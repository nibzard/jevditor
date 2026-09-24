import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { occurrenceKey, PRESET_RULES, type Rule } from "@jevditor/engine";
import type { LintRequest, TargetResult } from "../src/api.js";
import { LintController, type CheckStatus } from "../src/lint/controller.js";
import { extractBlocks, docRange } from "../src/lint/extract.js";
import type { DisplayFinding } from "../src/lint/plugin.js";

const schema = getSchema([StarterKit]);

function doc(...paragraphs: string[]): PMNode {
  return schema.node(
    "doc",
    null,
    paragraphs.map((p) => schema.node("paragraph", null, p ? [schema.text(p)] : [])),
  );
}

const rules: Rule[] = PRESET_RULES.map((p, i) => ({ id: `r${i}-${p.key}`, version: 1, enabled: p.enabled, sensitivity: p.sensitivity, preset: true, definition: p.definition }));
const linkedin = rules.find((r) => r.id.endsWith("linkedin-voice"))!;

type Pending = { body: LintRequest; signal: AbortSignal; resolve: (r: { results: TargetResult[] }) => void; reject: (e: unknown) => void };

function harness() {
  const calls: Pending[] = [];
  let findings: DisplayFinding[] = [];
  const statuses: CheckStatus[] = [];
  const onRulesChanged = vi.fn();
  const c = new LintController({
    lint: (body, signal) => new Promise((resolve, reject) => calls.push({ body, signal, resolve, reject })),
    onFindings: (f) => (findings = f),
    onStatus: (s) => statuses.push(s),
    onRulesChanged,
    isComposing: () => false,
    timing: { shortDelayMs: 500, longDelayMs: 4000, retryMs: 10_000 },
  });
  c.setRules(rules, []);
  return { c, calls, findings: () => findings, statuses, onRulesChanged };
}

/** Flag LinkedIn passages that mention lessons; everything else is fine. */
function answer(p: Pending): { results: TargetResult[] } {
  return {
    results: p.body.targets.map((t) => ({
      snapshot: t.snapshot,
      status: "ok",
      model: "fake",
      cached: false,
      results:
        t.scope === "passage"
          ? [{ ruleId: linkedin.id, ruleVersion: 1, probability: t.text.includes("lessons") ? 0.95 : 0.1, threshold: 0.85, flag: t.text.includes("lessons"), suppressed: false, patternId: "contrived-lesson" }]
          : [],
    })),
  };
}

const LINKEDIN = ["I missed my train this morning.", "It taught me more about leadership than ten years in management.", "Here are five lessons every founder needs to hear."];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("extract", () => {
  it("maps text offsets to document positions, including duplicate sentences", () => {
    const d = doc("Same. Same.", "Same.");
    const blocks = extractBlocks(d);
    expect(blocks.map((b) => b.text)).toEqual(["Same. Same.", "Same."]);
    const second = docRange(blocks, { block: 0, start: 6, end: 11 });
    expect(d.textBetween(second.from, second.to)).toBe("Same.");
    expect(second.from).toBe(7);
    const third = docRange(blocks, { block: 1, start: 0, end: 5 });
    expect(third.from).toBe(blocks[1]!.nodeFrom + 1);
  });
});

describe("LintController", () => {
  it("shows exact findings immediately and semantic ones only after a pause", async () => {
    const h = harness();
    h.c.update(doc(...LINKEDIN, "We should circle back."));
    expect(h.findings().map((f) => f.ruleName)).toEqual(["Phrases to avoid"]);
    expect(h.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(499);
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    // One request carries every pending sentence and passage target.
    expect(h.calls[0]!.body.targets.map((t) => t.scope)).toEqual(["sentence", "sentence", "sentence", "sentence", "passage", "passage"]);
    expect(h.calls[0]!.body.rules.map((r) => r.id).sort()).toEqual(rules.filter((r) => r.enabled && r.definition.kind === "semantic").map((r) => r.id).sort());

    h.calls[0]!.resolve(answer(h.calls[0]!));
    await vi.advanceTimersByTimeAsync(0);
    const passage = h.findings().find((f) => f.scope === "passage")!;
    expect(passage.message).toBe("This passage may turn an ordinary experience into a professional lesson.");
    expect(passage.nodes).toHaveLength(3);
  });

  it("coalesces rapid edits into one check of the latest text", async () => {
    const h = harness();
    for (let i = 1; i <= 5; i++) {
      h.c.update(doc("Draft ".repeat(i) + "sentence."));
      await vi.advanceTimersByTimeAsync(200);
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body.targets[0]!.text).toBe("Draft Draft Draft Draft Draft sentence.");
  });

  it("drops a late response for text that changed, and aborts that request", async () => {
    const h = harness();
    h.c.update(doc(...LINKEDIN));
    await vi.advanceTimersByTimeAsync(500);
    const first = h.calls[0]!;
    // The writer edits a neighbouring sentence while the check is in flight.
    h.c.update(doc(LINKEDIN[0]!, "It taught me a lot.", LINKEDIN[2]!));
    expect(first.signal.aborted).toBe(true);
    first.resolve(answer(first));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.findings().filter((f) => f.semantic)).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls).toHaveLength(2);
    // Every sentence's neighbours changed too, so each is re-sent under a new snapshot.
    expect(h.calls[1]!.body.targets.some((t) => t.text === "It taught me a lot.")).toBe(true);
  });

  it("does not re-send targets that already have a result", async () => {
    const h = harness();
    h.c.update(doc(...LINKEDIN, "", "Unrelated closing paragraph here.", "And another one."));
    await vi.advanceTimersByTimeAsync(500);
    h.calls[0]!.resolve(answer(h.calls[0]!));
    await vi.advanceTimersByTimeAsync(0);
    h.c.update(doc(...LINKEDIN, "", "Unrelated closing paragraph here.", "And another one, edited."));
    await vi.advanceTimersByTimeAsync(500);
    const resent = h.calls[1]!.body.targets.map((t) => t.text);
    expect(resent).not.toContain(LINKEDIN[0]);
    expect(resent).toContain("And another one, edited.");
  });

  it("reports failures as unavailable, shows nothing, and retries later", async () => {
    const h = harness();
    h.c.update(doc(...LINKEDIN));
    await vi.advanceTimersByTimeAsync(500);
    h.calls[0]!.resolve({ results: h.calls[0]!.body.targets.map((t) => ({ snapshot: t.snapshot, status: "error", error: "checking_unavailable" })) });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.statuses.at(-1)).toBe("unavailable");
    expect(h.findings().filter((f) => f.semantic)).toEqual([]);
    const shortChecks = () => h.calls.filter((c) => c.body.targets.some((t) => t.scope !== "section")).length;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(shortChecks()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(shortChecks()).toBe(2);
  });

  it("asks for fresh rules on a version conflict", async () => {
    const h = harness();
    h.c.update(doc(...LINKEDIN));
    await vi.advanceTimersByTimeAsync(500);
    h.calls[0]!.reject(Object.assign(new Error("rules_changed"), { status: 409 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onRulesChanged).toHaveBeenCalled();
  });

  it("hides kept occurrences and shows nothing while paused", async () => {
    const h = harness();
    h.c.update(doc(...LINKEDIN));
    await vi.advanceTimersByTimeAsync(500);
    h.calls[0]!.resolve(answer(h.calls[0]!));
    await vi.advanceTimersByTimeAsync(0);
    const f = h.findings().find((x) => x.scope === "passage")!;
    h.c.setRules(rules, [{ id: "s", ruleId: f.ruleId, key: occurrenceKey(f.ruleId, f.occurrenceText), excerpt: "", createdAt: "" }]);
    expect(h.findings().find((x) => x.scope === "passage")).toBeUndefined();

    h.c.setRules(rules, []);
    h.c.setPaused(true);
    expect(h.findings()).toEqual([]);
    h.c.setPaused(false);
    expect(h.findings().find((x) => x.scope === "passage")).toBeDefined();
  });

  it("runs section rules only after the longer pause or an explicit review", async () => {
    const h = harness();
    h.c.update(doc("First point, explained.", "First point, explained again."));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls[0]!.body.targets.some((t) => t.scope === "section")).toBe(false);
    h.c.reviewNow();
    expect(h.calls.at(-1)!.body.targets.map((t) => t.scope)).toEqual(["section"]);
  });
});

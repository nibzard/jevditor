import { describe, expect, it, vi } from "vitest";
import { semanticRulesFor, snapshotId, sentenceTargets, passageTargets, type Rule, type SemanticRuleDefinition } from "@jevditor/engine";
import { createApp } from "../src/app.js";
import type { Classification, Classifier, ClassifierState } from "../src/classifier.js";
import { Gate } from "../src/infra.js";
import { LintService } from "../src/lint.js";
import { Store } from "../src/store.js";

class FakeClassifier implements Classifier {
  readonly name = "demo" as const;
  readonly model = "fake-1";
  calls: Array<{ state: ClassifierState; rules: string[] }> = [];
  fail = false;
  constructor(private readonly score: (text: string, rule: SemanticRuleDefinition) => number) {}
  async classify(state: ClassifierState, rules: readonly SemanticRuleDefinition[]): Promise<Classification> {
    this.calls.push({ state, rules: rules.map((r) => r.name) });
    if (this.fail) throw new Error("boom");
    return {
      model: this.model,
      inputTokens: 1,
      judgments: rules.map((r) => ({ probability: this.score(state.target, r), ...(r.patterns?.length ? { patternId: r.patterns[0]!.id } : {}) })),
    };
  }
}

function setup(score: (t: string) => number = (t) => (/lesson|revolutionary/i.test(t) ? 0.95 : 0.1)) {
  const store = new Store();
  const classifier = new FakeClassifier(score);
  const lint = new LintService(classifier, new Gate(4, 1000), { cacheEntries: 100, cacheTtlMs: 60_000 });
  const app = createApp({ store, lint, tokens: new Map([["alice-token", "alice"], ["bob-token-1", "bob"]]) });
  const call = (method: string, path: string, body?: unknown, token = "alice-token") =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { store, classifier, app, call };
}

const LINKEDIN = [
  { type: "paragraph" as const, text: "I missed my train this morning." },
  { type: "paragraph" as const, text: "It taught me more about leadership than ten years in management." },
  { type: "paragraph" as const, text: "Here are five lessons every founder needs to hear." },
];

async function lintBody(call: ReturnType<typeof setup>["call"], blocks = LINKEDIN) {
  const res = await call("GET", "/api/rules");
  const { rules } = (await res.json()) as { rules: Rule[] };
  const targets = [...sentenceTargets(blocks), ...passageTargets(blocks)].map((t) => ({
    scope: t.scope,
    text: t.text,
    context: t.context,
    snapshot: snapshotId({ target: t, genre: "general", language: "en", rules: semanticRulesFor(rules, t.scope) }),
  }));
  const enabled = rules.filter((r) => r.enabled && r.definition.kind === "semantic").map((r) => ({ id: r.id, version: r.version }));
  return { rules, body: { genre: "general", language: "en", rules: enabled, targets } };
}

describe("auth and rules", () => {
  it("rejects missing or unknown tokens", async () => {
    const { app } = setup();
    expect((await app.request("/api/rules")).status).toBe(401);
    expect((await app.request("/api/rules", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("seeds presets per user and isolates users", async () => {
    const { call } = setup();
    const a = (await (await call("GET", "/api/rules")).json()) as { rules: Rule[] };
    const b = (await (await call("GET", "/api/rules", undefined, "bob-token-1")).json()) as { rules: Rule[] };
    expect(a.rules.map((r) => r.definition.name)).toContain("Avoid LinkedIn voice");
    expect(new Set(a.rules.map((r) => r.id)).size).toBe(a.rules.length);
    expect(a.rules.some((r) => b.rules.some((x) => x.id === r.id))).toBe(false);
    // Bob cannot touch Alice's rule.
    const res = await call("PATCH", `/api/rules/${a.rules[0]!.id}`, { enabled: false }, "bob-token-1");
    expect(res.status).toBe(404);
  });

  it("versions definition changes but not display settings", async () => {
    const { call } = setup();
    const { rules } = (await (await call("GET", "/api/rules")).json()) as { rules: Rule[] };
    const r = rules[0]!;
    const patched = (await (await call("PATCH", `/api/rules/${r.id}`, { sensitivity: "strict" })).json()) as { rule: Rule };
    expect(patched.rule.version).toBe(1);
    const def = { ...r.definition, name: "Renamed" };
    const put = (await (await call("PUT", `/api/rules/${r.id}`, def)).json()) as { rule: Rule };
    expect(put.rule.version).toBe(2);
    const versions = (await (await call("GET", `/api/rules/${r.id}/versions`)).json()) as { versions: unknown[] };
    expect(versions.versions).toHaveLength(2);
  });

  it("validates rule definitions", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/rules", { kind: "semantic", name: "x" });
    expect(res.status).toBe(400);
  });
});

describe("lint", () => {
  it("batches all applicable rules into one call per target and returns negatives too", async () => {
    const { call, classifier } = setup();
    const { body, rules } = await lintBody(call);
    const res = await call("POST", "/api/lint", body);
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: Array<{ status: string; results: Array<{ ruleId: string; flag: boolean; patternId?: string }> }> };
    expect(results).toHaveLength(4);
    // Two sentence rules are asked together for each sentence.
    expect(classifier.calls[0]!.rules).toEqual(expect.arrayContaining(["Not marketing copy", "Concrete over vague"]));
    expect(classifier.calls).toHaveLength(4);
    const passage = results[3]!;
    const linkedin = rules.find((r) => r.definition.name === "Avoid LinkedIn voice")!;
    expect(passage.results).toEqual([expect.objectContaining({ ruleId: linkedin.id, flag: true, patternId: "contrived-lesson" })]);
    expect(results[0]!.results.every((r) => r.flag === false)).toBe(true);
  });

  it("caches per user, and a sensitivity change reuses cached probabilities", async () => {
    const { call, classifier } = setup((t) => (t.includes("lessons") ? 0.8 : 0.1));
    const first = await lintBody(call);
    await call("POST", "/api/lint", first.body);
    expect(classifier.calls).toHaveLength(4);
    const linkedin = first.rules.find((r) => r.definition.name === "Avoid LinkedIn voice")!;
    await call("PATCH", `/api/rules/${linkedin.id}`, { sensitivity: "strict" });
    const res = await call("POST", "/api/lint", first.body);
    expect(classifier.calls).toHaveLength(4);
    const { results } = (await res.json()) as { results: Array<{ cached: boolean; results: Array<{ flag: boolean }> }> };
    expect(results[3]!.cached).toBe(true);
    expect(results[3]!.results[0]!.flag).toBe(true); // 0.8 >= 0.70 at strict

    // Another user with identical text does not share the cache.
    const bob = await lintBody((m, p, b) => call(m, p, b, "bob-token-1"));
    await call("POST", "/api/lint", bob.body, "bob-token-1");
    expect(classifier.calls).toHaveLength(8);
  });

  it("rejects requests made with stale rule versions", async () => {
    const { call } = setup();
    const { body, rules } = await lintBody(call);
    const r = rules.find((x) => x.definition.kind === "semantic")!;
    await call("PUT", `/api/rules/${r.id}`, { ...r.definition, question: "Changed?" });
    const res = await call("POST", "/api/lint", body);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("rules_changed");
  });

  it("rejects snapshots that do not match the target", async () => {
    const { call } = setup();
    const { body } = await lintBody(call);
    body.targets[0]!.text = "Something else entirely.";
    expect((await call("POST", "/api/lint", body)).status).toBe(400);
  });

  it("reports failures as unavailable rather than as no issues", async () => {
    const { call, classifier } = setup();
    classifier.fail = true;
    const { body } = await lintBody(call);
    const { results } = (await (await call("POST", "/api/lint", body)).json()) as { results: Array<{ status: string; error?: string }> };
    expect(results.every((r) => r.status === "error" && r.error === "checking_unavailable")).toBe(true);
  });

  it("keep-occurrence suppresses exactly that rule on that text", async () => {
    const { call } = setup();
    const { body, rules } = await lintBody(call);
    const linkedin = rules.find((r) => r.definition.name === "Avoid LinkedIn voice")!;
    const passageText = body.targets[3]!.text;
    const fb = await call("POST", "/api/feedback", { kind: "keep-occurrence", ruleId: linkedin.id, text: passageText });
    expect(fb.status).toBe(200);
    const { results } = (await (await call("POST", "/api/lint", body)).json()) as { results: Array<{ results: Array<{ flag: boolean; suppressed: boolean }> }> };
    expect(results[3]!.results[0]).toMatchObject({ flag: false, suppressed: true });
  });

  it("allow-like-this adds a negative example as a new version", async () => {
    const { call } = setup();
    const { rules } = await lintBody(call);
    const linkedin = rules.find((r) => r.definition.name === "Avoid LinkedIn voice")!;
    const res = await call("POST", "/api/feedback", { kind: "allow-like-this", ruleId: linkedin.id, text: "We shipped it." });
    const { rule } = (await res.json()) as { rule: Rule };
    expect(rule.version).toBe(2);
    expect(rule.definition.kind === "semantic" && rule.definition.examples.at(-1)).toEqual({ text: "We shipped it.", flag: false });
  });

  it("rate limits per user", async () => {
    const store = new Store();
    const lint = new LintService(new FakeClassifier(() => 0.1), new Gate(4, 1000), { cacheEntries: 10, cacheTtlMs: 1000 });
    const app = createApp({ store, lint, tokens: new Map([["alice-token", "alice"]]), limits: { checksPerMinute: 5 } });
    const call = (m: string, p: string, b?: unknown) =>
      app.request(p, { method: m, headers: { authorization: "Bearer alice-token" }, ...(b ? { body: JSON.stringify(b) } : {}) });
    const { body } = await lintBody(call);
    expect((await call("POST", "/api/lint", body)).status).toBe(200);
    const res = await call("POST", "/api/lint", body);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("evaluation", () => {
  it("reports precision among shown findings on dev and held-out splits", async () => {
    const { call } = setup((t) => (t.includes("flag") ? 0.9 : t.includes("borderline") ? 0.87 : 0.1));
    const { rules } = await lintBody(call);
    const id = rules.find((r) => r.definition.kind === "semantic")!.id;
    for (const [text, flag, heldOut] of [
      ["please flag me", true, false],
      ["borderline but fine", false, false],
      ["plain text", false, false],
      ["flag this too", true, true],
    ] as const) {
      expect((await call("POST", `/api/rules/${id}/labels`, { text, flag, heldOut })).status).toBe(201);
    }
    const res = await call("POST", `/api/rules/${id}/evaluate`);
    const out = (await res.json()) as { dev: { precision: number; recall: number; shown: number }; heldOut: { precision: number }; sweep: Array<{ threshold: number; dev: { precision: number } }> };
    expect(out.dev).toMatchObject({ shown: 2, precision: 0.5, recall: 1 });
    expect(out.heldOut.precision).toBe(1);
    expect(out.sweep.find((s) => s.threshold === 0.9)!.dev.precision).toBe(1);
  });
});

describe("generation", () => {
  it("is reported unavailable when not configured", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/rules/draft", { request: "No LinkedIn voice" })).status).toBe(503);
  });

  it("drafts through the generator", async () => {
    const store = new Store();
    const lint = new LintService(new FakeClassifier(() => 0), new Gate(1, 10), { cacheEntries: 1, cacheTtlMs: 1 });
    const draftRule = vi.fn(async () => ({ definition: { name: "x" } as SemanticRuleDefinition, candidates: [] }));
    const app = createApp({ store, lint, generator: { draftRule, rewrite: vi.fn() }, tokens: new Map([["alice-token", "alice"]]) });
    const res = await app.request("/api/rules/draft", {
      method: "POST",
      headers: { authorization: "Bearer alice-token" },
      body: JSON.stringify({ request: "Flag anything that sounds like a LinkedIn post." }),
    });
    expect(res.status).toBe(200);
    expect(draftRule).toHaveBeenCalledWith("Flag anything that sounds like a LinkedIn post.");
  });
});

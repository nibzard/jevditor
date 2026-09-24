import { describe, expect, it } from "vitest";
import { effectiveThreshold, occurrenceKey, runExactChecks, snapshotId, type Rule } from "../src/index.js";

const rule = (id: string, definition: Rule["definition"], enabled = true): Rule => ({
  id,
  version: 1,
  enabled,
  sensitivity: "normal",
  preset: false,
  definition,
});

describe("runExactChecks", () => {
  const phrases = rule("p", { kind: "phrases", name: "P", phrases: ["synergy", "circle back", "C++"], explanation: "" });

  it("matches whole words and phrases, case-insensitively, with exact offsets", () => {
    const text = "Let's Circle  back on the synergy, not synergyish things. I like C++.";
    const found = runExactChecks([{ type: "paragraph", text }], [phrases]);
    expect(found.map((f) => text.slice(f.range.start, f.range.end))).toEqual(["Circle  back", "synergy", "C++"]);
  });

  it("finds repeated words, including every duplicate occurrence of the same sentence", () => {
    const r = rule("r", { kind: "repeated-word", name: "R", explanation: "" });
    const text = "It was the the best. It was the the best.";
    const found = runExactChecks([{ type: "paragraph", text }], [r]);
    expect(found.map((f) => f.range.start)).toEqual([7, 28]);
  });

  it("checks sentence length but skips headings and disabled rules", () => {
    const len = rule("l", { kind: "sentence-length", name: "L", maxWords: 3, explanation: "" });
    const blocks = [
      { type: "heading" as const, text: "A heading with many words" },
      { type: "paragraph" as const, text: "Short one. This one is too long." },
    ];
    expect(runExactChecks(blocks, [len]).map((f) => f.range)).toEqual([{ block: 1, start: 11, end: 32 }]);
    expect(runExactChecks(blocks, [{ ...len, enabled: false }])).toEqual([]);
  });
});

describe("snapshots and thresholds", () => {
  const base = {
    target: { scope: "sentence" as const, text: "Hello.", context: "" },
    genre: "blog",
    language: "en",
    rules: [{ id: "a", version: 1 }],
  };

  it("changes when text, context, or rule versions change, and not when rule order changes", () => {
    const s = snapshotId(base);
    expect(snapshotId({ ...base, target: { ...base.target, context: "[after] x" } })).not.toBe(s);
    expect(snapshotId({ ...base, target: { ...base.target, text: "Hello.\n" } })).not.toBe(s);
    expect(snapshotId({ ...base, rules: [{ id: "a", version: 2 }] })).not.toBe(s);
    const two = { ...base, rules: [{ id: "a", version: 1 }, { id: "b", version: 1 }] };
    expect(snapshotId(two)).toBe(snapshotId({ ...two, rules: [...two.rules].reverse() }));
  });

  it("occurrence keys ignore surrounding whitespace only", () => {
    expect(occurrenceKey("r", " x ")).toBe(occurrenceKey("r", "x"));
    expect(occurrenceKey("r", "x")).not.toBe(occurrenceKey("s", "x"));
  });

  it("sensitivity shifts and clamps the threshold", () => {
    expect(effectiveThreshold(0.85, "normal")).toBe(0.85);
    expect(effectiveThreshold(0.85, "gentle")).toBeCloseTo(0.92);
    expect(effectiveThreshold(0.6, "strict")).toBe(0.5);
    expect(effectiveThreshold(0.95, "gentle")).toBe(0.99);
  });
});

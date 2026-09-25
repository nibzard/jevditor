import { describe, expect, it } from "vitest";
import { passageTargets, sectionTargets, sentenceTargets, splitPhrases, splitSentences } from "../src/index.js";

const slices = (text: string) => splitSentences(text).map((r) => text.slice(r.start, r.end));

describe("splitSentences", () => {
  it("splits on terminal punctuation and keeps offsets exact", () => {
    const text = "  I missed my train. It taught me a lot!  Did it?";
    expect(slices(text)).toEqual(["I missed my train.", "It taught me a lot!", "Did it?"]);
  });

  it("does not split on common abbreviations, initials, or decimals", () => {
    expect(slices("Dr. Smith met J. Doe at 3.5 p.m. on Friday. Then they left.")).toEqual([
      "Dr. Smith met J. Doe at 3.5 p.m. on Friday.",
      "Then they left.",
    ]);
  });

  it("keeps closing quotes with their sentence and treats hard breaks as boundaries", () => {
    expect(slices('He said "stop." She left\nwithout a word')).toEqual(['He said "stop."', "She left", "without a word"]);
  });

  it("ignores fragments without letters or digits", () => {
    expect(slices("... — !")).toEqual([]);
  });
});

describe("targets", () => {
  const blocks = [
    { type: "heading" as const, text: "Monday" },
    { type: "paragraph" as const, text: "I missed my train this morning." },
    { type: "paragraph" as const, text: "It taught me more about leadership than ten years in management." },
    { type: "paragraph" as const, text: "" },
    { type: "paragraph" as const, text: "Here are five lessons every founder needs to hear." },
    { type: "heading" as const, text: "Tuesday" },
    { type: "paragraph" as const, text: "Nothing happened." },
  ];

  it("sentence targets carry block ranges and neighbouring context", () => {
    const t = sentenceTargets(blocks);
    expect(t.map((x) => x.text)).toEqual([
      "I missed my train this morning.",
      "It taught me more about leadership than ten years in management.",
      "Here are five lessons every founder needs to hear.",
      "Nothing happened.",
    ]);
    expect(t[1]!.ranges).toEqual([{ block: 2, start: 0, end: 64 }]);
    expect(t[1]!.context).toContain("[before] I missed my train");
    expect(t[1]!.context).toContain("[after] Here are five lessons");
  });

  it("passages span short paragraph runs, preserve breaks, and stop at headings", () => {
    const t = passageTargets(blocks);
    expect(t).toHaveLength(2);
    expect(t[0]!.text).toBe(
      "I missed my train this morning.\n\nIt taught me more about leadership than ten years in management.\n\nHere are five lessons every founder needs to hear.",
    );
    expect(t[0]!.ranges.map((r) => r.block)).toEqual([1, 2, 4]);
    expect(t[1]!.ranges.map((r) => r.block)).toEqual([6]);
  });

  it("chunks long runs", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ type: "paragraph" as const, text: `Paragraph ${i}.` }));
    expect(passageTargets(many).map((t) => t.ranges.length)).toEqual([3, 3, 3]);
  });

  it("sections are heading-delimited and need at least two paragraphs", () => {
    const t = sectionTargets(blocks);
    expect(t).toHaveLength(1);
    expect(t[0]!.context).toBe("[section heading] Monday");
  });
});

describe("splitPhrases", () => {
  const parts = (text: string) => splitPhrases(text).map((r) => text.slice(r.start, r.end));

  it("splits at clause punctuation and conjunctions and keeps offsets exact", () => {
    expect(parts("Some people might perhaps argue that bike lanes could possibly slow traffic, in a sense.")).toEqual([
      "Some people might perhaps argue",
      "that bike lanes could possibly slow traffic",
      "in a sense",
    ]);
  });

  it("joins a one-word part to its neighbour", () => {
    expect(parts("Basically, the data is clear: bike lanes work.")).toEqual(["Basically, the data is clear", "bike lanes work"]);
  });

  it("returns nothing when a sentence has only one part", () => {
    expect(splitPhrases("Bike lanes work.")).toEqual([]);
  });
});

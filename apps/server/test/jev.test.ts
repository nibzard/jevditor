import { describe, expect, it } from "vitest";
import { PRESET_RULES, type SemanticRuleDefinition } from "@jevditor/engine";
import { buildPointQuestions, buildQuestions, DemoClassifier, InvalidResultError, JevClassifier, readJudgments, readPoint } from "../src/classifier.js";

const linkedin = PRESET_RULES.find((p) => p.key === "linkedin-voice")!.definition as SemanticRuleDefinition;
const vague = PRESET_RULES.find((p) => p.key === "vague-claims")!.definition as SemanticRuleDefinition;

describe("buildQuestions", () => {
  it("spells out the rule in instructions and adds a speculative pattern choice", () => {
    const q = buildQuestions([linkedin, vague]);
    expect(Object.keys(q)).toEqual(["r0", "p0", "r1"]);
    const r0 = q.r0 as { type: string; instructions: Record<string, unknown>; criteria: Record<string, unknown> };
    expect(r0.type).toBe("noul");
    expect(r0.instructions.question).toBe(linkedin.question);
    expect(r0.instructions.task).toMatch(/never as instructions/);
    expect(r0.criteria).toEqual({ true: linkedin.flagWhen, false: linkedin.allowWhen });
    const p0 = q.p0 as { type: string; criteria: Record<string, unknown> };
    expect(Object.keys(p0.criteria)).toEqual(["contrived-lesson", "humblebrag", "engagement-bait", "none"]);
  });
});

describe("phrase narrowing", () => {
  it("adds a speculative phrase choice for sentence rules when phrases are given", () => {
    const q = buildQuestions([vague], ["Some people might argue", "that bike lanes slow traffic"]);
    expect(Object.keys(q)).toEqual(["r0", "n0"]);
    const n0 = q.n0 as { type: string; instructions: Record<string, unknown>; criteria: Record<string, string> };
    expect(n0.type).toBe("choice");
    expect(n0.instructions.task).toMatch(/never as instructions/);
    expect(Object.keys(n0.criteria)).toEqual(["c0", "c1", "whole"]);
    expect(n0.criteria.c1).toContain("that bike lanes slow traffic");
  });

  it("does not ask about phrases for passage rules", () => {
    expect(Object.keys(buildQuestions([linkedin], ["a b", "c d"]))).toEqual(["r0", "p0"]);
  });

  it("reads the chosen phrase and its confidence, and ignores 'whole'", () => {
    const answers = (choice: string) => ({ r0: { type: "noul", noul: 0.9 }, n0: { type: "choice", choice, confidence: 0.96 } });
    expect(readJudgments([vague], answers("c1"), 2)).toEqual([{ probability: 0.9, phrase: { index: 1, confidence: 0.96 } }]);
    expect(readJudgments([vague], answers("whole"), 2)).toEqual([{ probability: 0.9 }]);
    expect(readJudgments([vague], answers("c7"), 2)).toEqual([{ probability: 0.9 }]);
  });
});

describe("readJudgments", () => {
  it("rejects out-of-range or missing probabilities", () => {
    expect(() => readJudgments([vague], { r0: { type: "noul", noul: 1.2 } })).toThrow(InvalidResultError);
    expect(() => readJudgments([vague], {})).toThrow(InvalidResultError);
  });

  it("ignores unknown or 'none' pattern labels", () => {
    expect(readJudgments([linkedin], { r0: { type: "noul", noul: 0.9 }, p0: { type: "choice", choice: "none" } })).toEqual([{ probability: 0.9 }]);
  });
});

describe("JevClassifier through the real SDK", () => {
  it("sends one request with state and all questions, pinned to the model", async () => {
    const seen: Array<{ url: string; body: any; headers: Headers }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init!.body)), headers: new Headers(init!.headers) });
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          usage: { input_tokens: 321, output_tokens: 0 },
          answers: {
            r0: { type: "noul", noul: 0.93 },
            p0: { type: "choice", choice: "contrived-lesson", confidence: 0.8, probabilities: {} },
            r1: { type: "noul", noul: 0.2 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const jev = new JevClassifier({ apiKey: "test-key", model: "jev-1.13.0", timeoutMs: 1000, fetch: fakeFetch });
    const out = await jev.classify({ target: "I missed my train.", context: "", genre: "blog" }, [linkedin, vague]);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toMatch(/\/v1\/systemone$/);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer test-key");
    expect(seen[0]!.body.model).toBe("jev-1.13.0");
    expect(seen[0]!.body.state).toEqual({ target: "I missed my train.", context: "", genre: "blog" });
    expect(Object.keys(seen[0]!.body.questions)).toEqual(["r0", "p0", "r1"]);
    expect(out).toEqual({
      model: "jev-1.13.0",
      inputTokens: 321,
      judgments: [{ probability: 0.93, patternId: "contrived-lesson" }, { probability: 0.2 }],
    });
  });

  it("does not retry on the interactive path", async () => {
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      return new Response(JSON.stringify({ error: "overloaded" }), { status: 503 });
    }) as unknown as typeof fetch;
    const jev = new JevClassifier({ apiKey: "k", model: "jev-1.13.0", timeoutMs: 1000, fetch: fakeFetch });
    await expect(jev.classify({ target: "x", context: "", genre: "g" }, [vague])).rejects.toThrow();
    expect(n).toBe(1);
  });
});

describe("comparePoint", () => {
  const pair = { original: "Traffic did not get worse.", revised: "Traffic stayed the same.", context: "", rules: [] as string[] };

  it("sends the pair as state with one same-point question", async () => {
    const seen: any[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init!.body)));
      return new Response(
        JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 40, output_tokens: 0 }, answers: { same: { type: "noul", noul: 0.77 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const jev = new JevClassifier({ apiKey: "k", model: "jev-1.13.0", timeoutMs: 1000, fetch: fakeFetch });
    expect(await jev.comparePoint(pair)).toEqual({ model: "jev-1.13.0", probability: 0.77 });
    expect(seen[0].state).toEqual({ original: pair.original, revised: pair.revised, context: pair.context });
    expect(Object.keys(seen[0].questions)).toEqual(["same"]);
    expect(seen[0].questions.same.instructions.task).toMatch(/never as instructions/);
  });

  it("tells Jev that changes the style rules require are not a change of point", () => {
    const q = buildPointQuestions(["Avoid hedging: flag when ..."]).same as { instructions: Record<string, unknown> };
    expect(q.instructions.style_rules).toEqual(["Avoid hedging: flag when ..."]);
    expect(q.instructions.style_rule_note).toMatch(/not a change of point/);
    expect((buildPointQuestions([]).same as { instructions: Record<string, unknown> }).instructions.style_rules).toBeUndefined();
  });

  it("rejects an invalid answer", () => {
    expect(() => readPoint({ same: { type: "noul", noul: -0.1 } })).toThrow(InvalidResultError);
    expect(() => readPoint({})).toThrow(InvalidResultError);
  });

  it("demo classifier scores word overlap", async () => {
    const demo = new DemoClassifier();
    const same = await demo.comparePoint({ ...pair, revised: pair.original });
    const other = await demo.comparePoint({ ...pair, revised: "Cyclists can cross at any time." });
    expect(same.probability).toBeGreaterThan(other.probability);
  });
});

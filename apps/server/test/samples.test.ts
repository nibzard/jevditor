// ABOUTME: Checks that the eval samples are well formed without calling Jev.
// ABOUTME: Every expectation must name a semantic preset, and every rule needs a flag and an allow case.
import { describe, expect, it } from "vitest";
import { PRESET_RULES, targetsForScope, type SemanticRuleDefinition } from "@jevditor/engine";
import { SAMPLES } from "../evals/samples.js";

const semantic = PRESET_RULES.filter((p) => p.definition.kind === "semantic");

describe("eval samples", () => {
  it("only name semantic presets, and give each an expectation", () => {
    for (const s of SAMPLES) expect(Object.keys(s.expect).sort()).toEqual(semantic.map((p) => p.key).sort());
  });

  it("have at least one flag and one allow case per rule", () => {
    for (const p of semantic) {
      const values = SAMPLES.map((s) => s.expect[p.key]);
      expect(values, p.key).toContain("flag");
      expect(values, p.key).toContain("allow");
    }
  });

  it("produce targets at each flagged rule's scope", () => {
    for (const s of SAMPLES) {
      for (const [key, e] of Object.entries(s.expect)) {
        if (e !== "flag") continue;
        const scope = (semantic.find((p) => p.key === key)!.definition as SemanticRuleDefinition).scope;
        expect(targetsForScope(s.blocks, scope).length, `${s.name} / ${key}`).toBeGreaterThan(0);
      }
    }
  });
});

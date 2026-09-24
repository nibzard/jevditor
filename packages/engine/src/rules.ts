import type { Rule, SemanticRule, SemanticScope, Sensitivity } from "./types.js";

export const DEFAULT_THRESHOLD = 0.85;

const SENSITIVITY_OFFSET: Record<Sensitivity, number> = { gentle: 0.07, normal: 0, strict: -0.15 };

/**
 * The probability at or above which a finding is shown. Thresholds are starting
 * hypotheses; tune them per rule against labeled examples in the playground.
 */
export function effectiveThreshold(base: number, sensitivity: Sensitivity): number {
  return Math.min(0.99, Math.max(0.5, base + SENSITIVITY_OFFSET[sensitivity]));
}

export function isSemantic(rule: Rule): rule is SemanticRule {
  return rule.definition.kind === "semantic";
}

/** Enabled semantic rules that apply to a scope, in a stable order. */
export function semanticRulesFor(rules: readonly Rule[], scope: SemanticScope): SemanticRule[] {
  return rules
    .filter(isSemantic)
    .filter((r) => r.enabled && r.definition.scope === scope)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `id@version` pairs; part of every snapshot identity. */
export function ruleVersionKey(rules: readonly Pick<Rule, "id" | "version">[]): string {
  return rules.map((r) => `${r.id}@${r.version}`).sort().join(",");
}

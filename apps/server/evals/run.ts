// ABOUTME: Runs the semantic preset rules against the document samples with real Jev.
// ABOUTME: Prints one row per sample and rule, and exits with 1 when any expectation fails.
import {
  effectiveThreshold,
  PRESET_RULES,
  semanticRulesFor,
  targetsForScope,
  splitPhrases,
  type Rule,
  type SemanticScope,
} from "@jevditor/engine";
import { JevClassifier } from "../src/classifier.js";
import { SAMPLES } from "./samples.js";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error("Set TYPESAFE_API_KEY to run the evals.");
  process.exit(2);
}
const model = process.env.JEVDITOR_JEV_MODEL ?? "jev-1.13.0";
const jev = new JevClassifier({ apiKey, model, timeoutMs: 15_000 });

// Every semantic preset is evaluated, also the ones that are off by default.
const rules: Rule[] = PRESET_RULES.filter((p) => p.definition.kind === "semantic").map((p) => ({
  id: p.key,
  version: 1,
  enabled: true,
  sensitivity: "normal",
  preset: true,
  definition: p.definition,
}));

let failures = 0;
for (const sample of SAMPLES) {
  const top = new Map<string, number>();
  for (const scope of ["sentence", "passage", "section"] as SemanticScope[]) {
    const scoped = semanticRulesFor(rules, scope);
    if (!scoped.length) continue;
    for (const t of targetsForScope(sample.blocks, scope)) {
      const phrases = scope === "sentence" ? splitPhrases(t.text).map((r) => t.text.slice(r.start, r.end)) : [];
      const out = await jev.classify({ target: t.text, context: t.context, genre: "general", phrases }, scoped.map((r) => r.definition));
      scoped.forEach((r, i) => top.set(r.id, Math.max(top.get(r.id) ?? 0, out.judgments[i]!.probability)));
    }
  }
  for (const [key, expected] of Object.entries(sample.expect)) {
    const rule = rules.find((r) => r.id === key)!;
    const max = top.get(key) ?? 0;
    const threshold = effectiveThreshold((rule.definition as { threshold: number }).threshold, "normal");
    const actual = max >= threshold ? "flag" : "allow";
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${sample.name.padEnd(20)} ${key.padEnd(22)} expected ${expected.padEnd(5)}  max ${max.toFixed(2)} (≥ ${threshold.toFixed(2)})`);
  }
}
console.log(`\n${failures ? `${failures} failed` : "all passed"} · ${model}`);
process.exit(failures ? 1 : 0);

import { splitSentences } from "./segment.js";
import type { ExactFinding, ExactRuleDefinition, Rule, TextBlock } from "./types.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word boundaries that also work for phrases starting or ending in punctuation. */
function phrasePattern(phrase: string): string {
  const body = escapeRegExp(phrase.trim()).replace(/\s+/g, "\\s+");
  const lead = /^[\p{L}\p{N}_]/u.test(phrase.trim()) ? "(?<![\\p{L}\\p{N}_])" : "";
  const tail = /[\p{L}\p{N}_]$/u.test(phrase.trim()) ? "(?![\\p{L}\\p{N}_])" : "";
  return lead + body + tail;
}

function* phraseMatches(text: string, phrases: string[], caseSensitive: boolean) {
  const clean = phrases.map((p) => p.trim()).filter(Boolean);
  if (!clean.length) return;
  // Longest first so "circle back around" wins over "circle back".
  clean.sort((a, b) => b.length - a.length);
  const re = new RegExp(clean.map(phrasePattern).join("|"), caseSensitive ? "gu" : "giu");
  for (const m of text.matchAll(re)) yield { start: m.index!, end: m.index! + m[0].length, match: m[0] };
}

function checkBlock(def: ExactRuleDefinition, text: string): Array<{ start: number; end: number; message: string }> {
  switch (def.kind) {
    case "phrases":
      return [...phraseMatches(text, def.phrases, def.caseSensitive ?? false)].map((m) => ({
        start: m.start,
        end: m.end,
        message: `“${m.match}” is on your list of phrases to avoid.`,
      }));
    case "repeated-word": {
      const out: Array<{ start: number; end: number; message: string }> = [];
      for (const m of text.matchAll(/(?<![\p{L}\p{N}])([\p{L}\p{N}']+)(\s+)(\1)(?![\p{L}\p{N}])/giu)) {
        const second = m.index! + m[1]!.length + m[2]!.length;
        out.push({ start: m.index!, end: second + m[3]!.length, message: `“${m[1]}” appears twice in a row.` });
      }
      return out;
    }
    case "sentence-length": {
      const out: Array<{ start: number; end: number; message: string }> = [];
      for (const s of splitSentences(text)) {
        const words = text.slice(s.start, s.end).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
        if (words > def.maxWords) {
          out.push({ ...s, message: `This sentence has ${words} words; your limit is ${def.maxWords}.` });
        }
      }
      return out;
    }
  }
}

/** Deterministic checks. These run locally and immediately, never through the model. */
export function runExactChecks(blocks: readonly TextBlock[], rules: readonly Rule[]): ExactFinding[] {
  const out: ExactFinding[] = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.definition.kind === "semantic") continue;
    const def = rule.definition;
    blocks.forEach((b, block) => {
      if (def.kind === "sentence-length" && b.type === "heading") return;
      for (const f of checkBlock(def, b.text)) {
        out.push({ ruleId: rule.id, ruleVersion: rule.version, range: { block, start: f.start, end: f.end }, message: f.message });
      }
    });
  }
  return out;
}

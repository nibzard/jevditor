import {
  effectiveThreshold,
  occurrenceKey,
  ruleVersionKey,
  semanticRulesFor,
  splitPhrases,
  type SemanticRule,
  type SemanticRuleDefinition,
  type SemanticScope,
} from "@jevditor/engine";
import type { Classifier, PointComparison, PointPair, RuleJudgment } from "./classifier.js";
import { CapacityError, Gate, LruCache, sha256 } from "./infra.js";

export interface LintTarget {
  snapshot: string;
  scope: SemanticScope;
  text: string;
  context: string;
}

export interface RuleResult {
  ruleId: string;
  ruleVersion: number;
  probability: number;
  threshold: number;
  /** probability >= threshold and not suppressed. */
  flag: boolean;
  suppressed: boolean;
  patternId?: string;
  /** For sentence rules: the part of the target that shows the match best. Offsets index into the target text. */
  phrase?: { start: number; end: number; confidence: number };
}

export type TargetResult =
  | { snapshot: string; status: "ok"; model: string; cached: boolean; results: RuleResult[] }
  | { snapshot: string; status: "error"; error: "checking_unavailable" | "capacity" };

interface CachedClassification {
  model: string;
  judgments: RuleJudgment[];
}

export class LintService {
  private readonly cache: LruCache<CachedClassification>;

  constructor(
    readonly classifier: Classifier,
    private readonly gate: Gate,
    opts: { cacheEntries: number; cacheTtlMs: number },
    private readonly onError: (err: unknown) => void = () => {},
  ) {
    this.cache = new LruCache(opts.cacheEntries, opts.cacheTtlMs);
  }

  /**
   * Cache identity: tenant + target + context + genre/language + exact rule
   * versions + model. Probabilities are cached; thresholds and suppressions
   * are applied afterwards, so changing sensitivity never needs a new call.
   */
  private cacheKey(userId: string, t: LintTarget, genre: string, language: string, rules: readonly SemanticRule[]) {
    return sha256([userId, t.scope, t.text, t.context, genre, language, ruleVersionKey(rules), this.classifier.model]);
  }

  /** Classifies without caching or thresholds. Used by the rule preview and evaluation. */
  async judge(
    definitions: readonly SemanticRuleDefinition[],
    text: string,
    context: string,
    genre: string,
    signal?: AbortSignal,
    phrases?: string[],
  ): Promise<CachedClassification> {
    const state = { target: text, context, genre, ...(phrases?.length ? { phrases } : {}) };
    return this.gate.run(() => this.classifier.classify(state, definitions, signal), signal);
  }

  /** Asks whether a revision makes the same point as the original. Not cached: each rewrite is new text. */
  async comparePoint(pair: PointPair, signal?: AbortSignal): Promise<PointComparison> {
    return this.gate.run(() => this.classifier.comparePoint(pair, signal), signal);
  }

  async lintTarget(args: {
    userId: string;
    target: LintTarget;
    genre: string;
    language: string;
    rules: readonly SemanticRule[];
    suppressed: ReadonlySet<string>;
    signal?: AbortSignal;
  }): Promise<TargetResult> {
    const { userId, target, genre, language, suppressed, signal } = args;
    const rules = semanticRulesFor(args.rules, target.scope);
    if (!rules.length) return { snapshot: target.snapshot, status: "ok", model: this.classifier.model, cached: true, results: [] };

    // Phrases come from the target text alone, so the cache key already covers them.
    const phrases = target.scope === "sentence" ? splitPhrases(target.text) : [];
    const key = this.cacheKey(userId, target, genre, language, rules);
    let hit = this.cache.get(key);
    const cached = hit !== undefined;
    if (!hit) {
      try {
        const texts = phrases.map((p) => target.text.slice(p.start, p.end));
        hit = await this.judge(rules.map((r) => r.definition), target.text, target.context, genre, signal, texts);
      } catch (err) {
        if (signal?.aborted) throw err;
        this.onError(err);
        const error = err instanceof CapacityError ? "capacity" : "checking_unavailable";
        return { snapshot: target.snapshot, status: "error", error };
      }
      this.cache.set(key, hit);
    }

    const results = rules.map((rule, i): RuleResult => {
      const j = hit!.judgments[i]!;
      const threshold = effectiveThreshold(rule.definition.threshold, rule.sensitivity);
      const isSuppressed = suppressed.has(`${rule.id}:${occurrenceKey(rule.id, target.text)}`);
      return {
        ruleId: rule.id,
        ruleVersion: rule.version,
        probability: j.probability,
        threshold,
        flag: !isSuppressed && j.probability >= threshold,
        suppressed: isSuppressed,
        ...(j.patternId ? { patternId: j.patternId } : {}),
        ...(j.phrase && phrases[j.phrase.index] ? { phrase: { ...phrases[j.phrase.index]!, confidence: j.phrase.confidence } } : {}),
      };
    });
    return { snapshot: target.snapshot, status: "ok", model: hit.model, cached, results };
  }
}

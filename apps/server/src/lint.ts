import {
  effectiveThreshold,
  occurrenceKey,
  ruleVersionKey,
  semanticRulesFor,
  type SemanticRule,
  type SemanticRuleDefinition,
  type SemanticScope,
} from "@jevditor/engine";
import type { Classifier, RuleJudgment } from "./classifier.js";
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
  ): Promise<CachedClassification> {
    return this.gate.run(() => this.classifier.classify({ target: text, context, genre }, definitions, signal), signal);
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

    const key = this.cacheKey(userId, target, genre, language, rules);
    let hit = this.cache.get(key);
    const cached = hit !== undefined;
    if (!hit) {
      try {
        hit = await this.judge(rules.map((r) => r.definition), target.text, target.context, genre, signal);
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
      };
    });
    return { snapshot: target.snapshot, status: "ok", model: hit.model, cached, results };
  }
}

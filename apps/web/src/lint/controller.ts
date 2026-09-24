import {
  occurrenceKey,
  runExactChecks,
  semanticRulesFor,
  snapshotId,
  splitSentences,
  targetsForScope,
  type Rule,
  type SemanticScope,
  type Target,
} from "@jevditor/engine";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { LintRequest, Suppression, TargetResult } from "../api.js";
import { docRange, extractBlocks, type ExtractedBlock } from "./extract.js";
import type { DisplayFinding } from "./plugin.js";

export type CheckStatus = "idle" | "checking" | "unavailable" | "paused";

export interface Timing {
  /** Pause before sentence and passage rules run. */
  shortDelayMs: number;
  /** Pause before section-level rules run. */
  longDelayMs: number;
  /** How long a failed target waits before it is retried. */
  retryMs: number;
}

export const DEFAULT_TIMING: Timing = { shortDelayMs: 500, longDelayMs: 4000, retryMs: 10_000 };

const MAX_TARGETS_PER_REQUEST = 24;
const MAX_RESULTS = 3000;

interface CurrentTarget {
  target: Target;
  snapshot: string;
}

export interface ControllerDeps {
  lint: (body: LintRequest, signal: AbortSignal) => Promise<{ results: TargetResult[] }>;
  onFindings: (findings: DisplayFinding[]) => void;
  onStatus: (status: CheckStatus) => void;
  /** The server rejected our rule versions; reload rules. */
  onRulesChanged: () => void;
  /** Composition (IME) in progress: do not check yet. */
  isComposing: () => boolean;
  timing?: Partial<Timing>;
  now?: () => number;
}

/**
 * Decides when to check what, and which results may be shown.
 *
 * - Exact rules run on every change, locally.
 * - Semantic rules run after a pause, only for targets whose snapshot has no
 *   result yet. Rapid edits coalesce into one check of the latest state.
 * - Results are stored by snapshot. A result is shown only if some current
 *   target has exactly that snapshot, so a late response for text that has
 *   since changed is never rendered. Cancelling requests is an optimization;
 *   the snapshot match is what keeps results correct.
 */
export class LintController {
  private rules: Rule[] = [];
  private suppressed = new Set<string>();
  private genre = "general";
  private readonly language = "en";
  private paused = false;
  private disposed = false;

  private blocks: ExtractedBlock[] = [];
  private targets: CurrentTarget[] = [];
  private results = new Map<string, Extract<TargetResult, { status: "ok" }>>();
  private failedUntil = new Map<string, number>();
  private inflight = new Set<{ snapshots: Set<string>; abort: AbortController }>();
  private timers: Partial<Record<"short" | "long" | "retry", ReturnType<typeof setTimeout>>> = {};
  private unavailable = false;
  private readonly timing: Timing;
  private readonly now: () => number;

  constructor(private readonly deps: ControllerDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
  }

  setRules(rules: Rule[], suppressions: Suppression[]) {
    this.rules = rules;
    this.suppressed = new Set(suppressions.map((s) => `${s.ruleId}:${s.key}`));
    this.recompute();
  }

  setGenre(genre: string) {
    this.genre = genre;
    this.recompute();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) this.cancelAll();
    this.recompute();
  }

  /** Call after every document change. */
  update(doc: PMNode) {
    this.blocks = extractBlocks(doc);
    this.recompute();
  }

  /** Run every pending check now, including section-level rules. */
  reviewNow() {
    this.flush(["sentence", "passage", "section"]);
  }

  dispose() {
    this.disposed = true;
    this.cancelAll();
    for (const t of Object.values(this.timers)) clearTimeout(t);
  }

  /** Whether a finding's text is still exactly what was judged. */
  isCurrent(snapshot: string): boolean {
    return this.targets.some((t) => t.snapshot === snapshot);
  }

  private scopes(): SemanticScope[] {
    return (["sentence", "passage", "section"] as const).filter((s) => semanticRulesFor(this.rules, s).length > 0);
  }

  private recompute() {
    if (this.disposed) return;
    const targets: CurrentTarget[] = [];
    if (!this.paused) {
      for (const scope of this.scopes()) {
        const rules = semanticRulesFor(this.rules, scope);
        for (const target of targetsForScope(this.blocks, scope)) {
          targets.push({ target, snapshot: snapshotId({ target, genre: this.genre, language: this.language, rules }) });
        }
      }
    }
    this.targets = targets;
    const live = new Set(targets.map((t) => t.snapshot));
    for (const req of this.inflight) {
      if (![...req.snapshots].some((s) => live.has(s))) {
        req.abort.abort();
        this.inflight.delete(req);
      }
    }
    this.render();
    this.schedule();
  }

  private pending(scopes: readonly SemanticScope[]): CurrentTarget[] {
    const now = this.now();
    const busy = new Set([...this.inflight].flatMap((r) => [...r.snapshots]));
    const seen = new Set<string>();
    return this.targets.filter((t) => {
      if (!scopes.includes(t.target.scope) || seen.has(t.snapshot)) return false;
      seen.add(t.snapshot);
      if (this.results.has(t.snapshot) || busy.has(t.snapshot)) return false;
      return (this.failedUntil.get(t.snapshot) ?? 0) <= now;
    });
  }

  private schedule() {
    clearTimeout(this.timers.short);
    clearTimeout(this.timers.long);
    if (this.paused) return;
    if (this.pending(["sentence", "passage"]).length) {
      this.timers.short = setTimeout(() => this.flush(["sentence", "passage"]), this.timing.shortDelayMs);
    }
    if (this.pending(["section"]).length) {
      this.timers.long = setTimeout(() => this.flush(["section"]), this.timing.longDelayMs);
    }
  }

  private flush(scopes: SemanticScope[]) {
    if (this.paused || this.disposed) return;
    if (this.deps.isComposing()) {
      setTimeout(() => this.flush(scopes), 300);
      return;
    }
    const pending = this.pending(scopes);
    for (let i = 0; i < pending.length; i += MAX_TARGETS_PER_REQUEST) {
      void this.send(pending.slice(i, i + MAX_TARGETS_PER_REQUEST));
    }
  }

  private async send(batch: CurrentTarget[]) {
    const abort = new AbortController();
    const req = { snapshots: new Set(batch.map((t) => t.snapshot)), abort };
    this.inflight.add(req);
    this.emitStatus();
    const rules = this.rules.filter((r) => r.enabled && r.definition.kind === "semantic").map((r) => ({ id: r.id, version: r.version }));
    try {
      const { results } = await this.deps.lint(
        {
          genre: this.genre,
          language: this.language,
          rules,
          targets: batch.map((t) => ({ snapshot: t.snapshot, scope: t.target.scope, text: t.target.text, context: t.target.context })),
        },
        abort.signal,
      );
      let failed = false;
      for (const r of results) {
        if (r.status === "ok") {
          this.results.set(r.snapshot, r);
          this.failedUntil.delete(r.snapshot);
        } else {
          failed = true;
          this.failedUntil.set(r.snapshot, this.now() + this.timing.retryMs);
        }
      }
      this.unavailable = failed;
      while (this.results.size > MAX_RESULTS) this.results.delete(this.results.keys().next().value!);
    } catch (err) {
      if (abort.signal.aborted) return;
      if ((err as { status?: number }).status === 409) {
        this.deps.onRulesChanged();
      } else {
        this.unavailable = true;
        for (const s of req.snapshots) this.failedUntil.set(s, this.now() + this.timing.retryMs);
      }
    } finally {
      this.inflight.delete(req);
      if (!this.disposed) {
        this.render();
        this.emitStatus();
        if (this.unavailable) this.scheduleRetry();
      }
    }
  }

  private scheduleRetry() {
    clearTimeout(this.timers.retry);
    this.timers.retry = setTimeout(() => this.schedule(), this.timing.retryMs + 50);
  }

  private cancelAll() {
    for (const r of this.inflight) r.abort.abort();
    this.inflight.clear();
    this.emitStatus();
  }

  private emitStatus() {
    this.deps.onStatus(this.paused ? "paused" : this.inflight.size ? "checking" : this.unavailable ? "unavailable" : "idle");
  }

  private isSuppressed(ruleId: string, text: string) {
    return this.suppressed.has(`${ruleId}:${occurrenceKey(ruleId, text)}`);
  }

  private render() {
    if (this.paused) {
      this.deps.onFindings([]);
      return;
    }
    const byId = new Map(this.rules.map((r) => [r.id, r]));
    const findings: DisplayFinding[] = [];

    for (const f of runExactChecks(this.blocks, this.rules)) {
      const rule = byId.get(f.ruleId)!;
      const block = this.blocks[f.range.block]!;
      const sentence = splitSentences(block.text).find((s) => s.start <= f.range.start && f.range.end <= s.end);
      const sentenceText = sentence ? block.text.slice(sentence.start, sentence.end) : block.text;
      const occurrenceText = `${sentenceText}\u0000${block.text.slice(f.range.start, f.range.end)}`;
      if (this.isSuppressed(rule.id, occurrenceText)) continue;
      const { from, to } = docRange(this.blocks, f.range);
      findings.push({
        id: `x:${rule.id}:${from}:${to}`,
        ruleId: rule.id,
        ruleVersion: rule.version,
        ruleName: rule.definition.name,
        preset: rule.preset,
        scope: "phrase",
        semantic: false,
        message: f.message,
        occurrenceText,
        text: sentenceText,
        context: "",
        from,
        to,
      });
    }

    for (const { target, snapshot } of this.targets) {
      const result = this.results.get(snapshot);
      if (!result) continue;
      for (const r of result.results) {
        if (!r.flag) continue;
        const rule = byId.get(r.ruleId);
        if (!rule || rule.version !== r.ruleVersion || rule.definition.kind !== "semantic") continue;
        if (this.isSuppressed(rule.id, target.text)) continue;
        const pattern = rule.definition.patterns?.find((p) => p.id === r.patternId);
        const ranges = target.ranges.map((range) => docRange(this.blocks, range));
        const multi = target.scope !== "sentence";
        findings.push({
          id: `s:${rule.id}:${snapshot}`,
          ruleId: rule.id,
          ruleVersion: rule.version,
          ruleName: rule.definition.name,
          preset: rule.preset,
          scope: target.scope,
          semantic: true,
          message: pattern?.explanation ?? rule.definition.explanation,
          occurrenceText: target.text,
          text: target.text,
          context: target.context,
          snapshot,
          probability: r.probability,
          threshold: r.threshold,
          from: ranges[0]!.from,
          to: ranges.at(-1)!.to,
          ...(multi
            ? { nodes: target.ranges.map((range) => ({ from: this.blocks[range.block]!.nodeFrom, to: this.blocks[range.block]!.nodeTo })) }
            : {}),
        });
      }
    }
    this.deps.onFindings(findings);
  }
}

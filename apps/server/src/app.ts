import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import {
  effectiveThreshold,
  hash64,
  isSemantic,
  occurrenceKey,
  semanticRulesFor,
  snapshotId,
  type Rule,
  type SemanticRuleDefinition,
} from "@jevditor/engine";
import type { Generator } from "./generative.js";
import { RateLimiter } from "./infra.js";
import type { LintService } from "./lint.js";
import {
  draftRequestSchema,
  feedbackSchema,
  labelSchema,
  lintRequestSchema,
  previewRequestSchema,
  ruleDefinitionSchema,
  rewriteRequestSchema,
  ruleSettingsSchema,
} from "./schemas.js";
import type { Store } from "./store.js";

export interface AppDeps {
  store: Store;
  lint: LintService;
  generator?: Generator;
  /** Bearer token → user id. */
  tokens: ReadonlyMap<string, string>;
  limits?: { checksPerMinute?: number; generationsPerMinute?: number };
  log?: (msg: string) => void;
}

type Env = { Variables: { userId: string } };

const SWEEP = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

export function createApp(deps: AppDeps) {
  const { store, lint, generator, tokens } = deps;
  const log = deps.log ?? (() => {});
  const checks = new RateLimiter(deps.limits?.checksPerMinute ?? 240, deps.limits?.checksPerMinute ?? 240);
  const generations = new RateLimiter(deps.limits?.generationsPerMinute ?? 20, deps.limits?.generationsPerMinute ?? 20);

  const app = new Hono<Env>();

  app.use("/api/*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }));

  app.use("/api/*", async (c, next) => {
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    const userId = m ? tokens.get(m[1]!) : undefined;
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", userId);
    await next();
  });

  app.onError((err, c) => {
    // Never log request bodies: they contain the user's writing.
    log(`error ${c.req.method} ${c.req.path}: ${err.name}`);
    return c.json({ error: "internal" }, 500);
  });

  async function body<S extends z.ZodType>(c: Context<Env>, schema: S): Promise<z.infer<S> | Response> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
    }
    return parsed.data;
  }

  function limited(c: Context<Env>, limiter: RateLimiter, cost: number): Response | undefined {
    const r = limiter.take(c.get("userId"), cost);
    if (r.ok) return undefined;
    c.header("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)));
    return c.json({ error: "rate_limited", retryAfterMs: r.retryAfterMs }, 429);
  }

  app.get("/api/status", (c) =>
    c.json({ classifier: lint.classifier.name, model: lint.classifier.model, generation: Boolean(generator) }),
  );

  // Rules -----------------------------------------------------------------

  app.get("/api/rules", (c) => {
    const userId = c.get("userId");
    return c.json({ rules: store.listRules(userId), suppressions: store.listSuppressions(userId) });
  });

  app.post("/api/rules", async (c) => {
    const b = await body(c, ruleDefinitionSchema);
    if (b instanceof Response) return b;
    return c.json({ rule: store.createRule(c.get("userId"), b as Rule["definition"]) }, 201);
  });

  app.put("/api/rules/:id", async (c) => {
    const b = await body(c, ruleDefinitionSchema);
    if (b instanceof Response) return b;
    const existing = store.getRule(c.get("userId"), c.req.param("id"));
    if (!existing) return c.json({ error: "not_found" }, 404);
    if (existing.definition.kind !== b.kind) return c.json({ error: "kind_change" }, 400);
    return c.json({ rule: store.updateDefinition(c.get("userId"), existing.id, b as Rule["definition"]) });
  });

  app.patch("/api/rules/:id", async (c) => {
    const b = await body(c, ruleSettingsSchema);
    if (b instanceof Response) return b;
    const rule = store.updateSettings(c.get("userId"), c.req.param("id"), b);
    return rule ? c.json({ rule }) : c.json({ error: "not_found" }, 404);
  });

  app.delete("/api/rules/:id", (c) =>
    store.deleteRule(c.get("userId"), c.req.param("id")) ? c.body(null, 204) : c.json({ error: "not_found" }, 404),
  );

  app.get("/api/rules/:id/versions", (c) => {
    const versions = store.listVersions(c.get("userId"), c.req.param("id"));
    return versions ? c.json({ versions }) : c.json({ error: "not_found" }, 404);
  });

  // Checking --------------------------------------------------------------

  app.post("/api/lint", async (c) => {
    const b = await body(c, lintRequestSchema);
    if (b instanceof Response) return b;
    const userId = c.get("userId");
    const rules = store.listRules(userId).filter(isSemantic).filter((r) => r.enabled);

    // The client's snapshots must have been computed with the current rule versions.
    const current = new Map(rules.map((r) => [r.id, r.version]));
    const sent = new Map(b.rules.map((r) => [r.id, r.version]));
    const same = current.size === sent.size && [...current].every(([id, v]) => sent.get(id) === v);
    if (!same) return c.json({ error: "rules_changed", rules: store.listRules(userId) }, 409);

    for (const t of b.targets) {
      const expected = snapshotId({ target: t, genre: b.genre, language: b.language, rules: semanticRulesFor(rules, t.scope) });
      if (expected !== t.snapshot) return c.json({ error: "snapshot_mismatch" }, 400);
    }

    const rl = limited(c, checks, b.targets.length);
    if (rl) return rl;

    const suppressed = store.suppressedKeys(userId);
    const signal = c.req.raw.signal;
    const results = await Promise.all(
      b.targets.map((target) =>
        lint.lintTarget({ userId, target, genre: b.genre, language: b.language, rules, suppressed, signal }),
      ),
    );
    return c.json({ results });
  });

  /** Evaluate an unsaved definition against sample texts. Nothing is cached or stored. */
  app.post("/api/rules/preview", async (c) => {
    const b = await body(c, previewRequestSchema);
    if (b instanceof Response) return b;
    const rl = limited(c, checks, b.samples.length);
    if (rl) return rl;
    const def = b.definition as SemanticRuleDefinition;
    const threshold = effectiveThreshold(def.threshold, "normal");
    try {
      const items = await mapLimit(b.samples, 6, async (s) => {
        const r = await lint.judge([def], s.text, s.context, b.genre, c.req.raw.signal);
        const j = r.judgments[0]!;
        return { probability: j.probability, flag: j.probability >= threshold, patternId: j.patternId ?? null };
      });
      return c.json({ threshold, model: lint.classifier.model, items });
    } catch (err) {
      log(`preview failed: ${(err as Error).name}`);
      return c.json({ error: "checking_unavailable" }, 502);
    }
  });

  // Feedback --------------------------------------------------------------

  app.post("/api/feedback", async (c) => {
    const b = await body(c, feedbackSchema);
    if (b instanceof Response) return b;
    const userId = c.get("userId");
    const rule = store.getRule(userId, b.ruleId);
    if (!rule) return c.json({ error: "not_found" }, 404);
    if (b.kind === "keep-occurrence") {
      const suppression = store.addSuppression(userId, rule.id, occurrenceKey(rule.id, b.text), b.text);
      return c.json({ suppression });
    }
    // "Allow writing like this": save an approved negative example as a new rule version.
    if (!isSemantic(rule)) return c.json({ error: "not_semantic" }, 400);
    const def = rule.definition;
    if (def.examples.some((e) => e.text === b.text && !e.flag)) return c.json({ rule });
    const examples = [...def.examples.filter((e) => e.text !== b.text), { text: b.text, flag: false }].slice(-30);
    return c.json({ rule: store.updateDefinition(userId, rule.id, { ...def, examples }) });
  });

  app.delete("/api/suppressions/:id", (c) =>
    store.deleteSuppression(c.get("userId"), c.req.param("id")) ? c.body(null, 204) : c.json({ error: "not_found" }, 404),
  );

  // Evaluation set --------------------------------------------------------

  app.get("/api/rules/:id/labels", (c) => {
    const rule = store.getRule(c.get("userId"), c.req.param("id"));
    if (!rule) return c.json({ error: "not_found" }, 404);
    return c.json({ labels: store.listLabels(c.get("userId"), rule.id) });
  });

  app.post("/api/rules/:id/labels", async (c) => {
    const b = await body(c, labelSchema);
    if (b instanceof Response) return b;
    const rule = store.getRule(c.get("userId"), c.req.param("id"));
    if (!rule) return c.json({ error: "not_found" }, 404);
    // Unless told otherwise, hold out roughly one label in five, deterministically by text.
    const heldOut = b.heldOut ?? parseInt(hash64(b.text).slice(0, 8), 16) % 5 === 0;
    return c.json({ label: store.addLabel(c.get("userId"), rule.id, { text: b.text, context: b.context, flag: b.flag, heldOut }) }, 201);
  });

  app.delete("/api/rules/:id/labels/:labelId", (c) =>
    store.deleteLabel(c.get("userId"), c.req.param("id"), c.req.param("labelId"))
      ? c.body(null, 204)
      : c.json({ error: "not_found" }, 404),
  );

  /** Run the current rule version over its labeled set and report agreement. */
  app.post("/api/rules/:id/evaluate", async (c) => {
    const userId = c.get("userId");
    const rule = store.getRule(userId, c.req.param("id"));
    if (!rule || !isSemantic(rule)) return c.json({ error: "not_found" }, 404);
    const labels = store.listLabels(userId, rule.id);
    if (!labels.length) return c.json({ error: "no_labels" }, 400);
    const rl = limited(c, checks, labels.length);
    if (rl) return rl;
    const threshold = effectiveThreshold(rule.definition.threshold, rule.sensitivity);
    try {
      const items = await mapLimit(labels, 6, async (l) => {
        const r = await lint.judge([rule.definition], l.text, l.context, "general", c.req.raw.signal);
        return { labelId: l.id, flag: l.flag, heldOut: l.heldOut, probability: r.judgments[0]!.probability };
      });
      const split = (heldOut: boolean) => items.filter((i) => i.heldOut === heldOut);
      return c.json({
        ruleVersion: rule.version,
        model: lint.classifier.model,
        threshold,
        items,
        dev: metrics(split(false), threshold),
        heldOut: metrics(split(true), threshold),
        sweep: SWEEP.map((t) => ({ threshold: t, dev: metrics(split(false), t), heldOut: metrics(split(true), t) })),
      });
    } catch (err) {
      log(`evaluate failed: ${(err as Error).name}`);
      return c.json({ error: "checking_unavailable" }, 502);
    }
  });

  // Generation ------------------------------------------------------------

  app.post("/api/rules/draft", async (c) => {
    if (!generator) return c.json({ error: "generation_unavailable" }, 503);
    const b = await body(c, draftRequestSchema);
    if (b instanceof Response) return b;
    const rl = limited(c, generations, 1);
    if (rl) return rl;
    try {
      return c.json(await generator.draftRule(b.request));
    } catch (err) {
      log(`draft failed: ${(err as Error).name}`);
      return c.json({ error: "generation_failed", message: (err as Error).name === "GenerationError" ? (err as Error).message : undefined }, 502);
    }
  });

  app.post("/api/rewrite", async (c) => {
    if (!generator) return c.json({ error: "generation_unavailable" }, 503);
    const b = await body(c, rewriteRequestSchema);
    if (b instanceof Response) return b;
    const rl = limited(c, generations, 1);
    if (rl) return rl;
    const userId = c.get("userId");
    const rules = b.ruleIds
      .map((id) => store.getRule(userId, id))
      .filter((r): r is Rule => Boolean(r))
      .map((r) => (isSemantic(r) ? `${r.definition.name}: flag when ${r.definition.flagWhen} Allow when ${r.definition.allowWhen}` : r.definition.name));
    let rewrite: string;
    try {
      rewrite = await generator.rewrite({ text: b.text, context: b.context, instruction: b.instruction, rules });
    } catch (err) {
      log(`rewrite failed: ${(err as Error).name}`);
      return c.json({ error: "generation_failed" }, 502);
    }
    // The meaning check is advisory. When it fails, the writer still gets the rewrite and reads it without a verdict.
    let samePoint: { probability: number; model: string } | null = null;
    try {
      const r = await lint.comparePoint({ original: b.text, revised: rewrite, context: b.context, rules });
      samePoint = { probability: r.probability, model: r.model };
    } catch (err) {
      log(`same-point check failed: ${(err as Error).name}`);
    }
    return c.json({ rewrite, samePoint });
  });

  return app;
}

export function metrics(items: ReadonlyArray<{ flag: boolean; probability: number }>, threshold: number) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const i of items) {
    const shown = i.probability >= threshold;
    if (shown && i.flag) tp++;
    else if (shown) fp++;
    else if (i.flag) fn++;
    else tn++;
  }
  return {
    count: items.length,
    shown: tp + fp,
    tp, fp, fn, tn,
    /** Helpful findings among displayed findings. */
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
  };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

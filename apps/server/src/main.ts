import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { DemoClassifier, JevClassifier } from "./classifier.js";
import { loadConfig } from "./config.js";
import { ClaudeGenerator } from "./generative.js";
import { Gate } from "./infra.js";
import { LintService } from "./lint.js";
import { Store } from "./store.js";

const config = loadConfig();
const log = (msg: string) => console.log(`[jewriter] ${msg}`);

const classifier = config.demo
  ? new DemoClassifier()
  : new JevClassifier({ apiKey: config.typesafeApiKey, model: config.jevModel, timeoutMs: config.jevTimeoutMs });

const lint = new LintService(
  classifier,
  new Gate(config.jevMaxConcurrent, config.jevRequestsPerMinute),
  { cacheEntries: 20_000, cacheTtlMs: 24 * 60 * 60 * 1000 },
  (err) => log(`classifier error: ${(err as Error).name}${"status" in (err as object) ? ` ${(err as { status: number }).status}` : ""}`),
);

const app = createApp({
  store: new Store(config.dbPath),
  lint,
  generator: config.generation ? new ClaudeGenerator(config.anthropicModel) : undefined,
  tokens: config.tokens,
  log,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  log(`listening on http://localhost:${info.port}`);
  log(`classifier: ${classifier.name} (${classifier.model})${config.demo ? " — demo only, not Jev" : ""}`);
  log(`generation: ${config.generation ? config.anthropicModel : "off (set ANTHROPIC_API_KEY to enable rule drafting and rewrites)"}`);
  if (config.tokens.has("dev-token")) log("auth: development token 'dev-token' (set JEWRITER_TOKENS for real users)");
});

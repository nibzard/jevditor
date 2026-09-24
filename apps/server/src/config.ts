export interface Config {
  port: number;
  dbPath: string;
  tokens: Map<string, string>;
  typesafeApiKey: string | undefined;
  jevModel: string;
  jevTimeoutMs: number;
  /** Use the offline demo classifier instead of Jev. */
  demo: boolean;
  anthropicModel: string;
  generation: boolean;
  jevMaxConcurrent: number;
  jevRequestsPerMinute: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const tokens = new Map<string, string>();
  for (const pair of (env.JEVDITOR_TOKENS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [token, user] = pair.split(":");
    if (!token || !user || token.length < 8) throw new Error("JEVDITOR_TOKENS must be token:user pairs with tokens of 8+ characters");
    tokens.set(token, user);
  }
  if (!tokens.size) {
    if (production) throw new Error("JEVDITOR_TOKENS is required in production");
    tokens.set("dev-token", "dev");
  }

  const typesafeApiKey = env.TYPESAFE_API_KEY?.trim() || undefined;
  const demo = env.JEVDITOR_DEMO === "1" || (!typesafeApiKey && !production);
  if (!typesafeApiKey && !demo) throw new Error("TYPESAFE_API_KEY is required unless JEVDITOR_DEMO=1");
  if (production && demo) throw new Error("The demo classifier cannot run in production");

  return {
    port: Number(env.PORT ?? 8787),
    dbPath: env.JEVDITOR_DB ?? "jevditor.db",
    tokens,
    typesafeApiKey,
    // Pin a tested version: aliases such as jev-latest can move and shift tuned thresholds.
    jevModel: env.JEVDITOR_JEV_MODEL ?? "jev-1.13.0",
    jevTimeoutMs: Number(env.JEVDITOR_JEV_TIMEOUT_MS ?? 1500),
    demo,
    anthropicModel: env.JEVDITOR_CLAUDE_MODEL ?? "claude-opus-5",
    generation: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) && env.JEVDITOR_GENERATION !== "0",
    jevMaxConcurrent: Number(env.JEVDITOR_JEV_CONCURRENCY ?? 32),
    // Documented limit is 1,200 requests/minute and may change; stay below it.
    jevRequestsPerMinute: Number(env.JEVDITOR_JEV_RPM ?? 1000),
  };
}

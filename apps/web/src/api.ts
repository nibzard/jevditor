import type { Rule, RuleDefinition, SemanticRuleDefinition, Sensitivity } from "@jevditor/engine";

const TOKEN = (import.meta.env.VITE_JEVDITOR_TOKEN as string | undefined) ?? "dev-token";

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: any) {
    super(body?.error ?? `HTTP ${status}`);
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export interface Suppression {
  id: string;
  ruleId: string;
  key: string;
  excerpt: string;
  createdAt: string;
}

export interface RuleResult {
  ruleId: string;
  ruleVersion: number;
  probability: number;
  threshold: number;
  flag: boolean;
  suppressed: boolean;
  patternId?: string;
  /** For sentence rules: the part of the target that shows the match best. Offsets index into the target text. */
  phrase?: { start: number; end: number; confidence: number };
}

export type TargetResult =
  | { snapshot: string; status: "ok"; model: string; cached: boolean; results: RuleResult[] }
  | { snapshot: string; status: "error"; error: string };

export interface LintRequest {
  genre: string;
  language: string;
  rules: Array<{ id: string; version: number }>;
  targets: Array<{ snapshot: string; scope: string; text: string; context: string }>;
}

export interface Metrics {
  count: number;
  shown: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
}

export interface Label {
  id: string;
  ruleId: string;
  text: string;
  context: string;
  flag: boolean;
  heldOut: boolean;
  createdAt: string;
}

export interface Evaluation {
  ruleVersion: number;
  model: string;
  threshold: number;
  items: Array<{ labelId: string; flag: boolean; heldOut: boolean; probability: number }>;
  dev: Metrics;
  heldOut: Metrics;
  sweep: Array<{ threshold: number; dev: Metrics; heldOut: Metrics }>;
}

export interface PreviewResult {
  threshold: number;
  model: string;
  items: Array<{ probability: number; flag: boolean; patternId: string | null }>;
}

export interface RuleDraft {
  definition: SemanticRuleDefinition;
  candidates: Array<{ text: string; suggested: "flag" | "allow" }>;
}

export const api = {
  status: () => request<{ classifier: "jev" | "demo"; model: string; generation: boolean }>("GET", "/api/status"),
  rules: () => request<{ rules: Rule[]; suppressions: Suppression[] }>("GET", "/api/rules"),
  createRule: (definition: RuleDefinition) => request<{ rule: Rule }>("POST", "/api/rules", definition),
  updateRule: (id: string, definition: RuleDefinition) => request<{ rule: Rule }>("PUT", `/api/rules/${id}`, definition),
  updateSettings: (id: string, settings: { enabled?: boolean; sensitivity?: Sensitivity }) =>
    request<{ rule: Rule }>("PATCH", `/api/rules/${id}`, settings),
  deleteRule: (id: string) => request<void>("DELETE", `/api/rules/${id}`),
  lint: (body: LintRequest, signal?: AbortSignal) => request<{ results: TargetResult[] }>("POST", "/api/lint", body, signal),
  preview: (definition: SemanticRuleDefinition, samples: Array<{ text: string; context?: string }>, genre = "general") =>
    request<PreviewResult>("POST", "/api/rules/preview", { definition, samples, genre }),
  keepOccurrence: (ruleId: string, text: string) =>
    request<{ suppression: Suppression }>("POST", "/api/feedback", { kind: "keep-occurrence", ruleId, text }),
  allowLikeThis: (ruleId: string, text: string) => request<{ rule: Rule }>("POST", "/api/feedback", { kind: "allow-like-this", ruleId, text }),
  deleteSuppression: (id: string) => request<void>("DELETE", `/api/suppressions/${id}`),
  labels: (ruleId: string) => request<{ labels: Label[] }>("GET", `/api/rules/${ruleId}/labels`),
  addLabel: (ruleId: string, label: { text: string; context?: string; flag: boolean }) =>
    request<{ label: Label }>("POST", `/api/rules/${ruleId}/labels`, label),
  deleteLabel: (ruleId: string, id: string) => request<void>("DELETE", `/api/rules/${ruleId}/labels/${id}`),
  evaluate: (ruleId: string) => request<Evaluation>("POST", `/api/rules/${ruleId}/evaluate`),
  draft: (text: string) => request<RuleDraft>("POST", "/api/rules/draft", { request: text }),
  rewrite: (body: { text: string; context: string; instruction: string; ruleIds: string[] }) =>
    request<{ rewrite: string; samePoint: { probability: number; model: string } | null }>("POST", "/api/rewrite", body),
};

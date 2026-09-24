import { hash64 } from "./hash.js";
import { ruleVersionKey } from "./rules.js";
import type { Rule, Target } from "./types.js";

export interface SnapshotInput {
  target: Pick<Target, "scope" | "text" | "context">;
  genre: string;
  language: string;
  rules: readonly Pick<Rule, "id" | "version">[];
}

/**
 * Identity of everything that can change a judgment: the target, its context,
 * the document genre and language, and the exact rule versions. A result is
 * rendered only while the current snapshot matches the one it was computed for.
 *
 * Text is not normalized: paragraph breaks and punctuation are meaningful.
 */
export function snapshotId({ target, genre, language, rules }: SnapshotInput): string {
  return hash64(
    JSON.stringify([target.scope, target.text, target.context, genre, language, ruleVersionKey(rules)]),
  );
}

/** Key for "Keep this occurrence": the same rule on the same text stays quiet. */
export function occurrenceKey(ruleId: string, text: string): string {
  return hash64(JSON.stringify([ruleId, text.trim()]));
}

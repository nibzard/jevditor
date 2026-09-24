import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PRESET_RULES, type Rule, type RuleDefinition, type Sensitivity } from "@jewriter/engine";

export interface Label {
  id: string;
  ruleId: string;
  text: string;
  context: string;
  flag: boolean;
  heldOut: boolean;
  createdAt: string;
}

export interface Suppression {
  id: string;
  ruleId: string;
  key: string;
  excerpt: string;
  createdAt: string;
}

/**
 * Persistence for users' rules, rule versions, suppressions, and labeled
 * evaluation examples. SQLite keeps local development dependency-free; the
 * schema is plain enough to move to Postgres unchanged.
 *
 * Document bodies are never stored here. Only text the writer explicitly
 * labels, allows, or keeps is saved, and only for that writer.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        sensitivity TEXT NOT NULL,
        preset TEXT,
        position INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS rules_user ON rules(user_id);
      CREATE TABLE IF NOT EXISTS rule_versions (
        rule_id TEXT NOT NULL REFERENCES rules(id),
        version INTEGER NOT NULL,
        definition TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (rule_id, version)
      );
      CREATE TABLE IF NOT EXISTS seeded_users (user_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS suppressions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        rule_id TEXT NOT NULL REFERENCES rules(id),
        key TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (user_id, rule_id, key)
      );
      CREATE TABLE IF NOT EXISTS labels (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        rule_id TEXT NOT NULL REFERENCES rules(id),
        text TEXT NOT NULL,
        context TEXT NOT NULL,
        flag INTEGER NOT NULL,
        held_out INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Give a new user the preset rules, once. Deleted presets stay deleted. */
  private seed(userId: string) {
    const seeded = this.db.prepare("SELECT 1 FROM seeded_users WHERE user_id = ?").get(userId);
    if (seeded) return;
    this.tx(() => {
      this.db.prepare("INSERT INTO seeded_users (user_id) VALUES (?)").run(userId);
      PRESET_RULES.forEach((p, i) => this.insertRule(userId, p.definition, p.enabled, p.sensitivity, p.key, i));
    });
  }

  private insertRule(
    userId: string,
    definition: RuleDefinition,
    enabled: boolean,
    sensitivity: Sensitivity,
    preset: string | null,
    position: number,
  ): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO rules (id, user_id, version, enabled, sensitivity, preset, position) VALUES (?, ?, 1, ?, ?, ?, ?)")
      .run(id, userId, enabled ? 1 : 0, sensitivity, preset, position);
    this.db
      .prepare("INSERT INTO rule_versions (rule_id, version, definition, created_at) VALUES (?, 1, ?, ?)")
      .run(id, JSON.stringify(definition), new Date().toISOString());
    return id;
  }

  listRules(userId: string): Rule[] {
    this.seed(userId);
    const rows = this.db
      .prepare(
        `SELECT r.id, r.version, r.enabled, r.sensitivity, r.preset, v.definition
         FROM rules r JOIN rule_versions v ON v.rule_id = r.id AND v.version = r.version
         WHERE r.user_id = ? AND r.deleted = 0 ORDER BY r.position, r.rowid`,
      )
      .all(userId) as Array<{ id: string; version: number; enabled: number; sensitivity: Sensitivity; preset: string | null; definition: string }>;
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      enabled: r.enabled === 1,
      sensitivity: r.sensitivity,
      preset: r.preset !== null,
      definition: JSON.parse(r.definition) as RuleDefinition,
    }));
  }

  /** Returns the rule only if it belongs to `userId`. */
  getRule(userId: string, ruleId: string): Rule | undefined {
    return this.listRules(userId).find((r) => r.id === ruleId);
  }

  createRule(userId: string, definition: RuleDefinition, sensitivity: Sensitivity = "normal"): Rule {
    this.seed(userId);
    const { n } = this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM rules WHERE user_id = ?").get(userId) as { n: number };
    const id = this.tx(() => this.insertRule(userId, definition, true, sensitivity, null, n));
    return this.getRule(userId, id)!;
  }

  /** Saves a new version. Older versions are kept for history and evaluation. */
  updateDefinition(userId: string, ruleId: string, definition: RuleDefinition): Rule | undefined {
    const rule = this.getRule(userId, ruleId);
    if (!rule) return undefined;
    if (rule.definition.kind !== definition.kind) throw new Error("A rule's kind cannot change");
    if (JSON.stringify(rule.definition) === JSON.stringify(definition)) return rule;
    const next = rule.version + 1;
    this.tx(() => {
      this.db
        .prepare("INSERT INTO rule_versions (rule_id, version, definition, created_at) VALUES (?, ?, ?, ?)")
        .run(ruleId, next, JSON.stringify(definition), new Date().toISOString());
      this.db.prepare("UPDATE rules SET version = ? WHERE id = ?").run(next, ruleId);
    });
    return this.getRule(userId, ruleId);
  }

  updateSettings(userId: string, ruleId: string, settings: { enabled?: boolean; sensitivity?: Sensitivity }): Rule | undefined {
    if (!this.getRule(userId, ruleId)) return undefined;
    if (settings.enabled !== undefined) this.db.prepare("UPDATE rules SET enabled = ? WHERE id = ?").run(settings.enabled ? 1 : 0, ruleId);
    if (settings.sensitivity) this.db.prepare("UPDATE rules SET sensitivity = ? WHERE id = ?").run(settings.sensitivity, ruleId);
    return this.getRule(userId, ruleId);
  }

  deleteRule(userId: string, ruleId: string): boolean {
    if (!this.getRule(userId, ruleId)) return false;
    this.db.prepare("UPDATE rules SET deleted = 1 WHERE id = ?").run(ruleId);
    return true;
  }

  listVersions(userId: string, ruleId: string): Array<{ version: number; definition: RuleDefinition; createdAt: string }> | undefined {
    if (!this.getRule(userId, ruleId)) return undefined;
    const rows = this.db
      .prepare("SELECT version, definition, created_at FROM rule_versions WHERE rule_id = ? ORDER BY version DESC")
      .all(ruleId) as Array<{ version: number; definition: string; created_at: string }>;
    return rows.map((r) => ({ version: r.version, definition: JSON.parse(r.definition), createdAt: r.created_at }));
  }

  addSuppression(userId: string, ruleId: string, key: string, excerpt: string): Suppression {
    this.db
      .prepare(
        "INSERT INTO suppressions (id, user_id, rule_id, key, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(randomUUID(), userId, ruleId, key, excerpt.slice(0, 160), new Date().toISOString());
    return this.listSuppressions(userId).find((s) => s.ruleId === ruleId && s.key === key)!;
  }

  listSuppressions(userId: string): Suppression[] {
    const rows = this.db
      .prepare("SELECT id, rule_id, key, excerpt, created_at FROM suppressions WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as Array<{ id: string; rule_id: string; key: string; excerpt: string; created_at: string }>;
    return rows.map((r) => ({ id: r.id, ruleId: r.rule_id, key: r.key, excerpt: r.excerpt, createdAt: r.created_at }));
  }

  suppressedKeys(userId: string): Set<string> {
    return new Set(this.listSuppressions(userId).map((s) => `${s.ruleId}:${s.key}`));
  }

  deleteSuppression(userId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM suppressions WHERE id = ? AND user_id = ?").run(id, userId).changes) > 0;
  }

  addLabel(userId: string, ruleId: string, label: { text: string; context: string; flag: boolean; heldOut: boolean }): Label {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO labels (id, user_id, rule_id, text, context, flag, held_out, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, ruleId, label.text, label.context, label.flag ? 1 : 0, label.heldOut ? 1 : 0, createdAt);
    return { id, ruleId, ...label, createdAt };
  }

  listLabels(userId: string, ruleId: string): Label[] {
    const rows = this.db
      .prepare("SELECT id, text, context, flag, held_out, created_at FROM labels WHERE user_id = ? AND rule_id = ? ORDER BY created_at")
      .all(userId, ruleId) as Array<{ id: string; text: string; context: string; flag: number; held_out: number; created_at: string }>;
    return rows.map((r) => ({
      id: r.id,
      ruleId,
      text: r.text,
      context: r.context,
      flag: r.flag === 1,
      heldOut: r.held_out === 1,
      createdAt: r.created_at,
    }));
  }

  deleteLabel(userId: string, ruleId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM labels WHERE id = ? AND user_id = ? AND rule_id = ?").run(id, userId, ruleId).changes) > 0;
  }
}

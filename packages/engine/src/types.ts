/**
 * Core types shared by the server and every editor integration.
 *
 * The engine never talks to a model. It segments text into targets with known
 * offsets, runs exact checks in code, and computes snapshot identities. The
 * server asks Jev about semantic rules; editors render the results.
 */

/** Where a rule's judgment applies. */
export type Scope = "phrase" | "sentence" | "passage" | "section";

/** Scopes judged by the model rather than by code. */
export type SemanticScope = Exclude<Scope, "phrase">;

/** How readily a rule interrupts. Separate from what the rule means. */
export type Sensitivity = "gentle" | "normal" | "strict";

export interface RuleExample {
  text: string;
  /** true: this should be flagged. false: this should be allowed. */
  flag: boolean;
}

/**
 * A predefined way a rule can be violated. When a rule is flagged, a Choice
 * question picks the best-fitting pattern so the card can show a useful
 * explanation without a generative-model call.
 */
export interface RulePattern {
  id: string;
  label: string;
  /** Shown to the classifier. */
  description: string;
  /** Shown to the writer on the finding card. */
  explanation: string;
}

export interface SemanticRuleDefinition {
  kind: "semantic";
  name: string;
  scope: SemanticScope;
  /** The yes/no question asked about `target`. */
  question: string;
  flagWhen: string;
  allowWhen: string;
  /** How to treat quotes, parody, and other edge cases. */
  boundaryCases?: string;
  examples: RuleExample[];
  patterns?: RulePattern[];
  /** Card text used when no pattern is selected. */
  explanation: string;
  /** Probability at or above which a finding is shown at "normal" sensitivity. */
  threshold: number;
}

export interface PhraseRuleDefinition {
  kind: "phrases";
  name: string;
  phrases: string[];
  caseSensitive?: boolean;
  explanation: string;
}

export interface RepeatedWordRuleDefinition {
  kind: "repeated-word";
  name: string;
  explanation: string;
}

export interface SentenceLengthRuleDefinition {
  kind: "sentence-length";
  name: string;
  maxWords: number;
  explanation: string;
}

export type ExactRuleDefinition =
  | PhraseRuleDefinition
  | RepeatedWordRuleDefinition
  | SentenceLengthRuleDefinition;

export type RuleDefinition = SemanticRuleDefinition | ExactRuleDefinition;

/**
 * A saved rule. `version` increments whenever `definition` changes; results
 * computed against an older version are never shown. `enabled` and
 * `sensitivity` change only how results are displayed, so they do not bump
 * the version.
 */
export interface Rule {
  id: string;
  version: number;
  enabled: boolean;
  sensitivity: Sensitivity;
  preset: boolean;
  definition: RuleDefinition;
}

export interface SemanticRule extends Rule {
  definition: SemanticRuleDefinition;
}

/** A block of text extracted from an editor, e.g. one paragraph. */
export interface TextBlock {
  /** "heading" blocks end passages and start sections. */
  type: "paragraph" | "heading" | "other";
  text: string;
}

/** A character range inside one block. `end` is exclusive. */
export interface BlockRange {
  block: number;
  start: number;
  end: number;
}

/** A unit of text the model judges, with the ranges it covers. */
export interface Target {
  scope: SemanticScope;
  /** Ranges in block coordinates; passages and sections span several blocks. */
  ranges: BlockRange[];
  text: string;
  context: string;
}

/** A finding produced by code, positioned exactly. */
export interface ExactFinding {
  ruleId: string;
  ruleVersion: number;
  range: BlockRange;
  message: string;
}

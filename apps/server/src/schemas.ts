import { z } from "zod";

const text = (max: number) => z.string().max(max);

export const ruleExampleSchema = z.object({ text: text(2000).min(1), flag: z.boolean() });

export const rulePatternSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  label: text(60).min(1),
  description: text(400).min(1),
  explanation: text(300).min(1),
});

export const semanticDefinitionSchema = z.object({
  kind: z.literal("semantic"),
  name: text(80).min(1),
  scope: z.enum(["sentence", "passage", "section"]),
  question: text(500).min(1),
  flagWhen: text(1200).min(1),
  allowWhen: text(1200).min(1),
  boundaryCases: text(800).optional(),
  examples: z.array(ruleExampleSchema).max(30),
  patterns: z
    .array(rulePatternSchema)
    .max(8)
    .refine((p) => new Set(p.map((x) => x.id)).size === p.length && !p.some((x) => x.id === "none"), {
      message: "pattern ids must be unique and not 'none'",
    })
    .optional(),
  explanation: text(300).min(1),
  threshold: z.number().min(0.5).max(0.99),
});

export const ruleDefinitionSchema = z.discriminatedUnion("kind", [
  semanticDefinitionSchema,
  z.object({
    kind: z.literal("phrases"),
    name: text(80).min(1),
    phrases: z.array(text(80).min(1)).min(1).max(200),
    caseSensitive: z.boolean().optional(),
    explanation: text(300),
  }),
  z.object({ kind: z.literal("repeated-word"), name: text(80).min(1), explanation: text(300) }),
  z.object({
    kind: z.literal("sentence-length"),
    name: text(80).min(1),
    maxWords: z.number().int().min(5).max(200),
    explanation: text(300),
  }),
]);

export const sensitivitySchema = z.enum(["gentle", "normal", "strict"]);

export const ruleSettingsSchema = z
  .object({ enabled: z.boolean().optional(), sensitivity: sensitivitySchema.optional() })
  .strict();

export const MAX_TARGET_CHARS = 9000;
export const MAX_CONTEXT_CHARS = 2000;

export const targetSchema = z.object({
  snapshot: z.string().regex(/^[0-9a-f]{16}$/),
  scope: z.enum(["sentence", "passage", "section"]),
  text: text(MAX_TARGET_CHARS).min(1),
  context: text(MAX_CONTEXT_CHARS),
});

export const lintRequestSchema = z.object({
  genre: text(40).default("general"),
  language: text(16).default("en"),
  /** The rule versions the client used for its snapshots. */
  rules: z.array(z.object({ id: z.string().max(64), version: z.number().int().positive() })).max(50),
  targets: z.array(targetSchema).min(1).max(24),
});

export const previewRequestSchema = z.object({
  definition: semanticDefinitionSchema,
  genre: text(40).default("general"),
  samples: z.array(z.object({ text: text(MAX_TARGET_CHARS).min(1), context: text(MAX_CONTEXT_CHARS).default("") })).min(1).max(40),
});

export const feedbackSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("keep-occurrence"), ruleId: z.string().max(64), text: text(MAX_TARGET_CHARS).min(1) }),
  z.object({ kind: z.literal("allow-like-this"), ruleId: z.string().max(64), text: text(2000).min(1) }),
]);

export const labelSchema = z.object({
  text: text(MAX_TARGET_CHARS).min(1),
  context: text(MAX_CONTEXT_CHARS).default(""),
  flag: z.boolean(),
  heldOut: z.boolean().optional(),
});

export const draftRequestSchema = z.object({ request: text(1000).min(3) });

export const rewriteRequestSchema = z.object({
  text: text(4000).min(1),
  context: text(MAX_CONTEXT_CHARS).default(""),
  instruction: text(500).default(""),
  ruleIds: z.array(z.string().max(64)).max(10).default([]),
});

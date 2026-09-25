// ABOUTME: Document-level writing samples with the expected result of each semantic preset rule.
// ABOUTME: The eval script runs them against Jev; clean samples check that rules stay quiet.
import type { TextBlock } from "@jevditor/engine";

export type Expectation = "flag" | "allow";

export interface Sample {
  name: string;
  blocks: TextBlock[];
  /** Keyed by preset key. "flag": at least one target must be flagged. "allow": no target may be flagged. */
  expect: Record<string, Expectation>;
}

const p = (...texts: string[]): TextBlock[] => texts.map((text) => ({ type: "paragraph", text }));

const ALL_ALLOW = { "linkedin-voice": "allow", "marketing-copy": "allow", "vague-claims": "allow", "repeated-explanation": "allow" } as const;

export const SAMPLES: readonly Sample[] = [
  {
    name: "Intentionally clear",
    blocks: p(
      "The bridge closes at midnight. Cars must use the tunnel until six in the morning.",
      "Cyclists can cross at any time. Signs at both ends show the current status.",
    ),
    expect: ALL_ALLOW,
  },
  {
    name: "Awkward but valid",
    blocks: p(
      "The report, which the council published on Tuesday after two delays, lists 14 junctions where collisions rose.",
      "Of those junctions, nine have no protected crossing, and five of the nine are near schools.",
    ),
    expect: ALL_ALLOW,
  },
  {
    name: "Technical prose",
    blocks: p(
      "The cache key includes the user id, the target text, and every rule version. When a rule changes, its old entries no longer match.",
      "Entries expire after ten minutes. The server keeps at most 5,000 of them and removes the least recently used first.",
    ),
    expect: ALL_ALLOW,
  },
  {
    name: "Marketing copy",
    blocks: p(
      "Meet the revolutionary task manager that transforms the way you work.",
      "Unlock your full potential with seamless, next-level productivity.",
    ),
    // Hype like "unlock your full potential" is also vague, so both sentence rules apply.
    expect: { ...ALL_ALLOW, "marketing-copy": "flag", "vague-claims": "flag" },
  },
  {
    name: "Vague claims",
    blocks: p(
      "Bike lanes deliver results in many ways. They create value for communities and drive positive outcomes.",
      "Various studies suggest that things generally improve over time.",
    ),
    expect: { ...ALL_ALLOW, "vague-claims": "flag" },
  },
  {
    name: "LinkedIn voice",
    blocks: p(
      "I missed my train this morning.",
      "It taught me more about leadership than ten years in management.",
      "Here are five lessons every founder needs to hear.",
    ),
    expect: { ...ALL_ALLOW, "linkedin-voice": "flag" },
  },
  {
    name: "Explained twice",
    blocks: p(
      "Snapshots stop old results from being shown. Each result is stored with the exact text, context, and rule versions it was computed for.",
      "When any of those change, the snapshot changes too, and the editor does not display the old result.",
      "In other words, a result only appears if it was computed for exactly the text you see now. Results for older text are never displayed.",
    ),
    expect: { ...ALL_ALLOW, "repeated-explanation": "flag" },
  },
];

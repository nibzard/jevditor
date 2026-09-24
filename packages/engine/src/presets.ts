import { DEFAULT_THRESHOLD } from "./rules.js";
import type { RuleDefinition, Sensitivity } from "./types.js";

export interface PresetRule {
  /** Stable key; the server derives per-user rule ids from it. */
  key: string;
  enabled: boolean;
  sensitivity: Sensitivity;
  definition: RuleDefinition;
}

/**
 * Starting rules. Wording and thresholds are hypotheses to be tested against
 * labeled examples, not validated settings.
 */
export const PRESET_RULES: readonly PresetRule[] = [
  {
    key: "linkedin-voice",
    enabled: true,
    sensitivity: "normal",
    definition: {
      kind: "semantic",
      name: "Avoid LinkedIn voice",
      scope: "passage",
      question:
        "Does target use performative professional self-branding, turn an ordinary experience into a contrived business lesson, or use engagement-bait framing?",
      flagWhen:
        "The writing performs professional identity for an audience: an everyday event recast as a leadership or career lesson, a humblebrag, a listicle promise such as 'five lessons every founder needs to hear', or a hook designed to provoke engagement rather than inform.",
      allowWhen:
        "The writing plainly describes a job, an achievement, a professional experience, or real enthusiasm without dressing it up as a lesson or a hook. Words like 'founder', 'leadership', or 'excited' alone are not a reason to flag.",
      boundaryCases:
        "Quoted examples of this style, and deliberate parody that the surrounding context makes obvious, should be allowed.",
      examples: [
        {
          text: "I missed my train this morning.\n\nIt taught me more about leadership than ten years in management.\n\nHere are five lessons every founder needs to hear.",
          flag: true,
        },
        {
          text: "Humbled and honored to announce that I've been named one of the top voices in fintech. Agree?",
          flag: true,
        },
        {
          text: "I'm starting a new job at Acme next month as a data engineer. I'll be working on their billing pipeline.",
          flag: false,
        },
        {
          text: "Our team shipped the migration on Friday. It took four months and two false starts, and I'm glad it's done.",
          flag: false,
        },
      ],
      patterns: [
        {
          id: "contrived-lesson",
          label: "Contrived lesson",
          description: "An ordinary event is reframed as a professional or leadership lesson.",
          explanation: "This passage may turn an ordinary experience into a professional lesson.",
        },
        {
          id: "humblebrag",
          label: "Humblebrag",
          description: "Self-promotion disguised as humility or gratitude.",
          explanation: "This passage may present self-promotion as humility.",
        },
        {
          id: "engagement-bait",
          label: "Engagement bait",
          description: "Hooks, cliffhangers, listicle promises, or prompts like 'Agree?' designed to drive reactions.",
          explanation: "This passage may be framed to provoke reactions rather than inform.",
        },
      ],
      explanation: "This passage may match your rule about LinkedIn-style framing.",
      threshold: DEFAULT_THRESHOLD,
    },
  },
  {
    key: "marketing-copy",
    enabled: true,
    sensitivity: "normal",
    definition: {
      kind: "semantic",
      name: "Not marketing copy",
      scope: "sentence",
      question: "Does target read like marketing or advertising copy rather than plain description?",
      flagWhen:
        "Hype and superlatives without support ('revolutionary', 'best-in-class', 'seamless'), benefit claims with no specifics, or sales language that addresses the reader as a prospect.",
      allowWhen:
        "Plain statements of what something does, including positive ones, especially when they are specific or measurable.",
      boundaryCases: "Quoted marketing copy that the writer is discussing should be allowed.",
      examples: [
        { text: "Our revolutionary platform seamlessly empowers teams to unlock their full potential.", flag: true },
        { text: "The new cache cut median page load from 900 ms to 300 ms.", flag: false },
      ],
      patterns: [
        {
          id: "hype",
          label: "Hype",
          description: "Superlatives or buzzwords that assert quality without evidence.",
          explanation: "This sentence may assert quality with hype words rather than evidence.",
        },
        {
          id: "empty-benefit",
          label: "Empty benefit",
          description: "Promises a benefit (empower, unlock, transform) without saying what actually happens.",
          explanation: "This sentence may promise a benefit without saying what happens.",
        },
      ],
      explanation: "This sentence may read like marketing copy.",
      threshold: DEFAULT_THRESHOLD,
    },
  },
  {
    key: "vague-claims",
    enabled: true,
    sensitivity: "normal",
    definition: {
      kind: "semantic",
      name: "Concrete over vague",
      scope: "sentence",
      question: "Does target make a vague or abstract claim that says little, where a concrete statement was possible?",
      flagWhen:
        "The sentence gestures at significance without content: 'This changes everything', 'There are many factors to consider', 'It plays a key role in various ways'.",
      allowWhen:
        "The sentence states something specific, or is a deliberate summary or transition whose specifics appear in the surrounding context.",
      examples: [
        { text: "There are a lot of different factors that play a role in this.", flag: true },
        { text: "Two things drove the delay: the vendor shipped late, and we underestimated testing.", flag: false },
      ],
      explanation: "This sentence may make a claim without saying anything concrete.",
      threshold: DEFAULT_THRESHOLD,
    },
  },
  {
    key: "repeated-explanation",
    enabled: true,
    sensitivity: "normal",
    definition: {
      kind: "semantic",
      name: "Don't explain it twice",
      scope: "section",
      question: "Does target explain the same point more than once in different words, without adding anything the second time?",
      flagWhen: "Two or more paragraphs make the same point, and the later one adds no new information, example, or nuance.",
      allowWhen:
        "Points are related but distinct, a later paragraph adds evidence or detail, or a brief closing summary is clearly signposted.",
      examples: [],
      explanation: "This section may explain the same point more than once.",
      threshold: DEFAULT_THRESHOLD,
    },
  },
  {
    key: "phrases",
    enabled: true,
    sensitivity: "normal",
    definition: {
      kind: "phrases",
      name: "Phrases to avoid",
      phrases: ["synergy", "circle back", "move the needle", "game-changer", "at the end of the day", "low-hanging fruit"],
      explanation: "You asked to avoid this phrase.",
    },
  },
  {
    key: "repeated-word",
    enabled: true,
    sensitivity: "normal",
    definition: { kind: "repeated-word", name: "Repeated word", explanation: "A word appears twice in a row." },
  },
  {
    key: "sentence-length",
    enabled: false,
    sensitivity: "normal",
    definition: {
      kind: "sentence-length",
      name: "Long sentences",
      maxWords: 40,
      explanation: "This sentence is longer than your limit.",
    },
  },
];

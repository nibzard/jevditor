import type { BlockRange, SemanticScope, Target, TextBlock } from "./types.js";

/** Limits that keep each request's state small. */
export const PASSAGE_MAX_BLOCKS = 3;
export const PASSAGE_MAX_CHARS = 1500;
export const SECTION_MAX_CHARS = 8000;
const CONTEXT_MAX_CHARS = 600;

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e",
  "inc", "ltd", "co", "no", "fig", "approx", "dept", "est", "u.s", "u.k", "a.m", "p.m",
]);

/**
 * Split one block of text into sentence ranges. Offsets index into `text`.
 * Leading and trailing whitespace is excluded from each range.
 */
export function splitSentences(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;
  const re = /[.!?…]+["'”’)\]]*(?=\s|$)|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (m[0] !== "\n" && m[0].startsWith(".") && m[0].length === 1) {
      const word = /([\p{L}.]+)$/u.exec(text.slice(start, m.index))?.[1]?.toLowerCase() ?? "";
      if (ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word)) continue;
      // A lowercase continuation ("approx. five") is rarely a new sentence.
      if (/^\s+\p{Ll}/u.test(text.slice(end))) continue;
      // "3.5" never matches because of the (?=\s|$) lookahead.
    }
    push(out, text, start, m[0] === "\n" ? m.index : end);
    start = end;
  }
  push(out, text, start, text.length);
  return out;
}

function push(out: Array<{ start: number; end: number }>, text: string, start: number, end: number) {
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (end > start && /[\p{L}\p{N}]/u.test(text.slice(start, end))) out.push({ start, end });
}

function clip(text: string, fromEnd: boolean): string {
  if (text.length <= CONTEXT_MAX_CHARS) return text;
  return fromEnd ? "…" + text.slice(-CONTEXT_MAX_CHARS) : text.slice(0, CONTEXT_MAX_CHARS) + "…";
}

function contextFor(before: string, after: string): string {
  const parts: string[] = [];
  if (before.trim()) parts.push(`[before] ${clip(before.trim(), true)}`);
  if (after.trim()) parts.push(`[after] ${clip(after.trim(), false)}`);
  return parts.join("\n");
}

/** Sentence targets across all non-heading blocks. */
export function sentenceTargets(blocks: readonly TextBlock[]): Target[] {
  const flat: Array<{ block: number; start: number; end: number; text: string }> = [];
  blocks.forEach((b, block) => {
    if (b.type === "heading") return;
    for (const s of splitSentences(b.text)) flat.push({ block, ...s, text: b.text.slice(s.start, s.end) });
  });
  return flat.map((s, i) => ({
    scope: "sentence",
    ranges: [{ block: s.block, start: s.start, end: s.end }],
    text: s.text,
    context: contextFor(flat[i - 1]?.text ?? "", flat[i + 1]?.text ?? ""),
  }));
}

/** Runs of consecutive non-empty paragraphs, split at headings and other blocks. */
function paragraphRuns(blocks: readonly TextBlock[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  blocks.forEach((b, i) => {
    if (b.type === "paragraph") {
      // An empty paragraph does not break a run; headings and other blocks do.
      if (b.text.trim()) run.push(i);
      return;
    }
    if (run.length) runs.push(run);
    run = [];
  });
  if (run.length) runs.push(run);
  return runs;
}

function fullRange(blocks: readonly TextBlock[], block: number): BlockRange {
  return { block, start: 0, end: blocks[block]!.text.length };
}

/**
 * Passage targets: short multi-paragraph windows. Paragraph breaks are kept as
 * blank lines so patterns spread across several short paragraphs stay visible.
 */
export function passageTargets(blocks: readonly TextBlock[]): Target[] {
  const out: Target[] = [];
  for (const run of paragraphRuns(blocks)) {
    let chunk: number[] = [];
    let size = 0;
    const flush = () => {
      if (!chunk.length) return;
      const first = chunk[0]!;
      const last = chunk[chunk.length - 1]!;
      const before = first > 0 ? blocks[first - 1]!.text : "";
      const after = last + 1 < blocks.length ? blocks[last + 1]!.text : "";
      out.push({
        scope: "passage",
        ranges: chunk.map((b) => fullRange(blocks, b)),
        text: chunk.map((b) => blocks[b]!.text.trim()).join("\n\n"),
        context: contextFor(before, after),
      });
      chunk = [];
      size = 0;
    };
    for (const b of run) {
      const len = blocks[b]!.text.length;
      if (chunk.length && (chunk.length >= PASSAGE_MAX_BLOCKS || size + len > PASSAGE_MAX_CHARS)) flush();
      chunk.push(b);
      size += len;
    }
    flush();
  }
  return out;
}

/** Heading-delimited sections, for document-level rules such as repetition. */
export function sectionTargets(blocks: readonly TextBlock[]): Target[] {
  const out: Target[] = [];
  let heading = "";
  let chunk: number[] = [];
  let size = 0;
  const flush = () => {
    const body = chunk.filter((b) => blocks[b]!.text.trim());
    if (body.length >= 2) {
      out.push({
        scope: "section",
        ranges: body.map((b) => fullRange(blocks, b)),
        text: body.map((b) => blocks[b]!.text.trim()).join("\n\n"),
        context: heading ? `[section heading] ${heading}` : "",
      });
    }
    chunk = [];
    size = 0;
  };
  blocks.forEach((b, i) => {
    if (b.type === "heading") {
      flush();
      heading = b.text.trim();
      return;
    }
    if (size + b.text.length > SECTION_MAX_CHARS) flush();
    chunk.push(i);
    size += b.text.length;
  });
  flush();
  return out;
}

export function targetsForScope(blocks: readonly TextBlock[], scope: SemanticScope): Target[] {
  switch (scope) {
    case "sentence":
      return sentenceTargets(blocks);
    case "passage":
      return passageTargets(blocks);
    case "section":
      return sectionTargets(blocks);
  }
}

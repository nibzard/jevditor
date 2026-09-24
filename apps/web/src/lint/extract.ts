import type { Node as PMNode } from "@tiptap/pm/model";
import type { BlockRange, TextBlock } from "@jewriter/engine";

/**
 * A textblock with an explicit map from text offsets to document positions.
 * Positions are never recovered by searching text: the same sentence can
 * appear more than once.
 */
export interface ExtractedBlock extends TextBlock {
  /** map[i] is the document position of character i; map[text.length] is the end. */
  map: number[];
  /** Range of the block node itself, for node decorations and replacement. */
  nodeFrom: number;
  nodeTo: number;
}

const OBJECT_REPLACEMENT = "￼";

export function extractBlocks(doc: PMNode): ExtractedBlock[] {
  const out: ExtractedBlock[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    const map: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        const t = child.text ?? "";
        for (let i = 0; i < t.length; i++) map.push(start + i);
        text += t;
      } else {
        map.push(start);
        text += child.type.name === "hardBreak" ? "\n" : OBJECT_REPLACEMENT;
      }
    });
    map.push(pos + 1 + node.content.size);
    const type = node.type.name === "heading" ? "heading" : node.type.name === "paragraph" ? "paragraph" : "other";
    out.push({ type, text, map, nodeFrom: pos, nodeTo: pos + node.nodeSize });
    return false;
  });
  return out;
}

/** Document range for a block range. */
export function docRange(blocks: readonly ExtractedBlock[], r: BlockRange): { from: number; to: number } {
  const b = blocks[r.block]!;
  const from = b.map[r.start]!;
  const to = r.end > r.start ? b.map[r.end - 1]! + 1 : from;
  return { from, to };
}

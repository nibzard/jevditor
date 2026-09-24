import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Scope } from "@jewriter/engine";

export interface DisplayFinding {
  id: string;
  ruleId: string;
  ruleVersion: number;
  ruleName: string;
  preset: boolean;
  scope: Scope;
  semantic: boolean;
  message: string;
  /** Text the rule judged (used for "Keep this occurrence"). */
  occurrenceText: string;
  /** Text and context that would be sent for a rewrite. */
  text: string;
  context: string;
  snapshot?: string;
  probability?: number;
  threshold?: number;
  from: number;
  to: number;
  /** For passage and section findings: the block nodes covered. */
  nodes?: Array<{ from: number; to: number }>;
}

interface LintState {
  findings: DisplayFinding[];
  active: string | null;
  decorations: DecorationSet;
}

export const lintKey = new PluginKey<LintState>("jewriterLint");

type Meta = { findings: DisplayFinding[] } | { active: string | null };

function build(state: EditorState, findings: DisplayFinding[], active: string | null): DecorationSet {
  const decos: Decoration[] = [];
  const size = state.doc.content.size;
  for (const f of findings) {
    const isActive = f.id === active;
    if (f.nodes?.length) {
      f.nodes.forEach((n, i) => {
        if (n.to > size) return;
        decos.push(
          Decoration.node(n.from, n.to, {
            class: `jw-block-flag${isActive ? " is-active" : ""}${i === 0 ? " is-first" : ""}${i === f.nodes!.length - 1 ? " is-last" : ""}`,
          }),
        );
      });
      const first = f.nodes[0]!;
      if (first.from + 1 <= size) {
        decos.push(
          Decoration.widget(
            first.from + 1,
            () => {
              const el = document.createElement("button");
              el.type = "button";
              el.className = "jw-margin-marker";
              el.dataset.finding = f.id;
              el.contentEditable = "false";
              el.setAttribute("aria-label", `${f.ruleName}: open finding`);
              el.tabIndex = -1;
              return el;
            },
            { side: -1, key: `m-${f.id}`, ignoreSelection: true, stopEvent: () => false },
          ),
        );
      }
    } else if (f.to > f.from && f.to <= size) {
      decos.push(
        Decoration.inline(f.from, f.to, {
          class: `jw-underline jw-underline--${f.semantic ? "semantic" : "exact"}${isActive ? " is-active" : ""}`,
          "data-finding": f.id,
        }),
      );
    }
  }
  return DecorationSet.create(state.doc, decos);
}

function mapFinding(f: DisplayFinding, tr: Transaction): DisplayFinding | null {
  const from = tr.mapping.map(f.from, 1);
  const to = tr.mapping.map(f.to, -1);
  if (to <= from) return null;
  const nodes = f.nodes?.map((n) => ({ from: tr.mapping.map(n.from, 1), to: tr.mapping.map(n.to, -1) })).filter((n) => n.to > n.from);
  return { ...f, from, to, ...(nodes ? { nodes } : {}) };
}

export interface LintExtensionOptions {
  onActivate: (id: string | null, via: "pointer" | "keyboard") => void;
}

/**
 * Decorations only: findings never become part of the document, copied
 * text, or exported HTML. Between checks, decorations are mapped through
 * each transaction so they stay attached to the text they describe.
 */
export const LintExtension = Extension.create<LintExtensionOptions>({
  name: "jewriterLint",

  addOptions() {
    return { onActivate: () => {} };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<LintState>({
        key: lintKey,
        state: {
          init: () => ({ findings: [], active: null, decorations: DecorationSet.empty }),
          apply(tr, prev, _old, state) {
            const meta = tr.getMeta(lintKey) as Meta | undefined;
            if (meta && "findings" in meta) {
              const active = meta.findings.some((f) => f.id === prev.active) ? prev.active : null;
              return { findings: meta.findings, active, decorations: build(state, meta.findings, active) };
            }
            if (meta && "active" in meta) {
              return { ...prev, active: meta.active, decorations: build(state, prev.findings, meta.active) };
            }
            if (!tr.docChanged) return prev;
            const findings = prev.findings.map((f) => mapFinding(f, tr)).filter((f): f is DisplayFinding => f !== null);
            return { findings, active: prev.active, decorations: prev.decorations.map(tr.mapping, tr.doc) };
          },
        },
        props: {
          decorations: (state) => lintKey.getState(state)?.decorations,
          handleDOMEvents: {
            mousedown(_view, event) {
              const el = (event.target as HTMLElement | null)?.closest?.("[data-finding]") as HTMLElement | null;
              if (!el) return false;
              if (el.classList.contains("jw-margin-marker")) event.preventDefault();
              options.onActivate(el.dataset.finding ?? null, "pointer");
              return false;
            },
          },
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    const step = (dir: 1 | -1) => () => {
      const view = this.editor.view;
      const f = nextFinding(view, dir);
      if (!f) return true;
      this.editor.chain().setTextSelection({ from: f.from, to: f.to }).scrollIntoView().run();
      this.options.onActivate(f.id, "keyboard");
      return true;
    };
    return {
      F8: step(1),
      "Shift-F8": step(-1),
      "Mod-.": () => {
        const view = this.editor.view;
        const pos = view.state.selection.from;
        const f = getFindings(view.state).find((x) => x.from <= pos && pos <= x.to) ?? nextFinding(view, 1);
        if (f) this.options.onActivate(f.id, "keyboard");
        return true;
      },
      Escape: () => {
        if (!lintKey.getState(this.editor.state)?.active) return false;
        this.options.onActivate(null, "keyboard");
        return true;
      },
    };
  },
});

export function getFindings(state: EditorState): DisplayFinding[] {
  return lintKey.getState(state)?.findings ?? [];
}

function nextFinding(view: EditorView, dir: 1 | -1): DisplayFinding | undefined {
  const sorted = [...getFindings(view.state)].sort((a, b) => a.from - b.from || a.to - b.to);
  if (!sorted.length) return undefined;
  const pos = dir === 1 ? view.state.selection.to : view.state.selection.from;
  return dir === 1 ? (sorted.find((f) => f.from >= pos) ?? sorted[0]) : ([...sorted].reverse().find((f) => f.to <= pos) ?? sorted.at(-1));
}

export function setFindings(view: EditorView, findings: DisplayFinding[]) {
  view.dispatch(view.state.tr.setMeta(lintKey, { findings }).setMeta("addToHistory", false));
}

export function setActive(view: EditorView, active: string | null) {
  view.dispatch(view.state.tr.setMeta(lintKey, { active }).setMeta("addToHistory", false));
}

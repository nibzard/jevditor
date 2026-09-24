import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Rule } from "@jevditor/engine";
import { api, type Suppression } from "../api.js";
import { LintController, type CheckStatus } from "../lint/controller.js";
import { getFindings, LintExtension, setActive, setFindings, type DisplayFinding } from "../lint/plugin.js";
import { FindingCard } from "./FindingCard.js";

const STORAGE_KEY = "jevditor:document";

const SAMPLE = `<p>I missed my train this morning.</p><p>It taught me more about leadership than ten years in management.</p><p>Here are five lessons every founder needs to hear.</p><p>Our revolutionary platform seamlessly empowers teams to unlock their full potential, and we should circle back on the the pricing.</p>`;

function loadDoc(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? SAMPLE;
  } catch {
    return SAMPLE;
  }
}

export interface EditorProps {
  rules: Rule[];
  suppressions: Suppression[];
  generation: boolean;
  onRulesStale: () => void;
  onSuppressed: (s: Suppression) => void;
  onRuleUpdated: (r: Rule) => void;
  onTune: (ruleId: string) => void;
}

const GENRES = ["general", "blog post", "email", "essay", "social post", "documentation", "fiction"];

export function Editor(props: EditorProps) {
  const [status, setStatus] = useState<CheckStatus>("idle");
  const [paused, setPaused] = useState(false);
  const [genre, setGenre] = useState("general");
  const [active, setActiveState] = useState<{ id: string; via: "pointer" | "keyboard" } | null>(null);
  const [count, setCount] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const onActivate = useRef<(id: string | null, via: "pointer" | "keyboard") => void>(() => {});

  const editor = useEditor({
    extensions: [StarterKit, LintExtension.configure({ onActivate: (id, via) => onActivate.current(id, via) })],
    content: loadDoc(),
    editorProps: { attributes: { class: "jw-editor", spellcheck: "true", "aria-label": "Document" } },
  });

  const [controller, setController] = useState<LintController | null>(null);

  // Created in an effect (not a memo) so StrictMode's mount/unmount/mount cycle gets a live instance.
  useEffect(() => {
    if (!editor) return;
    const c = new LintController({
      lint: (body, signal) => api.lint(body, signal),
      onFindings: (findings) => {
        // Dispatch outside the current transaction/update cycle.
        queueMicrotask(() => {
          if (!editor.isDestroyed) {
            setFindings(editor.view, findings);
            setCount(findings.length);
          }
        });
      },
      onStatus: setStatus,
      onRulesChanged: () => propsRef.current.onRulesStale(),
      isComposing: () => editor.view.composing,
    });
    setController(c);
    return () => c.dispose();
  }, [editor]);

  useEffect(() => {
    controller?.setRules(props.rules, props.suppressions);
  }, [controller, props.rules, props.suppressions]);

  useEffect(() => controller?.setGenre(genre), [controller, genre]);
  useEffect(() => controller?.setPaused(paused), [controller, paused]);

  useEffect(() => {
    if (!editor || !controller) return;
    controller.update(editor.state.doc);
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      controller.update(editor.state.doc);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try {
          localStorage.setItem(STORAGE_KEY, editor.getHTML());
        } catch {
          /* storage unavailable: the document still works, it just isn't remembered */
        }
      }, 500);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      clearTimeout(saveTimer);
    };
  }, [editor, controller]);

  const close = useCallback(() => {
    setActiveState(null);
    if (editor && !editor.isDestroyed) {
      setActive(editor.view, null);
      editor.commands.focus();
    }
  }, [editor]);

  onActivate.current = (id, via) => {
    if (!editor) return;
    if (!id) return close();
    setActiveState({ id, via });
    setActive(editor.view, id);
  };

  // Close the card when its finding disappears (edited, rechecked, or kept).
  const finding: DisplayFinding | undefined = active && editor ? getFindings(editor.state).find((f) => f.id === active.id) : undefined;
  useEffect(() => {
    if (active && !finding) setActiveState(null);
  }, [active, finding]);

  let cardPos = { top: 0, left: 0 };
  if (finding && editor && wrapRef.current) {
    try {
      const box = wrapRef.current.getBoundingClientRect();
      const end = editor.view.coordsAtPos(Math.min(finding.nodes ? finding.nodes.at(-1)!.to - 1 : finding.to, editor.state.doc.content.size));
      const start = editor.view.coordsAtPos(finding.from);
      cardPos = { top: end.bottom - box.top + 6, left: Math.max(0, Math.min(start.left - box.left, box.width - 340)) };
    } catch {
      /* position out of range during a transaction; the next render fixes it */
    }
  }

  const applyRewrite = (f: DisplayFinding, text: string): "applied" | "stale" => {
    if (!editor) return "stale";
    if (f.snapshot && !controller?.isCurrent(f.snapshot)) return "stale";
    if (f.nodes?.length) {
      const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      editor
        .chain()
        .insertContentAt(
          { from: f.nodes[0]!.from, to: f.nodes.at(-1)!.to },
          paragraphs.map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })),
        )
        .run();
    } else {
      if (editor.state.doc.textBetween(f.from, f.to, "\n") !== f.text) return "stale";
      editor.chain().insertContentAt({ from: f.from, to: f.to }, { type: "text", text: text.replace(/\s*\n+\s*/g, " ") }).run();
    }
    return "applied";
  };

  const statusText = {
    idle: count ? `${count} ${count === 1 ? "note" : "notes"}` : "No notes",
    checking: "Checking…",
    unavailable: "Checking unavailable — will retry",
    paused: "Checking paused",
  }[status];

  return (
    <div className="jw-write">
      <div className="jw-toolbar" role="toolbar" aria-label="Checking">
        <label>
          Genre{" "}
          <select value={genre} onChange={(e) => setGenre(e.target.value)}>
            {GENRES.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => controller?.reviewNow()} disabled={paused} title="Run all checks now, including section-level rules">
          Review
        </button>
        <button type="button" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume checking" : "Pause checking"}
        </button>
        <span className={`jw-status jw-status--${status}`} role="status" aria-live="polite">
          {statusText}
        </span>
        <span className="jw-muted jw-small jw-hint">F8 next note · Shift+F8 previous · Esc close</span>
      </div>
      <div className="jw-editor-wrap" ref={wrapRef}>
        <EditorContent editor={editor} />
        {finding && (
          <FindingCard
            finding={finding}
            top={cardPos.top}
            left={cardPos.left}
            focusOnOpen={active?.via === "keyboard"}
            canRewrite={props.generation}
            onClose={close}
            onKeep={async (f) => {
              const { suppression } = await api.keepOccurrence(f.ruleId, f.occurrenceText);
              props.onSuppressed(suppression);
            }}
            onAllow={async (f) => {
              const { rule } = await api.allowLikeThis(f.ruleId, f.occurrenceText);
              props.onRuleUpdated(rule);
            }}
            onTune={(id) => {
              close();
              props.onTune(id);
            }}
            onApplyRewrite={applyRewrite}
          />
        )}
      </div>
    </div>
  );
}

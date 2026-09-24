import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { DisplayFinding } from "../lint/plugin.js";
import { Diff } from "./Diff.js";

export interface FindingCardProps {
  finding: DisplayFinding;
  top: number;
  left: number;
  focusOnOpen: boolean;
  canRewrite: boolean;
  onClose: () => void;
  onKeep: (f: DisplayFinding) => Promise<void>;
  onAllow: (f: DisplayFinding) => Promise<void>;
  onTune: (ruleId: string) => void;
  onApplyRewrite: (f: DisplayFinding, text: string) => "applied" | "stale";
}

type RewriteState =
  | { kind: "none" }
  | { kind: "asking"; instruction: string }
  | { kind: "loading" }
  | { kind: "ready"; text: string }
  | { kind: "error"; message: string };

const SCOPE_NOUN = { phrase: "phrase", sentence: "sentence", passage: "passage", section: "section" } as const;

export function FindingCard(props: FindingCardProps) {
  const { finding: f } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rewrite, setRewrite] = useState<RewriteState>({ kind: "none" });

  useEffect(() => {
    setMenu(false);
    setRewrite({ kind: "none" });
  }, [f.id]);

  useEffect(() => {
    if (props.focusOnOpen) ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [f.id, props.focusOnOpen]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  const runRewrite = async (instruction: string) => {
    setRewrite({ kind: "loading" });
    try {
      const { rewrite: text } = await api.rewrite({ text: f.text, context: f.context, instruction, ruleIds: [f.ruleId] });
      setRewrite({ kind: "ready", text });
    } catch {
      setRewrite({ kind: "error", message: "Rewriting is unavailable right now." });
    }
  };

  // Exact findings are fixed by editing; section rewrites are too large to review as a diff.
  const canRewrite = props.canRewrite && (f.scope === "sentence" || f.scope === "passage");

  return (
    <div
      ref={ref}
      className="jw-card"
      role="dialog"
      aria-label={`${f.ruleName} finding`}
      style={{ top: props.top, left: props.left }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          props.onClose();
        }
      }}
    >
      <div className="jw-card__head">
        <strong>{f.ruleName}</strong>
        <span className="jw-muted"> · {f.preset ? "Preset rule" : "Your rule"}</span>
      </div>
      <p className="jw-card__msg">{f.message}</p>
      {f.probability !== undefined && (
        <p className="jw-card__meta" title="Model probability that this matches the rule, and the threshold for showing it. Not a severity.">
          Matched this {SCOPE_NOUN[f.scope]} with probability {f.probability.toFixed(2)} (shown at ≥ {f.threshold?.toFixed(2)})
        </p>
      )}

      {rewrite.kind === "asking" && (
        <form
          className="jw-card__rewrite"
          onSubmit={(e) => {
            e.preventDefault();
            void runRewrite(rewrite.instruction);
          }}
        >
          <input
            autoFocus
            placeholder="Optional: how should it change?"
            value={rewrite.instruction}
            onChange={(e) => setRewrite({ kind: "asking", instruction: e.target.value })}
          />
          <button type="submit">Rewrite</button>
        </form>
      )}
      {rewrite.kind === "loading" && <p className="jw-muted">Rewriting…</p>}
      {rewrite.kind === "error" && <p className="jw-error">{rewrite.message}</p>}
      {rewrite.kind === "ready" && (
        <div className="jw-card__rewrite">
          <Diff before={f.text} after={rewrite.text} />
          <p className="jw-muted jw-small">It will be checked against your rules again. That doesn't confirm the meaning was kept — read it first.</p>
          <div className="jw-row">
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (props.onApplyRewrite(f, rewrite.text) === "stale") {
                  setRewrite({ kind: "error", message: "The text changed since this was checked. Nothing was replaced." });
                } else props.onClose();
              }}
            >
              Accept
            </button>
            <button type="button" onClick={() => setRewrite({ kind: "none" })}>
              Discard
            </button>
          </div>
        </div>
      )}

      {rewrite.kind === "none" && !menu && (
        <div className="jw-row">
          {canRewrite && (
            <button type="button" onClick={() => setRewrite({ kind: "asking", instruction: "" })}>
              Rewrite
            </button>
          )}
          <button type="button" onClick={() => setMenu(true)} aria-expanded={menu}>
            Keep this
          </button>
          <button type="button" onClick={() => props.onTune(f.ruleId)}>
            Tune rule
          </button>
        </div>
      )}
      {menu && (
        <div className="jw-menu" role="menu">
          <button type="button" role="menuitem" disabled={busy} onClick={() => act(() => props.onKeep(f))}>
            Keep this occurrence
            <span className="jw-muted jw-small">Stop flagging this exact text.</span>
          </button>
          {f.semantic && (
            <button type="button" role="menuitem" disabled={busy} onClick={() => act(() => props.onAllow(f))}>
              Allow writing like this
              <span className="jw-muted jw-small">Save it as an example the rule should allow.</span>
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => props.onTune(f.ruleId)}>
            Change the rule
            <span className="jw-muted jw-small">Edit what the rule means.</span>
          </button>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { isSemantic, targetsForScope, type Rule, type SemanticRule, type Target, type TextBlock } from "@jewriter/engine";
import { api, type Evaluation, type Label, type Metrics, type PreviewResult } from "../api.js";
import { Probability } from "./RuleEditor.js";

/** Paragraphs split on blank lines; lines starting with "#" are headings. */
export function pastedBlocks(text: string): TextBlock[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/^#{1,6}\s/.test(p) ? { type: "heading" as const, text: p.replace(/^#+\s*/, "") } : { type: "paragraph" as const, text: p }));
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

export function Playground(props: { rules: Rule[]; onRuleUpdated: (r: Rule) => void }) {
  const semantic = props.rules.filter(isSemantic);
  const [ruleId, setRuleId] = useState(semantic[0]?.id ?? "");
  const rule = semantic.find((r) => r.id === ruleId) as SemanticRule | undefined;
  const [text, setText] = useState("");
  const [targets, setTargets] = useState<Target[]>([]);
  const [results, setResults] = useState<PreviewResult | null>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResults(null);
    setEvaluation(null);
    if (!ruleId) return;
    api.labels(ruleId).then((r) => setLabels(r.labels), () => setLabels([]));
  }, [ruleId]);

  if (!rule) return <p className="jw-muted">No semantic rules yet. Create one under Rules.</p>;

  const check = async () => {
    const t = targetsForScope(pastedBlocks(text), rule.definition.scope).slice(0, 40);
    setTargets(t);
    setResults(null);
    if (!t.length) return;
    setBusy("check");
    setError(null);
    try {
      setResults(await api.preview(rule.definition, t.map((x) => ({ text: x.text, context: x.context }))));
    } catch {
      setError("Checking is unavailable right now.");
    } finally {
      setBusy(null);
    }
  };

  const addLabel = async (t: Target, flag: boolean) => {
    const { label } = await api.addLabel(rule.id, { text: t.text, context: t.context, flag });
    setLabels((l) => [...l, label]);
  };

  const evaluate = async () => {
    setBusy("eval");
    setError(null);
    try {
      setEvaluation(await api.evaluate(rule.id));
    } catch {
      setError("Evaluation is unavailable right now.");
    } finally {
      setBusy(null);
    }
  };

  const useThreshold = async (threshold: number) => {
    const { rule: updated } = await api.updateRule(rule.id, { ...rule.definition, threshold });
    props.onRuleUpdated(updated);
    setEvaluation(null);
  };

  const labeled = new Map(labels.map((l) => [l.text, l]));

  return (
    <div className="jw-playground">
      <h2>Rule playground</h2>
      <p className="jw-muted">
        Paste writing, see what a rule would flag, and label where you disagree. Labels form a test set for this rule; about one in five is held out
        so you can check a change against text you didn't tune on.
      </p>
      <div className="jw-row">
        <label>
          Rule{" "}
          <select value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
            {semantic.map((r) => (
              <option key={r.id} value={r.id}>
                {r.definition.name} (v{r.version}, {r.definition.scope})
              </option>
            ))}
          </select>
        </label>
      </div>
      <textarea
        className="jw-paste"
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Paste writing here. Separate paragraphs with a blank line; start a line with # for a heading."}
      />
      <div className="jw-row">
        <button type="button" className="primary" onClick={check} disabled={busy !== null || !text.trim()}>
          {busy === "check" ? "Checking…" : `Check ${rule.definition.scope}s`}
        </button>
        <span className="jw-muted jw-small">{rule.definition.question}</span>
      </div>
      {error && <p className="jw-error" role="alert">{error}</p>}

      {results && (
        <ul className="jw-samples">
          {targets.map((t, i) => {
            const r = results.items[i]!;
            const existing = labeled.get(t.text);
            return (
              <li key={i} className={r.flag ? "is-flag" : ""}>
                <p className="jw-pre">{t.text}</p>
                <div className="jw-row jw-small">
                  <Probability p={r.probability} threshold={results.threshold} />
                  {r.patternId && <span className="jw-muted">· {rule.definition.patterns?.find((p) => p.id === r.patternId)?.label}</span>}
                  <span className="jw-grow" />
                  {existing ? (
                    <span className="jw-muted">Labeled: {existing.flag ? "should flag" : "should allow"}</span>
                  ) : (
                    <>
                      <button type="button" onClick={() => addLabel(t, true)}>Should flag</button>
                      <button type="button" onClick={() => addLabel(t, false)}>Should allow</button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {results && !targets.length && <p className="jw-muted">No {rule.definition.scope}s found in that text.</p>}

      <section className="jw-section">
        <div className="jw-row">
          <h3 className="jw-grow">
            Labeled set <span className="jw-muted jw-small">{labels.filter((l) => !l.heldOut).length} dev · {labels.filter((l) => l.heldOut).length} held out</span>
          </h3>
          <button type="button" onClick={evaluate} disabled={busy !== null || !labels.length}>
            {busy === "eval" ? "Evaluating…" : `Evaluate v${rule.version}`}
          </button>
        </div>
        {evaluation && (
          <div className="jw-eval">
            <p className="jw-small">
              At threshold {evaluation.threshold.toFixed(2)} ({rule.sensitivity} sensitivity), model {evaluation.model}:
            </p>
            <MetricsRow name="Dev" m={evaluation.dev} />
            <MetricsRow name="Held out" m={evaluation.heldOut} />
            <table className="jw-table">
              <thead>
                <tr>
                  <th>Threshold</th>
                  <th>Shown (dev)</th>
                  <th>Helpful among shown (dev)</th>
                  <th>Caught (dev)</th>
                  <th>Helpful among shown (held out)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {evaluation.sweep.map((s) => (
                  <tr key={s.threshold} className={Math.abs(s.threshold - rule.definition.threshold) < 1e-9 ? "is-current" : ""}>
                    <td>{s.threshold.toFixed(2)}</td>
                    <td>{s.dev.shown}/{s.dev.count}</td>
                    <td>{pct(s.dev.precision)}</td>
                    <td>{pct(s.dev.recall)}</td>
                    <td>{pct(s.heldOut.precision)}</td>
                    <td>
                      {Math.abs(s.threshold - rule.definition.threshold) > 1e-9 && (
                        <button type="button" className="link" onClick={() => useThreshold(s.threshold)}>Use</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="jw-muted jw-small">Thresholds are chosen on dev labels. Judge the result on held-out labels.</p>
          </div>
        )}
        <ul className="jw-examples">
          {labels.map((l) => (
            <li key={l.id}>
              <span className={`jw-tag ${l.flag ? "is-flag" : "is-allow"}`}>{l.flag ? "Flag" : "Allow"}</span>
              <span className="jw-grow jw-small">{l.text}</span>
              {l.heldOut && <span className="jw-muted jw-small">held out</span>}
              <button
                type="button"
                className="link"
                aria-label="Delete label"
                onClick={async () => {
                  await api.deleteLabel(rule.id, l.id);
                  setLabels((x) => x.filter((y) => y.id !== l.id));
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function MetricsRow({ name, m }: { name: string; m: Metrics }) {
  return (
    <p className="jw-small">
      <strong>{name}:</strong> {m.shown} shown of {m.count} · helpful among shown {pct(m.precision)} · caught {pct(m.recall)} of should-flag · {m.fp} unwanted
    </p>
  );
}

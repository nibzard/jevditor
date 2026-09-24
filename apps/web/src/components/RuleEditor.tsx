import { useState } from "react";
import { DEFAULT_THRESHOLD, type Rule, type RuleDefinition, type RulePattern, type SemanticRuleDefinition } from "@jevditor/engine";
import { api, ApiError, type PreviewResult } from "../api.js";

const BLANK: SemanticRuleDefinition = {
  kind: "semantic",
  name: "",
  scope: "sentence",
  question: "",
  flagWhen: "",
  allowWhen: "",
  examples: [],
  patterns: [],
  explanation: "",
  threshold: DEFAULT_THRESHOLD,
};

interface Sample {
  text: string;
  suggested?: "flag" | "allow";
  result?: PreviewResult["items"][number];
}

export function RuleEditor(props: {
  rule?: Rule;
  generation: boolean;
  onSaved: (r: Rule) => void;
  onCancel: () => void;
}) {
  const [def, setDef] = useState<RuleDefinition>(props.rule?.definition ?? BLANK);
  const [request, setRequest] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [newSample, setNewSample] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const draft = async () => {
    setDrafting(true);
    setError(null);
    try {
      const d = await api.draft(request);
      setDef({ ...d.definition, examples: def.kind === "semantic" ? def.examples : [] });
      setSamples(d.candidates.map((c) => ({ text: c.text, suggested: c.suggested })));
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 503
          ? "Drafting needs a generative model (set ANTHROPIC_API_KEY on the server). You can fill in the fields yourself."
          : "Couldn't draft a rule. Try rephrasing, or fill in the fields yourself.",
      );
      if (def.kind === "semantic" && !def.name) setDef({ ...BLANK, name: request.slice(0, 80) });
    } finally {
      setDrafting(false);
    }
  };

  const preview = async () => {
    if (def.kind !== "semantic" || !samples.length) return;
    setPreviewing(true);
    setError(null);
    try {
      const r = await api.preview(def, samples.map((s) => ({ text: s.text })));
      setThreshold(r.threshold);
      setSamples((prev) => prev.map((s, i) => ({ ...s, result: r.items[i] })));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 400 ? "Fill in the name, question, criteria, and card text first." : "Preview is unavailable right now.");
    } finally {
      setPreviewing(false);
    }
  };

  const label = (i: number, flag: boolean) => {
    if (def.kind !== "semantic") return;
    const text = samples[i]!.text;
    setDef({ ...def, examples: [...def.examples.filter((e) => e.text !== text), { text, flag }] });
    setSamples((prev) => prev.filter((_, j) => j !== i));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const clean: RuleDefinition = def.kind === "phrases" ? { ...def, phrases: def.phrases.map((p) => p.trim()).filter(Boolean) } : def;
    try {
      const { rule } = props.rule ? await api.updateRule(props.rule.id, clean) : await api.createRule(clean);
      props.onSaved(rule);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 400 ? "Some fields are missing or too long." : "Couldn't save the rule.");
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof SemanticRuleDefinition>(k: K, v: SemanticRuleDefinition[K]) =>
    def.kind === "semantic" && setDef({ ...def, [k]: v });

  return (
    <div className="jw-rule-editor">
      <h2>{props.rule ? `Edit “${props.rule.definition.name}”` : "New rule"}</h2>
      {props.rule && <p className="jw-muted jw-small">Saving creates version {props.rule.version + 1}. Results from older versions are discarded.</p>}

      {!props.rule && (
        <section className="jw-section">
          <label className="jw-field">
            <span>Describe what you want flagged</span>
            <textarea rows={2} value={request} placeholder="Flag anything that sounds like a LinkedIn post." onChange={(e) => setRequest(e.target.value)} />
          </label>
          <button type="button" onClick={draft} disabled={drafting || request.trim().length < 3 || !props.generation} title={props.generation ? "" : "Drafting is not configured on the server"}>
            {drafting ? "Drafting…" : "Draft a rule"}
          </button>
          {!props.generation && <span className="jw-muted jw-small"> Drafting is off on this server; fill in the fields below.</span>}
        </section>
      )}

      {def.kind === "semantic" ? (
        <section className="jw-section jw-grid">
          <Field label="Name" value={def.name} onChange={(v) => set("name", v)} />
          <label className="jw-field">
            <span>Scope</span>
            <select value={def.scope} onChange={(e) => set("scope", e.target.value as SemanticRuleDefinition["scope"])}>
              <option value="sentence">Sentence — underline the sentence</option>
              <option value="passage">Passage — mark a few paragraphs</option>
              <option value="section">Section — review after a longer pause</option>
            </select>
          </label>
          <Field label="Question" hint="A yes/no question about the target text." value={def.question} onChange={(v) => set("question", v)} multiline />
          <Field label="Flag when" value={def.flagWhen} onChange={(v) => set("flagWhen", v)} multiline />
          <Field label="Allow when" value={def.allowWhen} onChange={(v) => set("allowWhen", v)} multiline />
          <Field label="Boundary cases" hint="Quotes, parody, and other edge cases." value={def.boundaryCases ?? ""} onChange={(v) => set("boundaryCases", v || undefined)} multiline />
          <Field label="Card text" hint="Shown when no specific pattern fits. Keep it hedged: “This sentence may…”" value={def.explanation} onChange={(v) => set("explanation", v)} />
          <label className="jw-field">
            <span>Show at probability ≥</span>
            <input type="number" min={0.5} max={0.99} step={0.01} value={def.threshold} onChange={(e) => set("threshold", Number(e.target.value))} />
            <span className="jw-muted jw-small">A starting guess. Tune it in the playground against labeled examples.</span>
          </label>
          <Patterns patterns={def.patterns ?? []} onChange={(p) => set("patterns", p)} />
          <Examples def={def} onChange={(examples) => set("examples", examples)} />
        </section>
      ) : (
        <ExactFields def={def} onChange={setDef} />
      )}

      {def.kind === "semantic" && (
        <section className="jw-section">
          <h3>Try it</h3>
          <p className="jw-muted jw-small">Mark what should be flagged or allowed. Marked samples become examples in the rule.</p>
          <form
            className="jw-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (newSample.trim()) setSamples((s) => [...s, { text: newSample.trim() }]);
              setNewSample("");
            }}
          >
            <input className="jw-grow" value={newSample} placeholder="Add a sample text…" onChange={(e) => setNewSample(e.target.value)} />
            <button type="submit">Add</button>
            <button type="button" onClick={preview} disabled={previewing || !samples.length}>
              {previewing ? "Checking…" : "Check samples"}
            </button>
          </form>
          <ul className="jw-samples">
            {samples.map((s, i) => (
              <li key={i + s.text}>
                <p>{s.text}</p>
                <div className="jw-row jw-small">
                  {s.result && threshold !== null ? (
                    <Probability p={s.result.probability} threshold={threshold} />
                  ) : s.suggested ? (
                    <span className="jw-muted">Suggested: {s.suggested}</span>
                  ) : null}
                  <span className="jw-grow" />
                  <button type="button" onClick={() => label(i, true)}>Should flag</button>
                  <button type="button" onClick={() => label(i, false)}>Should allow</button>
                  <button type="button" className="link" onClick={() => setSamples((p) => p.filter((_, j) => j !== i))} aria-label="Remove sample">
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className="jw-error" role="alert">{error}</p>}
      <div className="jw-row">
        <button type="button" className="primary" onClick={save} disabled={saving || !def.name}>
          {saving ? "Saving…" : "Save rule"}
        </button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function Probability({ p, threshold }: { p: number; threshold: number }) {
  return (
    <span className={`jw-prob ${p >= threshold ? "is-flag" : ""}`} title={`Probability ${p.toFixed(3)}; shown at ≥ ${threshold.toFixed(2)}`}>
      <span className="jw-prob__bar"><span style={{ width: `${p * 100}%` }} /><i style={{ left: `${threshold * 100}%` }} /></span>
      {p.toFixed(2)} · {p >= threshold ? "would flag" : "would allow"}
    </span>
  );
}

function Field(props: { label: string; hint?: string; value: string; onChange: (v: string) => void; multiline?: boolean }) {
  return (
    <label className="jw-field">
      <span>{props.label}</span>
      {props.multiline ? (
        <textarea rows={2} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      ) : (
        <input value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      )}
      {props.hint && <span className="jw-muted jw-small">{props.hint}</span>}
    </label>
  );
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "pattern";
}

function Patterns({ patterns, onChange }: { patterns: RulePattern[]; onChange: (p: RulePattern[]) => void }) {
  const update = (i: number, patch: Partial<RulePattern>) =>
    onChange(patterns.map((p, j) => (j === i ? { ...p, ...patch, ...(patch.label ? { id: uniqueId(patterns, slug(patch.label), i) } : {}) } : p)));
  return (
    <fieldset className="jw-field jw-fieldset">
      <legend>Patterns <span className="jw-muted jw-small">— optional; picks a more specific card text</span></legend>
      {patterns.map((p, i) => (
        <div key={i} className="jw-pattern">
          <input placeholder="Label" value={p.label} onChange={(e) => update(i, { label: e.target.value })} />
          <input placeholder="What it looks like (for the classifier)" value={p.description} onChange={(e) => update(i, { description: e.target.value })} />
          <input placeholder="Card text (for you)" value={p.explanation} onChange={(e) => update(i, { explanation: e.target.value })} />
          <button type="button" className="link" onClick={() => onChange(patterns.filter((_, j) => j !== i))} aria-label="Remove pattern">✕</button>
        </div>
      ))}
      {patterns.length < 8 && (
        <button type="button" onClick={() => onChange([...patterns, { id: uniqueId(patterns, "pattern", -1), label: "", description: "", explanation: "" }])}>
          Add pattern
        </button>
      )}
    </fieldset>
  );
}

function uniqueId(patterns: RulePattern[], base: string, self: number) {
  const b = base === "none" ? "none-pattern" : base;
  let id = b;
  for (let n = 2; patterns.some((p, j) => j !== self && p.id === id); n++) id = `${b}-${n}`;
  return id;
}

function Examples({ def, onChange }: { def: SemanticRuleDefinition; onChange: (e: SemanticRuleDefinition["examples"]) => void }) {
  return (
    <fieldset className="jw-field jw-fieldset">
      <legend>Examples <span className="jw-muted jw-small">— sent with the question; approved by you</span></legend>
      {!def.examples.length && <p className="jw-muted jw-small">None yet. Label samples below to add some.</p>}
      <ul className="jw-examples">
        {def.examples.map((e, i) => (
          <li key={i}>
            <button type="button" className={`jw-tag ${e.flag ? "is-flag" : "is-allow"}`} onClick={() => onChange(def.examples.map((x, j) => (j === i ? { ...x, flag: !x.flag } : x)))} title="Toggle">
              {e.flag ? "Flag" : "Allow"}
            </button>
            <span className="jw-grow">{e.text}</span>
            <button type="button" className="link" onClick={() => onChange(def.examples.filter((_, j) => j !== i))} aria-label="Remove example">✕</button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function ExactFields({ def, onChange }: { def: Exclude<RuleDefinition, SemanticRuleDefinition>; onChange: (d: RuleDefinition) => void }) {
  return (
    <section className="jw-section jw-grid">
      <Field label="Name" value={def.name} onChange={(name) => onChange({ ...def, name })} />
      {def.kind === "phrases" && (
        <Field
          label="Phrases (one per line)"
          value={def.phrases.join("\n")}
          onChange={(v) => onChange({ ...def, phrases: v.split("\n") })}
          multiline
        />
      )}
      {def.kind === "sentence-length" && (
        <label className="jw-field">
          <span>Maximum words per sentence</span>
          <input type="number" min={5} max={200} value={def.maxWords} onChange={(e) => onChange({ ...def, maxWords: Number(e.target.value) })} />
        </label>
      )}
      <p className="jw-muted jw-small">This rule is checked exactly, in code, as you type. It never goes to a model.</p>
    </section>
  );
}

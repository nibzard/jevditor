import type { Rule, Sensitivity } from "@jewriter/engine";
import { api, type Suppression } from "../api.js";

const SCOPE_LABEL: Record<string, string> = { sentence: "Sentence", passage: "Passage", section: "Section" };

export function RulesPanel(props: {
  rules: Rule[];
  suppressions: Suppression[];
  onChanged: () => void;
  onEdit: (rule: Rule | null) => void;
}) {
  const settings = async (r: Rule, s: { enabled?: boolean; sensitivity?: Sensitivity }) => {
    await api.updateSettings(r.id, s);
    props.onChanged();
  };
  const names = new Map(props.rules.map((r) => [r.id, r.definition.name]));

  return (
    <div className="jw-rules">
      <div className="jw-row">
        <h2 className="jw-grow">My writing rules</h2>
        <button type="button" className="primary" onClick={() => props.onEdit(null)}>New rule</button>
      </div>
      <ul className="jw-rule-list">
        {props.rules.map((r) => (
          <li key={r.id} className={r.enabled ? "" : "is-off"}>
            <label className="jw-switch">
              <input type="checkbox" checked={r.enabled} onChange={(e) => settings(r, { enabled: e.target.checked })} />
              <span className="jw-sr">Enabled</span>
            </label>
            <div className="jw-grow">
              <strong>{r.definition.name}</strong>
              <div className="jw-muted jw-small">
                {r.definition.kind === "semantic" ? `${SCOPE_LABEL[r.definition.scope]} · judged by model` : "Exact · checked in code"}
                {" · "}v{r.version}
                {r.preset ? " · preset" : ""}
              </div>
            </div>
            {r.definition.kind === "semantic" && (
              <label className="jw-small">
                <span className="jw-sr">Sensitivity</span>
                <select value={r.sensitivity} onChange={(e) => settings(r, { sensitivity: e.target.value as Sensitivity })} title="How readily this rule interrupts">
                  <option value="gentle">Gentle</option>
                  <option value="normal">Normal</option>
                  <option value="strict">Strict</option>
                </select>
              </label>
            )}
            <button type="button" onClick={() => props.onEdit(r)}>Edit</button>
            <button
              type="button"
              className="link"
              onClick={async () => {
                if (!confirm(`Delete “${r.definition.name}”?`)) return;
                await api.deleteRule(r.id);
                props.onChanged();
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      {props.suppressions.length > 0 && (
        <>
          <h3>Kept occurrences</h3>
          <p className="jw-muted jw-small">Text you chose to keep. These aren't flagged again by that rule.</p>
          <ul className="jw-rule-list">
            {props.suppressions.map((s) => (
              <li key={s.id}>
                <div className="jw-grow">
                  <span className="jw-small">{s.excerpt.split("\u0000")[0]}</span>
                  <div className="jw-muted jw-small">{names.get(s.ruleId) ?? "Deleted rule"}</div>
                </div>
                <button
                  type="button"
                  className="link"
                  onClick={async () => {
                    await api.deleteSuppression(s.id);
                    props.onChanged();
                  }}
                >
                  Flag again
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

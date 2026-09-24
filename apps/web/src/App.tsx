import { useCallback, useEffect, useState } from "react";
import type { Rule } from "@jevditor/engine";
import { api, type Suppression } from "./api.js";
import { Editor } from "./components/Editor.js";
import { Playground } from "./components/Playground.js";
import { RuleEditor } from "./components/RuleEditor.js";
import { RulesPanel } from "./components/RulesPanel.js";

type Tab = "write" | "rules" | "playground";

export function App() {
  const [tab, setTab] = useState<Tab>("write");
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [status, setStatus] = useState<{ classifier: "jev" | "demo"; model: string; generation: boolean } | null>(null);
  const [editing, setEditing] = useState<Rule | null | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await api.rules();
      setRules(r.rules);
      setSuppressions(r.suppressions);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    api.status().then(setStatus, () => setStatus(null));
  }, [reload]);

  const updateRule = (rule: Rule) => setRules((rs) => rs?.map((r) => (r.id === rule.id ? rule : r)) ?? null);

  const tune = (ruleId: string) => {
    setEditing(rules?.find((r) => r.id === ruleId) ?? undefined);
    setTab("rules");
  };

  return (
    <div className="jw-app">
      <header className="jw-header">
        <span className="jw-logo">Jevditor</span>
        <nav className="jw-tabs" aria-label="Sections">
          {(["write", "rules", "playground"] as const).map((t) => (
            <button key={t} type="button" aria-current={tab === t ? "page" : undefined} onClick={() => setTab(t)}>
              {t === "write" ? "Write" : t === "rules" ? "Rules" : "Playground"}
            </button>
          ))}
        </nav>
        {status?.classifier === "demo" && (
          <span className="jw-badge" title="No TypeSafe key is configured. Findings come from a word-overlap stand-in, not Jev.">
            Demo classifier
          </span>
        )}
      </header>
      <main className="jw-main">
        {loadError && (
          <p className="jw-error" role="alert">
            Can't reach the server. <button type="button" className="link" onClick={reload}>Retry</button>
          </p>
        )}
        {rules && (
          <>
            <div hidden={tab !== "write"}>
              <Editor
                rules={rules}
                suppressions={suppressions}
                generation={status?.generation ?? false}
                onRulesStale={reload}
                onSuppressed={(s) => setSuppressions((x) => [s, ...x.filter((y) => y.id !== s.id)])}
                onRuleUpdated={updateRule}
                onTune={tune}
              />
            </div>
            {tab === "rules" &&
              (editing !== undefined ? (
                <RuleEditor
                  key={editing?.id ?? "new"}
                  rule={editing ?? undefined}
                  generation={status?.generation ?? false}
                  onSaved={() => {
                    setEditing(undefined);
                    void reload();
                  }}
                  onCancel={() => setEditing(undefined)}
                />
              ) : (
                <RulesPanel rules={rules} suppressions={suppressions} onChanged={reload} onEdit={setEditing} />
              ))}
            {tab === "playground" && <Playground rules={rules} onRuleUpdated={updateRule} />}
          </>
        )}
      </main>
    </div>
  );
}

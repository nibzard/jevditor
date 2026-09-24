type Part = { kind: "same" | "add" | "del"; text: string };

/** Word-level diff (LCS). Inputs are short passages, so O(n·m) is fine. */
export function diffWords(a: string, b: string): Part[] {
  const x = a.match(/\s+|[^\s]+/g) ?? [];
  const y = b.match(/\s+|[^\s]+/g) ?? [];
  if (x.length * y.length > 400_000) return [{ kind: "del", text: a }, { kind: "add", text: b }];
  const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Part[] = [];
  const push = (kind: Part["kind"], text: string) => {
    const last = out.at(-1);
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) (push("same", x[i]!), i++, j++);
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push("del", x[i++]!);
    else push("add", y[j++]!);
  }
  while (i < x.length) push("del", x[i++]!);
  while (j < y.length) push("add", y[j++]!);
  return out;
}

export function Diff({ before, after }: { before: string; after: string }) {
  return (
    <p className="jw-diff">
      {diffWords(before, after).map((p, i) =>
        p.kind === "same" ? <span key={i}>{p.text}</span> : p.kind === "add" ? <ins key={i}>{p.text}</ins> : <del key={i}>{p.text}</del>,
      )}
    </p>
  );
}

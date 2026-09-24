# Jevditor

A programmable writing linter: a personal style guide that runs while you write.

> Tell it what you dislike in writing. It quietly catches those patterns in yours.

This isn't a chatbot sitting beside the document, and it doesn't keep rewriting your voice. The work is split three ways:

- **Jev detects.** Each saved rule becomes a yes/no question (Noul). Jev answers it for known sentences, passages, and sections. When a rule is flagged, a speculative Choice question picks a predefined explanation.
- **Ordinary code decides what to show.** It segments the text, runs exact checks, applies thresholds and sensitivity, rejects stale results, and handles suppressions.
- **A generative model rewrites, only on request.** Claude drafts rule definitions and rewrites a selected passage when you ask. It never runs while you type.

## Layout

```
packages/engine   Editor-independent core: segmentation with exact offsets, exact checks,
                  snapshot identities, thresholds, preset rules. No model calls, no DOM.
apps/server       Hono API: auth, rule versioning (SQLite), lint endpoint, Jev classifier,
                  cache, rate limits, playground evaluation, Claude drafting/rewrites.
apps/web          React + Tiptap editor with a ProseMirror decoration plugin, a check
                  scheduler, finding cards, the rules editor, and the rule playground.
```

## Running it

Requires Node 22.13+ (for `node:sqlite`) and pnpm.

```sh
pnpm install
pnpm dev            # server on :8787, web on :5173 (proxies /api)
pnpm test           # engine, server, and web unit tests
pnpm typecheck
```

Without `TYPESAFE_API_KEY`, development uses a **demo classifier**: word overlap with the rule's own examples. It isn't Jev, its probabilities mean very little, and the UI shows a "Demo classifier" badge whenever it's in use. It can't be enabled in production. Set `TYPESAFE_API_KEY` to use Jev, and `ANTHROPIC_API_KEY` to turn on rule drafting and rewrites. All settings are listed in `.env.example`.

## How a check works

```
Editor transaction
  ├─ exact rules (phrases, repeated words, sentence length) → immediately, in code
  └─ extract blocks with an explicit text-offset → doc-position map
       → sentence / passage / section targets, each with a snapshot id
       → pause (500 ms; 4 s for section rules; "Review" runs everything now)
       → POST /api/lint: only targets whose snapshot has no result yet
            server: verify rule versions (409 if stale) and snapshots
                    one Jev request per target with every applicable rule
                    cache probabilities by user+text+context+genre+rule versions+model
                    apply threshold × sensitivity, suppressions
       → store results by snapshot; render only those matching a *current* target
```

- **Staleness.** A snapshot covers the target text, its neighbouring context, genre, language, and the exact rule versions. If you edit a neighbouring sentence, the snapshot changes and the old result is never shown. Obsolete requests are aborted, but that's only an optimization. The snapshot match is what keeps results correct.
- **Positions.** Extraction records the document position of every character. Highlights are never found again with `indexOf`, because the same sentence can appear twice.
- **Decorations only.** Findings never enter the document, copied text, or exported HTML. Between checks they're mapped through each transaction.
- **Failures aren't "no issues".** Provider errors come back per target as `checking_unavailable`. The toolbar says checking is unavailable, and those targets are retried after 10 s.
- **Question ids are opaque to Jev.** Questions are named `r0`, `p0`, and so on. The rule, its criteria, its approved examples, and the instruction to treat document text as data are all written out in the question itself.

## Rules

A semantic rule has a name, scope, question, *flag when*, *allow when*, boundary cases, examples you've approved, optional patterns (for more specific card text), card text, and a threshold. Changing the definition creates a new **version**. Old results and cache entries no longer match, and the server rejects lint requests made with old versions. **Enabled** and **sensitivity** only affect display, so changing them doesn't create a version and reuses cached probabilities. Sensitivity shifts the threshold: gentle +0.07, strict −0.15, clamped to [0.5, 0.99].

Presets (starting hypotheses, not validated settings): *Avoid LinkedIn voice* (passage), *Not marketing copy* and *Concrete over vague* (sentence), *Don't explain it twice* (section), plus exact rules *Phrases to avoid*, *Repeated word*, and *Long sentences* (off by default).

Creating a rule: describe it in plain language, then **Draft a rule** (Claude proposes a definition and some boundary samples). Mark samples *Should flag* / *Should allow*, **Check samples** against the unsaved definition, and adjust before saving. Without a generation key you fill in the fields yourself.

## Feedback is explicit

On a finding card, **Keep this** offers three choices with different meanings:

| Choice | Effect |
| --- | --- |
| Keep this occurrence | Suppresses that rule on that exact text. It can be undone under Rules → Kept occurrences. |
| Allow writing like this | Saves the text as an approved *allow* example, which creates a new rule version. |
| Change the rule | Opens the rule editor. |

Dismissing a card is never treated as a training label.

**Rewrite** sends the target, its context, and the rule to Claude, then shows a word diff you have to accept. If the text changed after it was checked, nothing is replaced. The rewrite is checked against your rules again like any other edit, but that doesn't confirm the meaning was kept.

## Playground and evaluation

Pick a rule and paste some writing to see per-target probabilities. Label each target *Should flag* or *Should allow*. About one label in five is held out (chosen deterministically by text). **Evaluate** runs the current version over the labeled set and reports, for dev and held-out labels separately:

- helpful findings among those shown (precision)
- should-flag items that were caught (recall)
- unwanted findings

It also includes a threshold sweep with a **Use** button. Pick thresholds on dev labels and judge them on held-out ones.

## Security and privacy

- Provider keys stay on the server. Every request needs a bearer token, and every rule, suppression, and label is checked against its owner.
- Inputs are validated with zod and size-limited (256 KB body, 24 targets per request). Each user is rate-limited, and a global gate keeps traffic under the Jev request limit.
- Document bodies are never logged or stored. The SDK runs at `warn` level because its `debug` level logs request bodies. Only text you explicitly keep, allow, or label is saved, and only for you.
- Caches include the user id and are never shared between users.
- TypeSafe says it doesn't train on customer data, and offers zero data retention to enterprise customers. Those are two different statements, so check your actual retention terms before promising users anything.

## Status and known gaps

- **Not tested against live APIs.** The Jev path is exercised through the real `@typesafe-ai/sdk` with a stubbed `fetch`, and the Claude path is typechecked but hasn't been called. Measure pause-to-highlight latency from your users' regions before promising sub-second checks.
- **Thresholds are untuned.** Collect a few hundred labeled passages per rule, including boundary cases (real announcements, genuine enthusiasm, quotes, parody, patterns spread across several paragraphs), and compare against at least one baseline classifier.
- **Deferred:** phrase-level localization inside semantic findings, section rewrites, multi-document storage, Postgres (the SQLite schema ports directly), and integrations beyond this editor. The engine is already editor-independent.
- Throughput will likely become a limit before cost does: 100 active writers checking every 2 s is about 3,000 requests per minute. Coalescing, per-target caching, and batching all rules into one request are built in, but more capacity will need to be negotiated.

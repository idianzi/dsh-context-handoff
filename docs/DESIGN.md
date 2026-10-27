# Design notes

This document records why the plugin is shaped the way it is. User-facing behavior lives in [README.zh.md](../README.zh.md).

## Goals and non-goals

**Goals**

1. Produce a self-contained Markdown handoff that a fresh session can read with `@path`.
2. Make the continue-versus-switch decision from measured token data, not a fixed character count.
3. Keep the cost of writing the handoff visible and bounded.
4. Degrade gracefully: no model, provider error, or quota failure must still leave a usable artifact when possible.
5. Be a normal DSH bundle: one command, one config schema, no client build step, no network beyond the configured provider.

**Non-goals**

- Replacing compaction. `/compact` keeps a session alive; this plugin moves to a new one.
- Exact billing. There is no cross-provider price table in DSH.
- A separate chat transcript or a full settings app. The sidebar panel is a compact control surface, not a second conversation UI.
- Background summarization of every turn. Auto mode is opt-in, per workspace, and completes once per source session.

## Package shape

The package is plain ESM JavaScript with JSDoc, no build step. DSH's bundle patch mounts one plugin entry:

```yaml
- id: context-handoff
  name: dsh-context-handoff
  config: { ... }
```

`lib/index.js` exports a Cordis class with `static inject`, `static Config`, and `static name` (as a named export). The constructor registers `/handoff` inside `ctx.effect` and installs the idle listener only when `auto` is true.

Dependencies are peer dependencies resolved by the DSH installation's runtime resolver. The package has no runtime `dependencies`, so `npm install` does not pull a second copy of DSH packages.

## Measurement

`inspect()` is the only place that reads session state:

- `session.deriveMessages()` — model-visible messages, used both for pricing and for the summary request.
- `ctx.tokenMeter.measure(session)` — `totalTokens` (prompt pressure) and `surfaceTokens`.
- `ctx.tokenMeter.estimateMessage(message)` — per-message and per-file pricing under the same heuristic the host uses.
- `ctx.llm.resolveModelInfo(provider, model)` — optional context window. Failure is non-fatal.
- `sessionProjections.stateOf(session, 'tokenUsage')` — optional cumulative spend for `/handoff stats`.

The fixed prefix is derived as:

```text
tools     = max(0, totalTokens - surfaceTokens)
system    = sum(price(system messages))
S         = min(totalTokens, tools + system)
messages  = totalTokens - S
```

This is deliberately derived from the same numbers the host uses, rather than assuming a system-prompt size.

## Recommendation point

The economic break-even is necessary but not sufficient. A handoff at 17k in a 128k window is cheaper on paper, yet it throws away context the user may still need. The policy adds a quality floor:

```text
usableLimit = window - reserve
qualityAt   = min(window × recommendAtRatio, recommendMaxTokens, usableLimit)
recommendedAt = min(max(economicAt, qualityAt), usableLimit)
```

Defaults: `recommendAtRatio = 0.55`, `recommendMaxTokens = 256000`, `reserve = 8192`. This produces:

| Window | Recommendation point |
|---|---|
| 32k | 17.6k |
| 64k | 35.2k |
| 128k | 70.4k |
| 200k | 110k |
| 1M | 256k |

The absolute cap exists because an agent session at 400k+ tokens is already carrying a lot of stale tool output even when the model advertises a million-token window. 256k is a policy default, not a measured degradation point; set `recommendMaxTokens: 0` to disable it. `usableLimit` prevents a recommendation that would leave no room for the output. When the model window is unknown, the recommendation falls back to `economicAt` rather than `Infinity`.

## Digest budget

`D` is chosen as:

```text
D = clamp(P × digestRatio, minDigestTokens, targetDigestTokens, maxDigestTokens, window × 8%, (P - S) × 60%)
```

The last clamp is the important one: a digest that is not smaller than the message budget can never save tokens. The plugin still reports a no-benefit plan instead of pretending otherwise.

The file budget includes frontmatter and the resume card. `enforceFileBudget()` trims the body's middle first, keeping the opening summary and the trailing next-steps section. It iterates up to five times, then converges the final frontmatter, because updating `digest_tokens` in the frontmatter changes the file's own price by a few tokens. The result is `digest_tokens <= budget` in normal cases; a manually requested budget below the frontmatter size can exceed it.

## Summary request: replay or transcript

The preferred path replays `session.deriveMessages()` and appends the handoff instruction as a final user message, mirroring compaction-basic's cache-reusing call. The provider's warm prefix cache then covers most of the input, which is what makes a handoff at 100k+ tokens affordable.

Safety rules:

- If the route exposes a window and the replay does not fit (`window - maxOutput - 5% margin`), switch to a plain-text transcript.
- Without a known window, replay only up to 48k estimated input tokens.
- Before replaying, non-text blocks are projected to text placeholders. Images are not re-sent; files become `[file: name]`; reasoning blocks are dropped. Messages left empty are dropped.
- A transcript is budgeted by `transcriptBudgetRatio × window`, keeps the first user request and the newest messages, and inserts an explicit "N earlier messages omitted" marker.

Replay passes `tools` and `toolHistory()` so tool calls in history remain valid. Transcript mode sends one user message and no tool schema, so tool pairing cannot be violated.

## Failure behavior

| Failure | Behavior |
|---|---|
| No provider/model resolved | Deterministic fallback if `fallbackDigest`, otherwise a clear error. |
| `resolveModelInfo` fails | Window is unknown; the request still streams. |
| Stream error, rate limit, quota | Fallback digest, `generator: fallback`, reason recorded in frontmatter and command output. |
| Empty model text | Treated as a failure; fallback applies. |
| Abort/cancel | No file; command reports "Handoff cancelled." |
| Agent busy | `agent.runMaintenance()` rejects before the job starts; the command reports "not idle" instead of interleaving. |
| Write failure | Error propagates; no ledger record is written (the ledger append happens after the file). |
| Ledger failure | Ignored; the handoff file is still valid. |
| Prune failure | Ignored per file; the new handoff is still valid. |

The fallback is intentionally conservative: mission, recent conversation, tools used, next step, statistics. It never invents work or claims a model call happened.

## Secrets

`redactSecrets()` applies a small set of high-signal patterns: private-key blocks, `sk-…`, GitHub tokens, AWS access keys, Slack tokens, and `key = value` assignments for common credential names. It runs on the final body only.

Why not redact before the model call? The provider already receives the conversation during normal turns; redacting the handoff input would distort the summary. The file is the durable artifact, so that is where the boundary matters. This is best-effort, not a security boundary.

## Auto mode and the sidebar switch

Auto mode is owned by the workspace, not by the plugin's YAML. The sidebar panel writes:

```text
<workspace>/.dsh/handoff/auto.json  { "auto": true, "updatedAt": "..." }
```

`AutoStateStore` caches by mtime, so polling does not re-read a stable file. A missing file uses `config.auto`. `/handoff auto on|off` writes the same file, which makes the switch reachable from the command surface and from headless setups.

`agent/status` → `idle` schedules a 300 ms timer (unref'd). `maybeAuto()` refuses to run when:

- the workspace switch is off;
- the session is a subagent (`origin === 'subagent'` or `parentSession` present);
- another handoff is active for the session;
- the plan is not useful;
- `promptTokens < recommendedAt`;
- this source session already completed an automatic handoff;
- growth/cooldown constraints fail after a previous *failed* attempt;
- any handoff file in the directory is newer than the cooldown.

The generation runs through `agent.runMaintenance()`, so it cannot interleave with a live turn. After the file is written, `startNewSession()` creates a new root agent in the same workspace with `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions })` and queues the resume prompt through `agent.followup()`. The source session's model route is copied (provider, model, reasoning effort, max tokens). The new session starts with a normal first turn, so the user lands on a working session rather than an empty one.

The `lastAuto` guard is set before generation; a failure does not retry on every idle event. A completed handoff blocks further automatic handoffs for that source session.

## Sidebar bridge

The client bundle is plain CJS wrapped in `window.__ModuleLoader__.load`, with React as the only external. It registers a right-sidebar tab and a `sidebar.right.pane.tab` body. The panel polls `/context-handoff/api/state?session=...` and posts to:

- `/context-handoff/api/auto` — per-workspace switch;
- `/context-handoff/api/run` — manual file or file-plus-session;
- `/context-handoff/api/ack` — clear a consumed auto-session notice.

The host registers these as exact `webServer` routes only when the Web host provides `webServer`; headless profiles simply have no HTTP surface. Mutations require `x-context-handoff: 1` (forcing a cross-site preflight), a same-origin `Origin` when present, and a JSON body. The custom header is the practical CSRF boundary; the host does not accept a cross-site form post.

The panel computes the current session from `ctx.sessions.list` retention (`retainedBy.mainView`), so it addresses the session actually on screen. When a new session ID arrives from auto mode, the panel calls `ctx.uiWorkspace.openSession(id)` only if the source session is current; otherwise it offers an explicit **Open new session** button. `ack` prevents the same notice from reopening after a refresh.

## Session creation

`startNewSession()` deliberately uses a root agent, not a child/subagent, so the new session appears in the sidebar and has its own context. It does not fork the source log: the handoff file is the transfer medium, and the new session starts clean. If creation or `followup()` fails, the handoff file is already written and remains the deliverable; the panel and command output report the session error.

## Economics module

`lib/economics.js` is pure and unit-tested. It returns a frozen plan with:

- `perTurnCurrent`, `perTurnNext`, `savingPerTurn`;
- `oneTimeCost`, `breakEvenTurns`;
- `economicAt`, `comfortAt`, `recommendedAt`, `tokensToRecommended`;
- `projectedSavings`, `useful`, `verdict`.

`verdict` is one of `switch-now`, `efficient-wait`, `continue`, `no-benefit`. The command and the ledger both use the same plan, so the text and the recorded numbers cannot disagree.

Cache modeling is explicit:

```text
a = (1 - hitRate) + hitRate × cacheReadWeight
```

Both the current prompt and the new session's prefix are scaled by `a`. The summary's output is not cached; the switch overhead is a fixed token charge. Users who do not trust the assumptions can set `cacheHitRatio: 0` and `cacheReadWeight: 1`, which reduces to the uncached model.

## Files and ledger

- Atomic write: temp file in the output directory, then `rename`.
- `keepFiles` prunes only files whose frontmatter contains `dsh_handoff: 1`; unrelated Markdown is never touched.
- Frontmatter is flat YAML with JSON-quoted strings, parsed by a small reader that tolerates the first 4 KiB.
- `ledger.jsonl` is append-only, one JSON object per line, torn lines ignored on read. It stores token counts, model, file, session id, and trigger — no conversation text.

## Test matrix

`node --test` covers:

- economics: cache-adjusted saving, break-even, early/quality/no-benefit verdicts, budget selection, formatting;
- digest: redaction, transcript rendering, budgeted fitting, language detection, title extraction, fence/preamble sanitization, middle truncation, fallback structure, frontmatter/resume, file-budget enforcement;
- files: atomic write, frontmatter parsing, ordering, pruning (and not pruning unrelated files), ledger append/read;
- plugin: command registration, plan/now/status/list/stats/auto, replay request shape, explicit budget, model-failure fallback, redaction, busy-agent reporting, auto-mode threshold/growth, subagent exclusion, new-session creation, sidebar HTTP bridge, ack;
- client bundle: execution under a mocked module loader, tab/pane registration, sidebar key, guide metadata;
- auto state: default, explicit on/off, per-workspace persistence;
- summarize: replay versus transcript selection, language-specific instructions, missing route, terminal error finish.

## Known limits

- The sidebar panel polls every 5 seconds; it is not a push subscription. A state change can take one poll to appear.
- Auto-switching only happens when the source session is the one on screen. Otherwise the new session is created and the panel offers a button.
- The panel has no embedded file viewer; it shows the path and relies on `@` references in the new session.
- The handoff has no interactive editing step; edit the Markdown directly if needed.
- A digest can still lose nuance. Critical constraints should be added by hand.
- `/handoff` is unavailable where `dsh-commands` is absent; auto mode remains.
- The ledger keeps the last 500 records for `/handoff stats`; the file itself is append-only.
- Model info lookup is best-effort and cached; without a window the recommendation falls back to the economic point.
- The absolute 256k quality cap is a policy default, not a measurement of model degradation.
- `priceMessage` uses the host's heuristic; it is not a provider tokenizer.

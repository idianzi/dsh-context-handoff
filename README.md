# dsh-context-handoff

> Token-aware context handoff for DeepSeek Harness (dsh): summarize a long session into a self-contained Markdown file, decide with measured token economics whether to continue or start fresh, and resume in a new session.

[中文](README.zh.md) · [Publishing](docs/PUBLISHING.md) · [Design](docs/DESIGN.md) · [GitHub](https://github.com/idianzi/dsh-context-handoff)

- **`/handoff`** writes a handoff document that a fresh session can read directly.
- **`/handoff plan`** compares continuing with switching using `ctx.tokenMeter`; it makes no model call.
- **Sidebar switch** in the right sidebar panel turns auto mode on/off per workspace.
- **Auto mode** writes the handoff, creates a fresh session, and queues the resume prompt when an idle session crosses the threshold.
- **Deterministic fallback** still produces a conservative digest when the model is unavailable or fails.
- **Secret redaction** removes common API keys, tokens, and private keys before writing.
- **Local ledger** records each generation so `/handoff stats` can report cumulative summary cost and projected savings.

## Why not just compact?

dsh's `/compact` replaces older history with a summary **inside the same session**. It answers: "the context is nearly full, but I want to keep working here."

This plugin answers a different question: **when is it worth leaving the session with a high-quality handoff?** Compaction keeps paying for its summary every turn; a handoff file is read once by a new session and the old 100k-token history is no longer re-sent. Writing too early wastes the summary cost and discards useful detail; writing too late has already paid for many oversized turns. The plugin computes where the break-even point is.

## Install

From the DSH plugin market once listed, or:

```sh
dsh plugin --profile web add dsh-context-handoff
```

Desktop users should install from **Plugins**; the CLI form works after the Desktop profile is initialized and the app is fully quit:

```sh
dsh plugin --profile desktop add dsh-context-handoff
```

Local development:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-context-handoff
```

Verify with `/handoff help`. The command requires the `dsh-commands` UI adapter; auto mode works without it.

## Usage

| Command | Effect |
|---|---|
| `/handoff` | Write a handoff and report the comparison. |
| `/handoff plan [turns]` | Analyze only; no model call, no file. `turns` is the horizon (default `horizonTurns`). |
| `/handoff now [tokens]` | Write now with an explicit digest budget (minimum 600). |
| `/handoff status` | Current pressure plus the latest file. |
| `/handoff list` | Newest files in the output directory. |
| `/handoff stats` | Aggregate the local JSONL ledger. |
| `/handoff auto [on\|off]` | Show or set the per-workspace auto switch. |
| `/handoff help` | Help. |

### Sidebar panel

Next to the session title there is a small chip — **上下文 545k**, or **自动总结 545k** while auto mode is on. Clicking it expands the right sidebar and opens the handoff panel, so you do not have to know where the sidebar is. You can also open it from the right sidebar's add menu: **上下文交接 / Context Handoff**.

- The switch controls auto mode for the current workspace. It is stored in `.dsh/handoff/auto.json` and survives restarts.
- The panel shows current context, the recommendation point, a progress bar, and buttons for file-only or file-plus-new-session.
- When auto mode fires, the host writes the file, creates a new root session in the same workspace, and queues `Read @...` as its first message. The panel switches to it when the source session is the one on screen; otherwise it offers an **Open new session** button.
- `autoNewSession: true` by default; set it to `false` to write files only.

Auto mode is per workspace and performs at most one automatic handoff per source session.

Example plan:

```text
Context: 118k / 128k (92%), 10.0k headroom
Composition: 11.0k fixed prefix + 107k messages
Digest: 3.0k tokens (budget 3.0k)
Per-turn saving: 57.2k tokens (cache factor 0.55) · break-even 1.2 turns
Over 8 turns: saves 388k tokens after paying for the summary

Recommended now: a handoff repays itself in 1.2 turns, and the context is already at 92% of the window.
Recommendation point: 70.4k tokens (55% of window)
Earliest efficient point: 17.2k tokens over 8 turns
Cache assumption: 50% hit, cache-read weight 0.1
```

The file goes to `.dsh/handoff/` by default and starts with YAML frontmatter, a copy-paste resume line, and then the summary. The resume workflow is:

1. `/handoff plan 10` to check the economics.
2. `/handoff` when you are ready to leave.
3. Open a fresh session and paste `Read @.dsh/handoff/<file>.md and continue from the "Next steps" section.`
4. Continue from that section; keep the old session as evidence if useful.

The output directory also contains `ledger.jsonl` (token numbers, model, file name, session id; no conversation text). Set `ledger: false` to disable it.

## Token model

Measured inputs:

- `P` current prompt pressure (`tokenMeter.measure(session).totalTokens`).
- `S` fixed prefix every session pays (system prompt + tool schemas).
- `D` the handoff file's own token count (`tokenMeter.estimateMessage`).
- `H` comparison horizon in turns (default 8).
- `a` cache factor: `(1 - hitRate) + hitRate × cacheReadWeight`.

```text
Continue H turns:      H × P × a
Handoff + H new turns: P × a + D + switchOverhead + H × (S + D) × a

Break-even turns R* = (P × a + D + overhead) / ((P - S - D) × a)
Earliest efficient P* = (H × (S + D) × a + D + overhead) / (a × (H - 1))
qualityAt = min(window × recommendAtRatio, recommendMaxTokens, window - reserve)
recommendedAt = min(max(P*, qualityAt), window - reserve)
```

The quality threshold matters: at 18k tokens in a 128k window, switching may already be cheaper, but it throws away context you still need. Defaults are 55%, a 256k absolute cap, and an 8k reserve:

| Window | Recommendation point |
|---|---|
| 32k | 17.6k |
| 64k | 35.2k |
| 128k | 70.4k |
| 200k | 110k |
| 1M | 256k (absolute cap) |

Worked example: `P=118k`, `S=11k`, `D=3k`, `H=8`, 50% cache hit, weight 0.1 → `a=0.55`; continuing ≈ 519k effective tokens, switching ≈ 131k, saving ≈ 388k, break-even ≈ 1.2 turns. The recommendation point is 70.4k.

These are relative token costs, not a bill: dsh has no cross-provider price table. Cache assumptions are configurable, and the meter's fixed heuristic is an approximation (especially for CJK and JSON schema). Treat the result as a decision aid, not billing data.

## Configuration

```yaml
- id: context-handoff
  config:
    outputDir: .dsh/handoff
    targetDigestTokens: 3000
    recommendAtRatio: 0.55
    recommendMaxTokens: 256000
    horizonTurns: 8
    auto: false
    autoNewSession: true
```

A bundle install already inserts the row; use `- id: context-handoff` to override it. For a hand-composed profile without the bundle patch, insert it explicitly:

```yaml
- insert:
    - id: context-handoff
      name: dsh-context-handoff
```

| Field | Default | Meaning |
|---|---|---|
| `outputDir` | `.dsh/handoff` | Output directory, relative to the workspace or absolute. |
| `targetDigestTokens` | `3000` | Digest token budget. |
| `minDigestTokens` | `700` | Lower bound for small contexts. |
| `maxDigestTokens` | `8000` | Absolute cap. |
| `digestRatio` | `0.03` | Budget as a share of current context, then clamped. |
| `recommendAtRatio` | `0.55` | Quality threshold as a window fraction. |
| `recommendMaxTokens` | `256000` | Absolute cap for the recommendation point; `0` disables it. |
| `horizonTurns` | `8` | Cost-comparison horizon; at least 2. |
| `cacheHitRatio` | `0.5` | Assumed cache hit share. |
| `cacheReadWeight` | `0.1` | Relative cache-read cost. |
| `switchOverheadTokens` | `1500` | Re-orientation cost of a new session. |
| `keepFiles` | `20` | Files kept per directory; `0` disables pruning. |
| `auto` | `false` | Default for workspaces without an `auto.json` override. |
| `autoNewSession` | `true` | Auto mode creates a new session and queues the resume prompt. |
| `autoMinGrowthTokens` | `8000` | Minimum growth between auto handoffs. |
| `autoCooldownMinutes` | `10` | Cooldown between auto handoffs. |
| `provider` / `model` | empty | Summarization route; empty follows the routed request or agent options. Set both or neither. |
| `maxOutputTokens` | `0` | Summary output cap; `0` derives it from the budget. |
| `language` | `auto` | `auto`, `en`, or `zh`. |
| `includeToolDetails` | `true` | Include tool names/short arguments in the fallback. |
| `transcriptBudgetRatio` | `0.7` | Window share for the plain-text fallback transcript. |
| `redactSecrets` | `true` | Redact common credentials before writing. |
| `fallbackDigest` | `true` | Write a deterministic digest if the model fails. |
| `ledger` | `true` | Append `ledger.jsonl`. |

Auto mode writes only when the workspace switch is on, the agent is idle, the session is not a subagent, the plan is useful, the recommendation point is crossed, this source session has not already completed an automatic handoff, and no recent handoff exists. It runs through `agent.runMaintenance()`, never interrupts a live turn, then creates a new root session in the same workspace with the resume prompt queued. The file remains valid if session creation fails.

## Privacy

Handoff files contain conversation text, paths, commands, and errors. They are written into your workspace; add `.dsh/handoff/` to `.gitignore`. Redaction is best-effort, not a security boundary. The summary call sends the conversation prefix to the configured model provider, exactly like normal chat. Auto mode makes background model calls and files; confirm the cost is acceptable before enabling it.

## Compatibility

Verified against **DSH Desktop 0.2.1-rc.3** (`dsh --version`): bundle composition, config-schema import, plugin load, `/handoff` command registration, presence of the client bundle in the Web boot graph, and retrieval of the bundle from `/plugins` in a disposable Web profile. Sidebar tab/pane registration is covered by the client bundle test; command execution, model calls, auto-state, new-session creation, and ledger behavior are covered by `npm test` with stubbed services. Real summary quality and visual rendering still depend on your dsh build and model. The plugin targets 0.2.x APIs; re-run both checks after a host upgrade.

## Development

```sh
npm test
npm run check
npm run pack:check
```

Modules: `config`, `economics`, `digest`, `summarize`, `files`, `format`, `index`. See [docs/DESIGN.md](docs/DESIGN.md) for the replay-versus-transcript decision, tool-pairing safety, and known limits.

## Publishing

See [docs/PUBLISHING.md](docs/PUBLISHING.md): add repository metadata, `npm publish`, then open a PR against [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin). The market picks the entry up automatically.

## License

MIT

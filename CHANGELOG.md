# Changelog

All notable changes to `dsh-context-handoff` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.2] — 2026-10-27

### Fixed

- **The compaction service is mounted per agent, not on the host plane.** DSH assembles each session from a preset, and the preset's isolated group owns `compaction` (`isolate: { compaction: true }`); a host-plane plugin can never see it through `ctx` or injection. The plugin now reads `agent.ctx.compaction`, per call and without caching, because two sessions may run under different presets with different backends. `compaction.source` reports `agent` when that path is used.
- The panel payload now carries a `probe` (`agentCompaction`, `rootCompaction`) so a composition that genuinely lacks a backend is distinguishable from a lookup bug.

## [0.3.1] — 2026-10-27

### Fixed

- **Automatic condensation never ran in the Desktop app.** The plugin only looked for the compaction service through `ctx.inject`, which never resolved in that composition, so `compaction.available` stayed `false` and every session fell back to a handoff. The service is now also resolved lazily through `ctx.get('compaction')` and `ctx.compaction` at every use, with the discovery path reported as `source` in the panel payload.
- A second `maybeAuto` pass while a condensation was in flight could call `compactNow` on a busy agent. An in-flight per-session guard now ignores the duplicate, and a busy failure backs off for a minute instead of retrying immediately.

### Added

- Regression tests for context-based service discovery and for the concurrent-condense guard.

## [0.3.0] — 2026-10-27

### Added

- **Automatic condensation at the recommendation point.** When a session crosses its recommendation threshold, the plugin calls the composition's compaction service (`ctx.compaction.compactNow`) before doing anything else. There is no switch for this step.
- `maxCompactionsPerSession` (default `3`): a session is condensed at most this many times, each condense is logged with its before/after token counts, and a condense that frees less than 10% of the context ends the session's budget immediately instead of looping.
- **The handoff is now the fallback, not the first step.** A handoff file and a new session are only produced when the context is still at or above the recommendation point after condensing. The workspace switch now gates this step only: off means condense but never switch sessions.
- The panel reports how many automatic condensations a session has used and the tokens it moved (`before → after`).
- Four tests covering condense-then-recover, condense-then-fallback, condense with the switch off, and the per-session budget.

### Changed

- The panel's subtitle and footer now describe the two-stage behavior.

## [0.2.5] — 2026-10-27

### Added

- A session-header chip (`上下文 545k`, or `自动总结 545k` while auto mode is on) registered at `conversation.session.header.actions`. It shows the current context size, turns amber past the recommendation point, and opens the handoff panel on click — so the switch is reachable without knowing that the right sidebar exists.

### Fixed

- The panel now takes its session from the slot framework's session-scoped `sessionId` prop first and only falls back to DOM lookup, so a panel that mounts before the sidebar writes its marker can no longer show "先打开一个会话" or the wrong session.

## [0.2.4] — 2026-10-27

### Fixed

- The sidebar panel resolves its session from its own right-sidebar DOM owner (`closest('[data-sidebar-right-session]')`) before falling back to a visible owner or main-view retention. A tab that mounted before retention, or a background session kept mounted, can no longer steal the switch or poll a stale session.
- Added a brief retry poll while the session marker is not written yet.
- Added a loading state, a visible text toggle (`开启自动总结` / `关闭自动总结`), an unavailable-state label, and a retry button, so the panel no longer reports "已关闭" before it has read the host state or when the request fails.
- Warn when the current context is already past the recommendation point, so enabling auto mode is not a surprise.

## [0.2.1] — 2026-10-27

### Fixed

- The sidebar panel resolves its session from the right-sidebar DOM marker first, then from `sessions.list` retention. A tab that mounted before the main-view retention was set no longer shows "先打开一个会话" forever.
- Added a visible text toggle (`开启自动总结` / `关闭自动总结`) beside the small switch, and a loading state so the panel no longer says "已关闭" before the first state response.
- State errors now show the error and a retry button instead of leaving the switch disabled with no explanation.
- Added a brief poll when the session marker has not been written yet, instead of waiting for an unrelated session-list event.

## [0.2.0] — 2026-10-27

### Added

- Right-sidebar **Context Handoff** panel: per-workspace auto switch, current pressure, recommendation point, progress bar, file-only and file-plus-new-session actions.
- Automatic new-session flow: when auto mode fires, the host writes the file, creates a new root session in the same workspace, and queues the `Read @...` resume prompt. The panel switches to it when the source session is on screen.
- `/handoff auto [on|off]` as a command-level equivalent of the sidebar switch.
- Per-workspace switch persistence in `.dsh/handoff/auto.json`.
- HTTP bridge for the panel with same-origin/custom-header mutation checks.
- `recommendMaxTokens` (default 256k) as an absolute cap so large windows do not wait indefinitely; `0` disables it.
- `autoNewSession` (default true) to disable automatic session creation while keeping file generation.
- Client test that loads the browser bundle and verifies tab/pane registration; host tests for the panel bridge, auto state, new-session creation, and threshold caps.

### Changed

- **Recommendation point is earlier and bounded**: default `recommendAtRatio` is now `0.55`, capped by `recommendMaxTokens` and the window reserve. For a 128k window the default point is **70.4k tokens**; 32k → 17.6k; 200k → 110k; 1M → 256k.
- Fixed prefix `S` now prefers the host's `contextBreakdown` projection when available, instead of deriving it only from provider usage totals.
- Model-window lookup is cached per provider/model, so sidebar polling does not repeat metadata resolution.
- Auto mode is evaluated per workspace and completed once per source session.

### Fixed

- Unknown model windows now fall back to the economic break-even point instead of `Infinity`.
- The panel and line output keep the source session, new session, and digest numbers consistent.

## [0.1.0] — 2026-10-27

### Added

- `/handoff` command: LLM-written, self-contained Markdown handoff with a copy-paste resume line.
- `/handoff plan [turns]`: cache-adjusted token comparison, break-even turns, economic threshold, and quality-aware recommendation.
- `/handoff now [tokens]` with an explicit digest budget.
- `/handoff status`, `/handoff list`, and `/handoff stats`.
- Optional idle-time auto mode through `agent.runMaintenance()`, with growth and cooldown guards.
- Deterministic fallback digest when no model is available or summarization fails.
- Budget enforcement that preserves the opening summary and the trailing next-steps section.
- Prefix-replay summary requests (warm provider cache) with a budgeted plain-text transcript fallback.
- Best-effort secret redaction for common API keys, tokens, and private keys.
- Atomic writes, retention pruning that never touches unrelated Markdown, and an append-only JSONL ledger.
- `dsh.bundle` manifest, config schema, and market catalog entry.
- 31 `node:test` tests covering economics, digest construction, file handling, and plugin integration.

### Verified

- DSH Desktop 0.2.1-rc.3: bundle composition, config-schema import, plugin load, and `/handoff` command registration in a disposable Web profile. Command execution, model calls, fallback, and ledger behavior are covered by the test suite with stubbed services.

[Unreleased]: https://github.com/idianzi/dsh-context-handoff/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/idianzi/dsh-context-handoff/releases/tag/v0.2.4
[0.2.1]: https://github.com/idianzi/dsh-context-handoff/releases/tag/v0.2.1
[0.2.0]: https://github.com/idianzi/dsh-context-handoff/releases/tag/v0.2.0
[0.1.0]: https://github.com/idianzi/dsh-context-handoff/releases/tag/v0.1.0

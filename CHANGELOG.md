# Changelog

All notable changes to `dsh-context-handoff` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/idianzi/dsh-context-handoff/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/idianzi/dsh-context-handoff/releases/tag/v0.2.0
[0.1.0]: https://github.com/idianzi/dsh-context-handoff/releases/tag/v0.1.0

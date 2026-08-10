---
type: Added
pr: 0
---
**`validate agents` now reports Codex `.toml` model posture, not just presence** — on a `codex` install it flags any agent whose `.toml` pins a GSD tier alias or a `claude-*` id (which Codex rejects with a 400, so the agent never spawns) or carries a `model_reasoning_effort` with no `model`. Previously the check confirmed only that agent files existed, so a stale install from before the passive-model posture reported healthy right up until a typed agent failed to start. Read-only — it names the offending agent and value and never edits your files. Reports `not_codex` and reads nothing on other runtimes. (#3242)

---
type: Fixed
pr: 0
---
**Codex worktree executors now run on the model you pinned for them.** With `model_overrides.gsd-executor` set, `$gsd-execute-phase` spawned its worktree executor with no `--model` argument at all, so the child silently fell back to the global Codex session model — and because this path spawns a process rather than dispatching a named agent, the model baked into `gsd-executor.toml` could not apply either. An explicitly pinned model is now passed to the spawned process. An unpinned, blank, or `inherit` configuration still emits no model argument and keeps the session-model fallback, so Codex's session-only model posture is unchanged and no tier-derived model is ever sent. A pin that is Anthropic-flavored (`sonnet`, `opus`, `claude-*`), flag-shaped (e.g. `-c`), or otherwise outside the model-id character set is now dropped with a stderr warning instead of being sent to Codex — which would 400 — or aborting the whole run. (#3714)

---
type: Fixed
pr: 2713
---
**Subagent spawns no longer fail on non-Claude runtimes when no model resolves** — 15 workflows told the orchestrator to pass a model parameter without saying to drop it when nothing resolved, so 43 dispatch sites sent an empty model and the spawn 404'd. That was the default state on Codex, OpenCode, Gemini CLI, Kilo, Qwen and Hermes, where GSD sets `resolve_model_ids: "omit"` on install. Every dispatching workflow now carries the rule. (#2711)

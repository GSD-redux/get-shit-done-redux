---
type: Changed
pr: 3276
---
**Codex agents now inherit the session model instead of getting a pinned per-tier model** — if you install for `codex` with a `runtime` set and any `model_profile` other than `inherit`, GSD no longer writes a `model` (or `model_reasoning_effort`) line into `~/.codex/agents/<agent>.toml`. This fixes typed agents failing to spawn with `400 invalid_request_error: "The 'sonnet' model is not supported when using Codex with a ChatGPT account"`, which degraded the whole plan/execute flow to a generic-agent fallback. **To keep pinning a model, set an explicit real-Codex id in `model_overrides`** (e.g. `{"model_overrides": {"gsd-planner": "gpt-5.6-sol"}}`) — that path is unchanged. The installer prints a one-time notice when it drops a pin. Codex-only; all other runtimes are untouched. (#3241)

---
type: Added
pr: 3541
---
**Effort now supports `inherit` — "follow the session" is a first-class, declarable choice** — `effort.agent_overrides`, `routing_tier_defaults`, and `effort.default` accept `inherit`; the install-time writer omits the `effort:` frontmatter key for agents resolving to it (Codex omits the `model_reasoning_effort` pin), and `effort sync --apply` no longer re-adds a hand-stripped key — an absent key under `inherit` is in-sync, and a present one is stripped. An explicit `inherit` never escalates on failed attempts. (#3533)

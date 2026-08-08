---
type: Changed
pr: 0
---
**Milestone names are no longer truncated at a parenthesis, and a phase heading is never mistaken for the milestone** — a ROADMAP whose `### Phase N` heading mentioned a version could cause a wrong `milestone:` to be written to `STATE.md`, and a milestone named `v3.3 — Portability (Windows)` was recorded and rendered as `Portability`. Milestone identity now has one implementation; when it cannot be determined it is reported as absent instead of defaulting to a plausible-looking `v1.0`/`milestone`. (#3216)

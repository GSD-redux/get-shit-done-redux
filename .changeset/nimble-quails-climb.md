---
type: Fixed
pr: 4301
---
**`phase.complete` no longer skips to the positionally-last phase on mixed-grammar roadmaps** — completing a phase now advances to the lowest outstanding phase even when the roadmap's rows use the dash form (`- [ ] **Phase N — Name**`); previously only colon-form rows were visible to next-phase selection, so a later phase.add-ingested phase could win and jump `current_phase` seventeen phases ahead. (#4078)

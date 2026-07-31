---
type: Fixed
pr: 2821
---
**`phase complete` and `state begin-phase` no longer rewrite `current_phase_name` to the name's own parenthetical** — transitions that already hold the exact display name now pass it to `syncStateFrontmatter` as an authoritative override, so the lossy body-prose re-derivation never runs the final word on a field the transition just resolved. Previously, completing into a phase named `Closer-ruling measurement (D1a)` wrote `current_phase_name: D1a` (the prose parser's paren-over-dash preference harvested the name's own parenthetical), and every downstream consumer of the scalar inherited the mangled name. `parsePhaseFromProse` also gains status-keyword-aware precedence (the #1695 AC #3 residual) for genuinely unknown prose: the em-dash name wins when it is not a status keyword or `Milestone:` tail, so `48 — Closer-ruling measurement (D1a)` now parses to `Closer-ruling measurement` instead of `D1a`. (#2736)

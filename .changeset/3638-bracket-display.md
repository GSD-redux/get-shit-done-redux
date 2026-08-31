---
type: Added
pr: 4111
---
**Opted-in bracket phase IDs now render consistently on progress surfaces** — `progress`, `stats`, manager init, and both statusline formats display canonical `[CODE.MM] NN` identities only when `phase_id_convention` is exactly `"bracket"`; other conventions retain their existing patterns and output shape. `config-set` now validates the convention's three supported values. (#3638)

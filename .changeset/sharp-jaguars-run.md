---
type: Fixed
pr: 4229
---
**`claude plugin validate --strict` now runs in CI and covers `agents/`** — a dedicated test.yml job provisions the claude CLI so the C2 tier is a real gate, and the validation fixture includes the agents/ tree the CLI validates by convention. (#3751)

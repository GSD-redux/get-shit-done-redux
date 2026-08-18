---
type: Added
pr: 3571
---
**`check:contract-drift` — a machine-enforced agent-contract registry** — sentinel markers, read-tag gates, and deleted-file test references can no longer drift silently: the Agent Registry table in `gsd-core/references/agent-contracts.md` is now linted against what agents emit and what workflows consume, and `lint-removed-but-needed` catches tests that pin files your PR deleted. (#3565)

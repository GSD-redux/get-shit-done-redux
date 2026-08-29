---
type: Added
pr: 0
---
**CI shard/job timeouts now self-report near-cap and accumulate a trending history.** Every matrixed CI job (test, test-full, mutate, smoke) warns in its own run once it crosses 90% of its timeout-minutes budget, and a new scheduled workflow keeps a durable, accumulating record of elapsed-vs-cap across runs — so a lane drifting toward its cap is visible before it actually breaches, not just after. (#4036)

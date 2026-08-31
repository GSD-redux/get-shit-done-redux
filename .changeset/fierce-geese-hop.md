---
type: Fixed
pr: 4072
---
**CI shard 1 no longer runs at 92-99% of its timeout cap.** The full-scope unit-test shard balancer now reserves shard 1's fixed aux-suite cost (integration/security/install/slow) before packing unit-test files onto it, instead of leaving shard 1 to carry that cost on top of an equal unit-test share. (#4070)

---
type: Fixed
pr: 3823
---
**A merged acknowledgment fragment no longer hard-blocks a later PR that grows the same workflow.** The `guard-no-ack-on-next` job only ever watched the legacy `tests/emitted-drift-ack.json`, on the premise that per-PR fragments cannot conflict. They do not share a file, but they do share a path key space — so a fully-spent fragment on `next` kept owning paths it could no longer gate, and the next PR to touch one of them could declare it neither there nor in its own fragment. The guard now sweeps fully-spent fragments, the duplicate-ack error names both resolutions, and the 45 spent fragments on `next` are removed. (#3078)

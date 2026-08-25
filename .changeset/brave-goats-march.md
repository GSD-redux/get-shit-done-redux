---
type: Changed
pr: 0
---
**Stage the emitted-drift-ack sweep around open PRs** — sweeping an all-spent fragment used to delete it unconditionally, handing any open PR that still touched the same file a modify/delete conflict it did not cause (#3330, #3774, #3648). The guard now holds a fragment back when an open PR still touches it, deferring the sweep until that PR merges or closes. (#3842)

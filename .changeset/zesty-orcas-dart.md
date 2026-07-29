---
type: Changed
pr: 2780
---
**The emitted-attribution size ratchet now tells you how to clear it** — a PR that only grew a workflow or agent file used to fail with a byte delta and the word "acknowledgment", without naming `tests/emitted-drift-ack.json`, saying it does not exist yet, giving its schema, or stating that the key is the bare filename. All three failing branches now print a minimal valid document and repeat that nothing is regenerated. (#2778)

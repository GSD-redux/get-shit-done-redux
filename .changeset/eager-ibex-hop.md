---
type: Changed
pr: 3848
---
**The launcher now proves which `gsd-tools` it resolved before running any verb** — a project-local or config-directory install that cannot answer `runtime-identity` with an `@opengsd/gsd-core` payload now produces one actionable warning naming both causes (a foreign package, or a gsd-core older than the verb) and exports `GSD_IDENTITY_STATUS=unverified`, instead of silently handing a state-mutating verb to a tool written for a different contract. (#3841)

---
type: Changed
pr: 0
---
**Capabilities can now do work before UAT, not only block it** — the `verify:pre` extension point dispatched gate hooks only, so a capability declaring a step or contribution there was rejected at registry-build time and the whole verify lane was closed to anything that wanted to contribute to what UAT covers. It now dispatches contribution, step, and gate hooks, and `extract_tests` additively consumes the artefacts those steps declare via `produces`. (#3866)

---
type: Added
pr: 0
---
**installRuntimeArtifacts() now returns the plan it executed** — per kind, per scope, including on the combined OpenCode/Kilo family path that previously returned nothing — so an install's correctness is a value a caller can assert, not something only re-readable from disk afterward. Install IO routes through a new injectable fs seam (`install-fs-adapter.cts`), letting a full install run end-to-end against a fake adapter with no real destination filesystem contact; failures still throw rather than becoming a value, and a best-effort cleanup that fails is now visible in the return instead of silently swallowed. Writes on disk are unchanged. Completes ADR-58's never-landed `cleanup` rollout step. (#2874)

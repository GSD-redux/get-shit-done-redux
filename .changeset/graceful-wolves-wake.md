---
type: Removed
pr: 3422
---
**Removed the orphaned `verify-phase` workflow (~40 KB shipped to every runtime, never loaded)** — its still-live verification gates (decision-coverage validation, test-quality audit, infrastructure-phase human-verification scoping) moved to a reference the verifier agent actually loads, so they run again instead of shipping as dead prose; installs are ~40 KB lighter and PRs to the verifier no longer mirror a dead twin to keep lockstep tests green. (#1891)

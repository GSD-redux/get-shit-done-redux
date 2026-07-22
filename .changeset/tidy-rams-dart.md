---
type: Fixed
pr: 2536
---
`/gsd-review`'s codex lane no longer passes the hook-trust bypass flag or runs its capability probe — host-harness safety classifiers denied invocations carrying them, and flagless invocations work in steady state. A genuine untrusted-hook failure still surfaces as a dropped lane with diagnosable stderr. (#2479)

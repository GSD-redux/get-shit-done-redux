---
type: Fixed
pr: 2923
---
**Contributor PRs stop conflicting on a file they never meaningfully changed** — the emitted-drift acknowledgment moves from one shared `tests/emitted-drift-ack.json` every PR rewrote wholesale to per-PR fragments under `tests/emitted-drift-acks/`, so two PRs needing an acknowledgment can no longer collide with each other; the legacy file's 35 spent entries are migrated (not deleted) into a fragment so nothing is lost, and a next-only push guard now fails if the legacy shared file itself ever reappears, since every entry is scoped to the diff that introduced it and is spent the moment it merges. (#2914)

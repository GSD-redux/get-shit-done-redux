---
type: Fixed
pr: 2923
---
**Contributor PRs stop conflicting on a file they never meaningfully changed** — the spent acknowledgments left on `next` in tests/emitted-drift-ack.json are deleted, and a next-only push guard now fails if the file ever reappears, since every entry is scoped to the diff that introduced it and is spent the moment it merges. (#2914)

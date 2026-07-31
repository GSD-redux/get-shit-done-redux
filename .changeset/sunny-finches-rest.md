---
type: Fixed
pr: 0
---
**Contributor PRs stop conflicting on a file they never meaningfully changed** — tests/emitted-drift-ack.json's 34 spent #2834 acknowledgments are deleted, and a next-only push guard now fails if the file ever reappears, since every entry is scoped to the diff that introduced it and is spent the moment it merges. (#2914)

---
type: Fixed
pr: 0
---
**Fixed a silent CI failure in the raw-coverage test shards.** `test:coverage:unit:raw` (used by test.yml's sharded lane and release.yml's rc/finalize jobs) could OOM-crash after the test suite itself passed cleanly, showing no error beyond a bare non-zero exit code.

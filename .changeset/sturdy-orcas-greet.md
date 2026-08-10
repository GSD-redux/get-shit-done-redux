---
type: Fixed
pr: 3286
---
**`gsd-test` runs can now prepare the emitted-attribution baseline before the test suite starts** — the dockerized runner has no access to the GitHub-Actions-only cache CI restores, so both `tests/emitted-attribution.test.cjs` checks fell through to an in-job build that ran inside the parallel suite and timed out. A new opt-in `gsd:pretest-baseline` script generates the baseline once, serially, at the base ref when the runner supplies `GSD_TEST_BASE_REF`; it exits 0 on every failure path, so a run degrades to the previous in-job-build behavior rather than failing. (#3284)

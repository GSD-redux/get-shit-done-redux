---
type: Fixed
pr: 0
---
local test runs no longer fail when a daemon keeps a unix socket under the repo root — the overlay builder classified every non-directory entry as a file, so copyFileSync threw ENXIO and 32 tests failed in their before() hooks with no connection to the code under test (#3900)

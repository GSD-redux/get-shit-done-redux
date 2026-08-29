---
type: Fixed
pr: 4015
---
**A killed test chunk now names the file that was hanging.** `scripts/run-tests.cjs` logged only chunk starts, so a chunk killed at the 600s cap printed ~55 basenames and left the operator to guess which one hung — and every timing figure had to be reconstructed from CI log timestamps. It now emits per-chunk elapsed time on every path, names the files still in flight on a kill with how stale the last event is (hang vs. merely slow), and ranks the chunk by known weight, flagging files missing from the timings table. (#4012)

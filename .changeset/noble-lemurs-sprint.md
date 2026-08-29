---
type: Fixed
pr: 0
---
**`n/no-process-exit` no longer double-enforces alongside its replacement.** Epic #3889 registered `local/require-registered-exit` on `gsd-core/bin/**/*.cjs` and `scripts/**/*.cjs` but never retired the predecessor rule on those same globs, so both enforced the same property — and the coarser one would flag `terminateNow`'s own generated copy, the single sanctioned terminator. It is now off on exactly those two globs and deliberately still `error` on the seven that have no successor. (#3914)

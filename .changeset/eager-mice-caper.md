---
type: Fixed
pr: 2656
---
**`api-coverage` now ships the #2366 coverage-matrix fix** — the tracked `gsd-core/bin/lib/api-coverage.cjs` build artifact had drifted four days behind `src/api-coverage.cts`, so the module that actually ships still parsed non-coverage tables as data, mishandled multi-section matrices with repeated headers, and failed to parse `**OPT-OUT**`. Regenerated, plus a new `lint:generated-sync` check that fails when any tracked compiled artifact no longer matches its source. Also prunes two stale entries from the `no-phantom-issue-refs` guard: GitHub numbers issues and PRs from one shared counter, so both had since become real merged PRs, and the guard was rejecting accurate citations of them. (#2653)

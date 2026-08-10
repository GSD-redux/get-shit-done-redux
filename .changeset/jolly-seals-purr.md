---
type: Fixed
pr: 3285
---
**Twenty-five folded test suites no longer run twice on every CI lane** — three consolidated install suites each carried a verbatim second copy of a contiguous run of folded regression blocks (~5,800 lines), left behind by a stale-base re-application during the test-consolidation epic. Every duplicated block registered and passed twice, so nothing reported it, and a contributor fixing one of those regressions could edit one copy and leave the other asserting the old behavior with the suite still green. The duplicates are deleted, and a new `local/no-duplicate-fold-marker` ESLint rule fails the build if a folded suite ever appears twice in one host file again. (#3271)

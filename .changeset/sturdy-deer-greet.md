---
type: Fixed
pr: 2879
---
**The portability linter now catches Windows-path failures in membership and substring assertions** — `no-path-literal-in-assert` flags `.includes`/`.indexOf`/`.startsWith`/`.endsWith`/`.match` over a path-returning receiver (including through a `.map()` hop), not just equality assertions. Previously these passed lint and failed on Windows CI; the rule now surfaces them at lint time. (#2764)

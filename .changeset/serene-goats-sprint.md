---
type: Fixed
pr: 0
---
**The packaging guard stays armed on npm 12 (Node 26)** — npm 12 emits pack --json as an object keyed by package name, so parsed[0] was undefined, the before() hook threw, and all 6 packaging-guard tests (including both does-NOT-ship gates) went dark for Node 26 contributors (#3902)

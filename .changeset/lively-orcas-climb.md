---
type: Fixed
pr: 3499
---
**The build no longer requires Node 24: `escapeRegex` falls back to an in-file metachar escape when `RegExp.escape` is absent** (#3498) — `RegExp.escape` is ES2026 (Node 24+), and `src/pattern.cts` called it unconditionally, so `npm run build` itself failed on Node 22 (`gen-loop-host-contract` consumes the module), breaking the gsd-test `linux-node22` verification lane. The seam now prefers the built-in when present and falls back otherwise — still the single owner of escaping (#3212 invariant preserved). Behavior on Node 24+ is unchanged; match behavior below Node 24 is verified equivalent by regression tests that neuter `RegExp.escape` in a child process.

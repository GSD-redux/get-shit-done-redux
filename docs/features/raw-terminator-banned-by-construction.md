---
id: 3910
title: The Raw Terminator Is Banned by Construction
group: v1.7.0 Features
---

**Purpose:** Make a bare `process.exit(...)` a lint error everywhere it matters, so the
"nothing fails with success" defect class ADR-3889 exists to close cannot silently reopen
through a new call site.

**What changed (ADR-3889 Phase 6, #3910):**

- New rule `local/require-registered-exit` (`eslint-rules/require-registered-exit.cjs`) flags
  any `CallExpression` shaped exactly like `process.exit(...)`. It does **not** flag
  `process.exitCode = N` — that assignment is the correct drain-then-exit pattern `runMain`
  itself uses, and the two are structurally distinct (an assignment target is never a
  `CallExpression`).
- Registered on four globs: `src/**/*.cts`, `scripts/**/*.cjs`, `hooks/**/*.js`,
  `gsd-core/bin/**/*.cjs` (`eslint.config.mjs:420-426,545-547,574-576,601`). Registering on
  `src/**/*.cts` — not only the emitted `gsd-core/bin/lib/*.cjs` mirrors, which are globally
  eslint-ignored (ADR-457) — is load-bearing: a rule registered only on the emitted surface is
  blind to the real sources, the same way `n/no-process-exit` went invisible (#3496).
- The dead `n/no-process-exit: 'off'` carve-out for `hooks/**` is deleted: Phase 7 (#3911)
  migrated every enforcement hook onto `terminateNow`, so it protected nothing.
- Exactly two allowlist entries, repo-wide:
  1. The body of `terminateNow` in `src/cli-exit.cts` — detected **structurally** (any
     `process.exit()` lexically nested inside a function named `terminateNow`, *and* the file's
     basename is `cli-exit.cts`), not by path+line, so it does not rot when the function moves.
  2. `gsd-core/bin/gsd-tools.cjs`'s `ensureRuntimeBuild` bootstrap-failure path, via an inline
     `// eslint-disable-next-line local/require-registered-exit` with a stated reason — it runs
     *before* `./lib/cli-exit.cjs` is even required, so the registered-exit seam does not exist
     yet at that point in the process's lifetime.
- The last raw terminators in `src/**/*.cts` were migrated onto the seam, most notably
  `src/io.cts`'s `error()`: it changed from an uncatchable `process.exit(1)` to a catchable
  `throw new ExitError(1)` (stderr output is byte-identical; `runMain` projects the exit code).
  `terminateNow` could not serve this site — ADR-3889 §1 makes exit codes 0 and 1
  unallocatable, so `nameForExitCode(1)` throws. That control-flow change required three
  interceptor fixes so an `ExitError` reaches `runMain`: `command-routing-hub`'s `dispatch()`
  now rethrows it, and the profile-pipeline router's detached `.catch()` no longer calls
  `error()` — it writes stderr and sets `exitCode` in place.
- **Known limits (documented and test-pinned, not endorsed):** the rule matches the literal
  `process.exit(...)` shape only, with no scope/flow analysis. It does not catch
  `process['exit'](0)` (computed member access), `const e = process.exit; e(1)` (aliasing to a
  local binding before calling), or `process.exit.call(...)`/`.apply(...)` (indirect invocation).
  Catching these needs binding/scope-aware analysis, out of scope for this issue; pinning tests
  in `tests/eslint-rules.test.cjs` assert today's non-detection so a future widening is a visible
  choice, not a silent one.

See [Resolve a raw-terminator finding](../how-to/resolve-a-raw-terminator-finding.md) for what to
do when this rule fires, and [ADR-3889](../adr/3889-process-exit-contract.md) for the exit-code
registry the seam is layered over.

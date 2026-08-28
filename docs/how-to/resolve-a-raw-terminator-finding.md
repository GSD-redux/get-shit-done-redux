# How to resolve a raw-terminator finding

`npm run lint` (or `npx eslint .`) reported `local/require-registered-exit`. That rule bans a
bare `process.exit(...)` call everywhere it matters — the seam it protects is the whole point of
[ADR-3889](../adr/3889-process-exit-contract.md): every process termination is projected through
one of two registered terminators, so "nothing fails with success" cannot reopen through a new
call site that bypasses them.

This page covers what the rule reports, which of the three replacements applies to your surface,
the two existing allowlist entries and why a third should not be added casually, and the
documented evasions the rule cannot catch today.

## Read a finding

```
error  Raw process.exit() is banned outside terminateNow (ADR-3889). Use runMain/ExitError
(src/cli-exit.cts) for a CLI entrypoint, terminateNow (src/cli-exit.cts) for a hook that must
write-then-terminate immediately, or set process.exitCode and let the process drain naturally
when nothing needs an immediate hard exit.  local/require-registered-exit
```

The rule matches a literal `CallExpression` shaped exactly like `process.exit(...)` — a
non-computed `MemberExpression` on an identifier named `process` with a property named `exit`.
It does not flag `process.exitCode = N`: that is an assignment, never a `CallExpression`, and is
the correct pattern (see below).

## Pick the right replacement

Three outcomes exist. Pick by asking what the surrounding code actually needs, not by pattern-
matching on which file you happen to be in.

### 1. A CLI entrypoint — throw `ExitError`, let `runMain` project the code

If the call is deep inside a command's execution path and needs to unwind the stack and stop,
throw instead of exiting directly:

```js
throw new ExitError(1, 'a short reason');
```

`runMain` (`src/cli-exit.cts`) is the single place that catches an `ExitError` and turns it into
the process's actual exit code — it wraps every CLI entrypoint, so the throw always has somewhere
to land. This is exactly the migration `src/io.cts`'s `error()` went through: it used to call
`process.exit(1)` directly (uncatchable, stderr output unchanged), and now throws `ExitError(1)`
instead — stderr is byte-identical, only the control-flow shape changed.

**A throw only reaches `runMain` if nothing between the throw site and `runMain` swallows it.**
This branch's own migration needed three interceptor fixes for exactly that reason:
`command-routing-hub`'s `dispatch()` now rethrows an `ExitError` instead of catching it as a
generic failure, and the profile-pipeline router's detached `.catch()` no longer calls `error()`
(which would throw again from inside a `.catch()`, going nowhere) — it writes stderr and sets
`exitCode` in place instead. If you introduce a new `try`/`catch` or `.catch()` between your throw
site and `runMain`, check that it rethrows `ExitError` rather than absorbing it.

### 2. A hook that must write-then-terminate immediately — `terminateNow`

Enforcement hooks (`hooks/**/*.js`) run once per invocation and need to write their JSON response
and stop in the same breath — there is no `runMain` wrapper to unwind into. Use `terminateNow`
from `src/cli-exit.cts` (or its generated hook-side copy, `hooks/lib/cli-exit.js`). It is the
**only** sanctioned direct terminator in the codebase, and the only place exit code 2 (the
hook-protocol deny) may be produced (ADR-3889 §3).

If you are declaring a hook's fail-open/fail-closed policy rather than calling `terminateNow`
directly, see [Declare a hook's crash policy](declare-a-hook-crash-policy.md) — `allow()`/
`deny()`/`crash()` in `hooks/lib/hook-exit.js` are the higher-level vocabulary built on top of
this seam.

### 3. Nothing needs an immediate hard exit — `process.exitCode`

If the process should simply drain and exit non-zero once its event loop empties — no forced
unwind, no immediate write-then-die — set `process.exitCode` and return normally:

```js
process.exitCode = 1;
return;
```

This is never flagged: it is an assignment (`MemberExpression` target), never a `CallExpression`,
so the rule's `CallExpression`-only selector excludes it structurally. It is also the pattern
`runMain` itself uses once an `ExitError` is caught — projecting the code onto `process.exitCode`
rather than calling `process.exit()` a second time.

## The two allowlist entries — and why a third needs a real reason

Exactly two call sites in the repo are exempt, both for structural reasons, not convenience:

1. **`terminateNow`'s own body**, in `src/cli-exit.cts` — detected structurally: any
   `process.exit()` call lexically nested inside a function declaration or expression named
   `terminateNow`, *and* the file's basename is `cli-exit.cts`. The basename check matters on its
   own: without it, any function named `terminateNow` anywhere in the repo would silently inherit
   the allowlist.
2. **`gsd-core/bin/gsd-tools.cjs`'s `ensureRuntimeBuild` bootstrap-failure path**, via an inline
   `// eslint-disable-next-line local/require-registered-exit` carrying a reason. This one call
   runs *before* `./lib/cli-exit.cjs` is even required — the registered-exit seam has not been
   loaded yet at that point in the process's lifetime, so there is nothing to route through.

Do not add a third entry to make an inconvenient finding go away. If you believe you have a
genuine third case — code that runs before any exit seam is loadable, the same way
`ensureRuntimeBuild` does — that is a structural claim about your file's position in the process
lifecycle, not a style preference, and it belongs in chat as a blocking question before you land
an `eslint-disable` comment.

## Known evasions — using one is a review finding, not a fix

The rule matches the literal `process.exit(...)` shape with no scope or flow analysis, so three
shapes are not caught today (and are pinned by tests in `tests/eslint-rules.test.cjs` so a future
widening is a visible decision, not a silent one):

- `process['exit'](0)` — computed member access defeats the property-name check.
- `const e = process.exit; e(1);` — aliasing the function to a local binding before calling it;
  by the call site, the callee is a plain identifier, not a `MemberExpression` on `process`.
- `process.exit.call(null, 1)` / `process.exit.apply(null, [1])` — the outer call's callee is
  `process.exit.call`, not `process.exit` itself.

These are documented gaps, not sanctioned escape hatches. Writing code in one of these shapes to
route around the rule reopens exactly the defect class ADR-3889 exists to close, and is a review
finding — fix the underlying call the same way any other raw terminator would be fixed, do not
rely on the lint being unable to see it.

## Related

- [ADR-3889](../adr/3889-process-exit-contract.md) — the exit-code registry and the terminator
  contract this rule enforces
- [Declare a hook's crash policy](declare-a-hook-crash-policy.md) — the higher-level
  `allow()`/`deny()`/`crash()` vocabulary hooks use on top of `terminateNow`
- [Resolve ESLint coverage findings](resolve-eslint-coverage-findings.md) — sibling "the lint gate
  surfaced something, here is what to do with it" page

# How to adopt the v2 exit contract

`gsd-tools` runs, by default, under exit-contract **`v1`** — every observable exit code is
byte-identical to every prior release. **`v2`** is an opt-in projection, per
[ADR-3889](../adr/3889-process-exit-contract.md) §4, that turns a small set of previously
same-looking outcomes into distinct, non-zero exit codes a CI gate can branch on without parsing
stdout. This page covers how to turn it on, what the new codes mean, and how to migrate a gate that
today treats "any non-zero exit" as fatal.

## Should you turn this on?

Turn it on if a script or CI gate wraps `gsd-tools` and needs to tell "ran fine", "you called it
wrong", "there was nothing to find", "a prerequisite was missing", "it crashed", and "it ran but is
reporting a condition in its payload" apart **from the exit code alone**, instead of parsing JSON on
stdout to find out. If your caller only ever needs pass/fail, `v1` already gives you that — there is
nothing to adopt.

## Step 1 — turn it on

Either a flag or an environment variable activates `v2`. The flag beats the env var if both are
given in the same invocation.

```bash
# Per-invocation (preferred in test code and one-off scripts):
node gsd-tools.cjs --exit-contract=v2 state validate --strict

# Process-wide (preferred for CI and shell wrappers):
export GSD_EXIT_CONTRACT=v2
gsd-tools state validate --strict
```

The flag works in any argv position — before the subcommand or after it — and `gsd-tools` strips
it before dispatch, exactly as it already does for `--json-errors`.

Only the exact lowercase tokens `v1`/`v2` are accepted. Anything else present — a typo, `V2`,
`v3`, or an explicitly empty `--exit-contract=` — throws rather than silently falling back to `v1`;
a selector for a contract whose whole point is "nothing fails with success" must not itself fail
open. That throw surfaces as a stack trace at exit `1`, not as a tidy `USAGE` `64`, and that is
deliberate: the failure is *the version being unresolvable*, so there is no contract version yet
under which to project a code. Loud and coarse beats quiet and wrong. An empty
`GSD_EXIT_CONTRACT=` (nothing after the `=`) reads as **unset**, not as an explicit selection, so a
shell that exports it empty still gets `v1`.

## Step 2 — read the code table

`v2` projects a declared outcome through one generated registry
(`gsd-core/bin/lib/exit-code-registry.cjs`). Every code below is stable and machine-checked; do not
hardcode the integers in your own scripts — call `exitCodeFor(name)` if you are writing Node, or
just compare against the number after reading it here once.

| Code | Name | Meaning |
|--:|---|---|
| `0` | (PASS) | The operation ran and its verdict is affirmative. |
| `1` | (FAIL) | The operation ran and its verdict is negative — the honest default when nothing more specific applies. |
| `64` | `USAGE` | Caller error — bad argv, unknown subcommand, missing required argument. |
| `66` | `NO_INPUT` | Ran; zero units were in scope, and that emptiness is known to be genuine. |
| `69` | `UNAVAILABLE` | Could not run — a prerequisite was absent, unreadable, or scope was never established. |
| `70` | `INTERNAL` | Self-failure — the run itself broke (crash, timeout, killed subprocess), not its inputs. |
| `80` | `DEGRADED` | Ran to completion and is **reporting a condition through its result payload**, not failing as a process. |

`2` is reserved to the Claude Code hook-protocol deny and is never produced by `gsd-tools` itself —
you will not see it from a CLI invocation.

## Step 3 — understand `80` specifically

`80` (`DEGRADED`) is the one code most CI authors get wrong, because it is the one code where "ran
to completion" and "found a problem" are the same event. It fires when a command's JSON payload
carries a **serializable** `error` key — for example `gsd-tools state-snapshot` in a project with
no `STATE.md` returns `{"error": "STATE.md not found"}`. Under `v1` that exits `0`; under `v2` it
exits `80`.

`80` is **not** a crash. The process did its job: it determined, correctly, that the artifact you
asked about is absent, unparseable, or that a required argument was missing — see
[ADR-2980](../adr/2980-payload-carried-error-is-a-degraded-result.md) for the full population this
covers (64 call sites across nine modules) and why it stayed a payload-carried signal rather than a
thrown fault. `70` (`INTERNAL`) is the code for an actual crash. Do not conflate the two: a gate
that maps `80` to "the tool is broken" will page someone for a condition the tool successfully
diagnosed.

## Step 4 — migrate a gate that treats any non-zero exit as fatal

The naive shell form,

```sh
if ! gsd-tools state-snapshot > snap.json; then
  echo "gsd-tools failed" >&2
  exit 1
fi
```

is **correct as a fail-safe** under `v2` — every registered code is non-zero, so this can only turn
a false green red, never a red green (ADR-3889 §5). What it cannot do on its own is tell you *which*
non-zero condition fired, which matters if your policy is "treat `DEGRADED` as a soft warning but
still hard-fail on `USAGE`/`UNAVAILABLE`/`INTERNAL`":

```sh
set +e
gsd-tools --exit-contract=v2 state-snapshot > snap.json
code=$?
set -e

case "$code" in
  0)   ;;                                            # PASS
  80)  echo "degraded result — inspect snap.json" >&2 ;;  # ran, reported a condition — your call whether this gates the pipeline
  64|66|69|70)
       echo "gsd-tools failed (exit $code)" >&2
       exit 1
       ;;
  *)   echo "gsd-tools failed (unrecognized exit $code)" >&2
       exit 1
       ;;
esac
```

Whether `DEGRADED` itself should gate your pipeline is a policy decision only you can make — the
contract's only promise is that `80` is distinguishable from `64`/`66`/`69`/`70`, not that it is
always safe to ignore. A gate that wants the old, coarser behavior (any non-zero is fatal, including
`80`) needs no case statement at all; the naive form above already does that correctly.

## Four things that will surprise you

1. **`--json-errors` is a different, orthogonal switch.** It governs whether `error()`'s stderr
   envelope is JSON or plain text; it does nothing to `output()`'s exit code. You can run `v2` with
   or without `--json-errors`.
2. **Precedence can surprise a caller reading only `output()`'s contract.** An explicit `main()`
   return, or a non-zero `process.exitCode` a command set directly, always wins over a `DEGRADED`
   declared earlier in the same invocation — projection can only raise a code, never lower one. See
   [`docs/json-errors.md`](../json-errors.md#outcome-declaration-and-the-versioned-exit-contract-adr-3889-4-3912)
   for the full precedence order.
3. **The declaration does not accumulate.** If a command calls `output()` more than once — a
   diagnostic degraded payload followed by a clean final one — only the **last** call's declaration
   is live when the process exits.
4. **`v1` and `v2` are the only recognized versions today**, and the default flips to `v2` at the
   next major (ADR-3889 §4). Pin `--exit-contract=v1` explicitly in a script that must keep today's
   codes indefinitely, rather than relying on the current default staying `v1` forever.

## Related

- [ADR-3889](../adr/3889-process-exit-contract.md) — the exit-code registry and the versioned
  projection this page walks through
- [ADR-2980](../adr/2980-payload-carried-error-is-a-degraded-result.md) — why `output({error})`
  exits `0` under `v1`, and the population `DEGRADED` covers under `v2`
- [`docs/json-errors.md`](../json-errors.md) — the full reference for both failure channels,
  the error-code taxonomy, and the outcome-declaration precedence rules
- [Resolve a raw-terminator finding](resolve-a-raw-terminator-finding.md) — the sibling page for the
  lint rule that keeps every termination path routed through this same seam

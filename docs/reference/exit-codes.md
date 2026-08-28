# Exit code reference

> **Generated file — do not edit by hand.**
> This page is generated from the exit-code declaration
> (`gsd-core/bin/shared/exit-codes.json`) by `scripts/gen-exit-code-docs.cjs`
> and kept honest by a drift guard in `npm run lint:generated-sync` (which runs
> `node scripts/gen-exit-code-docs.cjs --check`). Any manual edit is overwritten
> on the next generation run. To register a new code, add an entry to the
> declaration and run `node scripts/gen-exit-code-registry.cjs --write && node
> scripts/gen-exit-code-docs.cjs --write`.

See also: [ADR-3889 — one exit-code registry](../adr/3889-process-exit-contract.md) —
[Adopt the v2 exit contract](../how-to/adopt-the-v2-exit-contract.md) —
[JSON error mode](../json-errors.md)

---

## Registered codes (6)

Every process-level exit code `gsd-tools`, its hooks, and its scripts may terminate
with, by name, meaning, and the module that owns it.

| code | name | meaning | owning module | authorized by |
|---|---|---|---|---|
| 2 | `HOOK_DENY` | Hook protocol deny — the harness blocks the tool call | `hook-adapter` | ADR-3889 |
| 64 | `USAGE` | Caller error — bad argv, unknown subcommand, missing argument | `generic` | ADR-3889 |
| 66 | `NO_INPUT` | Ran; zero units were in scope, and that emptiness is known to be genuine | `generic` | ADR-3889 |
| 69 | `UNAVAILABLE` | Could not run — prerequisite absent, input unreadable, scope unestablished | `generic` | ADR-3889 |
| 70 | `INTERNAL` | Self-failure — crash, timeout, killed subprocess | `generic` | ADR-3889 |
| 80 | `DEGRADED` | Ran to completion and is reporting a condition through its result payload rather than as a process failure | `gsd-tools` | ADR-3889 + ADR-2980 |

---

## Reserved bands

The registered codes above are not chosen freely — each falls inside one of a
fixed set of allocatable bands (ADR-3889 §1). A code outside these bands can
never be registered; validation rejects it before it reaches the tables above.
This is what makes an unfamiliar number in a CI log actionable: look up its
band first, then its registered name if it has one.

| Band | Meaning |
|---|---|
| `0`, `1` | **Free — never allocatable.** `0` is the universal "succeeded" convention and `1` is the universal "failed, no further detail" convention across nearly every CLI ecosystem. Registering either here would collide with that universal meaning instead of adding a distinct, named signal — so the registry leaves both permanently unallocated. |
| `2` | Reserved exclusively to the Claude Code hook-protocol deny (`HOOK_DENY`) — owned by `hook-adapter` and no other module. |
| `3`–`13` | **Node-reserved.** Node.js itself assigns meaning to this range (e.g. internal JavaScript errors, fatal exceptions, invalid argument errors) before a GSD process ever gets a chance to project its own outcome. Allocating one of these would be indistinguishable from a Node-level failure the process never intended to report. |
| `14`–`63`, `79`, `126+` | Outside every allocatable band — not Node-reserved, but also not opened for GSD use. `126`+ additionally collides with the shell convention for "command not executable" / "signal N" (`128+N`), which a process exit code must never impersonate. |
| `64`–`78` | **Generic band.** Codes any module may use for caller-facing, non-domain-specific outcomes (bad argv, no input in scope, a missing prerequisite, an internal crash). |
| `80`–`125` | **Domain band.** Codes reserved for a specific product surface's own vocabulary — currently only `gsd-tools`' `DEGRADED` (a completed run reporting a condition through its payload rather than as a process failure). |

## The v1/v2 exit contract

ADR-3889 §4 adds a **version projection** on top of this registry, not a second
registry: every registered name above projects to the *same* code under both
contract versions, with one deliberate exception — `DEGRADED`. Under the
default, backward-compatible `v1` contract, a payload-carried error
(`output({error})`) still exits `0`, exactly as ADR-2980 ratified for the ~60
pre-existing call sites that already depended on that behavior. Under the
opt-in `v2` contract, the same outcome exits `80` (`DEGRADED`) instead, so a
caller that wants to branch on the exit code alone — without parsing stdout —
can opt in without breaking every existing consumer. See
[Adopt the v2 exit contract](../how-to/adopt-the-v2-exit-contract.md) for how to
turn this on, and [JSON error mode](../json-errors.md) for the full fault vs.
degraded-result channel taxonomy this registry sits underneath.

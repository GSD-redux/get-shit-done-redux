# ADR-2008: Generic gate-predicate evaluator

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-04 |
| **Issue** | [#2008 — No generic evaluator for third-party capability gates](https://github.com/open-gsd/gsd-core/issues/2008) |
| **Supersedes** | — |
| **Amends** | ADR-0894 (capability declaration format — `check.predicate` evaluation path) |

## Context

Capability gates are declared in `capability.json` under `gates[].check`. The
registry validator (`capability-validator.cjs:validateGate`) recognises three
mutually-exclusive `check` shapes — `query`, `predicate`, and `agentVerdict` —
and the loop-resolver (`loop-resolver.cts:renderLoopHooks`) renders all active
gates to the workflow gate-dispatch sites.

Prior to this ADR, only `check.query` was **enforced**: every workflow
gate-dispatch site ran `gsd_run check ${hook.check.query}`, which routes through
the fixed if-chain in `check-command-router.cts:routeCheckCommand`. A
`check.predicate` (e.g. the `security` capability's
`artifact-frontmatter-equals` declaration) was **declaration-only** — rendered
for display, never evaluated. The security capability's `threats_open == 0`
enforcement worked only because `ship.md` hard-codes a `capId == "security"`
prose branch that reads `SECURITY.md` frontmatter directly. There was no
extension path for a third-party capability's gate to actually fire.

Issue #2008 asked for a generic, data-driven gate-evaluation path. Two candidate
directions were proposed:

1. A generic `check.predicate` evaluator covering `artifact-frontmatter-equals`
   and future kinds.
2. A documented, sandboxed **`command-exit-zero`** gate kind — "run `<cmd>`,
   block on non-zero exit" — matching the git-hook / CI-runner enforcement
   shape.

The maintainer chose **Option 2** (issue comment, 2026-07-04).

## Decision

Add a **generic gate-predicate evaluation path** with two built-in kinds,
`command-exit-zero` and `artifact-frontmatter-equals`, scoped as follows.

### Declaration shape

A capability declares a `command-exit-zero` gate under the existing
`check.predicate` block (already a first-class, validator-accepted shape):

```json
"gates": [
  {
    "point": "ship:pre",
    "check": {
      "predicate": {
        "kind": "command-exit-zero",
        "command": "node scripts/check.sh \"${PHASE_DIR}\"",
        "timeout": 30
      }
    },
    "when": "my_cap.enabled",
    "blocking": true,
    "onError": "halt"
  }
]
```

`predicate.command` is required (non-empty string, ≤ 4096 chars).
`predicate.timeout` is optional (positive finite number, seconds; default 30).

### Sandbox contract (the security core of this ADR)

| Axis | Value | Rationale |
|---|---|---|
| Interpreter | `sh -c` (via `shell-command-projection.execTool`) | Cross-platform with the runtime's existing bash dependency; one string, no argv array to author |
| cwd | Project root (the runtime `cwd`) | Matches the user's working context; the same root existing `check.query` gates operate from |
| Environment | Inherit process env | The command runs as the user, on the user's machine, in the project they are working on — no sandbox boundary is crossed vs. the user's own shell. Override via the command itself (`env VAR=x ...`) |
| Timeout | Default 30s; overridable per-gate | Bounded execution is non-negotiable; an unbounded gate could hang the loop forever |
| Interpolation | `${PHASE_NUMBER}`, `${PHASE_DIR}`, `${PHASE_REQ_IDS}` substituted from gate context; undefined → `''`; all other `${X}` left untouched for `sh` to interpret | Parity with the context existing `check.query` gates already receive |
| Result mapping | exit 0 → `block:false`; non-zero → `block:true`; timeout (SIGTERM) → `block:true` (`timed_out`); `sh` missing (ENOENT, exit 127) → `block:true` | Fail-closed: every non-zero outcome blocks. A blocking gate with `block:true` halts per the existing two-step gate contract |
| Output cap | stderr/stdout tail embedded in `message` trimmed to 2000 chars | Keeps the `GATE_RESULT` payload context-bounded |

### Evaluation path

- A new pure leaf module `src/gate-predicate-evaluator.cts` owns
  `evaluatePredicate(predicate, context, deps)`. It is fully deps-injected (the
  subprocess seam is `runBoundedShell`) — no fs, no child_process, no config —
  so it is trivially unit-testable without spawning. A `KIND_TABLE` dispatches
  by `predicate.kind`; adding a future kind is a one-line registration.
- `check-command-router.cts` gains a `predicate` subcommand
  (`gsd_run check predicate --predicate '<json>' [--phase-dir …] [--phase-number …]
  [--phase-req-ids …] --raw`). It parses flags, builds the production deps
  (wrapping `execTool`), calls `evaluatePredicate`, and emits the standard
  `{ block, message, details? }` envelope via `output()`.
- The three generic workflow gate-dispatch sites — `execute:wave:post`,
  `execute:post`, `plan:post` — now branch on the gate's `check` shape:
  `check.query` → existing `gsd_run check <query>` path; `check.predicate` →
  `gsd_run check predicate`. The two-step Step-1 (command-failure → `onError`)
  / Step-2 (`block` → halt) contract is **unchanged** — the predicate path
  emits the same envelope and the same check-command-failure semantics.

### Fail-closed mapping for malformed predicates

`evaluatePredicate` **throws** for a malformed predicate (missing/non-string
command, non-positive timeout, oversized command, unknown kind). The CLI
wrapper maps a throw to `error()` (non-zero exit), which the workflow treats as
a **Step-1 command failure** — routed per the gate's `onError` (`halt` or
`skip`). This deliberately does **not** conflate an evaluator bug with a
legitimate gate-block decision: a recognised predicate returns
`{ block, … }`; an unrecognised one fails the check command.

## Trust model

Capabilities are opt-in installs (like npm packages): installing one already
trusts it to ship skills, agents, and hooks that run arbitrary code.
`command-exit-zero` is therefore **not a new trust boundary** — it is another
code-execution path for already-trusted capabilities. Security does not rely on
secrecy (Kerckhoffs): the command is declared in plain JSON, and safety comes
from bounded timeout + fail-closed mapping + the opt-in install, not from
hiding the mechanism.

## Consequences

- **Positive:** Third-party capability gates now actually fire. The path is
  generic; future predicate kinds (e.g. a revival of `artifact-frontmatter-equals`
  to retire the hard-coded `ship.md` security branch) register in `KIND_TABLE`
  without further workflow changes.
- **Positive:** The evaluator is a pure leaf with injected I/O, matching the
  ADR-857 module decomposition and the repo's test conventions.
- **Negative / documented limitation:** A command that backgrounds a child
  (`sleep 100 &`) can outlive the timeout kill of its direct `sh` parent —
  `execTool` kills the direct child on SIGTERM, not the whole process group.
  This is the same property the existing `check.query` gates have (they too can
  spawn long-running subprocesses). Full process-group kill is a future
  hardening, out of scope here; the threat is a malicious capability, which is
  already trusted.
- **Negative:** `sh` must be present. On Windows without a POSIX shell
  (git-bash / WSL), `command-exit-zero` gates fail-closed with exit 127. This
  matches the runtime's existing bash dependency for workflows.

## Out of scope

- Retiring the hard-coded `security` branch in `ship.md`.
- `check.agentVerdict` evaluation (advisory, `blocking:false`-forced, separate
  concern).
- Process-group kill on timeout.

## References

- Issue: [#2008](https://github.com/open-gsd/gsd-core/issues/2008)
- Parent bundle: #2004
- ADR-0894 (capability declaration format)
- ADR-0857 (capability system / module decomposition)
- `src/gate-predicate-evaluator.cts`, `src/check-command-router.cts`
- Diátaxis docs: `docs/reference/gate-predicates.md`, `docs/how-to/command-exit-zero-gate.md`

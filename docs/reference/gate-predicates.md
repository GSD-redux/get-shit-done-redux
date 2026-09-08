# Gate predicates (reference)

> **Diátaxis quadrant:** Reference. This is the canonical specification of the
> capability gate `check.predicate` evaluation path. For a step-by-step
> authoring guide, see [How-to: add a command-exit-zero gate](../how-to/command-exit-zero-gate.md).

A capability gate's `check` block carries exactly one of three shapes
(`query`, `predicate`, `agentVerdict`), enforced by the registry validator
(`capability-validator.cjs:validateGate`). This page documents the
**`predicate`** shape and the kinds the built-in evaluator recognises.

## Declaration

```json
"gates": [
  {
    "point": "<loop-point>",
    "check": {
      "predicate": {
        "kind": "<kind>",
        "<kind-specific fields>"
      }
    },
    "when": "<config-key>",
    "blocking": true,
    "onError": "halt"
  }
]
```

The gate envelope (`point`, `when`, `blocking`, `onError`) follows the standard
contract documented in ADR-0894 (capability declaration format) and the
`Loop Host Contract` glossary entry in `CONTEXT.md`. This page covers only
`check.predicate`.

## Evaluation path

1. The loop-resolver (`gsd-tools loop render-hooks <point>`) renders the active
   gate hook (including its `check.predicate` declaration) to the workflow.
2. The workflow gate-dispatch reads the hook in-context and, when the `check`
   shape is `predicate`, runs:
   ```bash
   gsd_run check predicate --predicate '<predicate JSON>' [--phase-dir …] [--phase-number …] [--phase-req-ids …] --raw
   ```
3. `check-command-router.cts:cmdCheckPredicate` parses the predicate, confines
   `--phase-dir` to the project (see **Path confinement** below), builds the
   production subprocess binding, and calls
   `gate-predicate-evaluator.cjs:evaluatePredicate`, which dispatches by
   `predicate.kind`.
4. The evaluator returns the standard gate envelope:
   ```json
   { "block": <bool>, "message": "<string>", "details": { … } }
   ```
5. The workflow applies the **two-step gate contract** unchanged:
   - **Step 1** — if the check command itself failed (non-zero exit, e.g. a
     malformed predicate / unknown kind), route per `onError` (`halt` or `skip`).
   - **Step 2** — if the command succeeded, a `blocking: true` gate halts on
     `block: true`; an advisory gate shows `message` and continues.

## Path confinement

`--phase-dir` is the only directory path supplied to predicate evaluation, and
both built-in kinds read it: `artifact-frontmatter-equals` searches it for the
artifact, and `command-exit-zero` exposes it as `${PHASE_DIR}` (see
**Interpolation** below). It is therefore resolved against the project root
and rejected if it escapes:

- A relative value resolves against the project root, never the process cwd.
- The value is canonicalized with `realpath`, so a symlink whose target lands
  outside the project is rejected along with a plain out-of-project path.
- Rejection is a **check-command failure** (non-zero exit), which the two-step
  contract routes per `onError` — never a `block: false` verdict sourced from
  outside the project.
- A blank value stays the "no phase context" shape: the evaluator treats it as
  absent and falls back to the project root.

The predicate's own `artifact` suffix is confined under the resolved phase
directory separately, so neither the root nor the leaf can traverse out.

Confinement is a PATH check only — it guarantees the resolved directory sits
inside the project, not that its text is safe to hand to a shell. A confined
value can still contain shell metacharacters (e.g. a not-yet-created leaf
segment, which confinement accepts without touching the filesystem). The
`command-exit-zero` kind's `${PHASE_DIR}` interpolation handles that
separately — see **Interpolation** below.

## Built-in kinds

### `command-exit-zero`

Runs a declared command in a bounded `sh -c` subprocess; **exit 0 → pass,
non-zero → block, timeout → block.** See ADR-2008 for the full sandbox
contract.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `kind` | string | yes | — | Must be `"command-exit-zero"` |
| `command` | string | yes | — | The shell command. Non-empty, ≤ 4096 chars |
| `timeout` | number | no | `30` | Positive finite number, seconds |

**Interpolation.** Three placeholders resolve from the gate context; all
others are left untouched for `sh` to interpret against its own env:

| Placeholder | Source | Workflow flag |
|---|---|---|
| `${PHASE_NUMBER}` | the active phase number | `--phase-number` |
| `${PHASE_DIR}` | the active phase directory, confined to the project (see **Path confinement**) | `--phase-dir` |
| `${PHASE_REQ_IDS}` | the phase's requirement ids | `--phase-req-ids` |

These are exported as real environment variables on the `sh -c` subprocess —
never textually substituted into the command string — so `sh`'s own `${VAR}`
expansion resolves them as inert data. A value containing shell
metacharacters (`$()`, backticks, `;`, `|`) therefore cannot inject into the
command, even though `--phase-dir` is otherwise arbitrary path text. An
undefined placeholder resolves to the empty string.

**Quote it with double quotes**, e.g. `"${PHASE_DIR}"` (every example above
does). Single quotes suppress ALL shell parameter expansion (standard POSIX
`sh` behavior, not specific to this evaluator) — `'${PHASE_DIR}'` stays the
literal text `${PHASE_DIR}`, which never matches a real path, so `test -f
'${PHASE_DIR}/x'` always fails (`block: true`). **In a NEGATED command this
fails OPEN, not closed**: `! test -f '${PHASE_DIR}/x'` always exits 0
(`block: false`), since the always-failing `test` always negates to success —
silently skipping the check it declares. This is an authoring mistake in the
capability's own trusted command, not an attacker-reachable path (ADR-2008
"Trust model"), but it fails in the dangerous direction, so double-quote it.

**Sandbox.** cwd = project root; env = inherited from the GSD process plus
the three `PHASE_*` vars above; killed (SIGTERM) on timeout. The command runs
as the user, on the user's machine — there is no sandbox boundary vs. the
user's own shell. See ADR-2008 "Trust model".

**Result mapping.**

| Command outcome | `block` | `message` |
|---|---|---|
| exit 0 | `false` | `command exited 0` |
| exit N (non-zero) | `true` | `command exited N: <stderr/stdout tail, ≤2000 chars>` |
| timeout (SIGTERM) | `true` | `command timed out after <s>s: <tail>` |
| `sh` missing (ENOENT, exit 127) | `true` | `command exited 127: sh: not found` |

**Validation errors (throw → check-command failure → Step-1 / `onError`).**

- Missing, non-string, empty, or whitespace-only `command`.
- `command` longer than 4096 chars.
- `timeout` present but not a positive finite number.
- Unknown `kind`.

### `artifact-frontmatter-equals`

Reads a Markdown file with YAML frontmatter from the current phase directory (or falls back to the project root for project-level artifacts) and compares a field's value to the declared expectation. The value is matched using loosely typed string comparison or exact matching, where numeric expectations will safely match stringified numeric frontmatter values.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `kind` | string | yes | — | Must be `"artifact-frontmatter-equals"` |
| `artifact` | string | yes | — | Suffix or exact filename (e.g. `WINDOWS.md`) |
| `field` | string | yes | — | Frontmatter key to read |
| `equals` | any | yes | — | Expected value (compared with string coercion) |

**Result mapping.**

| Command outcome | `block` | `message` |
|---|---|---|
| Value matches `equals` | `false` | `Frontmatter field "<field>" matches expected value (<expected>)` |
| Value mismatch | `true` | `Frontmatter field "<field>" in <artifact> is <actual>, expected <expected>` |
| Artifact file not found | `true` | `Artifact matching <artifact> not found in <targetDir>` |

**Validation errors (throw → check-command failure → Step-1 / `onError`).**

- Missing or empty `artifact` string.
- Missing or empty `field` string.
- Missing `equals` value.
- File read or YAML parsing failure (I/O errors).

## Extensibility

The evaluator dispatches through a `KIND_TABLE`. Adding a new built-in kind is
a one-line registration in `gate-predicate-evaluator.cts` — no workflow changes
required, since the workflow dispatches any `check.predicate` to the same
`gsd_run check predicate` subcommand.

## Related

- [ADR-2008](../adr/2008-command-exit-zero-gate.md) — full decision record.
- [How-to: add a command-exit-zero gate](../how-to/command-exit-zero-gate.md).
- ADR-0894 — capability declaration format.
- `src/gate-predicate-evaluator.cts`, `src/check-command-router.cts`.

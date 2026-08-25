# State a failing direction

`/gsd-plan-phase` blocks when a plan's `<automated>` acceptance command does not say what output
constitutes failure. This page is what to do about it — how to write the statement, how to read
the probe's verdicts, and how to migrate a phase planned before the rule existed.

## The rule

Every runnable `<automated>` command needs a `<fails_when>` sibling naming an observable failure
signal:

```xml
<verify>
  <automated>npm --prefix apps/api test -- auth.spec.ts</automated>
  <fails_when>non-zero exit, or "0 passed" in the summary line</fails_when>
</verify>
```

Within one `<task>`, each `<fails_when>` binds to the nearest **preceding** `<automated>`, and
the first statement after a command is the binding one. Two commands need two statements.

## Write the statement

Ask one question: **if this command were silently doing nothing, what in its output would tell
me?** The answer is the statement. If there is no answer, you do not have an acceptance command
— fix the command rather than inventing a statement for it.

| Good — names a signal | Rejected — restates "failure" |
|---|---|
| `non-zero exit` | `the command fails` |
| `"0 passed" appears in the summary` | `it doesn't work` |
| `the coverage line is absent from stdout` | `an error occurs` |
| `stderr contains "ECONNREFUSED"` | `TBD` |
| `exit code > 0, or fewer than 12 tests report` | `N/A` |

Short is fine — `non-zero exit` is complete. There is no minimum length and no required keyword.
Any characters are safe: `exit code > 0` and `stderr contains "FAIL" && exit != 0` are ordinary
prose here.

## Run the probe yourself

```bash
gsd-tools check verify-failure-directions 3 --raw
```

Same JSON the plan-checker acts on. Each row carries `command`, `statement`, `plan`, `task`,
`status`, and `severity`.

## Read the verdicts

| `status` | `severity` | What happened | What to do |
|---|---|---|---|
| `ok` | `none` | A real statement is bound to this command | nothing |
| `missing` | `blocker` | The command has no `<fails_when>` | add one after the command |
| `empty` | `blocker` | The element is present but blank | fill it in, or delete the command |
| `placeholder` | `blocker` | The whole value is `TBD`, `TODO`, `N/A`, `NA`, `none`, `unknown`, `TBA`, `?`, or `-` | write the real signal; a statement you cannot write is a command you should not ship |
| `orphan` | `warning` | A `<fails_when>` that follows no command | move it after the command it describes |
| `sentinel` | `none` | A Nyquist `MISSING — Wave 0 …` placeholder — not runnable, so exempt | nothing; check 8a/8d own it |

The placeholder match is **whole-value and case-insensitive**. `TBD in the harness output` is real
prose and passes; a bare `TBD` does not.

## Tell "nothing to report" from "could not look"

The top-level `status` is `blocked` when any row is a blocker and `ok` when none are. A third
state matters: `unresolvable` with a populated `readError` means the probe **could not read the
plans** — an unreadable file, or a phase directory that does not resolve. An empty `commands`
list with a non-empty `readError` is not a clean bill of health, and neither the probe nor the
plan-checker will report it as one.

| Top-level `status` | `readError` | Meaning |
|---|---|---|
| `ok` | `null` | Every runnable command has a stated failing direction |
| `blocked` | `null` | At least one blocker — fix the rows above |
| `unresolvable` | populated | Could not look. Check the phase number and the plans' readability |

## Migrate a phase planned before this rule

A phase planned earlier has no `<fails_when>` anywhere, so re-checking it reports one `missing`
blocker per runnable command. Two ways forward:

1. **Add the statements by hand.** Run the probe with `--raw`, and for each `missing` row open
   the named `plan` and `task` and add a `<fails_when>` after that command. This preserves the
   plan as reviewed.
2. **Re-plan the phase** with `/gsd-plan-phase <N>`, which emits statements from the start. Do
   this when the plan needs revising anyway; it discards any hand edits.

Sentinel commands need no migration — they were never runnable.

## Related

- [`gsd-tools check verify-failure-directions`](../COMMANDS.md#gsd-tools-check-verify-failure-directions) — the command reference
- [Resolve verify-command path findings](resolve-verify-command-path-findings.md) — the sibling probe, for a command whose *target* does not resolve
- [Stated Failing Direction](../FEATURES.md#167-stated-failing-direction) — why the check is shaped this way

# Stated Failing Direction (#3172)

> Reference file for the gsd-planner agent. Loaded on-demand via `@` reference from the
> `<failing_direction_contract>` block of the planner spawn prompt in
> `gsd-core/workflows/plan-phase.md` — NOT from `agents/gsd-planner.md`, which is frozen
> under a 49152-LF-char cap, so planner-side rules are projected onto its spawn contract
> (the #3297 / #3645 precedent).

**Every runnable `<automated>` command needs a `<fails_when>` sibling naming what output
constitutes failure.** A command with no expressible failure mode is not an acceptance test.

```xml
<verify>
  <automated>npm --prefix apps/api test -- auth.spec.ts</automated>
  <fails_when>non-zero exit, or "0 passed" in the summary line</fails_when>
</verify>
```

**Why.** #3172: six plans shipped 21 `<automated>` commands that could not run at all — a
`--lib` target against a binary-only package. They sat inside the very blocks that decide whether
work is done, so the acceptance criteria for those plans were improvised at execution time by
three separate executors instead of reviewed at planning time. Cargo happened to exit non-zero,
so it failed loudly. The identical mistake with a command that exits 0 on a no-op — a test-name
filter matching nothing — passes green and silently. Naming the failure signal is what makes the
difference visible while you are still authoring the plan.

**The authoring test, applied to yourself:** *if this command were silently doing nothing, what
in its output would tell me?* If you cannot answer, you do not yet have an acceptance command —
you have a command. Fix the command, do not invent a statement for it.

## Rules

- **One statement per runnable command**, placed immediately after it. Within a task, each
  `<fails_when>` binds to the nearest preceding `<automated>`, and the first statement after a
  command is the binding one. Two commands need two statements.
- **Name an observable signal**, not the word "failure". `non-zero exit`, `"0 passed" in the
  summary`, `the coverage line is absent`, `stderr contains "ECONNREFUSED"` are signals. *"the
  command fails"*, *"it doesn't work"*, *"an error occurs"* are restatements and will be flagged.
- **Short is fine.** `non-zero exit` is complete. There is no minimum length and no required
  keyword.
- **`TBD`, `TODO`, `N/A`, `none`, `unknown`, `?`, `-` are rejected outright** as whole values.
  A statement you cannot write is a command you should not ship.
- **Any characters are safe.** `exit code > 0`, `stderr contains "FAIL" && exit != 0` are ordinary
  prose here — that is exactly why this is an element and not an attribute.
- **The `MISSING — Wave 0 must create …` sentinel is exempt.** It is not a runnable command, so
  it has no failure mode to state. Do not attach a `<fails_when>` to one.

## Where the failing direction comes from

Prefer the signal the tool actually emits over one you imagine. When
`prior_verify_commands` supplies a command a prior phase already proved, the failure signal that
command produces is the one to state — you have seen its output. When you author a new command,
name the signal from the tool's documented output shape, not from a guess about it.

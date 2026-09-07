# Loop Hook Dispatch Contract

Generic reference for consuming the `--raw` JSON output of `gsd_run loop render-hooks <point>`
in any host-loop workflow. This document is point-agnostic — it applies to every loop
extension point (discuss:pre, discuss:post, plan:pre, plan:post, execute:pre, execute:wave:pre,
execute:wave:post, execute:post, verify:pre, verify:post, ship:pre, ship:post).

## Envelope shape

```json
{
  "point": "discuss:pre",
  "activeHooks": [
    { "kind": "contribution", "into": "orchestrator", "fragment": { "inline": "..." } },
    { "kind": "step", "ref": { "skill": "my-skill" } },
    { "kind": "gate", "check": { "query": "..." }, "blocking": true, "onError": "skip" }
  ],
  "rendered": "...",
  "context": { "phase": "05", "phaseDir": ".planning/phases/05-widgets" }
}
```

`activeHooks` is an array of enabled hook entries for the named point. It is empty (or absent)
when no capability has registered an active hook at this point — treat that as a no-op.

`context` is additive and optional (#4030): present only when the caller passed `--phase
<token>` and it resolved to exactly one on-disk phase directory. It is the task-local phase
the render-hooks invocation was scoped to — **authoritative over `STATE.current_phase` or
artifact-order/mtime inference** for any dispatch below that needs a phase, since
`STATE.current_phase` is project lifecycle status, not a claim about this invocation's scope,
and the two diverge whenever one phase is being planned or verified while another still
executes. Absent `context` means either `--phase` was omitted, or it did not resolve to a
single directory (a warning is appended to `warnings` in that case) — dispatch exactly as if
no phase were relevant.

## Dispatch rules by `kind`

### `contribution`

Inject `fragment.inline` verbatim into the context for the role named in `into`
(e.g. `orchestrator`, `planner`). Do not paraphrase — the text is the product.

### `step`

Dispatch the referenced unit. Exactly one of `ref.skill`, `ref.agent`, or `ref.command` is set.

- `ref.skill` present → dispatch via the Skill tool with skill id `gsd-<ref.skill>`. If
  `context` is present and the target skill accepts a phase argument, pass it as the skill's
  args (e.g. `args="${context.phase}"`, plus whatever else that host's own dispatch already
  appends — this file is point-agnostic and assumes no ambient shell variable exists).
  Check the skill's own argument contract first. Do not assume a skill fails loudly when the argument is
  omitted: some (e.g. `code-review`) exit with "Phase not found"; others (e.g.
  `validate-phase`, whose `argument-hint` documents "optional, defaults to last
  completed phase") silently fall back to artifact-order inference — exactly the failure
  mode this field exists to close. Pass `context.phase` whenever it is present, in both
  cases.
- `ref.agent` present → dispatch via the Agent tool with `subagent_type` = `ref.agent`. If
  `context` is present, include `context.phase` / `context.phaseDir` in the agent's prompt so
  it operates on the task-local phase rather than inferring one.
  Before dispatching an agent, print the canonical liveness banner so users know silence
  is expected and do not kill a healthy agent:

  ```
  ◆ Spawning <agent>... (runs in a subagent — no output until it returns; expected, not a freeze)
  ```

- `ref.command` present → **validate it IN-CONTEXT first, before any shell use.** It comes
  from a capability manifest, which may be third-party. Check the value you read from
  `activeHooks` against `^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$` yourself — **never** by pasting
  it into a shell command to be tested there, because a value carrying a quote, `;`,
  `` ` ``, `$(`, or a newline would terminate the assignment and run as its own statement
  before any shell-side check could execute. A value that fails is a malformed manifest:
  record a warning, skip that hook, continue to the next entry. Only a value that has passed
  is run, with `context.phase` appended when present:

  ```bash
  gsd_run ${ref.command} --phase "${context.phase}" --raw
  ```

  `context.phaseDir` is not passed here: no first-party `ref.command` consumer
  (`intel api-surface`, `refactor evaluate`) parses a `--phase-dir` flag today. A
  capability that needs the directory, not just the token, resolves it itself from
  `--phase` the same way `init.*` does, rather than this contract inventing an
  unconsumed flag.

Wait for the result before continuing to the next hook or the next step.

A `step` is **advisory by construction**: it never blocks or redirects the host workflow —
that is what a `gate` is for. Each dispatch is best-effort; on error record a warning and
continue, honoring `onError`.

**A point whose workflow hand-rolls one `kind` does not implement this contract.** Several
host workflows historically matched a single hook (e.g. `execute:post` matched only
`ref.skill == "code-review"`), so any other step registered there was declared and silently
never run. When a workflow defers to this file, it dispatches **every** active `step` entry,
not one shape of one.

### `gate`

**Validate `check` before any shell use.** `check.query` and `check.predicate` come from a
capability manifest, which may be third-party — and `gates[].check` is **not** one of the
executable surfaces the install consent prompt discloses (`hooks`, command modules,
`mcpServers`, reviewer lanes), so a capability can be consented to as declarative-only and
still reach a shell through a gate. Check the query value you read from `activeHooks` against
`^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$` yourself, IN-CONTEXT — **never** by pasting it into a
shell command to be tested there, because a value carrying a quote, `;`, a `` ` ``, `$(`, or a
newline would terminate the assignment and run as its own statement before any shell-side
check could execute. A value that fails is a malformed manifest: record a warning, route it
per the gate's `onError`, and do not run it. Pass `check.predicate` as a **single argv
element** for the same reason — never re-quote it into a shell string, where an apostrophe
would close the literal. This is the identical requirement `step` → `ref.command` carries
above; it was stated there and omitted here, which is the gap #3559 closed.

Evaluate `check` (one of `query`, `predicate`, or `agentVerdict`). Then honor `blocking`:

- `blocking: true` → if the check returns `block: true`, surface `check.message` to the user
  and stop the current step. Do not continue.
- `blocking: false` → advisory only; surface the message but continue regardless of outcome.

Honor `onError` if the check itself errors: `skip` means treat as non-blocking and continue;
`halt` means surface the error and stop.

When `context` is present and the check invocation needs a phase argument, source it from
`context`, not an ambient variable — and match the subcommand's own argument shape, they
differ: a `query` check's phase-taking subcommands (e.g. `verify-context-drift`,
`verify-schema-drift`) take the phase **token** as a positional argument (`gsd_run check
${hook.check.query} "${context.phase}" --raw`); a `predicate` check's `gate-predicate-evaluator.cts`
(per ADR-2008) takes the **directory** as a named flag (`--phase-dir "${context.phaseDir}"`).

## Empty / absent `activeHooks`

If `activeHooks` is absent, null, or an empty array, skip silently and continue to the next
step in the workflow. No output to the user is needed.

## The `execute:task` point (a different shape)

`execute:task` exists below wave granularity — it is evaluated once per task, inside the
`execute:wave:pre` / `execute:wave:post` bracket, immediately before that task's `read_first`
gate. It is **not** one of the 12 points documented above, does not appear in `steps` /
`contributions` / `gates`, and is never dispatched through `gsd_run loop render-hooks <point>` or
this file's `activeHooks` envelope.

Instead, a capability declares task-content resolution directly in its manifest body via
`taskContentResolver` (`trackerPrefix` + a bounded `invoke`) — see
[Capability manifest reference](../../docs/reference/capability-manifest.md). `execute-plan.md`'s
per-task loop calls `gsd_run task resolve-content --plan <path> --task-id <tracker-id> --raw`
directly, an unconditional, required subprocess invocation with a real, binding exit code —
never a prose-dispatched `step`/`gate` entry chosen from an `activeHooks` array.

This point always runs — there is no `when` config gate and no autonomous-mode elision. That is
deliberate, not an oversight: the twelve points above are best-effort prose dispatch, which
`execute:task`'s hard-halt safety property cannot be built on top of (a missed dispatch is
indistinguishable from a legitimate resolver-empty fallback). See
[ADR-3646](../../docs/adr/3646-per-task-content-resolution-seam.md) for the full rationale,
including why a `kind: "gate"` shape was rejected outright.

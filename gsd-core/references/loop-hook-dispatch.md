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
  "rendered": "..."
}
```

`activeHooks` is an array of enabled hook entries for the named point. It is empty (or absent)
when no capability has registered an active hook at this point — treat that as a no-op.

## Dispatch rules by `kind`

### `contribution`

Inject `fragment.inline` verbatim into the context for the role named in `into`
(e.g. `orchestrator`, `planner`). Do not paraphrase — the text is the product.

### `step`

Dispatch the referenced unit. Exactly one of `ref.skill`, `ref.agent`, or `ref.command` is set.

- `ref.skill` present → dispatch via the Skill tool with skill id `gsd-<ref.skill>`.
- `ref.agent` present → dispatch via the Agent tool with `subagent_type` = `ref.agent`.
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
  is run, with the phase number appended:

  ```bash
  gsd_run ${ref.command} --phase "${PHASE_NUMBER}" --raw
  ```

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

## Empty / absent `activeHooks`

If `activeHooks` is absent, null, or an empty array, skip silently and continue to the next
step in the workflow. No output to the user is needed.

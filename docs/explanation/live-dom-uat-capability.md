# The live-DOM UAT capability

Why GSD can drive a browser during execution, and why it does that from a purpose-built agent
instead of from the plan executor.

## The problem

A phase with a live-UI acceptance criterion could not be finished by the agent that executed
it. `gsd-executor` carries no browser tools, so it did the correct thing — returned a
`checkpoint:human-action` at the gate — even though the work was not actually human-only. An
orchestrator with a browser MCP server could do it unattended.

The practical result was that every phase with a DOM-level acceptance criterion quietly
degraded from *executed by the executor* to *executed by the executor, then finished by hand in
the orchestrator*. On a UI-heavy project that is routine, not an edge case. Worse, the plan's
own `autonomous: false` marker could not distinguish **"a human must judge this"** from
**"the executor lacks the tool"** — so the run notes had to explain the deviation every time.

## The shape that was not taken

The obvious fix is to add browser globs to `agents/gsd-executor.md`'s `tools:` line. It is one
line, and an absent MCP server simply means the tool is not offered, so it is inert for anyone
without one.

That reasoning is correct and it is not the concern. The concern is the user who **does** have
a browser MCP configured for unrelated work. For a first-party agent, the static `tools:` list
is the only control that exists:

- **A capability cannot grant tools to a first-party agent.** [ADR-1244](../adr/1244-capability-ecosystem.md)
  D2 rejects an overlay whose `id` collides with a first-party id or that claims an agent stem
  already owned. A `contribution` hook ([ADR-857](../adr/857-capability-system.md) D4) injects
  prose into a step's prompt; no hook kind grants tool permissions.
- **There is no per-dispatch tool override.** The executor is spawned with `subagent_type`,
  `description`, `model`, and `prompt`. The agent definition file is the sole authority on its
  tool surface.
- **Nothing else contains it.** ADR-1244 D5 is explicit: *"there is no sandbox… Consent +
  integrity + reversibility are the barrier."* There is no domain allowlist and no gate that
  inspects what a browser call fetched.

The codebase already reflected this instinct. `gsd-ui-auditor` — the one subagent that produces
UI screenshots — captures via CLI rather than taking an MCP tool grant. The executor carrying
only `mcp__context7__*` while the researcher agents carry the full web-reaching set is a
deliberate separation, not an oversight.

So widening the executor would trade a narrow, auditable surface for a permanent broad one, to
solve a problem that a narrower surface also solves.

## The shape that was taken

One default-off capability owns everything:

- **The key.** `workflow.live_dom_uat`, `boolean`, default `false`, declared as the
  capability's `activationKey`. With it off the capability resolves **inactive**, and
  `resolveLoopHooks` is fail-closed on `state.active === true` — the hook does not render at
  all. The step's own `when` guard is a second, independent gate.
- **The agent.** `gsd-dom-verifier` carries `mcp__chrome-devtools__*` and
  `mcp__claude-in-chrome__*` in **its own** `tools:` line, and carries no `Bash`. Browser reach
  is confined to one agent that only exists to look at a DOM.
- **The step.** Registered at `execute:wave:post` as a `step` hook with `onError: skip`. A step
  is additive by construction — it never halts the host. Blocking preconditions are `gate`s,
  and this capability declares none.

`gsd-executor`'s tool surface is unchanged in every configuration. That is a tested invariant,
asserted as an absence, because that is the only way it is observable.

## Why the existing Playwright path was left alone

The orchestrator's `automated_ui_verification` step already used `mcp__playwright__*`, gated on
tool presence **plus** an active UI phase. Pulling that branch behind a new default-off key
would have silently removed working behaviour from every current Playwright-MCP user on
upgrade — a regression wearing an enhancement's clothes.

So the key gates only the **newly added** families. Playwright keeps the gating it already had.
The instruction to gate on "presence AND the config key, not presence alone" is what gives the
new families the same two-condition shape Playwright already possessed.

## Why there is no browser-lock coordination

`chrome-devtools-mcp` holds an exclusive lock on its browser profile, so parallel execution
waves will collide. The tempting design is a lease or queue around the profile.

GSD cannot enforce one. `--isolated` is a flag on the **user's** MCP server registration; GSD
neither launches that server nor passes its arguments. Coordination over a resource you do not
own is theatre — it adds machinery, and the lock still happens.

So the verifier tolerates the lock instead: it reports `could_not_look` / `profile_locked`,
names `--isolated` so the operator knows the remedy, and stops. No retry, no wait, no held-up
wave. The docs carry the flag; the code does not pretend to.

## The distinction the artifact must preserve

`DOM-VERIFY.md` separates **`nothing_to_report`** (there were no UI criteria) from
**`could_not_look`** (there were criteria, and the check did not happen — with a reason code
saying which). Collapsing those two is what produced the ambiguous run notes that opened the
original report. A report claiming *no issues* when it never opened a browser is worse than no
report.

## Known limits

- No sandbox. Once the key is on, nothing constrains which origins a browser call reaches.
  This capability narrows *who* can reach a browser, not *where* it may go.
- Concurrent waves still collide on a shared profile unless the operator passes `--isolated`.
- DOM observation only — no screenshot diffing, accessibility audit, or performance tracing.
- `chrome-devtools` and `claude-in-chrome` are detected but not feature-normalized; the
  verifier uses whichever answers and does not paper over differences between them.

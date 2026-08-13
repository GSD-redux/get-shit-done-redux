# Per-plan executor routing (#1689)

Run for each plan, immediately before its `Agent()` dispatch in step 3. Sets
`EXECUTOR_TYPE` so a plan can opt into a specialist executor instead of the
default `gsd-executor`. `plan_json` (the current plan's object from
`phase-plan-index`, same scope step 2.5 uses) is in scope.

## Contract

- Default: `EXECUTOR_TYPE="gsd-executor"` — byte-identical to pre-#1689 dispatch.
- A plan opts into a specialist by declaring `agent_hint: <name>` in its PLAN.md
  frontmatter. The field reaches the orchestrator as `plan_json.agent_hint`
  (parsed by `phase-plan-index`; `null` when unset).
- When routing is enabled AND the hint is non-empty AND the named agent resolves
  on the active runtime, `EXECUTOR_TYPE` becomes the hint. Otherwise it stays
  `gsd-executor`.
- The resolved `EXECUTOR_TYPE` is used as `subagent_type` in BOTH worktree and
  sequential dispatch (sequential reuses the worktree-mode `Agent()` template).

## Resolution

```bash
# Default-on; opt out with: gsd config-set workflow.agent_hint_routing false
AGENT_HINT_ROUTING=$(gsd_run query config-get workflow.agent_hint_routing --raw 2>/dev/null || echo "true")

EXECUTOR_TYPE="gsd-executor"
if [ "${AGENT_HINT_ROUTING:-true}" != "false" ]; then
  PLAN_HINT=$(jq -r '.agent_hint // empty' <<<"$plan_json" 2>/dev/null | tr -d '"')
  if [ -n "$PLAN_HINT" ]; then
    EXECUTOR_TYPE=$(gsd_run query resolve-agent --name "$PLAN_HINT" --raw 2>/dev/null || echo "gsd-executor")
  fi
fi

# #1689 v1 routes only the Agent()-based dispatch. On the orchestrator-worktree
# backend (process-spawn; no subagent_type) a resolved hint cannot be honored
# yet — surface it so a set hint is never silently ignored.
if [ "${ISOLATION:-}" = "orchestrator-worktree" ] && [ -n "${PLAN_HINT:-}" ]; then
  echo "note: plan ${plan_id} agent_hint='${PLAN_HINT}' resolved, but orchestrator-worktree dispatch does not route subagent types in this release — using the default executor." >&2
fi
```

`gsd_run query resolve-agent` consults the **active runtime's agent directory**
(both project-local and user-global, across runtime filename variants — `.md`,
`.agent.md`, `.toml`, the kimi `subagents/<name>.{yaml,md}` pair) and fails
closed to `gsd-executor` when the named agent does not resolve or on any error,
so a missing or misspelled hint never blocks dispatch.

## Scope

Routing applies to the `Agent()`-based dispatch (harness-worktree and sequential
modes). The `orchestrator-worktree` isolation backend spawns executors via a
separate process path that has no `subagent_type` and is not routed in this
release.

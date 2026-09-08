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
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
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

## Checkpoint gate rule (#3370)

Loaded with the routing resolution so the orchestrator reads it immediately
before composing each dispatch prompt, in every isolation mode.

On `checkpoint:human-verify` / `checkpoint:decision` tasks, `gate="blocking"`
(the default) is auto-approvable in auto-mode — that is the executor's own
`<checkpoint_protocol>` (`agents/gsd-executor.md`), and `checkpoints.md` (the
full gate table) is embedded in the dispatch `<execution_context>` verbatim.
Only `gate="blocking-human"` always surfaces to a human, regardless of
auto-mode. An unmet `<precondition>` checkpoint (executor step 0, `Blocked by:
Precondition not met` — unmet `user_setup` step, missing env var, absent
prior-phase artifact) reports `blocking-human` and therefore always surfaces
to a human, in every mode (#3210): the missing prerequisite is a fact only a
human can establish, not a verification step to rubber-stamp.

When composing the `Agent()` prompt, do NOT add text refusing or overriding
auto-approval for a `blocking` gate. Orchestrator-composed instructions that contradict the
executor's protocol win the executor's attention, stall autonomous runs at the
checkpoint, and defeat `_auto_chain_active`/auto-advance for the common case.
Executor-side gate semantics are already complete; compose nothing about gates
beyond what the template already embeds.

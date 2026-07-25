# Executor isolation dispatch (ADR-1239 / #2584 Phase 3)

Read and follow this fragment from `execute-phase.md` step 3 when dispatching a wave.
It owns the per-host dispatch detail so the host workflow stays inside its
ADR-857 Phase 6 byte budget (#1168) — the host step keeps only the `ISOLATION`
resolution and its fail-closed guard.

## Resolve ISOLATION

Run this in the config-gate step, right after `RUNTIME`/`USE_WORKTREES` are read.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# Isolation is a NEGOTIATED CAPABILITY, not a runtime id (#2584). Fail-closed to none.
ISOLATION=$(gsd_run query dispatch-isolation --raw 2>/dev/null || echo "none")
case "$ISOLATION" in
  harness-worktree|orchestrator-worktree|none) ;;
  *) ISOLATION=none ;;
esac

# Project-level opt-out wins on every host; a host with no primitive fails closed.
[ "$USE_WORKTREES" = "false" ] && ISOLATION=none
if [ "$ISOLATION" = "none" ] && [ "$USE_WORKTREES" != "false" ]; then
  echo "FATAL: runtime '$RUNTIME' declares no executor-isolation primitive (dispatch.isolation=none) — executors would run unisolated against the main checkout. Set workflow.use_worktrees=false." >&2
  exit 1
fi

# Sweep orphaned locked worktrees from prior crashed sessions (#3707).
[ "$ISOLATION" != "none" ] && gsd_run query worktree.reap-orphans 2>/dev/null || true
# Auto-degrade if HEAD diverged from the fork base (#683) — both isolation models.
if [ "$ISOLATION" != "none" ]; then
  _SHOULD_DEGRADE=$(gsd_run query worktree.base-check --pick shouldDegrade 2>/dev/null || true)
  if [ "$_SHOULD_DEGRADE" = "true" ]; then
    _DEGRADE_MSG=$(gsd_run query worktree.base-check --pick message 2>/dev/null || true)
    [ -n "$_DEGRADE_MSG" ] && printf '%s\n' "$_DEGRADE_MSG" >&2
    USE_WORKTREES=false
    ISOLATION=none
  fi
fi
```

`ISOLATION` — not `RUNTIME` — selects how the wave fans out. These three values are the only
branch points; **never add a `RUNTIME = "codex"` test to the scheduler.** The per-host
invocation detail is descriptor data, surfaced by `dispatch-isolation --json` as
`harnessFlag` / `exec`.

| `ISOLATION` | Fan-out | What the scheduler does |
|---|---|---|
| `harness-worktree` | host-driven | Pass the host's own declared isolation flag (`harnessFlag`) on each executor dispatch and let the harness create + bind the worktree. GSD runs no git. |
| `orchestrator-worktree` | GSD-driven | GSD creates the worktree (`worktree create`), then process-spawns the executor bound to it via the resolved `exec` argv/cwd. GSD performs all git operations. |
| `none` | none | Plans run inline, sequentially (unchanged). |

Fail-closed is the invariant: an undeclared, unknown, or unresolvable isolation declaration
degrades to `none`, never to an unsafe parallel path. A `harness-worktree` host with no
declared flag, and an `orchestrator-worktree` host whose exec descriptor does not resolve,
both degrade to `none` rather than dispatching executors that only believe they are isolated.

## harness-worktree — pass the host flag

Read the flag once before dispatching; it is descriptor data, never hardcoded per runtime:

```bash
HARNESS_FLAG=$(gsd_run query dispatch-isolation --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j&&j.harnessFlag?j.harnessFlag:"")}catch{process.stdout.write("")}})')
[ -n "$HARNESS_FLAG" ] || { echo "FATAL: runtime declares dispatch.isolation=harness-worktree but no harnessIsolationFlag — refusing to dispatch executors that would believe they are isolated." >&2; exit 1; }
```

Substitute `$HARNESS_FLAG`'s value for the `{harnessFlag}` placeholder in the `Agent()` dispatch
in `execute-phase.md` step 3 (on Claude Code it is literally `isolation="worktree"`).

## orchestrator-worktree — GSD creates the worktree and spawns the executor

The host has no harness-native isolation primitive, so **GSD** creates each worktree and process-spawns the executor into it. Fan-out is OS-level (N processes), not the host's subagent tool. Per the Codex `workspace-write` sandbox constraint, **the orchestrator performs every git operation** — create, merge, cleanup; the spawned executor only edits files and commits inside its own worktree.

Run the loop below once per runnable plan in the wave, **one plan at a time** (`git worktree add` races on `.git/config.lock`).

**Before running the bash block, substitute the plan's identifiers into it** exactly as you do for the `Agent()` prompt on the harness path: replace `{plan_number}` and `{phase_number}` with this plan's values. They are template placeholders, not shell variables. `$ORCH_ROOT` and `$EXPECTED_BASE` are real shell variables, already assigned earlier in this step; `$WAVE_WORKTREE_MANIFEST` was initialized above.

First build the executor prompt. It is the **same prompt text the harness path's `Agent()` call uses**, with the harness-only framing removed — drop the `<worktree_branch_check>` build-time embed note and the `<parallel_execution>` harness block, keep `<objective>`, the execution context, and `<success_criteria>` verbatim. Assign it to a shell variable so it can be passed as one argument:

```bash
# Compose the executor prompt for THIS plan. Single-quoted multi-line
# assignment (NOT a heredoc): these blocks are indented inside the workflow,
# and a heredoc terminator must sit at column 0 — `<<-` strips only tabs, not
# the leading spaces, so a heredoc here would never terminate. Single quotes
# also stop the shell expanding anything in the prompt body.
EXECUTOR_PROMPT='<objective>
Execute plan {plan_number} of phase {phase_number}-{phase_name}.
Commit each task atomically. Create SUMMARY.md.
Do NOT update STATE.md or ROADMAP.md — the orchestrator owns those writes after all worktree agents in the wave complete.
</objective>

<execution_context>
You are running as an executor in a git worktree GSD created for you. Your
working directory IS that worktree. Do not cd elsewhere, and do not run any
git command that targets the main checkout. Use normal git commits WITH hooks.
Do NOT use --no-verify.
REQUIRED ORDER: Write SUMMARY.md, commit, then any narration.
</execution_context>

<success_criteria>
- [ ] All tasks executed
- [ ] Each task committed individually
- [ ] SUMMARY.md created AND committed in the plan directory
</success_criteria>'
[ -n "$EXECUTOR_PROMPT" ] || { echo "FATAL: executor prompt is empty for plan {plan_number}." >&2; exit 1; }
```

The prompt body must contain no single-quote character, since the assignment above is single-quoted; keep apostrophes out of it when editing.

Then create the worktree and resolve the spawn:

```bash
# 1. Create the worktree. Bounded, manifest-recorded, fail-closed, and
#    root-confined by the verb itself — never hand-roll `git worktree add`.
AGENT_ID="agent-p{plan_number}-$(date -u +%s)"
WT_BRANCH="worktree-${AGENT_ID}"
WT_PATH="${ORCH_ROOT}/.claude/worktrees/${AGENT_ID}"
CREATE_JSON=$(gsd_run query worktree.create \
  --manifest "$WAVE_WORKTREE_MANIFEST" \
  --agent-id "$AGENT_ID" \
  --path "$WT_PATH" \
  --branch "$WT_BRANCH" \
  --base "$EXPECTED_BASE" \
  --root "$ORCH_ROOT" 2>&1) || {
    echo "FATAL: worktree create failed for plan {plan_number}: $CREATE_JSON" >&2
    exit 1
  }

# 2. Resolve the host's headless-exec argv for that worktree. Descriptor
#    data — command, args, cwd flag and prompt flag all come from the
#    capability descriptor, so no host is named here.
EXEC_JSON=$(gsd_run query dispatch-isolation --json \
  --cwd-target "$WT_PATH" \
  --prompt "$EXECUTOR_PROMPT")

# 3. MANDATORY fail-closed check. `dispatch-isolation` degrades to
#    isolation:"none" / exec:null rather than exiting non-zero, so the
#    command substitution above ALWAYS "succeeds" — the exit code proves
#    nothing. A worktree already exists at this point (step 1 is a real side
#    effect), so an unusable exec must NOT be spawned and must NOT be left
#    behind as an orphan: tear it down through the manifest-scoped cleanup
#    and halt rather than silently running the wave unisolated.
EXEC_OK=$(printf '%s' "$EXEC_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j&&j.isolation==="orchestrator-worktree"&&j.exec&&j.exec.command?"true":"false")}catch{process.stdout.write("false")}})')
if [ "$EXEC_OK" != "true" ]; then
  echo "FATAL: could not resolve an orchestrator-exec invocation for plan {plan_number} after its worktree was created. The wave is halted rather than run unisolated. Retained for inspection: $WT_PATH (branch $WT_BRANCH, recorded in $WAVE_WORKTREE_MANIFEST) — run 'gsd_run query worktree.cleanup-wave --manifest \"$WAVE_WORKTREE_MANIFEST\"' to merge/clean it." >&2
  exit 1
fi
```

`worktree create` records the entry in `$WAVE_WORKTREE_MANIFEST` itself, so **do not** call `worktree.record-agent` for these plans — that verb is the harness-path counterpart, used because the harness creates the worktree behind GSD's back. Double-recording is deduped by path+branch, but the create verb is the single writer here.

Spawn `EXEC_JSON`'s `command` + `args` as a background process with its working directory set to `EXEC_JSON.cwd`. The `cwd` is returned for **every** host, including those whose descriptor has no cwd flag (`cwdFlag: null`) and therefore bind through the process's own working directory — always set it, never assume the flag did the job. Wait for all spawned executors in the wave before merging.

The executor never touches `STATE.md`/`ROADMAP.md`, and that guard needs no new code — `execute-plan` auto-detects worktree mode via the `IS_WORKTREE` (`.git`-is-a-file) primitive, which a GSD-created worktree trips identically to a harness-created one.

Merge-back, validation, and cleanup are the **existing** gauntlet, unchanged: the serialized `worktree.cleanup-wave` merge loop that stops the wave and retains the worktree on conflict, and manifest-only cleanup (never glob-inferred). Because the manifest shape is identical, the orchestrator path reuses it verbatim.

> **Declared-scope conformance (#2596):** ADR-1239 specifies that *both* isolation adapters route their merge through a check that each plan branch's committed diff stayed inside its declared `files_modified` scope. That check does not exist yet for either adapter (it is tracked as #2596). When it lands it must be wired into this path **and** the harness path together.


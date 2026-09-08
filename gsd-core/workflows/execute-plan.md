<purpose>
Execute a phase prompt (PLAN.md) and create the outcome summary (SUMMARY.md).
</purpose>

<required_reading>
Read STATE.md before any operation to load project context.
Read config.json for planning behavior settings.

@~/.claude/gsd-core/references/git-integration.md
</required_reading>

<atomic_close_out_invariant>
For each executed plan, the only complete close-out order is:
`production-code commit(s) -> SUMMARY commit -> STATE/ROADMAP update`.

For a synchronous executor, the only legal half-state is mid-production-commits
while the executor is still actively working. Once production commits for a plan
exist, returning without a committed SUMMARY.md is an illegal partial-plan state.
The next execute-phase resume must detect that condition before dispatching
another executor.

**Async exception — `external_job_waiting`.** When an executor dispatches an
async external job (long-running compute) it commits an async-job manifest at
`.planning/async-jobs/<job>.json` and returns *without* SUMMARY.md. With a
manifest recording a non-terminal job for this plan, the SUMMARY-absent state is
a **legal deferred state** (`external_job_waiting`), not an illegal partial.
SUMMARY.md is deferred until the external job reaches a terminal state and its
output is verified. Resume reconciles against the manifest and must NOT
re-dispatch a fresh executor for a plan with a non-terminal manifest (that would
duplicate the external job). The manifest schema is the stability contract in
`docs/reference/planning-artifacts.md`; the scheduler adapter that *writes* it is
a capability (#1164), not core.
</atomic_close_out_invariant>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-executor — Executes plan tasks, commits, creates SUMMARY.md
</available_agent_types>

<process>

<step name="init_context" priority="first">
Load execution context (paths only to minimize orchestrator context):

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(gsd_run query init.execute-phase "${PHASE}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Extract from init JSON: `executor_model`, `commit_docs`, `sub_repos`, `phase_dir`, `phase_number`, `plans`, `summaries`, `incomplete_plans`, `state_path`, `config_path`, `response_language`.

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

If `.planning/` missing: error.
</step>

<step name="identify_plan">
```bash
# Use plans/summaries from INIT JSON, or list files
(ls .planning/phases/XX-name/*-PLAN.md 2>/dev/null || true) | sort
(ls .planning/phases/XX-name/*-SUMMARY.md 2>/dev/null || true) | sort
```

Find first PLAN without matching SUMMARY. Decimal phases supported (`01.1-hotfix/`).

**Exclude `external_job_waiting` plans from selection.** When choosing the first PLAN that lacks a matching SUMMARY, skip any plan whose `plan_id` matches an async-job manifest in `.planning/async-jobs/` (any status) — that plan is `external_job_waiting` or awaiting reconciliation, never work to (re-)dispatch (re-dispatching would duplicate the external job). Reconcile via the manifest / safe_resume_gate instead.

```bash
PHASE=$(echo "$PLAN_PATH" | grep -oE '[0-9]+(\.[0-9]+)?-[0-9]+')
# config settings can be fetched via gsd_run query config-get if needed
```

<if mode="yolo">
Auto-approve: `⚡ Execute {phase}-{plan}-PLAN.md [Plan X of Y for Phase Z]` → parse_segments.
</if>

<if mode="interactive" OR="custom with gates.execute_next_plan true">
Present plan identification, wait for confirmation.
</if>
</step>

<step name="record_start_time">
```bash
PLAN_START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PLAN_START_EPOCH=$(date +%s)
```
</step>

<step name="parse_segments">
```bash
# Count tasks — match <task tag at any indentation level
TASK_COUNT=$(grep -cE '^\s*<task[[:space:]>]' .planning/phases/XX-name/{phase}-{plan}-PLAN.md 2>/dev/null || echo "0")
INLINE_THRESHOLD=$(gsd_run query config-get workflow.inline_plan_threshold --raw 2>/dev/null || echo "2")
USE_WORKTREES=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null || echo "true")
RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")
HUMAN_VERIFY_MODE=$(gsd_run query config-get workflow.human_verify_mode --default end-of-phase --raw 2>/dev/null || echo "end-of-phase")
grep -n "type=\"checkpoint" .planning/phases/XX-name/{phase}-{plan}-PLAN.md
```

**Primary routing: task count threshold (#1979)**

If `INLINE_THRESHOLD > 0` AND `TASK_COUNT <= INLINE_THRESHOLD`: Use Pattern C (inline) regardless of checkpoint type. Small plans execute faster inline — avoids ~14K token subagent spawn overhead and preserves prompt cache. Configure threshold via `workflow.inline_plan_threshold` (default: 2, set to `0` to always spawn subagents).

Otherwise: Apply checkpoint-based routing below.

**Checkpoint-based routing (plans with > threshold tasks):**

| Checkpoints | Pattern | Execution |
|-------------|---------|-----------|
| None | A (autonomous) | Single subagent: full plan + SUMMARY + commit |
| Verify-only | B (segmented) | Segments between checkpoints. After none/human-verify → SUBAGENT. After decision/human-action → MAIN |
| Decision | C (main) | Execute entirely in main context |

**Resolve isolation now — AFTER the pattern is chosen, and only for a pattern that dispatches
(#2584/#2652).**

- **Pattern C: skip this entirely.** It executes inline in the main context and spawns no
  agent, so there is nothing to isolate. Running the gate here would abort an
  `isolation`-`none` host with a FATAL for a run that was never going to dispatch anything.
- **Pattern A:** read @gsd-core/references/dispatch-isolation-gate.md and run its
  `Resolve ISOLATION`, `Single-agent dispatch sites`, and `Resolve the harness flag` blocks in
  order; they set `ISOLATION`/`HARNESS_FLAG` via `query dispatch-isolation`. `ISOLATION` — not
  `RUNTIME` — gates the worktree decision. Substitute `{harnessFlag}` in Pattern A's `Agent()`
  with `$HARNESS_FLAG`+comma when `ISOLATION = "harness-worktree"`, else empty.
  `{harnessFlag}` is a template placeholder, not a shell variable.
- **Pattern B: segments are NOT isolated, and must record that before dispatching.** Each
  segment subagent continues on the working tree the previous segment left behind, so putting
  them in per-agent worktrees would break the sequence. Record `none` before the first segment
  dispatch, or the sentinel still asserts the phase-level `harness-worktree` and the #3045
  `PreToolUse` guard denies every segment dispatch with `exit 2`:

  ```bash
  ISOLATION=none
  gsd_run query dispatch-isolation --raw --force-isolation none >/dev/null 2>&1 || true
  ```

  Segment dispatches therefore carry no `{harnessFlag}`.

<!-- #2508 runtime-aware-dispatch -->

> **Runtime-aware dispatch (#2508 Phase 4).** GSD workflows dispatch specialized subagents by role. Before dispatching on a built-in-only runtime (kimi-code — three built-ins only), resolve the role to a built-in via `gsd_run query resolve-dispatch-type --requested <role> --raw`. On named-dispatch runtimes (Claude/OpenCode/…) the role is returned unchanged; on kimi-code it maps to `coder`/`explore`/`plan` by role-suffix. The persona rides `${AGENT_SKILLS_<ROLE>}` (Phase 3) regardless. See @gsd-core/references/runtime-aware-dispatch.md.

**Pattern A:** init_agent_tracking → capture `EXPECTED_BASE=$(git rev-parse HEAD)` → **before spawning, run the #2649 pre-dispatch worktree base-check** (mirrors execute-phase #683/#1369 and quick #1941): if `ISOLATION = "harness-worktree"`, run `gsd_run query worktree.base-check --mode "$ISOLATION" --pick shouldDegrade` (#3659: the mode is what stops `worktree.baseRef:"head"` from suppressing the comparison — the harness does not honor that setting); if it returns `true`, print its `--pick message` to stderr, emit the `⚠ [#2649] Worktree fork base diverged from orchestrator HEAD — auto-degrading to sequential mode for this plan to avoid a base-mismatch halt.` warning, and treat `ISOLATION` as `"none"` for this dispatch (spawn without `{harnessFlag}`), **then re-record the degrade before spawning** — run `gsd_run query dispatch-isolation --raw --force-isolation none >/dev/null 2>&1 || true`. That re-record is mandatory, not bookkeeping: the resolve step already persisted `harness-worktree` to the run-scoped sentinel, the degrade above happens where the resolver cannot see it, and the shipped `PreToolUse` isolation guard (#3045) reads that sentinel at the instant of the `Agent()` call — a stale `harness-worktree` against a dispatch that correctly omits `{harnessFlag}` is denied with `exit 2`, so the plan does not run at all. See `Re-record after every degrade` in `gsd-core/references/dispatch-isolation-gate.md`. Claude Code's `isolation="worktree"` forks from `origin/HEAD`, not live local HEAD; without this gate a plan whose commit advanced local HEAD past a stale `origin/HEAD` hits the verify-only guard's `exit 42` mid-execution with no auto-degrade. → print `Spawning executor agent (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)` → spawn Agent(subagent_type="gsd-executor", model=executor_model) with prompt: execute plan at [path], autonomous, all tasks + SUMMARY + commit, follow deviation/auth rules, honor checkpoint gate semantics (#3370) — gate="blocking" (the default) is auto-approvable in auto-mode per the executor's own checkpoint protocol, gate="blocking-human" always surfaces to a human; add no instruction overriding that protocol — report: plan name, tasks, SUMMARY path, commit hash → track agent_id → wait → update tracking → report. **Include `{harnessFlag}` only when `ISOLATION = "harness-worktree"` and the #2649 base-check did not degrade** — never hardcode `isolation="worktree"`, which is Claude Code's own literal and wrong on any other harness-worktree host. **When dispatching with `{harnessFlag}`, embed the `<worktree_branch_check>` block from `gsd-core/references/worktree-branch-check.md` into the prompt, substituting `{EXPECTED_BASE}` with the captured base SHA.** That guard is **verify-only and fail-closed** (#48) and stays active as a backstop whether or not the base-check degraded: it asserts a per-agent `agent-*` / `worktree-agent-*` branch and the exact base, forbids `git update-ref` self-recovery (#2924), and on any mismatch prints `FATAL:` and `exit 42` so the orchestrator can recover — the sub-agent never rewrites a worktree it did not create. This supersedes the former self-recovery (#2015), whose destructive base rewrite could fail silently under a deny rule; the base-drift it addressed affects all platforms, and base correction is now the orchestrator's responsibility.

**Pattern B:** Execute segment-by-segment. Autonomous segments: spawn subagent for assigned tasks only (no SUMMARY/commit). Checkpoints: main context. After all segments: aggregate, create SUMMARY, commit. See segment_execution. **Segments run unisolated on the main working tree by design** — each continues where the previous one stopped — so dispatch them WITHOUT `{harnessFlag}`, and only after the `ISOLATION=none` re-record above has run (#2652/#3045).

**Pattern C:** Execute in main using standard flow (step name="execute").

Fresh context per subagent preserves peak quality. Main context stays lean.
</step>

<step name="init_agent_tracking">
```bash
if [ ! -f .planning/agent-history.json ]; then
  echo '{"version":"1.0","max_entries":50,"entries":[]}' > .planning/agent-history.json
fi
# #3795: read a SURVIVING id before clearing it — the clear used to run
# first, so the check below was always false and the resume prompt at this
# step's tail was never offered.
if [ -f .planning/current-agent-id.txt ]; then
  INTERRUPTED_ID=$(cat .planning/current-agent-id.txt)
  echo "Found interrupted agent: $INTERRUPTED_ID"
fi
rm -f .planning/current-agent-id.txt
```

If interrupted: ask user to resume (Task `resume` parameter) or start fresh.

**Tracking protocol:** On spawn: write agent_id to `current-agent-id.txt`, append to agent-history.json: `{"agent_id":"[id]","task_description":"[desc]","phase":"[phase]","plan":"[plan]","segment":[num|null],"timestamp":"[ISO]","status":"spawned","completion_timestamp":null}`. On completion: status → "completed", set completion_timestamp, delete current-agent-id.txt. Prune: if entries > max_entries, remove oldest "completed" (never "spawned").

Run for Pattern A/B before spawning. Pattern C: skip.
</step>

<step name="segment_execution">
Pattern B only (verify-only checkpoints). Skip for A/C.

1. Parse segment map: checkpoint locations and types
2. Per segment:
   - Subagent route: spawn gsd-executor for assigned tasks only. Prompt: task range, plan path, read full plan for context, execute assigned tasks, track deviations, NO SUMMARY/commit. Track via agent protocol.
   - Main route: execute tasks using standard flow (step name="execute")
3. **Critical ordering — write and commit SUMMARY.md as one atomic block.** Do NOT
   emit narrative output between the Write tool call and the commit tool call.
   Truncation at this boundary is a known failure mode (see #2070 rescue logic in
   execute-phase.md step 5.5).

   After ALL segments: aggregate files/deviations/decisions → create SUMMARY.md → self-check:
   - Verify key-files.created exist on disk with `[ -f ]`
   - Check `git log --oneline --all --grep="{phase}-{plan}"` returns ≥1 commit
   - Re-run ALL `<acceptance_criteria>` from every task — if any fail, fix before finalizing SUMMARY
   - Re-run the plan-level `<verification>` commands — log results in SUMMARY
   - Append `## Self-Check: PASSED` or `## Self-Check: FAILED` to SUMMARY
   Then commit (no narrative between Write and commit).

   **Known Claude Code bug (classifyHandoffIfNeeded):** If any segment agent reports "failed" with `classifyHandoffIfNeeded is not defined`, this is a Claude Code runtime bug — not a real failure. Run spot-checks; if they pass, treat as successful.

</step>

<step name="load_prompt">
```bash
cat .planning/phases/XX-name/{phase}-{plan}-PLAN.md
```
This IS the execution instructions. Follow exactly. If plan references CONTEXT.md: honor user's vision throughout.

**If plan contains `<interfaces>` block:** These are pre-extracted type definitions and contracts. Use them directly — do NOT re-read the source files to discover types. The planner already extracted what you need.
</step>

<step name="previous_phase_check">
```bash
gsd_run query phases.list --type summaries --raw
# Extract the second-to-last summary from the JSON result
```

**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
If previous SUMMARY has unresolved "Issues Encountered" or "Next Phase Readiness" blockers: AskUserQuestion(header="Previous Issues", options: "Proceed anyway" | "Address first" | "Review previous").
</step>

<step name="execute">
Deviations are normal — handle via rules below.

1. Read @context files from prompt
2. **MCP tools:** If CLAUDE.md or project instructions reference MCP tools (e.g. jCodeMunch for code navigation), prefer them over Grep/Glob when available. Fall back to Grep/Glob if MCP tools are not accessible.
3. Per task:
   - **Task-content resolution:** If this task is NOT `type="checkpoint:*"` AND it carries a `tracker-id` attribute, run `gsd_run task resolve-content --plan "<plan path>" --task-id "<tracker-id>" --raw` BEFORE anything else for this task — before the read_first gate below, since read_first is itself a field this call can resolve. A `type="checkpoint:*"` task NEVER enters this resolution, regardless of whether it carries a `tracker-id` attribute — its interactive structure always stays sourced from PLAN.md (ADR-3646 Decision 1); see the `type="checkpoint:*"` bullet below. A **non-zero exit is a HARD HALT**: surface the tracker-id, the tracker prefix, and the command's stderr, and STOP — do NOT proceed to read this task's inline PLAN.md content as a fallback (that defeats the point of the seam: see ADR-3646). On exit 0 with `resolved: true`, the returned `content` object SUPERSEDES this task's `<read_first>`/`<action>`/`<verify>`/`<acceptance_criteria>`/`<done>` for every remaining bullet in this step — every gate below reads from the resolved content instead of PLAN.md. On exit 0 with `resolved: false` (for any `reason`), proceed exactly as today and read the task's inline PLAN.md content. A task with no `tracker-id` attribute, or a checkpoint task, is unaffected — this step is unconditional but resolves to a no-op instantly for the common case.
   - **MANDATORY read_first gate:** If the task has a `<read_first>` field (or the resolved content carries one), you MUST read every listed file BEFORE making any edits. This is not optional. Do not skip files because you "already know" what's in them — read them. The read_first files establish ground truth for the task.
   - `type="auto"`: if `tdd="true"` → TDD execution. Implement with deviation rules + auth gates. Verify done criteria. Commit (see task_commit). Track hash for Summary.
   - `type="tracer"`: execute like `type="auto"` (production-quality, real `<verify>`, commit), then run the tracer feedback gate BEFORE any expansion task — an early integration checkpoint. Evaluate in order (#3299). First, `gate="blocking-human"` → STOP → return a `checkpoint:human-verify` via checkpoint_protocol — every mode, auto included (golden rule 6, checkpoints.md). Next, Auto mode active (`AUTO_CHAIN` or `AUTO_CFG`): re-run the tracer `<verify>`; on failure HALT and surface (deviation) — do NOT start expansion tasks. Next, `HUMAN_VERIFY_MODE` is `end-of-phase` (default) AND the tracer's `<verify>` carries only `<automated>` (no `<human-check>`) → re-run the tracer `<verify>`; on failure HALT and surface as a deviation exactly as in the auto-mode branch — never a checkpoint; on success log `⚡ Tracer verified end-to-end — expanding` and continue to expansion, do NOT synthesize a checkpoint. Otherwise (`mid-flight`, or the tracer carries genuine human-observable evidence) → STOP → return a `checkpoint:human-verify` for the tracer via checkpoint_protocol before expansion.
   - `type="checkpoint:*"`: STOP → checkpoint_protocol → wait for user → continue only after confirmation.
   - **HARD GATE — acceptance_criteria verification:** After completing each task, if it has `<acceptance_criteria>` (inline or resolved), you MUST run a verification loop before proceeding:
     1. For each criterion: execute the grep, file check, or CLI command that proves it passes
     2. Log each result as PASS or FAIL with the command output
     3. If ANY criterion fails: fix the implementation immediately, then re-run ALL criteria
     4. Repeat until all criteria pass — you are BLOCKED from starting the next task until this gate clears
     5. If a criterion cannot be satisfied after 2 fix attempts, log it as a deviation with reason — do NOT silently skip it
     This is not advisory. A task with failing acceptance criteria is an incomplete task.
3. Run `<verification>` checks
4. Confirm `<success_criteria>` met
5. Document deviations in Summary
</step>

<authentication_gates>

## Authentication Gates

Auth errors during execution are NOT failures — they're expected interaction points.

**Indicators:** "Not authenticated", "Unauthorized", 401/403, "Please run {tool} login", "Set {ENV_VAR}"

**Protocol:**
1. Recognize auth gate (not a bug)
2. STOP task execution
3. Create dynamic checkpoint:human-action with exact auth steps
4. Wait for user to authenticate
5. Verify credentials work
6. Retry original task
7. Continue normally

**Example:** `vercel --yes` → "Not authenticated" → checkpoint asking user to `vercel login` → verify with `vercel whoami` → retry deploy → continue

**In Summary:** Document as normal flow under "## Authentication Gates", not as deviations.

</authentication_gates>

<deviation_rules>

## Deviation Rules

Apply deviation rules from the gsd-executor agent definition (single source of truth):
- **Rules 1-3** (bugs, missing critical, blockers): auto-fix, test, verify, track as deviations
- **Rule 4** (architectural changes): STOP, present decision to user, await approval
- **Scope boundary**: do not auto-fix pre-existing issues unrelated to current task
- **Fix attempt limit**: max 3 retries per deviation before escalating
- **Priority**: Rule 4 (STOP) > Rules 1-3 (auto) > unsure → Rule 4

</deviation_rules>

<deviation_documentation>

## Documenting Deviations

Summary MUST include deviations section. None? → `## Deviations from Plan\n\nNone - plan executed exactly as written.`

Per deviation: **[Rule N - Category] Title** — Found during: Task X | Issue | Fix | Files modified | Verification | Commit hash

End with: **Total deviations:** N auto-fixed (breakdown). **Impact:** assessment.

</deviation_documentation>

<tdd_plan_execution>
## TDD Execution

For `type: tdd` plans — RED-GREEN-REFACTOR:

1. **Infrastructure** (first TDD plan only): detect project, install framework, config, verify empty suite
2. **Cycle (#3990: stated ONCE; #4267: cited correctly):** execute RED → GREEN → REFACTOR
exactly as specified in the canonical `~/.claude/gsd-core/references/tdd.md` reference — the
"Red-Green-Refactor Cycle" section's commit-scope contract (`test({phase}-{plan})` →
`feat({phase}-{plan})` → `refactor({phase}-{plan})`, RED must fail, GREEN must pass, REFACTOR
commits only on change), the "Gate Enforcement Rules" section's "Fail-Fast Rules" subsection,
and the "Error Handling" section. The reference is the single source; do not improvise a
variant.
</tdd_plan_execution>

<precommit_failure_handling>
## Pre-commit Hook Failure Handling

Your commits may trigger pre-commit hooks. Auto-fix hooks handle themselves transparently — files get fixed and re-staged automatically.

**If running as a parallel executor agent (spawned by execute-phase):**
Run commits normally — let pre-commit hooks run. Do NOT use `--no-verify` by default
(#2924). Hooks should run so issues surface at the introducing commit, and silent
bypass violates project CLAUDE.md guidance. If a project explicitly opts out via
`workflow.worktree_skip_hooks=true`, the orchestrator will surface that flag in the
prompt; absent that signal, hooks run normally. If a hook fails, follow the
sequential-mode handling below.

**If running as the sole executor (sequential mode):**
If a commit is BLOCKED by a hook:

1. The `git commit` command fails with hook error output
2. Read the error — it tells you exactly which hook and what failed
3. Fix the issue (type error, lint violation, secret leak, etc.)
4. `git add` the fixed files
5. Retry the commit
6. Budget 1-2 retry cycles per commit
</precommit_failure_handling>

<task_commit>
## Task Commit Protocol

Canonical per-task commit rules live in **`agents/gsd-executor.md`** (`<task_commit_protocol>`). Follow that section for staging, `{type}({phase}-{plan})` messages, `commit-to-subrepo` when `sub_repos` is set, post-commit checks, and untracked-file handling — do not duplicate or paraphrase the full protocol here (single source of truth).

**Orchestrator note:** After each task, the spawned executor reports commit hashes; this workflow does not re-specify commit semantics beyond pointing at the executor.

</task_commit>

<step name="checkpoint_protocol">
On `type="checkpoint:*"`: automate everything possible first. Checkpoints are for verification/decisions only.

Display: `### CHECKPOINT: [Type]` heading → Progress {X}/{Y} → Task name → type-specific content → `---` → `**YOUR ACTION: [signal]**`

| Type | Content | Resume signal |
|------|---------|---------------|
| human-verify (90%) | What was built + verification steps (commands/URLs) | "approved" or describe issues |
| decision (9%) | Decision needed + context + options with pros/cons | "Select: option-id" |
| human-action (1%) | What was automated + ONE manual step + verification plan | "done" |

After response: verify if specified. Pass → continue. Fail → inform, wait. WAIT for user — do NOT hallucinate completion.

See ~/.claude/gsd-core/references/checkpoints.md for details.
</step>

<step name="checkpoint_return_for_orchestrator">
When spawned via Task and hitting checkpoint: return structured state (cannot interact with user directly).

**Required return:** 1) Completed Tasks table (hashes + files) 2) Current Task (what's blocking) 3) Checkpoint Details (user-facing content) 4) Awaiting (what's needed from user)

Orchestrator parses → presents to user → spawns fresh continuation with your completed tasks state. You will NOT be resumed. In main context: use checkpoint_protocol above.
</step>

<step name="verification_failure_gate">
If verification fails:

**Check if node repair is enabled** (default: on):
```bash
NODE_REPAIR=$(gsd_run query config-get workflow.node_repair --raw 2>/dev/null || echo "true")
```

If `NODE_REPAIR` is `true`: invoke `@./.claude/gsd-core/workflows/node-repair.md` with:
- FAILED_TASK: task number, name, done-criteria
- ERROR: expected vs actual result
- PLAN_CONTEXT: adjacent task names + phase goal
- REPAIR_BUDGET: `workflow.node_repair_budget` from config (default: 2)

Node repair will attempt RETRY, DECOMPOSE, or PRUNE autonomously. Only reaches this gate again if repair budget is exhausted (ESCALATE).

If `NODE_REPAIR` is `false` OR repair returns ESCALATE: STOP. Present: "Verification failed for Task [X]: [name]. Expected: [criteria]. Actual: [result]. Repair attempted: [summary of what was tried]." Options: Retry | Skip (mark incomplete) | Stop (investigate). If skipped → SUMMARY "Issues Encountered".
</step>

<step name="record_completion_time">
```bash
PLAN_END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PLAN_END_EPOCH=$(date +%s)

DURATION_SEC=$(( PLAN_END_EPOCH - PLAN_START_EPOCH ))
DURATION_MIN=$(( DURATION_SEC / 60 ))

if [[ $DURATION_MIN -ge 60 ]]; then
  HRS=$(( DURATION_MIN / 60 ))
  MIN=$(( DURATION_MIN % 60 ))
  DURATION="${HRS}h ${MIN}m"
else
  DURATION="${DURATION_MIN} min"
fi
```
</step>

<step name="generate_user_setup">
```bash
grep -A 50 "^user_setup:" .planning/phases/XX-name/{phase}-{plan}-PLAN.md | head -50
```

If user_setup exists: create `{phase}-USER-SETUP.md` using template `~/.claude/gsd-core/templates/user-setup.md`. Per service: env vars table, account setup checklist, dashboard config, local dev notes, verification commands. Status "Incomplete". Set `USER_SETUP_CREATED=true`. If empty/missing: skip.
</step>

<step name="create_summary">
**Critical ordering — write and commit SUMMARY.md as one atomic block.** Do NOT
emit narrative output between the Write tool call and the commit tool call.
Truncation at this boundary is a known failure mode (see #2070 rescue logic in
execute-phase.md step 5.5).

Create `{phase}-{plan}-SUMMARY.md` at `.planning/phases/XX-name/`. Use `~/.claude/gsd-core/templates/summary.md`.

**Frontmatter:** phase, plan, subsystem, tags | requires/provides/affects | tech-stack.added/patterns | key-files.created/modified | key-decisions | requirements-completed (**MUST** copy `requirements` array from PLAN.md frontmatter verbatim) | duration ($DURATION), completed ($PLAN_END_TIME date).

**Coverage block (#1602):** Populate the `coverage:` frontmatter block — one entry per shipped deliverable (the structured form of each `## Accomplishments` bullet). For each deliverable, aggregate the task-level `<verify>` results and tests:
- A task whose `<verify>` command passed or whose matching test passed → a `verification` entry with `kind` + `ref` (`tests/path#name`, Playwright screenshot ref, or command) + `status: pass`, and `human_judgment: false`.
- A judgment-dependent deliverable (UX adequacy, external/multi-session behavior, anything no test asserts) → `human_judgment: true` with a `rationale`.
- **Every deliverable MUST be classified.** If you cannot determine coverage, default to `human_judgment: true` with `rationale: "Coverage not determined at authoring time — verifier must classify"`. Never set `human_judgment: false` without a non-empty all-`pass` `verification` — `verify-work` auto-passes (skips the human) ONLY on that proof, so an unproven `false` still routes to the human but loses the audit trail. Omit the whole block only for a genuinely prose-only SUMMARY (verify-work then uses the legacy `## Accomplishments` path). The block is validated downstream by `gsd-tools uat classify-coverage`.

Title: `# Phase [X] Plan [Y]: [Name] Summary`

One-liner SUBSTANTIVE: "JWT auth with refresh rotation using jose library" not "Authentication implemented"

Include: duration, start/end times, task count, file count.

Next: more plans → "Ready for {next-plan}" | last → "Phase complete, ready for next step".
</step>

<step name="update_current_position">
**Skip this step if running in parallel mode** (the orchestrator in execute-phase.md
handles STATE.md/ROADMAP.md updates centrally after merging worktrees to avoid
merge conflicts).

Update STATE.md using gsd_run query (or legacy gsd-tools) state mutations:

```bash
# Auto-detect parallel mode: .git is a file in worktrees, a directory in main repo
IS_WORKTREE=$([ -f .git ] && echo "true" || echo "false")

# Skip in parallel mode — orchestrator handles STATE.md centrally
if [ "$IS_WORKTREE" != "true" ]; then
  # Advance plan counter (handles last-plan edge case)
  gsd_run query state.advance-plan

  # Recalculate progress bar from disk state
  gsd_run query state.update-progress

  # Record execution metrics
  gsd_run query state.record-metric \
    --phase "${PHASE}" --plan "${PLAN}" --duration "${DURATION}" \
    --tasks "${TASK_COUNT}" --files "${FILE_COUNT}"
fi
```
</step>

<step name="extract_decisions_and_issues">
From SUMMARY: Extract decisions and add to STATE.md:

```bash
# Add each decision from SUMMARY key-decisions
# Prefer file inputs for shell-safe text (preserves `$`, `*`, etc. exactly)
gsd_run query state.add-decision \
  --phase "${PHASE}" --summary-file "${DECISION_TEXT_FILE}" --rationale-file "${RATIONALE_FILE}"

# Add blockers if any found
gsd_run query state.add-blocker --text-file "${BLOCKER_TEXT_FILE}"
```
</step>

<step name="update_session_continuity">
Update session info using gsd_run query (or legacy gsd-tools):

```bash
gsd_run query state.record-session \
  --stopped-at "Completed ${PHASE}-${PLAN}-PLAN.md" \
  --resume-file "None"
```

Keep STATE.md under 150 lines.
</step>

<step name="issues_review_gate">
If SUMMARY "Issues Encountered" ≠ "None": yolo → log and continue. Interactive → present issues, wait for acknowledgment.
</step>

<step name="update_roadmap">
Run this step only when NOT executing inside a git worktree (i.e.
`use_worktrees: false`, the bug #2661 reproducer). In worktree mode each
worktree has its own ROADMAP.md, so per-plan writes here would diverge
across siblings; the orchestrator owns the post-merge sync centrally
(see execute-phase.md §5.7, single-writer contract from #1486 / dcb50396).

```bash
# Auto-detect worktree mode: .git is a file in worktrees, a directory in main repo.
# This mirrors the use_worktrees config flag for the executing handler.
IS_WORKTREE=$([ -f .git ] && echo "true" || echo "false")

if [ "$IS_WORKTREE" != "true" ]; then
  # use_worktrees: false → this handler is the sole post-plan sync point (#2661)
  gsd_run query roadmap.update-plan-progress "${PHASE}"
fi
```
Counts PLAN vs SUMMARY files on disk. Updates progress table row with correct count and status (`In Progress` or `Complete` with date).
</step>

<step name="update_requirements">
Mark completed requirements from the PLAN.md frontmatter `requirements:` field.

Extract requirement IDs from the plan's frontmatter (e.g., `requirements: [AUTH-01, AUTH-02]`) into `REQ_IDS`. If no requirements field, skip this step.

**Shared-ID gate (#2388):** a requirement ID declared by more than one plan in this phase must not read `Complete` until every plan declaring it has finished (produced a `*-SUMMARY.md`) — otherwise the first plan to finish flips it `Complete` while its sibling plans are still running, before phase verification ever gets a chance to catch a real gap. Compute the ready subset first, then mark only those:

```bash
READY=$(gsd_run query requirements.ready-ids "${PLAN_PATH}" ${REQ_IDS} --raw)
READY_IDS=$(printf '%s' "$READY" | jq -r '.ready[]' 2>/dev/null | tr '\n' ' ')
if [ -n "$(printf '%s' "$READY_IDS" | tr -d '[:space:]')" ]; then
  gsd_run query requirements.mark-complete ${READY_IDS}
fi
```

`requirements.ready-ids` is read-only: it scans sibling `*-PLAN.md` files in this plan's phase directory and blocks an ID only when a sibling ALSO declares it and that sibling has no `*-SUMMARY.md` yet. An ID no sibling declares is always ready (single-plan requirements mark immediately, no added latency). A blocked ID is re-evaluated the next time any plan in this phase finishes its own `update_requirements` step, and becomes ready once the LAST declaring plan's SUMMARY exists.
</step>

<step name="git_commit_metadata">
**Critical ordering — write and commit SUMMARY.md as one atomic block.** Do NOT
emit narrative output between the Write tool call and the commit tool call.
Truncation at this boundary is a known failure mode (see #2070 rescue logic in
execute-phase.md step 5.5).

Task code already committed per-task. Commit plan metadata:

```bash
# Auto-detect parallel mode: .git is a file in worktrees, a directory in main repo
IS_WORKTREE=$([ -f .git ] && echo "true" || echo "false")

# In parallel mode: exclude STATE.md and ROADMAP.md (orchestrator commits these)
if [ "$IS_WORKTREE" = "true" ]; then
  gsd_run query commit "docs({phase}-{plan}): complete [plan-name] plan" --files .planning/phases/XX-name/{phase}-{plan}-SUMMARY.md .planning/REQUIREMENTS.md
else
  gsd_run query commit "docs({phase}-{plan}): complete [plan-name] plan" --files .planning/phases/XX-name/{phase}-{plan}-SUMMARY.md .planning/STATE.md .planning/ROADMAP.md .planning/REQUIREMENTS.md
fi
```
</step>

<step name="update_codebase_map">
If .planning/codebase/ doesn't exist: skip.

```bash
FIRST_TASK=$(git log --oneline --grep="feat({phase}-{plan}):" --grep="fix({phase}-{plan}):" --grep="test({phase}-{plan}):" --reverse | head -1 | cut -d' ' -f1)
git diff --name-only ${FIRST_TASK}^..HEAD 2>/dev/null || true
```

Update only structural changes: new src/ dir → STRUCTURE.md | deps → STACK.md | file pattern → CONVENTIONS.md | API client → INTEGRATIONS.md | config → STACK.md | renamed → update paths. Skip code-only/bugfix/content changes.

```bash
gsd_run query commit "" --files .planning/codebase/*.md --amend
```
</step>

<step name="offer_next">
If `USER_SETUP_CREATED=true`: display `⚠️ USER SETUP REQUIRED` with path + env/config tasks at TOP.

Get plan/summary counts for the current phase from the single owner (#3218 — LIVE
counts, i.e. `status: superseded` plans excluded, matching this route's
"outstanding work" question):

```bash
PHASE_COUNTS=$(gsd_run query find-phase "${PHASE}")
PLAN_COUNT=$(echo "$PHASE_COUNTS" | jq -r '.plan_count // 0')
SUMMARY_COUNT=$(echo "$PHASE_COUNTS" | jq -r '.summary_count // 0')
```

| Condition | Route | Action |
|-----------|-------|--------|
| summaries < plans | **A: More plans** | Find next PLAN without SUMMARY — skip any plan whose `plan_id` matches a non-terminal async-job manifest (`external_job_waiting`; see `identify_plan`). Yolo: auto-continue. Interactive: show next plan, suggest `/gsd:execute-phase {phase}` + `/gsd:verify-work`. STOP here. |
| summaries = plans, current < highest phase | **B: Phase done** | Show completion, suggest `/gsd:plan-phase {Z+1}` + `/gsd:verify-work {Z}` + `/gsd:discuss-phase {Z+1}` |
| summaries = plans, current = highest phase | **C: Milestone done** | Show banner, suggest `/gsd:complete-milestone` + `/gsd:verify-work` + `/gsd-add-phase` |

All routes: `/clear` first for fresh context.
</step>

</process>

<success_criteria>

- All tasks from PLAN.md completed
- All verifications pass
- USER-SETUP.md generated if user_setup in frontmatter
- SUMMARY.md created with substantive content
- STATE.md updated (position, decisions, issues, session) — unless parallel mode (orchestrator handles)
- ROADMAP.md updated — unless parallel mode (orchestrator handles)
- If codebase map exists: map updated with execution changes (or skipped if no significant changes)
- If USER-SETUP.md created: prominently surfaced in completion output
</success_criteria>

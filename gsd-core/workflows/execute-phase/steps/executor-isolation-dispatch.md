# Executor isolation dispatch (ADR-1239 / #2584 Phase 3)

Read and follow this fragment from `execute-phase.md` step 3 when dispatching a wave.
It owns the per-host dispatch detail so the host workflow stays inside its
ADR-857 Phase 6 byte budget (#1168) — the host step keeps only the `ISOLATION`
resolution and its fail-closed guard.

## Resolve ISOLATION

The resolution rule is shared with every other dispatch site — see
@gsd-core/references/dispatch-isolation-gate.md, the canonical statement of the
`ISOLATION`-not-`RUNTIME` contract (#2652). This fragment keeps the wave-specific
extras (`worktree.reap-orphans`, the `worktree.base-check` auto-degrade) inline below.

Run this in the config-gate step, right after `RUNTIME`/`USE_WORKTREES` are read.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# Isolation is a NEGOTIATED CAPABILITY, not a runtime id (#2584). Fail-closed to none.
# #3045 CORE REDESIGN: `dispatch-isolation` PERSISTS this resolution to the
# run-scoped sentinel the isolation guard hooks read, as an unconditional
# side effect of resolving it — this call is the ONLY way the workflow learns
# ISOLATION at all, so the recording cannot be skipped the way a separate
# "and now also run this to record it" prose instruction could be. `--phase`
# threads the phase identifier into that same atomic write (mode + harnessFlag
# + phase together — see hooks/lib/isolation-sentinel.js for how the guards
# consume it).
# Keep the resolver's own failure DISTINGUISHABLE from a genuine `none`, exactly
# as references/dispatch-isolation-gate.md does — this site declares that gate
# canonical, so it must not carry the older collapsing shape. Both outcomes fail
# closed, which is right, but only one of them may claim the host declared no
# primitive (#2652 review).
_ISOLATION_RAW=$(gsd_run query dispatch-isolation --raw --phase "${PHASE_NUMBER:-}" 2>/dev/null)
_ISOLATION_RC=$?
if [ $_ISOLATION_RC -ne 0 ] || [ -z "$_ISOLATION_RAW" ]; then
  ISOLATION=none
  ISOLATION_RESOLVED=false      # fail closed, but we did NOT learn a verdict
else
  ISOLATION="$_ISOLATION_RAW"
  ISOLATION_RESOLVED=true
fi
case "$ISOLATION" in
  harness-worktree|orchestrator-worktree|none) ;;
  *) ISOLATION=none; ISOLATION_RESOLVED=false ;;   # out of vocabulary is not a verdict either
esac

# Project-level opt-out wins on every host; a host with no primitive fails closed.
[ "$USE_WORKTREES" = "false" ] && ISOLATION=none
if [ "$ISOLATION" = "none" ] && [ "$USE_WORKTREES" != "false" ]; then
  if [ "$ISOLATION_RESOLVED" = "true" ]; then
    echo "FATAL: runtime '$RUNTIME' declares no executor-isolation primitive (dispatch.isolation=none) — executors would run unisolated against the main checkout. Set workflow.use_worktrees=false." >&2
  else
    echo "FATAL: could not resolve this runtime's executor-isolation capability — 'gsd_run query dispatch-isolation' failed or returned nothing, so GSD cannot tell whether isolation is available. Refusing to dispatch rather than guess (a guard that cannot verify must not answer 'safe'). Re-run once the gsd-tools shim resolves, or set workflow.use_worktrees=false to run sequentially on purpose." >&2
  fi
  exit 1
fi

# Sweep orphaned locked worktrees from prior crashed sessions (#3707).
[ "$ISOLATION" != "none" ] && gsd_run query worktree.reap-orphans 2>/dev/null || true
# Auto-degrade if HEAD diverged from the fork base (#683) — both isolation models.
if [ "$ISOLATION" != "none" ]; then
  _SHOULD_DEGRADE=$(gsd_run query worktree.base-check --mode "$ISOLATION" --pick shouldDegrade 2>/dev/null || true)
  if [ "$_SHOULD_DEGRADE" = "true" ]; then
    _DEGRADE_MSG=$(gsd_run query worktree.base-check --mode "$ISOLATION" --pick message 2>/dev/null || true)
    [ -n "$_DEGRADE_MSG" ] && printf '%s\n' "$_DEGRADE_MSG" >&2
    USE_WORKTREES=false
    ISOLATION=none
  fi
fi

# Re-resolve (and, as a side effect, re-persist) now that the base-check
# auto-degrade above may have changed $ISOLATION since the first
# `dispatch-isolation` call. `--force-isolation` pushes the FINAL,
# shell-computed value (which the resolver itself cannot see — the #683
# base-check degrade is decided here, not inside gsd-tools.cjs) through the
# SAME single write path (`--force-isolation none` also clears the stored
# harnessFlag, since none applies to sequential dispatch). The isolation
# guard hooks (hooks/gsd-agent-isolation-guard.js,
# hooks/gsd-cursor-subagent-start.js) read this sentinel instead of
# re-deriving a host CAPABILITY from the registry — the registry's
# harness-worktree entry means "this host CAN isolate", not "this dispatch
# SHOULD be isolated", and every degrade above (project opt-out, the #683
# base-check auto-degrade) is a legitimate ISOLATION=none outcome the guards
# must not treat as a bypass. Best-effort: a write failure here must never
# fail the wave — the guards' own sentinel-absent fallback is safe, just less
# precise.
gsd_run query dispatch-isolation --raw --phase "${PHASE_NUMBER:-}" --force-isolation "$ISOLATION" >/dev/null 2>&1 || true
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
# #3045 CORE REDESIGN: `dispatch-isolation --json` already resolves and
# atomically records `harnessFlag` together with `isolation` and `phase` in
# ONE write, as a side effect of this same call (routeDispatchIsolation,
# gsd-core/bin/gsd-tools.cjs) — there is no separate "now also record the
# flag" step, and therefore no flagless window between recording the mode and
# recording the flag.
HARNESS_FLAG=$(gsd_run query dispatch-isolation --json --phase "${PHASE_NUMBER:-}" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j&&j.harnessFlag?j.harnessFlag:"")}catch{process.stdout.write("")}})')
[ -n "$HARNESS_FLAG" ] || { echo "FATAL: runtime declares dispatch.isolation=harness-worktree but no harnessIsolationFlag — refusing to dispatch executors that would believe they are isolated." >&2; exit 1; }
```

Substitute `$HARNESS_FLAG`'s value for the `{harnessFlag}` placeholder in the `Agent()` dispatch
in `execute-phase.md` step 3 (on Claude Code it is literally `isolation="worktree"`).

## orchestrator-worktree — GSD creates the worktree and spawns the executor

The host has no harness-native isolation primitive, so **GSD** creates each worktree and process-spawns the executor into it. Fan-out is OS-level (N processes), not the host's subagent tool. Per the Codex `workspace-write` sandbox constraint, **the orchestrator performs every git operation** — create, merge, cleanup; the spawned executor only edits files and commits inside its own worktree.

Run the loop below once per runnable plan in the wave, **one plan at a time** (`git worktree add` races on `.git/config.lock`).

**Before running the bash block, substitute the plan's identifiers into it** exactly as you do for the `Agent()` prompt on the harness path: replace `{plan_number}` and `{phase_number}` with this plan's values. They are template placeholders, not shell variables. `$ORCH_ROOT` and `$EXPECTED_BASE` are real shell variables, already assigned earlier in this step; `$WAVE_WORKTREE_MANIFEST` was initialized above.

First build the executor prompt. It is the **same prompt text the harness path's `Agent()` call uses** — same executor identity, same execution context, same required-reading contract — with only the harness-only framing removed: drop the `<worktree_branch_check>` build-time embed note (this backend pins the base itself via `worktree create --base` and verifies it at merge) and the `<parallel_execution>` harness block (its SUMMARY-commit semantics ride inside the embedded `execute-plan.md` worktree mode). Keep `<objective>`, `<execution_context>`, `<required_reading>`, `${AGENT_SKILLS}`, and `<success_criteria>` from the harness prompt — substituting the worktree-specific `<execution_context>` framing below. The checkpoint gate rule (#3370, in `per-plan-executor-routing.md`) applies here too: add no prompt text refusing or overriding auto-approval for the default `gate="blocking"` — only `blocking-human` always surfaces.

#3637: the process-spawned child has NO host subagent machinery — nothing loads the `gsd-executor` agent definition or the execute-plan workflow unless THIS prompt carries them. A short objective-only prompt forces the child to reconstruct its role from the repository (skill discovery, inference) and leaves it unaware of the gitignored-planning skip semantics, which is how executors ended up force-staging gitignored `SUMMARY.md` files to satisfy an unconditional commit criterion. Build-time embeds below are therefore MANDATORY, and the resolution check after the assignment fails closed: if any embed source cannot be read, do NOT spawn a generic process and hope — halt the wave (the fail-closed check after `dispatch-isolation` handles the worktree teardown).

Assign the composed prompt to a shell variable so it can be passed as one argument:

```bash
# Compose the executor prompt for THIS plan. Single-quoted multi-line
# assignment (NOT a heredoc): these blocks are indented inside the workflow,
# and a heredoc terminator must sit at column 0 — `<<-` strips only tabs, not
# the leading spaces, so a heredoc here would never terminate. Single quotes
# also stop the shell expanding anything in the prompt body — the prompt MUST
# contain no single-quote character.
#
# ORCHESTRATOR BUILD-TIME EMBEDS (do these BEFORE the spawn, in order):
#   1. Inline each file listed in <execution_context> verbatim, in order.
#      An unreadable source file is a halt condition (#3637 fail-closed),
#      never a skip — a child without these texts is not a gsd-executor.
#   2. Substitute this plan's {plan_number}, {phase_number}, {phase_name},
#      {phase_dir}, and {plan_file} placeholders (same values the harness
#      path substitutes into its Agent() prompt).
#   3. Inline the gsd-executor ROLE DEFINITION: read `agents/gsd-executor.md`
#      (resolved against the install root the same way the harness runtime
#      resolves subagent types) and inline it verbatim at the provenance
#      marker below. The agent-skills query alone is NOT sufficient — its
#      block is the skills include list whenever the project configures
#      agent_skills for gsd-executor, and only an UNCONFIGURED non-Claude
#      project gets the full agent file via the #2454 fallback. The child has
#      no host subagent machinery, so the role definition must ride the prompt
#      (#3637 acceptance: resolved agent instructions as launch-level
#      instructions + provenance of which role definition was used).
# Resolve TDD-applicability for THIS plan (#4266/#4272) — fail closed on
# command failure, mirroring the ISOLATION resolution above: an absent
# verdict must never silently resolve to "not TDD" (ADR-3473 §8.4), since
# that would silently drop a real TDD plan's RED/GREEN/REFACTOR procedure.
_TDD_APPLICABLE_RAW=$(gsd_run query phase.tdd-applicable "{phase_dir}/{plan_file}" --pick applicable 2>/dev/null)
_TDD_APPLICABLE_RC=$?
if [ $_TDD_APPLICABLE_RC -ne 0 ]; then
  echo "FATAL: could not resolve TDD-applicability for plan {plan_number} — 'gsd_run query phase.tdd-applicable' failed. Refusing to guess whether this dispatch needs the TDD procedure. Halting." >&2
  exit 1
fi
TDD_APPLICABLE="$_TDD_APPLICABLE_RAW"

EXECUTOR_PROMPT='<objective>
Execute plan {plan_number} of phase {phase_number}-{phase_name}.
Commit each task atomically. Create SUMMARY.md.
Do NOT update STATE.md or ROADMAP.md — the orchestrator owns those writes after all worktree agents in the wave complete.
</objective>

<execution_context>
You are the gsd-executor agent running in a git worktree GSD created for you.
Your working directory IS that worktree. Do not cd elsewhere, and do not run
any git command that targets the main checkout. Use normal git commits WITH
hooks. Do NOT use --no-verify.

ORCHESTRATOR build-time embed (NOT a child-process runtime step): the files
below were inlined verbatim into this prompt before you were spawned. If any
section below is missing or truncated, stop and report it — do not improvise
the executor workflow from repository search.
- execute-plan.md (the executor workflow you run, including its worktree-mode
  SUMMARY commit semantics and the gitignored-planning skip contract)
- summary.md template
- checkpoints.md
${TDD_APPLICABLE ? "- tdd.md" : ""}  # #3990/#4265: only when this dispatch is TDD (plan type: tdd, a tdd="true" task, or workflow.tdd_mode config)
- worktree-path-safety.md
- agents/gsd-executor.md (the ROLE DEFINITION you are executing — its steps
  0/0a/0b per-commit HEAD/cwd-drift/path-guard discipline applies to every
  commit you make in this worktree, and its final_commit contract is the
  authority for the skip semantics in <success_criteria>)

(Inline the actual contents of each file above at compose time — this block
is the provenance record of what was embedded and where it came from.)

REQUIRED ORDER: Write SUMMARY.md, commit, then any narration.
</execution_context>

<required_reading>
Read these files at execution start using the Read tool.
First resolve repo root so every path is anchored:
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
- ${PROJECT_ROOT}/{phase_dir}/{plan_file} (Plan — THE plan you are executing)
- ${PROJECT_ROOT}/.planning/PROJECT.md (Project context — core value, requirements, evolution rules)
- ${PROJECT_ROOT}/.planning/STATE.md (State)
- ${PROJECT_ROOT}/.planning/config.json (Config, if exists)
- ${PROJECT_ROOT}/CLAUDE.md (Project instructions, if exists — follow project-specific guidelines and coding conventions)
- ${PROJECT_ROOT}/.claude/skills/ or ${PROJECT_ROOT}/.agents/skills/ (Project skills, if either exists — list skills, read SKILL.md for each, follow relevant rules during implementation)
- ${PROJECT_ROOT}/{phase_dir}/*-CONTEXT.md (User decisions from discuss-phase — honors locked choices; skip silently when none exist)
- ${PROJECT_ROOT}/{phase_dir}/*-RESEARCH.md (Technical research — pitfalls and patterns to follow; skip silently when none exist)
- ${PROJECT_ROOT}/{prior_wave_summaries} (SUMMARY.md files from earlier waves in this phase — what was already built; PARALLEL WAVES especially must not duplicate or clobber sibling work; substitute the empty string when this is wave 1)
</required_reading>

<mcp_tools>
If CLAUDE.md or project instructions reference MCP tools, prefer those tools
over Grep/Glob for code navigation when available. Check tool availability
first — fall back to Grep/Glob if not accessible.
</mcp_tools>

${AGENT_SKILLS}

<success_criteria>
- [ ] All tasks executed
- [ ] Each task committed individually
- [ ] SUMMARY.md created in the plan directory and committed — OR an
      intentional skip recorded (skipped_gitignored when .planning is
      gitignored, skipped_commit_docs_false when commit_docs is disabled).
      Never force-stage gitignored planning artifacts: git add -f on
      .planning paths is forbidden. An intentional skip is a success path.
- [ ] No modifications to shared orchestrator artifacts (the orchestrator handles all post-wave shared-file writes)
</success_criteria>'
[ -n "$EXECUTOR_PROMPT" ] || { echo "FATAL: executor prompt is empty for plan {plan_number}." >&2; exit 1; }
# #3637 fail-closed verification. Two classes of check:
#   (a) template completeness — the prompt must carry the required-reading
#       contract and the skip semantics at all (catches wholesale truncation
#       back to the objective-only prompt);
#   (b) embed PERFORMANCE — the compose-time placeholders must actually be
#       gone. A raw, un-embedded template still contains its own
#       instructions-about-instructions (the provenance parenthetical and the
#       un-substituted persona marker); those strings surviving to spawn time
#       mean the embeds were skipped and the child would hold instructions
#       about files it never received — the milder recurrence of #3637.
# These run BEFORE worktree creation, so a gate exit leaves nothing to tear
# down; the post-dispatch-isolation fail-closed check governs the worktree
# itself once one exists.
printf '%s' "$EXECUTOR_PROMPT" | grep -q '<required_reading>' || {
  echo "FATAL: executor prompt for plan {plan_number} is missing the required-reading contract — the template is truncated. Halting rather than spawning a generic process." >&2
  exit 1
}
printf '%s' "$EXECUTOR_PROMPT" | grep -q 'skipped_gitignored' || {
  echo "FATAL: executor prompt for plan {plan_number} is missing the gitignored-planning skip semantics — executors without them force-stage planning artifacts (#3637). Halting." >&2
  exit 1
}
printf '%s' "$EXECUTOR_PROMPT" | grep -q 'Inline the actual contents' && {
  echo "FATAL: executor prompt for plan {plan_number} still contains its compose-time placeholder — the build-time embeds were not performed. Halting rather than dispatching instructions-about-instructions (#3637)." >&2
  exit 1
}
printf '%s' "$EXECUTOR_PROMPT" | grep -q '\${AGENT_SKILLS}' && {
  echo "FATAL: executor prompt for plan {plan_number} still contains the un-substituted \${AGENT_SKILLS} marker — the role definition was not spliced in (#3637). Halting." >&2
  exit 1
}
printf '%s' "$EXECUTOR_PROMPT" | grep -q '\${TDD_APPLICABLE' && {
  echo "FATAL: executor prompt for plan {plan_number} still contains the un-substituted \${TDD_APPLICABLE marker — the TDD-applicability decision was not resolved into the prompt (#4266). Halting." >&2
  exit 1
}
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
  --root "$ORCH_ROOT" \
  --files "$PLAN_FILES" \
  --deletions "$PLAN_DELETIONS" 2>&1) || {
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

`--files` carries the plan's declared `files_modified` (the same `PLAN_FILES` the per-plan worktree gate extracts) so this backend routes through the SAME advisory scope-conformance check the Claude worktree path uses at merge (#2596) — one validation, both backends. It is advisory and never blocks; omitting it just skips the check.

`--deletions` carries the plan's declared `files_deleted` (`PLAN_DELETIONS`, extracted alongside `PLAN_FILES`) so this backend also routes through the deletions guard's opt-in (#3003). Unlike `--files` this one is **not** advisory: omitting it leaves the guard blocking on any deletion at all, which would make a plan that declares a removal merge on the harness path and fail here. Every dispatch surface that records a worktree must pass it.

`worktree create` records the entry in `$WAVE_WORKTREE_MANIFEST` itself, so **do not** call `worktree.record-agent` for these plans — that verb is the harness-path counterpart, used because the harness creates the worktree behind GSD's back. Double-recording is deduped by path+branch, but the create verb is the single writer here.

Spawn `EXEC_JSON`'s `command` + `args` as a background process with its working directory set to `EXEC_JSON.cwd`. The `cwd` is returned for **every** host, including those whose descriptor has no cwd flag (`cwdFlag: null`) and therefore bind through the process's own working directory — always set it, never assume the flag did the job. Wait for all spawned executors in the wave before merging.

The executor never touches `STATE.md`/`ROADMAP.md`, and that guard needs no new code — `execute-plan` auto-detects worktree mode via the `IS_WORKTREE` (`.git`-is-a-file) primitive, which a GSD-created worktree trips identically to a harness-created one.

Merge-back, validation, and cleanup are the **existing** gauntlet, unchanged: the serialized `worktree.cleanup-wave` merge loop that stops the wave and retains the worktree on conflict, and manifest-only cleanup (never glob-inferred). Because the manifest shape is identical, the orchestrator path reuses it verbatim.

> **Declared-scope conformance (#2596):** ADR-1239 specifies that *both* isolation adapters route their merge through a check that each plan branch's committed diff stayed inside its declared `files_modified` scope. That check now exists, advisory-first, and is wired into **both** paths: this one passes `--files "$PLAN_FILES"` to `worktree create` above, the harness path passes it to `worktree record-agent`, and `cleanup-wave` runs the one comparison for both. A path outside the declared scope is reported in the result's `warnings` array; it does not block the merge. Promotion to a hard gate is a separate, disclosed change.


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
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
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
  _SHOULD_DEGRADE=$(gsd_run query worktree.base-check --pick shouldDegrade 2>/dev/null || true)
  if [ "$_SHOULD_DEGRADE" = "true" ]; then
    _DEGRADE_MSG=$(gsd_run query worktree.base-check --pick message 2>/dev/null || true)
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

First compose the executor prompt — **to a file, not a shell literal**. A process spawn has no `subagent_type`, so nothing on this transport loads the `gsd-executor` role for the child (#3637): everything the harness dispatch delivers through the agent definition and its `<execution_context>` embed must instead ride in this prompt, or the spawned process starts as a generic model that reconstructs its role by inference. Two transport constraints shape the composition: the prompt travels as a single argv argument (Windows caps a command line at ~32 KiB, so the multi-hundred-KiB build-time embeds the harness path inlines cannot ride along), and a shell-literal assignment cannot carry arbitrary file content. So: the small, contract-critical text goes INLINE; the large execution-context files are listed as MANDATORY first reads with resolvable paths — a process-spawned executor, unlike an `Agent()` prompt (#3324), can and must Read files.

First ensure the destination directory exists (do not rely on any runtime's Write tool creating intermediate directories): run `mkdir -p "${ORCH_ROOT}/.claude/worktrees"`. Then write the composed prompt with your Write tool to exactly this path (the file is the inspectable provenance of what this dispatch injected, and it survives worktree cleanup):

`${ORCH_ROOT}/.claude/worktrees/executor-prompt-p{plan_number}.md`

Compose it from the template below, substituting every `{placeholder}` — leave NO unexpanded template text behind; the spawn block validates this and halts. Two substitutions need care:

- `{EXECUTOR_ROLE_FILE}` — the absolute path of the INSTALLED `gsd-executor` agent definition on this runtime (the same file `query agent-skills` reads for its persona fallback). This, not an inline embed, is how the role's full substance (deviation rules, destructive-git prohibitions, the final-commit SDK contract) reaches the child: the prompt must stay a single small argv argument (Windows caps a command line at ~32 KiB), and the installed agent alone is ~49 KiB. The spawn block verifies the path is readable before anything launches.
- `{AGENT_SKILLS_BLOCK}` — ONLY the configured custom-skills block (when `.planning/config.json` configures `agent_skills` for `gsd-executor`). When it is not configured, substitute the EMPTY string — on AGENTS-native runtimes the unconfigured `query agent-skills` falls back to injecting the full installed persona (#2454), which would blow the argv cap this design exists to respect; the persona already rides `{EXECUTOR_ROLE_FILE}` above. The spawn block enforces this with a hard byte cap.

```text
<provenance>plan {plan_number} of phase {phase_number} at {ORCH_ROOT}</provenance>

<role>
You are the gsd-executor agent, dispatched by the GSD execute-phase orchestrator
into a git worktree it created for you. No agent file is loaded on this
transport, so this prompt plus the files below ARE your role. Before ANY other
work, read every file in <required_reading> with your file-reading tool — the
gsd-executor definition and execute-plan.md are your execution contract
(deviation rules, commit protocol, checkpoint gates, destructive-git
prohibitions, the final-commit SDK contract). If any listed file cannot be
read, STOP and report the failure — do not improvise the contract.
</role>

<objective>
Execute plan {plan_number} of phase {phase_number}-{phase_name}.
Plan file: {ORCH_ROOT}/{phase_dir}/{plan_file}
Commit each task atomically. Create SUMMARY.md.
Do NOT update STATE.md or ROADMAP.md — the orchestrator owns those writes after all worktree agents in the wave complete.
</objective>

<required_reading>
Read these BEFORE starting, in this order. Paths under {GSD_ROOT} are the
installed GSD tree (outside your worktree — readable; your sandbox restricts
writes, not reads). Paths under {ORCH_ROOT} are the orchestrator's checkout.
- {EXECUTOR_ROLE_FILE}                            (your role definition)
- {GSD_ROOT}/workflows/execute-plan.md            (your execution contract)
- {GSD_ROOT}/templates/summary.md                 (SUMMARY.md structure)
- {GSD_ROOT}/references/checkpoints.md            (checkpoint + tracer gate rules)
- {GSD_ROOT}/references/tdd.md                    (TDD execution)
- {GSD_ROOT}/references/worktree-path-safety.md   (cwd-drift and path guards)
- {ORCH_ROOT}/{phase_dir}/{plan_file}             (your plan)
- {ORCH_ROOT}/.planning/PROJECT.md                (project context)
- {ORCH_ROOT}/.planning/STATE.md                  (state)
- {ORCH_ROOT}/.planning/config.json               (config, if it exists)
- {ORCH_ROOT}/CLAUDE.md or AGENTS.md              (project instructions, if either exists)
</required_reading>

<execution_context>
Your working directory IS the worktree GSD created. Do not cd elsewhere, and do
not run any git command that targets the main checkout. Use normal git commits
WITH hooks; do NOT pass --no-verify. execute-plan.md auto-detects worktree mode
(`.git` is a file) and skips shared-file updates automatically.
REQUIRED ORDER: Write SUMMARY.md, commit, then any narration.
</execution_context>

{AGENT_SKILLS_BLOCK}

<success_criteria>
- [ ] All tasks executed
- [ ] Each task committed individually
- [ ] SUMMARY.md created in the plan directory, and committed via execute-plan.md's
      git_commit_metadata step. When that SDK step reports
      `skipped_gitignored` or `skipped_commit_docs_false`, the skip IS success —
      record it and move on. NEVER force-stage planning artifacts
      (`git add -f .planning/...` is forbidden, #3678); an uncommitted SUMMARY.md
      is rescued by the orchestrator at merge (#2070), not by you.
</success_criteria>
```

Substitute `{GSD_ROOT}` with the installed gsd-core root this workflow itself was loaded from (the directory containing `workflows/execute-phase.md`), as an absolute path. The checkpoint gate rule (#3370, in `per-plan-executor-routing.md`) applies here too: add no prompt text refusing or overriding auto-approval for the default `gate="blocking"` — only `blocking-human` always surfaces.

Then load and validate the prompt file — **fail closed on any gap** rather than spawning a reduced-context executor (#3637):

```bash
PROMPT_FILE="${ORCH_ROOT}/.claude/worktrees/executor-prompt-p{plan_number}.md"
[ -s "$PROMPT_FILE" ] || { echo "FATAL: executor prompt file missing or empty for plan {plan_number}: $PROMPT_FILE" >&2; exit 1; }

# 1. Identity: the provenance stamp must name THIS plan, phase, and root — a
#    surviving file from another phase or run passes every structural check
#    below, so identity is checked first and exactly.
grep -qF '<provenance>plan {plan_number} of phase {phase_number} at '"$ORCH_ROOT"'</provenance>' "$PROMPT_FILE" || {
  echo "FATAL: executor prompt at $PROMPT_FILE is not the prompt for plan {plan_number} of phase {phase_number} (stale or foreign provenance stamp). Re-compose it." >&2; exit 1; }

# 1b. Freshness: the provenance stamp cannot distinguish a leftover from a
#     PREVIOUS attempt of this same plan (same plan, phase, and root). The
#     wave manifest is initialized at wave start, so any prompt composed for
#     THIS wave is newer than it — an older file is a stale leftover whose
#     plan text, skills, or contract paths may have changed since.
[ "$PROMPT_FILE" -nt "$WAVE_WORKTREE_MANIFEST" ] || {
  echo "FATAL: executor prompt at $PROMPT_FILE predates this wave's manifest — a leftover from a previous attempt. Re-compose it." >&2; exit 1; }

# 2. Structure: every contract block present AND closed — a truncated compose
#    can carry every opening tag and still be missing its tail.
for TAG in '<provenance>' '<role>' '</role>' '<objective>' '</objective>' '<required_reading>' '</required_reading>' '<execution_context>' '</execution_context>' '<success_criteria>' '</success_criteria>' 'skipped_gitignored'; do
  grep -qF "$TAG" "$PROMPT_FILE" || { echo "FATAL: executor prompt for plan {plan_number} is missing required block: $TAG (see $PROMPT_FILE)" >&2; exit 1; }
done

# 3. No surviving template text.
grep -qE '\{(GSD_ROOT|ORCH_ROOT|EXECUTOR_ROLE_FILE|AGENT_SKILLS_BLOCK|phase_dir|plan_file|plan_number|phase_number|phase_name)\}' "$PROMPT_FILE" && {
  echo "FATAL: executor prompt for plan {plan_number} still contains unexpanded template placeholders (see $PROMPT_FILE)." >&2; exit 1; }

# 4. Contract files must be READABLE now, before anything spawns — this is the
#    preflight that makes a wrong {GSD_ROOT} or {EXECUTOR_ROLE_FILE}
#    substitution fail here instead of inside a half-launched executor.
# Anchor both range delimiters to WHOLE lines: the <role> prose mentions
# <required_reading> inline, and an unanchored range would open there, feed
# prose to the entry grep, and reject every valid prompt. Entries are the
# "- <path>" lines only; the path ends at the 2+ space gap before the
# parenthesized comment, so a path containing single spaces survives.
# `tr -d '\r'` first: a prompt written on Windows (or through a CRLF-normalizing
# tool) leaves a trailing CR that whole-line sed anchors will not match and that
# would ride into every extracted path, so a perfectly valid prompt would be
# rejected. Strip once, parse the clean text.
PROMPT_LF=$(tr -d '\r' < "$PROMPT_FILE")
RR_BLOCK=$(printf '%s\n' "$PROMPT_LF" | sed -n '/^<required_reading>$/,/^<\/required_reading>$/p')
for BASE in gsd-executor execute-plan.md summary.md checkpoints.md tdd.md worktree-path-safety.md; do
  RR_LINE=$(printf '%s\n' "$RR_BLOCK" | grep -E -- "^- .*$BASE" | head -1)
  [ -n "$RR_LINE" ] || { echo "FATAL: executor prompt for plan {plan_number} lists no required-reading entry for $BASE." >&2; exit 1; }
  # Strip the leading bullet and ONLY a trailing parenthesized comment — not
  # every run of spaces. A path may legitimately contain consecutive spaces,
  # and truncating at the first such run would reject it as unreadable.
  RR_PATH=$(printf '%s\n' "$RR_LINE" | sed -E 's/^- +//; s/[[:space:]]+\([^()]*\)[[:space:]]*$//; s/[[:space:]]+$//')
  [ -r "$RR_PATH" ] || { echo "FATAL: required-reading file for $BASE is not readable at: $RR_PATH — the {GSD_ROOT}/{EXECUTOR_ROLE_FILE} substitution is wrong for this install." >&2; exit 1; }
done
PLAN_PATH=$(printf '%s\n' "$PROMPT_LF" | grep -m1 '^Plan file: ' | sed 's/^Plan file: //')
[ -n "$PLAN_PATH" ] && [ -r "$PLAN_PATH" ] || { echo "FATAL: the prompt's plan path is missing or unreadable: '$PLAN_PATH'." >&2; exit 1; }

# 5. Size: one argv argument on every host — Windows caps a command line at
#    ~32 KiB, so 24000 bytes leaves headroom for the exec argv around it. This
#    is also the hard backstop against the #2454 persona fallback being inlined.
PROMPT_BYTES=$(wc -c < "$PROMPT_FILE" | tr -d ' ')
[ "$PROMPT_BYTES" -lt 24000 ] || { echo "FATAL: executor prompt is $PROMPT_BYTES bytes (cap 24000) — an inline embed (likely the full agent persona) does not fit a single argv argument; large content belongs in <required_reading>." >&2; exit 1; }

EXECUTOR_PROMPT="$(cat "$PROMPT_FILE")"
echo "Executor prompt for plan {plan_number}: $PROMPT_FILE (${PROMPT_BYTES} bytes; role + contract via preflighted required reading)"
```

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
  --files "$PLAN_FILES" 2>&1) || {
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

`worktree create` records the entry in `$WAVE_WORKTREE_MANIFEST` itself, so **do not** call `worktree.record-agent` for these plans — that verb is the harness-path counterpart, used because the harness creates the worktree behind GSD's back. Double-recording is deduped by path+branch, but the create verb is the single writer here.

Spawn `EXEC_JSON`'s `command` + `args` as a background process with its working directory set to `EXEC_JSON.cwd`. The `cwd` is returned for **every** host, including those whose descriptor has no cwd flag (`cwdFlag: null`) and therefore bind through the process's own working directory — always set it, never assume the flag did the job. Wait for all spawned executors in the wave before merging.

The executor never touches `STATE.md`/`ROADMAP.md`, and that guard needs no new code — `execute-plan` auto-detects worktree mode via the `IS_WORKTREE` (`.git`-is-a-file) primitive, which a GSD-created worktree trips identically to a harness-created one.

Merge-back, validation, and cleanup are the **existing** gauntlet, unchanged: the serialized `worktree.cleanup-wave` merge loop that stops the wave and retains the worktree on conflict, and manifest-only cleanup (never glob-inferred). Because the manifest shape is identical, the orchestrator path reuses it verbatim.

> **Declared-scope conformance (#2596):** ADR-1239 specifies that *both* isolation adapters route their merge through a check that each plan branch's committed diff stayed inside its declared `files_modified` scope. That check now exists, advisory-first, and is wired into **both** paths: this one passes `--files "$PLAN_FILES"` to `worktree create` above, the harness path passes it to `worktree record-agent`, and `cleanup-wave` runs the one comparison for both. A path outside the declared scope is reported in the result's `warnings` array; it does not block the merge. Promotion to a hard gate is a separate, disclosed change.


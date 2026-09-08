<purpose>
Validate `.planning/` directory integrity and report actionable issues. Checks for missing files, invalid configurations, inconsistent state, and orphaned plans. Optionally repairs auto-fixable issues.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>
```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --raw --default "" 2>/dev/null || echo "")
```

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

<step name="parse_args">
**Parse arguments:**

Check if `--repair`, `--backfill`, or `--context` flags are present in the command arguments.

```
REPAIR_FLAG=""
BACKFILL_FLAG=""
CONTEXT_MODE=""
if arguments contain "--repair"; then
  REPAIR_FLAG="--repair"
fi
if arguments contain "--backfill"; then
  BACKFILL_FLAG="--backfill"
fi
if arguments contain "--context"; then
  CONTEXT_MODE="true"
fi
```

If `CONTEXT_MODE` is set, jump to the `context_check` step and skip the
integrity validation steps. The two modes are orthogonal — context utilization
has nothing to do with `.planning/` directory health.
</step>

<step name="context_check">
**Run only when `--context` is set.**

The model running this workflow self-reports the current session's
approximate `tokensUsed` and the active model's `contextWindow`. Use the values
visible in your runtime (Claude Code's `/context` slash command output, or the
model's own session telemetry). If the runtime exposes neither, prompt the user
once via AskUserQuestion for both numbers.

**TEXT_MODE fallback:** when `text_mode` is true (config or `--text` flag) the
runtime is non-Claude (Codex, Gemini, etc.) and `AskUserQuestion` is not
available — replace the prompt with a plain-text two-question sequence
("Approximate tokens used? Context window size?") and read the answers as
plain text from the user's response.

```bash
gsd_run query validate.context \
  --tokens-used "$TOKENS_USED" \
  --context-window "$CONTEXT_WINDOW"
```

The query prints a one-line status (`Context utilization: NN% (state)`) plus
a recommendation line for the warning and critical states. Print the SDK
output verbatim and end the workflow — do **not** mix in `.planning/`
health output, the two modes are independent diagnostics.
</step>

<step name="run_health_check">
**Run health validation:**

```bash
gsd_run query validate.health $REPAIR_FLAG $BACKFILL_FLAG
```

Parse JSON output:
- `status`: "healthy" | "degraded" | "broken"
- `errors[]`: Critical issues (code, message, fix, repairable)
- `warnings[]`: Non-critical issues
- `info[]`: Informational notes
- `repairable_count`: Number of auto-fixable issues
- `repairs_performed[]`: Actions taken if --repair was used

**Isolation/worktrees compatibility check (#2486):** the SDK is runtime-neutral, so this check runs here, using the same negotiation the execution-workflow guards use. It catches a config that carries an explicit `workflow.use_worktrees: true` on a runtime whose declared `dispatch.isolation` is `none` (e.g. inherited from a worktree-capable install sharing the repo) — a value `/gsd:execute-phase` and `/gsd:quick` fail closed on. The gate is the **declared capability, not the runtime name** (#2584), and the resolver fail-closes unknown/undeclared/`undocumented` values to `none`. Use `inspect-dispatch-isolation`, the **sentinel-free** inspection verb — never `dispatch-isolation`, whose #3045 contract records the resolved decision to the executor-dispatch sentinel as an unconditional side effect; a read-only diagnostic must not be able to stamp a sentinel the isolation guards then enforce against real dispatches. "Sentinel-free" is the precise claim and the only one this check depends on: like every `gsd-tools` invocation, inspection still runs the shared CLI bootstrap, which may self-heal a stale `.planning/active-workstream` pointer or rebuild compiled modules. Those are pre-existing, verb-independent, and cannot block a dispatch; writing the sentinel can:

The worktrees read deliberately carries no `--default`/fallback, exactly as `settings.md` does
it: W025's claim is that the config **sets** the key to a non-false value, so an absent key
(empty output) must stay distinguishable from an explicit `true`. A `|| echo "true"` fallback
collapses that distinction and makes the check fire on a config that never set the key —
correct only on an emit where `_stampNonClaudeRuntimeDefaults` happened to rewrite the line to
`--default false`, and wrong on the un-stamped source/Claude emit. The `[ -n … ]` guard below
removes that dependency on stamping entirely (#2486 review, Major 1).

A failed query is **not** a capability verdict. `|| echo "none"` would collapse "this runtime
declares no primitive" and "the query did not answer" into the same value, and W025's text asserts
the former — telling a Claude Code user their runtime declares no executor-isolation primitive,
which is false. Track the two apart and report which one happened.

Know the limit of that signal (#2486 review): the verb itself fail-closes an unknown, undeclared or
out-of-vocabulary runtime — and any internal resolution error — to `none` and exits 0, so `INSPECTED_RESOLVED=true` means "the query
answered", not "the runtime published a declaration". W025's resolved-case wording below is
therefore written to be true of every path that reaches it — a declared `none` and an
internally-fail-closed `none` alike. Distinguishing those two would need the verb to report
provenance, which is out of scope here.

```bash
_INSPECTED_RAW=$(gsd_run query inspect-dispatch-isolation --raw 2>/dev/null)
_ISOLATION_RC=$?
if [ $_ISOLATION_RC -ne 0 ] || [ -z "$_INSPECTED_RAW" ]; then
  INSPECTED_ISOLATION=none
  INSPECTED_RESOLVED=false      # no verdict learned — not the same as "declares none"
else
  INSPECTED_ISOLATION="$_INSPECTED_RAW"
  INSPECTED_RESOLVED=true
fi
case "$INSPECTED_ISOLATION" in
  harness-worktree|orchestrator-worktree|none) ;;
  *) INSPECTED_ISOLATION=none; INSPECTED_RESOLVED=false ;;   # out of vocabulary is not a verdict either
esac

USE_WORKTREES=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null)
if [ "$INSPECTED_ISOLATION" = "none" ] && [ -n "$USE_WORKTREES" ] && [ "$USE_WORKTREES" != "false" ]; then
  if [ "$INSPECTED_RESOLVED" = "true" ]; then
    echo "W025: the project config sets workflow.use_worktrees to a non-false value, but this runtime has no usable executor-isolation primitive — dispatch.isolation resolves to none, declared as none, or fail-closed because the capability could not be determined — so /gsd:execute-phase and /gsd:quick will fail closed. Fix: run /gsd:settings and answer No to Worktrees, or set workflow.use_worktrees: false in the project config (the active workstream's config.json when one is active). Set it explicitly rather than deleting the key — an absent key resolves to false only on an emit whose default was stamped to false, and to true otherwise."
  else
    echo "W025: the project config sets workflow.use_worktrees to a non-false value, and GSD could not resolve this runtime's executor-isolation capability ('gsd_run query inspect-dispatch-isolation' failed or returned nothing) — so it cannot tell whether /gsd:execute-phase and /gsd:quick will fail closed on that value. This is a report of an unverifiable config, NOT a finding that the runtime declares no primitive. Fix: re-run once the gsd-tools shim resolves; if the warning persists, run /gsd:settings and answer No to Worktrees."
  fi
fi
```

If the check prints, append it to the Warnings section of the report as `[W025]` with the printed fix, include it in the displayed warning count, and report `Status: DEGRADED` if `validate.health` returned `healthy` (a config the execution workflows fail closed on is not a healthy planning state). It is not auto-repairable: an explicit `true` may be intentional for a worktree-capable install sharing the same `.planning/config.json`, so the remedy is the user's call (#2486).
</step>

<step name="format_output">
**Format and display results:**

```
### GSD Health Check

Status: HEALTHY | DEGRADED | BROKEN
Errors: N | Warnings: N | Info: N
```

**If repairs were performed:**
```
## Repairs Performed

- ✓ config.json: Created with defaults
- ✓ STATE.md: Regenerated from roadmap
```

**If errors exist:**
```
## Errors

- [E001] config.json: JSON parse error at line 5
  Fix: Run /gsd:health --repair to reset to defaults

- [E002] PROJECT.md not found
  Fix: Run /gsd:new-project to create
```

**If warnings exist:**
```
## Warnings

- [W002] STATE.md references phase 5, but only phases 1-3 exist
  Fix: Review STATE.md manually before changing it; repair will not overwrite an existing STATE.md

- [W005] Phase directory "1-setup" doesn't follow NN-name format
  Fix: Rename to match pattern (e.g., 01-setup)
```

**If info exists:**
```
## Info

- [I001] 02-implementation/02-01-PLAN.md has no SUMMARY.md
  Note: May be in progress
```

**Footer (if repairable issues exist and --repair was NOT used):**
```
---
N issues can be auto-repaired. Run: /gsd:health --repair
```
</step>

<step name="offer_repair">
**If repairable issues exist and --repair was NOT used:**

Ask user if they want to run repairs:

```
Would you like to run /gsd:health --repair to fix N issues automatically?
```

If yes, re-run with --repair flag and display results.
</step>

<step name="verify_repairs">
**If repairs were performed:**

Re-run health check without --repair to confirm issues are resolved:

```bash
gsd_run query validate.health
```

Report final status.
</step>

</process>

<error_codes>
| Code | Severity | Description | Repairable |
|------|----------|-------------|------------|
| E001 | error | .planning/ directory not found | No |
| E002 | error | PROJECT.md not found | No |
| E003 | error | ROADMAP.md not found | No |
| E004 | error | STATE.md not found | No |
| E005 | error | config.json parse error | No |
| E010 | error | CWD resolves to the user's home directory — health check would target the wrong .planning/ | No |
| W001 | warning | PROJECT.md missing required section | No |
| W002 | warning | STATE.md references invalid phase | No |
| W003 | warning | config.json not found | Yes |
| W004 | warning | config.json invalid field value | No |
| W005 | warning | Phase directory naming mismatch | No |
| W006 | warning | Phase in ROADMAP but no directory | No |
| W007 | warning | Phase on disk but not in ROADMAP | No |
| W008 | warning | config.json: workflow.nyquist_validation absent (defaults to enabled but agents may skip) | Yes |
| W009 | warning | Phase has Validation Architecture in RESEARCH.md but no VALIDATION.md | No |
| W010 | warning | GSD agent installation missing or incomplete | No |
| W011 | warning | STATE.md current-phase status disagrees with ROADMAP.md checkbox | No |
| W012 | warning | config.json invalid branching_strategy value | No |
| W013 | warning | config.json context_window not a positive integer | No |
| W014 | warning | config.json phase_branch_template missing {phase} placeholder | No |
| W015 | warning | config.json milestone_branch_template missing {milestone} placeholder | No |
| W016 | warning | config.json: workflow.ai_integration_phase absent (defaults to enabled but agents may skip AI-integration-phase planning) | Yes |
| W017 | warning | Orphan git worktree (path no longer exists on disk) | No |
| W018 | warning | MILESTONES.md missing entry for archived milestone snapshot | Yes (`--backfill`) |
| W019 | warning | Unrecognized .planning/ root file — not a canonical GSD artifact | No |
| W020 | warning | Worktree health scan degraded — git worktree list timed out, failed, or a finding could not be verified | No |
| W021 | warning | Phase's integer prefix implies a different milestone than its ROADMAP section (phase_id_convention: milestone-prefixed) | No |
| W022 | warning | config.json models entry malformed (unknown phase type, invalid tier, or non-object value) | No |
| W023 | warning | Phase directories collide on normalized key | No |
| W024 | warning | STATE.md was written many commits ago — treat its contents as approximate | No |
| W026 | warning | STATE says milestone complete but ROADMAP lists an unstarted phase for that milestone | No |
| W027 | warning | Stale git worktree (not modified in a long time) | No |
| W028 | warning | A GSD-owned install scope shadows another on this machine | No |
| W029 | warning | .planning/ matches a gitignore rule but is still tracked by git (gitignore has no effect on already-tracked files) | No |
| I001 | info | Plan without SUMMARY (may be in progress) | No |
| I010 | info | Resolved CWD reported alongside the E010 home-directory guard | No |

Note: this table is **generated** — do not hand-edit it. It is produced by `node scripts/gen-health-docs.cjs --write` from `src/health-diagnostic.cts`'s `RULES` table (31 rules as of #3309, each carrying a static `description`/`repairable` on its `Rule` entry — see `src/health-diagnostic-types.cts`) plus the 3 pre-checks that stay outside the rule table by design (`E001`, `E010`, `I010` — safety rails in `cmdValidateHealth`, `src/verify.cts`, never `.planning/` findings). `scripts/lint-health-diagnostic-rule-table.cjs` already enforces the 1:1 code invariant this table depends on (no duplicate codes; severity is always a `Rule` property, never set per emit call) — before assigning a new code, add a `Rule` entry under `src/health-diagnostic-rules/` (its `code` is simply the next free number the lint guard has not yet seen) and run `node scripts/gen-health-docs.cjs --write` to regenerate this table; `npm run lint:generated-sync` fails if it drifts. `W025` (the `workflow.use_worktrees`/`dispatch.isolation` check, #2486) is a workflow-layer diagnostic emitted directly by this file's own `run_health_check` step, not by `cmdValidateHealth` — it stays documented in that step, not in this generated table.

</error_codes>

<repair_actions>
| Action | Effect | Risk |
|--------|--------|------|
| createConfig | Create config.json with defaults | None |
| resetConfig | Delete + recreate config.json | Loses custom settings |
| regenerateState | Create STATE.md from ROADMAP structure when it is missing | Loses session history |
| addNyquistKey | Add workflow.nyquist_validation: true to config.json | None — matches existing default |
| addAiIntegrationPhaseKey | Add workflow.ai_integration_phase: true to config.json | None — matches existing default |
| backfillMilestones | Synthesize missing MILESTONES.md entries from `.planning/milestones/vX.Y-ROADMAP.md` snapshots | None — additive only; triggered by `--backfill` flag |

**Not repairable (too risky):**
- PROJECT.md, ROADMAP.md content
- Phase directory renaming
- Orphaned plan cleanup

</repair_actions>

<stale_task_cleanup>
**Windows-specific:** Check for stale Claude Code task directories that accumulate on crash/freeze.
These are left behind when subagents are force-killed and consume disk space.

When `--repair` is active, detect and clean up:

```bash
# Check for stale task directories (older than 24 hours)
TASKS_DIR="$HOME/.claude/tasks"
if [ -d "$TASKS_DIR" ]; then
  STALE_COUNT=$( (find "$TASKS_DIR" -maxdepth 1 -type d -mtime +1 2>/dev/null || true) | wc -l )
  if [ "$STALE_COUNT" -gt 0 ]; then
    echo "⚠️  Found $STALE_COUNT stale task directories in ~/.claude/tasks/"
    echo "   These are leftover from crashed subagent sessions."
    echo "   Run: rm -rf ~/.claude/tasks/*  (safe — only affects dead sessions)"
  fi
fi
```

Report as info diagnostic: `I002 | info | Stale subagent task directories found | Yes (--repair removes them)`
</stale_task_cleanup>

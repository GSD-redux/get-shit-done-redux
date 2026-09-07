<purpose>
Safe git revert workflow. Rolls back GSD phase or plan commits using the phase manifest with dependency checks and a confirmation gate. Uses git revert --no-commit (NEVER git reset) to preserve history.
</purpose>

<required_reading>
@~/.claude/gsd-core/references/ui-brand.md
@~/.claude/gsd-core/references/gate-prompts.md
</required_reading>

<process>
```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --raw --default "" 2>/dev/null || echo "")
```

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

<step name="banner" priority="first">
Display the stage banner:

```
### GSD ► UNDO
```
</step>

<step name="parse_arguments">
Parse $ARGUMENTS for the undo mode:

- `--last N` → MODE=last, COUNT=N (integer, default 10 if N missing)
- `--phase NN` → MODE=phase, TARGET_PHASE=NN (two-digit phase number)
- `--plan NN-MM` → MODE=plan, TARGET_PLAN=NN-MM (phase-plan ID)

If no valid argument is provided, display usage and exit:

```
Usage: /gsd:undo --last N | --phase NN | --plan NN-MM

Modes:
  --last N      Show last N GSD commits for interactive selection
  --phase NN    Revert all commits for phase NN
  --plan NN-MM  Revert all commits for plan NN-MM

Examples:
  /gsd:undo --last 5
  /gsd:undo --phase 03
  /gsd:undo --plan 03-02
```
</step>

<step name="gather_commits">
Based on MODE, gather candidate commits.

**MODE=last:**

Run:
```bash
git log --oneline --no-merges -${COUNT}
```

Filter for GSD conventional commits matching `type(scope): message` pattern (e.g., `feat(04-01):`, `docs(03):`, `fix(02-03):`).

Display a numbered list of matching commits:
```
Recent GSD commits:
  1. abc1234 feat(04-01): implement auth endpoint
  2. def5678 docs(03-02): complete plan summary
  3. ghi9012 fix(02-03): correct validation logic
```

**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
Use AskUserQuestion to ask:
- question: "Which commits to revert? Enter numbers (e.g., 1,3) or 'all'"
- header: "Select"

Parse the user's selection into COMMITS list.

---

**MODE=phase:**

Resolve the phase's own directory, then anchor the selection window on it. `find-phase`
resolves through `planningDir`, so under an active workstream this is that workstream's
phase directory — not the root's same-numbered one.

```bash
PHASE_DIR=$(gsd_run query find-phase "${TARGET_PHASE}" --raw 2>/dev/null)
```

If `PHASE_DIR` is empty, the phase does not exist in the active scope:
```
Phase ${TARGET_PHASE} not found in the active planning scope. Nothing to revert.
```
Exit cleanly — do NOT fall back to an unbounded search.

Derive the selection window from `PHASE_DIR` (the `#3995` anchor, shared with
`code-review.md`): the base is the parent of the first commit that added anything under
the phase's own directory, and the tip is `HEAD`.

```bash
PHASE_START=$(git log --format="%H" --diff-filter=A -- "${PHASE_DIR}" 2>/dev/null | tail -1)
UNDO_RANGE=""
if [ -n "$PHASE_START" ]; then
  if git rev-parse "${PHASE_START}^" >/dev/null 2>&1; then
    UNDO_RANGE="${PHASE_START}^..HEAD"
  else
    # PHASE_START is the root commit — it has no parent to exclude. `${PHASE_START}..HEAD`
    # would drop PHASE_START ITSELF, refusing a legitimate revert of the first commit.
    UNDO_RANGE="HEAD"
  fi
fi
```

**Fail closed when no anchor resolves.** If `UNDO_RANGE` is empty, stop:
```
Cannot determine a reliable commit window for phase ${TARGET_PHASE} (no commit adds ${PHASE_DIR}).
Re-run with /gsd:undo --last N and select commits explicitly.
```
Exit cleanly. An unbounded repository-wide search is never the fallback — that is the
defect this anchor replaces.

Select within the window. **No `--all`:** only commits reachable from `HEAD` may be
reverted, because reverting a commit that is not in the current branch's history stages a
change the branch never received.

```bash
# `|| true`: grep exits 1 on no match. The former `| head -50` masked that rc; the empty
# case is handled by the Empty check step below, so the pipeline must not abort here.
git log --oneline --no-merges "${UNDO_RANGE}" | grep -E "\(0*${TARGET_PHASE}(-[0-9]+)?\):" || true
```

Use matching commits as COMMITS.

**Report truncation, never truncate silently.** If the selection exceeds 50 commits, show
the count and stop rather than capping — a partial phase revert leaves a worse tree state
than either reverting the phase or not:
```
Phase ${TARGET_PHASE} selects ${N} commits (>50). Refusing to revert a partial phase.
Use /gsd:undo --plan NN-MM per plan, or /gsd:undo --last N.
```

---

**MODE=plan:**

Extract the phase number from `TARGET_PLAN` (the `NN` of `NN-MM`) and derive the same
window from that phase's own directory — a plan number is unique within its phase, and a
phase number only within its milestone and workstream.

```bash
PLAN_PHASE="${TARGET_PLAN%%-*}"
PHASE_DIR=$(gsd_run query find-phase "${PLAN_PHASE}" --raw 2>/dev/null)
PHASE_START=$(git log --format="%H" --diff-filter=A -- "${PHASE_DIR}" 2>/dev/null | tail -1)
UNDO_RANGE=""
if [ -n "$PHASE_START" ]; then
  if git rev-parse "${PHASE_START}^" >/dev/null 2>&1; then
    UNDO_RANGE="${PHASE_START}^..HEAD"
  else
    # PHASE_START is the root commit — it has no parent to exclude. `${PHASE_START}..HEAD`
    # would drop PHASE_START ITSELF, refusing a legitimate revert of the first commit.
    UNDO_RANGE="HEAD"
  fi
fi
```

Apply the same fail-closed rule as MODE=phase when `PHASE_DIR` or `UNDO_RANGE` is empty,
then select within the window:

```bash
# `|| true` for the same reason as MODE=phase: an empty selection is not an error here.
git log --oneline --no-merges "${UNDO_RANGE}" | grep -E "\(${TARGET_PLAN}\):" || true
```

Use matching commits as COMMITS.

**Report truncation, never truncate silently** — the same rule as MODE=phase. If the
selection exceeds 50 commits, show the count and stop rather than capping:
```
Plan ${TARGET_PLAN} selects ${N} commits (>50). Refusing to revert a partial plan.
Use /gsd:undo --last N and select commits explicitly.
```

---

**Known residual — a revision range is ancestry, not chronology.** `PHASE_START^..HEAD`
excludes everything reachable from `PHASE_START^`, which is the right bound for the
ordinary linear case. It is not a *chronological* lower bound: a long-lived side branch
created before the phase, carrying matching scopes, and merged in **after** `PHASE_START`
is reachable from `HEAD` without being an ancestor of `PHASE_START^`, so it stays
selectable. This is strictly narrower than the unbounded search it replaces, not a new
exposure — but it is not zero.

**Known residual — an archived or renamed phase directory under-selects.** The anchor is
`--diff-filter=A` on the phase directory's *current* path and does not follow renames, so
for a phase whose directory has since moved (milestone archival moves it under
`milestones/v<X.Y>-phases/`) the oldest add at that path is the **move** commit, and the
phase's real work commits — which predate it — fall outside the window. The failure is
under-selection: the undo reverts too little or refuses, never too much. Prefer
`/gsd:undo --last N` for a phase whose directory has been archived.

**Known residual — concurrent workstreams.** The window above is scoped to the target
phase's own directory, which is workstream-correct, but the commit subjects it filters
are not: the executor's scope contract is `type({phase}-{plan})` with no workstream
token, so two workstreams running the same phase number concurrently emit
indistinguishable subjects and both fall inside each other's window. Narrowing the window
removes the previous-milestone and unreachable-branch classes entirely; this last class
needs a discriminator that does not exist in a commit subject today (`#3995`: *"Message
subjects demonstrably do not carry enough information to identify a phase"*). Until one
exists, `confirm_revert` is the backstop for it.

---

**Empty check:**

If COMMITS is empty after gathering:
```
No commits found for ${MODE} ${TARGET}. Nothing to revert.
```
Exit cleanly.
</step>

<step name="dependency_check">
**Applies when MODE=phase or MODE=plan.**

Skip this step entirely for MODE=last.

Resolve the active scope's planning root first — **both** modes below read from it. Under
an active workstream the roadmap and phase directories describing the target are that
workstream's, not the root's:

```bash
PLANNING_DIR=$(gsd_run query planning inspect --pick generated_from.planning_root --raw 2>/dev/null)
[ -n "$PLANNING_DIR" ] || PLANNING_DIR=".planning"
```

---

**MODE=phase:**

Read `${PLANNING_DIR}/ROADMAP.md` inline.

Search for phases that list a dependency on the target phase. Look for patterns like:
- "Depends on: Phase ${TARGET_PHASE}"
- "Depends on: ${TARGET_PHASE}"
- "depends_on: [${TARGET_PHASE}]"

For each dependent phase N found:
1. Check if `${PLANNING_DIR}/phases/${N}-*/` directory exists
2. If directory exists, check for any PLAN.md or SUMMARY.md files inside it

If any downstream phase has started work, collect warnings:
```
⚠  Downstream dependency detected:
   Phase ${N} depends on Phase ${TARGET_PHASE} and has started work.
```

---

**MODE=plan:**

Extract the phase number from TARGET_PLAN (the NN part of NN-MM). Extract the plan number (the MM part).

Look for later plans in the same phase directory (`${PLANNING_DIR}/phases/${NN}-*/`, the
same workstream-resolved root). For each later plan (plans with number > MM):
1. Read the later plan's PLAN.md
2. Check if its `<files>` sections or `consumes` fields reference outputs from the target plan

If any later plan references the target plan's outputs, collect warnings:
```
⚠  Intra-phase dependency detected:
   Plan ${LATER_PLAN} in phase ${NN} references outputs from plan ${TARGET_PLAN}.
```

---

If any warnings exist (from either mode):
- Display all warnings
- Use AskUserQuestion with approve-revise-abort pattern:
  - question: "Downstream work depends on the target being reverted. Proceed anyway?"
  - header: "Confirm"
  - options: Proceed | Abort

If user selects "Abort": exit with "Revert cancelled. No changes made."
</step>

<step name="confirm_revert">
Display the confirmation gate using approve-revise-abort pattern from gate-prompts.md.

Show:
```
The following commits will be reverted (in reverse chronological order):

  {hash} — {message}
  {hash} — {message}
  ...

Total: {N} commit(s) to revert
```

Use AskUserQuestion:
- question: "Proceed with revert?"
- header: "Approve?"
- options: Approve | Abort

If "Abort": display "Revert cancelled. No changes made." and exit.
If "Approve": ask for a reason:

```
AskUserQuestion(
  header: "Reason",
  question: "Brief reason for the revert (used in commit message):",
  options: []
)
```

Store the response as REVERT_REASON. Continue to execute_revert.
</step>

<step name="execute_revert">
**HARD CONSTRAINT: Use git revert --no-commit. NEVER use git reset (except for conflict cleanup as documented below).**

**Dirty-tree guard (run first, before any revert):**

Run `git status --porcelain`. If the output is non-empty, display the dirty files and abort:
```
Working tree has uncommitted changes. Commit or stash them before running /gsd:undo.
```
Exit immediately — do not proceed to any revert operations.

---

Sort COMMITS in reverse chronological order (newest first). If commits came from git log (already newest-first), they are already in correct order.

For each commit hash in COMMITS:
```bash
git revert --no-commit ${HASH}
```

If any revert fails (merge conflict or error):
1. Display the error message
2. Run cleanup — handle both first-call and mid-sequence cases:
   ```bash
   # Try git revert --abort first (works if this is the first failed revert)
   git revert --abort 2>/dev/null
   # If prior --no-commit reverts already staged cleanly before this failure,
   # revert --abort may be a no-op. Clean up staged and working tree changes:
   git reset HEAD 2>/dev/null
   git restore . 2>/dev/null
   ```
3. Display:
   ```
### ERROR

   Revert failed on commit ${HASH}.
   Likely cause: merge conflict with subsequent changes.

   **To fix:** Resolve the conflict manually or revert commits individually.
   All pending reverts have been aborted — working tree is clean.
   ```
4. Exit with error.

After all reverts are staged successfully, create a single commit:

For MODE=phase:
```bash
git commit -m "revert(${TARGET_PHASE}): undo phase ${TARGET_PHASE} — ${REVERT_REASON}"
```

For MODE=plan:
```bash
git commit -m "revert(${TARGET_PLAN}): undo plan ${TARGET_PLAN} — ${REVERT_REASON}"
```

For MODE=last:
```bash
git commit -m "revert: undo ${N} selected commits — ${REVERT_REASON}"
```
</step>

<step name="summary">
Display the completion banner:

```
### GSD ► UNDO COMPLETE ✓
```

Show summary:
```
  ✓ ${N} commit(s) reverted
  ✓ Single revert commit created: ${REVERT_HASH}
```

Show next steps:
```
---

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Review state** — verify project is in expected state after revert

/clear then:

/gsd:progress

---

**Also available:**
- `/gsd:execute-phase ${PHASE}` — re-execute if needed
- `/gsd:undo --last 1` — undo the revert itself if something went wrong

---
```
</step>

</process>

<success_criteria>
- [ ] Arguments parsed correctly for all three modes
- [ ] --phase mode anchors selection on the phase's own directory (find-phase -> PHASE_START), never a repository-wide commit-subject grep
- [ ] --phase and --plan modes fail closed when no anchor resolves, never widening to an unbounded search
- [ ] Dependency check warns when downstream phases have started (MODE=phase)
- [ ] Dependency check warns when later plans reference target plan outputs (MODE=plan)
- [ ] Dirty-tree guard aborts if working tree has uncommitted changes
- [ ] Confirmation gate shown before any revert execution
- [ ] Reverts use git revert --no-commit in reverse chronological order
- [ ] Single commit created after all reverts staged
- [ ] Error handling cleans up both first-call and mid-sequence conflict cases
- [ ] git reset --hard is NEVER used anywhere in this workflow
</success_criteria>

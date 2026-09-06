<purpose>
Cross-AI plan convergence loop — automates the manual chain:
gsd-plan-phase N → gsd-review N --codex → gsd-plan-phase N --reviews → gsd-review N --codex → ...
Plan-phase runs inline (bare Skill at depth 0) so it can spawn gsd-planner/gsd-plan-checker at depth 1.
Review runs inside an isolated Agent (leaf skill — Bash only, no sub-agents needed).
Orchestrator only does: init, loop control, parse CYCLE_SUMMARY for HIGH and actionable non-HIGH counts, stall detection, escalation.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.

@$HOME/.claude/gsd-core/references/revision-loop.md
@$HOME/.claude/gsd-core/references/gates.md
@$HOME/.claude/gsd-core/references/agent-contracts.md
</required_reading>

<process>

## 1. Parse and Normalize Arguments

Extract from $ARGUMENTS: phase number, reviewer flags (the declared reviewer lane flags, plus `--all`), `--max-cycles N`, `--text`, `--ws`.

```bash
PHASE=$(echo "$ARGUMENTS" | grep -oE '[0-9]+\.?[0-9]*' | head -1)

# #2315: do NOT default REVIEWER_FLAGS to --codex here. The default is resolved
# against review.default_reviewers in step 1.5 (after the config gate) so a bare
# invocation respects the configured reviewer lineup per ADR-0011 / ADR-0015.

MAX_CYCLES=$(echo "$ARGUMENTS" | grep -oE '\-\-max-cycles\s+[0-9]+' | awk '{print $2}')
if [ -z "$MAX_CYCLES" ]; then MAX_CYCLES=3; fi

GSD_WS=""
echo "$ARGUMENTS" | grep -qE '\-\-ws\s+\S+' && GSD_WS=$(echo "$ARGUMENTS" | grep -oE '\-\-ws\s+\S+')
```

## 1.5. Config Gate (feature disabled by default)

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
CONVERGENCE_ENABLED=$(gsd_run query config-get workflow.plan_review_convergence --raw 2>/dev/null || echo "false")
```

**If `CONVERGENCE_ENABLED` is not `"true"`:** Display and exit:

```text
gsd-plan-review-convergence is disabled (workflow.plan_review_convergence=false).

This feature automates the plan→review→replan loop using external AI reviewers.
Enable it with:

  gsd config-set workflow.plan_review_convergence true

Then re-run: /gsd:plan-review-convergence {PHASE}
```

```bash
# Reviewer flags are DERIVED from the declared lane roster (#2800/#2272), never hand-listed.
# Three surfaces used to enumerate them independently and had drifted: --coderabbit was missing
# from all three, --qwen/--cursor/--kimi-code from this one, and the old unanchored
# `grep -q '\-\-agy'` matched INSIDE --antigravity, appending both for one user flag.
# `--all` is a selection control, not a lane, so it stays literal.
# This block must stay AFTER the launcher preamble (below) because it calls `gsd_run` —
# do not move it back above the preamble in a future edit.
REVIEWER_FLAGS=""
for REVIEW_FLAG in $(gsd_run review-lane flags) --all; do
  if echo "$ARGUMENTS" | grep -qE "(^|[[:space:]])${REVIEW_FLAG}([[:space:]]|$)"; then
    REVIEWER_FLAGS="$REVIEWER_FLAGS $REVIEW_FLAG"
  fi
done

# #2315: Resolve reviewer selection when no explicit flag was given.
# The pre-fix bug unconditionally set REVIEWER_FLAGS="--codex" in step 1, BEFORE
# the config gate — silently overriding any configured review.default_reviewers
# (and, transitively, review.reviewer_instances). gsd-review sees the injected
# --codex as an explicit flag (precedence rule 1) and never reaches rule 3
# (review.default_reviewers). ADR-0011 and ADR-0015 both assume convergence
# respects review.default_reviewers on the no-flag path.
#
# After the fix: leave REVIEWER_FLAGS empty when default_reviewers is configured
# so gsd-review applies review.default_reviewers itself (rule 3). Only fall back
# to --codex when no default is configured, preserving the pre-fix default for
# unconfigured users (#2315 AC3). REVIEWER_DISPLAY mirrors the resolved value
# so the startup banner reflects what will actually run (#2315 AC4).
if [ -z "$REVIEWER_FLAGS" ]; then
  DEFAULT_REVIEWERS_JSON=$(gsd_run query config-get review.default_reviewers 2>/dev/null || echo "")
  if ! command -v jq >/dev/null 2>&1; then
    # jq is a documented production dependency (review.md, detect_clis — the
    # "jq-dependent reviewer lanes" note). If it is absent we cannot inspect
    # the configured default (it is a JSON array, not a --raw/--pick scalar), so
    # fail safe with --codex and surface the reason rather than silently
    # reproducing the #2315 override under degraded conditions.
    echo "WARNING: jq not on PATH — cannot read review.default_reviewers; falling back to --codex (#2315)" >&2
    REVIEWER_FLAGS="--codex"
    REVIEWER_DISPLAY="--codex (jq missing; cannot read review.default_reviewers)"
  else
    DEFAULT_REVIEWERS_COUNT=$(printf '%s' "$DEFAULT_REVIEWERS_JSON" | jq 'if type=="array" then length else 0 end' 2>/dev/null || echo 0)
    if [ "${DEFAULT_REVIEWERS_COUNT:-0}" -gt 0 ] 2>/dev/null; then
      : # leave REVIEWER_FLAGS empty — gsd-review applies review.default_reviewers itself
      REVIEWER_DISPLAY="review.default_reviewers ($(printf '%s' "$DEFAULT_REVIEWERS_JSON" | jq -r 'join(", ")' 2>/dev/null))"
    else
      REVIEWER_FLAGS="--codex"
      REVIEWER_DISPLAY="--codex (default; configure review.default_reviewers to change)"
    fi
  fi
else
  # Strip the leading space accumulated by the parse block so the banner renders
  # "Reviewers: --gemini" not "Reviewers:  --gemini" (#2315 review nit).
  REVIEWER_DISPLAY="${REVIEWER_FLAGS# }"
fi
```

## 2. Initialize

```bash
INIT=$(gsd_run init plan-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `phase_dir`, `phase_number`, `padded_phase`, `phase_name`, `has_plans`, `plan_count`, `commit_docs`, `text_mode`, `response_language`.

**If `response_language` is set:** All user-facing output — narration between tool calls, status updates, progress notes, findings, questions, and report prose — should be in `{response_language}`.

Set `TEXT_MODE=true` if `--text` is present in $ARGUMENTS OR `text_mode` from init JSON is `true`. When `TEXT_MODE` is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number.

## 3. Validate Phase + Pre-flight Gate

```bash
PHASE_INFO=$(gsd_run roadmap get-phase "${PHASE}")
```

**If `found` is false:** Error with available phases. Exit.

Display startup banner:

```text
### GSD ► PLAN CONVERGENCE — Phase {phase_number}

 Reviewers: {REVIEWER_DISPLAY}
 Max cycles: {MAX_CYCLES}
```

## 4. Initial Planning (if no plans exist)

**If `has_plans` is true:** Skip to step 5. Display: `Plans found: {plan_count} PLAN.md files — skipping initial planning.`

**If `has_plans` is false:**

Display: `◆ No plans found — running initial planning inline... (plan-phase runs here in the orchestrator — no output until planning is complete, ~1–5 min; expected, not a freeze)`

```text
Skill(skill="gsd-plan-phase", args="{PHASE} {GSD_WS}")
```

Run plan-phase **inline** (do NOT wrap it in Agent()). The convergence orchestrator runs at depth 0 with Agent available, so inline plan-phase can spawn gsd-planner and gsd-plan-checker at depth 1 — the one level of nesting that works on Claude Code. Wrapping plan-phase in Agent() would push it to depth 1 where the Agent tool is absent, preventing it from spawning any sub-agents. Wait until plan-phase completes and PLAN.md files are committed before continuing.

After plan-phase completes, verify plans were created. This asks "did initial
planning write files to disk" — a planner-produced-nothing check, not
outstanding-work counting — so it takes the PHYSICAL set (`plan_count_all`,
`status: superseded` INCLUDED, #3218):
```bash
PLAN_COUNT=$(gsd_run query find-phase "${PHASE}" | jq -r '.plan_count_all // 0')
```

If PLAN_COUNT == 0: Error — initial planning failed. Exit.

Display: `Initial planning complete: ${PLAN_COUNT} PLAN.md files created.`

## 5. Convergence Loop

Initialize loop variables:

```text
cycle = 0
prev_unresolved_count = Infinity
```

### 5a. Review (Spawn Agent)

Increment `cycle`.

Display: `◆ Cycle {cycle}/{MAX_CYCLES} — spawning review agent... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)`

```text
Agent(
  description="Cross-AI review Phase {PHASE} cycle {cycle}",
  prompt="Run /gsd:review for Phase {PHASE}.

Execute: Skill(skill='gsd-review', args='--phase {PHASE} {REVIEWER_FLAGS} {GSD_WS}')

Complete the full review workflow. Do NOT return until REVIEWS.md is committed.

IMPORTANT — CYCLE_SUMMARY contract (required):
Your final response MUST include a machine-readable line of exactly this form:

  CYCLE_SUMMARY: current_high=<N> current_actionable=<M>

Where <N> is the integer count of HIGH-severity concerns that REMAIN UNRESOLVED in this cycle's findings.
Where <M> is the integer count of actionable MEDIUM/LOW concerns that REMAIN UNRESOLVED because the latest PLAN.md files do not yet incorporate them or explicitly defer/reject them.

Consensus gate (applies to NEWLY RAISED HIGHs only; evaluate before the counting rules below):
  This gate engages ONLY when 2 or more reviewers actually ran and produced a review section this
  cycle. With exactly one reviewer, skip this entire gate — a single reviewer's HIGH always counts,
  exactly as before.

  Classify each newly raised HIGH by what the claim ASSERTS, not by whether it happens to contain a
  file:line citation:
    - EXISTENCE-CLASS — asserts that a named symbol, file, path, flag, commit, or ID exists,
      is absent, or says something specific ("X does not exist", "the plan cites Y which is missing",
      "file Z contains Q").
    - JUDGMENT-CLASS — asserts a design or correctness property ("no idempotency on retried writes",
      "race between A and B", "missing rate limit"). A judgment-class HIGH stays judgment-class even
      when it cites a file for context.

  A HIGH raised by 2+ reviewers is corroborated and always counts.

  For a HIGH raised by exactly ONE reviewer:
    - EXISTENCE-CLASS — counts only if the source-grounding pass independently confirms it against
      real project source, or another reviewer raised the same or a materially overlapping concern
      (i.e. it lands in REVIEWS.md's Consensus Summary "Agreed Concerns").
    - JUDGMENT-CLASS — counts UNLESS that reviewer's own section OPENS with an evidence-quality
      discount marker blockquote: `[reviewed-without-source-citations]` or
      `[reviewed-without-repo-access]`, or the reviewer is a diff-only lane (CodeRabbit). The marker
      must be the LEADING blockquote of that reviewer's section — a review that merely quotes a
      marker while discussing it is NOT marked. Corroboration by another reviewer overrides the
      marker and the HIGH counts.

  Judgment-class findings are deliberately NOT subject to corroboration. Different reviewers catch
  materially different classes of issue, so requiring two of them to independently raise the same
  architectural concern would suppress exactly the findings a multi-reviewer setup exists to surface.

  FAIL OPEN: if EVERY reviewer that ran this cycle carries a discount marker, this gate does not
  apply at all — count as if it were absent. A gate must never manufacture convergence out of a
  cycle in which nothing was verified.

  A HIGH suppressed by this gate is still listed under "## Current HIGH Concerns", tagged
  `(single-reviewer, unconfirmed)`. It is excluded from current_high only — never silently dropped,
  and never removed from the report.

  This gate governs current_high only. current_actionable is unaffected.

Counting rules:
  INCLUDE in the count:
    - Newly raised HIGHs in this cycle (subject to the consensus gate above)
    - PARTIALLY RESOLVED HIGHs: concern acknowledged and a mitigation is in progress, but not yet verified/completed
    - Previously raised HIGHs that are still unresolved

  EXCLUDE from the count:
    - FULLY RESOLVED HIGHs: concern addressed with verification complete (closed ticket, verification log, or reviewer sign-off)
    - HIGH mentions in retrospective/summary tables comparing cycles
    - Quoted excerpts from prior reviews referencing past HIGH items
    - MEDIUM/LOW concerns that are already incorporated into a PLAN.md task, action, acceptance_criteria, verify command, must_haves item, threat model, artifact list, or explicit deferral/rejection rationale

Definitions:
  PARTIALLY RESOLVED — concern acknowledged and mitigation is in progress but not yet verified/completed (e.g., open ticket exists but fix not landed).
  FULLY RESOLVED — concern addressed with verification complete (closed ticket, verification log, or explicit reviewer sign-off confirming closure).
  ACTIONABLE — a non-HIGH review finding that would be invisible to /gsd:execute-phase unless it is incorporated into PLAN.md or explicitly deferred/rejected in PLAN.md.

Your final response MUST also include this section immediately after the CYCLE_SUMMARY line:

## Current HIGH Concerns
[List each unresolved HIGH with a brief description, one per bullet]
[If none: write exactly 'None.']

## Current Actionable Non-HIGH Concerns
[List each unresolved actionable MEDIUM/LOW with a brief description and the PLAN.md change still needed, one per bullet]
[If none: write exactly 'None.']
These two sections MUST be the final content of your response, in this exact order, with no additional "## " headings after them (the source-grounding "Verification coverage" block is appended to REVIEWS.md, not to this return message).",
  mode="auto"
)
```

### Source-grounding pass (config: `plan_review.source_grounding`, default on)

Run this pass unless `plan_review.source_grounding` is `false`. It verifies every symbol the plan cites against the project source before approval, catching hallucinated symbols at review time instead of execution time.

1. **Enumerate cited symbols.** List every referenced symbol by kind, quoting the plan line for each (coverage must be auditable): decorators (`@name`), classes/methods (`Class.method`), functions (`module.function`), CLI flags (`--name`), file paths, dataclass/struct fields.
2. **Exclude new artifacts.** Do NOT verify symbols the plan declares under its "Artifacts this phase produces" section — those are created by this phase, not references to existing code.
3. **Resolve each remaining symbol** using the effective authority adapter (resolved deterministically — see step 4a):
   - `grep` — ripgrep / Read the source; confirm the name appears as a real declaration.
   - `intel` — consult `.planning/intel/API-SURFACE.md` / `api-map.json` (only when `intel.enabled`).
   Record one verdict per symbol: **VERIFIED** (quote `file:line`), **MISSING** (adapter can check this language/kind and the symbol is absent), **AMBIGUOUS** (multiple candidates), or **UNCHECKABLE** (adapter cannot analyze this language/kind — e.g. non-JS under `intel`, or any signature under `grep`). Never treat UNCHECKABLE as verified or missing.
4a. **Resolve effective authority** (deterministic — replaces manual `intel.enabled` reasoning):
   ```bash
   EFFECTIVE_AUTHORITY=$(gsd_run drift-guard authority --raw)
   ```
4. **Severity & gating** — classify each symbol's verdict using the seam (do not apply the table manually):
   ```bash
   # For each symbol, e.g.:
   RESULT=$(gsd_run drift-guard severity --status <verdict> --authority "$EFFECTIVE_AUTHORITY")
   # $RESULT is JSON: {"severity":"…","hardBlock":true|false}
   ```
   - `hardBlock: true` (HIGH at authority `lsp`/`scip`) — stops the review cycle immediately; do not proceed until the plan author resolves the missing symbol.
   - `hardBlock: false`, severity `needs-acknowledgement` — plan proceeds only if the author confirms the symbol is genuinely new or dynamically resolved, and that acknowledgement is recorded.
   - `AMBIGUOUS` → MEDIUM. `UNCHECKABLE` → INFO.
   - Signature mismatches cannot be asserted under `grep`/`intel`; report the signature as UNCHECKABLE.
5. **Coverage block.** Append a "Verification coverage" section to `REVIEWS.md` listing every UNCHECKABLE/skipped symbol and why — a clean review must never silently mean "nothing was checked."

### Cross-artifact fact-drift pass (same gate: `plan_review.source_grounding`)

Run this pass whenever the source-grounding pass ran — it is the second axis of the same drift guard, gated by the same `plan_review.source_grounding` key and adding no config surface of its own. Where source-grounding asks *"does this symbol exist in the source?"*, this asks *"does the project state the same fact in two planning artifacts, and do the two disagree?"* Because each phase runs in a fresh context, an agent typically reads only one artifact and trusts it, so a stale duplicate silently steers it wrong.

**Key on knowledge, not on similar text.** DRY is about a single authoritative representation of a piece of *knowledge*. Two passages that merely read alike, or that restate one fact at different levels of detail, are NOT drift. Only a contradiction is.

1. **Phase status — decided by the seam, not by judgment.** Do not eyeball this axis:

   ```bash
   DRIFT=$(gsd_run drift-guard phase-status --phase "${PHASE}")
   # $DRIFT is JSON: {"verdict":"consistent|lag|drifted|uncheckable","stateStatus":…,"roadmapStatus":…}
   ```

   - `drifted` — STATE.md and ROADMAP.md contradict each other. Report it; the authority is STATE.md.
   - `lag` — one lifecycle step apart between non-terminal statuses. NOT a finding.
   - `consistent` — nothing to report.
   - `uncheckable` — a document was absent or carried a status outside both vocabularies. Record it in the coverage block; never read it as consistent.

   Completeness is terminal: when exactly one side says the phase is complete, the verdict is `drifted` and never `lag`, however few steps apart the two words look.

2. **Pair up the remaining facts by judgment.** The authority column names the source of truth, so a finding can say which side to keep:

   | Fact class | Artifact pair | Authority | Decided by |
   |---|---|---|---|
   | Success criteria / must-have truths | ROADMAP.md Success Criteria ↔ PLAN.md `must_haves.truths` | ROADMAP.md | judgment |
   | Requirement IDs | ROADMAP.md `**Requirements:**` ↔ PLAN.md task requirement refs | ROADMAP.md | judgment |
   | Phase status | STATE.md status ↔ ROADMAP.md phase state | STATE.md | step 1 (deterministic) |
   | Glossary / domain term | CONTEXT.md `Decisions` ↔ PLAN.md usage of the term | CONTEXT.md | judgment |

3. **Judge each judgment pair.** FLAG only when ALL THREE hold:

   1. both sides name the *same* fact — same requirement ID, same success criterion, or the same defined term; and
   2. the two representations *contradict*, one asserting what the other denies, rather than differing in wording or in level of detail; and
   3. the pair is one of the judgment pairs above.

4. **Record.** Emit each finding into `REVIEWS.md` beside the source-grounding coverage block, quoting both locations and naming the divergence and the authority, so the author can collapse the two copies to a single source of truth.

**Do NOT flag:** a wording-only difference that asserts the same thing; a fact that appears in one artifact only — single-source is the target state, not a finding; a PLAN that ADDS a truth beyond the roadmap Success Criteria, which is sanctioned (plans may add, never subtract); a `lag` verdict from step 1 — two non-terminal statuses a single lifecycle step apart, in either direction, since STATE.md is written at planning time independently of ROADMAP.md and can lead as readily as trail (a disagreement about *completion* is never lag, and step 1 already reports it as `drifted`); anything under CONTEXT.md's `Claude's Discretion` or `Deferred Ideas`, which are non-authoritative by design.

**Report once, not twice — these belong to `gsd-plan-checker`:** a PLAN that omits a roadmap Success Criterion is scope reduction (Dimension 7b); a requirement ID the ROADMAP never defines is requirement coverage (Dimension 1); two PLAN.md files in one phase disagreeing is cross-plan data contracts (Dimension 9).

**Severity: advisory, never a blocker.** This pass never sets `hardBlock`, and its findings contribute to neither `HIGH_COUNT` nor `ACTIONABLE_COUNT` — a project carrying pre-existing drift must still be able to converge, or an advisory check becomes an endless replan loop.

**Coverage, never silence.** If STATE.md or CONTEXT.md is absent, that axis is skipped and the skip is recorded in the same "Verification coverage" block. A clean pass must never mean "nothing was compared."

After agent returns, verify REVIEWS.md exists. Assign the path directly and quote it — an unquoted
`${phase_dir}` inside `$(ls …)` word-splits and glob-expands, and a discarded stderr hides it (#3899):
```bash
if [ -z "${phase_dir}" ]; then
  echo "ERROR: phase_dir is empty — cannot resolve the expected REVIEWS.md path." >&2
  exit 1
fi
REVIEWS_FILE="${phase_dir}/${padded_phase}-REVIEWS.md"
if [ ! -f "${REVIEWS_FILE}" ] || [ ! -r "${REVIEWS_FILE}" ]; then
  echo "ERROR: expected reviews file is not a readable file: '${REVIEWS_FILE}'. Confirm the phase directory resolved correctly before concluding the review agent produced nothing." >&2
  exit 1
fi
```

### 5b. Extract unresolved counts from CYCLE_SUMMARY Contract

**Do NOT grep REVIEWS.md for HIGH or actionable counts.** REVIEWS.md accumulates history across cycles — resolved findings from prior cycles remain in the file as audit trail, inflating a raw grep count and causing false stall detection.

Parse HIGH_COUNT and ACTIONABLE_COUNT from the review agent's return message via the CYCLE_SUMMARY contract:

```bash
# Extract integers from "CYCLE_SUMMARY: current_high=N current_actionable=M" in the agent's return message
SUMMARY_LINE=$(echo "$REVIEW_AGENT_RETURN" | grep -oE 'CYCLE_SUMMARY:.*' | head -1)
HIGH_COUNT=$(echo "$SUMMARY_LINE" | grep -oE 'current_high=[0-9]+' | head -1 | grep -oE '[0-9]+$')
ACTIONABLE_COUNT=$(echo "$SUMMARY_LINE" | grep -oE 'current_actionable=[0-9]+' | head -1 | grep -oE '[0-9]+$')

if [ -z "$SUMMARY_LINE" ]; then
  echo "Review agent did not honor the CYCLE_SUMMARY contract — cannot determine unresolved review counts. Retry or switch reviewer."
  exit 1
fi

if [ -z "$HIGH_COUNT" ]; then
  echo "CYCLE_SUMMARY present but current_high is missing or malformed — expected integer, got non-numeric or absent value. Retry or switch reviewer."
  exit 1
fi

if [ -z "$ACTIONABLE_COUNT" ]; then
  echo "CYCLE_SUMMARY present but current_actionable is missing or malformed — expected integer, got non-numeric or absent value. Retry or switch reviewer."
  exit 1
fi

UNRESOLVED_COUNT=$((HIGH_COUNT + ACTIONABLE_COUNT))

# Extract the ## Current HIGH Concerns section from the agent's return message
HIGH_LINES=$(echo "$REVIEW_AGENT_RETURN" | awk '/^## Current HIGH Concerns/{found=1; next} found && /^##/{exit} found{print}')
ACTIONABLE_LINES=$(echo "$REVIEW_AGENT_RETURN" | awk '/^## Current Actionable Non-HIGH Concerns/{found=1; next} found && /^##/{exit} found{print}')

if [ "${HIGH_COUNT}" -gt 0 ] && [ -z "${HIGH_LINES}" ]; then
  echo "⚠ Review agent's CYCLE_SUMMARY reports ${HIGH_COUNT} HIGHs but did not provide ## Current HIGH Concerns section — continuing with incomplete escalation details."
fi

if [ "${ACTIONABLE_COUNT}" -gt 0 ] && [ -z "${ACTIONABLE_LINES}" ]; then
  echo "⚠ Review agent's CYCLE_SUMMARY reports ${ACTIONABLE_COUNT} actionable non-HIGH concerns but did not provide ## Current Actionable Non-HIGH Concerns section — continuing with incomplete escalation details."
fi
```

**Open plan-revision conflicts are part of the converged condition (#3771).** An entry under
`## Plan-Revision Conflicts` in REVIEWS.md is a checker `fix_hint` that contradicted a locked
decision, capability guidance, or an existing plan constraint, recorded by `/gsd:plan-phase`
together with the alternatives the planner considered. It is NOT counted by `CYCLE_SUMMARY`, so
it must be read from the file directly — evaluate this BEFORE the converged branch below, or a
run would write `planned-phase` and print the success banner over a conflict nobody resolved:

```bash
if [ ! -f "${REVIEWS_FILE}" ]; then
  # Fail CLOSED. A missing/non-file REVIEWS.md is "I cannot tell", never "no conflicts".
  echo "BLOCKED: cannot read REVIEWS.md ('${REVIEWS_FILE}') to check for open plan-revision conflicts. Refusing to declare convergence on an unverifiable gate." >&2
  exit 1
fi
if OPEN_CONFLICTS=$(awk '
  BEGIN { saw_title = 0; in_owned = 0; saw_heading = 0; done = 0; count = 0 }
  { sub(/\r$/, "") }
  !saw_title && /^# Cross-AI Plan Review — Phase / { saw_title = 1; next }
  saw_title && !in_owned && !done {
    if ($0 == "") next
    if ($0 == "<!-- gsd:plan-revision-conflicts:begin -->") { in_owned = 1; next }
    exit 2
  }
  in_owned && $0 == "<!-- gsd:plan-revision-conflicts:begin -->" { exit 2 }
  in_owned && !saw_heading && $0 == "" { next }
  in_owned && !saw_heading && $0 == "## Plan-Revision Conflicts" { saw_heading = 1; next }
  in_owned && !saw_heading { exit 2 }
  in_owned && $0 == "<!-- gsd:plan-revision-conflicts:end -->" {
    done = 1
    in_owned = 0
    print count
    exit
  }
  in_owned && /^- \[ \] REVISION_CONFLICT .*required_property:/ { count++ }
  END { if (!done) exit 2 }
' "${REVIEWS_FILE}"); then
  :
else
  awk_status=$?
  echo "BLOCKED: could not parse the writer-owned plan-revision conflict block in '${REVIEWS_FILE}' (awk exit ${awk_status}). Refusing to declare convergence on an unverifiable gate." >&2
  exit 1
fi
```

`/gsd:review` emits exactly one writer-owned slot immediately after the artifact title,
between `<!-- gsd:plan-revision-conflicts:begin -->` and
`<!-- gsd:plan-revision-conflicts:end -->`. Inside that slot, `/gsd:plan-phase` records each
conflict as a `- [ ] REVISION_CONFLICT` checklist line and flips it to
`- [x] REVISION_CONFLICT` when resolved. The reader counts only the first fixed slot at that
position and stops at its explicit end delimiter. Reviewer output is rendered after the slot, so
raw reviewer text containing either the heading or an exact conflict-shaped checklist line cannot
forge blocking state. There is deliberately no fallback to the prior global line-shape scan: that
shape never merged to `next`, and accepting both grammars would recreate the reviewer collision.

**Only `/gsd:plan-phase` mutates the contents of this slot.** The review agent preserves the
existing `## Plan-Revision Conflicts` block byte-for-byte between its delimiters; every other
agent with write access to REVIEWS.md must leave it alone. Appending, editing, reordering or
deleting a line there forges the state of a blocking gate. Readers read. If `OPEN_CONFLICTS` > 0, convergence has NOT been
achieved regardless of the counts: skip the converged branch and continue to 5c so the next cycle
arbitrates. Escalation at `MAX_CYCLES` is unchanged and still terminates the loop, so an
unresolvable conflict escalates rather than deadlocking.

**If HIGH_COUNT == 0 and ACTIONABLE_COUNT == 0 and OPEN_CONFLICTS == 0 (converged):**

```bash
gsd_run state planned-phase --phase "${PHASE}" --name "${phase_name}" --plans "${PLAN_COUNT}"
```

Display:
```text
### GSD ► CONVERGENCE COMPLETE ✓

 Phase {phase_number} converged in {cycle} cycle(s).
 No HIGH concerns remaining.
 No actionable MEDIUM/LOW review findings remain outside PLAN.md.

 REVIEWS.md: {REVIEWS_FILE}
 Next: /gsd:execute-phase {PHASE}
```

Exit — convergence achieved.

**If HIGH_COUNT > 0 or ACTIONABLE_COUNT > 0 or OPEN_CONFLICTS > 0:** Continue to 5c.

### 5c. Stall Detection + Escalation Check

Display: `◆ Cycle {cycle}/{MAX_CYCLES} — {HIGH_COUNT} HIGH, {ACTIONABLE_COUNT} actionable non-HIGH review concerns, {OPEN_CONFLICTS} open plan-revision conflicts found`

**Stall detection:** If `UNRESOLVED_COUNT >= prev_unresolved_count`:
```text
⚠ Convergence stalled — unresolved review concern count not decreasing
  ({UNRESOLVED_COUNT} unresolved concerns, previous cycle had {prev_unresolved_count})
```

**Max cycles check:** If `cycle >= MAX_CYCLES`:

**If `OPEN_CONFLICTS` > 0 (#3771): "Proceed anyway" is never offered.** An open plan-revision
conflict is a blocker — this loop's whole purpose is to surface it rather than let a success
banner paper over it, so escalation cannot end in the same silent acceptance a HIGH/actionable
concern can. Only "Manual review" is available:

If `TEXT_MODE` is true, present as plain text:
```text
Plan convergence did not complete after {MAX_CYCLES} cycles.
{OPEN_CONFLICTS} open plan-revision conflict(s) remain — these are blockers and cannot be accepted:

{HIGH_LINES}

{ACTIONABLE_LINES}

Review the concerns in: {REVIEWS_FILE}

To replan manually:  /gsd:plan-phase {PHASE} --reviews
To restart loop:     /gsd:plan-review-convergence {PHASE} {REVIEWER_FLAGS}
```
Exit workflow.

**Otherwise (`OPEN_CONFLICTS` == 0):**

If `TEXT_MODE` is true, present as plain-text numbered list:
```text
Plan convergence did not complete after {MAX_CYCLES} cycles.
{HIGH_COUNT} HIGH concerns and {ACTIONABLE_COUNT} actionable non-HIGH concerns remain:

{HIGH_LINES}

{ACTIONABLE_LINES}

How would you like to proceed?

1. Proceed anyway — Accept plans with remaining review concerns and move to execution
2. Manual review — Stop here, review REVIEWS.md and address concerns manually

Enter number:
```

Otherwise use AskUserQuestion:
```js
AskUserQuestion([
  {
    question: "Plan convergence did not complete after {MAX_CYCLES} cycles. {HIGH_COUNT} HIGH concerns and {ACTIONABLE_COUNT} actionable non-HIGH concerns remain:\n\n{HIGH_LINES}\n\n{ACTIONABLE_LINES}\n\nHow would you like to proceed?",
    header: "Convergence",
    multiSelect: false,
    options: [
      { label: "Proceed anyway", description: "Accept plans with remaining review concerns and move to execution" },
      { label: "Manual review", description: "Stop here — review REVIEWS.md and address concerns manually" }
    ]
  }
])
```

If "Proceed anyway": Display final status and exit.
If "Manual review":
```text
Review the concerns in: {REVIEWS_FILE}

To replan manually:  /gsd:plan-phase {PHASE} --reviews
To restart loop:     /gsd:plan-review-convergence {PHASE} {REVIEWER_FLAGS}
```
Exit workflow.

### 5d. Replan (Inline)

**If under max cycles:**

Update `prev_unresolved_count = UNRESOLVED_COUNT`.

Display: `◆ Replanning inline with review feedback... (plan-phase runs here in the orchestrator — no output until replanning is complete, ~1–5 min; expected, not a freeze)`

```text
Skill(skill="gsd-plan-phase", args="{PHASE} --reviews --skip-research {GSD_WS}")
```

Run plan-phase **inline** (do NOT wrap it in Agent()). Same rationale as step 4: the convergence orchestrator runs at depth 0 with Agent available, so inline plan-phase can spawn gsd-planner and gsd-plan-checker at depth 1. Wrapping in Agent() pushes plan-phase to depth 1 where the Agent tool is absent — the replan loop can never produce a revised plan when HIGHs are found. This is the root cause of bug #936. Actionable MEDIUM/LOW findings must be incorporated into executable PLAN.md content or explicitly deferred/rejected in the relevant PLAN.md before convergence can complete. The same holds for any open `## Plan-Revision Conflicts` entry (#3771): the replan must resolve it by adopting one of its recorded alternatives, overriding the named constraint, or amending the constraint — and mark the entry resolved. Re-running the planner against an unchanged conflict cannot resolve it and only burns a cycle. Wait until plan-phase completes (outputs '## PLANNING COMPLETE') and updated PLAN.md files are committed before continuing.

After plan-phase completes → go back to **step 5a** (review again).

</process>

<success_criteria>
- [ ] Config gate checked before running — exits with enable instructions if workflow.plan_review_convergence is false
- [ ] Initial planning via inline Skill("gsd-plan-phase") if no plans exist — NOT wrapped in Agent() (bug #936: depth-1 Agent has no Agent tool)
- [ ] Review via Agent → Skill("gsd-review") — isolated Agent is correct; gsd-review is a Bash leaf with no sub-agent spawns; {GSD_WS} forwarded
- [ ] Replan via inline Skill("gsd-plan-phase --reviews") — NOT wrapped in Agent(); inline lets plan-phase spawn gsd-planner/gsd-plan-checker at depth 1
- [ ] Orchestrator only does: init, config gate, loop control, parse CYCLE_SUMMARY for HIGH and actionable non-HIGH counts, stall detection, escalation
- [ ] HIGH and actionable non-HIGH counts extracted from review agent's CYCLE_SUMMARY return message (not by grepping REVIEWS.md)
- [ ] Review agent prompt defines CYCLE_SUMMARY: current_high=<N> current_actionable=<M> contract with PARTIALLY/FULLY RESOLVED/ACTIONABLE definitions
- [ ] Abort with clear error if CYCLE_SUMMARY is absent; distinguish malformed from absent
- [ ] Warn if HIGH_COUNT > 0 but ## Current HIGH Concerns section is absent from return message
- [ ] Abort with clear error if current_actionable is absent or malformed
- [ ] Warn if ACTIONABLE_COUNT > 0 but ## Current Actionable Non-HIGH Concerns section is absent from return message
- [ ] The review Agent fully completes gsd-review before returning (plan-phase runs inline — no Agent wrap)
- [ ] Loop exits on: no HIGH concerns, no actionable non-HIGH concerns, and OPEN_CONFLICTS == 0 (converged) OR max cycles (escalation)
- [ ] OPEN_CONFLICTS read from REVIEWS.md and evaluated BEFORE the converged branch writes state or prints the banner
- [ ] Stall detection reported when total unresolved review concern count is not decreasing
- [ ] STATE.md updated on convergence completion
</success_criteria>

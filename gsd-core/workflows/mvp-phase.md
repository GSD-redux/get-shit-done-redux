<purpose>
Guide the user through MVP-mode planning for a phase. Prompts for an "As a / I want to / So that" user story, runs SPIDR splitting check on the story, writes the result to ROADMAP.md, and delegates to `/gsd plan-phase` (which auto-detects MVP via the roadmap mode field shipped in PRD Phase 1).
</purpose>

<required_reading>
@~/.claude/gsd-core/references/user-story-template.md
@~/.claude/gsd-core/references/spidr-splitting.md
@~/.claude/gsd-core/references/planner-mvp-mode.md
</required_reading>

<runtime_note>
**Copilot (VS Code):** Use `vscode_askquestions` wherever this workflow calls `AskUserQuestion`. They are equivalent.

**TEXT_MODE fallback:** Set TEXT_MODE=true if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is true. When TEXT_MODE is active, replace every AskUserQuestion call with a plain-text numbered list and ask the user to type their choice number.
</runtime_note>

<process>

## 1. Parse and validate phase argument

Extract the phase number from `$ARGUMENTS` (integer or decimal like `2.1`). Optional flag: `--force` (allow operating on `in_progress` / `completed` phases).

If no argument:
```
ERROR: Phase number required
Usage: /gsd mvp-phase <phase-number>
Example: /gsd mvp-phase 1
Example: /gsd mvp-phase 2.1
```
Exit.

Normalize per `@~/.claude/gsd-core/references/phase-argument-parsing.md` (zero-pad integer phases to two digits).

## 2. Validate phase exists and check status

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --raw --default "" 2>/dev/null || echo "")
PHASE_INFO=$(gsd_run query roadmap.get-phase "${PHASE}")
PHASE_FOUND=$(echo "$PHASE_INFO" | jq -r '.found')
PHASE_NAME=$(echo "$PHASE_INFO" | jq -r '.phase_name')
PHASE_GOAL=$(echo "$PHASE_INFO" | jq -r '.goal')
PHASE_MODE=$(echo "$PHASE_INFO" | jq -r '.mode // ""')
ANALYZE=$(gsd_run query roadmap.analyze)
if [[ "$ANALYZE" == @file:* ]]; then ANALYZE=$(cat "${ANALYZE#@file:}"); fi
DISK_STATUS=$(echo "$ANALYZE" | jq -r --arg p "$PHASE" '.phases[] | select((.phase_number|tostring)==$p) | .disk_status' | head -1)
# ADR-3180 §7.4 (issue #3186, disk-strict, #2957): DISK_STATUS alone decides
# completion — a ROADMAP checkbox carries no machine authority and is never
# ORed in here. `roadmap.analyze`'s `disk_status` already routes through the
# canonical owner (`isPhaseComplete`), so this is the same predicate the read
# and write paths both use.
if [[ "$DISK_STATUS" == "complete" ]]; then
  STATUS="completed"
elif [[ "$DISK_STATUS" == "planned" || "$DISK_STATUS" == "partial" ]]; then
  STATUS="in_progress"
else
  STATUS="not_started"
fi
```

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

If `PHASE_FOUND` is `false`: error and exit. Suggest `/gsd add-phase` or `/gsd insert-phase` to create the phase first.

**Status guard.** If the phase is `in_progress` (has plans but not complete) or `completed`, refuse unless `--force` is in `$ARGUMENTS`:

```text
ERROR: Phase ${PHASE} is currently ${STATUS}.
Converting an active or completed phase to MVP mode mid-flight will
invalidate any existing plans and summaries.

To proceed anyway: /gsd mvp-phase ${PHASE} --force
```

**Already-MVP guard.** If `PHASE_MODE` is already `mvp`, surface this and ask whether to re-prompt the user story or abort:

> "Phase ${PHASE} is already in MVP mode with goal: «${PHASE_GOAL}». Re-run user-story prompts and SPIDR check?"

Use `AskUserQuestion` with options [Re-prompt / Abort]. On Abort, exit cleanly. On Re-prompt, proceed.

## 3. User story prompts

Run three sequential `AskUserQuestion` calls. Each is free-text. After all three, assemble into the canonical sentence per `@~/.claude/gsd-core/references/user-story-template.md`:

**Prompt 1 — As a:**
> "As a [user role]?"
> (Examples: "new user", "admin", "signed-in customer", "API consumer")

**Prompt 2 — I want to:**
> "I want to [capability]?"
> (Examples: "register and log in", "upload a CSV", "see my dashboard")

**Prompt 3 — So that:**
> "So that [outcome]?"
> (Examples: "I can access my account", "I can bulk-import contacts", "I can see at a glance what needs attention")

Assemble:

```
USER_STORY="As a ${ROLE}, I want to ${CAPABILITY}, so that ${OUTCOME}."
```

If any of the three answers is empty or whitespace-only, error and re-prompt that single field. Do NOT proceed with a partial story.

**Validate via the centralized User Story validator.** The verb owns the canonical regex `/^As a .+, I want to .+, so that .+\.$/` and surfaces per-error guidance:

```bash
USER_STORY_RESULT=$(gsd_run query user-story.validate --story "$USER_STORY")
if [ "$(echo "$USER_STORY_RESULT" | jq -r '.valid')" != "true" ]; then
  echo "$USER_STORY_RESULT" | jq -r '.errors[]' >&2
  # Re-prompt the offending field(s) per surfaced errors, then re-run validation.
  # Do not abort the workflow on first invalid draft.
  RE_PROMPT_USER_STORY=true
fi
```

This guarantees the goal stored in ROADMAP.md will satisfy the same guard the verifier applies later.
If `RE_PROMPT_USER_STORY=true`, re-run only the offending prompt field(s), rebuild `USER_STORY`, and validate again before continuing.

## 4. SPIDR splitting check

Run the SPIDR rules from `@~/.claude/gsd-core/references/spidr-splitting.md`. Briefly:

**Trigger evaluation.** Check the assembled `USER_STORY` against the four size signals from the reference (compound capabilities, multi-actor, length > 120 chars, vague capability). If none fire, **skip SPIDR** entirely — go to step 5.

**If SPIDR triggers.**

a) Restate the story to the user:

> "Your story: «${USER_STORY}»
>
> This story has [signal description, e.g., 'two compound capabilities joined by and']. Splitting it into multiple phases will produce a cleaner Walking Skeleton and reduce the risk of mid-phase scope creep.
>
> Want to walk through SPIDR splitting?"

Use `AskUserQuestion` with options [Yes, walk through SPIDR / No, proceed with the story as-is].

If "No": skip SPIDR, go to step 5.

If "Yes": continue to (b).

b) Ask which SPIDR axis fits best:

> "Which axis best fits how to split this story?"

Use `AskUserQuestion` with the five options from `spidr-splitting.md` (Spike / Paths / Interfaces / Data / Rules). Each option includes its targeted question as the description so the user can pick by understanding what each axis means.

c) Walk through the chosen axis with **one** targeted question (not all five). For example, if the user picked "Paths":

> "Does this feature have a happy path and one or more error/edge paths?"

Free-text response. Workflow parses to identify the split.

d) Produce a split proposal. Example:

> "Proposed split (Paths axis):
> - **Phase ${PHASE} (this one):** Happy path — ${HAPPY_STORY}
> - **Phase ${PHASE+1} (new):** Edge case — ${EDGE_STORY}
>
> Accept this split?"

Use `AskUserQuestion` [Accept / Modify / Reject].

- **Accept**: `USER_STORY` becomes the first split's story (`${HAPPY_STORY}` in the example). Surface the remaining splits as a list of `/gsd add-phase` invocations the user can run after this command completes — do NOT auto-create the new phases (preserve user control over numbering).
- **Modify**: re-prompt the splits one more time, then accept or reject.
- **Reject**: revert `USER_STORY` to the original, proceed without splitting.

## 5. Update ROADMAP.md

Read `ROADMAP.md`. Find the section for `Phase ${PHASE}`. Apply two edits:

**Edit 1 — Update Goal line.**

Find: `**Goal:** ${OLD_GOAL_TEXT}`
Replace with: `**Goal:** ${USER_STORY}`

**Edit 2 — Insert Mode line.**

If `**Mode:**` already exists in the section (replacing or re-running), update it to `**Mode:** mvp`.
If `**Mode:**` does not exist, insert `**Mode:** mvp` on the line immediately after `**Goal:**`.

Show the user a unified diff (lines being changed) and ask:

> "Apply these changes to ROADMAP.md?"

Use `AskUserQuestion` [Apply / Cancel]. On Cancel, exit without writing.

On Apply, write the updated `ROADMAP.md` atomically (read-edit-write).

## 6. Verify the write

```bash
NEW_MODE=$(gsd_run query roadmap.get-phase "${PHASE}" --pick mode)
NEW_GOAL=$(gsd_run query roadmap.get-phase "${PHASE}" --pick goal)
```

Assert:
- `NEW_MODE` equals `mvp`
- `NEW_GOAL` equals the assembled user story

If either assertion fails, surface the discrepancy to the user and exit. Do not proceed to plan-phase delegation with a half-applied write.

## 7. Delegate to /gsd plan-phase

Invoke `/gsd plan-phase ${PHASE}` (no flags). Phase 1's MVP_MODE resolution chain (CLI flag → roadmap mode → config → false) will detect the new `**Mode:** mvp` line and run plan-phase in vertical-slice mode automatically.

The Walking Skeleton gate (also from Phase 1) will fire automatically if `${PHASE} == "01"` and there are zero prior phase summaries.

## 8. Surface deferred phase splits (if any)

If SPIDR produced a split in step 4, append a final user-facing message:

> "**SPIDR split deferred phases.**
>
> Your original story was split. The first slice is now planned via plan-phase.
> To create the remaining slice(s) as new phases, run:
>
> - `/gsd add-phase` — for the next slice: «${SPLIT_2_STORY}»
> - `/gsd add-phase` — for the next slice: «${SPLIT_3_STORY}»
>
> Each will be added to the end of the current milestone. You can then run
> `/gsd mvp-phase <new-phase-number>` on each to plan them as MVP slices."

## 9. Exit

Workflow ends. The phase is now in MVP mode with a planned PLAN.md, optionally with deferred follow-up phases surfaced for the user.

</process>

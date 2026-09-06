<purpose>

Mark a shipped version (v1.0, v1.1, v2.0) as complete. Creates historical record in MILESTONES.md, performs full PROJECT.md evolution review, reorganizes ROADMAP.md with milestone groupings, and tags the release in git.

</purpose>

<required_reading>

1. templates/milestone.md
2. templates/milestone-archive.md
3. `.planning/ROADMAP.md`
4. `.planning/REQUIREMENTS.md`
5. `.planning/PROJECT.md`

</required_reading>

<archival_behavior>

When a milestone completes:

1. Extract full milestone details to `.planning/milestones/v[X.Y]-ROADMAP.md`
2. Archive requirements to `.planning/milestones/v[X.Y]-REQUIREMENTS.md`
3. Update ROADMAP.md — overwrite in place with milestone grouping (preserve Backlog section)
4. Safety commit archive files + updated ROADMAP.md, then `git rm REQUIREMENTS.md` (fresh for next milestone)
5. Perform full PROJECT.md evolution review
6. Offer to create next milestone inline
7. Archive UI artifacts (`*-UI-SPEC.md`, `*-UI-REVIEW.md`) alongside other phase documents
8. Clean up `.planning/ui-reviews/` screenshot files (binary assets, never archived)

**Context Efficiency:** Archives keep ROADMAP.md constant-size and REQUIREMENTS.md milestone-scoped.

**ROADMAP archive** uses `templates/milestone-archive.md` — includes milestone header (status, phases, date), full phase details, milestone summary (decisions, issues, tech debt).

**REQUIREMENTS archive** contains all requirements marked complete with outcomes, traceability table with final status, notes on changed requirements.

</archival_behavior>

<process>

<step name="pre_close_artifact_audit">
Before proceeding with milestone close, run the comprehensive open artifact audit.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --raw --default "" 2>/dev/null || echo "")
gsd_run query audit-open
```

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

If the output contains open items (any section with count > 0):

Display the full audit report to the user.

Then ask:
```
These items are open. Choose an action:
[R] Resolve — stop and fix items, then re-run /gsd:complete-milestone
[A] Acknowledge all — document as deferred and proceed with close
[C] Cancel — exit without closing
```

If user chooses [A] (Acknowledge):
1. Re-run `gsd_run query audit-open --json` to get structured data.
2. Acknowledge every open item through the `audit-open acknowledge` CLI writer — this is what actually suppresses each item starting at the NEXT `audit-open` scan; the STATE.md table in step 3 is a disclosure record only, it is no longer the suppression mechanism. Every acknowledge call's exit status is accumulated (`ACK_FAILURES`); the step HALTS before closing if any failed — a refusal (`unsupported_heading_shape`, `ambiguous`, `not_found`, missing file, etc.) must never be silently discarded and let the close proceed as if everything were suppressed. `AUDIT_JSON` uses the same `@file:` large-payload sentinel handling `INIT_MANAGER` uses in `verify_readiness` below — `io.output` swaps any JSON payload over 50000 chars for a `@file:<path>` marker, and feeding that literal string to `jq` would silently make every loop body below iterate zero times:
   ```bash
   AUDIT_JSON=$(gsd_run query audit-open --json)
   if [[ "$AUDIT_JSON" == @file:* ]]; then AUDIT_JSON=$(cat "${AUDIT_JSON#@file:}"); fi
   MILESTONE_VERSION="v[X.Y]"   # already known from ROADMAP.md's active milestone header — the same identifier `milestone.complete` uses in the archive_milestone step

   ACK_FAILURES=0
   ACK_FAILURE_LOG=""
   record_ack_failure() {
     ACK_FAILURES=$((ACK_FAILURES + 1))
     ACK_FAILURE_LOG="${ACK_FAILURE_LOG}
   - $1"
   }

   # debug_sessions / threads (--slug)
   # NOTE: `< <(...)` process substitution, not `... | while`, so the loop
   # runs in THIS shell — a `| while` pipeline puts the loop in a subshell
   # and any ACK_FAILURES/ACK_FAILURE_LOG update inside it is lost the
   # moment the pipeline exits.
   for cat in debug_sessions threads; do
     while IFS= read -r slug; do
       [ -z "$slug" ] && continue
       if ! gsd_run query audit-open acknowledge --category "$cat" --milestone "$MILESTONE_VERSION" --slug "$slug"; then
         record_ack_failure "$cat slug=$slug"
       fi
     done < <(printf '%s' "$AUDIT_JSON" | jq -r --arg cat "$cat" '.items[$cat][] | select(.scan_error | not) | .slug')
   done

   # seeds (--seed-id)
   while IFS= read -r seed_id; do
     [ -z "$seed_id" ] && continue
     if ! gsd_run query audit-open acknowledge --category seeds --milestone "$MILESTONE_VERSION" --seed-id "$seed_id"; then
       record_ack_failure "seeds seed_id=$seed_id"
     fi
   done < <(printf '%s' "$AUDIT_JSON" | jq -r '.items.seeds[] | select(.scan_error | not) | .seed_id')

   # todos (--filename) — the scanner caps its list to 5 entries per scan
   # (remainder items carry `_remainder_count`, no `filename`, and are skipped)
   while IFS= read -r filename; do
     [ -z "$filename" ] && continue
     if ! gsd_run query audit-open acknowledge --category todos --milestone "$MILESTONE_VERSION" --filename "$filename"; then
       record_ack_failure "todos filename=$filename"
     fi
   done < <(printf '%s' "$AUDIT_JSON" | jq -r '.items.todos[] | select((.scan_error or ._remainder_count) | not) | .filename')

   # quick_tasks (--dir) — the scanner's `slug` strips a leading
   # YYYYMMDD-/YYYY-MM-DD- date prefix for display; `--dir` needs the
   # ORIGINAL .planning/quick/<dir>/ name, so reconstruct it from `date`+`slug`.
   while IFS= read -r dir; do
     [ -z "$dir" ] && continue
     if ! gsd_run query audit-open acknowledge --category quick_tasks --milestone "$MILESTONE_VERSION" --dir "$dir"; then
       record_ack_failure "quick_tasks dir=$dir"
     fi
   done < <(printf '%s' "$AUDIT_JSON" | jq -r '.items.quick_tasks[] | select(.scan_error | not) | if .date != "" then "\(.date)-\(.slug)" else .slug end')

   # uat_gaps / verification_gaps / context_questions — phase-scoped
   # (--phase --file [--archived-milestone] when the item was found in an archived phase)
   for cat in uat_gaps verification_gaps context_questions; do
     while IFS= read -r item; do
       [ -z "$item" ] && continue
       phase=$(printf '%s' "$item" | jq -r '.phase')
       file=$(printf '%s' "$item" | jq -r '.file')
       archived=$(printf '%s' "$item" | jq -r '.archived_milestone // empty')
       if [ -n "$archived" ]; then
         if ! gsd_run query audit-open acknowledge --category "$cat" --milestone "$MILESTONE_VERSION" --phase "$phase" --file "$file" --archived-milestone "$archived"; then
           record_ack_failure "$cat phase=$phase file=$file archived-milestone=$archived"
         fi
       else
         if ! gsd_run query audit-open acknowledge --category "$cat" --milestone "$MILESTONE_VERSION" --phase "$phase" --file "$file"; then
           record_ack_failure "$cat phase=$phase file=$file"
         fi
       fi
     done < <(printf '%s' "$AUDIT_JSON" | jq -c --arg cat "$cat" '.items[$cat][] | select(.scan_error | not)')
   done

   # deferred_items — same phase-scoped identification, plus --text (the
   # exact bullet the audit read, which uniquely identifies the entry)
   while IFS= read -r item; do
     [ -z "$item" ] && continue
     phase=$(printf '%s' "$item" | jq -r '.phase')
     file=$(printf '%s' "$item" | jq -r '.file')
     text=$(printf '%s' "$item" | jq -r '.text')
     archived=$(printf '%s' "$item" | jq -r '.archived_milestone // empty')
     if [ -n "$archived" ]; then
       if ! gsd_run query audit-open acknowledge --category deferred_items --milestone "$MILESTONE_VERSION" --phase "$phase" --file "$file" --text "$text" --archived-milestone "$archived"; then
         record_ack_failure "deferred_items phase=$phase file=$file archived-milestone=$archived"
       fi
     else
       if ! gsd_run query audit-open acknowledge --category deferred_items --milestone "$MILESTONE_VERSION" --phase "$phase" --file "$file" --text "$text"; then
         record_ack_failure "deferred_items phase=$phase file=$file"
       fi
     fi
   done < <(printf '%s' "$AUDIT_JSON" | jq -c '.items.deferred_items[] | select(.scan_error | not)')

   if [ "$ACK_FAILURES" -gt 0 ]; then
     echo "ERROR: $ACK_FAILURES acknowledge call(s) failed — HALTING before milestone close. Resolve each listed item manually (e.g. edit the file directly for unsupported_heading_shape/ambiguous, or re-run the audit if a --text/--file target has since changed) and re-run /gsd:complete-milestone:" >&2
     printf '%s\n' "$ACK_FAILURE_LOG" >&2
     exit 1
   fi
   ```
   `todos` is the only category the scanner caps (5 entries per scan, with a remainder count for the rest). Re-run `gsd_run query audit-open --json` (through the same `@file:` handling above) and repeat the `todos` block until it reports no `todos` items — every other category always returns its full open set in one pass.
3. Re-run `gsd_run query audit-open --json` once more and write the items just acknowledged as new rows to STATE.md under `## Deferred Items` — append to the existing table (creating the section if absent) rather than overwriting it, preserving rows recorded at earlier milestone closes:
   ```markdown
   ## Deferred Items

   Items acknowledged and deferred at milestone close, most recent first:

   | Category | Item | Status | Deferred At | Milestone |
   |----------|------|--------|-------------|-----------|
   | debug_sessions | {slug} | {status} | {date} | {milestone} |
   | quick_tasks | {slug} | {status} | {date} | {milestone} |
   | threads | {slug} | {status} | {date} | {milestone} |
   | seeds | {seed_id} | {status} | {date} | {milestone} |
   | todos | {filename} | (presence-only) | {date} | {milestone} |
   | uat_gaps | {phase}/{file} | {status} | {date} | {milestone} |
   | verification_gaps | {phase}/{file} | {status} | {date} | {milestone} |
   | context_questions | {phase}/{file} | {question_count} questions | {date} | {milestone} |
   | deferred_items | {phase}/{file}: {text} | acknowledged | {date} | {milestone} |
   ```
   One row per item actually acknowledged in step 2 (omit categories with nothing to disclose this close). `{date}` is today's date; `{milestone}` is `MILESTONE_VERSION`. Sanitize all slug/status/text values via `sanitizeForDisplay()` before writing. Never inject raw file content into STATE.md.
4. Set `closeout_type=override_closeout` and record in the MILESTONES.md entry: `Known verification overrides: {N} newly acknowledged, {M} carried forward from a prior close (see STATE.md Deferred Items)` — `{N}` is the count of items acknowledged in step 2 (the pre-acknowledgment audit JSON's `counts.total`) and `{M}` is that same audit JSON's `acknowledged.total` (items a PRIOR close already suppressed and still are).
5. Proceed with milestone close.

Acknowledging is verdict-preserving and self-invalidating: it never rewrites the artifact's own `status:` field (except `deferred_items`, whose entry has no other meaning for that field), and the suppression it grants lapses automatically the moment the artifact's observed state changes again — a reopened debug session, an edited UAT gap, a re-triggered seed, etc. resurfaces on its own at the next audit and must be acknowledged again.

If output shows all clear (no open items): set `closeout_type=verified_closeout`. If the audit JSON's `acknowledged.total` is `0`, print `All artifact types clear.` and proceed. Otherwise the close is clean only because `{acknowledged.total}` item(s) acknowledged at an earlier milestone close are still being suppressed, not because everything was fixed this time — print `All artifact types clear ({acknowledged.total} previously acknowledged item(s) still suppressed — see STATE.md Deferred Items).` and record `Known verification overrides: 0 newly acknowledged, {acknowledged.total} carried forward from a prior close (see STATE.md Deferred Items)` in the MILESTONES.md entry before proceeding.

SECURITY: Audit JSON output is structured data from the `audit-open` query handler (same JSON contract as legacy `gsd_run audit-open`) — validated and sanitized at source. The `audit-open acknowledge` writer is the only path that sets the `audit_acknowledged` suppression marker — it snapshots each artifact's current state itself from the identifiers passed on the command line, so this workflow never hand-authors the marker. When writing the STATE.md disclosure table, item identifiers, statuses, and deferred-item text are sanitized via `sanitizeForDisplay()` before inclusion. Never inject raw user-supplied content into STATE.md without sanitization.
</step>

<step name="verify_readiness">

**Use `init.manager` for canonical readiness check:**

```bash
INIT_MANAGER=$(gsd_run query init.manager)
if [[ "$INIT_MANAGER" == @file:* ]]; then INIT_MANAGER=$(cat "${INIT_MANAGER#@file:}"); fi
```

This returns all phases with implementation and verification projection. Use this to verify:
- Which phases belong to this milestone?
- `all_phases_verified`: all milestone phases have `phase_complete === true` and `verification_status === 'passed'`.
- `progress_percent` should be 100%.

Compute readiness from `INIT_MANAGER`, not from roadmap counts:

```bash
ALL_PHASES_VERIFIED=$(printf '%s' "$INIT_MANAGER" | jq -r '[
  .phases[] | select((.number | tostring | test("^999(\\.|$)") | not))
  | (.phase_complete == true and .verification_status == "passed")
] | all')
```

If not all_phases_verified, verified_closeout must not proceed. Set `closeout_type=override_closeout`, show each phase whose `phase_complete !== true` or `verification_status !== 'passed'`, and require an explicit user choice:
1. **Proceed anyway** — record verification overrides in MILESTONES.md/STATE.md
2. **Run verification first** — `/gsd:verify-work {phase}` or `/gsd:execute-phase {phase}`
3. **Abort** — return to development

Only set `closeout_type=verified_closeout` when `ALL_PHASES_VERIFIED` is `true`.

**Requirements completion check (REQUIRED before presenting):**

Parse REQUIREMENTS.md traceability table:
- Count total v1 requirements vs checked-off (`[x]`) requirements
- Identify any non-Complete rows in the traceability table

Present:

```
Milestone: [Name, e.g., "v1.0 MVP"]

Includes:
- Phase 1: Foundation (2/2 plans complete)
- Phase 2: Authentication (2/2 plans complete)
- Phase 3: Core Features (3/3 plans complete)
- Phase 4: Polish (1/1 plan complete)

Total: {phase_count} phases, {total_plans} plans
Verification: {all_phases_verified ? "all phases verified" : "override needed"}
Closeout type: {closeout_type}
Requirements: {N}/{M} v1 requirements checked off
```

**If requirements incomplete** (N < M):

```
⚠ Unchecked Requirements:

- [ ] {REQ-ID}: {description} (Phase {X})
- [ ] {REQ-ID}: {description} (Phase {Y})
```

MUST present 3 options:
1. **Proceed anyway** — mark milestone complete with known gaps
2. **Run audit first** — `/gsd:audit-milestone` to assess gap severity
3. **Abort** — return to development

If user selects "Proceed anyway": set `closeout_type=override_closeout`; note incomplete requirements in MILESTONES.md under `### Known Gaps` with REQ-IDs and descriptions.

<config-check>

```bash
cat .planning/config.json 2>/dev/null || true
```

</config-check>

<if mode="yolo">

```
⚡ Auto-approved: Milestone scope verification
[Show breakdown summary without prompting]
Proceeding to stats gathering...
```

Proceed to gather_stats.

</if>

<if mode="interactive" OR="custom with gates.confirm_milestone_scope true">

```
Ready to mark this milestone as shipped?
(yes / wait / adjust scope)
```

Wait for confirmation.
- "adjust scope": Ask which phases to include.
- "wait": Stop, user returns when ready.

</if>

</step>

<step name="gather_stats">

Calculate milestone statistics:

```bash
git log --oneline --grep="feat(" | head -20
git diff --stat FIRST_COMMIT..LAST_COMMIT | tail -1
find . -name "*.swift" -o -name "*.ts" -o -name "*.py" | xargs wc -l 2>/dev/null || true
git log --format="%ai" FIRST_COMMIT | tail -1
git log --format="%ai" LAST_COMMIT | head -1
```

Present:

```
Milestone Stats:
- Phases: [X-Y]
- Plans: [Z] total
- Tasks: [N] total (from phase summaries)
- Files modified: [M]
- Lines of code: [LOC] [language]
- Timeline: [Days] days ([Start] → [End])
- Git range: feat(XX-XX) → feat(YY-YY)
```

</step>

<step name="extract_accomplishments">

Extract one-liners from SUMMARY.md files using summary-extract:

```bash
# #2962: zsh aborts the block on an unmatched for-list glob (nomatch); bash passes it through. nullglob both.
shopt -s nullglob 2>/dev/null; setopt NULL_GLOB 2>/dev/null

# For each phase in milestone, extract one-liner
for summary in .planning/phases/*-*/*-SUMMARY.md; do
  [ -e "$summary" ] || continue
  gsd_run query summary-extract "$summary" --fields one_liner --pick one_liner
done
```

Extract 4-6 key accomplishments. Present:

```
Key accomplishments for this milestone:
1. [Achievement from phase 1]
2. [Achievement from phase 2]
3. [Achievement from phase 3]
4. [Achievement from phase 4]
5. [Achievement from phase 5]
```

</step>

<step name="create_milestone_entry">

**Note:** MILESTONES.md entry is now created automatically by `gsd_run query milestone.complete` in the archive_milestone step. The entry includes version, date, phase/plan/task counts, and accomplishments extracted from SUMMARY.md files.

If additional details are needed (e.g., user-provided "Delivered" summary, git range, LOC stats), add them manually after the CLI creates the base entry.

</step>

<step name="evolve_project_full_review">

Full PROJECT.md evolution review at milestone completion.

Read all phase summaries:

```bash
_SUMMARIES=( .planning/phases/*-*/*-SUMMARY.md )
if [ -e "${_SUMMARIES[0]}" ]; then cat "${_SUMMARIES[@]}"; fi
```

**Full review checklist:**

1. **"What This Is" accuracy:**
   - Compare current description to what was built
   - Update if product has meaningfully changed

2. **Core Value check:**
   - Still the right priority? Did shipping reveal a different core value?
   - Update if the ONE thing has shifted

3. **Business Context check (only if the section is present):**
   - Skip entirely if PROJECT.md has no `## Business Context` section
   - Customer, revenue model, and success metric still accurate after shipping?
   - Update any field that drifted; refresh the linked strategy doc reference if it moved

4. **Requirements audit:**

   **Validated section:**
   - All Active requirements shipped this milestone → Move to Validated
   - Format: `- ✓ [Requirement] — v[X.Y]`

   **Active section:**
   - Remove requirements moved to Validated
   - Add new requirements for next milestone
   - Keep unaddressed requirements

   **Out of Scope audit:**
   - Review each item — reasoning still valid?
   - Remove irrelevant items
   - Add requirements invalidated during milestone

5. **Context update:**
   - Current codebase state (LOC, tech stack)
   - User feedback themes (if any)
   - Known issues or technical debt

6. **Key Decisions audit:**
   - Extract all decisions from milestone phase summaries
   - Add to Key Decisions table with outcomes
   - Mark ✓ Good, ⚠️ Revisit, or — Pending

7. **Constraints check:**
   - Any constraints changed during development? Update as needed

Update PROJECT.md inline. Update "Last updated" footer:

```markdown
---
*Last updated: [date] after v[X.Y] milestone*
```

**Example full evolution (v1.0 → v1.1 prep):**

Before:

```markdown
## What This Is

A real-time collaborative whiteboard for remote teams.

## Core Value

Real-time sync that feels instant.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Canvas drawing tools
- [ ] Real-time sync < 500ms
- [ ] User authentication
- [ ] Export to PNG

### Out of Scope

- Mobile app — web-first approach
- Video chat — use external tools
```

After v1.0:

```markdown
## What This Is

A real-time collaborative whiteboard for remote teams with instant sync and drawing tools.

## Core Value

Real-time sync that feels instant.

## Requirements

### Validated

- ✓ Canvas drawing tools — v1.0
- ✓ Real-time sync < 500ms — v1.0 (achieved 200ms avg)
- ✓ User authentication — v1.0

### Active

- [ ] Export to PNG
- [ ] Undo/redo history
- [ ] Shape tools (rectangles, circles)

### Out of Scope

- Mobile app — web-first approach, PWA works well
- Video chat — use external tools
- Offline mode — real-time is core value

## Context

Shipped v1.0 with 2,400 LOC TypeScript.
Tech stack: Next.js, Supabase, Canvas API.
Initial user testing showed demand for shape tools.
```

**Step complete when:**

- [ ] "What This Is" reviewed and updated if needed
- [ ] Core Value verified as still correct
- [ ] Business Context checked (or confirmed absent)
- [ ] All shipped requirements moved to Validated
- [ ] New requirements added to Active for next milestone
- [ ] Out of Scope reasoning audited
- [ ] Context updated with current state
- [ ] All milestone decisions added to Key Decisions
- [ ] "Last updated" footer reflects milestone completion

</step>

<step name="archive_milestone">

**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.

**Quick-task archival (opt-in — NOT symmetrical with phase archival below, #2142):** unlike phase archival, quick-task archival is **opt-in, default OFF**. Doing nothing leaves `.planning/quick/` untouched, exactly like today's behavior. Decide this BEFORE calling `milestone complete` below, so the flag can be folded into that single invocation rather than issuing a second, redundant call.

If `.planning/quick/` contains at least one directory, ask:

AskUserQuestion: "Archive completed quick tasks into this milestone too?" with options: "Yes — archive quick tasks into v[X.Y]" | "Skip"

If "Yes": set `ARCHIVE_QUICK_FLAG="--archive-quick"`. If "Skip" (or `.planning/quick/` is empty): set `ARCHIVE_QUICK_FLAG=""`.

**Delegate archival to `gsd_run query milestone.complete`:**

```bash
ARCHIVE=$(gsd_run query milestone.complete "v[X.Y]" --name "[Milestone Name]" --confirm $ARCHIVE_QUICK_FLAG)
```

`--confirm` is required (#3726): the archive is irreversible (ROADMAP/REQUIREMENTS archived, phase
directories MOVED, STATE.md rewritten), so `milestone complete` refuses to mutate without it. This
workflow has already gathered the user's explicit intent by this step, so passing the flag here is
correct; `--dry-run` previews the exact move list without mutating if a preview is ever needed first.

The CLI handles:
- Creating `.planning/milestones/` directory
- Archiving ROADMAP.md to `milestones/v[X.Y]-ROADMAP.md`
- Archiving REQUIREMENTS.md to `milestones/v[X.Y]-REQUIREMENTS.md` with archive header
- Moving audit file to milestones if it exists
- Creating/appending MILESTONES.md entry with accomplishments from SUMMARY.md files
- Updating STATE.md (status, last activity)
- When `ARCHIVE_QUICK_FLAG` is `--archive-quick`: moving every directory under `.planning/quick/` into `.planning/milestones/v[X.Y]-quick/`, writing a `README.md` index into that archive directory (generated by scanning the archive directory itself), and clearing the data rows of STATE.md's `### Quick Tasks Completed` table — preserving the table's header and whichever column variant (with/without a Status column) was detected

Extract from result: `version`, `date`, `phases`, `plans`, `tasks`, `accomplishments`, `archived`.

Verify: `✅ Milestone archived to .planning/milestones/`

**Known limit (quick-task archival):** there is no on-disk provenance recording which milestone a given quick task belonged to. Archival buckets **all** remaining `.planning/quick/*` into the completing milestone — a quick task that predates an earlier, unarchived milestone lands in the current bucket regardless.

Verify after `--archive-quick` was passed: `✅ Quick tasks archived to .planning/milestones/v[X.Y]-quick/`

**Phase archival (default-on):** `milestone complete` archives phase directories to `milestones/v[X.Y]-phases/` by default (#1871), so the next `/gsd:new-milestone` never inherits un-archived dirs. No manual `mkdir`/`mv` or `--archive-phases` flag is needed.

If the user explicitly wants to keep phase directories in place as raw execution history, invoke `milestone complete` with `--no-archive-phases`:

```bash
gsd_run query milestone complete v[X.Y] --no-archive-phases --confirm
```

Verify after a default (archived) completion: `✅ Phase directories archived to .planning/milestones/v[X.Y]-phases/`

After archival, the AI still handles:
- Reorganizing ROADMAP.md with milestone grouping (requires judgment) — overwrite in place after extracting Backlog section, with the write-guard's single-use sentinel armed first (a per-step env var cannot reach a hook — see the reorganize step for the sentinel mechanics)
- Full PROJECT.md evolution review (requires understanding)
- Safety commit of archive files + updated ROADMAP.md, then `git rm .planning/REQUIREMENTS.md`
- These are NOT fully delegated because they require AI interpretation of content

</step>

<step name="reorganize_roadmap_and_delete_originals">

After `milestone complete` has archived, reorganize ROADMAP.md with milestone groupings, then commit archives as a safety checkpoint before removing originals.

**Backlog preservation — do this FIRST before rewriting ROADMAP.md:**

Extract the Backlog section from the current ROADMAP.md before making any changes:

```bash
# Extract lines under ## Backlog through end of file (or next ## section)
BACKLOG_SECTION=$(awk '/^## Backlog/{found=1} found{print}' .planning/ROADMAP.md)
```

If `$BACKLOG_SECTION` is empty, there is no Backlog section — skip silently.

**Reorganize ROADMAP.md** — overwrite in place (do NOT delete first) with milestone groupings.

This rewrite is an *intentional* catastrophic shrink: phase detail was just archived to `milestones/v[X.Y]-ROADMAP.md`, and a multi-hundred-line ROADMAP.md collapses to a compact grouped summary. The `gsd-write-guard` PreToolUse hook (#2255) hard-blocks exactly that shape on curated `.planning/` files — this step is the legitimate milestone reset its escape hatch exists for. A hook inherits the *runtime's* environment, so no per-step env var can reach it; the hatch is a **single-use sentinel file the guard itself consumes**. Arm it, then write:

1. Arm the sentinel (single-use; the guard checks it is fresh — within 15 minutes — and names exactly this file, then consumes it):

```bash
printf '.planning/ROADMAP.md\n' > .planning/.gsd-allow-shrink
```

2. Compose the full new ROADMAP.md content (template below) and overwrite `.planning/ROADMAP.md` with the **Write tool** — the normal path. The guard allows this one shrink and deletes the sentinel. If the Write is blocked anyway, the sentinel was stale or consumed — re-run the `printf` and retry the Write.

Template for the composed content:

```markdown
# Roadmap: [Project Name]

## Milestones

- ✅ **v1.0 MVP** — Phases 1-4 (shipped YYYY-MM-DD)
- 🚧 **v1.1 Security** — Phases 5-6 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-4) — SHIPPED YYYY-MM-DD</summary>

- [x] Phase 1: Foundation (2/2 plans) — completed YYYY-MM-DD
- [x] Phase 2: Authentication (2/2 plans) — completed YYYY-MM-DD

</details>
```

**Re-append Backlog section after the rewrite** (only if `$BACKLOG_SECTION` was non-empty):

Append the extracted Backlog content verbatim to the end of the newly written ROADMAP.md. This ensures 999.x backlog items are never silently dropped during milestone reorganization.

**Safety commit — commit archive files BEFORE deleting any originals:**

```bash
gsd_run query commit "chore: archive v[X.Y] milestone files" --files .planning/milestones/v[X.Y]-ROADMAP.md .planning/milestones/v[X.Y]-REQUIREMENTS.md .planning/milestones/v[X.Y]-MILESTONE-AUDIT.md .planning/MILESTONES.md .planning/PROJECT.md .planning/STATE.md .planning/ROADMAP.md
```

This creates a durable checkpoint in git history. If anything fails after this point, the working tree can be reconstructed from git.

**Remove REQUIREMENTS.md via git rm** (preserves history, stages deletion atomically):

```bash
git rm .planning/REQUIREMENTS.md
```

</step>

<step name="write_retrospective">

**Append to living retrospective:**

Check for existing retrospective:
```bash
ls .planning/RETROSPECTIVE.md 2>/dev/null || true
```

**If exists:** Read the file, append new milestone section before the "## Cross-Milestone Trends" section.

**If doesn't exist:** Create from template at `~/.claude/gsd-core/templates/retrospective.md`.

**Gather retrospective data:**

1. From SUMMARY.md files: Extract key deliverables, one-liners, tech decisions
2. From VERIFICATION.md files: Extract verification scores, gaps found
3. From UAT.md files: Extract test results, issues found
4. From git log: Count commits, calculate timeline
5. From the milestone work: Reflect on what worked and what didn't

**Write the milestone section:**

```markdown
## Milestone: v{version} — {name}

**Shipped:** {date}
**Phases:** {phase_count} | **Plans:** {plan_count}

### What Was Built
{Extract from SUMMARY.md one-liners}

### What Worked
{Patterns that led to smooth execution}

### What Was Inefficient
{Missed opportunities, rework, bottlenecks}

### Patterns Established
{New conventions discovered during this milestone}

### Key Lessons
{Specific, actionable takeaways}

### Cost Observations
- Model mix: {X}% opus, {Y}% sonnet, {Z}% haiku
- Sessions: {count}
- Notable: {efficiency observation}
```

**Update cross-milestone trends:**

If the "## Cross-Milestone Trends" section exists, update the tables with new data from this milestone.

**Commit:**
```bash
gsd_run query commit "docs: update retrospective for v${VERSION}" --files .planning/RETROSPECTIVE.md
```

</step>

<step name="update_state">

Most STATE.md updates were handled by `milestone complete`, but verify and update remaining fields:

**Project Reference:**

```markdown
## Project Reference

See: .planning/PROJECT.md (updated [today])

**Core value:** [Current core value from PROJECT.md]
**Current focus:** [Next milestone or "Planning next milestone"]
```

**Accumulated Context:**
- Clear decisions summary (full log in PROJECT.md)
- Clear resolved blockers
- Keep open blockers for next milestone

</step>

<step name="handle_branches">

Check branching strategy and offer merge options.

Use `init milestone-op` for context, or load config directly:

```bash
INIT=$(gsd_run query init.execute-phase "1")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
INIT_CM=$(gsd_run query init.complete-milestone)
if [[ "$INIT_CM" == @file:* ]]; then INIT_CM=$(cat "${INIT_CM#@file:}"); fi
```

Extract `branching_strategy`, `phase_branch_template`, `milestone_branch_template`, and `commit_docs` from init JSON. Extract `git_create_tag` and `section_manifest` from `INIT_CM` (used by the `git_tag` step below).

Detect base branch:
```bash
BASE_BRANCH=$(gsd_run query git.base-branch)
```

**If "none":** Skip to git_tag.

**For "phase" strategy:**

```bash
BRANCH_PREFIX=$(echo "$PHASE_BRANCH_TEMPLATE" | sed 's/{.*//')
PHASE_BRANCHES=$(git branch --list "${BRANCH_PREFIX}*" 2>/dev/null | sed 's/^\*//' | tr -d ' ')
```

**For "milestone" strategy:**

```bash
BRANCH_PREFIX=$(echo "$MILESTONE_BRANCH_TEMPLATE" | sed 's/{.*//')
MILESTONE_BRANCH=$(git branch --list "${BRANCH_PREFIX}*" 2>/dev/null | sed 's/^\*//' | tr -d ' ' | head -1)
```

**If no branches found:** Skip to git_tag.

**If branches exist:**

```
## Git Branches Detected

Branching strategy: {phase/milestone}
Branches: {list}

Options:
1. **Merge to main** — Merge branch(es) to main
2. **Delete without merging** — Already merged or not needed
3. **Keep branches** — Leave for manual handling
```

AskUserQuestion with options: Squash merge (Recommended), Merge with history, Delete without merging, Keep branches.

**Squash merge:**

```bash
CURRENT_BRANCH=$(git branch --show-current)
git checkout ${BASE_BRANCH}

if [ "$BRANCHING_STRATEGY" = "phase" ]; then
  # Rewrapped through unquoted command substitution (gsd-core#4109): a bare
  # `$VAR` word-splits under bash but not zsh, collapsing every element onto
  # one iteration there.
  for branch in $(printf '%s' "$PHASE_BRANCHES"); do
    git merge --squash "$branch"
    # Strip .planning/ from staging if commit_docs is false
    if [ "$COMMIT_DOCS" = "false" ]; then
      git reset HEAD .planning/ 2>/dev/null || true
    fi
    git commit -m "feat: $branch for v[X.Y]"
  done
fi

if [ "$BRANCHING_STRATEGY" = "milestone" ]; then
  git merge --squash "$MILESTONE_BRANCH"
  # Strip .planning/ from staging if commit_docs is false
  if [ "$COMMIT_DOCS" = "false" ]; then
    git reset HEAD .planning/ 2>/dev/null || true
  fi
  git commit -m "feat: $MILESTONE_BRANCH for v[X.Y]"
fi

git checkout "$CURRENT_BRANCH"
```

**Merge with history:**

```bash
CURRENT_BRANCH=$(git branch --show-current)
git checkout ${BASE_BRANCH}

if [ "$BRANCHING_STRATEGY" = "phase" ]; then
  # Rewrapped through unquoted command substitution (gsd-core#4109): a bare
  # `$VAR` word-splits under bash but not zsh, collapsing every element onto
  # one iteration there.
  for branch in $(printf '%s' "$PHASE_BRANCHES"); do
    git merge --no-ff --no-commit "$branch"
    # Strip .planning/ from staging if commit_docs is false
    if [ "$COMMIT_DOCS" = "false" ]; then
      git reset HEAD .planning/ 2>/dev/null || true
    fi
    git commit -m "Merge branch '$branch' for v[X.Y]"
  done
fi

if [ "$BRANCHING_STRATEGY" = "milestone" ]; then
  git merge --no-ff --no-commit "$MILESTONE_BRANCH"
  # Strip .planning/ from staging if commit_docs is false
  if [ "$COMMIT_DOCS" = "false" ]; then
    git reset HEAD .planning/ 2>/dev/null || true
  fi
  git commit -m "Merge branch '$MILESTONE_BRANCH' for v[X.Y]"
fi

git checkout "$CURRENT_BRANCH"
```

**Delete without merging:**

```bash
if [ "$BRANCHING_STRATEGY" = "phase" ]; then
  # Rewrapped through unquoted command substitution (gsd-core#4109): a bare
  # `$VAR` word-splits under bash but not zsh, collapsing every element onto
  # one iteration there.
  for branch in $(printf '%s' "$PHASE_BRANCHES"); do
    git branch -d "$branch" 2>/dev/null || git branch -D "$branch"
  done
fi

if [ "$BRANCHING_STRATEGY" = "milestone" ]; then
  git branch -d "$MILESTONE_BRANCH" 2>/dev/null || git branch -D "$MILESTONE_BRANCH"
fi
```

**Keep branches:** Report "Branches preserved for manual handling"

</step>

<!-- gsd:section id="git-tag" when="state:git-create-tag" -->
If `section_manifest` is `null` or `"git-tag"` is in its `included` list: read and execute `gsd-core/workflows/complete-milestone/steps/git-tag.md`. Otherwise skip — do not read the file; proceed to `git_commit_milestone`.
<!-- /gsd:section -->

<step name="git_commit_milestone">

Commit the REQUIREMENTS.md deletion (archive files and ROADMAP.md were already committed in the safety commit in `reorganize_roadmap_and_delete_originals`).

```bash
git commit -m "chore: remove REQUIREMENTS.md for v[X.Y] milestone"
```

Confirm: "Committed: chore: remove REQUIREMENTS.md for v[X.Y] milestone"

</step>

<step name="offer_next">

```
✅ Milestone v[X.Y] [Name] complete

Shipped:
- [N] phases ([M] plans, [P] tasks)
- [One sentence of what shipped]

Archived:
- milestones/v[X.Y]-ROADMAP.md
- milestones/v[X.Y]-REQUIREMENTS.md

Summary: .planning/MILESTONES.md
Tag: v[X.Y]

---

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Start Next Milestone** — questioning → research → requirements → roadmap

`/clear` then:

`/gsd:new-milestone`

---
```

</step>

</process>

<milestone_naming>

**Version conventions:**
- **v1.0** — Initial MVP
- **v1.1, v1.2** — Minor updates, new features, fixes
- **v2.0, v3.0** — Major rewrites, breaking changes, new direction

**Names:** Short 1-2 words (v1.0 MVP, v1.1 Security, v1.2 Performance, v2.0 Redesign).

</milestone_naming>

<what_qualifies>

**Create milestones for:** Initial release, public releases, major feature sets shipped, before archiving planning.

**Don't create milestones for:** Every phase completion (too granular), work in progress, internal dev iterations (unless truly shipped).

Heuristic: "Is this deployed/usable/shipped?" If yes → milestone. If no → keep working.

</what_qualifies>

<success_criteria>

Milestone completion is successful when:

- [ ] Pre-close artifact audit run and output shown to user
- [ ] Deferred items recorded in STATE.md if user acknowledged
- [ ] Known deferred items count noted in MILESTONES.md entry

- [ ] MILESTONES.md entry created with stats and accomplishments
- [ ] PROJECT.md full evolution review completed
- [ ] All shipped requirements moved to Validated in PROJECT.md
- [ ] Key Decisions updated with outcomes
- [ ] ROADMAP.md Backlog section extracted before rewrite, re-appended after (skipped if absent)
- [ ] ROADMAP.md reorganized with milestone grouping (overwritten in place, not deleted)
- [ ] Roadmap archive created (milestones/v[X.Y]-ROADMAP.md)
- [ ] Requirements archive created (milestones/v[X.Y]-REQUIREMENTS.md)
- [ ] Safety commit made (archive files + updated ROADMAP.md) BEFORE deleting REQUIREMENTS.md
- [ ] REQUIREMENTS.md removed via `git rm` (fresh for next milestone, history preserved)
- [ ] STATE.md updated with fresh project reference
- [ ] Git tag created (v[X.Y]) (if `git.create_tag` enabled)
- [ ] Milestone commit made (includes archive files and deletion)
- [ ] Requirements completion checked against REQUIREMENTS.md traceability table
- [ ] Incomplete requirements surfaced with proceed/audit/abort options
- [ ] Known gaps recorded in MILESTONES.md if user proceeded with incomplete requirements
- [ ] RETROSPECTIVE.md updated with milestone section
- [ ] Cross-milestone trends updated
- [ ] User knows next step (/gsd:new-milestone)

</success_criteria>

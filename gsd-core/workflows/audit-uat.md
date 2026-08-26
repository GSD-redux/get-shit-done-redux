<purpose>
Cross-phase audit of all UAT and verification files. Finds every outstanding item (pending, skipped, blocked, human_needed), optionally verifies against the codebase to detect stale docs, and produces a prioritized human test plan.
</purpose>

<process>

<step name="initialize">
Run the CLI audit:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
AUDIT=$(gsd_run query audit-uat --raw)
```

Parse JSON for `results` array and `summary` object.

If `summary.total_items` is 0 AND `summary.parse_gap_files` is 0:
```
## All Clear

No outstanding UAT or verification items found across all phases.
All tests are passing, resolved, or diagnosed with fix plans.
```
Stop here.

If `summary.total_items` is 0 but `summary.parse_gap_files` is greater than 0, this is NOT all-clear — one or more files have test blocks that could not be parsed and may be hiding outstanding work. Continue to the `categorize` and `present` steps below; `present` renders the Unparsed section from these `parse_gap: true` entries even though `items` is empty for a mixed project.

`summary.parse_gap_files` counts only files in LIVE (non-archived) phases — that is what makes it an actionable gate. Files in phases belonging to an already-completed milestone are counted separately in `summary.archived_parse_gap_files`, because an archived milestone is closed history: its UAT files are signed off by definition, and no user action can clear a parse gap in them. If `archived_parse_gap_files` were folded into the gate, a mature project would report unparsed files on every single run, permanently, drowning the next real gap. Archived gaps are still fully present in `results` (with `parse_gap: true` and an `archived_milestone` field) and are reported by `present` in their own informational section — visible, but never counted as work to do. Do NOT treat a non-zero `archived_parse_gap_files` alone as a reason to skip the All Clear block above.
</step>

<step name="categorize">
Group items by what's actionable NOW vs. what needs prerequisites:

**Testable Now** (no external dependencies):
- `pending` — tests never run
- `human_uat` — human verification items
- `skipped_unresolved` — skipped without clear blocking reason

**Needs Prerequisites:**
- `server_blocked` — needs external server running
- `device_needed` — needs physical device (not simulator)
- `build_needed` — needs release/preview build
- `third_party` — needs external service configuration

For each item in "Testable Now", use Grep/Read to check if the underlying feature still exists in the codebase:
- If the test references a component/function that no longer exists → mark as `stale`
- If the test references code that has been significantly rewritten → mark as `needs_update`
- Otherwise → mark as `active`
</step>

<step name="present">
If `summary.parse_gap_files` is greater than 0, render this section FIRST (before the `## UAT Audit Report` below, or standalone if `total_items` is also 0). Filter `results` for entries with `parse_gap: true` AND no `archived_milestone` field:
```
## Unparsed UAT Files ({parse_gap_files} files)

| Phase | File | Unparsed Blocks |
|-------|------|------------------|
| {phase} | {file_path} | {unparsed_blocks} |
...

These files have `### N.` test blocks with no readable `result:` line. Fix the file's structure, then re-run the audit.
```
This fires for ANY project with `parse_gap_files > 0`, including a mixed project where other phases also have real outstanding `items` — the two sections are not mutually exclusive. If `total_items` is 0, stop after this section (there is no `## UAT Audit Report` to present). Otherwise continue below.

If `summary.archived_parse_gap_files` is greater than 0, render this section AFTER the live one above (or on its own if there were no live gaps). Filter `results` for entries with `parse_gap: true` AND an `archived_milestone` field:
```
## Unparsed UAT Files in Archived Milestones ({archived_parse_gap_files} files) — informational

| Milestone | Phase | File | Unparsed Blocks |
|-----------|-------|------|------------------|
| {archived_milestone} | {phase} | {file_path} | {unparsed_blocks} |
...

These phases belong to milestones that are already complete, so this is closed history and NOT outstanding work — no action is expected or required. They are listed only so a parse gap in a signed-off file is never silently dropped: if you ever need to trust one of these records, this is where to look.
```
Never merge these rows into the live `## Unparsed UAT Files` table, never add them to `{parse_gap_files}`, and never let this section alone suppress the All Clear block or drive a routing suggestion. Its presence is a note, not a task.

Present the audit report:

```
## UAT Audit Report

**{total_items} outstanding items across {total_files} files in {phase_count} phases**

### Testable Now ({count})

| # | Phase | Test | Description | Status |
|---|-------|------|-------------|--------|
| 1 | {phase} | {test_name} | {expected} | {active/stale/needs_update} |
...

### Needs Prerequisites ({count})

| # | Phase | Test | Blocked By | Description |
|---|-------|------|------------|-------------|
| 1 | {phase} | {test_name} | {category} | {expected} |
...

### Stale (can be closed) ({count})

| # | Phase | Test | Why Stale |
|---|-------|------|-----------|
| 1 | {phase} | {test_name} | {reason} |
...

---

## Recommended Actions

1. **Close stale items:** `/gsd:verify-work {phase}` — mark stale tests as resolved
2. **Run active tests:** Human UAT test plan below
3. **When prerequisites met:** Retest blocked items with `/gsd:verify-work {phase}`
```
</step>

<step name="test_plan">
Generate a human UAT test plan for "Testable Now" + "active" items only:

Group by what can be tested together (same screen, same feature, same prerequisite):

```
## Human UAT Test Plan

### Group 1: {category — e.g., "Billing Flow"}
Prerequisites: {what needs to be running/configured}

1. **{Test name}** (Phase {N})
   - Navigate to: {where}
   - Do: {action}
   - Expected: {expected behavior}

2. **{Test name}** (Phase {N})
   ...

### Group 2: {category}
...
```
</step>

</process>

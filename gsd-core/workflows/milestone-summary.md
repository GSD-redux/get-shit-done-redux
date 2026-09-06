@~/.claude/gsd-core/references/response-language-directive.md

# Milestone Summary Workflow

Generate a comprehensive, human-friendly project summary from completed milestone artifacts.
Designed for team onboarding — a new contributor can read the output and understand the entire project.

---

## Step 1: Resolve Version

```bash
VERSION="$ARGUMENTS"
```

If `$ARGUMENTS` is empty:
1. Check `.planning/STATE.md` for current milestone version
2. Check `.planning/milestones/` for the latest archived version
3. If neither found, check if `.planning/ROADMAP.md` exists (project may be mid-milestone)
4. If nothing found: error "No milestone found. Run /gsd:new-project or /gsd:new-milestone first."

Set `VERSION` to the resolved version (e.g., "1.0").

## Step 2: Locate Artifacts

Determine whether the milestone is **archived** or **current**:

**Archived milestone** (`.planning/milestones/v{VERSION}-ROADMAP.md` exists):
```
ROADMAP_PATH=".planning/milestones/v${VERSION}-ROADMAP.md"
REQUIREMENTS_PATH=".planning/milestones/v${VERSION}-REQUIREMENTS.md"
AUDIT_PATH=".planning/milestones/v${VERSION}-MILESTONE-AUDIT.md"
```

**Current/in-progress milestone** (no archive yet):
```
ROADMAP_PATH=".planning/ROADMAP.md"
REQUIREMENTS_PATH=".planning/REQUIREMENTS.md"
AUDIT_PATH=".planning/v${VERSION}-MILESTONE-AUDIT.md"
```

Note: The audit file moves to `.planning/milestones/` on archive (per `complete-milestone` workflow). Check both locations as a fallback.

**Always available:**
```
PROJECT_PATH=".planning/PROJECT.md"
RETRO_PATH=".planning/RETROSPECTIVE.md"
STATE_PATH=".planning/STATE.md"
```

Read all files that exist. Missing files are fine — the summary adapts to what's available.

## Step 3: Discover Phase Artifacts

Find all phase directories:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
gsd_run query init.progress
```

This returns phase metadata. For each phase in the milestone scope:

- Read `{phase_dir}/{padded}-SUMMARY.md` if it exists — extract `one_liner`, `accomplishments`, `decisions`
- Read `{phase_dir}/{padded}-VERIFICATION.md` if it exists — extract status, gaps, deferred items
- Read `{phase_dir}/{padded}-CONTEXT.md` if it exists — extract key decisions from `<decisions>` section
- Read `{phase_dir}/{padded}-RESEARCH.md` if it exists — note what was researched

Track which phases have which artifacts.

**If no phase directories exist** (empty milestone or pre-build state): skip to Step 5 and generate a minimal summary noting "No phases have been executed yet." Do not error — the summary should still capture PROJECT.md and ROADMAP.md content.

## Step 4: Gather Git Statistics

Try each method in order until one succeeds:

**Method 1 — Tagged milestone** (check first):
```bash
git tag -l "v${VERSION}" | head -1
```
If the tag exists:
```bash
git log v${VERSION} --oneline | wc -l
git diff --stat $(git log --format=%H --reverse v${VERSION} | head -1)..v${VERSION}
```

**Method 2 — STATE.md date range** (if no tag):
Read STATE.md and extract the `started_at` or earliest session date. Use it as the `--since` boundary:
```bash
git log --oneline --since="<started_at_date>" | wc -l
```

**Method 3 — Earliest phase commit** (if STATE.md has no date):
Find the earliest `.planning/phases/` commit:
```bash
git log --oneline --diff-filter=A -- ".planning/phases/" | tail -1
```
Use that commit's date as the start boundary.

**Method 4 — Skip stats** (if none of the above work):
Report "Git statistics unavailable — no tag or date range could be determined." This is not an error — the summary continues without the Stats section.

Extract (when available):
- Total commits in milestone
- Files changed, insertions, deletions
- Timeline (start date → end date)
- Contributors (from git log authors)

## Step 5: Generate Summary Document

Write to `.planning/reports/MILESTONE_SUMMARY-v${VERSION}.md`:

```markdown
# Milestone v{VERSION} — Project Summary

**Generated:** {date}
**Purpose:** Team onboarding and project review

---

## 1. Project Overview

{From PROJECT.md: "What This Is", core value proposition, target users}
{If mid-milestone: note which phases are complete vs in-progress}

## 2. Architecture & Technical Decisions

{From CONTEXT.md files across phases: key technical choices}
{From SUMMARY.md decisions: patterns, libraries, frameworks chosen}
{From PROJECT.md: tech stack if documented}

Present as a bulleted list of decisions with brief rationale:
- **Decision:** {what was chosen}
  - **Why:** {rationale from CONTEXT.md}
  - **Phase:** {which phase made this decision}

## 3. Phases Delivered

| Phase | Name | Status | One-Liner |
|-------|------|--------|-----------|
{For each phase: number, name, status (complete/in-progress/planned), one_liner from SUMMARY.md}

## 4. Requirements Coverage

{From REQUIREMENTS.md: list each requirement with status}
- ✅ {Requirement met}
- ⚠️ {Requirement partially met — note gap}
- ❌ {Requirement not met — note reason}

{If MILESTONE-AUDIT.md exists: include audit verdict}

## 5. Key Decisions Log

{Aggregate from all CONTEXT.md <decisions> sections}
{Each decision with: ID, description, phase, rationale}

## 6. Tech Debt & Deferred Items

{From VERIFICATION.md files: gaps found, anti-patterns noted}
{From RETROSPECTIVE.md: lessons learned, what to improve}
{From CONTEXT.md <deferred> sections: ideas parked for later}

## 7. Getting Started

{Entry points for new contributors:}
- **Run the project:** {from PROJECT.md or SUMMARY.md}
- **Key directories:** {from codebase structure}
- **Tests:** {test command from PROJECT.md or CLAUDE.md}
- **Where to look first:** {main entry points, core modules}

---

## Stats

- **Timeline:** {start} → {end} ({duration})
- **Phases:** {count complete} / {count total}
- **Commits:** {count}
- **Files changed:** {count} (+{insertions} / -{deletions})
- **Contributors:** {list}
```

## Step 6: Write and Commit

**Overwrite guard:** If `.planning/reports/MILESTONE_SUMMARY-v${VERSION}.md` already exists, ask the user:
> "A milestone summary for v{VERSION} already exists. Overwrite it, or view the existing one?"
If "view": display existing file and skip to Step 8 (interactive mode). If "overwrite": proceed.

Create the reports directory if needed:
```bash
mkdir -p .planning/reports
```

Write the summary, then commit:
```bash
gsd_run query commit "docs(v${VERSION}): generate milestone summary for onboarding" --files \
  ".planning/reports/MILESTONE_SUMMARY-v${VERSION}.md"
```

## Step 7: Present Summary

Display the full summary document inline.

## Step 8: Offer Interactive Mode

After presenting the summary:

> "Summary written to `.planning/reports/MILESTONE_SUMMARY-v{VERSION}.md`.
>
> I have full context from the build artifacts. Want to ask anything about the project?
> Architecture decisions, specific phases, requirements, tech debt — ask away."

If the user asks questions:
- Answer from the artifacts already loaded (CONTEXT.md, SUMMARY.md, VERIFICATION.md, etc.)
- Reference specific files and decisions
- Stay grounded in what was actually built (not speculation)

If the user is done:
- Suggest next steps: `/gsd:new-milestone`, `/gsd:progress`, or sharing the summary with the team

## Step 9: Update STATE.md

```bash
gsd_run query state.record-session \
  --stopped-at "Milestone v${VERSION} summary generated" \
  --resume-file ".planning/reports/MILESTONE_SUMMARY-v${VERSION}.md"
```

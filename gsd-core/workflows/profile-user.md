<purpose>
Orchestrate the full developer profiling flow: consent, session analysis (or questionnaire fallback), profile generation, result display, and artifact creation.

This workflow wires Phase 1 (session pipeline) and Phase 2 (profiling engine) into a cohesive user-facing experience. All heavy lifting is done by existing `gsd_run query` handlers and the gsd-user-profiler agent -- this workflow orchestrates the sequence, handles branching, and provides the UX.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.

Key references:
- @$HOME/.claude/gsd-core/references/ui-brand.md (display patterns)
- @$HOME/.claude/agents/gsd-user-profiler.md (profiler agent definition)
- @$HOME/.claude/gsd-core/references/user-profiling.md (profiling reference doc)
</required_reading>

<process>
```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --raw --default "" 2>/dev/null || echo "")
```

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

## 1. Initialize

Parse flags from $ARGUMENTS:
- Detect `--questionnaire` flag (skip session analysis, questionnaire-only)
- Detect `--refresh` flag (rebuild profile even when one exists)

Check for existing profile:

```bash
PROFILE_PATH="$HOME/.claude/gsd-core/USER-PROFILE.md"
[ -f "$PROFILE_PATH" ] && echo "EXISTS" || echo "NOT_FOUND"
```

**If profile exists AND --refresh NOT set AND --questionnaire NOT set:**

**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
Use AskUserQuestion:
- header: "Existing Profile"
- question: "You already have a profile. What would you like to do?"
- options:
  - "View it" -- Display summary card from existing profile data, then exit
  - "Refresh it" -- Continue with --refresh behavior
  - "Cancel" -- Exit workflow

If "View it": Read USER-PROFILE.md, display its content formatted as a summary card, then exit.
If "Refresh it": Set --refresh behavior and continue.
If "Cancel": Display "No changes made." and exit.

**If profile exists AND --refresh IS set:**

Backup existing profile:
```bash
cp "$HOME/.claude/gsd-core/USER-PROFILE.md" "$HOME/.claude/USER-PROFILE.backup.md"
```

Display: "Re-analyzing your sessions to update your profile."
Continue to step 2.

**If no profile exists:** Continue to step 2.

---

## 2. Consent Gate (ACTV-06)

**Skip if** `--questionnaire` flag is set (no JSONL reading occurs -- jump directly to step 4b).

Display consent screen:

```
### GSD > PROFILE YOUR CODING STYLE

Claude starts every conversation generic. A profile teaches Claude
how YOU actually work -- not how you think you work.

## What We'll Analyze

Your recent Claude Code sessions, looking for patterns in these
8 behavioral dimensions:

| Dimension            | What It Measures                            |
|----------------------|---------------------------------------------|
| Communication Style  | How you phrase requests (terse vs. detailed) |
| Decision Speed       | How you choose between options               |
| Explanation Depth    | How much explanation you want with code      |
| Debugging Approach   | How you tackle errors and bugs               |
| UX Philosophy        | How much you care about design vs. function  |
| Vendor Philosophy    | How you evaluate libraries and tools         |
| Frustration Triggers | What makes you correct Claude                |
| Learning Style       | How you prefer to learn new things           |

## Data Handling

✓ Reads session files locally (read-only, nothing modified)
✓ Analyzes message patterns (not content meaning)
✓ Stores profile at $HOME/.claude/gsd-core/USER-PROFILE.md
✗ Nothing is sent to external services
✗ Sensitive content (API keys, passwords) is automatically excluded
```

**If --refresh path:**
Show abbreviated consent instead:

```
Re-analyzing your sessions to update your profile.
Your existing profile has been backed up to USER-PROFILE.backup.md.
```

Use AskUserQuestion:
- header: "Refresh"
- question: "Continue with profile refresh?"
- options:
  - "Continue" -- Proceed to step 3
  - "Cancel" -- Exit workflow

**If default (no --refresh) path:**

Use AskUserQuestion:
- header: "Ready?"
- question: "Ready to analyze your sessions?"
- options:
  - "Let's go" -- Proceed to step 3 (session analysis)
  - "Use questionnaire instead" -- Jump to step 4b (questionnaire path)
  - "Not now" -- Display "No worries. Run /gsd:profile-user when ready." and exit

---

## 3. Session Scan

Display: "◆ Scanning sessions..."

Run session scan:
```bash
SCAN_RESULT=$(gsd_run query scan-sessions --json 2>/dev/null)
```

Parse the JSON output to get session count and project count.

Display: "✓ Found N sessions across M projects"

**Determine data sufficiency:**
- Count total messages available from the scan result (sum sessions across projects)
- If 0 sessions found: Display "No sessions found. Switching to questionnaire." and jump to step 4b
- If sessions found: Continue to step 4a

---

## 4a. Session Analysis Path

Display: "◆ Sampling messages..."

Run profile sampling:
```bash
SAMPLE_RESULT=$(gsd_run query profile-sample --json 2>/dev/null)
```

Parse the JSON output to get the temp directory path and message count.

Display: "✓ Sampled N messages from M projects"

Display: "◆ Analyzing patterns..."

```bash
PROFILER_MODEL=$(gsd_run query resolve-model gsd-user-profiler --raw)
```

<!-- #2517 model-omit-on-inherit -->

> **Model omission (#2517).** Omit the `model` parameter entirely when the value it would carry (`PROFILER_MODEL`) is `"inherit"` or empty. An empty value 404s on runtimes without native tier aliases — the default on non-Claude runtimes. Omitting it inherits the orchestrator's model. See @gsd-core/references/model-profile-resolution.md.

**Spawn gsd-user-profiler agent using Task tool:**

Use the Task tool to spawn the `gsd-user-profiler` agent, passing `model="{PROFILER_MODEL}"` (omit the parameter per the rule above when the value is `"inherit"` or empty). Provide it with:
- The sampled JSONL file path from profile-sample output
- The user-profiling reference doc at `$HOME/.claude/gsd-core/references/user-profiling.md`

The agent prompt should follow this structure:
```
Read the profiling reference document and the sampled session messages, then analyze the developer's behavioral patterns across all 8 dimensions.

Reference: @$HOME/.claude/gsd-core/references/user-profiling.md
Session data: @{temp_dir}/profile-sample.jsonl

Analyze these messages and return your analysis in the <analysis> JSON format specified in the reference document.
```

**Parse the agent's output:**
- Extract the `<analysis>` JSON block from the agent's response
- Save analysis JSON to a temp file (in the same temp directory created by profile-sample)

```bash
ANALYSIS_PATH="{temp_dir}/analysis.json"
```

Write the analysis JSON to `$ANALYSIS_PATH`.

Display: "✓ Analysis complete (N dimensions scored)"

**Check for thin data:**
- Read the analysis JSON and check the total message count
- If < 50 messages were analyzed: Note that a questionnaire supplement could improve accuracy. Display: "Note: Limited session data (N messages). Results may have lower confidence."

Continue to step 5.

---

## 4b. Questionnaire Path

Display: "Using questionnaire to build your profile."

**Get questions:**
```bash
QUESTIONS=$(gsd_run query profile-questionnaire --json 2>/dev/null)
```

Parse the questions JSON. It contains 8 questions, one per dimension.

**Present each question to the user via AskUserQuestion:**

For each question in the questions array:
- header: The dimension name (e.g., "Communication Style")
- question: The question text
- options: The answer options from the question definition

Collect all answers into an answers JSON object mapping dimension keys to selected answer values.

**Save answers to temp file:**
```bash
# BSD/macOS mktemp only randomizes XXXXXX when it is the final path component, so make a
# suffixless temp then append the extension — portable across BSD + GNU (#1520).
ANSWERS_PATH=$(mktemp "${TMPDIR:-/tmp}/gsd-profile-answers-XXXXXX") && mv "$ANSWERS_PATH" "${ANSWERS_PATH}.json" && ANSWERS_PATH="${ANSWERS_PATH}.json" || exit 1
```

Write the answers JSON to `$ANSWERS_PATH`.

**Convert answers to analysis:**
```bash
ANALYSIS_RESULT=$(gsd_run query profile-questionnaire --answers "$ANSWERS_PATH" --json 2>/dev/null)
```

Parse the analysis JSON from the result.

Save analysis JSON to a temp file:
```bash
# BSD/macOS mktemp only randomizes XXXXXX when it is the final path component, so make a
# suffixless temp then append the extension — portable across BSD + GNU (#1520).
ANALYSIS_PATH=$(mktemp "${TMPDIR:-/tmp}/gsd-profile-analysis-XXXXXX") && mv "$ANALYSIS_PATH" "${ANALYSIS_PATH}.json" && ANALYSIS_PATH="${ANALYSIS_PATH}.json" || exit 1
```

Write the analysis JSON to `$ANALYSIS_PATH`.

Continue to step 5 (skip split resolution since questionnaire handles ambiguity internally).

---

## 5. Split Resolution

**Skip if** questionnaire-only path (splits already handled internally).

Read the analysis JSON from `$ANALYSIS_PATH`.

Check each dimension for `cross_project_consistent: false`.

**For each split detected:**

Use AskUserQuestion:
- header: The dimension name (e.g., "Communication Style")
- question: "Your sessions show different patterns:" followed by the split context (e.g., "CLI/backend projects -> terse-direct, Frontend/UI projects -> detailed-structured")
- options:
  - Rating option A (e.g., "terse-direct")
  - Rating option B (e.g., "detailed-structured")
  - "Context-dependent (keep both)"

**If user picks a specific rating:** Update the dimension's `rating` field in the analysis JSON to the selected value.

**If user picks "Context-dependent":** Keep the dominant rating in the `rating` field. Add a `context_note` to the dimension's summary describing the split (e.g., "Context-dependent: terse in CLI projects, detailed in frontend projects").

Write updated analysis JSON back to `$ANALYSIS_PATH`.

---

## 6. Profile Write

Display: "◆ Writing profile..."

```bash
gsd_run query write-profile --input "$ANALYSIS_PATH" --json
```

Display: "✓ Profile written to $HOME/.claude/gsd-core/USER-PROFILE.md"

---

## 7. Result Display

Read the analysis JSON from `$ANALYSIS_PATH` to build the display.

**Show report card table:**

```
## Your Profile

| Dimension            | Rating               | Confidence |
|----------------------|----------------------|------------|
| Communication Style  | detailed-structured  | HIGH       |
| Decision Speed       | deliberate-informed  | MEDIUM     |
| Explanation Depth    | concise              | HIGH       |
| Debugging Approach   | hypothesis-driven    | MEDIUM     |
| UX Philosophy        | pragmatic            | LOW        |
| Vendor Philosophy    | thorough-evaluator   | HIGH       |
| Frustration Triggers | scope-creep          | MEDIUM     |
| Learning Style       | self-directed        | HIGH       |
```

(Populate with actual values from the analysis JSON.)

**Show highlight reel:**

Pick 3-4 dimensions with the highest confidence and most evidence signals. Format as:

```
## Highlights

- **Communication (HIGH):** You consistently provide structured context with
  headers and problem statements before making requests
- **Vendor Choices (HIGH):** You research alternatives thoroughly -- comparing
  docs, GitHub activity, and bundle sizes before committing
- **Frustrations (MEDIUM):** You correct Claude most often for doing things
  you didn't ask for -- scope creep is your primary trigger
```

Build highlights from the `evidence` array and `summary` fields in the analysis JSON. Use the most compelling evidence quotes. Format each as "You tend to..." or "You consistently..." with evidence attribution.

**Offer full profile view:**

Use AskUserQuestion:
- header: "Profile"
- question: "Want to see the full profile?"
- options:
  - "Yes" -- Read and display the full USER-PROFILE.md content, then continue to step 8
  - "Continue to artifacts" -- Proceed directly to step 8

---

## 8. Artifact Selection (ACTV-05)

Use AskUserQuestion with multiSelect:
- header: "Artifacts"
- question: "Which artifacts should I generate?"
- options (ALL pre-selected by default):
  - "/gsd-dev-preferences command file" -- "Load your preferences in any session"
  - "CLAUDE.md profile section" -- "Add profile to this project's CLAUDE.md"
  - "Global CLAUDE.md" -- "Add profile to $HOME/.claude/CLAUDE.md for all projects"

**If no artifacts selected:** Display "No artifacts generated. Your profile is saved at $HOME/.claude/gsd-core/USER-PROFILE.md" and jump to step 10.

---

## 9. Artifact Generation

Generate selected artifacts sequentially (file I/O is fast, no benefit from parallel agents):

**For /gsd-dev-preferences (if selected):**

```bash
gsd_run query generate-dev-preferences --analysis "$ANALYSIS_PATH" --json
```

Display: "✓ Generated /gsd-dev-preferences at $HOME/.claude/skills/gsd-dev-preferences/SKILL.md"

**For CLAUDE.md profile section (if selected):**

```bash
gsd_run query generate-claude-profile --analysis "$ANALYSIS_PATH" --json
```

Display: "✓ Added profile section to CLAUDE.md"

**For Global CLAUDE.md (if selected):**

```bash
gsd_run query generate-claude-profile --analysis "$ANALYSIS_PATH" --global --json
```

Display: "✓ Added profile section to $HOME/.claude/CLAUDE.md"

**Error handling:** If any `gsd_run query` call fails, display the error message and use AskUserQuestion to offer "Retry" or "Skip this artifact". On retry, re-run the command. On skip, continue to next artifact.

---

## 10. Summary & Refresh Diff

**If --refresh path:**

Read both old backup and new analysis to compare dimension ratings/confidence.

Read the backed-up profile:
```bash
BACKUP_PATH="$HOME/.claude/USER-PROFILE.backup.md"
```

Compare each dimension's rating and confidence between old and new. Display diff table showing only changed dimensions:

```
## Changes

| Dimension       | Before                      | After                        |
|-----------------|-----------------------------|-----------------------------|
| Communication   | terse-direct (LOW)          | detailed-structured (HIGH)  |
| Debugging       | fix-first (MEDIUM)          | hypothesis-driven (MEDIUM)  |
```

If nothing changed: Display "No changes detected -- your profile is already up to date."

**Display final summary:**

```
### GSD > PROFILE COMPLETE ✓

Your profile:    $HOME/.claude/gsd-core/USER-PROFILE.md
```

Then list paths for each generated artifact:
```
Artifacts:
  ✓ /gsd-dev-preferences   $HOME/.claude/skills/gsd-dev-preferences/SKILL.md
  ✓ CLAUDE.md section       <resolved claude_md_path, default ./.claude/CLAUDE.md>
  ✓ Global CLAUDE.md        $HOME/.claude/CLAUDE.md
```

(Show the `claude_md_path` actually returned by the command — it defaults to `./.claude/CLAUDE.md` but may be overridden by config or `--output`.)

(Only show artifacts that were actually generated.)

**Clean up temp files:**

Remove the temp directory created by profile-sample (contains sample JSONL and analysis JSON):
```bash
rm -rf "$TEMP_DIR"
```

Also remove any standalone temp files created for questionnaire answers:
```bash
rm -f "$ANSWERS_PATH" 2>/dev/null
rm -f "$ANALYSIS_PATH" 2>/dev/null
```

(Only clean up temp paths that were actually created during this workflow run.)

</process>

<success_criteria>
- [ ] Initialization detects existing profile and handles all three responses (view/refresh/cancel)
- [ ] Consent gate shown for session analysis path, skipped for questionnaire path
- [ ] Session scan discovers sessions and reports statistics
- [ ] Session analysis path: samples messages, spawns profiler agent, extracts analysis JSON
- [ ] Questionnaire path: presents 8 questions, collects answers, converts to analysis JSON
- [ ] Split resolution presents context-dependent splits with user resolution options
- [ ] Profile written to USER-PROFILE.md via write-profile subcommand
- [ ] Result display shows report card table and highlight reel with evidence
- [ ] Artifact selection uses multiSelect with all options pre-selected
- [ ] Artifacts generated sequentially via `gsd_run query` subcommands
- [ ] Refresh diff shows changed dimensions when --refresh was used
- [ ] Temp files cleaned up on completion
</success_criteria>

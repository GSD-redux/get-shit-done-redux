<purpose>
Generate a UI design contract (UI-SPEC.md) for frontend phases. Orchestrates gsd-ui-researcher and gsd-ui-checker with a revision loop. Inserts between discuss-phase and plan-phase in the lifecycle.

UI-SPEC.md locks spacing, typography, color, copywriting, and design system decisions before the planner creates tasks. This prevents design debt caused by ad-hoc styling decisions during execution.
</purpose>

<required_reading>
@~/.claude/gsd-core/references/ui-brand.md
</required_reading>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-ui-researcher — Researches UI/UX approaches
- gsd-ui-checker — Reviews UI implementation quality
</available_agent_types>

<process>

## 1. Initialize

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(gsd_run query init.plan-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_UI=$(gsd_run query agent-skills gsd-ui-researcher)
AGENT_SKILLS_UI_CHECKER=$(gsd_run query agent-skills gsd-ui-checker)
```

Parse JSON for: `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`, `has_context`, `has_research`, `commit_docs`, `response_language`.

**If `response_language` is set:** All user-facing questions, prompts, and explanations in this workflow MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

**File paths:** `state_path`, `roadmap_path`, `requirements_path`, `context_path`, `research_path`.

Detect sketch findings:
```bash
SKETCH_FINDINGS_PATH=$(ls ./.claude/skills/sketch-findings-*/SKILL.md 2>/dev/null | head -1 || true)
```

Resolve UI agent models:

```bash
UI_RESEARCHER_MODEL=$(gsd_run query resolve-model gsd-ui-researcher --raw)
UI_CHECKER_MODEL=$(gsd_run query resolve-model gsd-ui-checker --raw)
```

Check config:

```bash
UI_ENABLED=$(gsd_run query config-get workflow.ui_phase 2>/dev/null || echo "true")
```

**If `UI_ENABLED` is `false`:**
```
UI phase is disabled in config. Enable via /gsd:settings.
```
Exit workflow.

**If `planning_exists` is false:** Error — run `/gsd:new-project` first.

## 2. Parse and Validate Phase

Extract phase number from $ARGUMENTS. If not provided, detect next unplanned phase.

```bash
PHASE_INFO=$(gsd_run query roadmap.get-phase "${PHASE}")
```

**If `found` is false:** Error with available phases.

## 3. Check Prerequisites

**If `has_context` is false:**
```
No CONTEXT.md found for Phase {N}.
Recommended: run /gsd:discuss-phase {N} first to capture design preferences.
Continuing without user decisions — UI researcher will ask all questions.
```
Continue (non-blocking).

**If `has_research` is false:**
```
No RESEARCH.md found for Phase {N}.
Note: stack decisions (component library, styling approach) will be asked during UI research.
```
Continue (non-blocking).

**If `SKETCH_FINDINGS_PATH` is not empty:**
```
⚡ Sketch findings detected: {SKETCH_FINDINGS_PATH}
   Validated design decisions from /gsd:sketch will be loaded into the UI researcher.
   Pre-validated decisions (layout, palette, typography, spacing) should be treated as locked — not re-asked.
```

## 4. Check Existing UI-SPEC

```bash
UI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-UI-SPEC.md 2>/dev/null | head -1)
```

**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
**If exists:** Use AskUserQuestion:
- header: "Existing UI-SPEC"
- question: "UI-SPEC.md already exists for Phase {N}. What would you like to do?"
- options:
  - "Update — re-run researcher with existing as baseline"
  - "View — display current UI-SPEC and exit"
  - "Skip — keep current UI-SPEC, proceed to verification"

If "View": display file contents, exit.
If "Skip": proceed to step 7 (checker).
If "Update": continue to step 5.

## 5. Spawn gsd-ui-researcher

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► UI DESIGN CONTRACT — PHASE {N}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning UI researcher... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Build prompt:

```markdown
Read ~/.claude/agents/gsd-ui-researcher.md for instructions.

<objective>
Create UI design contract for Phase {phase_number}: {phase_name}
Answer: "What visual and interaction contracts does this phase need?"
</objective>

<files_to_read>
- {state_path} (Project State)
- {roadmap_path} (Roadmap)
- {requirements_path} (Requirements)
- {context_path} (USER DECISIONS from /gsd:discuss-phase)
- {research_path} (Technical Research — stack decisions)
- {SKETCH_FINDINGS_PATH} (Sketch Findings — validated design decisions, CSS patterns, visual direction from /gsd:sketch, if exists)
</files_to_read>

${AGENT_SKILLS_UI}

<output>
Write to: {phase_dir}/{padded_phase}-UI-SPEC.md
Template: ~/.claude/gsd-core/templates/UI-SPEC.md
</output>

<config>
commit_docs: {commit_docs}
phase_dir: {phase_dir}
padded_phase: {padded_phase}
</config>
```

Omit null file paths from `<files_to_read>`.

<!-- #2508 runtime-aware-dispatch -->

> **Runtime-aware dispatch (#2508 Phase 4).** GSD workflows dispatch specialized subagents by role. Before dispatching on a built-in-only runtime (kimi-code — three built-ins only), resolve the role to a built-in via `gsd_run query resolve-dispatch-type --requested <role> --raw`. On named-dispatch runtimes (Claude/OpenCode/…) the role is returned unchanged; on kimi-code it maps to `coder`/`explore`/`plan` by role-suffix. The persona rides `${AGENT_SKILLS_<ROLE>}` (Phase 3) regardless. See @gsd-core/references/runtime-aware-dispatch.md.

<!-- #2517 model-omit-on-inherit -->

> **Model omission (#2517).** Omit the `model` parameter entirely when the value it would carry (`UI_RESEARCHER_MODEL`, `UI_CHECKER_MODEL`) is `"inherit"` or empty. An empty value 404s on runtimes without native tier aliases — the default on non-Claude runtimes. Omitting it inherits the orchestrator's model. See @gsd-core/references/model-profile-resolution.md.

```
Agent(
  prompt=ui_research_prompt,
  subagent_type="gsd-ui-researcher",
  model="{UI_RESEARCHER_MODEL}",
  description="UI Design Contract Phase {N}"
)
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

## 6. Handle Researcher Return

**If `## UI-SPEC COMPLETE`:**
Display confirmation. Continue to step 7.

**If `## UI-SPEC BLOCKED`:**
Display blocker details and options. Exit workflow.

## 7. Spawn gsd-ui-checker

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► VERIFYING UI-SPEC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning UI checker... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Build prompt:

```markdown
Read ~/.claude/agents/gsd-ui-checker.md for instructions.

<objective>
Validate UI design contract for Phase {phase_number}: {phase_name}
Check all 6 dimensions. Return APPROVED or BLOCKED.
</objective>

<files_to_read>
- {phase_dir}/{padded_phase}-UI-SPEC.md (UI Design Contract — PRIMARY INPUT)
- {context_path} (USER DECISIONS — check compliance)
- {research_path} (Technical Research — check stack alignment)
</files_to_read>

${AGENT_SKILLS_UI_CHECKER}

<config>
ui_safety_gate: {ui_safety_gate config value}
</config>
```

```
Agent(
  prompt=ui_checker_prompt,
  subagent_type="gsd-ui-checker",
  model="{UI_CHECKER_MODEL}",
  description="Verify UI-SPEC Phase {N}"
)
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

## 8. Handle Checker Return

**If `## UI-SPEC VERIFIED`:**
Display dimension results. Proceed to step 9.5.

**If `## ISSUES FOUND`:**
Display blocking issues. Proceed to step 9.

## 9. Revision Loop (Max 2 Iterations)

Track `revision_count` (starts at 0).

**If `revision_count` < 2:**
- Increment `revision_count`
- Re-spawn gsd-ui-researcher with revision context:

```markdown
<revision>
The UI checker found issues with the current UI-SPEC.md.

### Issues to Fix
{paste blocking issues from checker return}

Read the existing UI-SPEC.md, fix ONLY the listed issues, re-write the file.
Do NOT re-ask the user questions that are already answered.
</revision>
```

- After researcher returns → re-spawn checker (step 7)

**If `revision_count` >= 2:**
```
Max revision iterations reached. Remaining issues:

{list remaining issues}

Options:
1. Force approve — proceed with current UI-SPEC (FLAGs become accepted)
2. Edit manually — open UI-SPEC.md in editor, re-run /gsd:ui-phase
3. Abandon — exit without approving
```

Use AskUserQuestion for the choice.

**On "Force approve":** proceed to step 9.5 (the UI-consideration probe still runs on the accepted UI-SPEC, so state coverage is recorded even when quality FLAGs were accepted), then step 10. **On "Edit manually" / "Abandon":** exit without running the probe.

## 9.5. UI-Consideration Probe (post-verification)

Run AFTER the checker approves the UI-SPEC (VERIFIED, or force-approved at step 9) — never inline
during authoring, so a revision-loop researcher rewrite (step 9) cannot clobber the section and the
`## UI Considerations` block is committed with the FINAL UI-SPEC. This is the visual analog of
spec-phase Step 5.5's edge probe, retargeted to the UI element/state axis. Reference:
@~/.claude/gsd-core/references/ui-consideration-probe.md.

**Skip conditions:** if `--auto` and the UI-SPEC already carries a resolved `## UI Considerations`
section (re-run), the write-back is idempotent (it REPLACES that section, never appends). If the
runtime is non-Claude and the probe engine cannot be resolved, the shim FAILS LOUD (below) — it
never silently no-ops (a silent skip would drop the whole state-coverage axis).

**Runtime coverage compute — resolve and invoke ui-consideration-probe.cjs:**

```bash
# Resolve the compiled ui-consideration-probe.cjs against the GSD install dir via RUNTIME_DIR
# (#448) — NOT the consuming project's git root — falling back to git toplevel / $HOME/.claude.
# Mirrors spec-phase.md Step 5.5's edge-probe resolution idiom verbatim (same candidate paths).
_GSD_RT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
UI_PROBE_JS=$(for _c in \
  "$_GSD_RT/gsd-core/bin/lib/ui-consideration-probe.cjs" \
  "$_GSD_RT/bin/lib/ui-consideration-probe.cjs" \
  "$_GSD_RT/.claude/bin/lib/ui-consideration-probe.cjs" \
  "$HOME/.claude/gsd-core/bin/lib/ui-consideration-probe.cjs" \
  "$HOME/.claude/bin/lib/ui-consideration-probe.cjs"; do
  [ -f "$_c" ] && { echo "$_c"; break; }
done)

# Graceful degradation — never a silent skip. Build ONLY when $_GSD_RT is a verified GSD source
# checkout (has tsconfig.build.json + src/ui-consideration-probe.cts), pinned with --prefix so we
# never trigger the CONSUMING project's own build during a ui-phase. Real installs ship the
# compiled .cjs via prepublishOnly, so this path only matters in a GSD dev checkout.
if [ -z "$UI_PROBE_JS" ]; then
  if [ -f "$_GSD_RT/tsconfig.build.json" ] && [ -f "$_GSD_RT/src/ui-consideration-probe.cts" ]; then
    npm --prefix "$_GSD_RT" run build:lib 2>/dev/null || true
    UI_PROBE_JS=$(for _c in \
      "$_GSD_RT/gsd-core/bin/lib/ui-consideration-probe.cjs" \
      "$_GSD_RT/bin/lib/ui-consideration-probe.cjs" \
      "$_GSD_RT/.claude/bin/lib/ui-consideration-probe.cjs" \
      "$HOME/.claude/gsd-core/bin/lib/ui-consideration-probe.cjs" \
      "$HOME/.claude/bin/lib/ui-consideration-probe.cjs"; do
      [ -f "$_c" ] && { echo "$_c"; break; }
    done)
  fi
  if [ -z "$UI_PROBE_JS" ]; then
    echo "ERROR: ui-consideration-probe.cjs not found — reinstall GSD or run \`npm run build:lib\` in your GSD checkout." >&2
    exit 1
  fi
fi

# Element extraction (MANUAL BY DESIGN — not an oversight): the agent reads the researcher-authored
# UI-SPEC prose (the described surfaces — the Design System / Copywriting rows and any element the
# researcher named) and writes ONE object per UI element/surface: {"id","text"} where text is the
# prose describing it. This mirrors spec-phase Step 5.5's edge-probe REQS_JSON step VERBATIM — a
# hand-populated heredoc guarded by the fail-loud <replace:> check below — the established, shipped
# pattern for feeding a probe from a prose spec. It is NOT mechanized on purpose: a UI-SPEC has no
# single machine-parseable "elements" column — surfaces are distributed across design-token tables
# (Design System / Typography / Color), the Copywriting section, and prose the researcher names, so a
# regex/table parse would fail-OPEN (miss a prose-named surface, or feed a design-token row as a bogus
# element). The agent-authored heredoc + fail-loud guard is the conservative choice, identical to the
# requirement-side edge-probe path (RR-04). If a future UI-SPEC gains a canonical element table,
# revisit to parse it. Populate the heredoc from the UI-SPEC; the guard below fails loud on a
# forgotten substitution (never a no-op).
ELEMENTS_JSON=$(mktemp "${TMPDIR:-/tmp}/ui-probe-elements-XXXXXX") && mv "$ELEMENTS_JSON" "${ELEMENTS_JSON}.json" && ELEMENTS_JSON="${ELEMENTS_JSON}.json" || exit 1
cat > "$ELEMENTS_JSON" <<'JSON'
[
  { "id": "E1", "text": "<replace: element/surface description from the UI-SPEC prose>" }
]
JSON
if ! node -e 'const a=require(process.argv[1]);if(!Array.isArray(a)||a.length===0)process.exit(1);if(a.some(e=>typeof e.text!=="string"||!e.text.trim()||e.text.includes("<replace:")))process.exit(1)' "$ELEMENTS_JSON" 2>/dev/null; then
  rm -f "$ELEMENTS_JSON"
  echo "ERROR: ui-probe elements JSON is empty/invalid or still holds the <replace: …> placeholder — populate \$ELEMENTS_JSON from the UI-SPEC's described surfaces before this step runs." >&2
  exit 1
fi
# Invoke the compiled engine and CAPTURE its report. FATAL-INVOKE GUARD: use `if ! COVERAGE=$(…)`,
# NEVER a bare `COVERAGE=$(node …)` — a bare capture swallows the engine's exit 2 (invalid shape /
# bad input) and falls through to prose re-derivation: fail-OPEN at the exact boundary the engine
# validation protects.
if ! COVERAGE=$(node "$UI_PROBE_JS" "$ELEMENTS_JSON"); then
  rm -f "$ELEMENTS_JSON"
  echo "ERROR: ui-consideration-probe engine failed (invalid shapes or bad input) — fix the element(s) and re-run; never proceed with empty coverage." >&2
  exit 1
fi
rm -f "$ELEMENTS_JSON"
# Malformed-report guard: exit 0 but garbage. The report must parse as { items[], coverage{} }.
if ! printf '%s' "$COVERAGE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{process.exit(1)}if(!r||!Array.isArray(r.items)||typeof r.coverage!=="object"||r.coverage===null)process.exit(1)})'; then
  echo "ERROR: ui-consideration-probe produced an unparseable or malformed coverage report — refusing to proceed with the resolution loop." >&2
  exit 1
fi
# Zero-applicable guard: a report where NO category applied across ANY element is far more likely a
# classification miss (or malformed elements) than a genuinely state-free UI. Surface it loudly.
APPLICABLE=$(printf '%s' "$COVERAGE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let n=0;try{n=JSON.parse(s).coverage.applicable}catch{n=0}process.stdout.write(String(n))})')
if [ "$APPLICABLE" = "0" ]; then
  echo "WARNING: ui-consideration-probe proposed ZERO applicable categories across all elements — likely a classification miss or malformed elements, not a genuinely state-free UI. Do NOT silently write an empty UI Considerations section." >&2
fi
```

If `$APPLICABLE` is `0`, do NOT proceed silently: ask via AskUserQuestion ("The UI probe found no
applicable state considerations — is this genuinely a state-free surface, or should we revisit the
element descriptions?"). Only write an empty section after explicit confirmation.

**Propose-then-confirm (the partial-cue mitigation — load-bearing).** For each element, the engine
reports the DETECTED element kinds (`classifyElement` over the built `.cjs`). The prose classifier
is heuristic and LOSSY: a surface that is genuinely both a form and a list, but whose prose trips
only the form cue, under-covers — and because SOMETHING classified, no `unclassified` signal fires.
So SURFACE the detected kinds to the user (AskUserQuestion) and ask whether any real element kind
was missed. If the user ADDs a kind, re-run that element with an authored `elements` override
(the union of detected + added) so the missed categories are raised. A single tripped cue is a
SIGNAL, not proof the element is only that kind — the confirm step, not the heuristic, is what makes
coverage sound.

**Resolution loop** (mirror spec-phase 5.5): resolve each applicable consideration via
AskUserQuestion — **Specify** (→ `covered`, write a concrete truth) / **Dismiss (reason required)** /
**Backstop** (a held-out/visual UI-state test) / **Defer** (→ `unresolved`). An `unclassified` row is
a manual-review nudge, not a hard block. Text mode (`workflow.text_mode` / `--text`) → numbered lists.

**Kind-confirmation under `--auto`.** The propose-then-confirm step above is an AskUserQuestion, so
under `--auto` it follows the spec-phase 5.5 convention (replace AskUserQuestion with Claude's
recommended choice): Claude re-reads each element's prose and authors the `elements` override (the
union of the detected kinds + any kind it identifies as missed) instead of prompting — so `--auto`
recall rests on Claude's kind-identification, not the heuristic cue-match alone. This matters because
`autoResolve` (below) is a RESOLUTION floor only: it resolves the *detected* categories and cannot
recover a kind that was never surfaced, so recall is fixed HERE, at kind-confirmation, before
resolution runs.

**`--auto` mode (two layers).** The adapter's `autoResolve` is the CODE floor: every applicable
consideration auto-`backstop`s (carrying the taxonomy question as its resolution) and an
`unclassified` candidate stays `unresolved` — it NEVER auto-`dismiss`es and never auto-backstops an
unclassified item (#1110). On top of that floor the workflow MAY upgrade an item to `covered` when a
defensible acceptance criterion can be written (the same judgment spec-phase 5.5 applies in prose).
An auto `--auto` run therefore leaves un-upgraded backstops as `backstop`: at verify time each one
with no wired evidence routes to `insufficient_spec → human_needed` — never a silent pass (#1154).
That surfacing is the intended honest-verifier behavior, not over-flagging.

**Write-back.** Populate a `## UI Considerations` section in the UI-SPEC from the resolved
considerations, in the format the shipped plan-phase `## UI Considerations` lift rule reads:
`covered` → a truth string; `backstop` → a flat scalar `{ statement, verification: backstop }`;
`unresolved` → an explicit `⚠ unresolved — planner must treat as assumption` row. Empty-state and
error-state COPY stays in `## Copywriting Contract` — the considerations section covers shape-rooted
STATE coverage and REFERENCES those rows rather than restating the copy (de-dup). IDEMPOTENT: if a
`## UI Considerations` section already exists, REPLACE it — never append a duplicate.

## 10. Present Final Status

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► UI-SPEC READY ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Phase {N}: {Name}** — UI design contract approved

Dimensions: 6/6 passed
{If any FLAGs: "Recommendations: {N} (non-blocking)"}

───────────────────────────────────────────────────────────────

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

{If CONTEXT.md exists for this phase:}
**Plan Phase {N}** — planner will use UI-SPEC.md as design context

`/clear` then: `/gsd:plan-phase {N}`

{If CONTEXT.md does NOT exist:}
**Discuss Phase {N}** — gather implementation context before planning

`/clear` then: `/gsd:discuss-phase {N}`

(or `/gsd:plan-phase {N}` to skip discussion)

───────────────────────────────────────────────────────────────
```

## 11. Commit (if configured)

```bash
gsd_run query commit "docs(${padded_phase}): UI design contract" --files "${PHASE_DIR}/${PADDED_PHASE}-UI-SPEC.md"
```

## 12. Update State

```bash
gsd_run query state.record-session \
  --stopped-at "Phase ${PHASE} UI-SPEC approved" \
  --resume-file "${PHASE_DIR}/${PADDED_PHASE}-UI-SPEC.md"
```

</process>

<success_criteria>
- [ ] Config checked (exit if ui_phase disabled)
- [ ] Phase validated against roadmap
- [ ] Prerequisites checked (CONTEXT.md, RESEARCH.md — non-blocking warnings)
- [ ] Existing UI-SPEC handled (update/view/skip)
- [ ] gsd-ui-researcher spawned with correct context and file paths
- [ ] UI-SPEC.md created in correct location
- [ ] gsd-ui-checker spawned with UI-SPEC.md
- [ ] All 6 dimensions evaluated
- [ ] Revision loop if BLOCKED (max 2 iterations)
- [ ] Final status displayed with next steps
- [ ] UI-SPEC.md committed (if commit_docs enabled)
- [ ] State updated
</success_criteria>

<purpose>
Generate an AI design contract (AI-SPEC.md) for phases that involve building AI systems. Orchestrates gsd-framework-selector → gsd-ai-researcher → gsd-domain-researcher → gsd-eval-planner with a validation gate. Inserts between discuss-phase and plan-phase in the GSD lifecycle.

AI-SPEC.md locks four things before the planner creates tasks:
1. Framework selection (with rationale and alternatives)
2. Implementation guidance (correct syntax, patterns, pitfalls from official docs)
3. Domain context (practitioner rubric ingredients, failure modes, regulatory constraints)
4. Evaluation strategy (dimensions, rubrics, tooling, reference dataset, guardrails)

This prevents the two most common AI development failures: choosing the wrong framework for the use case, and treating evaluation as an afterthought.
</purpose>

<required_reading>
@~/.claude/gsd-core/references/ai-frameworks.md
@~/.claude/gsd-core/references/ai-evals.md
</required_reading>

<process>

## 1. Initialize

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(gsd_run query init.plan-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`, `has_context`, `has_research`, `commit_docs`, `response_language`.

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

**File paths:** `state_path`, `roadmap_path`, `requirements_path`, `context_path`.

Resolve agent models:
```bash
SELECTOR_MODEL=$(gsd_run query resolve-model gsd-framework-selector --pick model 2>/dev/null || true)
RESEARCHER_MODEL=$(gsd_run query resolve-model gsd-ai-researcher --pick model 2>/dev/null || true)
DOMAIN_MODEL=$(gsd_run query resolve-model gsd-domain-researcher --pick model 2>/dev/null || true)
PLANNER_MODEL=$(gsd_run query resolve-model gsd-eval-planner --pick model 2>/dev/null || true)
```

Check config:
```bash
AI_PHASE_ENABLED=$(gsd_run query config-get workflow.ai_integration_phase --raw 2>/dev/null || echo "true")
```

**If `AI_PHASE_ENABLED` is `false`:**
```
AI phase is disabled in config. Enable via /gsd:settings.
```
Exit workflow.

**If `planning_exists` is false:** Error — run `/gsd:new-project` first.

## 2. Parse and Validate Phase

Extract phase number from $ARGUMENTS. If not provided, this orchestrator (not `gsd-tools.cjs`) detects the next unplanned phase: run `gsd_run query roadmap.analyze` and read its `next_phase` field (the first phase whose `disk_status` is `no_directory`, `empty`, `discussed`, or `researched` — i.e. not yet planned). `query roadmap.get-phase` below hard-requires an explicit `${PHASE}` and does not auto-detect.

```bash
PHASE_INFO=$(gsd_run query roadmap.get-phase "${PHASE}")
```

**If `found` is false:** Error with available phases.

## 3. Check Prerequisites

**If `has_context` is false:**
```
No CONTEXT.md found for Phase {N}.
Recommended: run /gsd:discuss-phase {N} first to capture framework preferences.
Continuing without user decisions — framework selector will ask all questions.
```
Continue (non-blocking).

## 4. Check Existing AI-SPEC

```bash
AI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-AI-SPEC.md 2>/dev/null | head -1)
```

**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
**If exists:** Use AskUserQuestion:
- header: "Existing AI-SPEC"
- question: "AI-SPEC.md already exists for Phase {N}. What would you like to do?"
- options:
  - "Update — re-run with existing as baseline"
  - "View — display current AI-SPEC and exit"
  - "Skip — keep current AI-SPEC and exit"

If "View": display file contents, exit.
If "Skip": exit.
If "Update": continue to step 5.

## 5. Spawn gsd-framework-selector

Display:
```
### GSD ► AI DESIGN CONTRACT — PHASE {N}: {name}

◆ Step 1/4 — Framework Selection...
```

Spawn `gsd-framework-selector` with:
```markdown
Read ~/.claude/agents/gsd-framework-selector.md for instructions.

<objective>
Select the right AI framework for Phase {phase_number}: {phase_name}
Goal: {phase_goal}
</objective>

<required_reading>
{context_path if exists}
{requirements_path if exists}
</required_reading>

<phase_context>
Phase: {phase_number} — {phase_name}
Goal: {phase_goal}
</phase_context>
```

Parse selector output for: `primary_framework`, `system_type`, `model_provider`, `eval_concerns`, `alternative_framework`.

**If selector fails or returns empty:** Exit with error — "Framework selection failed. Re-run /gsd:ai-integration-phase {N} or answer the framework question in /gsd:discuss-phase {N} first."

## 6. Initialize AI-SPEC.md

Copy template:
```bash
cp "$HOME/.claude/gsd-core/templates/AI-SPEC.md" "${PHASE_DIR}/${PADDED_PHASE}-AI-SPEC.md"
```

Fill in header fields:
- Phase number and name
- System classification (from selector)
- Selected framework (from selector)
- Alternative considered (from selector)

## 7. Spawn gsd-ai-researcher

> **Ordering note (prevents tool-level last-writer-wins race):** Steps 7 and 8 write disjoint sections of AI-SPEC.md but MUST run sequentially — wait for Step 7 to complete before spawning Step 8. Both agents use the `Edit` tool exclusively (never `Write`) when modifying AI-SPEC.md. A `Write` on a shared file replaces the entire file, silently overwriting the other agent's work; `Edit` targets only the relevant lines. See #3096 for a confirmed 40%-incidence race on parallel dispatch.

Display:
```
◆ Step 2/4 — Researching {primary_framework} docs + AI systems best practices...
```

Spawn `gsd-ai-researcher` with:
```markdown
Read ~/.claude/agents/gsd-ai-researcher.md for instructions.

**Tool discipline (mandatory):**
Use the Edit tool exclusively when modifying AI-SPEC.md — NEVER use Write on this file.
Write replaces the entire file and will overwrite work from parallel or sequential sibling agents.
Before editing, verify the section you are about to write is still a template placeholder.

<objective>
</objective>

<required_reading>
{ai_spec_path}
{context_path if exists}
</required_reading>

<input>
framework: {primary_framework}
system_type: {system_type}
model_provider: {model_provider}
ai_spec_path: {ai_spec_path}
phase_context: Phase {phase_number}: {phase_name} — {phase_goal}
</input>
```

## 8. Spawn gsd-domain-researcher

> **Wait for Step 7 to complete before spawning this step** (see ordering note in Step 7).

Display:
```
◆ Step 3/4 — Researching domain context and expert evaluation criteria...
```

Spawn `gsd-domain-researcher` with:
```markdown
Read ~/.claude/agents/gsd-domain-researcher.md for instructions.

**Tool discipline (mandatory):**
Use the Edit tool exclusively when modifying AI-SPEC.md — NEVER use Write on this file.
Write replaces the entire file and will overwrite work from parallel or sequential sibling agents.
Before editing, verify the section you are about to write is still a template placeholder.

<objective>
</objective>

<required_reading>
{ai_spec_path}
{context_path if exists}
{requirements_path if exists}
</required_reading>

<input>
system_type: {system_type}
phase_name: {phase_name}
phase_goal: {phase_goal}
ai_spec_path: {ai_spec_path}
</input>
```

## 9. Spawn gsd-eval-planner

Display:
```
◆ Step 4/4 — Designing evaluation strategy from domain + technical context...
```

Spawn `gsd-eval-planner` with:
```markdown
Read ~/.claude/agents/gsd-eval-planner.md for instructions.

<objective>
Design evaluation strategy for Phase {phase_number}: {phase_name}
Write Sections 5, 6, and 7 of AI-SPEC.md
AI-SPEC.md now contains domain context (Section 1b) — use it as your rubric starting point.
</objective>

<required_reading>
{ai_spec_path}
{context_path if exists}
{requirements_path if exists}
</required_reading>

<input>
system_type: {system_type}
framework: {primary_framework}
model_provider: {model_provider}
phase_name: {phase_name}
phase_goal: {phase_goal}
ai_spec_path: {ai_spec_path}
</input>
```

## 10. Validate AI-SPEC Completeness

Read the completed AI-SPEC.md. Check that:
- Section 2 has a framework name (not placeholder)
- Section 1b has at least one domain rubric ingredient (Good/Bad/Stakes)
- Section 3 has a non-empty code block (entry point pattern)
- Section 4b has a Pydantic example
- Section 5 has at least one row in the dimensions table
- Section 6 has at least one guardrail or explicit "N/A for internal tool" note
- Checklist section at end has 3+ items checked

**If validation fails:** Display specific missing sections. Ask user if they want to re-run the specific step or continue anyway.

## 11. Commit

```bash
gsd_run query commit "docs({phase_slug}): generate AI-SPEC.md — {primary_framework} + domain context + eval strategy" --files "${AI_SPEC_FILE}"
```

## 12. Display Completion

```
### GSD ► AI-SPEC COMPLETE — PHASE {N}: {name}

◆ Framework: {primary_framework}
◆ System Type: {system_type}
◆ Domain: {domain_vertical from Section 1b}
◆ Eval Dimensions: {eval_concerns}
◆ Tracing Default: Arize Phoenix (or detected existing tool)
◆ Output: {ai_spec_path}

Next step:
  /gsd:plan-phase {N}   — planner will consume AI-SPEC.md
```

</process>

<success_criteria>
- [ ] Framework selected with rationale (Section 2)
- [ ] AI-SPEC.md created from template
- [ ] Framework docs + AI best practices researched (Sections 3, 4, 4b populated)
- [ ] Domain context + expert rubric ingredients researched (Section 1b populated)
- [ ] Eval strategy grounded in domain context (Sections 5-7 populated)
- [ ] Arize Phoenix (or detected tool) set as tracing default in Section 7
- [ ] AI-SPEC.md validated (Sections 1b, 2, 3, 4b, 5, 6 all non-empty)
- [ ] Committed if commit_docs enabled
- [ ] Next step surfaced to user
</success_criteria>

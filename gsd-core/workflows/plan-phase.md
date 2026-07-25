<!-- gsd:loop-host
step: plan
points: plan:pre, plan:post
agent-roles: researcher, planner, checker
produces: PLAN.md
consumes: CONTEXT.md
-->
<purpose>
Create executable phase prompts (PLAN.md files) for a roadmap phase with integrated research and verification. Default flow: Research (if needed) -> Plan -> Verify -> Done. Orchestrates gsd-phase-researcher, gsd-planner, and gsd-plan-checker agents with a revision loop (max 3 iterations).
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.

@~/.claude/gsd-core/references/ui-brand.md
@~/.claude/gsd-core/references/revision-loop.md
@~/.claude/gsd-core/references/gate-prompts.md
@~/.claude/gsd-core/references/agent-contracts.md
@~/.claude/gsd-core/references/gates.md
</required_reading>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-phase-researcher — Researches technical approaches for a phase
- gsd-pattern-mapper — Analyzes codebase for existing patterns, produces PATTERNS.md
- gsd-planner — Creates detailed plans from phase scope
- gsd-plan-checker — Reviews plan quality before execution
</available_agent_types>

<runtime_compatibility>
**Subagent spawning — top-level Claude Code:**
The Agent tool IS available in a top-level Claude Code session. Always spawn
gsd-phase-researcher, gsd-planner, and gsd-plan-checker as separate Agent() calls.
Never absorb these roles inline. Role separation is required regardless of `--chain`
or `--auto` — those options suppress interactive prompts only; they NEVER authorize
collapsing plan roles into the orchestrator context.

**Backgrounded Claude Code (via manager/autonomous):**
The calling workflow (manager.md / autonomous.md) already runs plan-phase inline via
Skill() on Claude Code so that the plan-checker subagent can still spawn. plan-phase
itself does not need to detect this case.

**#1009 caveat (discuss-phase early-exit):**
The "display the command and exit" instruction near `## 4` applies only to the
discuss-phase early-exit path. It does NOT authorize inline role performance for any
plan-phase agents.

**Other runtimes:**
Do not pre-judge Agent availability by introspection. Always attempt the actual
Agent() call for gsd-phase-researcher, gsd-planner, and gsd-plan-checker. Only
a real tool-unavailable error returned by Agent() is a reliable absence signal —
never stop based on a self-assessed "I think Agent is unavailable." If the call
fails with a tool-unavailable error, log the gap and stop — do NOT collapse
researcher/planner/checker roles inline. Independent agent contexts are required
for the plan-checker gate to be meaningful.
</runtime_compatibility>

<process>

## 0. Git Branch Invariant

**Do not create, rename, or switch git branches during plan-phase.** Branch identity is established at discuss-phase and is owned by the user's git workflow. A phase rename in ROADMAP.md is a plan-level change only — it does not mutate git branch names. If `phase_slug` in the init JSON differs from the current branch name, that is expected and correct; leave the branch unchanged.

## 1. Initialize

Load all context in one call (paths only to minimize orchestrator context):

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
GRAN_PARAM=""; if [[ "$ARGUMENTS" =~ (^|[[:space:]])--granularity[[:space:]]+([^[:space:]-][^[:space:]]*) ]]; then GRAN_PARAM="--granularity ${BASH_REMATCH[2]}"; fi
INIT=$(gsd_run query init.plan-phase "$PHASE" $GRAN_PARAM)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_RESEARCHER=$(gsd_run query agent-skills gsd-phase-researcher)
AGENT_SKILLS_PLANNER=$(gsd_run query agent-skills gsd-planner)
AGENT_SKILLS_CHECKER=$(gsd_run query agent-skills gsd-plan-checker)
CONTEXT_WINDOW=$(gsd_run query config-get context_window 2>/dev/null || echo "200000")
MVP_MODE_CFG=$(gsd_run query config-get workflow.mvp_mode 2>/dev/null || echo "false")
```

When the tdd capability's `workflow.tdd_mode` is active (resolved via the plan:pre render-hooks), the planner agent is instructed to apply `type: tdd` to eligible tasks using heuristics from `references/tdd.md`. The TDD guidance is injected via the tdd capability's contribution hook at §5.6; no inline config-get is needed.

When `CONTEXT_WINDOW >= 500000`, the planner prompt includes the 3 most recent prior-phase CONTEXT.md/SUMMARY.md files plus any phases in the current phase's `Depends on:` field (explicit deps load regardless of recency).

Parse JSON for: `researcher_model`, `planner_model`, `checker_model`, `research_enabled`, `plan_checker_enabled`, `nyquist_validation_enabled`, `commit_docs`, `text_mode`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`, `has_research`, `has_context`, `has_reviews`, `has_plans`, `plan_count`, `phase_status` (#3569), `planning_exists`, `roadmap_exists`, `phase_req_ids`, `response_language`, `granularity`.

**#2517:** omit the `model=` param from an `Agent()` call when its `researcher`/`planner`/`checker`_model is `"inherit"` or empty — passing `model=""` 404s on non-Claude runtimes; omitting inherits the orchestrator model (mirrors execute-phase).

**If `response_language` is set:** All user-facing orchestrator output MUST be in `{response_language}`; technical terms, code, paths, and subagent prompts stay in English. Pass `response_language: {value}` into every spawned subagent prompt.

**File paths (for <files_to_read> blocks):** `state_path`, `roadmap_path`, `requirements_path`, `context_path`, `research_path`, `verification_path`, `uat_path`, `reviews_path`. These are null if files don't exist.

**If `planning_exists` is false:** Error — run `/gsd:new-project` first.

## 1.5. Closed-Phase Gate (#3569)

Read and execute `gsd-core/workflows/plan-phase/steps/closed-phase-gate.md` — it parses `phase_status` from the init JSON, sets `FORCE_REPLAN` from `$ARGUMENTS`, and hard-stops replanning a `Complete` phase: `--reviews` on a closed phase is never overridable (exit 1), and replanning otherwise requires `--force` (else exit 1, pointing at `${verification_path}`); under `--force` it continues but emits a WARNING banner. Only `Complete` is gated — `Executed` / `Needs Review` are legitimate replans.

## 2. Parse and Normalize Arguments

Extract from $ARGUMENTS: phase number (integer or decimal like `2.1`), flags (`--research`, `--skip-research`, `--research-phase <N>`, `--gaps`, `--skip-verify`, `--skip-ui`, `--prd <filepath>`, `--ingest <path-or-glob>`, `--ingest-format <auto|nygard|madr|narrative>`, `--reviews`, `--text`, `--bounce`, `--skip-bounce`, `--chunked`, `--mvp`, `--no-tracer`, `--no-reversibility-gates`, `--tdd`, `--granularity <coarse|standard|fine>`, `--force` (override closed-phase gate, see §1.5)).

**`--research-phase <N>` — research-only mode (#3042 + #3044).** When this flag is present, parse `<N>` as the phase number (overrides any positional phase argument), set `RESEARCH_ONLY=true`, and treat the rest of this workflow as a research-dispatch only — the planner spawn (step 8), plan-checker, verification, gaps, bounce, and post-planning-gaps blocks all skip on `RESEARCH_ONLY`. Use this for cross-phase research, doc review before committing to a planning approach, and correction-without-replanning loops. Replaces the deleted `/gsd-research-phase` command.

In research-only mode, two modifiers control behavior when `RESEARCH.md` already exists:

- **`--research`** — force-refresh re-research without prompting. Re-spawns the researcher unconditionally and overwrites the existing RESEARCH.md. (This is the existing `--research` flag's standard "force re-research" semantics, reused here.)
- **`--view`** — view-only: print existing `RESEARCH.md` to stdout, do **not** spawn the researcher. Sets `VIEW_ONLY=true`. Cheapest mode for the correction-without-replanning loop. If `RESEARCH.md` does not exist, error with a hint to drop `--view`.

```bash
RESEARCH_ONLY=false
VIEW_ONLY=false
if [[ "$ARGUMENTS" =~ --research-phase[[:space:]]+([0-9]+(\.[0-9]+)?) ]]; then
  RESEARCH_ONLY=true
  PHASE="${BASH_REMATCH[1]}"
fi
if $RESEARCH_ONLY && [[ "$ARGUMENTS" =~ (^|[[:space:]])--view([[:space:]]|$) ]]; then
  VIEW_ONLY=true
fi
```

**`--granularity <coarse|standard|fine>` — CLI override (#703).** When present, this value is the resolved granularity passed to the planner — it wins over any per-phase `granularities.<type>` config, top-level `granularity` config, or project defaults. The init JSON always includes a `granularity` field reflecting the resolved value; read it from there. Invalid values (anything other than `coarse`, `standard`, `fine`) cause an error at the CLI boundary.

Set `TEXT_MODE=true` if `--text` is present in $ARGUMENTS OR `text_mode` from init JSON is `true`. When `TEXT_MODE` is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for Claude Code remote sessions (`/rc` mode) where TUI menus don't work through the Claude App.

**MVP_MODE resolution.** Resolve `MVP_MODE` once via the centralized `phase.mvp-mode` query verb. Precedence (first hit wins): CLI flag → ROADMAP.md `**Mode:** mvp` → `workflow.mvp_mode` config → false. The verb is the single source of truth — do not re-implement the chain.

```bash
MVP_FLAG_ARG=""
if [[ "$ARGUMENTS" =~ (^|[[:space:]])--mvp([[:space:]]|$) ]]; then MVP_FLAG_ARG="--cli-flag"; fi
if [[ "$ARGUMENTS" =~ (^|[[:space:]])--tdd([[:space:]]|$) ]]; then
  gsd_run query config-set workflow.tdd_mode true 2>/dev/null || true
fi
# Tracer-first is the default; --no-tracer opts back into the legacy horizontal-layer shape.
TRACER_MODE=true
if [[ "$ARGUMENTS" =~ (^|[[:space:]])--no-tracer([[:space:]]|$) ]]; then TRACER_MODE=false; fi
REVERSIBILITY_GATES=true
if [[ "$ARGUMENTS" =~ (^|[[:space:]])--no-reversibility-gates([[:space:]]|$) ]]; then REVERSIBILITY_GATES=false; fi
```

**Baseline-discipline flags.** `TRACER_MODE` and `REVERSIBILITY_GATES` default to `true`; neither is persisted per-phase nor read from config.

Defer the `phase.mvp-mode` query until `PHASE` is finalized (after explicit argument parsing/fallback phase detection + validation). The verb returns `true|false`; full result also exposes `source` (`cli_flag` | `roadmap` | `config` | `none`) for diagnostics. Mode is **all-or-nothing per phase** (PRD decision Q1).

**Walking Skeleton gate.** When `MVP_MODE=true` AND `phase_number == "01"` AND there are zero prior phase summaries (new project), the planner runs in **Walking Skeleton mode** (per PRD decision Q2 — new projects only). Detect with:

```bash
WALKING_SKELETON=false
if [ "$MVP_MODE" = "true" ] && [ "$padded_phase" = "01" ]; then
  PRIOR_SUMMARIES=$(gsd_run query phases.list --pick summaries_total 2>/dev/null || echo "0")
  if [ "$PRIOR_SUMMARIES" = "0" ]; then WALKING_SKELETON=true; fi
fi
```

When `WALKING_SKELETON=true`:
- Planner is instructed to produce `SKELETON.md` in the phase directory alongside `PLAN.md`. The template lives at `~/.claude/gsd-core/references/skeleton-template.md` — the planner reads it when producing SKELETON.md (lazy; not loaded on non-skeleton runs).
- The plan must scaffold project + routing + one real DB read/write + one real UI interaction + dev deployment — the thinnest possible end-to-end working slice.

**Interaction with `--prd <filepath>`.** `--mvp` and `--prd` compose. The PRD express path (Step 3.5) creates `CONTEXT.md` from the PRD file and continues to research; the Walking Skeleton gate fires independently from the conditions above. When both are active on Phase 1 of a new project, the planner receives `WALKING_SKELETON=true` and PRD-derived context simultaneously — the PRD informs *what the skeleton should prove*. No precedence is needed; the two signals are orthogonal. See [`references/mvp-concepts.md`](../references/mvp-concepts.md) for the broader interaction map.

Extract express-path args from $ARGUMENTS: `PRD_FILE` (`--prd <filepath>`), `INGEST_PATH` (`--ingest <path-or-glob>`), and optional `INGEST_FORMAT` (`--ingest-format <auto|nygard|madr|narrative>`, default `auto`).

`--prd` and `--ingest` are mutually exclusive. If both are present, error and exit:
`Invalid arguments: cannot combine \`--prd\` with \`--ingest\`.`

**If no phase number:** Auto-detect it — `query init.plan-phase` and `query roadmap.get-phase` require an explicit number, so this is an orchestrator step. Run `gsd_run query roadmap.analyze` and read `next_phase` (first phase with `disk_status` of `no_directory`, `empty`, `discussed`, or `researched`). If `next_phase` is `null`, read ROADMAP.md's `### Phase N:` headers and ask the user which phase to plan. Set `PHASE` to the result before step 1's `query init.plan-phase "$PHASE"` call.

**If `phase_found` is false:** Validate phase exists in ROADMAP.md. If valid, create the directory using `expected_phase_dir` from init (includes `project_code` prefix when set):
```bash
mkdir -p "${expected_phase_dir}"
```

Set `phase_dir="${expected_phase_dir}"` after creation.

**Existing artifacts from init:** `has_research`, `has_plans`, `plan_count`.

Set `CHUNKED_MODE` from flag or config:
```bash
CHUNKED_CFG=$(gsd_run query config-get workflow.plan_chunked 2>/dev/null || echo "false")
CHUNKED_MODE=false
if [[ "$ARGUMENTS" =~ --chunked ]] || [[ "$CHUNKED_CFG" == "true" ]]; then
  CHUNKED_MODE=true
fi
```

## 2.5. Validate `--reviews` Prerequisite

**Skip if:** No `--reviews` flag.

**If `--reviews` AND `--gaps`:** Error — cannot combine `--reviews` with `--gaps`. These are conflicting modes.

**If `--reviews` AND `has_reviews` is false (no REVIEWS.md in phase dir):**

Error:
```
No REVIEWS.md found for Phase {N}. Run reviews first:

/gsd:review --phase {N}

Then re-run /gsd:plan-phase {N} --reviews
```
Exit workflow.

## 3. Validate Phase

```bash
PHASE_INFO=$(gsd_run query roadmap.get-phase "${PHASE}")
```

**If `found` is false:** Error with available phases. **If `found` is true:** Extract `phase_number`, `phase_name`, `goal` from JSON.

Now that `PHASE` is finalized, resolve MVP mode:
```bash
MVP_MODE=$(gsd_run query phase.mvp-mode "${PHASE}" $MVP_FLAG_ARG --pick active)
```

## 3.5. Handle PRD Express Path

**Skip if:** No `--prd` flag in arguments.

**If `--prd <filepath>` provided:**

Read and execute `gsd-core/workflows/plan-phase/steps/prd-express-path.md` — it reads the PRD (`$PRD_FILE`), generates `CONTEXT.md` (every PRD requirement/story/criterion → locked decision, uncovered areas → "Claude's Discretion", canonical refs extracted from ROADMAP.md + PRD-referenced specs), commits it, sets `context_content`, and bypasses step 4 (Load CONTEXT.md). The rest of the workflow proceeds normally with the PRD-derived context.

## 3.6. Handle ADR Ingest Express Path

**Skip if:** No `--ingest` flag in arguments.

**If `--ingest <path-or-glob>` provided:**

1. Display banner: `GSD ► ADR Ingest Express Path` with `{INGEST_PATH}` and `{INGEST_FORMAT}`.
2. Parse each resolved ADR through `gsd-core/bin/lib/adr-parser.cjs` (`--input`, `--format`) and collect normalized records.
3. Status gate: reject `superseded`/`rejected`/`deprecated`; warn on `proposed`; missing status defaults to `accepted`.
4. Empty-decisions fallback: if all parsed ADRs have zero `decisions[]`, emit `ADR ingest produced no locked decisions; fall back to discuss-phase for this phase.` and exit with `/gsd:discuss-phase {N}` guidance.
5. Generate CONTEXT.md using `<domain>`, `<decisions>`, `<canonical_refs>`, `<specifics>`, `<deferred>`, `<scope_fence>`, map `consequences_positive[]` to Success Criteria and `consequences_negative[]` to Risk Summary, and include `**Source:** ADR Ingest Express Path ({INGEST_PATH})`.
6. Commit with `gsd-tools.cjs query commit "docs(${padded_phase}): generate context from ADR ingest" --files "${phase_dir}/${padded_phase}-CONTEXT.md"` and set `context_content`; continue to step 5.

**Effect:** This bypasses step 4 (Load CONTEXT.md) since CONTEXT.md was synthesized from ADR input.

## 4. Load CONTEXT.md

**Skip if:** PRD express path or ADR ingest express path was used (CONTEXT.md already created in step 3.5/3.6).

Check `context_path` from init JSON.

If `context_path` is not null, display: `Using phase context from: ${context_path}`

**If `context_path` is null (no CONTEXT.md exists):**

Read discuss mode for context gate label:
```bash
DISCUSS_MODE=$(gsd_run query config-get workflow.discuss_mode 2>/dev/null || echo "discuss")
```

If `TEXT_MODE` is true, present as a plain-text numbered list:
```
No CONTEXT.md found for Phase {X}. Plans will use research and requirements only — your design preferences won't be included.

1. Continue without context — Plan using research + requirements only
[If DISCUSS_MODE is "assumptions":]
2. Gather context (assumptions mode) — Analyze codebase and surface assumptions before planning
[If DISCUSS_MODE is "discuss" or unset:]
2. Run discuss-phase first — Capture design decisions before planning

Enter number:
```

Otherwise use AskUserQuestion:
- header: "No context"
- question: "No CONTEXT.md found for Phase {X}. Plans will use research and requirements only — your design preferences won't be included. Continue or capture context first?"
- options:
  - "Continue without context" — Plan using research + requirements only
  If `DISCUSS_MODE` is `"assumptions"`:
  - "Gather context (assumptions mode)" — Analyze codebase and surface assumptions before planning
  If `DISCUSS_MODE` is `"discuss"` (or unset):
  - "Run discuss-phase first" — Capture design decisions before planning

If "Continue without context": Proceed to step 5.
If "Run discuss-phase first":
  **IMPORTANT:** Do NOT invoke discuss-phase as a nested Skill/Task call — AskUserQuestion
  does not work correctly in nested subcontexts (#1009). Instead, display the command
  and exit so the user runs it as a top-level command:
  ```
  Run this command first, then re-run /gsd:plan-phase {X} ${GSD_WS}:

  /gsd:discuss-phase {X} ${GSD_WS}
  ```
  **Exit the plan-phase workflow. Do not continue.**

## 4.5. Resolve AI-SPEC Artifact

AI integration activation is owned by the `ai-integration` capability's `plan:pre` step hook. The plan-phase host only discovers existing artifacts here so the planner can consume them; it must not read the capability's config key directly.

```bash
AI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-AI-SPEC.md 2>/dev/null | head -1)
AI_SPEC_PATH="${AI_SPEC_FILE}"
FRAMEWORK_LINE=""
if [ -n "$AI_SPEC_FILE" ]; then
  FRAMEWORK_LINE=$(grep "Selected Framework:" "${AI_SPEC_FILE}" | head -1)
fi
```

If `AI_SPEC_FILE` is non-empty, pass `AI_SPEC_PATH` and `FRAMEWORK_LINE` to the planner in step 8 so it can reference the AI design contract. If it is empty, the active `ai-integration` capability hook in step 5.6 handles any AI-system nudge or `/gsd:ai-integration-phase` dispatch.

## 5. Handle Research

**Skip if:** `--gaps` flag or `--skip-research` flag or `--reviews` flag.

### 5.0. Research-Only Modifiers (`--view`, `--research`)

**Skip if:** `RESEARCH_ONLY` is `false`.

Three branches in research-only mode (`--research-phase <N>`):

1. **`--view`**: print `RESEARCH.md` to stdout, no spawn, exit. If `RESEARCH.md` is missing, error with: `--view requires an existing RESEARCH.md; drop --view to spawn the researcher.`
2. **`--research`** (force-refresh): re-spawn researcher unconditionally — fall through to "Spawn gsd-phase-researcher" below.
3. **Neither flag AND `has_research=true`:** auto-use the existing research and exit cleanly — do not prompt, do not re-spawn. Emit `RESEARCH.md already exists for Phase ${PHASE}, using it. To force-refresh, re-invoke with --research; to print, re-invoke with --view. Path: ${research_path}` then exit. The explicit-flag escape hatches cover any deviation; this matches §5.1's promptless auto-use of existing research, removing the §5.0/§5.1 inconsistency (#159).

```bash
if [[ "$VIEW_ONLY" == "true" ]]; then
  [[ -f "$research_path" ]] || { echo "Error: --view requires an existing RESEARCH.md (Phase ${PHASE}). Drop --view to spawn the researcher."; exit 1; }
  cat "$research_path"; exit 0
fi
```

### 5.1. Standard Research Decision

**Skip if** `RESEARCH_ONLY=true` (the research-only mode in 5.0 already determined the path: spawn or exit). Without this guard, an LLM following the workflow could fall through into "use existing, skip to step 6" → planner spawn, violating the research-only contract. **CR #3045 finding: this gate makes the early-exit unreachable from any non-research-only branch.**

**If `has_research` is true (from init) AND no `--research` flag:** Use existing, skip to step 6.

**If RESEARCH.md missing OR `--research` flag:**

**If no explicit flag (`--research` or `--skip-research`) and not `--auto`:**
Ask the user whether to research, with a contextual recommendation based on the phase:

If `TEXT_MODE` is true, present as a plain-text numbered list:
```
Research before planning Phase {X}: {phase_name}?

1. Research first (Recommended) — Investigate domain, patterns, and dependencies before planning. Best for new features, unfamiliar integrations, or architectural changes.
2. Skip research — Plan directly from context and requirements. Best for bug fixes, simple refactors, or well-understood tasks.

Enter number:
```

Otherwise use AskUserQuestion:
```
AskUserQuestion([
  {
    question: "Research before planning Phase {X}: {phase_name}?",
    header: "Research",
    multiSelect: false,
    options: [
      { label: "Research first (Recommended)", description: "Investigate domain, patterns, and dependencies before planning. Best for new features, unfamiliar integrations, or architectural changes." },
      { label: "Skip research", description: "Plan directly from context and requirements. Best for bug fixes, simple refactors, or well-understood tasks." }
    ]
  }
])
```

If user selects "Skip research": skip to step 6.

**If `--auto` and `research_enabled` is false:** Skip research silently (preserves automated behavior).

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► RESEARCHING PHASE {X}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning researcher... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

### Spawn gsd-phase-researcher

```bash
if gsd_run query teams-status --active >/dev/null 2>&1; then
  echo "⚠️  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS detected. GSD's multi-agent orchestration is not validated under claude-code agent-teams and may stall (a subagent's completion can fail to route to the orchestrator). Recommend disabling agent-teams for GSD workflows. See https://github.com/open-gsd/gsd-core/issues/1355" >&2
fi
```

```bash
PHASE_DESC=$(gsd_run query roadmap.get-phase "${PHASE}" --pick section)
if [ -z "${PLAN_PRE_HOOKS_JSON:-}" ]; then
  PLAN_PRE_HOOKS_JSON=$(gsd_run loop render-hooks plan:pre --raw)
fi
```

Find the active `research` step hook in `PLAN_PRE_HOOKS_JSON`. Use the hook's `fragment.inline` as the prompt template and substitute the phase fields below before spawning its declared `ref.agent`.

```markdown
{research_hook.fragment.inline}
```

```
Agent(
  prompt=filled_research_hook_fragment,
  subagent_type=research_hook.ref.agent,
  model="{researcher_model}",
  description="Research Phase {phase}"
)
```

> **ORCHESTRATOR RULE — ALL RUNTIMES**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

### Handle Researcher Return

- **`## RESEARCH COMPLETE`:** Display confirmation, continue to step 6
- **`## RESEARCH BLOCKED`:** Display blocker, offer: 1) Provide context, 2) Skip research, 3) Abort

### Research-Only Early Exit (`--research-phase`)

**Skip if:** `RESEARCH_ONLY` is `false` (the default).

**If `RESEARCH_ONLY=true`:** the user invoked `/gsd:plan-phase --research-phase <N>` for research-only mode. Do **not** continue to Section 5.5+ (validation strategy, planner, plan-checker, verification, gaps, bounce, post-planning-gaps). Print the research-complete summary and exit cleanly:

```text
✓ Research-only mode complete (#3042)

  Phase:       ${PHASE}
  RESEARCH.md: ${research_path}

Re-run /gsd:plan-phase ${PHASE} to plan the phase using this research,
or /gsd:plan-phase ${PHASE} --research to refresh research and plan.
```

This exits the workflow. The planner / plan-checker / verifier blocks below are skipped.

## 5.5. Create Validation Strategy

Skip if `nyquist_validation_enabled` is false OR `research_enabled` is false.

If `research_enabled` is false and `nyquist_validation_enabled` is true: warn "Nyquist validation enabled but research disabled — VALIDATION.md cannot be created without RESEARCH.md. Plans will lack validation requirements (Dimension 8)." Continue to step 6.

**But Nyquist is not applicable for this run** when all of the following are true:
- `research_enabled` is false
- `has_research` is false
- no `--research` flag was provided

In that case: **skip validation-strategy creation entirely**. Do **not** expect `RESEARCH.md` or `VALIDATION.md` for this run, and continue to Step 6.

```bash
grep -l "## Validation Architecture" "${PHASE_DIR}"/*-RESEARCH.md 2>/dev/null || true
```

**If found:**
1. Read template: `~/.claude/gsd-core/templates/VALIDATION.md`
2. Write to `${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md` (use Write tool)
3. Fill frontmatter: `{N}` → phase number, `{phase-slug}` → slug, `{date}` → current date
4. Verify:
```bash
test -f "${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md" && echo "VALIDATION_CREATED=true" || echo "VALIDATION_CREATED=false"
```
5. If `VALIDATION_CREATED=false`: STOP — do not proceed to Step 6
6. If `commit_docs`: `commit "docs(phase-${PHASE}): add validation strategy"`

**If not found:** Warn and continue — plans may fail Dimension 8.

## 5.55. Security Threat Model Gate

> Capability-driven dispatch. Resolves active `plan:pre` hooks via the capability registry; the security hook's `when` condition is evaluated by the registry.

```bash
PLAN_PRE_HOOKS_JSON=$(gsd_run loop render-hooks plan:pre --raw)
```

Resolve active contribution hooks from `PLAN_PRE_HOOKS_JSON` where `kind == "contribution"` and `capId == "security"`.

**If no active security contribution hook exists:** Skip to step 5.6.

**If an active security contribution hook exists:** Read `SECURITY_ASVS` from the active hook's `configValues.security_asvs_level` (default: `1`) and `SECURITY_BLOCK` from `configValues.security_block_on` (default: `"high"`). These values are resolved by the capability registry from user config using the same four-level precedence as hook activation — no inline `config-get` is needed.

Display banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► SECURITY THREAT MODEL REQUIRED (ASVS L{SECURITY_ASVS})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Each PLAN.md must include a <threat_model> block.
Block on: {SECURITY_BLOCK} severity threats.
Opt out: set security_enforcement: false in .planning/config.json
```

Continue to step 5.6. Security config is passed to the planner in step 8.

## 5.6. Plan:Pre Capability Dispatch and UI Design Contract Gate

> Capability-driven dispatch. Resolves active `plan:pre` hooks via the capability registry; each hook's `when` condition is evaluated by the registry — no inline config-get needed. This section handles skill-based planning preflights such as `ai-integration`, agent-backed hooks through `ref.agent`, and the UI gate whose deterministic check comes from `check.query`.
>
> **Config semantics (cutover fix):** `workflow.ui_phase` gates UI-SPEC *generation* (step); `workflow.ui_safety_gate` gates the *planning block* (gate). Both-on = identical to OLD §5.6. Intended change: `{ui_phase:true, ui_safety_gate:false}` now auto-generates in pipelines but does NOT block manual planning (each key controls exactly what its description says).

```bash
PLAN_PRE_HOOKS_JSON=${PLAN_PRE_HOOKS_JSON:-$(gsd_run loop render-hooks plan:pre --raw)}
HOOKS_JSON="$PLAN_PRE_HOOKS_JSON"
```

Read the `activeHooks` array directly from `PLAN_PRE_HOOKS_JSON` / `HOOKS_JSON` (in-context — do NOT invoke a shell pipeline).

**Branch 1 — all plan:pre hooks inactive (`activeHooks` is empty or absent):** Skip to step 6.

**Generic step hook dispatch contract:** For each active entry where `kind == "step"`:
- If `ref.skill` is set, dispatch with `Skill(skill="gsd-${ref.skill}", args="${PHASE} --auto ${GSD_WS}")` when pipeline mode allows auto-chaining. Prepend `gsd-` to `ref.skill` — `ui-phase` → `gsd-ui-phase`.
- If `ref.agent` is set, dispatch with `Agent(prompt=filled_hook_fragment, subagent_type=ref.agent, model="{researcher_model}")`. Use the hook's `fragment.inline` as the prompt body and fill phase fields before spawning.
- The `research` hook is handled by §5.1's research decision. The `pattern-mapper` hook is handled by §7.8 after `RESEARCH_PATH` is known. Future plan:pre agent hooks use the same `ref.agent` fragment contract.

**AI integration capability:** If the active `ai-integration` step hook is present, `AI_SPEC_PATH` is empty, and the phase goal contains AI keywords (`agent`, `llm`, `rag`, `chatbot`, `embedding`, `langchain`, `llamaindex`, `crewai`, `langgraph`, `openai`, `anthropic`, `vector`, `eval`, `ai system`), then:
- In pipeline / `--auto` mode, invoke the hook's `ref.skill` via `Skill(skill="gsd-${ref.skill}", args="${PHASE} --auto ${GSD_WS}")`.
- In manual mode, display the existing non-blocking `/gsd:ai-integration-phase {N}` recommendation and let the user continue planning without AI-SPEC or stop to run the capability workflow first.

Run the UI deterministic gate whenever **any** `plan:pre` UI hook is active — including the step-only case (`workflow.ui_safety_gate` off). (`check.query` = `"ui.plan-gate"`; router normalizes dots→hyphens.)

```bash
GATE=$(gsd_run check ui-plan-gate "${PHASE}" --raw)
```

Read `frontend`, `hasUiSpec`, and `block` from `GATE`.

**Branch 2 — no frontend indicators (`frontend` is `false`):** Skip silently to step 6.

**Branch 3 — UI-SPEC already exists (`hasUiSpec` is `true`):**

```bash
UI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-UI-SPEC.md 2>/dev/null | head -1)
UI_SPEC_PATH="${UI_SPEC_FILE}"
```

Display: `Using UI design contract: ${UI_SPEC_PATH}`. Continue to step 6.

**Branch 4 — `--skip-ui` in `$ARGUMENTS`:** Skip silently to step 6.

**Branches 5 & 6 — frontend detected, UI-SPEC missing, no `--skip-ui`.**

Read the ephemeral auto-chain flag:

```bash
AUTO_CHAIN=$(gsd_run query check auto-mode --pick auto_chain_active 2>/dev/null || echo "false")
```

**Branch 5 — `AUTO_CHAIN` is `true` (pipeline / `--auto`):** Fire each active UI **step** hook — runs independently of whether a gate is active (covers `{ui_phase:true,ui_safety_gate:false}`). For each entry in `activeHooks` (in array order) where `kind == "step"` and `ref.skill` is set:

```
Skill(skill="gsd-${ref.skill}", args="${PHASE} --auto ${GSD_WS}")
```

After all UI step hooks return, re-read:

```bash
UI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-UI-SPEC.md 2>/dev/null | head -1)
UI_SPEC_PATH="${UI_SPEC_FILE}"
```

Continue to step 6.

**Branch 6 — `AUTO_CHAIN` is `false` (manual): generic gate handling.** For each entry in `activeHooks` where `kind == "gate"` and `blocking` is `true`: if `block:true` (from `GATE`), output the block below and **EXIT the plan-phase workflow**. If no active blocking gate (e.g. `workflow.ui_safety_gate` is off), continue to step 6 — no block.

Output this markdown directly (not as a code block):

```
## ⚠ UI-SPEC.md missing for Phase {N}
▶ Recommended next step:
`/gsd:ui-phase {N} ${GSD_WS}` — generate UI design contract before planning
───────────────────────────────────────────────
Also available:
- `/gsd:plan-phase {N} --skip-ui ${GSD_WS}` — plan without UI-SPEC (not recommended for frontend phases)
```

**Exit the plan-phase workflow. Do not continue.**

## 5.65. Codebase Map Freshness Pre-Check (drift plan:pre gate)

If `activeHooks` (from `PLAN_PRE_HOOKS_JSON`, §5.6) has a `kind == "gate"`, `capId == "drift"`,
`check.query == "verify.codebase-drift"` entry (`workflow.plan_drift_precheck` on), run the same check the
execute gate uses; otherwise skip to step 6:

```bash
DRIFT=$(gsd_run verify codebase-drift 2>/dev/null || echo '{"skipped":true}')
```

This gate is **non-blocking** and **never blocks, never spawns** the mapper at plan time. If `skipped` or
`action_required` is false, continue silently to step 6. If `action_required` is true, print `message`
verbatim (it ends with a `/gsd:map-codebase` pointer) and continue — planning proceeds whether or not the
map is refreshed first. (`drift_action: auto-remap` stays at `execute:wave:post`.)

## 6. Check Existing Plans

```bash
ls "${PHASE_DIR}"/*-PLAN.md 2>/dev/null || true
```

**If exists AND `--reviews` flag:** Skip prompt — go straight to replanning (the purpose of `--reviews` is to replan with review feedback).

**If exists AND no `--reviews` flag:** Offer: 1) Add more plans, 2) View existing, 3) Replan from scratch.

## 7. Use Context Paths from INIT

Extract from INIT JSON:

```bash
_gsd_field() { node -e "const o=JSON.parse(process.argv[1]); const v=o[process.argv[2]]; process.stdout.write(v==null?'':String(v))" "$1" "$2"; }
STATE_PATH=$(_gsd_field "$INIT" state_path)
ROADMAP_PATH=$(_gsd_field "$INIT" roadmap_path)
REQUIREMENTS_PATH=$(_gsd_field "$INIT" requirements_path)
RESEARCH_PATH=$(_gsd_field "$INIT" research_path)
VERIFICATION_PATH=$(_gsd_field "$INIT" verification_path)
UAT_PATH=$(_gsd_field "$INIT" uat_path)
CONTEXT_PATH=$(_gsd_field "$INIT" context_path)
REVIEWS_PATH=$(_gsd_field "$INIT" reviews_path)
PATTERNS_PATH=$(_gsd_field "$INIT" patterns_path)

# Detect spike/sketch findings skills (project-local)
SPIKE_FINDINGS_PATH=$(ls ./.claude/skills/spike-findings-*/SKILL.md 2>/dev/null | head -1 || true)
SKETCH_FINDINGS_PATH=$(ls ./.claude/skills/sketch-findings-*/SKILL.md 2>/dev/null | head -1 || true)

# Resolve the phase SPEC (carries the ## Edge Coverage section the planner lifts covered/
# backstop edges from). UNCONDITIONAL — must NOT live in §4.5 Check AI-SPEC, which is skipped
# on non-AI phases; gating it there silently starves the planner of the SPEC (#550 review).
# Glob the plain phase SPEC, excluding the -AI-SPEC.md / -UI-SPEC.md variants.
PHASE_DIR_FOR_SPEC=$(_gsd_field "$INIT" phase_dir)
SPEC_FILE=$(ls "${PHASE_DIR_FOR_SPEC}"/*-SPEC.md 2>/dev/null | grep -Ev -- '-(AI|UI)-SPEC\.md$' | head -1)
SPEC_PATH="${SPEC_FILE}"
# Resolve the phase UI-SPEC separately (the glob above excludes -UI-SPEC.md); it carries the
# ## UI Considerations section the planner lifts by the same rule as ## Edge Coverage (#1867).
UI_SPEC_FILE=$(ls "${PHASE_DIR_FOR_SPEC}"/*-UI-SPEC.md 2>/dev/null | head -1)
UI_SPEC_PATH="${UI_SPEC_FILE}"
```

## 7.5. Verify Nyquist Artifacts

Skip if `nyquist_validation_enabled` is false OR `research_enabled` is false.

Also skip if all of the following are true:
- `research_enabled` is false
- `has_research` is false
- no `--research` flag was provided

In that no-research path, Nyquist artifacts are **not required** for this run.

```bash
VALIDATION_EXISTS=$(ls "${PHASE_DIR}"/*-VALIDATION.md 2>/dev/null | head -1)
```

If missing and Nyquist is still enabled/applicable — ask user:
1. Re-run: `/gsd:plan-phase {PHASE} --research ${GSD_WS}`
2. Disable Nyquist with the exact command:
   `gsd-tools.cjs query config-set workflow.nyquist_validation false`
3. Continue anyway (plans fail Dimension 8)

Proceed to Step 7.8 (or Step 8 if pattern mapper is disabled) only if user selects 2 or 3.

## 7.8. Spawn gsd-pattern-mapper Agent (Optional)

Pattern mapper activation is owned by the `pattern-mapper` capability's `plan:pre` step hook. Read `PLAN_PRE_HOOKS_JSON` and skip if no active step hook has `capId == "pattern-mapper"` and `ref.agent == "gsd-pattern-mapper"`. Also skip if no CONTEXT.md and no RESEARCH.md exist for this phase (nothing to extract file lists from).

**If PATTERNS.md already exists** (`PATTERNS_PATH` is non-empty from step 7): Skip to step 8 (use existing).

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► PATTERN MAPPING PHASE {X}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning pattern mapper... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Use the active `pattern-mapper` hook's `fragment.inline` as the prompt template and substitute the phase fields below before spawning its declared `ref.agent`.

```markdown
{pattern_mapper_hook.fragment.inline}
```

Spawn with:
```
Agent(
  prompt=filled_pattern_mapper_hook_fragment,
  subagent_type=pattern_mapper_hook.ref.agent,
  model="{researcher_model}",
)
```

> **ORCHESTRATOR RULE — ALL RUNTIMES**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

**Handle return:**
- **`## PATTERN MAPPING COMPLETE`:** Update `PATTERNS_PATH` to the created file path, continue to step 8.
- **Any error or empty return:** Log warning, continue to step 8 without patterns (non-blocking).

After pattern mapper completes, update the path variable:
```bash
PATTERNS_PATH="${PHASE_DIR}/${PADDED_PHASE}-PATTERNS.md"
```

## 7.9. Regenerate API-SURFACE.md (intel gate)

> Capability-driven dispatch. Resolves active `plan:pre` step hooks via the capability registry; the intel hook's `when: intel.enabled` condition is evaluated by the registry — no inline config-get needed.

Read the active intel step hook from `PLAN_PRE_HOOKS_JSON` where `kind == "step"` and `capId == "intel"`.

**If no active intel step hook exists:** `API_SURFACE_PATH` stays empty; skip to step 8. The step-8 planner entry for API Surface is omitted when `API_SURFACE_PATH` is empty.

**If an active intel step hook exists:**
```bash
gsd_run intel api-surface
API_SURFACE_PATH="$(dirname "$STATE_PATH")/intel/API-SURFACE.md"
echo "✓ API surface regenerated: ${API_SURFACE_PATH}"  # injected into step 8 as HINT
```

Continue to step 8.

## 7.95. Spec-less Probe Fallback (gate)

When the SPEC did not supply `## Edge Coverage` / `## Prohibitions`, plan-phase runs the probe protocol
and authors the predicates into PLAN.md `must_haves` (ADR-857 Phase 6 — the *else branch* of the
`<downstream_consumer>` lift below). Core workflow-body substrate, not a capability rail (D-03). Runs
after `$SPEC_FILE` (Step 7), before the gsd-planner spawn (Step 8).

**Read and run** the gate + edge probe in `~/.claude/gsd-core/references/specless-probe-fallback.md`
(§0 default-ON toggle + per-section absence via the `spec-section` helper, visibly skipping when
disabled or no requirement IDs; §A deterministic edge probe → `$COVERAGE` when `EDGE_ABSENT`; §B
prohibition recall in the planner). Pass `$COVERAGE` and `$SPECLESS_FALLBACK_DISABLED` into Step 8.

## 8. Spawn gsd-planner Agent

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► PLANNING PHASE {X}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning planner... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Planner prompt:

```markdown
<planning_context>
**Phase:** {phase_number}
**Mode:** {standard | gap_closure | reviews}

<files_to_read>
- {state_path} (Project State)
- {roadmap_path} (Roadmap)
- {requirements_path} (Requirements)
- {context_path} (USER DECISIONS from /gsd:discuss-phase)
- {research_path} (Technical Research)
- {PATTERNS_PATH} (Pattern Map — analog files and code excerpts, if exists)
- {verification_path} (Verification Gaps - if --gaps)
- {uat_path} (UAT Gaps - if --gaps)
- {reviews_path} (Cross-AI Review Feedback - if --reviews; actionable findings must be incorporated or explicitly deferred/rejected in PLAN.md)
- {AI_SPEC_PATH} (AI Design Contract — framework and evaluation strategy, if exists)
- {UI_SPEC_PATH} (UI Design Contract — visual/interaction specs, if exists)
- {SPEC_PATH} (Phase SPEC — carries the ## Edge Coverage section to lift covered/backstop edges from, if exists)
- {SPIKE_FINDINGS_PATH} (Spike Findings — validated patterns, constraints, landmines from experiments, if exists)
- {SKETCH_FINDINGS_PATH} (Sketch Findings — validated design decisions, CSS patterns, visual direction, if exists)
- {API_SURFACE_PATH} (API Surface — HINT ONLY, when intel capability is active; see <intel_surface_hint> below)
${CONTEXT_WINDOW >= 500000 ? `
**Cross-phase context (1M model enrichment):**
- CONTEXT.md files from the 3 most recent completed phases (locked decisions — maintain consistency)
- SUMMARY.md files from the 3 most recent completed phases (what was built — reuse patterns, avoid duplication)
- LEARNINGS.md files from the 3 most recent completed phases (structured decisions, patterns, lessons, surprises — skip silently if a phase has no LEARNINGS.md; prefix each block with \`[from Phase N LEARNINGS]\` for source attribution; if total size exceeds 15% of context budget, drop oldest first)
- CONTEXT.md, SUMMARY.md, and LEARNINGS.md from any phases listed in the current phase's "Depends on:" field in ROADMAP.md (regardless of recency — explicit dependencies always load, deduplicated against the 3 most recent)
- Skip all other prior phases to stay within context budget
` : ''}
</files_to_read>
${API_SURFACE_PATH ? `
<intel_surface_hint>
**API Surface (HINT — may be incomplete):** When \`intel.enabled\` is true, \`${API_SURFACE_PATH}\` lists symbols extracted from the codebase by regex/JS analysis. Prefer symbols listed there when referencing existing code. This surface is regex/JS-derived and MAY BE INCOMPLETE — a symbol's absence means *unknown*, not *nonexistent*. Never treat the surface as exhaustive. If you reference a symbol that is not in the surface and this phase creates it, list it under "Artifacts this phase produces".
</intel_surface_hint>
` : ''}
${AGENT_SKILLS_PLANNER}

<review_incorporation_contract>
**If Mode is reviews:** REVIEWS.md is feedback input, not a hidden execution contract. /gsd:execute-phase primarily consumes PLAN.md plus the normal phase context, so every current actionable review finding must become visible in the relevant PLAN.md before planning can pass.

For each current actionable finding in REVIEWS.md, the planner MUST either:
- incorporate it into a PLAN.md task, `<action>`, `<acceptance_criteria>`, `<verify>`, `must_haves`, threat model, or artifact list; or
- explicitly document a deferral/rejection rationale in the relevant PLAN.md so the executor and reviewer can see the decision.

Historical findings already incorporated, explicitly deferred/rejected in PLAN.md, or marked fully resolved do not require new plan changes.
</review_incorporation_contract>

**Phase requirement IDs (every ID MUST appear in a plan's `requirements` field):** {phase_req_ids}

**Project instructions:** Read ./CLAUDE.md or ./.claude/CLAUDE.md if either exists — follow project-specific guidelines
**Project skills:** Check .claude/skills/ or .agents/skills/ directory (if either exists) — read SKILL.md files, plans should account for project skill rules

{For each active entry in `PLAN_PRE_HOOKS_JSON` where `kind == "contribution"` and `into == "planner"` (in array order): inject the entry's `fragment.inline` verbatim here. This delivers all planner-targeted contributions — including tdd's `<tdd_mode_active>` block (type:tdd heuristics), schema-gate's schema-push detection guidance (if active at plan:pre), and security's threat-model guidance. For the security contribution, also surface the resolved `configValues`: `security_asvs_level` (ASVS enforcement level) and `security_block_on` (severity threshold) so the planner uses the configured values when generating `<threat_model>` blocks. If no active planner contributions exist, omit this block entirely.}

**TRACER_MODE:** ${TRACER_MODE} (false = horizontal layers instead of a leading `type="tracer"` slice; see `planner-mvp-mode.md`.)
**REVERSIBILITY_GATES:** ${REVERSIBILITY_GATES} (false = rate but do not gate; see `planner-reversibility.md`.)
**MVP_MODE:** ${MVP_MODE} (when true, follow vertical-slice rules from `~/.claude/gsd-core/references/planner-mvp-mode.md`; when false, ignore MVP guidance entirely.)
**WALKING_SKELETON:** ${WALKING_SKELETON} (when true, the first deliverable must be a Walking Skeleton — Read the template at `~/.claude/gsd-core/references/skeleton-template.md` and produce SKELETON.md alongside PLAN.md.)
**Granularity:** {granularity}

${MVP_MODE === 'true' ? `
<mvp_mode_active>
**MVP Mode is ENABLED.** Read `~/.claude/gsd-core/references/planner-mvp-mode.md` now and follow its vertical-slice planning rules. Each plan must deliver a complete vertical slice — thin end-to-end functionality rather than horizontal layers.
</mvp_mode_active>
` : ''}

<specless_probe_fallback>
**Spec-less probe fallback** (only when step 7.95 set `EDGE_ABSENT` and/or `PROHIB_ABSENT`). The SPEC
omitted that section — author its predicates into `must_haves` via the `<downstream_consumer>`
else-branch below, per §A/§B/§C of `~/.claude/gsd-core/references/specless-probe-fallback.md`
(descriptor-less prohibitions, never auto-dismiss, no silent drops).

Edge coverage report (`$COVERAGE`, present when `EDGE_ABSENT`):

```json
{COVERAGE}
```
${SPECLESS_FALLBACK_DISABLED ? `
**⚠ ${SPECLESS_FALLBACK_DISABLED}** — record this in the plan (a visible, recorded choice); do not generate probe predicates this run.
` : ''}

</planning_context>

<downstream_consumer>
Output consumed by /gsd:execute-phase. Plans need:
- Frontmatter (wave, depends_on, files_modified, autonomous)
- Tasks in XML format with read_first and acceptance_criteria fields (MANDATORY on every task)
- Verification criteria
- must_haves for goal-backward verification
- If the SPEC has an `## Edge Coverage` section, lift every `covered` edge's acceptance criterion into `must_haves.truths` as a plain string, and every `backstop` edge **as a structured flat-scalar marker** — an object item `{ statement: <the check>, verification: backstop }`, NOT a prose note (the verifier branches deterministically on the `verification: backstop` field; a parenthetical is unparseable — the #1110 fragility). Use a flat scalar `verification:` continuation key, never a nested object (ADR-550 #1278). At verify time a `backstop` truth the verifier cannot confirm with explicit evidence abstains → `human_needed` (reason `insufficient_spec`), never a silent pass (#1154; see `references/honest-verifier.md`). `unresolved` edges are explicit assumptions — surface them in the plan, do not silently drop them. **Otherwise** (`EDGE_ABSENT`): apply the SAME lift to the fallback report `{COVERAGE}` (per §C of `references/specless-probe-fallback.md`); a SPEC-supplied section is never re-run.
- If the SPEC has a `## Prohibitions` section, lift every resolved prohibition into the `must_haves.prohibitions:` sibling block (NOT `truths` — ADR-550 D3) with `statement`+`status`+`verification`, via the single `projectProhibitions` serializer (Hyrum — no second serializer); unresolved -> flagged assumptions, don't drop; never put a must-NOT under `truths`. **Otherwise** (`PROHIB_ABSENT`), author the recalled prohibitions into the SAME block via the SAME `projectProhibitions` contract but **descriptor-less** (no `check_*`) so each disposes flagged-unverified; never auto-dismiss. Section-level precedence + no-silent-drop equality apply (§C).
- If a `-UI-SPEC.md` exists (resolved above as `UI_SPEC_PATH`) with a `## UI Considerations` section, lift it by the **identical rule** as `## Edge Coverage` above — `covered` → `must_haves.truths` string, `backstop` → flat scalar `{ statement, verification: backstop }`, `unresolved` → explicit planner assumption (no new verb — ADR-550 #1278/#1154; #1867). Read it from `UI_SPEC_PATH` (the SPEC glob excludes `-UI-SPEC.md`).
- **"Artifacts this phase produces" section (MANDATORY)** — list every symbol this phase creates: decorators, classes, functions, CLI flags, struct/dataclass fields, new file paths. The plan-review-convergence source-grounding pass reads this section to exclude newly-created symbols from drift verification; omitting it causes new symbols to be flagged for acknowledgement.
</downstream_consumer>

<deep_work_rules>
## Anti-Shallow Execution Rules (MANDATORY)

Every task MUST include these fields — they are NOT optional:

1. **`<read_first>`** — Files the executor MUST read before touching anything. Always include:
   - The file being modified (so executor sees current state, not assumptions)
   - Any "source of truth" file referenced in CONTEXT.md (reference implementations, existing patterns, config files, schemas)
   - Any file whose patterns, signatures, types, or conventions must be replicated or respected

2. **`<acceptance_criteria>`** — Verifiable conditions that prove the task was done correctly. Rules:
   - Every criterion must be checkable as a source assertion, behavior assertion, test command, or CLI output
   - NEVER use subjective language ("looks correct", "properly configured", "consistent with")
   - Include exact strings, patterns, values, command outputs, or observable behavior where that is the right proof
   - Examples:
     - Code: `auth.py contains def verify_token(` / `test_auth.py exits 0`
     - Behavior: `POST /api/auth/login returns 200 + httpOnly JWT cookie for valid credentials`
     - Config: `.env.example contains DATABASE_URL=` / `Dockerfile contains HEALTHCHECK`
     - Docs: `README.md contains '## Installation'` / `API.md lists all endpoints`
     - Infra: `deploy.yml has rollback step` / `docker-compose.yml has healthcheck for db`

3. **`<action>`** — Must include CONCRETE values, not references. Rules:
   - NEVER say "align X with Y", "match X to Y", "update to be consistent" without specifying the exact target state
   - Include concrete identifiers and reference values: config keys, function signatures, SQL table names, class names, import paths, env vars, endpoint paths, etc.
   - If CONTEXT.md has a comparison table or expected values, copy only the target identifiers/values needed to remove ambiguity
   - Do not include full file contents, fenced code blocks, or complete implementations in `<action>`
   - The executor should understand the intended target state from `<action>` and use `<read_first>` files for current implementation details, patterns, and source-of-truth context

**Why this matters:** Executor agents work from the plan text. Vague instructions like "update the config to match production" produce shallow one-line changes. Concrete instructions like "add DATABASE_URL, set POOL_SIZE=20, add REDIS_URL, and read config/runtime.ts before editing" produce complete work without turning the planner into the executor.
</deep_work_rules>

<quality_gate>
- [ ] PLAN.md files created in phase directory
- [ ] Each plan has valid frontmatter
- [ ] Tasks are specific and actionable
- [ ] Every task has `<read_first>` with at least the file being modified
- [ ] Every task has `<acceptance_criteria>` with behavior, test-command, CLI, or source assertions
- [ ] Every `<action>` contains concrete identifiers without fenced code blocks or full implementations
- [ ] Dependencies correctly identified
- [ ] Waves assigned for parallel execution
- [ ] must_haves derived from phase goal
- [ ] Every PLAN.md includes an "Artifacts this phase produces" section listing symbols created by this phase (decorators, classes, functions, CLI flags, struct/dataclass fields, new file paths)
- [ ] Every SPEC ## Edge Coverage covered/backstop edge is represented in a plan's must_haves (no silent drops)
- [ ] Every UI-SPEC ## UI Considerations covered/backstop consideration is represented in a plan's must_haves (no silent drops)
- [ ] Every SPEC ## Prohibitions resolved item is represented in a plan's must_haves.prohibitions (no silent drops)
</quality_gate>
```

**If `CHUNKED_MODE` is `false` (default):** Spawn the planner as a single long-lived Agent:

```text
Agent(
  prompt=filled_prompt,
  subagent_type="gsd-planner",
  model="{planner_model}",
  description="Plan Phase {phase}"
)
```

> **ORCHESTRATOR RULE — ALL RUNTIMES**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

**If `CHUNKED_MODE` is `true`:** Skip the Agent() call above — proceed to step 8.5 instead.

## 8.5. Chunked Planning Mode

**Skip if `CHUNKED_MODE` is `false`.**

Chunked mode splits the single long-lived planner Agent run into a short outline Agent run followed by
N short per-plan Agent runs. Each run is bounded to ~3–5 min; each plan is committed individually
for crash resilience. If any run hangs and the terminal is force-killed, rerunning
`/gsd:plan-phase {N} --chunked` resumes from the last successfully committed plan.

**Intended for new or in-progress chunked runs.** To recover plans already written by a prior
*non-chunked* run, use step 6's "Add more plans" or proceed directly to `/gsd:execute-phase`
— don't start a fresh chunked run over existing non-chunked plans.

### 8.5.1 Outline Phase (outline-only mode, ~2 min)

**Resume detection:** If `${PHASE_DIR}/${PADDED_PHASE}-PLAN-OUTLINE.md` already exists **and
is valid** (contains the `## OUTLINE COMPLETE` marker), skip this sub-step — the outline
already exists from a previous run. Proceed directly to 8.5.2.

```bash
OUTLINE_FILE="${PHASE_DIR}/${PADDED_PHASE}-PLAN-OUTLINE.md"
if [[ -f "$OUTLINE_FILE" ]] && grep -q "^## OUTLINE COMPLETE" "$OUTLINE_FILE"; then
  # reuse existing outline — skip to 8.5.2
fi
```

Display:
```text
◆ Chunked mode: spawning outline planner... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Spawn the planner in **outline-only** mode — it must write only the outline manifest, not any
PLAN.md files:

```javascript
Agent(
  prompt="{same planning_context as step 8, plus:}

  **Chunked mode: outline-only.**
  Do NOT write any PLAN.md files in this Task.
  Write only: {PHASE_DIR}/{PADDED_PHASE}-PLAN-OUTLINE.md

  The outline must be a markdown table with columns:
  Plan ID | Objective | Wave | Depends On | Requirements

  Return: ## OUTLINE COMPLETE with plan count.",
  subagent_type="gsd-planner",
  model="{planner_model}",
  description="Outline Phase {phase} (chunked)"
)
```

> **ORCHESTRATOR RULE — ALL RUNTIMES**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

Handle return:
- **`## OUTLINE COMPLETE`:** Read `PLAN-OUTLINE.md`, extract plan list. Continue to 8.5.2.
- **Any other return or empty:** Display error. Offer: 1) Retry outline, 2) Stop.

### 8.5.2 Per-Plan Tasks (single-plan mode, ~3-5 min each)

For each plan entry extracted from `PLAN-OUTLINE.md`:

1. **Resume check:** If `${PHASE_DIR}/{plan_id}-PLAN.md` already exists on disk **and has
   valid YAML frontmatter** (opening `---` delimiter present), skip this plan (do not
   overwrite completed work — resume safety).

   ```bash
   PLAN_FILE="${PHASE_DIR}/${plan_id}-PLAN.md"
   if [[ -f "$PLAN_FILE" ]] && head -1 "$PLAN_FILE" | grep -q '^---'; then
     continue  # plan already written, skip
   fi
   ```

2. Display:
   ```text
   ◆ Chunked mode: planning {plan_id} ({k}/{N})... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
   ```

3. Spawn the planner in **single-plan** mode — it must write exactly one PLAN.md file:
   ```javascript
   Agent(
     prompt="{same planning_context as step 8, plus:}

     **Chunked mode: single-plan.**
     Write exactly ONE plan file: {PHASE_DIR}/{plan_id}-PLAN.md
     Plan to write: {plan_id} — {objective}
     Wave: {wave} | Depends on: {depends_on}
     Phase requirement IDs to cover in this plan: {plan_requirements}

     Return: ## PLAN COMPLETE with the plan ID.",
     subagent_type="gsd-planner",
     model="{planner_model}",
     description="Plan {plan_id} (chunked {k}/{N})"
   )
   ```

   > **ORCHESTRATOR RULE — ALL RUNTIMES**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

4. **Verify disk:** Check `${PHASE_DIR}/{plan_id}-PLAN.md` exists. If missing: offer 1) Retry, 2) Stop.

5. **Commit per-plan:**
   ```bash
   gsd_run query commit "docs(${PADDED_PHASE}): plan ${plan_id} (chunked)" --files "${PHASE_DIR}/${plan_id}-PLAN.md"
   ```

After all N plans are written and committed, treat this as `## PLANNING COMPLETE` and continue
to step 9.

## 9. Handle Planner Return

- **`## PLANNING COMPLETE`:** Display plan count. If `--skip-verify` or `plan_checker_enabled` is false (from init): skip to step 13. Otherwise: step 10.
- **`## PHASE SPLIT RECOMMENDED`:** The planner determined the phase exceeds the context budget for full-fidelity implementation of all source items. Handle in step 9b.
- **`## ⚠ Source Audit: Unplanned Items Found`:** The planner's multi-source coverage audit found items from REQUIREMENTS.md, RESEARCH.md, ROADMAP goal, or CONTEXT.md decisions that are not covered by any plan. Handle in step 9c.
- **`## CHECKPOINT REACHED`:** Present to user, get response, spawn continuation (step 12)
- **`## PLANNING INCONCLUSIVE`:** Show attempts, offer: Add context / Retry / Manual
- **Empty / truncated / no recognized marker:** → Filesystem fallback (step 9a).

## 9a. Filesystem Fallback (Planner)

**Triggered when:** Agent() returns but the return contains no recognized marker (`## PLANNING COMPLETE`, `## PHASE SPLIT RECOMMENDED`, `## ⚠ Source Audit`, `## CHECKPOINT REACHED`, `## PLANNING INCONCLUSIVE`).

```bash
DISK_PLANS=$(ls "${PHASE_DIR}"/*-PLAN.md 2>/dev/null | wc -l | tr -d ' ')
```

**If `DISK_PLANS` > 0:** The planner wrote plans to disk but the Agent() return was empty or
truncated (the Windows stdio hang pattern — the subagent finished but the return never
arrived). Display:

```text
◆ Planner wrote {DISK_PLANS} plan(s) to disk but did not emit a PLANNING COMPLETE marker.
  This is a known Windows stdio hang pattern — work is likely recoverable.

  Plans found on disk:
  {ls output of *-PLAN.md}
```

Offer 3 options:
1. **Accept plans** — treat as `## PLANNING COMPLETE` and continue through step 9 `## PLANNING COMPLETE` handling (so `--skip-verify` / `plan_checker_enabled=false` are honored — may skip to step 13 rather than step 10)
2. **Retry planner** — re-spawn the planner with the same prompt (return to step 8)
3. **Stop** — exit; user can re-run `/gsd:plan-phase {N}` to resume

**If `DISK_PLANS` is 0 and no marker:** The planner produced no output. Treat as
`## PLANNING INCONCLUSIVE` and handle accordingly.

## 9b. Handle Phase Split Recommendation

When the planner returns `## PHASE SPLIT RECOMMENDED`, it means the phase's source items exceed the context budget for full-fidelity implementation. The planner proposes groupings.

**Extract from planner return:**
- Proposed sub-phases (e.g., "17a: processing core (D-01 to D-19)", "17b: billing + config UX (D-20 to D-27)")
- Which source items (REQ-IDs, D-XX decisions, RESEARCH items) go in each sub-phase
- Why the split is necessary (context cost estimate, file count)

**Present to user:**
```
## Phase {X} exceeds context budget for full-fidelity implementation

The planner found {N} source items that exceed the context budget when
planned at full fidelity. Instead of reducing scope, we recommend splitting:

**Option 1: Split into sub-phases**
- Phase {X}a: {name} — {items} ({N} source items, ~{P}% context)
- Phase {X}b: {name} — {items} ({M} source items, ~{Q}% context)

**Option 2: Proceed anyway** (planner will attempt all, quality may degrade past 50% context)

**Option 3: Prioritize** — you choose which items to implement now,
rest become a follow-up phase
```

Use AskUserQuestion with these 3 options.

**If "Split":** Use `/gsd:phase --insert` to create the sub-phases, then replan each.
**If "Proceed":** Return to planner with instruction to attempt all items at full fidelity, accepting more plans/tasks.
**If "Prioritize":** Use AskUserQuestion (multiSelect) to let user pick which items are "now" vs "later". Create CONTEXT.md for each sub-phase with the selected items.

## 9c. Handle Source Audit Gaps

When the planner returns `## ⚠ Source Audit: Unplanned Items Found`, it means items from REQUIREMENTS.md, RESEARCH.md, ROADMAP goal, or CONTEXT.md decisions have no corresponding plan.

**Extract from planner return:**
- Each unplanned item with its source artifact and section
- The planner's suggested options (A: add plan, B: split phase, C: defer with confirmation)

**Present each gap to user.** For each unplanned item:

```
## ⚠ Unplanned: {item description}

Source: {RESEARCH.md / REQUIREMENTS.md / ROADMAP goal / CONTEXT.md}
Details: {why the planner flagged this}

Options:
1. Add a plan to cover this item (recommended)
2. Split phase — move to a sub-phase with related items
3. Defer — add to backlog (developer confirms this is intentional)
```

Use AskUserQuestion for each gap (or batch if multiple gaps).

**If "Add plan":** Return to planner (step 8) with instruction to add plans covering the missing items, preserving existing plans.
**If "Split":** Use `/gsd:phase --insert` for overflow items, then replan.
**If "Defer":** Record in CONTEXT.md `## Deferred Ideas` with developer's confirmation. Proceed to step 10.

## 10. Spawn gsd-plan-checker Agent

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► VERIFYING PLANS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning plan checker... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Checker prompt:

```markdown
<verification_context>
**Phase:** {phase_number}
**Phase Goal:** {goal from ROADMAP}
**Mode:** {standard | gap_closure | reviews}

<files_to_read>
- {PHASE_DIR}/*-PLAN.md (Plans to verify)
- {roadmap_path} (Roadmap)
- {requirements_path} (Requirements)
- {context_path} (USER DECISIONS from /gsd:discuss-phase)
- {research_path} (Technical Research — includes Validation Architecture)
- {reviews_path} (Cross-AI Review Feedback - if --reviews; verify actionable findings are represented in PLAN.md)
</files_to_read>

${AGENT_SKILLS_CHECKER}

<review_incorporation_verification>
**If Mode is reviews:** Read REVIEWS.md and verify each current actionable review finding is visible in executable PLAN.md content or explicitly deferred/rejected in the relevant PLAN.md. A finding remains actionable if it requires a concrete plan task, `<action>`, `<acceptance_criteria>`, `<verify>`, `must_haves`, threat-model item, stale-path correction, or execution contract change before /gsd:execute-phase runs.

If an actionable finding remains only in REVIEWS.md and would be invisible to /gsd:execute-phase, return `## ISSUES FOUND`. Use WARNING by default; use BLOCKER when the missing incorporation can prevent the phase goal, create unsafe execution, or invalidate verification.
</review_incorporation_verification>

**Phase requirement IDs (MUST ALL be covered):** {phase_req_ids}

**Project instructions:** Read ./CLAUDE.md or ./.claude/CLAUDE.md if either exists — verify plans honor project guidelines
**Project skills:** Check .claude/skills/ or .agents/skills/ directory (if either exists) — verify plans account for project skill rules
</verification_context>

<expected_output>
- ## VERIFICATION PASSED — all checks pass
- ## ISSUES FOUND — structured issue list
</expected_output>
```

```
Agent(
  prompt=checker_prompt,
  subagent_type="gsd-plan-checker",
  model="{checker_model}",
  description="Verify Phase {phase} plans"
)
```

> **ORCHESTRATOR RULE — ALL RUNTIMES**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

## 11. Handle Checker Return

- **`## VERIFICATION PASSED`:** Display confirmation, proceed to step 13.
- **`## ISSUES FOUND`:** Display issues, check iteration count, proceed to step 12.
- **Empty / truncated / no recognized marker:** → Filesystem fallback (step 11a).

**Thinking partner for architectural tradeoffs (conditional):**
If `features.thinking_partner` is enabled, scan the checker's issues for architectural tradeoff keywords
("architecture", "approach", "strategy", "pattern", "vs", "alternative"). If found:

```
The plan-checker flagged an architectural decision point:
{issue description}

Brief analysis:
- Option A: {approach_from_plan} — {pros/cons}
- Option B: {alternative_approach} — {pros/cons}
- Recommendation: {choice} aligned with {phase_goal}

Apply this to the revision? [Yes] / [No, I'll decide]
```

If yes: include the recommendation in the revision prompt. If no: proceed to revision loop as normal.
If thinking_partner disabled: skip this block entirely.

## 11a. Filesystem Fallback (Checker)

**Triggered when:** Checker Agent() returns but the return contains neither `## VERIFICATION PASSED` nor `## ISSUES FOUND`.

```bash
DISK_PLANS=$(ls "${PHASE_DIR}"/*-PLAN.md 2>/dev/null | wc -l | tr -d ' ')
```

**If `DISK_PLANS` > 0:** Plans exist on disk; the checker return was empty or truncated (the
Windows stdio hang pattern — the subagent finished but the return never arrived). Display:

```text
◆ Checker return was empty or truncated. {DISK_PLANS} plan(s) exist on disk.
  This is a known Windows stdio hang pattern — checker may have completed without returning.
```

Offer 3 options:
1. **Accept verification** — treat as `## VERIFICATION PASSED` and continue to step 13
2. **Retry checker** — re-spawn the checker with the same prompt (return to step 10)
3. **Stop** — exit; user can re-run `/gsd:plan-phase {N}` to resume

**If `DISK_PLANS` is 0:** No plans on disk — something is seriously wrong. Display error and stop.

## 12. Revision Loop (Max 3 Iterations)

Track `iteration_count` (starts at 1 after initial plan + check).
Track `prev_issue_count` (initialized to `Infinity` before the loop begins).
Track `stall_reentry_count` (starts at 0; incremented each time "Adjust approach" re-enters step 8).

**If iteration_count < 3:**

Parse issue count from checker return: count BLOCKER + WARNING entries in the YAML issues block (structured output from gsd-plan-checker). If the checker's return contains no YAML issues block (i.e., the plan was approved with no issues), treat `issue_count` as 0 and skip the stall check — the plan passed. Proceed to step 13.

Display: `Revision iteration {N}/3 -- {blocker_count} blockers, {warning_count} warnings`

**Stall detection:** If `issue_count >= prev_issue_count`:
  Display: `Revision loop stalled — issue count not decreasing ({issue_count} issues remain after {N} iterations)`

  **If `stall_reentry_count < 2`:**
    Ask user:
      Question: "Issues remain after {N} revision attempts with no progress. Proceed with current output?"
      Options: "Proceed anyway" | "Adjust approach"
    If "Proceed anyway": accept current plans and continue to step 13.
    If "Adjust approach": increment `stall_reentry_count`, open freeform discussion, then re-enter step 8 (full replanning). Note: re-entry resets `iteration_count` and `prev_issue_count` but `stall_reentry_count` persists across re-entries and is capped at 2.

  **If `stall_reentry_count >= 2`:**
    Display: `Stall persists after 2 re-planning attempts. The following issues could not be resolved automatically:`
    List the remaining issues from the checker.
    Suggest: "Consider resolving these issues manually or running `/gsd:debug` to investigate root causes."
    Options: "Proceed anyway" | "Abandon"
    If "Proceed anyway": accept current plans and continue to step 13.
    If "Abandon": stop workflow.

Set `prev_issue_count = issue_count`.

Revision prompt:

```markdown
<revision_context>
**Phase:** {phase_number}
**Mode:** revision

<files_to_read>
- {PHASE_DIR}/*-PLAN.md (Existing plans)
- {context_path} (USER DECISIONS from /gsd:discuss-phase)
</files_to_read>

${AGENT_SKILLS_PLANNER}

**Checker issues:** {structured_issues_from_checker}
</revision_context>

<instructions>
Make targeted updates to address checker issues.
Do NOT replan from scratch unless issues are fundamental.
Return what changed.
</instructions>
```

```
Agent(
  prompt=revision_prompt,
  subagent_type="gsd-planner",
  model="{planner_model}",
  description="Revise Phase {phase} plans"
)
```

> **ORCHESTRATOR RULE — ALL RUNTIMES**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

After planner returns -> spawn checker again (step 10), increment iteration_count.

**If iteration_count >= 3:**

Display: `Max iterations reached. {N} issues remain:` + issue list

Offer: 1) Force proceed, 2) Provide guidance and retry, 3) Abandon

## 12.5. Plan Bounce (Optional External Refinement)

**Skip if:** `--skip-bounce` flag, `--gaps` flag, or bounce is not activated.

**Activation:** Bounce runs when `--bounce` flag is present OR `workflow.plan_bounce` config is `true`. The `--skip-bounce` flag always wins (disables bounce even if config enables it). The `--gaps` flag also disables bounce (gap-closure mode should not modify plans externally).

**Prerequisites:** `workflow.plan_bounce_script` must be set to a valid script path. If bounce is activated but no script is configured, display warning and skip:
```
⚠ Plan bounce activated but no script configured.
Set workflow.plan_bounce_script to the path of your refinement script.
Skipping bounce step.
```

**Read pass count:**
```bash
BOUNCE_PASSES=$(gsd_run query config-get workflow.plan_bounce_passes 2>/dev/null || echo "2")
BOUNCE_SCRIPT=$(gsd_run query config-get workflow.plan_bounce_script 2>/dev/null | jq -r '.' 2>/dev/null || true)
```

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► BOUNCING PLANS (External Refinement)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Script: ${BOUNCE_SCRIPT}
Max passes: ${BOUNCE_PASSES}
```

**For each PLAN.md file in the phase directory:**

1. **Backup:** Copy `*-PLAN.md` to `*-PLAN.pre-bounce.md`
```bash
cp "${PLAN_FILE}" "${PLAN_FILE%.md}.pre-bounce.md"
```

2. **Invoke bounce script:**
```bash
"${BOUNCE_SCRIPT}" "${PLAN_FILE}" "${BOUNCE_PASSES}"
```

3. **Validate bounced plan — YAML frontmatter integrity:**
After the script returns, check that the bounced file still has valid YAML frontmatter (opening and closing `---` delimiters with parseable content between them). If the bounced plan breaks YAML frontmatter validation, restore the original from the pre-bounce.md backup and continue to the next plan:
```
⚠ Bounced plan ${PLAN_FILE} has broken YAML frontmatter — restoring original from pre-bounce backup.
```

4. **Handle script failure:** If the bounce script exits non-zero, restore the original plan from the pre-bounce.md backup and continue to the next plan:
```
⚠ Bounce script failed for ${PLAN_FILE} (exit code ${EXIT_CODE}) — restoring original from pre-bounce backup.
```

**After all plans are bounced:**

5. **Re-run plan checker on bounced plans:** Spawn gsd-plan-checker (same as step 10) on all modified plans. If a bounced plan fails the checker, restore original from its pre-bounce.md backup:
```
⚠ Bounced plan ${PLAN_FILE} failed checker validation — restoring original from pre-bounce backup.
```

6. **Commit surviving bounced plans:** If at least one plan survived both the frontmatter validation and the checker re-run, commit the changes:
```bash
gsd_run query commit "refactor(${padded_phase}): bounce plans through external refinement" --files "${PHASE_DIR}/*-PLAN.md"
```

Display summary:
```
Plan bounce complete: {survived}/{total} plans refined
```

**Clean up:** Remove all `*-PLAN.pre-bounce.md` backup files after the bounce step completes (whether plans survived or were restored).

## 13. Requirements Coverage Gate

After plans pass the checker (or checker is skipped), verify that all phase requirements are covered by at least one plan.

**Skip if:** `phase_req_ids` is null or TBD (no requirements mapped to this phase).

**Step 1: Extract requirement IDs claimed by plans**
```bash
# Collect all requirement IDs from plan frontmatter
PLAN_REQS=$(grep -h "requirements_addressed\|requirements:" ${PHASE_DIR}/*-PLAN.md 2>/dev/null | tr -d '[]' | tr ',' '\n' | sed 's/^[[:space:]]*//' | sort -u)
```

**Step 2: Compare against phase requirements from ROADMAP**

For each REQ-ID in `phase_req_ids`:
- If REQ-ID appears in `PLAN_REQS` → covered ✓
- If REQ-ID does NOT appear in any plan → uncovered ✗

**Step 3: Check CONTEXT.md features against plan objectives**

Read CONTEXT.md `<decisions>` section. Extract feature/capability names. Check each against plan `<objective>` blocks. Features not mentioned in any plan objective → potentially dropped.

**Step 4: Report**

If all requirements covered and no dropped features:
```
✓ Requirements coverage: {N}/{N} REQ-IDs covered by plans
```
→ Proceed to step 14.

If gaps found:
```
## ⚠ Requirements Coverage Gap

{M} of {N} phase requirements are not assigned to any plan:

| REQ-ID | Description | Plans |
|--------|-------------|-------|
| {id} | {from REQUIREMENTS.md} | None |

{K} CONTEXT.md features not found in plan objectives:
- {feature_name} — described in CONTEXT.md but no plan covers it

Options:
1. Re-plan to include missing requirements (recommended)
2. Move uncovered requirements to next phase
3. Proceed anyway — accept coverage gaps
```

If `TEXT_MODE` is true, present as a plain-text numbered list (options already shown in the block above). Otherwise use AskUserQuestion to present the options.

## 13a. Decision Coverage Gate

After the requirements coverage gate passes, verify that every trackable
decision captured by discuss-phase in CONTEXT.md `<decisions>` is referenced
by at least one plan. This is the **translation gate** from issue #2492 —
its job is to refuse to mark a phase planned when a discuss-phase decision
silently dropped on the way into the plans.

**Skip if** `workflow.context_coverage_gate` is explicitly set to `false`
(absent key = enabled). Also skip if no CONTEXT.md exists for this phase
(nothing to translate) or if its `<decisions>` block is empty.

```bash
GATE_CFG=$(gsd_run query config-get workflow.context_coverage_gate 2>/dev/null || echo "true")
if [ "$GATE_CFG" != "false" ]; then
  GATE_RESULT=$(gsd_run query check.decision-coverage-plan "${PHASE_DIR}" "${CONTEXT_PATH}")
  # BLOCKING: refuse to mark phase planned when a trackable decision is uncovered.
  # `passed: true` covers both real-pass and skipped cases (gate disabled / no CONTEXT.md /
  # no trackable decisions). Verify-phase counterpart deliberately omits this exit-1 — that
  # gate is non-blocking by design (review finding F15).
  echo "$GATE_RESULT" | jq -e '(.passed // .data.passed) == true' >/dev/null || {
    echo "$GATE_RESULT" | jq -r '(.message // .data.message // "Decision coverage gate failed.")'
    exit 1
  }
fi
```

The handler returns JSON:
```json
{
  "passed": true,
  "skipped": false,
  "total":  2,
  "covered": 2,
  "uncovered": [ { "id": "D-01", "text": "...", "category": "..." } ],
  "message": "..."
}
```

**If `passed` is true (or `skipped` is true):** Display
`✓ Decision coverage: {M}/{N} CONTEXT.md decisions covered by plans` (or
`(skipped — gate disabled)` / `(skipped — no decisions)`) and proceed to
step 13b.

**If `passed` is false:** Display the handler's `message` block. It already
names each uncovered decision (`D-NN | category | text`) and tells the user
what to do — cite the id in a relevant plan's `must_haves` / `truths`, or
move the decision under `### Claude's Discretion` / tag it `[informational]`
if it should not be tracked. Then offer:

```text
Options:
1. Re-plan to cover missing decisions (recommended)
2. Edit CONTEXT.md to mark dropped decisions as [informational] / Discretion
3. Proceed anyway — accept the coverage gap
```

If `TEXT_MODE` is true, present as a plain-text numbered list. Otherwise use
AskUserQuestion. Selecting "Proceed anyway" continues to step 13b but
records the override in STATE.md so verify-phase can re-surface it.

**Why this gate blocks:** failing here is cheap. The plans are the contract
between discuss-phase and execute-phase; if a decision isn't visible in any
plan, no executor will implement it. Catching that now beats discovering it
after thousands of dollars of execution.

## 13b. Record Planning Completion in STATE.md

After plans pass all gates, record that planning is complete so STATE.md reflects the new phase status:

```bash
gsd_run query state.planned-phase --phase "${PHASE_NUMBER}" --name "${PHASE_NAME}" --plans "${PLAN_COUNT}"
```

This updates STATUS to "Ready to execute", sets the correct plan count, and timestamps Last Activity.

## 13c. Annotate ROADMAP with Wave Dependencies and Cross-cutting Constraints

After plans are finalized, annotate the ROADMAP.md plan list for this phase with:
- **Wave dependency notes** — a bold header before each wave group ("Wave 2 *(blocked on Wave 1 completion)*")
- **Cross-cutting constraints** — a "Cross-cutting constraints:" subsection listing `must_haves.truths` entries that appear in 2 or more plans

This step is derived entirely from existing PLAN frontmatter — no extra LLM pass is required.

```bash
gsd_run query roadmap.annotate-dependencies "${PHASE_NUMBER}"
```

This operation is idempotent: if wave headers or cross-cutting constraints already exist in the ROADMAP phase section, the command returns without modifying the file. Skip this step if `plan_count` is 0.

## 13d. Commit Plans if commit_docs is true

If `commit_docs` is true (from the init JSON parsed in step 1), commit the generated plan artifacts (including any ROADMAP.md annotations from step 13c):

```bash
gsd_run query commit "docs(${PADDED_PHASE}): create phase plan" --files "${PHASE_DIR}"/*-PLAN.md .planning/STATE.md .planning/ROADMAP.md
```

This commits all PLAN.md files for the phase plus the updated STATE.md and ROADMAP.md to version-control the planning artifacts. Skip this step if `commit_docs` is false.

## 13e. Post-Planning Gap Analysis (plan:post capability gate dispatch)

Proactive, non-blocking coverage report gated on `workflow.post_planning_gaps`
(default `true`). Dispatched via the `plan:post` capability gate owned by the
`gap-analysis` capability (ADR-857 §53). Reads REQUIREMENTS.md and CONTEXT.md
`<decisions>` and cross-references each REQ-ID / D-ID against `${PHASE_DIR}/*-PLAN.md`.

```bash
PLAN_POST_HOOKS_JSON=$(gsd_run loop render-hooks plan:post --raw)
PHASE_REQ_IDS=$(gsd_run query init.plan-phase "$PHASE" --pick phase_req_ids 2>/dev/null || echo TBD)
```

Read the `activeHooks` array from `PLAN_POST_HOOKS_JSON` in-context. If the
`gap-analysis` gate hook is absent (capability inactive), skip this step.

**For each active entry where `kind == "gate"`** (process in array order). **Dispatch by check shape** (the registry validates exactly one of `query`/`predicate`/`agentVerdict`):

```bash
# named-query gate:
GATE_RESULT=$(gsd_run check ${hook.check.query} "${PHASE_DIR}" "${PHASE_REQ_IDS}" --raw)
CHECK_EXIT=$?
```
OR, for a generic `predicate` gate (ADR-2008 / #2008), inline the predicate as compact JSON (note the `--phase-dir`/`--phase-req-ids` flags feed `${PHASE_DIR}`/`${PHASE_REQ_IDS}` interpolation):
```bash
GATE_RESULT=$(gsd_run check predicate --predicate '<hook.check.predicate as JSON>' --phase-dir "${PHASE_DIR}" --phase-req-ids "${PHASE_REQ_IDS}" --raw)
CHECK_EXIT=$?
```
(Read the hook's `check` object in-context to pick the branch; a gate with neither is a malformed registry entry — skip with a warning.)

**Step 1 — did the CHECK COMMAND itself succeed?**
If the check command failed (non-zero `CHECK_EXIT`, empty output, or unparseable JSON):
- `onError == "halt"` → halt and surface command error.
- `onError == "skip"` → log a warning and continue to the next hook.

**Step 2 — read `GATE_RESULT.block` (boolean).** Only reached when command succeeded.

- If `hook.blocking == true` and `GATE_RESULT.block == true`: halt. (gap-analysis is always `blocking: false` so this branch is informational only.)
- If `hook.blocking == false` (advisory): if `GATE_RESULT.block == true` or non-empty `table`/`summary`, output the gap table and continue. Advisory gates never block phase completion.
- If `hook.blocking == true` and `GATE_RESULT.block == false`: continue silently.

## 14. Present Final Status

Route to `<offer_next>` OR `auto_advance` depending on flags/config.

## 15. Auto-Advance Check

Check for auto-advance trigger using values already loaded in step 1:

1. Parse `--auto` and `--chain` flags from $ARGUMENTS
2. Use `auto_chain_active` and `auto_advance` from the INIT JSON parsed in step 1 — **do not issue additional `config-get` calls for these values** (they are already present in the init output). Issuing redundant `config-get` calls for values already in INIT can cause infinite read loops on some runtimes.
3. **Sync chain flag with intent** — if user invoked manually (no `--auto` and no `--chain`), clear the ephemeral chain flag from any previous interrupted `--auto` chain. This does NOT touch `workflow.auto_advance` (the user's persistent settings preference):
   ```bash
   if [[ ! "$ARGUMENTS" =~ --auto ]] && [[ ! "$ARGUMENTS" =~ --chain ]]; then
     gsd_run query config-set workflow._auto_chain_active false || true
   fi
   ```

Set local variables from INIT (parsed once in step 1):
- `AUTO_CHAIN` = `auto_chain_active` from INIT JSON (boolean, default false)
- `AUTO_CFG` = `auto_advance` from INIT JSON (boolean, default false)

**If `--auto` or `--chain` flag present AND `AUTO_CHAIN` is not true:** Persist chain flag to config (handles direct invocation without prior discuss-phase):
```bash
if ([[ "$ARGUMENTS" =~ --auto ]] || [[ "$ARGUMENTS" =~ --chain ]]) && [[ "$AUTO_CHAIN" != "true" ]]; then
  gsd_run query config-set workflow._auto_chain_active true
fi
```

**If `--auto` or `--chain` flag present OR `AUTO_CHAIN` is true OR `AUTO_CFG` is true:**

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► AUTO-ADVANCING TO EXECUTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Plans ready. Launching execute-phase...
```

Launch execute-phase using the Skill tool to avoid nested Task sessions (which cause runtime freezes due to deep agent nesting):
```
Skill(skill="gsd-execute-phase", args="${PHASE} --auto --no-transition ${GSD_WS}")
```

The `--no-transition` flag tells execute-phase to return status after verification instead of chaining further. This keeps the auto-advance chain flat — each phase runs at the same nesting level rather than spawning deeper Task agents.

**Handle execute-phase return:**
- **PHASE COMPLETE** → Display final summary:
  ```
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GSD ► PHASE ${PHASE} COMPLETE ✓
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Auto-advance pipeline finished.

  Next: /gsd:discuss-phase ${NEXT_PHASE} --auto ${GSD_WS}
  ```
- **GAPS FOUND / VERIFICATION FAILED** → Display result, stop chain:
  ```
  Auto-advance stopped: Execution needs review.

  Review the output above and continue manually:
  /gsd:execute-phase ${PHASE} ${GSD_WS}
  ```

**If neither `--auto` nor config enabled:**
Route to `<offer_next>` (existing behavior).

</process>

<offer_next>
Output this markdown directly (not as a code block):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► PHASE {X} PLANNED ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Phase {X}: {Name}** — {N} plan(s) in {M} wave(s)

| Wave | Plans | What it builds |
|------|-------|----------------|
| 1    | 01, 02 | [objectives] |
| 2    | 03     | [objective]  |

Research: {Completed | Used existing | Skipped}
Verification: {Passed | Passed with override | Skipped}

───────────────────────────────────────────────────────────────

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Execute Phase {X}** — run all {N} plans

/clear then:

/gsd:execute-phase {X} ${GSD_WS}

───────────────────────────────────────────────────────────────

**Also available:**
- cat .planning/phases/{phase-dir}/*-PLAN.md — review plans
- /gsd:plan-phase {X} --research — re-research first
- /gsd:review --phase {X} --all — peer review plans with external AIs
- /gsd:plan-phase {X} --reviews — replan incorporating review feedback

───────────────────────────────────────────────────────────────
</offer_next>

<windows_troubleshooting>
Read `gsd-core/workflows/plan-phase/steps/windows-troubleshooting.md` if plan-phase freezes on Windows during agent spawning (stdio deadlocks with MCP servers, anthropics/claude-code#28126) — it covers force-kill, orphaned-node cleanup, stale task-dir cleanup, reducing the MCP server count, and the `--skip-research` fallback.
</windows_troubleshooting>

<success_criteria>
- [ ] .planning/ directory validated
- [ ] Phase validated against roadmap
- [ ] Phase directory created if needed
- [ ] CONTEXT.md loaded early (step 4) and passed to ALL agents
- [ ] Research completed (unless --skip-research or --gaps or exists)
- [ ] gsd-phase-researcher spawned with CONTEXT.md
- [ ] Existing plans checked
- [ ] gsd-planner spawned with CONTEXT.md + RESEARCH.md
- [ ] Plans created (PLANNING COMPLETE or CHECKPOINT handled)
- [ ] gsd-plan-checker spawned with CONTEXT.md
- [ ] Verification passed OR user override OR max iterations with user decision
- [ ] User sees status between agent spawns
- [ ] User knows next steps
</success_criteria>

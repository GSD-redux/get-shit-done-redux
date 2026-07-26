<purpose>
Create structured `.planning/HANDOFF.json` and `.continue-here.md` handoff files to preserve complete work state across sessions. The JSON provides machine-readable state for `/gsd:resume-work`; the markdown provides human-readable context.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="detect">
## Context Detection

Determine what kind of work is being paused and set the handoff destination accordingly:

```bash
# Check for active phase
phase=$(( ls -lt .planning/phases/*/PLAN.md 2>/dev/null || true ) | head -1 | grep -oP 'phases/\K[^/]+' || true)

# Check for active spike
spike=$(( ls -lt .planning/spikes/*/SPIKE.md .planning/spikes/*/DESIGN.md .planning/spikes/*/README.md 2>/dev/null || true ) | head -1 | grep -oP 'spikes/\K[^/]+' || true)

# Check for active sketch
sketch=$(( ls -lt .planning/sketches/*/README.md .planning/sketches/*/index.html 2>/dev/null || true ) | head -1 | grep -oP 'sketches/\K[^/]+' || true)

# Check for active deliberation
deliberation=$(ls .planning/deliberations/*.md 2>/dev/null | head -1 || true)
```

- **Phase work**: active phase directory → handoff to `.planning/phases/XX-name/.continue-here.md`
- **Spike work**: active spike directory or spike-related files (no active phase) → handoff to `.planning/spikes/SPIKE-NNN/.continue-here.md` (create directory if needed)
- **Sketch work**: active sketch directory (no active phase/spike) → handoff to `.planning/sketches/.continue-here.md`
- **Deliberation work**: active deliberation file (no phase/spike/sketch) → handoff to `.planning/deliberations/.continue-here.md`
- **Research work**: research notes exist but no phase/spike/sketch/deliberation → handoff to `.planning/.continue-here.md`
- **Default**: no detectable context → handoff to `.planning/.continue-here.md`, note the ambiguity in `<current_state>`

If phase is detected, proceed with phase handoff path. Otherwise use the first matching non-phase path above.
</step>

<step name="gather">
**Collect complete state for handoff:**

1. **Current position**: Which phase, which plan, which task
2. **Work completed**: What got done this session
3. **Work remaining**: What's left in current plan/phase
4. **Decisions made**: Key decisions and rationale
5. **Blockers/issues**: Anything stuck
6. **Human actions pending**: Things that need manual intervention (MCP setup, API keys, approvals, manual testing)
7. **Background processes**: Any running servers/watchers that were part of the workflow
8. **Files modified**: What's changed but not committed
9. **Outstanding async external jobs**: any `.planning/async-jobs/*.json` manifests for non-terminal jobs — record job id, backend, status, expected artifacts, verification + resume commands, and any watcher/daemon state. Do NOT cancel the external job; it keeps running across the pause.
10. **Blocking constraints**: Anti-patterns or methodological failures encountered during this session that a resuming agent MUST be aware of before proceeding. Only include items discovered through actual failure — not warnings or predictions. Assign each constraint a `severity`:
   - `blocking` — The resuming agent MUST demonstrate understanding before proceeding. The discuss-phase and execute-phase workflows will enforce a mandatory understanding check.
   - `advisory` — Important context but does not gate resumption.

Ask user for clarifications if needed via conversational questions.

**Also inspect SUMMARY.md files for false completions:**
```bash
# Check for placeholder content in existing summaries
grep -l "To be filled\|placeholder\|TBD" .planning/phases/*/*.md 2>/dev/null || true
```
Report any summaries with placeholder content as incomplete items.
</step>

<step name="write_structured">
**Write structured handoff to `.planning/HANDOFF.json`:**

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=0; if [ -f "$GSD_TOOLS" ]; then _GSD_FOUND=1; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${QODER_CONFIG_DIR:-$HOME/.qoder}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QODER_CONFIG_DIR:-$HOME/.qoder}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; [ "$_GSD_FOUND" = "1" ] && gsd_run() { node "$GSD_TOOLS" "$@"; }; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
timestamp=$(gsd_run query current-timestamp full --raw)
```

```json
{
  "version": "1.0",
  "timestamp": "{timestamp}",
  "phase": "{phase_number}",
  "phase_name": "{phase_name}",
  "phase_dir": "{phase_dir}",
  "plan": {current_plan_number},
  "task": {current_task_number},
  "total_tasks": {total_task_count},
  "status": "paused",
  "completed_tasks": [
    {"id": 1, "name": "{task_name}", "status": "done", "commit": "{short_hash}"},
    {"id": 2, "name": "{task_name}", "status": "done", "commit": "{short_hash}"},
    {"id": 3, "name": "{task_name}", "status": "in_progress", "progress": "{what_done}"}
  ],
  "remaining_tasks": [
    {"id": 4, "name": "{task_name}", "status": "not_started"},
    {"id": 5, "name": "{task_name}", "status": "not_started"}
  ],
  "blockers": [
    {"description": "{blocker}", "type": "technical|human_action|external", "workaround": "{if any}"}
  ],
  "async_jobs": [
    {"manifest": ".planning/async-jobs/{job}.json", "job_id": "{id}", "backend": "{backend}", "status": "running", "submit_command": "{cmd}", "submitted_at": "{iso8601}", "expected_artifacts": ["..."], "verification_command": "{cmd}", "resume_command": "{cmd}"}
  ],
  "human_actions_pending": [
    {"action": "{what needs to be done}", "context": "{why}", "blocking": true}
  ],
  "decisions": [
    {"decision": "{what}", "rationale": "{why}", "phase": "{phase_number}"}
  ],
  "uncommitted_files": [],
  "next_action": "{specific first action when resuming}",
  "context_notes": "{mental state, approach, what you were thinking}"
}
```

Any recorded `async_jobs` entries are the primary resume context on the next session — check them first before treating a PLAN-without-SUMMARY as incomplete work.
</step>

<step name="write">
**Write handoff to the path determined in the detect step** (e.g. `.planning/phases/XX-name/.continue-here.md`, `.planning/spikes/SPIKE-NNN/.continue-here.md`, or `.planning/.continue-here.md`):

```markdown
---
context: [phase|spike|sketch|deliberation|research|default]
phase: XX-name
task: 3
total_tasks: 7
status: in_progress
last_updated: [timestamp from current-timestamp]
---

# BLOCKING CONSTRAINTS — Read Before Anything Else

> These are not suggestions. Each constraint below was discovered through failure.
> Acknowledge each one explicitly before proceeding.

- [ ] CONSTRAINT: [name] — [what it is] — [structural mitigation required]

**Do not proceed until all boxes are checked.**

_If no constraints have been identified yet, remove this section._

## Critical Anti-Patterns

| Pattern | Description | Severity | Prevention Mechanism |
|---------|-------------|----------|---------------------|
| [pattern name] | [what it is and how it manifested] | blocking | [structural step that prevents recurrence — not acknowledgment] |
| [pattern name] | [what it is and how it manifested] | advisory | [guidance for avoiding it] |

**Severity values:** `blocking` — resuming agent must pass understanding check before proceeding. `advisory` — important context, does not gate resumption.

_Remove rows that do not apply. The discuss-phase and execute-phase workflows parse this table and enforce a mandatory understanding check for any `blocking` rows._

<current_state>
[Where exactly are we? Immediate context]
</current_state>

<completed_work>

Completed Tasks:
- Task 1: [name] - Done
- Task 2: [name] - Done
- Task 3: [name] - In progress, [what's done]
</completed_work>

<remaining_work>

- Task 3: [what's left]
- Task 4: Not started
- Task 5: Not started
</remaining_work>

<decisions_made>

- Decided to use [X] because [reason]
- Chose [approach] over [alternative] because [reason]
</decisions_made>

<blockers>
- [Blocker 1]: [status/workaround]
</blockers>

## Required Reading (in order)
<!-- List documents the resuming agent must read before acting -->
1. [document] — [why it matters]
1. `.planning/METHODOLOGY.md` (if it exists) — project analytical lenses; apply before any assumption analysis

## Critical Anti-Patterns (do NOT repeat these)
<!-- Mistakes discovered this session that must be structurally avoided -->
- [ANTI-PATTERN]: [what it is] → [structural mitigation]

## Infrastructure State
<!-- Running services, external state, environment specifics -->
- [service/env]: [current state]

## Pre-Execution Critique Required
<!-- Fill in ONLY if pausing between design and execution (e.g. spike design done, not yet run) -->
- Design artifact: [path]
- Critique focus: [key questions the critic should probe]
- Gate: Do NOT begin execution until critique is complete and design is revised

<context>
[Mental state, what were you thinking, the plan]
</context>

<next_action>
Start with: [specific first action when resuming]
</next_action>
```

Be specific enough for a fresh Claude to understand immediately.

Use `current-timestamp` for last_updated field. You can use init todos (which provides timestamps) or call directly:
```bash
timestamp=$(gsd_run query current-timestamp full --raw)
```
</step>

<step name="commit">
```bash
gsd_run query commit "wip: [context-name] paused at [X]/[Y]" --files [handoff-path] .planning/HANDOFF.json
```
</step>

<step name="confirm">
```
✓ Handoff created:
  - .planning/HANDOFF.json (structured, machine-readable)
  - [handoff-path] (human-readable)

Current state:

- Context: [phase|spike|deliberation|research]
- Location: [XX-name or SPIKE-NNN]
- Task: [X] of [Y]
- Status: [in_progress/blocked]
- Blockers: [count] ({human_actions_pending count} need human action)
- Committed as WIP

To resume: /gsd:resume-work

```
</step>

</process>

<success_criteria>
- [ ] Context detected (phase/spike/deliberation/research/default)
- [ ] .continue-here.md created at correct path for detected context
- [ ] Required Reading, Anti-Patterns, and Infrastructure State sections filled
- [ ] Pre-Execution Critique section filled if pausing between design and execution
- [ ] Committed as WIP
- [ ] User knows location and how to resume
</success_criteria>

# /gsd:onboard Workflow

One-command onboarding for an existing or unknown repo. This workflow is a thin
renderer around `init onboard`; deterministic routing lives in the CLI projection.

@~/.claude/gsd-core/references/gsd-run-resolver.md

## 1. Render the Onboarding Projection

Parse `$ARGUMENTS`:
- `--fast` passes `--fast` to `init onboard`. Fast mode accepts the fast map for lightweight onboarding only; `next_action` still decides whether complete map work is required before project setup.
- `--text` forces text-mode choices for runtimes without `AskUserQuestion`.

Run the standard `gsd_run` resolver from the reference above, then run the projection from the runtime root:

```bash
# If --fast was parsed from $ARGUMENTS:
INIT=$(gsd_run --cwd "$_GSD_RUNTIME_ROOT" init onboard --fast --raw)
# Otherwise:
INIT=$(gsd_run --cwd "$_GSD_RUNTIME_ROOT" init onboard --raw)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON fields from `INIT`:

- `next_action.kind`, `next_action.command`, `next_action.reason`, `next_action.missing`, `next_action.summary_path`
- `handoff_commands.ingest_docs`, `handoff_commands.manager`, `handoff_commands.new_project`, `handoff_commands.onboard`
- `map_readiness`, `codebase_map_summary_status`, `codebase_map_final_status`
- `planning_exists`, `project_exists`, `requirements_exists`, `roadmap_exists`, `state_exists`
- `is_brownfield`, `fast_mode`, `has_codebase_map`, `has_fast_codebase_map`
- `missing_codebase_map_files`, `missing_fast_codebase_map_files`
- `has_docs_candidates`, `doc_candidate_count`, `onboarding_summary_exists`
- `commit_docs`, `text_mode`, `has_git`, `git_worktree_root`, `in_nested_subdir`
- `response_language`

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

Set:
- `TEXT_MODE=true` if `--text` is present or `text_mode` is true. When `TEXT_MODE` is active, replace every `AskUserQuestion` call below with a plain-text numbered list and ask the user to type their choice number — required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
- `ONBOARDING_ROOT={git_worktree_root || _GSD_RUNTIME_ROOT}`.

If `has_git` and `in_nested_subdir` are true, warn that onboarding artifacts belong to the outer worktree at `git_worktree_root`. Do not run `git init`.

## 2. Execute `next_action`

### `map-codebase`

If `next_action.kind == "map-codebase"`:

- If `TEXT_MODE=true`, print:

```text
{next_action.reason}
Missing map files: {fast_mode ? missing_fast_codebase_map_files : missing_codebase_map_files}

1. Map codebase first — run {next_action.command} from worktree root {ONBOARDING_ROOT} (Recommended)
2. Skip mapping — continue with weaker onboarding context

Enter number:
```

- Otherwise use AskUserQuestion:
  - header: "Codebase"
  - question: "{next_action.reason} Map it first?"
  - options:
    - "Map codebase first" — Run `{next_action.command}` from worktree root `{ONBOARDING_ROOT}` (Recommended)
    - "Skip mapping" — Continue with weaker onboarding context

If the user chooses mapping, do not nest the interactive workflow. Print:

```text
Run from worktree root {ONBOARDING_ROOT}:

{next_action.command}

Then rerun {handoff_commands.onboard} from the same worktree root.
```

Exit. If the user skips mapping:

- If `(project_exists || requirements_exists || roadmap_exists || state_exists) && (!project_exists || !requirements_exists || !roadmap_exists || !state_exists)`, route the skip to the partial planning guard instead:

```text
Skipping codebase mapping may give downstream steps weaker context, but project planning exists and is incomplete.

PROJECT.md: {project_exists ? "present" : "missing"}
REQUIREMENTS.md: {requirements_exists ? "present" : "missing"}
ROADMAP.md: {roadmap_exists ? "present" : "missing"}
STATE.md: {state_exists ? "present" : "missing"}

Run the appropriate lower-level command to fill the missing planning artifact(s), then rerun {handoff_commands.onboard}.
```

Exit.

- If `has_docs_candidates && !project_exists`, route the skip to docs ingest instead:

```text
Skipping codebase mapping may give downstream steps weaker context, but existing ADR/PRD/SPEC/RFC documents should still be ingested before {handoff_commands.new_project}.

Run from worktree root {ONBOARDING_ROOT}:

{handoff_commands.ingest_docs}

Then rerun {handoff_commands.onboard} from the same worktree root.
```

Exit.

- Otherwise print:

```text
Skipping codebase mapping may give {handoff_commands.new_project} weaker context.

Run from worktree root {ONBOARDING_ROOT}:

{handoff_commands.new_project}

Then rerun {handoff_commands.onboard} from the same worktree root.
```

Exit.

### `ingest-docs`

If `next_action.kind == "ingest-docs"`:

- If `TEXT_MODE=true`, print:

```text
{next_action.reason}
Detected {doc_candidate_count} possible ADR/PRD/SPEC/RFC document(s).

1. Ingest docs first — run {next_action.command} from worktree root {ONBOARDING_ROOT} (Recommended)
2. Skip docs ingest — continue to {handoff_commands.new_project}

Enter number:
```

- Otherwise use AskUserQuestion:
  - header: "Docs"
  - question: "Detected {doc_candidate_count} possible ADR/PRD/SPEC/RFC document(s). Ingest them first?"
  - options:
    - "Ingest docs first" — Run `{next_action.command}` from worktree root `{ONBOARDING_ROOT}` (Recommended)
    - "Skip docs ingest" — Continue to `{handoff_commands.new_project}`

If the user chooses ingest, print:

```text
Run from worktree root {ONBOARDING_ROOT}:

{next_action.command}

Then rerun {handoff_commands.onboard} from the same worktree root.
```

Exit. If the user skips docs ingest, print:

```text
Skipping docs ingest may omit existing ADR/PRD/SPEC/RFC context from {handoff_commands.new_project}.

Run from worktree root {ONBOARDING_ROOT}:

{handoff_commands.new_project}

Then rerun {handoff_commands.onboard} from the same worktree root.
```

Exit.

### `complete-map-before-new-project`

If `next_action.kind == "complete-map-before-new-project"`, print:

```text
{next_action.reason}

Run from worktree root {ONBOARDING_ROOT}:

{next_action.command}

Then rerun {handoff_commands.onboard} from the same worktree root.
```

Exit.

### `new-project`

If `next_action.kind == "new-project"`, print:

```text
{next_action.reason}

Run from worktree root {ONBOARDING_ROOT}:

{next_action.command}

Then rerun {handoff_commands.onboard} from the same worktree root.
```

Exit.

### `partial-planning`

If `next_action.kind == "partial-planning"`, print:

```text
Project planning exists but is incomplete.

Missing files: {next_action.missing}
REQUIREMENTS.md: {requirements_exists ? "present" : "missing"}
ROADMAP.md: {roadmap_exists ? "present" : "missing"}
STATE.md: {state_exists ? "present" : "missing"}

Run the appropriate lower-level command to fill the missing planning artifact(s), then rerun {handoff_commands.onboard}.
```

Exit.

### `ready`

If `next_action.kind == "ready"`, print the final status section and exit.

### `write-summary`

If `next_action.kind == "write-summary"`, continue to summary creation.

## 3. Create Onboarding Summary

Create `{ONBOARDING_ROOT}/{next_action.summary_path}`. Do not overwrite an existing summary; the projection should only route here when the summary is missing.

Summary template:

```markdown
# Onboarding Summary

## Project State
- PROJECT.md: {project_exists ? "present" : "missing"}
- REQUIREMENTS.md: {requirements_exists ? "present" : "missing"}
- ROADMAP.md: {roadmap_exists ? "present" : "missing"}
- STATE.md: {state_exists ? "present" : "missing"}

## Codebase Context
- Brownfield repo: {is_brownfield ? "yes" : "no"}
- Map readiness: {map_readiness}
- Codebase map: {codebase_map_summary_status}
- Fast map available: {has_fast_codebase_map ? "yes" : "no"}

## Docs Context
- Existing ADR/PRD/SPEC/RFC candidates: {has_docs_candidates ? doc_candidate_count : 0}

## Recommended Next Step
- {handoff_commands.manager}
```

If `commit_docs` is true, commit only the summary path from the onboarding root:

```bash
gsd_run --cwd "$ONBOARDING_ROOT" query commit "docs: create onboarding summary" --files .planning/onboarding/SUMMARY.md
```

Continue to final status.

## 4. Final Status

Print:

```text
Onboarding status:
- PROJECT.md: {project_exists ? "present" : "missing"}
- REQUIREMENTS.md: {requirements_exists ? "present" : "missing"}
- ROADMAP.md: {roadmap_exists ? "present" : "missing"}
- STATE.md: {state_exists ? "present" : "missing"}
- Codebase map: {codebase_map_final_status}
- Onboarding summary: present

Next recommended command: {handoff_commands.manager}
```

Do not run implementation execution or shipping from onboarding.

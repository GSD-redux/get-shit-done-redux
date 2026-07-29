# GSD CLI Tools Reference

> Reference for the `gsd-tools` CLI (`gsd-core/bin/gsd-tools.cjs`). For slash commands and user flows, see [Command Reference](COMMANDS.md). Return to [docs index](README.md).

---

## Overview

`gsd-tools.cjs` centralizes config parsing, model resolution, phase lookup, git commits, summary verification, state management, and template operations across GSD commands, workflows, and agents.


|                    |                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Shipped path**   | `gsd-core/bin/gsd-tools.cjs`                                                                                                                                                                      |
| **Implementation** | 20 domain modules under `gsd-core/bin/lib/` (the directory is authoritative)                                                                                                                        |
| **Status**         | Primary runtime command surface for orchestration, workflows, and automation. |


**Usage (CJS):**

```bash
node gsd-tools.cjs <command> [args] [--raw] [--cwd <path>]
```

**Global flags (CJS):**


| Flag           | Description                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `--raw`        | Machine-readable output (JSON or plain text, no formatting)                  |
| `--cwd <path>` | Override working directory (for sandboxed subagents)                         |
| `--ws <name>`  | Workstream context for `.planning/workstreams/<name>` paths |


---

## State Commands

Manage `.planning/STATE.md` — the project's living memory.

```bash
# Load full project config + state as JSON
node gsd-tools.cjs state load

# Output STATE.md frontmatter as JSON
node gsd-tools.cjs state json

# Update a single field
node gsd-tools.cjs state update <field> <value>

# Get STATE.md content or a specific section
node gsd-tools.cjs state get [section]

# Batch update multiple fields
node gsd-tools.cjs state patch --field1 val1 --field2 val2

# Increment plan counter
node gsd-tools.cjs state advance-plan

# Record execution metrics
node gsd-tools.cjs state record-metric --phase N --plan M --duration Xmin [--tasks N] [--files N]

# Recalculate progress bar
node gsd-tools.cjs state update-progress

# Add a decision
node gsd-tools.cjs state add-decision --summary "..." [--phase N] [--rationale "..."]
# Or from files:
node gsd-tools.cjs state add-decision --summary-file path [--rationale-file path]

# Add/resolve blockers
node gsd-tools.cjs state add-blocker --text "..."
node gsd-tools.cjs state resolve-blocker --text "..."

# Record session continuity
node gsd-tools.cjs state record-session --stopped-at "..." [--resume-file path]

# Phase start — update STATE.md Status/Last activity for a new phase
node gsd-tools.cjs state begin-phase --phase N --name SLUG --plans COUNT

# Agent-discoverable blocker signalling (used by discuss-phase / UI flows)
node gsd-tools.cjs state signal-waiting --type TYPE --question "..." --options "A|B" --phase P
node gsd-tools.cjs state signal-resume
```

### State Snapshot

Structured parse of the full STATE.md:

```bash
node gsd-tools.cjs state-snapshot
```

Returns JSON with: current position, phase, plan, status, decisions, blockers, metrics, last activity.

### Smart Entry

Read-only situation classifier used by `/gsd:next`.

```bash
node gsd-tools.cjs smart-entry          # Human summary + recommended route
node gsd-tools.cjs smart-entry --json   # Machine-readable result for workflows
```

The JSON result contains `situation`, `recommended`, `summary`, `signals`, and ordered `actions[]`. Detection reads `.planning/STATE.md`, `ROADMAP.md`, latest verification/summary artifacts, and git status; it does not write files or dispatch commands.

---

## Phase Commands

Manage phases — directories, numbering, and roadmap sync.

```bash
# Find phase directory by number
node gsd-tools.cjs find-phase <phase>

# Calculate next decimal phase number for insertions
node gsd-tools.cjs phase next-decimal <phase>

# Append new phase to roadmap + create directory
node gsd-tools.cjs phase add <description>

# Insert decimal phase after existing
node gsd-tools.cjs phase insert <after> <description>

# Remove phase, renumber subsequent
node gsd-tools.cjs phase remove <phase> [--force]

# Mark phase complete, update state + roadmap
# Also emits advisory `warnings[]` when a phase SUMMARY references a file that
# is not on disk — see "Phase SUMMARY artifact check" below.
node gsd-tools.cjs phase complete <phase>

# Evaluate HUMAN-UAT results for a phase (markdown-aware; ignores false-positive contexts)
# Returns JSON: { passed, uat_files[], verification_files[], checks[], blockers[], policy }
node gsd-tools.cjs phase uat-passed <phase> [--require-verification]

# Index plans with waves and status
node gsd-tools.cjs phase-plan-index <phase>

# List phases with filtering
node gsd-tools.cjs phases list [--type planned|executed|all] [--phase N] [--include-archived]
```

### Phase SUMMARY artifact check

A phase `SUMMARY.md` asserts which files the phase created or modified. On
`phase complete`, each SUMMARY in the phase is scanned for referenced file paths
and any path that is not on disk is reported in the command's existing
`warnings[]` array — the case where a summary reports work that never landed.

**Advisory only.** Findings never block completion; the completion gate is the
phase's `VERIFICATION.md` status, which this does not touch. `/gsd-execute-phase`
surfaces the warnings before advancing.

Scope and limits, so the output is not read as more than it is:

- Paths are recovered heuristically from the SUMMARY body — backticked paths and
  `Created:`/`Modified:`-style lines. Globs, URLs, bare hostnames, and paths
  resolving outside the project are skipped rather than reported.
- The `key-files:` frontmatter block is **not** read. Its YAML flow-sequence form
  (`created: [a.ts, b.ts]`) is not matched by the prose scan, so a summary whose
  only file claims live there produces no findings.
- Commit hashes in the SUMMARY are **not** resolved here. The pattern matches any
  hex-shaped token in prose, which is too loose to surface.

Every path the scan does recover is checked — there is no cap. The standalone
`verify-summary` verb keeps its historical default of checking the first two.

---

## Roadmap Commands

Parse and update `ROADMAP.md`.

```bash
# Extract phase section from ROADMAP.md
node gsd-tools.cjs roadmap get-phase <phase>

# Full roadmap parse with disk status
node gsd-tools.cjs roadmap analyze

# Update progress table row from disk
node gsd-tools.cjs roadmap update-plan-progress <N>
```

---

## Config Commands

Read and write `.planning/config.json`.

```bash
# Initialize config.json with defaults
node gsd-tools.cjs config-ensure-section

# Set a config value (dot notation)
node gsd-tools.cjs config-set <key> <value>

# Get a config value
node gsd-tools.cjs config-get <key>

# Set model profile
node gsd-tools.cjs config-set-model-profile <profile>
```

---

## Capability Commands

The capability command family resolves and mutates capability state (ADR-857). One resolved state composes three substrates: the install profile (`.gsd-profile`), the runtime surface (`.gsd-surface.json`), and config gates (`.planning/config.json` `workflow.*`). `enabled = installed && surfaced`; a hook is `active` only when its capability is enabled and its config gate is on.

### `capability state`

```bash
node gsd-tools.cjs capability state [--config-dir <path>] [--raw]
```

Resolves and prints every capability's `installed`, `surfaced`, `enabled`, and per-hook `active` state. Read-only. `--config-dir` selects the runtime config directory (defaults to the resolved Claude home). `--raw` emits JSON.

### `capability set`

```bash
node gsd-tools.cjs capability set <id> [--on | --off] [--gate <key>=<true|false>]... [--config-dir <path>] [--runtime <name>] [--scope <global|project>] [--raw]
```

Mutates one capability, re-resolves, and reports the result. Two axes:

- `--on` / `--off` (aliases `--enable` / `--disable`): the capability on/off switch, applied through the runtime surface. `--off` unsurfaces the capability; the change is reversible and reclaims the surface budget. A capability that owns no skills has no surface footprint — use `--gate` for those.
- `--gate <key>=<true|false>` (repeatable): toggles one of the capability's own config keys (a hook gate) within an enabled capability.
- `--runtime` / `--scope`: materialise the surface change for that runtime's artifact layout.

After writing, the command re-resolves and prints two message classes to stderr: errors (non-zero exit) — unknown capability id, a `--gate` key the capability does not own, a non-boolean gate value, or `--on` for a capability whose skills are not in the install profile; warnings (exit 0) — `--on`/`--off` on a skill-less capability, or a capability left surfaced while every hook is gated off ("present but dead"). Exit status is non-zero only when a requested change could not be applied.

**Examples:**

```bash
# Turn the UI capability off
node gsd-tools.cjs capability set ui --off --config-dir ~/.claude

# Keep the capability on, gate one hook off
node gsd-tools.cjs capability set code-review --gate workflow.code_review=false
```

---

## Teams Status

### `query teams-status`

```bash
node gsd-tools.cjs query teams-status [--active]
```

Read-only detector for claude-code's experimental agent-teams feature (issue #1355). Resolves the runtime via the canonical `GSD_RUNTIME` → `config.runtime` → `'claude'` precedence, then checks `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.

**Default (no flags):** prints a JSON object and exits 0:

```json
{
  "active": false,
  "runtime": "claude",
  "env_present": false,
  "source": "off: flag absent"
}
```

Fields:

| Field | Type | Description |
|---|---|---|
| `active` | boolean | `true` only when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is strictly truthy (`"1"` or `"true"`, case-insensitive) **and** the resolved runtime is `"claude"` |
| `runtime` | string | The resolved runtime name (e.g. `"claude"`, `"codex"`) |
| `env_present` | boolean | `true` when the env flag is set to a strictly-truthy value |
| `source` | string | One of: `"on: env"`, `"off: flag absent"`, `"off: non-claude"` |

**`--active` flag:** exits 0 if `active` is true, exits 1 otherwise. Prints nothing. Useful in bash conditionals:

```bash
if gsd_run query teams-status --active >/dev/null 2>&1; then
  echo "agent-teams is on"
fi
```

This command is strictly read-only — no config writes, no disk mutation.

---

### `query eval.score`

```bash
node gsd-tools.cjs query eval.score --covered <N> --total <N> --infra <tooling>,<dataset>,<cicd>,<guardrails>,<tracing>
```

Deterministic scorer for eval-auditor results. Computes coverage, infrastructure, and overall scores from audited inputs. Called by `gsd-eval-auditor` in its `calculate_scores` step — agents must not recompute these values by hand.

**Inputs:**

| Flag | Type | Description |
|---|---|---|
| `--covered` | integer | Number of eval dimensions scored COVERED |
| `--total` | integer | Total planned eval dimensions |
| `--infra` | string | Comma-separated list of 5 infra component statuses (order: tooling, dataset, cicd, guardrails, tracing); each value is `ok`, `partial`, or `missing` |

**Output JSON:**

| Field | Type | Description |
|---|---|---|
| `coverage_score` | number | `covered / total × 100` |
| `infra_score` | number | `(sum of component weights) / 5 × 100` (`ok`=1, `partial`=0.5, `missing`=0) |
| `overall_score` | number | `(coverage_score × 0.6) + (infra_score × 0.4)` |
| `verdict` | string | `PRODUCTION READY` (80–100) / `NEEDS WORK` (60–<80) / `SIGNIFICANT GAPS` (40–<60) / `NOT IMPLEMENTED` (0–<40) |

**Example:**

```bash
node gsd-tools.cjs query eval.score --covered 3 --total 5 --infra ok,partial,missing,ok,ok
# → {"coverage_score":60,"infra_score":70,"overall_score":64,"verdict":"NEEDS WORK"}
```

This command is strictly read-only — no config writes, no disk mutation.

---

## Model Resolution

```bash
# Get model for agent based on current profile
node gsd-tools.cjs resolve-model <agent-name>
# Raw output returns the selected model ID/tier.
# JSON output also includes profile and, when the active runtime supports it,
# reasoning_effort.
```

Agent names: `gsd-planner`, `gsd-executor`, `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-roadmapper`, `gsd-debugger`, `gsd-codebase-mapper`, `gsd-nyquist-auditor`

---

## Verification Commands

Validate plans, phases, references, and commits.

```bash
# Verify SUMMARY.md file
node gsd-tools.cjs verify-summary <path> [--check-count N]

# Check PLAN.md structure + tasks
node gsd-tools.cjs verify plan-structure <file>

# Check all plans have summaries
node gsd-tools.cjs verify phase-completeness <phase>

# Check @-refs + paths resolve
node gsd-tools.cjs verify references <file>

# Batch verify commit hashes
node gsd-tools.cjs verify commits <hash1> [hash2] ...

# Check must_haves.artifacts
node gsd-tools.cjs verify artifacts <plan-file>

# Check must_haves.key_links
node gsd-tools.cjs verify key-links <plan-file>
```

---

## Validation Commands

Check project integrity.

```bash
# Check phase numbering, disk/roadmap sync
node gsd-tools.cjs validate consistency

# Check .planning/ integrity, optionally repair
node gsd-tools.cjs validate health [--repair]

# Probe context-window utilization for status-line / hook callers (v1.40.0)
node gsd-tools.cjs validate context

# Context utilization as typed JSON surface (#455)
node gsd-tools.cjs validate context --json
```

`validate context` emits a structured envelope with `utilization`, `status`
(`ok` / `warn` / `critical` at the 60 % / 70 % thresholds), and a
`suggestion` string. The same data backs `/gsd-health --context`.
Pass `--json` to receive the typed IR directly (useful in scripts and test assertions).

---

## Template Commands

Template selection and filling.

```bash
# Select summary template based on granularity
node gsd-tools.cjs template select <type>

# Fill template with variables
node gsd-tools.cjs template fill <type> --phase N [--plan M] [--name "..."] [--type execute|tdd] [--wave N] [--fields '{json}']
```

Template types for `fill`: `summary`, `plan`, `verification`

---

## Frontmatter Commands

YAML frontmatter CRUD operations on any Markdown file.

```bash
# Extract frontmatter as JSON
node gsd-tools.cjs frontmatter get <file> [--field key]

# Update single field
node gsd-tools.cjs frontmatter set <file> --field key --value jsonVal

# Merge JSON into frontmatter
node gsd-tools.cjs frontmatter merge <file> --data '{json}'

# Validate required fields
node gsd-tools.cjs frontmatter validate <file> --schema plan|summary|verification
```

---

## Scaffold Commands

Create pre-structured files and directories.

```bash
# Create CONTEXT.md template
node gsd-tools.cjs scaffold context --phase N

# Create UAT.md template
node gsd-tools.cjs scaffold uat --phase N

# Create VERIFICATION.md template
node gsd-tools.cjs scaffold verification --phase N

# Create phase directory
node gsd-tools.cjs scaffold phase-dir --phase N --name "phase name"
```

---

## Init Commands (Compound Context Loading)

Load all context needed for a specific workflow in one call. Returns JSON with project info, config, state, and workflow-specific data. `init onboard [--fast] [--text]` reports brownfield signals, planning-doc candidates, codebase-map completeness, fast-map readiness, text-mode routing, partial planning state, and onboarding summary status for `/gsd-onboard`.

```bash
node gsd-tools.cjs init execute-phase <phase>
node gsd-tools.cjs init plan-phase <phase>
node gsd-tools.cjs init new-project
node gsd-tools.cjs init new-milestone
node gsd-tools.cjs init onboard [--fast] [--text]
node gsd-tools.cjs init quick <description>
node gsd-tools.cjs init resume
node gsd-tools.cjs init verify-work <phase>
node gsd-tools.cjs init phase-op <phase>
node gsd-tools.cjs init todos [area]
node gsd-tools.cjs init milestone-op
node gsd-tools.cjs init map-codebase
node gsd-tools.cjs init progress

# Workstream-scoped init (`--ws` flag)
node gsd-tools.cjs init execute-phase <phase> --ws <name>
node gsd-tools.cjs init plan-phase <phase> --ws <name>
```

**Large payload handling:** When output exceeds ~50KB, the CLI writes to a temp file and returns `@file:/tmp/gsd-init-XXXXX.json`. Workflows check for the `@file:` prefix and read from disk:

```bash
INIT=$(node gsd-tools.cjs init execute-phase "1")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

---

## Milestone Commands

```bash
# Archive milestone
node gsd-tools.cjs milestone complete <version> [--name <name>] [--no-archive-phases]

# Mark requirements as complete
node gsd-tools.cjs requirements mark-complete <ids>
# Accepts: REQ-01,REQ-02 or REQ-01 REQ-02 or [REQ-01, REQ-02]
```

---

## Agent Skills

Emit the skill block for a given agent type.

```bash
# Emit raw XML skill block (default — safe for shell expansion)
node gsd-tools.cjs agent-skills <agent-type>

# Emit typed JSON surface (#455) — { agent_type, block, skills_count, warnings, configured, reason, source, degraded }
node gsd-tools.cjs agent-skills <agent-type> --json
```

The `--json` flag returns a typed IR object suitable for structured consumption and test assertions, while the default (no flag) preserves the raw XML output that workflow shell expansions rely on.

**`--json` field reference** (as of #1415, Resolution Provenance P2):

| Field | Type | Description |
|---|---|---|
| `agent_type` | `string` | The agent type that was queried. |
| `block` | `string` | The `<agent_skills>` XML block, or `""` when empty. |
| `skills_count` | `number` | Number of skill paths configured for this agent type. |
| `warnings` | `string[]` | Per-path warnings for skills that were skipped (missing `SKILL.md`, unsafe path, etc.). Empty when all configured paths resolved. |
| `configured` | `boolean` | `true` when the agent type appears in `agent_skills` in the config; `false` when the key is absent entirely. |
| `reason` | `string` | Resolution reason: `"resolved"` (block non-empty), `"not_configured"` (agent not in `agent_skills` — silent), `"configured_empty"` (configured but paths list is empty — emits stderr WARNING), `"configured_unresolved"` (configured with paths but all failed to resolve — emits stderr WARNING). |
| `source` | `string` | Config provenance: `"root"` (`.planning/config.json`), `"workstream"` (workstream-scoped config), `"global-defaults"` (`~/.gsd/defaults.json`), `"builtin-defaults"` (no project config). |
| `degraded` | `boolean` | `true` when a workstream was requested but its config.json was absent and the command fell back to root config; `false` otherwise. |

The command anchors to the project root via `findProjectRoot` before loading config, so invoking it from a descendant subdirectory resolves the same config as the project root.

---

## Skill Manifest

Pre-compute and cache skill discovery for faster command loading.

```bash
# Generate skill manifest (writes to .claude/skill-manifest.json)
node gsd-tools.cjs skill-manifest

# Generate with custom output path
node gsd-tools.cjs skill-manifest --output <path>
```

Returns JSON mapping of all available GSD skills with their metadata (name, description, file path, argument hints). Used by the installer and session-start hooks to avoid repeated filesystem scans.

---

## Utility Commands

```bash
# Convert text to URL-safe slug
node gsd-tools.cjs generate-slug "Some Text Here"
# → some-text-here

# Get timestamp
node gsd-tools.cjs current-timestamp [full|date|filename]

# Count and list pending todos
node gsd-tools.cjs list-todos [area]

# List captured seeds (optionally filter by status: dormant|active|triggered)
node gsd-tools.cjs list-seeds [status]

# Check file/directory existence
node gsd-tools.cjs verify-path-exists <path>

# Append a row to STATE.md's "Quick Tasks Completed" table (schema-backed; #2133)
node gsd-tools.cjs quick-tasks-append --task "<description>"

# Aggregate all SUMMARY.md data
node gsd-tools.cjs history-digest

# Extract structured data from SUMMARY.md
node gsd-tools.cjs summary-extract <path> [--fields field1,field2]

# Project statistics
node gsd-tools.cjs stats [json|table]

# Progress rendering (human-readable)
node gsd-tools.cjs progress [json|table|bar]

# Progress as typed JSON surface (#455)
node gsd-tools.cjs progress --json

# Complete a todo
node gsd-tools.cjs todo complete <filename>

# UAT audit — scan all phases for unresolved items
node gsd-tools.cjs audit-uat

# Cross-artifact audit queue — scan `.planning/` for unresolved audit items
node gsd-tools.cjs audit-open [--json]

# Reverse-migrate a GSD-2 project into the current structure (backs `/gsd-import --from-gsd2`)
node gsd-tools.cjs from-gsd2 [--path <dir>] [--force] [--dry-run]

# Git commit with config checks
node gsd-tools.cjs commit <message> [--files f1 f2] [--amend] [--no-verify] [--respect-staged]
```

> `--no-verify`: Skips pre-commit hooks. Used by parallel executor agents during wave-based execution to avoid build lock contention (e.g., cargo lock fights in Rust projects). The orchestrator runs hooks once after each wave completes. Do not use `--no-verify` during sequential execution — let hooks run normally.
> `--files <paths>` **staging behaviour**: by default, `--files` runs `git add -- <path>` for each named file before committing. This overwrites any per-hunk staging set up via `git add -p`. Pass `--respect-staged` to skip the `git add` step and commit only what is already in the index within the requested pathspec. If nothing is staged within that scope, the command returns `{ committed: false, reason: 'nothing staged' }` without error. The trailing `-- <paths>` pathspec on the commit is applied under both modes, so files staged outside the `--files` scope are never included (#3061 invariant).

```bash
# Web search (requires Brave API key)
node gsd-tools.cjs websearch <query> [--limit N] [--freshness day|week|month]
```

---

## Update Backup and Restore

The two halves of `/gsd:update`'s user-added-file protection. `detect-custom-files`
lists files that exist inside GSD-managed directories but are absent from
`gsd-file-manifest.json` — the update workflow copies those into
`gsd-user-files-backup/` before the clean-install wipe. `restore-custom-files`
puts them back afterwards.

```bash
# List user-added files the installer would destroy (JSON)
node gsd-tools.cjs detect-custom-files --config-dir <config-dir>

# Plan a restore — reports what would be restored, writes nothing
node gsd-tools.cjs restore-custom-files --config-dir <config-dir>

# Restore the eligible entries
node gsd-tools.cjs restore-custom-files --config-dir <config-dir> --apply
```

`restore-custom-files` emits one entry per backed-up file:

| Field | Meaning |
|---|---|
| `path` | Path relative to the config dir — where the file came from and goes back to |
| `outcome` | `eligible` (plan mode) · `restored` · `skipped_destination_managed` · `skipped_destination_exists` · `skipped_copy_failed` · `skipped_unsafe_path` |
| `warnings` | Advisory `{code, detail}` findings from the compatibility pass; never blocks a restore |

Warning codes: `destination_managed`, `destination_exists`,
`missing_referenced_path`, `missing_referenced_command`,
`frontmatter_missing_field`, `write_failed`.

The compatibility pass runs against the **newly installed** release, so it
catches a backed-up skill that `@`-references a workflow the new version
retired, invokes a `/gsd:` command that no longer exists, or is missing the
`name` / `description` frontmatter its runtime needs.

Three things the restore never does: it never deletes the backup, it never
overwrites a path the new release ships (`skipped_destination_managed`), and it
never overwrites a different file already on disk
(`skipped_destination_exists`). Symlinked backup entries are skipped outright
rather than followed (`skipped_unsafe_path`). A single unwritable entry is
reported and the remaining entries still restore.

---

## Worktree Commands

Diagnose and configure the worktree fork base used by Claude Code's `isolation="worktree"` executor dispatch. These commands address the branch-divergence condition described in [Fix the worktree base-mismatch (exit 42) error](how-to/fix-worktree-base-mismatch.md).

```bash
# Check whether the current HEAD has diverged from the worktree fork base.
# Returns JSON: { shouldDegrade, reason, message, headSha, forkRef, forkSha }
node gsd-tools.cjs worktree base-check

# Write worktree.baseRef:"head" into .claude/settings.local.json (no-clobber).
# Returns JSON: { changed, skipped, previous, baseRef, file }
node gsd-tools.cjs worktree set-baseref
```

**`worktree base-check`** reads `worktree.baseRef` from a three-layer cascade — `.claude/settings.local.json`, then `.claude/settings.json`, then the user/global `settings.json` under `CLAUDE_CONFIG_DIR` (or `~/.claude`) — and compares the current `HEAD` SHA against `origin/HEAD`. Project-level settings take precedence over the user/global layer, so a machine-wide `worktree.baseRef:"head"` set via `/config` is honored when no project override exists. The `shouldDegrade` field is `true` when the execute-phase orchestrator will fall back to sequential execution. Possible `reason` values:

| `reason` | `shouldDegrade` | Meaning |
|---|---|---|
| `baseref-head` | `false` | `worktree.baseRef:"head"` is set; no mismatch possible |
| `head-matches-fork` | `false` | HEAD and `origin/HEAD` are the same commit |
| `head-diverged-from-fork` | `true` | Branch is ahead of or diverged from `origin/HEAD` |
| `fork-ref-unknown` | `true` | `origin/HEAD` could not be resolved |
| `no-head` | `false` | Not in a git repo (no `HEAD`) |

**`worktree set-baseref`** applies a no-clobber write of `worktree.baseRef:"head"` to `.claude/settings.local.json`. If the file already contains an explicit `baseRef` value other than `"head"`, the existing value is preserved and `skipped:"explicit-other"` is returned. Malformed JSON causes an error rather than a silent overwrite. Both fresh installs and upgrades of GSD Core run this automatically when `workflow.use_worktrees` is enabled (the default); the command is also available for manual use — for example, to apply the setting when worktrees were toggled on after installation, or to re-apply it after a settings change.

### Wave-manifest recording

The execute-phase orchestrator records each spawned executor's worktree identity into a wave cleanup manifest so the matching `cleanup-wave` reader can later merge and remove exactly those worktrees.

```bash
# Append a validated per-agent entry to the wave cleanup manifest.
# Returns JSON: { ok, reason, entry, manifest_path } (exit 0), or
#   { ok:false, reason, hint } with a non-zero exit on a rejected entry.
node gsd-tools.cjs worktree record-agent \
  --manifest <path> --agent-id <id> --path <worktree> --branch <branch> --base <sha>
```

**`worktree record-agent`** appends one `{agent_id, worktree_path, branch, expected_base}` entry to an already-initialized manifest, validating every field **at write time using the same rules the `cleanup-wave` reader enforces** — `--branch` must match the disposable `^(worktree-)?agent-[A-Za-z0-9._/-]+$` namespace (accepts both `agent-<id>` and legacy `worktree-agent-<id>`), and `--path`/`--branch`/`--base` must be non-empty. `--agent-id` is required (write-strict), even though the reader treats it as optional. A missing or garbled field — or a duplicate `(worktree_path, branch)` the reader would dedup away — fails loudly with a recovery hint and a non-zero exit **without** writing, instead of appending an under-populated or silently-dropped entry. Whitespace-only `--path`/`--base` are rejected (values are trimmed). The on-disk manifest shape is unchanged (the reader re-derives `allowed_bases`); the orchestrator still initializes the empty `{orchestrator_root, worktrees: []}` shell inline before any agent is recorded.

---

## Graphify

Build, query, and inspect the project knowledge graph in `.planning/graphs/`. Requires `graphify.enabled: true` in `config.json` (see [Configuration Reference](CONFIGURATION.md#graphify-settings)).

```bash
# Build or rebuild the knowledge graph
node gsd-tools.cjs graphify build

# Search the graph for a term
node gsd-tools.cjs graphify query <term>

# Show graph freshness and statistics
node gsd-tools.cjs graphify status

# Show changes since the last build
node gsd-tools.cjs graphify diff

# Write a named snapshot of the current graph
node gsd-tools.cjs graphify snapshot [name]
```

User-facing entry point: `/gsd-graphify` (see [Command Reference](COMMANDS.md#gsd-graphify)).

---

## Module Architecture

| Module | File | Exports |
|--------|------|---------|
| Core | `lib/core.cjs` | `error()`, `output()`, `parseArgs()`, shared utilities, compatibility re-exports |
| State | `lib/state.cjs` | All `state` subcommands, `state-snapshot` |
| Phase | `lib/phase.cjs` | Phase CRUD, `find-phase`, `phase-plan-index`, `phases list` |
| Planning Workspace | `lib/planning-workspace.cjs` | Planning seam: `planningDir`, `planningPaths`, active workstream routing, `.planning/.lock` |
| Roadmap | `lib/roadmap.cjs` | Roadmap parsing, phase extraction, progress updates |
| Config | `lib/config.cjs` | Config read/write, section initialization |
| Verify | `lib/verify.cjs` | All verification and validation commands |
| Template | `lib/template.cjs` | Template selection and variable filling |
| Frontmatter | `lib/frontmatter.cjs` | YAML frontmatter CRUD |
| Init | `lib/init.cjs` | Compound context loading for all workflows |
| Milestone | `lib/milestone.cjs` | Milestone archival, requirements marking |
| Commands | `lib/commands.cjs` | Misc: slug, timestamp, todos, scaffold, stats, websearch |
| Model Profiles | `lib/model-profiles.cjs` | Profile resolution table |
| UAT | `lib/uat.cjs` | Cross-phase UAT/verification audit |
| Profile Output | `lib/profile-output.cjs` | Developer profile formatting |
| Profile Pipeline | `lib/profile-pipeline.cjs` | Session analysis pipeline |
| Graphify | `lib/graphify.cjs` | Knowledge graph build/query/status/diff/snapshot (backs `/gsd-graphify`) |
| Learnings | `lib/learnings.cjs` | Extract learnings from phases/SUMMARY artifacts (backs `/gsd-extract-learnings`) |
| Audit | `lib/audit.cjs` | Phase/milestone audit queue handlers; `audit-open` helper |
| GSD2 Import | `lib/gsd2-import.cjs` | Reverse-migration importer from GSD-2 projects (backs `/gsd-import --from-gsd2`) |
| Intel | `lib/intel.cjs` | Queryable codebase intelligence index (backs `/gsd-map-codebase --query`) |
| Capability State | `lib/capability-state.cjs` | Capability-state resolver — composes install profile, surface, and config into per-capability `enabled`/`active` view |
| Capability Writer | `lib/capability-writer.cjs` | Capability-state writer (ADR-1213) — write-side inverse; projects `--on`/`--off`/`--gate` onto surface + config substrates then re-resolves |
| Worktree Base Ref | `lib/worktree-base-ref.cjs` | Worktree fork-base detection and `worktree base-check` / `set-baseref` commands (#683) |

---

## Reviewer CLI Routing

`review.models.<cli>` maps a reviewer flavor to a bare model id injected into the CLI's `--model` (or `-m`) flag by the code-review workflow. Set via [`/gsd-config --integrations`](COMMANDS.md#gsd-config) or directly:

```bash
node gsd-tools.cjs config-set review.models.codex    "gpt-5"
node gsd-tools.cjs config-set review.models.gemini   "gemini-2.5-pro"
node gsd-tools.cjs config-set review.models.opencode "claude-sonnet-4"
node gsd-tools.cjs config-set review.models.claude   ""   # clear — fall back to session model
```

Slugs are validated against `[a-zA-Z0-9_-]+`; empty or path-containing slugs are rejected. See [`docs/CONFIGURATION.md`](CONFIGURATION.md#code-review-cli-routing) for the full field reference.

## Secret Handling

API keys configured via `/gsd-settings` (`brave_search`, `firecrawl`, `exa_search`) are written plaintext to `.planning/config.json` but are masked (`****<last-4>`) in every `config-set` / `config-get` output, confirmation table, and interactive prompt. See `gsd-core/bin/lib/secrets.cjs` for the masking implementation. The `config.json` file itself is the security boundary — protect it with filesystem permissions and keep it out of git (`.planning/` is gitignored by default).

---

## Related

- [Commands](COMMANDS.md)
- [Configuration](CONFIGURATION.md)
- [Architecture](ARCHITECTURE.md)
- [Fix the worktree base-mismatch (exit 42) error](how-to/fix-worktree-base-mismatch.md)
- [docs index](README.md)

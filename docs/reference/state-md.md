# STATE.md schema reference

`STATE.md` is GSD Core's living project-memory file — a single Markdown document that records where a project stands, what happened last, and what to run next. This page documents its structure. See [docs index](../README.md).

---

## Overview

Every project managed by GSD Core keeps one `STATE.md` at `.planning/STATE.md`. It is read at the start of every workflow and written after every significant action. The file combines:

- **YAML frontmatter** — machine-readable fields consumed by the status-line hook (`parseStateMd`) and the `gsd-tools state` commands.
- **Markdown body** — human-readable sections covering current position, accumulated context, session continuity, and performance metrics.

The file is intentionally small (target: under 100 lines). It is a digest of the project's state, not an archive.

---

## YAML frontmatter

Frontmatter appears between `---` delimiters at the very start of the file. All fields except `gsd_state_version` and `status` are optional; fields may be absent when their data is not yet available.

### Annotated example

```yaml
---
gsd_state_version: '1.0'
milestone: v2.0
milestone_name: Code Quality
status: executing

# Phase-lifecycle fields — all optional (added in v1.40.0, issue #2833)
active_phase: "4.5"
next_action: execute-phase
next_phases: ["4.5"]

progress:
  total_phases: 17
  completed_phases: 10
  total_plans: 84
  completed_plans: 47
  percent: 59

# Additional fields written by syncStateFrontmatter
current_phase: "4"
current_phase_name: Observability
current_plan: "3"
last_updated: "2026-06-01T12:34:56.789Z"
state_head: 4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b
last_activity: "2026-06-01"
stopped_at: "Phase 4 P3 execution complete"
paused_at: null
---
```

### Field reference

| Field | Type | When populated | Purpose |
|---|---|---|---|
| `gsd_state_version` | string (`'1.0'`) | Always | Schema version; written on first `state.*` call by `syncStateFrontmatter`. |
| `milestone` | string (e.g. `v2.0`) | When a milestone is configured | Current milestone version, read from the project's config. |
| `milestone_name` | string | When a milestone is configured | Human-readable milestone label (e.g. `Code Quality`). |
| `status` | string | Always | Current lifecycle stage. Normalised by `normalizeStateStatus()` — see [status values](#status-values). |
| `active_phase` | string (e.g. `"4.5"`) | An orchestrator command is in flight on this phase | The phase number currently being processed. Set to `null` when between phases. |
| `next_action` | string | Idle, with a recommended command | The slash command to run next: `discuss-phase`, `plan-phase`, `execute-phase`, or `verify-phase`. Set to `null` when an orchestrator is in flight or no recommendation is available. |
| `next_phases` | YAML flow array (e.g. `["4.5"]`) | Goes with `next_action` | The phase ID(s) the `next_action` applies to (typically 1–2 entries). Set to `null` under the same conditions as `next_action`. |
| `progress.total_phases` | integer | When phase data is available | Total number of phases in the current milestone, derived from ROADMAP.md and the phases directory. |
| `progress.completed_phases` | integer | When phase data is available | Number of phases that have all plan summaries on disk (i.e. every plan completed). |
| `progress.total_plans` | integer | When plan files exist | Sum of all plan files across phases in the current milestone. |
| `progress.completed_plans` | integer | When summary files exist | Sum of completed plan summaries (one SUMMARY.md per executed plan). |
| `progress.percent` | integer 0–100 | When progress data is available | Milestone progress in the **phase dimension** (`min(completed_plans/total_plans, completed_phases/total_phases)`). The status-line progress bar is only rendered when this field is present — its absence suppresses the bar. |
| `current_phase` | string | When a phase is executing | Phase number extracted from the body `Current Phase:` field. |
| `current_phase_name` | string | When a phase has a name | Phase name extracted from the body `Current Phase Name:` field. |
| `current_plan` | string | When a plan is in progress | Plan number extracted from the body `Current Plan:` field. |
| `last_updated` | ISO-8601 timestamp | Always (on write) | Timestamp of the last `syncStateFrontmatter` call; written by `realClock.nowIso()`. |
| `state_head` | string (40-char sha) | On write, when the project's own git repo resolves | Full commit sha STATE.md was written against (#2573). Omitted entirely outside a git repo, when the resolved repo is not the project's own, or in a `planning.sub_repos` workspace — an unverifiable stamp degrades to absent rather than asserting provenance the file does not have. Recomputed on every write and never carried forward. |
| `last_activity` | string | When set in body | Date of the last activity, extracted from the body `Last Activity:` field. |
| `stopped_at` | string | When a stop point was recorded | Description of the last completed action; scoped to the `## Session` body section to avoid matching archive prose. |
| `paused_at` | string | When the project is paused | Freeform description of the pause point; absent or `null` when not paused. |

> **Known limitation — multi-repo workspaces.** In a workspace configured with
> [`planning.sub_repos`](../CONFIGURATION.md#planning), the freshness hint reports *unknown*
> rather than a commit age, and `state_head` is omitted. The outer workspace can own both
> `.planning/` and its own git repo while every code commit lands in a nested child repo, so the
> outer `HEAD` would not advance when the code does — measuring against it would report
> "known fresh" for a STATE.md that is arbitrarily far behind. Reporting unknown is deliberate:
> a wrong answer here is worse than no answer. Aggregating freshness across several child
> histories needs a defined semantics and is not part of this feature.

### Status values

`normalizeStateStatus()` in `gsd-core/bin/lib/state-document.cjs` maps raw body text to these canonical values:

| Canonical value | Matched text (case-insensitive) |
|---|---|
| `discussing` | contains `discussing` |
| `planning` | contains `planning` or `ready to plan` |
| `executing` | contains `executing`, `in progress`, or `ready to execute` |
| `verifying` | contains `verif` |
| `completed` | contains `complete` or `done` |
| `paused` | contains `paused` or `stopped`, or `paused_at` is present |
| `unknown` | none of the above |

When an orchestrator command is in flight, the convention (issue #2833) is to write the lifecycle stage directly to `status`:

| Command | `status` while in flight |
|---|---|
| `/gsd-discuss-phase` | `discussing` |
| `/gsd-plan-phase` | `planning` |
| `/gsd-execute-phase` | `executing` |
| `/gsd-verify-work` | `verifying` |

### Status lifecycle (ADR-2207)

The `Status` field follows a strict lifecycle across phase and milestone boundaries:

| Value | Written by | Meaning |
|---|---|---|
| `Ready to plan` | `completePhaseCore` (non-last phase) | Next phase is ready for planning |
| `All phases complete` | `completePhaseCore` (last phase) | All phases done; milestone awaiting formal close |
| `<version> milestone complete` | `milestoneCompleteCore` | Milestone formally closed and archived |
| `Awaiting next milestone` | `milestoneCompleteCore` | Terminal/archived state |

Phase-completion verbs never write `Milestone complete` (the overloaded bare value was removed in #2204 per ADR-2207 to decouple phase-level writes from milestone termination).

---

## Status-line rendering scenes

`formatGsdState()` in `hooks/gsd-statusline.js` reads the parsed frontmatter and emits the **first matching scene**. If no new lifecycle fields apply, rendering falls through to the original format byte-for-byte unchanged from v1.38.x.

| Scene | Trigger | Display example |
|---|---|---|
| **1. Phase active** | `active_phase` is populated | `v2.0 [██░░░░░░░░] 20% · Phase 4.5 executing` |
| **2. Idle, next recommended** | `active_phase` is null AND both `next_action` and `next_phases` are populated | `v2.0 [██░░░░░░░░] 20% · next execute-phase 4.5` |
| **3. Milestone complete** | `percent` is `100` OR `completed_phases == total_phases` | `v2.0 [██████████] 100% · milestone complete` |
| **4. Default fallback** | None of the above match | `v1.9 Code Quality · executing · ph 1/5` (existing format) |

**Scene priority:** when both `active_phase` and `next_action` are populated, Scene 1 wins — an orchestrator is in flight, so a "next recommendation" would be misleading. This priority is enforced by check order in `formatGsdState()` and covered by the `"scene priority"` suite in `tests/gsd-statusline.test.cjs`.

The progress bar (`[██░░░░░░░░] 20%`) is appended to the milestone segment only when `progress.percent` is present in frontmatter; absent means no bar.

---

## Frontmatter parsing constraints

The status-line hook uses regex-based parsing (no full YAML library), so the following constraints apply. They are tested in `tests/gsd-statusline.test.cjs`.

1. **Frontmatter must start at the very first character of the file.** Anything — including comments — above the opening `---` invalidates the match. The opening `---` line must be exactly that, with no trailing spaces.

2. **Comments inside nested blocks are not supported.** The `progress:` block parser requires the next line to be `[ \t]+\w+:`. Inserting a `# comment` between `progress:` and its first key breaks the match and the bar disappears. Any documentation belongs in the `STATE.md` body, not inside frontmatter blocks.

3. **`next_phases` primary format is single-line flow.** The parser first tries `next_phases: ["4.5", "4.6"]`. Block sequences (`- 4.5\n- 4.6`) are also parsed but are less reliable for status-line rendering. Prefer single-line flow for `next_phases` to keep the regex-based parser predictable. If many candidate phases need recording for documentation purposes, store them in the `STATE.md` body.

If a future change replaces the regex parser with a full YAML library, these constraints can be relaxed and the tests updated accordingly.

---

## Markdown body sections

The body (everything after the closing `---`) follows the template in `gsd-core/templates/state.md`. The standard sections are:

### Project Reference

Points to `.planning/PROJECT.md`. Contains:
- **Core value** — the one-liner from `PROJECT.md`'s Core Value section.
- **Current focus** — which phase is active.

### Current Position

Where the project stands right now:

| Field | Format |
|---|---|
| `Phase:` | `X of Y (Phase name)` |
| `Plan:` | `A of B in current phase` |
| `Status:` | Free text, e.g. `Ready to execute`, `Executing Phase 4`, `Phase complete — ready for verification` |
| `Last activity:` | ISO date (`YYYY-MM-DD`) when handler-written; narrative prose when executor-authored |
| `Progress:` | Visual bar, e.g. `[████░░░░░░] 40%` |

The `Status:` and `Last activity:` fields in this section are updated by GSD handlers when the existing value is a known template default (Knuth invariant: executor-authored values are preserved). The full list of known handler defaults is in `KNOWN_TEMPLATE_DEFAULTS` inside `gsd-core/bin/lib/state-document.cjs`.

### Performance Metrics

Execution velocity tracking:
- Total plans completed, average duration per plan.
- Per-phase breakdown table (`Phase | Plans | Total | Avg/Plan`).
- Recent trend: Improving / Stable / Degrading.

Updated after each plan completion.

### Accumulated Context

**Decisions** — a summary of recent decisions affecting current work (full log lives in `PROJECT.md`). Added via `gsd-tools state add-decision`.

**Pending Todos** — count and reference to `.planning/todos/pending/`. Captured via `/gsd-capture`.

**Blockers/Concerns** — issues affecting future work, prefixed with the originating phase. Added via `gsd-tools state add-blocker`; resolved via `gsd-tools state resolve-blocker`.

### Session Continuity

Enables instant session resumption:
- `Last session:` — ISO-8601 timestamp of the last session.
- `Stopped at:` — description of the last completed action.
- `Resume file:` — path to a `.continue-here*.md` file if one exists, otherwise `None`.

---

## Backward compatibility

The phase-lifecycle fields (`active_phase`, `next_action`, `next_phases`, and `progress.percent` for the bar) are **additive and opt-in per project**:

- A `STATE.md` with none of the lifecycle fields populated renders **byte-for-byte identically** to v1.38.x and earlier.
- Adding any lifecycle field is opt-in — the renderer degrades gracefully when fields are absent.
- The progress bar is opt-in even when the `progress` block exists: only `progress.percent` triggers the bar; `total_phases` and `completed_phases` alone do not.

The `formatGsdState #2833 backward compatibility` test suite in `tests/gsd-statusline.test.cjs` locks this guarantee; any change that breaks legacy `STATE.md` rendering will fail the suite.

---

## Related

- [Planning artifacts](planning-artifacts.md)
- [Configuration](../CONFIGURATION.md)
- [The phase loop](../explanation/the-phase-loop.md)
- [docs index](../README.md)

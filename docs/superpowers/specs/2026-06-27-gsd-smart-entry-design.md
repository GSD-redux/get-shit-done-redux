# Design: /gsd Smart Entry

**Date:** 2026-06-27
**Status:** Approved — ready for implementation planning
**Origin:** Adapted from the `/gsd` smart-entry wizard in `open-gsd/gsd-pi`, redesigned for gsd-core's markdown-first, multi-runtime architecture.

---

## Summary

A `/gsd-next` command that acts as gsd-core's **state-aware front door**. It reads project + workflow state, classifies the user's situation, and presents a small menu of the right next actions — then dispatches to an existing command. The "smart" part is deterministic detection living in Node (a new `gsd-tools smart-entry` subcommand); the presentation is an idiomatic markdown command + workflow using `AskUserQuestion` with a `--text` fallback for non-Claude runtimes.

This is a **launcher / router**, not an executor. It never does the work itself.

> **Implementation note (command name):** the command-contract (ADR-0002) requires `name:` to be `gsd:*` or `gsd-*` prefixed; a bare `/gsd` is not expressible. The frontmatter is therefore `name: gsd:next`, surfacing as `/gsd-next` (file `commands/gsd/next.md`, backed by `gsd-core/workflows/smart-entry.md`). The "smart entry" concept and behavior are unchanged; only the surfaced name differs from the original `/gsd` sketch.

---

## Motivation

gsd-pi ships a `/gsd` smart-entry wizard — a state-aware menu that branches on detected project state (phase loop, blockers, stranded work) and surfaces one well-chosen set of options with a single recommended action. It is the command users run first. gsd-core has no equivalent front door: users must already know whether to reach for `progress`, `plan-phase`, `execute-phase`, `quick`, or `new-project`.

We want the same daily-driver feel — "run `/gsd`, get told what to do next" — without fighting gsd-core's nature. gsd-core is a **markdown prompt framework installed into AI agents**, not a Node CLI app. So gsd-pi's full-screen TUI and its imperative TypeScript branch tree do not port directly. What ports is the **behavior**: detect state → classify situation → offer contextual options → dispatch.

---

## Resolved design decisions

These were chosen during brainstorming and are fixed inputs to this spec:

1. **Approach: Hybrid.** Detection + classification as a new `gsd-tools smart-entry --json` subcommand (deterministic, unit-tested in Node); presentation + dispatch as a markdown command + workflow that shells out to it via the existing `gsd_run` shim. This mirrors how `gsd-core/workflows/do.md` already drives tooling. Rationale: code-driven detection is reliable and testable; the markdown surface keeps multi-runtime reach (Codex, Gemini, Copilot) and adds zero dependencies.

2. **Priority: workflow routing ("what now?").** The wizard optimizes for the ongoing-work menu (gsd-pi's `showSmartEntry`), not first-run onboarding (gsd-pi's `showProjectInit`). Onboarding routes to the existing `/gsd-new-project`, which already handles project detection and setup. We are **not** building an init wizard.

3. **Richness: phase + smart signals.** The classifier branches on gsd-core's phase loop **and** richer gsd-pi-style signals (blocked/recover, idle/stranded, paused, complete). All 10 situations below are in scope.

4. **Relationship to `/gsd-progress`: complementary, not redundant.** `/gsd-next` is the **front door / launcher** — a state-aware *menu* the user picks the next action from. `/gsd-progress` remains the **detailed situational report + auto-advance** (`--next` chaining). `/gsd-next` will frequently recommend `/gsd-progress`; it does not replace or deprecate it.

---

## Non-goals

- **No init/onboarding wizard.** `/gsd-new-project` already owns first-run project setup. `/gsd-next` routes to it.
- **No new prompt/TUI library.** `AskUserQuestion` (Claude) + `--text` numbered-list fallback (other runtimes) — matching repo convention. No inquirer/clack/ink.
- **No copy of gsd-pi's branch tree.** gsd-pi's milestone/slice/task model does not exist here. The situation table is **redesigned for gsd-core's phase loop** (`.planning/`).
- **No execution.** Pure launcher. Picked action dispatches to an existing command and stops.
- **No new state storage.** Reads existing artifacts (`.planning/STATE.md`, `ROADMAP.md`, git). Writes nothing.

---

## Architecture

```text
/gsd-next   (commands/gsd/next.md — thin markdown dispatcher)
  │
  ▼
workflow: gsd-core/workflows/smart-entry.md        ◄── presentation + dispatch
  │   step 1: resolve gsd_run shim
  │   step 2: gsd_run smart-entry --json
  │   step 3: render AskUserQuestion (or TEXT_MODE list)
  │   step 4: show GSD ► ROUTING banner
  │   step 5: dispatch + stop
  ▼
gsd-tools smart-entry --json               ◄── NEW deterministic detection
  │   reads: state-snapshot (.planning/STATE.md)
  │         + .planning/ existence
  │         + git status / branch / unpushed
  │         + verify signals
  │   emits: { situation, recommended, summary, actions[] }
  ▼
(existing command: progress / plan-phase / execute-phase / quick / ship …)
```

Two artifacts, one contract — the JSON shape in §"JSON contract". The workflow is thin because all branching logic lives in Node.

---

## The classifier — `gsd-tools smart-entry`

New `src/smart-entry.cts` → compiled (build-at-publish, ADR-457) to `gsd-core/bin/lib/smart-entry.cjs`. Registered in `gsd-tools.cjs` as `case 'smart-entry':` (≈2 lines, delegating to `smartEntry.run(cwd, { json: true }, raw)`).

### Contract

- **Pure detection → classification.** No side effects. No writes. No `process.exit()` (throw `ExitError` per repo convention; the `runMain` wrapper translates exit codes).
- **Output modes:** `--json` (machine, used by the workflow) and default (human-readable summary line, for `gsd-tools` users / debugging).
- **Idempotent, fast, no network.** Read-only filesystem + `git` calls only.
- **Never throws in `--json` mode when `.planning/` is absent** — it returns `situation: "no-project"` so the workflow always has a menu to render.

### Inputs

| input | source | what we read |
|---|---|---|
| workflow state | `gsd_run query state.load` / `cmdStateSnapshot` | `current_phase`, `total_phases`, `current_plan`, `total_plans_in_phase`, `status`, `progress`, `blockers[]`, `paused_at`, `last_activity`, session |
| planning dir | filesystem at cwd | existence of `.planning/`, `.planning/STATE.md`, `.planning/ROADMAP.md` |
| git signals | `git status --porcelain`, `git branch`, `git log @{u}..` (guarded) | dirty tree, branch, unpushed commits |
| verify signals | filesystem | latest phase's verify report presence; `STATUS:` marker on most recent summary |

Git calls are **guarded** — any git error (not a repo, no upstream, detached HEAD) is swallowed and treated as "no git signal," never fatal.

### Situations (priority order — first match wins)

This is the gsd-core analog of gsd-pi's phase enum. Evaluated top-down; the first matching row is the situation.

| # | situation | when (predicate over inputs) | recommended action |
|---|---|---|---|
| 1 | `no-project` | `.planning/` absent | `new-project` |
| 2 | `paused` | `paused_at` set (non-empty) | `resume-work` |
| 3 | `blocked` | `blockers[]` non-empty | `debug` |
| 4 | `verify-failed` | latest verify report `STATUS:` indicates failure/blocked | `verify-work` |
| 5 | `needs-first-phase` | STATE exists but `total_phases` ≤ 0 or no `ROADMAP.md` | `discuss-phase` |
| 6 | `planning` | `status` = planning (phase has no plan yet) | `plan-phase` |
| 7 | `executing` | `status` = executing / active | `execute-phase` |
| 8 | `verify-pending` | `status` = needs-verify / review-pending | `verify-work` |
| 9 | `idle-stranded` | clean tree + unpushed/stranded commits OR stale `last_activity` with committed-but-unshipped work | `ship` |
| 10 | `complete` | `total_phases` > 0 and current phase ≥ total and `status` = complete | `new-milestone` |
| — | `unknown` | fallback (no predicate matched) | `progress` |

**Note on `idle-stranded`:** this is the richest heuristic and the most likely to need tuning. Predicates: working tree clean **AND** (`git log @{u}..` non-empty **OR** `last_activity` older than threshold with non-complete `status`). Threshold: 72h (configurable later via config; hardcoded for v1). If this proves brittle in testing it is the first situation to relax — but it is in scope per the richness decision.

### Action set per situation

Each situation produces an ordered `actions[]` array. The recommended action is always first and carries `recommended: true`; the workflow shows the top 4 (`AskUserQuestion` cap). Every situation **always** includes `progress` ("Show progress") and `quick` ("Quick task") as escape hatches, and `help` is appended when room remains.

```
no-project       → new-project*, map-codebase, quick, help
paused           → resume-work*, progress, quick, help
blocked          → debug*, verify-work, capture, progress
verify-failed    → verify-work*, debug, code-review, progress
needs-first-phase→ discuss-phase*, plan-phase, quick, progress
planning         → plan-phase*, discuss-phase, quick, progress
executing        → execute-phase*, "progress --next", quick, code-review
verify-pending   → verify-work*, code-review, "ship", progress
idle-stranded    → ship*, complete-milestone, progress, capture
complete         → new-milestone*, extract-learnings, quick, progress
unknown          → progress*, "progress --next", quick, help
(* = recommended)
```

### JSON contract (machine output, `--json`)

```json
{
  "situation": "executing",
  "recommended": "execute-phase",
  "summary": "Phase 2 of 5 · plan 1/3 · 60% · active",
  "signals": {
    "current_phase": 2,
    "total_phases": 5,
    "status": "executing",
    "progress": 60,
    "has_planning": true,
    "git_dirty": false,
    "paused": false,
    "blockers": []
  },
  "actions": [
    { "id": "execute-phase", "label": "Continue executing phase 2", "command": "/gsd-execute-phase", "recommended": true },
    { "id": "progress-next", "label": "Advance to the next step", "command": "/gsd-progress --next", "recommended": false },
    { "id": "quick", "label": "Quick task", "command": "/gsd-quick", "recommended": false },
    { "id": "code-review", "label": "Review recent work", "command": "/gsd-code-review", "recommended": false }
  ]
}
```

- `situation`, `recommended`, `actions[]` are the contract the workflow depends on.
- `signals` is informational (shown in the summary banner); the workflow does not branch on it.
- `summary` is a one-line human string; the workflow may show it verbatim or reformat.
- `actions[].command` is the full slash command string the workflow dispatches, including flags (e.g. `/gsd-progress --next`).

---

## The markdown layer

### Command — `commands/gsd/next.md` (NEW)

Thin dispatcher, modeled on `commands/gsd/progress.md` and `commands/gsd/help.md`. Backed by `gsd-core/workflows/smart-entry.md` (named for the `smart-entry` classifier + `gsd-tools smart-entry` subcommand; does not collide with the existing `workflows/next.md`, which is the progress `--next` sub-workflow).

Frontmatter:
- `name: gsd:next` (surfaces as `/gsd-next`; the command-contract requires a `gsd:*`/`gsd-*` prefix — a bare `/gsd` is not expressible, see ADR-0002)
- `description:` "GSD smart entry — the state-aware front door. Reads your project state and routes you to the right next action."
- `argument-hint: ""` (no args for v1; reserved)
- `effort: low`
- `allowed-tools:` `Read, Bash, Glob, SlashCommand, AskUserQuestion`
- **No `requires: [phase]`** (unlike `progress`) — must work pre-project.
- `<execution_context>` → `@~/.claude/gsd-core/workflows/smart-entry.md` + `@~/.claude/gsd-core/references/ui-brand.md`

Body: a short `<objective>` stating this is a state-aware launcher, then `<process>` delegating entirely to the workflow. No inline logic.

### Workflow — `gsd-core/workflows/smart-entry.md` (NEW)

Five steps. **Must stay under 32 KiB (NEW_FILE_CAP)** — lean, because all branching is in Node.

**Step 1 — `resolve` (resolve the gsd_run shim):** Copy the `check_project`-style shim-resolution block verbatim from `gsd-core/workflows/do.md:29` (the long `_GSD_SHIM_NAME` resolver). This finds `gsd-tools.cjs` across all supported runtime homes. It is a proven, required block; do not paraphrase.

**Step 2 — `detect` (run the classifier):**
```bash
SNAPSHOT=$(gsd_run smart-entry --json 2>/dev/null)
```
Parse `SNAPSHOT` as JSON. If missing or unparseable → fall back to `/gsd-progress` (Step 5, with a one-line note "smart-entry unavailable — showing progress"). The agent never gets stuck.

**Step 3 — `present` (render the menu):**

TEXT_MODE handling copied verbatim from `do.md:15` (set `TEXT_MODE=true` when `--text` in `$ARGUMENTS` or `text_mode` from init JSON is true; replace every `AskUserQuestion` with a numbered list).

Present via `AskUserQuestion`:
- `header`: derived from `situation` (e.g. `executing` → "Continue work").
- `question`: the `summary` line + "What next?"
- `options`: the first 4 of `actions[]`, label = action `label`, recommended first. (AskUserQuestion shows the first option as recommended.)
- Always allow the user to type a custom command ("Other" is provided automatically by the tool).

In TEXT_MODE: print `summary`, then a numbered list of all `actions[]` (not capped — text has no 4-option limit), ask the user to type a number.

**Step 4 — `display` (routing banner):** Copy the `display` step from `do.md:77-89` verbatim — the `GSD ► ROUTING` banner showing input / routing-to / reason. Input here is the chosen `label`; routing-to is the chosen `command`.

**Step 5 — `dispatch`:** Invoke the chosen `command`. Pass `$ARGUMENTS` through if the user typed a custom command. Then **stop** — the dispatched command owns everything from here. (Same contract as `do.md:91-99`.)

### TEXT_MODE / multi-runtime

The `--text` fallback is mandatory and is the reason we keep menus small and logic in Node. The fallback is copied from `do.md`, not reinvented.

---

## Error handling

| failure | behavior |
|---|---|
| `gsd_run` shim not found | the shim block itself errors with the standard install hint (from `do.md:29`); not our concern |
| `smart-entry` command missing (older gsd-core) | workflow sees empty/unparseable output → falls back to `/gsd-progress` with a note |
| `smart-entry` throws | same: caught by the `2>/dev/null` + parse check → fallback to `/gsd-progress` |
| `.planning/` absent | `smart-entry` returns `situation: "no-project"` → menu offers `new-project` |
| git unavailable / not a repo | classifier swallows git errors; works without git signals |
| `AskUserQuestion` unavailable (non-Claude) | TEXT_MODE numbered list |

**Invariant:** `/gsd` always produces *some* actionable menu and never strands the user. The ultimate fallback is `/gsd-progress`, which is always safe and always exists.

---

## Testing

Per CONTRIBUTING: `node:test` + `node:assert/strict`, behavior assertions only, no source-grep tests.

### `tests/smart-entry.unit.test.cjs` (NEW)

Fixture-driven: create temp dirs with crafted `.planning/STATE.md` + optional git repo, run the classifier, assert situation + recommended + action set. Cases (one per situation at minimum):

- `no-project` — empty cwd → situation `no-project`, recommended `new-project`, actions include `map-codebase`.
- `paused` — STATE.md with `paused_at` set → situation `paused`, recommended `resume-work`.
- `blocked` — STATE.md with blockers → situation `blocked`, recommended `debug`.
- `verify-failed` — latest summary `STATUS: blocked` → situation `verify-failed`.
- `needs-first-phase` — STATE.md present, `total_phases: 0` → situation `needs-first-phase`.
- `planning` / `executing` / `verify-pending` — respective `status` values.
- `idle-stranded` — clean tree + unpushed commits → situation `idle-stranded`, recommended `ship`.
- `complete` — current ≥ total, status complete → situation `complete`, recommended `new-milestone`.
- `unknown` — malformed state → situation `unknown`, recommended `progress`.
- **Priority ordering** — a STATE.md that is both paused AND blocked resolves to `paused` (earlier row wins).
- **JSON shape** — `actions[].command` always starts with `/gsd:`; exactly one action has `recommended: true`.

### `tests/gsd-workflow.structure.test.cjs` (NEW)

Invariants over the markdown layer (these are structural/format assertions on shipped artifacts, not source-grep of logic — permitted since they test the *contract* the workflow exposes):

- `commands/gsd/next.md` exists with frontmatter `name: gsd:next`, no `requires` field, `allowed-tools` includes `AskUserQuestion`.
- `gsd-core/workflows/smart-entry.md` exists and is **under 32 KiB** (NEW_FILE_CAP).
- Every `command` string referenced by the classifier's action table resolves to a real existing slash command file in `commands/gsd/` (guard against dead routes).
- The workflow contains the TEXT_MODE fallback clause and the shim-resolution block (contract assertions).
- The workflow dispatches exactly one command and then stops (no inline execution).

### Coverage & baseline

- The new `.cjs` enters the `c8` coverage gate (`--lines 70 --branches 60`).
- After adding `workflows/smart-entry.md`, run `npm run size:baseline` to update `tests/workflow-size-baseline.json`; justify the new entry in the PR.

---

## File changes

| file | change | size budget |
|---|---|---|
| `src/smart-entry.cts` | NEW — detection + classifier; `--json` + human output | — |
| `gsd-core/bin/lib/smart-entry.cjs` | generated by `build:lib` (gitignored) | — |
| `gsd-core/bin/gsd-tools.cjs` | add `case 'smart-entry':` (~2 lines) | — |
| `commands/gsd/next.md` | NEW — thin dispatcher command (`name: gsd:next` → `/gsd-next`) | small |
| `gsd-core/workflows/smart-entry.md` | NEW — presentation + dispatch | < 32 KiB |
| `tests/smart-entry.unit.test.cjs` | NEW — classifier behavior | — |
| `tests/gsd-workflow.structure.test.cjs` | NEW — markdown-layer invariants | — |
| `tests/workflow-size-baseline.json` | regenerate via `npm run size:baseline` | — |
| `docs/superpowers/specs/2026-06-27-gsd-smart-entry-design.md` | this document | — |

No existing command or workflow is modified. No new npm dependencies.

---

## Open questions for implementation

None blocking. Two noted for the implementer's judgment (not spec-level):

1. **`idle-stranded` threshold** — 72h hardcoded for v1. If brittle in practice, relax to "unpushed commits only" (drop the staleness clause).
2. **Action label wording** — exact strings are an implementation/tuning detail; the contract is `id` + `command`.

---

## Success criteria

- [ ] `gsd-tools smart-entry --json` classifies all 10 situations + `unknown` correctly from fixtures.
- [ ] `/gsd` in a real project shows a situation-appropriate menu and dispatches the chosen command.
- [ ] `/gsd` pre-project offers `new-project`.
- [ ] `/gsd` works under TEXT_MODE (no `AskUserQuestion`).
- [ ] Any `smart-entry` failure falls back to `/gsd-progress` without erroring.
- [ ] New workflow under 32 KiB; `size:baseline` updated; coverage gate passes.
- [ ] No new dependencies; no existing command modified.

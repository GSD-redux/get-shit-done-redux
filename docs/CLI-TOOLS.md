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


| Flag                | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `--raw`             | Machine-readable output (JSON or plain text, no formatting)                  |
| `--cwd <path>`      | Override working directory (for sandboxed subagents)                         |
| `--ws <name>`       | Workstream context for `.planning/workstreams/<name>` paths |
| `--pick <field>`    | Extract one field from a command's JSON output — see [`--pick <field>` contract](#--pick-field-contract) below |


---

### `--pick <field>` contract

`--pick <field>` runs `<command>` as normal, parses its stdout as JSON, and
extracts one field by name (dotted paths and `[N]` array indices are
supported, e.g. `a.b.c`, `directories[-1]`). As of ADR-3473 §8.4 / #3884, the
three possible outcomes are distinguished **by exit code**, never by an
ambiguous empty string:

| Outcome | stdout | stderr | Exit code |
| --- | --- | --- | --- |
| Field present | The field's value, coerced to a string | (none) | `0` |
| Field absent (missing key, out-of-range index, dotted path partially missing, or a non-object JSON root) | empty | Diagnostic naming the field and the available top-level keys (or the actual JSON root type) | `1` (`pick_field_absent`) |
| Command output is not JSON (including `--raw` output, which is plain text/human-readable, not JSON) | empty | Diagnostic saying the output was not JSON | `1` (`pick_output_not_json`) |

A `null` or empty-string (`''`) field value is a real answer, not an absence
— it still prints (an empty line) at exit **0**. Only the *absence of the
field itself* is a failure. This is why `--raw` and `--pick` are, in
practice, mutually exclusive: `--raw` output is not JSON, so combining them
always hits `pick_output_not_json`.

**This replaces the previous behavior.** Before #3884, an absent field (or
non-JSON output) silently printed an empty string at exit `0` — indistinguishable
from a field that genuinely held `null` or `''`. That coercion is gone. The
common shell idiom

```bash
X=$(gsd_run query some.command --pick some_field 2>/dev/null) || X=default
```

now works as written: the `|| X=default` arm fires exactly when the field
could not be resolved, and never fires merely because the resolved value
happens to be empty.

---

## State Commands

Manage `.planning/STATE.md` — the project's living memory.

```bash
# Load full project config + state as JSON
node gsd-tools.cjs state load

# Output STATE.md frontmatter as JSON
node gsd-tools.cjs state json

# Update a single field. Frontmatter keys are projections of body fields —
# write the body field (see COMMANDS.md#state-update-field-value).
node gsd-tools.cjs state update <field> <value>

# Get STATE.md content or a specific section
node gsd-tools.cjs state get [section]

# Batch update multiple fields
node gsd-tools.cjs state patch --field1 val1 --field2 val2

# Increment plan counter
node gsd-tools.cjs state advance-plan
# When no labeled plan position can be parsed (e.g. ## Current Position drifted
# to pure narrative prose), declines with reason "plan_position_unreadable" plus
# the disk-derived counts and the exact labeled lines to re-insert; STATE.md is
# left byte-identical.

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

Read-only situation classifier used by `/gsd-next`.

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

# Archive (or, with --force, permanently delete) every current phase directory —
# used by /gsd-new-milestone before roadmapping the next cycle
node gsd-tools.cjs phases clear [--confirm] [--force] [--archive-version <version>]
```

### Milestone-scoped phase listing (`phases list`)

The bare `phases list` (no `--phase`, no `--include-archived`) is scoped to the
current milestone's `ROADMAP.md` window **and** filtered through the canonical
sentinel predicate: `999.*` backlog directories and `0-*` pre-milestone
directories are not listed as current-milestone phases. `--phase <N>` (a direct
lookup) and `--include-archived` (an archive listing) are deliberately **not**
scoped or sentinel-filtered — they answer "does this phase exist" and "what has
ever existed here," not "what belongs to this milestone," so they still see
sentinel and out-of-window directories.

### `phases clear` and sentinel directories

`phases clear` moves (or, with `--force` and no prior archive, permanently
deletes) every phase directory under `.planning/phases/` except sentinels. It
now excludes both `999.*` (backlog) and `0-*` (pre-milestone) directories via
the same canonical sentinel predicate `phases list` uses — previously its own
regex excluded `999` but not `0`, so a `0-*` directory could be destroyed on
this irreversible path.

### `find-phase` plan/summary counts (live vs physical)

`find-phase`'s JSON carries the existing `plans[]` / `summaries[]` arrays
**unchanged**, plus three additive scalar fields:

| Field | Set | Answers |
|---|---|---|
| `plan_count` | live — `status: superseded` plans excluded | "how much outstanding work is left in this phase?" (same set as `plans[]`) |
| `summary_count` | live | same, for `summaries[]` |
| `plan_count_all` | physical — every canonically-named plan file on disk, superseded included | "what has the planner actually written to disk?" |

Naming mirrors `roadmap analyze`'s existing `plan_count`/`summary_count`, and the
`_all` suffix echoes the underlying `scanPhasePlans` field it is drawn from.
**Pick by the question you're asking, not by which number looks bigger:** a
phase where every plan is `status: superseded` correctly reports `plan_count: 0`
— that is a real "nothing outstanding" answer, not a bug — while
`plan_count_all` still reports the physical count, so a check for "did the
planner produce anything at all" doesn't misread a fully-superseded phase as
untouched.

When the phase can't be resolved, all three fields are `null`, not `0` — a
fabricated `0` would read identically to a genuinely empty phase.

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

### `phase-plan-index`: unresolved `depends_on` tokens (ADR-3473 §8.5, #3427/#3885)

A plan's `depends_on:` token must resolve to another plan in the same phase (by
exact id or by canonical id). When a token resolves to neither, the edge is
dropped and the dependent plan becomes a DAG root — `phase-plan-index` now
names this in `warnings[]` instead of silently discarding it:

```text
Plan 03-02: depends_on token "typo-plan-id" does not resolve to any plan in this
phase — edge dropped, wave placement for this plan may be unreliable
```

The token is escaped (quoted, control characters and embedded newlines
backslash-escaped) before it is embedded in the warning, so a `depends_on`
value crafted to contain a newline or a quote cannot forge a second,
fabricated warning entry when `warnings[]` is printed one-per-line.

**The wave-mismatch warning is suppressed for an affected plan.** Normally a
plan whose declared `wave:` disagrees with the computed DAG wave gets its own
warning (`"declared wave: N but depends_on DAG places it in wave M"`). When
the disagreement is caused by a dropped edge on that same plan, that warning
would blame the author for a mismatch the tool itself manufactured by losing
an edge — so it does not fire for that plan; the unresolved-token warning above
stands in its place. A plan with **no** dropped edges and a genuinely wrong
`wave:` still gets the mismatch warning as before.

This does not repair `waves` / `wave` themselves — those fields stay computed
from the DAG with the edge missing, since the edge cannot be invented. A
consumer using `wave` for scheduling (`WAVE_FILTER`, the wave-safety check)
is still working from the degraded assignment; only the diagnostic surfaces
the loss.

### The ROADMAP `**Requirements**:` line grammar

`phase complete` reads each phase's `**Requirements**:` line to decide which
REQ-IDs to mark. The grammar is deliberately small, and it is documented here
because the command now warns about it (#3697) — a warning about a rule that
cannot be looked up is not actionable.

**The canonical form is a comma-separated list of REQ-IDs.** Square brackets are
optional; a REQ-ID is `PREFIX-N`, where the prefix is a letter followed by
letters or digits. Two tolerances are worth knowing because the warnings below
do **not** fire on them: the line is split on commas *and whitespace*, so
`REQ-01 REQ-02` selects both; and the ID shape is matched case-insensitively,
so `req-01` is selected and marked. Write the comma list anyway — it is what
every template and every example uses — but neither spelling is an error:

```
**Requirements**: REQ-01, REQ-02, REQ-03
**Requirements**: [REQ-01, REQ-02, REQ-03]
```

**Ranges are not expanded** — `REQ-01 … REQ-05` selects the two endpoints and
nothing between them, and `REQ-01..REQ-05` selects nothing at all, because the
whole token fails the ID shape. This is a deliberate non-feature, not an
oversight: the line is a traceability record, and silently inventing IDs that
appear nowhere in `REQUIREMENTS.md` is worse than declining to.

**A deliberately empty line is written `TBD` or `None`.** Those two words are
the placeholder vocabulary, and they are matched as the line's leading token, so
`None (per ADR-7)` and `**None**` are declared-empty too. **Any other wording
that selects no REQ-IDs warns** — `Deferred`, `N/A`, `Pending`, `TBA`, a bare
`-`, or free prose — because from the command's side an unrecognised word is
indistinguishable from a line that was meant to cite requirements and failed
to. A line whose only content is an HTML comment is not "other wording" and
stays silent, so the shipped template's own `<!-- ... -->` does not warn.

**Write each requirement as a bare ID, separated by a comma.** The line is
split on commas and whitespace only, and nothing else is stripped, so anything
attached to an ID takes the ID with it. `REQ-01; REQ-02` marks **only**
`REQ-02`; so do `REQ-01 ;REQ-02`, `**REQ-01;** REQ-02` and an ID carrying a
stray invisible character. Those are the cases the warning names — it reports
the dropped ID, because this is the quietest way to lose a requirement here
(the command reports `requirements_updated: true` either way).

**What the warning does NOT reach.** Stated so its silence is not read as a
clean bill, and enumerated rather than summarised, because each of these is a
requirement that goes missing without a word. The check fires only when the
thing touching the ID is a `;`, a `:`, or an invisible character:

- **Markdown styling on its own is silent.** `**REQ-01**, REQ-02` drops
  `REQ-01` and says nothing at all. Styling is not evidence that a separator
  was meant. `**REQ-01**; REQ-02` is silent for the same reason — the `**`
  sits between the ID and the `;`, so nothing is touching the ID.
- **Any other attached punctuation is silent.** `REQ-01/ REQ-02`,
  `REQ-01| REQ-02`, `REQ-01. REQ-02`, `REQ-01+ REQ-02`, `REQ-01> REQ-02` and
  their full-width and non-ASCII equivalents (`；`, `，`, `؛`) each mark only
  `REQ-02`. A fully crossed sweep — 21 separators against bare, leading-space,
  trailing-space and both-spaces spellings, 84 combinations — found **34**
  silent under-selections, every one of them a separator glued to exactly one
  of the two IDs. Only `;` and `:` are in the set. Widening it is a live
  option — say the word — but each past widening of this check first fired on
  a citation, so it is not done blind.
- **A dropped ID whose prefix matches nothing selected is silent.**
  `REQ-01, REQ-02: login` is reported; `REQ-01, FOO-02: x` is not. A citation
  is textually identical to a dropped requirement — `REQ-01, see ADR-7:
  section 3` carries `ADR-7:` in exactly the shape `REQ-01;` has — and prefix
  agreement is the only thing that separates them without guessing at prose.
  Anything inside matched parentheses is left alone for the same reason:
  `(see ADR-7: section 3)` is a citation.

The prefix gate is not complete in the other direction either: a citation that
*shares* a selected prefix — `REQ-01, see REQ-7: sec 3` — does warn, naming
`REQ-7` as dropped. Nothing at the token level separates that from a real
drop.

**Dash spellings need a full ID on both sides.** `REQ-01-REQ-05` reads as a
range; `REQ-01-05` does not, and neither does any of its typographic variants
(en dash, em dash, minus sign, and the rest). The reason is that
`PREFIX-<digits><dash><digits>` is also a date (`FY-2026-08`) and a sub-numbered
ID (`API-2-01`), so warning on it would be noise on lines that are perfectly
correct. `..`, `…`, `to`, `thru` and `through` have no such reading and do
accept a bare numeric endpoint (`REQ-01..05`). The cost is that
`REQ-01, REQ-02-05` is not reported; a bare `REQ-02-05` still is, because it
selects nothing.

**What warns, and in which of the three voices.** All go to `warnings[]` and
none blocks completion:

- *"could not be parsed as a comma-separated REQ-ID list"* — the line did not
  yield the requirements it appears to name. That covers two cases, and the
  message says which one it is: ID-shaped text on the line was **not**
  selected, so something was demonstrably dropped; **or** the line selected
  nothing at all while not being a `TBD`/`None` placeholder, in which case
  there may be no ID-shaped text on it whatsoever (`Deferred` takes this
  voice). Either way nothing was marked and the line needs fixing.
- *"contains what reads as a range between two cited REQ-IDs"* — the separator
  is the only thing in question: a separator between two cited IDs could equally
  be a range or an annotation, and the command cannot tell them apart, so it
  states both readings rather than asserting a failure that may not have
  happened. It speaks about the **separator**, not about the whole line. It is
  also the *weakest* of the three claims, so it yields to the other two: a
  demonstrated drop elsewhere on the line makes it a misparse, and an
  unexamined over-cap token makes the line unverified — a voice whose claim is
  that nothing was dropped cannot speak over a token no rule read.

**Each warning carries a machine-readable kind.** The prose goes to
`warnings[]` as before — that field is unchanged and is still an array of
strings — and the kind is emitted beside it as `requirements_line_warning`,
one of `req-line-misparse`, `req-line-range-reading` or `req-line-unverified`.
The field is absent entirely when the line is clean. Key on the kind rather
than on the wording; the wording is free to improve.

Either of those two voices may add a factual note naming **ID-shaped text on the
line that was not selected**. Square brackets *are* stripped — `[REQ-01, REQ-02]`
is the documented form — but parentheses are not, so `(REQ-02)` is not marked.
The command cannot tell that from `(ADR-7)`, which is a citation and correctly
ignored, so it names what it skipped and leaves the judgement to you. Where the
skipped text is `PREFIX-<digits>-<digits>` — the shape the dash rule above
declines to adjudicate, because `FY-2026-08` is a date and `API-2-01` is a
legal requirement id and no rule separates them — it is still named, with that
ambiguity stated alongside it. Naming it and saying why it is ambiguous beats
both alternatives: filtering it hides a real dropped requirement, and reporting
it bare asks you to check whether a date is a requirement.
The third voice is for input the command could not examine: *"could not be
checked ... the REQ-ID selection on this line is unverified"*. Range detection
is bounded at 2,048 characters per token, so a longer token is not classified —
and unclassified is reported, never treated as clean. Selection itself is *not*
bounded, so a valid REQ-ID longer than that is still selected and marked
normally; it only triggers this voice if something beside it could have formed a
range with it, which is the case where the bound actually suppressed a check.

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

### Milestone window scope (`roadmap analyze`)

`roadmap analyze` scopes its phase list to the current milestone's section of
`ROADMAP.md`. Its JSON output carries a `scope` field describing how much of the
intended input that scoping actually saw:

| `scope` | Meaning |
|---|---|
| `complete` | The window was computed over the whole intended input. `phase_count: 0` here is a **real** answer — a freshly-declared milestone genuinely has no phases yet. |
| `truncated` | The milestone's heading was found, but its window closed before reaching the document's phase region — typically because a closed-milestone heading sits between the active milestone and its `### Phase N:` sections. `phase_count: 0` here is a **non**-answer. |
| `unscoped` | No milestone version could be resolved (or its section is absent) on a ROADMAP that does use versioned milestones, so the result is not milestone-scoped. |
| `unreadable` | `ROADMAP.md` could not be read. |

Before this field existed, all four cases produced the same well-formed
`phase_count: 0` with no error, so a consumer could not tell a genuinely empty
milestone from a scoping failure. Branch on `scope`, not on `phase_count` alone.

A ROADMAP with no versioned milestone headings at all (the free-form legacy
shape) reports `complete`: the whole document *is* the milestone there. Note
this answer is specific to *windowing* — see the next section for why milestone
*identity* answers the same document differently.

### A non-`COMPLETE` scope withholds the percentage entirely (#3217)

`roadmap analyze --json`'s `progress_percent`, `stats --raw`'s `percent` /
`plan_percent`, `query progress --raw`'s `percent`, and `state json --raw`'s
`progress.percent` are now **nullable** — a Tier-2 contract change. When the
phase set a percentage would be computed from is not fully trustworthy (any
scope other than `complete`), these surfaces render **no percentage at all**
rather than a number computed from a truncated, unscoped, or unreadable set:

| Surface | Non-`complete` behavior |
|---|---|
| `roadmap analyze --json` | `progress_percent: null` |
| `stats --raw` | `percent: null`, `plan_percent: null` |
| `query progress --raw` | `percent: null` |
| `state json --raw` | `progress.percent` is **omitted** from the `progress` object (not `0`, not present as `null`) |
| `state update-progress --raw` | `false` — no write; `STATE.md`'s Progress field is left untouched, and a `[gsd-tools] WARNING:` line is written to stderr naming the scope |

`0` is a legitimate, real answer under a `complete` scope (e.g. a
freshly-declared milestone with zero phases, or a phase with zero plan files)
and is never withheld — only a non-`complete` scope withholds.

`roadmap analyze --json` gates `total_plans` / `total_summaries` / `phases` /
`completed_phases` on the top-level `scope` field described above (heading
windowing identity), but `progress_percent` is governed by a **separate**
`progress_scope` field — the scope of the phase-directory set the percentage
was actually computed from. The two can legitimately disagree (e.g.
`scope: "complete"` — the ROADMAP heading resolves fine — alongside
`progress_scope: "unreadable"` when `.planning/phases` itself cannot be read),
so a consumer must branch on `progress_scope`, not `scope`, to know why
`progress_percent` is `null`.

### Milestone identity (which milestone, and what it is called)

Milestone identity — the version and name behind `STATE.md`'s `milestone:`
field, `roadmap analyze`'s `milestones[]` array, and the milestone shown by
`query progress`, `stats`, `init manager`, `validate health` and
`workstream create` — is resolved by one implementation:

- `STATE.md`'s `milestone:` field selects the version when present. The ROADMAP
  heuristics are the fallback, not the primary.
- The heading is located by the same canonical locator that computes the
  milestone window, so a `### Phase N: …` heading is **never** read as the
  milestone heading — even when it mentions a version. Previously a ROADMAP
  whose phase heading preceded its milestone heading could write a wrong
  `milestone:` to disk.
- The **name** is the heading text after that heading's own version token, with
  one leading delimiter (`—`, `–`, `:`, `-`) and any trailing `✅`/`📋`/`🚧`
  marker removed. Parentheses are ordinary characters: a milestone named
  `v3.3 — Portability (Windows)` keeps its full name rather than being cut at
  the `(`.
- When identity **cannot** be determined it is reported as absent rather than
  defaulted. A free-form legacy ROADMAP with no version anywhere is `unscoped`
  with no identity — unlike windowing above, there is no version token to
  report, and inventing one would be indistinguishable from a real answer.

Two consumers act on that distinction rather than just displaying it:
`state sync` / `state record-session` write `null` instead of a fabricated
`milestone:`/name, and `phases clear` falls back to its dated archive label
(`archived-<YYYYMMDD>`) instead of filing phase history under a fabricated
`milestones/<version>-phases/` directory.

### `milestone complete` refuses an untrustworthy window

`milestone complete` archives `ROADMAP.md`/`REQUIREMENTS.md` and **moves phase
directories** — a one-way door. When the milestone window's `scope` is
`truncated` — the milestone heading was found but its section closes before
reaching any phase entries, even though the ROADMAP has phase entries
elsewhere — phase scoping cannot be trusted, and the command now refuses
rather than falling back to an over-inclusive filter that would archive every
phase directory in the project. `unreadable` (no ROADMAP.md at all) and
`unscoped` (no section for this version) are pre-existing, legitimately
handled states and are not refused here. Pass `--force --confirm` to override, the same
affordance the unstarted-phase guard uses (`--confirm` is required for any mutating run —
#3726; `--force` alone does not imply it).

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

Read-only detector for claude-code's experimental agent-teams feature (issue #1355). Resolves the runtime via the canonical `GSD_RUNTIME` → `config.runtime` → per-install runtime marker → `'claude'` precedence (#3897), then checks `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.

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

### `query context-predicates`

```bash
node gsd-tools.cjs query context-predicates --class <CLASS> | --prefix <dotted.prefix> | --contains <text>
```

Selector surface for the `CONTEXT.md` predicate fact-store (ADR-1671, #2928). Parses the repo-root `CONTEXT.md` **live** on every call via the compiled `context-predicates.cjs` — it never reads the committed `docs/CONTEXT-INDEX.json` (that artifact is a CI drift-guard byproduct, not a query source, so it can never go stale relative to the live predicates it answers about).

**Selectors** (at least one required; when more than one is given they are ANDed together):

| Flag | Type | Description |
|---|---|---|
| `--class <CLASS>` | string | Exact match on the predicate's class (the segment before the first `.`) |
| `--prefix <dotted.prefix>` | string | Match predicate ids starting with this dotted prefix |
| `--contains <text>` | string | Case-insensitive substring match against `id + ' ' + value` |

Each flag also accepts the inline-assignment form (`--contains=<text>`), which is the escape
hatch for a flag-shaped value the space-separated form cannot express — e.g.
`--contains=--dry-run` to search for the literal substring `--dry-run`. The space-separated form
(`--contains --dry-run`) always reads a following `--...` token as a missing value, by design.

**Output JSON:**

```json
{
  "matched": 2,
  "predicates": [
    { "id": "RULESET.EXAMPLE", "klass": "RULESET", "value": "…", "line": 42, "section": "Glossary" }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `matched` | number | Count of predicates satisfying all given selectors |
| `predicates` | array | Each entry is a live `Predicate` — `id`, `klass`, `value`, `line` (1-based source line), `section` (nearest enclosing heading) |

This command is strictly read-only — no config writes, no disk mutation. See [ADR-1671](adr/1671-dynamic-context-management-platform.md) and [Architecture — CLI Tools](ARCHITECTURE.md#cli-tools-gsd-corebin).

---

## Intel Commands

```bash
node gsd-tools.cjs intel query <term>
```

Searches every JSON intel file under `.planning/intel/` (keys and values, including
`arch-decisions.json`) for `<term>`. No-ops with `{ enabled: false }` when the `intel`
capability is not active (`intel.enabled` in config).

**Output JSON:**

```json
{ "matches": [{ "source": "file-roles.json", "entries": [...] }], "term": "…", "total": 3, "truncated": false }
```

| Field | Type | Description |
|---|---|---|
| `total` | number | Count of matched entries across every intel file |
| `truncated` | boolean | `true` when the recursive walk of at least one intel file hit the 48-level depth ceiling before finishing — see below |

### The 48-level recursion ceiling and `truncated` (ADR-3473 §8.5, #3885)

The search recurses into nested objects/arrays up to **48 levels deep** (the bound is on
depth, not breadth or total node count — a wide-but-shallow structure is unaffected). A
match at or above the ceiling is not returned, and `truncated` is set to `true` on the
result so a caller can tell "I stopped looking" apart from "there is no match here."

`truncated: false` means the walk reached the bottom of every branch it visited — it does
**not** by itself mean anything was found; check `total` for that. Before this fix, a
search past the ceiling threw an uncaught `RangeError: Maximum call stack size exceeded`
instead of returning a diagnosable result; a shallower search (depth ≤ 48) is unaffected
and its result is unchanged.

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

`verify key-links` confines each link's `from:`/`to:` to the project directory (#3493): a path that resolves outside the project (via `../` traversal, an absolute path, or a symlink) is never read. That link's `links[]` entry reports `path_rejected: "from"` or `path_rejected: "to"` (whichever field was rejected) alongside `verified: false`, without echoing the underlying path-confinement error (which would embed an absolute host path). A rejected link fails independently — it does not abort evaluation of the other links in the same plan, and does not set `path_rejected` on links whose paths resolve inside the project.

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

`validate consistency`'s `warnings` entries are coded diagnostics (`{code, message, fix, repairable}`), not bare strings. A phase declared in ROADMAP.md with no directory on disk, or a directory on disk with no ROADMAP.md entry, reports under `W006`/`W007` — the same codes `validate health` uses for the identical check, since it's one enumeration with two callers, not a separate check. The four subjects unique to this command (numbering gaps in phases or plans, orphan `*-SUMMARY.md` files, plans missing `wave` frontmatter) use a new `C0NN` code range (`C001`-`C004`).

`validate context` emits a structured envelope with `utilization`, `status`
(`ok` / `warn` / `critical` at the 60 % / 70 % thresholds), and a
`suggestion` string. The same data backs `/gsd-health --context`.
Pass `--json` to receive the typed IR directly (useful in scripts and test assertions).

---

## Planning Snapshot Commands

### `planning inspect`

Emits a read-only, schema-versioned snapshot of everything `.planning/` knows,
as one JSON document. It exists so a downstream tool — a harness UI, a
mission-control view, a dashboard — can consume planning state without parsing
`ROADMAP.md` / `REQUIREMENTS.md` / `*-PLAN.md` / `*-SUMMARY.md` a second time
and drifting from gsd-core's own answers.

```bash
gsd-tools query planning inspect
gsd-tools query planning.inspect     # dotted canonical form — identical output
```

**Takes no arguments.** A stray positional or an unrecognized flag is a
fail-loud usage error, not a silently-ignored one: a caller who believed
`--phase 3` was scoping the query would otherwise receive a whole-project
snapshot presented as a scoped one.

`planning inspect` writes nothing, anywhere. It is safe to run against a
project mid-workflow.

#### The schema contract

```json
{ "schema_version": 1, "...": "..." }
```

`schema_version` is the contract. **A consumer must reject any value other than
the one it was written against** rather than best-effort-parsing a shape it does
not know. Every top-level key is always present; a key is never omitted to
signal absence, because omission is itself something callers come to depend on.

| Key | What it carries |
|-----|-----------------|
| `schema_version` | Always `1` today |
| `generated_from` | Resolved `cwd` and `.planning/` root (`null` when there is no planning root) |
| `milestone` | `version`, `name`, and the `scope` of that answer |
| `active` | `phase`, `plan`, and `status` — three distinct STATE.md facts, each scoped separately |
| `phases[]` | Per phase: completion, verification, roadmap acceptance, UAT, plan and task rows |
| `orphan_phase_dirs[]` | Directories under `phases/` that the current milestone window does not declare |
| `requirements[]` | Requirement rows with mapped-phase traceability |
| `progress` | `accepted_phases` and `completed_plans`, as independent fractions |
| `diagnostics[]` | Coded reasons for every non-answer above |

#### Three kinds of evidence, never folded together

Each phase reports `verification`, `roadmap_acceptance`, and `uat` **side by
side**. They are not combined into a single verdict, because they answer
different questions and can legitimately disagree — a phase can pass
verification while UAT items remain open.

`roadmap_acceptance.checkbox` is reported with `authoritative: false`. A ticked
ROADMAP checkbox is a human annotation with no machine authority: completion is
derived from disk state (a passing `*-VERIFICATION.md`), and a stale tick never
overrides it. See [Milestone window scope](#milestone-window-scope-roadmap-analyze).

#### Unknown is a real answer; nothing is inferred

Where the evidence is absent, or where two sources disagree, the value is `null`
or `"unknown"` and a coded entry in `diagnostics[]` says why. It is never
reconciled, guessed, or filled from a plausible default.

The most common case is task-scoped file provenance. A `<task>` block declares
the files it plans to touch, but `SUMMARY.md`'s `## Files Created/Modified`
section describes the **whole plan**, not an individual task. Spreading that
plan-level list across the plan's tasks would be inference, so instead:

| `provenance` | Meaning |
|---|---|
| `task_scoped` | The summary attributed files to this specific task (via a deviation block naming `Found during: Task N`) |
| `plan_scoped` | A summary exists, but only carries a plan-level file list — this task's changed files are unknown |
| `absent` | No summary exists yet |

When a task's planned and changed file sets both exist and disagree,
`agreement` is `"conflicting"` and **both lists are emitted verbatim**.

#### Percentages are withheld rather than guessed

`progress.accepted_phases` and `progress.completed_plans` are independent
fractions, each `{completed, total, percent, scope}`. `percent` is `null`
whenever `scope` is anything other than `complete` — the same rule the roadmap
and progress surfaces follow, for the same reason. See
[A non-`COMPLETE` scope withholds the percentage entirely](#a-non-complete-scope-withholds-the-percentage-entirely-3217).

`0` is a real answer under a `complete` scope and is never withheld.

#### Large payloads

Output over ~50 KB is written to a temp file and returned as
`@file:<path>`, which `gsd-tools` resolves transparently before writing to
stdout — the same channel `init` uses. Callers see JSON either way.

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
node gsd-tools.cjs init code-review <phase> [--fix]
node gsd-tools.cjs init review <phase>
node gsd-tools.cjs init discuss-phase-assumptions <phase> [--auto]
node gsd-tools.cjs init todos [area]
node gsd-tools.cjs init milestone-op
node gsd-tools.cjs init map-codebase
node gsd-tools.cjs init progress
node gsd-tools.cjs init manager
node gsd-tools.cjs init complete-milestone
node gsd-tools.cjs init autonomous [--converge] [--cross-ai]
node gsd-tools.cjs init docs-update
node gsd-tools.cjs init update [--next] [--rc]
node gsd-tools.cjs init transition

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
node gsd-tools.cjs milestone complete <version> (--confirm | --dry-run) [--name <name>] [--no-archive-phases] [--force] [--archive-quick]

# Archive .planning/quick/* into milestones/<version>-quick/ WITHOUT the milestone complete close-out (#2142)
node gsd-tools.cjs milestone archive-quick <version> [--dry-run]

# Mark requirements as complete
node gsd-tools.cjs requirements mark-complete <ids>
# Accepts: REQ-01,REQ-02 or REQ-01 REQ-02 or [REQ-01, REQ-02]
```

**`milestone complete` flags**

| Flag | Description |
|------|-------------|
| `<version>` | Milestone version label to archive (e.g. `v1.0`). |
| `--confirm` | **Required to mutate (#3726).** The archive is irreversible — ROADMAP.md/REQUIREMENTS.md archived, phase directories MOVED, STATE.md rewritten — so without this flag the command refuses and changes nothing (exit 1, with a message naming both `--confirm` and `--dry-run`). Not implied by `--force`, which only overrides the guards below. |
| `--name <name>` | Display name for the MILESTONES.md entry. Defaults to `<version>`. |
| `--no-archive-phases` | Leave phase directories in place instead of moving them into `.planning/milestones/<version>-phases/`. |
| `--archive-quick` | Opt-in (default OFF, #2142): also move every directory under `.planning/quick/` into `.planning/milestones/<version>-quick/`, (re)write that archive directory's `README.md` index, and clear STATE.md's `### Quick Tasks Completed` table rows. See "`milestone archive-quick`" below for the narrower standalone form and the full behavior. |
| `--force` | Override the unstarted-phase guard (see below). |
| `--dry-run` | Print the archive plan (roadmap, requirements, phases, and — when `--archive-quick` is also passed — quick-task dirs to move) without mutating anything. |

**Unstarted-phase guard.** Before archiving, the command scans the ROADMAP scoped for `<version>` and refuses if any `### Phase N:` heading in that slice has no matching phase directory on disk (`disk_status: no_directory`). Phase 0 (pre-milestone) and Phase 999 (backlog) sentinels are excluded. The guard runs whenever `--force` is absent, independent of `STATE.md`'s `milestone:` field — if that field is present but does not match `<version>`, a WARNING naming both values is emitted to stderr and the scan still runs (#2946). Pass `--force --confirm` to override (`--confirm` is required for any mutating run — #3726; `--force` alone does not imply it).

**Sentinel directories are never archived.** The phase-directory move performed when `--no-archive-phases` is absent is now filtered through the same canonical sentinel predicate as `phases list` and `phases clear`: `999.*` (backlog) and `0-*` (pre-milestone) directories are left in place rather than moved into `.planning/milestones/<version>-phases/`. Previously this path was scoped only by the milestone window, with no sentinel filter, so a sentinel directory sitting inside the window could be archived along with the milestone's real phases.

**`milestone archive-quick` (#2142 escalation)**

A narrower sibling of `milestone complete --archive-quick`, for callers that need to sweep `.planning/quick/*` WITHOUT the full milestone close-out — chiefly `gsd-core/workflows/cleanup.md`, which runs against milestones that are typically already completed.

| Flag | Description |
|------|-------------|
| `<version>` | Milestone version label to archive quick-task directories under (e.g. `v1.0`). Same validation as `milestone complete`'s `<version>` — letters/digits/`.`/`-`/`_` only, no path separators or `..`. |
| `--dry-run` | List what would move (`would_archive`) without mutating anything. |

It moves every directory under `.planning/quick/` into `.planning/milestones/<version>-quick/`, (re)writes that archive directory's `README.md` index, and clears STATE.md's `### Quick Tasks Completed` table rows — the same move/index/reset logic `milestone complete --archive-quick` uses. Unlike `milestone complete`, it never archives `ROADMAP.md`/`REQUIREMENTS.md`, never writes a `MILESTONES.md` entry, and runs neither the unstarted-phase guard nor the milestone-window refusal — so, unlike `milestone complete --archive-quick`, it can be safely re-run against an already-completed milestone. JSON result: `{ version, archived, entries, archive_dir, state_updated, warnings }`.

`milestone archive-quick` is a second subcommand of `milestone` (alongside `complete`) — it is not a separate top-level command.

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
# Optional (#3356) — supply a real quick id and task directory to write the canonical row the
# `/gsd-quick` workflow itself renders, instead of a positional `#` and an em-dash `Directory`:
node gsd-tools.cjs quick-tasks-append --task "<description>" --quick-id <id> --slug <slug>
node gsd-tools.cjs quick-tasks-append --task "<description>" --directory "[<id>-<slug>](./quick/<id>-<slug>/)"
# All three flags are optional. Omit them (as `fast.md` does, having neither an id nor a task
# directory) and the emitted row is byte-identical to the pre-#3356 behavior. `--directory` wins
# outright when given; otherwise `--quick-id` + `--slug` together derive the permalink.
# This append touches only the body table — it no longer forces a re-derive of the disk-derived
# `progress.*` frontmatter, which previously overwrote curated values (#3356).
# See "Milestone Commands" below for `milestone archive-quick` (#2142) — sweeps .planning/quick/* into
# milestones/<version>-quick/ and clears this table, without a full `milestone complete`.

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
```

Both `stats` and `progress` are scoped to the current milestone's `ROADMAP.md`
window and sentinel-filtered: `999.*` backlog directories and `0-*`
pre-milestone directories are not counted as current-milestone phases, and the
aggregate completion percentage no longer reads `100` while phases from the
active window are still outstanding.

On a project explicitly configured with `phase_id_convention: "bracket"`, both
JSON surfaces keep the phase's bare join key in `phases[].number` and add its
canonical human label in `phases[].display_id` (for example,
`{"number":"05.03","display_id":"[GSD.02] 05.03"}`). Their
`milestone_version` and table headings use `[GSD.02]` rather than the legacy
`v2.0` marker. Other conventions retain their prior object and table shapes.

```bash
# Complete a todo
node gsd-tools.cjs todo complete <filename> [--dry-run]
```

`--dry-run` previews the completion (a `dry_run`/`would_*` JSON payload naming
the source, the destination, and the frontmatter keys it would set) without
moving the file or touching anything on disk. A real completion moves the todo
from `todos/pending/` to `todos/completed/` and upserts `completed:` and
`status: completed` inside the file's frontmatter block. Unknown flags are
rejected loudly.

```bash
# UAT audit — scan all phases for unresolved items
node gsd-tools.cjs audit-uat

# Cross-artifact audit queue — scan `.planning/` for unresolved audit items
node gsd-tools.cjs audit-open [--json]

# Suppress one open audit item — writes a self-invalidating `audit_acknowledged`
# marker; never overwrites the artifact's own `status:` (except `deferred_items`,
# where the marker IS the entry's `status:`). See docs/COMMANDS.md's
# `/gsd-complete-milestone` entry for the full per-category identifier flag table.
node gsd-tools.cjs audit-open acknowledge --category <category> --milestone <version> [--at <date>] <identifier flags…>

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

The two halves of `/gsd-update`'s user-added-file protection. `detect-custom-files`
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

**`worktree base-check`** reads `worktree.baseRef` from a three-layer cascade — `.claude/settings.local.json`, then `.claude/settings.json`, then the user/global `settings.json` under `CLAUDE_CONFIG_DIR` (or `~/.claude`) — and compares the current `HEAD` SHA against `origin/HEAD`. Project-level settings take precedence over the user/global layer, so a machine-wide `worktree.baseRef:"head"` set via `/config` is honored when no project override exists. The `shouldDegrade` field is `true` when the execute-phase orchestrator will fall back to sequential execution. `--mode` declares who creates the isolated worktree (#3659): `harness-worktree` (the default — the runtime harness forks it and does **not** read project-settings `baseRef`, #48) or `orchestrator-worktree` (GSD itself runs `git worktree add` with an explicit start-point and honors `"head"`); invalid values fail closed with an error. Possible `reason` values:

| `reason` | `shouldDegrade` | Meaning |
|---|---|---|
| `baseref-head` | `false` | `worktree.baseRef:"head"` is set and `--mode orchestrator-worktree` declares GSD-managed worktrees — the fork base is the orchestrator HEAD by construction |
| `baseref-head-ignored-by-harness` | `true` | `worktree.baseRef:"head"` is set but HEAD differs from `origin/HEAD` in harness (default) mode — the harness does not read the setting (#48), so the run degrades to sequential (#3659) |
| `head-matches-fork` | `false` | HEAD and `origin/HEAD` are the same commit |
| `head-diverged-from-fork` | `true` | Branch is ahead of or diverged from `origin/HEAD` |
| `fork-ref-unknown` | `true` | `origin/HEAD` could not be resolved |
| `no-head` | `false` | Not in a git repo (no `HEAD`) — `git rev-parse HEAD` exited 128 (definitive), or exited 0 with empty stdout |
| `head-unresolvable` | `true` | `git rev-parse HEAD` did not return a definitive answer (timed out, `git` missing, or any other non-128 failure) — fails closed rather than being treated as `no-head` |

**`worktree set-baseref`** applies a no-clobber write of `worktree.baseRef:"head"` to `.claude/settings.local.json`. If the file already contains an explicit `baseRef` value other than `"head"`, the existing value is preserved and `skipped:"explicit-other"` is returned. Malformed JSON causes an error rather than a silent overwrite. Both fresh installs and upgrades of GSD Core run this automatically when `workflow.use_worktrees` is enabled (the default); the command is also available for manual use — for example, to apply the setting when worktrees were toggled on after installation, or to re-apply it after a settings change.

### Worktree creation

```bash
# Create an agent worktree and atomically record it in the wave cleanup manifest.
# Returns JSON: { ok, reason, entry, manifest_path } (exit 0), or
#   { ok:false, reason, hint } with a non-zero exit on a rejected/failed create.
node gsd-tools.cjs worktree create \
  --manifest <path> --agent-id <id> --path <worktree> --branch <branch> --base <sha> --root <dir> \
  [--files "<space-separated declared paths>"]
```

**`worktree create`** validates and records the manifest entry BEFORE running any git command, then runs `git worktree add` for the validated `{path, branch, base}`, and only on success finalizes the manifest write — a rejected entry or a failed `git worktree add` never leaves a partially-recorded manifest or an unmanifested worktree on disk. `--root` is **mandatory** (#3050): the fail-closed root-confinement check resolves `--path` and `--root` and rejects (`reason:"path_outside_root"`) unless `--path` resolves strictly inside `--root` — this closes a prior gap where an unconfined `--path` (no `--root` check at all) could point a spawned executor's worktree anywhere on the filesystem. Omitting `--root` fails closed with `reason:"root_required"` rather than silently skipping confinement. All other flags share `worktree record-agent`'s validation rules above (`--branch` namespace, non-empty/non-whitespace `--path`/`--branch`/`--base`, `--agent-id` required). It also accepts the same optional `--files` as `record-agent` (#2596).

### Wave-manifest recording

The execute-phase orchestrator records each spawned executor's worktree identity into a wave cleanup manifest so the matching `cleanup-wave` reader can later merge and remove exactly those worktrees.

```bash
# Append a validated per-agent entry to the wave cleanup manifest.
# Returns JSON: { ok, reason, entry, manifest_path } (exit 0), or
#   { ok:false, reason, hint } with a non-zero exit on a rejected entry.
node gsd-tools.cjs worktree record-agent \
  --manifest <path> --agent-id <id> --path <worktree> --branch <branch> --base <sha> \
  [--files "<space-separated declared paths>"]
```

**`worktree record-agent`** appends one `{agent_id, worktree_path, branch, expected_base}` entry to an already-initialized manifest, validating every field **at write time using the same rules the `cleanup-wave` reader enforces** — `--branch` must match the disposable `^(worktree-)?agent-[A-Za-z0-9._/-]+$` namespace (accepts both `agent-<id>` and legacy `worktree-agent-<id>`), and `--path`/`--branch`/`--base` must be non-empty. `--agent-id` is required (write-strict), even though the reader treats it as optional. A missing or garbled field — or a duplicate `(worktree_path, branch)` the reader would dedup away — fails loudly with a recovery hint and a non-zero exit **without** writing, instead of appending an under-populated or silently-dropped entry. Whitespace-only `--path`/`--base` are rejected (values are trimmed). The on-disk manifest shape is unchanged unless `--files` is supplied (see below); the reader still re-derives `allowed_bases`, and the orchestrator still initializes the empty `{orchestrator_root, worktrees: []}` shell inline before any agent is recorded.

`--files` is optional (#2596). When supplied it records the plan's declared `files_modified` — the same whitespace-separated `PLAN_FILES` list the per-plan worktree gate already builds — as an extra `files_modified` array on the entry, and `cleanup-wave` then reports any path the branch committed outside it. A blank or omitted `--files` writes no field at all, leaving the 4-field on-disk shape untouched, and the scope check is simply skipped for that entry: an unrecorded scope means *unknown*, never *declares nothing*. Values are compared against a diff, never opened as paths and never passed to a shell.

`--deletions` is optional (#3003). When supplied it records the plan's declared `files_deleted` — built by the per-plan worktree gate exactly like `PLAN_FILES`, from the plan's own frontmatter — as a `declared_deletions` array on the entry. It is the opt-in the deletions guard reads (see below). A blank or omitted `--deletions` writes no field, leaving the on-disk shape untouched and the guard's original unconditional block in force. Like `--files`, values are compared against a diff and never opened or passed to a shell.

**Intentional deletions (gate, #3003)**

`cleanup-wave` blocks the merge of any executor branch whose diff deletes a file — a net against a mass-deletion accident. A plan whose scope legitimately includes removing a file declares those paths in its `files_deleted` frontmatter, which reaches the entry as `declared_deletions`; the guard then blocks only the deletions **not** in that list.

| Branch deletes | Entry declares | Result |
|---|---|---|
| nothing | — | merges |
| `tests/a.ts` | *(no field)* | **blocked** — unchanged pre-#3003 behavior |
| `tests/a.ts` | `["tests/a.ts"]` | merges |
| `tests/a.ts`, `src/b.ts` | `["tests/a.ts"]` | **blocked**, and the block detail names only `src/b.ts` |
| `tests/a.ts` | `["tests"]` | **blocked** — a directory does not authorize its children |
| `tests/a.ts` | `["*.ts"]` | **blocked** — globs are literal paths here, matching nothing |

Matching is **exact after normalization**: git's C-quoting is decoded, backslashes become forward slashes, and a leading `./` and any trailing `/` are stripped — on both sides. The decode matters more than it looks: with `core.quotepath` at its git default, a path like `tests/é.ts` is reported as the literal `"tests/\303\251.ts"`, which would never compare equal to the plainly-declared path, so a correctly declared deletion of any non-ASCII path would block forever with nothing pointing at the encoding. It is deliberately neither a prefix nor a glob match — either would let one declaration authorize a whole set of deletions, which is the accident the guard exists to catch. A declared path that was not in fact deleted is inert. A blocked entry still isolates: the rest of the wave proceeds (#2852). If the deletion check itself fails the entry blocks on `deletion_check_failed` and is never filtered — a broken check is not an authorization.

A declared deletion is also treated as in-scope by the advisory below, so authorizing a removal does not then warn that the removed path was out of the declared scope. That is done by **subtracting** declared deletions from the advisory's findings, not by adding them to the declared scope it matches against — the advisory reads its scope list with prefix-and-glob semantics, so adding them would quietly give `declared_deletions` a second, wider matching rule than the table above, and `["*.md"]` would go from inert to silencing the advisory entirely. One field, one matching rule, on every surface. Subtraction also means the advisory's activation is unchanged: it still runs only when `files_modified` is recorded, so a plan that declares deletions alone stays as silent as it was before #3003.

One limit worth knowing, shared with `--files` and failing closed: a declared path containing a **space** cannot be expressed, because the flag value is whitespace-separated — such a path splits into fragments, matches nothing, and the entry blocks. Flag values are also read positionally and never re-inspected for shape, so a malformed `--deletions --files src/a.ts` records the literal `--files` as the declaration; that is harmless (it is a path git never reports as deleted, so it authorizes nothing) and `--files` still resolves to `src/a.ts` on its own lookup.

**Scope conformance at merge (advisory, #2596)**

When a manifest entry carries a declared `files_modified`, `cleanup-wave` compares the branch's actual committed diff (`HEAD...<branch>`) against it and appends one entry to the result's `warnings` array for every path outside the declared scope, with `code: "scope_out_of_declared"` and the offending `path`. If the diff itself cannot be computed the entry gets a single `code: "scope_check_unavailable"` warning instead, so an unknown result is never mistaken for a clean one. Warnings are also aggregated on the top-level `warnings` array, each tagged with its `branch`.

This is advisory: it does not change `ok`, `reason`, the per-entry `status`, or the exit code, and the merge proceeds either way. Promotion to a hard gate would be a separate, disclosed change.

Two deliberate limits keep it from crying wolf. `.planning/**/*SUMMARY.md` paths are always exempt — the executor writes a SUMMARY by orchestration contract and no plan declares it. Glob patterns are matched by their literal prefix only, so `src/**/*.ts` covers everything under `src/`, and a pattern with no literal prefix (`*.md`) suppresses warnings for that entry rather than reporting every file.

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
| Context Predicates | `lib/context-predicates.cjs` | `CONTEXT.md` predicate fact-store parser/selector (ADR-1671, #2928) — backs `query context-predicates` and `scripts/gen-context-index.cjs`'s `docs/CONTEXT-INDEX.json` drift guard |
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

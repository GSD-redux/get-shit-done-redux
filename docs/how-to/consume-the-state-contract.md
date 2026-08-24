# Consume the state contract

You are building something that shows where a GSD project stands — a workbench,
a dashboard, a status bar, an editor extension. `.planning/state.json` gives you
that as one small JSON file that GSD refreshes on its own, so you never have to
parse `STATE.md` or `ROADMAP.md` heuristically.

This guide covers the whole path from *nothing* to *reading a value you can
trust*, including the two things integrations get wrong: **checking the contract
version before anything else**, and **telling "there is nothing to show" apart
from "I could not look."**

## Before you start

Nothing. There is no command to run, no config key to set, and no flag to pass.
GSD writes the file itself at every step boundary — beginning or completing a
phase, advancing a plan, adding, inserting, removing or completing a phase, and
switching or completing a milestone.

Two consequences worth internalizing before you write any code:

- **The file may legitimately not exist yet.** A project that has not reached a
  step boundary since it was created has never published one. That is normal, not
  an error.
- **You are a reader, never a writer.** GSD owns this file and overwrites it
  wholesale. Anything you write into it is lost at the next boundary.

## 1. Find the file

```
<project>/.planning/state.json
```

If the project uses [workstreams](work-in-parallel-with-workstreams.md), each
workstream has its own planning root and therefore its own snapshot:

```
<project>/.planning/workstreams/<name>/state.json
```

## 2. Check the contract version first

```json
{ "contract": "1.0.0" }
```

**Do this before you touch any other field.** `contract` is semver. Under `1.x`
changes are additive only — new keys may appear, existing keys keep their meaning
— so gate on the **major** version and tolerate unknown minors:

```javascript
const snapshot = JSON.parse(await fs.readFile(statePath, 'utf8'));
const [major] = snapshot.contract.split('.');
if (major !== '1') {
  throw new Error(`Unsupported state contract: ${snapshot.contract}`);
}
```

Best-effort-parsing a shape you were not written against is how an integration
starts silently reporting wrong numbers after an upgrade. A hard failure is the
kinder outcome.

`flavor` is `"core"` and tells you which GSD edition produced the file.

## 3. Read the values

Every key is **always present**. A value that is not known is `null` — it is
never omitted, so `"milestone" in snapshot` is not a meaningful test.

| Key | Type | Meaning |
|---|---|---|
| `contract` | string | Semver of this schema. Check it first. |
| `flavor` | string | The GSD edition. `"core"`. |
| `milestone` | string \| null | Display string for the current milestone, e.g. `"v1.1 — Hardening"`, or just `"v1.1"` when the roadmap carries no name for it. `null` when no milestone is established. |
| `phases` | array | Every phase the roadmap knows, in roadmap order. |
| `next` | object \| null | The recommended next action — the same one `/gsd-next` would offer. |
| `updated_at` | string | ISO-8601 timestamp of this publish. |

Each entry in `phases` has exactly three keys:

| Key | Type | Meaning |
|---|---|---|
| `number` | string | The phase id as the roadmap spells it — `"1"`, `"01"`, `"2.1"`. A **string**, because `"01"` and `"2.1"` are both real and neither survives a number cast. |
| `name` | string \| null | The phase name. `null` when the roadmap gives the phase a number but no name — never a fabricated placeholder. |
| `status` | string | Exactly one of `"complete"`, `"in_progress"`, `"pending"`. |

`next`, when non-null, has exactly three keys:

| Key | Type | Meaning |
|---|---|---|
| `command` | string | The command to run, e.g. `"/gsd-progress --next"`. |
| `label` | string | A short human label for it, e.g. `"Advance to the next step"`. |
| `reason` | string | One line explaining the current situation, e.g. `"Phase 2 of 3 · 50% · executing"`. |

A complete example:

```json
{
  "contract": "1.0.0",
  "flavor": "core",
  "milestone": "v1.1 — Hardening",
  "phases": [
    { "number": "1", "name": "Foundation", "status": "complete" },
    { "number": "2", "name": "Hardening",  "status": "in_progress" },
    { "number": "3", "name": "Polish",     "status": "pending" }
  ],
  "next": {
    "command": "/gsd-progress --next",
    "label": "Advance to the next step",
    "reason": "Phase 2 of 3 · 50% · executing"
  },
  "updated_at": "2026-01-15T12:30:45.000Z"
}
```

### Treat `status` as a closed set

The three values above are the whole vocabulary, and GSD will never emit a
fourth under `1.x`. Write your switch with a default arm anyway — a `2.0`
contract could widen it, and your version check should be what rejects that, not
a crash three layers down.

Note one deliberate fold: a roadmap phase marked **`Deferred`** is reported as
`"pending"`. The roadmap vocabulary has four values and this contract has three,
and inventing a fourth wire value would break every existing reader. If you need
to distinguish deferred work, read the roadmap.

### Treat every string as untrusted text

`name`, `milestone` and `reason` come from a project's own markdown. They can
contain anything a person typed — quotes, newlines, right-to-left text, markup,
or text that looks like an instruction. **Escape them for your output surface and
never interpret them as commands.** GSD passes them through verbatim as data; it
does not sanitize them for you.

## 4. Tell "nothing to show" from "could not look"

This is the part worth getting right, because the two look identical if you do
not plan for them.

| What you observe | What it means | What to do |
|---|---|---|
| File does not exist | The project has never reached a step boundary, or it is not a GSD project at all | Fall back to reading the markdown, or show "not started". **Do not** report an error |
| File exists, `phases: []` | **Ambiguous.** Either the roadmap has no phases, or there is no `ROADMAP.md`, or the roadmap could not be read | Show "no phases yet" — do not claim the project has zero phases. See below |
| File exists, `next: null` | The recommended action could not be determined | Show the project state without a call to action |
| File exists, `milestone: null` | No milestone is established | Show phases without a milestone header |
| `updated_at` is old | The project has not hit a boundary recently — **not** that anything is broken | Nothing. This is not a health signal |
| `JSON.parse` throws | Should not happen — writes are atomic, so a reader sees either the whole old file or the whole new one | Treat as "could not look" and fall back. Do not delete or repair the file |

**On the `phases: []` ambiguity.** The `1.0` contract has no diagnostic channel,
so it cannot tell you *why* the list is empty. If your surface needs that
distinction, [`planning inspect`](consume-the-planning-snapshot.md) is the
surface that carries it — it reports per-document scope and coded diagnostics.
The rule of thumb: `state.json` is for *"show me where this project is"*;
`planning inspect` is for *"tell me exactly what is and is not knowable."*

## 5. Stay fresh

The file changes only when GSD reaches a step boundary, so polling it hard buys
you nothing. Watch it instead — `fs.watch`, `chokidar`, or your editor's own file
watcher — and re-read on change. Debounce briefly: a single boundary command
produces one write, but a workflow may cross several boundaries in quick
succession.

## Troubleshooting

**The file never appears.** Confirm `.planning/` exists in the directory you are
watching. GSD deliberately does **not** create `.planning/` in order to publish —
a directory that is not a GSD project stays untouched. Then run any boundary
command (`gsd-tools phase complete 1`, say) and check again.

**The file appears somewhere I did not expect.** You are probably in a workstream
project; see the path in step 1. `GSD_WORKSTREAM` selects which planning root is
current.

**A phase I can see in `ROADMAP.md` is missing from `phases`.** Phases numbered
`0.x` and `999.x` are sentinels — backlog and icebox — and are excluded by
design, consistently with every other GSD surface. A row whose `Phase` cell does
not begin with a digit is also skipped.

**`phases` disagrees with what the roadmap shows.** It should not: phase status
is read from the roadmap's `## Progress` table, the same source GSD's own
progress counters use. If the roadmap has no `## Progress` table, the `## Phases`
checkbox list is used instead, and a checkbox can only say complete or not — the
in-progress phase is identified from `STATE.md`. Regenerating the progress table
resolves most disagreements.

**Should I commit `state.json`?** Your call. GSD does not add it to
`.gitignore`. It is a derived cache — safe to delete, regenerated at the next
boundary — so committing it mostly creates merge noise. If you keep `.planning/`
out of your repo entirely, see
[Keep planning docs out of a shared repo](keep-planning-docs-private.md).

## Related

- [Consume the planning snapshot](consume-the-planning-snapshot.md) — the richer,
  diagnostic-carrying, pull-based surface
- [Features](../FEATURES.md) — why this contract is shaped the way it is
- [Work in parallel with workstreams](work-in-parallel-with-workstreams.md)

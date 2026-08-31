# Consume the planning snapshot

You are building something that needs to know where a GSD project stands —
a dashboard, a status page, a harness UI, a bot that comments on a pull request.
`planning inspect` gives you that as one JSON document, so you never have to
parse `ROADMAP.md`, `REQUIREMENTS.md`, `*-PLAN.md`, or `*-SUMMARY.md` yourself.

This guide covers the whole path from *off* to *reading a value you can trust*,
including the part most integrations get wrong: telling **"nothing to report"**
apart from **"could not look."**

## Before you start

You need `gsd-tools` on the machine, and a project directory containing
`.planning/`. Nothing has to be enabled or configured — the command is read-only
and always available.

## 1. Get a snapshot

```bash
gsd-tools query planning inspect
```

The dotted form is identical, if that reads better in your code:

```bash
gsd-tools query planning.inspect
```

The command takes no arguments. If you pass one, it fails loudly rather than
ignoring it — see [Troubleshooting](#troubleshooting).

To inspect a project other than your current directory, use the global `--cwd`
flag, which every `gsd-tools` command accepts:

```bash
gsd-tools query planning inspect --cwd /path/to/project
```

## 2. Check the schema version first

```json
{ "schema_version": 1 }
```

**Reject any version you were not written against.** Do this before you touch
any other field:

```javascript
const snapshot = JSON.parse(stdout);
if (snapshot.schema_version !== 1) {
  throw new Error(`Unsupported planning snapshot schema: ${snapshot.schema_version}`);
}
```

Best-effort-parsing an unknown shape is how an integration starts silently
reporting wrong numbers after an upgrade. A hard failure is the kinder outcome.

## 3. Read a value — and check its scope

Most answers arrive alongside a `scope`. It tells you whether the value is a
real answer or a placeholder for one that could not be produced:

| `scope` | Meaning | What to render |
|---|---|---|
| `complete` | The read succeeded. The value is real — **including when it is `0` or `[]`** | The value |
| `truncated` | Part of the source could not be read | The value, marked partial |
| `unscoped` | The source exists but nothing could be located in it | "Unknown" |
| `unreadable` | The source could not be read at all | "Unknown" |

The distinction that matters: **`complete` with an empty value is a real answer.**
A milestone with zero phases genuinely has zero phases. `unreadable` with an
empty value means nobody looked. Rendering both as "0 phases" is the bug this
field exists to prevent.

```javascript
const phases = snapshot.progress.accepted_phases;
if (phases.scope !== 'complete') {
  render('Progress unavailable');       // could not look
} else {
  render(`${phases.completed} / ${phases.total}`);  // real, even if 0 / 0
}
```

## 4. Handle a withheld percentage

`progress.accepted_phases` and `progress.completed_plans` each carry
`{completed, total, percent, scope}`. **`percent` is `null` whenever `scope` is
not `complete`.**

That is deliberate. A percentage computed from a partial phase set is a
confidently wrong number, and a consumer cannot tell it apart from a real one.
Do not substitute `0`, and do not compute your own from `completed / total` —
those counts are partial too.

```javascript
const { percent } = snapshot.progress.completed_plans;
render(percent === null ? '—' : `${percent}%`);
```

`percent: 0` under a `complete` scope is a real 0 and should be rendered.

## 5. Read the three kinds of phase evidence separately

Each entry in `phases[]` reports three independent signals. **They are not
combined into one verdict, and you should not combine them either** — they
answer different questions and can legitimately disagree.

| Field | Question it answers |
|---|---|
| `verification` | Did the verifier pass this phase? This is what `complete` is derived from |
| `roadmap_acceptance` | Is the ROADMAP checkbox ticked? |
| `uat` | Are there unresolved user-acceptance items? |

`roadmap_acceptance` carries `authoritative: false`, and it means it. A ticked
checkbox is a human annotation with no machine authority — completion comes from
disk state. If you show the checkbox, label it as an annotation, not as status.

A phase can be `complete: true` with open UAT items. That is a real state, not a
contradiction.

## 6. Handle `unknown` rather than guessing

Where evidence is absent or two sources disagree, the value is `null` or
`"unknown"` and `diagnostics[]` says why. Nothing is inferred.

The case you will hit most often is task-scoped file provenance:

| `provenance` | What it means | What to show |
|---|---|---|
| `task_scoped` | The summary attributed files to this exact task | The file list |
| `plan_scoped` | A summary exists, but only lists files for the whole plan | "Not attributed" — **not** the plan's list |
| `absent` | No summary yet | "Not started" |

`plan_scoped` is the common case and is not an error. Attributing a plan's file
list to one of its tasks would be a guess, so the snapshot declines to make it.
The plan-level list is still available at `plans[].changed_files`, where it is
accurate.

When a task's planned and changed files both exist and disagree, `agreement` is
`"conflicting"` and both lists are present, unreconciled. Show both; do not pick.

## 7. Read the diagnostics

Every non-answer above has a matching entry in `diagnostics[]`:

```json
{ "code": "requirement_unmapped", "subject": "AUTH-03", "detail": "..." }
```

`code` is a stable identifier from a frozen vocabulary — match on it, never on
`detail`, whose wording may change. Common codes:

| Code | Meaning |
|---|---|
| `planning_root_absent` | No `.planning/` directory — every section below is a non-answer |
| `roadmap_unscoped` | No milestone version could be resolved; none was invented |
| `requirements_absent` | No `REQUIREMENTS.md` |
| `requirement_unmapped` | A requirement no Traceability row maps to a phase |
| `requirement_phase_unknown` | A requirement mapped to a phase that is not on disk |
| `orphan_phase_dir` | A phase directory the current milestone does not declare |
| `task_changed_files_plan_scoped` | Task-level file attribution unavailable (see step 6) |
| `task_changed_files_conflicting` | Planned and changed files disagree |
| `percent_withheld` | A percentage was suppressed because its scope was not `complete` |

An empty `diagnostics[]` means every value in the snapshot is a real answer.

## 8. Handle a large payload

On a big project the JSON can exceed the ~50 KB console limit. `gsd-tools`
handles this for you: it writes to a temp file and resolves the reference before
writing to stdout, so you always receive JSON. If you are invoking `gsd-tools`
through a shell wrapper that captures stdout directly, no special handling is
needed.

## Troubleshooting

**`Unknown planning subcommand. Available: inspect`**
You typed a subcommand that does not exist. `inspect` is the only one.

**`planning inspect takes no arguments; got flag: --phase`**
v1 always returns the whole project. It refuses scoping arguments rather than
ignoring them — silently returning an unscoped snapshot to a caller who asked
for a scoped one would be worse. Filter the `phases[]` array on your side.

**Everything is `unknown` and `diagnostics[0].code` is `planning_root_absent`**
You are not in a GSD project directory. Use `--cwd`, or `cd` first.

**A phase you expect is missing from `phases[]`**
Check `orphan_phase_dirs[]`. `phases[]` is scoped to the phases the current
milestone's ROADMAP window declares; a directory on disk that the roadmap never
mentions is reported there instead, so that a genuinely orphaned directory
cannot masquerade as a planned phase.

## Related

- [`planning inspect` reference](../CLI-TOOLS.md#planning-inspect) — every field, with exact semantics
- [Resolve unreachable-guard findings](resolve-unreachable-guard-findings.md) — the same "nothing to report vs. could not look" distinction, one layer down

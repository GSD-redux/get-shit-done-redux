# How to resolve a contract-drift finding

**Goal:** Bring `gsd-core/references/agent-contracts.md`'s Agent Registry back into agreement with what agents actually emit and what workflows, commands, and agents actually consume — so a completion marker, a read-tag gate, or a deleted-file reference can never silently drift apart again.

**Prerequisites:** A failing `npm run lint:ci` (or a direct `npm run check:contract-drift`) reporting one or more violations. The check runs automatically as part of `lint:ci` — you do not invoke it separately.

For why the registry exists (five shipped defects, all one root cause: two surfaces sharing a contract with nothing enforcing agreement), see [issue #3565](https://github.com/open-gsd/gsd-core/issues/3565) and epic [#1891](https://github.com/open-gsd/gsd-core/issues/1891). This guide covers only how to *act* on a finding.

---

## Read a finding

```
ERROR check-contract-drift: 2 violation(s) across 2 kind(s)

  no_consumer (1):
    - gsd-example marker "EXAMPLE COMPLETE": no consumer text contains "EXAMPLE COMPLETE" (exact case)
      remedy: add an exact-case consumer for this marker, or reclassify the row Kind to artifact+query/structured-return
```

Every finding names its **kind**, the agent (or registry), the marker where one is involved, and a **remedy** line. The kinds and what they mean:

| Kind | Meaning | Correct resolution |
|---|---|---|
| `no_consumer` | A declared `sentinel-match` marker no workflow/command/agent matches exact-case | Wire the consumer, fix the casing on either side, or reclassify the row's `Kind` |
| `declared_consumer_no_match` | The marker is consumed somewhere, but by none of the files the row's `Consumed by` cell names | Fix the cell to name a real consumer — the cell is what the read-tag arm and humans navigate by |
| `case_only_match` | A marker matches a consumer only case-insensitively | Fix the casing to match exactly — never relax the matcher; lowercase prose is a coincidence, not a contract |
| `case_collision` | Two declared markers differ only by case | Rename one deliberately; a case-insensitive runtime match cannot tell them apart |
| `declared_marker_not_emitted` | The registry declares a marker the agent never emits in-fence | Emit it as a fenced example in the agent file (a `@`-included `gsd-core/references/**` file counts), or remove it from the row |
| `emitted_marker_not_declared` | The agent emits an in-fence marker-shaped heading absent from its row | Add it to the row — after verifying a real consumer exists (it may be your next `no_consumer`) |
| `vestigial_marker` | An `artifact+query`/`structured-return` row's agent still emits a marker | Delete the marker from the agent — unless it carries an `(unconsumed: …)` annotation (see below) |
| `agent_without_contract` / `duplicate_registry_row` | An agent file with no row, or two rows | Add exactly one row; the registry is the declaration of record for every agent |
| `unknown_producer` / `unknown_consumer` | A row names an agent or a `Consumed by` file that does not exist | Fix or drop the name — a lint over fictional paths guards nothing |
| `read_tag_gate_missing` | A declared consumer emits `<required_reading>` but the agent never references the gate | Add the MUST-Read gate clause to the agent (an `@`-included reference carrying it counts) — this is the F8 defect one layer up |
| `legacy_read_tag` | A `<files_to_read>` survived under workflows/commands/agents | Rename to `<required_reading>` ([#3423](https://github.com/open-gsd/gsd-core/issues/3423) standardized on the gate tag) |
| `unmatched_consumer_token` | A workflow/command matches a quoted `## TOKEN` no agent declares or emits | Declare the producer, or delete the dispatch — this is F9's shape from the consumer side |
| `parse_error` / `unclosed_fence` | The registry table or an agent file is malformed | Fix the row / close the fence; extraction over an unclosed fence is unreliable |
| `pins-existence` (from `lint-removed-but-needed`) | A test depends on a file this PR deleted | Update the test to assert absence instead — `assert.ok(!content.includes('x.md'))` is the correct post-deletion state |

---

## Pick the right `Kind`

Every row declares exactly one of three kinds, and the kind is a **measured fact about the consumer**, not a style preference:

- **`sentinel-match`** — a workflow, command, or another agent detects completion by an exact-case string match. Only kind whose markers need a consumer.
- **`artifact+query`** — the agent writes a file and the caller reads or queries it (`*-VERIFICATION.md` + `gsd_run query verification.status`). No marker required.
- **`structured-return`** — the agent cannot write (no `Write` tool) or returns parseable sections/JSON inline, and the caller reads the return text.

To decide, open the consumer and find the line that waits for the agent. If it greps a marker string → `sentinel-match`. If it reads a file or queries a CLI → `artifact+query`. If it parses the return message → `structured-return`.

## The `(unconsumed: …)` annotation — an audit trail, not a mute button

Some markers are emitted deliberately while nothing matches them: Marker Rule 2's title-case markers are a recorded decision, and a draft-presentation heading may serve a human, not a spawner. Declare those as:

```markdown
`## ROADMAP DRAFT` (unconsumed: draft-presentation format the shipped execution flow never invokes — Step 8 returns `## ROADMAP CREATED`)
```

The annotation waives **only** the consumer requirement. The marker must still be declared *and* emitted, and it still counts for case-collision detection. A non-empty reason is required — the reason is what makes the exemption auditable rather than a silent pass. Never use it to silence a real orphan; if no reason survives scrutiny, the marker is dead and should be deleted.

## After editing the registry

Nothing regenerates from `agent-contracts.md` — it is the source of truth, read directly by the check. Re-run:

```bash
npm run check:contract-drift
```

If the failing finding came from the `tests/` arm of `lint-removed-but-needed`, re-run `npm run lint:removed-but-needed` with `GSD_REMOVED_BUT_NEEDED_BASE` pointing at your base branch (CI sets this automatically).

## Silent cases are clean by design

- A marker heading **outside** a code fence is prose documentation, not a contract — the check ignores it (fence-awareness is what keeps 7 legitimate prose headings from being reported as case-drift).
- An `(unconsumed: …)` marker with no consumer is not an orphan — that is the annotation working.
- A test that **asserts absence** of a deleted file is not a surviving reference — that is the discriminator working.
- Nothing to report and nothing to fix look identical in the output: `ok check:contract-drift: N agents, M markers, 0 violations`. The agent/marker counts moving between runs is your signal the registry actually changed.

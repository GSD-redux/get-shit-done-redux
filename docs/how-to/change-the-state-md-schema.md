# How to change the STATE.md schema

Every key in `.planning/STATE.md`'s frontmatter is declared once, in
`src/state-md-schema.cts`. The field-classification tables, the shipped template and the five
reference documents are all derived from it. This page is how you add, change or remove a key
without any of those falling out of step.

If you only want to know what the keys *are*, read
[the STATE.md reference](../reference/state-md.md) instead.

## Add a key

**1. Declare it in `src/state-md-schema.cts`.**

```ts
my_new_key: {
  type: 'string',
  cardinality: 'optional',
  source: 'body',
  preservation: 'preserve-when-unchanged',
  bodySource: ['My New Key'],
  bodyLabel: 'My New Key',
  emitted: 'when-present',
},
```

Every column is required except `enum`, `guard`, `mergeStrategy`, `bodySource`, `bodyLabel` and
`acceptedShapes`. What each means is documented on the type itself — read it there rather than
copying a neighbouring row and hoping.

**2. Build, then regenerate. In that order.**

```bash
npm run build:lib
npm run regen:derived
```

**The order matters and getting it wrong fails quietly.** The generator reads the *compiled*
`gsd-core/bin/lib/state-md-schema.cjs`, not the TypeScript source. Regenerating before building
regenerates against the previous schema, produces artifacts that look plausible, and commits a
document that disagrees with the code you just wrote. If you are ever unsure whether the build is
current, run `npm run build:lib` again — it is cheap and idempotent.

**3. Commit the regenerated artifacts.** They are generated *and committed*:

- `gsd-core/templates/state.md`
- `docs/reference/state-md.md` and its `ja-JP`, `zh-CN`, `ko-KR`, `pt-BR` siblings

**4. Add the human-facing rows by hand.** Two tables in the reference documents are deliberately
**not** generated — see [What is generated and what is not](#what-is-generated-and-what-is-not).
Add your key's row to the **Field reference** table in each locale. The parity check will tell you
if you miss one.

## Change or remove a key

Same two commands. Removing a key also means removing its row from the Field-reference tables in
all five locales, or the parity check fails naming each one.

Before you change a key's `preservation` or `source`, read
[ADR-3408](../adr/3408-state-write-path-preservation.md) §8 — those columns drive what survives a
STATE.md write, and a change there is a behavior change, not a documentation edit.

## What the check is telling you

`npm run lint:generated-sync` runs `node scripts/gen-state-md-docs.cjs --check`, and `lint:ci` runs
it for you. It exits non-zero with a reason code and the file and region involved.

| Reason | What happened | What to do |
|---|---|---|
| `region_stale` | A generated region does not match what the schema would produce. | `npm run build:lib && npm run regen:derived`, then commit the result. |
| `markers_missing` | A target file has no `STATE-MD-SCHEMA` marker pair for a region. | Add the marker pair where the region belongs. The generator never invents a location. |
| `marker_unclosed` | A `:START:` marker has no matching `:END:`. | Fix the markers. The generator refuses to write rather than guess where the region ends — a wrong guess would eat hand-written prose. |
| `field_reference_drift` | The Field-reference table's row set disagrees with the schema. | Add the missing row, or remove the row for a key that no longer exists. |
| `status_values_drift` | The Status-values table disagrees with the schema's `status` enum. | Same. |

`--json` gives you the same information structurally if you are scripting against it.

## What is generated and what is not

| Region | Generated? |
|---|---|
| The template's frontmatter block | yes |
| `### Status lifecycle` | yes, in all five locales |
| `### Field cardinality` | yes, in all five locales |
| **Field reference** table | **no** — row set parity-checked only |
| **Status values** table | **no** — row set parity-checked only |
| All prose outside a marked region | **no**, ever |

The last three are the point. The Field-reference and Status-values tables carry per-row prose —
`Purpose`, `When populated`, `Matched text` — that is genuinely hand-translated. The Japanese
Matched-text column reads `` `discussing` を含む ``, not the English. Generating those tables from
a single English source would overwrite four languages' translations every time anyone regenerated.
So the schema owns the **row set**, which is what drift actually means, and translators own the
prose.

If you edit inside a marked region, the next `--write` will overwrite you and `--check` will report
it first. If you edit *outside* one, nothing touches it.

## Adding a language

Copy an existing locale's `reference/state-md.md`, translate the prose, and keep the
`STATE-MD-SCHEMA` marker pairs where they are. Then run the two commands above; the generator fills
every marked region for the new locale, and the parity check starts holding it to the same row set
as the rest.

Column headers come from a per-locale string table in the generator — add yours there so the
generated tables are not headed in English.

## Keys the schema does not model

`active_phase`, `next_action` and `next_phases` are real frontmatter keys ([#2833](https://github.com/open-gsd/gsd-core/issues/2833))
that are documented but sit outside the schema. They are grandfathered **by exact name** in
`KNOWN_SCHEMA_GAP_FIELDS`, so the parity check tolerates those three and no others — a fourth
undocumented key fails, which is what stops the list quietly becoming a wildcard.

If you are adding one of those three to the schema properly, remove its name from that list in the
same change.

## Why the schema exists

Before it, this key set was declared in four places that had to agree by hand, and they did not:
one table carried `last_activity`, another did not. The five reference documents disagreed too —
the section documenting the `status` values was missing from all four translations, and it is the
section that matters for [#3853](https://github.com/open-gsd/gsd-core/issues/3853).

[ADR-3473](../adr/3473-enforcement-by-construction.md) §8.8 is the contract, and its governing idea
is worth keeping in mind when you edit the schema: **the schema declares what the code does, not
what it should do.** If you find yourself writing a row that describes intended behavior, you are
writing a document that lies — declare today's behavior and fix the code separately.

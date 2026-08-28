---
id: 3951
title: Reachable Lint Rules and a Non-Destructive Quick-Task Append
group: v1.7.0 Features
---

**Purpose:** Make two ESLint rules cover the code they were written to govern, and stop
`quick-tasks-append` from overwriting curated `progress.*` values on a body-only write.

**What changed:**

- **`local/no-adhoc-markdown-parsing` reaches its whole registered surface.** The rule short-circuited
  unless a file's path matched a flat `src/*.cts` pattern, so it **self-gated on its own filename**.
  Two consequences: 28 `.cts` files in `src/` subdirectories sat inside the `src/**/*.cts` glob it was
  registered on and were silently skipped, and the rule could not be extended by configuration at all —
  widening the glob alone left it inert. Both halves now move together, and a test pins that the gate
  and the registration agree in *both* directions.
- **The rule now also covers `tests/**` and `scripts/**`**, which surfaced **80 hand-rolled markdown
  parses across 43 test files**. Seventy are routed through the existing `markdown-sectionizer` and
  `markdown-table` seams; ten are suppressed with a stated reason (six of those are a shell-pipe
  detector whose regex merely resembles a table).
- **`local/no-adhoc-regex-escape` sees property access.** Its unsafe-`new RegExp` arm examined only
  bare identifiers, so `new RegExp(obj['key'])` — the shape runtime data actually arrives in — was
  invisible. That is why it never fired on a known ReDoS. It now inspects `MemberExpression`, with an
  exemption keyed strictly on the property being `source` (18 safe sites), plus provenance exemptions
  for `_SOURCE` constants reached through a required module (3 sites).
- **`quick-tasks-append` can write the canonical row.** Optional `--quick-id`, `--slug` and
  `--directory` let a caller that has a real quick task emit the same row `/gsd-quick` renders. Omit
  them — as `fast.md` does, having neither an id nor a directory — and the row is byte-identical to
  before.
- **A body-only append no longer re-derives progress.** The route was the only body-only STATE.md
  writer not passing `{ resync: false }`, so appending one row triggered a full re-derive of the
  disk-derived `progress.*` frontmatter and replaced curated values. Reproduced: a project with two
  real phase directories and a curated `total_phases: 25` collapsed to `2` on append.

**Found by the widening:** `tests/config-field-docs.test.cjs` asserted that
`workflow.subagent_timeout`'s documented default is not `600` — but read the **Type** column instead
of **Default**, so it compared `'number'` against `'600'` and could never fail. The guard against
regressing to the old seconds-based default had been inert. It is now row-scoped and real.

**Known limits:**

- #3426 and #3239 are **not** closed by this. Their hand-rolled scans in
  `tests/package-legitimacy-gate.test.cjs` are built from line filters and `split('|')`, not the
  regex-literal fingerprints this rule detects — measured at zero violations even with the gate
  bypassed. They need new detectors, which is a separate design.
- The 10 suppressions are suppressions, not fixes. Each names why the raw markdown text is the
  subject of that assertion.
- The `src/` subdirectory hole was **latent** — zero violations existed there when it was fixed. It is
  closed because "no violations today" is not a property that keeps holding, not because it was
  hiding anything.

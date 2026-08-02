# Dynamic context management — Option-E reference example

Reference example for [ADR-1671](../../docs/adr/1671-dynamic-context-management-platform.md),
"Dynamic context management platform."

> **This is a non-shipping reference example.** It lives outside the build
> (`src/` → `bin/lib/`), the npm package `files[]`, the installer, and the CI
> test suite (`tests/`). Nothing here is compiled into or installed with GSD.
> The production implementation lands in a later phase of the
> [Dynamic Context Management epic (#1671)](https://github.com/open-gsd/gsd-core/issues/1671).

## What it demonstrates

The **predicate fact-store → JIT selector** slice of the platform: parse the
repo-root `CONTEXT.md` `CLASS.subkey=value` predicates into structured records,
drift-guard a generated index, and select the relevant predicate subset for a
task — the building block for just-in-time agent-brief assembly instead of
hand-citing a 200 KB file.

## Files

- `context-predicates.cjs` — parser + selector + deterministic index builder (self-contained).
- `gen-context-index.cjs` — `--check` / `--write` drift-guarded generator + `--select`.
- `CONTEXT-INDEX.json` — sample generated output (415 predicates, 20 classes).
- `demo.cjs` — runnable usage example.

## Run (from the repo root)

```sh
node examples/dynamic-context-management/demo.cjs
node examples/dynamic-context-management/gen-context-index.cjs --select PRED.k320
node examples/dynamic-context-management/gen-context-index.cjs --check
```

## Validation

During research this slice was validated with 42 behavioral tests — predicate
forms, fenced-code / prose skipping, duplicate-id detection, the selector, a
deterministic index, and a fast-check property test. The production
implementation has since landed, with `tests/context-predicates.test.cjs` and
`tests/context-index-sync.test.cjs` as its behavioral tests under `tests/`,
and `scripts/lint-example-parser-parity.cjs` (wired into `npm run lint:ci`)
asserting this example and production agree.

Research also surfaced 3 latent duplicate predicate IDs in `CONTEXT.md`
(`RULESET.WORKFLOW_MARKDOWN.FENCES`, `RULESET.GEMINI.TOOLS.ask_user`,
`RULESET.GEMINI.TEST_SENTINEL`) at the time; all three have since been
resolved and the current index carries 0 duplicate ids.

# Command Contract Validation Module

- **Status:** Accepted
- **Date:** 2026-05-05

We decided to centralize the `commands/gsd/*.md` file contract into a single validation seam enforced at two layers: a fast lint script (`scripts/lint-command-contract.cjs`) that runs as a pre-test CI step, and a behavioral regression test (`tests/command-contract.test.cjs`) that validates the full contract against the live filesystem.

## Decision

The command file contract defines what makes a valid `commands/gsd/*.md`:

- `name:` field present, non-empty, matches `gsd:*` or `gsd-*` (ns- commands use `gsd-`)
- `description:` field present and non-empty
- `allowed-tools:` block present and non-empty, all entries from the canonical tool set
- Every `@`-reference inside `<execution_context>` blocks resolves to an existing file on disk
- `@`-references inside `<execution_context>` blocks appear on their own line (no trailing prose)
- Every `gsd-core/workflows/*.md` file is reachable from at least one `commands/`, `agents/`, or `skills/` loader, transitively through `gsd-core/**` (#3560)

The first five checks are per-file frontmatter/body rules. The sixth is a different concern in kind: a repo-level reachability graph, computed once per run rather than per command file. It walks every markdown file under `commands/`, `agents/`, and `skills/` as loader seeds, then follows references transitively through `gsd-core/**` (not just `gsd-core/workflows/`, since a `references/` or `templates/` file can itself name a workflow path) until every reachable workflow file is marked. Any `gsd-core/workflows/*.md` file left unmarked is reported as an orphan.

A reference is recognized in three shapes: an eager `@`-include (the same `<execution_context>` syntax the first five checks already parse), a lazy path named only in prose or code that a command reads on demand rather than inlines, and a parent-relative sub-file path (`execute-phase/steps/post-merge-gate.md`) implicitly rooted under `workflows/`.

Reachability is seeded only from loaders, never from a workflow file's own content — a workflow that references itself, or two workflows that reference only each other, must still be reported as unreachable, since no command, agent, or skill loader ever actually opens them. `docs/` and test fixtures deliberately do not count as loaders: a path merely mentioned in documentation or a test does not make it reachable by any runtime — only `commands/`, `agents/`, and `skills/` do.

## Context

Before this ADR, the command contract was enforced inconsistently:
- `tests/skill-frontmatter-contract.test.cjs` (folds former `enh-2790-skill-consolidation`, consolidation epic #1969) checked existence and frontmatter of specific post-consolidation commands
- `tests/docs-update.test.cjs` (folds former `bug-3135-capture-backlog-workflow`, consolidation epic #1969) checked `execution_context` @-ref resolution (added 2026-05-05)
- No test checked `allowed-tools` validity, `name:` convention, or `description:` non-emptiness across all commands simultaneously

This meant any PR touching a command file could break the contract without a single test catching it. The `add-backlog.md` gap (#3135) is a concrete example: the workflow file was missing for the full consolidation cycle before a targeted regression test was written.

Additionally, 40 of 65 command files contained redundant prose @-references — the same path appearing once in `<execution_context>` (which loads the file) and again in `<process>` body text (inert). This added ~900 tokens of dead weight per invocation and created a drift seam where prose refs could go stale independently of the executable `execution_context` ref.

The two largest commands (`debug.md`, `thread.md`) embedded their full implementation inline rather than delegating to workflow files, causing ~4,400 tokens of implementation detail to load as part of the skills index description on every session regardless of whether those commands are used.

## Consequences

- A single `lint-command-contract.cjs` script enforces frontmatter invariants across all 65 commands in milliseconds, runs before the test suite in CI
- `tests/command-contract.test.cjs` replaces the scattered contract coverage in `enh-2790` and `bug-3135`, becoming the authoritative behavioral contract test for the entire command surface
- Redundant prose @-refs removed from 40 command files (~900 tokens/invocation recovered)
- `debug.md` and `thread.md` refactored to the workflow-delegation pattern (~4,400 tokens removed from eager system-prompt load)
- `workflows/extract_learnings.md` renamed to `workflows/extract-learnings.md` to align with the hyphen convention used by all other workflow files
- The `execution_context` block is the single authoritative declaration of what a command loads — no duplication in prose

# GSD Core — Antigravity CLI context

> **Gemini CLI was sunset by Google on 2026-06-18** and is no longer served for
> free/Pro/Ultra tiers. Antigravity CLI is its official successor, and this file
> is the context Antigravity reads automatically (its `contextFileName` is
> `GEMINI.md`, inherited from the shared Gemini 3 backend).

This context gives Antigravity the operating context for
[GSD Core](https://github.com/open-gsd/gsd-core), a meta-prompting,
context-engineering, and spec-driven development system for AI coding agents.

## What GSD is

GSD turns a vague goal into shipped software through an explicit,
resumable workflow: **explore → plan → execute → verify → ship**. Work is
organised into milestones and phases under a `.planning/` directory, with each
phase carrying a SPEC, a PLAN, and verification criteria. The system favours
small, atomic, test-backed commits and keeps durable context in version-tracked
files rather than in the conversation.

## The slash commands (installed separately)

> **This file ships only the context above — not the slash commands.** To
> install the `/gsd-*` command set, agents, and hooks into `~/.gemini/antigravity/`,
> run the dedicated installer:
>
> ```bash
> npx gsd-core --antigravity --global
> ```
>
> The commands below are available only once that installer has run.

If you have installed the gsd commands, the workflow is driven by these `/gsd-*`
slash commands (Antigravity registers gsd's commands under a hyphenated
namespace):

- `/gsd-new-project` — initialise a project and gather deep context.
- `/gsd-progress` — the unified situational command: check progress, advance the
  workflow, or dispatch a freeform intent.
- `/gsd-plan-phase <N>` — produce a detailed phase plan with a verification loop.
- `/gsd-execute-phase <N>` — execute a phase's plans with wave-based parallelism.
- `/gsd-verify-work` — validate built features through conversational UAT.
- `/gsd-ship` — open a PR, run review, and prepare for merge.
- `/gsd-help` — list every available command.

## Working with GSD

- Treat `.planning/` as the source of truth for project state — read it before
  acting, and keep it current as work progresses.
- Prefer the smallest change that satisfies the phase's verification criteria.
- Run the project's tests and linters before declaring a phase done.
- When unsure what to do next, and the gsd commands are installed, `/gsd-progress`
  is the situational entry point.

## Contributing Standards & PR Workflow

Whenever preparing bug fixes, enhancements, or features for `open-gsd/gsd-core`:

1. **Pre-Approved Issue Check**:
   - Ensure the linked issue carries a maintainer-applied approval label (`confirmed-bug`, `approved-enhancement`, or `approved-feature`).

2. **Branch & PR Title Format**:
   - Branch format: `fix/<issue>-<short-description>` or `feat/<issue>-<short-description>`.
   - PR Title format: `type(#<issue>): summary` (e.g., `fix(#2787): clarify broken-windows ship blocking enforcement`).
   - PR Body format: MUST use `.github/PULL_REQUEST_TEMPLATE/fix.md` (or `enhancement.md` / `feature.md`) verbatim, with `Fixes #<issue>` under `## Linked Issue`.

3. **Changeset Fragment Schema**:
   - Create `.changeset/<short-name>-<issue>.md` with required GSD frontmatter format (do NOT use `@opengsd/gsd-core: patch`):
     ```markdown
     ---
     type: Fixed
     pr: <PR_NUMBER>
     ---
     **`summary`** — description of change. (#<issue>)
     ```
   - Always run `npm run lint:changeset` to validate frontmatter structure.

4. **Regression Test Protocol**:
   - Every bug fix MUST include a dedicated `tests/<name>.test.cjs` behavioral test file (`scripts/lint-fix-has-regression-test.cjs` enforces this).
   - Assert **runtime behavioral contracts** (functions, JSON outputs, CLI returns).
   - **NO Source-Grepping `.cts` Files**: `CONTRIBUTING.md:569` strictly bans reading `.cts` files with `readFileSync` or regex to assert comments/literals. `// allow-test-rule: source-text-is-the-product` is restricted exclusively to Markdown `.md` files.
   - **Failing-First Test Cycle**: Test MUST fail when executed against `upstream/next` (RED) and pass on the feature branch (GREEN). Never write pass-always / vacuous assertions.
   - **Real Dependency Coverage**: Use real dependency-injected factories (e.g. `buildPredicateDeps()`) and real temporary directory structures (`.planning/WINDOWS.md`), not mock functions that diverge from production behaviors.

5. **Runtime Data Handling Standards**:
   - **Frontmatter Values**: Frontmatter parsers may return numbers as strings (e.g., `"0"` vs `0`); equality evaluators must coerce or support numeric-string equivalence.
   - **Scope Boundaries**: Headings-based Markdown parsers (`stripDeferredSections`) must resume parsing when encountering a non-deferred heading at or above the deferred heading level.
   - **Async State Polling**: Async GitHub CLI operations (`mergeStateStatus`) must poll with backoff rather than single sleep calls, handle `UNKNOWN` states gracefully, and include push-failure fallbacks (`2>&1 || echo ...`).

6. **Pre-Push Quality Gate**:
   - Always run `npm run build:lib && npm run lint:changeset && npm run lint:ci && npm test` prior to opening a PR or pushing.

Learn more: <https://github.com/open-gsd/gsd-core>


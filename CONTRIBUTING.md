# Contributing to GSD Core

## Getting Started

```bash
# Clone the repo
git clone https://github.com/open-gsd/gsd-core.git
cd gsd-core

# Activate the pinned Node version from .nvmrc
nvm use

# Validate your environment
npm run check:env

# Install dependencies (reproducible, lockfile-driven)
npm ci

# Run tests
npm test
```

`npm ci` is required over `npm install`. It installs exactly what `package-lock.json`
specifies and fails fast if the lockfile is out of sync — this is intentional.

**[docs/contributing/bootstrap.md](docs/contributing/bootstrap.md)** is the source of truth
for setup. See it for Node version managers other than nvm (fnm, asdf, mise), the
environment validator, daily commands, and troubleshooting.

---

## Types of Contributions

GSD accepts three types of contributions. Each type has a different process and a different bar for acceptance. **Read this section before opening anything.**

### 🐛 Fix (Bug Report)

A fix corrects something that is broken, crashes, produces wrong output, or behaves contrary to documented behavior.

**Process:**
1. Open a [Bug Report issue](https://github.com/open-gsd/gsd-core/issues/new?template=bug_report.yml) — fill it out completely.
2. Wait for a maintainer to confirm it is a bug (label: `confirmed-bug`). For obvious, reproducible bugs this is typically fast.
3. Fix it. Write a test that would have caught the bug.
4. Open a PR using the [Fix PR template](.github/PULL_REQUEST_TEMPLATE/fix.md) — link the confirmed issue.

**Rejection reasons:** Not reproducible, works-as-designed, duplicate of an existing issue.

---

### ⚡ Enhancement

An enhancement improves an existing feature — better output, faster execution, cleaner UX, expanded edge-case handling. It does **not** add new commands, new workflows, or new concepts.

**The bar:** Enhancements must have a scoped written proposal approved by a maintainer before any code is written. A PR for an enhancement will be closed without review if the linked issue does not carry the `approved-enhancement` label.

**Process:**
1. Open an [Enhancement issue](https://github.com/open-gsd/gsd-core/issues/new?template=enhancement.yml) with the full proposal.  The issue template requires: the problem being solved, the concrete benefit, the scope of changes, and alternatives considered.
2. **Wait for maintainer approval.** A maintainer must label the issue `approved-enhancement` before you write a single line of code. Do not open a PR against an unapproved enhancement issue — it will be closed.
3. Write the code. Keep the scope exactly as approved. If scope creep occurs, comment on the issue and get re-approval before continuing.
4. Open a PR using the [Enhancement PR template](.github/PULL_REQUEST_TEMPLATE/enhancement.md) — link the approved issue.

**Rejection reasons:** Issue not labeled `approved-enhancement`, scope exceeds what was approved, no written proposal, duplicate of existing behavior.

---

### ✨ Feature

A feature adds something new — a new command, a new workflow, a new concept, a new integration. Features have the highest bar because they add permanent maintenance burden to a solo-developer tool maintained by a small team.

**The bar:** Features require a complete written specification approved by a maintainer before any code is written. A PR for a feature will be closed without review if the linked issue does not carry the `approved-feature` label. Incomplete specs are closed, not revised by maintainers.

**Process:**
1. **Discuss first** — check [Discussions](https://github.com/open-gsd/gsd-core/discussions) to see if the idea has been raised. If it has and was declined, don't open a new issue.
2. Open a [Feature Request issue](https://github.com/open-gsd/gsd-core/issues/new?template=feature_request.yml) with the complete spec. The template requires: the solo-developer problem being solved, what is being added, full scope of affected files and systems, user stories, acceptance criteria, and assessment of maintenance burden.
3. **Wait for maintainer approval.** A maintainer must label the issue `approved-feature` before you write a single line of code. Approval is not guaranteed — GSD is intentionally lean and many valid ideas are declined because they conflict with the project's design philosophy.
4. Write the code. Implement exactly the approved spec. Changes to scope require re-approval.
5. Open a PR using the [Feature PR template](.github/PULL_REQUEST_TEMPLATE/feature.md) — link the approved issue.

**Rejection reasons:** Issue not labeled `approved-feature`, spec is incomplete, scope exceeds what was approved, feature conflicts with GSD's solo-developer focus, maintenance burden too high.

---

### 📐 Proposing an ADR or PRD

An ADR (Architecture Decision Record) documents a significant architectural decision. A PRD (Product Requirements Document) captures the what and why of a feature before implementation. Both are governed by the same issue-first rule as everything else.

**Process:**

1. Open an issue of the appropriate type (enhancement for an ADR revisiting an existing area, feature for a new architectural surface, chore for policy/docs decisions). Fill it out completely.
2. **Wait for maintainer approval.** A maintainer must label the issue `approved-enhancement`, `approved-feature`, or confirm the chore before any file is created.
3. The GitHub-assigned issue number becomes your filename prefix. Create the file on a branch named after the issue:
   - `docs/adr/<issue#>-<slug>.md` for ADRs
   - `docs/prd/<issue#>-<slug>.md` for PRDs
   - Branch: `docs/<issue#>-<slug>`
4. Open a PR using the appropriate template and close the issue with `Closes #<issue#>` in the PR body.

**One issue = one ADR-or-PRD = one PR.** Do not batch multiple decisions into one file or one PR.

**Do not compute a "next number" locally.** Any PR that uses the legacy `NNNN-*` sequential pattern for a *new* ADR or PRD will be asked to rename the file to the `<issue#>-<slug>.md` format before merge.

**Example:** Issue #2264 was opened, approved, and its number became the prefix: `docs/adr/2264-golden-parity-redesign.md`.

**Rejection reasons:** Issue not approved before file was created, filename uses local-compute sequential number instead of issue#, multiple decisions bundled in one PR, file placed in wrong directory (`docs/adr/` vs `docs/prd/`).

**This process is for a *new* ADR file.** An accepted ADR is never rewritten from scratch — check `docs/adr/` first for a broader ADR that already owns the area. Amending one is a separate, lighter-weight path: see **[`docs/contributor-standards.md` — "Amending an accepted ADR"](docs/contributor-standards.md#amending-an-accepted-adr)** for the two established patterns (an in-place dated section, or a new ADR that declares `Amends`/gets the reciprocal `Amended by` back-link).

---

## The Issue-First Rule — No Exceptions

> **No code before approval.**

For **fixes**: open the issue, confirm it's a bug, then fix it.
For **enhancements**: open the issue, get `approved-enhancement`, then code.
For **features**: open the issue, get `approved-feature`, then code.

PRs that arrive without a properly-labeled linked issue are closed automatically. This is not a bureaucratic hurdle — it protects you from spending time on work that will be rejected, and it protects maintainers from reviewing code for changes that were never agreed to.

---

## Where Do I Open My PR? (Branching Model)

GSD uses two long-lived branches: `main` (production, what's on npm `@latest`)
and `next` (integration for the upcoming release). **Almost every PR targets
`next`.** Full guide: [`docs/branching.md`](docs/branching.md).

| Your branch | PR target | Notes |
|---|---|---|
| `feat/NNN-slug` | `next` | Default for all new features |
| `fix/NNN-slug` | `next` | Default for all bug fixes; ships in next minor or via hotfix cherry-pick |
| `chore/`, `docs/`, `refactor/`, `test/`, `perf/`, `ci/`, `revert/` | `next` | All routine work |
| `fix/critical-NNN-slug` | `main` | Production-down emergencies only; auto-back-merges to `next` |
| `release/X.Y.0` | `main` | Created by `release.yml` — don't make these by hand |
| `hotfix/X.Y.Z` | `main` | Created by `release.yml` (dispatch with a patch version X.Y.Z) — don't make these by hand |
| Stabilization PR for an in-flight release | `release/X.Y.0` | Fix a regression found during the RC cycle |

**Day-to-day commands:**

```bash
git fetch origin
git checkout next
git pull --ff-only origin next
git checkout -b fix/3187-config-corruption
# ... commit, push
gh pr create --base next --repo open-gsd/gsd-core
```

If you target the wrong branch by accident, the `PR Target Validator`
workflow will post a comment with the one-line fix (click "Edit" by the PR
title and change the base branch — no need to recreate the PR).

**Why this matters:** Under the old single-branch model, every PR rebased onto
`main`, which moved on every merge. `next` moves far less often — only when
another PR to `next` lands — so in practice you rebase much less.

**But `next` does still require "up-to-date before merging".** Branch
protection has `required_status_checks.strict = true`; check it yourself with
`gh api repos/open-gsd/gsd-core/branches/next/protection --jq '.required_status_checks.strict'`.
If another PR lands while yours is open, yours goes `BEHIND` and must be
rebased before it can merge.

Budget for that, because the rebase is not free here: **it changes your HEAD
sha, which invalidates the sha-bound pass marker the push gate reads**, so a
rebase means re-running the full remote verification and another CI cycle
before the gate clears again. Rebase *last* — immediately before you push for
review — rather than paying for a verification you are about to discard.

---

## Pull Request Guidelines

### Architecture & Domain Standards (Maintainer-Defined)

The following files are maintainer-owned coding standards and must be treated as canonical when contributing:

- `CONTEXT.md` — domain language and module naming standards
- `docs/adr/` — Architecture Decision Records (ADRs) for accepted architectural decisions

Full contributor requirements — including CONTEXT.md format, ADR governance, and AI-agent-assisted work standards — are in **[`docs/contributor-standards.md`](docs/contributor-standards.md)**.

Contributor requirements (summary):
- Read `CONTEXT.md` before naming or refactoring modules/interfaces/seams.
- Use `CONTEXT.md` vocabulary consistently in code comments, tests, issue/PR text, and docs for the touched area.
- Check relevant ADRs in `docs/adr/` before proposing or implementing architectural changes.
- If a change intentionally revisits an ADR decision, call it out explicitly in the linked issue and PR rationale.
- Do not rewrite maintainer intent in `CONTEXT.md`/ADRs as part of drive-by cleanup; propose focused updates tied to approved scope.
- If using an AI assistant, prompt it to read `CONTEXT.md` and the relevant ADRs before writing any code or docs, and verify it used the correct vocabulary before opening the PR.

**Every PR must link to an approved issue.** PRs without a linked issue are closed without review, no exceptions.

- **No draft PRs** — draft PRs are automatically closed. Only open a PR when it is complete, tested, and ready for review. If your work is not finished, keep it on your local branch until it is.
- **Use the correct PR template** — there are separate templates for [Fix](.github/PULL_REQUEST_TEMPLATE/fix.md), [Enhancement](.github/PULL_REQUEST_TEMPLATE/enhancement.md), and [Feature](.github/PULL_REQUEST_TEMPLATE/feature.md). Using the wrong template or using the default template for a feature is a rejection reason.
- **Link with a closing keyword** — use `Closes #123`, `Fixes #123`, or `Resolves #123` in the PR body. The CI check will fail and the PR will be auto-closed if no valid issue reference is found.
  - **Test-only and docs-only follow-up PRs may reference without closing.** If your PR is documentation or regression coverage only — say, a repo-wide guard for a fix that already shipped — and there is no open issue for it to close, use a non-closing reference instead: `Refs #123`. `Ref`, `Refs`, `References`, `Relates to`, `Related to`, and `Follow-up to` are all accepted in that position. Do **not** write a closing keyword against an already-closed issue to satisfy the check; on merge it closes nothing, and it trains readers to treat closing keywords as decorative.
  - **Qualifying diff shape:** every changed file must be under `tests/`, under `docs/`, or a root-level `*.md` (`README.md`, `CONTRIBUTING.md`, …). This mirrors the doc-only classification the push gate already uses, and it is deliberately root-only — markdown under a subdirectory (`gsd-core/workflows/*.md`, `agents/*.md`, `commands/**/*.md`) is runtime-loaded text, not documentation, so it still requires a closing keyword. `CHANGELOG.md` is excluded too: edit it through a `.changeset/` fragment, never directly.
  - This weaker form is accepted **only** for that diff shape. A PR touching anything else still needs a closing keyword, and a PR with no issue reference at all still fails. On a very large PR (more than 100 changed files) the check cannot confirm the diff shape and falls back to requiring a closing keyword.
- **One concern per PR** — bug fixes, enhancements, and features must be separate PRs
- **No drive-by formatting** — don't reformat code unrelated to your change
- **Don't bundle test-fixture updates into `docs:` or unrelated commits** — when a production change makes an existing test assertion stale, the test correction MUST land as its own `test:` (or `fix:`) commit, not bundled into a `docs:` commit that also updates the explanation. The release-sdk hotfix cherry-pick filter routes by commit-subject prefix (`fix:`, `chore:`, `test:`); a test-fixture correction packed under a `docs:` prefix is invisible to the picker and ships a half-state to the hotfix branch — production code changed, test assertion stale. v1.42.3 hit this exact mode (#3621). The fix is upstream: keep the test-fixture commit separate.
- **CI must pass** — all configured matrix jobs must be green. Node 24 is the compatibility floor and primary target; Node 26 compatibility must be preserved for code and tests even when a Node 26 CI lane is not yet available.
- **Scope matches the approved issue** — if your PR does more than what the issue describes, the extra changes will be asked to be removed or moved to a new issue

## CHANGELOG Entries — Drop a Fragment

**Do not edit `CHANGELOG.md` directly.** Two PRs that both append to a `### Fixed` block always conflict on merge — git can't pick a serialization order without a human. Instead, every PR with user-facing changes drops a fragment file in `.changeset/`.

```bash
npm run changeset -- --type Fixed --pr <YOUR_PR_NUMBER> \
  --body "**\`/gsd-foo\` no longer drops trailing slashes** — explain the user-visible change."
```

This writes `.changeset/<adjective>-<noun>-<noun>.md`. Three random words → concurrent PRs never collide. Allowed `type:` values follow [Keep a Changelog](https://keepachangelog.com/): `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

Fragments are consolidated into `CHANGELOG.md` at release time by the release workflow. See [`.changeset/README.md`](.changeset/README.md) for the format spec and [#2975](https://github.com/open-gsd/gsd-core/issues/2975) for the rationale.

**CI enforcement:** the `Changeset Required` workflow (`scripts/changeset/lint.cjs`) fails any PR that touches `bin/`, `gsd-core/`, `src/`, `agents/`, `commands/`, `hooks/`, or `sdk/src/` without a `.changeset/*.md` fragment. (`src/` is the TypeScript source of truth compiled into `gsd-core/bin/lib/*.cjs`, so editing it is a user-facing change even though the generated `.cjs` is gitignored and never appears in the diff.)

> **Running it locally.** The lint derives its changed-file set from `GITHUB_BASE_REF`, which only CI sets. `node scripts/changeset/lint.cjs` on a developer machine therefore does **not** evaluate your branch and can report success on a PR that CI will fail. Pass the base explicitly to reproduce the CI result:
>
> ```bash
> GITHUB_BASE_REF=next node scripts/changeset/lint.cjs
> ``` The gate also **validates the content** of every changed fragment: a fragment whose frontmatter does not parse (e.g. a `pr: 0` placeholder that was never backfilled to the real PR number) fails the gate with `fail_invalid_fragment`, naming the offending file. This stops a malformed fragment from merging to `next` and only detonating later in the release job's CHANGELOG render.

**Opt-out:** PRs with no user-facing impact (test refactors, lint config changes, CI tweaks, formatting-only changes) can add the `no-changelog` label. The lint honors it. When unsure whether a change is user-facing, **add the fragment**.

### Release notes formatting

GitHub release notes are generated automatically. The release and hotfix
workflows first create the release with `gh release create --generate-notes`,
then run `scripts/release-notes/format-github-release-notes.cjs --apply` to
rewrite the body into the project's curated format: an **Install** block,
followed by **What's Changed** grouped into **Feature** / **Enhancement** /
**Fix** sections (classified by each PR's conventional-commit title prefix —
`feat` → Feature, `fix` → Fix, non-user-facing types `test`/`chore`/`ci`/`docs`/`refactor`/`perf`/`revert` → omitted from the user-facing notes, everything else → Enhancement), then
**New Contributors** and the **Full Changelog** link.

To re-format an existing release by hand (e.g. backfilling an older release):

```bash
node scripts/release-notes/format-github-release-notes.cjs \
  --tag vX.Y.Z --repo open-gsd/gsd-core --apply
```

Omit `--apply` to print the reformatted body to stdout for review without
publishing.

### PR title convention (enforced at open time)

Because the changelog is built from PR titles, your **PR title** must follow:

```
type(#<issue>): short summary
```

- **Start with the type** — `feat`, `fix`, or any other conventional type
  (`chore`, `docs`, `refactor`, …). No leading tags or prefixes: a title like
  `[security] fix(config): …` defeats the `^fix` bucket anchor and silently
  files the entry under the wrong changelog section.
- **Put the linked issue ref in the scope** — `(#<digits>)`. This is what
  renders as a link to the issue in the changelog line. `fix(core): …` buckets
  correctly but produces a changelog entry with **no issue link**.
- A breaking-change marker is fine: `feat(#42)!: …`.

Examples: `fix(#1542): roadmap rollback`, `feat(#39): milestone-prefixed phase IDs`,
`enhance(#1549): add PR-title validator`.

**CI enforcement:** `pr-title-validator.yml` checks the title on open/edit and
fails with the required format if it doesn't conform. It reuses the same matcher
the changelog classifier uses (`scripts/release-notes/conventional-title.cjs`), so a title
that passes the check is guaranteed to bucket and link correctly. Fix a flagged
title by editing it in place — the check re-runs on edit, no need to recreate
the PR.

## Documentation Updates — Update the Relevant Docs

If your PR adds, changes, deprecates, or removes user-visible behavior, you **must** update the relevant documentation in `docs/`. CI will fail any PR whose changeset fragment is typed `Added`, `Changed`, `Deprecated`, or `Removed` without also modifying at least one file under `docs/` ([#3213](https://github.com/open-gsd/gsd-core/issues/3213)).

`Fixed` and `Security` fragments do not trigger this lint — bug fixes restore documented behavior, they do not introduce new behavior to document. (Edit the docs anyway if a fix corrects something the docs got wrong.)

### Which docs to update

| Change type | Required doc updates |
|---|---|
| New command or flag | `docs/COMMANDS.md`, `docs/FEATURES.md` |
| Changed command behavior or output | `docs/USER-GUIDE.md`, `docs/COMMANDS.md` |
| Configuration / schema change | `docs/CONFIGURATION.md` |
| Architectural change | `docs/ARCHITECTURE.md`, `docs/adr/` |
| Agent or skill change | `docs/AGENTS.md` |
| Removed command, flag, or workflow | All docs that referenced it |

### Language policy

All content in `docs/` and the root `README.md` **must be written in English**. English is the canonical source. The translated READMEs (`README.pt-BR.md`, `README.zh-CN.md`, `README.ja-JP.md`, `README.ko-KR.md`) are community-maintained translations and do not need to be updated by every PR.

### CI enforcement

The `Docs Required` workflow (`scripts/lint-docs-required.cjs`) reads the changeset fragments touched in the PR diff. If any has type `Added` / `Changed` / `Deprecated` / `Removed`, it requires at least one file under `docs/` to also appear in the diff.

### Opt-outs (with paper trail)

When a change genuinely has no user-facing documentation impact (infrastructure rewrite, internal refactor, test-only addition, CI fix), use one of:

- **Label:** add the `no-docs` label to the PR. Leave a comment explaining why no docs update was needed.
- **Per-fragment marker:** add `<!-- docs-exempt: <reason> -->` **on its own line** inside the body of each triggering changeset fragment (typically at the end). The reason is **required and must be non-empty** — a bare `<!-- docs-exempt -->` or `<!-- docs-exempt: -->` is rejected (no audit trail = no exemption). The marker is extracted at parse time by `scripts/changeset/parse.cjs` and stripped from the body before the CHANGELOG.md and GitHub release-notes serializers see it — it leaves a paper trail in the source fragment without leaking into published release notes. Inline mentions of the marker syntax (e.g. inside backticks) are intentionally ignored; the parser only acts on a marker that occupies its own line. Both routes leave a paper trail; the label is global, the marker is per-fragment for mixed PRs.

When unsure whether a change is user-facing, **update the docs**.

### Adding a feature to `docs/FEATURES.md`

**`docs/FEATURES.md` is generated. Do not edit it by hand.** Add one fragment
under `docs/features/` and regenerate:

```
docs/features/<kebab-slug>.md
```

```markdown
---
id: 3840
title: Runtime Identity
group: v1.7.0 Features
---

**Purpose:** …
```

Then run `npm run regen:derived` (or just `npm run gen:features -- --write`) and
commit both the fragment and the regenerated `docs/FEATURES.md`.
`npm run lint:generated-sync` runs the `--check` twin, so a stale index cannot
merge. `--write` is fail-closed: it refuses to emit `docs/FEATURES.md` while any
fragment violation stands, so a `--write && git commit` chain cannot commit a
corrupt file. Pass `--force` only to see what a broken corpus would render as.

**Why fragments.** The old practice hand-allocated a monotonically increasing
integer at authoring time, and every feature PR wrote into *two* shared mutable
cells: the `### N.` heading and the hand-maintained table of contents. With
several PRs in flight everyone picked the same next integer, and two PRs adding
*differently numbered* features still collided on the TOC. #3831 was renumbered
165 → 166 → 167 → 168 across successive rebases — the last collision landing
*during* a verification run — and because every rebase invalidates the sha-keyed
pass marker, each collision also cost a full remote matrix run. This is the same
fix `.changeset/` already applies to `CHANGELOG.md`: one file per
contribution, consolidated by a generator. You add a new file and touch no
shared file, so there is nothing to collide on.

**The rules:**

1. **Any unique `id` is legal.** It does not have to be contiguous or maximal —
   58, 113 and 131 are already absent, and `6.5`, `27a` and `27b` are live
   non-integer ids. **Use your issue number** and you never have to revisit the
   choice after a rebase. `--check` rejects a duplicate with an `id_duplicate`
   violation naming both fragments, so a collision is a loud one-line fix in
   your own file, not a merge conflict.
2. **Never renumber a merged feature.** `id` is frozen once it ships: other docs
   link to `FEATURES.md#<id>-<slug>`, and `--check` now verifies every one of
   those inbound anchors resolves (`inbound_anchor_unresolved`). Renaming the
   *title* moves the anchor too — fix the inbound links in the same commit.
3. **Groups are derived, not registered.** `group` is the `##` heading text.
   Groups are ordered by their lowest-ordered member, so adding a release bucket
   is just the first fragment that names it. Optional per-group prose lives in
   `docs/features/_groups/<slug>.md`, which a feature PR never touches.
4. **`order` is optional.** It defaults to the numeric part of `id`, which is
   right for almost everything. Declare it only to place a section somewhere its
   number would not put it (`27b` precedes `27a` for historical reasons). When
   declared it must be an optionally-signed integer or decimal — `27`, `0`,
   `-1`, `+3`, `27.2`. Anything else is an `order_invalid` violation, including
   an empty value, a hex/binary/octal literal and exponential notation: all of
   those coerce to a finite number under JavaScript's `Number()`, so before
   #3840 a bare `order:` sorted the section to position 0 — ahead of every real
   feature — with no violation and a clean `--check`.
5. **Bodies start at `####`.** A `##` or `###` inside a fragment body would
   forge a group or a sibling section with no id and no TOC entry; `--check`
   rejects it (`body_heading_too_shallow`).

**Fork contributors:** there is nothing to coordinate and nothing to chase. Pick
your issue number, add your file, regenerate. If `docs/FEATURES.md` conflicts on
a rebase, discard your side and re-run `--write` — it is a derived artifact.

**Agents:** no Fleet allocation lease is needed for a feature number any more.
The lease that used to serialize `docs/FEATURES.md::section-number-allocation`
protected an invariant that no longer exists.

## Testing Standards

All tests use Node.js built-in test runner (`node:test`) and assertion library (`node:assert`). **Do not use Jest, Mocha, Chai, or any external test framework.**

> **Suite grouping.** Tests live in named suites (`unit`, `integration`, `install`, `security`, `slow`) selected by **filename suffix**: a file named `foo.security.test.cjs` belongs to the `security` suite; a file with no suffix (`foo.test.cjs`) belongs to `unit`. See [docs/TESTING-SUITES.md](docs/TESTING-SUITES.md) for the full policy, CI matrix, and per-suite scripts (`npm run test:unit`, `npm run test:security`, `npm run test:coverage:unit`, …). Default `npm test` still runs every test — backwards compatible.

### Required Imports

```javascript
const { describe, it, test, beforeEach, afterEach, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
```

### Setup and Cleanup

There are two approved cleanup patterns. Choose the one that fits the situation.

**Pattern 1 — Shared fixtures (`beforeEach`/`afterEach`):** Use when all tests in a `describe` block share identical setup and teardown. This is the most common case.

```javascript
// GOOD — shared setup/teardown with hooks
describe('my feature', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('does the thing', () => {
    assert.strictEqual(result, expected);
  });
});
```

**Pattern 2 — Per-test cleanup (`t.after()`):** Use when individual tests require unique teardown that differs from other tests in the same block.

```javascript
// GOOD — per-test cleanup when each test needs different teardown
test('does the thing with a custom setup', (t) => {
  const tmpDir = createTempProject('custom-prefix');
  t.after(() => cleanup(tmpDir));

  assert.strictEqual(result, expected);
});
```

**Never use `try/finally` inside test bodies.** It is verbose, masks test failures, and is not an approved pattern in this project.

```javascript
// BAD — try/finally inside a test body
test('does the thing', () => {
  const tmpDir = createTempProject();
  try {
    assert.strictEqual(result, expected);
  } finally {
    cleanup(tmpDir); // masks failures — don't do this
  }
});
```

> `try/finally` is only permitted inside standalone utility or helper functions that have no access to test context.

### Use Centralized Test Helpers

Import helpers from `tests/helpers.cjs` instead of inlining temp directory creation:

```javascript
const { createTempProject, createTempGitProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
```

| Helper | Creates | Use When |
|--------|---------|----------|
| `createTempProject(prefix?)` | tmpDir with `.planning/phases/` | Testing GSD tools that need planning structure |
| `createTempGitProject(prefix?)` | Same + git init + initial commit | Testing git-dependent features |
| `createTempDir(prefix?)` | Bare temp directory | Testing features that don't need `.planning/` |
| `cleanup(tmpDir)` | Removes directory recursively | Always use in `afterEach` |
| `runGsdTools(args, cwd, env?)` | Executes gsd-tools.cjs | Testing CLI commands |

### Spawning a subprocess: use the process seam

Anything that shells out goes through `tests/helpers/process-seam.cjs` — never a hand-rolled
`spawnSync`/`execFileSync` in your suite.

```javascript
const { runNode, runGit, runHook, OUTCOME } = require('./helpers/process-seam.cjs');

const r = runHook(HOOK_PATH, [], { input: JSON.stringify(payload), timeoutMs: 5000 });
assert.equal(r.outcome, OUTCOME.EXITED);
assert.equal(r.exitCode, 0);
```

| Primitive | Spawns |
|---|---|
| `runNode(argv, opts)` | `process.execPath` |
| `runGit(argv, opts)` | `git` |
| `runHook(scriptPath, argv, opts)` | `opts.interpreter` (default `process.execPath`; pass `'bash'` for a shell script) |

`opts`: `{ cwd, env, input, timeoutMs, killSignal, interpreter }`.

Every call returns the same discriminated union — `{ outcome, exitCode, stdout, stderr, timedOut,
signal, killed, code }` — and **never throws** for a child's exit code, a timeout, a buffer
overflow, or a spawn failure. All four are data, so you assert on them:

```javascript
assert.equal(r.outcome, OUTCOME.TIMED_OUT);
assert.equal(r.timedOut, true);
```

Two rules the seam enforces for you:

- **Every call is timeout-bounded.** `timeoutMs` defaults to 60s; there is no unbounded path. An
  unbounded subprocess is an indefinite hang, and it is how macOS CI silently stops reporting.
- **`outcome` distinguishes cases that look identical.** A timeout and a `maxBuffer` overflow both
  report `exitCode: null` and `signal: 'SIGTERM'`, differing only in `code` (`ETIMEDOUT` vs
  `ENOBUFS`). Branch on `outcome`, never on `signal`.

The seam is **not** a fault-injection surface — it cannot tell an injected timeout from a genuine
bench OOM. Inject faults in-process through a module's `deps` parameter instead.

Per-suite wrappers are still expected and encouraged: bind your fixture (cwd, env, payload) in a
local helper and delegate the spawn to the seam.

**Class-norm timeouts live in `tests/helpers/timeouts.cjs`** — `PROBE_TIMEOUT_MS`,
`GIT_TIMEOUT_MS`, `BUILD_TIMEOUT_MS`, `INSTALL_TIMEOUT_MS`. These describe how long a whole CLASS
of subprocess call takes (a CLI probe, git plumbing on a fixture repo, a hooks build, a full
`bin/install.js` run), not a single suite's preference, so import them rather than re-declaring the
same literal with the same comment in yet another file. Only write a local constant when a site
genuinely differs from its class (a real `tsc` compile, a `regen:derived` run, ...) — and give that
local constant its own justifying comment explaining why it departs from the norm.

#### When you want git to *throw*: `gitOrThrow`

`runGit` never throws — that is the whole point of it. But `execSync` and `execFileSync` **do**
throw on a non-zero exit, and a lot of fixture setup relies on that: `git commit` failing should
stop the test right there, not hand back an empty string that produces a baffling assertion failure
twenty lines later.

For that case use `tests/helpers/git-fixture.cjs`:

```javascript
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

gitOrThrow(['init', '-b', 'main'], { cwd: dir });
gitOrThrow(['commit', '-m', 'seed'], { cwd: dir });   // throws if git exits non-zero
const branch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).trim();
```

It returns `stdout` as a **string** on success. On any non-`EXITED` outcome, or a non-zero exit, it
throws an `Error` carrying `status`, `exitCode`, `stdout`, `stderr`, `signal`, `timedOut` and
`outcome` as own properties. `status` and `exitCode` are deliberate aliases: `status` is what the
legacy `execSync` idiom reads (`catch (err) { assert.equal(err.status, 1) }`), so a migrated call
site keeps working.

| You want | Use |
|---|---|
| Every outcome as data; you branch on `outcome` | `runGit` |
| Fixture setup that must abort loudly on failure | `gitOrThrow` |

`process-seam.cjs` itself is untouched by this — it still never throws.

If your per-suite wrapper spawns something that is **not** git — a node CLI via `runNode`, a bash
snippet via `runHook` — and its callers depend on a throw, call `throwIfFailed(result, displayName)`
directly instead of hand-rolling the same `outcome !== EXITED || exitCode !== 0` check. `gitOrThrow`
is itself just `throwIfFailed` bound to `runGit`, so every thrown error — git or not — carries the
same `status`/`exitCode`/`stdout`/`stderr`/`signal`/`timedOut`/`outcome` shape:

```javascript
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const r = runNode([BUILD_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS });
throwIfFailed(r, 'build-hooks.js (before install tests)');
```

#### When you want the legacy shape without a throw: `toLegacyResult`

Some call sites never wanted a throw in the first place — they already branch on exit status as
data, reading `.status`/`.stdout`/`.stderr` off the result themselves. Those still need the seam's
`exitCode` renamed to the legacy `status` field their assertions expect. Use `toLegacyResult`
instead of hand-rolling the three-line mapping — ~8 test files did exactly that independently
before this export existed (#3147):

```javascript
const { toLegacyResult } = require('./helpers/git-fixture.cjs');

function runLint(args = []) {
  const r = runNode([LINT_SCRIPT, ...args], { timeoutMs: PROBE_TIMEOUT_MS });
  return toLegacyResult(r); // { status, stdout, stderr }
}
```

It is a bare mapping and nothing more. If your call site needs an extra field beyond that shape (a
parsed-JSON body, a fixture-specific path alongside the result), compose it rather than extending
the helper: `{ ...toLegacyResult(result), extra }`. And if your site's return shape genuinely
diverges from `{ status, stdout, stderr }` — e.g. it substitutes a parsed report object for raw
`stdout` — leave it as its own local mapping; forcing every result-reshaping helper onto one shared
function is the same drift `toLegacyResult` exists to prevent, just in the other direction.

#### The lint rule that enforces it

`local/no-unbounded-spawn` (`eslint-rules/no-unbounded-spawn.cjs`) fails any `spawnSync`,
`execFileSync` or `execSync` under `tests/` that is not timeout-bounded. It resolves renamed
destructures (`const { execSync: exec } = require('node:child_process')`) and chained requires
(`require('node:child_process').execSync(...)`), so renaming your way around it does not work.

Two things it deliberately rejects, because both look bounded and are not:

- `timeout: 0` — Node reads zero as *no timeout*.
- `timeout: 999999999` — anything above the 600000 ms ceiling is effectively unbounded. Size the
  number to what the command actually runs and say why in a comment.

A non-literal value (`timeout: GIT_TIMEOUT_MS`) is trusted — that is the shape you should be
writing.

When a call genuinely needs more than the 600000 ms ceiling — a full installer run, a build plus
generators — the escape is an inline marker comment, exactly the `// allow-test-rule: <reason>`
idiom above:

```javascript
// allow-spawn-timeout-ceiling: regen:derived chains a full build plus eight generators
timeout: 900000,
```

The reason is required and must be non-empty; a bare `// allow-spawn-timeout-ceiling:` (or one
with only whitespace after the colon) is not an audit trail and still reports `timeoutTooLarge`.
The marker binds only to the call it decorates — either the line immediately above it, or
anywhere inside that call's own source range — never to the rest of the file. Critically, the
escape only ever raises the ceiling for a call that already resolves to a numeric timeout: it
never waives the requirement for a bound. A marked call with no `timeout` at all still reports
`unboundedSpawn`.

There is no allowlist. `eslint-rules/no-unbounded-spawn.allowlist.json` grandfathered files that
predated the rule; the epic that introduced it (#3064) migrated every site across four waves and
deleted the file in its terminal wave (#3148), so `local/no-unbounded-spawn` now runs with **no
exemption surface** across `tests/**`. There is no file to add an entry to — fix the timeout at
the call site instead. The only sanctioned escapes are an explicit `timeout` on a raw spawn (for a
call shape the process seam cannot express, e.g. a `shell: true` invocation for `npm.cmd` on
Windows, or `stdio` redirection to a real fd) and the `// allow-spawn-timeout-ceiling: <reason>`
marker above for a bound over the 600000 ms ceiling. Never reach for `eslint-disable` on this rule
— with the allowlist gone, that is the only remaining way to silence it, and a test asserts that no
such comment exists anywhere under `tests/`.

### Test Structure

```javascript
describe('featureName', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Additional setup specific to this suite
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('handles normal case', () => {
    // Arrange
    // Act
    // Assert
  });

  test('handles edge case', () => {
    // ...
  });

  describe('sub-feature', () => {
    // Nested describes can have their own hooks
    beforeEach(() => {
      // Additional setup for sub-feature
    });

    test('sub-feature works', () => {
      // ...
    });
  });
});
```

### Fixture Data Formatting

Template literals inside test blocks inherit indentation from the surrounding code. This can introduce unexpected leading whitespace that breaks regex anchors and string matching. Construct multi-line fixture strings using array `join()` instead:

```javascript
// GOOD — no indentation bleed
const content = [
  'line one',
  'line two',
  'line three',
].join('\n');

// BAD — template literal inherits surrounding indentation
const content = `
  line one
  line two
  line three
`;
```

### QA Matrix Requirements

Happy-path tests are not enough for code that accepts user input, reads project files, writes to disk, shells out, generates artifacts, or builds prompts. New tests for those areas must include adversarial inputs and negative proof that unsafe behavior did not happen.

See [`TEST-EXAMPLES.md`](TEST-EXAMPLES.md) for concrete demo tests that show these requirements in practice.

**Standing rule for error/fallback branches:** feeding an adversarial input is not sufficient on its own — if the code degrades permissively instead of throwing, the test must assert the *specific* degraded verdict, not just that the call survived. See [`TESTING-STANDARDS.md` — "Standing rule: assert the degraded verdict"](TESTING-STANDARDS.md#standing-rule-assert-the-degraded-verdict-not-just-did-not-throw).

Use this matrix when it applies to the changed surface:

1. Happy path
2. Missing input
3. Empty input
4. Whitespace-only input
5. Malformed input
6. Out-of-range input
7. Duplicate or conflicting input
8. Hostile input
9. Filesystem failure
10. Concurrency or retry
11. Cross-platform path/newline behavior
12. Regression fixture from the linked issue

You do not need all twelve cases for every PR. You do need to cover the cases that match the risk of the touched code. If a case is not applicable, the PR should make that obvious from the issue scope or test rationale.

#### CLI and command routing

Changes to CLI parsing, command dispatch, query dispatch, command routers, `gsd-tools`, or `gsd-sdk` must include a negative input matrix for the affected command family.

Required cases where relevant:

- Missing required arguments
- Empty strings, for example `--phase ""`
- Whitespace-only values
- Duplicate flags, for example `--phase 1 --phase 2`
- Conflicting flags, for example `--json --raw`
- Malformed assignments, for example `--phase=` and `--phase==1`
- Unknown subcommands at the touched command depth
- Values that look like flags, for example `--name --weird`
- Very long values and Unicode values
- Shell metacharacters in values, for example `;`, `&&`, `$()`, backticks, and quotes

CLI tests must assert on the full command contract:

- Exit status
- Structured `--json` result when the command supports JSON
- Filesystem mutation or absence of mutation
- No stack trace in non-debug failure output
- No shell interpolation of attacker-controlled values

Prefer `spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: 'utf8' })` or `execFileSync()` with argv arrays. Do not use shell strings for tests that contain hostile values.

#### Parser and project-file inputs

Changes to markdown, TOML, frontmatter, roadmap, phase, state, config, or schema parsing must include adversarial fixtures. Put reusable fixtures under `tests/fixtures/adversarial/` with a directory that names the input type, such as `roadmap/`, `frontmatter/`, `config/`, `toml/`, or `planning-state/`.

Required cases where relevant:

- Malformed frontmatter
- Duplicate keys
- Mixed CRLF/LF newlines
- Unclosed or nested fenced code blocks
- Headings inside fenced code blocks
- Unicode headings
- Repeated or decimal phase IDs
- Path traversal-like names such as `../../x`
- Null bytes or replacement characters
- Huge but bounded files
- TOML duplicate tables or trailing garbage
- Empty arrays vs missing arrays
- Scalars where arrays are expected, and objects where strings are expected

Property-style parser tests are encouraged for high-risk parsers. They must be deterministic: pin the seed, bound the iteration count, and print replay data on failure.

##### Fixture provenance (#2371)

**A gate's fixtures may not be derived from the gate's own writer, grammar, or docstring examples. A negative fixture must come from a source that does not know the gate exists.**

This is stricter than the adversarial-input rule above and exists because of it: `tests/fixtures/adversarial/` covers hostile input, but a fixture written by the parser's own author — even a deliberately "realistic" one — is still drawn from the author's mental model of the format. It can only ever confirm what the author already believed, never surface what they didn't anticipate. A property-test generator has the same failure mode one level up: seeding the generator from the writer/render function that produces the same format makes the document shape a constant, so the property can never explore a document the writer wouldn't produce (see the document-shaped vs. writer-seeded property tests in `tests/api-coverage.test.cjs` for a worked example — the writer-seeded one cannot fail against a decoy table; the document-shaped one can).

For a gate whose fixtures come from real user reports, put them under `tests/fixtures/representative/<gate>/` with a `MANIFEST.json` labeling each fixture's source issue and expected gate verdict, and drive them through the gate's real CLI entrypoint (gate-verdict altitude), not the parser function in isolation — see `tests/fixtures/representative/README.md` and `tests/representative-corpus.test.cjs`. If the gate is not yet fixed, do not mark the assertion `{ todo: true }` and do not skip it: this repo's test-runner (`gsd-test` / `gsd-test-runner`) has no concept of node:test's `todo` option — its JSONL result parser only recognizes `kind: "pass" | "fail"`, so a thrown todo-marked test is still counted as a real failure and blocks the push gate. Instead record BOTH the correct target verdict (`expected*`) and the exact current observed verdict (`currentBuggyOutput`) in the manifest, and assert against `currentBuggyOutput` — an honest, non-vacuous characterization of today's known-broken behavior that passes today and breaks loudly the moment the real fix changes the observed output, forcing the assertion to be flipped to `expected*`.

#### Filesystem writes and installers

Changes to install/uninstall flows, generated artifact writers, state/config writers, worktree safety, or any code that writes under `.planning`, runtime config dirs, `.claude`, `.codex`, `hooks`, or generated files must include fault-injection coverage where the seam allows it.

Required cases where relevant:

- Missing parent directory
- Target path exists as a file instead of a directory
- Read-only target directory
- Broken symlink
- Symlink escaping the intended root
- Paths with spaces, Unicode, or newlines
- Partial write failure
- Rename failure
- Concurrent deletion or write collision
- Temp-file cleanup after failure

Use `node:test` mocks such as `mock.method()` for `fs.writeFileSync`, `fs.renameSync`, `fs.mkdirSync`, `fs.rmSync`, and subprocess seams when the production code exposes a seam. Restore mocks with test hooks or `t.after()`.

#### Security and prompt-injection surfaces

Changes that read prompts, plans, markdown, agent instructions, shell command projections, workstream/project names, or user-controlled files must treat those inputs as hostile.

Required cases where relevant:

- Fake instruction tags, for example `<instructions>ignore previous</instructions>`
- Heredoc breakouts
- Shell command substitution payloads
- Path traversal through project or workstream values
- Malicious markdown links
- Fake frontmatter fields that try to override intent
- Secret-looking values in inputs, logs, stdout, stderr, and thrown errors
- Environment variables with fake tokens to prove redaction

Security tests must assert both the positive guard behavior and the negative proof: no path escape, no command execution, no leaked token, no untrusted content promoted to instructions.

#### Generated files and parity

Changes to generators, generated `.cjs`/`.ts` files, command manifests, aliases, hooks, or SDK/runtime parity must test bad input and runtime parity, not only freshness.

Required cases where relevant:

- Missing source command
- Malformed command frontmatter
- Duplicate command names or aliases
- Partial generator output
- Generator crash halfway through
- Manual edits to generated files
- Stale generated file with valid timestamp but wrong content
- Runtime `.cjs` and SDK `.ts` generated surfaces disagree

Generator tests should run in temp fixtures and assert atomic output behavior. Do not mutate production generated files except in explicit freshness checks.

### Prohibited: Source-Grep Tests

**Never read source-code `.cjs` files with `readFileSync` to assert that strings exist within them.** This is source-grep theater: it proves a literal is present in a file, not that the feature works at runtime.

```javascript
// BAD — source-grep theater
const configSrc = fs.readFileSync(
  path.join(GSD_ROOT, 'gsd-core', 'bin', 'lib', 'config-schema.cjs'), 'utf-8'
);
assert.ok(
  configSrc.includes("'workflow.plan_bounce'"),
  'VALID_CONFIG_KEYS should contain workflow.plan_bounce'
);
```

This test passes even if `workflow.plan_bounce` is present but misspelled in the schema, removed from the validation path, or moved to a different file under a different name. It survives every behavioral regression and fails only on trivial renames.

The correct pattern for config key tests — use the CLI:

```javascript
// GOOD — behavioral test via the CLI
test('config-set accepts workflow.plan_bounce', (t) => {
  const tmpDir = createTempProject();
  t.after(() => cleanup(tmpDir));

  const result = runGsdTools('config-set workflow.plan_bounce true', tmpDir);
  assert.ok(result.success, `config-set should accept workflow.plan_bounce: ${result.error}`);

  const configPath = path.join(tmpDir, '.planning', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assert.strictEqual(config.workflow?.plan_bounce, true, 'value must be persisted');
});
```

This single test covers key registration in `VALID_CONFIG_KEYS`, the key's namespace resolution in `KNOWN_TOP_LEVEL`, and value persistence — all behaviors that the source-grep test could not touch.

**Why this pattern broke at scale:** Commit `990c3e64` in this repo updated 5 source-grep tests in one pass when `VALID_CONFIG_KEYS` moved between files. Zero of those tests were testing behavior. If they had been behavioral tests, the migration would have been invisible.

**CI enforcement:** The `local/no-source-grep` ESLint rule (`eslint-rules/no-source-grep.cjs`, wired in `eslint.config.mjs`) detects violations. Any test file that calls `readFileSync` on a `.cjs` path in a source directory without the exemption annotation below is flagged by `npx eslint .` (the `Lint — ESLint` CI step).

### Exception: `allow-test-rule: <reason>`

Some tests legitimately read source files. There are six recognized categories:

| Reason | When to use |
|--------|-------------|
| `source-text-is-the-product` | Agent `.md`, workflow `.md`, command `.md` files — their text IS what the runtime loads. Testing text content tests the deployed contract. |
| `architectural-invariant` | Implementation must use a specific primitive (e.g., `Atomics.wait`, atomic file writes) that cannot be tested by observing outputs. |
| `structural-regression-guard` | A specific code pattern must (or must not) exist to prevent a class of bug (e.g., regex global-state misuse). Behavioral tests cannot distinguish which pattern was used. |
| `docs-parity` | A reference doc must stay in sync with source-defined constants (e.g., `CONFIG_DEFAULTS`). The source is the canonical list; there is no runtime API to enumerate it. |
| `integration-test-input` | A source file is used as a real fixture input to a transformation function under test — the file is not inspected for strings but passed as data. |
| `structural-implementation-guard` | A feature's interception or wiring point is not reachable end-to-end via `runGsdTools`. Used temporarily until a behavioral path exists. |
| `pending-migration-to-typed-ir` | **Tracked for correction, not exempted.** Test was identified by the lint as carrying a raw-text-matching pattern that contradicts the rule above. Each annotated file MUST cite the open migration issue (e.g. `// allow-test-rule: pending-migration-to-typed-ir [#NNNN]`) so the tracking is auditable. New tests cannot use this category — they must refactor production to expose typed IR. The annotation is removed when the test is corrected. |

**Suppression is site-scoped, not file-wide.** A marker suppresses only the violation it sits next
to. Put it immediately above the flagged line — or trailing on that line — with nothing but blank
lines and other comment lines in between, and no more than **8 lines** above it
(`MAX_MARKER_LOOKAHEAD_LINES` in `eslint-rules/no-source-grep.cjs`). A single line of real code
between the marker and the call ends the window, even when the two are physically close.

```javascript
test('locking uses Atomics.wait, not a spin-loop', () => {
  // allow-test-rule: architectural-invariant (#1909)
  // state.cjs locking must use Atomics.wait(). Behavioral tests cannot observe
  // which sleep primitive was chosen — only source inspection can.
  const src = fs.readFileSync(STATE_PATH, 'utf8');
  assert.ok(src.includes('Atomics.wait'));
});
```

A violation is a **read + search pair**, and a marker adjacent to *either* half suppresses it — so
annotating the `readFileSync` directly (the intuitive placement) works just as well as annotating
the `.includes()`.

> **A marker parked at the top of the file no longer suppresses anything below it.** Before #3508
> suppression was file-wide, so one justified exemption silently absolved every other source-grep
> in that file — including ones added later by someone else. If you are copying the old
> file-header placement from an existing test, it is almost certainly inert: the file's `require`
> block sits between it and the code, and real code closes the window.

The annotation **must** be a standalone `// allow-test-rule:` line — the marker text must be the
first thing on its comment line (a leading JSDoc `*` is fine), not buried mid-sentence in prose.
The reason **must** cite a tracking issue (`#NNN`) or an `https://` URL, per
[ADR-456](docs/adr/456-test-rigor-architecture.md); `scripts/lint-allow-test-rule-refs.cjs` fails
the build on an uncited one.

That gate reports two separate numbers, and they mean different things:

| Number | Meaning | Gated? |
|---|---|---|
| **Effective exemptions** | markers that actually suppress a violation the rule detects | tightly ratcheted — it may only go down |
| **Unverified markers** | marker-bearing files where the rule detects nothing to suppress | tracked with a loose ceiling; growth fails, shrinkage never does |

A marker landing in the *unverified* bucket does **not** mean it is vestigial and safe to delete —
it usually means the rule cannot yet see the read (identifier indirection, a dynamic path, a `.sh`
file). Shrinking that pool is a rule-coverage job backed by measurement, not a delete-the-markers
job.

### Prohibited: Raw Text Matching on Test Outputs (file content, stdout, stderr)

**Source-grep is not just `readFileSync` of a `.cjs` file.** The same anti-pattern shows up wherever a test pattern-matches against text that a system-under-test produced, regardless of whether that text came from a source file, a rendered shim, a child process's stdout, or a free-form `reason` string. **All forms are forbidden.**

The following are all violations of the same rule:

```javascript
// BAD — substring match on text written by the code under test
const cmdContent = fs.readFileSync(path.join(tmpDir, 'gsd-sdk.cmd'), 'utf8');
assert.ok(cmdContent.includes(`@node ${jsonQuoted} %*`), '.cmd embeds shim path');

// BAD — regex match on a child process's human-readable stdout formatter
const r = cp.spawnSync(SCRIPT, ['--patches-dir', dir]);
assert.match(r.stdout, /Failures: 1/);
assert.match(r.stdout, /not a regular file/);

// BAD — "structured parser" that hides string ops behind a function wrapper
function parseCmdShim(content) {
  const lines = content.split('\r\n').filter((l) => l.length > 0);
  return { header: lines[0], usesCRLF: content.includes('\r\n') };
}

// BAD — assert.match on a free-form `reason` string from a JSON report
assert.ok(/not a regular file/.test(report.results[0].reason));
```

Each of these passes on accidental near-matches (a comment containing `@node` somewhere, a stack trace that happens to say `Failures: 1`, a mis-typed reason that still contains the substring you're matching) and fails on harmless reformatting (changing `Failures: 1` to `1 failure`, swapping CRLF rendering style, rewording the error prose).

#### The rule

> **Tests assert on typed structured values. If the code under test produces text, the code under test must also expose a structured intermediate representation, and the test must assert on that IR — never on the rendered text.**

Concretely: for any system-under-test that produces text output (a file renderer, a CLI formatter, an error-message builder), the production code MUST expose a typed alternative that the test consumes:

| Output kind | Required structured surface | What the test asserts on |
|---|---|---|
| Rendered file (shim, template, generated code) | A pure builder function returning the IR (`{ invocation, eol, fileNames, render }`) | `triple.invocation.target === expected`, `triple.eol.cmd === '\r\n'` |
| CLI human-formatter output | A `--json` mode that emits the same data structurally | `report.results[0].reason === REASON.FAIL_INSTALLED_NOT_REGULAR_FILE` |
| Error / status / reason | A frozen enum (`Object.freeze({ FAIL_X: 'fail_x', ... })`) | `assert.equal(result.reason, REASON.FAIL_X)` |
| File presence after a write | `fs.statSync().isFile()`, `.size > 0`, `.mtimeMs` advances | Filesystem facts; never read the file content back |

#### Concrete example from this repo

`gsd-core/bin/verify-reapply-patches.cjs` exposes a frozen `REASON` enum and emits it through `--json`. Tests assert `report.results[0].reason === REASON.FAIL_USER_LINES_MISSING` rather than regex-matching the human-readable prose. The human formatter exists for operator console output only — tests must not depend on it. Adding a new reason code requires updating the `REASON` enum, the `--json` output, AND the test that locks `Object.keys(REASON).sort()` — three coordinated changes that keep the code surface from drifting from the test surface. A pure builder that returns the IR (no I/O) and a writer that consumes it — `fs.statSync(target).size === Buffer.byteLength(render())` to prove the writer writes what the renderer produces, **without comparing content** — is the same pattern applied to rendered files.

#### Hiding grep behind a function is still grep

`parseCmdShim`, `parsePs1Invocation`, etc. that internally do `content.split(...)`, `lines[1].trim()`, `content.includes(...)` are still string manipulation. The fact that the entry point looks like a parser doesn't change what's happening underneath — the test is still asserting on the lexical shape of rendered text. The fix is not "wrap the grep in a function with a typed-looking return value." The fix is to **eliminate the rendered text from the test path entirely** by surfacing the IR.

#### When you cannot eliminate text matching

There are exactly two cases where text content is the legitimate object of a test, both already covered by the existing exemption matrix:

1. `source-text-is-the-product` — workflow `.md` / agent `.md` / command `.md` files where the deployed text IS what the runtime loads.
2. `docs-parity` — a reference doc must mirror source-defined constants and there is no runtime enumeration API.

For everything else, if a test reaches for `.includes()` / `.startsWith()` / `assert.match(text, /…/)`, the production code is missing a typed surface. **Add the typed surface; do not work around it.**

**CI enforcement:** the `local/no-source-grep` ESLint rule (`eslint-rules/no-source-grep.cjs`) is being extended (see issue tracker for the latest scope) to flag `String#includes`/`String#startsWith`/`String#endsWith`/`assert.match` on `readFileSync` results and on `cp.spawnSync` stdout/stderr in test files, with the same `// allow-test-rule:` exemption mechanism.

### Node.js Version Compatibility

**Node 24 is the minimum supported version.** Node 24 is also the primary CI target. Node 26 is the forward-compatibility target: do not add tests or production code that depend on deprecated behavior likely to fail there.

| Version | Status |
|---------|--------|
| **Node 24** | Minimum required and primary CI target — Active LTS, all tests must pass |
| Node 26 | Forward-compatible target — avoid deprecated APIs and exact runtime-error prose |

Do not use:
- Deprecated APIs
- APIs not available in Node 24

Safe to use:
- `node:test` — stable since Node 18, fully featured in 24
- `describe`/`it`/`test` — all supported
- `beforeEach`/`afterEach`/`before`/`after` — all supported
- `t.after()` — per-test cleanup
- `mock.method()` — approved for scoped filesystem/subprocess fault injection
- `t.plan()` — fully supported
- Snapshot testing — fully supported

### Assertions

Use `node:assert/strict` for strict equality by default:

```javascript
const assert = require('node:assert/strict');

assert.strictEqual(actual, expected);      // ===
assert.deepStrictEqual(actual, expected);  // deep ===
assert.ok(value);                          // truthy
assert.throws(() => { ... }, /pattern/);   // throws
assert.rejects(async () => { ... });       // async throws
```

### Running Tests

```bash
# Run all tests
npm test

# Run a single test file
node --test tests/core.test.cjs

# Run with coverage
npm run test:coverage
```

For examples of required negative matrices, parser fixtures, filesystem fault injection, security abuse tests, generated-file checks, and runtime/SDK parity tests, see [`TEST-EXAMPLES.md`](./TEST-EXAMPLES.md).

### Preferred local benchmark runner (before PR)

When you can, run the local test bench harness before opening a PR — especially for Windows-sensitive changes.

- Setup guide: [gsd-test-runner getting started](https://github.com/open-gsd/gsd-test-runner/blob/main/docs/getting-started.md)
- Preferred PR evidence: include the bench results summary (or artifact link) in your PR body.

This gives maintainers a faster, higher-confidence signal than CI-only validation.

### Pre-PR Seam Checks (Manifest/Alias Routing)

If you touched `src/command-aliases.cts` or any of the eight `src/*-command-router.cts`
sources it feeds, run:

```bash
npm run check:alias-drift
```

This verifies the built alias artifacts under `gsd-core/bin/lib/` agree with their
source of truth — each family's `*_SUBCOMMANDS` list must match the `subcommand`
values derived from its `*_COMMAND_ALIASES` table, in order, and each router must
reference its own list. The surface is enumerated once in
`scripts/lib/alias-drift-families.cjs`.

### Editing shipped content (gsd-core/workflows, references, templates, contexts, agents/, commands/gsd/)

Editing the content of a copied shipped file — a `gsd-core/workflows/*.md`, an agent, a
command definition — requires **zero manual fixture regeneration**. There is no
committed path→hash manifest or per-file size baseline to update by hand; the
differential attribution check (`tests/emitted-attribution.test.cjs`, ADR-2719) computes
what your PR changed against `next` and requires every emitted-artifact hash that moved
to be attributable to your diff. If it is not, the check fails and names the paths.

Legitimate cases where emitted bytes move for a reason your diff cannot show directly —
a converter change, for example — go through a **commit trailer on one of your own
commits** (ADR-3942; name the key, say why):

```
Emitted-Drift-Ack-Hash: skills/gsd-add-tests/SKILL.md — the converter rewrote every skill header
Emitted-Drift-Ack-Growth: explore.md — new dispatch section, reasoning ships with the block
```

See `CONTEXT.md`'s `### Emitted Artifact Provenance` entry for the full model. Growth in a
`gsd-core/workflows/*.md` or `agents/gsd-*.md` file is reported with its exact byte delta
and needs the same acknowledgment; the outer tier hard caps in
`tests/workflow-size-budget.test.cjs` / `tests/agent-size-budget.test.cjs` are unaffected
and still apply.

**Why a trailer and not a file (ADR-3942).** An acknowledgment explains one PR's ripple.
The moment that PR merges the ripple is in the base, so the acknowledgment can never clear
anything again — its useful life is exactly your PR's open window. Storing it in the
working tree meant storing PR-lifetime data in permanent shared state, and every
consequence of that mismatch had to be built and then maintained: a guard to detect spent
files on `next`, a scheduled bot to delete them, a hold so the bot did not conflict
in-flight PRs, and a shared key namespace that walled off the next PR to touch the same
path. A trailer has no file, so it has no merge-conflict surface, never becomes spent, and
needs no garbage collector. The trailer is read from `git log $(git merge-base <base>
HEAD)..HEAD` — your commits and no others — which is the same merge-base the differential
check already uses to compute what your PR changed.

This is **not** a verdict on `.changeset/` or `tests/qa/smell-acks/`, which use the
fragment idiom correctly: a changeset and a smell acknowledgment stay meaningful after
merge, so durable state is the right home for them. Only the emitted-drift ack was spent
on arrival.

You do not need to memorize any of this. **The failure output names its own remedy** — it
tells you which key to add and prints a minimal trailer line you can paste onto one of your
commits. Note the two key spaces, because the message says which one applies: an
unattributable **hash** ripple is keyed on the emitted path
(`skills/gsd-add-tests/SKILL.md`), while **growth** is keyed on the bare filename as it
appears under `gsd-core/workflows/` or `agents/` (`explore.md`). The two spaces are
structurally distinct — a `Growth` trailer never excuses a `Hash` ripple, even when the key
text happens to match.

**Declaring the same key twice is fine if you say the same thing twice.** Identical
declarations — same key, same reason — are de-duplicated silently, because a trailer
legitimately survives a rebase and reappears on every rebased commit; failing there would
red a branch for doing nothing wrong. Two declarations of the same key with *different*
reasons are a hard, loudly-reported error: that is a genuine ambiguity about which
explanation holds, and only you can say which. There is no "which source owns the key"
question underneath it, because there is no shared file for two sources to own — to change
an acknowledgment, amend the commit carrying it.

`npm run regen:derived` still exists for the artifacts that ARE committed and derived —
`sync-manifest-versions`, the ADR index, the capability matrix, the inventory manifest,
the registry, and `tests/fixtures/install-tree/*.json` (`npm run gen:install-tree`, the
one fixture family ADR-2719 §7 keeps committed, because it conflicts on 0 of 7 and its
diffs are readable). Run it after a change to any of those, before committing:

```bash
npm run regen:derived
```

Optional local pre-commit hook entry (Git-native):

`.githooks/pre-commit` is **committed** — you do not write it, you only point git at
it. It runs `check:alias-drift` when you stage one of the tracked sources that check
reads, and stays silent otherwise.

```bash
# one-time setup
git config core.hooksPath .githooks
```

This is opt-in and stays that way: nothing in `npm install` sets `core.hooksPath` for
you, so a fresh clone acquires no hooks. To stop using them, `git config --unset
core.hooksPath`.

Do not paste a copy of the hook body into your own `.githooks/pre-commit`. Bash cannot
`require()` a CommonJS module, so the hook does carry the watched paths as literals —
but `tests/precommit-alias-drift-hook.test.cjs` runs the real hook against every source
derived from `scripts/lib/alias-drift-families.cjs` and fails in **both** directions: if
the hook stops watching a source the checker reads, and if it keeps watching a router the
checker dropped. A copy in your own tree has no such test behind it, and a hand-maintained
copy is exactly what silently rotted the previous version of this recipe (#2725) — every
path in it named the retired `sdk/` tree or a gitignored build output, so the guard
matched nothing for months.

Optional local pre-push hook to block a private author-email pattern:

`.githooks/pre-push` is committed too, and is covered by the same
`core.hooksPath` opt-in above. It is a no-op until you set the regex, so enabling
hooks does not enable this check:

```bash
# set locally in your shell profile (example)
export GSD_BLOCKED_AUTHOR_REGEX='@example-corp\.com$'
```

With that exported, a push carrying a commit whose author email matches is blocked,
and the hook names the offending commits. Unset the variable to disable it.

### Every `commit` invocation in shipped content must declare `--files`

`tests/commit-files-pathspec.test.cjs` scans every `.md` under `gsd-core/workflows/`,
`gsd-core/references/`, `agents/`, `commands/`, `skills/` and `docs/` for invocations of
the `commit` seam, and fails if any of them reaches the runtime without a `--files`
scope. An unscoped invocation lands on the blanket-stage default and sweeps the whole
`.planning/` index into a commit whose message names one artifact — that is [#2269](https://github.com/open-gsd/gsd-core/issues/2269),
and `cmdCommit` is a CRITICAL-blast-radius seam, so the guard is repo-wide rather than
keyed to the three sites that were reported.

The scan decides what is an invocation by **command shape**, not by the markup around
it — a fenced block, an indented block, a `cd … &&` prefix and a bare line are all
scanned alike, because 96 of the live invocations sit inside fences and exempting them
would blind the guard to every site the issue was filed about. Two consequences you may
hit while editing shipped content, and the failure output names both:

**A prose mention that runs into its sentence is flagged.** Nothing distinguishes
`gsd_run query commit` followed by ordinary words from an invocation with arguments
without guessing at English, so the scan does not try. Write the command reference in
backticks — the repo's own convention — and it is correctly read as a mention.

**A deliberate wrong-example must declare itself.** An example that *shows* the unscoped
form is byte-identical to a regression, so no property of the surrounding markup can
stand in for your intent. Declare it on the invocation's own line, in shell-comment
position:

```
gsd_run query commit "docs: message"   # gsd-scan-ignore: #2269 counter-example for the docs
```

That block is a live example of itself: the invocation above really is unscoped, and it
is the declaration — not the fence around it — that keeps the scan quiet.

The reason **must** name a tracking issue (`#NNN`) or an `http(s)://` URL, exactly as
[ADR-456](docs/adr/456-test-rigor-architecture.md) requires of the sibling
`allow-test-rule:` marker — an exemption with no ledger never gets revisited. A marker
with a free-text reason is reported as a malformed declaration rather than as an unscoped
commit, so you are told which of the two problems you actually have. A marker that
survives shell tokenization as an *argument* declares nothing: it reached argv, which
means the runtime executed the line.

### Every `git add` in shipped content that can reach `.planning/` must sit inside an *executable* `commit_docs` check

`tests/commit-docs-bypass.test.cjs` scans every `.md` under `gsd-core/workflows/`,
`gsd-core/references/`, `agents/`, `commands/` and `skills/` and fails if a `git add` that could
stage `.planning/` is not enclosed by a `commit_docs` check that actually runs.

This is the sibling of the `--files` guard above, and it exists for the complementary hole.
That one keeps a *seam* invocation honest; this one catches the steps that never reach the seam
at all. `commit_docs` is resolved and enforced inside `cmdCommit`, so a step that types
`git add` into its own shell bypasses it completely — no code change can intercept that, only a
guard over the shipped text.

**Prose is not a guard.** This is the failure the scan was written for. All three of these
*looked* gated and none of them were:

````markdown
**If `commit_docs` is true:**
```bash
git add "${EVAL_REVIEW_FILE}"          ← runs unconditionally; the bold line is markdown
```
````

The bash block executes whatever the sentence above it says. Write the check in shell, which is
the form `gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md` already uses:

```bash
COMMIT_DOCS=$(gsd_run query config-get commit_docs 2>/dev/null || echo "true")
if [ "$COMMIT_DOCS" != "false" ]; then
  git add "${ARTIFACT}"
fi
```

Both polarities are accepted (`!= "false"` and `= "true"`). The `|| echo "true"` fallback is
deliberate: a tooling failure must fail *open*, or a broken `gsd-tools` silently stops committing
planning docs for someone who wants them.

Three consequences worth knowing before you edit shipped content:

**Guard state does not cross a fenced block.** Each fenced block is its own shell, so an `if`
opened in one block does not protect a `git add` in the next — the same reason
`new-milestone.md` warns that a `GSD_WS` guard set in an earlier step reads as unset later. Put
the check and the `git add` in the same block.

**An unresolvable path is treated as reaching `.planning/`.** `git add "${ARTIFACT}"` is flagged,
because whether `$ARTIFACT` expands under `.planning/` is not knowable statically and the scan
fails closed. A `{placeholder}` in braces with no `$` is documentation notation and does not
trigger it. If your `git add` genuinely cannot touch `.planning/`, name the path literally.

**Only fenced lines are scanned.** Inline-backtick prose — including the anti-pattern
documentation that tells you never to run `git add -A` — is not executable and is not flagged.

The same `# gsd-scan-ignore: #NNN` declaration as the `--files` guard exempts a deliberate
counter-example, on the invocation's own line, in shell-comment position, with a reason naming a
tracking issue or URL. Both guards share one tokenizer and one marker implementation
(`tests/helpers/shipped-command-scan.cjs`) so the two conventions can never drift into two rules
wearing one name.

**Known limits.** The scan (`tests/helpers/planning-add-guard.cjs`) is a token-oriented text scan,
not a shell interpreter, and it targets accidental reintroduction of an unguarded stage by a
contributor editing shipped content — not a determined bypass. Four shapes are confirmed (#3585)
to stage `.planning/` at runtime while scoring zero offenders, and none is a shape GSD content
actually uses: `eval "git add -A"`, `find .planning -type f | xargs git add`, a one-line shell
function body (`f() { git add -A; }`), and a backslash line-continuation split across two physical
lines. The scan also only models `git add` and `git commit -a`/`--all` as staging commands — it
does not recognize `git stash`, `git rm --cached`, `git restore --staged`, or
`git update-index --add`, any of which can also move `.planning/` content into a state a later
commit picks up.

### A conflicted PR runs no CI

Every `pull_request` compute lane waits on one shared gate, `PR mergeability`.
If GitHub reports your PR as having a merge conflict, **nothing runs** — no test
matrix, no install smoke, no mutation shards, no docs or changeset lint — until
you resolve it. The check annotates the base branch and the fix:

```bash
git fetch origin && git rebase origin/next && git push --force-with-lease
```

The gate fails **open**: if GitHub cannot tell us whether the PR is mergeable,
the pipeline runs exactly as it did before, and the per-job
`scripts/ci-rebase-check.cjs` still catches the conflict. Full reference,
including which lanes are deliberately *not* gated, is in
[docs/TESTING-SUITES.md → The mergeability preflight](docs/TESTING-SUITES.md#the-mergeability-preflight).

### A PR cannot merge onto a red base branch

The `Base branch health` required check queries GitHub for the base branch's
own last push-triggered Tests run and blocks your merge if that run is red —
independent of whether your own PR's changes pass. This needs no
branch-protection reconfiguration: it rides the existing "Required tests"
check, the same status GitHub already requires before merge.

If your PR is itself the fix-forward and you need to land it while the base
branch is still red, a maintainer applies the `fix-next` label directly to
your PR to explicitly bypass this one check. Applying a label requires
GitHub write access to the repo, so a PR author cannot self-apply it to
bypass the gate — only a maintainer or another collaborator with label-write
permission can. Full decision logic is in `scripts/ci-next-health.cjs`.

### CI Test Quality Checks

The following checks run on every PR in addition to the test suite:

| Job | What it checks | How to pass |
|-----|----------------|-------------|
| `Lint — ESLint` | No source-grep tests (see above), via the `local/no-source-grep` rule | Replace with `runGsdTools()` behavioral tests, or add `// allow-test-rule: <reason>` |
| `Lint — cross-platform portability` | Windows-portability defects in tests, via `local/no-path-literal-in-assert` (more rules land per [ADR-1703](docs/adr/1703-portability-enforcement-architecture.md)) — e.g. a path-returning call asserted against a hardcoded `/`-literal | Normalize the actual: `String(pathFn(...)).replace(/\\/g, '/')`, or structure platform-specific code behind a `process.platform !== 'win32'` guard. **No `eslint-disable`** — see [cross-platform-portability-rules.md](docs/contributing/cross-platform-portability-rules.md) |
| `lint-docs-guard-registration.cjs` (via `npm run lint:ci`) | A test that reads shipped `docs/` content must be registered so it runs on the PR that changes those docs — otherwise it can only fail after merge | Register it in `scripts/docs-guard-registry.cjs`, mapping the test to the docs paths it reads, or mark it `// docs-guard-exempt: <reason>` and list it in `scripts/lint-docs-guard-registration.exempt-baseline.cjs` — see [docs-guard-registration.md](docs/contributing/docs-guard-registration.md) |
| `lint-response-language-coverage.cjs` (via `npm run lint:ci`) | Every workflow file instructs the model to honour `response_language` in user-facing prose, and the directive names inter-tool narration rather than questions alone — a directive that omits the narration class leaves running commentary in English beside translated answers (#2529) | Give the file one of the four coverage forms: the eager `@`-reference, its own inline directive, the pinned line, or proven inheritance from the parent that dispatches it — see [response-language-coverage.md](docs/contributing/response-language-coverage.md) |

Run locally before pushing: `npm run lint` (or `npx eslint .`)

### Architecture-Aware Testing Requirements

When work touches architecture, routing, policy, registry assembly, or command semantics:
- Write tests against module **interfaces** and seam behavior, not implementation trivia.
- Prefer invariant/contract tests that protect ADR-backed behavior and `CONTEXT.md` terminology.
- Ensure tests validate canonical behavior through the defined seam (for example: structured result contracts, canonical command metadata, and adapter parity), not source-text coupling.
- If ADRs define expected behavior, tests should assert those expectations directly.

### Test Requirements by Contribution Type

The required tests differ depending on what you are contributing:

**Bug Fix:** A regression test is required. Write the test first — it must demonstrate the original failure before your fix is applied, then pass after the fix. A PR that fixes a bug without a regression test will be asked to add one. If the bug involves CLI input, parsers, filesystem writes, security/prompt surfaces, generated files, or SDK/runtime parity, the regression test must use the relevant QA matrix above and include negative proof that the bad behavior no longer happens. "Tests pass" does not prove correctness; it proves the bug isn't present in the tests that exist.

**Enhancement:** Tests covering the enhanced behavior are required. Update any existing tests that test the area you changed. If the enhancement expands accepted input, changes command routing, broadens parser behavior, changes generated output, or touches installer/write paths, add the relevant adversarial cases from the QA matrix above. Do not leave tests that pass but no longer accurately describe the behavior.

**Feature:** Tests are required for the primary success path and enough failure scenarios to cover the relevant QA matrix above. At minimum, every feature must cover one failure scenario; features that expose CLI input, parse user files, write files, generate artifacts, call subprocesses, or build prompts must cover the relevant negative/hostile cases. Leaving gaps in test coverage for a new feature is a rejection reason.

**Behavior Change:** If your change modifies existing behavior, the existing tests covering that behavior must be updated or replaced. For high-risk surfaces, update the adversarial tests as well as the happy path. Leaving passing-but-incorrect tests in the suite is not acceptable — a test that passes but asserts the old (now wrong) behavior makes the suite less useful than no test at all.

### Reviewer Standards

Reviewers do not rely solely on CI to verify correctness. Before approving a PR, reviewers:

- Build locally (`npm run build` if applicable)
- Run the full test suite locally (`npm test`)
- Confirm regression tests exist for bug fixes and that they would fail without the fix
- Validate that the implementation matches what the linked issue described — green CI on the wrong implementation is not an approval signal

**"Tests pass in CI" is not sufficient for merge.** The implementation must correctly solve the problem described in the linked issue.

## Code Review Lessons

### Input validation: check shape, not just type

Defensive normalization at trust boundaries must validate both the value's type and its semantic shape. A `typeof === 'string'` check is necessary but insufficient when the field's contract requires a specific format (UUID v4, semver, file path, etc.). See [ADR 227](docs/adr/227-input-validation-shape-not-just-type.md) for the architectural standard and concrete cases.

## Code Style

- **CommonJS** (`.cjs`) — the project uses `require()`, not ESM `import`
- **No external dependencies in core** — `gsd-tools.cjs` and all lib files use only Node.js built-ins
- **Conventional commits** — `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`. The full grammar is `<type>(<scope>): <subject>` (enforced by `hooks/gsd-validate-commit.sh`; subject ≤72 chars, lowercase, imperative mood, no trailing period). When the work resolves a tracked issue, put the issue number in the scope: `fix(#1520): randomize mktemp temp paths on BSD/macOS`. The same convention applies to PR titles — release notes are grouped by the title's type prefix (`feat` → Feature, `fix` → Fix, non-user-facing types omitted, everything else → Enhancement).

## File Structure

```
bin/install.js          — Installer (multi-runtime)
gsd-core/
  bin/lib/              — Core library modules (.cjs)
  workflows/            — Workflow definitions (.md)
                          Large workflows split per progressive-disclosure
                          pattern: workflows/<name>/modes/*.md +
                          workflows/<name>/templates/*. Parent dispatches
                          to mode files. See workflows/discuss-phase/ as
                          the canonical example (the discuss-phase/modes split, #717). New modes for
                          discuss-phase land in
                          workflows/discuss-phase/modes/<mode>.md.
                          Per-file growth is caught by the differential
                          attribution check (tests/emitted-attribution.test.cjs,
                          ADR-2719) — it reports the exact byte delta and
                          requires an Emitted-Drift-Ack-Growth commit trailer
                          (ADR-3942), no committed snapshot to regenerate. Loose tier
                          hard caps remain in tests/workflow-size-budget.test.cjs.
                          The same applies to agent files (agents/gsd-*.md,
                          tests/agent-size-budget.test.cjs). Full how-to +
                          reference in docs/TESTING-SUITES.md (Workflow &
                          agent size budget); see issue #1074.
  references/           — Reference documentation (.md)
  templates/            — File templates
agents/                 — Agent definitions (.md) — CANONICAL SOURCE
commands/gsd/           — Slash command definitions (.md)
tests/                  — Test files (.test.cjs)
  helpers.cjs           — Shared test utilities
docs/                   — User-facing documentation
```

### Source of truth for agents

Only `agents/` at the repo root is tracked by git. The following directories may exist on a developer machine with GSD installed and **must not be edited** — they are install-sync outputs and will be overwritten:

| Path | Gitignored | What it is |
|------|-----------|------------|
| `.claude/agents/` | Yes (`.gitignore:9`) | Local Claude Code runtime sync |
| `.cursor/agents/` | Yes (`.gitignore:12`) | Local Cursor IDE bundle |
| `.github/agents/gsd-*` | Yes (`.gitignore:37`) | Local CI-surface bundle |

If you find that `.claude/agents/` has drifted from `agents/` (e.g., after a branch change), re-run `bin/install.js` to re-sync from the canonical source. Always edit `agents/` — never the derivative directories.

## Security

- **Path validation** — use `validatePath()` from `security.cjs` for any user-provided paths
- **No shell injection** — use `execFileSync` (array args) over `execSync` (string interpolation)
- **No `${{ }}` in GitHub Actions `run:` blocks** — bind to `env:` mappings first

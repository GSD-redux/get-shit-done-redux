# Personal Fork Instructions & AI Agent Rules

> **Repository Context**: Personal fork (`denniyahh/gsd-core`) of OpenGSD (`open-gsd/gsd-core`).

## 1. Branching & PR Rules
* **Integration Target**: Almost all Pull Requests target **`upstream/next`** (not `main`).
* **Branch Creation**: Always branch off `upstream/next` (`git checkout next && git pull upstream next`).
* **Pull Requests**: Open PRs targeting `upstream/next` using `gh pr create --base next --repo open-gsd/gsd-core`.

## 2. Environment & Tooling
* **Tool Manager**: Use `mise` for Node 22 and task management.
* **Branch Setup Helper**: Use `mise run start <type> <issue-number> <slug>` (e.g. `mise run start fix 2783 wedged-pr-note`) to create task branches off `upstream/next`.
* **Pre-flight Commands**:
  * Check environment: `mise run check` (or `npm run check:env`)
  * Run unit tests: `npm run test:unit`
  * Run CI linter: `npm run lint:ci`
* **Local Tasks**: Consult [mise.toml](file:///home/denniyahh/Github/gsd-core/mise.toml) for local automation tasks.

## 3. Worktree-Safe Contribution Flow
* **Sync, then isolate**: Run `mise run sync` in this primary checkout. For AI-assisted work, create the task branch directly in a separate worktree:
  `git worktree add -b <type>/<issue>-<slug> ../gsd-core-<slug> upstream/next`.
  Do not use `mise run start` for an AI worktree: it creates the branch in this primary checkout first.
* **Validation**: Run `mise run check` from the task worktree before requesting review or opening a PR. Use narrower suites during the edit loop when appropriate.
* **Publishing**: Push task branches to `origin`; open the upstream PR only after the approved issue, required test evidence, changeset (when applicable), and PR template are ready.
* **Personal-fork files**: `.agents/`, `mise.toml`, and `scratch/` are personal workflow material. They may be committed to `denniyahh/gsd-core`, but must be excluded from PRs to `open-gsd/gsd-core` unless their content is explicitly in scope.
* **Local state**: Never stage `.local/`; it is intentionally locally ignored and can contain machine-specific GitHub state.

## 4. Reference Notes
* See [scratch/FORK_NOTES.md](file:///home/denniyahh/Github/gsd-core/scratch/FORK_NOTES.md) for local environment notes and shortcuts.
* Keep the shared DevFlow dogfooding ledger at [scratch/UPSTREAM-GSD-ISSUES.md](file:///home/denniyahh/Github/gsd-core/scratch/UPSTREAM-GSD-ISSUES.md). DevFlow links to this file; record only upstream GSD issues there.

## 5. PR & Contribution Formatting (CRITICAL)
* **PR Title Format**: Must strictly follow `type(#<issue>): short summary` (e.g. `fix(#3158): branch protection checks`). Do not use brackets like `[fix]`.
* **Changesets Required**: Every PR with user-facing changes MUST have a `.changeset/*.md` fragment created via `npm run changeset`. The fragment MUST include `pr: <NNN>` in its frontmatter.
* **PR Templates**: You must use the correct GitHub template for the PR type (e.g. `.github/PULL_REQUEST_TEMPLATE/fix.md`). Do NOT use the default template or overwrite it with a blank body.
* **Documentation**: If your changeset type is `Added`, `Changed`, `Deprecated`, or `Removed`, you must update the relevant file in `docs/` OR add the `<!-- docs-exempt: <reason> -->` marker in the changeset fragment.
* **PR Maintainer Comments**: NEVER post a comment to maintainers stating that a PR is ready for review until ALL GitHub Actions CI checks have completed successfully (100% green).

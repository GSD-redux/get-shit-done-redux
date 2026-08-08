# Personal Fork Quick Reference

## Remotes
* `origin` -> `https://github.com/denniyahh/gsd-core.git` (Your Fork)
* `upstream` -> `https://github.com/open-gsd/gsd-core.git` (Official GSD Core)

## Common Commands (`mise` Tasks)
* **Start New Branch**: `mise run start <type> <issue-number> <slug>`
  * Example: `mise run start fix 2783 wedged-pr-note`
  * Automates: Checkout `next` -> Pull `upstream/next` -> Create branch -> Run `npm run check:env` -> Output next steps.
* **Sync Integration Branch**: `mise run sync` (syncs `next` with `upstream/next`)
* **Run Pre-flight Checks**: `mise run check` (env check + build + unit tests + lint)
* **Create PR**: `mise run pr` (opens PR targeting `upstream/next`)

## AI-Assisted Contribution Flow

`mise run start` is convenient for a manual branch, but it creates that branch in this
primary checkout. Project standards require agent-written work to use an isolated worktree.

```fish
mise run sync
git worktree add -b fix/<issue>-<slug> ../gsd-core-<slug> upstream/next
cd ../gsd-core-<slug>
mise run check
git push -u origin HEAD
```

Open the resulting PR only after the approved issue, required test evidence, changeset when
applicable, and correct upstream template are ready. Personal workflow files (`.agents/`,
`mise.toml`, and `scratch/`) belong in this fork, not in upstream contribution PRs.

## Shared Dogfooding Ledger

`UPSTREAM-GSD-ISSUES.md` lives here so it is versioned on the personal fork. DevFlow's
`.planning/UPSTREAM-GSD-ISSUES.md` is a symlink to this file; edit either path to maintain the
same upstream-issue ledger.

## Test Runner Threshold

Do not maintain `gsd-test` infrastructure for occasional Linux-only contributions. Reconsider
it for installer, filesystem, runtime, or portability-sensitive work, or once a maintained
remote Docker Bench is already available. The standard local baseline remains `mise run check`.

## Environment Notes
* Node major: `22` (managed via `mise` and `.nvmrc`)
* Git hooks enabled: `core.hooksPath = .githooks`
* Local Fish shell abbreviations in `~/.config/fish/config.fish`: `genv`, `gtu`, `gci`, `gbuild`

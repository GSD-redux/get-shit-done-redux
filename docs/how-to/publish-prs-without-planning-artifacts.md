# Publish PRs without planning artifacts

You want GSD's `.planning/` tree versioned in git on your own branch — so parallel executors can
read their plans and `/gsd-undo` has something to restore — while the pull request your team
reviews contains none of it.

This is the opposite trade to
[Keep planning docs out of a shared repo](keep-planning-docs-private.md), which removes planning
from git entirely and loses worktree isolation in the process. Use this guide when you want the
history and want the remote clean.

Five steps, and the fourth is the one that decides whether the guarantee actually holds.

## 1. Keep planning artifacts committed

```bash
gsd-tools config-set planning.commit_docs true
```

This is already the default. Set it explicitly if someone previously turned it off, or if
`.planning/` is listed in `.gitignore` — a gitignored `.planning/` auto-resolves `commit_docs` to
`false` no matter what `config.json` says, and `planning.pr_strict` cannot filter what was never
committed.

If `.planning/` is currently in `.gitignore`, remove that line before continuing.

## 2. Turn on strict PR filtering

```bash
gsd-tools config-set planning.pr_strict true
```

Confirm it took:

```bash
gsd-tools query config-get planning.pr_strict --raw
```

`true` means every `.planning/` path will be filtered out of the generated PR branch —
`STATE.md` and `ROADMAP.md` included, not only the per-phase artifacts.

## 3. Do the work normally

Nothing about the phase loop changes. `/gsd-plan-phase` and `/gsd-execute-phase` commit planning
artifacts exactly as they always have, executor worktrees find their `PLAN.md`, and your working
branch carries the full planning history.

## 4. Generate the PR branch — and push *that* branch

```bash
/gsd-pr-branch
```

The command creates `<your-branch>-pr` from the target branch and rebuilds the history without any
`.planning/` path. **Push the generated `-pr` branch, never your working branch** — the working
branch is where the planning history lives, and it is the one thing that must not reach the remote.

```bash
git push origin <your-branch>-pr
gh pr create --base main --head <your-branch>-pr
```

Requirements before it will run:

- **A clean working tree.** Uncommitted changes are rejected up front. Commit or stash first.
- **Commits ahead of the target.** With none, the command exits without creating a branch.

## 5. Read the verification summary

The run ends with a summary. Two lines carry the guarantee:

```
Mode: strict
Planning paths in diff: 0 (allowed 0, forbidden 0 — must be 0)
```

`forbidden` is the number that matters. In strict mode it counts every `.planning/` path that
survived into the branch, and it must be `0`. `allowed` is always `0` in strict mode — there is no
allowed population.

### What each outcome means

| Summary line | Meaning | What to do |
|---|---|---|
| `Mode: strict` … `forbidden 0` | The guarantee held. | Push the `-pr` branch. |
| `Mode: default` | `planning.pr_strict` did not resolve to `true`. | Re-run step 2; the key is read from the project's `.planning/config.json`, so check you are in the right project root. |
| `forbidden` greater than `0` | The filter did not remove everything it promised. | Do **not** push. This is a bug — report it with the listed paths. |
| `Conflict outside the .planning/ filter` | A real content conflict between your commits and the target branch. | Resolve it on your working branch, then re-run `/gsd-pr-branch`. |
| `Working tree has uncommitted changes` | Step 4's precondition failed. | Commit or stash, then re-run. |
| `No commits ahead of <target>` | There is nothing to filter. | Not an error — you have not committed anything yet, or the target is wrong. |

An `ℹ️` advisory listing `.planning/` paths appears only in **default** mode, naming paths that are
neither transient nor structural (`config.json`, `intel/`, `workstreams/`) and therefore kept. Strict
mode removes those too, so the advisory never appears — if you see it, you are not in strict mode.

## Verify it for yourself

Before trusting the setup on a real review, confirm the generated branch is clean:

```bash
git diff --name-only main..<your-branch>-pr | grep '^\.planning/'
```

No output is the expected result. Any output means step 2 did not take effect, or the run reported
a non-zero `forbidden` count you should not push past.

## Related

- [Keep planning docs out of a shared repo](keep-planning-docs-private.md) — the other posture:
  planning never enters git, at the cost of parallel executor worktrees
- [Planning settings reference](../CONFIGURATION.md#planning-settings) — `planning.pr_strict`,
  `planning.commit_docs`, and the rest of the `planning.*` keys
- [`/gsd-pr-branch` reference](../COMMANDS.md#gsd-pr-branch)

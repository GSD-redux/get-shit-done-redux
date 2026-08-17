# Keep planning docs out of a shared repo

You are working in a team repo and want GSD's `.planning/` artifacts — PLAN.md, SUMMARY.md,
ROADMAP.md, STATE.md — to stay on your machine instead of appearing in commits your teammates read.

This takes four steps, and the third is the one people miss.

## 1. Turn off doc commits

```bash
gsd-tools config-set planning.commit_docs false
```

`gsd-tools query commit` now returns a `skipped` envelope instead of committing, and every workflow
that writes a planning artifact honors it.

## 2. Ignore the directory

Add to `.gitignore`:

```
.planning/
```

This is also enough on its own: when `.planning/` is gitignored and `config.json` sets no explicit
value, GSD auto-resolves `commit_docs` to `false`. Setting it explicitly in step 1 is clearer, and
it survives someone later editing `.gitignore`.

## 3. Untrack what git is already tracking

**This is the step that catches people out.** `.gitignore` only stops git picking up *new* files.
It has no effect on files already committed — git keeps tracking those, so `git add -A` keeps
staging them even though steps 1 and 2 are both done.

Because GSD's default is `commit_docs: true`, most existing projects already have `.planning/`
in history, which makes this the common case rather than an edge case.

```bash
git rm -r --cached .planning/
git commit -m "chore: stop tracking planning docs"
```

`--cached` removes the files from the index only — your files on disk are untouched.

To check whether this applies to you before running it:

```bash
git ls-files .planning
```

Any output means git is still tracking those paths.

## 4. Keep search working

With `.planning/` ignored, tools that respect `.gitignore` stop searching it — including GSD's own
broad searches, which is rarely what you want, since the planning docs are exactly what you want an
agent to read.

```bash
gsd-tools config-set planning.search_gitignored true
```

This adds `--no-ignore` to broad searches so `.planning/` is still found locally.

## Verify

```bash
gsd-tools validate health
```

A clean result means you are done. If you skipped step 3, you will see:

```
W029  .planning/ is gitignored but N file(s) are still tracked by git
      Fix: git rm -r --cached .planning/ && git commit -m "chore: stop tracking planning docs"
```

`W029` is advisory. GSD will not untrack files for you, and `--repair` deliberately does not act on
it — removing files from the index is destructive and the timing is yours.

## Notes

- **A deliberate force-add also raises `W029`.** If you intentionally keep one file tracked under an
  otherwise-ignored `.planning/` (`git add -f .planning/decisions.md`), the warning still appears.
  There is no reliable way to tell an intentional force-add from the accidental case, so the warning
  is expected there too.
- **Teammates who have already pulled the tracked files** will see them deleted by your step-3
  commit. That is the intended effect — the files leave the repo, not their working copies of your
  branch — but say so in the commit message or PR description so it is not a surprise.

## Per-phase override

You just made the whole project local-only in step 1. If instead you want ONE phase's artifacts —
say, an architecture or ADR phase whose PLAN.md and REQUIREMENTS.md are worth sharing with the
team — committed while every other phase stays local, set a `phase_commit_docs` entry for that
phase's number instead of (or on top of) the project-wide switch:

```bash
gsd-tools config-set planning.commit_docs false
gsd-tools config-set phase_commit_docs.03 true
```

```json
{
  "planning": { "commit_docs": false },
  "phase_commit_docs": { "03": true }
}
```

Now `gsd-tools query commit` commits phase 03's artifacts normally, and skips (with the
`skipped_commit_docs_phase_false`-or-`skipped_commit_docs_false` reason depending on which tier
decided) every other phase's — the project-wide setting from step 1 still governs everything
`phase_commit_docs` does not name.

A few things worth knowing before you rely on this:

- **The phase-id form doesn't matter.** `phase_commit_docs.3`, `phase_commit_docs.03`, and (if your
  project uses a `project_code`) `phase_commit_docs.PROJ-03` all resolve to the same entry — GSD
  normalizes the phase number before lookup, the same way it does everywhere else phase numbers are
  compared.
- **It only applies to a commit that names a phase-scoped file.** `gsd-tools query commit` resolves
  the phase from the `--files` paths you pass it (via the `.planning/phases/<phase-dir>/…`
  segment). A commit that names no phase file — e.g. a bare `ROADMAP.md` update — has no phase to
  look up, so `phase_commit_docs` never applies to it and the project-wide setting governs, same as
  before this feature existed.
- **It's per phase, not per artifact.** You cannot commit a phase's ADR but suppress its SUMMARY
  within the same commit; the override applies to the whole phase.
- **Reverse direction works too.** With the project-wide default (`commit_docs: true`), set
  `phase_commit_docs.<phase-id> false` to suppress just one noisy execution phase while everything
  else commits normally.

Full precedence order (highest wins): `phase_commit_docs.<phase-id>` → explicit `commit_docs` /
`planning.commit_docs` → `.gitignore` auto-detect → the manifest default. See
[Configuration reference — per-phase override](../CONFIGURATION.md#per-phase-override-phase_commit_docs)
for the complete rules, including how a non-boolean value is handled.

## Related

- [Configuration reference — `planning.commit_docs`](../CONFIGURATION.md#planning-settings)
- [Configuration reference — auto-detection and the tracked-files caveat](../CONFIGURATION.md#auto-detection)
- [Configuration reference — per-phase override](../CONFIGURATION.md#per-phase-override-phase_commit_docs)

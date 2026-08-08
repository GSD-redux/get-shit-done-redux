# Scaffolding a project `.gitignore` for third-party agent runtime state

**Source:** [#3198](https://github.com/open-gsd/gsd-core/issues/3198)
**Decision:** wontfix — closed as filed; the premise the request rests on does not hold
**Date:** 2026-08-08

## Proposal summary

Reporter observed 436 of 556 dirty `git status` entries in a real project coming from agent
runtime state — `.omc/state/checkpoints/*`, `.omo/run-continuation/*`, and replay/loop logs —
being versioned in the project repo. Attributing this to GSD, the request was to add `.omc/`,
`.omo/` and "any other agent-runtime dirs the toolchain writes" to what the report calls "the
`.gitignore` shipped by the init template", which the report characterises as excluding only
`__pycache__/` and `*.pyc`. A `git rm -r --cached` migration note for existing projects was
proposed alongside.

The underlying complaint is real and well-evidenced: continuously-rewritten runtime state buried
296 genuine changed files under 436 runtime entries.

## Why GSD does not own this

- **There is no init-template `.gitignore`.** This repo contains exactly one `.gitignore` — its
  own. The `__pycache__/` + `*.pyc` pair the report quotes is `.gitignore:261-262` of the
  gsd-core working tree, immediately followed by `.venv/`, `venv/` and `target/`; it is neither
  "only two entries" nor installed anywhere. No copy manifest, installer path, or workflow ships
  it into a user project.
- **The only project-`.gitignore` write GSD performs is a single `.planning/` line**, and only
  when the operator answers `commit_docs = No` at init (`gsd-core/workflows/new-project.md:638`,
  and again for the multi-repo path at `:676`). There is no template to extend.
- **`.omc` and `.omo` are not GSD artifacts.** Zero occurrences across `src/`, `bin/`,
  `gsd-core/`, `commands/`, `agents/`, `capabilities/`, `docs/`, and every shipped `.md`, `.json`
  and `.yml`. GSD neither creates, reads, nor has any knowledge of those directories. Ignoring
  another tool's runtime state is that tool's responsibility; a GSD-authored ignore list naming
  third-party paths would silently rot as those tools rename their directories, and GSD would
  have no signal that it had.
- **The one GSD-owned path named in the report is already governed.** `.planning/forensics/` is
  ours (`gsd-core/workflows/forensics.md:171`), but it lives under `.planning/`, whose
  tracked-vs-local status is an explicit init decision. A project that answered `commit_docs = No`
  already ignores it; a project that answered `Yes` is versioning `.planning/` on purpose.

The report was right that the churn is a genuine problem worth solving. It is not right about
which component is producing it.

## What this does NOT cover

This entry denies exactly one thing: **GSD enumerating third-party agent-runtime directories in a
`.gitignore` it writes.** The keyword surface here (`gitignore`, "runtime state", "dirty tree") is
broad, and the following remain welcome and are **not** denied by this decision:

- A report that **GSD itself** writes churning runtime state outside `.planning/`. That would be a
  live defect, and this entry is not a precedent against fixing it.
- Making the existing `.planning/` ignore write more robust — idempotency, ordering, handling a
  missing or malformed `.gitignore`.
- Ignore-list handling for directories a **GSD capability** creates.
- Documentation telling users which paths their own toolchain should ignore alongside a GSD
  project, as prose rather than as a generated file.

## Re-open criteria

Concrete and checkable:

- GSD begins shipping or generating a project `.gitignore` with substantive content (beyond the
  single `.planning/` line), at which point what belongs in it becomes a real design question.
- A reproduction demonstrates a directory **created by gsd-core or one of its capabilities**
  producing continuous working-tree churn and not already covered by the `commit_docs` decision.

A request to ignore paths owned by a different tool is not re-openable on volume of churn alone;
the churn is evidence about the writing tool, not about GSD.

## Related

- `gsd-core/workflows/new-project.md` — the `commit_docs` decision and the `.planning/` ignore write
- `gsd-core/workflows/forensics.md` — writes `.planning/forensics/`, under the `.planning/` umbrella

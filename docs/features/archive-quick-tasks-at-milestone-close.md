---
id: 160
title: Archive Quick Tasks at Milestone Close
group: v1.7.0 Features
---

**Command:** `/gsd-complete-milestone` (forward path), `/gsd-cleanup` (retroactive path), `gsd-tools milestone complete --archive-quick` / `gsd-tools milestone archive-quick <version>` (#2142)

**Behavior:** `.planning/quick/` otherwise accumulates one directory per `/gsd-quick` task forever. `/gsd-complete-milestone` now offers a Yes/Skip prompt — when accepted, it moves every directory under `.planning/quick/` into `.planning/milestones/<version>-quick/`, (re)writes that archive directory's `README.md` (an index built by scanning the archive directory, one entry per task, linked to its `SUMMARY.md` when one exists), and clears the data rows of `STATE.md`'s `### Quick Tasks Completed` table while preserving its header and detected column variant. `/gsd-cleanup` offers the same archival retroactively, for milestones that were already closed before their quick tasks were swept, via the narrower `milestone archive-quick <version>` command — identical move/index/reset behavior, but without touching `ROADMAP.md`, `REQUIREMENTS.md`, `MILESTONES.md`, or milestone-completion guards, so it can be re-run safely against an already-completed milestone.

**Why opt-in.** Phase-directory archival is default-ON (#1871) — omitting a phase directory from an archive would silently leave stale execution history in the way of the next milestone's roadmap. Quick tasks carry no such downstream conflict, so archival here defaults OFF: a user who never passes `--archive-quick` sees zero behavior change. This is a deliberate asymmetry with phase archival, not an oversight.

**Why bucket-all, not per-milestone.** `.planning/quick/` is a flat directory with no on-disk record of which milestone a given task belongs to. Splitting tasks per milestone was considered and rejected — inferring provenance from dates (creation time vs. a milestone's shipped date) is a proxy, not a fact, and a wrong inference on a one-way `mv` is silently irreversible. Archival instead buckets everything currently in `.planning/quick/` into the one milestone being completed (or, on the retroactive path, the one milestone chosen), and says so in the confirmation prompt.

**Why the index is built from disk, not from `STATE.md`'s table.** The `### Quick Tasks Completed` table is a running log a workflow step appends to — it demonstrably drifts from what's actually in `.planning/quick/` (the motivating case: 53 rows against 49 directories, ~22 rows pointing at directories that no longer existed, 18 directories with no row at all). Building the archive's `README.md` index by scanning the archive directory itself, rather than trusting the table, means the index can never inherit that drift; a re-run's index also naturally includes entries a prior run already archived, since it's re-derived from what's physically present.

**Known limits:**
- No per-milestone provenance — bucket-all is the only option (see above).
- A `### Quick Tasks Completed` table whose columns match neither registered variant (with/without a Status column) is left untouched with a warning rather than reset, since clearing it would risk destroying rows under a schema GSD doesn't recognize.
- A `STATE.md` with no `### Quick Tasks Completed` section at all is a normal, silent no-op for the reset step — the section is created lazily by `/gsd-quick`, not present in the project template.

See [Archiving quick tasks](how-to/handle-quick-and-fast-tasks.md#archiving-quick-tasks) for the full walkthrough.

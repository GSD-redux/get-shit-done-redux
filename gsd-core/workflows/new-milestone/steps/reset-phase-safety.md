## 7.5 Reset-phase safety (only when `--reset-phase-numbers`)

If `--reset-phase-numbers` is active:

1. Set starting phase number to `1` for the upcoming roadmap.
2. If `phase_dir_count > 0`, archive the old phase directories before roadmapping so new `01-*` / `02-*` directories cannot collide with stale milestone directories.

If `phase_dir_count > 0` and `phase_archive_path` is available:

```bash
mkdir -p "${phase_archive_path}"
find .planning/phases -mindepth 1 -maxdepth 1 -type d -exec mv {} "${phase_archive_path}/" \;
```

Then verify `.planning/phases/` no longer contains old milestone directories before continuing.

If `phase_dir_count > 0` but `phase_archive_path` is missing:
- Stop and explain that reset numbering is unsafe without a completed milestone archive target.
- Tell the user to complete/archive the previous milestone first, then rerun `/gsd:new-milestone --reset-phase-numbers ${GSD_WS}`.

---
type: Added
pr: 2679
---
**`/gsd:update` now offers to restore the user-added files it backs up** — files you added inside GSD-managed directories were copied to `gsd-user-files-backup/` before the clean install and then left there forever; only `--reapply` (a different bucket, `gsd-local-patches/`) had a restore path. The update now lists what it backed up, runs a compatibility pass against the newly installed release, and offers to put the files back. Declining leaves the backup untouched, and the backup is never deleted. (#1854)

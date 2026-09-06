---
type: Added
pr: 4425
---
Local installs accept a new --relative-includes flag (or GSD_RELATIVE_INCLUDES=1) that writes project-relative @ includes, so a repository worked from several git worktrees no longer has every worktree reading its workflow prose out of whichever checkout ran the installer.

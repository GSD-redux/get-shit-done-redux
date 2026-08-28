---
type: Security
pr: 0
---
**Atomic config writes preserve hardened file permissions and create temp files exclusively** — a chmod 600 on settings.json, settings.local.json, or defaults.json now survives the temp+rename write instead of silently resetting to the umask default; temp files are opened with O_EXCL so a symlink pre-planted at the predictable temp path is never followed; and the install-migration lock writes its payload through the exclusively-created descriptor, closing a symlink-swap window between create and write.

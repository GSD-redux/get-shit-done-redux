---
type: Fixed
pr: 3600
---
**User profile and dev-preferences files are no longer lost when an install or uninstall is interrupted.** These files were held only in memory while GSD deleted and rebuilt the directory containing them, so pressing Ctrl-C — or any crash during the copy — destroyed them permanently. On the main install path that window spanned the entire gsd-core tree rebuild. They are now staged to disk before anything is deleted, and any copy orphaned by an interrupted run is restored automatically on the next install or uninstall. (#1874)

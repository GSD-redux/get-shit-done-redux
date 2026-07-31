---
type: Fixed
pr: 3385
---
Installer: a malformed settings.local.json is no longer overwritten by the #338 migration — readSettings()'s null 'could not parse, preserve existing' signal is now honored, and the whole migration stands down so the shared GSD entries are not stripped either. Also fixes two crashes on that path: an unparseable settings file previously aborted the install with a TypeError instead of skipping the file.

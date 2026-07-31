---
type: Fixed
pr: 3385
---
Installer: ~/.gsd/defaults.json is now written under the install-migration lock and in a single atomic write. Concurrent installs for different runtimes can no longer lose each other's settings, and a crash mid-write can no longer truncate this machine-global file (which the read path treats as absent, silently degrading model resolution for every project on the machine). An install that changes nothing no longer rewrites the file.

---
type: Fixed
pr: 4375
---
**Managed hooks no longer break on keg-only Homebrew node** — on a Homebrew Node installed as a versioned, unlinked formula (e.g. node@24), every managed hook failed at invocation with `/bin/sh: <prefix>/bin/node: No such file or directory`; the Homebrew path rewrite now verifies the stable symlink exists before using it and keeps the working install path otherwise. (#4137)

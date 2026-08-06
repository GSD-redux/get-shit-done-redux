---
type: Fixed
pr: 3100
---
**Bug-report template version guidance corrected** — the template pointed reporters at `npm list -g`, which does not track what `/gsd-update` installs into the runtime home. It now points at the `gsd-file-manifest.json` version field that the installer writes. (#2998)

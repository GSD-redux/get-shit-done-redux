---
id: 31
title: Update System
group: Utility Features
---

**Command:** `/gsd-update`

**Purpose:** Update GSD to the latest version with changelog preview.

**Requirements:**
- REQ-UPDATE-01: System MUST check for new versions via npm
- REQ-UPDATE-02: System MUST display changelog for new version before updating
- REQ-UPDATE-03: System MUST be runtime-aware and target the correct directory
- REQ-UPDATE-04: System MUST back up locally modified files to `gsd-local-patches/`
- REQ-UPDATE-05: `/gsd-update --reapply` MUST restore local modifications after update
- REQ-UPDATE-06: `/gsd-update --next` (alias `--rc`) MUST target the `@next` RC dist-tag for version check and install; omitting the flag MUST keep `@latest` behavior unchanged (ADR #660)
- REQ-UPDATE-07: System MUST back up user-added files found inside GSD-managed directories to `gsd-user-files-backup/` before the clean install
- REQ-UPDATE-08: When that backup is non-empty, the update MUST offer an explicit restore choice before finishing, and MUST leave the backup intact whichever way the user answers
- REQ-UPDATE-09: A restore MUST NOT overwrite a path the newly installed release ships, MUST NOT overwrite a different file already on disk, and MUST report best-effort compatibility warnings for restored files without blocking on them

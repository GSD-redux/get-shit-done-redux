---
id: 128
title: Update Banner Opt-In
group: v1.41.0 Features
---

**Purpose:** Surface update availability to users who have declined or bypassed the GSD statusline, without requiring the statusline.

**Behavior:**
- At install time, if the installer detects no GSD statusline, it offers an opt-in `SessionStart` hook.
- The hook reads the existing `~/.cache/gsd/gsd-update-check.json` cache — the same cache used by the statusline — and prints a banner only when an update is available.
- Silent when up-to-date.
- Failure diagnostics rate-limited to once per 24 h.
- Cleanly removed by `npx @opengsd/gsd-core --uninstall`.

**Requirements:**
- REQ-BANNER-01: Banner does not install without explicit opt-in.
- REQ-BANNER-02: No additional network requests — reuses the existing background update-check cache.
- REQ-BANNER-03: Uninstall path removes the banner hook.

**Reference issue:** [#2795](https://github.com/open-gsd/gsd-core/pull/2795)

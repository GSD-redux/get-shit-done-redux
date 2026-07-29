---
type: Fixed
pr: 2802
---
**Permission errors on phase and milestone directories now surface instead of looking empty** — an unreadable phase directory used to be silently reported as "no CONTEXT.md" (so the discuss/plan gates wrongly skipped context) and an unreadable `milestones/` directory as "no archives" (so active-milestone resolution and archived-phase filtering misbehaved), because both scans treated a permission or I-O failure the same as a genuinely empty directory. (#1883)

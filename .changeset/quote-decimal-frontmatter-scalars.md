---
type: Fixed
pr: 4151
---
**Decimal-shaped frontmatter scalars (e.g. a `22.10` phase id) are now quoted on write**, so a spec-compliant YAML reader preserves them as the exact string instead of reloading `22.10` as the float `22.1` — which collided with `22.1` and dropped the trailing zero. All-digit integers (counts, phase numbers, leading-zero ids like `02`) stay unquoted; `gsd_state_version` is now written `"1.0"`, matching the STATE.md template. (#4053)

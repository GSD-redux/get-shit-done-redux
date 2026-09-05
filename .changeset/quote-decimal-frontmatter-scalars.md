---
type: Fixed
pr: 4165
---
**Decimal-shaped frontmatter scalars (e.g. a `22.10` phase id) are now quoted on write**, so a spec-compliant YAML reader preserves them as the exact string instead of reloading `22.10` as the float `22.1` — which collided with `22.1`, a different phase. Exponent, hex, octal and binary forms are quoted likewise. All-digit values (integer counts and zero-padded ids like `02`) stay unquoted as a deliberate scoped trade-off; `gsd_state_version` is now written `"1.0"`, matching the quoted form in the STATE.md template. (#4053)

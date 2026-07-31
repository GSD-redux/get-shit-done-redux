---
type: Fixed
pr: 2888
---
**Dev-dependency `brace-expansion` bumped to patched versions (1.1.18 / 5.0.9), resolving the high-severity DoS/OOM advisories** — the lockfile now pins the 2026-07-30 patch backports reachable via eslint and stryker. A non-breaking in-range bump (no overrides, no major bumps); production `npm audit --omit=dev` is unaffected (devDependency only). (#2765)

---
type: Fixed
pr: 3246
---
**Dev-dependency `js-yaml` bumped to the patched 4.3.1, resolving a high-severity quadratic-CPU advisory** — the lockfile now pins the backported `!!omap` fix (GHSA-5p4m-2wfm-xmqj, CVSS 7.5), reachable via eslint. A non-breaking in-range bump (no overrides, no major bump, one package moved); production `npm audit --omit=dev` is unaffected (devDependency only). (#3238)

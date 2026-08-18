---
type: Fixed
pr: 0
---
**Running a capability's own test suite no longer silently deactivates it** — `bundleContentHash` digested every entry under a capability bundle with no exclusions, so ordinary Python bytecode caching (`__pycache__/*.pyc`, written by any plain `python3` run) changed the consent-binding hash. The capability then reported `inactive` with no error and no warning, and `loop render-hooks` quietly dropped its step and gate — indistinguishable from never having installed it. An *empty* `__pycache__` directory was enough to trigger it, since the digest binds directory existence. Derived-cache entries (`__pycache__`, `.pytest_cache`, `.DS_Store`, `*.pyc`, `*.pyo`) are now excluded from the digest only; `node_modules` and other executable content stay bound, excluded entries still count toward the walk's caps, and the filter runs after the symlink rejection so it cannot smuggle one past. (#3631)

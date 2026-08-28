---
type: Changed
pr: 3937
---
**A security scanner that cannot compute a diff now fails instead of reporting clean** — `secret-scan`, `base64-scan` and `prompt-injection-scan` previously exited 0 for a bad ref, a missing repository, or a repository with no commits, which is indistinguishable from a genuine all-clear to any CI gate. They now distinguish four outcomes: scanned clean, nothing was in scope, could not establish scope, and findings. The security workflow treats nothing-in-scope as a pass and could-not-scan as a failure. (#3908)

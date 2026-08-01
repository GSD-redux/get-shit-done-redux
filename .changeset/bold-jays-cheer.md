---
type: Fixed
pr: 2981
---
**`execute-phase` now warns when local commits are ahead of origin** — forking the phase branch from `origin/$DEFAULT_BRANCH` silently missed unpushed local commits (e.g. plan/research docs). A loud WARNING now names the divergence before the fork. (#2639)

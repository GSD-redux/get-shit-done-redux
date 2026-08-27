---
type: Fixed
pr: 3814
---
**Resuming `/gsd-execute-phase` on a phase whose verification passed but whose run died before marking complete now finishes the job** — the phase is marked complete, progress state advances, phase todos close, and the transition handoff runs, instead of every resume reporting "nothing to do" while the roadmap checkbox stays unticked forever. Already-completed phases keep exiting cleanly, and verification is never redone. (#3684)

---
type: Fixed
pr: 2700
---
**Verification-status next-step commands now use the command surface each runtime actually installs** — on a Codex project, a phase blocked on verification suggested `/gsd:execute-phase`, which Codex does not install; the correct form is `$gsd-execute-phase`. The routing table stored hard-coded, deprecated colon-form strings with no runtime context, so `phase complete` and `query verification.status` relayed them verbatim to every runtime. All four routed states (missing, unknown, gaps_found, stale) now project through the shared runtime formatter. (#2617)

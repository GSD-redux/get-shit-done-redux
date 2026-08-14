---
type: Fixed
pr: 0
---
The `init phase-op`, `init plan-phase` and `init execute-phase` queries no longer hand consumers a fully-formed absolute path for a `REQUIREMENTS.md`/`STATE.md`/`ROADMAP.md` that does not exist. Those three fields were built with a bare path.join and no existence check, so a non-null value was indistinguishable from the file actually being there — even as the conditional sibling fields in the same payload (`patterns_path`, `context_path`, ...) already returned null for absent files, and `ultraplan-phase.md` explicitly gates its REQUIREMENTS.md read on `requirements_path is not null`. Each of the three reading sites now returns null when the file is absent and its absolute path when present. The project/milestone-bootstrap and doc-ingest emitters that use these paths as write-targets for not-yet-created files are intentionally unchanged. (#3188)

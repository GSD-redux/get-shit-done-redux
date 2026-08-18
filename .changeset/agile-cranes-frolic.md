---
type: Fixed
pr: 0
---
**Roadmap `Plans:` lines keep their hand-written text instead of being overwritten with a plan count** — `roadmap update-plan-progress` replaced everything after the `Plans:` label whenever the line did not already begin with a canonical `N/N plans` token, silently destroying freeform prose, a `TBD` note, or a hand-written annotation. A sentence that wrapped onto a second line lost only its first line, leaving the continuation stranded so the roadmap asserted something nobody wrote — at exit 0, in a diff that read as a routine count bump. The count is now written only over a real count token or the fresh-template placeholder, and a single-plan phase (`1 plan`) is recognized rather than frozen. (#3584)

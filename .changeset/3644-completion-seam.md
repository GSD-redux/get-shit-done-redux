---
type: Added
pr: 3644
---
**The phase-directory membership seam threads the phase ID convention through the completion chain** — the #3511 seam (`isPhaseArtifact` / `scopeToPhase`) now takes the same optional convention every other read-path helper does, and the completion chain threads it: `state json` / `state sync`'s completed-phase counting, the planning snapshot, roadmap analysis, `state validate`'s drift scan, and the verification-report resolver. A bracket directory therefore scopes its listing by its real phase token instead of the include-everything ambiguity fail-safe, so a cross-phase stray (`01-VERIFICATION.md` misfiled into phase 03's directory) can no longer complete a bracket phase — the same protection #3511 already gives legacy directories.

Aggregate scans whose call sites do not yet resolve a convention (`uat`, `audit`, `init`'s projections, `gap-checker`, `phase-locator`) keep the documented include-everything fail-safe on bracket directories; threading those readers is follow-up-slice work alongside the epic's other convention-less readers. A project on any convention other than `"bracket"` is unaffected. (#2761)

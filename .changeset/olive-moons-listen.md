---
type: Fixed
pr: 0
---
**`/gsd-audit-uat` no longer drops a whole phase's verification debt on the floor** — a `*-VERIFICATION.md` whose status is `gaps_found` reported zero items, so the file never entered the results and its phase disappeared from the report entirely. `cmdAuditUat` admitted both non-passing statuses, then `parseVerificationItems` honoured only `human_needed` and returned an empty array for the other, standing on a comment that deferred to `plan-phase --gaps` — a different command the audit never reaches. A `gaps_found` report now contributes its `human_verification:` entries and its frontmatter `gaps:` entries, skipping any already marked `status: resolved` or carrying a `resolution:`. The `human_needed` path is byte-for-byte unchanged. (#3850)

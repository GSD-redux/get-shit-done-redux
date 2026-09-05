---
type: Fixed
pr: 3879
---
**`/gsd-audit-uat` now surfaces a `gaps_found` verification report's frontmatter debt instead of dropping the phase entirely** — a `*-VERIFICATION.md` whose status is `gaps_found` reported zero items, so the file never entered the results and its phase disappeared from the report. `cmdAuditUat` admitted both non-passing statuses, then `parseVerificationItems` honoured only `human_needed` and returned an empty array for the other, standing on a comment that deferred to `plan-phase --gaps` — a different command the audit never reaches.

Entries already closed are skipped on **both** statuses, so a `human_needed` file whose entries are mostly resolved no longer over-reports either. Closure is read from the parsed fields, so a `truth:` whose text merely mentions "resolution:" is not mistaken for a closed entry.

What counts as closed follows the key. A `gaps:` entry closes on `status: resolved` and nothing else, matching the rule the `## Gaps` markdown reader already applies, so the same authored entry cannot read closed in one reader and open in the other. A `human_verification:` entry also closes on a bare `resolution:` field, because verifier-written entries record closure that way — but only where no `status:` contradicts it. An entry reading `status: failed` alongside a `resolution:` note is reported, not dropped.

Scope, stated precisely: this covers gaps recorded in a report's **frontmatter**. A report authored to the template's `## Gaps Summary` prose shape (`gsd-core/templates/verification-report.md`) records its gaps in the body, and those are still not counted. (#3850)

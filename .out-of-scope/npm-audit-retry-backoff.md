# Retry/backoff and cached-advisory paths for the npm-audit CI gate

**Source:** [#4260](https://github.com/open-gsd/gsd-core/issues/4260)
**Decision:** wontfix — redirected to #4251 (the audit-gate hardening work)
**Date:** 2026-09-04

## Proposal summary

#4260 asked for the npm-audit CI gate to distinguish "no advisories" from "could not ask": when
`registry.npmjs.org`'s bulk-advisories endpoint is slow or unreachable, the gate throws and blocks
every open PR even though a fetch that never completed is not evidence of a vulnerability. The
specific mechanisms proposed were retry with backoff (on POSIX CI the audit is attempted exactly
once — the candidate loop iterates npm binaries, not attempts) and/or a cached-advisory path. The
issue also flagged that the gate which actually reddens CI
(`tests/npm-integrity-gate.test.cjs`'s `auditProductionVulns`) carries a near-copy of
`runPackageLockAudit`, so a retry added to `scripts/npm-audit-baseline.cjs` alone would not reach
the failing path, and asked that the extraction be finished so the fix lands in one place.

## Why GSD does not own this

- **The maintainer judged the ask covered by the in-flight work in [PR #4251](https://github.com/open-gsd/gsd-core/pull/4251)** (fixes #4250), which adds an `isTimeoutKill` predicate and a shared timeout-error builder used by both audit call sites, so a timed-out audit reports its real cause instead of a JSON parse error. Carrying the retry/backoff design as a *separate* enhancement issue was declined; the hardening is being worked through #4251. **Scope note, verified 2026-09-04:** #4251 does **not** finish the extraction — `auditProductionVulns` in `tests/npm-integrity-gate.test.cjs` remains a separate near-copy of `runPackageLockAudit` with its own candidate loop and `AUDIT_TIMEOUT_MS`. The fix-location hazard #4260 flagged is therefore still live: any future retry work must touch both sites or finish the extraction first.
- **The proposal got two things RIGHT that this entry does not deny:** the single-attempt/no-backoff observation was accurate, and the halfway-extraction observation was accurate — only the error-classification half is addressed by #4251, not the duplication itself. This entry records a redirect, not a rejection of the diagnosis.

## What this does NOT cover

This entry denies **filing the audit transport-resilience work as a standalone enhancement**. It does not deny, and must never be cited against:

- **Retry/backoff or advisory-caching inside the #4251 workstream itself.** If that PR's follow-ups adopt them, this entry is satisfied, not violated.
- **A future re-filing if, after #4251 lands, the gate still hard-fails on transport errors with no retry.** That residual gap would be a new issue referencing this one.
- **The advisory gate tripping on a real published advisory** — that is the gate working and was never in question (#4260 explicitly disclaimed it).

## Re-open criteria

- PR #4251 lands **and** the merged gate still fails closed on a transport error (timeout,
  connection refused, DNS) with no retry, backoff, or cached-advisory path — at that point the
  residual resilience gap is a live defect of the gate, not a redirected enhancement. Note the
  two functions are still duplicated after #4251, so that work must fix both sites or finish the
  extraction.
- The npm bulk-advisories endpoint's degradation becomes chronic enough that a cached-advisory
  path is a reliability requirement rather than a nicety.

## Related

- [PR #4251](https://github.com/open-gsd/gsd-core/pull/4251) — fix(#4250): distinguish a timed-out npm audit from a JSON parse failure; the redirect target
- [#4250](https://github.com/open-gsd/gsd-core/issues/4250) — the diagnosis issue #4251 fixes

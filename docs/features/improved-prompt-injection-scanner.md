---
id: 99
title: Improved Prompt Injection Scanner
group: v1.34.0 Features
---

**Hook:** `gsd-prompt-guard.js`, `gsd-read-injection-scanner.js`
**Script:** `scripts/prompt-injection-scan.sh`, `scripts/base64-scan.sh`

**Purpose:** Defense-in-depth detection of prompt injection attempts in planning artifacts and ingested content. Live hooks inline their own pattern subsets for hook independence (they do not import from `security.cts`). The CI scanner (`scanForInjection` in `security.cts`) provides a centralized engine for codebase-wide scanning in tests.

**Requirements:**
- REQ-SCAN-INJ-01: Live hooks MUST detect invisible Unicode characters (zero-width spaces, soft hyphens, Unicode tag block U+E0000–E007F)
- REQ-SCAN-INJ-02: Live hooks MUST detect known injection patterns (instruction override, role manipulation, system-prompt extraction, fake message boundaries). Base64-decode scanning is a CI-time control (`scripts/base64-scan.sh`), not a live hook — live hooks match a base64-exfiltration phrase regex only, they do not decode.
- REQ-SCAN-INJ-03: ~~Scanner MUST apply entropy analysis~~ — Entropy analysis (`scanEntropyAnomalies`) was removed in #2198 as dead code (zero production callers; live hooks do not perform entropy analysis). This requirement is deferred pending a maintainable live implementation.
- REQ-SCAN-INJ-04: Scanner MUST remain advisory-only — detection is logged, not blocking
- REQ-SCAN-INJ-05: A scanner that could not establish its file list MUST NOT report clean (#3908). The CI scanners (`prompt-injection-scan.sh`, `base64-scan.sh`, `secret-scan.sh`) distinguish four outcomes rather than collapsing them into exit 0:

  | Outcome | Exit | Meaning |
  |---|---|---|
  | scanned, no findings | `0` | files were in scope and none matched |
  | findings | `1` | the scan's own verdict |
  | nothing in scope | `NO_INPUT` | the diff resolved and was genuinely empty — e.g. a docs-only PR |
  | could not scan | `UNAVAILABLE` | the file list was never established: a bad ref, no repository, or a repository with no commits |

  Codes come from the exit-code registry ([ADR-3889](adr/3889-process-exit-contract.md)), sourced from `gsd-core/bin/shared/exit-codes.sh`, never written into the scripts. Every one is non-zero, so a caller written `if ! scanner; then` behaves identically for a clean scan and trips for everything else — this can turn a false green red, never a red green. `.github/workflows/security-scan.yml` treats *nothing in scope* as a pass and *could not scan* as a failure; previously the latter passed silently, having scanned nothing.

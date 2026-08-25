---
id: 98
title: Autonomous Audit-to-Fix
group: v1.34.0 Features
---

**Command:** `/gsd-audit-fix [--source <audit>] [--severity high|medium|all] [--max N] [--dry-run]`

**Purpose:** End-to-end pipeline that runs an audit, classifies findings as auto-fixable vs. manual-only, then autonomously fixes auto-fixable issues with test verification and atomic commits.

**Requirements:**
- REQ-AUDITFIX-01: Findings MUST be classified as auto-fixable or manual-only before any changes
- REQ-AUDITFIX-02: Each fix MUST be verified with tests before committing
- REQ-AUDITFIX-03: Each fix MUST be committed atomically
- REQ-AUDITFIX-04: `--dry-run` MUST show classification table without applying any fixes
- REQ-AUDITFIX-05: `--max N` MUST limit the number of fixes applied in one run (default: 5)

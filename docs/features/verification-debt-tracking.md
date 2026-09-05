---
id: 40
title: Verification Debt Tracking
group: Infrastructure Features
---

**Command:** `/gsd-audit-uat`

**Purpose:** Prevent silent loss of UAT/verification items when projects advance past phases with outstanding tests. Surfaces verification debt across all prior phases so items are never forgotten.

**Components:**

**1. Cross-Phase Health Check** (progress.md Step 1.6)
Every `/gsd-progress` call scans ALL phases in the current milestone for outstanding items (pending, skipped, blocked, human_needed, gaps_found). Displays a non-blocking warning section with actionable links.

A verification report counts as outstanding under EITHER terminal non-passing status: `human_needed` contributes its `human_verification:` entries, and `gaps_found` contributes both its `human_verification:` and its `gaps:` entries, excluding any already closed. What counts as closed is per key: a `gaps:` entry closes on `status: resolved` and nothing else — the same rule the `## Gaps` markdown reader applies, so one authored entry cannot read closed in one reader and open in the other — while a `human_verification:` entry also closes on a bare `resolution:` field, provided no `status:` contradicts it (#3850).

**2. `status: partial`** (verify-work.md, UAT.md)
New UAT status that distinguishes between "session ended" and "all tests resolved". Prevents `status: complete` when tests are still pending, blocked, or skipped without reason.

**3. `result: blocked` with `blocked_by` tag** (verify-work.md, UAT.md)
New test result type for tests blocked by external dependencies (server, physical device, release build, third-party services). Categorized separately from skipped tests.

**4. HUMAN-UAT.md Persistence** (execute-phase.md)
When verification returns `human_needed`, items are persisted as a trackable HUMAN-UAT.md file with `status: partial`. Feeds into the cross-phase health check and audit systems.

**5. Phase Completion Warnings** (phase.cjs, transition.md)
`phase complete` CLI returns verification debt warnings in its JSON output. Transition workflow surfaces outstanding items before confirmation.

**Requirements:**
- REQ-DEBT-01: System MUST surface outstanding UAT/verification items from ALL prior phases in `/gsd-progress`
- REQ-DEBT-02: System MUST distinguish incomplete testing (partial) from completed testing (complete)
- REQ-DEBT-03: System MUST categorize blocked tests with `blocked_by` tags
- REQ-DEBT-04: System MUST persist human_needed verification items as trackable UAT files
- REQ-DEBT-05: System MUST warn (non-blocking) during phase completion and transition when verification debt exists
- REQ-DEBT-06: `/gsd-audit-uat` MUST scan all phases, categorize items by testability, and produce a human test plan

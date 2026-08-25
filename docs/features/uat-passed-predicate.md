---
id: 143
title: UAT-Passed Predicate
group: v1.42.1 Features
---

**CLI:** `node gsd-tools.cjs phase uat-passed <N> [--require-verification]`

**Purpose:** Provide a runtime-neutral, automatable predicate that evaluates HUMAN-UAT results for a phase and returns a structured pass/fail verdict with full diagnostic detail.

**Behavior:** Locates `*-UAT.md` and optionally `*-VERIFICATION.md` files for the given phase, parses UAT test blocks (heading-block parser, column-0 result lines) with a markdown-aware stripper that removes false-positive contexts (YAML frontmatter, fenced code blocks, HTML comments, and blockquotes). Returns `passed: true` only when at least one check exists AND all checks pass AND no blockers — fail-closed, no vacuous pass. The `--require-verification` flag requires at least one `*-VERIFICATION.md` with an allowlisted passing status; the command fails without one.

**Output envelope:** `{ passed, uat_files[], verification_files[], checks[], blockers[], no_uat_artifacts, policy: { require_verification } }`

| Field | Type | Description |
|-------|------|-------------|
| `passed` | `boolean` | `true` only when ≥1 check exists AND all passing AND no blockers |
| `uat_files` | `string[]` | Filenames of `*-UAT.md` files evaluated |
| `verification_files` | `string[]` | Filenames of `*-VERIFICATION.md` files evaluated |
| `checks[]` | `{ file, test, name, result, passing }[]` | Per-item results from heading blocks |
| `blockers[]` | `string[]` | Human-readable failure reasons (frontmatter, failing/missing items, policy, malformed markdown) |
| `no_uat_artifacts` | `boolean` | `true` when no test items were parsed; `passed` is always `false` when `true` |
| `policy.require_verification` | `boolean` | Whether `--require-verification` was active |

**Requirements:**
- REQ-UAT-PRED-01: The predicate MUST ignore result lines inside YAML frontmatter, fenced code blocks, HTML comments, and blockquotes.
- REQ-UAT-PRED-02: `passed: true` MUST require at least one check AND all checks passing AND no blockers (fail-closed, no vacuous pass).
- REQ-UAT-PRED-03: `--require-verification` MUST cause the command to fail when no `*-VERIFICATION.md` file with an allowlisted passing status is found.
- REQ-UAT-PRED-04: `blockers[]` contains all human-readable failure reasons including frontmatter issues, policy violations, and malformed markdown — NOT limited to a subset of `checks[]`.
- REQ-UAT-PRED-05: The module MUST be runtime-neutral (no runtime-specific env checks or exit shortcuts).
- REQ-UAT-PRED-06: A heading block with no column-0 `result:` line emits `result:'missing'` (blocker); test items are never silently dropped.

**Reference:** [Phase Management Commands](COMMANDS.md#phase-uat-passed-n---require-verification)

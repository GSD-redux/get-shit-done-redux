---
id: 4273
title: TDD-Applicability Predicate
group: Quality Assurance Features
---

**Purpose:** Give the workflow engine one code-owned computation for whether TDD's RED/GREEN/REFACTOR
procedure applies to a given plan, instead of restating the same precedence logic as hand-written prose in
each dispatch backend — a restatement that had already drifted between two backends (#4264, #4265). This
is Phase 1 of epic #4272 (ADR-3473's fourth application of the single-owner-predicate pattern): it ships
the isolated `phase.tdd-applicable` query verb only. Wiring `execute-phase.md` and its
executor-isolation-dispatch step to consume the verb instead of their own inline predicates is a later
phase of the same epic.

**Command:** `gsd-tools query phase.tdd-applicable <plan-file> [--cli-flag]`

**Requirements:**
- REQ-TDDA-01: System MUST resolve applicability via a fixed precedence: `--cli-flag` (explicit override) >
  plan frontmatter `type: tdd` > any task in the plan carrying `tdd="true"` > project config
  `workflow.tdd_mode`
- REQ-TDDA-02: System MUST report which precedence tier decided the outcome (`cli_flag`, `plan_frontmatter`,
  `task_attribute`, `config`, or `none`) alongside the boolean result
- REQ-TDDA-03: System MUST emit JSON (`applicable`, `source`, `plan_type`, `config_tdd_mode`,
  `cli_flag_present`) so callers can consume the decision without re-deriving it

---
id: 116
title: TDD Pipeline Mode
group: v1.36.0 Features
---

**Purpose:** Opt-in TDD (red-green-refactor) as a first-class phase execution mode. When enabled, the planner aggressively selects `type: tdd` for eligible tasks and the executor enforces RED/GREEN/REFACTOR gate sequence with fail-fast on unexpected GREEN before RED.

**Requirements:**
- REQ-TDD-01: `workflow.tdd_mode` config key (boolean, default `false`)
- REQ-TDD-02: When enabled, planner applies TDD heuristics from `references/tdd.md` to all eligible tasks (business logic, APIs, validations, algorithms, state machines)
- REQ-TDD-03: Executor enforces gate sequence for `type: tdd` plans — RED commit (`test(...)`) must precede GREEN commit (`feat(...)`)
- REQ-TDD-04: Executor fails fast if tests pass unexpectedly during RED phase (feature already exists or test is wrong)
- REQ-TDD-05: End-of-phase collaborative review checkpoint verifies gate compliance across all TDD plans (advisory, non-blocking)
- REQ-TDD-06: Gate violations surfaced in SUMMARY.md under `## TDD Gate Compliance` section

**Configuration:** `workflow.tdd_mode`
**Reference files:** `tdd.md`, `checkpoints.md`

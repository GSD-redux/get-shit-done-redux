---
id: 108
title: Plan Bounce
group: v1.36.0 Features
---

**Command:** `/gsd-plan-phase N --bounce`

**Purpose:** After plans pass the checker, optionally refine them through an external script (a second AI, a linter, a custom validator). The bounce step backs up each plan, runs the script, validates YAML frontmatter integrity on the result, re-runs the plan checker, and restores the original if anything fails.

**Requirements:**
- REQ-BOUNCE-01: `--bounce` flag or `workflow.plan_bounce: true` activates the step; `--skip-bounce` always disables it
- REQ-BOUNCE-02: `workflow.plan_bounce_script` must point to a valid executable; missing script produces a warning and skips
- REQ-BOUNCE-03: Each plan is backed up to `*-PLAN.pre-bounce.md` before the script runs
- REQ-BOUNCE-04: Bounced plans with broken YAML frontmatter or that fail the plan checker are restored from backup
- REQ-BOUNCE-05: `workflow.plan_bounce_passes` (default: 2) controls how many refinement passes the script receives

**Configuration:** `workflow.plan_bounce`, `workflow.plan_bounce_script`, `workflow.plan_bounce_passes`

---
id: 117
title: Spike Command
group: v1.37.0 Features
---

**Command:** `/gsd-spike [idea] [--quick]`

**Purpose:** Run 2–5 focused feasibility experiments before committing to an implementation approach. Each experiment uses Given/When/Then framing, produces executable code, and returns a VALIDATED / INVALIDATED / PARTIAL verdict. Companion `/gsd-spike --wrap-up` packages findings into a project-local skill.

**Requirements:**
- REQ-SPIKE-01: Each experiment MUST produce a Given/When/Then hypothesis before any code is written
- REQ-SPIKE-02: Each experiment MUST include working code or a minimal reproduction
- REQ-SPIKE-03: Each experiment MUST return one of: VALIDATED, INVALIDATED, or PARTIAL verdict with evidence
- REQ-SPIKE-04: Results MUST be stored in `.planning/spikes/NNN-experiment-name/` with a README and MANIFEST.md
- REQ-SPIKE-05: `--quick` flag skips intake conversation and uses the argument text as the experiment direction
- REQ-SPIKE-06: `/gsd-spike --wrap-up` MUST package findings into `.claude/skills/spike-findings-[project]/`

**Produces:**

| Artifact | Description |
|----------|-------------|
| `.planning/spikes/NNN-name/README.md` | Hypothesis, experiment code, verdict, and evidence |
| `.planning/spikes/MANIFEST.md` | Index of all spikes with verdicts |
| `.claude/skills/spike-findings-[project]/` | Packaged findings (via `/gsd-spike --wrap-up`) |

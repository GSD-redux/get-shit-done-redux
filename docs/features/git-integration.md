---
id: 34
title: Git Integration
group: Infrastructure Features
---

**Purpose:** Atomic commits, branching strategies, and clean history management.

**Requirements:**
- REQ-GIT-01: Each task MUST get its own atomic commit
- REQ-GIT-02: Commit messages MUST follow structured format: `type(scope): description`
- REQ-GIT-03: System MUST support 3 branching strategies: `none`, `phase`, `milestone`
- REQ-GIT-04: Phase strategy MUST create one branch per phase
- REQ-GIT-05: Milestone strategy MUST create one branch per milestone
- REQ-GIT-06: Complete-milestone MUST offer squash merge (recommended) or merge with history
- REQ-GIT-07: System MUST respect `commit_docs` setting for `.planning/` files
- REQ-GIT-08: System MUST auto-detect `.planning/` in `.gitignore` and skip commits

**Commit Format:**
```
type(phase-plan): description

# Examples:
docs(08-02): complete user registration plan
feat(08-02): add email confirmation flow
fix(03-01): correct auth token expiry
```

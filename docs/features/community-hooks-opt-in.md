---
id: 88
title: Community Hooks Opt-In
group: v1.32 Features
---

**Hooks:** `gsd-validate-commit.sh`, `gsd-session-state.sh`, `gsd-phase-boundary.sh`

**Purpose:** Optional git and session hooks for GSD projects, gated behind `hooks.community: true` in config.

**Requirements:**
- REQ-COMMUNITY-01: All community hooks MUST be no-ops unless `hooks.community` is `true` in `.planning/config.json`
- REQ-COMMUNITY-02: `gsd-validate-commit.sh` MUST enforce Conventional Commits format on git commit messages
- REQ-COMMUNITY-03: `gsd-session-state.sh` MUST track session state transitions
- REQ-COMMUNITY-04: `gsd-phase-boundary.sh` MUST enforce phase boundary checks

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `hooks.community` | boolean | `false` | Enable optional community hooks for commit validation, session state, and phase boundaries |
| `hooks.commit_types` | array of strings | `[]` | Extra Conventional Commits types `gsd-validate-commit.sh` accepts, in addition to the built-in `feat, fix, docs, style, refactor, perf, test, build, ci, chore` — never replaces them. Each entry must match `^[a-z][a-z0-9-]*$` (lowercase letters, digits, hyphens); non-conforming or non-string entries are dropped. Example: `{ "hooks": { "community": true, "commit_types": ["enhance", "enh", "revert"] } }`. |

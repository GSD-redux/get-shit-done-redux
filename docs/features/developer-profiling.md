---
id: 38
title: Developer Profiling
group: Infrastructure Features
---

**Command:** `/gsd-profile-user [--questionnaire] [--refresh]`

**Purpose:** Analyze Claude Code session history to build behavioral profiles across 8 dimensions, generating artifacts that personalize Claude's responses to the developer's style.

**Dimensions:**
1. Communication style (terse vs verbose, formal vs casual)
2. Decision patterns (rapid vs deliberate, risk tolerance)
3. Debugging approach (systematic vs intuitive, log preference)
4. UX preferences (design sensibility, accessibility awareness)
5. Vendor/technology choices (framework preferences, ecosystem familiarity)
6. Frustration triggers (what causes friction in workflows)
7. Learning style (documentation vs examples, depth preference)
8. Explanation depth (high-level vs implementation detail)

**Generated Artifacts:**
- `USER-PROFILE.md` — Full behavioral profile with evidence citations
- `CLAUDE.md` profile section — Auto-discovered by Claude Code

**Flags:**
- `--questionnaire` — Interactive questionnaire fallback when session history is unavailable
- `--refresh` — Re-analyze sessions and regenerate profile

**Pipeline Modules:**
- `profile-pipeline.cjs` — Session scanning, message extraction, sampling
- `profile-output.cjs` — Profile rendering, questionnaire, artifact generation
- `gsd-user-profiler` agent — Behavioral analysis from session data

**Requirements:**
- REQ-PROF-01: Session analysis MUST cover at least 8 behavioral dimensions
- REQ-PROF-02: Profile MUST cite evidence from actual session messages
- REQ-PROF-03: Questionnaire MUST be available as fallback when no session history exists
- REQ-PROF-04: Generated artifacts MUST be discoverable by Claude Code (CLAUDE.md integration)

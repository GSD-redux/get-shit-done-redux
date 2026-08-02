<!-- provenance: template-derived (gsd-core/templates/). NOT real-user-sourced. See #2371 — adequate for happy-path/sequence scenarios, NOT sufficient as a negative fixture asserting the engine correctly rejects input. -->
<!-- Used by scenarios/milestone-rollover.json: stands in for the roadmapper's re-plan after
     `milestone complete 1.0` — a real ROADMAP.md carries the next milestone's version marker,
     which is what lets a boundary-aware oracle actually SEE the milestone_version change
     instead of falling back to the same "v1.0"/"milestone" default the pre-rollover roadmap
     never overrode (see roadmap-parser.cts getMilestoneInfo). -->
# Roadmap: Loop QA Walk Sample

## Overview

🚧 **v2.0 Post-Rollover Milestone** — extend the shipped v1.0 parser with one
more phase now that Phase 1-3 have shipped. Phases for this milestone are not
yet drafted — the next `phase add` call is what introduces Phase 4, exactly
as a planner would after the roadmapper hands off a version-only roadmap.

## Phases

- [ ] **Phase 4: Post-Rollover Work** - Extend the shipped parser with a new feature

## Phase Details

### Phase 4: Post-Rollover Work
**Goal**: Extend the shipped parser with a new feature
**Depends on**: Nothing (new milestone)
**Requirements**: [REQ-06]
**Success Criteria** (what must be TRUE):
  1. The post-rollover feature is implemented and covered by a plan
**Plans**: 1 plan

Plans:
- [ ] 04-01: Implement the post-rollover feature

## Progress

**Execution Order:**
Phases execute in numeric order: 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 4. Post-Rollover Work | 0/1 | Not started | - |

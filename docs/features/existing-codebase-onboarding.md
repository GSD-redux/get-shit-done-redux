---
id: 27b
title: Existing Codebase Onboarding
group: Brownfield Features
order: 27.1
---

**Command:** `/gsd-onboard [--fast] [--text]`

**Purpose:** Guide first-time setup for an existing repository by checking brownfield state, routing through codebase mapping and docs ingest, then handing off to project initialization without silently overwriting planning artifacts.

**Requirements:**
- REQ-ONBOARD-01: System MUST detect existing code, package manifests, planning documents, partial `.planning/` state, and complete or missing codebase-map files.
- REQ-ONBOARD-02: System MUST hand off to `/gsd-map-codebase` or `/gsd-map-codebase --fast` when brownfield code lacks the required `.planning/codebase/` map files; fast-map readiness is partial and MUST NOT be treated as sufficient for `/gsd-new-project`.
- REQ-ONBOARD-03: System MUST offer `/gsd-ingest-docs` before `/gsd-new-project` when ADR/PRD/SPEC/RFC candidates exist and no project exists.
- REQ-ONBOARD-04: System MUST refuse to report onboarding complete until `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, and `STATE.md` all exist.
- REQ-ONBOARD-05: System MUST create or confirm `.planning/onboarding/SUMMARY.md` only after project setup exists.
- REQ-ONBOARD-06: System MUST support `--text` for numbered plain-text gates on runtimes without interactive menus.

**Produces:**
| Artifact | Description |
|----------|-------------|
| `.planning/codebase/` | Codebase map produced by the `/gsd-map-codebase` handoff |
| `.planning/PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md` | Planning setup produced by `/gsd-new-project` or `/gsd-ingest-docs` |
| `.planning/onboarding/SUMMARY.md` | Onboarding status, artifact index, and next-command summary |

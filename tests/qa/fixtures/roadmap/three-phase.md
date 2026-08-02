<!-- provenance: template-derived (gsd-core/templates/). NOT real-user-sourced. See #2371 — adequate for happy-path/sequence scenarios, NOT sufficient as a negative fixture asserting the engine correctly rejects input. -->
# Roadmap: Loop QA Walk Sample

## Overview

Ship a minimal checklist converter in three phases: get the parser working,
add printable output, and polish the CLI surface.

## Phases

- [ ] **Phase 1: Parser** - Parse a markdown task list into structured items
- [ ] **Phase 2: Printable Output** - Render parsed items to a printable page
- [ ] **Phase 3: CLI Polish** - Wire the parser and renderer into a usable CLI

## Phase Details

### Phase 1: Parser
**Goal**: Parse a markdown task list into structured items
**Depends on**: Nothing (first phase)
**Requirements**: [REQ-01, REQ-02]
**Success Criteria** (what must be TRUE):
  1. A markdown checklist file is parsed into an ordered item list
  2. Malformed list items are skipped without crashing the parser
**Plans**: 2 plans

Plans:
- [ ] 01-01: Implement the markdown task-list tokenizer
- [ ] 01-02: Implement the item-list builder

### Phase 2: Printable Output
**Goal**: Render parsed items to a printable page
**Depends on**: Phase 1
**Requirements**: [REQ-03]
**Success Criteria** (what must be TRUE):
  1. Parsed items render as a printable checklist page
**Plans**: 1 plan

Plans:
- [ ] 02-01: Implement the printable renderer

### Phase 3: CLI Polish
**Goal**: Wire the parser and renderer into a usable CLI
**Depends on**: Phase 2
**Requirements**: [REQ-04, REQ-05]
**Success Criteria** (what must be TRUE):
  1. Running the CLI on a markdown file produces a printable page
  2. Invalid input paths produce a clear error message
**Plans**: 1 plan

Plans:
- [ ] 03-01: Wire parser and renderer into the CLI entry point

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Parser | 0/2 | Not started | - |
| 2. Printable Output | 0/1 | Not started | - |
| 3. CLI Polish | 0/1 | Not started | - |

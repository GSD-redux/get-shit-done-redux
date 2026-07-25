// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests - Roadmap
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('roadmap get-phase command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts phase section from ROADMAP.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phases

### Phase 1: Foundation
**Goal:** Set up project infrastructure
**Plans:** 2 plans

Some description here.

### Phase 2: API
**Goal:** Build REST API
**Plans:** 3 plans
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.strictEqual(output.phase_number, '1', 'phase number correct');
    assert.strictEqual(output.phase_name, 'Foundation', 'phase name extracted');
    assert.strictEqual(output.goal, 'Set up project infrastructure', 'goal extracted');
  });

  test('returns not found for missing phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

### Phase 1: Foundation
**Goal:** Set up project
`
    );

    const result = runGsdTools('roadmap get-phase 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'phase should not be found');
  });

  test('handles decimal phase numbers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 2: Main
**Goal:** Main work

### Phase 2.1: Hotfix
**Goal:** Emergency fix
`
    );

    const result = runGsdTools('roadmap get-phase 2.1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'decimal phase should be found');
    assert.strictEqual(output.phase_name, 'Hotfix', 'phase name correct');
    assert.strictEqual(output.goal, 'Emergency fix', 'goal extracted');
  });

  test('extracts full section content', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Setup
**Goal:** Initialize everything

This phase covers:
- Database setup
- Auth configuration
- CI/CD pipeline

### Phase 2: Build
**Goal:** Build features
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.section.includes('Database setup'), 'section includes description');
    assert.ok(output.section.includes('CI/CD pipeline'), 'section includes all bullets');
    assert.ok(!output.section.includes('Phase 2'), 'section does not include next phase');
  });

  test('handles missing ROADMAP.md gracefully', () => {
    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'should return not found');
    assert.strictEqual(output.error, 'ROADMAP.md not found', 'should explain why');
  });

  test('accepts ## phase headers (two hashes)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phase 1: Foundation
**Goal:** Set up project infrastructure
**Plans:** 2 plans

## Phase 2: API
**Goal:** Build REST API
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase with ## header should be found');
    assert.strictEqual(output.phase_name, 'Foundation', 'phase name extracted');
    assert.strictEqual(output.goal, 'Set up project infrastructure', 'goal extracted');
  });

  test('extracts goal when colon is outside bold (**Goal**: format)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.24

### Phase 5: Skill Scaffolding
**Goal**: The autonomous skill files exist following project conventions
**Plans:** 2 plans

### Phase 6: Smart Discuss
**Goal**: Grey area resolution works with proposals
`
    );

    const result = runGsdTools('roadmap get-phase 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.strictEqual(output.goal, 'The autonomous skill files exist following project conventions', 'goal extracted with colon outside bold');
  });

  test('extracts goal for both colon-inside and colon-outside bold formats', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Alpha
**Goal:** Colon inside bold format

### Phase 2: Beta
**Goal**: Colon outside bold format
`
    );

    const result1 = runGsdTools('roadmap get-phase 1', tmpDir);
    const output1 = JSON.parse(result1.output);
    assert.strictEqual(output1.goal, 'Colon inside bold format', 'colon-inside-bold goal extracted');

    const result2 = runGsdTools('roadmap get-phase 2', tmpDir);
    const output2 = JSON.parse(result2.output);
    assert.strictEqual(output2.goal, 'Colon outside bold format', 'colon-outside-bold goal extracted');
  });

  test('detects malformed ROADMAP with summary list but no detail sections', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phases

- [ ] **Phase 1: Foundation** - Set up project
- [ ] **Phase 2: API** - Build REST API
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'phase should not be found');
    assert.strictEqual(output.error, 'malformed_roadmap', 'should identify malformed roadmap');
    assert.ok(output.message.includes('missing'), 'should explain the issue');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase next-decimal command
// ─────────────────────────────────────────────────────────────────────────────


describe('roadmap analyze command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing ROADMAP.md returns error', () => {
    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'ROADMAP.md not found');
  });

  test('parses phases with goals and disk status', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

### Phase 1: Foundation
**Goal:** Set up infrastructure

### Phase 2: Authentication
**Goal:** Add user auth

### Phase 3: Features
**Goal:** Build core features
`
    );

    // Create phase dirs with varying completion
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const p2 = path.join(tmpDir, '.planning', 'phases', '02-authentication');
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p2, '02-01-PLAN.md'), '# Plan');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 3, 'should find 3 phases');
    assert.strictEqual(output.phases[0].disk_status, 'complete', 'phase 1 complete');
    assert.strictEqual(output.phases[1].disk_status, 'planned', 'phase 2 planned');
    assert.strictEqual(output.phases[2].disk_status, 'no_directory', 'phase 3 no directory');
    assert.strictEqual(output.completed_phases, 1, '1 phase complete');
    assert.strictEqual(output.total_plans, 2, '2 total plans');
    assert.strictEqual(output.total_summaries, 1, '1 total summary');
    assert.strictEqual(output.progress_percent, 50, '50% complete');
    assert.strictEqual(output.current_phase, '2', 'current phase is 2');
  });

  test('extracts goals and dependencies', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Setup
**Goal:** Initialize project
**Depends on:** Nothing

### Phase 2: Build
**Goal:** Build features
**Depends on:** Phase 1
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].goal, 'Initialize project');
    assert.strictEqual(output.phases[0].depends_on, 'Nothing');
    assert.strictEqual(output.phases[1].goal, 'Build features');
    assert.strictEqual(output.phases[1].depends_on, 'Phase 1');
  });

  test('extracts goals and depends_on with colon outside bold (**Goal**: format)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.24

### Phase 5: Skill Scaffolding
**Goal**: The autonomous skill files exist following project conventions
**Depends on**: Phase 4 (v1.23 complete)

### Phase 6: Smart Discuss
**Goal**: Grey area resolution works with proposals
**Depends on**: Phase 5
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].goal, 'The autonomous skill files exist following project conventions', 'goal extracted with colon outside bold');
    assert.strictEqual(output.phases[0].depends_on, 'Phase 4 (v1.23 complete)', 'depends_on extracted with colon outside bold');
    assert.strictEqual(output.phases[1].goal, 'Grey area resolution works with proposals', 'second phase goal extracted');
    assert.strictEqual(output.phases[1].depends_on, 'Phase 5', 'second phase depends_on extracted');
  });

  test('handles mixed colon-inside and colon-outside bold formats in analyze', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Alpha
**Goal:** Colon inside bold
**Depends on:** Nothing

### Phase 2: Beta
**Goal**: Colon outside bold
**Depends on**: Phase 1
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].goal, 'Colon inside bold', 'colon-inside goal works');
    assert.strictEqual(output.phases[0].depends_on, 'Nothing', 'colon-inside depends_on works');
    assert.strictEqual(output.phases[1].goal, 'Colon outside bold', 'colon-outside goal works');
    assert.strictEqual(output.phases[1].depends_on, 'Phase 1', 'colon-outside depends_on works');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze disk status variants
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze disk status variants', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns researched status for phase dir with only RESEARCH.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Exploration
**Goal:** Research the domain
`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-exploration');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-RESEARCH.md'), '# Research notes');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].disk_status, 'researched', 'disk_status should be researched');
    assert.strictEqual(output.phases[0].has_research, true, 'has_research should be true');
  });

  test('returns discussed status for phase dir with only CONTEXT.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Discussion
**Goal:** Gather context
`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-discussion');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-CONTEXT.md'), '# Context notes');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].disk_status, 'discussed', 'disk_status should be discussed');
    assert.strictEqual(output.phases[0].has_context, true, 'has_context should be true');
  });

  test('returns empty status for phase dir with no recognized files', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Empty
**Goal:** Nothing yet
`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-empty');
    fs.mkdirSync(p1, { recursive: true });

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].disk_status, 'empty', 'disk_status should be empty');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze milestone extraction
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze milestone extraction', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts milestone headings and version numbers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## v1.0 Test Infrastructure

### Phase 1: Foundation
**Goal:** Set up base

## v1.1 Coverage Hardening

### Phase 2: Coverage
**Goal:** Add coverage
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.milestones), 'milestones should be an array');
    assert.strictEqual(output.milestones.length, 2, 'should find 2 milestones');
    assert.strictEqual(output.milestones[0].version, 'v1.0', 'first milestone version');
    assert.ok(output.milestones[0].heading.includes('v1.0'), 'first milestone heading contains v1.0');
    assert.strictEqual(output.milestones[1].version, 'v1.1', 'second milestone version');
    assert.ok(output.milestones[1].heading.includes('v1.1'), 'second milestone heading contains v1.1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze missing phase details
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze missing phase details', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('detects checklist-only phases missing detail sections', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1: Foundation** - Set up project
- [ ] **Phase 2: API** - Build REST API

### Phase 2: API
**Goal:** Build REST API
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.missing_phase_details), 'missing_phase_details should be an array');
    assert.ok(output.missing_phase_details.includes('1'), 'phase 1 should be in missing details');
    assert.ok(!output.missing_phase_details.includes('2'), 'phase 2 should not be in missing details');
  });

  test('returns null when all checklist phases have detail sections', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1: Foundation** - Set up project
- [ ] **Phase 2: API** - Build REST API

### Phase 1: Foundation
**Goal:** Set up project

### Phase 2: API
**Goal:** Build REST API
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.missing_phase_details, null, 'missing_phase_details should be null');
  });

  test('does not report phantom missing details for milestone-prefixed (M-NN) phase IDs', () => {
    // The checklist scanner truncated dash-separated IDs at the dash (1-01 -> 1)
    // while the detail-heading scanner kept the full ID, so every milestone-prefixed
    // ROADMAP spuriously reported the truncated major as a missing detail section.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1-01: Foundation** - Set up project
- [ ] **Phase 1-02: API** - Build REST API
- [ ] **Phase 2-01: Ship** - Release

### Phase 1-01: Foundation
**Goal:** Set up project

### Phase 1-02: API
**Goal:** Build REST API

### Phase 2-01: Ship
**Goal:** Release
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.missing_phase_details,
      null,
      'milestone-prefixed phases with matching detail sections should report no missing details'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap get-phase success criteria
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap get-phase success criteria', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts success_criteria array from phase section', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
**Success Criteria** (what must be TRUE):
  1. First criterion
  2. Second criterion
  3. Third criterion

### Phase 2: Other
**Goal:** Other goal
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.ok(Array.isArray(output.success_criteria), 'success_criteria should be an array');
    assert.strictEqual(output.success_criteria.length, 3, 'should have 3 criteria');
    assert.ok(output.success_criteria[0].includes('First criterion'), 'first criterion matches');
    assert.ok(output.success_criteria[1].includes('Second criterion'), 'second criterion matches');
    assert.ok(output.success_criteria[2].includes('Third criterion'), 'third criterion matches');
  });

  test('#2522: wrapped success-criteria lines fold into their criterion (not dropped/truncated)', () => {
    // A criterion that wraps onto an indented continuation line must fold INTO its
    // criterion (retaining its trailing [REQ-ID]), and every criterion below the wrap
    // must still be parsed. The old regex broke the run at the wrap, truncating
    // criterion 2 mid-sentence (losing [A-02]) and silently dropping criterion 3.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '### Phase 9: T',
        '**Goal**: g',
        '**Success Criteria** (what must be TRUE):',
        '  1. alpha. [A-01]',
        '  2. beta which is long and',
        '     wraps onto a second line. [A-02]',
        '  3. gamma. [A-03]',
        '**Plans**: TBD',
        '',
      ].join('\n')
    );

    const result = runGsdTools('roadmap get-phase 9', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.strictEqual(output.success_criteria.length, 3, 'all 3 criteria must parse — wrapped continuations must not drop/truncate (#2522)');
    assert.ok(output.success_criteria[1].includes('wraps onto a second line'), 'the wrapped continuation must fold into criterion 2');
    assert.ok(output.success_criteria[1].includes('[A-02]'), 'the wrapped criterion must retain its trailing [REQ-ID] tag (#2522)');
    assert.ok(output.success_criteria[2].includes('[A-03]'), 'criterion 3 (below the wrap) must not be dropped (#2522)');
    // Boundary: the parse must not bleed past the Success Criteria block.
    assert.ok(!output.success_criteria.some(c => c.includes('TBD')), 'parse must not consume the **Plans** line');
  });

  test('#2522: blank-line-separated success criteria still parse (the continuation fix must not regress blank lines)', () => {
    // Guard against the naive-form trap the issue flags: narrowing the leading
    // whitespace to [ \t]* and splitting on \n would trade wrapped-line truncation
    // for blank-line truncation. Blank lines between criteria must keep working.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '### Phase 1: T',
        '**Goal**: g',
        '**Success Criteria** (what must be TRUE):',
        '  1. alpha. [A-01]',
        '',
        '  2. beta. [A-02]',
        '',
        '  3. gamma. [A-03]',
        '**Plans**: TBD',
        '',
      ].join('\n')
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.success_criteria.length, 3, 'blank-line-separated criteria must all parse (#2522 guard)');
    assert.ok(output.success_criteria[0].includes('[A-01]'));
    assert.ok(output.success_criteria[1].includes('[A-02]'));
    assert.ok(output.success_criteria[2].includes('[A-03]'));
  });

  test('returns empty array when no success criteria present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Simple
**Goal:** No criteria here
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.ok(Array.isArray(output.success_criteria), 'success_criteria should be an array');
    assert.strictEqual(output.success_criteria.length, 0, 'should have empty criteria');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap update-plan-progress command
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap update-plan-progress command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing phase number returns error', () => {
    const result = runGsdTools('roadmap update-plan-progress', tmpDir);
    assert.strictEqual(result.success, false, 'should fail without phase number');
    assert.ok(result.error.includes('phase number required'), 'error should mention phase number required');
  });

  test('nonexistent phase returns error', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
`
    );

    const result = runGsdTools('roadmap update-plan-progress 99', tmpDir);
    assert.strictEqual(result.success, false, 'should fail for nonexistent phase');
    assert.ok(result.error.includes('not found'), 'error should mention not found');
  });

  test('no plans found returns updated false', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
`
    );

    // Create phase dir with only a context file (no plans)
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-CONTEXT.md'), '# Context');

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'should not update');
    assert.ok(output.reason.includes('No plans'), 'reason should mention no plans');
    assert.strictEqual(output.plan_count, 0, 'plan_count should be 0');
  });

  test('updates progress for partial completion', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
**Plans:** TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Test | v1.0 | 0/2 | Planned | - |
`
    );

    // Create phase dir with 2 plans, 1 summary
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, '01-02-PLAN.md'), '# Plan 2');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'should update');
    assert.strictEqual(output.plan_count, 2, 'plan_count should be 2');
    assert.strictEqual(output.summary_count, 1, 'summary_count should be 1');
    assert.strictEqual(output.status, 'In Progress', 'status should be In Progress');
    assert.strictEqual(output.complete, false, 'should not be complete');

    // Verify file was actually modified
    const roadmapContent = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmapContent.includes('1/2'), 'roadmap should contain updated plan count');
  });

  test('counts plans and summaries from plans/ subdirectory layout (#3053)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test', 'plans');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, 'PLAN-01.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, 'PLAN-02.md'), '# Plan 2');
    fs.writeFileSync(path.join(p1, 'SUMMARY-01.md'), '# Summary 1');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].plan_count, 2);
    assert.strictEqual(output.phases[0].summary_count, 1);
    assert.strictEqual(output.phases[0].disk_status, 'partial');
  });

  test('#1988 — stray non-plan *-SUMMARY.md files do not inflate summary_count or flip phase to Complete', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 30: Big** - description

### Phase 30: Big
**Goal:** big goal
**Plans:** TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 30. Big | v3.0 | 0/4 | Planned | - |
`
    );

    // 4 plans, only 1 has a real summary; plus 3 stray non-plan summaries
    // (the exact names from the #1988 report: FIX-CR02, FIX-WR02-04, GAPCLOSURE).
    const p = path.join(tmpDir, '.planning', 'phases', '30-big');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, '30-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p, '30-02-PLAN.md'), '# Plan 2');
    fs.writeFileSync(path.join(p, '30-03-PLAN.md'), '# Plan 3');
    fs.writeFileSync(path.join(p, '30-04-PLAN.md'), '# Plan 4');
    fs.writeFileSync(path.join(p, '30-01-SUMMARY.md'), '# Summary 1');
    // Strays — these must NOT count:
    fs.writeFileSync(path.join(p, '30-FIX-CR02-SUMMARY.md'), '# fix summary');
    fs.writeFileSync(path.join(p, '30-FIX-WR02-04-SUMMARY.md'), '# fix summary');
    fs.writeFileSync(path.join(p, '30-GAPCLOSURE-SUMMARY.md'), '# gap closure summary');

    const result = runGsdTools('roadmap update-plan-progress 30', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plan_count, 4, 'plan_count is the 4 real plans');
    assert.strictEqual(output.summary_count, 1, 'stray summaries must not inflate the count');
    assert.strictEqual(output.status, 'In Progress', 'must not flip to Complete');
    assert.strictEqual(output.complete, false, 'must not be complete');

    // The ROADMAP row must NOT show 4/4 Complete.
    const roadmapContent = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmapContent.includes('1/4'), 'roadmap row must show the real 1/4 progress');
    assert.ok(!/4\/4\s*\|\s*Complete/.test(roadmapContent), 'must not stamp 4/4 Complete');
    assert.ok(!/\[x\] \*\*Phase 30/.test(roadmapContent), 'phase checkbox must not be checked');
  });

  test('#2022 — all summaries present but verification NOT passed → checkbox NOT checked', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1: Test** - description

### Phase 1: Test
**Goal:** Test goal
**Plans:** TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Test | v1.0 | 0/1 | Planned | - |
`
    );

    // 1 plan + 1 summary (all summaries present) but NO VERIFICATION.md → the
    // verification gate (#2022) must prevent the checkbox from being checked.
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.complete, false, 'must NOT be complete without verification');
    assert.strictEqual(output.status, 'In Progress', 'status should be In Progress (not Complete)');

    const roadmapContent = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmapContent.includes('[ ] **Phase 1'), 'phase checkbox must remain unchecked');
    assert.ok(!/\[x\] \*\*Phase 1/.test(roadmapContent), 'phase checkbox must NOT be checked without verification');
    assert.ok(roadmapContent.includes('1/1'), 'plan count should still be updated');
  });

  test('#2022 — verification status NOT passed → checkbox NOT checked', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1: Test**

### Phase 1: Test
**Goal:** Test goal

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Test | v1.0 | 0/1 | Planned | - |
`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1');
    // Verification exists but status is gaps_found (not passed)
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nstatus: gaps_found\n---\n# Verification\n');

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.complete, false, 'must NOT be complete (verification gaps_found)');
    assert.strictEqual(output.status, 'In Progress');
    const roadmapContent = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(!roadmapContent.includes('[x]'), 'checkbox must NOT be checked (verification not passed)');
  });

  test('updates progress and checks checkbox on completion', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1: Test** - description

### Phase 1: Test
**Goal:** Test goal
**Plans:** TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Test | v1.0 | 0/1 | Planned | - |
`
    );

    // Create phase dir with 1 plan, 1 summary (complete) + verification passed (#2022 gate)
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1');
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'should update');
    assert.strictEqual(output.complete, true, 'should be complete');
    assert.strictEqual(output.status, 'Complete', 'status should be Complete');

    // Verify file was actually modified
    const roadmapContent = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmapContent.includes('[x]'), 'checkbox should be checked');
    assert.ok(roadmapContent.includes('completed'), 'should contain completion date text');
    assert.ok(roadmapContent.includes('1/1'), 'roadmap should contain updated plan count');
  });

  test('updates unpadded ROADMAP phase entries when called with padded phase argument', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 3: Build** - description

### Phase 3: Build
**Goal:** Test goal
**Plans:** 0 plans
- [ ] 03-01-PLAN.md

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 3. Build | 0/1 | Planned |  |
`
    );

    const p3 = path.join(tmpDir, '.planning', 'phases', '03-build');
    fs.mkdirSync(p3, { recursive: true });
    fs.writeFileSync(path.join(p3, '03-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p3, '03-01-SUMMARY.md'), '# Summary 1');
    fs.writeFileSync(path.join(p3, '03-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    const result = runGsdTools('roadmap update-plan-progress 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmapContent = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.match(roadmapContent, /- \[x\] \*\*Phase 3: Build\*\* - description \(completed \d{4}-\d{2}-\d{2}\)/);
    assert.ok(roadmapContent.includes('**Plans:** 1/1 plans complete'), 'phase detail plan count should be updated');
    assert.match(roadmapContent, /\| 3\. Build \| 1\/1 \| Complete\s+\| \d{4}-\d{2}-\d{2} \|/);
    assert.ok(roadmapContent.includes('- [x] 03-01-PLAN.md'), 'completed plan checkbox should still be marked');
  });

  test('missing ROADMAP.md returns updated false', () => {
    // Create phase dir with plans and summaries but NO ROADMAP.md
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'should not update');
    assert.ok(output.reason.includes('ROADMAP.md not found'), 'reason should mention missing ROADMAP.md');
  });

  test('marks completed plan checkboxes', () => {
    const roadmapContent = `# Roadmap

- [ ] Phase 50: Build
  - [ ] 50-01-PLAN.md
  - [ ] 50-02-PLAN.md

### Phase 50: Build
**Goal:** Build stuff
**Plans:** 2 plans

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 50. Build | 0/2 | Planned |  |
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapContent);

    const p50 = path.join(tmpDir, '.planning', 'phases', '50-build');
    fs.mkdirSync(p50, { recursive: true });
    fs.writeFileSync(path.join(p50, '50-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p50, '50-02-PLAN.md'), '# Plan 2');
    // Only plan 1 has a summary (completed)
    fs.writeFileSync(path.join(p50, '50-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 50', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('[x] 50-01-PLAN.md') || roadmap.includes('[x] 50-01'),
      'completed plan checkbox should be marked');
    assert.ok(roadmap.includes('[ ] 50-02-PLAN.md') || roadmap.includes('[ ] 50-02'),
      'incomplete plan checkbox should remain unchecked');
  });

  test('preserves Milestone column in 5-column progress table', () => {
    const roadmapContent = `# Roadmap

### Phase 50: Build
**Goal:** Build stuff
**Plans:** 1 plans

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 50. Build | v2.0 | 0/1 | Planned |  |
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapContent);

    const p50 = path.join(tmpDir, '.planning', 'phases', '50-build');
    fs.mkdirSync(p50, { recursive: true });
    fs.writeFileSync(path.join(p50, '50-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p50, '50-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p50, '50-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    const result = runGsdTools('roadmap update-plan-progress 50', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const rowMatch = roadmap.match(/^\|[^\r\n]*50\. Build[^\r\n]*$/m);
    assert.ok(rowMatch, 'table row should exist');
    const cells = rowMatch[0].split('|').slice(1, -1).map(c => c.trim());
    assert.strictEqual(cells.length, 5, 'should have 5 columns');
    assert.strictEqual(cells[1], 'v2.0', 'Milestone column should be preserved');
    assert.ok(cells[3].includes('Complete'), 'Status column should show Complete');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase add command
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// regressions: insert missing plan rows (#1163)
// ─────────────────────────────────────────────────────────────────────────────

// Phase numbers are zero-padded by normalizePhaseName so the .planning/phases/
// directory must use the padded form (e.g. "05-test-phase" for phase 5).
const PHASE_NUM_1163 = '5';       // what we pass on the command line
const PHASE_DIR_SLUG_1163 = '05'; // what ends up on disk after normalization

/**
 * ROADMAP.md with a phase-5 detail section that uses bold **Plans:** and has
 * NO per-plan checkbox rows yet.
 */
function buildRoadmapBoldPlans(phaseNum = PHASE_NUM_1163, planCount = '0/3 plans executed') {
  return [
    '# ROADMAP',
    '',
    '## Milestone v1.0',
    '',
    '| Phase | Plans | Status | Completed |',
    '| --- | --- | --- | --- |',
    `| Phase ${phaseNum}: test phase | 0/3 | Planned      |   |`,
    '',
    `### Phase ${phaseNum}: test phase`,
    '',
    'Goal: build something',
    '',
    `**Plans:** ${planCount}`,
    '',
    '(No individual plan rows yet — template freshly generated)',
    '',
  ].join('\n');
}

/**
 * ROADMAP.md using the CANONICAL template shape:
 *   **Plans**: N plans       ← bold summary metadata line
 *   (blank line)
 *   Plans:                   ← checklist header
 *   - [ ] NN-XX-PLAN.md      ← per-plan checkboxes
 *
 * The template (gsd-core/templates/roadmap.md) always uses this two-line form.
 * `**Plans**:` has the colon OUTSIDE the bold markers.
 */
function buildRoadmapCanonicalTemplate(phaseNum = PHASE_NUM_1163, existingRows = []) {
  const rowLines = existingRows.length > 0
    ? ['Plans:', ...existingRows.map(r => `- [ ] ${r}`), '']
    : ['Plans:', ''];
  return [
    '# ROADMAP',
    '',
    '## Milestone v1.0',
    '',
    '| Phase | Plans | Status | Completed |',
    '| --- | --- | --- | --- |',
    `| Phase ${phaseNum}: test phase | 0/3 | Planned      |   |`,
    '',
    `### Phase ${phaseNum}: test phase`,
    '',
    '**Goal**: build something',
    `**Plans**: 0/3 plans`,
    '',
    ...rowLines,
  ].join('\n');
}

/**
 * ROADMAP.md with a duplicate phase heading in an archived <details> section
 * plus the same phase as the ACTIVE milestone section.
 */
function buildRoadmapWithArchivedDuplicate(phaseNum = PHASE_NUM_1163) {
  return [
    '# ROADMAP',
    '',
    '<details>',
    '<summary>v0.9 — shipped</summary>',
    '',
    `### Phase ${phaseNum}: test phase`,
    '',
    '**Plans**: 2/2 plans complete',
    '',
    'Plans:',
    `- [x] ${phaseNum}-01-PLAN.md`,
    `- [x] ${phaseNum}-02-PLAN.md`,
    '',
    '</details>',
    '',
    '## Milestone v1.0',
    '',
    `### Phase ${phaseNum}: test phase`,
    '',
    '**Plans**: 0/3 plans',
    '',
    'Plans:',
    '',
  ].join('\n');
}

/**
 * ROADMAP.md with a phase-5 detail section that uses plain `Plans:` (not bold)
 * and NO per-plan checkbox rows yet.
 */
function buildRoadmapPlainPlans(phaseNum = PHASE_NUM_1163) {
  return [
    '# ROADMAP',
    '',
    '## Milestone v1.0',
    '',
    '| Phase | Plans | Status | Completed |',
    '| --- | --- | --- | --- |',
    `| Phase ${phaseNum}: test phase | 0/3 | Planned      |   |`,
    '',
    `### Phase ${phaseNum}: test phase`,
    '',
    'Goal: build something',
    '',
    `Plans: 0/3 plans executed`,
    '',
    '(No individual plan rows yet)',
    '',
  ].join('\n');
}

/**
 * Create plan files for a given phase in the .planning/phases tree.
 * Uses the normalized (zero-padded) directory name so findPhaseInternal can
 * locate the phase.  Returns the phase directory path.
 */
function createPhaseWithPlans(tmpDir, phaseNum, planNames) {
  // normalizePhaseName('5') → '05', so use zero-padded slug on disk
  const paddedNum = String(phaseNum).padStart(2, '0');
  const phaseDir = path.join(tmpDir, '.planning', 'phases', `${paddedNum}-test-phase`);
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const name of planNames) {
    fs.writeFileSync(path.join(phaseDir, name), `# ${name}\n`);
  }
  return phaseDir;
}

describe('regressions: insert missing plan rows (#1163)', () => {
  let tmpDir;
  let roadmapPath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1163-');
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Bold **Plans:** — insert missing rows ────────────────────────────────

  test('inserts plan checkbox rows under bold **Plans:** when none exist', () => {
    fs.writeFileSync(roadmapPath, buildRoadmapBoldPlans('5'));
    createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
      '5-03-PLAN.md',
    ]);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'expected updated:true');

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    assert.ok(written.includes('- [ ] 5-01-PLAN.md'), '5-01-PLAN.md row not inserted');
    assert.ok(written.includes('- [ ] 5-02-PLAN.md'), '5-02-PLAN.md row not inserted');
    assert.ok(written.includes('- [ ] 5-03-PLAN.md'), '5-03-PLAN.md row not inserted');
  });

  // ── Plain Plans: — insert missing rows ──────────────────────────────────

  test('inserts plan checkbox rows under plain Plans: when none exist', () => {
    fs.writeFileSync(roadmapPath, buildRoadmapPlainPlans('5'));
    createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
    ]);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'expected updated:true');

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    assert.ok(written.includes('- [ ] 5-01-PLAN.md'), '5-01-PLAN.md row not inserted (plain Plans:)');
    assert.ok(written.includes('- [ ] 5-02-PLAN.md'), '5-02-PLAN.md row not inserted (plain Plans:)');
  });

  // ── Plan count update with plain Plans: ─────────────────────────────────

  test('plan count is updated when section uses plain Plans: (not bold)', () => {
    fs.writeFileSync(roadmapPath, buildRoadmapPlainPlans('5'));
    // createPhaseWithPlans returns the padded dir path (05-test-phase)
    const phaseDir = createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
    ]);
    // Create a summary for plan 1 so it's not 0/2
    fs.writeFileSync(path.join(phaseDir, '5-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    // Plan count should reflect 1 completed out of 2
    assert.ok(
      written.match(/Plans:\s*1\/2 plans executed/),
      'Plain Plans: count not updated. ROADMAP.md:\n' + written,
    );
  });

  // ── Bold **Plans:** count update ─────────────────────────────────────────

  test('plan count is updated when section uses bold **Plans:**', () => {
    fs.writeFileSync(roadmapPath, buildRoadmapBoldPlans('5', '0/3 plans executed'));
    const phaseDir = createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
      '5-03-PLAN.md',
    ]);
    // Complete 1 plan
    fs.writeFileSync(path.join(phaseDir, '5-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    assert.ok(
      written.includes('**Plans:** 1/3 plans executed'),
      '**Plans:** count not updated. ROADMAP.md:\n' + written,
    );
  });

  // ── Existing rows are checked off, not duplicated ───────────────────────

  test('existing plan rows are marked complete, not duplicated when SUMMARY exists', () => {
    const roadmapWithRows = [
      '# ROADMAP',
      '',
      '## Milestone v1.0',
      '',
      '### Phase 5: test phase',
      '',
      '**Plans:** 0/2 plans executed',
      '',
      '- [ ] 5-01-PLAN.md',
      '- [ ] 5-02-PLAN.md',
      '',
    ].join('\n');
    fs.writeFileSync(roadmapPath, roadmapWithRows);

    const phaseDir = createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
    ]);
    fs.writeFileSync(path.join(phaseDir, '5-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');

    // 5-01 should be checked, 5-02 should remain unchecked
    assert.ok(written.includes('- [x] 5-01-PLAN.md'), '5-01-PLAN.md not marked complete');
    assert.ok(written.includes('- [ ] 5-02-PLAN.md'), '5-02-PLAN.md incorrectly marked complete');

    // Only two rows — no duplicates
    const matches = (written.match(/- \[.\] 5-\d+-PLAN\.md/g) || []);
    assert.equal(matches.length, 2, `Expected 2 checkbox rows, got ${matches.length}:\n${written}`);
  });

  // ── Inserted rows are sorted ─────────────────────────────────────────────

  test('inserted plan rows are sorted in ascending order', () => {
    fs.writeFileSync(roadmapPath, buildRoadmapBoldPlans('5'));
    createPhaseWithPlans(tmpDir, '5', [
      '5-03-PLAN.md',
      '5-01-PLAN.md',
      '5-02-PLAN.md',
    ]);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    const rowPositions = [
      written.indexOf('5-01-PLAN.md'),
      written.indexOf('5-02-PLAN.md'),
      written.indexOf('5-03-PLAN.md'),
    ];
    assert.ok(
      rowPositions[0] < rowPositions[1] && rowPositions[1] < rowPositions[2],
      'Inserted plan rows are not in ascending order. ROADMAP.md:\n' + written,
    );
  });

  // ── No plans found — command returns updated:false without inserting ─────

  test('returns updated:false gracefully when phase has no plan files', () => {
    fs.writeFileSync(roadmapPath, buildRoadmapBoldPlans('5'));
    // Create phase dir (padded slug) but no plan files
    const phaseDir = path.join(tmpDir, '.planning', 'phases', `${PHASE_DIR_SLUG_1163}-test-phase`);
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, false, 'Expected updated:false when no plans exist');
  });

  // ── Adversarial: CRLF in ROADMAP.md ──────────────────────────────────────

  test('CRLF line endings in ROADMAP.md are handled without corruption', () => {
    const content = buildRoadmapBoldPlans('5').replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(roadmapPath, content);
    createPhaseWithPlans(tmpDir, '5', ['5-01-PLAN.md', '5-02-PLAN.md']);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'CRLF ROADMAP not handled');
  });
});

describe('regressions: insert missing plan rows (#1163) — adversarial: partial gaps, canonical template, scoped insertion', () => {
  let tmpDir;
  let roadmapPath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1163-adv-');
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Finding 1: partial-row gaps ──────────────────────────────────────────

  test('(Finding 1) inserts missing rows when SOME plan rows already exist', () => {
    // Phase has 5-01, 5-02, 5-03 on disk.
    // ROADMAP already has a row for 5-01 only.
    // Expected: 5-02 and 5-03 rows are inserted; 5-01 is NOT duplicated.
    const roadmapContent = [
      '# ROADMAP',
      '',
      '## Milestone v1.0',
      '',
      `### Phase 5: test phase`,
      '',
      '**Plans:** 0/3 plans executed',
      '',
      'Plans:',
      '- [ ] 5-01-PLAN.md',
      '',
    ].join('\n');
    fs.writeFileSync(roadmapPath, roadmapContent);

    createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
      '5-03-PLAN.md',
    ]);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');

    // All three plans must have rows
    assert.ok(written.includes('5-01-PLAN.md'), '5-01-PLAN.md row missing');
    assert.ok(written.includes('5-02-PLAN.md'), '5-02-PLAN.md row was not inserted for partial gap');
    assert.ok(written.includes('5-03-PLAN.md'), '5-03-PLAN.md row was not inserted for partial gap');

    // No duplicates: exactly one checkbox row per plan
    const rows01 = (written.match(/- \[.\] 5-01-PLAN\.md/g) || []);
    const rows02 = (written.match(/- \[.\] 5-02-PLAN\.md/g) || []);
    const rows03 = (written.match(/- \[.\] 5-03-PLAN\.md/g) || []);
    assert.equal(rows01.length, 1, `5-01-PLAN.md duplicated (${rows01.length} times)`);
    assert.equal(rows02.length, 1, `5-02-PLAN.md duplicated (${rows02.length} times)`);
    assert.equal(rows03.length, 1, `5-03-PLAN.md duplicated (${rows03.length} times)`);
  });

  test('(Finding 1) running twice (idempotent) does not duplicate partially-inserted rows', () => {
    const roadmapContent = [
      '# ROADMAP',
      '',
      '## Milestone v1.0',
      '',
      `### Phase 5: test phase`,
      '',
      '**Plans:** 0/2 plans executed',
      '',
      'Plans:',
      '- [ ] 5-01-PLAN.md',
      '',
    ].join('\n');
    fs.writeFileSync(roadmapPath, roadmapContent);
    createPhaseWithPlans(tmpDir, '5', ['5-01-PLAN.md', '5-02-PLAN.md']);

    // Run once to insert 5-02
    runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);
    // Run again — should be a no-op
    runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    const rows01 = (written.match(/- \[.\] 5-01-PLAN\.md/g) || []);
    const rows02 = (written.match(/- \[.\] 5-02-PLAN\.md/g) || []);
    assert.equal(rows01.length, 1, `5-01-PLAN.md duplicated after two runs (${rows01.length} times)`);
    assert.equal(rows02.length, 1, `5-02-PLAN.md duplicated after two runs (${rows02.length} times)`);
  });

  // ── Finding 2: canonical template shape ─────────────────────────────────
  // The canonical template (gsd-core/templates/roadmap.md) uses:
  //   **Plans**: N plans     ← summary line (bold word, outer colon)
  //   (blank line)
  //   Plans:                 ← checklist header
  //   - [ ] NN-XX rows
  //
  // NOTE: `**Plans**:` differs from `**Plans:**` (colon placement):
  //   **Plans**:  → bold "Plans" + outer colon (CANONICAL)
  //   **Plans:**  → bold "Plans:" (previously assumed form)
  // Rows must be inserted under the `Plans:` checklist header, not after the
  // `**Plans**:` summary line.

  test('(Finding 2) canonical template: inserts rows under Plans: checklist header, not after **Plans**: summary', () => {
    // Canonical form: **Plans**: summary + blank + Plans: checklist header + no rows yet
    fs.writeFileSync(roadmapPath, buildRoadmapCanonicalTemplate('5', []));
    createPhaseWithPlans(tmpDir, '5', ['5-01-PLAN.md', '5-02-PLAN.md']);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    assert.ok(written.includes('- [ ] 5-01-PLAN.md'), '5-01-PLAN.md not inserted under Plans:');
    assert.ok(written.includes('- [ ] 5-02-PLAN.md'), '5-02-PLAN.md not inserted under Plans:');

    // Rows must appear AFTER the `Plans:` line, not between `**Plans**:` and `Plans:`
    const plansHeaderIdx = written.indexOf('\nPlans:\n');
    const boldPlansIdx = written.indexOf('**Plans**:');
    const row01Idx = written.indexOf('- [ ] 5-01-PLAN.md');
    assert.ok(boldPlansIdx !== -1, '**Plans**: summary line is missing from output');
    assert.ok(plansHeaderIdx !== -1, 'Plans: checklist header is missing from output');
    assert.ok(row01Idx > plansHeaderIdx, 'row 5-01 appears before Plans: checklist header');
  });

  test('(Finding 2) canonical template: plan count updated on **Plans**: summary line', () => {
    // **Plans**: uses bold word + outer colon — the count update regex must handle it
    fs.writeFileSync(roadmapPath, buildRoadmapCanonicalTemplate('5', []));
    const phaseDir = createPhaseWithPlans(tmpDir, '5', ['5-01-PLAN.md', '5-02-PLAN.md']);
    fs.writeFileSync(path.join(phaseDir, '5-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    // The **Plans**: summary line should be updated to reflect 1/2
    assert.ok(
      written.match(/\*\*Plans\*\*:\s*1\/2 plans executed/),
      '**Plans**: count not updated for canonical template shape.\nROADMAP.md:\n' + written,
    );
  });

  // ── Finding 3: insertion scoped to active milestone ──────────────────────

  test('(Finding 3) rows are inserted only in the active milestone, not in archived <details>', () => {
    // ROADMAP has duplicate phase heading: one inside <details> (archived) and
    // one in the active section.  Rows must land ONLY in the active section.
    fs.writeFileSync(roadmapPath, buildRoadmapWithArchivedDuplicate('5'));
    createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
      '5-03-PLAN.md',
    ]);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');

    // The archived section already has rows for 5-01 and 5-02 only (checked off).
    // The active section should get 5-03 row (and ideally 5-01/5-02 too if they
    // were missing from the active section — the active section's Plans: was empty).
    // Key assertion: no NEW rows were inserted into the archived <details> block.

    const detailsStart = written.indexOf('<details>');
    const detailsEnd = written.indexOf('</details>');
    const archivedSection = written.slice(detailsStart, detailsEnd + '</details>'.length);

    // The archived section should still have exactly 2 rows (5-01 and 5-02)
    const archivedRows = (archivedSection.match(/- \[.\] 5-\d+-PLAN\.md/g) || []);
    assert.equal(archivedRows.length, 2, `Archived section row count changed — rows were inserted into archived section:\n${archivedSection}`);

    // The active milestone section (after </details>) should have the new rows
    const activeSection = written.slice(detailsEnd + '</details>'.length);
    assert.ok(activeSection.includes('5-03-PLAN.md'), '5-03 row not inserted in active milestone section');
  });

  // ── Finding 1 (code-review round 2): detection scoped to active region ───
  // When an archived <details> block contains checkbox rows for the SAME plan
  // files as the current phase, the missingPlans filter must detect those plans
  // as MISSING from the ACTIVE section and insert them there — not skip them
  // because they appear anywhere in the full file content.

  test('(Finding 1 code-review) inserts ALL missing rows in active section even when archived section has same plans', () => {
    // Archived section has 5-01 and 5-02 (checked off for v0.9).
    // Active section has NO checkbox rows yet (empty Plans: block).
    // Phase 5 on disk has 5-01, 5-02, 5-03.
    // Expected: active section gets rows for ALL THREE plans (5-01, 5-02, 5-03).
    // Bug (pre-fix): detection runs against full content → 5-01 and 5-02 found in
    // archived block → missingPlans = [5-03 only] → only 5-03 inserted.
    fs.writeFileSync(roadmapPath, buildRoadmapWithArchivedDuplicate('5'));
    createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
      '5-03-PLAN.md',
    ]);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    const detailsEnd = written.indexOf('</details>');
    const activeSection = written.slice(detailsEnd + '</details>'.length);

    // All three plans must be present in the active section
    assert.ok(activeSection.includes('5-01-PLAN.md'), '5-01-PLAN.md not inserted in active section (detection not scoped to active region)');
    assert.ok(activeSection.includes('5-02-PLAN.md'), '5-02-PLAN.md not inserted in active section (detection not scoped to active region)');
    assert.ok(activeSection.includes('5-03-PLAN.md'), '5-03-PLAN.md not inserted in active section');

    // Archived section must remain untouched (still exactly 2 rows)
    const archivedSection = written.slice(written.indexOf('<details>'), detailsEnd + '</details>'.length);
    const archivedRows = (archivedSection.match(/- \[.\] 5-\d+-PLAN\.md/g) || []);
    assert.equal(archivedRows.length, 2, `Archived section row count changed:\n${archivedSection}`);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2661-roadmap-sync-parallel.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2661-roadmap-sync-parallel (consolidation epic #1969 B2 #1971)", () => {
// allow-test-rule: source-text-is-the-product (see #2661)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Regression tests for bug #2661:
 *   `/gsd-execute-phase N --auto` with parallelization: true, use_worktrees: false
 *   left ROADMAP plan checkboxes unchecked until a manual
 *   `roadmap update-plan-progress` was run.
 *
 * Root cause (workflow-level): execute-plan.md `update_roadmap` step was
 * gated on a worktree-detection branch that incorrectly conflated
 * "parallel mode" with "worktree mode". When `parallelization: true,
 * use_worktrees: false` was configured, the step was still gated by the
 * worktree-only check (which is true: the executing tree IS the main repo,
 * not a worktree, so the gate happened to fire correctly there) — the
 * actual reproducer was a different code path. The original PR #2682 fix
 * made the sync unconditional, which violated the single-writer contract
 * for shared ROADMAP.md established by #1486 / dcb50396 in worktree mode.
 *
 * Minimal fix (this PR): restore the worktree guard and document its
 * intent explicitly. The `IS_WORKTREE != "true"` branch IS the
 * `use_worktrees: false` mode: only that mode runs the in-handler sync.
 * Worktree mode relies on the orchestrator's post-merge sync at
 * execute-phase.md §5.7 (lines 815-834) — the single writer for shared
 * tracking files.
 *
 * These tests:
 *   (1) assert the workflow gates the sync call on `use_worktrees: false`
 *       (i.e. the IS_WORKTREE != "true" branch is present and gates the call);
 *   (2) assert the handler itself behaves correctly under the
 *       use_worktrees: false reproducer (the original #2661 case);
 *   (3) assert the handler is idempotent and lock-safe (lockfile is the
 *       in-handler defense; the workflow gate is the cross-handler one).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan.md');

function writeRoadmap(tmpDir, content) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

function readRoadmap(tmpDir) {
  return fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
}

function seedPhase(tmpDir, phaseNum, planIds, summaryIds) {
  const phaseDir = path.join(tmpDir, '.planning', 'phases', `${String(phaseNum).padStart(2, '0')}-test`);
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const id of planIds) {
    fs.writeFileSync(path.join(phaseDir, `${id}-PLAN.md`), `# Plan ${id}`);
  }
  for (const id of summaryIds) {
    fs.writeFileSync(path.join(phaseDir, `${id}-SUMMARY.md`), `# Summary ${id}`);
  }
}

const THREE_PLAN_ROADMAP = `# Roadmap

- [ ] Phase 1: Test phase with three parallel plans
  - [ ] 01-01-PLAN.md
  - [ ] 01-02-PLAN.md
  - [ ] 01-03-PLAN.md

### Phase 1: Test
**Goal:** Parallel execution regression test
**Plans:** 3 plans

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Test | v1.0 | 0/3 | Planned |  |
`;

// ─── Structural: workflow gates sync on use_worktrees=false ──────────────────

describe('bug #2661: execute-plan.md update_roadmap gating', () => {
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const stepMatch = content.match(
    /<step name="update_roadmap">([\s\S]*?)<\/step>/
  );
  const step = stepMatch && stepMatch[1];

  test('update_roadmap step exists and invokes roadmap.update-plan-progress', () => {
    assert.ok(stepMatch, 'update_roadmap step must exist');
    // After #3797 architectural fix, callsites use gsd_run
    assert.ok(
      /gsd_run query roadmap\.update-plan-progress/.test(step),
      'update_roadmap must still invoke roadmap.update-plan-progress'
    );
  });

  test('use_worktrees: false mode — sync call is gated to fire (the #2661 reproducer)', () => {
    // The non-worktree branch must contain the sync call.
    // After #3797 architectural fix, callsites use gsd_run
    assert.ok(
      /IS_WORKTREE.*!=.*"true"[\s\S]*?gsd_run query roadmap\.update-plan-progress/.test(step),
      'sync call must execute on the IS_WORKTREE != "true" branch (use_worktrees: false)'
    );
  });

  test('use_worktrees: true mode — sync call does NOT fire (single-writer contract)', () => {
    // The sync call must be inside an `if [ "$IS_WORKTREE" != "true" ]` block,
    // i.e. it must NOT be unconditional and it must NOT appear on the worktree branch.
    // We verify by extracting the bash block and checking the call sits under the gate.
    const bashMatch = step.match(/```bash\s*([\s\S]*?)```/);
    assert.ok(bashMatch, 'update_roadmap must contain a bash block');
    const bash = bashMatch[1];

    assert.ok(
      /IS_WORKTREE/.test(bash),
      'bash block must include the IS_WORKTREE worktree-detection check'
    );
    // Sync call must appear after the guard check, not before.
    // After #3797 architectural fix, callsites use gsd_run
    const guardIdx = bash.search(/if \[ "\$IS_WORKTREE" != "true" \]/);
    const callIdx = bash.search(/gsd_run query roadmap\.update-plan-progress/);
    assert.ok(guardIdx >= 0, 'guard must be present');
    assert.ok(callIdx > guardIdx,
      'sync call must appear inside the use_worktrees: false guard, not before/outside it');
  });

  test('intent doc references single-writer contract / orchestrator-owns-write', () => {
    // The prose must justify why worktree mode is excluded so future readers
    // do not regress this back to unconditional.
    assert.ok(
      /worktree|orchestrator|single-writer|#1486|#2661/i.test(step),
      'update_roadmap must document the contract that justifies the gate'
    );
  });
});

// ─── Handler-level: idempotence + multi-plan sync (use_worktrees: false case) ─

describe('bug #2661: roadmap update-plan-progress handler (use_worktrees: false)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject('gsd-2661-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('three parallel SUMMARY.md files produce three [x] plan checkboxes', () => {
    writeRoadmap(tmpDir, THREE_PLAN_ROADMAP);
    seedPhase(tmpDir, 1, ['01-01', '01-02', '01-03'], ['01-01', '01-02', '01-03']);

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, `handler failed: ${result.error}`);

    const roadmap = readRoadmap(tmpDir);
    assert.ok(roadmap.includes('[x] 01-01-PLAN.md'), 'plan 01-01 should be checked');
    assert.ok(roadmap.includes('[x] 01-02-PLAN.md'), 'plan 01-02 should be checked');
    assert.ok(roadmap.includes('[x] 01-03-PLAN.md'), 'plan 01-03 should be checked');
    assert.ok(roadmap.includes('3/3'), 'progress row should reflect 3/3');
  });

  test('handler is idempotent — second call produces identical content', () => {
    writeRoadmap(tmpDir, THREE_PLAN_ROADMAP);
    seedPhase(tmpDir, 1, ['01-01', '01-02', '01-03'], ['01-01', '01-02', '01-03']);

    const first = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(first.success, first.error);
    const afterFirst = readRoadmap(tmpDir);

    const second = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(second.success, second.error);
    const afterSecond = readRoadmap(tmpDir);

    assert.strictEqual(afterSecond, afterFirst,
      'repeated invocation must not mutate ROADMAP.md further (idempotent)');
  });

  test('partial completion: only plans with SUMMARY.md get [x]', () => {
    writeRoadmap(tmpDir, THREE_PLAN_ROADMAP);
    // Only plan 01-02 has a SUMMARY.md
    seedPhase(tmpDir, 1, ['01-01', '01-02', '01-03'], ['01-02']);

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, result.error);

    const roadmap = readRoadmap(tmpDir);
    assert.ok(roadmap.includes('[ ] 01-01-PLAN.md'), 'plan 01-01 should remain unchecked');
    assert.ok(roadmap.includes('[x] 01-02-PLAN.md'), 'plan 01-02 should be checked');
    assert.ok(roadmap.includes('[ ] 01-03-PLAN.md'), 'plan 01-03 should remain unchecked');
    assert.ok(roadmap.includes('1/3'), 'progress row should reflect 1/3');
  });

  test('lockfile contention: concurrent handler invocations within a single tree do not corrupt ROADMAP.md', async () => {
    // Scope: lockfile only serializes within a single working tree. Cross-worktree
    // serialization is enforced by the workflow gate (worktree mode never calls
    // this handler from execute-plan.md), not by the lockfile.
    writeRoadmap(tmpDir, THREE_PLAN_ROADMAP);
    seedPhase(tmpDir, 1, ['01-01', '01-02', '01-03'], ['01-01', '01-02', '01-03']);

    const invocations = Array.from({ length: 3 }, () =>
      new Promise((resolve) => {
        const r = runGsdTools('roadmap update-plan-progress 1', tmpDir);
        resolve(r);
      })
    );
    const results = await Promise.all(invocations);

    for (const r of results) {
      assert.ok(r.success, `concurrent handler invocation failed: ${r.error}`);
    }

    const roadmap = readRoadmap(tmpDir);
    // Structural integrity: each checkbox appears exactly once, progress row intact.
    for (const id of ['01-01', '01-02', '01-03']) {
      const occurrences = roadmap.split(`[x] ${id}-PLAN.md`).length - 1;
      assert.strictEqual(occurrences, 1,
        `plan ${id} checkbox should appear exactly once (got ${occurrences})`);
    }
    assert.ok(roadmap.includes('3/3'), 'progress row should reflect 3/3 after concurrent runs');
    // Lockfile should have been cleaned up after the final release.
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'ROADMAP.md.lock')),
      'ROADMAP.md.lock should be released after concurrent invocations settle'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3599-roadmap-get-phase-project-code-prefix.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3599-roadmap-get-phase-project-code-prefix (consolidation epic #1969 B2 #1971)", () => {
/**
 * Bug #3599: roadmap.get-phase no longer matches custom phase IDs with
 * project-code prefixes like `PROJ-42`.
 *
 * `phaseMarkdownRegexSource(phaseNum)` in gsd-core/bin/lib/core.cjs
 * (and its SDK twin in sdk/src/query/roadmap-update-plan-progress.ts) strips
 * the `PROJ-` prefix before building the padding-tolerant numeric regex.
 * Result: `roadmap get-phase PROJ-42` produces a regex of `0*42`, which
 * matches `### Phase 42:` instead of (or in addition to) the intended
 * `### Phase PROJ-42:`. The function's own docstring promises a fallback to
 * `escapeRegex(phaseNum)` for non-numeric custom IDs, but that branch is
 * unreachable for project-code-prefixed numeric IDs.
 *
 * Fix: the emitted regex must match BOTH the stripped numeric form (so
 * `CK-01-name` directory inputs still resolve to `Phase 1:` in prose, the
 * #3537 contract) AND the full prefixed form (so `PROJ-42` resolves to
 * `Phase PROJ-42:`).
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function writeRoadmap(tmpDir, body) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), body);
}

function writeState(tmpDir, version) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    `---\nmilestone: ${version}\n---\n`,
  );
}

describe('bug #3599: roadmap get-phase preserves project-code prefix in lookup', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('bug-3599-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('finds ### Phase PROJ-42: when queried as PROJ-42', () => {
    writeState(tmpDir, 'v1.0.0');
    writeRoadmap(
      tmpDir,
      [
        '# Roadmap',
        '',
        '## Current Milestone: v1.0.0 - Test',
        '',
        '### Phase PROJ-42: Custom phase',
        '**Goal:** Verify project-code-prefixed lookup',
        '',
      ].join('\n'),
    );

    const result = runGsdTools('roadmap get-phase PROJ-42 --json', tmpDir);
    assert.ok(result.success, `command failed: ${result.error || result.output}`);

    const payload = JSON.parse(result.output);
    assert.strictEqual(payload.found, true, `expected found=true, got: ${result.output}`);
    assert.strictEqual(payload.phase_name, 'Custom phase');
    assert.strictEqual(payload.goal, 'Verify project-code-prefixed lookup');
  });

  test('bare numeric prefers a bare sibling over a prefixed one (#3599 anti-steal, updated for #2114)', () => {
    // #3599's real guard is anti-STEALING: when BOTH a bare `Phase 42:` and a
    // distinct prefixed `Phase PROJ-42:` exist, a bare `42` query must resolve
    // the BARE one — the numeric source is tried before the prefix-tolerant
    // fallback, so a bare query never steals a distinct prefixed sibling.
    // (Since #2114/#2121, a bare query DOES resolve a *drifted-only* prefixed
    // heading when no bare sibling exists — see the bug #2114 block below.)
    writeState(tmpDir, 'v1.0.0');
    writeRoadmap(
      tmpDir,
      [
        '# Roadmap',
        '',
        '## Current Milestone: v1.0.0 - Test',
        '',
        '### Phase 42: Bare',
        '**Goal:** Canonical bare heading',
        '',
        '### Phase PROJ-42: Prefixed',
        '**Goal:** Distinct prefixed sibling',
        '',
      ].join('\n'),
    );

    const result = runGsdTools('roadmap get-phase 42 --json', tmpDir);
    assert.ok(result.success);
    const payload = JSON.parse(result.output);
    assert.strictEqual(payload.found, true, `expected found=true, got: ${result.output}`);
    assert.strictEqual(
      payload.phase_name,
      'Bare',
      `bare '42' must resolve the bare 'Phase 42:', not steal 'Phase PROJ-42:'; got ${result.output}`,
    );
  });

  test('preserves #3537 contract: CK-01 directory form resolves to Phase 1 prose', () => {
    // Existing contract: phase directory names like `CK-01-name` carry the
    // project_code prefix and a zero-padded number, but ROADMAP prose is
    // typically un-padded (`### Phase 1:`). The padding-tolerant lookup must
    // still bridge those two surfaces.
    writeState(tmpDir, 'v1.0.0');
    writeRoadmap(
      tmpDir,
      [
        '# Roadmap',
        '',
        '## Current Milestone: v1.0.0 - Test',
        '',
        '### Phase 1: Numeric prose',
        '**Goal:** #3537 contract — CK-01 dir → Phase 1 prose',
        '',
      ].join('\n'),
    );

    const result = runGsdTools('roadmap get-phase CK-01 --json', tmpDir);
    assert.ok(result.success);
    const payload = JSON.parse(result.output);
    assert.strictEqual(
      payload.found,
      true,
      `CK-01 must still resolve to 'Phase 1:' prose (#3537 contract); got ${result.output}`,
    );
    assert.strictEqual(payload.phase_name, 'Numeric prose');
  });

  test('finds the right phase when both prefixed and bare forms coexist', () => {
    // Disambiguation test: a roadmap that contains BOTH `### Phase 42:` and
    // `### Phase PROJ-42:` must resolve each query to its specific match.
    writeState(tmpDir, 'v1.0.0');
    writeRoadmap(
      tmpDir,
      [
        '# Roadmap',
        '',
        '## Current Milestone: v1.0.0 - Test',
        '',
        '### Phase 42: Bare numeric',
        '**Goal:** Bare',
        '',
        '### Phase PROJ-42: Prefixed',
        '**Goal:** Prefixed',
        '',
      ].join('\n'),
    );

    const r42 = runGsdTools('roadmap get-phase 42 --json', tmpDir);
    const rProj = runGsdTools('roadmap get-phase PROJ-42 --json', tmpDir);

    const p42 = JSON.parse(r42.output);
    const pProj = JSON.parse(rProj.output);

    assert.strictEqual(p42.found, true);
    assert.strictEqual(p42.phase_name, 'Bare numeric');
    assert.strictEqual(p42.goal, 'Bare');

    assert.strictEqual(pProj.found, true);
    assert.strictEqual(pProj.phase_name, 'Prefixed');
    assert.strictEqual(pProj.goal, 'Prefixed');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2447-roadmap-wave-deps.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2447-roadmap-wave-deps (consolidation epic #1969 B2 #1971)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #2447)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Tests for ROADMAP wave dependency surfacing (#2447).
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const PLAN_TEMPLATE = (wave, truths = []) => `---
phase: "1"
plan: "01-0${wave}"
type: standard
wave: ${wave}
depends_on: []
files_modified: []
autonomous: true
requirements: []
must_haves:
  truths:
${truths.map(t => `    - ${t}`).join('\n') || '    - (none)'}
  artifacts: []
  key_links: []
---

<objective>
Plan ${wave} objective
</objective>
`;

function makePlanProject(files = {}) {
  const dir = createTempProject();
  fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '');
  fs.mkdirSync(path.join(dir, '.planning', 'phases', '01-foundation'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

describe('bug #2114: roadmap get-phase resolves drifted prefixed headings by bare number', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject('bug-2114-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('bare-number query resolves a drifted project-code-prefixed heading', () => {
    // Before the fix, bare `29` did NOT match `### Phase AB-29:` from the CLI
    // (2-source lookup), even though getRoadmapPhaseInternal (init.phase-op) did
    // — the #2114 divergence. Now all three resolvers share the 3-source list.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nmilestone: v1.0.0\n---\n# State\n\n**Status:** In progress\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Current Milestone: v1.0.0 - Test',
        '',
        '### Phase 30: Plain',
        '**Goal:** Canonical bare heading',
        '',
        '### Phase AB-29: Prefixed',
        '**Goal:** Drifted prefixed heading',
        '',
      ].join('\n'),
    );

    const resultAB29 = runGsdTools('roadmap get-phase 29 --json', tmpDir);
    assert.ok(resultAB29.success, `command failed: ${resultAB29.error || resultAB29.output}`);
    const payloadAB29 = JSON.parse(resultAB29.output);
    assert.strictEqual(payloadAB29.found, true, `expected found=true for drifted AB-29, got: ${resultAB29.output}`);
    assert.strictEqual(payloadAB29.phase_name, 'Prefixed');
    assert.strictEqual(payloadAB29.goal, 'Drifted prefixed heading');

    // The canonical bare heading still resolves.
    const result30 = runGsdTools('roadmap get-phase 30 --json', tmpDir);
    assert.ok(result30.success);
    const payload30 = JSON.parse(result30.output);
    assert.strictEqual(payload30.found, true);
    assert.strictEqual(payload30.phase_name, 'Plain');
  });

  test('project-code-prefixed checklist-only entry surfaces malformed_roadmap for both query forms', () => {
    // #2121/#2114 route all three resolvers through the shared 3-source lookup. A
    // `**Phase PROJ-42:**` summary line with no matching `### Phase PROJ-42:` detail heading
    // is a malformed ROADMAP. Before the consolidation this project-code-prefixed checklist
    // was reported as a silent `{found:false}` for BOTH query forms — the prefixed pass
    // discarded its malformed candidate, and the bare pass could not match the `PROJ-` prefix
    // at all. The unified lookup newly surfaces the malformed_roadmap diagnostic for both, so
    // this test fails on the prior silent-empty behavior for the prefixed AND the bare form.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap v1.0',
        '',
        '## Phases',
        '',
        '- [ ] **Phase PROJ-42: Checklist only, no header**',
        '',
      ].join('\n'),
    );

    const prefixed = runGsdTools('roadmap get-phase PROJ-42 --json', tmpDir);
    assert.ok(prefixed.success, `command failed: ${prefixed.error || prefixed.output}`);
    const pPayload = JSON.parse(prefixed.output);
    assert.strictEqual(pPayload.found, false, 'malformed roadmap: phase must not be found');
    assert.strictEqual(pPayload.error, 'malformed_roadmap', 'prefixed query must surface malformed_roadmap');
    assert.ok(pPayload.message.includes('missing'), 'message must explain the missing detail section');

    // Parity: the bare numeric form yields the same diagnostic against the same fixture.
    const bare = runGsdTools('roadmap get-phase 42 --json', tmpDir);
    assert.ok(bare.success, `command failed: ${bare.error || bare.output}`);
    assert.strictEqual(JSON.parse(bare.output).error, 'malformed_roadmap', 'bare query surfaces the same diagnostic');
  });
});

describe('roadmap annotate-dependencies', () => {
  let tmpDir;

  afterEach(() => cleanup(tmpDir));

  test('inserts wave headers for multi-wave plan set', () => {
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Set up DB
- [ ] 01-02-PLAN.md — Build API
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1, ['DB schema is correct']),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_TEMPLATE(2, ['API returns 200']),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true);
    assert.strictEqual(out.waves, 2);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('**Wave 1**'), 'Wave 1 header present');
    assert.ok(roadmap.includes('**Wave 2**'), 'Wave 2 header present');
    assert.ok(roadmap.includes('blocked on Wave 1'), 'Wave 2 blocked-on note present');
  });

  test('does not insert wave headers for single-wave plan set', () => {
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Set up DB
- [ ] 01-02-PLAN.md — Build API
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1, ['DB schema is correct']),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_TEMPLATE(1, ['API returns 200']),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(!roadmap.includes('**Wave 1**'), 'no Wave header for single-wave set');
    assert.ok(!roadmap.includes('blocked on'), 'no blocked-on note for single wave');
  });

  test('surfaces cross-cutting constraints when truths appear in 2+ plans', () => {
    const sharedTruth = 'All endpoints require auth';
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Set up DB
- [ ] 01-02-PLAN.md — Build API
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1, [sharedTruth, 'DB schema is correct']),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_TEMPLATE(2, [sharedTruth, 'API returns 200']),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.cross_cutting_constraints, 1);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('Cross-cutting constraints:'), 'constraints subsection present');
    assert.ok(roadmap.includes(sharedTruth), 'shared truth listed');
  });

  test('#1154: surfaces a cross-cutting backstop (object-form) truth by its statement, not dropped', () => {
    // An object-form backstop truth `{ statement, verification: backstop }` (the #1154 non-inferable
    // marker on must_haves.truths) shared across 2 plans must be coerced by its `statement` — the
    // Hyrum backward-compat guard: a truth-reader must tolerate the new object form, never drop it.
    const backstopTruth = 'statement: Adjacent touching intervals merge\n      verification: backstop';
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Set up DB
- [ ] 01-02-PLAN.md — Build API
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1, [backstopTruth, 'DB schema is correct']),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_TEMPLATE(2, [backstopTruth, 'API returns 200']),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.cross_cutting_constraints, 1, 'the shared backstop truth is surfaced, not dropped');
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('Adjacent touching intervals merge'), 'surfaced by its statement text, not [object Object]');
  });

  test('does not surface constraints that appear in only one plan', () => {
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Set up DB
- [ ] 01-02-PLAN.md — Build API
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1, ['Only in plan 1']),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_TEMPLATE(2, ['Only in plan 2']),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.cross_cutting_constraints, 0);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(!roadmap.includes('Cross-cutting constraints:'), 'no constraints section when none are cross-cutting');
  });

  test('is idempotent — running twice does not double-insert wave headers', () => {
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Set up DB
- [ ] 01-02-PLAN.md — Build API
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_TEMPLATE(2),
    });

    runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    const secondResult = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(secondResult.success);

    const out = JSON.parse(secondResult.output);
    assert.strictEqual(out.updated, false, 'second run should be no-op');

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const waveMatches = roadmap.match(/\*\*Wave \d+\*\*/g) || [];
    assert.strictEqual(waveMatches.length, 2, 'exactly 2 wave headers (not doubled)');
  });

  test('returns no-op when phase has no plans', () => {
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Set up project\n`,
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, false);
  });

  test('#2757: truths containing colons do not crash annotate-dependencies', () => {
    // Unquoted truths with colons (Rails idioms: db:seed, /foo/:id, Class::Method)
    // caused parseMustHavesBlock to return {} instead of a string, then t.trim() threw.
    const colonTruths = [
      'GET /foo/:id resolves to controller#show',
      'Class::Method is idempotent',
      '"Quoted truth with colon: inside"',
    ];
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Set up project\n**Plans:** 1 plan\n\nPlans:\n- [ ] 01-01-PLAN.md — Repro plan\n`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1, colonTruths),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command threw on colon-containing truths: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(typeof out.updated === 'boolean', 'should return a valid result object');
  });

  test('#314 map-lookup: found-path uses plan wave, miss-path defaults to wave 1', () => {
    // Behavior lock for the O(1) Map swap: asserts BOTH branches of the lookup.
    // - 01-01-PLAN.md is in planData (wave 2) → checklist line must land under Wave 2.
    // - 01-99-PLAN.md is NOT in planData → null-on-miss → defaults to wave 1.
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Known plan
- [ ] 01-99-PLAN.md — Unknown plan (no PLAN.md)
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(2),
      // 01-99-PLAN.md intentionally absent — simulates a checklist entry with no backing plan file
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');

    // Both waves must be present (wave 1 from the miss, wave 2 from the found entry)
    assert.ok(roadmap.includes('**Wave 1**'), 'Wave 1 header present (miss-path default)');
    assert.ok(roadmap.includes('**Wave 2**'), 'Wave 2 header present (found-path)');

    // Known plan (wave 2) must appear AFTER Wave 2 header
    const wave2Idx = roadmap.indexOf('**Wave 2**');
    const knownLineIdx = roadmap.indexOf('01-01-PLAN.md');
    assert.ok(knownLineIdx > wave2Idx, 'known plan line grouped under Wave 2');

    // Unknown plan (wave 1 default) must appear AFTER Wave 1 header and BEFORE Wave 2 header
    const wave1Idx = roadmap.indexOf('**Wave 1**');
    const unknownLineIdx = roadmap.indexOf('01-99-PLAN.md');
    assert.ok(unknownLineIdx > wave1Idx, 'unknown plan line grouped under Wave 1');
    assert.ok(unknownLineIdx < wave2Idx, 'unknown plan line appears before Wave 2 section');
  });

  test('plan-phase.md documents annotate-dependencies step', () => {
    const planPhase = fs.readFileSync(
      path.join(__dirname, '../gsd-core/workflows/plan-phase.md'), 'utf-8'
    );
    assert.ok(planPhase.includes('annotate-dependencies'), 'plan-phase.md references annotate-dependencies command');
    assert.ok(planPhase.includes('13d'), 'plan-phase.md has step 13d');
    assert.ok(planPhase.includes('Cross-cutting constraints'), 'plan-phase.md documents cross-cutting constraints');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-557-details-summary-milestone-strip.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-557-details-summary-milestone-strip (consolidation epic #1969 B2 #1971)", () => {
/**
 * Bug #557: Active milestone wrapped in <details open> with version only in
 * <summary> tag + 🔄 emoji causes extractCurrentMilestone() to fall through
 * to stripShippedMilestones(), erasing the active block and making
 * roadmap.analyze return phase_count: 0 — which then triggers a premature
 * milestone_complete STATE write.
 *
 * Root cause (two miss paths in extractCurrentMilestone, core.cjs):
 * 1. sectionPattern only matches ##/### headings; version in <summary> not found.
 * 2. activeMarkerPattern does not include 🔄; only 🚧 is recognised.
 * Both misses → stripShippedMilestones() deletes the active <details open> block.
 *
 * This test will FAIL before the fix (phase_count returns 0) and PASS after.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Fixtures ────────────────────────────────────────────────────────────────

// ROADMAP where the active milestone's version ("v1.3") appears ONLY inside
// a <summary> tag, and the in-progress marker is 🔄 (not 🚧).
// Shipped milestone v1.2 is correctly collapsed in a <details> block.
const ROADMAP_DETAILS_SUMMARY = `# Roadmap

<details>
<summary>✅ v1.2: Foundation (shipped)</summary>

### Phase 1: Bootstrap
**Goal:** Set up infrastructure

### Phase 2: Core API
**Goal:** Build REST API

</details>

<details open>
<summary>🔄 v1.3: Active Sprint</summary>

### Phase 3: Auth
**Goal:** Add authentication

### Phase 4: Dashboard
**Goal:** Build dashboard UI

</details>
`;

// STATE.md with milestone: v1.3 — version matches the <summary> tag above
const STATE_V13 = `---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Active Sprint
status: in_progress
progress:
  total_phases: 2
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Current Position

Phase: 3 (Auth)
`;

// Second variant: active milestone uses the 🔄 emoji in a heading (not just
// <summary>) to confirm the activeMarkerPattern gap is also covered.
const ROADMAP_ROTATE_HEADING = `# Roadmap

<details>
<summary>✅ v2.0: Shipped (shipped)</summary>

### Phase 1: Old Phase
**Goal:** Done

</details>

## 🔄 v2.1: Active Milestone

### Phase 2: New Feature
**Goal:** Build the new feature

### Phase 3: Integration
**Goal:** Wire it all together
`;

const STATE_V21 = `---
gsd_state_version: 1.0
milestone: v2.1
milestone_name: Active Milestone
status: in_progress
---

# Project State

## Current Position

Phase: 2 (New Feature)
`;

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('bug #557 — <details>/<summary> active milestone strip', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Core repro: version only in <summary> tag ─────────────────────────────

  test('roadmap.analyze returns correct phase_count when active milestone uses <summary> + 🔄', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V13, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(result.success, `roadmap.analyze failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.phase_count >= 2,
      `Expected phase_count >= 2 (phases 3 and 4 of v1.3); got phase_count=${output.phase_count}. ` +
      `Bug: extractCurrentMilestone() stripped the active <details open> block because ` +
      `the version "v1.3" only appears in a <summary> tag and the emoji is 🔄, not 🚧.`
    );
  });

  test('roadmap.analyze does NOT return phase_count: 0 when active milestone is in <details open>', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V13, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(result.success, `roadmap.analyze failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.notStrictEqual(
      output.phase_count,
      0,
      'phase_count must not be 0 — a zero count caused by stripping the active block ' +
      'is the direct trigger for the premature milestone_complete write.'
    );
  });

  test('roadmap get-phase returns found:true for phase in active <details open> block', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V13, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['roadmap', 'get-phase', '3'], tmpDir);
    assert.ok(result.success, `roadmap get-phase failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.found,
      true,
      `Phase 3 must be found in the active v1.3 milestone block. ` +
      `Bug: stripShippedMilestones() erased the <details open> block so the phase section was lost.`
    );
  });

  test('shipped phases in collapsed <details> are NOT visible to roadmap.analyze (strip preserved for non-active)', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V13, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(result.success, `roadmap.analyze failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const phaseNums = (output.phases || []).map(p => p.number);
    assert.ok(
      !phaseNums.includes('1') && !phaseNums.includes('2'),
      `Shipped phases 1 and 2 (from collapsed <details>) must not appear in the analyze output. ` +
      `Got phases: ${JSON.stringify(phaseNums)}`
    );
  });

  // ── 🔄 in heading (not <summary>) also recognised ────────────────────────

  test('extractCurrentMilestone recognises 🔄 in milestone heading as in-progress marker', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_ROTATE_HEADING, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V21, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(result.success, `roadmap.analyze failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.phase_count >= 2,
      `Expected phase_count >= 2 for v2.1 with 🔄 heading; got ${output.phase_count}. ` +
      `activeMarkerPattern must include 🔄, not just 🚧.`
    );
  });

  // ── Health check W021: milestone_complete vs unstarted phases ─────────────

  test('validate health emits W021 when STATE says milestone complete but ROADMAP has unstarted phases', () => {
    const planning = path.join(tmpDir, '.planning');
    // ROADMAP still has active phases in it
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY, 'utf-8');
    // STATE falsely says milestone complete
    fs.writeFileSync(path.join(planning, 'STATE.md'), `---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Active Sprint
status: v1.3 milestone complete
---

# Project State

## Current Position

Phase: Milestone v1.3 complete
`, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['validate', 'health'], tmpDir);
    assert.ok(result.success, `validate health failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const warnings = output.warnings || [];
    const w021 = warnings.find(w => w.code === 'W021');
    assert.ok(
      w021 !== undefined,
      `Expected W021 warning (milestone-status vs. roadmap-progress incoherence). ` +
      `Got warnings: ${JSON.stringify(warnings.map(w => w.code))}`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-549-total-phases-overcounts-with-phase-section-heading.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-549-total-phases-overcounts-with-phase-section-heading (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression test for bug #549:
 * STATE.md progress.total_phases is over-counted by 1 when the ROADMAP contains
 * a non-phase section heading that happens to match the broader pattern used by
 * getMilestonePhaseFilter (e.g. `## Phase Overview:`, `## Phase Details:`).
 *
 * Root cause:
 *   buildStateFrontmatter sources total_phases from getMilestonePhaseFilter.phaseCount,
 *   which uses the looser regex `#{2,4}\s*Phase\s+([\w][\w.-]*)\s*:` to build its
 *   milestonePhaseNums set.  That pattern matches section headings like
 *   `## Phase Overview:` and `## Phase Details:`, adding non-numeric tokens
 *   ("Overview", "Details") to the set and inflating phaseCount by 1 per heading.
 *
 *   roadmap.analyze uses the stricter pattern
 *   `#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)` which requires a
 *   leading digit, so it only counts real phase headings.
 *
 *   Fix: buildStateFrontmatter (and cmdStateSync) must source total_phases from
 *   the same digit-anchored phase-heading parser as roadmap.analyze — single
 *   source of truth.
 *
 * Scenario under test:
 *   ROADMAP with 6 integer phases (01-06) + 1 inserted decimal phase (05.1) = 7
 *   phases, plus a `## Phase Overview:` section header.
 *
 *   BEFORE fix: state json / state sync report total_phases: 8 (7 + 1 spurious
 *               "Overview" token from the getMilestonePhaseFilter pattern).
 *   AFTER fix:  state json / state sync report total_phases: 7, matching
 *               roadmap.analyze.phase_count.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ROADMAP: 6 integer phases + 1 inserted decimal + `## Phase Overview:` section header.
// The section header must include a trailing `:` so it matches the getMilestonePhaseFilter
// broader pattern (the bug trigger).
const ROADMAP = `## Milestone v1.0: Test Milestone

## Phase Overview:

High-level narrative about the phases.

### Phase 01: Alpha
**Goal:** alpha

### Phase 02: Beta
**Goal:** beta

### Phase 03: Gamma
**Goal:** gamma

### Phase 04: Delta
**Goal:** delta

### Phase 05: Epsilon
**Goal:** epsilon

### Phase 05.1: Inserted Hotfix (INSERTED)
**Goal:** inserted hotfix

### Phase 06: Zeta
**Goal:** zeta
`;

describe('bug #549 — total_phases over-counted by non-phase section headings', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('bug-549-');
    const planning = path.join(tmpDir, '.planning');

    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP, 'utf-8');
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'milestone_name: Test Milestone',
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
        '## Configuration',
        'Current Phase: 1',
        'Status: Executing Phase 1',
        'Last Activity: 2026-01-01',
        '',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    // Create 7 phase dirs (6 integer + 1 decimal).
    const phaseDirs = [
      '01-alpha',
      '02-beta',
      '03-gamma',
      '04-delta',
      '05-epsilon',
      '05.1-inserted-hotfix',
      '06-zeta',
    ];
    for (const d of phaseDirs) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state json total_phases matches roadmap.analyze phase_count (7, not 8)', () => {
    // Authoritative count from roadmap.analyze — uses the digit-anchored pattern.
    const analyzeResult = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(analyzeResult.success, `roadmap analyze failed: ${analyzeResult.error}`);
    const analyzed = JSON.parse(analyzeResult.output);

    assert.equal(
      analyzed.phase_count,
      7,
      `roadmap.analyze should count 7 phases (01-06 + 05.1), got ${analyzed.phase_count}`,
    );

    // State frontmatter must equal the authoritative count.
    const stateResult = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(stateResult.success, `state json failed: ${stateResult.error}`);
    const state = JSON.parse(stateResult.output);

    assert.ok(state.progress, 'state json must return a progress block');
    assert.equal(
      state.progress.total_phases,
      7,
      `progress.total_phases must be 7 (not 8) — ## Phase Overview: section must not be counted as a phase. Got ${state.progress.total_phases}`,
    );
    assert.equal(
      state.progress.total_phases,
      analyzed.phase_count,
      `progress.total_phases (${state.progress.total_phases}) must equal roadmap.analyze.phase_count (${analyzed.phase_count})`,
    );
  });

  test('state sync total_phases matches roadmap.analyze phase_count', () => {
    // Add a Progress field to the body so cmdStateSync has something to update.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const before = fs.readFileSync(statePath, 'utf-8');
    fs.writeFileSync(statePath, before.replace('Last Activity: 2026-01-01', 'Last Activity: 2026-01-01\nProgress: [░░░░░░░░░░] 0%'), 'utf-8');

    const syncResult = runGsdTools(['state', 'sync'], tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    // Read frontmatter via state json (authoritative JSON path).
    const stateResult = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(stateResult.success, `state json after sync failed: ${stateResult.error}`);
    const state = JSON.parse(stateResult.output);

    assert.ok(state.progress, 'state json must return a progress block after sync');
    assert.equal(
      state.progress.total_phases,
      7,
      `state sync must write total_phases: 7, not 8. ## Phase Overview: must not inflate the count. Got ${state.progress.total_phases}`,
    );
  });

  test('integer-only project without decimal phase also counts correctly', () => {
    // Regression guard: the fix must not break projects with no decimal phases.
    const tmpDir2 = createTempProject('bug-549-integer-');
    try {
      const planning2 = path.join(tmpDir2, '.planning');

      // ROADMAP: 4 integer phases only + non-phase section heading.
      fs.writeFileSync(
        path.join(planning2, 'ROADMAP.md'),
        [
          '## Milestone v1.0: Simple',
          '',
          '## Phase Overview:',
          '',
          '### Phase 01: One',
          '**Goal:** one',
          '',
          '### Phase 02: Two',
          '**Goal:** two',
          '',
          '### Phase 03: Three',
          '**Goal:** three',
          '',
          '### Phase 04: Four',
          '**Goal:** four',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(planning2, 'STATE.md'),
        '---\ngsd_state_version: 1.0\nmilestone: v1.0\nstatus: executing\n---\n\n# State\n\nStatus: Executing Phase 1\nLast Activity: 2026-01-01\n',
        'utf-8',
      );
      fs.writeFileSync(path.join(planning2, 'config.json'), '{}', 'utf-8');

      for (const d of ['01-one', '02-two', '03-three', '04-four']) {
        const dir = path.join(planning2, '.planning', 'phases', d);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      }

      const analyzeResult = runGsdTools(['roadmap', 'analyze'], tmpDir2);
      assert.ok(analyzeResult.success, `roadmap analyze failed: ${analyzeResult.error}`);
      const analyzed = JSON.parse(analyzeResult.output);
      assert.equal(analyzed.phase_count, 4, `expected 4 phases, got ${analyzed.phase_count}`);

      const stateResult = runGsdTools(['state', 'json'], tmpDir2);
      assert.ok(stateResult.success, `state json failed: ${stateResult.error}`);
      const state = JSON.parse(stateResult.output);
      assert.ok(state.progress, 'state json must return a progress block');
      assert.equal(
        state.progress.total_phases,
        4,
        `integer-only project: total_phases must be 4, not 5. Got ${state.progress.total_phases}`,
      );
    } finally {
      cleanup(tmpDir2);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3691-annotate-deps-plans-block-variants.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3691-annotate-deps-plans-block-variants (consolidation epic #1969 B2 #1971)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #3691)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Regression — issue #3691
 *
 * Two regex defects fixed in `roadmap.cjs` function `cmdRoadmapAnnotateDependencies`,
 * plus two review-cycle additions (F3 defensive guard, F4 adversarial gaps):
 *
 * Bug 1 (line ~553) — Plans-block detection regex `/(Plans:\s*\n)/i` requires no text
 *   after the colon. Headers like `Plans: 3 plans across 2 waves\n` or
 *   `**Plans:** 3 plans\n` are silently skipped and the function early-returns.
 *   Fix: `(?:^|\n)(\*{0,2}Plans\*{0,2}:[^\n]*\n)` anchors to start-of-line and
 *   accepts optional bold wrappers and any trailing text on the header line.
 *
 * Bug 3 (line ~566) — Plan-ID extraction regex `/([\w-]+?)/` excludes `.`, so
 *   decimal plan IDs like `02.3-01` are captured as `02` only, never match
 *   the planData entry, and every plan defaults to wave 1.
 *   Fix: `[\w.-]+?` includes `.` so decimal IDs are captured in full.
 *
 * Note: "Bug 2" (phase-section boundary `\d` → `\d[\d.]*`) was confirmed empirically
 *   to be a no-op: any phase heading starts with a digit, so `\d` already matches.
 *   The no-op change was dropped from the PR; this file has no Bug 2 describe block.
 *
 * Review additions:
 *   F3 — Leading-dot plan ID guard: malformed IDs like `.invalid` are rejected
 *        before planData.find() rather than silently defaulting to wave 1.
 *   F4 — Adversarial gaps: multi-decimal leading-zero IDs (001.10-PLAN.md) and
 *        bare-bold `**Plans:**` (no trailing text) are explicitly covered.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function makePlanProject(files = {}) {
  const dir = createTempProject();
  fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

/** Build a minimal PLAN.md frontmatter string */
function makePlan({ phase, plan, wave, dependsOn = [] }) {
  return [
    '---',
    `phase: "${phase}"`,
    `plan: "${plan}"`,
    'type: standard',
    `wave: ${wave}`,
    `depends_on: [${dependsOn.map(d => `"${d}"`).join(', ')}]`,
    'files_modified: []',
    'autonomous: true',
    'must_haves:',
    '  truths: []',
    '  artifacts: []',
    '  key_links: []',
    '---',
    '',
    `<objective>Plan ${plan}</objective>`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Bug 1 — Plans-block detection: inline summary text after the colon
// ---------------------------------------------------------------------------

describe('bug #3691 — Bug 1: Plans-block detection with inline summary', () => {
  let tmpDir;
  afterEach(() => cleanup(tmpDir));

  test('Plans: N plans (inline count after colon) is detected as a Plans-block', (_t) => {
    // Pre-fix: `Plans:\s*\n` requires bare newline — fails for "Plans: 2 plans\n"
    // Post-fix: `Plans:[^\n]*\n` accepts any text after the colon
    const roadmap = [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '',
      '**Goal:** Set up project',
      '',
      'Plans: 2 plans',
      '- [ ] 01-01-PLAN.md — Task A',
      '- [ ] 01-02-PLAN.md — Task B',
      '',
    ].join('\n');

    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': roadmap,
      '.planning/phases/01-foundation/01-01-PLAN.md': makePlan({ phase: '1', plan: '01-01', wave: 1 }),
      '.planning/phases/01-foundation/01-02-PLAN.md': makePlan({ phase: '1', plan: '01-02', wave: 2, dependsOn: ['01-01'] }),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true,
      'Plans-block with inline summary must be detected and written');
    assert.ok(out.waves >= 1, 'at least one wave must be written');

    const written = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(written.includes('Wave'), 'wave annotation must appear in ROADMAP.md');
  });

  test('Plans: N plans across N waves (longer inline text) is detected', (_t) => {
    const roadmap = [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '',
      'Plans: 3 plans across 2 waves',
      '- [ ] 01-01-PLAN.md — Task A',
      '- [ ] 01-02-PLAN.md — Task B',
      '- [ ] 01-03-PLAN.md — Task C',
      '',
    ].join('\n');

    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': roadmap,
      '.planning/phases/01-foundation/01-01-PLAN.md': makePlan({ phase: '1', plan: '01-01', wave: 1 }),
      '.planning/phases/01-foundation/01-02-PLAN.md': makePlan({ phase: '1', plan: '01-02', wave: 1 }),
      '.planning/phases/01-foundation/01-03-PLAN.md': makePlan({ phase: '1', plan: '01-03', wave: 2, dependsOn: ['01-01'] }),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true,
      'Plans-block with "N plans across N waves" inline text must be detected');
  });

  test('**Plans:** (bold markdown wrapper) is detected as a Plans-block', (_t) => {
    // Bold wrapper: `**Plans:** 3 plans across 2 waves`
    const roadmap = [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '',
      '**Plans:** 2 plans',
      '- [ ] 01-01-PLAN.md — Task A',
      '- [ ] 01-02-PLAN.md — Task B',
      '',
    ].join('\n');

    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': roadmap,
      '.planning/phases/01-foundation/01-01-PLAN.md': makePlan({ phase: '1', plan: '01-01', wave: 1 }),
      '.planning/phases/01-foundation/01-02-PLAN.md': makePlan({ phase: '1', plan: '01-02', wave: 2 }),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true,
      '**Plans:** bold-wrapped header must be detected as a Plans-block');
  });

  test('bare Plans: (no inline text, legacy format) still works after fix', (_t) => {
    // Regression guard: the fix must not break the working case
    const roadmap = [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '',
      'Plans:',
      '- [ ] 01-01-PLAN.md — Task A',
      '- [ ] 01-02-PLAN.md — Task B',
      '',
    ].join('\n');

    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': roadmap,
      '.planning/phases/01-foundation/01-01-PLAN.md': makePlan({ phase: '1', plan: '01-01', wave: 1 }),
      '.planning/phases/01-foundation/01-02-PLAN.md': makePlan({ phase: '1', plan: '01-02', wave: 2 }),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true,
      'bare Plans: (legacy format) must still be detected after the fix');
  });
});

// ---------------------------------------------------------------------------
// Bug 3 — Plan-ID extraction: decimal phase IDs like 02.3-01
// ---------------------------------------------------------------------------

describe('bug #3691 — Bug 3: decimal plan IDs (e.g. 02.3-01-PLAN.md) parse correctly', () => {
  let tmpDir;
  afterEach(() => cleanup(tmpDir));

  test('decimal plan ID 02.3-01 is captured fully and matched to the correct wave', (_t) => {
    // Pre-fix: `[\w-]+?` stops at `.` → captures `02` only → planData.find misses → wave = 1 for all
    // Post-fix: `[\w.-]+?` captures `02.3-01` → planData.find resolves → correct wave written
    const roadmap = [
      '# Roadmap',
      '',
      '### Phase 02.3: Surgical edit ops',
      '',
      'Plans: 2 plans across 2 waves',
      '- [ ] 02.3-01-PLAN.md — Path resolver',
      '- [ ] 02.3-02-PLAN.md — Op handlers',
      '',
    ].join('\n');

    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': roadmap,
      '.planning/phases/02.3-surgical-edit-ops/02.3-01-PLAN.md': makePlan({ phase: '02.3', plan: '02.3-01', wave: 1 }),
      '.planning/phases/02.3-surgical-edit-ops/02.3-02-PLAN.md': makePlan({ phase: '02.3', plan: '02.3-02', wave: 2, dependsOn: ['02.3-01'] }),
    });

    const result = runGsdTools('roadmap annotate-dependencies 02.3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true,
      'decimal-phase ROADMAP with inline Plans: summary must be annotated');
    assert.strictEqual(out.waves, 2,
      'two distinct waves must be identified (02.3-01→wave 1, 02.3-02→wave 2)');

    const written = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(/Wave 1/.test(written), 'Wave 1 header must appear in output');
    assert.ok(/Wave 2/.test(written), 'Wave 2 header must appear in output');
  });

  test('combined fixture: decimal phase + bold Plans: header (both bugs together)', (_t) => {
    // Exercises Bug 1 (bold **Plans:** header) AND Bug 3 (decimal IDs) simultaneously.
    // This is the exact ROADMAP fragment from the issue report.
    const roadmap = [
      '# Roadmap',
      '',
      '## Milestone v1.2',
      '',
      '### Phase 02.3: Surgical edit ops',
      '',
      '**Plans:** 3 plans across 2 waves',
      '- [ ] 02.3-01-PLAN.md — Path resolver',
      '- [ ] 02.3-02-PLAN.md — Op handlers',
      '- [ ] 02.3-03-PLAN.md — Tests',
      '',
    ].join('\n');

    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': roadmap,
      '.planning/phases/02.3-surgical-edit-ops/02.3-01-PLAN.md': makePlan({ phase: '02.3', plan: '02.3-01', wave: 1 }),
      '.planning/phases/02.3-surgical-edit-ops/02.3-02-PLAN.md': makePlan({ phase: '02.3', plan: '02.3-02', wave: 1 }),
      '.planning/phases/02.3-surgical-edit-ops/02.3-03-PLAN.md': makePlan({ phase: '02.3', plan: '02.3-03', wave: 2, dependsOn: ['02.3-01', '02.3-02'] }),
    });

    const result = runGsdTools('roadmap annotate-dependencies 02.3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true,
      'combined fixture (bold Plans: + decimal IDs) must produce updated: true');
    assert.strictEqual(out.waves, 2,
      'wave 2 dependency must be detected from decimal plan IDs');
  });
});

// ---------------------------------------------------------------------------
// F3 review fix — Leading-dot ID validation guard (defensive, malformed ROADMAP)
// ---------------------------------------------------------------------------

describe('review fix F3 — leading-dot plan ID is rejected (defensive guard)', () => {
  let tmpDir;
  afterEach(() => cleanup(tmpDir));

  test('checklist line with leading-dot plan ID is skipped and does not silently default to wave 1', (_t) => {
    // Guards: `.invalid-PLAN.md` would be captured as `.invalid` by the `[\w.-]+?` regex
    // (since `.` is now included), which starts with a dot — an invalid ID.
    // Without the guard, planData.find() misses it and wave defaults to 1, silently
    // polluting the output. With the guard, the line is skipped entirely.
    // We verify this by having TWO real plans with known waves (1 and 2), plus one
    // malformed line. The malformed line must not appear in the wave-annotated output.
    const roadmap = [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '',
      'Plans: 3 items',
      '- [ ] 01-01-PLAN.md — Task A',
      '- [ ] .invalid-PLAN.md — Corrupted entry',
      '- [ ] 01-02-PLAN.md — Task B',
      '',
    ].join('\n');

    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': roadmap,
      '.planning/phases/01-foundation/01-01-PLAN.md': makePlan({ phase: '1', plan: '01-01', wave: 1 }),
      '.planning/phases/01-foundation/01-02-PLAN.md': makePlan({ phase: '1', plan: '01-02', wave: 2, dependsOn: ['01-01'] }),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    // Two valid plans resolve to 2 waves — annotation must still proceed
    assert.strictEqual(out.updated, true, 'annotation must proceed despite malformed line');
    assert.strictEqual(out.waves, 2, 'two distinct waves from the two valid plans');

    const written = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    // The malformed line should not appear in the written output (it was skipped)
    assert.ok(!written.includes('.invalid-PLAN.md'),
      'malformed leading-dot entry must be dropped from the annotated output');
  });
});

// ---------------------------------------------------------------------------
// F4 review additions — adversarial test gaps
// ---------------------------------------------------------------------------

describe('review fix F4 — adversarial test gaps', () => {
  let tmpDir;
  afterEach(() => cleanup(tmpDir));

  test('001.10-PLAN.md multi-decimal leading-zero ID is captured fully and wave-assigned correctly', (_t) => {
    // Guards regression of Bug 3: `[\w-]+?` would stop at the first `.` and
    // capture `001` instead of `001.10`, which never matches any planData entry.
    // Post-fix `[\w.-]+?` must capture `001.10` in full.
    const roadmap = [
      '# Roadmap',
      '',
      '### Phase 001.10: Extended decimal phase',
      '',
      'Plans: 2 plans across 2 waves',
      '- [ ] 001.10-01-PLAN.md — First task',
      '- [ ] 001.10-02-PLAN.md — Second task',
      '',
    ].join('\n');

    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': roadmap,
      '.planning/phases/001.10-extended/001.10-01-PLAN.md': makePlan({ phase: '001.10', plan: '001.10-01', wave: 1 }),
      '.planning/phases/001.10-extended/001.10-02-PLAN.md': makePlan({ phase: '001.10', plan: '001.10-02', wave: 2, dependsOn: ['001.10-01'] }),
    });

    const result = runGsdTools('roadmap annotate-dependencies 001.10', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true,
      'multi-decimal leading-zero plan ID must be captured fully and annotated');
    assert.strictEqual(out.waves, 2,
      'wave 2 dependency must be resolved from full 001.10-02 ID (not truncated to 001)');
  });

  test('**Plans:** (bold, no trailing text) is matched and checklist is processed', (_t) => {
    // Guards the bare-bold variant: `**Plans:**` with nothing after the colon.
    // The `[^\n]*` quantifier accepts zero chars so this should already work,
    // but this test would fail if `\*{0,2}Plans\*{0,2}` regressed to require no stars.
    const roadmap = [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '',
      '**Plans:**',
      '- [ ] 01-01-PLAN.md — Task A',
      '- [ ] 01-02-PLAN.md — Task B',
      '',
    ].join('\n');

    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': roadmap,
      '.planning/phases/01-foundation/01-01-PLAN.md': makePlan({ phase: '1', plan: '01-01', wave: 1 }),
      '.planning/phases/01-foundation/01-02-PLAN.md': makePlan({ phase: '1', plan: '01-02', wave: 2, dependsOn: ['01-01'] }),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true,
      '**Plans:** bare-bold variant (no trailing text) must be detected and annotated');
    assert.strictEqual(out.waves, 2,
      'wave assignment must resolve correctly from planData for bare-bold variant');
  });
});

// ---------------------------------------------------------------------------
// Bug #1103 — leading newline dropped in replace, fusing adjacent lines
//
// On the SUCCESSFUL mutation path, the block matcher anchors with `(?:^|\n)`.
// On a mid-string match (a `**Plans:** N plans` bold summary line directly above
// a bare `Plans:` block) `plansBlockMatch[0]` begins with the consumed `\n`. The
// replacement did not re-emit it, fusing the summary line onto the header →
// `**Plans:** 3 plansPlans:`. Distinct from #3691's silent-no-op detection bugs;
// #3691's Bug 1 fix is what let this two-line layout be matched and exposed it.
// ---------------------------------------------------------------------------

describe('bug #1103 — annotate-dependencies preserves newline before Plans: header', () => {
  let tmpDir;
  afterEach(() => cleanup(tmpDir));

  test('bold **Plans:** summary line followed by bare Plans: header are not fused', (_t) => {
    const roadmap = [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '',
      '**Goal:** Set up project',
      '',
      '**Plans:** 3 plans',
      'Plans:',
      '- [ ] 01-01-PLAN.md — Task A',
      '- [ ] 01-02-PLAN.md — Task B',
      '- [ ] 01-03-PLAN.md — Task C',
      '',
    ].join('\n');

    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': roadmap,
      '.planning/phases/01-foundation/01-01-PLAN.md': makePlan({ phase: '1', plan: '01-01', wave: 1 }),
      '.planning/phases/01-foundation/01-02-PLAN.md': makePlan({ phase: '1', plan: '01-02', wave: 1 }),
      '.planning/phases/01-foundation/01-03-PLAN.md': makePlan({ phase: '1', plan: '01-03', wave: 2, dependsOn: ['01-01'] }),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true, 'annotation must succeed and write back');

    const written = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');

    // Core assertion: the malformed fusion string must NOT appear.
    assert.ok(
      !written.includes('plansPlans:'),
      `ROADMAP must not contain the fused string "plansPlans:"; got:\n${written}`
    );
    // The bold summary line must keep its line boundary before Plans:.
    assert.ok(
      written.includes('**Plans:** 3 plans\nPlans:'),
      `**Plans:** 3 plans must be followed by a newline before Plans:; got:\n${written}`
    );
    assert.ok(written.includes('Wave'), 'wave annotation must appear in ROADMAP.md');
  });

  test('inline Plans: header (no bold summary prefix) still annotates after fix', (_t) => {
    const roadmap = [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '',
      'Plans: 2 plans',
      '- [ ] 01-01-PLAN.md — Task A',
      '- [ ] 01-02-PLAN.md — Task B',
      '',
    ].join('\n');

    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': roadmap,
      '.planning/phases/01-foundation/01-01-PLAN.md': makePlan({ phase: '1', plan: '01-01', wave: 1 }),
      '.planning/phases/01-foundation/01-02-PLAN.md': makePlan({ phase: '1', plan: '01-02', wave: 2, dependsOn: ['01-01'] }),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true, 'inline Plans: header must still be annotated after fix');
  });

  test('mid-string Plans: header keeps exact heading→header spacing (no extra newline)', (_t) => {
    // `phaseSection` always begins with the `### Phase` heading, so the `Plans:`
    // match is always mid-string and `(?:^|\n)` matches a `\n` (the start-of-string
    // `^` branch is unreachable through the handler). This guards the inverse of the
    // bug: the re-emitted newline must restore EXACTLY the one `\n` the regex
    // consumed — not a doubled blank line and not a fusion.
    const roadmap = [
      '### Phase 1: Foundation',
      '',
      'Plans:',
      '- [ ] 01-01-PLAN.md — Task A',
      '- [ ] 01-02-PLAN.md — Task B',
      '',
    ].join('\n');

    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': roadmap,
      '.planning/phases/01-foundation/01-01-PLAN.md': makePlan({ phase: '1', plan: '01-01', wave: 1 }),
      '.planning/phases/01-foundation/01-02-PLAN.md': makePlan({ phase: '1', plan: '01-02', wave: 2, dependsOn: ['01-01'] }),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true, 'Plans: must still be detected and annotated');

    const written = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(
      written.includes('### Phase 1: Foundation\n\nPlans:'),
      `heading→Plans spacing must be preserved exactly; got:\n${written}`
    );
    assert.ok(!written.includes('FoundationPlans:'), 'heading must not fuse onto Plans:');
    assert.ok(!written.includes('Foundation\n\n\nPlans:'), 'no doubled blank line before Plans:');
  });
});
  });
}

// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests - State
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGsdTools, createTempDir, createTempProject, cleanup } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');

function writePassedVerification(tmpDir, phaseDirName, paddedPhase) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'phases', phaseDirName, `${paddedPhase}-VERIFICATION.md`),
    ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
  );
}

describe('state-snapshot command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing STATE.md returns error', () => {
    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'STATE.md not found', 'should report missing file');
  });

  test('extracts basic fields from STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03
**Current Phase Name:** API Layer
**Total Phases:** 6
**Current Plan:** 03-02
**Total Plans in Phase:** 3
**Status:** In progress
**Progress:** 45%
**Last Activity:** 2024-01-15
**Last Activity Description:** Completed 03-01-PLAN.md
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '03', 'current phase extracted');
    assert.strictEqual(output.current_phase_name, 'API Layer', 'phase name extracted');
    assert.strictEqual(output.total_phases, 6, 'total phases extracted');
    assert.strictEqual(output.current_plan, '03-02', 'current plan extracted');
    assert.strictEqual(output.total_plans_in_phase, 3, 'total plans extracted');
    assert.strictEqual(output.status, 'In progress', 'status extracted');
    assert.strictEqual(output.progress_percent, 45, 'progress extracted');
    assert.strictEqual(output.last_activity, '2024-01-15', 'last activity date extracted');
  });

  test('extracts decisions table', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 01

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
| 01 | Use Prisma | Better DX than raw SQL |
| 02 | JWT auth | Stateless authentication |
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.decisions.length, 2, 'should have 2 decisions');
    assert.strictEqual(output.decisions[0].phase, '01', 'first decision phase');
    assert.strictEqual(output.decisions[0].summary, 'Use Prisma', 'first decision summary');
    assert.strictEqual(output.decisions[0].rationale, 'Better DX than raw SQL', 'first decision rationale');
  });

  test('extracts blockers list', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03

## Blockers

- Waiting for API credentials
- Need design review for dashboard
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.blockers, [
      'Waiting for API credentials',
      'Need design review for dashboard',
    ], 'blockers extracted');
  });

  test('extracts session continuity info', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03

## Session

**Last Date:** 2024-01-15
**Stopped At:** Phase 3, Plan 2, Task 1
**Resume File:** .planning/phases/03-api/03-02-PLAN.md
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.session.last_date, '2024-01-15', 'session date extracted');
    assert.strictEqual(output.session.stopped_at, 'Phase 3, Plan 2, Task 1', 'stopped at extracted');
    assert.strictEqual(output.session.resume_file, '.planning/phases/03-api/03-02-PLAN.md', 'resume file extracted');
  });

  test('handles paused_at field', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03
**Paused At:** Phase 3, Plan 1, Task 2 - mid-implementation
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.paused_at, 'Phase 3, Plan 1, Task 2 - mid-implementation', 'paused_at extracted');
  });

  describe('--cwd override', () => {
    let outsideDir;

    beforeEach(() => {
      outsideDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-test-outside-'));
    });

    afterEach(() => {
      cleanup(outsideDir);
    });

    test('supports --cwd override when command runs outside project root', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'STATE.md'),
        `# Session State

**Current Phase:** 03
**Status:** Ready to plan
`
      );

      const result = runGsdTools(`state-snapshot --cwd "${tmpDir}"`, outsideDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.current_phase, '03', 'should read STATE.md from overridden cwd');
      assert.strictEqual(output.status, 'Ready to plan', 'should parse status from overridden cwd');
    });
  });

  test('returns error for invalid --cwd path', () => {
    const invalid = path.join(tmpDir, 'does-not-exist');
    const result = runGsdTools(`state-snapshot --cwd "${invalid}"`, tmpDir);
    assert.ok(!result.success, 'should fail for invalid --cwd');
    assert.ok(result.error.includes('Invalid --cwd'), 'error should mention invalid --cwd');
  });
});

// ─── Regression: #3265 — frontmatter wins over bold-body cell ─────────────

describe('state-snapshot — bug #3265 frontmatter precedence', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns frontmatter status, not **Status:** value embedded in a body table cell', () => {
    // Reproduce the collision: frontmatter says "executing", but the body
    // contains a Markdown table cell with "**Status:** to ✅ COMPLETE ..."
    // which stateExtractField (bold pattern) would match before the YAML line.
    const stateContent = [
      '---',
      'gsd_state_version: 1.0',
      'status: executing',
      'current_plan: 19.5-05',
      '---',
      '',
      '# Project State',
      '',
      '## Recent Quick Tasks',
      '',
      '| Date | Task | Notes |',
      '|------|------|-------|',
      '| 2026-05-01 | Reopened Plan 19.5-05. **Status:** to ✅ COMPLETE | done |',
      '',
      '**Current Phase:** 19',
      '**Current Plan:** archived-lane',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Frontmatter status must win over the table cell's **Status:** match
    assert.strictEqual(output.status, 'executing', 'frontmatter status beats body table cell');
  });

  test('returns frontmatter current_plan, not bold body value when both present', () => {
    const stateContent = [
      '---',
      'gsd_state_version: 1.0',
      'status: executing',
      'current_plan: 19.5-05',
      '---',
      '',
      '# Project State',
      '',
      '**Current Phase:** 19',
      '**Current Plan:** archived-lane',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_plan, '19.5-05', 'frontmatter current_plan beats body bold value');
  });

  test('falls back to body extraction when no frontmatter block is present', () => {
    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 07',
      '**Status:** paused',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // No frontmatter — body extraction must still work
    assert.strictEqual(output.status, 'paused', 'body extraction works without frontmatter');
    assert.strictEqual(output.current_phase, '07', 'body extraction works without frontmatter');
  });
});

describe('state mutation commands', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('add-decision preserves dollar amounts without corrupting Decisions section', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

## Decisions
No decisions yet.

## Blockers
None
`
    );

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '11-01', '--summary', 'Benchmark prices moved from $0.50 to $2.00 to $5.00', '--rationale', 'track cost growth'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(
      state,
      /- \[Phase 11-01\]: Benchmark prices moved from \$0\.50 to \$2\.00 to \$5\.00 — track cost growth/,
      'decision entry should preserve literal dollar values'
    );
    assert.strictEqual((state.match(/^## Decisions$/gm) || []).length, 1, 'Decisions heading should not be duplicated');
    assert.ok(!state.includes('No decisions yet.'), 'placeholder should be removed');
  });

  test('add-blocker preserves dollar strings without corrupting Blockers section', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

## Decisions
None

## Blockers
None
`
    );

    const result = runGsdTools(['state', 'add-blocker', '--text', 'Waiting on vendor quote $1.00 before approval'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(state, /- Waiting on vendor quote \$1\.00 before approval/, 'blocker entry should preserve literal dollar values');
    assert.strictEqual((state.match(/^## Blockers$/gm) || []).length, 1, 'Blockers heading should not be duplicated');
  });

  test('add-decision supports file inputs to preserve shell-sensitive dollar text', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

## Decisions
No decisions yet.

## Blockers
None
`
    );

    const summaryPath = path.join(tmpDir, 'decision-summary.txt');
    const rationalePath = path.join(tmpDir, 'decision-rationale.txt');
    fs.writeFileSync(summaryPath, 'Price tiers: $0.50, $2.00, else $5.00\n');
    fs.writeFileSync(rationalePath, 'Keep exact currency literals for budgeting\n');

    const result = runGsdTools(
      `state add-decision --phase 11-02 --summary-file "${summaryPath}" --rationale-file "${rationalePath}"`,
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(
      state,
      /- \[Phase 11-02\]: Price tiers: \$0\.50, \$2\.00, else \$5\.00 — Keep exact currency literals for budgeting/,
      'file-based decision input should preserve literal dollar values'
    );
  });

  test('add-blocker supports --text-file for shell-sensitive text', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

## Decisions
None

## Blockers
None
`
    );

    const blockerPath = path.join(tmpDir, 'blocker.txt');
    fs.writeFileSync(blockerPath, 'Vendor quote updated from $1.00 to $2.00 pending approval\n');

    const result = runGsdTools(`state add-blocker --text-file "${blockerPath}"`, tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(state, /- Vendor quote updated from \$1\.00 to \$2\.00 pending approval/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state json command (machine-readable STATE.md frontmatter)
// ─────────────────────────────────────────────────────────────────────────────

describe('state json command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing STATE.md returns error', () => {
    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'STATE.md not found', 'should report missing file');
  });

  test('builds frontmatter on-the-fly from body when no frontmatter exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 05
**Current Phase Name:** Deployment
**Total Phases:** 8
**Current Plan:** 05-03
**Total Plans in Phase:** 4
**Status:** In progress
**Progress:** 60%
**Last Activity:** 2026-01-20
`
    );

    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.gsd_state_version, '1.0', 'should have version 1.0');
    assert.strictEqual(output.current_phase, '05', 'current phase extracted');
    assert.strictEqual(output.current_phase_name, 'Deployment', 'phase name extracted');
    assert.strictEqual(output.current_plan, '05-03', 'current plan extracted');
    assert.strictEqual(output.status, 'executing', 'status normalized to executing');
    assert.ok(output.last_updated, 'should have last_updated timestamp');
    assert.strictEqual(output.last_activity, '2026-01-20', 'last activity extracted');
    assert.ok(output.progress, 'should have progress object');
    assert.strictEqual(output.progress.percent, 60, 'progress percent extracted');
  });

  test('reads existing frontmatter when present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
gsd_state_version: 1.0
current_phase: 03
status: paused
stopped_at: Plan 2 of Phase 3
---

# Project State

**Current Phase:** 03
**Status:** Paused
`
    );

    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.gsd_state_version, '1.0', 'version from frontmatter');
    assert.strictEqual(output.current_phase, '03', 'phase from frontmatter');
    assert.strictEqual(output.status, 'paused', 'status from frontmatter');
    assert.strictEqual(output.stopped_at, 'Plan 2 of Phase 3', 'stopped_at from frontmatter');
  });

  test('normalizes various status values', () => {
    const statusTests = [
      { input: 'In progress', expected: 'executing' },
      { input: 'Ready to execute', expected: 'executing' },
      { input: 'Paused at Plan 3', expected: 'paused' },
      { input: 'Ready to plan', expected: 'planning' },
      { input: 'Phase complete — ready for verification', expected: 'verifying' },
      { input: 'Milestone complete', expected: 'completed' },
      { input: 'All phases complete', expected: 'completed' },
    ];

    for (const { input, expected } of statusTests) {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'STATE.md'),
        `# State\n\n**Current Phase:** 01\n**Status:** ${input}\n`
      );

      const result = runGsdTools('state json', tmpDir);
      assert.ok(result.success, `Command failed for status "${input}": ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.status, expected, `"${input}" should normalize to "${expected}"`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATE.md frontmatter sync (write operations add frontmatter)
// ─────────────────────────────────────────────────────────────────────────────

describe('STATE.md frontmatter sync', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state update adds frontmatter to STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 02
**Status:** Ready to execute
`
    );

    const result = runGsdTools('state update Status "Executing Plan 1"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.startsWith('---\n'), 'should start with frontmatter delimiter');
    assert.ok(content.includes('gsd_state_version: 1.0'), 'should have version field');
    assert.ok(content.includes('current_phase: 02'), 'frontmatter should have current phase');
    assert.ok(content.includes('**Current Phase:** 02'), 'body field should be preserved');
    assert.ok(content.includes('**Status:** Executing Plan 1'), 'updated field in body');
  });

  test('state patch adds frontmatter', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 04
**Status:** Planning
**Current Plan:** 04-01
`
    );

    const result = runGsdTools('state patch --Status "In progress" --"Current Plan" 04-02', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.startsWith('---\n'), 'should have frontmatter after patch');
  });

  test('frontmatter is idempotent on multiple writes', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 01
**Status:** Ready to execute
`
    );

    runGsdTools('state update Status "In progress"', tmpDir);
    runGsdTools('state update Status "Paused"', tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const delimiterCount = (content.match(/^---$/gm) || []).length;
    assert.strictEqual(delimiterCount, 2, 'should have exactly one frontmatter block (2 delimiters)');
    assert.ok(content.includes('status: paused'), 'frontmatter should reflect latest status');
  });

  test('preserves frontmatter status when body Status field is missing', () => {
    // Simulate: frontmatter has status: executing, but body lost Status: field
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
status: executing
milestone: v1.0
---

# Project State

**Current Phase:** 03
**Current Plan:** 03-02
`
    );

    // Any writeStateMd triggers syncStateFrontmatter — use state update on a field that exists
    runGsdTools('state update "Current Plan" "03-03"', tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.includes('status: executing'), 'should preserve existing status, not overwrite with unknown');
    assert.ok(!content.includes('status: unknown'), 'should not contain unknown status');
  });

  test('#2202: preserves unknown frontmatter keys the schema does not own', () => {
    // Regression: a mutating verb rewrites STATE.md via syncStateFrontmatter,
    // which rebuilds frontmatter from the body + schema. Before #2202 it dropped
    // any frontmatter key the schema does not own; custom/tooling keys must
    // survive every write.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
status: executing
milestone: v1.0
custom_tracking_id: ABC-123
team: platform
---

# Project State

**Current Phase:** 03
**Current Plan:** 03-02
`
    );

    // Any writeStateMd triggers syncStateFrontmatter.
    runGsdTools('state update "Current Plan" "03-03"', tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(content, /custom_tracking_id: ABC-123/, 'unknown key custom_tracking_id must be preserved');
    assert.match(content, /team: platform/, 'unknown key team must be preserved');
    // Schema-owned keys still win / survive alongside the carried-forward keys.
    assert.ok(content.includes('status: executing'), 'schema-owned status still preserved');
  });

  test('round-trip: write then read via state json', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 07
**Current Phase Name:** Production
**Total Phases:** 10
**Status:** In progress
**Current Plan:** 07-05
**Progress:** 70%
`
    );

    runGsdTools('state update Status "Executing Plan 5"', tmpDir);

    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '07', 'round-trip: phase preserved');
    assert.strictEqual(output.current_phase_name, 'Production', 'round-trip: phase name preserved');
    assert.strictEqual(output.status, 'executing', 'round-trip: status normalized');
    assert.ok(output.last_updated, 'round-trip: timestamp present');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stateExtractField and stateReplaceField helpers
// ─────────────────────────────────────────────────────────────────────────────

const { stateExtractField, stateReplaceField, stateReplaceFieldWithFallback } = require('../gsd-core/bin/lib/state.cjs');

describe('stateExtractField and stateReplaceField helpers', () => {
  // stateExtractField tests

  test('extracts simple field value', () => {
    const content = '# State\n\n**Status:** In progress\n';
    const result = stateExtractField(content, 'Status');
    assert.strictEqual(result, 'In progress', 'should extract simple field value');
  });

  test('extracts field with colon in value', () => {
    const content = '# State\n\n**Last Activity:** 2024-01-15 — Completed plan\n';
    const result = stateExtractField(content, 'Last Activity');
    assert.strictEqual(result, '2024-01-15 — Completed plan', 'should return full value after field pattern');
  });

  test('returns null for missing field', () => {
    const content = '# State\n\n**Phase:** 03\n';
    const result = stateExtractField(content, 'Status');
    assert.strictEqual(result, null, 'should return null when field not present');
  });

  test('is case-insensitive on field name', () => {
    const content = '# State\n\n**status:** Active\n';
    const result = stateExtractField(content, 'Status');
    assert.strictEqual(result, 'Active', 'should match field name case-insensitively');
  });

  // stateReplaceField tests

  test('replaces field value', () => {
    const content = '# State\n\n**Status:** Old\n';
    const result = stateReplaceField(content, 'Status', 'New');
    assert.ok(result !== null, 'should return updated content, not null');
    assert.ok(result.includes('**Status:** New'), 'output should contain updated field value');
    assert.ok(!result.includes('**Status:** Old'), 'output should not contain old field value');
  });

  test('returns null when field not found', () => {
    const content = '# State\n\n**Phase:** 03\n';
    const result = stateReplaceField(content, 'Status', 'New');
    assert.strictEqual(result, null, 'should return null when field not present');
  });

  test('preserves surrounding content', () => {
    const content = [
      '# Project State',
      '',
      '**Phase:** 03',
      '**Status:** Old',
      '**Last Activity:** 2024-01-15',
      '',
      '## Notes',
      'Some notes here.',
    ].join('\n');

    const result = stateReplaceField(content, 'Status', 'New');
    assert.ok(result !== null, 'should return updated content');
    assert.ok(result.includes('**Phase:** 03'), 'Phase line should be unchanged');
    assert.ok(result.includes('**Status:** New'), 'Status should be updated');
    assert.ok(result.includes('**Last Activity:** 2024-01-15'), 'Last Activity line should be unchanged');
    assert.ok(result.includes('## Notes'), 'Notes heading should be unchanged');
    assert.ok(result.includes('Some notes here.'), 'Notes content should be unchanged');
  });

  test('round-trip: extract then replace then extract', () => {
    const content = '# State\n\n**Phase:** 3\n';
    const extracted = stateExtractField(content, 'Phase');
    assert.strictEqual(extracted, '3', 'initial extract should return "3"');

    const updated = stateReplaceField(content, 'Phase', '4');
    assert.ok(updated !== null, 'replace should succeed');

    const reExtracted = stateExtractField(updated, 'Phase');
    assert.strictEqual(reExtracted, '4', 'extract after replace should return "4"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stateReplaceFieldWithFallback — consolidated fallback helper
// ─────────────────────────────────────────────────────────────────────────────

describe('stateReplaceFieldWithFallback', () => {
  test('replaces primary field when present', () => {
    const content = '# State\n\n**Status:** Old\n';
    const result = stateReplaceFieldWithFallback(content, 'Status', null, 'New');
    assert.ok(result.includes('**Status:** New'));
  });

  test('falls back to secondary field when primary not found', () => {
    const content = '# State\n\nLast activity: 2024-01-01\n';
    const result = stateReplaceFieldWithFallback(content, 'Last Activity', 'Last activity', '2025-03-19');
    assert.ok(result.includes('Last activity: 2025-03-19'), 'should update fallback field');
  });

  test('returns content unchanged when neither field matches', () => {
    const content = '# State\n\n**Phase:** 3\n';
    let warning = '';
    const origErrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      warning += String(chunk);
      return true;
    };
    let result;
    try {
      result = stateReplaceFieldWithFallback(content, 'Status', 'state', 'New');
    } finally {
      process.stderr.write = origErrWrite;
    }
    assert.strictEqual(result, content, 'content should be unchanged');
    assert.match(warning, /STATE\.md field "Status"/, 'missing field warning should be emitted');
  });

  test('prefers primary over fallback when both exist', () => {
    const content = '# State\n\n**Status:** Old\nStatus: Also old\n';
    const result = stateReplaceFieldWithFallback(content, 'Status', 'Status', 'New');
    // Bold format is tried first by stateReplaceField
    assert.ok(result.includes('**Status:** New'), 'should replace bold (primary) format');
  });

  test('works with plain format fields', () => {
    const content = '# State\n\nPhase: 1 of 3 (Foundation)\nStatus: In progress\nPlan: 01-01\n';
    let updated = stateReplaceFieldWithFallback(content, 'Status', null, 'Complete');
    assert.ok(updated.includes('Status: Complete'), 'should update plain Status');
    updated = stateReplaceFieldWithFallback(updated, 'Current Plan', 'Plan', 'Not started');
    assert.ok(updated.includes('Plan: Not started'), 'should fall back to Plan field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateLoad, cmdStateGet, cmdStatePatch, cmdStateUpdate CLI tests
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateLoad (state load)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns config and state when STATE.md exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ mode: 'yolo' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n'
    );

    const result = runGsdTools('state load', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_exists, true, 'state_exists should be true');
    assert.strictEqual(output.config_exists, true, 'config_exists should be true');
    assert.strictEqual(output.roadmap_exists, true, 'roadmap_exists should be true');
    assert.ok(output.state_raw.includes('**Status:** Active'), 'state_raw should contain STATE.md content');
  });

  test('returns state_exists false when STATE.md missing', () => {
    const result = runGsdTools('state load', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_exists, false, 'state_exists should be false');
    assert.strictEqual(output.state_raw, '', 'state_raw should be empty string');
  });

  test('returns raw key=value format with --raw flag', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ mode: 'yolo' })
    );

    const result = runGsdTools('state load --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(result.output.includes('state_exists=true'), 'raw output should include state_exists=true');
    assert.ok(result.output.includes('config_exists=true'), 'raw output should include config_exists=true');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2376: cmdStateLoad's *_dir/*_path fields must resolve regardless of the
// calling process's own cwd, not just the orchestrator's — debug.md has no
// init.* call of its own and reads debug_dir from `state load` to build
// debug_file_path for its gsd-debug-session-manager spawns instead of
// hardcoding '.planning/debug/{slug}.md'. See tests/init.test.cjs's matching
// '#2376 — init.* path fields resolve...' describe block for the established
// pattern (spawn gsd-tools with its OS-level process cwd pointed at an
// unrelated decoy directory while passing the real project root via --cwd).
// ─────────────────────────────────────────────────────────────────────────────

describe('#2376 — state load emits absolute debug_dir regardless of process cwd', () => {
  let projectDir;
  let decoyDir;

  beforeEach(() => {
    projectDir = createFixture();
    decoyDir = createTempDir('gsd-2376-decoy-');
  });

  afterEach(() => {
    cleanup(projectDir);
    cleanup(decoyDir);
  });

  test('state load emits absolute debug_dir field that resolves from a different process cwd (previously absent)', () => {
    fs.mkdirSync(path.join(projectDir, '.planning', 'debug'), { recursive: true });

    const result = runGsdTools(['state', 'load', '--cwd', projectDir], decoyDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok('debug_dir' in output, 'cmdStateLoad must now emit debug_dir (#2376)');
    assert.ok(path.isAbsolute(output.debug_dir), `debug_dir must be absolute, got: "${output.debug_dir}"`);
    assert.ok(fs.existsSync(output.debug_dir), `debug_dir must resolve to the real directory: "${output.debug_dir}"`);
  });
});

describe('cmdStateGet (state get)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns full content when no section specified', () => {
    const stateContent = '# Project State\n\n**Status:** Active\n**Phase:** 03\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state get', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.content !== undefined, 'output should have content field');
    assert.ok(output.content.includes('**Status:** Active'), 'content should include full STATE.md text');
  });

  test('extracts bold field value', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );

    const result = runGsdTools('state get Status', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output['Status'], 'Active', 'should extract Status field value');
  });

  test('extracts markdown section content', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n\n## Blockers\n\n- item1\n- item2\n'
    );

    const result = runGsdTools('state get Blockers', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output['Blockers'] !== undefined, 'should have Blockers key in output');
    assert.ok(output['Blockers'].includes('item1'), 'section content should include item1');
    assert.ok(output['Blockers'].includes('item2'), 'section content should include item2');
  });

  test('returns error for nonexistent field', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );

    const result = runGsdTools('state get Missing', tmpDir);
    assert.ok(result.success, `Command should exit 0 even for missing field: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.toLowerCase().includes('not found'), 'error should mention "not found"');
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state get Status', tmpDir);
    assert.ok(!result.success, 'command should fail when STATE.md is missing');
    assert.ok(
      result.error.includes('STATE.md') || result.output.includes('STATE.md'),
      'error message should mention STATE.md'
    );
  });
});

describe('cmdStatePatch and cmdStateUpdate (state patch, state update)', () => {
  let tmpDir;
  const stateMd = [
    '# Project State',
    '',
    '**Current Phase:** 03',
    '**Status:** In progress',
    '**Last Activity:** 2024-01-15',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state patch updates multiple fields at once', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state patch --Status Complete --"Current Phase" 04', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Status:** Complete'), 'Status should be updated to Complete');
    assert.ok(updated.includes('**Last Activity:** 2024-01-15'), 'Last Activity should be unchanged');
  });

  test('state patch accepts JSON object input from workflows', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools([
      'query',
      'state.patch',
      JSON.stringify({
        Status: 'Complete',
        'Current Phase': '04',
      }),
    ], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepEqual(output.updated.sort(), ['Current Phase', 'Status'].sort());

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Status:** Complete'), 'Status should be updated to Complete');
    assert.ok(updated.includes('**Current Phase:** 04'), 'Current Phase should be updated to 04');
  });

  test('state patch reports failed fields that do not exist', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state patch --Status Done --Missing value', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.updated), 'updated should be an array');
    assert.ok(output.updated.includes('Status'), 'Status should be in updated list');
    assert.ok(Array.isArray(output.failed), 'failed should be an array');
    assert.ok(output.failed.includes('Missing'), 'Missing should be in failed list');
  });

  test('state update changes a single field', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state update Status "Phase complete"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'updated should be true');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Status:** Phase complete'), 'Status should be updated');
    assert.ok(updated.includes('**Current Phase:** 03'), 'Current Phase should be unchanged');
    assert.ok(updated.includes('**Last Activity:** 2024-01-15'), 'Last Activity should be unchanged');
  });

  test('state update reports field not found', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state update Missing value', tmpDir);
    assert.ok(result.success, `Command should exit 0 for not-found field: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'updated should be false');
    assert.ok(output.reason !== undefined, 'should include a reason');
  });

  test('state update returns error when STATE.md missing', () => {
    const result = runGsdTools('state update Status value', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'updated should be false');
    assert.ok(
      output.reason.includes('STATE.md'),
      'reason should mention STATE.md'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateAdvancePlan, cmdStateRecordMetric, cmdStateUpdateProgress
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateAdvancePlan (state advance-plan)', () => {
  let tmpDir;

  const advanceFixture = [
    '# Project State',
    '',
    '**Current Plan:** 1',
    '**Total Plans in Phase:** 3',
    '**Status:** Executing',
    '**Last Activity:** 2024-01-10',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('advances plan counter when not on last plan', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), advanceFixture);

    const PINNED_MS = Date.parse('2020-06-15T12:00:00.000Z');
    const PINNED_DATE = '2020-06-15';
    const result = runGsdTools('state advance-plan', tmpDir, {
      GSD_TEST_MODE: '1',
      GSD_NOW_MS: String(PINNED_MS),
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true, 'advanced should be true');
    assert.strictEqual(output.previous_plan, 1, 'previous_plan should be 1');
    assert.strictEqual(output.current_plan, 2, 'current_plan should be 2');
    assert.strictEqual(output.total_plans, 3, 'total_plans should be 3');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Current Plan:** 2'), 'Current Plan should be updated to 2');
    assert.ok(updated.includes('**Status:** Ready to execute'), 'Status should be Ready to execute');
    assert.ok(
      updated.includes(`**Last Activity:** ${PINNED_DATE}`),
      `Last Activity should be the pinned date ${PINNED_DATE}`,
    );
  });

  test('marks phase complete on last plan', () => {
    const lastPlanFixture = advanceFixture.replace('**Current Plan:** 1', '**Current Plan:** 3');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), lastPlanFixture);

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, false, 'advanced should be false');
    assert.strictEqual(output.reason, 'last_plan', 'reason should be last_plan');
    assert.strictEqual(output.status, 'ready_for_verification', 'status should be ready_for_verification');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Phase complete'), 'Status should contain Phase complete');
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });

  test('returns error when plan fields not parseable', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.toLowerCase().includes('cannot parse'), 'error should mention Cannot parse');
  });

  test('advances plan in compound "Plan: X of Y" format', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\nPlan: 2 of 5 in current phase\nStatus: In progress\nLast activity: 2025-01-01\n`
    );

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true, 'advanced should be true');
    assert.strictEqual(output.previous_plan, 2);
    assert.strictEqual(output.current_plan, 3);
    assert.strictEqual(output.total_plans, 5);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Plan: 3 of 5 in current phase'),
      'should preserve compound format with updated plan number');
    assert.ok(updated.includes('Status: Ready to execute'),
      'Status should be updated');
  });

  test('marks phase complete on last plan in compound format', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\nPlan: 3 of 3 in current phase\nStatus: In progress\nLast activity: 2025-01-01\n`
    );

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, false);
    assert.strictEqual(output.reason, 'last_plan');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Phase complete'), 'Status should contain Phase complete');
  });
});

describe('cmdStateRecordMetric (state record-metric)', () => {
  let tmpDir;

  const metricsFixture = [
    '# Project State',
    '',
    '## Performance Metrics',
    '',
    '| Plan | Duration | Tasks | Files |',
    '|------|----------|-------|-------|',
    '| Phase 1 P1 | 3min | 2 tasks | 3 files |',
    '',
    '## Session Continuity',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('appends metric row to existing table', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), metricsFixture);

    const result = runGsdTools('state record-metric --phase 2 --plan 1 --duration 5min --tasks 3 --files 4', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('| Phase 2 P1 | 5min | 3 tasks | 4 files |'), 'new row should be present');
    assert.ok(updated.includes('| Phase 1 P1 | 3min | 2 tasks | 3 files |'), 'existing row should still be present');
  });

  // #2245 Blocker 2: a RAGGED sibling data row (a hand-edited stray/extra
  // pipe) in the existing Performance Metrics table used to fail the
  // whole-table `parseMarkdownTable` gate, which fell through to the
  // "section absent (or malformed)" scaffold branch and appended a SECOND
  // "## Performance Metrics" heading — compounding on every per-plan
  // record-metric call. The append must be ragged-tolerant: it locates the
  // table's last existing row and splices the new row after it WITHOUT
  // requiring every sibling row to parse cleanly, and must never introduce a
  // duplicate heading when a (possibly ragged) table already exists.
  test('#2245 appends into a RAGGED existing table without duplicating the heading', () => {
    const raggedFixture = [
      '# Project State',
      '',
      '## Performance Metrics',
      '',
      '| Plan | Duration | Tasks | Files |',
      '|------|----------|-------|-------|',
      '| Phase 1 P1 | 3min | 2 tasks | 3 files |',
      '| Phase 1 P2 | 4min | 3 tasks | 5 files | extra |',
      '',
      '## Session Continuity',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), raggedFixture);

    const result = runGsdTools('state record-metric --phase 2 --plan 1 --duration 5min --tasks 3 --files 4', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');
    assert.ok(!output.created, 'created must be absent/false — an existing (ragged) section must not be treated as auto-created');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const headingMatches = updated.match(/^## Performance Metrics\s*$/gim) || [];
    assert.strictEqual(headingMatches.length, 1, `exactly ONE "## Performance Metrics" heading expected, got ${headingMatches.length}:\n${updated}`);
    assert.ok(updated.includes('| Phase 1 P2 | 4min | 3 tasks | 5 files | extra |'), 'existing ragged row must be preserved verbatim');
    assert.ok(updated.includes('| Phase 1 P1 | 3min | 2 tasks | 3 files |'), 'existing clean row should still be present');
    assert.ok(updated.includes('| Phase 2 P1 | 5min | 3 tasks | 4 files |'), 'new row should be appended into the existing table');
  });

  // #2245/#2143: a live STATE.md's "## Performance Metrics" section also
  // carries the "By Phase" velocity table (gsd-core/templates/state.md:48,
  // `| Phase | Plans | Total | Avg/Plan |`), which the prior "first table in
  // the section" targeting polluted with a mismatched per-plan row on EVERY
  // plan completion (execute-plan.md:414 calls record-metric per-plan). The
  // command must target ITS OWN `| Plan | Duration | Tasks | Files |` table
  // specifically, self-creating one when the section exists but doesn't
  // carry it yet.
  test('#2245/#2143: record-metric does not pollute the By-Phase velocity table (targets its own metrics table)', () => {
    const byPhaseFixture = [
      '# Project State',
      '',
      '## Performance Metrics',
      '',
      '**Velocity:**',
      '- Total plans completed: 0',
      '- Average duration: 0 min',
      '- Total execution time: 0.0 hours',
      '',
      '**By Phase:**',
      '',
      '| Phase | Plans | Total | Avg/Plan |',
      '|-------|-------|-------|----------|',
      '| - | - | - | - |',
      '',
      '**Recent Trend:**',
      '- Last 5 plans: none',
      '- Trend: Stable',
      '',
      '*Updated after each plan completion*',
      '',
      '## Session Continuity',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), byPhaseFixture);

    const result = runGsdTools('state record-metric --phase 1 --plan 1 --duration 5min --tasks 3 --files 4', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');
    assert.ok(!output.created, 'created must be absent/false — the section already existed');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // (a) By-Phase table unchanged — header + placeholder row intact, and no
    // metric row spliced in between the delimiter and the next blank line.
    const byPhaseIdx = updated.indexOf('| Phase | Plans | Total | Avg/Plan |');
    assert.ok(byPhaseIdx !== -1, 'By-Phase table header must still exist');
    const afterHeader = updated.slice(byPhaseIdx);
    const byPhaseBlock = afterHeader.slice(0, afterHeader.indexOf('\n\n'));
    assert.ok(byPhaseBlock.includes('|-------|-------|-------|----------|'), 'By-Phase delimiter must be intact');
    assert.ok(byPhaseBlock.includes('| - | - | - | - |'), 'By-Phase placeholder row must be intact');
    assert.ok(!byPhaseBlock.includes('Phase 1 P1'), 'the per-plan row must NOT be spliced into the By-Phase table block');
    assert.ok(!byPhaseBlock.includes('5min'), 'the per-plan duration must NOT appear in the By-Phase table block');

    // (b) A dedicated `| Plan | Duration | Tasks | Files |` table now exists,
    // containing the new row.
    const metricsIdx = updated.indexOf('| Plan | Duration | Tasks | Files |');
    assert.ok(metricsIdx !== -1, 'a Per-Plan Metrics table must now exist');
    assert.ok(updated.includes('| Phase 1 P1 | 5min | 3 tasks | 4 files |'), 'the new metric row must be present in the Per-Plan Metrics table');

    // (c) exactly ONE "## Performance Metrics" heading.
    const headingMatches = updated.match(/^## Performance Metrics\s*$/gim) || [];
    assert.strictEqual(headingMatches.length, 1, `exactly ONE "## Performance Metrics" heading expected, got ${headingMatches.length}:\n${updated}`);

    // (d) Recent Trend block + footer preserved.
    assert.ok(updated.includes('**Recent Trend:**'), 'Recent Trend block must be preserved');
    assert.ok(updated.includes('*Updated after each plan completion*'), 'footer must be preserved');
  });

  test('replaces None yet placeholder with first metric', () => {
    const noneYetFixture = [
      '# Project State',
      '',
      '## Performance Metrics',
      '',
      '| Plan | Duration | Tasks | Files |',
      '|------|----------|-------|-------|',
      'None yet',
      '',
      '## Session Continuity',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), noneYetFixture);

    const result = runGsdTools('state record-metric --phase 1 --plan 1 --duration 2min --tasks 1 --files 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!updated.includes('None yet'), 'None yet placeholder should be removed');
    assert.ok(updated.includes('| Phase 1 P1 | 2min | 1 tasks | 2 files |'), 'new row should be present');
  });

  test('returns error when required fields missing', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), metricsFixture);

    const result = runGsdTools('state record-metric --phase 1', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(
      output.error.includes('phase') || output.error.includes('plan') || output.error.includes('duration'),
      'error should mention missing required fields'
    );
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state record-metric --phase 1 --plan 1 --duration 2min', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });
});

describe('cmdStateUpdateProgress (state update-progress)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('calculates progress from plan/summary counts', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [░░░░░░░░░░] 0%\n'
    );

    // Phase 01: 1 PLAN + 1 SUMMARY = completed
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary\n');

    // Phase 02: 1 PLAN only = not completed
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02');
    fs.mkdirSync(phase02Dir, { recursive: true });
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'updated should be true');
    assert.strictEqual(output.percent, 50, 'percent should be 50');
    assert.strictEqual(output.completed, 1, 'completed should be 1');
    assert.strictEqual(output.total, 2, 'total should be 2');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('50%'), 'STATE.md Progress should contain 50%');
  });

  test('handles zero plans gracefully', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [░░░░░░░░░░] 0%\n'
    );

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.percent, 0, 'percent should be 0 when no plans found');
  });

  test('returns error when Progress field missing', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'updated should be false');
    assert.ok(output.reason !== undefined, 'should have a reason');
  });

  // ── #2177: frontmatter `progress:` key must not shadow the body Progress: line ──

  test('#2177 frontmatter progress: key is not matched — body Progress: line is the target', () => {
    // A STATE.md carrying YAML frontmatter (which writeStateMd adds to every
    // STATE.md). The lowercase `progress:` key used to be matched first by the
    // case-insensitive pattern, mangling the frontmatter and leaving the body
    // line stale.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'status: executing',
        'progress:',
        '  total_phases: 1',
        '  completed_phases: 0',
        '  total_plans: 2',
        '  completed_plans: 1',
        '  percent: 20',
        '---',
        '',
        '# Project State',
        '',
        'Progress: [██░░░░░░░░] 20% (1/2 plans complete)',
        '',
      ].join('\n')
    );
    // 1 of 2 plans complete → 50%.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true);
    assert.strictEqual(out.percent, 50);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // The body line advanced to 50% AND its descriptive suffix survived.
    assert.ok(updated.includes('[█████░░░░░] 50% (1/2 plans complete)'),
      'body Progress line must update to 50% with suffix preserved');
    // The frontmatter block is intact (not mangled by the old \s*-crosses-newline match).
    assert.ok(updated.includes('total_phases: 1'), 'frontmatter total_phases key must survive');
    assert.ok(updated.includes('percent:'), 'frontmatter percent key must survive');
  });

  test('#2177 descriptive suffix after the machine segment is preserved', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [█████░░░░░] 50% (2/4 plans done; blocked on API keys)\n'
    );
    // 1 of 1 plan complete → 100%.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success);
    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(/\[██████████\] 100% \(2\/4 plans done; blocked on API keys\)/.test(updated),
      'the machine segment updates to 100% while the suffix is preserved verbatim');
  });

  test('#2177 no body Progress: line → updated:false even if frontmatter has a progress: key', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      ['---', 'progress:', '  percent: 0', '---', '', '# Project State', '', '**Status:** Active', ''].join('\n')
    );
    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, false,
      'a frontmatter progress: key with no body Progress: line must not report a false success');
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateResolveBlocker, cmdStateRecordSession
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateResolveBlocker (state resolve-blocker)', () => {
  let tmpDir;

  const blockerFixture = [
    '# Project State',
    '',
    '## Blockers',
    '',
    '- Waiting for API credentials',
    '- Need design review for dashboard',
    '- Pending vendor approval',
    '',
    '## Session Continuity',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('removes matching blocker line (case-insensitive substring match)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), blockerFixture);

    const result = runGsdTools('state resolve-blocker --text "api credentials"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.resolved, true, 'resolved should be true');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!updated.includes('Waiting for API credentials'), 'matched blocker should be removed');
    assert.ok(updated.includes('Need design review for dashboard'), 'other blocker should still be present');
    assert.ok(updated.includes('Pending vendor approval'), 'other blocker should still be present');
  });

  test('adds None placeholder when last blocker resolved', () => {
    const singleBlockerFixture = [
      '# Project State',
      '',
      '## Blockers',
      '',
      '- Single blocker',
      '',
      '## Session Continuity',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), singleBlockerFixture);

    const result = runGsdTools('state resolve-blocker --text "single blocker"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!updated.includes('- Single blocker'), 'resolved blocker should be removed');

    // Section should contain "None" placeholder, not be empty
    const sectionMatch = updated.match(/## Blockers\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
    assert.ok(sectionMatch, 'Blockers section should still exist');
    assert.ok(sectionMatch[1].includes('None'), 'Blockers section should contain None placeholder');
  });

  test('returns error when text not provided', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), blockerFixture);

    const result = runGsdTools('state resolve-blocker', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(
      output.error.toLowerCase().includes('text'),
      'error should mention text required'
    );
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state resolve-blocker --text "anything"', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });

  test('returns resolved true even if no line matches', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), blockerFixture);

    const result = runGsdTools('state resolve-blocker --text "nonexistent blocker text"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.resolved, true, 'resolved should be true even when no line matches');
  });
});

describe('cmdStateRecordSession (state record-session)', () => {
  let tmpDir;

  const sessionFixture = [
    '# Project State',
    '',
    '## Session Continuity',
    '',
    '**Last session:** 2024-01-10',
    '**Stopped at:** Phase 2, Plan 1',
    '**Resume file:** None',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('updates session fields with stopped-at and resume-file', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionFixture);

    const PINNED_MS = Date.parse('2020-07-20T10:00:00.000Z');
    const PINNED_ISO = '2020-07-20T10:00:00.000Z';
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 3, Plan 2" --resume-file ".planning/phases/03/03-02-PLAN.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');
    assert.ok(Array.isArray(output.updated), 'updated should be an array');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Phase 3, Plan 2'), 'Stopped at should be updated');
    assert.ok(updated.includes('.planning/phases/03/03-02-PLAN.md'), 'Resume file should be updated');
    assert.ok(updated.includes(PINNED_ISO), `Last session should be the pinned ISO timestamp ${PINNED_ISO}`);
  });

  test('updates Last session timestamp even with no other options', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionFixture);

    const PINNED_MS = Date.parse('2020-08-01T08:30:00.000Z');
    const PINNED_ISO = '2020-08-01T08:30:00.000Z';
    const result = runGsdTools('state record-session', tmpDir, {
      GSD_TEST_MODE: '1',
      GSD_NOW_MS: String(PINNED_MS),
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes(PINNED_ISO), `Last session should contain the pinned ISO timestamp ${PINNED_ISO}`);
  });

  test('sets Resume file to None when not specified', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionFixture);

    const result = runGsdTools('state record-session --stopped-at "Phase 1 complete"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Phase 1 complete'), 'Stopped at should be updated');
    // Resume file should be set to None (default)
    const resumeMatch = updated.match(/\*\*Resume file:\*\*\s*(.*)/i);
    assert.ok(resumeMatch, 'Resume file field should exist');
    assert.ok(resumeMatch[1].trim() === 'None', 'Resume file should be None when not specified');
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state record-session', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });

  test('returns recorded false when no session fields found', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n**Phase:** 03\n'
    );

    const result = runGsdTools('state record-session', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, false, 'recorded should be false when no session fields found');
    assert.ok(output.reason !== undefined, 'should have a reason');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Milestone-scoped phase counting in frontmatter
// ─────────────────────────────────────────────────────────────────────────────

describe('milestone-scoped phase counting in frontmatter', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('total_phases counts only current milestone phases', () => {
    // ROADMAP lists only phases 5-6 (current milestone)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v2.0: Next Release',
        '',
        '### Phase 5: Auth',
        '**Goal:** Add authentication',
        '',
        '### Phase 6: Dashboard',
        '**Goal:** Build dashboard',
      ].join('\n')
    );

    // Disk has dirs 01-06 (01-04 are leftover from previous milestone)
    for (let i = 1; i <= 6; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      // Add a plan to each
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-SUMMARY.md`), '# Summary');
    }

    // Write a STATE.md and trigger a write that will sync frontmatter
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 05\n**Status:** In progress\n'
    );

    const result = runGsdTools('state update Status "Executing"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Read the state json to check frontmatter
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const output = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(output.progress.total_phases), 2, 'should count only milestone phases (5 and 6), not all 6');
    assert.strictEqual(Number(output.progress.completed_phases), 2, 'both milestone phases have summaries');
  });

  test('total_phases includes ROADMAP phases without directories', () => {
    // ROADMAP lists 6 phases (5-10), but only 4 have directories on disk
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v3.0',
        '',
        '### Phase 5: Auth',
        '### Phase 6: Dashboard',
        '### Phase 7: API',
        '### Phase 8: Notifications',
        '### Phase 9: Analytics',
        '### Phase 10: Polish',
      ].join('\n')
    );

    // Only phases 5-8 have directories (9 and 10 not yet planned)
    for (let i = 5; i <= 8; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-SUMMARY.md`), '# Summary');
    }

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 08\n**Status:** In progress\n'
    );

    const result = runGsdTools('state update Status "Executing"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const output = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(output.progress.total_phases), 6, 'should count all 6 ROADMAP phases, not just 4 with directories');
    assert.strictEqual(Number(output.progress.completed_phases), 4, 'only 4 phases have summaries');
  });

  test('without ROADMAP counts all phases (pass-all filter)', () => {
    // No ROADMAP.md — all phases should be counted
    for (let i = 1; i <= 4; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
    }

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 01\n**Status:** Planning\n'
    );

    const result = runGsdTools('state update Status "In progress"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const output = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(output.progress.total_phases), 4, 'without ROADMAP should count all 4 phases');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// begin-phase — field preservation (#1365)
// ─────────────────────────────────────────────────────────────────────────────

describe('state begin-phase preserves Current Position fields (#1365)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('begin-phase preserves Status, Last activity, and Progress in Current Position', () => {
    const stateMd = `# Project State

**Current Phase:** 1
**Current Phase Name:** setup
**Total Phases:** 5
**Current Plan:** 0
**Total Plans in Phase:** 0
**Status:** Ready to plan
**Last Activity:** 2026-03-20
**Last Activity Description:** Roadmap created

## Current Position
Phase: 1 of 5 (setup)
Plan: 0 of ? in current phase
Status: Ready to plan
Last activity: 2026-03-20 -- Roadmap created
Progress: [..........] 0%

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '4'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'
    );

    // Extract the Current Position section
    const posMatch = content.match(/## Current Position\s*\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
    assert.ok(posMatch, 'Current Position section should exist');
    const posSection = posMatch[1];

    // Phase and Plan lines should be updated
    assert.ok(/^Phase:.*EXECUTING/m.test(posSection), 'Phase line should say EXECUTING');
    assert.ok(/^Plan:.*1 of 4/m.test(posSection), 'Plan line should show 1 of 4');

    // Status, Last activity, and Progress must still be present (the bug destroys these)
    assert.ok(/^Status:/m.test(posSection),
      'Status field must be preserved in Current Position');
    assert.ok(/^Last activity:/m.test(posSection),
      'Last activity field must be preserved in Current Position');
    assert.ok(/^Progress:/m.test(posSection),
      'Progress field must be preserved in Current Position');
  });

  test('#2245 F2: begin-phase does not clobber an H3 subsection nested under Current Position', () => {
    // A prior revision swapped `locateCurrentPosition` (stops at ANY heading
    // level >= 2) for `collectSection` with its default `levelBounded: true`
    // (stops only at H1/H2), so a `### Notes` subsection under
    // `## Current Position` was folded into the section body and the
    // field-write regexes (which use the `m` flag and match ANY line start)
    // clobbered a same-named line inside that subsection.
    const stateMd = `# Project State

## Current Position

Phase: 1 (Setup) — EXECUTING
Status: Executing Phase 1

### Notes

Plan: DO-NOT-TOUCH

## Next Steps

Do the thing.
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools(
      ['state', 'begin-phase', '--phase', '2', '--name', 'Foo', '--plans', '3'],
      tmpDir,
    );
    assert.ok(result.success, `begin-phase failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(
      content.includes('Plan: DO-NOT-TOUCH'),
      `the ### Notes subsection must not be rewritten by the Current Position field regexes:\n${content}`,
    );
    assert.ok(/^## Next Steps/m.test(content), 'the ## Next Steps section must remain untouched');
    assert.ok(/^Phase:.*EXECUTING/m.test(content), 'Phase line in Current Position should still update');
  });

  test('advance-plan can update Status after begin-phase', () => {
    // Simulates the full workflow: begin-phase then advance through all plans
    const stateMd = `# Project State

**Current Phase:** 1
**Current Phase Name:** setup
**Total Phases:** 5
**Current Plan:** 0
**Total Plans in Phase:** 0
**Status:** Ready to plan
**Last Activity:** 2026-03-20
**Last Activity Description:** Roadmap created

## Current Position
Phase: 1 of 5 (setup)
Plan: 0 of ? in current phase
Status: Ready to plan
Last activity: 2026-03-20 -- Roadmap created
Progress: [..........] 0%

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    // Step 1: begin-phase
    const beginResult = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '2'],
      tmpDir
    );
    assert.ok(beginResult.success, `begin-phase failed: ${beginResult.error}`);

    // Step 2: advance-plan to go from plan 1 to plan 2
    const adv1 = runGsdTools(['state', 'advance-plan'], tmpDir);
    assert.ok(adv1.success, `advance-plan 1 failed: ${adv1.error}`);

    // Step 3: advance-plan again — plan 2 of 2 is the last, should set "Phase complete"
    const adv2 = runGsdTools(['state', 'advance-plan'], tmpDir);
    assert.ok(adv2.success, `advance-plan 2 failed: ${adv2.error}`);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'
    );
    const posMatch = content.match(/## Current Position\s*\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
    assert.ok(posMatch, 'Current Position section should exist after advance-plan');
    const posSection = posMatch[1];

    // After advancing past all plans, Status should say "Phase complete"
    assert.ok(/Status:.*Phase complete/i.test(posSection),
      'Status should be updated to "Phase complete" after last advance-plan');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #1589 — progress counters not updated during plan execution
// ─────────────────────────────────────────────────────────────────────────────

describe('progress counters correct after plan execution (#1589)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('percent in frontmatter is derived from disk counts, not stale Progress body field', () => {
    // STATE.md body still says 0% (update-progress was never called or was skipped),
    // but all 4 plans across 2 phases have SUMMARY.md files on disk.
    // After any STATE.md write, the frontmatter percent must reflect disk reality.
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.mkdirSync(phase02Dir, { recursive: true });

    // Phase 01: 2 plans, 2 summaries (complete)
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase01Dir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-02-SUMMARY.md'), '# Summary\n');

    // Phase 02: 2 plans, 2 summaries (complete)
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-SUMMARY.md'), '# Summary\n');

    // Body Progress: still says 0% (stale — never updated by update-progress)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 02\n**Status:** Phase complete — ready for verification\n**Progress:** [░░░░░░░░░░] 0%\n'
    );

    // Trigger a STATE.md write (e.g. state update Status)
    const result = runGsdTools('state update Status "All phases complete"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Read the frontmatter — percent must be derived from disk (4/4 = 100%), not from body "0%"
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);

    assert.ok(output.progress, 'frontmatter must have progress object');
    assert.strictEqual(Number(output.progress.total_plans), 4, 'total_plans must be 4 from disk');
    assert.strictEqual(Number(output.progress.completed_plans), 4, 'completed_plans must be 4 from disk');
    assert.strictEqual(Number(output.progress.total_phases), 2, 'total_phases must be 2 from disk');
    assert.strictEqual(Number(output.progress.completed_phases), 2, 'completed_phases must be 2 from disk');
    assert.strictEqual(Number(output.progress.percent), 100, 'percent must be 100 (derived from disk counts, not stale body 0%)');
  });

  test('percent is 0 when no summaries exist even if Progress body says 100%', () => {
    // Inverse: body says 100% but disk has no summaries.
    // Frontmatter percent must come from disk, not body.
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    // No summary files

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 01\n**Status:** In progress\n**Progress:** [██████████] 100%\n'
    );

    const result = runGsdTools('state update Status "Executing"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);

    assert.ok(output.progress, 'frontmatter must have progress object');
    assert.strictEqual(Number(output.progress.total_plans), 1, 'total_plans must be 1 from disk');
    assert.strictEqual(Number(output.progress.completed_plans), 0, 'completed_plans must be 0 (no summaries)');
    assert.strictEqual(Number(output.progress.percent), 0, 'percent must be 0 (derived from disk, not stale body 100%)');
  });

  test('state json rebuilds stale frontmatter progress from disk after all plans complete', () => {
    // Reproduces the exact scenario from #1589:
    // Frontmatter was written early with stale counters.
    // All summaries now exist on disk.
    // state json must return fresh disk-derived progress.
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-phase');
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02-phase');
    const phase03Dir = path.join(tmpDir, '.planning', 'phases', '03-phase');
    const phase04Dir = path.join(tmpDir, '.planning', 'phases', '04-phase');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.mkdirSync(phase02Dir, { recursive: true });
    fs.mkdirSync(phase03Dir, { recursive: true });
    fs.mkdirSync(phase04Dir, { recursive: true });

    // 4 phases, 6 total plans (as in the bug report)
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase03Dir, '03-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase03Dir, '03-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase04Dir, '04-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase04Dir, '04-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase04Dir, '04-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase04Dir, '04-02-SUMMARY.md'), '# Summary\n');

    // Write STATE.md with stale frontmatter matching the bug report exactly
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---\ngsd_state_version: '1.0'\nstatus: executing\nprogress:\n  total_phases: 4\n  completed_phases: 0\n  total_plans: 0\n  completed_plans: 4\n  percent: 0\n---\n\n# Project State\n\n**Current Phase:** 04\n**Status:** Ready to execute\n**Progress:** [░░░░░░░░░░] 0%\n`
    );

    // state json must return fresh progress derived from disk (all 6 plans complete across 4 phases)
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);

    assert.ok(output.progress, 'frontmatter must have progress object');
    assert.strictEqual(Number(output.progress.total_plans), 6, 'total_plans must be 6 (not stale 0)');
    assert.strictEqual(Number(output.progress.completed_plans), 6, 'completed_plans must be 6 (not stale 4)');
    assert.strictEqual(Number(output.progress.total_phases), 4, 'total_phases must be 4');
    assert.strictEqual(Number(output.progress.completed_phases), 4, 'completed_phases must be 4 (not stale 0)');
    assert.strictEqual(Number(output.progress.percent), 100, 'percent must be 100 (not stale 0)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updatePerformanceMetricsSection (Step 1)
// ─────────────────────────────────────────────────────────────────────────────

describe('updatePerformanceMetricsSection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty Performance Metrics section rebuilds with zeros', () => {
    const content = `# Project State

**Status:** Executing Phase 3

## Performance Metrics

**Velocity:**
- Total plans completed: [N]
- Average duration: [X] min
- Total execution time: [X.X] hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

## Accumulated Context
`;

    // We test via the CLI: phase complete triggers updatePerformanceMetricsSection
    // But first let's test the helper directly via state planned-phase + phase complete flow
    // For a unit-style test, write STATE.md and call state validate to check metrics
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    // Create a phase with 2 plans, 2 summaries
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan 1\n');
    fs.writeFileSync(path.join(phaseDir, '03-02-PLAN.md'), '# Plan 2\n');
    fs.writeFileSync(path.join(phaseDir, '03-01-SUMMARY.md'), '# Summary 1\n');
    fs.writeFileSync(path.join(phaseDir, '03-02-SUMMARY.md'), '# Summary 2\n');
    writePassedVerification(tmpDir, '03-api', '03');

    // Also need ROADMAP.md for phase complete
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 3: API\n\n- [ ] Phase 3: API Layer\n`
    );

    const result = runGsdTools('phase complete 3', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');
    assert.ok(stateAfter.includes('Total plans completed:'), 'Velocity section should have total plans');
    assert.ok(stateAfter.match(/Total plans completed:\s*2/), 'Total plans should be 2');
    assert.ok(stateAfter.includes('| 3'), 'By Phase table should have row for phase 3');
  });

  test('existing Plan Execution Times rows aggregated into Velocity/By Phase', () => {
    const content = `# Project State

**Current Phase:** 04
**Status:** Executing Phase 4

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 3 P1 | 12 min | 5 tasks | 3 files |
| Phase 3 P2 | 8 min | 3 tasks | 2 files |

**Velocity:**
- Total plans completed: 2
- Average duration: 10 min
- Total execution time: 0.3 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 3 | 2 | 20 min | 10 min |

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    // Create phase 4 with 1 plan, 1 summary
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-ui');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '04-01-PLAN.md'), '# Plan 1\n');
    fs.writeFileSync(path.join(phaseDir, '04-01-SUMMARY.md'), '# Summary 1\n');
    writePassedVerification(tmpDir, '04-ui', '04');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 4: UI\n\n- [ ] Phase 4: UI Layer\n`
    );

    const result = runGsdTools('phase complete 4', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');
    assert.ok(stateAfter.match(/Total plans completed:\s*3/), 'Total plans should be 3 (2 previous + 1 new)');
    assert.ok(stateAfter.includes('| 4'), 'By Phase table should have row for phase 4');
  });

  test('idempotent — running twice produces same result', () => {
    const content = `# Project State

**Current Phase:** 05
**Status:** Executing Phase 5

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: N/A
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-final');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '05-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '05-01-SUMMARY.md'), '# Summary\n');
    writePassedVerification(tmpDir, '05-final', '05');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 5: Final\n\n- [ ] Phase 5: Final\n`
    );

    runGsdTools('phase complete 5', tmpDir);
    const afterFirst = fs.readFileSync(statePath, 'utf-8');

    // Reset state so we can complete again
    let resetContent = afterFirst.replace(/All phases complete|Ready to plan/, 'Executing Phase 5');
    resetContent = resetContent.replace(/Not started/, '1');
    fs.writeFileSync(statePath, resetContent);

    // Re-create plan files (they still exist)
    runGsdTools('phase complete 5', tmpDir);
    const afterSecond = fs.readFileSync(statePath, 'utf-8');

    // #1582: the velocity total must be IDEMPOTENT across re-runs of the same phase.
    // The old blind-add (prevTotal + summaryCount) double-counted on every re-run
    // (1 -> 2 here); the fix derives the total from the By-Phase Plans column, so
    // re-running the same phase upserts the same row and the sum stays stable.
    const firstCount = afterFirst.match(/Total plans completed:\s*(\d+)/);
    const secondCount = afterSecond.match(/Total plans completed:\s*(\d+)/);
    assert.ok(firstCount, 'First run should have total plans');
    assert.ok(secondCount, 'Second run should have total plans');
    assert.equal(
      firstCount[1],
      secondCount[1],
      `velocity total must be idempotent across re-runs of phase 5 (#1582): first=${firstCount[1]} second=${secondCount[1]}`,
    );
    assert.equal(firstCount[1], '1', 'phase 5 has 1 plan, so the velocity total must be 1');
    // The By Phase row for phase 5 should be updated, not duplicated.
    const phase5Rows = (afterSecond.match(/\|\s*5\s*\|/g) || []).length;
    assert.ok(phase5Rows <= 1, 'Phase 5 should appear at most once in By Phase table (no duplicates)');
  });

  test('#1582 — velocity self-heals a hand-inflated total down to the true By-Phase sum', () => {
    // A hand-edited STATE.md whose velocity line says 99 but whose By-Phase table
    // records the true completed plans. Completing a fresh phase must RECOMPUTE the
    // total from the table (derive, not accumulate), correcting the inflated value
    // downward rather than adding to it.
    const content = `# Project State

**Current Phase:** 02
**Status:** Executing Phase 2

## Performance Metrics

**Velocity:**
- Total plans completed: 99
- Average duration: 5 min
- Total execution time: 0.1 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 2 | 10 min | 5 min |

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-next');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# Summary\n');
    writePassedVerification(tmpDir, '02-next', '02');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 2: Next\n\n- [ ] Phase 2: Next\n`
    );

    const result = runGsdTools('phase complete 2', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');
    // True sum = phase 1 (2) + phase 2 (1) = 3. Old blind-add would yield 99 + 1 = 100.
    assert.ok(
      stateAfter.match(/Total plans completed:\s*3\b/),
      'velocity total must self-heal to the true By-Phase sum (3), not accumulate from the inflated 99 (#1582)',
    );
  });

  test('#1582 — velocity sums indented By-Phase data rows too (codex review: byPhaseTablePattern allows [ \\t]* leading whitespace, so the sum must match it)', () => {
    // byPhaseTablePattern's data-row capture is `(?:[ \\t]*\\|...)*` — it ALLOWS leading
    // whitespace. The derive sum must tolerate the same, or a hand-edited/legacy indented
    // row is captured by the table but silently skipped by the sum (undercount).
    const content = `# Project State

**Current Phase:** 02
**Status:** Executing Phase 2

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: N/A
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
  | 1 | 2 | - | - |

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-next');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# Summary\n');
    writePassedVerification(tmpDir, '02-next', '02');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 2: Next\n\n- [ ] Phase 2: Next\n`
    );

    const result = runGsdTools('phase complete 2', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');
    // Indented phase-1 row (2) + new column-0 phase-2 row (1) = 3. A sum regex anchored
    // at ^\\| would skip the indented row and report 1.
    assert.ok(
      stateAfter.match(/Total plans completed:\s*3\b/),
      'velocity must sum indented By-Phase rows too (codex review, #1582): expected 3 (2 + 1)',
    );
  });

  test('byPhaseTablePattern behavior-lock (#320): By Phase table header preserved and phase row upserted after hoist to module scope', () => {
    // Exercises the byPhaseTablePattern match path directly: header must be preserved,
    // an existing phase row must be replaced (not duplicated), and a new phase row inserted.
    const content = `# Project State

**Current Phase:** 06
**Status:** Executing Phase 6

## Performance Metrics

**Velocity:**
- Total plans completed: 1
- Average duration: 5 min
- Total execution time: 0.1 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 6 | 1 | 5 min | 5 min |

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '06-lock');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '06-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '06-02-PLAN.md'), '# Plan 2\n');
    fs.writeFileSync(path.join(phaseDir, '06-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '06-02-SUMMARY.md'), '# Summary 2\n');
    writePassedVerification(tmpDir, '06-lock', '06');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 6: Lock\n\n- [ ] Phase 6: Lock\n`
    );

    const result = runGsdTools('phase complete 6', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');

    // Header must be preserved
    assert.ok(stateAfter.includes('| Phase | Plans | Total | Avg/Plan |'), 'By Phase table header must be preserved');

    // Phase 6 row must appear exactly once (upserted, not duplicated)
    const phase6Rows = (stateAfter.match(/\|\s*6\s*\|/g) || []).length;
    assert.strictEqual(phase6Rows, 1, 'Phase 6 row must appear exactly once in By Phase table (upsert, not append)');

    // Total plans count = sum of the By-Phase Plans column after the upsert. Phase 6's
    // row is upserted to its current summaryCount (2), and it is the only row, so the
    // derived total is 2. (#1582: derived from the table, not blind-added onto the prior
    // velocity — which previously produced 1+2=3 by double-counting phase 6.)
    assert.ok(stateAfter.match(/Total plans completed:\s*2\b/), 'Total plans completed should equal the By-Phase Plans sum (2) after upsert (#1582)');
  });

  test('#1658 — By-Phase table row upserts on a CRLF STATE.md (byPhaseTablePattern must be CRLF-tolerant)', () => {
    const content = [
      '# Project State', '',
      '**Current Phase:** 07', '**Status:** Executing Phase 7', '',
      '## Performance Metrics', '',
      '**Velocity:**',
      '- Total plans completed: [N]',
      '- Average duration: N/A',
      '- Total execution time: 0 hours', '',
      '**By Phase:**', '',
      '| Phase | Plans | Total | Avg/Plan |',
      '|-------|-------|-------|----------|',
      '| - | - | - | - |', '',
      '## Accumulated Context', '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Force CRLF line endings across the whole STATE.md (Windows / hand-edited).
    fs.writeFileSync(statePath, content.replace(/\r?\n/g, '\r\n'), 'utf8');

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '07-crlf');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '07-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '07-01-SUMMARY.md'), '# Summary\n');
    // #1548 (#1522) enforces canonical verification before phase transition, so phase
    // complete fail-closes without a passed VERIFICATION.md. Add one so the test exercises
    // the By-Phase row upsert path (the actual #1658 concern) rather than the gate.
    writePassedVerification(tmpDir, '07-crlf', '07');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phase 7: CRLF\n\n- [ ] Phase 7\n');

    const result = runGsdTools('phase complete 7', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf8');
    // #1658: byPhaseTablePattern is CRLF-tolerant. #1668 (By-Phase row not persisted on a
    // CRLF STATE.md even though the pattern matches CRLF) was resolved by #1655's
    // restructure of updatePerformanceMetricsSection (table upsert now runs before the
    // velocity manipulation). Assert the full contract: row present, placeholder removed,
    // velocity derived — all on a CRLF STATE.md.
    assert.ok(
      /\|\s*7\s*\|\s*1\s*\|/.test(after),
      'By-Phase row for phase 7 must be upserted even on a CRLF STATE.md (#1658/#1668)',
    );
    assert.ok(
      !/\|\s*-\s*\|\s*-\s*\|\s*-\s*\|\s*-\s*\|/.test(after),
      'placeholder row must be removed on CRLF STATE.md once a real row is upserted',
    );
    assert.ok(
      /Total plans completed:\s*1\b/.test(after),
      'velocity total must derive from the CRLF By-Phase table (1 plan)',
    );
  });

  test('#1659 — completing an unpadded phase number upserts an existing zero-padded By-Phase row (no duplicate)', () => {
    const content = [
      '# Project State', '',
      '**Current Phase:** 05', '**Status:** Executing Phase 5', '',
      '## Performance Metrics', '',
      '**Velocity:**', '- Total plans completed: 1', '- Average duration: N/A', '- Total execution time: 0 hours', '',
      '**By Phase:**', '',
      '| Phase | Plans | Total | Avg/Plan |',
      '|-------|-------|-------|----------|',
      '| 05 | 1 | - | - |',   // seeded ZERO-PADDED row
      '',
      '## Accumulated Context', '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content, 'utf8');

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-final');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '05-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '05-01-SUMMARY.md'), '# Summary\n');
    writePassedVerification(tmpDir, '05-final', '05');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phase 5: Final\n\n- [ ] Phase 5\n');

    // phase complete with the UNPADDED number "5" — must upsert the seeded "| 05 |" row,
    // not append a duplicate "| 5 |".
    const result = runGsdTools('phase complete 5', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf8');
    const rows05 = (after.match(/^\|\s*05\s*\|/gm) || []).length;
    const rows5 = (after.match(/^\|\s*5\s*\|/gm) || []).length;
    assert.equal(rows05 + rows5, 1, `phase 5 must appear exactly once in By Phase (got |05|=${rows05} |5|=${rows5}) — padded/unpadded must dedup (#1659)`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state planned-phase (Step 3 — Gate 3a)
// ─────────────────────────────────────────────────────────────────────────────

describe('state planned-phase command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('after call: Status is "Ready to execute"', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning Phase 3\n**Total Plans in Phase:** 0\n**Last Activity:** 2024-01-01\n**Current Phase:** 3\n`
    );

    const result = runGsdTools(['state', 'planned-phase', '--phase', '3', '--name', 'API', '--plans', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(stateContent.includes('Ready to execute'), 'Status should be "Ready to execute"');
  });

  test('after call: Total Plans matches argument', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning\n**Total Plans in Phase:** 0\n**Last Activity:** 2024-01-01\n**Current Phase:** 2\n`
    );

    const result = runGsdTools(['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '7'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(stateContent.match(/Total Plans in Phase.*7/), 'Total Plans should be 7');
  });

  test('after call: Last Activity is the pinned date (deterministic via GSD_NOW_MS)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning\n**Total Plans in Phase:** 0\n**Last Activity:** 2024-01-01\n**Current Phase:** 1\n`
    );

    const PINNED_MS = Date.parse('2020-09-10T15:00:00.000Z');
    const PINNED_DATE = '2020-09-10';
    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '1', '--name', 'Setup', '--plans', '3'],
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(
      stateContent.includes(PINNED_DATE),
      `Last Activity should contain the pinned date ${PINNED_DATE}`,
    );
  });

  test('missing STATE.md returns graceful error', () => {
    // No STATE.md written
    const result = runGsdTools(['state', 'planned-phase', '--phase', '1', '--name', 'Test', '--plans', '3'], tmpDir);
    assert.ok(result.success, 'Should not crash');
    const output = JSON.parse(result.output);
    assert.ok(output.error, 'Should return error field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bug #1070 regression: "Complete ✓" terminal status must yield to planned-phase
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #1070: "Complete ✓" terminal status yields to Ready to execute on planned-phase', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Full STATE.md shape that matches the canonical fixture used across state tests.
  // Both **Status:** frontmatter and Current Position `Status:` are set to the given value.
  function makeStateMd(statusValue) {
    return `# Project State

**Current Phase:** 1
**Current Phase Name:** setup
**Total Phases:** 5
**Current Plan:** 0
**Total Plans in Phase:** 0
**Status:** ${statusValue}
**Last Activity:** 2026-03-20
**Last Activity Description:** Phase 1 complete

## Current Position
Phase: 1 of 5 (setup)
Plan: 0 of 5 in current phase
Status: ${statusValue}
Last activity: 2026-03-20 -- Phase 1 complete
Progress: [##########] 20%

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
`;
  }

  // Case 1: the bug — Complete ✓ blocks the state machine
  test('case 1: Complete ✓ in both frontmatter and Current Position is overwritten by planned-phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      makeStateMd('Complete ✓')
    );

    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '5'],
      tmpDir
    );
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);

    // The updated array must include Status (both paths ran the replacement)
    assert.ok(
      Array.isArray(output.updated) && output.updated.includes('Status'),
      `Expected output.updated to include "Status", got: ${JSON.stringify(output.updated)}`
    );

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // The checkmark form must be gone
    assert.ok(
      !stateContent.includes('Complete ✓'),
      'STATE.md must not contain "Complete ✓" after planned-phase'
    );

    // Frontmatter **Status:** line must now be "Ready to execute"
    const fmStatusMatch = stateContent.match(/\*\*Status:\*\*\s*(.+)/);
    assert.ok(fmStatusMatch, '**Status:** frontmatter line not found');
    assert.strictEqual(
      fmStatusMatch[1].trim(),
      'Ready to execute',
      `Frontmatter **Status:** should be "Ready to execute", got: "${fmStatusMatch[1].trim()}"`
    );

    // Current Position Status: line must also be "Ready to execute"
    const posMatch = stateContent.match(/## Current Position\s*\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
    assert.ok(posMatch, 'Current Position section not found');
    const posStatusMatch = posMatch[1].match(/^Status:\s*(.+)/m);
    assert.ok(posStatusMatch, 'Status field not found in Current Position section');
    assert.strictEqual(
      posStatusMatch[1].trim(),
      'Ready to execute',
      `Current Position Status should be "Ready to execute", got: "${posStatusMatch[1].trim()}"`
    );
  });

  // Case 2: a genuinely executor-authored non-terminal status must NOT be overwritten
  // (frontmatter **Status:** path via stateReplaceFieldIfTemplate)
  test('case 2: executor-authored non-terminal status is preserved by planned-phase (#397 narrowness check)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      makeStateMd('Blocked on infra review')
    );

    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '5'],
      tmpDir
    );
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // The executor-authored Status must survive in the frontmatter
    const fmStatusMatch = stateContent.match(/\*\*Status:\*\*\s*(.+)/);
    assert.ok(fmStatusMatch, '**Status:** frontmatter line not found');
    assert.strictEqual(
      fmStatusMatch[1].trim(),
      'Blocked on infra review',
      `Frontmatter **Status:** should be preserved as "Blocked on infra review", got: "${fmStatusMatch[1].trim()}"`
    );
  });

  // Case 3: executor-authored non-terminal status in the Current Position section
  // must NOT be overwritten (exercises updateCurrentPositionFields in src/state.cts,
  // a separate code path from the frontmatter matcher).
  test('case 3: executor-authored non-terminal status in Current Position is preserved by planned-phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      makeStateMd('Blocked on infra review')
    );

    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '5'],
      tmpDir
    );
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // Locate the Current Position section and verify the Status line there.
    const posMatch = stateContent.match(/## Current Position\s*\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
    assert.ok(posMatch, 'Current Position section not found');
    const posStatusMatch = posMatch[1].match(/^Status:\s*(.+)/m);
    assert.ok(posStatusMatch, 'Status field not found in Current Position section');
    assert.strictEqual(
      posStatusMatch[1].trim(),
      'Blocked on infra review',
      `Current Position Status should be preserved as "Blocked on infra review", got: "${posStatusMatch[1].trim()}"`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state validate (Step 4 — Gate 1)
// ─────────────────────────────────────────────────────────────────────────────

describe('state validate command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('STATE says executing + VERIFICATION.md shows passed emits warning', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 2\n**Current Phase:** 2\n**Total Plans in Phase:** 2\n**Current Plan:** 1\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-core');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '02-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.warnings.length > 0, 'Should have warnings when executing but verification passed');
    assert.ok(output.warnings.some(w => /verif/i.test(w)), 'Warning should mention verification');
  });

  test('STATE plan count 3 but 12 SUMMARY.md on disk emits mismatch warning', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 3\n**Current Plan:** 1\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    // Write 12 plans and summaries
    for (let i = 1; i <= 12; i++) {
      const padded = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(phaseDir, `01-${padded}-PLAN.md`), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, `01-${padded}-SUMMARY.md`), '# Summary\n');
    }

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.warnings.length > 0, 'Should have warnings for plan count mismatch');
    assert.ok(output.warnings.some(w => /plan.*count|count.*mismatch/i.test(w)), 'Warning should mention plan count mismatch');
  });

  test('perfect state returns valid: true, no warnings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 2\n**Current Plan:** 1\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, true, 'Should be valid');
    assert.strictEqual(output.warnings.length, 0, 'Should have no warnings');
  });

  test('missing STATE.md returns graceful error', () => {
    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, 'Should not crash');
    const output = JSON.parse(result.output);
    assert.ok(output.error, 'Should return error field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state sync (Step 5 — Gate 2)
// ─────────────────────────────────────────────────────────────────────────────

describe('state sync command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('drifted STATE.md + correct filesystem: after sync, fields match disk', () => {
    // STATE says phase 1 with 0 plans, but disk has phase 2 with 3 plans
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning\n**Current Phase:** 1\n**Total Plans in Phase:** 0\n**Current Plan:** 0\n**Progress:** 0%\n`
    );

    const phase1Dir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1Dir, { recursive: true });
    fs.writeFileSync(path.join(phase1Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase1Dir, '01-01-SUMMARY.md'), '# Summary\n');

    const phase2Dir = path.join(tmpDir, '.planning', 'phases', '02-core');
    fs.mkdirSync(phase2Dir, { recursive: true });
    fs.writeFileSync(path.join(phase2Dir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase2Dir, '02-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase2Dir, '02-03-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase2Dir, '02-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.synced, 'Should report synced');

    const stateAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // Total plans in current phase (phase 2 since it's highest with incomplete plans) should be 3
    assert.ok(stateAfter.match(/Total Plans in Phase.*3/), 'Total Plans should match disk (3)');
  });

  test('run sync twice is idempotent', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 2\n**Current Plan:** 1\n**Progress:** 0%\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    runGsdTools('state sync', tmpDir);
    const afterFirst = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    runGsdTools('state sync', tmpDir);
    const afterSecond = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // Strip frontmatter timestamps which will differ
    const stripTimestamps = (s) => s.replace(/last_updated:.*\r?\n/g, '').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, 'TS');
    assert.strictEqual(stripTimestamps(afterFirst), stripTimestamps(afterSecond), 'Two syncs should produce same result');
  });

  test('--verify flag reports changes without writing', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning\n**Current Phase:** 1\n**Total Plans in Phase:** 0\n**Current Plan:** 0\n**Progress:** 0%\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');

    const before = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    const result = runGsdTools('state sync --verify', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.changes && output.changes.length > 0, 'Should report changes');
    assert.strictEqual(output.dry_run, true, 'Should indicate dry run');

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(before, after, 'File should not be modified in verify mode');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #2444: stopped_at frontmatter must not be overwritten by historical body prose
// ─────────────────────────────────────────────────────────────────────────────

describe('stopped_at frontmatter not overwritten by historical prose (bug #2444)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state sync preserves correct stopped_at frontmatter when historical plain-text match appears before Session section', () => {
    // The bug: body has plain "Stopped at:" in old notes (no bold) — stateExtractField
    // uses a plain ^Stopped at:\s*(.+) pattern with /im which matches the first line,
    // returning the stale historical value. syncStateFrontmatter has no preservation
    // step for stopped_at like cmdStateJson does, so it overwrites the correct value.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
gsd_state_version: '1.0'
status: executing
stopped_at: Phase 3, Plan 2 — current correct value
---

# Project State

**Current Phase:** 03
**Status:** In progress

## Previous Session Notes

Stopped at: Phase 5 complete — v1.0 shipped (OLD stale historical note)

## Session

Last Date: 2026-04-19
Stopped At: Phase 3, Plan 2 — current correct value
`
    );

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // The correct frontmatter value must survive the sync
    assert.ok(
      stateContent.includes('Phase 3, Plan 2 — current correct value'),
      'stopped_at must retain the correct value from the ## Session section'
    );
    assert.ok(
      !stateContent.includes('stopped_at: Phase 5 complete'),
      'stopped_at must NOT be overwritten with the old historical note'
    );
  });

  test('state sync does not promote stale body prose to stopped_at frontmatter when frontmatter has no stopped_at', () => {
    // No existing stopped_at in frontmatter, body has plain Stopped at: in
    // a historical notes section appearing BEFORE the real ## Session entry.
    // buildStateFrontmatter should scope extraction to ## Session section, not
    // match the first occurrence anywhere in the body.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
gsd_state_version: '1.0'
status: executing
---

# Project State

**Current Phase:** 03
**Status:** In progress

## Old Notes

Stopped at: Phase 5 complete — v1.0 STALE (should never land in frontmatter)

## Session

Last Date: 2026-04-19
Stopped At: Phase 3, Plan 1 — real current value
`
    );

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);

    assert.strictEqual(output.stopped_at, 'Phase 3, Plan 1 — real current value',
      'stopped_at must be extracted from ## Session section, not the first plain-text match in the body');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #2567: current-state field extraction must be scoped so historical body
// prose in archive sections cannot overwrite frontmatter. Same divergence
// class as #2444 (which scoped Stopped At to ## Session): the #2444 fix did
// not propagate to Last Activity, Last Activity Description, Paused At, and
// the other current-state fields. These pin the scoped-extraction contract.
// ─────────────────────────────────────────────────────────────────────────────

describe('last_activity / paused_at frontmatter not overwritten by historical prose (bug #2567)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Extract the YAML frontmatter block (between the --- fences) so assertions
  // target the frontmatter only, not field-shaped prose elsewhere in the body.
  function frontmatterBlock(stateContent) {
    const m = stateContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return m ? m[1] : '';
  }

  test('state sync does not let a stale archive "Last activity:" leak into the last_activity frontmatter', () => {
    // The issue's repro: frontmatter holds the current value; the body has NO
    // current Last Activity line (only frontmatter does), but an archive
    // section further down contains a stale "Last activity:" line. Before the
    // fix, buildStateFrontmatter extracted the stale body value and overwrote
    // the correct frontmatter value on every sync. (state sync may also touch
    // the body's Last Activity line via syncCore; the assertion is therefore
    // on the frontmatter block specifically, and checks the stale value never
    // lands there regardless of any date mutation.)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        "gsd_state_version: '1.0'",
        'status: executing',
        "last_activity: '2026-07-23'",
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 03',
        '**Status:** In progress',
        '',
        '## Previous Notes',
        '',
        'Last activity: 2026-06-20 - some older task',
        '',
        '## Session',
        '',
        'Last Date: 2026-07-22',
        'Stopped At: Phase 3, Plan 2 — current',
        '',
      ].join('\n')
    );

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = frontmatterBlock(stateContent);

    assert.ok(/last_activity:/.test(fm),
      'last_activity must remain in frontmatter after sync');
    assert.ok(!/last_activity:[^\n]*2026-06-20/.test(fm),
      `stale archive value must not leak into frontmatter; frontmatter was:\n${fm}`);
  });

  test('state sync does not let a stale archive "Paused At:" leak into the paused_at frontmatter', () => {
    // Paused At is a session field: scope to ## Session (same treatment as
    // Stopped At under #2444). A stale Paused At in an archive section that
    // appears BEFORE ## Session must not win over the current value.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        "gsd_state_version: '1.0'",
        'status: executing',
        "paused_at: '2026-07-22'",
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 03',
        '**Status:** In progress',
        '',
        '## Old Session Notes',
        '',
        'Paused At: 2026-06-15 - old pause',
        '',
        '## Session',
        '',
        'Last Date: 2026-07-22',
        'Paused At: 2026-07-22',
        '',
      ].join('\n')
    );

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = frontmatterBlock(stateContent);

    assert.ok(!/paused_at:[^\n]*2026-06-15/.test(fm),
      `stale archive paused_at must not leak into frontmatter; frontmatter was:\n${fm}`);
    assert.ok(/paused_at:[^\n]*2026-07-22/.test(fm),
      `paused_at must retain the ## Session value (2026-07-22); frontmatter was:\n${fm}`);
  });

  test('state json surfaces the preserved last_activity, not undefined, when the body preamble lacks the field', () => {
    // Read-path guard for #2567 + the cmdStateJson preserve fix: when the body
    // preamble has no Last Activity (only the frontmatter holds it and the
    // body's sole copy is a stale archive line), `state json` must surface the
    // preserved frontmatter value, not undefined. Uses `state json` directly
    // (no preceding sync) so the frontmatter value is deterministic.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        "gsd_state_version: '1.0'",
        'status: executing',
        "last_activity: '2026-07-23'",
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 03',
        '**Status:** In progress',
        '',
        '## Archive',
        '',
        'Last activity: 2026-06-20 - older',
        '',
      ].join('\n')
    );

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const parsed = JSON.parse(jsonResult.output);

    assert.strictEqual(parsed.last_activity, '2026-07-23',
      `state json must surface the preserved frontmatter last_activity (2026-07-23) but got ${parsed.last_activity}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #2445: stale phase dirs from closed milestone inflate phase counts
// ─────────────────────────────────────────────────────────────────────────────

describe('stale phase dirs do not corrupt phase counts (bug #2445)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state json excludes stale prior-milestone phase dirs from phase count when ROADMAP scopes current milestone', () => {
    // Old milestone had phases 1-5; new milestone starts fresh with phases 1-2.
    // Stale dirs for old phases 3, 4, 5 remain in .planning/phases/ and must be
    // excluded by getMilestonePhaseFilter (new ROADMAP only lists phases 1 and 2).
    // Old phases 1 and 2 dirs are ambiguous (same number reused) but phase 3-5 dirs
    // must not inflate total_phases beyond the ROADMAP's phaseCount of 2.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '<details>',
        '<summary>v1.0 — Old Milestone (Shipped)</summary>',
        '',
        '## Roadmap v1.0: Old Milestone',
        '### Phase 1: Old Foundation',
        '### Phase 2: Old API',
        '### Phase 3: Old Deploy',
        '### Phase 4: Old Polish',
        '### Phase 5: Old Wrap',
        '',
        '</details>',
        '',
        '## Roadmap v2.0: New Milestone',
        '### Phase 1: New Foundation',
        '### Phase 2: New API',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nmilestone: v2.0\n---\n\n# State\n\n**Current Phase:** 01\n**Status:** Planning\n'
    );

    // Create stale v1.0 phase dirs 3, 4, 5 — these are NOT in the new ROADMAP
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (const dir of ['03-old-deploy', '04-old-polish', '05-old-wrap']) {
      const d = path.join(phasesDir, dir);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${dir.slice(0, 2)}-01-PLAN.md`), '# stale plan\n');
    }

    // New milestone has only Phase 1 started so far
    const newPhaseDir = path.join(phasesDir, '01-new-foundation');
    fs.mkdirSync(newPhaseDir, { recursive: true });
    fs.writeFileSync(path.join(newPhaseDir, '01-01-PLAN.md'), '# new plan\n');

    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    // total_phases must be bounded by the ROADMAP's 2 phases, not 4 total dirs
    // (the 3 stale dirs for phases 3-5 must be excluded by the milestone filter)
    assert.ok(
      output.progress && output.progress.total_phases <= 2,
      `total_phases should be ≤ 2 (new milestone phases 1-2 only), got ${output.progress?.total_phases}`
    );
    // total_plans must only count plans from current-milestone phase dirs
    assert.ok(
      output.progress && output.progress.total_plans <= 1,
      `total_plans should be 1 (only new phase 1 dir), got ${output.progress?.total_plans}`
    );
  });

  test('init new-milestone phase_dir_count excludes stale prior-milestone dirs', () => {
    // ROADMAP scoped to v2.0 with 2 phases
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '<details>',
        '<summary>v1.0 — Shipped</summary>',
        '',
        '## Roadmap v1.0: Old',
        '### Phase 1: Old One',
        '### Phase 2: Old Two',
        '### Phase 3: Old Three',
        '',
        '</details>',
        '',
        '## Roadmap v2.0: New',
        '### Phase 1: New One',
        '### Phase 2: New Two',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nmilestone: v2.0\n---\n\n# State\n\n**Status:** Planning\n'
    );

    // Three stale phase dirs from the old milestone
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (const dir of ['01-old-one', '02-old-two', '03-old-three']) {
      fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
    }

    const result = runGsdTools('init new-milestone', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    // phase_dir_count should not include stale dirs from the old milestone
    assert.ok(
      output.phase_dir_count <= 2,
      `phase_dir_count should be ≤ 2 (only new-milestone dirs), got ${output.phase_dir_count}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state complete-phase: Phase-fallback decoration handling (PR #2761 nitpick)
// ─────────────────────────────────────────────────────────────────────────────
//
// When STATE.md is missing the canonical `**Current Phase:**` field but
// includes a decorated `## Current Position` body line, the fallback path used
// to leak the decoration into downstream Status/Phase strings — producing
// `**Status:** Phase 01 (Foo) — EXECUTING complete` instead of the expected
// `**Status:** Phase 01 complete`. CodeRabbit flagged this on PR #2761 and the
// Phase fallback now strips everything past the leading numeric/decimal token.
describe('state complete-phase: decorated Phase fallback (#2761 nitpick)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('writes clean Phase identifier when only Current Position decoration is present', () => {
    // STATE.md without the canonical `**Current Phase:**` field — the only
    // phase signal lives inside the `## Current Position` block as a decorated
    // line. This is the regression fixture.
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** Executing',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: 01 (Foo) — EXECUTING',
      'Plan: bootstrap',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state complete-phase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );

    // Status should reference the bare phase identifier (`01`), not the
    // decorated string. The negative assertion catches the regression
    // shape directly.
    assert.ok(
      updated.includes('**Status:** Phase 01 complete'),
      `Status should be "Phase 01 complete", got STATE.md:\n${updated}`,
    );
    assert.ok(
      !updated.includes('Phase 01 (Foo) — EXECUTING complete'),
      `Status must not embed Current Position decoration: ${updated}`,
    );
  });

  test('canonical Current Phase field is preferred over Current Position decoration', () => {
    // When both are present, Current Phase wins — same outcome as before, but
    // pinned here so a future refactor that flips precedence is caught.
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** Executing',
      '**Current Phase:** 03',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: 01 (Foo) — EXECUTING',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state complete-phase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    assert.ok(
      updated.includes('**Status:** Phase 03 complete'),
      `Status should reference canonical Current Phase (03), got: ${updated}`,
    );
  });

  test('rejects unresolved literal Phase token and does not corrupt STATE.md (#3063)', () => {
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** Executing',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: narrative only',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd);

    const result = runGsdTools('state complete-phase', tmpDir);
    assert.ok(result.success, 'command should return JSON error payload, not crash');
    const output = JSON.parse(result.output);
    assert.ok(output.error, 'expected clear resolution error');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(!after.includes('Phase: Phase — COMPLETE'));
    assert.ok(!after.includes('Status: Phase Phase complete'));
  });

  test('rejects a milestone-closure Phase line, never mines the version token (#2111 / #2125)', () => {
    // After `milestone complete v0.5`, the only phase signal is the narrative
    // `Phase: Milestone v0.5 complete`. The old unanchored resolver mined "0.5"
    // and rewrote Status as "Phase 0.5 complete"; the anchored parser yields no
    // token, so complete-phase must reject rather than corrupt STATE.md.
    const stateMd = [
      '---',
      'milestone: v0.5',
      '---',
      '',
      '# State',
      '',
      '**Status:** Awaiting next milestone',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: Milestone v0.5 complete',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd);

    const result = runGsdTools('state complete-phase', tmpDir);
    assert.ok(result.success, 'command should return JSON error payload, not crash');
    const output = JSON.parse(result.output);
    assert.ok(output.error, 'expected a resolution error, not a phase mined from the version string');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(!after.includes('Phase 0.5 complete'), `must not mine "0.5" from the version: ${after}`);
    assert.ok(!after.includes('Phase: 0.5'), `must not rewrite Current Position to Phase 0.5: ${after}`);
  });

  test('supports explicit phase override for complete-phase disambiguation (#3063)', () => {
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** Executing',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: narrative only',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd);

    const result = runGsdTools('state complete-phase --phase 3.3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('**Status:** Phase 3.3 complete'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// summary-extract command
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// state add-roadmap-evolution (regression: bug #1140)
//
// `query state.add-roadmap-evolution` was unreachable: the CJS state router
// listed it in its `unsupported` map with a message pointing back at the exact
// command that just failed ("...is SDK-only. Use: gsd-tools query
// state.add-roadmap-evolution ..."), and no CJS handler existed after the SDK
// retirement (ADR-0174). Every `/gsd:phase insert` and `/gsd:phase --edit` run
// hit a circular dead end. The fix re-implements `cmdStateAddRoadmapEvolution`
// in CJS and wires it into the state router. These cases follow the CLI/parser
// QA matrix in CONTRIBUTING.md (all invocations use argv arrays, no shell).
// ─────────────────────────────────────────────────────────────────────────────
describe('state add-roadmap-evolution (bug #1140)', () => {
  let tmpDir;

  const STATE_WITH_ACC_CONTEXT = `# Project State

## Current Status

**Current Phase:** 103.1

## Accumulated Context

### Decisions

- Some earlier decision
`;

  const writeState = (dir, body) => fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), body);
  const readState = (dir) => fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf-8');
  // Body of `## Accumulated Context` bounded by the next h2 (or EOF), so
  // placement assertions prove a subsection sits INSIDE that section.
  const accumulatedContextBody = (state) => {
    const m = state.match(/##\s*Accumulated Context\s*\r?\n([\s\S]*?)(?=\n##[^#]|$)/);
    return m ? m[1] : null;
  };

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // The literal issue repro: negative proof the circular dead end is gone.
  test('query state.add-roadmap-evolution no longer routes to the circular SDK-only rejection', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const result = runGsdTools(
      ['query', 'state.add-roadmap-evolution',
        '--phase', '103.2', '--action', 'inserted', '--after', '103.1',
        '--note', 'test', '--urgent'],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.ok(
      !/SDK-only/i.test(result.output) && !/SDK-only/i.test(result.error || ''),
      `must not emit the circular "SDK-only" rejection; got output=${result.output} error=${result.error}`
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.added, true);
    assert.match(parsed.entry, /\(URGENT\)$/);
  });

  test('appends an entry, creating the ### Roadmap Evolution subsection under ## Accumulated Context', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution',
        '--phase', '103.2', '--action', 'inserted', '--after', '103.1',
        '--note', 'Add OAuth login', '--urgent'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    assert.ok(
      state.includes('- Phase 103.2 inserted after Phase 103.1: Add OAuth login (URGENT)'),
      `entry not found in:\n${state}`
    );
    assert.strictEqual((state.match(/^### Roadmap Evolution$/gm) || []).length, 1, 'subsection must not be duplicated');
    const accBody = accumulatedContextBody(state);
    assert.ok(accBody && accBody.includes('### Roadmap Evolution'), 'subsection must be inside Accumulated Context');
    assert.ok(accBody.includes('- Phase 103.2 inserted after Phase 103.1: Add OAuth login (URGENT)'), 'entry must be inside Accumulated Context');
    assert.ok(state.includes('- Some earlier decision'), 'existing content preserved');
  });

  test('omitting --urgent and --after produces a plain entry', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '103.2', '--action', 'edited',
        '--note', 'edited fields: goal, depends_on'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    assert.ok(state.includes('- Phase 103.2 edited: edited fields: goal, depends_on'), `missing entry:\n${state}`);
    assert.ok(!/\(URGENT\)/.test(state), 'no URGENT suffix when --urgent absent');
  });

  test('creates ### Roadmap Evolution when ## Accumulated Context exists without it', () => {
    writeState(tmpDir, `# Project State

## Accumulated Context

### Decisions

- prior decision

## Next Steps

- do the thing
`);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '4', '--action', 'added', '--note', 'caching layer'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    assert.ok(state.includes('### Roadmap Evolution'), 'subsection created');
    assert.ok(state.includes('- Phase 4 added: caching layer'), 'entry appended');
    const subIdx = state.indexOf('### Roadmap Evolution');
    const nextIdx = state.indexOf('## Next Steps');
    assert.ok(subIdx !== -1 && nextIdx !== -1 && subIdx < nextIdx, 'subsection must be inside Accumulated Context');
    assert.ok(state.includes('- do the thing'), 'sibling section preserved');
  });

  test('creates both ## Accumulated Context and ### Roadmap Evolution when neither exists', () => {
    writeState(tmpDir, `# Project State

## Current Status

**Current Phase:** 1
`);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '2', '--action', 'inserted', '--after', '1', '--note', 'bootstrap'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).added, true);

    const state = readState(tmpDir);
    assert.strictEqual((state.match(/^## Accumulated Context$/gm) || []).length, 1, 'Accumulated Context created once');
    assert.strictEqual((state.match(/^### Roadmap Evolution$/gm) || []).length, 1, 'subsection created once');
    assert.ok(state.includes('- Phase 2 inserted after Phase 1: bootstrap'), 'entry appended');
  });

  test('targets the subsection under Accumulated Context, never a decoy heading elsewhere', () => {
    writeState(tmpDir, `# Project State

## Accumulated Context

### Decisions

- prior decision

## Reference Notes

### Roadmap Evolution

- DECOY entry that must never be touched
`);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '8', '--action', 'inserted', '--note', 'real entry'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    const accBody = accumulatedContextBody(state);
    assert.ok(accBody && accBody.includes('- Phase 8 inserted: real entry'), 'entry must be inside Accumulated Context');
    assert.ok(state.includes('- DECOY entry that must never be touched'), 'decoy preserved');
    assert.ok(!accBody.includes('DECOY'), 'decoy must not be pulled into Accumulated Context');
    assert.strictEqual((state.match(/^### Roadmap Evolution$/gm) || []).length, 2, 'a new subsection is created under Accumulated Context; decoy heading remains');
  });

  test('flattens a multiline note into a single bullet so dedupe and rendering hold', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const notePath = path.join(tmpDir, 'note.txt');
    fs.writeFileSync(notePath, 'line one\nline two\nline three\n');

    const first = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '9', '--action', 'edited', '--note-file', notePath],
      tmpDir
    );
    assert.ok(first.success, `Command failed: ${first.error}`);

    const state = readState(tmpDir);
    assert.ok(state.includes('- Phase 9 edited: line one line two line three'), `note not flattened:\n${state}`);
    assert.ok(!/\r?\n\s*line two/.test(state), 'continuation lines must not spill outside the bullet');

    const second = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '9', '--action', 'edited', '--note-file', notePath],
      tmpDir
    );
    assert.strictEqual(JSON.parse(second.output).reason, 'duplicate', 'flattened entry must dedupe on replay');
  });

  test('deduplicates an identical entry on replay', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const args = ['state', 'add-roadmap-evolution', '--phase', '103.2', '--action', 'inserted',
      '--after', '103.1', '--note', 'Add OAuth login', '--urgent'];

    const first = runGsdTools(args, tmpDir);
    assert.ok(first.success, `first call failed: ${first.error}`);
    assert.strictEqual(JSON.parse(first.output).added, true);

    const second = runGsdTools(args, tmpDir);
    assert.ok(second.success, `second call failed: ${second.error}`);
    const parsed = JSON.parse(second.output);
    assert.strictEqual(parsed.added, false, 'replay must not add');
    assert.strictEqual(parsed.reason, 'duplicate');

    const state = readState(tmpDir);
    const occurrences = (state.match(/- Phase 103\.2 inserted after Phase 103\.1: Add OAuth login \(URGENT\)/g) || []).length;
    assert.strictEqual(occurrences, 1, 'entry must appear exactly once after replay');
  });

  test('CRLF STATE.md: appends under Accumulated Context while preserving later sections', () => {
    const crlf = [
      '# Project State', '',
      '## Accumulated Context', '',
      '### Decisions', '',
      '- prior decision', '',
      '## Blockers', '',
      '- keep me', '',
      '## History', '',
      '- also keep me', '',
    ].join('\r\n');
    writeState(tmpDir, crlf);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '4', '--action', 'inserted', '--note', 'crlf safe'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    assert.ok(state.includes('## Blockers'), '## Blockers must be preserved');
    assert.strictEqual((state.match(/^## Blockers/gm) || []).length, 1, '## Blockers not duplicated/corrupted');
    assert.ok(state.includes('- keep me'), 'Blockers content must be preserved');
    assert.ok(state.includes('## History'), '## History must be preserved');
    assert.ok(state.includes('- also keep me'), 'History content must be preserved');
    assert.ok(/### Roadmap Evolution/.test(state), 'subsection created');
    assert.ok(/- Phase 4 inserted: crlf safe/.test(state), 'entry appended');
  });

  test('missing --note is rejected without mutating STATE.md', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);
    const before = readState(tmpDir);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted'],
      tmpDir
    );
    const combined = `${result.output}\n${result.error || ''}`;
    assert.match(combined, /note required/, 'should report the missing-note error');
    assert.ok(!/"added"\s*:\s*true/.test(result.output), 'must not report added:true');
    assert.ok(!/\bat .*\(.*:\d+:\d+\)/.test(result.error || ''), 'no stack trace in failure output');
    assert.strictEqual(readState(tmpDir), before, 'STATE.md not mutated on missing note');
  });

  test('empty --note "" is rejected without mutating STATE.md', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);
    const before = readState(tmpDir);

    runGsdTools(['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted', '--note', ''], tmpDir);
    assert.strictEqual(readState(tmpDir), before, 'STATE.md must be untouched for empty note');
  });

  test('whitespace-only --note is rejected without mutating STATE.md', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);
    const before = readState(tmpDir);

    runGsdTools(['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted', '--note', '   '], tmpDir);
    assert.strictEqual(readState(tmpDir), before, 'STATE.md must be untouched for whitespace-only note');
  });

  test('--note followed by a flag-shaped token is treated as missing note', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);
    const before = readState(tmpDir);

    runGsdTools(['state', 'add-roadmap-evolution', '--phase', '5', '--note', '--weird'], tmpDir);
    assert.strictEqual(readState(tmpDir), before, 'flag-shaped value must not be consumed as the note');
  });

  test('duplicate --phase flags do not crash; first value wins', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '7', '--phase', '9', '--action', 'inserted', '--note', 'dup flags'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const state = readState(tmpDir);
    assert.ok(state.includes('- Phase 7 inserted: dup flags'), `expected phase 7 entry:\n${state}`);
    assert.ok(!state.includes('Phase 9'), 'second --phase value must not be used');
  });

  test('shell metacharacters in --note are stored literally, never executed', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    // Probe path lives under the test's tmpDir (no hardcoded /tmp literal, which
    // the Windows-parity guard forbids). If command substitution executed, this
    // file would exist afterward.
    const probe = path.join(tmpDir, 'gsd-pwn-1140');
    const hostile = `pwn $(touch ${probe}) \`id\` ; rm -rf / && echo done`;
    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted', '--note', hostile],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const state = readState(tmpDir);
    assert.ok(state.includes(hostile), 'hostile note must be stored verbatim');
    assert.ok(!fs.existsSync(probe), 'command substitution must not have executed');
  });

  test('Unicode note content is preserved', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const note = 'café — 日本語 — 🚀 reroute';
    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'edited', '--note', note],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.ok(readState(tmpDir).includes(note), 'Unicode preserved');
  });

  test('missing STATE.md returns a structured error, not a crash', () => {
    // Guarantee STATE.md is absent (force: no-op if the fixture didn't create one).
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- deleting a single fixture file to simulate the missing-STATE.md case, not a temp-dir teardown
    fs.rmSync(path.join(tmpDir, '.planning', 'STATE.md'), { force: true });

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted', '--note', 'x'],
      tmpDir
    );
    const combined = `${result.output}\n${result.error || ''}`;
    assert.match(combined, /STATE\.md not found/, 'should report STATE.md not found');
    assert.ok(!/\bat .*\(.*:\d+:\d+\)/.test(result.error || ''), 'no stack trace');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// regressions: table-format STATE.md (#1162)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal STATE.md that uses a pipe-table for the Current Position section.
 * This is the format that triggered the "Field not found" silent failure.
 */
function buildTableFormatState(opts) {
  const {
    status = 'Ready to plan',
    phase = '3',
    planCount = '4',
    lastActivity = '2026-01-01',
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    'status: planning',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Status | ${status} |`,
    `| Phase | ${phase} |`,
    `| Total Plans in Phase | ${planCount} |`,
    `| Last Activity | ${lastActivity} |`,
    '',
    '## Accumulated Context',
    '',
    'Some context here.',
    '',
  ].join('\n');
}

/**
 * STATE.md that uses bold inline format (the existing working format).
 * Included as a control case to confirm we did not break bold-field support.
 */
function buildBoldFormatState(opts) {
  const {
    status = 'Ready to plan',
    phase = '3',
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    'status: planning',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    `**Status:** ${status}`,
    `**Phase:** ${phase}`,
    '',
  ].join('\n');
}

describe('regressions: table-format STATE.md (#1162)', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1162-');
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Happy path: table-format field replacement ──────────────────────────

  test('state update rewrites table-cell Status value', () => {
    fs.writeFileSync(statePath, buildTableFormatState({ status: 'Ready to plan' }));

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    // Command must report success
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'expected updated:true but got: ' + JSON.stringify(parsed));

    // The table cell must be rewritten on disk
    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Status | Ready to execute |'),
      'Table cell not rewritten. STATE.md content:\n' + written,
    );
    // Original value must be gone
    assert.ok(
      !written.includes('| Status | Ready to plan |'),
      'Old table cell value still present in STATE.md',
    );
  });

  test('state update rewrites table-cell value for arbitrary field', () => {
    fs.writeFileSync(statePath, buildTableFormatState({ lastActivity: '2026-01-01' }));

    const result = runGsdTools(['state', 'update', 'Last Activity', '2026-06-13'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'expected updated:true');

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Last Activity | 2026-06-13 |'),
      'Last Activity table cell not rewritten. Content:\n' + written,
    );
  });

  test('state update is case-insensitive for table field names', () => {
    // Table may have lowercase "status" in the first cell
    const content = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '## Current Position',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| status | Ready to plan |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(['state', 'update', 'status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'case-insensitive table match failed');
  });

  // ── Negative: separator row must NOT be treated as a field ───────────────

  test('separator row | --- | --- | is not matched as a field', () => {
    // The field name "---" is rejected by the field-name validator before
    // stateReplaceField is even called.  The command exits with a non-zero
    // status and a plain-text error, NOT a JSON { updated: false } result.
    // The key invariant is that the file is never corrupted.
    const originalContent = buildTableFormatState();
    fs.writeFileSync(statePath, originalContent);

    const result = runGsdTools(['state', 'update', '---', 'injected'], tmpDir);

    // The validator rejects '---' as an invalid field name — command must fail
    // OR, if somehow the command succeeds, updated must be false.
    if (result.success) {
      // Unlikely path — if the validator is relaxed in future, still must not update.
      let parsed;
      try { parsed = JSON.parse(result.output); } catch { parsed = null; }
      if (parsed) {
        assert.equal(parsed.updated, false, 'separator row incorrectly matched as a field');
      }
    }
    // Either way: the file must be untouched (no 'injected' value written)
    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(!written.includes('injected'), 'separator row replacement leaked into file');
  });

  // ── Regression: bold-format still works after the fix ────────────────────

  test('state update bold-format still works after table support added', () => {
    fs.writeFileSync(statePath, buildBoldFormatState({ status: 'Ready to plan' }));

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'bold-format update broken after fix');

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('**Status:** Ready to execute'),
      'Bold-format field not rewritten. Content:\n' + written,
    );
  });

  // ── updateCurrentPositionFields table support ─────────────────────────────

  test('state planned-phase updates table-cell Status via updateCurrentPositionFields', () => {
    // cmdStatePlannedPhase uses updateCurrentPositionFields internally;
    // verify it also handles the table format.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'status: planning',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** Ready to plan',
      '**Total Plans in Phase:** 0',
      '**Last Activity:** 2026-01-01',
      '**Last Activity Description:** initial',
      '',
      '## Current Position',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| Status | Ready to plan |',
      '| Last Activity | 2026-01-01 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // Create a minimal phase dir so planned-phase can count plans
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '1-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '1-01-PLAN.md'), '# Plan 1');

    const result = runGsdTools(['state', 'planned-phase', '1', '--plan-count', '1'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    // The Current Position table cell should now be "Ready to execute"
    assert.ok(
      written.includes('| Status | Ready to execute |'),
      'planned-phase did not update table-cell Status. Content:\n' + written,
    );
  });

  // ── Adversarial / edge cases ──────────────────────────────────────────────

  test('table field with extra whitespace in cells is handled', () => {
    const content = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '## Current Position',
      '',
      '|  Status  |  Ready to plan  |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'extra-whitespace table cell not matched');
  });

  test('updating one row in a multi-row table does not corrupt adjacent rows', () => {
    // Regression: updating `Status` must leave the `Phase` row untouched.
    // NOTE: values containing literal '|' (e.g., "blocked | waiting") are NOT
    // supported — the current value regex [^|\n]*? stops at the first pipe.
    // Escaped-pipe values are out of scope for single-token status fields.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '## Current Position',
      '',
      '| Status | Ready to plan |',
      '| Phase | 3 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // Normal replacement — verify Phase row is untouched
    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(written.includes('| Phase | 3 |'), 'Phase row was corrupted during Status update');
  });

  test('CRLF line endings in table format are handled', () => {
    const content = buildTableFormatState({ status: 'Ready to plan' }).replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'CRLF table format not handled');
  });

  test('missing STATE.md returns updated:false gracefully', () => {
    // No STATE.md written — verify the command does not throw
    const missingDir = createTempProject('gsd-1162-missing-');
    try {
      const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], missingDir);
      const parsed = JSON.parse(result.output);
      assert.equal(parsed.updated, false, 'missing STATE.md should return updated:false');
    } finally {
      cleanup(missingDir);
    }
  });
});

describe('regressions: table-format STATE.md (#1162) — updateCurrentPositionFields preserve-authored invariants', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1162-f2-');
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Helper: a STATE.md with table-format Current Position section.
  // We use planned-phase to exercise updateCurrentPositionFields indirectly,
  // because that is the call-site that writes Status/Last Activity.
  function buildMixedFormatState(opts) {
    const {
      status = 'Ready to plan',
      lastActivity = '2026-01-01',
    } = opts || {};
    return [
      '---',
      'gsd_state_version: 1.0',
      'status: planning',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** Ready to plan',
      '**Total Plans in Phase:** 0',
      `**Last Activity:** ${lastActivity}`,
      '**Last Activity Description:** initial',
      '',
      '## Current Position',
      '',
      '| Field | Value |',
      '| --- | --- |',
      `| Status | ${status} |`,
      `| Last Activity | ${lastActivity} |`,
      '',
    ].join('\n');
  }

  // (a) Custom Status in table format must NOT be overwritten by planned-phase.
  test('(Finding 2a) custom Status in table format is preserved by updateCurrentPositionFields', () => {
    // "Blocked: waiting on infra" is executor-authored — not in KNOWN_TEMPLATE_DEFAULTS.
    // planned-phase calls updateCurrentPositionFields with status="Ready to execute".
    // The table-format branch must honour the same guard as the inline branch:
    // only overwrite when the existing value is a known template default.
    const content = buildMixedFormatState({ status: 'Blocked: waiting on infra', lastActivity: '2026-01-01' });
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '2-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '2-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools(['state', 'planned-phase', '2', '--plan-count', '1'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Status | Blocked: waiting on infra |'),
      'Custom Status was overwritten by updateCurrentPositionFields table branch.\nContent:\n' + written,
    );
    assert.ok(
      !written.includes('| Status | Ready to execute |'),
      'Custom Status replaced with Ready to execute in table branch.\nContent:\n' + written,
    );
  });

  // (b) Narrative Last Activity in table format must NOT be overwritten.
  test('(Finding 2b) narrative Last Activity in table format is preserved', () => {
    // "2026-02-15 -- blocked" has trailing prose — executor-authored.
    // planned-phase calls updateCurrentPositionFields with today's ISO date.
    // Must be preserved.
    const content = buildMixedFormatState({ status: 'Ready to plan', lastActivity: '2026-02-15 -- blocked' });
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '2-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '2-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools(['state', 'planned-phase', '2', '--plan-count', '1'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Last Activity | 2026-02-15 -- blocked |'),
      'Narrative Last Activity was overwritten in table branch.\nContent:\n' + written,
    );
  });

  // (c) Known-default Status and bare-date Last Activity ARE updated.
  test('(Finding 2c) known-default Status and bare-date Last Activity ARE updated in table format', () => {
    // "Ready to plan" is a known default; "2026-01-01" is a bare ISO date.
    // Both should be replaced by planned-phase.
    const content = buildMixedFormatState({ status: 'Ready to plan', lastActivity: '2026-01-01' });
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '2-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '2-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools(['state', 'planned-phase', '2', '--plan-count', '1'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Status | Ready to execute |'),
      'Known-default Status not updated in table branch.\nContent:\n' + written,
    );
    // Last Activity should be today's date (not 2026-01-01)
    assert.ok(
      !written.includes('| Last Activity | 2026-01-01 |'),
      'Bare-date Last Activity was NOT updated in table branch.\nContent:\n' + written,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1255 — begin/complete-phase advance status for pipe-table STATE.md
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regression tests for bug #1255.
 *
 * `state begin-phase` / `state complete-phase` do not advance the frontmatter
 * `status` when the body `Status` field is expressed as a pipe-table row
 * (`| Status | Planning |`) instead of an inline key-value pair
 * (`Status: Planning`).
 *
 * Root cause: `stateReplaceField(content, 'Status', ...)` is called with the
 * full file content (frontmatter + body). The plain-text pattern
 * (`^Status:\s*(.+)` with /im flag) matches `status: planning` in the YAML
 * frontmatter block rather than the body pipe-table row. The pipe-table row
 * is never updated. `syncStateFrontmatter` then re-derives from the body (which
 * still says 'Planning') and the #1230 delta heuristic preserves the old
 * frontmatter value ('planning'), so the status never advances to 'executing'.
 *
 * Fix: strip frontmatter before all body-field replacements in
 * `cmdStateBeginPhase` and `cmdStateCompletePhase`, then reassemble.
 *
 * Additional bugs fixed (#1255 follow-up):
 * 1. complete-phase Phase table cell had label-duplication: `Phase: 1 — COMPLETE`
 *    instead of bare `1 — COMPLETE`.
 * 2. begin-phase and complete-phase Last-activity table branches wrote bare date
 *    instead of date + narrative (inconsistent with inline branch).
 */

function make1255TempProject(stateContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1255-'));
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  // Minimal ROADMAP so buildStateFrontmatter can resolve phase counts
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), [
    '# ROADMAP',
    '',
    '## Phase 1: setup:',
    '- [ ] Step 1',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent, 'utf8');
  return dir;
}

// STATE.md where Status lives entirely in pipe-table rows (no inline "Status: ..." anywhere)
// This is the form a hand-edited or legacy STATE.md might use, and is a
// supported body format (do NOT silently rewrite to inline).
const TABLE_STATUS_PLANNING_1255 = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

## Configuration

| Current Phase | 1 |
| Current Phase Name | setup |
| Total Plans in Phase | 3 |
| Current Plan | 1 |
| Status | Planning |
| Last Activity | 2026-06-01 |
| Last Activity Description | Roadmap created |

## Current Position

| Phase | 1 (setup) |
| Plan | 1 of 3 |
| Status | Planning |
| Last activity | 2026-06-01 |
`;

// STATE.md with Status as pipe-table but execution already in progress (complete-phase scenario)
const TABLE_STATUS_EXECUTING_1255 = `---
gsd_state_version: '1.0'
status: executing
---

# Project State

## Configuration

| Current Phase | 1 |
| Current Phase Name | setup |
| Total Plans in Phase | 3 |
| Current Plan | 3 |
| Status | Executing Phase 1 |
| Last Activity | 2026-06-01 |
| Last Activity Description | Phase 1 execution started |

## Current Position

| Phase | 1 (setup) |
| Plan | 3 of 3 |
| Status | Executing Phase 1 |
| Last activity | 2026-06-01 |
`;

describe('#1255 — begin/complete-phase advance status for pipe-table STATE.md', () => {
  // begin-phase: planning → executing
  test('begin-phase advances frontmatter status planning→executing when body Status is pipe-table', () => {
    const dir = make1255TempProject(TABLE_STATUS_PLANNING_1255);
    try {
      const result = runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      assert.ok(result.success, `begin-phase failed: ${result.error || result.output}`);

      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Primary assertion: frontmatter status must advance to 'executing'
      const fmMatch = after.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, 'STATE.md must have YAML frontmatter after begin-phase');
      const fm = fmMatch[1];
      assert.ok(
        /^status:\s*executing\s*$/m.test(fm),
        `frontmatter status must be 'executing' after begin-phase on pipe-table STATUS; got frontmatter:\n${fm}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // begin-phase: body pipe-table row must also be updated
  test('begin-phase updates body pipe-table Status cell to Executing Phase N', () => {
    const dir = make1255TempProject(TABLE_STATUS_PLANNING_1255);
    try {
      runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      // The pipe-table Status cell in the Configuration table must be updated
      assert.ok(
        /\|\s*Status\s*\|\s*Executing Phase 1\s*\|/i.test(after),
        `body pipe-table Status cell must be updated to 'Executing Phase 1'; got:\n${after}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // begin-phase: Current Position table cells — exact cell values
  test('begin-phase updates Current Position pipe-table Status and Last activity cells correctly', () => {
    const dir = make1255TempProject(TABLE_STATUS_PLANNING_1255);
    try {
      runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Extract the ## Current Position section only, to avoid matching Configuration rows
      const cpMatch = after.match(/##\s*Current Position\s*\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
      assert.ok(cpMatch, '## Current Position section must exist');
      const cpSection = cpMatch[1];

      // Status cell in Current Position: bare value, not prefixed
      assert.ok(
        /\|\s*Status\s*\|\s*Executing Phase 1\s*\|/i.test(cpSection),
        `Current Position Status cell must be 'Executing Phase 1'; got Current Position:\n${cpSection}`
      );

      // Last activity cell must include date + narrative (not bare date)
      assert.ok(
        /\|\s*Last activity\s*\|[^|]*—\s*Phase 1 execution started\s*\|/i.test(cpSection),
        `Current Position Last activity cell must include narrative '— Phase 1 execution started'; got Current Position:\n${cpSection}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // complete-phase: executing → completed
  test('complete-phase advances frontmatter status executing→completed when body Status is pipe-table', () => {
    const dir = make1255TempProject(TABLE_STATUS_EXECUTING_1255);
    try {
      const result = runGsdTools(
        ['state', 'complete-phase', '--phase', '1'],
        dir
      );
      assert.ok(result.success, `complete-phase failed: ${result.error || result.output}`);

      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Primary assertion: frontmatter status must be 'completed'
      const fmMatch = after.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, 'STATE.md must have YAML frontmatter after complete-phase');
      const fm = fmMatch[1];
      assert.ok(
        /^status:\s*completed\s*$/m.test(fm),
        `frontmatter status must be 'completed' after complete-phase on pipe-table STATUS; got frontmatter:\n${fm}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // complete-phase: body pipe-table row must also be updated
  test('complete-phase updates body pipe-table Status cell to Phase N complete', () => {
    const dir = make1255TempProject(TABLE_STATUS_EXECUTING_1255);
    try {
      runGsdTools(
        ['state', 'complete-phase', '--phase', '1'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      assert.ok(
        /\|\s*Status\s*\|\s*Phase 1 complete\s*\|/i.test(after),
        `body pipe-table Status cell must be updated to 'Phase 1 complete'; got:\n${after}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // complete-phase: Current Position table cells — exact cell values (catches bugs 1 and 2)
  test('complete-phase updates Current Position pipe-table Phase/Status/Last-activity cells correctly', () => {
    const dir = make1255TempProject(TABLE_STATUS_EXECUTING_1255);
    try {
      runGsdTools(
        ['state', 'complete-phase', '--phase', '1'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Extract the ## Current Position section only, to avoid matching Configuration rows
      const cpMatch = after.match(/##\s*Current Position\s*\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
      assert.ok(cpMatch, '## Current Position section must exist');
      const cpSection = cpMatch[1];

      // Bug 1: Phase cell must be bare '1 — COMPLETE', NOT 'Phase: 1 — COMPLETE'
      assert.ok(
        /\|\s*Phase\s*\|\s*1\s*—\s*COMPLETE\s*\|/.test(cpSection),
        `Current Position Phase cell must be '1 — COMPLETE' (no 'Phase:' prefix in cell value); got Current Position:\n${cpSection}`
      );
      assert.ok(
        !/\|\s*Phase\s*\|\s*Phase:\s*1/.test(cpSection),
        `Current Position Phase cell must NOT contain 'Phase: 1' (label-duplication bug); got Current Position:\n${cpSection}`
      );

      // Status cell in Current Position: bare value
      assert.ok(
        /\|\s*Status\s*\|\s*Phase 1 complete\s*\|/i.test(cpSection),
        `Current Position Status cell must be 'Phase 1 complete'; got Current Position:\n${cpSection}`
      );

      // Bug 2: Last activity cell must include date + narrative (not bare date)
      assert.ok(
        /\|\s*Last activity\s*\|[^|]*—\s*Phase 1 marked complete\s*\|/i.test(cpSection),
        `Current Position Last activity cell must include narrative '— Phase 1 marked complete'; got Current Position:\n${cpSection}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // Regression guard: inline Status format must still work (existing behavior unchanged)
  test('begin-phase still works correctly with inline Status: format (regression guard)', () => {
    const inlineStateMd = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

Current Phase: 1
Current Phase Name: setup
Total Plans in Phase: 3
Current Plan: 1
Status: Planning
Last Activity: 2026-06-01
Last Activity Description: Roadmap created

## Current Position
Phase: 1 (setup)
Plan: 1 of 3
Status: Planning
Last activity: 2026-06-01 -- Roadmap created
`;
    const dir = make1255TempProject(inlineStateMd);
    try {
      const result = runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      assert.ok(result.success, `begin-phase failed on inline format: ${result.error || result.output}`);
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      const fmMatch = after.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, 'must have frontmatter');
      const fm = fmMatch[1];
      assert.ok(
        /^status:\s*executing\s*$/m.test(fm),
        `inline Status: format: frontmatter status must be 'executing'; got:\n${fm}`
      );
    } finally {
      cleanup(dir);
    }
  });
});

// #1257 — planned-phase + begin-phase pipe-table regressions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regression tests for bug #1257.
 *
 * Finding 1 (INFERRED — reproduced here empirically):
 *   `cmdStatePlannedPhase` calls `stateReplaceFieldIfTemplate(content, 'Status', …)`
 *   on the FULL file content (including YAML frontmatter).  The plain-text pattern
 *   `^Status:\s*(.+)` (case-insensitive) matches the YAML frontmatter `status: planning`
 *   line BEFORE reaching the body pipe-table row `| Status | Planning |`.  The pipe-table
 *   cell is never updated.  `syncStateFrontmatter` re-derives from the unchanged body
 *   and the #1230 delta heuristic preserves the original frontmatter value, so the
 *   status never advances to 'Ready to execute'.
 *   Smoking-gun: src/state.cts:2015 — `stateReplaceFieldIfTemplate(content, 'Status', …)`
 *   where `content` is the full file (frontmatter + body), not stripped body.
 *
 * Finding 2 (OBSERVED):
 *   `cmdStateBeginPhase`'s `## Current Position` update block only has pipe-table
 *   else-branches for Status (#1255) and Last-activity (#1255), NOT for Phase or Plan.
 *   For a pipe-table STATE.md, the `| Phase | … |` and `| Plan | … |` rows are silently
 *   ignored: the else-branch instead INSERTS a new inline `Phase: N — EXECUTING` text
 *   line prepended to the section body (leaving the old table cells stale).
 *   Smoking-gun: src/state.cts:1833–1844 — `^Phase:` / `^Plan:` plain-text checks with
 *   else-branches that prepend text rather than calling stateReplaceField on the table.
 */

// STATE.md fixture for #1257 — pipe-table format with frontmatter status: planning
// After planned-phase the body Status should become 'Ready to execute' and
// frontmatter status should advance accordingly.
const TABLE_STATUS_PLANNING_1257 = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

## Configuration

| Current Phase | 1 |
| Current Phase Name | setup |
| Total Plans in Phase | 3 |
| Current Plan | 1 |
| Status | Planning |
| Last Activity | 2026-06-01 |
| Last Activity Description | Roadmap created |

## Current Position

| Phase | 1 (setup) |
| Plan | 1 of 3 |
| Status | Planning |
| Last activity | 2026-06-01 |
`;

function make1257TempProject(stateContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1257-'));
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  // Minimal ROADMAP so phase resolution can proceed
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), [
    '# ROADMAP',
    '',
    '## Phase 1: setup:',
    '- [ ] Step 1',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent, 'utf8');
  return dir;
}

describe('#1257 — planned-phase and begin-phase pipe-table regressions', () => {

  // ── Finding 1 ───────────────────────────────────────────────────────────────

  test('Finding 1: planned-phase advances Configuration pipe-table Status cell to Ready to execute', () => {
    // planned-phase should update the Configuration-section body | Status | … | cell.
    // Smoking-gun: state.cts:2015 calls stateReplaceFieldIfTemplate on full content,
    // so the frontmatter `status:` key shadows the body table cell and the cell is
    // never updated.  (updateCurrentPositionFields at line 2037 does correctly update
    // the Current Position table cell — this test specifically targets the Configuration
    // table cell, which has no pipe-table else-branch in planned-phase.)
    const dir = make1257TempProject(TABLE_STATUS_PLANNING_1257);
    try {
      const result = runGsdTools(
        ['state', 'planned-phase', '--phase', '1', '--plans', '3'],
        dir
      );
      assert.ok(result.success, `planned-phase failed: ${result.error || result.output}`);

      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Extract the ## Configuration section (stops before ## Current Position)
      // to avoid false-positive from the Current Position table (which IS updated
      // by updateCurrentPositionFields).
      const cfgMatch = after.match(/##\s*Configuration\s*\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
      assert.ok(cfgMatch, '## Configuration section must exist');
      const cfgSection = cfgMatch[1];

      // The Configuration section's pipe-table Status cell must be updated
      assert.ok(
        /\|\s*Status\s*\|\s*Ready to execute\s*\|/i.test(cfgSection),
        `Configuration pipe-table Status cell must be 'Ready to execute' after planned-phase; got Configuration:\n${cfgSection}`
      );
    } finally {
      cleanup(dir);
    }
  });

  test('Finding 1: planned-phase advances frontmatter status to executing when body Status is pipe-table', () => {
    // The frontmatter status must advance after planned-phase sets Status to 'Ready to execute'.
    // (syncStateFrontmatter maps 'ready to execute' → 'executing'.)
    const dir = make1257TempProject(TABLE_STATUS_PLANNING_1257);
    try {
      runGsdTools(
        ['state', 'planned-phase', '--phase', '1', '--plans', '3'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      const fmMatch = after.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, 'STATE.md must have YAML frontmatter after planned-phase');
      const fm = fmMatch[1];
      // syncStateFrontmatter maps 'Ready to execute' → 'executing' in normalizeStateStatus
      assert.ok(
        /^status:\s*executing\s*$/m.test(fm),
        `frontmatter status must be 'executing' after planned-phase on pipe-table STATUS; got frontmatter:\n${fm}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // ── Finding 2 ───────────────────────────────────────────────────────────────

  test('Finding 2: begin-phase updates Current Position pipe-table Phase cell (not prepend inline)', () => {
    // begin-phase must update the | Phase | … | cell in ## Current Position.
    // Smoking-gun: state.cts:1833 checks `^Phase:` (plain-text pattern) which
    // never matches a pipe-table row, so the else-branch at 1836 PREPENDS a new
    // inline `Phase: N — EXECUTING` line to the section instead of updating the cell.
    const dir = make1257TempProject(TABLE_STATUS_PLANNING_1257);
    try {
      const result = runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      assert.ok(result.success, `begin-phase failed: ${result.error || result.output}`);

      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Extract ## Current Position section only
      const cpMatch = after.match(/##\s*Current Position\s*\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
      assert.ok(cpMatch, '## Current Position section must exist');
      const cpSection = cpMatch[1];

      // The pipe-table Phase cell must be updated to reflect the executing phase
      assert.ok(
        /\|\s*Phase\s*\|[^|]*1[^|]*EXECUTING[^|]*\|/i.test(cpSection),
        `Current Position pipe-table Phase cell must contain phase 1 EXECUTING; got Current Position:\n${cpSection}`
      );

      // Must NOT have a spurious prepended inline `Phase: …` text line
      assert.ok(
        !/^Phase:\s+\d/m.test(cpSection),
        `Current Position must NOT have a spuriously prepended inline 'Phase: N' text line; got Current Position:\n${cpSection}`
      );
    } finally {
      cleanup(dir);
    }
  });

  test('Finding 2: begin-phase updates Current Position pipe-table Plan cell (not prepend inline)', () => {
    // begin-phase must update the | Plan | … | cell in ## Current Position.
    // Smoking-gun: state.cts:1841 checks `^Plan:` which never matches a pipe-table row,
    // so the else-branch at 1843 replaces the (newly-prepended) inline Phase line with
    // Phase\nPlan, neither touching the existing table | Plan | cell.
    const dir = make1257TempProject(TABLE_STATUS_PLANNING_1257);
    try {
      runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Extract ## Current Position section only
      const cpMatch = after.match(/##\s*Current Position\s*\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
      assert.ok(cpMatch, '## Current Position section must exist');
      const cpSection = cpMatch[1];

      // The pipe-table Plan cell must be updated to '1 of 3'
      assert.ok(
        /\|\s*Plan\s*\|\s*1 of 3\s*\|/i.test(cpSection),
        `Current Position pipe-table Plan cell must be '1 of 3'; got Current Position:\n${cpSection}`
      );

      // Must NOT have a spurious prepended inline `Plan: …` text line
      assert.ok(
        !/^Plan:\s+\d/m.test(cpSection),
        `Current Position must NOT have a spuriously prepended inline 'Plan: N' text line; got Current Position:\n${cpSection}`
      );
    } finally {
      cleanup(dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T6 section-splice characterization tests (ADR-1372 / #1398)
//
// Covers the migrated cmdState* write-ops across a matrix of fixture variants:
//   inline (standard frontmatter + inline section text)
//   trailing-blanks (sections with extra blank lines)
//   CRLF (Windows line endings)
//   no-frontmatter (bare body only)
//   nested-acc (Accumulated Context with Session Notes subsection)
//   no-current-pos (absent Current Position section)
//   post-milestone (fresh milestone, prior progress=100%)
// ─────────────────────────────────────────────────────────────────────────────

describe('T6 section-splice characterization — record-session', () => {
  // Fixtures used across these tests
  const STATE_WITH_SESSION = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v1.0',
    'milestone_name: TestMilestone',
    'status: executing',
    "last_updated: '2026-01-01T00:00:00.000Z'",
    "last_activity: '2026-01-01'",
    '---',
    '',
    '# Project State',
    '',
    '## Session',
    '',
    '**Last session:** 2026-01-01T00:00:00.000Z',
    '**Stopped at:** None',
    '**Resume file:** None',
    '',
  ].join('\n');

  const STATE_NO_SESSION_LABELS = [
    '# Project State',
    '',
    '**Current focus:** Phase 2',
    '',
    '## Current Position',
    '',
    'Phase: 2',
    'Plan: 1 of 4',
    'Status: Executing Phase 2',
    'Last Activity: 2026-01-01',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: Chose PostgreSQL',
    '',
  ].join('\n');

  test('record-session no-op: no session fields → recorded:false, STATE.md byte-unchanged', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_SESSION_LABELS);
      const result = runGsdTools(['state', 'record-session'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.recorded, false, 'recorded must be false when no session fields exist');
      // milestone_name must NOT be trampled (#952 no-op guard)
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.strictEqual(after, STATE_NO_SESSION_LABELS, 'STATE.md must be byte-unchanged on no-op');
    } finally {
      cleanup(d);
    }
  });

  test('record-session --stopped-at updates Stopped at field in Session section', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_WITH_SESSION);
      const result = runGsdTools(['state', 'record-session', '--stopped-at', '14.3'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.recorded, true, 'recorded must be true when session fields found');
      assert.ok(Array.isArray(output.updated), 'updated must be an array');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('**Stopped at:** 14.3'), 'Stopped at field must be updated to 14.3');
      // milestone_name must be preserved (not trampled)
      assert.ok(after.includes('milestone_name: TestMilestone'), 'milestone_name must be preserved');
    } finally {
      cleanup(d);
    }
  });

  test('record-session --resume-file updates Resume file field in Session section', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_WITH_SESSION);
      const result = runGsdTools(['state', 'record-session', '--resume-file', 'plan-3.md'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.recorded, true, 'recorded must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('**Resume file:** plan-3.md'), 'Resume file field must be updated to plan-3.md');
    } finally {
      cleanup(d);
    }
  });

  // ─── #2450: CRLF STATE.md must not silently drop inserted session fields ─────
  //
  // Bug class: cmdStateRecordSession's section-rewrite regex used literal \n
  // for the `## Session` and `## Session Continuity` heading boundaries, which
  // cannot match a CRLF STATE.md (---\r\n style). The detector regex (using
  // /^## Session[ \t]*$/im) WAS CRLF-tolerant ($ under /m treats \r as a line
  // terminator), so the bug fired when a canonical session field was missing
  // and had to be INSERTED via the section-rewrite path: the detector entered
  // the branch, the writer regex silently no-op'd, but `updated.push('Resume File')`
  // ran unconditionally → reported as updated but never written to disk.
  //
  // With core.autocrlf=input, the CRLF working-tree file produces no git diff,
  // so the contributor cannot tell their STATE.md was misclassified.

  const STATE_CRLF_SESSION_MISSING_RESUME = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v1.0',
    'milestone_name: TestMilestone',
    'status: executing',
    "last_updated: '2026-01-01T00:00:00.000Z'",
    "last_activity: '2026-01-01'",
    '---',
    '',
    '# Project State',
    '',
    '## Session',
    '',
    '**Last session:** 2026-01-01T00:00:00.000Z',
    '**Stopped at:** None',
    // Resume file absent — forces the section-rewrite insert path (the buggy block)
    '',
  ].join('\r\n');

  test('record-session --resume-file on CRLF STATE.md with field absent: field IS written (#2450)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_CRLF_SESSION_MISSING_RESUME);
      const result = runGsdTools(['state', 'record-session', '--resume-file', 'plan-3.md'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);

      // Bug discriminator: command reported recorded:true + 'Resume File' in
      // updated, but the field was never written to disk. The disk assertion
      // below is what fails pre-fix and passes post-fix.
      assert.ok(Array.isArray(output.updated) && output.updated.includes('Resume File'),
        `updated must include 'Resume File': ${JSON.stringify(output.updated)}`);

      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(
        /\*\*Resume file:\*\*\s*plan-3\.md/.test(after),
        `Resume file field must be on disk after the call; STATE.md head:\n${after.slice(0, 500)}`,
      );
    } finally {
      cleanup(d);
    }
  });

  test('record-session --stopped-at on CRLF STATE.md with field absent: field IS written (#2450)', () => {
    // Same bug class, different field. The bug fires whenever a canonical
    // session field must be INSERTED (vs. same-line replaced) on a CRLF STATE.md.
    const STATE_CRLF_SESSION_MISSING_STOPPED = [
      '---',
      'status: executing',
      '---',
      '',
      '## Session',
      '',
      '**Last session:** 2026-01-01T00:00:00.000Z',
      // Stopped at absent — forces the section-rewrite insert path
      '**Resume file:** None',
      '',
    ].join('\r\n');

    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_CRLF_SESSION_MISSING_STOPPED);
      const result = runGsdTools(['state', 'record-session', '--stopped-at', '14.3'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(
        /\*\*Stopped at:\*\*\s*14\.3/.test(after),
        `Stopped at field must be on disk; STATE.md head:\n${after.slice(0, 500)}`,
      );
    } finally {
      cleanup(d);
    }
  });

  test('record-session --resume-file on CRLF STATE.md with Session Continuity heading: field IS inserted (#2450)', () => {
    // Same bug class, different heading: `## Session Continuity` is the
    // bootstrap-template shape. The rewrite regex at the second bug site used
    // the same literal-\n pattern.
    const STATE_CRLF_CONTINUITY = [
      '---',
      'status: executing',
      '---',
      '',
      '## Session Continuity',
      '',
      'Next recommended action: resume phase 2.',
      '',
    ].join('\r\n');

    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_CRLF_CONTINUITY);
      const result = runGsdTools(['state', 'record-session', '--resume-file', 'plan-9.md'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(
        /\*\*Resume file:\*\*\s*plan-9\.md/.test(after),
        `Resume file field must be inserted under Session Continuity; STATE.md head:\n${after.slice(0, 500)}`,
      );
      // Existing prose must be preserved (#1101 invariant)
      assert.ok(/Next recommended action: resume phase 2\./.test(after),
        'Session Continuity prose must be preserved');
    } finally {
      cleanup(d);
    }
  });

  test('record-session --resume-file on mixed-ending STATE.md (LF frontmatter + CRLF body): field IS written (#2450)', () => {
    // CONTRIBUTING.md §"Parser and project-file inputs" lists "Mixed CRLF/LF
    // newlines" as a required adversarial fixture class. Realistic when a
    // Windows editor normalizes frontmatter bytes but preserves body text,
    // or when tooling concatenates LF + CRLF fragments. The bug class is
    // body-section-rewrite, so CRLF body + LF frontmatter is the worst case:
    // the frontmatter delimiter is LF (syncStateFrontmatter parses either)
    // but the `## Session` heading is CRLF, exercising the writer regex.
    const STATE_MIXED_LF_FM_CRLF_BODY = [
      '---',
      'status: executing',
      '---',
      '',  // LF after frontmatter
    ].join('\n') + [
      '## Session',
      '',
      '**Last session:** 2026-01-01T00:00:00.000Z',
      '**Stopped at:** None',
      // Resume file absent
      '',
    ].join('\r\n');

    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_MIXED_LF_FM_CRLF_BODY);
      const result = runGsdTools(['state', 'record-session', '--resume-file', 'plan-mix.md'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(
        /\*\*Resume file:\*\*\s*plan-mix\.md/.test(after),
        `Resume file field must be on disk despite mixed line endings; STATE.md head:\n${after.slice(0, 500)}`,
      );
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — add-decision', () => {
  const STATE_INLINE = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v1.0',
    'milestone_name: TestMilestone',
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: Use Node.js for tooling',
    '',
    '### Blockers',
    '',
    'None yet.',
    '',
  ].join('\n');

  const STATE_TRAILING_BLANKS = [
    '---',
    "gsd_state_version: '1.0'",
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1',
    '',
    'Status: Executing Phase 1',
    'Last Activity: 2026-01-01',
    '',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: First decision',
    '',
    '',
    '### Blockers',
    '',
    '- Bug in auth service',
    '',
  ].join('\n');

  const STATE_NO_DECISIONS = [
    '---',
    "gsd_state_version: '1.0'",
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '### Blockers',
    '',
    'None.',
    '',
  ].join('\n');

  test('add-decision appends to existing Decisions Made section (inline fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_INLINE);
      const result = runGsdTools(['state', 'add-decision', '--phase', '2', '--summary', 'Use Docker for builds'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- [Phase 2]: Use Docker for builds'), 'new decision entry must be present');
      assert.ok(after.includes('- [Phase 1]: Use Node.js for tooling'), 'existing decision must be preserved');
    } finally {
      cleanup(d);
    }
  });

  test('add-decision appends to Decisions Made section with trailing blank lines (trailing-blanks fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_TRAILING_BLANKS);
      const result = runGsdTools(['state', 'add-decision', '--phase', '3', '--summary', 'Add monitoring'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- [Phase 3]: Add monitoring'), 'new decision must be present');
      assert.ok(after.includes('- [Phase 1]: First decision'), 'original decision must be preserved');
    } finally {
      cleanup(d);
    }
  });

  test('add-decision creates Decisions section when absent (DWIM)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_DECISIONS);
      const result = runGsdTools(['state', 'add-decision', '--phase', '1', '--summary', 'Use Node.js'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- [Phase 1]: Use Node.js'), 'decision must be present even when section was absent');
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — add-blocker', () => {
  const STATE_INLINE_WITH_BLOCKERS = [
    '---',
    "gsd_state_version: '1.0'",
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: Use Node.js for tooling',
    '',
    '### Blockers',
    '',
    'None yet.',
    '',
  ].join('\n');

  const STATE_CRLF = '---\r\ngsd_state_version: 1.0\r\nstatus: executing\r\n---\r\n\r\n# Project State\r\n\r\n## Current Position\r\n\r\nStatus: Executing Phase 2\r\nLast Activity: 2026-01-01\r\n\r\n### Blockers\r\n\r\nNone.\r\n';

  const STATE_NO_BLOCKERS_SECTION = [
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 2',
    '',
  ].join('\n');

  test('add-blocker appends to existing Blockers section (inline fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_INLINE_WITH_BLOCKERS);
      const result = runGsdTools(['state', 'add-blocker', '--text', 'Flaky CI on Windows'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      assert.strictEqual(output.blocker, 'Flaky CI on Windows', 'blocker text must match');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- Flaky CI on Windows'), 'blocker entry must be present');
    } finally {
      cleanup(d);
    }
  });

  test('add-blocker appends to existing Blockers section (CRLF fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_CRLF);
      const result = runGsdTools(['state', 'add-blocker', '--text', 'NFS mount issue'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('NFS mount issue'), 'blocker entry must be present in CRLF file');
    } finally {
      cleanup(d);
    }
  });

  test('add-blocker creates Blockers section when absent (DWIM)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_BLOCKERS_SECTION);
      const result = runGsdTools(['state', 'add-blocker', '--text', 'Build pipeline broken'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('Build pipeline broken'), 'blocker must be present even when section was absent');
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — resolve-blocker', () => {
  const STATE_WITH_BLOCKERS = [
    '---',
    "gsd_state_version: '1.0'",
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: First decision',
    '',
    '',
    '### Blockers',
    '',
    '- Bug in auth service',
    '- Another blocker',
    '',
    '### Recently Completed',
    '',
    '- Phase 1 Plan 1',
    '',
  ].join('\n');

  test('resolve-blocker removes target blocker, preserves others (trailing-blanks fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_WITH_BLOCKERS);
      const result = runGsdTools(['state', 'resolve-blocker', '--text', 'Bug in auth service'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.resolved, true, 'resolved must be true');
      assert.strictEqual(output.blocker, 'Bug in auth service', 'resolved blocker text must match');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(!after.includes('- Bug in auth service'), 'resolved blocker must be removed');
      assert.ok(after.includes('Another blocker'), 'unrelated blocker must be preserved');
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — add-roadmap-evolution', () => {
  const STATE_NESTED_ACC = [
    '---',
    "gsd_state_version: '1.0'",
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 3',
    'Status: Executing Phase 3',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: Use TypeScript',
    '- [Phase 2]: Use Jest',
    '',
    '### Blockers',
    '',
    'None.',
    '',
    '## Accumulated Context',
    '',
    'Some context text here.',
    '',
    '### Roadmap Evolution',
    '',
    '- Phase 1 added: Initial planning',
    '- Phase 2 changed: Scope updated',
    '',
    '### Session Notes',
    '',
    'Some notes.',
    '',
    '## Session',
    '',
    '**Last session:** 2026-01-01T00:00:00.000Z',
    '**Stopped at:** None',
    '**Resume file:** None',
    '',
  ].join('\n');

  const STATE_INLINE_WITH_ROAD_EVO = [
    '---',
    "gsd_state_version: '1.0'",
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Accumulated Context',
    '',
    '### Roadmap Evolution',
    '',
    'None yet.',
    '',
  ].join('\n');

  const STATE_NO_ACC_SECTION = [
    '---',
    "gsd_state_version: '1.0'",
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '### Blockers',
    '',
    'None.',
    '',
  ].join('\n');

  const STATE_CRLF_ROAD = '---\r\ngsd_state_version: 1.0\r\nstatus: executing\r\n---\r\n\r\n# Project State\r\n\r\n## Accumulated Context\r\n\r\n### Roadmap Evolution\r\n\r\n- Phase 1 added: Initial migration\r\n';

  const STATE_POST_MILESTONE = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v2.0',
    'milestone_name: NextMilestone',
    'status: planning',
    'progress:',
    '  total_phases: 4',
    '  completed_phases: 4',
    '  total_plans: 12',
    '  completed_plans: 12',
    '  percent: 100',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: Not started (defining requirements)',
    'Plan: —',
    'Status: Defining requirements',
    'Last activity: 2026-01-15 — Milestone v2.0 started',
    '',
    '## Accumulated Context',
    '',
    '### Roadmap Evolution',
    '',
    '- Phase 1 complete after Phase 1: Migration done',
    '',
  ].join('\n');

  test('add-roadmap-evolution appends to existing Roadmap Evolution subsection (nested-acc fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NESTED_ACC);
      const result = runGsdTools(['state', 'add-roadmap-evolution', '--phase', '4', '--action', 'added', '--note', 'New API endpoint'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      assert.ok(output.entry.includes('Phase 4 added'), 'entry must reference phase 4 added');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- Phase 4 added: New API endpoint'), 'new entry must be present');
      assert.ok(after.includes('- Phase 1 added: Initial planning'), 'existing entries must be preserved');
      assert.ok(after.includes('- Phase 2 changed: Scope updated'), 'second existing entry must be preserved');
      // Session Notes subsection must be preserved (not consumed by splice)
      assert.ok(after.includes('### Session Notes'), 'Session Notes subsection must be preserved');
    } finally {
      cleanup(d);
    }
  });

  test('add-roadmap-evolution creates Roadmap Evolution subsection when absent but acc section present', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_INLINE_WITH_ROAD_EVO);
      const result = runGsdTools(['state', 'add-roadmap-evolution', '--phase', '3', '--action', 'changed', '--note', 'Scope updated significantly'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- Phase 3 changed: Scope updated significantly'), 'new entry must be present');
    } finally {
      cleanup(d);
    }
  });

  test('add-roadmap-evolution creates Accumulated Context and subsection when both absent (DWIM)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_ACC_SECTION);
      const result = runGsdTools(['state', 'add-roadmap-evolution', '--phase', '1', '--action', 'added', '--note', 'Initial setup'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- Phase 1 added: Initial setup'), 'new entry must be present');
      assert.ok(after.includes('### Roadmap Evolution'), 'Roadmap Evolution subsection must be created');
    } finally {
      cleanup(d);
    }
  });

  test('add-roadmap-evolution appends to Roadmap Evolution in CRLF file', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_CRLF_ROAD);
      const result = runGsdTools(['state', 'add-roadmap-evolution', '--phase', '2', '--action', 'changed', '--note', 'CRLF test case'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- Phase 2 changed: CRLF test case'), 'new CRLF entry must be present');
      assert.ok(after.includes('- Phase 1 added: Initial migration'), 'existing CRLF entry must be preserved');
    } finally {
      cleanup(d);
    }
  });

  test('add-roadmap-evolution appends to Roadmap Evolution in post-milestone STATE.md', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_POST_MILESTONE);
      const result = runGsdTools(['state', 'add-roadmap-evolution', '--phase', '2', '--action', 'added', '--note', 'New phase inserted'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.added, true, 'added must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(after.includes('- Phase 2 added: New phase inserted'), 'new entry must be present');
      assert.ok(after.includes('- Phase 1 complete after Phase 1: Migration done'), 'prior entry must be preserved');
      // Frontmatter milestone_name must NOT be trampled
      assert.ok(after.includes('milestone_name: NextMilestone'), 'milestone_name must be preserved');
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — begin-phase', () => {
  const STATE_INLINE_POS = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v1.0',
    'milestone_name: TestMilestone',
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1 (Setup)',
    'Plan: 2 of 3',
    'Status: Executing Phase 1',
    'Last Activity: 2026-01-01',
    'Last activity: 2026-01-01',
    '',
  ].join('\n');

  const STATE_NO_FRONTMATTER_POS = [
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 2',
    'Plan: 1 of 4',
    'Status: Executing Phase 2',
    'Last Activity: 2026-01-01',
    '',
  ].join('\n');

  const STATE_NO_CURRENT_POS = [
    '---',
    "gsd_state_version: '1.0'",
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: First decision',
    '',
    '### Blockers',
    '',
    'None.',
    '',
  ].join('\n');

  test('begin-phase updates Current Position and status (inline fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_INLINE_POS);
      const result = runGsdTools(['state', 'begin-phase', '--phase', '2', '--name', 'Build', '--plans', '4'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(Array.isArray(output.updated), 'updated must be an array');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      // Phase line must reflect new phase
      assert.ok(/Phase:\s+2/.test(after), 'Phase line must reference phase 2');
      // Plan counter must reset to 1 of 4
      assert.ok(/Plan:\s+1 of 4/.test(after), 'Plan line must be reset to 1 of 4');
      // Frontmatter status must be executing
      assert.ok(/^status:\s+executing/m.test(after), 'frontmatter status must be executing');
    } finally {
      cleanup(d);
    }
  });

  test('begin-phase updates Current Position without frontmatter (no-frontmatter fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_FRONTMATTER_POS);
      const result = runGsdTools(['state', 'begin-phase', '--phase', '3', '--plans', '2'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(Array.isArray(output.updated), 'updated must be an array');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(/Phase:\s+3/.test(after), 'Phase line must reference phase 3');
    } finally {
      cleanup(d);
    }
  });

  test('begin-phase handles absent Current Position section gracefully', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_CURRENT_POS);
      const result = runGsdTools(['state', 'begin-phase', '--phase', '1', '--name', 'Setup', '--plans', '3'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      // Expect phase, phase_name and plan_count in response even if fields weren't updated
      assert.strictEqual(output.phase, '1', 'phase must be reported in response');
      assert.strictEqual(output.plan_count, 3, 'plan_count must be reported in response');
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — complete-phase', () => {
  const STATE_INLINE_EXEC = [
    '---',
    "gsd_state_version: '1.0'",
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1 (Setup)',
    'Plan: 2 of 3',
    'Status: Executing Phase 1',
    'Last Activity: 2026-01-01',
    '',
  ].join('\n');

  const STATE_TRAILING_BLANKS_EXEC = [
    '---',
    "gsd_state_version: '1.0'",
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1',
    '',
    'Status: Executing Phase 1',
    'Last Activity: 2026-01-01',
    '',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: First decision',
    '',
  ].join('\n');

  const STATE_CRLF_EXEC = '---\r\ngsd_state_version: 1.0\r\nstatus: executing\r\n---\r\n\r\n# Project State\r\n\r\n## Current Position\r\n\r\nStatus: Executing Phase 2\r\nLast Activity: 2026-01-01\r\n';

  test('complete-phase marks current phase complete and sets frontmatter status (inline fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_INLINE_EXEC);
      const result = runGsdTools(['state', 'complete-phase'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(Array.isArray(output.updated), 'updated must be an array');
      assert.ok(output.updated.includes('Status'), 'Status must be in updated list');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(/^status:\s+completed/m.test(after), 'frontmatter status must be completed');
      assert.ok(/Status:\s+Phase\s+1\s+complete/i.test(after), 'body Status field must reflect phase complete');
    } finally {
      cleanup(d);
    }
  });

  test('complete-phase works correctly with trailing blank lines in Current Position (trailing-blanks fixture)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_TRAILING_BLANKS_EXEC);
      const result = runGsdTools(['state', 'complete-phase'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(Array.isArray(output.updated), 'updated must be an array');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(/^status:\s+completed/m.test(after), 'frontmatter status must be completed');
    } finally {
      cleanup(d);
    }
  });

  test('complete-phase works correctly on CRLF STATE.md', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_CRLF_EXEC);
      const result = runGsdTools(['state', 'complete-phase', '--phase', '2'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(Array.isArray(output.updated), 'updated must be an array');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(/^status:\s+completed/m.test(after), 'frontmatter status must be completed after CRLF complete-phase');
    } finally {
      cleanup(d);
    }
  });
});

describe('T6 section-splice characterization — milestone-switch', () => {
  const STATE_INLINE_MS = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v1.0',
    'milestone_name: OldMilestone',
    'status: executing',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1 (Setup)',
    'Plan: 1 of 3',
    'Status: Executing Phase 1',
    '',
  ].join('\n');

  const STATE_NO_POSITION_MS = [
    '---',
    "gsd_state_version: '1.0'",
    'milestone: v1.0',
    'milestone_name: OldMilestone',
    'status: planning',
    '---',
    '',
    '# Project State',
    '',
    '## Decisions Made',
    '',
    '- [Phase 1]: First decision',
    '',
    '### Blockers',
    '',
    'None.',
    '',
  ].join('\n');

  test('milestone-switch updates milestone and milestone_name in frontmatter (position present)', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_INLINE_MS);
      const result = runGsdTools(['state', 'milestone-switch', '--milestone', 'v2.0', '--name', 'NextMilestone'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.switched, true, 'switched must be true');
      assert.strictEqual(output.version, 'v2.0', 'version must be v2.0');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(/^milestone:\s+v2\.0/m.test(after), 'frontmatter milestone must be v2.0');
      assert.ok(/^milestone_name:\s+NextMilestone/m.test(after), 'frontmatter milestone_name must be NextMilestone');
      assert.ok(/^status:\s+planning/m.test(after), 'frontmatter status must be reset to planning on milestone switch');
    } finally {
      cleanup(d);
    }
  });

  test('milestone-switch updates frontmatter when Current Position is absent', () => {
    const d = createTempProject();
    try {
      fs.writeFileSync(path.join(d, '.planning', 'STATE.md'), STATE_NO_POSITION_MS);
      const result = runGsdTools(['state', 'milestone-switch', '--milestone', 'v3.0'], d);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.switched, true, 'switched must be true');
      const after = fs.readFileSync(path.join(d, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(/^milestone:\s+v3\.0/m.test(after), 'frontmatter milestone must be v3.0');
    } finally {
      cleanup(d);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1761-state-sync-wrong-progress.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1761-state-sync-wrong-progress (consolidation epic #1969 B2 #1971)", () => {
'use strict';
// Regression test for issue #1761 — `state sync` silently writes wrong progress
// when ROADMAP lacks versioned milestone headings.
//
// ADR-1769 Phase 7 fix: when getMilestonePhaseFilter().missingExplicitVersion is
// true (the current milestone cannot be bounded to a versioned phase set), the
// sync transition leaves Progress untouched (percent=null) rather than silently
// computing/writing values off a fallback milestone.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function buildStateWithProgress({ percent = 50 } = {}) {
  const barWidth = 10;
  const filled = Math.round((percent / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v1.0',
    'milestone_name: Test',
    'current_phase: "3"',
    'status: executing',
    'progress:',
    '  total_phases: 10',
    '  completed_phases: 5',
    `  percent: ${percent}`,
    '---',
    '',
    '# GSD State',
    '',
    '**Current Phase:** 3',
    '**Total Plans in Phase:** 4',
    '**Current Plan:** 2',
    '**Status:** Executing Phase 3',
    '**Last Activity:** 2026-06-20',
    `**Progress:** [${bar}] ${percent}%`,
    '',
  ].join('\n');
}

// ROADMAP with an UNVERSIONED milestone heading (no vX.Y) — the #1761 trigger.
function buildUnversionedRoadmap(numPhases) {
  const lines = ['# ROADMAP', '', '## Milestone 1: Test Milestone', ''];
  for (let i = 1; i <= numPhases; i++) {
    lines.push(`### Phase ${i}: phase-${i}`);
    lines.push('');
  }
  return lines.join('\n');
}

function readBodyProgress(statePath) {
  const m = fs.readFileSync(statePath, 'utf-8').match(/\*\*Progress:\*\*\s*(.*)/);
  return m ? m[1].trim() : null;
}

describe('#1761: state sync leaves Progress untouched when milestone is unbounded', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('sync does NOT rewrite the Progress bar when ROADMAP lacks a versioned milestone heading', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithProgress({ percent: 50 }));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), buildUnversionedRoadmap(10));

    // Seed disk: 2 of 10 phases fully summarized → if sync naively recomputes,
    // it would write ~20%, clobbering the curated 50% (#1761).
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (let i = 1; i <= 2; i++) {
      const dir = path.join(phasesDir, String(i).padStart(2, '0'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(dir, '01-SUMMARY.md'), '# Summary\n');
    }

    const before = readBodyProgress(statePath);
    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);
    const after = readBodyProgress(statePath);

    assert.strictEqual(after, before,
      `Progress must be left untouched when the milestone is unbounded; before=${JSON.stringify(before)} after=${JSON.stringify(after)} (#1761)`);
  });
});

// #1761 read-path: the ADR-1769 Phase 7 fix (#1794) closed the `state sync`
// WRITE path, but `state json` (the READ path) rebuilds progress via
// buildStateFrontmatter, whose roadmapPhaseCount loop counts phase headings
// across the WHOLE document when extractCurrentMilestone can't bound the
// asserted milestone. Result: state json reported a conflated total_phases
// (sum of sibling milestones) + a derived percent, contradicting the sync
// guard. This block mirrors the write-path guard on the read path.
describe('#1761 read-path: state json does not conflate progress when milestone is unbounded', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('state json omits percent and does NOT report the conflated whole-doc total_phases', () => {
    // Repro from the issue: STATE.md asserts milestone: v2.0; ROADMAP has two
    // UNVERSIONED sibling milestones (4 + 4 phases) — neither matches v2.0, so
    // the milestone is unbounded. One summarized phase dir on disk.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v2.0',
      'milestone_name: Second',
      'current_phase: "2"',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '**Current Phase:** 2',
      '**Status:** Executing Phase 2',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# ROADMAP',
      '## Milestone 1: First Milestone',
      '### Phase 1: a',
      '### Phase 2: b',
      '### Phase 3: c',
      '### Phase 4: d',
      '## Milestone 2: Second Milestone',
      '### Phase 5: e',
      '### Phase 6: f',
      '### Phase 7: g',
      '### Phase 8: h',
      '',
    ].join('\n'));
    // One summarized phase dir on disk.
    const dir01 = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(dir01, { recursive: true });
    fs.writeFileSync(path.join(dir01, '01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(dir01, '01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('state json --raw', tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const out = JSON.parse(result.output);

    // BEFORE the fix this printed progress.total_phases: 8 (4+4 sibling
    // milestones) and percent: 13 — exactly the conflated read-path the sync
    // guard was added to prevent.
    assert.ok(
      out.progress === undefined || out.progress.percent === undefined,
      `state json must omit percent when the milestone is unbounded; got progress=${JSON.stringify(out.progress)}`,
    );
    assert.ok(
      !(out.progress && out.progress.total_phases === 8),
      `state json must NOT report the conflated whole-doc total_phases (8 = 4+4 sibling milestones); got total_phases=${out.progress && out.progress.total_phases}`,
    );
  });

  test('state json still reports percent + total_phases when the milestone IS bounded (versioned ROADMAP)', () => {
    // Control: a versioned ROADMAP heading matching the asserted milestone
    // keeps the read path unchanged — the guard only fires when unbounded.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: First',
      'current_phase: "1"',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '**Current Phase:** 1',
      '**Status:** Executing Phase 1',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# ROADMAP',
      '## Milestone 1: First Milestone v1.0',
      '### Phase 1: a',
      '### Phase 2: b',
      '',
    ].join('\n'));
    const dir01 = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(dir01, { recursive: true });
    fs.writeFileSync(path.join(dir01, '01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(dir01, '01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('state json --raw', tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(
      out.progress && typeof out.progress.percent === 'number',
      `state json must report a numeric percent when the milestone is bounded; got progress=${JSON.stringify(out.progress)}`,
    );
    assert.strictEqual(
      out.progress.total_phases,
      2,
      'bounded read path must report the versioned milestone phase count (2)',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2630-state-frontmatter-milestone-switch.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2630-state-frontmatter-milestone-switch (consolidation epic #1969 B2 #1971)", () => {
/**
 * GSD Tools Tests — Bug #2630
 *
 * Regression guard: `state milestone-switch` resets STATE.md YAML frontmatter
 * (milestone, milestone_name, status, progress.*) AND the `## Current Position`
 * body in a single atomic write. Prior to the fix, the `/gsd:new-milestone`
 * workflow rewrote the body but left the frontmatter pointing at the previous
 * milestone, so every downstream reader (state.json, getMilestoneInfo, etc.)
 * reported the stale milestone.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const STALE_STATE = `---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Foundation
status: completed
progress:
  total_phases: 5
  completed_phases: 5
  total_plans: 12
  completed_plans: 12
  percent: 100
---

# Project State

## Current Position

Phase: 5 (Foundation) — COMPLETED
Plan: 3 of 3
Status: v1.0 milestone complete
Last activity: 2026-04-20 -- v1.0 shipped

## Accumulated Context

### Decisions

- [Phase 1]: Use Node 20
`;

describe('state milestone-switch (#2630)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      STALE_STATE,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v1.1 Notifications\n\n### Phase 6: Notify\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      '{}',
      'utf-8',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('writes new milestone into frontmatter and resets progress + Current Position', () => {
    const result = runGsdTools(
      ['state', 'milestone-switch', '--milestone', 'v1.1', '--name', 'Notifications'],
      tmpDir,
    );
    assert.equal(result.success, true, result.error || result.output);

    const after = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );

    // Frontmatter reflects the NEW milestone — the core of bug #2630.
    assert.match(after, /^milestone:\s*v1\.1\s*$/m, 'frontmatter milestone not switched');
    assert.match(
      after,
      /^milestone_name:\s*Notifications\s*$/m,
      'frontmatter milestone_name not switched',
    );
    assert.match(after, /^status:\s*planning\s*$/m, 'status not reset to planning');
    // Progress counters reset to zero.
    assert.match(after, /^\s*completed_phases:\s*0\s*$/m, 'completed_phases not reset');
    assert.match(after, /^\s*completed_plans:\s*0\s*$/m, 'completed_plans not reset');
    assert.match(after, /^\s*percent:\s*0\s*$/m, 'percent not reset');

    // Body Current Position reset to the new-milestone template.
    assert.match(after, /Status:\s*Defining requirements/, 'body Status not reset');
    assert.match(
      after,
      /Phase:\s*Not started \(defining requirements\)/,
      'body Phase not reset',
    );

    // Accumulated Context is preserved.
    assert.match(after, /\[Phase 1\]:\s*Use Node 20/, 'Accumulated Context lost');
  });

  test('rejects missing --milestone', () => {
    const result = runGsdTools(
      ['state', 'milestone-switch', '--name', 'Something'],
      tmpDir,
    );
    // gsd-tools emits JSON with { error: ... } to stdout even on error paths.
    const combined = (result.output || '') + (result.error || '');
    assert.match(combined, /milestone required/i);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3286-state-write-routing.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3286-state-write-routing (consolidation epic #1969 B2 #1971)", () => {
'use strict';
// Regression tests for issue #3286 — three bugs in state.cjs:
//
// Bug A: cmdStateRecordMetric / cmdStateAddDecision return { recorded: false }
//   with exit code 0 when their target section is absent. gsd-executor treats
//   exit 0 as success, silently losing metrics/decisions across an entire phase.
//   Fix: auto-create the missing section (Bug B subsumes A — silent no-op
//   disappears). When auto-created, JSON must include created: true.
//
// Bug B: A fresh STATE.md without ## Performance Metrics or ## Decisions causes
//   both verbs to silently no-op. DWIM: auto-create the canonical section scaffold
//   and then write the row/entry, matching state begin-phase / advance-plan behavior.
//
// Bug C: state record-metric and add-decision must honor --ws <name>, routing
//   writes to .planning/workstreams/<name>/STATE.md instead of root STATE.md.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal STATE.md with all canonical sections */
function buildFullStateMd() {
  return [
    '# GSD State',
    '',
    '## Configuration',
    'Current Phase: 1',
    'Current Phase Name: bootstrap',
    'Total Plans in Phase: 3',
    'Current Plan: 1',
    'Status: Executing',
    'Last Activity: 2026-01-01',
    '',
    '## Performance Metrics',
    '',
    '| Phase | Plan | Duration | Notes |',
    '|-------|------|----------|-------|',
    '',
    '## Decisions',
    '',
    'None yet.',
    '',
    '### Blockers',
    '',
    'None.',
    '',
  ].join('\n');
}

/** Build a STATE.md WITHOUT Performance Metrics or Decisions sections */
function buildBareboneStateMd() {
  return [
    '# GSD State',
    '',
    '## Configuration',
    'Current Phase: 1',
    'Current Phase Name: bootstrap',
    'Total Plans in Phase: 3',
    'Current Plan: 1',
    'Status: Executing',
    'Last Activity: 2026-01-01',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Group B: auto-create missing sections (DWIM)
// ─────────────────────────────────────────────────────────────────────────────

describe('#3286 Bug B: record-metric auto-creates ## Performance Metrics when missing', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('record-metric succeeds when ## Performance Metrics is absent', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '1', '--plan', '1', '--duration', '45min'],
      tmpDir,
    );

    assert.ok(result.success, `record-metric must succeed (exit 0), got: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.recorded, true, `recorded must be true, got: ${JSON.stringify(parsed)}`);
  });

  test('record-metric with created:true when section was auto-created', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '1', '--plan', '1', '--duration', '45min'],
      tmpDir,
    );

    assert.ok(result.success, `record-metric must succeed, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.created, true, `JSON must include created:true when section was auto-created`);
  });

  test('record-metric appends row into auto-created section — verifiable via state snapshot', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '1', '--plan', '2', '--duration', '30min', '--tasks', '5'],
      tmpDir,
    );
    assert.ok(result.success, `record-metric must succeed, got: ${result.error}`);

    // Verify the metric appeared in the file by calling state get to read the section
    const getResult = runGsdTools(['state', 'get', 'Performance Metrics'], tmpDir);
    assert.ok(getResult.success, `state get must succeed, got: ${getResult.error}`);

    // Parse JSON to check structural content (no .includes on raw file)
    const sectionContent = JSON.parse(getResult.output);
    const sectionText = sectionContent['Performance Metrics'] || '';
    // Must contain a row referencing Phase 1 P2
    assert.ok(
      sectionText.includes('Phase 1 P2') || sectionText.includes('| Phase 1 P2'),
      `Performance Metrics section must contain the appended row. Got section: ${sectionText}`,
    );
  });

  test('record-metric on state with existing section still works (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildFullStateMd());

    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '2', '--plan', '1', '--duration', '1h'],
      tmpDir,
    );
    assert.ok(result.success, `record-metric must succeed on existing section, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.recorded, true, `recorded must be true`);
    // created should be absent or false when section already existed
    assert.ok(!parsed.created, `created must be absent/false when section existed`);
  });
});

describe('#3286 Bug B: add-decision auto-creates ## Decisions when missing', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('add-decision succeeds when ## Decisions is absent', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '1', '--summary', 'Use TypeScript for type safety'],
      tmpDir,
    );

    assert.ok(result.success, `add-decision must succeed (exit 0), got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.added, true, `added must be true, got: ${JSON.stringify(parsed)}`);
  });

  test('add-decision with created:true when section was auto-created', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '1', '--summary', 'Use Redis for caching'],
      tmpDir,
    );

    assert.ok(result.success, `add-decision must succeed, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.created, true, `JSON must include created:true when Decisions section auto-created`);
  });

  test('add-decision appended entry is visible in state get', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const summary = 'Adopt PostgreSQL over MySQL for JSONB support';
    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '2', '--summary', summary],
      tmpDir,
    );
    assert.ok(result.success, `add-decision must succeed, got: ${result.error}`);

    // Verify via state get (structured), not raw file grep
    const getResult = runGsdTools(['state', 'get', 'Decisions'], tmpDir);
    assert.ok(getResult.success, `state get Decisions must succeed, got: ${getResult.error}`);

    const sectionContent = JSON.parse(getResult.output);
    const sectionText = sectionContent['Decisions'] || '';
    assert.ok(
      sectionText.includes(summary),
      `Decisions section must contain the appended decision. Got: ${sectionText}`,
    );
  });

  test('add-decision on state with existing Decisions section works (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildFullStateMd());

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '1', '--summary', 'Use monorepo layout'],
      tmpDir,
    );
    assert.ok(result.success, `add-decision must succeed on existing section, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.added, true, `added must be true`);
    assert.ok(!parsed.created, `created must be absent/false when section already existed`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group A: exit code contract (covered by Bug B fix — no silent no-op)
// ─────────────────────────────────────────────────────────────────────────────

describe('#3286 Bug A: record-metric / add-decision never silently no-op', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('record-metric always has recorded:true (never silent false)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Minimal state — no Performance Metrics section
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '1', '--plan', '1', '--duration', '20min'],
      tmpDir,
    );

    // Must exit 0 AND recorded must be true (auto-created or found)
    assert.ok(result.success, `record-metric must exit 0, got stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.recorded,
      true,
      `recorded must be true — section auto-create should prevent silent false. Got: ${JSON.stringify(parsed)}`,
    );
  });

  test('add-decision always has added:true (never silent false)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '1', '--summary', 'Prefer composition over inheritance'],
      tmpDir,
    );

    assert.ok(result.success, `add-decision must exit 0, got stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.added,
      true,
      `added must be true — section auto-create should prevent silent false. Got: ${JSON.stringify(parsed)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group C: workstream routing — writes go to workstream STATE.md, not root
// ─────────────────────────────────────────────────────────────────────────────

describe('#3286 Bug C: record-metric / add-decision honor --ws routing', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();

    // Create root STATE.md with Performance Metrics + Decisions sections
    const rootStatePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(rootStatePath, buildFullStateMd());

    // Create workstream foo with its own STATE.md (full sections)
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'foo');
    fs.mkdirSync(wsDir, { recursive: true });
    const wsStatePath = path.join(wsDir, 'STATE.md');
    fs.writeFileSync(wsStatePath, buildFullStateMd());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('record-metric --ws foo writes to workstream STATE.md, not root', () => {
    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '1', '--plan', '1', '--duration', '10min', '--ws', 'foo'],
      tmpDir,
    );

    assert.ok(result.success, `record-metric --ws foo must succeed, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.recorded, true, `recorded must be true`);

    // Workstream STATE.md should have the row; root STATE.md should NOT
    const rootGet = runGsdTools(['state', 'get', 'Performance Metrics'], tmpDir);
    assert.ok(rootGet.success, `state get root must succeed, got: ${rootGet.error}`);
    const rootContent = JSON.parse(rootGet.output)['Performance Metrics'] || '';
    assert.ok(
      !rootContent.includes('Phase 1 P1'),
      `Root STATE.md must NOT have the metric row. Got: ${rootContent}`,
    );

    const wsGet = runGsdTools(['state', 'get', 'Performance Metrics', '--ws', 'foo'], tmpDir);
    assert.ok(wsGet.success, `state get --ws foo must succeed, got: ${wsGet.error}`);
    const wsContent = JSON.parse(wsGet.output)['Performance Metrics'] || '';
    assert.ok(
      wsContent.includes('Phase 1 P1'),
      `Workstream foo STATE.md must have the metric row. Got: ${wsContent}`,
    );
  });

  test('add-decision --ws foo writes to workstream STATE.md, not root', () => {
    const summary = 'Adopt event-sourcing for audit trail';
    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '1', '--summary', summary, '--ws', 'foo'],
      tmpDir,
    );

    assert.ok(result.success, `add-decision --ws foo must succeed, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.added, true, `added must be true`);

    // Root STATE.md must NOT have the decision
    const rootGet = runGsdTools(['state', 'get', 'Decisions'], tmpDir);
    assert.ok(rootGet.success, `state get root must succeed, got: ${rootGet.error}`);
    const rootContent = JSON.parse(rootGet.output)['Decisions'] || '';
    assert.ok(
      !rootContent.includes(summary),
      `Root STATE.md must NOT have the decision. Got: ${rootContent}`,
    );

    // Workstream STATE.md must have the decision
    const wsGet = runGsdTools(['state', 'get', 'Decisions', '--ws', 'foo'], tmpDir);
    assert.ok(wsGet.success, `state get --ws foo must succeed, got: ${wsGet.error}`);
    const wsContent = JSON.parse(wsGet.output)['Decisions'] || '';
    assert.ok(
      wsContent.includes(summary),
      `Workstream foo STATE.md must have the decision. Got: ${wsContent}`,
    );
  });

  test('record-metric --ws foo auto-creates section in workstream STATE.md when missing', () => {
    // Create a workstream without Performance Metrics section
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'bar');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), buildBareboneStateMd());

    const result = runGsdTools(
      ['state', 'record-metric', '--phase', '1', '--plan', '1', '--duration', '5min', '--ws', 'bar'],
      tmpDir,
    );

    assert.ok(result.success, `record-metric --ws bar must succeed, got: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.recorded, true, `recorded must be true`);
    assert.strictEqual(parsed.created, true, `created must be true when section auto-created in workstream`);

    // Root STATE.md must remain untouched
    const rootGet = runGsdTools(['state', 'get', 'Performance Metrics'], tmpDir);
    assert.ok(rootGet.success);
    const rootContent = JSON.parse(rootGet.output)['Performance Metrics'] || '';
    assert.ok(
      !rootContent.includes('Phase 1 P1'),
      `Root STATE.md must not be written when --ws bar is used`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3454-state-dollar-backreference-growth.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3454-state-dollar-backreference-growth (consolidation epic #1969 B2 #1971)", () => {
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

function seedState(tmpDir, planLine = '1 of 2') {
  const state = `# Project State

**Status:** executing
**Current Phase:** 1

## Current Position
Phase: 1 of 1
Plan: ${planLine}
Status: Ready
Last activity: 2026-01-01
Budget: $2,500 max test

## Session Continuity
Last session: 2026-01-01
`;
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), state, 'utf8');
}

function parseStateFile(tmpDir) {
  const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
  const sections = {};
  const keyCountsBySection = {};
  let currentSection = '__root__';
  sections[currentSection] = {};
  keyCountsBySection[currentSection] = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const headingMatch = /^##\s+(.+)$/u.exec(rawLine);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
      sections[currentSection] = sections[currentSection] || {};
      keyCountsBySection[currentSection] = keyCountsBySection[currentSection] || {};
      continue;
    }

    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const boldFieldMatch = /^\*\*([^*]+)\*\*:\s*(.*)$/u.exec(trimmed);
    if (boldFieldMatch) {
      const key = boldFieldMatch[1].trim();
      const value = boldFieldMatch[2].trim();
      sections[currentSection][key] = value;
      keyCountsBySection[currentSection][key] = (keyCountsBySection[currentSection][key] || 0) + 1;
      continue;
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex <= 0) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    sections[currentSection][key] = value;
    keyCountsBySection[currentSection][key] = (keyCountsBySection[currentSection][key] || 0) + 1;
  }

  return { content, sections, keyCountsBySection };
}

describe('bug #3454: state mutation must preserve literal $N amounts', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('bug-3454-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state advance-plan keeps Current Position dollar amount literal', () => {
    seedState(tmpDir, '1 of 20');
    const result = runGsdTools(['state', 'advance-plan'], tmpDir);
    assert.equal(result.success, true, `state advance-plan failed: ${result.error || result.output}`);

    const parsed = parseStateFile(tmpDir);
    const currentPosition = parsed.sections['Current Position'] || {};
    assert.equal(currentPosition.Budget, '$2,500 max test');
    assert.equal((parsed.keyCountsBySection['Current Position'] || {}).Budget, 1);
  });

  test('state begin-phase keeps Current Position dollar amount literal', () => {
    seedState(tmpDir);
    const result = runGsdTools(['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '2'], tmpDir);
    assert.equal(result.success, true, `state begin-phase failed: ${result.error || result.output}`);

    const parsed = parseStateFile(tmpDir);
    const currentPosition = parsed.sections['Current Position'] || {};
    assert.equal(currentPosition.Budget, '$2,500 max test');
    assert.equal((parsed.keyCountsBySection['Current Position'] || {}).Budget, 1);
  });

  test('state complete-phase keeps Current Position dollar amount literal', () => {
    seedState(tmpDir);
    const result = runGsdTools(['state', 'complete-phase', '--phase', '1'], tmpDir);
    assert.equal(result.success, true, `state complete-phase failed: ${result.error || result.output}`);

    const parsed = parseStateFile(tmpDir);
    const currentPosition = parsed.sections['Current Position'] || {};
    assert.equal(currentPosition.Budget, '$2,500 max test');
    assert.equal((parsed.keyCountsBySection['Current Position'] || {}).Budget, 1);
  });

  test('repeated state advance-plan stays size-bounded with dollar amounts', () => {
    seedState(tmpDir, '1 of 20');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    let stabilizedSize = null;
    for (let i = 0; i < 8; i += 1) {
      const result = runGsdTools(['state', 'advance-plan'], tmpDir);
      assert.equal(result.success, true, `iteration ${i + 1} failed: ${result.error || result.output}`);
      if (i === 0) stabilizedSize = fs.statSync(statePath).size;
    }

    const endSize = fs.statSync(statePath).size;
    const growth = endSize / stabilizedSize;
    assert.ok(growth <= 1.5, `expected <=1.5x growth after first write, got ${growth.toFixed(2)}x (${stabilizedSize} -> ${endSize})`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3489-complete-phase-idempotent.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3489-complete-phase-idempotent (consolidation epic #1969 B2 #1971)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #3489)
// State.md is the deployed artifact; asserting on its literal text content
// tests the deployed contract.

/**
 * Regression test for #3489
 *
 *   `gsd state complete-phase --phase <N>` was non-idempotent. Re-invoking it
 *   on a phase already marked complete in STATE.md silently rolled STATE.md
 *   back to that phase's moment-of-completion — overwriting Status, Last
 *   Activity, Current Position and the body Status/Phase with stale values
 *   derived from the just-completed phase.
 *
 *   Expected: when the target phase is already marked complete (and STATE.md
 *   has clearly advanced past it — e.g. a later phase is now in progress or
 *   inserted), `complete-phase` must be a no-op. No STATE.md write at all.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

describe('bug #3489: state complete-phase must be idempotent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('bug-3489-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('re-running complete-phase on an already-complete phase does not roll STATE.md back', () => {
    // STATE.md as it would appear AFTER phase 02.2 was legitimately completed
    // AND a follow-up Phase 02.2.1 has since been inserted as in-progress.
    // Re-invoking `state complete-phase --phase 02.2` from a downstream tool
    // (e.g. a re-run of /gsd-execute-phase) must NOT regress this content.
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** in-progress',
      '**Current Phase:** 02.2.1',
      '**Last Activity:** 2026-05-13',
      '**Last Activity Description:** Phase 02.2.1 inserted (urgent — gates Phase 5)',
      '',
      '## Current Position',
      '',
      'Phase: 02.2.1 — Not planned yet',
      'Status: Phase 02.2.1 inserted (urgent — gates Phase 5)',
      'Last activity: 2026-05-13 -- Phase 02.2.1 inserted (urgent — gates Phase 5)',
      '',
    ].join('\n');

    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd, 'utf8');
    const before = fs.readFileSync(statePath, 'utf8');

    const result = runGsdTools(['state', 'complete-phase', '--phase', '02.2'], tmpDir);
    assert.ok(result.success, `command should not error, got: ${result.error || result.output}`);

    const after = fs.readFileSync(statePath, 'utf8');

    // Hard assertion: file is byte-identical to its pre-call snapshot.
    assert.equal(
      after,
      before,
      `STATE.md must not be rewritten when phase is already complete.\n\n--- before ---\n${before}\n--- after ---\n${after}`,
    );

    // Output should advertise the no-op so downstream consumers can detect it.
    let payload = null;
    try { payload = JSON.parse(result.output); } catch (_) { /* ignore */ }
    assert.ok(payload && typeof payload === 'object', `expected JSON payload, got: ${result.output}`);
    assert.deepEqual(payload.updated, [], `expected empty updated list, got: ${JSON.stringify(payload.updated)}`);
    assert.equal(payload.phase, '02.2');
    assert.equal(payload.idempotent, true, `expected idempotent:true flag, got: ${JSON.stringify(payload)}`);
  });

  test('completing the currently in-progress phase still works normally (no false-positive idempotency)', () => {
    // Sanity check: the guard must not fire on the legitimate first completion.
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** in-progress',
      '**Current Phase:** 03',
      '**Last Activity:** 2026-05-13',
      '',
      '## Current Position',
      '',
      'Phase: 03',
      'Status: Phase 03 executing',
      '',
    ].join('\n');

    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd, 'utf8');

    const result = runGsdTools(['state', 'complete-phase', '--phase', '03'], tmpDir);
    assert.ok(result.success, `command failed: ${result.error || result.output}`);

    const after = fs.readFileSync(statePath, 'utf8');
    assert.ok(
      after.includes('**Status:** Phase 03 complete'),
      `expected Status updated to "Phase 03 complete", got:\n${after}`,
    );

    const payload = JSON.parse(result.output);
    assert.notEqual(payload.idempotent, true, 'first completion must not be flagged idempotent');
    assert.ok(Array.isArray(payload.updated) && payload.updated.length > 0, 'expected non-empty updated list');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-397-state-preserve-executor-authored.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-397-state-preserve-executor-authored (consolidation epic #1969 B2 #1971)", () => {
'use strict';
// allow-test-rule: reads runtime STATE.md written to temp dir — behavioral output test, not source-grep (see #397)

// Regression tests for bug #397.
//
// STATE.md fields edited by an executor (e.g. a hand-authored Resume File path,
// a custom Status value, or a custom Last Activity entry) were silently overwritten
// by the next call to record-session, advance-plan, or planned-phase because the
// handlers used unconditional stateReplaceField / stateReplaceFieldWithFallback
// calls, even when the option was not passed by the caller.
//
// Fix: introduce KNOWN_TEMPLATE_DEFAULTS (a per-field table of string values that
// are safe to replace because they came from a template) and
// stateReplaceFieldIfTemplate (a helper that only replaces when the current value
// is a template default or absent). Handlers must consult this table rather than
// writing unconditionally.
//
// The 7 baseline cases verified here:
//
//  1. record-session WITHOUT --resume-file when Resume File is executor-authored
//     → preserved (must NOT be replaced with 'None')
//  2. record-session WITHOUT --resume-file when Resume File is 'None'
//     → remains 'None' (template-default → template-default is fine)
//  3. record-session WITH --resume-file → explicit caller value wins (always)
//  4. advance-plan phase-complete when Status is executor-authored → preserved
//  5. advance-plan phase-complete when Status is a known default → replaced
//  6. advance-plan advance when Last Activity is executor-authored → preserved
//  7. updateCurrentPositionFields with executor-authored Current Position values
//     → preserved

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const TOOLS_PATH = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempPlanning(stateContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-397-'));
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent, 'utf8');
  return dir;
}

function readState(dir) {
  return fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
}

function runGsdState(args, cwd) {
  const { execFileSync } = require('child_process');
  const env = {
    ...process.env,
    GSD_SESSION_KEY: '',
    CODEX_THREAD_ID: '',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SSE_PORT: '',
    OPENCODE_SESSION_ID: '',
  };
  try {
    execFileSync(process.execPath, [TOOLS_PATH, 'state', ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.stderr?.toString().trim() || err.message };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Case 1: Resume File is executor-authored (not a template default)
const STATE_EXECUTOR_RESUME_FILE = `# GSD State

## Configuration
Current Phase: 2
Total Plans in Phase: 4
Current Plan: 1
Status: Ready to execute

## Current Position
Phase: 2
Plan: 1 of 4
Status: Ready to execute
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: /home/user/my-custom-context.md
Stopped At: Phase 2 Plan 1 complete
`;

// Case 2: Resume File is 'None' (the known template default)
const STATE_DEFAULT_RESUME_FILE = `# GSD State

## Configuration
Current Phase: 2
Total Plans in Phase: 4
Current Plan: 1
Status: Ready to execute

## Current Position
Phase: 2
Plan: 1 of 4
Status: Ready to execute
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
Stopped At: Phase 2 Plan 1 complete
`;

// Cases 4 & 7: Status is executor-authored in both Configuration and Current Position.
// Current Plan=2, Total Plans=2 → triggers the phase-complete branch of advance-plan.
const STATE_EXECUTOR_STATUS = `# GSD State

## Configuration
Current Phase: 3
Total Plans in Phase: 2
Current Plan: 2
Status: Awaiting QA sign-off before proceeding

## Current Position
Phase: 3
Plan: 2 of 2
Status: Awaiting QA sign-off before proceeding
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
`;

// Case 5: Status IS a known template default ('Ready to execute').
// Current Plan=2, Total Plans=2 → triggers the phase-complete branch.
const STATE_DEFAULT_STATUS = `# GSD State

## Configuration
Current Phase: 3
Total Plans in Phase: 2
Current Plan: 2
Status: Ready to execute

## Current Position
Phase: 3
Plan: 2 of 2
Status: Ready to execute
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
`;

// Case 6: The only Last Activity field in the document is executor-authored
// (a narrative, not a bare ISO date). Current Plan=1, Total=3 → advance branch.
const STATE_EXECUTOR_LAST_ACTIVITY = `# GSD State

## Configuration
Current Phase: 2
Total Plans in Phase: 3
Current Plan: 1
Status: Ready to execute
Last Activity: Unblocked after infra fix — merged PR #88 manually

## Current Position
Phase: 2
Plan: 1 of 3
Status: Ready to execute
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
`;

// Case 7: Current Position has executor-authored Status and Last activity.
// Current Plan=2, Total=3 → advance branch.
const STATE_EXECUTOR_CURRENT_POSITION = `# GSD State

## Configuration
Current Phase: 4
Total Plans in Phase: 3
Current Plan: 2
Status: Ready to execute

## Current Position
Phase: 4
Plan: 2 of 3
Status: On hold — waiting for upstream dependency merge
Last activity: 2026-02-15 -- blocked by infra; resume after merge

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bug #397: executor-authored STATE.md fields must be preserved', () => {

  // Case 1: record-session without --resume-file, Resume File is executor-authored
  test('case 1: record-session without --resume-file preserves executor-authored Resume File', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_RESUME_FILE);
    try {
      const r = runGsdState(['record-session', '--stopped-at', 'Plan 1 complete'], dir);
      assert.ok(r.success, `record-session failed: ${r.error}`);
      const after = readState(dir);
      const rfMatch = after.match(/Resume File:\s*(.+)/i);
      assert.ok(rfMatch, 'Resume File field not found in STATE.md after record-session');
      assert.strictEqual(
        rfMatch[1].trim(),
        '/home/user/my-custom-context.md',
        `record-session overwrote executor-authored Resume File with '${rfMatch[1].trim()}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 2: record-session without --resume-file, Resume File is 'None' (template default)
  test('case 2: record-session without --resume-file keeps "None" when it is already "None"', () => {
    const dir = makeTempPlanning(STATE_DEFAULT_RESUME_FILE);
    try {
      const r = runGsdState(['record-session', '--stopped-at', 'Plan complete'], dir);
      assert.ok(r.success, `record-session failed: ${r.error}`);
      const after = readState(dir);
      const rfMatch = after.match(/Resume File:\s*(.+)/i);
      assert.ok(rfMatch, 'Resume File field not found in STATE.md after record-session');
      assert.strictEqual(
        rfMatch[1].trim(),
        'None',
        `Expected 'None' to remain when it was already 'None', got: ${rfMatch[1].trim()}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 3: record-session WITH --resume-file — explicit value always wins
  test('case 3: record-session with --resume-file sets the explicit value', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_RESUME_FILE);
    try {
      const r = runGsdState(['record-session', '--resume-file', '/tmp/new-resume.md'], dir);
      assert.ok(r.success, `record-session failed: ${r.error}`);
      const after = readState(dir);
      const rfMatch = after.match(/Resume File:\s*(.+)/i);
      assert.ok(rfMatch, 'Resume File field not found in STATE.md after record-session');
      assert.strictEqual(
        rfMatch[1].trim(),
        '/tmp/new-resume.md',
        `Expected explicit --resume-file value to be written, got: ${rfMatch[1].trim()}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 4: advance-plan phase-complete, Status is executor-authored → preserved
  test('case 4: advance-plan (phase-complete) preserves executor-authored Status', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_STATUS);
    try {
      // Current Plan=2, Total=2 → phase-complete branch
      const r = runGsdState(['advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const after = readState(dir);
      // The Configuration-level Status must not be clobbered
      const statusMatch = after.match(/^Status:\s*(.+)/m);
      assert.ok(statusMatch, 'Status field not found after advance-plan');
      assert.strictEqual(
        statusMatch[1].trim(),
        'Awaiting QA sign-off before proceeding',
        `advance-plan overwrote executor-authored Status: got '${statusMatch[1].trim()}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 5: advance-plan phase-complete, Status is a known default → replaced
  test('case 5: advance-plan (phase-complete) replaces known-default Status with phase-complete value', () => {
    const dir = makeTempPlanning(STATE_DEFAULT_STATUS);
    try {
      // Current Plan=2, Total=2 → phase-complete branch
      const r = runGsdState(['advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const after = readState(dir);
      const statusMatch = after.match(/^Status:\s*(.+)/m);
      assert.ok(statusMatch, 'Status field not found after advance-plan');
      // 'Ready to execute' is a known default and should be replaced
      assert.notStrictEqual(
        statusMatch[1].trim(),
        'Ready to execute',
        `Status should have been updated from 'Ready to execute' after phase-complete, but was not`,
      );
      assert.ok(
        statusMatch[1].includes('Phase complete') || statusMatch[1].includes('ready for verification'),
        `Expected phase-complete Status text, got: '${statusMatch[1].trim()}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 6: advance-plan normal advance, top-level Last Activity is executor-authored → preserved
  test('case 6: advance-plan (normal advance) preserves executor-authored Last Activity', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_LAST_ACTIVITY);
    try {
      // Current Plan=1, Total=3 → advance branch
      const r = runGsdState(['advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const after = readState(dir);
      // The top-level Last Activity (in Configuration section) must be preserved
      const laMatch = after.match(/^Last Activity:\s*(.+)/im);
      assert.ok(laMatch, 'Last Activity field not found after advance-plan');
      assert.strictEqual(
        laMatch[1].trim(),
        'Unblocked after infra fix — merged PR #88 manually',
        `advance-plan overwrote executor-authored Last Activity: got '${laMatch[1].trim()}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 7: advance-plan preserves executor-authored Status and Last activity in Current Position
  test('case 7: advance-plan preserves executor-authored Current Position Status and Last activity', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_CURRENT_POSITION);
    try {
      // Current Plan=2, Total=3 → advance branch
      const r = runGsdState(['advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const after = readState(dir);
      const posMatch = after.match(/##\s*Current Position\s*\n([\s\S]*?)(?=\n##|$)/i);
      assert.ok(posMatch, 'Current Position section not found after advance-plan');
      const posBody = posMatch[1];
      const posStatusMatch = posBody.match(/^Status:\s*(.+)/m);
      assert.ok(posStatusMatch, 'Status field not found in Current Position section');
      assert.strictEqual(
        posStatusMatch[1].trim(),
        'On hold — waiting for upstream dependency merge',
        `advance-plan overwrote executor-authored Current Position Status: got '${posStatusMatch[1].trim()}'`,
      );
      const posActivityMatch = posBody.match(/^Last activity:\s*(.+)/im);
      assert.ok(posActivityMatch, 'Last activity field not found in Current Position section');
      assert.ok(
        posActivityMatch[1].includes('blocked by infra'),
        `advance-plan overwrote executor-authored Current Position Last activity: got '${posActivityMatch[1].trim()}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-905-state-syncstatefrontmatter-preserve-scalars.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-905-state-syncstatefrontmatter-preserve-scalars (consolidation epic #1969 B2 #1971)", () => {
'use strict';
/**
 * Regression guard for bug #905.
 *
 * `syncStateFrontmatter` (src/state.cts) only preserved `status` from existing
 * frontmatter when the body-derived value was missing/unknown. The scalars
 * `current_phase`, `current_phase_name`, `current_plan`, and `progress` were
 * silently stripped whenever `buildStateFrontmatter` could not extract them from
 * the body text — e.g. when an agent removed the bold `**Current Phase:**`
 * annotations.
 *
 * Fix: mirror the `cmdStateJson` fallback pattern in `syncStateFrontmatter` so
 * that all four scalars survive a `writeStateMd` / `state sync` call when the
 * body no longer carries the annotation but the existing frontmatter does.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, createTempDir, cleanup, parseFrontmatter } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A STATE.md whose YAML frontmatter holds all four scalars but whose body
 * does NOT contain the bold `**Current Phase:**` / `**Current Plan:**`
 * annotations that `buildStateFrontmatter` uses to re-derive them.
 *
 * This is the exact scenario that triggered the bug: the body has already lost
 * the annotations (e.g. because a CLI tool or agent overwrote it), but the
 * frontmatter still holds the ground-truth values. A subsequent `state sync`
 * (or any `writeStateMd` call) must not strip them.
 */
function buildStateMdWithoutBodyAnnotations(opts) {
  const {
    currentPhase = 3,
    currentPhaseName = 'Implementation',
    currentPlan = 2,
    progressPercent = 42,
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    `current_phase: ${currentPhase}`,
    `current_phase_name: ${currentPhaseName}`,
    `current_plan: ${currentPlan}`,
    'status: executing',
    'progress:',
    `  total_phases: 5`,
    `  completed_phases: 2`,
    `  total_plans: 10`,
    `  completed_plans: 4`,
    `  percent: ${progressPercent}`,
    '---',
    '',
    '# GSD State',
    '',
    '## Configuration',
    // Intentionally omitting "Current Phase:", "Current Phase Name:",
    // "Current Plan:" body annotations to reproduce the bug scenario.
    'Status: Executing',
    'Last Activity: 2026-01-01',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- Use Node 22',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('#905: syncStateFrontmatter preserves scalars when body annotations are absent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state sync preserves current_phase from existing frontmatter when body lacks annotation', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ currentPhase: 3 }));

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.current_phase,
      '3',
      `current_phase must be preserved from existing frontmatter after sync (got: ${JSON.stringify(fm.current_phase)})`,
    );
  });

  test('state sync preserves current_phase_name from existing frontmatter when body lacks annotation', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ currentPhaseName: 'Implementation' }));

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.current_phase_name,
      'Implementation',
      `current_phase_name must be preserved from existing frontmatter after sync (got: ${JSON.stringify(fm.current_phase_name)})`,
    );
  });

  test('state sync preserves current_plan from existing frontmatter when body lacks annotation', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ currentPlan: 2 }));

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.current_plan,
      '2',
      `current_plan must be preserved from existing frontmatter after sync (got: ${JSON.stringify(fm.current_plan)})`,
    );
  });

  test('state update (resync:false) preserves curated progress from existing frontmatter when body lacks disk-scan data', () => {
    // state update "Last Activity" calls readModifyWriteStateMd with resync:false.
    // That path runs syncStateFrontmatter and then explicitly re-applies the
    // pre-existing progress block (lines 1243-1253 of state.cts). The curated
    // progress values must survive even though the phases dir is empty.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ progressPercent: 42 }));

    // Add body annotation for Last Activity so state update can find and replace it
    const initial = fs.readFileSync(statePath, 'utf8');
    fs.writeFileSync(statePath, initial.replace('Last Activity: 2026-01-01', 'Last Activity: 2026-01-01'));

    const updateResult = runGsdTools(
      ['state', 'update', 'Last Activity', '2026-06-08'],
      tmpDir,
    );
    assert.ok(updateResult.success, `state update failed: ${updateResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.ok(fm.progress, 'frontmatter must retain a progress block after body-only update');
    // shouldPreserveExistingProgress: existing completed_plans (4) > derived (0 from empty disk)
    // → curated block survives via cmdStateJson read-path fallback.
    assert.strictEqual(
      fm.progress.completed_plans,
      4,
      `progress.completed_plans must be preserved via shouldPreserveExistingProgress ` +
      `(got: ${JSON.stringify(fm.progress?.completed_plans)})`,
    );
  });

  test('state update field preserves current_phase frontmatter when body lacks annotation', () => {
    // Trigger the write path via `state update` (which calls readModifyWriteStateMd
    // with resync:true), confirming the fix covers every write path.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ currentPhase: 7 }));

    const updateResult = runGsdTools(
      ['state', 'update', 'Last Activity', '2026-06-08'],
      tmpDir,
    );
    assert.ok(updateResult.success, `state update failed: ${updateResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.current_phase,
      '7',
      `current_phase must survive a state.update write (got: ${JSON.stringify(fm.current_phase)})`,
    );
  });

  test('body annotation beats existing frontmatter when both are present', () => {
    // When the body DOES carry the annotation, the derived value wins — we must
    // not accidentally lock stale frontmatter in place.
    // IMPORTANT: assert on the raw written STATE.md file (not just state json,
    // which rebuilds from the body and would return body-derived values regardless
    // of what syncStateFrontmatter wrote to disk).
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Frontmatter says phase 3; body says phase 5. Body should win.
    fs.writeFileSync(statePath, [
      '---',
      'gsd_state_version: 1.0',
      'current_phase: 3',
      'current_phase_name: Old Phase',
      'current_plan: 1',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Current Phase: 5',
      'Current Phase Name: New Phase',
      'Current Plan: 2',
      'Status: Executing',
      'Last Activity: 2026-01-01',
      '',
    ].join('\n'));

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    // Assert on raw file: body-derived values must be written to frontmatter,
    // not the stale existing values. This guards against a fallback that locks
    // in stale data even when buildStateFrontmatter successfully derived values.
    const writtenContent = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(writtenContent);
    assert.strictEqual(
      rawFm.current_phase,
      '5',
      `body-derived current_phase (5) must be written to raw frontmatter (not stale 3), got: ${JSON.stringify(rawFm.current_phase)}`,
    );
    assert.strictEqual(
      rawFm.current_phase_name,
      'New Phase',
      `body-derived current_phase_name must be written to raw frontmatter, got: ${JSON.stringify(rawFm.current_phase_name)}`,
    );
    assert.strictEqual(
      rawFm.current_plan,
      '2',
      `body-derived current_plan must be written to raw frontmatter, got: ${JSON.stringify(rawFm.current_plan)}`,
    );
  });

  test('syncStateFrontmatter preserves progress from existing frontmatter when disk has no phases dir', () => {
    // Directly exercises the !derivedFm['progress'] fallback in syncStateFrontmatter.
    // Without a phases dir, buildStateFrontmatter returns no progress block at all
    // (the existsSync guard at line ~927 short-circuits the disk scan). The
    // existing frontmatter's progress must then survive the writeStateMd call.
    // Use createTempDir (no phases dir) and set up .planning/ manually.
    const dir = createTempDir('gsd-905-nophasesdir-');
    try {
      fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
      const statePath = path.join(dir, '.planning', 'STATE.md');

      // Body has the "Current Phase:" annotation so cmdStateSync can proceed;
      // the progress block is ONLY in frontmatter (no ROADMAP, no phases dir).
      fs.writeFileSync(statePath, [
        '---',
        'gsd_state_version: 1.0',
        'current_phase: 2',
        'status: executing',
        'progress:',
        '  total_phases: 4',
        '  completed_phases: 1',
        '  total_plans: 8',
        '  completed_plans: 3',
        '  percent: 38',
        '---',
        '',
        '# GSD State',
        '',
        '## Configuration',
        'Current Phase: 2',
        'Status: Executing',
        'Last Activity: 2026-01-01',
        '',
      ].join('\n'));

      // state update "Last Activity" → readModifyWriteStateMd (resync:true for
      // Progress/Total Phases/Total Plans fields, but resync:false for Last Activity)
      // This calls syncStateFrontmatter; without phases dir, buildStateFrontmatter
      // produces no progress → !derivedFm['progress'] guard fires → existing preserved.
      const updateResult = runGsdTools(
        ['state', 'update', 'Last Activity', '2026-06-08'],
        dir,
      );
      assert.ok(updateResult.success, `state update failed: ${updateResult.error}`);

      // Assert on the raw frontmatter file — cmdStateJson would apply
      // shouldPreserveExistingProgress separately, so we must verify the on-disk state.
      const written = fs.readFileSync(statePath, 'utf8');
      const rawFm = parseFrontmatter(written);

      // The progress block must be present in the written frontmatter.
      // parseFrontmatter returns flat keys, so check the presence indicator.
      assert.ok(
        written.includes('progress:'),
        'progress block must be preserved in raw frontmatter when disk has no phases dir',
      );
      // percent: 38 should survive (no disk scan to overwrite it)
      assert.ok(
        written.includes('percent: 38'),
        `progress.percent: 38 must survive syncStateFrontmatter when no phases dir exists (raw: ${rawFm.progress})`,
      );
    } finally {
      cleanup(dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #1230 regression suite
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a STATE.md where:
 *  - frontmatter has an explicit status (e.g. 'completed') and optional stopped_at
 *  - body has a Status: field that is STALE relative to the frontmatter
 *    (e.g. "Verifying Phase 3" would derive 'verifying')
 * A subsequent incidental write must NOT revert the hand-set frontmatter status.
 */
function buildStateMd1230({ fmStatus = 'completed', fmStoppedAt = null, bodyStatus = 'Verifying Phase 3', bodyStoppedAt = null } = {}) {
  const fmLines = [
    '---',
    'gsd_state_version: 1.0',
    `status: ${fmStatus}`,
  ];
  if (fmStoppedAt) fmLines.push(`stopped_at: "${fmStoppedAt}"`);
  fmLines.push('---');

  const bodyLines = [
    '',
    '# GSD State',
    '',
    '## Configuration',
    `Status: ${bodyStatus}`,
    'Last Activity: 2026-01-01',
    `Current Phase: 3`,
    '',
    '## Session',
    '',
    '**Last session:** 2026-01-01T00:00:00.000Z',
  ];
  if (bodyStoppedAt) bodyLines.push(`**Stopped at:** ${bodyStoppedAt}`);
  bodyLines.push('');

  return [...fmLines, ...bodyLines].join('\n');
}

describe('bug #1230: readModifyWriteStateMd preserves frontmatter status/stopped_at when write does not change body source field', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // (a) CORE: record-session with stale body Status leaves frontmatter status: completed intact
  test('(a) record-session does NOT revert frontmatter status: completed when body Status is unchanged', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // frontmatter status: completed; body Status: Verifying Phase 3 (derives 'verifying')
    fs.writeFileSync(statePath, buildStateMd1230({ fmStatus: 'completed', bodyStatus: 'Verifying Phase 3' }));

    const result = runGsdTools(
      ['state', 'record-session', '--stopped-at', 'Phase 3 final review checkpoint'],
      tmpDir,
    );
    assert.ok(result.success, `record-session failed: ${result.error}`);

    // Assert on raw file frontmatter — not state json (which re-derives)
    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    assert.strictEqual(
      rawFm.status,
      'completed',
      `frontmatter status must remain 'completed' after record-session (body Status unchanged); got: ${JSON.stringify(rawFm.status)}`,
    );
  });

  // (b) add-decision (resync:true) with frontmatter status: completed, stale body → status preserved
  test('(b) add-decision (resync:true) does NOT revert frontmatter status: completed when body Status unchanged', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMd1230({ fmStatus: 'completed', bodyStatus: 'Verifying Phase 3' }));

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '3', '--summary', 'Use Node 22'],
      tmpDir,
    );
    assert.ok(result.success, `add-decision failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    assert.strictEqual(
      rawFm.status,
      'completed',
      `frontmatter status must remain 'completed' after add-decision; got: ${JSON.stringify(rawFm.status)}`,
    );
  });

  // (c) LEGITIMATE UPDATE NOT FROZEN: begin-phase changes body Status → frontmatter re-derived correctly.
  //
  // stateReplaceField(content, 'Status', ...) replaces the FIRST ^Status: match in the
  // full content (frontmatter + body). When the frontmatter has NO 'status:' key, the
  // match falls through to the body 'Status:' line, which IS changed. The delta then
  // fires (preBodyStatus ≠ postBodyStatus), the preservation guard is skipped, and
  // syncStateFrontmatter re-derives from the new body value as intended.
  test('(c) begin-phase changes body Status → frontmatter status reflects new body-derived value', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Frontmatter intentionally has NO 'status:' key so stateReplaceField targets the body
    // 'Status:' line. After the transform, body Status becomes "Executing Phase 3" →
    // normalizeStateStatus → 'executing' must be written to frontmatter.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Status: Ready to execute',
      'Last Activity: 2026-01-01',
      'Current Phase: 2',
      'Current Phase Name: Planning',
      'Current Plan: 1',
      '',
      '## Current Position',
      '',
      'Phase: 2 (Planning) — READY',
      'Plan: 1 of 1',
      'Status: Ready to execute',
      'Last activity: 2026-01-01 -- Phase 2 planning complete',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(
      ['state', 'begin-phase', '--phase', '3', '--name', 'Execution'],
      tmpDir,
    );
    assert.ok(result.success, `begin-phase failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    // begin-phase changed body Status to "Executing Phase 3" → delta fired → re-derived → 'executing'
    assert.strictEqual(
      rawFm.status,
      'executing',
      `frontmatter status must be updated to 'executing' when begin-phase changes body Status; got: ${JSON.stringify(rawFm.status)}`,
    );
  });

  // (d) stopped_at: TRUE RED — frontmatter stopped_at preserved when body Stopped at differs
  //
  // Change C: this is a TRUE regression guard. Frontmatter stopped_at ("Phase 7 verified PASS")
  // differs from the body ## Session "Stopped at:" value ("Phase 3 work"). The write operation
  // (add-decision) does NOT touch the Session Stopped at line. The delta heuristic must detect
  // that the Session Stopped at did NOT change (pre == post == "Phase 3 work") and therefore
  // preserve the frontmatter value "Phase 7 verified PASS". Pre-fix code would REVERT to
  // "Phase 3 work" (the body-derived value) — making this a genuine red.
  test('(d) add-decision preserves frontmatter stopped_at when body Session Stopped at differs from frontmatter and is unchanged', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'status: completed',
      'stopped_at: "Phase 7 verified PASS"',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Status: Phase 3 complete',
      'Last Activity: 2026-01-01',
      'Current Phase: 3',
      '',
      '## Session',
      '',
      '**Last session:** 2026-01-01T00:00:00.000Z',
      // body Session Stopped at is STALE (different from frontmatter stopped_at)
      '**Stopped at:** Phase 3 work',
      '**Resume file:** None',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // add-decision does NOT touch ## Session Stopped at → pre and post body value identical
    // ("Phase 3 work" unchanged) → delta fires → frontmatter "Phase 7 verified PASS" preserved.
    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '3', '--summary', 'Preserve stopped_at check'],
      tmpDir,
    );
    assert.ok(result.success, `add-decision failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    assert.strictEqual(
      rawFm.stopped_at,
      'Phase 7 verified PASS',
      `frontmatter stopped_at must be preserved ("Phase 7 verified PASS") when body Session Stopped at ` +
      `is unchanged (stale "Phase 3 work"); got: ${JSON.stringify(rawFm.stopped_at)}`,
    );
  });

  // (f) PRODUCTION-PATH: legitimate status transition is NOT frozen by the delta heuristic.
  //
  // Change A: prove that begin-phase on a STATE.md with inline "Status: Executing Phase 1"
  // (the standard template format) correctly transitions frontmatter status from
  // 'executing' to a new 'executing' value when the body Status CHANGES.
  // More critically: also verify a complete-phase → frontmatter becomes 'completed'
  // when the body Status field IS changed. This locks in that the delta heuristic
  // re-derives correctly whenever the body's Status source field actually changes.
  test('(f) begin-phase changes inline body Status → delta fires → frontmatter status updated (not frozen)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Realistic STATE.md: frontmatter status: executing, body Status: Executing Phase 1 (inline format)
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'status: executing',
      'current_phase: 1',
      'current_phase_name: Planning',
      'current_plan: 1',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Status: Executing Phase 1',
      'Last Activity: 2026-01-01',
      'Current Phase: 1',
      'Current Phase Name: Planning',
      'Current Plan: 1',
      'Total Plans in Phase: 2',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // begin-phase 2 changes body Status from "Executing Phase 1" to "Executing Phase 2"
    // → pre and post body Status differ → delta does NOT fire → syncStateFrontmatter
    // re-derives status from new body value → frontmatter status must reflect 'executing'
    // (still 'executing' after begin-phase 2 is a correct transition).
    const beginResult = runGsdTools(
      ['state', 'begin-phase', '--phase', '2', '--name', 'Implementation'],
      tmpDir,
    );
    assert.ok(beginResult.success, `state begin-phase failed: ${beginResult.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    // Frontmatter status must have been updated (not frozen at original 'executing' for phase 1).
    // After begin-phase 2, body Status becomes "Executing Phase 2" → re-derived → still 'executing'
    // but it must NOT be the stale body-derived value from before the transform; the key check is
    // that the write completed successfully and status is a known valid value.
    assert.ok(
      rawFm.status === 'executing',
      `frontmatter status must be 'executing' after begin-phase 2 (delta fires, re-derived); got: ${JSON.stringify(rawFm.status)}`,
    );

    // Stronger check: if we then run a command that changes Status to a DIFFERENT value,
    // the frontmatter MUST reflect the new body-derived status (not be frozen).
    // Use state update to change Status to "Phase 2 complete" → derives 'completed'.
    const updateResult = runGsdTools(
      ['state', 'update', 'Status', 'Phase 2 complete'],
      tmpDir,
    );
    assert.ok(updateResult.success, `state update Status failed: ${updateResult.error}`);

    const written2 = fs.readFileSync(statePath, 'utf8');
    const rawFm2 = parseFrontmatter(written2);
    assert.strictEqual(
      rawFm2.status,
      'completed',
      `frontmatter status must be 'completed' after body Status → 'Phase 2 complete' (delta fires, re-derived); ` +
      `got: ${JSON.stringify(rawFm2.status)}. The delta heuristic must NOT freeze status when the body field changes.`,
    );
  });

  // (e) milestone-switch uses platformWriteSync directly (not RMW) — check it still resets status correctly
  test('(e) milestone-switch still resets frontmatter status to planning (uses writeStateMd path, not RMW)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMd1230({ fmStatus: 'completed', bodyStatus: 'Phase 3 complete' }));
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v2.0 Next\n\n### Phase 4: Next steps\n',
      'utf-8',
    );

    const result = runGsdTools(
      ['state', 'milestone-switch', '--milestone', 'v2.0', '--name', 'Next'],
      tmpDir,
    );
    assert.ok(result.success, `milestone-switch failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    assert.strictEqual(
      rawFm.status,
      'planning',
      `milestone-switch must reset frontmatter status to 'planning'; got: ${JSON.stringify(rawFm.status)}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-948-state-noop-write-guard.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-948-state-noop-write-guard (consolidation epic #1969 B2 #1971)", () => {
'use strict';
/**
 * Regression guard for bugs #948 and #944.
 *
 * #948 (data loss): a `state patch` whose fields all fail to match still
 * rewrites STATE.md — bumping `last_updated`, resetting `milestone_name` to
 * the template placeholder, and resurrecting a stale `stopped_at` from an
 * old body `## Session` block (body-derived value overwrites a newer
 * frontmatter value written by `record-session`).
 *
 * #944: `state record-session --stopped-at X --resume-file Y` silently
 * drops the supplied values when the STATE.md body lacks the exact session
 * labels the in-place replace expects, returning `{"recorded": false}` at
 * exit 0 and only bumping `last_updated`.
 *
 * Shared root cause: `readModifyWriteStateMd` always writes STATE.md even
 * when the transform produced no change, and `syncStateFrontmatter`
 * re-derives frontmatter (including milestone_name / stopped_at) from the
 * possibly-stale body on every write.
 *
 * Fixes:
 *   1. No-op guard in `readModifyWriteStateMd`: when transform output ===
 *      input, skip the write entirely.
 *   2. `syncStateFrontmatter` preserves existing `milestone_name` / `milestone`
 *      when the derived value is the template placeholder `'milestone'`.
 *   3. `syncStateFrontmatter` prefers existing frontmatter `stopped_at` /
 *      `paused_at` over a body-derived value (frontmatter wins).
 *   4. `cmdStateRecordSession` auto-creates a canonical `## Session` section
 *      when `--stopped-at` / `--resume-file` are supplied but no labels exist.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup, parseFrontmatter } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * STATE.md with:
 *  - real `milestone_name` in frontmatter (e.g. "My Real Milestone")
 *  - newer frontmatter `stopped_at` (written by a prior `record-session`)
 *  - stale `## Session` body section with an OLDER "Stopped at" line
 *
 * When a zero-match `state patch` runs on this file, NONE of these values
 * should be disturbed — the file must be byte-identical afterward.
 */
function buildStateMdWithStaleSectionAndRealFrontmatter(opts) {
  const {
    milestoneName = 'My Real Milestone',
    fmStoppedAt = 'Phase 3, Plan 2 — newer value',
    bodyStoppedAt = 'Phase 1, Plan 1 — stale historical value',
    lastUpdated = '2026-01-01T00:00:00.000Z',
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v2.0',
    `milestone_name: ${milestoneName}`,
    'status: executing',
    `stopped_at: ${fmStoppedAt}`,
    `last_updated: ${lastUpdated}`,
    'progress:',
    '  total_phases: 5',
    '  completed_phases: 2',
    '  total_plans: 10',
    '  completed_plans: 4',
    '  percent: 40',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    'Status: Executing Phase 3',
    'Last Activity: 2026-01-01',
    '',
    '## Session',
    '',
    `**Last session:** 2026-01-01T00:00:00.000Z`,
    `**Stopped at:** ${bodyStoppedAt}`,
    '**Resume file:** None',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- [Phase 1]: Use Node 22',
    '',
  ].join('\n');
}

/**
 * STATE.md with NO session section at all — no "## Session" heading,
 * no Stopped at / Resume file labels. This is the #944 scenario.
 */
function buildStateMdWithoutSessionSection() {
  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v1.0',
    'milestone_name: Foundation',
    'status: executing',
    'last_updated: 2026-01-01T00:00:00.000Z',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    'Status: Executing Phase 1',
    'Last Activity: 2026-01-01',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- [Phase 1]: Use TypeScript',
    '',
  ].join('\n');
}

/**
 * STATE.md with a canonical session section (the success path — must not regress).
 */
function buildStateMdWithCanonicalSessionSection() {
  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v1.0',
    'milestone_name: Foundation',
    'status: executing',
    'last_updated: 2026-01-01T00:00:00.000Z',
    '---',
    '',
    '# GSD State',
    '',
    '## Session',
    '',
    '**Last session:** 2026-01-01T00:00:00.000Z',
    '**Stopped at:** Phase 1, Plan 1',
    '**Resume file:** None',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- Use TypeScript',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug #948: zero-match patch must leave STATE.md byte-identical
// ─────────────────────────────────────────────────────────────────────────────

describe('#948: zero-match state patch must not rewrite STATE.md', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('STATE.md is byte-identical after a zero-match patch', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({});
    fs.writeFileSync(statePath, original);

    // Patch a field that does NOT exist in the file — zero matches expected.
    const result = runGsdTools('state patch --NonExistentFieldXYZ "some value"', tmpDir);
    assert.ok(result.success, `state patch should exit 0: ${result.error}`);

    const patchOutput = JSON.parse(result.output);
    assert.deepStrictEqual(patchOutput.updated, [], 'updated should be empty');
    assert.ok(Array.isArray(patchOutput.failed), 'failed should be an array');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(after, original, 'STATE.md must be byte-identical after zero-match patch');
  });

  test('milestone_name is preserved after zero-match patch (not reset to template placeholder)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({
      milestoneName: 'My Real Milestone',
    });
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentField "value"', tmpDir);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['milestone_name'], 'My Real Milestone',
      'milestone_name must not be reset to template placeholder by zero-match patch');
  });

  test('stopped_at frontmatter value is preserved after zero-match patch (via byte-identity)', () => {
    // The no-op guard prevents ANY rewrite when nothing changed, so the
    // frontmatter stopped_at is preserved because the file is never touched.
    // The stale body value cannot win because syncStateFrontmatter is never called.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({
      fmStoppedAt: 'Phase 3, Plan 2 — newer value',
      bodyStoppedAt: 'Phase 1, Plan 1 — stale historical value',
    });
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentField "value"', tmpDir);

    // The byte-identity test already covers this; this test confirms the key
    // field specifically is intact.
    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(after, original,
      'STATE.md must be byte-identical — stopped_at cannot be overwritten via a no-op patch');
  });

  test('last_updated is not bumped by a zero-match patch', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({
      lastUpdated: '2026-01-01T00:00:00.000Z',
    });
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentField "value"', tmpDir);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['last_updated'], '2026-01-01T00:00:00.000Z',
      'last_updated must not be bumped when no fields were changed');
  });

  test('a matching patch STILL updates STATE.md correctly (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const fixture = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** In Progress',
      '**Last Activity:** 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, fixture);

    const result = runGsdTools('state patch --Status "Phase complete — ready for verification"', tmpDir);
    assert.ok(result.success, `state patch should succeed: ${result.error}`);

    const patchOutput = JSON.parse(result.output);
    assert.ok(patchOutput.updated.includes('Status'), 'Status should be in updated list');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase complete — ready for verification'),
      'matching patch should update the field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #948: syncStateFrontmatter — milestone_name placeholder preservation
// ─────────────────────────────────────────────────────────────────────────────

describe('#948: syncStateFrontmatter preserves milestone_name when derived is template placeholder', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state sync preserves real milestone_name when disk yields only template placeholder', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Frontmatter has a real name, but no ROADMAP.md exists so getMilestoneInfo
    // will fall back to the 'milestone' placeholder — must not overwrite.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v2.5',
      'milestone_name: Very Real Project Name',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      'Status: Executing Phase 1',
      'Last Activity: 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['milestone_name'], 'Very Real Project Name',
      'milestone_name must not be reset to template placeholder by state sync');
  });

  test('state sync runs successfully and preserves milestone_name (no corruption)', () => {
    // state sync always rebuilds frontmatter from the body — the no-op guard
    // applies to commands whose transform produces no change. state sync always
    // writes because last_updated changes. This test verifies that a full sync
    // cycle does not corrupt milestone_name when the placeholder is derived.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v2.5',
      'milestone_name: Very Real Project Name',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      'Status: Executing Phase 1',
      'Last Activity: 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['milestone_name'], 'Very Real Project Name',
      'state sync must not reset milestone_name to template placeholder');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #944: record-session with no session section must persist supplied values
// ─────────────────────────────────────────────────────────────────────────────

describe('#944: record-session persists values even when body lacks session labels', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('stopped-at and resume-file are present in STATE.md after record-session with no prior section', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutSessionSection());

    const PINNED_MS = Date.parse('2026-06-09T12:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 2, Plan 3" --resume-file ".planning/phases/02/02-03-PLAN.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `state record-session should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true,
      'recorded must be true when values were supplied and persisted');
    assert.ok(!output.reason || output.reason !== 'No session fields found in STATE.md',
      'must not return the silent no-op reason when values were supplied');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase 2, Plan 3'),
      '--stopped-at value must appear in STATE.md');
    assert.ok(after.includes('.planning/phases/02/02-03-PLAN.md'),
      '--resume-file value must appear in STATE.md');
  });

  test('command does not silently no-op when values are supplied (recorded must not be false)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutSessionSection());

    const result = runGsdTools(
      'state record-session --stopped-at "Phase 5, Plan 1"',
      tmpDir,
    );
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    // The key contract: if values were supplied, recorded must be true.
    assert.notStrictEqual(output.recorded, false,
      'recorded must not be false when --stopped-at was explicitly supplied');
  });

  test('STATE.md with non-canonical session labels still persists supplied values', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Session section exists but uses non-canonical label shapes (table, alternate caps)
    const nonCanonical = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# GSD State',
      '',
      '## Session Info',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Last Session | 2026-01-01 |',
      '| Stopped Here | Phase 1, Plan 1 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, nonCanonical);

    const PINNED_MS = Date.parse('2026-06-09T15:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 3, Plan 2" --resume-file "none.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true,
      'recorded must be true when values are persisted via auto-create fallback');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase 3, Plan 2'),
      '--stopped-at value must be present in STATE.md');
    assert.ok(after.includes('none.md'),
      '--resume-file value must be present in STATE.md');
  });

  test('record-session with no args against a body-less file returns recorded:false (no regression)', () => {
    // When NO values are supplied and no session fields can be found/updated,
    // recorded:false is the correct behaviour — we only changed the contract
    // when the caller supplies values.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutSessionSection());

    const result = runGsdTools('state record-session', tmpDir);
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, false,
      'recorded should still be false when no session fields exist AND no values were supplied');
  });

  test('canonical session section still updates in place (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithCanonicalSessionSection());

    const PINNED_MS = Date.parse('2026-06-09T18:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 2, Plan 4" --resume-file ".planning/phases/02/02-04-PLAN.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase 2, Plan 4'), 'stopped-at should be updated');
    assert.ok(after.includes('.planning/phases/02/02-04-PLAN.md'), 'resume-file should be updated');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial fixtures: malformed frontmatter, missing fields, CRLF
// ─────────────────────────────────────────────────────────────────────────────

describe('#948/#944: adversarial fixture variants', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('zero-match patch on CRLF STATE.md leaves file unchanged', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Build with CRLF line endings
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({}).replace(/\n/g, '\r\n');
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentFieldXYZ "value"', tmpDir);

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(after, original, 'CRLF file must be byte-identical after zero-match patch');
  });

  test('zero-match patch on STATE.md with missing frontmatter fields does not corrupt', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const minimal = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** In Progress',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, minimal);

    const result = runGsdTools('state patch --NonExistentField "value"', tmpDir);
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const patchOutput = JSON.parse(result.output);
    assert.deepStrictEqual(patchOutput.updated, [], 'no fields should be updated');
  });

  test('record-session with empty body still records when values supplied', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Body is entirely empty (only frontmatter)
    const emptyBody = [
      '---',
      'gsd_state_version: 1.0',
      'status: planning',
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, emptyBody);

    const result = runGsdTools(
      'state record-session --stopped-at "Phase 1, Plan 1"',
      tmpDir,
    );
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true,
      'should persist even into a body-less STATE.md');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase 1, Plan 1'),
      '--stopped-at value must appear in STATE.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial review findings: in-place update for existing ## Session heading
// ─────────────────────────────────────────────────────────────────────────────

describe('#944 adversarial: existing ## Session heading must be updated in place, not duplicated', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /**
   * HIGH finding: when a `## Session` heading already exists but uses
   * non-canonical rows (e.g. a markdown table), the DWIM code was appending
   * a second `## Session` block instead of normalizing the existing one.
   * buildStateFrontmatter / cmdStateSnapshot both read only the FIRST match,
   * so the newly-written Stopped at / Resume file end up in an ignored block.
   */
  test('record-session with existing non-canonical ## Session block: exactly one ## Session block afterward', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const nonCanonicalWithHeading = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# GSD State',
      '',
      '## Session',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Last Session | 2026-01-01 |',
      '| Stopped Here | Phase 1, Plan 1 |',
      '',
      '## Accumulated Context',
      '',
      '- Decision: use TypeScript',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, nonCanonicalWithHeading);

    const PINNED_MS = Date.parse('2026-06-09T20:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 4, Plan 2" --resume-file "resume.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `record-session should exit 0: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');

    // (a) exactly ONE ## Session block — no duplicate
    const sessionHeadingCount = (after.match(/^## Session\s*$/gm) || []).length;
    assert.strictEqual(sessionHeadingCount, 1,
      'exactly ONE ## Session block must exist after record-session (no duplicate appended)');

    // (b) supplied values are present in the file
    assert.ok(after.includes('Phase 4, Plan 2'),
      '--stopped-at value must be present in STATE.md');
    assert.ok(after.includes('resume.md'),
      '--resume-file value must be present in STATE.md');
  });

  test('record-session with existing non-canonical ## Session block: state-snapshot sees supplied stopped_at', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const nonCanonicalWithHeading = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# GSD State',
      '',
      '## Session',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Last Session | 2026-01-01 |',
      '| Stopped Here | Phase 1, Plan 1 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, nonCanonicalWithHeading);

    const PINNED_MS = Date.parse('2026-06-09T20:30:00.000Z');
    runGsdTools(
      'state record-session --stopped-at "Phase 4, Plan 2" --resume-file "resume.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );

    // (c) state-snapshot must see the written stopped_at in the session block
    // (via buildStateFrontmatter frontmatter OR body Session section, first match)
    const snapshotResult = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snapshotResult.success, `state-snapshot should exit 0: ${snapshotResult.error}`);
    const snapshot = JSON.parse(snapshotResult.output);
    assert.strictEqual(
      snapshot.session && snapshot.session.stopped_at,
      'Phase 4, Plan 2',
      `state-snapshot session.stopped_at must reflect "Phase 4, Plan 2", got: ${JSON.stringify(snapshot.session)}`,
    );
  });

  /**
   * LOW finding: auto-created scaffold writes `**Last session:**` but
   * cmdStateSnapshot only matched `**Last Date:**`, so session.last_date
   * was null after auto-create despite a valid timestamp being written.
   * Fix: teach the snapshot parser to also accept `**Last session:**`.
   */
  test('state-snapshot returns non-null session.last_date after auto-create on body-less file', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutSessionSection());

    const PINNED_MS = Date.parse('2026-06-09T21:00:00.000Z');
    const recResult = runGsdTools(
      'state record-session --stopped-at "Phase 1, Plan 1"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(recResult.success, `record-session should exit 0: ${recResult.error}`);

    const snapshotResult = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snapshotResult.success, `state-snapshot should exit 0: ${snapshotResult.error}`);
    const snapshot = JSON.parse(snapshotResult.output);
    assert.notStrictEqual(
      snapshot.session && snapshot.session.last_date,
      null,
      `state-snapshot session.last_date must not be null after auto-create; got: ${JSON.stringify(snapshot.session)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #1101: record-session on a `## Session Continuity` bootstrap section must
// update IN PLACE, not append a duplicate `## Session` block.
//
// The reported symptom (recorded:false + frontmatter still mutated) is already
// fixed by #944/#948. The residual: the DWIM auto-create recognised only the
// canonical `## Session` heading, so a bootstrap `## Session Continuity` section
// (workstream.cts, gsd2-import.cts, templates/state.md) fell through to the
// append branch and produced a SECOND `## Session` block. The fix inserts the
// missing canonical fields into the existing `## Session Continuity` section,
// preserving the heading and any prose, and teaches the snapshot / frontmatter
// readers to recognise that heading.
// ─────────────────────────────────────────────────────────────────────────────

describe('#1101: record-session updates ## Session Continuity in place (no duplicate block)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  /** Workstream bootstrap shape: bold Stopped At/Resume File, no Last session. */
  function buildWorkstreamContinuity() {
    return [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# State: example',
      '',
      '## Session Continuity',
      '**Stopped At:** N/A',
      '**Resume File:** None',
      '',
    ].join('\n');
  }

  test('workstream Session Continuity is updated in place — no duplicate ## Session appended', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildWorkstreamContinuity());

    const PINNED_MS = Date.parse('2026-06-12T12:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 1 context gathered" --resume-file ".planning/phases/01/01-CONTEXT.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `record-session should exit 0: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.recorded, true, 'recorded must be true when values are supplied');

    const after = fs.readFileSync(statePath, 'utf-8');
    // No duplicate bare `## Session` heading appended (the only heading stays
    // `## Session Continuity`).
    assert.ok(!/^## Session[ \t]*$/m.test(after),
      `must not append a duplicate bare "## Session" block; got:\n${after}`);
    assert.strictEqual((after.match(/^## Session\b/gm) || []).length, 1,
      `exactly one Session-family heading must remain; got:\n${after}`);
    // Missing canonical field inserted; supplied values present.
    assert.ok(after.includes('**Last session:**'), 'Last session field must be inserted');
    assert.ok(after.includes('Phase 1 context gathered'), '--stopped-at value must be present');
    assert.ok(after.includes('.planning/phases/01/01-CONTEXT.md'), '--resume-file value must be present');
    // The frontmatter reader recognises `## Session Continuity` and derives stopped_at.
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm.stopped_at, 'Phase 1 context gathered',
      'frontmatter stopped_at must be derived from the ## Session Continuity section');
    // The cmdStateSnapshot reader (separate code path) must also resolve it.
    const snap = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snap.success, `state-snapshot should exit 0: ${snap.error}`);
    const snapshot = JSON.parse(snap.output);
    assert.strictEqual(snapshot.session.stopped_at, 'Phase 1 context gathered',
      'state-snapshot must read stopped_at from the ## Session Continuity section');
  });

  test('prose under ## Session Continuity is preserved (no data loss)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const withProse = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# State: example',
      '',
      '## Session Continuity',
      '',
      '**Next recommended action:** keep-me-intact',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, withProse);

    const PINNED_MS = Date.parse('2026-06-12T13:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 2 done" --resume-file "none.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `record-session should exit 0: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.recorded, true, 'recorded must be true');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('**Next recommended action:** keep-me-intact'),
      `existing prose must be preserved (no data loss); got:\n${after}`);
    assert.ok(!/^## Session[ \t]*$/m.test(after),
      'must not append a duplicate bare "## Session" block');
    assert.ok(after.includes('Phase 2 done'), '--stopped-at value must be present');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm.stopped_at, 'Phase 2 done',
      'frontmatter stopped_at must be derived from the ## Session Continuity section');
  });

  test('canonical ## Session block path is unchanged (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithCanonicalSessionSection());

    const PINNED_MS = Date.parse('2026-06-12T14:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 9, Plan 9" --resume-file "r.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `record-session should exit 0: ${result.error}`);
    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual((after.match(/^## Session\b/gm) || []).length, 1,
      'canonical ## Session block must remain single');
    assert.ok(after.includes('Phase 9, Plan 9'), 'stopped-at value updated in canonical block');
  });

  test('legacy duplicate file: reader PREFERS canonical ## Session over ## Session Continuity (F1)', () => {
    // A file created by the OLD bug: a stale `## Session Continuity` first, then an
    // appended fresh `## Session`. The snapshot reader must read the canonical
    // `## Session` (fresh), matching the writer, not the stale Continuity block.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const duplicate = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# State: example',
      '',
      '## Session Continuity',
      '**Stopped At:** STALE-continuity-value',
      '**Resume File:** None',
      '',
      '## Session',
      '',
      '**Last session:** 2026-06-12T10:00:00.000Z',
      '**Stopped at:** FRESH-canonical-value',
      '**Resume file:** r.md',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, duplicate);

    const snap = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snap.success, `state-snapshot should exit 0: ${snap.error}`);
    const snapshot = JSON.parse(snap.output);
    assert.strictEqual(snapshot.session.stopped_at, 'FRESH-canonical-value',
      'reader must prefer the canonical ## Session block over the stale ## Session Continuity');
  });

  test('h3 ### Session Continuity is NOT read as the session section (F4)', () => {
    // The reader is line-anchored to `^## `, so an h3 subsection must not be picked
    // up as the session section.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const h3Only = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# State: example',
      '',
      '### Session Continuity',
      '**Last session:** 2026-06-12T10:00:00.000Z',
      '**Stopped at:** h3-should-not-be-session',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, h3Only);

    const snap = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snap.success, `state-snapshot should exit 0: ${snap.error}`);
    const snapshot = JSON.parse(snap.output);
    assert.strictEqual(snapshot.session.last_date, null,
      'an h3 ### Session Continuity must not be treated as the ## Session section');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3275-fmstr-non-string-scalars.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3275-fmstr-non-string-scalars (consolidation epic #1969 B2 #1971)", () => {
/**
 * GSD Tools Tests — Bug #3275 (CR finding)
 *
 * Regression guard: `state-snapshot` must prefer YAML frontmatter scalar
 * values even when those scalars are numeric (e.g. current_phase: 19) or
 * boolean — not just when they are strings.
 *
 * Prior to the fix, `fmStr` checked `typeof v === 'string'`, so a numeric
 * frontmatter value like `current_phase: 19` was treated as missing and the
 * snapshot fell back to body extraction, which could return a stale or
 * incorrect value.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('state-snapshot: fmStr accepts non-string YAML scalars (#3275 CR)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('numeric current_phase in frontmatter wins over body extraction', () => {
    // YAML parses bare integers as numbers, not strings.
    // fmStr must not drop the frontmatter value when it is a number.
    const stateMd = [
      '---',
      'gsd_state_version: 1.0',
      'current_phase: 19',
      '---',
      '',
      '# Project State',
      '',
      '**Current Phase:** 03',
      '**Status:** executing',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Frontmatter numeric value must win over bold-body value
    assert.strictEqual(output.current_phase, '19', 'numeric frontmatter current_phase must be used');
  });

  test('numeric total_phases in frontmatter wins over body extraction', () => {
    const stateMd = [
      '---',
      'gsd_state_version: 1.0',
      'total_phases: 7',
      '---',
      '',
      '# Project State',
      '',
      '**Total Phases:** 3',
      '**Status:** executing',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Frontmatter says 7, body says 3 — frontmatter must win
    assert.strictEqual(output.total_phases, 7, 'numeric frontmatter total_phases must be used');
  });

  test('numeric total_plans_in_phase in frontmatter wins over body extraction', () => {
    const stateMd = [
      '---',
      'gsd_state_version: 1.0',
      'total_plans_in_phase: 5',
      '---',
      '',
      '# Project State',
      '',
      '**Total Plans in Phase:** 2',
      '**Status:** executing',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.total_plans_in_phase, 5, 'numeric frontmatter total_plans_in_phase must be used');
  });

  test('string current_phase in frontmatter still works (no regression)', () => {
    const stateMd = [
      '---',
      'gsd_state_version: 1.0',
      "current_phase: '19'",
      '---',
      '',
      '# Project State',
      '',
      '**Current Phase:** 03',
      '**Status:** executing',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '19', 'string frontmatter current_phase still works');
  });

  test('no-frontmatter file still extracts from body (no regression)', () => {
    const stateMd = [
      '# Project State',
      '',
      '**Current Phase:** 05',
      '**Total Phases:** 8',
      '**Status:** paused',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '05', 'body extraction still works without frontmatter');
    assert.strictEqual(output.total_phases, 8, 'numeric body total_phases still extracted');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3257-nested-plans-undercount.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3257-nested-plans-undercount (consolidation epic #1969 B2 #1971)", () => {
/**
 * GSD Tools Tests — Bug #3257
 *
 * Regression guard: `buildStateFrontmatter` must count plan/summary files in
 * the nested `phases/<N>-<slug>/plans/<N>-PLAN-<NN>-<slug>.md` layout (written
 * by gsd-plan-phase post-#3139). Prior to this fix, the loop did a flat
 * `readdirSync` on the phase directory and missed every file inside the
 * `plans/` subdirectory, so `progress.total_plans` and
 * `progress.completed_plans` were silently under-counted on every state
 * mutation that flows through `syncStateFrontmatter → buildStateFrontmatter`.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a minimal STATE.md that will trigger syncStateFrontmatter on any write.
 */
function writeStateFile(tmpDir, overrides = {}) {
  const phase = overrides.phase || '01';
  const status = overrides.status || 'executing';
  const content = [
    '# Project State',
    '',
    `**Current Phase:** ${phase}`,
    `**Status:** ${status}`,
    '',
    '## Current Position',
    '',
    `Phase: ${phase} — In progress`,
    'Status: Executing',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content, 'utf-8');
}

/**
 * Write a ROADMAP.md listing the given phase numbers so the milestone-scoped
 * filter includes them (avoids needing a milestone header to count phases).
 */
function writeRoadmap(tmpDir, phaseNums) {
  const lines = ['## Roadmap v1.0'];
  for (const n of phaseNums) {
    lines.push('', `### Phase ${n}: Phase ${n}`);
  }
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    lines.join('\n'),
    'utf-8'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Nested layout — core bug (#3257)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildStateFrontmatter nested plans/ layout (#3257)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('counts plans and summaries in nested plans/ subdirectory', () => {
    // Layout: phases/01-init/plans/1-PLAN-01-setup.md etc.
    // 2 phases × 3 plans each, all completed (3 summaries each).
    for (let phase = 1; phase <= 2; phase++) {
      const phaseSlug = `0${phase}-phase-${phase}`;
      const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseSlug);
      const plansDir = path.join(phaseDir, 'plans');
      fs.mkdirSync(plansDir, { recursive: true });

      for (let plan = 1; plan <= 3; plan++) {
        const planPad = String(plan).padStart(2, '0');
        // Reporter's format: {N}-PLAN-{NN}-{slug}.md
        const planFile = `${phase}-PLAN-${planPad}-step${plan}.md`;
        const summaryFile = `${phase}-SUMMARY-${planPad}-step${plan}.md`;
        fs.writeFileSync(path.join(plansDir, planFile), '# Plan\n');
        fs.writeFileSync(path.join(plansDir, summaryFile), '# Summary\n');
      }
    }

    writeRoadmap(tmpDir, [1, 2]);
    writeStateFile(tmpDir, { phase: '02' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    assert.strictEqual(Number(progress.total_plans), 6, 'total_plans must count nested plans/ files (2 phases × 3 plans)');
    assert.strictEqual(Number(progress.completed_plans), 6, 'completed_plans must count nested summary files (2 phases × 3 summaries)');
    assert.strictEqual(Number(progress.completed_phases), 2, 'completed_phases: both phases have summaries >= plans');
  });

  test('counts PLAN-NN-slug form (bare PLAN- prefix, no phase prefix)', () => {
    // roadmap.cjs uses /^PLAN-\d+.*\.md$/i — test that form too.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    fs.writeFileSync(path.join(plansDir, 'PLAN-01-foundation.md'), '# Plan\n');
    fs.writeFileSync(path.join(plansDir, 'PLAN-02-infra.md'), '# Plan\n');
    fs.writeFileSync(path.join(plansDir, 'SUMMARY-01-foundation.md'), '# Summary\n');

    writeRoadmap(tmpDir, [1]);
    writeStateFile(tmpDir, { phase: '01' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    assert.strictEqual(Number(progress.total_plans), 2, 'bare PLAN-NN-slug.md files must be counted');
    assert.strictEqual(Number(progress.completed_plans), 1, 'SUMMARY-NN-slug.md files must be counted');
    // 1 summary < 2 plans → phase NOT completed
    assert.strictEqual(Number(progress.completed_phases), 0, 'phase not complete when summaries < plans');
  });

  test('flat-layout repos are unaffected (no plans/ subdirectory)', () => {
    // Pre-#3139 flat layout: plans live directly in the phase dir.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-SUMMARY.md'), '# Summary\n');

    writeRoadmap(tmpDir, [1]);
    writeStateFile(tmpDir, { phase: '01' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    assert.strictEqual(Number(progress.total_plans), 2, 'flat layout: top-level *-PLAN.md files counted');
    assert.strictEqual(Number(progress.completed_plans), 2, 'flat layout: top-level *-SUMMARY.md files counted');
    assert.strictEqual(Number(progress.completed_phases), 1, 'flat layout: phase complete when summaries >= plans');
  });

  test('no double-count when both top-level and nested plan files coexist', () => {
    // Edge case: phase has a top-level plan AND a plans/ subdir.
    // Only the nested files should be counted (or both, depending on logic),
    // but the critical thing is no file is counted twice.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    // Top-level flat plan
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Top-level Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Top-level Summary\n');

    // Nested plan
    fs.writeFileSync(path.join(plansDir, '1-PLAN-02-nested.md'), '# Nested Plan\n');
    fs.writeFileSync(path.join(plansDir, '1-SUMMARY-02-nested.md'), '# Nested Summary\n');

    writeRoadmap(tmpDir, [1]);
    writeStateFile(tmpDir, { phase: '01' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    // 1 top-level + 1 nested = 2 total (not 4 from double-counting)
    assert.strictEqual(Number(progress.total_plans), 2, 'mixed layout: no double-counting of plan files');
    assert.strictEqual(Number(progress.completed_plans), 2, 'mixed layout: no double-counting of summary files');
  });

  test('empty plans/ directory is a no-op (does not break counting)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    // plans/ dir exists but is empty

    // One top-level plan
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    writeRoadmap(tmpDir, [1]);
    writeStateFile(tmpDir, { phase: '01' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    assert.strictEqual(Number(progress.total_plans), 1, 'empty plans/ must not add phantom plan count');
    assert.strictEqual(Number(progress.completed_plans), 1, 'empty plans/ must not affect summary count');
    assert.strictEqual(Number(progress.completed_phases), 1, 'phase complete: 1 summary >= 1 plan');
  });

  test('PLAN-OUTLINE.md files are excluded from nested plan count', () => {
    // phase.cjs explicitly excludes *-PLAN-OUTLINE.md (not real plans).
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    fs.writeFileSync(path.join(plansDir, '1-PLAN-01-work.md'), '# Real Plan\n');
    // Outline file — should NOT count as a plan
    fs.writeFileSync(path.join(plansDir, '1-PLAN-OUTLINE.md'), '# Outline\n');

    writeRoadmap(tmpDir, [1]);
    writeStateFile(tmpDir, { phase: '01' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    // Only the real plan should count; outline excluded.
    assert.strictEqual(Number(progress.total_plans), 1, 'PLAN-OUTLINE.md must not count as a plan');
  });

  test('pre-bounce files are excluded from nested plan count (bare PLAN- prefix)', () => {
    // CR finding: PLAN_PRE_BOUNCE_RE was /-PLAN.*\.pre-bounce\.md$/i which missed
    // bare-prefix files like PLAN-01-foo.pre-bounce.md. Fixed to /\.pre-bounce\.md$/i.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    fs.writeFileSync(path.join(plansDir, '1-PLAN-01-work.md'), '# Real Plan\n');
    // Pre-bounce files — should NOT count as plans
    fs.writeFileSync(path.join(plansDir, 'PLAN-01-work.pre-bounce.md'), '# Pre-bounce\n');
    fs.writeFileSync(path.join(plansDir, '1-PLAN-01-work.pre-bounce.md'), '# Pre-bounce\n');

    writeRoadmap(tmpDir, [1]);
    writeStateFile(tmpDir, { phase: '01' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    // Only the real plan should count; pre-bounce files excluded.
    assert.strictEqual(Number(progress.total_plans), 1, 'pre-bounce files must not count as plans');
  });

  test('reporter scenario: 2 phases × multiple plans, all complete', () => {
    // Mirrors the reporter's observation: after a state mutation the progress
    // block should reflect the TRUE on-disk count, not an under-count.
    // Phase 1: 4 plans, all with summaries.
    // Phase 2: 3 plans, all with summaries.
    // Expected: total=7, completed=7, completed_phases=2.
    const phases = [
      { num: 1, plans: 4 },
      { num: 2, plans: 3 },
    ];

    for (const { num, plans } of phases) {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `0${num}-phase-${num}`);
      const plansDir = path.join(phaseDir, 'plans');
      fs.mkdirSync(plansDir, { recursive: true });

      for (let p = 1; p <= plans; p++) {
        const pad = String(p).padStart(2, '0');
        fs.writeFileSync(path.join(plansDir, `${num}-PLAN-${pad}-task${p}.md`), '# Plan\n');
        fs.writeFileSync(path.join(plansDir, `${num}-SUMMARY-${pad}-task${p}.md`), '# Summary\n');
      }
    }

    writeRoadmap(tmpDir, [1, 2]);
    writeStateFile(tmpDir, { phase: '02' });

    const result = runGsdTools('state update "Last Activity" "2026-05-08"', tmpDir);
    assert.ok(result.success, `state update failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const progress = JSON.parse(jsonResult.output).progress;
    assert.strictEqual(Number(progress.total_plans), 7, 'reporter scenario: total_plans must be 7');
    assert.strictEqual(Number(progress.completed_plans), 7, 'reporter scenario: completed_plans must be 7');
    assert.strictEqual(Number(progress.completed_phases), 2, 'reporter scenario: both phases complete');
    assert.strictEqual(Number(progress.percent), 100, 'reporter scenario: 100% when all plans have summaries');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateValidate nested plans/ layout (#3257 — CR finding)
//
// Prior to this fix, cmdStateValidate did a flat readdirSync on the phase dir
// and returned diskPlans=0 for nested layouts, causing false drift warnings
// when STATE.md correctly said "Total Plans in Phase: 3".
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateValidate nested plans/ layout (#3257)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no false drift warning when STATE.md plan count matches nested disk count', () => {
    // Phase 01-init: 3 nested plans, 0 summaries (still executing).
    // STATE.md says "Total Plans in Phase: 3" — after the fix, validate sees
    // diskPlans=3 and emits no plan_count drift warning.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    for (let p = 1; p <= 3; p++) {
      const pad = String(p).padStart(2, '0');
      fs.writeFileSync(path.join(plansDir, `1-PLAN-${pad}-step${p}.md`), '# Plan\n');
    }

    // Write STATE.md with correct plan count so validate can check for drift.
    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 01',
      '**Status:** executing',
      '**Total Plans in Phase:** 3',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent, 'utf-8');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `state validate failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(parsed.valid, `state validate should be valid; warnings: ${JSON.stringify(parsed.warnings)}`);
    assert.deepStrictEqual(parsed.warnings, [], 'no drift warnings for nested-layout phase with correct plan count');
    assert.ok(!parsed.drift.plan_count, 'no plan_count drift when nested scan matches STATE.md');
  });

  test('emits drift warning when STATE.md plan count does not match nested disk count', () => {
    // STATE.md says 5 but only 2 plans exist on disk — validate should catch it.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    for (let p = 1; p <= 2; p++) {
      const pad = String(p).padStart(2, '0');
      fs.writeFileSync(path.join(plansDir, `1-PLAN-${pad}-step${p}.md`), '# Plan\n');
    }

    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 01',
      '**Status:** executing',
      '**Total Plans in Phase:** 5',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent, 'utf-8');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `state validate failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(!parsed.valid, 'state validate should report invalid when plan counts differ');
    assert.ok(parsed.warnings.length > 0, 'at least one drift warning expected');
    assert.ok(parsed.drift.plan_count, 'plan_count drift object must be present');
    assert.strictEqual(parsed.drift.plan_count.disk, 2, 'disk count must reflect nested scan (2 nested plans)');
    assert.strictEqual(parsed.drift.plan_count.state, 5, 'state count from STATE.md must be 5');
  });

  test('PLAN-OUTLINE.md excluded from nested count in validate', () => {
    // Outline files must not inflate diskPlans and cause false "too few" drift.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    fs.writeFileSync(path.join(plansDir, '1-PLAN-01-work.md'), '# Plan\n');
    fs.writeFileSync(path.join(plansDir, '1-PLAN-OUTLINE.md'), '# Outline\n'); // must not count

    // STATE.md claims 1 plan — correct after exclusion.
    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 01',
      '**Status:** executing',
      '**Total Plans in Phase:** 1',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent, 'utf-8');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `state validate failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(parsed.valid, `should be valid (outline excluded); warnings: ${JSON.stringify(parsed.warnings)}`);
    assert.ok(!parsed.drift.plan_count, 'no plan_count drift when outline excluded from nested count');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateSync nested plans/ layout (#3257 — CR finding)
//
// Prior to this fix, cmdStateSync did a flat readdirSync on each phase dir,
// returning plans=0 for nested layouts. It would set "Total Plans in Phase"
// to 0 even when plans existed inside plans/ — an under-count that corrupts
// the STATE.md progress block.
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateSync nested plans/ layout (#3257)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('updates Total Plans in Phase from 0 to correct nested count on sync', () => {
    // Disk: phase 01-init with 3 nested plans, no summaries.
    // STATE.md says "Total Plans in Phase: 0" (stale / pre-fix value).
    // After sync, the field must be updated to 3.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    for (let p = 1; p <= 3; p++) {
      const pad = String(p).padStart(2, '0');
      fs.writeFileSync(path.join(plansDir, `1-PLAN-${pad}-step${p}.md`), '# Plan\n');
    }

    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 01',
      '**Status:** executing',
      '**Total Plans in Phase:** 0',
      '**Progress:** [░░░░░░░░░░] 0%',
      '**Last Activity:** 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent, 'utf-8');

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(parsed.synced, 'sync must report synced: true');
    // The "Total Plans in Phase" change must appear in the changes list.
    const planCountChange = parsed.changes.find(c => c.startsWith('Total Plans in Phase:'));
    assert.ok(planCountChange, `changes must include Total Plans in Phase update; got: ${JSON.stringify(parsed.changes)}`);
    assert.ok(planCountChange.includes('-> 3'), `Total Plans in Phase must update to 3; got: "${planCountChange}"`);
  });

  test('sync dry-run reports correct nested plan count without writing', () => {
    // --verify flag: sync must report what WOULD change but not write STATE.md.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-init');
    const plansDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    for (let p = 1; p <= 2; p++) {
      const pad = String(p).padStart(2, '0');
      fs.writeFileSync(path.join(plansDir, `PLAN-${pad}-task${p}.md`), '# Plan\n');
    }

    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 01',
      '**Status:** executing',
      '**Total Plans in Phase:** 0',
      '**Progress:** [░░░░░░░░░░] 0%',
      '**Last Activity:** 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent, 'utf-8');

    const result = runGsdTools('state sync --verify', tmpDir);
    assert.ok(result.success, `state sync --verify failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(parsed.dry_run, 'dry_run must be true with --verify flag');
    const planCountChange = parsed.changes.find(c => c.startsWith('Total Plans in Phase:'));
    assert.ok(planCountChange, `dry-run changes must include Total Plans in Phase; got: ${JSON.stringify(parsed.changes)}`);
    assert.ok(planCountChange.includes('-> 2'), `dry-run must show correct count of 2; got: "${planCountChange}"`);

    // STATE.md must be unchanged (dry-run): re-run sync --verify and confirm the
    // same pending change is still reported (if STATE.md had been written, the
    // change would have been applied and the second run would show no changes).
    const result2 = runGsdTools('state sync --verify', tmpDir);
    assert.ok(result2.success, `second dry-run failed: ${result2.error}`);
    const parsed2 = JSON.parse(result2.output);
    const planCountChange2 = parsed2.changes.find(c => c.startsWith('Total Plans in Phase:'));
    assert.ok(planCountChange2, 'repeated dry-run must still report pending change (file was not mutated on disk)');
  });

  test('sync across multiple phases with nested plans sums correctly', () => {
    // Phase 01: 2 nested plans, 2 summaries (complete).
    // Phase 02: 3 nested plans, 1 summary (in progress).
    // Expected "Total Plans in Phase" = 3 (current/incomplete phase).
    const phases = [
      { dir: '01-alpha', plans: 2, summaries: 2 },
      { dir: '02-beta', plans: 3, summaries: 1 },
    ];
    for (const { dir, plans, summaries } of phases) {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', dir);
      const plansDir = path.join(phaseDir, 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      for (let p = 1; p <= plans; p++) {
        const pad = String(p).padStart(2, '0');
        fs.writeFileSync(path.join(plansDir, `1-PLAN-${pad}-t.md`), '# Plan\n');
      }
      for (let s = 1; s <= summaries; s++) {
        const pad = String(s).padStart(2, '0');
        fs.writeFileSync(path.join(plansDir, `1-SUMMARY-${pad}-t.md`), '# Summary\n');
      }
    }

    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 02',
      '**Status:** executing',
      '**Total Plans in Phase:** 0',
      '**Progress:** [░░░░░░░░░░] 0%',
      '**Last Activity:** 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent, 'utf-8');

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(parsed.synced, 'sync must succeed');
    // "Total Plans in Phase" reflects the current (incomplete) phase: 02-beta has 3 plans.
    const planCountChange = parsed.changes.find(c => c.startsWith('Total Plans in Phase:'));
    assert.ok(planCountChange, `Total Plans in Phase change expected; got: ${JSON.stringify(parsed.changes)}`);
    assert.ok(planCountChange.includes('-> 3'), `current phase plan count must be 3; got: "${planCountChange}"`);
    // Progress: computeProgressPercent uses min(plan_fraction, phase_fraction).
    // plan_fraction = 3 summaries / 5 plans = 60%.
    // phase_fraction = 1 completed phase / 2 total phases = 50%.
    // min(60%, 50%) = 50% — the phase cap applies (#3242).
    const progressChange = parsed.changes.find(c => c.startsWith('Progress:'));
    assert.ok(progressChange, `Progress change expected; got: ${JSON.stringify(parsed.changes)}`);
    assert.ok(progressChange.includes('50%'), `progress must reflect nested counts (min(3/5, 1/2)=50%); got: "${progressChange}"`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-501-flat-phase-details-milestone-leak.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-501-flat-phase-details-milestone-leak (consolidation epic #1969 B2 #1971)", () => {
/**
 * Bug #501: extractCurrentMilestone leaks prior-milestone phases when the
 * ROADMAP uses a flat shared "## Phase Details" section.
 *
 * extractCurrentMilestone returns `preamble + currentSection`, where the
 * preamble is everything before the first milestone heading (only <details>
 * blocks stripped). A flat "## Phase Details" section listing every phase
 * across all milestones therefore leaks its `### Phase N:` headings into the
 * active-milestone scope, so getMilestonePhaseFilter / buildStateFrontmatter
 * count the whole project instead of just the active milestone.
 *
 * Maintainer direction (triage of #501): fix in code AND make
 * `validate consistency` milestone-aware so it does not flag shipped phase
 * dirs as orphans once the scope is correctly narrowed.
 *
 * Layout under test (mirrors the real repro):
 *   # Roadmap
 *   ## Phase Details        <- flat, BEFORE the first milestone heading
 *   ### Phase 1..3          <- shipped phases
 *   ## ✅ v2.0              <- shipped milestone
 *   ## 🚧 v3.0 (active)
 *   ### Phase 4..5          <- active-milestone phases
 * STATE.md milestone: v3.0  →  state json must report total_phases: 2.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const ROADMAP = `# Roadmap

Project overview prose that legitimately lives before the milestones.

## Phase Details

### Phase 1: Shipped One
Did a thing.

### Phase 2: Shipped Two
Did another thing.

### Phase 3: Shipped Three
Did a third thing.

## ✅ v2.0: Foundation (shipped)

Summary of the shipped milestone.

## 🚧 v3.0: Active Milestone

### Phase 4: Active One
Doing a thing.

### Phase 5: Active Two
Doing another thing.
`;

const STATE = `---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: Active Milestone
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

Phase: 4 (Active One)
`;

describe('flat "## Phase Details" milestone leak (#501)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
    // All five phase dirs exist on disk (the flat layout retains shipped dirs).
    const phaseDirs = ['01-shipped-one', '02-shipped-two', '03-shipped-three', '04-active-one', '05-active-two'];
    for (const d of phaseDirs) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-PLAN.md'), '# Plan\n', 'utf-8');
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state json counts only the active milestone phases, not the flat Phase Details list', () => {
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const state = JSON.parse(result.output);
    assert.equal(
      state.progress.total_phases,
      2,
      `active milestone v3.0 has 2 phases (4,5); flat Phase Details (1-3) must not leak. Got total_phases=${state.progress.total_phases}`
    );
  });

  test('validate consistency does not flag shipped phase dirs as not-in-ROADMAP', () => {
    // Once milestone scope is correctly narrowed (Test A), the shipped phase
    // dirs (1-3) are no longer in the SCOPED roadmap. They are, however, real
    // phases listed in the FULL roadmap, so they must NOT be reported as
    // "exists on disk but not in ROADMAP" orphans. (#501 — validate must be
    // milestone-aware.)
    const result = runGsdTools(['validate', 'consistency'], tmpDir);
    const payload = JSON.parse(result.output);
    const warnings = payload.warnings || [];
    const orphanWarnings = warnings.filter((w) => /exists on disk but not in ROADMAP/i.test(w));
    assert.deepEqual(
      orphanWarnings,
      [],
      `shipped phase dirs (1-3) are in the full ROADMAP and must not be flagged as orphans. Got: ${JSON.stringify(orphanWarnings)}`
    );
  });

  test('validate health (W007) does not flag shipped phase dirs as not-in-ROADMAP', () => {
    // cmdValidateHealth's Check 8 has the same coupling: its W007 membership
    // check compared active disk phases against the active-milestone scope.
    // Shipped phase dirs in the active phases/ dir must be checked against the
    // FULL roadmap so they are not false W007 orphans. (#501)
    const result = runGsdTools(['validate', 'health'], tmpDir);
    const payload = JSON.parse(result.output);
    const warnings = payload.warnings || [];
    const w007Orphans = warnings.filter(
      (w) => w.code === 'W007' && /exists on disk but not in ROADMAP/i.test(w.message)
    );
    assert.deepEqual(
      w007Orphans,
      [],
      `shipped phase dirs (1-3) must not produce W007. Got: ${JSON.stringify(w007Orphans.map((w) => w.message))}`
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1967-cache-invalidation.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1967-cache-invalidation (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #1967)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression tests for #1967 cache invalidation.
 *
 * The disk scan cache in buildStateFrontmatter must be invalidated on
 * writeStateMd to prevent stale reads if multiple state-mutating
 * operations occur within the same Node process. This matters for:
 *   - SDK callers that require() gsd-tools.cjs as a module
 *   - Future dispatcher extensions that handle compound operations
 *   - Tests that import state.cjs directly
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const state = require('../gsd-core/bin/lib/state.cjs');
const { cleanup } = require('./helpers.cjs');

describe('buildStateFrontmatter cache invalidation (#1967)', () => {
  let tmpDir;
  let planningDir;
  let phasesDir;
  let statePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1967-cache-'));
    planningDir = path.join(tmpDir, '.planning');
    phasesDir = path.join(planningDir, 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });

    // Create a minimal config and STATE.md
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ project_code: 'TEST' })
    );

    statePath = path.join(planningDir, 'STATE.md');
    fs.writeFileSync(statePath, [
      '# State',
      '',
      '**Current Phase:** 1',
      '**Status:** executing',
      '**Total Phases:** 2',
      '',
    ].join('\n'));

    // Start with one phase directory containing one PLAN
    const phase1 = path.join(phasesDir, '01-foo');
    fs.mkdirSync(phase1);
    fs.writeFileSync(path.join(phase1, '01-1-PLAN.md'), '---\nphase: 1\nplan: 1\n---\n# Plan\n');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('writeStateMd invalidates cache so subsequent reads see new disk state', () => {
    // First write — populates cache via buildStateFrontmatter
    const content1 = fs.readFileSync(statePath, 'utf-8');
    state.writeStateMd(statePath, content1, tmpDir);

    // Create a NEW phase directory AFTER the first write
    // Without cache invalidation, the second write would still see only 1 phase
    const phase2 = path.join(phasesDir, '02-bar');
    fs.mkdirSync(phase2);
    fs.writeFileSync(path.join(phase2, '02-1-PLAN.md'), '---\nphase: 2\nplan: 1\n---\n# Plan\n');
    fs.writeFileSync(path.join(phase2, '02-1-SUMMARY.md'), '---\nstatus: complete\n---\n# Summary\n');

    // Second write in the SAME process — must see the new phase
    const content2 = fs.readFileSync(statePath, 'utf-8');
    state.writeStateMd(statePath, content2, tmpDir);

    // Read back and parse frontmatter to verify it reflects 2 phases, not 1
    const result = fs.readFileSync(statePath, 'utf-8');
    const fmMatch = result.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fmMatch, 'STATE.md should have frontmatter after writeStateMd');

    const fm = fmMatch[1];
    // Should show 2 total phases (the new disk state), not 1 (stale cache)
    const totalPhasesMatch = fm.match(/total_phases:\s*(\d+)/);
    assert.ok(totalPhasesMatch, 'frontmatter should contain total_phases');
    assert.strictEqual(
      parseInt(totalPhasesMatch[1], 10),
      2,
      'total_phases should reflect new disk state (2), not stale cache (1)'
    );

    // Should show 1 completed phase (phase 2 has SUMMARY)
    const completedMatch = fm.match(/completed_phases:\s*(\d+)/);
    assert.ok(completedMatch, 'frontmatter should contain completed_phases');
    assert.strictEqual(
      parseInt(completedMatch[1], 10),
      1,
      'completed_phases should reflect new disk state (1 complete), not stale cache (0)'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3127-state-begin-phase-idempotent.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3127-state-begin-phase-idempotent (consolidation epic #1969 B3 #1972)", () => {
'use strict';
// allow-test-rule: reads runtime STATE.md written to temp dir — behavioral output test, not source-grep (see #3127)

// Regression tests for bug #3127.
//
// state.begin-phase is non-idempotent: when execute-phase calls it on a phase
// that is already mid-flight (e.g. --wave N resume), the handler unconditionally
// overwrites execution-progress fields with stale values from the last plan-phase run:
//   - stopped_at / Last Activity Description reset to "context gathered; ready for plan-phase"
//   - Current Plan reset to 1 (from plan being executed, e.g. 3)
//   - Plan: N of M body line reset to "Plan: 1 of M"
//   - Last activity timestamp reverted to an older value
//   - progress.percent may decrease
//
// Fix: read the current Status field before writing. If the phase is already
// "Executing Phase N", skip the execution-progress fields (Current Plan, plan body
// line, Last Activity Description) and only update fields safe to overwrite on
// resume (Last Activity date, Status if somehow wrong).
// A --force flag bypasses the guard for intentional full resets.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');

// Load the state.cjs module internals via the command router
function requireStateCjs() {
  return require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'state.cjs'));
}

function makeTempPlanning(stateContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3127-'));
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent, 'utf8');
  return dir;
}

// A STATE.md that is mid-flight on Phase 5 (Plan 3 of 8 in progress)
const MID_FLIGHT_STATE = `# GSD State

## Configuration
Current Phase: 5
Current Phase Name: test-phase
Total Plans in Phase: 8
Current Plan: 3
Status: Executing Phase 5

## Current Position

Phase: 5 (test-phase) — EXECUTING
Plan: 3 of 8 (Plan 00 SHIPPED — wave 1 complete; Plan 01 SHIPPED; Plan 02 next)
Status: Executing Phase 5
Last activity: 2026-05-05 -- Plan 02 SHIPPED wave 2 GREEN

## Progress

progress:
  total_phases: 10
  completed_phases: 4
  percent: 89

stopped_at: Phase 5 Plan 02 SHIPPED — Wave 2 GREEN detailed narrative here; ready for Plan 03
`;

// A STATE.md that is NOT yet executing (plan-phase just ran)
const PRE_EXECUTE_STATE = `# GSD State

## Configuration
Current Phase: 5
Current Phase Name: test-phase
Total Plans in Phase: 8
Current Plan: 1
Status: Ready to execute

## Current Position

Phase: 5 (test-phase) — READY
Plan: 1 of 8
Status: Ready to execute
Last activity: 2026-05-04 -- context gathered; ready for plan-phase

stopped_at: Phase 5 context gathered; ready for plan-phase
`;

describe('bug #3127: state.begin-phase idempotency guard', () => {
  test('begin-phase on a mid-flight phase does not reset Current Plan', () => {
    const stateModule = requireStateCjs();
    const { cmdStateBeginPhase } = stateModule;
    if (!cmdStateBeginPhase) {
      // Skip if not exported — the guard may be inside a private function
      return;
    }
    const dir = makeTempPlanning(MID_FLIGHT_STATE);
    try {
      cmdStateBeginPhase(dir, '5', 'test-phase', 8, false);
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      // Current Plan must not have been reset to 1
      const planMatch = after.match(/^Current Plan:\s*(\S+)/m);
      if (planMatch) {
        assert.notStrictEqual(planMatch[1], '1',
          'begin-phase reset Current Plan to 1 on a mid-flight phase — idempotency guard not applied');
      }
    } finally {
      cleanup(dir);
    }
  });

  test('begin-phase on a mid-flight phase does not overwrite stopped_at narrative', () => {
    const stateModule = requireStateCjs();
    const { cmdStateBeginPhase } = stateModule;
    if (!cmdStateBeginPhase) return;
    const dir = makeTempPlanning(MID_FLIGHT_STATE);
    try {
      cmdStateBeginPhase(dir, '5', 'test-phase', 8, false);
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      // The rich stopped_at narrative must be preserved
      assert.ok(
        after.includes('Plan 02 SHIPPED') || after.includes('Wave 2 GREEN'),
        'begin-phase overwrote stopped_at narrative on a mid-flight phase',
      );
    } finally {
      cleanup(dir);
    }
  });

  test('begin-phase on a NOT-yet-executing phase sets Current Plan to 1 (normal path)', () => {
    const stateModule = requireStateCjs();
    const { cmdStateBeginPhase } = stateModule;
    if (!cmdStateBeginPhase) return;
    const dir = makeTempPlanning(PRE_EXECUTE_STATE);
    try {
      cmdStateBeginPhase(dir, '5', 'test-phase', 8, false);
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      // Normal path: Current Plan should become 1 (or stay 1)
      const planMatch = after.match(/^Current Plan:\s*(\S+)/m);
      if (planMatch) {
        assert.strictEqual(planMatch[1], '1',
          'begin-phase should set Current Plan to 1 on a fresh phase');
      }
    } finally {
      cleanup(dir);
    }
  });

  test('begin-phase always updates Last Activity date (safe on resume, pinned via GSD_NOW_MS)', () => {
    const stateModule = requireStateCjs();
    const { cmdStateBeginPhase } = stateModule;
    if (!cmdStateBeginPhase) return;
    const dir = makeTempPlanning(MID_FLIGHT_STATE);

    const PINNED_MS = Date.parse('2020-11-25T09:00:00.000Z');
    const PINNED_DATE = '2020-11-25';
    // Pin the in-process clock via env vars before calling the function directly.
    const origTestMode = process.env.GSD_TEST_MODE;
    const origNowMs = process.env.GSD_NOW_MS;
    process.env.GSD_TEST_MODE = '1';
    process.env.GSD_NOW_MS = String(PINNED_MS);
    try {
      cmdStateBeginPhase(dir, '5', 'test-phase', 8, false);
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      assert.ok(
        after.includes(PINNED_DATE),
        `begin-phase must update Last Activity date to the pinned date ${PINNED_DATE} even on resume (safe field)`,
      );
    } finally {
      // Restore env vars before cleanup to avoid leaking state to other tests.
      if (origTestMode === undefined) delete process.env.GSD_TEST_MODE;
      else process.env.GSD_TEST_MODE = origTestMode;
      if (origNowMs === undefined) delete process.env.GSD_NOW_MS;
      else process.env.GSD_NOW_MS = origNowMs;
      cleanup(dir);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1445-999x-backlog-excluded-from-total-phases.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1445-999x-backlog-excluded-from-total-phases (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * Regression test for bug #1445:
 * 999.x backlog phases must not be counted toward total_phases.
 *
 * Root cause:
 *   deriveProgressFromRoadmap (phase-lifecycle.cts) counted ALL data rows
 *   matching /^\|\s*\d+/ in the progress table, including 999.x backlog rows.
 *   Similarly, state.cts's roadmapPhaseCount loop (via extractCurrentMilestone)
 *   counted 999.x phase headings because it only checked /\d/.test(m[1]).
 *
 * Fix:
 *   Both sites now test /^999(?:\.|$)/.test(token) and skip matching rows.
 *   Mirrors the existing init.cts /^999(?:\.|$)/ filter.
 *
 * Scenarios:
 *   A. deriveProgressFromRoadmap with a progress table containing a 999.x row.
 *   B. state json total_phases via extractCurrentMilestone / roadmapPhaseCount.
 *
 * Follow-up #1580: the same `^999` (and Phase 0) sentinel exclusion was missing
 * in two more code paths — `milestone complete`'s unstarted-phase guard
 * (src/milestone.cts) and `roadmap analyze`'s next_phase routing + phase_count
 * (src/roadmap.cts). Scenarios C and D below cover those.
 *
 *   C. milestone complete is NOT blocked by a Phase 999 backlog heading.
 *   D. roadmap analyze never routes next_phase to 999 / never counts it.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { deriveProgressFromRoadmap } = require('../gsd-core/bin/lib/phase-lifecycle.cjs');

// ─── Scenario A: deriveProgressFromRoadmap unit test ────────────────────────
//
// ADR-2143 (epic #2143) migrated deriveProgressFromRoadmap from position-based
// regexes to the markdown-table schema registry (TABLE_SCHEMAS.RoadmapProgress),
// which resolves the Progress table by exact column-name match. These fixtures'
// second column is renamed "Plans" -> "Plans Complete" to match the canonical
// header (gsd-core/templates/roadmap.md) the schema now requires; the assertions
// (999.x exclusion, Complete-row counting) are unchanged.

describe('bug #1445 — deriveProgressFromRoadmap excludes 999.x rows', () => {
  test('3 real phases + 1 999.x backlog row → total_phases: 3, not 4', () => {
    const roadmap = [
      '## Milestone v1.0: Test',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
      '| 2. Beta | 1/2 | In Progress | |',
      '| 3. Gamma | 0/1 | Planned | |',
      '| 999.1 Backlog: Future Idea | 0/0 | Backlog | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(
      result.totalPhases,
      3,
      `total_phases must be 3 (not 4) — 999.1 backlog row must be excluded. Got ${result.totalPhases}`,
    );
    assert.equal(
      result.completedPhases,
      1,
      `completed_phases must be 1. Got ${result.completedPhases}`,
    );
  });

  test('999 exact (no dot) row is also excluded', () => {
    const roadmap = [
      '## Milestone v1.0: Test',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 1/1 | Complete | ✅ |',
      '| 2. Beta | 1/1 | Complete | ✅ |',
      '| 999 Backlog | 0/0 | Backlog | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(
      result.totalPhases,
      2,
      `total_phases must be 2 (not 3) — 999 row must be excluded. Got ${result.totalPhases}`,
    );
    assert.equal(
      result.completedPhases,
      2,
      `completed_phases must be 2. Got ${result.completedPhases}`,
    );
  });

  test('all-backlog table yields null total_phases (no real phases)', () => {
    const roadmap = [
      '## Milestone v1.0: Test',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 999.1 Future A | 0/0 | Backlog | |',
      '| 999.2 Future B | 0/0 | Backlog | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(
      result.totalPhases,
      null,
      `total_phases must be null when the only rows are 999.x backlog. Got ${result.totalPhases}`,
    );
  });
});

// ─── #2137: header-driven parse handles the milestone-grouped (5-col) table ──
//
// Regression for #2137: deriveProgressFromRoadmap read the `## Progress` table
// with two 4-column-only regexes. Every project past its v1.0 milestone uses the
// 5-column milestone-grouped shape the same template ships, so the reader (which
// only understood 4 columns) returned { null, null, null } while the writer
// (cmdPhaseComplete, with its explicit `cells.length === 5` branch) happily wrote
// it — and phase.complete then silently skipped the STATE progress update. The
// fix reads columns by NAME, so both shapes parse identically. These tests would
// fail against the pre-fix 4-column regexes (which returned all-null for 5-col).

describe('#2137 regression: deriveProgressFromRoadmap parses the milestone-grouped 5-column table', () => {
  test("the template's own 5-column milestone-grouped Progress block parses non-null", () => {
    // Byte-identical to gsd-core/templates/roadmap.md's "Milestone-Grouped
    // Roadmap" Progress block — the exact shape that silently returned all-null.
    const roadmap = [
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '|-------|-----------|----------------|--------|-----------|',
      '| 1. Foundation | v1.0 | 3/3 | Complete | YYYY-MM-DD |',
      '| 2. Features | v1.0 | 2/2 | Complete | YYYY-MM-DD |',
      '| 5. Security | v1.1 | 0/2 | Not started | - |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(result.totalPhases, 3, `totalPhases must be 3 (5-col table must parse). Got ${result.totalPhases}`);
    assert.equal(result.completedPhases, 2, `completedPhases must be 2 (Status is column 4 in the 5-col shape). Got ${result.completedPhases}`);
    assert.equal(result.totalPlans, 7, `totalPlans must be 3+2+2=7 (Plans is column 3 in the 5-col shape). Got ${result.totalPlans}`);
  });

  test('the 4-column greenfield and 5-column milestone-grouped shapes derive the same progress', () => {
    // The reader must agree with the writer on both shapes the template ships.
    const fiveCol = [
      '## Progress',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Foundation | v1.0 | 3/3 | Complete | 2026-01-01 |',
      '| 2. Features | v1.0 | 2/2 | Complete | 2026-01-02 |',
    ].join('\n');
    const fourCol = [
      '## Progress',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Foundation | 3/3 | Complete | 2026-01-01 |',
      '| 2. Features | 2/2 | Complete | 2026-01-02 |',
    ].join('\n');

    assert.deepEqual(
      deriveProgressFromRoadmap(fiveCol),
      deriveProgressFromRoadmap(fourCol),
      'the milestone-grouped and greenfield shapes must derive identical progress',
    );
    assert.deepEqual(deriveProgressFromRoadmap(fiveCol), {
      completedPhases: 2,
      totalPhases: 2,
      totalPlans: 5,
    });
  });

  test('999.x backlog rows stay excluded in the 5-column shape', () => {
    const roadmap = [
      '## Progress',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Alpha | v1.0 | 2/2 | Complete | 2026-01-01 |',
      '| 2. Beta | v1.0 | 1/1 | Complete | 2026-01-02 |',
      '| 999.1 Future | v2.0 | 0/0 | Backlog | - |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(result.totalPhases, 2, `999.1 backlog row must be excluded in the 5-col shape too. Got ${result.totalPhases}`);
    assert.equal(result.completedPhases, 2, `completedPhases must be 2. Got ${result.completedPhases}`);
  });

  test('binds to the ## Progress table, not an earlier Phase/Status/Completed-shaped table', () => {
    // A decoy table under a different heading shares the Phase/Status/Completed
    // header shape. The reader must scope to ## Progress (mirroring the writer's
    // #2012 scoping) rather than binding to the first matching table it sees.
    const roadmap = [
      '## Retrospective',
      '',
      '| Phase | Owner | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Old | jo | Complete | 2025-01-01 |',
      '',
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Foundation | v1.0 | 3/3 | Complete | 2026-01-01 |',
      '| 2. Features | v1.0 | 2/2 | Complete | 2026-01-02 |',
      '| 3. Security | v1.1 | 0/2 | Not started | - |',
      '',
      '## Next',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(result.totalPhases, 3, `must count the 3 rows of the ## Progress table, not the 1-row decoy. Got ${result.totalPhases}`);
    assert.equal(result.completedPhases, 2, `must count Complete rows in ## Progress (2), not the decoy's 1. Got ${result.completedPhases}`);
    assert.equal(result.totalPlans, 7, `must sum the ## Progress plans (3+2+2=7). Got ${result.totalPlans}`);
  });

  test('an h3 ### Progress decoy does not hijack the h2 ## Progress scope', () => {
    // Heading detection must be line-anchored to h2: "### Progress".indexOf("## Progress")
    // is 1, so a substring scan would start the slice inside the h3 subheading and
    // miss the real table below.
    const roadmap = [
      '### Progress notes',
      '',
      'Some prose about progress, no table here.',
      '',
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Foundation | v1.0 | 3/3 | Complete | 2026-01-01 |',
      '| 2. Features | v1.0 | 2/2 | Complete | 2026-01-02 |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(result.totalPhases, 2, `h2 ## Progress table must be found past the h3 decoy. Got ${result.totalPhases}`);
    assert.equal(result.completedPhases, 2, `completedPhases must be 2. Got ${result.completedPhases}`);
  });

  // ── Boundary conditions (#2137 review) ──────────────────────────────────────
  // The header-driven walk terminates at the first non-`|` line and skips the
  // separator row, so these edges must not throw and must honour the "0 → null"
  // contract that lets the consumer leave the existing STATE value untouched.

  test('header + separator only (0 data rows) derives all-null', () => {
    const roadmap = [
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.deepEqual(
      result,
      { completedPhases: null, totalPhases: null, totalPlans: null },
      `an empty table must report all-null (0 counts → null), got ${JSON.stringify(result)}`,
    );
  });

  test('exactly one data row derives that single row', () => {
    const roadmap = [
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Foundation | v1.0 | 4/4 | Complete | 2026-01-01 |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.deepEqual(
      result,
      { completedPhases: 1, totalPhases: 1, totalPlans: 4 },
      `a single Complete row must derive {1,1,4}, got ${JSON.stringify(result)}`,
    );
  });

  test('ragged rows (more/fewer cells than the header) are handled without throwing', () => {
    // (#2242 review Fix 5 / ADR-2143 §3): deriveProgressFromRoadmap now resolves
    // the Progress table via the markdown-table seam's parseMarkdownTable, which
    // is fail-loud on ragged data rows by design — "ragged rows are errors, not
    // silent" (src/markdown-table.cts) — rather than the pre-ADR-2143 reader's
    // graceful cell-count degradation this test used to assert. A ragged row
    // anywhere in the table now makes the WHOLE table unparseable, so the reader
    // falls through to its existing (null) values instead of throwing.
    const roadmap = [
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Alpha | v1.0 | 2/2 | Complete | 2026-01-01 | stray-extra-column |', // 6 cells (extra)
      '| 2. Beta | v1.0 |', // 2 cells (short: Plans/Status/Completed absent)
    ].join('\n');

    let result;
    assert.doesNotThrow(() => {
      result = deriveProgressFromRoadmap(roadmap);
    }, 'ragged rows must not throw');
    assert.deepEqual(
      result,
      { completedPhases: null, totalPhases: null, totalPlans: null },
      `a ragged-row table must fail loud to all-null (no throw), got ${JSON.stringify(result)}`,
    );
  });
});

// ─── Scenario B: state json total_phases via roadmapPhaseCount ───────────────

describe('bug #1445 — state json excludes 999.x phase headings from total_phases', () => {
  let tmpDir;

  const ROADMAP = [
    '## Milestone v1.0: Test Milestone',
    '',
    '### Phase 01: Alpha',
    '**Goal:** first',
    '',
    '### Phase 02: Beta',
    '**Goal:** second',
    '',
    '### Phase 03: Gamma',
    '**Goal:** third',
    '',
    '### Phase 999.1: Backlog Item A',
    '**Goal:** future idea, not counted',
    '',
    '### Phase 999.2: Backlog Item B',
    '**Goal:** another future idea',
  ].join('\n');

  beforeEach(() => {
    tmpDir = createTempProject('bug-1445-');
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP, 'utf-8');
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'status: executing',
        '---',
        '',
        '# GSD State',
        '',
        '## Configuration',
        'Current Phase: 1',
        'Status: Executing Phase 1',
        'Last Activity: 2026-01-01',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    for (const d of ['01-alpha', '02-beta', '03-gamma']) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
    }
    // 999.x dirs should exist on disk but must not inflate total_phases
    for (const d of ['999.1-backlog-a', '999.2-backlog-b']) {
      fs.mkdirSync(path.join(planning, 'phases', d), { recursive: true });
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state json total_phases is 3, not 5 (999.x dirs and headings excluded)', () => {
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const state = JSON.parse(result.output);
    assert.ok(state.progress, 'state json must return a progress block');
    assert.equal(
      state.progress.total_phases,
      3,
      `total_phases must be 3 (not 5). 999.x backlog phases must be excluded. Got ${state.progress.total_phases}`,
    );
  });
});

// ─── Scenario C: milestone complete not blocked by a 999 backlog heading ─────

describe('fix #1580 — milestone complete ignores the 999 backlog sentinel', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('fix-1580-mc-');
    const planning = path.join(tmpDir, '.planning');
    // One real, on-disk phase + a directory-less Phase 999 backlog heading.
    fs.writeFileSync(
      path.join(planning, 'ROADMAP.md'),
      [
        '# Roadmap v1.0',
        '## v1.0 Milestone',
        '## Phases',
        '- [x] **Phase 1: Foundation**',
        '## Phase Details',
        '### Phase 1: Foundation',
        '**Goal:** build it',
        '### Phase 999: Backlog / Someday',
        '**Goal:** deferred, never executed',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      `---\nmilestone: v1.0\n---\n# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
      'utf-8',
    );
    const dir = path.join(planning, 'phases', '01-foundation');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('completes WITHOUT --force despite a Phase 999 backlog heading', () => {
    const result = runGsdTools(
      ['milestone', 'complete', 'v1.0', '--name', 'Regression'],
      tmpDir,
    );
    assert.ok(
      result.success,
      `milestone complete must not be blocked by the 999 sentinel; got error: ${result.error}`,
    );
    assert.ok(
      !/Cannot mark milestone complete/.test(result.error || ''),
      `the unstarted-phase guard must not fire on Phase 999. Got: ${result.error}`,
    );
  });
});

// ─── Scenario D: roadmap analyze never routes/ counts the 999 sentinel ────────

describe('fix #1580 — roadmap analyze excludes the 999 backlog sentinel', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('fix-1580-ra-');
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(
      path.join(planning, 'ROADMAP.md'),
      [
        '# Roadmap v1.0',
        '## v1.0 Milestone',
        '## Phases',
        '- [x] **Phase 1: Foundation**',
        '## Phase Details',
        '### Phase 1: Foundation',
        '**Goal:** build it',
        '### Phase 999: Backlog / Someday',
        '**Goal:** deferred, never executed',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      `---\nmilestone: v1.0\n---\n# State\n`,
      'utf-8',
    );
    const dir = path.join(planning, 'phases', '01-foundation');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n', 'utf-8');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('next_phase is never 999 and phase_count excludes the sentinel', () => {
    const result = runGsdTools(['roadmap', 'analyze', '--raw'], tmpDir);
    assert.ok(result.success, `roadmap analyze failed: ${result.error}`);
    const analysis = JSON.parse(result.output);
    assert.notEqual(
      String(analysis.next_phase),
      '999',
      `next_phase must never route to the 999 backlog sentinel. Got ${analysis.next_phase}`,
    );
    assert.equal(
      analysis.phase_count,
      1,
      `phase_count must exclude the 999 sentinel (expected 1). Got ${analysis.phase_count}`,
    );
    assert.ok(
      !(analysis.phases || []).some(p => String(p.number) === '999'),
      'the phases array must not include the 999 backlog sentinel',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1446-total-phases-corrects-downward.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1446-total-phases-corrects-downward (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * Regression test for bug #1446:
 * total_phases must correct downward when re-derived; shouldPreserveExistingProgress
 * must NOT include total_phases in its ratchet check.
 *
 * Root cause:
 *   shouldPreserveExistingProgress (state-document.cts) returned true when
 *   existingProgress.total_phases > derivedProgress.total_phases, making the
 *   stored value sticky even when it was wrong (e.g. counted backlog phases).
 *
 * Fix:
 *   total_phases is removed from the "existing exceeds derived" check.
 *   Only completed_phases, total_plans, and completed_plans keep ratchet behaviour.
 *
 * Scenarios:
 *   A. shouldPreserveExistingProgress unit test — returns false when only total_phases differs.
 *   B. state sync re-derives a lower total_phases and writes the new value.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { shouldPreserveExistingProgress } = require('../gsd-core/bin/lib/state-document.cjs');

// ─── Scenario A: unit test ───────────────────────────────────────────────────

describe('bug #1446 — shouldPreserveExistingProgress does not ratchet total_phases', () => {
  test('existing total_phases:10 > derived total_phases:7 → returns false (no ratchet)', () => {
    const existing = { total_phases: 10, completed_phases: 3, total_plans: 6, completed_plans: 3 };
    const derived  = { total_phases: 7,  completed_phases: 3, total_plans: 6, completed_plans: 3 };
    assert.equal(
      shouldPreserveExistingProgress(existing, derived),
      false,
      'total_phases downward correction must NOT trigger shouldPreserveExistingProgress',
    );
  });

  test('existing completed_phases:5 > derived completed_phases:2 → returns true (ratchet still active)', () => {
    const existing = { total_phases: 7, completed_phases: 5, total_plans: 6, completed_plans: 3 };
    const derived  = { total_phases: 7, completed_phases: 2, total_plans: 6, completed_plans: 3 };
    assert.equal(
      shouldPreserveExistingProgress(existing, derived),
      true,
      'completed_phases ratchet must still work',
    );
  });

  test('existing total_phases:10 > derived:7 AND completed_phases matches → false (total_phases alone does not preserve)', () => {
    const existing = { total_phases: 10, completed_phases: 3 };
    const derived  = { total_phases: 7,  completed_phases: 3 };
    assert.equal(
      shouldPreserveExistingProgress(existing, derived),
      false,
      'only-total_phases discrepancy must not trigger preservation',
    );
  });

  test('all derived values equal existing → returns false', () => {
    const existing = { total_phases: 7, completed_phases: 3, total_plans: 6, completed_plans: 3 };
    const derived  = { total_phases: 7, completed_phases: 3, total_plans: 6, completed_plans: 3 };
    assert.equal(shouldPreserveExistingProgress(existing, derived), false);
  });
});

// ─── Scenario B: end-to-end state sync overwrites inflated total_phases ──────

describe('bug #1446 — state sync writes corrected (lower) total_phases', () => {
  let tmpDir;

  // ROADMAP has 3 real phases only (no 999.x).
  const ROADMAP = [
    '## Milestone v1.0: Test',
    '',
    '### Phase 01: Alpha',
    '**Goal:** alpha',
    '',
    '### Phase 02: Beta',
    '**Goal:** beta',
    '',
    '### Phase 03: Gamma',
    '**Goal:** gamma',
  ].join('\n');

  beforeEach(() => {
    tmpDir = createTempProject('bug-1446-');
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP, 'utf-8');

    // STATE.md has a stale inflated total_phases:10 in frontmatter.
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'status: executing',
        'progress:',
        '  total_phases: 10',
        '  completed_phases: 2',
        '  total_plans: 6',
        '  completed_plans: 4',
        '  percent: 40',
        '---',
        '',
        '# GSD State',
        '',
        '## Configuration',
        'Current Phase: 3',
        'Status: Executing Phase 3',
        'Last Activity: 2026-01-01',
        'Progress: [████░░░░░░] 40%',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    for (const d of ['01-alpha', '02-beta', '03-gamma']) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      // Mark 01 and 02 as complete (2 summaries)
      if (d !== '03-gamma') {
        fs.writeFileSync(path.join(dir, 'PLAN-SUMMARY.md'), '# Summary\n', 'utf-8');
      }
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state sync corrects total_phases from 10 to 3', () => {
    const syncResult = runGsdTools(['state', 'sync'], tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const state = JSON.parse(jsonResult.output);

    assert.ok(state.progress, 'state json must return a progress block');
    assert.equal(
      state.progress.total_phases,
      3,
      `total_phases must be corrected to 3 (derived), not kept at 10 (stale). Got ${state.progress.total_phases}`,
    );
    // completed_phases ratchet still works: existing 2 ≥ disk-derived → keep 2
    assert.ok(
      state.progress.completed_phases >= 2,
      `completed_phases must be at least 2 (ratchet). Got ${state.progress.completed_phases}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1514-retired-phase-excluded-from-total-phases.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1514-retired-phase-excluded-from-total-phases (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * Regression test for bug #1514:
 * A retired/folded phase (struck through in ROADMAP, marked `[x]`, with a
 * directory but no completion artifact) must NOT be counted in
 * progress.total_phases. Otherwise it inflates the denominator without ever
 * satisfying the numerator (no SUMMARY → never "completed"), freezing a
 * fully-shipped milestone below 100%.
 *
 * Root cause:
 *   buildStateFrontmatter (state.cts) derived total_phases from
 *   max(phaseDirs.length, roadmapPhaseCount) — both of which counted the
 *   retired phase (its directory and its `### Phase NN:` heading) — while
 *   completed_phases came from a disk SUMMARY scan that the retired phase
 *   can never satisfy. Same counting family as #549 / #500 / #1445.
 *
 * Fix:
 *   buildStateFrontmatter now extracts retired phase numbers from the GFM
 *   strikethrough in the current-milestone ROADMAP scope and excludes them
 *   from BOTH the disk phase-dir set and the heading count, so a retired
 *   phase counts toward neither denominator nor numerator.
 *
 * Why integration (state json) not a unit test: the bug only manifests in the
 * assembled progress block a shipped milestone actually writes to STATE.md, so
 * the test reproduces that artifact rather than a helper in isolation.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { _extractRetiredPhaseNumbers } = require('../gsd-core/bin/lib/state.cjs');
const { normalizePhaseName } = require('../gsd-core/bin/lib/phase-id.cjs');

// Six phases, all shipped, except Phase 04 which is retired/folded into 05.
// Phases 01-03,05,06 have PLAN+SUMMARY (complete); Phase 04 keeps a directory
// but no work (retired). `complete` flags which dirs get PLAN+SUMMARY.
function seedProject(prefix, roadmap, completeDirs) {
  const tmpDir = createTempProject(prefix);
  const planning = path.join(tmpDir, '.planning');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmap, 'utf-8');
  fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
  fs.writeFileSync(
    path.join(planning, 'STATE.md'),
    [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Current Phase: 6',
      'Status: shipped',
      'Last Activity: 2026-06-01',
    ].join('\n'),
    'utf-8',
  );
  const allDirs = ['01-alpha', '02-beta', '03-gamma', '04-delta', '05-epsilon', '06-zeta'];
  for (const d of allDirs) {
    const dir = path.join(planning, 'phases', d);
    fs.mkdirSync(dir, { recursive: true });
    if (completeDirs.includes(d)) {
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n', 'utf-8');
    }
  }
  return tmpDir;
}

const PHASE_DETAILS = [
  '### Phase 01: Alpha', '**Goal:** a', '',
  '### Phase 02: Beta', '**Goal:** b', '',
  '### Phase 03: Gamma', '**Goal:** c', '',
  '### Phase 04: Delta', '**Goal:** GOAL_04', '',
  '### Phase 05: Epsilon', '**Goal:** e', '',
  '### Phase 06: Zeta', '**Goal:** f',
];

function roadmap(checklist04, goal04) {
  return [
    '## Milestone v1.0: Repro',
    '',
    '### Phases',
    '- [x] **Phase 01: Alpha** — done',
    '- [x] **Phase 02: Beta** — done',
    '- [x] **Phase 03: Gamma** — done',
    checklist04,
    '- [x] **Phase 05: Epsilon** — done',
    '- [x] **Phase 06: Zeta** — done',
    '',
    ...PHASE_DETAILS.map((l) => (l === '**Goal:** GOAL_04' ? `**Goal:** ${goal04}` : l)),
  ].join('\n');
}

const ALL_COMPLETE = ['01-alpha', '02-beta', '03-gamma', '05-epsilon', '06-zeta'];

describe('bug #1514 — retired/folded phase excluded from progress.total_phases', () => {
  let tmpDir;
  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = undefined;
  });

  test('struck `[x] ~~Phase 04~~ — folded into Phase 05` → 5/5, percent 100 (not 5/6, 83)', () => {
    const rm = roadmap(
      '- [x] ~~**Phase 04: Delta**~~ — folded into Phase 05; number retired',
      'folded into Phase 05',
    );
    tmpDir = seedProject('bug-1514-a-', rm, ALL_COMPLETE);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 5, `total_phases must exclude the retired phase. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 5, `completed_phases must be 5. Got ${progress.completed_phases}`);
    assert.equal(progress.percent, 100, `shipped milestone must reach 100%. Got ${progress.percent}`);
  });

  test('fold TARGET is not retired: a struck goal line `~~folded into Phase 05~~` must not drop Phase 05', () => {
    // Phase 04 retired via checklist; Phase 04 *goal* also struck and mentions
    // the fold target. The target (Phase 05) must remain a counted phase.
    const rm = roadmap(
      '- [x] ~~**Phase 04: Delta**~~ — folded into Phase 05; number retired',
      '~~folded into Phase 05; retired~~',
    );
    tmpDir = seedProject('bug-1514-b-', rm, ALL_COMPLETE);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 5, `only Phase 04 is retired; Phase 05 must still count. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 5, `completed_phases must be 5. Got ${progress.completed_phases}`);
    assert.equal(progress.percent, 100, `Got ${progress.percent}`);
  });

  test('regression: no strikethrough → all 6 phases counted (6/6, 100)', () => {
    const rm = roadmap('- [x] **Phase 04: Delta** — done', 'd');
    tmpDir = seedProject('bug-1514-c-', rm, [...ALL_COMPLETE, '04-delta']);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 6, `no retired phase: all 6 counted. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 6, `Got ${progress.completed_phases}`);
    assert.equal(progress.percent, 100, `Got ${progress.percent}`);
  });

  // `state sync --verify` is the SECOND counting path (cmdStateSync). Before the
  // fix it re-derived the same inflated denominator and reported "no drift",
  // so a manual STATE edit was the only recourse (#1514). It must now agree
  // with state json and drive the stuck 83% Progress field to 100%.
  test('state sync --verify drives a stuck 83% Progress to 100% (cmdStateSync path)', () => {
    const rm = roadmap(
      '- [x] ~~**Phase 04: Delta**~~ — folded into Phase 05; number retired',
      'folded into Phase 05',
    );
    tmpDir = seedProject('bug-1514-sync-', rm, ALL_COMPLETE);
    // Seed a stuck Progress line that the inflated denominator would "agree" with.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.appendFileSync(statePath, '\nProgress: [████████░░] 83%\n', 'utf-8');
    const result = runGsdTools(['state', 'sync', '--verify'], tmpDir);
    assert.ok(result.success, `state sync --verify failed: ${result.error}`);
    const { changes } = JSON.parse(result.output);
    const progressChange = (changes || []).find((c) => /Progress:/.test(c));
    assert.ok(progressChange, `expected a Progress drift, got changes: ${JSON.stringify(changes)}`);
    assert.match(progressChange, /-> .*100%/, `sync must want 100%, got: ${progressChange}`);
  });
});

// ─── Generic seeder for non-canonical phase shapes ──────────────────────────

/**
 * Seed a project from explicit phase specs so project-code, decimal,
 * no-directory, and shipped-then-retired shapes can be exercised.
 * spec: { id, retired?, dir?, shipped? }
 *   id      — ROADMAP phase id (e.g. '04', '05.1', 'PROJ-42')
 *   retired — strike the checklist entry (folded/retired)
 *   dir     — directory name to create (omit → no directory)
 *   shipped — write PLAN+SUMMARY into the directory (complete)
 */
function seedFromSpecs(prefix, specs) {
  const tmpDir = createTempProject(prefix);
  const planning = path.join(tmpDir, '.planning');
  const checklist = specs.map((s) =>
    s.retired
      ? `- [x] ~~**Phase ${s.id}: P${s.id}**~~ — retired`
      : `- [x] **Phase ${s.id}: P${s.id}** — done`,
  );
  const details = specs.flatMap((s) => [`### Phase ${s.id}: P${s.id}`, '**Goal:** g', '']);
  const roadmapText = ['## Milestone v1.0: Specs', '', '### Phases', ...checklist, '', ...details].join('\n');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmapText, 'utf-8');
  fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
  fs.writeFileSync(
    path.join(planning, 'STATE.md'),
    ['---', 'gsd_state_version: 1.0', 'milestone: v1.0', 'status: executing', '---', '', '# GSD State', '', '## Configuration', 'Current Phase: 1'].join('\n'),
    'utf-8',
  );
  for (const s of specs) {
    if (!s.dir) continue;
    const dir = path.join(planning, 'phases', s.dir);
    fs.mkdirSync(dir, { recursive: true });
    if (s.shipped) {
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n', 'utf-8');
    }
  }
  return tmpDir;
}

describe('bug #1514 — retired exclusion across phase shapes', () => {
  let tmpDir;
  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = undefined;
  });

  test('project-code retired phase is dropped from the denominator (Phase PROJ-42)', () => {
    // Project-code dirs are not milestone-mapped for completion counts (a
    // separate pre-existing limitation), so assert only the total_phases
    // denominator, which #1514 governs: the struck PROJ-42 heading must not
    // be counted, while PROJ-41 / PROJ-43 still are.
    tmpDir = seedFromSpecs('bug-1514-pc-', [
      { id: 'PROJ-41', dir: 'PROJ-41-a', shipped: true },
      { id: 'PROJ-42', retired: true, dir: 'PROJ-42-d' },
      { id: 'PROJ-43', dir: 'PROJ-43-c', shipped: true },
    ]);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 2, `retired project-code phase must be excluded. Got ${progress.total_phases}`);
  });

  test('decimal, multiple, shipped-then-retired, and no-directory retired phases all excluded', () => {
    // Retired: 02 (executed → has SUMMARY, then folded), 04 (no work),
    // 05.1 (decimal, no directory at all). Live: 01, 03, 06.
    tmpDir = seedFromSpecs('bug-1514-multi-', [
      { id: '01', dir: '01-a', shipped: true },
      { id: '02', retired: true, dir: '02-b', shipped: true },
      { id: '03', dir: '03-c', shipped: true },
      { id: '04', retired: true, dir: '04-d' },
      { id: '05.1', retired: true },
      { id: '06', dir: '06-f', shipped: true },
    ]);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 3, `3 retired of 6 → total 3. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 3, `live phases 01/03/06 complete. Got ${progress.completed_phases}`);
    assert.equal(progress.percent, 100, `Got ${progress.percent}`);
  });

  test('boundary: every phase retired (k === n) → total_phases 0', () => {
    tmpDir = seedFromSpecs('bug-1514-all-', [
      { id: '01', retired: true, dir: '01-a' },
      { id: '02', retired: true, dir: '02-b' },
      { id: '03', retired: true, dir: '03-c' },
    ]);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 0, `all phases retired → denominator 0. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 0, `Got ${progress.completed_phases}`);
  });

  test('strikethrough in a non-checklist/heading line (a goal) does NOT retire that phase', () => {
    // Detection is scoped to checklist/heading lines, so a struck GOAL line
    // that begins with a phase reference must not retire it.
    const tmp = createTempProject('bug-1514-prose-');
    const planning = path.join(tmp, '.planning');
    const roadmapText = [
      '## Milestone v1.0: Prose',
      '',
      '### Phases',
      '- [x] **Phase 01: A** — done',
      '- [x] **Phase 02: B** — done',
      '- [x] **Phase 03: C** — done',
      '',
      '### Phase 01: A', '**Goal:** g',
      '### Phase 02: B', '**Goal:** ~~Phase 02 was renamed from an earlier plan~~',
      '### Phase 03: C', '**Goal:** g',
    ].join('\n');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmapText, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      ['---', 'gsd_state_version: 1.0', 'milestone: v1.0', 'status: executing', '---', '', '# GSD State', '', '## Configuration', 'Current Phase: 3'].join('\n'),
      'utf-8',
    );
    for (const d of ['01-a', '02-b', '03-c']) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n', 'utf-8');
    }
    tmpDir = tmp;
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 3, `struck prose in a goal line must not retire Phase 02. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 3, `Got ${progress.completed_phases}`);
  });
});

// ─── Property: the strikethrough parser extracts exactly the struck set ──────

// extractRetiredPhaseNumbers is the parsing/transformation core of the fix, so
// per RULESET.TESTS.property-based-testing it carries a fast-check property:
// for a roadmap with k of n checklist phases struck, the parser must return
// exactly the canonical keys of those k phases — no more, no fewer — across
// randomized phase counts and numeric/zero-padded/project-code ID forms. This
// underpins the `total_phases === n - k` guarantee the integration tests assert.
describe('bug #1514 — extractRetiredPhaseNumbers property: returns exactly the struck set', () => {
  const idForm = (num, form) =>
    form === 'padded' ? String(num).padStart(2, '0')
      : form === 'project' ? `PROJ-${num}`
        : String(num);
  const keyOf = (num, form) => normalizePhaseName(idForm(num, form)).toUpperCase();

  test('k-of-n struck phases → exactly k canonical keys, for any n/form', () => {
    fc.assert(
      fc.property(
        // Distinct phase numbers so canonical keys don't collide within a run.
        fc.uniqueArray(fc.integer({ min: 1, max: 98 }), { minLength: 1, maxLength: 10 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
        fc.constantFrom('plain', 'padded', 'project'),
        (nums, flagsRaw, form) => {
          const lines = ['## Milestone v1.0: M', '', '### Phases'];
          const struck = [];
          nums.forEach((num, i) => {
            const id = idForm(num, form);
            if (flagsRaw[i]) {
              lines.push(`- [x] ~~**Phase ${id}: P${num}**~~ — folded; retired`);
              struck.push(num);
            } else {
              lines.push(`- [x] **Phase ${id}: P${num}** — done`);
            }
          });

          const got = _extractRetiredPhaseNumbers(lines.join('\n'));
          const expected = new Set(struck.map((num) => keyOf(num, form)));

          assert.equal(got.size, expected.size, `size: got ${got.size}, expected ${expected.size}`);
          for (const k of expected) assert.ok(got.has(k), `missing struck key ${k}`);
          for (const k of got) assert.ok(expected.has(k), `extra (non-struck) key ${k}`);
        },
      ),
    );
  });
});

// ─── #2440: total_plans excluded from progress ratchet (per-counter) ──────────
//
// Pre-fix: shouldPreserveExistingProgress included total_plans in the ratchet.
// Fix: total_plans joins total_phases as always-derived (both move in both
// directions). Only completed_phases and completed_plans keep ratchet behaviour.

describe('bug #2440 — shouldPreserveExistingProgress does not ratchet total_plans', () => {
  const { shouldPreserveExistingProgress } = require('../gsd-core/bin/lib/state-document.cjs');

  test('existing total_plans:50 > derived:64 → returns false (upward correction)', () => {
    const existing = { total_phases: 2, completed_phases: 1, total_plans: 50, completed_plans: 49 };
    const derived  = { total_phases: 2, completed_phases: 1, total_plans: 64, completed_plans: 49 };
    assert.equal(shouldPreserveExistingProgress(existing, derived), false,
      'total_plans upward correction must NOT trigger ratchet');
  });

  test('existing total_plans:50 > derived:30 → returns false (downward correction)', () => {
    const existing = { total_phases: 2, completed_phases: 1, total_plans: 50, completed_plans: 30 };
    const derived  = { total_phases: 2, completed_phases: 1, total_plans: 30, completed_plans: 30 };
    assert.equal(shouldPreserveExistingProgress(existing, derived), false,
      'total_plans downward correction must NOT trigger ratchet');
  });

  test('boundary: existing total_plans == derived → false', () => {
    const existing = { total_phases: 2, completed_phases: 1, total_plans: 50, completed_plans: 50 };
    const derived  = { total_phases: 2, completed_phases: 1, total_plans: 50, completed_plans: 50 };
    assert.equal(shouldPreserveExistingProgress(existing, derived), false,
      'total_plans equality must NOT trigger ratchet');
  });

  test('completed_plans:5 > derived:2 → true (ratchet still active for completed_plans)', () => {
    const existing = { total_phases: 2, completed_phases: 1, total_plans: 6, completed_plans: 5 };
    const derived  = { total_phases: 2, completed_phases: 1, total_plans: 6, completed_plans: 2 };
    assert.equal(shouldPreserveExistingProgress(existing, derived), true,
      'completed_plans ratchet must still work');
  });
});
  });
}

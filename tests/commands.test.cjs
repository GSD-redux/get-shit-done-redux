// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.
// docs-guard-exempt: 'docs/x.md' below is a synthetic fixture path fed into
// groupFilesBySubrepo() to exercise its subrepo-grouping logic — no real
// docs/ file is ever read or asserted on for content.

/**
 * GSD Tools Tests - Commands
 */

const { test, describe, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, createTempDir, cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { gitOrThrow, throwIfFailed } = require('./helpers/git-fixture.cjs');
const { runNode, runGit } = require('./helpers/process-seam.cjs');

describe('history-digest command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty phases directory returns valid schema', () => {
    const result = runGsdTools('history-digest', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const digest = JSON.parse(result.output);

    assert.deepStrictEqual(digest.phases, {}, 'phases should be empty object');
    assert.deepStrictEqual(digest.decisions, [], 'decisions should be empty array');
    assert.deepStrictEqual(digest.tech_stack, [], 'tech_stack should be empty array');
  });

  test('nested frontmatter fields extracted correctly', () => {
    // Create phase directory with SUMMARY containing nested frontmatter
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    const summaryContent = `---
phase: "01"
name: "Foundation Setup"
dependency-graph:
  provides:
    - "Database schema"
    - "Auth system"
  affects:
    - "API layer"
tech-stack:
  added:
    - "prisma"
    - "jose"
patterns-established:
  - "Repository pattern"
  - "JWT auth flow"
key-decisions:
  - "Use Prisma over Drizzle"
  - "JWT in httpOnly cookies"
---

# Summary content here
`;

    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), summaryContent);

    const result = runGsdTools('history-digest', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const digest = JSON.parse(result.output);

    // Check nested dependency-graph.provides
    assert.ok(digest.phases['01'], 'Phase 01 should exist');
    assert.deepStrictEqual(
      digest.phases['01'].provides.sort(),
      ['Auth system', 'Database schema'],
      'provides should contain nested values'
    );

    // Check nested dependency-graph.affects
    assert.deepStrictEqual(
      digest.phases['01'].affects,
      ['API layer'],
      'affects should contain nested values'
    );

    // Check nested tech-stack.added
    assert.deepStrictEqual(
      digest.tech_stack.sort(),
      ['jose', 'prisma'],
      'tech_stack should contain nested values'
    );

    // Check patterns-established (flat array)
    assert.deepStrictEqual(
      digest.phases['01'].patterns.sort(),
      ['JWT auth flow', 'Repository pattern'],
      'patterns should be extracted'
    );

    // Check key-decisions
    assert.strictEqual(digest.decisions.length, 2, 'Should have 2 decisions');
    assert.ok(
      digest.decisions.some(d => d.decision === 'Use Prisma over Drizzle'),
      'Should contain first decision'
    );
  });

  test('multiple phases merged into single digest', () => {
    // Create phase 01
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.writeFileSync(
      path.join(phase01Dir, '01-01-SUMMARY.md'),
      `---
phase: "01"
name: "Foundation"
provides:
  - "Database"
patterns-established:
  - "Pattern A"
key-decisions:
  - "Decision 1"
---
`
    );

    // Create phase 02
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase02Dir, { recursive: true });
    fs.writeFileSync(
      path.join(phase02Dir, '02-01-SUMMARY.md'),
      `---
phase: "02"
name: "API"
provides:
  - "REST endpoints"
patterns-established:
  - "Pattern B"
key-decisions:
  - "Decision 2"
tech-stack:
  added:
    - "zod"
---
`
    );

    const result = runGsdTools('history-digest', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const digest = JSON.parse(result.output);

    // Both phases present
    assert.ok(digest.phases['01'], 'Phase 01 should exist');
    assert.ok(digest.phases['02'], 'Phase 02 should exist');

    // Decisions merged
    assert.strictEqual(digest.decisions.length, 2, 'Should have 2 decisions total');

    // Tech stack merged
    assert.deepStrictEqual(digest.tech_stack, ['zod'], 'tech_stack should have zod');
  });

  test('malformed SUMMARY.md skipped gracefully', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Valid summary
    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
phase: "01"
provides:
  - "Valid feature"
---
`
    );

    // Malformed summary (no frontmatter)
    fs.writeFileSync(
      path.join(phaseDir, '01-02-SUMMARY.md'),
      `# Just a heading
No frontmatter here
`
    );

    // Another malformed summary (broken YAML)
    fs.writeFileSync(
      path.join(phaseDir, '01-03-SUMMARY.md'),
      `---
broken: [unclosed
---
`
    );

    const result = runGsdTools('history-digest', tmpDir);
    assert.ok(result.success, `Command should succeed despite malformed files: ${result.error}`);

    const digest = JSON.parse(result.output);
    assert.ok(digest.phases['01'], 'Phase 01 should exist');
    assert.ok(
      digest.phases['01'].provides.includes('Valid feature'),
      'Valid feature should be extracted'
    );
  });

  test('flat provides field still works (backward compatibility)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
phase: "01"
provides:
  - "Direct provides"
---
`
    );

    const result = runGsdTools('history-digest', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const digest = JSON.parse(result.output);
    assert.deepStrictEqual(
      digest.phases['01'].provides,
      ['Direct provides'],
      'Direct provides should work'
    );
  });

  test('inline array syntax supported', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
phase: "01"
provides: [Feature A, Feature B]
patterns-established: ["Pattern X", "Pattern Y"]
---
`
    );

    const result = runGsdTools('history-digest', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const digest = JSON.parse(result.output);
    assert.deepStrictEqual(
      digest.phases['01'].provides.sort(),
      ['Feature A', 'Feature B'],
      'Inline array should work'
    );
    assert.deepStrictEqual(
      digest.phases['01'].patterns.sort(),
      ['Pattern X', 'Pattern Y'],
      'Inline quoted array should work'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phases list command
// ─────────────────────────────────────────────────────────────────────────────


describe('summary-extract command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing file returns error', () => {
    const result = runGsdTools('summary-extract .planning/phases/01-test/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'File not found', 'should report missing file');
  });

  test('extracts all fields from SUMMARY.md', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
one-liner: Set up Prisma with User and Project models
key-files:
  - prisma/schema.prisma
  - src/lib/db.ts
tech-stack:
  added:
    - prisma
    - zod
patterns-established:
  - Repository pattern
  - Dependency injection
key-decisions:
  - Use Prisma over Drizzle: Better DX and ecosystem
  - Single database: Start simple, shard later
requirements-completed:
  - AUTH-01
  - AUTH-02
---

# Summary

Full summary content here.
`
    );

    const result = runGsdTools('summary-extract .planning/phases/01-foundation/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.path, '.planning/phases/01-foundation/01-01-SUMMARY.md', 'path correct');
    assert.strictEqual(output.one_liner, 'Set up Prisma with User and Project models', 'one-liner extracted');
    assert.deepStrictEqual(output.key_files, ['prisma/schema.prisma', 'src/lib/db.ts'], 'key files extracted');
    assert.deepStrictEqual(output.tech_added, ['prisma', 'zod'], 'tech added extracted');
    assert.deepStrictEqual(output.patterns, ['Repository pattern', 'Dependency injection'], 'patterns extracted');
    assert.strictEqual(output.decisions.length, 2, 'decisions extracted');
    assert.deepStrictEqual(output.requirements_completed, ['AUTH-01', 'AUTH-02'], 'requirements completed extracted');
  });

  test('selective extraction with --fields', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
one-liner: Set up database
key-files:
  - prisma/schema.prisma
tech-stack:
  added:
    - prisma
patterns-established:
  - Repository pattern
key-decisions:
  - Use Prisma: Better DX
requirements-completed:
  - AUTH-01
---
`
    );

    const result = runGsdTools('summary-extract .planning/phases/01-foundation/01-01-SUMMARY.md --fields one_liner,key_files,requirements_completed', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.one_liner, 'Set up database', 'one_liner included');
    assert.deepStrictEqual(output.key_files, ['prisma/schema.prisma'], 'key_files included');
    assert.deepStrictEqual(output.requirements_completed, ['AUTH-01'], 'requirements_completed included');
    assert.strictEqual(output.tech_added, undefined, 'tech_added excluded');
    assert.strictEqual(output.patterns, undefined, 'patterns excluded');
    assert.strictEqual(output.decisions, undefined, 'decisions excluded');
  });

  test('extracts one-liner from body when not in frontmatter', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
phase: "01"
key-files:
  - src/lib/db.ts
---

# Phase 1: Foundation Summary

**JWT auth with refresh rotation using jose library**

## Performance

- **Duration:** 28 min
- **Tasks:** 5
`
    );

    const result = runGsdTools('summary-extract .planning/phases/01-foundation/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.one_liner, 'JWT auth with refresh rotation using jose library',
      'one-liner should be extracted from body **bold** line');
  });

  test('handles missing frontmatter fields gracefully', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
one-liner: Minimal summary
---

# Summary
`
    );

    const result = runGsdTools('summary-extract .planning/phases/01-foundation/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.one_liner, 'Minimal summary', 'one-liner extracted');
    assert.deepStrictEqual(output.key_files, [], 'key_files defaults to empty');
    assert.deepStrictEqual(output.tech_added, [], 'tech_added defaults to empty');
    assert.deepStrictEqual(output.patterns, [], 'patterns defaults to empty');
    assert.deepStrictEqual(output.decisions, [], 'decisions defaults to empty');
    assert.deepStrictEqual(output.requirements_completed, [], 'requirements_completed defaults to empty');
  });

  test('reads requirements in snake_case form the tool itself emits (#628)', () => {
    // Regression: the tool's JSON output key and the milestone-audit `--pick` both use the
    // snake form `requirements_completed`, so operators naturally write that into SUMMARY
    // frontmatter. The reader must accept it, not silently drop it to [].
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
one-liner: Snake-keyed summary
requirements_completed:
  - REQ-1
  - REQ-2
---

# Summary
`
    );

    const result = runGsdTools('summary-extract .planning/phases/01-foundation/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.requirements_completed, ['REQ-1', 'REQ-2'],
      'snake-case requirements_completed should be read, not dropped to []');
  });

  test('prefers kebab requirements-completed when both key forms are present (#628)', () => {
    // kebab is the documented template form and must win the tolerance fallback.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
one-liner: Both key forms present
requirements-completed:
  - KEBAB-1
requirements_completed:
  - SNAKE-1
---

# Summary
`
    );

    const result = runGsdTools('summary-extract .planning/phases/01-foundation/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.requirements_completed, ['KEBAB-1'],
      'kebab key should take precedence over snake when both are present');
  });

  test('parses key-decisions with rationale', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
key-decisions:
  - Use Prisma: Better DX than alternatives
  - JWT tokens: Stateless auth for scalability
---
`
    );

    const result = runGsdTools('summary-extract .planning/phases/01-foundation/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.decisions[0].summary, 'Use Prisma', 'decision summary parsed');
    assert.strictEqual(output.decisions[0].rationale, 'Better DX than alternatives', 'decision rationale parsed');
    assert.strictEqual(output.decisions[1].summary, 'JWT tokens', 'second decision summary');
    assert.strictEqual(output.decisions[1].rationale, 'Stateless auth for scalability', 'second decision rationale');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// init commands tests
// ─────────────────────────────────────────────────────────────────────────────


describe('progress command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('renders JSON progress', () => {
    // #3217: no version token — genuinely free-form, so windowing scope is
    // COMPLETE (§7.1) rather than UNSCOPED (a title merely mentioning "v1.0"
    // with no STATE.md milestone pointer cannot be windowed to that version).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap MVP\n`
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Done');
    fs.writeFileSync(path.join(p1, '01-02-PLAN.md'), '# Plan 2');

    const result = runGsdTools('progress json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.total_plans, 2, '2 total plans');
    assert.strictEqual(output.total_summaries, 1, '1 summary');
    assert.strictEqual(output.percent, 50, '50%');
    assert.strictEqual(output.phases.length, 1, '1 phase');
    assert.strictEqual(output.phases[0].status, 'In Progress', 'phase in progress');
  });

  test('renders bar format', () => {
    // #3217: no version token — see 'renders JSON progress' above.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n`
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Done');

    const result = runGsdTools('progress bar --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.ok(result.output.includes('1/1'), 'should include count');
    assert.ok(result.output.includes('100%'), 'should include 100%');
  });

  test('renders table format', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0 MVP\n`
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('progress table --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.ok(result.output.includes('Phase'), 'should have table header');
    assert.ok(result.output.includes('foundation'), 'should include phase name');
  });

  test('does not crash when summaries exceed plans (orphaned SUMMARY.md)', () => {
    // #3217: no version token — see 'renders JSON progress' above.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap MVP\n`
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    // 1 plan but 2 summaries (orphaned SUMMARY.md after PLAN.md deletion)
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Done');
    fs.writeFileSync(path.join(p1, '01-02-SUMMARY.md'), '# Orphaned summary');

    // bar format - should not crash with RangeError
    const barResult = runGsdTools('progress bar --raw', tmpDir);
    assert.ok(barResult.success, `Bar format crashed: ${barResult.error}`);
    assert.ok(barResult.output.includes('100%'), 'percent should be clamped to 100%');

    // table format - should not crash with RangeError
    const tableResult = runGsdTools('progress table --raw', tmpDir);
    assert.ok(tableResult.success, `Table format crashed: ${tableResult.error}`);

    // json format - percent should be clamped
    const jsonResult = runGsdTools('progress json', tmpDir);
    assert.ok(jsonResult.success, `JSON format crashed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);
    assert.ok(output.percent <= 100, `percent should be <= 100 but got ${output.percent}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// todo complete command
// ─────────────────────────────────────────────────────────────────────────────


describe('todo complete command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('moves todo from pending to completed', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(
      path.join(pendingDir, 'add-dark-mode.md'),
      `title: Add dark mode\narea: ui\ncreated: 2025-01-01\n`
    );

    const result = runGsdTools('todo complete add-dark-mode.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.completed, true);

    // Verify moved
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'todos', 'pending', 'add-dark-mode.md')),
      'should be removed from pending'
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'todos', 'completed', 'add-dark-mode.md')),
      'should be in completed'
    );

    // Verify completion timestamp added — #4096: the completed/status keys must
    // live INSIDE a well-formed frontmatter block (line 1 is the opening fence),
    // never above it.
    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'todos', 'completed', 'add-dark-mode.md'),
      'utf-8'
    );
    assert.ok(content.startsWith('---\n'), 'should open with a frontmatter fence');
    assert.match(content, /^completed: \d{4}-\d{2}-\d{2}$/m);
  });

  test('fails for nonexistent todo', () => {
    const result = runGsdTools('todo complete nonexistent.md', tmpDir);
    assert.ok(!result.success, 'should fail');
    assert.ok(result.error.includes('not found'), 'error mentions not found');
  });

  // #4096 regressions — --dry-run must not mutate, and completion keys must be
  // written inside the frontmatter fence.
  test('--dry-run previews without moving the file or mutating anything', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const source = path.join(pendingDir, 'dry-run-probe.md');
    fs.writeFileSync(source, '---\ntitle: probe\nstatus: pending\n---\n\n# body\n');

    const result = runGsdTools('todo complete dry-run-probe.md --dry-run', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.dry_run, true, 'payload must be preview-shaped (dry_run)');
    assert.strictEqual(output.would_complete, true, 'payload must say would_complete');
    assert.strictEqual('completed' in output, false, 'preview must never report completed:true');
    assert.strictEqual(output.file, 'dry-run-probe.md');
    assert.match(output.date, /^\d{4}-\d{2}-\d{2}$/);

    // File untouched, in place; nothing written to completed/.
    assert.ok(fs.existsSync(source), 'pending file must still exist under --dry-run');
    const completedPath = path.join(tmpDir, '.planning', 'todos', 'completed', 'dry-run-probe.md');
    assert.ok(!fs.existsSync(completedPath), 'no completed copy under --dry-run');
    assert.strictEqual(
      fs.readFileSync(source, 'utf-8'),
      '---\ntitle: probe\nstatus: pending\n---\n\n# body\n',
      'source bytes must be unchanged under --dry-run'
    );
  });

  test('--dry-run still fails for nonexistent todo', () => {
    const result = runGsdTools('todo complete nonexistent.md --dry-run', tmpDir);
    assert.ok(!result.success, 'dry-run must still run existence checks');
    assert.ok(result.error.includes('not found'), 'error mentions not found');
  });

  test('writes completed and status: completed inside the frontmatter fence', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(
      path.join(pendingDir, 'fence-probe.md'),
      '---\ntitle: fence probe\nstatus: pending\ncreated: 2025-01-01\n---\n\n# body\n'
    );

    const result = runGsdTools('todo complete fence-probe.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'todos', 'completed', 'fence-probe.md'),
      'utf-8'
    );
    // Line 1 must remain the opening fence (#4096 defect 2).
    assert.ok(content.startsWith('---\n'), 'opening fence must stay on line 1');
    const lines = splitLines(content);
    const closeIdx = lines.indexOf('---', 1);
    assert.ok(closeIdx > 0, 'closing fence must exist');
    const fm = lines.slice(1, closeIdx);
    assert.ok(fm.includes('status: completed'), 'status: completed must be inside the fence');
    assert.strictEqual(fm.filter(l => /^completed: /.test(l)).length, 1,
      'exactly one completed: line, inside the fence');
    // Other frontmatter keys survive.
    assert.ok(fm.some(l => l.startsWith('title:')), 'existing keys preserved');
    // Body preserved after the block.
    assert.ok(content.includes('# body'), 'body preserved');
  });

  test('upserts an existing completed field instead of duplicating it', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(
      path.join(pendingDir, 'recomplete-probe.md'),
      '---\ntitle: recomplete\nstatus: pending\ncompleted: 2020-01-01\n---\n\n# body\n'
    );

    const result = runGsdTools('todo complete recomplete-probe.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'todos', 'completed', 'recomplete-probe.md'),
      'utf-8'
    );
    assert.ok(content.startsWith('---\n'), 'opening fence must stay on line 1');
    assert.ok(!content.includes('completed: 2020-01-01'), 'stale completed value replaced');
    assert.strictEqual(
      (content.match(/^completed: /gm) || []).length, 1,
      'exactly one completed: occurrence'
    );
  });

  test('wraps a frontmatter-less todo in a complete frontmatter block', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'bare.md'), '# just a body\n');

    const result = runGsdTools('todo complete bare.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'todos', 'completed', 'bare.md'),
      'utf-8'
    );
    // #4096 fix-2: no bare prefix line — a complete frontmatter block instead.
    assert.ok(content.startsWith('---\n'), 'frontmatter block must open the file');
    const lines = splitLines(content);
    const closeIdx = lines.indexOf('---', 1);
    assert.ok(closeIdx > 0, 'closing fence must exist');
    const fm = lines.slice(1, closeIdx);
    assert.ok(fm.some(l => /^completed: \d{4}-\d{2}-\d{2}$/.test(l)), 'completed inside block');
    assert.ok(fm.includes('status: completed'), 'status: completed inside block');
    assert.ok(content.includes('# just a body'), 'body preserved');
  });

  test('rejects unknown flags instead of silently completing', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'flag-probe.md'), '---\nstatus: pending\n---\n');

    const result = runGsdTools('todo complete flag-probe.md --bogus-flag', tmpDir);
    assert.ok(!result.success, 'unknown flag must fail loudly');
    assert.ok(result.error.includes('Unknown flag'), 'error mentions Unknown flag');
    // And crucially: nothing moved.
    assert.ok(
      fs.existsSync(path.join(pendingDir, 'flag-probe.md')),
      'file must not move when a flag is rejected'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// todo match-phase command
// ─────────────────────────────────────────────────────────────────────────────

describe('todo match-phase command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });
  afterEach(() => cleanup(tmpDir));

  test('returns empty matches when no todos exist', () => {
    const result = runGsdTools('todo match-phase 01', tmpDir);
    assert.ok(result.success, 'should succeed');
    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 0);
    assert.deepStrictEqual(output.matches, []);
  });

  test('matches todo by keyword overlap with phase name', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'auth-todo.md'),
      'title: Add OAuth token refresh\narea: auth\ncreated: 2026-03-01\n\nNeed to handle token expiry for OAuth flows.');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 01: Authentication and Session Management\n\n**Goal:** Implement OAuth login and session handling\n');

    const result = runGsdTools('todo match-phase 01', tmpDir);
    assert.ok(result.success, 'should succeed');
    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 1, 'should find 1 todo');
    assert.ok(output.matches.length > 0, 'should have matches');
    assert.strictEqual(output.matches[0].title, 'Add OAuth token refresh');
    assert.ok(output.matches[0].score > 0, 'score should be positive');
    assert.ok(output.matches[0].reasons.length > 0, 'should have reasons');
  });

  test('does not match unrelated todo', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'auth-todo.md'),
      'title: Add OAuth token refresh\narea: auth\ncreated: 2026-03-01\n\nOAuth token expiry.');
    fs.writeFileSync(path.join(pendingDir, 'unrelated-todo.md'),
      'title: Fix CSS grid layout in dashboard\narea: ui\ncreated: 2026-03-01\n\nGrid columns break on mobile.');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 01: Authentication and Session Management\n\n**Goal:** Implement OAuth login and session handling\n');

    const result = runGsdTools('todo match-phase 01', tmpDir);
    assert.ok(result.success, 'should succeed');
    const output = JSON.parse(result.output);
    const matchTitles = output.matches.map(m => m.title);
    assert.ok(matchTitles.includes('Add OAuth token refresh'), 'auth todo should match');
    assert.ok(!matchTitles.includes('Fix CSS grid layout in dashboard'), 'unrelated todo should not match');
  });

  test('matches todo by area overlap', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'auth-todo.md'),
      'title: Add OAuth token refresh\narea: auth\ncreated: 2026-03-01\n\nOAuth token handling.');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 01: Auth System\n\n**Goal:** Build auth module\n');

    const result = runGsdTools('todo match-phase 01', tmpDir);
    const output = JSON.parse(result.output);
    const authMatch = output.matches.find(m => m.title === 'Add OAuth token refresh');
    assert.ok(authMatch, 'should find auth todo');
    const hasAreaReason = authMatch.reasons.some(r => r.startsWith('area:'));
    assert.ok(hasAreaReason, 'should match on area');
  });

  test('sorts matches by score descending', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'weak-match.md'),
      'title: Check token format\narea: general\ncreated: 2026-03-01\n\nToken format validation.');
    fs.writeFileSync(path.join(pendingDir, 'strong-match.md'),
      'title: Session management authentication OAuth token handling\narea: auth\ncreated: 2026-03-01\n\nSession auth OAuth tokens.');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 01: Authentication and Session Management\n\n**Goal:** Implement OAuth login, session handling, and token management\n');

    const result = runGsdTools('todo match-phase 01', tmpDir);
    const output = JSON.parse(result.output);
    assert.ok(output.matches.length >= 2, 'should have multiple matches');
    for (let i = 1; i < output.matches.length; i++) {
      assert.ok(output.matches[i - 1].score >= output.matches[i].score,
        `match ${i-1} score (${output.matches[i-1].score}) should be >= match ${i} score (${output.matches[i].score})`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scaffold command
// ─────────────────────────────────────────────────────────────────────────────


describe('scaffold command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('scaffolds context file', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });

    const result = runGsdTools('scaffold context --phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, true);

    // Verify file content
    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'phases', '03-api', '03-CONTEXT.md'),
      'utf-8'
    );
    assert.ok(content.includes('Phase 3'), 'should reference phase number');
    assert.ok(content.includes('Decisions'), 'should have decisions section');
    assert.ok(content.includes('Discretion Areas'), 'should have discretion section');
  });

  test('scaffolds UAT file', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });

    const result = runGsdTools('scaffold uat --phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, true);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'phases', '03-api', '03-UAT.md'),
      'utf-8'
    );
    assert.ok(content.includes('User Acceptance Testing'), 'should have UAT heading');
    assert.ok(content.includes('Test Results'), 'should have test results section');
  });

  test('scaffolds verification file', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });

    const result = runGsdTools('scaffold verification --phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, true);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'phases', '03-api', '03-VERIFICATION.md'),
      'utf-8'
    );
    assert.ok(content.includes('Goal-Backward Verification'), 'should have verification heading');
  });

  test('scaffolds phase directory', () => {
    const result = runGsdTools('scaffold phase-dir --phase 5 --name User Dashboard', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, true);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '05-user-dashboard')),
      'directory should be created'
    );
  });

  test('does not overwrite existing files', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-CONTEXT.md'), '# Existing content');

    const result = runGsdTools('scaffold context --phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, false, 'should not overwrite');
    assert.strictEqual(output.reason, 'already_exists');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdGenerateSlug tests (CMD-01)
// ─────────────────────────────────────────────────────────────────────────────

describe('generate-slug command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('converts normal text to slug', () => {
    const result = runGsdTools('generate-slug "Hello World"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.slug, 'hello-world');
  });

  test('strips special characters', () => {
    const result = runGsdTools('generate-slug "Test@#$%^Special!!!"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.slug, 'test-special');
  });

  test('preserves numbers', () => {
    const result = runGsdTools('generate-slug "Phase 3 Plan"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.slug, 'phase-3-plan');
  });

  test('strips leading and trailing hyphens', () => {
    const result = runGsdTools('generate-slug "---leading-trailing---"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.slug, 'leading-trailing');
  });

  test('fails when no text provided', () => {
    const result = runGsdTools('generate-slug', tmpDir);
    assert.ok(!result.success, 'should fail without text');
    assert.ok(result.error.includes('text required'), 'error should mention text required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdCurrentTimestamp tests (CMD-01)
// ─────────────────────────────────────────────────────────────────────────────

describe('current-timestamp command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('date format returns YYYY-MM-DD', () => {
    const result = runGsdTools('current-timestamp date', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.match(output.timestamp, /^\d{4}-\d{2}-\d{2}$/, 'should be YYYY-MM-DD format');
  });

  test('filename format returns ISO without colons or fractional seconds', () => {
    const result = runGsdTools('current-timestamp filename', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.match(output.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/, 'should replace colons with hyphens and strip fractional seconds');
  });

  test('full format returns full ISO string', () => {
    const result = runGsdTools('current-timestamp full', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.match(output.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'should be full ISO format');
  });

  test('default (no format) returns full ISO string', () => {
    const result = runGsdTools('current-timestamp', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.match(output.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'default should be full ISO format');
  });

  test('dispatches directly to CJS handler (no SDK bridge) to avoid Windows native crash path', () => {
    // ADR-2346 P4: current-timestamp migrated from a case arm to HOST_COMMAND_ROUTERS.
    // Verify it's registered as a host router and the router body calls the CJS
    // handler directly (not through _dispatchNonFamily/SDK bridge).
    const { HOST_COMMAND_ROUTERS } = require('../gsd-core/bin/gsd-tools.cjs');
    assert.ok(
      Object.prototype.hasOwnProperty.call(HOST_COMMAND_ROUTERS, 'current-timestamp'),
      'current-timestamp must be registered in HOST_COMMAND_ROUTERS',
    );
    const router = HOST_COMMAND_ROUTERS['current-timestamp'];
    assert.strictEqual(typeof router, 'function', 'current-timestamp router must be a function');

    // The router should call commands.cmdCurrentTimestamp directly.
    // (Verified behaviorally by the 'current-timestamp command' tests above.)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdCurrentTimestamp exact-value tests (#3314 — ADR-456 subprocess clock pin)
// ─────────────────────────────────────────────────────────────────────────────

describe('current-timestamp command — exact value under GSD_NOW_MS pin', () => {
  let tmpDir;
  // Pinned instant with a non-zero millisecond fraction so the 'full' format
  // assertion can't accidentally pass against a truncated value.
  const PINNED_MS = 1_700_000_000_123; // 2023-11-14T22:13:20.123Z
  const PIN_ENV = { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) };

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('date format: exact value for pinned instant', () => {
    const result = runGsdTools('current-timestamp date', tmpDir, PIN_ENV);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const expected = new Date(PINNED_MS).toISOString().split('T')[0];
    assert.strictEqual(output.timestamp, expected);
  });

  test('filename format: exact value for pinned instant', () => {
    const result = runGsdTools('current-timestamp filename', tmpDir, PIN_ENV);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const expected = new Date(PINNED_MS).toISOString().replace(/:/g, '-').replace(/\..+/, '');
    assert.strictEqual(output.timestamp, expected);
  });

  test('full format: exact value for pinned instant', () => {
    const result = runGsdTools('current-timestamp full', tmpDir, PIN_ENV);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.timestamp, new Date(PINNED_MS).toISOString());
  });

  test('default format: exact value for pinned instant', () => {
    const result = runGsdTools('current-timestamp', tmpDir, PIN_ENV);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.timestamp, new Date(PINNED_MS).toISOString());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdListTodos tests (CMD-02)
// ─────────────────────────────────────────────────────────────────────────────

describe('list-todos command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty directory returns zero count', () => {
    const result = runGsdTools('list-todos', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.count, 0, 'count should be 0');
    assert.deepStrictEqual(output.todos, [], 'todos should be empty');
  });

  test('returns multiple todos with correct fields', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(path.join(pendingDir, 'add-tests.md'), 'title: Add unit tests\narea: testing\ncreated: 2026-01-15\n');
    fs.writeFileSync(path.join(pendingDir, 'fix-bug.md'), 'title: Fix login bug\narea: auth\ncreated: 2026-01-20\n');

    const result = runGsdTools('list-todos', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.count, 2, 'should have 2 todos');
    assert.strictEqual(output.todos.length, 2, 'todos array should have 2 entries');

    const testTodo = output.todos.find(t => t.file === 'add-tests.md');
    assert.ok(testTodo, 'add-tests.md should be in results');
    assert.strictEqual(testTodo.title, 'Add unit tests');
    assert.strictEqual(testTodo.area, 'testing');
    assert.strictEqual(testTodo.created, '2026-01-15');
  });

  test('area filter returns only matching todos', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(path.join(pendingDir, 'ui-task.md'), 'title: UI task\narea: ui\ncreated: 2026-01-01\n');
    fs.writeFileSync(path.join(pendingDir, 'api-task.md'), 'title: API task\narea: api\ncreated: 2026-01-01\n');

    const result = runGsdTools('list-todos ui', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.count, 1, 'should have 1 matching todo');
    assert.strictEqual(output.todos[0].area, 'ui', 'should only return ui area');
  });

  test('area filter miss returns zero count', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(path.join(pendingDir, 'task.md'), 'title: Some task\narea: backend\ncreated: 2026-01-01\n');

    const result = runGsdTools('list-todos nonexistent-area', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.count, 0, 'should have 0 matching todos');
  });

  test('malformed files use defaults', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    // File with no title or area fields
    fs.writeFileSync(path.join(pendingDir, 'malformed.md'), 'some random content\nno fields here\n');

    const result = runGsdTools('list-todos', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.count, 1, 'malformed file should still be counted');
    assert.strictEqual(output.todos[0].title, 'Untitled', 'missing title defaults to Untitled');
    assert.strictEqual(output.todos[0].area, 'general', 'missing area defaults to general');
    assert.strictEqual(output.todos[0].created, 'unknown', 'missing created defaults to unknown');
  });

  // ── #2337: severity must be surfaced when present, omitted when absent ──────
  // cmdListTodos parsed created/title/area but silently dropped severity, so
  // audit-open and status summaries could not triage by blocker/major/minor/
  // cosmetic even for todos an agent had correctly hand-tagged.
  test('surfaces severity when the frontmatter carries it (#2337)', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(path.join(pendingDir, 'crash.md'),
      'title: Fix data-loss crash\narea: core\ncreated: 2026-02-01\nseverity: blocker\n');

    const result = runGsdTools('list-todos', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const todo = output.todos.find(t => t.file === 'crash.md');
    assert.ok(todo, 'crash.md should be in results');
    assert.strictEqual(todo.severity, 'blocker', 'severity must be surfaced verbatim');
  });

  test('omits the severity key for todos with no severity line — backward compatible (#2337)', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(path.join(pendingDir, 'legacy.md'),
      'title: Legacy todo\narea: docs\ncreated: 2026-02-02\n');

    const result = runGsdTools('list-todos', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const todo = output.todos.find(t => t.file === 'legacy.md');
    assert.ok(todo, 'legacy.md should be in results');
    assert.ok(!('severity' in todo),
      'severity key must be ABSENT (not null/empty) for a todo with no severity line');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdVerifyPathExists tests (CMD-02)
// ─────────────────────────────────────────────────────────────────────────────

describe('verify-path-exists command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('existing file returns exists=true with type=file', () => {
    fs.writeFileSync(path.join(tmpDir, 'test-file.txt'), 'hello');

    const result = runGsdTools('verify-path-exists test-file.txt', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.exists, true);
    assert.strictEqual(output.type, 'file');
  });

  test('existing directory returns exists=true with type=directory', () => {
    fs.mkdirSync(path.join(tmpDir, 'test-dir'), { recursive: true });

    const result = runGsdTools('verify-path-exists test-dir', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.exists, true);
    assert.strictEqual(output.type, 'directory');
  });

  test('missing path returns exists=false', () => {
    const result = runGsdTools('verify-path-exists nonexistent/path', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.exists, false);
    assert.strictEqual(output.type, null);
  });

  test('absolute path resolves correctly', () => {
    const absFile = path.join(tmpDir, 'abs-test.txt');
    fs.writeFileSync(absFile, 'content');

    const result = runGsdTools(['verify-path-exists', absFile], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.exists, true);
    assert.strictEqual(output.type, 'file');
  });

  test('fails when no path provided', () => {
    const result = runGsdTools('verify-path-exists', tmpDir);
    assert.ok(!result.success, 'should fail without path');
    assert.ok(result.error.includes('path required'), 'error should mention path required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdResolveModel tests (CMD-03)
// ─────────────────────────────────────────────────────────────────────────────

describe('resolve-model command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('known agent returns model and profile without unknown_agent', () => {
    const result = runGsdTools('resolve-model gsd-planner', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.model, 'should have model field');
    assert.ok(output.profile, 'should have profile field');
    assert.strictEqual(output.unknown_agent, undefined, 'should not have unknown_agent for known agent');
  });

  test('shipped-but-previously-missing agent resolves under quality profile (#3229)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ model_profile: 'quality' }));
    const result = runGsdTools('resolve-model gsd-code-reviewer', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.model, 'opus');
    assert.strictEqual(output.profile, 'quality');
    assert.strictEqual(output.unknown_agent, undefined);
  });

  test('unknown agent returns unknown_agent=true', () => {
    const result = runGsdTools('resolve-model fake-nonexistent-agent', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.unknown_agent, true, 'should flag unknown agent');
  });

  test('unknown agent uses quality-semantic fallback (opus)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ model_profile: 'quality' }));
    const result = runGsdTools('resolve-model fake-nonexistent-agent', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.model, 'opus');
    assert.strictEqual(output.unknown_agent, true);
  });

  test('unknown agent uses budget-semantic fallback (haiku)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ model_profile: 'budget' }));
    const result = runGsdTools('resolve-model fake-nonexistent-agent', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.model, 'haiku');
    assert.strictEqual(output.unknown_agent, true);
  });

  test('default profile fallback when no config exists', () => {
    // tmpDir has no config.json, so defaults to balanced profile
    const result = runGsdTools('resolve-model gsd-executor', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.profile, 'balanced', 'should default to balanced profile');
    assert.ok(output.model, 'should resolve a model');
  });

  // #4192 (AC1, behavioral): a claude-runtime tier override must change the
  // resolved output relative to the no-override control — the CLI surface the
  // orchestrator reads is where the documented contract is observable.
  test('claude-runtime tier override changes resolved output vs control (#4192)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({
      model_profile: 'balanced',
      model_profile_overrides: { claude: { opus: 'claude-opus-4-7' } },
    }));
    const pinned = runGsdTools('resolve-model gsd-planner', tmpDir);
    assert.ok(pinned.success, `Command failed: ${pinned.error}`);
    assert.strictEqual(JSON.parse(pinned.output).model, 'claude-opus-4-7');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({
      model_profile: 'balanced',
    }));
    const control = runGsdTools('resolve-model gsd-planner', tmpDir);
    assert.ok(control.success, `Command failed: ${control.error}`);
    assert.strictEqual(JSON.parse(control.output).model, 'opus');
  });

  // #4192 (AC2, behavioral): a per-agent fully-qualified Claude model ID is
  // resolved as configured through the CLI surface.
  test('per-agent fully-qualified claude ID resolves as configured (#4192)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({
      model_profile: 'balanced',
      model_overrides: { 'gsd-debugger': 'claude-opus-4-7' },
    }));
    const result = runGsdTools('resolve-model gsd-debugger', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).model, 'claude-opus-4-7');
  });

  // #443: resolve-model now emits unified `effort` instead of `reasoning_effort`.
  // reasoning_effort was flavor-text (resolved but consumed by nobody); effort is
  // the wired, config-driven universal effort string for all runtimes.
  test('emits unified effort (not reasoning_effort) when runtime supports tiered effort', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({
      model_profile: 'balanced',
      runtime: 'codex',
      models: { planning: 'opus' },
    }));
    const result = runGsdTools('resolve-model gsd-planner', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.model, 'gpt-5.6-sol');
    assert.strictEqual(output.profile, 'balanced');
    // #443: effort is now the unified field (xhigh for gsd-planner heavy tier default)
    assert.strictEqual(output.effort, 'xhigh');
    // reasoning_effort must be absent — replaced by unified effort
    assert.ok(!Object.prototype.hasOwnProperty.call(output, 'reasoning_effort'),
      'reasoning_effort must not appear in resolve-model output (replaced by effort)');
  });

  test('does not include reasoning_effort for unsupported runtime overrides (effort present instead)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({
      model_profile: 'balanced',
      runtime: 'opencode',
      models: { planning: 'opus' },
      model_profile_overrides: {
        opencode: {
          opus: { model: 'openrouter/openai/gpt-5.5', reasoning_effort: 'high' },
        },
      },
    }));
    const result = runGsdTools('resolve-model gsd-planner', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.model, 'openrouter/openai/gpt-5.5');
    assert.strictEqual(output.profile, 'balanced');
    // #443: effort always present; reasoning_effort never present
    assert.ok(Object.prototype.hasOwnProperty.call(output, 'effort'), 'effort must be present');
    assert.ok(!Object.prototype.hasOwnProperty.call(output, 'reasoning_effort'),
      'reasoning_effort must not appear (replaced by unified effort)');
  });

  test('does not include reasoning_effort for per-agent model_overrides (effort present instead)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({
      model_profile: 'balanced',
      runtime: 'codex',
      models: { planning: 'opus' },
      model_overrides: { 'gsd-planner': 'gpt-5.5' },
    }));
    const result = runGsdTools('resolve-model gsd-planner', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.model, 'gpt-5.5');
    assert.strictEqual(output.profile, 'balanced');
    // #443: effort always present; reasoning_effort never present
    assert.ok(Object.prototype.hasOwnProperty.call(output, 'effort'), 'effort must be present');
    assert.ok(!Object.prototype.hasOwnProperty.call(output, 'reasoning_effort'),
      'reasoning_effort must not appear (replaced by unified effort)');
  });

  test('fails when no agent-type provided', () => {
    const result = runGsdTools('resolve-model', tmpDir);
    assert.ok(!result.success, 'should fail without agent-type');
    assert.ok(result.error.includes('agent-type required'), 'error should mention agent-type required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdCommit tests (CMD-04)
// ─────────────────────────────────────────────────────────────────────────────

describe('commit command', () => {
  const { createTempGitProject } = require('./helpers.cjs');
  const { gitOrThrow, throwIfFailed } = require('./helpers/git-fixture.cjs');
  const { runNode } = require('./helpers/process-seam.cjs');
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('skips when commit_docs is false', () => {
    // Write config with commit_docs: false
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: false })
    );

    const result = runGsdTools('commit "test message"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'skipped_commit_docs_false');
  });

  test('skips when .planning is gitignored', () => {
    // Add .planning/ to .gitignore and commit it so git recognizes the ignore
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.planning/\n');
    gitOrThrow(['add', '.gitignore'], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'add gitignore'], { cwd: tmpDir });

    const result = runGsdTools('commit "test message"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'skipped_gitignored');
  });

  test('handles nothing to commit', () => {
    // Don't modify any files after initial commit
    const result = runGsdTools('commit "test message"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'nothing_to_commit');
  });

  test('creates real commit with correct hash', () => {
    // Create a new file in .planning/
    fs.writeFileSync(path.join(tmpDir, '.planning', 'test-file.md'), '# Test\n');

    const result = runGsdTools('commit "test: add test file" --files .planning/test-file.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.committed, true, 'should have committed');
    assert.ok(output.hash, 'should have a commit hash');
    assert.strictEqual(output.reason, 'committed');

    // Verify via git log
    const gitLog = gitOrThrow(['log', '--oneline', '-1'], { cwd: tmpDir }).trim();
    assert.ok(gitLog.includes('test: add test file'), 'git log should contain the commit message');
    assert.ok(gitLog.includes(output.hash), 'git log should contain the returned hash');
  });

  test('amend mode works without crashing', () => {
    // Create a file and commit it first
    fs.writeFileSync(path.join(tmpDir, '.planning', 'amend-file.md'), '# Initial\n');
    gitOrThrow(['add', '.planning/amend-file.md'], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'initial file'], { cwd: tmpDir });

    // Modify the file and amend
    fs.writeFileSync(path.join(tmpDir, '.planning', 'amend-file.md'), '# Amended\n');

    const result = runGsdTools('commit "ignored" --files .planning/amend-file.md --amend', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.committed, true, 'amend should succeed');

    // Verify only 2 commits total (initial setup + amended)
    const logCount = gitOrThrow(['log', '--oneline'], { cwd: tmpDir }).trim().split('\n').length;
    assert.strictEqual(logCount, 2, 'should have 2 commits (initial + amended)');
  });
  test('#3207: creates AND switches to the milestone branch before first commit', () => {
    // Configure milestone branching strategy
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        branching_strategy: 'milestone',
        milestone_branch_template: 'gsd/{milestone}-{slug}',
      })
    );
    // getMilestoneInfo reads ROADMAP.md for milestone version/name
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '## v1.0: Initial Release\n\n### Phase 1: Setup\n'
    );

    // Create a file to commit
    fs.writeFileSync(path.join(tmpDir, '.planning', 'test-context.md'), '# Context\n');

    const result = runGsdTools('commit "docs: add context" --files .planning/test-context.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.committed, true, 'should have committed');

    // #3207: the branch should be CREATED and HEAD switched to it, so the first
    // milestone-scoped commit lands on the milestone branch (#1278 intent). The
    // prior #3079 no-switch behavior regressed this for fresh creates.
    const branch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    assert.strictEqual(branch, 'gsd/v1.0-initial-release', '#3207: must switch to the milestone branch');
    // The commit must be reachable on the milestone branch (HEAD is on it).
    const committedFile = gitOrThrow(['show', 'HEAD:.planning/test-context.md'], { cwd: tmpDir });
    assert.ok(committedFile.includes('# Context'), 'milestone commit must land on the milestone branch');
  });

  test('#3207: creates AND switches to the phase branch before first commit', () => {
    // Configure phase branching strategy
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        branching_strategy: 'phase',
        phase_branch_template: 'gsd/phase-{phase}-{slug}',
      })
    );
    // Create ROADMAP.md with a phase
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 1: Setup\nGoal: Initial setup\n'
    );

    // Create a context file for phase 1
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases', '01-setup', '01-CONTEXT.md'), '# Context\n');

    const result = runGsdTools(
      'commit "docs(01): add context" --files .planning/phases/01-setup/01-CONTEXT.md',
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.committed, true, 'should have committed');

    // #3207: the branch should be CREATED and HEAD switched to it, so the first
    // phase-scoped commit lands on the phase branch (#1278 intent). The prior
    // #3079 no-switch behavior regressed this for fresh creates.
    const branch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    assert.strictEqual(branch, 'gsd/phase-01-setup', '#3207: must switch to the phase branch');
    // The commit must be reachable on the phase branch (HEAD is on it).
    const committedFile = gitOrThrow(
      ['show', 'HEAD:.planning/phases/01-setup/01-CONTEXT.md'], { cwd: tmpDir }
    );
    assert.ok(committedFile.includes('# Context'), 'phase commit must land on the phase branch');
  });

  test('decimal phase numbers are captured correctly in branching strategy', () => {
    // Configure phase branching strategy
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        branching_strategy: 'phase',
        phase_branch_template: 'gsd/phase-{phase}-{slug}',
      })
    );
    // Create ROADMAP.md with a decimal phase
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '45.14-golden-capture'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 45.14: Golden Capture\nGoal: Capture golden standard\n'
    );

    // Create a context file for phase 45.14
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases', '45.14-golden-capture', '45.14-CONTEXT.md'), '# Context\n');

    const result = runGsdTools(
      'commit "docs(45.14): add context" --files .planning/phases/45.14-golden-capture/45.14-CONTEXT.md',
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.committed, true, 'should have committed');

    // #3207: the branch should be CREATED and HEAD switched to it (decimal phase).
    const branch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    assert.strictEqual(branch, 'gsd/phase-45.14-golden-capture', '#3207: must switch to the decimal phase branch');
    // Verify the correct branch name was resolved (not integer-only)
    const branchExists = gitOrThrow(['rev-parse', '--verify', 'gsd/phase-45.14-golden-capture'], { cwd: tmpDir });
    assert.ok(branchExists.trim(), 'decimal phase branch should be created (45.14, not 14)');
  });

  // #2539: the phase-token extraction must be anchored to the path segment under
  // .planning/phases/ and reuse the project-code-aware extractPhaseToken helper.
  // The prior unanchored `match(/(\d+(?:\.\d+)*)-/)` matched the leftmost
  // digit-run-then-hyphen anywhere in the joined file path, so a project_code
  // ending in a digit (e.g. PROJECT_V2) made `.../PROJECT_V2-07-name/...` match
  // the `2-` inside `V2-` BEFORE reaching the real `07-` phase token —
  // resolving phase "2" instead of phase "7". findPhaseInternal also searches
  // archived milestones, so an existing archived phase 2 produced a real branch
  // name, and the silent `git checkout <existing-branch>` fallback switched the
  // whole working tree onto the wrong branch in the same call that then
  // committed. This fixture reproduces both preconditions.
  test('#2539: digit-suffixed project_code does not collide with the phase number', () => {
    // Configure phase branching strategy with a project_code ending in a digit.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        project_code: 'PROJECT_V2',
        branching_strategy: 'phase',
        phase_branch_template: 'gsd/phase-{phase}-{slug}',
      })
    );

    // Archived phase 02 under a shipped milestone — the collision target that
    // findPhaseInternal reaches via the .planning/milestones/<v>-phases/ search.
    fs.mkdirSync(
      path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', 'PROJECT_V2-02-archived-phase'),
      { recursive: true }
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', 'PROJECT_V2-02-archived-phase', '02-CONTEXT.md'),
      '# Archived\n'
    );

    // Active phase 07 — the phase actually being committed.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', 'PROJECT_V2-07-active-phase'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 7: Active Phase\nGoal: ship it\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', 'PROJECT_V2-07-active-phase', '07-CONTEXT.md'),
      '# Context\n'
    );

    const result = runGsdTools(
      'commit "docs(07): add context" --files .planning/phases/PROJECT_V2-07-active-phase/07-CONTEXT.md',
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.committed, true, 'should have committed');

    // #3207: the commit now CREATES and SWITCHES to the phase branch. The
    // resolved branch is phase-07 (correct, not the archived 02), and HEAD
    // moves onto it so the phase's work accumulates there.
    const branch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    assert.notStrictEqual(
      branch,
      'gsd/phase-02-archived-phase',
      `must NOT be on the archived phase-02 branch (got ${branch})`
    );
    // #3207: HEAD must land on the CORRECT freshly-created phase-07 branch.
    assert.strictEqual(
      branch,
      'gsd/phase-07-active-phase',
      `must switch onto the correct phase-07 branch (got ${branch})`
    );
    // Verify the correct phase-07 branch was created (not the archived 02)
    const phase07Exists = gitOrThrow(
      ['rev-parse', '--verify', 'gsd/phase-07-active-phase'],
      { cwd: tmpDir }
    );
    assert.ok(phase07Exists.trim(), 'phase-07 branch should be created (not the archived phase-02)');

    // The committed file must exist on HEAD, proving the commit landed.
    const committedFile = gitOrThrow(
      ['show', 'HEAD:.planning/phases/PROJECT_V2-07-active-phase/07-CONTEXT.md'],
      { cwd: tmpDir }
    );
    assert.ok(committedFile.includes('# Context'), 'phase-07 file must be in the commit');
  });

  // #2539 second defect: an auto-checkout mid-commit must never be silent. The
  // #1278 intent was to CREATE the phase branch before the FIRST commit on it —
  // not to force-switch an already-checked-out working branch onto a different
  // existing branch. If the resolved phase branch already exists and the working
  // tree is on some other branch, switching to it silently is the dangerous
  // drift; the fix keeps create-if-absent but drops the silent switch-to-existing.
  test('#2539: does not silently switch onto an existing unrelated phase branch', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        branching_strategy: 'phase',
        phase_branch_template: 'gsd/phase-{phase}-{slug}',
      })
    );
    // Active phase 01.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-first-phase'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 1: First Phase\nGoal: start\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '01-first-phase', '01-CONTEXT.md'),
      '# Context\n'
    );

    // Pre-create the phase-01 branch and check it out, then return to the
    // default branch so the working tree is NOT on the phase branch when commit
    // runs. The resolved branch already exists; the pre-fix code silently
    // switched onto it.
    gitOrThrow(['branch', 'gsd/phase-01-first-phase'], { cwd: tmpDir });
    // Ensure the file is staged only by the commit command itself (it must run
    // from the current/default branch and must not be force-switched).
    const beforeBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();

    // Invoke gsd-tools via the process seam so stderr is observable on the
    // success path — the warning that proves the no-switch path is not silent
    // (#2539 AC2) is written to stderr, which execFileSync discards on success.
    const { TOOLS_PATH } = require('./helpers.cjs');
    const proc = runNode([
      TOOLS_PATH, 'commit', 'docs(01): add context',
      '--files', '.planning/phases/01-first-phase/01-CONTEXT.md',
    ], { cwd: tmpDir });
    throwIfFailed(proc, 'gsd-tools commit (#2539 no-switch fixture)');
    const stdout = proc.stdout || '';
    const stderr = proc.stderr || '';

    const output = JSON.parse(stdout.trim());
    assert.strictEqual(output.committed, true, 'should have committed');

    // The command must NOT have silently switched the working tree onto the
    // pre-existing phase branch. The commit lands on the branch we were on.
    const afterBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    assert.strictEqual(
      afterBranch,
      beforeBranch,
      `must not silently switch onto an existing phase branch mid-commit (was ${beforeBranch}, now ${afterBranch})`
    );

    // #2539/#3079 AC2: the no-switch path must not be silent. The warning
    // surfaces the resolved branch and the branch the commit actually lands on.
    // Note: stderr may also contain config-loader warnings; the branching warning
    // is the one we assert on.
    assert.ok(
      /Warning: resolved.*branch .* already exists/.test(stderr),
      `expected a non-silent warning on stderr when the resolved branch already exists; got stderr=${stderr}`
    );
  });

  // #3207 AC3: the fresh-create path must NOT be silent. Pre-fix the first
  // phase-scoped commit produced no output at all, so the divergence between
  // "phase branch exists" and "phase work is on it" started invisibly. The fix
  // logs the create+switch on stderr.
  test('#3207: fresh phase-branch create is non-silent (logs create+switch)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        branching_strategy: 'phase',
        phase_branch_template: 'gsd/phase-{phase}-{slug}',
      })
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 1: Setup\nGoal: Initial setup\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '01-setup', '01-CONTEXT.md'), '# Context\n'
    );

    // Observe stderr on the success path via the process seam (execFileSync
    // discards stderr on success — same reason the #2539 test uses runNode).
    const { TOOLS_PATH } = require('./helpers.cjs');
    const proc = runNode([
      TOOLS_PATH, 'commit', 'docs(01): add context',
      '--files', '.planning/phases/01-setup/01-CONTEXT.md',
    ], { cwd: tmpDir });
    throwIfFailed(proc, 'gsd-tools commit (#3207 non-silent fixture)');
    const stderr = proc.stderr || '';

    // The fresh create must announce itself — not the "already exists" wording
    // (that belongs to the existing-branch path) but a create+switch notice.
    assert.ok(
      /created.*switched|switched.*created/i.test(stderr) ||
        /phase-01-setup/i.test(stderr),
      `expected a non-silent create+switch notice on stderr; got stderr=${stderr}`
    );
  });

  // #3207 AC5: once the first commit has switched HEAD onto the phase branch,
  // a second phase-scoped commit must NOT emit the misleading "already exists"
  // warning — the currentBranch === branchName guard skips the block entirely.
  test('#3207: second phase commit does not re-warn once HEAD is on the phase branch', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        branching_strategy: 'phase',
        phase_branch_template: 'gsd/phase-{phase}-{slug}',
      })
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 1: Setup\nGoal: Initial setup\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '01-setup', '01-CONTEXT.md'), '# Context\n'
    );

    const { TOOLS_PATH } = require('./helpers.cjs');

    // First commit — fresh create, switches onto the phase branch.
    const first = runNode([
      TOOLS_PATH, 'commit', 'docs(01): first',
      '--files', '.planning/phases/01-setup/01-CONTEXT.md',
    ], { cwd: tmpDir });
    throwIfFailed(first, 'gsd-tools commit (#3207 first)');
    const branchAfterFirst = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    assert.strictEqual(branchAfterFirst, 'gsd/phase-01-setup', 'first commit must switch onto the phase branch');

    // Second commit — HEAD is already on the phase branch, so the block is
    // skipped and NO "already exists" warning should appear.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '01-setup', '02-NOTES.md'), '# Notes\n'
    );
    const second = runNode([
      TOOLS_PATH, 'commit', 'docs(01): second',
      '--files', '.planning/phases/01-setup/02-NOTES.md',
    ], { cwd: tmpDir });
    throwIfFailed(second, 'gsd-tools commit (#3207 second)');
    const secondStderr = second.stderr || '';
    assert.ok(
      !/already exists/i.test(secondStderr),
      `second commit must not re-warn once on the phase branch; got stderr=${secondStderr}`
    );
  });

  // #4055 — a phase branch that existed, was merged into the base branch, and
  // was then deleted must NOT be resurrected on the next phase-scoped commit.
  // Pre-fix, `rev-parse --verify` can't distinguish "never existed" from
  // "existed, merged, deleted" (both fail verify), so the create-and-switch
  // path silently re-created the branch and committed the next phase's work
  // onto it instead of the current (base) branch.
  test('#4055: does not resurrect a merged-and-deleted phase branch', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        branching_strategy: 'phase',
        phase_branch_template: 'gsd/phase-{phase}-{slug}',
      })
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 1: Setup\nGoal: Initial setup\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '01-setup', '01-CONTEXT.md'), '# Context\n'
    );

    const { TOOLS_PATH } = require('./helpers.cjs');
    const baseBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();

    // First commit — fresh create, switches onto gsd/phase-01-setup.
    const first = runNode([
      TOOLS_PATH, 'commit', 'docs(01): first',
      '--files', '.planning/phases/01-setup/01-CONTEXT.md',
    ], { cwd: tmpDir });
    throwIfFailed(first, 'gsd-tools commit (#4055 first)');
    assert.strictEqual(
      gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim(),
      'gsd/phase-01-setup',
      'first commit must switch onto the phase branch'
    );

    // Merge the phase branch back into the base branch (a real merge commit,
    // as a completed phase's PR would produce) and delete it — the branch
    // name no longer resolves to any ref, exactly like the never-existed case.
    gitOrThrow(['checkout', baseBranch], { cwd: tmpDir });
    gitOrThrow(['merge', '--no-ff', '-m', "Merge branch 'gsd/phase-01-setup'", 'gsd/phase-01-setup'], { cwd: tmpDir });
    gitOrThrow(['branch', '-D', 'gsd/phase-01-setup'], { cwd: tmpDir });

    // Next phase-scoped commit resolves to the SAME branch name (e.g. a second
    // capture into phase 01, or a re-run after the phase's PR merged). It must
    // commit on the base branch, not resurrect the deleted branch.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '01-setup', '02-NOTES.md'), '# Notes\n'
    );
    const second = runNode([
      TOOLS_PATH, 'commit', 'docs(01): second',
      '--files', '.planning/phases/01-setup/02-NOTES.md',
    ], { cwd: tmpDir });
    throwIfFailed(second, 'gsd-tools commit (#4055 second)');

    const afterBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    assert.strictEqual(
      afterBranch,
      baseBranch,
      `must not resurrect the merged-and-deleted phase branch (expected to stay on "${baseBranch}", got "${afterBranch}")`
    );
    const stillDeleted = runGit(['rev-parse', '--verify', 'refs/heads/gsd/phase-01-setup'], { cwd: tmpDir });
    assert.notStrictEqual(
      stillDeleted.exitCode,
      0,
      'the deleted phase branch must not have been re-created'
    );

    const secondStderr = second.stderr || '';
    assert.ok(
      /previously merged and deleted/i.test(secondStderr),
      `expected a non-silent warning about the merged-and-deleted branch; got stderr=${secondStderr}`
    );
  });

  // #4055 v2 (PR #4080 review): the first fix only detected resurrection via
  // `git log --merges --grep=<branchName>`, which requires a real two-parent
  // merge commit. A squash merge is single-parent and never matches, so the
  // branch was still resurrected after a squash close-out — reproduced by all
  // three review passes against the PR's own head commit. The replacement
  // check is content-based (does HEAD's history already contain a commit that
  // touched the phase's own directory), which a squash merge satisfies
  // identically to a `--no-ff` merge.
  test('#4055 v2: does not resurrect a phase branch closed out via squash merge', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        branching_strategy: 'phase',
        phase_branch_template: 'gsd/phase-{phase}-{slug}',
      })
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 1: Setup\nGoal: Initial setup\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '01-setup', '01-CONTEXT.md'), '# Context\n'
    );

    const { TOOLS_PATH } = require('./helpers.cjs');
    const baseBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();

    const first = runNode([
      TOOLS_PATH, 'commit', 'docs(01): first',
      '--files', '.planning/phases/01-setup/01-CONTEXT.md',
    ], { cwd: tmpDir });
    throwIfFailed(first, 'gsd-tools commit (#4055v2 squash first)');
    assert.strictEqual(
      gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim(),
      'gsd/phase-01-setup',
      'first commit must switch onto the phase branch'
    );

    // Squash merge — single-parent, no merge commit, message need not mention
    // the branch name at all (mirrors GitHub's "Squash and merge").
    gitOrThrow(['checkout', baseBranch], { cwd: tmpDir });
    gitOrThrow(['merge', '--squash', 'gsd/phase-01-setup'], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'Phase 01 (#1)'], { cwd: tmpDir });
    gitOrThrow(['branch', '-D', 'gsd/phase-01-setup'], { cwd: tmpDir });

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '01-setup', '02-NOTES.md'), '# Notes\n'
    );
    const second = runNode([
      TOOLS_PATH, 'commit', 'docs(01): second',
      '--files', '.planning/phases/01-setup/02-NOTES.md',
    ], { cwd: tmpDir });
    throwIfFailed(second, 'gsd-tools commit (#4055v2 squash second)');

    const afterBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    assert.strictEqual(
      afterBranch,
      baseBranch,
      `must not resurrect the squash-merged-and-deleted phase branch (expected to stay on "${baseBranch}", got "${afterBranch}")`
    );
    const stillDeleted = runGit(['rev-parse', '--verify', 'refs/heads/gsd/phase-01-setup'], { cwd: tmpDir });
    assert.notStrictEqual(
      stillDeleted.exitCode,
      0,
      'the deleted phase branch must not have been re-created'
    );
  });

  // #4055 v2 (PR #4080 review): a rebase merge is also single-parent per
  // replayed commit — no merge commit exists at all, so the message-grep
  // heuristic could never have covered it either.
  test('#4055 v2: does not resurrect a phase branch closed out via rebase merge', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        branching_strategy: 'phase',
        phase_branch_template: 'gsd/phase-{phase}-{slug}',
      })
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 1: Setup\nGoal: Initial setup\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '01-setup', '01-CONTEXT.md'), '# Context\n'
    );

    const { TOOLS_PATH } = require('./helpers.cjs');
    const baseBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();

    const first = runNode([
      TOOLS_PATH, 'commit', 'docs(01): first',
      '--files', '.planning/phases/01-setup/01-CONTEXT.md',
    ], { cwd: tmpDir });
    throwIfFailed(first, 'gsd-tools commit (#4055v2 rebase first)');
    assert.strictEqual(
      gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim(),
      'gsd/phase-01-setup',
      'first commit must switch onto the phase branch'
    );

    // Rebase merge — replays the phase branch's commits onto base as
    // single-parent commits, then fast-forwards; no merge commit is created.
    gitOrThrow(['rebase', baseBranch, 'gsd/phase-01-setup'], { cwd: tmpDir });
    gitOrThrow(['checkout', baseBranch], { cwd: tmpDir });
    gitOrThrow(['merge', '--ff-only', 'gsd/phase-01-setup'], { cwd: tmpDir });
    gitOrThrow(['branch', '-D', 'gsd/phase-01-setup'], { cwd: tmpDir });

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '01-setup', '02-NOTES.md'), '# Notes\n'
    );
    const second = runNode([
      TOOLS_PATH, 'commit', 'docs(01): second',
      '--files', '.planning/phases/01-setup/02-NOTES.md',
    ], { cwd: tmpDir });
    throwIfFailed(second, 'gsd-tools commit (#4055v2 rebase second)');

    const afterBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    assert.strictEqual(
      afterBranch,
      baseBranch,
      `must not resurrect the rebase-merged-and-deleted phase branch (expected to stay on "${baseBranch}", got "${afterBranch}")`
    );
    const stillDeleted = runGit(['rev-parse', '--verify', 'refs/heads/gsd/phase-01-setup'], { cwd: tmpDir });
    assert.notStrictEqual(
      stillDeleted.exitCode,
      0,
      'the deleted phase branch must not have been re-created'
    );
  });

  // #4055 v2 (PR #4080 review, Minor): the prior `--grep=<branchName>` check
  // was an unanchored substring match — a merge commit that merely MENTIONS
  // a branch name in its message (without ever having merged that branch)
  // would false-positively block create-and-switch for a branch that never
  // existed. The content-based check only matches a commit that actually
  // touched the phase's own directory, so this must still create-and-switch.
  test('#4055 v2: a branch name merely mentioned in an unrelated commit message does not block create-and-switch', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        branching_strategy: 'phase',
        phase_branch_template: 'gsd/phase-{phase}-{slug}',
      })
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-other'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 2: Other\nGoal: Unrelated work\n'
    );

    // An unrelated merge commit whose message happens to name a phase-02
    // branch that has never existed as a ref.
    fs.writeFileSync(path.join(tmpDir, 'unrelated.txt'), 'unrelated\n');
    gitOrThrow(['add', 'unrelated.txt'], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', "docs: mention gsd/phase-02-other in migration guide"], { cwd: tmpDir });

    const { TOOLS_PATH } = require('./helpers.cjs');
    const baseBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '02-other', '01-CONTEXT.md'), '# Context\n'
    );
    const result = runNode([
      TOOLS_PATH, 'commit', 'docs(02): first',
      '--files', '.planning/phases/02-other/01-CONTEXT.md',
    ], { cwd: tmpDir });
    throwIfFailed(result, 'gsd-tools commit (#4055v2 false-positive)');

    const afterBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    assert.strictEqual(
      afterBranch,
      'gsd/phase-02-other',
      `a never-existed branch merely named in an unrelated commit message must still be created-and-switched-to (expected "gsd/phase-02-other", got "${afterBranch}")`
    );
  });

  // #3734 — the phase arm of `query commit` must not treat a backlog sentinel
  // phase id as a real phase. /gsd-capture --backlog commits the sentinel phase
  // directory via add-backlog.md; pre-fix each capture created AND switched to a
  // gsd/phase-999.<n>-<slug> branch, scattering backlog items across branches
  // and leaving the operator's branch at the base commit.
  test('#3734: 999.x backlog sentinel commits on the current branch and creates no phase branch', () => {
    const startBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        branching_strategy: 'phase',
        phase_branch_template: 'gsd/phase-{phase}-{slug}',
      })
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '999.42-first-idea'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '999.42-first-idea', '.gitkeep'), '# backlog marker\n'
    );

    const result = runGsdTools(
      'commit "docs: add backlog item 999.42 — first idea" --files .planning/phases/999.42-first-idea/.gitkeep',
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.committed, true, 'sentinel capture must still commit');

    const endBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    assert.strictEqual(endBranch, startBranch, '#3734: sentinel capture must not switch branches');
    const sentinelBranches = gitOrThrow(
      ['branch', '--list', 'gsd/phase-999*'], { cwd: tmpDir }
    ).trim();
    assert.strictEqual(sentinelBranches, '', '#3734: no gsd/phase-999.* branch may be created');
    // The "lost work" mode from the issue: the commit must be reachable on the
    // branch the operator was actually on. gitOrThrow throws if the path is
    // absent from startBranch, so reaching the content assertion proves it.
    const onStartBranch = gitOrThrow(
      ['show', `${startBranch}:.planning/phases/999.42-first-idea/.gitkeep`], { cwd: tmpDir }
    );
    assert.ok(onStartBranch.includes('# backlog marker'), 'sentinel commit must land on the starting branch');
  });

  test('#3734: 0.x backlog sentinel also never creates a phase branch', () => {
    const startBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        commit_docs: true,
        branching_strategy: 'phase',
        phase_branch_template: 'gsd/phase-{phase}-{slug}',
      })
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '0.3-icebox-idea'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases', '0.3-icebox-idea', '.gitkeep'), '# icebox marker\n');

    const result = runGsdTools(
      'commit "docs: add backlog item 0.3 — icebox idea" --files .planning/phases/0.3-icebox-idea/.gitkeep',
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).committed, true, '0.x capture must still commit');

    const endBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    assert.strictEqual(endBranch, startBranch, '#3734: 0.x sentinel must not switch branches');
    const sentinelBranches = gitOrThrow(
      ['branch', '--list', 'gsd/phase-0*'], { cwd: tmpDir }
    ).trim();
    assert.strictEqual(sentinelBranches, '', '#3734: no gsd/phase-0.* branch may be created');
    const onStartBranch = gitOrThrow(
      ['show', `${startBranch}:.planning/phases/0.3-icebox-idea/.gitkeep`], { cwd: tmpDir }
    );
    assert.ok(onStartBranch.includes('# icebox marker'), '0.x sentinel commit must land on the starting branch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// groupFilesBySubrepo tests (#311)
// ─────────────────────────────────────────────────────────────────────────────

describe('groupFilesBySubrepo (#311)', () => {
  const { groupFilesBySubrepo } = require('../gsd-core/bin/lib/commands.cjs');

  test('single-segment subrepos route files correctly and unmatched collected', () => {
    const result = groupFilesBySubrepo(
      ['packages/a.js', 'docs/x.md', 'README.md'],
      ['packages', 'docs']
    );
    assert.deepStrictEqual(result.grouped, { packages: ['packages/a.js'], docs: ['docs/x.md'] });
    assert.deepStrictEqual(result.unmatched, ['README.md']);
  });

  test('multi-segment subrepo matches deep files, not shallow sibling', () => {
    const result = groupFilesBySubrepo(
      ['vendor/pkg/x.js', 'vendor/other.js', 'vendor/pkg/y.js'],
      ['vendor/pkg']
    );
    assert.deepStrictEqual(result.grouped, { 'vendor/pkg': ['vendor/pkg/x.js', 'vendor/pkg/y.js'] });
    assert.deepStrictEqual(result.unmatched, ['vendor/other.js']);
  });

  test('longest-prefix wins, not first-match-in-array-order (#391)', () => {
    // 'app' precedes 'app/sub' in array order, but 'app/sub' is the more specific
    // configured sub-repo, so 'app/sub/f.js' must route to 'app/sub'.
    const result = groupFilesBySubrepo(
      ['app/sub/f.js'],
      ['app', 'app/sub']
    );
    assert.deepStrictEqual(result.grouped, { 'app/sub': ['app/sub/f.js'] });
    assert.deepStrictEqual(result.unmatched, []);
  });

  test('longest-prefix selection is independent of sub_repos array order (#391)', () => {
    // Reverse array order: longest-prefix must still win (no array-order workaround).
    const result = groupFilesBySubrepo(
      ['app/sub/f.js'],
      ['app/sub', 'app']
    );
    assert.deepStrictEqual(result.grouped, { 'app/sub': ['app/sub/f.js'] });
    assert.deepStrictEqual(result.unmatched, []);
  });

  test('nested sub-repos route by specificity; shallow files stay shallow (#391)', () => {
    // Exact repro from #391 plus a shallow sibling file under the parent sub-repo.
    const result = groupFilesBySubrepo(
      ['packages/core/widget.js', 'packages/util.js'],
      ['packages', 'packages/core']
    );
    assert.deepStrictEqual(result.grouped, {
      'packages/core': ['packages/core/widget.js'],
      packages: ['packages/util.js'],
    });
    assert.deepStrictEqual(result.unmatched, []);
  });

  test('three-level nesting routes to the deepest matching prefix (#391)', () => {
    const result = groupFilesBySubrepo(
      ['a/b/c/f.js', 'a/b/g.js', 'a/h.js'],
      ['a', 'a/b', 'a/b/c']
    );
    assert.deepStrictEqual(result.grouped, {
      'a/b/c': ['a/b/c/f.js'],
      'a/b': ['a/b/g.js'],
      a: ['a/h.js'],
    });
    assert.deepStrictEqual(result.unmatched, []);
  });

  test('file with no slash does not match a same-name subrepo', () => {
    const result = groupFilesBySubrepo(['top'], ['top']);
    assert.deepStrictEqual(result.grouped, {});
    assert.deepStrictEqual(result.unmatched, ['top']);
  });

  test('file with slash after prefix routes correctly', () => {
    const result = groupFilesBySubrepo(['top/a'], ['top']);
    assert.deepStrictEqual(result.grouped, { top: ['top/a'] });
    assert.deepStrictEqual(result.unmatched, []);
  });

  test('empty files list returns empty grouped and unmatched', () => {
    const result = groupFilesBySubrepo([], ['a']);
    assert.deepStrictEqual(result.grouped, {});
    assert.deepStrictEqual(result.unmatched, []);
  });

  test('empty subRepos list puts all files in unmatched', () => {
    const result = groupFilesBySubrepo(['a/b'], []);
    assert.deepStrictEqual(result.grouped, {});
    assert.deepStrictEqual(result.unmatched, ['a/b']);
  });

  test('non-string subRepos entry does not throw and string entries still route (#311)', () => {
    // Old inline code coerced non-string repos via `repo + '/'` and never threw.
    let result;
    assert.doesNotThrow(() => {
      result = groupFilesBySubrepo(['a/b', 'README.md'], [null, 'a']);
    });
    assert.deepStrictEqual(result.grouped, { a: ['a/b'] });
    assert.deepStrictEqual(result.unmatched, ['README.md']);
  });

  test('non-string entry in a matched bucket does not throw (#391)', () => {
    // A null sub_repos entry shares the 'null' first-segment bucket with a real
    // multi-segment entry; longest-prefix selection must not throw reading length.
    let result;
    assert.doesNotThrow(() => {
      result = groupFilesBySubrepo(['null/a/f.js'], [null, 'null/a']);
    });
    assert.deepStrictEqual(result.grouped, { 'null/a': ['null/a/f.js'] });
    assert.deepStrictEqual(result.unmatched, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdWebsearch tests (CMD-05)
// ─────────────────────────────────────────────────────────────────────────────

describe('websearch command', () => {
  const { cmdWebsearch } = require('../gsd-core/bin/lib/commands.cjs');
  let origFetch;
  let origApiKey;
  let origWriteSync;
  let captured;

  beforeEach(() => {
    origFetch = global.fetch;
    origApiKey = process.env.BRAVE_API_KEY;
    origWriteSync = fs.writeSync;
    captured = '';
    // output() uses fs.writeSync(1, data) since #1276 — mock it to capture output
    fs.writeSync = (fd, data) => { if (fd === 1) captured += data; return Buffer.byteLength(String(data)); };
  });

  afterEach(() => {
    global.fetch = origFetch;
    if (origApiKey !== undefined) {
      process.env.BRAVE_API_KEY = origApiKey;
    } else {
      delete process.env.BRAVE_API_KEY;
    }
    fs.writeSync = origWriteSync;
  });

  test('returns available=false when BRAVE_API_KEY is unset', async () => {
    delete process.env.BRAVE_API_KEY;

    await cmdWebsearch('test query', {}, false);

    const output = JSON.parse(captured);
    assert.strictEqual(output.available, false);
    assert.ok(output.reason.includes('BRAVE_API_KEY'), 'should mention missing API key');
  });

  test('returns error when no query provided', async () => {
    process.env.BRAVE_API_KEY = 'test-key';

    await cmdWebsearch(null, {}, false);

    const output = JSON.parse(captured);
    assert.strictEqual(output.available, false);
    assert.ok(output.error.includes('Query required'), 'should mention query required');
  });

  test('returns results for successful API response', async () => {
    process.env.BRAVE_API_KEY = 'test-key';

    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        web: {
          results: [
            { title: 'Test Result', url: 'https://example.com', description: 'A test result', age: '1d' },
          ],
        },
      }),
    });

    await cmdWebsearch('test query', { limit: 5, freshness: 'pd' }, false);

    const output = JSON.parse(captured);
    assert.strictEqual(output.available, true);
    assert.strictEqual(output.query, 'test query');
    assert.strictEqual(output.count, 1);
    assert.strictEqual(output.results[0].title, 'Test Result');
    assert.strictEqual(output.results[0].url, 'https://example.com');
    assert.strictEqual(output.results[0].age, '1d');
  });

  test('constructs correct URL parameters', async () => {
    process.env.BRAVE_API_KEY = 'test-key';
    let capturedUrl = '';

    global.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      };
    };

    await cmdWebsearch('node.js testing', { limit: 5, freshness: 'pd' }, false);

    const parsed = new URL(capturedUrl);
    assert.strictEqual(parsed.searchParams.get('q'), 'node.js testing', 'query param should decode to original string');
    assert.strictEqual(parsed.searchParams.get('count'), '5', 'count param should be 5');
    assert.strictEqual(parsed.searchParams.get('freshness'), 'pd', 'freshness param should be pd');
  });

  test('handles API error (non-200 status)', async () => {
    process.env.BRAVE_API_KEY = 'test-key';

    global.fetch = async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
    });

    await cmdWebsearch('test query', {}, false);

    const output = JSON.parse(captured);
    assert.strictEqual(output.available, false);
    assert.ok(output.error.includes('401'), 'error should include status code');
  });

  test('handles network failure', async () => {
    process.env.BRAVE_API_KEY = 'test-key';

    global.fetch = async () => {
      throw new Error('Network timeout');
    };

    await cmdWebsearch('test query', {}, false);

    const output = JSON.parse(captured);
    assert.strictEqual(output.available, false);
    assert.strictEqual(output.error, 'Network timeout');
  });

  // ── New retry/timeout tests (A–E) ──────────────────────────────────────────

  test('A. timeout is bounded: AbortSignal fires, resolves with available=false and attempts field', async (t) => {
    process.env.BRAVE_API_KEY = 'test-key';
    process.env.GSD_WEBSEARCH_TIMEOUT_MS = '20';
    t.after(() => { delete process.env.GSD_WEBSEARCH_TIMEOUT_MS; });

    global.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });

    await cmdWebsearch('q', {}, false);

    const output = JSON.parse(captured);
    assert.strictEqual(output.available, false, 'should be available=false after timeout exhaustion');
    assert.ok(typeof output.attempts === 'number', 'should include attempts field');
  });

  test('B. retry on 503 then success: succeeds on 2nd attempt, fetch called exactly twice', async () => {
    process.env.BRAVE_API_KEY = 'test-key';
    let callCount = 0;

    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 503, headers: { get: () => null } };
      }
      return {
        ok: true,
        json: async () => ({
          web: { results: [{ title: 'T', url: 'https://example.com', description: 'D' }] },
        }),
      };
    };

    await cmdWebsearch('test query', {}, false);

    const output = JSON.parse(captured);
    assert.strictEqual(output.available, true, 'should succeed after retry');
    assert.strictEqual(output.results.length, 1, 'should have one result');
    assert.strictEqual(callCount, 2, 'fetch should be called exactly twice');
  });

  test('C. 429 honors Retry-After then succeeds on 2nd call, fetch called exactly twice', async () => {
    process.env.BRAVE_API_KEY = 'test-key';
    let callCount = 0;

    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '0' : null },
        };
      }
      return {
        ok: true,
        json: async () => ({
          web: { results: [{ title: 'T', url: 'https://example.com', description: 'D' }] },
        }),
      };
    };

    await cmdWebsearch('test query', {}, false);

    const output = JSON.parse(captured);
    assert.strictEqual(output.available, true, 'should succeed after 429 retry');
    assert.strictEqual(callCount, 2, 'fetch should be called exactly twice');
  });

  test('D. no retry on 401: fails immediately, fetch called exactly once', async () => {
    process.env.BRAVE_API_KEY = 'test-key';
    let callCount = 0;

    global.fetch = async () => {
      callCount++;
      return { ok: false, status: 401, headers: { get: () => null } };
    };

    await cmdWebsearch('test query', {}, false);

    const output = JSON.parse(captured);
    assert.strictEqual(output.available, false, 'should be available=false');
    assert.strictEqual(output.error, 'API error: 401', 'error should be API error: 401');
    assert.strictEqual(output.attempts, undefined, 'should NOT have attempts field on immediate fail');
    assert.strictEqual(callCount, 1, 'fetch should be called exactly once');
  });

  test('E. network error retried then exhausted: attempts=3, fetch called 3 times', async () => {
    process.env.BRAVE_API_KEY = 'test-key';
    let callCount = 0;

    global.fetch = async () => {
      callCount++;
      throw new Error('boom');
    };

    await cmdWebsearch('test query', {}, false);

    const output = JSON.parse(captured);
    assert.strictEqual(output.available, false, 'should be available=false');
    assert.ok(output.error.includes('boom'), 'error should include boom');
    assert.strictEqual(output.attempts, 3, 'attempts should be 3');
    assert.strictEqual(callCount, 3, 'fetch should be called 3 times');
  });
});

describe('stats command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // #3217 (ADR-3180 §7.6 rule 4): a free-form ROADMAP.md (no version token
    // anywhere) is COMPLETE scope for windowing (§7.1) — without this, an
    // absent ROADMAP.md is UNREADABLE and stats withholds `percent`/counts.
    // Individual tests below that write their own ROADMAP.md content
    // overwrite this baseline.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns valid JSON with empty project', () => {
    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    assert.ok(Array.isArray(stats.phases), 'phases should be an array');
    assert.strictEqual(stats.total_plans, 0);
    assert.strictEqual(stats.total_summaries, 0);
    assert.strictEqual(stats.percent, 0);
    assert.strictEqual(stats.phases_completed, 0);
    assert.strictEqual(stats.phases_total, 0);
    assert.strictEqual(stats.requirements_total, 0);
    assert.strictEqual(stats.requirements_complete, 0);
  });

  test('counts phases, plans, and summaries correctly', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    const p2 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(p1, { recursive: true });
    fs.mkdirSync(p2, { recursive: true });

    // Phase 1: 2 plans, 2 summaries, passing verification (complete)
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-02-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, '01-02-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, 'VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification');

    // Phase 2: 1 plan, 0 summaries (planned)
    fs.writeFileSync(path.join(p2, '02-01-PLAN.md'), '# Plan');

    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    assert.strictEqual(stats.phases_total, 2);
    assert.strictEqual(stats.phases_completed, 1);
    assert.strictEqual(stats.total_plans, 3);
    assert.strictEqual(stats.total_summaries, 2);
    assert.strictEqual(stats.percent, 50);
    assert.strictEqual(stats.plan_percent, 67);
  });

  // #3473 F2 (companion to #3357): determinePhaseStatus now resolves its
  // *-VERIFICATION.md via the shared resolveVerificationFile resolver instead
  // of a hand-rolled `.find()` over unsorted readdir() order. Before this fix,
  // which of a canonical report and an ad-hoc `-CORRECTION-VERIFICATION.md`
  // worksheet "won" was filesystem-dependent; the canonical report must now
  // win deterministically regardless of directory-listing order.
  test('#3473 F2: phase status resolves the canonical report over a -CORRECTION- worksheet, not readdir order', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '03-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '03-01-SUMMARY.md'), '# Summary');
    // The ad-hoc worksheet reports gaps_found; if it won the pick, the phase
    // would read 'Executed', not 'Complete'.
    fs.writeFileSync(path.join(p1, '03-CORRECTION-VERIFICATION.md'), '---\nstatus: gaps_found\n---\n# Correction worksheet');
    fs.writeFileSync(path.join(p1, '03-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification');

    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    const phase = stats.phases.find(p => p.number === '03');
    assert.ok(phase, 'phase 03 must be present in stats output');
    assert.strictEqual(phase.status, 'Complete', 'the canonical 03-VERIFICATION.md must win over the CORRECTION worksheet');
  });

  // #3511 BLOCKER-2 regression: a cross-phase stray VERIFICATION.md must not
  // resolve as THIS phase's report. Phase 03's directory holds only a
  // '04-VERIFICATION.md' (belongs to phase 04); an unscoped resolver would
  // pick it up as phase 03's own report and read 'Complete'.
  test('#3511: phase status is not Complete off a cross-phase stray VERIFICATION.md', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '03-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '03-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '03-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, '04-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification');

    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    const phase = stats.phases.find(p => p.number === '03');
    assert.ok(phase, 'phase 03 must be present in stats output');
    assert.notStrictEqual(phase.status, 'Complete',
      `phase 03 must not report Complete off phase 04's report; got: ${phase.status}`);
  });

  test('counts requirements from REQUIREMENTS.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

- [x] **AUTH-01**: User can sign up
- [x] **AUTH-02**: User can log in
- [ ] **API-01**: REST endpoints
- [ ] **API-02**: GraphQL support
`
    );

    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    assert.strictEqual(stats.requirements_total, 4);
    assert.strictEqual(stats.requirements_complete, 2);
  });

  test('reads last activity from STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Last Activity:** 2025-06-15\n**Last Activity Description:** Working\n`
    );

    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    assert.strictEqual(stats.last_activity, '2025-06-15');
  });

  test('reads last activity from plain STATE.md template format', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n## Current Position\n\nPhase: 1 of 2 (Foundation)\nPlan: 1 of 1 in current phase\nStatus: In progress\nLast activity: 2025-06-16 — Finished plan 01-01\n`
    );

    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    assert.strictEqual(stats.last_activity, '2025-06-16 — Finished plan 01-01');
  });

  test('includes roadmap-only phases in totals and preserves hyphenated names', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '14-auth-hardening');
    const p2 = path.join(tmpDir, '.planning', 'phases', '15-proof-generation');
    fs.mkdirSync(p1, { recursive: true });
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p1, '14-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '14-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, 'VERIFICATION.md'), '---\nstatus: passed\n---\n# Verified');
    fs.writeFileSync(path.join(p2, '15-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p2, '15-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p2, 'VERIFICATION.md'), '---\nstatus: passed\n---\n# Verified');

    // #3217 (ADR-3180 §7.6 rule 4): no `vX.Y` token in the milestone heading
    // — the ROADMAP has no STATE.md milestone pointer, so a real version
    // token here would resolve to UNSCOPED (§7.1 row 4: "has versioned
    // milestones, but no version resolved"), not the free-form COMPLETE
    // window this test's counting assertions depend on.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [x] **Phase 14: Auth Hardening**
- [x] **Phase 15: Proof Generation**
- [ ] **Phase 16: Multi-Claim Verification & UX**

## Milestone Growth

### Phase 14: Auth Hardening
**Goal:** Improve auth checks

### Phase 15: Proof Generation
**Goal:** Improve proof generation

### Phase 16: Multi-Claim Verification & UX
**Goal:** Support multi-claim verification
`
    );

    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    assert.strictEqual(stats.phases_total, 3);
    assert.strictEqual(stats.phases_completed, 2);
    assert.strictEqual(stats.percent, 67);
    assert.strictEqual(stats.plan_percent, 100);
    assert.strictEqual(
      stats.phases.find(p => p.number === '16')?.name,
      'Multi-Claim Verification & UX'
    );
    assert.strictEqual(
      stats.phases.find(p => p.number === '16')?.status,
      'Not Started'
    );
  });

  test('reports git commit count and first commit date from repository history', () => {
    gitOrThrow(['init'], { cwd: tmpDir });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
    gitOrThrow(['config', 'user.name', 'Test User'], { cwd: tmpDir });

    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\n');
    gitOrThrow(['add', '-A'], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'initial commit'], {
      cwd: tmpDir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    });

    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Updated\n');
    gitOrThrow(['add', 'README.md'], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'second commit'], {
      cwd: tmpDir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-02-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-02-01T00:00:00Z',
      },
    });

    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    assert.strictEqual(stats.git_commits, 2);
    assert.strictEqual(stats.git_first_commit_date, '2026-01-01');
  });

  test('table format renders readable output', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, 'VERIFICATION.md'), '---\nstatus: passed\n---\n# Verified');

    const result = runGsdTools('stats table', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.ok(parsed.rendered, 'table format should include rendered field');
    assert.ok(parsed.rendered.includes('Statistics'), 'should include Statistics header');
    assert.ok(parsed.rendered.includes('| Phase |'), 'should include table header');
    assert.ok(parsed.rendered.includes('| 1 |'), 'should include phase row');
    assert.ok(parsed.rendered.includes('1/1 phases'), 'should report phase progress');
  });

  test('phase with summaries but no verification is Executed, not Complete', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    const phase = stats.phases.find(p => p.number === '01' || p.number === '1');
    assert.strictEqual(phase.status, 'Executed', 'should be Executed without verification');
    assert.strictEqual(stats.phases_completed, 0, 'unverified phase should not count as completed');
  });

  test('phase with passing verification is Complete', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, 'VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification');
    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    const phase = stats.phases.find(p => p.number === '01' || p.number === '1');
    assert.strictEqual(phase.status, 'Complete', 'should be Complete with passing verification');
    assert.strictEqual(stats.phases_completed, 1);
  });

  test('phase with gaps_found verification is Executed', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, 'VERIFICATION.md'), '---\nstatus: gaps_found\n---\n# Verification');
    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    const phase = stats.phases.find(p => p.number === '01' || p.number === '1');
    assert.strictEqual(phase.status, 'Executed', 'gaps_found should show as Executed');
  });

  test('phase with human_needed verification shows Needs Review', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, 'VERIFICATION.md'), '---\nstatus: human_needed\n---\n# Verification');
    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    const phase = stats.phases.find(p => p.number === '01' || p.number === '1');
    assert.strictEqual(phase.status, 'Needs Review', 'human_needed should show as Needs Review');
  });

  test('progress command also uses verification-aware status', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0 MVP\n`
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('progress json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].status, 'Executed', 'progress should show Executed without verification');
  });

  test('does not duplicate phases when ROADMAP uses unpadded numbers and dirs use padded numbers', () => {
    // ROADMAP.md uses "Phase 1:" (unpadded) but directory is "01-auth" (padded).
    // Without normalization, the Map holds two entries: "1" and "01", doubling phases_total.
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, 'VERIFICATION.md'), '---\nstatus: passed\n---\n# Verified');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Milestone v1',
        '',
        '### Phase 1: Auth',
        '**Goal:** Authentication',
      ].join('\n')
    );

    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    assert.strictEqual(stats.phases_total, 1, 'unpadded ROADMAP heading and padded dir should merge into one phase');
    assert.strictEqual(stats.phases_completed, 1);
    assert.strictEqual(stats.phases.length, 1);
  });

  // ─── #2408: cmdStats last-write-wins fix — colliding dirs fold by precedence ──
  //
  // Two on-disk phase directories that normalize to the same phase key
  // (e.g. `05-real/` + `05-real-stray/`) used to silently overwrite `status`
  // at the directory-scan merge site (last-write-wins), so /gsd-stats could
  // report `Not Started` for a phase that is actually `Complete` depending on
  // fs.readdirSync order. The fix folds colliding statuses by precedence
  // (Complete > Needs Review > Executed > In Progress > Planned > Not Started),
  // so the furthest-along status wins regardless of read order.

  test('#2408: colliding phase directories fold to the furthest-along status (Complete wins over Not Started)', () => {
    // Two dirs that both normalize to phase key "05": `05-real/` (Complete)
    // and `05-real-stray/` (empty → Not Started). The merged status MUST be
    // Complete regardless of which directory the fs yields first.
    const realDir = path.join(tmpDir, '.planning', 'phases', '05-real');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(realDir, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(realDir, 'VERIFICATION.md'), '---\nstatus: passed\n---\n# Verified');

    const strayDir = path.join(tmpDir, '.planning', 'phases', '05-real-stray');
    fs.mkdirSync(strayDir, { recursive: true });

    // ROADMAP declares Phase 5 so the dir-scan finds an explicit phase to populate.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Milestone v1',
        '',
        '### Phase 5: Real',
        '**Goal:** The real phase',
      ].join('\n')
    );

    const result = runGsdTools('stats', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stats = JSON.parse(result.output);
    assert.strictEqual(stats.phases_total, 1, 'two colliding dirs must merge into one phase');
    assert.strictEqual(stats.phases_completed, 1, 'Complete status must win over Not Started after the fold');
    const phase05 = stats.phases.find((p) => p.number === '05');
    assert.ok(phase05, 'phase 05 must appear in stats output');
    assert.strictEqual(phase05.status, 'Complete', 'folded status must be Complete, not Not Started');
  });

  test('#2408: foldPhaseStatus is commutative and order-independent (property)', () => {
    // Direct unit test of the fold: a Complete colliding with a Not Started
    // must yield Complete regardless of argument order. This is the property
    // that makes the merge-site fix correct independent of fs read order.
    const { foldPhaseStatus, PHASE_STATUS_PRECEDENCE } = require('../gsd-core/bin/lib/commands.cjs');
    assert.strictEqual(foldPhaseStatus('Complete', 'Not Started'), 'Complete');
    assert.strictEqual(foldPhaseStatus('Not Started', 'Complete'), 'Complete');
    assert.strictEqual(foldPhaseStatus('Complete', 'Complete'), 'Complete');
    // Every recognized status folded with a lower-precedence one wins.
    for (let i = 0; i < PHASE_STATUS_PRECEDENCE.length - 1; i++) {
      const higher = PHASE_STATUS_PRECEDENCE[i];
      const lower = PHASE_STATUS_PRECEDENCE[i + 1];
      assert.strictEqual(foldPhaseStatus(higher, lower), higher, `${higher} should beat ${lower}`);
      assert.strictEqual(foldPhaseStatus(lower, higher), higher, `${higher} should beat ${lower} (commutative)`);
    }
    // Unrecognized status never beats a recognized one.
    assert.strictEqual(foldPhaseStatus('Complete', '???'), 'Complete');
    assert.strictEqual(foldPhaseStatus('???', 'Complete'), 'Complete');
    // Two unrecognized → returns first arg (deterministic).
    assert.strictEqual(foldPhaseStatus('foo', 'bar'), 'foo');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// check-commit command (#1395)
// ─────────────────────────────────────────────────────────────────────────────

describe('check-commit command', () => {
  const { createTempGitProject } = require('./helpers.cjs');
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('allows commit when commit_docs is true', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: true })
    );
    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.allowed, true);
  });

  test('allows commit when no .planning/ files staged and commit_docs is false', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: false })
    );
    // Stage a non-planning file
    fs.writeFileSync(path.join(tmpDir, 'src.js'), 'console.log("hi")');
    gitOrThrow(['add', 'src.js'], { cwd: tmpDir });

    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.allowed, true);
  });

  test('blocks commit when .planning/ files staged and commit_docs is false', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: false })
    );
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State');
    gitOrThrow(['add', '.planning/STATE.md'], { cwd: tmpDir });

    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(!result.success, 'should block commit');
    assert.ok(result.error.includes('.planning/'), 'error should mention .planning/ files');
    assert.ok(result.error.includes('unstage'), 'error should suggest unstage command');
  });

  // #3588 F1: cmdCheckCommit must resolve the SAME phase_commit_docs.<phase-id>
  // tier `gsd-tools query commit` (cmdCommit) already honors (#3587/#3601).
  // Before this fix, cmdCheckCommit read only project-level `commit_docs`, so
  // a phase with `phase_commit_docs.<n>: true` under project `commit_docs:
  // false` was ALLOWED by `query commit` and BLOCKED by this guard — the
  // hook shipped in this same branch shells out to check-commit, so that
  // contradiction was live. C4/C5 exercise both directions of the override;
  // both fail against the pre-fix tree (project-level-only check).
  test('C4 (#3588/#3587): project commit_docs:false + per-phase true ALLOWS the commit', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: false, phase_commit_docs: { '03': true } })
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-widgets'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases', '03-widgets', 'SUMMARY.md'), '# Three');
    gitOrThrow(['add', '.planning/phases/03-widgets/SUMMARY.md'], { cwd: tmpDir });

    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(
      result.success,
      `phase_commit_docs.03:true must allow the commit even though project commit_docs is false: ${result.error || ''}`,
    );
    const output = JSON.parse(result.output);
    assert.strictEqual(output.allowed, true);
  });

  test('C5 (#3588/#3587): project commit_docs:true + per-phase false BLOCKS the commit', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: true, phase_commit_docs: { '03': false } })
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-widgets'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases', '03-widgets', 'SUMMARY.md'), '# Three');
    gitOrThrow(['add', '.planning/phases/03-widgets/SUMMARY.md'], { cwd: tmpDir });

    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(!result.success, 'phase_commit_docs.03:false must block the commit even though project commit_docs is true');
    assert.ok(result.error.includes('03-widgets/SUMMARY.md'), result.error);
  });

  // #3588 C6: staged paths spanning two phase directories with DIFFERENT
  // phase_commit_docs values must resolve against the FIRST phase (in
  // detectPhaseNumberFromFiles's staged-path order) — the same first-match
  // rule cmdCommit is pinned to (see the folded #3587 `multiPhaseFilesResolves
  // AgainstFirstPhase` test above). This replaces the pre-fix baseline test,
  // which could only assert the phase-blind "blocks everything" behavior
  // because the per-phase tier did not exist here yet.
  test('C6 (#3588): staged paths spanning two phase directories resolve against the FIRST phase, matching cmdCommit', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: false, phase_commit_docs: { '01': true, '02': false } })
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-first'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-second'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases', '01-first', 'SUMMARY.md'), '# One');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases', '02-second', 'SUMMARY.md'), '# Two');
    gitOrThrow(
      ['add', '.planning/phases/01-first/SUMMARY.md', '.planning/phases/02-second/SUMMARY.md'],
      { cwd: tmpDir }
    );

    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(
      result.success,
      `phase 01 (first match) resolves phase_commit_docs.01:true, so the commit must be allowed despite phase 02:false: ${result.error || ''}`,
    );
  });

  // #3588 F2: `git diff --cached --name-only` (no `-z`) C-style-quotes any
  // path containing a non-ASCII byte or another special character — a staged
  // `.planning/café.md` is reported as `".planning/caf\303\251.md"`, which
  // does not start with `.planning/`, so the pre-fix guard MISSED it and
  // allowed the commit — a false negative in the harm direction this guard
  // exists to prevent. These MUST fail against the pre-fix (LF, no `-z`)
  // tree and pass once `-z` + NUL-split lands.
  test('F2 (#3588): a staged .planning/ file with a non-ASCII name is detected and blocked', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: false })
    );
    const unicodeName = '.planning/café.md';
    fs.writeFileSync(path.join(tmpDir, unicodeName), '# State');
    gitOrThrow(['add', unicodeName], { cwd: tmpDir });

    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(!result.success, 'a staged .planning/café.md must be detected and block the commit');
    assert.ok(result.error.includes('café.md'), result.error);
  });

  test('F2 (#3588): a staged .planning/ file with a space in its name is detected and blocked', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: false })
    );
    const spacedName = '.planning/with space.md';
    fs.writeFileSync(path.join(tmpDir, spacedName), '# State');
    gitOrThrow(['add', spacedName], { cwd: tmpDir });

    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(!result.success, 'a staged .planning/ file with a space in its name must be detected and block the commit');
    assert.ok(result.error.includes('with space.md'), result.error);
  });

  test('F2 (#3588): a staged .planning/ file with a quote character in its name is detected and blocked', (t) => {
    // `"` is a reserved NTFS character — a file named `with"quote.md` cannot
    // exist on Windows at all, so the fixture itself is unrepresentable
    // there. This is not a gap in the guard's Windows behavior; it is an
    // input that Windows filesystems reject outright. Do not re-enable this
    // on win32 — see #3588.
    if (process.platform === 'win32') {
      t.skip('a `"` filename is illegal on Windows filesystems (#3588); fixture cannot be created');
      return;
    }
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: false })
    );
    const quotedName = '.planning/with"quote.md';
    fs.writeFileSync(path.join(tmpDir, quotedName), '# State');
    gitOrThrow(['add', quotedName], { cwd: tmpDir });

    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(!result.success, 'a staged .planning/ file with a quote character in its name must be detected and block the commit');
    assert.ok(result.error.includes('quote.md'), result.error);
  });

  // #3588 C7 (flipped): the earlier pass's C7 test pinned a synthetic
  // top-level filename (`.planning\STATE.md`, backslash as a literal
  // character in a single path component, not a real nested directory — git
  // never uses backslash as a tree separator, on any platform) as evidence
  // that `f.startsWith('.planning\\')` was unreachable, and left the assertion
  // at "currently allowed" pending a fix. That branch is now removed as dead
  // code (git's plumbing output is always `/`-normalized, so a real Windows
  // `.planning\<file>` path never reaches this filter as a `.planning\`
  // prefix). This replaces it with the REAL analog of the same class of bug:
  // a genuine `.planning/` file whose name merely CONTAINS a literal
  // backslash character. Without `-z` that name is also C-style-quoted
  // (`".planning/back\\slash.md"`) and missed; with `-z` it is read as raw,
  // unquoted bytes and correctly detected via the plain `.planning/` prefix
  // check alone — no backslash-specific branch needed.
  test('C7 (#3588, flipped): a staged .planning/ file whose name contains a backslash character is detected and blocked', (t) => {
    // `\` is the Windows path separator, not a legal character inside a
    // single filename component — a file literally named `back\slash.md`
    // cannot be created on Windows filesystems, so the fixture itself is
    // unrepresentable there. This is not a gap in the guard's Windows
    // behavior; it is an input Windows rejects outright. Do not re-enable
    // this on win32 — see #3588.
    if (process.platform === 'win32') {
      t.skip('a `\\` filename is illegal on Windows filesystems (#3588); fixture cannot be created');
      return;
    }
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: false })
    );
    const backslashInName = '.planning/back\\slash.md';
    fs.writeFileSync(path.join(tmpDir, backslashInName), '# State');
    gitOrThrow(['add', backslashInName], { cwd: tmpDir });

    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(
      !result.success,
      'a staged .planning/ file whose name contains a backslash character must be detected and block the commit',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// commit-docs-guard: opt-in pre-commit hook (#3588)
// ─────────────────────────────────────────────────────────────────────────────

// #3901: a developer's GLOBAL core.hooksPath (~/.gitconfig) applies to every
// fresh repo — the guard correctly refuses to install a hook git would never
// run, which used to fail the guard suites' beforeEach (18 tests across the
// A/B/D suites) on machines that centralize commit hooks. Pin
// GIT_CONFIG_GLOBAL to an empty file (runGsdTools and the git helpers
// propagate process.env to every child), making the fixtures independent of
// the host's git configuration. A LOCAL repo value cannot isolate this:
// `git config --get` returns any non-empty local value (same refusal), and an
// empty local value makes rev-parse --git-path hooks resolve to `./` — not
// `.git/hooks`. Returns a restore function for the suite's after().
function isolateGlobalGitConfig() {
  const dir = createTempDir('gsd-3901-gitconfig-');
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'global.gitconfig');
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  return () => {
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev;
    cleanup(dir);
  };
}

describe('commit-docs-guard hook script (#3588 A1-A5)', () => {
  const { createTempGitProject, TEST_ENV_BASE } = require('./helpers.cjs');
  const { runHook } = require('./helpers/process-seam.cjs');
  const REPO_ROOT = path.join(__dirname, '..');
  const HOOK_MARKER = '# gsd-core:commit-docs-guard';
  let tmpDir;
  let hookPath;

  // #3901: see isolateGlobalGitConfig — shared by all three guard suites.
  const restoreGitConfig = isolateGlobalGitConfig();
  after(restoreGitConfig);

  beforeEach(() => {
    tmpDir = createTempGitProject();
    const enableResult = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(enableResult.success, `enable failed: ${enableResult.error}`);
    hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
  });

  test('#3901: the suite isolates children from the host git config (global core.hooksPath)', () => {
    // The developer-machine scenario this suite must survive: a hostile
    // ~/.gitconfig with core.hooksPath set. The before() hook pins
    // GIT_CONFIG_GLOBAL to an empty file; this pins the seam is actually
    // armed and reaching children — a child git sees NO hooksPath from the
    // host, so the guard never refuses and the 18 tests never fail. (A child
    // given an explicitly hostile GIT_CONFIG_GLOBAL still refuses — that is
    // the guard being correct, and it is covered where the refusal is
    // asserted.)
    assert.ok(
      process.env.GIT_CONFIG_GLOBAL && fs.existsSync(process.env.GIT_CONFIG_GLOBAL),
      'the isolation file is armed for this suite',
    );
    assert.equal(fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf-8'), '',
      'the isolation file is empty — children inherit no host config');
    const { spawnSync } = require('node:child_process');
    const probe = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 15_000,
    });
    assert.notEqual(probe.status, 0, `a child git must not see a host core.hooksPath; got: ${probe.stdout}`);
    assert.ok(fs.existsSync(hookPath), 'the beforeEach enable installed the hook at the repo-local default path');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('A1: hook script carries the gsd-core:commit-docs-guard marker', () => {
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.ok(content.includes(HOOK_MARKER), 'written hook must carry the marker line');
  });

  test('A2: hook script uses LF-only line endings (boundary — Windows)', () => {
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.ok(!content.includes('\r'), 'a CRLF shebang is not executable under Git Bash');
  });

  test('A3: hook file is executable after enable', () => {
    if (process.platform === 'win32') return; // exec bit is not the Windows-relevant assertion
    const mode = fs.statSync(hookPath).mode;
    assert.ok((mode & 0o111) !== 0, 'pre-commit hook must carry the executable bit');
  });

  test('A4: hook exits zero when the guard allows', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ commit_docs: true }));
    const result = runHook(hookPath, [], {
      interpreter: 'bash',
      cwd: tmpDir,
      env: { ...process.env, ...TEST_ENV_BASE, RUNTIME_DIR: REPO_ROOT },
    });
    assert.strictEqual(result.exitCode, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
  });

  test('A5: hook exits non-zero and names the staged files when the guard blocks', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ commit_docs: false }));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State');
    gitOrThrow(['add', '.planning/STATE.md'], { cwd: tmpDir });
    const result = runHook(hookPath, [], {
      interpreter: 'bash',
      cwd: tmpDir,
      env: { ...process.env, ...TEST_ENV_BASE, RUNTIME_DIR: REPO_ROOT },
    });
    assert.notStrictEqual(result.exitCode, 0, 'hook must exit non-zero when the guard blocks');
    assert.ok(result.stderr.includes('.planning/STATE.md'), result.stderr);
  });
});

describe('commit-docs-guard enable/disable (#3588 B1-B15)', () => {
  const { createTempGitProject } = require('./helpers.cjs');
  let tmpDir;

  // #3901: this suite also runs `enable` against fresh repos — the same
  // hostile-global exposure as the A suite (review finding).
  const restoreGitConfigB = isolateGlobalGitConfig();
  after(restoreGitConfigB);

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = undefined;
  });

  test('B1: enable writes an executable hook and reports success', () => {
    tmpDir = createTempGitProject();
    const result = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(result.success, result.error);
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    assert.ok(fs.existsSync(hookPath));
    if (process.platform !== 'win32') {
      assert.ok((fs.statSync(hookPath).mode & 0o111) !== 0);
    }
  });

  test('B2: enable refuses to clobber an existing foreign pre-commit hook', () => {
    tmpDir = createTempGitProject();
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const foreignContent = '#!/bin/sh\necho foreign\n';
    fs.writeFileSync(hookPath, foreignContent);
    fs.chmodSync(hookPath, 0o755);
    const result = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(!result.success, 'enable must refuse to overwrite a foreign hook');
    assert.ok(result.error.includes(hookPath), result.error);
    assert.strictEqual(fs.readFileSync(hookPath, 'utf8'), foreignContent, 'foreign hook must be byte-unchanged');
  });

  test('B3: enable twice is idempotent — no duplicated content', () => {
    tmpDir = createTempGitProject();
    const r1 = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(r1.success, r1.error);
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const first = fs.readFileSync(hookPath, 'utf8');
    const r2 = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(r2.success, r2.error);
    const second = fs.readFileSync(hookPath, 'utf8');
    assert.strictEqual(second, first, 'a second enable must not change or duplicate content');
    const markerCount = (second.match(/# gsd-core:commit-docs-guard/g) || []).length;
    assert.strictEqual(markerCount, 1, 'exactly one marker line, never duplicated');
  });

  test('B4: disable removes our hook', () => {
    tmpDir = createTempGitProject();
    const enableResult = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(enableResult.success, enableResult.error);
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    assert.ok(fs.existsSync(hookPath));
    const result = runGsdTools('commit-docs-guard disable --raw', tmpDir);
    assert.ok(result.success, result.error);
    assert.ok(!fs.existsSync(hookPath));
  });

  test('B5: disable refuses to remove a foreign hook', () => {
    tmpDir = createTempGitProject();
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const foreignContent = '#!/bin/sh\necho foreign\n';
    fs.writeFileSync(hookPath, foreignContent);
    fs.chmodSync(hookPath, 0o755);
    const result = runGsdTools('commit-docs-guard disable --raw', tmpDir);
    assert.ok(!result.success, 'disable must refuse to remove a foreign hook');
    assert.strictEqual(fs.readFileSync(hookPath, 'utf8'), foreignContent, 'foreign hook must be byte-unchanged');
  });

  test('B6: disable with no hook present is a success no-op, not an error', () => {
    tmpDir = createTempGitProject();
    const result = runGsdTools('commit-docs-guard disable --raw', tmpDir);
    assert.ok(result.success, result.error);
  });

  test('B7: enable outside a git repository fails cleanly, nothing written', () => {
    tmpDir = createTempDir();
    const before = fs.readdirSync(tmpDir);
    const result = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(!result.success, 'enable must fail outside a git repository');
    assert.deepStrictEqual(fs.readdirSync(tmpDir), before, 'nothing may be written');
  });

  test('B8: enable resolves the real hooks dir when .git is a worktree file', (t) => {
    tmpDir = createTempGitProject();
    const worktreeParent = createTempDir();
    t.after(() => cleanup(worktreeParent));

    const wtDir = path.join(worktreeParent, 'wt');
    gitOrThrow(['worktree', 'add', wtDir, '-b', 'gsd-test-commit-docs-guard-wt'], { cwd: tmpDir });
    assert.ok(fs.statSync(path.join(wtDir, '.git')).isFile(), 'precondition: .git must be a file in a linked worktree');

    const result = runGsdTools('commit-docs-guard enable --raw', wtDir);
    assert.ok(result.success, result.error);
    // Hooks are shared across worktrees in the COMMON git dir — never a
    // literal `<worktree>/.git/hooks`.
    assert.ok(!fs.existsSync(path.join(wtDir, '.git', 'hooks')), 'must never write a literal <worktree>/.git/hooks path');
    const commonHookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    assert.ok(fs.existsSync(commonHookPath), 'hook must land in the real (common) hooks directory');
  });

  test('B9: enable refuses when core.hooksPath is already set', () => {
    tmpDir = createTempGitProject();
    gitOrThrow(['config', 'core.hooksPath', 'custom-hooks'], { cwd: tmpDir });
    const result = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(!result.success, 'enable must refuse when core.hooksPath is set');
    assert.ok(result.error.includes('core.hooksPath'), result.error);
    assert.ok(!fs.existsSync(path.join(tmpDir, 'custom-hooks', 'pre-commit')), 'must not write into the hooksPath-configured dir either');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit')), 'must not write the ordinary hooks dir either');
  });

  test('B10: marker detection tolerates a user-appended line', () => {
    tmpDir = createTempGitProject();
    const r1 = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(r1.success, r1.error);
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    fs.appendFileSync(hookPath, '\n# a user comment appended after install\n');

    const r2 = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(r2.success, `enable must still recognize the edited hook as ours: ${r2.error}`);
    assert.ok(
      fs.readFileSync(hookPath, 'utf8').includes('a user comment appended after install'),
      'enable must not silently discard the user edit on a recognized hook'
    );

    const r3 = runGsdTools('commit-docs-guard disable --raw', tmpDir);
    assert.ok(r3.success, `disable must still recognize the edited hook as ours: ${r3.error}`);
    assert.ok(!fs.existsSync(hookPath));
  });

  test('B11: no subcommand at all hits the unknown-subcommand routing guard', () => {
    tmpDir = createTempGitProject();
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const result = runGsdTools(['--json-errors', 'commit-docs-guard'], tmpDir);
    assert.ok(!result.success, 'missing subcommand must not succeed');
    assert.notStrictEqual(result.exitCode, 0, 'missing subcommand must exit non-zero');
    const parsed = JSON.parse(result.error);
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['message', 'ok', 'reason']);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.reason, 'sdk_unknown_command');
    assert.strictEqual(/\n\s*at\s/.test(result.error), false, 'non-debug failure must not print a stack trace');
    assert.ok(!fs.existsSync(hookPath), 'no hook may be written for a missing subcommand');
  });

  test('B12: an unknown subcommand hits the unknown-subcommand routing guard', () => {
    tmpDir = createTempGitProject();
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const result = runGsdTools(['--json-errors', 'commit-docs-guard', 'bogus'], tmpDir);
    assert.ok(!result.success, 'an unrecognized subcommand must not succeed');
    assert.notStrictEqual(result.exitCode, 0, 'an unrecognized subcommand must exit non-zero');
    const parsed = JSON.parse(result.error);
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['message', 'ok', 'reason']);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.reason, 'sdk_unknown_command');
    assert.strictEqual(/\n\s*at\s/.test(result.error), false, 'non-debug failure must not print a stack trace');
    assert.ok(!fs.existsSync(hookPath), 'no hook may be written for an unrecognized subcommand');
  });

  test('B13: an empty-string subcommand hits the unknown-subcommand routing guard', () => {
    tmpDir = createTempGitProject();
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const result = runGsdTools(['--json-errors', 'commit-docs-guard', ''], tmpDir);
    assert.ok(!result.success, 'an empty-string subcommand must not succeed');
    assert.notStrictEqual(result.exitCode, 0, 'an empty-string subcommand must exit non-zero');
    const parsed = JSON.parse(result.error);
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['message', 'ok', 'reason']);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.reason, 'sdk_unknown_command');
    assert.strictEqual(/\n\s*at\s/.test(result.error), false, 'non-debug failure must not print a stack trace');
    assert.ok(!fs.existsSync(hookPath), 'no hook may be written for an empty-string subcommand');
  });

  test('B14: a whitespace-only subcommand hits the unknown-subcommand routing guard', () => {
    tmpDir = createTempGitProject();
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const result = runGsdTools(['--json-errors', 'commit-docs-guard', '   '], tmpDir);
    assert.ok(!result.success, 'a whitespace-only subcommand must not succeed');
    assert.notStrictEqual(result.exitCode, 0, 'a whitespace-only subcommand must exit non-zero');
    const parsed = JSON.parse(result.error);
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['message', 'ok', 'reason']);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.reason, 'sdk_unknown_command');
    assert.strictEqual(/\n\s*at\s/.test(result.error), false, 'non-debug failure must not print a stack trace');
    assert.ok(!fs.existsSync(hookPath), 'no hook may be written for a whitespace-only subcommand');
  });

  test('B15: a flag-shaped value in the subcommand position hits the unknown-subcommand routing guard', () => {
    tmpDir = createTempGitProject();
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const result = runGsdTools(['--json-errors', 'commit-docs-guard', '--enable'], tmpDir);
    assert.ok(!result.success, 'a flag-shaped subcommand must not succeed');
    assert.notStrictEqual(result.exitCode, 0, 'a flag-shaped subcommand must exit non-zero');
    const parsed = JSON.parse(result.error);
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['message', 'ok', 'reason']);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.reason, 'sdk_unknown_command');
    assert.strictEqual(/\n\s*at\s/.test(result.error), false, 'non-debug failure must not print a stack trace');
    assert.ok(!fs.existsSync(hookPath), 'no hook may be written for a flag-shaped subcommand');
  });
});

describe('commit-docs-guard real git commit wiring (#3588 D1-D3)', () => {
  const { createTempGitProject, TEST_ENV_BASE } = require('./helpers.cjs');
  const { runGit } = require('./helpers/process-seam.cjs');
  const REPO_ROOT = path.join(__dirname, '..');
  let tmpDir;

  // #3901: the D suite's premise is the hook firing from .git/hooks/pre-commit
  // — a hostile global core.hooksPath broke its beforeEach identically.
  const restoreGitConfigD = isolateGlobalGitConfig();
  after(restoreGitConfigD);

  beforeEach(() => {
    tmpDir = createTempGitProject();
    const enableResult = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(enableResult.success, `enable failed: ${enableResult.error}`);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function stagePlanningFile(name) {
    fs.writeFileSync(path.join(tmpDir, '.planning', name), '# State\n');
    gitOrThrow(['add', `.planning/${name}`], { cwd: tmpDir });
  }

  function commitEnv() {
    // RUNTIME_DIR pins the hook's gsd_run resolution (the
    // _runtime-launcher.snippet.sh preamble) to THIS checkout's own
    // gsd-core/bin/gsd-tools.cjs rather than relying on an ambient PATH
    // install or a config-dir fallback that would not exist in CI.
    return { ...process.env, ...TEST_ENV_BASE, RUNTIME_DIR: REPO_ROOT };
  }

  function commitCount() {
    return Number(gitOrThrow(['rev-list', '--count', 'HEAD'], { cwd: tmpDir }).trim());
  }

  test('D1: a real `git commit` is refused when commit_docs is false and .planning/ is staged', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ commit_docs: false }));
    stagePlanningFile('STATE.md');
    const before = commitCount();
    const result = runGit(['commit', '-m', 'chore: should be refused'], { cwd: tmpDir, env: commitEnv() });
    assert.notStrictEqual(result.exitCode, 0, `commit should have been refused; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.strictEqual(commitCount(), before, 'nothing should have been committed');
  });

  test('D2: a real `git commit` succeeds when commit_docs is true', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ commit_docs: true }));
    stagePlanningFile('STATE.md');
    const before = commitCount();
    const result = runGit(['commit', '-m', 'chore: should succeed'], { cwd: tmpDir, env: commitEnv() });
    assert.strictEqual(result.exitCode, 0, `commit should have succeeded; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.strictEqual(commitCount(), before + 1);
  });

  test('D3: disable actually unwires the hook — the same D1 scenario now succeeds', () => {
    const disableResult = runGsdTools('commit-docs-guard disable --raw', tmpDir);
    assert.ok(disableResult.success, disableResult.error);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ commit_docs: false }));
    stagePlanningFile('STATE.md');
    const before = commitCount();
    const result = runGit(['commit', '-m', 'chore: allowed after disable'], { cwd: tmpDir, env: commitEnv() });
    assert.strictEqual(result.exitCode, 0, `commit should have succeeded after disable; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.strictEqual(commitCount(), before + 1);
  });
});

describe('commit-docs-guard default install scope guarantee (#3588 E2)', () => {
  test('E2: the default install path wires nothing new — commit-docs-guard is opt-in only', () => {
    // #3588 scope guarantee (40-design.md): bin/install.js wiring is
    // explicitly OUT of scope. This is the regression lock for that
    // narrowing — checked structurally (require()'d typed exports, never
    // source-text grep) against the THREE surfaces that would make the hook
    // install by default.
    const { MANAGED_HOOKS } = require('../hooks/managed-hooks-registry.cjs');
    assert.ok(
      !MANAGED_HOOKS.some((h) => h.includes('commit-docs-guard')),
      'commit-docs-guard must not be a MANAGED_HOOKS install-time hook'
    );

    // scripts/build-hooks.js HOOKS_TO_COPY is the single source of truth for
    // both the shared hooks/dist/ bundle AND bin/install.js's
    // INSTALLED_HOOK_FILES/GSD_UNINSTALL_HOOKS (see the "new hook-script
    // registration invariants" ripple) — asserting against the exported
    // array itself, not grepping either file's source text.
    const { HOOKS_TO_COPY } = require('../scripts/build-hooks.js');
    assert.ok(
      !HOOKS_TO_COPY.includes('commit-docs-guard'),
      'commit-docs-guard must not be copied into the shared hooks bundle'
    );

    const { GSD_UNINSTALL_HOOKS } = require('../bin/install.js');
    assert.ok(
      !GSD_UNINSTALL_HOOKS.includes('commit-docs-guard'),
      'bin/install.js must not list commit-docs-guard among installed/uninstalled hook files'
    );
  });
});

describe('_wsParseRetryAfter (#308)', () => {
  const { _wsParseRetryAfter } = require('../gsd-core/bin/lib/commands.cjs');

  test('integer seconds: "120" → 60000 (capped at 60s)', () => {
    assert.strictEqual(_wsParseRetryAfter('120'), 60000);
  });

  test('leading zero: "01" → 1000', () => {
    assert.strictEqual(_wsParseRetryAfter('01'), 1000);
  });

  test('whitespace: " 5 " → 5000', () => {
    assert.strictEqual(_wsParseRetryAfter(' 5 '), 5000);
  });

  test('"0" → 0', () => {
    assert.strictEqual(_wsParseRetryAfter('0'), 0);
  });

  test('value > 60s cap: "120000" → 60000', () => {
    assert.strictEqual(_wsParseRetryAfter('120000'), 60000);
  });

  // ADR-456 §(a) reachability rule: this function is required directly
  // (in-process), so t.mock.timers reaches it without any production change —
  // it patches the global `Date` that `Date.now()` reads from regardless of
  // whether the SUT goes through realClock. Fixed, second-aligned pin so the
  // HTTP-date's whole-second precision doesn't round the expected value away.
  const PINNED_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

  test('future HTTP-date 5s ahead → exactly 5000 (deterministic)', (t) => {
    t.mock.timers.enable(['Date']);
    t.mock.timers.setTime(PINNED_MS);
    const futureDate = new Date(PINNED_MS + 5000).toUTCString();
    assert.strictEqual(_wsParseRetryAfter(futureDate), 5000);
  });

  test('past HTTP-date 5s behind → exactly 0 (deterministic)', (t) => {
    t.mock.timers.enable(['Date']);
    t.mock.timers.setTime(PINNED_MS);
    const pastDate = new Date(PINNED_MS - 5000).toUTCString();
    assert.strictEqual(_wsParseRetryAfter(pastDate), 0);
  });

  test('boundary: HTTP-date 59s ahead → 59000, not clamped', (t) => {
    t.mock.timers.enable(['Date']);
    t.mock.timers.setTime(PINNED_MS);
    const d = new Date(PINNED_MS + 59_000).toUTCString();
    assert.strictEqual(_wsParseRetryAfter(d), 59_000);
  });

  test('boundary: HTTP-date 60s ahead → 60000, at cap exactly', (t) => {
    t.mock.timers.enable(['Date']);
    t.mock.timers.setTime(PINNED_MS);
    const d = new Date(PINNED_MS + 60_000).toUTCString();
    assert.strictEqual(_wsParseRetryAfter(d), 60_000);
  });

  test('boundary: HTTP-date 61s ahead → clamped to 60000', (t) => {
    t.mock.timers.enable(['Date']);
    t.mock.timers.setTime(PINNED_MS);
    const d = new Date(PINNED_MS + 61_000).toUTCString();
    assert.strictEqual(_wsParseRetryAfter(d), 60_000);
  });

  test('"garbage" → null', () => {
    assert.strictEqual(_wsParseRetryAfter('garbage'), null);
  });

  test('"" → null', () => {
    assert.strictEqual(_wsParseRetryAfter(''), null);
  });

  test('null → null', () => {
    assert.strictEqual(_wsParseRetryAfter(null), null);
  });
});

// ─── Regressions: bug #1145 — query user-story.validate phantom command ────
//
// `query user-story.validate` was invoked by mvp-phase.md and verify-work.md
// but had no CJS handler (phantom command). Every invocation errored with
// "Unknown command: user-story — did you mean: user-story validate?".
//
// Calls the CLI via runGsdTools; no readFileSync source-grep.

describe('user-story validate command (bug #1145)', () => {
  // Helper: call `query user-story.validate --story <story>` and parse JSON.
  function validateStory(story) {
    const result = runGsdTools(['query', 'user-story.validate', '--story', story]);
    assert.equal(result.success, true, `user-story.validate exited non-zero: ${result.error || result.output}`);
    let parsed;
    try { parsed = JSON.parse(result.output); } catch {
      assert.fail(`output was not valid JSON: ${result.output}`);
    }
    return parsed;
  }

  // Helper: call with --pick valid, return trimmed output string.
  function validateStoryPickValid(story) {
    const result = runGsdTools(['query', 'user-story.validate', '--story', story, '--pick', 'valid']);
    assert.equal(result.success, true, `user-story.validate --pick valid exited non-zero: ${result.error || result.output}`);
    return result.output.trim();
  }

  test('command is reachable — not a phantom (negative proof of bug #1145)', () => {
    // Before the fix: exit 1 with "Unknown command: user-story"
    const result = runGsdTools(['query', 'user-story.validate', '--story', 'As a user, I want to log in, so that I can access my account.']);
    assert.equal(result.success, true, `Expected exit 0 but got: ${result.error || result.output}`);
  });

  test('canonical well-formed story returns { valid: true, errors: [], slots }', () => {
    const out = validateStory('As a new user, I want to register and log in, so that I can access my account.');
    assert.equal(typeof out, 'object');
    assert.equal(out.valid, true, `expected valid:true, got: ${JSON.stringify(out)}`);
    assert.ok(!out.errors || out.errors.length === 0, `unexpected errors: ${JSON.stringify(out.errors)}`);
    // Slot extraction (see verify-work.md: "returns slot extractions")
    assert.ok(out.slots && typeof out.slots === 'object', `expected slots object, got: ${JSON.stringify(out.slots)}`);
    assert.equal(out.slots.role, 'new user');
    assert.equal(out.slots.capability, 'register and log in');
    assert.equal(out.slots.outcome, 'I can access my account');
  });

  test('whitespace-only role slot returns { valid: false } (Codex finding: .+ accepted spaces)', () => {
    // "As a  ," — role is whitespace-only; must be rejected
    const out = validateStory('As a  , I want to build reports, so that I can share status.');
    assert.equal(out.valid, false, `whitespace role must be invalid: ${JSON.stringify(out)}`);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
    assert.equal(out.slots, null, 'slots must be null on invalid story');
  });

  test('whitespace-only capability slot returns { valid: false }', () => {
    // ", I want to  ," — capability is whitespace-only
    const out = validateStory('As a user, I want to  , so that I can share status.');
    assert.equal(out.valid, false, `whitespace capability must be invalid: ${JSON.stringify(out)}`);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
  });

  test('whitespace-only outcome slot returns { valid: false }', () => {
    // ", so that  ." — outcome is whitespace-only
    const out = validateStory('As a user, I want to build reports, so that  .');
    assert.equal(out.valid, false, `whitespace outcome must be invalid: ${JSON.stringify(out)}`);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
  });

  test('empty string returns { valid: false } with non-empty errors array', () => {
    const out = validateStory('');
    assert.equal(out.valid, false);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
  });

  test('story missing "As a" prefix returns { valid: false }', () => {
    const out = validateStory('I want to register so that I can log in.');
    assert.equal(out.valid, false);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
  });

  test('story missing ", I want to" clause returns { valid: false }', () => {
    const out = validateStory('As a user, so that I can log in.');
    assert.equal(out.valid, false);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
  });

  test('story missing ", so that" clause returns { valid: false }', () => {
    const out = validateStory('As a user, I want to register and log in.');
    assert.equal(out.valid, false);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
  });

  test('story missing trailing period returns { valid: false }', () => {
    const out = validateStory('As a user, I want to register, so that I can log in');
    assert.equal(out.valid, false);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
  });

  test('whitespace-only story returns { valid: false }', () => {
    const out = validateStory('   ');
    assert.equal(out.valid, false);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
  });

  test('--pick valid returns bare "true" for valid story (verify-work.md call shape)', () => {
    const out = validateStoryPickValid('As a developer, I want to run tests, so that I can catch regressions.');
    assert.equal(out, 'true', `expected bare "true" but got: ${JSON.stringify(out)}`);
  });

  test('--pick valid returns bare "false" for invalid story (verify-work.md call shape)', () => {
    const out = validateStoryPickValid('Not a user story at all.');
    assert.equal(out, 'false', `expected bare "false" but got: ${JSON.stringify(out)}`);
  });

  test('mvp-phase.md call shape: result has .valid boolean, .errors array, and .slots', () => {
    // gsd_run query user-story.validate --story "$USER_STORY"
    // mvp-phase.md uses: jq -r '.valid' and jq -r '.errors[]'
    const out = validateStory('As a product manager, I want to export reports, so that I can share progress with stakeholders.');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'valid'), 'missing "valid" field');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'errors'), 'missing "errors" field');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'slots'), 'missing "slots" field');
    assert.equal(typeof out.valid, 'boolean');
    assert.ok(Array.isArray(out.errors));
    // slots is object on success, null on failure
    assert.equal(out.valid, true);
    assert.equal(typeof out.slots, 'object');
    assert.notEqual(out.slots, null);
  });

  test('dotted-form (user-story.validate) works identically to spaced form', () => {
    // Canonical dotted invocation used by workflows
    const result = runGsdTools(['query', 'user-story.validate', '--story', 'As a user, I want to log in, so that I can see my dashboard.']);
    assert.equal(result.success, true, `dotted form failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.equal(out.valid, true);
  });

  test('boundary — minimal valid story passes', () => {
    const out = validateStory('As a X, I want to Y, so that Z.');
    assert.equal(out.valid, true, `minimal valid story should pass: ${JSON.stringify(out)}`);
  });
});

// ---------------------------------------------------------------------------
// pr-subrepo — regressions (#666) + workflow source invariants
// ---------------------------------------------------------------------------

describe('pr-subrepo', () => {
  function writePrSubrepoConfig(dir, obj) {
    const planningDir = path.join(dir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(obj, null, 2));
  }

  function initPrSubrepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    gitOrThrow(['init'], { cwd: dir });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: dir });
    gitOrThrow(['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    fs.writeFileSync(path.join(dir, 'feature.js'), '// initial\n');
    fs.writeFileSync(path.join(dir, 'a.js'), '// initial\n');
    fs.writeFileSync(path.join(dir, 'b.js'), '// initial\n');
    gitOrThrow(['add', '.gitkeep', 'feature.js', 'a.js', 'b.js'], { cwd: dir });
    gitOrThrow(['commit', '-m', 'chore: initial commit'], { cwd: dir });
  }

  function wirePrSubrepoRemote(repoDir, bareDir) {
    fs.mkdirSync(bareDir, { recursive: true });
    gitOrThrow(['init', '--bare'], { cwd: bareDir });
    gitOrThrow(['remote', 'add', 'origin', bareDir], { cwd: repoDir });
    const branch = gitOrThrow(['branch', '--show-current'], { cwd: repoDir }).trim();
    gitOrThrow(['push', 'origin', branch], { cwd: repoDir });
  }

  describe('regressions (#666 — cmdPrSubrepo seam)', () => {
    let rootDir;
    let subDir;
    let bareDir;

    beforeEach(() => {
      rootDir = createTempDir('gsd-666-root-');
      subDir  = path.join(rootDir, 'backend');
      bareDir = path.join(rootDir, '_bare-backend.git');
      writePrSubrepoConfig(rootDir, { planning: { sub_repos: ['backend'] } });
      initPrSubrepo(subDir);
      wirePrSubrepoRemote(subDir, bareDir);
    });

    afterEach(() => {
      cleanup(rootDir);
    });

    test('config-get planning.sub_repos resolves canonical config location', () => {
      const res = runGsdTools(['query', 'config-get', 'planning.sub_repos'], rootDir);
      assert.ok(res.success, `config-get planning.sub_repos failed: ${res.error}`);
      assert.deepStrictEqual(JSON.parse(res.output), ['backend']);
    });

    test('config-get sub_repos (top-level) fails — confirming bug #666 Blocker 1 is gone', () => {
      const res = runGsdTools(['query', 'config-get', 'sub_repos'], rootDir);
      assert.ok(!res.success, 'top-level sub_repos key must not resolve — fix requires planning.sub_repos');
    });

    test('pr-subrepo happy path: branch created, files staged explicitly, commit pushed', () => {
      fs.writeFileSync(path.join(subDir, 'feature.js'), 'module.exports = 42;\n');

      const res = runGsdTools(
        ['query', 'pr-subrepo', 'fix(backend): add feature',
         '--repo', 'backend', '--branch', 'fix-666-backend-pr'],
        rootDir
      );
      assert.ok(res.success, `pr-subrepo failed: ${res.error}`);

      const result = JSON.parse(res.output);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.repo, 'backend');
      assert.strictEqual(result.branch, 'fix-666-backend-pr');
      assert.strictEqual(result.committed, true);
      assert.ok(Array.isArray(result.files) && result.files.length > 0);
      assert.ok(result.files.includes('feature.js'), `feature.js missing from files: ${JSON.stringify(result.files)}`);
      assert.ok(typeof result.commit_hash === 'string' && result.commit_hash.length > 0);
    });

    test('pr-subrepo stages files explicitly — result.files lists every changed file', () => {
      fs.writeFileSync(path.join(subDir, 'a.js'), '1\n');
      fs.writeFileSync(path.join(subDir, 'b.js'), '2\n');

      const res = runGsdTools(
        ['query', 'pr-subrepo', 'fix(backend): two files',
         '--repo', 'backend', '--branch', 'fix-666-explicit-pr'],
        rootDir
      );
      assert.ok(res.success, `pr-subrepo failed: ${res.error}`);

      const result = JSON.parse(res.output);
      assert.ok(result.files.includes('a.js'), 'a.js must be staged');
      assert.ok(result.files.includes('b.js'), 'b.js must be staged');
    });

    test('pr-subrepo: nothing_to_commit when sub-repo is clean', () => {
      const res = runGsdTools(
        ['query', 'pr-subrepo', 'fix(backend): nothing',
         '--repo', 'backend', '--branch', 'fix-666-clean-pr'],
        rootDir
      );
      assert.ok(res.success, `pr-subrepo should succeed on clean repo: ${res.error}`);
      const result = JSON.parse(res.output);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.committed, false);
      assert.strictEqual(result.reason, 'nothing_to_commit');
    });

    test('pr-subrepo: duplicate branch guard — errors when branch already exists', () => {
      fs.writeFileSync(path.join(subDir, 'a.js'), '1\n');
      const first = runGsdTools(
        ['query', 'pr-subrepo', 'fix(backend): first',
         '--repo', 'backend', '--branch', 'fix-666-dup-pr'],
        rootDir
      );
      assert.ok(first.success, `first call failed: ${first.error}`);

      fs.writeFileSync(path.join(subDir, 'b.js'), '2\n');
      const second = runGsdTools(
        ['query', 'pr-subrepo', 'fix(backend): second',
         '--repo', 'backend', '--branch', 'fix-666-dup-pr'],
        rootDir
      );
      assert.ok(!second.success, 'Expected failure on duplicate branch name');
      assert.ok(second.error.includes('already exists'), `Got: ${second.error}`);
    });

    test('pr-subrepo: missing --repo returns descriptive error', () => {
      const res = runGsdTools(
        ['query', 'pr-subrepo', 'fix: msg', '--branch', 'some-branch'],
        rootDir
      );
      assert.ok(!res.success);
      assert.ok(res.error.includes('--repo required'), `Got: ${res.error}`);
    });

    test('pr-subrepo: missing --branch returns descriptive error', () => {
      const res = runGsdTools(
        ['query', 'pr-subrepo', 'fix: msg', '--repo', 'backend'],
        rootDir
      );
      assert.ok(!res.success);
      assert.ok(res.error.includes('--branch required'), `Got: ${res.error}`);
    });

    test('pr-subrepo: missing commit message returns descriptive error', () => {
      const res = runGsdTools(
        ['query', 'pr-subrepo', '--repo', 'backend', '--branch', 'some-branch'],
        rootDir
      );
      assert.ok(!res.success);
      assert.ok(res.error.includes('commit message required'), `Got: ${res.error}`);
    });

    test('pr-subrepo: non-existent repo path returns descriptive error', () => {
      const res = runGsdTools(
        ['query', 'pr-subrepo', 'fix: msg', '--repo', 'nonexistent', '--branch', 'some-branch'],
        rootDir
      );
      assert.ok(!res.success);
      assert.ok(
        res.error.includes('not found') || res.error.includes('nonexistent'),
        `Got: ${res.error}`
      );
    });

    test('pr-subrepo: path traversal (../escape) is rejected', () => {
      const res = runGsdTools(
        ['query', 'pr-subrepo', 'fix: msg', '--repo', '../escape', '--branch', 'some-branch'],
        rootDir
      );
      assert.ok(!res.success, 'Expected failure on path traversal attempt');
      assert.ok(
        res.error.includes('unsafe') || res.error.includes('escape'),
        `Got: ${res.error}`
      );
    });

    test('pr-subrepo push failure: branch+commit survive when push is rejected (no data loss)', () => {
      // Reproduce the data-loss scenario flagged in review: a rejecting remote must leave
      // the local branch+commit intact so the user can retry git push manually.
      const branch = 'fix-666-push-fail-pr';

      // Wire a bare remote with a pre-receive hook that rejects all pushes.
      const rejectingBare = path.join(rootDir, '_rejecting-bare.git');
      fs.mkdirSync(rejectingBare, { recursive: true });
      gitOrThrow(['init', '--bare'], { cwd: rejectingBare });
      const hookPath = path.join(rejectingBare, 'hooks', 'pre-receive');
      fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
      fs.chmodSync(hookPath, 0o755);

      // Point origin at the rejecting bare (overwrite the working one wired in beforeEach).
      gitOrThrow(['remote', 'set-url', 'origin', rejectingBare], { cwd: subDir });

      fs.writeFileSync(path.join(subDir, 'feature.js'), 'IMPORTANT USER WORK\n');

      const res = runGsdTools(
        ['query', 'pr-subrepo', 'fix(backend): push-fail test',
         '--repo', 'backend', '--branch', branch],
        rootDir
      );

      // Command must fail because push was rejected.
      assert.ok(!res.success, `Expected failure on rejected push, got success: ${res.output}`);

      // The local branch must still exist — work must not be lost.
      const branches = gitOrThrow(['branch', '--list', branch], { cwd: subDir });
      assert.ok(branches.trim().length > 0, `Branch ${branch} was deleted after push failure — user work lost`);

      // The commit on that branch must contain the user's changes.
      const log = gitOrThrow(['log', branch, '--oneline', '-1'], { cwd: subDir });
      assert.ok(log.trim().length > 0, `No commit on ${branch} — staged work was lost`);
    });

    test('pr-subrepo porcelain: staged rename — both old and new paths in result.files', () => {
      // git mv produces "R  old -> new" in porcelain v1; both paths must be staged.
      gitOrThrow(['mv', 'feature.js', 'renamed-feature.js'], { cwd: subDir });

      const res = runGsdTools(
        ['query', 'pr-subrepo', 'fix(backend): rename',
         '--repo', 'backend', '--branch', 'fix-666-rename-pr'],
        rootDir
      );
      assert.ok(res.success, `pr-subrepo failed: ${res.error}`);
      const result = JSON.parse(res.output);
      assert.ok(result.files.includes('feature.js'), `old path missing: ${JSON.stringify(result.files)}`);
      assert.ok(result.files.includes('renamed-feature.js'), `new path missing: ${JSON.stringify(result.files)}`);
    });

    test('pr-subrepo porcelain: non-ASCII filename (core.quotePath=false)', () => {
      // Without -c core.quotePath=false, "café.js" is C-escaped → slice(2) parse breaks.
      fs.writeFileSync(path.join(subDir, 'café.js'), '// initial\n');
      gitOrThrow(['add', 'café.js'], { cwd: subDir });
      gitOrThrow(['commit', '-m', 'chore: add café.js'], { cwd: subDir });
      fs.writeFileSync(path.join(subDir, 'café.js'), 'updated\n');

      const res = runGsdTools(
        ['query', 'pr-subrepo', 'fix(backend): non-ascii',
         '--repo', 'backend', '--branch', 'fix-666-nonascii-pr'],
        rootDir
      );
      assert.ok(res.success, `pr-subrepo failed: ${res.error}`);
      const result = JSON.parse(res.output);
      assert.ok(result.files.includes('café.js'), `non-ASCII file missing: ${JSON.stringify(result.files)}`);
    });

    test('pr-subrepo porcelain: fc property — parsed filenames are always non-empty strings', () => {
      // Local mirror of cmdPrSubrepo's porcelain line-parsing logic (commands.cts).
      // Tests the transformation contract without needing a real git repo.
      function parsePorcelainLine(line) {
        const normalized = line.trimStart();
        const file = normalized.slice(2).trim();
        const arrowIdx = file.indexOf(' -> ');
        return arrowIdx !== -1
          ? [file.slice(0, arrowIdx).trim(), file.slice(arrowIdx + 4).trim()]
          : [file];
      }

      const safeFilename = fc.stringMatching(/^[a-zA-Z0-9._-]+$/);
      const xyChar = fc.constantFrom('M', 'A', 'D', 'R', 'C', 'U');
      const normalLine = fc.tuple(xyChar, xyChar, safeFilename)
        .map(([x, y, f]) => `${x}${y} ${f}`);
      const renameLine = fc.tuple(xyChar, safeFilename, safeFilename)
        .map(([x, o, n]) => `${x}  ${o} -> ${n}`);
      // First-line trim edge case: leading space stripped by execGit global trim
      const trimmedLine = fc.tuple(xyChar, safeFilename)
        .map(([y, f]) => ` ${y} ${f}`);

      fc.assert(fc.property(
        fc.oneof(normalLine, renameLine, trimmedLine),
        (line) => {
          const files = parsePorcelainLine(line);
          return files.length > 0 && files.every(f => typeof f === 'string' && f.length > 0);
        }
      ));
    });
  });

  describe('workflow source invariants (#666 — pr-branch.md)', () => {
    // allow-test-rule: source-text-is-the-product see #666
    // pr-branch.md is a workflow file whose deployed text IS the runtime contract.
    const workflowPath = path.resolve(__dirname, '..', 'gsd-core', 'workflows', 'pr-branch.md');
    let wfContent;

    test('setup', () => {
      wfContent = fs.readFileSync(workflowPath, 'utf-8');
      assert.ok(wfContent.length > 0);
    });

    test('uses planning.sub_repos (canonical key) — not legacy top-level sub_repos', () => {
      wfContent = wfContent || fs.readFileSync(workflowPath, 'utf-8');
      assert.ok(wfContent.includes('planning.sub_repos'), 'must call config-get planning.sub_repos');
      assert.ok(
        !/config-get sub_repos(?!\.)/.test(wfContent),
        'must not call config-get sub_repos without the planning. prefix'
      );
    });

    test('delegates git work to gsd_run query pr-subrepo — no inline git add -A in code', () => {
      wfContent = wfContent || fs.readFileSync(workflowPath, 'utf-8');
      assert.ok(wfContent.includes('pr-subrepo'), 'must invoke the pr-subrepo seam');
      const hasForbiddenGitAdd = /^\s*git(?:\s+-C\s+\S+)?\s+add\s+(?:-A|\.)\b/m.test(wfContent);
      assert.ok(!hasForbiddenGitAdd, 'must not use git add -A or git add . as a shell command');
    });

    test('persists dirty-repo list without bash arrays (temp file or inline string)', () => {
      wfContent = wfContent || fs.readFileSync(workflowPath, 'utf-8');
      assert.ok(
        !wfContent.includes('DIRTY_REPOS=()') && !wfContent.includes('DIRTY_REPOS+='),
        'bash arrays must not be used — they do not survive across command blocks'
      );
    });

    test('branch name includes repo-specific slug to avoid root PR_BRANCH collision', () => {
      wfContent = wfContent || fs.readFileSync(workflowPath, 'utf-8');
      assert.ok(
        /REPO_SAFE|SUB_BRANCH.*REPO/.test(wfContent),
        'sub-repo branch name must embed a repo-specific component'
      );
    });

    test('handle_sub_repos positioned before analyze_commits', () => {
      wfContent = wfContent || fs.readFileSync(workflowPath, 'utf-8');
      const a = wfContent.indexOf('handle_sub_repos');
      const b = wfContent.indexOf('analyze_commits');
      assert.ok(a !== -1 && b !== -1 && a < b);
    });

    test('dirty-scan rejects traversal, newline, and symlink entries before invoking git (security)', () => {
      // Extracts and executes the ACTUAL node -e script shipped in pr-branch.md — not a
      // mirror — so this test fails if the real script regresses, not just a copy of it.
      wfContent = wfContent || fs.readFileSync(workflowPath, 'utf-8');
      const match = wfContent.match(/node -e "([\s\S]*?)"\s+"\$SUB_REPOS_JSON" "\$ROOT" "\$DIRTY_FILE"/);
      assert.ok(match, 'could not extract dirty-scan node script from pr-branch.md');
      const script = match[1];

      // Helper: init a git repo with a TRACKED dirty change. An untracked file would be
      // filtered by the ?? exclusion and the repo would look clean even without the guard,
      // making the assertions vacuous. A tracked modification ensures that WITHOUT the
      // guard the repo WOULD be reported dirty, so the test genuinely fails-first.
      const initDirtyRepo = (dir, file) => {
        gitOrThrow(['init'], { cwd: dir });
        gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: dir });
        gitOrThrow(['config', 'user.name', 'Test'], { cwd: dir });
        fs.writeFileSync(path.join(dir, file), 'committed\n');
        gitOrThrow(['add', file], { cwd: dir });
        gitOrThrow(['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], { cwd: dir });
        fs.writeFileSync(path.join(dir, file), 'modified\n');
      };

      const scanRoot = createTempDir('gsd-666-scan-root-');
      const outsideDir = createTempDir('gsd-666-scan-outside-');
      initDirtyRepo(outsideDir, 'secret.txt');

      // Positive control: a legit dirty sub-repo INSIDE the workspace must still be reported,
      // so the test can't pass by a guard that simply rejects everything.
      const backendDir = path.join(scanRoot, 'backend');
      fs.mkdirSync(backendDir, { recursive: true });
      initDirtyRepo(backendDir, 'app.js');

      // Symlink escape: an in-tree name with no ".." and no "/" that points outside root.
      // path.resolve would keep it "inside"; only realpathSync catches it. Symlink
      // creation needs privileges on Windows — skip just this vector if it throws.
      let symlinked = true;
      try { fs.symlinkSync(outsideDir, path.join(scanRoot, 'evil')); } catch { symlinked = false; }

      const traversalEntry = path.relative(scanRoot, outsideDir); // e.g. "../gsd-666-scan-outside-XXXX"
      const newlineEntry = 'good\nbad'; // record-separator injection attempt
      const dirtyFile = path.join(scanRoot, '_dirty');
      const entries = symlinked
        ? ['evil', traversalEntry, newlineEntry, 'backend']
        : [traversalEntry, newlineEntry, 'backend'];
      const subReposJson = JSON.stringify(entries);

      try {
        const scanResult = runNode(['-e', script, subReposJson, scanRoot, dirtyFile]);
        throwIfFailed(scanResult, 'node -e <dirty-scan script from pr-branch.md>');
        const dirty = fs.existsSync(dirtyFile) ? fs.readFileSync(dirtyFile, 'utf-8') : '';
        const lines = dirty.split('\n').filter(Boolean);
        assert.ok(
          !dirty.includes(path.basename(outsideDir)),
          `Path traversal reached git outside the workspace: ${JSON.stringify(dirty)}`
        );
        if (symlinked) {
          assert.ok(
            !lines.includes('evil'),
            `Symlink entry reached git outside the workspace: ${JSON.stringify(dirty)}`
          );
        }
        assert.ok(
          !lines.includes('bad'),
          `Embedded-newline entry injected a spurious record: ${JSON.stringify(dirty)}`
        );
        assert.deepStrictEqual(
          lines, ['backend'],
          `Positive control failed — expected only 'backend', got: ${JSON.stringify(lines)}`
        );
      } finally {
        cleanup(scanRoot);
        cleanup(outsideDir);
      }
    });
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-1754-cli-skew-detection.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-1754-cli-skew-detection (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * feat-1754-cli-skew-detection.test.cjs
 *
 * Tests for the CLI version-skew detection module (src/cli-skew-check.cts).
 *
 * The check warns (returns a string) when the running gsd-tools.cjs is NOT the
 * project-local install while a project-local install EXISTS — the shadowing
 * scenario from #1748 (a stale global canary from @gsd-build/sdk shadowing
 * project-local 1.6.0).
 *
 * DEFECT class: environment / version skew (enhancement #1754)
 *
 * The function is PURE (no I/O — the caller provides paths + existence flags),
 * making it trivially testable without filesystem setup.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { checkCliSkew } = require('../gsd-core/bin/lib/cli-skew-check.cjs');

describe('#1754: checkCliSkew — pure path-comparison skew detection', () => {
  test('SKEW: resolved CLI outside project root + project-local exists → returns warning', () => {
    const warning = checkCliSkew({
      resolvedPath: '/opt/homebrew/bin/gsd-tools',
      projectRoot: '/home/user/my-project',
      projectLocalExists: true,
    });
    assert.ok(warning, 'Expected a warning string when resolved CLI is outside project root and project-local exists');
    assert.ok(warning.includes('shadow') || warning.includes('outside') || warning.includes('may'),
      `Warning should mention the shadowing/outside nature, got: "${warning}"`);
  });

  test('NO-SKEW: resolved CLI is the project-local install → returns null', () => {
    const warning = checkCliSkew({
      resolvedPath: '/home/user/my-project/.claude/gsd-core/bin/gsd-tools.cjs',
      projectRoot: '/home/user/my-project',
      projectLocalExists: true,
    });
    assert.strictEqual(warning, null, 'No warning expected when resolved CLI IS the project-local install');
  });

  test('NO-SKEW: resolved CLI outside project root but NO project-local install → returns null', () => {
    const warning = checkCliSkew({
      resolvedPath: '/usr/local/bin/gsd-tools',
      projectRoot: '/home/user/my-project',
      projectLocalExists: false,
    });
    assert.strictEqual(warning, null, 'No warning expected when no project-local install exists (legitimate global-only)');
  });

  test('NO-SKEW: projectRoot is null (no project context) → returns null', () => {
    const warning = checkCliSkew({
      resolvedPath: '/usr/local/bin/gsd-tools',
      projectRoot: null,
      projectLocalExists: false,
    });
    assert.strictEqual(warning, null, 'No warning expected when there is no project root');
  });

  test('LEGACY-SDK: resolved path contains @gsd-build → warning includes removal instructions', () => {
    const warning = checkCliSkew({
      resolvedPath: '/opt/homebrew/lib/node_modules/@gsd-build/sdk/bin/gsd-tools',
      projectRoot: '/home/user/my-project',
      projectLocalExists: true,
    });
    assert.ok(warning, 'Expected a warning for @gsd-build/sdk paths');
    assert.ok(warning.includes('@gsd-build/sdk') || warning.includes('npm uninstall'),
      `Warning should include @gsd-build/sdk removal instructions, got: "${warning}"`);
  });

  test('PATH-NORMALIZATION: resolved under project root via realpath → no false positive', () => {
    // Even if the resolved path differs in symlink resolution, if it's under the
    // project root, it's not a skew. The caller normalizes paths before calling.
    const warning = checkCliSkew({
      resolvedPath: path.resolve('/home/user/my-project/.claude/gsd-core/bin/gsd-tools.cjs'),
      projectRoot: path.resolve('/home/user/my-project'),
      projectLocalExists: true,
    });
    assert.strictEqual(warning, null, 'No warning when resolved path is under project root (even with realpath normalization)');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3251-command-aliases-manifest-coverage.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3251-command-aliases-manifest-coverage (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * Regression guard for issue #3251:
 * 14 commands used in workflows must be present in command-aliases.cjs.
 *
 * Asserts structurally by requiring the manifest and checking each canonical
 * command appears in either the family arrays or the non-family array.
 * Never greps the source file — see feedback_no_source_grep_tests.md.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const COMMAND_ALIASES_FILE = path.join(
  REPO_ROOT,
  'gsd-core',
  'bin',
  'lib',
  'command-aliases.cjs',
);
const GSD_TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

const MISSING_14 = [
  'check.decision-coverage-plan',
  'check.decision-coverage-verify',
  'frontmatter.get',
  'frontmatter.set',
  'learnings.copy',
  'milestone.complete',
  'phase.mvp-mode',
  'progress.bar',
  'requirements.mark-complete',
  'stats.json',
  'task.is-behavior-adding',
  'todo.match-phase',
  'uat.render-checkpoint',
  'workstream.list',
];

describe('feat-3251: command-aliases.cjs manifest coverage', () => {
  let manifest;

  test('manifest file can be required without error', () => {
    try {
      manifest = require(COMMAND_ALIASES_FILE);
    } catch (err) {
      assert.fail(`Failed to require manifest: ${err.message}`);
    }
    assert.ok(manifest, 'manifest should be truthy');
  });

  test('manifest exports NON_FAMILY_COMMAND_ALIASES array', () => {
    manifest = manifest ?? require(COMMAND_ALIASES_FILE);
    assert.ok(
      Array.isArray(manifest.NON_FAMILY_COMMAND_ALIASES),
      'NON_FAMILY_COMMAND_ALIASES must be an exported array in command-aliases.cjs',
    );
  });

  test('all 14 missing commands are present in the manifest (family or non-family)', () => {
    manifest = manifest ?? require(COMMAND_ALIASES_FILE);

    const allCanonicalsInManifest = new Set();

    // Collect from all family arrays
    const familyArrayKeys = [
      'STATE_COMMAND_ALIASES',
      'VERIFY_COMMAND_ALIASES',
      'INIT_COMMAND_ALIASES',
      'PHASE_COMMAND_ALIASES',
      'PHASES_COMMAND_ALIASES',
      'VALIDATE_COMMAND_ALIASES',
      'ROADMAP_COMMAND_ALIASES',
      'EVAL_COMMAND_ALIASES',
    ];
    for (const key of familyArrayKeys) {
      const arr = manifest[key];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (entry && entry.canonical) allCanonicalsInManifest.add(entry.canonical);
      }
    }

    // Collect from non-family array
    const nonFamily = manifest.NON_FAMILY_COMMAND_ALIASES;
    if (Array.isArray(nonFamily)) {
      for (const entry of nonFamily) {
        if (entry && entry.canonical) allCanonicalsInManifest.add(entry.canonical);
      }
    }

    const missing = MISSING_14.filter((cmd) => !allCanonicalsInManifest.has(cmd));
    assert.deepStrictEqual(
      missing,
      [],
      `${missing.length} command(s) still missing from manifest: ${missing.join(', ')}`,
    );
  });

  test('each non-family entry has required fields: canonical, aliases, mutation', () => {
    manifest = manifest ?? require(COMMAND_ALIASES_FILE);
    const nonFamily = manifest.NON_FAMILY_COMMAND_ALIASES;
    if (!Array.isArray(nonFamily)) return; // caught by earlier test

    for (const entry of nonFamily) {
      assert.ok(typeof entry.canonical === 'string' && entry.canonical.length > 0,
        `entry missing canonical: ${JSON.stringify(entry)}`);
      assert.ok(Array.isArray(entry.aliases),
        `entry missing aliases array for canonical=${entry.canonical}`);
      assert.ok(typeof entry.mutation === 'boolean',
        `entry missing mutation boolean for canonical=${entry.canonical}`);
    }
  });

  test('NON_FAMILY_COMMAND_ALIASES is sorted by canonical (deterministic output)', () => {
    manifest = manifest ?? require(COMMAND_ALIASES_FILE);
    const nonFamily = manifest.NON_FAMILY_COMMAND_ALIASES;
    if (!Array.isArray(nonFamily)) return; // caught by earlier test

    const canonicals = nonFamily.map((e) => e.canonical);
    const sorted = [...canonicals].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(
      canonicals,
      sorted,
      'NON_FAMILY_COMMAND_ALIASES must be sorted by canonical for deterministic regeneration',
    );
  });
});

function createProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3251-dispatch-'));
  fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
  return dir;
}

function runGsdTools(args, projectDir) {
  return spawnSync(process.execPath, [GSD_TOOLS, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
  });
}

function snapshotProjectState(projectDir) {
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(projectDir, full);
      if (entry.isDirectory()) walk(full);
      else {
        files.push({
          path: rel,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
        });
      }
    }
  }
  walk(projectDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

describe('feat-3251: generated aliases dispatch through real gsd-tools behavior', () => {
  test('phase.mvp-mode spaced alias resolves CLI flag precedence', () => {
    const projectDir = createProject();
    try {
      const result = runGsdTools(['phase', 'mvp-mode', '1', '--cli-flag'], projectDir);
      assert.equal(result.status, 0, result.stderr);

      const output = JSON.parse(result.stdout);
      assert.deepEqual(output, {
        active: true,
        source: 'cli_flag',
        roadmap_mode: null,
        config_mvp_mode: false,
        cli_flag_present: true,
      });
    } finally {
      cleanup(projectDir);
    }
  });

  test('phase.mvp-mode spaced alias resolves ROADMAP mode without mutating files', () => {
    const projectDir = createProject();
    try {
      fs.writeFileSync(
        path.join(projectDir, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0.0',
          '',
          '### Phase 1: User Auth',
          '**Goal:** Users can sign in.',
          '**Mode:** mvp',
          '',
        ].join('\n'),
      );
      const beforeFiles = snapshotProjectState(projectDir);

      const result = runGsdTools(['phase', 'mvp-mode', '1'], projectDir);
      assert.equal(result.status, 0, result.stderr);

      const output = JSON.parse(result.stdout);
      assert.equal(output.active, true);
      assert.equal(output.source, 'roadmap');
      assert.equal(output.roadmap_mode, 'mvp');
      assert.equal(output.config_mvp_mode, false);
      assert.equal(output.cli_flag_present, false);
      assert.deepEqual(snapshotProjectState(projectDir), beforeFiles);
    } finally {
      cleanup(projectDir);
    }
  });

  test('phase.mvp-mode ROADMAP lookup stops before custom-id next phase', () => {
    const projectDir = createProject();
    try {
      fs.writeFileSync(
        path.join(projectDir, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0.0',
          '',
          '### Phase 1: Numeric Phase',
          '**Goal:** Users can sign in.',
          '',
          '### Phase custom-alpha: Custom Phase',
          '**Goal:** Custom work.',
          '**Mode:** mvp',
          '',
        ].join('\n'),
      );
      const beforeFiles = snapshotProjectState(projectDir);

      const result = runGsdTools(['phase', 'mvp-mode', '1'], projectDir);
      assert.equal(result.status, 0, result.stderr);

      const output = JSON.parse(result.stdout);
      assert.equal(output.active, false);
      assert.equal(output.source, 'none');
      assert.equal(output.roadmap_mode, null);
      assert.deepEqual(snapshotProjectState(projectDir), beforeFiles);
    } finally {
      cleanup(projectDir);
    }
  });

  test('phase.mvp-mode JSON error is typed and leaves project files untouched', () => {
    const projectDir = createProject();
    try {
      const beforeFiles = snapshotProjectState(projectDir);
      const result = runGsdTools(['--json-errors', 'phase', 'mvp-mode'], projectDir);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');

      const error = JSON.parse(result.stderr);
      assert.deepEqual(Object.keys(error).sort(), ['message', 'ok', 'reason']);
      assert.equal(error.ok, false);
      assert.equal(error.reason, 'usage');
      assert.equal(typeof error.message, 'string');
      assert.equal(/\n\s*at\s/.test(result.stderr), false, 'non-debug failure must not print a stack trace');
      assert.deepEqual(snapshotProjectState(projectDir), beforeFiles);
    } finally {
      cleanup(projectDir);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-488-effort-sync.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-488-effort-sync (consolidation epic #1969 B3 #1972)", () => {
// Tests for gsd-tools effort sync command (#488)
// Verifies that effort frontmatter in installed agent files can be re-synced
// when effort config changes after initial install.
// allow-test-rule: structural-regression-guard — readFileSync asserts on installed agent .md files (the product under mutation) to verify dry-run safety and apply correctness; stderr.includes guards the CLI argument-rejection contract. (see #488)

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup, captureFdSync } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');

const GSD_TOOLS = path.resolve(__dirname, '../gsd-core/bin/gsd-tools.cjs');

// This is a DISTINCT, independently-scoped `runCli` — not the file's other
// local helper of a similar shape (`runGsdTools` above, folded from
// feat-3251, which already carries its own `timeout: 30000`). This one
// returns the legacy `{status, stdout, stderr}` shape its callers below read
// directly (never a throw contract), so it is bounded via `runNode` +
// `toLegacyResult` rather than `gitOrThrow`/`throwIfFailed`.
function runCli(args, env = {}) {
  const result = runNode([GSD_TOOLS, ...args], {
    env: { ...process.env, GSD_TEST_MODE: '1', ...env },
  });
  return toLegacyResult(result);
}

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// output() in core.cjs uses fs.writeSync(1, data) — intercept fd=1 writes.
// Pass raw=false so output() emits JSON (raw=true emits the plain rawValue string).
function captureOutput(fn) {
  return JSON.parse(captureFdSync(1, fn));
}

function makeAgentsDir(tmpDir) {
  const agentsDir = path.join(tmpDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  return agentsDir;
}

function writePlanningConfig(tmpDir, effortConfig) {
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ effort: effortConfig }));
}

const AGENT_WITH_EFFORT = `---
name: gsd-planner
description: Plans phases for GSD milestones
effort: medium
---
Body of the agent.
`;

const AGENT_WITHOUT_EFFORT = `---
name: gsd-executor
description: Executes GSD phase plans
---
Body of the agent.
`;

describe('#3533 effort sync: inherit means the key must not exist', () => {
  test('10d: sync does not re-add a hand-stripped key when inherit is configured', () => {
    const tmpDir = makeTmpDir('effort-sync-inherit-absent-');
    const agentsDir = makeAgentsDir(tmpDir);
    fs.writeFileSync(path.join(agentsDir, 'gsd-executor.md'), AGENT_WITHOUT_EFFORT);
    // Tier standard -> inherit.
    writePlanningConfig(tmpDir, { routing_tier_defaults: { light: 'high', standard: 'inherit', heavy: 'xhigh' } });

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.synced, 0, `absent key + inherit is IN SYNC, not drift: ${JSON.stringify(result.changes)}`);
    assert.equal(result.changes.length, 0, 'no change may be reported for an absent key under inherit');
    const after = fs.readFileSync(path.join(agentsDir, 'gsd-executor.md'), 'utf8');
    assert.ok(!/^effort:/m.test(after), 'the effort: key must NOT be re-added');

    cleanup(tmpDir);
  });

  test('10d: sync strips the key when inherit is configured and a value is present', () => {
    const tmpDir = makeTmpDir('effort-sync-inherit-strip-');
    const agentsDir = makeAgentsDir(tmpDir);
    // Fixture carries its own name so the survivor assertion below is
    // satisfiable (AGENT_WITH_EFFORT names gsd-planner — wrong file).
    fs.writeFileSync(path.join(agentsDir, 'gsd-executor.md'), AGENT_WITH_EFFORT.replace('name: gsd-planner', 'name: gsd-executor'));
    // #3531+#3533 combined: pin every TIER to inherit — a bare effort.default
    // no longer reaches a tiered agent now that the config block merges over
    // the built-in tier ladder (the manifest standard tier would answer 'high').
    writePlanningConfig(tmpDir, { routing_tier_defaults: { light: 'inherit', standard: 'inherit', heavy: 'inherit' } });

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.synced, 1);
    assert.equal(result.changes[0].agent, 'gsd-executor');
    assert.equal(result.changes[0].from, 'medium');
    assert.equal(result.changes[0].to, null, 'to: null is the typed IR for omission');
    const after = fs.readFileSync(path.join(agentsDir, 'gsd-executor.md'), 'utf8');
    assert.ok(!/^effort:/m.test(after), 'the effort: line must be stripped');
    assert.ok(after.includes('name: gsd-executor'), 'every other frontmatter line survives');
    assert.ok(after.includes('Body of the agent.'), 'the body survives');

    cleanup(tmpDir);
  });

  test('10d: strip preserves CRLF files and leaves comments and sibling keys intact', () => {
    const tmpDir = makeTmpDir('effort-sync-inherit-crlf-');
    const agentsDir = makeAgentsDir(tmpDir);
    const crlfAgent = [
      '---',
      'name: gsd-executor',
      '# a hand comment that must survive',
      'effort: high',
      'description: Executes GSD phase plans',
      '---',
      'Body.',
      '',
    ].join('\r\n');
    const agentPath = path.join(agentsDir, 'gsd-executor.md');
    fs.writeFileSync(agentPath, crlfAgent);
    writePlanningConfig(tmpDir, { agent_overrides: { 'gsd-executor': 'inherit' } });

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.synced, 1, `expected one strip: ${JSON.stringify(result.changes)}`);
    const after = fs.readFileSync(agentPath, 'utf8');
    assert.ok(!/^effort:/m.test(after), 'effort line gone');
    assert.ok(after.includes('\r\n'), 'CRLF endings preserved');
    assert.ok(after.includes('# a hand comment that must survive'), 'comment preserved');
    assert.ok(/^description: Executes GSD phase plans\r?$/m.test(after), 'sibling key preserved');

    cleanup(tmpDir);
  });
});

describe('feat-488: effort sync command', () => {
  test('dry-run mode reports pending changes without writing files', () => {
    const tmpDir = makeTmpDir('effort-sync-dry-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-planner.md');
    fs.writeFileSync(agentPath, AGENT_WITH_EFFORT);
    writePlanningConfig(tmpDir, { default: 'high', agent_overrides: { 'gsd-planner': 'xhigh' } });

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: true, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.dry_run, true);
    assert.equal(result.synced, 1, 'should report 1 pending change');
    assert.equal(result.changes[0].agent, 'gsd-planner');
    assert.equal(result.changes[0].from, 'medium');
    assert.equal(result.changes[0].to, 'xhigh');

    // dry-run must not modify the file
    assert.ok(fs.readFileSync(agentPath, 'utf8').includes('effort: medium'), 'dry-run must not write file');

    cleanup(tmpDir);
  });

  test('--apply mode rewrites effort: frontmatter to new config value', () => {
    const tmpDir = makeTmpDir('effort-sync-apply-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-planner.md');
    fs.writeFileSync(agentPath, AGENT_WITH_EFFORT);
    writePlanningConfig(tmpDir, { default: 'low', agent_overrides: { 'gsd-planner': 'xhigh' } });

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.dry_run, false);
    assert.equal(result.synced, 1);

    const updated = fs.readFileSync(agentPath, 'utf8');
    assert.ok(updated.includes('effort: xhigh'), 'file must be updated to xhigh');
    assert.ok(!updated.includes('effort: medium'), 'old effort value must be gone');

    cleanup(tmpDir);
  });

  test('skips agents where effort: already matches config', () => {
    const tmpDir = makeTmpDir('effort-sync-noop-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-planner.md');
    // Already has the correct value
    fs.writeFileSync(agentPath, AGENT_WITH_EFFORT.replace('effort: medium', 'effort: xhigh'));
    writePlanningConfig(tmpDir, { agent_overrides: { 'gsd-planner': 'xhigh' } });

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.synced, 0, 'nothing to sync when already matching');
    assert.equal(result.skipped, 1);

    cleanup(tmpDir);
  });

  test('injects effort: into agent files that lack the frontmatter key', () => {
    const tmpDir = makeTmpDir('effort-sync-inject-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-executor.md');
    fs.writeFileSync(agentPath, AGENT_WITHOUT_EFFORT);
    // #3531: pin every tier so the injected value is tier-independent — an
    // effort.default alone no longer answers for a tiered agent now that the
    // config block merges over the built-in tier ladder.
    writePlanningConfig(tmpDir, { routing_tier_defaults: { light: 'max', standard: 'max', heavy: 'max' }, default: 'max' });

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.synced, 1, 'should inject effort into agent missing the key');
    assert.equal(result.changes[0].from, null);
    assert.equal(result.changes[0].to, 'max');
    assert.ok(fs.readFileSync(agentPath, 'utf8').includes('effort: max'), 'effort must be injected');

    cleanup(tmpDir);
  });

  test('non-claude runtime exits cleanly with informative reason field', () => {
    const tmpDir = makeTmpDir('effort-sync-gemini-');

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: true, runtime: 'gemini' })
    );

    assert.ok(result.reason, 'should include a reason message for unsupported runtime');
    assert.equal(result.synced, 0);

    cleanup(tmpDir);
  });

  test('home-default effort config gap: applies home-level effort when project config has no effort section', () => {
    // The key #488 scenario: user changed ~/.gsd/defaults.json effort settings
    // after install, but the project .planning/config.json has no effort section.
    // cmdEffortSync must pick up the home config (via readGsdEffectiveEffortConfig),
    // not fall back to 'high' (which loadConfig would return).
    //
    // readGsdEffectiveEffortConfig calls os.homedir() directly, and os.homedir()
    // is live (respects process.env.HOME).  We redirect HOME to an isolated
    // tmpHome so the test is hermetic and can assert the real outcome.
    const tmpHome = makeTmpDir('effort-sync-homecfg-');
    const tmpDir = makeTmpDir('effort-sync-project-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-planner.md');
    fs.writeFileSync(agentPath, AGENT_WITH_EFFORT); // current: effort: medium

    // Project has .planning/config.json with NO effort section
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ model_profile: 'balanced' }));

    // Home defaults set the heavy tier effort to low. (#3531: a bare home
    // effort.default would no longer reach gsd-planner — the merged tier
    // ladder answers for tiered agents — so the home fixture pins the tier,
    // which is what this test's claim actually exercises: home-level effort
    // applies when the project config has no effort section.)
    const gsdDir = path.join(tmpHome, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({ effort: { routing_tier_defaults: { heavy: 'low' } } }));

    // Isolate HOME (and USERPROFILE for Windows parity) so
    // readGsdEffectiveEffortConfig reads our fixture, not the
    // developer's real ~/.gsd/defaults.json.
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    let result;
    try {
      result = captureOutput(() =>
        cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
      );
    } finally {
      if (origHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = origHome;
      }
      if (origUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = origUserProfile;
      }
    }

    // With home heavy-tier effort 'low' and the agent currently at 'medium',
    // cmdEffortSync must sync exactly 1 agent and set it to 'low'.
    assert.equal(result.synced, 1, 'should sync 1 agent whose effort differs from home default');
    assert.equal(result.changes[0].agent, 'gsd-planner');
    assert.equal(result.changes[0].from, 'medium');
    assert.equal(result.changes[0].to, 'low', 'effort must be updated to the home-default value');
    assert.ok(
      fs.readFileSync(agentPath, 'utf8').includes('effort: low'),
      'agent file must be rewritten with the home-default effort value'
    );

    cleanup(tmpHome);
    cleanup(tmpDir);
  });

  test('CLI dispatcher: positional args after effort sync are rejected', () => {
    const result = runCli(['effort', 'sync', 'unexpected-arg']);
    assert.notEqual(result.status, 0, 'should exit non-zero on unexpected positional arg');
    assert.ok(
      result.stderr.includes('positional') || result.stderr.includes('unexpected-arg'),
      `stderr should mention the bad arg; got: ${result.stderr}`
    );
  });

  test('CLI dispatcher: effort sync --apply routes through gsd-tools correctly', () => {
    const tmpDir = makeTmpDir('effort-sync-cli-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-planner.md');
    fs.writeFileSync(agentPath, AGENT_WITH_EFFORT);
    writePlanningConfig(tmpDir, { agent_overrides: { 'gsd-planner': 'xhigh' } });

    const result = runCli(
      ['--cwd', tmpDir, 'effort', 'sync', '--apply', '--config-dir', tmpDir],
    );

    assert.equal(result.status, 0, `CLI exited non-zero: ${result.stderr}`);
    // gsd-tools may print a startup banner before the JSON payload — parse from the first `{`.
    const jsonStart = result.stdout.indexOf('{');
    const output = JSON.parse(result.stdout.slice(jsonStart));
    assert.equal(output.synced, 1);
    assert.ok(
      fs.readFileSync(agentPath, 'utf8').includes('effort: xhigh'),
      'CLI --apply must write the updated effort value'
    );

    cleanup(tmpDir);
  });
});

// ────────────────────────────────────────────────────────────────────────
// #3243 (ADR-2313 D7) — the Codex `.toml` branch of `cmdEffortSync`.
// Spec: .gsd/phase/feat-3243-codex-toml-sync/{40-design,50-test-matrix}.md
// Row numbers below (# B<N>) map 1:1 to 50-test-matrix.md's "B — the sync"
// table. B1/B2 (the claude/opencode rows) are the EXISTING tests directly
// above this block ('feat-488: effort sync command' + the non-claude-runtime
// test) and are asserted UNCHANGED — this describe adds only new coverage.
//
// Every `.toml` fixture below is hand-authored against the real
// `generateCodexAgentToml` shape (CONTRIBUTING's fixture-provenance rule,
// #2371), not produced by calling that writer.
// ────────────────────────────────────────────────────────────────────────
describe('#3243 (ADR-2313 D7): Codex .toml effort sync', () => {
  const { PARSE_REASON } = require('../gsd-core/bin/lib/codex-agent-toml.cjs');
  const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'adversarial', 'toml');

  function writeCodexAgentToml(agentsDir, agentName, content) {
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, `${agentName}.toml`), content);
  }

  function syncCodex(tmpDir, dryRun) {
    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    return captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun, configDir: tmpDir, runtime: 'codex' })
    );
  }

  test('B3: model = "sonnet" — the model line stripped; one structured change', () => {
    const tmpDir = makeTmpDir('codex-sync-b3-');
    const agentsDir = makeAgentsDir(tmpDir);
    writeCodexAgentToml(
      agentsDir,
      'gsd-planner',
      'name = "gsd-planner"\nmodel = "sonnet"\ndeveloper_instructions = \'\'\'\nPlan.\n\'\'\'\n',
    );

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].agent, 'gsd-planner');
    assert.equal(result.changes[0].field, 'model');
    assert.equal(result.changes[0].from, 'sonnet');
    assert.equal(result.changes[0].to, null);
    const updated = fs.readFileSync(path.join(agentsDir, 'gsd-planner.toml'), 'utf8');
    assert.ok(!updated.includes('model = "sonnet"'), 'the stale model line must be gone');
    assert.ok(updated.includes('name = "gsd-planner"'), 'other lines must survive');

    cleanup(tmpDir);
  });

  test('B4 (negative proof): model = "gpt-5.6-sol" (legal pin) — untouched, reported skipped not synced', () => {
    const tmpDir = makeTmpDir('codex-sync-b4-');
    const agentsDir = makeAgentsDir(tmpDir);
    const content = 'name = "gsd-gpt-agent"\nmodel = "gpt-5.6-sol"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n';
    writeCodexAgentToml(agentsDir, 'gsd-gpt-agent', content);

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 0, 'a legal pin must never be reported synced');
    assert.equal(result.skipped, 1);
    assert.equal(result.changes.length, 0);
    assert.equal(fs.readFileSync(path.join(agentsDir, 'gsd-gpt-agent.toml'), 'utf8'), content);

    cleanup(tmpDir);
  });

  test('B5 (negative proof): legal pin plus its coupled effort — both untouched', () => {
    const tmpDir = makeTmpDir('codex-sync-b5-');
    const agentsDir = makeAgentsDir(tmpDir);
    const content = 'name = "gsd-pinned-agent"\nmodel = "gpt-5-codex"\nmodel_reasoning_effort = "high"\n' +
      "developer_instructions = '''\nWork.\n'''\n";
    writeCodexAgentToml(agentsDir, 'gsd-pinned-agent', content);

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 0);
    assert.equal(result.skipped, 1);
    assert.equal(fs.readFileSync(path.join(agentsDir, 'gsd-pinned-agent.toml'), 'utf8'), content);

    cleanup(tmpDir);
  });

  test('B6: orphaned model_reasoning_effort, no model — the effort stripped', () => {
    const tmpDir = makeTmpDir('codex-sync-b6-');
    const agentsDir = makeAgentsDir(tmpDir);
    writeCodexAgentToml(
      agentsDir,
      'gsd-orphan-agent',
      'name = "gsd-orphan-agent"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n',
    );

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 1);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].field, 'model_reasoning_effort');
    assert.equal(result.changes[0].from, 'high');
    const updated = fs.readFileSync(path.join(agentsDir, 'gsd-orphan-agent.toml'), 'utf8');
    assert.ok(!updated.includes('model_reasoning_effort'), 'the orphaned effort must be gone');

    cleanup(tmpDir);
  });

  test('B7: stale model plus its effort — both stripped', () => {
    const tmpDir = makeTmpDir('codex-sync-b7-');
    const agentsDir = makeAgentsDir(tmpDir);
    writeCodexAgentToml(
      agentsDir,
      'gsd-stale-agent',
      'name = "gsd-stale-agent"\nmodel = "opus"\nmodel_reasoning_effort = "medium"\n' +
        "developer_instructions = '''\nWork.\n'''\n",
    );

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 1);
    assert.equal(result.changes.length, 2, 'both the model and the coupled effort must be reported');
    const fields = result.changes.map(c => c.field).sort();
    assert.deepEqual(fields, ['model', 'model_reasoning_effort']);
    const updated = fs.readFileSync(path.join(agentsDir, 'gsd-stale-agent.toml'), 'utf8');
    assert.ok(!updated.includes('model = "opus"'));
    assert.ok(!updated.includes('model_reasoning_effort'));

    cleanup(tmpDir);
  });

  test('B8: posture-clean .toml — synced:0, no write (mtime unchanged)', () => {
    const tmpDir = makeTmpDir('codex-sync-b8-');
    const agentsDir = makeAgentsDir(tmpDir);
    writeCodexAgentToml(
      agentsDir,
      'gsd-clean',
      'name = "gsd-clean"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n',
    );
    const filePath = path.join(agentsDir, 'gsd-clean.toml');
    const mtimeBefore = fs.statSync(filePath).mtimeMs;

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 0);
    assert.equal(fs.statSync(filePath).mtimeMs, mtimeBefore, 'a posture-clean file must never be written');

    cleanup(tmpDir);
  });

  test('B9 (boundary): dry-run is the default — changes reported, file byte-identical after', () => {
    const tmpDir = makeTmpDir('codex-sync-b9-');
    const agentsDir = makeAgentsDir(tmpDir);
    const content = 'name = "gsd-planner"\nmodel = "sonnet"\ndeveloper_instructions = \'\'\'\nPlan.\n\'\'\'\n';
    writeCodexAgentToml(agentsDir, 'gsd-planner', content);

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { configDir: tmpDir, runtime: 'codex' }) // no dryRun key — must default true
    );

    assert.equal(result.dry_run, true);
    assert.equal(result.synced, 1, 'the pending strip must still be reported');
    assert.equal(fs.readFileSync(path.join(agentsDir, 'gsd-planner.toml'), 'utf8'), content, 'dry-run must not write');

    cleanup(tmpDir);
  });

  test('B10: --no-dry-run writes; reports identically to the dry run', () => {
    const content = 'name = "gsd-planner"\nmodel = "sonnet"\ndeveloper_instructions = \'\'\'\nPlan.\n\'\'\'\n';

    const dryTmpDir = makeTmpDir('codex-sync-b10-dry-');
    writeCodexAgentToml(makeAgentsDir(dryTmpDir), 'gsd-planner', content);
    const dryResult = syncCodex(dryTmpDir, true);

    const applyTmpDir = makeTmpDir('codex-sync-b10-apply-');
    const applyAgentsDir = makeAgentsDir(applyTmpDir);
    writeCodexAgentToml(applyAgentsDir, 'gsd-planner', content);
    const applyResult = syncCodex(applyTmpDir, false);

    assert.equal(dryResult.synced, applyResult.synced);
    assert.deepEqual(dryResult.changes, applyResult.changes, 'the report must match the dry run exactly');
    assert.equal(dryResult.dry_run, true);
    assert.equal(applyResult.dry_run, false);
    assert.ok(!fs.readFileSync(path.join(applyAgentsDir, 'gsd-planner.toml'), 'utf8').includes('model = "sonnet"'));

    cleanup(dryTmpDir);
    cleanup(applyTmpDir);
  });

  test('B11 (negative proof): unterminated block — skipped and reported, file byte-identical after', () => {
    const tmpDir = makeTmpDir('codex-sync-b11-');
    const agentsDir = makeAgentsDir(tmpDir);
    const content = 'name = "gsd-broken"\nmodel = "sonnet"\ndeveloper_instructions = \'\'\'\nThis block never closes.\n';
    writeCodexAgentToml(agentsDir, 'gsd-broken', content);

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 0, 'an unparseable document must never be synced');
    assert.equal(result.skipped, 1);
    assert.equal(result.refused.length, 1);
    assert.equal(result.refused[0].agent, 'gsd-broken');
    assert.equal(result.refused[0].reason, PARSE_REASON.UNTERMINATED_BLOCK);
    assert.equal(
      fs.readFileSync(path.join(agentsDir, 'gsd-broken.toml'), 'utf8'),
      content,
      'a refused file must never be partially rewritten',
    );

    cleanup(tmpDir);
  });

  test('B12 (negative proof): symlinked .toml — skipped, target byte-identical after', (t) => {
    const tmpDir = makeTmpDir('codex-sync-b12-');
    const agentsDir = makeAgentsDir(tmpDir);
    const targetPath = path.join(tmpDir, 'outside-target.toml');
    const targetContent = 'model = "sonnet"\n';
    fs.writeFileSync(targetPath, targetContent);
    const symlinkPath = path.join(agentsDir, 'gsd-linked.toml');
    try {
      fs.symlinkSync(targetPath, symlinkPath, 'file');
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip('symlink creation is not available on this platform');
        cleanup(tmpDir);
        return;
      }
      throw error;
    }

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 0);
    assert.ok(
      !result.changes.some(c => c.agent === 'gsd-linked'),
      'a symlinked agent must never be reported as synced',
    );
    assert.equal(fs.readFileSync(targetPath, 'utf8'), targetContent, 'the symlink target must never be written through');

    cleanup(tmpDir);
  });

  test('B13: agents dir absent — reports not-found, as the claude path does', () => {
    const tmpDir = makeTmpDir('codex-sync-b13-');
    // agentsDir intentionally not created

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 0);
    assert.equal(result.reason, 'agents directory not found');

    cleanup(tmpDir);
  });

  test('B14 (hostile, headline data-loss case): model = inside developer_instructions — file byte-identical after a non-dry-run sync', () => {
    const tmpDir = makeTmpDir('codex-sync-b14-');
    const agentsDir = makeAgentsDir(tmpDir);
    const fixtureContent = fs.readFileSync(path.join(FIXTURES_DIR, 'model-in-developer-instructions.toml'), 'utf8');
    writeCodexAgentToml(agentsDir, 'gsd-planner', fixtureContent);

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 0, 'the prose model= inside the block must never be treated as a pin');
    assert.equal(
      fs.readFileSync(path.join(agentsDir, 'gsd-planner.toml'), 'utf8'),
      fixtureContent,
      'the agent prompt must survive a non-dry-run sync untouched',
    );

    cleanup(tmpDir);
  });

  test('B15 (cross-platform): CRLF file, stale pin — pin stripped, remaining line endings still CRLF', () => {
    const tmpDir = makeTmpDir('codex-sync-b15-');
    const agentsDir = makeAgentsDir(tmpDir);
    const lfContent = 'name = "gsd-scribe"\nmodel = "sonnet"\ndeveloper_instructions = \'\'\'\nWrite a changelog entry.\n\'\'\'\n';
    const crlfContent = lfContent.replace(/\n/g, '\r\n');
    writeCodexAgentToml(agentsDir, 'gsd-scribe', crlfContent);

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 1);
    const updated = fs.readFileSync(path.join(agentsDir, 'gsd-scribe.toml'), 'utf8');
    assert.ok(!updated.includes('model = "sonnet"'));
    assert.equal(
      updated,
      'name = "gsd-scribe"\r\ndeveloper_instructions = \'\'\'\r\nWrite a changelog entry.\r\n\'\'\'\r\n',
      'every remaining line ending must still be CRLF',
    );

    cleanup(tmpDir);
  });

  test('B16 (cross-platform): BOM file, stale pin — pin stripped, BOM preserved', () => {
    const tmpDir = makeTmpDir('codex-sync-b16-');
    const agentsDir = makeAgentsDir(tmpDir);
    const content = String.fromCharCode(0xfeff) +
      'name = "gsd-archivist"\nmodel = "sonnet"\ndeveloper_instructions = \'\'\'\nArchive.\n\'\'\'\n';
    writeCodexAgentToml(agentsDir, 'gsd-archivist', content);

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 1);
    const updatedRaw = fs.readFileSync(path.join(agentsDir, 'gsd-archivist.toml'));
    assert.equal(updatedRaw[0], 0xef, 'BOM byte 1 (EF) must survive');
    assert.equal(updatedRaw[1], 0xbb, 'BOM byte 2 (BB) must survive');
    assert.equal(updatedRaw[2], 0xbf, 'BOM byte 3 (BF) must survive');
    assert.ok(!updatedRaw.toString('utf8').includes('model = "sonnet"'));

    cleanup(tmpDir);
  });

  test('B17 (boundary): file with no trailing newline — preserved', () => {
    const tmpDir = makeTmpDir('codex-sync-b17-');
    const agentsDir = makeAgentsDir(tmpDir);
    const content = 'name = "gsd-bare"\nmodel = "sonnet"'; // deliberately no trailing \n
    writeCodexAgentToml(agentsDir, 'gsd-bare', content);

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 1);
    const updated = fs.readFileSync(path.join(agentsDir, 'gsd-bare.toml'), 'utf8');
    assert.equal(updated, 'name = "gsd-bare"', 'the file must still have no trailing newline');

    cleanup(tmpDir);
  });

  test('B18 (negative proof): hand-added approval_policy survives a strip of the stale pin untouched', () => {
    const tmpDir = makeTmpDir('codex-sync-b18-');
    const agentsDir = makeAgentsDir(tmpDir);
    writeCodexAgentToml(
      agentsDir,
      'gsd-custom-agent',
      'name = "gsd-custom-agent"\nmodel = "sonnet"\napproval_policy = "on-request"\n' +
        "developer_instructions = '''\nFollow policy.\n'''\n",
    );

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 1);
    const updated = fs.readFileSync(path.join(agentsDir, 'gsd-custom-agent.toml'), 'utf8');
    assert.ok(updated.includes('approval_policy = "on-request"'), 'the hand-added key must survive verbatim');
    assert.ok(!updated.includes('model = "sonnet"'));

    cleanup(tmpDir);
  });

  test('B19 (negative proof): interleaved comments preserved verbatim', () => {
    const tmpDir = makeTmpDir('codex-sync-b19-');
    const agentsDir = makeAgentsDir(tmpDir);
    writeCodexAgentToml(
      agentsDir,
      'gsd-commented',
      '# top comment\nname = "gsd-commented"\n# a note about the model below\nmodel = "sonnet"\n# trailing comment\n' +
        "developer_instructions = '''\nWork.\n'''\n",
    );

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 1);
    const updated = fs.readFileSync(path.join(agentsDir, 'gsd-commented.toml'), 'utf8');
    assert.ok(updated.includes('# top comment'));
    assert.ok(updated.includes('# a note about the model below'));
    assert.ok(updated.includes('# trailing comment'));
    assert.ok(!updated.includes('model = "sonnet"'));

    cleanup(tmpDir);
  });

  test('B20 (filesystem failure, atomic-write proof): a mid-write failure is reported; the remaining agents still get processed; the target is left byte-identical, never partially rewritten', (t) => {
    const tmpDir = makeTmpDir('codex-sync-b20-');
    const agentsDir = makeAgentsDir(tmpDir);
    const alphaOriginal = 'name = "gsd-alpha"\nmodel = "sonnet"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n';
    writeCodexAgentToml(agentsDir, 'gsd-alpha', alphaOriginal);
    writeCodexAgentToml(agentsDir, 'gsd-bravo', 'name = "gsd-bravo"\nmodel = "opus"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n');
    const failingPath = path.join(agentsDir, 'gsd-alpha.toml');

    // Unlike the old version of this test — which mocked fs.writeFileSync to
    // throw BEFORE any bytes ever reached disk, proving nothing about a
    // mid-write failure — this injects the failure at the point a NON-ATOMIC
    // implementation (`fs.writeFileSync(filePath, ...)` straight into the
    // target, in place) would already have truncated the real file: 'w'-mode
    // open+truncate happens before any content is written, so a crash between
    // open and completion leaves a partial file. The mock actually performs a
    // REAL (truncated) write to whatever path it's called with — including a
    // hypothetical direct write to `failingPath` itself — before throwing, so
    // an in-place implementation's target would end up holding these 4 bytes,
    // not the original content. An atomic tmp+rename implementation instead
    // sends this call to a SIBLING tmp path (never `failingPath` itself), so
    // `failingPath` is never opened for write in the first place and survives
    // untouched.
    const realWriteFileSync = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (target, data, ...args) => {
      if (typeof target === 'string' && target.startsWith(failingPath)) {
        realWriteFileSync.call(fs, target, String(data).slice(0, 4));
        throw Object.assign(new Error('injected ENOSPC (mid-write)'), { code: 'ENOSPC' });
      }
      return realWriteFileSync.call(fs, target, data, ...args);
    });

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 1, 'only the non-failing agent must be reported synced');
    assert.equal(result.write_failures.length, 1);
    assert.equal(result.write_failures[0].agent, 'gsd-alpha');
    assert.ok(
      !result.changes.some(c => c.agent === 'gsd-alpha'),
      'a failed write must never be reported as a completed change',
    );
    assert.ok(
      fs.readFileSync(path.join(agentsDir, 'gsd-bravo.toml'), 'utf8').indexOf('model = "opus"') === -1,
      'the sibling agent must still be synced despite the other write failing',
    );
    // The load-bearing assertion (ADR-2313 "never partially rewritten"): the
    // target must be BYTE-IDENTICAL to its pre-sync content, not merely
    // "contains model = sonnet somewhere" — a truncated-to-4-bytes file would
    // pass a substring check but fail this equality. Against the pre-fix
    // in-place `fs.writeFileSync(filePath, renderCodexAgentToml(doc))`, this
    // assertion FAILS: that call's target IS `failingPath`, so the mock's
    // real truncated write lands directly on the file, leaving it as the
    // 4-byte slice `'name'` instead of `alphaOriginal`.
    assert.equal(
      fs.readFileSync(failingPath, 'utf8'),
      alphaOriginal,
      'a mid-write failure must leave the original file byte-identical, never partially rewritten',
    );
    // The atomic write path cleans up its sibling tmp file on failure — no
    // stray `.tmp.<pid>` left behind in the agents directory.
    const leftovers = fs.readdirSync(agentsDir).filter(f => f !== 'gsd-alpha.toml' && f !== 'gsd-bravo.toml');
    assert.deepEqual(leftovers, [], 'a failed write must not leave a stray tmp file behind');

    cleanup(tmpDir);
  });

  test('B21 (independence): several agents, mixed states — per-agent results, deterministic order', () => {
    const tmpDir = makeTmpDir('codex-sync-b21-');
    const agentsDir = makeAgentsDir(tmpDir);
    writeCodexAgentToml(agentsDir, 'gsd-alpha', 'name = "gsd-alpha"\ndeveloper_instructions = \'\'\'\nClean.\n\'\'\'\n');
    writeCodexAgentToml(agentsDir, 'gsd-bravo', 'name = "gsd-bravo"\nmodel = "opus"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n');
    writeCodexAgentToml(agentsDir, 'gsd-charlie', 'name = "gsd-charlie"\nmodel_reasoning_effort = "medium"\ndeveloper_instructions = \'\'\'\nWork.\n\'\'\'\n');

    const result = syncCodex(tmpDir, false);

    assert.equal(result.synced, 2, 'gsd-bravo and gsd-charlie must both sync; gsd-alpha is clean');
    assert.equal(result.skipped, 1);
    assert.deepEqual(
      result.changes.map(c => c.agent),
      ['gsd-bravo', 'gsd-charlie'],
      'agents must be processed in deterministic (sorted) order',
    );

    cleanup(tmpDir);
  });
});
  });
}

describe('query commit --files scoping (#2269)', () => {
  const REPO_ROOT = path.join(__dirname, '..');

  test('secure-phase.md passes --files to its query commit call', () => {
    const content = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'workflows', 'secure-phase.md'), 'utf-8'
    );
    const idx = content.indexOf('add/update security threat verification');
    assert.notEqual(idx, -1, 'must contain the security commit message');
    assert.match(content.slice(idx, idx + 200), /--files/);
    assert.match(content.slice(idx, idx + 200), /SECURITY\.md/);
  });

  test('validate-phase.md passes --files to its query commit call', () => {
    const content = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'workflows', 'validate-phase.md'), 'utf-8'
    );
    const idx = content.indexOf('add/update validation strategy');
    assert.notEqual(idx, -1, 'must contain the validation commit message');
    assert.match(content.slice(idx, idx + 200), /--files/);
    assert.match(content.slice(idx, idx + 200), /VALIDATION\.md/);
  });

  test('next.md passes --files to its deferral query commit call', () => {
    const content = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'workflows', 'next.md'), 'utf-8'
    );
    const idx = content.indexOf('defer incomplete Phase');
    assert.notEqual(idx, -1, 'must contain the deferral commit message');
    assert.match(content.slice(idx, idx + 200), /--files/);
    assert.match(content.slice(idx, idx + 200), /ROADMAP\.md/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3776: `query commit --files` must report an empty diff as `nothing_to_commit`
// even when a pre-commit hook would reject.
//
// `stagedPaths` records paths whose `git add` exited 0 — "did staging succeed",
// not "is there anything to commit". Staging an already-committed, unmodified
// file succeeds and contributes nothing, so the old `stagedPaths.length === 0`
// guard was reachable only when EVERY named path was missing from disk. The
// ordinary empty-diff case fell through to `git commit`, where the sole rescue
// was a string match on git's "nothing to commit" output — and git runs the
// pre-commit hook BEFORE deciding there is nothing to commit, so a rejecting
// hook pre-empted the match and the caller was handed `commit_failed` carrying
// a gate message about a commit that had nothing to gate.
//
// The residual sibling of #2608/#2693, which covered `git add` FAILING; this
// covers `git add` succeeding and contributing nothing.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3776: query commit --files reports an empty diff as nothing_to_commit', () => {
  const { createTempGitProject } = require('./helpers.cjs');
  // runGit (never gitOrThrow) for the conflicting merge below — that merge is
  // MEANT to exit non-zero, and the throwing wrapper would fail the fixture.
  const { runGit } = require('./helpers/process-seam.cjs');
  let tmpDir;

  const REJECTING_HOOK = '#!/bin/sh\necho "gate: BACKLOG.md is stale" >&2\nexit 1\n';
  const PASSING_HOOK = '#!/bin/sh\nexit 0\n';

  // Writes .git/hooks/pre-commit. Every arm below drives the real hook, not a
  // stub of it: the defect lives in git's own hook-before-empty-diff ordering,
  // so a faked rejection would not exercise the mechanism under test.
  function installHook(body) {
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, body);
    fs.chmodSync(hookPath, 0o755);
  }

  // A tracked, committed, unmodified file — `git add` on it succeeds and
  // contributes no diff. This is the exact shape the guard used to miss.
  function commitFixtureFile(name = 'doc.md', body = 'hello\n') {
    const rel = path.posix.join('.planning', name);
    fs.writeFileSync(path.join(tmpDir, '.planning', name), body);
    gitOrThrow(['add', '--', rel], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'fixture: ' + name], { cwd: tmpDir });
    return rel;
  }

  // The command emits its JSON payload on either stream depending on outcome;
  // read whichever carries it rather than assuming success.
  function commitFiles(rel, extra = '') {
    const result = runGsdTools('commit "m"' + extra + ' --files ' + rel, tmpDir);
    const payload = (result.output && result.output.trim()) ? result.output : result.error;
    return JSON.parse(payload);
  }

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // AC1 — the defect. Pre-fix this returned commit_failed + the hook's message.
  test('AC1: empty diff + rejecting pre-commit hook reports nothing_to_commit, not the hook rejection', () => {
    const rel = commitFixtureFile();
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'nothing_to_commit',
      'an empty-diff --files call must not be reported as a failed commit');
    assert.ok(!output.error,
      'no hook message may be surfaced for a call that had nothing to gate');
  });

  // AC2 — the two controls that isolate the hook as the only variable.
  test('AC2: empty diff + no hook still reports nothing_to_commit', () => {
    const rel = commitFixtureFile();

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'nothing_to_commit');
  });

  test('AC2: empty diff + passing hook still reports nothing_to_commit', () => {
    const rel = commitFixtureFile();
    installHook(PASSING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'nothing_to_commit');
  });

  // AC3 — the all-missing short-circuit must not regress.
  test('AC3: every named path missing from disk still reports nothing_to_commit', () => {
    const rel = commitFixtureFile();
    fs.unlinkSync(path.join(tmpDir, rel));
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'nothing_to_commit');
  });

  // AC3, sharp edge: the `stagedPaths.length === 0` short-circuit is
  // load-bearing, not defensive noise. Without it an all-missing call spreads
  // an empty array into the pathspec, and a pathspec-less `git diff HEAD`
  // tests the WHOLE tree — so unrelated work would suppress the guard and turn
  // this arm into a commit of somebody else's changes.
  test('AC3: all named paths missing does not consult unrelated staged work', () => {
    const rel = commitFixtureFile();
    fs.unlinkSync(path.join(tmpDir, rel));
    const unrelated = path.posix.join('.planning', 'unrelated.md');
    fs.writeFileSync(path.join(tmpDir, unrelated), 'staged by the caller\n');
    gitOrThrow(['add', '--', unrelated], { cwd: tmpDir });
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'nothing_to_commit');

    const staged = gitOrThrow(['diff', '--cached', '--name-only'], { cwd: tmpDir });
    assert.match(staged, /unrelated\.md/,
      "the caller's own staged work must be left in the index, not swept into a commit");
  });

  // AC4 — a genuine rejection must still be reported. The goal is to stop
  // reporting a rejection for a call that never had anything to gate, not to
  // stop reporting rejections.
  test('AC4: a real diff rejected by the hook still reports commit_failed with the hook message', () => {
    const rel = commitFixtureFile();
    fs.writeFileSync(path.join(tmpDir, rel), 'hello\nmodified\n');
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'commit_failed');
    assert.match(String(output.error), /BACKLOG\.md is stale/,
      "the hook's own message must still reach the caller");
  });

  test('AC4: a real diff with no hook still commits', () => {
    const rel = commitFixtureFile();
    fs.writeFileSync(path.join(tmpDir, rel), 'hello\nmodified\n');

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, true);
    assert.strictEqual(output.reason, 'committed');
    assert.ok(output.hash, 'a successful commit must carry its hash');
  });

  // AC5 — amending has a different empty-diff meaning; the guard stays exempt.
  test('AC5: --amend remains exempt from the empty-diff guard', () => {
    const rel = commitFixtureFile();
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel, ' --amend');
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'commit_failed',
      '--amend must still reach git, where the hook governs the rewrite');
  });

  // Beyond the brief's ACs: during a merge git refuses a partial commit, so the
  // commit runs WITHOUT the pathspec and the named paths describe nothing about
  // what would land. Deciding "nothing to commit" from them would abandon the
  // merge — which is why the empty-diff probe is gated on !isMergeInProgress.
  // Sets up a conflicted history and leaves the caller mid-sequence. `rel` (the
  // file the commit call names) is never touched by the conflict, so it always
  // contributes no diff of its own — which is what puts these arms on the
  // empty-diff branch under test.
  function conflictedSequence(kind) {
    const shared = path.posix.join('.planning', 'shared.md');
    fs.writeFileSync(path.join(tmpDir, shared), 'base\n');
    gitOrThrow(['add', '--', shared], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'shared base'], { cwd: tmpDir });
    const trunk = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();

    if (kind === 'revert') {
      fs.writeFileSync(path.join(tmpDir, shared), 'second\n');
      gitOrThrow(['commit', '-am', 'second'], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, shared), 'third\n');
      gitOrThrow(['commit', '-am', 'third'], { cwd: tmpDir });
      runGit(['revert', '--no-edit', 'HEAD~1'], { cwd: tmpDir });
    } else {
      gitOrThrow(['checkout', '-b', 'side'], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, shared), 'side\n');
      gitOrThrow(['commit', '-am', 'side edit'], { cwd: tmpDir });
      gitOrThrow(['checkout', trunk], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, shared), 'trunk\n');
      gitOrThrow(['commit', '-am', 'trunk edit'], { cwd: tmpDir });
      runGit([kind === 'merge' ? 'merge' : 'cherry-pick', 'side'], { cwd: tmpDir });
    }
    fs.writeFileSync(path.join(tmpDir, shared), 'resolved\n');
    gitOrThrow(['add', '--', shared], { cwd: tmpDir });
  }

  // The one state where `git diff` and `git commit -- <path>` genuinely
  // disagree. `--assume-unchanged` makes `git add` stage nothing and BOTH diff
  // forms (`--cached` and `HEAD`) report no difference, while
  // `git commit -- <path>` reads the working tree directly and records it. The
  // pre-#3776 build therefore COMMITTED this, and the guard must not turn a
  // purely diagnostic fix into a silent drop of content the caller named in
  // `--files`. Asking `git commit --dry-run` preserves the pre-fix outcome
  // exactly, because it is the same decision the real commit makes.
  test('a modified assume-unchanged path is still committed, not swallowed by the guard', () => {
    const rel = commitFixtureFile();
    gitOrThrow(['update-index', '--assume-unchanged', '--', rel], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, rel), 'hello\nmodified under assume-unchanged\n');

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, true,
      'git commit -- <path> reads the working tree and records it; the guard must not pre-empt that');
    assert.strictEqual(
      gitOrThrow(['show', 'HEAD:' + rel], { cwd: tmpDir }),
      'hello\nmodified under assume-unchanged\n',
      'and the content it records must be the working-tree content');
  });

  // THE OTHER DIRECTION, and the reason the check compares CONTENT rather than
  // stopping at the `ls-files -v` tag. An unmodified assume-unchanged path has
  // nothing to record; falling through on the tag alone would hand it to
  // `git commit`, which — with any unrelated modified file present — prints
  // `no changes added to commit`, a string the fallback does not match, and
  // returns `commit_failed`. That is #3776 re-entered from the other side, the
  // same shape `--ignore-submodules=none` would have re-entered it. Pinned so a
  // later simplification to a tag-only test cannot pass.
  test('an UNMODIFIED assume-unchanged path still reports nothing_to_commit, even with unrelated dirt', () => {
    const rel = commitFixtureFile();
    const unrelated = path.posix.join('.planning', 'unrelated.md');
    fs.writeFileSync(path.join(tmpDir, unrelated), 'seed\n');
    gitOrThrow(['add', '--', unrelated], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'seed unrelated'], { cwd: tmpDir });
    gitOrThrow(['update-index', '--assume-unchanged', '--', rel], { cwd: tmpDir });
    // Unrelated modified work present — this is what turns git's answer from
    // `nothing to commit` into `no changes added to commit`.
    fs.writeFileSync(path.join(tmpDir, unrelated), 'unrelated edit\n');

    assert.strictEqual(commitFiles(rel).reason, 'nothing_to_commit',
      'nothing would land for the named path, so the guard must still answer nothing_to_commit');
  });

  // `--skip-worktree` is NOT a second instance of the above, and the PR body
  // used to group them. `git add` exits 1 under it (the path reads as outside
  // the sparse-checkout definition), so it fails closed as `staging_failed`
  // ABOVE this guard and never reaches the empty-diff decision at all.
  test('a modified skip-worktree path fails closed as staging_failed, never reaching the guard', () => {
    const rel = commitFixtureFile();
    gitOrThrow(['update-index', '--skip-worktree', '--', rel], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, rel), 'hello\nmodified under skip-worktree\n');

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'staging_failed',
      'git add refuses the path, so the staging-failure block above the guard owns this case');
  });

  // The same flag with the path ABSENT from disk — the canonical sparse shape —
  // takes a DIFFERENT route, and the distinction is worth pinning because the
  // obvious reading of the arm above ("skip-worktree never reaches the guard")
  // is too strong. A missing path is skipped before `git add` runs at all
  // (#2014), so `stagedPaths` is empty and the guard's own
  // `stagedPaths.length === 0` arm answers it. `nothing_to_commit` is the
  // correct answer there — the file does not exist, so a commit would record
  // nothing — and it is the PRE-FIX answer too, unchanged by this PR.
  test('a skip-worktree path absent from disk reports nothing_to_commit via the missing-path arm', () => {
    const rel = commitFixtureFile();
    gitOrThrow(['update-index', '--skip-worktree', '--', rel], { cwd: tmpDir });
    fs.unlinkSync(path.join(tmpDir, rel));

    assert.strictEqual(commitFiles(rel).reason, 'nothing_to_commit',
      'a missing path is skipped before git add, so the length === 0 arm owns this — not staging_failed');
  });

  // THREE ARMS PINNING WHY THE PROBE ASKS GIT RATHER THAN RECONSTRUCTING ITS
  // ANSWER. Each one reds if the dry run is replaced by a
  // `hash-object` vs `HEAD:<path>` blob comparison, and each is a silent drop
  // of content the caller named — the exact class this whole guard is careful
  // about.

  // A mode-only change leaves the blob identical, so a content comparison sees
  // nothing — while `git commit -- <path>` records the new mode.
  test('a mode-only change to an assume-unchanged path is still committed', (t) => {
    const rel = commitFixtureFile('exec.md');
    // Windows, and any checkout with `core.filemode=false`, cannot represent
    // the bit — `chmodSync` would then be a no-op and this arm would pass while
    // pinning nothing. Assert the precondition and skip loudly instead.
    gitOrThrow(['config', 'core.filemode', 'true'], { cwd: tmpDir });
    gitOrThrow(['update-index', '--assume-unchanged', '--', rel], { cwd: tmpDir });
    fs.chmodSync(path.join(tmpDir, rel), 0o755);
    if (!/^100755 /.test(gitOrThrow(['ls-files', '-s', '--', rel], { cwd: tmpDir }))
      && (fs.statSync(path.join(tmpDir, rel)).mode & 0o111) === 0) {
      t.skip('filesystem cannot represent the executable bit — nothing to pin here');
      return;
    }

    assert.strictEqual(commitFiles(rel).committed, true,
      'the mode moved and git would record it, so the guard must not report nothing_to_commit');
    assert.match(
      gitOrThrow(['ls-tree', 'HEAD', '--', rel], { cwd: tmpDir }), /^100755 /,
      'and the recorded mode must actually be the executable one');
  });

  // A non-ASCII path is rendered QUOTED by `git ls-files -v` under the default
  // `core.quotePath` (`"caf\303\251.md"`), so any probe that parses the path
  // out of that output reads a filename that does not exist and silently
  // concludes there is nothing to commit.
  test('a modified assume-unchanged path with a non-ASCII name is still committed', () => {
    const rel = commitFixtureFile('caf\u00e9.md');
    // PIN the quoting explicitly. This arm's whole point is that a probe
    // parsing the path out of `ls-files -v` reads `"caf\303\251.md"` and finds
    // no such file; under an ambient `core.quotePath=false` the rejected
    // implementation would pass here and the arm would be vacuous.
    gitOrThrow(['config', 'core.quotePath', 'true'], { cwd: tmpDir });
    gitOrThrow(['update-index', '--assume-unchanged', '--', rel], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, rel), 'modified\n');

    assert.strictEqual(commitFiles(rel).committed, true,
      'core.quotePath must not be able to hide a real change from the probe');
    assert.strictEqual(gitOrThrow(['show', 'HEAD:' + rel], { cwd: tmpDir }), 'modified\n');
  });

  // The probe compares the WORKING TREE to HEAD, so an unborn HEAD makes it
  // fatal (rc 128). That must fall through to the commit rather than be read as
  // "nothing to commit" — there is plenty to commit in a repo with no commits.
  test('an unborn HEAD falls through to the commit rather than reporting nothing_to_commit', (t) => {
    const fresh = createTempDir();
    // REGISTERED teardown, not a trailing statement: `fresh` lives outside
    // `tmpDir`, so afterEach does not reach it and any failing assertion below
    // would leak a git repo into the temp root.
    t.after(() => cleanup(fresh));
    fs.mkdirSync(path.join(fresh, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(fresh, '.planning', 'config.json'), '{}\n');
    fs.writeFileSync(path.join(fresh, '.planning', 'doc.md'), 'first content\n');
    gitOrThrow(['init', '-q', '.'], { cwd: fresh });
    gitOrThrow(['config', 'user.email', 't@t'], { cwd: fresh });
    gitOrThrow(['config', 'user.name', 't'], { cwd: fresh });

    const result = runGsdTools('commit "m" --files .planning/doc.md', fresh);
    const payload = (result.output && result.output.trim()) ? result.output : result.error;
    const output = JSON.parse(payload);
    assert.strictEqual(output.committed, true,
      'the very first commit in a repo must not be swallowed by the empty-diff guard');
  });

  // git refuses a partial commit during a cherry-pick exactly as it does during
  // a merge, so the guard must stay out of the way there too — this arm pins
  // that the pre-fix outcome is preserved rather than turned into a silent
  // no-op. Driven, not assumed: the three sequencer states disagree.
  test('a cherry-pick in progress keeps its pre-existing outcome', () => {
    const rel = commitFixtureFile();
    conflictedSequence('cherry-pick');
    assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'CHERRY_PICK_HEAD')),
      'fixture must leave a cherry-pick in progress');
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'commit_failed',
      'git refuses the partial commit here; that must not become a silent nothing_to_commit');
    assert.match(String(output.error), /partial commit/,
      "git's own refusal must reach the caller");
  });

  // REVERT_HEAD is deliberately NOT in the refusal set: a revert permits partial
  // commits, so the fix must still apply there. Including it would suppress the
  // fix during a revert and reintroduce the misreport.
  test('a revert in progress still reports nothing_to_commit, not the hook rejection', () => {
    const rel = commitFixtureFile();
    conflictedSequence('revert');
    assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'REVERT_HEAD')),
      'fixture must leave a revert in progress');
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'nothing_to_commit',
      'a revert permits partial commits, so the empty-diff guard must still apply');
  });

  test('a merge in progress is still concluded when the named paths carry no diff', () => {
    const shared = path.posix.join('.planning', 'shared.md');
    fs.writeFileSync(path.join(tmpDir, shared), 'base\n');
    gitOrThrow(['add', '--', shared], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'shared base'], { cwd: tmpDir });
    const rel = commitFixtureFile();

    const trunk = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();
    gitOrThrow(['checkout', '-b', 'side'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, shared), 'side\n');
    gitOrThrow(['commit', '-am', 'side edit'], { cwd: tmpDir });
    gitOrThrow(['checkout', trunk], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, shared), 'trunk\n');
    gitOrThrow(['commit', '-am', 'trunk edit'], { cwd: tmpDir });

    // Conflicting merge, then resolve it so the index carries real content.
    runGit(['merge', 'side'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, shared), 'resolved\n');
    gitOrThrow(['add', '--', shared], { cwd: tmpDir });
    assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'MERGE_HEAD')),
      'fixture must leave a merge in progress');

    // `rel` is committed and unmodified — it contributes no diff of its own.
    const output = commitFiles(rel);
    assert.strictEqual(output.committed, true,
      'the merge must still be concluded, not reported as nothing to commit');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.git', 'MERGE_HEAD')),
      'MERGE_HEAD must be gone once the merge commit lands');
  });
});

// #3859: the empty-diff probe must answer the question `git commit -- <paths>`
// asks. `git diff` is porcelain and honours user configuration the commit does
// not, so an unpinned probe lets a caller's config decide whether the guard
// fires — and every arm below was driven against git 2.54 by confirming that
// `git commit -- <path>` records exactly the change the unpinned probe reports
// as absent.
describe('#3859: the empty-diff probe is pinned against diff-only configuration', () => {
  const { createTempGitProject } = require('./helpers.cjs');
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function commitFiles(rel) {
    const result = runGsdTools('commit "m" --files ' + rel, tmpDir);
    const payload = (result.output && result.output.trim()) ? result.output : result.error;
    return JSON.parse(payload);
  }

  // Sub-repos created by `bumpedSubmodule()` are SIBLINGS of `tmpDir`, so the
  // `afterEach` above does not reach them. Registering them here cleans every
  // caller at once and — unlike a trailing `cleanup(subSrc)` in each test body
  // — survives a failing assertion, which would otherwise leak a git repo into
  // the temp root.
  const strayRepos = [];
  afterEach(() => {
    while (strayRepos.length > 0) cleanup(strayRepos.pop());
  });

  // A submodule whose recorded gitlink is AHEAD of what the superproject has
  // committed — i.e. `git commit -- <sub>` has something real to record.
  function bumpedSubmodule() {
    const subSrc = path.join(tmpDir, '..', path.basename(tmpDir) + '-sub');
    strayRepos.push(subSrc);
    fs.mkdirSync(subSrc, { recursive: true });
    gitOrThrow(['init', '-q', '.'], { cwd: subSrc });
    gitOrThrow(['config', 'user.email', 't@t'], { cwd: subSrc });
    gitOrThrow(['config', 'user.name', 't'], { cwd: subSrc });
    fs.writeFileSync(path.join(subSrc, 'f.txt'), 'v1\n');
    gitOrThrow(['add', 'f.txt'], { cwd: subSrc });
    gitOrThrow(['commit', '-m', 'v1'], { cwd: subSrc });

    gitOrThrow(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSrc, 'sub'], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'add submodule'], { cwd: tmpDir });

    fs.writeFileSync(path.join(subSrc, 'f.txt'), 'v2\n');
    gitOrThrow(['add', 'f.txt'], { cwd: subSrc });
    gitOrThrow(['commit', '-m', 'v2'], { cwd: subSrc });
    gitOrThrow(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--remote', '--', 'sub'], { cwd: tmpDir });
  }

  // `diff.ignoreSubmodules=all` is local config; `.gitmodules` `ignore = all` is
  // CHECKED IN and so arrives with a clone, needing no local setting at all —
  // which makes it the stronger of the two vectors, and the one a reviewer
  // reading only `diff.ignoreSubmodules` would not reach.
  for (const vector of ['diff.ignoreSubmodules', '.gitmodules ignore']) {
    test(`a submodule bump is not reported as nothing_to_commit under ${vector}=all`, () => {
      bumpedSubmodule();
      if (vector === 'diff.ignoreSubmodules') {
        gitOrThrow(['config', 'diff.ignoreSubmodules', 'all'], { cwd: tmpDir });
      } else {
        gitOrThrow(['config', '-f', '.gitmodules', 'submodule.sub.ignore', 'all'], { cwd: tmpDir });
        gitOrThrow(['add', '--', '.gitmodules'], { cwd: tmpDir });
        gitOrThrow(['commit', '-m', 'gitmodules ignore=all'], { cwd: tmpDir });
      }

      const before = gitOrThrow(['rev-parse', 'HEAD:sub'], { cwd: tmpDir }).trim();
      const output = commitFiles('sub');

      assert.notStrictEqual(output.reason, 'nothing_to_commit',
        'the gitlink moved and `git commit -- sub` records it, so the probe must not say there is nothing');
      assert.strictEqual(output.committed, true);
      assert.notStrictEqual(
        gitOrThrow(['rev-parse', 'HEAD:sub'], { cwd: tmpDir }).trim(), before,
        'the recorded gitlink must actually advance');
    });
  }

  // A submodule path cannot be hashed at all (`fatal: Unable to hash sub`),
  // while `git commit -- sub` advances the recorded gitlink.
  test('an assume-unchanged submodule with an advanced gitlink is still committed', () => {
    bumpedSubmodule();
    const before = gitOrThrow(['rev-parse', 'HEAD:sub'], { cwd: tmpDir }).trim();
    gitOrThrow(['update-index', '--assume-unchanged', '--', 'sub'], { cwd: tmpDir });

    assert.notStrictEqual(commitFiles('sub').reason, 'nothing_to_commit',
      'the gitlink would advance, so the guard must stand aside');
    assert.notStrictEqual(
      gitOrThrow(['rev-parse', 'HEAD:sub'], { cwd: tmpDir }).trim(), before,
      'and the recorded gitlink must actually advance');
  });

  // The other direction, and the reason the pin is `=dirty` rather than `=none`.
  // A partial commit of a submodule path records the GITLINK, which moves only
  // when the submodule's HEAD does — so a merely dirty submodule WORKTREE would
  // land nothing. Under `--ignore-submodules=none` the probe reports a
  // difference there and sends an empty call back to `git commit`, which is the
  // #3776 misreport re-entered from the other side. Pinned so a later widening
  // to `=none` cannot pass.
  test('a dirty submodule worktree with an unchanged gitlink still reports nothing_to_commit', () => {
    bumpedSubmodule();
    gitOrThrow(['add', '--', 'sub'], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'bump sub'], { cwd: tmpDir });
    fs.appendFileSync(path.join(tmpDir, 'sub', 'f.txt'), 'dirty\n');

    assert.strictEqual(commitFiles('sub').reason, 'nothing_to_commit',
      'nothing would land, so nothing_to_commit is the correct answer, not a misreport');
  });

  // No submodule involved. A textconv driver maps two different blobs to the
  // same text, so `git diff --quiet HEAD` reports no difference while
  // `git commit -- <path>` records the new blob.
  test('a change hidden by a textconv driver is not reported as nothing_to_commit', () => {
    const rel = path.posix.join('.planning', 'binaryish.md');
    fs.writeFileSync(path.join(tmpDir, rel), 'A\n');
    fs.writeFileSync(path.join(tmpDir, '.gitattributes'), 'binaryish.md diff=flat\n');
    gitOrThrow(['add', '--', rel, '.gitattributes'], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'seed'], { cwd: tmpDir });
    // A textconv that collapses every input to one constant. `#` swallows the
    // filename git appends, so the driver ignores its argument entirely.
    gitOrThrow(['config', 'diff.flat.textconv', 'echo CONSTANT #'], { cwd: tmpDir });

    fs.writeFileSync(path.join(tmpDir, rel), 'B\n');
    const output = commitFiles(rel);

    assert.notStrictEqual(output.reason, 'nothing_to_commit',
      'the blob changed and the commit would record it — textconv only changes how the DIFF renders');
    assert.strictEqual(output.committed, true);
    assert.strictEqual(
      gitOrThrow(['show', 'HEAD:' + rel], { cwd: tmpDir }), 'B\n',
      'the new content must actually be recorded');
  });

  // #3859 follow-up (e935694fc/b3d37b929, widened after a canScope gap found
  // reproducing live against the pinned CI tester image,
  // ghcr.io/open-gsd/gsd-tester-linux:v1.8.0-node24, which runs git 2.39.5):
  // the actual `git commit` call carries a `commitEnv` GIT_CONFIG_* override
  // forcing `diff.ignoreSubmodules=dirty`. This was originally scoped to only
  // fire when `canScope` was true (a pathspec-limited `git commit --
  // <paths>`), on the assumption that only a pathspec-limited commit
  // consults `diff.ignoreSubmodules` when deciding whether a bumped
  // submodule gitlink is a real change to record. That assumption was wrong:
  // on git 2.39.5 a bare WHOLE-INDEX `git commit -m ...` (no pathspec at
  // all, canScope=false) is refused identically when the only staged change
  // is a submodule gitlink under `diff.ignoreSubmodules=all` — git's
  // "nothing to commit" check is a real diff (HEAD vs. index) that honours
  // `diff.ignoreSubmodules` regardless of pathspec. The override is now
  // applied unconditionally (no `canScope` gate) to cover this shape too.
  // `--amend` is the one shape confirmed NOT to hit the refusal at all
  // (reproduced directly: it succeeds identically with or without the
  // override, since amend never runs the empty-diff check a plain `git
  // commit` does) — its test below pins that the override being applied
  // unconditionally is still harmless there.
  test('a whole-index commit (no --files, canScope=false) still records a bumped submodule under diff.ignoreSubmodules=all', () => {
    bumpedSubmodule();
    gitOrThrow(['config', 'diff.ignoreSubmodules', 'all'], { cwd: tmpDir });
    gitOrThrow(['add', '--', 'sub'], { cwd: tmpDir });
    const before = gitOrThrow(['rev-parse', 'HEAD:sub'], { cwd: tmpDir }).trim();

    const result = runGsdTools('commit "m"', tmpDir);
    const payload = (result.output && result.output.trim()) ? result.output : result.error;
    const output = JSON.parse(payload);

    assert.strictEqual(output.committed, true,
      'a whole-index commit hits the same git 2.39.5 refusal as a pathspec-limited one, so it needs the ' +
      'GIT_CONFIG_* override applied unconditionally, not gated on canScope, to record the bumped gitlink');
    assert.notStrictEqual(
      gitOrThrow(['rev-parse', 'HEAD:sub'], { cwd: tmpDir }).trim(), before,
      'the recorded gitlink must actually advance');
  });

  test('an --amend commit (canScope=false) still records a bumped submodule under diff.ignoreSubmodules=all', () => {
    bumpedSubmodule();
    gitOrThrow(['config', 'diff.ignoreSubmodules', 'all'], { cwd: tmpDir });
    gitOrThrow(['add', '--', 'sub'], { cwd: tmpDir });
    const before = gitOrThrow(['rev-parse', 'HEAD:sub'], { cwd: tmpDir }).trim();

    const result = runGsdTools('commit "m" --amend', tmpDir);
    const payload = (result.output && result.output.trim()) ? result.output : result.error;
    const output = JSON.parse(payload);

    assert.strictEqual(output.committed, true,
      '--amend never hits the empty-diff refusal, so the now-unconditional GIT_CONFIG_* override must remain ' +
      'a harmless no-op here');
    assert.notStrictEqual(
      gitOrThrow(['rev-parse', 'HEAD:sub'], { cwd: tmpDir }).trim(), before,
      'the recorded gitlink must actually advance');
  });
});

// #3859 follow-up: `cmdCommitToSubrepo` and `cmdPrSubrepo` carry the identical
// structurally-shaped `canScope*`-branched `git commit` call as `cmdCommit`
// above (see `COMMIT_TIMEOUT_MS`'s "three commit sites" comment in
// src/commands.cts) and were missing the same `diff.ignoreSubmodules=dirty`
// GIT_CONFIG_* override, applied unconditionally for the same reason.
describe('#3859 follow-up: commit-to-subrepo and pr-subrepo also need the diff.ignoreSubmodules override', () => {
  const { createTempGitProject } = require('./helpers.cjs');
  let rootDir;
  let nestedSubmoduleSrc;

  afterEach(() => {
    if (rootDir) cleanup(rootDir);
    if (nestedSubmoduleSrc) cleanup(nestedSubmoduleSrc);
    rootDir = undefined;
    nestedSubmoduleSrc = undefined;
  });

  // A submodule nested inside `repoDir` whose recorded gitlink is AHEAD of
  // what `repoDir` has committed — same shape as `bumpedSubmodule()` above,
  // scoped to an arbitrary sub-repo directory instead of the project root.
  function bumpedSubmoduleIn(repoDir) {
    const subSrc = path.join(repoDir, '..', path.basename(repoDir) + '-nested-sub');
    nestedSubmoduleSrc = subSrc;
    fs.mkdirSync(subSrc, { recursive: true });
    gitOrThrow(['init', '-q', '.'], { cwd: subSrc });
    gitOrThrow(['config', 'user.email', 't@t'], { cwd: subSrc });
    gitOrThrow(['config', 'user.name', 't'], { cwd: subSrc });
    fs.writeFileSync(path.join(subSrc, 'f.txt'), 'v1\n');
    gitOrThrow(['add', 'f.txt'], { cwd: subSrc });
    gitOrThrow(['commit', '-m', 'v1'], { cwd: subSrc });

    gitOrThrow(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSrc, 'nested'], { cwd: repoDir });
    gitOrThrow(['commit', '-m', 'add nested submodule'], { cwd: repoDir });

    fs.writeFileSync(path.join(subSrc, 'f.txt'), 'v2\n');
    gitOrThrow(['add', 'f.txt'], { cwd: subSrc });
    gitOrThrow(['commit', '-m', 'v2'], { cwd: subSrc });
    gitOrThrow(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--remote', '--', 'nested'], { cwd: repoDir });
  }

  test('commit-to-subrepo records a bumped nested submodule under diff.ignoreSubmodules=all', () => {
    rootDir = createTempGitProject();
    fs.writeFileSync(
      path.join(rootDir, '.planning', 'config.json'),
      JSON.stringify({ planning: { sub_repos: ['backend'] } }, null, 2),
    );
    const subDir = path.join(rootDir, 'backend');
    fs.mkdirSync(subDir, { recursive: true });
    gitOrThrow(['init', '-q', '.'], { cwd: subDir });
    gitOrThrow(['config', 'user.email', 't@t'], { cwd: subDir });
    gitOrThrow(['config', 'user.name', 't'], { cwd: subDir });
    fs.writeFileSync(path.join(subDir, 'seed.js'), '// seed\n');
    gitOrThrow(['add', 'seed.js'], { cwd: subDir });
    gitOrThrow(['commit', '-m', 'seed'], { cwd: subDir });

    bumpedSubmoduleIn(subDir);
    gitOrThrow(['config', 'diff.ignoreSubmodules', 'all'], { cwd: subDir });
    const before = gitOrThrow(['rev-parse', 'HEAD:nested'], { cwd: subDir }).trim();

    const res = runGsdTools(
      ['commit-to-subrepo', 'chore: bump nested submodule', '--files', 'backend/nested'],
      rootDir,
    );
    assert.ok(res.success, `commit-to-subrepo failed: ${res.error}`);
    const result = JSON.parse(res.output);

    assert.strictEqual(result.repos.backend.committed, true,
      `the gitlink moved and \`git commit -- nested\` records it on git 2.39.5 only with the ` +
      `GIT_CONFIG_* override applied, got ${JSON.stringify(result.repos.backend)}`);
    assert.notStrictEqual(result.repos.backend.reason, 'error');
    assert.notStrictEqual(
      gitOrThrow(['rev-parse', 'HEAD:nested'], { cwd: subDir }).trim(), before,
      'the recorded gitlink must actually advance');
  });

  test('pr-subrepo records a bumped nested submodule under diff.ignoreSubmodules=all', () => {
    rootDir = createTempGitProject();
    fs.writeFileSync(
      path.join(rootDir, '.planning', 'config.json'),
      JSON.stringify({ planning: { sub_repos: ['backend'] } }, null, 2),
    );
    const subDir = path.join(rootDir, 'backend');
    const bareDir = path.join(rootDir, '_bare-backend.git');
    fs.mkdirSync(subDir, { recursive: true });
    gitOrThrow(['init', '-q', '.'], { cwd: subDir });
    gitOrThrow(['config', 'user.email', 't@t'], { cwd: subDir });
    gitOrThrow(['config', 'user.name', 't'], { cwd: subDir });
    fs.writeFileSync(path.join(subDir, 'seed.js'), '// seed\n');
    gitOrThrow(['add', 'seed.js'], { cwd: subDir });
    gitOrThrow(['commit', '-m', 'seed'], { cwd: subDir });
    fs.mkdirSync(bareDir, { recursive: true });
    gitOrThrow(['init', '--bare', '-q'], { cwd: bareDir });
    gitOrThrow(['remote', 'add', 'origin', bareDir], { cwd: subDir });
    const branch = gitOrThrow(['branch', '--show-current'], { cwd: subDir }).trim();
    gitOrThrow(['push', 'origin', branch], { cwd: subDir });

    bumpedSubmoduleIn(subDir);
    gitOrThrow(['config', 'diff.ignoreSubmodules', 'all'], { cwd: subDir });
    const before = gitOrThrow(['rev-parse', 'HEAD:nested'], { cwd: subDir }).trim();

    const res = runGsdTools(
      ['query', 'pr-subrepo', 'fix(backend): bump nested submodule',
       '--repo', 'backend', '--branch', 'fix-3859-nested-submodule-pr'],
      rootDir,
    );
    assert.ok(res.success, `pr-subrepo failed: ${res.error}`);
    const result = JSON.parse(res.output);

    assert.strictEqual(result.committed, true,
      `the gitlink moved and \`git commit -- nested\` records it on git 2.39.5 only with the ` +
      `GIT_CONFIG_* override applied, got ${JSON.stringify(result)}`);
    assert.notStrictEqual(
      gitOrThrow(['rev-parse', 'HEAD:nested'], { cwd: subDir }).trim(), before,
      'the recorded gitlink must actually advance');
  });
});

describe('#2279: map-codebase date stamp instructions overwrite existing dates', () => {
  const REPO_ROOT = path.join(__dirname, '..');

  test('codebase-mapper agent says to SET date stamps, overwriting existing values', () => {
    const content = fs.readFileSync(
      path.join(REPO_ROOT, 'agents', 'gsd-codebase-mapper.md'), 'utf-8'
    );
    assert.match(content, /overwriting whatever date is already there/i,
      'must instruct the agent to SET date stamps unconditionally, not just replace [YYYY-MM-DD] placeholders');
  });

  test('map-codebase workflow spawn prompts say to SET date stamps, not replace placeholders', () => {
    const content = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'workflows', 'map-codebase.md'), 'utf-8'
    );
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored workflow markdown, bounded prose, not adversarial input
    const stampLines = content.match(/Set all date stamps[^\r\n]*/g) || [];
    assert.ok(stampLines.length >= 4,
      `must have ≥4 "Set all date stamps" instructions (4 spawn prompts + 1 sequential); got ${stampLines.length}`);
  });

  test('map-codebase sequential path says to SET date stamps overwriting existing dates', () => {
    const content = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'workflows', 'map-codebase.md'), 'utf-8'
    );
    const idx = content.indexOf('overwriting any existing date');
    assert.notEqual(idx, -1,
      'workflow must instruct agents to overwrite existing dates, not just replace [YYYY-MM-DD] placeholders');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT.GENERATIVE-FIX parity guard: HOST_COMMAND_ROUTERS vs TOP_LEVEL_USAGE
// vs SKIP_ROOT_RESOLUTION (#2928 S9)
//
// gsd-tools.cjs's query-command surface is declared across THREE
// independently hand-maintained sites in the same file with no prior parity
// gate between them: the dispatch table (HOST_COMMAND_ROUTERS), the
// `--help` command list (TOP_LEVEL_USAGE), and the project-root-skip list
// (SKIP_ROOT_RESOLUTION). Nothing previously caught a command being wired
// into the dispatch table but omitted from the help string (or vice versa)
// — exactly the generative-fix-divergence shape CLAUDE.md's
// "Generative Fix Divergence" anti-pattern names ("add a parity assertion
// test that fails if the shared constants/arrays/parsers diverge").
//
// This is a STRUCTURAL comparison against the exported constants, not a
// source-text/string-match test, so it stays correct across reformatting
// and is immune to the no-source-grep concern.
// ─────────────────────────────────────────────────────────────────────────────
describe('gsd-tools.cjs dispatch/help/skip-list parity (DEFECT.GENERATIVE-FIX, #2928 S9)', () => {
  const { HOST_COMMAND_ROUTERS, TOP_LEVEL_USAGE, skipsRootResolution } = require('../gsd-core/bin/gsd-tools.cjs');

  // Parse the "Commands: a, b, c\n\nGlobal flags:" line out of the usage
  // string rather than hardcoding a copy of it here — this test must fail
  // when the two sites diverge, not silently pass because it re-embeds its
  // own stale expectation.
  function parseHelpCommandNames(usage) {
    const match = usage.match(/Commands: ([\s\S]*?)\n\nGlobal flags:/);
    assert.ok(match, 'TOP_LEVEL_USAGE must contain a "Commands: ...\\n\\nGlobal flags:" block');
    return match[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  test('every HOST_COMMAND_ROUTERS entry is listed in the --help command string', () => {
    const helpNames = new Set(parseHelpCommandNames(TOP_LEVEL_USAGE));
    const missing = Object.keys(HOST_COMMAND_ROUTERS).filter((name) => !helpNames.has(name));
    assert.deepEqual(
      missing,
      [],
      `command(s) registered in HOST_COMMAND_ROUTERS but missing from TOP_LEVEL_USAGE's ` +
      `"Commands:" list: ${missing.join(', ')}`,
    );
  });

  test('context-predicates is registered in all three hand-maintained sites', () => {
    // Concrete regression pin for the command this parity test was added
    // alongside (#2928 S9) — a generic diff-based assertion alone would not
    // fail if ALL THREE sites were missing an entry simultaneously.
    assert.ok(
      Object.prototype.hasOwnProperty.call(HOST_COMMAND_ROUTERS, 'context-predicates'),
      'context-predicates must be registered in HOST_COMMAND_ROUTERS',
    );
    assert.ok(
      parseHelpCommandNames(TOP_LEVEL_USAGE).includes('context-predicates'),
      'context-predicates must be listed in TOP_LEVEL_USAGE',
    );
    assert.ok(
      skipsRootResolution('context-predicates'),
      'context-predicates must be in SKIP_ROOT_RESOLUTION (it is a pure repo-root CONTEXT.md ' +
      'read, like prompt-budget, and must work with no .planning/ directory present)',
    );
  });

  test('SKIP_ROOT_RESOLUTION is not exported as a mutable live Set (DEFECT.MUTABLE-EXPORTED-SET, #2928)', () => {
    const gsdTools = require('../gsd-core/bin/gsd-tools.cjs');
    assert.equal(
      gsdTools.SKIP_ROOT_RESOLUTION,
      undefined,
      'the live Set must not be exported directly — only the read-only skipsRootResolution() predicate',
    );
    assert.equal(typeof gsdTools.skipsRootResolution, 'function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveMainWorktreeCwd — #3050: gsd-tools must surface (not silently
// swallow) a git_timed_out worktree-root resolution, since writing planning
// artifacts to the wrong tree is the exact fail-open the issue names.
// ─────────────────────────────────────────────────────────────────────────────
describe('gsd-tools.cjs resolveMainWorktreeCwd (#3050)', () => {
  const { resolveMainWorktreeCwd } = require('../gsd-core/bin/gsd-tools.cjs');

  test('emits a WARNING to stderr and still resolves the fallback root on git_timed_out', () => {
    const warnings = [];
    const resolved = resolveMainWorktreeCwd('/repo/wt', {
      existsSync: () => false,
      resolveWorktreeRoot: () => ({ root: '/repo/wt', reason: 'git_timed_out' }),
      writeWarning: (msg) => warnings.push(msg),
    });
    assert.equal(resolved, '/repo/wt');
    assert.equal(warnings.length, 1, 'must emit exactly one warning on git_timed_out');
    assert.match(warnings[0], /git timed out/i);
    assert.match(warnings[0], /wrong tree/i);
  });

  test('does NOT warn on a benign reason (linked_worktree)', () => {
    const warnings = [];
    const resolved = resolveMainWorktreeCwd('/repo/wt', {
      existsSync: () => false,
      resolveWorktreeRoot: () => ({ root: '/repo', reason: 'linked_worktree' }),
      writeWarning: (msg) => warnings.push(msg),
    });
    assert.equal(resolved, '/repo');
    assert.deepEqual(warnings, [], 'must not warn for a benign, definitive resolution');
  });

  test('does NOT warn on a benign reason (not_git_repo)', () => {
    const warnings = [];
    const resolved = resolveMainWorktreeCwd('/repo/wt', {
      existsSync: () => false,
      resolveWorktreeRoot: () => ({ root: '/repo/wt', reason: 'not_git_repo' }),
      writeWarning: (msg) => warnings.push(msg),
    });
    assert.equal(resolved, '/repo/wt');
    assert.deepEqual(warnings, []);
  });

  test('short-circuits (never calls resolveWorktreeRoot) when .planning already exists in cwd', () => {
    const resolved = resolveMainWorktreeCwd('/repo/wt', {
      existsSync: () => true,
      resolveWorktreeRoot: () => { throw new Error('must not be called when .planning exists locally'); },
      writeWarning: () => { throw new Error('must not warn when short-circuited'); },
    });
    assert.equal(resolved, '/repo/wt');
  });
});

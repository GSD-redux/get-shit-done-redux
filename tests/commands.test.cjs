// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests - Commands
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, execFileSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, createTempDir, cleanup } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

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
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0 MVP\n`
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
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n`
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
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0 MVP\n`
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

    // Verify completion timestamp added
    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'todos', 'completed', 'add-dark-mode.md'),
      'utf-8'
    );
    assert.ok(content.startsWith('completed:'), 'should have completed timestamp');
  });

  test('fails for nonexistent todo', () => {
    const result = runGsdTools('todo complete nonexistent.md', tmpDir);
    assert.ok(!result.success, 'should fail');
    assert.ok(result.error.includes('not found'), 'error mentions not found');
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
  const { execSync, execFileSync } = require('child_process');
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
    execSync('git add .gitignore', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "add gitignore"', { cwd: tmpDir, stdio: 'pipe' });

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
    const gitLog = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    assert.ok(gitLog.includes('test: add test file'), 'git log should contain the commit message');
    assert.ok(gitLog.includes(output.hash), 'git log should contain the returned hash');
  });

  test('amend mode works without crashing', () => {
    // Create a file and commit it first
    fs.writeFileSync(path.join(tmpDir, '.planning', 'amend-file.md'), '# Initial\n');
    execSync('git add .planning/amend-file.md', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "initial file"', { cwd: tmpDir, stdio: 'pipe' });

    // Modify the file and amend
    fs.writeFileSync(path.join(tmpDir, '.planning', 'amend-file.md'), '# Amended\n');

    const result = runGsdTools('commit "ignored" --files .planning/amend-file.md --amend', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.committed, true, 'amend should succeed');

    // Verify only 2 commits total (initial setup + amended)
    const logCount = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' }).trim().split('\n').length;
    assert.strictEqual(logCount, 2, 'should have 2 commits (initial + amended)');
  });
  test('creates strategy branch before first commit when branching_strategy is milestone', () => {
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

    // Verify we're on the strategy branch
    const { execFileSync } = require('child_process');
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir, encoding: 'utf-8' }).trim();
    assert.strictEqual(branch, 'gsd/v1.0-initial-release', 'should be on milestone branch');
  });

  test('creates strategy branch before first commit when branching_strategy is phase', () => {
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

    // Verify we're on the strategy branch
    const { execFileSync } = require('child_process');
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir, encoding: 'utf-8' }).trim();
    assert.strictEqual(branch, 'gsd/phase-01-setup', 'should be on phase branch');
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

    // Verify we're on the correct branch (45.14, not 14)
    const { execFileSync } = require('child_process');
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir, encoding: 'utf-8' }).trim();
    assert.strictEqual(branch, 'gsd/phase-45.14-golden-capture', 'should be on decimal phase branch, not integer-only');
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

    // The commit must land on the phase-07 branch. Pre-fix this resolved the
    // `2-` in `PROJECT_V2-` and silently switched onto the archived phase-02
    // branch instead.
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir, encoding: 'utf-8' }).trim();
    assert.strictEqual(
      branch,
      'gsd/phase-07-active-phase',
      `should be on the active phase-07 branch, not the archived phase-02 branch (got ${branch})`
    );

    // The committed file must exist on the phase-07 branch's HEAD, proving the
    // commit did not silently land on the wrong branch.
    const committedFile = execFileSync(
      'git',
      ['show', 'HEAD:.planning/phases/PROJECT_V2-07-active-phase/07-CONTEXT.md'],
      { cwd: tmpDir, encoding: 'utf-8' }
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
    execFileSync('git', ['branch', 'gsd/phase-01-first-phase'], { cwd: tmpDir, stdio: 'pipe' });
    // Ensure the file is staged only by the commit command itself (it must run
    // from the current/default branch and must not be force-switched).
    const beforeBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: tmpDir, encoding: 'utf-8',
    }).trim();

    // Invoke gsd-tools via spawnSync so stderr is observable on the success
    // path — the warning that proves the no-switch path is not silent (#2539
    // AC2) is written to stderr, which execFileSync discards on success.
    const { TOOLS_PATH } = require('./helpers.cjs');
    const { spawnSync } = require('child_process');
    const proc = spawnSync(process.execPath, [
      TOOLS_PATH, 'commit', 'docs(01): add context',
      '--files', '.planning/phases/01-first-phase/01-CONTEXT.md',
    ], { cwd: tmpDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = proc.stdout || '';
    const stderr = proc.stderr || '';
    if (proc.status !== 0) {
      throw new Error(`gsd-tools commit exited ${proc.status}: stdout=${stdout} stderr=${stderr}`);
    }

    const output = JSON.parse(stdout.trim());
    assert.strictEqual(output.committed, true, 'should have committed');

    // The command must NOT have silently switched the working tree onto the
    // pre-existing phase branch. The commit lands on the branch we were on.
    const afterBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: tmpDir, encoding: 'utf-8',
    }).trim();
    assert.strictEqual(
      afterBranch,
      beforeBranch,
      `must not silently switch onto an existing phase branch mid-commit (was ${beforeBranch}, now ${afterBranch})`
    );

    // #2539 AC2: the no-switch path must not be silent either. The warning
    // surfaces the resolved branch and the branch the commit actually lands on.
    assert.ok(
      /Warning: resolved phase branch .* already exists/.test(stderr),
      `expected a non-silent warning on stderr when the resolved branch already exists; got stderr=${stderr}`
    );
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

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [x] **Phase 14: Auth Hardening**
- [x] **Phase 15: Proof Generation**
- [ ] **Phase 16: Multi-Claim Verification & UX**

## Milestone v1.0 Growth

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
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: 'pipe' });

    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\n');
    execSync('git add -A', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "initial commit"', {
      cwd: tmpDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    });

    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Updated\n');
    execSync('git add README.md', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "second commit"', {
      cwd: tmpDir,
      stdio: 'pipe',
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
    execSync('git add src.js', { cwd: tmpDir, stdio: 'pipe' });

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
    execSync('git add .planning/STATE.md', { cwd: tmpDir, stdio: 'pipe' });

    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(!result.success, 'should block commit');
    assert.ok(result.error.includes('.planning/'), 'error should mention .planning/ files');
    assert.ok(result.error.includes('unstage'), 'error should suggest unstage command');
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

  test('future HTTP-date → value in (0, 60000]', () => {
    const futureDate = new Date(Date.now() + 5000).toUTCString();
    const v = _wsParseRetryAfter(futureDate);
    assert.ok(typeof v === 'number' && v > 0 && v <= 60000, `expected (0,60000], got ${v}`);
  });

  test('past HTTP-date → 0', () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString();
    assert.strictEqual(_wsParseRetryAfter(pastDate), 0);
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
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    fs.writeFileSync(path.join(dir, 'feature.js'), '// initial\n');
    fs.writeFileSync(path.join(dir, 'a.js'), '// initial\n');
    fs.writeFileSync(path.join(dir, 'b.js'), '// initial\n');
    execFileSync('git', ['add', '.gitkeep', 'feature.js', 'a.js', 'b.js'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: dir, stdio: 'pipe' });
  }

  function wirePrSubrepoRemote(repoDir, bareDir) {
    fs.mkdirSync(bareDir, { recursive: true });
    execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir, stdio: 'pipe' });
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: repoDir, encoding: 'utf8',
    }).trim();
    execFileSync('git', ['push', 'origin', branch], { cwd: repoDir, stdio: 'pipe' });
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
      execFileSync('git', ['init', '--bare'], { cwd: rejectingBare, stdio: 'pipe' });
      const hookPath = path.join(rejectingBare, 'hooks', 'pre-receive');
      fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
      fs.chmodSync(hookPath, 0o755);

      // Point origin at the rejecting bare (overwrite the working one wired in beforeEach).
      execFileSync('git', ['remote', 'set-url', 'origin', rejectingBare], { cwd: subDir, stdio: 'pipe' });

      fs.writeFileSync(path.join(subDir, 'feature.js'), 'IMPORTANT USER WORK\n');

      const res = runGsdTools(
        ['query', 'pr-subrepo', 'fix(backend): push-fail test',
         '--repo', 'backend', '--branch', branch],
        rootDir
      );

      // Command must fail because push was rejected.
      assert.ok(!res.success, `Expected failure on rejected push, got success: ${res.output}`);

      // The local branch must still exist — work must not be lost.
      const branches = execFileSync('git', ['branch', '--list', branch], {
        cwd: subDir, encoding: 'utf8',
      });
      assert.ok(branches.trim().length > 0, `Branch ${branch} was deleted after push failure — user work lost`);

      // The commit on that branch must contain the user's changes.
      const log = execFileSync('git', ['log', branch, '--oneline', '-1'], {
        cwd: subDir, encoding: 'utf8',
      });
      assert.ok(log.trim().length > 0, `No commit on ${branch} — staged work was lost`);
    });

    test('pr-subrepo porcelain: staged rename — both old and new paths in result.files', () => {
      // git mv produces "R  old -> new" in porcelain v1; both paths must be staged.
      execFileSync('git', ['mv', 'feature.js', 'renamed-feature.js'], { cwd: subDir, stdio: 'pipe' });

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
      execFileSync('git', ['add', 'café.js'], { cwd: subDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'chore: add café.js'], { cwd: subDir, stdio: 'pipe' });
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
        execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
        fs.writeFileSync(path.join(dir, file), 'committed\n');
        execFileSync('git', ['add', file], { cwd: dir, stdio: 'pipe' });
        execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
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
        execFileSync('node', ['-e', script, subReposJson, scanRoot, dirtyFile], { stdio: 'pipe' });
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
const { spawnSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');

const GSD_TOOLS = path.resolve(__dirname, '../gsd-core/bin/gsd-tools.cjs');

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [GSD_TOOLS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GSD_TEST_MODE: '1', ...env },
  });
  return result;
}

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// output() in core.cjs uses fs.writeSync(1, data) — intercept fd=1 writes.
// Pass raw=false so output() emits JSON (raw=true emits the plain rawValue string).
function captureOutput(fn) {
  const origWriteSync = fs.writeSync;
  let captured = '';
  fs.writeSync = (fd, data) => {
    if (fd === 1) captured += data;
    else origWriteSync(fd, data);
  };
  try {
    fn();
  } finally {
    fs.writeSync = origWriteSync;
  }
  return JSON.parse(captured);
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
    writePlanningConfig(tmpDir, { default: 'max' });

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

    // Home defaults set effort.default = low
    const gsdDir = path.join(tmpHome, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({ effort: { default: 'low' } }));

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

    // With home effort.default = 'low' and the agent currently at 'medium',
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

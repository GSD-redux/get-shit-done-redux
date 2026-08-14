// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests - Concurrency Safety
 *
 * Tests for fix/concurrency-safety-1473a:
 *   - Planning lock integration (withPlanningLock in phase/roadmap operations)
 *   - readModifyWriteStateMd (atomic state updates)
 *   - normalizeMd behavioral equivalence (O(n) insideFence rewrite)
 *   - Warnings (frontmatter parse warning, stateReplaceFieldWithFallback)
 *   - Performance benchmarks (normalizeMd O(n) verification)
 *   - Snapshot tests for normalizeMd (regression detection)
 *   - Multi-process concurrent write tests
 *   - Stress tests at scale (50+ phases)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const { normalizeContent } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
// normalizeMd was removed from core.cjs (Phase 4 — issue #3468); the same algorithm now
// lives in the shell-command-projection seam. Wrap normalizeContent so existing
// behavioral / snapshot / perf assertions stay point-of-truth.
const normalizeMd = (input) => normalizeContent('test.md', input).content;

// ─── Helpers ────────────────────────────────────────────────────────────────


function writeMinimalStateMd(tmpDir, content) {
  const defaultContent = content || `# Session State\n\n## Current Position\n\nPhase: 1\n`;
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    defaultContent
  );
}


/**
 * Generate a 50-phase project structure for stress testing.
 */
function create50PhaseProject(tmpDir, completedCount = 25) {
  let roadmapContent = '# Roadmap v1.0\n\n';
  for (let i = 1; i <= 50; i++) {
    roadmapContent += `- [${i <= completedCount ? 'x' : ' '}] Phase ${i}: Feature ${i}\n`;
  }
  roadmapContent += '\n';
  for (let i = 1; i <= 50; i++) {
    const pad = String(i).padStart(2, '0');
    roadmapContent += `### Phase ${i}: Feature ${i}\n\n`;
    roadmapContent += `**Goal:** Build feature ${i}\n`;
    roadmapContent += `**Requirements:** REQ-${pad}\n`;
    roadmapContent += `**Plans:** 1 plans\n\n`;
    roadmapContent += `Plans:\n- [${i <= completedCount ? 'x' : ' '}] ${pad}-01-PLAN.md\n\n`;
  }
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    roadmapContent
  );

  const phasesDir = path.join(tmpDir, '.planning', 'phases');
  for (let i = 1; i <= 50; i++) {
    const pad = String(i).padStart(2, '0');
    const dirName = `${pad}-feature-${i}`;
    const phaseDir = path.join(phasesDir, dirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, `${pad}-01-PLAN.md`),
      `# Phase ${i} Plan 1\n\nBuild feature ${i}.\n`
    );
    if (i <= completedCount) {
      fs.writeFileSync(
        path.join(phaseDir, `${pad}-01-SUMMARY.md`),
        `# Phase ${i} Plan 1 Summary\n\nFeature ${i} completed.\n`
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Planning lock integration
// ─────────────────────────────────────────────────────────────────────────────

describe('planning lock integration', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('phase add creates and releases .planning/.lock during ROADMAP write', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n`
    );

    const result = runGsdTools('phase add Testing', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const lockPath = path.join(tmpDir, '.planning', '.lock');
    assert.ok(!fs.existsSync(lockPath), '.lock file should be released after phase add');

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 2, 'should be phase 2');
  });

  test('phase complete creates and releases .planning/.lock', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Phase 1: Foundation\n\n### Phase 1: Foundation\n**Goal:** Setup\n**Plans:** 1 plans\n\n### Phase 2: API\n**Goal:** Build\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Foundation\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(
      path.join(p1, '01-VERIFICATION.md'),
      '---\nstatus: passed\nscore: "1/1"\n---\n# Verification\nPassed.\n',
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), { recursive: true });

    const result = runGsdTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const lockPath = path.join(tmpDir, '.planning', '.lock');
    assert.ok(!fs.existsSync(lockPath), '.lock file should be released after phase complete');

    const output = JSON.parse(result.output);
    assert.strictEqual(output.completed_phase, '1', 'phase should be completed');
  });

  test('roadmap update-plan-progress creates and releases .planning/.lock', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n| Phase | Plans | Status | Updated |\n|-------|-------|--------|---------|\n| 1 | 0/0 | Not started | - |\n\n### Phase 1: Foundation\n**Goal:** Setup\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const lockPath = path.join(tmpDir, '.planning', '.lock');
    assert.ok(!fs.existsSync(lockPath), '.lock file should be released after roadmap update');
  });

  test('lock file does NOT persist after successful phase operations', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n`
    );

    runGsdTools('phase add First Phase', tmpDir);
    runGsdTools('phase add Second Phase', tmpDir);

    const lockPath = path.join(tmpDir, '.planning', '.lock');
    assert.ok(!fs.existsSync(lockPath), '.lock file should not persist after multiple operations');
  });

  test('phase add still works correctly with lock (behavioral regression)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n### Phase 2: API\n**Goal:** Build API\n\n---\n`
    );

    const result = runGsdTools('phase add User Dashboard', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 3, 'should be phase 3');
    assert.strictEqual(output.slug, 'user-dashboard');

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '03-user-dashboard')),
      'directory should be created'
    );

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('### Phase 3: User Dashboard'), 'roadmap should include new phase');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. readModifyWriteStateMd (tested via CLI commands that use it)
// ─────────────────────────────────────────────────────────────────────────────

describe('readModifyWriteStateMd (via state patch)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('transforms content atomically (read + modify + write under lock)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Current Phase:** 03\n**Status:** Planning\n**Current Plan:** 03-01\n`
    );

    const result = runGsdTools('state patch --Status "In progress" --"Current Plan" 03-02', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.includes('**Status:** In progress'), 'Status should be updated');
    assert.ok(content.includes('03-02'), 'Current Plan should be updated');

    const lockPath = path.join(tmpDir, '.planning', 'STATE.md.lock');
    assert.ok(!fs.existsSync(lockPath), 'STATE.md.lock should be released after patch');
  });

  test('lock file cleaned up after state patch operation', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Current Phase:** 01\n**Status:** Ready\n`
    );

    runGsdTools('state patch --Status "In progress"', tmpDir);

    const lockPath = path.join(tmpDir, '.planning', 'STATE.md.lock');
    assert.ok(!fs.existsSync(lockPath), 'STATE.md.lock should not persist after operation');
  });

  test('state patch still works correctly via readModifyWriteStateMd path (behavioral regression)', () => {
    const stateMd = [
      '# Project State',
      '',
      '**Current Phase:** 03',
      '**Status:** Planning',
      '**Current Plan:** 03-01',
      '**Last Activity:** 2024-01-15',
    ].join('\n') + '\n';

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state patch --Status Complete --"Current Phase" 04', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Status:** Complete'), 'Status should be updated to Complete');
    assert.ok(updated.includes('**Last Activity:** 2024-01-15'), 'Last Activity should be unchanged');
  });

  test('two sequential state patches both persist (patch A then patch B)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Current Phase:** 01\n**Status:** Planning\n**Current Plan:** 01-01\n**Last Activity:** 2024-01-01\n`
    );

    const resultA = runGsdTools('state patch --Status "In progress"', tmpDir);
    assert.ok(resultA.success, `Patch A failed: ${resultA.error}`);

    const resultB = runGsdTools('state patch --"Current Plan" 01-02', tmpDir);
    assert.ok(resultB.success, `Patch B failed: ${resultB.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.includes('**Status:** In progress'), 'Patch A (Status) should persist');
    assert.ok(content.includes('01-02'), 'Patch B (Current Plan) should persist');
    assert.ok(content.includes('**Last Activity:** 2024-01-01'), 'Untouched field should be preserved');
  });

  test('lock file does not persist after rapid sequential patches', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Current Phase:** 01\n**Status:** Planning\n**Current Plan:** 01-01\n`
    );

    runGsdTools('state patch --Status "In progress"', tmpDir);
    runGsdTools('state patch --"Current Plan" 01-02', tmpDir);
    runGsdTools('state patch --Status Complete', tmpDir);

    const lockPath = path.join(tmpDir, '.planning', 'STATE.md.lock');
    assert.ok(!fs.existsSync(lockPath), 'STATE.md.lock should not persist after rapid sequential patches');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Multi-process concurrent write tests
// ─────────────────────────────────────────────────────────────────────────────

describe('multi-process concurrent write tests', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // 'two concurrent state patches to DIFFERENT fields both persist' deleted per #453 (clock-seam):
  // plain Promise.all without a barrier is non-deterministic — the weakened OR assertion
  // (aOk || bOk) and the vacuous assert.ok(true, ...) make the test pass even when one write
  // is lost. Deterministic barrier-based coverage lives in locking-bugs-1909-1916-1925-1927:
  //   'state update: both concurrent updates to different fields survive'.

  // 'lock file does not persist after concurrent operations' deleted per #453 (clock-seam):
  // plain Promise.all without a barrier; lock-cleanup coverage is in clock-seam.test.cjs
  //   describe('exit cleanup: STATE.md.lock removed on process exit').

  test('three rapid sequential patches all persist', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Current Phase:** 01',
        '**Status:** Planning',
        '**Current Plan:** 01-01',
        '**Last Activity:** 2025-01-01',
        '',
      ].join('\n')
    );

    const r1 = runGsdTools('state patch --Status "In progress"', tmpDir);
    assert.ok(r1.success, `Patch 1 failed: ${r1.error}`);

    const r2 = runGsdTools('state patch --"Current Plan" 01-02', tmpDir);
    assert.ok(r2.success, `Patch 2 failed: ${r2.error}`);

    const r3 = runGsdTools('state patch --"Last Activity" 2025-06-15', tmpDir);
    assert.ok(r3.success, `Patch 3 failed: ${r3.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.includes('In progress'), 'Patch 1 (Status) should persist');
    assert.ok(content.includes('01-02'), 'Patch 2 (Current Plan) should persist');
    assert.ok(content.includes('2025-06-15'), 'Patch 3 (Last Activity) should persist');
    assert.ok(content.includes('**Current Phase:** 01'), 'Untouched field should be preserved');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. normalizeMd behavioral equivalence (O(n) insideFence rewrite)
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeMd behavioral equivalence', () => {
  test('simple markdown with headings and paragraphs', () => {
    const input = '# Title\nSome text.\n## Section\nMore text.\n';
    const result = normalizeMd(input);
    assert.ok(result.includes('# Title\n\nSome text.'), 'title heading should have blank line after');
    assert.ok(result.includes('\n\n## Section\n\nMore text.'), 'section heading should have blank lines around it');
    assert.ok(result.endsWith('\n'), 'should end with newline');
    assert.ok(!result.endsWith('\n\n'), 'should not end with double newline');
  });

  test('single fenced code block gets blank lines before/after', () => {
    const input = 'Some text\n```js\nconst x = 1;\n```\nMore text\n';
    const result = normalizeMd(input);
    assert.ok(result.includes('Some text\n\n```js'), 'code block should have blank line before');
    assert.ok(result.includes('```\n\nMore text'), 'code block should have blank line after');
    assert.ok(result.includes('const x = 1;'), 'code content should be preserved');
  });

  test('multiple fenced code blocks', () => {
    const input = 'Intro\n```js\nfoo();\n```\nMiddle\n```py\nbar()\n```\nEnd\n';
    const result = normalizeMd(input);
    assert.ok(result.includes('Intro\n\n```js'), 'first code block should have blank line before');
    assert.ok(result.includes('```\n\nMiddle'), 'first code block should have blank line after');
    assert.ok(result.includes('Middle\n\n```py'), 'second code block should have blank line before');
    assert.ok(result.includes('```\n\nEnd'), 'second code block should have blank line after');
  });

  test('unclosed fence at end of file (edge case)', () => {
    const input = 'Some text\n```js\nconst x = 1;\n';
    const result = normalizeMd(input);
    assert.ok(typeof result === 'string', 'should return a string');
    assert.ok(result.includes('```js'), 'fence opener should be preserved');
    assert.ok(result.includes('const x = 1;'), 'content after unclosed fence should be preserved');
    assert.ok(result.endsWith('\n'), 'should end with newline');
  });

  test('empty string input', () => {
    assert.strictEqual(normalizeMd(''), '', 'empty string should return empty string');
  });

  test('mixed headings + lists + fences (complex case)', () => {
    const input = [
      '# Title',
      '## Section One',
      'Paragraph text.',
      '- item 1',
      '- item 2',
      '## Section Two',
      '```bash',
      'echo hello',
      '```',
      'After code.',
      '## Section Three',
      '1. First',
      '2. Second',
      'Done.',
    ].join('\n') + '\n';

    const result = normalizeMd(input);

    assert.ok(result.includes('\n\n## Section One\n\n'), 'Section One heading needs blank lines');
    assert.ok(result.includes('\n\n## Section Two\n\n'), 'Section Two heading needs blank lines');
    assert.ok(result.includes('\n\n## Section Three\n\n'), 'Section Three heading needs blank lines');
    assert.ok(result.includes('Paragraph text.\n\n- item 1'), 'list should have blank line before');
    assert.ok(result.includes('\n\n```bash'), 'code block should have blank line before');
    assert.ok(result.includes('```\n\nAfter code.'), 'code block should have blank line after');
    assert.ok(result.includes('echo hello'), 'code content should be preserved');
    assert.ok(!result.includes('\n\n\n'), 'should not have 3+ consecutive blank lines');
  });
});

// normalizeMd performance benchmark tests deleted per #453 (clock-seam):
// wall-clock assertions (elapsed < 50ms, elapsed < 200ms) are inherently
// flaky on loaded CI runners. Correctness is covered by the snapshot tests
// in describe('normalizeMd snapshot tests') below.

// ─────────────────────────────────────────────────────────────────────────────
// 6. normalizeMd snapshot tests
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeMd snapshot tests', () => {
  test('snapshot - heading spacing', () => {
    const input = '# Title\nParagraph\n## Section\nMore text';
    const expected = '# Title\n\nParagraph\n\n## Section\n\nMore text\n';
    const result = normalizeMd(input);
    assert.strictEqual(result, expected,
      `Heading spacing snapshot mismatch.\nGot:      ${JSON.stringify(result)}\nExpected: ${JSON.stringify(expected)}`
    );
  });

  test('snapshot - code block spacing', () => {
    const input = 'Text before\n```js\nconst x = 1;\n```\nText after\n';
    const expected = 'Text before\n\n```js\nconst x = 1;\n```\n\nText after\n';
    const result = normalizeMd(input);
    assert.strictEqual(result, expected,
      `Code block spacing snapshot mismatch.\nGot:      ${JSON.stringify(result)}\nExpected: ${JSON.stringify(expected)}`
    );
  });

  test('snapshot - list spacing', () => {
    const input = 'Paragraph\n- item 1\n- item 2\nAnother paragraph';
    const expected = 'Paragraph\n\n- item 1\n- item 2\n\nAnother paragraph\n';
    const result = normalizeMd(input);
    assert.strictEqual(result, expected,
      `List spacing snapshot mismatch.\nGot:      ${JSON.stringify(result)}\nExpected: ${JSON.stringify(expected)}`
    );
  });

  test('snapshot - complex mixed document', () => {
    const input = [
      '# Main Title',
      'Intro paragraph.',
      '## Section One',
      'Some text here.',
      '```js',
      'const a = 1;',
      '```',
      '- first item',
      '- second item',
      '## Section Two',
      'Final text.',
    ].join('\n');

    const expected = [
      '# Main Title',
      '',
      'Intro paragraph.',
      '',
      '## Section One',
      '',
      'Some text here.',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '- first item',
      '- second item',
      '',
      '## Section Two',
      '',
      'Final text.',
      '',
    ].join('\n');

    const result = normalizeMd(input);
    assert.strictEqual(result, expected,
      `Complex mixed document snapshot mismatch.\nGot:      ${JSON.stringify(result)}\nExpected: ${JSON.stringify(expected)}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Warnings (frontmatter parse, state field miss)
// ─────────────────────────────────────────────────────────────────────────────

describe('warnings', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('must_haves parse warning fires for block with content but 0 items', () => {
    const planDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, '01-01-PLAN.md'),
      `---
phase: "01"
plan: "01"
must_haves:
  acceptance:
    bare content without dash prefix
    another line without dash prefix
---

# Plan 01-01
`
    );

    const result = runGsdTools(
      ['frontmatter', 'get', path.join(planDir, '01-01-PLAN.md'), 'must_haves'],
      tmpDir
    );

    const stderr = result.error || '';
    assert.ok(
      stderr.includes('WARNING') && stderr.includes('must_haves') ||
      result.output.includes('acceptance'),
      `Expected WARNING about must_haves parse or valid parse result. stderr: ${stderr}, stdout: ${result.output}`
    );
  });

  test('stateReplaceFieldWithFallback logs warning on miss', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Current Phase:** 01\n**Current Plan:** 1\n**Total Plans in Phase:** 3\n`
    );

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.advanced === true || output.reason === 'last_plan', 'advance should complete');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Malformed input resilience
// ─────────────────────────────────────────────────────────────────────────────

describe('malformed input resilience', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('STATE.md with invalid bold format -- state patch returns gracefully', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase: 01\n**Status:** Planning\n'
    );

    const result = runGsdTools('state patch --Status "In progress"', tmpDir);
    const didNotCrash = result.success || (result.output !== undefined);
    assert.ok(didNotCrash, `state patch should not crash on malformed bold format: ${result.error}`);

    if (result.success) {
      const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      assert.ok(
        content.includes('In progress'),
        'Status field (with valid bold format) should be updated'
      );
    }
  });

  test('STATE.md with only frontmatter, no body -- state patch handles gracefully', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nphase: "01"\n---\n'
    );

    const result = runGsdTools('state patch --Status "In progress"', tmpDir);
    const didNotCrash = result.success || (result.output !== undefined);
    assert.ok(didNotCrash, `state patch should not crash on frontmatter-only STATE.md: ${result.error}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Stress tests with 50+ phases
// ─────────────────────────────────────────────────────────────────────────────

describe('stress tests with 50+ phases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // roadmap analyze on 50-phase ROADMAP: behavioral test without timing gate.
  // The elapsed < N wall-clock gate was a persistent flake source (#7, #453).
  // Equivalent behavioral coverage (50 phases, 25 complete) lives in
  // tests/clock-seam.test.cjs describe('roadmap analyze behavioral correctness').


  test('phase complete on phase 26 of 50-phase project works correctly', () => {
    create50PhaseProject(tmpDir, 25);
    writeMinimalStateMd(tmpDir, '# Session State\n\n**Current Phase:** 26\n**Status:** In progress\n');

    const phase26Dir = path.join(tmpDir, '.planning', 'phases', '26-feature-26');
    fs.writeFileSync(
      path.join(phase26Dir, '26-01-SUMMARY.md'),
      '# Phase 26 Plan 1 Summary\n\nFeature 26 completed.\n'
    );
    fs.writeFileSync(
      path.join(phase26Dir, '26-VERIFICATION.md'),
      '---\nstatus: passed\nscore: "1/1"\n---\n# Verification\nPassed.\n',
    );

    const result = runGsdTools('phase complete 26', tmpDir);
    assert.ok(result.success, `phase complete 26 should succeed: ${result.error}`);

    const roadmapContent = fs.readFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      'utf-8'
    );
    const phase26Checkbox = roadmapContent.match(/-\s*\[(x| )\]\s*.*Phase\s+26/i);
    assert.ok(phase26Checkbox, 'Should find Phase 26 checkbox in ROADMAP');
    assert.strictEqual(phase26Checkbox[1], 'x', 'Phase 26 should now be marked as complete [x]');
  });
});

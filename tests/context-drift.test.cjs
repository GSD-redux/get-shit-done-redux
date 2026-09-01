'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempGitProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const VERIFY_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'verify.cjs');
const { computeContextDrift } = require(VERIFY_PATH);

describe('computeContextDrift', () => {
  test('returns no stale artifacts when there is nothing to compare', () => {
    assert.deepStrictEqual(computeContextDrift(1000, []), []);
  });

  test('treats a newer upstream artifact as fresh', () => {
    const stale = computeContextDrift(1000, [{ file: '01-RESEARCH.md', effectiveMs: 2000 }]);
    assert.deepStrictEqual(stale, []);
  });

  test('flags an upstream artifact older than CONTEXT.md', () => {
    const stale = computeContextDrift(2000, [{ file: '01-RESEARCH.md', effectiveMs: 1000 }]);
    assert.deepStrictEqual(stale, ['01-RESEARCH.md']);
  });

  test('reports exactly the stale subset, not all entries', () => {
    const stale = computeContextDrift(2000, [
      { file: '01-RESEARCH.md', effectiveMs: 1000 },
      { file: '01-PATTERNS.md', effectiveMs: 3000 },
      { file: '01-VALIDATION.md', effectiveMs: 500 },
    ]);
    assert.deepStrictEqual(stale, ['01-RESEARCH.md', '01-VALIDATION.md']);
  });

  test('treats an equal timestamp as not stale (strict greater-than)', () => {
    const stale = computeContextDrift(2000, [{ file: '01-RESEARCH.md', effectiveMs: 2000 }]);
    assert.deepStrictEqual(stale, []);
  });

  test('flags an artifact exactly one second (1000ms) older', () => {
    const stale = computeContextDrift(2000, [{ file: '01-RESEARCH.md', effectiveMs: 1000 }]);
    assert.deepStrictEqual(stale, ['01-RESEARCH.md']);
  });

  test('treats an artifact exactly one second (1000ms) newer as fresh', () => {
    const stale = computeContextDrift(2000, [{ file: '01-RESEARCH.md', effectiveMs: 3000 }]);
    assert.deepStrictEqual(stale, []);
  });

  test('handles an empty entries array without throwing', () => {
    assert.doesNotThrow(() => computeContextDrift(0, []));
  });

  test('does not throw on a zero or negative timestamp', () => {
    assert.deepStrictEqual(computeContextDrift(0, [{ file: 'a.md', effectiveMs: -5 }]), ['a.md']);
    assert.deepStrictEqual(computeContextDrift(-5, [{ file: 'a.md', effectiveMs: 0 }]), []);
  });
});

describe('verify context-drift CLI', () => {
  let tmp;
  beforeEach(() => {
    tmp = createTempGitProject('gsd-context-drift-cli-');
  });
  afterEach(() => cleanup(tmp));

  function phaseDirPath(name) {
    return path.join(tmp, '.planning', 'phases', name);
  }

  test('errors with usage message on missing phase arg', () => {
    const r = runGsdTools(['verify', 'context-drift'], tmp);
    assert.strictEqual(r.success, false);
    assert.match(r.error || '', /Usage: verify context-drift <phase>/);
  });

  test('treats an empty phase arg as missing', () => {
    const r = runGsdTools(['verify', 'context-drift', ''], tmp);
    assert.strictEqual(r.success, false);
    assert.match(r.error || '', /Usage: verify context-drift <phase>/);
  });

  test('treats a whitespace phase arg as not found, not a usage error', () => {
    const r = runGsdTools(['verify', 'context-drift', '   '], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'phase-not-found');
  });

  test('degrades gracefully for an unresolvable phase', () => {
    const r = runGsdTools(['verify', 'context-drift', '99'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'phase-not-found');
    assert.strictEqual(data.block, false);
  });

  test('does not interpret shell metacharacters in the phase arg', () => {
    const r = runGsdTools(['verify', 'context-drift', '1; echo pwned'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'phase-not-found');
  });

  test('does not path-traverse via a hostile phase arg', () => {
    const r = runGsdTools(['verify', 'context-drift', '../../etc'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'phase-not-found');
  });

  test('skips when no CONTEXT.md exists', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-RESEARCH.md'), '# research\n');
    const r = runGsdTools(['verify', 'context-drift', '01-setup'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'no-context-md');
    assert.strictEqual(data.block, false);
  });

  test('skips when no upstream artifacts exist', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\n');
    const r = runGsdTools(['verify', 'context-drift', '01-setup'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'no-upstream-artifacts');
  });

  test('excludes AI-SPEC.md and UI-SPEC.md from the SPEC.md comparison', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\n');
    fs.writeFileSync(path.join(dir, '01-AI-SPEC.md'), '# ai spec\n');
    fs.writeFileSync(path.join(dir, '01-UI-SPEC.md'), '# ui spec\n');
    const r = runGsdTools(['verify', 'context-drift', '01-setup'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'no-upstream-artifacts');
  });

  test('degrades to mtime comparison outside a git repo', () => {
    const plain = createTempDir('gsd-context-drift-nogit-');
    try {
      const dir = path.join(plain, '.planning', 'phases', '01-setup');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-RESEARCH.md'), '# research\n');
      fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\n');
      const r = runGsdTools(['verify', 'context-drift', '01-setup'], plain);
      assert.strictEqual(r.success, true, r.error);
      const data = JSON.parse(r.output);
      assert.strictEqual(data.skipped, false);
      assert.deepStrictEqual(data.stale_artifacts, ['01-RESEARCH.md']);
    } finally {
      cleanup(plain);
    }
  });

  test('degrades to mtime comparison in a repo with no commits', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-RESEARCH.md'), '# research\n');
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\n');
    const r = runGsdTools(['verify', 'context-drift', '01-setup'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(data.stale_artifacts, ['01-RESEARCH.md']);
  });

  test('fresh RESEARCH.md (committed after CONTEXT.md) is not flagged', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\nD-01\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'context'], { cwd: tmp });
    fs.writeFileSync(path.join(dir, '01-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'research'], { cwd: tmp });
    const r = runGsdTools(['verify', 'context-drift', '01-setup'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(data.stale_artifacts, []);
    assert.strictEqual(data.block, false);
  });

  test('uses mtime, not a stale commit time, for a dirty CONTEXT.md', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\nD-01\n');
    fs.writeFileSync(path.join(dir, '01-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'context+research'], { cwd: tmp });
    fs.appendFileSync(path.join(dir, '01-CONTEXT.md'), 'D-02\n');
    const r = runGsdTools(['verify', 'context-drift', '01-setup'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(data.stale_artifacts, ['01-RESEARCH.md']);
  });

  test('#3348 regression: uncommitted new decisions flag existing RESEARCH and PATTERNS as stale', () => {
    const dir = phaseDirPath('03-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# context\nD-01\nD-02\n...\nD-09\n');
    fs.writeFileSync(path.join(dir, '03-RESEARCH.md'), '# research from D-01..D-09\n');
    fs.writeFileSync(path.join(dir, '03-PATTERNS.md'), '# patterns from D-01..D-09\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'phase 3: context, research, patterns'], { cwd: tmp });
    fs.appendFileSync(path.join(dir, '03-CONTEXT.md'), 'D-10\nD-11\nD-12\nD-13\n');
    const r = runGsdTools(['verify', 'context-drift', '03-feature'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(
      data.stale_artifacts.slice().sort(),
      ['03-PATTERNS.md', '03-RESEARCH.md'],
    );
  });

  test('defaults to warn when config.json is absent', () => {
    const dir = phaseDirPath('03-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# context\n');
    fs.writeFileSync(path.join(dir, '03-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'research'], { cwd: tmp });
    fs.appendFileSync(path.join(dir, '03-CONTEXT.md'), 'D-99\n');
    assert.ok(!fs.existsSync(path.join(tmp, '.planning', 'config.json')));
    const r = runGsdTools(['verify', 'context-drift', '03-feature'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.action, 'warn');
    assert.strictEqual(data.block, false);
  });

  test('defaults to warn when config.json is malformed', () => {
    const dir = phaseDirPath('03-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), '{ not valid json');
    fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# context\n');
    fs.writeFileSync(path.join(dir, '03-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'research'], { cwd: tmp });
    fs.appendFileSync(path.join(dir, '03-CONTEXT.md'), 'D-99\n');
    const r = runGsdTools(['verify', 'context-drift', '03-feature'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.action, 'warn');
    assert.strictEqual(data.block, false);
  });

  test('falls back to warn for an unrecognized context_drift_action value', () => {
    const dir = phaseDirPath('03-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ workflow: { context_drift_action: 'yolo' } }),
    );
    fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# context\n');
    fs.writeFileSync(path.join(dir, '03-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'research'], { cwd: tmp });
    fs.appendFileSync(path.join(dir, '03-CONTEXT.md'), 'D-99\n');
    const r = runGsdTools(['verify', 'context-drift', '03-feature'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.action, 'warn');
    assert.strictEqual(data.block, false);
  });

  test('sets block:true when context_drift_action is block and drift is found', () => {
    const dir = phaseDirPath('03-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ workflow: { context_drift_action: 'block' } }),
    );
    fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# context\n');
    fs.writeFileSync(path.join(dir, '03-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'research'], { cwd: tmp });
    fs.appendFileSync(path.join(dir, '03-CONTEXT.md'), 'D-99\n');
    const r = runGsdTools(['verify', 'context-drift', '03-feature'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.action, 'block');
    assert.strictEqual(data.block, true);
  });

  test('never blocks when nothing is stale, even with action:block', () => {
    const dir = phaseDirPath('03-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ workflow: { context_drift_action: 'block' } }),
    );
    fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# context\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'context'], { cwd: tmp });
    fs.writeFileSync(path.join(dir, '03-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'research'], { cwd: tmp });
    const r = runGsdTools(['verify', 'context-drift', '03-feature'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.deepStrictEqual(data.stale_artifacts, []);
    assert.strictEqual(data.block, false);
  });

  test('honors --raw', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\n');
    const r = runGsdTools(['verify', 'context-drift', '01-setup', '--raw'], tmp);
    assert.strictEqual(r.success, true, r.error);
  });

  test('always exits 0 (query command contract)', () => {
    const cases = [
      ['verify', 'context-drift', '99'],
      ['verify', 'context-drift'],
    ];
    for (const args of cases) {
      const r = runGsdTools(args, tmp);
      assert.strictEqual(r.exitCode, 0, `args=${JSON.stringify(args)} exitCode=${r.exitCode}`);
    }
  });
});

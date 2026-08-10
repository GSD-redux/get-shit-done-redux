'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Default-flip-documentation lint (DEFECT.DEFAULT-FLIP-DOCUMENTATION,
 * CONTEXT.md).
 *
 * scripts/lint-default-flip-documentation.cjs fails a PR that changes an
 * EXISTING default value in gsd-core/bin/shared/config-defaults.manifest.json
 * (the single source `CONFIG_DEFAULTS` loads at runtime) without a
 * `## Breaking Changes` PR-body section covering the migration semantics
 * (#3309: the v2 default flip from mid-flight to end-of-phase).
 *
 * Scope note: this check is deliberately narrower than the full DEFECT text
 * — it does NOT cover `buildNewProjectConfig`'s hardcoded object literal in
 * src/config.cts, because that literal mixes env-derived branches with
 * CONFIG_DEFAULTS spreads and cannot be reduced to a resolved value map from
 * source text alone without executing the compiled module at both refs. A
 * line/text diff of that literal would inherit the exact false-positive
 * risk (a harmless refactor reading as a "flip") this check exists to
 * avoid, so it is left out rather than shipped noisy. See the script's own
 * header comment for the full rationale.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LINT_SCRIPT = path.join(ROOT, 'scripts', 'lint-default-flip-documentation.cjs');
const { flatten, findDefaultValueChanges, evaluateDefaultFlipDoc, MANIFEST_PATH } = require(LINT_SCRIPT);
const { cleanup } = require('./helpers.cjs');

describe('default-flip-documentation lint: flatten (pure)', () => {
  test('flattens a nested object into dot-path leaves', () => {
    assert.deepEqual(
      flatten({ workflow: { human_verify_mode: 'end-of-phase' }, model_profile: 'balanced' }),
      { 'workflow.human_verify_mode': 'end-of-phase', model_profile: 'balanced' },
    );
  });

  test('an array is a leaf, not recursed into (reordering reads as one change, not N)', () => {
    assert.deepEqual(flatten({ tags: ['a', 'b'] }), { tags: ['a', 'b'] });
  });
});

describe('default-flip-documentation lint: findDefaultValueChanges (pure)', () => {
  test('the real #3309 defect shape IS a change: an existing key value differs', () => {
    const changes = findDefaultValueChanges(
      { 'workflow.human_verify_mode': 'mid-flight' },
      { 'workflow.human_verify_mode': 'end-of-phase' },
    );
    assert.deepEqual(changes, [{ key: 'workflow.human_verify_mode', from: 'mid-flight', to: 'end-of-phase' }]);
  });

  test('LOOKALIKE: a brand-new key (addition, not a flip) is NOT a change', () => {
    const changes = findDefaultValueChanges({ a: 1 }, { a: 1, b: 2 });
    assert.deepEqual(changes, []);
  });

  test('LOOKALIKE: a removed key (not a flip either) is NOT a change', () => {
    const changes = findDefaultValueChanges({ a: 1, b: 2 }, { a: 1 });
    assert.deepEqual(changes, []);
  });

  test('LOOKALIKE: the whole object reordered/restructured with identical resolved values is NOT a change (the false-positive the audit called out)', () => {
    const base = { workflow: { a: 1, b: 2 }, git: { create_tag: true } };
    const head = { git: { create_tag: true }, workflow: { b: 2, a: 1 } };
    assert.deepEqual(findDefaultValueChanges(flatten(base), flatten(head)), []);
  });

  test('an unchanged value is not reported', () => {
    assert.deepEqual(findDefaultValueChanges({ a: 1 }, { a: 1 }), []);
  });
});

describe('default-flip-documentation lint: evaluateDefaultFlipDoc (pure)', () => {
  test('no changes: always ok regardless of PR body', () => {
    assert.equal(evaluateDefaultFlipDoc([], '').ok, true);
  });

  test('a real flip with no Breaking Changes section in the PR body fails', () => {
    const verdict = evaluateDefaultFlipDoc([{ key: 'x', from: 1, to: 2 }], 'just a normal PR description');
    assert.equal(verdict.ok, false);
  });

  test('a real flip WITH a "## Breaking Changes" heading in the PR body passes', () => {
    const verdict = evaluateDefaultFlipDoc(
      [{ key: 'x', from: 1, to: 2 }],
      'Summary\n\n## Breaking Changes\n\nNew default takes effect on config-set.',
    );
    assert.equal(verdict.ok, true);
  });

  test('the heading match is case-insensitive and tolerates heading level', () => {
    const verdict = evaluateDefaultFlipDoc([{ key: 'x', from: 1, to: 2 }], '# breaking changes\ndetails');
    assert.equal(verdict.ok, true);
  });
});

describe('default-flip-documentation lint: main() end-to-end wiring', () => {
  const git = (dir, ...args) => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  function buildRepo(tmpDir, baseManifest, headManifest) {
    git(tmpDir, 'init', '-q', '-b', 'main');
    git(tmpDir, 'config', 'user.email', 'test@example.com');
    git(tmpDir, 'config', 'user.name', 'Test');
    const manifestAbs = path.join(tmpDir, MANIFEST_PATH);
    fs.mkdirSync(path.dirname(manifestAbs), { recursive: true });
    fs.writeFileSync(manifestAbs, JSON.stringify(baseManifest));
    git(tmpDir, 'add', '-A');
    git(tmpDir, 'commit', '-q', '-m', 'base');
    git(tmpDir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    git(tmpDir, 'checkout', '-q', '-b', 'pr');
    fs.writeFileSync(manifestAbs, JSON.stringify(headManifest));
    git(tmpDir, 'add', '-A');
    git(tmpDir, 'commit', '-q', '-m', 'pr');

    const scriptsDir = path.join(tmpDir, 'scripts');
    const libDir = path.join(scriptsDir, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    const scriptCopy = path.join(scriptsDir, 'lint-default-flip-documentation.cjs');
    fs.copyFileSync(LINT_SCRIPT, scriptCopy);
    fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', 'cli-exit.cjs'), path.join(libDir, 'cli-exit.cjs'));
    return scriptCopy;
  }

  function runWithPrBody(tmpDir, scriptCopy, prBody) {
    const eventPath = path.join(tmpDir, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { body: prBody } }));
    return cp.spawnSync(
      process.execPath,
      [scriptCopy],
      {
        cwd: tmpDir,
        env: { ...process.env, GITHUB_BASE_REF: 'main', GITHUB_EVENT_PATH: eventPath },
        encoding: 'utf8',
      },
    );
  }

  test('exit 1: a flipped default with no Breaking Changes section in the PR body', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-default-flip-e2e-'));
    t.after(() => cleanup(tmpDir));
    const scriptCopy = buildRepo(
      tmpDir,
      { workflow: { human_verify_mode: 'mid-flight' } },
      { workflow: { human_verify_mode: 'end-of-phase' } },
    );
    const result = runWithPrBody(tmpDir, scriptCopy, 'Flips the default. No migration notes.');
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /DEFAULT-FLIP-DOCUMENTATION/);
  });

  test('exit 0: a flipped default WITH a Breaking Changes section', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-default-flip-e2e-doc-'));
    t.after(() => cleanup(tmpDir));
    const scriptCopy = buildRepo(
      tmpDir,
      { workflow: { human_verify_mode: 'mid-flight' } },
      { workflow: { human_verify_mode: 'end-of-phase' } },
    );
    const result = runWithPrBody(
      tmpDir,
      scriptCopy,
      '## Breaking Changes\n\nNew default takes effect when config.json is regenerated; opt back in with `gsd config-set workflow.human_verify_mode mid-flight`.',
    );
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  });

  test('LOOKALIKE: manifest restructured/reformatted with identical resolved values does NOT fail, even with no Breaking Changes section', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-default-flip-e2e-reformat-'));
    t.after(() => cleanup(tmpDir));
    const scriptCopy = buildRepo(
      tmpDir,
      { a: 1, workflow: { x: true, y: false } },
      { workflow: { y: false, x: true }, a: 1 },
    );
    const result = runWithPrBody(tmpDir, scriptCopy, 'Pure reformat, no PR body sections at all.');
    assert.equal(result.status, 0, `expected exit 0 (no real value change), got ${result.status}: ${result.stderr}`);
  });

  test('exit 0 and skip when there is no PR event payload (push / local run)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-default-flip-e2e-noevent-'));
    t.after(() => cleanup(tmpDir));
    const scriptCopy = buildRepo(tmpDir, { a: 1 }, { a: 2 });
    const result = cp.spawnSync(
      process.execPath,
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GITHUB_BASE_REF: 'main', GITHUB_EVENT_PATH: '' }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /skipping/);
  });
});

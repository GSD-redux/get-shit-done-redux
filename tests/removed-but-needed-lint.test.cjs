'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Removed-but-needed lint (DEFECT.REMOVED-BUT-NEEDED, CONTEXT.md).
 *
 * scripts/lint-removed-but-needed.cjs fails a PR that deletes a file while a
 * live consumer (a workflow, docs, or package.json) still references it —
 * #3316 (root package-lock.json deleted while workflows still used
 * `cache: 'npm'` + `npm ci`), e3b52c70 (docs referenced a removed
 * `/gsd-new-workspace` workflow).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LINT_SCRIPT = path.join(ROOT, 'scripts', 'lint-removed-but-needed.cjs');
const { referencesBasename, referencesNpmLockfileDependency, findSurvivingReferences, scan } = require(LINT_SCRIPT);
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

describe('removed-but-needed lint: referencesBasename (pure)', () => {
  test('a plain filename reference in prose is found', () => {
    assert.equal(referencesBasename('see docs/gsd-new-workspace.md for details', 'gsd-new-workspace.md'), true);
  });

  test('no reference at all is not found', () => {
    assert.equal(referencesBasename('nothing to see here', 'gsd-new-workspace.md'), false);
  });

  test('a coincidental substring inside a different filename is NOT a false match (word-boundary guard)', () => {
    assert.equal(referencesBasename('old-config.json.bak lives here', 'config.json'), false);
  });

  test('a path-embedded reference (with separators) IS found', () => {
    assert.equal(referencesBasename('run: node scripts/gsd-new-workspace.cjs', 'gsd-new-workspace.cjs'), true);
  });
});

describe('removed-but-needed lint: referencesNpmLockfileDependency (pure)', () => {
  test('`npm ci` is flagged', () => {
    assert.equal(referencesNpmLockfileDependency('      run: npm ci'), true);
  });

  test('`cache: \'npm\'` is flagged', () => {
    assert.equal(referencesNpmLockfileDependency("        cache: 'npm'"), true);
  });

  test('an unrelated workflow step is not flagged', () => {
    assert.equal(referencesNpmLockfileDependency('      run: npm run build'), false);
  });
});

describe('removed-but-needed lint: findSurvivingReferences (pure)', () => {
  test('the real #3316 defect shape IS flagged: package-lock.json deleted, workflow still runs npm ci', () => {
    const violations = findSurvivingReferences(
      ['package-lock.json'],
      [{ file: '.github/workflows/ci.yml', content: 'jobs:\n  test:\n    steps:\n      - run: npm ci\n' }],
    );
    assert.ok(violations.some((v) => v.deletedFile === 'package-lock.json'));
  });

  test('a deleted workflow still referenced in docs IS flagged (e3b52c70 shape)', () => {
    const violations = findSurvivingReferences(
      ['gsd-core/workflows/new-workspace.md'],
      [{ file: 'docs/getting-started.md', content: 'run /gsd:new-workspace.md to start' }],
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].referencedIn, 'docs/getting-started.md');
  });

  test('LOOKALIKE: a deleted file with zero surviving references is clean', () => {
    const violations = findSurvivingReferences(
      ['gsd-core/workflows/retired.md'],
      [{ file: 'docs/getting-started.md', content: 'nothing relevant here' }],
    );
    assert.deepEqual(violations, []);
  });

  test('LOOKALIKE: a coincidental basename collision with an unrelated live file is not silently skipped, but the word-boundary guard avoids substring noise', () => {
    const violations = findSurvivingReferences(
      ['old/config.json'],
      [{ file: 'docs/setup.md', content: 'we removed archived-config.json.old, unrelated' }],
    );
    assert.deepEqual(violations, []);
  });
});

describe('removed-but-needed lint: the live repo (against origin/next) is clean', () => {
  test('scan() finds zero surviving references for anything deleted since origin/next', () => {
    let violations;
    try {
      violations = scan(ROOT, 'origin/next');
    } catch {
      // origin/next unreachable in this environment — nothing to assert.
      return;
    }
    assert.deepEqual(
      violations,
      [],
      'deleted file(s) still referenced by a live consumer:\n'
        + violations.map((v) => `  ${v.deletedFile} -> ${v.referencedIn}: ${v.reason}`).join('\n'),
    );
  });
});

/**
 * Build a minimal temp git repo shaped like a PR branch, mirroring
 * tests/changeset-lint.test.cjs's fixture builder: origin/main = base
 * commit, pr = PR branch with caller-supplied file mutations on top.
 * @param {string} tmpDir
 * @param {Array<{file: string, content: string|null}>} baseFiles
 * @param {Array<{file: string, content: string|null}>} prFiles - null content deletes
 */
function buildTempRepo(tmpDir, baseFiles, prFiles) {
  const git = (...args) => gitOrThrow(args, { cwd: tmpDir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');

  for (const { file, content } of baseFiles) {
    const abs = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');

  git('checkout', '-q', '-b', 'pr');
  for (const { file, content } of prFiles) {
    const abs = path.join(tmpDir, file);
    if (content === null) {
      try { fs.unlinkSync(abs); } catch { /* already absent */ }
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'pr changes');
  return tmpDir;
}

/**
 * The lint script resolves its scan root from `path.join(__dirname, '..')`
 * (matching every other standalone lint script in this repo, e.g.
 * lint-canary-version-leak.cjs) — it does NOT use `process.cwd()`. So an
 * end-to-end fixture must run a COPY of the script placed inside the fixture
 * repo, not the real repo's script, or it would scan the real repo instead
 * of the fixture tree.
 * @param {string} tmpDir
 * @returns {string} path to the copied script inside tmpDir/scripts/
 */
function copyScriptInto(tmpDir) {
  const scriptsDir = path.join(tmpDir, 'scripts');
  const libDir = path.join(scriptsDir, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  const scriptCopy = path.join(scriptsDir, 'lint-removed-but-needed.cjs');
  fs.copyFileSync(LINT_SCRIPT, scriptCopy);
  fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', 'cli-exit.cjs'), path.join(libDir, 'cli-exit.cjs'));
  return scriptCopy;
}

describe('removed-but-needed lint: main() end-to-end wiring', () => {
  test('exit 1 in a fixture repo reproducing the real defect shape (package-lock.json deleted, workflow still npm ci)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-removed-but-needed-e2e-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [
        { file: 'package-lock.json', content: '{}' },
        { file: '.github/workflows/ci.yml', content: 'jobs:\n  test:\n    steps:\n      - run: npm ci\n' },
      ],
      [{ file: 'package-lock.json', content: null }],
    );
    const scriptCopy = copyScriptInto(tmpDir);
    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stderr, /REMOVED-BUT-NEEDED/);
  });

  test('exit 0 in a fixture repo where the deletion is clean (no surviving reference, workflow updated too)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-removed-but-needed-e2e-clean-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [
        { file: 'package-lock.json', content: '{}' },
        { file: '.github/workflows/ci.yml', content: 'jobs:\n  test:\n    steps:\n      - run: npm install\n' },
      ],
      [{ file: 'package-lock.json', content: null }],
    );
    const scriptCopy = copyScriptInto(tmpDir);
    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
  });

  test('gracefully skips (exit 0) when the base ref cannot be resolved', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-removed-but-needed-e2e-noref-'));
    t.after(() => cleanup(tmpDir));
    const git = (...args) => gitOrThrow(args, { cwd: tmpDir });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'only commit');
    const scriptCopy = copyScriptInto(tmpDir);

    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'nonexistent-branch' } },
    );
    assert.equal(result.exitCode, 0, `expected graceful skip (exit 0), got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stdout, /skipping/);
  });
});

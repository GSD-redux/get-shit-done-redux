'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { evaluateLint, LINT_REASON, findPrFieldDrift, DEFAULT_BASE: CHANGESET_DEFAULT_BASE } = require(path.join(__dirname, '..', 'scripts', 'changeset', 'lint.cjs'));
const { DEFAULT_BASE: DOCS_DEFAULT_BASE } = require(path.join(__dirname, '..', 'scripts', 'lint-docs-required.cjs'));

const ROOT = path.join(__dirname, '..');
const LINT_SCRIPT = path.join(ROOT, 'scripts', 'changeset', 'lint.cjs');
const { cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

/**
 * Build a minimal temp git repo shaped like a PR branch:
 *   origin/main  = base commit (README.md)
 *   pr           = PR branch with caller-supplied files committed on top
 *
 * @param {string} tmpDir - pre-created temp directory (mkdtempSync result)
 * @param {Array<{file: string, content: string}>} prFiles - files to create on the PR branch
 * @param {Array<{file: string, content: string}>} [baseFiles] - extra files to create on base commit
 * @returns {string} path to the temp repo (same as tmpDir)
 */
function buildTempRepo(tmpDir, prFiles, baseFiles = []) {
  const git = (...args) => gitOrThrow(args, { cwd: tmpDir });

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');

  // Base commit: README + any caller-supplied base files
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
  for (const { file, content } of baseFiles) {
    const abs = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');

  // Fake origin/main so `git diff origin/main...HEAD` works without a real remote
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');

  // PR branch
  git('checkout', '-q', '-b', 'pr');

  // Create or delete the PR files
  for (const { file, content } of prFiles) {
    const abs = path.join(tmpDir, file);
    if (content === null) {
      // null content = delete the file (unlinkSync, not rmSync, to stay within
      // the no-raw-rmsync-in-tests rule — we are removing a single file, not a tree)
      try { fs.unlinkSync(abs); } catch { /* already absent — ok */ }
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
 * Invoke lint.cjs --json in the given repo directory and return the parsed report.
 * @param {string} repoDir
 * @returns {{ status: number, report: object }}
 */
function runLint(repoDir) {
  const result = runNode(
    [LINT_SCRIPT, '--json'],
    {
      cwd: repoDir,
      env: { ...process.env, GITHUB_BASE_REF: 'main', GITHUB_EVENT_PATH: '' },
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  let report = {};
  try { report = JSON.parse(result.stdout); } catch { /* leave as empty object */ }
  return { status: result.exitCode, report };
}

/**
 * Like runLint, but with a real GITHUB_EVENT_PATH pointing at a synthetic PR
 * event payload — needed to exercise DEFECT.CHANGESET-PR-FIELD-DRIFT, which
 * compares each fragment's `pr:` against `event.pull_request.number`.
 * @param {string} repoDir
 * @param {number|undefined} prNumber - omit to simulate a push/non-PR run
 *   (no `pull_request` key in the payload at all).
 */
function runLintWithPrEvent(repoDir, prNumber) {
  const eventPath = path.join(repoDir, 'event.json');
  const payload = prNumber === undefined ? {} : { pull_request: { number: prNumber, labels: [] } };
  fs.writeFileSync(eventPath, JSON.stringify(payload));
  const result = runNode(
    [LINT_SCRIPT, '--json'],
    {
      cwd: repoDir,
      env: { ...process.env, GITHUB_BASE_REF: 'main', GITHUB_EVENT_PATH: eventPath },
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  let report = {};
  try { report = JSON.parse(result.stdout); } catch { /* leave as empty object */ }
  return { status: result.exitCode, report };
}

// evaluateLint is a pure function over file lists + label list — no fs, no git.
// Tests assert on the structured verdict: { ok: bool, reason: LINT_REASON.X }.

describe('changeset lint: pure verdict (#2975)', () => {
  test('LINT_REASON enum exposes the documented codes', () => {
    assert.deepEqual(
      Object.keys(LINT_REASON).sort(),
      [
        'OK_FRAGMENT_PRESENT', 'OK_NO_USER_FACING_CHANGES', 'OK_OPT_OUT_LABEL',
        'FAIL_MISSING_FRAGMENT', 'FAIL_INVALID_FRAGMENT', 'FAIL_PR_FIELD_DRIFT',
      ].sort(),
    );
  });

  test('OK_FRAGMENT_PRESENT when the diff includes a new .changeset/*.md', () => {
    const verdict = evaluateLint({
      changedFiles: ['bin/install.js', '.changeset/silly-bears-dance.md'],
      labels: [],
    });
    assert.deepEqual(verdict, { ok: true, reason: LINT_REASON.OK_FRAGMENT_PRESENT });
  });

  test('FAIL_MISSING_FRAGMENT when user-facing files change without a fragment', () => {
    const verdict = evaluateLint({
      changedFiles: ['bin/install.js', 'tests/foo.test.cjs'],
      labels: [],
    });
    assert.deepEqual(verdict, { ok: false, reason: LINT_REASON.FAIL_MISSING_FRAGMENT });
  });

  test('OK_OPT_OUT_LABEL when no-changelog label present, even with user-facing changes', () => {
    const verdict = evaluateLint({
      changedFiles: ['bin/install.js'],
      labels: ['no-changelog'],
    });
    assert.deepEqual(verdict, { ok: true, reason: LINT_REASON.OK_OPT_OUT_LABEL });
  });

  test('OK_NO_USER_FACING_CHANGES when only test/ci/doc files change', () => {
    const verdict = evaluateLint({
      changedFiles: ['tests/foo.test.cjs', '.github/workflows/x.yml', 'docs/x.md'],
      labels: [],
    });
    assert.deepEqual(verdict, { ok: true, reason: LINT_REASON.OK_NO_USER_FACING_CHANGES });
  });

  test('FAIL_MISSING_FRAGMENT when CHANGELOG.md is edited directly (closes the workflow bypass)', () => {
    const verdict = evaluateLint({
      changedFiles: ['CHANGELOG.md'],
      labels: [],
    });
    assert.deepEqual(verdict, { ok: false, reason: LINT_REASON.FAIL_MISSING_FRAGMENT });
  });

  test('a fragment alone (no source change) is OK_FRAGMENT_PRESENT — fragment-only PR is allowed', () => {
    const verdict = evaluateLint({
      changedFiles: ['.changeset/silly-bears-dance.md'],
      labels: [],
    });
    assert.deepEqual(verdict, { ok: true, reason: LINT_REASON.OK_FRAGMENT_PRESENT });
  });

  test('FAIL_INVALID_FRAGMENT when fragmentFailures is non-empty', () => {
    const verdict = evaluateLint({
      changedFiles: ['.changeset/bad.md'],
      labels: [],
      fragmentFailures: [{ file: '.changeset/bad.md', reason: 'invalid_pr', detail: '0' }],
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, LINT_REASON.FAIL_INVALID_FRAGMENT);
    assert.deepEqual(verdict.failures, [{ file: '.changeset/bad.md', reason: 'invalid_pr', detail: '0' }]);
  });

  test('OK_FRAGMENT_PRESENT when fragment is present and fragmentFailures is empty (regression guard)', () => {
    const verdict = evaluateLint({
      changedFiles: ['bin/install.js', '.changeset/good.md'],
      labels: [],
      fragmentFailures: [],
    });
    assert.deepEqual(verdict, { ok: true, reason: LINT_REASON.OK_FRAGMENT_PRESENT });
  });

  test('FAIL_INVALID_FRAGMENT beats no-changelog opt-out label', () => {
    const verdict = evaluateLint({
      changedFiles: ['.changeset/bad.md'],
      labels: ['no-changelog'],
      fragmentFailures: [{ file: '.changeset/bad.md', reason: 'invalid_pr', detail: '0' }],
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, LINT_REASON.FAIL_INVALID_FRAGMENT);
  });

  test('FAIL_PR_FIELD_DRIFT when prFieldDrift is non-empty, even with a fragment present', () => {
    const verdict = evaluateLint({
      changedFiles: ['.changeset/good.md'],
      labels: [],
      prFieldDrift: [{ file: '.changeset/good.md', found: 1234, expected: 1240 }],
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, LINT_REASON.FAIL_PR_FIELD_DRIFT);
    assert.deepEqual(verdict.drift, [{ file: '.changeset/good.md', found: 1234, expected: 1240 }]);
  });

  test('FAIL_INVALID_FRAGMENT beats FAIL_PR_FIELD_DRIFT (checked first)', () => {
    const verdict = evaluateLint({
      changedFiles: ['.changeset/bad.md'],
      labels: [],
      fragmentFailures: [{ file: '.changeset/bad.md', reason: 'invalid_pr', detail: '0' }],
      prFieldDrift: [{ file: '.changeset/bad.md', found: 1, expected: 2 }],
    });
    assert.equal(verdict.reason, LINT_REASON.FAIL_INVALID_FRAGMENT);
  });
});

// ---------------------------------------------------------------------------
// DEFECT.CHANGESET-PR-FIELD-DRIFT (#3316, #3325): a fragment's pr: field is a
// guess (issue number, stacked-PR leftover) that never got backfilled to the
// real PR number.
// ---------------------------------------------------------------------------
describe('changeset lint: findPrFieldDrift (pure)', () => {
  test('a fragment whose pr matches the real PR number is not drift', () => {
    assert.deepEqual(findPrFieldDrift([{ file: '.changeset/good.md', pr: 1234 }], 1234), []);
  });

  test('a fragment whose pr disagrees with the real PR number IS flagged, naming the file', () => {
    const drift = findPrFieldDrift([{ file: '.changeset/stale.md', pr: 1234 }], 1240);
    assert.deepEqual(drift, [{ file: '.changeset/stale.md', found: 1234, expected: 1240 }]);
  });

  test('realPrNumber === null (no PR event payload) always yields no drift — push/non-PR runs never fail', () => {
    assert.deepEqual(findPrFieldDrift([{ file: '.changeset/anything.md', pr: 999 }], null), []);
  });

  test('a pr: 0 placeholder entry is silent even when it disagrees with a real, non-zero PR number', () => {
    // CONTRIBUTING.md documents pr:0 as the deliberate placeholder used
    // "during initial commit" before the real PR number is backfilled — it
    // is unbackfilled, not drifted, so it must never be flagged. (In the
    // real main() wiring, parseFragment already rejects pr:0 upstream as
    // invalid_pr before a fragment reaches this function at all — this test
    // locks in the pure function's own contract independent of that.)
    assert.deepEqual(findPrFieldDrift([{ file: '.changeset/placeholder.md', pr: 0 }], 1234), []);
  });
});

// ---------------------------------------------------------------------------
// src/ is user-facing (#2070 fix 2): post-ADR-457 the .cts sources under
// src/ are the product source of truth — gsd-core/bin/lib/*.cjs is a
// gitignored build artifact, so a src/-only PR previously had zero
// USER_FACING_PREFIXES coverage and could merge with no release note.
// ---------------------------------------------------------------------------
describe('changeset lint: src/ is user-facing (#2070)', () => {
  test('FAIL_MISSING_FRAGMENT when only a src/*.cts file changes without a fragment', () => {
    const verdict = evaluateLint({
      changedFiles: ['src/verify.cts'],
      labels: [],
    });
    assert.deepEqual(verdict, { ok: false, reason: LINT_REASON.FAIL_MISSING_FRAGMENT });
  });

  test('OK_FRAGMENT_PRESENT when a src/*.cts change is accompanied by a fragment', () => {
    const verdict = evaluateLint({
      changedFiles: ['src/verify.cts', '.changeset/silly-bears-dance.md'],
      labels: [],
    });
    assert.deepEqual(verdict, { ok: true, reason: LINT_REASON.OK_FRAGMENT_PRESENT });
  });

  test('OK_NO_USER_FACING_CHANGES when only a tests/*.test.cjs file changes (tests are not user-facing)', () => {
    const verdict = evaluateLint({
      changedFiles: ['tests/foo.test.cjs'],
      labels: [],
    });
    assert.deepEqual(verdict, { ok: true, reason: LINT_REASON.OK_NO_USER_FACING_CHANGES });
  });
});

// ---------------------------------------------------------------------------
// End-to-end integration: real main() wiring via temp git repo (#1006)
// ---------------------------------------------------------------------------
describe('changeset lint: main() end-to-end wiring (#1006)', () => {
  // Each test allocates its own tmpDir so cases run independently.

  test('malformed fragment (pr: 0) fails the gate end-to-end', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lint-e2e-'));
    t.after(() => cleanup(tmpDir));

    buildTempRepo(tmpDir, [
      // User-facing source change that requires a fragment
      { file: 'bin/thing.js', content: '// placeholder\n' },
      // Malformed fragment: pr: 0 is rejected by parseFragment (pr must be > 0)
      {
        file: '.changeset/bad.md',
        content: '---\ntype: Fixed\npr: 0\n---\n**Bad** placeholder. (#1)\n',
      },
    ]);

    const { status, report } = runLint(tmpDir);

    assert.equal(status, 1, `expected exit 1, got ${status}`);
    assert.equal(
      report.reason,
      LINT_REASON.FAIL_INVALID_FRAGMENT,
      `expected FAIL_INVALID_FRAGMENT, got ${report.reason}`,
    );
    assert.ok(Array.isArray(report.failures), 'failures must be an array');
    const badEntry = report.failures.find((f) => f.file.endsWith('.changeset/bad.md'));
    assert.ok(badEntry, 'failures must contain the bad fragment file');
    assert.equal(badEntry.reason, 'invalid_pr', `expected reason invalid_pr, got ${badEntry.reason}`);
  });

  test('valid fragment (pr: 1) passes the gate end-to-end', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lint-e2e-'));
    t.after(() => cleanup(tmpDir));

    buildTempRepo(tmpDir, [
      { file: 'bin/thing.js', content: '// placeholder\n' },
      {
        file: '.changeset/good.md',
        content: '---\ntype: Fixed\npr: 1\n---\n**Good** fix. (#1)\n',
      },
    ]);

    const { status, report } = runLint(tmpDir);

    assert.equal(status, 0, `expected exit 0, got ${status}`);
    assert.equal(
      report.reason,
      LINT_REASON.OK_FRAGMENT_PRESENT,
      `expected OK_FRAGMENT_PRESENT, got ${report.reason}`,
    );
  });

  test('deleted fragment is skipped and does not produce fail_invalid_fragment', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lint-e2e-'));
    t.after(() => cleanup(tmpDir));

    // Base commit includes a valid fragment (pr: 5) that the PR will delete.
    buildTempRepo(
      tmpDir,
      [
        // PR deletes the old fragment (null = delete)
        { file: '.changeset/old.md', content: null },
        // PR adds a new valid fragment
        {
          file: '.changeset/new.md',
          content: '---\ntype: Fixed\npr: 6\n---\n**New** fix. (#6)\n',
        },
      ],
      // base files: the old fragment exists before the PR
      [{ file: '.changeset/old.md', content: '---\ntype: Fixed\npr: 5\n---\n**Old** fix. (#5)\n' }],
    );

    const { status, report } = runLint(tmpDir);

    assert.equal(status, 0, `expected exit 0, got ${status}`);
    assert.equal(
      report.reason,
      LINT_REASON.OK_FRAGMENT_PRESENT,
      `expected OK_FRAGMENT_PRESENT, got ${report.reason}`,
    );
    // The deleted fragment must NOT appear in failures
    const failures = report.failures ?? [];
    const deletedEntry = failures.find((f) => f.file.endsWith('.changeset/old.md'));
    assert.ok(!deletedEntry, `deleted fragment must not appear in failures, got: ${JSON.stringify(failures)}`);
  });
});

// ─── #2988: local base fallback parity ──────────────────────────────────────

describe('#2988: changeset + docs lints resolve the same local base fallback', () => {
  test('both lints default to `next` (the integration branch), not `main`', () => {
    assert.strictEqual(CHANGESET_DEFAULT_BASE, 'next',
      `changeset lint DEFAULT_BASE must be 'next', got '${CHANGESET_DEFAULT_BASE}'`);
    assert.strictEqual(DOCS_DEFAULT_BASE, 'next',
      `docs lint DEFAULT_BASE must be 'next', got '${DOCS_DEFAULT_BASE}'`);
  });

  test('both lints resolve the same base given the same environment (parity)', () => {
    assert.strictEqual(CHANGESET_DEFAULT_BASE, DOCS_DEFAULT_BASE,
      `the two lints must not diverge on base resolution: changeset='${CHANGESET_DEFAULT_BASE}' docs='${DOCS_DEFAULT_BASE}'`);
  });
});

// ---------------------------------------------------------------------------
// DEFECT.CHANGESET-PR-FIELD-DRIFT end-to-end: real main() wiring reading
// GITHUB_EVENT_PATH's pull_request.number and comparing it against each
// changed fragment's pr: field.
// ---------------------------------------------------------------------------
describe('changeset lint: PR-field-drift end-to-end wiring', () => {
  test('correct pr: (matches the real PR number) passes the gate', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lint-e2e-'));
    t.after(() => cleanup(tmpDir));

    buildTempRepo(tmpDir, [
      { file: 'bin/thing.js', content: '// placeholder\n' },
      { file: '.changeset/good.md', content: '---\ntype: Fixed\npr: 4242\n---\n**Good** fix. (#4242)\n' },
    ]);

    const { status, report } = runLintWithPrEvent(tmpDir, 4242);

    assert.equal(status, 0, `expected exit 0, got ${status}: ${JSON.stringify(report)}`);
    assert.equal(report.reason, LINT_REASON.OK_FRAGMENT_PRESENT);
  });

  test('wrong pr: (stale/guessed number) fails the gate, naming the offending file', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lint-e2e-'));
    t.after(() => cleanup(tmpDir));

    buildTempRepo(tmpDir, [
      { file: 'bin/thing.js', content: '// placeholder\n' },
      { file: '.changeset/stale.md', content: '---\ntype: Fixed\npr: 3312\n---\n**Stale pr field** fix. (#3316)\n' },
    ]);

    const { status, report } = runLintWithPrEvent(tmpDir, 3316);

    assert.equal(status, 1, `expected exit 1, got ${status}`);
    assert.equal(report.reason, LINT_REASON.FAIL_PR_FIELD_DRIFT);
    assert.ok(Array.isArray(report.drift), 'drift must be an array');
    const entry = report.drift.find((d) => d.file.endsWith('.changeset/stale.md'));
    assert.ok(entry, `drift must name the offending file, got: ${JSON.stringify(report.drift)}`);
    assert.equal(entry.found, 3312);
    assert.equal(entry.expected, 3316);
  });

  test('no PR event payload (push / non-PR run) skips the drift check entirely, even with a stale pr:', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lint-e2e-'));
    t.after(() => cleanup(tmpDir));

    buildTempRepo(tmpDir, [
      { file: 'bin/thing.js', content: '// placeholder\n' },
      { file: '.changeset/anything.md', content: '---\ntype: Fixed\npr: 999\n---\n**Anything** fix. (#999)\n' },
    ]);

    // runLint() (no override) sets GITHUB_EVENT_PATH: '' — no payload at all.
    const { status, report } = runLint(tmpDir);

    assert.equal(status, 0, `expected exit 0, got ${status}: ${JSON.stringify(report)}`);
    assert.equal(report.reason, LINT_REASON.OK_FRAGMENT_PRESENT);
  });

  test('event payload present but with no pull_request key (also push-shaped) skips the drift check', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lint-e2e-'));
    t.after(() => cleanup(tmpDir));

    buildTempRepo(tmpDir, [
      { file: 'bin/thing.js', content: '// placeholder\n' },
      { file: '.changeset/anything.md', content: '---\ntype: Fixed\npr: 999\n---\n**Anything** fix. (#999)\n' },
    ]);

    const { status, report } = runLintWithPrEvent(tmpDir, undefined);

    assert.equal(status, 0, `expected exit 0, got ${status}: ${JSON.stringify(report)}`);
    assert.equal(report.reason, LINT_REASON.OK_FRAGMENT_PRESENT);
  });
});

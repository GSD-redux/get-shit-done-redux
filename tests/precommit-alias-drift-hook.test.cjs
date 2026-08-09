'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { runHook } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { stagedSourcePaths } = require('../scripts/lib/alias-drift-families.cjs');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, '.githooks', 'pre-commit');

/**
 * Derived, never restated: the sources `scripts/check-alias-drift.cjs` actually
 * reads. The hook's watched list and the checker's family table are parallel
 * surfaces over one constant set, and their silent divergence is exactly what
 * made the guard inert (#2725) — so this test asserts the hook against the
 * checker's own table rather than against a second copy of it.
 */
const DRIFT_SOURCES = stagedSourcePaths();

/** The two script paths the hook additionally watches, beyond the sources above. */
const WATCHED_SCRIPTS = [
  'scripts/check-alias-drift.cjs',
  'scripts/lib/alias-drift-families.cjs',
];

const WATCHED_PATHS = new Set([...DRIFT_SOURCES, ...WATCHED_SCRIPTS]);

/**
 * Write a mock bash script to a .sh file in tmpDir and return its absolute path.
 * The hook invokes it via GIT_OVERRIDE / NPM_OVERRIDE — bash executes the path
 * directly, so no PATH manipulation or NTFS execute-ACL fight is needed.
 */
function writeMock(tmpDir, name, content) {
  const filePath = path.join(tmpDir, `${name}.sh`);
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  return filePath;
}

/**
 * Run the hook with a mock `git diff --cached --name-only` that emits
 * `stagedLines` verbatim, and a mock `npm` that appends one line to a marker
 * file per invocation.
 *
 * `stagedLines` is a raw string, not an array, so a row can exercise the exact
 * byte shape git produces — including a CR-terminated line. Every other row
 * builds it from LF-joined paths, which is what git actually emits.
 *
 * Returns `{ result, npmCalls }`. Counting invocations (rather than testing for
 * file existence) is what lets the many-staged-files row assert the check runs
 * exactly once.
 */
function runPreCommit(t, stagedLines) {
  const tmpDir = createTempDir('gsd-precommit-hook-');
  t.after(() => cleanup(tmpDir));

  const marker = path.join(tmpDir, 'npm-calls.txt');
  const mockGit = writeMock(
    tmpDir,
    'git',
    `#!/usr/bin/env bash\nprintf '%s' ${JSON.stringify(stagedLines)}\n`,
  );
  const mockNpm = writeMock(
    tmpDir,
    'npm',
    `#!/usr/bin/env bash\nprintf 'call %s\\n' "$*" >> "$GSD_TEST_NPM_MARKER"\n`,
  );

  const result = runHook(HOOK_PATH, [], {
    interpreter: 'bash',
    cwd: ROOT,
    env: {
      ...process.env,
      GIT_OVERRIDE: mockGit,
      NPM_OVERRIDE: mockNpm,
      GSD_TEST_NPM_MARKER: marker,
    },
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  const npmCalls = fs.existsSync(marker)
    ? fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean).length
    : 0;

  return { result, npmCalls };
}

/** Join paths the way `git diff --cached --name-only` emits them. */
function staged(...paths) {
  return paths.length === 0 ? '' : `${paths.join('\n')}\n`;
}

describe('.githooks/pre-commit alias drift guard', () => {
  test('runs the drift check when the alias table source is staged', (t) => {
    const { result, npmCalls } = runPreCommit(t, staged('src/command-aliases.cts'));

    throwIfFailed(result, `bash ${HOOK_PATH}`);
    assert.equal(
      npmCalls,
      1,
      'staging the tracked alias source must invoke check:alias-drift — ' +
      'the guard previously watched gitignored build output, which git never stages (#2725)',
    );
  });

  test('fires when the drift checker itself is staged', (t) => {
    const { result, npmCalls } = runPreCommit(t, staged('scripts/check-alias-drift.cjs'));

    throwIfFailed(result, `bash ${HOOK_PATH}`);
    assert.equal(npmCalls, 1, 'editing the checker must re-run it');
  });

  test('fires when the shared family table is staged', (t) => {
    const { result, npmCalls } = runPreCommit(
      t,
      staged('scripts/lib/alias-drift-families.cjs'),
    );

    throwIfFailed(result, `bash ${HOOK_PATH}`);
    assert.equal(npmCalls, 1, 'editing the family table must re-run the check');
  });

  test('fires for every source the drift check actually reads', (t) => {
    assert.ok(DRIFT_SOURCES.length > 0, 'the drift surface must not be empty');

    for (const source of DRIFT_SOURCES) {
      const { npmCalls } = runPreCommit(t, staged(source));

      assert.equal(
        npmCalls,
        1,
        `${source} is in the drift checker's family table but .githooks/pre-commit ` +
        'does not watch it — the two surfaces have diverged again (#2725)',
      );
    }
  });

  test('does not run the drift check for unrelated staged files', (t) => {
    const { result, npmCalls } = runPreCommit(t, staged('README.md'));

    throwIfFailed(result, `bash ${HOOK_PATH}`);
    assert.equal(npmCalls, 0, 'expected npm check to be skipped for unrelated staged files');
  });

  test('does not fire for a src file outside the drift surface', (t) => {
    const outsider = 'src/milestone.cts';
    // Guards the row against going vacuous if milestone ever joins the family.
    assert.ok(
      !WATCHED_PATHS.has(outsider),
      `${outsider} joined the drift surface — pick a different outsider for this row`,
    );

    const { result, npmCalls } = runPreCommit(t, staged(outsider));

    throwIfFailed(result, `bash ${HOOK_PATH}`);
    assert.equal(
      npmCalls,
      0,
      'a guard that fires on every src/ edit trains contributors to bypass it',
    );
  });

  test('does not invoke a missing npm script for retired sdk paths', (t) => {
    const { result, npmCalls } = runPreCommit(t, staged('sdk/src/query/state-document.ts'));

    throwIfFailed(result, `bash ${HOOK_PATH}`);
    assert.equal(
      npmCalls,
      0,
      'the retired sdk/ guards called npm scripts that do not exist, aborting the commit (#2725)',
    );
  });

  test('does not watch the gitignored build output', (t) => {
    const { result, npmCalls } = runPreCommit(
      t,
      staged('gsd-core/bin/lib/command-aliases.cjs'),
    );

    throwIfFailed(result, `bash ${HOOK_PATH}`);
    assert.equal(
      npmCalls,
      0,
      'build outputs are gitignored and can never be staged — watching them is what made the guard inert',
    );
  });

  test('exits clean when nothing is staged', (t) => {
    const { result, npmCalls } = runPreCommit(t, staged());

    throwIfFailed(result, `bash ${HOOK_PATH}`);
    assert.equal(npmCalls, 0);
  });

  test('runs the check once when one of many staged files matches', (t) => {
    const { result, npmCalls } = runPreCommit(
      t,
      staged(
        'README.md',
        'docs/adr/0174-retire-gsd-sdk-package-boundary.md',
        'src/command-aliases.cts',
        'tests/helpers.cjs',
      ),
    );

    throwIfFailed(result, `bash ${HOOK_PATH}`);
    assert.equal(npmCalls, 1, 'expected exactly one check:alias-drift invocation');
  });

  test('matches a CR-terminated staged path', (t) => {
    const { result, npmCalls } = runPreCommit(t, 'src/command-aliases.cts\r\n');

    throwIfFailed(result, `bash ${HOOK_PATH}`);
    assert.equal(
      npmCalls,
      1,
      'a $-anchored grep fails on a CR-terminated line — the hook must strip \\r first',
    );
  });

  describe('anchors the pattern exactly (limit-1 / limit / limit+1)', () => {
    const cases = [
      ['src/command-aliases.ct', 0, 'limit-1: one character short of the extension'],
      ['src/command-aliases.cts', 1, 'limit: the exact tracked source'],
      ['src/command-aliases.ctsx', 0, 'limit+1: one character past the extension'],
      ['src/command-aliases.cts.bak', 0, 'suffix past the end anchor'],
      ['notsrc/command-aliases.cts', 0, 'prefix before the start anchor'],
    ];

    for (const [stagedPath, expectedCalls, label] of cases) {
      test(label, (t) => {
        const { result, npmCalls } = runPreCommit(t, staged(stagedPath));

        throwIfFailed(result, `bash ${HOOK_PATH}`);
        assert.equal(npmCalls, expectedCalls, `${stagedPath} -> ${expectedCalls} npm call(s)`);
      });
    }
  });

  test('property: never fires for a path outside the watched set', (t) => {
    // Biased toward near-misses (src/-prefixed, .cts-suffixed) because that is
    // where over-matching actually hides. numRuns is held low: every sample
    // spawns bash.
    const nearMiss = fc
      .tuple(
        fc.constantFrom('src/', 'srcx/', 'notsrc/', 'docs/', 'tests/', ''),
        fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
        fc.constantFrom('.cts', '.cjs', '.ts', '.md', '.cts.bak', ''),
      )
      .map(([dir, stem, ext]) => `${dir}${stem}${ext}`)
      .filter((p) => !WATCHED_PATHS.has(p));

    fc.assert(
      fc.property(nearMiss, (stagedPath) => {
        const { result, npmCalls } = runPreCommit(t, staged(stagedPath));
        throwIfFailed(result, `bash ${HOOK_PATH}`);
        return npmCalls === 0;
      }),
      { numRuns: 20 },
    );
  });
});

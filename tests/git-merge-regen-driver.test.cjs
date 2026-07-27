
/**
 * Tests for the `gsd-regen` merge driver (#2721, epic #2719, ADR-2719 Phase 1).
 *
 * Design + behavior table: .gsd/phase/feat-2721-merge-driver-and-regen-derived/40-design.md
 * Test matrix:            .gsd/phase/feat-2721-merge-driver-and-regen-derived/50-test-matrix.md
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const DRIVER_PATH = path.join(REPO_ROOT, 'scripts', 'git-merge-regen-driver.cjs');

const {
  ACTION,
  REASON,
  GITDIR_SOURCE,
  NOTICE_WINDOW_MS,
  resolveGitDir,
  resolveAndRecord,
  planInstall,
} = require(DRIVER_PATH);

// --- helpers ---------------------------------------------------------------

const GIT_TIMEOUT_MS = 30_000;

function git(cwd, args) {
  return cp.spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, GIT_TERMINAL_PROMPT: '0' },
  });
}

/**
 * `git check-attr <attr> -- <path>` in the real repo. Returns the attribute value.
 *
 * `-c safe.directory=…` is required, not incidental: the test container checks this repo
 * out at a path its user does not own, and git then refuses every command with
 * "detected dubious ownership in repository at '/work'". `check-attr` is a pure read of
 * `.gitattributes` — no hooks, no filters — so scoping the exemption to this one
 * invocation is safe. It is deliberately NOT applied to the driver's own production
 * `git config` calls, which run in the user's own clone and should keep the protection.
 * Forward slashes unconditionally: git wants them in this value on every platform.
 */
function checkAttr(attr, relPath) {
  const safeRoot = REPO_ROOT.replace(/\\/g, '/');
  const r = cp.spawnSync('git', ['-c', `safe.directory=${safeRoot}`, 'check-attr', attr, '--', relPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
  });
  assert.equal(r.status, 0, `git check-attr failed: ${r.stderr}`);
  // Format: "<path>: <attr>: <value>" — the value is everything after the last ": ".
  const line = String(r.stdout).trim();
  const idx = line.lastIndexOf(': ');
  return idx === -1 ? '' : line.slice(idx + 2);
}

/** Replace an fs method with a throwing stub for the duration of `fn`, then restore. */
function withFsFailure(method, fn) {
  const original = fs[method];
  fs[method] = () => {
    throw Object.assign(new Error('injected'), { code: 'EACCES' });
  };
  try {
    return fn();
  } finally {
    fs[method] = original;
  }
}

/** Write an "ours" temp file and return its path — production always receives a real %A. */
function writeOurs(dir, content = 'ours-content\n') {
  const p = path.join(dir, '.merge_file_OURS');
  fs.writeFileSync(p, content);
  return p;
}

/**
 * The argv shape git actually supplies under the registered command: [%O, %A, %B, %L].
 * `%P` is deliberately NOT registered — see planInstall's comment on shell interpolation.
 * `extra` lets one test prove a stray 5th entry (an old registration) is ignored.
 */
function gitArgv(dir, ...extra) {
  const o = path.join(dir, '.merge_file_ANC');
  const b = path.join(dir, '.merge_file_THEIRS');
  fs.writeFileSync(o, '');
  fs.writeFileSync(b, 'theirs-content\n');
  return [o, writeOurs(dir), b, '7', ...extra];
}

function readMarker(gitDir) {
  return JSON.parse(fs.readFileSync(path.join(gitDir, 'gsd-regen-pending.json'), 'utf8'));
}

function seedMarker(gitDir, value) {
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(
    path.join(gitDir, 'gsd-regen-pending.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

const GOLDEN_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'golden-install-parity');
const INSTALL_TREE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'install-tree');

function jsonFixturesIn(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

// --- .gitattributes scoping (rows 1-10) ------------------------------------

describe('.gitattributes declares the gsd-regen driver for exactly the churning artifacts', () => {
  test('goldenParityFixturesDeclareGsdRegenMergeDriver', () => {
    assert.equal(
      checkAttr('merge', 'tests/fixtures/golden-install-parity/claude.json'),
      'gsd-regen',
    );
  });

  test('allNineteenGoldenFixturesDeclareTheDriver', () => {
    const fixtures = jsonFixturesIn(GOLDEN_DIR);
    assert.ok(fixtures.length > 0, 'expected golden-install-parity fixtures to exist');
    for (const f of fixtures) {
      assert.equal(
        checkAttr('merge', `tests/fixtures/golden-install-parity/${f}`),
        'gsd-regen',
        `${f} must declare merge=gsd-regen`,
      );
    }
  });

  test('workflowSizeBaselineDeclaresTheDriver', () => {
    assert.equal(checkAttr('merge', 'tests/workflow-size-baseline.json'), 'gsd-regen');
  });

  test('agentSizeBaselineDeclaresTheDriver', () => {
    assert.equal(checkAttr('merge', 'tests/agent-size-baseline.json'), 'gsd-regen');
  });

  // NEGATIVE SPACE — ADR-2719 §7 keeps install-tree committed precisely so that
  // "the installer stopped shipping X" stays an absolute failure. Capturing it
  // with the driver would silently convert that absolute into an auto-resolve.
  test('installTreeFixturesAreNotCapturedByTheDriver', () => {
    assert.equal(
      checkAttr('merge', 'tests/fixtures/install-tree/claude.json'),
      'unspecified',
      'install-tree must keep normal merge semantics (ADR-2719 §7)',
    );
  });

  test('noInstallTreeFixtureIsCapturedByTheDriver', () => {
    const fixtures = jsonFixturesIn(INSTALL_TREE_DIR);
    assert.ok(fixtures.length > 0, 'expected install-tree fixtures to exist');
    for (const f of fixtures) {
      assert.equal(
        checkAttr('merge', `tests/fixtures/install-tree/${f}`),
        'unspecified',
        `${f} must NOT be captured by the driver`,
      );
    }
  });

  test('installTreeFixturesAreNotMarkedLinguistGenerated', () => {
    assert.equal(
      checkAttr('linguist-generated', 'tests/fixtures/install-tree/claude.json'),
      'unspecified',
      'ADR-2719 §7 keeps install-tree because its diffs are readable',
    );
  });

  test('goldenParityFixturesAreMarkedLinguistGenerated', () => {
    assert.equal(
      checkAttr('linguist-generated', 'tests/fixtures/golden-install-parity/claude.json'),
      'true',
    );
  });

  test('sizeBaselineDeclarationsAreExactPathsNotAGlob', () => {
    assert.equal(
      checkAttr('merge', 'tests/other-size-baseline.json'),
      'unspecified',
      'the two baselines are declared by exact path, never by a tests/*-size-baseline.json glob',
    );
  });

  test('driverPatternDoesNotCrossADirectorySeparator', () => {
    assert.equal(
      checkAttr('merge', 'tests/fixtures/golden-install-parity/sub/nested.json'),
      'unspecified',
    );
  });
});

// --- resolveGitDir (rows 11-19) --------------------------------------------

describe('resolveGitDir', () => {
  test('resolvesGitDirWhenDotGitIsADirectory', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, '.git'));

    const r = resolveGitDir(dir);
    assert.equal(r.source, GITDIR_SOURCE.DIRECTORY);
    assert.equal(r.gitDir, path.join(dir, '.git'));
  });

  test('resolvesGitDirFromAWorktreePointerFile', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'real-gitdir');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${target}\n`);

    const r = resolveGitDir(dir);
    assert.equal(r.source, GITDIR_SOURCE.GITFILE);
    assert.equal(r.gitDir, target);
  });

  test('resolvesARelativeWorktreePointerAgainstCwd', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ./nested\n');

    const r = resolveGitDir(dir);
    assert.equal(r.source, GITDIR_SOURCE.GITFILE);
    assert.equal(r.gitDir, path.resolve(dir, './nested'));
  });

  test('parsesAWorktreePointerWrittenWithCrlf', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'real-gitdir');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${target}\r\n`);

    const r = resolveGitDir(dir);
    assert.equal(r.source, GITDIR_SOURCE.GITFILE);
    assert.equal(r.gitDir, target, 'a trailing CR must not become part of the path');
  });

  test('parsesAWorktreePointerWithNoSpaceAfterTheColon', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'real-gitdir');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(dir, '.git'), `gitdir:${target}\n`);

    assert.equal(resolveGitDir(dir).gitDir, target);
  });

  test('treatsAnEmptyPointerFileAsUnresolved', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, '.git'), '');

    const r = resolveGitDir(dir);
    assert.equal(r.source, GITDIR_SOURCE.UNRESOLVED);
    assert.equal(r.gitDir, null);
  });

  test('treatsAGarbagePointerFileAsUnresolved', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, '.git'), 'this is not a gitdir pointer\n');

    assert.equal(resolveGitDir(dir).source, GITDIR_SOURCE.UNRESOLVED);
  });

  test('treatsAMissingDotGitAsUnresolved', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));

    const r = resolveGitDir(dir);
    assert.equal(r.source, GITDIR_SOURCE.UNRESOLVED);
    assert.equal(r.gitDir, null);
  });

  test('treatsAnUnreadablePointerFileAsUnresolved', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: somewhere\n');

    const r = withFsFailure('readFileSync', () => resolveGitDir(dir));
    assert.equal(r.source, GITDIR_SOURCE.UNRESOLVED, 'must degrade, never throw');
  });
});

// --- resolveAndRecord: happy & boundary (rows 20-29) -------------------------

describe('resolveAndRecord — resolution and the notice window', () => {
  test('acceptsOursAndNoticesOnTheFirstResolution', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const r = resolveAndRecord({ argv: gitArgv(dir), gitDir, now: 1_000_000 });
    assert.equal(r.action, ACTION.ACCEPT_OURS);
    assert.equal(r.reason, REASON.OK_RESOLVED);
    assert.equal(r.exitCode, 0);
    assert.equal(r.notice, true);
    assert.equal(r.pendingCount, 1);
  });

  test('suppressesTheNoticeForASubsequentPathInTheSameOperation', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    seedMarker(gitDir, { startedAt: 999_999, count: 1 });

    const r = resolveAndRecord({ argv: gitArgv(dir), gitDir, now: 1_000_000 });
    assert.equal(r.notice, false);
    assert.equal(r.pendingCount, 2, 'the second conflicted path in the same operation');
  });

  test('treatsAMarkerJustInsideTheWindowAsTheSameOperation', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    const now = 5_000_000;
    seedMarker(gitDir, { startedAt: now - (NOTICE_WINDOW_MS - 1), count: 1 });

    assert.equal(resolveAndRecord({ argv: gitArgv(dir), gitDir, now }).notice, false);
  });

  test('treatsAMarkerAtExactlyTheWindowAsTheSameOperation', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    const now = 5_000_000;
    seedMarker(gitDir, { startedAt: now - NOTICE_WINDOW_MS, count: 1 });

    assert.equal(
      resolveAndRecord({ argv: gitArgv(dir), gitDir, now }).notice,
      false,
      'the window is inclusive at the limit',
    );
  });

  test('resetsAndRenoticesForAMarkerJustOutsideTheWindow', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    const now = 5_000_000;
    seedMarker(gitDir, { startedAt: now - (NOTICE_WINDOW_MS + 1), count: 7 });

    const r = resolveAndRecord({ argv: gitArgv(dir), gitDir, now });
    assert.equal(r.notice, true, 'a later operation must not inherit the previous silence');
    assert.equal(r.pendingCount, 1, 'the stale count must reset, not accumulate');
  });

  test('noticesOnceAcrossAllTwentyArtifactResolutions', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const notices = [];
    for (let i = 0; i < 20; i += 1) {
      const r = resolveAndRecord({ argv: gitArgv(dir), gitDir, now: 2_000_000 + i });
      notices.push(r.notice);
    }
    assert.equal(notices.filter(Boolean).length, 1, 'exactly one notice for the whole operation');
    assert.equal(readMarker(gitDir).count, 20, 'this repo conflicts on 20 artifacts');
  });

  test('countsEveryResolutionInTheOperation', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    resolveAndRecord({ argv: gitArgv(dir), gitDir, now: 3_000_000 });
    const r = resolveAndRecord({ argv: gitArgv(dir), gitDir, now: 3_000_001 });
    assert.equal(r.pendingCount, 2);
  });

  test('resolvesAnAddAddConflictWhereTheAncestorIsEmpty', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const argv = gitArgv(dir);
    fs.writeFileSync(argv[0], ''); // %O is a 0-byte file in the add/add case
    const r = resolveAndRecord({ argv, gitDir, now: 4_000_000 });
    assert.equal(r.action, ACTION.ACCEPT_OURS);
    assert.equal(r.exitCode, 0);
  });

  test('resolvesOnTheMinimumThreeArgumentForm', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const [o, a, b] = gitArgv(dir);
    const r = resolveAndRecord({ argv: [o, a, b], gitDir, now: 4_100_000 });
    assert.equal(r.action, ACTION.ACCEPT_OURS);
    assert.equal(r.pendingCount, 1);
  });

  // An old registration (or a hand-edited .git/config) may still pass %P. It must be
  // inert data, never consumed — the driver's contract does not depend on it.
  test('ignoresAStrayFifthArgumentFromAnOldRegistration', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const r = resolveAndRecord({
      argv: gitArgv(dir, 'tests/workflow-size-baseline.json'),
      gitDir,
      now: 4_200_000,
    });
    assert.equal(r.action, ACTION.ACCEPT_OURS);
    assert.equal(r.pendingCount, 1);
    assert.equal(r.realPath, undefined, 'no path is read from argv at all');
  });
});

// --- resolveAndRecord: negative & hostile (rows 30-46) -----------------------

describe('resolveAndRecord — degrades toward a normal conflict, never toward a wrong resolution', () => {
  const badArgvCases = [
    ['declinesRatherThanGuessingWhenArgvIsTooShort', (dir) => gitArgv(dir).slice(0, 2)],
    ['declinesOnEmptyArgv', () => []],
  ];
  for (const [name, build] of badArgvCases) {
    test(name, (t) => {
      const dir = createTempDir('gsd-regen-');
      t.after(() => cleanup(dir));
      const gitDir = path.join(dir, '.git');
      fs.mkdirSync(gitDir);

      const r = resolveAndRecord({ argv: build(dir), gitDir, now: 6_000_000 });
      assert.equal(r.action, ACTION.DECLINE);
      assert.equal(r.reason, REASON.FAIL_BAD_ARGV);
      assert.equal(r.exitCode, 1, 'a non-zero exit gives git a normal conflict — today’s behavior');
    });
  }

  test('declinesWhenTheOursSideIsMissing', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const [ancestor, , theirs] = gitArgv(dir);
    const neverWritten = path.join(dir, '.merge_file_NEVER_WRITTEN');
    const r = resolveAndRecord({
      argv: [ancestor, neverWritten, theirs, '7', 'tests/workflow-size-baseline.json'],
      gitDir,
      now: 6_100_000,
    });
    assert.equal(r.action, ACTION.DECLINE);
    assert.equal(r.reason, REASON.FAIL_OURS_UNREADABLE);
    assert.equal(r.exitCode, 1);
  });

  const blankOursCases = [
    ['declinesOnAnEmptyOursPath', ''],
    ['declinesOnAWhitespaceOnlyOursPath', '   '],
  ];
  for (const [name, oursPath] of blankOursCases) {
    test(name, (t) => {
      const dir = createTempDir('gsd-regen-');
      t.after(() => cleanup(dir));
      const gitDir = path.join(dir, '.git');
      fs.mkdirSync(gitDir);

      const [o, , b] = gitArgv(dir);
      const r = resolveAndRecord({ argv: [o, oursPath, b], gitDir, now: 6_200_000 });
      assert.equal(r.action, ACTION.DECLINE);
      assert.equal(r.reason, REASON.FAIL_BAD_ARGV);
    });
  }

  // Valid JSON that is not a usable marker object. Each must be treated as absent
  // (reset + notice) rather than throwing or being read as state.
  const hostileMarkers = [
    ['treatsANumericMarkerAsAbsent', '0'],
    ['treatsAStringMarkerAsAbsent', '"str"'],
    ['treatsAnArrayMarkerAsAbsent', '[]'],
    ['treatsANullMarkerAsAbsent', 'null'],
    ['treatsABooleanMarkerAsAbsent', 'true'],
    ['treatsAnEmptyMarkerFileAsAbsent', ''],
    ['treatsACorruptMarkerAsAbsent', '{not json at all'],
    ['treatsANonNumericStartedAtAsAbsent', '{"startedAt":"yesterday","count":1}'],
    ['treatsANonFiniteStartedAtAsAbsent', '{"startedAt":1e999,"count":1}'],
    ['treatsANonNumericCountAsAbsent', '{"startedAt":1,"count":"three"}'],
    ['treatsANonFiniteCountAsAbsent', '{"startedAt":1,"count":1e999}'],
    ['treatsANegativeCountAsAbsent', '{"startedAt":1,"count":-5}'],
    ['treatsAMissingCountAsAbsent', '{"startedAt":1}'],
  ];
  for (const [name, raw] of hostileMarkers) {
    test(name, (t) => {
      const dir = createTempDir('gsd-regen-');
      t.after(() => cleanup(dir));
      const gitDir = path.join(dir, '.git');
      seedMarker(gitDir, raw);

      const r = resolveAndRecord({ argv: gitArgv(dir), gitDir, now: 7_000_000 });
      assert.equal(r.action, ACTION.ACCEPT_OURS, 'a bad marker must never block the merge');
      assert.equal(r.notice, true);
      assert.equal(r.pendingCount, 1, 'an unusable marker resets rather than accumulating');
    });
  }

  test('stillResolvesWhenTheMarkerCannotBeWritten', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const argv = gitArgv(dir);
    const r = withFsFailure('writeFileSync', () =>
      resolveAndRecord({ argv, gitDir, now: 8_000_000 }),
    );
    assert.equal(r.action, ACTION.ACCEPT_OURS);
    assert.equal(r.exitCode, 0, 'a diagnostic must never fail a merge');
  });

  test('resolvesAndNoticesEveryTimeWhenTheGitDirIsUnknown', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));

    const first = resolveAndRecord({ argv: gitArgv(dir), gitDir: null, now: 9_000_000 });
    const second = resolveAndRecord({ argv: gitArgv(dir), gitDir: null, now: 9_000_001 });
    assert.equal(first.action, ACTION.ACCEPT_OURS);
    assert.equal(first.exitCode, 0);
    assert.equal(first.notice, true);
    assert.equal(second.notice, true, 'without a marker there is nothing to dedupe against');
  });
});

// --- planInstall (rows 47-50) ----------------------------------------------

describe('planInstall', () => {
  test('plansBothMergeDriverConfigEntries', () => {
    const keys = planInstall({ repoRoot: '/repo' }).entries.map((e) => e.key);
    assert.deepEqual(keys, ['merge.gsd-regen.name', 'merge.gsd-regen.driver']);
  });

  test('normalizesTheDriverCommandToForwardSlashesOnEveryPlatform', () => {
    const { entries } = planInstall({ repoRoot: 'C:\\Users\\dev\\gsd-core' });
    const driver = entries.find((e) => e.key === 'merge.gsd-regen.driver').value;
    assert.ok(!driver.includes('\\'), `driver command must contain no backslash: ${driver}`);
  });

  // `driverCommandPassesEveryPlaceholderGitProvides` lived here and asserted that the
  // command carried %P. That was the vulnerable behaviour, so the test has been deleted
  // rather than relaxed — a test that asserts the old, now-wrong behaviour is worse than
  // no test. Its useful half (the four git-generated placeholders ARE passed) is folded
  // into `registeredDriverCommandNeverPassesThePlaceholderForTheFilePath`, which asserts
  // both directions in one place.

  test('plansIdenticalEntriesOnRepeatedInvocation', () => {
    assert.deepEqual(planInstall({ repoRoot: '/repo' }), planInstall({ repoRoot: '/repo' }));
  });
});

// --- CLI dispatch (rows 62-73) ---------------------------------------------
// CONTRIBUTING.md → "QA Matrix Requirements" / "CLI and command routing" requires a
// negative-input matrix for any command dispatcher: unknown subcommands, duplicate and
// conflicting flags, plus assertions on exit status and the absence of a stack trace.

describe('CLI dispatch', () => {
  /** Run the driver as a real child process — its output never touches this test's stdout. */
  function runCli(args, cwd = REPO_ROOT) {
    return cp.spawnSync(process.execPath, [DRIVER_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    });
  }

  /**
   * Swap process.stdout.write for the duration of `fn`. Same monkeypatch-and-restore-in-
   * finally shape as withFsFailure — the run* functions print, and leaking that into the
   * runner's stream is how a reporter ends up parsing a driver banner as a test result.
   */
  function withStdoutSilenced(fn) {
    const original = process.stdout.write;
    process.stdout.write = () => true;
    try {
      return fn();
    } finally {
      process.stdout.write = original;
    }
  }

  /** A stack frame looks like a line beginning with whitespace + "at ". */
  function hasStackTrace(text) {
    return /^\s+at\s/m.test(String(text));
  }

  const rejectedInvocations = [
    ['rejectsAnUnknownFlag', ['--bogus']],
    ['rejectsTwoConflictingFlags', ['--install', '--status']],
    ['rejectsADuplicatedFlag', ['--install', '--install']],
    ['rejectsAFlagCombinedWithAPositionalArgument', ['--status', 'extra']],
  ];
  for (const [name, args] of rejectedInvocations) {
    test(name, () => {
      const r = runCli(args);
      assert.equal(r.status, 2, `${args.join(' ')} must exit 2, got ${r.status}: ${r.stderr}`);
      assert.ok(
        !hasStackTrace(r.stderr),
        `usage errors must not print a stack trace, got: ${r.stderr}`,
      );
    });
  }

  test('driverModeWithNoArgumentsDeclinesRatherThanCrashing', () => {
    const r = runCli([]);
    assert.equal(r.status, 1, 'too-few-args declines, which git reads as a normal conflict');
    assert.ok(!hasStackTrace(r.stderr), `expected no stack trace, got: ${r.stderr}`);
  });

  test('statusEmitsParseableJsonWithTheDocumentedShape', () => {
    const r = runCli(['--status']);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    assert.equal(typeof report.registered, 'boolean');
    assert.equal(typeof report.pendingCount, 'number');
  });

  /** A scratch repo so registration never touches the developer's own .git/config. */
  function scratchRepo(t) {
    const dir = createTempDir('gsd-regen-cli-');
    t.after(() => cleanup(dir));
    git(dir, ['init', '-q', '.']);
    return dir;
  }

  test('installRegistersBothConfigEntriesAndStatusReportsIt', (t) => {
    const dir = scratchRepo(t);
    const { statusOf, runInstall } = require(DRIVER_PATH);

    assert.equal(statusOf({ repoRoot: dir }).registered, false, 'precondition: not registered');
    assert.equal(withStdoutSilenced(() => runInstall({ repoRoot: dir })), 0);
    assert.equal(statusOf({ repoRoot: dir }).registered, true);

    const driver = git(dir, ['config', '--get', 'merge.gsd-regen.driver']).stdout.trim();
    assert.equal(driver, planInstall({ repoRoot: dir }).entries[1].value);
  });

  test('installIsIdempotent', (t) => {
    const dir = scratchRepo(t);
    const { statusOf, runInstall } = require(DRIVER_PATH);

    withStdoutSilenced(() => runInstall({ repoRoot: dir }));
    const first = git(dir, ['config', '--get-all', 'merge.gsd-regen.driver']).stdout;
    assert.equal(withStdoutSilenced(() => runInstall({ repoRoot: dir })), 0);
    const second = git(dir, ['config', '--get-all', 'merge.gsd-regen.driver']).stdout;

    assert.equal(second, first, 'a second install must not append a duplicate value');
    assert.equal(statusOf({ repoRoot: dir }).registered, true);
  });

  test('uninstallRemovesTheRegistration', (t) => {
    const dir = scratchRepo(t);
    const { statusOf, runInstall, runUninstall } = require(DRIVER_PATH);

    withStdoutSilenced(() => runInstall({ repoRoot: dir }));
    assert.equal(withStdoutSilenced(() => runUninstall({ repoRoot: dir })), 0);
    assert.equal(statusOf({ repoRoot: dir }).registered, false);
  });

  test('uninstallOnACleanRepoSucceedsRatherThanFailing', (t) => {
    const dir = scratchRepo(t);
    const { runUninstall, statusOf } = require(DRIVER_PATH);

    assert.equal(withStdoutSilenced(() => runUninstall({ repoRoot: dir })), 0);
    assert.equal(statusOf({ repoRoot: dir }).registered, false);
  });

  /**
   * REGRESSION — arbitrary command execution via `%P` (isolated security review, #2721).
   *
   * Git does not invoke a merge driver with an argv array: it substitutes the placeholders
   * textually into the configured string and runs the whole thing through a shell. Quoting
   * does not save you — `$(…)` executes inside POSIX double quotes. `%O`/`%A`/`%B` are
   * git-generated temp names and `%L` is an integer, but `%P` is the file's own path, which
   * any contributor names freely. Registering `"%P"` let a branch that renamed a covered
   * fixture to `evil$(touch PWNED).json` run that command on the machine of every maintainer
   * who merged it — and the merge still reported success, so nothing looked wrong.
   *
   * The structural assertion is the real guard: it is platform-independent and fails the
   * moment someone re-adds the placeholder.
   */
  test('registeredDriverCommandNeverPassesThePlaceholderForTheFilePath', () => {
    const { entries } = planInstall({ repoRoot: REPO_ROOT });
    const driver = entries.find((e) => e.key === 'merge.gsd-regen.driver').value;
    assert.ok(
      !driver.includes('%P'),
      'git shell-interpolates %P — passing it is arbitrary command execution. Do not re-add it.',
    );
    for (const safe of ['%O', '%A', '%B', '%L']) {
      assert.ok(driver.includes(safe), `${safe} is git-generated and must still be passed`);
    }
  });

  test('aFilenameCarryingShellSubstitutionCannotExecuteDuringAMerge', (t) => {
    const dir = createTempDir('gsd-regen-inject-');
    t.after(() => cleanup(dir));

    git(dir, ['init', '-q', '.']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    // Register the REAL production command string — a hand-rolled one would not regress.
    for (const { key, value } of planInstall({ repoRoot: REPO_ROOT }).entries) {
      git(dir, ['config', key, value]);
    }

    fs.writeFileSync(path.join(dir, '.gitattributes'), 'evil*.json merge=gsd-regen\n');
    // Written with fs, so this shell never expands it — the payload is the literal name.
    const evil = 'evil$(touch PWNED_SENTINEL).json';
    const sentinel = path.join(dir, 'PWNED_SENTINEL');
    const write = (v) => fs.writeFileSync(path.join(dir, evil), `{"v":${v}}\n`);

    write(0);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    const base = git(dir, ['rev-parse', 'HEAD']).stdout.trim();

    git(dir, ['checkout', '-qb', 'ours']);
    write(1);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'ours']);

    git(dir, ['checkout', '-q', base]);
    git(dir, ['checkout', '-qb', 'theirs']);
    write(2);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'theirs']);

    git(dir, ['checkout', '-q', 'ours']);
    git(dir, ['merge', 'theirs', '-m', 'merge']);

    assert.equal(
      fs.existsSync(sentinel),
      false,
      'a filename containing $(...) must never execute — see the regression note above',
    );
  });
});

// --- real-git end-to-end (rows 51-55) — #2721 AC1 --------------------------

describe('gsd-regen driver under real git operations', () => {
  /**
   * Build a repo whose `derived.json` is a stand-in for a golden fixture: both
   * branches edit a DIFFERENT workflow file and both regenerate the artifact, so
   * the artifact conflicts while the sources do not. That is exactly the #2721
   * scenario (7 of 7 conflicting PRs collide on the identical artifact set).
   */
  function buildScenario(t, { register }) {
    const dir = createTempDir('gsd-regen-e2e-');
    t.after(() => cleanup(dir));

    git(dir, ['init', '-q', '.']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    if (register) {
      // Register the REAL production entries. A hand-rolled command string would let the
      // end-to-end tests keep passing while planInstall drifted — and would have kept
      // registering the %P form these tests exist to prove is gone.
      for (const { key, value } of planInstall({ repoRoot: REPO_ROOT }).entries) {
        git(dir, ['config', key, value]);
      }
    }

    fs.mkdirSync(path.join(dir, 'workflows'));
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'derived.json merge=gsd-regen\n');
    fs.writeFileSync(path.join(dir, 'workflows', 'a.md'), 'A0\n');
    fs.writeFileSync(path.join(dir, 'workflows', 'b.md'), 'B0\n');
    fs.writeFileSync(path.join(dir, 'derived.json'), '{"a":"A0","b":"B0"}\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    const base = git(dir, ['rev-parse', 'HEAD']).stdout.trim();

    git(dir, ['checkout', '-qb', 'ours']);
    fs.writeFileSync(path.join(dir, 'workflows', 'a.md'), 'A1\n');
    fs.writeFileSync(path.join(dir, 'derived.json'), '{"a":"A1","b":"B0"}\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'ours edits workflow a']);

    git(dir, ['checkout', '-q', base]);
    git(dir, ['checkout', '-qb', 'theirs']);
    fs.writeFileSync(path.join(dir, 'workflows', 'b.md'), 'B1\n');
    fs.writeFileSync(path.join(dir, 'derived.json'), '{"a":"A0","b":"B1"}\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'theirs edits workflow b']);

    git(dir, ['checkout', '-q', 'ours']);
    return dir;
  }

  test('twoBranchesEditingDifferentWorkflowsMergeCleanlyWithTheDriver', (t) => {
    const dir = buildScenario(t, { register: true });

    const merge = git(dir, ['merge', 'theirs', '-m', 'merge']);
    assert.equal(merge.status, 0, `merge should succeed: ${merge.stdout}${merge.stderr}`);
    assert.equal(git(dir, ['ls-files', '-u']).stdout.trim(), '', 'no unmerged index entries');
    assert.ok(
      !fs.readFileSync(path.join(dir, 'derived.json'), 'utf8').includes('<<<<<<<'),
      'the artifact must carry no conflict markers',
    );
    assert.equal(
      fs.readFileSync(path.join(dir, 'workflows', 'b.md'), 'utf8'),
      'B1\n',
      'the source side of the merge must still be applied normally',
    );
  });

  // Control: proves the test observes the DRIVER, not a trivially-mergeable artifact.
  test('theSameTwoBranchesConflictWithoutTheDriver', (t) => {
    const dir = buildScenario(t, { register: false });

    const merge = git(dir, ['merge', 'theirs', '-m', 'merge']);
    assert.notEqual(merge.status, 0, 'without the driver this scenario must conflict');
    assert.notEqual(git(dir, ['ls-files', '-u']).stdout.trim(), '');
  });

  test('resolvesUnderRebaseNotJustMerge', (t) => {
    const dir = buildScenario(t, { register: true });
    git(dir, ['checkout', '-q', 'theirs']);

    const rebase = git(dir, ['rebase', 'ours']);
    assert.equal(rebase.status, 0, `rebase should succeed: ${rebase.stdout}${rebase.stderr}`);
    assert.equal(git(dir, ['ls-files', '-u']).stdout.trim(), '');
  });

  test('leavesAOneSidedChangeToGitsTrivialMerge', (t) => {
    const dir = buildScenario(t, { register: true });
    git(dir, ['checkout', '-q', '-b', 'sideways', 'ours']);
    fs.writeFileSync(path.join(dir, 'workflows', 'c.md'), 'C1\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'unrelated']);

    const merge = git(dir, ['merge', 'ours', '-m', 'merge']);
    assert.equal(merge.status, 0);
    assert.equal(
      fs.readFileSync(path.join(dir, 'derived.json'), 'utf8'),
      '{"a":"A1","b":"B0"}\n',
      'a one-sided change is git’s trivial merge — the driver must not be involved',
    );
  });

  test('resolvedArtifactIsExactlyTheOursSide', (t) => {
    const dir = buildScenario(t, { register: true });
    const ours = fs.readFileSync(path.join(dir, 'derived.json'), 'utf8');

    git(dir, ['merge', 'theirs', '-m', 'merge']);
    assert.equal(
      fs.readFileSync(path.join(dir, 'derived.json'), 'utf8'),
      ours,
      'the driver invents nothing — it takes ours verbatim and defers to regen:derived',
    );
  });
});

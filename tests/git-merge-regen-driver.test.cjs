
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
  planResolution,
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

/** `git check-attr <attr> -- <path>` in the real repo. Returns the attribute value. */
function checkAttr(attr, relPath) {
  const r = cp.spawnSync('git', ['check-attr', attr, '--', relPath], {
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

/** The argv shape git actually supplies: [%O, %A, %B, %L, %P]. */
function gitArgv(dir, realPath = 'tests/workflow-size-baseline.json') {
  const o = path.join(dir, '.merge_file_ANC');
  const b = path.join(dir, '.merge_file_THEIRS');
  fs.writeFileSync(o, '');
  fs.writeFileSync(b, 'theirs-content\n');
  return [o, writeOurs(dir), b, '7', realPath];
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

// --- planResolution: happy & boundary (rows 20-29) -------------------------

describe('planResolution — resolution and the notice window', () => {
  test('acceptsOursAndNoticesOnTheFirstResolution', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const r = planResolution({ argv: gitArgv(dir), gitDir, now: 1_000_000 });
    assert.equal(r.action, ACTION.ACCEPT_OURS);
    assert.equal(r.reason, REASON.OK_RESOLVED);
    assert.equal(r.exitCode, 0);
    assert.equal(r.notice, true);
    assert.deepEqual(r.pendingPaths, ['tests/workflow-size-baseline.json']);
  });

  test('suppressesTheNoticeForASubsequentPathInTheSameOperation', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    seedMarker(gitDir, { startedAt: 999_999, paths: ['tests/agent-size-baseline.json'] });

    const r = planResolution({ argv: gitArgv(dir), gitDir, now: 1_000_000 });
    assert.equal(r.notice, false);
    assert.deepEqual(r.pendingPaths, [
      'tests/agent-size-baseline.json',
      'tests/workflow-size-baseline.json',
    ]);
  });

  test('treatsAMarkerJustInsideTheWindowAsTheSameOperation', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    const now = 5_000_000;
    seedMarker(gitDir, { startedAt: now - (NOTICE_WINDOW_MS - 1), paths: ['a.json'] });

    assert.equal(planResolution({ argv: gitArgv(dir), gitDir, now }).notice, false);
  });

  test('treatsAMarkerAtExactlyTheWindowAsTheSameOperation', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    const now = 5_000_000;
    seedMarker(gitDir, { startedAt: now - NOTICE_WINDOW_MS, paths: ['a.json'] });

    assert.equal(
      planResolution({ argv: gitArgv(dir), gitDir, now }).notice,
      false,
      'the window is inclusive at the limit',
    );
  });

  test('resetsAndRenoticesForAMarkerJustOutsideTheWindow', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    const now = 5_000_000;
    seedMarker(gitDir, { startedAt: now - (NOTICE_WINDOW_MS + 1), paths: ['stale.json'] });

    const r = planResolution({ argv: gitArgv(dir), gitDir, now });
    assert.equal(r.notice, true, 'a later operation must not inherit the previous silence');
    assert.deepEqual(r.pendingPaths, ['tests/workflow-size-baseline.json']);
  });

  test('noticesOnceAcrossAllTwentyArtifactPaths', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const notices = [];
    for (let i = 0; i < 20; i += 1) {
      const r = planResolution({
        argv: gitArgv(dir, `tests/fixtures/golden-install-parity/host-${i}.json`),
        gitDir,
        now: 2_000_000 + i,
      });
      notices.push(r.notice);
    }
    assert.equal(notices.filter(Boolean).length, 1, 'exactly one notice for the whole operation');
    assert.equal(readMarker(gitDir).paths.length, 20);
  });

  test('dedupesARepeatedPathWithinOneOperation', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    planResolution({ argv: gitArgv(dir, 'tests/x.json'), gitDir, now: 3_000_000 });
    const r = planResolution({ argv: gitArgv(dir, 'tests/x.json'), gitDir, now: 3_000_001 });
    assert.deepEqual(r.pendingPaths, ['tests/x.json']);
  });

  test('resolvesAnAddAddConflictWhereTheAncestorIsEmpty', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const argv = gitArgv(dir);
    fs.writeFileSync(argv[0], ''); // %O is a 0-byte file in the add/add case
    const r = planResolution({ argv, gitDir, now: 4_000_000 });
    assert.equal(r.action, ACTION.ACCEPT_OURS);
    assert.equal(r.exitCode, 0);
  });

  test('resolvesWhenGitSuppliesNoRealPathPlaceholder', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const [o, a, b] = gitArgv(dir);
    const r = planResolution({ argv: [o, a, b], gitDir, now: 4_100_000 });
    assert.equal(r.action, ACTION.ACCEPT_OURS);
    assert.equal(r.realPath, '<unknown>');
  });

  test('ignoresArgvEntriesBeyondTheKnownPlaceholders', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const r = planResolution({ argv: [...gitArgv(dir), 'extra'], gitDir, now: 4_200_000 });
    assert.equal(r.action, ACTION.ACCEPT_OURS);
    assert.equal(r.realPath, 'tests/workflow-size-baseline.json');
  });
});

// --- planResolution: negative & hostile (rows 30-46) -----------------------

describe('planResolution — degrades toward a normal conflict, never toward a wrong resolution', () => {
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

      const r = planResolution({ argv: build(dir), gitDir, now: 6_000_000 });
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
    const r = planResolution({
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
      const r = planResolution({ argv: [o, oursPath, b], gitDir, now: 6_200_000 });
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
    ['treatsANonNumericStartedAtAsAbsent', '{"startedAt":"yesterday","paths":["x"]}'],
    ['treatsANonFiniteStartedAtAsAbsent', '{"startedAt":1e999,"paths":["x"]}'],
    ['treatsANonArrayPathsFieldAsAbsent', '{"startedAt":1,"paths":"notanarray"}'],
  ];
  for (const [name, raw] of hostileMarkers) {
    test(name, (t) => {
      const dir = createTempDir('gsd-regen-');
      t.after(() => cleanup(dir));
      const gitDir = path.join(dir, '.git');
      seedMarker(gitDir, raw);

      const r = planResolution({ argv: gitArgv(dir), gitDir, now: 7_000_000 });
      assert.equal(r.action, ACTION.ACCEPT_OURS, 'a bad marker must never block the merge');
      assert.equal(r.notice, true);
      assert.deepEqual(r.pendingPaths, ['tests/workflow-size-baseline.json']);
    });
  }

  test('stillResolvesWhenTheMarkerCannotBeWritten', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir);

    const argv = gitArgv(dir);
    const r = withFsFailure('writeFileSync', () =>
      planResolution({ argv, gitDir, now: 8_000_000 }),
    );
    assert.equal(r.action, ACTION.ACCEPT_OURS);
    assert.equal(r.exitCode, 0, 'a diagnostic must never fail a merge');
  });

  test('resolvesAndNoticesEveryTimeWhenTheGitDirIsUnknown', (t) => {
    const dir = createTempDir('gsd-regen-');
    t.after(() => cleanup(dir));

    const first = planResolution({ argv: gitArgv(dir), gitDir: null, now: 9_000_000 });
    const second = planResolution({ argv: gitArgv(dir), gitDir: null, now: 9_000_001 });
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

  test('driverCommandPassesEveryPlaceholderGitProvides', () => {
    const { entries } = planInstall({ repoRoot: '/repo' });
    const driver = entries.find((e) => e.key === 'merge.gsd-regen.driver').value;
    for (const ph of ['%O', '%A', '%B', '%L', '%P']) {
      assert.ok(driver.includes(ph), `driver command must pass ${ph}`);
    }
  });

  test('plansIdenticalEntriesOnRepeatedInvocation', () => {
    assert.deepEqual(planInstall({ repoRoot: '/repo' }), planInstall({ repoRoot: '/repo' }));
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
      git(dir, ['config', 'merge.gsd-regen.name', 'regenerating driver']);
      git(dir, [
        'config',
        'merge.gsd-regen.driver',
        `node ${DRIVER_PATH.replace(/\\/g, '/')} %O %A %B %L %P`,
      ]);
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

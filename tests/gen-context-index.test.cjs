'use strict';

/**
 * Integration tests for scripts/gen-context-index.cjs — the CI gate that
 * keeps docs/CONTEXT-INDEX.json in sync with the predicates declared in the
 * repo-root CONTEXT.md (ADR-1671, #2928 Phase 1, rows F1-F17).
 *
 * The committed artifact is plain JSON (not a `.cjs` CommonJS module): a
 * shipped runtime module is the wrong place for ~120 KB of arbitrary
 * CONTEXT.md prose, and embedding it there tripped both
 * tests/cline-install.test.cjs (leaked `.claude/hooks/...` path literals) and
 * tests/package-name-single-source.test.cjs (hardcoded package-name
 * literals) — both true positives against runtime-code content scanning.
 * docs/CONTEXT-INDEX.json mirrors docs/INVENTORY-MANIFEST.json's precedent:
 * a committed, generated, `--check`-guarded JSON manifest that is not
 * runtime code.
 *
 * Fixture isolation (ADR-1671 Phase 1 commit 3): gen-context-index.cjs now
 * accepts `--context-path <p>` / `--index-path <p>` CLI overrides (and the
 * same-named parameters on the exported `checkReport`/`buildFreshIndex`
 * pure functions), so every test here spawns the real CLI (spawnSync, not an
 * engine-direct call — an engine-direct call is false-green for CLI behavior
 * per the design's own risk analysis) pointed directly at temp fixture
 * files, with NO fs monkeypatching. The prior `--require` preload
 * (tests/helpers/gen-context-index-fs-fixture.cjs) redirected two hardcoded
 * absolute paths by patching fs.readFileSync/existsSync/writeFileSync — that
 * indirection is no longer needed now that the paths are directly
 * injectable, and the preload has been deleted.
 *
 * Prohibited: Raw Text Matching on Test Outputs (CONTRIBUTING.md). This
 * generator's `--check --json` mode emits a typed `{ ok, reason, duplicates,
 * count, classes }` report — `reason` is always one of the frozen `REASON`
 * enum values. Rows F7-F10 assert on `report.reason === REASON.FAIL_X`
 * (and, for F7, that `report.duplicates` names the duplicate id) instead of
 * exit-code-only / stderr-substring assertions.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { serializeIndex, buildFreshIndex, checkReport, REASON } = require('../scripts/gen-context-index.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-context-index.cjs');
const REAL_CONTEXT_PATH = path.join(ROOT, 'CONTEXT.md');

const STACK_FRAME_RE = /\n\s+at\s+\S+\s+\(.*:\d+:\d+\)/;

/**
 * Spawn the real gen-context-index.cjs CLI with explicit `--context-path` /
 * `--index-path` overrides — no fs monkeypatching, no `--require` preload.
 *
 * @param {string[]} args - CLI args (e.g. ['--check', '--json']).
 * @param {{contextPath?: string, indexPath?: string}} [paths] - absolute
 *   fixture paths to pass via `--context-path`/`--index-path`. Omit a key to
 *   leave that seam at its real-repo default (read-only, untouched).
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function runGenContextIndex(args, paths = {}) {
  const fullArgs = [...args];
  if (paths.contextPath !== undefined) fullArgs.push('--context-path', paths.contextPath);
  if (paths.indexPath !== undefined) fullArgs.push('--index-path', paths.indexPath);

  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...fullArgs], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

/**
 * Parse the single JSON line `--check --json` writes to stdout.
 *
 * @param {string} stdout
 * @returns {object}
 */
function parseJsonReport(stdout) {
  return JSON.parse(stdout.trim());
}

describe('gen-context-index.cjs REASON enum (three-coordinated-changes lock)', () => {
  test('REASON key set is exactly the documented set', () => {
    // Locks the documented enum shape (CONTRIBUTING.md three-coordinated-
    // changes pattern): adding a reason requires updating this assertion
    // too, so the typed surface cannot silently drift from what tests expect.
    assert.deepEqual(Object.keys(REASON).sort(), [
      'FAIL_CONTEXT_MISSING',
      'FAIL_CONTEXT_UNREADABLE',
      'FAIL_DUPLICATE_IDS',
      'FAIL_INDEX_MISSING',
      'FAIL_INDEX_UNPARSEABLE',
      'FAIL_LIB_NOT_BUILT',
      'FAIL_STALE',
      'OK_UP_TO_DATE',
    ]);
  });

  test('REASON is frozen', () => {
    assert.ok(Object.isFrozen(REASON));
  });
});

describe('gen-context-index.cjs --check (F)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gen-context-index-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('checkExitsZeroWhenIndexIsFresh', () => {
    // Read-only against the real, already-fresh repo state — no override
    // needed, and nothing is mutated.
    const r = runGenContextIndex(['--check']);
    assert.equal(r.code, 0);
  });

  test('checkExitsZeroAfterPureLineShift', () => {
    // S5: the committed artifact carries no `line` field, so a pure line
    // shift in CONTEXT.md must not perturb the byte-identical serialization.
    const real = fs.readFileSync(REAL_CONTEXT_PATH, 'utf8');
    const lines = real.split(/\r?\n/);
    const shifted = [lines[0], '', '', ...lines.slice(1)].join('\n');
    const shiftedPath = path.join(tmpDir, 'CONTEXT-shifted.md');
    fs.writeFileSync(shiftedPath, shifted, 'utf8');

    const r = runGenContextIndex(['--check'], { contextPath: shiftedPath });
    assert.equal(r.code, 0, 'a pure line shift must not fail the gate (Q4 resolution, S5)');
  });

  test('checkExitsOneWhenPredicateValueChanged', () => {
    const real = fs.readFileSync(REAL_CONTEXT_PATH, 'utf8');
    const modified = real.replace(
      /`RULESET\.PR-SCOPE\.one-concern-per-pr=[^`]*`/,
      '`RULESET.PR-SCOPE.one-concern-per-pr=CHANGED VALUE FOR TEST`',
    );
    assert.notEqual(modified, real, 'fixture setup sanity: the substitution must actually apply');
    const modifiedPath = path.join(tmpDir, 'CONTEXT-value-changed.md');
    fs.writeFileSync(modifiedPath, modified, 'utf8');

    const r = runGenContextIndex(['--check'], { contextPath: modifiedPath });
    assert.equal(r.code, 1);
  });

  test('checkExitsOneWhenPredicateAdded', () => {
    const real = fs.readFileSync(REAL_CONTEXT_PATH, 'utf8');
    const added = real + '\n`ZZZTEST.added-by-test=value`\n';
    const addedPath = path.join(tmpDir, 'CONTEXT-added.md');
    fs.writeFileSync(addedPath, added, 'utf8');

    const r = runGenContextIndex(['--check'], { contextPath: addedPath });
    assert.equal(r.code, 1);
  });

  test('checkExitsOneWhenPredicateRemoved', () => {
    const real = fs.readFileSync(REAL_CONTEXT_PATH, 'utf8');
    const removed = real.replace(/`RULESET\.PR-SCOPE\.one-concern-per-pr=[^`]*`\r?\n/, '');
    assert.notEqual(removed, real, 'fixture setup sanity: the removal must actually apply');
    const removedPath = path.join(tmpDir, 'CONTEXT-removed.md');
    fs.writeFileSync(removedPath, removed, 'utf8');

    const r = runGenContextIndex(['--check'], { contextPath: removedPath });
    assert.equal(r.code, 1);
  });

  test('checkExitsOneWhenClassSetChanged', () => {
    const real = fs.readFileSync(REAL_CONTEXT_PATH, 'utf8');
    const classGained = real + '\n`BRANDNEWCLASSFORTEST.x=y`\n';
    const classGainedPath = path.join(tmpDir, 'CONTEXT-class-gained.md');
    fs.writeFileSync(classGainedPath, classGained, 'utf8');

    const r = runGenContextIndex(['--check'], { contextPath: classGainedPath });
    assert.equal(r.code, 1);
  });

  test('checkExitsOneAndNamesDuplicateIdentifier (F7)', () => {
    const real = fs.readFileSync(REAL_CONTEXT_PATH, 'utf8');
    const dupPath = path.join(tmpDir, 'CONTEXT-dup.md');
    const dupIntroduced = real + '\n`RULESET.PR-SCOPE.one-concern-per-pr=duplicate copy for test`\n';
    fs.writeFileSync(dupPath, dupIntroduced, 'utf8');

    const r = runGenContextIndex(['--check', '--json'], { contextPath: dupPath });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'no bare stack trace in non-debug failure output');

    const report = parseJsonReport(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_DUPLICATE_IDS);
    assert.ok(
      report.duplicates.some((d) => d.id === 'RULESET.PR-SCOPE.one-concern-per-pr'),
      'report.duplicates must name the duplicate id',
    );
  });

  test('checkExitsOneWithRemedyWhenIndexMissing (F8)', () => {
    const missingIndexPath = path.join(tmpDir, 'does-not-exist.json');
    const r = runGenContextIndex(['--check', '--json'], { indexPath: missingIndexPath });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE);

    const report = parseJsonReport(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_INDEX_MISSING);
  });

  test('checkExitsOneWithNamedReasonWhenIndexCorrupt (F9)', () => {
    const corruptIndexPath = path.join(tmpDir, 'corrupt-index.json');
    fs.writeFileSync(corruptIndexPath, 'this is not { valid javascript', 'utf8');

    const r = runGenContextIndex(['--check', '--json'], { indexPath: corruptIndexPath });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'no bare stack trace for a corrupt committed index');

    const report = parseJsonReport(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_INDEX_UNPARSEABLE);
  });

  test('checkExitsOneWhenContextMdMissing (F10)', () => {
    const missingContextPath = path.join(tmpDir, 'does-not-exist.md');
    const r = runGenContextIndex(['--check', '--json'], { contextPath: missingContextPath });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'no bare stack trace when CONTEXT.md is missing');

    const report = parseJsonReport(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_CONTEXT_MISSING);
  });

  test('checkExitsOneWhenContextMdUnreadable', () => {
    // Fault injection via the mandated technique (CONTRIBUTING.md /
    // CLAUDE.md cross-platform IO-failure rule): monkeypatch fs.readFileSync
    // to throw an injected EACCES for one specific fixture path, restore in
    // `finally`. Never chmod 0o000 (root bypasses mode bits). This is an
    // in-process call to the exported `checkReport` pure function rather
    // than a subprocess spawn — a subprocess's fs cannot be monkeypatched
    // from the parent test process without a `--require` preload, and
    // `checkReport` IS the typed surface under test here, so calling it
    // directly is not an engine-direct false-green for CLI *argv* behavior
    // (that risk is covered by the spawned-CLI tests above); it is the
    // correct level to exercise a fault the CLI itself cannot inject.
    const fixtureContextPath = path.join(tmpDir, 'unreadable-context.md');
    fs.writeFileSync(fixtureContextPath, '`FOO=bar`\n', 'utf8');

    const origReadFileSync = fs.readFileSync;
    fs.readFileSync = function patchedReadFileSync(p, ...rest) {
      if (p === fixtureContextPath) {
        const err = new Error(`EACCES: permission denied, open '${p}' (injected by test, never a real fs fault)`);
        err.code = 'EACCES';
        throw err;
      }
      return origReadFileSync.call(fs, p, ...rest);
    };
    try {
      const report = checkReport(fixtureContextPath, path.join(tmpDir, 'unused-index.json'));
      assert.equal(report.ok, false);
      assert.equal(report.reason, REASON.FAIL_CONTEXT_UNREADABLE);
    } finally {
      fs.readFileSync = origReadFileSync;
    }
  });

  test('checkIsCrlfAgnostic (F17)', () => {
    // F17: a CRLF-committed index compared against the (LF) fresh real
    // CONTEXT.md must still exit 0 — comparison is CRLF-normalized.
    const freshSerialized = serializeIndex(buildFreshIndex());
    const crlfSerialized = freshSerialized.replace(/\n/g, '\r\n');
    const crlfIndexPath = path.join(tmpDir, 'context-index-crlf.json');
    fs.writeFileSync(crlfIndexPath, crlfSerialized, 'utf8');

    const r = runGenContextIndex(['--check'], { indexPath: crlfIndexPath });
    assert.equal(r.code, 0, 'CRLF-vs-LF committed/fresh comparison must be normalized, not a false failure');
  });
});

describe('gen-context-index.cjs --write / default / usage (F)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gen-context-index-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('writeThenCheckIsClean', () => {
    const writeTarget = path.join(tmpDir, 'write-target.json');
    const w = runGenContextIndex(['--write'], { indexPath: writeTarget });
    assert.equal(w.code, 0);
    assert.ok(fs.existsSync(writeTarget), '--write must create the fixture-redirected index file');

    const c = runGenContextIndex(['--check'], { indexPath: writeTarget });
    assert.equal(c.code, 0, '--check must be clean immediately after --write');
  });

  test('writeIsByteIdenticalAcrossRuns', () => {
    const target1 = path.join(tmpDir, 'w1.json');
    const target2 = path.join(tmpDir, 'w2.json');
    assert.equal(runGenContextIndex(['--write'], { indexPath: target1 }).code, 0);
    assert.equal(runGenContextIndex(['--write'], { indexPath: target2 }).code, 0);

    const content1 = fs.readFileSync(target1, 'utf8');
    const content2 = fs.readFileSync(target2, 'utf8');
    assert.equal(content1, content2, '--write must be deterministic across independent runs');
  });

  test('writtenIndexContainsNoLineField', () => {
    const target = path.join(tmpDir, 'no-line-field.json');
    assert.equal(runGenContextIndex(['--write'], { indexPath: target }).code, 0);
    const content = fs.readFileSync(target, 'utf8');
    assert.equal(content.includes('"line"'), false, 'the committed artifact must carry no `line` field anywhere (S5)');
  });

  test('defaultInvocationPrintsIndexToStdout', () => {
    // Fully safe against the real repo: default mode only reads CONTEXT.md
    // and the compiled predicates lib (read-only) and writes nothing.
    const r = runGenContextIndex([]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.length > 0);
    // Compare against the exact expected serialization (computed the same
    // way the CLI does, via the exported pure functions) rather than
    // hand-parsing the rendered text — avoids brittle delimiter-scanning
    // over a JSON payload that legitimately contains ';' inside string values.
    const expected = serializeIndex(buildFreshIndex()) + '\n';
    assert.equal(r.stdout, expected);
  });

  test('unknownFlagExitsWithUsage', () => {
    // Safe against the real repo: the unknown-flag branch never reads
    // CONTEXT.md or the committed index at all.
    const r = runGenContextIndex(['--totally-bogus-flag']);
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'usage output must never be a bare stack trace');
  });

  // ─── DEFECT.GEN-CONTEXT-INDEX-PARSEARGS-GATE-BYPASS (MAJOR review finding):
  // conflicting `--check --write` must be a hard usage error, not a silent
  // `--write` win, and a missing/flag-shaped path value must never resolve
  // to the cwd (which previously leaked a raw EISDIR stack trace). ────────

  test('checkAndWriteTogetherIsUsageErrorNotASilentWrite (a)', () => {
    const target = path.join(tmpDir, 'should-not-be-written.json');
    const r = runGenContextIndex(['--check', '--write'], { indexPath: target });
    assert.notEqual(r.code, 0, '--check --write together must not silently exit 0 as a write');
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'usage output must never be a bare stack trace');
    assert.equal(fs.existsSync(target), false, '--write must never win over --check and rewrite the index');
  });

  test('writeAndCheckReversedOrderIsAlsoAUsageError (a)', () => {
    const target = path.join(tmpDir, 'should-also-not-be-written.json');
    const r = runGenContextIndex(['--write', '--check'], { indexPath: target });
    assert.notEqual(r.code, 0, 'conflicting mode flags must be a usage error regardless of order');
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE);
    assert.equal(fs.existsSync(target), false);
  });

  test('missingTrailingValueForContextPathIsUsageErrorNotEisdirStackTrace (b)', () => {
    const target = path.join(tmpDir, 'should-not-be-written-2.json');
    // `--context-path` is the LAST arg: argv[i+1] is undefined, which used
    // to resolve to the cwd via `path.resolve(undefined ?? '')`.
    const r = runGenContextIndex(['--write', '--index-path', target, '--context-path']);
    assert.notEqual(r.code, 0, 'a missing --context-path value must be a usage error');
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'must never leak a raw EISDIR (or any) stack trace');
    assert.equal(fs.existsSync(target), false, 'no write must happen when the path argument is rejected');
  });

  test('flagShapedValueForIndexPathIsUsageErrorNotSwallowedAsALiteralPath (b)', () => {
    // `--index-path` is immediately followed by another flag rather than a
    // path — must be rejected, not silently swallowed as the literal path
    // "--json".
    const r = runGenContextIndex(['--write', '--index-path', '--json']);
    assert.notEqual(r.code, 0, 'a flag-shaped --index-path value must be a usage error');
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE);
  });
});

// ─── DEFECT.GEN-CONTEXT-INDEX-DUPLICATE-GATE-UNPROVEN (MAJOR review finding):
// `FAIL_DUPLICATE_IDS` was only ever proven against synthetic fixtures — this
// branch hand-deleted the ONE live duplicate
// (`RULESET.WORKFLOW_MARKDOWN.FENCES`) from the real CONTEXT.md, so the
// committed docs/CONTEXT-INDEX.json ships `duplicates: []` and the gate has
// never been shown to catch a REAL duplicate in the real document. This
// suite re-inserts the exact deleted line (recovered from
// `git show origin/next:CONTEXT.md`) into a copy of the REAL CONTEXT.md and
// runs the real generator CLI against it. ───────────────────────────────────

describe('gen-context-index.cjs --check against a real-CONTEXT.md duplicate (real-data proof)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gen-context-index-real-dup-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('reinsertingTheDeletedRulesetWorkflowMarkdownFencesLineFailsWithNamedDuplicate', () => {
    // The exact line this branch deleted from the real CONTEXT.md (does NOT
    // mention MD040 — the live line that replaced it does).
    const deletedLine =
      '`RULESET.WORKFLOW_MARKDOWN.FENCES=when editing shell snippets inside workflow markdown, preserve the opening language fence; malformed fence can create fresh CodeRabbit threads`';

    const real = fs.readFileSync(REAL_CONTEXT_PATH, 'utf8');
    assert.ok(
      real.includes('RULESET.WORKFLOW_MARKDOWN.FENCES'),
      'sanity: the real CONTEXT.md must still carry the live (MD040) FENCES line',
    );
    assert.ok(!real.includes(deletedLine), 'sanity: the deleted line must not already be present verbatim');

    const reinserted = real + '\n' + deletedLine + '\n';
    const fixturePath = path.join(tmpDir, 'CONTEXT-real-with-reinserted-duplicate.md');
    fs.writeFileSync(fixturePath, reinserted, 'utf8');

    const r = runGenContextIndex(['--check', '--json'], { contextPath: fixturePath });
    assert.equal(r.code, 1, 'a real duplicate reintroduced into the real CONTEXT.md must fail the gate');
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE);

    const report = parseJsonReport(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_DUPLICATE_IDS);
    assert.ok(
      report.duplicates.some((d) => d.id === 'RULESET.WORKFLOW_MARKDOWN.FENCES'),
      'report.duplicates must name RULESET.WORKFLOW_MARKDOWN.FENCES as the real duplicate',
    );
  });
});

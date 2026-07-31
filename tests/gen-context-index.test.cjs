'use strict';

/**
 * Integration tests for scripts/gen-context-index.cjs — the CI gate that
 * keeps gsd-core/bin/lib/context-index.cjs in sync with the predicates
 * declared in the repo-root CONTEXT.md (ADR-1671, #2928 Phase 1, rows F1-F17).
 *
 * FIXTURE-ISOLATION GAP (disclosed, not worked around): gen-context-index.cjs
 * hardcodes CONTEXT_PATH and INDEX_PATH to the real repo-root CONTEXT.md and
 * the real committed context-index.cjs — there is no --cwd flag or env
 * override to point it at a temp fixture tree. To exercise the real CLI
 * (spawnSync, not an engine-direct call — an engine-direct call is false-green
 * for CLI behavior per the design's own risk analysis) without ever mutating
 * the real repo files, every test here spawns the script under
 * tests/helpers/gen-context-index-fs-fixture.cjs, a `--require` preload that
 * redirects the exact two absolute paths the script reads/writes
 * (fs.readFileSync / fs.existsSync / fs.writeFileSync) to fixture paths
 * supplied via env vars — verified empirically that Node's own CJS loader
 * reads `require()`-d `.cjs` source through the same patchable
 * fs.readFileSync, so `require(INDEX_PATH)` inside the script also honors the
 * redirect. See that file's header comment for the full mechanism.
 *
 * Prohibited: Raw Text Matching on Test Outputs (CONTRIBUTING.md). This
 * generator has no --json mode — its --check/--write messages are
 * human-readable prose with no structured IR. Per this task's brief, that gap
 * is NOT worked around with a stdout regex: every assertion below is on exit
 * code, or on filesystem facts (the fixture index file's bytes), never on
 * message text. Rows that ask for "message names X" (F7, F8, F9, F10) are
 * therefore asserted only on exit code + no-bare-stack-trace here; the
 * message-content half of those rows needs a --json surface that does not
 * exist yet (reported to the orchestrator, not invented here).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { serializeIndex, buildFreshIndex } = require('../scripts/gen-context-index.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-context-index.cjs');
const PRELOAD = path.join(__dirname, 'helpers', 'gen-context-index-fs-fixture.cjs');
const REAL_CONTEXT_PATH = path.join(ROOT, 'CONTEXT.md');

const STACK_FRAME_RE = /\n\s+at\s+\S+\s+\(.*:\d+:\d+\)/;

/**
 * Spawn the real gen-context-index.cjs CLI through the fs-fixture preload.
 *
 * @param {string[]} args - CLI args (e.g. ['--check']).
 * @param {{contextMd?: string, index?: string}} [fixtures] - absolute fixture
 *   paths (or the '__FAULT__' sentinel for contextMd) to redirect the real
 *   CONTEXT.md / committed index reads+writes to. Omit a key to leave that
 *   seam untouched (real content, read-only).
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function runGenContextIndex(args, fixtures = {}) {
  const env = { ...process.env };
  if (fixtures.contextMd !== undefined) env.GSD_TEST_GCI_CONTEXT_MD = fixtures.contextMd;
  if (fixtures.index !== undefined) env.GSD_TEST_GCI_INDEX = fixtures.index;

  try {
    const stdout = execFileSync(process.execPath, ['--require', PRELOAD, SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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

describe('gen-context-index.cjs --check (F)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gen-context-index-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('checkExitsZeroWhenIndexIsFresh', () => {
    // Read-only against the real, already-fresh repo state — no redirect
    // needed, and nothing is mutated.
    const r = runGenContextIndex(['--check']);
    assert.equal(r.code, 0);
  });

  test('checkExitsZeroAfterPureLineShift', () => {
    // S5: the committed artifact carries no `line` field, so a pure line
    // shift in CONTEXT.md must not perturb the byte-identical serialization.
    // Verified empirically before writing this test (see task report): GREEN
    // today, not RED — S5 was already ported in the prior commit.
    const real = fs.readFileSync(REAL_CONTEXT_PATH, 'utf8');
    const lines = real.split(/\r?\n/);
    const shifted = [lines[0], '', '', ...lines.slice(1)].join('\n');
    const shiftedPath = path.join(tmpDir, 'CONTEXT-shifted.md');
    fs.writeFileSync(shiftedPath, shifted, 'utf8');

    const r = runGenContextIndex(['--check'], { contextMd: shiftedPath });
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

    const r = runGenContextIndex(['--check'], { contextMd: modifiedPath });
    assert.equal(r.code, 1);
  });

  test('checkExitsOneWhenPredicateAdded', () => {
    const real = fs.readFileSync(REAL_CONTEXT_PATH, 'utf8');
    const added = real + '\n`ZZZTEST.added-by-test=value`\n';
    const addedPath = path.join(tmpDir, 'CONTEXT-added.md');
    fs.writeFileSync(addedPath, added, 'utf8');

    const r = runGenContextIndex(['--check'], { contextMd: addedPath });
    assert.equal(r.code, 1);
  });

  test('checkExitsOneWhenPredicateRemoved', () => {
    const real = fs.readFileSync(REAL_CONTEXT_PATH, 'utf8');
    const removed = real.replace(/`RULESET\.PR-SCOPE\.one-concern-per-pr=[^`]*`\r?\n/, '');
    assert.notEqual(removed, real, 'fixture setup sanity: the removal must actually apply');
    const removedPath = path.join(tmpDir, 'CONTEXT-removed.md');
    fs.writeFileSync(removedPath, removed, 'utf8');

    const r = runGenContextIndex(['--check'], { contextMd: removedPath });
    assert.equal(r.code, 1);
  });

  test('checkExitsOneWhenClassSetChanged', () => {
    const real = fs.readFileSync(REAL_CONTEXT_PATH, 'utf8');
    const classGained = real + '\n`BRANDNEWCLASSFORTEST.x=y`\n';
    const classGainedPath = path.join(tmpDir, 'CONTEXT-class-gained.md');
    fs.writeFileSync(classGainedPath, classGained, 'utf8');

    const r = runGenContextIndex(['--check'], { contextMd: classGainedPath });
    assert.equal(r.code, 1);
  });

  test('checkExitsOneAndNamesDuplicateIdentifier', () => {
    const real = fs.readFileSync(REAL_CONTEXT_PATH, 'utf8');
    const dupPath = path.join(tmpDir, 'CONTEXT-dup.md');
    const dupIntroduced = real + '\n`RULESET.PR-SCOPE.one-concern-per-pr=duplicate copy for test`\n';
    fs.writeFileSync(dupPath, dupIntroduced, 'utf8');

    const r = runGenContextIndex(['--check'], { contextMd: dupPath });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'no bare stack trace in non-debug failure output');
  });

  test('checkExitsOneWithRemedyWhenIndexMissing', () => {
    const missingIndexPath = path.join(tmpDir, 'does-not-exist.cjs');
    const r = runGenContextIndex(['--check'], { index: missingIndexPath });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE);
  });

  test('checkExitsOneWithNamedReasonWhenIndexCorrupt', () => {
    const corruptIndexPath = path.join(tmpDir, 'corrupt-index.cjs');
    fs.writeFileSync(corruptIndexPath, 'this is not { valid javascript', 'utf8');

    const r = runGenContextIndex(['--check'], { index: corruptIndexPath });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'no bare stack trace for a corrupt committed index');
  });

  test('checkExitsOneWhenContextMdMissing', () => {
    const missingContextPath = path.join(tmpDir, 'does-not-exist.md');
    const r = runGenContextIndex(['--check'], { contextMd: missingContextPath });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'no bare stack trace when CONTEXT.md is missing');
  });

  test('checkExitsOneWhenContextMdUnreadable', () => {
    // Fault injection via the mandated technique: the fs-fixture preload
    // monkeypatches fs.readFileSync to throw an injected EACCES for the real
    // CONTEXT_PATH when this sentinel is set — never chmod 0o000 (root
    // bypasses mode bits; see CONTRIBUTING.md cross-platform IO-failure rule).
    const r = runGenContextIndex(['--check'], { contextMd: '__FAULT__' });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'a degraded fs fault must not crash with a raw stack trace');
  });

  test('checkIsCrlfAgnostic', () => {
    // F17: a CRLF-committed index compared against the (LF) fresh real
    // CONTEXT.md must still exit 0 — comparison is CRLF-normalized. Verified
    // empirically before writing this test: also GREEN today.
    const freshSerialized = serializeIndex(buildFreshIndex());
    const crlfSerialized = freshSerialized.replace(/\n/g, '\r\n');
    const crlfIndexPath = path.join(tmpDir, 'context-index-crlf.cjs');
    fs.writeFileSync(crlfIndexPath, crlfSerialized, 'utf8');

    const r = runGenContextIndex(['--check'], { index: crlfIndexPath });
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
    const writeTarget = path.join(tmpDir, 'write-target.cjs');
    const w = runGenContextIndex(['--write'], { index: writeTarget });
    assert.equal(w.code, 0);
    assert.ok(fs.existsSync(writeTarget), '--write must create the fixture-redirected index file');

    const c = runGenContextIndex(['--check'], { index: writeTarget });
    assert.equal(c.code, 0, '--check must be clean immediately after --write');
  });

  test('writeIsByteIdenticalAcrossRuns', () => {
    const target1 = path.join(tmpDir, 'w1.cjs');
    const target2 = path.join(tmpDir, 'w2.cjs');
    assert.equal(runGenContextIndex(['--write'], { index: target1 }).code, 0);
    assert.equal(runGenContextIndex(['--write'], { index: target2 }).code, 0);

    const content1 = fs.readFileSync(target1, 'utf8');
    const content2 = fs.readFileSync(target2, 'utf8');
    assert.equal(content1, content2, '--write must be deterministic across independent runs');
  });

  test('writtenIndexContainsNoLineField', () => {
    const target = path.join(tmpDir, 'no-line-field.cjs');
    assert.equal(runGenContextIndex(['--write'], { index: target }).code, 0);
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
});

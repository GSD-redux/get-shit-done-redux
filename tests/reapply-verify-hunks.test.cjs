/**
 * GSD Tools Tests - reapply-patches post-merge verification
 *
 * Validates that the reapply-patches workflow includes post-merge
 * verification to detect dropped hunks during three-way merge.
 *
 * Closes: #1758
 *
 * #2790: reapply-patches.md (combined command+workflow) was consolidated into
 * update.md as the --reapply flag. The workflow content now lives in
 * gsd-core/workflows/reapply-patches.md.
 */

// allow-test-rule: source-text-is-the-product
// gsd-core/workflows/reapply-patches.md is the installed runtime workflow —
// its text IS the deployed behavioral contract for the --reapply path.

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// 30000ms: shared by both folded `runVerifier()` blocks below — each runs a
// single deterministic verifier pass over a small mkdtemp fixture tree, well
// over any observed duration for this class of call.
const VERIFIER_TIMEOUT_MS = 30_000;

const WORKFLOW_PATH = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'reapply-patches.md'
);

function extractTagBlock(markdown, tagName) {
  const start = markdown.indexOf(`<${tagName}>`);
  const end = markdown.indexOf(`</${tagName}>`);
  assert.notEqual(start, -1, `Missing <${tagName}> block in workflow`);
  assert.notEqual(end, -1, `Missing </${tagName}> block in workflow`);
  return markdown.slice(start, end);
}

describe('reapply-patches post-merge verification (#1758)', () => {
  let content;

  before(() => {
    content = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  });

  test('workflow file contains "Post-merge verification" section', () => {
    assert.ok(
      content.includes('Post-merge verification'),
      'reapply-patches.md workflow must contain a "Post-merge verification" section'
    );
  });

  test('workflow mentions "Hunk presence check"', () => {
    assert.ok(
      content.includes('Hunk presence check'),
      'workflow must describe the hunk presence check step'
    );
  });

  test('workflow mentions "Line-count check"', () => {
    assert.ok(
      content.includes('Line-count check'),
      'workflow must describe the line-count verification step'
    );
  });

  test('success criteria includes verification', () => {
    // Scope to the structured <success_criteria> block so the assertion can't
    // false-pass when the phrase appears elsewhere (e.g. inline prose).
    const successCriteriaBlock = extractTagBlock(content, 'success_criteria');
    assert.ok(
      successCriteriaBlock.includes('Post-merge verification checks each file for dropped hunks'),
      'workflow success_criteria block must include post-merge verification requirement'
    );
  });

  test('verification warns but never auto-reverts', () => {
    assert.ok(
      content.includes('do not block') || content.includes('Report warnings inline'),
      'verification must warn and continue — never auto-revert'
    );
  });

  test('verification references backup availability for recovery', () => {
    assert.ok(
      content.includes('Backup available') || content.includes('backup available'),
      'verification warnings must reference backup path for manual recovery'
    );
  });

  test('verification tracks per-file status via Hunk Verification Table', () => {
    assert.ok(
      content.includes('Hunk Verification Table') &&
        content.includes('one row per hunk per file') &&
        content.includes('verified'),
      'workflow must track verification status per hunk per file via the Hunk Verification Table contract'
    );
  });

  test('verification section appears between merge-write and status-report steps', () => {
    const verifyIdx = content.indexOf('Post-merge verification');
    const writeIdx = content.indexOf('Write merged result');
    const reportIdx = content.indexOf('Step 7: Report');
    assert.notEqual(writeIdx, -1, 'Missing "Write merged result" anchor in reapply-patches.md');
    assert.notEqual(verifyIdx, -1, 'Missing "Post-merge verification" anchor in reapply-patches.md');
    assert.notEqual(reportIdx, -1, 'Missing "Step 7: Report" anchor in reapply-patches.md');
    assert.ok(
      writeIdx < verifyIdx && verifyIdx < reportIdx,
      'Post-merge verification must appear between "Write merged result" and "Step 7: Report"'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2969-verify-reapply-patches.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2969-verify-reapply-patches (consolidation epic #1969 B5 #1974)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2969: /gsd-reapply-patches Step 5 hunk verification gate reports
 * success on lost content because the LLM-driven workflow fills in
 * "verified: yes" without actually checking content presence.
 *
 * Fix: deterministic verifier script (scripts/verify-reapply-patches.cjs)
 * that the workflow calls.
 *
 * Per the repo's no-source-grep testing standard (CONTRIBUTING.md):
 * tests must assert on TYPED structured fields — not regex/substring
 * matching against script output, formatter prose, or file content.
 *
 * The script's --json mode emits a structured report whose `reason`
 * field is a stable enum (exposed as REASON), and whose `missing` field
 * is an array of typed strings (exact set membership, not substring).
 * Every assertion below is a deepEqual / equal / Array.includes against
 * those typed fields. Zero regex, zero String#includes on text.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');

const ROOT = path.join(__dirname, '..');
// Script lives at gsd-core/bin/ so the installer ships it under
// `${GSD_HOME}/gsd-core/bin/` (issue #2994). The top-level scripts/
// directory is not copied to user installs.
const SCRIPT = path.join(ROOT, 'gsd-core', 'bin', 'verify-reapply-patches.cjs');
const { REASON } = require(SCRIPT);

let tmpRoot;
let patchesDir;
let configDir;
let pristineDir;

function writeFile(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function resetFixture({ withPristine = true } = {}) {
  for (const dir of [patchesDir, configDir, pristineDir]) {
    cleanup(dir);
  }
  fs.mkdirSync(patchesDir);
  fs.mkdirSync(configDir);
  if (withPristine) fs.mkdirSync(pristineDir);
}

/** Runs the verifier with --json. Returns parsed structured report. */
function runVerifier({ includePristine = true } = {}) {
  const args = [
    SCRIPT,
    '--patches-dir', patchesDir,
    '--config-dir',  configDir,
    ...(includePristine ? ['--pristine-dir', pristineDir] : []),
    '--json',
  ];
  const r = runNode(args, { timeoutMs: VERIFIER_TIMEOUT_MS });
  return {
    status: r.exitCode,
    report: r.stdout && r.stdout.length ? JSON.parse(r.stdout) : null,
  };
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2969-'));
  patchesDir = path.join(tmpRoot, 'patches');
  configDir = path.join(tmpRoot, 'installed');
  pristineDir = path.join(tmpRoot, 'pristine');
  resetFixture();
});

after(() => {
  cleanup(tmpRoot);
});

describe('Bug #2969: deterministic Step 5 verification gate', () => {
  test('REASON enum exposes the documented set of stable codes', () => {
    // Locks the public diagnostic surface — adding a code requires updating
    // this assertion, removing one breaks consumers that switch on the enum.
    // Bug #3657 added OK_PRISTINE_DRIFT_DETECTED.
    // Bug #934 added OK_NO_BASELINE.
    // Bug #4136 added OK_UNVALIDATED_BASELINE (--classify refuses to confirm
    // adoption on an on-disk snapshot with no recorded hash to validate it).
    assert.deepEqual(
      Object.keys(REASON).sort(),
      [
        'FAIL_INSTALLED_MISSING',
        'FAIL_INSTALLED_NOT_REGULAR_FILE',
        'FAIL_READ_ERROR',
        'FAIL_USER_LINES_MISSING',
        'OK_NO_BASELINE',
        'OK_NO_SIGNIFICANT_BACKUP_LINES',
        'OK_NO_USER_LINES_VS_PRISTINE',
        'OK_PRISTINE_DRIFT_DETECTED',
        'OK_UNVALIDATED_BASELINE',
      ],
    );
  });

  test('exits 0 with status=ok when every user-added line is present in the merged file', () => {
    resetFixture();
    const pristine = 'line one of stock content here\nline two of stock content here\nline three of stock content here\n';
    const userAdded = 'a custom line the user added for behavior X\nanother substantial line that the user inserted\n';

    writeFile(path.join(pristineDir, 'skills', 'foo', 'SKILL.md'), pristine);
    writeFile(path.join(patchesDir, 'skills', 'foo', 'SKILL.md'), pristine + userAdded);
    writeFile(path.join(configDir, 'skills', 'foo', 'SKILL.md'), pristine + userAdded);

    const { status, report } = runVerifier();
    assert.equal(status, 0);
    assert.equal(report.failures, 0);
    assert.equal(report.checked, 1);
    assert.equal(report.results[0].status, 'ok');
    assert.deepEqual(report.results[0].missing, []);
  });

  test('reason=FAIL_USER_LINES_MISSING with the exact dropped line in .missing[]', () => {
    resetFixture();
    const pristine = 'first stock line in the original file here\nsecond stock line in the original file here\n';
    const lostLine = 'this is the visual companion block that must survive';
    writeFile(path.join(pristineDir, 'skills', 'discuss-phase', 'SKILL.md'), pristine);
    writeFile(path.join(patchesDir, 'skills', 'discuss-phase', 'SKILL.md'), `${pristine}${lostLine}\n`);
    writeFile(path.join(configDir, 'skills', 'discuss-phase', 'SKILL.md'), pristine);

    const { status, report } = runVerifier();
    assert.equal(status, 1);
    assert.equal(report.failures, 1);
    const r0 = report.results[0];
    // Normalize separators: on Windows the SUT emits 'skills\discuss-phase\SKILL.md'.
    assert.equal(r0.file.replace(/\\/g, '/'), 'skills/discuss-phase/SKILL.md');
    assert.equal(r0.status, 'fail');
    assert.equal(r0.reason, REASON.FAIL_USER_LINES_MISSING);
    assert.ok(
      r0.missing.includes(lostLine),
      `dropped line should be in .missing[]; got ${JSON.stringify(r0.missing)}`,
    );
  });

  test('reason=FAIL_INSTALLED_NOT_REGULAR_FILE when installed path is a directory', () => {
    resetFixture();
    writeFile(path.join(pristineDir, 'a.md'), 'pristine line of substantial content here\n');
    writeFile(path.join(patchesDir, 'a.md'), 'pristine line of substantial content here\nuser added line that is substantial\n');
    fs.mkdirSync(path.join(configDir, 'a.md')); // EISDIR trap

    const { status, report } = runVerifier();
    assert.equal(status, 1);
    assert.equal(report.results[0].status, 'fail');
    assert.equal(report.results[0].reason, REASON.FAIL_INSTALLED_NOT_REGULAR_FILE);
  });

  test('reason=FAIL_INSTALLED_MISSING when the merged file has been deleted', () => {
    resetFixture();
    const pristine = 'stock line one with substantial content for the test\n';
    writeFile(path.join(pristineDir, 'workflow.md'), pristine);
    writeFile(path.join(patchesDir, 'workflow.md'), `${pristine}user line that should survive but does not\n`);
    // configDir intentionally missing the file.

    const { status, report } = runVerifier();
    assert.equal(status, 1);
    assert.equal(report.results[0].status, 'fail');
    assert.equal(report.results[0].reason, REASON.FAIL_INSTALLED_MISSING);
  });

  test('--json report has the documented shape: { checked, failures, results: [{ file, status, missing, reason }] }', () => {
    resetFixture();
    const pristine = 'pristine line that is sufficiently long to be significant\n';
    const userAdded = 'extra line the user wrote for their workflow customisation';
    writeFile(path.join(pristineDir, 'a.md'), pristine);
    writeFile(path.join(patchesDir, 'a.md'), `${pristine}${userAdded}\n`);
    writeFile(path.join(configDir, 'a.md'), pristine);

    const { status, report } = runVerifier();
    assert.equal(status, 1);
    // Bug #3657 (Finding 1): drifted + drifted_files are additive fields added to surface
    // pristine-drift skips distinctly from failures.  Shape-lock updated to include them.
    // Bug #934: no_baseline + no_baseline_files are additive fields for missing-pristine advisory.
    // Bug #4135: baseline_covered is the additive coverage aggregate (headline reporting).
    assert.deepEqual(Object.keys(report).sort(), ['baseline_covered', 'checked', 'drifted', 'drifted_files', 'failures', 'no_baseline', 'no_baseline_files', 'results']);
    const r0 = report.results[0];
    assert.deepEqual(Object.keys(r0).sort(), ['file', 'missing', 'reason', 'status']);
    assert.equal(typeof r0.file, 'string');
    assert.equal(typeof r0.status, 'string');
    assert.equal(typeof r0.reason, 'string');
    assert.ok(Array.isArray(r0.missing));
  });

  test('ignores backup-meta.json — it is metadata, not a patched file', () => {
    resetFixture();
    writeFile(path.join(patchesDir, 'backup-meta.json'), JSON.stringify({ files: [] }));

    const { status, report } = runVerifier();
    assert.equal(status, 0);
    assert.equal(report.checked, 0);
    assert.equal(report.failures, 0);
    assert.deepEqual(report.results, []);
  });

  test('without --pristine-dir, treats every significant backup line as required (safe over-broad fallback)', () => {
    resetFixture({ withPristine: false });
    const presentLine = 'this is a substantial line of user content here';
    const droppedLine = 'another substantial line that should survive';
    writeFile(path.join(patchesDir, 'b.md'), `${presentLine}\n${droppedLine}\n`);
    writeFile(path.join(configDir, 'b.md'), `${presentLine}\n`);

    const { status, report } = runVerifier({ includePristine: false });
    assert.equal(status, 1);
    assert.equal(report.results[0].reason, REASON.FAIL_USER_LINES_MISSING);
    assert.ok(report.results[0].missing.includes(droppedLine));
    assert.ok(!report.results[0].missing.includes(presentLine));
  });

  test('treats gsd-hook-version install-time substitution as upstream-owned, not missing user content (#229)', () => {
    resetFixture();
    const rel = path.join('hooks', 'gsd-statusline.js');
    const pristine = [
      '// gsd-hook-version: {{GSD_VERSION}}',
      'console.log("statusline hook");',
      '',
    ].join('\n');
    const backup = [
      '// gsd-hook-version: 1.41.0',
      'console.log("statusline hook");',
      '',
    ].join('\n');
    const installed = [
      '// gsd-hook-version: 1.42.3',
      'console.log("statusline hook");',
      '',
    ].join('\n');

    writeFile(path.join(pristineDir, rel), pristine);
    writeFile(path.join(patchesDir, rel), backup);
    writeFile(path.join(configDir, rel), installed);

    const { status, report } = runVerifier();
    assert.equal(status, 0, `expected pass for upstream-owned version substitution; report=${JSON.stringify(report)}`);
    assert.equal(report.failures, 0);
    assert.equal(report.checked, 1);
    assert.equal(report.results[0].status, 'ok');
    assert.deepStrictEqual(report.results[0].missing, []);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3657-verify-reapply-patches-pristine-drift.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3657-verify-reapply-patches-pristine-drift (consolidation epic #1969 B5 #1974)", () => {
// allow-test-rule: source-text-is-the-product — Finding 2 reads reapply-patches.md to (see #3657)
// assert structural presence of the Step 5a drift-check block; the .md file is the
// product (workflow instructions consumed by AI agents), not a source .cjs file.
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #3657: verify-reapply-patches false-fails when gsd-pristine/ snapshot is
 * newer than backup-meta baseline.
 *
 * Root cause: the verifier computes user-added lines as
 *   diff(backup, pristine_on_disk)
 * but pristine_on_disk is from a LATER GSD version than the one captured in
 * backup-meta.json.pristine_hashes.  Lines present in the backup but removed by
 * the upstream update appear as "user-added lines that must survive", causing
 * FAIL_USER_LINES_MISSING false positives even when the user's real
 * customisation survived the merge.
 *
 * Fix: when backup-meta.json contains `pristine_hashes` and the on-disk
 * pristine file's SHA-256 does NOT match the recorded hash, the verifier must
 * skip the stale pristine and fall back to the over-broad mode (treating every
 * significant backup line as required) rather than computing a diff against the
 * wrong baseline.  Over-broad mode still passes if all backup lines are present
 * in the installed file — it never false-fails for a DIFFERENT reason.
 *
 * Per CONTRIBUTING.md testing standard: assert on typed structured fields from
 * the --json report and the REASON frozen enum. Zero regex / String#includes on
 * formatter prose.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'gsd-core', 'bin', 'verify-reapply-patches.cjs');
const { REASON } = require(SCRIPT);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpRoot;
let patchesDir;
let configDir;
let pristineDir;

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeFile(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function writeBackupMeta(overrides = {}) {
  const meta = { pristine_hashes: {}, ...overrides };
  writeFile(path.join(patchesDir, 'backup-meta.json'), JSON.stringify(meta, null, 2));
}

function resetFixture() {
  for (const dir of [patchesDir, configDir, pristineDir]) {
    cleanup(dir);
  }
  fs.mkdirSync(patchesDir);
  fs.mkdirSync(configDir);
  fs.mkdirSync(pristineDir);
}

/** Runs the verifier with --json. Returns { status, report }. */
function runVerifier({ pristine = true } = {}) {
  const args = [
    SCRIPT,
    '--patches-dir', patchesDir,
    '--config-dir',  configDir,
    ...(pristine ? ['--pristine-dir', pristineDir] : []),
    '--json',
  ];
  const r = runNode(args, { timeoutMs: VERIFIER_TIMEOUT_MS });
  return {
    status: r.exitCode,
    report: r.stdout && r.stdout.length ? JSON.parse(r.stdout) : null,
  };
}

before(() => {
  tmpRoot    = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3657-'));
  patchesDir = path.join(tmpRoot, 'patches');
  configDir  = path.join(tmpRoot, 'installed');
  pristineDir = path.join(tmpRoot, 'pristine');
  resetFixture();
});

after(() => {
  cleanup(tmpRoot);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bug #3657: pristine-drift does not produce false FAIL_USER_LINES_MISSING', () => {

  /**
   * Core regression: the user has one real customisation line.  The pristine
   * snapshot on disk is a NEWER version that removed a line that was in the
   * backup (v_old pristine).  Without the fix, the removed-upstream line
   * appears as a "user-added line" that is missing from the installed file,
   * causing a spurious failure.  With the fix, the verifier detects hash
   * mismatch and skips the stale pristine, so only the real user line is
   * checked — which IS present — and the run exits 0.
   */
  test('exits 0 with reason=OK_PRISTINE_DRIFT_DETECTED when on-disk pristine hash does not match recorded hash', () => {
    resetFixture();

    const FILE = 'agents/gsd-executor.md';

    // v_old pristine: the file as it existed when the backup was made.
    const oldPristineContent =
      'line present in old pristine and also in backup\n' +
      'another stock line that was present in old pristine\n';

    // The user added one customisation line on top of v_old pristine.
    const backupContent =
      oldPristineContent +
      'model: sonnet in frontmatter — the user customisation to preserve\n';

    // The installer later refreshed gsd-pristine/ to v_new.
    // The upstream update removed the second stock line entirely.
    const newPristineContent =
      'line present in old pristine and also in backup\n' +
      'brand-new upstream line added in the newer version here\n';

    // After reapply-patches, the installed file has the new upstream content
    // PLUS the user's real customisation.
    const installedContent =
      newPristineContent +
      'model: sonnet in frontmatter — the user customisation to preserve\n';

    // backup-meta.json records the SHA-256 of the OLD pristine content.
    writeBackupMeta({ pristine_hashes: { [FILE]: sha256(oldPristineContent) } });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), installedContent);
    // The pristine dir has the NEW (mismatched) version.
    writeFile(path.join(pristineDir, FILE), newPristineContent);

    const { status, report } = runVerifier();

    // Must exit 0: drift detected, file skipped with diagnostic code rather
    // than false-failing. The user's real line cannot be verified without the
    // correct baseline, but the gate must not halt on a false alarm.
    assert.equal(status, 0, `expected exit 0 (no failures); got ${status}; report=${JSON.stringify(report)}`);
    assert.equal(report.failures, 0, `expected 0 failures; got ${report.failures}`);
    const r0 = report.results[0];
    assert.equal(r0.status, 'ok');
    assert.equal(r0.reason, REASON.OK_PRISTINE_DRIFT_DETECTED,
      `expected OK_PRISTINE_DRIFT_DETECTED; got ${r0.reason}`);
    assert.deepEqual(r0.missing, []);
  });

  /**
   * Counter-test (anti-false-positive): when pristine on-disk MATCHES the
   * recorded hash (no drift), a real user-added line that was dropped from
   * the installed file must still be caught as FAIL_USER_LINES_MISSING.
   * The hash-mismatch guard must not suppress legitimate failures.
   */
  test('still catches FAIL_USER_LINES_MISSING when pristine matches recorded hash', () => {
    resetFixture();

    const FILE = 'agents/gsd-executor.md';

    const pristineContent =
      'stock line one that is long enough to be significant\n' +
      'stock line two that is also long enough to matter\n';

    const droppedLine = 'model: sonnet in frontmatter — the user customisation that was lost';
    const backupContent = pristineContent + droppedLine + '\n';

    // Installed file is missing the user's line — a real failure.
    const installedContent = pristineContent;

    // backup-meta records hash of the SAME pristine currently on disk (no drift).
    writeBackupMeta({ pristine_hashes: { [FILE]: sha256(pristineContent) } });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), installedContent);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const { status, report } = runVerifier();

    assert.equal(status, 1, 'expected exit 1 (real failure should be caught)');
    assert.equal(report.failures, 1);
    const r0 = report.results[0];
    assert.equal(r0.status, 'fail');
    assert.equal(r0.reason, REASON.FAIL_USER_LINES_MISSING);
    assert.ok(
      r0.missing.includes(droppedLine),
      `dropped user line must appear in .missing[]; got ${JSON.stringify(r0.missing)}`,
    );
  });

  /**
   * Counter-test (pristine present but no backup-meta.json): behaviour must
   * be unchanged from the pre-fix code — use whatever pristine is on disk
   * without hash validation (backup-meta is absent so no recorded hash).
   */
  test('uses on-disk pristine normally when backup-meta.json is absent (no hash to check)', () => {
    resetFixture();
    // No backup-meta.json written — simulate older installer that never recorded hashes.

    const FILE = 'workflow.md';
    const pristineContent = 'stock line that is long enough to be significant in the file\n';
    const droppedLine = 'user line that was added but dropped from the merged install';
    const backupContent = pristineContent + droppedLine + '\n';
    const installedContent = pristineContent; // user line was dropped

    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), installedContent);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const { status, report } = runVerifier();

    // Should still catch the dropped user line via normal pristine diff.
    assert.equal(status, 1);
    assert.equal(report.failures, 1);
    assert.equal(report.results[0].reason, REASON.FAIL_USER_LINES_MISSING);
    assert.ok(report.results[0].missing.includes(droppedLine));
  });

  /**
   * Counter-test (pristine matches AND user line present): clean run must
   * report 0 failures — no false positives even with hash-validation active.
   */
  test('reports 0 failures when pristine matches recorded hash and user line is present', () => {
    resetFixture();

    const FILE = 'skills/custom/SKILL.md';
    const pristineContent = 'stock line one with sufficient length to be significant\n';
    const userLine = 'user custom instruction that the user intentionally added here';
    const backupContent = pristineContent + userLine + '\n';
    const installedContent = backupContent; // user line survived

    writeBackupMeta({ pristine_hashes: { [FILE]: sha256(pristineContent) } });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), installedContent);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const { status, report } = runVerifier();

    assert.equal(status, 0);
    assert.equal(report.failures, 0);
    assert.equal(report.results[0].status, 'ok');
  });

  /**
   * Multi-file regression: two files; one with hash drift (should not false-fail),
   * one with no drift but a real dropped line (should catch it).
   * Verifies that per-file hash checking is independent.
   */
  test('handles mixed drift + real-failure across multiple files independently', () => {
    resetFixture();

    const DRIFT_FILE  = 'agents/gsd-executor.md';
    const CLEAN_FILE  = 'workflows/update.md';

    const driftOldPristine  = 'old upstream line that was removed in newer pristine version\n';
    const driftNewPristine  = 'brand-new upstream replacement line in the refreshed snapshot\n';
    const driftUserLine     = 'model: sonnet — the user customisation that survived reapply';
    const driftBackup       = driftOldPristine + driftUserLine + '\n';
    const driftInstalled    = driftNewPristine + driftUserLine + '\n';

    const cleanPristine     = 'stock workflow line long enough to pass significance threshold\n';
    const cleanDroppedLine  = 'user workflow customisation that was lost in the merge operation';
    const cleanBackup       = cleanPristine + cleanDroppedLine + '\n';
    const cleanInstalled    = cleanPristine; // dropped

    writeBackupMeta({
      pristine_hashes: {
        [DRIFT_FILE]: sha256(driftOldPristine),
        [CLEAN_FILE]: sha256(cleanPristine),
      },
    });

    writeFile(path.join(patchesDir, DRIFT_FILE), driftBackup);
    writeFile(path.join(configDir,  DRIFT_FILE), driftInstalled);
    writeFile(path.join(pristineDir, DRIFT_FILE), driftNewPristine); // hash mismatch

    writeFile(path.join(patchesDir, CLEAN_FILE), cleanBackup);
    writeFile(path.join(configDir,  CLEAN_FILE), cleanInstalled);
    writeFile(path.join(pristineDir, CLEAN_FILE), cleanPristine); // hash matches

    const { status, report } = runVerifier();

    // Exactly 1 failure (the clean file with the genuinely dropped line).
    assert.equal(report.failures, 1, `expected 1 failure; got ${report.failures}; report=${JSON.stringify(report, null, 2)}`);
    assert.equal(status, 1);

    const driftResult = report.results.find(
      (r) => r.file.replace(/\\/g, '/') === DRIFT_FILE,
    );
    const cleanResult = report.results.find(
      (r) => r.file.replace(/\\/g, '/') === CLEAN_FILE,
    );

    assert.ok(driftResult, 'drift file result must be present in report');
    assert.ok(cleanResult, 'clean file result must be present in report');

    assert.equal(driftResult.status, 'ok', 'drift file must not false-fail');
    assert.equal(driftResult.reason, REASON.OK_PRISTINE_DRIFT_DETECTED,
      `drift file must report OK_PRISTINE_DRIFT_DETECTED; got ${driftResult.reason}`);
    assert.equal(cleanResult.status, 'fail', 'clean file with dropped line must fail');
    assert.equal(cleanResult.reason, REASON.FAIL_USER_LINES_MISSING);
    assert.ok(cleanResult.missing.includes(cleanDroppedLine));
  });

  /**
   * REASON enum shape-lock: the #3657 fix adds OK_PRISTINE_DRIFT_DETECTED.
   * This assertion locks the updated documented set of stable codes.
   * Any further additions require updating this assertion.
   * Bug #4136 added OK_UNVALIDATED_BASELINE (see the #2969 fold's lock note).
   */
  test('REASON enum includes OK_PRISTINE_DRIFT_DETECTED added by the #3657 fix', () => {
    assert.deepEqual(
      Object.keys(REASON).sort(),
      [
        'FAIL_INSTALLED_MISSING',
        'FAIL_INSTALLED_NOT_REGULAR_FILE',
        'FAIL_READ_ERROR',
        'FAIL_USER_LINES_MISSING',
        'OK_NO_BASELINE',
        'OK_NO_SIGNIFICANT_BACKUP_LINES',
        'OK_NO_USER_LINES_VS_PRISTINE',
        'OK_PRISTINE_DRIFT_DETECTED',
        'OK_UNVALIDATED_BASELINE',
      ],
    );
  });

  // ---------------------------------------------------------------------------
  // Finding 1 (BLOCKER) — drifted_files report shape
  // Asserts that the JSON report top-level carries `drifted` count +
  // `drifted_files` array so that workflow Step 5a has structured data to gate
  // on.  Per-file shape is unchanged (backward compat).
  // ---------------------------------------------------------------------------

  /**
   * Single drifted file: the top-level `drifted` count must be 1 and
   * `drifted_files` must contain the relative path of the drifted file.
   * The `failures` count must remain 0 (drift ≠ failure).
   */
  test('Finding 1: JSON report includes top-level drifted count and drifted_files when drift is detected', () => {
    resetFixture();

    const FILE = 'agents/gsd-executor.md';
    const oldPristineContent = 'old pristine line that was present when backup was captured\n';
    const newPristineContent = 'new upstream line in the refreshed pristine snapshot version\n';
    const userLine = 'user customisation line that should be preserved across updates';
    const backupContent = oldPristineContent + userLine + '\n';
    const installedContent = newPristineContent + userLine + '\n';

    writeBackupMeta({ pristine_hashes: { [FILE]: sha256(oldPristineContent) } });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), installedContent);
    writeFile(path.join(pristineDir, FILE), newPristineContent); // hash mismatch → drift

    const { status, report } = runVerifier();

    // Script exits 0 — drift is not a failure.
    assert.equal(status, 0, `expected exit 0; got ${status}`);
    assert.equal(report.failures, 0, 'failures must be 0 — drift is not a failure');

    // Finding 1: top-level drifted fields must be present and accurate.
    assert.equal(typeof report.drifted, 'number', 'report.drifted must be a number');
    assert.equal(report.drifted, 1, `expected drifted=1; got ${report.drifted}`);
    assert.ok(Array.isArray(report.drifted_files), 'report.drifted_files must be an array');
    assert.equal(report.drifted_files.length, 1, `expected 1 drifted_files entry; got ${report.drifted_files.length}`);
    // Normalize path separator so test passes on Windows worktrees too.
    assert.equal(
      report.drifted_files[0].replace(/\\/g, '/'),
      FILE,
      `drifted_files[0] must equal the drifted file path; got ${report.drifted_files[0]}`,
    );

    // Per-file shape is unchanged for backward compat.
    const r0 = report.results.find((r) => r.file.replace(/\\/g, '/') === FILE);
    assert.ok(r0, 'per-file result must be present');
    assert.equal(r0.status, 'ok');
    assert.equal(r0.reason, REASON.OK_PRISTINE_DRIFT_DETECTED);
  });

  /**
   * Multi-file drift: two files drifted, one clean pass. Asserts that the
   * `drifted` count is 2 and `drifted_files` lists both relative paths.
   * Confirms `failures` stays at 0.
   */
  test('Finding 1: drifted count and drifted_files aggregate correctly across multiple drifted files', () => {
    resetFixture();

    const FILE_A = 'agents/gsd-executor.md';
    const FILE_B = 'workflows/update.md';
    const FILE_C = 'skills/custom/SKILL.md';

    const oldPristineA = 'old pristine content for file A that was captured at backup time\n';
    const newPristineA = 'refreshed upstream content for file A in the newer GSD snapshot\n';
    const oldPristineB = 'old pristine content for file B that was captured at backup time\n';
    const newPristineB = 'refreshed upstream content for file B in the newer GSD snapshot\n';
    const pristineC   = 'stable pristine for file C — this one did not drift between versions\n';
    const userLineC   = 'user customisation for file C that survived the merge successfully';

    writeBackupMeta({
      pristine_hashes: {
        [FILE_A]: sha256(oldPristineA),
        [FILE_B]: sha256(oldPristineB),
        [FILE_C]: sha256(pristineC),
      },
    });

    // FILE_A: drifted (hash mismatch)
    writeFile(path.join(patchesDir, FILE_A), oldPristineA + 'user line A\n');
    writeFile(path.join(configDir,  FILE_A), newPristineA + 'user line A\n');
    writeFile(path.join(pristineDir, FILE_A), newPristineA); // mismatch

    // FILE_B: drifted (hash mismatch)
    writeFile(path.join(patchesDir, FILE_B), oldPristineB + 'user line B\n');
    writeFile(path.join(configDir,  FILE_B), newPristineB + 'user line B\n');
    writeFile(path.join(pristineDir, FILE_B), newPristineB); // mismatch

    // FILE_C: clean (hash matches, user line present)
    writeFile(path.join(patchesDir, FILE_C), pristineC + userLineC + '\n');
    writeFile(path.join(configDir,  FILE_C), pristineC + userLineC + '\n');
    writeFile(path.join(pristineDir, FILE_C), pristineC); // matches

    const { status, report } = runVerifier();

    assert.equal(status, 0, `expected exit 0; got ${status}`);
    assert.equal(report.failures, 0, 'failures must be 0');
    assert.equal(report.drifted, 2, `expected drifted=2; got ${report.drifted}`);
    assert.ok(Array.isArray(report.drifted_files), 'drifted_files must be an array');
    assert.equal(report.drifted_files.length, 2);
    const normalised = report.drifted_files.map((f) => f.replace(/\\/g, '/'));
    assert.ok(normalised.includes(FILE_A), `drifted_files must include ${FILE_A}`);
    assert.ok(normalised.includes(FILE_B), `drifted_files must include ${FILE_B}`);
    assert.ok(!normalised.includes(FILE_C), `drifted_files must NOT include the clean file ${FILE_C}`);
  });

  /**
   * No-drift baseline: when no files have hash mismatch, the top-level
   * `drifted` field must be 0 and `drifted_files` must be an empty array.
   * Verifies the additive fields are always present (not omitted on clean runs).
   */
  test('Finding 1: drifted=0 and drifted_files=[] when no files have pristine drift', () => {
    resetFixture();

    const FILE = 'skills/custom/SKILL.md';
    const pristineContent = 'stable pristine content that did not change between versions\n';
    const userLine = 'user customisation that survived correctly into the merged file';
    const backupContent = pristineContent + userLine + '\n';
    const installedContent = backupContent; // user line survived

    writeBackupMeta({ pristine_hashes: { [FILE]: sha256(pristineContent) } });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir,  FILE), installedContent);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const { status, report } = runVerifier();

    assert.equal(status, 0);
    assert.equal(report.failures, 0);
    assert.equal(report.drifted, 0, `expected drifted=0 on clean run; got ${report.drifted}`);
    assert.ok(Array.isArray(report.drifted_files), 'drifted_files must always be an array');
    assert.equal(report.drifted_files.length, 0, 'drifted_files must be empty on clean run');
  });

  // ---------------------------------------------------------------------------
  // Finding 2 (WARNING) — workflow Step 5a drift-check structural test
  // Asserts that the workflow markdown source now contains the drift-check
  // section that gates on `DRIFTED_COUNT > 0`.  Treating the .md source as
  // the product per allow-test-rule:source-text-is-the-product. (see #3657)
  // ---------------------------------------------------------------------------

  /**
   * Structural assertion: the workflow source must now contain the drift-check
   * block that Step 5a uses to halt on drifted files.  This guarantees that the
   * workflow consumer gate exists and uses the structured `drifted` / `drifted_files`
   * fields that Finding 1 added to the JSON report.
   */
  test('Finding 2: workflow Step 5a source contains drift-check section for DRIFTED_COUNT gate', () => {
    const workflowPath = path.join(ROOT, 'gsd-core', 'workflows', 'reapply-patches.md');
    const workflowSource = fs.readFileSync(workflowPath, 'utf8');

    // The drift-check block must be present in Step 5a.
    assert.ok(
      workflowSource.includes('Step 5a: drift check'),
      'workflow must contain "Step 5a: drift check" heading',
    );

    // Must gate on the drifted count field from the JSON report.
    assert.ok(
      workflowSource.includes('DRIFTED_COUNT'),
      'workflow must reference DRIFTED_COUNT so it gates on the structured drifted field',
    );

    // Must reference drifted_files so the halt message names each drifted path.
    assert.ok(
      workflowSource.includes('drifted_files'),
      'workflow must reference drifted_files to name each drifted path in the halt message',
    );

    // Must instruct the user to resolve drift before re-running.
    assert.ok(
      workflowSource.includes('DRIFT_DETECTED'),
      'workflow must set DRIFT_DETECTED flag when drift is found (signals halt to subsequent steps)',
    );

    // The drift check must appear BEFORE the VERIFY_STATUS non-zero check.
    // (Drift can be present even when exit code is 0.)
    const driftCheckPos    = workflowSource.indexOf('Step 5a: drift check');
    const verifyStatusPos  = workflowSource.indexOf('If `VERIFY_STATUS` is non-zero');
    assert.ok(
      driftCheckPos < verifyStatusPos,
      'drift-check block must appear before the VERIFY_STATUS non-zero check in Step 5a',
    );
  });
});

// ---------------------------------------------------------------------------
// Bug #934: OK_NO_BASELINE — pristine dir provided, hash recorded, but file absent
// ---------------------------------------------------------------------------

describe('Bug #934: OK_NO_BASELINE when recordedHash present but pristine file absent', () => {

  /**
   * Core regression: backup-meta.json has a pristine_hash for the file but
   * the gsd-pristine/ snapshot is absent from disk (the installer's
   * saveLocalPatches discarded the only candidate because its hash did not
   * match the old-release hash — the file changed upstream between releases).
   * Without the fix the verifier falls to over-broad mode and treats every
   * upstream-removed line as a "user-added line that must survive", producing
   * FAIL_USER_LINES_MISSING false positives.
   * With the fix the verifier returns OK_NO_BASELINE (non-blocking, advisory).
   */
  test('exits 0 with reason=OK_NO_BASELINE when recordedHash present but pristine absent', () => {
    resetFixture();

    const FILE = 'gsd-core/workflows/execute-phase.md';

    // The backup contains both the old upstream content and the user's line.
    const backupContent =
      'upstream line that was present in 1.4.0 but removed in 1.4.2 release\n' +
      'another upstream line removed upstream between gsd-core releases here\n' +
      'model: sonnet in frontmatter — this is the real user customisation line\n';

    // The installed file has the new upstream content + the user's real line.
    const installedContent =
      'brand-new upstream line that replaced the old content in gsd-core 1.4.2\n' +
      'model: sonnet in frontmatter — this is the real user customisation line\n';

    // backup-meta.json records a hash (modern installer) but gsd-pristine/ is absent.
    writeBackupMeta({ pristine_hashes: { [FILE]: 'sha256:deadbeef00000000000000000000000000000000000000000000000000000001' } });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), installedContent);
    // Deliberately do NOT write a pristine file — this is the gap-1 scenario.

    const { status, report } = runVerifier();

    // Must exit 0: cannot reason without baseline → non-blocking advisory.
    assert.equal(status, 0, `expected exit 0; got ${status}; report=${JSON.stringify(report)}`);
    assert.equal(report.failures, 0, `expected 0 failures; got ${report.failures}`);
    const r0 = report.results[0];
    assert.equal(r0.status, 'ok', `expected status ok; got ${r0.status}`);
    assert.equal(r0.reason, REASON.OK_NO_BASELINE,
      `expected OK_NO_BASELINE; got ${r0.reason}`);
    assert.deepEqual(r0.missing, []);
  });

  /**
   * Counter-test: when pristine is absent but NO recordedHash is present
   * (pre-fix installer that never wrote backup-meta.json), the verifier must
   * still fall to over-broad mode — the old behaviour for untracked backups.
   * OK_NO_BASELINE must NOT fire in this case.
   */
  test('falls through to over-broad mode when pristine absent AND no recordedHash', () => {
    resetFixture();

    const FILE = 'gsd-core/workflows/plan-phase.md';
    const droppedLine = 'user-added instruction that was dropped from the install output';
    const backupContent =
      'stock upstream line long enough to be significant in the file\n' +
      droppedLine + '\n';
    const installedContent = 'stock upstream line long enough to be significant in the file\n';

    // No backup-meta.json — simulates pre-fix installer with no hash records.
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), installedContent);
    // No pristine file.

    const { status, report } = runVerifier();

    // Over-broad mode catches the genuinely dropped user line.
    assert.equal(status, 1, 'over-broad mode should catch the dropped user line');
    assert.equal(report.failures, 1);
    const r0 = report.results[0];
    assert.equal(r0.status, 'fail');
    assert.equal(r0.reason, REASON.FAIL_USER_LINES_MISSING);
    assert.ok(r0.missing.includes(droppedLine),
      `dropped line must appear in .missing[]; got ${JSON.stringify(r0.missing)}`);
    // Must NOT be OK_NO_BASELINE — that only fires when a hash WAS recorded.
    assert.notEqual(r0.reason, REASON.OK_NO_BASELINE);
  });

  /**
   * Presence check: when pristine IS present AND hash matches, the normal
   * flow must proceed (not short-circuit to OK_NO_BASELINE).
   * A real dropped user line must still be caught.
   */
  test('does not short-circuit to OK_NO_BASELINE when pristine exists and hash matches', () => {
    resetFixture();

    const FILE = 'gsd-core/workflows/plan-phase.md';
    const pristineContent = 'stock upstream line long enough to be significant content\n';
    const droppedLine = 'user customisation that was genuinely dropped from the merged output';
    const backupContent = pristineContent + droppedLine + '\n';
    const installedContent = pristineContent; // user line dropped — real failure

    writeBackupMeta({ pristine_hashes: { [FILE]: sha256(pristineContent) } });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), installedContent);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const { status, report } = runVerifier();

    assert.equal(status, 1, 'real dropped user line must be caught');
    assert.equal(report.failures, 1);
    const r0 = report.results[0];
    assert.equal(r0.status, 'fail');
    assert.equal(r0.reason, REASON.FAIL_USER_LINES_MISSING);
    assert.notEqual(r0.reason, REASON.OK_NO_BASELINE);
    assert.ok(r0.missing.includes(droppedLine));
  });

  /**
   * When --pristine-dir is NOT provided at all (old CLI invocation without the
   * flag), the OK_NO_BASELINE path must never fire — there is no pristine dir
   * context to consult and the old over-broad behaviour must be preserved.
   */
  test('does not return OK_NO_BASELINE when --pristine-dir is not provided', () => {
    resetFixture();

    const FILE = 'gsd-core/workflows/execute-phase.md';
    const backupContent =
      'upstream line removed in newer version but present in backup\n' +
      'model: sonnet — user customisation line in the backup file\n';
    const installedContent =
      'replacement upstream line in the newer release version\n' +
      'model: sonnet — user customisation line in the backup file\n';

    // Record a hash — but no pristine dir will be passed to the verifier.
    writeBackupMeta({ pristine_hashes: { [FILE]: 'sha256:deadbeef00000000000000000000000000000000000000000000000000000001' } });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), installedContent);

    // Run without --pristine-dir flag.
    const { status, report } = runVerifier({ pristine: false });

    // Over-broad mode: every significant backup line is required.
    // "upstream line removed in newer version but present in backup" is NOT in
    // the installed content → over-broad mode FAILS this file (exit 1).
    // OK_NO_BASELINE must NOT fire — there was no pristine dir to consult.
    assert.equal(status, 1, `over-broad mode should fail (upstream-removed line absent); got ${status}`);
    const r0 = report.results[0];
    assert.equal(r0.status, 'fail', `expected fail status; got ${r0.status}`);
    assert.equal(r0.reason, REASON.FAIL_USER_LINES_MISSING,
      `expected FAIL_USER_LINES_MISSING from over-broad mode; got ${r0.reason}`);
    assert.notEqual(r0.reason, REASON.OK_NO_BASELINE,
      `OK_NO_BASELINE must not fire when --pristine-dir is not provided`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded regression block — #4086 (verifier resolves skills/ entries at the
// runtime's ACTUAL skills root). Codex installs skills to ~/.agents/skills;
// verifyFile() joined every relPath against configDir only, so legacy
// Codex skills/ patch entries reported fail_installed_missing even though
// the file existed at its real location.
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:bug-4086-verify-reapply-skills-root', () => {
'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup, scrubConfigLocationEnv } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'gsd-core', 'bin', 'verify-reapply-patches.cjs');
const { REASON } = require(SCRIPT);

let tmpRoot;
let patchesDir;
let configDir;
let savedHome;
let savedUserProfile;
let restoreConfigEnv;

function writeFile(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function runVerifier() {
  const r = runNode([
    SCRIPT,
    '--patches-dir', patchesDir,
    '--config-dir', configDir,
    '--json',
  ], { timeoutMs: 60_000 });
  return {
    status: r.exitCode,
    report: r.stdout && r.stdout.length ? JSON.parse(r.stdout) : null,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4086-vfy-'));
  patchesDir = path.join(tmpRoot, 'patches');
  configDir = path.join(tmpRoot, 'home', '.codex');
  fs.mkdirSync(patchesDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  // Sandbox HOME so the codex skills-kind home override resolves inside the
  // fixture (~/.agents/skills), not the developer's real home.
  const home = path.join(tmpRoot, 'home');
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  restoreConfigEnv = scrubConfigLocationEnv();
});

afterEach(() => {
  restoreConfigEnv();
  process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  cleanup(tmpRoot);
});

describe('Bug #4086: verifyFile resolves skills entries at the runtime skills root', () => {
  test('verifyFile resolves skills entries at the runtime\'s skills root (#4086)', () => {
    const key = 'skills/gsd-x/SKILL.md';
    writeFile(path.join(patchesDir, key), 'stock body line for the patch backup\nuser-added line that must survive merges\n');
    writeFile(path.join(tmpRoot, 'home', '.agents', key), 'stock body line for the patch backup\nuser-added line that must survive merges\n');
    // Manifest tells the verifier which runtime/scope owns this configDir.
    writeFile(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify({
      version: '1.12.0', runtime: 'codex', scope: 'global', files: {},
    }));

    const { status, report } = runVerifier();
    assert.equal(status, 0, `gate must pass; got report ${JSON.stringify(report)}`);
    assert.equal(report.failures, 0);
    const r0 = report.results[0];
    assert.equal(r0.status, 'ok');
    assert.notEqual(r0.reason, REASON.FAIL_INSTALLED_MISSING);
  });

  test('verifyFile still fails when the skill file is genuinely missing (#4086)', () => {
    const key = 'skills/gsd-gone/SKILL.md';
    writeFile(path.join(patchesDir, key), 'stock body line for the patch backup\nuser-added line that must survive merges\n');
    writeFile(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify({
      version: '1.12.0', runtime: 'codex', scope: 'global', files: {},
    }));

    const { status, report } = runVerifier();
    assert.equal(status, 1);
    const r0 = report.results[0];
    assert.equal(r0.file.replace(/\\/g, '/'), key);
    assert.equal(r0.status, 'fail');
    assert.equal(r0.reason, REASON.FAIL_INSTALLED_MISSING);
  });
});
  });
}



// ────────────────────────────────────────────────────────────────────────
// Folded regression block — #4145 (a hash-matching gsd-pristine/ baseline
// stored without the gsd-core/ prefix is never resolved). verifyFile() joined
// the manifest-keyed path strictly; when stat missed and a hash was recorded
// it reported OK_NO_BASELINE even though byte-correct content sat elsewhere
// under gsd-pristine/. The fix consults the recorded pristine_hashes — the
// same authority the #3657 drift guard trusts — and adopts an exact-hash
// match found anywhere in the tree.
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:bug-4145-pristine-prefix-resolution', () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'gsd-core', 'bin', 'verify-reapply-patches.cjs');
const { REASON } = require(SCRIPT);
const { findPristineByHash } = require(
  path.join(ROOT, 'gsd-core', 'bin', 'lib', 'pristine-baseline.cjs'),
);

let tmpRoot;
let patchesDir;
let configDir;
let pristineDir;

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeFile(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function writeBackupMeta(pristine_hashes) {
  writeFile(path.join(patchesDir, 'backup-meta.json'), JSON.stringify({ pristine_hashes }, null, 2));
}

function resetFixture() {
  for (const dir of [patchesDir, configDir, pristineDir]) {
    cleanup(dir);
  }
  fs.mkdirSync(patchesDir);
  fs.mkdirSync(configDir);
  fs.mkdirSync(pristineDir);
}

function runVerifier() {
  const r = runNode([
    SCRIPT,
    '--patches-dir', patchesDir,
    '--config-dir',  configDir,
    '--pristine-dir', pristineDir,
    '--json',
  ], { timeoutMs: 30_000 });
  return {
    status: r.exitCode,
    report: r.stdout && r.stdout.length ? JSON.parse(r.stdout) : null,
  };
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4145-'));
  patchesDir = path.join(tmpRoot, 'patches');
  configDir = path.join(tmpRoot, 'installed');
  pristineDir = path.join(tmpRoot, 'pristine');
  resetFixture();
});

after(() => {
  cleanup(tmpRoot);
});

describe('Bug #4145: hash-matching prefix-less pristine baseline is resolved', () => {
  /**
   * Core regression. The manifest key is `gsd-core/bin/lib/frontmatter.cjs`
   * but the snapshot sits at `bin/lib/frontmatter.cjs` — one segment away
   * from the joined path. Its SHA-256 equals the recorded pristine_hashes
   * entry. The upstream release replaced the file wholesale and only the
   * user's line survived the merge, so a verifier that recovered the
   * baseline computes exactly one user-added line (present → exit 0,
   * no_baseline 0), while the pre-fix run reported ok_no_baseline.
   */
  test('#4145: resolves a hash-matching prefix-less pristine baseline instead of reporting ok_no_baseline', () => {
    resetFixture();
    const FILE = 'gsd-core/bin/lib/frontmatter.cjs';
    const OLD_PRISTINE =
      'outgoing pristine stock line one with substantial content\n' +
      'outgoing pristine stock line two also substantial content\n';
    const USER_LINE = 'user customization line that must survive the reapply merge';
    const backupContent = OLD_PRISTINE + USER_LINE + '\n';
    const installedContent =
      'incoming upstream replacement line with substantial content\n' + USER_LINE + '\n';

    writeBackupMeta({ [FILE]: sha256(OLD_PRISTINE) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), installedContent);
    // The orphan: same bytes, stored WITHOUT the gsd-core/ prefix.
    writeFile(path.join(pristineDir, 'bin', 'lib', 'frontmatter.cjs'), OLD_PRISTINE);

    const { status, report } = runVerifier();

    assert.equal(status, 0, `expected exit 0; report=${JSON.stringify(report)}`);
    assert.equal(report.no_baseline, 0, 'a hash-matching baseline was on disk — it must be resolved');
    assert.deepEqual(report.no_baseline_files, []);
    assert.equal(report.failures, 0);
    const r0 = report.results[0];
    assert.equal(r0.status, 'ok');
    assert.notEqual(r0.reason, REASON.OK_NO_BASELINE);
  });

  /** Negative space: nothing anywhere under gsd-pristine/ matches the record. */
  test('#4145: still reports ok_no_baseline when the recorded hash matches nothing under gsd-pristine', () => {
    resetFixture();
    const FILE = 'gsd-core/bin/lib/frontmatter.cjs';
    const backupContent =
      'upstream line present in the backup of the outgoing release\n' +
      'model: sonnet — the user customisation line in the backup file\n';
    const installedContent =
      'replacement upstream line in the newer release version\n' +
      'model: sonnet — the user customisation line in the backup file\n';

    writeBackupMeta({ [FILE]: 'deadbeef00000000000000000000000000000000000000000000000000000001' });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), installedContent);
    // No pristine file anywhere.

    const { status, report } = runVerifier();

    assert.equal(status, 0, 'no-baseline is advisory, never a failure');
    assert.equal(report.no_baseline, 1);
    assert.equal(report.results[0].reason, REASON.OK_NO_BASELINE);
  });

  /**
   * Negative space: an orphan whose bytes do NOT hash to the record is never
   * adopted — only exact recorded-hash matches are accepted.
   */
  test('#4145: never adopts a hash-mismatching orphan — only exact recorded-hash matches', () => {
    resetFixture();
    const FILE = 'gsd-core/bin/lib/frontmatter.cjs';
    const OLD_PRISTINE = 'outgoing pristine bytes that the record hashes\n';
    const OTHER_CONTENT = 'some other release snapshot with different bytes\n';

    writeBackupMeta({ [FILE]: sha256(OLD_PRISTINE) });
    writeFile(path.join(patchesDir, FILE), 'outgoing pristine bytes that the record hashes\nuser line\n');
    writeFile(path.join(configDir, FILE), 'user line\n');
    // Orphan exists but hashes to something else.
    writeFile(path.join(pristineDir, 'bin', 'lib', 'frontmatter.cjs'), OTHER_CONTENT);

    const { status, report } = runVerifier();

    assert.equal(status, 0);
    assert.equal(report.no_baseline, 1, 'a mismatching orphan is not a baseline');
    assert.equal(report.results[0].reason, REASON.OK_NO_BASELINE);
  });

  /**
   * Precedence lock: the canonical prefixed path still resolves exactly as
   * today even when an identical-content orphan also exists — the strict join
   * stays first, and the verifier (read-only) leaves the orphan untouched.
   */
  test('#4145: prefixed canonical baseline resolves exactly as today when an identical orphan also exists', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/execute-phase.md';
    const pristineContent = 'stock workflow line long enough to pass the significance threshold\n';
    const droppedLine = 'user workflow customisation that was lost in the merge operation';
    const backupContent = pristineContent + droppedLine + '\n';
    const installedContent = pristineContent; // user line dropped — real failure

    writeBackupMeta({ [FILE]: sha256(pristineContent) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), installedContent);
    writeFile(path.join(pristineDir, FILE), pristineContent);
    const orphanPath = path.join(pristineDir, 'workflows', 'execute-phase.md');
    writeFile(orphanPath, pristineContent);

    const { status, report } = runVerifier();

    assert.equal(status, 1, 'the dropped user line must still be caught via the canonical baseline');
    const r0 = report.results[0];
    assert.equal(r0.status, 'fail');
    assert.equal(r0.reason, REASON.FAIL_USER_LINES_MISSING);
    assert.ok(r0.missing.includes(droppedLine));
    // Read-only verifier: the orphan is never relocated or pruned by a verify run.
    assert.equal(fs.existsSync(orphanPath), true, 'verifier must not mutate gsd-pristine/');
  });

  /**
   * Drift-path lock: a hash-MISMATCHING canonical snapshot still reports
   * OK_PRISTINE_DRIFT_DETECTED (#3657) — the recovery scan must not reach the
   * drift case.
   */
  test('#4145: canonical-path drift still reports ok_pristine_drift_detected even when a hash-matching orphan exists', () => {
    resetFixture();
    const FILE = 'gsd-core/agents/gsd-executor.md';
    const oldPristine = 'old pristine line that was present when backup was captured\n';
    const newPristine = 'refreshed upstream line in the newer pristine snapshot\n';
    const userLine = 'user customisation line that should be preserved across updates';

    writeBackupMeta({ [FILE]: sha256(oldPristine) });
    writeFile(path.join(patchesDir, FILE), oldPristine + userLine + '\n');
    writeFile(path.join(configDir, FILE), newPristine + userLine + '\n');
    writeFile(path.join(pristineDir, FILE), newPristine); // canonical drifted
    // A hash-matching orphan exists elsewhere — drift must still win.
    writeFile(path.join(pristineDir, 'agents', 'gsd-executor.md'), oldPristine);

    const { status, report } = runVerifier();

    assert.equal(status, 0);
    const r0 = report.results[0];
    assert.equal(r0.reason, REASON.OK_PRISTINE_DRIFT_DETECTED,
      `expected the untouched #3657 drift posture; got ${r0.reason}`);
    assert.equal(report.drifted, 1);
  });

  /** Module unit: deterministic sorted-first match, symlink skip, absent dir. */
  test('#4145: findPristineByHash returns the sorted-first match, skips symlinks, and null on an absent dir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4145-unit-'));
    const symRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4145-sym-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4145-out-'));
    try {
      const contentA = 'identical bytes that two snapshots happen to share\n';
      const hashA = sha256(contentA);
      writeFile(path.join(root, 'zz-dir', 'late-match.md'), contentA);
      writeFile(path.join(root, 'aa.txt'), contentA);

      assert.equal(findPristineByHash(root, hashA), 'aa.txt',
        'sorted-first match wins deterministically');
      assert.equal(findPristineByHash(root, hashA, 'aa.txt'), 'zz-dir/late-match.md',
        'skipRel is never returned');
      assert.equal(findPristineByHash(root, hashA, new Set(['aa.txt', 'zz-dir/late-match.md'])), null,
        'every member of a skip Set is excluded (canonical-path protection)');
      assert.equal(findPristineByHash(root, sha256('no such content anywhere here\n')), null,
        'no match resolves to null');
      assert.equal(findPristineByHash(path.join(root, 'absent'), hashA), null,
        'absent dir resolves to null');

      // A symlink is never followed, even when its target would hash-match.
      // The target lives OUTSIDE symRoot so the only hashable entry inside the
      // scanned tree is the symlink itself.
      const outsideTarget = path.join(outsideRoot, 'outside-target.md');
      fs.writeFileSync(outsideTarget, contentA);
      fs.symlinkSync(outsideTarget, path.join(symRoot, 'sym.md'));
      assert.equal(findPristineByHash(symRoot, hashA), null,
        'symlinked candidates are skipped, not followed');
    } finally {
      cleanup(root);
      cleanup(symRoot);
      cleanup(outsideRoot);
    }
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded regression block — #4136 (the documented "Incorporated" per-file
// status was unreachable: a customization upstream had adopted was silently
// re-grafted on every future cycle, forever). Adds a --classify pre-merge
// mode to the deterministic verifier: with a hash-validated pristine
// baseline, a file whose EVERY significant user-added line is already
// present verbatim in the freshly installed version is classified
// `incorporated` — the workflow then leaves it untouched (status
// Incorporated, "Already in upstream v{version}") instead of re-grafting.
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:bug-4136-reapply-incorporated-status', () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #4136: reapply-patches.md Step 4 item 6 defines three per-file statuses
 * (Merged / Conflict / Incorporated) but no code path computed Incorporated —
 * the term existed only in workflow prose, so superseded customizations were
 * re-grafted forever (the merged file's hash never re-converged with the
 * shipped manifest hash, so saveLocalPatches re-flagged it every update).
 *
 * Fix: `--classify` mode on the deterministic verifier. Pre-merge, per file:
 *   - hash-validated pristine + >=1 significant user-added line + every one of
 *     those lines present verbatim in the fresh install  → incorporated
 *   - hash-validated pristine + some user lines absent               → needs_merge
 *   - anything else (no/mismatched/absent/unvalidated baseline, zero user
 *     lines, structural failure)                                     → unknown
 *
 * Incorporated is NEVER produced without baseline confirmation — the issue's
 * law that a false Incorporated is worse than none. Per CONTRIBUTING's typed-
 * surface standard, assertions go against the frozen CLASSIFICATION enum and
 * the structured --json report; zero text matching on human output.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'gsd-core', 'bin', 'verify-reapply-patches.cjs');
const { REASON, CLASSIFICATION } = require(SCRIPT);

let tmpRoot;
let patchesDir;
let configDir;
let pristineDir;

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function writeFile(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function writeBackupMeta(pristine_hashes) {
  writeFile(path.join(patchesDir, 'backup-meta.json'), JSON.stringify({ pristine_hashes }, null, 2));
}

function resetFixture() {
  for (const dir of [patchesDir, configDir, pristineDir]) {
    cleanup(dir);
  }
  fs.mkdirSync(patchesDir);
  fs.mkdirSync(configDir);
  fs.mkdirSync(pristineDir);
}

/** Runs the verifier in --classify mode with --json. Returns { status, report }. */
function runClassifier({ includePristine = true } = {}) {
  const args = [
    SCRIPT,
    '--patches-dir', patchesDir,
    '--config-dir',  configDir,
    ...(includePristine ? ['--pristine-dir', pristineDir] : []),
    '--classify',
    '--json',
  ];
  const r = runNode(args, { timeoutMs: VERIFIER_TIMEOUT_MS });
  return {
    status: r.exitCode,
    report: r.stdout && r.stdout.length ? JSON.parse(r.stdout) : null,
  };
}

/** Runs the verifier in default post-merge gate mode with --json. */
function runGate({ includePristine = true } = {}) {
  const args = [
    SCRIPT,
    '--patches-dir', patchesDir,
    '--config-dir',  configDir,
    ...(includePristine ? ['--pristine-dir', pristineDir] : []),
    '--json',
  ];
  const r = runNode(args, { timeoutMs: VERIFIER_TIMEOUT_MS });
  return {
    status: r.exitCode,
    report: r.stdout && r.stdout.length ? JSON.parse(r.stdout) : null,
  };
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4136-'));
  patchesDir = path.join(tmpRoot, 'patches');
  configDir = path.join(tmpRoot, 'installed');
  pristineDir = path.join(tmpRoot, 'pristine');
  resetFixture();
});

after(() => {
  cleanup(tmpRoot);
});

describe('Bug #4136: deterministic Incorporated classification (--classify)', () => {
  test('CLASSIFICATION enum exposes the documented set of stable codes', () => {
    assert.deepEqual(
      Object.keys(CLASSIFICATION).sort(),
      ['INCORPORATED', 'NEEDS_MERGE', 'UNKNOWN'],
    );
  });

  test('Row 1 (RED regression): all user-added lines already upstream → incorporated', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/execute-phase.md';
    const pristineContent = [
      'stock line one that is long enough to be significant',
      'stock line two that is long enough to be significant',
    ].join('\n') + '\n';
    const userLine = 'user custom verification gate that upstream adopted verbatim';
    const backupContent = pristineContent + userLine + '\n';
    // Fresh install: upstream shipped the user's line PLUS its own new line.
    const freshInstall = pristineContent + userLine + '\n' +
      'brand-new unrelated upstream line shipped in this release\n';

    writeBackupMeta({ [FILE]: sha256(pristineContent) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), freshInstall);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const { status, report } = runClassifier();
    assert.equal(status, 0, `classify must exit 0; report=${JSON.stringify(report)}`);
    assert.equal(report.incorporated, 1);
    assert.equal(report.incorporated_files.length, 1);
    assert.equal(report.incorporated_files[0].replace(/\\/g, '/'), FILE);
    const r0 = report.results[0];
    assert.equal(r0.file.replace(/\\/g, '/'), FILE);
    assert.equal(r0.classification, CLASSIFICATION.INCORPORATED);
    assert.deepEqual(r0.missing, []);
  });

  test('Row 2: user line absent from fresh install → needs_merge; gate still catches drops', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/plan-phase.md';
    const pristineContent = 'stock baseline line long enough to be significant here\n';
    const userLine = 'user custom instruction that upstream did NOT adopt yet';
    const backupContent = pristineContent + userLine + '\n';
    const freshInstall = pristineContent + 'unrelated upstream line shipped in the release\n';

    writeBackupMeta({ [FILE]: sha256(pristineContent) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), freshInstall);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const cls = runClassifier();
    assert.equal(cls.status, 0, 'classify is informational — needs_merge is not an error');
    assert.equal(cls.report.incorporated, 0);
    assert.deepEqual(cls.report.incorporated_files, []);
    const c0 = cls.report.results[0];
    assert.equal(c0.classification, CLASSIFICATION.NEEDS_MERGE);
    assert.ok(c0.missing.includes(userLine), `missing must name the absent line; got ${JSON.stringify(c0.missing)}`);

    // Negative proof: the post-merge gate is NOT weakened — a merge that
    // drops the user line still fails the default (#2969) run.
    const gate = runGate();
    assert.equal(gate.status, 1);
    assert.equal(gate.report.failures, 1);
    const g0 = gate.report.results[0];
    assert.equal(g0.status, 'fail');
    assert.equal(g0.reason, REASON.FAIL_USER_LINES_MISSING);
  });

  test('Row 3 (boundary): partially-superseded is needs_merge, not Incorporated', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/ship.md';
    const pristineContent = 'stock line that is long enough to be significant\n';
    const adoptedLine = 'user line number one that upstream did adopt upstream';
    const unadoptedLine = 'user line number two that upstream has NOT adopted';
    const backupContent = pristineContent + adoptedLine + '\n' + unadoptedLine + '\n';
    const freshInstall = pristineContent + adoptedLine + '\n';

    writeBackupMeta({ [FILE]: sha256(pristineContent) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), freshInstall);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const { status, report } = runClassifier();
    assert.equal(status, 0);
    assert.equal(report.incorporated, 0, 'partial adoption must not classify Incorporated');
    const r0 = report.results[0];
    assert.equal(r0.classification, CLASSIFICATION.NEEDS_MERGE);
    assert.deepEqual(r0.missing, [unadoptedLine], 'only the un-adopted line is missing');
  });

  test('Row 4a: pristine drift (#3657 shape) → unknown, never Incorporated', () => {
    resetFixture();
    const FILE = 'agents/gsd-executor.md';
    const oldPristine = 'old pristine line present when the backup was captured\n';
    const newPristine = 'refreshed upstream snapshot line in the newer GSD release\n';
    const userLine = 'user customisation line that upstream adopted in the release';
    const backupContent = oldPristine + userLine + '\n';
    const freshInstall = newPristine + userLine + '\n';

    writeBackupMeta({ [FILE]: sha256(oldPristine) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), freshInstall);
    writeFile(path.join(pristineDir, FILE), newPristine); // hash mismatch → drift

    const { status, report } = runClassifier();
    assert.equal(status, 0);
    assert.equal(report.incorporated, 0, 'a drifted baseline confirms nothing');
    assert.deepEqual(report.incorporated_files, []);
    const r0 = report.results[0];
    assert.equal(r0.classification, CLASSIFICATION.UNKNOWN);
    assert.equal(r0.reason, REASON.OK_PRISTINE_DRIFT_DETECTED);
  });

  test('Row 4b: recorded hash but pristine absent (#934 shape) → unknown', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/debug.md';
    const pristineContent = 'stock line that is long enough to be significant x\n';
    const userLine = 'user custom line upstream adopted, but baseline is missing';
    const backupContent = pristineContent + userLine + '\n';
    const freshInstall = pristineContent + userLine + '\n';

    writeBackupMeta({ [FILE]: sha256(pristineContent) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), freshInstall);
    // No pristine file on disk at all.

    const { status, report } = runClassifier();
    assert.equal(status, 0);
    assert.equal(report.incorporated, 0, 'absent baseline confirms nothing even when all lines are present');
    const r0 = report.results[0];
    assert.equal(r0.classification, CLASSIFICATION.UNKNOWN);
    assert.equal(r0.reason, REASON.OK_NO_BASELINE);
  });

  test('Row 4c: no --pristine-dir (two-way fallback) → unknown', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/scan.md';
    const pristineContent = 'stock line that is long enough to be significant y\n';
    const userLine = 'user custom line upstream adopted, but no baseline was passed';
    const backupContent = pristineContent + userLine + '\n';
    const freshInstall = pristineContent + userLine + '\n';

    writeBackupMeta({ [FILE]: sha256(pristineContent) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), freshInstall);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const { status, report } = runClassifier({ includePristine: false });
    assert.equal(status, 0);
    assert.equal(report.incorporated, 0);
    const r0 = report.results[0];
    assert.equal(r0.classification, CLASSIFICATION.UNKNOWN);
  });

  test('Row 4d: on-disk pristine but no recorded hash → unknown (unvalidated baseline)', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/undo.md';
    const pristineContent = 'stock line that is long enough to be significant z\n';
    const userLine = 'user custom line upstream adopted, but hash was never recorded';
    const backupContent = pristineContent + userLine + '\n';
    const freshInstall = pristineContent + userLine + '\n';

    // Older installer: no pristine_hashes entry at all.
    writeBackupMeta({});
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), freshInstall);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const { status, report } = runClassifier();
    assert.equal(status, 0);
    assert.equal(report.incorporated, 0, 'an unvalidated snapshot cannot confirm adoption');
    const r0 = report.results[0];
    assert.equal(r0.classification, CLASSIFICATION.UNKNOWN);
    assert.equal(r0.reason, REASON.OK_UNVALIDATED_BASELINE);
  });

  test('Row 4d-2: a #4145-recovered (hash-matched orphan) baseline can confirm adoption', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/import.md';
    const pristineContent = 'stock line that is long enough to be significant s\n';
    const userLine = 'user custom line upstream adopted, baseline stored unprefixed';
    const backupContent = pristineContent + userLine + '\n';
    const freshInstall = pristineContent + userLine + '\n';

    // The pristine snapshot sits WITHOUT the gsd-core/ prefix (an earlier
    // release's writer dropped it) — only the #4145 hash scan can find it.
    writeBackupMeta({ [FILE]: sha256(pristineContent) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), freshInstall);
    writeFile(path.join(pristineDir, 'workflows', 'import.md'), pristineContent);

    const { status, report } = runClassifier();
    assert.equal(status, 0);
    // A recovered baseline is hash-confirmed by construction, so it VALIDATES
    // and may confirm adoption — the #4136 classifier composes with the
    // #4145 recovery instead of treating it as unknown.
    assert.equal(report.incorporated, 1);
    const r0 = report.results[0];
    assert.equal(r0.classification, CLASSIFICATION.INCORPORATED);
    assert.deepEqual(r0.missing, []);
  });

  test('Row 4e: signature-looking short/fence lines do not drive the classification', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/health.md';
    const pristineContent = 'stock line that is long enough to be significant w\n';
    // The user hunk: a short heading (under the 12-char significance floor),
    // a code fence, and ONE significant line.
    const shortHeading = '## My Gate';
    const fence = '```bash';
    const significant = 'the substantive customization body line that matters';
    const backupContent = pristineContent + shortHeading + '\n' + fence + '\n' + significant + '\n';
    // Fresh install happens to contain the short heading (renamed section)
    // and plenty of fences — but NOT the significant body line.
    const freshInstall = pristineContent + '## My Gate\n' + '```bash\nls -la\n```\n';

    writeBackupMeta({ [FILE]: sha256(pristineContent) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), freshInstall);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const { status, report } = runClassifier();
    assert.equal(status, 0);
    assert.equal(report.incorporated, 0, 'trivial-line presence must not fabricate adoption');
    const r0 = report.results[0];
    assert.equal(r0.classification, CLASSIFICATION.NEEDS_MERGE);
    assert.ok(r0.missing.includes(significant));
    assert.ok(!r0.missing.includes(shortHeading), 'insufficiently-significant lines are excluded');
    assert.ok(!r0.missing.includes(fence), 'structural lines are excluded');
  });

  test('Row 5: backup with zero significant delta vs validated pristine → unknown, never a skip', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/note.md';
    const pristineContent = 'stock line that is long enough to be significant v\n';
    const backupContent = pristineContent; // degenerate: backed up but identical

    writeBackupMeta({ [FILE]: sha256(pristineContent) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), pristineContent);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const { status, report } = runClassifier();
    assert.equal(status, 0);
    assert.equal(report.incorporated, 0);
    const r0 = report.results[0];
    assert.equal(r0.classification, CLASSIFICATION.UNKNOWN);
    assert.equal(r0.reason, REASON.OK_NO_USER_LINES_VS_PRISTINE);
  });

  test('Row 6: structural failures classify unknown; classify still exits 0', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/stats.md';
    const pristineContent = 'stock line that is long enough to be significant u\n';
    const userLine = 'user custom line that upstream adopted in this release';
    const backupContent = pristineContent + userLine + '\n';

    writeBackupMeta({ [FILE]: sha256(pristineContent) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(pristineDir, FILE), pristineContent);
    // Installed file deliberately absent.

    const { status, report } = runClassifier();
    assert.equal(status, 0, 'classify is informational; the post-merge gate enforces structure');
    const r0 = report.results[0];
    assert.equal(r0.classification, CLASSIFICATION.UNKNOWN);
    assert.equal(r0.reason, REASON.FAIL_INSTALLED_MISSING);
  });

  test('Row 7: classify --json report shape is { checked, incorporated, incorporated_files, results }', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/help.md';
    const pristineContent = 'stock line that is long enough to be significant t\n';
    const userLine = 'user custom line that upstream adopted in this release';
    const backupContent = pristineContent + userLine + '\n';
    const freshInstall = pristineContent + userLine + '\n';

    writeBackupMeta({ [FILE]: sha256(pristineContent) });
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(configDir, FILE), freshInstall);
    writeFile(path.join(pristineDir, FILE), pristineContent);

    const { report } = runClassifier();
    assert.deepEqual(Object.keys(report).sort(), ['checked', 'incorporated', 'incorporated_files', 'results']);
    const r0 = report.results[0];
    assert.deepEqual(Object.keys(r0).sort(), ['classification', 'file', 'missing', 'reason']);
    assert.equal(typeof r0.file, 'string');
    assert.equal(typeof r0.classification, 'string');
    assert.ok(Array.isArray(r0.missing));
  });

  test('Row 8: Incorporated ends the re-graft cycle — the file drops out of the next backup', () => {
    resetFixture();
    const FILE = 'gsd-core/workflows/inbox.md';
    const pristineV1 = 'stock v1 line that is long enough to be significant\n';
    const userLine = 'user custom loop guard that upstream adopted in v2';
    const backupContent = pristineV1 + userLine + '\n';
    // v2 ships the user's line verbatim plus an unrelated upstream change.
    const freshV2 = pristineV1 + userLine + '\n' + 'unrelated upstream improvement line in v2\n';

    // Update #1: installer backs up the modified file + records the pristine.
    writeFile(path.join(patchesDir, FILE), backupContent);
    writeFile(path.join(pristineDir, FILE), pristineV1);
    writeBackupMeta({ [FILE]: sha256(pristineV1) });
    // The update wipes and installs v2; manifest now hashes v2's shipped bytes.
    writeFile(path.join(configDir, FILE), freshV2);
    const manifestV2 = { version: '2.0.0', files: { [FILE]: sha256(freshV2) } };
    writeFile(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify(manifestV2, null, 2));

    // Pre-flight classification: incorporated → the workflow leaves the file untouched.
    const cls = runClassifier();
    assert.equal(cls.status, 0);
    assert.equal(cls.report.results[0].classification, CLASSIFICATION.INCORPORATED);
    assert.equal(
      fs.readFileSync(path.join(configDir, FILE), 'utf8'),
      freshV2,
      'incorporated files are NOT re-grafted — installed bytes stay as shipped',
    );

    // Post-merge gate passes on the untouched install (all user lines present).
    const gate = runGate();
    assert.equal(gate.status, 0, `gate must pass the untouched install; report=${JSON.stringify(gate.report)}`);
    assert.equal(gate.report.failures, 0);

    // Next update cycle: saveLocalPatches detection (manifest hash comparison)
    // no longer flags the file — the forever loop is broken.
    const stillModified = Object.entries(manifestV2.files)
      .filter(([rel, hash]) => sha256(fs.readFileSync(path.join(configDir, rel), 'utf8')) !== hash)
      .map(([rel]) => rel);
    assert.deepEqual(stillModified, [], 'an incorporated file must drop out of the backup cycle');

    // Counter-case (the pre-fix behavior): a re-grafted file WOULD be flagged again.
    writeFile(path.join(configDir, FILE), freshV2 + userLine + '\n');
    const reGraftedModified = Object.entries(manifestV2.files)
      .filter(([rel, hash]) => sha256(fs.readFileSync(path.join(configDir, rel), 'utf8')) !== hash)
      .map(([rel]) => rel);
    assert.deepEqual(reGraftedModified, [FILE], 'a re-grafted file stays in the backup cycle forever');
  });
});

describe('Bug #4136: workflow consumes the classifier (contract rows)', () => {
  const WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'reapply-patches.md');

  test('Step 4 runs the classifier before merging and gates it on PRISTINE_DIR', () => {
    // allow-test-rule: source-text-is-the-product (#4136)
    // reapply-patches.md is the installed runtime workflow — its text IS the
    // deployed behavioral contract for --reapply, so structural assertions
    // against the shipped text are the correct test form here.
    const md = fs.readFileSync(WORKFLOW, 'utf8');
    const classifyIdx = md.indexOf('--classify');
    assert.ok(classifyIdx > 0, 'Step 4 must invoke the verifier with --classify');
    const mergeRulesIdx = md.indexOf('### Three-way merge (when baseline is available)');
    assert.ok(mergeRulesIdx > 0);
    assert.ok(
      classifyIdx < mergeRulesIdx,
      'the classify invocation must precede the Step 4 merge rules (classify before merging)',
    );
    // Both invocations must be the runtime-installed path (locked separately
    // by the #2994 fold); here we lock that the classify block is bounded by
    // the same GSD_HOME-anchored script reference as the Step 5a gate.
    const gateIdx = md.indexOf('verify-reapply-patches.cjs', classifyIdx);
    assert.ok(gateIdx > classifyIdx, 'the Step 5a gate invocation must still follow the classify block');
  });

  test('Incorporated files are instructed NOT to be re-grafted', () => {
    // allow-test-rule: source-text-is-the-product (#4136)
    const md = fs.readFileSync(WORKFLOW, 'utf8');
    const step4Idx = md.indexOf('## Step 4: Merge each file');
    const step5Idx = md.indexOf('## Step 5: Hunk Verification Gate');
    assert.ok(step4Idx > 0 && step5Idx > step4Idx);
    const step4 = md.slice(step4Idx, step5Idx);
    assert.ok(
      step4.includes('INCORPORATED_FILES'),
      'Step 4 must consume the classifier\'s incorporated_files list',
    );
    assert.ok(
      /do NOT re-apply/i.test(step4),
      'Step 4 must instruct that incorporated files are not re-grafted',
    );
    assert.ok(
      step4.includes('Already in upstream'),
      'the documented Step 7 Incorporated phrasing must be wired to the classifier output',
    );
  });

  test('three-way merge rules include the already-present-verbatim rule', () => {
    // allow-test-rule: source-text-is-the-product (#4136)
    const md = fs.readFileSync(WORKFLOW, 'utf8');
    const rulesIdx = md.indexOf('**Merge rules:**');
    assert.ok(rulesIdx > 0);
    const rulesBlock = md.slice(rulesIdx, md.indexOf('### Two-way merge'));
    assert.ok(
      rulesBlock.includes('already present verbatim'),
      'the merge rule set must cover user content upstream already contains',
    );
  });

  test('success_criteria covers the Incorporated / not-re-grafted contract', () => {
    // allow-test-rule: source-text-is-the-product (#4136)
    const md = fs.readFileSync(WORKFLOW, 'utf8');
    const start = md.indexOf('<success_criteria>');
    const end = md.indexOf('</success_criteria>');
    assert.ok(start > 0 && end > start);
    const block = md.slice(start, end);
    assert.ok(
      block.includes('Incorporated'),
      'success_criteria must name the Incorporated disposition',
    );
    assert.ok(
      /not re-grafted/i.test(block),
      'success_criteria must require that superseded customizations are not re-grafted',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded regression block — #4135 (gsd-pristine/ regeneration yields
// near-zero coverage on a multi-version update). The #3407 promotion rule
// only keeps regeneration candidates byte-identical across the WHOLE
// version span, so the surviving baseline set is precisely the files
// upstream did NOT change — and no reporting surface (verifier summary,
// --json, workflow Step 5a) distinguishes a 12-of-13 unbaselined green run
// from a fully-verified one. The fix reports baseline coverage as a
// headline, adds an opt-in strict coverage gate, and widens resolution
// with a git-history tier anchored by the same pristine_hashes authority.
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:bug-4135-pristine-regen-coverage', () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'gsd-core', 'bin', 'verify-reapply-patches.cjs');
const { REASON } = require(SCRIPT);
const { findPristineInGit } = require(
  path.join(ROOT, 'gsd-core', 'bin', 'lib', 'pristine-baseline.cjs'),
);
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'reapply-patches.md');

// 30000ms: same class as the folded blocks above — one deterministic
// verifier pass (plus, for the git tier rows, the in-process git log/show
// walk the verifier performs) over a small mkdtemp fixture tree.
const VERIFIER_TIMEOUT_MS = 30_000;

let tmpRoot;
let patchesDir;
let configDir;
let pristineDir;

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function writeFile(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function writeBackupMeta(pristine_hashes) {
  writeFile(path.join(patchesDir, 'backup-meta.json'), JSON.stringify({ pristine_hashes }, null, 2));
}

function resetFixture() {
  for (const dir of [patchesDir, configDir, pristineDir]) {
    cleanup(dir);
  }
  fs.mkdirSync(patchesDir);
  fs.mkdirSync(configDir);
  fs.mkdirSync(pristineDir);
}

/** Runs the verifier with --json plus any extra argv (strict-gate flags). */
function runVerifier(extraArgs = []) {
  const r = runNode([
    SCRIPT,
    '--patches-dir', patchesDir,
    '--config-dir',  configDir,
    '--pristine-dir', pristineDir,
    '--json',
    ...extraArgs,
  ], { timeoutMs: VERIFIER_TIMEOUT_MS });
  return {
    status: r.exitCode,
    report: r.stdout && r.stdout.length ? JSON.parse(r.stdout) : null,
  };
}

/** git fixture plumbing that must abort loudly when setup breaks. */
function gitIn(dir, args) {
  gitOrThrow(args, { cwd: dir });
}
function gitCommitAll(dir, message) {
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message]);
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4135-'));
  patchesDir = path.join(tmpRoot, 'patches');
  configDir = path.join(tmpRoot, 'installed');
  pristineDir = path.join(tmpRoot, 'pristine');
  resetFixture();
});

after(() => {
  cleanup(tmpRoot);
});

describe('Bug #4135: baseline coverage is reported, gateable, and widened from git history', () => {
  /**
   * Core regression (headline): the issue's exact scenario — 13 backed-up
   * customised files on a multi-version update, 12 changed upstream, 1
   * byte-identical. gsd-pristine/ holds only the byte-identical survivor.
   * The green exit must CARRY a countable coverage aggregate instead of
   * presenting like a fully-verified run.
   */
  test('#4135: report aggregates baseline_covered so a 12-of-13 unbaselined run is countable', () => {
    resetFixture();
    const pristineHashes = {};
    for (let i = 1; i <= 13; i++) {
      const rel = `gsd-core/workflows/flow-${String(i).padStart(2, '0')}.md`;
      const pristine =
        `# Flow ${i}\nStock content of the outgoing release for file ${i}.\n` +
        `Line two of outgoing stock content ${i} with plenty of substance.\n`;
      const userLine = `## User customisation ${i}\nA custom section the user added for file ${i}.\n`;
      const upstream =
        `# Flow ${i} (rewritten)\nUpstream rewrote file ${i} across the multi-version span.\n` +
        `New stock structure with several new lines for file ${i}.\n`;
      pristineHashes[rel] = sha256(pristine);
      writeFile(path.join(patchesDir, rel), pristine + userLine);
      writeFile(path.join(configDir, rel), upstream + userLine);
      if (i === 7) {
        // The single byte-identical-across-the-span survivor.
        writeFile(path.join(pristineDir, rel), pristine);
      }
    }
    writeBackupMeta(pristineHashes);

    const { status, report } = runVerifier();

    assert.equal(status, 0, 'no-baseline files stay advisory — the default gate must stay green');
    assert.equal(report.checked, 13);
    assert.equal(report.no_baseline, 12);
    assert.equal(report.failures, 0);
    assert.equal(report.baseline_covered, 1,
      `coverage collapse must be countable; got ${JSON.stringify(report.baseline_covered)}`);
  });

  /** Human-mode headline renderer: exact-contract unit on the typed helper. */
  test('#4135: human summary headlines baseline coverage N-of-M', () => {
    const script = require(SCRIPT);
    assert.equal(typeof script.coverageHeadline, 'function',
      'the human summary headline must be rendered by an exported typed helper');
    assert.equal(
      script.coverageHeadline(1, 13),
      'Baseline coverage: 1 of 13 file(s) verified against a pristine baseline (12 unverified)',
      'partial coverage renders N-of-M plus the unverified count');
    assert.equal(
      script.coverageHeadline(13, 13),
      'Baseline coverage: 13 of 13 file(s) verified against a pristine baseline',
      'full coverage renders without an unverified tail');
  });

  /**
   * Core regression (strict gate): the same collapsed fixture under
   * `--min-baseline-coverage 0.9` must FAIL LOUDLY (new opt-in exit code 3)
   * while still emitting the parseable JSON report.
   */
  test('#4135: opt-in --min-baseline-coverage exits 3 below threshold', () => {
    resetFixture();
    const pristineHashes = {};
    for (let i = 1; i <= 13; i++) {
      const rel = `gsd-core/workflows/flow-${String(i).padStart(2, '0')}.md`;
      const pristine = `# Flow ${i}\nOutgoing stock line with substantial content ${i}.\n`;
      const userLine = `User customisation line that survived the merge for file ${i}.\n`;
      const upstream = `# Flow ${i} new\nIncoming release rewrote this file upstream ${i}.\n`;
      pristineHashes[rel] = sha256(pristine);
      writeFile(path.join(patchesDir, rel), pristine + userLine);
      writeFile(path.join(configDir, rel), upstream + userLine);
    }
    writeBackupMeta(pristineHashes);

    const { status, report } = runVerifier(['--min-baseline-coverage', '0.9']);

    assert.equal(status, 3, 'a 1-of-13 run under a 0.9 threshold must exit non-zero (coverage gate)');
    assert.ok(report, 'the JSON report must still be emitted for scripting consumers');
    assert.equal(report.failures, 0, 'the failure here is coverage, not content');
    assert.equal(report.baseline_covered, 0);
  });

  /** Precedence: a real content failure outranks the coverage failure. */
  test('#4135: strict gate yields to exit 1 when real content failed', () => {
    resetFixture();
    const rel = 'gsd-core/workflows/one.md';
    const pristine = 'outgoing stock line with substantial content here\n';
    const userLine = 'user customisation line that was dropped by the merge\n';
    writeBackupMeta({ [rel]: sha256(pristine) });
    writeFile(path.join(patchesDir, rel), pristine + userLine);
    writeFile(path.join(configDir, rel), pristine); // user line dropped
    writeFile(path.join(pristineDir, rel), pristine);

    const { status, report } = runVerifier(['--min-baseline-coverage', '1']);

    assert.equal(status, 1, 'content failure is the louder, more specific signal');
    assert.equal(report.failures, 1);
    assert.equal(report.results[0].reason, REASON.FAIL_USER_LINES_MISSING);
  });

  /** Ratio boundary: at exactly the threshold the gate passes (>= semantics). */
  test('#4135: strict coverage gate passes at exactly the threshold', () => {
    resetFixture();
    seedTwoFilesOneCovered();
    const { status } = runVerifier(['--min-baseline-coverage', '0.5']);
    assert.equal(status, 0, '1 of 2 covered satisfies a 0.5 threshold (>= passes)');
  });

  /** Ratio boundary: just below the threshold the gate fails. */
  test('#4135: strict coverage gate fails just below the threshold', () => {
    resetFixture();
    seedTwoFilesOneCovered();
    const { status } = runVerifier(['--min-baseline-coverage', '0.51']);
    assert.equal(status, 3, '1 of 2 covered does not satisfy a 0.51 threshold');
  });

  /** Vacuous input: nothing checked cannot be under-covered. */
  test('#4135: strict coverage gate is vacuously satisfied when nothing is checked', () => {
    resetFixture();
    const { status, report } = runVerifier(['--min-baseline-coverage', '1']);
    assert.equal(status, 0);
    assert.equal(report.checked, 0);
  });

  /** Arg validation: malformed thresholds are usage errors (exit 2). */
  test('#4135: malformed --min-baseline-coverage values are usage errors', () => {
    resetFixture();
    for (const bad of ['1.5', '-1', 'notanumber']) {
      const r = runNode([
        SCRIPT,
        '--patches-dir', patchesDir,
        '--config-dir', configDir,
        '--pristine-dir', pristineDir,
        '--json',
        '--min-baseline-coverage', bad,
      ], { timeoutMs: VERIFIER_TIMEOUT_MS });
      assert.equal(r.exitCode, 2, `threshold "${bad}" must be a usage error, not silently clamped`);
    }
  });

  /**
   * Core regression (widening): multi-version collapse — no baseline under
   * gsd-pristine/, but the config dir is a git repository whose history
   * holds the outgoing bytes (recorded pristine_hashes match). The
   * recovered baseline must produce a REAL diff: the dropped user line is
   * caught as fail_user_lines_missing, not skipped as ok_no_baseline.
   */
  test('#4135: resolves the baseline from git history by recorded hash and catches a dropped user line', () => {
    resetFixture();
    const rel = 'gsd-core/workflows/flow-01.md';
    const pristine =
      '# Flow 1\nOutgoing release stock line one with substance.\n' +
      'Outgoing release stock line two also with substance.\n';
    const userLine = 'user customisation line that the merge dropped for flow one';
    const backup = pristine + userLine + '\n';
    const upstreamRewrite =
      '# Flow 1 (rewritten)\nIncoming release replaced the stock body upstream.\n';

    writeBackupMeta({ [rel]: sha256(pristine) });
    writeFile(path.join(patchesDir, rel), backup);
    // Config dir IS a git repo: outgoing pristine state, then the merged state.
    gitIn(configDir, ['init', '-q', '-b', 'main']);
    writeFile(path.join(configDir, rel), pristine);
    gitCommitAll(configDir, 'gsd install of the outgoing release');
    writeFile(path.join(configDir, rel), upstreamRewrite); // user line dropped
    gitCommitAll(configDir, 'post-update merged state');

    const { status, report } = runVerifier();

    assert.equal(status, 1, 'the git-recovered baseline must catch the dropped line');
    assert.equal(report.no_baseline, 0, 'the baseline was recoverable — no skip');
    assert.equal(report.baseline_covered, 1);
    const r0 = report.results[0];
    assert.equal(r0.status, 'fail');
    assert.equal(r0.reason, REASON.FAIL_USER_LINES_MISSING);
    assert.deepEqual(r0.missing, [userLine],
      'the diff ran against the RECOVERED baseline — upstream-removed lines are not "missing"');
  });

  /**
   * Net observable: same recovery, user line PRESENT — the file is verified
   * (exit 0, covered) instead of silently skipped.
   */
  test('#4135: git-recovered baseline verifies surviving user lines instead of skipping', () => {
    resetFixture();
    const rel = 'gsd-core/workflows/flow-02.md';
    const pristine = '# Flow 2\nOutgoing stock line with substantial content.\n';
    const userLine = 'user customisation line that survived the merge for flow two';
    const upstreamRewrite = '# Flow 2 (rewritten)\nIncoming release rewrote the stock body.\n';

    writeBackupMeta({ [rel]: sha256(pristine) });
    writeFile(path.join(patchesDir, rel), pristine + userLine + '\n');
    gitIn(configDir, ['init', '-q', '-b', 'main']);
    writeFile(path.join(configDir, rel), pristine);
    gitCommitAll(configDir, 'gsd install of the outgoing release');
    writeFile(path.join(configDir, rel), upstreamRewrite + userLine + '\n');
    gitCommitAll(configDir, 'post-update merged state');

    const { status, report } = runVerifier();

    assert.equal(status, 0);
    assert.equal(report.no_baseline, 0);
    assert.equal(report.baseline_covered, 1);
    assert.equal(report.results[0].status, 'ok');
    assert.notEqual(report.results[0].reason, REASON.OK_NO_BASELINE);
  });

  /**
   * Version-hop boundary (N−1 / multi-commit span): history holds TWO
   * upstream versions; the recorded hash is the OLDER one, so the walk must
   * pass the newer (mismatching) commit and match deeper history — the
   * single-hop shape of the same recovery.
   */
  test('#4135: single-version hop also recovers the baseline from git history', () => {
    resetFixture();
    const rel = 'gsd-core/workflows/flow-03.md';
    const vA = '# Flow 3\nVersion A stock line with substantial content.\n';
    const vB = '# Flow 3\nVersion B stock line with substantial content.\n';
    const userLine = 'user customisation line present in the merged output';
    writeBackupMeta({ [rel]: sha256(vA) }); // outgoing = the OLDER commit's bytes
    writeFile(path.join(patchesDir, rel), vA + userLine + '\n');
    gitIn(configDir, ['init', '-q', '-b', 'main']);
    writeFile(path.join(configDir, rel), vA);
    gitCommitAll(configDir, 'gsd install vA');
    writeFile(path.join(configDir, rel), vB);
    gitCommitAll(configDir, 'gsd update to vB');
    writeFile(path.join(configDir, rel), vB + userLine + '\n');
    gitCommitAll(configDir, 'post-update merged state');

    const { status, report } = runVerifier();

    assert.equal(status, 0);
    assert.equal(report.no_baseline, 0, 'the walk must reach the older vA commit');
    assert.equal(report.baseline_covered, 1);
  });

  /** Negative space: no git, no pristine — the #934 advisory posture is unchanged. */
  test('#4135: non-git config dirs keep the ok_no_baseline advisory posture', () => {
    resetFixture();
    const rel = 'gsd-core/workflows/flow-04.md';
    const pristine = '# Flow 4\nOutgoing stock line with substantial content.\n';
    writeBackupMeta({ [rel]: sha256(pristine) });
    writeFile(path.join(patchesDir, rel), pristine + 'user line that survived the merge here\n');
    writeFile(path.join(configDir, rel), 'incoming rewrite\nuser line that survived the merge here\n');

    const { status, report } = runVerifier();

    assert.equal(status, 0);
    assert.equal(report.no_baseline, 1);
    assert.equal(report.results[0].reason, REASON.OK_NO_BASELINE);
    assert.equal(report.baseline_covered, 0);
  });

  /** Negative space: git present but no blob matches the recorded hash. */
  test('#4135: git tier adopts nothing when no blob matches the recorded hash', () => {
    resetFixture();
    const rel = 'gsd-core/workflows/flow-05.md';
    const pristine = '# Flow 5\nOutgoing stock line with substantial content.\n';
    writeBackupMeta({ [rel]: sha256(pristine) });
    writeFile(path.join(patchesDir, rel), pristine + 'user line that survived the merge here\n');
    gitIn(configDir, ['init', '-q', '-b', 'main']);
    writeFile(path.join(configDir, rel), 'history only ever held user-modified bytes\n');
    gitCommitAll(configDir, 'only user state was ever committed');

    const { status, report } = runVerifier();

    assert.equal(status, 0);
    assert.equal(report.no_baseline, 1, 'hash equality is the authority — nothing else is trusted');
    assert.equal(report.results[0].reason, REASON.OK_NO_BASELINE);
  });

  /** Drift-path lock: #3657 is never bypassed by the git tier. */
  test('#4135: canonical drift is never rescued by the git-history tier', () => {
    resetFixture();
    const rel = 'gsd-core/workflows/flow-06.md';
    const pristine = '# Flow 6\nOutgoing stock line with substantial content.\n';
    const drifted = '# Flow 6\nRefreshed newer-release stock line with substance.\n';
    writeBackupMeta({ [rel]: sha256(pristine) });
    writeFile(path.join(patchesDir, rel), pristine + 'user line that survived the merge here\n');
    writeFile(path.join(configDir, rel), drifted + 'user line that survived the merge here\n');
    writeFile(path.join(pristineDir, rel), drifted); // canonical present, hash-mismatched
    gitIn(configDir, ['init', '-q', '-b', 'main']);
    writeFile(path.join(configDir, rel), pristine);
    gitCommitAll(configDir, 'history holds the recorded-hash bytes');

    const { status, report } = runVerifier();

    assert.equal(status, 0);
    assert.equal(report.results[0].reason, REASON.OK_PRISTINE_DRIFT_DETECTED,
      'a present-but-drifted canonical stays drift — no rescue');
    assert.equal(report.drifted, 1);
  });

  /** Precedence lock: a matching canonical pristine beats the git tier. */
  test('#4135: canonical pristine keeps precedence over the git-history tier', () => {
    resetFixture();
    const rel = 'gsd-core/workflows/flow-07.md';
    const pristine = '# Flow 7\nOutgoing stock line with substantial content.\n';
    const droppedLine = 'user customisation line that the merge dropped for flow seven';
    writeBackupMeta({ [rel]: sha256(pristine) });
    writeFile(path.join(patchesDir, rel), pristine + droppedLine + '\n');
    writeFile(path.join(configDir, rel), pristine); // dropped — caught via canonical
    writeFile(path.join(pristineDir, rel), pristine); // canonical, hash-matching
    gitIn(configDir, ['init', '-q', '-b', 'main']);
    writeFile(path.join(configDir, rel), pristine);
    gitCommitAll(configDir, 'history also holds the bytes');

    const { status, report } = runVerifier();

    assert.equal(status, 1);
    assert.equal(report.results[0].reason, REASON.FAIL_USER_LINES_MISSING);
    assert.ok(report.results[0].missing.includes(droppedLine));
  });

  /** Invocation-shape lock: no --pristine-dir → over-broad fallback, no git tier. */
  test('#4135: no git-history resolution when --pristine-dir is not provided', () => {
    resetFixture();
    const rel = 'gsd-core/workflows/flow-08.md';
    const pristine = '# Flow 8\nOutgoing stock line with substantial content.\n';
    const userLine = 'user customisation line that survived the merge for flow eight';
    writeBackupMeta({ [rel]: sha256(pristine) });
    writeFile(path.join(patchesDir, rel), pristine + userLine + '\n');
    gitIn(configDir, ['init', '-q', '-b', 'main']);
    writeFile(path.join(configDir, rel), pristine);
    gitCommitAll(configDir, 'history holds the recorded-hash bytes');
    // Merge kept everything — over-broad mode passes on this shape.
    writeFile(path.join(configDir, rel), pristine + userLine + '\n');

    const r = runNode([
      SCRIPT, '--patches-dir', patchesDir, '--config-dir', configDir, '--json',
    ], { timeoutMs: VERIFIER_TIMEOUT_MS });
    const report = r.stdout && r.stdout.length ? JSON.parse(r.stdout) : null;

    assert.equal(r.exitCode, 0, 'all backup lines present — over-broad fallback passes');
    assert.equal(report.results[0].reason, null,
      'without --pristine-dir the baseline logic (incl. git tier) must not run');
    assert.equal(report.baseline_covered, 0,
      'an over-broad run verifies nothing against a pristine baseline — coverage stays 0');
  });

  /** Module unit: findPristineInGit contract on a real fixture repo. */
  test('#4135: findPristineInGit unit — match, no-match, non-repo', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4135-git-unit-'));
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4135-plain-'));
    try {
      const rel = 'gsd-core/workflows/unit.md';
      const content = '# Unit\noutgoing pristine bytes for the git walk unit test\n';
      gitIn(root, ['init', '-q', '-b', 'main']);
      writeFile(path.join(root, rel), content);
      gitCommitAll(root, 'seed');
      writeFile(path.join(root, rel), 'later user-modified bytes committed on top\n');
      gitCommitAll(root, 'user state');

      assert.equal(findPristineInGit(root, rel, sha256(content)), content,
        'an exact recorded-hash blob in history is returned verbatim');
      assert.equal(findPristineInGit(root, rel, sha256('bytes that never existed anywhere\n')), null,
        'no matching blob resolves to null');
      assert.equal(findPristineInGit(plain, rel, sha256(content)), null,
        'a non-repo directory resolves to null without throwing');
    } finally {
      cleanup(root);
      cleanup(plain);
    }
  });

  /**
   * Workflow contract row (source-text-is-the-product): Step 5a must make
   * coverage a headline and document the opt-in strict gate.
   */
  test('#4135: Step 5a headlines baseline coverage and documents the opt-in strict gate', () => {
    // allow-test-rule: source-text-is-the-product — Step 5a contract text (see #4135)
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.ok(content.includes('Baseline coverage:'),
      'Step 5a must print a Baseline coverage headline, not bury no_baseline in parseable fields');
    assert.ok(content.includes('--min-baseline-coverage'),
      'the opt-in strict coverage gate must be documented for operators');
  });

  /**
   * Fixture: 2 files, exactly 1 baseline-covered — the minimal exact-ratio
   * fixture for the threshold boundary rows.
   */
  function seedTwoFilesOneCovered() {
    const specs = [
      { rel: 'gsd-core/workflows/a.md', covered: true },
      { rel: 'gsd-core/workflows/b.md', covered: false },
    ];
    const pristineHashes = {};
    for (const { rel, covered } of specs) {
      const pristine = `outgoing stock line with substantial content for ${rel}\n`;
      const userLine = `user customisation line that survived the merge for ${rel}\n`;
      pristineHashes[rel] = sha256(pristine);
      writeFile(path.join(patchesDir, rel), pristine + userLine);
      writeFile(path.join(configDir, rel), `incoming rewrite for ${rel}\n` + userLine);
      if (covered) writeFile(path.join(pristineDir, rel), pristine);
    }
    writeBackupMeta(pristineHashes);
  }
});
  });
}

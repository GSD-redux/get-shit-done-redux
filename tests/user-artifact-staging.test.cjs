'use strict';

/**
 * User Artifact Staging Module — the module's own contract (#2875, epic
 * #2866 Phase 6, governed by ADR-3574 and
 * .gsd/phase/feat-2875-materialization-primitives/50-test-matrix.md).
 *
 * Confinement rows (E1-E5) live in tests/install-write-confinement.test.cjs
 * (this suite's own file-count ratchet keeps them there — see 50-test-matrix.md
 * "Suites"). Call-site integration (Hermes/Claude dev-preferences migration,
 * the mainline gsd-core copy, and C7 production-reachability) lives in
 * tests/install-runtime-artifacts.test.cjs.
 *
 * Crash-window injection is by monkeypatching a real `node:fs` method and
 * restoring it in a `finally` — never chmod/permission tricks (root bypasses
 * mode bits in CI). This works because install-fs-adapter.cts's REAL_ADAPTER
 * calls `nodeFs.<method>(...)` as a live property lookup on the `node:fs`
 * module object at call time, not a captured reference (see that module's
 * own doc comment).
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const {
  stageUserArtifacts,
  restoreStagedUserArtifacts,
  discardStagedUserArtifacts,
  recoverOrphanedUserArtifacts,
} = require('../gsd-core/bin/lib/user-artifact-staging.cjs');
const { withInstallFs } = require('../gsd-core/bin/lib/install-fs-adapter.cjs');
const { copyPreservingSymlink } = require('../gsd-core/bin/lib/installer-migrations.cjs');

function mktemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function stagingRootFor(configDir) {
  return path.join(configDir, '.gsd-staging', 'user-artifacts');
}

// ---------------------------------------------------------------------------
// A. Staging contract
// ---------------------------------------------------------------------------

describe('user-artifact-staging: A. staging contract', () => {
  test('A1: one existing file stages before any wipe; record written after', (t) => {
    const destDir = mktemp('gsd-uas-a1-dest-');
    const configDir = mktemp('gsd-uas-a1-cfg-');
    t.after(() => { cleanup(destDir); cleanup(configDir); });

    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'hello world\n', 'utf8');
    const staged = stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRootFor(configDir));

    assert.ok(fs.existsSync(path.join(staged.filesDir, 'USER-PROFILE.md')), 'copy landed in staging');
    assert.ok(fs.existsSync(staged.recordPath), 'record.json exists');
    const record = JSON.parse(fs.readFileSync(staged.recordPath, 'utf8'));
    assert.deepEqual(record.names, ['USER-PROFILE.md']);
    assert.equal(record.destDir, path.resolve(destDir));
  });

  test('A2: file absent from destDir — not staged, no record entry, no throw', (t) => {
    const destDir = mktemp('gsd-uas-a2-dest-');
    const configDir = mktemp('gsd-uas-a2-cfg-');
    t.after(() => { cleanup(destDir); cleanup(configDir); });

    const staged = stageUserArtifacts(destDir, ['does-not-exist.md'], stagingRootFor(configDir));
    assert.deepEqual(staged.names, []);
    assert.ok(!fs.existsSync(path.join(staged.filesDir, 'does-not-exist.md')));
  });

  test('A3: fileNames empty — empty staging, record still coherent', (t) => {
    const destDir = mktemp('gsd-uas-a3-dest-');
    const configDir = mktemp('gsd-uas-a3-cfg-');
    t.after(() => { cleanup(destDir); cleanup(configDir); });

    const staged = stageUserArtifacts(destDir, [], stagingRootFor(configDir));
    assert.deepEqual(staged.names, []);
    assert.ok(fs.existsSync(staged.recordPath), 'record still written for an empty batch');
    const record = JSON.parse(fs.readFileSync(staged.recordPath, 'utf8'));
    assert.deepEqual(record.names, []);
  });

  test('A4: symlinked file — the link is recreated, the referent is never read', (t) => {
    const destDir = mktemp('gsd-uas-a4-dest-');
    const configDir = mktemp('gsd-uas-a4-cfg-');
    const targetDir = mktemp('gsd-uas-a4-target-');
    t.after(() => { cleanup(destDir); cleanup(configDir); cleanup(targetDir); });

    const targetFile = path.join(targetDir, 'secret.txt');
    fs.writeFileSync(targetFile, 'referent-bytes-must-never-be-read');
    fs.symlinkSync(targetFile, path.join(destDir, 'USER-PROFILE.md'));

    const originalReadFileSync = fs.readFileSync;
    let readFileSyncCalledOnTarget = false;
    fs.readFileSync = function patched(p, ...rest) {
      if (String(p) === targetFile) readFileSyncCalledOnTarget = true;
      return originalReadFileSync.call(fs, p, ...rest);
    };
    let staged;
    try {
      staged = stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRootFor(configDir));
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    assert.equal(readFileSyncCalledOnTarget, false, 'referent bytes must never be read');
    const stagedPath = path.join(staged.filesDir, 'USER-PROFILE.md');
    assert.ok(fs.lstatSync(stagedPath).isSymbolicLink(), 'staged copy is itself a symlink');
    assert.equal(fs.readlinkSync(stagedPath), targetFile);
  });

  test('A5: staged copy is byte-identical, including CRLF and a trailing newline', (t) => {
    const destDir = mktemp('gsd-uas-a5-dest-');
    const configDir = mktemp('gsd-uas-a5-cfg-');
    t.after(() => { cleanup(destDir); cleanup(configDir); });

    const content = 'line one\r\nline two\r\nno-trailing-newline';
    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), content);
    const staged = stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRootFor(configDir));
    const stagedContent = fs.readFileSync(path.join(staged.filesDir, 'USER-PROFILE.md'), 'utf8');
    assert.equal(stagedContent, content);
  });

  test('A6: staging the same destDir twice does not corrupt the first record, and clears stale files from the prior batch', (t) => {
    const destDir = mktemp('gsd-uas-a6-dest-');
    const configDir = mktemp('gsd-uas-a6-cfg-');
    t.after(() => { cleanup(destDir); cleanup(configDir); });

    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'v1');
    fs.writeFileSync(path.join(destDir, 'dev-preferences.md'), 'stale-from-first-batch');
    const first = stageUserArtifacts(destDir, ['USER-PROFILE.md', 'dev-preferences.md'], stagingRootFor(configDir));
    assert.deepEqual(first.names.sort(), ['USER-PROFILE.md', 'dev-preferences.md']);

    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'v2');
    // Second call only asks for USER-PROFILE.md — dev-preferences.md is no
    // longer part of this batch. Deterministic key reuse is asserted
    // directly against `first`, captured BEFORE this call — #2875 defect
    // fix: previously this equality check was performed by folding a SECOND
    // `stageUserArtifacts` call directly into the assertion, which
    // overwrote `first`'s own on-disk state (record.json + files/) before it
    // was ever re-examined, so the test's own "does not corrupt the first
    // record" claim was never actually checked.
    const second = stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRootFor(configDir));
    assert.equal(second.entryDir, first.entryDir, 'same destDir maps to the same staging entry (deterministic key)');

    const content = fs.readFileSync(path.join(second.filesDir, 'USER-PROFILE.md'), 'utf8');
    assert.equal(content, 'v2', 'second stage call overwrites the first cleanly, no corruption');
    assert.ok(
      !fs.existsSync(path.join(second.filesDir, 'dev-preferences.md')),
      'the entry dir is cleared FIRST — a file from a prior batch must not linger alongside the new one',
    );

    // #2875 defect fix: re-examine `first`'s OWN captured paths (identical to
    // `second`'s, by construction — same destDir, same deterministic key)
    // AFTER the second stage call, proving the record was cleanly REPLACED,
    // not merged or corrupted. A bug that failed to clear the entry dir
    // before rewriting record.json (e.g. names from both batches surviving)
    // would fail this and did not fail the old assertions.
    const recordAfterSecondStage = JSON.parse(fs.readFileSync(first.recordPath, 'utf8'));
    assert.deepEqual(
      recordAfterSecondStage.names, ['USER-PROFILE.md'],
      'the record at the path `first` originally wrote must now reflect ONLY the second batch',
    );
    assert.ok(
      !fs.existsSync(path.join(first.filesDir, 'dev-preferences.md')),
      'dev-preferences.md staged by the FIRST batch must be gone from the (shared) files dir after the second call',
    );
  });

  test('A7: crash between copy and record — treated as incomplete, not a recovery source', (t) => {
    const destDir = mktemp('gsd-uas-a7-dest-');
    const configDir = mktemp('gsd-uas-a7-cfg-');
    t.after(() => { cleanup(destDir); cleanup(configDir); });

    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'content');
    const stagingRoot = stagingRootFor(configDir);

    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function patched(p, ...rest) {
      if (String(p).endsWith('record.json')) {
        throw Object.assign(new Error('simulated crash before record commit'), { code: 'EIO' });
      }
      return originalWriteFileSync.call(fs, p, ...rest);
    };
    try {
      assert.throws(() => stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot), /simulated crash/);
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    // The copy landed (files/ populated) but no record.json — recovery must
    // ignore this half-staged entry entirely (B4).
    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.deepEqual(result.recovered, [], 'a recordless staging entry is never a recovery source');
  });

  test('A8: the record timestamp comes from the injected clock seam, never the real wall clock', (t) => {
    const destDir = mktemp('gsd-uas-a8-dest-');
    const configDir = mktemp('gsd-uas-a8-cfg-');
    t.after(() => { cleanup(destDir); cleanup(configDir); });

    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'x');
    const pinnedMs = Date.parse('2001-01-01T00:00:00.000Z');
    const fakeClock = { now: () => pinnedMs };
    const staged = stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRootFor(configDir), { clock: fakeClock });
    const record = JSON.parse(fs.readFileSync(staged.recordPath, 'utf8'));
    assert.equal(record.timestamp, new Date(pinnedMs).toISOString());
  });

  test('A9: restoreStagedUserArtifacts opts.rename restores a staged name under a DIFFERENT destination file name', (t) => {
    const destDir = mktemp('gsd-uas-a9-dest-');
    const configDir = mktemp('gsd-uas-a9-cfg-');
    t.after(() => { cleanup(destDir); cleanup(configDir); });

    fs.writeFileSync(path.join(destDir, 'dev-preferences.md'), 'legacy content');
    const staged = stageUserArtifacts(destDir, ['dev-preferences.md'], stagingRootFor(configDir));
    cleanup(destDir);
    fs.mkdirSync(destDir, { recursive: true });

    restoreStagedUserArtifacts(destDir, staged, { rename: { 'dev-preferences.md': 'gsd-dev-preferences.md' } });

    assert.ok(!fs.existsSync(path.join(destDir, 'dev-preferences.md')), 'the OLD name must not be recreated');
    assert.equal(
      fs.readFileSync(path.join(destDir, 'gsd-dev-preferences.md'), 'utf8'),
      'legacy content',
      'content lands under the renamed destination',
    );
  });
});

// ---------------------------------------------------------------------------
// B. The crash window
// ---------------------------------------------------------------------------

describe('user-artifact-staging: B. the crash window (F19)', () => {
  test('B1 (the F19 regression row): crash between wipe and restore, then recovery — byte-identical', (t) => {
    const configDir = mktemp('gsd-uas-b1-cfg-');
    t.after(() => cleanup(configDir));
    const destDir = path.join(configDir, 'gsd-core');
    fs.mkdirSync(destDir, { recursive: true });
    const stagingRoot = stagingRootFor(configDir);

    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'my profile content\n');
    stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot);

    // Simulate the crash: the wipe ran, the process died before restore.
    cleanup(destDir);
    assert.ok(!fs.existsSync(destDir), 'destDir is gone — this is the F19 crash window');

    // Next run: recovery, BEFORE any new preserve/wipe cycle.
    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.equal(result.recovered.length, 1);
    assert.equal(
      fs.readFileSync(path.join(destDir, 'USER-PROFILE.md'), 'utf8'),
      'my profile content\n',
    );
  });

  test('B2 (negative proof): the in-memory-only shape this replaces cannot recover, proving the row is real', (t) => {
    // preserveUserArtifacts/restoreUserArtifacts (pre-#2875) held content ONLY
    // in a Map — nothing durable ever touched disk between preserve and a
    // process death. This reproduces that exact shape inline (no disk write)
    // to demonstrate recoverOrphanedUserArtifacts has nothing to find: proof
    // that B1's green result comes from the staging fix, not from the test
    // being unable to fail.
    const configDir = mktemp('gsd-uas-b2-cfg-');
    t.after(() => cleanup(configDir));
    const destDir = path.join(configDir, 'gsd-core');
    fs.mkdirSync(destDir, { recursive: true });
    const stagingRoot = stagingRootFor(configDir);

    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'never staged to disk');
    const legacyInMemoryMap = new Map([['USER-PROFILE.md', fs.readFileSync(path.join(destDir, 'USER-PROFILE.md'), 'utf8')]]);
    void legacyInMemoryMap; // held only in the process's heap — a crash here loses it

    cleanup(destDir); // the crash: process dies right here, map is gone

    // #2875 defect fix: mirror B1's own post-crash sequence EXACTLY (recover,
    // THEN recreate destDir, THEN check for the specific file) — the only
    // difference from B1 is that stageUserArtifacts was never called. The
    // previous version asserted `!fs.existsSync(destDir)` immediately after
    // `cleanup(destDir)` deleted it on the line above, which is trivially
    // true regardless of anything recovery does and never actually exercised
    // recovery's behavior; it was also structurally identical to C5 (no
    // staging root at all), so it could not distinguish "recovery correctly
    // finds nothing" from "recovery is broken in a way that never finds
    // anything, ever". This version recreates destDir (as a real
    // preserve/wipe cycle would) and checks the recovered destination
    // directly — proving negatively that recovery does not (and cannot)
    // resurrect content nothing ever staged to disk.
    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.deepEqual(result.recovered, [], 'nothing was ever staged to disk — recovery correctly finds nothing');
    fs.mkdirSync(destDir, { recursive: true });
    assert.ok(
      !fs.existsSync(path.join(destDir, 'USER-PROFILE.md')),
      'the file is genuinely lost under the pre-#2875 shape — recovery cannot resurrect content that was never staged',
    );
  });

  test('B4: crash before the record is written — nothing restored, half-staged dir left alone', (t) => {
    const configDir = mktemp('gsd-uas-b4-cfg-');
    t.after(() => cleanup(configDir));
    const stagingRoot = stagingRootFor(configDir);
    const destDir = path.join(configDir, 'gsd-core');
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'x');

    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function patched(p, ...rest) {
      if (String(p).endsWith('record.json')) throw Object.assign(new Error('crash'), { code: 'EIO' });
      return originalWriteFileSync.call(fs, p, ...rest);
    };
    try {
      assert.throws(() => stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot));
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.deepEqual(result.recovered, []);
    assert.deepEqual(result.skipped, []);
    // The half-staged entry itself is left in place (not a recovery source,
    // but also not swept — it is evidence, not garbage).
    const entries = fs.readdirSync(stagingRoot);
    assert.equal(entries.length, 1, 'the half-staged entry dir is still present for inspection');
  });

  test('B5: crash after successful restore — staging already discarded, next run finds no orphan', (t) => {
    const configDir = mktemp('gsd-uas-b5-cfg-');
    t.after(() => cleanup(configDir));
    const destDir = path.join(configDir, 'gsd-core');
    fs.mkdirSync(destDir, { recursive: true });
    const stagingRoot = stagingRootFor(configDir);

    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'restored already');
    const staged = stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot);
    cleanup(destDir);
    fs.mkdirSync(destDir, { recursive: true });
    restoreStagedUserArtifacts(destDir, staged);
    discardStagedUserArtifacts(staged);

    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.deepEqual(result.recovered, [], 'nothing left to recover — the batch was already discarded');
    assert.deepEqual(result.skipped, []);
  });
});

// ---------------------------------------------------------------------------
// C. Recovery semantics — the anti-inertness rows
// ---------------------------------------------------------------------------

describe('user-artifact-staging: C. recovery semantics', () => {
  test('C1: orphan exists, destDir file absent — restored', (t) => {
    const configDir = mktemp('gsd-uas-c1-cfg-');
    t.after(() => cleanup(configDir));
    const destDir = path.join(configDir, 'gsd-core');
    fs.mkdirSync(destDir, { recursive: true });
    const stagingRoot = stagingRootFor(configDir);
    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'c1');
    stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot);
    cleanup(destDir);

    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.equal(result.recovered.length, 1);
    assert.equal(fs.readFileSync(path.join(destDir, 'USER-PROFILE.md'), 'utf8'), 'c1');
  });

  test('C2: orphan exists, destDir file present — NOT overwritten', (t) => {
    const configDir = mktemp('gsd-uas-c2-cfg-');
    t.after(() => cleanup(configDir));
    const destDir = path.join(configDir, 'gsd-core');
    fs.mkdirSync(destDir, { recursive: true });
    const stagingRoot = stagingRootFor(configDir);
    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'orphaned-content');
    stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot);
    // The destDir file was NOT wiped this time — a fresh, different file is present.
    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'current-user-content');

    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.equal(result.recovered.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'dest-already-present');
    assert.equal(fs.readFileSync(path.join(destDir, 'USER-PROFILE.md'), 'utf8'), 'current-user-content');
  });

  test('C3: recorded destDir no longer exists — recreated, never throws', (t) => {
    const configDir = mktemp('gsd-uas-c3-cfg-');
    t.after(() => cleanup(configDir));
    const destDir = path.join(configDir, 'legacy', 'gsd');
    fs.mkdirSync(destDir, { recursive: true });
    const stagingRoot = stagingRootFor(configDir);
    fs.writeFileSync(path.join(destDir, 'dev-preferences.md'), 'c3');
    stageUserArtifacts(destDir, ['dev-preferences.md'], stagingRoot);
    // Remove the WHOLE parent tree, not just destDir.
    cleanup(path.join(configDir, 'legacy'));
    assert.ok(!fs.existsSync(destDir));

    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.equal(result.recovered.length, 1);
    assert.equal(fs.readFileSync(path.join(destDir, 'dev-preferences.md'), 'utf8'), 'c3');
  });

  test('C4: recovery runs before the preserve step — recovered file is then protected by the ordinary cycle', (t) => {
    const configDir = mktemp('gsd-uas-c4-cfg-');
    t.after(() => cleanup(configDir));
    const destDir = path.join(configDir, 'gsd-core');
    fs.mkdirSync(destDir, { recursive: true });
    const stagingRoot = stagingRootFor(configDir);
    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'c4');
    stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot);
    cleanup(destDir);

    recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.ok(fs.existsSync(path.join(destDir, 'USER-PROFILE.md')), 'recovered before the ordinary cycle runs');

    // The ordinary preserve step now sees the recovered file and protects it.
    const staged = stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot);
    assert.deepEqual(staged.names, ['USER-PROFILE.md']);
  });

  test('C5: no staging root at all — no-op, no throw, no directory created', (t) => {
    const configDir = mktemp('gsd-uas-c5-cfg-');
    t.after(() => cleanup(configDir));
    const stagingRoot = stagingRootFor(configDir); // never created
    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.deepEqual(result, { recovered: [], skipped: [] });
    assert.ok(!fs.existsSync(stagingRoot), 'recovery must not create a staging root');
  });

  test('C6: corrupt/truncated record JSON — ignored, never a crash', (t) => {
    const configDir = mktemp('gsd-uas-c6-cfg-');
    t.after(() => cleanup(configDir));
    const stagingRoot = stagingRootFor(configDir);
    const entryDir = path.join(stagingRoot, 'deadbeefdeadbeef');
    fs.mkdirSync(path.join(entryDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(entryDir, 'files', 'USER-PROFILE.md'), 'x');
    fs.writeFileSync(path.join(entryDir, 'record.json'), '{ this is not valid json');

    assert.doesNotThrow(() => recoverOrphanedUserArtifacts(stagingRoot, configDir));
    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.deepEqual(result.recovered, []);
    // Malformed record is left alone for inspection, not swept.
    assert.ok(fs.existsSync(entryDir), 'malformed staging entry is left in place, not deleted');
  });

  test('C8: configDir is an explicit parameter, not derived from stagingRoot\'s path shape — a record naming a destDir outside the EXPLICITLY-passed configDir is refused', (t) => {
    // stagingRoot deliberately lives OUTSIDE configDir entirely (no nested
    // relationship at all) — the two-directories-up derivation this replaced
    // would have computed a nonsense confinement root here. The explicit
    // parameter is what makes the confinement decision correct regardless of
    // where stagingRoot physically lives.
    const configDir = mktemp('gsd-uas-c8-cfg-');
    const unrelatedStagingParent = mktemp('gsd-uas-c8-unrelated-');
    const outsideConfigDir = mktemp('gsd-uas-c8-outside-');
    t.after(() => { cleanup(configDir); cleanup(unrelatedStagingParent); cleanup(outsideConfigDir); });

    const stagingRoot = path.join(unrelatedStagingParent, 'wherever', 'staging');
    const entryDir = path.join(stagingRoot, 'c8entry0000000000');
    fs.mkdirSync(path.join(entryDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(entryDir, 'files', 'USER-PROFILE.md'), 'attacker or stale data');
    // destDir resolves under outsideConfigDir, NOT under configDir.
    fs.writeFileSync(
      path.join(entryDir, 'record.json'),
      JSON.stringify({ destDir: path.join(outsideConfigDir, 'gsd-core'), names: ['USER-PROFILE.md'], timestamp: new Date().toISOString() }),
    );

    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.equal(result.recovered.length, 0, 'must refuse — destDir is outside the explicitly-passed configDir');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'destDir-outside-confinement');
    assert.ok(
      !fs.existsSync(path.join(outsideConfigDir, 'gsd-core', 'USER-PROFILE.md')),
      'must never write to the recorded destDir when it escapes the explicit configDir',
    );
  });

  // Confinement/symlink rows (dangling-symlink destination, symlinked
  // ancestor, separator-in-name) live in tests/install-write-confinement.test.cjs
  // as E6-E9, alongside E1-E5 — this suite's own file-count ratchet keeps
  // confinement rows there (see this file's own header doc comment).

  // #2875 defect fix: recoverOrphanedUserArtifacts's "never throws" contract
  // was false — mkdirSync/stagedCopy/the final rmSync were all unguarded, so
  // one unrecoverable entry (e.g. a `files/<name>` that is unexpectedly a
  // directory, causing the symlink-safe copy to throw) propagated out of the
  // whole function, and — because it threw BEFORE that entry was ever
  // cleaned up — permanently bricked install/uninstall on every future run.
  test('C13: an entry that cannot be recovered (a directory staged where a file is expected) never throws, and other entries still recover', (t) => {
    const configDir = mktemp('gsd-uas-c13-cfg-');
    t.after(() => cleanup(configDir));
    const stagingRoot = stagingRootFor(configDir);

    // Entry 1: genuinely broken — files/BROKEN.md is a DIRECTORY, not a file,
    // which the symlink-safe copy cannot handle.
    const brokenDestDir = path.join(configDir, 'broken-dest');
    fs.mkdirSync(brokenDestDir, { recursive: true });
    const brokenEntryDir = path.join(stagingRoot, 'c13brokenentry00');
    fs.mkdirSync(path.join(brokenEntryDir, 'files', 'BROKEN.md'), { recursive: true }); // a DIR, not a file
    fs.writeFileSync(
      path.join(brokenEntryDir, 'record.json'),
      JSON.stringify({ destDir: path.resolve(brokenDestDir), names: ['BROKEN.md'], timestamp: new Date().toISOString() }),
    );

    // Entry 2: a perfectly ordinary, recoverable batch.
    const goodDestDir = path.join(configDir, 'good-dest');
    fs.mkdirSync(goodDestDir, { recursive: true });
    fs.writeFileSync(path.join(goodDestDir, 'USER-PROFILE.md'), 'good content');
    stageUserArtifacts(goodDestDir, ['USER-PROFILE.md'], stagingRoot);
    cleanup(path.join(goodDestDir, 'USER-PROFILE.md'));

    let result;
    assert.doesNotThrow(() => { result = recoverOrphanedUserArtifacts(stagingRoot, configDir); });
    assert.ok(
      result.recovered.some((r) => r.name === 'USER-PROFILE.md' && r.destDir === path.resolve(goodDestDir)),
      'the OTHER (good) batch must still be recovered even though a sibling batch is broken',
    );
    assert.ok(fs.existsSync(brokenEntryDir), 'the broken entry must be LEFT IN PLACE, not silently swept, since it was never actually recovered');
  });
});

// ---------------------------------------------------------------------------
// D. Fs seam completeness
// ---------------------------------------------------------------------------

describe('user-artifact-staging: D. fs seam completeness', () => {
  test('D1: staging under an injected fake adapter resolves; no real path created', (t) => {
    const configDir = mktemp('gsd-uas-d1-cfg-');
    t.after(() => cleanup(configDir));
    const destDir = path.join(configDir, 'gsd-core');
    const stagingRoot = stagingRootFor(configDir);

    const store = new Map();
    const norm = (p) => path.normalize(String(p));
    store.set(norm(destDir), { type: 'dir' });
    store.set(norm(path.join(destDir, 'USER-PROFILE.md')), { type: 'file', content: 'fake-fs-content' });
    let fakeRmSyncCalls = 0;
    const fake = {
      existsSync: (p) => store.has(norm(p)),
      mkdirSync: (p) => { store.set(norm(p), { type: 'dir' }); },
      // #2875 defect fix: stageUserArtifacts's entryDir-clearing step calls
      // installFs().rmSync unconditionally — a partial fake omitting it
      // previously fell through to REAL fs.rmSync silently (install-fs-
      // adapter.cts's PARTIAL-ADAPTER TRAP), which this test's own negative
      // assertion below could not detect (it only checked `stagingRoot`,
      // which real rmSync on a non-existent real path no-ops against
      // harmlessly with `force: true` — vacuously true either way).
      rmSync: (p) => {
        fakeRmSyncCalls++;
        const n = norm(p);
        store.delete(n);
        const prefix = n.endsWith(path.sep) ? n : n + path.sep;
        for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
      },
      writeFileSync: (p, data) => { store.set(norm(p), { type: 'file', content: data }); },
      lstatSync: (p) => {
        const e = store.get(norm(p));
        if (!e) { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; }
        return { isFile: () => e.type === 'file', isDirectory: () => e.type === 'dir', isSymbolicLink: () => false };
      },
      copyFileSync: (src, dest) => {
        const e = store.get(norm(src));
        store.set(norm(dest), { type: 'file', content: e ? e.content : '' });
      },
    };

    const staged = withInstallFs(fake, () => stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot));
    assert.deepEqual(staged.names, ['USER-PROFILE.md']);
    assert.ok(store.has(norm(path.join(staged.filesDir, 'USER-PROFILE.md'))), 'landed in the fake store');
    assert.ok(fakeRmSyncCalls > 0, 'the entryDir-clearing step must route through the FAKE rmSync, proving this is a real negative check');
    assert.ok(!fs.existsSync(stagingRoot), 'no real filesystem path was ever created');
  });

  test('D3: staging touches zero real fs under a fake adapter (poison by path)', (t) => {
    const configDir = mktemp('gsd-uas-d3-cfg-');
    t.after(() => cleanup(configDir));
    const destDir = path.join(configDir, 'gsd-core');
    const stagingRoot = stagingRootFor(configDir);

    const store = new Map();
    const norm = (p) => path.normalize(String(p));
    store.set(norm(destDir), { type: 'dir' });
    store.set(norm(path.join(destDir, 'USER-PROFILE.md')), { type: 'file', content: 'x' });
    const fake = {
      existsSync: (p) => store.has(norm(p)),
      mkdirSync: (p) => { store.set(norm(p), { type: 'dir' }); },
      // #2875 defect fix: this fake previously omitted rmSync, so
      // stageUserArtifacts's entryDir-clearing step (installFs().rmSync)
      // fell through to REAL fs.rmSync (install-fs-adapter.cts's
      // PARTIAL-ADAPTER TRAP) — which is exactly what this test's own
      // poisoning below is supposed to catch, and did: `real fs.rmSync
      // touched under a fake adapter`. Implementing it here is the fix.
      rmSync: (p) => {
        const n = norm(p);
        store.delete(n);
        const prefix = n.endsWith(path.sep) ? n : n + path.sep;
        for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
      },
      writeFileSync: (p, data) => { store.set(norm(p), { type: 'file', content: data }); },
      lstatSync: (p) => {
        const e = store.get(norm(p));
        if (!e) { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; }
        return { isFile: () => e.type === 'file', isDirectory: () => e.type === 'dir', isSymbolicLink: () => false };
      },
      copyFileSync: (src, dest) => {
        const e = store.get(norm(src));
        store.set(norm(dest), { type: 'file', content: e ? e.content : '' });
      },
    };

    // Poison every real fs method this call tree could touch — a gap here
    // fires as the poisoned method throwing, never a silent pass (Phase 5's
    // F2 pattern, install-fs-adapter.cts's own doc comment).
    const realFs = require('node:fs');
    const poisoned = ['existsSync', 'mkdirSync', 'writeFileSync', 'lstatSync', 'copyFileSync', 'symlinkSync', 'readlinkSync', 'rmSync'];
    const originals = {};
    for (const m of poisoned) {
      originals[m] = realFs[m];
      realFs[m] = () => { throw new Error(`real fs.${m} touched under a fake adapter`); };
    }
    try {
      const staged = withInstallFs(fake, () => stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot));
      assert.deepEqual(staged.names, ['USER-PROFILE.md']);
    } finally {
      for (const m of poisoned) realFs[m] = originals[m];
    }
  });

  test('D4 (correctness, not error-handling): adapter throws mid-stage — the failure propagates', (t) => {
    const configDir = mktemp('gsd-uas-d4-cfg-');
    t.after(() => cleanup(configDir));
    const destDir = path.join(configDir, 'gsd-core');
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'must-survive');
    const stagingRoot = stagingRootFor(configDir);

    const originalMkdirSync = fs.mkdirSync;
    fs.mkdirSync = function patched(p, ...rest) {
      if (String(p).includes('.gsd-staging')) {
        throw Object.assign(new Error('simulated EACCES creating staging dir'), { code: 'EACCES' });
      }
      return originalMkdirSync.call(fs, p, ...rest);
    };
    try {
      assert.throws(
        () => stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot),
        /EACCES|simulated/,
        'staging failure must propagate — a caller cannot proceed to wipe having staged nothing',
      );
    } finally {
      fs.mkdirSync = originalMkdirSync;
    }
    // The source file is untouched — nothing wiped, because the throw
    // happened before any caller-side wipe could run.
    assert.equal(fs.readFileSync(path.join(destDir, 'USER-PROFILE.md'), 'utf8'), 'must-survive');
  });

  test('D2 (regression): copyPreservingSymlink is unaffected for its existing ambient-fs migration caller', (t) => {
    const srcDir = mktemp('gsd-uas-d2-src-');
    const destDir = mktemp('gsd-uas-d2-dest-');
    t.after(() => { cleanup(srcDir); cleanup(destDir); });

    const srcFile = path.join(srcDir, 'a.txt');
    fs.writeFileSync(srcFile, 'plain-file-content');
    const destFile = path.join(destDir, 'a.txt');
    // No withInstallFs wrap — ambient default resolves to real fs, exactly
    // the migration engine's own call shape.
    copyPreservingSymlink(srcFile, destFile);
    assert.equal(fs.readFileSync(destFile, 'utf8'), 'plain-file-content');

    const linkSrc = path.join(srcDir, 'link.txt');
    fs.symlinkSync(srcFile, linkSrc);
    const linkDest = path.join(destDir, 'link.txt');
    copyPreservingSymlink(linkSrc, linkDest);
    assert.ok(fs.lstatSync(linkDest).isSymbolicLink());
  });
});

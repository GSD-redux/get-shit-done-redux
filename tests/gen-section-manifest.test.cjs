'use strict';

/**
 * gen-section-manifest.cjs drift-guard tests — 50-test-matrix.md rows 29-41
 * (issue #2932, epic #1671 Phase 5,
 * `.gsd/phase/chore-2932-init-section-manifest/50-test-matrix.md` section D).
 *
 * Every test spawns the real CLI (execFileSync) against a temp fixture tree
 * shaped like the real repo (`<root>/gsd-core/workflows/<name>.md` +
 * `<root>/gsd-core/workflows/<name>/steps/<id>.md`), using the generator's
 * `--workflows-dir`/`--manifest-path`/`--repo-root` overrides — no fs
 * monkeypatching except rows 40/41, which inject the exact fault
 * `writeManifestAtomically` cannot otherwise be made to hit (CONTRIBUTING.md
 * / CLAUDE.md cross-platform IO-failure rule: monkeypatch the `fs` method,
 * restore via `t.after()`, never `chmod 0o000`).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');
const {
  buildFreshManifest,
  writeManifestAtomically,
  REASON,
} = require('../scripts/gen-section-manifest.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-section-manifest.cjs');

const STACK_FRAME_RE = /\n\s+at\s+\S+\s+\(.*:\d+:\d+\)/;

// ─── Fixture builder ───────────────────────────────────────────────────────

/**
 * Build a `<tmpRoot>/gsd-core/workflows/` tree containing one workflow file
 * plus (optionally) its `steps/` directory, matching the real repo's
 * relative shape exactly so `--repo-root <tmpRoot>` produces the same
 * `gsd-core/workflows/...` POSIX `read` paths the real generator emits.
 *
 * @param {string} tmpRoot
 * @param {string} workflowName - e.g. "sample" -> gsd-core/workflows/sample.md
 * @param {string} sourceContent
 * @param {{[stepFileName: string]: string}} [stepFiles]
 * @returns {{ workflowsDir: string, manifestPath: string }}
 */
function buildFixture(tmpRoot, workflowName, sourceContent, stepFiles = {}) {
  const workflowsDir = path.join(tmpRoot, 'gsd-core', 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(path.join(workflowsDir, `${workflowName}.md`), sourceContent, 'utf8');

  if (Object.keys(stepFiles).length > 0) {
    const stepsDir = path.join(workflowsDir, workflowName, 'steps');
    fs.mkdirSync(stepsDir, { recursive: true });
    for (const [name, content] of Object.entries(stepFiles)) {
      fs.writeFileSync(path.join(stepsDir, name), content, 'utf8');
    }
  }

  return { workflowsDir, manifestPath: path.join(workflowsDir, 'section-manifest.json') };
}

/** A single well-formed marker + matching step-file body. */
function markerSource(id, when, refFile) {
  return [
    '# Sample workflow',
    '',
    `<!-- gsd:section id="${id}" when="${when}" -->`,
    `Read and execute \`gsd-core/workflows/sample/steps/${refFile}\`.`,
    '<!-- /gsd:section -->',
    '',
  ].join('\n');
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function runGenSectionManifest(args, cwd = ROOT) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
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

function parseJsonReport(stdout) {
  return JSON.parse(stdout.trim());
}

// ─── D. Generator drift-guard (rows 29-41) ─────────────────────────────────

describe('gen-section-manifest.cjs --check / --write (matrix D)', () => {
  test('checkExitsZeroWhenManifestMatchesSource (row 29)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    const { workflowsDir, manifestPath } = buildFixture(
      tmpRoot,
      'sample',
      markerSource('handle-x', 'always', 'handle-x.md'),
      { 'handle-x.md': '<step name="handle_x">\nbody\n</step>\n' },
    );
    const fresh = buildFreshManifest(workflowsDir, tmpRoot);
    fs.writeFileSync(manifestPath, JSON.stringify(fresh, null, 2) + '\n', 'utf8');

    const r = runGenSectionManifest([
      '--check', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
    ]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  });

  test('checkExitsOneAndNamesFileWhenManifestIsStale (row 30)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    const { workflowsDir, manifestPath } = buildFixture(
      tmpRoot,
      'sample',
      markerSource('handle-x', 'always', 'handle-x.md'),
      { 'handle-x.md': '<step name="handle_x">\nbody\n</step>\n' },
    );
    // Stale: valid shape, but "when" no longer matches the source's marker.
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ sections: [{ id: 'handle-x', when: 'flag:--wave', read: 'gsd-core/workflows/sample/steps/handle-x.md' }] }, null, 2) + '\n',
      'utf8',
    );

    const r = runGenSectionManifest([
      '--check', '--json', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
    ]);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'no bare stack trace for a stale manifest');
    const report = parseJsonReport(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_STALE);
    assert.equal(report.subject, manifestPath, 'report must name the stale manifest file');
  });

  test('writeThenCheckRoundTripsClean (row 31)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    const { workflowsDir, manifestPath } = buildFixture(
      tmpRoot,
      'sample',
      markerSource('handle-x', 'always', 'handle-x.md'),
      { 'handle-x.md': '<step name="handle_x">\nbody\n</step>\n' },
    );

    const w = runGenSectionManifest([
      '--write', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
    ]);
    assert.equal(w.code, 0, `stderr: ${w.stderr}`);
    assert.ok(fs.existsSync(manifestPath));

    const c = runGenSectionManifest([
      '--check', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
    ]);
    assert.equal(c.code, 0, '--check must be clean immediately after --write');
  });

  test('checkFailsCleanlyWhenManifestAbsent (row 32)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    const { workflowsDir, manifestPath } = buildFixture(
      tmpRoot,
      'sample',
      markerSource('handle-x', 'always', 'handle-x.md'),
      { 'handle-x.md': '<step name="handle_x">\nbody\n</step>\n' },
    );
    assert.equal(fs.existsSync(manifestPath), false, 'sanity: manifest must not exist yet');

    const r = runGenSectionManifest([
      '--check', '--json', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
    ]);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'an absent manifest must not crash, just fail closed');
    const report = parseJsonReport(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_MANIFEST_MISSING);
    assert.equal(report.subject, manifestPath);
  });

  test('checkFailsCleanlyOnEmptyManifestFile (row 33)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    const { workflowsDir, manifestPath } = buildFixture(
      tmpRoot,
      'sample',
      markerSource('handle-x', 'always', 'handle-x.md'),
      { 'handle-x.md': '<step name="handle_x">\nbody\n</step>\n' },
    );
    fs.writeFileSync(manifestPath, '', 'utf8');

    const r = runGenSectionManifest([
      '--check', '--json', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
    ]);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'no stack trace for an empty manifest file');
    const report = parseJsonReport(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_MANIFEST_UNPARSEABLE);
  });

  test('rejectsValidJsonThatIsNotTheExpectedShape (row 34)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    const { workflowsDir, manifestPath } = buildFixture(
      tmpRoot,
      'sample',
      markerSource('handle-x', 'always', 'handle-x.md'),
      { 'handle-x.md': '<step name="handle_x">\nbody\n</step>\n' },
    );

    for (const hostileJson of ['0', '"s"', '[]', 'null', 'true']) {
      fs.writeFileSync(manifestPath, hostileJson, 'utf8');
      const r = runGenSectionManifest([
        '--check', '--json', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
      ]);
      assert.equal(r.code, 1, `hostile JSON ${hostileJson} must fail --check`);
      assert.doesNotMatch(r.stderr, STACK_FRAME_RE, `hostile JSON ${hostileJson} must not crash`);
      const report = parseJsonReport(r.stdout);
      assert.equal(report.ok, false, `hostile JSON ${hostileJson}`);
      assert.equal(report.reason, REASON.FAIL_MANIFEST_MALFORMED_SHAPE, `hostile JSON ${hostileJson}`);
    }
  });

  test('checkFailsWhenMarkerReferencesMissingStepFile (row 35)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    // Marker present, but the step file it names is never created.
    const { workflowsDir, manifestPath } = buildFixture(
      tmpRoot,
      'sample',
      markerSource('handle-x', 'always', 'handle-x.md'),
      {},
    );

    const r = runGenSectionManifest([
      '--check', '--json', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
    ]);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'a missing step file must not crash the generator');
    const report = parseJsonReport(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_MISSING_STEP_FILE);
    assert.equal(
      report.subject,
      'gsd-core/workflows/sample/steps/handle-x.md',
      'report must name the missing step file path',
    );
  });

  test('checkFailsOnOrphanStepFile (row 36)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    // handle-x.md is the legitimate marker target; stray.md is referenced by
    // nothing (not the marker, not any prose in the parent or in handle-x.md).
    const { workflowsDir, manifestPath } = buildFixture(
      tmpRoot,
      'sample',
      markerSource('handle-x', 'always', 'handle-x.md'),
      {
        'handle-x.md': '<step name="handle_x">\nbody\n</step>\n',
        'stray.md': '<step name="unreachable">\nnever referenced anywhere\n</step>\n',
      },
    );

    const r = runGenSectionManifest([
      '--check', '--json', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
    ]);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'an orphan step file must not crash the generator');
    const report = parseJsonReport(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_ORPHAN_STEP_FILE);
    assert.equal(
      report.subject,
      'gsd-core/workflows/sample/steps/stray.md',
      'report must name the orphan step file path',
    );
  });

  test('nestedStepReferenceIsNotFlaggedAsOrphan (supplemental: proves the reachability fixed-point, not just the negative case)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    // handle-x.md is the marker target; handle-x.md's OWN prose delegates to
    // handle-x-run.md, which is referenced by NO marker directly — mirrors
    // the real repo's regression-gate.md -> regression-gate-run.md shape.
    const { workflowsDir, manifestPath } = buildFixture(
      tmpRoot,
      'sample',
      markerSource('handle-x', 'always', 'handle-x.md'),
      {
        'handle-x.md': 'Read and execute `gsd-core/workflows/sample/steps/handle-x-run.md`.\n',
        'handle-x-run.md': 'the nested run body\n',
      },
    );

    const fresh = buildFreshManifest(workflowsDir, tmpRoot);
    assert.equal(fresh.sections.length, 1);
    fs.writeFileSync(manifestPath, JSON.stringify(fresh, null, 2) + '\n', 'utf8');

    const r = runGenSectionManifest([
      '--check', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
    ]);
    assert.equal(r.code, 0, `handle-x-run.md must resolve as reachable, not orphan; stderr: ${r.stderr}`);
  });

  test('producesIdenticalManifestForCrlfAndLfSources (row 37)', (t) => {
    const lfRoot = createTempDir('gen-section-manifest-lf-');
    const crlfRoot = createTempDir('gen-section-manifest-crlf-');
    t.after(() => {
      cleanup(lfRoot);
      cleanup(crlfRoot);
    });

    const lfSource = markerSource('handle-x', 'state:has-prior-phases', 'handle-x.md');
    const lfStep = '<step name="handle_x">\nbody\n</step>\n';
    const { workflowsDir: lfDir } = buildFixture(lfRoot, 'sample', lfSource, { 'handle-x.md': lfStep });
    const { workflowsDir: crlfDir } = buildFixture(
      crlfRoot,
      'sample',
      lfSource.replace(/\n/g, '\r\n'),
      { 'handle-x.md': lfStep.replace(/\n/g, '\r\n') },
    );

    const lfManifest = buildFreshManifest(lfDir, lfRoot);
    const crlfManifest = buildFreshManifest(crlfDir, crlfRoot);
    assert.deepEqual(crlfManifest, lfManifest, 'CRLF and LF sources must produce an identical manifest');
  });

  test('ignoresSectionShapedLineInsideFencedBlock (row 38)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    const source = [
      '# Sample workflow',
      '',
      '<!-- gsd:section id="handle-x" when="always" -->',
      'Read and execute `gsd-core/workflows/sample/steps/handle-x.md`.',
      '<!-- /gsd:section -->',
      '',
      'Documentation of the marker grammar (must NOT be treated as real):',
      '```',
      '<!-- gsd:section id="fake" when="always" -->',
      'never a real section',
      '<!-- /gsd:section -->',
      '```',
      '',
    ].join('\n');

    const { workflowsDir, manifestPath } = buildFixture(tmpRoot, 'sample', source, {
      'handle-x.md': '<step name="handle_x">\nbody\n</step>\n',
    });

    const fresh = buildFreshManifest(workflowsDir, tmpRoot);
    assert.equal(fresh.sections.length, 1, 'the fenced marker-shaped lines must not produce a section');
    assert.equal(fresh.sections[0].id, 'handle-x');

    fs.writeFileSync(manifestPath, JSON.stringify(fresh, null, 2) + '\n', 'utf8');
    const r = runGenSectionManifest([
      '--check', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
    ]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  });

  test('leavesLoopHostMarkerUntouched (row 39)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    const source = [
      '<!-- gsd:loop-host name="example" -->',
      '',
      '# Sample workflow',
      '',
      '<!-- gsd:section id="handle-x" when="always" -->',
      'Read and execute `gsd-core/workflows/sample/steps/handle-x.md`.',
      '<!-- /gsd:section -->',
      '',
    ].join('\n');

    const { workflowsDir, manifestPath } = buildFixture(tmpRoot, 'sample', source, {
      'handle-x.md': '<step name="handle_x">\nbody\n</step>\n',
    });

    const fresh = buildFreshManifest(workflowsDir, tmpRoot);
    assert.equal(fresh.sections.length, 1, 'gsd:loop-host must never be treated as a gsd:section marker');
    assert.equal(fresh.sections[0].id, 'handle-x');

    fs.writeFileSync(manifestPath, JSON.stringify(fresh, null, 2) + '\n', 'utf8');
    const r = runGenSectionManifest([
      '--check', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
    ]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  });

  test('writesManifestAtomically (row 40)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    const manifestPath = path.join(tmpRoot, 'section-manifest.json');
    const originalContent = '{"sections":[{"id":"pre-existing","when":"always","read":"x.md"}]}\n';
    fs.writeFileSync(manifestPath, originalContent, 'utf8');

    // Cross-platform IO-failure injection (CLAUDE.md rule): monkeypatch the
    // fs method, restore via t.after() (never chmod 0o000 — root bypasses
    // mode bits, silently zero-coverage in root Docker/CI).
    const origRenameSync = fs.renameSync;
    fs.renameSync = function patchedRenameSync() {
      throw new Error('injected rename failure (never a real fs fault)');
    };
    t.after(() => {
      fs.renameSync = origRenameSync;
    });

    assert.throws(() => writeManifestAtomically(manifestPath, '{"sections":[]}\n'));

    assert.equal(
      fs.readFileSync(manifestPath, 'utf8'),
      originalContent,
      'a rename failure must leave the pre-existing manifest completely untouched, never truncated',
    );
    const leftoverTmp = fs.readdirSync(tmpRoot).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftoverTmp, [], 'the temp file must be cleaned up even when the rename step fails');
  });

  test('surfacesWriteFailureAndCleansTemp (row 41)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    const manifestPath = path.join(tmpRoot, 'section-manifest.json');
    assert.equal(fs.existsSync(manifestPath), false, 'sanity: no pre-existing manifest');

    const origWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function patchedWriteFileSync(target, ...rest) {
      if (target === manifestPath || (typeof target === 'string' && target.includes('.tmp-'))) {
        throw new Error('injected write failure (never a real fs fault)');
      }
      return origWriteFileSync.call(fs, target, ...rest);
    };
    t.after(() => {
      fs.writeFileSync = origWriteFileSync;
    });

    assert.throws(() => writeManifestAtomically(manifestPath, '{"sections":[]}\n'));

    assert.equal(fs.existsSync(manifestPath), false, 'the target manifest must never be created on a write failure');
    const leftover = fs.readdirSync(tmpRoot).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftover, [], 'no temp file must leak when the initial write itself fails');
  });
});

// ─── REASON enum shape lock (mirrors gen-context-index.cjs precedent) ──────

describe('gen-section-manifest.cjs REASON enum', () => {
  test('REASON key set is exactly the documented set', () => {
    assert.deepEqual(Object.keys(REASON).sort(), [
      'FAIL_LIB_NOT_BUILT',
      'FAIL_MANIFEST_MALFORMED_SHAPE',
      'FAIL_MANIFEST_MISSING',
      'FAIL_MANIFEST_UNPARSEABLE',
      'FAIL_MISSING_STEP_FILE',
      'FAIL_ORPHAN_STEP_FILE',
      'FAIL_SOURCE_PARSE_ERROR',
      'FAIL_STALE',
      'FAIL_WRITE_ERROR',
      'OK_UP_TO_DATE',
    ]);
  });

  test('REASON is frozen', () => {
    assert.ok(Object.isFrozen(REASON));
  });
});

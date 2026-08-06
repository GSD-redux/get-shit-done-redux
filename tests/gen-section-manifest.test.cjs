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
  loadWorkflowFragmentsLib,
  checkReport,
  ManifestBuildError,
  REASON,
  WORKFLOW_FRAGMENTS_LIB_PATH,
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
    // Stale: valid {workflows:{...}} shape, but "when" no longer matches the
    // source's marker (must reach FAIL_STALE, not trip the shape check).
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ workflows: { sample: [{ id: 'handle-x', when: 'flag:--wave', read: 'gsd-core/workflows/sample/steps/handle-x.md' }] } }, null, 2) + '\n',
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

  test('rejectsPre6_1FlatSectionsShapeAsMalformed (upgrade-path supplemental: an installed tree still carrying the old flat {sections:[...]} artifact)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    const { workflowsDir, manifestPath } = buildFixture(
      tmpRoot,
      'sample',
      markerSource('handle-x', 'always', 'handle-x.md'),
      { 'handle-x.md': '<step name="handle_x">\nbody\n</step>\n' },
    );

    // Pre-6.1 committed artifact shape: a flat `{sections:[...]}` array with
    // no `workflows` key at all. Must be rejected as malformed, never
    // silently attributed to whichever workflow asks first (design row C4).
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ sections: [{ id: 'handle-x', when: 'always', read: 'gsd-core/workflows/sample/steps/handle-x.md' }] }, null, 2) + '\n',
      'utf8',
    );

    const r = runGenSectionManifest([
      '--check', '--json', '--workflows-dir', workflowsDir, '--manifest-path', manifestPath, '--repo-root', tmpRoot,
    ]);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, STACK_FRAME_RE, 'a pre-6.1 flat manifest must not crash the generator');
    const report = parseJsonReport(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_MANIFEST_MALFORMED_SHAPE, 'pre-6.1 flat {sections:[...]} shape must be rejected, not mistaken for up-to-date or stale');
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
    assert.equal(fresh.workflows.sample.length, 1);
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
    assert.equal(fresh.workflows.sample.length, 1, 'the fenced marker-shaped lines must not produce a section');
    assert.equal(fresh.workflows.sample[0].id, 'handle-x');

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
    assert.equal(fresh.workflows.sample.length, 1, 'gsd:loop-host must never be treated as a gsd:section marker');
    assert.equal(fresh.workflows.sample[0].id, 'handle-x');

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

    assert.throws(() => writeManifestAtomically(manifestPath, '{"sections":[]}\n'), (err) => {
      // Finding 2 (#2932 review): the throw site must attach the typed
      // FAIL_WRITE_ERROR reason, not just a plain ExitError, so a downstream
      // `--write --json` consumer can emit the same {ok,reason,subject}
      // envelope every other failure path in this file produces.
      assert.ok(err instanceof ManifestBuildError, 'must throw a ManifestBuildError, not a plain ExitError');
      assert.equal(err.reason, REASON.FAIL_WRITE_ERROR);
      assert.equal(err.subject, manifestPath);
      return true;
    });

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

    assert.throws(() => writeManifestAtomically(manifestPath, '{"sections":[]}\n'), (err) => {
      assert.ok(err instanceof ManifestBuildError, 'must throw a ManifestBuildError, not a plain ExitError');
      assert.equal(err.reason, REASON.FAIL_WRITE_ERROR);
      assert.equal(err.subject, manifestPath);
      return true;
    });

    assert.equal(fs.existsSync(manifestPath), false, 'the target manifest must never be created on a write failure');
    const leftover = fs.readdirSync(tmpRoot).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftover, [], 'no temp file must leak when the initial write itself fails');
  });

  test('loadWorkflowFragmentsLib throws ManifestBuildError with FAIL_LIB_NOT_BUILT when the compiled lib cannot be read (Finding 2, #2932 review)', (t) => {
    // Cross-platform IO-failure injection (CLAUDE.md rule): monkeypatch the
    // `fs` method Node's own module loader uses to read the file content
    // (never chmod 0o000 — root bypasses mode bits, silently zero-coverage in
    // root Docker/CI, and would also mutate a file shared by concurrent test
    // workers). The real compiled artifact is never touched or renamed.
    const origReadFileSync = fs.readFileSync;
    fs.readFileSync = function patchedReadFileSync(target, ...rest) {
      if (target === WORKFLOW_FRAGMENTS_LIB_PATH) {
        throw new Error('injected read failure (never a real fs fault)');
      }
      return origReadFileSync.call(fs, target, ...rest);
    };
    t.after(() => {
      fs.readFileSync = origReadFileSync;
    });

    assert.throws(() => loadWorkflowFragmentsLib(), (err) => {
      assert.ok(err instanceof ManifestBuildError, 'must throw a ManifestBuildError, not a plain ExitError');
      assert.equal(err.reason, REASON.FAIL_LIB_NOT_BUILT);
      assert.equal(err.subject, 'gsd-core/bin/lib/workflow-fragments.cjs');
      assert.match(err.message, /npm run build:lib/);
      return true;
    });
  });

  test('checkReport surfaces FAIL_LIB_NOT_BUILT as the same typed envelope other --check failures produce (Finding 2, #2932 review)', (t) => {
    const tmpRoot = createTempDir('gen-section-manifest-');
    t.after(() => cleanup(tmpRoot));

    const { workflowsDir, manifestPath } = buildFixture(
      tmpRoot,
      'sample',
      markerSource('handle-x', 'always', 'handle-x.md'),
      { 'handle-x.md': '<step name="handle_x">\nbody\n</step>\n' },
    );

    const origReadFileSync = fs.readFileSync;
    fs.readFileSync = function patchedReadFileSync(target, ...rest) {
      if (target === WORKFLOW_FRAGMENTS_LIB_PATH) {
        throw new Error('injected read failure (never a real fs fault)');
      }
      return origReadFileSync.call(fs, target, ...rest);
    };
    t.after(() => {
      fs.readFileSync = origReadFileSync;
    });

    const report = checkReport(workflowsDir, manifestPath, tmpRoot);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_LIB_NOT_BUILT);
    assert.equal(report.subject, 'gsd-core/bin/lib/workflow-fragments.cjs');
  });
});

// ─── #2993 (epic #1671 Phase 6.2) rows C1/C2: the shipped, committed
// gsd-core/workflows/section-manifest.json artifact itself — never a
// regenerated fixture — gains a `plan-phase` key with all 6 sections in
// document order (C1), while `execute-phase`'s own entry stays
// BYTE-IDENTICAL (C2, a Hyrum gate: #2932/#2992's 3 pre-existing sections
// must not shift shape just because a sibling workflow key was added).

describe('shipped gsd-core/workflows/section-manifest.json (#2993 rows C1/C2)', () => {
  const SHIPPED_MANIFEST_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'section-manifest.json');

  function readShippedManifest() {
    return JSON.parse(fs.readFileSync(SHIPPED_MANIFEST_PATH, 'utf8'));
  }

  test('planPhaseKeyHasAllSixSectionsInDocumentOrder (row C1)', () => {
    const manifest = readShippedManifest();
    assert.deepEqual(manifest.workflows['plan-phase'], [
      {
        id: 'reviews-prerequisite',
        when: 'flag:--reviews',
        read: 'gsd-core/workflows/plan-phase/steps/reviews-prerequisite.md',
      },
      {
        id: 'prd-express-gate',
        when: 'flag:--prd',
        read: 'gsd-core/workflows/plan-phase/steps/prd-express-gate.md',
      },
      {
        id: 'adr-ingest-express-path',
        when: 'flag:--ingest',
        read: 'gsd-core/workflows/plan-phase/steps/adr-ingest-express-path.md',
      },
      {
        id: 'research-only-modifiers',
        when: 'flag:--research-phase',
        read: 'gsd-core/workflows/plan-phase/steps/research-only-modifiers.md',
      },
      {
        id: 'research-only-early-exit',
        when: 'flag:--research-phase',
        read: 'gsd-core/workflows/plan-phase/steps/research-only-early-exit.md',
      },
      {
        id: 'chunked-planning-mode',
        when: 'state:chunked-mode',
        read: 'gsd-core/workflows/plan-phase/steps/chunked-planning-mode.md',
      },
    ]);
  });

  test('executePhaseKeyIsByteIdenticalToBeforeThisChange (row C2 — Hyrum gate)', () => {
    const manifest = readShippedManifest();
    assert.deepEqual(manifest.workflows['execute-phase'], [
      {
        id: 'partial-wave',
        when: 'flag:--wave',
        read: 'gsd-core/workflows/execute-phase/steps/partial-wave.md',
      },
      {
        id: 'gap-closure-artifacts',
        when: 'state:gap-closure-phase',
        read: 'gsd-core/workflows/execute-phase/steps/gap-closure-artifacts.md',
      },
      {
        id: 'regression-gate',
        when: 'state:has-prior-phases',
        read: 'gsd-core/workflows/execute-phase/steps/regression-gate.md',
      },
    ]);
  });

  test('shippedManifestPassesTheRealCheckAgainstTheRealRepo (idempotency, mirrors row 29)', () => {
    const r = runGenSectionManifest([
      '--check', '--workflows-dir', path.join(ROOT, 'gsd-core', 'workflows'), '--manifest-path', SHIPPED_MANIFEST_PATH, '--repo-root', ROOT,
    ]);
    assert.equal(r.code, 0, `the shipped manifest must already be up to date; stderr: ${r.stderr}`);
  });
});

// ─── Flag-forwarding regression guard (BLOCKER fix, epic #1671 Phase 6.2) ──
//
// The workflows never forwarded their flags to the init CLI, so every
// `flag:--X` atom was permanently FALSE in production and its gated section
// permanently EXCLUDED (`prd-express-gate` unreachable under `--prd`;
// `partial-wave` unreachable under `--wave`, pre-existing since #2932 Phase
// 5). This guard is DERIVED from the shipped manifest — never a hardcoded
// {workflow, flag} list — so it also catches the NEXT `flag:--X` atom added
// to any workflow without its own dedicated test.

describe('workflow gsd_run query init.<workflow> invocations forward every flag:--X atom (regression guard)', () => {
  const SHIPPED_MANIFEST_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'section-manifest.json');

  function readShippedManifest() {
    return JSON.parse(fs.readFileSync(SHIPPED_MANIFEST_PATH, 'utf8'));
  }

  /**
   * All shell variable names assigned (anywhere in `scope`, via a
   * double-quoted `VAR="..."` assignment) a value whose whitespace-split
   * tokens include the exact literal `atomFlag` token (e.g. `--prd`).
   * Whole-token comparison (not substring) so `--research-phase` never
   * satisfies a check for `--research`, and vice versa.
   */
  function varsCarryingFlagToken(scope, atomFlag) {
    const carriers = new Set();
    const assignRe = /([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g;
    let m;
    while ((m = assignRe.exec(scope)) !== null) {
      const [, varName, rhs] = m;
      if (rhs.split(/\s+/).includes(atomFlag)) carriers.add(varName);
    }
    return carriers;
  }

  /** `$VAR` / `${VAR}` variable references appearing anywhere in `line`. */
  function varsReferencedIn(line) {
    const referenced = new Set();
    const refRe = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
    let m;
    while ((m = refRe.exec(line)) !== null) referenced.add(m[1]);
    return referenced;
  }

  const manifest = readShippedManifest();
  for (const [workflow, sections] of Object.entries(manifest.workflows)) {
    const flagAtoms = [
      ...new Set(
        sections
          .map((s) => s.when)
          .filter((when) => when.startsWith('flag:--'))
          .map((when) => when.slice('flag:'.length)),
      ),
    ];
    if (flagAtoms.length === 0) continue;

    test(`${workflow}.md forwards [${flagAtoms.join(', ')}] to its gsd_run query init.${workflow} invocation`, () => {
      const workflowMdPath = path.join(ROOT, 'gsd-core', 'workflows', `${workflow}.md`);
      const content = fs.readFileSync(workflowMdPath, 'utf8');

      // A workflow may call `gsd_run query init.<workflow>` more than once
      // (e.g. new-milestone.md's early INIT_EARLY call, whose section_manifest
      // gates ONLY project-md-milestone-write per its own prose, followed by
      // a later full INIT call that gates every other flag-gated section and
      // does forward the flag). Every occurrence is a candidate carrier —
      // a flagAtom only needs forwarding by AT LEAST ONE invocation line,
      // not necessarily the first.
      const initLineRe = new RegExp(`^.*gsd_run query init\\.${workflow}\\b.*$`, 'mg');
      const initLineMatches = [...content.matchAll(initLineRe)];
      assert.ok(initLineMatches.length > 0, `${workflow}.md must contain a "gsd_run query init.${workflow}" invocation line`);

      for (const atomFlag of flagAtoms) {
        const forwardedByAnyInvocation = initLineMatches.some((match) => {
          const initLine = match[0];
          // Everything up to and including this invocation line: real
          // workflows parse $ARGUMENTS into a param variable earlier in the
          // same bash block, then reference that variable on the INIT= line
          // itself.
          const scope = content.slice(0, match.index + initLine.length);
          const referencedVars = varsReferencedIn(initLine);

          const directlyPresent = initLine
            .split(/\s+/)
            .includes(atomFlag);
          const carriers = varsCarryingFlagToken(scope, atomFlag);
          const forwardedViaVar = [...carriers].some((v) => referencedVars.has(v));
          return directlyPresent || forwardedViaVar;
        });

        assert.ok(
          forwardedByAnyInvocation,
          `${workflow}.md's "gsd_run query init.${workflow}" invocation line(s) must forward a parameter for ` +
            `${atomFlag} (its gated section is otherwise permanently excluded — see BLOCKER, epic #1671 Phase 6.2). ` +
            `Invocation line(s): ${initLineMatches.map((m) => m[0]).join(' | ')}`,
        );
      }
    });
  }
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

/**
 * Tests for the `.planning/`-root artifact writer-registry completeness
 * guard (epic #3180, ADR-3180 §8.4 deliverable C, Phase 12 #3310) —
 * `scripts/lint-planning-artifact-writer-drift.cjs`.
 *
 * Unlike its `lint-*-drift.cjs` siblings, this guard is a bare pass/fail
 * completeness check (no ratchet baseline) — see the guard's own module
 * docblock. Tests exercise the guard's PURE functions directly with
 * in-memory strings, mirroring `tests/planning-snapshot-bypass-drift.test.cjs`'s
 * structure — no shelling out to the CLI, except the one real-tree
 * regression test which imports and calls `scanRepo` in-process.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const drift = require('../scripts/lint-planning-artifact-writer-drift.cjs');
const {
  scanFileForCandidates,
  findArtifactWriterDrift,
  scanRepo,
  stripLineComment,
} = drift;

const REPO_ROOT = path.join(__dirname, '..');
const FAKE_FILE = path.join('src', 'fake-writer.cts');

// ─── Case 1: the guard passes clean against the REAL src/ tree ───────────
// This is the main regression-proof test: the design doc's ground-truth
// sweep found zero current violations (every real root-artifact writer is
// already registered), so a red run here means either a genuine new/newly
// discovered registry gap or a detector regression — never "expected".

describe('scanRepo — real src/ tree', () => {
  test('reports zero violations against the actual src/*.cts tree', () => {
    const violations = scanRepo(REPO_ROOT);
    assert.deepStrictEqual(
      violations,
      [],
      `unexpected .planning/-root writer-registry violation(s): ${JSON.stringify(violations, null, 2)}`,
    );
  });

  test('the real tree also has REAL statically-resolvable candidates (the detector is not silently inert)', () => {
    // A guard that never matches anything would also report zero
    // violations — this proves the detector actually found real writers
    // (ROADMAP.md/STATE.md/config.json/MILESTONES.md/REQUIREMENTS.md) and
    // they were individually checked, not just skipped wholesale.
    const driftScanLib = require('../scripts/lib/drift-scan.cjs');
    const candidates = driftScanLib.scanTree({
      root: REPO_ROOT,
      scanDirs: drift.SCAN_DIRS,
      scanExt: drift.SCAN_EXT,
      onFile(rel, text) {
        return scanFileForCandidates(text, rel);
      },
    });
    assert.ok(candidates.length > 0, 'expected at least one statically-resolvable .planning/-root write in src/*.cts');
    const filenames = new Set(candidates.map((c) => c.filename));
    assert.ok(filenames.has('ROADMAP.md'));
    assert.ok(filenames.has('STATE.md'));
    assert.ok(filenames.has('config.json'));
  });
});

// ─── Case 2: an unregistered literal filename is flagged ─────────────────

describe('findArtifactWriterDrift — unregistered filename is a violation', () => {
  test('a write to an unregistered .planning/-root file is flagged, naming the file', () => {
    const source = [
      'function cmdWriteFoo(cwd) {',
      "  const fooPath = path.join(planningRoot(cwd), 'FOO.md');",
      '  platformWriteSync(fooPath, content);',
      '}',
      '',
    ].join('\n');
    // Injected predicate (no build:lib dependency for this unit test):
    // everything is canonical EXCEPT 'FOO.md'.
    const isCanonical = (name) => name !== 'FOO.md';

    const out = findArtifactWriterDrift(source, FAKE_FILE, isCanonical);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].filename, 'FOO.md');
    assert.strictEqual(out[0].file, FAKE_FILE.replace(/\\/g, '/'));
    assert.strictEqual(out[0].line, 3);
    assert.strictEqual(out[0].text, 'platformWriteSync(fooPath, content);');
  });

  test('a registered filename resolved through the identical path is NOT flagged', () => {
    const source = [
      'function cmdWriteFoo(cwd) {',
      "  const fooPath = path.join(planningRoot(cwd), 'FOO.md');",
      '  platformWriteSync(fooPath, content);',
      '}',
      '',
    ].join('\n');
    const isCanonical = () => true; // everything canonical
    const out = findArtifactWriterDrift(source, FAKE_FILE, isCanonical);
    assert.deepStrictEqual(out, []);
  });

  test('an inline path.join (no intermediate variable) is also detected and checked', () => {
    const source = [
      'function cmdWriteBar(cwd) {',
      "  platformWriteSync(path.join(planningRoot(cwd), 'BAR.json'), content);",
      '}',
      '',
    ].join('\n');
    const out = findArtifactWriterDrift(source, FAKE_FILE, (name) => name !== 'BAR.json');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].filename, 'BAR.json');
  });

  test('an object-literal-property binding (RepairPaths-style) resolves the same as a local const', () => {
    const source = [
      'function repairPaths(cwd) {',
      '  const rootBase = planningRoot(cwd);',
      '  return {',
      "    fooPath: path.join(rootBase, 'FOO.md'),",
      '  };',
      '}',
      'function repair(cwd) {',
      '  const { fooPath } = repairPaths(cwd);',
      '  platformWriteSync(fooPath, content);',
      '}',
      '',
    ].join('\n');
    const out = findArtifactWriterDrift(source, FAKE_FILE, (name) => name !== 'FOO.md');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].filename, 'FOO.md');
    assert.strictEqual(out[0].line, 9);
  });

  test('planningPaths(cwd).<prop> (a full-path property, not a directory) resolves to its known file name', () => {
    const source = [
      'function cmdWriteState(cwd) {',
      '  const p = planningPaths(cwd).state;',
      '  platformWriteSync(p, content);',
      '}',
      '',
    ].join('\n');
    const out = findArtifactWriterDrift(source, FAKE_FILE, () => false); // everything fails -> must see STATE.md
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].filename, 'STATE.md');
  });
});

// ─── Case 3: a runtime-computed target is silently skipped ───────────────

describe('scanFileForCandidates — dynamic targets are never candidates (not pass, not fail)', () => {
  test('a template-literal file name (inline) produces NO candidate at all', () => {
    const source = [
      'function cmdWriteDynamic(cwd, name) {',
      '  platformWriteSync(path.join(planningRoot(cwd), `${name}.md`), content);',
      '}',
      '',
    ].join('\n');
    const candidates = scanFileForCandidates(source, FAKE_FILE);
    assert.deepStrictEqual(candidates, [], 'a runtime-computed filename must never be reported as a candidate, checked or otherwise');
  });

  test('a template-literal file name (via an intermediate variable) also produces no candidate', () => {
    const source = [
      'function cmdWriteDynamic(cwd, name) {',
      '  const dynPath = path.join(planningRoot(cwd), `${name}.md`);',
      '  platformWriteSync(dynPath, content);',
      '}',
      '',
    ].join('\n');
    const candidates = scanFileForCandidates(source, FAKE_FILE);
    assert.deepStrictEqual(candidates, []);
  });

  test('findArtifactWriterDrift over the same dynamic-target source reports no violation either (never a false pass or false fail)', () => {
    const source = [
      'function cmdWriteDynamic(cwd, name) {',
      '  platformWriteSync(path.join(planningRoot(cwd), `${name}.md`), content);',
      '}',
      '',
    ].join('\n');
    // Even an isCanonical that rejects EVERYTHING must not surface a
    // violation here, because the write was never a candidate to begin with.
    const out = findArtifactWriterDrift(source, FAKE_FILE, () => false);
    assert.deepStrictEqual(out, []);
  });

  test('a workstream-scoped planningDir(cwd, ws) call is ambiguous and is never treated as an unambiguous root', () => {
    const source = [
      'function cmdWriteScoped(cwd, ws) {',
      "  const p = path.join(planningDir(cwd, ws), 'config.json');",
      '  platformWriteSync(p, content);',
      '}',
      '',
    ].join('\n');
    const candidates = scanFileForCandidates(source, FAKE_FILE);
    assert.deepStrictEqual(candidates, [], 'planningDir(cwd, ws) can resolve under .planning/workstreams/<ws>/ — must be skipped, not treated as root');
  });

  test('a nested write (under milestones/) is never treated as a root-level candidate', () => {
    const source = [
      'function cmdArchive(cwd, version) {',
      "  const archiveDir = path.join(planningRoot(cwd), 'milestones');",
      '  platformWriteSync(path.join(archiveDir, `${version}-ROADMAP.md`), content);',
      '}',
      '',
    ].join('\n');
    const candidates = scanFileForCandidates(source, FAKE_FILE);
    assert.deepStrictEqual(candidates, []);
  });
});

// ─── stripLineComment — comment/string safety ─────────────────────────────

describe('stripLineComment', () => {
  test('strips a trailing // comment but preserves a quoted string containing //', () => {
    const line = "  const x = 'http://example.com'; // not real";
    assert.strictEqual(stripLineComment(line), "  const x = 'http://example.com'; ");
  });

  test('a // inside a string does not truncate the line early', () => {
    const line = "platformWriteSync(path.join(planningRoot(cwd), '//weird.md'), c);";
    // The string content is preserved verbatim even though it contains //.
    assert.ok(stripLineComment(line).includes("'//weird.md'"));
  });
});

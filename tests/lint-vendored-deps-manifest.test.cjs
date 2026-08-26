'use strict';

/**
 * ADR-3473 §8.1 (#3881, phase test-matrix §G — packaging).
 *
 * scripts/lint-vendored-deps.cjs used to be a single hand-rolled check hardcoded to
 * `re2js`; #3881 generalized it to a table-driven VENDORED manifest so adding js-yaml did
 * not need a second hardcoded block. This suite pins:
 *   G1 the js-yaml row's byte-compare actually matches node_modules today.
 *   G2 all four checks the original hand-rolled re2js guard ran (see
 *      scripts/lint-vendored-deps.cjs's `checkRow`: .cjs drift, .d.cts drift, src/vendor/
 *      twin drift, version-pin drift) still fire, asserted against re2js's CURRENT
 *      behavior — not re-derived from the new manifest, which would validate the
 *      refactor against its own output and prove nothing about drift.
 *   G3 the hand-authored js-yaml type twin (no upstream to compare against) is
 *      deliberately excluded from the byte-compare rather than silently skipped by
 *      accident, and is pinned by a direct assertion on its declared surface instead.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  VENDORED,
  compareFiles,
  checkRow,
  stripRangeOperator,
  declaredValueExports,
  checkHandAuthoredTwin,
  resolvePath,
} = require('../scripts/lint-vendored-deps.cjs');

const REPO_ROOT = path.join(__dirname, '..');

function jsYamlRow() {
  const row = VENDORED.find((r) => r.name === 'js-yaml');
  assert.ok(row, 'expected a js-yaml row in VENDORED');
  return row;
}

function re2jsRow() {
  const row = VENDORED.find((r) => r.name === 're2js');
  assert.ok(row, 'expected a re2js row in VENDORED');
  return row;
}

describe('resolvePath: absolute-input safety does not change repo-relative resolution', () => {
  test('a repo-relative input still resolves under REPO_ROOT (unchanged behavior)', () => {
    const row = jsYamlRow();
    assert.equal(resolvePath(row.vendoredCjs), path.join(REPO_ROOT, row.vendoredCjs));
  });

  test('an absolute input is returned as-is, not re-joined onto REPO_ROOT', () => {
    const absPath = path.join(os.tmpdir(), 'resolve-path-absolute-sensor.cjs');
    assert.equal(resolvePath(absPath), absPath);
    // Sensor: confirm this is not vacuous — path.join(ROOT, absPath) (the
    // pre-fix behavior) would NOT equal absPath, since joining an absolute
    // second segment onto ROOT is not the identity operation on either
    // POSIX or Windows.
    assert.notEqual(path.join(REPO_ROOT, absPath), absPath);
  });
});

describe('G1: vendored js-yaml matches node_modules via the generalized manifest', () => {
  test('the js-yaml row byte-compares clean against node_modules today', () => {
    const findings = checkRow(jsYamlRow());
    assert.deepEqual(findings, [], `unexpected drift findings for js-yaml: ${JSON.stringify(findings)}`);
  });

  test('sensor: compareFiles is not vacuous — it reports drift against a deliberately mutated copy', () => {
    const row = jsYamlRow();
    const upstreamAbs = path.join(REPO_ROOT, row.upstreamCjs);
    const tmpFile = path.join(os.tmpdir(), `js-yaml-mutated-${process.pid}-${Date.now()}.cjs`);
    const original = fs.readFileSync(upstreamAbs, 'utf8');
    fs.writeFileSync(tmpFile, `${original}\n// mutated for test\n`);
    try {
      // tmpFile is passed ABSOLUTE, not relativized against REPO_ROOT — a
      // temp dir can live on a different drive than the repo checkout
      // (observed on windows-latest CI), where path.relative() cannot
      // express a relative traversal and silently returns the absolute
      // path unchanged, defeating compareFiles's `path.join(ROOT, rel)`
      // resolution. compareFiles/resolvePath must accept an absolute path
      // as-is regardless of platform or drive.
      const drift = compareFiles(row.vendoredCjs, tmpFile);
      assert.ok(drift, 'expected compareFiles to report drift against a mutated copy, got null');
      assert.ok(drift.includes('!='), `expected a byte-length mismatch description, got: ${drift}`);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe('G2: all four original re2js checks still fire after the manifest refactor', () => {
  test('fresh state: re2js has zero findings today (sanity baseline before mutating)', () => {
    const findings = checkRow(re2jsRow());
    assert.deepEqual(findings, [], `expected re2js to be fresh; findings: ${JSON.stringify(findings)}`);
  });

  test('check 1 (cjs drift) fires against a mutated vendoredCjs copy', () => {
    const row = re2jsRow();
    const vendoredAbs = path.join(REPO_ROOT, row.vendoredCjs);
    const tmpFile = path.join(os.tmpdir(), `re2js-vendored-mutated-${process.pid}-${Date.now()}.cjs`);
    fs.writeFileSync(tmpFile, `${fs.readFileSync(vendoredAbs, 'utf8')}\n// mutated`);
    try {
      // Absolute tmpFile, not relativized — see the js-yaml sensor test above
      // for why: cross-drive path.relative() on Windows returns the absolute
      // path unchanged, which is exactly the shape that must still resolve.
      const mutatedRow = { ...row, vendoredCjs: tmpFile };
      const findings = checkRow(mutatedRow);
      assert.ok(
        findings.some((f) => f.includes('!=')),
        `expected a cjs-drift finding, got: ${JSON.stringify(findings)}`,
      );
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  test('check 2 (d.cts drift) fires against a mutated vendoredDts copy', () => {
    const row = re2jsRow();
    assert.ok(row.vendoredDts, 're2js is expected to carry a vendoredDts for this check to apply');
    const vendoredDtsAbs = path.join(REPO_ROOT, row.vendoredDts);
    const tmpFile = path.join(os.tmpdir(), `re2js-dts-mutated-${process.pid}-${Date.now()}.d.cts`);
    fs.writeFileSync(tmpFile, `${fs.readFileSync(vendoredDtsAbs, 'utf8')}\n// mutated`);
    try {
      // Absolute tmpFile — same cross-drive rationale as above.
      const mutatedRow = { ...row, vendoredDts: tmpFile };
      const findings = checkRow(mutatedRow);
      assert.ok(
        findings.some((f) => f.includes('!=')),
        `expected a d.cts-drift finding, got: ${JSON.stringify(findings)}`,
      );
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  test('check 3 (src/vendor twin drift) fires against a mutated srcTwin copy', () => {
    const row = re2jsRow();
    assert.ok(row.srcTwin, 're2js is expected to carry a srcTwin for this check to apply');
    const srcTwinAbs = path.join(REPO_ROOT, row.srcTwin);
    const tmpFile = path.join(os.tmpdir(), `re2js-srctwin-mutated-${process.pid}-${Date.now()}.d.cts`);
    fs.writeFileSync(tmpFile, `${fs.readFileSync(srcTwinAbs, 'utf8')}\n// mutated`);
    try {
      // Absolute tmpFile — same cross-drive rationale as above.
      const mutatedRow = { ...row, srcTwin: tmpFile };
      const findings = checkRow(mutatedRow);
      assert.ok(
        findings.some((f) => f.includes('!=')),
        `expected a src/vendor-twin-drift finding, got: ${JSON.stringify(findings)}`,
      );
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  test('check 4 (version-pin drift) fires when the row name has no package.json pin', () => {
    const row = re2jsRow();
    const mutatedRow = { ...row, name: 'a-package-that-is-not-pinned-anywhere' };
    const findings = checkRow(mutatedRow);
    assert.ok(
      findings.some((f) => f.includes('devDependencies') && f.includes('is missing')),
      `expected a missing-pin finding, got: ${JSON.stringify(findings)}`,
    );
  });

  test('check 4 (version-pin drift): stripRangeOperator mismatch is what the real check compares', () => {
    // checkRow reads package.json/node_modules directly and cannot be redirected, so this
    // exercises the exact comparison predicate checkRow applies
    // (stripRangeOperator(pinned) !== installed.version) against a synthetic mismatch,
    // proving the predicate itself can fail rather than only ever reading true.
    assert.equal(stripRangeOperator('^5.9.9') === '5.9.0', false, 'a genuine version mismatch must not compare equal');
    assert.equal(stripRangeOperator('^5.9.0') === '5.9.0', true, 'a matching version must compare equal');
  });
});

describe('G3: the hand-authored js-yaml type twin is excluded from byte-compare, and pinned by test', () => {
  test('the js-yaml row is declared hand-authored with no upstream twin to compare', () => {
    const row = jsYamlRow();
    assert.equal(row.twinKind, 'hand-authored');
    assert.equal(row.upstreamDts, null, 'js-yaml ships no upstream .d.ts to compare against');
    assert.equal(row.vendoredDts, null, 'there is no bin-side .d.cts twin for js-yaml');
    assert.equal(row.srcTwin, 'src/vendor/js-yaml.d.cts');
  });

  test('sensor: a byte-compare-neutral mutation (e.g. a trailing comment) produces NO drift finding — the BYTE-COMPARE exclusion is real, not accidental', () => {
    const row = jsYamlRow();
    const srcTwinAbs = path.join(REPO_ROOT, row.srcTwin);
    const original = fs.readFileSync(srcTwinAbs, 'utf8');
    fs.writeFileSync(srcTwinAbs, `${original}\n// mutated for test — must not be flagged\n`);
    try {
      const findings = checkRow(row);
      assert.deepEqual(
        findings,
        [],
        `hand-authored twin must be excluded from byte-compare; unexpected findings: ${JSON.stringify(findings)}`,
      );
    } finally {
      fs.writeFileSync(srcTwinAbs, original);
    }
  });

  test('#3881 review, finding 4: srcTwin is NOT dead for a hand-authored row — a declared export the runtime does not have IS caught', () => {
    // Before the fix, `srcTwin` was read only inside the `twinKind === 'upstream-verbatim'`
    // branch; for a hand-authored row nothing ever consulted it, which is exactly how the
    // js-yaml.d.cts docblock could drift from runtime reality (finding 2) unnoticed.
    const row = jsYamlRow();
    const srcTwinAbs = path.join(REPO_ROOT, row.srcTwin);
    const original = fs.readFileSync(srcTwinAbs, 'utf8');
    fs.writeFileSync(
      srcTwinAbs,
      `${original}\nexport function thisExportDoesNotExistAtRuntime(): void;\n`,
    );
    try {
      const findings = checkRow(row);
      assert.ok(
        findings.some((f) => f.includes('thisExportDoesNotExistAtRuntime')),
        `expected a declared-export-not-at-runtime finding, got: ${JSON.stringify(findings)}`,
      );
    } finally {
      fs.writeFileSync(srcTwinAbs, original);
    }
  });

  test('checkHandAuthoredTwin: fresh state is clean for the real js-yaml twin', () => {
    assert.deepEqual(checkHandAuthoredTwin(jsYamlRow()), []);
  });

  test('declaredValueExports: extracts function/const/class exports, ignores type/interface exports', () => {
    const src = [
      'export interface Foo { x: number; }',
      'export type Bar = string;',
      'export function realFn(): void;',
      'export const REAL_CONST: string;',
      'export class RealClass {}',
    ].join('\n');
    assert.deepEqual(declaredValueExports(src), ['realFn', 'REAL_CONST', 'RealClass']);
  });

  test('contrast: the SAME mutation on an upstream-verbatim row (re2js) IS caught — proving the exclusion is deliberate', () => {
    const row = re2jsRow();
    const srcTwinAbs = path.join(REPO_ROOT, row.srcTwin);
    const original = fs.readFileSync(srcTwinAbs, 'utf8');
    fs.writeFileSync(srcTwinAbs, `${original}\n// mutated for test — must be flagged\n`);
    try {
      const findings = checkRow(row);
      assert.ok(findings.length > 0, 'expected the upstream-verbatim row to catch the same mutation the hand-authored row ignores');
    } finally {
      fs.writeFileSync(srcTwinAbs, original);
    }
  });

  test("js-yaml.d.cts's declared surface is pinned (no upstream to byte-diff, so pin by contract instead)", () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'src/vendor/js-yaml.d.cts'), 'utf8');
    // The declared surface is deliberately narrow (ADR-3473 §8.1: only what the FAILSAFE
    // read/write path needs). Pin each declared export by name.
    assert.match(content, /export function load\(/, 'load export missing');
    assert.match(content, /export function dump\(/, 'dump export missing');
    assert.match(content, /export const FAILSAFE_SCHEMA:/, 'FAILSAFE_SCHEMA export missing');
    assert.match(content, /export class YAMLException/, 'YAMLException export missing');
    // Deliberately NOT declared — anchors/aliases/custom types/loadAll are unreachable
    // from typed code through this twin (the security posture this twin encodes). Check
    // for an actual export statement, not just the word (which legitimately appears in
    // this file's own prose explaining the exclusion).
    assert.doesNotMatch(content, /export function loadAll\(/, 'loadAll must stay undeclared per the narrowed surface');
  });
});

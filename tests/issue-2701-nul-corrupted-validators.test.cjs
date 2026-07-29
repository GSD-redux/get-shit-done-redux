// Regression tests for #2701 — plan/summary/verification/state validators silently
// accept NUL-corrupted files and report valid:true.
//
// A NUL-corrupted text artifact is binary-classified by file(1) and silently
// OMITTED from recursive / binary-skipping search results (rg -l, grep -rI,
// exit 0), so the corruption reads downstream as "file absent" rather than
// "file corrupt." The validators must fail loud, naming the encoding problem and
// its consequence, before any schema/structure check. The fix is at the
// validator entry points (a shared textEncodingError helper in validate.cjs),
// NOT inside the broadly-shared platformReadSync read primitive.
//
// NUL bytes are written via Buffer so they survive onto disk (a string write
// would not). Cleanup via t.after(() => cleanup(tmpDir)).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { writeState } = require('./fixtures/index.cjs');

// A structurally-complete PLAN.md that passes both validators when clean.
function validPlanBody() {
  return [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: [some/file.ts]',
    'autonomous: true',
    'must_haves:',
    '  truths:',
    '    - "something is true"',
    '---',
    '',
    '<tasks>',
    '',
    '<task type="auto">',
    '  <name>Task 1: Do something</name>',
    '  <files>some/file.ts</files>',
    '  <action>Do the thing</action>',
    '  <verify><automated>npx vitest run</automated></verify>',
    '  <done>Thing is done</done>',
    '</task>',
    '',
    '</tasks>',
  ].join('\n');
}

/** Write `body` to a fresh phase plan path, optionally injecting a NUL at `nulAt`. */
function writePlan(tmpDir, name, body, nulAt) {
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  const p = path.join(tmpDir, '.planning', 'phases', '01-test', name);
  let buf = Buffer.from(body, 'utf8');
  if (nulAt !== undefined) {
    buf = Buffer.concat([buf.subarray(0, nulAt), Buffer.from([0x00]), buf.subarray(nulAt)]);
  }
  fs.writeFileSync(p, buf);
  return p;
}

function parseResult(t, argv, tmpDir) {
  const r = runGsdTools(argv, tmpDir);
  assert.ok(r.success, `command failed: ${r.error}`);
  return JSON.parse(r.output);
}

// ─── frontmatter validate --schema plan|summary|verification ────────────────

describe('#2701: frontmatter validate rejects NUL-corrupted artifacts', () => {
  test('PLAN.md with an embedded NUL byte → valid:false, error names encoding + consequence', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = '.planning/phases/01-test/01-01-PLAN.md';
    writePlan(tmpDir, '01-01-PLAN.md', validPlanBody(), 200);

    const out = parseResult(t, ['frontmatter', 'validate', rel, '--schema', 'plan'], tmpDir);
    assert.strictEqual(out.valid, false, `expected valid:false; got ${JSON.stringify(out)}`);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0, 'must report errors');
    const msg = out.errors.join(' ');
    assert.ok(/NUL/i.test(msg), `error must name NUL/encoding: ${msg}`);
    assert.ok(/skip|search|absent|missing/i.test(msg), `error must name the downstream consequence: ${msg}`);
  });

  test('SUMMARY.md with an embedded NUL byte → valid:false', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const dir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(dir, { recursive: true });
    const body = ['---', 'phase: 01-test', 'plan: 01', 'status: in_progress', '---', '', '# Summary', 'did the work'].join('\n');
    const buf = Buffer.concat([Buffer.from(body, 'utf8').subarray(0, 30), Buffer.from([0x00]), Buffer.from(body, 'utf8').subarray(30)]);
    fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), buf);

    const out = parseResult(t, ['frontmatter', 'validate', '.planning/phases/01-test/01-01-SUMMARY.md', '--schema', 'summary'], tmpDir);
    assert.strictEqual(out.valid, false);
    assert.ok(out.errors.some((e) => /NUL/i.test(e)));
  });

  test('VERIFICATION.md with an embedded NUL byte → valid:false', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const dir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(dir, { recursive: true });
    const body = ['---', 'phase: 01-test', 'plan: 01', 'status: passed', '---', '', '# Verification', 'all green'].join('\n');
    const buf = Buffer.concat([Buffer.from(body, 'utf8').subarray(0, 40), Buffer.from([0x00]), Buffer.from(body, 'utf8').subarray(40)]);
    fs.writeFileSync(path.join(dir, '01-01-VERIFICATION.md'), buf);

    const out = parseResult(t, ['frontmatter', 'validate', '.planning/phases/01-test/01-01-VERIFICATION.md', '--schema', 'verification'], tmpDir);
    assert.strictEqual(out.valid, false);
    assert.ok(out.errors.some((e) => /NUL/i.test(e)));
  });
});

// ─── verify plan-structure ──────────────────────────────────────────────────

describe('#2701: verify plan-structure rejects NUL-corrupted PLAN.md', () => {
  test('PLAN.md with an embedded NUL byte → valid:false, error names encoding', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = '.planning/phases/01-test/01-01-PLAN.md';
    writePlan(tmpDir, '01-01-PLAN.md', validPlanBody(), 200);

    const out = parseResult(t, ['verify', 'plan-structure', rel], tmpDir);
    assert.strictEqual(out.valid, false, `expected valid:false; got ${JSON.stringify(out)}`);
    assert.ok(out.errors.some((e) => /NUL/i.test(e)), `error must name NUL: ${JSON.stringify(out.errors)}`);
  });
});

// ─── state validate ─────────────────────────────────────────────────────────

describe('#2701: state validate rejects NUL-corrupted STATE.md', () => {
  test('STATE.md with an embedded NUL byte → valid:false', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // createTempProject() does NOT seed STATE.md; use writeState to create one,
    // then corrupt it in place with a NUL byte (Buffer write so it survives).
    const seed = [
      '# Project',
      '',
      '## Status',
      'executing',
      '## Current Phase',
      '01 of 01',
      '## Total Plans in Phase',
      '1',
    ].join('\n');
    const statePath = writeState(tmpDir, seed);
    const body = Buffer.from(seed, 'utf8');
    const buf = Buffer.concat([body.subarray(0, 50), Buffer.from([0x00]), body.subarray(50)]);
    fs.writeFileSync(statePath, buf);

    const out = parseResult(t, ['state', 'validate'], tmpDir);
    assert.strictEqual(out.valid, false, `expected valid:false; got ${JSON.stringify(out)}`);
    assert.ok(out.warnings.some((w) => /NUL/i.test(w)), `warning must name NUL: ${JSON.stringify(out.warnings)}`);
  });
});

// ─── negative space: clean files still pass; non-ASCII UTF-8 not over-rejected ─

describe('#2701: clean and valid-UTF-8 files are not over-rejected', () => {
  test('clean PLAN.md (no NUL) → frontmatter validate valid:true', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = '.planning/phases/01-test/01-01-PLAN.md';
    writePlan(tmpDir, '01-01-PLAN.md', validPlanBody());

    const out = parseResult(t, ['frontmatter', 'validate', rel, '--schema', 'plan'], tmpDir);
    assert.strictEqual(out.valid, true, `clean plan must pass; got ${JSON.stringify(out)}`);
  });

  test('clean PLAN.md (no NUL) → verify plan-structure valid:true', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = '.planning/phases/01-test/01-01-PLAN.md';
    writePlan(tmpDir, '01-01-PLAN.md', validPlanBody());

    const out = parseResult(t, ['verify', 'plan-structure', rel], tmpDir);
    assert.strictEqual(out.valid, true, `clean plan must pass; got ${JSON.stringify(out)}`);
  });

  test('non-ASCII UTF-8 (é, emoji) without NUL is NOT rejected', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = '.planning/phases/01-test/01-01-PLAN.md';
    // High bytes are valid UTF-8; only a NUL (0x00) is the corruption signal.
    const body = validPlanBody().replace('Do the thing', 'Do the thing — café ☕ naïve');
    writePlan(tmpDir, '01-01-PLAN.md', body);

    const out = parseResult(t, ['frontmatter', 'validate', rel, '--schema', 'plan'], tmpDir);
    assert.strictEqual(out.valid, true, `valid UTF-8 high bytes must not be rejected; got ${JSON.stringify(out)}`);
  });
});

// ─── boundary: NUL at offset 0 and mid-file both rejected ───────────────────

describe('#2701: NUL position does not matter (start and middle both rejected)', () => {
  for (const nulAt of [0, 5, 250]) {
    test(`NUL at offset ${nulAt} → frontmatter validate valid:false`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const rel = '.planning/phases/01-test/01-01-PLAN.md';
      writePlan(tmpDir, '01-01-PLAN.md', validPlanBody(), nulAt);

      const out = parseResult(t, ['frontmatter', 'validate', rel, '--schema', 'plan'], tmpDir);
      assert.strictEqual(out.valid, false, `NUL at offset ${nulAt} must be rejected; got ${JSON.stringify(out)}`);
    });
  }
});

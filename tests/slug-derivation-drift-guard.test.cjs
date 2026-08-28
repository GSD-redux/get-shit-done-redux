'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Unit coverage for the SLUG-DERIVATION drift guard
 * (scripts/lint-slug-derivation-drift.cjs, issue #3987, closing epic #3473's
 * last two residuals).
 *
 * Modelled on tests/enumeration-drift-guard.test.cjs /
 * tests/completion-ratio-single-owner.test.cjs: exercises the guard's pure
 * functions directly (no `readFileSync().includes()` in a test body), plus
 * a `scanRepo` PROVE-IT-CAN-FAIL row on a fresh synthetic tree — this
 * repo's rule that a drift guard must be shown capable of failing, not just
 * shown to pass on an already-clean tree.
 *
 * .gsd/phase/feat-3987-guard-slug-and-swallow/50-test-matrix.md rows T1-T12
 * map onto the describe blocks below.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  findSlugDerivationDrift,
  scanRepo,
  buildLogicalStatements,
} = require(path.join(ROOT, 'scripts', 'lint-slug-derivation-drift.cjs'));
const { generateSlugInternal } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'core-utils.cjs'));
const { createTempDir, cleanup } = require('./helpers.cjs');

// ─── T1: the real deleted #3883 shape (POSITIVE) ──────────────────────────

describe('findSlugDerivationDrift — T1: the real historical inline-copy shape', () => {
  test('single-line chained copy (matches src/gsd2-import.cts slugify\'s own shape) is flagged', () => {
    const line = "function slugify(title) { return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }";
    const v = findSlugDerivationDrift(line, 'src/unrelated.cts');
    assert.equal(v.length, 1);
    assert.equal(v[0].line, 1);
  });

  test('multi-line chained copy (matches the real deleted #3883 shape, and the pre-fix scripts/qa-smell-ratchet.cjs slugify) is flagged as ONE statement', () => {
    const text = [
      'function slugify(value) {',
      '  return value',
      '    .toLowerCase()',
      "    .replace(/[^a-z0-9]+/g, '-')",
      "    .replace(/^-+|-+$/g, '')",
      '    .slice(0, 60);',
      '}',
    ].join('\n');
    const v = findSlugDerivationDrift(text, 'src/unrelated.cts');
    assert.equal(v.length, 1);
    assert.equal(v[0].line, 2, 'reports at the statement\'s OPENING line, not the line either .replace() sits on');
  });

  test('the exact pre-fix tests/planning-inspect.test.cjs helper shape is flagged', () => {
    const line = "function slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }";
    const v = findSlugDerivationDrift(line, 'tests/unrelated.test.cjs');
    assert.equal(v.length, 1);
  });
});

// ─── T2: the canonical owner is NOT flagged ───────────────────────────────

describe('findSlugDerivationDrift — T2: the canonical owner (src/core-utils.cts generateSlugInternal)', () => {
  test('the real generateSlugInternal body is not flagged, EVEN UNEXEMPTED — its two clauses sit in different statements by construction', () => {
    const text = fs.readFileSync(path.join(ROOT, 'src', 'core-utils.cts'), 'utf8');
    const unexempt = findSlugDerivationDrift(text, 'ZZZ-not-the-real-owner-path.cts');
    assert.deepEqual(unexempt, []);
  });

  test('the real owner file at its real repo-relative path is not flagged (allowlist entry present as a defensive backstop)', () => {
    const text = fs.readFileSync(path.join(ROOT, 'src', 'core-utils.cts'), 'utf8');
    const v = findSlugDerivationDrift(text, path.join('src', 'core-utils.cts'));
    assert.deepEqual(v, []);
  });

  test('a synthetic refactor that DID fold generateSlugInternal into one statement would be flagged if NOT for the explicit allowlist entry — proving the entry is load-bearing, not decorative', () => {
    const folded = [
      'function generateSlugInternal(text, maxLen) {',
      "  return transliterateForSlug(text).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
      '}',
    ].join('\n');
    const unexempt = findSlugDerivationDrift(folded, 'ZZZ-not-core-utils.cts');
    assert.equal(unexempt.length, 1, 'the folded shape IS detectable — proves the real file escapes only by construction, not because the detector cannot see this shape');

    const exempt = findSlugDerivationDrift(folded, path.join('src', 'core-utils.cts'));
    assert.deepEqual(exempt, [], 'the allowlist entry suppresses it at the real owner path');
  });
});

// ─── T3-T5: the 3 sanctioned sites are exempted BY the allowlist ──────────

describe('findSlugDerivationDrift — T3-T5: sanctioned sites are exempted BY the allowlist, not by accident', () => {
  const sanctioned = [
    { file: path.join('src', 'gsd2-import.cts'), fn: 'slugify' },
    { file: path.join('src', 'runtime-artifact-conversion.cts'), fn: 'normalizeKimiSkillName' },
    { file: path.join('scripts', 'generate-package-identity.cjs'), fn: 'slugifyPackageName' },
  ];

  for (const { file, fn } of sanctioned) {
    test(`${file} (${fn}) is exempted at its real path`, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const v = findSlugDerivationDrift(text, file);
      assert.deepEqual(v, []);
    });

    test(`${file} (${fn}) IS flagged when the SAME text is attributed to a non-exempt path — proves the allowlist, not the shape, suppresses it`, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const v = findSlugDerivationDrift(text, `ZZZ-not-exempt-${path.basename(file)}`);
      assert.ok(v.length >= 1, `expected ${file}'s re-derivation to be independently detectable outside its allowlist entry`);
    });
  }
});

// ─── T6: the rejected loose [^A-Za-z0-9._-] line-level shape is NOT flagged ─

describe('findSlugDerivationDrift — T6: the rejected loose line-level false-positive shape', () => {
  test('a negated-class collapse to a DIFFERENT character ("_") sharing a statement with a hyphen-trim is NOT flagged — clause (a) requires collapsing specifically to \'-\'', () => {
    const line = "const p = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^-+|-+$/g, '');";
    assert.deepEqual(findSlugDerivationDrift(line, 'src/unrelated.cts'), []);
  });

  test('two UNRELATED statements sharing one physical line (separated by \';\') are NOT merged into one false-positive statement', () => {
    const line = "a.replace(/[^A-Za-z0-9._-]+/g, '-'); b.replace(/^-+|-+$/g, '');";
    assert.deepEqual(findSlugDerivationDrift(line, 'src/unrelated.cts'), []);
  });

  test('clause (a) alone (no trim-replace anywhere) is not flagged', () => {
    const line = "const p = raw.replace(/[^A-Za-z0-9._-]+/g, '-');";
    assert.deepEqual(findSlugDerivationDrift(line, 'src/unrelated.cts'), []);
  });

  test('clause (b) alone (no charclass-replace anywhere) is not flagged', () => {
    const line = "const p = raw.replace(/^-+|-+$/g, '');";
    assert.deepEqual(findSlugDerivationDrift(line, 'src/unrelated.cts'), []);
  });
});

// ─── buildLogicalStatements — the statement-scoping mechanism itself ──────

describe('buildLogicalStatements — statement scoping mechanics', () => {
  test('a chain\'s continuation lines (leading ".") merge into the opening line\'s statement', () => {
    const text = ['const x = a', '  .b()', '  .c();'].join('\n');
    const stmts = buildLogicalStatements(text.split('\n'));
    assert.equal(stmts.length, 1);
    assert.equal(stmts[0].startLine, 1);
    // The trailing ';' is stripped by the fragment splitter (it is the
    // fragment TERMINATOR, not part of the statement text) — matches the
    // ';'-terminated statements test below.
    assert.equal(stmts[0].text, 'const x = a .b() .c()');
  });

  test('a line NOT starting with "." never merges into the previous statement, even with no ";" boundary', () => {
    const text = ['const a = 1', 'const b = 2'].join('\n');
    const stmts = buildLogicalStatements(text.split('\n'));
    assert.equal(stmts.length, 2);
    assert.equal(stmts[0].startLine, 1);
    assert.equal(stmts[1].startLine, 2);
  });

  test('multiple ";"-terminated statements on one physical line become separate statements', () => {
    const stmts = buildLogicalStatements(['const a = 1; const b = 2; const c = 3;']);
    assert.equal(stmts.length, 3);
    assert.deepEqual(stmts.map((s) => s.text), ['const a = 1', 'const b = 2', 'const c = 3']);
  });

  test('blank and comment-only lines are skipped without breaking a chain across them', () => {
    const text = ['const x = a', '  // a comment line in the middle of the chain', '', '  .b();'].join('\n');
    const stmts = buildLogicalStatements(text.split('\n'));
    assert.equal(stmts.length, 1);
    assert.equal(stmts[0].text, 'const x = a .b()');
  });
});

// ─── T7 (PROVE-IT-CAN-FAIL) + T8: scanRepo mechanics ──────────────────────

describe('scanRepo — PROVE-IT-CAN-FAIL: the guard reds on a fresh synthetic violation', () => {
  test('a freshly written violation in a temp tree is reported with its file and line', (t) => {
    const root = createTempDir('gsd-slug-derivation-drift-');
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'fake.cts'),
      "function slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }\n",
    );

    const violations = scanRepo(root);
    assert.equal(violations.length, 1, 'the guard must be able to FAIL on a real violation, not merely pass on a clean tree');
    assert.equal(violations[0].file, path.join('src', 'fake.cts'));
    assert.equal(violations[0].line, 1);
  });

  test('a clean temp tree with no re-derivations reports zero violations', (t) => {
    const root = createTempDir('gsd-slug-derivation-drift-');
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'clean.cts'), 'const x = 1;\n');

    assert.deepEqual(scanRepo(root), []);
  });

  test('gsd-core/bin/lib and bin/install.js are never visited — a scan-dir outside src/scripts/tests/eslint-rules is not scanned', (t) => {
    const root = createTempDir('gsd-slug-derivation-drift-');
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'gsd-core', 'bin', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'gsd-core', 'bin', 'lib', 'core-utils.cjs'),
      "function slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }\n",
    );
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'bin', 'install.js'),
      "function slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }\n",
    );

    assert.deepEqual(scanRepo(root), []);
  });

  test('SELF_TEST_FILE exemption is scoped to its exact path — a DIFFERENT tests/ file with the same fixture text IS still flagged', (t) => {
    const { SELF_TEST_FILE } = require(path.join(ROOT, 'scripts', 'lint-slug-derivation-drift.cjs'));
    const root = createTempDir('gsd-slug-derivation-drift-');
    t.after(() => cleanup(root));
    const fixtureLine = "function slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }\n";

    fs.mkdirSync(path.join(root, path.dirname(SELF_TEST_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, SELF_TEST_FILE), fixtureLine);

    const otherTestsFile = path.join('tests', 'some-other-file.test.cjs');
    fs.writeFileSync(path.join(root, otherTestsFile), fixtureLine);

    const violations = scanRepo(root);
    assert.equal(violations.length, 1, 'exactly one violation: SELF_TEST_FILE is skipped, the other tests/ file is not');
    assert.equal(violations[0].file, otherTestsFile);
  });
});

test('T8: scanRepo(repoRoot) against the real repo returns EMPTY after the Task-2 fixes (was 2 TRUE positives)', () => {
  const violations = scanRepo(ROOT);
  assert.deepEqual(violations, []);
});

// ─── T9-T11: scripts/qa-smell-ratchet.cjs slugify, routed through the seam ─

describe('scripts/qa-smell-ratchet.cjs slugify — routed through generateSlugInternal (#2849/#2848 fixes)', () => {
  // Re-require the fixed module's own slugify indirectly isn't exported, so
  // these rows assert the SEAM behaves as the routed call site now expects
  // (parity is guaranteed by construction: the call site is `generateSlugInternal(value, 60) ?? ''`).

  test('T9: a >60-char input whose 60th char lands mid-word does not leave a trailing hyphen (the live #2849 bug)', () => {
    // 58 'a's + "-bcdef": char 60 lands inside "bcdef", right after the
    // separator hyphen — the exact #2849 trigger shape.
    const input = 'a'.repeat(58) + '-bcdef';
    const slug = generateSlugInternal(input, 60) ?? '';
    assert.ok(!slug.endsWith('-'), `expected no trailing hyphen after truncation, got ${JSON.stringify(slug)}`);
    assert.equal(slug.length <= 60, true);
  });

  test('T10: non-Latin (Cyrillic) input transliterates to a non-empty slug', () => {
    const slug = generateSlugInternal('Привет мир', 60) ?? '';
    assert.notEqual(slug, '');
    assert.match(slug, /^[a-z0-9-]+$/);
  });

  test('T11: null/empty input preserves the never-null contract via "?? \'\'"', () => {
    assert.equal(generateSlugInternal(null, 60) ?? '', '');
    assert.equal(generateSlugInternal('', 60) ?? '', '');
    assert.equal(generateSlugInternal(undefined, 60) ?? '', '');
  });
});

// ─── T12: tests/planning-inspect.test.cjs slugify helper parity ──────────

describe('tests/planning-inspect.test.cjs slugify helper — parity with getPhaseDirFromPhaseId (#3987)', () => {
  test('T12: a name that both transliterates AND would need no truncation matches the real seam with maxLen: null (no truncation, matching getPhaseDirFromPhaseId\'s own contract)', () => {
    const name = 'Привет Мир Feature';
    const helperShape = generateSlugInternal(name, null) ?? '';
    assert.notEqual(helperShape, '');
    assert.match(helperShape, /^[a-z0-9-]+$/);
    // getPhaseDirFromPhaseId never truncates (per src/core-utils.cts's own
    // maxLen doc comment) — this asserts the helper's contract (maxLen:
    // null) is the one that actually matches, not the 60-char default.
    const truncatedShape = generateSlugInternal(name, 60);
    assert.equal(helperShape, truncatedShape, 'this short fixture does not exercise truncation, so both must still agree');
  });
});

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
  stripComments,
  SCAN_EXT,
} = require(path.join(ROOT, 'scripts', 'lint-slug-derivation-drift.cjs'));
const { generateSlugInternal } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'core-utils.cjs'));
const { getPhaseDirFromPhaseId } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'phase-id.cjs'));
const { slugify: qaSmellRatchetSlugify } = require(path.join(ROOT, 'scripts', 'qa-smell-ratchet.cjs'));
const { createTempDir, cleanup } = require('./helpers.cjs');
const { splitLines } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'text-lines.cjs'));
const { MAX_REGEX_LITERAL_LEN, resetRegexScanStats, getRegexScanStats } = require(path.join(ROOT, 'scripts', 'lib', 'drift-scan.cjs'));

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

// ─── MAJOR-1 (security review, #3987): exemption scoping does not bleed past
// the exempted function's own closing brace ────────────────────────────────

describe('findSlugDerivationDrift — MAJOR-1: allowlist exemption is scoped to the REAL function body, not "until the next top-level function"', () => {
  const sanctionedRealEndLines = [
    { file: path.join('src', 'core-utils.cts'), fn: 'generateSlugInternal', realEndLine: 199 },
    { file: path.join('src', 'gsd2-import.cts'), fn: 'slugify', realEndLine: 103 },
    { file: path.join('src', 'runtime-artifact-conversion.cts'), fn: 'normalizeKimiSkillName', realEndLine: 616 },
    { file: path.join('scripts', 'generate-package-identity.cjs'), fn: 'slugifyPackageName', realEndLine: 42 },
  ];

  for (const { file, fn, realEndLine } of sanctionedRealEndLines) {
    test(`a re-derivation planted immediately AFTER ${fn}'s (${file}) real closing brace IS flagged — the pre-fix bug exempted up to 50 lines past the function's own 11-line body`, () => {
      const lines = splitLines(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      const evilSlug = "const evilSlug = (t) => t.replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');";
      lines.splice(realEndLine, 0, evilSlug); // insert right after the function's REAL closing brace
      const text = lines.join('\n');

      const v = findSlugDerivationDrift(text, file);
      assert.equal(v.length, 1, `expected the planted violation right after ${fn}'s real body to be flagged`);
      assert.equal(v[0].line, realEndLine + 1);
    });

    test(`a re-derivation planted INSIDE ${fn}'s (${file}) own real body remains exempt`, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      // The real bodies here are single-collapse-clause shapes (never both
      // clauses in one statement) by construction, so this only re-confirms
      // the existing "exempted at its real path" T3-T5 assertion holds with
      // the new extent-based exemption mechanism, not the old bleed-through one.
      assert.deepEqual(findSlugDerivationDrift(text, file), []);
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

// ─── MAJOR-3 (security review, #3987): widened detector shapes ───────────

describe('findSlugDerivationDrift — MAJOR-3: widened detection (each of these evaded the pre-fix detector)', () => {
  const positives = [
    ['replaceAll alongside replace', "function f(t){return t.toLowerCase().replaceAll(/[^a-z0-9]+/g,'-').replaceAll(/^-+|-+$/g,'');}"],
    ['{1,} as an equivalent of +', "function f(t){return t.toLowerCase().replace(/[^a-z0-9]{1,}/g,'-').replace(/^-+|-+$/g,'');}"],
    ['\\s* prefixed into the collapse class', "function f(t){return t.toLowerCase().replace(/\\s*[^a-z0-9]+\\s*/g,'-').replace(/^-+|-+$/g,'');}"],
    ['escaped ] inside the negated class', "function f(t){return t.toLowerCase().replace(/[^a-z0-9\\]]+/g,'-').replace(/^-+|-+$/g,'');}"],
    ['literal new RegExp(...) form', "function f(t){return t.toLowerCase().replace(new RegExp('[^a-z0-9]+','g'),'-').replace(/^-+|-+$/g,'');}"],
    ['trim spelled /^[-]+|[-]+$/', "function f(t){return t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^[-]+|[-]+$/g,'');}"],
    ['trim spelled /(^-+)|(-+$)/', "function f(t){return t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-+)|(-+$)/g,'');}"],
    ['trim spelled /^-*|-*$/', "function f(t){return t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-*|-*$/g,'');}"],
    ['trim spelled /^\\-+|\\-+$/', "function f(t){return t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^\\-+|\\-+$/g,'');}"],
    ['trim spelled /-+$|^-+/ (swapped order)', "function f(t){return t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+$|^-+/g,'');}"],
    ['.split(<negated class>).join(\'-\') as a collapse form', "function f(t){return t.toLowerCase().split(/[^a-z0-9]+/g).join('-').replace(/^-+|-+$/g,'');}"],
    [
      'arguments to .replace( spanning multiple physical lines (no leading "." continuation)',
      ['function f(t){', '  return t.toLowerCase().replace(', '    /[^a-z0-9]+/g,', "    '-'", "  ).replace(/^-+|-+$/g, '');", '}'].join('\n'),
    ],
  ];

  for (const [name, src] of positives) {
    test(`${name} is flagged`, () => {
      const v = findSlugDerivationDrift(src, 'ZZZ-not-exempt.cts');
      assert.ok(v.length >= 1, `expected "${name}" to be detected after the MAJOR-3 widening`);
    });
  }

  test('the two-statement/temp-var form is a DOCUMENTED, deliberate gap (needs data flow, not textual matching) — still evades', () => {
    const src = ['function f(t){', "  const a = t.toLowerCase().replace(/[^a-z0-9]+/g,'-');", "  return a.replace(/^-+|-+$/g,'');", '}'].join('\n');
    assert.deepEqual(findSlugDerivationDrift(src, 'ZZZ-not-exempt.cts'), []);
  });

  test('new RegExp built from a variable is a DOCUMENTED, deliberate gap — still evades', () => {
    const src = "function f(t,p){return t.toLowerCase().replace(new RegExp(p,'g'),'-').replace(/^-+|-+$/g,'');}";
    assert.deepEqual(findSlugDerivationDrift(src, 'ZZZ-not-exempt.cts'), []);
  });
});

// ─── MAJOR-2 (security review, #3987): bounded regex-literal extraction ──

describe('findSlugDerivationDrift — MAJOR-2: no quadratic blowup on a pathological regex-literal-shaped line', () => {
  test('a 1.28MB line built from many unterminated "[^"-shaped fragments is scanned in bounded, LINEAR work — not the pre-fix quadratic blowup (54.3s at this size)', () => {
    // Deterministic replacement for a wall-clock assertion (CLAUDE.md "Clock
    // Seams: Do not assert on wall-clock time" — the original elapsedMs<5000
    // row flaked on a slow shared CI runner at 7368ms while passing locally
    // at ~200ms). Instead of timing, this pins the actual MAJOR-2 invariant:
    // every attempt to read a regex literal is capped at MAX_REGEX_LITERAL_LEN
    // characters (`readRegexLiteralAt`'s own `limit`), so total scan work
    // across all `k` unterminated `.replace(/[^` fragments is bounded by
    // `calls * MAX_REGEX_LITERAL_LEN` — a small linear multiple of the input,
    // never a multiple of the input's OWN LENGTH (which is what made the
    // pre-fix unbounded scan quadratic: each of the k attempts re-scanned
    // however much of the remaining 1.28MB line was left).
    const k = 40000; // '.replace(/[^'.repeat(k) + 'x'.repeat(20k) ~= 1.28MB, matching the review's measured repro
    const line = '.replace(/[^'.repeat(k) + 'x'.repeat(20 * k);
    assert.equal(Buffer.byteLength(line, 'utf8'), 1_280_000);

    resetRegexScanStats();
    const v = findSlugDerivationDrift(line, 'ZZZ-not-exempt.cts');
    const { calls, charsExamined } = getRegexScanStats();

    assert.deepEqual(v, [], 'a giant unterminated fragment run is not a real re-derivation');
    // Every attempt is capped at MAX_REGEX_LITERAL_LEN by construction — this
    // holds even under the (hypothetical) unbounded pre-fix shape only if the
    // cap itself is honored; a bound expressed against `calls`, not against
    // `line.length`, is what makes this assertion mean something.
    assert.ok(calls > 0, 'expected at least one regex-literal-read attempt on this fragment run');
    assert.ok(
      charsExamined <= calls * MAX_REGEX_LITERAL_LEN,
      `expected charsExamined (${charsExamined}) to never exceed calls (${calls}) * MAX_REGEX_LITERAL_LEN (${MAX_REGEX_LITERAL_LEN})`,
    );
    // The real discriminator: an ABSOLUTE ceiling, independent of whatever
    // MAX_REGEX_LITERAL_LEN happens to be configured to (the prior assertion
    // is tautological w.r.t. that constant and would not catch the constant
    // itself being blown out). Measured on the current bounded implementation
    // this line drives ~120k bounded attempts (`calls`) totalling
    // ~4.8e7 examined characters — comfortably under 1e8. An unbounded scan
    // (each attempt re-reading however much of the 1.28MB line remains, the
    // exact pre-fix shape) is quadratic: ~line.length^2/2 ≈ 8e11 characters —
    // over four orders of magnitude past this ceiling. Confirmed live: a
    // reverted "no cap" simulation of this same fixture did not finish within
    // 120s, versus ~0.3s bounded.
    assert.ok(
      charsExamined < 1e8,
      `expected charsExamined (${charsExamined}) to stay under a fixed absolute ceiling, not scale toward line.length^2 (~8e11) as the pre-fix unbounded scan would`,
    );
  });
});

// ─── MINOR fixes (security review, #3987) ────────────────────────────────

describe('MINOR fixes', () => {
  test('stripComments does not cut at a "//" inside a string literal (e.g. a URL)', () => {
    const line = "const u = 'http://x'; return t.replace(/[^a-z0-9]+/g, '-');";
    const stripped = stripComments(line);
    assert.ok(stripped.includes("'http://x'"), 'the URL string must survive comment-stripping intact');
    assert.ok(stripped.includes(".replace(/[^a-z0-9]+/g, '-')"), 'code after the string must survive too');
  });

  test('a top-level statement split on ";" does not fire on a ";" embedded inside a regex character class', () => {
    const line = "a.replace(/[^a-z0-9;]+/g, '-'); b.replace(/^-+|-+$/g, '');";
    const stmts = buildLogicalStatements([line]);
    assert.equal(stmts.length, 2, 'the embedded ";" inside the class must not split the first statement in two');
    assert.equal(stmts[0].text, "a.replace(/[^a-z0-9;]+/g, '-')");
  });

  test('SCAN_EXT includes .mjs, .tsx, .jsx alongside the original extensions', () => {
    for (const ext of ['.mjs', '.tsx', '.jsx', '.cts', '.ts', '.mts', '.cjs', '.js']) {
      assert.ok(SCAN_EXT.has(ext), `expected SCAN_EXT to include ${ext}`);
    }
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

// ─── PROVE-IT-CAN-FAIL, the CLI (main()) surface ──────────────────────────
//
// The `scanRepo` PROVE-IT-CAN-FAIL row above only exercises the pure
// function; `main()`'s `process.exitCode = 1`, its stderr banner text, and
// both `sanitizeForReport` call sites (on `d.file` AND `d.found`) are a
// SEPARATE, uncovered surface — dropping the `process.exitCode = 1` line
// entirely would leave every row above green. `main()` is not exported and
// hardcodes its scan root to `path.join(__dirname, '..')` (the real repo,
// which is clean — see T8), so the only way to drive the exit-1 branch is to
// run the CLI as a REAL subprocess against a throwaway copy of the script
// (plus its `scripts/lib/drift-scan.cjs` dependency, which has no other
// requires) rooted at a synthetic tree carrying a real violation.
describe('CLI (main()) — the process.exitCode/stderr surface scanRepo alone does not cover', () => {
  test('a violation drives exit code 1, a stderr banner, and a sanitized file:line report line', (t) => {
    const { spawnSync } = require('node:child_process');
    const tmpRoot = createTempDir('gsd-slug-derivation-drift-cli-');
    t.after(() => cleanup(tmpRoot));

    fs.mkdirSync(path.join(tmpRoot, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'scripts', 'lint-slug-derivation-drift.cjs'),
      path.join(tmpRoot, 'scripts', 'lint-slug-derivation-drift.cjs'),
    );
    fs.copyFileSync(
      path.join(ROOT, 'scripts', 'lib', 'drift-scan.cjs'),
      path.join(tmpRoot, 'scripts', 'lib', 'drift-scan.cjs'),
    );
    // `d.file` gets a zero-width space (a valid filename character on every
    // OS — a raw control byte in a filename is REJECTED as ENOENT on
    // Windows, so it cannot be used here without breaking that lane); `d.found`
    // gets an actual control byte (\x07) embedded in the flagged statement's
    // own text, which is disk file CONTENT, not a path, so it is safe on every
    // platform. Both are exactly what sanitizeForReport exists to neutralize.
    const evilFileName = `fa${'​'}ke.cts`;
    fs.writeFileSync(
      path.join(tmpRoot, 'src', evilFileName),
      `function slugify(name${'\x07'}) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }\n`,
    );

    const res = spawnSync(process.execPath, [path.join(tmpRoot, 'scripts', 'lint-slug-derivation-drift.cjs')], {
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(res.status, 1, 'main() must set a non-zero process.exitCode when a violation is found');
    assert.match(res.stderr, /slug-derivation-drift: independent re-derivation\(s\)/, 'expected the stderr banner text');
    assert.match(res.stderr, /generateSlugInternal\(text, maxLen\)/, 'expected the fix-forward guidance line');
    assert.match(res.stderr, /fa\\u200bke\.cts/, 'sanitizeForReport must have escaped the zero-width space in d.file');
    assert.match(res.stderr, /name\\x07/, 'sanitizeForReport must have escaped the control byte in d.found');
    assert.ok(!res.stderr.includes('​'), 'the raw zero-width space must not reach stderr unescaped');
    assert.ok(!res.stderr.includes('\x07'), 'the raw control byte must not reach stderr unescaped');
  });

  test('a clean tree exits 0 with the "ok" stdout line, not the violation banner', (t) => {
    const { spawnSync } = require('node:child_process');
    const tmpRoot = createTempDir('gsd-slug-derivation-drift-cli-clean-');
    t.after(() => cleanup(tmpRoot));

    fs.mkdirSync(path.join(tmpRoot, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'scripts', 'lint-slug-derivation-drift.cjs'),
      path.join(tmpRoot, 'scripts', 'lint-slug-derivation-drift.cjs'),
    );
    fs.copyFileSync(
      path.join(ROOT, 'scripts', 'lib', 'drift-scan.cjs'),
      path.join(tmpRoot, 'scripts', 'lib', 'drift-scan.cjs'),
    );
    fs.writeFileSync(path.join(tmpRoot, 'src', 'clean.cts'), 'const x = 1;\n');

    const res = spawnSync(process.execPath, [path.join(tmpRoot, 'scripts', 'lint-slug-derivation-drift.cjs')], {
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(res.status, 0);
    assert.match(res.stdout, /^ok slug-derivation-drift:/);
    assert.equal(res.stderr, '');
  });
});

// ─── T9-T11: scripts/qa-smell-ratchet.cjs slugify, routed through the seam ─

describe('scripts/qa-smell-ratchet.cjs slugify — routed through generateSlugInternal (#2849/#2848 fixes)', () => {
  // Re-require the fixed module's own slugify indirectly isn't exported, so
  // these rows assert the SEAM behaves as the routed call site now expects
  // (parity is guaranteed by construction: the call site is `generateSlugInternal(value, 60) ?? ''`).

  test('T9: a >60-char input whose 60th char is the separator hyphen itself does not leave a trailing hyphen (the live #2849 bug)', () => {
    // 59 'a's + "-bcd": char 60 (1-based) is EXACTLY the separator hyphen at
    // index 59. The pre-#2849 formula trimmed leading/trailing hyphens BEFORE
    // truncating to 60 — a no-op here, since the hyphen sits in the middle,
    // not at either end — then truncated with substring(0, 60), which lands
    // exactly ON that hyphen and leaves it as the new trailing character:
    // 59 'a's + trailing '-'. The fixed formula truncates FIRST (same 60-char
    // cut), THEN trims trailing hyphens, removing it. This input is
    // discriminating (old -> trailing '-', new -> none); the previous fixture
    // ('a'.repeat(58) + '-bcdef') truncated to "...a-b", which both the old
    // and new formulas produce identically — it never reached #2849's bug at
    // all (verified: both formulas agree on that input).
    const input = 'a'.repeat(59) + '-bcd';
    const slug = generateSlugInternal(input, 60) ?? '';
    assert.ok(!slug.endsWith('-'), `expected no trailing hyphen after truncation, got ${JSON.stringify(slug)}`);
    assert.equal(slug.length <= 60, true);
    assert.equal(slug, 'a'.repeat(59), 'the separator hyphen itself must be trimmed after truncation');
  });

  test('T9b (call-site): scripts/qa-smell-ratchet.cjs\'s slugify(), routed through generateSlugInternal, does not leave a trailing hyphen either', () => {
    // Asserts through the CALL SITE, not generateSlugInternal directly — if
    // qa-smell-ratchet.cjs's slugify() were reverted to its pre-#3987
    // hand-rolled (trim-before-truncate) copy, this reds even though T9
    // above (which only calls generateSlugInternal) would not notice.
    const input = 'a'.repeat(59) + '-bcd';
    const slug = qaSmellRatchetSlugify(input);
    assert.ok(!slug.endsWith('-'), `expected no trailing hyphen from the routed call site, got ${JSON.stringify(slug)}`);
    assert.equal(slug, 'a'.repeat(59));
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

  test('T11b: an entirely non-alphanumeric input collapses to the EMPTY STRING, not null', () => {
    // Distinguishes "the input produced nothing after slugification" (a
    // non-null, empty string — the collapse/trim clauses ran and consumed
    // every character) from "no input was supplied at all" (T11's null/undefined
    // -> null case). Previously untested.
    assert.equal(generateSlugInternal('!!!', 60), '');
    assert.notEqual(generateSlugInternal('!!!', 60), null);
  });

  test('T9c: maxLen boundary at 59/60/61 (limit-1, limit, limit+1) truncates to exactly maxLen characters', () => {
    const input = 'a'.repeat(65);
    assert.equal(generateSlugInternal(input, 59), 'a'.repeat(59));
    assert.equal(generateSlugInternal(input, 60), 'a'.repeat(60));
    assert.equal(generateSlugInternal(input, 61), 'a'.repeat(61));
  });
});

// ─── T12: tests/planning-inspect.test.cjs slugify helper parity ──────────

describe('tests/planning-inspect.test.cjs slugify helper — parity with getPhaseDirFromPhaseId (#3987)', () => {
  // A name long enough that its slug EXCEEDS 60 chars, so maxLen: null and
  // maxLen: 60 genuinely disagree — the previous 18-char fixture never
  // exercised truncation at all, so the two arguments trivially matched
  // regardless of which one getPhaseDirFromPhaseId actually passes.
  const LONG_NAME = 'This Is A Genuinely Long Phase Name That Exceeds Sixty Characters For Sure';

  test('T12: maxLen: null and maxLen: 60 genuinely DISAGREE on a >60-char slug (fixture is discriminating)', () => {
    const untruncated = generateSlugInternal(LONG_NAME, null) ?? '';
    const truncated = generateSlugInternal(LONG_NAME, 60) ?? '';
    assert.ok(untruncated.length > 60, `fixture must produce a >60-char slug to be discriminating, got length ${untruncated.length}`);
    assert.equal(truncated.length, 60);
    assert.notEqual(untruncated, truncated, 'maxLen: null and maxLen: 60 must produce DIFFERENT slugs for this fixture');
  });

  test('T12b (call site): getPhaseDirFromPhaseId embeds the UNTRUNCATED (maxLen: null) slug, never the 60-char-truncated one', () => {
    // Asserts through the CALL SITE (src/phase-id.cts's getPhaseDirFromPhaseId),
    // not generateSlugInternal directly — if that call site were reverted to
    // pass the 60-char default instead of maxLen: null, this reds even
    // though a generateSlugInternal-only assertion would not notice.
    const dir = getPhaseDirFromPhaseId('01-01', LONG_NAME, null);
    const untruncated = generateSlugInternal(LONG_NAME, null) ?? '';
    const truncated = generateSlugInternal(LONG_NAME, 60) ?? '';
    assert.ok(dir.endsWith(untruncated), `expected the phase dir to embed the untruncated slug, got ${JSON.stringify(dir)}`);
    assert.ok(!dir.endsWith(truncated) || truncated === untruncated, 'the phase dir must not embed the 60-char-truncated slug');
  });
});

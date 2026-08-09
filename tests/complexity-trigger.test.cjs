'use strict';

/**
 * Complexity-triggered refactor extension point — analyzer, evaluator, and
 * baseline-persistence behavioral + property tests.
 *
 * Module: gsd-core/bin/lib/complexity-trigger.cjs (compiled from
 *         src/complexity-trigger.cts — deliberately absent; this file is
 *         written failing-first per issue #1953's TDD directive).
 *
 * Spec sources (authoritative, do not drift from these without a design
 * change):
 *   - .gsd/phase/feat-1953-complexity-triggered-refactor/41-api-contract.md
 *   - .gsd/phase/feat-1953-complexity-triggered-refactor/50-test-matrix.md
 *   - .gsd/phase/feat-1953-complexity-triggered-refactor/40-design.md
 *
 * Coverage map — test matrix rows 1-54 (analyzer counting, the literal-strip
 * leak surface, CRLF/empty/size bounds, properties, file selection,
 * threshold/jump evaluation, baseline persistence) plus the typed-surface
 * enum/constant lock tests. Rows 55+ (git adapter, CLI, ship gate, loop
 * wiring) live in tests/refactor-trigger-cli.test.cjs — out of scope here.
 *
 * Hermetic: every temp dir via createTempDir + t.after(cleanup); every fs
 * mock via mock.method(fs, ...) restored via t.after(...mock.restore()).
 * No shared module-level fixture state (matrix row 91). Ambient GSD_* env
 * is not touched by this file — every fixture here is either pure in-memory
 * input or an isolated tmpdir (matrix row 92 is structural, not exercised
 * by this leaf-module suite).
 */

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  BASELINE_FILE_NAME,
  PROPOSAL_SUFFIX,
  SCHEMA_VERSION,
  DEFAULTS,
  ANALYZABLE_EXTENSIONS,
  VERDICT,
  REASON,
  stripLiterals,
  analyzeSource,
  isAnalyzablePath,
  evaluateCandidates,
  nextBaseline,
  reanchorBaseline,
  readBaseline,
  writeBaseline,
} = require('../gsd-core/bin/lib/complexity-trigger.cjs');

// ---------------------------------------------------------------------------
// Analyzer — counting (matrix rows 1-10)
// ---------------------------------------------------------------------------

describe('complexity-trigger: analyzer — counting decision points', () => {
  test('scoresFlatFunctionAsOne', () => {
    const source = ['function f() {', '  return 1;', '}'].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.ok, true);
    assert.equal(r.functions.length, 1);
    assert.equal(r.functions[0].name, 'f');
    assert.equal(r.functions[0].startLine, 1);
    assert.equal(r.functions[0].score, 1);
  });

  test('scoresSingleIfAsTwo', () => {
    const source = [
      'function f(x) {',
      '  if (x) {',
      '    return 1;',
      '  }',
      '}',
    ].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.ok, true);
    assert.equal(r.functions[0].score, 2);
  });

  test('countsEachDecisionConstructOnce', () => {
    // Each of the twelve listed constructs exactly once: if, else if, for,
    // for..of, for..in, do, while (via one do-while so "while" is not
    // double-counted by a separate stand-alone while statement), case,
    // catch, &&, ||, ?:. Base 1 + 12 = 13.
    const source = [
      'function f(x) {',
      '  if (x === 1) { return 1; }',
      '  else if (x === 2) { return 2; }',
      '  for (let i = 0; i < 1; i++) { g(i); }',
      '  for (const y of x) { g(y); }',
      '  for (const k in x) { g(k); }',
      '  let n = 0;',
      '  do { n += 1; } while (n < 1);',
      '  switch (x) {',
      '    case 1: g(1); break;',
      '    default: g(0);',
      '  }',
      '  try { g(x); } catch (e) { g(e); }',
      '  const a = x && 1;',
      '  const b = x || 1;',
      '  const c = x ? 1 : 2;',
      '  return a + b + c;',
      '}',
    ].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.ok, true);
    assert.equal(r.functions.length, 1);
    assert.equal(r.functions[0].score, 13);
  });

  test('doesNotCountBareElse', () => {
    const source = [
      'function f(x) {',
      '  if (x) { return 1; }',
      '  else { return 2; }',
      '}',
    ].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.functions[0].score, 2, 'bare else must not add a point beyond the if');
  });

  test('doesNotCountSwitchDefault', () => {
    const source = [
      'function f(x) {',
      '  switch (x) {',
      '    case 1: return 1;',
      '    default: return 0;',
      '  }',
      '}',
    ].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.functions[0].score, 2, 'base 1 + one case; default: must not add a point');
  });

  test('doesNotConflateLengthWithComplexity', () => {
    const bodyLines = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`);
    const source = ['function f() {', ...bodyLines, '  return 0;', '}'].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.ok, true);
    assert.equal(r.functions[0].score, 1, 'a long but flat function must still score 1');
  });

  test('scoresFlatSwitchByCaseCountPinningKnownBias', () => {
    const caseLines = Array.from({ length: 12 }, (_, i) => `    case ${i + 1}: return ${i + 1};`);
    const source = [
      'function f(x) {',
      '  switch (x) {',
      ...caseLines,
      '  }',
      '  return 0;',
      '}',
    ].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.functions[0].score, 13, 'flat 12-case switch scores 1 + 12 by design — the known bias is pinned, not accidental');
  });

  test('attributesScoresToEachFunction', () => {
    const source = [
      'function a() {',
      '  return 1;',
      '}',
      '',
      'function b(x) {',
      '  if (x) {',
      '    return 1;',
      '  }',
      '  return 0;',
      '}',
    ].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.functions.length, 2);
    assert.equal(r.functions[0].name, 'a');
    assert.equal(r.functions[0].startLine, 1);
    assert.equal(r.functions[0].score, 1);
    assert.equal(r.functions[1].name, 'b');
    assert.equal(r.functions[1].startLine, 5);
    assert.equal(r.functions[1].score, 2);
  });

  test('doesNotDoubleCountNestedFunction', () => {
    const source = [
      'function outer() {',
      '  function inner(x) {',
      '    if (x) {',
      '      return 1;',
      '    }',
      '    return 0;',
      '  }',
      '  return inner;',
      '}',
    ].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.functions.length, 2);
    const outer = r.functions.find((fn) => fn.name === 'outer');
    const inner = r.functions.find((fn) => fn.name === 'inner');
    assert.equal(outer.score, 1, 'the nested if must not double-count into outer');
    assert.equal(inner.score, 2, 'the nested if is attributed to the innermost function');
  });

  test('detectsAllFunctionForms', () => {
    const source = [
      'const arrow = (x) => x + 1;',
      'const obj = {',
      '  method(x) {',
      '    return x;',
      '  },',
      '};',
      'async function asyncFn() {',
      '  return 1;',
      '}',
      'function* genFn() {',
      '  yield 1;',
      '}',
    ].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.ok, true);
    assert.equal(r.functions.length, 4, 'arrow, method shorthand, async function, and generator must all be detected');
    assert.ok(r.functions.every((fn) => fn.score === 1), 'none of these forms has a branch of its own');
  });
});

// ---------------------------------------------------------------------------
// Analyzer — the leak surface (matrix rows 11-21)
// ---------------------------------------------------------------------------

describe('complexity-trigger: analyzer — the leak surface', () => {
  test('ignoresDecisionKeywordInLineComment', () => {
    const source = [
      'function f() {',
      '  // if (x) { return 1; }',
      '  return 0;',
      '}',
    ].join('\n');
    assert.equal(analyzeSource(source).functions[0].score, 1);
  });

  test('ignoresDecisionKeywordInBlockComment', () => {
    const source = [
      'function f() {',
      '  /* if (x) { return 1 } && y */',
      '  return 0;',
      '}',
    ].join('\n');
    assert.equal(analyzeSource(source).functions[0].score, 1);
  });

  test('ignoresDecisionKeywordInString', () => {
    const source = [
      'function f() {',
      '  const s = "if (x) { return 1; }";',
      '  return s;',
      '}',
    ].join('\n');
    assert.equal(analyzeSource(source).functions[0].score, 1);
  });

  test('ignoresDecisionKeywordInTemplateLiteral', () => {
    const source = [
      'function f() {',
      '  const s = `if (x) { return 1; }`;',
      '  return s;',
      '}',
    ].join('\n');
    assert.equal(analyzeSource(source).functions[0].score, 1);
  });

  test('ignoresAlternationInsideRegexLiteral', () => {
    const source = [
      'function f(s) {',
      '  return /a|b/.test(s);',
      '}',
    ].join('\n');
    assert.equal(analyzeSource(source).functions[0].score, 1, 'the | inside /a|b/ must not count as ||');
  });

  test('doesNotMistakeDivisionForRegexLiteral', () => {
    const source = [
      'function f(a, b, c) {',
      '  return a / b / c;',
      '}',
    ].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.ok, true);
    assert.equal(r.functions[0].score, 1, 'a / b / c must be read as division, never as a regex literal');
  });

  test('doesNotCountOptionalChainingAsTernary', () => {
    const source = [
      'function f(a) {',
      '  return a?.b;',
      '}',
    ].join('\n');
    assert.equal(analyzeSource(source).functions[0].score, 1);
  });

  test('doesNotCountNullishCoalescingAsBranch', () => {
    const source = [
      'function f(x, y) {',
      '  return x ?? y;',
      '}',
    ].join('\n');
    assert.equal(analyzeSource(source).functions[0].score, 1);
  });

  test('handlesEscapedQuoteWithoutSwallowingCode', () => {
    const source = [
      'function f(x) {',
      "  const s = 'it\\'s fine';",
      '  if (x) { return s; }',
      '  return null;',
      '}',
    ].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.ok, true);
    assert.equal(r.functions[0].score, 2, 'the escaped quote must not swallow the following if');
  });

  test('countsBranchInsideTemplateInterpolation', () => {
    const source = [
      'function f(x) {',
      '  const s = `value: ${x ? 1 : 2}`;',
      '  return s;',
      '}',
    ].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.ok, true);
    assert.equal(r.functions[0].score, 2, 'the ternary inside ${} is real code and must be counted');
  });

  test('refusesToScoreUnterminatedLiteral', () => {
    const unterminatedString = [
      'function f() {',
      '  const s = "never closed;',
      '}',
    ].join('\n');
    const unterminatedTemplate = [
      'function f() {',
      '  const s = `never closed;',
      '}',
    ].join('\n');
    const unterminatedComment = [
      'function f() {',
      '  /* never closed',
      '  return 1;',
      '}',
    ].join('\n');

    for (const src of [unterminatedString, unterminatedTemplate, unterminatedComment]) {
      const r = analyzeSource(src);
      assert.equal(r.ok, false);
      assert.equal(r.reason, REASON.REFACTOR_ANALYZER_UNPARSEABLE);
      assert.equal(r.functions, undefined, 'an unparseable source must never emit a number');
    }
  });

  test('producesIdenticalScoresForCrlfAndLf', () => {
    const lfSource = [
      'function f(x) {',
      '  if (x) {',
      '    return 1;',
      '  } else if (x === 2) {',
      '    return 2;',
      '  }',
      '  return 0;',
      '}',
      '',
      'function g(y) {',
      '  return y && y || y ? 1 : 0;',
      '}',
    ].join('\n');
    const crlfSource = lfSource.replace(/\n/g, '\r\n');

    const lfResult = analyzeSource(lfSource);
    const crlfResult = analyzeSource(crlfSource);
    assert.equal(lfResult.ok, true);
    assert.equal(crlfResult.ok, true);
    assert.deepEqual(
      crlfResult.functions,
      lfResult.functions,
      'CRLF and LF forms of the same source must yield byte-identical scores AND line numbers',
    );
  });

  test('returnsEmptyResultForEmptyFile', () => {
    const r = analyzeSource('');
    assert.equal(r.ok, true);
    assert.deepEqual(r.functions, []);
  });

  test('returnsEmptyResultForWhitespaceOnlyFile', () => {
    const r = analyzeSource('   \n\t\n   \n');
    assert.equal(r.ok, true);
    assert.deepEqual(r.functions, []);
  });

  test('returnsEmptyResultWhenNoFunctionsPresent', () => {
    const source = [
      'const x = 1;',
      'if (x) {',
      '  console.log(x);',
      '}',
    ].join('\n');
    const r = analyzeSource(source);
    assert.equal(r.ok, true);
    assert.deepEqual(r.functions, [], 'top-level code belongs to no function, and must never be a synthetic entry');
  });

  test('analyzesLargeFileWithinBounds', () => {
    const N = 8000;
    const chunks = Array.from({ length: N }, (_, i) => [
      `function f${i}(x) {`,
      '  if (x) { return 1; }',
      '  return 0;',
      '}',
    ].join('\n'));
    const source = chunks.join('\n\n');
    assert.ok(source.length > 500000, 'fixture must actually be large enough to exercise the bound');

    const r = analyzeSource(source);
    assert.equal(r.ok, true);
    assert.equal(r.functions.length, N);
    assert.ok(r.functions.every((fn) => fn.score === 2));
  });
});

// ---------------------------------------------------------------------------
// Analyzer — properties (matrix rows 27-28)
// ---------------------------------------------------------------------------

describe('complexity-trigger: analyzer — properties', () => {
  test('propertyStripNeverManufacturesDecisionPoints', () => {
    const SYMBOL_TOKENS = ['&&', '||'];
    const WORD_TOKENS = ['if', 'for', 'while', 'do', 'case', 'catch'];
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (source) => {
        const stripped = stripLiterals(source);
        if (!stripped.ok) return; // unparseable input is outside this invariant's scope
        assert.ok(
          stripped.stripped.length <= source.length,
          `stripLiterals must never grow the source (in=${source.length}, out=${stripped.stripped.length})`,
        );
        for (const token of SYMBOL_TOKENS) {
          if (stripped.stripped.includes(token)) {
            assert.ok(source.includes(token), `stripLiterals must never manufacture "${token}"`);
          }
        }
        for (const token of WORD_TOKENS) {
          const re = new RegExp(`\\b${token}\\b`);
          if (re.test(stripped.stripped)) {
            assert.ok(re.test(source), `stripLiterals must never manufacture the word "${token}"`);
          }
        }
        const analyzed = analyzeSource(source);
        if (analyzed.ok) {
          for (const fn of analyzed.functions) {
            assert.ok(fn.score >= 1, 'every detected function must score at least 1');
          }
        }
      }),
      { numRuns: 50, seed: 42 },
    );
  });

  test('propertyCommentsAndStringsAreScoreNeutral', () => {
    const BASE_SOURCES = [
      ['function f(x) {', '  if (x) { return 1; }', '  return 0;', '}'].join('\n'),
      ['function g(x, y) {', '  return x && y;', '}'].join('\n'),
      ['function h(x) {', '  for (let i = 0; i < x; i++) { g(i); }', '}'].join('\n'),
    ];
    const APPENDERS = [
      (src) => [src, '// if (x) { return 1; } && y || z ? 1 : 2', ''].join('\n'),
      (src) => [src, '/* if (x) { return 1 } && y */', ''].join('\n'),
      (src) => [src, 'const __s = "if (x) { return 1; } && y || z ? 1 : 2";', ''].join('\n'),
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...BASE_SOURCES),
        fc.constantFrom(...APPENDERS),
        (base, appendFn) => {
          const before = analyzeSource(base);
          const after = analyzeSource(appendFn(base));
          assert.equal(before.ok, true);
          assert.equal(after.ok, true);
          assert.deepEqual(
            before.functions.map((fn) => fn.score),
            after.functions.map((fn) => fn.score),
            'appending a comment/string containing decision keywords must never change a score',
          );
        },
      ),
      { numRuns: 20, seed: 42 },
    );
  });
});

// ---------------------------------------------------------------------------
// File selection (matrix rows 29-32)
// ---------------------------------------------------------------------------

describe('complexity-trigger: file selection', () => {
  test('analyzesSupportedExtensions', () => {
    for (const ext of ANALYZABLE_EXTENSIONS) {
      assert.equal(isAnalyzablePath(`src/foo${ext}`), true, `expected ${ext} to be analyzable`);
    }
  });

  test('skipsUnsupportedExtensionsWithoutScoringZero', () => {
    for (const p of ['docs/readme.md', 'package.json', 'ci.yml', 'notes.txt', 'Makefile']) {
      assert.equal(isAnalyzablePath(p), false, `expected ${p} to be unsupported`);
    }
  });

  test('excludesTestFilesByDefault', () => {
    assert.equal(isAnalyzablePath('tests/foo.test.cjs'), false);
    assert.equal(isAnalyzablePath('tests\\foo.test.cjs'), false, 'separators are normalized unconditionally');
  });

  test('excludesGeneratedLibPathsExplicitly', () => {
    assert.equal(isAnalyzablePath('gsd-core/bin/lib/foo.cjs'), false);
    assert.equal(isAnalyzablePath('gsd-core\\bin\\lib\\foo.cjs'), false);
  });
});

// ---------------------------------------------------------------------------
// Threshold / jump evaluation (matrix rows 33-44)
// ---------------------------------------------------------------------------

describe('complexity-trigger: threshold / jump evaluation', () => {
  test('doesNotTriggerBelowThreshold', () => {
    const T = DEFAULTS.threshold;
    const analyzed = [{ file: 'a.js', ok: true, method: 'decision-points', functions: [{ name: 'f', startLine: 1, endLine: 3, score: T - 1 }] }];
    const r = evaluateCandidates({ analyzed, baseline: {} });
    assert.equal(r.verdict, VERDICT.BELOW_THRESHOLD);
    assert.deepEqual(r.candidates, []);
    assert.equal(r.target, null);
  });

  test('doesNotTriggerAtExactThreshold', () => {
    const T = DEFAULTS.threshold;
    const analyzed = [{ file: 'a.js', ok: true, method: 'decision-points', functions: [{ name: 'f', startLine: 1, endLine: 3, score: T }] }];
    const r = evaluateCandidates({ analyzed, baseline: {} });
    assert.equal(r.verdict, VERDICT.BELOW_THRESHOLD, 'strictly-greater semantics: score === T must not trigger');
    assert.deepEqual(r.candidates, []);
  });

  test('triggersAboveThreshold', () => {
    const T = DEFAULTS.threshold;
    const analyzed = [{ file: 'a.js', ok: true, method: 'decision-points', functions: [{ name: 'f', startLine: 1, endLine: 3, score: T + 1 }] }];
    const r = evaluateCandidates({ analyzed, baseline: {} });
    assert.equal(r.verdict, VERDICT.TRIGGERED);
    assert.equal(r.candidates.length, 1);
    assert.deepEqual(r.candidates[0].reasons, ['threshold']);
    assert.equal(r.candidates[0].baseline, null);
    assert.equal(r.candidates[0].delta, null);
  });

  test('doesNotTriggerBelowJumpDelta', () => {
    const T = DEFAULTS.threshold;
    const D = DEFAULTS.jumpDelta;
    const score = T - 5;
    const baseline = { 'a.js::f': { score: score - (D - 1) } };
    const analyzed = [{ file: 'a.js', ok: true, method: 'decision-points', functions: [{ name: 'f', startLine: 1, endLine: 3, score }] }];
    const r = evaluateCandidates({ analyzed, baseline });
    assert.equal(r.verdict, VERDICT.BELOW_THRESHOLD);
    assert.deepEqual(r.candidates, []);
  });

  test('doesNotTriggerAtExactJumpDelta', () => {
    const T = DEFAULTS.threshold;
    const D = DEFAULTS.jumpDelta;
    const score = T - 5;
    const baseline = { 'a.js::f': { score: score - D } };
    const analyzed = [{ file: 'a.js', ok: true, method: 'decision-points', functions: [{ name: 'f', startLine: 1, endLine: 3, score }] }];
    const r = evaluateCandidates({ analyzed, baseline });
    assert.equal(r.verdict, VERDICT.BELOW_THRESHOLD, 'strictly-greater semantics: delta === D must not trigger');
  });

  test('triggersAboveJumpDelta', () => {
    const T = DEFAULTS.threshold;
    const D = DEFAULTS.jumpDelta;
    const score = T - 5;
    const baseline = { 'a.js::f': { score: score - (D + 1) } };
    const analyzed = [{ file: 'a.js', ok: true, method: 'decision-points', functions: [{ name: 'f', startLine: 1, endLine: 3, score }] }];
    const r = evaluateCandidates({ analyzed, baseline });
    assert.equal(r.verdict, VERDICT.TRIGGERED);
    assert.deepEqual(r.candidates[0].reasons, ['jump']);
  });

  test('emitsSingleCandidateCarryingBothReasons', () => {
    const T = DEFAULTS.threshold;
    const D = DEFAULTS.jumpDelta;
    const score = T + 1;
    const baseline = { 'a.js::f': { score: score - (D + 1) } };
    const analyzed = [{ file: 'a.js', ok: true, method: 'decision-points', functions: [{ name: 'f', startLine: 1, endLine: 3, score }] }];
    const r = evaluateCandidates({ analyzed, baseline });
    assert.equal(r.candidates.length, 1, 'one candidate, never two entries');
    assert.deepEqual(r.candidates[0].reasons, ['threshold', 'jump'], 'both reasons, ordered');
  });

  test('doesNotTriggerWhenComplexityDecreased', () => {
    const analyzed = [{ file: 'a.js', ok: true, method: 'decision-points', functions: [{ name: 'f', startLine: 1, endLine: 3, score: 10 }] }];
    const baseline = { 'a.js::f': { score: 20 } };
    const r = evaluateCandidates({ analyzed, baseline });
    assert.equal(r.verdict, VERDICT.BELOW_THRESHOLD);
    assert.deepEqual(r.candidates, []);
  });

  test('doesNotTreatMissingBaselineAsZeroBaseline', () => {
    const T = DEFAULTS.threshold;
    const analyzed = [{ file: 'a.js', ok: true, method: 'decision-points', functions: [{ name: 'f', startLine: 1, endLine: 3, score: T + 1 }] }];
    const r = evaluateCandidates({ analyzed, baseline: {} });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].baseline, null);
    assert.equal(r.candidates[0].delta, null, 'no baseline means delta is null — never equal to score');
    assert.notEqual(r.candidates[0].delta, r.candidates[0].score);
    assert.deepEqual(r.candidates[0].reasons, ['threshold'], 'jump must not be evaluated with no baseline');
  });

  test('ordersCandidatesDeterministically', () => {
    const analyzed = [
      { file: 'b.js', ok: true, method: 'decision-points', functions: [{ name: 'y', startLine: 1, endLine: 3, score: 20 }] },
      {
        file: 'a.js',
        ok: true,
        method: 'decision-points',
        functions: [
          { name: 'x', startLine: 1, endLine: 3, score: 20 },
          { name: 'z', startLine: 10, endLine: 13, score: 18 },
        ],
      },
    ];
    const baseline = { 'a.js::x': { score: 10 } }; // y and z have no baseline entry
    const r = evaluateCandidates({ analyzed, baseline, threshold: 15, jumpDelta: 100 });
    const ids = r.candidates.map((c) => `${c.file}::${c.name}`);
    assert.deepEqual(ids, ['a.js::x', 'b.js::y', 'a.js::z'], 'score desc, delta desc (null last), file asc, name asc');
    assert.equal(r.target, r.candidates[0]);
  });

  test('breaksCandidateTiesStably', () => {
    const analyzed = [
      {
        file: 'a.js',
        ok: true,
        method: 'decision-points',
        functions: [
          { name: 'bravo', startLine: 20, endLine: 22, score: 20 },
          { name: 'alpha', startLine: 5, endLine: 7, score: 20 },
        ],
      },
    ];
    const r = evaluateCandidates({ analyzed, baseline: {}, threshold: 15, jumpDelta: 100 });
    assert.deepEqual(r.candidates.map((c) => c.name), ['alpha', 'bravo'], 'tie on every other key breaks by name ascending');
  });

  test('rejectsNonNumericThresholdInsteadOfNaNComparing', () => {
    const scoreAboveDefaultThreshold = DEFAULTS.threshold + 1;
    const analyzed = [{
      file: 'a.js',
      ok: true,
      method: 'decision-points',
      functions: [{ name: 'f', startLine: 1, endLine: 3, score: scoreAboveDefaultThreshold }],
    }];
    for (const bad of [0, -5, 'not-a-number', NaN, undefined, null, {}]) {
      const r = evaluateCandidates({ analyzed, baseline: {}, threshold: bad, jumpDelta: bad });
      assert.equal(r.thresholdUsed, DEFAULTS.threshold, `threshold ${String(bad)} must fall back to the default`);
      assert.equal(r.jumpDeltaUsed, DEFAULTS.jumpDelta, `jumpDelta ${String(bad)} must fall back to the default`);
      assert.equal(r.verdict, VERDICT.TRIGGERED, 'fallback must still evaluate — never a silent NaN-comparison never-trigger');
    }
  });
});

// ---------------------------------------------------------------------------
// Baseline persistence (matrix rows 45-54)
// ---------------------------------------------------------------------------

describe('complexity-trigger: baseline persistence', () => {
  test('treatsMissingBaselineAsEmpty', (t) => {
    const tmp = createTempDir('complexity-trigger-');
    t.after(() => cleanup(tmp));
    const r = readBaseline(tmp);
    assert.equal(r.ok, true);
    assert.deepEqual(r.baseline, {});
    assert.equal(r.reason, undefined);
  });

  test('doesNotClobberMalformedBaselineOnReadFailure', (t) => {
    const tmp = createTempDir('complexity-trigger-');
    t.after(() => cleanup(tmp));
    const baselinePath = path.join(tmp, BASELINE_FILE_NAME);
    fs.writeFileSync(baselinePath, '{not valid json', 'utf8');
    const before = fs.readFileSync(baselinePath, 'utf8');

    const r = readBaseline(tmp);
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASON.REFACTOR_BASELINE_MALFORMED);
    assert.deepEqual(r.baseline, {});

    const after = fs.readFileSync(baselinePath, 'utf8');
    assert.equal(after, before, 'a failing read must never rewrite the malformed file');
  });

  test('rejectsWrongShapedBaseline', (t) => {
    const tmp = createTempDir('complexity-trigger-');
    t.after(() => cleanup(tmp));
    const baselinePath = path.join(tmp, BASELINE_FILE_NAME);
    for (const bad of ['[]', '"a string"', 'null', '42']) {
      fs.writeFileSync(baselinePath, bad, 'utf8');
      const r = readBaseline(tmp);
      assert.equal(r.ok, false, `shape ${bad} must be rejected`);
      assert.equal(r.reason, REASON.REFACTOR_BASELINE_MALFORMED);
    }
  });

  test('anchorsBaselineOnFirstObservation', () => {
    const prev = {};
    const analyzed = [{
      file: 'a.js', ok: true, method: 'decision-points',
      functions: [{ name: 'f', startLine: 1, endLine: 3, score: 6 }],
    }];
    const next = nextBaseline(prev, analyzed, [], { analyzedFiles: ['a.js'] });
    assert.equal(next['a.js::f'].score, 6, 'first observation inserts the anchor at the current score');
  });

  test('doesNotAdvanceAnchorOnPlainEvaluate', () => {
    const prev = { 'a.js::f': { score: 3 } };
    const analyzed = [{
      file: 'a.js', ok: true, method: 'decision-points',
      functions: [{ name: 'f', startLine: 1, endLine: 3, score: 6 }],
    }];
    const next = nextBaseline(prev, analyzed, [], { analyzedFiles: ['a.js'] });
    assert.equal(next['a.js::f'].score, 3, 'a stable anchor must not advance on a plain evaluate, even for a non-triggering function');
  });

  test('freezesBaselineWhileProposalUntriaged', () => {
    // The anchor is unconditionally stable across evaluate — not merely
    // "frozen because it triggered". This proves it holds even when the
    // function is (still) triggering on a second evaluate.
    const prev = { 'a.js::f': { score: 10 } };
    const analyzed = [{
      file: 'a.js', ok: true, method: 'decision-points',
      functions: [{ name: 'f', startLine: 1, endLine: 5, score: DEFAULTS.threshold + 5 }],
    }];
    const evaluation = evaluateCandidates({ analyzed, baseline: prev });
    assert.equal(evaluation.verdict, VERDICT.TRIGGERED);

    const next = nextBaseline(prev, analyzed, evaluation.candidates, { analyzedFiles: ['a.js'] });
    assert.equal(next['a.js::f'], prev['a.js::f'], 'the anchor carries forward unchanged, not merely equal');
    assert.equal(next['a.js::f'].score, 10);
  });

  test('reanchorsBaselineOnDisposition', () => {
    // Proves reanchorBaseline is the ONLY thing that moves an anchor:
    // nextBaseline leaves it untouched regardless of candidates; only an
    // explicit disposition call moves it.
    const key = 'src/a.cts::target';
    const prev = { [key]: { score: 3 } };

    const analyzed = [{
      file: 'src/a.cts', ok: true, method: 'decision-points',
      functions: [{ name: 'target', startLine: 1, endLine: 20, score: 11 }],
    }];
    const evaluation = evaluateCandidates({ analyzed, baseline: prev });
    const afterEvaluate = nextBaseline(prev, analyzed, evaluation.candidates, { analyzedFiles: ['src/a.cts'] });
    assert.equal(afterEvaluate[key].score, 3, 'a plain evaluate must never move the anchor');

    // Accept: re-anchor to a LOWER post-refactor score.
    const afterAccept = reanchorBaseline(prev, key, 4);
    assert.equal(afterAccept[key].score, 4, 'accept re-anchors to the post-refactor score');

    // Decline: re-anchor to the current HIGHER score (debt consciously accepted).
    const afterDecline = reanchorBaseline(prev, key, 11);
    assert.equal(afterDecline[key].score, 11, 'decline re-anchors to the current score');
  });

  test('detectsIncrementalCreepAcrossRuns', () => {
    const T = 15;
    const D = 5;
    const anchor = { 'a.js::f': { score: 8 } };
    let baseline = anchor;
    let firstTriggeringRound = null;
    let firstTriggeringCandidate = null;

    for (let round = 1; round <= 5; round += 1) {
      const score = 6 + round * 2; // round1=8, round2=10, round3=12, round4=14, round5=16
      const analyzed = [{
        file: 'a.js', ok: true, method: 'decision-points',
        functions: [{ name: 'f', startLine: 1, endLine: 5, score }],
      }];
      const evaluation = evaluateCandidates({ analyzed, baseline, threshold: T, jumpDelta: D });
      if (firstTriggeringRound === null && evaluation.verdict === VERDICT.TRIGGERED) {
        firstTriggeringRound = round;
        firstTriggeringCandidate = evaluation.candidates[0];
      }
      baseline = nextBaseline(baseline, analyzed, evaluation.candidates, { analyzedFiles: ['a.js'] });
    }

    // Anchor is stable at 8 throughout (a plain evaluate never advances it),
    // so the delta is CUMULATIVE since the anchor: round1=0, round2=2,
    // round3=4, round4=6, round5=8. Delta first exceeds D=5 at round 4
    // (6 > 5) — one full run before the absolute score would cross T=15
    // (score 16 at round 5). This is the point of the test: the jump-delta
    // catches the creep earlier than, and independently of, the absolute
    // threshold — it is not redundant with it.
    assert.equal(firstTriggeringRound, 4);
    assert.ok(
      firstTriggeringCandidate.reasons.includes('jump'),
      'round 4 must trigger via the jump reason, proving the jump-delta adds value over the absolute threshold',
    );
  });

  test('prunesBaselineForDeletedFile', () => {
    const analyzed = [{
      file: 'a.js', ok: true, method: 'decision-points',
      functions: [{ name: 'f', startLine: 1, endLine: 3, score: 5 }],
    }];

    const prev = { 'a.js::f': { score: 5 }, 'a.js::g': { score: 8 } };
    const next = nextBaseline(prev, analyzed, [], { analyzedFiles: ['a.js'] });
    assert.ok(!('a.js::g' in next), 'g no longer exists in the analyzed file; its baseline entry must be pruned');
    assert.equal(next['a.js::f'].score, 5);

    const prevWithUntouchedFile = { 'a.js::f': { score: 5 }, 'b.js::h': { score: 99 } };
    const nextWithUntouchedFile = nextBaseline(prevWithUntouchedFile, analyzed, [], { analyzedFiles: ['a.js'] });
    assert.equal(
      nextWithUntouchedFile['b.js::h'].score,
      99,
      'an entry whose file is absent from analyzedFiles must never be pruned',
    );
  });

  test('leavesNoPartialBaselineWhenWriteFails', (t) => {
    const tmp = createTempDir('complexity-trigger-');
    t.after(() => cleanup(tmp));
    const writeMock = mock.method(fs, 'writeFileSync', () => {
      const err = new Error('ENOSPC: no space left on device');
      err.code = 'ENOSPC';
      throw err;
    });
    t.after(() => writeMock.mock.restore());

    const r = writeBaseline(tmp, { 'a.js::f': { score: 5 } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASON.REFACTOR_BASELINE_WRITE_FAILED);

    const leftover = fs.readdirSync(tmp).filter((n) => n.includes('.tmp'));
    assert.deepEqual(leftover, [], 'no orphan tmp file must remain after write failure');
  });

  test('cleansUpTempFileWhenRenameFails', (t) => {
    const tmp = createTempDir('complexity-trigger-');
    t.after(() => cleanup(tmp));
    const renameMock = mock.method(fs, 'renameSync', () => {
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    });
    t.after(() => renameMock.mock.restore());

    const r = writeBaseline(tmp, { 'a.js::f': { score: 5 } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASON.REFACTOR_BASELINE_WRITE_FAILED);

    const leftover = fs.readdirSync(tmp).filter((n) => n.includes('.tmp'));
    assert.deepEqual(leftover, [], 'the orphan .tmp file must be unlinked when rename fails');
  });

  test('degradesReadBaselineOnDeniedRead', (t) => {
    // An injected EACCES on the baseline read must degrade readBaseline to
    // { ok:false, baseline:{}, reason: REFACTOR_BASELINE_MALFORMED } without
    // throwing.
    const tmp = createTempDir('complexity-trigger-');
    t.after(() => cleanup(tmp));
    const readMock = mock.method(fs, 'readFileSync', () => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    });
    t.after(() => readMock.mock.restore());

    const r = readBaseline(tmp);
    assert.equal(r.ok, false);
    assert.deepEqual(r.baseline, {});
    assert.equal(r.reason, REASON.REFACTOR_BASELINE_MALFORMED);
  });
});

// ---------------------------------------------------------------------------
// Typed surface — frozen enums and constants
// ---------------------------------------------------------------------------

describe('complexity-trigger: typed surface', () => {
  test('locksReasonEnumKeys', () => {
    const expected = [
      'REFACTOR_ALREADY_DISPOSITIONED',
      'REFACTOR_ANALYZER_UNPARSEABLE',
      'REFACTOR_ANALYZER_UNSUPPORTED',
      'REFACTOR_ARTIFACT_NOT_FOUND',
      'REFACTOR_BASELINE_MALFORMED',
      'REFACTOR_BASELINE_WRITE_FAILED',
      'REFACTOR_DECLINE_REASON_EMPTY',
      'REFACTOR_DISABLED',
      'REFACTOR_GIT_UNAVAILABLE',
      'REFACTOR_INVALID_PHASE',
      'REFACTOR_NO_TOUCHED_FILES',
      'REFACTOR_OK',
      'REFACTOR_USAGE',
    ].sort();
    assert.deepEqual(Object.keys(REASON).sort(), expected);
    assert.ok(Object.isFrozen(REASON));
  });

  test('locksVerdictEnumKeys', () => {
    const expected = ['BELOW_THRESHOLD', 'SKIPPED', 'TRIGGERED'].sort();
    assert.deepEqual(Object.keys(VERDICT).sort(), expected);
    assert.ok(Object.isFrozen(VERDICT));
  });

  test('exposes frozen DEFAULTS and ANALYZABLE_EXTENSIONS with documented values', () => {
    assert.deepEqual(DEFAULTS, { threshold: 15, jumpDelta: 5 });
    assert.ok(Object.isFrozen(DEFAULTS));
    assert.deepEqual(ANALYZABLE_EXTENSIONS, ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts']);
    assert.ok(Object.isFrozen(ANALYZABLE_EXTENSIONS));
  });

  test('exposes the documented module-scoped constants', () => {
    assert.equal(BASELINE_FILE_NAME, 'complexity-baseline.json');
    assert.equal(PROPOSAL_SUFFIX, '-REFACTOR.md');
    assert.equal(SCHEMA_VERSION, 1);
  });
});

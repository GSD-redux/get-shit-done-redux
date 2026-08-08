'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Unit coverage for the #3216 WIDENING of the milestone-window drift guard
 * (scripts/lint-milestone-window-drift.cjs, epic #3180, issue #3184/#3216,
 * ADR-3180 Decision 4(a)).
 *
 * Modelled on tests/enumeration-drift-guard.test.cjs: this file covers ONLY
 * the tokens/behavior #3216 added — the literal `##` heading-anchor path,
 * the grouped and interpolated version shapes, and the function-scoped
 * (not file-scoped) exemption boundary. Behavioral throughout: assertions
 * drive `findMilestoneWindowDrift` / `headingMatcherLiterals` / `scanRepo`
 * directly — no `readFileSync().includes()` in a test body.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  findMilestoneWindowDrift,
  scanRepo,
  headingMatcherLiterals,
} = require(path.join(ROOT, 'scripts', 'lint-milestone-window-drift.cjs'));

describe('#3216 widened tokens: findMilestoneWindowDrift (pure)', () => {
  test('an interpolated-version heading matcher (the real :785 shape) IS flagged', () => {
    const line =
      "      const headingMatch = roadmap.match(new RegExp(`^##[^\\\\n]*${escapedVer}[:\\\\s]+([^\\\\n(]+)`, 'im'));";
    const v = findMilestoneWindowDrift(line, 'src/fake.cts');
    assert.equal(v.length, 1);
    assert.equal(v[0].line, 1);
  });

  test('a grouped-version regex-literal heading matcher (the real :806 shape) IS flagged', () => {
    const line = '    const headingMatch = cleaned.match(/## (?!.*✅).*v(\\d+(?:\\.\\d+)+)[:\\s]+([^\\n(]+)/);';
    const v = findMilestoneWindowDrift(line, 'src/fake.cts');
    assert.equal(v.length, 1);
    assert.equal(v[0].line, 1);
  });

  test('an unanchored enumeration shape (the real :454 shape) IS flagged', () => {
    const line = '  const milestonePattern = /##\\s*(.*v(\\d+(?:\\.\\d+)+)[^(\\n]*)/gi;';
    const v = findMilestoneWindowDrift(line, 'src/fake.cts');
    assert.equal(v.length, 1);
    assert.equal(v[0].line, 1);
  });

  test('phaseHeadingRegexCarryingOnlyTheQuantifierIsNotFlagged', () => {
    // Token (a) alone — no literal heading run, no version/marker token — is
    // the "where is phase N's heading" question, already single-owned
    // elsewhere (#2121), and must stay clean.
    const line = '  const phaseRe = /^#{2,4}\\s*Phase\\s+(\\d+)/gm;';
    assert.deepEqual(findMilestoneWindowDrift(line, 'src/fake.cts'), []);
  });

  test('a heading-BUILDING template is NOT flagged (the false-positive #3216 narrowing exists to prevent)', () => {
    // A template that BUILDS a heading for output (`## ${version} — ${name}`)
    // is not a re-derivation of WHERE a milestone section begins — it never
    // matches against document text at all — so it must stay outside the
    // literal-heading-run detector, or every heading writer in the tree
    // would be flagged as if it were `locateMilestoneHeadings`.
    const line = '  const heading = `## ${version} — ${name}`;';
    assert.deepEqual(findMilestoneWindowDrift(line, 'src/fake.cts'), []);
  });

  test('literalHashShapeInACommentIsNotFlagged', () => {
    const line =
      "  // const headingMatch = roadmap.match(new RegExp(`^##[^\\\\n]*${escapedVer}[:\\\\s]+([^\\\\n(]+)`, 'im'));";
    assert.deepEqual(findMilestoneWindowDrift(line, 'src/fake.cts'), []);
  });

  test('literalHashShapeInAJsDocContinuationIsNotFlagged', () => {
    const line =
      "   * const headingMatch = roadmap.match(new RegExp(`^##[^\\\\n]*${escapedVer}[:\\\\s]+([^\\\\n(]+)`, 'im'));";
    assert.deepEqual(findMilestoneWindowDrift(line, 'src/fake.cts'), []);
  });

  test('a # run inside a string literal that is never fed to new RegExp( is NOT flagged', () => {
    const line = "  const colour = fgHash + '#ffffff';";
    assert.deepEqual(findMilestoneWindowDrift(line, 'src/fake.cts'), []);
  });
});

describe('#3216: headingMatcherLiterals (pure)', () => {
  test('a regex literal on the line is returned', () => {
    const line = 'const x = /abc/;';
    assert.deepEqual(headingMatcherLiterals(line, line), ['/abc/']);
  });

  test('a string/template literal is returned ONLY when the line also contains new RegExp(', () => {
    const withNewRegExp = 'const re = new RegExp(`##foo`);';
    assert.deepEqual(headingMatcherLiterals(withNewRegExp, withNewRegExp), ['`##foo`']);

    const plainAssignment = 'const heading = `##foo`;';
    assert.deepEqual(headingMatcherLiterals(plainAssignment, plainAssignment), []);
  });

  test('a line with no literals returns an empty array', () => {
    const line = 'const x = 1 + 2;';
    assert.deepEqual(headingMatcherLiterals(line, line), []);
  });
});

describe('#3216: function-scoped exemptions', () => {
  const OWNER_REL = path.join('src', 'roadmap-parser.cts');

  test('namedCanonicalFunctionsRemainExemptAfterWidening', () => {
    const text = [
      'function locateMilestoneHeadings(content, version) {',
      "  const headingMatch = content.match(new RegExp(`^##[^\\\\n]*${escapedVer}[:\\\\s]+([^\\\\n(]+)`, 'im'));",
      '  return headingMatch;',
      '}',
    ].join('\n');
    assert.deepEqual(findMilestoneWindowDrift(text, OWNER_REL), []);
  });

  test('the same flagged shape inside getMilestoneInfo IS flagged, proving the exemption is function-scoped not file-scoped (row 40/53)', () => {
    const text = [
      'function getMilestoneInfo(cwd) {',
      "  const headingMatch = content.match(new RegExp(`^##[^\\\\n]*${escapedVer}[:\\\\s]+([^\\\\n(]+)`, 'im'));",
      '  return headingMatch;',
      '}',
    ].join('\n');
    const v = findMilestoneWindowDrift(text, OWNER_REL);
    assert.equal(v.length, 1);
    assert.equal(v[0].line, 2);
  });

  test('the same shape in an unrelated file path IS flagged (no exemption entry at all)', () => {
    const text = [
      'function getMilestoneInfo(cwd) {',
      "  const headingMatch = content.match(new RegExp(`^##[^\\\\n]*${escapedVer}[:\\\\s]+([^\\\\n(]+)`, 'im'));",
      '  return headingMatch;',
      '}',
    ].join('\n');
    const v = findMilestoneWindowDrift(text, path.join('src', 'somewhere-else.cts'));
    assert.equal(v.length, 1);
  });
});

describe('#3216: the live repo', () => {
  test('liveRepoHasZeroMilestoneWindowRederivations', () => {
    // Expected to FAIL (RED) until the #3216 consolidation lands — at write
    // time the live repo still carries 3 un-consolidated re-derivations
    // (roadmap-parser.cts getMilestoneInfo x2, roadmap.cts:454
    // cmdRoadmapAnalyze — see 50-test-matrix.md's "Scope amendment" section).
    // This is the failing-first proof the widened guard binds to real code,
    // not just synthetic fixtures.
    const violations = scanRepo(ROOT);
    assert.deepEqual(
      violations,
      [],
      'unsanctioned milestone-window re-derivation(s) — route through roadmap-parser.cts '
        + 'computeMilestoneSectionEnd / locateMilestoneHeadings / isMilestoneBoundedInRoadmap:\n'
        + violations.map((d) => `  ${d.file}:${d.line} ${d.found}`).join('\n'),
    );
  });
});

'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Regression test for #2977 — `extractFrontmatter` returns {} for any file whose
 * frontmatter fence is preceded by a UTF-8 BOM (Windows PowerShell `>`/`Out-File`,
 * several editors). The `startsWith('---')` byte-0 check fails on any leading byte,
 * so every frontmatter field silently disappears with no error.
 *
 * The fix strips a leading UTF-8 BOM (\uFEFF) before the fence check. Scope: BOM only
 * (acceptance criteria 1-3). The generalized "arbitrary content before the fence" fork
 * (tolerate vs diagnose) is a product-intent decision, surfaced in the PR — out of scope.
 *
 * Matrix: .gsd/bug/fix/2977-frontmatter-bom-tolerance/50-test-matrix.md
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

const BOM = '\uFEFF';

describe('extractFrontmatter BOM tolerance (#2977)', () => {
  test('bomPrefixedFrontmatterParses', () => {
    // Row 1 (failing-first regression): a BOM-prefixed frontmatter document parses
    // identically to the same document without the BOM.
    const clean = '---\ntitle: T\nphase: "01"\nstatus: passed\n---\n\n# Body\n';
    const bommed = BOM + clean;
    const expected = extractFrontmatter(clean, 'a.md');
    const actual = extractFrontmatter(bommed, 'a.md');
    assert.deepEqual(actual, expected, 'BOM-prefixed frontmatter must parse identically to no-BOM');
    assert.strictEqual(actual.title, 'T', 'title field recovered');
    assert.strictEqual(actual.phase, '01', 'phase field recovered');
    assert.strictEqual(actual.status, 'passed', 'status field recovered');
  });

  test('bomWithCrlfParses', () => {
    // Row 2 (acceptance #2): BOM + CRLF line endings together still parse correctly.
    const clean = '---\r\ntitle: T\r\nphase: "01"\r\n---\r\n\r\n# Body\r\n';
    const bommed = BOM + clean;
    const actual = extractFrontmatter(bommed, 'a.md');
    assert.strictEqual(actual.title, 'T', 'title recovered (BOM + CRLF)');
    assert.strictEqual(actual.phase, '01', 'phase recovered (BOM + CRLF)');
  });

  test('bomWithNoFrontmatterStaysEmpty', () => {
    // Row 3 (acceptance #3): a BOM prefixing a document with no frontmatter (or genuinely
    // empty frontmatter) returns {} with no false diagnostic — same as no-BOM.
    assert.deepEqual(extractFrontmatter(BOM + 'just plain text', 'a.md'), {}, 'BOM + no frontmatter -> {}');
    assert.deepEqual(extractFrontmatter(BOM + '', 'a.md'), {}, 'BOM + empty -> {}');
    // A thematic-break-first-line Markdown doc (--- then prose) must stay {} — protected by
    // the existing false-positive threshold; the BOM strip must not lower that bar.
    assert.deepEqual(extractFrontmatter(BOM + '---\n\nA horizontal rule, not frontmatter.\n', 'a.md'), {},
      'BOM + thematic-break Markdown -> {} (no false diagnostic)');
  });

  test('bomAcrossArtifactTypes', () => {
    // Row 4 (acceptance #1 across artifact types): each frontmatter-bearing artifact shape
    // recovers its fields when BOM-prefixed.
    const cases = [
      { name: 'STATE.md', body: '---\ncurrent_phase: "01"\nstatus: "In progress"\n---\n\n# State\n', expect: { current_phase: '01', status: 'In progress' } },
      { name: 'PLAN.md', body: '---\nphase: "01"\nplan: "01-01"\nstatus: "done"\n---\n\n# Plan\n', expect: { phase: '01', plan: '01-01', status: 'done' } },
      { name: 'SUMMARY.md', body: '---\none-liner: "shipped the thing"\n---\n\n# Summary\n', expect: { 'one-liner': 'shipped the thing' } },
      { name: 'UAT.md', body: '---\nphase: "02"\nverdict: "pass"\n---\n\n# UAT\n', expect: { phase: '02', verdict: 'pass' } },
    ];
    for (const c of cases) {
      const actual = extractFrontmatter(BOM + c.body, c.name);
      assert.deepEqual(actual, c.expect, `${c.name}: BOM-prefixed frontmatter must recover fields`);
    }
  });

  test('controlNoBom', () => {
    // Row 5 (no regression): no BOM, valid frontmatter still parses correctly (unchanged).
    const actual = extractFrontmatter('---\ntitle: T\nphase: "01"\n---\n\n# Body\n', 'a.md');
    assert.strictEqual(actual.title, 'T');
    assert.strictEqual(actual.phase, '01');
  });
});

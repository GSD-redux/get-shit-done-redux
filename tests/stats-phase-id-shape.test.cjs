'use strict';

/**
 * stats — phase-id shape contract (#3569)
 *
 * `gsd-tools stats` hand-rolls a phase-heading scan whose id capture accepted ANY
 * word (`[\w][\w.-]*`), so prose mentioning `` `### Phase N:` `` inside an inline
 * code span produced a phantom Not-Started row that could never complete — and
 * `phases_total` disagreed with `roadmap analyze`, whose canonical scan requires
 * a digit-bearing id (#3036 shape). These tests pin the agreement and the id shape.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const ADVERSARIAL_ROADMAP_DIR = path.join(__dirname, 'fixtures', 'adversarial', 'roadmap');

function projectWithRoadmap(t, markdown) {
  const tmpDir = createTempProject('gsd-bug-3569-');
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), markdown);
  t.after(() => cleanup(tmpDir));
  return tmpDir;
}

function statsJson(tmpDir) {
  const result = runGsdTools('stats json', tmpDir);
  assert.ok(result.success, `stats json failed: ${result.error}`);
  return JSON.parse(result.output);
}

function analyzeJson(tmpDir) {
  const result = runGsdTools('roadmap analyze json', tmpDir);
  assert.ok(result.success, `roadmap analyze json failed: ${result.error}`);
  return JSON.parse(result.output);
}

describe('bug #3569: stats phantom phase from ### Phase N: inside inline code', () => {
  test('#3569: stats ignores ### Phase N: inside inline code — exactly one phase row', (t) => {
    // The issue's exact repro: a blockquote explaining the roadmap's own numbering
    // mentions `### Phase N:` in an inline code span (plus a bare mid-paragraph
    // mention). Pre-fix, cmdStats' heading scan accepted the digit-free id "N",
    // producing a phantom Not-Started row that could never complete.
    const markdown = fs.readFileSync(path.join(ADVERSARIAL_ROADMAP_DIR, 'phase-heading-inside-inline-code.md'), 'utf-8');
    const tmpDir = projectWithRoadmap(t, markdown);
    const output = statsJson(tmpDir);
    assert.ok(Array.isArray(output.phases), `expected phases array, got: ${typeof output.phases}`);
    assert.deepEqual(
      output.phases.map((p) => p.number).sort(),
      ['01'],
      'exactly one phase — the inline-code "N" mention must not produce a row',
    );
    assert.equal(output.phases_total, 1, 'phases_total must agree with the row count');
  });

  test('#3569: stats and roadmap analyze agree on the inline-code fixture', (t) => {
    const markdown = fs.readFileSync(path.join(ADVERSARIAL_ROADMAP_DIR, 'phase-heading-inside-inline-code.md'), 'utf-8');
    const tmpDir = projectWithRoadmap(t, markdown);
    const stats = statsJson(tmpDir);
    const analyze = analyzeJson(tmpDir);
    const analyzeCount = Array.isArray(analyze.phases) ? analyze.phases.length : 0;
    assert.equal(analyzeCount, 1, 'parity control: roadmap analyze itself counts one phase');
    assert.equal(
      stats.phases.length,
      analyzeCount,
      'stats and roadmap analyze must agree on phase count (the disagreement IS the bug)',
    );
  });

  test('#3569: digit-required id shape still counts decimal phases (decimal-phase-mixed fixture)', (t) => {
    const markdown = fs.readFileSync(path.join(ADVERSARIAL_ROADMAP_DIR, 'decimal-phase-mixed.md'), 'utf-8');
    const tmpDir = projectWithRoadmap(t, markdown);
    const output = statsJson(tmpDir);
    const numbers = output.phases.map((p) => p.number);
    assert.ok(numbers.length >= 1, 'fixture carries at least one decimal phase');
    for (const num of numbers) {
      assert.match(num, /\d/, `phase id "${num}" is digit-bearing — decimals must keep counting (over-narrowing guard)`);
    }
  });

  test('#3569: milestone-prefixed and letter-prefixed phase ids still count', (t) => {
    const markdown = [
      '# Roadmap',
      '',
      '### Phase 2-01: Milestone Scoped',
      '**Goal:** G',
      '',
      '### Phase B7: Letter Prefixed',
      '**Goal:** G',
      '',
    ].join('\n');
    const tmpDir = projectWithRoadmap(t, markdown);
    const output = statsJson(tmpDir);
    assert.deepEqual(
      output.phases.map((p) => p.number).sort(),
      ['2-01', 'B7'],
      'canonical id shapes (milestone-prefixed, letter-prefixed #3036) must survive the digit requirement',
    );
  });
});

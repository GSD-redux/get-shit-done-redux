/**
 * SPEC section-status helper tests.
 *
 * Asserts the LOCKED behaviour of `spec-section` against the BUILT artifact
 * (`gsd-core/bin/lib/spec-section.cjs`), which `npm run build:lib` (run by pretest) emits from
 * `src/spec-section.cts`.
 *
 * This is the contract that pins the spec-less probe fallback's per-section absence detection
 * (plan-phase step 7.95). It exists because the prior ad-hoc awk produced two regressions:
 *   - an exact `^## Prohibitions$` anchor that missed the canonical `## Prohibitions (must-NOT)`
 *     heading -> a supplied section read as absent -> human SPEC prohibitions overridden;
 *   - single-table row counting that could miscount multi-table sections.
 * Both are regression-tested below.
 */
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const BUILT_SCRIPT = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'spec-section.cjs');
const ss = require(BUILT_SCRIPT);

function writeTmp(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-section-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const PROHIB_SUFFIX_SPEC = [
  '## Prohibitions (must-NOT)',
  '',
  '**Coverage:** 2/2 applicable prohibitions resolved · 0 unresolved',
  '',
  '| Prohibition | Requirement | Status | Verification |',
  '|-------------|-------------|--------|--------------|',
  '| MUST NOT do X | R1 | resolved | test |',
  '| MUST NOT do Y | R2 | resolved | judgment |',
  '',
  '## Ambiguity Report',
  '| Dim | Score |',
  '|-----|-------|',
  '| Goal | 0.9 |',
].join('\n');

describe('spec-section: countSectionDataRows / specSectionStatus', () => {
  test('suffix-tolerant header: `## Prohibitions (must-NOT)` is detected for key=prohibitions (the header-bug regression)', () => {
    const status = ss.countSectionDataRows(PROHIB_SUFFIX_SPEC, 'prohibitions');
    assert.equal(status.present, true);
    assert.equal(status.dataRows, 2);
  });

  test('does not bleed into the next `##` section (Ambiguity Report rows are not counted as prohibitions)', () => {
    const status = ss.countSectionDataRows(PROHIB_SUFFIX_SPEC, 'prohibitions');
    assert.equal(status.dataRows, 2); // not 3 — the Ambiguity Report data row is outside the section
  });

  test('`## Edge Coverage` is detected and data rows counted', () => {
    const spec = [
      '## Edge Coverage',
      '',
      '| Category | Requirement | Status | Resolution |',
      '|----------|-------------|--------|------------|',
      '| empty | R1 | covered | x |',
      '| ordering | R1 | dismissed | y |',
      '| adjacency | R2 | backstop | z |',
    ].join('\n');
    const status = ss.countSectionDataRows(spec, 'edges');
    assert.equal(status.present, true);
    assert.equal(status.dataRows, 3);
  });

  test('present-but-empty section (header + table header + separator, no data rows) is NOT supplied', () => {
    const spec = [
      '## Prohibitions (must-NOT)',
      '',
      '**Coverage:** 0/0 applicable',
      '',
      '| Prohibition | Requirement | Status | Verification |',
      '|-------------|-------------|--------|--------------|',
    ].join('\n');
    const p = writeTmp('empty.md', spec);
    const status = ss.specSectionStatus(p, 'prohibitions');
    assert.equal(status.present, true);
    assert.equal(status.dataRows, 0);
    assert.equal(status.supplied, false);
  });

  test('absent section -> not present, not supplied', () => {
    const p = writeTmp('noproh.md', '## Edge Coverage\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    const status = ss.specSectionStatus(p, 'prohibitions');
    assert.equal(status.present, false);
    assert.equal(status.supplied, false);
  });

  test('missing file -> not present, not supplied (no throw)', () => {
    const status = ss.specSectionStatus('/no/such/file-xyz.md', 'edges');
    assert.deepEqual(status, { key: 'edges', present: false, dataRows: 0, supplied: false });
  });

  test('multi-table section counts every table’s data rows (the awk single-table miscount regression)', () => {
    const spec = [
      '## Edge Coverage',
      '',
      '| Category | Status |',
      '|----------|--------|',
      '| empty | covered |',
      '',
      'Some prose between two tables.',
      '',
      '| Category | Status |',
      '|----------|--------|',
      '| ordering | covered |',
      '| adjacency | backstop |',
    ].join('\n');
    const status = ss.countSectionDataRows(spec, 'edges');
    assert.equal(status.dataRows, 3); // 1 + 2 across both tables
  });

  test('supplied = present AND dataRows > 0', () => {
    const p = writeTmp('full.md', PROHIB_SUFFIX_SPEC);
    assert.equal(ss.specSectionStatus(p, 'prohibitions').supplied, true);
  });
});

describe('spec-section: CLI', () => {
  test('prints JSON status and exits 0 for a valid key', () => {
    const p = writeTmp('cli.md', PROHIB_SUFFIX_SPEC);
    const r = toLegacyResult(runNode([BUILT_SCRIPT, p, 'prohibitions'], { timeoutMs: PROBE_TIMEOUT_MS }));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.supplied, true);
    assert.equal(out.dataRows, 2);
  });

  test('exits 2 on a bad key', () => {
    const p = writeTmp('cli2.md', PROHIB_SUFFIX_SPEC);
    const r = toLegacyResult(runNode([BUILT_SCRIPT, p, 'bogus'], { timeoutMs: PROBE_TIMEOUT_MS }));
    assert.equal(r.status, 2);
  });
});

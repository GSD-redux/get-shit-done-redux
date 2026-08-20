'use strict';

/**
 * Characterization tests for T3 seam migration (#1390).
 *
 * These tests capture CURRENT behavior of the two gate-adjacent functions
 * being migrated onto the markdown-sectionizer seam:
 *   1. `extractPlanDesignatedSections` (check-command-router.cts)
 *   2. `parseRequirements` checkbox-bullet path (gap-checker.cts)
 *
 * They are written BEFORE the migration (refactor pattern: tests go green
 * before AND after). They act as the byte-identical contract:
 * any migration that makes one of these fail is wrong.
 *
 * All tests are BEHAVIORAL (call the exported function, assert typed output).
 * No source-grep.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractPlanDesignatedSections,
} = require('../gsd-core/bin/lib/check-command-router.cjs');

const {
  parseRequirements,
} = require('../gsd-core/bin/lib/gap-checker.cjs');

// ─── extractPlanDesignatedSections ───────────────────────────────────────────

describe('extractPlanDesignatedSections — characterization (T3 pre-migration contract)', () => {

  // ── HTML comment stripping (CALLER-SIDE: must survive migration) ──────────

  test('strips HTML comments before scanning', () => {
    const content = `# Plan\n<!-- D-01: this is a comment -->\n## Must Haves\n- D-01: implement\n`;
    const result = extractPlanDesignatedSections(content);
    // Comment is gone; designated section body is intact
    assert.ok(!result.includes('D-01: this is a comment'), 'HTML comment content must be stripped');
  });

  test('strips multi-line HTML comment spanning lines', () => {
    const content = `# Plan\n<!--\nhidden section\n-->\n## Objective\n- D-01: implement\n`;
    const result = extractPlanDesignatedSections(content);
    assert.ok(!result.includes('hidden section'), 'Multi-line comment content must be stripped');
    assert.ok(result.includes('D-01'), 'Objective section content must survive');
  });

  // ── Fenced code block stripping ───────────────────────────────────────────

  test('strips backtick fenced code blocks', () => {
    const content = [
      '## Must Haves',
      '- D-01: real requirement',
      '```',
      '## Must Haves',
      '- D-99: fake in fence',
      '```',
    ].join('\n');
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-01'), 'Real D-01 outside fence must be included');
    assert.ok(!result.includes('D-99'), 'D-99 inside fence must be stripped');
  });

  test('strips tilde fenced code blocks', () => {
    const content = [
      '## Truths',
      '- D-01: real',
      '~~~',
      '- D-99: inside tilde fence',
      '~~~',
    ].join('\n');
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-01'), 'D-01 outside tilde fence must be included');
    assert.ok(!result.includes('D-99'), 'D-99 inside tilde fence must be stripped');
  });

  // ── DESIGNATED_HEADINGS_RE matching ───────────────────────────────────────

  test('collects body under ## Must Haves heading', () => {
    const content = '# Plan\n\n## Must Haves\n\n- D-01: decision one\n- D-02: decision two\n\n## Other Heading\n\nsome text\n';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-01'), 'Must Haves body must include D-01');
    assert.ok(result.includes('D-02'), 'Must Haves body must include D-02');
    assert.ok(!result.includes('some text'), 'Non-designated section must be excluded');
  });

  test('collects body under ## Truths heading', () => {
    const content = '## Truths\n\n- D-03: truth one\n\n## Irrelevant\n\nignored\n';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-03'), 'Truths body must include D-03');
    assert.ok(!result.includes('ignored'), 'Non-designated heading must be excluded');
  });

  test('collects body under ## Objective heading', () => {
    const content = '## Objective\n\n- D-04: objective item\n';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-04'), 'Objective body must include D-04');
  });

  test('collects body under ## Tasks heading', () => {
    const content = '## Tasks\n\n- D-05: task one\n';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-05'), 'Tasks body must include D-05');
  });

  test('collects body under ## Task (singular) heading', () => {
    const content = '## Task\n\n- D-06: singular task\n';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-06'), 'Task (singular) body must include D-06');
  });

  test('collects body under ## Must Have (singular) heading', () => {
    const content = '## Must Have\n\n- D-07: singular must have\n';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-07'), 'Must Have (singular) body must include D-07');
  });

  test('collects body under ## Truth (singular) heading', () => {
    const content = '## Truth\n\n- D-08: singular truth\n';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-08'), 'Truth (singular) body must include D-08');
  });

  test('stops collecting when next heading is non-designated', () => {
    const content = [
      '## Must Haves',
      '- D-01: item in must haves',
      '## Implementation Plan',
      '- D-99: item in non-designated',
    ].join('\n');
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-01'), 'D-01 in designated section must be collected');
    assert.ok(!result.includes('D-99'), 'D-99 in non-designated section must not be collected');
  });

  test('collects multiple designated sections separately', () => {
    const content = [
      '## Must Haves',
      '- D-01: must have',
      '## Objective',
      '- D-02: objective',
      '## Implementation',
      '- D-99: not designated',
    ].join('\n');
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-01'), 'D-01 from Must Haves must be collected');
    assert.ok(result.includes('D-02'), 'D-02 from Objective must be collected');
    assert.ok(!result.includes('D-99'), 'D-99 from Implementation must not be collected');
  });

  test('heading match is case-insensitive (## MUST HAVES)', () => {
    const content = '## MUST HAVES\n\n- D-01: uppercase heading\n';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-01'), 'Uppercase MUST HAVES heading must be matched');
  });

  test('heading match is case-insensitive (## TRUTHS)', () => {
    const content = '## TRUTHS\n\n- D-02: uppercase truths\n';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-02'), 'Uppercase TRUTHS heading must be matched');
  });

  // ── YAML frontmatter extraction ───────────────────────────────────────────

  test('extracts must_haves from YAML frontmatter', () => {
    const content = [
      '---',
      'must_haves:',
      '  - D-01: jwt tokens',
      '  - D-02: redis',
      'other_key: value',
      '---',
      '# Plan body',
    ].join('\n');
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-01'), 'must_haves YAML value must be included');
    assert.ok(result.includes('D-02'), 'must_haves YAML second value must be included');
  });

  test('extracts objective from YAML frontmatter', () => {
    const content = [
      '---',
      'objective: Implement D-01 for auth',
      '---',
      '# Body',
    ].join('\n');
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-01'), 'objective YAML value must be included');
  });

  test('extracts truths from YAML frontmatter', () => {
    const content = [
      '---',
      'truths:',
      '  - D-03: the canonical truth',
      '---',
      '# Body',
    ].join('\n');
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-03'), 'truths YAML value must be included');
  });

  // ── XML tag bodies ─────────────────────────────────────────────────────────

  test('extracts content from <objective> XML tags', () => {
    const content = '<objective>D-01 is implemented here</objective>\n# Other section';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-01'), '<objective> tag body must be extracted');
  });

  test('extracts content from <tasks> XML tags', () => {
    const content = '<tasks>D-02 task body</tasks>';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-02'), '<tasks> tag body must be extracted');
  });

  test('extracts content from <action> XML tags', () => {
    const content = '<action>D-03 action body</action>';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-03'), '<action> tag body must be extracted');
  });

  // ── Null / empty / missing input ─────────────────────────────────────────

  test('returns empty string for null input', () => {
    assert.strictEqual(extractPlanDesignatedSections(null), '');
  });

  test('returns empty string for undefined input', () => {
    assert.strictEqual(extractPlanDesignatedSections(undefined), '');
  });

  test('returns empty string for empty string input', () => {
    assert.strictEqual(extractPlanDesignatedSections(''), '');
  });

  // ── Byte-identical spot-check: full plan fixture ─────────────────────────

  test('full plan fixture: exact output shape matches expected pattern', () => {
    const content = [
      '---',
      'must_haves:',
      '  - D-01: use JWT',
      '---',
      '# Implementation Plan',
      '',
      '## Objective',
      '',
      'Implement D-02.',
      '',
      '## Must Haves',
      '',
      '- D-03: Redis session store',
      '',
      '## Background',
      '',
      'No decisions here.',
    ].join('\n');
    const result = extractPlanDesignatedSections(content);
    // All designated items present
    assert.ok(result.includes('D-01'), 'D-01 from YAML must_haves present');
    assert.ok(result.includes('D-02'), 'D-02 from Objective section present');
    assert.ok(result.includes('D-03'), 'D-03 from Must Haves section present');
    // Non-designated content absent
    assert.ok(!result.includes('No decisions here'), 'Background section must be excluded');
  });

  test('CRLF content: designated sections collected correctly', () => {
    const content = '## Must Haves\r\n\r\n- D-01: crlf item\r\n\r\n## Other\r\n\r\nnot here\r\n';
    const result = extractPlanDesignatedSections(content);
    assert.ok(result.includes('D-01'), 'CRLF content must be handled; D-01 must be collected');
    assert.ok(!result.includes('not here'), 'Non-designated CRLF content must be excluded');
  });
});

// ─── parseRequirements — checkbox-bullet path ─────────────────────────────────

describe('parseRequirements — checkbox-bullet characterization (T3 pre-migration contract)', () => {

  // ── Basic checkbox parsing ────────────────────────────────────────────────

  test('parses unchecked checkbox bullet - [ ] **REQ-01**', () => {
    const md = '- [ ] **REQ-01** First requirement\n';
    const items = parseRequirements(md);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, 'REQ-01');
    assert.strictEqual(items[0].text, 'First requirement');
  });

  test('parses checked checkbox bullet - [x] **REQ-01**', () => {
    const md = '- [x] **REQ-01** Checked requirement\n';
    const items = parseRequirements(md);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, 'REQ-01');
    assert.strictEqual(items[0].text, 'Checked requirement');
  });

  test('strips the separator colon used by the shipped requirements template', () => {
    const md = '- [ ] **AUTH-01**: User can sign up\n';
    const items = parseRequirements(md);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, 'AUTH-01');
    assert.strictEqual(items[0].text, 'User can sign up');
  });

  test('parses multiple checkbox bullets', () => {
    const md = [
      '- [ ] **REQ-01** First',
      '- [x] **REQ-02** Second (checked)',
      '- [ ] **REQ-03** Third',
    ].join('\n') + '\n';
    const items = parseRequirements(md);
    assert.deepStrictEqual(items.map(i => i.id), ['REQ-01', 'REQ-02', 'REQ-03']);
  });

  test('deduplicates repeated IDs (first occurrence wins)', () => {
    const md = '- [ ] **REQ-01** First\n- [ ] **REQ-01** Duplicate\n';
    const items = parseRequirements(md);
    assert.strictEqual(items.length, 1, 'Duplicate IDs must be deduplicated');
    assert.strictEqual(items[0].id, 'REQ-01');
    assert.strictEqual(items[0].text, 'First');
  });

  test('parses non-REQ prefixes (TST-01, BACK-07, INSP-04)', () => {
    const md = [
      '- [ ] **TST-01** Test requirement',
      '- [ ] **BACK-07** Backend requirement',
      '- [ ] **INSP-04** Inspector requirement',
    ].join('\n') + '\n';
    const items = parseRequirements(md);
    const ids = items.map(i => i.id);
    assert.ok(ids.includes('TST-01'), 'TST-01 must be parsed');
    assert.ok(ids.includes('BACK-07'), 'BACK-07 must be parsed');
    assert.ok(ids.includes('INSP-04'), 'INSP-04 must be parsed');
  });

  test('returns [] for empty string', () => {
    assert.deepStrictEqual(parseRequirements(''), []);
  });

  test('returns [] for null', () => {
    assert.deepStrictEqual(parseRequirements(null), []);
  });

  test('returns [] for undefined', () => {
    assert.deepStrictEqual(parseRequirements(undefined), []);
  });

  test('returns [] for non-string (number)', () => {
    assert.deepStrictEqual(parseRequirements(42), []);
  });

  // ── Table path (must remain caller-side after migration) ──────────────────

  test('parses REQ-ID from table first-cell', () => {
    const md = [
      '| REQ-ID | Phase | Plan(s) |',
      '|--------|-------|---------|',
      '| TST-01 | Phase 01 | TBD |',
      '| BACK-07 | Phase 01 | TBD |',
    ].join('\n') + '\n';
    const items = parseRequirements(md);
    const ids = items.map(i => i.id);
    assert.ok(ids.includes('TST-01'), 'TST-01 must be parsed from table');
    assert.ok(ids.includes('BACK-07'), 'BACK-07 must be parsed from table');
    assert.ok(!ids.includes('REQ-ID'), 'Header token REQ-ID must not be parsed');
  });

  test('skips separator rows (|---|---|)', () => {
    const md = [
      '| REQ-ID | Phase |',
      '|--------|-------|',
      '| TST-01 | Phase 01 |',
    ].join('\n') + '\n';
    const items = parseRequirements(md);
    // Separator row itself must not produce a requirement
    assert.ok(items.every(i => /^[A-Z][A-Z0-9]*-[A-Za-z0-9_-]+$/.test(i.id)),
      'All items must have valid ID format (not separator row content)');
  });

  test('skips header row immediately preceding separator', () => {
    const md = [
      '| REQ-ID | Phase |',  // header row
      '|--------|-------|',  // separator row
      '| REQ-01 | Phase 01 |',
    ].join('\n') + '\n';
    const items = parseRequirements(md);
    const ids = items.map(i => i.id);
    assert.ok(!ids.includes('REQ-ID'), 'Header row token must be skipped');
    assert.ok(ids.includes('REQ-01'), 'Data row must be parsed');
  });

  test('does not parse IDs from non-first table columns', () => {
    const md = [
      '| TST-01 | Phase 01 | PLAN-01 |',
    ].join('\n') + '\n';
    const items = parseRequirements(md);
    const ids = items.map(i => i.id);
    assert.ok(ids.includes('TST-01'), 'First column ID must be parsed');
    assert.ok(!ids.includes('PLAN-01'), 'Non-first column ID must NOT be parsed');
  });

  // ── Mixed checkbox + table ────────────────────────────────────────────────

  test('parses both checkbox and table rows from same document', () => {
    const md = [
      '# Requirements',
      '',
      '| REQ-ID | Phase |',
      '|--------|-------|',
      '| TST-01 | Phase 01 |',
      '',
      '- [ ] **INSP-04** Inspector requirement',
    ].join('\n') + '\n';
    const items = parseRequirements(md);
    const ids = items.map(i => i.id);
    assert.ok(ids.includes('TST-01'), 'Table row ID must be parsed');
    assert.ok(ids.includes('INSP-04'), 'Checkbox row ID must be parsed');
  });

  test('deduplicates across checkbox and table forms (ID in both → one entry)', () => {
    const md = [
      '- [ ] **REQ-01** Checkbox form',
      '',
      '| REQ-01 | duplicate |',
    ].join('\n') + '\n';
    const items = parseRequirements(md);
    assert.strictEqual(items.filter(i => i.id === 'REQ-01').length, 1,
      'REQ-01 appearing in both forms must appear once');
  });

  // ── Natural ordering (deterministic) ─────────────────────────────────────

  test('returns items in document order (not sorted)', () => {
    // parseRequirements preserves insertion order — sorting is sortRows()'s job
    const md = [
      '- [ ] **REQ-10** Tenth',
      '- [ ] **REQ-02** Second',
      '- [ ] **REQ-01** First',
    ].join('\n') + '\n';
    const items = parseRequirements(md);
    assert.deepStrictEqual(items.map(i => i.id), ['REQ-10', 'REQ-02', 'REQ-01'],
      'Items must be returned in document order, not sorted');
  });

  // ── Indented checkbox bullets ─────────────────────────────────────────────

  test('parses indented checkbox bullet (leading whitespace)', () => {
    const md = '  - [ ] **REQ-01** Indented\n';
    const items = parseRequirements(md);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, 'REQ-01');
  });
});

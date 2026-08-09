// allow-test-rule: source-text-is-the-product (see #1867) — the rendered reference doc's taxonomy table IS the runtime contract; this pins its bijection to the code (docs-parity, ADR-456 exception matrix)
// Asserts gsd-core/references/ui-consideration-probe.md keeps its taxonomy id column in
// sync with the source-of-truth UI_TAXONOMY (built .cjs), and that the closed compiled
// taxonomy stays DISJOINT from the open-prose domain-probes.md bank (the mixed-axis boundary,
// ADPT-02). The comparison is on PARSED table ids and PARSED `##` headings, never a raw
// full-text substring match — a reformat that preserves the data does not fail; semantic drift does.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const uc = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'ui-consideration-probe.cjs'));
const docPath = path.join(__dirname, '..', 'gsd-core', 'references', 'ui-consideration-probe.md');
const domainPath = path.join(__dirname, '..', 'gsd-core', 'references', 'domain-probes.md');
const templatePath = path.join(__dirname, '..', 'gsd-core', 'templates', 'UI-SPEC.md');

// Extract the first-column ids from the `## Taxonomy` markdown table (skips the `id` header
// row and the `|----|` separator; an id is a lowercase-hyphen token).
function docTaxonomyIds(md) {
  const section = md.split(/^## Taxonomy/m)[1].split(/^## /m)[0];
  return section.split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => l.split('|')[1].trim())
    .filter((c) => /^[a-z][a-z0-9-]*$/.test(c) && c !== 'id');
}

// The `##` topic headings of the open-prose bank (lower-cased).
function domainTopics(md) {
  return md.split('\n')
    .filter((l) => /^## /.test(l))
    .map((l) => l.replace(/^## /, '').trim().toLowerCase());
}

describe('ui-consideration-probe doc/code parity (ADPT-02)', () => {
  test('reference doc exists', () => {
    assert.ok(fs.existsSync(docPath), `${docPath} must exist`);
  });

  test('doc taxonomy ids deep-equal the code UI_TAXONOMY ids, in order (doc == code)', () => {
    const md = fs.readFileSync(docPath, 'utf8');
    assert.deepEqual(docTaxonomyIds(md), uc.UI_TAXONOMY.map((c) => c.id));
  });

  test('no taxonomy id overlaps a domain-probes.md open-prose topic (closed/open disjointness)', () => {
    const topics = domainTopics(fs.readFileSync(domainPath, 'utf8'));
    for (const id of uc.UI_TAXONOMY.map((c) => c.id)) {
      assert.ok(!topics.includes(id), `taxonomy id "${id}" must not overlap a domain-probes.md topic`);
    }
  });

  test('the doc names domain-probes.md as the companion open-prose bank (links, does not duplicate)', () => {
    const md = fs.readFileSync(docPath, 'utf8');
    assert.match(md, /domain-probes\.md/);
  });
});

describe('UI-SPEC template `## UI Considerations` section (WIRE-02 SC3 de-dup)', () => {
  // PARSED `##` headings only (never a raw copy substring) — a reformat that preserves the data
  // does not fail; a missing/merged section does. Reuses the domainTopics() heading parser.
  test('template ## headings include BOTH `UI Considerations` and `Copywriting Contract` as distinct sections', () => {
    const headings = domainTopics(fs.readFileSync(templatePath, 'utf8'));
    assert.ok(headings.includes('ui considerations'), 'template must gain a ## UI Considerations section');
    assert.ok(headings.includes('copywriting contract'), 'template must retain the distinct ## Copywriting Contract section (de-dup, not a rename)');
  });
});

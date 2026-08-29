// allow-test-rule: source-text-is-the-product (#3854)
// Asserts the markdown write-normalizer's blank-line policy through the
// exported seam (normalizeContent / platformWriteSync) — no source grepping.

/**
 * Tight-list preservation in markdown write normalization — shell-command-projection-md-normalize.test.cjs
 *
 * #3854: `phase.complete` (any .md write, really) injected one blank line
 * before every bullet that follows a multi-line item's indented continuation
 * line — converting tight markdown lists to loose ones (61 injected blanks on
 * the reporter's real ROADMAP; tight and loose lists render differently, so
 * it was a rendering change plus huge diff noise, not just whitespace).
 *
 * Root cause: `_normalizeMd`'s "separate a list from a preceding paragraph"
 * rule inserted a blank before a bullet whose previous line "wasn't a bullet"
 * — but an indented CONTINUATION line of the previous item also "isn't a
 * bullet". The mirror-image after-a-bullet rule already guards against
 * indented next lines; the before-a-bullet rule must too.
 *
 * These tests pin both directions: tight lists stay tight through the write
 * seam, and the legitimate paragraph↔list separations the rule exists for
 * still happen.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('node:os');
const path = require('path');
const { normalizeContent, platformWriteSync } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const { cleanup } = require('./helpers.cjs');

const MD = 'roadmap.md';

describe('#3854: write normalization preserves tight multi-line lists', () => {
  test('a bullet following a multi-line item\'s continuation gets NO injected blank', () => {
    const tight = [
      '# Roadmap v1.0',
      '',
      '- **RC-1 — first rule** whose text wraps onto',
      '  a continuation line',
      '- **RC-2 — second rule** also wrapping onto',
      '  its continuation line',
      '- **RC-3 — third rule** single line',
      '',
    ].join('\n');
    const { content } = normalizeContent(MD, tight);
    assert.ok(
      !content.includes('a continuation line\n\n- **RC-2'),
      'no blank may be injected between a wrapped item\'s last continuation and the next item (tight list stays tight)'
    );
    assert.ok(
      !content.includes('its continuation line\n\n- **RC-3'),
      'same for every following item'
    );
    assert.strictEqual(
      content.split('\n').filter((l) => l.trim() === '').length,
      tight.split('\n').filter((l) => l.trim() === '').length,
      'blank-line count must round-trip unchanged'
    );
  });

  test('numbered tight multi-line lists are preserved too', () => {
    const tight = [
      '1. First rule with a wrapped',
      '   continuation line',
      '2. Second rule',
    ].join('\n') + '\n';
    const { content } = normalizeContent(MD, tight);
    assert.ok(
      !content.includes('continuation line\n\n2.'),
      'no blank between a wrapped numbered item\'s continuation and the next item'
    );
  });

  test('the paragraph→list separation the rule exists for STILL happens', () => {
    const doc = 'A lead-in paragraph.\n- first item\n';
    const { content } = normalizeContent(MD, doc);
    assert.ok(
      content.includes('A lead-in paragraph.\n\n- first item'),
      'a list following a paragraph still gets its separating blank'
    );
  });

  test('heading/list separations are unchanged (regression pin on the rule\'s purpose)', () => {
    const doc = '## Section\n- item\n';
    const { content } = normalizeContent(MD, doc);
    assert.ok(content.includes('## Section\n\n- item'), 'heading→list keeps its blank');
  });

  test('normalization is idempotent on a tight list (no one-shot growth, no compounding)', () => {
    const tight = '- a\n  wrapped continuation\n- b\n';
    const once = normalizeContent(MD, tight).content;
    const twice = normalizeContent(MD, once).content;
    assert.strictEqual(once, twice, 'second pass must be a no-op');
    assert.strictEqual(once, tight, 'and the first pass must not have grown the document');
  });

  test('the write seam (platformWriteSync) lands the same bytes — end-to-end guard', () => {
    const osTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3854-'));
    try {
      const target = path.join(osTmp, 'ROADMAP.md');
      const tight = '# Roadmap v1.0\n\n- item one wraps\n  continuation one\n- item two wraps\n  continuation two\n';
      platformWriteSync(target, tight);
      const onDisk = fs.readFileSync(target, 'utf-8');
      assert.strictEqual(onDisk, tight, 'platformWriteSync must not convert the tight list to a loose one');
    } finally {
      cleanup(osTmp);
    }
  });
});

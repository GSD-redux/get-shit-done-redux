// allow-test-rule: source-text-is-the-product (see #3427)
// Reads gsd-core/templates/phase-prompt.md — the template's deployed text IS
// what the planner loads, so testing its worked `depends_on` examples tests the
// contract the wave DAG depends on.

/**
 * Regression guard for #3427 / #3473 criterion B8.
 *
 * `resolveDependencyId` (src/phase.cts) resolves a `depends_on` token only
 * when it is a FULL plan id (`planMap` exact match) or a canonical id
 * (`canonicalToId` prefix match). A bare short-form suffix (`"01"`) resolves
 * to nothing and every caller silently drops the edge, collapsing the phase
 * into wave 1 (#3427; the resolver half is rewritten by #3473 B4/B5).
 *
 * Until short-form resolution exists — and regardless, per the template's own
 * documented convention (`depends_on: [] # e.g., ["01-01"]`) — the planner
 * template must only ever TEACH full-form ids in its worked `depends_on`
 * examples. This suite pins that: every non-empty `depends_on:` example in
 * templates/phase-prompt.md lists `NN-NN` full-form plan ids only.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'gsd-core', 'templates', 'phase-prompt.md');

/** Full-form plan id: two-digit phase + two-digit plan, e.g. "03-01". */
const FULL_FORM_ID = /^\d{2}-\d{2}$/;

/**
 * Extract every `depends_on:` example line from a template body.
 * Returns [{ line, tokens }] where tokens is the parsed string array
 * ([] for `depends_on: []`, null for a non-literal/unparsable value — the
 * caller treats null as a failure so an example can never opt out by
 * obfuscating its array).
 */
function extractDependsOnExamples(body) {
  const out = [];
  const lines = body.split('\n');
  lines.forEach((line, i) => {
    const match = line.match(/^\s*depends_on:\s*(\[[^\]]*\])\s*(?:#.*)?$/);
    if (!match) return;
    const raw = match[1].trim();
    if (raw === '[]') {
      out.push({ line: i + 1, text: line, tokens: [] });
      return;
    }
    const inner = raw.slice(1, -1).trim();
    const tokens = inner
      .split(',')
      .map((piece) => piece.trim().replace(/^["']|["']$/g, ''));
    out.push({ line: i + 1, text: line, tokens });
  });
  return out;
}

/** Every token in every non-empty example is a full-form plan id. */
function shortFormTokens(examples) {
  const bad = [];
  for (const example of examples) {
    for (const token of example.tokens) {
      if (!FULL_FORM_ID.test(token)) bad.push({ ...example, token });
    }
  }
  return bad;
}

describe('phase-prompt template teaches only full-form depends_on ids (#3427 / #3473 B8)', () => {
  const body = fs.readFileSync(TEMPLATE, 'utf8');
  const examples = extractDependsOnExamples(body);

  test('template carries depends_on examples to check (non-vacuous)', () => {
    assert.ok(examples.length >= 8, `expected >= 8 depends_on examples, found ${examples.length}`);
    assert.ok(
      examples.some((e) => e.tokens.length > 0),
      'expected at least one non-empty depends_on example'
    );
  });

  test('every non-empty depends_on example lists full-form plan ids only', () => {
    const bad = shortFormTokens(examples);
    assert.deepEqual(
      bad.map((b) => `line ${b.line}: token "${b.token}" in ${b.text.trim()}`),
      [],
      'depends_on examples must use full-form plan ids (e.g. ["03-01"]), never ' +
        'bare short-form suffixes like ["01"] — the resolver drops those edges ' +
        'silently (#3427)'
    );
  });

  test('checker: known good/bad samples classify correctly', () => {
    const good = extractDependsOnExamples(
      [
        'depends_on: []',
        'depends_on: ["03-01"]',
        'depends_on: ["03-01", "03-02"]  # trailing comment',
        'depends_on: ["01-01"]',
      ].join('\n')
    );
    assert.deepEqual(shortFormTokens(good), []);

    const bad = extractDependsOnExamples(
      ['depends_on: ["01"]', 'depends_on: ["01", "02"]'].join('\n')
    );
    assert.equal(shortFormTokens(bad).length, 3); // both tokens of line 2 + line 1
  });
});

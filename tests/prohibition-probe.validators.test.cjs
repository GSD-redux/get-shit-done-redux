// allow-test-rule: source-text-is-the-product (see #644) — the prohibition validators and the verify-time
// disposition are the deployed safety contract; this pins them against the CANONICAL fixture corpus
// and the ADR-550 D4 "judgment is never silently green" invariant so the code can never drift from
// its own documented intent again.
//
// Regression coverage for the two defects the RED-first suite did not exercise (code review #644):
//   CR-01 — PROHIBITION_VALIDATORS must ACCEPT every resolved prohibition in the canonical corpus
//           (resolution: null; the checkable content is `statement`). The prior config required a
//           non-empty `resolution` and threw on 100% of the fixtures.
//   WR-01 — dispositionForProhibition must NEVER return a silent green for a judgment-tier item,
//           regardless of enforcement evidence (ADR-550 D4 / verify-phase.md).
//
// Fixture-driven on purpose: the validators are exercised against the SAME expected.json files the
// docs-fixtures parity test pins, so the validator and the corpus can never silently diverge.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const PROBE_CORE_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'probe-core.cjs');
const FIXTURES_DIR = path.join(__dirname, '..', 'gsd-core', 'references', 'prohibition-probe-fixtures');

function loadFixtureItems() {
  const out = [];
  for (const name of fs.readdirSync(FIXTURES_DIR).sort()) {
    const expected = path.join(FIXTURES_DIR, name, 'expected.json');
    if (!fs.existsSync(expected)) continue;
    const json = JSON.parse(fs.readFileSync(expected, 'utf8'));
    assert.ok(json.items === undefined || Array.isArray(json.items),
      `fixture ${name}: expected.json "items" must be an array when present (got ${typeof json.items})`);
    for (const item of json.items ?? []) out.push({ fixture: name, item });
  }
  return out;
}

describe('prohibition-probe validators: canonical corpus is accepted (CR-01 regression)', () => {
  test('validateProhibitionResolution accepts every resolved item in the reference fixtures', () => {
    const pc = require(PROBE_CORE_LIB);
    assert.equal(typeof pc.validateProhibitionResolution, 'function',
      'probe-core must export validateProhibitionResolution()');

    const fixtureItems = loadFixtureItems();
    assert.ok(fixtureItems.length >= 4,
      'the corpus must carry the resolved prohibitions the validator is pinned against');

    for (const { fixture, item } of fixtureItems) {
      // A resolved prohibition's checkable content is `statement`, NOT `resolution` (resolution: null
      // in every fixture). The validator must not throw on its own canonical corpus.
      assert.doesNotThrow(
        () => pc.validateProhibitionResolution(item),
        `validateProhibitionResolution must accept fixture ${fixture} item ${item.requirement_id}::${item.category} (resolution: ${JSON.stringify(item.resolution)})`,
      );
    }
  });
});

describe('prohibition-probe disposition: judgment is never silently green (WR-01 / ADR-550 D4)', () => {
  const evidence = { enforcementEvidence: ['a wired negative test reference'] };

  test('a judgment-tier item with enforcement evidence is NEVER a silent green', () => {
    const pc = require(PROBE_CORE_LIB);
    const judgment = { status: 'resolved', verification: 'judgment', statement: 'MUST NOT shame the user' };

    const disposition = pc.dispositionForProhibition(judgment, evidence);
    assert.notEqual(disposition.status, 'green',
      'a judgment-tier prohibition can never be green from the deterministic helper — it routes to judgment review (ADR-550 D4)');
    assert.equal(disposition.flagged, true,
      'a judgment-tier prohibition with evidence must still be flagged for judgment review');
  });

  test('no-evidence items stay fail-closed for both tiers', () => {
    const pc = require(PROBE_CORE_LIB);
    for (const tier of ['test', 'judgment']) {
      const d = pc.dispositionForProhibition({ status: 'resolved', verification: tier, statement: 'x' }, { enforcementEvidence: [] });
      assert.notEqual(d.status, 'green', `${tier}-tier with no evidence must be fail-closed (never green)`);
      assert.equal(d.flagged, true, `${tier}-tier with no evidence must be flagged`);
    }
  });
});

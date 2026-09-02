'use strict';

/**
 * Property-based tests for normalizePhaseReqIds range expansion (#1269) and
 * post-expand ID-shape filtering (#3189).
 *
 * Module: gsd-core/bin/lib/gap-checker.cjs
 * Exported: normalizePhaseReqIds(rawVal)
 *
 * Range form (#1269): a `--phase-req-ids` list element of the shape
 * `<PREFIX>-NN..<PREFIX>-MM` (identical prefix both sides, identical bound digit
 * width, ascending numeric NN ≤ MM) expands in place to the individual IDs,
 * preserving the bounds' zero-pad width; ambiguous/invalid ranges stay literal
 * (fail-closed) — and are then dropped by the post-expand shape filter (#3189),
 * because they contain `.`/`..` and so cannot be requirement IDs.
 *
 * ID-shape filter (#3189): STRICTLY AFTER range expansion, every token is
 * filtered through `PHASE_REQ_ID_SHAPE_RE` (`/^(?=.*\d)[A-Z][A-Z0-9]*(?:[-_][A-Za-z0-9]+)*$/`).
 * Tokens that cannot be requirement IDs (prose, punctuation, dates, invalid
 * range tokens left literal by expandPhaseReqIdToken) are dropped; an input
 * whose every token is dropped collapses to `null`.
 *
 * Properties tested:
 *   (a) valid ascending same-prefix, same-width range → length == MM-NN+1, all
 *       elements share the prefix, suffixes are strictly monotonic NN..MM,
 *       width preserved — and every expanded ID survives the shape filter
 *   (b) NN == MM → single-element expansion equal to the (re-padded) bound
 *   (c) literal preservation: a non-range token round-trips unchanged
 *   (d) descending range → dropped by the shape filter (returns null)
 *   (d2) mismatched-prefix range → dropped by the shape filter (returns null)
 *   (d3) differing-width bounds → dropped by the shape filter (returns null)
 *   (d4) non-numeric bounds → dropped by the shape filter (returns null)
 *   (d5) missing left/right bound → dropped by the shape filter (returns null)
 *   (d6) multi-dot tokens → dropped by the shape filter (returns null)
 *   (e) never throws on arbitrary string input
 *
 * Lives in a sibling *.property.test.cjs file (the established property-test
 * convention). Its effective prefix `gap-checker.property` does not match the
 * `gap-checker` production prefix, so it does not count against the per-module
 * test-file cap; the unit/integration fixtures are folded into
 * bug-447-gap-analysis-phase-req-ids.test.cjs instead.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { normalizePhaseReqIds } = require('../gsd-core/bin/lib/gap-checker.cjs');

// A safe prefix that always ends in '-', contains no whitespace, commas,
// brackets, quotes, parens, or dots (those are stripped/split by the
// normalizer), and never collides with the null/TBD/none sentinels.
//
// #3189: leading char MUST be uppercase and the rest uppercase-or-digit, to
// match `PHASE_REQ_ID_SHAPE_RE`'s `[A-Z][A-Z0-9]*` prefix portion. A
// lowercase-leading prefix (e.g. `a-`) would produce IDs the shape filter
// rejects, so properties (a)/(b)/(c) — which assert the expanded IDs survive —
// would fail for the wrong reason. The realistic requirement-ID format is
// uppercase-leading anyway (`REQ-`, `SEL-`, `R1`).
const prefixArb = fc
  .stringMatching(/^[A-Z][A-Z0-9]{0,5}$/)
  .filter(s => !/^(null|tbd|none)$/i.test(s))
  .map(s => `${s}-`);

const widthArb = fc.integer({ min: 1, max: 4 });

function pad(n, width) {
  return String(n).padStart(width, '0');
}

describe('#1269 normalizePhaseReqIds — range expansion properties', () => {
  test('(a) valid ascending same-prefix, same-width range expands to MM-NN+1 monotonic same-prefix IDs', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      widthArb,
      (prefix, a, b, w) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        // Both bounds share width w; choose w wide enough to hold hi so neither
        // bound is truncated and both render at the SAME digit width.
        const width = Math.max(w, String(hi).length);
        const loStr = pad(lo, width);
        const hiStr = pad(hi, width);
        const token = `${prefix}${loStr}..${prefix}${hiStr}`;

        const result = normalizePhaseReqIds(token);

        // length == MM - NN + 1
        assert.strictEqual(result.length, hi - lo + 1, `length for ${token}`);
        // all elements share the prefix
        for (const id of result) {
          assert.ok(id.startsWith(prefix), `${id} must start with ${prefix}`);
        }
        // suffixes are strictly monotonic NN..MM, each padded to the shared width
        result.forEach((id, i) => {
          const expectedNum = lo + i;
          assert.strictEqual(id, `${prefix}${pad(expectedNum, width)}`,
            `element ${i} of ${token}`);
        });
      },
    ));
  });

  test('(d3) differing-width bounds are dropped by the shape filter (#3189 — expandPhaseReqIdToken still fails closed, then the literal token is filtered)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      widthArb,
      widthArb,
      (prefix, a, b, wA, wB) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const loStr = pad(lo, wA);
        const hiStr = pad(hi, wB);
        // Only exercise the differing-width case here.
        fc.pre(loStr.length !== hiStr.length);
        const token = `${prefix}${loStr}..${prefix}${hiStr}`;
        // expandPhaseReqIdToken returns [token] (fail-closed on differing
        // width); the token contains `..`, so #3189's shape filter drops it
        // and normalizePhaseReqIds collapses to null.
        assert.strictEqual(normalizePhaseReqIds(token), null);
      },
    ));
  });

  test('(d4) non-numeric bounds are dropped by the shape filter (#3189)', () => {
    fc.assert(fc.property(
      prefixArb,
      // A suffix containing at least one non-digit so the bound is non-numeric.
      fc.stringMatching(/^[0-9]*[A-Za-z][0-9A-Za-z]*$/),
      fc.stringMatching(/^[0-9]*[A-Za-z][0-9A-Za-z]*$/),
      (prefix, sLo, sHi) => {
        const token = `${prefix}${sLo}..${prefix}${sHi}`;
        // expandPhaseReqIdToken fails closed (returns [token]); #3189's filter
        // then drops the literal token (contains `..`).
        assert.strictEqual(normalizePhaseReqIds(token), null);
      },
    ));
  });

  test('(d5) missing left or right bound is dropped by the shape filter (#3189)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 99 }),
      widthArb,
      fc.boolean(),
      (prefix, n, w, dropLeft) => {
        const bound = `${prefix}${pad(n, w)}`;
        const token = dropLeft ? `..${bound}` : `${bound}..`;
        // expandPhaseReqIdToken fails closed (returns [token]); #3189's filter
        // then drops the literal token (contains `..`).
        assert.strictEqual(normalizePhaseReqIds(token), null);
      },
    ));
  });

  test('(d6) multi-dot tokens are dropped by the shape filter (#3189)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      widthArb,
      (prefix, a, b, c, w) => {
        const token = `${prefix}${pad(a, w)}..${prefix}${pad(b, w)}..${prefix}${pad(c, w)}`;
        // expandPhaseReqIdToken fails closed (returns [token]); #3189's filter
        // then drops the literal token (contains `..`).
        assert.strictEqual(normalizePhaseReqIds(token), null);
      },
    ));
  });

  test('(b) NN == MM expands to a single re-padded bound', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 99 }),
      widthArb,
      (prefix, n, w) => {
        const nStr = pad(n, w);
        const token = `${prefix}${nStr}..${prefix}${nStr}`;
        const result = normalizePhaseReqIds(token);
        // Expected width is nStr.length, not w: when n has more digits than w
        // (e.g. n=99, w=1), pad() returns the un-truncated "99", so the emitted
        // ID preserves the bound's actual width — which is what the range parser does.
        assert.deepStrictEqual(result, [`${prefix}${pad(n, nStr.length)}`]);
      },
    ));
  });

  test('(c) a non-range single token round-trips unchanged (literal preservation)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 999 }),
      widthArb,
      (prefix, n, w) => {
        const id = `${prefix}${pad(n, w)}`; // a plain ID, no '..'
        assert.deepStrictEqual(normalizePhaseReqIds(id), [id]);
      },
    ));
  });

  test('(d) descending range is dropped by the shape filter (#3189 — expandPhaseReqIdToken still fails closed, then the literal token is filtered)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 1, max: 50 }),
      fc.integer({ min: 1, max: 50 }),
      widthArb,
      (prefix, a, b, w) => {
        fc.pre(a !== b);
        const hi = Math.max(a, b);
        const lo = Math.min(a, b);
        // Deliberately put the larger bound first → descending → expandPhaseReqIdToken
        // returns [token] (fail-closed); the token contains `..`, so #3189's
        // shape filter drops it and normalizePhaseReqIds collapses to null.
        const token = `${prefix}${pad(hi, w)}..${prefix}${pad(lo, w)}`;
        assert.strictEqual(normalizePhaseReqIds(token), null);
      },
    ));
  });

  test('(d2) mismatched-prefix range is dropped by the shape filter (#3189)', () => {
    fc.assert(fc.property(
      prefixArb,
      prefixArb,
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      widthArb,
      (p1, p2, a, b, w) => {
        fc.pre(p1 !== p2);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const token = `${p1}${pad(lo, w)}..${p2}${pad(hi, w)}`;
        // expandPhaseReqIdToken fails closed (returns [token]); #3189's filter
        // then drops the literal token (contains `..`).
        assert.strictEqual(normalizePhaseReqIds(token), null);
      },
    ));
  });

  test('(e) never throws on arbitrary string input', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      // Either a valid normalized value or null — but never an exception.
      assert.doesNotThrow(() => normalizePhaseReqIds(s));
    }));
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-447-gap-analysis-phase-req-ids.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-447-gap-analysis-phase-req-ids (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Bug #447: plan-phase §13e gap-analysis ignores phase_req_ids → false-positive
 * coverage gaps.
 *
 * Root cause: runGapAnalysis() diffs the ENTIRE REQUIREMENTS.md against the
 * phase's plans, with no awareness of phase_req_ids. §13 (Requirements Coverage
 * Gate) skips when phase_req_ids is null/TBD, but §13e never inherited that
 * scoping contract — so a phase that maps no requirements reports every
 * unrelated project REQ-ID as "Not covered".
 *
 * Fix: teach the gap-analysis CLI a --phase-req-ids option (the durable home for
 * the scoping contract), mirroring §13:
 *   - null / TBD / empty  → skip the REQUIREMENTS.md comparison entirely
 *                           (CONTEXT.md decisions are still reported).
 *   - explicit ID list    → restrict the comparison to those IDs.
 *   - flag absent         → backward-compatible (compare the whole file).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { normalizePhaseReqIds } = require('../gsd-core/bin/lib/gap-checker.cjs');

describe('gap-analysis --phase-req-ids scoping (#447)', () => {
  let tmpDir;
  let phaseDir;

  function writeRequirements(ids) {
    const lines = ids.map((id, i) => `- [ ] **${id}** Requirement ${i + 1} description`);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n${lines.join('\n')}\n`);
  }

  function writeContext(decisions) {
    const dLines = decisions.map(d => `- **${d.id}:** ${d.text}`).join('\n');
    fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'),
      `# Phase Context\n\n<decisions>\n## Implementation Decisions\n\n${dLines}\n</decisions>\n`);
  }

  function writePlan(name, body) {
    fs.writeFileSync(path.join(phaseDir, `${name}-PLAN.md`), body);
  }

  function reqRows(out) {
    return out.rows.filter(r => r.source === 'REQUIREMENTS.md').map(r => r.item);
  }

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const r = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(r.success, `config-ensure-section failed: ${r.error}`);
  });

  afterEach(() => cleanup(tmpDir));

  // ── The core bug ─────────────────────────────────────────────────────────────

  test('phase mapping no REQs (--phase-req-ids TBD) reports zero REQUIREMENTS.md rows', () => {
    // A REQUIREMENTS.md full of IDs that belong to OTHER phases/milestones.
    writeRequirements(['BACK-01', 'WEB-03', 'API-07', 'DATA-02']);
    writePlan('01', '# Plan 1\n\nStandalone phase, maps no project requirements.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'TBD'], tmpDir);
    assert.ok(r.success, `gap-analysis failed: ${r.error}`);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out), [],
      'a phase that maps no REQ-IDs must not report unrelated project requirements as gaps');
    assert.strictEqual(out.counts.uncovered, 0,
      'no false-positive "not covered" rows for an unmapped phase');
  });

  test('--phase-req-ids null behaves the same as TBD (skip requirements)', () => {
    writeRequirements(['BACK-01', 'WEB-03']);
    writePlan('01', '# Plan\n\nNo mapped reqs.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'null'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out), []);
  });

  // ── Scoped to a mapped subset ────────────────────────────────────────────────

  test('explicit ID list restricts the comparison to those REQ-IDs', () => {
    writeRequirements(['REQ-01', 'REQ-02', 'REQ-03']);
    // Plan covers REQ-01 only; REQ-02 is mapped to the phase but not yet addressed.
    writePlan('01', '# Plan\n\nImplements REQ-01 only.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'REQ-01,REQ-02'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-02'],
      'only the phase-mapped REQ-IDs are considered; REQ-03 (another phase) is excluded');
    const req01 = out.rows.find(x => x.item === 'REQ-01');
    const req02 = out.rows.find(x => x.item === 'REQ-02');
    assert.strictEqual(req01.status, 'Covered');
    assert.strictEqual(req02.status, 'Not covered');
  });

  test('JSON-array-ish value (["REQ-01"]) is tolerated and scoped', () => {
    writeRequirements(['REQ-01', 'REQ-02']);
    writePlan('01', '# Plan\n\nImplements REQ-01.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', '["REQ-01"]'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out), ['REQ-01']);
  });

  // ── CONTEXT.md decisions are unaffected by req scoping ───────────────────────

  test('CONTEXT.md decisions are still reported when requirements are skipped', () => {
    writeRequirements(['BACK-01', 'WEB-03']);
    writeContext([{ id: 'D-01', text: 'Use a local notification daemon' }]);
    writePlan('01', '# Plan\n\nUnrelated work, no decisions addressed.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'TBD'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out), [], 'requirements skipped');
    const d01 = out.rows.find(x => x.item === 'D-01');
    assert.ok(d01, 'CONTEXT.md decision D-01 must still be reported');
    assert.strictEqual(d01.source, 'CONTEXT.md');
    assert.strictEqual(d01.status, 'Not covered');
  });

  // ── Parser robustness (workflow passes the roadmap value verbatim) ───────────

  test('whitespace/newline-separated IDs are tolerated and scoped', () => {
    writeRequirements(['REQ-01', 'REQ-02', 'REQ-03']);
    writePlan('01', '# Plan\n\nImplements the first one.\n');
    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'REQ-01 REQ-02\nREQ-03'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-02', 'REQ-03']);
  });

  // ── Backward compatibility ───────────────────────────────────────────────────

  test('flag absent → whole REQUIREMENTS.md is compared (unchanged behavior)', () => {
    writeRequirements(['REQ-01', 'REQ-02']);
    writePlan('01', '# Plan\n\nImplements REQ-01 only.\n');

    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-02'],
      'with no --phase-req-ids, all requirements are still reported (back-compat)');
  });

  // ── §13e wiring: init.plan-phase --pick phase_req_ids → gap-analysis ─────────
  // Guards the exact query the workflow uses. `roadmap.get-phase` returns raw
  // phase TEXT (not JSON), so --pick yields nothing there; the scoping value
  // must come from `init.plan-phase`. This test would have caught using the
  // wrong query (which silently skips requirements for every phase).

  function writeRoadmap(reqLine) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 1: Test Phase\n**Goal:** Do the thing\n${reqLine}**Success Criteria:**\n- It works\n`);
  }

  test('init.plan-phase --pick phase_req_ids exposes the mapped IDs, and gap-analysis scopes to them', () => {
    writeRoadmap('**Requirements:** REQ-01, REQ-02\n');
    writeRequirements(['REQ-01', 'REQ-02', 'REQ-03']);
    writePlan('01', '# Plan\n\nImplements the first requirement only.\n');

    const q = runGsdTools(['query', 'init.plan-phase', '1', '--pick', 'phase_req_ids'], tmpDir);
    assert.ok(q.success, `init.plan-phase query failed: ${q.error}`);
    const ids = q.output.trim();
    assert.match(ids, /REQ-01/, 'init.plan-phase must expose phase_req_ids (roadmap.get-phase does NOT)');

    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', ids], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-02'],
      'gap report is scoped to the phase-mapped IDs; REQ-03 (another phase) is excluded');
  });

  test('mapped REQ-ID absent from REQUIREMENTS.md appears as "Missing" row, not silently dropped', () => {
    writeRequirements(['REQ-01']);
    writePlan('01', '# Plan\n\nImplements REQ-01.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'REQ-01,REQ-99'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-99'],
      'REQ-99 (absent from REQUIREMENTS.md) must be present in the report, not silently dropped');
    const req99 = out.rows.find(x => x.item === 'REQ-99');
    assert.ok(req99, 'missing mapped ID must have an output row');
    assert.strictEqual(req99.status, 'Missing from REQUIREMENTS.md');
    assert.ok(out.counts.uncovered > 0, 'uncovered count must reflect the missing mapped ID');
  });

  test('phase with no Requirements line → init.plan-phase yields empty → gap-analysis skips requirements', () => {
    writeRoadmap(''); // no **Requirements:** line
    writeRequirements(['REQ-01', 'REQ-02']);
    writePlan('01', '# Plan\n\nStandalone phase.\n');

    const q = runGsdTools(['query', 'init.plan-phase', '1', '--pick', 'phase_req_ids'], tmpDir);
    assert.ok(q.success, q.error);
    const ids = q.output.trim(); // expected empty

    // The workflow passes the (possibly empty) value through verbatim.
    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', ids], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out), [],
      'an unmapped phase reports no requirement gaps (the original #447 bug)');
  });
});

/**
 * #1269: `--phase-req-ids` range syntax (`<PREFIX>-NN..<PREFIX>-MM`) was treated
 * as a literal ID, so a mapped range was reported as a coverage gap even when the
 * individual IDs existed. normalizePhaseReqIds now expands a valid ascending
 * same-prefix numeric range in place (preserving zero-pad width), and leaves any
 * ambiguous/invalid range literal (fail-closed). #3189 subsequently added a
 * post-expand shape filter that DROPS those left-literal invalid-range tokens
 * (they contain `..` and so cannot be requirement IDs) — the AC4 fixtures below
 * were updated to assert the dropped behaviour. expandPhaseReqIdToken's internal
 * fail-closed branch is unchanged. These unit fixtures are folded here (the
 * owning home for --phase-req-ids behavior) rather than a new bug-NNNN-* file,
 * per the regression-test-placement policy.
 */
describe('#1269 — normalizePhaseReqIds range expansion', () => {
  // ── The core bug: a range token must expand, not stay literal ────────────────

  test('AC1: range + single ID expands in input order (was the literal-token bug)', () => {
    // Pre-fix this returned ['SEL-01..SEL-03','TEST-01'] — the unexpanded range.
    assert.deepStrictEqual(
      normalizePhaseReqIds('SEL-01..SEL-03,TEST-01'),
      ['SEL-01', 'SEL-02', 'SEL-03', 'TEST-01'],
      'a same-prefix ascending range must expand in place, preserving list order');
  });

  test('AC2: zero-pad width is preserved across the expansion', () => {
    assert.deepStrictEqual(
      normalizePhaseReqIds('PREFIX-001..PREFIX-003'),
      ['PREFIX-001', 'PREFIX-002', 'PREFIX-003']);
  });

  // ── AC3: existing behavior is unchanged ──────────────────────────────────────

  test('AC3: single-ID, comma/space/newline, and JSON-array-ish inputs unchanged', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01'), ['REQ-01']);
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01,REQ-02'), ['REQ-01', 'REQ-02']);
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01 REQ-02'), ['REQ-01', 'REQ-02']);
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01\nREQ-02'), ['REQ-01', 'REQ-02']);
    assert.deepStrictEqual(normalizePhaseReqIds(['REQ-01', 'REQ-02']), ['REQ-01', 'REQ-02']);
    assert.strictEqual(normalizePhaseReqIds(undefined), undefined);
    assert.strictEqual(normalizePhaseReqIds(null), null);
    assert.strictEqual(normalizePhaseReqIds('TBD'), null);
    assert.strictEqual(normalizePhaseReqIds(''), null);
  });

  // ── AC4: invalid/ambiguous ranges — expandPhaseReqIdToken still fails closed
  //    (returns the token literal), but #3189's post-expand shape filter then
  //    DROPS that literal token (it contains `.`/`..`, so it cannot be a
  //    requirement ID). The token is no longer surfaced as a fake missing
  //    requirement — it is silently dropped, and an all-invalid input collapses
  //    to null (skip semantics). expandPhaseReqIdToken's internal fail-closed
  //    branch is unchanged; this assertion verifies the composition.

  test('AC4: mismatched-prefix range is dropped (#3189 — was: stayed literal)', () => {
    assert.strictEqual(normalizePhaseReqIds('SEL-01..TEST-03'), null);
  });

  test('AC4: descending range is dropped (#3189 — was: stayed literal)', () => {
    assert.strictEqual(normalizePhaseReqIds('SEL-03..SEL-01'), null);
  });

  test('AC4: non-numeric bound is dropped (#3189 — was: stayed literal)', () => {
    assert.strictEqual(normalizePhaseReqIds('SEL-0A..SEL-0C'), null);
  });

  test('AC4: missing bound is dropped (#3189 — was: stayed literal)', () => {
    assert.strictEqual(normalizePhaseReqIds('SEL-01..'), null);
    assert.strictEqual(normalizePhaseReqIds('..SEL-03'), null);
  });

  test('AC4: an invalid range inside a mixed list is dropped while valid ones expand (#3189)', () => {
    // SEL-01..SEL-03 expands (valid); BAD-3..BAD-1 fails-closed literal then is
    // dropped by the shape filter. The valid expansions are preserved in order.
    assert.deepStrictEqual(
      normalizePhaseReqIds('SEL-01..SEL-03,BAD-3..BAD-1'),
      ['SEL-01', 'SEL-02', 'SEL-03']);
  });

  // ── Boundary fixtures ────────────────────────────────────────────────────────

  test('boundary: single-element range (NN == MM)', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('SEL-02..SEL-02'), ['SEL-02']);
  });

  test('boundary: two-element range (NN == MM-1)', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('SEL-01..SEL-02'), ['SEL-01', 'SEL-02']);
  });

  test('boundary: differing zero-pad widths are dropped (#3189 — was: stayed literal)', () => {
    // Bounds of differing digit width are ambiguous: padding 'SEL-9' to width 2
    // would invent 'SEL-09', which may never appear unpadded in REQUIREMENTS.
    // expandPhaseReqIdToken fails closed (returns the token literal); #3189's
    // shape filter then drops the literal token (contains `..`).
    assert.strictEqual(normalizePhaseReqIds('SEL-9..SEL-11'), null);
  });

  test('AC4: a range exceeding MAX_PHASE_REQ_RANGE is dropped (#3189 — DoS guard still fires, then shape filter drops the literal)', () => {
    // Same-width bounds (both 4 digits) so the differing-width guard does NOT fire
    // first; span = 1001 - 1 + 1 = 1001 > MAX_PHASE_REQ_RANGE (1000) → the DoS cap
    // is what keeps this literal. Isolates the cap branch from the width check.
    // #3189's shape filter then drops the literal token (contains `..`).
    assert.strictEqual(normalizePhaseReqIds('REQ-0001..REQ-1001'), null);
  });

  test('multi-segment prefix with digits is handled (prefix compared verbatim)', () => {
    assert.deepStrictEqual(
      normalizePhaseReqIds('REQ2-01..REQ2-03'),
      ['REQ2-01', 'REQ2-02', 'REQ2-03']);
  });
});

/**
 * #1269 integration (AC5): the gap-analysis CLI must not flag a mapped range —
 * or the IDs it expands to — as missing when those IDs exist in REQUIREMENTS.md.
 */
describe('#1269 — gap-analysis --phase-req-ids range (integration)', () => {
  let tmpDir;
  let phaseDir;

  function writeRequirements(ids) {
    const lines = ids.map((id, i) => `- [ ] **${id}** Requirement ${i + 1} description`);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n${lines.join('\n')}\n`);
  }
  function writePlan(name, body) {
    fs.writeFileSync(path.join(phaseDir, `${name}-PLAN.md`), body);
  }
  function reqRows(out) {
    return out.rows.filter(r => r.source === 'REQUIREMENTS.md').map(r => r.item);
  }

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const r = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(r.success, `config-ensure-section failed: ${r.error}`);
  });

  afterEach(() => cleanup(tmpDir));

  test('AC5: a mapped range is expanded and not flagged as missing when the IDs exist', () => {
    writeRequirements(['SEL-01', 'SEL-02', 'SEL-03', 'TEST-01', 'OTHER-09']);
    // The plan addresses each expanded SEL id and TEST-01.
    writePlan('01', '# Plan\n\nImplements SEL-01, SEL-02, SEL-03, and TEST-01.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'SEL-01..SEL-03,TEST-01'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out).sort(), ['SEL-01', 'SEL-02', 'SEL-03', 'TEST-01'],
      'the range expands to individual SEL IDs; the literal range token must NOT appear, and OTHER-09 (unmapped) is excluded');
    // The literal range token must never surface as a missing row.
    assert.ok(!out.rows.some(x => x.item.includes('..')),
      'no range-literal row (e.g. "SEL-01..SEL-03") may be reported');
    assert.strictEqual(out.counts.uncovered, 0,
      'all expanded IDs exist in REQUIREMENTS.md and are covered — zero gaps');
  });
});
  });
}

// ─── #3189: normalizePhaseReqIds ID-shape filter (post-expand) ────────────────
//
// ROADMAP `**Requirements:**` lines routinely carry prose trailing the real ID
// list (locked-decision annotations, ambiguity scores, prohibitions, dates).
// The function's own contract says callers may pass that roadmap value through
// verbatim, but the whitespace split + range expansion alone let every prose
// word through as a "missing requirement", drowning the real coverage signal
// (8 real gaps became 21 reported in the issue's reproduction).
//
// #3189 adds a shape filter (`PHASE_REQ_ID_SHAPE_RE`) STRICTLY AFTER range
// expansion so:
//   - real IDs survive (both hyphen-less `R1` and prefix-hyphen `SEL-01`);
//   - prose / punctuation / dates / invalid range tokens are dropped;
//   - an all-dropped input collapses to `null` (skip semantics);
//   - valid range expansion still works (filter is post-expand, so
//     `SEL-01..SEL-03` expands first, then each expanded ID passes the filter).
//
// These are the unit-level fixtures; the end-to-end CLI reproduction lives in
// tests/check-gap-analysis-plan-post-e2e.test.cjs.

describe('#3189 — normalizePhaseReqIds drops non-ID prose after range expansion', () => {
  // ── AC1: prose trailing a real ID list — only ID-shaped tokens survive ──────

  test('AC1 (issue repro): prose-annotated Requirements value yields only the ID-shaped tokens', () => {
    // The exact reproduction string from the issue. After bracket/paren strip,
    // whitespace split, range expansion, and the #3189 shape filter, only the
    // ID-shaped tokens survive: R1..R8 plus `P1-P3`. Every prose fragment
    // (locked, <date>, —, canonical, source, `NN-SPEC.md, ##, Requirements;,
    // ambiguity, 0.12;, +, prohibitions) is dropped.
    //
    // `P1-P3` (from "prohibitions P1-P3") SURVIVES because it is syntactically
    // ID-shaped: it matches `PHASE_REQ_ID_SHAPE_RE` exactly the way `SEL-01`
    // does, and the issue's own note 1 lists `P1-P3` alongside `R1` and
    // `SEL-01` as an example of a real requirement ID that carries a digit. It
    // is consistent with the codebase's `ID_PATTERN` (`[A-Z][A-Z0-9]*-[A-Za-z0-9_-]+`),
    // which ALSO accepts `P1-P3` — so a `P1-P3` requirement parsed from
    // REQUIREMENTS.md would be a valid ID, and dropping the same token here
    // would create a false mismatch. The 8 R-IDs are the "actual" requirement
    // IDs in the issue's REQUIREMENTS.md; `P1-P3` is an additional ID-shaped
    // token that the filter (correctly) cannot distinguish from a real ID
    // without semantic context.
    const raw = 'R1, R2, R3, R4, R5, R6, R7, R8 (locked <date> — canonical source `NN-SPEC.md ## Requirements`; ambiguity 0.12; + prohibitions P1-P3)';
    assert.deepStrictEqual(
      normalizePhaseReqIds(raw),
      ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'P1-P3'],
      'only ID-shaped tokens survive; every prose fragment is dropped');
  });

  test('AC1: every prose fragment named in the issue is dropped (no prose reaches the comparison)', () => {
    const raw = 'R1, R2, R3, R4, R5, R6, R7, R8 (locked <date> — canonical source `NN-SPEC.md ## Requirements`; ambiguity 0.12; + prohibitions P1-P3)';
    const result = normalizePhaseReqIds(raw);
    // These are the exact fragments the issue reported as fake "missing
    // requirements" — none may survive the shape filter.
    const droppedProse = [
      'locked', '<date>', '—', 'canonical', 'source', '`NN-SPEC.md',
      '##', 'Requirements;', 'ambiguity', '0.12;', '+', 'prohibitions',
    ];
    for (const frag of droppedProse) {
      assert.ok(!result.includes(frag),
        `prose fragment ${JSON.stringify(frag)} must be dropped, but it survived in ${JSON.stringify(result)}`);
    }
  });

  test('AC1: em-dash, markdown heading marker, bare +, version-like 0.12; and <date> are all dropped', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01 — ## + 0.12; <date>'), ['REQ-01']);
  });

  test('AC1: backtick filename fragment and trailing prose are dropped', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01 `NN-SPEC.md` canonical source'), ['REQ-01']);
  });

  // ── AC2: a pure-prose caps token with no digit is dropped ───────────────────
  //
  // The digit lookahead `(?=.*\d)` in PHASE_REQ_ID_SHAPE_RE is load-bearing:
  // without it ALL-CAPS prose tokens that appear in annotations (LOCKED, NONE,
  // TBD-as-prose) would pass the shape and still reach the report as fake IDs.

  test('AC2: a pure-prose caps token with no digit is dropped (digit lookahead is load-bearing)', () => {
    assert.strictEqual(normalizePhaseReqIds('LOCKED'), null);
    assert.strictEqual(normalizePhaseReqIds('PROSE'), null);
  });

  test('AC2: a pure-prose caps token mixed with real IDs is dropped, real IDs survive', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01 LOCKED REQ-02'), ['REQ-01', 'REQ-02']);
  });

  // ── Edge case: ID-shaped prose tokens survive (filter is syntactic, not semantic) ─
  //
  // `P1-P3` (from "prohibitions P1-P3") is syntactically indistinguishable from
  // a real requirement ID — it matches `PHASE_REQ_ID_SHAPE_RE` exactly as
  // `SEL-01` does, and the codebase's own `ID_PATTERN` (`[A-Z][A-Z0-9]*-[A-Za-z0-9_-]+`)
  // accepts it too. The filter is purely syntactic: it cannot know from shape
  // alone that this particular `P1-P3` was prose describing a prohibition range
  // rather than a real requirement ID. The issue's note 1 explicitly groups
  // `P1-P3` with `R1` and `SEL-01` as a real-ID shape. Keeping it is consistent
  // with how REQUIREMENTS.md parsing treats the same token; dropping it would
  // create a false mismatch for any project that legitimately uses `P1-P3`-shaped
  // IDs. Tightening the filter to reject this shape is a separate decision
  // (would need a semantic signal the filter does not have).

  test('edge: an ID-shaped prose token (P1-P3) survives the syntactic filter, consistent with ID_PATTERN', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('P1-P3'), ['P1-P3']);
    // And it does NOT collapse a mixed list to null — real IDs alongside it survive.
    assert.deepStrictEqual(normalizePhaseReqIds('R1 P1-P3 R8'), ['R1', 'P1-P3', 'R8']);
  });

  // ── AC3: range + trailing prose — expand THEN filter ────────────────────────
  //
  // Filter ordering is load-bearing: filtering BEFORE expandPhaseReqIdToken
  // would discard the range token itself (`SEL-01..SEL-03` matches no single-ID
  // shape), silently undoing #1269 / #1419.

  test('AC3: range followed by trailing prose still expands, then the prose is dropped', () => {
    assert.deepStrictEqual(
      normalizePhaseReqIds('SEL-01..SEL-03 (locked <date>)'),
      ['SEL-01', 'SEL-02', 'SEL-03']);
  });

  test('AC3: range + single ID + trailing prose preserves order, drops prose', () => {
    assert.deepStrictEqual(
      normalizePhaseReqIds('SEL-01..SEL-03, TEST-01 (notes: locked)'),
      ['SEL-01', 'SEL-02', 'SEL-03', 'TEST-01']);
  });

  // ── AC4: empty/null/tbd/none sentinel skip behavior is unchanged ────────────

  test('AC4: undefined / null / empty / tbd / none sentinel skip behavior is unchanged', () => {
    assert.strictEqual(normalizePhaseReqIds(undefined), undefined);
    assert.strictEqual(normalizePhaseReqIds(null), null);
    assert.strictEqual(normalizePhaseReqIds(''), null);
    assert.strictEqual(normalizePhaseReqIds('TBD'), null);
    assert.strictEqual(normalizePhaseReqIds('tbd'), null);
    assert.strictEqual(normalizePhaseReqIds('none'), null);
    assert.strictEqual(normalizePhaseReqIds('NONE'), null);
  });

  test('AC4: an all-prose input (every token dropped) collapses to null (skip semantics)', () => {
    assert.strictEqual(normalizePhaseReqIds('locked <date> — ambiguity 0.12; prohibitions'), null);
  });

  // ── AC5: real coverage detection is NOT narrowed ────────────────────────────
  //
  // A genuinely-missing requirement ID (no prose involved) must still be
  // returned so the caller can report it as "Missing from REQUIREMENTS.md".

  test('AC5: a genuinely-missing requirement ID is still returned (no narrowing)', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01,REQ-99'), ['REQ-01', 'REQ-99']);
  });

  test('AC5 (backstop): hyphen-less digit-bearing IDs (R-family) are preserved', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('R1,R8'), ['R1', 'R8']);
  });

  test('AC5 (backstop): prefix-hyphen IDs and multi-segment-prefix IDs are preserved', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('SEL-01,REQ-02'), ['SEL-01', 'REQ-02']);
    assert.deepStrictEqual(
      normalizePhaseReqIds('REQ2-01..REQ2-03'),
      ['REQ2-01', 'REQ2-02', 'REQ2-03']);
  });

  // ── AC5 (backstop): existing input shapes that already worked are unchanged ─

  test('AC5 (backstop): comma/space/newline/JSON-array-ish inputs unchanged for real IDs', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01,REQ-02'), ['REQ-01', 'REQ-02']);
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01 REQ-02'), ['REQ-01', 'REQ-02']);
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01\nREQ-02'), ['REQ-01', 'REQ-02']);
    assert.deepStrictEqual(normalizePhaseReqIds(['REQ-01', 'REQ-02']), ['REQ-01', 'REQ-02']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3885 (ADR-3473 §8.5) / item 5 — runGapAnalysis's phase-directory readdirSync
// swallows an unreadable directory into the same `[]` a genuinely absent one
// produces (src/gap-checker.cts, runGapAnalysis):
//   try { if (fs.existsSync(absPhaseDir)) phaseDirFiles = fs.readdirSync(absPhaseDir); }
//   catch { /* unreadable */ }
// The existsSync guard means a caught error here is NEVER ENOENT-shaped
// absence — the directory exists, so any readdirSync failure (EACCES, EIO,
// ...) must be named, not folded into the same result a phase with a
// genuinely context-less/plan-less directory produces.
//
// `runGapAnalysis` gains `phase_dir_read_error: string | null` — null on a
// successful read (this is the ONLY branch reachable, since an ABSENT
// directory never reaches readdirSync at all, per the existsSync guard), and
// a message naming the phase directory on any other readdirSync failure.
// `runGapAnalysis` is exported directly (see decisions.test.cjs's identical
// direct-call style for the same function), so these drive it in-process.
// Injected via monkeypatching `fs.readdirSync` (t.mock.method, auto-restored
// per test) — NEVER chmod 0o000, which root bypasses with zero coverage.
describe('#3885 (ADR-3473 §8.5): runGapAnalysis distinguishes unreadable from absent (gap-checker.cts caller)', () => {
  const fs = require('fs');
  const path = require('path');
  const { createTempProject, cleanup } = require('./helpers.cjs');
  const { runGapAnalysis } = require('../gsd-core/bin/lib/gap-checker.cjs');

  let tmpDir;
  let phaseDir;

  function setup() {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan\nSome plan text.\n');
  }

  function injectReaddirFailure(t, targetPath, code) {
    const resolved = path.resolve(targetPath);
    const origReaddirSync = fs.readdirSync.bind(fs);
    t.mock.method(fs, 'readdirSync', (p, ...rest) => {
      if (path.resolve(String(p)) === resolved) {
        const err = new Error(`${code}: simulated failure, scandir '${p}'`);
        err.code = code;
        throw err;
      }
      return origReaddirSync(p, ...rest);
    });
  }

  test('readablePhaseDirWithoutContextReportsNoReadError (MUST STAY GREEN)', () => {
    setup();
    try {
      const result = runGapAnalysis(tmpDir, phaseDir);
      assert.strictEqual(result.phase_dir_read_error ?? null, null,
        'a readable phase directory must report no read error');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('unreadablePhaseDirIsNotReportedAsAbsent', (t) => {
    setup();
    try {
      injectReaddirFailure(t, phaseDir, 'EACCES');
      const result = runGapAnalysis(tmpDir, phaseDir);
      assert.strictEqual(typeof result.phase_dir_read_error, 'string',
        `an unreadable phase directory must be reported as an error, not silently absent; got: ${JSON.stringify(result.phase_dir_read_error)}`);
      assert.ok(result.phase_dir_read_error.includes('03-api'),
        `the reported error must name the discarded input (the phase directory); got: ${result.phase_dir_read_error}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('missingPhaseDirStaysAbsentNotAnError (MUST STAY GREEN)', () => {
    tmpDir = createTempProject();
    const missingPhaseDir = path.join(tmpDir, '.planning', 'phases', '09-nonexistent');
    try {
      // Genuinely absent — never created — so `fs.existsSync` short-circuits
      // before readdirSync is ever attempted; no patch needed.
      const result = runGapAnalysis(tmpDir, missingPhaseDir);
      assert.strictEqual(result.phase_dir_read_error ?? null, null,
        `a genuinely absent phase directory must not be reported as a read error; got: ${result.phase_dir_read_error}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  // #4014 (epic #3473 B4-unreadable) matrix row 12: runGapAnalysis now
  // consumes `scope` from findContextMdIn(phaseDir) and surfaces it as the
  // additive `phase_dir_scope` field — the typed SCOPE-enum sibling of the
  // pre-existing `phase_dir_read_error` string field asserted above.
  test('#4014 matrix row 12: unreadable phase dir reports phase_dir_scope:unreadable', (t) => {
    setup();
    try {
      injectReaddirFailure(t, phaseDir, 'EACCES');
      const result = runGapAnalysis(tmpDir, phaseDir);
      assert.strictEqual(result.phase_dir_scope, 'unreadable',
        `an unreadable phase directory must report phase_dir_scope 'unreadable'; got: ${result.phase_dir_scope}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('#4014: readable phase dir reports phase_dir_scope:complete (must not regress)', () => {
    setup();
    try {
      const result = runGapAnalysis(tmpDir, phaseDir);
      assert.strictEqual(result.phase_dir_scope, 'complete');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('#4014: genuinely absent phase dir reports phase_dir_scope:complete (boundary — not unreadable)', () => {
    tmpDir = createTempProject();
    const missingPhaseDir = path.join(tmpDir, '.planning', 'phases', '09-nonexistent');
    try {
      const result = runGapAnalysis(tmpDir, missingPhaseDir);
      assert.strictEqual(result.phase_dir_scope, 'complete',
        `a genuinely absent phase directory must report phase_dir_scope 'complete', not 'unreadable'; got: ${result.phase_dir_scope}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4014 (epic #3473 B4-unreadable) matrix row 15 — independence: the SAME
// injected-unreadable phase directory must be reported distinguishably from
// an empty one, using the SAME SCOPE.UNREADABLE value, across all three CLI
// surfaces this issue touches: `roadmap analyze` (roadmap.cts), gap-checker
// (gap-checker.cts), and one `init` bundle (init.cts). All three surfaces are
// exercised in-process (each module's exported function called directly,
// mirroring the identical direct-call style already used above and in
// init.test.cjs's #3885 block) against one shared fixture, so a single
// `fs.readdirSync` monkeypatch on the same phase directory drives all three.
// ─────────────────────────────────────────────────────────────────────────────
describe('#4014 matrix row 15: unreadable-vs-empty identity is consistent across roadmap/gap-checker/init', () => {
  const fs = require('fs');
  const path = require('path');
  const { createTempProject, cleanup } = require('./helpers.cjs');
  const { runGapAnalysis } = require('../gsd-core/bin/lib/gap-checker.cjs');
  const roadmapLib = require('../gsd-core/bin/lib/roadmap.cjs');
  const initMod = require('../gsd-core/bin/lib/init.cjs');

  function injectReaddirFailure(t, targetPath, code) {
    const resolved = path.resolve(targetPath);
    const origReaddirSync = fs.readdirSync.bind(fs);
    t.mock.method(fs, 'readdirSync', (p, ...rest) => {
      if (path.resolve(String(p)) === resolved) {
        const err = new Error(`${code}: simulated failure, scandir '${p}'`);
        err.code = code;
        throw err;
      }
      return origReaddirSync(p, ...rest);
    });
  }

  // `output()` writes via `fs.writeSync(1, ...)`, bypassing console.log — see
  // init.test.cjs's captureFd1 for the identical rationale/pattern.
  function captureFd1(run) {
    const chunks = [];
    const origWriteSync = fs.writeSync;
    fs.writeSync = function patchedWriteSync(fd, data, offset, length) {
      if (fd !== 1) return origWriteSync.apply(fs, arguments);
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const start = offset ?? 0;
      const len = length ?? (buf.length - start);
      chunks.push(Buffer.from(buf.subarray(start, start + len)));
      return len;
    };
    try {
      run();
    } finally {
      fs.writeSync = origWriteSync;
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  test('the same unreadable phase directory reports SCOPE.UNREADABLE consistently on all three surfaces', (t) => {
    const tmpDir = createTempProject();
    try {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'ROADMAP.md'),
        '# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n',
      );

      injectReaddirFailure(t, phaseDir, 'EACCES');

      // Surface 1: gap-checker.
      const gapResult = runGapAnalysis(tmpDir, phaseDir);
      assert.strictEqual(gapResult.phase_dir_scope, 'unreadable',
        `gap-checker surface: got phase_dir_scope=${gapResult.phase_dir_scope}`);

      // Surface 2: roadmap analyze.
      const analyzeOutput = captureFd1(() => roadmapLib.cmdRoadmapAnalyze(tmpDir, false));
      const phase3 = analyzeOutput.phases.find((p) => p.number === '3');
      assert.ok(phase3, `phase 3 must appear in analyze output; got: ${JSON.stringify(analyzeOutput.phases)}`);
      assert.strictEqual(phase3.context_scope, 'unreadable',
        `roadmap analyze surface: got context_scope=${phase3.context_scope}`);

      // Surface 3: one init bundle (cmdInitPlanPhase).
      const initOutput = captureFd1(() => initMod.cmdInitPlanPhase(tmpDir, '03', false));
      assert.strictEqual(initOutput.context_scope, 'unreadable',
        `init surface: got context_scope=${initOutput.context_scope}`);

      // All three used the SAME typed SCOPE.UNREADABLE value — no ad-hoc
      // per-surface string vocabulary.
      assert.strictEqual(gapResult.phase_dir_scope, phase3.context_scope);
      assert.strictEqual(phase3.context_scope, initOutput.context_scope);
    } finally {
      cleanup(tmpDir);
    }
  });
});


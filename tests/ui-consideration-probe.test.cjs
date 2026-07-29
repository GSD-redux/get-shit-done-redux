/**
 * UI-consideration-probe adapter unit tests (#1867).
 *
 * Asserts the LOCKED export surface of the THIRD probe-core adapter against the
 * BUILT artifact (`gsd-core/bin/lib/ui-consideration-probe.cjs`), which
 * `npm run build:lib` (run by pretest) emits from `src/ui-consideration-probe.cts`.
 *
 * The adapter mirrors `edge-probe` on the UI element/state axis: a closed 8-id
 * shape-rooted `UI_TAXONOMY`, an element-kind relevance filter
 * (`UI_CUES` → `classifyElement` → `applicableCategories`), the `unclassified`
 * soft-signal (#1110), and the `{explicit, backstop}` verification validators —
 * all lifecycle/merge/validation delegated to `probe-core` (ADPT-01/02/03, FILT-01).
 *
 * Structured-value assertions only (local/no-source-grep): every assertion is on a
 * typed return of the built module, never on stdout or file-content substrings.
 */
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const BUILT_SCRIPT = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'ui-consideration-probe.cjs');
const uc = require(BUILT_SCRIPT);
// The LIFT-01 primitives are probe-core's (there is no adapter-owned lift function — the lift is
// plan-phase workflow prose); LIFT-01 correctness is proven at the shared primitive level here.
const core = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'probe-core.cjs'));

const TAXONOMY_IDS = ['empty', 'loading', 'error', 'populated', 'partial', 'overflow', 'zero-one-many', 'long-text'];

describe('ui-consideration-probe: classifyElement (D-03/D-04 element-cue filter)', () => {
  test('detects form from input/field/validation cues', () => {
    assert.ok(uc.classifyElement('A signup form with input fields and validation').includes('form'));
  });
  test('detects list-collection from table/rows cues', () => {
    assert.ok(uc.classifyElement('A table listing all rows of results').includes('list-collection'));
  });
  test('detects static-content from heading/paragraph/copy cues', () => {
    assert.ok(uc.classifyElement('A heading and a paragraph of body copy').includes('static-content'));
  });
  test('returns [] when no element cue matches (zero-cue prose)', () => {
    assert.deepEqual(uc.classifyElement('xyzzy plugh frobnicate wibble'), []);
  });
  test('null/undefined text is null-safe and returns []', () => {
    assert.deepEqual(uc.classifyElement(null), []);
    assert.deepEqual(uc.classifyElement(undefined), []);
  });
});

describe('ui-consideration-probe: UI_TAXONOMY + UI_VALIDATORS (ADPT-02/03, D-01/D-02/D-05)', () => {
  test('UI_TAXONOMY has exactly the 8 shape-rooted ids in order', () => {
    assert.deepEqual(uc.UI_TAXONOMY.map((c) => c.id), TAXONOMY_IDS);
  });
  test('every taxonomy entry has name, elements[], and a string consideration', () => {
    for (const c of uc.UI_TAXONOMY) {
      assert.equal(typeof c.name, 'string');
      assert.ok(Array.isArray(c.elements) && c.elements.length >= 1);
      assert.equal(typeof c.consideration, 'string');
      assert.ok(c.consideration.length > 0);
    }
  });
  test('UNCLASSIFIED_CATEGORY is the soft-signal, kept OUT of the taxonomy (#1110)', () => {
    assert.equal(uc.UNCLASSIFIED_CATEGORY, 'unclassified');
    assert.ok(!uc.UI_TAXONOMY.map((c) => c.id).includes('unclassified'));
  });
  test('UI_VALIDATORS.categories === the 8 ids plus unclassified; verification is the {explicit,backstop} tiers (singular key)', () => {
    assert.deepEqual(uc.UI_VALIDATORS.categories, [...TAXONOMY_IDS, 'unclassified']);
    // The probe-core Validators field is `verification` (SINGULAR) — CONTEXT.md D-05's `verifications` is a paraphrase typo.
    assert.deepEqual(uc.UI_VALIDATORS.verification, ['explicit', 'backstop']);
    assert.equal(uc.UI_VALIDATORS.verifications, undefined);
  });
  test('VALID_ELEMENT_KINDS is derived from UI_CUES keys (single source of truth)', () => {
    assert.deepEqual([...uc.VALID_ELEMENT_KINDS].sort(), Object.keys(uc.UI_CUES).sort());
  });
});

describe('ui-consideration-probe: applicableCategories (FILT-01 relevance intersection, D-04)', () => {
  test('static-content raises only overflow + long-text (no loading/error/empty — SPEC R2 hint)', () => {
    assert.deepEqual(uc.applicableCategories(['static-content']).sort(), ['long-text', 'overflow']);
  });
  test('list-collection raises the richest set (empty/loading/error/populated/partial/overflow/zero-one-many)', () => {
    assert.deepEqual(uc.applicableCategories(['list-collection']).sort(),
      ['empty', 'error', 'loading', 'overflow', 'partial', 'populated', 'zero-one-many']);
  });
  test('interactive-control raises loading + error + long-text — a control has in-flight and failure states, not just long-text (#2151)', () => {
    assert.deepEqual(uc.applicableCategories(['interactive-control']).sort(), ['error', 'loading', 'long-text']);
  });
  test('no element kinds raises nothing', () => {
    assert.deepEqual(uc.applicableCategories([]), []);
  });
  test('result ids are a subset of the taxonomy ids', () => {
    const all = uc.applicableCategories(['form', 'list-collection', 'nav', 'media', 'interactive-control', 'static-content']);
    for (const id of all) assert.ok(TAXONOMY_IDS.includes(id));
  });
  test('every UIElementKind maps to >= 1 taxonomy category (a classified element never silently yields zero considerations)', () => {
    for (const kind of Object.keys(uc.UI_CUES)) {
      assert.ok(uc.applicableCategories([kind]).length >= 1, `element kind ${kind} must have >= 1 applicable category`);
    }
  });
});

describe('ui-consideration-probe: proposeConsiderations (ADPT-01/FILT-01, #1110)', () => {
  test('emits exactly one unresolved Item per applicable category, question carried in Item.probe', () => {
    const element = { id: 'C1', text: 'A table listing all rows of results' };
    const items = uc.proposeConsiderations(element);
    const expected = uc.applicableCategories(uc.classifyElement(element.text));
    assert.deepEqual(items.map((i) => i.category).sort(), [...expected].sort());
    for (const it of items) {
      assert.equal(it.requirement_id, 'C1');
      assert.equal(it.status, 'unresolved');
      assert.equal(it.verification, null);
      assert.equal(it.resolution, null);
      assert.equal(it.reason, null);
      assert.equal(typeof it.probe, 'string');
      assert.ok(it.probe.length > 0);
    }
  });
  test('zero-cue prose yields exactly ONE unclassified item, never a silent drop or minted category (#1110)', () => {
    const items = uc.proposeConsiderations({ id: 'Z', text: 'xyzzy plugh frobnicate' });
    assert.equal(items.length, 1);
    assert.equal(items[0].category, 'unclassified');
    assert.equal(items[0].status, 'unresolved');
    assert.equal(items[0].verification, null);
  });
  test('an explicit `elements: []` opt-out is silent (no items, no unclassified)', () => {
    assert.deepEqual(uc.proposeConsiderations({ id: 'O', text: 'anything', elements: [] }), []);
  });
  test('an authored array with an invalid element kind throws (fail closed, never silently empty)', () => {
    assert.throws(() => uc.proposeConsiderations({ id: 'B', text: 'x', elements: ['not-a-kind'] }));
  });
  test('an authored valid element override bypasses prose classification', () => {
    const items = uc.proposeConsiderations({ id: 'A', text: 'no cues here at all', elements: ['static-content'] });
    assert.deepEqual(items.map((i) => i.category).sort(), ['long-text', 'overflow']);
  });
});

describe('ui-consideration-probe: delegated validation (ADPT-03, D-06 — inherited from probe-core)', () => {
  test('validateResolution rejects a dismissed resolution with an empty/blank reason', () => {
    assert.throws(() => uc.validateResolution({
      requirement_id: 'C1', category: 'empty', status: 'dismissed', verification: null, resolution: null, reason: '   ',
    }));
  });
  test('analyzeCoverage rejects an orphan resolution (no matching proposed item)', () => {
    const elements = [{ id: 'C1', text: 'A table listing all rows of results' }];
    const orphan = [{
      requirement_id: 'C1', category: 'nonexistent-category', status: 'resolved',
      verification: 'explicit', resolution: 'x', reason: null,
    }];
    assert.throws(() => uc.analyzeCoverage(elements, orphan));
  });
  test('analyzeCoverage delegates a clean merge to probe-core and reports coverage', () => {
    const elements = [{ id: 'C1', text: 'A table listing all rows of results' }];
    const report = uc.analyzeCoverage(elements, []);
    assert.ok(report && report.coverage && typeof report.coverage.applicable === 'number');
    assert.ok(Array.isArray(report.items) && report.items.length >= 1);
  });
});

// ── LIFT-01 (proven at the shared probe-core primitive level on UI-SPEC-shaped input) ──────────
// A resolved `## UI Considerations` section after resolution: a `covered` (inferable)
// consideration → a plain-string truth; a `backstop` (non-inferable, purely-visual) consideration
// → carries verification: 'backstop'. Measures DISPOSITION, not entry-count (SPEC R7, Goodhart).
const COVERED = 'Empty state for the results table renders the documented "No results" copy.';
const BACKSTOP = { statement: 'Overflowing long labels truncate with an ellipsis without shifting layout.', verification: 'backstop' };
const COVERED_2 = 'Loading state shows a skeleton for the results table.';

describe('ui-consideration-probe LIFT-01: projectTruths (covered→string, backstop→flat scalar, D-07)', () => {
  test('covered consideration projects to a bare string; backstop projects to {statement, verification:backstop}', () => {
    const out = core.projectTruths([COVERED, BACKSTOP]);
    assert.equal(out[0], COVERED);
    assert.deepEqual(out[1], { statement: BACKSTOP.statement, verification: 'backstop' });
  });
  test('projection preserves input order (deterministic lift over taxonomy id order — ordering/stability edge)', () => {
    const out = core.projectTruths([COVERED, COVERED_2, BACKSTOP]);
    assert.equal(out[0], COVERED);
    assert.equal(out[1], COVERED_2);
    assert.deepEqual(out[2], { statement: BACKSTOP.statement, verification: 'backstop' });
  });
  test('no covered/backstop consideration is silently dropped', () => {
    const input = [COVERED, COVERED_2, BACKSTOP];
    assert.equal(core.projectTruths(input).length, input.length);
  });
});

describe('ui-consideration-probe LIFT-01: verify-time disposition (never silent pass, D-09)', () => {
  test('a no-evidence backstop consideration routes to insufficient_spec — NEVER a silent green', () => {
    const d = core.dispositionForUnverifiableTruth(BACKSTOP, { evidence: [] });
    assert.equal(d.status, 'unverified');
    assert.equal(d.flagged, true);
    assert.equal(d.tier, 'backstop');
    assert.equal(d.reason, core.INSUFFICIENT_SPEC);
    assert.equal(core.INSUFFICIENT_SPEC, 'insufficient_spec');
    assert.notEqual(d.status, 'green');
  });
  test('a backstop consideration WITH explicit evidence (a passing wired test) disposes green', () => {
    const d = core.dispositionForUnverifiableTruth(BACKSTOP, { evidence: [{ kind: 'wired-test', passed: true }] });
    assert.equal(d.status, 'green');
    assert.equal(d.flagged, false);
  });
  test('a covered (inferable) consideration disposes green even with no evidence (over-abstention guard)', () => {
    const d = core.dispositionForUnverifiableTruth(COVERED, { evidence: [] });
    assert.equal(d.status, 'green');
    assert.equal(d.flagged, false);
  });
});

// ══ WIRE-01 (Phase 2, #1867) — the live ui-phase producer surface ════════════════════════════
// Two new adapter functions the ui-phase Step 9.5 probe consumes: proposeElements (the
// propose-then-confirm view exposing detected kinds + applicable categories per element) and
// autoResolve (the deterministic `--auto` resolution FLOOR that never dismisses and never
// auto-backstops an unclassified item, #1110). Structured-value assertions only.
const LIST_ELEMENT = { id: 'C1', text: 'A table listing all rows of results' };
const ZERO_CUE_ELEMENT = { id: 'Z', text: 'xyzzy plugh frobnicate' };
// A surface that is genuinely BOTH a form and a list, but whose prose trips only the form cue —
// the partial-cue recall gap the confirm step exists to close.
const PARTIAL_CUE_ELEMENT = { id: 'P', text: 'A signup form with input fields and validation' };

describe('ui-consideration-probe: proposeElements (WIRE-01 confirm surface, SC1)', () => {
  test('a classified element returns one ElementProposal with kinds, applicable categories, considerations, unclassified:false', () => {
    const [p] = uc.proposeElements([LIST_ELEMENT]);
    assert.equal(p.id, 'C1');
    assert.ok(p.kinds.includes('list-collection'));
    assert.deepEqual([...p.categories].sort(), [...uc.applicableCategories(uc.classifyElement(LIST_ELEMENT.text))].sort());
    assert.deepEqual(p.considerations.map((c) => c.category).sort(), [...p.categories].sort());
    assert.equal(p.unclassified, false);
  });
  test('a zero-cue element returns kinds:[], categories:[], unclassified:true, and exactly one unclassified consideration (#1110)', () => {
    const [p] = uc.proposeElements([ZERO_CUE_ELEMENT]);
    assert.deepEqual(p.kinds, []);
    assert.deepEqual(p.categories, []);
    assert.equal(p.unclassified, true);
    assert.equal(p.considerations.length, 1);
    assert.equal(p.considerations[0].category, uc.UNCLASSIFIED_CATEGORY);
  });
  test('proposeElements is deterministic — two calls on the same element array deepEqual (idempotency substrate for WIRE-02)', () => {
    assert.deepEqual(uc.proposeElements([LIST_ELEMENT, ZERO_CUE_ELEMENT]), uc.proposeElements([LIST_ELEMENT, ZERO_CUE_ELEMENT]));
  });
  test('an authored elements[] override bypasses prose classification and drives the categories', () => {
    const [p] = uc.proposeElements([{ id: 'A', text: 'no cues here at all', elements: ['static-content'] }]);
    assert.deepEqual([...p.kinds].sort(), ['static-content']);
    assert.deepEqual([...p.categories].sort(), ['long-text', 'overflow']);
    assert.equal(p.unclassified, false);
  });
});

describe('ui-consideration-probe: autoResolve (WIRE-01 typed --auto never-dismiss, SC2, #1110)', () => {
  test('every applicable consideration auto-resolves to a backstop with a non-empty resolution; NONE is dismissed', () => {
    const items = uc.proposeConsiderations(LIST_ELEMENT);
    const resolutions = uc.autoResolve(items);
    assert.equal(resolutions.length, items.length);
    for (const r of resolutions) {
      assert.notEqual(r.status, 'dismissed');
      assert.equal(r.status, 'resolved');
      assert.equal(r.verification, 'backstop');
      assert.equal(typeof r.resolution, 'string');
      assert.ok(r.resolution.length > 0);
    }
  });
  test('an unclassified item stays unresolved — never auto-backstopped (a missing cue is not evidence, #1110)', () => {
    const items = uc.proposeConsiderations(ZERO_CUE_ELEMENT); // one unclassified item
    const [r] = uc.autoResolve(items);
    assert.equal(r.status, 'unresolved');
    assert.equal(r.verification, null);
    assert.equal(r.resolution, null);
    assert.equal(r.reason, null);
  });
  test('autoResolve output validates and merges through probe-core: zero dismissed, byVerification.backstop === applicable', () => {
    const items = uc.proposeConsiderations(LIST_ELEMENT);
    const report = uc.analyzeCoverage([LIST_ELEMENT], uc.autoResolve(items));
    assert.ok(report.items.every((it) => it.status !== 'dismissed'));
    assert.equal(report.coverage.resolved, report.coverage.applicable);
    assert.equal(report.coverage.byVerification.backstop, report.coverage.applicable);
  });
});

describe('ui-consideration-probe: partial-cue recall gap (confirm is load-bearing, not the heuristic — Goodhart)', () => {
  test('prose that trips only the form cue under-covers: heuristic categories are a STRICT SUBSET of the confirmed form+list union', () => {
    const [heuristic] = uc.proposeElements([PARTIAL_CUE_ELEMENT]);
    const [confirmed] = uc.proposeElements([{ ...PARTIAL_CUE_ELEMENT, elements: ['form', 'list-collection'] }]);
    assert.deepEqual(heuristic.kinds, ['form']); // prose only tripped 'form'
    const hSet = new Set(heuristic.categories);
    const cSet = new Set(confirmed.categories);
    for (const cat of hSet) assert.ok(cSet.has(cat), `heuristic category ${cat} must be in the confirmed union`);
    assert.ok(cSet.size > hSet.size, 'the confirmed union must strictly exceed the heuristic set — proving the confirm step recovers missed coverage');
  });
});

// ══ WIRE-02 (Phase 2, #1867) — the UI-SPEC section round-trips the shipped lift, backward-compat,
// idempotency. Typed returns only (this file carries no allow-test-rule header). The `## UI
// Considerations` section format is LOCKED by the shipped plan-phase `## UI Considerations` lift rule +
// probe-core `projectTruths`; these guards pin that the template documents the SAME format. ═════
describe('ui-consideration-probe WIRE-02: backward-compat + format-match + idempotency (SC4)', () => {
  test('projectTruths(undefined) and projectTruths([]) both === [] — an old UI-SPEC with no section lifts nothing, never throws (Hyrum SC4)', () => {
    assert.deepEqual(core.projectTruths(undefined), []);
    assert.deepEqual(core.projectTruths([]), []);
  });
  test('a mixed covered/backstop/unresolved considerations array projects to the exact plan-phase-lift shape, order preserved (format-match SC3)', () => {
    const input = ['Empty state renders the documented "No results" copy.', { statement: 'Overflowing long labels truncate with an ellipsis.', verification: 'backstop' }, 'Loading shows a skeleton for the results table.'];
    const out = core.projectTruths(input);
    assert.equal(out[0], input[0]);                                              // covered → bare string
    assert.deepEqual(out[1], { statement: input[1].statement, verification: 'backstop' }); // backstop → flat scalar
    assert.equal(out[2], input[2]);                                             // order preserved
  });
  test('proposeElements is deterministic — re-running the probe rewrites byte-stable rows, never duplicated (idempotency SC4)', () => {
    const els = [{ id: 'C1', text: 'A table listing all rows of results' }, { id: 'Z', text: 'xyzzy plugh' }];
    assert.deepEqual(uc.proposeElements(els), uc.proposeElements(els));
  });
});

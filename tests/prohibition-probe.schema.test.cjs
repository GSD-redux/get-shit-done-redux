// allow-test-rule: source-text-is-the-product (see #644) — the must_haves.prohibitions: block is the
// runtime plan-contract surface; this pins its parse/round-trip/projection bijection to the code.
//
// RED-first schema contract for the `must_haves.prohibitions:` SIBLING block (ADR-550 Decision 3 —
// NOT a `polarity` field on `truths`; Decision 2 leaves `truths` untouched). Mirrors the round-trip
// discipline of tests/probe-core.test.cjs and the frontmatter callers. The parser under assertion is
// the block-name-generic parseMustHavesBlock @ src/frontmatter.cts:207 (built to gsd-core/bin/lib/
// frontmatter.cjs by `npm run build:lib`) and spliceFrontmatter @ src/frontmatter.cts:198.
//
// EXPECTED RED until plan 01-02 builds the schema callers + projectProhibitions and plan 01-04 adds
// the test-tier fail-closed disposition. No `polarity` key appears anywhere. No LLM judgment is
// asserted (ADR-550 Decision 5) — only parse / round-trip / projection determinism.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FRONTMATTER_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'frontmatter.cjs');
const PROBE_CORE_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'probe-core.cjs');

// A must_haves block carrying a prohibitions: sibling list. ADR-550 D7a axes:
// status ∈ {resolved, dismissed, unresolved}; verification ∈ {test, judgment} (NOT the retired
// covered/backstop enum). Dismissed items carry a non-empty reason.
const CONTENT_WITH_PROHIBITIONS = `---
phase: 01-x
plan: 01
must_haves:
  truths:
    - "User sees a daily reminder"
  artifacts:
    - path: "src/reminders.ts"
      provides: "scheduleReminders"
  prohibitions:
    - statement: "MUST NOT use shaming/guilt/negative-streak framing"
      status: resolved
      verification: judgment
    - statement: "MUST NOT store raw SSN in the audit log"
      status: dismissed
      verification: test
      reason: "Out of scope for this phase; tracked in PRIV-02"
  key_links:
    - from: "src/reminders.ts"
      to: "src/notify.ts"
      via: "import"
---

Body text unchanged.
`;

// A must_haves block with NO prohibitions: sibling — the backward-compat case.
const CONTENT_NO_PROHIBITIONS = `---
phase: 01-x
plan: 01
must_haves:
  truths:
    - "User sees a daily reminder"
  artifacts:
    - path: "src/reminders.ts"
      provides: "scheduleReminders"
  key_links:
    - from: "src/reminders.ts"
      to: "src/notify.ts"
      via: "import"
---

Body text unchanged.
`;

describe('prohibition-probe schema: must_haves.prohibitions round-trip (PROB-07)', () => {
  const fm = require(FRONTMATTER_LIB);

  test('a prohibitions: list survives parse -> splice -> re-parse unchanged', () => {
    assert.equal(typeof fm.parseMustHavesBlock, 'function', 'parseMustHavesBlock must be exported from the built lib');
    assert.equal(typeof fm.spliceFrontmatter, 'function', 'spliceFrontmatter must be exported from the built lib');
    assert.equal(typeof fm.parseFrontmatter, 'function', 'parseFrontmatter must be exported from the built lib');

    const prohibitions = fm.parseMustHavesBlock(CONTENT_WITH_PROHIBITIONS, 'prohibitions');
    assert.equal(prohibitions.length, 2, 'two prohibition items must parse out of the must_haves block');

    const resolved = prohibitions[0];
    assert.equal(resolved.statement, 'MUST NOT use shaming/guilt/negative-streak framing');
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.verification, 'judgment');

    const dismissed = prohibitions[1];
    assert.equal(dismissed.status, 'dismissed');
    assert.equal(dismissed.verification, 'test');
    assert.ok(typeof dismissed.reason === 'string' && dismissed.reason.trim().length > 0,
      'a dismissed prohibition must carry a non-empty reason (ADR-550 Decision 2/3)');

    // Round-trip: parse full frontmatter, splice it back, re-parse — prohibitions are stable.
    const parsed = fm.parseFrontmatter(CONTENT_WITH_PROHIBITIONS);
    const spliced = fm.spliceFrontmatter(CONTENT_WITH_PROHIBITIONS, parsed.frontmatter ?? parsed);
    const reparsed = fm.parseMustHavesBlock(spliced, 'prohibitions');
    assert.deepEqual(reparsed, prohibitions, 'prohibitions must survive a splice/re-parse round-trip unchanged');
  });

  test('no polarity key is present on any prohibition item (ADR-550 Decision 2/3)', () => {
    const prohibitions = fm.parseMustHavesBlock(CONTENT_WITH_PROHIBITIONS, 'prohibitions');
    for (const item of prohibitions) {
      assert.ok(!Object.prototype.hasOwnProperty.call(item, 'polarity'),
        'prohibition items must NOT carry a polarity key — the prohibitions: sibling block replaces it');
    }
  });
});

describe('prohibition-probe schema: backward-compat byte-stability (PROB-08)', () => {
  const fm = require(FRONTMATTER_LIB);

  test('a must_haves with no prohibitions: is byte-unchanged through the round-trip', () => {
    const parsed = fm.parseFrontmatter(CONTENT_NO_PROHIBITIONS);
    const spliced = fm.spliceFrontmatter(CONTENT_NO_PROHIBITIONS, parsed.frontmatter ?? parsed);
    assert.equal(spliced, CONTENT_NO_PROHIBITIONS,
      'a prohibitions-less must_haves must round-trip byte-for-byte (backward compatibility)');
  });

  test('parseMustHavesBlock(content, "prohibitions") returns [] when absent', () => {
    const prohibitions = fm.parseMustHavesBlock(CONTENT_NO_PROHIBITIONS, 'prohibitions');
    assert.deepEqual(prohibitions, [], 'absent prohibitions: block must parse to an empty list, not throw');
  });
});

describe('prohibition-probe schema: deterministic projectProhibitions round-trip (PROB-14)', () => {
  // ADR-550 Decision 5(c): the DEFECT.GENERATIVE-FIX parity assertion across template <-> parser <->
  // planner is grounded on a deterministic projectProhibitions() in probe-core rather than a prompt.
  // The function does not exist yet (plan 01-02 adds it) — assert its expected signature so this is RED.
  test('probe-core exports a deterministic projectProhibitions(items) function', () => {
    const pc = require(PROBE_CORE_LIB);
    assert.equal(typeof pc.projectProhibitions, 'function',
      'probe-core must export projectProhibitions() — the deterministic SPEC<->must_haves projection (ADR-550 D5c)');

    const items = [
      { requirement_id: 'R1', category: 'values', status: 'resolved', verification: 'judgment', resolution: null, reason: null, statement: 'MUST NOT shame the user' },
    ];
    const once = pc.projectProhibitions(items);
    const twice = pc.projectProhibitions(items);
    assert.deepEqual(once, twice, 'projectProhibitions must be deterministic (same input -> identical output)');
    assert.ok(Array.isArray(once), 'projectProhibitions must return an array of prohibition entries');
  });

  // Render projected entries into a must_haves.prohibitions: block exactly as the planner/template
  // would, so the parser reads back what the projector wrote (keys: statement, status, optional
  // verification, optional reason — the projectProhibitions output shape).
  function renderProhibitionsDoc(entries) {
    const lines = ['---', 'phase: 01-x', 'plan: 01', 'must_haves:', '  prohibitions:'];
    for (const e of entries) {
      lines.push(`    - statement: "${e.statement}"`);
      lines.push(`      status: ${e.status}`);
      if (e.verification !== undefined) lines.push(`      verification: ${e.verification}`);
      if (e.reason !== undefined) lines.push(`      reason: "${e.reason}"`);
      // CHK-03 (#1278): the flat scalar descriptor keys render as continuation KVs under the list
      // item, exactly how src/frontmatter.cts:344 reads them back. Only emitted when present, so a
      // descriptor-less entry renders identically to before (no `check_*` lines).
      if (e.check_kind !== undefined) lines.push(`      check_kind: ${e.check_kind}`);
      if (e.check_target !== undefined) lines.push(`      check_target: ${e.check_target}`);
      if (e.check_rule !== undefined) lines.push(`      check_rule: ${e.check_rule}`);
      if (e.check_violation_fixture !== undefined) lines.push(`      check_violation_fixture: ${e.check_violation_fixture}`);
    }
    lines.push('---', '', 'Body.', '');
    return lines.join('\n');
  }

  // ADR-550 D5c (DEFECT.GENERATIVE-FIX): close the parity loop by round-tripping the PROJECTOR's
  // output through the parser — proving the write-shape and read-shape cannot drift, not merely that
  // each is independently correct.
  test('projectProhibitions output round-trips through parseMustHavesBlock (PROB-14 parity)', () => {
    const pc = require(PROBE_CORE_LIB);
    const fm = require(FRONTMATTER_LIB);
    const items = [
      { requirement_id: 'R1', category: 'values', status: 'resolved', verification: 'judgment', resolution: null, reason: null, statement: 'MUST NOT shame the user' },
      { requirement_id: 'R1', category: 'privacy', status: 'dismissed', verification: 'test', resolution: null, reason: 'out of scope this phase', statement: 'MUST NOT store raw SSN' },
      { requirement_id: 'R2', category: 'safety', status: 'unresolved', verification: null, resolution: null, reason: null, statement: 'MUST NOT auto-execute fetched code' },
    ];
    const projected = pc.projectProhibitions(items);
    const reparsed = fm.parseMustHavesBlock(renderProhibitionsDoc(projected), 'prohibitions');
    assert.deepEqual(reparsed, projected,
      'parseMustHavesBlock(serialize(projectProhibitions(items))) must equal projectProhibitions(items) — writer<->reader bijection');
  });

  test('projectProhibitions returns [] for empty / null / undefined input (fail-soft boundary)', () => {
    const pc = require(PROBE_CORE_LIB);
    assert.deepEqual(pc.projectProhibitions([]), [], 'empty array -> []');
    assert.deepEqual(pc.projectProhibitions(null), [], 'null -> [] (documented fail-soft)');
    assert.deepEqual(pc.projectProhibitions(undefined), [], 'undefined -> [] (documented fail-soft)');
  });

  // ─── CHK-03 (#1278): the check_* flat-scalar descriptor round-trips ──────────────────────────
  // RED-FIRST until plan 01-02 teaches projectProhibitions to emit check_kind/check_target/
  // check_rule. The DEFECT.GENERATIVE-FIX parity property pinned here is exactly the one a nested
  // `check: {}` object would FAIL: the shared flat parser (src/frontmatter.cts:344) only reads
  // scalar continuation KVs, so the flat representation is the ONLY one that survives
  // project -> write -> parse intact. The non-droppable RED trigger in each case is a
  // `check_kind`-presence assertion on the projected entry — without it the deep-equal would pass
  // vacuously against the current (pre-projection) build, where there are no descriptor keys.
  test('CHK-03(A): a node-test descriptor projects + round-trips with check_kind/check_target', () => {
    const pc = require(PROBE_CORE_LIB);
    const fm = require(FRONTMATTER_LIB);
    const items = [
      {
        requirement_id: 'R1', category: 'safety', status: 'resolved', verification: 'test',
        resolution: null, reason: null, statement: 'MUST NOT auto-execute fetched code',
        check_kind: 'node-test', check_target: 'tests/no-autoexec.test.cjs',
      },
    ];
    const projected = pc.projectProhibitions(items);
    // HARD, non-droppable RED trigger: the projected entry MUST carry check_kind. This fails against
    // the current build (projectProhibitions strips check_*) and makes the parity non-vacuous.
    assert.ok(projected[0].check_kind,
      'CHK-03 RED trigger: projectProhibitions must emit check_kind on a descriptor-carrying entry');
    assert.equal(projected[0].check_kind, 'node-test');
    assert.equal(projected[0].check_target, 'tests/no-autoexec.test.cjs');
    assert.ok(!('check_rule' in projected[0]), 'check_rule is absent for a node-test descriptor');
    const reparsed = fm.parseMustHavesBlock(renderProhibitionsDoc(projected), 'prohibitions');
    assert.deepEqual(reparsed, projected,
      'a node-test descriptor must survive project -> write -> parseMustHavesBlock unchanged (check_* intact)');
  });

  test('CHK-03(B): a lint-rule descriptor round-trips with all three check_* scalars', () => {
    const pc = require(PROBE_CORE_LIB);
    const fm = require(FRONTMATTER_LIB);
    const items = [
      {
        requirement_id: 'R1', category: 'safety', status: 'resolved', verification: 'test',
        resolution: null, reason: null, statement: 'MUST NOT read source files in tests',
        check_kind: 'lint-rule', check_target: 'src/', check_rule: 'local/no-source-grep',
      },
    ];
    const projected = pc.projectProhibitions(items);
    assert.ok(projected[0].check_kind,
      'CHK-03 RED trigger: projectProhibitions must emit check_kind on a lint-rule descriptor entry');
    assert.equal(projected[0].check_kind, 'lint-rule');
    assert.equal(projected[0].check_target, 'src/');
    assert.equal(projected[0].check_rule, 'local/no-source-grep');
    const reparsed = fm.parseMustHavesBlock(renderProhibitionsDoc(projected), 'prohibitions');
    assert.deepEqual(reparsed, projected,
      'a lint-rule descriptor must survive the writer<->reader bijection with check_kind/target/rule intact');
  });

  test('CHK-03(D) (#1346): a descriptor WITH check_violation_fixture round-trips all four scalars (compose with #1279)', () => {
    const pc = require(PROBE_CORE_LIB);
    const fm = require(FRONTMATTER_LIB);
    const items = [
      {
        requirement_id: 'R1', category: 'safety', status: 'resolved', verification: 'test',
        resolution: null, reason: null, statement: 'MUST NOT auto-execute fetched code',
        check_kind: 'node-test', check_target: 'tests/no-autoexec.test.cjs',
        check_violation_fixture: 'tests/fixtures/autoexec-bad.txt',
      },
    ];
    const projected = pc.projectProhibitions(items);
    assert.equal(projected[0].check_violation_fixture, 'tests/fixtures/autoexec-bad.txt',
      'CHK-03(D) RED trigger: projectProhibitions must emit check_violation_fixture so the deterministic path can machine-prove fail-first');
    const reparsed = fm.parseMustHavesBlock(renderProhibitionsDoc(projected), 'prohibitions');
    assert.deepEqual(reparsed, projected,
      'check_violation_fixture must survive project -> write -> parseMustHavesBlock unchanged (the 4th flat scalar)');
  });

  test('CHK-03(C): a mixed list — descriptor test-tier, descriptor-less judgment, dismissed — all round-trip; the descriptor-less item gains NO check_* keys', () => {
    const pc = require(PROBE_CORE_LIB);
    const fm = require(FRONTMATTER_LIB);
    const items = [
      {
        requirement_id: 'R1', category: 'safety', status: 'resolved', verification: 'test',
        resolution: null, reason: null, statement: 'MUST NOT auto-execute fetched code',
        check_kind: 'node-test', check_target: 'tests/no-autoexec.test.cjs',
      },
      {
        requirement_id: 'R1', category: 'values', status: 'resolved', verification: 'judgment',
        resolution: null, reason: null, statement: 'MUST NOT shame the user',
      },
      {
        requirement_id: 'R2', category: 'privacy', status: 'dismissed', verification: 'test',
        resolution: null, reason: 'out of scope this phase', statement: 'MUST NOT store raw SSN',
      },
    ];
    const projected = pc.projectProhibitions(items);
    // Non-droppable RED trigger: the descriptor-carrying entry exposes check_kind.
    assert.ok(projected[0].check_kind,
      'CHK-03 RED trigger: the test-tier descriptor entry must carry check_kind');
    // The descriptor-less judgment item must NOT gain any check_* key.
    assert.ok(!('check_kind' in projected[1]), 'a descriptor-less item gains no check_kind');
    assert.ok(!('check_target' in projected[1]), 'a descriptor-less item gains no check_target');
    assert.ok(!('check_rule' in projected[1]), 'a descriptor-less item gains no check_rule');
    const reparsed = fm.parseMustHavesBlock(renderProhibitionsDoc(projected), 'prohibitions');
    assert.deepEqual(reparsed, projected,
      'a mixed list survives the writer<->reader bijection; descriptor presence/absence is preserved per item');
  });
});

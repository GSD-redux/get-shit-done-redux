'use strict';

/**
 * PR-1 (#2249 / epic #612) — bracket phase-ID core grammar.
 *
 * Ratified contract: docs/adr/612-bracket-phase-id-convention.md, Decisions 1/4/6.
 * One pure round-trippable model added INSIDE src/phase-id.cts (the ADR-2121
 * single canonical owner): parsePhaseId / renderPhaseId / toDir sharing one
 * PhaseId shape, alongside the existing M-NN helpers. READING-B: the milestone
 * comes from the `[PROJECT.MM]` / `{CODE}.{MM}-` prefix, never the phase-token
 * leading integer.
 *
 * Sibling of tests/adr-612-collision-characterization.test.cjs (the PR-0 anchor):
 * that file locks the CURRENT M-NN collapse (`normalizePhaseName('2-01.02-01')
 * === '02'`); this file locks the bracket grammar that resolves the same
 * `(milestone, phase, subphase, plan)` identity to exactly one tuple on the
 * gated bracket path.
 *
 * All assertions are BEHAVIORAL: call the exported function, assert its typed
 * output. No source-grep. The example tables mirror ADR §3; the two fast-check
 * blocks are the generative round-trip / disk-display bijection properties the
 * #612 approval requires (ADR Decision 4).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const core = require('../gsd-core/bin/lib/phase-id.cjs');

const p2 = (n) => String(n).padStart(2, '0');

// ─── ADR §3 round-trip example table (doc-parity) ───────────────────────────
const TABLE = [
  { display: '[GSD.02] 05.03-01', dir: 'GSD.02-05.03-feature' },
  { display: '[GSD.02] 05',       dir: 'GSD.02-05-feature' },
  { display: '[CK.01] 12.04',     dir: 'CK.01-12.04-feature' },
];

describe('bracket grammar: emit/render round-trip pair (ADR §3)', () => {
  test('render(parse(display)) === display', () => {
    for (const { display } of TABLE) {
      assert.strictEqual(core.renderPhaseId(core.parsePhaseId(display)), display);
    }
  });

  test('toDir(parse(display), slug) === dir', () => {
    for (const { display, dir } of TABLE) {
      assert.strictEqual(core.toDir(core.parsePhaseId(display), 'feature'), dir);
    }
  });

  test('parse is idempotent across surfaces: parse(dir) and parse(display) agree on the tuple', () => {
    for (const { display, dir } of TABLE) {
      const a = core.parsePhaseId(display);
      const b = core.parsePhaseId(dir);
      assert.strictEqual(
        `${b.project}.${b.milestone}-${b.phase}`,
        `${a.project}.${a.milestone}-${a.phase}`,
      );
    }
  });
});

// ─── ADR §1 collision-test acceptance (the full 5-tuple, post-fix) ───────────
describe('bracket grammar: full 5-tuple parse (ADR §1 acceptance)', () => {
  test('parsePhaseId resolves a complete milestone/phase/subphase/plan identity', () => {
    const parsed = core.parsePhaseId('GSD.02-05.03-01');
    assert.deepStrictEqual(parsed, {
      project:   'GSD',
      milestone: '02', // from the bracket/dir prefix (READING-B), not the leading int
      phase:     '05',
      subphase:  '03',
      plan:      '01',
    });
    assert.strictEqual(core.renderPhaseId(parsed), '[GSD.02] 05.03-01');
    assert.strictEqual(core.toDir(parsed, 'some-feature'), 'GSD.02-05.03-some-feature');
  });

  test('a plan without a subphase round-trips (display -[LL] with no .SS)', () => {
    const id = core.parsePhaseId('[GSD.02] 05-01');
    assert.strictEqual(id.subphase, undefined);
    assert.strictEqual(id.plan, '01');
    assert.strictEqual(core.renderPhaseId(id), '[GSD.02] 05-01');
  });

  test('a bare dir/token arg with no trailing segment parses (contract #2 "bare bracket arg")', () => {
    // `GSD.02-05` — the on-disk/CLI token with neither sub-phase, plan, nor slug.
    const id = core.parsePhaseId('GSD.02-05');
    assert.deepStrictEqual(id, { project: 'GSD', milestone: '02', phase: '05' });
    assert.strictEqual(core.renderPhaseId(id), '[GSD.02] 05');
  });
});

// ─── 3+-digit numeric width (re-review Minor 1) ─────────────────────────────
// The fast-check generators below (numArb) span 1–999 so the round-trip and
// disk↔display properties genuinely exercise 3+-digit tokens; this concrete
// case pins the reviewer's hand-traced example deterministically. A 3+-digit
// milestone must survive pad2() un-truncated, carry no leading zero, and match
// CANONICAL_NUMERIC_RE's `[1-9]\d{2,}` branch inside toDir.
describe('bracket grammar: 3+-digit milestone width (re-review Minor 1)', () => {
  test("'[GSD.100] 05' round-trips, renders, and toDirs without truncation", () => {
    const id = core.parsePhaseId('[GSD.100] 05');
    assert.deepStrictEqual(id, { project: 'GSD', milestone: '100', phase: '05' });
    assert.strictEqual(core.renderPhaseId(id), '[GSD.100] 05');
    assert.strictEqual(core.toDir(id, 'feature'), 'GSD.100-05-feature');
  });
});

// ─── Strict-reject: parsePhaseId rejects non-canonical input (review B1) ────
// render(parse(x)) === x must hold for every WELL-FORMED display string
// (ADR-612 Decision 4). A permissive match that accepts unpadded numbers or
// multi-space separators falsifies that contract the moment the accepted
// string differs from what renderPhaseId would emit for the same tuple —
// parsePhaseId must reject rather than silently normalize.
describe('bracket grammar: parsePhaseId rejects non-canonical input (review B1)', () => {
  test('unpadded / over-padded / multi-space display forms are rejected', () => {
    assert.throws(() => core.parsePhaseId('[GSD.5] 5'), /parsePhaseId: not canonical/);
    assert.throws(() => core.parsePhaseId('[GSD.005] 05'), /parsePhaseId: not canonical/);
    assert.throws(() => core.parsePhaseId('[GSD.02]  05'), /parsePhaseId: not canonical/);
  });

  test('leading/trailing whitespace is rejected by the anchors (no .trim() tolerance)', () => {
    assert.throws(() => core.parsePhaseId(' [GSD.02] 05'), /parsePhaseId: not a bracket phase id/);
    assert.throws(() => core.parsePhaseId('[GSD.02] 05 '), /parsePhaseId: not a bracket phase id/);
  });

  test('unpadded dir/token forms are rejected', () => {
    assert.throws(() => core.parsePhaseId('GSD.2-5'), /parsePhaseId: not canonical/);
    assert.throws(() => core.parsePhaseId('GSD.02-05-1'), /parsePhaseId: not canonical/);
  });

  test('a canonical form still parses cleanly (no false-positive rejection)', () => {
    assert.deepStrictEqual(core.parsePhaseId('[GSD.02] 05'), { project: 'GSD', milestone: '02', phase: '05' });
    assert.deepStrictEqual(core.parsePhaseId('GSD.02-05'), { project: 'GSD', milestone: '02', phase: '05' });
  });
});

// ─── Bare/ambiguous tokens are rejected — only the bracket parser throws ─────
describe('bracket grammar: parsePhaseId rejects ambiguous non-bracket tokens (ADR conservative default #8a)', () => {
  test("bare '02-04' (the cross-subsystem ambiguity) is rejected by the bracket parser", () => {
    // '02-04' has no bracket and no {CODE}.{MM}- dot-prefix, so it matches
    // neither branch — the new bracket parser throws rather than guess a tuple.
    // The rejection lives ONLY here; normalizePhaseName still returns it intact
    // (see adr-612-collision-characterization.test.cjs), so no existing path
    // gains a throw.
    assert.throws(() => core.parsePhaseId('02-04'), /not a bracket phase id/);
    // The legacy reader is untouched by this rejection.
    assert.strictEqual(core.normalizePhaseName('02-04'), '02-04');
  });

  test('other non-bracket forms are rejected', () => {
    assert.throws(() => core.parsePhaseId('05'), /not a bracket phase id/);
    assert.throws(() => core.parsePhaseId('2-01'), /not a bracket phase id/);
    assert.throws(() => core.parsePhaseId(''), /not a bracket phase id/);
  });
});

// ─── READING-B milestone source (gated on 'bracket'; legacy paths intact) ────
describe('bracket grammar: getMilestoneFromPhaseId READING-B', () => {
  test("milestone comes from the [PROJECT.MM] prefix, not the phase-token leading int", () => {
    // 'GSD.02-05.03' → milestone 02 (v2.0), NOT phase 05 (v5.0). ADR Decision 6.
    assert.strictEqual(core.getMilestoneFromPhaseId('GSD.02-05.03', 'bracket'), 'v2.0');
  });

  test('sentinel milestone ranges (0.x / 999.x) resolve to null', () => {
    assert.strictEqual(core.getMilestoneFromPhaseId('GSD.00-01', 'bracket'), null);
    assert.strictEqual(core.getMilestoneFromPhaseId('GSD.999-01', 'bracket'), null);
  });

  test('a bracket-convention call on a non-bracket string returns null (no throw)', () => {
    // Negative branch: convention === 'bracket' but the string has no
    // {CODE}.{MM} prefix → null, not an exception.
    assert.strictEqual(core.getMilestoneFromPhaseId('2-01', 'bracket'), null);
  });

  test("legacy M-NN path is byte-unchanged when convention is absent / not 'bracket'", () => {
    // READING-A leading-int rule, current behavior — must not regress.
    assert.strictEqual(core.getMilestoneFromPhaseId('2-01'), 'v2.0');
    assert.strictEqual(core.getMilestoneFromPhaseId('CK-2-01'), 'v2.0');
    assert.strictEqual(core.getMilestoneFromPhaseId('2-01', 'milestone-prefixed'), 'v2.0');
    // Sentinel + non-milestone forms preserved on the legacy path.
    assert.strictEqual(core.getMilestoneFromPhaseId('0-01'), null);
    assert.strictEqual(core.getMilestoneFromPhaseId('05'), null);
  });
});

// ─── extractPhaseToken: bracket dir form (gated on convention) ───────────────
// The bracket dir `{CODE}.{MM}-{PP}` is string-indistinguishable from the legacy
// #2043 letter-prefixed-decimal family (`P0.3-2`) when the code ends in a digit,
// so the new bracket reader fires ONLY under an explicit `convention` arg — the
// same gating decision as getMilestoneFromPhaseId's READING-B. Convention-less
// callers keep the legacy reading byte-identical (pinned across the whole
// numeric-tail family in tests/phase-id.test.cjs).
describe('bracket grammar: extractPhaseToken (bracket path gated on convention)', () => {
  test("extracts the phase token PP[.SS] from a bracket dir under convention 'bracket'", () => {
    assert.strictEqual(core.extractPhaseToken('CK.02-02.01-slug', 'bracket'), '02.01');
    assert.strictEqual(core.extractPhaseToken('GSD.02-05-feature', 'bracket'), '05');
    assert.strictEqual(core.extractPhaseToken('GSD.02-05.03-01', 'bracket'), '05.03'); // plan is not part of the token
  });

  test('the bracket path is OFF by default: a convention-less call keeps the legacy reading', () => {
    // Without the signal the bracket branch is skipped; `GSD.02` matches neither
    // the leading-int nor the letter-prefix legacy rule, so the whole dir name is
    // returned unchanged (prior behaviour) rather than parsed as a bracket dir.
    assert.strictEqual(core.extractPhaseToken('GSD.02-05.03-01'), 'GSD.02-05.03-01');
  });

  test('legacy code-prefixed dirs still extract as before (no regression)', () => {
    assert.strictEqual(core.extractPhaseToken('CK-01-foo'), 'CK-01');
    assert.strictEqual(core.extractPhaseToken('02-04-some-slug'), '02-04');
  });
});

// ─── comparator: existing comparePhaseNum orders extracted bracket tokens ─────
// ADR §Phases PR-1 row names "comparator". No NEW comparator code is required:
// bracket phase tokens flow through extractPhaseToken (which yields the
// dot-decimal `PP[.SS]` form), and comparePhaseNum's existing numeric+decimal
// branch already orders that form. Cross-MILESTONE ordering (a milestone-
// qualified key) is a resolution/lookup concern deferred to PR-2
// (bracketQualifiedKey), not core grammar — the last case below shows the
// boundary: two tokens from different milestones compare equal because the
// extracted token is milestone-blind by construction.
describe('bracket grammar: comparePhaseNum orders extracted bracket phase tokens', () => {
  const tok = (d) => core.extractPhaseToken(d, 'bracket');
  test('phase order: 05 < 12', () => {
    assert.ok(core.comparePhaseNum(tok('GSD.02-05'), tok('GSD.02-12')) < 0);
    assert.ok(core.comparePhaseNum(tok('GSD.02-12'), tok('GSD.02-05')) > 0);
  });

  test('sub-phase order: 05.03 < 05.10, and a bare phase sorts before its sub-phases', () => {
    assert.ok(core.comparePhaseNum(tok('GSD.02-05.03'), tok('GSD.02-05.10')) < 0);
    assert.ok(core.comparePhaseNum(tok('GSD.02-05'), tok('GSD.02-05.03')) < 0);
  });

  test('the extracted token is milestone-blind: same PP[.SS] across milestones compares equal (PR-2 owns qualified ordering)', () => {
    assert.strictEqual(core.comparePhaseNum(tok('GSD.02-05.03'), tok('CK.09-05.03')), 0);
  });
});

// ─── sentinel guard: isSentinelPhaseId / SENTINEL_RANGES ────────────────────
describe('bracket grammar: sentinel guard', () => {
  test('SENTINEL_RANGES are the {0, 999} milestone ranges', () => {
    assert.deepStrictEqual([...core.SENTINEL_RANGES], [0, 999]);
  });

  test('isSentinelPhaseId is true for milestone 0 / 999 across forms', () => {
    // Bracket forms: milestone in the `{CODE}.{MM}` prefix (gated on convention).
    assert.strictEqual(core.isSentinelPhaseId('GSD.999-01', 'bracket'), true);
    assert.strictEqual(core.isSentinelPhaseId('GSD.00-01', 'bracket'), true);
    // Legacy/bare leading-int forms need no convention.
    assert.strictEqual(core.isSentinelPhaseId('999.1'), true);
    assert.strictEqual(core.isSentinelPhaseId('0.1'), true);
  });

  test('isSentinelPhaseId is false for ordinary milestones and for tokens with no leading integer', () => {
    assert.strictEqual(core.isSentinelPhaseId('GSD.02-05', 'bracket'), false);
    assert.strictEqual(core.isSentinelPhaseId('2-01'), false);
    // Negative branch: a string with no leading integer at all → false.
    assert.strictEqual(core.isSentinelPhaseId('feature-branch'), false);
  });

  test('the bracket sentinel path is OFF by default: a convention-less #1324 dir is not a sentinel', () => {
    // `P0.0-foundation` is a real #1324 letter-prefixed phase, NOT milestone-0
    // sentinel. Auto-detecting the `P0`/`.0` prefix would be a false positive
    // (the same root ambiguity gated in extractPhaseToken), so without the
    // convention signal the legacy leading-int rule applies and returns false.
    assert.strictEqual(core.isSentinelPhaseId('P0.0-foundation'), false);
    assert.strictEqual(core.isSentinelPhaseId('P0.999-x'), false);
  });

  // SENTINEL_RANGES is the two DISCRETE values {0, 999} (an `.includes()`
  // membership test), not an inclusive numeric range — so a milestone just
  // inside either boundary (1, 998) and one just past the upper boundary
  // (1000) are all ordinary, non-sentinel milestones. Locks that boundary
  // shape across both the bracket and legacy reading paths.
  test('milestones 1, 998, and 1000 are NOT sentinels (boundary probe on the {0, 999} discrete set)', () => {
    assert.strictEqual(core.isSentinelPhaseId('GSD.01-01', 'bracket'), false);
    assert.strictEqual(core.isSentinelPhaseId('GSD.998-01', 'bracket'), false);
    assert.strictEqual(core.isSentinelPhaseId('GSD.1000-01', 'bracket'), false);
    assert.strictEqual(core.isSentinelPhaseId('1-01'), false);
    assert.strictEqual(core.isSentinelPhaseId('998-01'), false);
    assert.strictEqual(core.isSentinelPhaseId('1000-01'), false);
  });

  test('getMilestoneFromPhaseId resolves 1, 998, and 1000 to real milestones (not the sentinel null)', () => {
    assert.strictEqual(core.getMilestoneFromPhaseId('GSD.01-01', 'bracket'), 'v1.0');
    assert.strictEqual(core.getMilestoneFromPhaseId('GSD.998-01', 'bracket'), 'v998.0');
    assert.strictEqual(core.getMilestoneFromPhaseId('GSD.1000-01', 'bracket'), 'v1000.0');
    assert.strictEqual(core.getMilestoneFromPhaseId('1-01'), 'v1.0');
    assert.strictEqual(core.getMilestoneFromPhaseId('998-01'), 'v998.0');
    assert.strictEqual(core.getMilestoneFromPhaseId('1000-01'), 'v1000.0');
  });
});

// ─── slug guard: toDir never emits a path-traversal slug ────────────────────
describe('bracket grammar: toDir slug guard', () => {
  test('a hostile slug is sanitized to a safe filesystem token', () => {
    const id = core.parsePhaseId('[GSD.02] 05');
    const dir = core.toDir(id, '../../etc/passwd');
    assert.ok(!dir.includes('/'), `dir must not contain a path separator: ${dir}`);
    assert.ok(!dir.includes('..'), `dir must not contain '..': ${dir}`);
    assert.strictEqual(dir, 'GSD.02-05-etc-passwd');
  });

  test('a clean slug is preserved (round-trip unaffected)', () => {
    assert.strictEqual(core.toDir(core.parsePhaseId('[GSD.02] 05.03-01'), 'feature'), 'GSD.02-05.03-feature');
  });
});

// ─── toDir field validation: every interpolated PhaseId field is checked
// (review M1) ──────────────────────────────────────────────────────────────
// PhaseId is a structural (not nominal) type: nothing stops a caller from
// hand-building one and skipping parsePhaseId entirely. Only the slug was
// ever guarded, so a hand-built id with a hostile project/milestone/phase
// still reached the on-disk path unsanitized — a live traversal, not merely
// a theoretical one.
describe('bracket grammar: toDir validates every interpolated field (review M1)', () => {
  test('a path-traversal project is rejected', () => {
    const id = { project: '../../etc', milestone: '02', phase: '05' };
    assert.throws(() => core.toDir(id, 'feature'), /toDir:.*project/);
  });

  test('a lowercase project is rejected (does not match the project_code grammar)', () => {
    const id = { project: 'gsd', milestone: '02', phase: '05' };
    assert.throws(() => core.toDir(id, 'feature'), /toDir:.*project/);
  });

  test('an unpadded milestone is rejected (not the canonical pad2 shape)', () => {
    const id = { project: 'GSD', milestone: '5', phase: '05' };
    assert.throws(() => core.toDir(id, 'feature'), /toDir:.*milestone/);
  });

  test('a non-numeric phase is rejected', () => {
    const id = { project: 'GSD', milestone: '02', phase: '../etc' };
    assert.throws(() => core.toDir(id, 'feature'), /toDir:.*phase/);
  });

  test('a non-numeric subphase is rejected when present', () => {
    const id = { project: 'GSD', milestone: '02', phase: '05', subphase: '../etc' };
    assert.throws(() => core.toDir(id, 'feature'), /toDir:.*subphase/);
  });
});

// ─── toDir slug emptiness: no dangling trailing hyphen (review M2) ──────────
describe('bracket grammar: toDir rejects a slug that sanitizes to empty (review M2)', () => {
  test('a slug of only punctuation is rejected rather than emitting a trailing hyphen', () => {
    const id = core.parsePhaseId('[GSD.02] 05');
    assert.throws(() => core.toDir(id, '!!!'), /toDir:.*slug/);
    assert.throws(() => core.toDir(id, '...'), /toDir:.*slug/);
  });
});

// ─── toDir all-digit slug: collides with the plan grammar (review M3) ───────
describe('bracket grammar: toDir rejects an all-digit slug (review M3)', () => {
  test("a slug of '2026' is rejected — it would re-parse as a plan, not a slug", () => {
    const id = core.parsePhaseId('[GSD.02] 05');
    assert.throws(() => core.toDir(id, '2026'), /toDir:.*slug/);
  });
});

// ─── toDir slug type: non-string slugs are rejected, not stringified (nit) ──
describe('bracket grammar: toDir rejects a non-string slug', () => {
  test('undefined and null are rejected rather than coerced to the literal word', () => {
    const id = core.parsePhaseId('[GSD.02] 05');
    assert.throws(() => core.toDir(id, undefined), /toDir:.*slug/);
    assert.throws(() => core.toDir(id, null), /toDir:.*slug/);
  });
});

// ═══ m1: deterministic boundary coverage (re-review m1) ═════════════════════
// The fast-check domain (1–999, [a-z0-9] slugs) exercises the grammar's bounds
// only INCIDENTALLY. This section PINS them: the 2↔3-digit numeric-width
// boundary, a leading-zero 3-digit value, abusive slug content (null byte,
// control chars, unicode, absolute paths), whitespace-only, and very-long
// input. Every input below is a hand-written literal (never seeded from the
// renderer), and every expectation is the compiled lib's CURRENT behavior —
// this closes a proof gap, not a behavior gap. Placed against the toDir slug/
// field-validation cluster above so the absolute-path cases sit next to the
// `../../etc` traversal test they extend.

// ─── m1.1: numeric-width boundary 99/100/101 (identity grammar) ──────────────
// pad2() passes a ≥3-digit value through un-truncated and it carries no leading
// zero, so 99/100/101 are all canonical at the milestone/phase/subphase
// positions: parse→render round-trips and toDir emits them byte-for-byte
// (CANONICAL_NUMERIC_RE's `[1-9]\d{2,}` branch admits 100/101). The plan
// position is IDENTITY-symmetric too (parse/render accept all three) but is a
// filename-surface dimension only — toDir drops it from the dir string.
describe('bracket grammar: numeric-width boundary 99/100/101 (review m1)', () => {
  test('milestone width 99/100/101 round-trips through display, dir, and toDir', () => {
    for (const n of ['99', '100', '101']) {
      assert.deepStrictEqual(core.parsePhaseId(`[GSD.${n}] 05`), { project: 'GSD', milestone: n, phase: '05' }, n);
      assert.strictEqual(core.renderPhaseId(core.parsePhaseId(`[GSD.${n}] 05`)), `[GSD.${n}] 05`, n);
      assert.strictEqual(core.parsePhaseId(`GSD.${n}-05`).milestone, n, n);
      assert.strictEqual(core.toDir(core.parsePhaseId(`[GSD.${n}] 05`), 'feat'), `GSD.${n}-05-feat`, n);
    }
  });

  test('phase width 99/100/101 round-trips through display, dir, and toDir', () => {
    for (const n of ['99', '100', '101']) {
      assert.deepStrictEqual(core.parsePhaseId(`[GSD.02] ${n}`), { project: 'GSD', milestone: '02', phase: n }, n);
      assert.strictEqual(core.renderPhaseId(core.parsePhaseId(`[GSD.02] ${n}`)), `[GSD.02] ${n}`, n);
      assert.strictEqual(core.parsePhaseId(`GSD.02-${n}`).phase, n, n);
      assert.strictEqual(core.toDir(core.parsePhaseId(`[GSD.02] ${n}`), 'feat'), `GSD.02-${n}-feat`, n);
    }
  });

  test('subphase width 99/100/101 round-trips through display, dir, and toDir', () => {
    for (const n of ['99', '100', '101']) {
      assert.strictEqual(core.parsePhaseId(`[GSD.02] 05.${n}`).subphase, n, n);
      assert.strictEqual(core.renderPhaseId(core.parsePhaseId(`[GSD.02] 05.${n}`)), `[GSD.02] 05.${n}`, n);
      assert.strictEqual(core.parsePhaseId(`GSD.02-05.${n}`).subphase, n, n);
      assert.strictEqual(core.toDir(core.parsePhaseId(`[GSD.02] 05.${n}`), 'feat'), `GSD.02-05.${n}-feat`, n);
    }
  });

  test('plan width 99/100/101: parse/render accept all three (identity-symmetric); toDir drops the plan', () => {
    for (const n of ['99', '100', '101']) {
      // Identity grammar is symmetric at the plan position — plan >=100 is
      // accepted and round-trips (the plan-position cap lives ONLY in the
      // read-token source, pinned in m1.2 below, NOT in parsePhaseId).
      assert.strictEqual(core.parsePhaseId(`[GSD.02] 05-${n}`).plan, n, n);
      assert.strictEqual(core.renderPhaseId(core.parsePhaseId(`[GSD.02] 05-${n}`)), `[GSD.02] 05-${n}`, n);
      assert.strictEqual(core.parsePhaseId(`GSD.02-05-${n}`).plan, n, n);
      // toDir emits the dir with NO plan segment (plan is filename-surface only),
      // so all three widths collapse to the same slug-bearing dir.
      assert.strictEqual(core.toDir(core.parsePhaseId(`[GSD.02] 05-${n}`), 'feat'), 'GSD.02-05-feat', n);
    }
  });
});

// ─── m1.2: read-token width is POSITIONAL (plan capped, others admit 3+) ──────
// BRACKET_PHASE_TOKEN_SOURCE is the PR-2 READ-tolerance source, applied after
// the `{CODE}.` prefix is stripped, so its run is MM-PP[.SS][-LL]. milestone
// (leading, unbounded), phase (dash-1) and subphase (dot) are delimiter-
// disambiguated and admit the canonical `[1-9]\d{2,}` width; the slug-adjacent
// plan (dash-2) consumes the single-owner #2232 continuation seam `\d{2}(?!\d)`,
// so a plan >=100 is DELIBERATELY out of the token grammar. This is the landed
// positional divergence (see the block at the foot of
// tests/continuation-grammar-parity.test.cjs), pinned here at the 99/100/101
// boundary — asymmetry expected, NOT symmetry with the other positions.
describe('bracket grammar: read-token width is positional at 99/100/101 (review m1)', () => {
  const tok = (run) => run.match(new RegExp(`^${core.BRACKET_PHASE_TOKEN_SOURCE}`))?.[0];

  test('milestone / phase / subphase absorb 99, 100, and 101', () => {
    for (const n of ['99', '100', '101']) {
      assert.strictEqual(tok(`${n}-05`), `${n}-05`, `milestone ${n} (leading, unbounded)`);
      assert.strictEqual(tok(`02-${n}`), `02-${n}`, `phase ${n} (dash-1, delimiter-disambiguated)`);
      assert.strictEqual(tok(`02-05.${n}`), `02-05.${n}`, `subphase ${n} (dot, delimiter-disambiguated)`);
    }
  });

  test('plan (dash-2, slug-adjacent) absorbs 99 but NOT 100/101 — the #2232 cap holds', () => {
    assert.strictEqual(tok('02-05-99'), '02-05-99', 'a canonical 2-digit plan is absorbed');
    assert.strictEqual(tok('02-05-100'), '02-05', 'plan 100 is capped out of the token run');
    assert.strictEqual(tok('02-05-101'), '02-05', 'plan 101 is capped out of the token run');
  });
});

// ─── m1.3: leading-zero 3-digit value (007) is non-canonical everywhere ───────
// pad2('007') === '07' (parseInt drops the leading zeros), so the re-render /
// re-emit can never match the input — parsePhaseId rejects '007' as not-
// canonical at milestone/phase/subphase/plan, in BOTH the display and dir forms.
describe('bracket grammar: leading-zero 3-digit value (007) is rejected (review m1)', () => {
  test('display form rejects 007 in milestone / phase / subphase / plan', () => {
    for (const s of ['[GSD.007] 05', '[GSD.02] 007', '[GSD.02] 05.007', '[GSD.02] 05-007']) {
      assert.throws(() => core.parsePhaseId(s), /parsePhaseId: not canonical/, s);
    }
  });

  test('dir form rejects 007 in milestone / phase / subphase / plan', () => {
    for (const s of ['GSD.007-05', 'GSD.02-007', 'GSD.02-05.007', 'GSD.02-05-007']) {
      assert.throws(() => core.parsePhaseId(s), /parsePhaseId: not canonical/, s);
    }
  });
});

// ─── m1.4: slug content abuse — null byte / control / unicode ─────────────────
// Two layers, each pinned independently:
//   READ (parsePhaseId): a dir trailing segment is a read-tolerant slug, DROPPED
//   from the identity tuple. Any non-line-terminator content — null byte,
//   control char, accented letter, emoji — is accepted and dropped (never
//   stored, so it cannot smuggle a bad identity, and is never mis-read as a
//   plan). A LINE TERMINATOR (\n / \r) is rejected outright because the dir
//   regex's `.+` cannot cross it.
//   EMIT (toDir): the allow-list sanitizer `.replace(/[^a-z0-9]+/g,'-')`
//   collapses every non-[a-z0-9] run to a single hyphen (null / control / tab /
//   newline / path separator alike) and drops non-ASCII bytes; content that
//   sanitizes to nothing is rejected rather than emitting a dangling hyphen.
describe('bracket grammar: slug content abuse — null byte / control / unicode (review m1)', () => {
  const EMOJI = '\u{1F4A5}'; // 💥
  const ACCENTED = 'café'; // café

  test('parsePhaseId drops an abusive (non-line-terminator) trailing slug, keeping a clean tuple', () => {
    for (const bad of ['foo\x00bar', 'foo\x07bar', 'foo\tbar', ACCENTED, EMOJI]) {
      const id = core.parsePhaseId(`GSD.02-05-${bad}`);
      assert.deepStrictEqual(id, { project: 'GSD', milestone: '02', phase: '05' }, JSON.stringify(bad));
    }
  });

  test('a line terminator (\\n / \\r) in the slug position is rejected by the anchors', () => {
    assert.throws(() => core.parsePhaseId('GSD.02-05-foo\nbar'), /not a bracket phase id/);
    assert.throws(() => core.parsePhaseId('GSD.02-05-foo\rbar'), /not a bracket phase id/);
  });

  test('toDir sanitizes abusive slug content to a safe [a-z0-9-] token', () => {
    const id = core.parsePhaseId('[GSD.02] 05');
    assert.strictEqual(core.toDir(id, 'foo\x00bar'), 'GSD.02-05-foo-bar', 'null byte → hyphen');
    assert.strictEqual(core.toDir(id, 'foo\x07bar'), 'GSD.02-05-foo-bar', 'control char → hyphen');
    assert.strictEqual(core.toDir(id, 'a\nb'), 'GSD.02-05-a-b', 'newline → hyphen (safe on emit, unlike read)');
    assert.strictEqual(core.toDir(id, 'a\rb'), 'GSD.02-05-a-b', 'carriage return → hyphen');
    assert.strictEqual(core.toDir(id, ACCENTED), 'GSD.02-05-caf', 'non-ASCII dropped, trailing hyphen stripped');
  });

  test('toDir rejects a slug that sanitizes to empty (emoji-only / null-only) rather than a dangling hyphen', () => {
    const id = core.parsePhaseId('[GSD.02] 05');
    assert.throws(() => core.toDir(id, EMOJI), /toDir:.*slug/);
    assert.throws(() => core.toDir(id, '\x00'), /toDir:.*slug/);
  });
});

// ─── m1.5: absolute-path slug or project ─────────────────────────────────────
// Sibling of the `../../etc/passwd` traversal test above (toDir slug guard) and
// the hand-built-id field-validation block (review M1): the absolute-path
// (leading `/`) shapes, pinned next to the traversal shapes they extend.
describe('bracket grammar: absolute-path slug or project (review m1)', () => {
  test('an absolute-path slug is sanitized — leading slash and separators collapse away', () => {
    const id = core.parsePhaseId('[GSD.02] 05');
    const dir = core.toDir(id, '/etc/passwd');
    assert.ok(!dir.includes('/'), `dir must not contain a path separator: ${dir}`);
    assert.strictEqual(dir, 'GSD.02-05-etc-passwd');
  });

  test('an absolute-path project on a hand-built id is rejected by PROJECT_ID_RE', () => {
    assert.throws(() => core.toDir({ project: '/etc/passwd', milestone: '02', phase: '05' }, 'feat'), /toDir:.*project/);
    assert.throws(() => core.toDir({ project: '/etc', milestone: '02', phase: '05' }, 'feat'), /toDir:.*project/);
  });

  test('an absolute-path string is not a bracket phase id', () => {
    assert.throws(() => core.parsePhaseId('/etc/passwd'), /not a bracket phase id/);
  });

  test('an absolute-path slug embedded in a dir string is dropped, leaving a clean tuple (no `/` in any field)', () => {
    const id = core.parsePhaseId('GSD.02-05-/etc/passwd');
    assert.deepStrictEqual(id, { project: 'GSD', milestone: '02', phase: '05' });
  });
});

// ─── m1.6: whitespace-only input ─────────────────────────────────────────────
// (The empty string is already pinned above under the ambiguous-token block;
// these are the non-empty all-whitespace forms.)
describe('bracket grammar: whitespace-only input is rejected (review m1)', () => {
  test("' ', '   ', '\\t', '\\n', and '\\t\\n' all reject as not-a-bracket-phase-id", () => {
    for (const s of [' ', '   ', '\t', '\n', '\t\n']) {
      assert.throws(() => core.parsePhaseId(s), /not a bracket phase id/, JSON.stringify(s));
    }
  });
});

// ─── m1.7: very-long input (ReDoS smoke) ─────────────────────────────────────
// Behavioral (not timing) assertions: the grammar's regexes are linear — no
// nested quantifier over an overlapping class — so a 10k-char input resolves
// promptly; a catastrophic-backtracking regression would fail the run by
// timeout rather than by assertion.
describe('bracket grammar: very-long input handled promptly (review m1)', () => {
  const BIG = 'a'.repeat(10000);

  test('a 10k-char garbage string rejects promptly', () => {
    assert.throws(() => core.parsePhaseId(BIG), /not a bracket phase id/);
  });

  test('a partial-then-fail prefix (open bracket + 10k digits) rejects promptly', () => {
    assert.throws(() => core.parsePhaseId(`[GSD.${'0'.repeat(10000)}`), /not a bracket phase id/);
  });

  test('a 10k-char slug in a dir string parses (slug dropped) without hanging', () => {
    assert.deepStrictEqual(core.parsePhaseId(`GSD.02-05-${BIG}`), { project: 'GSD', milestone: '02', phase: '05' });
  });

  test('toDir sanitizes a 10k-char slug promptly to the expected token', () => {
    const dir = core.toDir(core.parsePhaseId('[GSD.02] 05'), BIG);
    assert.strictEqual(dir, `GSD.02-05-${BIG}`);
    assert.strictEqual(dir.length, 'GSD.02-05-'.length + 10000);
  });
});

// ─── canonical token/heading sources for the downstream read path (PR-2) ─────
describe('bracket grammar: exported canonical sources (drift-guard owner)', () => {
  test('BRACKET_PHASE_TOKEN_SOURCE matches the bracket numeric run (dot-or-dash sub-separator)', () => {
    const re = new RegExp(`^${core.BRACKET_PHASE_TOKEN_SOURCE}$`);
    // The bracket dir/heading numeric run: MM-PP[.SS] (dash milestone↔phase, dot phase↔subphase).
    assert.ok(re.test('02-05.03'), 'MM-PP.SS run');
    assert.ok(re.test('02-05'), 'MM-PP run');
    assert.ok(re.test('05.03'), 'PP.SS phase token');
    assert.ok(re.test('05'), 'bare phase');
    assert.ok(re.test('12A'), 'letter variant');
    assert.ok(!re.test('slug'), 'non-numeric is not a token');
  });

  test('PHASE_HEADING_PREFIX_SRC matches a bracket-or-Phase heading intro, not a bare number', () => {
    const re = new RegExp(`^${core.PHASE_HEADING_PREFIX_SRC}`);
    assert.ok(re.test('[GSD.02] 05: Title'), 'bracket prefix');
    assert.ok(re.test('Phase 5: Title'), 'Phase prefix');
    assert.ok(re.test('[GSD.02] Phase 5: Title'), 'bracket + Phase prefix');
    assert.ok(!re.test('05: Title'), 'a bare number is not a phase heading intro');
  });
});

// ─── fast-check generative properties (ADR Decision 4) ──────────────────────
// A genuinely generative project code over the repo's [A-Z][A-Z0-9_]* grammar.
const projectArb = fc
  .tuple(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
    fc.array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')), { maxLength: 5 }),
  )
  .map(([head, rest]) => head + rest.join(''));
// A clean slug over [a-z0-9], filtered to guarantee at least one letter: the
// mixed digit+letter shape (review M3) exercises alphanumeric words like
// 'v2ui' without ever generating an all-digit slug, which toDir now rejects
// (an all-digit slug collides with the plan grammar). Restricted to
// lowercase-plus-digit input so the slug guard's toLowerCase()/replace() is a
// no-op — safeSlug === slug holds, keeping the disk↔display bijection's dir-
// string equality assertion exact.
const slugArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 8 })
  .map((cs) => cs.join(''))
  .filter((s) => /[a-z]/.test(s));
// Spans 1–999 so the property domain genuinely includes 3+-digit milestone/
// phase/subphase/plan tokens (re-review Minor 1). pad2() passes a ≥3-digit
// value through unchanged (no truncation) and it carries no leading zero, so
// both the render round-trip and CANONICAL_NUMERIC_RE's dedicated `[1-9]\d{2,}`
// branch (exercised via toDir in the bijection property) hold at that width.
const numArb = fc.integer({ min: 1, max: 999 });
const optNumArb = fc.option(numArb, { nil: undefined });

describe('bracket grammar — properties (fast-check)', () => {
  test('round-trip: renderPhaseId(parsePhaseId(display)) === display for every well-formed display', () => {
    fc.assert(
      fc.property(projectArb, numArb, numArb, optNumArb, optNumArb, (proj, mm, pp, ss, ll) => {
        let display = `[${proj}.${p2(mm)}] ${p2(pp)}`;
        if (ss !== undefined) display += `.${p2(ss)}`;
        if (ll !== undefined) display += `-${p2(ll)}`;
        return core.renderPhaseId(core.parsePhaseId(display)) === display;
      }),
    );
  });

  test('disk↔display bijection: toDir(parse(display), slug) is the canonical dir and re-parses to the same identity', () => {
    fc.assert(
      fc.property(projectArb, numArb, numArb, optNumArb, slugArb, (proj, mm, pp, ss, slug) => {
        let display = `[${proj}.${p2(mm)}] ${p2(pp)}`;
        if (ss !== undefined) display += `.${p2(ss)}`;
        const id = core.parsePhaseId(display);
        const dir = core.toDir(id, slug);
        const expectedDir = `${proj}.${p2(mm)}-${p2(pp)}${ss !== undefined ? '.' + p2(ss) : ''}-${slug}`;
        if (dir !== expectedDir) return false;
        const back = core.parsePhaseId(dir);
        return (
          back.project === id.project &&
          back.milestone === id.milestone &&
          back.phase === id.phase &&
          back.subphase === id.subphase &&
          // A valid (letter-bearing) slug must never be read back as a plan
          // (review M3) — the bijection holds on the full identity tuple,
          // not just the milestone/phase/subphase dimensions.
          back.plan === undefined
        );
      }),
    );
  });

  // Non-canonical property (review B1): the round-trip property above only
  // ever feeds parsePhaseId a string produced by p2()-padding, so it cannot
  // exercise the rejection path at all. This property starts from a KNOWN
  // canonical display string and applies one structural mutation — stripping
  // a pad (milestone, phase, OR subphase), doubling the bracket/phase separator
  // space, over-padding a field, or adding stray whitespace — asserting
  // parsePhaseId throws on every one. The milestone/phase/subphase integers are
  // restricted to 1-9 here so `p2()` always actually pads (e.g. '05', not '42');
  // otherwise the "unpad" mutation could regenerate the same canonical string,
  // making the mutation a no-op instead of a genuine probe. `includeSub` (a
  // generated boolean) decides whether the canonical carries a `.SS` subphase;
  // the subphase-pad mutations (re-review Minor 2) force one in so there is
  // always a `.SS` to mutate, while the non-subphase mutations keep their
  // original no-subphase coverage whenever `includeSub` is false.
  const singleDigitArb = fc.integer({ min: 1, max: 9 });
  const mutationArb = fc.constantFrom(
    'unpad-milestone',
    'unpad-phase',
    'unpad-subphase',
    'overpad-milestone',
    'overpad-phase',
    'overpad-subphase',
    'double-space',
    'leading-space',
    'trailing-space',
  );

  test('non-canonical mutations of a canonical display string are always rejected', () => {
    fc.assert(
      fc.property(
        projectArb,
        singleDigitArb,
        singleDigitArb,
        singleDigitArb,
        fc.boolean(),
        mutationArb,
        (proj, mm, pp, ss, includeSub, mutation) => {
          const mmP = p2(mm);
          const ppP = p2(pp);
          const ssP = p2(ss);
          const isSubMutation = mutation === 'unpad-subphase' || mutation === 'overpad-subphase';
          // A subphase-pad mutation needs a `.SS` to act on, so force one in for
          // those cases; otherwise the generated boolean decides, preserving the
          // original no-subphase mutation coverage.
          const hasSub = includeSub || isSubMutation;
          const subCanon = hasSub ? `.${ssP}` : '';
          const canonical = `[${proj}.${mmP}] ${ppP}${subCanon}`;
          let mutated;
          switch (mutation) {
            case 'unpad-milestone': mutated = `[${proj}.${mm}] ${ppP}${subCanon}`; break;
            case 'unpad-phase': mutated = `[${proj}.${mmP}] ${pp}${subCanon}`; break;
            case 'unpad-subphase': mutated = `[${proj}.${mmP}] ${ppP}.${ss}`; break;
            case 'overpad-milestone': mutated = `[${proj}.0${mmP}] ${ppP}${subCanon}`; break;
            case 'overpad-phase': mutated = `[${proj}.${mmP}] 0${ppP}${subCanon}`; break;
            case 'overpad-subphase': mutated = `[${proj}.${mmP}] ${ppP}.0${ssP}`; break;
            case 'double-space': mutated = `[${proj}.${mmP}]  ${ppP}${subCanon}`; break;
            case 'leading-space': mutated = ` ${canonical}`; break;
            case 'trailing-space': mutated = `${canonical} `; break;
            default: throw new Error(`unreachable mutation: ${mutation}`);
          }
          // Sanity: every mutation above must actually change the string, or
          // the property would (correctly) fail to throw and falsely indict
          // the implementation instead of the generator.
          if (mutated === canonical) return false;
          try {
            core.parsePhaseId(mutated);
            return false; // did not throw — the mutation slipped through
          } catch {
            return true;
          }
        },
      ),
    );
  });
});

// ─── the #2232 reconciliation, generatively ─────────────────────────────────
// BRACKET_PHASE_TOKEN_SOURCE is the READ side; toDir is the EMIT side. The
// example tables pin specific strings, but the contract that actually matters
// is metamorphic and spans the pair: for every id the emit path can produce,
// the read path must collect exactly that id's numeric run — no more (the
// #2232 over-collection) and no less (the under-collection a verbatim
// exactly-2 cap would cause at 3+-digit widths). Tying the two together means a
// future change to either side fails here rather than drifting silently, which
// is the whole point of consuming the single-owner seam.
describe('bracket grammar — read/emit agreement on the token run (#2232)', () => {
  // A slug whose FIRST WORD is a >=3-digit number — the #2232 bug class itself
  // (roadmap phase "2026 Photos & Performance" → slug "2026-photos-…"). The
  // existing slugArb generates a single [a-z0-9] word and so can never produce
  // this shape; the collision only exists when a digit-run sits at a segment
  // boundary. Bounded at >=100 because a 2-digit first word is genuinely
  // ambiguous against a canonical plan — the seam's known, accepted limit,
  // identical on the M-NN path.
  const numberLeadingSlugArb = fc
    .tuple(
      fc.integer({ min: 100, max: 9999 }),
      fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 6 }),
    )
    .map(([lead, word]) => `${lead}-${word.join('')}`);

  test('a number-leading slug never bleeds into the token run', () => {
    fc.assert(
      fc.property(projectArb, numArb, numArb, optNumArb, numberLeadingSlugArb, (proj, mm, pp, ss, slug) => {
        const display = `[${proj}.${p2(mm)}] ${p2(pp)}${ss !== undefined ? '.' + p2(ss) : ''}`;
        const id = core.parsePhaseId(display);
        const dir = core.toDir(id, slug);

        // The run the emit path actually wrote, independent of the read regex.
        const expectedRun = `${p2(mm)}-${p2(pp)}${ss !== undefined ? '.' + p2(ss) : ''}`;

        // The read path, applied the way a PR-2 reader would: strip the
        // `{CODE}.` prefix, then collect the run with the exported source.
        const runInput = dir.slice(`${proj}.`.length);
        const collected = runInput.match(new RegExp(`^${core.BRACKET_PHASE_TOKEN_SOURCE}`))?.[0];
        if (collected !== expectedRun) return false;

        // And the strict parser agrees the slug is a slug, not a plan — the
        // #2232 failure mode was the reader and the parser disagreeing about
        // where the identity ends.
        const back = core.parsePhaseId(dir);
        return back.phase === p2(pp) && back.milestone === p2(mm) && back.plan === undefined;
      }),
    );
  });
});

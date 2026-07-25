/**
 * Tests for src/phase-id.cts (compiled to gsd-core/bin/lib/phase-id.cjs).
 *
 * Verifies behavioural contracts of the extracted pure phase-id helpers:
 *   - escapeRegex
 *   - normalizePhaseName
 *   - comparePhaseNum
 *   - extractPhaseToken
 *   - phaseTokenMatches
 *   - phaseMarkdownRegexSource
 *   - phaseMarkdownRegexSourceExact
 *   - getMilestoneFromPhaseId
 *   - getPhaseDirFromPhaseId
 *   - core.cjs re-export shims resolve to the exact same functions (single instance)
 *
 * ADR-857 rollout phase 2a / issue #865.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');
const fc = require('fast-check');

// ─── escapeRegex ─────────────────────────────────────────────────────────────

describe('escapeRegex', () => {
  test('escapes all regex special characters', () => {
    assert.strictEqual(phaseId.escapeRegex('.'), '\\.');
    assert.strictEqual(phaseId.escapeRegex('*'), '\\*');
    assert.strictEqual(phaseId.escapeRegex('+'), '\\+');
    assert.strictEqual(phaseId.escapeRegex('?'), '\\?');
    assert.strictEqual(phaseId.escapeRegex('^'), '\\^');
    assert.strictEqual(phaseId.escapeRegex('$'), '\\$');
    assert.strictEqual(phaseId.escapeRegex('{'), '\\{');
    assert.strictEqual(phaseId.escapeRegex('}'), '\\}');
    assert.strictEqual(phaseId.escapeRegex('('), '\\(');
    assert.strictEqual(phaseId.escapeRegex(')'), '\\)');
    assert.strictEqual(phaseId.escapeRegex('|'), '\\|');
    assert.strictEqual(phaseId.escapeRegex('['), '\\[');
    assert.strictEqual(phaseId.escapeRegex(']'), '\\]');
    assert.strictEqual(phaseId.escapeRegex('\\'), '\\\\');
  });

  test('leaves alphanumeric and hyphen characters unescaped', () => {
    assert.strictEqual(phaseId.escapeRegex('abc'), 'abc');
    assert.strictEqual(phaseId.escapeRegex('01-02'), '01-02');
    assert.strictEqual(phaseId.escapeRegex('v1.0'), 'v1\\.0');
  });

  test('coerces non-string values via String()', () => {
    assert.strictEqual(phaseId.escapeRegex(42), '42');
    assert.strictEqual(phaseId.escapeRegex(null), 'null');
    assert.strictEqual(phaseId.escapeRegex(undefined), 'undefined');
  });

  test('adversarial: path-traversal-like inputs are treated as literals', () => {
    const result = phaseId.escapeRegex('../../../etc/passwd');
    // The dots get escaped; slashes and alphanumeric pass through unchanged
    assert.strictEqual(result, '\\.\\./\\.\\./\\.\\./etc/passwd');
    // The result forms a valid regex (no throws)
    assert.doesNotThrow(() => new RegExp(result));
  });

  test('unicode passthrough', () => {
    assert.strictEqual(phaseId.escapeRegex('Phase Name'), 'Phase Name');
    assert.strictEqual(phaseId.escapeRegex('中文'), '中文');
  });
});

// ─── normalizePhaseName ───────────────────────────────────────────────────────

describe('normalizePhaseName', () => {
  test('zero-pads single-digit phase', () => {
    assert.strictEqual(phaseId.normalizePhaseName('1'), '01');
    assert.strictEqual(phaseId.normalizePhaseName('3'), '03');
  });

  test('leaves two-digit phase unchanged', () => {
    assert.strictEqual(phaseId.normalizePhaseName('12'), '12');
  });

  test('strips project_code prefix before normalizing', () => {
    assert.strictEqual(phaseId.normalizePhaseName('CK-01'), '01');
    assert.strictEqual(phaseId.normalizePhaseName('PROJ-3'), '03');
    assert.strictEqual(phaseId.normalizePhaseName('AB-12'), '12');
    assert.strictEqual(phaseId.normalizePhaseName('MANIFOLD-7'), '07');
    assert.strictEqual(phaseId.normalizePhaseName('APP1-7'), '07');
    assert.strictEqual(phaseId.normalizePhaseName('APP_1-7'), '07');
  });

  test('does not strip leading-underscore pseudo-prefix (#1455)', () => {
    // Valid project_code values must start with [A-Z]; leading underscores
    // (_FOO-7, _-7) are not valid codes and must not be stripped.
    assert.strictEqual(phaseId.normalizePhaseName('_FOO-7'), '_FOO-7');
    assert.strictEqual(phaseId.normalizePhaseName('_-7'), '_-7');
  });

  test('handles letter suffix (preserves original case per #1962)', () => {
    assert.strictEqual(phaseId.normalizePhaseName('12A'), '12A');
    assert.strictEqual(phaseId.normalizePhaseName('3b'), '03b');
  });

  test('handles decimal phase IDs', () => {
    assert.strictEqual(phaseId.normalizePhaseName('12.1'), '12.1');
    assert.strictEqual(phaseId.normalizePhaseName('3.10'), '03.10');
  });

  test('handles milestone-prefixed IDs (M-NN form)', () => {
    assert.strictEqual(phaseId.normalizePhaseName('1-1'), '01-01');
    assert.strictEqual(phaseId.normalizePhaseName('2-3'), '02-03');
    assert.strictEqual(phaseId.normalizePhaseName('1-2-3'), '01-02-03');
  });

  test('custom phase IDs: project_code prefix is stripped, then numeric part is normalized', () => {
    // The project-code prefix is stripped, leaving a numeric token that normalizes to '42' (no leading zero needed for 2+ digits).
    assert.strictEqual(phaseId.normalizePhaseName('PROJ-42'), '42');
    assert.strictEqual(phaseId.normalizePhaseName('AUTH-101'), '101');
    assert.strictEqual(phaseId.normalizePhaseName('MANIFOLD-117'), '117');
  });

  test('custom phase IDs with non-numeric remainder pass through as-is', () => {
    // No project_code pattern, no numeric match → return str as-is
    assert.strictEqual(phaseId.normalizePhaseName('my-phase'), 'my-phase');
  });

  test('coerces non-string values', () => {
    assert.strictEqual(phaseId.normalizePhaseName(5), '05');
  });
});

// ─── comparePhaseNum ──────────────────────────────────────────────────────────

describe('comparePhaseNum', () => {
  test('sorts numeric phases in ascending order', () => {
    const phases = ['03', '01', '10', '02'];
    const sorted = [...phases].sort(phaseId.comparePhaseNum);
    assert.deepStrictEqual(sorted, ['01', '02', '03', '10']);
  });

  test('compares single-digit vs two-digit correctly', () => {
    assert.ok(phaseId.comparePhaseNum('1', '02') < 0);
    assert.ok(phaseId.comparePhaseNum('02', '1') > 0);
    assert.strictEqual(phaseId.comparePhaseNum('1', '01'), 0);
  });

  test('handles decimal phases', () => {
    assert.ok(phaseId.comparePhaseNum('1', '1.1') < 0);
    assert.ok(phaseId.comparePhaseNum('1.1', '1.2') < 0);
    assert.ok(phaseId.comparePhaseNum('1.10', '1.9') > 0);
    assert.strictEqual(phaseId.comparePhaseNum('1.1', '01.1'), 0);
  });

  test('handles letter suffix ordering (no letter < A < B)', () => {
    assert.ok(phaseId.comparePhaseNum('01', '01A') < 0);
    assert.ok(phaseId.comparePhaseNum('01A', '01B') < 0);
    assert.ok(phaseId.comparePhaseNum('01B', '01') > 0);
  });

  test('handles milestone-prefixed IDs', () => {
    assert.ok(phaseId.comparePhaseNum('1-1', '1-2') < 0);
    assert.ok(phaseId.comparePhaseNum('2-1', '1-10') > 0);
    assert.ok(phaseId.comparePhaseNum('1-2-3', '1-2-4') < 0);
    assert.strictEqual(phaseId.comparePhaseNum('01-01', '1-1'), 0);
  });

  test('strips project_code prefix before comparing', () => {
    assert.strictEqual(phaseId.comparePhaseNum('CK-01', '01'), 0);
    assert.ok(phaseId.comparePhaseNum('CK-01', 'CK-02') < 0);
    assert.strictEqual(phaseId.comparePhaseNum('MANIFOLD-117', '117'), 0);
    assert.strictEqual(phaseId.comparePhaseNum('APP1-117', '117'), 0);
    assert.strictEqual(phaseId.comparePhaseNum('APP_1-117', '117'), 0);
  });

  test('handles non-parseable phase IDs via localeCompare fallback', () => {
    // Should not throw on non-numeric IDs
    const result = phaseId.comparePhaseNum('alpha', 'beta');
    assert.strictEqual(typeof result, 'number');
  });
});

// ─── extractPhaseToken ────────────────────────────────────────────────────────

describe('extractPhaseToken', () => {
  test('extracts simple numeric token from directory name', () => {
    assert.strictEqual(phaseId.extractPhaseToken('01-some-phase-name'), '01');
    assert.strictEqual(phaseId.extractPhaseToken('12A-feature'), '12A');
  });

  test('extracts milestone-prefixed numeric token', () => {
    assert.strictEqual(phaseId.extractPhaseToken('01-02-some-name'), '01-02');
    assert.strictEqual(phaseId.extractPhaseToken('02-03-04-deep'), '02-03-04');
  });

  test('extracts token with project_code prefix', () => {
    assert.strictEqual(phaseId.extractPhaseToken('CK-01-some-phase'), 'CK-01');
    assert.strictEqual(phaseId.extractPhaseToken('PROJ-12-feature'), 'PROJ-12');
    assert.strictEqual(phaseId.extractPhaseToken('MANIFOLD-117-feature'), 'MANIFOLD-117');
    assert.strictEqual(phaseId.extractPhaseToken('APP1-117-feature'), 'APP1-117');
    assert.strictEqual(phaseId.extractPhaseToken('APP_1-117-feature'), 'APP_1-117');
  });

  test('extracts glued letter-prefix phase tokens (#1324)', () => {
    assert.strictEqual(phaseId.extractPhaseToken('P0.3-tenant-primitives'), 'P0.3');
    assert.strictEqual(phaseId.extractPhaseToken('P0.0-foundation'), 'P0.0');
    assert.strictEqual(phaseId.extractPhaseToken('P0.16-gate'), 'P0.16');
    assert.strictEqual(phaseId.extractPhaseToken('M1-2-brain'), 'M1-2');
  });

  // #612/#2249: the #2043/#1324 letter-prefixed-decimal family has a NUMERIC-tail
  // variant (`P0.3-2`) the #1324 pins above never covered — every tail there is
  // non-numeric (`-tenant`, `-gate`) or hyphen-only (`M1-2`). PR-1 added a bracket
  // dir reader `{CODE}.{MM}-{PP}` to extractPhaseToken; because that shape is
  // string-indistinguishable from this family when the code ends in a digit, the
  // reader is GATED on an explicit `convention` arg. This characterization locks
  // the convention-less (legacy) reading byte-identical across the WHOLE family —
  // single- AND multi-digit tails — so the gate can never silently regress it.
  // (The multi-digit rows are precisely the ones no discriminator-tightening fix
  // could have preserved: `P0.12-34` stays ambiguous with a padded bracket dir,
  // whereas the convention gate is complete.)
  test('preserves the #2043 numeric-tail letter-prefixed family (convention-less, byte-identical)', () => {
    assert.strictEqual(phaseId.extractPhaseToken('P0.3-2-tenant'), 'P0.3-2');
    assert.strictEqual(phaseId.extractPhaseToken('P1.2-3'), 'P1.2-3');
    assert.strictEqual(phaseId.extractPhaseToken('A0.1-2'), 'A0.1-2');
    assert.strictEqual(phaseId.extractPhaseToken('X9.9-9-name'), 'X9.9-9');
    assert.strictEqual(phaseId.extractPhaseToken('P0.12-34-name'), 'P0.12-34');
    assert.strictEqual(phaseId.extractPhaseToken('P0.34-56-name'), 'P0.34-56');
    assert.strictEqual(phaseId.extractPhaseToken('P0X.3-2'), 'P0X.3-2');
  });

  test('returns the full dirName when no numeric token found', () => {
    assert.strictEqual(phaseId.extractPhaseToken('no-numeric'), 'no-numeric');
    assert.strictEqual(phaseId.extractPhaseToken('alpha'), 'alpha');
    assert.strictEqual(phaseId.extractPhaseToken('phase-name-01'), 'phase-name-01');
  });

  test('stops at first non-numeric-starting segment', () => {
    assert.strictEqual(phaseId.extractPhaseToken('01-02-name-03'), '01-02');
  });

  test('rejects a single-digit slug word after a phase number (#2043)', () => {
    // A phase dir like "46-6-rs-pipeline-orchestrator" (roadmap phase name
    // "6 Rs Pipeline Orchestrator" → slug "6-rs-...") must yield token "46",
    // not "46-6" — the "6" is the slug's first word, not a sub-phase segment.
    assert.strictEqual(phaseId.extractPhaseToken('46-6-rs-pipeline-orchestrator'), '46');
    assert.strictEqual(phaseId.extractPhaseToken('68-6-rs'), '68');
    // Legit cases are unaffected: a real zero-padded milestone-sub-phase pair
    // stays intact, and a single-digit sub-phase after a letter-prefixed
    // milestone id (e.g. "M1-2") is still valid.
    assert.strictEqual(phaseId.extractPhaseToken('01-02-some-name'), '01-02');
    assert.strictEqual(phaseId.extractPhaseToken('M1-2-brain'), 'M1-2');
    // Milestone-prefixed convention: "M1-" strips as a project-code prefix, so
    // the same rule fixes the slug-collision there too — a phase 46 named
    // "6 Rs …" under milestone M1 yields "M1-46", not "M1-46-6". Phase 6 under
    // M1 ("M1-6-rs") correctly stays "M1-6" (the 6 is the phase number).
    assert.strictEqual(phaseId.extractPhaseToken('M1-46-6-rs-pipeline-orchestrator'), 'M1-46');
    assert.strictEqual(phaseId.extractPhaseToken('M1-6-rs-pipeline'), 'M1-6');
    // Single-digit + letter-suffix phase id ("1A") is a real token, not a slug word.
    assert.strictEqual(phaseId.extractPhaseToken('1A-brain'), '1A');
  });

  test('rejects a ≥3-digit slug word after a phase number (#2232)', () => {
    // Roadmap phase name "2026 Photos & Performance" slugifies to
    // "2026-photos-performance"; dir "14-2026-photos-performance" must yield
    // token "14", not "14-2026" — the year is the slug's first word, not a
    // sub-phase segment (the residual case #2043 scoped out).
    assert.strictEqual(phaseId.extractPhaseToken('14-2026-photos-performance'), '14');
    assert.ok(
      phaseId.phaseTokenMatches('14-2026-photos-performance', phaseId.normalizePhaseName('14')),
      'phase 14 must match its own dir despite the year-leading slug',
    );
    // Boundary by continuation-segment digit width (the locked policy: a
    // continuation is EXACTLY the 2-digit zero-padded form the write side emits):
    assert.strictEqual(phaseId.extractPhaseToken('46-6-rs'), '46'); // 1-digit: slug word (#2043)
    assert.strictEqual(phaseId.extractPhaseToken('01-02-name'), '01-02'); // 2-digit: sub-phase
    assert.strictEqual(phaseId.extractPhaseToken('05-100-slug'), '05'); // 3-digit: slug word (policy)
    assert.strictEqual(phaseId.extractPhaseToken('14-2026-photos'), '14'); // 4-digit: year slug word
    // Milestone-prefixed variant collides the same way. Composed from parts
    // rather than written as one literal: GitGuardian's generic high-entropy
    // detector false-positives on the joined form (an alphanumeric run with
    // separators reads as a token/key shape to it). The assertion is identical;
    // only the source spelling changes.
    const mPrefix = 'M1';
    assert.strictEqual(
      phaseId.extractPhaseToken(`${mPrefix}-14-2026-photos`),
      `${mPrefix}-14`,
    );
  });
});

// ─── phaseTokenMatches ────────────────────────────────────────────────────────

describe('phaseTokenMatches', () => {
  test('matches exact token (case-insensitive)', () => {
    assert.ok(phaseId.phaseTokenMatches('01-some-phase', '01'));
    assert.ok(phaseId.phaseTokenMatches('12A-feature', '12A'));
    assert.ok(phaseId.phaseTokenMatches('12A-feature', '12a'));
  });

  test('matches with project_code prefix stripped', () => {
    assert.ok(phaseId.phaseTokenMatches('CK-01-phase', '01'));
    assert.ok(phaseId.phaseTokenMatches('PROJ-12-feature', '12'));
    assert.ok(phaseId.phaseTokenMatches('MANIFOLD-117-feature', '117'));
    assert.ok(phaseId.phaseTokenMatches('APP1-117-feature', '117'));
    assert.ok(phaseId.phaseTokenMatches('APP_1-117-feature', '117'));
  });

  test('matches glued letter-prefix phase dirs (#1324)', () => {
    assert.ok(phaseId.phaseTokenMatches('P0.3-tenant-primitives', 'P0.3'));
    assert.ok(phaseId.phaseTokenMatches('M1-2-brain', 'M1-2'));
    assert.ok(!phaseId.phaseTokenMatches('P0.3-tenant-primitives', 'P0.4'));
  });

  test('does not match when token differs', () => {
    assert.ok(!phaseId.phaseTokenMatches('01-some-phase', '02'));
    assert.ok(!phaseId.phaseTokenMatches('12A-feature', '12B'));
  });

  test('matches milestone-prefixed token', () => {
    assert.ok(phaseId.phaseTokenMatches('01-02-feature', '01-02'));
    assert.ok(!phaseId.phaseTokenMatches('01-02-feature', '01-03'));
  });
});

// ─── phaseMarkdownRegexSource ─────────────────────────────────────────────────

describe('phaseMarkdownRegexSource', () => {
  test('produces a regex source that matches zero-padded variants', () => {
    const src = phaseId.phaseMarkdownRegexSource('1');
    const re = new RegExp(src);
    assert.ok(re.test('1'));
    assert.ok(re.test('01'));
    assert.ok(re.test('001'));
  });

  test('produces source matching a two-digit phase', () => {
    const src = phaseId.phaseMarkdownRegexSource('12');
    const re = new RegExp(src);
    assert.ok(re.test('12'));
    assert.ok(re.test('012'));
    assert.ok(!re.test('13'));
  });

  test('handles letter suffix', () => {
    const src = phaseId.phaseMarkdownRegexSource('12A');
    const re = new RegExp(src, 'i');
    assert.ok(re.test('12A'));
    assert.ok(re.test('012A'));
  });

  test('handles decimal phases', () => {
    const src = phaseId.phaseMarkdownRegexSource('3.1');
    const re = new RegExp(src);
    assert.ok(re.test('3.1'));
    assert.ok(re.test('03.1'));
    assert.ok(!re.test('3.2'));
  });

  test('handles milestone-prefixed phase IDs', () => {
    const src = phaseId.phaseMarkdownRegexSource('1-2');
    const re = new RegExp(src);
    assert.ok(re.test('1-2'));
    assert.ok(re.test('01-02'));
    assert.ok(re.test('01-2'));
    assert.ok(!re.test('1-3'));
  });

  test('strips project_code prefix before building regex', () => {
    const withPrefix = phaseId.phaseMarkdownRegexSource('CK-01');
    const withoutPrefix = phaseId.phaseMarkdownRegexSource('01');
    assert.strictEqual(withPrefix, withoutPrefix);
    assert.strictEqual(phaseId.phaseMarkdownRegexSource('MANIFOLD-117'), phaseId.phaseMarkdownRegexSource('117'));
  });

  test('falls back to escaped literal for unparseable input', () => {
    const src = phaseId.phaseMarkdownRegexSource('v1.0');
    assert.strictEqual(typeof src, 'string');
    assert.ok(src.length > 0);
  });

  test('adversarial: phase num containing regex metacharacters is escaped', () => {
    // e.g. some exotic value that shouldn't break regexp construction
    const src = phaseId.phaseMarkdownRegexSource('3.1');
    // The literal dot in "3.1" should be escaped so it only matches a real dot
    const re = new RegExp(src);
    assert.ok(!re.test('3X1'), 'unescaped dot would match any char — must be escaped');
  });
});

// ─── phaseMarkdownRegexSourceExact ────────────────────────────────────────────

describe('phaseMarkdownRegexSourceExact', () => {
  test('returns escaped form for project-code-prefixed IDs', () => {
    const result = phaseId.phaseMarkdownRegexSourceExact('PROJ-42');
    // hyphen is not a regex special char so it passes through unescaped
    assert.strictEqual(result, 'PROJ-42');
    // The result is a valid regex source
    assert.doesNotThrow(() => new RegExp(result));
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact('MANIFOLD-117'), 'MANIFOLD-117');
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact('APP1-117'), 'APP1-117');
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact('APP_1-117'), 'APP_1-117');
  });

  test('returns null for non-prefixed IDs', () => {
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact('01'), null);
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact('12A'), null);
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact('1-2'), null);
  });

  test('null coercion: returns null for null/undefined', () => {
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact(null), null);
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact(undefined), null);
  });

  test('resulting regex matches the exact prefixed ID', () => {
    const src = phaseId.phaseMarkdownRegexSourceExact('AUTH-101');
    assert.ok(src !== null);
    const re = new RegExp(src);
    assert.ok(re.test('AUTH-101'));
    assert.ok(!re.test('AUTH-102'));
  });
});

// ─── getMilestoneFromPhaseId ──────────────────────────────────────────────────

describe('getMilestoneFromPhaseId', () => {
  test('returns vN.0 for a milestone-prefixed phase id', () => {
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('1-01'), 'v1.0');
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('02-03'), 'v2.0');
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('10-5'), 'v10.0');
  });

  test('returns null for non-milestone-prefixed IDs', () => {
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('01'), null);
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('12A'), null);
  });

  test('returns null for special sentinel milestones 0 and 999', () => {
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('0-1'), null);
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('999-1'), null);
  });

  test('strips project_code prefix before parsing', () => {
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('CK-2-01'), 'v2.0');
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('MANIFOLD-2-01'), 'v2.0');
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('APP1-2-01'), 'v2.0');
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('APP_1-2-01'), 'v2.0');
  });

  test('coerces non-string values', () => {
    // numeric doesn't match the milestone pattern — returns null
    assert.strictEqual(phaseId.getMilestoneFromPhaseId(42), null);
  });
});

// ─── getPhaseDirFromPhaseId ───────────────────────────────────────────────────

describe('getPhaseDirFromPhaseId', () => {
  test('returns null for non-milestone-format IDs', () => {
    assert.strictEqual(phaseId.getPhaseDirFromPhaseId('01', null, null), null);
    assert.strictEqual(phaseId.getPhaseDirFromPhaseId('12A', null, null), null);
  });

  test('constructs dir name from milestone-prefixed phase id (no name, no code)', () => {
    const result = phaseId.getPhaseDirFromPhaseId('1-2', null, null);
    assert.strictEqual(result, '01-02');
  });

  test('includes phaseName slug', () => {
    const result = phaseId.getPhaseDirFromPhaseId('1-2', 'My Feature', null);
    assert.strictEqual(result, '01-02-my-feature');
  });

  test('prepends projectCode when provided', () => {
    const result = phaseId.getPhaseDirFromPhaseId('1-2', 'Auth', 'CK');
    assert.strictEqual(result, 'CK-01-02-auth');
  });

  test('strips project_code from phaseId before parsing', () => {
    const result = phaseId.getPhaseDirFromPhaseId('CK-1-2', null, null);
    assert.strictEqual(result, '01-02');
    assert.strictEqual(phaseId.getPhaseDirFromPhaseId('MANIFOLD-1-2', null, null), '01-02');
    assert.strictEqual(phaseId.getPhaseDirFromPhaseId('APP1-1-2', null, null), '01-02');
    assert.strictEqual(phaseId.getPhaseDirFromPhaseId('APP_1-1-2', null, null), '01-02');
  });

  test('handles deep decomposition IDs (M-N-N)', () => {
    // m[2] is "02-03" for input "1-2-3" — split and pad each sub-part
    const result = phaseId.getPhaseDirFromPhaseId('1-2-3', null, null);
    assert.strictEqual(result, '01-02-03');
  });

  test('slug strips leading/trailing hyphens from phaseName', () => {
    const result = phaseId.getPhaseDirFromPhaseId('1-1', '  --some--name--  ', null);
    // normalize: replace non-alnum runs with hyphen, strip edges
    assert.ok(result !== null);
    assert.ok(!result.startsWith('-'));
    assert.ok(!result.endsWith('-'));
  });
});

// ─── parsePhaseFromProse (#2121, anchored — fixes #2111) ─────────────────────

describe('parsePhaseFromProse', () => {
  test('null / empty input yields null phase and name', () => {
    assert.deepEqual(phaseId.parsePhaseFromProse(null), { phase: null, name: null });
    assert.deepEqual(phaseId.parsePhaseFromProse(''), { phase: null, name: null });
  });

  test('#2111: a milestone-completion string carries no phase', () => {
    assert.equal(phaseId.parsePhaseFromProse('Milestone v0.5 complete').phase, null);
    assert.equal(phaseId.parsePhaseFromProse('Milestone v1.0 complete').phase, null);
    assert.equal(phaseId.parsePhaseFromProse('Milestone v2.10 complete').phase, null);
  });

  test('#2111: a bare version token or stray numeral is not a phase', () => {
    assert.equal(phaseId.parsePhaseFromProse('v0.5').phase, null);
    assert.equal(phaseId.parsePhaseFromProse('v1.0').phase, null);
    assert.equal(phaseId.parsePhaseFromProse('Fixed 12 bugs in v2.3').phase, null);
  });

  test('a genuine phase value (starting with the token) is parsed', () => {
    assert.deepEqual(phaseId.parsePhaseFromProse('3 of 4 (Delta)'), { phase: '3', name: 'Delta' });
    assert.deepEqual(phaseId.parsePhaseFromProse('3A — Delta'), { phase: '3A', name: 'Delta' });
    assert.equal(phaseId.parsePhaseFromProse('12.1: Setup').phase, '12.1');
    assert.equal(phaseId.parsePhaseFromProse('29 of 30').phase, '29');
    assert.equal(phaseId.parsePhaseFromProse('029').phase, '029');
  });

  test('a leading project-code prefix is tolerated but not captured (bare token)', () => {
    assert.equal(phaseId.parsePhaseFromProse('MEM-01 — Foo').phase, '01');
    assert.equal(phaseId.parsePhaseFromProse('AB-29 of 30').phase, '29');
  });

  test('an optional leading "Phase" label is tolerated', () => {
    assert.equal(phaseId.parsePhaseFromProse('Phase 3A — Delta').phase, '3A');
  });

  test('a status-word parenthetical is filtered from the name (preserved behavior)', () => {
    // parenName wins over the em-dash tail; "executing" is a status word → name null.
    assert.deepEqual(phaseId.parsePhaseFromProse('3A — Delta (executing)'), { phase: '3A', name: null });
    assert.equal(phaseId.parsePhaseFromProse('3 (complete)').name, null);
  });

  test('#2124 review: name quantifiers are length-bounded (ReDoS guard)', () => {
    // A parenthetical within the bound extracts; one longer than the bound is
    // NOT matched — the cap is what prevents O(n^2) backtracking on a crafted
    // untrusted value. Removing the bound would extract the long name → fail.
    assert.equal(phaseId.parsePhaseFromProse('3 (Delta)').name, 'Delta');
    assert.equal(phaseId.parsePhaseFromProse(`3 (${'x'.repeat(201)})`).name, null);
    // A long unterminated "(" run yields no name and still parses the phase.
    assert.deepEqual(phaseId.parsePhaseFromProse(`3 ${'('.repeat(5000)}`), { phase: '3', name: null });
  });

  test('#2124 review: non-string input is coerced, never throws', () => {
    assert.doesNotThrow(() => phaseId.parsePhaseFromProse(3));
    assert.equal(phaseId.parsePhaseFromProse(3).phase, '3');
    assert.deepEqual(phaseId.parsePhaseFromProse(true), { phase: null, name: null });
  });
});

// ─── stripConfiguredProjectCodePrefix (#2121 / #2104, config-aware) ───────────

describe('stripConfiguredProjectCodePrefix', () => {
  test('#2104: a foreign prefix is preserved (not collapsed to a bare phase)', () => {
    assert.equal(phaseId.stripConfiguredProjectCodePrefix('MEM-01', 'LKML'), 'MEM-01');
  });

  test('the configured prefix is stripped (case-insensitive)', () => {
    assert.equal(phaseId.stripConfiguredProjectCodePrefix('CK-01', 'CK'), '01');
    assert.equal(phaseId.stripConfiguredProjectCodePrefix('LKML-29', 'lkml'), '29');
    assert.equal(phaseId.stripConfiguredProjectCodePrefix('AB-29', 'AB'), '29');
  });

  test('a value with no prefix is returned unchanged', () => {
    assert.equal(phaseId.stripConfiguredProjectCodePrefix('01', 'CK'), '01');
    assert.equal(phaseId.stripConfiguredProjectCodePrefix('029', 'CK'), '029');
  });

  test('an absent/empty projectCode preserves the value verbatim', () => {
    assert.equal(phaseId.stripConfiguredProjectCodePrefix('MEM-01', ''), 'MEM-01');
    assert.equal(phaseId.stripConfiguredProjectCodePrefix('MEM-01', null), 'MEM-01');
    assert.equal(phaseId.stripConfiguredProjectCodePrefix('MEM-01', undefined), 'MEM-01');
  });
});

// ─── isForeignPrefixedPhaseQuery (#2121 / #2056) ─────────────────────────────

describe('isForeignPrefixedPhaseQuery', () => {
  test('a prefix that is not the configured code is foreign', () => {
    assert.equal(phaseId.isForeignPrefixedPhaseQuery('MEM-01', 'LKML'), true);
  });

  test('the configured prefix is not foreign (case-insensitive)', () => {
    assert.equal(phaseId.isForeignPrefixedPhaseQuery('CK-01', 'CK'), false);
    assert.equal(phaseId.isForeignPrefixedPhaseQuery('ck-01', 'CK'), false);
  });

  test('a value with no prefix is never foreign', () => {
    assert.equal(phaseId.isForeignPrefixedPhaseQuery('01', 'CK'), false);
    assert.equal(phaseId.isForeignPrefixedPhaseQuery('29', 'AB'), false);
  });

  test('a prefixed query with no configured code is foreign; a bare one is not', () => {
    assert.equal(phaseId.isForeignPrefixedPhaseQuery('MEM-01', ''), true);
    assert.equal(phaseId.isForeignPrefixedPhaseQuery('MEM-01', null), true);
    assert.equal(phaseId.isForeignPrefixedPhaseQuery('01', ''), false);
  });
});

// ─── roadmapPhaseLookupSources (#2121, owned here after the move) ─────────────

describe('roadmapPhaseLookupSources', () => {
  const PREFIX_TOLERANT = `${phaseId.OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}0*29`;

  test('a bare numeric query yields the numeric then prefix-tolerant sources', () => {
    const sources = phaseId.roadmapPhaseLookupSources('29');
    assert.deepEqual(sources, ['0*29', PREFIX_TOLERANT]);
  });

  test('the bare numeric source precedes the prefix-tolerant fallback', () => {
    const sources = phaseId.roadmapPhaseLookupSources('29');
    assert.ok(sources.indexOf('0*29') < sources.indexOf(PREFIX_TOLERANT));
  });

  test('a project-code-prefixed query adds the exact source first (3 sources)', () => {
    const sources = phaseId.roadmapPhaseLookupSources('AB-29');
    assert.equal(sources.length, 3);
    assert.equal(sources[0], 'AB-29');
    assert.ok(sources.includes('0*29'));
    assert.ok(sources.includes(PREFIX_TOLERANT));
  });

  test('zero-padding is tolerated: 029 resolves the same sources as 29', () => {
    assert.deepEqual(phaseId.roadmapPhaseLookupSources('029'), phaseId.roadmapPhaseLookupSources('29'));
  });

  test('sources are deduplicated', () => {
    const sources = phaseId.roadmapPhaseLookupSources('29');
    assert.equal(sources.length, new Set(sources).size);
  });
});

// ─── #2121 property tests (fast-check) ───────────────────────────────────────

describe('phase-id canonical surface — properties', () => {
  test('#2111 invariant: a "Milestone vX.Y complete" string never yields a phase', () => {
    fc.assert(
      fc.property(fc.nat(999), fc.nat(999), (major, minor) => {
        return phaseId.parsePhaseFromProse(`Milestone v${major}.${minor} complete`).phase === null;
      }),
    );
  });

  test('parse↔normalize: a "N of M" prose value extracts N, and it normalizes stably', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 1, max: 9999 }), (n, m) => {
        const parsed = phaseId.parsePhaseFromProse(`${n} of ${m}`);
        return (
          parsed.phase === String(n) &&
          phaseId.normalizePhaseName(parsed.phase) === phaseId.normalizePhaseName(String(n))
        );
      }),
    );
  });
});

// ─── #2232 continuation-cap property tests (fast-check) ──────────────────────

// An arbitrary run of digits, including leading-zero forms ("02", "007") that
// String(int) can never produce — the zero-padded shape is the whole point of
// the continuation rule, so the corpus must be able to generate it.
const digitRun = (min, max) =>
  fc.string({
    unit: fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'),
    minLength: min,
    maxLength: max,
  });

describe('#2232 continuation cap — properties', () => {
  test('a numeric segment is absorbed into the token IFF its digit run is exactly 2', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99 }), digitRun(1, 6), (lead, seg) => {
        const token = phaseId.extractPhaseToken(`${lead}-${seg}-photos-performance`);
        const absorbed = token === `${lead}-${seg}`;
        // The biconditional IS the rule: width 2 ⇔ absorbed. Anything else is
        // a slug word and must leave the token at the bare leading number.
        return absorbed === (seg.length === 2) && (absorbed || token === String(lead));
      }),
    );
  });

  test('the owner agrees with the observable extraction for every digit run', () => {
    fc.assert(
      fc.property(digitRun(1, 6), (seg) => {
        const absorbed = phaseId.extractPhaseToken(`14-${seg}-slug`) === `14-${seg}`;
        return phaseId.isPhaseContinuationSegment(seg) === absorbed;
      }),
    );
  });

  // Metamorphic: the read side (extractPhaseToken) must invert the write side
  // (getPhaseDirFromPhaseId), which zero-pads every component to 2 digits. This
  // ties the continuation cap to the convention it mirrors rather than to a
  // hand-picked example — if the write-side padding width ever changes, this
  // fails instead of silently drifting.
  test('metamorphic: a write-side phase dir round-trips to its own normalized phase id', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 99 }), (major, sub) => {
        const dir = phaseId.getPhaseDirFromPhaseId(`${major}-${sub}`, 'Some Phase Name', null);
        if (!dir) return true;
        return phaseId.extractPhaseToken(dir) === phaseId.normalizePhaseName(`${major}-${sub}`);
      }),
    );
  });

  // The #2232 bug itself, as a property: a phase NAME that slugifies to a
  // year-leading word must not perturb the round-trip.
  test('metamorphic: round-trip holds even when the phase name leads with a year (#2232)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1000, max: 9999 }),
        (major, sub, year) => {
          const dir = phaseId.getPhaseDirFromPhaseId(
            `${major}-${sub}`,
            `${year} Photos And Performance`,
            null,
          );
          if (!dir) return true;
          return phaseId.extractPhaseToken(dir) === phaseId.normalizePhaseName(`${major}-${sub}`);
        },
      ),
    );
  });
});

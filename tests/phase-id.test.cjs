/**
 * Tests for src/phase-id.cts (compiled to gsd-core/bin/lib/phase-id.cjs).
 *
 * Verifies behavioural contracts of the extracted pure phase-id helpers:
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
const { buildPhaseHeadingRegex: headingRegex } = require('../gsd-core/bin/lib/roadmap.cjs');
const fc = require('fast-check');

// escapeRegex moved off phase-id.cjs entirely in #3212 Phase 1 (#3412): it is
// now owned by the pattern-construction seam (src/pattern.cts, tests in
// tests/pattern.test.cjs) and phase-id.cjs no longer exports it — see
// tests/phase-id-drift-guard.test.cjs's CANONICAL list, which drops it for
// the same reason.

// ─── #3412 shared test helper ─────────────────────────────────────────────────
//
// phase-id.cts now delegates regex escaping to RegExp.escape via src/pattern.cts.
// RegExp.escape is MATCH-equivalent to the retired hand-rolled escaper but not
// TEXT-equivalent (it hex-escapes the first character and all hyphens), so any
// test that pinned the literal source text (e.g. `'0*29'`, `'PROJ-42'`) is
// brittle to that internal encoding, not to actual behavior. `headingRegex`
// (imported above as `buildPhaseHeadingRegex` from gsd-core/bin/lib/roadmap.cjs)
// is the SAME production function src/roadmap.cts's searchPhaseInContent uses to
// build its heading regex — not a hand-duplicated copy — so tests assert what
// matches and what doesn't — the real contract — rather than the escaper's
// spelling, with no parity gap against the production pattern.

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

describe('renderPhaseBranchName (#4126)', () => {
  const T = 'gsd/phase-{phase}-{slug}';

  test('substitutes a real slug and normalizes the phase number (negative control)', () => {
    assert.strictEqual(phaseId.renderPhaseBranchName(T, '1', 'setup'), 'gsd/phase-01-setup');
    assert.strictEqual(phaseId.renderPhaseBranchName(T, 'CK-3', 'auth'), 'gsd/phase-03-auth');
    assert.strictEqual(phaseId.renderPhaseBranchName(T, '45.14', 'golden-capture'), 'gsd/phase-45.14-golden-capture');
  });

  test('empty-string slug (name outside the transliterator) drops {slug} and the separator before it', () => {
    // Route 2 of #4126: phase_name resolved (e.g. CJK) but generateSlugInternal
    // returned '' — the tool must not fabricate a name it is not displaying.
    assert.strictEqual(phaseId.renderPhaseBranchName(T, '8', ''), 'gsd/phase-08');
  });

  test('null / undefined slug (no name segment) renders the same way as the empty-string route', () => {
    // Route 1 of #4126: a `07` directory — phase_name and phase_slug both null.
    assert.strictEqual(phaseId.renderPhaseBranchName(T, '7', null), 'gsd/phase-07');
    assert.strictEqual(phaseId.renderPhaseBranchName(T, '7', undefined), 'gsd/phase-07');
  });

  test('never substitutes the literal placeholder "phase", and stays distinguishable from a phase named "Phase"', () => {
    const empty = phaseId.renderPhaseBranchName(T, '8', '');
    assert.strictEqual(empty, 'gsd/phase-08');
    assert.notStrictEqual(empty, phaseId.renderPhaseBranchName(T, '8', 'phase'),
      'an empty slug must not collide with a phase genuinely slugged "phase"');
  });

  test('a leading {slug} drops the separator AFTER it instead', () => {
    assert.strictEqual(phaseId.renderPhaseBranchName('{slug}-{phase}', '4', ''), '04');
    assert.strictEqual(phaseId.renderPhaseBranchName('gsd/{slug}/{phase}', '4', ''), 'gsd/04');
  });

  test('a slash separator is dropped too, so no trailing slash survives (invalid ref otherwise)', () => {
    assert.strictEqual(phaseId.renderPhaseBranchName('gsd/phase-{phase}/{slug}', '8', ''), 'gsd/phase-08');
  });

  test('a preceding "/" is kept when a non-slash separator follows — hierarchy survives, the joiner goes', () => {
    // Adversarial review finding: `feature/{slug}-phase-{phase}` must not collapse
    // to `feature-phase-08`; `/` is a ref-hierarchy boundary, not a word joiner.
    assert.strictEqual(phaseId.renderPhaseBranchName('feature/{slug}-phase-{phase}', '8', ''), 'feature/phase-08');
    assert.strictEqual(phaseId.renderPhaseBranchName('gsd/{slug}_{phase}', '8', ''), 'gsd/08');
  });

  test('a slash run left behind by the drop is collapsed — "//" is not a valid ref component', () => {
    // Adversarial review finding (round 2): `feature/{slug}-/{phase}` dropped the
    // following `-` and left `feature//08`, which `git check-ref-format` rejects.
    assert.strictEqual(phaseId.renderPhaseBranchName('feature/{slug}-/{phase}', '8', ''), 'feature/08');
    assert.strictEqual(phaseId.renderPhaseBranchName('feature/{slug}_/{phase}', '8', ''), 'feature/08');
  });

  test('a truthy number slug is stringified, matching the prior .replace semantics', () => {
    assert.strictEqual(phaseId.renderPhaseBranchName('{slug}-{phase}', '8', 1), '1-08');
  });

  test('a template without {slug} is unaffected by an empty slug', () => {
    assert.strictEqual(phaseId.renderPhaseBranchName('gsd/phase-{phase}', '8', ''), 'gsd/phase-08');
    assert.strictEqual(phaseId.renderPhaseBranchName('gsd/phase-{phase}', '8', 'ignored'), 'gsd/phase-08');
  });

  test('returns null only when nothing is left to name', () => {
    assert.strictEqual(phaseId.renderPhaseBranchName('{slug}', '8', ''), null);
    assert.strictEqual(phaseId.renderPhaseBranchName('', '8', 'x'), null);
  });

  test('substitutes only the FIRST {slug}, matching the prior .replace(string) semantics at both call sites', () => {
    assert.strictEqual(phaseId.renderPhaseBranchName('{slug}/{phase}-{slug}', '2', 'x'), 'x/02-{slug}');
    assert.strictEqual(phaseId.renderPhaseBranchName('{slug}/{phase}-{slug}', '2', ''), '02-{slug}');
  });

  // Review nit (#4252, round 1): the truthy-slug path performs NO validation,
  // exactly preserving the `.replace(string, …)` semantics both call sites had.
  // Unreachable through either real call site — `phase_slug` is null or
  // `generateSlugInternal`'s output, which can never be whitespace-only or
  // all-separator — but the helper is exported and reusable, so the preserved
  // behavior is pinned here rather than left to be rediscovered as a regression.
  test('a pathological truthy slug is substituted verbatim — no validation, prior behavior preserved', () => {
    assert.strictEqual(phaseId.renderPhaseBranchName(T, '8', ' '), 'gsd/phase-08- ');
    assert.strictEqual(phaseId.renderPhaseBranchName(T, '8', '-'), 'gsd/phase-08--');
  });

  // Same nit, second half: the `//` collapse runs ONLY in the empty-slug branch.
  // The asymmetry is deliberate — collapsing on the truthy path would change
  // behavior #4126 is not scoped to touch, and no template in this repo reaches
  // it. Pinned so that it reads as a decision rather than an oversight.
  test('the double-slash collapse is empty-slug-only — a truthy slug leaves the template\'s own "//" alone', () => {
    assert.strictEqual(phaseId.renderPhaseBranchName('feature//{slug}', '8', 'x'), 'feature//x');
    assert.strictEqual(phaseId.renderPhaseBranchName('feature//{slug}', '8', ''), 'feature/');
  });

  // Same nit, third half: `phaseSlug` is typed `unknown`, so every shape that is
  // neither a string nor a truthy number must take the empty-slug route rather
  // than stringifying into the branch name. `0` and `NaN` are the interesting
  // pair — both are numbers and both are falsy, so both mean "no slug", never
  // "the slug 0".
  test('a non-string, non-truthy-number slug takes the empty-slug route, never String(value)', () => {
    for (const [label, shape] of [['{}', {}], ['[]', []], ['true', true], ['false', false], ['0', 0], ['NaN', NaN]]) {
      assert.strictEqual(phaseId.renderPhaseBranchName(T, '8', shape), 'gsd/phase-08', label);
    }
  });
});

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

// ─── isPhaseArtifact (#3511) ───────────────────────────────────────────────────
//
// Predicate for AGGREGATE phase-directory scans (uat-predicate.cts, phase.cts,
// state.cts, uat.cts, audit.cts) — answers "does fileName belong to THIS
// phase" so a stray, cross-phase, or ad-hoc file cannot contribute its status
// to a phase it does not belong to. See src/phase-id.cts's isPhaseArtifact
// docblock for the full contract and fail-safe rationale.

describe('isPhaseArtifact (#3511)', () => {
  test('plain: file matches its own phase dir, not a cross-phase dir', () => {
    assert.strictEqual(phaseId.isPhaseArtifact('03-VERIFICATION.md', '03-foo'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('04-VERIFICATION.md', '03-foo'), false);
  });

  test('ad-hoc worksheet: 03-CORRECTION-VERIFICATION.md belongs to 03-foo (it is the phase\'s own file)', () => {
    // Over-exclusion here would be a worse bug than #3511 itself — a phase's
    // own ad-hoc worksheet must never be treated as a stray.
    assert.strictEqual(phaseId.isPhaseArtifact('03-CORRECTION-VERIFICATION.md', '03-foo'), true);
  });

  test('letter suffix: token must match exactly, in both directions', () => {
    assert.strictEqual(phaseId.isPhaseArtifact('03A-VERIFICATION.md', '03A-foo'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('03-VERIFICATION.md', '03A-foo'), false,
      'a bare "03-" file must not belong to letter-suffixed phase dir "03A-foo"');
    assert.strictEqual(phaseId.isPhaseArtifact('03A-VERIFICATION.md', '03-foo'), false,
      'a letter-suffixed "03A-" file must not belong to bare phase dir "03-foo"');
  });

  test('decimal sub-phase: token must match exactly, not as a numeric prefix', () => {
    assert.strictEqual(phaseId.isPhaseArtifact('35.1-VERIFICATION.md', '35.1-foo'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('35.10-VERIFICATION.md', '35.1-foo'), false,
      '35.10-… must not match phase dir 35.1-foo despite the shared numeric prefix');
  });

  test('plan/summary shapes belong to their phase the same way VERIFICATION/UAT do', () => {
    assert.strictEqual(phaseId.isPhaseArtifact('03-01-SUMMARY.md', '03-foo'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('03-01-PLAN.md', '03-foo'), true);
  });

  test('project-code-prefixed dirs: both the prefixed and the project-code-STRIPPED reading belong (#3511 blocker 1)', () => {
    // Files are named by normalizePhaseName, which STRIPS the project code
    // (cmdScaffold, src/commands.cts) — files never carry the code, only the
    // directory does. `01-VERIFICATION.md` IS the real report cmdScaffold
    // writes into `CK-01-foundation`; excluding it locked in the #3511
    // follow-up defect (this assertion's polarity was inverted pre-fix).
    assert.strictEqual(phaseId.isPhaseArtifact('CK-01-VERIFICATION.md', 'CK-01-foo'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('01-VERIFICATION.md', 'CK-01-foo'), true,
      'the project-code-STRIPPED file is the real scaffold output and must belong to its own project-code-prefixed dir');
    assert.strictEqual(phaseId.isPhaseArtifact('02-VERIFICATION.md', 'CK-01-foo'), false,
      'a different phase number must still be excluded, project code aside');
  });

  test('#3511 blocker 2: unpadded dir "1-unpadded" — its own padded file belongs', () => {
    // #3511 blocker: dir "1-unpadded" has literal token "1"; cmdScaffold
    // writes the PADDED "01-VERIFICATION.md" into it via normalizePhaseName.
    assert.strictEqual(phaseId.isPhaseArtifact('01-VERIFICATION.md', '1-unpadded'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('02-VERIFICATION.md', '1-unpadded'), false);
  });

  test('#3511 blocker 3: digit-leading-slug family — own file uses the LEADING digit run, not the mis-absorbed token', () => {
    // "05-80-20-cleanup" tokenizes to "05-80-20" (#2528 mis-absorption), but
    // cmdScaffold writes "05-UAT.md"/"05-VERIFICATION.md" (leading digit run
    // only) — the same reading matchPhaseDirs' bare-integer fallback uses.
    assert.strictEqual(phaseId.isPhaseArtifact('05-UAT.md', '05-80-20-cleanup'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('05-VERIFICATION.md', '05-80-20-cleanup'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('80-VERIFICATION.md', '05-80-20-cleanup'), false,
      'the slug word "80" must not be mistaken for a real phase number');
    assert.strictEqual(phaseId.isPhaseArtifact('10-UAT.md', '10-24-7-autonomy'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('24-UAT.md', '10-24-7-autonomy'), false);
  });

  test('case-insensitive letter suffix (review item 8): "03A-VERIFICATION.md" belongs to lowercase-suffixed "03a-foo"', () => {
    assert.strictEqual(phaseId.isPhaseArtifact('03A-VERIFICATION.md', '03a-foo'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('03a-VERIFICATION.md', '03A-foo'), true);
  });

  // WARNING-2 (#3511 review): the `firstLetterPrefixed` include-everything
  // branch (bracket-convention ambiguity fail-safe, docblock "BRACKET
  // CONVENTION" section) was untested on its own — only the ZERO-SEGMENT
  // fail-safe below had direct coverage. Pinned here so a later flip to
  // `false` for this family is caught rather than silently shipped.
  test('#3511 WARNING-2: bracket-ambiguous letter-prefixed-decimal dirs (firstLetterPrefixed) are the deliberate include-everything fail-safe', () => {
    assert.strictEqual(phaseId.isPhaseArtifact('99-VERIFICATION.md', 'P0.3-2-slug'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('07-UAT.md', 'v2-migration'), true);
  });

  // WARNING-5 (#3511 review): pin actual behavior for a decimal sub-phase
  // token compared against a same-leading-number-but-different-sub-phase
  // artifact — the exact-token-match rule (not a numeric-prefix match).
  test('#3511 WARNING-5: "35-VERIFICATION.md" (bare, no sub-phase) does not belong to decimal sub-phase dir "35.1-slug"', () => {
    assert.strictEqual(phaseId.isPhaseArtifact('35-VERIFICATION.md', '35.1-slug'), false);
  });

  test('fail-safe: a dir name with no derivable token includes EVERY file (never exclude)', () => {
    // derivePhaseTokenSegments finds zero segments for these dir names (same
    // condition extractPhaseToken treats as "return dirName unchanged" —
    // see the 'returns the full dirName when no numeric token found' test
    // above). Excluding on an unreliable token would make an aggregate gate
    // silently permissive in the wrong direction (dropping the phase's own
    // real blockers) — worse than the cross-phase-contamination bug #3511
    // fixes. Every file must be treated as belonging to the phase instead.
    assert.strictEqual(phaseId.isPhaseArtifact('04-VERIFICATION.md', 'no-numeric'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('anything-at-all.md', 'alpha'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('99-UAT.md', 'phase-name-01'), true);
  });

  test('#3511 Fix 2: a bare "VERIFICATION.md"/"UAT.md" (no dash, no token of its own) belongs by containment', () => {
    // src/state.cts:3740's S006 filter matches `f.includes('VERIFICATION')`
    // with no dash requirement, so a bare `VERIFICATION.md` (a form
    // core-utils.cts, init.cts and verification.cts all treat as valid) was
    // silently excluded pre-fix — S006 drift detection lost, S007 wrongly
    // flipped on. Directory containment is the only signal for a token-less
    // file, and it is sufficient.
    assert.strictEqual(phaseId.isPhaseArtifact('VERIFICATION.md', '03-foo'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('UAT.md', '03-foo'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('VERIFICATION.md', 'CK-01-foo'), true);
    assert.strictEqual(phaseId.isPhaseArtifact('VERIFICATION.md', '1-unpadded'), true);
  });

  // ── Property: over-exclusion (#3511 follow-up) ───────────────────────────────
  //
  // Every "own file still contributes" assertion above uses a HAND-PICKED
  // fixture. This property generates across the real dirName shapes (padded /
  // unpadded, project-code-prefixed, digit-leading slugs, decimals, letter
  // suffixes) and asserts, for EACH, that the artifact name `cmdScaffold`
  // (src/commands.cts, via `normalizePhaseName`) would actually write into
  // that directory is a member — the exact invariant all three #3511
  // follow-up blockers violated, and the one no hand-picked fixture pins on
  // its own.
  test('property: the file cmdScaffold would write into a phase dir is always isPhaseArtifact-true for that dir', () => {
    const artifactType = fc.constantFrom('UAT', 'VERIFICATION', 'CONTEXT');

    // dirName shape generators mirroring the real on-disk families this
    // module's own docblocks (extractPhaseToken, matchPhaseDirs) enumerate.
    const letterSuffix = fc.constantFrom('', 'A', 'B', 'C');
    const projectCode = fc.constantFrom(null, 'CK', 'PROJ', 'APP1');
    const slugWord = fc.constantFrom('foo', 'cleanup', 'autonomy', 'follow-up');
    // Digit-leading-slug family (#2528): a second all-digit slug SEGMENT that
    // is NOT a genuine sub-phase — 2-3 digit words like "80", "100".
    const digitSlugSegment = fc.constantFrom(null, '80', '20', '100');

    const plainDirNameGen = fc.record({
      code: projectCode,
      padded: fc.boolean(),
      num: fc.integer({ min: 1, max: 99 }),
      letter: letterSuffix,
      digitSlug: digitSlugSegment,
      slug: slugWord,
    }).map(({ code, padded, num, letter, digitSlug, slug }) => {
      const numStr = padded ? String(num).padStart(2, '0') : String(num);
      const token = `${numStr}${letter}`;
      const codePrefix = code ? `${code}-` : '';
      const digitTail = digitSlug ? `-${digitSlug}` : '';
      return { dirName: `${codePrefix}${token}${digitTail}-${slug}`, phase: token };
    });

    // INFO-2 (#3511 review): a genuine decimal sub-phase dir (`05.3-slug`) —
    // the exact-token-match branch, not the digit-leading-slug fallback.
    const decimalDirNameGen = fc.record({
      code: projectCode,
      padded: fc.boolean(),
      major: fc.integer({ min: 1, max: 99 }),
      sub: fc.integer({ min: 1, max: 99 }),
      slug: slugWord,
    }).map(({ code, padded, major, sub, slug }) => {
      const majorStr = padded ? String(major).padStart(2, '0') : String(major);
      const token = `${majorStr}.${sub}`;
      const codePrefix = code ? `${code}-` : '';
      return { dirName: `${codePrefix}${token}-${slug}`, phase: token };
    });

    // INFO-2 (#3511 review): the letter-prefixed-decimal family (`P0.3-2-slug`)
    // — string-indistinguishable from a bracket-dir token without an explicit
    // convention signal, so `isPhaseArtifact` treats it as the deliberate
    // `firstLetterPrefixed` include-everything fail-safe (see WARNING-2 test
    // above): every candidate file belongs, by construction.
    const letterPrefixedDecimalDirNameGen = fc.record({
      prefix: fc.constantFrom('P0', 'M1', 'A2'),
      major: fc.integer({ min: 1, max: 20 }),
      sub: fc.integer({ min: 1, max: 20 }),
      slug: slugWord,
    }).map(({ prefix, major, sub, slug }) => ({
      dirName: `${prefix}.${major}-${sub}-${slug}`,
      phase: `${major}-${sub}`,
    }));

    const dirNameGen = fc.oneof(plainDirNameGen, decimalDirNameGen, letterPrefixedDecimalDirNameGen);

    fc.assert(
      fc.property(dirNameGen, artifactType, ({ dirName, phase }, type) => {
        const padded = phaseId.normalizePhaseName(phase);
        const writtenFile = `${padded}-${type}.md`;
        return phaseId.isPhaseArtifact(writtenFile, dirName);
      }),
      { numRuns: 200 },
    );
  });
});

// ─── scopeToPhase (#3511) ───────────────────────────────────────────────────
//
// scopeToPhase is a plain filter over isPhaseArtifact: `fileNames.filter(f =>
// isPhaseArtifact(f, phaseDirName))`. An earlier follow-up ("WARNING 4") added
// a rule that fell back to the unfiltered input whenever scoping would empty
// a non-empty candidate set — but that defeated the actual #3511 fix: a phase
// dir holding only a misfiled cross-phase report would publish that other
// phase's status as its own. The fallback rule has been REMOVED; an empty
// result is now the honest answer for "this phase has none of its own".
describe('scopeToPhase (#3511)', () => {
  test('mixed set: own file kept, stray dropped', () => {
    assert.deepStrictEqual(
      phaseId.scopeToPhase(['03-VERIFICATION.md', '04-VERIFICATION.md'], '03-foo'),
      ['03-VERIFICATION.md'],
    );
  });

  test('empty input: returns empty', () => {
    assert.deepStrictEqual(phaseId.scopeToPhase([], '03-foo'), []);
  });

  test('underivable dir token: every file passes through unchanged (isPhaseArtifact fail-safe)', () => {
    assert.deepStrictEqual(
      phaseId.scopeToPhase(['04-VERIFICATION.md', 'anything-at-all.md'], 'no-numeric'),
      ['04-VERIFICATION.md', 'anything-at-all.md'],
    );
  });

  test('#3511: a phase dir holding ONLY another phase\'s report scopes to empty — ' +
    'an empty result is the honest answer, not a reason to fall back to the stray', () => {
    // Removing this behavior is the whole point of #3511: returning
    // 04-VERIFICATION.md here would publish phase 04's status as phase 03's.
    assert.deepStrictEqual(
      phaseId.scopeToPhase(['04-VERIFICATION.md'], '03-foo'),
      [],
    );
  });

  test('property: a phase dir never scopes away its own canonically-named artifact', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        fc.stringMatching(/^[a-z]{1,8}$/),
        (num, slug) => {
          const padded = String(num).padStart(2, '0');
          for (const dirNum of new Set([padded, String(num)])) {
            const dirName = `${dirNum}-${slug}`;
            for (const fileNum of new Set([padded, String(num)])) {
              const own = `${fileNum}-VERIFICATION.md`;
              assert.deepStrictEqual(
                phaseId.scopeToPhase([own], dirName),
                [own],
                `${own} is phase ${dirNum}'s own artifact in ${dirName} and must survive scoping`,
              );
            }
          }
        },
      ),
      { numRuns: 300 },
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

  test('regex metacharacters in a phase id are neutralized, not interpreted (#3412)', () => {
    // The property RegExp.escape exists for: a literal metacharacter in the
    // phase id (the dot in "1.2") must not behave as a regex wildcard once the
    // source is compiled into the same heading regex production uses.
    const src = phaseId.phaseMarkdownRegexSource('1.2');
    const re = headingRegex(src);
    assert.ok(re.test('Phase 1.2: Title'));
    assert.ok(!re.test('Phase 1X2: Title'));
  });
});

// ─── phaseMarkdownRegexSourceExact ────────────────────────────────────────────

describe('phaseMarkdownRegexSourceExact', () => {
  test('returns escaped form for project-code-prefixed IDs', () => {
    // Source text is RegExp.escape's business (#3412) — the actual contract
    // is a non-null, compilable source that matches its own prefixed heading
    // and rejects the bare-numeric heading.
    for (const [id, bareHeadingNum, foreignPrefix] of [
      ['PROJ-42', '42', 'OTHER'],
      ['AB-29', '29', 'CK'],
      ['MANIFOLD-117', '117', 'OTHER'],
      ['APP1-117', '117', 'OTHER'],
      ['APP_1-117', '117', 'OTHER'],
    ]) {
      const result = phaseId.phaseMarkdownRegexSourceExact(id);
      assert.ok(result !== null, id);
      assert.doesNotThrow(() => new RegExp(result));
      const re = headingRegex(result);
      assert.ok(re.test(`Phase ${id}: Title`), `${id} must match its own heading`);
      assert.ok(!re.test(`Phase ${bareHeadingNum}: Title`), `${id} must not match the bare-numeric heading`);
      // #3599 regression: the exact source must be tied to the FULL prefixed
      // id, not just its trailing number — a different prefix with the same
      // number must not match (an impl returning `[A-Z]+-42` would pass every
      // assertion above but fail this one).
      assert.ok(
        !re.test(`Phase ${foreignPrefix}-${bareHeadingNum}: Title`),
        `${id} must not match a foreign-prefixed heading with the same number`,
      );
      // Case-insensitivity (the 'i' flag) — canonicalizes the same way a
      // literal would, despite the hex escape (#3412).
      assert.ok(re.test(`phase ${id.toLowerCase()}: title`));
    }
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

  test('a status-word parenthetical is filtered from the name', () => {
    // #2736 precedence change (the #1695 AC #3 residual): the em-dash name now
    // wins when it is a genuine name, so `3A — Delta (executing)` yields
    // 'Delta' (previously null — paren-priority harvested the status aside and
    // the status filter nulled it, losing the real name).
    assert.deepEqual(phaseId.parsePhaseFromProse('3A — Delta (executing)'), { phase: '3A', name: 'Delta' });
    assert.equal(phaseId.parsePhaseFromProse('3 (complete)').name, null);
  });

  test('#2736: status-keyword-aware precedence across the first-party writer shapes', () => {
    // completePhaseCore shape `N — Name (aside)`: the dash name wins; the
    // name's own parenthetical is no longer harvested as the whole name.
    assert.deepEqual(
      phaseId.parsePhaseFromProse('48 — Closer-ruling measurement (D1a)'),
      { phase: '48', name: 'Closer-ruling measurement' },
    );
    // beginPhaseCore shape `N (Name) — EXECUTING`: the dash tail is a status
    // keyword, so the parenthetical name still wins.
    assert.deepEqual(
      phaseId.parsePhaseFromProse('16 (Native Global Hotkey) — EXECUTING'),
      { phase: '16', name: 'Native Global Hotkey' },
    );
    // `N — COMPLETE` (state.cts phase-complete body line): status keyword on
    // the dash, no paren → no name.
    assert.deepEqual(phaseId.parsePhaseFromProse('5 — COMPLETE'), { phase: '5', name: null });
    // gsd2-import shape `N (slug) — Milestone: Title`: the dash tail is a
    // milestone label, not a name → the parenthetical still wins.
    assert.deepEqual(
      phaseId.parsePhaseFromProse('06 (setup) — Milestone: Foundation'),
      { phase: '06', name: 'setup' },
    );
    // Cross-AI review round 1: an em-dash INSIDE a parenthetical name must not
    // be mistaken for the name separator (the dash search runs on a
    // paren-stripped copy).
    assert.deepEqual(
      phaseId.parsePhaseFromProse('16 (Native — Global Hotkey) — EXECUTING'),
      { phase: '16', name: 'Native — Global Hotkey' },
    );
    // Cross-AI review round 1: status-LIKE dash tails beyond the canonical
    // three lose to a parenthetical name (broader precedence vocabulary +
    // the lone-ALL-CAPS-token heuristic), without changing which extracted
    // names are nulled.
    assert.equal(phaseId.parsePhaseFromProse('3 (Foundation) — COMPLETED').name, 'Foundation');
    assert.equal(phaseId.parsePhaseFromProse('3 (Name) — In progress').name, 'Name');
    assert.equal(phaseId.parsePhaseFromProse('3 (Name) — READY').name, 'Name');
    assert.equal(phaseId.parsePhaseFromProse('3 (Name) — WIP').name, 'Name');
    // With no parenthetical to prefer, an unknown dash tail stays the best guess.
    assert.equal(phaseId.parsePhaseFromProse('3 — WIP').name, 'WIP');
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
  test('a bare numeric query yields the numeric then prefix-tolerant sources', () => {
    const sources = phaseId.roadmapPhaseLookupSources('29');
    assert.equal(sources.length, 2);
    // Source text is RegExp.escape's business (#3412) — pin matching
    // behavior instead: source[0] matches the bare and zero-padded heading
    // but not a project-code-prefixed one; source[1] additionally tolerates
    // the prefix.
    const re0 = headingRegex(sources[0]);
    const re1 = headingRegex(sources[1]);
    assert.ok(re0.test('Phase 29: Title'));
    assert.ok(re0.test('Phase 029: Title'));
    assert.ok(!re0.test('Phase CK-29: Title'));
    assert.ok(re1.test('Phase CK-29: Title'));
    assert.ok(re1.test('Phase 29: Title'));
  });

  test('the bare numeric source precedes the prefix-tolerant fallback', () => {
    const sources = phaseId.roadmapPhaseLookupSources('29');
    // Behavioral ordering (#3412): the source that rejects a project-code
    // prefix must appear before the source that accepts one.
    const bareIdx = sources.findIndex((s) => !headingRegex(s).test('Phase CK-29: Title'));
    const prefixTolerantIdx = sources.findIndex((s) => headingRegex(s).test('Phase CK-29: Title'));
    assert.notEqual(bareIdx, -1);
    assert.notEqual(prefixTolerantIdx, -1);
    assert.ok(bareIdx < prefixTolerantIdx);
  });

  test('a project-code-prefixed query adds the exact source first (3 sources)', () => {
    const sources = phaseId.roadmapPhaseLookupSources('AB-29');
    assert.equal(sources.length, 3);
    // source[0] is the EXACT source (#3599): matches its own prefixed
    // heading and must NOT match the bare numeric heading — that ordering
    // is the whole point of #3599. Source text itself is RegExp.escape's
    // business (#3412).
    const reExact = headingRegex(sources[0]);
    assert.ok(reExact.test('Phase AB-29: Title'));
    assert.ok(!reExact.test('Phase 29: Title'));
    // #3599 regression: the exact source is tied to the FULL prefix, not just
    // the trailing number — a foreign prefix with the same number must not match.
    assert.ok(!reExact.test('Phase CK-29: Title'));
    // Case-insensitivity (the 'i' flag) — canonicalizes the same way a
    // literal would, despite the hex escape (#3412).
    assert.ok(reExact.test('phase ab-29: title'));
    // The remaining two sources behave as the numeric/prefix-tolerant pair.
    const rest = sources.slice(1).map(headingRegex);
    assert.ok(rest.some((re) => re.test('Phase 29: Title') && !re.test('Phase CK-29: Title')));
    assert.ok(rest.some((re) => re.test('Phase CK-29: Title')));
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

// ─── #2528 two-digit slug words + canonical dir-match selection ──────────────

describe('#2528 two-digit numeric slug words', () => {
  test('a 2-digit slug word is NOT re-read by the tokenizer, at any depth', () => {
    // Phase 10 named "24/7 Autonomy" → dir "10-24-7[-autonomy]". "24" is exactly
    // 2 digits (the gap between #2043's 1-digit and #2232's ≥3-digit guards) and
    // the 1-digit "7" that follows is the ONLY local signal that it might be a
    // slug word — but that signal cannot tell this dir apart from sub-phase 10.24
    // named "7-Zip Integration". Both readings are real, so the tokenizer commits
    // to neither: it reports the literal token and lets matchPhaseDirs (which has
    // a query) break the tie.
    for (const dir of ['10-24-7', '10-24-7-autonomy', '10-24-7-zip', '10-24-3d-printer']) {
      assert.strictEqual(phaseId.extractPhaseToken(dir), '10-24');
      assert.ok(
        phaseId.phaseTokenMatches(dir, phaseId.normalizePhaseName('10-24')),
        `${dir} must stay resolvable by its own literal id`,
      );
    }
    assert.strictEqual(phaseId.extractPhaseToken('M1-10-24-7'), 'M1-10-24');
  });

  test('a digit+letter slug word is not absorbed as a continuation', () => {
    // Phase 14 named "10x Growth" → dir "14-10x-growth". The write side only
    // emits PURE 2-digit continuation segments, so "10x" is a slug word.
    assert.strictEqual(phaseId.extractPhaseToken('14-10x-growth'), '14');
    assert.ok(phaseId.phaseTokenMatches('14-10x-growth', phaseId.normalizePhaseName('14')));
  });

  test('locked boundaries are unchanged (#2043 / #2232 / genuine sub-phases)', () => {
    assert.strictEqual(phaseId.extractPhaseToken('10-24'), '10-24'); // terminal sub-phase
    assert.strictEqual(phaseId.extractPhaseToken('10-24-setup'), '10-24'); // sub-phase + slug
    assert.strictEqual(phaseId.extractPhaseToken('02-03-04-deep'), '02-03-04'); // deep decomposition
    assert.strictEqual(phaseId.extractPhaseToken('46-6-rs'), '46'); // 1-digit slug word (#2043)
    assert.strictEqual(phaseId.extractPhaseToken('14-2026-photos'), '14'); // year slug word (#2232)
    // A ≥2-digit-run terminator does NOT rewind: the year-after-sub-phase
    // shape is locked by the #2232 metamorphic round-trip.
    assert.strictEqual(phaseId.extractPhaseToken('14-06-2026-photos-and-performance'), '14-06');
    assert.strictEqual(phaseId.extractPhaseToken('05-80-20-25abc'), '05-80-20');
    assert.strictEqual(phaseId.extractPhaseToken('10-01.2-setup'), '10-01.2');
    // The letter-prefixed family keeps its single-digit continuations.
    assert.strictEqual(phaseId.extractPhaseToken('M1-2-brain'), 'M1-2');
    assert.strictEqual(phaseId.extractPhaseToken('P0.3-tenant-primitives'), 'P0.3');
  });

  // Metamorphic: any phase name of the "NN/D …" family (24/7, 80/20 with a
  // 1-digit second word) slugifies to "NN-D-…". The dir must be REACHABLE by the
  // bare phase number — which is what #2528 reported — and the property is stated
  // on the resolution result, not on the token, because the token is exactly the
  // part no surface can decide from the name alone.
  test('metamorphic: a 2-digit/1-digit name family resolves from the bare phase number', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 10, max: 99 }),
        fc.integer({ min: 0, max: 9 }),
        (phase, w2, w1) => {
          const lead = String(phase).padStart(2, '0');
          const dir = `${lead}-${w2}-${w1}-autonomy`;
          const { matches } = phaseId.matchPhaseDirs([dir], phaseId.normalizePhaseName(String(phase)));
          return matches.length === 1 && matches[0] === dir;
        },
      ),
    );
  });
});

describe('#2528 matchPhaseDirs — canonical dir-match selection', () => {
  const M = (dirs, q) => phaseId.matchPhaseDirs(dirs, phaseId.normalizePhaseName(q));

  test('primary token matches win and never engage the fallback', () => {
    assert.deepStrictEqual(M(['10-ten', '11-other'], '10'), {
      matches: ['10-ten'],
      usedBareFallback: false,
    });
    // A digit-leading phase NAME never shadows a genuine primary match for the
    // same number: the fallback runs only when the primary pass found nothing.
    assert.deepStrictEqual(M(['10-24-7-autonomy', '10-ten'], '10'), {
      matches: ['10-ten'],
      usedBareFallback: false,
    });
    assert.deepStrictEqual(M(['46-06-rs'], '46-6'), {
      matches: ['46-06-rs'],
      usedBareFallback: false,
    });
  });

  test('bare-integer fallback resolves tokenizer-invisible digit-slug dirs', () => {
    // "80/20 Cleanup" → dir "05-80-20-cleanup" → token "05-80-20" (byte-
    // identical in shape to a genuine deep-decomposition dir, so the
    // tokenizer must not rewind it); the leading-digit-run fallback is the
    // resolution-level recovery.
    assert.deepStrictEqual(M(['05-80-20-cleanup', '11-other'], '5'), {
      matches: ['05-80-20-cleanup'],
      usedBareFallback: true,
    });
    assert.deepStrictEqual(M(['30-12-factor-refactor'], '30'), {
      matches: ['30-12-factor-refactor'],
      usedBareFallback: true,
    });
    // The originally reported dir is in the same family and takes the same route.
    assert.deepStrictEqual(M(['10-24-7-autonomy', '11-other'], '10'), {
      matches: ['10-24-7-autonomy'],
      usedBareFallback: true,
    });
  });

  // #2528 re-review. The two dirs below are string-indistinguishable — phase 10
  // named "24/7 Autonomy" and sub-phase 10.24 named "7-Zip Integration" — so the
  // ONLY sound arrangement is one where each is reachable by its own id and
  // neither is destroyed to serve the other. That is what splitting the work
  // between a literal tokenizer and a query-driven fallback buys; a tokenizer
  // that guesses can satisfy at most one of these four assertions per shape.
  test('both readings of a digit-leading NN-NN-<digit> name stay reachable', () => {
    assert.deepStrictEqual(M(['10-24-7-autonomy'], '10').matches, ['10-24-7-autonomy']);
    assert.deepStrictEqual(M(['10-24-7-zip'], '10').matches, ['10-24-7-zip']);
    // …and, the case the rewind heuristic silently lost:
    assert.deepStrictEqual(M(['10-24-7-zip'], '10-24').matches, ['10-24-7-zip']);
    assert.deepStrictEqual(M(['10-24-7-autonomy'], '10-24').matches, ['10-24-7-autonomy']);
  });

  test('fallback collisions surface every candidate for the #2237 ambiguity guard', () => {
    assert.deepStrictEqual(M(['05-80-20-a', '05-90-x'], '5'), {
      matches: ['05-80-20-a', '05-90-x'],
      usedBareFallback: true,
    });
  });

  test('non-bare queries never enter the fallback', () => {
    // Deep-decomposition and letter-suffix lookups are untouched (#2528 scope).
    assert.deepStrictEqual(M(['46-6-rs'], '46-6'), { matches: [], usedBareFallback: false });
    assert.deepStrictEqual(M(['12-x'], '12A'), { matches: [], usedBareFallback: false });
  });

  test('phaseNumberForMatch uses the leading digit run only for fallback matches', () => {
    assert.strictEqual(phaseId.phaseNumberForMatch('05-80-20-cleanup', true), '05');
    assert.strictEqual(phaseId.phaseNumberForMatch('MEM-05-80-20-cleanup', true), 'MEM-05');
    assert.strictEqual(phaseId.phaseNumberForMatch('10-24-setup', false), '10-24');
  });

  // The fallback compares a query against each directory's LEADING DIGIT RUN.
  // Its whole correctness rests on that run being captured entire before the
  // zero-strip compare: a regex that stopped at the first digit would make
  // every query a prefix match, and "1" would claim 10, 100, and 12 alike.
  // These are the digit-width transitions where that mistake shows up first.
  test('a bare query never prefix-matches a wider leading digit run', () => {
    const dirs = ['01-alpha', '09-nine', '10-ten', '12-twelve', '100-hundred'];
    assert.deepStrictEqual(M(dirs, '1').matches, ['01-alpha']);
    assert.deepStrictEqual(M(dirs, '9').matches, ['09-nine']);
    assert.deepStrictEqual(M(dirs, '10').matches, ['10-ten']);
    assert.deepStrictEqual(M(dirs, '100').matches, ['100-hundred']);
    // …and the same holds when only the wider dirs exist, so the assertion is
    // not being satisfied by an exact-width dir happening to be present.
    assert.deepStrictEqual(M(['10-ten', '100-hundred'], '1').matches, []);
    assert.deepStrictEqual(M(['90-ninety'], '9').matches, []);
  });

  // Property form of the same contract, over the whole integer corpus rather
  // than the hand-picked transitions above: a directory is returned only if its
  // own leading digit run IS the query. Stated as an invariant over the result
  // rather than an expected list, so it holds for primary and fallback matches
  // alike and cannot be satisfied by reimplementing the selection in the test.
  test('resolution never crosses leading-digit-run boundaries', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 999 }), { minLength: 2, maxLength: 6 }),
        fc.array(digitRun(1, 3), { minLength: 2, maxLength: 6 }),
        (leads, tails) => {
          const dirs = leads.map(
            (n, i) => `${String(n).padStart(2, '0')}-${tails[i % tails.length]}-slug`,
          );
          for (const q of leads) {
            for (const dir of M(dirs, String(q)).matches) {
              const run = dir.match(/^(\d+)/)[1].replace(/^0+(?=\d)/, '');
              if (run !== String(q)) return false;
            }
          }
          return true;
        },
      ),
    );
  });
});

// ─── #2736 prose name-precedence property tests (fast-check) ─────────────────

// #2821's only behavioral delta in parsePhaseFromProse is that a GENUINE
// (non-status) em-dash name now takes precedence over a parenthetical name;
// phase-token extraction and totality were unchanged by that commit.
//
// P1 and P9 are the delta guards: both fail against the pre-#2821 paren-first
// parser (verified by the standalone mutation check against
// parsePhaseFromProseOLD), because they each require the dash name to win
// over a co-present parenthetical — P9 additionally exercises the
// paren-stripped separator search, since the losing parenthetical itself
// contains an em-dash.
//
// P2, P3, P4 are characterization tests: they pin currently-true precedence
// contracts (status tails and em-dash-inside-parens both lose to a
// parenthetical name) that the pre-#2821 parser ALSO satisfied, so they guard
// against future regressions rather than proving the #2821 delta.
//
// P5-P8 pin totality and phase-token extraction, neither of which #2821
// changed.

const phaseToken = fc
  .tuple(
    digitRun(1, 3),
    fc.option(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), { nil: '' }),
    fc.array(digitRun(1, 2), { maxLength: 2 }),
  )
  .map(([lead, letter, decimals]) => `${lead}${letter}${decimals.map((d) => `.${d}`).join('')}`);

const STATUSY =
  /^(?:completed?|executing|not started|planning|planned|ready(?:\s+to\s+\S.{0,50})?|done|in progress|blocked|paused|verifying)$/i;

const genuineName = fc
  .string({
    unit: fc.constantFrom(
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
      'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
      ' ', 'A', 'B', 'C',
    ),
    minLength: 1,
    maxLength: 40,
  })
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !STATUSY.test(s) && !/^milestone\s*:/i.test(s) && !/^[A-Z][A-Z0-9_-]*$/.test(s));

const asideText = fc
  .string({
    unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_'),
    minLength: 1,
    maxLength: 30,
  })
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const statusTail = fc.constantFrom(
  'COMPLETE', 'COMPLETED', 'EXECUTING', 'READY', 'DONE', 'IN PROGRESS',
  'BLOCKED', 'PAUSED', 'VERIFYING', 'PLANNING', 'PLANNED', 'NOT STARTED',
);

const capsToken = fc.string({
  unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
  minLength: 2,
  maxLength: 12,
});

describe('#2736 prose name precedence — properties', () => {
  test('P1 dash name beats a trailing parenthetical aside', () => {
    fc.assert(
      fc.property(phaseToken, genuineName, asideText, (tok, name, aside) => {
        const p = phaseId.parsePhaseFromProse(`${tok} — ${name} (${aside})`);
        return p.phase === tok && p.name === name;
      }),
    );
  });

  test('P2 a status-keyword tail never displaces a parenthetical name', () => {
    fc.assert(
      fc.property(phaseToken, genuineName, statusTail, (tok, name, status) => {
        const p = phaseId.parsePhaseFromProse(`${tok} (${name}) — ${status}`);
        return p.phase === tok && p.name === name;
      }),
    );
  });

  test('P3 an em-dash inside parens is not mistaken for the separator', () => {
    fc.assert(
      fc.property(phaseToken, genuineName, genuineName, statusTail, (tok, a, b, status) => {
        const p = phaseId.parsePhaseFromProse(`${tok} (${a} — ${b}) — ${status}`);
        return p.phase === tok && p.name === `${a} — ${b}`;
      }),
    );
  });

  test('P4 a lone ALL-CAPS tail loses to a parenthetical name', () => {
    fc.assert(
      fc.property(phaseToken, genuineName, capsToken, (tok, name, caps) => {
        const p = phaseId.parsePhaseFromProse(`${tok} (${name}) — ${caps}`);
        return p.phase === tok && p.name === name;
      }),
    );
  });

  test('P5 parsePhaseFromProse is total over arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        const p = phaseId.parsePhaseFromProse(s);
        return (
          p !== null &&
          typeof p === 'object' &&
          (p.phase === null || typeof p.phase === 'string') &&
          (p.name === null || typeof p.name === 'string')
        );
      }),
    );
  });

  test('P6 pathological paren/em-dash runs stay total', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 400 }), (n) => {
        const p = phaseId.parsePhaseFromProse(`3 ${'('.repeat(n)}${'—'.repeat(n)}`);
        return p.phase === '3' && (p.name === null || typeof p.name === 'string');
      }),
    );
  });

  test('P7 the phase token round-trips out of first-party prose shapes', () => {
    fc.assert(
      fc.property(phaseToken, genuineName, (tok, name) =>
        phaseId.parsePhaseFromProse(`${tok} (${name})`).phase === tok &&
        phaseId.parsePhaseFromProse(`Phase ${tok} — ${name}`).phase === tok &&
        phaseId.parsePhaseFromProse(`${tok}`).phase === tok,
      ),
    );
  });

  test('P8 a milestone-prefixed token still yields the bare phase', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), minLength: 1, maxLength: 3 }),
        phaseToken,
        genuineName,
        (ms, tok, name) => phaseId.parsePhaseFromProse(`${ms}1-${tok} (${name})`).phase === tok,
      ),
    );
  });

  test('P9 a genuine dash name wins over a paren containing an em-dash', () => {
    fc.assert(
      fc.property(phaseToken, genuineName, genuineName, genuineName, (tok, a, b, name) => {
        const p = phaseId.parsePhaseFromProse(`${tok} (${a} — ${b}) — ${name}`);
        return p.phase === tok && p.name === name;
      }),
    );
  });

  // The STATUSY regex above is a test-local mirror of the private, unexported
  // STATUSY_TAIL_RE in src/phase-id.cts — it is not imported, only
  // reimplemented. If a future edit to the implementation's status
  // vocabulary drifts from this mirror, the properties above that rely on
  // STATUSY (P2, genuineName's exclusion filter, etc.) would silently weaken
  // rather than fail. This test pins the mirror to OBSERVABLE parser
  // behavior instead of source text, so a divergence fails loudly here.
  test('the test-local STATUSY mirror still agrees with the parser (divergence guard)', () => {
    const statusVocab = [
      'complete', 'completed', 'executing', 'not started', 'planning',
      'planned', 'ready', 'done', 'in progress', 'blocked', 'paused',
      'verifying',
    ];

    for (const w of statusVocab) {
      assert.equal(
        phaseId.parsePhaseFromProse(`3 (Real Name) — ${w}`).name,
        'Real Name',
        `expected status word "${w}" to lose to the parenthetical name`,
      );
      const upper = w.toUpperCase();
      assert.equal(
        phaseId.parsePhaseFromProse(`3 (Real Name) — ${upper}`).name,
        'Real Name',
        `expected status word "${upper}" to lose to the parenthetical name`,
      );
    }

    const nonStatusNames = ['Foundation', 'Native Hotkey', 'setup work'];
    for (const n of nonStatusNames) {
      assert.equal(
        phaseId.parsePhaseFromProse(`3 — ${n} (aside)`).name,
        n,
        `expected non-status name "${n}" to win as the dash name over the parenthetical aside`,
      );
    }
  });
});

// ─── phase-key derivations (#2562) ───────────────────────────────────────────

// #2562: the whole point of these living here is that a ROADMAP table cell and
// a phase DIRECTORY must land in ONE key space. Modules that derived their own
// regex for this is what let a `| 01. … |` row miss a `1-slug` directory, so
// the contract is unit-tested at the owner module, not only through consumers.
describe('phaseKeyFrom* — one key space for directories and prose', () => {
  test('every zero-padding spelling of a directory collapses to one key', () => {
    for (const dir of ['5-a', '05-a', 'PROJ-5-a', 'PROJ-05-a']) {
      assert.strictEqual(phaseId.phaseKeyFromDir(dir), '05', dir);
    }
  });

  test('every zero-padding spelling in prose collapses to the same key', () => {
    for (const prose of ['5. A', '05. A', '**5. A**', '`05. A`']) {
      assert.strictEqual(phaseId.phaseKeyFromProse(prose), '05', prose);
    }
  });

  test('a padded table cell and an unpadded directory produce the SAME key', () => {
    assert.strictEqual(phaseId.phaseKeyFromProse('01. Setup'), phaseId.phaseKeyFromDir('1-setup'));
    assert.strictEqual(phaseId.phaseKeyFromProse('30. Rollout'), phaseId.phaseKeyFromDir('030-rollout'));
  });

  test('sub-phase keys keep their decimal segment', () => {
    assert.strictEqual(phaseId.phaseKeyFromDir('30.1-follow-up'), '30.1');
    assert.strictEqual(phaseId.phaseKeyFromProse('**05.1 Follow-up**'), '05.1');
  });

  test('prose that does not begin with a phase token is null, not a bogus key', () => {
    assert.strictEqual(phaseId.phaseKeyFromProse('Not a phase'), null);
    assert.strictEqual(phaseId.phaseKeyFromProse(null), null);
    assert.strictEqual(phaseId.phaseKeyFromProse(undefined), null);
  });

  test('parentPhaseKey resolves a sub-phase to its parent and a top-level to null', () => {
    assert.strictEqual(phaseId.parentPhaseKey('30.1'), '30');
    assert.strictEqual(phaseId.parentPhaseKey('05.12'), '05');
    assert.strictEqual(phaseId.parentPhaseKey('30'), null);
  });

  test('property: padding a directory number never changes its key', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 0, max: 3 }),
        (num, pad) => {
          const padded = String(num).padStart(String(num).length + pad, '0');
          return phaseId.phaseKeyFromDir(`${padded}-slug`) === phaseId.phaseKeyFromDir(`${num}-slug`);
        },
      ),
    );
  });
});

// ─── #4126 branch-name renderer property tests (fast-check) ──────────────────

// A WELL-FORMED phase-branch template: word segments joined by exactly one
// separator, with exactly one `{slug}` token and at most one `{phase}`.
// "Well-formed" is load-bearing rather than convenient. A template that already
// carries a doubled or trailing separator (`feature//{slug}`) keeps that
// artifact across the drop, so the containment property below is a statement
// about what the DROP introduces, never about what the template brought with it.
const branchWord = fc.constantFrom('gsd', 'feature', 'fix', 'phase', 'wip', 'team');
const branchSep = fc.constantFrom('-', '_', '.', '/');

// `{phase}` goes at an ARBITRARY position among the parts, not just at an end.
// Restricting it to the two ends was a measured blind spot: the corpus then
// never generated the repo's OWN default arrangement, `gsd/phase-{phase}-{slug}`,
// where `{phase}` is internal and precedes `{slug}`. A location-sensitive
// regression that renders that template as the invalid `gsd/phase-08-` passed
// the edge-separator property against the ends-only corpus.
const assemble = (before, after, withPhase, phaseAt, joins) => {
  const parts = [...before, '{slug}', ...after];
  if (withPhase) parts.splice(phaseAt % (parts.length + 1), 0, '{phase}');
  return parts.reduce((acc, part, i) => `${acc}${joins[i % joins.length]}${part}`);
};

// Known real-world arrangements, seeded into the corpus directly rather than
// left to generation. Only the first is a SHIPPED default (`git.phase_branch_template`,
// docs/CONFIGURATION.md); the rest are supported custom shapes this file already
// characterizes. Seeding raises the odds these arrangements are exercised — it does
// NOT guarantee any single one is drawn, which is why the default template is also
// asserted deterministically inside the edge-separator property below.
const knownTemplate = fc.constantFrom(
  'gsd/phase-{phase}-{slug}',
  'gsd/phase-{phase}',
  'feature/{slug}-phase-{phase}',
  'gsd/phase-{phase}/{slug}',
);

const wellFormedTemplate = fc.oneof(
  knownTemplate,
  fc
    .record({
      before: fc.array(branchWord, { maxLength: 2 }),
      after: fc.array(branchWord, { maxLength: 2 }),
      withPhase: fc.boolean(),
      phaseAt: fc.nat({ max: 8 }),
      seps: fc.array(branchSep, { minLength: 6, maxLength: 6 }),
    })
    .map(({ before, after, withPhase, phaseAt, seps }) =>
      assemble(before, after, withPhase, phaseAt, seps),
    ),
);

// A template whose joins may be a RUN of two separators. This is the shape that
// actually reaches the `/\\/{2,}/g` collapse — `feature/{slug}-/{phase}` drops the
// `-` and leaves `feature//08` — and it is kept separate from the well-formed
// generator on purpose: a run can also leave a legitimately trailing separator
// (`a--{slug}` renders `a-`), so only the no-`//` clause is true of it.
const runSeparatorTemplate = fc
  .record({
    before: fc.array(branchWord, { maxLength: 2 }),
    after: fc.array(branchWord, { maxLength: 2 }),
    withPhase: fc.boolean(),
    phaseAt: fc.nat({ max: 8 }),
    seps: fc.array(fc.array(branchSep, { minLength: 1, maxLength: 2 }), {
      minLength: 6,
      maxLength: 6,
    }),
  })
  .map(({ before, after, withPhase, phaseAt, seps }) =>
    assemble(
      before,
      after,
      withPhase,
      phaseAt,
      seps.map((run) => run.join('')),
    ),
  );

// The alphabet `generateSlugInternal` can actually emit: lowercase alphanumeric
// runs joined by single hyphens, never empty and never edge-hyphenated.
const realSlug = fc
  .array(fc.stringMatching(/^[a-z0-9]{1,6}$/), { minLength: 1, maxLength: 3 })
  .map((words) => words.join('-'));

describe('#4126 renderPhaseBranchName — properties', () => {
  // The reported defect itself, stated as an invariant rather than as the one
  // hand-picked example above: whatever the template, a phase with no derivable
  // slug must never render the branch name a phase genuinely slugged "phase"
  // would get. That collision is precisely what `|| 'phase'` produced.
  test('an empty slug never collides with a phase genuinely slugged "phase"', () => {
    fc.assert(
      fc.property(wellFormedTemplate, fc.integer({ min: 0, max: 999 }), (template, num) => {
        // Precondition: a template carrying no `{slug}` renders identically for
        // every slug — `gsd/phase-{phase}` is a supported shape (not the shipped
        // default) and the example block already pins it. Nothing to collide.
        if (!template.includes('{slug}')) return true;
        const nameless = phaseId.renderPhaseBranchName(template, String(num), '');
        return nameless !== phaseId.renderPhaseBranchName(template, String(num), 'phase');
      }),
    );
  });

  // Boundary containment. Deliberately scoped to SINGLE-`{slug}` templates:
  // only the first `{slug}` is substituted (pinned by the example test above),
  // so a two-token template legitimately renders a literal `{slug}` and a
  // blanket "the output never contains {slug}" invariant would be false against
  // this function's own documented contract.
  test('the drop leaves no {slug} token and no edge separator behind', () => {
    // DETERMINISTIC first, sampled second. `fc.oneof` makes the shipped default
    // statistically reachable, never guaranteed to be drawn on any given run —
    // so the one arrangement that must never be missed is asserted outright.
    // This is the shape the ends-only corpus could not generate at all.
    for (const num of ['0', '8', '45.14', '999']) {
      const out = phaseId.renderPhaseBranchName('gsd/phase-{phase}-{slug}', num, '');
      assert.ok(
        out && !out.includes('{slug}') && !/^[-_./]/.test(out) && !/[-_./]$/.test(out),
        `default template with an empty slug rendered ${JSON.stringify(out)}`,
      );
    }
    fc.assert(
      fc.property(wellFormedTemplate, fc.integer({ min: 0, max: 999 }), (template, num) => {
        const out = phaseId.renderPhaseBranchName(template, String(num), '');
        if (out === null) return true; // `{slug}` alone — the documented "nothing left to name" case
        return !out.includes('{slug}') && !/^[-_./]/.test(out) && !/[-_./]$/.test(out);
      }),
    );
  });

  // The collapse's own invariant, and it needs the run-separator generator to be
  // reachable at all: a single-separator template can never leave a slash run
  // behind, so asserting no-`//` over that corpus would pass vacuously. `//` is
  // not a valid ref component, so this one holds for ANY template shape.
  test('a slash run left by the drop is always collapsed, whatever the template', () => {
    fc.assert(
      fc.property(runSeparatorTemplate, fc.integer({ min: 0, max: 999 }), (template, num) => {
        const out = phaseId.renderPhaseBranchName(template, String(num), '');
        return out === null || !out.includes('//');
      }),
    );
  });

  // Containment, not round-trip: this asserts the slug SURVIVES into the output,
  // which is weaker than reconstructing an input from an output. Named for what
  // it checks rather than for the nearest invariant category.
  test('a real slug always survives into the rendered name', () => {
    fc.assert(
      fc.property(
        wellFormedTemplate,
        fc.integer({ min: 0, max: 999 }),
        realSlug,
        (template, num, slug) => {
          if (!template.includes('{slug}')) return true; // nothing to survive into
          const out = phaseId.renderPhaseBranchName(template, String(num), slug);
          return out !== null && out.includes(slug);
        },
      ),
    );
  });

  // Monotonicity — the formal statement of "the empty-slug arm removes, and
  // never adds". The placeholder substitution #4126 removed did the opposite:
  // it made the nameless render LONGER than some real-slug renders, which is
  // how `gsd/phase-08-phase` came to out-name an honestly slugged phase.
  test('the empty-slug render is strictly shorter than any real-slug render', () => {
    fc.assert(
      fc.property(
        wellFormedTemplate,
        fc.integer({ min: 0, max: 999 }),
        realSlug,
        (template, num, slug) => {
          if (!template.includes('{slug}')) return true; // no token to drop, so no shortening
          const nameless = phaseId.renderPhaseBranchName(template, String(num), '');
          const named = phaseId.renderPhaseBranchName(template, String(num), slug);
          if (nameless === null) return true; // `{slug}` alone — no nameless render to compare
          return named !== null && nameless.length < named.length;
        },
      ),
    );
  });
});

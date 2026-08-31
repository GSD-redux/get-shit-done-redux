/**
 * Pure phase-id parsing/matching helpers — normalize, token match,
 * milestone/phase-dir id parsing, phase-markdown regex builders.
 *
 * Extracted from core.cts (ADR-857 rollout phase 2a / issue #865).
 * The hand-written bodies are preserved byte-for-behaviour; only the module
 * boundary moved. The core.cjs re-export spine was retired in epic #1267;
 * callers import phase-id helpers from phase-id.cjs directly.
 *
 * Dependencies:
 *   - ./pattern.cjs (escapeRegex — #3212 Phase 1 seam; this module is no
 *     longer the owner of pattern-escaping, only a consumer)
 *   - ./core-utils.cjs (generateSlugInternal — #3883/ADR-3473 §8.3: the
 *     canonical slug formula). core-utils.cjs also requires THIS module
 *     (comparePhaseNum, scopeToPhase), so a top-level require here would be
 *     circular and — per this codebase's compiled-.cjs convention of a
 *     single `module.exports = {...}` reassignment at the bottom of each
 *     file — a top-level circular require captures a stale, still-empty
 *     exports object forever (verified live: it throws
 *     "generateSlugInternal is not a function" when core-utils.cjs happens
 *     to load first). The require is deferred (lazy, inside each function
 *     body) instead, mirroring the same cycle-break already used by
 *     core-utils.cts's own getPhaseFileStats/plan-scan.cjs seam.
 */

import { escapeRegex } from './pattern.cjs';

// ─── Phase-id helpers ─────────────────────────────────────────────────────────

// project_code values start with an uppercase letter (e.g. PROJ, APP_CODE);
// leading underscores are not valid project codes per .planning/config.json.
const PROJECT_CODE_PREFIX_STRIP_RE = /^[A-Z][A-Z0-9_]*-(?=\d)/;
const PROJECT_CODE_PREFIX_STRIP_RE_I = /^[A-Z][A-Z0-9_]*-(?=\d)/i;
const PROJECT_CODE_PREFIX_CAPTURE_RE_I = /^([A-Z][A-Z0-9_]*)-(\d.*)/i;
const OPTIONAL_PROJECT_CODE_PREFIX_SOURCE = '(?:[A-Z][A-Z0-9_]*-)?';

// #1729: phase headers may carry a parenthetical tag between the number and the
// colon, e.g. `### Phase 26 (Cluster B): Title`. This optional, non-capturing
// fragment is injected at every phase-header regex call site (immediately after
// the phase-number token, before the colon/space delimiter) so the resolver
// tolerates the tag — mirroring how `[...]` is already tolerated before `Phase`.
// `[^)\n]*` keeps the match single-line (headers are one line) to avoid
// over-consuming across a malformed multi-line document. Injected at the call
// site (not baked into phaseMarkdownRegexSource) so it applies uniformly to
// both the numeric and project-code-exact escaped sources, and so the decimal
// sub-phase patterns can place it after the `.N` segment.
//
// Enumeration/parse call sites that read phase headers from a regex *literal*
// (rather than a `new RegExp` built from an interpolated phase number) cannot
// reference this constant; they inline its literal-regex mirror instead —
// `(?:\s*\([^)\n]{0,200}\))?` — kept character-for-character equivalent to this
// source. Both forms must change together; see the #1729 regression test.
const OPTIONAL_PHASE_TAG_SOURCE = '(?:\\s*\\([^)\\n]{0,200}\\))?';

// #2128: the canonical phase-NUMBER-TOKEN grammar — a phase number with an
// optional single-letter variant suffix and optional dotted sub-phases
// (1, 01, 12A, 12.1, 3.2.1). This is the ENUMERATION/scan counterpart to
// phaseMarkdownRegexSource: use phaseMarkdownRegexSource(n) to build a source
// for ONE KNOWN number; reference this constant when a call site must match ANY
// phase and capture its token. Enumeration/parse sites inline this into a
// `new RegExp(...)` instead of re-deriving the grammar as a literal, so every
// phase-token producer shares one owner. The anti-divergence guard
// (scripts/lint-phase-id-drift.cjs) fails CI if a literal re-derivation is
// introduced outside this module without a `// phase-id-owner:` justification.
const PHASE_NUMBER_TOKEN_SOURCE = '\\d+[A-Z]?(?:\\.\\d+)*';

// #2528 review: the CASE-FLEXIBLE renderings of the two sources above, for call
// sites that scan directory names (where a project code or a variant suffix may
// legitimately be lowercase) and therefore cannot use a case-sensitive class.
//
// They live HERE, beside the sources they widen, because the alternative in use
// was `SOURCE.replaceAll('A-Z', 'A-Za-z')` at the consuming site — a derivation
// that depends on the owner rendering that exact literal. It passes
// lint-phase-id-drift.cjs (no literal copy of the grammar), but the day this
// module expresses the same class any other way (`[[:upper:]]`, a named
// fragment, an escaped range) the replaceAll silently no-ops and the consumer
// quietly narrows to uppercase-only — the failure is a NON-match, so nothing
// throws and no test that only feeds uppercase input notices. Deriving it once,
// where the source is defined, makes that impossible: a rename here is a
// compile-visible change, not a silent behavior change three modules away.
const CASE_FLEXIBLE_PROJECT_CODE_PREFIX_SOURCE =
  OPTIONAL_PROJECT_CODE_PREFIX_SOURCE.replaceAll('A-Z', 'A-Za-z');
const CASE_FLEXIBLE_PHASE_NUMBER_TOKEN_SOURCE =
  PHASE_NUMBER_TOKEN_SOURCE.replaceAll('A-Z', 'A-Za-z');

// #2232: the canonical CONTINUATION-segment grammar — a dash-separated segment
// that extends a phase token (a zero-padded sub-phase or plan number, e.g. the
// "01" in "02-01-setup"). getPhaseDirFromPhaseId writes these zero-padded to
// exactly 2 digits, so the digit RUN of a genuine continuation is exactly 2:
// #2043's `\d{2,}` (2-or-more) over-collected a slug word that merely leads
// with ≥2 digits (a year: "14-2026-photos-…" yielded token "14-2026", so every
// phase-locating verb reported the phase as missing). The `(?!\d)` guard caps
// the run at 2 without anchoring what may follow, so call sites keep their own
// trailing grammar (letter suffixes, dotted sub-phases, segment boundaries).
// POLICY (locked by boundary tests): sub-phase/plan numbers ≥100 are out of the
// dir-token grammar — the LEADING phase number stays unbounded (`\d+`), only
// continuation segments begin with a two-digit run; consuming sites retain
// their established suffix and boundary grammar. Shared from here so the five #2043
// call sites cannot drift independently (see scripts/lint-phase-id-drift.cjs).
const PHASE_CONTINUATION_SEGMENT_SOURCE = '\\d{2}(?!\\d)';
const PHASE_CONTINUATION_SEGMENT_PREFIX_RE = new RegExp(`^${PHASE_CONTINUATION_SEGMENT_SOURCE}`);
function isPhaseContinuationSegment(seg: string): boolean {
  return PHASE_CONTINUATION_SEGMENT_PREFIX_RE.test(seg);
}

// #612 (PR-1): bracket-convention token/heading sources, kept next to the M-NN
// PHASE_NUMBER_TOKEN_SOURCE so this owner file stays the single origin of every
// phase-token grammar. `src/phase-id.cts` is exempt from the #2128 drift guard
// (scripts/lint-phase-id-drift.cjs) by construction, and that guard fails any
// literal re-derivation of the token grammar elsewhere — so the downstream
// bracket readers (PR-2: roadmap/validate/verify) must build their regexes by
// interpolating these exports, never by copying the literal.
//
// The canonical numeric WIDTH of a bracket identity field, mirroring pad2()'s
// output: exactly 2 digits, or 3+ with no leading zero. Owned here as a SOURCE
// so the read side (BRACKET_PHASE_TOKEN_SOURCE, below) and the emit-side
// validator (CANONICAL_NUMERIC_RE, which toDir enforces) are one rule rather
// than two literals that agree today and drift tomorrow.
const BRACKET_CANONICAL_NUMERIC_SOURCE = '(?:[1-9]\\d{2,}|\\d{2})';

// BRACKET_PHASE_TOKEN_SOURCE differs from PHASE_NUMBER_TOKEN_SOURCE by a
// dot-OR-dash sub-separator: a bracket dir/heading numeric run is `MM-PP[.SS]`
// (a hyphen joins milestone↔phase, a dot joins phase↔sub-phase), whereas M-NN
// sub-phases are dot-only.
//
// The run is POSITIONAL, not a free repetition — `MM-PP[.SS][-LL]` — and each
// position gets the width its DELIMITER can actually afford:
//
//   MM   leading   unbounded  — delimited by the `{CODE}.` prefix
//   -PP  dash-1    canonical  — the grammar REQUIRES this dash, so it is a field
//                              separator, not a continuation heuristic
//   .SS  dot       canonical  — a slug carries no dot (toDir sanitizes them
//                              away), so this position cannot collide
//   -LL  dash-2    #2232 cap  — the ONLY slug-adjacent position, and therefore
//                              the only one a slug word can collide with
//
// #2232 reconciliation: the slug-adjacent position interpolates the single-owner
// PHASE_CONTINUATION_SEGMENT_SOURCE, so the #2232 bug class cannot reopen on the
// bracket path — dir `PROJ.01-14-2026-photos-…` (a slug leading with a year)
// yields `01-14`, never `01-14-2026`.
//
// DELIBERATE DIVERGENCE from the M-NN dir-token path (pinned by the parity gate
// in tests/continuation-grammar-parity.test.cjs, which fails if these two rules
// drift for a reason nobody intended): the non-slug-adjacent positions stay
// WIDER than #2232's cap. Bracket admits 3+-digit milestone/phase/sub-phase
// (CANONICAL_NUMERIC_RE — `[GSD.100] 05` is a pinned regression), and unlike the
// M-NN continuations those positions are delimiter-disambiguated rather than
// heuristically recognized, so there is no year collision to defend against.
// Interpolating the cap verbatim at every position would only under-collect ids
// that toDir itself emits: `PROJ.02-105-slug` (3-digit phase) would read as
// `02`, and `[GSD.02] 05.100` (3-digit sub-phase) as `05`. Upstream draws this
// same line for the same reason — core-utils/phase cap the paired PLAN component
// while the leading phase component stays unbounded (phase numbers ≥100 are
// legitimate). The trade-off this accepts is #2232's policy verbatim: a PLAN
// ≥100 is out of the token grammar.
//
// Still deliberately MORE PERMISSIVE than parsePhaseId's strict grammar (it
// admits a letter-suffixed and unpadded leading token that the parser rejects):
// this is a READ-TOLERANCE source for the PR-2 readers, which must recognize a
// bracket-shaped token before deciding what to do with it — it is not the
// emit/identity grammar. parsePhaseId stays the arbiter of well-formedness.
const BRACKET_PHASE_TOKEN_SOURCE =
  `\\d+[A-Z]?` +
  `(?:-${BRACKET_CANONICAL_NUMERIC_SOURCE}(?!\\d))?` +
  `(?:\\.${BRACKET_CANONICAL_NUMERIC_SOURCE}(?!\\d))?` +
  `(?:-${PHASE_CONTINUATION_SEGMENT_SOURCE})?` +
  `(?=-|$)`;

// A phase HEADING intro under bracket is either a `[...]` bracket (optionally
// followed by a `Phase ` label) or a bare `Phase ` label; a bare number is NOT
// a phase-heading intro. The `[^\]]{1,200}` bound mirrors the existing
// roadmap-parser heading regexes (ReDoS-safe: a header is one short line).
//
// Retained as PR-1 shipped it. PR-2 does not consume it — see the gated
// selector below, which supersedes it — and it is left byte-identical so an
// already-merged epic export does not change its accepted language.
const PHASE_HEADING_PREFIX_SRC = '(?:\\[[^\\]]{1,200}\\]\\s*(?:Phase\\s+)?|Phase\\s+)';

// ── #612 PR-2: the ONE bracket identity grammar ─────────────────────────────
// A bracket phase-ID prefix is `{CODE}.{MM}`. Before this, three spellings of
// that shape lived in this file and disagreed: extractPhaseToken's bracket
// branch (`\d+`, case-sensitive), bracketQualifiedKey (`\d+`, mixed-case), and
// the dir prefix (`\d{2,}`). `GSD.2-05-feature` was simultaneously "not a phase
// directory" and "phase 05", depending on which one a caller reached. They are
// now one source.
//
// The milestone width mirrors the EMIT grammar rather than accepting any digit
// run: pad2() emits at least two digits, so two digits — or three-plus with no
// leading zero — is what toDir can produce. A bare `0` is NOT admitted: the
// padded `00` is the backlog sentinel's canonical identity and `\d{2}` already
// covers it, so nothing needs the unpadded spelling. (An earlier revision of
// this comment claimed the opposite; the constant below has always rejected it
// — #2867 review, Minor 2.) `[GSD.2] 05:` is therefore NOT a bracket id —
// which is the point: it is the shape that made the three spellings disagree.
// Reconciled with BRACKET_CANONICAL_NUMERIC_SOURCE above — the width toDir
// actually emits (pad2: 2 digits, or 3+ with no leading zero). The earlier
// `(?:\d{2,}|0)` diverged from it in both directions: it admitted `002`, which
// the emit validator rejects, and a bare `0` that pad2 never produces. Every
// bracket-milestone recognizer now derives from this one constant — the section
// recognizers previously spelled `0*N` or `\d+` and accepted `[GSD.2]`, which
// SCOPED a milestone no phase heading could then resolve into, recreating the
// on-disk-count fallback this PR exists to remove.
//
// An unpadded bracket is therefore MALFORMED, uniformly: it scopes nothing,
// bounds nothing, sections nothing, and is not a phase id. W005 on its
// directories is the signal that surfaces it.
const BRACKET_MILESTONE_NUMERIC_SRC = BRACKET_CANONICAL_NUMERIC_SOURCE;

// #2761 M3 (trek-e review): the bracket PROJECT-CODE class, as a named source
// rather than a class this file (and three readers outside it) each re-typed.
// The re-typed copies were the exact drift #2761's own gate forbids — "no token
// literal outside src/phase-id.cts" — and `check:phase-id-drift` did not see
// them, because its detector only knew the phase-NUMBER token grammar. The
// guard now carries a bracket rule too (scripts/lint-phase-id-drift.cjs).
const BRACKET_PROJECT_CODE_SRC = '[A-Z][A-Z0-9_]*';
const BRACKET_ID_SRC = `${BRACKET_PROJECT_CODE_SRC}\\.${BRACKET_MILESTONE_NUMERIC_SRC}`;

// The bracket MILESTONE INTRO — `[CODE.MM]` — in the two shapes its readers
// need. Both were re-typed verbatim outside this module before #2761 M3:
//
//   * PINNED, to one already-resolved milestone integer. This owns the pad2
//     spelling rule as well as the grammar, so "canonical spelling only, not
//     `0*N`" (the rule that keeps `[GSD.2]` from scoping a milestone no phase
//     heading can resolve into) lives in ONE place instead of being restated
//     beside every regex. `roadmap-parser`'s bracket-fallback selector and
//     `state`'s `isMilestoneBounded` both consume this.
//
//   * CAPTURING, over any milestone, putting the milestone digits in a group.
//     `validate`'s `checkBracketCoherence` consumes this.
//
// The milestone argument is expected to be a safe integer — every caller
// resolves it through `Number.isSafeInteger` first. A non-integer yields a
// regex source that is still well-formed and simply matches nothing, which is
// the same safe degrade the callers' own guards produce.
function bracketMilestoneIntroSrcFor(milestone: number): string {
  return `\\[${BRACKET_PROJECT_CODE_SRC}\\.${String(milestone).padStart(2, '0')}\\]`;
}
const BRACKET_MILESTONE_INTRO_CAPTURING_SRC =
  `\\[${BRACKET_PROJECT_CODE_SRC}\\.(${BRACKET_MILESTONE_NUMERIC_SRC})\\]`;

// Recognition is case-INSENSITIVE (every reader compiles `/i`), but the identity
// helpers this file owns — isSentinelPhaseId, getMilestoneFromPhaseId,
// bracketQualifiedKey — match `[A-Z]` case-SENSITIVELY. A lowercase bracket id
// captured by a reader and handed straight to them silently fails every identity
// test, which is how `### [gsd.999] 07:` leaked into phase counts as a real
// phase. Fold before any identity operation; never fold for display.
function foldBracketId(bracketId: unknown): string {
  return String(bracketId).toUpperCase();
}

// The identity recognizers every bracket helper in this file shares.
// `BRACKET_ID_PREFIX_RE` is applied to an ALREADY-FOLDED string, so it needs no
// `/i`; the other two see raw dir names and carry it.
// The milestone field must END at the phase separator. Without the boundary the
// width alternation matched a PREFIX of a malformed run — `GSD.002-01` matched
// its leading `00` and read as a sentinel.
const BRACKET_ID_PREFIX_RE = new RegExp(`^${BRACKET_PROJECT_CODE_SRC}\\.(${BRACKET_MILESTONE_NUMERIC_SRC})(?=-|$)`);
const BRACKET_DIR_PREFIX_SRC = `${BRACKET_ID_SRC}-`;
// The trailing `(?=-|$)` is what makes the recognizer and the resolver agree on
// REJECTED input, not just accepted input. Without it `GSD.02-12A-hotfix`
// resolves to token `12` here while the directory recognizer calls the name
// malformed — so W005 reports it malformed in the same run that the
// milestone-complete check treats it as a real phase directory.
const BRACKET_DIR_TOKEN_RE = new RegExp(`^${BRACKET_DIR_PREFIX_SRC}(\\d+(?:\\.\\d+)?)(?=-|$)`, 'i');
// Same width rule, same `(?=-|$)` boundary and same single-sub-phase shape as
// BRACKET_DIR_TOKEN_RE. Without them a qualified query `GSD.02-12` matched the
// directory `GSD.02-12A-hotfix` — which isPhaseDirName calls malformed — and
// phaseTokenMatches returns UNCONDITIONALLY on a qualified hit, so that
// disagreement would have been final rather than a fall-through.
const BRACKET_QUALIFIED_KEY_RE = new RegExp(
  `^(${BRACKET_PROJECT_CODE_SRC})\\.(${BRACKET_MILESTONE_NUMERIC_SRC})-(\\d+(?:\\.\\d+)?)(?=-|$)`, 'i',
);

// ── #612 PR-2: gated heading-intro selection ────────────────────────────────
// The two intro spellings that exist upstream TODAY, transcribed verbatim from
// the call sites. A repo that has not opted into the bracket convention
// compiles exactly these — not a superset of them, THEM — so its reads are
// structurally identical to the base build rather than argued equivalent.
// tests/adr-612-bracket-heading-selection.test.cjs asserts that byte-equality
// against its own independently transcribed copies of the call-site literals.
const BASE_ANY_BRACKET_HEADING_PREFIX_SRC = '(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+';
const BASE_PHASE_LABEL_PREFIX_SRC = 'Phase\\s+';

// Which of those two a site spells at base. Passed explicitly rather than
// inferred, because the choice is a fact about the call site's history that no
// amount of looking at the widened pattern can recover.
const PHASE_HEADING_BASELINE = Object.freeze({
  /** Site already tolerates `[anything] Phase N` — roadmap headings, validate's heading scanner. */
  ANY_BRACKET: 'any-bracket',
  /** Site spells a bare `Phase N` with no bracket tolerance — checklist bullets, the counters. */
  LABEL_ONLY: 'label-only',
});

/**
 * The heading-intro source a site should compile, given the resolved
 * `phase_id_convention`.
 *
 * NON-bracket conventions (null, undefined, 'milestone-prefixed', or any
 * unrecognized value) return the site's BASE spelling unchanged. This is the
 * whole design: PR-2 originally widened these reads ungated and argued the new
 * shape "cannot occur in a legacy ROADMAP", which is false — `### [RFC.2119] 5:`,
 * `### [v1.0] 2024:` and `### [ADR.612] 3:` are all legal legacy headings that
 * the widened form claims as phases, moving phase_count, total_phases and W006
 * on repos that never opted in. Selection at construction time removes the
 * argument entirely: there is nothing to reason about, because a non-bracket
 * repo compiles the same source string it compiled before.
 *
 * `capturing` adds EXACTLY ONE group, at position 1, holding the bracket id —
 * `undefined` whenever a non-bracket alternative matched. Sites that filter
 * sentinels need it: READING-B puts the sentinel milestone in the bracket, so
 * testing the phase token alone is blind to `### [GSD.999] 01:`.
 *
 * Pure: takes the resolved convention, never reads config.
 */
function phaseHeadingPrefixSrcFor(
  baseline: string,
  convention?: string | null,
  capturing = false,
): string {
  const base = baseline === PHASE_HEADING_BASELINE.ANY_BRACKET
    ? BASE_ANY_BRACKET_HEADING_PREFIX_SRC
    : BASE_PHASE_LABEL_PREFIX_SRC;
  if (convention !== 'bracket') return base;
  const id = capturing ? `(${BRACKET_ID_SRC})` : BRACKET_ID_SRC;
  // `[ \t]*` not `\s*`: `\s` spans newlines, so a bracket-terminated heading
  // followed by a blank line and a digit-leading prose line read as one phase.
  // BOTH bracket forms are admitted at both baselines, and both CAPTURE. The
  // any-bracket base already matches `[GSD.999] Phase 07:` on its own — but
  // through the base alternative, which captures nothing, so the reader saw
  // `bracketId === undefined`, fell back to the legacy leading-integer rule, and
  // counted a labeled icebox heading as a real phase while the label-less form
  // beside it was excluded. Two derivations of one ROADMAP disagreed. The
  // bracket alternative is tried FIRST so it wins the capture.
  const bracketAlt = `\\[${id}\\][ \\t]*(?:Phase\\s+|(?=\\d))`;
  return `(?:${bracketAlt}|${base})`;
}

function stripProjectCodePrefix(value: unknown, caseInsensitive = true): string {
  const input = String(value);
  const re = caseInsensitive ? PROJECT_CODE_PREFIX_STRIP_RE_I : PROJECT_CODE_PREFIX_STRIP_RE;
  return input.replace(re, '');
}

function hasProjectCodePrefix(value: unknown): boolean {
  return PROJECT_CODE_PREFIX_STRIP_RE_I.test(String(value));
}

function normalizePhaseName(phase: unknown): string {
  const str = String(phase);
  // Strip optional project_code prefix (e.g., 'CK-01' → '01')
  const stripped = stripProjectCodePrefix(str, false);
  // Milestone-prefixed phase IDs: M-NN or M-N-N (deep decomposition).
  const milestoneMatch = stripped.match(/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i);
  if (milestoneMatch) {
    const major = milestoneMatch[1].padStart(2, '0');
    const subSegments = milestoneMatch[2].slice(1).split('-').map(s => s.padStart(2, '0'));
    const suffix = milestoneMatch[3] || '';
    return `${major}-${subSegments.join('-')}${suffix}`;
  }
  // Standard numeric phases: 1, 01, 12A, 12.1
  const match = stripped.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  if (match) {
    const padded = match[1].padStart(2, '0');
    // Preserve original case of letter suffix (#1962).
    const letter = match[2] || '';
    const decimal = match[3] || '';
    return padded + letter + decimal;
  }
  // Custom phase IDs (e.g. PROJ-42, AUTH-101): return as-is
  return str;
}

function getMilestoneFromPhaseId(phaseId: unknown, convention?: string): string | null {
  // READING-B (#612): under the bracket convention the milestone comes from the
  // `[PROJECT.MM]` / `{CODE}.{MM}-` prefix, never the phase-token leading
  // integer (ADR-612 Decision 6). Gated on 'bracket' so the `null` and
  // 'milestone-prefixed' (M-NN) paths keep the legacy leading-int rule
  // (READING-A) below, byte-untouched. The optional parameter keeps this helper
  // pure (no config read) and backward-compatible: every existing single-arg
  // caller resolves to the unchanged READING-A body.
  if (convention === 'bracket') {
    const b = foldBracketId(phaseId).match(BRACKET_ID_PREFIX_RE);
    if (!b) return null;
    const mm = parseInt(b[1], 10);
    if (SENTINEL_RANGES.includes(mm)) return null; // sentinel milestones have no real milestone
    return `v${mm}.0`;
  }
  const stripped = stripProjectCodePrefix(phaseId);
  const m = stripped.match(/^0*(\d+)-\d/);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  if (major === 0 || major === 999) return null;
  return `v${major}.0`;
}

function getPhaseDirFromPhaseId(phaseId: unknown, phaseName: string | null | undefined, projectCode: string | null | undefined): string | null {
  const stripped = stripProjectCodePrefix(phaseId);
  const m = stripped.match(/^0*(\d+)-(0*(\d+(?:-\d+)*))$/);
  if (!m) return null;
  const milestone = String(parseInt(m[1], 10)).padStart(2, '0');
  const subParts = m[2].split('-').map(p => String(parseInt(p, 10)).padStart(2, '0'));
  const sub = subParts.join('-');
  // #3883 (ADR-3473 §8.3): delegate to the canonical slug formula
  // (generateSlugInternal, core-utils.cts) rather than re-implementing it.
  // `maxLen: null` preserves this site's pre-migration untruncated contract —
  // the 60-char default would silently shadow one on-disk phase dir's
  // reported phase_slug behind another distinct >60-char phase name's.
  // Lazy require to break the core-utils.cjs <-> phase-id.cjs cycle (see the
  // module dependency doc comment above).
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  const slug = phaseName ? ((require('./core-utils.cjs').generateSlugInternal(phaseName, null) as string | null) ?? '') : '';
  const parts = [milestone, sub, slug].filter(Boolean);
  const base = parts.join('-');
  return projectCode ? `${projectCode}-${base}` : base;
}

// ─── Bracket phase-ID grammar (#612, PR-1) ──────────────────────────────────
// One pure round-trippable model (ADR-612 §3 / Decision 4). parsePhaseId
// accepts the display form `[PROJECT.MM] PP[.SS][-LL]` or the on-disk/token form
// `{PROJECT}.{MM}-{PP}[.{SS}][-{LL|slug}]`; renderPhaseId / toDir are its two
// emitters. READING-B: the milestone lives in the `[PROJECT.MM]` prefix, so no
// token dimension is ever overloaded (the M-NN collapse pinned in
// tests/adr-612-collision-characterization.test.cjs cannot occur on this path).
// `plan` is a filename-surface dimension only — renderPhaseId emits it; toDir
// drops it (directories carry a slug, not a plan). The project code follows the
// repo's established `[A-Z][A-Z0-9_]*` grammar (the config-validated
// project_code shape shared with OPTIONAL_PROJECT_CODE_PREFIX_SOURCE), not the
// ADR §1 illustration's `[A-Z]{1,6}`, so that every project_code the config
// permits (digits / underscore / >6 chars) parses.
//
// Strict-reject posture (ADR-612 Decision 4's `render(parse(x)) === x`
// contract, held exactly): parsePhaseId accepts ONLY the canonical form of
// each branch — unpadded numbers, over-padded numbers, and multi-space or
// stray leading/trailing whitespace are all rejected rather than silently
// normalized, so two distinct input strings can never parse to the same
// tuple while one of them fails to round-trip. toDir mirrors this on the
// write side: every interpolated PhaseId field is validated (PhaseId is a
// structural type — nothing forces callers through parsePhaseId, so a hand-
// built id must not be able to smuggle a path-traversal segment onto disk),
// and the slug must sanitize to a non-empty, non-all-digit token (an empty
// slug would leave a dangling trailing hyphen; an all-digit slug is
// string-indistinguishable from the plan grammar's trailing tail and would
// silently break the disk↔identity bijection on read-back).
type PhaseId = {
  project: string;     // 'GSD'
  milestone: string;   // '02'  (zero-padded, from the bracket/dir prefix)
  phase: string;       // '05'  (zero-padded)
  subphase?: string;   // '03'  (optional)
  plan?: string;       // '01'  (filename surface only)
};

const pad2 = (n: string): string => String(parseInt(n, 10)).padStart(2, '0');

function parsePhaseId(input: string): PhaseId {
  // No .trim(): the match anchors (`^`...`$`) then reject leading/trailing
  // whitespace outright, folding that case into the same "not a bracket
  // phase id" rejection below rather than needing its own check.
  const str = String(input);

  // Display form: [PROJECT.MM] PP[.SS][-LL]. The match itself stays
  // permissive on purpose (it will happily match an unpadded number or a
  // multi-space run) — canonicality is enforced UNIFORMLY below via the
  // render round-trip (ADR-612 Decision 4) rather than by hand-tuning every
  // numeric / whitespace sub-pattern, so a field added later inherits the
  // check for free instead of needing its own regex micro-surgery.
  const disp = str.match(/^\[([A-Z][A-Z0-9_]*)\.(\d+)\]\s+(\d+)(?:\.(\d+))?(?:-(\d+))?$/);
  if (disp) {
    const id: PhaseId = { project: disp[1], milestone: pad2(disp[2]), phase: pad2(disp[3]) };
    if (disp[4] !== undefined) id.subphase = pad2(disp[4]);
    if (disp[5] !== undefined) id.plan = pad2(disp[5]);
    // Canonicality by construction: re-render the parsed id and require
    // byte-equality with the input. This rejects unpadded ('[GSD.5] 5'),
    // over-padded ('[GSD.005] 05'), and multi-space-separated ('[GSD.02]  05')
    // variants uniformly, without special-casing any one of them — the emit
    // path (renderPhaseId) is the single source of truth for "canonical".
    if (renderPhaseId(id) !== str) {
      throw new Error(`parsePhaseId: not canonical: ${JSON.stringify(input)}`);
    }
    return id;
  }

  // Dir / token form: {PROJECT}.{MM}-{PP}[.{SS}][-{plan|slug}]
  const dir = str.match(/^([A-Z][A-Z0-9_]*)\.(\d+)-(\d+)(?:\.(\d+))?(?:-(.+))?$/);
  if (dir) {
    const id: PhaseId = { project: dir[1], milestone: pad2(dir[2]), phase: pad2(dir[3]) };
    if (dir[4] !== undefined) id.subphase = pad2(dir[4]);
    // Trailing segment: a pure-integer tail is the plan; anything else is a
    // slug (dropped from the tuple — it is not an identity dimension). The
    // plan tail participates in the canonicality check below; the slug tail
    // is read-tolerant pass-through (a slug is not an identity dimension) and
    // is exempt from it.
    const tail = dir[5];
    const tailIsPlan = tail !== undefined && /^\d+$/.test(tail);
    if (tailIsPlan) id.plan = pad2(tail);

    // Canonicality by construction, mirroring the display branch: rebuild the
    // exact dir/token string this id would emit and require it match the
    // input verbatim. Rejects unpadded milestone/phase ('GSD.2-5') and
    // unpadded plan tails ('GSD.02-05-1') without special-casing either.
    const sub = id.subphase ? `.${id.subphase}` : '';
    const tailOut = tail === undefined ? '' : tailIsPlan ? `-${pad2(tail)}` : `-${tail}`;
    const canonical = `${id.project}.${id.milestone}-${id.phase}${sub}${tailOut}`;
    if (canonical !== str) {
      throw new Error(`parsePhaseId: not canonical: ${JSON.stringify(input)}`);
    }
    return id;
  }

  // Ambiguous / bare tokens (e.g. `02-04`, `05`, `2-01`) match neither branch,
  // as does a display/dir form carrying leading/trailing whitespace (the
  // anchors never match it): reject rather than guess a tuple (ADR-612
  // conservative default). The rejection lives ONLY in this new parser —
  // normalizePhaseName and every other legacy reader keep accepting those
  // tokens unchanged.
  throw new Error(`parsePhaseId: not a bracket phase id: ${JSON.stringify(input)}`);
}

function renderPhaseId(id: PhaseId): string {
  const sub = id.subphase ? `.${id.subphase}` : '';
  const plan = id.plan ? `-${id.plan}` : '';
  return `[${id.project}.${id.milestone}] ${id.phase}${sub}${plan}`;
}

// PhaseId is a structural type: nothing forces a caller through parsePhaseId,
// so toDir cannot trust project/milestone/phase/subphase are already
// canonical — each is validated below against the exact shape parsePhaseId
// itself would ever produce, closing off a hand-built id as a path-traversal
// vector. PROJECT_ID_RE mirrors the parser's `[A-Z][A-Z0-9_]*` grammar;
// CANONICAL_NUMERIC_RE mirrors pad2()'s output shape — exactly 2 digits, or
// 3+ digits with no leading zero. It is BUILT from
// BRACKET_CANONICAL_NUMERIC_SOURCE rather than re-spelled as a literal, so this
// emit-side gate and the read-side token source cannot disagree about what
// "canonical width" means (the anchors here make the source's trailing `(?!\d)`
// guard, which the unanchored read side needs, redundant).
const PROJECT_ID_RE = /^[A-Z][A-Z0-9_]*$/;
const CANONICAL_NUMERIC_RE = new RegExp(`^${BRACKET_CANONICAL_NUMERIC_SOURCE}$`);

function toDir(id: PhaseId, slug: string): string {
  if (!PROJECT_ID_RE.test(id.project)) {
    throw new Error(`toDir: invalid project: ${JSON.stringify(id.project)}`);
  }
  if (!CANONICAL_NUMERIC_RE.test(id.milestone)) {
    throw new Error(`toDir: invalid milestone: ${JSON.stringify(id.milestone)}`);
  }
  if (!CANONICAL_NUMERIC_RE.test(id.phase)) {
    throw new Error(`toDir: invalid phase: ${JSON.stringify(id.phase)}`);
  }
  if (id.subphase !== undefined && !CANONICAL_NUMERIC_RE.test(id.subphase)) {
    throw new Error(`toDir: invalid subphase: ${JSON.stringify(id.subphase)}`);
  }
  // A non-string slug (e.g. an omitted second argument) must not be silently
  // coerced by String(...) into the literal token 'undefined'/'null' on disk.
  if (typeof slug !== 'string') {
    throw new Error(`toDir: slug must be a string: ${JSON.stringify(slug)}`);
  }

  const sub = id.subphase ? `.${id.subphase}` : '';
  // Slug guard: the slug becomes an on-disk path segment, so collapse it to a
  // safe lowercase token — never a path separator or `..` traversal.
  // #3883 (ADR-3473 §8.3): delegate the sanitize formula itself to the
  // canonical (generateSlugInternal, core-utils.cts) — this fixes the
  // Cyrillic-collapses-to-empty defect (#2848-class) that toDir carried
  // before (it never transliterated). The empty-sanitize and all-digit
  // throw guards below stay: they are a DECLARED DIFFERENCE from every
  // other slug call site, not a bug — a slug here becomes a real directory
  // name, and toDir protects the parsePhaseId dir↔identity bijection
  // (see the toDir docstring above) by refusing to emit an unusable name,
  // where every other site silently accepts "" or a re-truncated value.
  // `maxLen: null` preserves toDir's pre-migration untruncated contract — the
  // 60-char default let two distinct >60-char phase names collapse onto the
  // identical directory name, one silently shadowing the other on disk.
  // Lazy require to break the core-utils.cjs <-> phase-id.cjs cycle (see the
  // module dependency doc comment above).
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  const safeSlug = (require('./core-utils.cjs').generateSlugInternal(slug, null) as string | null) ?? '';
  // A slug that sanitizes to nothing (e.g. '!!!') would otherwise emit a
  // dangling trailing hyphen.
  if (!safeSlug) {
    throw new Error(`toDir: slug sanitizes to empty: ${JSON.stringify(slug)}`);
  }
  // An all-digit slug (e.g. '2026') is string-indistinguishable from the
  // parsePhaseId dir branch's plan tail, so it would re-parse as a plan, not
  // a slug — silently breaking the disk↔identity bijection on read-back.
  if (/^\d+$/.test(safeSlug)) {
    throw new Error(`toDir: slug must not be all-digit: ${JSON.stringify(slug)}`);
  }
  return `${id.project}.${id.milestone}-${id.phase}${sub}-${safeSlug}`;
}

// Milestone integers reserved as non-milestone sentinels (0.x backlog / 999.x
// icebox); a phase id in these ranges has no real milestone.
const SENTINEL_RANGES: readonly number[] = Object.freeze([0, 999]);

function isSentinelPhaseId(phaseId: unknown, convention?: string): boolean {
  const s = String(phaseId);
  // Bracket milestone lives in the `{CODE}.{MM}` prefix. GATED on
  // convention === 'bracket' for the same reason as extractPhaseToken below and
  // getMilestoneFromPhaseId above: that prefix is string-indistinguishable from
  // the legacy #1324 letter-prefixed-decimal family (`P0.0-foundation` is a real
  // phase, NOT sentinel milestone 0) whenever the code ends in a digit. A
  // convention-less caller uses the legacy/bare leading-int rule below, so no
  // existing reader gains a false positive; the bracket reading is opt-in.
  if (convention === 'bracket') {
    // #612 PR-2: fold before matching. Readers recognize headings under `/i`, so
    // a lowercase `[gsd.999]` arrives verbatim; the case-sensitive class below
    // then failed to match and an icebox item counted as a real phase.
    const bracket = foldBracketId(s).match(BRACKET_ID_PREFIX_RE);
    if (bracket) return SENTINEL_RANGES.includes(parseInt(bracket[1], 10));
    // #2761 round-12: NO bracket tag matched — a bare/untagged id under
    // bracket convention (`0-bootstrap`, a directory with no `{CODE}.{MM}-`
    // prefix, or a legacy-spelled `### Phase 0:` heading routed here without
    // its own bracketId guard). Falling through to the LEGACY leading-int rule
    // below would read this bare `0` as sentinel milestone 0 — but under
    // bracket convention milestone 0 is expressed ONLY via an explicit
    // bracket tag, so an untagged leading `0` is a real phase token, not a
    // sentinel. This mirrors the two HEADING-side counters that already carry
    // this exact carve-out: state.cts's `countRoadmapPhaseHeadings` guards its
    // bare-0 exclusion with `bracketId &&` (so an untagged `Phase 0:` heading
    // is counted), and roadmap-parser.cts's `scanMilestonePhaseIds` composes
    // the bare-token rule as 999-only, deliberately NOT this predicate, for
    // the identical reason (#3185: the leading-int rule also swallows the
    // #2554 decimal ids — `0.5-bootstrap` is a real phase, not milestone 0).
    // The 999/icebox reading stays universal either way — an untagged `999`
    // is still backlog under every convention — so only that half of
    // SENTINEL_RANGES applies here.
    //
    // `isSentinelPhaseDir` remains deliberately convention-blind for its
    // warning-only disk guards and may conservatively classify a bare `0`
    // directory as sentinel. This branch has an explicit resolved convention
    // and feeds counts/archives, so it must retain the more precise reading.
    const bare = stripProjectCodePrefix(s).match(/^0*(\d+)/);
    return bare !== null && parseInt(bare[1], 10) === 999;
  }
  const legacy = stripProjectCodePrefix(s).match(/^0*(\d+)/); // legacy/bare: leading int
  if (!legacy) return false;
  return SENTINEL_RANGES.includes(parseInt(legacy[1], 10));
}

/**
 * Disk-side sentinel recognizer (#3639): is this on-disk PHASE DIRECTORY a
 * sentinel (never-on-roadmap by convention)?
 *
 * The disk-side guards (C001 gap numbering, W007 orphan dirs) see raw
 * directory names and do not know the repo's naming convention — and neither
 * convention-blind route could recognize a bracket sentinel: `isSentinelPhaseId`
 * without the convention argument reads only the legacy leading int, while
 * `extractPhaseToken(dirName)` (convention-aware or not) strips the MILESTONE
 * and returns the bare phase token — bracket sentinel-ness lives in the
 * milestone portion (`GSD.999-07-icebox` is icebox because of the 999, not
 * the 07). This helper reads the milestone directly off the dir name.
 *
 * The bracket branch requires the FULL bracket dir shape — code prefix, dot,
 * milestone digits, hyphen, PHASE DIGITS — so a #1324 letter-prefixed real
 * dir with a LETTER slug (`P0.0-foundation`) never matches it (ADR-2121
 * indistinguishability, same gate as extractPhaseToken below). DISCLOSED
 * RESIDUAL (#3639 review): the #1324 family also has digit continuations
 * (`P0.0-1-foundation`, `P0.3-2` are real shapes per derivePhaseTokenSegments),
 * and `{code}.{0|999}-{digit}...` is string-indistinguishable from a bracket
 * sentinel dir — no convention-free discriminator exists (ADR-2121). Such a
 * dir reads as sentinel here, which at the disk-guard call sites suppresses
 * a warning (conservative for a linter) rather than deleting data. The
 * digit-continuation family with NON-sentinel first decimals (`P0.3-2`)
 * reads milestone 3 — ordinary — exactly as the convention-gated id
 * predicate does. Everything else falls to the legacy leading-int rule.
 */
function isSentinelPhaseDir(dirName: string): boolean {
  const bracketDir = dirName.match(/^[A-Z][A-Z0-9_]*\.(\d+)-\d/); // milestone digits + hyphen + phase DIGITS
  if (bracketDir) return SENTINEL_RANGES.includes(parseInt(bracketDir[1], 10));
  return isSentinelPhaseId(dirName);
}

/**
 * Render a regex source fragment matching a phase number against ROADMAP/STATE
 * prose regardless of zero-padding on either side.
 */
function phaseMarkdownRegexSource(phaseNum: unknown): string {
  const stripped = stripProjectCodePrefix(phaseNum);

  // Milestone-prefixed IDs: M-NN or M-N-N (deep).
  const milestoneSegments = stripped.match(/^(\d+)((?:-\d+)*)([A-Z]?(?:\.\d+)*)$/i);
  if (milestoneSegments && milestoneSegments[2]) {
    const majorUnpadded = milestoneSegments[1].replace(/^0+/, '') || '0';
    const subParts = milestoneSegments[2].slice(1).split('-');
    const subFragments = subParts.map(s => {
      const unpadded = s.replace(/^0+/, '') || '0';
      return `0*${escapeRegex(unpadded)}`;
    });
    const suffix = milestoneSegments[3] || '';
    const suffixFragment = suffix ? escapeRegex(suffix) : '';
    return `0*${escapeRegex(majorUnpadded)}-${subFragments.join('-')}${suffixFragment}`;
  }

  // Plain numeric phase: 1, 01, 12A, 12.1
  const match = stripped.match(/^0*(\d+)([A-Z])?((?:\.\d+)*)$/i);
  // #3212: escapeRegex now requires a string (the seam owns coercion policy,
  // not this module) — String(...) here preserves this function's own
  // pre-existing `unknown` acceptance for callers that pass a non-string
  // phaseNum through to this fallback branch.
  if (!match) return escapeRegex(String(phaseNum));

  const integer = match[1].replace(/^0+/, '') || '0';
  const letter = match[2] ? escapeRegex(match[2]) : '';
  const decimal = match[3] ? escapeRegex(match[3]) : '';
  return `0*${escapeRegex(integer)}${letter}${decimal}`;
}

/**
 * #3599: when the caller passed a project-code-prefixed ID like `PROJ-42`,
 * return the exact-escaped form.
 */
function phaseMarkdownRegexSourceExact(phaseNum: unknown): string | null {
  const raw = String(phaseNum);
  if (!hasProjectCodePrefix(raw)) return null;
  return escapeRegex(raw);
}

function comparePhaseNum(a: unknown, b: unknown): number {
  // Strip optional project_code prefix before comparing
  const sa = stripProjectCodePrefix(a);
  const sb = stripProjectCodePrefix(b);

  const milestoneA = sa.match(/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i);
  const milestoneB = sb.match(/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i);

  if (milestoneA && milestoneB) {
    const segsA = [parseInt(milestoneA[1], 10), ...milestoneA[2].slice(1).split('-').map(s => parseInt(s, 10))];
    const segsB = [parseInt(milestoneB[1], 10), ...milestoneB[2].slice(1).split('-').map(s => parseInt(s, 10))];
    const maxSegs = Math.max(segsA.length, segsB.length);
    for (let i = 0; i < maxSegs; i++) {
      const av = segsA[i] !== undefined ? segsA[i] : 0;
      const bv = segsB[i] !== undefined ? segsB[i] : 0;
      if (av !== bv) return av - bv;
    }
    const sufA = milestoneA[3] || '';
    const sufB = milestoneB[3] || '';
    if (sufA !== sufB) return sufA < sufB ? -1 : 1;
    return 0;
  }

  if (milestoneA || milestoneB) return String(a).localeCompare(String(b));

  const pa = sa.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  const pb = sb.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  const intDiff = parseInt(pa[1], 10) - parseInt(pb[1], 10);
  if (intDiff !== 0) return intDiff;
  const la = (pa[2] || '').toUpperCase();
  const lb = (pb[2] || '').toUpperCase();
  if (la !== lb) {
    if (!la) return -1;
    if (!lb) return 1;
    return la < lb ? -1 : 1;
  }
  const aDecParts = pa[3] ? pa[3].slice(1).split('.').map(p => parseInt(p, 10)) : [];
  const bDecParts = pb[3] ? pb[3].slice(1).split('.').map(p => parseInt(p, 10)) : [];
  const maxLen = Math.max(aDecParts.length, bDecParts.length);
  if (aDecParts.length === 0 && bDecParts.length > 0) return -1;
  if (bDecParts.length === 0 && aDecParts.length > 0) return 1;
  for (let i = 0; i < maxLen; i++) {
    const av = Number.isFinite(aDecParts[i]) ? aDecParts[i] : 0;
    const bv = Number.isFinite(bDecParts[i]) ? bDecParts[i] : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Segmentation core shared by `extractPhaseToken` (the token VALUE) and
 * `isPhaseArtifact` (the DERIVABILITY check — #3511). Factored out so the two
 * questions ("what is this dir's token" and "did a real token exist at all")
 * can never diverge — see CLAUDE.md's "Generative Fix Divergence" note: this
 * is exactly a shared parser between two parallel surfaces.
 *
 * Returns `tokenSegments.length === 0` iff dirName's own leading segment
 * carries no phase-number token (the `extractPhaseToken` dirName-unchanged
 * fallback) — i.e. the directory name itself does not start with a digit or a
 * short letter+digit prefix, so no reliable phase token can be read from it.
 */
function derivePhaseTokenSegments(
  dirName: string,
): { prefix: string; tokenSegments: string[]; firstLetterPrefixed: boolean } {
  const codePrefixMatch = dirName.match(PROJECT_CODE_PREFIX_CAPTURE_RE_I);
  let prefix = '';
  let rest = dirName;
  if (codePrefixMatch) {
    prefix = codePrefixMatch[1] + '-';
    rest = codePrefixMatch[2];
  }

  const segments = rest.split('-');
  const tokenSegments: string[] = [];
  // #2043: distinguish a real (zero-padded) phase/sub-phase segment from a
  // single-digit slug word. A pure-numeric leading segment ("46") only
  // continues with exactly-2-digit segments (#2232: a ≥3-digit run is a slug
  // word such as a year — "14-2026-photos-…" yields "14", not "14-2026"), so
  // "46-6-rs-…" yields "46" (the "6" is the
  // slug's first word), not "46-6". Milestone-prefixed ids like "M1-2" reach here
  // with "M1-" already stripped as a project-code prefix (see
  // PROJECT_CODE_PREFIX_CAPTURE_RE_I), so "2" is the leading segment and the same
  // pure-numeric rule applies (M1-46-6-rs → "M1-46"). The firstLetterPrefixed
  // carve-out covers letter+digit leading segments that survive prefix stripping
  // because of punctuation (e.g. "P0.3-2"), whose single-digit continuation is
  // intentionally preserved (unchanged from prior behaviour).
  let firstLetterPrefixed = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (i === 0) {
      if (/^\d/.test(seg)) {
        tokenSegments.push(seg);
      } else if (/^[A-Za-z]{1,3}\d/.test(seg)) {
        tokenSegments.push(seg);
        firstLetterPrefixed = true;
      } else {
        break;
      }
    } else if (
      (firstLetterPrefixed && /^\d/.test(seg)) ||
      (!firstLetterPrefixed && isPhaseContinuationSegment(seg))
    ) {
      tokenSegments.push(seg);
    } else {
      break;
    }
  }

  return { prefix, tokenSegments, firstLetterPrefixed };
}

/**
 * Extract the phase token from a directory name.
 */
function extractPhaseToken(dirName: string, convention?: string | null): string {
  // #612 bracket dir form `{CODE}.{MM}-{PP}[.{SS}]-slug` → phase token `PP[.SS]`.
  // GATED on convention === 'bracket' (mirrors getMilestoneFromPhaseId's READING-B
  // decision above). A bracket dir `{CODE}.{MM}-{PP}` is string-INDISTINGUISHABLE
  // from the legacy #2043/#1324 letter-prefixed-decimal family (`P0.3-2`,
  // `P0.12-34`) whenever the project code ends in a digit, so NO string-only
  // discriminator can separate the two conventions — auto-detecting here silently
  // reinterpreted `P0.3-2` → `2` (was `P0.3-2`), a byte-identical-read regression
  // on this CRITICAL 6-caller helper (ADR-2121). Requiring an explicit convention
  // signal keeps every existing (convention-less) call site byte-identical to
  // prior behaviour — see the #2043 numeric-tail characterization in
  // tests/phase-id.test.cjs — while keeping the helper pure (optional param, no
  // config read). The captured token is dot-only (`PP[.SS]`); the milestone↔phase
  // hyphen and any trailing plan/slug are excluded.
  if (convention === 'bracket') {
    // #612 PR-2: built from the ONE bracket identity grammar, not a private
    // spelling. Case-insensitive to match how the readers recognize headings and
    // directories; the milestone width is the emit grammar's.
    const bracketDir = dirName.match(BRACKET_DIR_TOKEN_RE);
    if (bracketDir) return bracketDir[1];
  }

  const { prefix, tokenSegments, firstLetterPrefixed } = derivePhaseTokenSegments(dirName);

  if (tokenSegments.length === 0) {
    return dirName;
  }

  // #2528 (re-review): the tokenizer deliberately does NOT try to tell a 2-digit
  // slug word ("24" of "24/7 Autonomy") from a genuine zero-padded continuation
  // ("24" of sub-phase 10.24) — by width alone they are the same string, the gap
  // between #2043's 1-digit and #2232's ≥3-digit guards, and no LOCAL signal
  // separates them. An earlier revision of this fix rewound the token when the
  // segment that stopped the scan was a 1-digit word, which reads
  // "10-24-7-autonomy" correctly but silently re-tokenizes the equally real
  // "10-24-7-zip" (sub-phase 10.24 named "7-Zip …") from "10-24" to "10" — it
  // trades the reported ambiguity for the symmetric one a level down, on a
  // CRITICAL 15-caller chokepoint whose output feeds query-less derivations
  // (STATE.md phase counts, W007, the #2562 key surface).
  //
  // So the token stays the LITERAL reading of the name, and disambiguation lives
  // ONE layer up, in matchPhaseDirs, where a QUERY exists to disambiguate
  // against: a bare-integer lookup falls back to the directory's leading digit
  // run and resolves "10-24-7-autonomy" for "10" without touching what the
  // directory's own token is. That is the same bounded mechanism the
  // "05-80-20-cleanup" shape already uses — one rule for the whole
  // digit-leading-slug family instead of two overlapping ones.
  //
  // A generated slug is lowercase. If the owner admitted a two-digit prefix
  // from a digit+letter slug segment ("10x", "25abc"), remove only that final
  // segment. Uppercase suffixes remain available to the established plan-ID
  // grammar, and dotted continuations remain intact.
  if (
    !firstLetterPrefixed &&
    tokenSegments.length > 1 &&
    /^\d{2}[a-z][a-z0-9]*$/.test(tokenSegments[tokenSegments.length - 1])
  ) {
    tokenSegments.pop();
  }

  return prefix + tokenSegments.join('-');
}

/**
 * #3511 (reworked — adversarial review found the membership rule wrong in
 * approach, not just detail): predicate for AGGREGATE phase-directory scans
 * (every matching file contributes, e.g.
 * uat-predicate/phase.cts/state.cts/uat.cts/audit.cts's `*-UAT.md` /
 * `*-VERIFICATION.md` scans) — answers "does fileName belong to THIS phase"
 * so a stray, cross-phase, or ad-hoc file (`04-VERIFICATION.md` sitting in
 * phase 03's directory) cannot contribute its status to phase 03. This is
 * deliberately NOT `resolveVerificationFile` (`src/verification.cts`,
 * #3357/#3492) — that resolver answers a SINGLE-PICK question ("which one
 * candidate is THE report") for a phase dir already known to hold one; this
 * answers a per-file membership question for a scan that must fold in EVERY
 * match. See "Reconciliation" below — the two do NOT fully agree.
 *
 * THE ORIGINAL BUG: files are named by `normalizePhaseName`
 * (`cmdScaffold`, `src/commands.cts` — PADDED, project-code-STRIPPED), while
 * this predicate read the directory's OWN token via the literal, unpadded,
 * project-code-CARRYING `extractPhaseToken(phaseDirName)`. Two different
 * normalizations of the same phase number, so a literal
 * `startsWith(token + '-')` excluded a phase's own artifacts whenever they
 * disagreed: `CK-01-foundation` (token `CK-01`, file `01-VERIFICATION.md`),
 * `1-unpadded` (token `1`, file `01-VERIFICATION.md`), and the #2528
 * digit-leading-slug family `05-80-20-cleanup` / `10-24-7-autonomy` (token
 * over-absorbs past the digit run `cmdScaffold` actually writes: `05-80-20`
 * vs the real `05-UAT.md`).
 *
 * THE FIX: build the set of every phase-number READING this directory could
 * plausibly resolve to elsewhere in the module, then check fileName against
 * ALL of them — reusing the exact readings `matchPhaseDirs` /
 * `phaseNumberForMatch` (#2528, below) already carry for directory
 * RESOLUTION, so this membership check can never diverge from what "the
 * directory for phase N" means elsewhere in the module (no third
 * normalization — CLAUDE.md's Generative Fix Divergence class):
 *   1. the literal token (`extractPhaseToken(phaseDirName)` — still correct
 *      for the common case and for genuine decimal / letter-suffixed
 *      sub-phase dirs);
 *   2. the same token read off the project-code-STRIPPED name
 *      (`stripProjectCodePrefix` — the exact fallback `phaseTokenMatches`
 *      already applies, #612/#1324);
 *   3. the directory's own LEADING DIGIT RUN on the stripped name
 *      (`LEADING_DIGIT_RUN_RE` — the #2528 bare-integer-fallback reading,
 *      the one that actually matches what `cmdScaffold` writes for the
 *      digit-leading-slug family); and
 *   4. each of (1)-(3) additionally passed through `normalizePhaseName`,
 *      since files always carry the PADDED form and directories often do
 *      not (`1-unpadded` vs `01-...`).
 * A file belongs when it starts with any candidate + `-` OR any candidate +
 * `.`, compared case-insensitively (matching `phaseTokenMatches`' own rule —
 * review item 8: `03A-VERIFICATION.md` vs `03a-foo`). This is a PREFIX check,
 * not a full-token equality — `03-01-SUMMARY.md` (phase 03, plan 01) must
 * still match dir `03-foo` on candidate `03`, even though
 * `extractPhaseToken('03-01-SUMMARY.md')` would (wrongly, for this purpose)
 * read `03-01` as a mis-absorbed 2-digit continuation.
 *
 * DOTTED SUB-PHASE CONTINUATION: the dot arm of the check exists because this
 * module's own token grammar (`PHASE_NUMBER_TOKEN_SOURCE`) admits a dotted
 * sub-phase continuation (`(?:\.\d+)*`) alongside dash-continuations — a
 * sub-phase artifact `01.1-CONTEXT.md` is `01`'s own file, written into `01`'s
 * directory, not a stray from a different phase. A dash-only prefix check
 * excluded it (`01.1-` does not start with `01-`), which is over-exclusion:
 * the dangerous direction for an aggregate scan whose fail-safes above all
 * default to inclusion when membership is unclear. Widening dash-only to
 * dash-OR-dot only ever ADDS a match a candidate already earned; it cannot
 * newly admit a file whose leading digits differ from `candidate`, so it
 * cannot resolve a genuinely different phase's artifact (`02.1-...` still
 * fails every `01`-rooted candidate).
 *
 * BRACKET CONVENTION (review item 7; reworked by #612/#2761): a
 * letter-prefixed-decimal dir (`P0.3-2-slug`) is string-INDISTINGUISHABLE
 * from a bracket-dir token (`extractPhaseToken` above, gated on
 * `convention === 'bracket'`) without an explicit convention signal. This
 * predicate now takes the same optional trailing `convention` its sibling
 * helpers do (ADR-2121 additive shape): when a call site threads
 * `'bracket'` and the dir is a WELL-FORMED bracket dir
 * (`BRACKET_DIR_TOKEN_RE` — the one grammar owner, shared with
 * `extractPhaseToken`'s bracket branch), the dir's real phase token is
 * readable and membership is scoped through the identical candidate
 * comparison its legacy twin gets — so `GSD.02-02-two` reads exactly what
 * `02-two` reads, which is PR-2's core invariant. Convention-less calls,
 * bracket-MALFORMED names (1-digit milestone, letter-suffixed token — the
 * shapes W005 reports), and legacy-shaped dirs inside a bracket repo all
 * resolve to the unchanged body below.
 *
 * A filename carrying its own bracket-qualified stem is compared on the
 * qualified key — see the branch body. An M-NN-stem artifact name
 * (`02-01-VERIFICATION.md` in `GSD.02-01-one`) is excluded under the bracket
 * convention, deliberately: that is exactly what the legacy twin does with
 * the same file, twin-parity is this PR's contract, and migration-window
 * artifact renaming belongs to the migrator slice per ADR-612 — the trade is
 * pinned in tests/adr-612-bracket-phase-counting.test.cjs.
 *
 * For those unthreaded/unparseable cases the include-everything trade
 * stands: rather than guess a reading it cannot know is active and risk
 * excluding the phase's OWN artifact (the exact defect class this rework
 * exists to fix), the ambiguous families widen to include-everything,
 * accepted in trade for never dropping the phase's own report. Note the
 * bracket family splits across BOTH fail-safes, not just one: a short
 * digit-bearing project code (`A1.02-…`) lands in `firstLetterPrefixed`,
 * but a 3+-letter code (`GSD.02-…`) derives ZERO token segments —
 * `PROJECT_CODE_PREFIX_CAPTURE_RE_I` strips `{CODE}-`, not `{CODE}.` — so
 * the zero-token fail-safe fires first. A fixer patching only the
 * `firstLetterPrefixed` branch covers neither; the convention gate above
 * covers both.
 *
 * FAIL-SAFE (#3511, unchanged): when dirName's own leading segment carries no
 * phase-number token at all (`derivePhaseTokenSegments` finds zero segments —
 * the same condition `extractPhaseToken` treats as "return dirName
 * unchanged"), no reliable token exists to scope against. Excluding on an
 * unreliable token would make an aggregate gate silently PERMISSIVE in the
 * wrong direction — dropping the phase's own real blockers — which is worse
 * than the cross-phase-contamination bug this predicate exists to fix.
 * Instead every file is treated as belonging to the phase (returns `true`
 * unconditionally), matching pre-fix (unscoped) behaviour for that directory.
 *
 * FIX 2 — bare `VERIFICATION.md` / `UAT.md` (no dash, no token of its own):
 * `derivePhaseTokenSegments(fileName)` also finds zero segments for these —
 * the file carries no phase number to compare against anything. Directory
 * containment is the only signal available for a token-less file, and it is
 * sufficient: every call site passes `fs.readdirSync` results for ONE
 * specific phase dir, so a token-less candidate already reaching this
 * predicate (past each call site's own verification/UAT suffix pre-filter)
 * is, by construction, that phase's own
 * listing. Returns `true` unconditionally, same as the dir-side fail-safe.
 *
 * RECONCILIATION WITH resolveVerificationFile (#3357/#3492/#3511) — the two
 * surfaces now AGREE. `resolveVerificationFile`'s fallback (`verification.cts`,
 * "Fallback" step in its own docblock) filters its dashed candidates through
 * THIS predicate — `isPhaseArtifact(f, phaseDirName)` — before picking
 * alphabetically-first, via a new `phaseDirName` option every call site
 * threads in (the same basename each already derives for `phaseToken`). So a
 * stray cross-phase file can no longer win the single-pick fallback either:
 * it is excluded there for the identical reason it is excluded from the
 * aggregate scans here — membership, not canonical shape. The fail-safes stay
 * aligned too: when this predicate cannot determine membership for a
 * directory (returns `true` unconditionally — see FAIL-SAFE above),
 * `resolveVerificationFile`'s filter is a no-op and its fallback degrades to
 * the original pre-#3357 "alphabetically first of ALL dashed candidates"
 * behavior, exactly as it always did for that directory shape.
 */
function isPhaseArtifact(fileName: string, phaseDirName: string, convention?: string | null): boolean {
  // #612/#2761: the bracket branch — see "BRACKET CONVENTION" in the docblock.
  // Gated on the same explicit signal AND the same grammar
  // (`BRACKET_DIR_TOKEN_RE`) as `extractPhaseToken`'s bracket branch, so the
  // two surfaces can never disagree about which names are bracket dirs. A
  // name that fails the grammar falls through to the unchanged body below.
  if (convention === 'bracket') {
    const bracketDir = phaseDirName.match(BRACKET_DIR_TOKEN_RE);
    if (bracketDir) {
      // The convention must gate the FILENAME reading, not just the directory
      // reading — a milestone-qualified artifact name (the layout the
      // read-tolerance suite models) derives zero legacy token segments, so
      // without this it enters FIX 2's token-less containment and any bracket
      // dir admits it. Compared on the qualified key: the phase's own
      // qualified artifact stays included — the exact key, and the dotted
      // sub-phase continuation (`GSD.02-05.1-…` is `GSD.02-05`'s own file,
      // the same dash-OR-dot rule matchesPhaseTokenCandidates applies; a
      // dash-continuation never reaches this comparison, the phase group's
      // `(?=-|$)` boundary already stopped the key before it) — while a
      // WELL-FORMED qualified stem naming a different phase or milestone is
      // excluded. A qualified-SHAPED but grammar-malformed stem (letter
      // suffix, 1-digit milestone, 2-level dot — the W005 shapes) yields a
      // null fileKey and keeps the module's documented include-everything
      // fail-safe via FIX 2 below, same as every other undecidable name.
      const fileKey = bracketQualifiedKey(fileName, convention);
      if (fileKey !== null) {
        const dirKey = bracketQualifiedKey(phaseDirName, convention);
        if (dirKey !== null) return fileKey === dirKey || fileKey.startsWith(`${dirKey}.`);
      }
      // Reached when the filename carries no well-formed qualified stem (the
      // common case — every unqualified name), or when the DIR's own key is
      // null despite matching the dir grammar (an unsafe-integer milestone or
      // phase — bracketQualifiedKey refuses both rather than collide).
      // Either way the candidate path decides, deliberately.
      return matchesPhaseTokenCandidates(fileName, [bracketDir[1]]);
    }
  }

  const { tokenSegments, firstLetterPrefixed } = derivePhaseTokenSegments(phaseDirName);
  if (tokenSegments.length === 0) return true;

  const literalToken = extractPhaseToken(phaseDirName);
  const strippedDir = stripProjectCodePrefix(phaseDirName);
  const strippedToken = strippedDir !== phaseDirName ? extractPhaseToken(strippedDir) : literalToken;
  const leadingRunMatch = strippedDir.match(LEADING_DIGIT_RUN_RE);

  const rawCandidates = [literalToken, strippedToken, leadingRunMatch?.[1]].filter(
    (t): t is string => Boolean(t),
  );
  if (matchesPhaseTokenCandidates(fileName, rawCandidates)) return true;

  // Bracket-convention ambiguity fail-safe — see docblock above.
  if (firstLetterPrefixed) return true;

  return false;
}

/**
 * Candidate-comparison core shared by `isPhaseArtifact`'s two entry paths —
 * the legacy segment-derived readings and the #612 bracket-dir token. One
 * comparison rule, not two that agree today and drift tomorrow: the padded/
 * de-padded expansion, the separator class, and FIX 2 apply identically
 * whichever path produced the candidates, which is what makes a bracket dir
 * read exactly what its legacy twin reads.
 */
function matchesPhaseTokenCandidates(fileName: string, rawCandidates: string[]): boolean {
  // Each reading is compared in BOTH its padded and de-padded form: files are
  // written padded by `normalizePhaseName` (`cmdScaffold`) while directories
  // are often not (`1-unpadded`), and legacy trees carry the reverse pairing.
  // De-padding is numeric-only — a token with a letter suffix or a dotted
  // sub-phase (`03A`, `03.1`) has no meaningful de-padded form and is left
  // alone, so this only ever ADDS a reading and can never drop one.
  const depad = (t: string): string => (/^\d+$/.test(t) ? String(Number(t)) : t);
  const candidates = new Set(
    rawCandidates
      .flatMap(t => [t, normalizePhaseName(t), depad(t)])
      .map(t => t.toUpperCase()),
  );

  const fileUpper = fileName.toUpperCase();
  for (const candidate of candidates) {
    // A dotted sub-phase segment (e.g. `01.1-CONTEXT.md`) is a legitimate
    // continuation of `candidate` per this module's own token grammar
    // (PHASE_NUMBER_TOKEN_SOURCE admits `(?:\.\d+)*`), so it belongs to
    // `candidate`'s own directory just as a dash-continuation does. Inclusion
    // is the safe direction for these aggregate scans (see FAIL-SAFE above) —
    // widening a dash-only check to dash-OR-dot never drops a genuine match,
    // it only stops wrongly excluding one.
    //
    // Accepted separator class after a matched candidate: `-`, `.`, or `_`.
    // The underscore was added for state.cts's `cmdStateValidate` S006/S007
    // scan, whose own pre-filter is deliberately broader than the dashed
    // grammar every other call site uses (`.includes('VERIFICATION')`, no
    // dash required — see the WARNING-4 comment there), so it admits names
    // like `03_VERIFICATION.md`. Before this predicate accepted `_` as a
    // boundary, such a file failed the `-`/`.`-only check here even though
    // its digits matched `candidate` exactly, and `scopeToPhase` dropped it —
    // a real same-phase verification report reported as absent. Widening the
    // separator class only ever EXTENDS a candidate whose digits already
    // match exactly; it cannot admit a genuinely different phase's file,
    // since the candidate comparison itself is unchanged.
    if (
      fileUpper.startsWith(`${candidate}-`) ||
      fileUpper.startsWith(`${candidate}.`) ||
      fileUpper.startsWith(`${candidate}_`)
    ) return true;
  }

  // FIX 2: token-less filename (bare "VERIFICATION.md"/"UAT.md") — containment
  // in this phase's own directory listing is sufficient.
  return derivePhaseTokenSegments(fileName).tokenSegments.length === 0;
}

/**
 * #3511: scope `fileNames` to the subset that passes
 * `isPhaseArtifact(fileName, phaseDirName)`. The single seam every
 * phase-directory scan routes through, so the membership rule has ONE owner.
 *
 * AN EMPTY RESULT IS A REAL ANSWER — deliberately, and this is the hard-won
 * part. An earlier revision of this helper carried an extra rule ("scoping
 * must never turn a non-empty set into an empty one": if the filter removed
 * every file, return the unfiltered input). It was added to rescue a
 * directory whose basename merely PARSES phase-shaped —
 * `gsd-651-broad-grep-a1b2`, an `mkdtemp`-style fixture name that
 * `extractPhaseToken` reads as project code `gsd` + phase `651` (the capture
 * regex is case-INSENSITIVE) — holding only `01-bg-VERIFICATION.md`, which
 * the filter then dropped, yielding an empty set indistinguishable from "no
 * report exists".
 *
 * That rescue was wrong, and no local rule can make it right: a directory
 * whose own name says phase 651 holding only a file that says phase 01 is
 * STRING-INDISTINGUISHABLE from `03-foo/` holding only `04-VERIFICATION.md`
 * — the exact cross-phase stray #3511 exists to exclude. Keeping the rule
 * meant a real phase directory holding only a MISFILED report would resolve
 * to it and publish another phase's `passed` as its own: the reported bug, in
 * its single most damaging form. `missing` is the correct answer when a
 * phase's own report is genuinely absent, and every caller already has a
 * `missing`/`null` branch for it.
 *
 * The over-exclusion that rule was reaching for is instead handled where it
 * is actually determinable, inside `isPhaseArtifact`: the zero-token dir
 * fail-safe, the `firstLetterPrefixed` bracket-ambiguity fail-safe, the
 * token-less-filename rule, and the multi-reading candidate set (literal /
 * project-code-stripped / leading-digit-run, each also padded AND de-padded)
 * that covers every normalization a phase directory and its files can
 * legitimately disagree on. A file excluded after all of those genuinely
 * names a different phase.
 *
 * SITE DISCIPLINE: every aggregate-scan call site (`uat.cts`,
 * `uat-predicate.cts`, `phase.cts`, `audit.cts`, `state.cts`,
 * `core-utils.cts`'s `getPhaseFileStats` — #3511 BLOCKER-2 — and
 * `init.cts`'s two phase-info-projection sites — #3511 BLOCKER-3, both of
 * which scope the raw listing once up front and reuse it for every bare
 * `.find()`/`.some()` artifact predicate: context/research/UAT/reviews/
 * patterns) and `resolveVerificationFile`'s single-pick fallback
 * (`verification.cts`) MUST route through this helper rather than calling
 * `isPhaseArtifact` in a filter position directly, so the rule cannot be
 * re-derived per site (CLAUDE.md's Generative Fix Divergence class).
 * `isPhaseArtifact` stays exported for single-item membership questions and
 * its own unit tests.
 *
 * #612/#2761: both helpers take the same optional trailing `convention` their
 * sibling primitives (`extractPhaseToken`, `phaseTokenMatches`) do — the
 * ADR-2121 additive shape, so every existing two-argument call resolves to
 * the unchanged legacy body. A call site that already holds the resolved
 * convention threads it and bracket dirs scope exactly like their legacy
 * twins; convention-less call sites keep the documented include-everything
 * fail-safes and are the follow-up-slice work (they cannot scope a bracket
 * dir until they can resolve the convention, and guessing is the one thing
 * this predicate must never do).
 */
function scopeToPhase(fileNames: string[], phaseDirName: string, convention?: string | null): string[] {
  return fileNames.filter((f) => isPhaseArtifact(f, phaseDirName, convention));
}

/**
 * Canonical comparable key for a milestone-qualified bracket id or dir name.
 * Lifts the milestone out of the `{CODE}.{MM}-` prefix so a flat multi-milestone
 * layout disambiguates: `CK.03-02` resolves to its OWN milestone's directory,
 * never the first same-numbered directory of another milestone.
 *
 * Returns null for UNQUALIFIED ids (`02`, `HQ-11`, `11.01`) so callers fall back
 * to bare-token matching unchanged, and GATED on convention === 'bracket' for
 * the same reason as extractPhaseToken: the qualified key is padding-
 * INSENSITIVE where the legacy token path is padding-SENSITIVE, so ungated it
 * silently widens matching on legacy repos.
 */
function bracketQualifiedKey(s: string, convention?: string | null): string | null {
  if (convention !== 'bracket') return null;
  const m = String(s).match(BRACKET_QUALIFIED_KEY_RE);
  if (!m) return null;
  const milestone = parseInt(m[2], 10);
  // A milestone integer past Number's exact range collapses to Infinity, and
  // every such id would then share one key. Refuse rather than collide.
  if (!Number.isSafeInteger(milestone)) return null;
  const phase = m[3].split('.').map(n => parseInt(n, 10));
  if (phase.some(n => !Number.isSafeInteger(n))) return null;
  return `${foldBracketId(m[1])}.${milestone}-${phase.join('.')}`;
}

/**
 * Check if a directory name's phase token matches the normalized phase exactly.
 *
 * The optional `convention` is the ADR-2121 additive shape: every existing
 * two-argument call site resolves to the unchanged legacy body.
 */
function phaseTokenMatches(dirName: string, normalized: string, convention?: string | null): boolean {
  if (convention === 'bracket') {
    // A milestone-qualified query compares on the full qualified key, and
    // returns unconditionally: falling through on a miss would re-admit the
    // cross-milestone match the qualification exists to prevent.
    const qKey = bracketQualifiedKey(normalized, convention);
    if (qKey) return bracketQualifiedKey(dirName, convention) === qKey;
    const bracketToken = extractPhaseToken(dirName, convention);
    if (bracketToken.toUpperCase() === normalized.toUpperCase()) return true;
  }
  const token = extractPhaseToken(dirName);
  if (token.toUpperCase() === normalized.toUpperCase()) return true;
  const stripped = stripProjectCodePrefix(dirName);
  if (stripped !== dirName) {
    const strippedToken = extractPhaseToken(stripped);
    if (strippedToken.toUpperCase() === normalized.toUpperCase()) return true;
  }
  return false;
}

/**
 * #2528: the LEADING DIGIT RUN of a directory name — the fragment the
 * bare-integer fallback selects on, and the one `phaseNumberForMatch` then
 * displays. Named (per this module's convention of naming grammar fragments
 * rather than inlining them) because the two sites must not drift: selecting on
 * one run and displaying another would resolve a directory and then label it
 * with a number that never matched.
 *
 * `LEADING_DIGIT_RUN_RE` anchors a trailing `-`-or-end so the run is a whole
 * segment; `_PREFIX` is the same run without that boundary, for reading the run
 * back off a name already known to match.
 */
const LEADING_DIGIT_RUN_SOURCE = '\\d+';
const LEADING_DIGIT_RUN_RE = new RegExp(`^(${LEADING_DIGIT_RUN_SOURCE})(?:-|$)`);
const LEADING_DIGIT_RUN_PREFIX_RE = new RegExp(`^${LEADING_DIGIT_RUN_SOURCE}`);
const BARE_INTEGER_RE = new RegExp(`^${LEADING_DIGIT_RUN_SOURCE}$`);

/** Strip leading zeros for numeric-equality compare, keeping a lone "0". */
const unpad = (digits: string): string => digits.replace(/^0+(?=\d)/, '');

/**
 * #2528: the CANONICAL phase-directory match selection — the one rule every
 * directory-resolution path (the shared locator plus the `find-phase` and
 * `phase-plan-index` command scans) applies to a candidate dir list. Extracted
 * here because the surrounding scan/ambiguity/shaping code exists per site and
 * had already diverged; the selection itself must not.
 *
 * Two passes:
 *   1. PRIMARY — exact token match (`phaseTokenMatches`), unchanged behavior.
 *   2. BARE-INTEGER FALLBACK — only when the primary pass matched NOTHING and
 *      the query is a bare integer, re-filter by each directory's own LEADING
 *      digit run (zero-padded compare). This catches digit-leading slug shapes
 *      the tokenizer cannot disambiguate from genuine sub-phase segments
 *      (e.g. "05-80-20-cleanup", phase 5 named "80/20 Cleanup", whose token
 *      "05-80-20" is byte-identical in shape to a real deep-decomposition dir).
 *      The fallback can only turn a silent not-found into a resolution or into
 *      a surfaced ambiguity (callers keep their #2237 multi-match guards) —
 *      never override a primary match.
 *
 * SCOPE, precisely (#2528 re-review). Non-bare QUERIES ("46-6", "12A",
 * "PROJ-42") never enter the fallback, so nothing changes about how a
 * deep-decomposition or letter-suffix lookup is asked. What DOES change is the
 * DIRECTORY side: a bare query now reaches directories the tokenizer classified
 * as multi-segment, and a genuine sub-phase directory has exactly that shape.
 * So `5` against a lone `05-01-auth` resolves (phase_number "05", phase_name
 * "01-auth") where it previously found nothing.
 *
 * That widening is DELIBERATE and it is irreducible from directory names alone.
 * `05-01-auth` (sub-phase 5.1) and `30-12-factor-refactor` (phase 30 named
 * "12-Factor Refactor") are the same string shape — `NN-NN-<slug>` — and the
 * discriminator that would separate them, "is the second segment a valid decimal
 * sub-phase", accepts both (`5.1` and `30.12` are equally well-formed). Any rule
 * strong enough to exclude `05-01-auth` also excludes `30-12-factor-refactor`,
 * which is the defect #2528 exists to fix. The tie is therefore broken in favour
 * of resolving, and the consequence is bounded on the side that matters: when
 * BOTH readings have a directory (`05-01-auth` + `05-02-api`) the result is two
 * matches. `tests/phase-resolution-parity.test.cjs` pins both directions: the
 * lone-directory resolution and the two-directory refusal.
 *
 * WHAT IS SHARED IS SELECTION, NOT AMBIGUITY POLICY. This function is the one
 * owner of "which directories does this query name". What a caller does with
 * two of them stays the caller's own decision, and the callers split in two
 * tiers on purpose:
 *
 *   REFUSE on `matches.length > 1` — `searchPhaseInDir`, `cmdFindPhase`,
 *   `cmdPhasePlanIndex`, `cmdPhaseRemove`. These either act destructively or
 *   answer "which phase is this", so guessing is worse than reporting the
 *   candidates (#2237).
 *
 *   TAKE `matches[0]` — `cmdPhasesList`, `cmdInitManager`, `cmdRoadmapAnalyze`,
 *   `cmdVerifySchemaDrift`, `detectVerifyFailed`. Each read a directory to
 *   DECORATE a row they are already emitting; each used `.find()` before this
 *   PR, so first-match is their prior behavior preserved verbatim, and each is
 *   order-stable because the directory list is sorted and this function filters
 *   without reordering.
 *
 * The honest caveat on that second tier: the bare-number fallback makes
 * multi-match newly REACHABLE for inputs that previously found nothing, so those
 * five can now silently pick one of several candidates where they used to report
 * not-found. That is a widening of an existing first-match rule, not a new rule
 * — but it is a widening, and promoting any of them to refusal is a UX decision
 * about their own output, not a change to selection, so it does not belong here.
 *
 * `usedBareFallback` tells callers to derive the displayed phase number from
 * the directory's leading digit run instead of `extractPhaseToken` (whose
 * token for these dirs is the mis-absorbed multi-segment form).
 */
function matchPhaseDirs(dirs: string[], normalized: string, convention?: string | null): { matches: string[]; usedBareFallback: boolean } {
  const primary = dirs.filter(d => phaseTokenMatches(d, normalized, convention));
  if (primary.length > 0) return { matches: primary, usedBareFallback: false };

  const bare = String(normalized);
  if (!BARE_INTEGER_RE.test(bare)) return { matches: primary, usedBareFallback: false };
  const want = unpad(bare);

  const fallback = dirs.filter(d => {
    const m = stripProjectCodePrefix(d).match(LEADING_DIGIT_RUN_RE);
    return m !== null && unpad(m[1]) === want;
  });
  return { matches: fallback, usedBareFallback: fallback.length > 0 };
}

/**
 * #2528: the display phase number for a directory selected by matchPhaseDirs.
 * Primary matches keep the extracted token; bare-fallback matches use the
 * directory's leading digit run (the whole point of the fallback is that the
 * extracted token is wrong for these dirs).
 */
function phaseNumberForMatch(dirName: string, usedBareFallback: boolean): string {
  if (!usedBareFallback) return extractPhaseToken(dirName);
  const stripped = stripProjectCodePrefix(dirName);
  const prefix = dirName.slice(0, dirName.length - stripped.length);
  const m = stripped.match(LEADING_DIGIT_RUN_PREFIX_RE);
  return m ? prefix + m[0] : extractPhaseToken(dirName);
}

// ─── Canonical phase KEY surface (#2562) ─────────────────────────────────────
//
// A phase "key" is the padding-, case- and project-code-insensitive identity of
// a phase, for use as a Map/Set key when two independently-derived phase
// references (a ROADMAP table cell and a phase directory name, say) must be
// compared. Promoted here from a local pair in state.cts (#2445) so every
// consumer derives BOTH sides of a comparison from the SAME function — deriving
// one side with a bespoke regex is the #2562 defect class (a `01` table cell
// never matching a `1-slug` directory, silently zeroing a rollup).

/**
 * Canonical key for an already-extracted phase TOKEN (`"5"`, `"05"`, `"005"`,
 * `"12A"`, `"30.1"`, `"PROJ-05"`). Padding- and case-insensitive: every
 * spelling of a number collapses to one key.
 *
 * Leading zeros are stripped per hyphen-separated segment BEFORE
 * `normalizePhaseName` pads to the 2-digit convention. Padding alone is not a
 * normalisation — `padStart(2)` is a no-op once the input is already ≥2
 * characters, so `5` yielded `05` while `005` stayed `005` and the two never
 * compared equal. The strip is deliberately confined to this key surface:
 * `normalizePhaseName` itself is a RENDERING function whose verbatim treatment
 * of wide IDs (`001.10`) is relied on by plan-ID capture and wave assignment.
 * Arithmetic is avoided (`parseInt` would lose precision on a long digit run).
 */
function phaseKeyFromToken(token: unknown): string {
  const stripped = String(token)
    .split('-')
    .map(segment => segment.replace(/^0+(?=\d)/, ''))
    .join('-');
  return normalizePhaseName(stripped).toUpperCase();
}

/**
 * Canonical key for a phase DIRECTORY name (`"05-schedule-8"` → `"05"`,
 * `"PROJ-5-x"` → `"05"`, `"30.1-follow-up"` → `"30.1"`).
 *
 * #612: `convention` is forwarded to `extractPhaseToken`, which needs that signal
 * to read a bracket directory (`"GSD.02-05-delta"` → `"05"`) — a bracket dir is
 * string-indistinguishable from the legacy letter-prefixed-decimal family, so the
 * extractor refuses to guess. Optional and defaulted-absent, so every pre-#612
 * call site resolves byte-identically to prior behaviour. Without it a bracket dir
 * yields its whole name as the key and never matches the ROADMAP entry it names —
 * #2562's own defect class reached from the other side: both sides of a comparison
 * must be derived not merely by the same function but under the same convention.
 */
function phaseKeyFromDir(dirName: string, convention?: string | null): string {
  return phaseKeyFromToken(extractPhaseToken(dirName, convention));
}

/**
 * Canonical key for a phase referenced in PROSE — a ROADMAP `## Progress` table
 * cell (`"30. Schedule 8 rollout"`, `"**05.1 Follow-up**"`) or a STATE.md
 * `Phase:` value. Markdown emphasis is stripped first so a bolded cell is not
 * mistaken for a non-phase. Returns null when the value does not BEGIN with a
 * phase token (`parsePhaseFromProse` anchoring, #2111).
 */
function phaseKeyFromProse(value: string | null | undefined): string | null {
  if (value == null) return null;
  const { phase } = parsePhaseFromProse(String(value).replace(/[*_`~]/g, ''));
  return phase === null ? null : phaseKeyFromToken(phase);
}

/**
 * The PARENT phase key of a sub-phase key (`"30.1"` → `"30"`), or null for a
 * top-level phase. A sub-phase directory inserted mid-milestone frequently has
 * no ROADMAP row of its own and inherits its parent's milestone (#2562).
 */
function parentPhaseKey(key: string): string | null {
  const dot = key.indexOf('.');
  return dot === -1 ? null : key.slice(0, dot);
}

// ─── #2121 canonical surface (ADR-2121) ──────────────────────────────────────

/**
 * Parse a phase identifier from a STATE.md `Phase:` prose field VALUE — the text
 * after the `Phase:` label (e.g. `"3 of 4 (Delta)"`, `"3A — Delta (executing)"`,
 * or `"Milestone v0.5 complete"`).
 *
 * The token is anchored to the START of the value (after an optional literal
 * `Phase ` label and an optional project-code prefix) so a phase is only
 * returned when the value actually begins with one. This is the #2111 fix: the
 * prior unanchored `/\b(\d+[A-Z]?(?:\.\d+)*)\b/i` mined the first numeral
 * anywhere, so `"Milestone v0.5 complete"` collapsed to `"5"` (the minor-version
 * digit) and `"v1.0"` to `"0"` (a reserved sentinel). Here both yield
 * `{ phase: null }` because they do not begin with a phase token. The name
 * extraction (parenthetical or em-dash tail, minus status words) is unchanged.
 */
function parsePhaseFromProse(value: string | null): { phase: string | null; name: string | null } {
  if (!value) return { phase: null, name: null };
  // Coerce defensively so a non-string caller cannot throw on this canonical
  // surface (mirrors the sibling #2121 functions' String(...) handling).
  const str = String(value);
  const phaseMatch = str.match(/^\s*(?:Phase\s+)?(?:[A-Z][A-Z0-9_]*-)?(\d+[A-Z]?(?:\.\d+)*)\b/i);
  // The name-extraction quantifiers are length-bounded so a crafted long
  // unterminated run (many `(` or `—`) in an untrusted STATE.md field value
  // cannot drive O(n^2) regex backtracking (CPU-exhaustion DoS). A real phase
  // name is far shorter than the cap.
  const parenName = str.match(/\(([^)]{1,200})\)/);
  // #2736 (the #1695 AC #3 residual): status-keyword-aware precedence. The
  // first-party writer shapes are `N — Name (aside)` (completePhaseCore),
  // `N (Name) — EXECUTING` (beginPhaseCore), `N — COMPLETE`, and the
  // gsd2-import `N (slug) — Milestone: Title`. A blind paren-first read
  // harvests the aside as the name on the first shape; a blind dash-first
  // read harvests the status keyword on the others. Prefer the em-dash name
  // when it is a genuine name, else fall back to the parenthetical. Still
  // lossy for names that themselves contain a parenthetical — transitions
  // that hold the exact name bypass this parser entirely via the
  // syncStateFrontmatter authoritative override.
  //
  // The em-dash separator is searched on a paren-stripped copy, so an em-dash
  // INSIDE a parenthetical name (`16 (Native — Global Hotkey) — EXECUTING`)
  // can never be mistaken for the name separator.
  const strNoParens = str.replace(/\([^)\n]{0,200}\)/g, ' ');
  const dashName = strNoParens.match(/—\s*([^(\n]{1,200}?)\s*$/);
  // The precedence-decision vocabulary is deliberately broader than the final
  // name-nulling filter below: a dash tail that merely LOOKS like a status
  // annotation should lose to a parenthetical name, without changing which
  // extracted names are nulled (that set stays the long-standing three).
  const STATUS_WORD_RE = /^(?:complete|executing|not started)$/i;
  const STATUSY_TAIL_RE = /^(?:completed?|executing|not started|planning|planned|ready(?:\s+to\s+\S.{0,50})?|done|in progress|blocked|paused|verifying)$/i;
  const dashRaw = dashName?.[1]?.trim() ?? null;
  const dashIsName = dashRaw !== null && dashRaw.length > 0
    && !STATUSY_TAIL_RE.test(dashRaw)
    && !/^milestone\s*:/i.test(dashRaw)
    // A lone ALL-CAPS token after the dash reads as a status marker whenever a
    // parenthetical name exists to prefer (the beginPhase writer's systematic
    // `(Name) — STATUS` shape); with no parenthetical it stays the best guess.
    && !(parenName && /^[A-Z][A-Z0-9_-]*$/.test(dashRaw));
  const rawName = dashIsName ? dashRaw : (parenName?.[1] ?? dashRaw ?? null);
  const name = rawName && !STATUS_WORD_RE.test(rawName.trim())
    ? rawName.trim()
    : null;
  return {
    phase: phaseMatch ? phaseMatch[1] : null,
    name,
  };
}

/**
 * Config-AWARE project-code prefix strip. Unlike the config-blind
 * `stripProjectCodePrefix` (which strips ANY `<CODE>-` shape), this strips the
 * leading `<CODE>-` ONLY when `<CODE>` case-insensitively equals the configured
 * `projectCode`. A foreign prefix (`MEM-01` when the configured code is `LKML`)
 * or an absent/empty `projectCode` is preserved verbatim — this is the #2104
 * fix: a foreign-prefixed id must not collapse to a bare numeric phase and
 * collide with a real one.
 */
function stripConfiguredProjectCodePrefix(value: unknown, projectCode: string | null | undefined): string {
  const input = String(value);
  const configured = typeof projectCode === 'string' ? projectCode.trim() : '';
  if (!configured) return input;
  const m = input.match(PROJECT_CODE_PREFIX_CAPTURE_RE_I);
  if (!m) return input;
  if (m[1].toUpperCase() !== configured.toUpperCase()) return input;
  return m[2];
}

/**
 * True when `phase` carries a project-code prefix that is NOT the configured
 * `projectCode` (or when no `projectCode` is configured). The canonical
 * predicate the init-command foreign-prefix guard (#2056 / PR #2105) delegates
 * to, so every call site shares one foreign-prefix rule.
 */
function isForeignPrefixedPhaseQuery(phase: unknown, projectCode: unknown): boolean {
  const m = String(phase).match(PROJECT_CODE_PREFIX_CAPTURE_RE_I);
  if (!m) return false;
  const configured = typeof projectCode === 'string' ? projectCode.trim() : '';
  return !configured || m[1].toUpperCase() !== configured.toUpperCase();
}

/**
 * Canonical ROADMAP heading lookup-source list (moved here from
 * roadmap-parser.cts so phase-id.cts is the single owner of the ordering).
 * Sources are tried in a fixed, deduplicated order: exact (only when the query
 * itself is project-code-prefixed) → bare numeric / padding-tolerant →
 * prefix-tolerant fallback. The bare numeric source precedes the prefix-tolerant
 * form so a canonical heading (`### Phase 117:`) is preferred over a drifted
 * prefixed one (`### Phase MANIFOLD-117:`) when both exist in one ROADMAP.
 */
function roadmapPhaseLookupSources(phaseNum: unknown): string[] {
  const sources: string[] = [];
  const exactSource = phaseMarkdownRegexSourceExact(phaseNum);
  if (exactSource) sources.push(exactSource);

  const numericSource = phaseMarkdownRegexSource(phaseNum);
  sources.push(numericSource);
  sources.push(`${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}${numericSource}`);

  return [...new Set(sources)];
}

export = {
  OPTIONAL_PROJECT_CODE_PREFIX_SOURCE,
  OPTIONAL_PHASE_TAG_SOURCE,
  PHASE_NUMBER_TOKEN_SOURCE,
  CASE_FLEXIBLE_PROJECT_CODE_PREFIX_SOURCE,
  CASE_FLEXIBLE_PHASE_NUMBER_TOKEN_SOURCE,
  PHASE_CONTINUATION_SEGMENT_SOURCE,
  isPhaseContinuationSegment,
  BRACKET_PHASE_TOKEN_SOURCE,
  PHASE_HEADING_PREFIX_SRC,
  BRACKET_ID_SRC,
  BRACKET_PROJECT_CODE_SRC,
  bracketMilestoneIntroSrcFor,
  BRACKET_MILESTONE_INTRO_CAPTURING_SRC,
  BRACKET_MILESTONE_NUMERIC_SRC,
  BRACKET_DIR_PREFIX_SRC,
  BASE_ANY_BRACKET_HEADING_PREFIX_SRC,
  BASE_PHASE_LABEL_PREFIX_SRC,
  PHASE_HEADING_BASELINE,
  phaseHeadingPrefixSrcFor,
  foldBracketId,
  bracketQualifiedKey,
  stripProjectCodePrefix,
  normalizePhaseName,
  getMilestoneFromPhaseId,
  getPhaseDirFromPhaseId,
  parsePhaseId,
  renderPhaseId,
  toDir,
  SENTINEL_RANGES,
  isSentinelPhaseId,
  isSentinelPhaseDir,
  phaseMarkdownRegexSource,
  phaseMarkdownRegexSourceExact,
  comparePhaseNum,
  extractPhaseToken,
  isPhaseArtifact,
  scopeToPhase,
  phaseTokenMatches,
  matchPhaseDirs,
  phaseNumberForMatch,
  phaseKeyFromToken,
  phaseKeyFromDir,
  phaseKeyFromProse,
  parentPhaseKey,
  parsePhaseFromProse,
  stripConfiguredProjectCodePrefix,
  isForeignPrefixedPhaseQuery,
  roadmapPhaseLookupSources,
};

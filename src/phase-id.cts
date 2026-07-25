/**
 * Pure phase-id parsing/matching helpers — normalize, token match,
 * milestone/phase-dir id parsing, phase-markdown regex builders.
 *
 * Extracted from core.cts (ADR-857 rollout phase 2a / issue #865).
 * The hand-written bodies are preserved byte-for-behaviour; only the module
 * boundary moved. The core.cjs re-export spine was retired in epic #1267;
 * callers import phase-id helpers from phase-id.cjs directly.
 *
 * Dependencies: none (pure string/regex, no Node built-ins required).
 */

// ─── Phase-id helpers ─────────────────────────────────────────────────────────

function escapeRegex(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
// continuation segments are width-capped. Shared from here so the five #2043
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
  `(?:-${PHASE_CONTINUATION_SEGMENT_SOURCE})?`;

// A phase HEADING intro under bracket is either a `[...]` bracket (optionally
// followed by a `Phase ` label) or a bare `Phase ` label; a bare number is NOT
// a phase-heading intro. The `[^\]]{1,200}` bound mirrors the existing
// roadmap-parser heading regexes (ReDoS-safe: a header is one short line).
const PHASE_HEADING_PREFIX_SRC = '(?:\\[[^\\]]{1,200}\\]\\s*(?:Phase\\s+)?|Phase\\s+)';

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
    const b = String(phaseId).match(/^([A-Z][A-Z0-9_]*)\.(\d+)/);
    if (!b) return null;
    const mm = parseInt(b[2], 10);
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
  const slug = phaseName
    ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : '';
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
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
    const bracket = s.match(/^[A-Z][A-Z0-9_]*\.(\d+)/); // bracket: milestone in the prefix
    if (bracket) return SENTINEL_RANGES.includes(parseInt(bracket[1], 10));
  }
  const legacy = stripProjectCodePrefix(s).match(/^0*(\d+)/); // legacy/bare: leading int
  if (!legacy) return false;
  return SENTINEL_RANGES.includes(parseInt(legacy[1], 10));
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
  if (!match) return escapeRegex(phaseNum);

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
 * Extract the phase token from a directory name.
 */
function extractPhaseToken(dirName: string, convention?: string): string {
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
    const bracketDir = dirName.match(/^[A-Z][A-Z0-9_]*\.\d+-(\d+(?:\.\d+)?)/);
    if (bracketDir) return bracketDir[1];
  }

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
    } else if (isPhaseContinuationSegment(seg) || (firstLetterPrefixed && /^\d/.test(seg))) {
      tokenSegments.push(seg);
    } else {
      break;
    }
  }

  if (tokenSegments.length === 0) {
    return dirName;
  }

  return prefix + tokenSegments.join('-');
}

/**
 * Check if a directory name's phase token matches the normalized phase exactly.
 */
function phaseTokenMatches(dirName: string, normalized: string): boolean {
  const token = extractPhaseToken(dirName);
  if (token.toUpperCase() === normalized.toUpperCase()) return true;
  const stripped = stripProjectCodePrefix(dirName);
  if (stripped !== dirName) {
    const strippedToken = extractPhaseToken(stripped);
    if (strippedToken.toUpperCase() === normalized.toUpperCase()) return true;
  }
  return false;
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
  const dashName = str.match(/—\s*([^(\n]{1,200}?)(?:\s*\(|$)/);
  const rawName = parenName?.[1] ?? dashName?.[1] ?? null;
  const name = rawName && !/^(?:complete|executing|not started)$/i.test(rawName.trim())
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
  escapeRegex,
  OPTIONAL_PROJECT_CODE_PREFIX_SOURCE,
  OPTIONAL_PHASE_TAG_SOURCE,
  PHASE_NUMBER_TOKEN_SOURCE,
  PHASE_CONTINUATION_SEGMENT_SOURCE,
  isPhaseContinuationSegment,
  BRACKET_PHASE_TOKEN_SOURCE,
  PHASE_HEADING_PREFIX_SRC,
  stripProjectCodePrefix,
  normalizePhaseName,
  getMilestoneFromPhaseId,
  getPhaseDirFromPhaseId,
  parsePhaseId,
  renderPhaseId,
  toDir,
  SENTINEL_RANGES,
  isSentinelPhaseId,
  phaseMarkdownRegexSource,
  phaseMarkdownRegexSourceExact,
  comparePhaseNum,
  extractPhaseToken,
  phaseTokenMatches,
  parsePhaseFromProse,
  stripConfiguredProjectCodePrefix,
  isForeignPrefixedPhaseQuery,
  roadmapPhaseLookupSources,
};

/**
 * Validate Helpers — pure computation helpers and regex constants extracted from
 * sdk/src/query/validate.ts (ADR-457 build-at-publish: the hand-written
 * bin/lib/validate.cjs collapsed to a TypeScript source of truth). Behaviour is
 * preserved byte-for-behaviour from the prior hand-written .cjs; only types are
 * added.
 *
 * No I/O. No async. No filesystem operations.
 *
 * Issue #6 drift items (three helpers):
 *   1. phaseVariants() — replaces parseInt-based padded/unpadded check in verify.cjs
 *      Check 8 (W006 disk-existence and W007 roadmap-membership checks).
 *   2. buildRoadmapPhaseVariants() — replaces raw roadmapPhases set in W007 loop.
 *   3. buildNotStartedPhaseVariants() — replaces raw+zero-padded notStartedPhases
 *      in W006 skip logic.
 *
 * Issue #26 drift items (four constants/helpers):
 *   4. phaseDirNameRe — W005 phase directory naming regex (was inline in verify.cjs Check 6).
 *   5. PHASE_TOKEN_FROM_DIR_RE — extracts phase token from dir name (was inline in
 *      verify.cjs forEachArchivedPhaseToken / collectDiskPhases).
 *   6. MILESTONE_ARCHIVE_DIR_RE — identifies milestone archive directories (was inline).
 *   7. canonicalPlanStem() — I001 PLAN/SUMMARY stem canonicalization (was inline in Check 7).
 *
 * I/O adapter pattern (ADR-3524 §4): pure transforms extracted from the SDK.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #6 (open-gsd/gsd-core)
 *   - Issue #26 (open-gsd/gsd-core)
 *   - PR #154 (issue #4) — generator pattern precedent
 *   - PR #156 (issue #6) — validate.ts generator that #26 extends
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const {
  OPTIONAL_PROJECT_CODE_PREFIX_SOURCE,
  PHASE_NUMBER_TOKEN_SOURCE,
  PHASE_CONTINUATION_SEGMENT_SOURCE,
  BRACKET_DIR_PREFIX_SRC,
  phaseHeadingPrefixSrcFor,
  PHASE_HEADING_BASELINE,
  extractPhaseToken,
  isSentinelPhaseId,
} = phaseIdMod;

// ── Issue #26: regex constants (W005, W006-archived) ────────────────────────
// Matches legacy numeric dirs (01-setup), milestone-prefixed dirs (02-01-setup),
// deep dirs (02-04-01-deep), and project-code-prefixed variants (GSD-02-01-setup).
export const phaseDirNameRe = new RegExp(
  `^${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}\\d{2,}(?:-\\d+)*(?:\\.\\d+)*-[\\w-]+$`,
  'i',
);
// Extracts the full phase token from a directory name, including milestone-prefixed
// multi-segment tokens like "02-01" from "02-01-setup" or "GSD-02-01-setup".
// #2043: a *continuation* sub-phase segment must be zero-padded, so a
// single-digit slug word after a phase number (e.g. "46-6-rs-…", slug "6 Rs …") is
// NOT absorbed — it captures "46", not "46-6". #2232: the continuation width is
// exactly 2 (PHASE_CONTINUATION_SEGMENT_SOURCE), so a ≥3-digit slug word (a year:
// "14-2026-photos-…") is not absorbed either — it captures "14", not "14-2026".
// The first component stays "\d+"
// (with the "[A-Z]?" suffix) so single-digit letter-suffixed phase ids ("1A") and
// milestone-prefixed single-digit sub-phases ("M1-2" → prefix "M1-" stripped, then
// "2") still match. The trailing boundary "(?:-|$)" (was "(?:-[a-z]|$)") lets a slug
// that starts with a digit terminate the token.
export const PHASE_TOKEN_FROM_DIR_RE = new RegExp(
  `^${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}(\\d+(?:-${PHASE_CONTINUATION_SEGMENT_SOURCE})*[A-Z]?(?:\\.\\d+)*)(?:-|$)`,
  'i',
);
export const MILESTONE_ARCHIVE_DIR_RE = /^v\d+.*-phases$/i;

// ── #612: bracket phase-directory recognition (convention-gated) ────────────
// `{CODE}.{MM}-{PP}[.{SS}][-slug]`, built from the one bracket identity grammar.
//
// This lives BESIDE phaseDirNameRe / PHASE_TOKEN_FROM_DIR_RE rather than being
// folded into them. The `{CODE}.{MM}-` prefix is string-indistinguishable from
// the legacy letter-prefixed-decimal family this repo documents as "ambiguous
// with a padded bracket dir", and folding a bracket branch in changes those
// constants' answers on exactly that family: `P0.34-56-name` goes null -> "56",
// and phaseDirNameRe goes false -> true, silencing a W005 that fires today. A
// RegExp constant has nowhere to attach a convention gate, so the gate goes on
// the functions and the constants stay byte-identical for every consumer.
//
// The numeric run mirrors the EMIT grammar rather than accepting any digit run:
// CANONICAL_NUMERIC_RE (what toDir enforces) is digits-only with at most one
// sub-phase, so `GSD.02-12A-hotfix` and `GSD.02-05.03.07-x` are not bracket
// directories. Admitting them would make this recognizer disagree with
// extractPhaseToken, which the milestone-complete check resolves through — and
// then W006/W007 would resolve a directory that W021 simultaneously reported
// unstarted, inside one `validate health` run.
export const BRACKET_PHASE_DIR_RE = new RegExp(
  `^(?:${BRACKET_DIR_PREFIX_SRC})\\d+(?:\\.\\d+)?(?:-[\\w-]+)?$`,
  'i',
);

// The constants these functions wrap are consumed as `e.name.match(RE)`, which
// throws on a non-string. Coercing instead would invent a phase token out of a
// number (`42` -> `"42"`), so the contract is preserved rather than softened.
function assertDirName(value: unknown, fn: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${fn}: directory name must be a string, received ${typeof value}`);
  }
  return value;
}

/**
 * True when `dirName` is a recognizable phase directory under `convention`.
 * Under 'bracket' the `{CODE}.{MM}-{PP}` form is additionally accepted, so W005
 * stops reporting every bracket phase directory as malformed. Every other
 * convention value delegates to the unchanged `phaseDirNameRe`.
 */
export function isPhaseDirName(dirName: string, convention?: string | null): boolean {
  const name = assertDirName(dirName, 'isPhaseDirName');
  if (convention === 'bracket' && BRACKET_PHASE_DIR_RE.test(name)) return true;
  return phaseDirNameRe.test(name);
}

/**
 * Extract a phase token from a directory name under `convention`, or null when
 * the name is not a phase directory — the same contract as
 * `PHASE_TOKEN_FROM_DIR_RE.exec()[1]`.
 *
 * Under 'bracket' the SHAPE is recognized here and the TOKEN is delegated to the
 * canonical owner, so this and every other bracket directory reader resolve
 * identically by construction rather than by two regexes agreeing today.
 */
export function phaseTokenFromDir(dirName: string, convention?: string | null): string | null {
  const name = assertDirName(dirName, 'phaseTokenFromDir');
  if (convention === 'bracket' && BRACKET_PHASE_DIR_RE.test(name)) {
    return extractPhaseToken(name, 'bracket');
  }
  const legacy = name.match(PHASE_TOKEN_FROM_DIR_RE);
  return legacy ? legacy[1] : null;
}

// ── Issue #26: I001 canonicalization ────────────────────────────────────────
export function canonicalPlanStem(stem: string): string {
  // #2043: the plan component (after the phase number) must be zero-padded,
  // so a digit-leading slug word (e.g. "46-6-rs-…") is not mistaken
  // for a "46-6" phase/plan pair. #2232: exactly 2 digits, so a year-leading
  // slug ("14-2026-photos-…") is not mistaken for a "14-2026" pair either.
  const m = stem.match(
    new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE}-${PHASE_CONTINUATION_SEGMENT_SOURCE})`, 'i'),
  );
  return m ? m[1] : stem;
}

/** Result of buildRoadmapPhaseVariants. */
export interface RoadmapPhaseVariantsResult {
  roadmapPhases: Set<string>;
  roadmapPhaseVariants: Set<string>;
  /**
   * #612: tokens borne ONLY by sentinel-bracket headings (0.x backlog / 999.x
   * icebox). Populated only under the bracket convention; empty otherwise, so no
   * legacy caller changes behaviour. Surfaced rather than filtered in place
   * because roadmapPhases feeds both a membership check and a missing-directory
   * warning, and only the latter should ignore an icebox item.
   *
   * OCCURRENCE-AWARE, and that is the whole subtlety: roadmapPhases is a TOKEN
   * set, so `[GSD.999] 01` and `[GSD.02] 01` collapse to one entry. Keying
   * suppression on the token alone let an icebox heading silence a REAL phase
   * that happens to share its number — a false negative worse than the warning
   * it removed. A token is suppressed only when NO non-sentinel heading bears it.
   */
  sentinelPhases: Set<string>;
}

// ── Issue #6: phase variant helpers (W006/W007) ──────────────────────────────
export function phaseVariants(phase: string): Set<string> {
  const variants = new Set([phase]);
  const dotIdx = phase.indexOf('.');
  const head = dotIdx === -1 ? phase : phase.slice(0, dotIdx);
  const tail = dotIdx === -1 ? '' : phase.slice(dotIdx);

  // Milestone-prefixed IDs: M-NN or M-N-N. Add padding-normalized variant.
  // e.g. "2-01" → also "02-01"; "02-01" → also "2-01"
  const milestoneHeadMatch = head.match(/^(\d+)((?:-\d+)+)([A-Z]?)$/i);
  if (milestoneHeadMatch) {
    const major = milestoneHeadMatch[1];
    const subSegs = milestoneHeadMatch[2]; // e.g. "-01" or "-04-01"
    const letter = milestoneHeadMatch[3] || '';
    const paddedMajor = major.padStart(2, '0');
    const unpaddedMajor = String(parseInt(major, 10));
    // Pad/unpad sub-segments individually
    const paddedSubs = subSegs.slice(1).split('-').map(s => s.padStart(2, '0')).join('-');
    const unpaddedSubs = subSegs.slice(1).split('-').map(s => String(parseInt(s, 10))).join('-');
    variants.add(`${paddedMajor}-${paddedSubs}${letter}${tail}`);
    variants.add(`${unpaddedMajor}-${unpaddedSubs}${letter}${tail}`);
    variants.add(`${unpaddedMajor}-${paddedSubs}${letter}${tail}`);
    variants.add(`${paddedMajor}-${unpaddedSubs}${letter}${tail}`);
    return variants;
  }

  // Plain numeric/decimal IDs: "1", "01", "12A", "12.1"
  const headMatch = head.match(/^(\d+)([A-Z]?)$/i);
  if (!headMatch) return variants;
  const numericHead = headMatch[1];
  const letterSuffix = headMatch[2] || '';
  variants.add(`${String(parseInt(numericHead, 10))}${letterSuffix}${tail}`);
  variants.add(`${numericHead.padStart(2, '0')}${letterSuffix}${tail}`);
  return variants;
}

export function buildRoadmapPhaseVariants(roadmapContent: string, convention?: string | null): RoadmapPhaseVariantsResult {
  const roadmapPhases = new Set<string>();
  const roadmapPhaseVariants = new Set<string>();
  const sentinelOnly = new Set<string>();
  const realTokens = new Set<string>();
  // Matches both legacy numeric (Phase 1:), decimal (Phase 2.1:), milestone-prefixed (Phase 2-01:),
  // and bracket-prefixed (### [GSD] Phase 2-01:) headings.
  // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
  // #612: SELECTED by the resolved convention. This capture class is
  // letter-tolerant, which makes it the site where an ungated widening does the
  // most damage — `### [RFC.2119] 5:` enters roadmapPhases as a phantom and
  // becomes a W007 "in ROADMAP.md but no directory on disk" on a repo that never
  // opted in. A non-bracket repo compiles the base source unchanged.
  const capturing = convention === 'bracket';
  const g = capturing ? 1 : 0;
  const phasePattern = new RegExp(`#{2,4}\\s*${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.ANY_BRACKET, convention, capturing)}([\\w][\\w.-]*)(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = phasePattern.exec(roadmapContent)) !== null) {
    const token = m[1 + g];
    const bracketId = g ? m[1] : undefined;
    if (bracketId && isSentinelPhaseId(`${bracketId}-${token}`, 'bracket')) sentinelOnly.add(token);
    else realTokens.add(token);
    roadmapPhases.add(token);
    for (const variant of phaseVariants(token)) roadmapPhaseVariants.add(variant);
  }
  // Also matches checklist-style entries (checked or unchecked):
  //   - [x] **Phase 01: name**   - [X] **Phase 2-01: name**   - [ ] **Phase 3: name**
  // This is a supported ROADMAP format (parallel to buildNotStartedPhaseVariants).
  // #612: CAPTURING, exactly as the sibling checklist scan in roadmap.cts does
  // and for the same stated reason — "the bracket id rides along so the sentinel
  // filter below is not blind to `- [ ] **[GSD.999] 01: Icebox**`". Left
  // un-capturing here, this scan called every checklist token REAL, and the
  // occurrence-aware un-suppression loop below then deleted the icebox token that
  // the HEADING scan had correctly marked sentinel — so `validate consistency`
  // warned that a bracket ICEBOX phase had no directory, in the house ROADMAP
  // shape (bold bullet index + detail headings) where the icebox appears as both.
  // `validate health` stayed silent on the same repo, so the two verbs disagreed
  // — the disagreement `sentinelPhases` exists to close.
  const checklistPattern = new RegExp(`-\\s*\\[[ xX]\\]\\s*\\*{0,2}${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, convention, capturing)}([\\w][\\w.-]*)\\s*:`, 'gi');
  let cm: RegExpExecArray | null;
  while ((cm = checklistPattern.exec(roadmapContent)) !== null) {
    const cBracketId = g ? cm[1] : undefined;
    const cToken = cm[1 + g];
    if (cBracketId && isSentinelPhaseId(`${cBracketId}-${cToken}`, 'bracket')) sentinelOnly.add(cToken);
    else realTokens.add(cToken);
    roadmapPhases.add(cToken);
    for (const variant of phaseVariants(cToken)) roadmapPhaseVariants.add(variant);
  }
  // A token borne by BOTH a sentinel and a real heading is not suppressed.
  for (const t of realTokens) sentinelOnly.delete(t);
  return { roadmapPhases, roadmapPhaseVariants, sentinelPhases: sentinelOnly };
}

export function buildNotStartedPhaseVariants(roadmapContent: string, convention?: string | null): Set<string> {
  const notStartedPhases = new Set<string>();
  // Also matches milestone-prefixed and bracket-prefixed checklist items.
  // Trailing class is `[:\s*]` — a SPACE terminates the token here, not only a
  // colon — so this site is the loosest of the three and the one where a
  // retro-granted bracket tolerance would suppress a live W006.
  const uncheckedPattern = new RegExp(`-\\s*\\[\\s\\]\\s*\\*{0,2}${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, convention)}([\\w][\\w.-]*)[:\\s*]`, 'gi');
  let um: RegExpExecArray | null;
  while ((um = uncheckedPattern.exec(roadmapContent)) !== null) {
    for (const variant of phaseVariants(um[1])) notStartedPhases.add(variant);
  }
  return notStartedPhases;
}

/**
 * Detect binary corruption (embedded NUL bytes) in a text artifact's bytes.
 *
 * #2701: the plan/summary/verification/state validators must FAIL LOUD on a
 * NUL-corrupted file instead of reporting `valid: true`. A NUL byte is the
 * unambiguous signal — UTF-8 text never contains 0x00 — and a file carrying one
 * is binary-classified by `file(1)`, then silently OMITTED from recursive /
 * binary-skipping search results (`rg -l`, `grep -rI`, exit 0), so the corruption
 * reads downstream as "file absent" rather than "file corrupt." The error message
 * names that consequence so the next investigator is not misdirected.
 *
 * This is a pure, opt-in check called explicitly by each validator at its own
 * entry point. It is deliberately NOT placed inside the shared `platformReadSync`
 * read primitive (which dozens of best-effort, tolerant reads flow through and
 * which must not start hard-failing on encoding). It does NOT strip, sanitize, or
 * repair the NUL bytes — corruption is a signal of an upstream authoring-tool bug
 * and must stay visible.
 *
 * @param buf   the file bytes (Buffer or string; a string is searched char-wise)
 * @param relPath  a path/label for the diagnostic message
 * @returns an error string when NUL is found, or `null` when the bytes are clean text
 */
export function textEncodingError(buf: Buffer | string, relPath: string): string | null {
  const nul = typeof buf === 'string' ? buf.indexOf('\0') : buf.indexOf(0x00);
  if (nul === -1) return null;
  return (
    `${relPath}: file contains NUL bytes (first at offset ${nul}). ` +
    'Artifact files must be UTF-8 text. A NUL-corrupted file is binary-classified ' +
    'and silently skipped by recursive / binary-skipping search tools (rg, grep -I), ' +
    'so downstream verification reports its contents as missing rather than corrupt.'
  );
}

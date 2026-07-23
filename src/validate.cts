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
  SINGLE_DIGIT_RUN_SEGMENT_SOURCE,
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
// #2528: a two-digit segment immediately followed by a single-digit-run slug
// segment is also left out of the token ("10-24-7-autonomy" captures "10").
// The negative lookahead is built from the same owner source used by
// extractPhaseToken's rewind rule so the regex and imperative surfaces agree.
// The first component stays "\d+"
// (with the "[A-Z]?" suffix) so single-digit letter-suffixed phase ids ("1A") and
// milestone-prefixed single-digit sub-phases ("M1-2" → prefix "M1-" stripped, then
// "2") still match. The trailing boundary "(?:-|$)" (was "(?:-[a-z]|$)") lets a slug
// that starts with a digit terminate the token.
export const PHASE_TOKEN_FROM_DIR_RE = new RegExp(
  `^${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}(\\d+(?:-${PHASE_CONTINUATION_SEGMENT_SOURCE}(?!-${SINGLE_DIGIT_RUN_SEGMENT_SOURCE}))*[A-Z]?(?:\\.\\d+)*)(?:-|$)`,
  'i',
);
export const MILESTONE_ARCHIVE_DIR_RE = /^v\d+.*-phases$/i;

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

export function buildRoadmapPhaseVariants(roadmapContent: string): RoadmapPhaseVariantsResult {
  const roadmapPhases = new Set<string>();
  const roadmapPhaseVariants = new Set<string>();
  // Matches both legacy numeric (Phase 1:), decimal (Phase 2.1:), milestone-prefixed (Phase 2-01:),
  // and bracket-prefixed (### [GSD] Phase 2-01:) headings.
  // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
  const phasePattern = /#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+([\w][\w.-]*)(?:\s*\([^)\n]{0,200}\))?\s*:/gi;
  let m: RegExpExecArray | null;
  while ((m = phasePattern.exec(roadmapContent)) !== null) {
    roadmapPhases.add(m[1]);
    for (const variant of phaseVariants(m[1])) roadmapPhaseVariants.add(variant);
  }
  // Also matches checklist-style entries (checked or unchecked):
  //   - [x] **Phase 01: name**   - [X] **Phase 2-01: name**   - [ ] **Phase 3: name**
  // This is a supported ROADMAP format (parallel to buildNotStartedPhaseVariants).
  const checklistPattern = /-\s*\[[ xX]\]\s*\*{0,2}Phase\s+([\w][\w.-]*)\s*:/gi;
  let cm: RegExpExecArray | null;
  while ((cm = checklistPattern.exec(roadmapContent)) !== null) {
    roadmapPhases.add(cm[1]);
    for (const variant of phaseVariants(cm[1])) roadmapPhaseVariants.add(variant);
  }
  return { roadmapPhases, roadmapPhaseVariants };
}

export function buildNotStartedPhaseVariants(roadmapContent: string): Set<string> {
  const notStartedPhases = new Set<string>();
  // Also matches milestone-prefixed and bracket-prefixed checklist items.
  const uncheckedPattern = /-\s*\[\s\]\s*\*{0,2}Phase\s+([\w][\w.-]*)[:\s*]/gi;
  let um: RegExpExecArray | null;
  while ((um = uncheckedPattern.exec(roadmapContent)) !== null) {
    for (const variant of phaseVariants(um[1])) notStartedPhases.add(variant);
  }
  return notStartedPhases;
}

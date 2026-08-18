/**
 * Roadmap — Roadmap parsing and update operations
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/roadmap.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { realClock } from './clock.cjs';
import { escapeRegex } from './pattern.cjs';
import { splitLines, detectEol, joinLines } from './text-lines.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
// #2528 moved this file's directory read off the `phaseTokenMatches` primitive
// and onto the shared `matchPhaseDirs` selector, so the primitive is DROPPED
// here rather than carried alongside — upstream's stated end state is that it
// has no call sites outside phase-id.cts. The #612 bracket helpers are
// untouched by that move and are kept.
// #3212 Phase 1 drops `escapeRegex` from this destructure as well: the symbol
// left phase-id.cts entirely and `src/pattern.cts` is its sole owner, imported
// at the top of this file. A re-homing of one unrelated import — no #612
// helper's provenance changes.
const { normalizePhaseName, phaseMarkdownRegexSource, matchPhaseDirs, stripProjectCodePrefix, OPTIONAL_PHASE_TAG_SOURCE, roadmapPhaseLookupSources, phaseHeadingPrefixSrcFor, PHASE_HEADING_BASELINE, isSentinelPhaseId, bracketQualifiedKey, foldBracketId, scopeToPhase } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { findPhaseInternal, listMilestonePhaseDirs } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserModule = require('./roadmap-parser.cjs');
const { stripShippedMilestones, extractCurrentMilestone, extractCurrentMilestoneScoped, replaceInCurrentMilestone, listMilestoneHeadings, scanMilestonePhaseIds, collectTablePhaseRows } = roadmapParserModule;
import { tokenizeHeadings } from './markdown-sectionizer.cjs';
import { updateTableCell } from './markdown-table.cjs';
import { clampPercent } from './phase-lifecycle.cjs';
import { platformWriteSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningPaths, withPlanningLock, findContextMdIn, resolvePhaseIdConvention } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import scanPhasePlans = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { countMatchedSummaries, findUnsummarizedPlans } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter, parseMustHavesBlock } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verificationMod = require('./verification.cjs');
const { isPhaseComplete } = verificationMod;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PhasePlansAndSummaries {
  planCount: number;
  summaryCount: number;
  hasContext: boolean;
  hasResearch: boolean;
}

interface PhaseSearchResult {
  found: boolean;
  phase_number: string;
  phase_name: string;
  goal?: string | null;
  mode?: string | null;
  success_criteria?: string[];
  section?: string;
  error?: string;
  message?: string;
}

interface TruthValue {
  count: number;
  text: string;
}

// ─── coerceTruthToString ──────────────────────────────────────────────────────

/**
 * Coerce an arbitrary YAML scalar/object into a string for cross-cutting
 * truth aggregation. Handles:
 *   - strings (passthrough)
 *   - numbers / booleans (String() coercion — issue #2770: bare YAML ints
 *     like `- 3` must be surfaced, not silently skipped)
 *   - kv-shaped objects from parseMustHavesBlock continuation kv (issue
 *     #2757) — extract the first meaningful string field
 *
 * Returns the empty string when no usable text can be derived; callers should
 * skip empty results.
 */
function coerceTruthToString(t: unknown): string {
  if (t === null || t === undefined) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'number' || typeof t === 'boolean' || typeof t === 'bigint') {
    return String(t);
  }
  if (typeof t === 'object') {
    // Prefer common title-bearing keys produced by parseMustHavesBlock. `statement` is the canonical
    // truth/prohibition payload field — and the carrier of #1154's object-form backstop truth
    // `{ statement, verification: backstop }`, so it leads (a non-inferable truth must be coerced by
    // its statement, never dropped — the Hyrum backward-compat guard for the new marker).
    for (const k of ['statement', 'title', 'text', 'name', 'rule', 'path', 'provides']) {
      const v = (t as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
  }
  return '';
}

// ─── countPhasePlansAndSummaries ──────────────────────────────────────────────

function countPhasePlansAndSummaries(phaseDir: string): PhasePlansAndSummaries {
  const { planCount, summaryCount } = scanPhasePlans(phaseDir);
  // hasContext and hasResearch are not plan-scan concerns — read the directory
  // once and share the listing for all non-plan metadata that cmdRoadmapAnalyze needs.
  let phaseFiles: string[] = [];
  try { phaseFiles = fs.readdirSync(phaseDir); } catch { /* empty */ }
  // #3511: scope the raw listing to this phase dir before the
  // phase-numbered-artifact predicates (hasContext/hasResearch) — planCount/
  // summaryCount above stay on scanPhasePlans's own unscoped listing since a
  // PLAN/SUMMARY leading number is a plan sequence number, not a phase
  // number. Mirrors core-utils.cts's getPhaseFileStats.
  const scopedFiles = scopeToPhase(phaseFiles, path.basename(phaseDir));
  return {
    planCount,
    summaryCount,
    hasContext: findContextMdIn(scopedFiles) !== null,
    hasResearch: scopedFiles.some(f => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md'),
  };
}

// `phaseMarkdownRegexSource` lives in phase-id.cjs (#3537) and is imported above.

// ─── searchPhaseInContent ─────────────────────────────────────────────────────

/**
 * Build the phase-heading regex used by `searchPhaseInContent` for a given
 * pre-escaped phase source. Extracted (#3412) so tests can assert against the
 * exact production pattern instead of hand-duplicating it.
 * #1729: OPTIONAL_PHASE_TAG_SOURCE after the number tolerates a pre-colon ( ) tag.
 *
 * #612: the heading intro is SELECTED by the resolved convention rather than
 * spelled literally. `convention` is OPTIONAL and trails #3412's signature, so
 * every convention-less caller — including `tests/phase-id.test.cjs:24`, which
 * imports this function precisely to assert the exact production pattern —
 * compiles the byte-identical source the literal previously spelled: at the
 * ANY_BRACKET baseline with no convention the selector returns
 * `(?:\[[^\]]{1,200}\]\s*)?Phase\s+` verbatim. Threading the parameter through
 * #3412's extraction rather than reinstating a second inline construction keeps
 * this function the single owner of the pattern, which is the whole point of
 * the extraction.
 */
function buildPhaseHeadingRegex(escapedPhase: string, convention?: string | null): RegExp {
  return new RegExp(
    `^${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.ANY_BRACKET, convention)}${escapedPhase}${OPTIONAL_PHASE_TAG_SOURCE}:\\s*(.+)$`,
    'i'
  );
}

/**
 * Search for a phase header (and its section) within the given content string.
 * Returns a result object if found (either a full match or a malformed_roadmap
 * checklist-only match), or null if the phase is not present at all.
 */
function searchPhaseInContent(content: string, escapedPhase: string, phaseNum: string, convention?: string | null): PhaseSearchResult | null {
  const headingPattern = buildPhaseHeadingRegex(escapedPhase, convention);
  const headings = tokenizeHeadings(content);
  const headingIndex = headings.findIndex((heading) => headingPattern.test(heading.text));
  const headerMatch = headingIndex === -1 ? null : headings[headingIndex].text.match(headingPattern);

  if (!headerMatch) {
    // Fallback: check if phase exists in summary list but missing detail section
    // A BARE `Phase\s+` at base — takes the label-only baseline, so a bracket
    // repo gains the bracket-ID form and nothing else.
    const checklistPattern = new RegExp(
      `-\\s*\\[[ x]\\]\\s*\\*\\*${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, convention)}${escapedPhase}${OPTIONAL_PHASE_TAG_SOURCE}:\\s*([^*]+)\\*\\*`,
      'i'
    );
    const checklistMatch = content.match(checklistPattern);

    if (checklistMatch) {
      return {
        found: false,
        phase_number: phaseNum,
        phase_name: checklistMatch[1].trim(),
        error: 'malformed_roadmap',
        message: `Phase ${phaseNum} exists in summary list but missing "### Phase ${phaseNum}:" detail section. ROADMAP.md needs both formats.`
      };
    }

    return null;
  }

  const phaseName = headerMatch[1].trim();
  const headerIndex = headings[headingIndex].offset;

  const currentHeading = headings[headingIndex];
  const nextHeading = headings
    .slice(headingIndex + 1)
    .find((candidate) => candidate.level <= currentHeading.level);
  const sectionEnd = nextHeading ? nextHeading.offset : content.length;

  const section = content.slice(headerIndex, sectionEnd).trim();

  // Extract goal if present (supports both **Goal:** and **Goal**: formats)
  const goalMatch = section.match(/\*\*Goal(?::\*\*|\*\*:)\s*([^\n]+)/i);
  const goal = goalMatch ? goalMatch[1].trim() : null;

  // Mode: vertical-MVP slice mode flag. Lowercased + trimmed for canonical
  // comparison; unrecognized values are preserved verbatim for forward-compat.
  const modeMatch = section.match(/\*\*Mode(?::\*\*|\*\*:)\s*([^\n]+)/i);
  const mode = modeMatch ? modeMatch[1].trim().toLowerCase() : null;

  // Extract success criteria as structured array. A criterion may wrap onto extra
  // indented lines (no `N.` prefix); those continuations must fold INTO their
  // criterion, not end the run (#2522 — the old `(?:\s*\d+\.\s*[^\n]+)+` broke on a
  // wrapped line, truncating it and silently dropping every criterion below it).
  // `\n*` before each numbered line keeps blank-line-separated criteria working.
  const criteriaMatch = section.match(
    /\*\*Success Criteria\*\*[^\n]*:\s*\n((?:\n*[ \t]*\d+\.[^\n]*\n?(?:[ \t]+(?!\d+\.)[^\n]*\n?)*)+)/i);
  const success_criteria = criteriaMatch
    ? criteriaMatch[1].trim().split(/\n+(?=[ \t]*\d+\.)/)
        .map(entry => entry.replace(/^\s*\d+\.\s*/, '').replace(/\s*\n\s*/g, ' ').trim())
        .filter(Boolean)
    : [];

  return {
    found: true,
    phase_number: phaseNum,
    phase_name: phaseName,
    goal,
    mode,
    success_criteria,
    section,
  };
}

// ─── getRoadmapPhaseWithFallback ──────────────────────────────────────────────

/**
 * Two-pass phase lookup that mirrors cmdRoadmapGetPhase's resolution strategy.
 *
 * Pass 1: current-milestone slice (extractCurrentMilestone).
 * Pass 2: full roadmap content (stripShippedMilestones) — covers cross-milestone
 *         and older frontend phases that are no longer in the current milestone slice.
 *
 * Returns the phase section string if found, null if ROADMAP.md is missing,
 * or throws if ROADMAP.md read fails.
 *
 * Used by check-command-router (computeUiPlanGate) so ui-plan-gate uses the SAME
 * phase resolution as `roadmap.get-phase` — not a milestone-only subset.
 */
function getRoadmapPhaseWithFallback(cwd: string, phaseNum: string): string | null {
  // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
  if (isSentinelPhaseId(stripProjectCodePrefix(phaseNum))) return null;
  const roadmapPath = planningPaths(cwd).roadmap;
  // Read directly rather than gating on fs.existsSync: existsSync returns false
  // on EACCES/EIO too, which would mask an UNREADABLE roadmap as "missing" and
  // let a blocking gate certify empty scope (#2365 review). Honor the documented
  // contract — null only when genuinely absent (ENOENT), otherwise throw.
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw err;
  }
  const milestoneContent = extractCurrentMilestone(rawContent, cwd);
  const fullContent = stripShippedMilestones(rawContent);

  // #2121/#2114: iterate the shared lookup-source list (exact → numeric →
  // prefix-tolerant) so this resolver matches getRoadmapPhaseInternal and a
  // bare-number query resolves a drifted project-code-prefixed heading.
  const convention = resolvePhaseIdConvention(cwd);
  for (const source of roadmapPhaseLookupSources(phaseNum)) {
    const milestoneResult = searchPhaseInContent(milestoneContent, source, phaseNum, convention);
    if (milestoneResult && !milestoneResult.error) return milestoneResult.section ?? null;
    const fullResult = searchPhaseInContent(fullContent, source, phaseNum, convention);
    if (fullResult && !fullResult.error) return fullResult.section ?? null;
  }

  return null;
}

// ─── cmdRoadmapGetPhase ───────────────────────────────────────────────────────

function cmdRoadmapGetPhase(cwd: string, phaseNum: string, raw: boolean): void {
  // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
  if (isSentinelPhaseId(stripProjectCodePrefix(phaseNum))) {
    output({ found: false, phase_number: phaseNum }, raw, '');
    return;
  }
  const roadmapPath = planningPaths(cwd).roadmap;

  if (!fs.existsSync(roadmapPath)) {
    output({ found: false, error: 'ROADMAP.md not found' }, raw, '');
    return;
  }

  try {
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const milestoneContent = extractCurrentMilestone(rawContent, cwd);

    const fullContent = stripShippedMilestones(rawContent);
    const convention = resolvePhaseIdConvention(cwd);

    // #2121/#2114: iterate the shared lookup-source list (exact → numeric →
    // prefix-tolerant) so all three roadmap resolvers share one contract and a
    // bare-number query resolves a drifted `### Phase AB-29:` heading. This
    // preserves the #3599 exact-prefix-first and #3537 padding-tolerant behavior
    // (both now encoded in roadmapPhaseLookupSources' ordering). A clean match
    // (milestone or full, any source) wins immediately; a malformed_roadmap
    // (checklist-only) candidate is surfaced only if no source finds a real
    // heading — so a milestone checklist never blocks a full-roadmap header.
    let malformed: PhaseSearchResult | null = null;
    for (const source of roadmapPhaseLookupSources(phaseNum)) {
      const milestoneResult = searchPhaseInContent(milestoneContent, source, phaseNum, convention);
      if (milestoneResult && !milestoneResult.error) {
        output(milestoneResult, raw, milestoneResult.section);
        return;
      }
      const fullResult = searchPhaseInContent(fullContent, source, phaseNum, convention);
      if (fullResult && !fullResult.error) {
        output(fullResult, raw, fullResult.section);
        return;
      }
      if (!malformed) malformed = (milestoneResult?.error ? milestoneResult : (fullResult?.error ? fullResult : null));
    }

    // #3577: no heading or checklist entry matched — fall back to a
    // markdown-table row declaration (the same last-resort tier
    // getRoadmapPhaseInternal gained). Zero-pad-tolerant id compare (#3572
    // lesson: the declared form may be padded).
    const stripPad = (s: string) => s.replace(/^0+(?=.)/, '');
    const tableHit = collectTablePhaseRows(milestoneContent).find((tr) => stripPad(tr.id) === stripPad(phaseNum))
      ?? collectTablePhaseRows(fullContent).find((tr) => stripPad(tr.id) === stripPad(phaseNum));
    if (tableHit) {
      output(
        { found: true, phase_number: phaseNum, phase_name: tableHit.name ?? `Phase ${tableHit.id}`, goal: null, section: tableHit.row.trim() },
        raw,
        tableHit.row.trim(),
      );
      return;
    }

    if (malformed) {
      output(malformed, raw, '');
      return;
    }

    output({ found: false, phase_number: phaseNum }, raw, '');
  } catch (e) {
    error('Failed to read ROADMAP.md: ' + (e as Error).message);
  }
}

// ─── cmdRoadmapAnalyze ────────────────────────────────────────────────────────

/**
 * #3165: a single phase-detail heading enriched with its on-disk status, as
 * `cmdRoadmapAnalyze` reports it. Extracted so the SAME enrichment runs on both
 * the scoped milestone window and, when that window is suspect (non-COMPLETE
 * scope, zero phases, phase dirs on disk), the shipped-milestone-stripped
 * fallback document.
 */
type AnalyzePhase = {
  number: string;
  name: string;
  goal: string | null;
  mode: string | null;
  depends_on: string | null;
  plan_count: number;
  summary_count: number;
  has_context: boolean;
  has_research: boolean;
  disk_status: string;
  roadmap_complete: boolean;
};

/**
 * #2761 M1 + #3165: the scan's two coupled outputs. `detailKeys` holds the
 * OCCURRENCE keys of the detail headings `phases` was built from — collected in
 * the same loop, past the same sentinel `continue`, so the two cannot disagree
 * about which headings count. They are returned together because the #3165
 * fallback below swaps BOTH or neither: a `detailKeys` left over from the
 * scoped scan while `phases` came from the fallback document would report every
 * recovered phase as `missing_phase_details`.
 */
type AnalyzeScan = { phases: AnalyzePhase[]; detailKeys: Set<string> };

// Phase 0 (pre-milestone) and Phase 999 (backlog) are sentinels, not real
// phases. They legitimately have no directory and must never be surfaced as
// current/next phase or counted in phase_count. Mirrors the engine-wide
// sentinel convention (phase-id getMilestoneFromPhaseId, roadmap-command-router
// SENTINELS, the #1445 /^999/ progress filters). (#1580)
// #612 READING-B: under the bracket convention the sentinel milestone lives in
// the BRACKET (`### [GSD.999] 01:`), not in the phase token, so testing the
// token alone is blind exactly when the widened read starts matching those
// headings — an icebox item would count as a real phase (#1445/#1580). A
// heading with no bracket keeps the legacy leading-integer rule byte-for-byte.
// #612 READING-B adds a rule, it does not replace one: a bracketed heading is a
// sentinel when its BRACKET milestone is reserved (`### [GSD.999] 01:`) OR when
// its token is, so the engine-wide 0/999 backlog convention (#1445/#1580) keeps
// applying to `### [GSD.02] 999:`. Replacing the token rule instead let a
// mid-migration ROADMAP — bracket headings plus a legacy 999 backlog block,
// exactly the content this epic targets — add entries to the denominator.
//
// #3185 (ADR-3180 Decision 1): the legacy leg is the canonical
// `isSentinelPhaseId` (src/phase-id.cts, SENTINEL_RANGES), NOT the local
// `parseInt(num,10) === 0 || === 999` copy #3185 deleted — that copy was the
// fourth independent expression of the engine-wide convention #1580
// describes. This predicate survives #3185's deletion only because it COMPOSES
// that owner with the bracket reading above; it re-derives nothing.
//
// #3165 re-homing: this and `occurrenceKey` below were closures inside
// `cmdRoadmapAnalyze` until #3165 split the detail scan into
// `collectAnalyzePhases`. Both scopes read them — the extracted heading loop
// and the caller's checklist loop — and neither closes over anything (the
// `'bracket'` arguments below are literals, not the resolved convention), so
// they are hoisted verbatim rather than duplicated or re-parameterised.
const isSentinelPhase = (num: string, bracketId?: string): boolean => {
  if (bracketId && isSentinelPhaseId(`${bracketId}-${num}`, 'bracket')) return true;
  return isSentinelPhaseId(num);
};

// #2761 M1 (trek-e review): the OCCURRENCE key — what makes two entries the
// same phase. Under READING-B a phase's identity is its milestone-QUALIFIED
// id, because the sentinel lives in the BRACKET: `[GSD.999] 01` and
// `[GSD.02] 01` share a token and are not the same phase, and only one of
// them is an icebox item. Keying on the bare token gave the pair ONE
// classification between them, so `missing_phase_details` depended on which
// bullet the author happened to write first.
//
// Prefers the owner's `bracketQualifiedKey`, which case-FOLDS, so
// `[gsd.02] 01` and `[GSD.02] 01` are one phase. (It is not padding-tolerant
// and does not need to be: the milestone grammar accepts exactly one spelling
// per milestone — pad2 below 100, no leading zero above — so `[GSD.2]` is
// malformed rather than an alternate spelling of `[GSD.02]`, and it takes the
// fallback below.) Two shapes the owner refuses, both falling back to a
// fold-normalized composite that still separates distinct pairs: a token
// carrying its OWN hyphen — `[GSD.02] 02-01` splices
// to `GSD.02-02-01`, which the qualified-key grammar reads as milestone 02 /
// phase 02 with the trailing `-01` truncated, collapsing distinct headings
// onto one key (the same splice hazard `getMilestonePhaseFilter` guards with
// its own `!token.includes('-')`), and any id the grammar does not accept.
// With no bracket id the bare token IS the identity — the legacy path, whose
// keys and dedupe order are byte-identical to base.
const occurrenceKey = (num: string, bracketId?: string): string => {
  if (!bracketId) return num;
  const qualified = num.includes('-')
    ? null
    : bracketQualifiedKey(`${bracketId}-${num}`, 'bracket');
  return qualified ?? `${foldBracketId(bracketId)}|${num}`;
};

/**
 * #3165: scan `content` for phase-detail headings (`##/###/#### Phase N: Name`)
 * and enrich each with its on-disk plan/summary/completion status and ROADMAP
 * checkbox. Pure extraction over `content` + the pre-built `phaseDirNames`
 * lookup index — no milestone windowing of its own; the caller chooses the
 * content (scoped window or fallback). Extracted verbatim from
 * `cmdRoadmapAnalyze`'s former inline loop so the fallback re-runs the EXACT
 * same enrichment, not a second derivation.
 *
 * #612: `convention` is the caller's ONCE-resolved `phase_id_convention`,
 * threaded rather than re-read here — it selects every heading/checklist
 * pattern below AND the directory read, so both call sites (the scoped window
 * and the #3165 fallback) get the same reading. Required, not optional: a
 * future call site that forgets it must be a compile error, not a silent
 * relapse to the legacy reading on exactly the recovery path #3165 exists for.
 */
function collectAnalyzePhases(
  content: string,
  phasesDir: string,
  phaseDirNames: string[],
  convention: string | null,
): AnalyzeScan {
  // Extract all phase headings: ## Phase N: Name or ### Phase N: Name
  // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
  // #612: CAPTURING intro under the bracket convention — group 1 is the
  // `[CODE.MM]` bracket id (undefined otherwise), group 2 the token, group 3 the
  // name. The bracket id is what the sentinel filter needs: READING-B puts the
  // sentinel milestone in the bracket, not in the token.
  // #3036: the id capture accepts non-numeric-leading ids (e.g. B7, P0.3-2) that
  // get-phase/execute-phase already resolve. The optional leading letter prefix
  // ([A-Za-z]?) covers letter-prefixed ids without breaking numeric-leading ones.
  // phase-id-owner: uses the [.-] (dot-or-dash) separator variant, not the canonical dot-only token; a swap to PHASE_NUMBER_TOKEN_SOURCE would drop hyphenated phase-id matches.
  const phasePattern = new RegExp(`#{2,4}\\s*${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.ANY_BRACKET, convention, true)}([A-Za-z]?\\d+[A-Z]?(?:[.-]\\d+)*)(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n]+)`, 'gi');
  // Group offset: the capturing intro inserts the bracket id at 1 only when the
  // bracket convention is active; otherwise the pattern has no such group and
  // the token is back at 1. (#3165 split this loop out of `cmdRoadmapAnalyze`;
  // its checklist loop derives the same offset from the same resolved
  // convention — see the second `G` there.)
  const G = convention === 'bracket' ? 1 : 0;
  const phases: AnalyzePhase[] = [];
  let match: RegExpExecArray | null;

  // #2761 M1: the occurrence keys of the DETAIL headings, collected in the same
  // loop and past the same sentinel `continue` as `phases` itself, so the two
  // cannot disagree about which headings count. Keyed per occurrence rather
  // than by bare token: `[GSD.02] 01`'s heading previously marked the token
  // `01` present, which then satisfied `[GSD.03] 01` — a different phase, with
  // no heading anywhere — and hid it from `missing_phase_details`.
  const detailKeys = new Set<string>();
  while ((match = phasePattern.exec(content)) !== null) {
    const bracketId = G ? match[1] : undefined;
    const phaseNum = match[1 + G];
    if (isSentinelPhase(phaseNum, bracketId)) continue;
    detailKeys.add(occurrenceKey(phaseNum, bracketId));
    const phaseName = match[2 + G].replace(/\(INSERTED\)/i, '').trim();

    // Extract goal from the section
    const sectionStart = match.index;
    const restOfContent = content.slice(sectionStart);
    // #3691: `\d` → `\d[\d.]*` so decimal phase headings (e.g. `### Phase 02.3:`) are
    // recognised as section boundaries. #3036: `[A-Za-z]?\d` so non-numeric-leading ids
    // (e.g. B7) are also recognised.
    const nextHeader = restOfContent.match(new RegExp(`\\n#{2,4}\\s+${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.ANY_BRACKET, convention)}[A-Za-z]?\\d[\\d.-]*`, 'i'));
    const sectionEnd = nextHeader ? sectionStart + nextHeader.index! : content.length;
    const section = content.slice(sectionStart, sectionEnd);

    const goalMatch = section.match(/\*\*Goal(?::\*\*|\*\*:)\s*([^\n]+)/i);
    const goal = goalMatch ? goalMatch[1].trim() : null;

    const modeMatch = section.match(/\*\*Mode(?::\*\*|\*\*:)\s*([^\n]+)/i);
    const mode = modeMatch ? modeMatch[1].trim().toLowerCase() : null;

    const dependsMatch = section.match(/\*\*Depends on(?::\*\*|\*\*:)\s*([^\n]+)/i);
    const depends_on = dependsMatch ? dependsMatch[1].trim() : null;

    // Check completion on disk
    const normalized = normalizePhaseName(phaseNum);
    let diskStatus = 'no_directory';
    let planCount = 0;
    let summaryCount = 0;
    let hasContext = false;
    let hasResearch = false;

    // DEAD catch removed (#2245 audit): matchPhaseDirs(...) is a pure
    // array lookup on an already-resolved string array, and
    // countPhasePlansAndSummaries is itself fully defensive (its own
    // readdirSync is self-guarded, and it delegates to scanPhasePlans, which
    // never throws) — nothing in this block can throw, so the try/catch could
    // never be triggered.
    // #612: the DIRECTORY read is selected by the same `convention` the four
    // heading/checklist patterns above already thread. Left two-argument, this
    // one call reported EVERY canonical `{CODE}.{MM}-{PP}-slug` directory as
    // `disk_status: "no_directory"` with `plan_count`/`summary_count` 0 —
    // `extractPhaseToken('GSD.02-01-one')` with no convention returns the whole
    // dir name — while the same build resolved those same directories correctly
    // in three other places on the same repo (W006/W007 via phaseTokenFromDir,
    // `state json` via the milestone filter, and the W021 milestone-complete read
    // through this very helper's three-argument form at the W021 site). It
    // failed ONLY for the directory shape the convention exists to name: a
    // mid-migration bracket repo carrying legacy `01-one` dirs resolved fine.
    // That is verbatim the asymmetry the note above the W021 site says this PR
    // closed — the directory read widens with the heading read, or every bracket
    // phase resolves to nothing.
    //
    // #2528 consolidated this read onto the shared `matchPhaseDirs` selector.
    // The convention rides along into it, per the seam agreement recorded on
    // that function: the selector's primary match IS `phaseTokenMatches`, so
    // dropping the argument here would reinstate exactly the regression the
    // paragraph above describes. `.matches[0]` reproduces the prior `.find()`
    // choice — the selector filters without reordering.
    //
    // #3165 made this ONE read serve TWO call paths — the scoped milestone
    // window and the truncated-window fallback. The threading covers both by
    // construction: `convention` is a parameter of this function, so the
    // fallback cannot resolve directories differently from the scoped scan.
    const dirMatch = matchPhaseDirs(phaseDirNames, normalized, convention).matches[0];

    if (dirMatch) {
      const counts = countPhasePlansAndSummaries(path.join(phasesDir, dirMatch));
      planCount = counts.planCount;
      summaryCount = counts.summaryCount;
      hasContext = counts.hasContext;
      hasResearch = counts.hasResearch;

      // ADR-3180 §7.4 (issue #3186, disk-strict, #3168 fix): route "is this
      // phase complete" through the canonical owner (`isPhaseComplete`),
      // which calls readVerificationStatus UNCONDITIONALLY — plan count is
      // NOT a precondition, so a zero-plan phase with a passing
      // `*-VERIFICATION.md` reports complete here too, not just via
      // `phase.complete`.
      const completionResult = isPhaseComplete(path.join(phasesDir, dirMatch));
      if (completionResult.value.complete) diskStatus = 'complete';
      else if (summaryCount > 0) diskStatus = 'partial';
      else if (planCount > 0) diskStatus = 'planned';
      else if (hasResearch) diskStatus = 'researched';
      else if (hasContext) diskStatus = 'discussed';
      else diskStatus = 'empty';
    }

    // Check ROADMAP checkbox status. #3537: padding-tolerant fragment — the
    // heading discovered above may use a different padding than the
    // summary-bullet checkbox below it (mixed padding inside one ROADMAP is
    // legal and seen in real projects).
    //
    // ADR-3180 §7.4 (disk-strict, #2957, maintainer decision 2026-08-08):
    // `roadmapComplete` is reported below as metadata ONLY — it carries NO
    // machine authority over `diskStatus`. The override that used to trust a
    // ticked checkbox over disk file structure is DELETED, not generalized
    // (#2957: "a ticked ROADMAP checkbox is a human annotation with no
    // machine authority"). A phase marked complete solely by a ticked
    // checkbox — no passing `*-VERIFICATION.md`, plans outstanding — now
    // reports incomplete; this is the deliberate Tier-2 break (ADR-3180 §7.4
    // Decision 3).
    //
    // #612: the label prefix comes from the owner builder — it is `Phase\s+`
    // verbatim when the convention is not bracket, so the legacy read is
    // byte-identical to the literal this replaced.
    const checkboxPattern = new RegExp(`-\\s*\\[(x| )\\]\\s*.*${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, convention)}${phaseMarkdownRegexSource(phaseNum)}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s]`, 'i');
    const checkboxMatch = content.match(checkboxPattern);
    const roadmapComplete = checkboxMatch ? checkboxMatch[1] === 'x' : false;

    phases.push({
      number: phaseNum,
      name: phaseName,
      goal,
      mode,
      depends_on,
      plan_count: planCount,
      summary_count: summaryCount,
      has_context: hasContext,
      has_research: hasResearch,
      disk_status: diskStatus,
      roadmap_complete: roadmapComplete,
    });
  }

  // #3577: markdown-table row declarations join the enumeration — same
  // enrichment contract as headings (disk counts when the directory exists),
  // zero-pad-tolerant duplicate guard so an id declared in BOTH a heading and
  // a table counts once.
  const stripPadA = (s: string) => s.replace(/^0+(?=.)/, '');
  const seen = new Set(phases.map((ph) => stripPadA(ph.number)));
  for (const tr of collectTablePhaseRows(content)) {
    if (seen.has(stripPadA(tr.id))) continue;
    const dirMatchA = matchPhaseDirs(phaseDirNames, normalizePhaseName(tr.id)).matches[0];
    let tPlanCount = 0;
    let tSummaryCount = 0;
    let tHasContext = false;
    let tHasResearch = false;
    if (dirMatchA) {
      const counts = countPhasePlansAndSummaries(path.join(phasesDir, dirMatchA));
      tPlanCount = counts.planCount;
      tSummaryCount = counts.summaryCount;
      tHasContext = fs.existsSync(path.join(phasesDir, dirMatchA, 'CONTEXT.md'));
      tHasResearch = fs.existsSync(path.join(phasesDir, dirMatchA, 'RESEARCH.md'));
    }
    phases.push({
      number: tr.id,
      name: tr.name ?? `Phase ${tr.id}`,
      goal: null,
      mode: null,
      depends_on: null,
      plan_count: tPlanCount,
      summary_count: tSummaryCount,
      has_context: tHasContext,
      has_research: tHasResearch,
      disk_status: dirMatchA ? 'ok' : 'no_directory',
      roadmap_complete: false,
    });
  }
  // #2761 M1: table-declared rows join `phases` above but are NOT heading
  // occurrences, so `detailKeys` (heading-only) is untouched — it keeps
  // scoping `missing_phase_details` to phases that lack a DETAIL heading,
  // regardless of whether they also have a table row.
  return { phases, detailKeys };
}

function cmdRoadmapAnalyze(cwd: string, raw: boolean): void {
  const roadmapPath = planningPaths(cwd).roadmap;

  if (!fs.existsSync(roadmapPath)) {
    output({ error: 'ROADMAP.md not found', milestones: [], phases: [], current_phase: null }, raw, undefined);
    return;
  }

  const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  // #3184/#3165: use the scoped variant so a truncated window is a
  // distinguishable signal in the output instead of a silent `phase_count: 0`
  // indistinguishable from a genuinely empty milestone.
  const { value: content, scope } = extractCurrentMilestoneScoped(rawContent, cwd);
  const phasesDir = planningPaths(cwd).phases;
  // #612: resolved ONCE per command, then threaded — never re-read per heading.
  const convention = resolvePhaseIdConvention(cwd);
  // Group offset for the checklist scan below; same rule as, and same resolved
  // convention as, `collectAnalyzePhases`'s own `G` (see the comment there).
  const G = convention === 'bracket' ? 1 : 0;

  // Build phase directory lookup once (O(1) readdir instead of O(N) per phase)
  // #3185 exemption (documented reason, not a file allowlist — ADR-3180
  // Decision 4a): this is a heading->directory LOOKUP INDEX, not a milestone
  // enumeration. It must see the PHYSICAL set so a heading already scoped by
  // extractCurrentMilestoneScoped above can find its directory; filtering it
  // through listMilestonePhaseDirs would scope the same set twice.
  const _phaseDirNames = (() => {
    try {
      return fs.readdirSync(phasesDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch { return []; }
  })();

  // Scan the scoped milestone window for phase-detail headings and enrich each
  // with its on-disk status. Extracted into `collectAnalyzePhases` (#3165) so
  // the SAME enrichment re-runs on the fallback below — not a second copy.
  let { phases, detailKeys } = collectAnalyzePhases(content, phasesDir, _phaseDirNames, convention);
  // `effectiveContent` is what the downstream checklist scan (missing_details)
  // iterates. Defaults to the scoped window; switched to the fallback document
  // when the recovery path below fires, so a phase found via fallback is not
  // falsely reported as "in checklist but missing a detail section."
  let effectiveContent = content;

  // #3165: recover phase_count when the scoped window came back empty. A
  // CLOSED milestone heading sitting between the active milestone heading and
  // its own phase-detail sections closes `extractCurrentMilestoneScoped`'s
  // window over prose only — `phases` is empty, and the consuming resume gate
  // (`workflows/next.md` Route 0) iterates `.phases[]` so a safety invariant
  // silently never runs. When the window is suspect (non-COMPLETE scope), the
  // scoped scan found nothing, AND phase directories exist on disk (real
  // evidence phases exist), re-scan the shipped-milestone-stripped document so
  // the phase list reflects the real phases instead of a silent zero. The
  // `scope` field retains its non-COMPLETE value downstream so consumers can
  // still tell this is a best-effort count, not a cleanly scoped one. Position
  // alone cannot attribute phases to the active vs the intervening closed
  // milestone, so this never claims COMPLETE — it converts silence into a
  // populated, flagged result.
  //
  // #612: the suspect-window test itself is convention-BLIND by construction —
  // `_phaseDirNames` is the raw `readdirSync` listing above, and the test is a
  // bare `.length > 0` with no token extraction or directory matching, so no
  // convention could change its verdict. The reading happens one line down,
  // inside `collectAnalyzePhases`, which is threaded.
  if (phases.length === 0 && scope !== SCOPE.COMPLETE && _phaseDirNames.length > 0) {
    const fallbackContent = stripShippedMilestones(rawContent);
    const fallbackScan = collectAnalyzePhases(fallbackContent, phasesDir, _phaseDirNames, convention);
    if (fallbackScan.phases.length > 0) {
      // #2761 M1: `detailKeys` moves WITH `phases`. The checklist scan below
      // switches to `effectiveContent` in the same breath, so all three inputs
      // to `missing_phase_details` describe one document.
      phases = fallbackScan.phases;
      detailKeys = fallbackScan.detailKeys;
      effectiveContent = fallbackContent;
    }
  }

  // Extract milestone info. #3216: routed through the canonical
  // `listMilestoneHeadings` owner (deleted the inline `##…` regex, which
  // truncated names at a parenthetical and had no phase-heading exclusion)
  // rather than re-deriving the enumeration here.
  const milestones: Array<{ heading: string; version: string }> = listMilestoneHeadings(content).map((m) => ({
    heading: m.heading,
    version: m.version,
  }));

  // Find current and next phase
  const currentPhase = phases.find(p => p.disk_status === 'planned' || p.disk_status === 'partial') || null;
  const nextPhase = phases.find(p => p.disk_status === 'empty' || p.disk_status === 'no_directory' || p.disk_status === 'discussed' || p.disk_status === 'researched') || null;

  // Aggregated stats
  const totalPlans = phases.reduce((sum, p) => sum + p.plan_count, 0);
  const totalSummaries = phases.reduce((sum, p) => sum + p.summary_count, 0);
  const completedPhases = phases.filter(p => p.disk_status === 'complete').length;

  // Detect phases in summary list without detail sections (malformed ROADMAP).
  // The char class must allow `-` (not just `.`) so dash-separated milestone-prefixed
  // IDs (e.g. `1-01`) match the detail-heading scanner above; otherwise they truncate
  // at the dash (`1-01` -> `1`) and every such phase reports a phantom missing detail.
  // #612: CAPTURING label-only intro — the bracket id rides along so the
  // sentinel filter below is not blind to `- [ ] **[GSD.999] 01: Icebox**`.
  // #3036: the token accepts non-numeric-leading ids (same widening as the detail-heading pattern above).
  // phase-id-owner: uses the [.-] (dot-or-dash) separator variant, not the canonical dot-only token; a swap to PHASE_NUMBER_TOKEN_SOURCE would drop hyphenated phase-id matches.
  const checklistPattern = new RegExp(`-\\s*\\[[ x]\\]\\s*\\*\\*${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, convention, true)}([A-Za-z]?\\d+[A-Z]?(?:[.-]\\d+)*)`, 'gi');
  // #2761 M1: an OCCURRENCE list keyed by `occurrenceKey`, not a token->bracket
  // map. The map was first-wins on the bare token, so of two checklist entries
  // sharing a token across brackets the FIRST one's bracket id classified BOTH:
  // `- [ ] **[GSD.999] 01: Icebox**` written above `- [ ] **[GSD.02] 01: …**`
  // made the real phase inherit the icebox's sentinel verdict and vanish from
  // `missing_phase_details`; written below it, the same document reported it.
  // Dedupe still happens — it is now per PHASE rather than per token, which is
  // what makes the classification order-independent.
  const checklistOccurrences: Array<{ token: string; bracketId?: string }> = [];
  const seenChecklistKeys = new Set<string>();
  let checklistMatch: RegExpExecArray | null;
  // #3165: iterates `effectiveContent`, not `content` — the fallback document
  // when the recovery path above fired, so a phase recovered from it is not
  // then reported as "in the checklist but missing a detail section."
  while ((checklistMatch = checklistPattern.exec(effectiveContent)) !== null) {
    const token = checklistMatch[1 + G];
    const bracketId = G ? checklistMatch[1] : undefined;
    const key = occurrenceKey(token, bracketId);
    if (seenChecklistKeys.has(key)) continue;
    seenChecklistKeys.add(key);
    checklistOccurrences.push({ token, bracketId });
  }
  // The EMITTED value stays the bare token, unchanged: `phases[].number` is a
  // token under every convention, and `missing_phase_details` is read against
  // it. Only the classification moved to the qualified key — so two different
  // brackets' `01` both missing report `01` once, rather than one of them
  // silently covering for the other.
  const missingDetails = [...new Set(
    checklistOccurrences
      .filter(o => !detailKeys.has(occurrenceKey(o.token, o.bracketId))
        && !isSentinelPhase(o.token, o.bracketId))
      .map(o => o.token),
  )];

  // #3217 (ADR-3180 §7.6 rules 3-4): `progress_percent` used to accumulate
  // `totalPlans`/`totalSummaries` above — a heading-matched enumeration
  // (`phasePattern` over the milestone-windowed `content`) paired against
  // `_phaseDirNames`, a DELIBERATELY unscoped physical directory listing
  // (see its own comment above: it is a heading->directory lookup index,
  // not a milestone enumeration). That set is not the same set
  // `listMilestonePhaseDirs` scopes for `query progress` / `stats` (#3185
  // Phase 3), so `progress_percent` could silently diverge from both siblings
  // on the same project (rule 3). Route `progress_percent`'s own
  // numerator/denominator through the single scoped owner instead — mirrors
  // cmdProgressRender/cmdStats's own aggregation — and withhold the
  // percentage entirely when THAT scope is not COMPLETE (rule 4), never
  // returning `0` for "could not compute". This does not touch `total_plans`
  // / `total_summaries` / `phases` / `completed_phases` above — those stay
  // the heading-matched detail view; only `progress_percent`'s own inputs
  // move onto the scoped owner.
  let scopedTotalPlans = 0;
  let scopedTotalSummaries = 0;
  let progressScope: Scope = SCOPE.UNREADABLE;
  try {
    const { value: progressDirs, scope: scopedResult } = listMilestonePhaseDirs(phasesDir, { cwd });
    progressScope = scopedResult;
    for (const dir of progressDirs) {
      const scan = scanPhasePlans(path.join(phasesDir, dir));
      scopedTotalPlans += scan.planCount;
      scopedTotalSummaries += scan.summaryCount;
    }
  } catch { /* progressScope stays the pessimistic SCOPE.UNREADABLE default */ }
  const progressPercent = progressScope === SCOPE.COMPLETE
    ? clampPercent(scopedTotalSummaries, scopedTotalPlans)
    : null;

  const result = {
    milestones,
    phases,
    phase_count: phases.length,
    completed_phases: completedPhases,
    total_plans: totalPlans,
    total_summaries: totalSummaries,
    progress_percent: progressPercent,
    // #3217 finding 2: `progress_percent` is gated by a SECOND, independently
    // computed `listMilestonePhaseDirs` scope (`progressScope` above) — not
    // by the top-level `scope` field, which describes the heading-windowing
    // identity `phases`/`total_plans`/`total_summaries`/`completed_phases`
    // were built from. Those two scopes can legitimately disagree (e.g.
    // `scope: "complete"` alongside a genuinely unreadable phases directory),
    // and per the documented contract "scope tells you whether the counts
    // are trustworthy", a consumer seeing `progress_percent: null` needs a
    // field to tell WHY without reading source. Exposing `progress_scope`
    // (rather than reconciling the two scopes into one, or re-deriving
    // `total_plans`/`phases`/etc. from the scoped set) preserves the
    // deliberate, already-documented choice a few lines up: `phases`/
    // `total_plans`/`total_summaries`/`completed_phases` stay the
    // heading-matched detail view (`_phaseDirNames` is a lookup index, not a
    // milestone enumeration — see its comment); only `progress_percent`'s own
    // inputs move onto the scoped owner.
    progress_scope: progressScope,
    current_phase: currentPhase ? currentPhase.number : null,
    next_phase: nextPhase ? nextPhase.number : null,
    missing_phase_details: missingDetails.length > 0 ? missingDetails : null,
    // #3184/#3165: distinguishes a genuinely empty milestone (`scope:
    // "complete"`, `phase_count: 0`) from a window that could not be fully
    // resolved (`"truncated"` / `"unscoped"` / `"unreadable"`) — those cases
    // were previously output-identical.
    scope,
  };

  output(result, raw, undefined);
}

// ─── cmdRoadmapMilestoneScope ────────────────────────────────────────────────

/**
 * #3262 (write-time milestone-scope guard): read-only probe emitting the
 * current milestone window's IDENTITY — its scope classification and the
 * phase ids it declares — so the edit-phase workflow can capture it before
 * its in-place section write, re-derive it after, and roll back on any
 * change. This is the milestone-scope sibling of the workflow's existing
 * `depends_on` gate, expressed as a command because the workflow's write is
 * assistant-driven free-text surgery, not a code path.
 *
 * Deliberately NOT `cmdRoadmapAnalyze`: analyze's #3165 recovery re-populates
 * `phases` from the shipped-milestone-stripped document when the scoped
 * window is suspect, which is right for a human-facing progress report and
 * wrong for a before/after equality probe — the refill would mask exactly
 * the narrowing this guard exists to detect. This probe reports the RAW
 * window (`extractCurrentMilestoneScoped` + `scanMilestonePhaseIds`), no
 * fallback, so a narrowed window is always visible as a changed phase set.
 */
function cmdRoadmapMilestoneScope(cwd: string, raw: boolean): void {
  const roadmapPath = planningPaths(cwd).roadmap;

  if (!fs.existsSync(roadmapPath)) {
    output({ error: 'ROADMAP.md not found', scope: SCOPE.UNREADABLE, phases: [], phase_count: 0 }, raw, undefined);
    return;
  }

  const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  const { value: window, scope } = extractCurrentMilestoneScoped(rawContent, cwd);
  // Document order (Set insertion order) — deterministic for a given document.
  //
  // #612: SELECTED by the resolved convention, like every other heading read on
  // this branch — and here the selection is load-bearing for the GUARD, not
  // just for the report. `scanMilestonePhaseIds` recognizes `### [GSD.02] 05:`
  // only when the convention says bracket, so a convention-BLIND call returns
  // the EMPTY set on a bracket ROADMAP: `phases: []` before the write and
  // `phases: []` after it, and edit-phase's before/after comparison passes on
  // exactly the narrowing it exists to catch. Resolved HERE, from this
  // command's own `cwd` (the same one `extractCurrentMilestoneScoped` above
  // resolves its own bracket scoping from), never inside the owner — an owner
  // that resolved for its callers would silently re-scope workstream repos.
  //
  // KNOWN GAP, deliberately NOT closed here: the `scope` axis above still runs
  // through `hasPhaseEntries`, which is convention-blind, so a pure-bracket
  // window classifies COMPLETE. This threading fixes the `phases` axis of the
  // probe; `scope` stays blind until the convention-less-readers slice lands.
  const phases = [...scanMilestonePhaseIds(window, resolvePhaseIdConvention(cwd)).ids];
  output({ scope, phases, phase_count: phases.length }, raw, undefined);
}

// ─── cmdRoadmapUpdatePlanProgress ─────────────────────────────────────────────

/**
 * Scope a ROADMAP.md content string down to its "Progress table" writable
 * slice, run `edit` against just that slice, then splice the result back into
 * the original content (ADR-2143 §7). Layered scoping:
 *   1. Milestone scope — everything after the LAST `</details>` close tag
 *      (mirrors `replaceInCurrentMilestone`), so a same-numbered phase row in
 *      an archived milestone is never touched.
 *   2. Heading scope — within that milestone slice, the `## Progress` heading
 *      section (up to the next `#`/`##` heading) when present, else the whole
 *      milestone slice (mirrors phase-lifecycle.cjs's `deriveProgressFromRoadmap`
 *      read-side scoping, #2012 decoy avoidance — a differently-headed table
 *      sharing the same column names must not be picked up instead).
 * `edit` always returns a string and never fails — a no-op edit (table/row not
 * found within the scoped slice) simply returns its input unchanged, mirroring
 * the prior regex `.replace()`'s no-match-is-a-no-op semantics.
 */
function editProgressTableSlice(content: string, edit: (scoped: string) => string): string {
  const lastDetailsClose = content.lastIndexOf('</details>');
  const milestoneOffset = lastDetailsClose === -1 ? 0 : lastDetailsClose + '</details>'.length;
  const before = content.slice(0, milestoneOffset);
  const milestoneSlice = content.slice(milestoneOffset);

  const progressMatch = milestoneSlice.match(/^##[ \t]+Progress\b/im);
  if (!progressMatch || progressMatch.index === undefined) {
    return before + edit(milestoneSlice);
  }

  const headingOffset = progressMatch.index;
  const beforeHeading = milestoneSlice.slice(0, headingOffset);
  const fromHeading = milestoneSlice.slice(headingOffset);
  const nextHeading = fromHeading.search(/\n#{1,2}[ \t]/);
  const scoped = nextHeading >= 0 ? fromHeading.slice(0, nextHeading) : fromHeading;
  const after = nextHeading >= 0 ? fromHeading.slice(nextHeading) : '';

  return before + beforeHeading + edit(scoped) + after;
}

function cmdRoadmapUpdatePlanProgress(cwd: string, phaseNum: string | null | undefined, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for roadmap update-plan-progress');
  }

  const roadmapPath = planningPaths(cwd).roadmap;

  const phaseInfo = findPhaseInternal(cwd, phaseNum);
  if (!phaseInfo) {
    error(`Phase ${phaseNum} not found`);
  }

  const planCount = phaseInfo!.plans.length;
  // Count only summaries that pair with a real plan (#1988): stray non-plan
  // summaries (30-FIX-CR02-SUMMARY.md, 30-GAPCLOSURE-SUMMARY.md, …) must not
  // inflate summary_count and silently flip the phase to Complete.
  const summaryCount = countMatchedSummaries(phaseInfo!.plans, phaseInfo!.summaries);

  if (planCount === 0) {
    output({ updated: false, reason: 'No plans found', plan_count: 0, summary_count: 0 }, raw, 'no plans');
    return;
  }

  // Verification gate (#2022): do NOT check the phase checkbox or stamp a
  // completion date until the phase's verification status is 'passed', matching
  // cmdPhaseComplete's gate (phase.cts:1436). Previously the checkbox fired the
  // moment the last plan summary landed — before gsd-verifier had verified.
  //
  // ADR-3180 §7.4 (issue #3186, disk-strict): routed through the canonical
  // owner (`isPhaseComplete`) instead of hand-rolling `summaryCount >=
  // planCount && verificationPassed` locally — the owner calls
  // readVerificationStatus UNCONDITIONALLY, so `isComplete` here always
  // agrees with `roadmap analyze` / `init manager` / `phase complete` for
  // the same phase (ADR-3180 §7.4's headline: one predicate for the read
  // path and the write path).
  const phaseDir = path.join(cwd, phaseInfo!.directory);
  const completionResult = isPhaseComplete(phaseDir);
  const verificationResult = completionResult.value.verification;
  // #2648 precedent, applied at this write site (ADR-3180 §7.4 / #3186):
  // `isPhaseComplete` deliberately carries NO plan-count precondition — the
  // owner's `complete` is exactly `verification.status === 'passed'`, and
  // that must stay true (disk-strict: a zero-plan phase with a passing
  // `*-VERIFICATION.md` IS complete, #3168). But `readVerificationStatus`'s
  // staleness check only compares SUMMARY mtimes against the verification
  // file — it has no idea a NEW plan was added after the file was written,
  // so a still-fresh `passed` verification says nothing about a plan added
  // afterward. This command WRITES a checkbox and a completion date into
  // ROADMAP.md, a materially stronger claim than "verification passed" —
  // mirroring cmdPhaseComplete's own fail-closed plan-coverage gate
  // (phase.cts:~1995, #2648: "a coverage gate that passes when it cannot
  // read the plans is no gate at all"), composed explicitly here rather than
  // folded into the predicate: complete AND all plans executed.
  const coverageScan = scanPhasePlans(phaseDir);
  const unsummarizedPlans = findUnsummarizedPlans(coverageScan.planFiles, coverageScan.summaryFiles);
  const isComplete = completionResult.value.complete && unsummarizedPlans.length === 0;
  // #3057 B3: routing above is unchanged (an indeterminate staleness check
  // still routes as if nothing were stale) — this only makes the fact visible
  // to whatever reads this command's JSON output.
  const verificationStaleCheckIndeterminate = verificationResult.staleCheckIndeterminate === true;
  const status = isComplete ? 'Complete' : summaryCount > 0 ? 'In Progress' : 'Planned';
  const today = realClock.localToday();

  if (!fs.existsSync(roadmapPath)) {
    output({ updated: false, reason: 'ROADMAP.md not found', plan_count: planCount, summary_count: summaryCount }, raw, 'no roadmap');
    return;
  }

  // Wrap entire read-modify-write in lock to prevent concurrent corruption
  withPlanningLock(cwd, () => {
    let roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    const phasePattern = phaseMarkdownRegexSource(phaseNum);

    // Progress table row: update Plans Complete/Status/Completed columns BY
    // COLUMN NAME (handles 4- or 5-column RoadmapProgress tables regardless of
    // Milestone-column presence) via the markdown-table seam (ADR-2143 §7) —
    // supersedes the prior ordinal cells[]-index regex. Scoped to the current
    // milestone's `## Progress` table (editProgressTableSlice above).
    // #2245 Blocker 4: optional dot must be followed by whitespace-or-end, not
    // dot-OR-whitespace-OR-end as alternatives — the prior form let a bare "."
    // satisfy the whole lookahead, so completing phase "2" over-matched a
    // decimal sub-phase row like "2.5 Extra". Matches "2", "2.", "2 Alpha";
    // rejects "2.5 Extra" (replicates OLD's `\.?\s` intent on the now-TRIMMED
    // cell value, where end-of-string is the trimmed equivalent of "no more
    // characters after the optional dot").
    const phaseCellRe = new RegExp(`^${phasePattern}\\.?(?:\\s|$)`, 'i');
    const rowMatch = (row: Record<string, string>): boolean => phaseCellRe.test((row['Phase'] ?? '').trim());
    const dateShape = /^\d{4}-\d{2}-\d{2}$/;

    roadmapContent = editProgressTableSlice(roadmapContent, (scoped) => {
      let text = scoped;

      const plansResult = updateTableCell(text, rowMatch, 'Plans Complete', ` ${summaryCount}/${planCount} `);
      if (plansResult.ok) text = plansResult.value;

      const statusResult = updateTableCell(text, rowMatch, 'Status', ` ${status.padEnd(11)}`);
      if (statusResult.ok) text = statusResult.value;

      // Preserve only a valid ISO date (#1161: idempotent; self-heal garbage).
      // Ragged-tolerant (#2245 Blocker 2): probe the CURRENT Completed cell via
      // a no-op updateTableCell write (its own tolerant row scan) rather than
      // findTableWithColumns (which requires the WHOLE table to parse — a
      // ragged SIBLING row elsewhere used to silently no-op this row's date
      // stamp/clear too). The decision (write vs no-op) is folded into the
      // newValue callback so a single updateTableCell call both reads and
      // writes.
      const completedResult = updateTableCell(text, rowMatch, 'Completed', (current) => {
        if (isComplete) {
          return dateShape.test(current.trim()) ? current : ` ${today} `;
        }
        return '  ';
      });
      if (completedResult.ok) text = completedResult.value;

      return text;
    });

    // Update plan count in phase detail section.
    // Three recognised forms (all tolerated; canonical template uses the first):
    //   `**Plans**: N plans`  — bold word + outer colon (gsd-core/templates/roadmap.md)
    //   `**Plans:** N plans`  — bold "Plans:" (colon inside bold)
    //   `Plans: N plans`      — plain text header
    //
    // #2853 / #3584: the verb owns the count token ONLY — it must not destroy
    // hand-written prose a human placed on the line. Group $1 = phase header →
    // `Plans:` label + trailing whitespace (unchanged). Group $2 = the existing
    // count token to replace: matches `N/N plans complete`, `N/N plans executed`,
    // or the bare template `N plan(s)` form — singular is part of the tool's OWN
    // grammar (gsd-core/templates/roadmap.md:62 ships `**Plans**: 1 plan` as the
    // documented one-plan-phase shape), so the `s` is optional there (bug #3584
    // Finding B; pre-fix a bare `1 plan` fell into the drop-everything path and
    // was accidentally overwritten with the correct count — post-fix it must be
    // recognised as a token in its own right or it freezes stale forever). Group
    // $3 = whatever else is on the line (`[^\r\n]*`, so a CRLF `\r` is never part
    // of the match and rides along untouched in the unmatched remainder of the
    // string — never stranded, never duplicated).
    //
    // Three arms, in order:
    //   1. $2 present (a real count token) → rewrite the token, preserve $3
    //      verbatim (an annotation a human wrote after a real count; #2853).
    //   2. $2 absent AND $3, trimmed, is the fresh-template PLACEHOLDER shipped
    //      by gsd-core/templates/roadmap.md — either
    //      `[Number of plans, e.g., "3 plans" or "TBD"]` (line 37) or
    //      `[Number of plans]` (lines 51/75/88) → replace it with the computed
    //      count. Detected POSITIVELY on the distinctive `Number of plans`
    //      wording (anchored, case-insensitive), NEVER on "wholly bracketed" —
    //      a bracketed HUMAN annotation such as `[Deferred pending re-scope]`
    //      is structurally identical but must be arm-3 preserved (bug #3584
    //      Finding A).
    //   3. Anything else (freeform prose, `TBD` / `TBD — annotation`, a
    //      bracketed human note, the first line of a wrapped sentence, an
    //      empty value) → leave the whole matched line untouched by returning
    //      `_match` unchanged. An untouched first line cannot orphan its own
    //      continuation on the next line, since the pattern never spans past
    //      `\n` in the first place.
    const planCountPattern = new RegExp(
      `(#{2,4}\\s*Phase\\s+${phasePattern}${OPTIONAL_PHASE_TAG_SOURCE}(?=[:\\s])(?:(?!\\n#{1,4}\\s)[\\s\\S])*?(?:\\*\\*Plans\\*\\*:|\\*\\*Plans:\\*\\*|(?:^|\\n)Plans:)\\s*)(\\d+\\s*\\/\\s*\\d+\\s+plans(?:\\s+(?:complete|executed))?|\\d+\\s+plans?)?([^\\r\\n]*)`,
      'i'
    );
    const planCountText = isComplete
      ? `${summaryCount}/${planCount} plans complete`
      : `${summaryCount}/${planCount} plans executed`;
    // Positive detector for the fresh-template placeholder ONLY (bug #3584
    // Finding A). Anchored to the distinctive `Number of plans` wording that
    // gsd-core/templates/roadmap.md actually ships, not to "anything in
    // brackets" — a bracketed human annotation like `[Deferred pending
    // re-scope]` is structurally bracketed too but carries none of this
    // wording, so it correctly falls through to arm 3 untouched.
    const isTemplatePlaceholder = (value: string): boolean => {
      const trimmed = value.trim();
      return /^\[\s*Number of plans\b[\s\S]*\]$/i.test(trimmed);
    };
    roadmapContent = replaceInCurrentMilestone(roadmapContent, planCountPattern, (_match, label, existingCount, trailing) => {
      if (existingCount) {
        // Arm 1: real count token — rewrite it, preserve the trailing annotation.
        return `${label}${planCountText}${trailing}`;
      }
      if (isTemplatePlaceholder(trailing)) {
        // Arm 2: fresh-template placeholder — replace with the count.
        return `${label}${planCountText}`;
      }
      // Arm 3: freeform prose, TBD, a bracketed human annotation, a wrapped
      // sentence's first line, or an empty value — leave the line exactly as
      // it was.
      return _match;
    });

    // If complete: check checkbox
    if (isComplete) {
      const checkboxPattern = new RegExp(
        `(-\\s*\\[)[ ](\\]\\s*.*Phase\\s+${phasePattern}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][^\\n]*)`,
        'i'
      );
      roadmapContent = replaceInCurrentMilestone(roadmapContent, checkboxPattern, `$1x$2 (completed ${today})`);
    }

    // Mark completed plan checkboxes (e.g. "- [ ] 50-01-PLAN.md", "- [ ] 50-01:", or "- [ ] **50-01**")
    for (const summaryFile of phaseInfo!.summaries) {
      const planId = summaryFile.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
      if (!planId) continue;
      const planEscaped = escapeRegex(planId);
      const planCheckboxPattern = new RegExp(
        `(-\\s*\\[) (\\]\\s*(?:\\*\\*)?${planEscaped}(?:\\*\\*)?)`,
        'i'
      );
      roadmapContent = roadmapContent.replace(planCheckboxPattern, '$1x$2');
    }

    // Compute the active (post-</details>) region offset ONCE.  Both the
    // missing-plan DETECTION and the row INSERTION must use the same active
    // region string so that a plan row that exists only in an archived <details>
    // block is not counted as "already present" in the active milestone section.
    // (Finding 1 code-review: detection was previously running against the full
    //  roadmapContent, causing archived rows to suppress active-section inserts.)
    const lastDetailsClose = roadmapContent.lastIndexOf('</details>');
    const activeRegion = lastDetailsClose === -1
      ? roadmapContent
      : roadmapContent.slice(lastDetailsClose + '</details>'.length);

    // Compute which plan files are MISSING a checkbox row in the ACTIVE region.
    // This handles three cases:
    //   (a) Fresh template — no rows at all: all plans are missing.
    //   (b) Partial gap — some rows exist, others don't: only the absent ones.
    //   (c) All rows present — nothing to insert (idempotent).
    //
    // Detection is scoped to the active region so a plan that appears in an
    // archived <details> block is still correctly detected as missing from the
    // active milestone section.
    const missingPlans = phaseInfo!.plans.filter((planFile) => {
      const planEscaped = escapeRegex(planFile);
      return !new RegExp(`-\\s*\\[[x ]\\]\\s*(?:\\*\\*)?${planEscaped}`, 'i').test(activeRegion);
    });

    if (missingPlans.length > 0) {
      // Insert missing plan checklist rows (#1163).  We prefer to anchor to the
      // bare `Plans:` checklist header (canonical template form) and fall back to
      // the bold `**Plans**:`/`**Plans:**` summary line only when no bare header
      // is present.  Using two separate patterns avoids the lazy-quantifier trap
      // where a single alternation would stop at the first matching alternative
      // (the bold summary) before reaching the checklist header.
      //
      // Canonical template (gsd-core/templates/roadmap.md) uses BOTH lines:
      //   **Plans**: N plans   ← summary (colon outside bold)
      //   Plans:               ← checklist header (PREFERRED insertion anchor)
      // Rows must land after `Plans:`, not between the summary and the header.
      //
      // Pattern A: anchor to bare `Plans:` header (preferred).
      // Pattern B: fallback to bold summary when no bare header exists.
      const insertRowsPatternA = new RegExp(
        `(#{2,4}\\s*Phase\\s+${phasePattern}${OPTIONAL_PHASE_TAG_SOURCE}(?=[:\\s])(?:(?!\\n#{1,4}\\s)[\\s\\S])*?(?:^|\\n)(?:Plans:)[^\\n]*)`,
        'i'
      );
      const insertRowsPatternB = new RegExp(
        `(#{2,4}\\s*Phase\\s+${phasePattern}${OPTIONAL_PHASE_TAG_SOURCE}(?=[:\\s])(?:(?!\\n#{1,4}\\s)[\\s\\S])*?(?:\\*\\*Plans\\*\\*:|\\*\\*Plans:\\*\\*)[^\\n]*)`,
        'i'
      );

      const sortedMissing = [...missingPlans].sort();
      const newRows = sortedMissing.map(p => `- [ ] ${p}`).join('\n');
      const inserter = (match: string) => `${match}\n${newRows}`;

      // Scope insertion to the active (post-</details>) milestone region to
      // prevent duplicate phase headings in archived sections from receiving rows.
      // replaceInCurrentMilestone only accepts a string replacement, so we
      // perform the scoped replace manually here (same strategy as that helper).
      // Note: lastDetailsClose was computed above (shared with detection).
      const scopedReplace = (src: string, pat: RegExp) => src.replace(pat, inserter);
      let withRows: string;
      if (lastDetailsClose === -1) {
        // activeRegion === roadmapContent when there are no </details> blocks.
        const regionA = scopedReplace(activeRegion, insertRowsPatternA);
        withRows = regionA !== activeRegion ? regionA : scopedReplace(activeRegion, insertRowsPatternB);
      } else {
        const beforeDetails = roadmapContent.slice(0, lastDetailsClose + '</details>'.length);
        const regionA = scopedReplace(activeRegion, insertRowsPatternA);
        const afterWithRows = regionA !== activeRegion ? regionA : scopedReplace(activeRegion, insertRowsPatternB);
        withRows = beforeDetails + afterWithRows;
      }
      if (withRows !== roadmapContent) {
        roadmapContent = withRows;
        // Mark any newly-inserted rows that already have summaries as complete
        for (const summaryFile of phaseInfo!.summaries) {
          const planId = summaryFile.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
          if (!planId) continue;
          const planEscaped = escapeRegex(planId);
          const planCheckboxPattern = new RegExp(
            `(-\\s*\\[) (\\]\\s*(?:\\*\\*)?${planEscaped}(?:\\*\\*)?)`,
            'i'
          );
          roadmapContent = roadmapContent.replace(planCheckboxPattern, '$1x$2');
        }
      }
    }

    platformWriteSync(roadmapPath, roadmapContent);
  });
  output({
    updated: true,
    phase: phaseNum,
    plan_count: planCount,
    summary_count: summaryCount,
    status,
    complete: isComplete,
    verification_stale_check_indeterminate: verificationStaleCheckIndeterminate,
  }, raw, `${summaryCount}/${planCount} ${status}`);
}

// ─── cmdRoadmapAnnotateDependencies ───────────────────────────────────────────

/**
 * Annotate the ROADMAP.md plan list for a phase with wave dependency notes
 * and a cross-cutting constraints subsection derived from PLAN frontmatter.
 *
 * Wave dependency notes: "Wave 2 — blocked on Wave 1 completion" inserted as
 * bold headers before each wave group in the plan checklist.
 *
 * Cross-cutting constraints: must_haves.truths strings that appear in 2+ plans
 * are surfaced in a "Cross-cutting constraints" subsection below the plan list.
 *
 * The operation is idempotent: if wave headers already exist in the section
 * the function returns without modifying the file.
 */
function cmdRoadmapAnnotateDependencies(cwd: string, phaseNum: string | null | undefined, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for roadmap annotate-dependencies');
  }

  const roadmapPath = planningPaths(cwd).roadmap;
  if (!fs.existsSync(roadmapPath)) {
    output({ updated: false, reason: 'ROADMAP.md not found' }, raw, 'no roadmap');
    return;
  }

  const phaseInfo = findPhaseInternal(cwd, phaseNum);
  if (!phaseInfo || phaseInfo.plans.length === 0) {
    output({ updated: false, reason: 'no plans found for phase', phase: phaseNum }, raw, 'no plans');
    return;
  }

  // Read each PLAN.md and extract wave + must_haves.truths
  const planData: Array<{ planFile: string; planId: string; wave: number; truths: unknown[] }> = [];
  for (const planFile of phaseInfo.plans) {
    const planPath = path.join(path.resolve(cwd, phaseInfo.directory), planFile);
    try {
      const content = fs.readFileSync(planPath, 'utf-8');
      const fm = extractFrontmatter(content, planPath);
      const wave = parseInt(fm.wave as string, 10) || 1;
      const planId = planFile.replace(/-PLAN\.md$/i, '').replace(/PLAN\.md$/i, '');
      const truths = parseMustHavesBlock(content, 'truths') || [];
      planData.push({ planFile, planId, wave, truths });
    } catch { /* skip unreadable plans */ }
  }

  if (planData.length === 0) {
    output({ updated: false, reason: 'could not read plan frontmatter' }, raw, 'no frontmatter');
    return;
  }

  // Group plans by wave (sorted)
  const waveGroups = new Map<number, typeof planData>();
  for (const p of planData) {
    if (!waveGroups.has(p.wave)) waveGroups.set(p.wave, []);
    waveGroups.get(p.wave)!.push(p);
  }
  const waves = [...waveGroups.keys()].sort((a, b) => a - b);

  // Find cross-cutting truths: appear in 2+ plans (de-duplicated, case-insensitive).
  //
  // Issue #2770: must **coerce, not skip**. A previous guard
  // `if (typeof t !== 'string') continue` silently dropped numeric scalars
  // (YAML ints like `- 3`) and kv-shaped truths (`- title: X`), so the
  // cross-cutting analysis lost real constraints rather than crashing on
  // `t.trim()`. We coerce primitives via `String(t)` and extract a sensible
  // string field from object-shaped items produced by parseMustHavesBlock's
  // continuation-kv path (issue #2757 produces those shapes for nested keys).
  const truthCounts = new Map<string, TruthValue>();
  for (const { truths } of planData) {
    const seen = new Set<string>();
    for (const t of truths) {
      const text = coerceTruthToString(t);
      if (!text) continue;
      const trimmed = text.trim();
      const key = trimmed.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!truthCounts.has(key)) truthCounts.set(key, { count: 0, text: trimmed });
      truthCounts.get(key)!.count++;
    }
  }
  const crossCuttingTruths = [...truthCounts.values()]
    .filter(v => v.count >= 2)
    .map(v => v.text);

  // Patch ROADMAP.md
  let updated = false;
  withPlanningLock(cwd, () => {
    const content = fs.readFileSync(roadmapPath, 'utf-8');
    // #3413: preserve the file's own EOL style when the checklist block below
    // is rebuilt and spliced back in — splitLines() cleans each captured line
    // of any dangling \r, so rejoining with a bare '\n' would silently
    // downgrade a CRLF ROADMAP.md's rewritten block to LF only.
    const eol = detectEol(content);

    // Find the phase section.
    // #3537: padding-tolerant fragment so the caller's resolved padded id
    // matches un-padded ROADMAP headings.
    const phaseEscaped = phaseMarkdownRegexSource(phaseNum);
    const phaseHeaderPattern = new RegExp(`(#{2,4}\\s*Phase\\s+${phaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}:[^\\n]*)`, 'i');
    const phaseMatch = content.match(phaseHeaderPattern);
    if (!phaseMatch) return;

    const phaseStart = phaseMatch.index!;
    const restAfterHeader = content.slice(phaseStart);
    const nextPhaseOffset = restAfterHeader.slice(1).search(/\n#{2,4}\s+Phase\s+\d/i);
    const phaseEnd = nextPhaseOffset >= 0 ? phaseStart + 1 + nextPhaseOffset : content.length;
    const phaseSection = content.slice(phaseStart, phaseEnd);

    // Idempotency: skip if annotation markers already present
    if (
      /\*\*Wave\s+\d+/i.test(phaseSection) ||
      /\*\*Cross-cutting constraints:\*\*/i.test(phaseSection)
    ) return;

    // Find the Plans: section within the phase section.
    // #3691 Bug 1: `Plans:\s*\n` required no text after the colon, missing variants like
    // `Plans: 3 plans across 2 waves\n` or `**Plans:** 3 plans\n` (bold-wrapped).
    // `\*{0,2}Plans\*{0,2}:[^\n]*\n` accepts any text (or none) after the colon
    // and tolerates optional `**` markdown bold wrappers on either side.
    // The checklist group uses `+` (not `*`) so that a bold `**Plans:**` description
    // line with no immediately-following checklist items (e.g. a summary line above a
    // separate bare `Plans:` block) does not consume the match and prevent the actual
    // list from being found.
    // Review fix (F2): `(?:^|\n)` anchors the match to start-of-line so mid-line
    // occurrences like `***Plans:***` embedded in a sentence or `OpenPlans: foo`
    // do not trigger a false match. Groups 1 and 2 retain the same semantics.
    // #3415: empirically verified linear-time to 10.9MB / 320,000 lines of adversarial
    // checklist input (0.31ms@1000 lines -> 8.4ms@320,000 lines). The outer `+` group has
    // no trailing constraint after it in the pattern, so a successful greedy pass never
    // needs to explore alternate `\r?\n?` boundary partitions to satisfy something later —
    // it accepts the first complete parse and stops, which rules out the #2128-class
    // ambiguous-boundary blowup despite the nested-quantifier shape. Non-global match on
    // already phase-sliced content, not the whole file.
    // eslint-disable-next-line local/no-unbounded-quantifier -- outer `+` has no trailing constraint to force re-partitioning; measured linear to 10.9MB
    const plansBlockMatch = phaseSection.match(/(?:^|\r?\n)(\*{0,2}Plans\*{0,2}:[^\r\n]*\r?\n)((?:\s*-\s*\[[ x]\][^\r\n]*\r?\n?)+)/i);
    if (!plansBlockMatch) return;

    const plansHeader = plansBlockMatch[1];
    const existingList = plansBlockMatch[2];
    const listLines = splitLines(existingList).filter(l => /^\s*-\s*\[/.test(l));

    if (listLines.length === 0) return;

    // #314 perf: build a first-wins Map so per-line lookup is O(1) instead of O(plans).
    // First-wins mirrors .find() semantics: if the same planId appears more than once
    // in planData, the earlier entry wins — identical to what .find() returned before.
    const planById = new Map<string, typeof planData[number]>();
    for (const p of planData) {
      if (!planById.has(p.planId)) planById.set(p.planId, p);
    }

    // Build wave-annotated plan list
    const linesByWave = new Map<number, string[]>();
    for (const line of listLines) {
      // Match plan ID from line: "- [ ] 01-01-PLAN.md — ..." or "- [ ] 01-01: ..."
      // #3691 Bug 3: `[\w-]+?` excluded `.`, so decimal IDs like `02.3-01` were captured
      // as `02` only and never matched planData entries. `[\w.-]+?` preserves the
      // terminating alternation (`-PLAN.md|.md|:|\s—`) as the boundary anchor.
      const idMatch = line.match(/\[\s*[x ]\s*\]\s*([\w.-]+?)(?:-PLAN\.md|\.md|:|\s—)/i);
      const planId = idMatch ? idMatch[1] : null;
      // Review fix (F3): reject malformed IDs that start with `.`, contain consecutive
      // dots, or otherwise violate the `^\w[\w.-]*$` contract. A leading-dot ID
      // (e.g. `.invalid-PLAN.md`) would silently default to wave 1 — defensively
      // skip the line instead so corrupted ROADMAP entries don't corrupt wave layout.
      if (planId && !/^\w[\w.-]*$/.test(planId)) continue;
      const planEntry = planId ? (planById.get(planId) || null) : null;
      const wave = planEntry ? planEntry.wave : 1;
      if (!linesByWave.has(wave)) linesByWave.set(wave, []);
      linesByWave.get(wave)!.push(line);
    }

    const annotatedLines: string[] = [];
    const sortedWaves = [...linesByWave.keys()].sort((a, b) => a - b);
    for (let i = 0; i < sortedWaves.length; i++) {
      const w = sortedWaves[i];
      const waveLines = linesByWave.get(w)!;
      if (sortedWaves.length > 1) {
        const dep = i > 0 ? ` *(blocked on Wave ${sortedWaves[i - 1]} completion)*` : '';
        annotatedLines.push(`**Wave ${w}**${dep}`);
      }
      annotatedLines.push(...waveLines);
      if (i < sortedWaves.length - 1) annotatedLines.push('');
    }

    // Append cross-cutting constraints subsection if any found
    if (crossCuttingTruths.length > 0) {
      annotatedLines.push('');
      annotatedLines.push('**Cross-cutting constraints:**');
      for (const t of crossCuttingTruths) {
        annotatedLines.push(`- ${t}`);
      }
    }

    const newListBlock = joinLines(annotatedLines, eol) + eol;
    // #1103: when `(?:^|\r?\n)` consumed a leading terminator (mid-string
    // match), re-emit it verbatim so the line preceding the Plans: header is
    // not fused onto it. #3413: the widened `(?:^|\r?\n)` can now consume a
    // 2-char `\r\n` — re-emit whatever was actually captured (`''`, `'\n'`,
    // or `'\r\n'`), not a hardcoded `'\n'`, or a CRLF file loses its `\r`.
    const leadingMatch = /^\r?\n/.exec(plansBlockMatch[0]);
    const leadingNewline = leadingMatch ? leadingMatch[0] : '';
    // Review fix (#3413 security): use the FUNCTION-replacement form. The
    // string-replacement form expands String#replace's special patterns
    // (`$&`, `` $` ``, `$'`, `$$`, `$1`-`$9`) inside the replacement — and
    // newListBlock is built from author-controlled truths/plan-file content,
    // so a line containing a literal `` $` `` (etc.) would splice unrelated
    // surrounding phaseSection text into the result. A function replacer is
    // never pattern-interpreted.
    const newPhaseSection = phaseSection.replace(
      plansBlockMatch[0],
      () => leadingNewline + plansHeader + newListBlock
    );

    const nextContent = content.slice(0, phaseStart) + newPhaseSection + content.slice(phaseEnd);
    if (nextContent === content) return;
    platformWriteSync(roadmapPath, nextContent);
    updated = true;
  });

  output({
    updated,
    phase: phaseNum,
    waves: waves.length,
    cross_cutting_constraints: crossCuttingTruths.length,
  }, raw, updated ? `annotated ${waves.length} wave(s), ${crossCuttingTruths.length} constraint(s)` : 'skipped (already annotated or no plan list)');
}

export = {
  cmdRoadmapGetPhase,
  getRoadmapPhaseWithFallback,
  cmdRoadmapAnalyze,
  cmdRoadmapMilestoneScope,
  cmdRoadmapUpdatePlanProgress,
  cmdRoadmapAnnotateDependencies,
  buildPhaseHeadingRegex,
};

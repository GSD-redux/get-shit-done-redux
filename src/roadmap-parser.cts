/**
 * Roadmap Parser — ROADMAP.md parsing helpers
 *
 * ADR-857 rollout phase 2b: extracted from core.cts (issue #870).
 * Owns shipped-milestone slicing, current-milestone extraction,
 * milestone/phase lookups, and milestone-phase filtering.
 * Behaviour is preserved byte-for-behaviour from the prior location;
 * only the module boundary moved. The core.cjs re-export spine was retired
 * in epic #1267; callers import roadmap-parser helpers directly.
 *
 * Dependencies (leaf modules only — no loadConfig):
 *   - node:fs / node:path (stdlib)
 *   - ./phase-id.cjs        (phaseMarkdownRegexSource)
 *   - ./pattern.cjs         (escapeRegex — #3212 Phase 1 seam)
 *   - ./planning-workspace.cjs (planningDir)
 *   - ./shell-command-projection.cjs (platformReadSync)
 *   - ./markdown-sectionizer.cjs (tokenizeHeadings, stripTaggedBlocks, withSection, collectSection)
 *   - ./markdown-table.cjs (findTableWithColumns)
 */

import fs from 'node:fs';
import path from 'node:path';
import { escapeRegex } from './pattern.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdModule = require('./phase-id.cjs');
const {
  phaseMarkdownRegexSource,
  stripProjectCodePrefix,
  OPTIONAL_PHASE_TAG_SOURCE,
  // #2121: roadmapPhaseLookupSources now lives in phase-id.cjs (single owner of
  // the lookup-source ordering); imported here rather than defined locally.
  roadmapPhaseLookupSources,
  extractPhaseToken,
  isSentinelPhaseId,
  // #3641: the single-owner heading-intro and digit-token grammar sources —
  // see BRACKET_PHASE_ENTRY_HEADING_RE below.
  PHASE_HEADING_PREFIX_SRC,
  PHASE_NUMBER_TOKEN_SOURCE,
  phaseHeadingPrefixSrcFor,
  PHASE_HEADING_BASELINE,
  // #612: the disk-side milestone filter resolves bracket directories through
  // the owner's gated helpers rather than spelling the grammar a second time.
  phaseTokenMatches,
  // #2761 B1: the version-less bracket milestone boundary (computeSectionEnd /
  // preambleCutoff, below) is built from this single-owner source rather than a
  // re-typed bracket-id literal.
  BRACKET_ID_SRC,
  // #2761 M3: the PINNED bracket milestone intro, owning the pad2 spelling rule
  // as well as the grammar — consumed by the bracket-fallback selector below,
  // which re-typed the project-code class and restated the padding rule.
  bracketMilestoneIntroSrcFor,
  // #2761 B1 (round-2 fix): fold-before-identity for the SAME-MILESTONE
  // continuation check in isBracketMilestoneBoundary, below — the branch's own
  // convention (matches bracketQualifiedKey/isSentinelPhaseId).
  foldBracketId,
} = phaseIdModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir, resolvePhaseIdConvention } = planningWorkspace;
import { platformReadSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import unusableInputMod = require('./unusable-input.cjs');
const { UNUSABLE_REASON, warnUnusableInput } = unusableInputMod;
import { tokenizeHeadings, stripTaggedBlocks, withSection, stripFencedCode, collectSection } from './markdown-sectionizer.cjs';
import type { HeadingToken } from './markdown-sectionizer.cjs';
import { findTableWithColumns, matchTableSchema, isDelimiterRow, splitTableRow } from './markdown-table.cjs';
import type { MarkdownTable } from './markdown-table.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;

// ─── Roadmap milestone scoping ───────────────────────────────────────────────

/**
 * Markers that classify a MILESTONE HEADING (or `<summary>`) as closed/shipped
 * versus still active. Hoisted to module scope in #2562 — three call sites
 * (`extractCurrentMilestone`, `currentMilestoneRawRanges`,
 * `isMilestoneShippedInRoadmap`) previously kept byte-identical copies.
 */
const MILESTONE_CLOSED_MARKER_PATTERN = /\b(?:CLOSED|ARCHIVED|ABANDONED|SHIPPED|FAILED)\b|✅|🗄/i;
const MILESTONE_ACTIVE_MARKER_PATTERN = /\b(?:STARTED|ACTIVE|WIP)\b|in\s+progress|🚧|🔄/i;
function isClosedMilestoneHeading(headingText: string): boolean {
  return MILESTONE_CLOSED_MARKER_PATTERN.test(headingText) && !MILESTONE_ACTIVE_MARKER_PATTERN.test(headingText);
}

/**
 * Strip shipped milestone content wrapped in <details> blocks.
 */
function stripShippedMilestones(content: string): string {
  return stripTaggedBlocks(content, 'details');
}

/**
 * #3982: strip only <details> blocks whose <summary> marks a CLOSED milestone
 * (ARCHIVED/SHIPPED/✅/… without an active marker) — the narrow form of
 * stripShippedMilestones the current-milestone window needs. A blanket strip
 * would delete the ACTIVE milestone's own collapsed blocks (#1341) and
 * reproduce the phase_count: 0 class of #557/#2947.
 */
function stripClosedMilestoneDetails(content: string): string {
  return content.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, (block) => {
    const summaryMatch = block.match(/<summary[^>]*>([^<]*)<\/summary>/i);
    if (!summaryMatch) return block;
    return isClosedMilestoneHeading(summaryMatch[1]) ? '' : block;
  });
}

/**
 * #2562: is the milestone `version` marked SHIPPED by the ROADMAP itself?
 *
 * Scoped deliberately narrowly, because a false positive here reproduces the
 * exact symptom #2562 reports ("milestone complete" while phases are unstarted):
 *
 * - Only a MILESTONE HEADING (`^#{1,3}` that is not a `Phase N:` heading) or a
 *   `<summary>` line can carry the signal. A bullet or checklist item that
 *   merely NAMES the version (`- [x] 03-01: ship the v2.0 login endpoint ✅`)
 *   is prose about a phase, not a milestone verdict, and is ignored.
 * - The version token is boundary-matched with `(?![\w.-])` (mirrors the #730
 *   sub-milestone boundary at `extractCurrentMilestone`), so `v2.0` does not
 *   match inside `v2.0.1` — `\b` alone would, since `.` is a non-word char.
 * - Shipped/active classification reuses the same marker patterns the milestone
 *   sectioniser uses, so an in-progress marker on the line always wins.
 *
 * Both patterns are anchored and use only complementary character classes
 * (`[^\n]`, `[^<]`, `[^>]`) with no overlapping alternation, so matching stays
 * linear in the ROADMAP's length — an untrusted ROADMAP cannot drive backtracking.
 */
function isMilestoneShippedInRoadmap(content: string, version: string): boolean {
  const boundedVersion = `${escapeRegex(version)}(?![\\w.-])`;
  const candidates = [
    // A milestone heading: `## v2.0 Launch — ✅ SHIPPED`.
    new RegExp(`^#{1,3}[^\\S\\n]+(?!Phase\\s+\\S)[^\\n]*${boundedVersion}[^\\n]*$`, 'gmi'),
    // A collapsed shipped block's own summary: `<summary>✅ v2.0 … SHIPPED</summary>`.
    new RegExp(`<summary[^>]*>[^<]*${boundedVersion}[^<]*<\\/summary>`, 'gi'),
  ];
  for (const pattern of candidates) {
    for (const match of content.matchAll(pattern)) {
      if (isClosedMilestoneHeading(match[0])) return true;
    }
  }
  return false;
}

// #2761 B1: matches a bracket MILESTONE heading's intro (`[GSD.02]`) at the
// START of a heading's text, capturing the bracket id in group 1. Shared by
// isBracketMilestoneBoundary below — the ONE recognizer for "is this heading
// bracket-shaped", so computeSectionEnd and the preambleCutoff scan cannot
// independently drift on what counts as bracket-shaped (the drift that
// produced Blocker 3 in the round-2 review).
const BRACKET_HEADING_INTRO_RE = new RegExp(`^\\[(${BRACKET_ID_SRC})\\]`, 'i');

// #2761 B2 (round-2 fix, Blocker 2): ADR-612 Decision 1's own discriminator
// (docs/adr/612-bracket-phase-id-convention.md:56) — "a phase heading is a
// bracket followed by a digit-then-colon (`[GSD.02] 05:`); a milestone
// heading is a bracket followed by a name" — is CONTENT, not heading level.
// The prior `h.level <= 2` level cap broke on a level-3 bracket milestone
// heading (`### [GSD.02] Foundation`): its own level-3 phase children
// (`#### [GSD.02] 01: One`) never reached this check at all (excluded
// upstream by the `h.level > level` sibling-depth filter), but a level-3
// SIBLING milestone heading (`### [GSD.03] Later`) was ALSO excluded by the
// level cap, so the section ran to EOF instead of stopping there — trek-e's
// original #612 defect, reopened on any milestone heading below level 2.
//
// Built by interpolating phase-id.cts's single-owner
// phaseHeadingPrefixSrcFor (the SAME intro grammar getMilestonePhaseFilter's
// heading counter and extractRetiredPhaseNumbers already compile) plus the
// digit + optional-tag + colon tail every phase-heading counter in this file
// already spells (mirrors the `([\w][\w.-]*)(?:\s*\([^)\n]{0,200}\))?\s*:`
// shape at :nnn below) — not a re-typed grammar. Covers the dotted sub-phase
// heading form too (`[GSD.02] 05.03:`) via the same `[\w][\w.-]*` token,
// which admits an embedded `.`.
const BRACKET_PHASE_TAIL_RE = new RegExp(
  `^${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.ANY_BRACKET, 'bracket', false)}[\\w][\\w.-]*(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:`,
  'i',
);

/**
 * #2761 B1/B2 (round-2 fixes): is `headingText` (hashes STRIPPED — the
 * `tokenizeHeadings` `HeadingToken.text` shape, and the shape the
 * preambleCutoff scan below is made to match) a BRACKET MILESTONE boundary —
 * as opposed to (a) a bracket PHASE heading (at any level, including the
 * dotted sub-phase form), which must never terminate a milestone's own
 * section, or (b) a heading that names the SAME milestone already selected,
 * which is a CONTINUATION of the current milestone's own section (a
 * version-less split like `## [GSD.02] Foundation (Phase Details)`), not the
 * boundary to a DIFFERENT one?
 *
 * `level` is the CANDIDATE heading's own depth (`h.level`), capped at 3 — a
 * depth-SANITY ceiling, not a phase/milestone discriminator (that job is
 * BRACKET_PHASE_TAIL_RE, below). The cap mirrors the bracket-fallback
 * selector's own `#{1,3}` ceiling (this file's SELECTION branch above) and
 * `isMilestoneBounded`'s (`state.cts`) — a bracket-shaped heading deeper than
 * either of those will ever select as a CURRENT milestone is outside the
 * shape this function needs to discriminate at all.
 *
 * `selectedBracketId` is the SELECTED milestone's own bracket id, already
 * case-folded by the caller — `null` when scoping is not bracket-gated, the
 * selected heading is not itself bracket-shaped, or (preambleCutoff) the
 * same-milestone check does not apply at this call site (see its own comment
 * there) — in which case the same-milestone check below simply never fires.
 */
function isBracketMilestoneBoundary(headingText: string, level: number, selectedBracketId: string | null): boolean {
  if (level > 3) return false;
  const introMatch = BRACKET_HEADING_INTRO_RE.exec(headingText);
  if (!introMatch) return false;
  // #2761 B2: a bracket PHASE heading (`[GSD.02] 05:`, or the dotted
  // sub-phase form `[GSD.02] 05.03:`) is never a milestone boundary,
  // regardless of level.
  if (BRACKET_PHASE_TAIL_RE.test(headingText)) return false;
  // #2761 B1: fold-before-identity — this branch's own convention
  // (bracketQualifiedKey / isSentinelPhaseId apply the same rule).
  if (selectedBracketId && foldBracketId(introMatch[1]) === selectedBracketId) return false;
  return true;
}

/**
 * #2761 B1 (round-3 fix, Blocker 1 case D; hardened post-round-3; round-4
 * fix: requires a same-id PHASE child, not merely a same-id child): does
 * `headings[index]`'s SUBTREE — every heading strictly deeper than it, up to
 * (not including) the next heading at or above its own level — contain a
 * bracket-shaped, PHASE-TAIL-shaped heading with the SAME id as
 * `headings[index]`'s own?
 *
 * Used ONLY at the preambleCutoff scan below, to distinguish a genuine prior
 * or later sibling milestone — whose subtree contains a real phase heading
 * carrying its bracket id (`## [GSD.01] Setup` / `### [GSD.01] 01: …`)
 * — from an unrelated bracket-shaped PROSE heading sitting above the current
 * milestone's own content. Same-id-ness alone is insufficient: round-4 F1's
 * `[ADR.612] Heading convention` owns `[ADR.612] Examples`, but that child is
 * milestone-shaped, not a digit-colon phase. Reuse `BRACKET_PHASE_TAIL_RE`
 * for the phase-vs-milestone distinction instead of re-deriving it.
 *
 * Scan the whole subtree, not just the immediate child: a genuine milestone
 * may open with `### Notes` before its first matching-id phase. Stopping at
 * that first non-match leaked the prior milestone's qualified phase into the
 * current filter (3/2/67 instead of 2/1/50 in rv2-amend1).
 *
 * A subtree that closes with no same-id phase hit — including a childless
 * heading or one with only milestone-shaped same-id children — degrades to
 * not-a-boundary. That is deliberately over-inclusive: the unmatched text
 * remains in the preamble rather than silently discarding current content.
 *
 * `headings` is the same fence-aware token list the caller iterates; `index`
 * is the candidate's own position in it.
 */
function bracketHeadingHasMatchingChild(headings: readonly HeadingToken[], index: number): boolean {
  const candidate = headings[index];
  const ownMatch = BRACKET_HEADING_INTRO_RE.exec(candidate.text);
  if (!ownMatch) return false;
  const ownId = foldBracketId(ownMatch[1]);
  for (let i = index + 1; i < headings.length; i++) {
    const next = headings[i];
    if (next.level <= candidate.level) return false;
    const childMatch = BRACKET_HEADING_INTRO_RE.exec(next.text);
    // #2761 round-4: a same-id child is not enough — it must also be a PHASE
    // (BRACKET_PHASE_TAIL_RE), or an unrelated PROSE heading whose own
    // sub-heading merely happens to share its bracket id (F1: [ADR.612]
    // Heading convention / [ADR.612] Examples) satisfies this rule.
    if (childMatch && foldBracketId(childMatch[1]) === ownId && BRACKET_PHASE_TAIL_RE.test(next.text)) return true;
    // Not a same-id PHASE match — keep scanning DEEPER into the subtree
    // instead of giving up on this one heading; only a same-or-shallower
    // heading (above) actually closes the subtree.
  }
  return false;
}

/**
 * #3184 (epic #3180 Phase 2): the sole owner of "where does this milestone
 * heading's section end". Lifted from `currentMilestoneRawRanges`'s prior
 * inline copy — the only one of three byte-identical copies that carried a
 * "keep in sync" comment (evidence the risk was known, not controlled).
 * `extractCurrentMilestoneScoped`, `currentMilestoneRawRanges`, and
 * `getMilestonePhaseFilter`'s versionOverride branch all call this instead of
 * re-deriving it.
 */
function computeMilestoneSectionEnd(
  content: string,
  headingText: string,
  headingStart: number,
  additionalBoundary?: (heading: HeadingToken) => boolean,
  headingTokens?: readonly HeadingToken[],
): number {
  const level = (headingText.match(/^(#{1,3})\s/) ?? ['', '#'])[1].length;
  const afterHeading = headingStart + headingText.length;
  // Use tokenizeHeadings (fence-aware, offsets into original content) to find
  // the next stop boundary without re-implementing fence detection. T4 seam migration.
  const headings = headingTokens ?? tokenizeHeadings(content);
  for (const h of headings) {
    if (h.offset <= headingStart) continue;
    if (h.offset < afterHeading) continue;
    if (h.level > level) continue;
    // Mirrors old stopPattern: level-bounded, not a Phase heading, milestone marker
    if (/^Phase\s+\S/i.test(h.text)) continue;
    if (/v\d+\.\d+|✅|📋|🚧/i.test(h.text)) return h.offset;
    if (additionalBoundary?.(h)) return h.offset;
  }
  return content.length;
}

/**
 * #3216 (epic #3180 §7.2 Scope amendment): the version-AGNOSTIC sibling of
 * `locateMilestoneHeadings` — enumerates EVERY milestone heading in document
 * order, carrying its own version token, curated name, and shipped/closed
 * status. Consolidates the THIRD independent re-derivation the widened guard
 * found at `roadmap.cts:454` (`cmdRoadmapAnalyze`'s inline
 * `/##\s*(.*v(\d+(?:\.\d+)+)[^(\n]*)/gi`), which truncated names at a
 * parenthetical and had no phase-heading exclusion.
 *
 * `MILESTONE_HEADING_LINE_SOURCE` immediately below is the ONE textual
 * expression of the grammar `^#{1,3}\s+(?!Phase\s+\S)` in this file;
 * `locateMilestoneHeadings` builds its own pattern from the SAME constant
 * instead of re-typing the pattern text, so it is a version-FILTERED VIEW
 * over this function's grammar, never a second expression of it.
 *
 * Name extraction follows the pinned rule (ADR-3180 §7.2 amendment, "Name
 * extraction — pinned rule" via `extractMilestoneHeadingName`): strip
 * everything through the heading's OWN version token — not necessarily one a
 * caller is separately asking about — then ONE leading delimiter and
 * surrounding whitespace via the shared `stripLeadingDelimiter`. `(` is an
 * ordinary name character and is never a terminator (#3171). `getMilestoneInfo`
 * shares this same extraction so the parenthetical rule has exactly one
 * implementation.
 */
function listMilestoneHeadings(content: string): Array<{ heading: string; version: string; name: string | null; closed: boolean }> {
  const pattern = new RegExp(MILESTONE_HEADING_LINE_SOURCE, 'gmi');
  const out: Array<{ heading: string; version: string; name: string | null; closed: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    // #3216 review (Finding 4): the shared grammar's `[^\n]*` captures a
    // trailing `\r` on a CRLF-encoded ROADMAP (the inline `cmdRoadmapAnalyze`
    // regex this replaced called `.trim()`; this did not). `.trim()` here
    // matches that prior behavior. `version` (digits/dots/letters only, via
    // `extractMilestoneHeadingName`'s regex) and `name` (already run through
    // `stripLeadingDelimiter`, which ends in `.trim()`) cannot carry a
    // trailing `\r`, so only `heading` needs the fix.
    //
    // `heading` carries the heading text WITHOUT the leading `#{1,3}` run and
    // its following whitespace — matching the inline `cmdRoadmapAnalyze`
    // regex this function replaced (`/##\s*(.*v(\d+(?:\.\d+)+)[^(\n]*)/gi`,
    // whose capture group 1 begins AFTER `##\s*`). `locateMilestoneHeadings`
    // legitimately returns a DIFFERENT representation (`m[1]`, `#`s included)
    // — the two owners agree on WHICH milestone headings are selected, not on
    // raw heading text.
    const heading = m[0].replace(/^#{1,3}\s+/, '').trim();
    const extracted = extractMilestoneHeadingName(heading);
    if (extracted === null) continue; // no version token on this heading — not a milestone heading
    out.push({
      heading,
      version: extracted.version,
      name: extracted.name,
      closed: isClosedMilestoneHeading(heading),
    });
  }
  return out;
}

// #3216: the ONE textual expression of "level-bounded (h1-h3), phase-excluded
// heading line" in this file. `listMilestoneHeadings` and
// `locateMilestoneHeadings` both build their pattern from this constant
// rather than typing `^#{1,3}\s+(?!Phase\s+\S)` a second time — the exact
// duplication class ADR-3180 §7.2's widened guard exists to catch.
const MILESTONE_HEADING_LINE_SOURCE = '^#{1,3}\\s+(?!Phase\\s+\\S)[^\\n]*';

/**
 * #3184: the sole milestone-heading locator. Boundary-matched on the version
 * token with `\b`, NOT the stricter `(?![\w.-])`: this function keeps `\b`
 * because a milestone STATE legitimately selects its own sub-milestone
 * heading (`v8.0` matching `## v8.0-B …` — `0` is a word char, `-` is not, so
 * `\b` matches) — that is deliberate, load-bearing behavior (#730). The
 * stricter `(?![\w.-])` boundary answers a DIFFERENT question — "is exactly
 * this milestone shipped" (`isMilestoneShippedInRoadmap`) / "which Phase
 * Details section belongs to exactly this one's version token"
 * (`detailsVersionBoundary`) — and applying it here breaks #730 sub-milestone
 * selection. `extractCurrentMilestoneScoped`, `currentMilestoneRawRanges`,
 * and `getMilestonePhaseFilter`'s versionOverride branch all consume this
 * instead of re-deriving their own heading-location regex.
 *
 * #3216: rewritten as a version-FILTERED VIEW over `MILESTONE_HEADING_LINE_SOURCE`
 * — the SAME grammar `listMilestoneHeadings` enumerates — rather than a
 * second expression of it. The returned `RegExpExecArray[]` contract
 * (`m[0] === m[1]`, `m.index` at the heading's start) is byte-for-byte
 * unchanged, so its 4 existing callers are unaffected.
 */
function locateMilestoneHeadings(content: string, version: string): RegExpExecArray[] {
  const escapedVersion = escapeRegex(version);
  // ADR-3180 §7.1 locks this boundary as `\b`, not the stricter
  // `(?![\w.-])` — Amendment 2 tried the stricter boundary and reverted it.
  // `\b` alone is what preserves the #730 sub-milestone selection this
  // function owns: `v2.0` still matches inside `v2.0.1`, `v8.0` still
  // matches `## v8.0-B …`.
  const boundary = new RegExp(`${escapedVersion}\\b`, 'i');
  const pattern = new RegExp(`(${MILESTONE_HEADING_LINE_SOURCE})`, 'gmi');
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    if (boundary.test(m[1])) matches.push(m);
  }
  return matches;
}

/**
 * #3184: named predicate replacing the two `state.cts` re-derivations
 * (`buildStateFrontmatter`, `syncStateFrontmatter`) that each hand-rolled the
 * same "is this version bounded to a versioned ROADMAP heading" regex. A
 * straight consolidation of the two identical `state.cts` regexes onto the
 * shared `locateMilestoneHeadings` owner — no behavior change.
 */
function isMilestoneBoundedInRoadmap(content: string, version: string): boolean {
  return locateMilestoneHeadings(content, version).length > 0;
}

/**
 * #3184: does this ROADMAP carry ANY versioned milestone heading (`v1.2`-style
 * token on a level 1-3 non-Phase heading), independent of any particular
 * version. `extractCurrentMilestoneScoped` (free-form-vs-versioned row 3/4
 * classification) and `getMilestonePhaseFilter` (the deprecation warning +
 * the same row 3/4 classification for its versionOverride branch) each
 * hand-rolled this identically — the guard does not catch intra-owner-file
 * copies by construction, so this was found by review instead.
 */
function hasVersionedMilestones(content: string): boolean {
  return /^#{1,3}\s+.*v\d+\.\d+/mi.test(content);
}

// This file's milestone-heading vocabulary: a version token (`v1.2`-style),
// a ✅/🚧/📋 status marker, or the word "Milestone". Tested against a
// non-Phase heading's own text by `hasMilestoneSectioning` below — this
// module's sole owner of "is this heading a milestone heading".
const MILESTONE_HEADING_SIGNAL_PATTERN = /v\d+\.\d+|✅|📋|🚧|\bMilestone\b/i;

/**
 * #3184/#3204/#2828/#1761/#3185: could a WHOLE-DOCUMENT phase count conflate
 * two different milestones? That is the only question `buildStateFrontmatter`
 * (`state.cts`) asks its single caller of this predicate.
 *
 * Three prior models were tried, and all three tried to infer milestone-ness
 * from POSITION — where a heading sits relative to other headings — and all
 * three broke a real shape because position does not carry it:
 *
 * 1. "Is there ANY non-Phase level-2/3 heading" (pre-#3184). #3204: a FLAT
 *    roadmap carrying one ordinary structural heading (`## Progress`) was
 *    misclassified as milestone-sectioned, and `safeToUseRoadmapCount`
 *    clobbered a correct ROADMAP-declared count down to the on-disk directory
 *    count. Not-Phase-ness was never the right question.
 * 2. "Do >=2 non-Phase headings EACH own a nested (STRICTLY DEEPER) Phase
 *    heading" (#3184's rewrite). Two independent review findings broke this:
 *    (a) #1761 regression — real sibling milestones are commonly at the SAME
 *    level as their own Phase headings (`## v1.0` / `## Phase 1:` / `## v2.0`
 *    / `## Phase 3:`), so "strictly deeper" never matches for either sibling
 *    and the predicate answers false, letting the whole-document count
 *    conflate them exactly as #1761 did. (b) #3204 reintroduced — the
 *    bundled greenfield template itself (`gsd-core/templates/roadmap.md:149-171`:
 *    `## Phases` -> `### 🚧 v1.1 — …` -> `#### Phase 5: …`) nests a Phase
 *    heading arbitrarily deep under EVERY ancestor in the chain, so a
 *    generic wrapper heading ("Phases") with no milestone meaning of its own
 *    counted as its own candidate section and single-milestone documents
 *    were misclassified as sectioned again.
 * 3. "Immediate adjacency, at any level" (interim #3185 rewrite, never
 *    shipped past this file's own working tree). Fixed both #3184 defects
 *    above, but adjacency is STILL a positional signal, and #3185 reproduced
 *    a THIRD shape it cannot see: a flat roadmap where `## Overview` happens
 *    to sit immediately before `## Phase 1:` and, independently, `## Notes`
 *    sits immediately before `## Phase 4:` later in the same document. Two
 *    purely structural headings, zero milestone meaning, each "adjacent" to a
 *    Phase heading by coincidence of document layout — ≥2 owners, so the
 *    flat 6-phase roadmap was misclassified as sectioned and clobbered to the
 *    2 on-disk phase directories. Same root defect as #3204's `## Progress`,
 *    wearing a different heading shape.
 *
 * The model that actually holds for every shape above abandons position
 * entirely and asks about the heading's own text: is it a MILESTONE HEADING —
 * a non-Phase heading at level 1-3 carrying a milestone VOCABULARY signal
 * (a version token, a ✅/🚧/📋 status marker, or the word "Milestone")?
 * Sectioning is present iff there are >=2 such headings — one or zero cannot
 * conflate siblings by construction, no matter where they sit. This resolves
 * every prior failure:
 * - #3204 / this file's `## Progress`: no signal — 0 milestone headings.
 * - #3185 `## Overview` / `## Notes` interleaved with flat phases: neither
 *   carries a signal — 0 milestone headings, regardless of adjacency.
 * - #1761 same-level siblings (`## v1.0` / `## v2.0`): each carries a version
 *   token — 2 milestone headings, sectioned, no level or adjacency test
 *   needed.
 * - #1761 unmarked prose siblings (`## Milestone 1: …` / `## Milestone 2: …`):
 *   each carries the word "Milestone" — 2 milestone headings, sectioned.
 * - Bundled template wrapper (`## Phases` -> `### 🚧 v1.1` -> `#### Phase 5:`):
 *   `## Phases` carries no signal; `### 🚧 v1.1` carries a marker and a
 *   version token but is only ONE heading — 1 milestone heading, not
 *   sectioned.
 *
 * Deliberately NOT a denylist of heading names (fragile, unbounded) and NOT
 * collapsed into `hasVersionedMilestones` (a non-versioned-but-marked or
 * "Milestone"-named section still conflates siblings — see that function's
 * own doc comment, which answers a narrower question: ANY version token
 * anywhere, not "are there >=2 independently-signalled milestone headings").
 * Routed through `tokenizeHeadings` (fence- and CRLF-aware, single owner of
 * ATX heading tokenisation) rather than a second regex pass, so a heading
 * inside a fenced code block is never tokenised in the first place and
 * cannot flip this result. The Phase-heading test (`/^Phase\s+\S/i`) is the
 * SAME literal reused by `computeMilestoneSectionEnd` / `locateMilestoneHeadings`
 * above, not a fresh copy. `MILESTONE_HEADING_SIGNAL_PATTERN`'s version-token
 * and marker alternatives mirror the literal fragments already used by
 * `hasVersionedMilestones` (`v\d+\.\d+`) and `computeMilestoneSectionEnd`
 * (`✅|📋|🚧`) rather than inventing a fourth independent copy of the same
 * vocabulary; the "Milestone" word is the one signal none of those three
 * needed and this predicate does.
 *
 * Honest limit: this is a NARROWER signal than any of the three position-based
 * attempts — a heading is only a candidate if its OWN TEXT carries a version
 * token, a status marker, or the word "Milestone". Two milestone sections that
 * carry NONE of the three (e.g. `## First Chapter` / `## Second Chapter`, each
 * with their own Phase headings, no version, no marker, no "Milestone" word)
 * are not detected as sectioned, and the whole-document count is trusted even
 * though it may still conflate them. No fixture in this repo's bundled
 * template or the #3204/#1761/#3185 reports exercises that shape; it is
 * recorded here rather than hidden.
 */
function countMilestoneHeadings(content: string): number {
  const isPhaseHeading = (text: string): boolean => /^Phase\s+\S/i.test(text);
  let milestoneHeadingCount = 0;
  for (const heading of tokenizeHeadings(content)) {
    if (heading.level < 1 || heading.level > 3) continue;
    if (isPhaseHeading(heading.text)) continue;
    if (!MILESTONE_HEADING_SIGNAL_PATTERN.test(heading.text)) continue;
    milestoneHeadingCount++;
  }
  return milestoneHeadingCount;
}

function hasMilestoneSectioning(content: string): boolean {
  // The >=2 short-circuit the inline walk used to have is gone — a ROADMAP's
  // heading count is small and tokenizeHeadings materializes the full token
  // array regardless, so the shared walk pays nothing for it.
  return countMilestoneHeadings(content) >= 2;
}

/**
 * #3642: the >=1 sibling of `hasMilestoneSectioning`. The >=2 predicate
 * answers SIBLING-conflation ("could two sections' phases mix") and is
 * unchanged; but `buildStateFrontmatter`'s unbounded branch asks a question
 * >=2 under-answers: "is there ANY milestone section whose phases a
 * whole-document count would attribute to a milestone that matches no
 * heading?" With exactly ONE section and an asserted milestone absent from
 * the ROADMAP, >=2 said "flat" and the single section's phases leaked into
 * the asserted milestone's total_phases (silent clobber of the stored
 * value). Same walk, same vocabulary, threshold 1 — exported for that
 * consumer only; every other consumer keeps the >=2 semantics.
 */
function hasAnyMilestoneSection(content: string): boolean {
  return countMilestoneHeadings(content) >= 1;
}

/**
 * #3184: the sole "which heading is this milestone's" rule — locate the version's
 * headings, prefer the first that is not marked CLOSED/SHIPPED, else fall back to the
 * first match. Returns null when the version has no heading at all.
 *
 * Extracted because three sites had written this same two-line selection
 * independently (sliceMilestoneWindow, extractCurrentMilestoneScoped,
 * currentMilestoneRawRanges) — the composition-level divergence ADR-3180
 * Decision 4(c) covers: calling the owner's primitives and re-assembling the
 * result locally is indistinguishable from re-deriving it.
 */
function selectMilestoneHeading(content: string, version: string): RegExpExecArray | null {
  const matches = locateMilestoneHeadings(content, version);
  if (matches.length === 0) return null;
  return matches.find((m) => !isClosedMilestoneHeading(m[1])) ?? matches[0];
}

/**
 * #3184: the sole "give me this version's window" composition. Delegates
 * heading selection to `selectMilestoneHeading` (the sole selection owner)
 * and then to `computeMilestoneSectionEnd` for the slice. Returns null when
 * the version has no heading at all, so callers can distinguish "no such
 * milestone section" from "empty section".
 *
 * Review finding (post-merge of this phase's first pass): `getMilestonePhaseFilter`'s
 * versionOverride branch and `cmdMilestoneComplete`'s unstarted-phase guard
 * had each independently composed `locateMilestoneHeadings` +
 * `computeMilestoneSectionEnd` into a window — the SAME derivation written
 * twice, and they disagreed (one skipped CLOSED headings, the other did not)
 * — exactly the composition-level divergence ADR-3180 Decision 4(c) warns
 * about: calling the owner and then re-assembling the result locally is
 * indistinguishable from re-deriving it. Both sites now call this instead.
 */
function sliceMilestoneWindow(content: string, version: string): string | null {
  const selected = selectMilestoneHeading(content, version);
  if (selected === null) return null;
  return content.slice(selected.index, computeMilestoneSectionEnd(content, selected[0], selected.index));
}

/**
 * #3184: counts RAW phase references — a `#{2,4} Phase <id>:` heading
 * (fence-aware via `tokenizeHeadings`) or a `#2199` bullet entry — BEFORE any
 * sentinel filter. Used for BOTH sides of `classifyMilestoneWindow`'s row-8
 * comparison (does the window contain phase entries; does the document).
 * Deliberately does NOT filter `999.x`/Phase 0 sentinels: the question here
 * is "did the window reach the phase region", not "how many real phases
 * exist" — a window containing only sentinel phases still reached the
 * region and must read COMPLETE, not TRUNCATED.
 */
// #3641: the bracket-convention phase-ENTRY heading shape — ADR-612 Decision
// 1's own discriminator: a phase heading is a bracket followed by a
// DIGIT-then-colon (`### [GSD.04] 01: Name`); a bracket followed by a NAME
// is a milestone heading and must never count. Every fragment interpolates a
// single-owner export from phase-id.cts — the heading intro
// (PHASE_HEADING_PREFIX_SRC: a `[...]` bracket optionally followed by a
// `Phase ` label, or a bare `Phase ` label), the digit-bearing token
// (PHASE_NUMBER_TOKEN_SOURCE, which also covers the dotted sub-phase form
// `[GSD.02] 05.03:`), and the optional pre-colon tag
// (OPTIONAL_PHASE_TAG_SOURCE) — never a re-typed grammar. Tested IN
// ADDITION to the legacy pattern below, so bracket mode is a strict
// superset: mid-migration legacy-labeled headings (`Phase AUTH-101:`-style
// custom ids included) keep their existing recognition. Review finding: an
// earlier single-alternative form with a `[\\w]` token admitted
// `[bracket] Word:` shapes — a colon-bearing MILESTONE heading inside the
// window read as an entry (defeating V005 outright for that spelling) and a
// decoy `### [GSD.04] Notes:` outside the window manufactured a false V005
// while suppressing the correct V004. The digit anchor forecloses both.
const BRACKET_PHASE_ENTRY_HEADING_RE = new RegExp(
  `^${PHASE_HEADING_PREFIX_SRC}${PHASE_NUMBER_TOKEN_SOURCE}${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`,
  'i',
);

function hasPhaseEntries(markdown: string, phaseIdConvention?: string | null): boolean {
  // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
  // #3641: the widened grammar engages ONLY when the resolved convention is
  // 'bracket' — a project that has not opted in runs the legacy pattern
  // alone, byte-identically.
  const phaseHeadingPattern = /^(?:\[[^\]]{1,200}\]\s*)?Phase\s+([\w][\w.-]*)(?:\s*\([^)\n]{0,200}\))?\s*:/i;
  const bracketMode = phaseIdConvention === 'bracket';
  for (const h of tokenizeHeadings(markdown)) {
    if (h.level < 2 || h.level > 4) continue;
    if (phaseHeadingPattern.test(h.text)) return true;
    if (bracketMode && BRACKET_PHASE_ENTRY_HEADING_RE.test(h.text)) return true;
  }
  // #3184 review finding: the bullet fallback must be fence-aware too, or a
  // FENCED markdown EXAMPLE of the `- [ ] **Phase N — Name**` syntax (e.g. a
  // doc showing the convention) counts as a real phase entry. Strip fences
  // through the canonical seam before testing, matching tokenizeHeadings'
  // fence-awareness above.
  if (BULLET_PHASE_LINE_PATTERN.test(stripFencedCode(markdown).text)) return true;
  // #3577: a markdown-table phase listing also declares phases.
  return collectTablePhaseRows(markdown).length > 0;
}

// ─── #3577: markdown-table phase listings ─────────────────────────────────────
// #3577: a GFM table declares phases when its header's FIRST cell is the literal
// `Phase` (optionally `Phase #` / `Phase No.` / `Phase number`) and the header does
// NOT match a known non-listing schema — the canonical RoadmapProgress table
// (`| Phase | Plans Complete | Status | Completed |`) leads with `Phase` too, and
// its rows are progress markers, not declarations. Data rows carry the phase id in
// their first cell (digit-bearing canonical shape — `Phase`-word header cells and
// `---` delimiter rows are digit-free and excluded by construction). Fence-aware
// via stripFencedCode, matching the #3184 lesson: a fenced EXAMPLE of the table
// form is not a declared phase.
const PHASE_LISTING_HEADER_RE = /^\|?\s*phase(?:\s*(?:#|no\.?|number))?\s*\|/i;
const TABLE_PHASE_ID_RE = /^[A-Za-z]?\d[\w.-]*$/;

function collectTablePhaseRows(window: string): Array<{ id: string; name: string | null; row: string }> {
  const unfenced = stripFencedCode(window).text;
  const lines = unfenced.split(/\r?\n/);
  const rows: Array<{ id: string; name: string | null; row: string }> = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!PHASE_LISTING_HEADER_RE.test(lines[i])) continue;
    const headerCells = splitTableRow(lines[i]);
    if (matchTableSchema(headerCells) !== null) continue; // canonical non-listing schema
    if (!isDelimiterRow(splitTableRow(lines[i + 1]))) continue;
    for (let j = i + 2; j < lines.length; j++) {
      // GFM semantics: the table ENDS at the first line that is not a table
      // row. Review finding: breaking only on blank lines let subsequent prose
      // (e.g. a bare `2026-01-01` date line) be harvested as a phase id.
      if (!/^\s*\|/.test(lines[j])) break;
      const cells = splitTableRow(lines[j]);
      if (cells.length === 0 || cells.every((c) => c === '')) break; // defensive: blank row
      const first = cells[0] ?? '';
      if (!TABLE_PHASE_ID_RE.test(first)) continue;
      if (!/^999\b/.test(first)) {
        rows.push({ id: first, name: cells[1] && cells[1] !== '' ? cells[1] : null, row: lines[j] });
      }
    }
  }
  return rows;
}

/**
 * #3262: the sole owner of "which phase ids does THIS milestone window
 * declare". Extracted verbatim from `getMilestonePhaseFilter`'s former inline
 * heading scan + bullet scan so the new `roadmap milestone-scope` probe (the
 * write-time milestone-scope guard's capture/compare signal) reads the SAME
 * derivation the phase filter builds its membership set from — never a second
 * copy of either scan.
 *
 * Fence-aware on both scans (tokenizeHeadings + stripFencedCode), matching
 * `hasPhaseEntries` above: a fenced markdown EXAMPLE of either syntax is not
 * a declared phase.
 *
 * #3185: deliberately NOT isSentinelPhaseId here. That predicate treats a
 * leading 0 as sentinel milestone 0, which would swallow the #2554 decimal
 * phase ids ("00.1" is a real phase, not milestone 0). This scan asks a
 * narrower question — "which phase ids does this window declare" — where only
 * the 999 icebox range is excluded.
 */
function scanMilestonePhaseIdSets(
  window: string,
  convention: string | null | undefined,
): { ids: Set<string>; qualifiedIds: Set<string> } {
  const ids = new Set<string>();
  const qualifiedIds = new Set<string>();
  // Use tokenizeHeadings (fence-aware) instead of stripFencedLines + regex.
  // T4 seam migration: phase headings inside fences are excluded automatically.
  // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
  // #612: select the heading grammar from the resolved convention and retain
  // the bracket id so the disk-side filter can distinguish equal phase tokens
  // belonging to different milestones.
  const capturing = convention === 'bracket';
  const bracketGroups = capturing ? 1 : 0;
  const phaseHeadingPattern = new RegExp(
    `^${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.ANY_BRACKET, convention, capturing)}([\\w][\\w.-]*)(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:`,
    'i',
  );
  for (const h of tokenizeHeadings(window)) {
    if (h.level < 2 || h.level > 4) continue;
    const pm = phaseHeadingPattern.exec(h.text);
    if (!pm) continue;
    const bracketId = bracketGroups ? pm[1] : undefined;
    const token = pm[1 + bracketGroups];
    if (bracketId && isSentinelPhaseId(`${bracketId}-${token}`, 'bracket')) continue;
    // This scan's legacy contract excludes only the 999 icebox range. Keep the
    // narrower rule so real decimal phase 00.1 is not swallowed as milestone 0.
    if (/^999\b/.test(token)) continue;
    ids.add(token);
    if (bracketId && !token.includes('-')) qualifiedIds.add(`${bracketId}-${token}`);
  }
  // #2199: also count bullet/checkbox phase entries (`- [ ] **Phase N — name**`)
  // so a bullet-house-style ROADMAP populates the milestone phase set instead of
  // collapsing to a zero-count pass-all filter.
  let bm: RegExpExecArray | null;
  const scanner = new RegExp(BULLET_PHASE_LINE_PATTERN.source, 'gim');
  const unfenced = stripFencedCode(window).text;
  while ((bm = scanner.exec(unfenced)) !== null) {
    if (!/^999\b/.test(bm[1])) ids.add(bm[1]);
  }
  // #3577: table-declared ids join the same membership set — the milestone
  // filter must not collapse a table-house-style window to zero-count.
  for (const tr of collectTablePhaseRows(window)) ids.add(tr.id);
  return { ids, qualifiedIds };
}

/**
 * Public #3262 owner contract: the declared-id Set remains directly iterable.
 * #612's qualified bracket ids are an internal companion used only by the
 * milestone directory filter, so extending that internal read must not break
 * existing consumers of this exported Set (including #3577's table scan).
 */
function scanMilestonePhaseIds(
  window: string,
  convention?: string | null,
): Set<string> {
  return scanMilestonePhaseIdSets(window, convention).ids;
}

/**
 * #3262 (write-time milestone-scope guard): does this free-text value contain
 * a heading line that would TERMINATE the current milestone window if spliced
 * into ROADMAP.md? Returns the offending heading texts (empty array = safe).
 *
 * Mirrors the parser's own terminator vocabulary (`computeMilestoneSectionEnd`):
 * a heading terminates the window when it is level 1-3, is NOT a Phase heading
 * (`/^Phase\s+\S/i` — the phase's OWN numbered heading is existing, correct,
 * load-bearing behavior and is never a violation), and carries a milestone
 * signal. The signal test is the union of `MILESTONE_HEADING_SIGNAL_PATTERN`
 * (this module's "is this heading a milestone heading" vocabulary) and `🔄`
 * (which terminates in `extractCurrentMilestoneScoped`'s own preamble pattern)
 * — deliberately the CONSERVATIVE union: a field value whose line is a level
 * 1-3 heading naming a version, a status marker, or the word "Milestone" is
 * exactly the shape that silently narrows the window, so the guard rejects on
 * any of them rather than re-deriving which specific marker a given roadmap's
 * terminator would fire on.
 *
 * Two deliberate conservatisms, both one-directional (reject more, never less):
 *  - `computeMilestoneSectionEnd` also bounds by the milestone heading's own
 *    level (a `###` marker only terminates a `###`-level milestone heading);
 *    this predicate flags every level 1-3 marker regardless, because which
 *    level the active milestone heading uses is a property of the document at
 *    write time, not of the text being validated.
 *  - level 4+ headings never terminate any window and are not flagged.
 *
 * Fence-aware via `tokenizeHeadings`: a FENCED example of a milestone heading
 * inside a field value does not terminate the real window, so it must not be
 * a violation either — the parser and this guard must agree on fences.
 *
 * #612: `convention` is the resolved `phase_id_convention`. This predicate is
 * defined as a MIRROR of the parser's terminator vocabulary, and on this
 * branch that vocabulary is convention-SELECTED: `computeBracketSectionEnd`
 * adds `isBracketMilestoneBoundary` as a terminator arm, so the ADR-canonical
 * `## [GSD.09] Hidden` — no version token, no status emoji, not the word
 * "Milestone" — terminates the window on an opted-in bracket repo while
 * matching NONE of the signals above. Left unmirrored, the guard accepts
 * exactly the description that narrows the window on the one convention this
 * branch teaches the parser to read, which is the failure the guard exists to
 * prevent. A non-bracket (or unresolvable) value takes the pre-existing path
 * byte-identically.
 *
 * REQUIRED, not optional — the same tripwire `scanMilestonePhaseIds` carries,
 * and for the sharper reason: a blind call here fails OPEN (the guard quietly
 * ACCEPTS a window-narrowing description) rather than merely miscounting, so a
 * future call site must fail to COMPILE. The census today is one caller,
 * `assertDescriptionPreservesMilestoneScope`, which pays nothing for it.
 */
function findMilestoneScopeHeadingLines(text: string, convention: string | null | undefined): string[] {
  const out: string[] = [];
  for (const h of tokenizeHeadings(text)) {
    if (h.level > 3) continue;
    if (/^Phase\s+\S/i.test(h.text)) continue;
    if (MILESTONE_HEADING_SIGNAL_PATTERN.test(h.text) || /🔄/.test(h.text)) {
      out.push(h.text.trim());
      continue;
    }
    // #612: the bracket arm, routed through the SAME single-owner
    // phase-vs-milestone discriminator `computeBracketSectionEnd` consults —
    // never a second bracket-heading grammar here.
    //
    // `selectedBracketId` is deliberately `null`, so the same-milestone
    // CONTINUATION exemption never fires and a value naming the ACTIVE
    // milestone (`## [GSD.02] Foundation (Phase Details)`) is flagged even
    // though the real parser would treat it as a continuation. That is the
    // third instance of this function's stated conservatism and rests on the
    // same argument as the other two: WHICH milestone is active is a property
    // of the document at write time, not of the text being validated, and
    // over-rejecting is one-directional (reject more, never less).
    if (convention === 'bracket' && isBracketMilestoneBoundary(h.text, h.level, null)) {
      out.push(h.text.trim());
    }
  }
  return out;
}

/**
 * #3184: pure decision table (no I/O, no regex construction from caller
 * data) implementing the design's Behavior table rows 1-8 (the remaining
 * rows 9-17 reduce to one of these six through how the caller constructs its
 * input, not additional branches here). Kernighan's Law fired during design:
 * `getMilestonePhaseFilter` is already cyclomatic 36, so this discriminator
 * is extracted as its own named, separately-testable function rather than
 * inlined.
 */
function classifyMilestoneWindow(input: {
  readable: boolean;
  versionResolved: boolean;
  hasVersionedMilestones: boolean;
  headingFound: boolean;
  windowHasPhaseEntries: boolean;
  documentHasPhaseEntries: boolean;
}): Scope {
  const { readable, versionResolved, hasVersionedMilestones, headingFound, windowHasPhaseEntries, documentHasPhaseEntries } = input;
  return (
    !readable ? SCOPE.UNREADABLE :                                                       // row 2
    !versionResolved && !hasVersionedMilestones ? SCOPE.COMPLETE :                       // row 3: free-form legacy roadmap
    !versionResolved && hasVersionedMilestones ? SCOPE.UNSCOPED :                        // row 4
    versionResolved && !headingFound ? SCOPE.UNSCOPED :                                  // row 5
    headingFound && !windowHasPhaseEntries && documentHasPhaseEntries ? SCOPE.TRUNCATED : // row 8
    SCOPE.COMPLETE                                                                        // rows 6, 7
  );
}

/**
 * Extract the current milestone section from ROADMAP.md by positive lookup,
 * carrying a `scope` discriminator (ADR-3180 Decision 2) alongside the value.
 *
 * @param content - ROADMAP.md content.
 * @param cwd - Project working directory, used to read the companion STATE.md
 *   for the current `milestone:` version.
 * @param ws - #2562: workstream name, so the companion STATE.md is read from
 *   `.planning/workstreams/<ws>/` instead of the project root. Omitted (the
 *   default) preserves the prior `planningDir(cwd)` resolution exactly,
 *   including its `GSD_WORKSTREAM` env fallback.
 *
 * #3184: `extractCurrentMilestone`'s CRITICAL blast radius (200+ affected
 * symbols, 20 direct callers) means its signature and return type do not
 * change. This is the real owner; `extractCurrentMilestone` becomes a
 * one-line wrapper returning `.value` so every existing caller is untouched.
 *
 * @param phaseIdConvention - #3641: the RESOLVED `phase_id_convention`
 *   config value, threaded to `hasPhaseEntries` so the scope axis's row-8
 *   comparison recognizes bracket-convention phase entries
 *   (`### [GSD.04] 01: Name`). Optional: absent, or any value other than
 *   `'bracket'`, compiles the legacy entry grammar byte-identically — the
 *   widening engages only for a project that resolved the convention
 *   explicitly. `extractCurrentMilestone`'s wrapper deliberately does NOT
 *   expose it (its 20 callers are not the scope-axis consumers; V005's
 *   router site and `getMilestonePhaseFilter` resolve and thread it).
 */
function extractCurrentMilestoneScoped(content: string, cwd?: string, ws?: string | null, phaseIdConvention?: string | null): { value: string; scope: Scope } {
  if (!cwd) {
    // Row 1: a deliberate unscoped read (no cwd supplied) is a real answer —
    // the caller asked for no scoping, so whole-document is COMPLETE.
    return { value: stripShippedMilestones(content), scope: SCOPE.COMPLETE };
  }

  let version: string | null = null;
  try {
    const statePath = path.join(planningDir(cwd, ws), 'STATE.md');
    const stateRaw = platformReadSync(statePath);
    if (stateRaw !== null) {
      const milestoneMatch = stateRaw.match(/^milestone:\s*(.+)/m);
      if (milestoneMatch) {
        version = milestoneMatch[1].trim();
      }
    }
  } catch { /* ignore */ }

  if (!version) {
    const inProgressMatch = content.match(/(?:🚧|🔄)\s*\*\*v(\d+\.\d+)\s/);
    if (inProgressMatch) {
      version = 'v' + inProgressMatch[1];
    }
  }

  const versionResolved = version !== null;
  // #3184: routed through the shared owner (was an inline copy — see the
  // twin copy in `getMilestonePhaseFilter`, the intra-owner-file duplicate
  // review caught since the drift guard exempts this file by construction).
  const versionedMilestonesPresent = hasVersionedMilestones(content);

  if (!version) {
    const value = stripShippedMilestones(content);
    return {
      value,
      scope: classifyMilestoneWindow({
        readable: true,
        versionResolved,
        hasVersionedMilestones: versionedMilestonesPresent,
        headingFound: false,
        windowHasPhaseEntries: hasPhaseEntries(value, phaseIdConvention),
        documentHasPhaseEntries: hasPhaseEntries(value, phaseIdConvention),
      }),
    };
  }

  const documentHasPhaseEntries = hasPhaseEntries(stripShippedMilestones(content), phaseIdConvention);
  const summaryPattern = new RegExp(
    `<summary[^>]*>([^<]*${escapeRegex(version)}[^<]*)<\\/summary>`,
    'i'
  );
  // #3184 keeps the version-heading locator single-owned. #612 adds a gated
  // bracket candidate source only when that owner finds no version-bearing
  // heading; it never replaces or re-derives the legacy lookup.
  let headingMatches = locateMilestoneHeadings(content, version);

  // #2761 B3: resolve the boundary convention independently of whether the
  // version-heading owner already selected a match. Preserve an explicitly
  // threaded convention; otherwise resolve from the same workstream whose
  // STATE/ROADMAP this call reads (#2761 B1).
  let bracketScopeConvention: string | null = phaseIdConvention ?? null;
  if (phaseIdConvention === undefined) {
    try {
      bracketScopeConvention = resolvePhaseIdConvention(cwd, ws);
    } catch { /* unresolvable convention → preserve the legacy fallback */ }
  }
  if (headingMatches.length === 0 && bracketScopeConvention === 'bracket') {
    const vMatch = version.match(/^v(\d+)/i);
    const milestoneInt = vMatch ? parseInt(vMatch[1], 10) : NaN;
    if (Number.isSafeInteger(milestoneInt)) {
      // #2761 M3: the phase-id owner supplies both the bracket intro grammar
      // and canonical pad2 spelling; `[CODE.2]` therefore cannot bound a
      // section whose phase headings the bracket grammar rejects.
      // #612 round-5: HeadingToken.offset is the line start, so require the
      // `#` there to preserve the old line-start anchor's indentation parity.
      // For every survivor, rebuilding [fullLine, fullLine] plus `.index`
      // retains the match shape and first-match order expected downstream.
      const bracketMilestoneHeadingRe = new RegExp(`^${bracketMilestoneIntroSrcFor(milestoneInt)}`, 'i');
      headingMatches = tokenizeHeadings(content)
        .filter((h) => h.level <= 3 && content[h.offset] === '#' && bracketMilestoneHeadingRe.test(h.text))
        .map((h) => {
          const lineEnd = content.indexOf('\n', h.offset);
          const fullLine = content.slice(h.offset, lineEnd === -1 ? content.length : lineEnd);
          return Object.assign([fullLine, fullLine], { index: h.offset }) as RegExpExecArray;
        });
    }
  }

  if (headingMatches.length === 0) {
    const summaryMatch = content.match(summaryPattern);
    if (summaryMatch) {
      const summaryIdx = content.indexOf(summaryMatch[0]);
      const beforeSummary = content.slice(0, summaryIdx);
      const detailsOpenIdx = beforeSummary.lastIndexOf('<details');
      if (detailsOpenIdx !== -1) {
        const afterDetails = content.slice(detailsOpenIdx);
        const closingMatch = afterDetails.match(/<\/details>/i);
        const detailsEnd = closingMatch
          ? detailsOpenIdx + (closingMatch.index ?? 0) + '</details>'.length
          : content.length;
        const anyMilestoneOrDetails = /^#{1,3}\s+(?!Phase\s+\S)(?:.*v\d+\.\d+|✅|📋|🚧|🔄)|<details/im;
        const firstMilestoneMatch = content.match(anyMilestoneOrDetails);
        const preambleCutoff = firstMilestoneMatch ? firstMilestoneMatch.index! : detailsOpenIdx;
        const preamble = stripTaggedBlocks(content.slice(0, preambleCutoff), 'details')
          // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
          .replace(/^#{2,4}\s*Phase\s+[\w][\w.-]*(?:\s*\([^)\n]{0,200}\))?\s*:[^\n]*(?:\n(?!#{1,6}\s)[^\n]*)*\n?/gim, '')
          .replace(/^#{1,4}\s*Phase Details\b[^\n]*\n?/gim, '');
        const value = preamble + content.slice(detailsOpenIdx, detailsEnd);
        return {
          value,
          scope: classifyMilestoneWindow({
            readable: true,
            versionResolved,
            hasVersionedMilestones: versionedMilestonesPresent,
            headingFound: true,
            windowHasPhaseEntries: hasPhaseEntries(value, phaseIdConvention),
            documentHasPhaseEntries,
          }),
        };
      }
    }
    const value = stripShippedMilestones(content);
    return {
      value,
      scope: classifyMilestoneWindow({
        readable: true,
        versionResolved,
        hasVersionedMilestones: versionedMilestonesPresent,
        headingFound: false,
        windowHasPhaseEntries: hasPhaseEntries(value, phaseIdConvention),
        documentHasPhaseEntries,
      }),
    };
  }

  const allMatches = headingMatches;

  const isClosed = isClosedMilestoneHeading;
  const firstMatch = allMatches[0];
  // #3184: selection collapses to the sole owner; `allMatches` is still needed
  // below (offsets, detailsMatch search), so only the selection itself routes
  // through `selectMilestoneHeading` rather than the whole block.
  // Preserve the canonical legacy selector, then fall back to the gated
  // bracket candidates above when a name-only bracket milestone carries no
  // version token for that selector to find.
  const selected = selectMilestoneHeading(content, version)
    ?? allMatches.find((m) => !isClosed(m[1]))
    ?? firstMatch;

  const sectionStart = selected.index;

  // #2761 B1: a bracket heading bearing the selected milestone's own id is
  // a continuation, not a boundary. Derive the selected id once and compose
  // the shared discriminator with upstream's centralized section-end walk.
  const bracketBoundaryActive = bracketScopeConvention === 'bracket';
  const selectedBracketMatch = bracketBoundaryActive
    ? selected[0].match(new RegExp(`^#{1,3}\\s+\\[(${BRACKET_ID_SRC})\\]`, 'i'))
    : null;
  const selectedBracketId = selectedBracketMatch ? foldBracketId(selectedBracketMatch[1]) : null;
  // #2761 B3: tokenize once for both the centralized section-end owner and
  // the bracket preamble scan below. This keeps both boundary decisions
  // fence-aware without restoring the local section walker retired by #3184.
  const currentMilestoneHeadings = tokenizeHeadings(content);
  const bracketBoundary = bracketBoundaryActive
    ? (heading: HeadingToken): boolean =>
      isBracketMilestoneBoundary(heading.text, heading.level, selectedBracketId)
    : undefined;
  const sectionEnd = computeMilestoneSectionEnd(
    content,
    selected[0],
    sectionStart,
    bracketBoundary,
    currentMilestoneHeadings,
  );

  const anyMilestonePattern = /^#{1,3}\s+(?!Phase\s+\S)(?:.*v\d+\.\d+|✅|📋|🚧)/im;
  let earliestMilestoneIndex: number | null;
  if (!bracketBoundaryActive) {
    // #2761 B3: the LEGACY (non-bracket-shaped) path stays a raw
    // `content.match` — byte-identical to before this fix, including its
    // fence-blindness. That hazard is real (a fenced `## Milestone v9.0`
    // example in the preamble reads identically wrong at base, round-1, and
    // HEAD — repro12's LEGACY control) but is PRE-EXISTING and shared with
    // the ORIGINAL (pre-#612) code path, not introduced by this branch —
    // fixing it is explicitly out of scope (round-2 review's own
    // minimal-fix note).
    const versionMilestoneMatch = content.match(anyMilestonePattern);
    earliestMilestoneIndex = versionMilestoneMatch ? versionMilestoneMatch.index! : null;
  } else {
    // #2761 Major 1 (round-3 fix): on the BRACKET branch, derive the
    // version/emoji half of "earliest milestone-shaped heading" from the
    // SAME fence-aware `currentMilestoneHeadings` token list too, instead of
    // the raw `content.match` above. Round-2 (ff6bf0a8) fixed the BRACKET
    // half's fence-blindness but left THIS half a raw regex even on this
    // branch: a fenced VERSION-BEARING example heading in a bracket repo's
    // preamble (`` ```markdown\n## Milestone v9.0: Example\n``` ``, ADR-612's
    // own docs illustrate the LEGACY heading shape exactly this way) was
    // still textually the earliest match for the raw regex, winning the old
    // min() and un-suppressing a wrong persisted 75% that base correctly
    // suppressed (rv-attack3c fixture C1) — B3 fixed only the half of the
    // asymmetry it introduced, not this pre-existing half once it also
    // started reaching the bracket branch. The predicate below (`h.text`
    // against the same `/^Phase\s+\S/i` / `/v\d+\.\d+|✅|📋|🚧/i` pair
    // `computeSectionEnd` already uses) never sees a fenced heading at all,
    // because tokenizeHeadings never produces a token for one.
    //
    // Hardened post-round-3: the raw `content.match(anyMilestonePattern)`
    // this replaced was anchored `^#{1,3}\s+…` — a level cap the token loop
    // dropped entirely. A level-4+ version-bearing heading in the preamble
    // (`#### v2.0 notes`) would win this scan where the raw pattern on the
    // legacy path ignores it outright, cutting the preamble at a heading
    // neither the selector nor `isMilestoneBounded` would ever treat as a
    // milestone marker. Mirrors the depth-sanity cap
    // `isBracketMilestoneBoundary` already applies to the bracket half.
    earliestMilestoneIndex = null;
    for (const h of currentMilestoneHeadings) {
      if (h.level > 3) continue;
      if (/^Phase\s+\S/i.test(h.text)) continue;
      if (/v\d+\.\d+|✅|📋|🚧/i.test(h.text)) { earliestMilestoneIndex = h.offset; break; }
    }
  }
  if (bracketBoundaryActive) {
    // #2761 B3: scans the SAME fence-aware `currentMilestoneHeadings` token
    // list computeSectionEnd consumes, instead of a raw `content.matchAll` —
    // closes the asymmetry between the two halves of one boundary semantic.
    // Before this fix, a fenced markdown example containing a bracket
    // heading (ADR-612's own docs do exactly this) was textually the
    // earliest `#{1,3} [CODE.MM]` match, so `preambleCutoff` landed INSIDE
    // the fence, `preamble` ended with an unclosed opener, and
    // `getMilestonePhaseFilter`'s tokenizeHeadings(scope) call then saw an
    // unbalanced fence and swallowed every real heading, degrading to a
    // pass-all filter (repro11). tokenizeHeadings already strips fenced
    // lines before a heading candidate is ever produced, so a heading INSIDE
    // a fence is never a candidate here at all.
    //
    // `h.text` is ALREADY hash-stripped and trimmed (HeadingToken's own
    // shape) — isBracketMilestoneBoundary is built to consume exactly that,
    // so no `^#{1,3}\s+` re-derivation is needed (that spelling would not
    // match `h.text` — it still carries the hashes in a raw regex match).
    for (let i = 0; i < currentMilestoneHeadings.length; i++) {
      const h = currentMilestoneHeadings[i];
      let isBoundary: boolean;
      if (h.offset === sectionStart) {
        // #2761 B1 (round-3 fix): the SELECTED heading's own occurrence is
        // ALWAYS a correct earliest answer to "where does milestone content
        // begin" — bypass BOTH the same-milestone check inside
        // isBracketMilestoneBoundary (which would otherwise reject this
        // heading against ITSELF, since `selectedBracketId` is its own id)
        // and the same-id-child rule below (which would reject a genuinely
        // childless CURRENT milestone, e.g. one with no phases populated
        // yet). Without this, a same-milestone heading EARLIER than the
        // selected one (a version-less checklist/overview split, or the
        // version-bearing heading landing on the LATER half of such a
        // split — Blocker 1 round-3 cases A/B) would incorrectly win via the
        // OLD `null`-everywhere behaviour, or (with the same-milestone
        // check alone reinstated) the selected heading would incorrectly
        // reject itself and fall through to a stray, unrelated LATER
        // heading.
        isBoundary = true;
      } else if (isBracketMilestoneBoundary(h.text, h.level, selectedBracketId)) {
        // #2761 B1 (round-3 fix, Blocker 1 case D): bracket-shaped, not
        // phase-tail-shaped, and not the SAME id as the selected milestone
        // is not enough — an unrelated bracket-shaped PROSE heading
        // (`## [ADR.612] Heading convention used by this roadmap`) reads as
        // a genuine boundary by those rules alone. Require its own next
        // DEEPER heading to carry ITS bracket id too — the property every
        // genuine sibling MILESTONE has (its own phase children) and no
        // unrelated prose heading does.
        //
        // #2761 round-4 Minor 1 (docstring correction — no code change): a
        // heading rejected here (no same-id PHASE child — see
        // bracketHeadingHasMatchingChild's own comment) leaves its WHOLE
        // SUBTREE in the preamble, not merely its own inert heading text.
        // That subtree can still contain a DIFFERENT-id bracket PHASE
        // heading, which DOES form a qualified key and CAN admit a foreign
        // directory (F7: `## [GSD.01] Setup` / `### [GSD.07] 01: Foreign` —
        // no same-id child, so `[GSD.01] Setup` is not a boundary, and
        // `GSD.07-01-foreign`'s directory is admitted into the CURRENT
        // milestone's filter, reading 3/2/67%). This is NOT a regression —
        // base, round-1 and HEAD all read 3/2/67% on F7 (base via its own
        // pass-all degrade) — and it remains the declared OVER-inclusive,
        // never under-inclusive, safe direction; it is a narrower and more
        // honest claim than "contributes nothing to any phase count", which
        // is true of the candidate's OWN text but not of what its subtree
        // can carry.
        isBoundary = bracketHeadingHasMatchingChild(currentMilestoneHeadings, i);
      } else {
        isBoundary = false;
      }
      if (!isBoundary) continue;
      if (earliestMilestoneIndex === null || h.offset < earliestMilestoneIndex) {
        earliestMilestoneIndex = h.offset;
      }
      break;
    }
  }
  const preambleCutoff = earliestMilestoneIndex !== null
    ? earliestMilestoneIndex
    : firstMatch.index;
  const beforeMilestones = content.slice(0, preambleCutoff);
  // #3982: newest-first roadmaps collapse their archives into <details>
  // blocks BELOW the active milestone, whose titles live in <summary> tags —
  // not headings — so no milestone-shaped heading bounds the section walk and
  // the raw slice runs to end-of-document. Strip CLOSED milestone details
  // blocks here so the window never feeds archived phases to the
  // lowest-outstanding scan. Deliberately NOT a blanket strip: the active
  // milestone may legitimately hold its own collapsed <details> (#1341), and
  // removing that would trade this bug for the phase_count: 0 class (#557).
  // Gated on the same isClosedMilestoneHeading the file already applies to
  // <summary> lines, per the issue's prescribed narrower fix.
  const currentSection = stripClosedMilestoneDetails(content.slice(sectionStart, sectionEnd));

  // Multi-milestone roadmaps split each added milestone across two version-bearing
  // headings: a `## Phases` checklist subsection (early) and a dedicated
  // `## Milestone … (Phase Details)` section (late) holding the `### Phase N:`
  // detail headers. The scope window above stops at the next version-bearing
  // heading — the current milestone's OWN Phase Details heading — leaving those
  // detail headers outside `currentSection`. Append that section so phase
  // resolution and counting see the current milestone's phases. Anchor the lookup
  // to the SELECTED heading's specific version token (boundary-aware, so a
  // `v3.0` state does not match a `v3.0-A` sub-milestone) so sibling milestones
  // that share a version prefix do not cross-pollinate. (#730)
  const selectedVersionToken = selected[1].match(
    /v\d+(?:\.\d+)+(?:[-.][A-Za-z0-9]+)*/i,
  )?.[0];
  const detailsVersionBoundary = selectedVersionToken
    ? new RegExp(`${escapeRegex(selectedVersionToken)}(?![\\w.-])`, 'i')
    : null;
  let detailsSection = '';
  const detailsMatch = allMatches.find(
    (m) =>
      /\(Phase\s+Details\)/i.test(m[1]) &&
      !isClosed(m[1]) &&
      (!detailsVersionBoundary || detailsVersionBoundary.test(m[1])) &&
      (m.index ?? 0) >= sectionEnd,
  );
  if (detailsMatch) {
    const detailsStart = detailsMatch.index ?? 0;
    detailsSection = content.slice(
      detailsStart,
      computeMilestoneSectionEnd(content, detailsMatch[0], detailsStart, bracketBoundary, currentMilestoneHeadings),
    );
  }

  // #2947: the preamble strip removes `### Phase N:` detail headings from the
  // pre-milestone region so they don't duplicate the ones inside the selected
  // milestone section. But when the phase list lives under a non-version-bearing
  // `## Phases` heading (the shipped greenfield template's own shape) and the
  // selected version-bearing heading is a LATER progress/notes sub-heading with
  // NO phase details of its own, stripping the preamble phases silently drops
  // every phase (phase_count: 0, exit 0). Only strip preamble phase details when
  // the selected milestone section actually contains its own — otherwise the
  // preamble phases ARE this milestone's phases and must be preserved.
  const currentSectionHasPhaseDetails = /^#{2,4}\s*Phase\s+\S/im.test(currentSection);
  const preambleBase = stripTaggedBlocks(beforeMilestones, 'details');
  // #3235: the conditional wraps the REPLACE, not the pattern. This used to select between the
  // strip regex and a `/$/` sentinel, which made the do-not-strip branch an identity replacement
  // (CodeQL js/identity-replacement, alert 53) -- correct, but it left both branches sharing one
  // replacement argument, so changing `''` would silently give the no-op branch a real effect.
  // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
  const preambleWithoutPhaseDetails = currentSectionHasPhaseDetails
    ? preambleBase.replace(/^#{2,4}\s*Phase\s+[\w][\w.-]*(?:\s*\([^)\n]{0,200}\))?\s*:[^\n]*(?:\n(?!#{1,6}\s)[^\n]*)*\n?/gim, '')
    : preambleBase;
  // Unconditional in BOTH branches -- the #730 `Phase Details` heading strip is independent of
  // whether the selected milestone section carries phase details of its own.
  const preamble = preambleWithoutPhaseDetails.replace(/^#{1,4}\s*Phase Details\b[^\n]*\n?/gim, '');

  const value = detailsSection
    ? preamble + currentSection + '\n' + detailsSection
    : preamble + currentSection;

  return {
    value,
    scope: classifyMilestoneWindow({
      readable: true,
      versionResolved,
      hasVersionedMilestones: versionedMilestonesPresent,
      headingFound: true,
      windowHasPhaseEntries: hasPhaseEntries(value, phaseIdConvention),
      documentHasPhaseEntries,
    }),
  };
}

/**
 * #3184: thin wrapper preserving `extractCurrentMilestone`'s exact signature
 * and return type — CRITICAL blast radius (20 direct callers), so the type
 * stays `string`. `extractCurrentMilestoneScoped` is the real owner; callers
 * that need to branch on scope opt in to it directly.
 */
function extractCurrentMilestone(content: string, cwd?: string, ws?: string | null): string {
  return extractCurrentMilestoneScoped(content, cwd, ws).value;
}

/**
 * Replace a pattern only in the current milestone section of ROADMAP.md.
 */
type RoadmapReplacer = (match: string, ...captures: string[]) => string;

function replaceInCurrentMilestone(
  content: string,
  pattern: RegExp,
  replacement: string | RoadmapReplacer,
): string {
  const apply = (src: string): string =>
    typeof replacement === 'function'
      ? src.replace(pattern, replacement)
      : src.replace(pattern, replacement);
  const lastDetailsClose = content.lastIndexOf('</details>');
  if (lastDetailsClose === -1) {
    return apply(content);
  }
  const offset = lastDetailsClose + '</details>'.length;
  const before = content.slice(0, offset);
  const after = content.slice(offset);
  return before + apply(after);
}

/**
 * Resolve a single phase's detail-section heading (`### Phase N: …`, any level
 * 1–6, via the #2121 phase-id source) and run `edit` against ONLY that
 * section's body. Delegates to `withSection` (markdown-sectionizer.cjs), so a
 * per-phase ROADMAP edit is structurally bounded to that phase's own section —
 * it cannot escape into a sibling phase, a shipped-milestone `<details>` block,
 * or a backticked prose literal (ADR-2143 §4).
 *
 * `content` is expected to already be scoped to the current milestone's raw
 * range(s) by the caller (see `currentMilestoneRawRanges`) — `withPhaseSection`
 * composes with that milestone-level scoping rather than replacing it.
 *
 * The matched phase number must be delimited by whitespace, a colon, an
 * open-paren tag, or end-of-heading — never a bare `\b`. A trailing `\b` sits
 * between the last digit and a following `.` or letter, so it would let a
 * query for phase `1` prefix-match a decimal sub-phase heading like
 * `### Phase 1.1: Sub` or a distinct suffixed phase like `### Phase 1A: …`.
 *
 * The phase token must additionally anchor to the START of the heading text
 * (after an optional leading `[tag]`, mirroring `findRoadmapPhaseInContent`
 * below) — never merely appear anywhere in it. Without this anchor, a query
 * for phase `1` would match a SIBLING phase whose own TITLE happens to
 * mention "Phase 1" (e.g. `### Phase 3: Migrate off Phase 1 legacy pipeline`),
 * and — because `collectSection` picks the first matching heading in document
 * order — that sibling would be hijacked instead of the real Phase 1 section.
 *
 * The section body is bounded by `{ levelBounded: false }`: it ends at the
 * next ATX heading of ANY level, not merely a heading at or above the phase
 * heading's own level. Real ROADMAPs are not guaranteed to use a uniform
 * phase-heading level, so a level-bounded stop could fold a deeper sibling
 * heading (e.g. a `####` phase following a `###` phase) into this phase's
 * body and let `edit` reach into it.
 */
function withPhaseSection(
  content: string,
  phaseId: unknown,
  edit: (body: string) => string,
): string {
  const src = phaseMarkdownRegexSource(phaseId);
  const headingRe = new RegExp(`^\\s*(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+${src}(?=[\\s:(]|$)`, 'i');
  return withSection(content, (h: HeadingToken) => headingRe.test(h.text), edit, { levelBounded: false });
}

// ─── Roadmap phase lookup ─────────────────────────────────────────────────────

// #2199: a bullet/checkbox phase entry, e.g. `- [ ] **Phase 36 — Authentication**`
// (the bundled roadmapper emits this in bullet-house-style ROADMAPs). The number
// is captured in group 1, the name in group 2; the separator may be an em-dash,
// en-dash, hyphen, or colon. Used as a fallback when no ATX heading matches, and
// to count phases in a milestone that uses the bullet form.
const BULLET_PHASE_LINE_PATTERN =
  /^\s*[-*]\s+(?:\[[ xX]\]\s+)?\*\*Phase\s+([\w][\w.-]*)(?:\s*\([^)\n]{0,200}\))?\s*[—–:\-]\s*(.+?)\*\*/im;

/** Build a bullet-phase-line regex pinned to a specific phase number (#2199). */
function bulletPhaseLineFor(phaseNum: unknown, phaseSource?: string): RegExp {
  const num = phaseSource ?? phaseMarkdownRegexSource(phaseNum);
  return new RegExp(
    `^\\s*[-*]\\s+(?:\\[[ xX]\\]\\s+)?\\*\\*Phase\\s+(${num})${OPTIONAL_PHASE_TAG_SOURCE}\\s*[—–:\\-]\\s*(.+?)\\*\\*`,
    'im',
  );
}

interface RoadmapPhaseResult {
  found: boolean;
  phase_number: string;
  phase_name: string;
  goal: string | null;
  section: string;
}

function findRoadmapPhaseInContent(content: string, phaseNum: unknown, phaseSource?: string): RoadmapPhaseResult | null {
  // #1729: OPTIONAL_PHASE_TAG_SOURCE after the number tolerates a pre-colon ( ) tag.
  const headingPattern = new RegExp(
    `^(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+${phaseSource ?? phaseMarkdownRegexSource(phaseNum)}${OPTIONAL_PHASE_TAG_SOURCE}:\\s*(.+)$`,
    'i'
  );
  const headings = tokenizeHeadings(content);
  const headingIndex = headings.findIndex((heading) => headingPattern.test(heading.text));
  if (headingIndex === -1) return null;

  const heading = headings[headingIndex];
  const headerMatch = heading.text.match(headingPattern);
  if (!headerMatch) return null;

  const phaseName = headerMatch[1].trim();
  const nextHeading = headings.slice(headingIndex + 1).find((candidate) => candidate.level <= heading.level);
  const sectionEnd = nextHeading ? nextHeading.offset : content.length;
  const section = content.slice(heading.offset, sectionEnd).trim();

  const goalMatch = section.match(/\*\*Goal(?:\*\*:|\*?\*?:\*\*)\s*([^\n]+)/i);
  const goal = goalMatch ? goalMatch[1].trim() : null;

  return {
    found: true,
    phase_number: String(phaseNum),
    phase_name: phaseName,
    goal,
    section,
  };
}

// #3577: markdown-table row fallback. Mirrors the #2199 bullet fallback's
// tier — used only AFTER heading and bullet lookups fail on scoped + full
// content, so a heading with a Requirements/Goal section always wins. The row
// itself is the section (single line), the name comes from column 2.
function findRoadmapTablePhaseInContent(content: string, phaseNum: unknown): RoadmapPhaseResult | null {
  const wanted = String(phaseNum).replace(/^0+(?=.)/, '');
  for (const tr of collectTablePhaseRows(content)) {
    if (tr.id.replace(/^0+(?=.)/, '') !== wanted) continue;
    return {
      found: true,
      phase_number: String(phaseNum),
      phase_name: tr.name ?? `Phase ${tr.id}`,
      goal: null,
      section: tr.row.trim(),
    };
  }
  return null;
}

function findRoadmapBulletPhaseInContent(content: string, phaseNum: unknown, phaseSource?: string): RoadmapPhaseResult | null {
  // #2199: bullet/checkbox entry fallback (`- [ ] **Phase N — name**`). Returns
  // the single bullet line as the section (no multi-line body) — used only as a
  // last resort, AFTER heading lookup on scoped + full content has failed, so a
  // heading with a Requirements/Goal section always wins.
  const bulletMatch = content.match(bulletPhaseLineFor(phaseNum, phaseSource));
  if (!bulletMatch) return null;
  return {
    found: true,
    phase_number: String(phaseNum),
    phase_name: bulletMatch[2].trim(),
    goal: null,
    section: bulletMatch[0].trim(),
  };
}

function getRoadmapPhaseInternal(cwd: string, phaseNum: unknown): RoadmapPhaseResult | null {
  if (!phaseNum) return null;
  const normalizedPhase = stripProjectCodePrefix(phaseNum);
  // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
  if (isSentinelPhaseId(normalizedPhase)) return null;
  // Resolved INSIDE the try for the same reason as getMilestoneInfo below: planningDir
  // throws a plain Error for an invalid GSD_WORKSTREAM/GSD_PROJECT segment, and resolving
  // it outside let that escape uncaught, crashing every caller for a malformed workstream
  // name. ADR-227 is explicit that throwing breaks pipeline continuity, and this read path
  // has no reason to be the exception -- it already degrades to null for every other
  // failure. Absence still returns null before any diagnostic, and when the path never
  // resolved there is nothing to name.
  let roadmapPath: string | undefined;

  try {
    roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
    if (!fs.existsSync(roadmapPath)) return null;
    const roadmapRaw = platformReadSync(roadmapPath);
    if (roadmapRaw === null) throw new Error('missing');
    const content = extractCurrentMilestone(roadmapRaw, cwd);
    const fullContent = stripShippedMilestones(roadmapRaw);

    for (const source of roadmapPhaseLookupSources(phaseNum)) {
      const scopedResult = findRoadmapPhaseInContent(content, phaseNum, source);
      if (scopedResult) return scopedResult;

      const fullResult = findRoadmapPhaseInContent(fullContent, phaseNum, source);
      if (fullResult) return fullResult;
    }

    // #2199: no ATX heading matched on scoped or full content — fall back to a
    // bullet/checkbox entry (em-dash/en-dash/hyphen/colon separator). Last resort
    // so a bullet never pre-empts a heading that carries the Requirements section.
    for (const source of roadmapPhaseLookupSources(phaseNum)) {
      const scopedBullet = findRoadmapBulletPhaseInContent(content, phaseNum, source);
      if (scopedBullet) return scopedBullet;

      const fullBullet = findRoadmapBulletPhaseInContent(fullContent, phaseNum, source);
      if (fullBullet) return fullBullet;
    }

    // #3577: last tier — a markdown-table row declaration.
    const scopedTable = findRoadmapTablePhaseInContent(content, phaseNum);
    if (scopedTable) return scopedTable;
    const fullTable = findRoadmapTablePhaseInContent(fullContent, phaseNum);
    if (fullTable) return fullTable;

    return null;
  } catch (err) {
    // Absence already returned above via existsSync; anything caught here is a read fault
    // or the synthetic missing-marker. The null is preserved exactly either way.
    if (roadmapPath !== undefined) reportUnreadableRoadmap(err, roadmapPath);
    return null;
  }
}

/**
 * Report a ROADMAP.md that exists but could not be read (#1881, ADR-1411).
 *
 * The discriminator is the errno, and it matters in the SILENT direction.
 * platformReadSync returns null for ENOENT and both callers convert that null into a
 * synthetic Error carrying no code, which lands in the same catch as a real EACCES.
 * Reporting unconditionally here would flag every project that has no ROADMAP.md yet --
 * every brand-new project -- as corrupt. A genuine read fault always carries an errno;
 * absence never does.
 *
 * The parse itself is regex over text and cannot throw, so anything reaching a catch is
 * either a read fault or that synthetic absence marker. Nothing else gets here.
 */
function reportUnreadableRoadmap(err: unknown, roadmapPath: string): void {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return;
  warnUnusableInput({ reason: UNUSABLE_REASON.ROADMAP_UNREADABLE, source: roadmapPath });
}

// ─── Roadmap progress table (#1956/#2012 decoy avoidance) ─────────────────────

/**
 * Locate ROADMAP.md's "Progress" table — the sole owner of the #2012
 * decoy-avoidance scope for the `drift-guard phase-status` CLI seam (#1956).
 *
 * Scopes to the `## Progress` heading first (level-2, exact case-insensitive
 * text `'progress'`, `{ levelBounded: true }`) via `collectSection` — the
 * same CRLF-safe seam `stateCurrentPositionSlice` (state-document.cts) uses
 * to scope STATE.md's `## Current Position` — so a differently-headed table
 * that happens to share the same column names (e.g. an "Archive Notes"
 * table) is never picked up instead of the real one (#2012). Falls back to
 * scanning the WHOLE document when no `## Progress` heading exists, so a
 * headingless milestone slice (#1445) still resolves rather than going
 * uncheckable — the same fallback `deriveProgressFromRoadmap`
 * (phase-lifecycle.cts) deliberately preserves.
 *
 * `deriveProgressFromRoadmap` independently expresses this same "scope to
 * `## Progress`, else whole document" rule via its own regex-based scope
 * (kept there deliberately rather than refactored onto this function — its
 * blast radius is large). The two locators are therefore separate
 * implementations of the same scoping rule and must agree about WHICH table
 * is the Progress table; a parity test in
 * tests/adr-22-plan-drift-guard.test.cjs asserts they do, per the repo's
 * generative-fix-divergence guard.
 *
 * Returns the same shape `findTableWithColumns` returns (or `null`).
 */
function findRoadmapProgressTable(roadmapContent: string): MarkdownTable | null {
  const isProgressHeading = (h: HeadingToken): boolean =>
    h.level === 2 && h.text.trim().toLowerCase() === 'progress';
  const section = collectSection(roadmapContent, isProgressHeading, { levelBounded: true });
  const scoped = section ? section.body : roadmapContent;
  return findTableWithColumns(scoped, ['Phase', 'Plans Complete', 'Status', 'Completed']);
}

// ─── Milestone info lookup ────────────────────────────────────────────────────

interface MilestoneInfo {
  version: string;
  name: string | null;
}

/**
 * Strip a leading delimiter run (whitespace, em/en-dash, colon, hyphen) from a
 * milestone-name capture. Markdown headings commonly take the shape
 * `## vX.Y — Name` or `## vX.Y: Name`; the raw capture includes the delimiter
 * because `.trim()` only removes whitespace, not punctuation. A name beginning
 * with punctuation is a delimiter-led fragment, not the curated name (#2135).
 * NOTE: do not strip `#` — a name beginning with `#` is a heading-parse failure
 * that should stay loud rather than be silently cleaned.
 */
function stripLeadingDelimiter(s: string): string {
  return s.replace(/^[\s—–:-]+/, '').trim();
}

/**
 * #3216 (ADR-3180 §7.2's "Name extraction — pinned rule"): the sole "milestone
 * heading text → version + curated name" rule. Strips everything through the
 * heading's OWN version token — NOT necessarily a version a caller is
 * separately asking about (a `v2.0` STATE selecting a `## v2.0.1 — Portability`
 * heading yields the name `Portability`, never `.1 — Portability`) — then ONE
 * leading delimiter and surrounding whitespace via `stripLeadingDelimiter`.
 * `(` is an ordinary name character and is never a terminator (#3171). Shared
 * by `listMilestoneHeadings` and `getMilestoneInfo` so this rule has exactly
 * one implementation. Returns `null` when `headingText` carries no version
 * token at all (e.g. a non-milestone heading reached this by mistake).
 *
 * #4134 (§7.2 rule 6 floor): the rule's direction assumes version-then-name.
 * A name-then-version heading (`# Roadmap: Project — Name (v1.13)`) leaves a
 * punctuation fragment (`)`) after the token; a remainder with no letter or
 * digit anywhere is heading structure, not a curated name, and is refused as
 * `name: null` so callers report the honest rule-6 answer instead of
 * fabricating garbage. Names that merely CONTAIN punctuation are unaffected.
 *
 * @param expectedVersion - When the caller already knows the exact version it
 *   is looking for (the STATE-anchored `getMilestoneInfo` path, which located
 *   this heading via `selectMilestoneHeading(roadmap, stateVersion)`), pass it
 *   here so the "own version token" is found by anchoring to that KNOWN
 *   literal (escaped, then extended by the same dash/dot continuation grammar
 *   for the row-16/17 sub-milestone cases) instead of independently
 *   re-deriving a version-shaped pattern from scratch. `listMilestoneHeadings`
 *   (version-agnostic enumeration — no target version exists) omits this and
 *   keeps the generic re-derivation. Anchoring on the known literal is what
 *   makes a hostile STATE `milestone:` value (regex metacharacters, single-
 *   segment `vN`, a literal `$&`/`$1`) resolve correctly: the generic pattern
 *   only recognizes the real GSD version grammar and stops early on anything
 *   outside it, leaving hostile characters in the extracted "name".
 */
function extractMilestoneHeadingName(
  headingText: string,
  expectedVersion?: string,
): { version: string; name: string | null } | null {
  const versionMatch = expectedVersion
    // Anchor to the KNOWN literal version, then extend across any immediate
    // dash/dot continuation the heading's OWN token carries beyond it (e.g.
    // requested v8.0 -> heading's own v8.0-B; requested v2.0 -> v2.0.1).
    // `.match()` here — never `.replace()` — so a `$&`/`$1`-bearing version
    // is located as a literal substring and never interpreted as a
    // String.replace() substitution pattern.
    ? headingText.match(new RegExp(`${escapeRegex(expectedVersion)}(?:[-.][A-Za-z0-9]+)*`, 'i'))
    // No known target: re-derive a version-shaped token generically. `v3` /
    // `v3.3` / `v3.3.3` must all resolve to themselves (§7.2), so the dotted
    // continuation is zero-or-more, not one-or-more.
    : headingText.match(/v\d+(?:\.\d+)*(?:[-.][A-Za-z0-9]+)*/i);
  if (!versionMatch) return null;
  const version = versionMatch[0];
  const afterVersion = headingText.slice((versionMatch.index ?? 0) + version.length);
  // Amendment (§7.2 pinned rule): after stripping the leading delimiter, also
  // strip a trailing run of status markers (✅ 📋 🚧) plus surrounding
  // whitespace — the marker is already carried structurally by `closed`, so
  // duplicating it inside `name` (e.g. "Old ✅") is redundant and wrong. Only
  // these three markers, only at the end; a marker inside a name is untouched.
  const candidate = stripLeadingDelimiter(afterVersion).replace(/\s*(?:[✅📋🚧]\s*)+$/, '') || null;
  // #4134 (§7.2 rule 6 floor): a "name" with no letter or digit anywhere is
  // heading structure, not a curated name. The pinned rule takes everything
  // AFTER the version token, so a name-then-version heading (`# Roadmap:
  // Project — Name (v1.13)` — the shape a first-ever ROADMAP.md drifts into)
  // leaves exactly `)` there, which used to be returned as a COMPLETE-scope
  // name and propagated into init.* output and STATE.md. Refuse it: callers
  // already report the honest rule-6 answer (version kept, `name: null`,
  // scope TRUNCATED) for an unresolvable name. A name that merely CONTAINS
  // punctuation is untouched — `(` is an ordinary name character (#3171) —
  // and digits alone qualify (`## v4.0 — 42` is the name `42`).
  const name = candidate !== null && /[\p{L}\p{N}]/u.test(candidate) ? candidate : null;
  return { version, name };
}

/**
 * #3216 (epic #3180 §7.2, "Milestone identity"): which milestone is current,
 * and what is it called. Binds to the canonical `locateMilestoneHeadings` /
 * `listMilestoneHeadings` / `extractMilestoneHeadingName` owners and deletes
 * both hand-rolled heading regexes this function used to carry — the
 * level-blind STATE-version regex (#3197) and the unanchored fallback regex
 * (#3171) — so the class of defect they produced ("### Phase N: … v3.3 …"
 * read as milestone `v3.3`; a name truncated at `(`) is structurally
 * unrepresentable rather than merely fixed on this one copy.
 *
 * Never throws (#2245) — the outer try/catch returns `{value: null, scope:
 * UNREADABLE}` on any failure, preserving `state.cts:1663`'s "this wrapper
 * could never be triggered" invariant. Absence (ENOENT) is silent (#1881,
 * ADR-1411); a genuine read fault (e.g. EACCES) still reports via
 * `reportUnreadableRoadmap`, which discriminates on the errno exactly as
 * before.
 *
 * The `{version:'v1.0', name:'milestone'}` default this function used to
 * return on every unresolved path is DELETED per §7.2 rule 4 — it was
 * output-identical to a successful read of a genuine v1.0 project. Every
 * unresolved path now returns a `scope` other than `COMPLETE` instead.
 */
/**
 * #3216 review Finding 2: `getMilestoneInfo`'s `{ value, scope }` return shape
 * was hand-built as an inline object literal at every return point — factored
 * out once so the shape itself cannot drift between call sites. Purely a
 * literal-shape constructor: does not decide, validate, or alter any value or
 * scope — every per-branch rationale comment stays exactly where it was.
 */
function scoped(value: MilestoneInfo | null, scope: Scope): { value: MilestoneInfo | null; scope: Scope } {
  return { value, scope };
}

function getMilestoneInfo(cwd?: string): { value: MilestoneInfo | null; scope: Scope } {
  // Declared here but RESOLVED INSIDE the try, so the catch can name the file without
  // moving planningDir() out of the protected region. planningDir throws a plain Error
  // for an invalid GSD_WORKSTREAM/GSD_PROJECT segment, and hoisting the call let that
  // escape uncaught — breaking the invariant #2245 relies on, that this function never
  // throws. When the path never resolved there is nothing to name, so the diagnostic is
  // skipped and the default is returned exactly as before.
  let roadmapPath: string | undefined;
  try {
    if (!cwd) return scoped(null, SCOPE.UNREADABLE);

    roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
    const roadmap = platformReadSync(roadmapPath);
    if (roadmap === null) throw new Error('missing');

    let stateVersion: string | null = null;
    if (cwd) {
      try {
        const statePath = path.join(planningDir(cwd), 'STATE.md');
        const stateRaw = platformReadSync(statePath);
        if (stateRaw !== null) {
          const m = stateRaw.match(/^milestone:\s*(.+)/m);
          if (m) stateVersion = m[1].trim();
        }
      } catch {
        /* best-effort (#2245 audit): platformReadSync re-throws for a non-ENOENT
         * failure (e.g. EACCES) reading STATE.md. Consulting STATE.md's
         * `milestone:` field is an OPTIONAL enhancement here — on failure this
         * function already falls back to ROADMAP-only heuristics below, the
         * same fallback path taken when STATE.md simply doesn't exist. */
      }
    }

    if (stateVersion) {
      const escapedVer = escapeRegex(stateVersion);

      // #2135: consult the 🚧 name-bearing marker FIRST. It is the only construct
      // guaranteed to carry the milestone's curated name adjacent to its version
      // (the active-milestone bullet). A `##` heading is often nameless
      // ("## vX.Y — Active Milestone") and, when unanchored, was matched
      // spuriously on a copy quoted inside backticks in this very bullet.
      // #3216 fix (progressMarkerBulletIsConsultedBeforeHeading): the version
      // is commonly wrapped in its OWN bold pair — `🚧 **v3.3** Name` — so a
      // trailing `\*?\*?` after the version (mirroring the leading one) is
      // required before the `\s+` that anchors the name capture; without it
      // the closing `**` sits between the version and the required whitespace
      // and the whole match fails, silently falling through to the heading.
      const listMatch = roadmap.match(
        new RegExp(`🚧\\s*\\*?\\*?${escapedVer}\\*?\\*?\\s+([^*\\n]+)`, 'i')
      );
      if (listMatch) {
        const name = stripLeadingDelimiter(listMatch[1]);
        if (name) return scoped({ version: stateVersion, name }, SCOPE.COMPLETE);
      }

      // #3216: heading selection routes through the shared owner
      // (`selectMilestoneHeading` — locate → prefer-non-closed, mirroring
      // `sliceMilestoneWindow`), deleting the level-blind `^##…` regex (#3197)
      // and the unanchored `[:\s]+([^\n(]+)` name capture that truncated at a
      // parenthetical (#3171). A CLOSED/shipped heading is not "current" (row
      // 5) — it falls through to the TRUNCATED return below exactly as a
      // missing heading would.
      const selected = selectMilestoneHeading(roadmap, stateVersion);
      if (selected) {
        const headingText = selected[1].replace(/^#{1,3}\s+/, '');
        if (!isClosedMilestoneHeading(headingText)) {
          // #3216 fix: pass the KNOWN stateVersion so name extraction anchors
          // to it (see extractMilestoneHeadingName's `expectedVersion` doc) —
          // fixes single-segment versions (`v3`, no dot) and hostile STATE
          // values (regex metacharacters, literal `$&`/`$1`) that the generic
          // re-derivation used by listMilestoneHeadings cannot recognize.
          const extracted = extractMilestoneHeadingName(headingText, stateVersion);
          if (extracted && extracted.name) {
            return scoped({ version: stateVersion, name: extracted.name }, SCOPE.COMPLETE);
          }
        }
      }

      // Version is known (STATE.md), but no name-bearing evidence resolved:
      // no 🚧 bullet, no usable heading (absent, phase-only-excluded, shipped,
      // or heading-but-nameless). §7.2 rule 4 — never fabricate a name.
      return scoped({ version: stateVersion, name: null }, SCOPE.TRUNCATED);
    }

    // No STATE.md version. The 🚧 in-progress bullet is still consulted first
    // (unchanged from the pre-#3216 fallback).
    const inProgressMatch = roadmap.match(/🚧\s*\*\*v(\d+(?:\.\d+)+)\s+([^*]+)\*\*/);
    if (inProgressMatch) {
      return scoped(
        { version: 'v' + inProgressMatch[1], name: inProgressMatch[2].trim() },
        SCOPE.COMPLETE,
      );
    }

    // #3216: enumerate every OPEN (non-shipped) milestone heading via the
    // shared owner and take the first in document order — deletes the
    // unanchored `/## (?!.*✅).*v(\d+(?:\.\d+)+)[:\s]+([^\n(]+)/` fallback
    // regex (#3171/#3197), whose `## ` prefix matched starting at the SECOND
    // `#` of a `### Phase N: …` heading.
    const cleaned = stripShippedMilestones(roadmap);
    const openHeadings = listMilestoneHeadings(cleaned).filter((h) => !h.closed);
    if (openHeadings.length > 0) {
      const first = openHeadings[0];
      if (first.name) {
        return scoped({ version: first.version, name: first.name }, SCOPE.COMPLETE);
      }
      return scoped({ version: first.version, name: null }, SCOPE.TRUNCATED);
    }

    // No usable milestone heading anywhere. A version token mentioned ONLY
    // inside an excluded `### Phase N: … vX.Y …` heading is not evidence
    // (#3197) and must not be reported as if it were a real version — value
    // stays null, scope UNSCOPED. A version token mentioned OUTSIDE any Phase
    // heading (prose, a bullet, a non-milestone heading) is weak-but-real
    // evidence — version retained, name null, scope TRUNCATED.
    const withoutPhaseHeadingLines = cleaned.replace(/^#{1,4}\s*Phase\s+\S[^\n]*$/gim, '');
    const bareVersionMatch = withoutPhaseHeadingLines.match(/v\d+(?:\.\d+)+/i);
    if (bareVersionMatch) {
      return scoped({ version: bareVersionMatch[0], name: null }, SCOPE.TRUNCATED);
    }

    // Free-form legacy ROADMAP with no version anywhere reachable, OR the
    // only version-bearing heading was a `### Phase N` heading. §7.1's
    // "free-form is COMPLETE" governs WINDOWING (whole document is the
    // window); identity has no version to report and must not invent one.
    return scoped(null, SCOPE.UNSCOPED);
  } catch (err) {
    // This function has no existsSync guard, so an absent ROADMAP arrives here too, as a
    // synthetic Error with no errno. Only a real read fault is reported; `value: null` is
    // returned unchanged either way, and a plausible-looking default needs the diagnostic
    // more than an empty sentinel does, not less (ADR-1411).
    if (roadmapPath !== undefined) reportUnreadableRoadmap(err, roadmapPath);
    return scoped(null, SCOPE.UNREADABLE);
  }
}

// ─── Milestone phase filter ───────────────────────────────────────────────────

type MilestonePhaseFilter = ((dirName: string) => boolean) & {
  phaseCount: number;
  missingExplicitVersion: boolean;
  /**
   * #2562: true only when `versionOverride` was supplied AND a matching
   * milestone section was located, i.e. the phase set really is scoped to that
   * one milestone. False for the whole-roadmap (unversioned) shape, where
   * `phaseCount` spans the project's lifetime and must NOT be read as a
   * current-milestone denominator.
   */
  versionScoped: boolean;
  /**
   * #2562: true when `versionOverride`'s milestone section was LOCATED in the
   * ROADMAP, independent of whether it turned out to declare any phases.
   * `versionScoped` cannot answer that question — a located-but-empty section
   * falls through to the zero-count pass-all filter below, which resets
   * `versionScoped` to false, making "milestone absent" and "milestone present
   * but not yet populated" indistinguishable. They are not the same state: the
   * second is a real, empty current milestone, and a caller that treats it as
   * "unscoped" silently reports the project's whole phase history as if it were
   * the current milestone's.
   */
  versionSectionFound: boolean;
  /**
   * #3184 (ADR-3180 Decision 2): the same window-classification carried by
   * `extractCurrentMilestoneScoped`. The filter's FUNCTION behavior is
   * UNCHANGED by this field — pass-all still passes all; a destructive
   * consumer (`cmdMilestoneComplete`) reads `scope` to refuse instead.
   */
  scope: Scope;
};

/**
 * Returns a filter function that checks whether a phase directory belongs
 * to the current milestone based on ROADMAP.md phase headings.
 *
 * @param cwd - Project working directory.
 * @param versionOverride - Optional version string to scope the phase filter
 *   to a specific milestone (e.g. 'v1.2').
 * @param phaseIdConvention - The resolved `phase_id_convention` config value.
 *   When `'milestone-prefixed'`, a deprecation warning is emitted for
 *   free-form ROADMAPs that lack versioned milestone headings. When absent or
 *   any other value, the warning is suppressed — legacy/default projects must
 *   never see spurious warnings.
 * @param ws - #2562: workstream name, so the ROADMAP/STATE pair is read from
 *   `.planning/workstreams/<ws>/` instead of the project root. Required by any
 *   caller that iterates workstreams (it cannot set `GSD_WORKSTREAM` per
 *   iteration). Omitted (the default) preserves the prior `planningDir(cwd)`
 *   resolution exactly, including its `GSD_WORKSTREAM` env fallback — every
 *   pre-#2562 call site is unaffected.
 */
function getMilestonePhaseFilter(cwd: string, versionOverride?: string | null, phaseIdConvention?: string | null, ws?: string | null): MilestonePhaseFilter {
  const milestonePhaseNums = new Set<string>();
  // #612: the milestone-QUALIFIED form (`{CODE}.{MM}-{PP}`) of each in-scope
  // bracket heading, kept in its OWN set — deliberately not in
  // milestonePhaseNums. A qualified id ALWAYS contains a hyphen, so putting one
  // there would flip `roadmapUsesHyphenedIds` below on EVERY bracket repo, which
  // swaps `numericRe` to the continuation-segment variant and silently moves the
  // LEGACY dir path. Separate set; `phaseCount` is unchanged.
  //
  // Stated exactly, because the narrower claim is the true one: this keeps
  // QUALIFIED IDS out of that flag's input, not hyphens in general. A heading
  // whose TOKEN carries its own hyphen (`### [GSD.02] Phase 02-01:`) still flips
  // it through milestonePhaseNums — as it also does at base, which matches that
  // spelling through the un-widened intro. See the token-hyphen guard below.
  const milestoneQualifiedIds = new Set<string>();
  // Hoisted out of the try so the DIR side can select the same grammar the
  // HEADING side selected. The two halves of this one filter reading different
  // conventions is exactly the defect the bracket branch below closes.
  let headingConvention: string | null | undefined;
  let missingExplicitVersion = false;
  let versionScoped = false;
  let versionSectionFound = false;
  let scope: Scope = SCOPE.UNREADABLE;
  try {
    const roadmapPath = path.join(planningDir(cwd, ws), 'ROADMAP.md');
    const roadmapContent = platformReadSync(roadmapPath);
    if (roadmapContent === null) throw new Error('missing');
    const scopedResult = extractCurrentMilestoneScoped(roadmapContent, cwd, ws, phaseIdConvention);
    let roadmap = scopedResult.value;
    // Default: the filter's window IS extractCurrentMilestoneScoped's own
    // window (reused verbatim, not re-derived — ADR-3180 Decision 4c).
    // Overwritten below when `versionOverride` scopes to a DIFFERENT window.
    scope = scopedResult.scope;

    // #3184: routed through the shared owner (was an inline copy — see the
    // twin copy in `extractCurrentMilestoneScoped`, the intra-owner-file
    // duplicate review caught since the drift guard exempts this file by
    // construction).
    const hasVersionedMilestonesGlobal = hasVersionedMilestones(roadmapContent);
    const hasPhaseHeadings = /#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+[\w]/i.test(roadmapContent);
    if (!hasVersionedMilestonesGlobal && hasPhaseHeadings && phaseIdConvention === 'milestone-prefixed') {
      console.warn(
        '[gsd] Deprecated: free-form ROADMAP.md detected (no versioned milestone headings). ' +
        'The project has phase_id_convention set to "milestone-prefixed" in config.json but the ' +
        'ROADMAP does not use versioned milestone headings. Run `gsd-tools roadmap upgrade --convention milestone-prefixed` to migrate (dry-run by default).'
      );
    }

    if (versionOverride) {
      // #3184: route the whole "locate headings -> pick the active one ->
      // section-end" composition through the single owner (sliceMilestoneWindow)
      // instead of assembling it here. This branch used to be a bare `.match()`
      // — first hit, no closed-heading skip, no version-token boundary — and a
      // review pass caught it independently re-composing the SAME primitives
      // `cmdMilestoneComplete`'s guard composed, disagreeing on closed-heading
      // skipping. Now both sites call one function. Boundary-matched
      // (`(?![\w.-])`) and closed-heading-skipping is a declared Tier-2 change
      // affecting every caller that passes `versionOverride`: `roadmap.analyze`
      // / `milestone complete` (this module, `cmdMilestoneComplete` in
      // milestone.cts), `inspectWorkstream` (workstream-inventory.cts:518,
      // via `currentVersion`), and `buildStateFrontmatter` (state.cts:1700,
      // via `storedMilestone`).
      const sliced = sliceMilestoneWindow(roadmapContent, versionOverride);

      const documentHasPhaseEntries = hasPhaseEntries(stripShippedMilestones(roadmapContent), phaseIdConvention);

      if (sliced !== null) {
        versionScoped = true;
        versionSectionFound = true;
        roadmap = sliced;
      } else {
        const escapedVersion = escapeRegex(versionOverride);
        const versionInSummary = new RegExp(`<summary[^>]*>[^<]*${escapedVersion}[^<]*<\\/summary>`, 'i').test(roadmapContent);
        if (hasVersionedMilestonesGlobal && !versionInSummary) {
          roadmap = '';
          missingExplicitVersion = true;
        }
        // else: version appears only inside a `<summary>`, or there are no
        // versioned milestones anywhere — `roadmap` keeps
        // extractCurrentMilestoneScoped's own (STATE-scoped) result, matching
        // the pre-existing summary-block / free-form fallback shape.
      }

      scope = classifyMilestoneWindow({
        readable: true,
        versionResolved: true,
        hasVersionedMilestones: hasVersionedMilestonesGlobal,
        headingFound: sliced !== null,
        windowHasPhaseEntries: hasPhaseEntries(roadmap, phaseIdConvention),
        documentHasPhaseEntries,
      });
    }

    // Resolve once, then thread the same answer through the shared scan and
    // directory matcher. Resolve an omitted value from this call's `ws`;
    // explicit null still means "resolved and non-bracket." A split convention
    // would widen the ROADMAP side while leaving bracket directories unmatched.
    headingConvention = phaseIdConvention === undefined
      ? resolvePhaseIdConvention(cwd, ws)
      : phaseIdConvention;
    // #3262 remains the single owner of the phase-set scan. #612 extends its
    // return with qualified bracket ids rather than restoring the superseded
    // inline duplicate this commit was originally written against.
    const scanned = scanMilestonePhaseIdSets(roadmap, headingConvention);
    for (const id of scanned.ids) milestonePhaseNums.add(id);
    for (const qualified of scanned.qualifiedIds) milestoneQualifiedIds.add(qualified);
  } catch {
    /* best-effort (#2245 audit): the real throw source is platformReadSync
     * at the top of this try (re-throws for a non-ENOENT read failure). On
     * any failure milestonePhaseNums stays empty, which below already
     * degrades to the same pass-all filter this function returns when a
     * ROADMAP genuinely has zero recognizable phase headings — a safe,
     * non-corrupting (over-inclusive, never under-inclusive) degrade.
     * #3184: `scope` was set to SCOPE.UNREADABLE before the try (row 2) and
     * is left as-is here — the read/parse fault IS the unreadable case. */
  }

  if (milestonePhaseNums.size === 0) {
    const passAll = (() => true) as unknown as MilestonePhaseFilter;
    passAll.phaseCount = 0;
    passAll.missingExplicitVersion = missingExplicitVersion;
    passAll.versionScoped = false;
    // #2562: preserved through the pass-all degrade precisely BECAUSE
    // `versionScoped` is reset here — this is the only surviving evidence that
    // the current milestone exists in the ROADMAP and simply has no phases yet.
    passAll.versionSectionFound = versionSectionFound;
    // #3184: the filter's FUNCTION behavior is unchanged — pass-all still
    // passes all. `scope` is the decidable signal a destructive consumer
    // reads to refuse instead (ADR-3180 Decision 3's two-tier policy).
    passAll.scope = scope;
    return passAll;
  }

  function normalizePhaseIdSegments(id: string): string {
    return id.split('-').map(seg => seg.replace(/^0+(?=\d)/, '') || '0').join('-');
  }

  // #2562: derive BOTH sides of every membership comparison from
  // normalizePhaseIdSegments. This set previously inlined a byte-identical
  // second copy of that logic — the drift-prone shape this issue is about.
  const normalized = new Set(
    [...milestonePhaseNums].map(n => normalizePhaseIdSegments(n).toLowerCase())
  );

  const roadmapUsesHyphenedIds = [...normalized].some(n => n.includes('-'));
  // #3213: longest-first so a hyphenated declared ID (e.g. "proj-42") is tested
  // before a prefix of it (e.g. "proj") in the segment-boundary membership loop
  // below — otherwise the shorter id would admit a dir that belongs to the longer.
  const normalizedIdsLongestFirst = [...normalized].sort((a, b) => b.length - a.length);
  // #2043: milestone-prefixed sub-phase components must be zero-padded — so a
  // single-digit slug word after the phase
  // number (e.g. dir "46-6-rs-…") captures "46" and is not silently excluded from
  // the milestone as a bogus "46-6" id. #2232: the continuation width is exactly 2
  // (PHASE_CONTINUATION_SEGMENT_SOURCE), so a year-leading slug word (dir
  // "14-2026-photos-…") captures "14" and is not excluded as a bogus "14-2026" id.
  // Built via new RegExp (no /i — the [A-Za-z] letter class does real case handling).
  const numericRe = roadmapUsesHyphenedIds
    ? new RegExp(
        `^0*(\\d+[A-Za-z]?(?:-${phaseIdModule.PHASE_CONTINUATION_SEGMENT_SOURCE}[A-Z]?)*(?:\\.\\d+)*)(?=-|$)`,
      )
    // phase-id-owner: the [A-Za-z] letter class does real case handling here — this regex carries NO /i flag; kept literal, not source-byte-equal to the canonical PHASE_NUMBER_TOKEN_SOURCE.
    : /^0*(\d+[A-Za-z]?(?:\.\d+)*)/;

  function isDirInMilestone(dirName: string): boolean {
    // #612: the DIR side of this filter, selected by the same convention the
    // heading side selected. Without it the heading scan's new bracket reach was
    // half a fix: `milestonePhaseNums` became non-empty, so the pass-all degrade
    // stopped firing, but no bracket directory could satisfy the three legacy
    // checks below (numericRe fails on `GSD.02-05-five`, the custom-id match
    // captures the project code `GSD`, and stripProjectCodePrefix does not strip
    // a dotted prefix) — so EVERY bracket directory was rejected and
    // completed_phases / total_plans / completed_plans / percent collapsed to 0
    // while `state sync` went on writing a percent off the unfiltered disk.
    //
    // Matching is delegated to phaseTokenMatches against the milestone-QUALIFIED
    // id, not the bare token: READING-B puts the milestone in the bracket, so
    // `GSD.01-01-old-one` and `GSD.02-01-one` share the token `01` and only the
    // qualified key separates them. That is the scoping this filter exists to do.
    // ADDITIVE: on a miss we fall through to the three legacy checks, so a
    // bracket repo carrying legacy-shaped directories reads exactly as before.
    if (headingConvention === 'bracket') {
      for (const qualified of milestoneQualifiedIds) {
        if (phaseTokenMatches(dirName, qualified, 'bracket')) return true;
      }
    }
    const m2 = dirName.match(numericRe);
    if (m2 && normalized.has(normalizePhaseIdSegments(m2[1]).toLowerCase())) return true;
    // #3213: segment-boundary membership test, scoped to LETTER-LEADING (custom-
    // ID) directories only. The prior greedy capture
    // `^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)` swallowed the WHOLE hyphenated
    // directory name (A-tool-output-contract was captured as
    // "A-tool-output-contract", not "A"), so every letter-named phase directory
    // (Phase A:..Phase L: — GSD's own convention, ADR-612 first-class non-numeric
    // IDs) fell out of the milestone and counts were silently fabricated over
    // whatever numeric directory survived. A letter-leading directory belongs if
    // its lowercased name EQUALS a declared phase ID, or BEGINS with that ID
    // followed by "-" (so "A-tool-output-contract" matches ID "a";
    // "PROJ-42-description" matches ID "proj-42"; "AB-combined" does NOT match
    // "a"). SCOPED TO LETTER-LEADING DIRS because numeric dirs are owned by
    // numericRe above, which respects the #2232 continuation grammar — a bare
    // startsWith here would wrongly admit "14-02-photos-…" to phase "14" when its
    // real token is "14-02" (continuation-absorbed, not declared).
    if (/^[A-Za-z]/.test(dirName)) {
      const lowerDir = dirName.toLowerCase();
      for (const id of normalizedIdsLongestFirst) {
        if (lowerDir === id || lowerDir.startsWith(id + '-')) return true;
      }
    }
    const stripped = stripProjectCodePrefix(dirName);
    if (stripped !== dirName) {
      const sm = stripped.match(numericRe);
      if (sm && normalized.has(normalizePhaseIdSegments(sm[1]).toLowerCase())) return true;
    }
    // #3185: last resort — ask the CANONICAL phase-id token extractor. The
    // three attempts above are all leading-DIGIT or bare-alnum shapes, so none
    // of them can match a #1324 letter-prefixed-DECIMAL directory
    // (`P0.0-foundation`) against its own `### Phase P0.0:` heading: numericRe
    // needs a leading digit, `customMatch` stops at the `.` and yields `P0`,
    // and stripProjectCodePrefix needs a dash before the digit. The observable
    // symptom was `stats` reporting such a phase with plans: 0 while its
    // directory held plan files, because the heading seeded the row but the
    // directory never folded in. extractPhaseToken is #2121's single owner of
    // "what is this directory's phase token", so this defers to it rather than
    // widening a fourth bespoke regex here. Additive: it can only ADMIT a
    // directory, never exclude one the attempts above already matched.
    const token = extractPhaseToken(dirName);
    if (token && normalized.has(normalizePhaseIdSegments(String(token)).toLowerCase())) return true;
    return false;
  }
  (isDirInMilestone as MilestonePhaseFilter).phaseCount = milestonePhaseNums.size;
  (isDirInMilestone as MilestonePhaseFilter).missingExplicitVersion = missingExplicitVersion;
  (isDirInMilestone as MilestonePhaseFilter).versionScoped = versionScoped;
  (isDirInMilestone as MilestonePhaseFilter).versionSectionFound = versionSectionFound;
  (isDirInMilestone as MilestonePhaseFilter).scope = scope;
  return isDirInMilestone as MilestonePhaseFilter;
}

/**
 * #2200: raw [start,end) offsets of the current milestone's region(s) in ROADMAP
 * content, for scoping write-path mutations (phase-checkbox flip, Plans-count
 * writer) so they cannot touch a backticked prose literal, a Backlog entry, or a
 * same-numbered phase in a shipped milestone.
 *
 * Mirrors the region selection in `extractCurrentMilestoneScoped` (version
 * detection → active heading → next milestone boundary → optional Phase
 * Details section) — both consume the same `locateMilestoneHeadings` /
 * `computeMilestoneSectionEnd` owner (#3184), so there is no separate copy to
 * keep in sync. Returns null when there is no versioned active milestone;
 * callers then fall back to whole-content mutation (the prior behaviour).
 *
 * #2761 (round-2 review, Minor 3 — latent, currently harmless): this function
 * consumes #3184's shared owners, but it does not pass the bracket-specific
 * B1/B2 boundary predicate and still has no bracket-fallback SELECTION branch:
 * it returns null when the version-string owner finds nothing, unlike
 * `extractCurrentMilestoneScoped`. The read owner can therefore scope a
 * bracket ROADMAP this write-range consumer still calls unscoped. Probed and
 * confirmed harmless TODAY: this
 * function's single consumer (`mutateMilestonePhase`, src/phase.cts) falls
 * back to whole-content mutation when it returns null, and every mutation
 * inside that caller is still `Phase`-labelled-only (not bracket-widened) per
 * the changeset's own "READ-path opt-in until the migrator and write path
 * land" — so a bracket ROADMAP's checkbox/heading patterns never match inside
 * that fallback and nothing is mutated cross-milestone. The moment the write
 * path is widened (PR-3+), this divergence becomes live: the whole-content
 * fallback would become a cross-milestone writer, which is exactly what this
 * note exists to prevent. Bracket-widen this function in lockstep with the
 * write path landing, not before.
 */
function currentMilestoneRawRanges(
  content: string,
  cwd?: string,
): { primary: { start: number; end: number }; details: { start: number; end: number } | null } | null {
  if (!cwd) return null;

  let version: string | null = null;
  try {
    const statePath = path.join(planningDir(cwd), 'STATE.md');
    const stateRaw = platformReadSync(statePath);
    if (stateRaw !== null) {
      const milestoneMatch = stateRaw.match(/^milestone:\s*(.+)/m);
      if (milestoneMatch) version = milestoneMatch[1].trim();
    }
  } catch { /* ignore */ }
  if (!version) {
    const inProgressMatch = content.match(/(?:🚧|🔄)\s*\*\*v(\d+\.\d+)\s/);
    if (inProgressMatch) version = 'v' + inProgressMatch[1];
  }
  if (!version) return null;

  const headingMatches = locateMilestoneHeadings(content, version);
  if (headingMatches.length === 0) return null;

  const isClosed = isClosedMilestoneHeading;
  // #3184: selection collapses to the sole owner; `headingMatches` is still
  // needed below for the detailsMatch search over all headings.
  const selected = selectMilestoneHeading(content, version)!;
  const sectionStart = selected.index ?? 0;

  const sectionEnd = computeMilestoneSectionEnd(content, selected[0], sectionStart);

  const selectedVersionToken = selected[1].match(
    /v\d+(?:\.\d+)+(?:[-.][A-Za-z0-9]+)*/i,
  )?.[0];
  const detailsVersionBoundary = selectedVersionToken
    ? new RegExp(`${escapeRegex(selectedVersionToken)}(?![\\w.-])`, 'i')
    : null;
  const detailsMatch = headingMatches.find(
    (m) =>
      /\(Phase\s+Details\)/i.test(m[1]) &&
      !isClosed(m[1]) &&
      (!detailsVersionBoundary || detailsVersionBoundary.test(m[1])) &&
      (m.index ?? 0) >= sectionEnd,
  );
  let details: { start: number; end: number } | null = null;
  if (detailsMatch) {
    const detailsStart = detailsMatch.index ?? 0;
    details = { start: detailsStart, end: computeMilestoneSectionEnd(content, detailsMatch[0], detailsStart) };
  }

  return { primary: { start: sectionStart, end: sectionEnd }, details };
}

export = {
  stripShippedMilestones,
  extractCurrentMilestone,
  extractCurrentMilestoneScoped,
  isMilestoneShippedInRoadmap,
  isMilestoneBoundedInRoadmap,
  replaceInCurrentMilestone,
  getRoadmapPhaseInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  currentMilestoneRawRanges,
  withPhaseSection,
  computeMilestoneSectionEnd,
  locateMilestoneHeadings,
  listMilestoneHeadings,
  selectMilestoneHeading,
  classifyMilestoneWindow,
  // #3184: the sole "give me this version's window" composition — see its
  // own doc comment. milestone.cts's destructive-consumer guard consumes
  // this instead of composing locate+select+section-end itself.
  sliceMilestoneWindow,
  hasVersionedMilestones,
  hasMilestoneSectioning,
  // #3642: the >=1 sibling buildStateFrontmatter's unbounded branch consumes.
  hasAnyMilestoneSection,
  // #1956: sole owner of the #2012 decoy-avoidance scope for the
  // `drift-guard phase-status` CLI seam.
  findRoadmapProgressTable,
  // #3262 (write-time milestone-scope guard): the window phase-id scan owner
  // (consumed by getMilestonePhaseFilter above and the roadmap milestone-scope
  // CLI probe) and the free-text predicate the phase add/add-batch/insert
  // guards and the edit-phase workflow's pre/post capture are built on.
  scanMilestonePhaseIds,
  collectTablePhaseRows,
  findMilestoneScopeHeadingLines,
  // #3641: the scope axis's phase-ENTRY predicate, exported so roadmap
  // validate's V004 document-level check routes through the same single
  // owner (and its convention gate) instead of a private inline copy.
  hasPhaseEntries,
};

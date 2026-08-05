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
 *   - ./phase-id.cjs        (escapeRegex, phaseMarkdownRegexSource)
 *   - ./planning-workspace.cjs (planningDir)
 *   - ./shell-command-projection.cjs (platformReadSync)
 *   - ./markdown-sectionizer.cjs (tokenizeHeadings, stripTaggedBlocks, withSection)
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdModule = require('./phase-id.cjs');
const {
  escapeRegex,
  phaseMarkdownRegexSource,
  stripProjectCodePrefix,
  OPTIONAL_PHASE_TAG_SOURCE,
  // #2121: roadmapPhaseLookupSources now lives in phase-id.cjs (single owner of
  // the lookup-source ordering); imported here rather than defined locally.
  roadmapPhaseLookupSources,
  phaseHeadingPrefixSrcFor,
  PHASE_HEADING_BASELINE,
  // #612: the disk-side milestone filter resolves bracket directories through
  // the owner's gated helpers rather than spelling the grammar a second time.
  isSentinelPhaseId,
  phaseTokenMatches,
  // #2761 B1: the version-less bracket milestone boundary (computeSectionEnd /
  // preambleCutoff, below) is built from this single-owner source rather than a
  // re-typed `[A-Z][A-Z0-9_]*\.\d+` literal.
  BRACKET_ID_SRC,
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
import { tokenizeHeadings, stripTaggedBlocks, withSection } from './markdown-sectionizer.cjs';
import type { HeadingToken } from './markdown-sectionizer.cjs';

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
 * or later SIBLING MILESTONE — whose own subtree contains a real PHASE
 * heading carrying ITS bracket id (`## [GSD.01] Setup` / `### [GSD.01] 01: …`)
 * — from an unrelated bracket-shaped PROSE heading sitting above the current
 * milestone's own content. `isBracketMilestoneBoundary` alone cannot make
 * this distinction, and neither can same-id-ness alone: round-4's case F1
 * is `## [ADR.612] Heading convention` followed by its OWN sub-heading
 * `### [ADR.612] Examples` — same id as the candidate, but a MILESTONE-shaped
 * heading (a name, no digit-then-colon), not a phase. Same-id-ness alone
 * satisfied the rule the round-3 hardening shipped, re-opening exactly the
 * case that hardening was meant to close — the requirement was never "does
 * this heading have EVIDENCE bearing its own id", it was "does this heading
 * have PHASE CHILDREN of its own", the property that actually distinguishes
 * a genuine sibling milestone from a bracket-shaped id namespace that merely
 * happens to nest headings under itself. `BRACKET_PHASE_TAIL_RE` is the
 * single-owner phase-vs-milestone discriminator `isBracketMilestoneBoundary`
 * already uses for the SAME distinction one level up — reused here, not
 * re-derived.
 *
 * SCANS THE WHOLE SUBTREE, not just the immediate next heading — an earlier
 * version checked only `headings[index + 1]` and returned `false` the moment
 * that ONE heading wasn't a same-id match, even if it wasn't bracket-shaped
 * at all. A genuine prior milestone whose section opens with a non-bracket
 * subsection before its first phase (`## [GSD.01] Setup` / `### Notes` /
 * `### [GSD.01] 01: Old`) was therefore wrongly rejected as a boundary by
 * that version, leaking the ENTIRE prior-milestone section — including its
 * real bracket phase heading — into the preamble unstripped. Confirmed
 * observable, not merely theoretical: `GSD.01-01-old`'s directory was
 * wrongly admitted into the CURRENT milestone's filter via the leaked
 * heading's qualified key, inflating a 2/1/50% truth to 3/2/67% (rv2-amend1
 * fixture).
 *
 * A candidate whose ENTIRE subtree closes (next same-or-shallower heading,
 * or EOF) with no same-id PHASE hit at all — including a genuinely childless
 * heading, or one whose same-id children are all MILESTONE-shaped rather
 * than phase-shaped (F1) — degrades to `false`, NOT a boundary. This is
 * deliberately the OVER-inclusive direction: the heading's own text (and any
 * non-matching subtree content) stays in the preamble. See the docstring
 * correction at the call site below (round-4 Minor 1) for what that
 * over-inclusive degrade can and cannot leak.
 *
 * `headings` is the SAME `currentMilestoneHeadings` token list the caller
 * iterates; `index` is the candidate's own position in it.
 */
function bracketHeadingHasMatchingChild(headings: HeadingToken[], index: number): boolean {
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
 * Extract the current milestone section from ROADMAP.md by positive lookup.
 *
 * @param content - ROADMAP.md content.
 * @param cwd - Project working directory, used to read the companion STATE.md
 *   for the current `milestone:` version.
 * @param ws - #2562: workstream name, so the companion STATE.md is read from
 *   `.planning/workstreams/<ws>/` instead of the project root. Omitted (the
 *   default) preserves the prior `planningDir(cwd)` resolution exactly,
 *   including its `GSD_WORKSTREAM` env fallback.
 */
function extractCurrentMilestone(content: string, cwd?: string, ws?: string | null): string {
  if (!cwd) return stripShippedMilestones(content);

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

  if (!version) return stripShippedMilestones(content);

  const escapedVersion = escapeRegex(version);
  const sectionPattern = new RegExp(
    `(^#{1,3}\\s+(?!Phase\\s+\\S).*${escapedVersion}\\b[^\\n]*)`,
    'gmi'
  );
  const summaryPattern = new RegExp(
    `<summary[^>]*>([^<]*${escapedVersion}[^<]*)<\\/summary>`,
    'i'
  );
  let headingMatches = [...content.matchAll(sectionPattern)];

  // #612: the ADR-canonical bracket milestone heading is `## [GSD.02] Foundation`
  // — a NAME, no version — so it contains no `v2.0` for the version-string scope
  // above to find. Scoping then failed, `milestoneBounded` went false, and
  // total_phases silently fell back to the on-disk directory count: the exact
  // symptom the bracket read path exists to remove, for the exact heading form
  // the ADR specifies.
  //
  // GATED, so a non-bracket repo cannot start scoping on a bracket heading it
  // never wrote. READING-B parity: the bracket's milestone integer is the
  // milestone, matched against the `vN` of STATE's milestone string.
  //
  // GUARDED, for the same reason getRoadmapPhaseInternal and getMilestoneInfo
  // carry their #2245 / ADR-227 notes: `resolvePhaseIdConvention` reaches
  // `planningDir`, which throws a plain Error for a `GSD_PROJECT`/`GSD_WORKSTREAM`
  // segment containing `/`, `\` or `..`. At base the only planningDir call in
  // this function is inside the STATE-read try above, so the function returned
  // normally on such an environment; hoisting an unguarded one here let that
  // escape and broke the never-throws invariant those two siblings are hardened
  // for. Not reachable through the CLI — GSD_WORKSTREAM is rejected up front by
  // the workstream-name policy and GSD_PROJECT throws identically at base — but
  // it is reachable by any in-process embedder calling this module directly.
  // On failure the convention is simply unknown, which takes the pre-existing
  // non-bracket path: the same safe degrade as a repo with no config.
  //
  // #2761 B3 (self-caught, round-2 verification): resolved UNCONDITIONALLY —
  // NOT gated on `headingMatches.length === 0` — because this convention also
  // feeds `computeSectionEnd`'s and `preambleCutoff`'s boundary detection
  // further down, which must engage on an opted-in bracket repo regardless of
  // which branch selected the current heading. The round-1 fix coupled two
  // different concerns under one gate: SELECTION's own bracket fallback
  // (immediately below — correctly still gated on `headingMatches.length ===
  // 0`, UNCHANGED) and boundary detection, which accidentally inherited
  // SELECTION's gate instead of having its own. On a roadmap where the CURRENT
  // milestone heading is itself version-bearing but a sibling (PRIOR or LATER)
  // is not, the version-string match above already succeeds —
  // `headingMatches.length !== 0` — so under the old single gate
  // `bracketScopeConvention` was never resolved and the version-less sibling
  // leaked in exactly like the original #612 defect. The extra
  // `resolvePhaseIdConvention` call this now costs on every call (previously
  // only paid when the version-string match found nothing) is deliberate: a
  // non-bracket repo still resolves to something other than `'bracket'` (or
  // `null` on a poisoned env, caught below), so `bracketMilestoneHeadingRe`
  // stays `null` and every downstream branch is byte-identical to today.
  let bracketScopeConvention: string | null = null;
  try {
    bracketScopeConvention = resolvePhaseIdConvention(cwd);
  } catch { /* unresolvable convention → treat as not-configured (base behaviour) */ }
  if (headingMatches.length === 0 && bracketScopeConvention === 'bracket') {
    const vMatch = version.match(/^v(\d+)/i);
    const milestoneInt = vMatch ? parseInt(vMatch[1], 10) : NaN;
    if (Number.isSafeInteger(milestoneInt)) {
      // The CANONICAL spelling only (pad2), not `0*N`: an unpadded `[GSD.2]`
      // scoped a milestone that no phase heading could then resolve into, so
      // roadmapPhaseCount stayed 0 and total_phases fell back to the directory
      // count — the very symptom this scoping fix removes.
      const canonical = String(milestoneInt).padStart(2, '0');
      // #612 round-4 (Major 1, F9's selection half): tokenizeHeadings, not a
      // raw content.matchAll — a FENCED example heading sharing the current
      // project's own bracket id (ADR-612's own authoring docs illustrate
      // exactly this shape) could otherwise be SELECTED as the current
      // milestone, landing `sectionStart` inside a fence. This is the ONE
      // place this whole round-4 fix touches SELECTION — semantics are
      // otherwise unchanged: same pattern, same first-match-wins by document
      // order, only the candidate set is now fence-aware (a heading inside a
      // fence was never a real heading to begin with). Reconstructs a
      // match-shaped array ([fullLine, fullLine], with `.index`) so every
      // downstream consumer of `headingMatches` (computeSectionEnd, the
      // version-token lookup) sees the exact shape the raw-regex path always
      // produced. `h.offset` is `tokenizeHeadings`' LINE-START offset, not
      // necessarily the `#` character itself — a ≤3-space-indented heading
      // has both — so the `content[h.offset] === '#'` filter above discards
      // any token the line-start-anchored raw `^#{1,3}\s+\[...` would never
      // have matched. For every survivor, `h.offset` IS the `#` character,
      // so `content.slice(h.offset, lineEnd)` is byte-identical to what
      // `[^\n]*` would have captured at `content.match().index`.
      const bracketMilestoneHeadingRe = new RegExp(`^\\[[A-Z][A-Z0-9_]*\\.${canonical}\\]`, 'i');
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
        return preamble + content.slice(detailsOpenIdx, detailsEnd);
      }
    }
    return stripShippedMilestones(content);
  }

  const allMatches = headingMatches;

  const isClosed = isClosedMilestoneHeading;
  const firstMatch = allMatches[0];
  const selected = allMatches.find((m) => !isClosed(m[1])) || firstMatch;

  const sectionStart = selected.index;

  // #2761 B1 (round-2 fix): the SELECTED milestone's own bracket id, case-
  // folded, so isBracketMilestoneBoundary can recognise a heading that merely
  // CONTINUES the current milestone's own section (a version-less split like
  // `## [GSD.02] Foundation (Phase Details)`) instead of treating it as the
  // boundary to a DIFFERENT milestone — the Blocker 1 defect: the version-
  // string re-append at `detailsMatch` below only searches `allMatches` (the
  // VERSION-string matches), so a version-less continuation heading was cut
  // out by the boundary below and never re-appended. `selected[0]` is the
  // FULL matched heading line (hashes included) on BOTH selection paths above
  // (the version-string `sectionPattern` match and the bracket-fallback
  // match), so this one extraction covers both; `null` on a non-bracket
  // heading or a non-bracket convention, in which case the same-milestone
  // check below simply never fires.
  const bracketBoundaryActive = bracketScopeConvention === 'bracket';
  const selectedBracketMatch = bracketBoundaryActive
    ? selected[0].match(new RegExp(`^#{1,3}\\s+\\[(${BRACKET_ID_SRC})\\]`, 'i'))
    : null;
  const selectedBracketId = selectedBracketMatch ? foldBracketId(selectedBracketMatch[1]) : null;

  // #2761 B1: the ADR-canonical bracket milestone heading (`## [GSD.02]
  // Foundation`) carries no `vN.N` and no status emoji, so neither
  // `computeSectionEnd` below nor the `preambleCutoff` scan further down
  // recognised it as a milestone boundary — every LATER milestone swept into
  // `computeSectionEnd`'s scope, and every PRIOR milestone landed in
  // `preambleCutoff`'s preamble. Under the bracket scope branch, a heading
  // isBracketMilestoneBoundary recognises is ALSO a valid boundary.
  // `bracketScopeConvention` (see its own comment above, #2761 B3) resolves
  // independently of which branch selected the current heading, so this
  // engages on ANY opted-in bracket repo — a non-bracket convention (or an
  // unresolvable one) leaves `bracketBoundaryActive` false and takes the exact
  // pre-existing code path, byte-identically.

  // #2761 B3: tokenized ONCE and shared by computeSectionEnd and the
  // preambleCutoff bracket scan below (previously each re-tokenized the whole
  // document independently, and the preambleCutoff scan didn't tokenize at
  // all — see that scan's own comment for why that was the Blocker 3 defect).
  const currentMilestoneHeadings = tokenizeHeadings(content);

  const computeSectionEnd = (headingText: string, headingStart: number): number => {
    const level = (headingText.match(/^(#{1,3})\s/) ?? ['', '#'])[1].length;
    const afterHeading = headingStart + headingText.length;
    // Fence-aware, offsets into original content — finds the next stop
    // boundary without re-implementing fence detection. T4 seam migration.
    for (const h of currentMilestoneHeadings) {
      if (h.offset <= headingStart) continue;
      if (h.offset < afterHeading) continue;
      if (h.level > level) continue;
      // Mirrors old stopPattern: level-bounded, not a Phase heading, milestone marker
      if (/^Phase\s+\S/i.test(h.text)) continue;
      if (/v\d+\.\d+|✅|📋|🚧/i.test(h.text)) return h.offset;
      if (bracketBoundaryActive && isBracketMilestoneBoundary(h.text, h.level, selectedBracketId)) {
        return h.offset;
      }
      continue;
    }
    return content.length;
  };

  const sectionEnd = computeSectionEnd(selected[0], sectionStart);

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
  const currentSection = content.slice(sectionStart, sectionEnd);

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
      computeSectionEnd(detailsMatch[0], detailsStart),
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
  const preamble = stripTaggedBlocks(beforeMilestones, 'details')
    // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
    .replace(currentSectionHasPhaseDetails ? /^#{2,4}\s*Phase\s+[\w][\w.-]*(?:\s*\([^)\n]{0,200}\))?\s*:[^\n]*(?:\n(?!#{1,6}\s)[^\n]*)*\n?/gim : /$/, '')
    .replace(/^#{1,4}\s*Phase Details\b[^\n]*\n?/gim, '');

  return detailsSection
    ? preamble + currentSection + '\n' + detailsSection
    : preamble + currentSection;
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
  if (/^999(?:\.|$)/.test(normalizedPhase)) return null;
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

// ─── Milestone info lookup ────────────────────────────────────────────────────

interface MilestoneInfo {
  version: string;
  name: string;
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

function getMilestoneInfo(cwd: string): MilestoneInfo {
  // Declared here but RESOLVED INSIDE the try, so the catch can name the file without
  // moving planningDir() out of the protected region. planningDir throws a plain Error
  // for an invalid GSD_WORKSTREAM/GSD_PROJECT segment, and hoisting the call let that
  // escape uncaught — breaking the invariant #2245 relies on, that this function never
  // throws. When the path never resolved there is nothing to name, so the diagnostic is
  // skipped and the default is returned exactly as before.
  let roadmapPath: string | undefined;
  try {
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
      const listMatch = roadmap.match(
        new RegExp(`🚧\\s*\\*?\\*?${escapedVer}\\s+([^*\\n]+)`, 'i')
      );
      if (listMatch) {
        const name = stripLeadingDelimiter(listMatch[1]);
        if (name) return { version: stateVersion, name };
      }

      // Fall back to the `##` heading — ANCHORED to line start (`^` + `m` flag)
      // so a heading quoted inside backticks or prose mid-line can no longer
      // match. Skip shipped (✅) headings.
      const headingMatch = roadmap.match(
        new RegExp(`^##[^\\n]*${escapedVer}[:\\s]+([^\\n(]+)`, 'im')
      );
      if (headingMatch && !headingMatch[0].includes('✅')) {
        // Strip a leading delimiter — `.trim()` removes whitespace, not the
        // em-dash/colon that conventionally separates version from name.
        const name = stripLeadingDelimiter(headingMatch[1]);
        if (name) return { version: stateVersion, name };
      }

      return { version: stateVersion, name: 'milestone' };
    }

    const inProgressMatch = roadmap.match(/🚧\s*\*\*v(\d+(?:\.\d+)+)\s+([^*]+)\*\*/);
    if (inProgressMatch) {
      return {
        version: 'v' + inProgressMatch[1],
        name: inProgressMatch[2].trim(),
      };
    }

    const cleaned = stripShippedMilestones(roadmap);
    const headingMatch = cleaned.match(/## (?!.*✅).*v(\d+(?:\.\d+)+)[:\s]+([^\n(]+)/);
    if (headingMatch) {
      return {
        version: 'v' + headingMatch[1],
        name: headingMatch[2].trim(),
      };
    }
    const versionMatch = cleaned.match(/v(\d+(?:\.\d+)+)/);
    return {
      version: versionMatch ? versionMatch[0] : 'v1.0',
      name: 'milestone',
    };
  } catch (err) {
    // This function has no existsSync guard, so an absent ROADMAP arrives here too, as a
    // synthetic Error with no errno. Only a real read fault is reported; the populated
    // default is returned unchanged either way, and a plausible-looking default needs the
    // diagnostic more than an empty sentinel does, not less (ADR-1411).
    if (roadmapPath !== undefined) reportUnreadableRoadmap(err, roadmapPath);
    return { version: 'v1.0', name: 'milestone' };
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
  try {
    const roadmapPath = path.join(planningDir(cwd, ws), 'ROADMAP.md');
    const roadmapContent = platformReadSync(roadmapPath);
    if (roadmapContent === null) throw new Error('missing');
    let roadmap = extractCurrentMilestone(roadmapContent, cwd, ws);

    const hasVersionedMilestonesGlobal = /^#{1,3}\s+.*v\d+\.\d+/mi.test(roadmapContent);
    const hasPhaseHeadings = /#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+[\w]/i.test(roadmapContent);
    if (!hasVersionedMilestonesGlobal && hasPhaseHeadings && phaseIdConvention === 'milestone-prefixed') {
      console.warn(
        '[gsd] Deprecated: free-form ROADMAP.md detected (no versioned milestone headings). ' +
        'The project has phase_id_convention set to "milestone-prefixed" in config.json but the ' +
        'ROADMAP does not use versioned milestone headings. Run `gsd-tools roadmap upgrade --convention milestone-prefixed` to migrate (dry-run by default).'
      );
    }

    if (versionOverride) {
      const escapedVersion = escapeRegex(versionOverride);
      const sectionPattern = new RegExp(`(^#{1,3}\\s+(?!Phase\\s+\\S).*${escapedVersion}[^\\n]*)`, 'mi');
      let sectionMatch = roadmapContent.match(sectionPattern);

      if (!sectionMatch) {
        const summaryPat = new RegExp(`<summary[^>]*>[^<]*${escapedVersion}[^<]*<\\/summary>`, 'i');
        const summaryHit = roadmapContent.match(summaryPat);
        if (summaryHit) {
          const beforeSummary = roadmapContent.slice(0, summaryHit.index);
          const detailsIdx = beforeSummary.lastIndexOf('<details');
          if (detailsIdx !== -1) {
            sectionMatch = null;
          }
        }
      }

      if (!sectionMatch) {
        const hasVersionedMilestones = /^#{1,3}\s+(?!Phase\s+\S).*v\d+\.\d+/mi.test(roadmapContent);
        const versionInSummary = new RegExp(`<summary[^>]*>[^<]*${escapedVersion}[^<]*<\\/summary>`, 'i').test(roadmapContent);
        if (hasVersionedMilestones && !versionInSummary) {
          roadmap = '';
          missingExplicitVersion = true;
        }
      } else {
        versionScoped = true;
        versionSectionFound = true;
        const sectionStart = sectionMatch.index!;
        const headingLevel = (sectionMatch[1].match(/^(#{1,3})\s/) ?? ['', '#'])[1].length;
        const afterHeading = sectionStart + sectionMatch[0].length;
        // Use tokenizeHeadings (fence-aware, offsets into original content) to find
        // the next milestone-boundary heading. T4 seam migration.
        const allHeadings = tokenizeHeadings(roadmapContent);
        let sectionEnd = roadmapContent.length;
        for (const h of allHeadings) {
          if (h.offset < afterHeading) continue;
          if (h.level > headingLevel) continue;
          if (/^Phase\s+\S/i.test(h.text)) continue;
          if (!/v\d+\.\d+|✅|📋|🚧/i.test(h.text)) continue;
          sectionEnd = h.offset;
          break;
        }

        const currentSection = roadmapContent.slice(sectionStart, sectionEnd);
        roadmap = currentSection;
      }
    }

    // Use tokenizeHeadings (fence-aware) instead of stripFencedLines + regex.
    // T4 seam migration: phase headings inside fences are excluded automatically.
    // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
    // #612: the 14th selected read. This scan feeds the DISK-side milestone
    // filter, and on a bracket ROADMAP it collected nothing — so the filter
    // degraded to pass-all and buildStateFrontmatter counted every other
    // milestone's directories, making the bracket convention strictly worse than
    // the M-NN one it supersedes on the property that matters most here: totals
    // must track the ROADMAP, not the disk. Resolved lazily; `phaseIdConvention`
    // is honoured when the caller already has it.
    headingConvention = phaseIdConvention === undefined
      ? resolvePhaseIdConvention(cwd)
      : phaseIdConvention;
    // #612: `capturing` puts the bracket id in group 1, so the token moves to
    // group 1+bg — the same offset idiom the two sibling counters spell
    // (validate.cts:218, state.cts:1752). A non-bracket convention ignores
    // `capturing` inside phaseHeadingPrefixSrcFor and compiles the base source
    // with zero added groups, so bg is 0 and every index below is unmoved.
    // The bracket id is what makes the DIR side able to scope: READING-B puts
    // the milestone in the bracket, so the token alone (`01`) cannot tell this
    // milestone's phase 01 from the previous milestone's.
    const capturing = headingConvention === 'bracket';
    const bg = capturing ? 1 : 0;
    const phaseHeadingPattern = new RegExp(
      `^${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.ANY_BRACKET, headingConvention, capturing)}([\\w][\\w.-]*)(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:`,
      'i',
    );
    for (const h of tokenizeHeadings(roadmap)) {
      if (h.level < 2 || h.level > 4) continue;
      const pm = phaseHeadingPattern.exec(h.text);
      if (!pm) continue;
      const bracketId = bg ? pm[1] : undefined;
      const token = pm[1 + bg];
      // #612 READING-B: a bracket heading carries its sentinel in the BRACKET,
      // so `### [GSD.999] 01:` is an icebox item even though its token is `01`.
      // Composed with — not substituted for — the legacy token rule, exactly as
      // buildStateFrontmatter and cmdStateSync compose it, so this filter's
      // phaseCount cannot disagree with the counters it is scoping for.
      if (bracketId && isSentinelPhaseId(`${bracketId}-${token}`, 'bracket')) continue;
      // Exclude 999.x backlog phases from milestone phase set. Mirrors init.cts filter.
      if (/^999\b/.test(token)) continue;
      milestonePhaseNums.add(token);
      // #612: a QUALIFIED key is formed only for a token that is itself a bracket
      // phase token. `${bracketId}-${token}` is a string SPLICE, so a
      // mid-migration heading carrying an M-NN label — `### [GSD.02] Phase 02-01:`
      // — spliced to `GSD.02-02-01`, which BRACKET_QUALIFIED_KEY_RE reads as
      // milestone 02 / phase 02: the trailing `-01` is silently truncated, both
      // such headings collapse to the one key `GSD.2-2`, and the heading then
      // claimed `GSD.02-02-two` — the directory it does NOT name — while
      // rejecting `GSD.02-01-one`, the one it does. Skipping the key leaves the
      // heading to the unqualified legacy path below, which is byte-identical to
      // base on this shape.
      //
      // The token still enters milestonePhaseNums, exactly as it does at base, so
      // `roadmapUsesHyphenedIds` below still flips for this shape. That is
      // deliberate, and it is what keeps the shape base-equivalent: base matches
      // `[GSD.02] Phase 02-01:` through the un-widened `(?:\[…\]\s*)?Phase\s+`
      // alternative and puts the same hyphenated token into the same set. The
      // isolation described where milestoneQualifiedIds is declared is therefore
      // narrower than it reads — it keeps QUALIFIED IDS out of that flag's input,
      // not hyphens in general.
      if (bracketId && !token.includes('-')) milestoneQualifiedIds.add(`${bracketId}-${token}`);
    }
    // #2199: also count bullet/checkbox phase entries (`- [ ] **Phase N — name**`)
    // so a bullet-house-style ROADMAP populates the milestone phase set instead of
    // collapsing to a zero-count pass-all filter.
    {
      let bm: RegExpExecArray | null;
      const scanner = new RegExp(BULLET_PHASE_LINE_PATTERN.source, 'gim');
      while ((bm = scanner.exec(roadmap)) !== null) {
        if (!/^999\b/.test(bm[1])) milestonePhaseNums.add(bm[1]);
      }
    }
  } catch {
    /* best-effort (#2245 audit): the real throw source is platformReadSync
     * at the top of this try (re-throws for a non-ENOENT read failure). On
     * any failure milestonePhaseNums stays empty, which below already
     * degrades to the same pass-all filter this function returns when a
     * ROADMAP genuinely has zero recognizable phase headings — a safe,
     * non-corrupting (over-inclusive, never under-inclusive) degrade. */
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
  // #2043: milestone-prefixed sub-phase components must be zero-padded — so a
  // single-digit slug word after the phase
  // number (e.g. dir "46-6-rs-…") captures "46" and is not silently excluded from
  // the milestone as a bogus "46-6" id. #2232: the continuation width is exactly 2
  // (PHASE_CONTINUATION_SEGMENT_SOURCE), so a year-leading slug word (dir
  // "14-2026-photos-…") captures "14" and is not excluded as a bogus "14-2026" id.
  // Built via new RegExp (no /i — the [A-Za-z] letter class does real case handling).
  const numericRe = roadmapUsesHyphenedIds
    ? new RegExp(
        `^0*(\\d+(?:-${phaseIdModule.PHASE_CONTINUATION_SEGMENT_SOURCE})*[A-Za-z]?(?:\\.\\d+)*)`,
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
    const customMatch = dirName.match(/^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)/);
    if (customMatch && normalized.has(customMatch[1].toLowerCase())) return true;
    const stripped = stripProjectCodePrefix(dirName);
    if (stripped !== dirName) {
      const sm = stripped.match(numericRe);
      if (sm && normalized.has(normalizePhaseIdSegments(sm[1]).toLowerCase())) return true;
    }
    return false;
  }
  (isDirInMilestone as MilestonePhaseFilter).phaseCount = milestonePhaseNums.size;
  (isDirInMilestone as MilestonePhaseFilter).missingExplicitVersion = missingExplicitVersion;
  (isDirInMilestone as MilestonePhaseFilter).versionScoped = versionScoped;
  (isDirInMilestone as MilestonePhaseFilter).versionSectionFound = versionSectionFound;
  return isDirInMilestone as MilestonePhaseFilter;
}

/**
 * #2200: raw [start,end) offsets of the current milestone's region(s) in ROADMAP
 * content, for scoping write-path mutations (phase-checkbox flip, Plans-count
 * writer) so they cannot touch a backticked prose literal, a Backlog entry, or a
 * same-numbered phase in a shipped milestone.
 *
 * Mirrors the region selection in `extractCurrentMilestone` (version detection →
 * active heading → next milestone boundary → optional Phase Details section).
 * Returns null when there is no versioned active milestone; callers then fall
 * back to whole-content mutation (the prior behaviour).
 *
 * NOTE: keep the region logic here in sync with extractCurrentMilestone.
 *
 * #2761 (round-2 review, Minor 3 — latent, currently harmless): this function
 * did NOT receive the bracket boundary fixes above (B1's same-milestone
 * exclusion, B2's content discriminator, or the bracket-fallback SELECTION
 * branch itself — this function returns null outright when the version-string
 * match finds nothing, unlike extractCurrentMilestone's bracket fallback).
 * `extractCurrentMilestone` can therefore now scope a bracket ROADMAP this
 * function still calls unscoped. Probed and confirmed harmless TODAY: this
 * function's single consumer (`mutateMilestonePhase`, src/phase.cts) falls
 * back to whole-content mutation when it returns null, and every mutation
 * inside that caller is still `Phase`-labelled-only (not bracket-widened) per
 * the changeset's own "READ-path opt-in until the migrator and write path
 * land" — so a bracket ROADMAP's checkbox/heading patterns never match inside
 * that fallback and nothing is mutated cross-milestone. The moment the write
 * path is widened (PR-3+), this divergence becomes live: the whole-content
 * fallback would become a cross-milestone writer, which is exactly what this
 * NOTE has always existed to prevent. Bracket-widen this function in lockstep
 * with the write path landing, not before.
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

  const escapedVersion = escapeRegex(version);
  const sectionPattern = new RegExp(
    `(^#{1,3}\\s+(?!Phase\\s+\\S).*${escapedVersion}\\b[^\\n]*)`,
    'gmi',
  );
  const headingMatches = [...content.matchAll(sectionPattern)];
  if (headingMatches.length === 0) return null;

  const isClosed = isClosedMilestoneHeading;
  const firstMatch = headingMatches[0];
  const selected = headingMatches.find((m) => !isClosed(m[1])) || firstMatch;
  const sectionStart = selected.index ?? 0;

  const computeSectionEnd = (headingText: string, headingStart: number): number => {
    const level = (headingText.match(/^(#{1,3})\s/) ?? ['', '#'])[1].length;
    const afterHeading = headingStart + headingText.length;
    for (const h of tokenizeHeadings(content)) {
      if (h.offset <= headingStart) continue;
      if (h.offset < afterHeading) continue;
      if (h.level > level) continue;
      if (/^Phase\s+\S/i.test(h.text)) continue;
      if (!/v\d+\.\d+|✅|📋|🚧/i.test(h.text)) continue;
      return h.offset;
    }
    return content.length;
  };
  const sectionEnd = computeSectionEnd(selected[0], sectionStart);

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
    details = { start: detailsStart, end: computeSectionEnd(detailsMatch[0], detailsStart) };
  }

  return { primary: { start: sectionStart, end: sectionEnd }, details };
}

export = {
  stripShippedMilestones,
  extractCurrentMilestone,
  isMilestoneShippedInRoadmap,
  replaceInCurrentMilestone,
  getRoadmapPhaseInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  currentMilestoneRawRanges,
  withPhaseSection,
};

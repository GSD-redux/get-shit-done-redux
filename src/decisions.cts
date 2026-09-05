/**
 * Shared parser for CONTEXT.md <decisions> blocks (ADR-457 build-at-publish:
 * the hand-written bin/lib/decisions.cjs collapsed to a TypeScript source of
 * truth). Behaviour is preserved byte-for-behaviour from the prior hand-written
 * .cjs; only types are added.
 *
 * Accepts both numeric (D-42) and alphanumeric (D-INFRA-01) IDs.
 * Returns {id, text, category, tags, trackable} per decision.
 * CJS callers that only use {id, text} safely ignore the extra fields.
 *
 * ADR-1372 T1: rewritten to adopt the markdown-sectionizer seam.
 * - `stripFencedCode` → seam's `stripFencedCode` (CommonMark-correct)
 * - `extractDecisionsBlock` → seam's `extractTaggedBlocks(content,'decisions')`
 * - Markdown-header fallback → seam's `collectSection(content, /decisions?/i, ...)`
 * - Outer bullet loop → seam's `iterateBullets` (for the header-fallback path)
 *
 * Resolves #1364 (markdown-header + em-dash recall) and #1365 (fail-loud gate).
 */

import {
  stripFencedCode,
  extractTaggedBlocks,
  collectSection,
} from './markdown-sectionizer.cjs';
import { indentWidth } from './token-scanner.cjs';

export interface Decision {
  id: string;
  text: string;
  category: string;
  tags: string[];
  trackable: boolean;
}

/**
 * Typed extraction result distinguishing three states the blocking gate cares about:
 * - 'parsed'         — ≥1 decision was successfully extracted
 * - 'none-present'   — content has no decision signals; nothing to check
 * - 'could-not-parse'— content is decision-shaped (has a <decisions> block, a
 *                      /decisions?/i heading, a \bD- token, or an unterminated fence)
 *                      yet 0 decisions were extracted → format mismatch, fail-loud
 */
export type DecisionOutcome = 'parsed' | 'none-present' | 'could-not-parse';

export interface DecisionExtraction {
  decisions: Decision[];
  outcome: DecisionOutcome;
}

const DISCRETION_HEADINGS = new Set([
  "claude's discretion",
  'claudes discretion',
  'claude discretion',
]);
const NON_TRACKABLE_TAGS = new Set(['informational', 'folded', 'deferred']);

// ─── Bullet parsers (decisions-specific grammar) ─────────────────────────────

/**
 * Colon form: `- **D-NN[ [tags]]:** text`
 * (#1343: `[^:*]*` subsumes any pre-colon prose, stops at `:**`)
 */
const bulletColonRe = /^\s*-\s+\*\*D-([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s*\[([^\]]+)\])?[^:*]*:\*\*\s*(.*)$/;

/**
 * Em-dash form: `- **D-NN[ [tags]] — title** body`
 * The em-dash (U+2014) or its lookalike separates the ID+tags group from a title
 * that lives inside the bold markers; the body (which may be empty) follows
 * outside the closing `**`. This form was not handled pre-T1 (bug #1364).
 *
 * Accepts both U+2014 em-dash (—) and U+2013 en-dash (–) for robustness.
 */
const bulletEmDashRe = /^\s*-\s+\*\*D-([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s*\[([^\]]+)\])?[^*]*[—–][^*]*\*\*\s*(.*)$/;

/**
 * Titled-colon form: `- **D-NN[ [tags]]: Title.** body`
 * A title sits between the colon and the closing `**` (so the `:**` anchor of
 * bulletColonRe fails, and there is no em-dash for bulletEmDashRe). This is a strict
 * superset of the colon-immediate form, so it MUST be checked AFTER bulletColonRe and
 * bulletEmDashRe — it only catches bullets those two miss. The title run is `[^:*]*` (no
 * colon, no `*`) so a genuinely-malformed bullet with a colon in the pre-separator run
 * (e.g. `D-07 ratio 3:1:**`) still fails the anchor and falls through to the parse-miss
 * guard — matching bulletColonRe's `[^:*]*` discipline that the separator colon is the
 * only colon permitted before `**`. (#1639)
 */
const bulletTitledColonRe = /^\s*-\s+\*\*D-([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s*\[([^\]]+)\])?[^:*]*:[^:*]*\*\*\s*(.*)$/;

/**
 * #2347: format-agnostic evidence that a block/section holds real decision
 * ENTRIES the parser could not read — a bullet whose bold lead-in is an
 * ID-SHAPED token (uppercase prefix, optional digits, hyphen, alnum), whatever
 * the exact ID grammar. The three parser grammars above all require a `D-`
 * prefix; #1365's fail-loud guard reused that same `\bD-` test as its "is this
 * decision-shaped?" evidence, so any other prefix (e.g. `D5-01`) was invisible
 * to BOTH parser and guard, collapsing `could-not-parse` into a clean
 * `none-present` pass.
 *
 * The ID-shape requirement (not "any bold bullet") is deliberate: a decisions
 * block or `### Claude's Discretion` sub-section legitimately contains prose
 * bullets with bold labels (`- **Scope:** …`, `- **Why:** …`, `- **Note:** …`).
 * Those are NOT decision entries and must stay `none-present` — a false
 * `could-not-parse` hard-blocks the plan gate. `[A-Z]+[0-9]*-[A-Za-z0-9]` matches
 * `D-01` / `D5-01` / `DEC-01` but not `Scope:` / `Why:` / `Follow-up:` (mixed
 * case) / `TODO:` (no `-<alnum>` id) — mirroring the parser's own `D-<alnum>`
 * shape without hardcoding the `D`.
 */
const boldLeadInBulletRe = /^\s*-\s+\*\*[A-Z]+[0-9]*-[A-Za-z0-9]/m;

/**
 * #3939: a decision bullet's DECLARATION line — the `- **D-NN … **` bold lead-in
 * the three grammars above anchor on — may wrap across a line break. Physical
 * line breaks inside a bullet are markdown-insignificant, and GSD's own
 * discuss-phase writer emits the wrapped shape whenever a decision title runs
 * past the wrap column. All three grammars require the closing `**` in the same
 * string as the `- **D-` anchor, so a wrapped declaration matched none of them
 * and fell to the #1365 parse-miss guard, forcing `could-not-parse` (which
 * hard-blocks `check.decision-coverage-plan`) on a well-formed CONTEXT.md.
 *
 * The repair is confined to how the LOGICAL bullet is assembled — the grammars
 * themselves are untouched, so every single-line form parses exactly as before.
 */
const decisionBulletStartRe = /^\s*-\s+\*\*D-/;

/**
 * A line that opens a new BLOCK-LEVEL construct, and therefore terminates the
 * bullet above it: a list marker of any family (`-`, `*`, `+`, `1.`, `1)`), an
 * ATX heading, a blockquote, or a table row. Joining never reaches across one of
 * these (nor across a blank/whitespace-only line, checked separately), so a
 * declaration whose bold run genuinely never closes cannot absorb the block
 * below it and get "closed" by an unrelated inline `**` — it stays a parse-miss
 * and still fails loud, which #1365's contract requires.
 *
 * The four MARKER families demand trailing whitespace so that a continuation
 * line opening with emphasis (`*in* the header.** …`) is text, not a bullet.
 * The table-row alternative deliberately does not: CommonMark tables may open
 * flush (`|Col1|Col2|`), and a leading `|` is never ordinary decision prose.
 * A `- ` line at ANY indent stops the join: a deeper one is #3169 nested
 * elaboration, which the main loop folds into the open decision itself.
 *
 * DELIBERATE DIVERGENCE from the sectionizer seam (ADR-1372): `iterateBullets`
 * recognises only the `N. ` ordered-list form (`numberedRe`,
 * src/markdown-sectionizer.cts), while this set also stops at the `N) ` form.
 * That is intentional and one-directional — this regex answers "may the join
 * cross this line?", where recognising MORE block openers is the conservative
 * answer (a missed terminator can manufacture a decision; a spare one can only
 * make a malformed bullet fail loud, which #1365 already wants). `N)` is a
 * CommonMark ordered-list marker, so a join must not reach across it whether or
 * not the seam's own bullet iterator yields it. Both forms are pinned by tests,
 * and a drift test asserts the seam still does NOT treat `N)` as a bullet, so
 * this divergence stays visible if either side moves.
 *
 * Accepted over-termination: continuation prose that happens to open with
 * digits-then-`.`/`)` ("10. really keeps going") or a literal `|` stops the join
 * early, so such a bullet fails loud rather than parsing. That is the same
 * markdown ambiguity every line-oriented reader carries, and this direction of
 * the trade is the one #1365 asks for — fail loud, never guess.
 */
const blockConstructRe = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>\s|\|)/;

/**
 * The id-adjacent `[tags]` REGION of a logical bullet, as far as it has been
 * assembled. Matching means the region is still unsettled, in one of two ways:
 * capture group 1 is present when the bracket is open (group 1 is the content
 * seen so far), and absent when the id has been read but no `[` has followed
 * yet — so a bracket may still open on the next absorbed line.
 *
 * A NON-match means the region is settled for good: the bracket closed, or
 * something other than `[` followed the id. Either way the join no longer has
 * to watch for a splice.
 *
 * The id character class is deliberately looser than the grammars' (it admits
 * an empty id, so a bare `- **D-` still counts as unsettled). This regex only
 * answers "may an id-adjacent bracket still open here?", where recognising MORE
 * shapes is the conservative direction: an over-broad match can only make a
 * malformed bullet fail loud, while a missed one silently re-classifies.
 *
 * Only the ID-ADJACENT bracket matters: that is the one the three grammars turn
 * into `tags` (and therefore into `trackable`). A `[` further along the title is
 * ordinary text and does not restrict the join.
 */
const tagRegionRe = /^\s*-\s+\*\*D-[A-Za-z0-9_-]*\s*(?:\[([^\]]*))?$/;

/**
 * #3939 (review): would folding `next` onto a lead-in whose `[tags]` bracket is
 * still open splice the inserted space INTO a tag token?
 *
 * Tags are comma-split and trimmed, so a space landing next to a delimiter
 * (`[`, `,`, `]`) changes nothing — `[informational,` + `deferred]` is still
 * exactly `[informational, deferred]`. A space landing anywhere else splits one
 * token into two (`[defer` + `red]` → `defer red`), which would not fail; it
 * would parse to a DIFFERENT tag, silently flipping `trackable` on a gate that
 * decides whether a decision must be covered. Refusing to join there leaves the
 * bullet unchanged, so it reaches the #1365 parse-miss guard and fails loud —
 * a wrong answer about coverage is worse than a blocked gate.
 *
 * `tail` is the bracket content accumulated so far, `next` the trimmed
 * continuation line.
 */
function wouldSpliceTagToken(tail: string, next: string): boolean {
  const before = tail.trimEnd();
  if (before === '' || before.endsWith(',') || before.endsWith('[')) return false;
  return !(next.startsWith(',') || next.startsWith(']'));
}

/**
 * True when the bullet's own bold lead-in — the FIRST bold run on the line —
 * is still open at end-of-line. Deliberately asks only about that first run
 * (not `**`-parity over the whole string), because that is the run the three
 * grammars anchor on: a balanced inline `**bold**` later in the body must not
 * make a terminated lead-in look open.
 */
function boldLeadInIsUnterminated(text: string): boolean {
  const open = text.indexOf('**');
  if (open === -1) return false;
  return text.indexOf('**', open + 2) === -1;
}

/**
 * Fold a decision bullet whose bold lead-in wraps into ONE logical line, so the
 * declaration grammars see the whole lead-in (#3939).
 *
 * Bounded and fail-loud-preserving: a wrapped declaration absorbs following
 * lines only until its lead-in closes, and a blank/whitespace-only line, a new
 * block-level construct (`blockConstructRe`), or the end of the block stops it.
 * If the lead-in never closes, the original line is emitted UNCHANGED — a
 * genuinely malformed bullet (e.g. an unterminated bold run) still reaches the
 * parse-miss guard and still fails loud, exactly as #1365 requires. Non-decision
 * lines pass through untouched, so continuation lines (#1372 FIX) and nested
 * cross-reference bullets (#3169) are handled by the main loop as before.
 *
 * The joined line keeps the FIRST physical line's leading whitespace, so the
 * `indentWidth` signal #3169 depends on is unchanged. Absorbed lines are
 * trimmed and re-joined with a single space, which is what a soft line break
 * means in markdown — so the join reproduces the rendered one-line text rather
 * than concatenating the raw bytes.
 *
 * One place that equivalence does not hold is inside the id-adjacent `[tags]`
 * bracket, where an inserted space can split a tag token and silently flip
 * `trackable`. The join stops there instead (`wouldSpliceTagToken`), leaving the
 * bullet to fail loud.
 *
 * Absorption stops at the first `**` on a continuation line, so an inline
 * `**bold**` INSIDE a wrapped title closes the run early. That is deliberate:
 * the result is byte-identical to what the same bullet written on one physical
 * line parses to (the text past the early close re-attaches through the main
 * loop's continuation folding), which is the whole contract here — wrapping is
 * markdown-insignificant, never a second grammar.
 */
function joinWrappedBoldLeadIns(lines: string[]): string[] {
  const joined: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!decisionBulletStartRe.test(line) || !boldLeadInIsUnterminated(line)) {
      joined.push(line);
      continue;
    }

    // Absorbed lines accumulate as SEGMENTS joined by a single space, and each
    // new segment is searched on its own: the lead-in is known to be open at the
    // end of the declaration line, and the inserted space means a closing `**`
    // can never straddle a segment boundary, so the first `**` in any later
    // segment is the close. Scanning per segment (rather than re-searching the
    // accumulated string, which forces a rope flatten every iteration) keeps a
    // long unterminated run linear on the plan gate's hot path.
    const segments = [line];
    // Bracket content accumulated while the id-adjacent `[tags]` bracket is
    // still open; null when it is not open. O(1) per segment.
    let tagTail: string | null = null;
    // The logical text assembled so far, kept ONLY while the id-adjacent
    // bracket has yet to open, so a bracket that opens on ANY absorbed line
    // arms the splice guard — not just one that opens on the declaration line.
    // Null once the region settles (the bracket opened and `tagTail` took over,
    // or the id was followed by something else), so this never re-walks a long
    // absorption: a non-empty segment that is not a bracket-open settles the
    // region immediately, which bounds the string to a single extra join.
    let tagRegion: string | null = null;
    const declRegion = tagRegionRe.exec(line);
    if (declRegion !== null) {
      if (declRegion[1] === undefined) tagRegion = line;
      else tagTail = declRegion[1];
    }
    let scan = i + 1;
    let closed = false;
    while (scan < lines.length) {
      const trimmed = lines[scan].trim();
      if (trimmed === '' || blockConstructRe.test(trimmed)) break;
      if (tagTail !== null && wouldSpliceTagToken(tagTail, trimmed)) break;
      segments.push(trimmed);
      scan += 1;
      if (tagTail !== null) {
        tagTail = trimmed.indexOf(']') === -1 ? trimmed : null;
      } else if (tagRegion !== null) {
        tagRegion = `${tagRegion} ${trimmed}`;
        const opened = tagRegionRe.exec(tagRegion);
        if (opened === null) tagRegion = null;
        else if (opened[1] !== undefined) {
          tagTail = opened[1];
          tagRegion = null;
        }
      }
      if (trimmed.indexOf('**') !== -1) {
        closed = true;
        break;
      }
    }

    if (closed) {
      joined.push(segments.join(' '));
      i = scan - 1;
    } else {
      joined.push(line);
    }
  }

  return joined;
}

interface ParseDecisionLinesResult {
  decisions: Decision[];
  parseMisses: number;
}

/**
 * Parse decision lines from a block of text (the inner text of a <decisions>
 * or markdown-header section body). Returns the extracted decisions and a count
 * of parse-misses (lines that looked like D-NN bullets but failed both regexes).
 *
 * FIX B (#1365): parseMisses > 0 means the caller must treat the result as
 * could-not-parse even when some decisions were extracted — a silent drop is
 * worse than a fail-loud signal.
 *
 * #3939: physical lines are folded into logical bullets first, so a declaration
 * whose bold lead-in wraps is matched as the one bullet it is.
 */
function parseDecisionLines(block: string): ParseDecisionLinesResult {
  const lines = joinWrappedBoldLeadIns(block.split(/\r?\n/));
  const out: Decision[] = [];
  let category = '';
  let inDiscretion = false;
  let current: Decision | null = null;
  let openIndent: number | null = null;
  let parseMisses = 0;

  const flush = (): void => {
    if (current) {
      current.text = current.text.trim();
      out.push(current);
      current = null;
      openIndent = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Track category headings (`### Heading`)
    const headingMatch = trimmed.match(/^###\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      category = headingMatch[1];
      // Strip the full unicode-quote family so any rendering of "Claude's
      // Discretion" (ASCII apostrophe, curly U+2019 ’, U+2018 ‘,
      // U+201A, U+201B, double-quote variants U+201C/D/E/F, etc.) collapses
      // to the same key (FIX C + review F20).
      const normalized = category
        .toLowerCase()
        .replace(/[‘’‚‛“”„‟''"`]/g, '')
        .trim();
      inDiscretion = DISCRETION_HEADINGS.has(normalized);
      continue;
    }

    // Nested bullet under an open decision (#3212 Phase 3, #3169): a bullet
    // indented deeper than the currently-open decision's own bullet is that
    // decision's elaboration (e.g. a cross-reference to a sibling decision),
    // not a fresh declaration attempt — fold it into current.text exactly
    // like a continuation line, before it ever reaches the declaration/
    // parse-miss regexes below. A bullet at the SAME or a SHALLOWER indent
    // is unaffected — tested exactly as before this fix. See design doc
    // .gsd/phase/chore-3414-tokenizer-first-seam/40-design.md §1.3 for why
    // nesting depth, not bullet content, is the signal that distinguishes
    // this from a genuinely malformed top-level declaration.
    if (
      current &&
      openIndent !== null &&
      trimmed.startsWith('-') &&
      indentWidth(line) > openIndent
    ) {
      current.text += ' ' + trimmed;
      continue;
    }

    // Colon form: `- **D-NN[ [tags]]:** text`
    const colonMatch = line.match(bulletColonRe);
    if (colonMatch) {
      flush();
      const id = `D-${colonMatch[1]}`;
      const tags = colonMatch[2]
        ? colonMatch[2].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
        : [];
      const trackable = !inDiscretion && !tags.some((t) => NON_TRACKABLE_TAGS.has(t));
      current = { id, text: colonMatch[3], category, tags, trackable };
      openIndent = indentWidth(line);
      continue;
    }

    // Em-dash form: `- **D-NN[ [tags]] — title** body`
    const emDashMatch = line.match(bulletEmDashRe);
    if (emDashMatch) {
      flush();
      const id = `D-${emDashMatch[1]}`;
      const tags = emDashMatch[2]
        ? emDashMatch[2].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
        : [];
      const trackable = !inDiscretion && !tags.some((t) => NON_TRACKABLE_TAGS.has(t));
      // The body (emDashMatch[3]) may be empty for the pure title form; the
      // title itself is embedded in the bold run but we report the body as text
      // (consistent with how the gate cares only about coverage, not title/body split).
      current = { id, text: emDashMatch[3] || '', category, tags, trackable };
      openIndent = indentWidth(line);
      continue;
    }

    // Titled-colon form: `- **D-NN[ [tags]]: Title.** body` (#1639). Checked LAST — it is
    // a strict superset of bulletColonRe, so it only catches bullets the colon-immediate
    // and em-dash forms missed (minimal blast radius). id + [tags] trackability honored;
    // the body after the closing bold run is reported as text.
    const titledColonMatch = line.match(bulletTitledColonRe);
    if (titledColonMatch) {
      flush();
      const id = `D-${titledColonMatch[1]}`;
      const tags = titledColonMatch[2]
        ? titledColonMatch[2].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
        : [];
      const trackable = !inDiscretion && !tags.some((t) => NON_TRACKABLE_TAGS.has(t));
      current = { id, text: titledColonMatch[3] || '', category, tags, trackable };
      openIndent = indentWidth(line);
      continue;
    }

    // Parse-miss guard (FIX B + #1343): a line that looks like a `D-NN` decision
    // bullet but failed both patterns — flush, warn, and record the miss.
    // parseMisses > 0 forces could-not-parse even when other decisions parsed.
    if (/^\s*-\s+\*\*D-/.test(line)) {
      flush();
      parseMisses += 1;
      console.warn(`parseDecisions: ignored unparseable decision bullet: ${trimmed}`);
      continue;
    }

    // Continuation line for current decision (indented with space OR tab,
    // non-bullet, non-empty) — tab indentation must work too (review F12).
    if (current && trimmed !== '' && !trimmed.startsWith('-') && /^[ \t]/.test(line)) {
      current.text += ' ' + trimmed;
      continue;
    }

    // Blank line or unrelated content terminates the current decision
    if (trimmed === '') {
      flush();
    }
  }
  flush();
  return { decisions: out, parseMisses };
}

// ─── Primary entry point: extractDecisions ────────────────────────────────────

/**
 * Extract decisions from CONTEXT.md content with a typed outcome.
 *
 * Strategy (in priority order):
 * 1. If the content (fence-stripped) contains `<decisions>...</decisions>` blocks,
 *    parse ONLY those blocks (canonical form; markdown-header content outside blocks
 *    is ignored when a block is present — existing behavior preserved).
 * 2. Otherwise, look for a /decisions?/i heading and collect its section body.
 *    This is the T1 recall fix for #1364.
 * 3. If neither is found, return outcome based on decision-shape heuristics.
 */
export function extractDecisions(content: unknown): DecisionExtraction {
  if (!content || typeof content !== 'string') {
    return { decisions: [], outcome: 'none-present' };
  }

  // Apply fence-stripping for block extraction (prevents example blocks inside
  // ``` fences from polluting the parser — review F11).
  const { text: stripped, unterminatedFence } = stripFencedCode(content);

  // ── Path 1: <decisions> blocks present ──────────────────────────────────────
  const taggedBlocks = extractTaggedBlocks(stripped, 'decisions');
  if (taggedBlocks.length > 0) {
    const combined = taggedBlocks.join('\n\n');
    const { decisions, parseMisses } = parseDecisionLines(combined);
    if (decisions.length > 0 && parseMisses === 0) {
      return { decisions, outcome: 'parsed' };
    }
    // FIX B: parse-misses present — could-not-parse even if some decisions extracted.
    if (parseMisses > 0) {
      return { decisions, outcome: 'could-not-parse' };
    }
    // FIX A: Block present but 0 extracted and no parse-misses.
    // Only report could-not-parse when there is genuine evidence of real decisions
    // that failed to parse: a bold-lead-in bullet (`- **…**`, any ID grammar — #2347),
    // a \bD- token in the block text, or an unterminated fence. An empty scaffold
    // (<decisions></decisions>) or an all-prose block has no such evidence — treat
    // as none-present so the gate passes cleanly.
    const hasDecisionTokenInBlock = /\bD-[A-Za-z0-9]/m.test(combined);
    const hasBoldLeadInBullet = boldLeadInBulletRe.test(combined);
    if (hasDecisionTokenInBlock || hasBoldLeadInBullet || unterminatedFence) {
      return { decisions: [], outcome: 'could-not-parse' };
    }
    return { decisions: [], outcome: 'none-present' };
  }

  // ── Path 2: markdown-header fallback (#1364 fix) ─────────────────────────────
  // Use the seam's collectSection to find a /decisions?/i heading section.
  // levelBounded:true → stop at next same-or-higher-level heading.
  // stripFences:true → inner fences inside the section body are stripped.
  const section = collectSection(
    content,
    (h) => /decisions?\b/i.test(h.text),
    { levelBounded: true, stripFences: true },
  );

  if (section !== null) {
    const { decisions, parseMisses } = parseDecisionLines(section.body);
    if (decisions.length > 0 && parseMisses === 0) {
      return { decisions, outcome: 'parsed' };
    }
    // FIX B: parse-misses present — could-not-parse even if some decisions extracted.
    if (parseMisses > 0) {
      return { decisions, outcome: 'could-not-parse' };
    }
    // FIX A: Heading found but 0 extracted and no parse-misses.
    // Report could-not-parse when the section body holds a decision-entry-shaped
    // bold-lead-in bullet (`- **…**`, any ID grammar — #2347) or a D- token. A
    // heading with only prose, sub-headings, or all-discretion content (no such
    // evidence) is a legitimate empty/discretion section → none-present.
    const hasDecisionTokenInSection = /\bD-[A-Za-z0-9]/m.test(section.body);
    const hasBoldLeadInBulletInSection = boldLeadInBulletRe.test(section.body);
    if (hasDecisionTokenInSection || hasBoldLeadInBulletInSection) {
      return { decisions: [], outcome: 'could-not-parse' };
    }
    return { decisions: [], outcome: 'none-present' };
  }

  // ── Path 3: no blocks, no heading ────────────────────────────────────────────
  // Apply shape heuristics to distinguish none-present from could-not-parse.
  // We re-use the already-computed unterminatedFence and check for D- tokens.
  const hasDecisionToken = /\bD-[A-Za-z0-9]/m.test(stripped);
  if (unterminatedFence || hasDecisionToken) {
    return { decisions: [], outcome: 'could-not-parse' };
  }

  return { decisions: [], outcome: 'none-present' };
}

// ─── parseDecisions: thin delegate (backwards-compatible entry point) ─────────

/**
 * Parse trackable decisions from CONTEXT.md content.
 *
 * Thin delegate over extractDecisions — callers receive the decisions array
 * exactly as before; nothing breaks. Use extractDecisions directly when the
 * outcome enum is needed (e.g. for the fail-loud gate logic).
 *
 * Returns ALL D-NN decisions found (including non-trackable ones, with
 * `trackable: false`). Callers that only want the gate-enforced decisions
 * should filter `.filter(d => d.trackable)`.
 */
export function parseDecisions(content: unknown): Decision[] {
  return extractDecisions(content).decisions;
}

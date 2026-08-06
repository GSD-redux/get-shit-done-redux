/**
 * Workflow Fragments — in-file `<!-- gsd:section -->` marker parser/composer
 * for GSD workflow markdown files (ADR-1671 epic #1671, Phase 3 / issue #2930,
 * `.gsd/phase/chore-2930-fragmentize-xl-workflow/40-design.md`).
 *
 * Pure module: no I/O, no dependency beyond node built-ins and the shared
 * budget-trim seam `context-composer.cjs` (issue #2929). Emission order is
 * `parseWorkflowSections` -> `toFragments` -> `composeWithinBudget` ->
 * `renderFragments` (= `composeWorkflow`), run BEFORE the per-runtime
 * converters so a marker attribute never reaches a path-rewrite regex.
 *
 * ## Marker grammar (CLOSED)
 *
 * Open:  a line whose only content (after trimming leading/trailing
 *        whitespace) is `<!-- gsd:section id="<id>" when="<when>" -->`.
 * Close: a line whose only content is `<!-- /gsd:section -->`.
 *
 * Attribute order is free and inner spacing is flexible (Postel on FORMAT);
 * `id` and `when` VALUES are validated strictly and fail closed (Postel is
 * deliberately NOT applied to semantics — an unrecognized `when` is an
 * authoring instruction that must never be silently dropped). `id` matches
 * `/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/`; `when` must be `===` exactly one
 * entry of the frozen {@link WHEN_VOCABULARY} — no operators, no negation,
 * no nesting (Greenspun's Tenth Rule: extending the vocabulary is a
 * coordinated ADR amendment, never an organic edit).
 *
 * ## Partition invariant
 *
 * `parseWorkflowSections` returns sections that PARTITION the document:
 * every byte that is not part of a marker LINE belongs to exactly one
 * section, in document order. Text outside any marker pair becomes a
 * synthesized gap section (`explicit: false`, id `gap-<n>`, n from 0). A
 * marker line is removed IN FULL — text and its original line terminator —
 * so an unmarked document (88 of 89 workflows today) parses to exactly one
 * implicit gap fragment and composes back byte-identical.
 *
 * Line splitting is CRLF-aware per line (not `content.split('\n')`, which
 * would leave a stray `\r` glued to `.text` and cannot express a mixed
 * CRLF-marker/LF-body document): {@link splitLinesPreservingEol} records
 * each line's own terminator (`''`, `'\n'`, or `'\r\n'`) so reassembly is
 * exact regardless of line-ending mixture.
 *
 * ## Fence + comment interleaving (the highest-risk code here)
 *
 * A marker is structural only when it is NOT inside a fenced code block and
 * NOT inside an unrelated HTML comment (`<!-- gsd:loop-host ... -->` is a
 * different marker family entirely and is left untouched by construction —
 * it does not match the `gsd:section` token). Fences and comments are
 * scanned in ONE left-to-right interleaved pass with two mutually exclusive
 * states (`fence`, `inComment`), copying the discipline documented in
 * `src/context-predicates.cts`'s module comment (DEFECT.CONTEXT-PREDICATES-
 * COMMENT-FENCE-BLIND, #2928): while a fence is open, only a matching closer
 * can end it (a `<!--`/`-->` token on a fenced line is fence content, never
 * a comment boundary); while a comment is open, only a `-->` token can end
 * it (a fence delimiter inside it is comment content, never a fence
 * boundary); when neither is open, a comment opener is checked BEFORE a
 * fence opener (HTML comments are lexically outermost). A two-pass design
 * (mask one construct, then scan for the other) resolves this wrongly in
 * one direction and silently skips to EOF — that is the exact defect this
 * module avoids by construction. An unclosed fence at EOF does NOT throw;
 * everything after it is simply literal.
 *
 * One deliberate refinement beyond a naive "does the trimmed line START
 * WITH `<!--` and END WITH `-->`" check: whether a comment PERSISTS past
 * the current line is decided by `.includes('-->')` (does a close token
 * appear anywhere on the line), not by `.endsWith('-->')`. A line like
 * `<!-- TODO: fix --> some trailing prose` closes its comment on the same
 * line and must not swallow the rest of the document — it is simply not a
 * `gsd:section` marker (a marker's grammar requires the comment to be the
 * line's ONLY content), and is left as ordinary content in whichever
 * section/gap contains it.
 *
 * Known inherited limitation (shared with `context-predicates.cts`, not a
 * regression introduced here): comment-open detection is anchored to the
 * start of the trimmed line. An HTML comment that opens *mid-line* (prose
 * followed by an unclosed `<!--`) is not tracked, so a `gsd:section`-shaped
 * line appearing on a later line inside that comment would be misread as
 * real. GSD workflow markers are always authored on their own line, so this
 * does not affect the production shape; documented here rather than papered
 * over.
 *
 * ADR-457 build-at-publish: compiled by tsc to
 * gsd-core/bin/lib/workflow-fragments.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- context-composer.cjs is a CommonJS module compiled from a sibling .cts source; `import x = require()` reads its module.exports namespace directly.
import contextComposer = require('./context-composer.cjs');

/**
 * Frozen, CLOSED applicability vocabulary for the `when=` attribute.
 * Extending this list requires an ADR amendment, not an organic edit
 * (Greenspun's Tenth Rule — see the module doc comment).
 *
 * Widened from 4 to 14 entries via the ADR-1671 amendment for #2992 (epic
 * #1671 Phase 6.1; see `.gsd/phase/chore-2992-widen-when-vocabulary/
 * 40-design.md`), then from 14 to 19 via the ADR-1671 amendment for #2993
 * (epic #1671 Phase 6.2; see `.gsd/phase/chore-2993-fragmentize-plan-phase/
 * 40-design.md`), then from 19 to 20 via the ADR-1671 amendment for #2994
 * (epic #1671 Phase 6.3, `verify-work.md`), then from 20 to 23 via a further
 * #2994 amendment fragmentizing `code-review.md` and `complete-milestone.md`,
 * then from 23 to 24 via a further #2994 amendment fragmentizing
 * `autonomous.md`, then from 24 to 26 via a still further #2994 amendment
 * fragmentizing `review.md` and `discuss-phase-assumptions.md`, then from 26
 * to 30 (then 29; `flag:--full` retired as dead vocabulary) via the FINAL
 * #2994 slice (epic #1671 Phase 6.3) fragmentizing
 * `docs-update.md`, `update.md`, `transition.md`, and `new-milestone.md` —
 * every one of the 13 workflows targeted by ADR-1671 is now on the fragment
 * model. The vocabulary remains CLOSED: no operators, no negation, no nesting.
 * Cardinality is not expressiveness — a 29-entry flat list with no
 * composition is still not a language.
 *
 * Held at 14, not wider: an atom whose fact is never computed always
 * evaluates FALSE, so a section marked with it would silently never
 * include — a silent-exclusion bug, not a feature. One further atom
 * (`flag:--verify-only`) was surveyed but is NOT admitted even now that
 * `docs-update` has its own `cmdInit*` entry point (`cmdInitDocsUpdate`):
 * the flag's control flow is INTERLEAVED across three non-contiguous
 * touch-points in `docs-update.md` (an inline early-exit check in
 * `init_context` — "If `--verify-only` is present…skip to
 * verify_only_report" — a "Skip condition" note embedded in another step's
 * body, and the `verify_only_report` step itself) rather than a single
 * contiguous, whole-line, purely-additive region — admitting the atom to
 * gate only the `verify_only_report` step would leave the other two
 * touch-points as un-migrated raw `$ARGUMENTS` checks. `state:is-monorepo`
 * (`dispatch-monorepo-packages` section) IS admitted in this slice — see the
 * paragraph below.
 * `flag:--fix`, `state:fallow-enabled`, and `state:git-create-tag` were
 * withheld for the same reason until a further #2994 amendment gave
 * `code-review` and `complete-milestone` their own dedicated `cmdInit*`
 * entry points (`cmdInitCodeReview`, `cmdInitCompleteMilestone`). The
 * originally-surveyed `flag:--converge` never shipped under that name: once
 * `autonomous` gained its own dedicated `cmdInitAutonomous` entry point, the
 * admitted atom is `state:plan-strategy-converge` instead — `--cross-ai` is
 * a documented alias for `--converge` (`autonomous.md`'s own `PLAN_STRATEGY`
 * resolver folds both into one value), so a `flag:--converge`-only atom
 * would have left `--cross-ai`-only invocations silently excluded from the
 * same sections; see the `state:plan-strategy-converge` paragraph below.
 * `state:reviewer-instances-configured` and `state:auto-advance-active` were
 * withheld the same way until `review` and `discuss-phase-assumptions`
 * gained their own dedicated `cmdInit*` entry points (`cmdInitReview`,
 * `cmdInitDiscussPhaseAssumptions`).
 *
 * The #2993 widening adds 5 entries fragmentizing `plan-phase.md`:
 * `flag:--ingest`, `flag:--prd`, `flag:--research-phase`, `flag:--reviews`,
 * `state:chunked-mode`. `state:chunked-mode` is a disjunction (`--chunked`
 * flag OR `.planning/config.json` `workflow.plan_chunked`) resolved to a
 * single boolean FACT by the init seam (`src/init.cts`) — the grammar still
 * sees exactly one atom with no operator, preserving the same guard.
 *
 * The #2994 widening adds 1 entry fragmentizing `verify-work.md`:
 * `state:ui-phase-active`. Like `state:chunked-mode`, it is a disjunction —
 * the phase's active `plan:pre` loop hooks include the `ui-phase` step OR
 * the phase directory already contains a `*-UI-SPEC.md` — resolved to a
 * single boolean FACT by the init seam before it ever reaches this grammar.
 *
 * A further #2994 widening (epic #1671 Phase 6.3) adds 3 entries
 * fragmentizing `code-review.md` and `complete-milestone.md`: `flag:--fix`
 * (`dispatch-fix` section), `state:fallow-enabled` (`structural-pre-pass`
 * section — the fallow config-gate resolver, previously re-derived inside
 * the section body itself, is hoisted into `cmdInitCodeReview` and exposed
 * as top-level `fallow_*` init-bundle fields), and `state:git-create-tag`
 * (`git-tag` section — the `git.create_tag` config-gate resolver is hoisted
 * into `cmdInitCompleteMilestone`).
 *
 * A still further #2994 widening (epic #1671 Phase 6.3) adds 1 entry
 * fragmentizing `autonomous.md`: `state:plan-strategy-converge`, gating five
 * sections (`converge-fail-fast`, `converge-banner`, `converge-dispatch-bg`,
 * `converge-dispatch-inline`, `converge-loop`) that all share the same atom
 * — legal and precedented (`plan-phase.md`'s `research-only-*` pair already
 * shares `flag:--research-phase`). It is a disjunction — `--converge` OR its
 * documented alias `--cross-ai` — resolved to a single boolean FACT by the
 * new `cmdInitAutonomous` entry point (`flags.has('--converge') ||
 * flags.has('--cross-ai')`) before it ever reaches this grammar, same
 * discipline as `state:chunked-mode`/`state:ui-phase-active` above.
 *
 * A still further #2994 widening (epic #1671 Phase 6.3) adds 2 entries
 * fragmentizing `review.md` and `discuss-phase-assumptions.md`:
 * `state:reviewer-instances-configured` (`reviewer-instances-note-1` and
 * `reviewer-instances-note-2` sections — two peripheral notes sharing one
 * atom, the same sharing pattern `plan-phase.md`'s `research-only-*` pair
 * already established) and `state:auto-advance-active` (`auto-advance-dispatch`
 * section — a disjunction, `--auto` flag OR a consolidated auto-mode config
 * fact, resolved to a single boolean FACT by the new
 * `cmdInitDiscussPhaseAssumptions` entry point before it ever reaches this
 * grammar, same discipline as `state:chunked-mode` above).
 *
 * The FINAL #2994 widening (epic #1671 Phase 6.3) adds 4 entries, closing
 * out the last four workflows on ADR-1671's fragmentization list —
 * `docs-update.md`, `update.md`, `transition.md`, `new-milestone.md` — none
 * of which carried a `gsd_run query init.*` call before this slice:
 * `state:is-monorepo` (`dispatch-monorepo-packages` section, new
 * `cmdInitDocsUpdate` entry point — reuses `docs.cts`'s own
 * `detectMonorepoWorkspaces` detector rather than a second scan);
 * `state:next-channel` (`channel-banner` section, new `cmdInitUpdate` entry
 * point — `--next` OR its documented alias `--rc`, resolved in PARALLEL
 * with, not in place of, `update.md`'s own `TAG="next"` case-statement,
 * which issue #815's regression test requires to stay literal in the
 * workflow); `state:workstream-active` (`workstream-collision-check`
 * section, new `cmdInitTransition` entry point — a workstream is active,
 * `GSD_WORKSTREAM` env falling back to the stored active-workstream
 * pointer, the same authoritative source `cmdInitProgress` already uses);
 * and `state:flat-mode` (`project-md-milestone-write` section,
 * `cmdInitNewMilestone` — the positively-phrased INVERSE of
 * `state:workstream-active`, introduced because the grammar has no negation
 * operator and `new-milestone.md`'s Step 4 Part A is gated on the OPPOSITE
 * condition from `transition.md`'s section).
 */
export const WHEN_VOCABULARY: readonly string[] = Object.freeze([
  'always',
  'flag:--wave',
  'state:gap-closure-phase',
  'state:has-prior-phases',
  'flag:--auto',
  'flag:--discuss',
  'flag:--fix',
  'flag:--forensic',
  'flag:--ingest',
  'flag:--prd',
  'flag:--research',
  'flag:--research-phase',
  'flag:--reset-phase-numbers',
  'flag:--reviews',
  'flag:--validate',
  'state:auto-advance-active',
  'state:chunked-mode',
  'state:fallow-enabled',
  'state:flat-mode',
  'state:git-create-tag',
  'state:is-monorepo',
  'state:needs-codebase-map',
  'state:next-channel',
  'state:phase-mvp-mode',
  'state:plan-strategy-converge',
  'state:reviewer-instances-configured',
  'state:ui-phase-active',
  'state:workstream-active',
  'state:worktrees-enabled',
]);

/**
 * Frozen, stable reason codes for every `fail()` throw site in this module.
 * Tests assert via `assert.equal(err.reason, REASON.X)` rather than
 * regex-/substring-matching the human-readable message (CONTRIBUTING.md
 * "Prohibited: Raw Text Matching on Test Outputs"; shape copied from this
 * repo's own `gsd-core/bin/verify-reapply-patches.cjs` REASON enum) — a
 * message reword must never silently pass a test that exists to catch a
 * behavior regression.
 *
 * Adding a new reason requires updating this map AND the test that locks
 * `Object.keys(REASON).sort()` as a coordinated change.
 */
export const REASON = Object.freeze({
  UNCLOSED_SECTION: 'unclosed_section',
  UNMATCHED_CLOSE: 'unmatched_close',
  NESTED_SECTION: 'nested_section',
  DUPLICATE_ID: 'duplicate_id',
  MISSING_ID: 'missing_id',
  MISSING_WHEN: 'missing_when',
  MALFORMED_ID: 'malformed_id',
  UNKNOWN_WHEN: 'unknown_when',
  MALFORMED_ATTRIBUTES: 'malformed_attributes',
  UNRECOGNIZED_ATTRIBUTE: 'unrecognized_attribute',
  CLOSE_WITH_ATTRIBUTES: 'close_with_attributes',
});

/** One partitioned section of a parsed workflow document. */
export interface WorkflowSection {
  readonly id: string;
  readonly when: string;
  readonly body: string;
  /** false for a synthesized gap fragment (unmarked text between/around marker pairs). */
  readonly explicit: boolean;
  /** 1-based. The `<!-- gsd:section -->` open marker's line for an explicit section, or the first line of the gap for a synthesized one. */
  readonly startLine: number;
}

/** One line of source content plus its ORIGINAL terminator, individually. */
interface LineRecord {
  readonly text: string;
  readonly eol: '' | '\n' | '\r\n';
}

/**
 * Split `content` into per-line records that each carry their OWN original
 * terminator, so CRLF/LF mixes and a missing trailing terminator reassemble
 * byte-for-byte via `record.text + record.eol` concatenation. See the
 * module doc comment's "Line splitting is CRLF-aware" note for why a bare
 * `content.split('\n')` cannot serve this.
 *
 * @param content - full source document text
 */
function splitLinesPreservingEol(content: string): LineRecord[] {
  const lines: LineRecord[] = [];
  let i = 0;
  while (i < content.length) {
    const nlIdx = content.indexOf('\n', i);
    if (nlIdx === -1) {
      lines.push({ text: content.slice(i), eol: '' });
      break;
    }
    const hasCr = content[nlIdx - 1] === '\r';
    const end = hasCr ? nlIdx - 1 : nlIdx;
    lines.push({ text: content.slice(i, end), eol: hasCr ? '\r\n' : '\n' });
    i = nlIdx + 1;
  }
  return lines;
}

// Fence delimiter line matcher — mirrors `context-predicates.cts`'s (itself
// mirroring `markdown-sectionizer.cts`'s `scanFencedBlocks`) exactly: >=3
// backticks/tildes, <=3-space indent tolerance. This is a single-line
// fence-OPENER/CLOSER probe, not a multiline fence-block-strip regex — it
// does not trip `local/no-adhoc-markdown-parsing`'s fenceRegex fingerprint
// (no `[\s\S]` multiline body in the pattern).
const FENCE_DELIM_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

const OPEN_TAG_RE = /^gsd:section(?=\s|$)/;
const CLOSE_TAG = '/gsd:section';
const ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Parse a candidate marker's attribute string (everything after `gsd:section`,
 * already trimmed) into a `key -> value` map, or `null` if it does not
 * consist entirely of zero-or-more `key="value"` tokens (attribute order is
 * free; spacing around `=` and between tokens is flexible — Postel on
 * FORMAT). Returns `null` on a duplicate attribute key too.
 *
 * @param attrsPart - the marker's attribute text, e.g. `id="x" when="always"`
 */
function parseAttrs(attrsPart: string): Map<string, string> | null {
  const attrs = new Map<string, string>();
  let remaining = attrsPart;
  const ATTR_RE = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"/;
  while (remaining.length > 0) {
    const m = ATTR_RE.exec(remaining);
    if (!m) return null;
    const [full, key, value] = m;
    if (attrs.has(key)) return null;
    attrs.set(key, value);
    remaining = remaining.slice(full.length);
  }
  return attrs;
}

/** A `TypeError` carrying a stable {@link REASON} code alongside the human-readable message. */
export interface WorkflowFragmentsError extends TypeError {
  readonly reason: string;
}

/**
 * Throws a `TypeError` naming `sourcePath` (when given) and the 1-based
 * `line`, carrying `reason` (one of {@link REASON}) as a typed property so
 * callers/tests never need to pattern-match the message prose.
 */
function fail(sourcePath: string | undefined, line: number, reason: string, message: string): never {
  const loc = sourcePath ? `${sourcePath}:${line}` : `line ${line}`;
  const err = new TypeError(`workflow-fragments: ${message} (${loc})`) as TypeError & { reason: string };
  err.reason = reason;
  throw err;
}

/** Result of classifying a complete one-line HTML comment's inner text. */
type MarkerClassification =
  | { readonly kind: 'open'; readonly id: string; readonly when: string }
  | { readonly kind: 'close' }
  | { readonly kind: 'none' };

/**
 * Classify a complete one-line HTML comment's inner text (already stripped
 * of `<!--`/`-->` and trimmed) as a `gsd:section` open attempt, a close
 * marker, or "not a marker at all" — including `gsd:loop-host` and any
 * other unrelated comment, which never match the `gsd:section` token and
 * fall through to `{kind: 'none'}` untouched. Throws on any STRUCTURAL
 * violation of a recognized open/close attempt (fail-closed grammar).
 *
 * @param inner - the comment's inner text, e.g. `gsd:section id="x" when="always"`
 * @param sourcePath - optional file path named in thrown errors
 * @param lineNo - 1-based line number named in thrown errors
 */
function classifyMarker(inner: string, sourcePath: string | undefined, lineNo: number): MarkerClassification {
  if (inner === CLOSE_TAG) {
    return { kind: 'close' };
  }
  if (inner.startsWith(CLOSE_TAG) && /^\s/.test(inner.slice(CLOSE_TAG.length))) {
    fail(sourcePath, lineNo, REASON.CLOSE_WITH_ATTRIBUTES, 'close marker must not carry attributes');
  }
  if (!OPEN_TAG_RE.test(inner)) {
    return { kind: 'none' };
  }

  const attrsPart = inner.slice('gsd:section'.length).trim();
  const attrs = parseAttrs(attrsPart);
  if (attrs === null) {
    fail(sourcePath, lineNo, REASON.MALFORMED_ATTRIBUTES, 'malformed section marker attributes');
  }
  const extraKeys = [...attrs.keys()].filter((k) => k !== 'id' && k !== 'when');
  if (extraKeys.length > 0) {
    fail(sourcePath, lineNo, REASON.UNRECOGNIZED_ATTRIBUTE, `unrecognized attribute "${extraKeys[0]}" on section marker`);
  }
  const id = attrs.get('id');
  const when = attrs.get('when');
  if (id === undefined) {
    fail(sourcePath, lineNo, REASON.MISSING_ID, 'section marker missing required "id" attribute');
  }
  if (when === undefined) {
    fail(sourcePath, lineNo, REASON.MISSING_WHEN, 'section marker missing required "when" attribute');
  }
  if (!ID_RE.test(id)) {
    fail(sourcePath, lineNo, REASON.MALFORMED_ID, `section marker "id" value "${id}" does not match ${ID_RE}`);
  }
  if (!WHEN_VOCABULARY.includes(when)) {
    fail(sourcePath, lineNo, REASON.UNKNOWN_WHEN, `section marker "when" value "${when}" is not in the frozen WHEN_VOCABULARY`);
  }
  return { kind: 'open', id, when };
}

/**
 * Parse a workflow document's `<!-- gsd:section -->` markers into a
 * document-order partition of {@link WorkflowSection}s. See the module doc
 * comment for the full grammar, partition invariant, and fence/comment
 * interleaving discipline.
 *
 * @param content - full workflow markdown source
 * @param sourcePath - optional file path named in thrown errors
 */
export function parseWorkflowSections(content: string, sourcePath?: string): WorkflowSection[] {
  const lines = splitLinesPreservingEol(content);
  const sections: WorkflowSection[] = [];

  let fence: { char: '`' | '~'; len: number } | null = null;
  let inComment = false;
  let currentOpen: { id: string; when: string; startLineIndex: number } | null = null;
  const seenIds = new Set<string>();
  let gapCounter = 0;
  let cursor = 0;

  const joinRange = (from: number, to: number): string => {
    let out = '';
    for (let k = from; k <= to; k++) {
      out += lines[k].text + lines[k].eol;
    }
    return out;
  };

  const flushGapBefore = (nextIndex: number): void => {
    if (nextIndex > cursor) {
      sections.push({
        id: `gap-${gapCounter}`,
        when: 'always',
        body: joinRange(cursor, nextIndex - 1),
        explicit: false,
        startLine: cursor + 1,
      });
      gapCounter += 1;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawText = lines[i].text;

    if (fence !== null) {
      // Inside a real fence: only a matching closer can end it. Any
      // `<!--`/`-->` on this line is fence content, never a comment
      // boundary (row 5/6 of 50-test-matrix.md).
      const m = FENCE_DELIM_RE.exec(rawText);
      if (m) {
        const char = m[2][0] as '`' | '~';
        const len = m[2].length;
        const trailing = m[3];
        if (char === fence.char && len >= fence.len && /^\s*$/.test(trailing)) {
          fence = null;
        }
      }
      continue;
    }

    if (inComment) {
      // Inside a real (unrelated) comment: only '-->' can end it. Any
      // fence delimiter on this line is comment content, never a fence
      // boundary (row 7 of 50-test-matrix.md).
      if (rawText.includes('-->')) inComment = false;
      continue;
    }

    const trimmed = rawText.trim();

    if (trimmed.startsWith('<!--')) {
      // Persistence is decided by whether a close token appears ANYWHERE on
      // the line, not by whether the line ENDS with one — see the module
      // doc comment's "deliberate refinement" note. Marker-hood additionally
      // requires the comment to be the line's ENTIRE content.
      const hasClose = trimmed.includes('-->');
      if (hasClose && trimmed.endsWith('-->')) {
        const inner = trimmed.slice(4, trimmed.length - 3).trim();
        const classification = classifyMarker(inner, sourcePath, lineNo);
        if (classification.kind === 'open') {
          if (currentOpen !== null) {
            fail(sourcePath, lineNo, REASON.NESTED_SECTION, `nested gsd:section marker (already inside "${currentOpen.id}")`);
          }
          if (seenIds.has(classification.id)) {
            fail(sourcePath, lineNo, REASON.DUPLICATE_ID, `duplicate section id "${classification.id}"`);
          }
          flushGapBefore(i);
          seenIds.add(classification.id);
          currentOpen = { id: classification.id, when: classification.when, startLineIndex: i };
          cursor = i + 1;
        } else if (classification.kind === 'close') {
          if (currentOpen === null) {
            fail(sourcePath, lineNo, REASON.UNMATCHED_CLOSE, 'unmatched /gsd:section close marker');
          }
          sections.push({
            id: currentOpen.id,
            when: currentOpen.when,
            body: joinRange(currentOpen.startLineIndex + 1, i - 1),
            explicit: true,
            startLine: currentOpen.startLineIndex + 1,
          });
          currentOpen = null;
          cursor = i + 1;
        }
        // classification.kind === 'none': ordinary self-contained comment
        // (e.g. a one-line `gsd:loop-host` or unrelated comment) — no state change.
      }
      if (!hasClose) {
        inComment = true; // multi-line: stays open until a later '-->'
      }
      continue;
    }

    const fenceMatch = FENCE_DELIM_RE.exec(rawText);
    if (fenceMatch) {
      const char = fenceMatch[2][0] as '`' | '~';
      const trailing = fenceMatch[3];
      // CommonMark §4.5: a backtick fence opener's info string must not
      // itself contain a backtick.
      if (!(char === '`' && trailing.includes('`'))) {
        fence = { char, len: fenceMatch[2].length };
      }
    }
  }

  if (currentOpen !== null) {
    fail(sourcePath, currentOpen.startLineIndex + 1, REASON.UNCLOSED_SECTION, `unclosed gsd:section marker "${currentOpen.id}"`);
  }

  flushGapBefore(lines.length);

  return sections;
}

/**
 * Map parsed sections to `context-composer` fragments. Every strategy is
 * `{kind: 'verbatim'}` (design row 23 / test matrix rows 26-29): non-
 * lossiness in this phase is a STRUCTURAL guarantee of the strategy choice,
 * never a large-budget trick.
 *
 * @param sections - document-order sections from {@link parseWorkflowSections}
 */
export function toFragments(sections: readonly WorkflowSection[]): contextComposer.Fragment[] {
  return sections.map((section) => ({
    id: section.id,
    content: section.body,
    strategy: { kind: 'verbatim' as const },
  }));
}

/**
 * Concatenate a {@link contextComposer.ComposeResult}'s fragment contents,
 * in declaration order, back into a document. Every fragment here is
 * `verbatim` with an empty wrapper, so this is a plain join.
 *
 * @param result - the plan returned by `composeWithinBudget`
 */
export function renderFragments(result: contextComposer.ComposeResult): string {
  return result.fragments.map((f) => f.content).join('');
}

/**
 * THE emission entry point: parse -> toFragments -> composeWithinBudget ->
 * render. `budget` defaults to `Number.MAX_SAFE_INTEGER` (no pressure).
 * Because every fragment is `verbatim`, the output is identical regardless
 * of the budget value (design row 23) — this is never relied upon as the
 * source of non-lossiness; the strategy set is.
 *
 * @param content - full workflow markdown source
 * @param opts - `sourcePath` named in thrown parse errors; `budget` in bytes
 */
export function composeWorkflow(content: string, opts: { sourcePath?: string; budget?: number } = {}): string {
  const { sourcePath, budget = Number.MAX_SAFE_INTEGER } = opts;
  const sections = parseWorkflowSections(content, sourcePath);
  const fragments = toFragments(sections);
  const composed = contextComposer.composeWithinBudget({
    fragments,
    budget,
    measure: (text: string) => Buffer.byteLength(text, 'utf8'),
    options: { charsPerUnit: 1 },
  });
  return renderFragments(composed);
}

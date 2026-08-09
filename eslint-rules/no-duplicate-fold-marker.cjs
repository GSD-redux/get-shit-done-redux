'use strict';

/**
 * no-duplicate-fold-marker
 *
 * Flag a `folded:<name>` marker that appears more than once in the same file.
 *
 * Consolidation epic #1969 moved standalone regression suites into shared host
 * files. Each moved suite is wrapped in a self-contained block:
 *
 *   // ──────────────────────────────────────────────────────────────────────
 *   // Folded from tests/bug-376-claude-js-hook-gsd-rewriter.test.cjs — …
 *   // ──────────────────────────────────────────────────────────────────────
 *   {
 *     const { describe: __foldDescribe } = require('node:test');
 *     __foldDescribe("folded:bug-376-claude-js-hook-gsd-rewriter (… B1 #1970)", () => {
 *       …
 *     });
 *   }
 *
 * Because each block is self-contained, a second verbatim copy in the same host
 * parses, registers, and PASSES — twice. Nothing reports it. #3271 found 25 such
 * copies (~5,800 lines) across three suites, all introduced by one stale-base
 * re-application in `6d072435d` (#1975 re-applying #1970's hunks).
 *
 * Two concrete costs, both invisible to a green suite:
 *   1. Every duplicated block executes twice on every lane of the matrix.
 *   2. DEFECT.GENERATIVE-FIX — a contributor fixing one of these regressions
 *      edits the copy they found and leaves the other asserting the old
 *      behavior. The suite stays green while the two copies disagree.
 *
 * ── What is keyed ─────────────────────────────────────────────────────────────
 *
 * The marker is the WHITESPACE-DELIMITED token after `folded:` in the title
 * literal passed to the fold alias — NOT the whole title, and NOT a
 * `[a-z0-9-]*` slice of it.
 *
 *   "folded:bug-376-claude-js-hook-gsd-rewriter (consolidation epic #1969 B1 #1970)"
 *    → marker `bug-376-claude-js-hook-gsd-rewriter`
 *
 * Both halves of that definition are load-bearing:
 *
 *   (a) Stopping at whitespace and NOT at `.` keeps
 *       `feat-443-effort-fast-mode.integration` distinct from
 *       `feat-443-effort-fast-mode`. Those are two different folded suites that
 *       coexist in tests/model-resolver.test.cjs; a `[a-z0-9-]*` key collides
 *       them and reports a duplicate that does not exist (#3271's own
 *       reproduction command has this bug).
 *
 *   (b) Keying on the marker rather than the full title means a re-fold under a
 *       different batch label ("… B1 #1970" vs "… B5 #1975") is still caught.
 *       The batch label is provenance, not identity.
 *
 * ── What is deliberately NOT flagged ──────────────────────────────────────────
 *
 *   - A `__foldDescribe` title without a `folded:` prefix. The alias is reused
 *     for at least one ordinary describe block
 *     (tests/review-default-reviewers-workflow.test.cjs). Those are not folds
 *     and carry no uniqueness obligation.
 *   - A plain `describe("folded:…")`. The convention this rule enforces is the
 *     fold alias; a bare `describe` with a colliding title is a different
 *     (and currently non-existent) shape.
 *   - A non-literal title (`__foldDescribe(name, …)`, template literal with a
 *     substitution). Nothing can be proven about it statically, so it is
 *     skipped rather than guessed at.
 *   - The SAME marker in two DIFFERENT files. The defect class is intra-file
 *     duplication — one host running one suite twice. Cross-file reuse would be
 *     a different question and is not decided here.
 *
 * The rule reports the SECOND and every subsequent occurrence, never the first,
 * and names the line the first occurrence sits on — so the failure message
 * points at both ends of the duplication.
 *
 * DEFECT category: DEFECT.GENERATIVE-FIX
 */

/** The `describe` alias that consolidation epic #1969 folds are wrapped in. */
const FOLD_ALIAS = '__foldDescribe';

/** Title prefix that marks a folded suite. */
const FOLD_PREFIX = 'folded:';

/**
 * Extract the fold marker from a describe title.
 *
 * Returns the whitespace-delimited token following `folded:`, or null when the
 * title is not a fold title (no prefix) or carries an empty marker.
 *
 * @param {string | null} title
 * @returns {string | null}
 */
function foldMarkerOf(title) {
  if (typeof title !== 'string') return null;
  if (!title.startsWith(FOLD_PREFIX)) return null;
  const marker = title.slice(FOLD_PREFIX.length).split(/\s/, 1)[0];
  return marker.length > 0 ? marker : null;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow the same consolidation-epic folded suite appearing twice in one host file',
      category: 'Test hygiene',
    },
    schema: [],
    messages: {
      duplicateFoldMarker:
        'Folded suite "{{marker}}" is already present in this file at line {{firstLine}} ' +
        '(DEFECT.GENERATIVE-FIX). A second copy runs the same tests twice on every lane and ' +
        'lets the two copies drift apart silently — a contributor fixing the regression edits ' +
        'one copy and leaves the other asserting the old behavior, with the suite still green. ' +
        'Delete this copy; keep the one at line {{firstLine}}.',
    },
  },

  create(context) {
    /**
     * marker → line of its first occurrence in this file.
     * Rebuilt per file: `create` runs once per linted file.
     * @type {Map<string, number>}
     */
    const firstSeen = new Map();

    /**
     * Returns the static string value of a title argument, or null when the
     * title is not a plain string literal (identifier, template literal with a
     * substitution, computed expression, …).
     *
     * A substituted template cannot be resolved statically, so it is skipped
     * rather than guessed at.
     *
     * @param {import('eslint').Rule.Node | undefined} node
     * @returns {string | null}
     */
    function staticTitleOf(node) {
      if (!node) return null;
      if (node.type === 'Literal') {
        return typeof node.value === 'string' ? node.value : null;
      }
      if (node.type === 'TemplateLiteral') {
        // Only a substitution-free template has a knowable value.
        if (node.expressions.length !== 0) return null;
        if (node.quasis.length !== 1) return null;
        return node.quasis[0].value.cooked ?? null;
      }
      return null;
    }

    return {
      CallExpression(node) {
        // Only the fold alias — a bare `describe` is a different convention.
        if (node.callee.type !== 'Identifier') return;
        if (node.callee.name !== FOLD_ALIAS) return;
        if (node.arguments.length === 0) return;

        const marker = foldMarkerOf(staticTitleOf(node.arguments[0]));
        if (marker === null) return;

        const firstLine = firstSeen.get(marker);
        if (firstLine === undefined) {
          firstSeen.set(marker, node.loc.start.line);
          return;
        }

        context.report({
          node: node.arguments[0],
          messageId: 'duplicateFoldMarker',
          data: { marker, firstLine: String(firstLine) },
        });
      },
    };
  },
};

module.exports = rule;

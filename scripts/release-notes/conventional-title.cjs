'use strict';

/**
 * Single source of truth for conventional-commit PR-title parsing.
 *
 * Consumed by BOTH:
 *   - the release-notes changelog classifier
 *     (scripts/release-notes/format-github-release-notes.cjs), and
 *   - the PR-title CI gate (.github/workflows/pr-title-validator.yml, via
 *     evaluatePrTitle).
 *
 * Keeping one matcher here is the point of #1549: a forked copy of the regex
 * would let the gate accept a title that the changelog then mis-buckets. Both
 * the bucket anchors and the gate must read the title the same way.
 */

// Bucket anchors. The leading `^` is load-bearing: the changelog buckets on the
// type at the START of the title. Anything before it (e.g. a `[security] ` tag)
// defeats the anchor and silently mis-files the entry — which is exactly the
// drift the PR-title gate below rejects at open time.
const FEATURE_RE = /^feat(?:ure)?\s*(?:\(|!|:)/i;
const FIX_RE = /^fix\s*(?:\(|!|:)/i;

// A well-formed conventional header at the START of the title:
//   <type>[(<scope>)][!]:
// e.g. `fix(#1542):`, `feat(#39)!:`, `fix:`, `enhance(verify-phase):`.
// Anchored with `^` so a leading tag/prefix fails to match (no `bad-prefix`).
const HEADER_RE = /^([a-z]+)(\([^)]*\))?(!)?:/i;

// An issue reference inside a scope: `(#123)`, `(#123, core)`, etc.
const ISSUE_REF_IN_SCOPE_RE = /#\d+/;

// #2716: recognized non-user-facing conventional-commit types. A title whose
// START-anchored type prefix is one of these is internal work (tests, chores,
// CI, docs, refactors, perf, reverts) and must NOT render under the user-facing
// "Enhancement" heading in release notes. Only a CLEAN prefix match qualifies —
// untyped or anchor-defeated titles fall through to the visible Enhancement
// fallback (a safety net so possibly-user-facing content is never hidden).
const NON_USER_FACING_TYPES = new Set([
  'docs', 'refactor', 'test', 'ci', 'chore', 'perf', 'revert',
]);

/**
 * Classify a clean conventional title into a changelog bucket.
 * Callers that hold a full changelog bullet line (with a `* ` marker and a
 * ` by @author` suffix) must strip those first; this operates on the title.
 *
 * @param {string} title
 * @returns {'Feature'|'Fix'|'Enhancement'|'Internal'}
 */
function classifyBucket(title) {
  const t = String(title == null ? '' : title).trim();
  if (FEATURE_RE.test(t)) return 'Feature';
  if (FIX_RE.test(t)) return 'Fix';
  // #2716: a clean non-user-facing type prefix → Internal (omitted from user-facing
  // release-note sections). The HEADER_RE anchor ensures a leading tag/prefix
  // (e.g. `[security] fix(...)`) does NOT match here — those keep falling through
  // to the visible Enhancement fallback.
  const headerMatch = HEADER_RE.exec(t);
  if (headerMatch && NON_USER_FACING_TYPES.has(headerMatch[1].toLowerCase())) {
    return 'Internal';
  }
  return 'Enhancement';
}

const REQUIRED_FORMAT_MESSAGE = [
  'PR title must follow `type(#<issue>): summary`.',
  'The type must come first (no leading tags like `[security]`) and the scope',
  'must carry the linked issue ref so the release changelog links to it.',
  'Examples: `fix(#1542): roadmap rollback`, `feat(#39)!: drop legacy flag`,',
  '`enhance(#1549): add PR-title validator`.',
].join(' ');

/**
 * Validate a PR title against the convention the changelog depends on (#1549).
 *
 * @param {{ title?: string }} input
 * @returns {{ valid: true, reason: 'valid' }
 *          | { valid: false, reason: 'bad-prefix'|'missing-issue-ref', message: string }}
 */
function evaluatePrTitle({ title } = {}) {
  const t = String(title == null ? '' : title).trim();

  const m = HEADER_RE.exec(t);
  if (!m) {
    // No clean `type[(scope)][!]:` at the start — covers leading tags,
    // `Revert "..."`, empty, and freeform titles.
    return { valid: false, reason: 'bad-prefix', message: REQUIRED_FORMAT_MESSAGE };
  }

  const scope = m[2]; // includes the parens, e.g. "(#1542)" — or undefined
  if (!scope || !ISSUE_REF_IN_SCOPE_RE.test(scope)) {
    return { valid: false, reason: 'missing-issue-ref', message: REQUIRED_FORMAT_MESSAGE };
  }

  return { valid: true, reason: 'valid' };
}

module.exports = {
  FEATURE_RE,
  FIX_RE,
  HEADER_RE,
  classifyBucket,
  evaluatePrTitle,
  REQUIRED_FORMAT_MESSAGE,
};

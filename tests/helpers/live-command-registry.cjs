// allow-test-rule: source-text-is-the-product
// commands/gsd/*.md files ARE the deployed registry — reading their frontmatter
// validates the structural contract of the command surface, not application source.
'use strict';
/**
 * live-command-registry.cjs
 *
 * Derives the canonical set of live slash-command tokens from the source-of-truth
 * registry: commands/gsd/*.md (one file per registered command).
 *
 * Each command file has YAML frontmatter with a `name:` field:
 *   name: gsd:slug    (colon-style — most commands)
 *   name: gsd-slug    (dash-style — ns-* namespace commands)
 *
 * For each slug, three canonical token forms are emitted:
 *   /gsd-slug   — Claude / non-Gemini runtimes
 *   /gsd:slug   — Gemini runtime
 *   $gsd-slug   — Codex runtime
 *
 * The result is memoized per process — a single fs walk is amortized across
 * all test files that import this helper. The cache is intentionally not
 * exposed for invalidation: test processes are short-lived and the registry
 * does not change mid-run.
 *
 * Per CONTEXT.md k003: all readFileSync calls happen inside getLiveCommandTokens()
 * (i.e., inside a function call, not at module top-level) so that import-time
 * ENOENT errors are caught and reported with context rather than aborting the
 * test runner before any test registers.
 */

const fs = require('node:fs');
const path = require('node:path');

const COMMANDS_DIR = path.join(__dirname, '..', '..', 'commands', 'gsd');

// Module-level memoization — set on first call, reused thereafter.
let _cache = null;

/**
 * The exhaustive set of prefixes `getLiveCommandTokens()` ever emits — kept
 * here, alongside the token-emission logic itself, as the single source of
 * truth so a shape-based "does this string look like a live-command token"
 * check (see `tests/qa/oracles.cjs` value-hygiene) never drifts from what
 * this file actually generates. Every token this module produces is exactly
 * `${prefix}${slug}` for one of these three prefixes — see the `tokens.add`
 * calls in `getLiveCommandTokens()` below, which is the sole producer.
 */
const LIVE_COMMAND_TOKEN_PREFIXES = Object.freeze(['/gsd-', '/gsd:', '$gsd-']);

/**
 * Extract the first whitespace-delimited "word" of a string, e.g.
 * `"/gsd-plan-phase 2"` -> `"/gsd-plan-phase"`. Real command-token payloads
 * carry trailing arguments (`init`'s `recommended_actions[].command` is
 * literally `/gsd-plan-phase 2`), so an exact-match test against the WHOLE
 * string would reject every argument-carrying token — the token itself is
 * always the first word.
 *
 * @param {string} value
 * @returns {string}
 */
function firstToken(value) {
  const match = value.match(/^\S+/);
  return match ? match[0] : value;
}

/**
 * Is `value`'s first whitespace-delimited word an EXACT member of
 * `liveTokens` (a `Set<string>`, normally `getLiveCommandTokens()`)?
 *
 * This is the SOLE shared predicate behind every "is this string a live
 * command token" check in the QA harness — `tests/qa/oracles.cjs`'s
 * `value-hygiene` command-token exemption and its `routing-validity` check —
 * so the two can never independently drift on what counts as a live command
 * token (#3913 P9 security review: this is the THIRD iteration of that
 * exemption. First it was keyed on the leaf name `command`; then on a bare
 * `String.startsWith` prefix test with an unconstrained remainder, which
 * exempted any string merely SHARING A PREFIX with a real token — e.g.
 * `/gsd-x/../../../Users/someone/.ssh/id_rsa` or `/gsd:/etc/passwd` both
 * satisfied `startsWith('/gsd-')`/`startsWith('/gsd:')`).
 *
 * Deliberately NOT a `startsWith` fast path over `LIVE_COMMAND_TOKEN_PREFIXES`
 * short-circuiting this check: exact membership of the first word is the
 * WHOLE predicate, so a leaked path can never pass merely by sharing a
 * token's first few bytes.
 *
 * @param {unknown} value
 * @param {Set<string>} liveTokens
 * @returns {boolean}
 */
function isLiveCommandToken(value, liveTokens) {
  if (typeof value !== 'string') return false;
  return liveTokens.has(firstToken(value));
}

/**
 * Parse the YAML frontmatter `name:` field from a command file's content.
 * Returns the slug (e.g. "help", "plan-phase", "context") or null if the
 * field is absent or the file has no frontmatter.
 *
 * The frontmatter is bounded by the first `---` line and the next `---` line.
 * We parse only the `name:` field — the full YAML spec is not needed and
 * introducing a YAML parser dependency would be disproportionate.
 *
 * Supported name forms:
 *   name: gsd:slug     → slug = "slug"
 *   name: gsd-slug     → slug = "slug"
 *   name: "gsd:slug"   → slug = "slug"  (quoted)
 *   name: "gsd-slug"   → slug = "slug"  (quoted)
 */
function parseSlug(content, filePath) {
  // Frontmatter must start with '---' on the very first line.
  if (!content.startsWith('---')) {
    throw new Error(
      `[live-command-registry] ${filePath}: missing YAML frontmatter — file must start with '---'`
    );
  }

  // Find the closing '---' delimiter.
  const closingIdx = content.indexOf('\n---', 3);
  if (closingIdx < 0) {
    throw new Error(
      `[live-command-registry] ${filePath}: unclosed YAML frontmatter — no closing '---' found`
    );
  }

  const frontmatter = content.slice(0, closingIdx);

  // Match `name:` line, allowing optional quotes around the value.
  // The value must be one of: gsd:<slug> or gsd-<slug>
  // where slug = [a-z0-9][a-z0-9-]*
  const nameMatch = frontmatter.match(/^name:\s*"?(gsd[:‑-])([a-z0-9][a-z0-9-]*)"?\s*$/m);
  if (!nameMatch) {
    throw new Error(
      `[live-command-registry] ${filePath}: could not extract slug from frontmatter ` +
      `(expected "name: gsd:<slug>" or "name: gsd-<slug>")`
    );
  }

  return nameMatch[2]; // the slug after "gsd:" or "gsd-"
}

/**
 * Returns the Set<string> of all canonical slash-command tokens derived from
 * commands/gsd/*.md. Memoized — safe to call repeatedly without extra fs I/O.
 *
 * Throws on the first malformed file (fail-loud per CONTEXT.md k302) so
 * registry drift is caught immediately rather than silently producing an
 * incomplete allow-list.
 */
function getLiveCommandTokens() {
  if (_cache !== null) return _cache;

  if (!fs.existsSync(COMMANDS_DIR)) {
    throw new Error(
      `[live-command-registry] commands directory not found: ${COMMANDS_DIR}`
    );
  }

  const entries = fs.readdirSync(COMMANDS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort(); // deterministic order for reproducible error messages

  const tokens = new Set();

  for (const fileName of entries) {
    const filePath = path.join(COMMANDS_DIR, fileName);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      throw new Error(
        `[live-command-registry] failed to read ${filePath}: ${err.message}`
      );
    }

    const slug = parseSlug(content, filePath);

    // Emit all three canonical token forms per slug.
    tokens.add(`/gsd-${slug}`);   // Claude / non-Gemini
    tokens.add(`/gsd:${slug}`);   // Gemini
    tokens.add(`$gsd-${slug}`);   // Codex
  }

  _cache = tokens;
  return _cache;
}

module.exports = { getLiveCommandTokens, LIVE_COMMAND_TOKEN_PREFIXES, firstToken, isLiveCommandToken };

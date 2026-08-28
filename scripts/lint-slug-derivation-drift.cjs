#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the SLUG-DERIVATION seam (issue #3987,
 * closing epic #3473's last two residuals).
 *
 * `src/core-utils.cts`'s `generateSlugInternal(text, maxLen)` is the SINGLE
 * canonical owner of "turn arbitrary text into a filesystem-safe slug":
 * `transliterateForSlug` (lowercase, then a per-character Cyrillic map) ->
 * `.replace(/[^a-z0-9]+/g, '-')` -> optional truncation to `maxLen` ->
 * `.replace(/^-+|-+$/g, '')` (trim runs AFTER truncation, #2849 — truncating
 * first can leave a trailing separator the trim step exists to remove).
 * `#3883` deleted 11 hand-inlined copies of the pre-#2849/#2848 shape — a
 * single chained expression `.toLowerCase()` -> `.replace(/[^a-z0-9]+/g,
 * '-')` -> `.replace(/^-+|-+$/g, '')`, optionally `.substring(0, 60)` —
 * none of which transliterated, and all of which trimmed BEFORE truncating.
 * This guard is what stops a twelfth copy.
 *
 * DETECTOR (measured against the real deleted shape and the real repo tree —
 * see the guard's own test file for the 5-flag/2-TRUE/3-SANCTIONED/0-FALSE
 * census). A re-derivation is one logical STATEMENT — not merely one source
 * LINE; a chained `.replace()` call is routinely wrapped across several
 * lines by this repo's formatter — carrying BOTH:
 *   (a) a `.replace(<negated character class>, '-')` call — collapsing
 *       every non-slug character run to a single hyphen; AND
 *   (b) a `.replace(<^-+|-+$-shaped anchor pair>, '')` call — trimming
 *       leading/trailing hyphen runs.
 * Both clauses require the SAME replacement discipline as the owner
 * (collapse specifically to `'-'`, trim specifically to `''`) — a nearby
 * sanitizer that collapses to a DIFFERENT character (e.g. `'_'`) is a
 * different derivation, not a copy of this one, and must not fire.
 *
 * WHY STATEMENT-SCOPED, NOT LINE-SCOPED. A candidate detector that matches
 * per LINE (mirroring `lint-phase-enumeration-drift.cjs`'s style) was
 * measured against the real tree and rejected: it produced 18 hits, 7 of
 * which were unrelated (an unrelated `[^A-Za-z0-9._-]+` filename sanitizer
 * sharing a physical line with an unrelated hyphen-trim, and test-fixture
 * labels) — a material false-positive rate. Scoping detection to one
 * logical statement (joining a chain's continuation lines — those starting
 * with `.` — back onto the statement that opened the chain) is what gives
 * this guard its precision: two re-derivation-shaped calls that merely sit
 * on the same physical line but belong to two DIFFERENT statements (e.g.
 * separated by `;`) do not merge into one statement and are correctly not
 * flagged; see `findSlugDerivationDrift`'s own test file for the fixture
 * that proves this.
 *
 * SCOPE. `src/`, `scripts/`, `tests/`, `eslint-rules/` — NOT
 * `gsd-core/bin/lib/**` or `bin/install.js`, which are `src/`'s own BUILT
 * OUTPUT (via `npm run build:lib` / the installer bundling step): scanning
 * them in addition to `src/` would double-count every authored re-derivation
 * once for its source and once for its compiled mirror. Both are simply
 * absent from SCAN_DIRS below, so no extra exclusion logic is needed.
 *
 * SANCTIONED EXEMPTIONS (never a bare denylist — each entry names the exact
 * function it exempts and WHY, mirroring `lint-completion-ratio-drift.cjs`'s
 * `FUNCTION_SCOPED_EXEMPTIONS`; an unrelated re-derivation added anywhere
 * else in these same files, or in a same-named function outside the exact
 * scoped file, is still caught):
 *   - `src/core-utils.cts` `generateSlugInternal` — the canonical owner
 *     itself. Its char-class collapse (`:190`) and hyphen-trim (`:192`) sit
 *     in two DIFFERENT statements today, so it escapes this detector BY
 *     CONSTRUCTION without needing an entry here. Listed explicitly anyway:
 *     an IMPLICIT escape is a latent bug — a future refactor that folds
 *     those two lines into one chained statement (functionally a no-op)
 *     must not silently make the guard start flagging its own owner.
 *   - `src/gsd2-import.cts` `slugify` (`:97-103`) — declared deliberately
 *     DIFFERENT from `generateSlugInternal` by #3883 (a distinct
 *     truncation contract: no 60-char cap at all, vs the owner's default);
 *     it already calls the SHARED `transliterateForSlug` primitive, so this
 *     is not an independent re-derivation of the transliteration step —
 *     only of the collapse/trim shape it deliberately keeps un-consolidated.
 *   - `src/runtime-artifact-conversion.cts` `normalizeKimiSkillName`
 *     (`:608-616`) — a Kimi runtime skill-name normalizer in a completely
 *     different domain (CLI skill invocation names, never a `.planning/`
 *     phase/plan/milestone slug); its negated class (`[^a-z0-9-]`)
 *     deliberately PRESERVES hyphens (a skill name may already contain
 *     them), the opposite of the slug seam's contract. Shaped like the
 *     re-derivation textually; not one by domain.
 *   - `scripts/generate-package-identity.cjs` `slugifyPackageName`
 *     (`:34-42`) — npm-scope-name-to-cache-filename prep. Runs PRE-BUILD
 *     (`npm run generate:identity`, step 1 of `npm run build`, before
 *     `build:lib` compiles `src/core-utils.cts`), so it structurally cannot
 *     `require()` the seam it would otherwise route through.
 *
 * The tree-walk / root-confinement / regex-literal-tokenizer / sanitizer
 * machinery is SHARED with the sibling drift guards via
 * `scripts/lib/drift-scan.cjs` (ADR-3180 Decision 4).
 *
 * KNOWN, ACCEPTED limits of a per-statement textual scan (same tradeoff the
 * sibling drift guards document): a statement-joiner keyed on "the next
 * line starts with `.`" will not recognize a chain broken across lines in
 * some OTHER formatting style (e.g. a trailing `.replace(` at the end of
 * the PRECEDING line rather than a leading `.` on the following one); this
 * repo's formatter (Prettier-style leading-dot continuation) does not
 * produce that shape, so it is left unhandled, matching the sibling guards'
 * "left to code review, not this regex" precedent.
 */

const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { MAX_REGEX_LITERAL_LEN, sanitizeForReport, scanTree } = driftScan;

// Authored source across the four surfaces the brief scopes this guard to.
// `gsd-core/bin/lib/**` (src/'s build output) and `bin/install.js` are never
// visited because they are not in this list — see the header comment.
const SCAN_DIRS = ['src', 'scripts', 'tests', 'eslint-rules'];
const SCAN_EXT = new Set(['.cts', '.ts', '.mts', '.cjs', '.js']);

// This guard's OWN unit-test file is a categorically different case from
// every other FUNCTION_SCOPED_EXEMPTIONS entry below: scanning `tests/` for
// REAL re-derivations (the whole reason this guard covers `tests/` at all —
// #3987's two TRUE positives were `scripts/qa-smell-ratchet.cjs` and
// `tests/planning-inspect.test.cjs`) means this guard's own fixtures —
// LITERAL STRINGS handed to `findSlugDerivationDrift` to prove it detects
// the real deleted #3883 shape — textually match the exact pattern they
// exist to demonstrate. They never execute as a real slug derivation at
// runtime; they are detector test data, the same role `RuleTester` fixtures
// play for an ESLint rule's own test file. Exempting this ONE file by path
// is not a loophole for a real re-derivation (every OTHER file in `tests/`
// remains fully covered) — it is what lets the detector's positive-match
// tests exist at all without permanently reporting themselves as findings.
const SELF_TEST_FILE = path.join('tests', 'slug-derivation-drift-guard.test.cjs');

// (a) `.replace(/[^...]+/flags, '-')` — collapse a negated character class
// to a single hyphen. The class body (`[^...]`) is matched generically (any
// content not containing `]`) so both `[^a-z0-9]` and `[^a-z0-9-]` match;
// what pins this to the slug seam specifically is the REQUIRED `'-'`
// replacement (captured/back-referenced quote so `'-'`/`"-"`/`` `-` `` all
// match, but the delimiters must agree) — a sanitizer that collapses to a
// different character (`'_'`, `''`, etc.) is a different derivation and
// must not match.
const CHARCLASS_REPLACE_RE = /\.replace\(\s*\/\[\^[^\]]*\][+*]?\/[a-z]*\s*,\s*(['"`])-\1\s*\)/;

// (b) `.replace(/^-+|-+$/flags, '')` (or the `/^-|-$/` single-hyphen
// variant some sanctioned sites use) — trim leading/trailing hyphen runs.
// Required replacement is the EMPTY string (captured/back-referenced quote,
// same reasoning as above).
const TRIM_REPLACE_RE = /\.replace\(\s*\/\^-\+?\|-\+?\$\/[a-z]*\s*,\s*(['"`])\1\s*\)/;

// Optional `export ` modifier, mirroring the sibling guards' function
// tracker — only a column-0 top-level `function` declaration updates the
// current-function tracker.
const TOP_LEVEL_FUNCTION_RE = /^(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(/;

// Per the header comment: NOT a bare file allowlist — each entry is scoped
// to the SPECIFIC function, with its reason recorded above (mirroring
// `lint-completion-ratio-drift.cjs`'s `FUNCTION_SCOPED_EXEMPTIONS`). An
// unrelated re-derivation added anywhere else in these same files is still
// caught.
const FUNCTION_SCOPED_EXEMPTIONS = new Map([
  [path.join('src', 'core-utils.cts'), new Set(['generateSlugInternal'])],
  [path.join('src', 'gsd2-import.cts'), new Set(['slugify'])],
  [path.join('src', 'runtime-artifact-conversion.cts'), new Set(['normalizeKimiSkillName'])],
  [path.join('scripts', 'generate-package-identity.cjs'), new Set(['slugifyPackageName'])],
]);

/**
 * Strip comment text from a line before detection — identical approach to
 * `lint-phase-enumeration-drift.cjs`'s local copy (not shared: each guard's
 * comment-bearing shape differs slightly in practice, and the sibling
 * guards deliberately keep this local rather than centralizing it).
 */
function stripComments(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return '';
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

/**
 * Join a chained method call's continuation lines (those whose trimmed,
 * comment-stripped text starts with `.`) back onto the line that opened the
 * chain, producing one "logical statement" per opening line — AND split a
 * single physical line into multiple statements at each top-level `;`, so
 * two unrelated statements that merely share one physical line (e.g.
 * `a.replace(/[^.]+/g,'-'); b.replace(/^-+|-+$/g,'');`) are never merged
 * into one and evaluated as a single (false-positive) statement. This is
 * what gives the guard STATEMENT scoping instead of LINE scoping — see the
 * header comment for why line-scoping was measured and rejected, and why
 * statement-scoping must cut BOTH ways (joining a chain's continuation
 * lines together, AND separating unrelated statements sharing one line).
 *
 * The `;`-split is intentionally naive (a plain string split, not a
 * literal-aware tokenizer): this detector's two clauses only ever appear
 * inside a `.replace(/regex/, 'string')` call, and neither the regex body
 * nor the replacement string this guard's own clauses match ever contains a
 * literal `;` in this repo's real sources. A hypothetical future site that
 * embeds a `;` inside such a literal is a known, accepted limit of this
 * per-statement textual scan — the same class of tradeoff the sibling
 * drift guards' own per-line scans document.
 *
 * Returns `[{ startLine, text }]` — `startLine` is 1-based, matching the
 * sibling guards' reporting convention.
 */
function buildLogicalStatements(lines) {
  const statements = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const strippedLine = stripComments(lines[i]);
    if (!strippedLine.trim()) continue; // blank/comment-only lines never break or start a statement

    const fragments = strippedLine.split(';').map((f) => f.trim()).filter((f) => f.length > 0);
    for (let f = 0; f < fragments.length; f++) {
      const frag = fragments[f];
      const isFirstFragmentOfLine = f === 0;
      const isLastFragmentOfLine = f === fragments.length - 1;

      if (isFirstFragmentOfLine && frag.startsWith('.') && current) {
        current.text += ' ' + frag;
      } else {
        if (current) statements.push(current);
        current = { startLine: i + 1, text: frag };
      }

      // A fragment that is not the LAST one on its line was terminated by a
      // `;` immediately after it — it is a complete statement no later
      // fragment (on this line or the next) may merge into.
      if (!isLastFragmentOfLine) {
        statements.push(current);
        current = null;
      }
    }
  }
  if (current) statements.push(current);
  return statements;
}

/**
 * Pure: find every unsanctioned slug-derivation re-derivation in `text`.
 * `relPath` is the repo-relative path, used both to report file:line and to
 * apply the narrow, function-scoped exemptions above.
 * Returns [{ line, found }].
 */
function findSlugDerivationDrift(text, relPath) {
  const out = [];
  const lines = text.split('\n');
  const exemptFunctions = FUNCTION_SCOPED_EXEMPTIONS.get(relPath) || null;

  // Pre-compute which top-level function each REAL line sits inside, before
  // merging chains, so a merged statement's reported/exempted function is
  // whichever one was active at the statement's OPENING line.
  const functionAtLine = new Array(lines.length);
  let currentFunction = null;
  for (let i = 0; i < lines.length; i++) {
    const fnMatch = TOP_LEVEL_FUNCTION_RE.exec(lines[i]);
    if (fnMatch) currentFunction = fnMatch[1];
    functionAtLine[i] = currentFunction;
  }

  for (const stmt of buildLogicalStatements(lines)) {
    if (!CHARCLASS_REPLACE_RE.test(stmt.text) || !TRIM_REPLACE_RE.test(stmt.text)) continue;

    const fn = functionAtLine[stmt.startLine - 1];
    if (exemptFunctions && fn && exemptFunctions.has(fn)) continue;

    out.push({ line: stmt.startLine, found: stmt.text.slice(0, MAX_REGEX_LITERAL_LEN) });
  }
  return out;
}

/**
 * Scan the authored source tree and return every unsanctioned re-derivation,
 * each annotated with the repo-relative file path.
 */
function scanRepo(root) {
  return scanTree({
    root,
    scanDirs: SCAN_DIRS,
    scanExt: SCAN_EXT,
    onFile(rel, text) {
      if (rel === SELF_TEST_FILE) return []; // see SELF_TEST_FILE's own comment above
      return findSlugDerivationDrift(text, rel).map((d) => ({ file: rel, ...d }));
    },
  });
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write('ok slug-derivation-drift: no unsanctioned slug re-derivations outside core-utils.cts generateSlugInternal\n');
    return;
  }
  process.stderr.write('slug-derivation-drift: independent re-derivation(s) of the slug-generation seam found.\n');
  process.stderr.write('Use src/core-utils.cts `generateSlugInternal(text, maxLen)` instead of re-deriving\n');
  process.stderr.write('the collapse/trim (or transliterate/collapse/trim) slug shape:\n');
  for (const d of violations) {
    // `d.file` is exactly as attacker-controlled as `d.found`: a repo can
    // legally track a filename containing control bytes / bidi overrides,
    // and it is a fork-PR-authored value reaching a CI log the same way the
    // matched statement text does — sanitize it at the same reporting
    // boundary.
    process.stderr.write(`  ${sanitizeForReport(d.file)}:${d.line}  ${sanitizeForReport(d.found)}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findSlugDerivationDrift,
  scanRepo,
  buildLogicalStatements,
  stripComments,
  CHARCLASS_REPLACE_RE,
  TRIM_REPLACE_RE,
  FUNCTION_SCOPED_EXEMPTIONS,
  SCAN_DIRS,
  SCAN_EXT,
  SELF_TEST_FILE,
};

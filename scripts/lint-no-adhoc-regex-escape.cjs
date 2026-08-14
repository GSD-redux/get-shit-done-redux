#!/usr/bin/env node
'use strict';

/**
 * lint-no-adhoc-regex-escape.cjs — the whole-tree parity backstop for
 * `local/no-adhoc-regex-escape` (ADR-3212 §7 / #3412 Phase 1; test-matrix
 * row 30: "a 13th copy of the escape body anywhere in the tree" must fail
 * CI, not review).
 *
 * ## Why this exists alongside the ESLint rule
 *
 * `eslint.config.mjs` covers `src/**\/*.cts`, `scripts/**\/*.cjs`,
 * `tests/**\/*.cjs`, `hooks/**\/*.js`+`*.cjs`, and a short explicit list of
 * top-level `.js` files — but NOT every extension in every directory. A
 * whole-tree file-inventory check found `tests/fixtures/brand-typing/*.cts`
 * (6 files): `.cts` under `tests/` matches neither the `src/**\/*.cts` glob
 * (wrong directory) nor the `tests/**\/*.cjs` glob (wrong extension), so the
 * AST rule never sees them. A hand-rolled escape helper planted in a
 * directory/extension combination outside every `eslint.config.mjs` glob
 * would pass `npx eslint .` cleanly. This script closes that gap with a
 * plain-text, whole-repo-tree scan (mirrors scripts/lint-removed-but-needed.cjs's
 * SCAN_ROOTS + walk() + ExitError structure) instead of another eslint.config.mjs
 * glob entry, so growing the covered surface never depends on remembering to
 * add a new files: [...] block for the next unanticipated extension.
 *
 * ## What this checks
 *
 * Walks the ENTIRE repository tree (skipping node_modules/.git/dist/coverage/
 * .worktrees/.claude, mirroring eslint.config.mjs's global ignores), and for
 * every source-like file (.cjs/.js/.mjs/.cts/.ts), text-scans for a
 * `<expr>.replace(<regex-literal>, <string-literal>)` call whose regex
 * literal's character class matches the escape-all-metachars member set
 * (reusing `eslint-rules/no-adhoc-regex-escape.cjs`'s
 * `isEscapeAllMetacharsClassSource` — single source of truth for the shape,
 * per CLAUDE.md's Generative Fix Divergence guidance) and whose replacement
 * string is `'\$&'`. `src/pattern.cts` (the seam) and any line carrying a
 * trailing/preceding `// allow-adhoc-regex-escape: <reason>` comment are
 * exempt, mirroring the ESLint rule's own suppression convention.
 *
 * A plain regex/text scan (not a full parser) is a deliberate, disclosed
 * trade-off: it only needs to close the residual gap outside the AST rule's
 * glob coverage, not replace it — the AST rule remains the primary,
 * precision enforcement for everything it does cover.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { isEscapeAllMetacharsClassSource, SELF_REFERENCE_REPLACEMENT } = require('../eslint-rules/no-adhoc-regex-escape.cjs');

const ROOT = path.join(__dirname, '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.worktrees', '.claude']);
const SOURCE_EXT = new Set(['.cjs', '.js', '.mjs', '.cts', '.ts']);

// The seam owns this shape — not a violation of itself.
const SEAM_FILE_RE = /(?:^|\/)src\/pattern\.cts$/;

// NOTE: bin/install.js was considered for a blanket "generated bundle,
// downstream mirror" exemption (the same reasoning that excuses
// gsd-core/bin/lib/**/*.cjs below) but REJECTED after inspection —
// bin/install.js:1974 carries a genuine, hand-written `function
// escapeRegExp(value) { return value.replace(...); }` of its own (real
// executable code, not an embedded string copy of another file's content).
// It is therefore a real 13th-plus copy and deliberately left un-exempted;
// see this script's own findings for it.
const GENERATED_BUNDLE_FILES = new Set();

// The RuleTester fixture corpus for the ESLint rule itself. Row 24/25's
// `code:` fixtures deliberately contain the flagged shape as STRING DATA
// (inside String.raw / template literals) to prove the rule fires — this is
// not runnable production code, and the AST-based ESLint rule correctly does
// not fire on it either (it never becomes a real `.replace()` CallExpression
// in this file's own AST). This text-only scanner cannot make that
// distinction, so the file is exempted explicitly. Per the dispatch brief,
// this test file is a fixed contract and is not edited to route around this.
const RULE_FIXTURE_FILES = new Set(['tests/eslint-no-adhoc-regex-escape.test.cjs']);

// Two suppression conventions are honored, matching what actually appears in
// this repo: the rule's own per-finding `// allow-adhoc-regex-escape: <reason>`
// marker (mirrors no-adhoc-markdown-parsing's convention), and a native
// `// eslint-disable-next-line local/no-adhoc-regex-escape -- <reason>`
// directive (what tests/pattern.test.cjs's historical-oracle exemptions use —
// real ESLint already honors this natively; this text-only scanner has to
// recognize it explicitly since it does not run through ESLint's engine).
const ALLOW_COMMENT_RE = /allow-adhoc-regex-escape:\s*\S/;
const ESLINT_DISABLE_RE = /eslint-disable(?:-next-line|-line)?\b[^\n]*\bno-adhoc-regex-escape\b/;

function isSuppressedByComment(line) {
  return ALLOW_COMMENT_RE.test(line) || ESLINT_DISABLE_RE.test(line);
}

/**
 * Is `rel` (repo-relative, POSIX-slash) a tsc-generated `.cjs` mirror of a
 * `src/**\/*.cts` source (ADR-457)? Dynamic (checks the filesystem for the
 * sibling `.cts`) rather than a hardcoded list, so it tracks whichever `.cts`
 * modules exist without needing its own upkeep as the seam migration lands.
 * @param {string} rel
 * @param {string} root
 */
function isGeneratedLibMirror(rel, root) {
  if (!rel.startsWith('gsd-core/bin/lib/') || !rel.endsWith('.cjs')) return false;
  const candidateSrc = `src/${rel.slice('gsd-core/bin/lib/'.length, -'.cjs'.length)}.cts`;
  return fs.existsSync(path.join(root, candidateSrc));
}

// A permissive, single-pass extraction of `.replace(<regex-literal>,
// <string-literal>)` call text. Deliberately simple (no nested-nesting /
// multi-line-argument support) — this is a coverage backstop for the AST
// rule, not a replacement for it; every real census copy is a single-line
// `.replace(/[...]/g, '\$&')` call.
//
// ReDoS fix (#3412, CodeQL js/redos): the original outer alternation let a
// `[...]` run be consumed EITHER by the character-class branch OR one
// character at a time by the trailing catch-all branch, so on a failing
// match the engine explored both parses of every bracket pair — exponential
// (measured: n=26 -> 204ms, n=28 -> 791ms, n=30 -> 3475ms, ~2^n). Two
// independent fixes, both required, neither alone sufficient long-term:
//   (a) the trailing branch is now `[^/\\\n[\]]` — it excludes `[` and `]`,
//       so a bracket can only ever be consumed by the character-class
//       branch. This removes the ambiguity and makes matching linear.
//       Consequence: a regex literal containing a BARE unescaped `]`
//       outside a character class is no longer matched by this backstop —
//       acceptable, since this is a coverage backstop for the AST rule, not
//       a replacement for it, and no census shape has that form.
//   (b) every `*` is now a bounded quantifier (ADR-3212's locked
//       bounded-quantifiers decision) — a second line of defense that caps
//       worst-case work even if the grammar above is later loosened.
const REPLACE_CALL_RE = /\.replace\(\s{0,20}\/((?:\\.|\[(?:\\.|[^\]\\]){0,200}\]|[^/\\\n[\]]){1,400})\/([a-z]{0,10})\s{0,20},\s{0,20}(['"`])((?:\\.|(?!\3)[^\\]){0,400})\3\s{0,20}\)/g;

function unescapeSimpleStringLiteral(raw) {
  // Handles the two-char escapes this specific replacement string ever uses
  // (\\ and \$); good enough for the '\$&' shape this script looks for.
  return raw.replace(/\\(.)/g, '$1');
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  }
  catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/**
 * Pure: does `content` (the text of a single file) contain the
 * escape-all-metachars `.replace(<class>, '\$&')` shape on a line that is
 * NOT exempted by an `allow-adhoc-regex-escape:` comment?
 * @param {string} content
 * @returns {{ line: number }[]}
 */
function findViolations(content) {
  const violations = [];
  const lines = content.split('\n');
  let match;
  REPLACE_CALL_RE.lastIndex = 0;
  while ((match = REPLACE_CALL_RE.exec(content)) !== null) {
    const [, classSource, , , replacementRaw] = match;
    if (!isEscapeAllMetacharsClassSource(`[${classSource}]`)) continue;
    if (unescapeSimpleStringLiteral(replacementRaw) !== SELF_REFERENCE_REPLACEMENT) continue;

    const upToMatch = content.slice(0, match.index);
    const line = upToMatch.split('\n').length;
    const sameLine = lines[line - 1] || '';
    const prevLine = lines[line - 2] || '';
    if (isSuppressedByComment(sameLine) || isSuppressedByComment(prevLine)) continue;

    violations.push({ line });
  }
  return violations;
}

/**
 * Pure: scan the whole tree rooted at `root` and return every violation.
 * @param {string} root
 * @returns {{ file: string, line: number }[]}
 */
function scan(root) {
  const violations = [];
  for (const abs of walk(root)) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (SEAM_FILE_RE.test(rel)) continue;
    if (GENERATED_BUNDLE_FILES.has(rel)) continue;
    if (RULE_FIXTURE_FILES.has(rel)) continue;
    if (isGeneratedLibMirror(rel, root)) continue;
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    }
    catch {
      continue; // unreadable (broken symlink, binary) — skip
    }
    for (const v of findViolations(content)) {
      violations.push({ file: rel, line: v.line });
    }
  }
  return violations;
}

function main() {
  const violations = scan(ROOT);
  if (violations.length > 0) {
    const detail = violations.map((v) => `  ${v.file}:${v.line}`).join('\n');
    throw new ExitError(
      1,
      'lint-no-adhoc-regex-escape: a hand-rolled regex-metacharacter-escape\n'
        + '.replace(<escape-all-metachars class>, \'\\$&\') copy was found outside\n'
        + 'src/pattern.cts (ADR-3212 §7 / #3412, test-matrix row 30 — parity\n'
        + 'assertion). Import escapeRegex() from src/pattern.cts instead, or\n'
        + 'suppress a genuine non-production exception with a trailing\n'
        + '// allow-adhoc-regex-escape: <reason> comment:\n'
        + detail,
    );
  }
  console.log('ok lint-no-adhoc-regex-escape: no hand-rolled escape-metachars copy found outside src/pattern.cts');
}

module.exports = {
  findViolations,
  scan,
  walk,
  SOURCE_EXT,
  SKIP_DIRS,
};

if (require.main === module) runMain(main);

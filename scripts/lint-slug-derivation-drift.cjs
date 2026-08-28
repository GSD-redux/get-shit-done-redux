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
 * SECURITY-REVIEW HARDENING PASS (post-#3987 review, this same issue). Three
 * MAJOR findings from an isolated security review changed how this guard
 * works internally; every detail below reflects the FIXED behavior:
 *
 *   MAJOR 1 — exemption scoping was fail-open. The original tracker only
 *   updated `currentFunction` on a column-0 `function` line and never reset
 *   it, so an allowlisted function's exemption bled forward into every line
 *   until the NEXT top-level `function` declaration — a re-derivation
 *   planted anywhere in that dead zone (measured: 50 exempted lines for an
 *   11-line function) silently escaped detection. Fixed by computing each
 *   allowlisted function's REAL body extent via brace-depth matching on a
 *   string/comment/template-literal-masked copy of the file
 *   (`findAllowlistedFunctionExtents` / `maskNonCode` / `maskRegexLiterals`
 *   below) — a statement is only exempted if it falls strictly inside the
 *   named function's actual `{ ... }` body, nothing before or after.
 *
 *   MAJOR 2 — the old `CHARCLASS_REPLACE_RE`'s `[^\]]*` character-class body
 *   was matched directly against the UNBOUNDED joined-statement text, with no
 *   size limit, and was re-attempted from every `.replace(/[^` occurrence —
 *   quadratic on a single pathological line (measured 54s at 1.28MB). Fixed
 *   by routing every regex-literal extraction through
 *   `drift-scan.cjs`'s `readRegexLiteralAt` (a bounded, non-backtracking,
 *   single-pass tokenizer this guard imported but never called), so
 *   classification regexes only ever run against an already-delimited
 *   literal capped at `MAX_REGEX_LITERAL_LEN` characters. A
 *   `MAX_FILE_SIZE_BYTES` cap (see below) bounds total scan cost too.
 *
 *   MAJOR 3 — the detector was measurably narrow (15 of 25 known-equivalent
 *   re-derivation shapes evaded it). Widened, where cheap and
 *   false-positive-free, to also catch: `replaceAll` (alongside `replace`);
 *   a small enumerated closed set of trim-regex spellings (`[-]+` character
 *   class, parenthesized alternatives, `-*` quantifier, `\-` escaped
 *   hyphen, and alternative order swapped); the `{1,}` quantifier as an
 *   equivalent of `+`; `.split(<negated class>).join('-')` as an alternate
 *   collapse mechanism; the literal `new RegExp('[^a-z0-9]+', 'g')` form;
 *   and call arguments spanning multiple physical lines after `.replace(`
 *   (not just the existing leading-`.` chain-continuation case) via
 *   paren-depth-aware statement joining. Deliberately NOT chased (needs data
 *   flow, not textual matching): `new RegExp` built from a variable, and the
 *   two-statement/temp-var form — see the guard's test file for both, kept
 *   as documented known gaps.
 *
 * DETECTOR (measured against the real deleted shape and the real repo tree —
 * see the guard's own test file for the flag/TRUE/SANCTIONED/FALSE census). A
 * re-derivation is one logical STATEMENT — not merely one source LINE; a
 * chained `.replace()` call is routinely wrapped across several lines by this
 * repo's formatter — carrying BOTH:
 *   (a) a `.replace()`/`.replaceAll()` call whose first argument is a negated
 *       character class (a `/[^...]+/` regex literal, or the literal form
 *       `new RegExp('[^...]+', 'flags')`) and whose replacement argument is
 *       exactly `'-'` — collapsing every non-slug character run to a single
 *       hyphen — OR a `.split(<same negated class>).join('-')` pair doing the
 *       same collapse via a different API shape; AND
 *   (b) a `.replace()`/`.replaceAll()` call whose first argument is one of a
 *       small enumerated set of hyphen-trim regex spellings and whose
 *       replacement argument is exactly `''` — trimming leading/trailing
 *       hyphen runs.
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
 * labels) — a material false-positive rate. Scoping detection to one logical
 * statement (joining a chain's continuation lines — those starting with `.`
 * — AND any line still inside an unbalanced open `(` from a `.replace(`/
 * `.split(` call, back onto the statement that opened it) is what gives this
 * guard its precision.
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
 * scoped file, is still caught — and, post MAJOR-1 fix, so is one added
 * AFTER the exempted function's own closing brace):
 *   - `src/core-utils.cts` `generateSlugInternal` — the canonical owner
 *     itself. Its char-class collapse and hyphen-trim sit in two DIFFERENT
 *     statements today, so it escapes this detector BY CONSTRUCTION without
 *     needing an entry here. Listed explicitly anyway: an IMPLICIT escape is
 *     a latent bug — a future refactor that folds those two lines into one
 *     chained statement (functionally a no-op) must not silently make the
 *     guard start flagging its own owner.
 *   - `src/gsd2-import.cts` `slugify` — declared deliberately DIFFERENT from
 *     `generateSlugInternal` by #3883 (a distinct truncation contract: no
 *     60-char cap at all, vs the owner's default); it already calls the
 *     SHARED `transliterateForSlug` primitive, so this is not an independent
 *     re-derivation of the transliteration step — only of the collapse/trim
 *     shape it deliberately keeps un-consolidated.
 *   - `src/runtime-artifact-conversion.cts` `normalizeKimiSkillName` — a Kimi
 *     runtime skill-name normalizer in a completely different domain (CLI
 *     skill invocation names, never a `.planning/` phase/plan/milestone
 *     slug); its negated class (`[^a-z0-9-]`) deliberately PRESERVES
 *     hyphens (a skill name may already contain them), the opposite of the
 *     slug seam's contract. Shaped like the re-derivation textually; not one
 *     by domain.
 *   - `scripts/generate-package-identity.cjs` `slugifyPackageName` —
 *     npm-scope-name-to-cache-filename prep. Runs PRE-BUILD (`npm run
 *     generate:identity`, step 1 of `npm run build`, before `build:lib`
 *     compiles `src/core-utils.cts`), so it structurally cannot `require()`
 *     the seam it would otherwise route through.
 *
 * The tree-walk / root-confinement / regex-literal-tokenizer / sanitizer
 * machinery is SHARED with the sibling drift guards via
 * `scripts/lib/drift-scan.cjs` (ADR-3180 Decision 4).
 *
 * KNOWN, ACCEPTED limits of this scan (same tradeoff the sibling drift guards
 * document): `new RegExp` built from a variable (not a literal string) and
 * the two-statement/temp-var re-derivation form are NOT detected — both need
 * real data-flow analysis, which a textual heuristic cannot do safely without
 * risking noise; quoted-string and regex-literal recognition is single-line
 * only (matching `readRegexLiteralAt`'s own "a literal cannot span lines"
 * rule) — a re-derivation whose string/regex argument is itself broken across
 * a line via unescaped continuation is left unhandled, the same class of
 * tradeoff the sibling drift guards' own per-line scans document.
 */

const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { MAX_REGEX_LITERAL_LEN, sanitizeForReport, scanTree, readRegexLiteralAt } = driftScan;

// Authored source across the four surfaces the brief scopes this guard to.
// `gsd-core/bin/lib/**` (src/'s build output) and `bin/install.js` are never
// visited because they are not in this list — see the header comment.
const SCAN_DIRS = ['src', 'scripts', 'tests', 'eslint-rules'];
// `.mjs`/`.tsx`/`.jsx` added (MINOR fix): the original set silently never
// opened any file with these extensions under the scanned roots at all — not
// merely "no violations found", but genuinely unread.
const SCAN_EXT = new Set(['.cts', '.ts', '.mts', '.mjs', '.cjs', '.js', '.tsx', '.jsx']);

// MAJOR 2 defense-in-depth: an upper bound on the SIZE of any single file
// this guard will read and scan, independent of the bounded-tokenizer fix
// below. Every real file under SCAN_DIRS today is well under 200KB; 2MB is
// ~10x headroom over the largest legitimate source file in this repo, while
// still bounding the worst-case per-file cost a maliciously huge tracked
// file (e.g. a generated fixture accidentally checked in with a scanned
// extension) could impose — the bounded tokenizer fix makes a 1.28MB file
// fast (see the guard's own test file for the measured timing), but nothing
// stops a fork PR from adding a 50MB one, so a hard cap remains cheap
// insurance. Files over the cap are skipped (not flagged) — same "silently
// unreadable" treatment `scanTree` already gives a file it cannot open.
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

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

// Upper bound on a quoted-string argument this scanner will extract (e.g. a
// `.replace()` replacement argument). Mirrors MAX_REGEX_LITERAL_LEN's
// reasoning: every real replacement value this detector cares about (`'-'`,
// `''`) is one or zero characters, so this bound is pure headroom, never a
// real constraint, and it keeps `readQuotedStringAt` a bounded, linear,
// non-backtracking scan with no size-dependent cost.
const MAX_QUOTED_STRING_LEN = 200;

// Optional `export ` modifier, mirroring the sibling guards' function
// tracker — only a column-0 top-level `function` declaration is a candidate
// for a FUNCTION_SCOPED_EXEMPTIONS entry. (Its extent, once matched, is
// computed precisely via brace-depth — see `findAllowlistedFunctionExtents`
// — not merely "until the next line matching this regex", which was
// MAJOR-1's fail-open bug.)
const TOP_LEVEL_FUNCTION_RE = /^(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(/;

// Per the header comment: NOT a bare file allowlist — each entry is scoped
// to the SPECIFIC function, with its reason recorded above (mirroring
// `lint-completion-ratio-drift.cjs`'s `FUNCTION_SCOPED_EXEMPTIONS`). An
// unrelated re-derivation added anywhere else in these same files — INCLUDING
// after the named function's own closing brace — is still caught (MAJOR 1).
const FUNCTION_SCOPED_EXEMPTIONS = new Map([
  [path.join('src', 'core-utils.cts'), new Set(['generateSlugInternal'])],
  [path.join('src', 'gsd2-import.cts'), new Set(['slugify'])],
  [path.join('src', 'runtime-artifact-conversion.cts'), new Set(['normalizeKimiSkillName'])],
  [path.join('scripts', 'generate-package-identity.cjs'), new Set(['slugifyPackageName'])],
]);

// ─── Bounded, string/regex/comment-aware line tokenizer ───────────────────
//
// Every helper in this section works on ONE physical line (or a bounded
// slice of text) and is a straight left-to-right scan with no backtracking —
// the same non-catastrophic shape as `readRegexLiteralAt` in drift-scan.cjs,
// which this section reuses directly rather than re-deriving its own
// (weaker) character-class matcher, which is exactly the class of mistake
// MAJOR 2 found.

/**
 * Read a single/double/backtick-quoted string literal starting at
 * `text[start]`. Returns `{ text, inner, end }` (`text` includes the quotes,
 * `inner` is the content between them, `end` is one past the closing quote)
 * or `null` if no matching close is found within `MAX_QUOTED_STRING_LEN`
 * characters or before a newline — a quoted string, like a regex literal,
 * is not expected to span a line in the shapes this detector cares about.
 */
function readQuotedStringAt(text, start) {
  const quote = text[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const limit = Math.min(text.length, start + MAX_QUOTED_STRING_LEN);
  let i = start + 1;
  while (i < limit) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2; // escape consumes the next character, whatever it is
      continue;
    }
    if (ch === '\n') return null;
    if (ch === quote) return { text: text.slice(start, i + 1), inner: text.slice(start + 1, i), end: i + 1 };
    i++;
  }
  return null;
}

/**
 * Heuristic used to disambiguate a `/` as the START of a regex literal
 * (rather than division/a closing comment marker) — the standard
 * "what came before it" tokenizer rule: a regex may open at the start of a
 * line, or right after an operator/punctuation/`return` that can only be
 * followed by an expression, never a value. This is the same disambiguation
 * every one of this detector's real call sites (`.replace(/…/`,
 * `.split(/…/`) always satisfies (the char before `/` is always `(` or `,`),
 * so a conservative heuristic here costs nothing in practice.
 */
// Bound on the trailing-context buffer `looksLikeRegexStart` inspects. Long
// enough to see the word "return" plus a little slack; deliberately NOT the
// full accumulated output — see `looksLikeRegexStart`'s own comment for why
// that distinction is load-bearing (MAJOR-2 regression class).
const REGEX_START_TAIL_LEN = 10;

/**
 * `precedingTail` is a BOUNDED trailing slice of the text scanned so far
 * (see `REGEX_START_TAIL_LEN`), never the full accumulated output. This
 * matters: an earlier draft of this heuristic re-derived the tail from the
 * FULL output string on every `/` encountered, which is exactly MAJOR 2's
 * bug shape reintroduced one level up — `String.prototype.replace` on an
 * ever-growing string, called once per `/` in the input, is quadratic on a
 * long line with many `/` characters (measured: a 2.88MB adversarial line
 * took 12.5s with a full-string tail; a bounded tail is O(1) per call
 * regardless of total input size). Every CALLER of this function is
 * responsible for maintaining `precedingTail` as a small rolling buffer.
 */
function looksLikeRegexStart(precedingTail) {
  const trimmed = precedingTail.replace(/\s+$/, '');
  if (trimmed.length === 0) return true;
  const last = trimmed[trimmed.length - 1];
  if ('(,=:;[!&|?+-*%{'.includes(last)) return true;
  return trimmed.endsWith('return');
}

/** Bounded (O(1) w.r.t. total accumulated text) update of a rolling tail buffer. */
function updateTail(tail, appended) {
  return (tail + appended).slice(-REGEX_START_TAIL_LEN);
}

/**
 * Scan one physical line, string/regex-literal-aware, producing:
 *   - `text`: the line with any trailing `//` line-comment removed (a `//`
 *     found INSIDE a string or regex literal, e.g. `'http://x'`, is not a
 *     comment — MINOR fix: the previous version cut at the first `//`
 *     unconditionally);
 *   - `parenDelta`: net `(` minus `)` count, skipping any that appear inside
 *     a string or regex literal (so `.replace(/[)]/g, ')')`'s internal
 *     parens/regex content never desyncs a caller's paren-depth tracking);
 *   - `semicolons`: offsets (into `text`) of every top-level `;` — one NOT
 *     inside a string or regex literal (MINOR fix: the previous version did
 *     a naive `line.split(';')`, so a `;` embedded in a regex character
 *     class, e.g. `/[^a-z0-9;]+/`, wrongly split one statement into two).
 */
function scanLineTokens(line) {
  const n = line.length;
  let i = 0;
  let out = '';
  let tail = ''; // bounded rolling context for looksLikeRegexStart — see its comment
  let parenDelta = 0;
  const semicolons = [];
  while (i < n) {
    const ch = line[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const str = readQuotedStringAt(line, i);
      if (str) {
        out += str.text;
        tail = updateTail(tail, str.text);
        i = str.end;
        continue;
      }
      // Unterminated within bound/line: fail safe by consuming the rest of
      // the line as opaque text rather than re-entering character-by-character
      // scanning mid-string (which could misparse quote-internal punctuation
      // as code).
      out += line.slice(i);
      break;
    }
    if (ch === '/' && line[i + 1] === '/') break; // real line comment (not inside a string — handled above)
    if (ch === '/' && looksLikeRegexStart(tail)) {
      const lit = readRegexLiteralAt(line, i);
      if (lit) {
        out += lit.text;
        tail = updateTail(tail, lit.text);
        i = lit.end;
        continue;
      }
    }
    if (ch === '(') parenDelta++;
    else if (ch === ')') parenDelta--;
    else if (ch === ';') semicolons.push(out.length);
    out += ch;
    tail = updateTail(tail, ch);
    i++;
  }
  return { text: out, parenDelta, semicolons };
}

/**
 * Strip comment text from a line, string-literal-aware (MINOR fix). Full
 * doc-comment lines (`*`/`/**`-prefixed, or a bare `//` line) are blanked
 * outright, matching the previous behavior for this repo's jsdoc shape
 * (every line of a block comment here starts with `*`); anything else is run
 * through `scanLineTokens`, which only treats a `//` as a comment marker
 * when it is not inside a string or regex literal.
 */
function stripComments(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return '';
  return scanLineTokens(line).text;
}

/**
 * Join a chained method call's continuation lines (those whose trimmed,
 * comment-stripped text starts with `.`) back onto the line that opened the
 * chain, producing one "logical statement" per opening line; split a single
 * physical line into multiple statements at each top-level `;` (string/regex
 * -aware, see `scanLineTokens`); AND (MAJOR-3 widen) keep merging any
 * following line/fragment, regardless of whether it starts with `.`, while
 * the statement's own paren-depth (also string/regex-aware) is still open —
 * this is what recognizes a `.replace(`/`.split(` call whose arguments were
 * wrapped across lines WITHOUT a leading-`.` continuation on each one, e.g.:
 *
 *   x.replace(
 *     /[^a-z0-9]+/g,
 *     '-'
 *   ).replace(/^-+|-+$/g, '')
 *
 * A statement is only finalized (pushed, and merging stops) at a top-level
 * `;` once its own paren-depth has returned to zero — a `;` that appears
 * while still inside an open `(` (not a real shape for this detector's
 * `.replace()`/`.split()` call sites, but handled defensively) does not
 * split the statement.
 *
 * Returns `[{ startLine, text }]` — `startLine` is 1-based, matching the
 * sibling guards' reporting convention.
 */
function buildLogicalStatements(lines) {
  const statements = [];
  let current = null; // { startLine, text, openDepth }
  for (let i = 0; i < lines.length; i++) {
    const trimmedRaw = lines[i].trim();
    if (trimmedRaw.startsWith('*') || trimmedRaw.startsWith('/*') || trimmedRaw.startsWith('//')) continue; // full-line comment

    const { text: strippedLine, semicolons } = scanLineTokens(lines[i]);
    if (!strippedLine.trim()) continue; // blank/comment-only lines never break or start a statement

    const rawFragments = [];
    let cursor = 0;
    for (const pos of semicolons) {
      rawFragments.push(strippedLine.slice(cursor, pos));
      cursor = pos + 1;
    }
    rawFragments.push(strippedLine.slice(cursor));
    const fragments = rawFragments.map((f) => f.trim()).filter((f) => f.length > 0);

    for (let f = 0; f < fragments.length; f++) {
      const frag = fragments[f];
      const isFirstFragmentOfLine = f === 0;
      const isLastFragmentOfLine = f === fragments.length - 1;
      const midOpenParen = current !== null && current.openDepth > 0;

      if (isFirstFragmentOfLine && current && (midOpenParen || frag.startsWith('.'))) {
        current.text += ' ' + frag;
      } else {
        if (current) statements.push(current);
        current = { startLine: i + 1, text: frag, openDepth: 0 };
      }
      current.openDepth += scanLineTokens(frag).parenDelta;

      // A fragment that is not the LAST one on its line was terminated by a
      // top-level `;` immediately after it. It is a complete statement no
      // later fragment may merge into, UNLESS it is (defensively) still
      // inside an open paren — see the doc comment above.
      if (!isLastFragmentOfLine && current.openDepth <= 0) {
        statements.push(current);
        current = null;
      }
    }
  }
  if (current) statements.push(current);
  return statements;
}

// ─── Collapse / trim classification (operates on an EXTRACTED, bounded
// regex-literal body — never on unbounded raw text; this is the MAJOR-2 fix)

// A negated character class collapsed to a single hyphen — the class body is
// matched escape-aware (`\\.` or any non-`]`/non-`\` char), which is what
// lets `[^a-z0-9\]]` (an escaped `]` inside the class) parse correctly; the
// previous `[^\]]*` body matcher broke on exactly this shape (MINOR fix).
// Quantifier may be `+`, `*`, `{1,}` (MAJOR-3 widen: `{1,}` is `+`'s
// equivalent), or absent; an optional `\s*` may sit on either side of the
// class (MAJOR-3 widen). All bounded: this runs against an already-extracted
// literal body capped at MAX_REGEX_LITERAL_LEN, never unbounded text.
const COLLAPSE_BODY_RE = /^(?:\\s\*)?\[\^(?:\\.|[^\]\\])*\](?:[+*]|\{1,\})?(?:\\s\*)?$/;

function isCollapseBody(body) {
  return COLLAPSE_BODY_RE.test(body);
}

/**
 * Normalize the small enumerated set of equivalent hyphen-trim regex
 * spellings (MAJOR-3 widen) down to a canonical `^-<quant>|-<quant>$` shape
 * (in either order) before comparing: unwraps a `(^-+)`/`(-+$)` parenthesized
 * alternative, unescapes a literal `\-` to `-`, and collapses a `[-]`
 * single-hyphen character class to a bare `-`. Deliberately a small,
 * enumerated normalization — not a permissive catch-all regex — per the
 * review's instruction to widen ONLY where the resulting shape is a closed,
 * auditable set.
 */
function canonicalizeTrimBody(rawBody) {
  return rawBody
    .replace(/\((\^[^)]*)\)/g, '$1')
    .replace(/\(([^)]*\$)\)/g, '$1')
    .replace(/\\-/g, '-')
    .replace(/\[-\]/g, '-');
}

function isTrimBodyPart(part, anchor) {
  return anchor === 'start' ? /^\^-[+*]?$/.test(part) : /^-[+*]?\$$/.test(part);
}

function isTrimBody(rawBody) {
  const parts = canonicalizeTrimBody(rawBody).split('|');
  if (parts.length !== 2) return false;
  const [p1, p2] = parts;
  return (
    (isTrimBodyPart(p1, 'start') && isTrimBodyPart(p2, 'end')) ||
    (isTrimBodyPart(p2, 'start') && isTrimBodyPart(p1, 'end'))
  );
}

/** Split a bounded `/body/flags` regex-literal text into `{ body, flags }`, or null. */
function splitRegexLiteral(literalText) {
  const m = /^\/(.*)\/([a-z]*)$/.exec(literalText);
  return m ? { body: m[1], flags: m[2] } : null;
}

/**
 * Parse the literal-argument form `new RegExp('pattern'[, 'flags'])` starting
 * at `text[start]` (which must be the `n` of `new`). Only LITERAL string
 * arguments are handled — per the review's explicit instruction, a variable
 * built into `new RegExp(...)` needs data-flow analysis this textual scanner
 * does not attempt, and is a documented known gap, not silently mishandled.
 * Returns `{ body, flags, end }` or null.
 */
function parseNewRegExpLiteral(text, start) {
  if (text.slice(start, start + 10) !== 'new RegExp') return null;
  let i = start + 10;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '(') return null;
  i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  const patternArg = readQuotedStringAt(text, i);
  if (!patternArg) return null;
  i = patternArg.end;
  while (i < text.length && /\s/.test(text[i])) i++;
  let flags = '';
  if (text[i] === ',') {
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    const flagsArg = readQuotedStringAt(text, i);
    if (flagsArg) {
      flags = flagsArg.inner;
      i = flagsArg.end;
      while (i < text.length && /\s/.test(text[i])) i++;
    }
  }
  if (text[i] !== ')') return null;
  return { body: patternArg.inner, flags, end: i + 1 };
}

/**
 * Find every `.replace(...)`/`.replaceAll(...)` call in `text` (MAJOR-3
 * widen: `replaceAll` alongside `replace`) whose first argument is a
 * recognizable regex (a `/…/` literal OR the literal `new RegExp(...)` form)
 * and whose second argument is a quoted string, returning
 * `[{ body, flags, replacement }]`. All literal extraction is bounded
 * (`readRegexLiteralAt`/`readQuotedStringAt`), so this is safe to run against
 * a long statement text — the MAJOR-2 fix.
 */
function findReplaceCalls(text) {
  const calls = [];
  const callRe = /\.(replace|replaceAll)\(/g;
  while (callRe.exec(text)) {
    let idx = callRe.lastIndex;
    while (idx < text.length && /\s/.test(text[idx])) idx++;
    let regexInfo = null;
    if (text[idx] === '/') {
      const lit = readRegexLiteralAt(text, idx);
      if (lit) {
        const split = splitRegexLiteral(lit.text);
        if (split) {
          regexInfo = split;
          idx = lit.end;
        }
      }
    } else if (text.slice(idx, idx + 10) === 'new RegExp') {
      const parsed = parseNewRegExpLiteral(text, idx);
      if (parsed) {
        regexInfo = { body: parsed.body, flags: parsed.flags };
        idx = parsed.end;
      }
    }
    if (!regexInfo) continue;
    while (idx < text.length && /[\s,]/.test(text[idx])) idx++;
    const replacementArg = readQuotedStringAt(text, idx);
    calls.push({ regexInfo, replacement: replacementArg ? replacementArg.inner : null });
  }
  return calls;
}

/**
 * MAJOR-3 widen: `.split(<negated class>).join('-')` is an alternate way to
 * express the SAME collapse-to-hyphen shape as
 * `.replace(<negated class>, '-')`. Only the literal-regex `.split(/…/)` form
 * is handled (mirrors `findReplaceCalls`'s own `new RegExp` literal-only
 * scope for the same textual-scan-cannot-do-data-flow reason).
 */
function findSplitJoinCollapse(text) {
  const splitRe = /\.split\(\s*/g;
  while (splitRe.exec(text)) {
    const argStart = splitRe.lastIndex;
    if (text[argStart] !== '/') continue;
    const lit = readRegexLiteralAt(text, argStart);
    if (!lit) continue;
    let after = lit.end;
    while (after < text.length && /\s/.test(text[after])) after++;
    if (text[after] !== ')') continue;
    after++;
    const joinMatch = /^\s*\.join\(\s*(['"`])-\1\s*\)/.exec(text.slice(after, after + 32));
    if (!joinMatch) continue;
    const split = splitRegexLiteral(lit.text);
    if (split && isCollapseBody(split.body)) return true;
  }
  return false;
}

/** True if `stmtText` (one logical statement) carries both the collapse and trim clauses. */
function statementHasSlugDerivation(stmtText) {
  let hasCollapse = false;
  let hasTrim = false;
  for (const call of findReplaceCalls(stmtText)) {
    if (call.replacement === null) continue;
    if (call.replacement === '-' && isCollapseBody(call.regexInfo.body)) hasCollapse = true;
    if (call.replacement === '' && isTrimBody(call.regexInfo.body)) hasTrim = true;
  }
  if (!hasCollapse) hasCollapse = findSplitJoinCollapse(stmtText);
  return hasCollapse && hasTrim;
}

// ─── MAJOR-1 fix: precise allowlisted-function body extent ────────────────
//
// Computes the REAL `{ ... }` body range of each allowlisted function via
// brace-depth matching on a masked copy of the file (comments, strings, and
// template literals replaced with same-length whitespace/newlines) — not
// "from this column-0 `function` line until the next one", which is what let
// the exemption bleed past the function it names.

/** Find the index one past a single/double-quoted string starting at `start`, masking is caller's job. Multi-line-safe (unlike readQuotedStringAt, which is intentionally single-line for the DETECTOR's own bounded-scan needs). */
function findQuotedEndMultiline(text, start) {
  const quote = text[start];
  const n = text.length;
  let i = start + 1;
  while (i < n) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return n;
}

/**
 * Find the index one past a backtick template literal starting at `start`,
 * recursively skipping nested `${ ... }` substitutions (which may themselves
 * contain nested templates/strings/comments/braces). Every brace opened
 * inside a substitution closes inside that SAME substitution (it is valid
 * JS/TS), so masking the whole template literal — substitutions included —
 * as non-code is safe for the purpose of an ENCLOSING function's brace-depth
 * extent: any braces inside it are locally balanced and net to zero either
 * way.
 */
function findTemplateEnd(text, start) {
  const n = text.length;
  let i = start + 1;
  const substitutionDepths = [];
  while (i < n) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (substitutionDepths.length === 0) {
      if (text[i] === '`') return i + 1;
      if (text[i] === '$' && text[i + 1] === '{') {
        substitutionDepths.push(1);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (text[i] === '`') {
      i = findTemplateEnd(text, i);
      continue;
    }
    if (text[i] === "'" || text[i] === '"') {
      i = findQuotedEndMultiline(text, i);
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const j = text.indexOf('*/', i + 2);
      i = j === -1 ? n : j + 2;
      continue;
    }
    if (text[i] === '{') {
      substitutionDepths[substitutionDepths.length - 1]++;
      i++;
      continue;
    }
    if (text[i] === '}') {
      substitutionDepths[substitutionDepths.length - 1]--;
      if (substitutionDepths[substitutionDepths.length - 1] === 0) substitutionDepths.pop();
      i++;
      continue;
    }
    i++;
  }
  return n; // unterminated -> EOF (fail-closed: masked to end of file, never past it)
}

/**
 * Replace every comment, string, and template literal in `text` with
 * same-length whitespace (preserving newlines, so downstream line-number math
 * stays correct), leaving all other characters — including every REAL code
 * brace/paren — untouched.
 */
function maskNonCode(text) {
  const n = text.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const two = text.slice(i, i + 2);
    if (two === '//') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (two === '/*') {
      const found = text.indexOf('*/', i + 2);
      const j = found === -1 ? n : found + 2;
      for (let k = i; k < j; k++) out += text[k] === '\n' ? '\n' : ' ';
      i = j;
      continue;
    }
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const j = findQuotedEndMultiline(text, i);
      for (let k = i; k < j; k++) out += text[k] === '\n' ? '\n' : ' ';
      i = j;
      continue;
    }
    if (ch === '`') {
      const j = findTemplateEnd(text, i);
      for (let k = i; k < j; k++) out += text[k] === '\n' ? '\n' : ' ';
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Second masking pass, run PER LINE (regex literals cannot span lines) over
 * text already comment/string/template-masked by `maskNonCode`: masks any
 * regex literal so an unbalanced brace inside a character class (e.g.
 * `/[{]/`) cannot desync brace-depth counting for an enclosing function.
 */
function maskRegexLiterals(masked) {
  return masked
    .split('\n')
    .map((line) => {
      let out = '';
      let tail = ''; // bounded rolling context — see looksLikeRegexStart's comment
      let i = 0;
      while (i < line.length) {
        if (line[i] === '/' && looksLikeRegexStart(tail)) {
          const lit = readRegexLiteralAt(line, i);
          if (lit) {
            const masked = ' '.repeat(lit.end - i);
            out += masked;
            tail = updateTail(tail, masked);
            i = lit.end;
            continue;
          }
        }
        out += line[i];
        tail = updateTail(tail, line[i]);
        i++;
      }
      return out;
    })
    .join('\n');
}

/** Find the index of the `{`/`}` that closes the one opened at `openIdx` in `masked`, or -1 (unterminated -> caller decides fallback). */
function findMatchingBrace(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Find the index of the `)` that closes the `(` at `openIdx` in `masked`, or -1. */
function findMatchingParen(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Compute `{ startLine, endLine }` (1-based, inclusive) for every function in
 * `exemptFunctionNames` that is declared as a column-0 top-level
 * `function name(` in `text`. Brace-depth matching runs on `masked`
 * (comments/strings/templates/regex-literals all masked to whitespace), so
 * only REAL code braces/parens are counted — a destructured parameter like
 * `function f({ a, b }) { ... }`'s own braces are correctly skipped past via
 * paren-matching of the parameter list BEFORE brace-matching begins.
 */
function findAllowlistedFunctionExtents(text, exemptFunctionNames) {
  if (!exemptFunctionNames || exemptFunctionNames.size === 0) return [];
  const masked = maskRegexLiterals(maskNonCode(text));
  const lines = text.split('\n');
  const lineStartOffsets = [];
  let offset = 0;
  for (const line of lines) {
    lineStartOffsets.push(offset);
    offset += line.length + 1; // +1 for the '\n' split removed
  }

  const extents = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TOP_LEVEL_FUNCTION_RE.exec(lines[i]);
    if (!m || !exemptFunctionNames.has(m[1])) continue;

    const declStart = lineStartOffsets[i];
    const parenIdx = masked.indexOf('(', declStart);
    if (parenIdx === -1) continue;
    const parenEnd = findMatchingParen(masked, parenIdx);
    if (parenEnd === -1) continue;
    const braceIdx = masked.indexOf('{', parenEnd);
    if (braceIdx === -1) continue;
    const braceEnd = findMatchingBrace(masked, braceIdx);
    const endOffset = braceEnd === -1 ? masked.length - 1 : braceEnd;

    let endLine = lines.length - 1;
    for (let li = 0; li < lineStartOffsets.length; li++) {
      if (lineStartOffsets[li] > endOffset) {
        endLine = li - 1;
        break;
      }
    }
    extents.push({ name: m[1], startLine: i + 1, endLine: endLine + 1 });
  }
  return extents;
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
  const exemptExtents = exemptFunctions ? findAllowlistedFunctionExtents(text, exemptFunctions) : [];

  for (const stmt of buildLogicalStatements(lines)) {
    if (!statementHasSlugDerivation(stmt.text)) continue;

    const inExemptExtent = exemptExtents.some(
      (ext) => stmt.startLine >= ext.startLine && stmt.startLine <= ext.endLine,
    );
    if (inExemptExtent) continue;

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
      if (Buffer.byteLength(text, 'utf8') > MAX_FILE_SIZE_BYTES) return []; // see MAX_FILE_SIZE_BYTES's own comment above
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
  scanLineTokens,
  isCollapseBody,
  isTrimBody,
  COLLAPSE_BODY_RE,
  findAllowlistedFunctionExtents,
  FUNCTION_SCOPED_EXEMPTIONS,
  SCAN_DIRS,
  SCAN_EXT,
  SELF_TEST_FILE,
  MAX_FILE_SIZE_BYTES,
};

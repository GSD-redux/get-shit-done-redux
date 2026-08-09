#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the STATE.md FIELD-EXTRACTION FALLBACK
 * CHAIN (epic #3180, issue #3187, ADR-3180 Decision 4, spec §7.7).
 *
 * The derivation this guard protects is "read a STATE.md field: prefer the
 * YAML frontmatter scalar (string, trimmed-non-empty; or number/boolean
 * coerced to a string), else fall back to the body field via
 * `stateExtractField(body, bodyField)`". `src/state-document.cts` is
 * DESIGNATED the single canonical owner of this grammar (issue #3187 Phase
 * 5), but as of this guard's authorship (Phase 5's guard-first step, per
 * ADR-3180 Amendment 3's standing rule) the canonical function does not yet
 * exist there — this script is written to discover every existing
 * re-derivation BEFORE any src/ file is touched, exactly the ordering
 * `lint-plan-count-drift.cjs` and its siblings established.
 *
 * Per ADR-3180 Decision 4(a) this guard discovers call sites by SCANNING THE
 * WHOLE `src/` TREE, not by consulting an allowlist of known files.
 *
 * DETECTION: FUNCTION-SCOPED CO-OCCURRENCE, not a bounded line-window.
 * An earlier draft of this guard used a fixed line-distance window between
 * the ladder and the fallback call. That shape was REJECTED: it produced a
 * documented "known miss" on live copies inside the very function it was
 * scanning (state.cts `cmdStateSnapshot`'s `Current Plan` / `Total Plans in
 * Phase` / `Status` / `Progress` / `Last Activity` reads all sit further
 * from the ladder than any defensible line count), which means the guard
 * could report "0 re-derivations" after only the nearest few copies were
 * migrated while several more of the SAME kind survived untouched in the
 * SAME function — "a zero it did not earn" (ADR-3180 Decision 4(a)). A fixed
 * N is also trivially gameable by reflow (Goodhart's law): moving a call one
 * line further from its ladder silences the guard without changing the
 * derivation at all. The window is dropped entirely; there is no magic
 * number anywhere in this detection.
 *
 * The invariant instead: a NAMED FUNCTION that BOTH (a) contains a
 * "frontmatter scalar coercion ladder" line — `typeof <ident> === 'number'
 * || typeof <ident> === 'boolean'` (LADDER_RE; often, but not necessarily,
 * preceded by a `typeof <ident> === 'string'` branch — see the ternary shape
 * in `cmdStatePrune` below) — ANYWHERE in its own body, INCLUDING inside a
 * nested closure it defines, AND (b) calls `stateExtractField(` anywhere in
 * that same body, is re-deriving the fm-else-body fallback chain. EVERY
 * `stateExtractField(` call line inside such a function is reported, not
 * just the first.
 *
 * FUNCTION ATTRIBUTION. Two declaration shapes are recognised as opening a
 * new named function scope:
 *   - `function NAME(...) {` (FUNCTION_DECL_RE) — top-level OR nested, at
 *     any indentation. `src/smart-entry.cts`'s `fmScalar` (line 144) is this
 *     shape, and is itself top-level.
 *   - `const NAME = (...): ReturnType => {` (ARROW_CONST_RE) — an arrow
 *     function assigned to a `const`, with a block body (`=> {`, not an
 *     expression body like `=> ({...})`, which never opens a new function
 *     frame — its `{` is an object literal, still counted toward brace
 *     depth, but attributes no name). `src/state.cts`'s `cmdStateSnapshot`
 *     defines its `fmScalar` (line 1464) this way, NESTED inside
 *     `cmdStateSnapshot` itself.
 * `ARROW_CONST_RE`'s pattern requires `=>\s*\{` literally, so it only ever
 * matches a line that already carries its opening brace — pushed
 * immediately. `FUNCTION_DECL_RE` carries no such guarantee: a multi-line
 * signature (parameters and/or a return-type annotation spilling onto later
 * lines) matches on a line with NO `{` at all. An earlier version of this
 * guard pushed such a match immediately anyway, recording `openDepth` at the
 * ENCLOSING scope's depth rather than the function's own — for a top-level
 * function, `openDepth: 0`, and because real code never reaches negative
 * depth, a frame pushed with `openDepth: 0` could NEVER pop, sitting at the
 * bottom of the stack for the rest of the file and silently misattributing
 * every later line with no OTHER open frame to it. `src/state.cts`'s
 * `preferNewerLastActivity` (a 4-line signature, `{` on its own line) is the
 * live instance that surfaced this; it caused no observed false violation
 * only because nothing ever called `stateExtractField(` at true module scope
 * after it, not because the tracking was sound. `buildFunctionInfo` now
 * DEFERS a `FUNCTION_DECL_RE` match (`pendingDeclName`) across lines until
 * the first subsequent line whose brace count actually increases, and pushes
 * the frame THERE, with `openDepth` computed from that line's `depth` —
 * matching every other frame's push convention. A pending name is abandoned
 * (never pushed) if a `;` terminates the statement before any `{` appears —
 * a type-only declaration, `declare function`, or overload signature, none
 * of which open a body.
 * Function scopes NEST via a brace-depth stack: entering either shape pushes
 * a frame; the frame pops once brace depth returns below the depth recorded
 * when it was pushed. A line is attributed to the INNERMOST currently-open
 * named frame (falling back to whatever enclosing frame IS open — typically
 * the nearest enclosing top-level function — when a line sits between two
 * sibling nested scopes; module-level code with no open frame is
 * unattributed and therefore never a violation, matching "if you cannot
 * identify one" in the design brief).
 *
 * TRANSITIVE ladder attribution is what makes `cmdStateSnapshot` (whose
 * OWN top-level statements never spell the ladder themselves — only its
 * nested `fmScalar` closure does) still register as ladder-bearing: when
 * LADDER_RE matches a line, EVERY frame currently open on the stack at that
 * point — not just the innermost — is marked ladder-bearing, because a
 * nested closure's body is lexically part of every one of its enclosing
 * functions' own bodies. `stateExtractField(` calls are attributed to the
 * INNERMOST frame only (no transitivity needed there: the call already sits
 * directly inside whichever frame is innermost at that point).
 *
 * BRACE-DEPTH COUNTING runs over `scanCode`'s per-line, cross-file output
 * (see that function's own header for the full rationale and the concrete
 * bug its cross-line comment/template tracking fixes) — comments and
 * quoted/backtick string and template literal CONTENTS are already removed
 * before a single brace is counted, escape-aware and threaded across line
 * boundaries, so neither a brace inside a string (`{ label: '{' }`) nor one
 * inside a multi-line block comment or template literal perturbs the depth
 * count. It does NOT specially recognise regex literals (a `{` inside a
 * `/.../ ` quantifier, e.g. `/x{2,3}/`, is counted as a plain character);
 * see `scanCode`'s header for why every such literal actually present in
 * `src/` today is harmless (balanced on its own line).
 *
 * MUST-NOT-FLAG case verified by running the guard (the earlier "case
 * variant chain" exemption for `src/state.cts:1488` was WRONG and is
 * SUPERSEDED — see the header of the guard's initial version in git history
 * for the retracted reasoning; `cmdStateSnapshot` is ladder-bearing, so
 * *every* `stateExtractField(` call inside it, including line 1488, is
 * correctly a violation now):
 *   - `src/smart-entry.cts`'s `fmScalarKey` (lines 152-158): its own
 *     `typeof v === 'number' || typeof v === 'boolean'` ladder (line 156)
 *     reads a value out of a NESTED frontmatter object and never calls
 *     `stateExtractField(` anywhere in its own body — it is ladder-bearing
 *     but call-free, so it is correctly never flagged. This is the live
 *     control case proving the guard still distinguishes "has a ladder" from
 *     "re-derives the fallback chain": a ladder alone, with no body
 *     fallback call in the same function, is a different question (reading
 *     a nested frontmatter object, full stop) and stays silent.
 *   - Any ladder or `stateExtractField(` call appearing inside a `//` line
 *     comment or a `/* *\/`-style block comment (single- or multi-line).
 *     `scanCode` blanks comment text — cross-line-aware — before either
 *     regex runs, so prose describing this derivation is never mistaken for
 *     a copy of it (ADR-3180 Amendment 3's "trains readers to reflexively
 *     exempt documentation" note).
 *
 * FUNCTION-SCOPED EXEMPTIONS (per ADR-3180 Decision 4(a): NEVER a bare
 * whole-file allowlist — Decision 4(d) records that a whole-file exemption
 * on the owner is precisely how `getMilestoneInfo` stayed invisible to an
 * earlier guard). `src/state-document.cts` is the owner of this grammar;
 * its `stateFieldValue` (added for issue #3187 Phase 5, landed in this same
 * working tree while this guard was being authored — see the guard's commit
 * history / PR for the exact sequencing) IS the canonical
 * frontmatter-scalar-then-body-field chain, not a copy of it, so it is the
 * ONLY entry in FUNCTION_SCOPED_EXEMPTIONS. Every other function in
 * `state-document.cts` — including any future re-derivation added anywhere
 * else in that file — is still scanned and still flagged (mirrors
 * `lint-completion-ratio-drift.cjs`'s `FUNCTION_SCOPED_EXEMPTIONS` for
 * `clampPercent`/`clampPercentFromFraction`).
 *
 * Every regex below is small, bounded, and has no nested/overlapping
 * quantifiers; the string-literal and brace scans are plain escape-aware
 * character loops, not regexes, so there is nothing for a backtracking
 * engine to explore. `npm run lint:ci` runs CodeQL js/redos over this repo;
 * mirrors the ReDoS discipline of the sibling drift guards.
 *
 * The tree-walk / root-confinement / sanitizer machinery is SHARED with the
 * sibling drift guards via `scripts/lib/drift-scan.cjs` (ADR-3180 Decision
 * 4). This guard's detection shape needs no regex-literal extraction, so it
 * does not use `readRegexLiteralAt`; the reported fragment is simply the
 * trimmed source line, bounded to MAX_REGEX_LITERAL_LEN characters.
 *
 * KNOWN, ACCEPTED limits of this scan: a re-derivation whose ladder and
 * fallback call sit in two DIFFERENT named functions with no shared
 * enclosing scope (e.g. a ladder in one file-level helper, consumed by a
 * caller in another function that itself calls `stateExtractField(` for an
 * unrelated field) is not caught — this guard's unit is "one named
 * function's own body, including its nested closures", not the whole
 * call graph. That is left to code review, not this regex.
 */

const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { MAX_REGEX_LITERAL_LEN, sanitizeForReport, scanTree } = driftScan;

// The frontmatter scalar coercion ladder's number/boolean branch — the one
// line common to every observed copy of this derivation. `\1` requires the
// SAME identifier on both sides of `||` (via a backreference), so unrelated
// `typeof a === 'number' || typeof b === 'boolean'` comparisons on two
// different variables never match. No nested/overlapping quantifiers: each
// `\s*` run is bounded by the next required literal token.
// No trailing `\b` after `'boolean'`: the literal already ends on the
// closing quote (a non-word character), so a `\b` there would require a
// word/non-word transition between two non-word characters (`'` then `)` or
// whitespace) — which never holds, and silently made this regex match
// nothing at all when first written. The quoted literal is unambiguous on
// its own; no boundary anchor is needed after it.
const LADDER_RE = /\btypeof\s+([A-Za-z_$][\w$]*)\s*===\s*'number'\s*\|\|\s*typeof\s+\1\s*===\s*'boolean'/;

// The body-fallback call whose presence, inside a ladder-bearing function,
// makes that function a re-derivation of the "frontmatter-else-body" grammar.
const STATE_EXTRACT_FIELD_CALL_RE = /\bstateExtractField\(/;

// Named function scope openers. Each requires its own opening `{` on the
// SAME line as the signature — see the header's "FUNCTION ATTRIBUTION"
// paragraph for the documented limitation and why it does not affect either
// real copy this guard was written against.
//   - `function NAME(...) {` — top-level OR nested, any indentation.
const FUNCTION_DECL_RE = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/;
//   - `const NAME = (...): ReturnType => {` — block-bodied arrow assigned to
//     a const. `[^)]*` and `[^=]*` are bounded, single-purpose character
//     classes (no nested/overlapping quantifiers): the former stops at the
//     parameter list's closing paren, the latter at the arrow itself.
const ARROW_CONST_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*(?::\s*[^=]+)?=>\s*\{/;

// Authored TypeScript source only (the generated bin/lib/*.cjs mirror it).
const SCAN_DIRS = ['src'];
const SCAN_EXT = new Set(['.cts', '.ts', '.mts']);

// The designated owner (issue #3187 Phase 5, ADR-3180 §7.7).
const OWNER_FILE = path.join('src', 'state-document.cts');

// Per ADR-3180 Decision 4(a): function-scoped, NEVER a bare file allowlist —
// Decision 4(d) records that a whole-file exemption on the owner is
// precisely how `getMilestoneInfo` stayed invisible to an earlier guard.
// Only `stateFieldValue` itself is exempt: it IS the canonical
// frontmatter-scalar-then-body-field chain (holds the ladder AND calls
// `stateExtractField(` by construction, in its own body — that is its whole
// job), not a copy of it. Every OTHER function in this same file — including
// any future re-derivation added anywhere else in state-document.cts — is
// still scanned and still flagged; nothing else in this file is exempt.
const FUNCTION_SCOPED_EXEMPTIONS = new Map([[OWNER_FILE, new Set(['stateFieldValue'])]]);

/**
 * Tokenize the WHOLE file into TWO parallel per-line views, from ONE
 * single-pass, escape-aware character scan (not a regex — no backtracking
 * cost to bound):
 *   - `detect[i]`: comments stripped, but string/template literal contents
 *     KEPT VERBATIM (quotes included). This is what the detection regexes
 *     (LADDER_RE / STATE_EXTRACT_FIELD_CALL_RE / FUNCTION_DECL_RE /
 *     ARROW_CONST_RE) run against — they need the literal quoted text
 *     `'number'` / `'boolean'` to still be present.
 *   - `braces[i]`: comments AND string/template literal CONTENTS stripped,
 *     used only for brace-depth counting, so a brace character written
 *     inside a string (e.g. `{ label: '{' }`) never perturbs the count.
 *
 * This REPLACES two earlier, narrower designs in turn:
 *   1. Two independent per-line helpers (`stripComments` + a separate
 *      `stripStringLiterals`), each with no cross-line state. That design
 *      missed a `/* ... *\/`-style block comment whose CLOSING line also
 *      carries trailing real code (e.g. a `catch { /* comment` opener
 *      followed by ` * more comment. *\/ }` on a later line): the old
 *      per-line `stripComments` heuristic ("a line whose trimmed text starts
 *      with `*` is entirely comment") blanked that closing line WHOLESALE,
 *      silently dropping the real `}` it also carried, which left a
 *      function's brace-depth frame permanently open and made every LATER
 *      `stateExtractField(` call in the file — inside unrelated functions —
 *      inherit that stale frame's ladder-bearing status (`src/state.cts`'s
 *      `cmdStateValidate`, which has no ladder of its own, was falsely
 *      flagged this way).
 *   2. A single merged output that dropped string CONTENTS unconditionally.
 *      That fixed (1) but broke detection outright: LADDER_RE needs the
 *      literal text `'number'`/`'boolean'` (with quotes) to match, and a
 *      merged output that strips quote contents for brace-safety also
 *      erases the very tokens the ladder regex looks for — every ladder
 *      line silently stopped matching. Two views, not one, is what lets
 *      each consumer see what it actually needs.
 *
 * `inBlockComment` and `inTemplate` are threaded ACROSS lines so a block
 * comment or a multi-line backtick template literal spanning several source
 * lines is tracked correctly regardless of what trails its closing
 * delimiter. Regex literals are NOT specially recognised (documented,
 * narrow, known limitation, same as the sibling drift guards'
 * `readRegexLiteralAt`-free scans): a `/` is only ever treated as a comment
 * opener when immediately followed by another `/` or `*`, so an ordinary
 * regex literal's slashes pass through as plain characters and any brace
 * inside one (e.g. `/x{2,3}/`) is counted like any other character —
 * verified harmless for every regex literal actually present in `src/`
 * today because each is balanced (equal opens/closes) on its own line, so it
 * never desyncs the running depth total even though the individual
 * characters are not "understood" as a literal.
 */
function scanCode(lines) {
  const detect = new Array(lines.length);
  const braces = new Array(lines.length);
  let inBlockComment = false;
  let inTemplate = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let outDetect = '';
    let outBraces = '';
    let i = 0;
    if (inTemplate) {
      const start = i;
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2;
          continue;
        }
        if (line[i] === '`') {
          i++;
          inTemplate = false;
          break;
        }
        i++;
      }
      outDetect += line.slice(start, i); // template contents kept verbatim for detect
      if (inTemplate) {
        detect[li] = outDetect;
        braces[li] = ''; // whole line still inside the unterminated template
        continue;
      }
    }
    while (i < line.length) {
      if (inBlockComment) {
        const close = line.indexOf('*/', i);
        if (close === -1) {
          i = line.length;
          break;
        }
        i = close + 2;
        inBlockComment = false;
        continue;
      }
      const ch = line[i];
      if (ch === '/' && line[i + 1] === '/') {
        i = line.length; // rest of line is a line comment
        break;
      }
      if (ch === '/' && line[i + 1] === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const quote = ch;
        const start = i;
        let j = i + 1;
        while (j < line.length) {
          if (line[j] === '\\') {
            j += 2; // escape consumes the next character, whatever it is
            continue;
          }
          if (line[j] === quote) {
            j++;
            break;
          }
          j++;
        }
        outDetect += line.slice(start, j); // string kept verbatim for detect
        // (nothing appended to outBraces — string contents excluded from depth counting)
        i = j;
        continue;
      }
      if (ch === '`') {
        const start = i;
        let j = i + 1;
        let closed = false;
        while (j < line.length) {
          if (line[j] === '\\') {
            j += 2;
            continue;
          }
          if (line[j] === '`') {
            j++;
            closed = true;
            break;
          }
          j++;
        }
        if (!closed) {
          outDetect += line.slice(start); // rest of line kept verbatim for detect
          inTemplate = true;
          i = line.length;
          break;
        }
        outDetect += line.slice(start, j); // template kept verbatim for detect
        i = j;
        continue;
      }
      outDetect += ch;
      outBraces += ch;
      i++;
    }
    detect[li] = outDetect;
    braces[li] = outBraces;
  }
  return { detect, braces };
}

/**
 * Pure: find every unsanctioned STATE.md field-extraction fallback-chain
 * re-derivation in `text`. `relPath` is the repo-relative path, used both to
 * report file:line and to apply the function-scoped owner exemptions above.
 *
 * Two passes over the same line array:
 *   PASS 1 walks the file once, maintaining a brace-depth stack of open
 *     named function frames, and records which function NAMES are
 *     ladder-bearing (transitively — see the header's "TRANSITIVE ladder
 *     attribution" paragraph) and, per source line, which frame is
 *     INNERMOST at that line (for call attribution) — {@link buildFunctionInfo}.
 *   PASS 2 walks the lines again; any `stateExtractField(` call whose
 *     innermost enclosing function is ladder-bearing (and not
 *     function-scoped-exempt) is a violation.
 * Returns [{ line, found }].
 */
function buildFunctionInfo(lines) {
  const { detect, braces } = scanCode(lines);
  const ladderBearing = new Set();
  const innermostAt = new Array(lines.length).fill(null);
  const stack = []; // { name, openDepth }
  let depth = 0;
  // A `function NAME(` match whose own line carries no `{` (a multi-line
  // signature — parameters and/or a return-type annotation spilling onto
  // later lines before the body opens) — awaiting the line that actually
  // carries its opening brace. See the header's "FUNCTION ATTRIBUTION"
  // paragraph and this function's own doc comment for why this cannot be
  // pushed onto `stack` immediately: pushing it with `openDepth` recorded
  // BEFORE its own `{` is counted produces a frame whose `openDepth` is the
  // ENCLOSING scope's depth, not its own — for a top-level function that is
  // `openDepth: 0`, and since real code never reaches negative depth, a
  // frame pushed with `openDepth: 0` can NEVER pop (`depth < 0` never
  // fires): it would sit at the bottom of `stack` for the rest of the file,
  // and every subsequent line with no OTHER open frame would be
  // misattributed to it. `ARROW_CONST_RE` never needs this deferral — its
  // pattern requires `=>\s*\{` literally, so it only ever matches on a line
  // that already carries the brace.
  let pendingDeclName = null;
  for (let i = 0; i < lines.length; i++) {
    const detectCode = detect[i];
    const braceCode = braces[i];

    let immediateName = null;
    if (detectCode.trim()) {
      const arrowMatch = ARROW_CONST_RE.exec(detectCode);
      if (arrowMatch) {
        immediateName = arrowMatch[1];
      } else {
        const declMatch = FUNCTION_DECL_RE.exec(detectCode);
        // A NEW `function NAME(` match replaces any still-pending name
        // rather than stacking deferrals — this scanner tracks at most one
        // pending declaration at a time (two `function` keywords on
        // consecutive lines with neither closing its signature first is not
        // a shape that occurs in this codebase's style).
        if (declMatch) pendingDeclName = declMatch[1];
      }
    }

    const opens = (braceCode.match(/\{/g) || []).length;
    const closes = (braceCode.match(/\}/g) || []).length;
    depth += opens - closes;

    if (immediateName) stack.push({ name: immediateName, openDepth: depth });

    if (pendingDeclName) {
      if (opens > 0) {
        // First line whose brace count actually increases — its `{` is
        // counted in THIS line's `opens`, so `depth` here correctly
        // reflects "inside the function", matching every other frame's
        // convention (push AFTER updating depth for the pushing line).
        stack.push({ name: pendingDeclName, openDepth: depth });
        pendingDeclName = null;
      } else if (detectCode.includes(';')) {
        // The statement terminated before any `{` appeared — a type-only
        // declaration, an ambient `declare function`, or an overload
        // signature, none of which open a function body. Abandon the
        // pending name rather than stranding it to match a `{` that
        // belongs to unrelated later code. (A `;` inside a string literal
        // on this line would also trigger this — accepted, narrow, known
        // limitation: a default-parameter string containing `;` on the
        // SAME line as an unterminated multi-line signature has not been
        // observed in this codebase.)
        pendingDeclName = null;
      }
    }

    while (stack.length > 0 && depth < stack[stack.length - 1].openDepth) stack.pop();

    innermostAt[i] = stack.length > 0 ? stack[stack.length - 1].name : null;

    if (detectCode.trim() && LADDER_RE.test(detectCode)) {
      // Transitive: every frame currently open (not just the innermost) is
      // ladder-bearing, because a nested closure's body is lexically part of
      // every one of its enclosing functions' own bodies.
      for (const frame of stack) ladderBearing.add(frame.name);
    }
  }
  return { ladderBearing, innermostAt, detect };
}

function findStateFieldDrift(text, relPath) {
  const out = [];
  const lines = text.split('\n');
  const exemptFunctions = FUNCTION_SCOPED_EXEMPTIONS.get(relPath) || null;
  const { ladderBearing, innermostAt, detect } = buildFunctionInfo(lines);

  for (let i = 0; i < lines.length; i++) {
    const detectCode = detect[i];
    if (!detectCode.trim()) continue;
    if (!STATE_EXTRACT_FIELD_CALL_RE.test(detectCode)) continue;

    const fn = innermostAt[i];
    if (!fn || !ladderBearing.has(fn)) continue;
    if (exemptFunctions && exemptFunctions.has(fn)) continue;

    out.push({ line: i + 1, found: lines[i].trim().slice(0, MAX_REGEX_LITERAL_LEN) });
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
      // `rel` is already the REAL (canonical) path (scanTree resolves
      // symlinks before calling onFile), so this — and
      // FUNCTION_SCOPED_EXEMPTIONS above, also keyed on `rel` — match
      // consistently regardless of which symlink reached the file.
      return findStateFieldDrift(text, rel).map((d) => ({ file: rel, ...d }));
    },
  });
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write('ok state-field-drift: no unsanctioned STATE.md field-extraction fallback-chain re-derivations found\n');
    return;
  }
  process.stderr.write('state-field-drift: independent re-derivation(s) of the STATE.md frontmatter-else-body field\n');
  process.stderr.write('fallback chain found. Route these call sites through src/state-document.cjs\n');
  process.stderr.write('`stateFieldValue` (issue #3187, ADR-3180 §7.7) instead of re-deriving the ladder:\n');
  for (const d of violations) {
    // `d.file` is exactly as attacker-controlled as `d.found`: a repo can
    // legally track a filename containing control bytes / bidi overrides,
    // and it is a fork-PR-authored value reaching a CI log the same way the
    // matched line text does — sanitize it at the same reporting boundary.
    process.stderr.write(`  ${sanitizeForReport(d.file)}:${d.line}  ${sanitizeForReport(d.found)}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findStateFieldDrift,
  buildFunctionInfo,
  scanRepo,
  LADDER_RE,
  STATE_EXTRACT_FIELD_CALL_RE,
  FUNCTION_DECL_RE,
  ARROW_CONST_RE,
  OWNER_FILE,
  FUNCTION_SCOPED_EXEMPTIONS,
  scanCode,
  MAX_REGEX_LITERAL_LEN,
};

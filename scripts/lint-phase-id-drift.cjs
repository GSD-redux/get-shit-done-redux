#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the phase-identifier parsing seam
 * (epic #2121, Phase 4 / issue #2128, locked by ADR-2121 Decision 7).
 *
 * `src/phase-id.cts` is the SINGLE canonical owner of phase-ID parsing. Its
 * `PHASE_NUMBER_TOKEN_SOURCE` (and `phaseMarkdownRegexSource` for a known number)
 * is the one place the phase-number-token grammar `\d+[A-Z]?(?:\.\d+)*` is
 * defined. Every other module that scans/enumerates phase headings must build
 * its regex from that source rather than re-deriving the grammar as a literal —
 * otherwise the trio drifts again (the #2111 / #2114 / #2104 recurrence loop this
 * epic closes).
 *
 * This lint makes the invariant machine-enforced: it FAILS the moment a literal
 * re-derivation of the canonical token grammar is introduced anywhere in
 * `src/**` outside `phase-id.cts`, unless the site is deliberately sanctioned
 * with a `// phase-id-owner: <reason>` comment (on the same line or the line
 * directly above). Sites that build their regex from `PHASE_NUMBER_TOKEN_SOURCE`
 * carry no literal grammar and pass automatically.
 *
 * Detection is intentionally NARROW: only the contiguous canonical token
 * (`\d+[A-Z]?(?:\.\d+)*`, its `[A-Za-z]` and `[.-]` near-variants, in both
 * regex-literal `\d` and `new RegExp` template `\\d` escaping) is drift. Bare
 * `\d+` probes, `[\w][\w.-]*` ids, digits-only captures, status-message text
 * (`Phase\s+\d`), and pipe-table structures are NOT phase-token re-derivations
 * and are not flagged.
 */

const fs = require('node:fs');
const path = require('node:path');

// The canonical phase-number token as it appears in SOURCE TEXT:
//   \d+[A-Z]?(?:\.\d+)*   in a regex literal   -> one backslash before d/.
//   \\d+[A-Z]?(?:\\.\\d+)* in a template string -> two backslashes
// Tolerated near-variants so a trivial rewrite does not silently evade the guard:
//   digit class     \d  \\d  or  [0-9]
//   letter class    [A-Z]  or  [A-Za-z]
//   sub-phase sep    \.  \\.  or  [.-]  (dot-or-dash)
// KNOWN, ACCEPTED limits of a per-line textual scan (covered instead by the
// identity guard + code review, not by this regex): a re-derivation split
// across lines via string concatenation, a capturing `(\.\d+)*` in place of the
// non-capturing group, or a semantically-equivalent restructuring. This guard
// targets the common case — an accidental copy of the exact grammar — not an
// adversary deliberately obfuscating a re-derivation.
const TOKEN_DRIFT_RE = /(?:\\{1,2}d|\[0-9\])\+\[A-Z(?:a-z)?\]\??\(\?:(?:\\{1,2}\.|\[\.-\])(?:\\{1,2}d|\[0-9\])\+\)\*/;

// A `phase-id-owner:` sanction must be a DEDICATED `//` comment line (the marker
// as the line's leading token). A `//` or the phrase embedded in a string
// literal or trailing a code line is NOT a comment and must never suppress a real
// flag — so sanctions live on their own line directly above the regex.
const OWNER_RE = /^\s*\/\/.*phase-id-owner:/;
const CANON_REF = 'PHASE_NUMBER_TOKEN_SOURCE';

// #2761 M3 (trek-e review): the SECOND grammar this seam owns — the BRACKET
// project-code class of `[CODE.MM]`, spelled `[A-Z][A-Z0-9_]*` (with its
// case-widened `[A-Za-z]`/`[A-Za-z0-9_]` variant tolerated so a trivial rewrite
// does not evade the rule). The token guard above only ever knew the phase-
// NUMBER grammar, so three files re-typed this class verbatim — roadmap-parser's
// bracket-fallback selector, state's `isMilestoneBounded`, verify's
// `checkBracketCoherence` — and `check:phase-id-drift` reported clean the whole
// time. That is the blind spot which let #2761's own "no token literal outside
// src/phase-id.cts" gate pass while being violated. Build from
// `BRACKET_PROJECT_CODE_SRC`, `BRACKET_ID_SRC`, `bracketMilestoneIntroSrcFor`
// or `BRACKET_MILESTONE_INTRO_CAPTURING_SRC` instead.
const BRACKET_CODE_DRIFT_RE = /\[A-Z(?:a-z)?\]\[A-Z(?:a-z)?0-9_\]\*/;

// This rule has NO counterpart to the token rule's `line.includes(CANON_REF)`
// escape, and that omission is the point.
//
// That escape is LINE-level: a line naming the canonical source anywhere on it
// is taken as built-from-the-owner. verify.cts's copy read
//
//   new RegExp(`^\\[[A-Z][A-Z0-9_]*\\.(${BRACKET_MILESTONE_NUMERIC_SRC})\\]`, 'i')
//
// — an owner reference for the MILESTONE field sharing a line with a re-typed
// PROJECT-CODE class. A line-level escape waves that through, so a bracket rule
// that copied it would have kept reporting clean on the very site under review.
// Partial ownership IS the drift. Only a `// phase-id-owner:` sanction
// suppresses this rule, and a sanction has to state which half is deliberate.
const BRACKET_OWNER_HINT =
  'BRACKET_PROJECT_CODE_SRC / BRACKET_ID_SRC / bracketMilestoneIntroSrcFor / BRACKET_MILESTONE_INTRO_CAPTURING_SRC';

/**
 * Pure: find every literal re-derivation of the canonical phase-number token in
 * `text` that is NOT sanctioned. A site is sanctioned when the nearest preceding
 * NON-BLANK line is a dedicated `// phase-id-owner:` comment (blank lines between
 * the comment and the regex are tolerated, so an auto-formatter cannot reactivate
 * the flag), or when the regex line references `PHASE_NUMBER_TOKEN_SOURCE` (built
 * from the canonical source, not a literal). A `//`/phrase inside a string or
 * trailing a code line does NOT count — put the sanction on its own line above.
 * Returns [{ line, found }].
 */
function findPhaseIdRegexDrift(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = TOKEN_DRIFT_RE.exec(line);
    if (!m) continue;
    if (line.includes(CANON_REF)) continue;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j--; // nearest preceding non-blank line
    if (j >= 0 && OWNER_RE.test(lines[j])) continue;
    out.push({ line: i + 1, found: m[0] });
  }
  return out;
}

/**
 * Pure: find every literal re-derivation of the BRACKET project-code grammar in
 * `text` that is NOT sanctioned. Same sanction mechanism as the token rule — a
 * dedicated `// phase-id-owner:` comment on the nearest preceding non-blank
 * line — but deliberately WITHOUT its line-level owner-reference escape, so a
 * site that references the owner for one field while re-typing the other is
 * still reported (see BRACKET_CODE_DRIFT_RE's note). Returns [{ line, found }].
 */
function findBracketGrammarDrift(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = BRACKET_CODE_DRIFT_RE.exec(lines[i]);
    if (!m) continue;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j--; // nearest preceding non-blank line
    if (j >= 0 && OWNER_RE.test(lines[j])) continue;
    out.push({ line: i + 1, found: m[0] });
  }
  return out;
}

// Authored TypeScript source only (the generated bin/lib/*.cjs mirror it).
const SCAN_DIRS = ['src'];
const SCAN_EXT = new Set(['.cts', '.ts', '.mts']);
// The canonical owner defines the grammar; it is exempt by construction.
const EXEMPT = new Set([path.join('src', 'phase-id.cts')]);

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walk(full, acc);
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

// ─── #2761 M4: the heading-baseline selector census ────────────────────────
//
// `phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.<MODE>)` is the other half
// of this seam: it decides which intro grammar a call site compiles, and the
// MODE argument is a fact about that site's history that no behavioural test
// can recover — flipping verify's milestone-complete site from LABEL_ONLY to
// ANY_BRACKET grants a tolerance it has never had, and every behavioural test
// still passes. Pinning it therefore requires reading the authored source.
//
// That reading lives HERE, not in the test suite. `tests/**` runs
// `local/no-source-grep` at ERROR, and its documented exemption
// (CONTEXT.md: RULESET.TESTS.no-source-grep.exemption) is reserved for tests
// whose subject is a runtime CONTRACT FILE — STATE.md, config.toml,
// hooks.json, agent .md — which `src/*.cts` is not. The suite had claimed that
// exemption anyway. Scripts are the sanctioned home for source scanning (the
// rule runs at `warn` in `scripts/**`, and this file already scans src/ for the
// grammar rules above), so the scan is exported as structured data and the test
// asserts on the returned census instead of on file text.
const SELECTOR_CALL_RE = /phaseHeadingPrefixSrcFor\(/g;
const SELECTOR_BASELINE_RE = /phaseHeadingPrefixSrcFor\(\s*PHASE_HEADING_BASELINE\.(ANY_BRACKET|LABEL_ONLY)/g;

/**
 * Pure: census the heading-baseline selector calls in `text`.
 *
 * `total` counts EVERY invocation, so a call that does not name a
 * `PHASE_HEADING_BASELINE` member shows up as `total > ANY_BRACKET +
 * LABEL_ONLY` — a hole in the pin rather than a silently uncounted site.
 * Returns { ANY_BRACKET, LABEL_ONLY, total }.
 */
function countSelectorBaselines(text) {
  const out = { ANY_BRACKET: 0, LABEL_ONLY: 0, total: 0 };
  for (const m of text.matchAll(SELECTOR_BASELINE_RE)) out[m[1]] += 1;
  out.total = (text.match(SELECTOR_CALL_RE) || []).length;
  return out;
}

/**
 * Scan the authored source tree and return the selector census keyed by
 * repo-relative path, for every file that consumes the selector at least once.
 * `phase-id.cts` is excluded: it DEFINES the selector, so its own occurrences
 * are the declaration, not a consumer's choice of baseline.
 */
function scanSelectorBaselines(root) {
  const census = {};
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir), [])) {
      const rel = path.relative(root, file);
      if (EXEMPT.has(rel)) continue;
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const counts = countSelectorBaselines(text);
      if (counts.total > 0) census[path.basename(file)] = counts;
    }
  }
  return census;
}

/**
 * Scan the authored source tree and return every unsanctioned phase-token
 * re-derivation, each annotated with the repo-relative file path.
 */
function scanRepo(root) {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir), [])) {
      const rel = path.relative(root, file);
      if (EXEMPT.has(rel)) continue;
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const d of findPhaseIdRegexDrift(text)) {
        violations.push({ file: rel, kind: 'token', ...d });
      }
      // #2761 M3: the bracket grammar is the second thing this seam owns.
      for (const d of findBracketGrammarDrift(text)) {
        violations.push({ file: rel, kind: 'bracket', ...d });
      }
    }
  }
  return violations;
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write('ok phase-id-drift: no unsanctioned phase-token or bracket-grammar re-derivations outside phase-id.cts\n');
    return;
  }
  process.stderr.write('phase-id-drift: literal re-derivation(s) of a canonical grammar found.\n');
  process.stderr.write(`Build the regex from phase-id.cjs \`${CANON_REF}\` (or phaseMarkdownRegexSource for a\n`);
  process.stderr.write(`known number) for the phase-number token, or from ${BRACKET_OWNER_HINT}\n`);
  process.stderr.write('for the bracket grammar — or sanction the site with a dedicated\n');
  process.stderr.write('`// phase-id-owner: <reason>` comment on the line directly above the regex:\n');
  for (const d of violations) {
    process.stderr.write(`  [${d.kind}] ${d.file}:${d.line}  ${d.found}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findPhaseIdRegexDrift,
  findBracketGrammarDrift,
  scanRepo,
  countSelectorBaselines,
  scanSelectorBaselines,
  TOKEN_DRIFT_RE,
  BRACKET_CODE_DRIFT_RE,
};

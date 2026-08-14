#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the STATE.md WRITE PATH — epic #3408, issue
 * #3468, ADR-3408 Decision 5, contract §8.1/§8.2/§8.3
 * (`docs/adr/3408-state-write-path-preservation.md` is the contract this
 * guard enforces; read it first).
 *
 * TWO AXES, ONE GUARD, because they fail together — a table that is
 * bypassed on dispatch and a seam that is bypassed on write are the same
 * failure mode ("policy declared, enforcement hand-rolled") applied to two
 * different call shapes:
 *
 *   AXIS 1 — POLICY DISPATCH (§8.1). `applyStatePreservation` must select
 *   its branch from a `FIELD_CLASSIFICATION` row's `preservation` value,
 *   never from a field NAME. Every `getFieldClassification('<string
 *   literal>')` inside `src/state-transition.cts` is a field-name-keyed
 *   branch — the shape that let four declared rows go unimplemented until
 *   #3258, and that leaves `derive` and `clear` with no executor today. A
 *   VARIABLE argument (`getFieldClassification(field)`) is the CORRECT
 *   table-driven shape and is deliberately NOT matched. Also matched: a
 *   direct `field === '<literal>'` / `field !== '<literal>'` / `'<literal>'
 *   === field` comparison of the dispatch loop's own `field` variable — the
 *   same prohibited shape routed AROUND `getFieldClassification` instead of
 *   through it (#3468 found this exact form live in `applyPreserveIfPlaceholder`,
 *   undetected by the call-shape check alone). Scoped to the identifier
 *   `field` only; see `FIELD_VAR_EQ_LITERAL_RE`'s own comment for why.
 *
 *   AXIS 2 — WRITE SEAM (§8.3), RATCHETED. `readModifyWriteStateMd` is the
 *   only path meant to write STATE.md. Every direct `writeStateMd(` or
 *   `syncStateFrontmatter(` call outside the owner's own definitions is a
 *   bypass that skips preservation and the #948 no-op guard — how #3374 and
 *   #3350 reproduce. This axis ships RATCHETED (see below), never a bare
 *   0-or-fail check.
 *
 * DESIGN CONSTRAINTS (ADR-3180 Decision 4, adopted verbatim by ADR-3408):
 *   - 4(a) whole-repo scan, never an allowlist. ADR-3180's own phases found
 *     26/5/54 copies where their epics scoped 3/3/4 — a scoped guard earns
 *     nothing.
 *   - 4(d) the scan surface is DECLARED and is NOT just `src/` — `src/`
 *     alone is itself an allowlist one directory wide; #1762 traced a wrong
 *     count to a shell snippet in `gsd-core/workflows/progress.md`. And
 *     inward: the OWNER FILE (`src/state.cts`) is not exempt, only its
 *     named canonical FUNCTIONS are (`SEAM_OWNER_EXEMPT_FUNCTIONS` below).
 *   - 4(e) Axis 2 ships ratcheted because Phase 1 (this file) cannot
 *     consolidate the write seam — that is Phase 2 (#3469). Landing a
 *     guard later, against an already-clean tree, is the "found it, wrote
 *     it down, moved on" posture the epic removes.
 *
 * GOODHART, PER ADR-3408 DECISION 5: "0 bypasses" is a LAGGING metric — a
 * measure about to become a target. This guard's own `_comment` and its
 * human-readable success message both say so: the zero this guard reports
 * must NEVER be quoted alone; it is only meaningful beside the behavioral
 * identity test's result (the consumer-output assertion Decision 5's gaming
 * table names as the actual defense).
 *
 * String literals are matched, never parsed as an AST — deliberately, per
 * `scripts/lint-state-field-drift.cjs`'s own precedent: over-reporting
 * (flagging a comment or a string that merely looks like a call) is safe;
 * under-reporting (missing a real bypass) is the failure this guard exists
 * to prevent. `stripComments` does not track quoted strings for exactly
 * this reason — see its own header.
 *
 * DECLARED KNOWN GAP — §8.3(b) `patchCore` frontmatter-write shape is NOT
 * detected by this guard. `patchCore` runs `stateReplaceField(` over the
 * WHOLE document (body + frontmatter) instead of stripping frontmatter
 * first, the way `updateCore` does — a real defect, but this guard does not
 * catch it.
 *
 * Why: catching it needs genuine DATAFLOW ("is this argument a variable
 * holding the full document, or a body slice?"), not function-scoped
 * co-occurrence. A co-occurrence approximation (does the enclosing function
 * also call `stripFrontmatter(`?) was implemented and measured directly
 * against this repo: 33 occurrences of `stateReplaceField(`, of which only
 * 4 are genuine write-seam bypasses and 29 are noise — the definition of
 * `stateReplaceField` itself (matched as a call), ~20 calls on `sectionBody`
 * (a body slice that is frontmatter-free by construction), and several
 * calls inside `readModifyWriteStateMd` callbacks (correct, because the RMW
 * envelope applies preservation after the callback returns). 29 false
 * positives to 1 true positive buries the signal and makes the ratchet's
 * shrink-rate meaningless as a Phase 2 progress indicator — recorded here,
 * with these numbers, so the next reader does not re-attempt the same
 * approximation.
 *
 * Who owns closing it: Phase 2 (#3469), which also FIXES the defect by
 * consolidating on the single write seam — after which detection becomes
 * tractable, because once the pure pipeline exists the invariant simplifies
 * to "no transition core calls `stateReplaceField` on unstripped content".
 *
 * This is a DECLARED gap with a named owner, not a silent omission — a
 * guard that quietly does not look somewhere is the failure ADR-3180
 * Decision 4(d) records.
 */

const fs = require('node:fs');
const path = require('node:path');
const { scanTree, sanitizeForReport } = require('./lib/drift-scan.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'state-write-path-drift-baseline.json');

// Frozen REASON enum — mirrors `lint-state-field-drift.cjs`'s house style of
// naming every failure shape explicitly rather than reusing one generic
// "violation" string, so a reader can `grep` a reason string straight back
// to the paragraph of this header (or of the ADR) that explains it.
const REASON = Object.freeze({
  FIELD_NAME_DISPATCH: 'field_name_dispatch',
  UNIMPLEMENTED_POLICY: 'unimplemented_policy',
  SEAM_BYPASS_UNRECORDED: 'seam_bypass_unrecorded',
  SEAM_BYPASS_COUNT_GREW: 'seam_bypass_count_grew',
  SEAM_BYPASS_COUNT_SHRANK: 'seam_bypass_count_shrank',
  BASELINE_ENTRY_STALE: 'baseline_entry_stale',
  BASELINE_UNREADABLE: 'baseline_unreadable',
});

// Scan surface — declared, per Decision 4(d), never inferred from `src/`
// alone. `src/` covers the executor and the write-seam owner; the prompt
// layer covers markdown that can shell out to `state.patch` / `phase.complete`
// and post-process the result outside any TypeScript this guard could see.
const SRC_DIRS = ['src'];
const SRC_EXT = new Set(['.cts']);
const PROMPT_DIRS = ['gsd-core/workflows', 'commands', 'agents', 'skills'];
const PROMPT_EXT = new Set(['.md']);

// The executor (Axis 1) and the write-seam owner (Axis 2). Forward-slash
// literals: every `rel` this guard compares against them is unconditionally
// POSIX-normalized first (`toPosixRel` below) — never gated on
// `process.platform`.
const EXECUTOR_FILE = 'src/state-transition.cts';
const SEAM_OWNER_FILE = 'src/state.cts';

// Per Decision 4(d)'s "owner FILE is not exempt, only its named canonical
// FUNCTIONS are": a `writeStateMd(`/`syncStateFrontmatter(` call inside one
// of these two functions, in `SEAM_OWNER_FILE` only, is the seam's own
// internal plumbing (the I/O wrapper calling the pure sync stage), not a
// bypass. Every OTHER function in `state.cts` — and every function in every
// OTHER file — is still scanned and still flagged.
const SEAM_OWNER_EXEMPT_FUNCTIONS = ['writeStateMd', 'readModifyWriteStateMd'];

// Unconditional path-separator normalization (never gated on
// `process.platform` — a Windows-authored fork PR must be judged by the
// same POSIX-relative rule as everything else this guard reads).
function toPosixRel(rel) {
  return rel.split(path.sep).join('/');
}

/**
 * Strip `//` line comments and `/* ... *\/` block comments from `text`,
 * returning one entry PER INPUT LINE so line numbers computed against the
 * result stay correct against the original file. Block comments are tracked
 * across lines (`inBlock`); line comments only ever affect their own line.
 *
 * Deliberately does NOT parse string/template literal contents — a `//` or
 * `/*` embedded inside a quoted string is treated exactly like real source,
 * which can occasionally UNDER-strip (leaving a would-be-comment's text
 * live) but never OVER-strips real code into invisibility. Per this guard's
 * header and `lint-state-field-drift.cjs`'s own precedent: over-reporting a
 * documentation paragraph that merely DESCRIBES a call (ADR-3180 Amendment
 * 3's exact false positive) is the failure this exists to prevent; a rare
 * miss on an adversarial one-line string is an accepted, narrower risk in
 * the opposite (safe) direction — under-reporting, never over-reporting.
 */
function stripComments(text) {
  const lines = text.split('\n');
  const out = new Array(lines.length);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let result = '';
    let j = 0;
    while (j < line.length) {
      if (inBlock) {
        const close = line.indexOf('*/', j);
        if (close === -1) {
          j = line.length;
          break;
        }
        j = close + 2;
        inBlock = false;
        continue;
      }
      if (line[j] === '/' && line[j + 1] === '/') {
        j = line.length; // rest of line is a line comment
        break;
      }
      if (line[j] === '/' && line[j + 1] === '*') {
        inBlock = true;
        j += 2;
        continue;
      }
      result += line[j];
      j++;
    }
    out[i] = result;
  }
  return out;
}

// A named function declaration, tolerating `export`/`async` prefixes — the
// SAME shape `enclosingFunction` looks backward for and `findSeamBypasses`
// uses to recognise (and skip) the seam functions' own definitions.
const FUNCTION_DECL_LINE_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;

/**
 * Nearest preceding named-function declaration, scanning `lines` BACKWARD
 * from `index`. Scopes an exemption to a FUNCTION, never a FILE — a whole-
 * file owner exemption is precisely how `getMilestoneInfo` stayed invisible
 * to an earlier drift guard (ADR-3180 Decision 4(d)'s own cautionary case,
 * cross-referenced by this guard's header).
 */
function enclosingFunction(lines, index) {
  for (let i = index; i >= 0; i--) {
    const m = FUNCTION_DECL_LINE_RE.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

// One member of the `FieldPreservation` union, e.g. `'preserve-always'` —
// lowercase-with-dashes, single-quoted.
const POLICY_UNION_START_RE = /export\s+type\s+FieldPreservation\s*=/;
const POLICY_UNION_MEMBER_RE = /'([a-z][a-z-]*)'/g;

/**
 * Parse the members of `export type FieldPreservation = 'a' | 'b' | ...;`
 * straight out of the executor's own source, so this guard cannot drift
 * from the type it polices (a hardcoded copy of the union would be exactly
 * the "declared here, enforced somewhere else" shape ADR-3408 exists to
 * remove — this time inside the GUARD). In `src/state-transition.cts` the
 * union is declared across several lines, each shaped like
 * `  | 'clear'; // remove the field entirely`. Scans from the declaration
 * line forward, collecting every quoted token on each line, and stops at
 * the first line whose (comment-INCLUDING) text still carries a `;` — the
 * statement terminator ends the union regardless of any trailing comment.
 */
function readPolicyUnion(text) {
  const lines = text.split('\n');
  const members = [];
  let inUnion = false;
  for (const line of lines) {
    if (!inUnion) {
      if (!POLICY_UNION_START_RE.test(line)) continue;
      inUnion = true;
    }
    POLICY_UNION_MEMBER_RE.lastIndex = 0;
    let m;
    while ((m = POLICY_UNION_MEMBER_RE.exec(line)) !== null) {
      members.push(m[1]);
    }
    if (line.includes(';')) break;
  }
  return members;
}

// `getFieldClassification(` called with a quoted string-literal argument —
// the field-name-keyed dispatch shape. `getFieldClassification(variable)`
// (a bare identifier, no quote) never matches this pattern, by construction
// (the quote-character backreference requires an opening quote immediately
// inside the parens) — the correct, table-driven shape is silent here.
const FIELD_NAME_DISPATCH_RE = /getFieldClassification\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;

// `field === '<literal>'` / `field !== '<literal>'`, and the reversed
// `'<literal>' === field` — the field-name-keyed BRANCH shape (as opposed to
// `FIELD_NAME_DISPATCH_RE`'s field-name-keyed CALL shape above; both report
// the same `REASON.FIELD_NAME_DISPATCH`, since both are "a branch selected
// by field name", ADR-3408 §8.1's exact prohibition). This is the shape a
// bypass takes when it routes AROUND `getFieldClassification` entirely
// rather than through it — ADR-3408 Decision 5's "route the bypass through
// a wrapper or a differently-named local" gaming route.
//
// Deliberately scoped to ONLY an identifier literally named `field` — the
// dispatch loop's own loop variable declared at
// `for (const field of Object.keys(FIELD_CLASSIFICATION))` a few dozen lines
// below in this same file. This is a DECLARED, narrow limitation, not a
// silent one: a rename of the loop variable would evade this detector
// entirely, and an unrelated local elsewhere in this file that happens to
// also be named `field` would false-positive. Both risks are accepted
// in trade for avoiding a name-agnostic match, which would flag every
// unrelated `===`/`!==` string comparison in the file (there are many —
// e.g. `derivedName !== MILESTONE_PLACEHOLDER`-shaped guards) and bury the
// real signal in noise; per this guard's own header, over-reporting a
// comment is an accepted risk but over-reporting live code this broadly is
// not.
//
// The reversed `!==` form (`'<literal>' !== field`) is deliberately NOT
// matched — not observed anywhere in this codebase, and left out rather
// than speculatively widened past what was found in practice.
const FIELD_VAR_EQ_LITERAL_RE = /\bfield\s*(?:===|!==)\s*(['"`])([^'"`]+)\1/g;
const LITERAL_EQ_FIELD_VAR_RE = /(['"`])([^'"`]+)\1\s*===\s*\bfield\b/g;

/**
 * AXIS 1a: every `getFieldClassification('<literal>')` CALL, and every
 * `field === '<literal>'` / `field !== '<literal>'` / `'<literal>' ===
 * field` BRANCH, inside the executor is a field-name-keyed branch (§8.1).
 * Only ever called against `EXECUTOR_FILE` — `collect()` gates the call
 * site, mirroring `findPolicyDispatchDrift`'s own "only when rel ===
 * EXECUTOR_FILE" rule from the spec this guard was authored against.
 * `preservation === '<member>'` comparisons — the CORRECT policy-dispatch
 * shape `findUnimplementedPolicies` requires to exist — are unaffected: the
 * identifier compared there is `preservation`, never `field`, so
 * `FIELD_VAR_EQ_LITERAL_RE`'s `\bfield\b` anchor does not reach them.
 */
function findPolicyDispatchDrift(rel, text) {
  const out = [];
  const stripped = stripComments(text);
  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i];
    if (!line.trim()) continue;
    FIELD_NAME_DISPATCH_RE.lastIndex = 0;
    let m;
    while ((m = FIELD_NAME_DISPATCH_RE.exec(line)) !== null) {
      out.push({
        reason: REASON.FIELD_NAME_DISPATCH,
        axis: 'policy-dispatch',
        file: rel,
        line: i + 1,
        field: m[2],
        source: sanitizeForReport(line.trim()),
      });
    }
    FIELD_VAR_EQ_LITERAL_RE.lastIndex = 0;
    while ((m = FIELD_VAR_EQ_LITERAL_RE.exec(line)) !== null) {
      out.push({
        reason: REASON.FIELD_NAME_DISPATCH,
        axis: 'policy-dispatch',
        file: rel,
        line: i + 1,
        field: m[2],
        source: sanitizeForReport(line.trim()),
      });
    }
    LITERAL_EQ_FIELD_VAR_RE.lastIndex = 0;
    while ((m = LITERAL_EQ_FIELD_VAR_RE.exec(line)) !== null) {
      out.push({
        reason: REASON.FIELD_NAME_DISPATCH,
        axis: 'policy-dispatch',
        file: rel,
        line: i + 1,
        field: m[2],
        source: sanitizeForReport(line.trim()),
      });
    }
  }
  return out;
}

/**
 * AXIS 1b: every `FieldPreservation` member (read from `text` via
 * `readPolicyUnion`, so the check cannot itself drift from the union) that
 * has no `preservation === '<member>'` comparison anywhere in the
 * comment-stripped executor source is a declared policy with no executor —
 * §8.1's mirror defect, one level up (a whole MEMBER unimplemented, not just
 * one dispatch call keyed on a field name). `derive` and `clear` are the
 * live instances ADR-3408 §8.6 names.
 */
function findUnimplementedPolicies(text, rel) {
  const members = readPolicyUnion(text);
  const strippedText = stripComments(text).join('\n');
  const out = [];
  for (const member of members) {
    const memberRe = new RegExp(`preservation\\s*===\\s*'${escapeRegex(member)}'`);
    if (memberRe.test(strippedText)) continue;
    out.push({
      reason: REASON.UNIMPLEMENTED_POLICY,
      axis: 'policy-dispatch',
      file: rel,
      line: 0,
      policy: member,
      source: sanitizeForReport(`FieldPreservation member '${member}' has no executor`),
    });
  }
  return out;
}

// The two write-seam functions, matched only as CALLS (`\(` immediately
// after, modulo whitespace) — never as bare mentions of the name.
const SEAM_CALL_RE = /\b(writeStateMd|syncStateFrontmatter)\s*\(/g;
// A line that IS one of the two seam functions' own definitions — skipped
// outright, never counted as a call to itself.
const SEAM_DEF_LINE_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+(?:writeStateMd|syncStateFrontmatter)\b/;

/**
 * AXIS 2a: every direct `writeStateMd(`/`syncStateFrontmatter(` call in
 * `text`, outside the two functions' own definitions and (only inside
 * `SEAM_OWNER_FILE`) outside `SEAM_OWNER_EXEMPT_FUNCTIONS`'s own bodies. No
 * `reason` on these findings — `applyRatchet` assigns one, since the same
 * observed call site is a different failure shape depending on whether the
 * baseline already knows about it.
 */
function findSeamBypasses(rel, text) {
  const rawLines = text.split('\n');
  const stripped = stripComments(text);
  const out = [];
  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i];
    if (!line.trim()) continue;
    if (SEAM_DEF_LINE_RE.test(line)) continue;
    SEAM_CALL_RE.lastIndex = 0;
    let m;
    while ((m = SEAM_CALL_RE.exec(line)) !== null) {
      if (rel === SEAM_OWNER_FILE) {
        const fn = enclosingFunction(stripped, i);
        if (fn && SEAM_OWNER_EXEMPT_FUNCTIONS.includes(fn)) continue;
      }
      out.push({
        axis: 'write-seam',
        file: rel,
        line: i + 1,
        symbol: m[1],
        source: sanitizeForReport(rawLines[i].trim()),
      });
    }
  }
  return out;
}

// Prose in the prompt layer shelling out to a write-side `gsd-tools`
// subcommand — the SAME write seam, expressed as markdown instructing an
// agent to run a command, rather than TypeScript calling a function
// directly (Decision 4(d)'s "the scan surface is declared, and is not just
// `src/`"). Matched on RAW lines — no comment stripping — because markdown
// carries no comment syntax this guard should be stripping in the first
// place. `g`-flagged so multiple candidate occurrences on one line are all
// checked against backtick spans below, rather than only the first.
const PROMPT_SEAM_RE = /gsd[-_]?tools[^\n]*\b(state\.patch|state\.planned-phase|state\.sync|phase\.complete)\b/g;

/**
 * Every `` `...` `` inline-code span on `line`, as `[start, end)` character
 * ranges (end exclusive). Handles multiple spans on one line correctly by
 * repeated `exec` over a global, non-overlapping backtick-pair pattern —
 * unlike a naive "count backticks before the match" parity check, this does
 * not get confused by a line that mixes code spans with unrelated literal
 * backticks (e.g. an unmatched one in prose).
 */
const CODE_SPAN_RE = /`[^`\n]+`/g;
function codeSpanRanges(line) {
  const ranges = [];
  CODE_SPAN_RE.lastIndex = 0;
  let m;
  while ((m = CODE_SPAN_RE.exec(line)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/**
 * True when character offset `index` of `line` falls inside one of `line`'s
 * inline-code spans.
 */
function isInsideCodeSpan(line, index) {
  return codeSpanRanges(line).some(([start, end]) => index >= start && index < end);
}

/**
 * AXIS 2b: every prompt-layer line instructing an agent to shell out to a
 * write-side `gsd-tools` subcommand. Same finding shape as
 * `findSeamBypasses` (no `reason` — the ratchet assigns it), with a fixed
 * `symbol` since there is no single function name to report for prose.
 *
 * A candidate occurrence enclosed in backticks is a MENTION, not an
 * invocation, and is deliberately not reported — CONTRIBUTING.md's "Every
 * `commit` invocation in shipped content must declare `--files`" section
 * states the repo's settled convention verbatim: "Write the command
 * reference in backticks — the repo's own convention — and it is correctly
 * read as a mention." ADR-3180 Amendment 3 records the cost of getting this
 * wrong: the first `lint-phase-enumeration-drift.cjs` flagged JSDoc that
 * merely documented the canonical owner as drift, which trains readers to
 * reflexively exempt documentation instead of trusting the guard — the
 * opposite of Decision 4(a)'s intent. All 5 of this guard's original
 * prompt-layer baseline entries were exactly this false positive.
 */
function findPromptSeamUses(rel, text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    PROMPT_SEAM_RE.lastIndex = 0;
    let m;
    while ((m = PROMPT_SEAM_RE.exec(line)) !== null) {
      if (isInsideCodeSpan(line, m.index)) continue;
      out.push({
        axis: 'write-seam',
        file: rel,
        line: i + 1,
        symbol: 'prompt-layer-state-write',
        source: sanitizeForReport(line.trim()),
      });
    }
  }
  return out;
}

/**
 * Ratchet key for one write-seam finding — `(file, TRIMMED source text)`,
 * NEVER a line number, which churns on any unrelated edit to the same file
 * (mirrors `qa-smell-ratchet.cjs`'s own key shape). `v.source` is already
 * the trimmed, sanitized line text by the time it reaches this function.
 */
function ratchetKey(v) {
  return `${v.file} ${v.source}`;
}

/**
 * Read `BASELINE_PATH`. Returns `{ entries: [] }` when the file is ABSENT
 * (`ENOENT` — first run, or a fully-shrunk Phase 4 baseline that deleted the
 * file — ADR-3408 §8.3's roster foresees exactly this end state); returns
 * `{ entries: null, code }` when the file is present but could not be read
 * OR could not be parsed/shaped (missing/malformed `entries` array) — `code`
 * carries the underlying `fs` error code (e.g. `'EACCES'`) when the failure
 * happened at the read step, `null` when it happened at the parse/shape
 * step, so the caller can fail closed rather than silently ratcheting
 * against nothing. Returns the parsed object when the read+parse succeed.
 *
 * Absent-vs-unreadable is deliberately NOT collapsed into one arm. This
 * guard exists to catch write paths whose failure and success are
 * output-identical (ADR-3180 / ADR-3408, "The failure mode that hides all
 * of it") — a `catch { return { entries: [] } }` around the read would
 * reproduce exactly that shape in the tool built to detect it: an
 * unreadable baseline (EACCES, EISDIR, EIO, ...) would be silently
 * indistinguishable from a legitimate absent one. Do not simplify this back
 * into a single catch arm.
 */
function loadBaseline() {
  let raw;
  try {
    raw = fs.readFileSync(BASELINE_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { entries: [] };
    return { entries: null, code: err && err.code ? err.code : 'UNKNOWN' };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { entries: null, code: null };
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.entries)) return { entries: null, code: null };
  return doc;
}

/**
 * The ratchet — mirrors `scripts/qa-smell-ratchet.cjs`'s four invariants,
 * applied to write-seam bypass COUNTS instead of QA-smell fingerprints:
 *
 *   1. An observed key absent from the baseline is a brand-new,
 *      unacknowledged bypass — `SEAM_BYPASS_UNRECORDED`.
 *   2. An observed count greater than the acknowledged count is a NEW copy
 *      landing beside an already-acknowledged one — `SEAM_BYPASS_COUNT_GREW`.
 *   3. An observed count less than the acknowledged count is a PARTIAL
 *      migration — some but not all call sites at this exact key were
 *      removed, and the baseline still claims the old, larger number —
 *      `SEAM_BYPASS_COUNT_SHRANK`.
 *   4. A baseline key with zero current observations is a STALE
 *      acknowledgment: an entry may never outlive what it describes, and
 *      the baseline may only shrink (via `--baseline`, regenerated) —
 *      `BASELINE_ENTRY_STALE`.
 *
 * The occurrence COUNT (not just key presence) is what makes a partial
 * migration visible at all: two byte-identical call sites in one file are
 * otherwise a single indistinguishable key, so removing one of the two
 * would silently vanish from a presence-only check while the acknowledgment
 * still describes two.
 *
 * Every returned finding carries both `observed` and `acknowledged` counts.
 */
function applyRatchet(observed, baseline) {
  const observedByKey = new Map();
  for (const finding of observed) {
    const key = ratchetKey(finding);
    let group = observedByKey.get(key);
    if (!group) {
      group = { count: 0, sample: finding };
      observedByKey.set(key, group);
    }
    group.count += 1;
  }

  const baselineByKey = new Map();
  for (const entry of baseline.entries) {
    baselineByKey.set(`${entry.file} ${entry.source}`, entry);
  }

  const out = [];
  for (const [key, group] of observedByKey) {
    const entry = baselineByKey.get(key);
    const acknowledged = entry && typeof entry.count === 'number' ? entry.count : 0;
    let reason = null;
    if (!entry) {
      reason = REASON.SEAM_BYPASS_UNRECORDED;
    } else if (group.count > acknowledged) {
      reason = REASON.SEAM_BYPASS_COUNT_GREW;
    } else if (group.count < acknowledged) {
      reason = REASON.SEAM_BYPASS_COUNT_SHRANK;
    }
    if (!reason) continue;
    out.push({
      reason,
      axis: 'write-seam',
      file: group.sample.file,
      line: group.sample.line,
      symbol: group.sample.symbol,
      source: group.sample.source,
      observed: group.count,
      acknowledged,
    });
  }

  for (const [key, entry] of baselineByKey) {
    if (observedByKey.has(key)) continue;
    out.push({
      reason: REASON.BASELINE_ENTRY_STALE,
      axis: 'write-seam',
      file: entry.file,
      line: 0,
      symbol: entry.symbol,
      source: entry.source,
      observed: 0,
      acknowledged: typeof entry.count === 'number' ? entry.count : 0,
    });
  }

  return out;
}

/**
 * Run both scan passes (the `src/` tree for Axis 1 + Axis 2a, the prompt
 * layer for Axis 2b) and split the combined findings by `axis` into
 * `{ policyFindings, seamFindings }`. `policyFindings` are already terminal
 * (each carries its own `reason`); `seamFindings` are raw observations —
 * `applyRatchet` is what turns them into (or clears them of) a finding.
 */
function collect() {
  const srcFindings = scanTree({
    root: REPO_ROOT,
    scanDirs: SRC_DIRS,
    scanExt: SRC_EXT,
    onFile(rel, text) {
      const relPosix = toPosixRel(rel);
      const found = [];
      if (relPosix === EXECUTOR_FILE) {
        found.push(...findPolicyDispatchDrift(relPosix, text));
        found.push(...findUnimplementedPolicies(text, relPosix));
      }
      found.push(...findSeamBypasses(relPosix, text));
      return found;
    },
  });

  const promptFindings = scanTree({
    root: REPO_ROOT,
    scanDirs: PROMPT_DIRS,
    scanExt: PROMPT_EXT,
    onFile(rel, text) {
      return findPromptSeamUses(toPosixRel(rel), text);
    },
  });

  const all = [...srcFindings, ...promptFindings];
  return {
    policyFindings: all.filter((f) => f.axis === 'policy-dispatch'),
    seamFindings: all.filter((f) => f.axis === 'write-seam'),
  };
}

/**
 * Group `seamFindings` by `ratchetKey` into the baseline entry shape
 * (`{file, source, symbol, count, owner}`), sorted by `file+source`.
 *
 * `owner` is NEVER invented by this mechanical regeneration — the guard can
 * observe WHERE a bypass is and HOW MANY there are, but not which issue owns
 * removing it; inventing one would violate the same "never guess" discipline
 * `qa-smell-ratchet.cjs` applies to its own `issue` field (its `--update`
 * never invents an issue number either). ADR-3408 §8.3 requires every
 * shipped entry to carry "a named ratchet entry carrying the issue that owns
 * its removal, never an unrecorded pass" — that owner is HUMAN-CURATED and
 * must be recorded before the entry ships.
 *
 * Because `--baseline` overwrites `BASELINE_PATH` wholesale, a naive
 * mechanical regeneration would silently re-null every curated `owner` on
 * each run. To avoid that, `existingEntries` (the baseline as it stood
 * BEFORE this regeneration, i.e. `loadBaseline().entries`) is optional and,
 * when supplied, its `owner` values are merged forward onto matching new
 * entries keyed on `(file, source)` — the same key `ratchetKey` /
 * `applyRatchet` use to identify a bypass. A key with no prior entry (a
 * brand-new bypass) still gets `owner: null`, exactly as before; only
 * already-curated owners survive the regeneration. Re-running `--baseline`
 * twice in a row is therefore idempotent with respect to `owner`.
 */
function buildBaselineEntries(seamFindings, existingEntries) {
  const priorOwnerByKey = new Map();
  if (Array.isArray(existingEntries)) {
    for (const entry of existingEntries) {
      priorOwnerByKey.set(ratchetKey(entry), entry.owner);
    }
  }

  const groups = new Map();
  for (const finding of seamFindings) {
    const key = ratchetKey(finding);
    let group = groups.get(key);
    if (!group) {
      group = {
        file: finding.file,
        source: finding.source,
        symbol: finding.symbol,
        count: 0,
        owner: priorOwnerByKey.has(key) ? priorOwnerByKey.get(key) : null,
      };
      groups.set(key, group);
    }
    group.count += 1;
  }
  return [...groups.values()].sort((a, b) => ratchetKey(a).localeCompare(ratchetKey(b)));
}

const BASELINE_COMMENT =
  'ADR-3408 Decision 5 write-seam ratchet baseline (issue #3468, Phase 1). Every entry here is a ' +
  '`writeStateMd(`/`syncStateFrontmatter(` bypass this guard found by a whole-repo scan (Decision ' +
  '4(a)) — it is ACKNOWLEDGED, not endorsed: acknowledgment is in writing (this file), with the ' +
  'issue owning its removal recorded in the entry\'s "owner" field. This baseline is SHRINK-ONLY — ' +
  'an entry that stops firing goes STALE and fails the plain run until `--baseline` is re-run to ' +
  'drop it (ADR-3180 Decision 4(e)\'s "the baseline may only shrink", adopted verbatim by ADR-3408). ' +
  'Phase 2 (#3469) removes the `cmdPhaseComplete` and `patchCore` entries when it lands the single ' +
  'write seam. Phase 4 (#3471) drives this baseline to empty and deletes this file. ' +
  '`REGENERATE_STATE` (`src/health-diagnostic.cts`) is a SANCTIONED PERMANENT exception, not debt — ' +
  'it is `/gsd-health --repair`\'s factory reset, which rebuilds STATE.md from scratch, so ' +
  'preservation would restore exactly the values it was invoked to discard; do not "consolidate" ' +
  'its entry away.';

function writeBaseline(seamFindings) {
  const priorBaseline = loadBaseline();
  const entries = buildBaselineEntries(
    seamFindings,
    Array.isArray(priorBaseline.entries) ? priorBaseline.entries : null,
  );
  const doc = { _comment: BASELINE_COMMENT, entries };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return entries;
}

const GOODHART_NOTE =
  'Goodhart note (ADR-3408 Decision 5): this "0 write-path bypasses" is a LAGGING metric — report ' +
  'it only alongside the behavioral identity test\'s result (asserted at the consumer\'s output), ' +
  'never alone.';

function printFindings(findings) {
  for (const f of findings) {
    process.stderr.write(`[${f.reason}] ${sanitizeForReport(f.file)}:${f.line}\n`);
    process.stderr.write(`    ${sanitizeForReport(f.source)}\n`);
  }
}

/**
 * `argv`: `--baseline` regenerates `BASELINE_PATH` from a fresh scan and
 * exits 0; `--json` (check mode only) prints the machine-readable finding
 * set instead of the human-readable report. Exit codes: 0 clean, 1 drift
 * (policy-dispatch violation, ratchet violation, or an unreadable
 * baseline), 2 usage error.
 */
function main(argv) {
  const args = argv || [];
  const recognized = new Set(['--baseline', '--json']);
  const unknown = args.filter((a) => !recognized.has(a));
  if (unknown.length > 0) {
    process.stderr.write(
      `lint-state-write-path-drift: unrecognized argument(s): ${unknown.map((a) => sanitizeForReport(a)).join(', ')} ` +
        '(expected --baseline and/or --json)\n',
    );
    process.exitCode = 2;
    return;
  }

  if (args.includes('--baseline')) {
    const { seamFindings } = collect();
    const entries = writeBaseline(seamFindings);
    process.stdout.write(`lint-state-write-path-drift: wrote ${entries.length} entries to ${BASELINE_PATH}\n`);
    process.exitCode = 0;
    return;
  }

  const wantJson = args.includes('--json');
  const baseline = loadBaseline();

  if (baseline.entries === null) {
    const finding = {
      reason: REASON.BASELINE_UNREADABLE,
      axis: 'write-seam',
      file: path.relative(REPO_ROOT, BASELINE_PATH),
      line: 0,
      symbol: null,
      code: baseline.code,
      source: sanitizeForReport(
        baseline.code
          ? `${BASELINE_PATH} is present but could not be read (${baseline.code}) — run \`node ${__filename} --baseline\` to regenerate it`
          : `${BASELINE_PATH} is present but unparseable — run \`node ${__filename} --baseline\` to regenerate it`,
      ),
    };
    if (wantJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: false,
            findings: [finding],
            summary: { policyDispatchViolations: 0, seamBypassesObserved: 0, seamBypassesAcknowledged: 0, ratchetViolations: 0 },
          },
          null,
          2,
        )}\n`,
      );
    } else {
      printFindings([finding]);
    }
    process.exitCode = 1;
    return;
  }

  const { policyFindings, seamFindings } = collect();
  const ratchetFindings = applyRatchet(seamFindings, baseline);
  const findings = [...policyFindings, ...ratchetFindings];
  const acknowledgedTotal = baseline.entries.reduce(
    (sum, e) => sum + (typeof e.count === 'number' ? e.count : 0),
    0,
  );
  const summary = {
    policyDispatchViolations: policyFindings.length,
    seamBypassesObserved: seamFindings.length,
    seamBypassesAcknowledged: acknowledgedTotal,
    ratchetViolations: ratchetFindings.length,
  };

  if (wantJson) {
    process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, findings, summary }, null, 2)}\n`);
    process.exitCode = findings.length === 0 ? 0 : 1;
    return;
  }

  if (findings.length === 0) {
    process.stdout.write(
      'ok state-write-path-drift: no policy-dispatch violations, no unrecorded/grown/shrunk/stale ' +
        'write-seam entries against the acknowledged baseline\n',
    );
    process.stdout.write(`${GOODHART_NOTE}\n`);
    process.exitCode = 0;
    return;
  }

  process.stderr.write(
    'state-write-path-drift: policy-dispatch and/or write-seam divergence found (ADR-3408 §8.1/§8.3). ' +
      'See docs/adr/3408-state-write-path-preservation.md for the contract:\n',
  );
  printFindings(findings);
  process.exitCode = 1;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  REASON,
  REPO_ROOT,
  BASELINE_PATH,
  SRC_DIRS,
  SRC_EXT,
  PROMPT_DIRS,
  PROMPT_EXT,
  EXECUTOR_FILE,
  SEAM_OWNER_FILE,
  SEAM_OWNER_EXEMPT_FUNCTIONS,
  toPosixRel,
  stripComments,
  enclosingFunction,
  readPolicyUnion,
  findPolicyDispatchDrift,
  findUnimplementedPolicies,
  findSeamBypasses,
  findPromptSeamUses,
  isInsideCodeSpan,
  ratchetKey,
  loadBaseline,
  applyRatchet,
  collect,
  buildBaselineEntries,
  main,
};

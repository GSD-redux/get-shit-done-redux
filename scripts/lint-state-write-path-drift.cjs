#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the STATE.md WRITE PATH — epic #3408, issue
 * #3468, ADR-3408 Decision 5, contract §8.1/§8.2/§8.3
 * (`docs/adr/3408-state-write-path-preservation.md` is the contract this
 * guard enforces; read it first) — SHRUNK per ADR-3473 §8.6 (issue #3871).
 *
 * WHAT MOVED INTO THE TYPE SYSTEM (ADR-3473 §8.6): `writeStateMd`'s third
 * parameter now REQUIRES a `StateTransaction` of `kind: 'rebuild'`, produced
 * only by `openStateTransaction()` / `rebuildStateTransaction()`
 * (`src/state-transition.cts`) — `writeStateMd` itself throws
 * `STATE_TRANSACTION_KIND_INVALID` for anything else. The two exceptions this
 * guard used to track as a RATCHETED STRING MATCH against
 * `scripts/state-write-path-drift-baseline.json` — `cmdStateSync`
 * (`src/state.cts`, #905's "let the body win") and `REGENERATE_STATE`
 * (`src/health-diagnostic.cts`, `/gsd-health --repair`'s factory reset) — are
 * NO LONGER TRACKED HERE. Both are now a constructor the type system names
 * (`rebuildStateTransaction`), not an entry a human had to remember to keep
 * acknowledging in a baseline file. That baseline file, and the whole
 * ratchet machinery that existed ONLY to support it (loading it, the
 * STALE-entry check, `--baseline` regeneration), is retired along with it —
 * the `writeStateMd(` ARM of the old `findSeamBypasses` axis is gone for
 * good, because the type system now names both of its exceptions.
 *
 * WHAT STAYED, RETITLED, AND MADE TERMINAL (issue #3871 review): the OTHER
 * half of `findSeamBypasses` — every direct `syncStateFrontmatter(` /
 * `applyPostSyncPreservation(` call outside their owner
 * (`syncAndPreserveStateMd`, `src/state.cts`) — is NOT redundant. The type
 * system gates `writeStateMd`'s THIRD PARAMETER; it says nothing about a call
 * site that re-assembles `syncStateFrontmatter` + `applyPostSyncPreservation`
 * itself instead of calling the one write-seam composition. ADR-3408 §8.3:
 * "Assembling the stages at a call site is a re-derivation even when every
 * step calls the owner." #3469 found exactly that shape live in
 * `cmdPhaseComplete`'s atomic-commit adapter (`src/phase.cts`) — every step
 * called an owner, so an owner-level test and this guard's OLD, narrower
 * scan both stayed green while the composition itself drifted from
 * `readModifyWriteStateMd`'s. See `findCompositionBypasses` below. Unlike
 * the retired `writeStateMd(` arm, this one ships TERMINAL, not ratcheted —
 * mirrors `findPromptSeamUses`'s own conversion in this same shrink: no
 * legitimate call site outside the owner exists today, so any occurrence is
 * a violation, not an entry to acknowledge.
 *
 * WHAT THIS GUARD STILL OWNS, because the type system cannot make it
 * unrepresentable:
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
 *   AXIS 2 — RAW STATE WRITE (§8.6, RETAINED). A direct `fs.writeFileSync(`
 *   call whose target argument is the state path (`statePath`, or a literal
 *   containing `STATE.md`) is a write that skips BOTH the write seam
 *   (`writeStateMd`/`syncAndPreserveStateMd`) AND the OS Shell Projection
 *   seam (`platformWriteSync`, `src/shell-command-projection.cts`) entirely.
 *   No constructor or type can make this unrepresentable — Node's `fs`
 *   module is always one `import` away — so this axis stays a plain
 *   string-match scan, unratcheted: any occurrence is a violation, because no
 *   legitimate call site in this codebase writes STATE.md this way (every
 *   real writer goes through `platformWriteSync`).
 *
 *   AXIS 3 — FRONTMATTER-SHAPED WRITE (§8.3(b), closed Phase 2 / #3469).
 *   `findUnstrippedContentWrites` below flags a `stateReplaceField(` call
 *   only when BOTH (a) its field-name argument is a VARIABLE, not a fixed
 *   string literal, and (b) its content argument has not been run through
 *   `stripFrontmatter` first (a narrow backward-scan approximation, not full
 *   dataflow — see the function's own docstring).
 *
 *   AXIS 4 — PROMPT-LAYER WRITE (§8.3, Decision 4(d)). Prose in the prompt
 *   layer instructing an agent to shell out to a write-side `gsd-tools`
 *   subcommand is the same write seam, expressed as markdown rather than
 *   TypeScript — a check the type system cannot reach at all, since markdown
 *   is never compiled. Any occurrence is a violation.
 *
 *   AXIS 5 — COMPOSITION BYPASS (§8.3, RETAINED, issue #3871). A direct
 *   `syncStateFrontmatter(` or `applyPostSyncPreservation(` call outside
 *   their owner (`syncAndPreserveStateMd`) is a re-assembly of the write-seam
 *   composition — the exact shape #3469 found live in `cmdPhaseComplete`.
 *   `writeStateMd(` is deliberately NOT scanned here (that arm is retired,
 *   §8.6) — `writeStateMd`'s own legitimate direct `syncStateFrontmatter(`
 *   call (the sanctioned #905 exception) is instead exempted by function
 *   name, same as the composition owner itself; see
 *   `SEAM_OWNER_EXEMPT_FUNCTIONS`. Terminal: any occurrence is a violation.
 *
 * DESIGN CONSTRAINTS (ADR-3180 Decision 4, adopted verbatim by ADR-3408):
 *   - 4(a) whole-repo scan, never an allowlist. ADR-3180's own phases found
 *     26/5/54 copies where their epics scoped 3/3/4 — a scoped guard earns
 *     nothing.
 *   - 4(d) the scan surface is DECLARED and is NOT just `src/` — `src/`
 *     alone is itself an allowlist one directory wide; #1762 traced a wrong
 *     count to a shell snippet in `gsd-core/workflows/progress.md`.
 *
 * GOODHART, PER ADR-3408 DECISION 5: "0 violations" is a LAGGING metric — a
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
 * CORRECTION TO ADR-3473 §8.6's TEXT, RECORDED HERE SO A FUTURE READER
 * COMPARING THE ADR TO THIS FILE DOES NOT CONCLUDE THE FILE DRIFTED:
 * §8.6 says this guard "keeps only its raw-write check (`fs.writeFileSync`
 * against the state path), which the type cannot make unrepresentable." That
 * sentence is wrong on both halves. First, no such check existed anywhere in
 * this file before this shrink — `findRawStateWrites` (Axis 2, below) is
 * NET-NEW, written for this shrink, not retained from a prior version.
 * Second, this file did not (and does not) drop to "only" one check: besides
 * the retired `writeStateMd(` arm of the old `findSeamBypasses` axis (the
 * half §8.6 correctly names for removal, since the type system now names
 * both of its exceptions), `findPolicyDispatchDrift`, `findUnimplementedPolicies`,
 * `findUnstrippedContentWrites`, `findPromptSeamUses`, and the RETAINED
 * `syncStateFrontmatter`/`applyPostSyncPreservation` composition-bypass half
 * of `findSeamBypasses` (now `findCompositionBypasses`, terminal — issue
 * #3871 review) all remain, because §8.6 names neither them nor anything
 * that makes what they check unrepresentable — a field-name-keyed dispatch
 * branch, an unimplemented `FieldPreservation` policy, an unstripped
 * frontmatter write, prompt-layer prose shelling out to `gsd-tools`, and a
 * re-assembled write-seam composition are all still exactly as representable
 * in TypeScript (or in markdown, for the prompt-layer one) after the
 * state-transaction constructor as they were before it — the constructor
 * gates `writeStateMd`'s third parameter, nothing about a call site that
 * never goes through `writeStateMd` at all. Do not edit the ADR to match
 * this file; this paragraph is the correction of record.
 */

const path = require('node:path');
const { scanTree, sanitizeForReport } = require('./lib/drift-scan.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

// Frozen REASON enum — mirrors `lint-state-field-drift.cjs`'s house style of
// naming every failure shape explicitly rather than reusing one generic
// "violation" string, so a reader can `grep` a reason string straight back
// to the paragraph of this header (or of the ADR) that explains it.
const REASON = Object.freeze({
  FIELD_NAME_DISPATCH: 'field_name_dispatch',
  UNIMPLEMENTED_POLICY: 'unimplemented_policy',
  // Axis 3 (§8.3(b), closed Phase 2 / #3469): a `stateReplaceField(` call
  // with a variable field-name argument whose content argument was not run
  // through `stripFrontmatter` first — see `findUnstrippedContentWrites`.
  UNSTRIPPED_CONTENT_WRITE: 'unstripped_content_write',
  // Axis 2 (§8.6, retained): a raw `fs.writeFileSync(` call targeting the
  // state path — see `findRawStateWrites`.
  RAW_STATE_WRITE: 'raw_state_write',
  // Axis 4 (§8.3, Decision 4(d)): prompt-layer prose shelling out to a
  // write-side `gsd-tools` subcommand — see `findPromptSeamUses`.
  PROMPT_LAYER_STATE_WRITE: 'prompt_layer_state_write',
  // Axis 5 (§8.3, RETAINED, issue #3871): a direct `syncStateFrontmatter(` or
  // `applyPostSyncPreservation(` call outside their owner
  // (`syncAndPreserveStateMd`) — see `findCompositionBypasses`.
  COMPOSITION_BYPASS: 'composition_bypass',
});

// Scan surface — declared, per Decision 4(d), never inferred from `src/`
// alone. `src/` covers the executor; the prompt layer covers markdown that
// can shell out to `state.patch` / `phase.complete` and post-process the
// result outside any TypeScript this guard could see.
const SRC_DIRS = ['src'];
const SRC_EXT = new Set(['.cts']);
const PROMPT_DIRS = ['gsd-core/workflows', 'commands', 'agents', 'skills'];
const PROMPT_EXT = new Set(['.md']);

// The executor (Axis 1 / Axis 3). Forward-slash literal: every `rel` this
// guard compares against it is unconditionally POSIX-normalized first
// (`toPosixRel` below) — never gated on `process.platform`.
const EXECUTOR_FILE = 'src/state-transition.cts';

// The write-seam composition owner (Axis 5). Forward-slash literal, same
// POSIX-normalization rule as `EXECUTOR_FILE` above.
const SEAM_OWNER_FILE = 'src/state.cts';

// Per Decision 4(d)'s "owner FILE is not exempt, only its named canonical
// FUNCTIONS are": a `syncStateFrontmatter(`/`applyPostSyncPreservation(` call
// inside one of these two functions, in `SEAM_OWNER_FILE` only, is the
// seam's own internal plumbing, not a bypass. `writeStateMd` is the
// `cmdStateSync`/`REGENERATE_STATE` path's own I/O wrapper calling
// `syncStateFrontmatter` directly (no preservation, by design — §8.3's
// closed exception list; ADR-3473 §8.6 gates ITS third parameter, which is
// an orthogonal, type-level check — this guard's exemption is about which
// FUNCTION BODY a raw call to the two seam stages is allowed to live in).
// `syncAndPreserveStateMd` is the ONE write-seam composition — every OTHER
// caller needing a non-standard I/O envelope routes through it. Every OTHER
// function in `state.cts` — and every function in every OTHER file — is
// still scanned and still flagged; in particular `readModifyWriteStateMd` is
// NOT exempt: it calls `syncAndPreserveStateMd` like everyone else, so if a
// direct `syncStateFrontmatter(`/`applyPostSyncPreservation(` call
// reappeared there it would be exactly the re-assembly shape this axis
// exists to catch.
const SEAM_OWNER_EXEMPT_FUNCTIONS = ['writeStateMd', 'syncAndPreserveStateMd'];

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
// SAME shape `nearestPrecedingAssignment` uses as its backward-scan boundary,
// and `enclosingFunction` below uses to recognise (and skip) the seam
// functions' own definitions.
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
    // `file` is sanitized here, at construction, not just at the human
    // formatter: `rel` is exactly as attacker-controlled as `source` on a
    // fork PR (a tracked filename can legally carry C1 bytes or bidi
    // overrides), and it reaches `--json` stdout unfiltered otherwise — see
    // `sanitizeForReport`'s own header.
    FIELD_NAME_DISPATCH_RE.lastIndex = 0;
    let m;
    while ((m = FIELD_NAME_DISPATCH_RE.exec(line)) !== null) {
      out.push({
        reason: REASON.FIELD_NAME_DISPATCH,
        axis: 'policy-dispatch',
        file: sanitizeForReport(rel),
        line: i + 1,
        // `field` is captured straight out of a quoted string literal in
        // repo source — attacker-controlled on the same fork-PR basis as
        // `file`/`source`, so sanitize it too rather than let it reach
        // `--json` stdout.
        field: sanitizeForReport(m[2]),
        source: sanitizeForReport(line.trim()),
      });
    }
    FIELD_VAR_EQ_LITERAL_RE.lastIndex = 0;
    while ((m = FIELD_VAR_EQ_LITERAL_RE.exec(line)) !== null) {
      out.push({
        reason: REASON.FIELD_NAME_DISPATCH,
        axis: 'policy-dispatch',
        file: sanitizeForReport(rel),
        line: i + 1,
        field: sanitizeForReport(m[2]),
        source: sanitizeForReport(line.trim()),
      });
    }
    LITERAL_EQ_FIELD_VAR_RE.lastIndex = 0;
    while ((m = LITERAL_EQ_FIELD_VAR_RE.exec(line)) !== null) {
      out.push({
        reason: REASON.FIELD_NAME_DISPATCH,
        axis: 'policy-dispatch',
        file: sanitizeForReport(rel),
        line: i + 1,
        field: sanitizeForReport(m[2]),
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
    // `file` and `policy` are sanitized here for the same reason as
    // `findPolicyDispatchDrift` above: both `rel` and a `FieldPreservation`
    // union member are attacker-controlled on a fork PR, exactly like
    // `source`.
    out.push({
      reason: REASON.UNIMPLEMENTED_POLICY,
      axis: 'policy-dispatch',
      file: sanitizeForReport(rel),
      line: 0,
      policy: sanitizeForReport(member),
      source: sanitizeForReport(`FieldPreservation member '${member}' has no executor`),
    });
  }
  return out;
}

// AXIS 3 (§8.3(b), closed Phase 2 / #3469): `stateReplaceField(<contentArg>,
// <fieldArg>, ...)` on a single line, capturing both argument expressions.
// `contentArg` must be a bare identifier (a call expression or property
// access as the first argument is not matched — silently out of scope, per
// this axis's own narrow-limitation note below) so its assignments can be
// tracked; `fieldArg` is everything up to the next comma, trimmed, so its
// literal-vs-variable shape can be read off directly.
const STATE_REPLACE_FIELD_CALL_RE = /\bstateReplaceField\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([^,()]+),/g;

// True when `arg` (already trimmed) is a fixed string/template literal —
// the safe shape, since every literal field name this codebase actually
// uses is a Title-Case body label that cannot collide with a lowercase/
// snake_case YAML frontmatter key.
function isQuotedLiteralArg(arg) {
  const t = arg.trim();
  return t.startsWith("'") || t.startsWith('"') || t.startsWith('`');
}

/**
 * The nearest assignment to `varName` (`varName = <expr>` or
 * `const|let|var varName = <expr>`), scanning `lines` BACKWARD from `index`
 * (inclusive) and stopping at the nearest preceding named-function
 * declaration. Returns the assigned expression's trimmed text, or `null`
 * when no such assignment is found before the boundary — meaning `varName`
 * is the enclosing function's own untouched parameter.
 *
 * Deliberately single-hop: this reports whatever the NEAREST assignment's
 * right-hand side literally is, and does not itself follow a further alias
 * (`let body = someOtherVar;` is reported as `"someOtherVar"`, not resolved
 * further). Every real call site in this file assigns its body variable
 * directly from `stripFrontmatter(content)` with no intermediate alias
 * (`updateCore`, `patchCore`, `beginPhaseCore`'s `tryField` helper) — a
 * future call site that introduces one extra hop of aliasing would evade
 * this check. A declared, narrow limitation, not a silent one — mirrors
 * this file's existing precedent (`FIELD_VAR_EQ_LITERAL_RE`'s own
 * documented scope) of accepting a bounded risk in trade for not chasing
 * full dataflow, which is exactly what made the Phase 1 approximation
 * unusable (29 false positives to 1 true positive).
 */
function nearestPrecedingAssignment(lines, index, varName) {
  const assignRe = new RegExp(`(?:^|[^.\\w$])(?:const|let|var)?\\s*${escapeRegex(varName)}\\s*=\\s*([^=].*)$`);
  for (let i = index; i >= 0; i--) {
    if (FUNCTION_DECL_LINE_RE.test(lines[i])) return null;
    const m = assignRe.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * AXIS 3: every `stateReplaceField(` call in `EXECUTOR_FILE` whose field-name
 * argument is a VARIABLE (not a quoted literal) — the only shape that can
 * ever rewrite YAML frontmatter, since `stateReplaceField`'s `^field:` line
 * pattern is case-insensitive and matches any line starting with that name,
 * literal or not — AND whose content argument was not assigned from
 * `stripFrontmatter(` at the nearest preceding assignment. A literal
 * field-name argument is never flagged regardless of stripping: every fixed
 * string this file's `stateReplaceField` calls use is a Title-Case body
 * label (`'Phase'`, `'Total Plans in Phase'`, ...) that cannot collide with
 * a lowercase/snake_case frontmatter key by construction, so checking its
 * content argument would only add false positives on the ~20 already-safe
 * `sectionBody`-scoped calls this axis must NOT report (mirrors
 * `updateCore`'s strip-then-replace shape, and `beginPhaseCore`'s
 * `stateReplaceField(body, name, value)`, both legitimately unflagged).
 */
function findUnstrippedContentWrites(rel, text) {
  const rawLines = text.split('\n');
  const stripped = stripComments(text);
  const out = [];
  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i];
    if (!line.trim()) continue;
    STATE_REPLACE_FIELD_CALL_RE.lastIndex = 0;
    let m;
    while ((m = STATE_REPLACE_FIELD_CALL_RE.exec(line)) !== null) {
      const contentArg = m[1];
      const fieldArg = m[2];
      if (isQuotedLiteralArg(fieldArg)) continue;
      const assignment = nearestPrecedingAssignment(stripped, i - 1, contentArg);
      const isStripped = assignment !== null && /^stripFrontmatter\s*\(/.test(assignment);
      if (isStripped) continue;
      // `file`/`source` sanitized for the same fork-PR reason as every other
      // finding in this guard; `contentArg` is captured out of repo source
      // (an identifier name), attacker-controlled on the same basis.
      out.push({
        reason: REASON.UNSTRIPPED_CONTENT_WRITE,
        axis: 'frontmatter-write',
        file: sanitizeForReport(rel),
        line: i + 1,
        field: sanitizeForReport(contentArg),
        source: sanitizeForReport(rawLines[i].trim()),
      });
    }
  }
  return out;
}

// AXIS 2 (§8.6, retained): `fs.writeFileSync(<targetArg>, ...)`, capturing
// the target-path argument up to the next comma. The type system (ADR-3473
// §8.6's `StateTransaction` constructors) closes the `writeStateMd`/
// `syncStateFrontmatter`/`applyPostSyncPreservation` bypass shape this guard
// used to scan for by function name; it cannot close a call site that skips
// those functions ENTIRELY and reaches for Node's raw `fs` module directly —
// that residual risk is what this axis stays alive to catch.
const RAW_WRITE_CALL_START_RE = /\bfs\.writeFileSync\s*\(/g;

/**
 * Capture `fs.writeFileSync`'s first-argument text starting at `startIdx`
 * (the offset right after its opening `(`), stopping at the first TOP-LEVEL
 * comma or the call's own closing paren — bracket/paren/brace depth and
 * string-literal spans are tracked so a nested call in the target expression
 * (e.g. `path.join(cwd, 'STATE.md')`) does not stop the scan at ITS internal
 * comma. A naive `[^,]+` capture (the guard's prior encoding) stopped at
 * `path.join(cwd` for exactly that shape, silently missing every
 * `fs.writeFileSync(path.join(cwd, 'STATE.md'), …)` call in the wild
 * (found via `tests/state-write-path-drift-guard.test.cjs` F1: "guard:
 * fs.writeFileSync against a STATE.md literal is reported").
 */
function captureFirstArg(line, startIdx) {
  let depth = 0;
  let inStr = null;
  let i = startIdx;
  for (; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break; // the call's own closing paren — no comma found
      depth--;
      continue;
    }
    if (c === ',' && depth === 0) break;
  }
  return line.slice(startIdx, i);
}

// True when the captured target-path expression plausibly names the STATE.md
// path: either the canonical `statePath` identifier this codebase uses at
// every real write site (see `src/state.cts`'s `writeStateMd`,
// `readModifyWriteStateMd`, `cmdStateMilestoneSwitch`), or a literal/template
// segment containing `STATE.md` outright.
function targetsStatePath(arg) {
  return /\bstatePath\b/.test(arg) || /STATE\.md/.test(arg);
}

/**
 * AXIS 2: every `fs.writeFileSync(` call in `text` whose target argument
 * names the state path is a raw write that bypasses BOTH the write seam
 * (`writeStateMd` / `syncAndPreserveStateMd`) and the OS Shell Projection
 * seam (`platformWriteSync`, `src/shell-command-projection.cts`) — no
 * legitimate call site in this codebase writes STATE.md this way today
 * (every real writer goes through `platformWriteSync`, whose OWN internal
 * `fs.writeFileSync` calls take a generic `filePath`/`tmpPath` argument, not
 * `statePath`, and are therefore never matched by `targetsStatePath` above).
 * Unratcheted, unexempted: any occurrence is a violation.
 */
function findRawStateWrites(rel, text) {
  const rawLines = text.split('\n');
  const stripped = stripComments(text);
  const out = [];
  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i];
    if (!line.trim()) continue;
    RAW_WRITE_CALL_START_RE.lastIndex = 0;
    let m;
    while ((m = RAW_WRITE_CALL_START_RE.exec(line)) !== null) {
      const argStart = m.index + m[0].length;
      const targetArg = captureFirstArg(line, argStart).trim();
      if (!targetsStatePath(targetArg)) continue;
      // `file`/`source` sanitized for the same fork-PR reason as every other
      // finding in this guard.
      out.push({
        reason: REASON.RAW_STATE_WRITE,
        axis: 'raw-write',
        file: sanitizeForReport(rel),
        line: i + 1,
        source: sanitizeForReport(rawLines[i].trim()),
      });
    }
  }
  return out;
}

// The two write-seam STAGE functions, matched only as CALLS (`\(`
// immediately after, modulo whitespace) — never as bare mentions of the
// name. `writeStateMd(` is deliberately NOT included here (that arm is
// retired — ADR-3473 §8.6 gates it at the type level instead).
const SEAM_CALL_RE = /\b(syncStateFrontmatter|applyPostSyncPreservation)\s*\(/g;
// A line that IS one of the two seam stage functions' own definitions —
// skipped outright, never counted as a call to itself.
const SEAM_DEF_LINE_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+(?:syncStateFrontmatter|applyPostSyncPreservation)\b/;

/**
 * AXIS 5 (§8.3, RETAINED, issue #3871): every direct `syncStateFrontmatter(`/
 * `applyPostSyncPreservation(` call in `text`, outside the two functions' own
 * definitions and (only inside `SEAM_OWNER_FILE`) outside
 * `SEAM_OWNER_EXEMPT_FUNCTIONS`'s own bodies. Terminal: unlike the old
 * `findSeamBypasses` this axis descends from, there is no ratchet — any
 * occurrence is `REASON.COMPOSITION_BYPASS` directly.
 */
function findCompositionBypasses(rel, text) {
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
      // `file`/`source` sanitized for the same fork-PR reason as every other
      // finding in this guard.
      out.push({
        reason: REASON.COMPOSITION_BYPASS,
        axis: 'composition-bypass',
        file: sanitizeForReport(rel),
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
 * AXIS 4: every prompt-layer line instructing an agent to shell out to a
 * write-side `gsd-tools` subcommand. Terminal (unratcheted): any occurrence
 * is a violation — this baseline was always empty for the prompt layer (no
 * prompt-layer entry was ever acknowledged), so removing the ratchet changes
 * nothing observable here.
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
 * opposite of Decision 4(a)'s intent.
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
      // `file` is sanitized here for the same reason as every other finding
      // in this guard: `rel` is attacker-controlled on a fork PR, exactly
      // like `source`.
      out.push({
        reason: REASON.PROMPT_LAYER_STATE_WRITE,
        axis: 'write-seam',
        file: sanitizeForReport(rel),
        line: i + 1,
        symbol: 'prompt-layer-state-write',
        source: sanitizeForReport(line.trim()),
      });
    }
  }
  return out;
}

/**
 * Run both scan passes (the `src/` tree for Axis 1 + Axis 2 + Axis 3 + Axis 5,
 * the prompt layer for Axis 4) and return the flat, already-terminal finding
 * list — every finding this guard produces carries its own `reason`; there
 * is no longer a ratcheted axis needing a second pass against a baseline.
 *
 * `root` defaults to `REPO_ROOT` (this repo) so every existing caller —
 * `npm run lint:ci`, a bare `node scripts/lint-state-write-path-drift.cjs`,
 * every other module that `require`s `collect` with no argument — is
 * byte-identical to before this parameter existed. It is overridable so a
 * test can exercise the guard's real scanning/reporting logic against a
 * throwaway synthetic tree instead of mutating this repository's own `src/`
 * to prove the guard can fail (see `--root` on the CLI, and F2 in
 * `tests/state-write-path-drift-guard.test.cjs`).
 */
function collect(root = REPO_ROOT) {
  const srcFindings = scanTree({
    root,
    scanDirs: SRC_DIRS,
    scanExt: SRC_EXT,
    onFile(rel, text) {
      const relPosix = toPosixRel(rel);
      const found = [];
      if (relPosix === EXECUTOR_FILE) {
        found.push(...findPolicyDispatchDrift(relPosix, text));
        found.push(...findUnimplementedPolicies(text, relPosix));
        found.push(...findUnstrippedContentWrites(relPosix, text));
      }
      found.push(...findRawStateWrites(relPosix, text));
      found.push(...findCompositionBypasses(relPosix, text));
      return found;
    },
  });

  const promptFindings = scanTree({
    root,
    scanDirs: PROMPT_DIRS,
    scanExt: PROMPT_EXT,
    onFile(rel, text) {
      return findPromptSeamUses(toPosixRel(rel), text);
    },
  });

  return { findings: [...srcFindings, ...promptFindings] };
}

const GOODHART_NOTE =
  'Goodhart note (ADR-3408 Decision 5): this "0 write-path violations" is a LAGGING metric — report ' +
  'it only alongside the behavioral identity test\'s result (asserted at the consumer\'s output), ' +
  'never alone.';

function printFindings(findings) {
  for (const f of findings) {
    process.stderr.write(`[${f.reason}] ${sanitizeForReport(f.file)}:${f.line}\n`);
    process.stderr.write(`    ${sanitizeForReport(f.source)}\n`);
  }
}

/**
 * Parse `argv` into `{ root, wantJson, unknown }`. `--root <dir>` overrides
 * the scan root (default `REPO_ROOT`, resolved relative to `process.cwd()`
 * when given); `--json` is a bare flag. Anything else lands in `unknown` so
 * `main` can report a usage error rather than silently ignoring a typo.
 */
function parseArgs(argv) {
  const args = argv || [];
  let root = REPO_ROOT;
  let wantJson = false;
  const unknown = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') {
      wantJson = true;
      continue;
    }
    if (a === '--root') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { error: '--root requires a directory argument' };
      }
      root = path.resolve(value);
      i += 1;
      continue;
    }
    unknown.push(a);
  }
  return { root, wantJson, unknown };
}

/**
 * `argv`: `--json` prints the machine-readable finding set instead of the
 * human-readable report; `--root <dir>` overrides the scan root (defaults to
 * this repo — see `parseArgs`'s own docstring). Exit codes: 0 clean, 1 a
 * finding was reported, 2 usage error.
 */
function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`lint-state-write-path-drift: ${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  const { root, wantJson, unknown } = parsed;
  if (unknown.length > 0) {
    process.stderr.write(
      `lint-state-write-path-drift: unrecognized argument(s): ${unknown.map((a) => sanitizeForReport(a)).join(', ')} ` +
        '(expected --json and/or --root <dir>)\n',
    );
    process.exitCode = 2;
    return;
  }

  const { findings } = collect(root);
  const summary = {
    policyDispatchViolations: findings.filter((f) => f.axis === 'policy-dispatch').length,
    frontmatterWriteViolations: findings.filter((f) => f.axis === 'frontmatter-write').length,
    rawWriteViolations: findings.filter((f) => f.axis === 'raw-write').length,
    writeSeamViolations: findings.filter((f) => f.axis === 'write-seam').length,
    compositionBypassViolations: findings.filter((f) => f.axis === 'composition-bypass').length,
  };

  if (wantJson) {
    process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, findings, summary }, null, 2)}\n`);
    process.exitCode = findings.length === 0 ? 0 : 1;
    return;
  }

  if (findings.length === 0) {
    process.stdout.write(
      'ok state-write-path-drift: no policy-dispatch, frontmatter-write, raw-write, prompt-layer, or ' +
        'composition-bypass violations found\n',
    );
    process.stdout.write(`${GOODHART_NOTE}\n`);
    process.exitCode = 0;
    return;
  }

  process.stderr.write(
    'state-write-path-drift: violation(s) found (ADR-3408 §8.1/§8.3, ADR-3473 §8.6). See ' +
      'docs/adr/3408-state-write-path-preservation.md and docs/adr/3473-enforcement-by-construction.md ' +
      'for the contract:\n',
  );
  printFindings(findings);
  process.exitCode = 1;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  REASON,
  REPO_ROOT,
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
  findUnstrippedContentWrites,
  isQuotedLiteralArg,
  nearestPrecedingAssignment,
  findRawStateWrites,
  targetsStatePath,
  findCompositionBypasses,
  findPromptSeamUses,
  isInsideCodeSpan,
  parseArgs,
  collect,
  main,
};

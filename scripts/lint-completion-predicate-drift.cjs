#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the PHASE-COMPLETION predicate (epic
 * #3180, issue #3186, ADR-3180 Decision 4, spec §7.4).
 *
 * The derivation this guard protects is "is phase P complete?", under the
 * DISK-STRICT rule §7.4 now locks (amended on this branch, commit
 * af92fd4c9, per the #2957 maintainer decision): `readVerificationStatus`
 * is called UNCONDITIONALLY (no plan-count precondition), and a ticked
 * ROADMAP checkbox carries NO machine authority over disk state. The
 * designated owner is `src/verification.cts` · `isPhaseComplete` (Decision
 * 1). Per ADR-3180 Amendment 3's standing rule this guard was written BEFORE
 * any src/ file was touched (guard-first discovery), with
 * `FUNCTION_SCOPED_EXEMPTIONS` below INTENTIONALLY EMPTY at that point. The
 * implementation step (issue #3186) has since landed `isPhaseComplete` and
 * migrated its call sites onto it, and populated the map — see its own
 * comment immediately above its definition for the per-entry reasoning,
 * including two DECLARED DEVIATIONS (`buildPhaseCompletionProjection`'s
 * retained `implementation_complete` and `buildWorkstreamInventory`'s
 * pure-projection boundary) not named by the design doc's own
 * DO-NOT-MIGRATE list.
 *
 * Per ADR-3180 Decision 4(a) this guard discovers call sites by SCANNING THE
 * WHOLE `src/` TREE, never an allowlist of known files. Per Decision 4(d)
 * that surface is widened further: `src/` alone is itself the forbidden
 * allowlist, one directory wide, so this guard ALSO scans the prompt-layer
 * markdown (`gsd-core/workflows`, `commands`, `agents`, `skills`) — see the
 * "PROMPT-LAYER PROSE DETECTION" section below.
 *
 * THREE INDEPENDENT SHAPES are detected, matching issue #3186's dispatch:
 *
 *   (a) CHECKBOX-DERIVED COMPLETION — a ROADMAP `- [x] Phase N` tick treated
 *       as completion evidence. Categorically wrong under disk-strict
 *       (§7.4's DECIDED resolution: "a ticked ROADMAP checkbox is a human
 *       annotation with no machine authority"). Detected as the PAIRED
 *       shape actually observed twice in this tree: an `if` statement whose
 *       condition references a roadmap/checkbox-derived "complete" boolean
 *       AND tests some status variable `!== 'complete'`, followed (within a
 *       small bounded window — this pairs ONE conditional with its OWN
 *       consequent statement, the same tight-pairing role
 *       `lint-state-field-drift.cjs`'s `LADDER_WINDOW_LINES` plays, NOT the
 *       big function-scoped co-occurrence Decision 4(a)'s Goodhart lesson
 *       targets) by an assignment of that SAME variable to the literal
 *       `'complete'`.
 *   (b) PLAN-COUNT PRECONDITION GATING A VERIFICATION READ — §7.4 names this
 *       exactly as `buildPhaseCompletionProjection`'s divergence: a
 *       `planCount > 0`-shaped gate that decides WHETHER
 *       `readVerificationStatus(` runs at all, rather than calling it
 *       unconditionally. Detected as FUNCTION-SCOPED co-occurrence (no
 *       window — Decision 4(a)'s Goodhart lesson, and Phase 5's "bounded
 *       window missed 7 of 14 copies" trap) of a count-gate ANYWHERE in the
 *       function's own body, together with a ternary- or `if`-gated call to
 *       `readVerificationStatus(` (a call that is NOT the function's
 *       unconditional top-level statement).
 *   (c) LOCAL RE-IMPLEMENTATION OF "COMPLETE" FROM COUNTS — a
 *       `summaryCount >= planCount`-shaped comparison (either operand
 *       order), computed locally instead of calling the owner. This is the
 *       single sharpest textual signature this epic's divergent copies
 *       share: `buildPhaseCompletionProjection`, `buildStateFrontmatter`
 *       (via `scanPhasePlans`'s own `completed` field),
 *       `cmdRoadmapAnalyze`, `cmdRoadmapUpdatePlanProgress`, and
 *       `buildWorkstreamInventory` all independently hand-roll this exact
 *       comparison.
 *
 * DETECTION IS FUNCTION-SCOPED, NOT A BOUNDED LINE-WINDOW, for the
 * *discovery* co-occurrence in each shape (shape (a)'s if/assignment pairing
 * and shape (b)'s ternary-clause pairing are each ONE conditional's own two
 * halves — the same narrow, unavoidable pairing `LADDER_WINDOW_LINES` bounds
 * in the sibling state-field guard, not a re-derivation-hiding Goodhart
 * target). Phase 5's first guard used a bounded line window between a
 * ladder and its consuming call and MISSED 7 of 14 live copies inside the
 * very function it scanned — that lesson is why shape (b)'s outer
 * count-gate/gated-call pairing has NO line-distance bound at all: both
 * signals need only appear somewhere in the SAME named function.
 *
 * COMMENT-AWARE. Phase 3's first `lint-phase-enumeration-drift.cjs` flagged
 * JSDoc/inline comments that merely DOCUMENTED the derivation, not code that
 * re-derives it (ADR-3180 Amendment 3). This guard reuses the SAME
 * comment/string-stripping tokenizer `lint-state-field-drift.cjs` proved
 * (`scanCode` below): comments and string/template literal CONTENTS are
 * blanked before any detection regex runs, cross-line-aware for block
 * comments and multi-line template literals.
 *
 * FUNCTION-SCOPED EXEMPTIONS ONLY, NEVER A WHOLE-FILE ALLOWLIST (Decision
 * 4(a)/(d)): a whole-file exemption on the owner is precisely how
 * `getMilestoneInfo` stayed invisible to an earlier guard (Decision 4(d)).
 * `FUNCTION_SCOPED_EXEMPTIONS` is a `Map<relPath, Set<functionName>>`, kept
 * EMPTY here because the owner (`src/verification.cts` · `isPhaseComplete`)
 * does not exist yet — this comment, not a populated map, is what the
 * implementation step (Phase 4's migration PR) replaces.
 *
 * Every regex below is small, bounded, and has no nested/overlapping
 * quantifiers — the same ReDoS discipline `npm run lint:ci`'s CodeQL
 * js/redos query verifies over every sibling drift guard.
 *
 * The tree-walk / root-confinement / sanitizer machinery is SHARED with the
 * sibling drift guards via `scripts/lib/drift-scan.cjs` (ADR-3180 Decision
 * 4).
 */

const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { MAX_REGEX_LITERAL_LEN, sanitizeForReport, scanTree } = driftScan;

// ─── SHARED TOKENIZER + FUNCTION ATTRIBUTION (mirrors lint-state-field-drift.cjs) ──
//
// Two parallel per-line views from ONE single-pass, escape-aware character
// scan (not a regex — nothing for a backtracking engine to explore):
//   - `detect[i]`: comments stripped, string/template CONTENTS kept verbatim
//     (this is what every detection regex below runs against).
//   - `braces[i]`: comments AND string/template CONTENTS stripped, used only
//     for brace-depth counting, so a brace inside a string/comment never
//     perturbs the depth count.
// `inBlockComment` / `inTemplate` are threaded ACROSS lines. Regex literals
// are not specially recognised — same documented, narrow, known limitation
// as the sibling guards (harmless for every regex literal actually present
// in this repo's completion-predicate call sites today, each balanced on
// its own line).
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
      outDetect += line.slice(start, i);
      if (inTemplate) {
        detect[li] = outDetect;
        braces[li] = '';
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
        i = line.length;
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
            j += 2;
            continue;
          }
          if (line[j] === quote) {
            j++;
            break;
          }
          j++;
        }
        outDetect += line.slice(start, j);
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
          outDetect += line.slice(start);
          inTemplate = true;
          i = line.length;
          break;
        }
        outDetect += line.slice(start, j);
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

// Named function scope openers (mirrors lint-state-field-drift.cjs exactly):
//   - `function NAME(...) {` — top-level OR nested, any indentation, an
//     optional leading `export ` tolerated by `\b` alone.
const FUNCTION_DECL_RE = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/;
//   - `const NAME = (...): ReturnType => {` — block-bodied arrow assigned to
//     a const (an expression-bodied arrow `=> ({...})` never opens a new
//     function frame; its `{` is an object literal, still counted toward
//     brace depth, but attributes no name).
const ARROW_CONST_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*(?::\s*[^=]+)?=>\s*\{/;

/**
 * Pure: walk `lines` once, maintaining a brace-depth stack of open named
 * function frames (deferring a multi-line `function NAME(` signature until
 * the line whose brace count actually increases — see
 * `lint-state-field-drift.cjs`'s `buildFunctionInfo` header for the full
 * rationale this mirrors verbatim). Returns `{ innermostAt, detect }`:
 * `innermostAt[i]` is the name of the innermost named function open at line
 * `i` (or `null` at module scope), `detect[i]` is the comment/string-
 * preserving-but-stripped-of-comments view every detector regex runs
 * against.
 */
function buildFunctionInfo(lines) {
  const { detect, braces } = scanCode(lines);
  const innermostAt = new Array(lines.length).fill(null);
  const stack = []; // { name, openDepth }
  let depth = 0;
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
        if (declMatch) pendingDeclName = declMatch[1];
      }
    }

    const opens = (braceCode.match(/\{/g) || []).length;
    const closes = (braceCode.match(/\}/g) || []).length;
    depth += opens - closes;

    if (immediateName) stack.push({ name: immediateName, openDepth: depth });

    if (pendingDeclName) {
      if (opens > 0) {
        stack.push({ name: pendingDeclName, openDepth: depth });
        pendingDeclName = null;
      } else if (detectCode.includes(';')) {
        pendingDeclName = null;
      }
    }

    while (stack.length > 0 && depth < stack[stack.length - 1].openDepth) stack.pop();

    innermostAt[i] = stack.length > 0 ? stack[stack.length - 1].name : null;
  }
  return { innermostAt, detect };
}

// ─── SHAPE (a): CHECKBOX-DERIVED COMPLETION ────────────────────────────────
//
// The `if` half of the pairing: a condition referencing a roadmap/checkbox-
// derived "complete" boolean (`roadmapComplete`, `roadmap_complete`, any
// `\w*roadmap\w*complete\w*` spelling — case-insensitive, both real sites in
// this tree use exactly `roadmapComplete`) AND testing some OTHER status
// variable against the literal `!== 'complete'` (single or double quotes).
const IF_OPEN_RE = /\bif\s*\(/;
const ROADMAP_COMPLETE_IDENT_RE = /\broadmap\w*complete\w*\b/i;
const STATUS_NEQ_COMPLETE_RE = /\b([A-Za-z_$][\w$]*)\s*!==\s*['"]complete['"]/;

// The consequent half: an assignment of the SAME status variable to the
// literal `'complete'`. The negative lookbehind excludes `!==`/`<=`/`>=`/`==`
// (each of which also contains a bare `=` immediately before a quote) so
// this never re-matches the `if` line's own `!== 'complete'` clause — a
// single bounded character class, not a nested quantifier.
const ASSIGN_COMPLETE_RE = /(?<![!<>=])=\s*['"]complete['"]/;

// How many lines the consequent assignment may trail its own `if` line by.
// This bounds ONE conditional's own two halves (condition, then its direct
// consequent statement) — the same narrow role `LADDER_WINDOW_LINES` plays
// in the sibling state-field guard, not the function-scoped, unbounded
// co-occurrence Decision 4(a)'s Goodhart lesson targets for shape (b) below.
const CHECKBOX_OVERRIDE_WINDOW_LINES = 4;

// The `if (...)` condition in both real sites nests a SECOND, unrelated
// parenthesised group (`(completion.phase_complete || planCount === 0)`), so
// a single-line, no-nested-parens regex over the whole condition
// systematically MISSES the second site. Extracted by plain paren-depth
// counting instead — a linear character walk, not a regex, so there is
// nothing for a backtracking engine to explore regardless of nesting depth.
// Bounded to IF_CONDITION_MAX_LINES so a pathologically unterminated `if (`
// cannot walk the whole file.
const IF_CONDITION_MAX_LINES = 10;

function extractIfCondition(detectLines, startLine, startCol) {
  let depth = 1; // the `(` at startCol already opened the condition
  let text = '';
  const endLineLimit = Math.min(detectLines.length, startLine + IF_CONDITION_MAX_LINES);
  for (let li = startLine; li < endLineLimit; li++) {
    const line = detectLines[li];
    const from = li === startLine ? startCol : 0;
    for (let ci = from; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return { text, endLine: li };
      }
      text += ch;
    }
    text += '\n';
  }
  return null; // unterminated within the bound — treated as no match
}

function findChecklistOverrideDrift(text, relPath, exemptFunctions) {
  const out = [];
  const lines = text.split('\n');
  const { innermostAt, detect } = buildFunctionInfo(lines);
  for (let i = 0; i < lines.length; i++) {
    const detectCode = detect[i];
    if (!detectCode.trim()) continue;
    const ifMatch = IF_OPEN_RE.exec(detectCode);
    if (!ifMatch) continue;
    const startCol = ifMatch.index + ifMatch[0].length;
    const condition = extractIfCondition(detect, i, startCol);
    if (!condition) continue;
    if (!ROADMAP_COMPLETE_IDENT_RE.test(condition.text)) continue;
    const neqMatch = STATUS_NEQ_COMPLETE_RE.exec(condition.text);
    if (!neqMatch) continue;
    const varName = neqMatch[1];
    const limit = Math.min(lines.length, condition.endLine + 1 + CHECKBOX_OVERRIDE_WINDOW_LINES);
    for (let j = condition.endLine + 1; j < limit; j++) {
      const assignCode = detect[j];
      if (!assignCode.trim()) continue;
      if (!assignCode.includes(varName)) continue;
      if (!ASSIGN_COMPLETE_RE.test(assignCode)) continue;
      const fn = innermostAt[j] || innermostAt[i];
      if (fn && exemptFunctions && exemptFunctions.has(fn)) break;
      out.push({ line: j + 1, found: lines[j].trim().slice(0, MAX_REGEX_LITERAL_LEN), shape: 'a', fn: fn || null });
      break;
    }
  }
  return out;
}

// ─── SHAPE (b): PLAN-COUNT PRECONDITION GATING A VERIFICATION READ ─────────
//
// A "count > 0"-shaped gate — any identifier containing `count`
// (case-insensitive) compared `> 0`. Function-scoped presence only (no
// window): §7.4 names this exact shape as `planCount > 0`, but the
// identifier is matched generically so a differently-named count (or a
// future `isPhaseComplete` re-implementation reusing the same gate under a
// new name) is still caught.
const COUNT_GATE_RE = /\b[A-Za-z_$][\w$]*count\b\s*>\s*0\b/i;

// The call this derivation's owner (`readVerificationStatus`, wrapped by the
// not-yet-existing `isPhaseComplete`) must run UNCONDITIONALLY per §7.4. A
// line where `readVerificationStatus(` is reached via a ternary — a `?`
// appearing anywhere earlier on the SAME line — is a GATED call, not an
// unconditional one. `[^\n]*` is bounded by the line itself (no backtracking
// blow-up: a single non-newline character class followed by one literal).
const VERIFICATION_READ_CALL_RE = /\breadVerificationStatus\(/;
const GATED_VERIFICATION_READ_RE = /\?[^\n]*\breadVerificationStatus\(/;

function findGatedVerificationReadDrift(text, relPath, exemptFunctions) {
  const out = [];
  const lines = text.split('\n');
  const { innermostAt, detect } = buildFunctionInfo(lines);

  const countGateFns = new Set();
  for (let i = 0; i < lines.length; i++) {
    const detectCode = detect[i];
    if (!detectCode.trim()) continue;
    if (COUNT_GATE_RE.test(detectCode)) {
      const fn = innermostAt[i];
      if (fn) countGateFns.add(fn);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const detectCode = detect[i];
    if (!detectCode.trim()) continue;
    if (!VERIFICATION_READ_CALL_RE.test(detectCode)) continue;
    if (!GATED_VERIFICATION_READ_RE.test(detectCode)) continue;
    const fn = innermostAt[i];
    if (!fn || !countGateFns.has(fn)) continue;
    if (exemptFunctions && exemptFunctions.has(fn)) continue;
    out.push({ line: i + 1, found: lines[i].trim().slice(0, MAX_REGEX_LITERAL_LEN), shape: 'b', fn });
  }
  return out;
}

// ─── SHAPE (c): LOCAL RE-IMPLEMENTATION OF "COMPLETE" FROM COUNTS ──────────
//
// `summaryCount >= planCount` (either identifier order, either comparison
// direction) — the single textual signature `buildPhaseCompletionProjection`,
// `scanPhasePlans`, `cmdRoadmapAnalyze`, `cmdRoadmapUpdatePlanProgress`, and
// `buildWorkstreamInventory` each independently hand-roll. Case-insensitive
// so `SummaryCount`/`summary_count` spellings are still caught; both operand
// orders are covered by two small, non-overlapping alternatives.
const SUMMARY_GE_PLAN_RE = /\bsummar\w*count\w*\s*>=\s*\w*plan\w*count\w*/i;
const PLAN_LE_SUMMARY_RE = /\bplan\w*count\w*\s*<=\s*\w*summar\w*count\w*/i;

function findLocalCompletionCountDerivationDrift(text, relPath, exemptFunctions) {
  const out = [];
  const lines = text.split('\n');
  const { innermostAt, detect } = buildFunctionInfo(lines);
  for (let i = 0; i < lines.length; i++) {
    const detectCode = detect[i];
    if (!detectCode.trim()) continue;
    if (!SUMMARY_GE_PLAN_RE.test(detectCode) && !PLAN_LE_SUMMARY_RE.test(detectCode)) continue;
    const fn = innermostAt[i];
    if (fn && exemptFunctions && exemptFunctions.has(fn)) continue;
    out.push({ line: i + 1, found: lines[i].trim().slice(0, MAX_REGEX_LITERAL_LEN), shape: 'c', fn: fn || null });
  }
  return out;
}

function findCompletionPredicateDrift(text, relPath) {
  const exemptFunctions = FUNCTION_SCOPED_EXEMPTIONS.get(relPath) || null;
  return [
    ...findChecklistOverrideDrift(text, relPath, exemptFunctions),
    ...findGatedVerificationReadDrift(text, relPath, exemptFunctions),
    ...findLocalCompletionCountDerivationDrift(text, relPath, exemptFunctions),
  ].sort((x, y) => x.line - y.line);
}

// ─── PROMPT-LAYER PROSE/SHELL DETECTION (ADR-3180 Decision 4(d)) ───────────
//
// The SAME question — "is phase P complete?" — expressed as shell/jq inside
// workflow markdown rather than TypeScript. `gsd-core/workflows/mvp-phase.md`
// reads `.roadmap_complete` (a ROADMAP-checkbox-derived JSON field) into a
// shell variable and later OR's it directly into a `STATUS="completed"`
// decision — shape (a), independently of and in addition to
// `cmdRoadmapAnalyze`'s own checkbox override at the source of that field.
//
// Two-line pairing, mirroring the TS-side shape (a) detector: line A assigns
// a shell variable from `.roadmap_complete` (or `.roadmap_complete` accessed
// any other way jq/shell might spell it); line B, within a bounded window
// (shell scripts interleave unrelated statements more than a single `if`
// body does, so this window is wider than the TS pairing's), uses that same
// variable in a `==` test against `"true"` — the same tight, unavoidable
// two-statement pairing as its TS counterpart, not a Goodhart-vulnerable
// function-scoped sweep (a Bash script has no function-scope concept this
// guard tracks).
const PROMPT_ROADMAP_COMPLETE_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=.*\.roadmap_complete\b/;
const PROMPT_TRUE_TEST_RE = /==\s*['"]true['"]/;
const PROMPT_OVERRIDE_WINDOW_LINES = 10;

function findPromptCompletionDrift(text, relPath) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const assignMatch = PROMPT_ROADMAP_COMPLETE_ASSIGN_RE.exec(lines[i]);
    if (!assignMatch) continue;
    const varName = assignMatch[1];
    const limit = Math.min(lines.length, i + 1 + PROMPT_OVERRIDE_WINDOW_LINES);
    for (let j = i + 1; j < limit; j++) {
      const line = lines[j];
      if (!line.includes(`$${varName}`)) continue;
      if (!PROMPT_TRUE_TEST_RE.test(line)) continue;
      out.push({ line: j + 1, found: line.trim().slice(0, MAX_REGEX_LITERAL_LEN), shape: 'a' });
      break;
    }
  }
  return out;
}

// Authored TypeScript source AND the prompt layer (ADR-3180 Decision 4(d)):
// `src/` alone is itself the forbidden allowlist Decision 4(d) names.
const SCAN_DIRS = ['src', 'gsd-core/workflows', 'commands', 'agents', 'skills'];
const SCAN_EXT = new Set(['.cts', '.ts', '.mts', '.md']);

// The designated owner (issue #3186, ADR-3180 §7.4) — does NOT exist yet.
const OWNER_FILE = path.join('src', 'verification.cts');

// Per ADR-3180 Decision 4(a)/(d): function-scoped, NEVER a whole-file
// allowlist. Populated by Phase 4's implementation step (issue #3186):
//
//   - `isPhaseComplete` (OWNER_FILE, src/verification.cts) — the canonical
//     owner itself. It reads `verification.status === 'passed'` (shape (c)'s
//     textual match is a false positive here: the owner's OWN comparison is
//     not a re-derivation of itself) and its readdirSync-based readability
//     check for `scope: UNREADABLE` sits beside a ternary-gated read that is
//     NOT a `readVerificationStatus(` call, so shapes (a)/(b) never fire here
//     either — this entry exists for defence in depth and Decision 4(d)'s
//     "the owner file is not exempt, only its named function is" rule.
//
//   - `scanPhasePlans` (src/plan-scan.cts) — ADR-3180 §7.4 / the design's
//     "0.x split": `completed: allPlanFiles.length > 0 && summaryCount >=
//     planCount` answers "are all plans summarized?", NOT "is the phase
//     complete?" (completion additionally requires a passing
//     `*-VERIFICATION.md`). Folding it onto `isPhaseComplete` would either
//     over-report completion or drag a verification read into plan-scan.cts,
//     inverting the dependency direction between Phase 1's owner and this
//     one (the owner consumes plan counts, never the reverse). Left as its
//     own, differently-scoped answer, per design's "Rejected" list item 1.
//
//   - `buildWorkstreamInventory` (src/workstream-inventory-builder.cts) — a
//     PURE, I/O-free projection (see the module's own header) over
//     PRE-COLLECTED `planCount`/`summaryCount`/`verificationStatus` inputs.
//     `summariesMeetPlans = summaryCount >= planCount && planCount > 0`
//     answers "are all plans summarized?" (combined with the caller-supplied
//     verification verdict for its own `status` projection) — it cannot call
//     the I/O-bound `isPhaseComplete` without breaking its "No I/O. No
//     async." contract, and re-plumbing its callers to pass a pre-computed
//     `complete` boolean instead of raw counts is a larger architectural
//     change than this phase's declared 6 call sites. Declared deviation —
//     see the Phase 4 migration PR for the full reasoning.
//
//   - `buildPhaseCompletionProjection` (src/init.cts) — MIGRATED onto
//     `isPhaseComplete` for `phase_complete`/`verification_status` (shape
//     (b) and the unconditional-read half of shape (c) are gone), but it
//     independently retains `implementation_complete = planCount > 0 &&
//     summaryCount >= planCount` as a DIFFERENT, still-needed answer ("are
//     plans done", not "is the phase complete") that `isPhaseComplete`'s
//     locked `{ complete, verification }` return shape does not carry and
//     that downstream consumers (`disk_status: 'executed'` vs `'planned'`)
//     still depend on. This is a declared deviation, not named by the design
//     doc's own DO-NOT-MIGRATE list (which named only `scanPhasePlans` and
//     `buildWorkstreamInventory`) — flagged for orchestrator review rather
//     than silently exempted.
const FUNCTION_SCOPED_EXEMPTIONS = new Map([
  [OWNER_FILE, new Set(['isPhaseComplete'])],
  [path.join('src', 'plan-scan.cts'), new Set(['scanPhasePlans'])],
  [path.join('src', 'workstream-inventory-builder.cts'), new Set(['buildWorkstreamInventory'])],
  [path.join('src', 'init.cts'), new Set(['buildPhaseCompletionProjection'])],
]);

function scanRepo(root) {
  return scanTree({
    root,
    scanDirs: SCAN_DIRS,
    scanExt: SCAN_EXT,
    onFile(rel, text) {
      const finder = path.extname(rel) === '.md' ? findPromptCompletionDrift : findCompletionPredicateDrift;
      return finder(text, rel).map((d) => ({ file: rel, ...d }));
    },
  });
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write('ok completion-predicate-drift: no unsanctioned phase-completion re-derivations found\n');
    return;
  }
  process.stderr.write('completion-predicate-drift: independent re-derivation(s) of the phase-completion\n');
  process.stderr.write('predicate ("is phase P complete?") found. Route these call sites through\n');
  process.stderr.write('src/verification.cts `isPhaseComplete` (issue #3186, ADR-3180 §7.4) instead of\n');
  process.stderr.write('re-deriving it locally:\n');
  for (const d of violations) {
    const shapeLabel = d.shape ? `[shape ${d.shape}]` : '';
    const fnLabel = d.fn ? ` (in ${sanitizeForReport(d.fn)})` : '';
    process.stderr.write(`  ${sanitizeForReport(d.file)}:${d.line} ${shapeLabel}${fnLabel}  ${sanitizeForReport(d.found)}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findCompletionPredicateDrift,
  findChecklistOverrideDrift,
  findGatedVerificationReadDrift,
  findLocalCompletionCountDerivationDrift,
  findPromptCompletionDrift,
  buildFunctionInfo,
  scanCode,
  scanRepo,
  IF_OPEN_RE,
  ROADMAP_COMPLETE_IDENT_RE,
  STATUS_NEQ_COMPLETE_RE,
  ASSIGN_COMPLETE_RE,
  CHECKBOX_OVERRIDE_WINDOW_LINES,
  IF_CONDITION_MAX_LINES,
  extractIfCondition,
  COUNT_GATE_RE,
  VERIFICATION_READ_CALL_RE,
  GATED_VERIFICATION_READ_RE,
  SUMMARY_GE_PLAN_RE,
  PLAN_LE_SUMMARY_RE,
  PROMPT_ROADMAP_COMPLETE_ASSIGN_RE,
  PROMPT_TRUE_TEST_RE,
  PROMPT_OVERRIDE_WINDOW_LINES,
  FUNCTION_DECL_RE,
  ARROW_CONST_RE,
  OWNER_FILE,
  FUNCTION_SCOPED_EXEMPTIONS,
  SCAN_DIRS,
  SCAN_EXT,
  MAX_REGEX_LITERAL_LEN,
};

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
 * FOUR INDEPENDENT SHAPES are detected, matching issue #3186's dispatch (shape
 * (d) added by the Phase 4 follow-up that closed the `cmdStateSync` /
 * `src/state.cts` gap the remote matrix exposed — see shape (d)'s own header
 * below):
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
 *       function's own body, together with a ternary- OR block/`if`-gated
 *       call to `readVerificationStatus(` (a call that is NOT the function's
 *       unconditional top-level statement) — the ternary form is a same-line
 *       `?` before the call; the block form is a call sitting inside the
 *       BODY of an `if (...)` whose OWN condition matches the count-gate
 *       (`findIfCountGateBlockLines`), which also catches `if (planCount >
 *       0) { x = readVerificationStatus(...) }` — a #3186 review finding
 *       (4a): the prior version matched only the same-line ternary and
 *       produced zero hits on the block form. Known, disclosed limit: a
 *       multi-line `if` condition whose opening `{` lands on a later line
 *       than the condition's own closing `)` is not detected (every
 *       count-gate condition actually present in this tree is one line).
 *   (c) LOCAL RE-IMPLEMENTATION OF "COMPLETE" FROM COUNTS — a
 *       `summaryCount >= planCount`-shaped comparison (either operand
 *       order, or the algebraic `summaryCount - planCount >= 0` restatement
 *       and its mirror), computed locally instead of calling the owner.
 *       Known, disclosed limit: further algebraic restatements (an
 *       intermediate difference variable, `Math.max`/`!()`-wrapped forms,
 *       etc.) are not reliably matchable by a bounded, non-backtracking
 *       regex and are not attempted — see the regexes' own comment. This is
 *       the single sharpest textual signature this epic's divergent copies
 *       share: `buildPhaseCompletionProjection`, `buildStateFrontmatter`
 *       (via `scanPhasePlans`'s own `completed` field),
 *       `cmdRoadmapAnalyze`, `cmdRoadmapUpdatePlanProgress`, and
 *       `buildWorkstreamInventory` all independently hand-roll this exact
 *       comparison.
 *   (d) A BARE FIELD READ OF `scanPhasePlans(...).completed` OUTSIDE THE
 *       OWNER (`src/plan-scan.cts`) — the shape the remote matrix exposed:
 *       `cmdStateSync` (`src/state.cts`, now fixed) destructured
 *       `scanPhasePlans(dirPath).completed` directly and used it AS a
 *       completion verdict, with no comparison for shapes (a)/(b)/(c) to
 *       catch — a bare property read is not a re-derivation shape any of the
 *       other three detectors match. `scanPhasePlans` legitimately EXPOSES
 *       `.completed` (it is Phase 1's own owner for "are all plans
 *       summarized?", a real and distinct question from "is the phase
 *       complete?"), so reading the field is not inherently wrong — USING it
 *       as a completion verdict is. That distinction is DATA-FLOW (what the
 *       caller does with the value), which no textual guard can decide.
 *       KNOWN, DISCLOSED, HONEST LIMIT: this detector cannot tell a
 *       legitimate "are summaries caught up with plans" read from an illegal
 *       "is the phase complete" read — it flags EVERY read of `.completed`
 *       off a `scanPhasePlans(` result outside `src/plan-scan.cts` and
 *       relies on `FUNCTION_SCOPED_EXEMPTIONS` carrying a WRITTEN REASON per
 *       exempted function (see that map's own comment for each current
 *       entry's reasoning) rather than silently deciding the question for
 *       itself. Detected in three independent textual forms, ALL
 *       function-scoped (Decision 4(a), no line window — see below):
 *         - the direct chained form, `scanPhasePlans(...).completed`, on one
 *           statement — the call's own argument list is walked with a plain
 *           paren-depth counter (not a `[^)]*` regex), so a nested-paren
 *           argument (`scanPhasePlans(path.join(phasesDir, dir))`, the
 *           majority real shape in this tree) is still matched correctly;
 *         - the destructured form, `const { completed } = scanPhasePlans(…)`
 *           or the renamed-alias form `const { completed: isDone } =
 *           scanPhasePlans(…)`, on one statement;
 *         - the INDIRECT form — `const scan = scanPhasePlans(…)` binding the
 *           whole result to a variable, with `.completed` read off that same
 *           variable ANYWHERE else in the SAME named function, including on a
 *           different line — no bounded window (the same Phase-5 "bounded
 *           window missed 7 of 14 copies" lesson shape (b) already learned;
 *           `cmdStateSync`'s own real shape bound the result to a
 *           destructured `{ planCount: plans, summaryCount: summaries }`
 *           rather than a whole-object variable, so this indirect form is
 *           precautionary breadth for a shape not yet observed in this tree,
 *           not a shape already caught in the wild).
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
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

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

/**
 * §7.4/#3186 review finding 4(a): the BLOCK form of shape (b)'s gate — `if
 * (planCount > 0) { … readVerificationStatus(…) … }` — is textually
 * indistinguishable from an unrelated `if` block by a same-line regex; the
 * prior ternary-only `GATED_VERIFICATION_READ_RE` produced zero hits on it.
 * Deliberately narrower than a generic "is this line nested at all" check
 * (which would false-positive on every unrelated wrapper — a `try` block, a
 * `withPlanningLock(cwd, () => { … })` callback, a `for` loop — none of
 * which are a plan-count GATE): only lines inside the BODY of an `if (...)`
 * whose OWN condition matches `COUNT_GATE_RE` are marked. Line-granularity
 * brace bookkeeping (mirrors `buildFunctionInfo`'s own style), not a
 * per-character brace matcher — a multi-line `if` condition whose `{` lands
 * on a later line than `extractIfCondition`'s reported `endLine` is a known,
 * disclosed limitation (real count-gates in this tree are one-line
 * conditions; see the module header).
 */
function findIfCountGateBlockLines(lines) {
  const { detect, braces } = scanCode(lines);
  const gated = new Array(lines.length).fill(false);
  const stack = []; // { openDepth } for open if-blocks whose condition is a count-gate
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const detectCode = detect[i];
    const braceCode = braces[i];

    let isCountGateIfHeader = false;
    if (detectCode.trim()) {
      const ifMatch = IF_OPEN_RE.exec(detectCode);
      if (ifMatch) {
        const startCol = ifMatch.index + ifMatch[0].length;
        const condition = extractIfCondition(detect, i, startCol);
        if (condition && COUNT_GATE_RE.test(condition.text)) isCountGateIfHeader = true;
      }
    }

    const opens = (braceCode.match(/\{/g) || []).length;
    const closes = (braceCode.match(/\}/g) || []).length;
    depth += opens - closes;

    // A line is "inside" a count-gate if-block when either a PRIOR line
    // already opened one and it has not yet closed, or THIS line's own `if`
    // header both matches the gate and opens its body on the same line
    // (`if (planCount > 0) { … }` — the exact shape in the finding).
    gated[i] = stack.length > 0 || (isCountGateIfHeader && opens > closes);

    if (isCountGateIfHeader && opens > closes) stack.push({ openDepth: depth });

    while (stack.length > 0 && depth < stack[stack.length - 1].openDepth) stack.pop();
  }
  return gated;
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
  const ifCountGateBlockLines = findIfCountGateBlockLines(lines);

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
    // #3186 review finding 4(a): "gated" is EITHER a same-line ternary `?`
    // before the call, OR the call sitting inside the BODY of an `if (...)`
    // block whose own condition is a count-gate (`findIfCountGateBlockLines`)
    // — the latter catches the block form (`if (planCount > 0) { …
    // readVerificationStatus(…) … }`), which the ternary-only regex produced
    // zero hits on.
    const ternaryGated = GATED_VERIFICATION_READ_RE.test(detectCode);
    const blockGated = ifCountGateBlockLines[i];
    if (!ternaryGated && !blockGated) continue;
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

// §7.4/#3186 review finding 4(b): the literal `>=`/`<=` regexes above missed
// the algebraic restatement `summaryCount - planCount >= 0` (and its mirror,
// `planCount - summaryCount <= 0`) — same comparison, no literal `>=`/`<=`
// between the two count identifiers. Widened to cover exactly these two
// zero-compared-difference shapes; each is a single bounded alternative, no
// nested/overlapping quantifiers.
//
// KNOWN, DISCLOSED LIMIT (not claimed covered): arbitrary further algebraic
// restatements — `!(planCount > summaryCount)`, a difference stored in an
// intermediate variable before the comparison, `Math.max(0, planCount -
// summaryCount) === 0`, etc. — are NOT reliably detectable by a bounded,
// non-backtracking regex and are not attempted here. This is a genuine gap,
// not swept under "et cetera": the header above disclosed it as such rather
// than claiming a wider net than the regexes actually cast.
const SUMMARY_MINUS_PLAN_GE_ZERO_RE = /\bsummar\w*count\w*\s*-\s*\w*plan\w*count\w*\s*>=\s*0\b/i;
const PLAN_MINUS_SUMMARY_LE_ZERO_RE = /\bplan\w*count\w*\s*-\s*\w*summar\w*count\w*\s*<=\s*0\b/i;

function findLocalCompletionCountDerivationDrift(text, relPath, exemptFunctions) {
  const out = [];
  const lines = text.split('\n');
  const { innermostAt, detect } = buildFunctionInfo(lines);
  for (let i = 0; i < lines.length; i++) {
    const detectCode = detect[i];
    if (!detectCode.trim()) continue;
    if (
      !SUMMARY_GE_PLAN_RE.test(detectCode)
      && !PLAN_LE_SUMMARY_RE.test(detectCode)
      && !SUMMARY_MINUS_PLAN_GE_ZERO_RE.test(detectCode)
      && !PLAN_MINUS_SUMMARY_LE_ZERO_RE.test(detectCode)
    ) continue;
    const fn = innermostAt[i];
    if (fn && exemptFunctions && exemptFunctions.has(fn)) continue;
    out.push({ line: i + 1, found: lines[i].trim().slice(0, MAX_REGEX_LITERAL_LEN), shape: 'c', fn: fn || null });
  }
  return out;
}

// ─── SHAPE (d): scanPhasePlans(...).completed READ AS A COMPLETION VERDICT ─
//
// See the module header's shape (d) entry for the full rationale and the
// three textual forms detected below. `FUNCTION_SCOPED_EXEMPTIONS` is
// SHARED with shapes (a)/(b)/(c) — the same per-file, per-function map, so a
// function already exempted for one shape (e.g. `scanPhasePlans` itself,
// which legitimately builds the `completed` field it returns) is exempted
// for shape (d) too, and a function newly exempted for shape (d) must carry
// its own written reason in that map's comment exactly like the others.
const SCAN_CALL_TOKEN = 'scanPhasePlans(';
const DOT_COMPLETED_RE = /^\.completed\b/;
const SCAN_ASSIGN_VAR_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*scanPhasePlans\(/;
// Bounded: `[^{}]*` is a single, non-nested, non-overlapping quantifier — no
// backtracking blow-up regardless of destructure-pattern length. Real
// destructuring assignments in this tree are single-line (the same
// assumption `SCAN_ASSIGN_VAR_RE` and every sibling shape's regexes make).
const DESTRUCTURE_ASSIGN_RE = /\{([^{}]*)\}\s*=\s*scanPhasePlans\(/;
const COMPLETED_KEY_RE = /\bcompleted\b/;

function isWordChar(ch) {
  return !!ch && /[A-Za-z0-9_$]/.test(ch);
}

// Plain paren-depth counter over a SINGLE line (not a regex — nothing for a
// backtracking engine to explore), so a nested-paren call argument (e.g.
// `scanPhasePlans(path.join(phasesDir, dir))`, the majority real shape in
// this tree) still resolves to the call's own true closing `)`. Confined to
// one line: every real `scanPhasePlans(` call site in this tree closes on
// the line it opens on (the same assumption the rest of this file's
// detectors make about this specific call).
function findCallEndOnLine(line, afterOpenParenIdx) {
  let depth = 1;
  for (let i = afterOpenParenIdx; i < line.length; i++) {
    const ch = line[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function findScanPhasePlansCompletedReadDrift(text, relPath, exemptFunctions) {
  const out = [];
  const lines = text.split('\n');
  const { innermostAt, detect } = buildFunctionInfo(lines);
  const isExemptAt = (i) => {
    const fn = innermostAt[i];
    return !!(fn && exemptFunctions && exemptFunctions.has(fn));
  };

  // fnKey: the innermost function name at the ASSIGNMENT site, or this
  // sentinel for module-scope assignments (never collides with a real
  // identifier — function names cannot start with U+0000).
  const FN_KEY_MODULE = ' module';
  const varsByFn = new Map(); // fnKey -> Set<varName> bound directly (non-destructured) to a scanPhasePlans( result

  for (let i = 0; i < lines.length; i++) {
    const detectCode = detect[i];
    if (!detectCode.trim()) continue;

    // Direct chained form: scanPhasePlans(...).completed — every occurrence
    // on the line, paren-matched (not a naive `[^)]*`, which would stop at
    // the FIRST `)`, i.e. the inner `path.join(...)`'s own closing paren).
    let searchFrom = 0;
    for (;;) {
      const idx = detectCode.indexOf(SCAN_CALL_TOKEN, searchFrom);
      if (idx === -1) break;
      if (isWordChar(detectCode[idx - 1])) {
        searchFrom = idx + 1;
        continue;
      }
      const callEnd = findCallEndOnLine(detectCode, idx + SCAN_CALL_TOKEN.length);
      if (callEnd === -1) {
        searchFrom = idx + 1;
        continue;
      }
      if (DOT_COMPLETED_RE.test(detectCode.slice(callEnd)) && !isExemptAt(i)) {
        out.push({ line: i + 1, found: lines[i].trim().slice(0, MAX_REGEX_LITERAL_LEN), shape: 'd', fn: innermostAt[i] || null });
      }
      searchFrom = callEnd;
    }

    // Destructured form: const { completed[, ...] } = scanPhasePlans(...)
    // (bare key or a `completed: alias` rename).
    const destructureMatch = DESTRUCTURE_ASSIGN_RE.exec(detectCode);
    if (destructureMatch && COMPLETED_KEY_RE.test(destructureMatch[1]) && !isExemptAt(i)) {
      out.push({ line: i + 1, found: lines[i].trim().slice(0, MAX_REGEX_LITERAL_LEN), shape: 'd', fn: innermostAt[i] || null });
    }

    // Indirect form, pass 1: const NAME = scanPhasePlans(...) — record the
    // binding; the read (possibly on a LATER line) is matched in pass 2
    // below, function-scoped with no line window.
    const assignMatch = SCAN_ASSIGN_VAR_RE.exec(detectCode);
    if (assignMatch) {
      const fnKey = innermostAt[i] || FN_KEY_MODULE;
      if (!varsByFn.has(fnKey)) varsByFn.set(fnKey, new Set());
      varsByFn.get(fnKey).add(assignMatch[1]);
    }
  }

  // Indirect form, pass 2: NAME.completed anywhere in the SAME function that
  // bound NAME to a scanPhasePlans( result — Decision 4(a)'s Goodhart
  // lesson again: no bounded distance between the binding and the read.
  for (const [fnKey, varNames] of varsByFn) {
    if (fnKey !== FN_KEY_MODULE && exemptFunctions && exemptFunctions.has(fnKey)) continue;
    for (const varName of varNames) {
      const escaped = escapeRegex(varName);
      const readRe = new RegExp(`\\b${escaped}\\.completed\\b`);
      for (let i = 0; i < lines.length; i++) {
        const fnHere = innermostAt[i] || FN_KEY_MODULE;
        if (fnHere !== fnKey) continue;
        if (!detect[i].trim()) continue;
        if (readRe.test(detect[i])) {
          out.push({
            line: i + 1,
            found: lines[i].trim().slice(0, MAX_REGEX_LITERAL_LEN),
            shape: 'd',
            fn: fnKey === FN_KEY_MODULE ? null : fnKey,
          });
        }
      }
    }
  }

  return out;
}

function findCompletionPredicateDrift(text, relPath) {
  const exemptFunctions = FUNCTION_SCOPED_EXEMPTIONS.get(relPath) || null;
  return [
    ...findChecklistOverrideDrift(text, relPath, exemptFunctions),
    ...findGatedVerificationReadDrift(text, relPath, exemptFunctions),
    ...findLocalCompletionCountDerivationDrift(text, relPath, exemptFunctions),
    ...findScanPhasePlansCompletedReadDrift(text, relPath, exemptFunctions),
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

// #3186 review finding 7(b): `relPath` is unused here — this detector has no
// per-file exemption map the way `findCompletionPredicateDrift` does (the
// prompt layer has no FUNCTION_SCOPED_EXEMPTIONS equivalent). Kept in the
// signature (underscore-prefixed) for parity with its sibling `find*Drift`
// detectors' `(text, relPath, …)` shape and with `scanRepo`'s uniform
// `finder(text, rel)` call, rather than diverging the call convention.
function findPromptCompletionDrift(text, _relPath) {
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
//
// SHAPE (d) reuses this exact map (`findScanPhasePlansCompletedReadDrift`
// takes the same `exemptFunctions` set every other shape's finder does). The
// four entries above were entered for shapes (a)/(b)/(c); of them, only
// `scanPhasePlans` (src/plan-scan.cts) also legitimately reads its OWN
// `completed` field for shape (d)'s purposes (building the return value it
// itself defines — not a call-then-read of another `scanPhasePlans(`
// invocation). `isPhaseComplete`, `buildWorkstreamInventory`, and
// `buildPhaseCompletionProjection` do not read `.completed` off a
// `scanPhasePlans(` call result at all (verified by direct inspection of
// each function's body as of this guard's shape-(d) addition — they consume
// `planCount`/`summaryCount`/`summaryFiles`, never `.completed`), so their
// presence in this map exempts nothing NEW for shape (d); they are listed
// here only because the map is shared. As of this addition, a whole-repo
// scan found ZERO live shape-(d) sites needing a fresh exemption entry — the
// one real instance this shape exists to catch (`cmdStateSync`,
// src/state.cts) was fixed by routing through `isPhaseComplete` rather than
// being exempted, which is the outcome ADR-3180 §7.4 requires. If a future
// change legitimately needs a NEW shape-(d) exemption, add it here with its
// own written reason — do not silently extend an existing entry's Set.
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
  findScanPhasePlansCompletedReadDrift,
  findPromptCompletionDrift,
  buildFunctionInfo,
  findIfCountGateBlockLines,
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
  SUMMARY_MINUS_PLAN_GE_ZERO_RE,
  PLAN_MINUS_SUMMARY_LE_ZERO_RE,
  SCAN_CALL_TOKEN,
  DOT_COMPLETED_RE,
  SCAN_ASSIGN_VAR_RE,
  DESTRUCTURE_ASSIGN_RE,
  COMPLETED_KEY_RE,
  findCallEndOnLine,
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

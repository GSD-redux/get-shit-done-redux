// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { cleanup } = require('./helpers.cjs');

// #2994 fragmentization moved the automated_ui_verification step out of
// verify-work.md into gsd-core/workflows/verify-work/steps/automated-ui-verification.md
// behind a section marker (`state:ui-phase-active`). The host no longer
// contains any "playwright" mention at all — reading the host alone now
// only passes these two assertions via unrelated substring coincidences
// ("automated"/"UI" from the section-marker id and an unrelated "User-facing
// changes - UI" bullet; "fall back" from an unrelated subagent-dispatch
// line), which is vacuous. Read the step file directly — it is the sole
// remaining source of the real Playwright content.
const AUTOMATED_UI_VERIFICATION_STEP_PATH = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'verify-work', 'steps', 'automated-ui-verification.md'
);

describe('Playwright-MCP UI verification integration', () => {
  test('verify-work.md mentions automated UI verification', () => {
    const content = fs.readFileSync(AUTOMATED_UI_VERIFICATION_STEP_PATH, 'utf-8');
    assert.ok(
      content.toLowerCase().includes('playwright') || content.includes('automated') && content.includes('UI'),
      'verify-work.md (or its extracted verify-work/steps/automated-ui-verification.md) should mention automated UI verification option'
    );
  });

  test('ui-review.md mentions Playwright-MCP when available', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'ui-review.md'), 'utf-8'
    );
    assert.ok(
      content.toLowerCase().includes('playwright') || content.includes('mcp__playwright'),
      'ui-review.md should reference Playwright-MCP'
    );
  });

  test('gsd-ui-auditor.md includes automated screenshot guidance', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'agents', 'gsd-ui-auditor.md'), 'utf-8'
    );
    assert.ok(
      content.toLowerCase().includes('playwright') || content.includes('screenshot') || content.includes('automated'),
      'gsd-ui-auditor.md should mention automated screenshot verification'
    );
  });

  test('automated verification is optional/conditional (falls back to manual)', () => {
    const verifyContent = fs.readFileSync(AUTOMATED_UI_VERIFICATION_STEP_PATH, 'utf-8');
    // Must include a fallback / "if available" conditional
    const hasConditional =
      verifyContent.includes('if available') ||
      verifyContent.includes('when available') ||
      verifyContent.includes('if Playwright') ||
      verifyContent.includes('fall back');
    assert.ok(hasConditional, 'Playwright integration must be conditional with manual fallback');
  });
});

// #4176: the auditor's sole screenshot path had three defects — a 200-only
// probe that misread a redirecting dev server as absent, an unconditional
// "Screenshots captured" echo that survived total capture failure, and a
// documented 3000 -> 5173 -> 8080 fallback the control flow never attempted.
// These assert against the <screenshot_approach> BASH BLOCK specifically, not
// the whole file: the pre-fix bug was precisely that the fallback existed as
// a guidance sentence while the code hard-coded one port, so a whole-file
// grep for "5173" passed on the broken version.
const AUDITOR_PATH = path.join(__dirname, '..', 'agents', 'gsd-ui-auditor.md');

// Line-based rather than a fence regex: an unbounded [\s\S]*? over readFileSync
// content is a backtracking risk (local/no-unbounded-quantifier), a triple-fence
// body regex is ad-hoc markdown parsing (local/no-adhoc-markdown-parsing), and a
// bare \n split is CRLF-fragile on Windows checkouts (local/no-crlf-fragile-split).
// splitLines() handles the line endings; the scan below handles the fence.
function screenshotApproachLines() {
  const lines = splitLines(fs.readFileSync(AUDITOR_PATH, 'utf-8'));
  const FENCE = '`'.repeat(3);
  const OPENER = FENCE + 'bash';
  const body = [];
  let inSection = false;
  let inFence = false;
  for (const line of lines) {
    if (!inSection) {
      if (line.includes('<screenshot_approach>')) inSection = true;
      continue;
    }
    if (line.includes('</screenshot_approach>')) break;
    if (!inFence) {
      if (line.trim() === OPENER) inFence = true;
      continue;
    }
    if (line.trim() === FENCE) break;
    body.push(line);
  }
  assert.ok(body.length > 0, '<screenshot_approach> must contain a non-empty bash fence');
  return body;
}

function screenshotApproachBlock() {
  return screenshotApproachLines().join('\n');
}

// Join backslash continuations, so a capture invocation or an `if ... ; then` spread
// over four physical lines is ONE logical line. Without this, a structural read of the
// block sees `if npx playwright screenshot "$DEV_URL" \` — a header with no `then` —
// and silently declines to open a scope.
function logicalLines(lines) {
  const joined = [];
  let buf = null;
  for (const raw of lines) {
    const piece = buf === null ? raw : `${buf} ${raw.trim()}`;
    const trimmedEnd = piece.replace(/[\t ]+$/, '');
    if (trimmedEnd.endsWith('\\')) {
      buf = trimmedEnd.slice(0, -1).replace(/[\t ]+$/, '');
      continue;
    }
    buf = null;
    joined.push(piece);
  }
  if (buf !== null) joined.push(buf);
  return joined;
}

// Every logical line paired with the shell conditions actually GOVERNING it — the
// `if`/`elif`/`else` conditions of the enclosing scopes, innermost last. Loops and
// `case` open a scope with no condition of their own, so a line inside one is still
// correctly reported as ungoverned unless an `if` encloses it too.
//
// This is what a "the echo is gated" assertion has to read. Asking instead whether some
// token appears EARLIER IN THE BLOCK TEXT than the echo answers a different question
// entirely, and `CAPTURED=0` near the top of the block makes that question true forever:
// moving the success echo back outside its `if [ "$CAPTURED" -eq 3 ]` branch — which is
// precisely the #4176 bug — would not disturb it.
//
// IT FAILS CLOSED, and that is the whole difference between this and its first version.
// A hand-written reader of a language it does not lex WILL meet a form it does not know;
// what decides whether that is a defect is which way it errs. The first version erred
// SILENTLY: an unrecognised line was pushed as an ordinary row, so a construct that
// should have popped the scope stack left a stale condition on it, and the next line
// inherited a guard that does not govern it — a FALSE PASS on exactly the regression
// this test names. Three were driven against it:
//   `fi # end capture-count branch`   -> `fi` not matched, stack never popped
//   `if [ "$CAPTURED" -eq 3 ]` + a bare `then` on the NEXT line (legal bash)
//   `if ...; then ...; fi; echo ...`  all on one logical line
// So: comments are stripped before the walk (which is what the first form needed), the
// two-line `then` form is recognised, and ANY residual line still carrying a bare
// control keyword this walker did not consume THROWS. A test that cannot parse the
// block fails loudly; it never reports on a stack it has lost track of.
// Does this text carry a shell control keyword the walker did not consume?
//
// QUOTED TEXT IS REMOVED FIRST — `echo "we do work"` threw on the `do` inside a string,
// and a guard that false-fires is a guard that gets deleted. The boundary set includes
// the redirection and grouping characters, because `fi>/dev/null` was accepted (and so
// silently failed to pop the scope stack) purely for want of `>` in it. `else` is in the
// keyword list for the same reason: `else echo unparsed` reached neither the bare-`else`
// branch nor this check. All three driven.
function hasControlKeyword(text) {
  return /(^|[\t ;&|(){}<>])(if|then|else|elif|fi|do|done|case|esac)([\t ;&|(){}<>]|$)/.test(blankQuoted(text));
}

// Replace the CONTENTS of quoted spans with spaces, walking the line once.
//
// Two independent regexes (`/'[^']*'/` then `/"..."/`) is not the same thing, and the
// difference is a false PASS: an apostrophe inside a double-quoted string — legal, and
// `test "'" = x` is the driven case — pairs with the next apostrophe several tokens
// away, and the single-quote pass then erases the real `then`, `fi` and `if` between
// them. The guard saw no control keyword and the walker kept a stale CAPTURED guard on a
// hoisted success echo. Whichever regex runs first, the other one is wrong.
function blankQuoted(text) {
  let out = '';
  let quote = null;
  let ansi = false;        // inside $'...', where a backslash escapes the closing quote
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      // ANSI-C quoting processes backslash escapes, so `$'x\''` is ONE string whose
      // content is `x'`. Treating that escaped quote as the terminator ended the span
      // early, and the real `then`/`fi`/`if` after it were then blanked by the NEXT
      // apparent quote — a stale guard with no throw. Driven, and the same asymmetry
      // stripComment already models.
      if (c === '\\' && (quote === '"' || ansi)) { out += '  '; i += 1; continue; }
      if (c === quote) { quote = null; ansi = false; out += ' '; continue; }
      out += ' ';
      continue;
    }
    if (c === '$' && text[i + 1] === "'") { quote = "'"; ansi = true; out += '  '; i += 1; continue; }
    if (c === '\\') { out += '  '; i += 1; continue; }
    if (c === "'" || c === '"') { quote = c; out += ' '; continue; }
    out += c;
  }
  return out;
}

function guardedLines(lines) {
  const stack = [];
  const rows = [];
  let pendingIf = null;   // an `if <cond>` whose `then` is on a later line
  for (const raw of logicalLines(lines.map(stripComment))) {
    const t = raw.trim();
    if (t === '') continue;
    if (pendingIf !== null) {
      // Only `then` may follow; anything else means we mis-read the `if` header.
      if (t === 'then' || t.startsWith('then ')) {
        const tail = t === 'then' ? '' : t.slice(5).trim();
        // The compound check belongs on EVERY path that opens a scope, not just the
        // one-line `if`. `if COND` + `then :; fi; if true; then` reached this branch and
        // pushed a condition whose tail closed the scope and opened another — bash
        // printed the success line with CAPTURED=0 while the walker reported the echo
        // as governed. Driven.
        if (hasControlKeyword(tail)) {
          throw new Error(`bash reader: compound then-clause — ${JSON.stringify(t)}`);
        }
        stack.push(pendingIf);
        pendingIf = null;
        if (tail === '') continue;
        rows.push({ line: tail, guards: stack.slice() });
        continue;
      }
      throw new Error(`bash reader: '${pendingIf}' opened an if with no 'then' — got ${JSON.stringify(t)}`);
    }
    const ifMatch = /^if[\t ]+(.{1,4000}?)[\t ]*;[\t ]*then$/.exec(t);
    if (ifMatch) {
      // The lazy quantifier still spans `;`, so `if A; then :; fi; if true; then` matched
      // as ONE header whose "condition" swallowed a complete if/fi and a second `if` —
      // and the echo that followed inherited a guard mentioning CAPTURED that governed
      // nothing. Driven: bash printed the success line with CAPTURED=0 while the
      // structural assertion passed. A condition is not allowed to contain control
      // keywords; if it does, this is a compound line the walker cannot model.
      if (hasControlKeyword(ifMatch[1])) {
        throw new Error(`bash reader: compound if header — ${JSON.stringify(t)}`);
      }
      stack.push(ifMatch[1]);
      continue;
    }
    const ifPending = /^if[\t ]+(.{1,4000}?)[\t ]*$/.exec(t);
    if (ifPending && !/;/.test(ifPending[1])) { pendingIf = ifPending[1]; continue; }
    const elifMatch = /^elif[\t ]+(.{1,4000}?)[\t ]*;[\t ]*then$/.exec(t);
    if (elifMatch) {
      // Same omission as the `if` header carried, and the same false PASS: the lazy
      // quantifier swallowed `:; fi; if true` into the stored condition.
      if (hasControlKeyword(elifMatch[1])) {
        throw new Error(`bash reader: compound elif header — ${JSON.stringify(t)}`);
      }
      if (stack.length) stack[stack.length - 1] = elifMatch[1];
      continue;
    }
    if (t === 'else') { if (stack.length) stack[stack.length - 1] = `!(${stack[stack.length - 1]})`; continue; }
    if (t === 'fi') { stack.pop(); continue; }
    if (/^(for|while|until)\b/.test(t) && /;[\t ]*do$/.test(t)) { stack.push(''); continue; }
    if (t === 'do') { stack.push(''); continue; }
    if (t === 'done') { stack.pop(); continue; }
    if (/^case\b/.test(t) && /\bin$/.test(t)) { stack.push(''); continue; }
    if (t === 'esac') { stack.pop(); continue; }
    // FAIL CLOSED. A control keyword this walker did not consume above means the block
    // uses a form it cannot model, and continuing would report guards it no longer knows.
    // Word-boundary matched so `elif`/`fi` inside a string or an identifier does not fire;
    // an over-fire here costs a loud test failure, an under-fire costs a false clean.
    if (hasControlKeyword(t)) {
      throw new Error(`bash reader: unparsed control construct — ${JSON.stringify(t)}`);
    }
    rows.push({ line: t, guards: stack.slice() });
  }
  if (pendingIf !== null) throw new Error(`bash reader: dangling if — ${JSON.stringify(pendingIf)}`);
  if (stack.length !== 0) throw new Error(`bash reader: ${stack.length} unclosed scope(s) at end of block`);
  return rows;
}

// Strip a trailing `#` comment, QUOTE-AWARE.
//
// The first version was a single regex, `line.replace(/\s+#.*$/, '')`, and it carried a
// comment admitting it was quote-blind. That admission was driven into a false PASS: a
// line such as
//     --user-agent="$DEV_URL # " \
// has its quoted `#` read as a comment start, taking the real continuation backslash with
// it, so the NEXT physical line — which in the constructed case carried a hard-coded
// `http://localhost:3000` — vanished from the selection entirely and the ban that exists
// to catch exactly that passed on an invocation that no longer included it. Documenting a
// hole is not closing one.
//
// So this walks the line and tracks quoting. It is not a bash lexer and does not claim to
// be: it knows single quotes (literal, no escapes inside), double quotes (backslash
// escapes), and a backslash escape outside quotes. That is the quoting the block actually
// uses, and it is what the false PASS above needed. A `#` starts a comment only when it is
// outside quotes AND at the start of a word — `foo#bar` is one word to bash, not a comment.
function stripComment(line) {
  // A STACK, not a single quote flag. Three constructs defeated the flat scanner, all
  // driven: `$'x\' # quoted'` (ANSI-C quoting, where a backslash-escaped quote is NOT the
  // terminator the flat scanner took it for), `"$(printf "%s" " # ")"` (a command
  // substitution restarts quoting inside an already-open double quote), and their
  // combinations. A `#` opens a comment only with the stack EMPTY and at a word start.
  const stack = [];
  const top = () => stack[stack.length - 1];
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    const ctx = top();
    if (ctx === 'sq') { out += c; if (c === "'") stack.pop(); continue; }
    if (ctx === 'ansi') {                       // $'...' — backslash escapes ARE processed
      if (c === '\\' && i + 1 < line.length) { out += c + line[i + 1]; i += 1; continue; }
      out += c; if (c === "'") stack.pop(); continue;
    }
    if (c === '\\' && i + 1 < line.length) { out += c + line[i + 1]; i += 1; continue; }
    if (c === '$' && line[i + 1] === "'") { out += c + line[i + 1]; i += 1; stack.push('ansi'); continue; }
    if (c === '$' && line[i + 1] === '(') { out += c + line[i + 1]; i += 1; stack.push('cmd'); continue; }
    // Nested parens inside `$( )`. A raw subshell — `$( (printf x); printf "%s" " # " )`
    // — closed the outer context at the INNER `)`, after which every quote was
    // misclassified and the trailing continuation was truncated away. Driven. Depth is
    // tracked on the stack itself: a bare `(` inside cmd pushes, its `)` pops.
    if (c === '(' && ctx === 'cmd') { out += c; stack.push('cmd'); continue; }
    if (c === ')' && ctx === 'cmd') { out += c; stack.pop(); continue; }
    // `${var#pattern}` — the `#` there is a removal operator, not a comment, and the
    // scanner truncated `echo ${value# #}` mid-expansion. Driven.
    if (c === '$' && line[i + 1] === '{') { out += c + line[i + 1]; i += 1; stack.push('param'); continue; }
    if (c === '}' && ctx === 'param') { out += c; stack.pop(); continue; }
    // Backticks are command substitution too, and they reopened the hidden-continuation
    // bypass the `$( )` handling had closed: `--user-agent="$DEV_URL""`printf "%s" " # "`"`
    // truncated the line and hid the continuation carrying a hard-coded port. Driven.
    if (c === '`' && ctx === 'btick') { out += c; stack.pop(); continue; }
    if (c === '`') { out += c; stack.push('btick'); continue; }
    if (c === '"' && ctx === 'dq') { out += c; stack.pop(); continue; }
    if (c === '"') { out += c; stack.push('dq'); continue; }
    if (c === "'" && ctx !== 'dq') { out += c; stack.push('sq'); continue; }
    if (c === '#' && stack.length === 0 && (i === 0 || /[\t ]/.test(line[i - 1]))) {
      // A `\` the removed text was hiding did NOT continue the line in bash, so this
      // reader must not treat it as one. Driven: `echo one \ # x` followed by
      // `--timeout=30000` runs the second line as its OWN command — bash never joins
      // them, and keeping the backslash would make logicalLines() join what bash does not.
      return out.replace(/[\t ]+$/, '').replace(/\\+$/, '');
    }
    out += c;
  }
  return out;
}


// The patterns of a `case` arm, or null when the line is not one.
//
// `line.split(')')[0].split('|')` was the first version and it is wrong on legal bash in
// two ways, both driven. A leading `(` — `(401|403|407|511)` is valid — yields
// `["(401","403",...]`, so `401` reads as MISSING and the assertion false-FAILS. And a `)`
// inside an earlier pattern truncates the label. Strip an optional leading `(`, then take
// up to the FIRST unquoted `)`; a quoted one is part of a pattern, not the terminator.
function caseLabelOf(line) {
  const t = line.trim().replace(/^\(/, '');
  // Walk once, tracking quotes, splitting on `|` only OUTSIDE them, and recording
  // activity PER CHARACTER rather than per pattern.
  //
  // One boolean per pattern cannot express either direction, and both were driven:
  // `2\?\?` escapes the wildcards so bash matches them literally — an exact-match arm
  // that read as a range (false PASS) — while `"2"??` quotes only the digit and IS a
  // range, which a whole-pattern flag called quoted (false FAIL). What decides whether a
  // `?` is a wildcard is whether THAT `?` was quoted or escaped, so that is what is kept.
  const patterns = [];
  let cur = '';
  let active = [];        // per character: is this an ACTIVE (unquoted, unescaped) glob metachar
  let quote = null;
  let end = -1;
  const push = (c, isActive) => { cur += c; active.push(isActive); };
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (quote) {
      if (c === '\\' && quote === '"') { push(t[i + 1] ?? '', false); i += 1; continue; }
      if (c === quote) { quote = null; continue; }
      push(c, false);
      continue;
    }
    if (c === '\\') { push(t[i + 1] ?? '', false); i += 1; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '|') { patterns.push({ text: cur.trim(), active }); cur = ''; active = []; continue; }
    if (c === ')') { end = i; break; }
    push(c, true);
  }
  if (end < 0) return null;
  patterns.push({ text: cur.trim(), active });
  // Whitespace only disqualifies an UNQUOTED pattern: `"x y"` is one legal pattern, and
  // rejecting the whole label for it false-FAILED an otherwise-valid arm. Driven.
  if (patterns.length === 0
      || patterns.some((x) => x.text === ''
        || x.text.split('').some((ch, k) => /[\t ]/.test(ch) && x.active[k]))) return null;
  return patterns;
}


// A pattern that actually matches a RANGE of 2xx statuses. A quoted `"2??"` matches the
// three literal characters `2??` and no status at all, so its wildcards do not count.
function isTwoXxRange(pattern) {
  const { text, active } = pattern;
  if (!/^2(\?\?|\[0-9\]\[0-9\]|\*)$/.test(text)) return false;
  // Every metacharacter in the matched shape must be ACTIVE. `2\?\?` has the right text
  // and no active wildcards, so it matches exactly the three characters `2??`.
  return text.split('').every((ch, k) => !/[?*[\]]/.test(ch) || active[k]);
}

function captureInvocations(lines) {
  return logicalLines(lines.map(stripComment).filter((l) => !/^[\t ]*#/.test(l) && l.trim() !== ''))
    .map((l) => l.trim())
    .filter((l) => l.includes('playwright screenshot'));
}

describe('#4176 — gsd-ui-auditor screenshot capture is honest', () => {
  // CODE, not prose. Every assertion below reads the comment-stripped block: the block
  // documents its own flags in comments, and a regression that deletes `redirect:"follow"`
  // while leaving the phrase in the paragraph above it would otherwise still pass. That is
  // the same substring defect the review's finding 1 names, and it was DRIVEN against the
  // previous version of this test with `{/* redirect:"follow" */ signal: ...}`.
  // stripComment knows BASH comments. The probe's argument is a JavaScript program
  // embedded in that bash, and a `/* redirect:"follow" */` left behind after the real key
  // was deleted satisfied every regex below — driven, 15/15 green on a probe that had
  // reverted to fetch's inherited default. Strip JS comments too. This is a belt: the
  // authoritative check on the probe's redirect behaviour is the executed one further
  // down, which runs the extracted program against a real redirecting server.
  const stripJsComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const codeBlock = () => stripJsComments(screenshotApproachLines().map(stripComment).join('\n'));

  test('dev-server probe follows redirects and is time-bounded', () => {
    const block = codeBlock();
    const usesCurlL = /curl[\t ]+(-[A-Za-z]{0,10}L|--location)\b/.test(block);
    const usesFetch = /\bfetch\(/.test(block);
    assert.ok(usesCurlL || usesFetch, 'probe must issue its request via curl or fetch()');
    // Redirect-FOLLOWING is the property, and the bare presence of `fetch(` cannot
    // express it: fetch's own default is already redirect:"follow", so a regression to
    // redirect:"manual" — which reinstates the 307-read-as-absent bug #4176 is about —
    // satisfies a `block.includes('fetch(')` check exactly as well as the fix does.
    // Ban the non-following forms, and require the contract to be stated rather than
    // inherited from a default a future runtime is free to change.
    assert.ok(
      !/redirect[\t ]*:[\t ]*["'](manual|error)["']/.test(block),
      'probe must not disable redirect following — a redirecting dev server is not an absent one'
    );
    assert.ok(
      usesCurlL || /redirect[\t ]*:[\t ]*["']follow["']/.test(block),
      'a fetch()-based probe must state redirect:"follow" explicitly, so the redirect contract is pinned rather than inherited'
    );
    const timeBounded = /--max-time|AbortSignal\.timeout|run-with-timeout|--connect-timeout/.test(block);
    assert.ok(timeBounded, 'probe must be time-bounded — an accepting-but-unresponsive port must not hang the audit');
  });

  test('probe accepts any 2xx rather than exact-matching 200', () => {
    const block = codeBlock();
    assert.ok(
      !/=[\s]*"200"/.test(block),
      'probe must not exact-match "200" — that misreads redirects and other 2xx as no-server'
    );
    // Banning one literal idiom is not the same as requiring a range. `case "$PROBE" in
    // 200) ... ;; esac` carries no `=` at all, so it reintroduces the same
    // 2xx-but-not-200 misread while passing the ban above. Assert positively that a 2xx
    // RANGE is what the probe accepts.
    // READ THE ARM THAT GOVERNS `DEV_URL=`, not the block. A block-wide search for a
    // range idiom is satisfied by a range test that decides nothing — driven against the
    // previous version of this test with
    //     200) [ "$PROBE" -ge 200 ] && DEV_URL=...; break ;;
    // which admits ONLY 200 at the case label, carries no `=` for the ban above to catch,
    // and offers the `-ge 200` the range check was looking for. 15/15 passed on a block
    // that had reinstated the exact-match bug.
    const acceptArm = logicalLines(screenshotApproachLines().map(stripComment))
      .map((l) => l.trim())
      .find((l) => /DEV_URL=/.test(l) && !/^DEV_URL=""$/.test(l));
    assert.ok(acceptArm, 'expected an arm that resolves DEV_URL from the probe status');
    const armLabel = caseLabelOf(acceptArm);
    // WHERE the range lives has to match where the DECISION is made. When a `case` label
    // gates the arm, that label IS the acceptance test and a range check inside the arm
    // body is vacuous — `200) [ "$PROBE" -ge 200 ] && DEV_URL=...` admits only 200 and the
    // `-ge` never rejects anything. So the alternatives are mutually exclusive by
    // construction: a case-gated arm is judged on its LABEL, and only an arm with no case
    // label may earn acceptance from a comparison in its body.
    const acceptsRange = armLabel !== null
      ? armLabel.some(isTwoXxRange)
      : (/-ge[\t ]+200\b/.test(acceptArm) || /\br\.ok\b/.test(block));
    assert.ok(
      acceptsRange,
      armLabel !== null
        ? `the case label that admits a status must be an UNQUOTED 2xx range (2?? / 2[0-9][0-9] / 2*), not an enumerated status and not a quoted literal — a range test inside an exact-match arm decides nothing: label was ${JSON.stringify(armLabel)}`
        : `the arm that sets DEV_URL must accept a 2xx RANGE, not an enumerated status: ${acceptArm}`
    );
  });

  test('capture success is checked, not assumed', () => {
    const block = screenshotApproachBlock();
    // `CAPTURED=` is deliberately NOT an alternative here. It matches the unconditional
    // `CAPTURED=0` initialisation, so a future block that keeps the counter and drops every
    // real outcome check would still satisfy this — the counter's EXISTENCE is not evidence
    // that anything was observed. (It does not weaken the regression this test names: the
    // pre-fix block declared no counter at all, so every alternative below is absent from it
    // and the test fails there either way. Removing it costs nothing and closes the forward
    // hole.) The remaining alternatives each name an actual observation: the captured file is
    // non-empty, or the capture command's own exit status is consumed.
    const checksOutcome = /\[ -s "?\$SCREENSHOT_DIR|\[ -s |if npx |\$\?/.test(block);
    assert.ok(checksOutcome, 'an exit-status or file-existence check must gate the captured/not-captured signal');
  });

  // The structural half of the assertion above. A "captured" claim is a claim about an
  // outcome, so what has to be true is that the branch printing it could only have been
  // reached by observing that outcome — a property of the block's CONTROL FLOW, which a
  // substring-proximity check cannot express and cannot fail on the regression it names.
  test('every capture-success claim is governed by a conditional testing the capture count', () => {
    const rows = guardedLines(screenshotApproachLines());
    const CLAIM = /^echo "Screenshots (captured|PARTIALLY captured)\b/;
    const claims = rows.filter((r) => CLAIM.test(r.line));
    assert.ok(
      claims.length > 0,
      'expected the capture block to echo a success or partial-success claim'
    );
    for (const claim of claims) {
      assert.ok(
        claim.guards.some((cond) => /CAPTURED/.test(cond)),
        'a capture-success claim must sit inside a conditional that tests the capture count; ' +
          `governing conditions for ${JSON.stringify(claim.line)} were ${JSON.stringify(claim.guards)}`
      );
    }
  });

  test('all three documented ports are tried in the control flow', () => {
    // Self-found, same class as finding 1: `block.includes(port)` is satisfied by a port
    // named only in a comment. The pre-fix bug WAS a port documented in prose beside code
    // that hard-coded 3000, so a whole-block substring check cannot distinguish the fix
    // from the bug it replaced — it can only see that the digits exist somewhere. Read
    // the iteration line itself.
    // logicalLines, not guardedLines: a `for ... ; do` line OPENS a scope, so it is
    // consumed by the guard walker and never appears among the governed lines.
    const iteration = logicalLines(screenshotApproachLines())
      .map((l) => l.trim())
      .find((l) => /^for[\t ]+PORT[\t ]+in\b/i.test(l));
    assert.ok(iteration, 'ports must be iterated, not hard-coded to one');
    // And drop any trailing comment before reading it, or the check regresses to the
    // whole-block substring form one line down: `for PORT in 3000; do # 5173, 8080 too`
    // would otherwise satisfy it. (Measured — that mutation passed before this strip.)
    const iterationCode = iteration.split(/[\t ]#/)[0];
    for (const port of ['3000', '5173', '8080']) {
      assert.ok(
        iterationCode.includes(port),
        `port ${port} must be in the port iteration itself, not only in guidance prose: ${iterationCode}`
      );
    }
  });

  test('the auth-gated port is recorded first-wins, matching the documented precedence', () => {
    // The ports carry a documented ORDER, and the reported reason should name the same
    // port that order would have picked. An unguarded assignment inside the loop reports
    // whichever gated port was tried last.
    const assignments = logicalLines(screenshotApproachLines())
      .map((l) => l.trim())
      .filter((l) => /DEV_GATED=/.test(l) && !/^DEV_GATED=""$/.test(l));
    assert.ok(assignments.length > 0, 'expected the port loop to record an auth-gated server');
    for (const line of assignments) {
      // THE OPERATOR IS THE PROPERTY, not the presence of a test. Driven against the
      // previous version: swapping `||` for `&&` leaves DEV_GATED permanently EMPTY —
      // strictly worse than the last-wins bug this guards — and all 15 tests passed,
      // because a `-n` test was still textually present. Accept exactly the two forms
      // that mean "keep the first": `[ -n "$DEV_GATED" ] ||` and `[ -z "$DEV_GATED" ] &&`.
      // The operator must gate THE ASSIGNMENT. `[ -n "$DEV_GATED" ] || :; DEV_GATED=...`
      // satisfies a guard-anywhere-on-the-line regex and still reports the LAST gated
      // port, because the `;` ends the conditional before the assignment runs. Driven.
      assert.ok(
        /\[[\t ]+-n[\t ]+"?\$DEV_GATED"?[\t ]+\][\t ]*\|\|[\t ]*DEV_GATED=/.test(line)
          || /\[[\t ]+-z[\t ]+"?\$DEV_GATED"?[\t ]+\][\t ]*&&[\t ]*DEV_GATED=/.test(line),
        `the auth-gated port must be recorded first-wins — \`[ -n "$DEV_GATED" ] ||\` or \`[ -z "$DEV_GATED" ] &&\`; the operator is what makes it first-wins, not the test: ${line}`
      );
    }
  });

  // Self-found by the round's guard-shape census, not by the review: the case arm above
  // FIXES A SET at author time (the statuses that count as auth-gated) while the domain it
  // rules on — what a local dev server may answer — is owned by the server, so the set can
  // fall behind without this code changing. 407 (proxy authentication required) and 511
  // (network authentication required) each mean the server ANSWERED and demanded
  // credentials; omitting them reports a PRESENT server as an absent one, which is the very
  // defect #4176 names, one status family over.
  // Read the case LABEL that governs the assignment, not the block text: `block.includes('407')`
  // would be satisfied by the comment explaining it — the same substring defect as finding 1.
  test('the whole auth-required status class is recorded as gated, not misreported as absent', () => {
    const gatedArms = logicalLines(screenshotApproachLines())
      .map((l) => l.trim())
      .filter((l) => /DEV_GATED=/.test(l) && !/^DEV_GATED=""$/.test(l));
    assert.ok(gatedArms.length > 0, 'expected a case arm recording an auth-gated server');
    const labels = gatedArms.map((l) => (caseLabelOf(l) || []).map((x) => x.text));
    for (const status of ['401', '403', '407', '511']) {
      assert.ok(
        labels.some((lab) => lab.includes(status)),
        `HTTP ${status} means authentication is required, so a server answering it is PRESENT and gated — not absent: case labels were ${JSON.stringify(labels)}`
      );
    }
  });

  test('the resolved port — not a hard-coded 3000 — is what gets captured', () => {
    const captureLines = captureInvocations(screenshotApproachLines());
    assert.ok(captureLines.length > 0, 'expected at least one capture invocation');
    for (const line of captureLines) {
      // Negative-only was the hole, and it is the SAME defect class the test above names:
      // banning the one literal `localhost:3000` leaves a hard-coded `localhost:5173` or
      // `localhost:8080` passing, while the defect #4176 names is "the capture targets a
      // hard-coded port", not "the capture targets 3000". Ban the shape, then require the
      // resolved variable positively — a ban alone cannot say what the line SHOULD contain.
      assert.ok(
        !/localhost:\d+/.test(line),
        `capture must not hard-code any port: ${line.trim()}`
      );
      assert.ok(
        line.includes('$DEV_URL'),
        `capture must use the resolved URL variable: ${line.trim()}`
      );
    }
  });

  test('capture invocations are time-bounded, as the probe is', () => {
    // `playwright screenshot` forwards --timeout to context.setDefaultTimeout() and
    // defaults it to 0, i.e. NO timeout — so this CLI path drops the bound the
    // Playwright library applies by default. An unbounded capture reinstates the
    // hang the probe's own time bound exists to prevent, one step later.
    // captureInvocations, not a bare filter: the comment four lines above the call site names
    // both `playwright screenshot` and `--timeout`, so a bare filter counted it as an invocation
    // and it satisfied this assertion by quoting the flag rather than passing it.
    const captures = captureInvocations(screenshotApproachLines());
    assert.ok(captures.length > 0, 'expected at least one capture invocation');
    for (const line of captures) {
      // A VALUE, AND A POSITIVE ONE. `--timeout=0` is playwright's own spelling of NO
      // timeout, so a presence check accepts the exact state this assertion exists to
      // forbid — driven against the previous version, which passed 15/15 with every
      // capture at `--timeout=0`.
      // THE LAST occurrence, because a repeated option is last-wins in the real command:
      // `--timeout=30000 --timeout=0` passed a first-match read while passing no timeout
      // at all. (The executed suite reads real argument boundaries and is the stronger
      // check; this one keeps the source-level assertion honest.)
      const found = [...line.matchAll(/--timeout[= ]([0-9]+)\b/g)];
      assert.ok(found.length > 0, `capture must be time-bounded — playwright screenshot defaults to no timeout: ${line}`);
      assert.ok(
        Number(found[found.length - 1][1]) > 0,
        `--timeout=0 IS playwright's no-timeout setting — the effective bound must be positive: ${line}`
      );
    }
  });

  test('a failed viewport removes the file it may have written, by name', () => {
    // rmdir alone cannot honour a "leaves nothing behind" claim: it succeeds only on a
    // genuinely empty directory and its stderr is discarded, so a zero-byte or partial
    // .png from a crashed browser — which `[ -s ]` correctly scores as a failure —
    // would leave BOTH the file and the directory in place, silently.
    //
    // The removal lives in the capture loop's FAILURE arm, not in the all-failed branch,
    // and that placement is the finding: scoped to the all-failed branch it left the
    // PARTIAL case — two good shots and one stray file — still overclaimed by the docs.
    // It is also BY NAME rather than a `*.png` glob. That is the narrower operation and
    // leaves alone anything else in the directory; what keeps a CONCURRENT audit's
    // captures safe is the atomic allocation, not this line.
    const rows = guardedLines(screenshotApproachLines());
    const removals = rows.filter((r) => /^rm -f\b/.test(r.line));
    assert.ok(removals.length > 0, 'expected the capture loop to remove a failed viewport\u2019s stray file');
    for (const row of removals) {
      assert.ok(
        !/\*/.test(row.line),
        `stray-file removal must name the file, never glob the directory: ${row.line}`
      );
      assert.ok(
        /\$SHOT_NAME/.test(row.line),
        `stray-file removal must target the viewport that just failed: ${row.line}`
      );
    }
    // The directory removal is `rm -rf`, not `rmdir`, and the atomic allocation is what
    // licenses that: a directory won by this audit alone can be removed whole. `rmdir`
    // could not honour the docs claim — it fails on any file the capture command wrote
    // under a name this block never asked for, leaving both behind.
    const removesDir = rows.filter((r) => /\brm -rf[\t ]+"?\$SCREENSHOT_DIR"?$/.test(r.line));
    assert.ok(removesDir.length > 0, 'expected the all-failed branch to remove the review directory whole');
    for (const row of removesDir) {
      assert.ok(
        row.guards.some((cond) => /CAPTURED/.test(cond)),
        `directory removal must be confined to the capture-failure branch; governing conditions were ${JSON.stringify(row.guards)}`
      );
    }
  });

  test('report surfaces can express partial capture', () => {
    // Was a whole-FILE substring check — the same defect class as the Major finding and as the
    // port check above, and shipped by this PR rather than inherited. The template prose alone
    // satisfied it, so deleting the block's partial branch outright would not have failed it.
    // Pin both ends positively instead: the block must PRODUCE a partial status, and a report
    // surface outside the block must CONSUME the variable — a status computed and never
    // rendered is not a surface that can express anything.
    const block = screenshotApproachBlock();
    assert.ok(
      /CAPTURE_STATUS=["']?partially captured/i.test(block),
      'the capture block must PRODUCE a partial status — full/none alone cannot describe 2 of 3'
    );
    // Name the consuming surface POSITIVELY rather than subtracting the block from the file.
    // `content.replace(block, '')` was two bugs in one: String#replace with a string argument
    // drops only the FIRST occurrence, and the block is joined with '\n' by splitLines() while
    // readFileSync returns the file's own '\r\n' on a Windows checkout — so the match fails
    // outright, the block stays in the haystack, and the assertion is then satisfied by the
    // block's own text. That is a false clean, and CRLF-fragility is a class this repo lints
    // for (local/no-crlf-fragile-split). Assert on the Screenshots report field itself.
    // HTML comments removed FIRST. Commenting out both real fields and adding a visible
    // hard-coded `Screenshots: captured` line satisfied a scan of the raw source: the
    // commented lines still matched, and the rendered text no longer carried the
    // variable at all. Driven.
    // Bounded quantifier: an unbounded `[\s\S]*?` over readFileSync content is a
    // catastrophic-backtracking risk this repo lints for (local/no-unbounded-quantifier).
    // 20k is far longer than any comment in this file and far short of the file itself.
    const rendered = fs.readFileSync(AUDITOR_PATH, 'utf-8').replace(/<!--[\s\S]{0,20000}?-->/g, '');
    const surfaces = splitLines(rendered)
      .filter((l) => /^\*\*Screenshots:\*\*/.test(l.trim()));
    assert.ok(surfaces.length > 0, 'expected a Screenshots report field in the agent output template');
    // The field's VALUE, not a mention on the line. `**Screenshots:** captured
    // <!-- $CAPTURE_STATUS -->` renders a hard-coded word while satisfying an
    // includes() check — the status is computed, carried, and then dropped at the one
    // place a reader sees it. Driven.
    assert.ok(
      surfaces.every((l) => /^\*\*Screenshots:\*\*[\t ]*\{?[\t ]*\$CAPTURE_STATUS\b/.test(l.trim())),
      `every Screenshots report field must render $CAPTURE_STATUS as its value: ${JSON.stringify(surfaces)}`
    );
  });
});

// ---------------------------------------------------------------------------
// EXECUTED, not read. Everything above asserts over the block's TEXT, and a
// cross-model adversarial pass over the first version of this file broke eight of
// those assertions with legal shell and legal JavaScript — a `fi # comment` that
// desynchronised the scope walker, a `--timeout=0`, an exact-match `case` label
// carrying a vacuous range test, a `redirect:"follow"` surviving only inside a JS
// comment. Each is fixed above, and each fix is one more regex standing between a
// claim and its evidence.
//
// The durable answer to "your test parses a language it does not lex" is to stop
// parsing and start running. These two suites do that: the first executes the probe
// program against real local HTTP servers (which is exactly how the reviewing
// maintainer verified it by hand), the second executes the whole bash fence against
// stub `node`/`npx` binaries and reads what it actually prints and leaves on disk.
// A textual bypass cannot survive either one, because neither reads the text.
// ---------------------------------------------------------------------------

const http = require('http');
const os = require('os');
const { spawnSync, execFile } = require('child_process');

// The probe is `node -e '<program>' "<url>"`. Take the program out verbatim.
function probeProgram() {
  const line = logicalLines(screenshotApproachLines().map(stripComment))
    .find((l) => /\bnode\b[\t ]+-e[\t ]+'/.test(l));
  assert.ok(line, 'expected the block to probe with `node -e`');
  const open = line.indexOf("-e ") + 3;
  assert.strictEqual(line[open], "'", 'expected the probe program in single quotes');
  const close = line.indexOf("'", open + 1);
  assert.ok(close > open, 'unterminated probe program');
  return line.slice(open + 1, close);
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const close = (server) => new Promise((resolve) => server.close(resolve));
const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;

// ASYNC, and that is not a style choice. The servers above live in THIS process, so a
// spawnSync here blocks the very event loop that has to answer the probe: every request
// hung, the probe's own AbortSignal fired at 5s, and three tests failed with '000' against
// live servers while the two that "passed" passed vacuously. Measured while writing this
// suite — a self-inflicted instance of the false-clean class the rest of this file is about.
function runProbe(url) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['-e', probeProgram(), url], { timeout: 30000 },
      // MODEL THE WHOLE SHELL EXPRESSION, not just the program. The fence runs
      //   PROBE=$(node -e '…' "$url" 2>/dev/null || echo "000"); PROBE=${PROBE:-000}
      // so a program that PRINTS 200 and then exits non-zero yields `200000` — which
      // matches no arm and reads as absent. Ignoring the exit code here accepted exactly
      // that mutant. `$( )` strips trailing newlines and nothing else: a blanket .trim()
      // accepted " 200" (which the block's `case` rejects) and no trim at all rejected
      // "200\n" (which it accepts). All three directions driven.
      (err, stdout) => {
        const code = err && typeof err.code === 'number' ? err.code : 0;
        const raw = String(stdout) + (code !== 0 ? '000\n' : '');
        const substituted = raw.replace(/\n+$/, '');
        resolve(substituted === '' ? '000' : substituted);
      });
  });
}

describe('#4176 — the probe program, executed against real servers', () => {
  test('a redirecting dev server resolves to its final 2xx, not to "absent"', async () => {
    // The originating bug: `curl` without -L against a root that 307s read as no server.
    // A regression to redirect:"manual" or a deleted redirect key cannot pass this,
    // whatever the block's comments say — the program is RUN.
    const target = await listen((req, res) => { res.writeHead(200); res.end('ok'); });
    const redirector = await listen((req, res) => {
      res.writeHead(307, { Location: `${urlOf(target)}/` });
      res.end();
    });
    try {
      assert.strictEqual(await runProbe(urlOf(redirector)), '200',
        'a 307 to a live 2xx must probe as 200 — following redirects is the #4176 fix');
    } finally { await close(redirector); await close(target); }
  });

  test('a 2xx that is not 200 is still a dev server', async () => {
    const server = await listen((req, res) => { res.writeHead(204); res.end(); });
    try {
      assert.strictEqual(await runProbe(urlOf(server)), '204');
    } finally { await close(server); }
  });

  test('an auth-gated server reports its status, not absence', async () => {
    const server = await listen((req, res) => { res.writeHead(401); res.end(); });
    try {
      assert.strictEqual(await runProbe(urlOf(server)), '401');
    } finally { await close(server); }
  });

  test('nothing listening probes as 000', async () => {
    // A port this test HELD and then released, not a well-known one: node's fetch
    // rejects port 1 as a bad port before it ever attempts a connection, so probing it
    // exercises URL validation rather than an absent listener — the wrong mechanism,
    // reaching the right answer. Driven. Binding first also removes the guesswork about
    // what else on the host might be listening; the residual is the window between the
    // close and the probe, which is why a rebind is retried rather than asserted through.
    let observed = null;
    for (let attempt = 0; attempt < 3 && observed !== '000'; attempt += 1) {
      const server = await listen((req, res) => { res.writeHead(200); res.end(); });
      const dead = urlOf(server);
      await close(server);
      observed = await runProbe(dead);
    }
    assert.strictEqual(observed, '000',
      'a closed but valid port must probe as 000 through a real connection refusal');
  });

  test('a port that accepts but never answers is time-bounded, not a hang', async () => {
    // The issue's own third case. Without AbortSignal.timeout this never returns and the
    // audit blocks forever; a presence check on the string "AbortSignal" cannot tell the
    // difference between a bound that fires and one that does not.
    const server = await listen(() => { /* accept, never respond */ });
    try {
      const started = Date.now();
      assert.strictEqual(await runProbe(urlOf(server)), '000');
      assert.ok(Date.now() - started < 20000,
        'the probe must abort a non-answering port rather than hang');
    } finally { await close(server); }
  });
});

// The fence needs a POSIX shell. Windows CI has no bash on PATH by default, and the
// repo's other fence-executing tests take the same platform gate.
// The fence needs a POSIX shell. Gate on bash actually being RUNNABLE, not on the
// platform: a `process.platform === 'win32'` gate also skips silently on any non-Windows
// host without bash, and claims Windows has none when Git Bash is often present.
const BASH_OK = (() => {
  const r = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0;
})();

describe('#4176 — the capture fence, executed', { skip: BASH_OK ? false : 'no runnable bash on this host' }, () => {
  const tmpDirs = [];
  // cleanup(), not a raw fs.rmSync: the helper carries the Windows-EBUSY retry budget, and
  // these directories hold files a spawned bash was writing moments earlier.
  after(() => { for (const d of tmpDirs) cleanup(d); });

  // Stub `node` and `npx` on PATH, run the fence, and read what it printed, what it left
  // on disk, what it passed to the capture binary, and what CAPTURE_STATUS ended up as.
  //
  // EXIT STATUS AND FILE CONTENT ARE INDEPENDENT KNOBS, and that independence is the
  // whole point of this harness. The first version derived both from one `SHOT_FAIL`
  // list: success always wrote a non-empty file, failure never did. Two different
  // regressions then passed every fixture — deleting the `[ -s ... ]` check, and
  // ignoring the capture command's exit status — because with the two signals perfectly
  // correlated, either one alone reproduces the correct answer. Both were driven.
  //   SHOT_EXIT   viewports whose capture command exits non-zero
  //   SHOT_WRITE  viewports that write a NON-EMPTY file (regardless of exit status)
  //   SHOT_EMPTY  viewports that write a ZERO-BYTE file (the crashed-browser artefact)
  function runFence(env, sharedDir) {
    const dir = sharedDir || fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4176-'));
    if (!sharedDir) tmpDirs.push(dir);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    // node's own argv contract: `node -e <program> <arg1>` puts arg1 at $3. Selecting the
    // last `http*` argument instead made the stub tolerate an inserted argument that real
    // node would have handed to the program as argv[1], so a probe invocation that is
    // wrong in the real world passed here.
    fs.writeFileSync(path.join(bin, 'node'),
      '#!/bin/sh\n[ "$1" = "-e" ] || { echo "stub node: expected -e, got $1" >&2; exit 64; }\n'
      // Real node accepts `-e PROGRAM -- URL` and still hands URL to the program as
      // argv[1]; a stub that stopped at `$3` reported absence and false-FAILED eleven
      // fence tests on a legal invocation.
      + 'shift 2\n[ "$1" = "--" ] && shift\nurl="$1"\ncase "$url" in http*) ;; *) echo "stub node: argv[1] not a url: $url" >&2; exit 65;; esac\n'
      + 'port=${url##*:}\nport=${port%%/*}\neval "s=\\$PROBE_$port"\nprintf %s "${s:-000}"\n', { mode: 0o755 });
    // One argument per line, so an assertion can read argument BOUNDARIES. `$*` collapsed
    // them, which let `--user-agent="--timeout=30000"` satisfy the timeout assertion while
    // passing no timeout option at all.
    fs.writeFileSync(path.join(bin, 'npx'),
      // VERIFY THE COMMAND SELECTION. A stub that manufactures screenshots for whatever
      // it is handed accepts `npx --version playwright screenshot ...`, which the real
      // offline npx answers by printing its version and capturing nothing. Driven: that
      // mutant passed every assertion here and failed against the real binary.
      '#!/bin/sh\n[ "$1" = "playwright" ] && [ "$2" = "screenshot" ] || '
      + '{ echo "stub npx: not invoked as `playwright screenshot`: $1 $2" >&2; exit 66; }\n'
      + 'out=""\nfor a in "$@"; do case "$a" in *.png) out="$a";; esac; done\n'
      + 'name=$(basename "$out" .png)\n'
      // NUL-DELIMITED. A newline-delimited log splits an argument that CONTAINS a
      // newline into two, so `--user-agent=$'audit\\n--timeout=30000'` — one argument
      // passing no timeout option at all — read as two arguments, the second of which
      // satisfied the timeout assertion. Driven.
      + '{ printf "%s\\0" "--INVOCATION--"; for a in "$@"; do printf "%s\\0" "$a"; done; } >> "$ARGV_LOG"\n'
      + 'case " $SHOT_WRITE " in *" $name "*) printf png > "$out";; esac\n'
      + 'case " $SHOT_EMPTY " in *" $name "*) : > "$out";; esac\n'
      + 'case " $SHOT_EXIT " in *" $name "*) exit 1;; esac\nexit 0\n', { mode: 0o755 });
    // The `date` override is a SHELL FUNCTION, injected into the script below — never a
    // file on PATH. Git Bash searches /usr/bin ahead of the converted Windows PATH, so a
    // stub named after a coreutils binary is shadowed there: measured on the
    // windows-latest runner, where the fence used the REAL clock, the collision could not
    // be constructed, and both fixtures passed vacuously while the Linux shards were
    // green. A function is looked up before PATH on every platform.
    const argvLog = path.join(dir, 'argv.log');
    const script = path.join(dir, 'fence.sh');
    // No `set -u`: the agent does not run this block under it, and adding it changes the
    // block's behaviour on an unset variable — a difference between the harness and the
    // product is a finding the harness would then manufacture rather than detect.
    // CAPTURE_STATUS is echoed because it, not the printed line, is what the report
    // consumes: an unconditional `CAPTURE_STATUS="captured"` appended after the branches
    // passed every assertion in the first version while making the final report lie.
    // Capture the block's OWN status before the instrumentation runs: a trailing
    // `printf` resets `$?`, so appending `false` to the fence exited 0 and the
    // exit-status assertion passed on a fence that had failed. Driven.
    // THE INSTRUMENTATION WRITES FILES, NOT STDOUT. Anything printed to stdout is
    // forgeable by the block under test: a `CAPTURE_STATUS` whose VALUE contains a
    // newline forged a second status line, and a `printf "FENCE_RC=0"` forged a clean
    // exit — both passed a stdout-scraping reader, whether it took the first match or
    // the last. A file the block never names cannot be forged by the block's own output.
    const statusFile = path.join(dir, 'capture-status.out');
    const rcFile = path.join(dir, 'fence-rc.out');
    const dateOverride = env.FIXED_DATE
      ? `date() { printf %s ${JSON.stringify(env.FIXED_DATE)}; }\n`
      : '';
    fs.writeFileSync(script,
      `PADDED_PHASE=${env.PADDED_PHASE || '07'}\n${dateOverride}${screenshotApproachBlock()}\n`
      + 'FENCE_RC=$?\n'
      + `printf %s "$CAPTURE_STATUS" > ${JSON.stringify(statusFile)}\n`
      + `printf %s "$FENCE_RC" > ${JSON.stringify(rcFile)}\n`);
    const r = spawnSync('bash', [script], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        ARGV_LOG: argvLog,
        SHOT_EXIT: '', SHOT_WRITE: 'desktop mobile tablet', SHOT_EMPTY: '',
        ...env,
      },
    });
    const stdout = r.stdout || '';
    const reviews = path.join(dir, '.planning', 'ui-reviews');
    const shotDirs = fs.existsSync(reviews) ? fs.readdirSync(reviews).sort() : [];
    const filesIn = (d) => fs.readdirSync(path.join(reviews, d)).sort();
    const argvRaw = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8') : '';
    const readOut = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
    const status = readOut(statusFile);
    const rcRead = readOut(rcFile);
    return {
      stdout,
      exitCode: rcRead !== null && rcRead !== '' ? Number(rcRead) : r.status,
      stderr: r.stderr || '',
      captureStatus: status,
      dir,
      // Each invocation as an array of its arguments — boundaries preserved.
      invocations: argvRaw.split('--INVOCATION--\0').slice(1)
        .map((b) => b.split('\0').filter((x) => x !== '')),
      shotDirs,
      filesIn,
      files: shotDirs.length === 1 ? filesIn(shotDirs[0]) : [],
    };
  }

  // The fence must not fail as a PROGRAM. Appending `exit 42` to it passed every
  // assertion in the first version, because the runner discarded the exit status.
  function ok(r) {
    assert.strictEqual(r.exitCode, 0, `the fence must exit 0; stderr: ${r.stderr}`);
    assert.ok(r.captureStatus !== null, 'the fence must leave CAPTURE_STATUS set');
    return r;
  }

  test('no dev server on any port is reported as such, and nothing is created', () => {
    const r = ok(runFence({}));
    assert.match(r.stdout, /No dev server on ports 3000, 5173 or 8080/);
    assert.strictEqual(r.captureStatus, 'not captured (no dev server)');
    assert.deepStrictEqual(r.shotDirs, [], 'no review directory may be created without a dev server');
  });

  test('a total capture failure NEVER claims success, in the message OR in the status', () => {
    const r = ok(runFence({ PROBE_3000: '200', SHOT_EXIT: 'desktop mobile tablet',
      SHOT_WRITE: '', SHOT_EMPTY: 'desktop mobile tablet' }));
    assert.doesNotMatch(r.stdout, /Screenshots captured/, 'a failed capture must never claim success');
    assert.doesNotMatch(r.stdout, /PARTIALLY captured/);
    assert.match(r.stdout, /Screenshot capture FAILED for all 3 viewports/);
    assert.strictEqual(r.captureStatus, 'not captured (capture failed)',
      'the report reads CAPTURE_STATUS, not the printed line — both have to be honest');
    assert.deepStrictEqual(r.shotDirs, [], 'the review directory must not survive a total failure');
  });

  test('a capture that exits 0 without writing anything is NOT a capture', () => {
    // The `[ -s ... ]` half of the check, isolated. Deleting it passes every fixture in
    // which exit status and file content agree — which is why they are separate knobs.
    const r = ok(runFence({ PROBE_3000: '200', SHOT_WRITE: '', SHOT_EXIT: '' }));
    assert.doesNotMatch(r.stdout, /Screenshots captured/);
    assert.strictEqual(r.captureStatus, 'not captured (capture failed)');
  });

  test('a capture that exits 0 leaving a ZERO-BYTE file is NOT a capture', () => {
    // The `-s` in `[ -s ... ]` doing its own work. Relaxing it to `[ -e ]` — the file
    // merely EXISTS — passed every fixture until this one, because no scenario paired a
    // clean exit with an empty file. A crashed browser writing a zero-byte png and
    // exiting 0 is precisely the shape #4176 is about.
    const r = ok(runFence({ PROBE_3000: '200', SHOT_WRITE: '', SHOT_EMPTY: 'desktop mobile tablet',
      SHOT_EXIT: '' }));
    assert.doesNotMatch(r.stdout, /Screenshots captured/);
    assert.strictEqual(r.captureStatus, 'not captured (capture failed)');
  });

  test('a capture that writes a real file but exits non-zero is NOT a capture, and its file goes', () => {
    // The exit-status half, isolated. Dropping it counts a crashed run that happened to
    // leave a plausible file.
    // EVERY viewport, not just the first. A cleanup skipping one specific name
    // (`if [ "$SHOT_NAME" != mobile ]`) passed a fixture set that only ever failed
    // `desktop`, and the total-failure fixtures conceal it because the directory is
    // removed wholesale. Driven.
    const others = { desktop: ['mobile.png', 'tablet.png'], mobile: ['desktop.png', 'tablet.png'],
      tablet: ['desktop.png', 'mobile.png'] };
    for (const [failed, survivors] of Object.entries(others)) {
      const r = ok(runFence({ PROBE_3000: '200', SHOT_EXIT: failed,
        SHOT_WRITE: 'desktop mobile tablet' }));
      assert.match(r.stdout, new RegExp(`PARTIALLY captured .*\\(2/3\\).*failed: ?${failed}`));
      assert.strictEqual(r.captureStatus, 'partially captured');
      // Restricting the cleanup to empty files only also passed every earlier fixture,
      // because none paired a failure with a non-empty artefact — a plausible-looking
      // png from a run that crashed after writing is the worst case to leave, not the least.
      assert.deepStrictEqual(r.files, survivors,
        `a failed ${failed} capture must take its file with it, empty or not`);
    }
  });

  test('a partial capture keeps the shots that worked and removes the stray file', () => {
    const r = ok(runFence({ PROBE_3000: '200', SHOT_EXIT: 'desktop',
      SHOT_WRITE: 'mobile tablet', SHOT_EMPTY: 'desktop' }));
    assert.match(r.stdout, /Screenshots PARTIALLY captured .*\(2\/3\).*failed: ?desktop/);
    assert.strictEqual(r.captureStatus, 'partially captured');
    assert.deepStrictEqual(r.files, ['mobile.png', 'tablet.png'],
      'the failed viewport\u2019s zero-byte file must not survive alongside the real captures');
  });

  test('audits colliding on the same second get separate directories, and none destroys another', () => {
    // CONSTRUCTED, not hoped for. `date` is overridden to a fixed value and all three
    // audits share one working directory, so they genuinely contend for the same base
    // name — the case a wall-clock test can never reach, and the case that matters: every
    // audit writes exactly `desktop.png`, `mobile.png`, `tablet.png`, so no per-file rule
    // can establish ownership. Ownership must come from winning the directory.
    //
    // TWO SURVIVING AUDITS, not one. Reading the directory list after a single failing
    // second run cannot see whether that run contended at all: its directory is removed
    // either way, so freezing only the FIRST audit left the second on the real clock and
    // the fixture still passed. Driven. Both successful audits must therefore be present,
    // distinct, and both under the frozen base name.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4176-race-'));
    tmpDirs.push(dir);
    const fixed = { FIXED_DATE: '20300101-000000', PADDED_PHASE: '07' };
    const base = `07-${fixed.FIXED_DATE}`;
    ok(runFence({ ...fixed, PROBE_3000: '200' }, dir));
    const second = ok(runFence({ ...fixed, PROBE_3000: '200' }, dir));
    assert.strictEqual(second.shotDirs.length, 2,
      `two contending audits must hold two directories: ${JSON.stringify(second.shotDirs)}`);
    for (const d of second.shotDirs) {
      assert.ok(d.startsWith(base),
        `every audit must be on the frozen base name or they never contend: ${JSON.stringify(second.shotDirs)}`);
    }
    assert.notStrictEqual(second.shotDirs[0], second.shotDirs[1],
      'a contended base name must not be handed to two audits');
    for (const d of second.shotDirs) {
      assert.deepStrictEqual(second.filesIn(d), ['desktop.png', 'mobile.png', 'tablet.png'],
        `each audit keeps its own three captures: ${d}`);
    }
    // And a third audit that fails everything removes only its own directory — under a
    // shared one, its cleanup is what destroyed the neighbours' identically-named files.
    const third = ok(runFence({ ...fixed, PROBE_3000: '200', SHOT_EXIT: 'desktop mobile tablet',
      SHOT_WRITE: '', SHOT_EMPTY: 'desktop mobile tablet' }, dir));
    assert.match(third.stdout, /Screenshot capture FAILED for all 3 viewports/);
    assert.strictEqual(third.shotDirs.length, 2,
      `the failing audit must remove only its own directory: ${JSON.stringify(third.shotDirs)}`);
    for (const d of third.shotDirs) {
      assert.deepStrictEqual(third.filesIn(d), ['desktop.png', 'mobile.png', 'tablet.png'],
        `a failing audit's cleanup must not touch another audit's captures: ${d}`);
    }
  });

  test('an exhausted allocation is a capture failure, not a write outside the project', () => {
    // The safety branch had NO fixture: replacing its guard with `if false; then` passed
    // every assertion. With SCREENSHOT_DIR empty the capture would write to /desktop.png
    // — outside the project entirely — so the branch that prevents it is exactly the kind
    // that must not be taken on trust.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4176-full-'));
    tmpDirs.push(dir);
    const reviews = path.join(dir, '.planning', 'ui-reviews');
    fs.mkdirSync(reviews, { recursive: true });
    // Occupy the base name and every suffix the loop will try.
    fs.mkdirSync(path.join(reviews, '07-20300101-000000'));
    for (let i = 1; i <= 99; i += 1) fs.mkdirSync(path.join(reviews, `07-20300101-000000-${i}`));
    const r = ok(runFence({ FIXED_DATE: '20300101-000000', PADDED_PHASE: '07', PROBE_3000: '200' }, dir));
    // Same guard, same reason: without a frozen clock the run allocates a fresh name, the
    // 100 occupied directories are never contended, and the exhaustion branch is not
    // reached at all. Measured on windows-latest, where this fixture failed for that
    // reason rather than for the reason it names.
    assert.doesNotMatch(r.stdout, /Screenshots captured/,
      'the date override did not take — the allocation was never exhausted');
    // The MESSAGE, not just a generic failure. Dropping this line (it was lost when the
    // vacuity guard above was added) let the fixture infer exhaustion from any capture
    // failure with no invocations — an unfrozen clock plus a capture stub that fails
    // early satisfied it while nothing was ever exhausted. Driven.
    assert.match(r.stdout, /Could not allocate a review directory/,
      'the exhaustion branch must be the one that ran, not merely some capture failure');
    assert.strictEqual(r.captureStatus, 'not captured (capture failed)');
    assert.doesNotMatch(r.stdout, /Screenshots captured/);
    assert.strictEqual(r.invocations.length, 0,
      'nothing may be captured when no directory was allocated — the path would be outside the project');
    assert.strictEqual(fs.readdirSync(reviews).length, 100,
      'the exhausted run must not have created a directory of its own');
  });

  test('the last candidate suffix is tried, not skipped', () => {
    // The retry loop once incremented past the bound before forming the next candidate,
    // so with the base and `-1`..`-98` taken it reported exhaustion while `-99` was free.
    // That correction had no test of its own — reverting it passed the whole suite — and
    // an off-by-one at the END of a bounded loop is exactly the shape a fixture that only
    // exercises the empty and exhausted cases will never reach.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4176-last-'));
    tmpDirs.push(dir);
    const reviews = path.join(dir, '.planning', 'ui-reviews');
    fs.mkdirSync(reviews, { recursive: true });
    fs.mkdirSync(path.join(reviews, '07-20300101-000000'));
    for (let i = 1; i <= 98; i += 1) fs.mkdirSync(path.join(reviews, `07-20300101-000000-${i}`));
    const r = ok(runFence({ FIXED_DATE: '20300101-000000', PADDED_PHASE: '07', PROBE_3000: '200' }, dir));
    assert.doesNotMatch(r.stdout, /Could not allocate a review directory/,
      'the last free candidate must be used, not skipped');
    assert.match(r.stdout, /Screenshots captured/);
    assert.ok(fs.existsSync(path.join(reviews, '07-20300101-000000-99')),
      `the run must have allocated the one free suffix: ${JSON.stringify(fs.readdirSync(reviews).slice(-3))}`);
  });

  test('all three captures succeeding is the only path that claims "captured"', () => {
    const r = ok(runFence({ PROBE_3000: '200' }));
    assert.match(r.stdout, /Screenshots captured to .* \(3\/3\) from http:\/\/localhost:3000/);
    assert.strictEqual(r.captureStatus, 'captured');
    assert.deepStrictEqual(r.files, ['desktop.png', 'mobile.png', 'tablet.png']);
  });

  test('the resolved port is the one captured, not a hard-coded 3000', () => {
    const r = ok(runFence({ PROBE_5173: '200' }));
    assert.match(r.stdout, /from http:\/\/localhost:5173/);
    for (const call of r.invocations) {
      assert.ok(call.includes('http://localhost:5173'), `capture argv: ${JSON.stringify(call)}`);
      assert.ok(!call.includes('http://localhost:3000'), `capture argv: ${JSON.stringify(call)}`);
    }
  });

  test('any 2xx resolves a dev server, not an enumerated few', () => {
    // 299 is the point: a mutant that swaps the `2??` glob for an enumeration wide
    // enough to cover the statuses a test happens to use — `200|204` — passes a fixture
    // set built from plausible statuses. A status no enumeration would think to list is
    // what makes this a RANGE test rather than a longer list.
    for (const status of ['200', '201', '204', '206', '299']) {
      assert.match(ok(runFence({ PROBE_3000: status })).stdout, /Screenshots captured/,
        `HTTP ${status} is a 2xx and must resolve a dev server`);
    }
  });

  test('the FIRST auth-gated port is the one reported', () => {
    const r = ok(runFence({ PROBE_3000: '401', PROBE_8080: '403' }));
    assert.match(r.stdout, /Dev server at http:\/\/localhost:3000 \(HTTP 401\) is auth-gated/);
    assert.strictEqual(r.captureStatus, 'not captured (dev server auth-gated)');
  });

  test('the whole auth-required class is reported as gated, not as absent', () => {
    for (const status of ['401', '403', '407', '511']) {
      const r = ok(runFence({ PROBE_3000: status }));
      assert.ok(r.stdout.includes(`(HTTP ${status}) is auth-gated`),
        `HTTP ${status} means the server answered and demanded credentials; it must not read as absent — got: ${r.stdout.trim()}`);
    }
  });

  test('every capture invocation passes a positive timeout as its own argument', () => {
    // ARGUMENT BOUNDARIES, and the LAST occurrence. A text search over a collapsed
    // command line accepted `--timeout=30000 --timeout=0` (bash keeps the last, i.e. no
    // timeout) and `--user-agent="--timeout=30000"` (no timeout option at all). Both
    // were driven against the first version of this assertion.
    const r = ok(runFence({ PROBE_3000: '200' }));
    assert.strictEqual(r.invocations.length, 3, `expected 3 capture invocations: ${JSON.stringify(r.invocations)}`);
    for (const call of r.invocations) {
      const values = [];
      for (let i = 0; i < call.length; i += 1) {
        // `--` ends option parsing; everything after it is a positional, so
        // `-- --timeout=30000` passes NO timeout option. Driven against the first version.
        if (call[i] === '--') break;
        const inline = /^--timeout=(.*)$/.exec(call[i]);
        if (inline) { values.push(inline[1]); continue; }
        if (call[i] === '--timeout') values.push(call[i + 1]);
      }
      assert.ok(values.length > 0, `capture must pass --timeout as its own argument: ${JSON.stringify(call)}`);
      const effective = values[values.length - 1];   // a repeated option: the last wins
      assert.ok(/^[0-9]+$/.test(effective) && Number(effective) > 0,
        `the effective --timeout must be a positive integer (0 IS playwright's no-timeout): ${JSON.stringify(call)}`);
    }
  });
});

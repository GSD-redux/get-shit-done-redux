// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

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
        stack.push(pendingIf);
        pendingIf = null;
        const tail = t === 'then' ? '' : t.slice(5).trim();
        if (tail === '') continue;
        rows.push({ line: tail, guards: stack.slice() });
        continue;
      }
      throw new Error(`bash reader: '${pendingIf}' opened an if with no 'then' — got ${JSON.stringify(t)}`);
    }
    const ifMatch = /^if[\t ]+(.{1,4000}?)[\t ]*;[\t ]*then$/.exec(t);
    if (ifMatch) { stack.push(ifMatch[1]); continue; }
    const ifPending = /^if[\t ]+(.{1,4000}?)[\t ]*$/.exec(t);
    if (ifPending && !/;/.test(ifPending[1])) { pendingIf = ifPending[1]; continue; }
    const elifMatch = /^elif[\t ]+(.{1,4000}?)[\t ]*;[\t ]*then$/.exec(t);
    if (elifMatch) { if (stack.length) stack[stack.length - 1] = elifMatch[1]; continue; }
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
    if (/(^|[\t ;&|(])(if|then|elif|fi|do|done|case|esac)([\t ;&|)]|$)/.test(t)) {
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
  let out = '';
  let quote = null;       // null | "'" | '"'
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote === "'") { out += c; if (c === "'") quote = null; continue; }
    if (quote === '"') {
      if (c === '\\' && i + 1 < line.length) { out += c + line[i + 1]; i += 1; continue; }
      out += c; if (c === '"') quote = null; continue;
    }
    if (c === '\\' && i + 1 < line.length) { out += c + line[i + 1]; i += 1; continue; }
    if (c === "'" || c === '"') { out += c; quote = c; continue; }
    if (c === '#' && (i === 0 || /[\t ]/.test(line[i - 1]))) {
      // A `\` that the removed text was hiding did NOT continue the line in bash, so this
      // reader must not treat it as one. Driven: `echo one \ # x` followed by
      // `--timeout=30000` runs the second line as its OWN command — bash never joins them.
      // Keeping the backslash would make logicalLines() join what bash does not, so a flag
      // on the following line would satisfy an assertion the real command never receives.
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
  let quote = null;
  let end = -1;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '\\') { i += 1; continue; }
    if (c === ')') { end = i; break; }
  }
  if (end <= 0) return null;
  const label = t.slice(0, end);
  // A case label is patterns joined by `|`; anything with a space or `=` in it is a
  // command line that merely happens to contain a `)`, not an arm.
  if (/[\t =]/.test(label)) return null;
  return label.split('|').map((x) => x.trim()).filter((x) => x !== '');
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
      ? armLabel.some((pat) => /^2(\?\?|\[0-9\]\[0-9\]|\*)$/.test(pat))
      : (/-ge[\t ]+200\b/.test(acceptArm) || /\br\.ok\b/.test(block));
    assert.ok(
      acceptsRange,
      armLabel !== null
        ? `the case label that admits a status must be a 2xx RANGE (2?? / 2[0-9][0-9] / 2*), not an enumerated status — a range test inside an exact-match arm decides nothing: label was ${JSON.stringify(armLabel)}`
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
      assert.ok(
        /\[[\t ]+-n[\t ]+"?\$DEV_GATED"?[\t ]+\][\t ]*\|\|/.test(line)
          || /\[[\t ]+-z[\t ]+"?\$DEV_GATED"?[\t ]+\][\t ]*&&/.test(line),
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
    const labels = gatedArms.map((l) => caseLabelOf(l) || []);
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
      const flag = /--timeout[= ]([0-9]+)\b/.exec(line);
      assert.ok(flag, `capture must be time-bounded — playwright screenshot defaults to no timeout: ${line}`);
      assert.ok(
        Number(flag[1]) > 0,
        `--timeout=0 IS playwright's no-timeout setting — the bound must be positive: ${line}`
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
    // It is also BY NAME rather than a `*.png` glob, because the review directory is
    // keyed to the phase and a whole second, so a concurrent audit of the same phase can
    // share it and a glob would delete that audit's captures.
    const rows = guardedLines(screenshotApproachLines());
    const removals = rows.filter((r) => /^rm -f\b/.test(r.line));
    assert.ok(removals.length > 0, 'expected the capture loop to remove a failed viewport\u2019s stray file');
    for (const row of removals) {
      assert.ok(
        !/\*/.test(row.line),
        `stray-file removal must name the file, never glob the directory — a concurrent audit shares it: ${row.line}`
      );
      assert.ok(
        /\$SHOT_NAME/.test(row.line),
        `stray-file removal must target the viewport that just failed: ${row.line}`
      );
    }
    const removesDir = rows.filter((r) => /^rmdir\b/.test(r.line));
    assert.ok(removesDir.length > 0, 'expected the all-failed branch to remove the review directory');
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
    const surfaces = splitLines(fs.readFileSync(AUDITOR_PATH, 'utf-8'))
      .filter((l) => /^\*\*Screenshots:\*\*/.test(l.trim()));
    assert.ok(surfaces.length > 0, 'expected a Screenshots report field in the agent output template');
    assert.ok(
      surfaces.every((l) => l.includes('$CAPTURE_STATUS')),
      'every Screenshots report field must render $CAPTURE_STATUS, or the status is computed and dropped'
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
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', probeProgram(), url], { timeout: 30000 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout).trim())));
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
    const server = await listen((req, res) => { res.writeHead(200); res.end(); });
    const dead = urlOf(server);
    await close(server);
    assert.strictEqual(await runProbe(dead), '000');
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
const BASH = process.platform === 'win32' ? null : 'bash';

describe('#4176 — the capture fence, executed', { skip: BASH ? false : 'no bash on this platform' }, () => {
  // Stub `node` and `npx` on PATH, run the fence, and read what it printed and left.
  //  PROBE_<port>   the status the stubbed probe reports for that port
  //  SHOT_FAIL      space-separated viewport names whose capture "fails"
  //  SHOT_PARTIAL   viewport names whose failed capture still writes a zero-byte file
  function runFence(env) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4176-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'node'),
      '#!/bin/sh\nfor a in "$@"; do case "$a" in http*) url="$a";; esac; done\n'
      + 'port=${url##*:}\nport=${port%%/*}\neval "s=\\$PROBE_$port"\nprintf %s "${s:-000}"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npx'),
      '#!/bin/sh\nout=""\nfor a in "$@"; do case "$a" in *.png) out="$a";; esac; done\n'
      + 'name=$(basename "$out" .png)\n'
      + 'printf "%s\\n" "$*" >> "$ARGV_LOG"\n'
      + '[ -n "$PLANT_FOREIGN" ] && printf other > "$(dirname "$out")/other-audit.png"\n'
      + 'case " $SHOT_FAIL " in *" $name "*)\n'
      + '  case " $SHOT_PARTIAL " in *" $name "*) : > "$out";; esac\n'
      + '  exit 1;; esac\n'
      + 'printf "png" > "$out"\nexit 0\n', { mode: 0o755 });
    const argvLog = path.join(dir, 'argv.log');
    const script = path.join(dir, 'fence.sh');
    fs.writeFileSync(script, `set -u\nPADDED_PHASE=07\n${screenshotApproachBlock()}\n`);
    const r = spawnSync(BASH, [script], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        ARGV_LOG: argvLog,
        SHOT_FAIL: '', SHOT_PARTIAL: '',
        ...env,
      },
    });
    const reviews = path.join(dir, '.planning', 'ui-reviews');
    const shotDirs = fs.existsSync(reviews) ? fs.readdirSync(reviews) : [];
    return {
      stdout: r.stdout || '',
      dir,
      argv: fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8') : '',
      shotDirs,
      files: shotDirs.length === 1 ? fs.readdirSync(path.join(reviews, shotDirs[0])).sort() : [],
    };
  }

  test('no dev server on any port is reported as such, and nothing is created', () => {
    const r = runFence({});
    assert.match(r.stdout, /No dev server on ports 3000, 5173 or 8080/);
    assert.deepStrictEqual(r.shotDirs, [], 'no review directory may be created without a dev server');
  });

  test('a total capture failure NEVER prints a success claim, and leaves nothing behind', () => {
    // The #4176 defect itself, and the maintainer's Major finding, decided by execution:
    // hoisting the success echo out of its branch makes this fail no matter how the block
    // is punctuated, because the assertion is over what the block PRINTED.
    const r = runFence({ PROBE_3000: '200', SHOT_FAIL: 'desktop mobile tablet', SHOT_PARTIAL: 'desktop mobile tablet' });
    assert.doesNotMatch(r.stdout, /Screenshots captured/, 'a failed capture must never claim success');
    assert.doesNotMatch(r.stdout, /PARTIALLY captured/);
    assert.match(r.stdout, /Screenshot capture FAILED for all 3 viewports/);
    assert.deepStrictEqual(r.shotDirs, [], 'the review directory must not survive a total failure');
  });

  test('a partial capture keeps the shots that worked and removes the stray files', () => {
    // The review's finding 4, in the form the docs actually claim: the failed viewport's
    // zero-byte file is gone while the two real captures remain.
    const r = runFence({ PROBE_3000: '200', SHOT_FAIL: 'desktop', SHOT_PARTIAL: 'desktop' });
    assert.match(r.stdout, /Screenshots PARTIALLY captured .*\(2\/3\).*failed: ?desktop/);
    assert.deepStrictEqual(r.files, ['mobile.png', 'tablet.png'],
      'the failed viewport\u2019s zero-byte file must not survive alongside the real captures');
  });

  test('a concurrent audit sharing the directory keeps its own captures', () => {
    // Why the removal is BY NAME and not `rm -f "$DIR"/*.png`: the review directory is
    // keyed to the phase and one whole second, so a second audit of the same phase can
    // land in it. Under the glob, this audit's total failure deleted that one's captures.
    // Here a foreign file is planted into the shared directory and every viewport then
    // fails: our three stray files go, the neighbour's stays, and rmdir correctly declines
    // to remove a directory that is no longer empty. The surviving directory is the
    // intended outcome, not a leak — which is why the AGENTS.md capture paragraph says
    // so explicitly rather than eliding it. (Named without its path: this file does not
    // READ that document, and spelling the path would register it as a docs reader with
    // the docs-guard lint, which is a claim about this test that is not true.)
    const r = runFence({ PROBE_3000: '200', SHOT_FAIL: 'desktop mobile tablet',
      SHOT_PARTIAL: 'desktop mobile tablet', PLANT_FOREIGN: '1' });
    assert.match(r.stdout, /Screenshot capture FAILED for all 3 viewports/);
    assert.strictEqual(r.shotDirs.length, 1, 'the shared directory must survive, since it is not ours alone');
    assert.deepStrictEqual(r.files, ['other-audit.png'],
      'cleanup must remove only the files this audit wrote, never the whole directory\u2019s .png files');
  });

  test('all three captures succeeding is the only path that prints "captured"', () => {
    const r = runFence({ PROBE_3000: '200' });
    assert.match(r.stdout, /Screenshots captured to .* \(3\/3\) from http:\/\/localhost:3000/);
    assert.deepStrictEqual(r.files, ['desktop.png', 'mobile.png', 'tablet.png']);
  });

  test('the resolved port is the one captured, not a hard-coded 3000', () => {
    const r = runFence({ PROBE_5173: '200' });
    assert.match(r.stdout, /from http:\/\/localhost:5173/);
    assert.ok(r.argv.includes('http://localhost:5173'), `capture argv: ${r.argv}`);
    assert.ok(!r.argv.includes('http://localhost:3000'), `capture argv: ${r.argv}`);
  });

  test('a 2xx that is not 200 still resolves a dev server', () => {
    const r = runFence({ PROBE_3000: '204' });
    assert.match(r.stdout, /Screenshots captured/);
  });

  test('the FIRST auth-gated port is the one reported', () => {
    // The review's finding 5, decided by behaviour: flipping the guard's operator makes
    // DEV_GATED empty and this reports "no dev server", which fails here.
    const r = runFence({ PROBE_3000: '401', PROBE_8080: '403' });
    assert.match(r.stdout, /Dev server at http:\/\/localhost:3000 \(HTTP 401\) is auth-gated/);
  });

  test('the whole auth-required class is reported as gated, not as absent', () => {
    for (const status of ['401', '403', '407', '511']) {
      const r = runFence({ PROBE_3000: status });
      assert.ok(
        r.stdout.includes(`(HTTP ${status}) is auth-gated`),
        `HTTP ${status} means the server answered and demanded credentials; it must not read as absent — got: ${r.stdout.trim()}`
      );
    }
  });

  test('every capture invocation carries a positive timeout', () => {
    const r = runFence({ PROBE_3000: '200' });
    const calls = r.argv.split('\n').filter((l) => l.includes('screenshot'));
    assert.strictEqual(calls.length, 3, `expected 3 capture invocations: ${r.argv}`);
    for (const call of calls) {
      const m = /--timeout[= ]([0-9]+)\b/.exec(call);
      assert.ok(m && Number(m[1]) > 0, `capture must pass a positive --timeout: ${call}`);
    }
  });
});

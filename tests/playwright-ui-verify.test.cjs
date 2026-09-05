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
function guardedLines(lines) {
  const stack = [];
  const rows = [];
  for (const line of logicalLines(lines)) {
    const t = line.trim();
    const ifMatch = /^if[\t ]+(.{1,4000}?)[\t ]*;[\t ]*then$/.exec(t);
    if (ifMatch) { stack.push(ifMatch[1]); continue; }
    const elifMatch = /^elif[\t ]+(.{1,4000}?)[\t ]*;[\t ]*then$/.exec(t);
    if (elifMatch) { if (stack.length) stack[stack.length - 1] = elifMatch[1]; continue; }
    if (t === 'else') { if (stack.length) stack[stack.length - 1] = `!(${stack[stack.length - 1]})`; continue; }
    if (t === 'fi') { stack.pop(); continue; }
    if (/^(for|while|until)\b/.test(t) && /;[\t ]*do$/.test(t)) { stack.push(''); continue; }
    if (t === 'do') { stack.push(''); continue; }
    if (t === 'done') { stack.pop(); continue; }
    if (/^case\b/.test(t) && /\bin$/.test(t)) { stack.push(''); continue; }
    if (t === 'esac') { stack.pop(); continue; }
    rows.push({ line: t, guards: stack.slice() });
  }
  return rows;
}

describe('#4176 — gsd-ui-auditor screenshot capture is honest', () => {
  test('dev-server probe follows redirects and is time-bounded', () => {
    const block = screenshotApproachBlock();
    const followsRedirects = block.includes('curl -L') || block.includes('fetch(');
    assert.ok(followsRedirects, 'probe must follow redirects (curl -L or fetch()) — a 307 dev server is not an absent one');
    const timeBounded = /--max-time|AbortSignal\.timeout|run-with-timeout|--connect-timeout/.test(block);
    assert.ok(timeBounded, 'probe must be time-bounded — an accepting-but-unresponsive port must not hang the audit');
  });

  test('probe accepts any 2xx rather than exact-matching 200', () => {
    const block = screenshotApproachBlock();
    assert.ok(
      !/=[\s]*"200"/.test(block),
      'probe must not exact-match "200" — that misreads redirects and other 2xx as no-server'
    );
  });

  test('capture success is checked, not assumed', () => {
    const block = screenshotApproachBlock();
    const checksOutcome = /\[ -s "?\$SCREENSHOT_DIR|\[ -s |if npx |CAPTURED=|\$\?/.test(block);
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
    const block = screenshotApproachBlock();
    for (const port of ['3000', '5173', '8080']) {
      assert.ok(block.includes(port), `port ${port} must appear in the capture control flow, not only in guidance prose`);
    }
    assert.ok(/for PORT in|for port in/.test(block), 'ports must be iterated, not hard-coded to one');
  });

  test('the resolved port — not a hard-coded 3000 — is what gets captured', () => {
    const block = screenshotApproachBlock();
    const captureLines = block.split('\n').filter((l) => l.includes('playwright screenshot'));
    assert.ok(captureLines.length > 0, 'expected at least one capture invocation');
    for (const line of captureLines) {
      assert.ok(
        !line.includes('localhost:3000'),
        `capture must use the resolved port variable, not a literal localhost:3000: ${line.trim()}`
      );
    }
  });

  test('report surfaces can express partial capture', () => {
    const content = fs.readFileSync(AUDITOR_PATH, 'utf-8');
    assert.ok(
      /partially captured/i.test(content),
      'the Screenshots field must be able to say partial — full/none alone cannot describe 2 of 3'
    );
  });
});

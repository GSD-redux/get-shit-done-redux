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
function screenshotApproachBlock() {
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
  return body.join('\n');
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
    // The unconditional echo is the actual defect: a "captured" claim must not
    // sit outside any conditional that could have observed a failure.
    const unconditional = block
      .split('\n')
      .some((l) => /^\s*echo "Screenshots captured/.test(l) && !/CAPTURED|-eq|-s /.test(block.slice(0, block.indexOf(l))));
    assert.ok(!unconditional, '"Screenshots captured" must never be echoed without an outcome check');
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

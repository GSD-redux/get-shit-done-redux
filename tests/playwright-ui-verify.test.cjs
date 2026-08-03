// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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

// allow-test-rule: source-text-is-the-product see #1528
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI_REVIEW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ui-review.md');
const MANAGER = path.join(__dirname, '..', 'gsd-core', 'workflows', 'manager.md');
const VERIFY_WORK = path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work.md');

describe('ui-review next guidance', () => {
  test('prioritizes current-phase verification over next-phase planning (#1528)', () => {
    const content = fs.readFileSync(UI_REVIEW, 'utf-8');
    const nextBlock = content.slice(
      content.indexOf('## ▶ Next'),
      content.indexOf('## Automated UI Verification'),
    );

    assert.match(nextBlock, /verify-work \{N\}/, 'ui-review must route to current-phase UAT');
    assert.doesNotMatch(
      nextBlock,
      /plan-phase \{N\+1\}/,
      'ui-review must not present next-phase planning before current-phase verification passes',
    );
    assert.equal(
      (nextBlock.match(/verify-work \{N\}/g) || []).length,
      1,
      'ui-review next block must not duplicate verify-work guidance',
    );
  });
});

describe('verify-work blocked-state next guidance', () => {
  test('security-blocked presentation does not offer next-phase planning (#1528)', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    // The security-blocked presentation explicitly states advancement is blocked
    // until SECURITY.md exists; it must route to the current-phase fix only.
    const blockedStart = content.indexOf(
      'If `SECURITY_FILE` is still empty, stop before phase advancement',
    );
    const blockedBlock = content.slice(
      blockedStart,
      content.indexOf('If an active secure-phase step hook exists', blockedStart),
    );

    assert.match(
      blockedBlock,
      /secure-phase \{phase\}/,
      'security-blocked presentation must route to the current-phase secure-phase fix',
    );
    assert.doesNotMatch(
      blockedBlock,
      /plan-phase \{next\}/,
      'security-blocked presentation must not offer next-phase planning while advancement is blocked',
    );
    assert.doesNotMatch(
      blockedBlock,
      /execute-phase \{next\}/,
      'security-blocked presentation must not offer next-phase execution while advancement is blocked',
    );
  });

  test('next-phase planning is still offered after the phase is marked complete (#1528)', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    // The post-transition "next-step options" block is the legitimate place for
    // next-phase guidance — it only renders after the completion contract passes.
    const completeBlock = content.slice(
      content.indexOf('Phase {phase} marked complete.'),
      content.indexOf('<step name="scan_phase_artifacts">'),
    );

    assert.match(
      completeBlock,
      /plan-phase \{next\}/,
      'post-completion presentation must still offer next-phase planning',
    );
  });
});

describe('manager verify dispatch', () => {
  test('dispatches verify recommendations through their command field (#1523)', () => {
    const content = fs.readFileSync(MANAGER, 'utf-8');
    const compoundBlock = content.slice(
      content.indexOf('### Compound Action'),
      content.indexOf('### Discuss Phase N'),
    );

    assert.match(compoundBlock, /recommended action's `command`/);
    assert.match(compoundBlock, /gsd-execute-phase/);
    assert.match(compoundBlock, /gsd-verify-work/);
    assert.doesNotMatch(
      compoundBlock,
      // Not a fence PARSE — a negative-text probe asserting a banned prose
      // pattern is absent; there is no fence content being extracted.
      /Inline verification:\s*```[\s\S]*Skill\(skill="gsd-verify-work", args="\{PHASE_NUM\}"\)/, // allow-adhoc-markdown: negative-text probe, not a fence parse
    );
  });
});

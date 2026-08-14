/**
 * Regression test for #2198 — advertised base64/entropy/homoglyph scanning
 * never runs live. `scanEntropyAnomalies` + `shannonEntropy` were dead exports
 * (zero callers outside their own unit tests). The live hooks inline their
 * own pattern subsets "for hook independence" and never call these functions.
 *
 * This test asserts the chosen contract: the dead export was removed and the
 * docs no longer over-claim entropy analysis as a live MUST.
 *
 * Contract: `scanForInjection` is retained — it serves as the CI codebase
 * scanner engine (tests/prompt-injection-scan.security.test.cjs). It is NOT
 * called from live hooks; hooks inline their own patterns.
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

describe('#2198 regression: dead scan exports removed, docs corrected', () => {
  test('scanEntropyAnomalies is no longer exported from security.cjs', () => {
    const security = require('../gsd-core/bin/lib/security.cjs');
    assert.equal(
      security.scanEntropyAnomalies,
      undefined,
      'scanEntropyAnomalies should have been removed as a dead export (#2198)'
    );
  });

  test('shannonEntropy is not accessible from the security module', () => {
    const security = require('../gsd-core/bin/lib/security.cjs');
    assert.equal(
      security.shannonEntropy,
      undefined,
      'shannonEntropy was the private helper for the removed scanEntropyAnomalies'
    );
  });

  test('scanForInjection is retained (CI codebase scanner uses it)', () => {
    const security = require('../gsd-core/bin/lib/security.cjs');
    assert.equal(
      typeof security.scanForInjection,
      'function',
      'scanForInjection is retained: it serves as the CI codebase scanner engine'
    );
  });

  test('FEATURES.md does not over-claim entropy analysis as a live MUST', () => {
    const features = fs.readFileSync(
      path.join(PROJECT_ROOT, 'docs', 'FEATURES.md'),
      'utf-8'
    );
    assert.ok(
      !features.includes('REQ-SCAN-INJ-03: Scanner MUST apply entropy analysis'),
      'REQ-SCAN-INJ-03 should not claim entropy analysis runs as a live MUST — ' +
        'the implementation was dead code (#2198)'
    );
  });

  test('FEATURES.md documents that base64-decode is CI-only, not live', () => {
    const features = fs.readFileSync(
      path.join(PROJECT_ROOT, 'docs', 'FEATURES.md'),
      'utf-8'
    );
    assert.ok(
      features.includes('CI-time control'),
      'FEATURES.md should note base64-decode is a CI-time control, not a live hook (#2198)'
    );
  });

  test('live hooks inline patterns independently (do not import security.cjs)', () => {
    const hookFiles = [
      'hooks/gsd-prompt-guard.js',
      'hooks/gsd-read-injection-scanner.js',
    ];

    for (const relPath of hookFiles) {
      const fullPath = path.join(PROJECT_ROOT, relPath);
      const source = fs.readFileSync(fullPath, 'utf-8');
      assert.ok(
        // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own bounded hooks/*.js source, not adversarial input
        !source.match(/require\s*\(\s*['"][^'"]*security\.(cjs|js)['"]\s*\)/) &&
        // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own bounded hooks/*.js source, not adversarial input
        !source.match(/import\s+.*from\s+['"][^'"]*security\.(cjs|js)['"]\s*;?/),
        `${relPath} must not require/import security.cjs — hooks inline patterns for independence`
      );
    }
  });
});

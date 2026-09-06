/**
 * Regression test for #2116 — commands/gsd/surface.md had unresolvable bare
 * `require('gsd-core/...')` specifiers and a wrong-package reinstall hint
 * (`npm i -g gsd-core` instead of `@opengsd/gsd-core`).
 *
 * This test asserts the doc uses resolvable paths (derived from runtimeConfigDir)
 * and the correct scoped package name in the reinstall hint.
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SURFACE_MD = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');

describe('#2116 regression: surface.md resolvable require + correct package', () => {
  const content = fs.readFileSync(SURFACE_MD, 'utf-8');

  test('no bare require("gsd-core/...") specifiers', () => {
    assert.ok(
      !content.match(/require\s*\(\s*['"]gsd-core\//),
      'surface.md should not use bare require(\'gsd-core/...\') — use runtimeConfigDir-derived path (#2116)'
    );
  });

  test('reinstall hint uses scoped package name', () => {
    assert.ok(
      content.includes('@opengsd/gsd-core'),
      'surface.md reinstall hint should reference @opengsd/gsd-core, not bare gsd-core (#2116)'
    );
  });

  test('require examples use runtimeConfigDir-derived paths', () => {
    assert.ok(
      content.includes("require(runtimeConfigDir + '/gsd-core/bin/lib/capability-registry.cjs')"),
      'surface.md require examples should derive the path from runtimeConfigDir (#2116)'
    );
  });
});

describe('#4132 regression: surface.md uses the state-last public contract', () => {
  // allow-test-rule: source-text-is-the-product (#4132)
  const content = fs.readFileSync(SURFACE_MD, 'utf-8');

  test('mutations pass an in-memory candidate without an eager state write', () => {
    assert.match(content, /surfaceState/);
    assert.match(content, /publishes the candidate state only after/);
    assert.doesNotMatch(content, /writeSurface\(runtimeConfigDir, surfaceState\)/);
  });

  test('reset is represented as an absent-state candidate, not an eager delete', () => {
    assert.match(content, /surfaceState: null/);
  });
});

'use strict';
/**
 * Tests for runtimeFlags (ADR-1239 Phase B / #1679 AC2). Collapses the four
 * duplicated `const isX = runtime === 'x'` declaration blocks in bin/install.js
 * into one helper. Pins: all flags present, exactly one true per known runtime,
 * claude/unknown/empty → all false, frozen.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runtimeFlags } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const EXPECTED_FLAGS = [
  'isOpencode', 'isKilo', 'isCodex', 'isCopilot', 'isAntigravity',
  'isCursor', 'isWindsurf', 'isAugment', 'isTrae', 'isQwen', 'isHermes',
  'isCodebuddy', 'isCline', 'isKimi', 'isKimiCode', 'isZcode', 'isPi', 'isQoder',
];

// #2103: registry runtimes that are NEVER CLI-installed via bin/install.js
// (Marketplace/VSIX-distributed, no --<rt> flag, not in allRuntimes) — these
// have no runtimeFlags entry by design, not by drift. vscode is the first
// (and, today, only) member: it enters `registry.runtimes` (role:runtime, for
// validator/host-integration coverage) but never enters bin/install.js's
// allRuntimes, so it must not be required to have an isVscode flag here.
const NON_INSTALLABLE_RUNTIMES = new Set(['vscode']);

test('runtimeFlags: every known non-claude runtime sets exactly its own flag true', () => {
  // Convert a flag name (camelCase, e.g. isKimiCode) to the runtime id it
  // represents (kimi-code). Strip the 'is' prefix, then split camelCase
  // boundaries into hyphen-separated lowercase words. The simpler
  // slice(2).toLowerCase() worked while every runtime id was a single word;
  // kimi-code is the first hyphenated id.
  const flagToId = (flag) => flag.slice(2)
    .replace(/[A-Z]/g, (m, i) => (i > 0 ? '-' : '') + m.toLowerCase());
  const idToFlag = (id) => 'is' + id.charAt(0).toUpperCase() + id.slice(1).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (const flag of EXPECTED_FLAGS) {
    const id = flagToId(flag);
    const flags = runtimeFlags(id);
    const trues = EXPECTED_FLAGS.filter((f) => flags[f] === true);
    assert.deepStrictEqual(trues, [idToFlag(id)], `runtime '${id}' must set exactly its own flag`);
  }
});

test('runtimeFlags: claude / unknown / empty → all flags false (fail-closed)', () => {
  for (const id of ['claude', 'unknown', '', 'claude-code']) {
    const flags = runtimeFlags(id);
    for (const f of EXPECTED_FLAGS) {
      assert.strictEqual(flags[f], false, `runtime '${id}': ${f} must be false`);
    }
  }
});

test('runtimeFlags: all 17 flags present + boolean + the object is frozen', () => {
  const flags = runtimeFlags('opencode');
  for (const f of EXPECTED_FLAGS) {
    assert.strictEqual(typeof flags[f], 'boolean', `${f} must be boolean`);
  }
  assert.deepStrictEqual(Object.keys(flags).sort(), [...EXPECTED_FLAGS].sort(), 'exactly the 17 flags');
  assert.ok(Object.isFrozen(flags), 'flags object must be frozen');
});

test('runtimeFlags drift guard: covers every registry runtime except claude and the non-installable set', () => {
  // Adding a registry runtime that is not claude must get a flag or be added to
  // RUNTIME_FLAG_IDS — pin the set so a new runtime forces a deliberate update.
  // NON_INSTALLABLE_RUNTIMES (#2103) is filtered out first: a runtime that is
  // never CLI-installed (e.g. vscode — Marketplace/VSIX only) has no --<rt>
  // flag by design and must not trip this guard.
  //
  // #2454: the flag-name → runtime-id conversion must fold PascalCase boundaries
  // back to kebab-case (isKimiCode → kimi-code, not 'kimicode').
  const flagToId = (flag) => flag.slice(2)
    .replace(/[A-Z]/g, (m, i) => (i > 0 ? '-' : '') + m.toLowerCase());
  const registryNonClaude = Object.keys(registry.runtimes)
    .filter((r) => r !== 'claude' && !NON_INSTALLABLE_RUNTIMES.has(r))
    .sort();
  const flagIds = EXPECTED_FLAGS.map(flagToId).sort();
  const missing = registryNonClaude.filter((r) => !flagIds.includes(r));
  assert.deepEqual(missing, [], `registry runtimes missing a runtimeFlags entry: ${missing.join(', ')} — add to RUNTIME_FLAG_IDS`);
});

test('#2103: vscode is registered but intentionally excluded from runtimeFlags (Marketplace-distributed, never CLI-installed)', () => {
  assert.ok(registry.runtimes.vscode, 'vscode must be present in the registry (role:runtime)');
  assert.ok(NON_INSTALLABLE_RUNTIMES.has('vscode'));
  const flags = runtimeFlags('vscode');
  for (const f of EXPECTED_FLAGS) {
    assert.strictEqual(flags[f], false, `runtime 'vscode': ${f} must be false (no isVscode flag exists)`);
  }
  assert.deepStrictEqual(Object.keys(flags).sort(), [...EXPECTED_FLAGS].sort(),
    'runtimeFlags(\'vscode\') must NOT introduce a new isVscode key — still exactly the 17 flags');
});

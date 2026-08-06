// allow-test-rule: structural-regression-guard — AC2 requires asserting no `runtime === 'hermes'` string-equality branch remains in bin/install.js — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2091)
'use strict';

/**
 * hermes imperative reference host — ADR-1239 Phase D / #2091 (EoS/hermes).
 *
 * Proves hermes is driven through the PUBLIC Host-Integration Interface (the
 * imperative adapter), that its negotiated axes classify + negotiate correctly,
 * that negotiation fails CLOSED on a corrupted descriptor, that the
 * extensionEvents UPGRADE (13 real plugin hook events replacing the borrowed
 * "claude" 6-event surface) is registered, and that the migration retired the
 * hardcoded `runtime === 'hermes'` / `isHermes` branches in bin/install.js
 * (folded into descriptor-driven `runtime.hostBehaviors`).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const {
  profileOf,
  negotiateHostCapabilities,
  extensionEventSurfaceFor,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const HERMES_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'hermes', 'capability.json'), 'utf8'),
);
const HERMES_AXES = HERMES_CAP.runtime.hostIntegration;

// -- AC2: driven through the public interface (imperative adapter) -----------

test('createImperativeAdapter classifies hermes as imperative + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'hermes' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'hermes');
  assert.ok(adapter.registry && typeof adapter.registry === 'object');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('hermes axes classify as the programmatic-cli reference profile', () => {
  assert.equal(profileOf(HERMES_AXES), 'programmatic-cli');
});

// -- AC3: all axes populated + validated -------------------------------------

test('hermes descriptor declares all 8 axes + 6 dispatch sub-axes (no undocumented)', () => {
  assert.equal(HERMES_AXES.embeddingMode, 'imperative');
  assert.equal(HERMES_AXES.commandSurface, 'slash-programmatic');
  assert.equal(HERMES_AXES.modelMode, 'active');
  assert.equal(HERMES_AXES.hookBus, 'host');
  assert.equal(HERMES_AXES.stateIO, 'filesystem');
  assert.equal(HERMES_AXES.transport, 'mcp');
  assert.equal(HERMES_AXES.runtime, 'python');
  const d = HERMES_AXES.dispatch;
  assert.equal(typeof d.namedDispatch, 'boolean');
  assert.equal(typeof d.nested, 'boolean');
  assert.equal(typeof d.maxDepth, 'number');
  assert.equal(typeof d.background, 'boolean');
  assert.ok(['full', 'read-only'].includes(d.subagentToolkit));
  assert.equal(typeof d.backgroundDispatch, 'boolean');
});

// -- AC4a: extensionEvents UPGRADE — 13 real events, not borrowed claude -----

test('hermes descriptor declares extensionEvents: "hermes" (not the borrowed "claude" hookEvents)', () => {
  assert.equal(HERMES_CAP.runtime.extensionEvents, 'hermes',
    'descriptor must declare extensionEvents: "hermes" — the real plugin hook vocabulary');
});

test('extensionEventSurfaceFor("hermes") returns all 13 documented events', () => {
  const surface = extensionEventSurfaceFor('hermes');
  assert.ok(surface, 'hermes extensionEvents surface must be registered');
  const expectedEvents = [
    'pre_tool_call', 'post_tool_call',
    'pre_llm_call', 'post_llm_call',
    'on_session_start', 'on_session_end',
    'on_session_finalize', 'on_session_reset',
    'subagent_start', 'subagent_stop',
    'pre_gateway_dispatch', 'pre_approval_request',
    'transform_tool_result',
  ];
  assert.equal(surface.length, 13, 'exactly 13 documented Hermes plugin events');
  for (const ev of expectedEvents) {
    assert.ok(surface.includes(ev), `surface must include ${ev}`);
  }
});

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for hermes, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...HERMES_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...HERMES_AXES, embeddingMode: 'future-unknown' }));
});

test('a partial/empty hermes descriptor degrades to the safe floor, not the programmatic-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['programmatic-cli']);
  assert.ok(result.warnings.length > 0);
});

// -- AC2: the hardcoded branches are retired ---------------------------------

test('hermes descriptor declares runtime.hostBehaviors (the folded-in behaviors)', () => {
  const hb = HERMES_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.skillFrontmatterVersion, true);
  assert.equal(hb.skillsManifestPrefix, 'skills/gsd/');
  assert.equal(hb.trackCategoryDescription, true);
  assert.equal(hb.writeCategoryDescription, true);
  assert.equal(hb.reportSkillsCount, true);
  assert.equal(hb.legacyCommandsGsdCleanup, true);
  assert.ok(hb.brandingRewrites && typeof hb.brandingRewrites === 'object');
});

test('no `runtime === "hermes"` string-equality branch remains in bin/install.js (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'install.js'), 'utf8');
  const offenders = strip(src).match(/runtime\s*[!=]==\s*'hermes'/g) || [];
  assert.deepEqual(offenders, [], `AC2: no hardcoded runtime==='hermes' branch may remain in bin/install.js; found: ${offenders.join(', ')}`);
});

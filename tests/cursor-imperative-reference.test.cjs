// allow-test-rule: AC2 requires asserting no `runtime === 'cursor'` string-equality branch remains in bin/install.js/src — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2089)
'use strict';

/**
 * cursor imperative reference host — ADR-1239 Phase D / #2089 (EoS/cursor).
 *
 * Proves cursor is driven through the PUBLIC Host-Integration Interface (the
 * imperative adapter), that its negotiated axes classify + negotiate correctly,
 * that negotiation fails CLOSED on a corrupted descriptor, that the Context7-
 * verified dispatch UPGRADE (named/background nested subagents) changes
 * `shouldFlattenDispatch`, and that the migration retired the hardcoded
 * `runtime === 'cursor'` / `isCursor` branches (folded into descriptor-driven
 * `runtime.hostBehaviors`).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const {
  profileOf,
  negotiateHostCapabilities,
  shouldFlattenDispatch,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const CUR_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'cursor', 'capability.json'), 'utf8'),
);
const CUR_AXES = CUR_CAP.runtime.hostIntegration;

// -- AC2: driven through the public interface (imperative adapter) -----------

test('createImperativeAdapter classifies cursor as imperative + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'cursor' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'cursor');
  assert.ok(adapter.registry && typeof adapter.registry === 'object');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('cursor axes classify as the programmatic-cli reference profile', () => {
  assert.equal(profileOf(CUR_AXES), 'programmatic-cli');
});

// -- AC3: all axes populated + validated -------------------------------------

test('cursor descriptor declares all 8 axes + 6 dispatch sub-axes (no undocumented)', () => {
  assert.equal(CUR_AXES.embeddingMode, 'imperative');
  assert.equal(CUR_AXES.commandSurface, 'slash-file');
  assert.equal(CUR_AXES.modelMode, 'passive');
  assert.equal(CUR_AXES.hookBus, 'host');
  assert.equal(CUR_AXES.stateIO, 'filesystem');
  assert.equal(CUR_AXES.transport, 'mcp');
  assert.equal(CUR_AXES.runtime, 'node');
  const d = CUR_AXES.dispatch;
  assert.equal(d.namedDispatch, true);
  assert.equal(d.nested, true);
  assert.equal(d.maxDepth, 2);
  assert.equal(d.background, true);
  assert.equal(d.subagentToolkit, 'full');
  assert.equal(d.backgroundDispatch, true);
});

// -- AC4b: the Context7-verified dispatch UPGRADE (named/background nested) ---

test('cursor descriptor declares background dispatch true/true + nested + maxDepth 2', () => {
  assert.equal(CUR_AXES.dispatch.background, true);
  assert.equal(CUR_AXES.dispatch.backgroundDispatch, true);
  assert.equal(CUR_AXES.dispatch.nested, true);
  assert.equal(CUR_AXES.dispatch.maxDepth, 2, 'cite https://cursor.com/docs/sdk/typescript');
});

test('dispatch UPGRADE changes shouldFlattenDispatch: false now (may background), true for pre-upgrade axes', () => {
  assert.equal(shouldFlattenDispatch(CUR_AXES.dispatch), false,
    'with background:true+backgroundDispatch:true, GSD must NOT force-flatten cursor dispatch');
  const preUpgrade = { ...CUR_AXES.dispatch, background: false, backgroundDispatch: 'undocumented' };
  assert.equal(shouldFlattenDispatch(preUpgrade), true,
    'pre-upgrade (background:false) cursor was force-flattened — this is the behavioral change #2089 lands');
});

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for cursor, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...CUR_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...CUR_AXES, embeddingMode: 'future-unknown' }));
});

test('a partial/empty cursor descriptor degrades to the safe floor, not the programmatic-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['programmatic-cli']);
  assert.ok(result.warnings.length > 0);
});

// -- AC2: the hardcoded branches are retired ---------------------------------

test('cursor descriptor declares runtime.hostBehaviors (the folded-in behaviors)', () => {
  const hb = CUR_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.reapplyCommand, 'gsd-update --reapply (mention the skill name)');
  assert.equal(hb.frontmatterDialect, 'cursor');
  assert.equal(hb.hooksJsonSurface, true);
  assert.equal(hb.skipSharedHooksInstall, true);
  assert.deepEqual(hb.retiredArtifacts, [
    { destSubpath: 'commands', prefix: 'gsd-', suffix: '.md' },
  ]);
  assert.equal(hb.reportCommandsDir, undefined,
    'Cursor no longer installs a parallel commands/ surface (#2644)');
  assert.ok(Array.isArray(hb.managedHookEvents) && hb.managedHookEvents.length >= 6,
    'managedHookEvents must list at least 6 events (AC4a)');
});

test('no `runtime === "cursor"` string-equality branch remains in the install source (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  for (const rel of ['bin/install.js', 'src/install-engine.cts', 'src/runtime-artifact-conversion.cts', 'src/runtime-hooks-surface.cts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const offenders = strip(src).match(/runtime\s*[!=]==\s*'cursor'/g) || [];
    assert.deepEqual(offenders, [], `AC2: no hardcoded runtime==='cursor' branch may remain in ${rel}; found: ${offenders.join(', ')}`);
  }
});

// allow-test-rule: AC2 requires asserting no `runtime === 'opencode'` string-equality branch remains in bin/install.js/src — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2087)
'use strict';

/**
 * opencode imperative reference host — ADR-1239 Phase D / #2087 (EoS/opencode).
 *
 * Proves opencode is driven through the PUBLIC Host-Integration Interface (the
 * imperative adapter), that its negotiated axes classify + negotiate correctly,
 * that negotiation fails CLOSED on a corrupted descriptor, that opencode's
 * SYNCHRONOUS dispatch force-flattens (#2598 retracts #2087's background
 * "upgrade" — the capability is behind an opt-in flag, not default-on), and that
 * the migration retired the hardcoded
 * `runtime === 'opencode'` / `isOpencode` branches (folded into descriptor-driven
 * `runtime.hostBehaviors` + the combined-family engine install path).
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
  extensionEventSurfaceFor,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const OC_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'opencode', 'capability.json'), 'utf8'),
);
const OC_AXES = OC_CAP.runtime.hostIntegration;

// -- AC2: driven through the public interface (imperative adapter) -----------

test('createImperativeAdapter classifies opencode as imperative + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'opencode' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'opencode');
  assert.ok(adapter.registry && typeof adapter.registry === 'object');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('opencode axes classify as the programmatic-cli reference profile', () => {
  assert.equal(profileOf(OC_AXES), 'programmatic-cli');
});

// -- AC4: dispatch is synchronous — the #2087 "upgrade" is retracted (#2598) --

test('opencode descriptor declares background dispatch false/false (#2598)', () => {
  // #2087 set these true, reading OpenCode v1.15/v1.17 as "background subagents
  // enabled by default in all modes". That reading does not hold against current
  // upstream `dev`, where the capability is opt-in:
  //   experimentalBackgroundSubagents: enabledByExperimental("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS")
  // `enabledByExperimental` falls back to the `experimental` flag and `bool()`
  // defaults false, so the Task tool's `background` parameter is hidden from the
  // model unless an operator opts in. Upstream #29638 (OPEN) confirms the session
  // loop still `tasks.pop()`s one subtask at a time.
  assert.equal(OC_AXES.dispatch.background, false,
    'background subagents are behind an opt-in experimental flag, not default-on');
  assert.equal(OC_AXES.dispatch.backgroundDispatch, false,
    'concurrent dispatch cannot be relied on, so it must not be declared');
});

test('synchronous dispatch force-flattens; the retracted axes would not have', () => {
  // Declaring a capability the host lacks is the failure mode #2598 closes:
  // negotiation is built to fail CLOSED, so an unavailable concurrency
  // capability must serialize rather than be trusted.
  assert.equal(shouldFlattenDispatch(OC_AXES.dispatch), true,
    'with background:false, GSD must force-flatten opencode dispatch (fail closed)');
  // Pin the retracted contract so a silent re-flip is caught: had the #2087
  // values been accurate, dispatch would NOT have been flattened.
  const retracted = { ...OC_AXES.dispatch, background: true, backgroundDispatch: true };
  assert.equal(shouldFlattenDispatch(retracted), false,
    'the #2087 axes did not flatten — that is exactly the overstatement #2598 retracts');
});

test('opencode extension-event surface includes the #2087 additions (permission + session.error)', () => {
  const surface = extensionEventSurfaceFor('opencode');
  assert.ok(surface, 'opencode is a consumed extensionEvents dialect');
  for (const ev of ['permission.asked', 'permission.replied', 'session.error']) {
    assert.ok(surface.includes(ev), `#2087 adds ${ev} to the opencode extension-event surface`);
  }
  // The engine still owns phase sequencing — no workflow-phase events on the bus.
  assert.ok(!surface.some((e) => /plan:|verify:|ship:/.test(e)));
});

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for opencode, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...OC_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...OC_AXES, embeddingMode: 'future-unknown' }));
});

test('a partial/empty opencode descriptor degrades to the safe floor, not the programmatic-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['programmatic-cli']);
  assert.ok(result.warnings.length > 0);
});

// -- AC2: the hardcoded branches are retired ---------------------------------

test('opencode descriptor declares runtime.hostBehaviors (the folded-in behaviors)', () => {
  const hb = OC_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.combinedFamilyInstall, true, 'commands+skills+plugin install runs through the engine (adapter)');
  assert.equal(hb.reapplyCommand, '/gsd-update --reapply');
  assert.equal(hb.attributionConfigResolver, 'opencode');
  // #2329: OpenCode discovers commands from the PLURAL `commands/` dir; the
  // singular `command/` made all /gsd-* commands invisible to OpenCode.
  assert.equal(hb.flatCommandDir, 'commands');
  assert.equal(hb.frontmatterDialect, 'opencode');
  assert.equal(hb.skipHomePrefixSubstitution, true);
  assert.equal(hb.skipSettingsUi, true);
  assert.equal(hb.skipUpdateBannerCommand, true);
  assert.equal(hb.skipCodexSkillsManifest, true);
  assert.equal(hb.nativePlugin.file, 'gsd-core.js');
  assert.equal(hb.nativePlugin.source, '.opencode/plugins/gsd-core.js');
});

test('no `runtime === "opencode"` string-equality branch remains in the install source (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  for (const rel of ['bin/install.js', 'src/install-engine.cts', 'src/runtime-artifact-conversion.cts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const offenders = strip(src).match(/runtime\s*[!=]==\s*'opencode'/g) || [];
    assert.deepEqual(offenders, [], `AC2: no hardcoded runtime==='opencode' branch may remain in ${rel}; found: ${offenders.join(', ')}`);
  }
});

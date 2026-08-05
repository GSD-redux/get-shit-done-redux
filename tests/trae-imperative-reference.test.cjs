// allow-test-rule: structural-regression-guard — AC2 requires asserting no `runtime === 'trae'` string-equality branch remains in bin/install.js, src/install-engine.cts, and src/runtime-artifact-conversion.cts — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2094)
'use strict';

/**
 * trae imperative reference host — ADR-1239 Phase D / #2094 (EoS/trae).
 *
 * Proves Trae IDE is driven through the PUBLIC Host-Integration Interface
 * (the imperative adapter), that its negotiated axes classify + negotiate
 * correctly, that negotiation fails CLOSED on a corrupted descriptor, and
 * that the migration retired the hardcoded `runtime === 'trae'` string-
 * equality branches across the install engine and artifact conversion
 * modules (folded into descriptor-driven `runtime.hostBehaviors`).
 *
 * Trae has NO hook surface at all (`hooksSurface: "none"`,
 * `extendedHookEvents: []`, `installSurface: "profile-marker-only"`) — its
 * `hookBus` axis is `'engine'` (VSCode-fork extension-host lifecycle, not a
 * GSD-managed hook dialect), so unlike qwen/kilo this file does not assert an
 * extendedHookEvents surface. Four of Trae's six dispatch sub-axes
 * (`nested`, `maxDepth`, `subagentToolkit`, `backgroundDispatch`) are
 * `'undocumented'` — no authoritative Trae doc states them — which is what
 * drives the fail-closed `shouldFlattenDispatch` assertion below. The real
 * upgrade (SOLO stage/trigger metadata on emitted skills) is covered in
 * tests/trae-upgrades.test.cjs.
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

const TRAE_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'trae', 'capability.json'), 'utf8'),
);
const TRAE_AXES = TRAE_CAP.runtime.hostIntegration;

// -- AC2: driven through the public interface (imperative adapter) -----------

test('createImperativeAdapter classifies trae as imperative + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'trae' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'trae');
  assert.ok(adapter.registry && typeof adapter.registry === 'object');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('trae axes classify as the programmatic-cli reference profile', () => {
  // Confirmed via `node -e` against the real descriptor before asserting:
  // profileOf(TRAE_AXES) === 'programmatic-cli' (embeddingMode: 'imperative').
  assert.equal(profileOf(TRAE_AXES), 'programmatic-cli');
});

// -- AC3: all axes populated + validated -------------------------------------

test('trae descriptor declares all 8 axes + 6 dispatch sub-axes with exact values', () => {
  assert.equal(TRAE_AXES.embeddingMode, 'imperative');
  assert.equal(TRAE_AXES.commandSurface, 'slash-file');
  assert.equal(TRAE_AXES.modelMode, 'passive');
  assert.equal(TRAE_AXES.hookBus, 'engine');
  assert.equal(TRAE_AXES.stateIO, 'filesystem');
  assert.equal(TRAE_AXES.transport, 'mcp');
  assert.equal(TRAE_AXES.runtime, 'node');
  const d = TRAE_AXES.dispatch;
  assert.equal(d.namedDispatch, true);
  assert.equal(d.nested, 'undocumented');
  assert.equal(d.maxDepth, 'undocumented');
  assert.equal(d.background, true);
  assert.equal(d.subagentToolkit, 'undocumented');
  assert.equal(d.backgroundDispatch, 'undocumented');
});

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for trae, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...TRAE_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...TRAE_AXES, embeddingMode: 'future-unknown' }));
});

test('AC-SPECIFIC: trae real dispatch axes fail CLOSED to inline (shouldFlattenDispatch === true)', () => {
  // Confirmed via `node -e` against the real descriptor before asserting:
  // shouldFlattenDispatch(TRAE_AXES.dispatch) === true.
  //
  // shouldFlattenDispatch only permits backgrounding when BOTH `background`
  // AND `backgroundDispatch` are explicitly `true` (src/host-integration.cts
  // shouldFlattenDispatch, `canBackground = background === true &&
  // backgroundDispatch === true`). Trae's `background` is `true` but
  // `backgroundDispatch` is `'undocumented'` (no authoritative Trae doc states
  // whether a spawned agent can itself be backgrounded) — so canBackground is
  // false and the orchestrator must run inline. Pinned here so a future
  // doc-sourcing pass that fills in `backgroundDispatch` can't silently flip
  // this fail-closed default without a deliberate test update.
  assert.equal(shouldFlattenDispatch(TRAE_AXES.dispatch), true);

  // #2939: flipping ONLY backgroundDispatch to true is NO LONGER sufficient to
  // background. trae's axes declare nested:'undocumented' (not true) and
  // subagentToolkit:'undocumented' (not 'full'), so even with backgroundDispatch
  // true the depth/nesting gate (canNest) fails closed to flatten. A future
  // doc-sourcing pass must also establish nested:true + subagentToolkit:'full' +
  // a sufficient maxDepth before trae may background.
  assert.equal(shouldFlattenDispatch({ ...TRAE_AXES.dispatch, backgroundDispatch: true }), true);
});

test('a partial/empty trae descriptor degrades to the safe floor, not the programmatic-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['programmatic-cli']);
  assert.ok(result.warnings.length > 0);
});

// -- AC2: the folded-in behaviors ---------------------------------------------

test('trae descriptor declares runtime.hostBehaviors (the folded-in behaviors)', () => {
  const hb = TRAE_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.skipSharedHooksInstall, true);
  assert.equal(hb.soloStageMetadata, 'workflow');
});

// -- AC2: the hardcoded branches are retired across all folded modules -------

test('no `runtime === "trae"` string-equality branch remains in the descriptor-migrated modules (AC2)', () => {
  // NOTE: this deliberately does NOT grep for `isTrae` — `isTrae` legitimately
  // remains in bin/install.js as a destructured `runtimeFlags(runtime)`
  // binding used ONLY by the agents-converter dispatch chain (`else if
  // (isTrae) { content = convertClaudeAgentToTraeAgent(content); }`). That
  // cross-runtime agents-converter dispatch is out of scope for #2094 (a
  // separate migration tracked elsewhere) — trae stays in RUNTIME_FLAG_IDS by
  // design until that follow-up lands. Only a `runtime === 'trae'` /
  // `runtime !== 'trae'` STRING-EQUALITY comparison is a regression here.
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  const repoRoot = path.join(__dirname, '..');
  const files = [
    path.join(repoRoot, 'bin', 'install.js'),
    path.join(repoRoot, 'src', 'install-engine.cts'),
    path.join(repoRoot, 'src', 'runtime-artifact-conversion.cts'),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const offenders = strip(src).match(/runtime\s*[!=]==\s*'trae'/g) || [];
    assert.deepEqual(offenders, [],
      `AC2: no hardcoded runtime==='trae' branch may remain in ${path.relative(repoRoot, file)}; found: ${offenders.join(', ')}`);
  }
});

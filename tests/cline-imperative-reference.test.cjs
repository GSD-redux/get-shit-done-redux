// allow-test-rule: structural-regression-guard — AC2 requires asserting no `runtime === 'cline'` string-equality branch remains in bin/install.js/src — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2090)
'use strict';

/**
 * cline imperative reference host — ADR-1239 Phase D / #2090 (EoS/cline).
 *
 * Proves cline is driven through the PUBLIC Host-Integration Interface (the
 * imperative adapter), that its negotiated axes classify + negotiate correctly,
 * that negotiation fails CLOSED on a corrupted descriptor, that the
 * Context7-sourced dispatch classification STAYS degraded/flat (cline subagents
 * are documented as single-level read-only — maxDepth:1 — and must never be
 * silently upgraded to full nested/background dispatch), and that the migration
 * retired the hardcoded `runtime === 'cline'` / `isCline` branches (folded into
 * descriptor-driven `runtime.hostBehaviors`).
 *
 * Contrast with cursor (#2089): cursor's dispatch got an UPGRADE (background +
 * nested). cline's dispatch is a deliberate DEGRADATION that must be preserved —
 * upgrading it would misrepresent a documented host restriction and violate the
 * fail-closed negotiation contract (see dispatch-degradation test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const {
  profileOf,
  negotiateHostCapabilities,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const CLN_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'cline', 'capability.json'), 'utf8'),
);
const CLN_AXES = CLN_CAP.runtime.hostIntegration;

// -- AC2: driven through the public interface (imperative adapter) -----------

test('createImperativeAdapter classifies cline as imperative + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'cline' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'cline');
  assert.ok(adapter.registry && typeof adapter.registry === 'object');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('cline axes classify as the programmatic-cli reference profile (imperative embedding)', () => {
  assert.equal(profileOf(CLN_AXES), 'programmatic-cli');
});

// -- AC3: all axes populated + validated -------------------------------------

test('cline descriptor declares all 8 axes + 6 dispatch sub-axes (no undocumented)', () => {
  assert.equal(CLN_AXES.embeddingMode, 'imperative');
  assert.equal(CLN_AXES.commandSurface, 'slash-file');
  assert.equal(CLN_AXES.modelMode, 'active');
  assert.equal(CLN_AXES.hookBus, 'host');
  assert.equal(CLN_AXES.stateIO, 'filesystem');
  assert.equal(CLN_AXES.transport, 'mcp');
  assert.equal(CLN_AXES.runtime, 'node');
  const d = CLN_AXES.dispatch;
  assert.equal(d.namedDispatch, true);
  assert.equal(d.nested, false);
  assert.equal(d.maxDepth, 1);
  assert.equal(d.background, true);
  assert.equal(d.subagentToolkit, 'read-only');
  assert.equal(d.backgroundDispatch, false);
});

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for cline, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...CLN_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...CLN_AXES, embeddingMode: 'future-unknown' }));
});

test('a partial/empty cline descriptor degrades to the safe floor, not the programmatic-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['programmatic-cli']);
  assert.ok(result.warnings.length > 0);
});

// -- AC2: the hardcoded branches are retired ---------------------------------

test('cline descriptor declares runtime.hostBehaviors (the folded-in behaviors)', () => {
  const hb = CLN_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.reapplyCommand, '/gsd-update --reapply');
  assert.equal(hb.frontmatterDialect, 'cline');
  assert.equal(hb.skipSharedHooksInstall, true);
  assert.equal(hb.localTargetIsProjectRoot, true);
  assert.equal(hb.clineRulesSurface, true);
  assert.equal(hb.localCommandsViaRules, true);
});

test('no `runtime === "cline"` string-equality branch remains in the install source (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  for (const rel of ['bin/install.js', 'src/install-engine.cts', 'src/runtime-artifact-conversion.cts', 'src/runtime-hooks-surface.cts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const offenders = strip(src).match(/runtime\s*[!=]==\s*'cline'/g) || [];
    assert.deepEqual(offenders, [], `AC2: no hardcoded runtime==='cline' branch may remain in ${rel}; found: ${offenders.join(', ')}`);
  }
});

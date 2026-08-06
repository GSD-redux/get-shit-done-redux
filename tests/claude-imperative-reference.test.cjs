// allow-test-rule: structural-regression-guard — AC2 requires asserting no `runtime === 'claude'` string-equality branch remains in bin/install.js — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2086)
'use strict';

/**
 * claude imperative reference host — ADR-1239 Phase D / #2086 (EoS/claude).
 *
 * claude is GSD's tier-1 reference host — "golden parity vs. the Claude reference
 * host" (ADR-1239 line 146). This proves claude is driven through the PUBLIC
 * Host-Integration Interface (the imperative adapter), that its negotiated axes
 * classify + negotiate correctly, that negotiation FAILS CLOSED on a corrupted
 * descriptor, and that the migration retired the hardcoded `runtime === 'claude'`
 * string-equality branches in bin/install.js (folded into descriptor-driven
 * `runtime.hostBehaviors`).
 *
 * Mirrors tests/pi-imperative-reference.test.cjs + tests/vscode-ide-reference.test.cjs
 * but binds against the REAL descriptor + the REAL installer source, since claude
 * (unlike pi/vscode) has a real production install being folded in.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const {
  profileOf,
  negotiateHostCapabilities,
  PROTOCOL_VERSION,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const CLAUDE_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'claude', 'capability.json'), 'utf8'),
);
const CLAUDE_AXES = CLAUDE_CAP.runtime.hostIntegration;

// Requiring the installer (not as main) never runs the CLI; GSD_TEST_MODE is set
// defensively to match the install-test convention.
process.env.GSD_TEST_MODE = process.env.GSD_TEST_MODE || '1';
const installMod = require('../bin/install.js');

// -- AC2: driven through the public interface (imperative adapter) -----------

test('createImperativeAdapter classifies claude as imperative + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'claude' });
  assert.equal(adapter.kind, 'imperative', "claude embeddingMode is imperative -> adapter kind must be 'imperative'");
  assert.equal(adapter.runtime, 'claude');
  assert.ok(adapter.registry && typeof adapter.registry === 'object', 'imperative adapter exposes the composed capability registry');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('claude descriptor embeddingMode agrees with the imperative adapter kind', () => {
  assert.equal(CLAUDE_AXES.embeddingMode, 'imperative', 'capability.json must declare embeddingMode: imperative for the imperative binding');
});

test('claude axes classify as the programmatic-cli reference profile', () => {
  assert.equal(profileOf(CLAUDE_AXES), 'programmatic-cli');
  assert.notEqual(profileOf(CLAUDE_AXES), 'ide');
});

// -- AC3: every negotiated axis populated, negotiation is clean ---------------

test('claude negotiates its declared axes verbatim (no degradation of documented values)', () => {
  const result = negotiateHostCapabilities({ ...CLAUDE_AXES, protocolVersion: PROTOCOL_VERSION });
  assert.equal(result.protocolVersion, PROTOCOL_VERSION);
  // Every declared scalar axis survives negotiation unchanged (all are known+documented).
  assert.equal(result.effective.embeddingMode, 'imperative');
  assert.equal(result.effective.commandSurface, CLAUDE_AXES.commandSurface);
  assert.equal(result.effective.modelMode, CLAUDE_AXES.modelMode);
  assert.equal(result.effective.hookBus, CLAUDE_AXES.hookBus);
  assert.equal(result.effective.stateIO, CLAUDE_AXES.stateIO);
  assert.equal(result.effective.transport, CLAUDE_AXES.transport);
  assert.equal(result.effective.runtime, CLAUDE_AXES.runtime);
  // No `undocumented` sentinel anywhere in claude's declared axes.
  assert.ok(
    !JSON.stringify(CLAUDE_AXES).includes(UNDOCUMENTED),
    'claude descriptor must carry no `undocumented` sentinel (fully doc-sourced)',
  );
});

// -- AC5: negotiation fails CLOSED on a corrupted / partial descriptor --------

test('negotiateHostCapabilities never throws for claude — even fully corrupted input', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ embeddingMode: 'wildly-unknown-future-value' }));
});

test('a partial/empty claude descriptor degrades to the safe floor — NOT the full programmatic-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  // Fail-closed floor (SAFE_DEFAULTS), not the rich profile baseline.
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed to declarative');
  assert.equal(result.effective.hookBus, 'none', 'omitted hookBus degrades closed to none');
  assert.equal(result.effective.commandSurface, 'prose-only', 'omitted commandSurface degrades closed to prose-only');
  assert.equal(result.effective.dispatch.namedDispatch, false, 'omitted dispatch degrades closed (no named dispatch)');
  assert.notDeepEqual(
    result.effective,
    PROFILE_BASELINES['programmatic-cli'],
    'a corrupted descriptor MUST NOT silently reuse the full programmatic-cli baseline',
  );
  assert.ok(result.warnings.length > 0, 'degrade-closed must surface warnings');
});

test('an undocumented/unknown claude axis value is not trusted (degraded closed per-axis)', () => {
  const corrupted = { ...CLAUDE_AXES, embeddingMode: UNDOCUMENTED, hookBus: 'unknown-bus-kind' };
  const result = negotiateHostCapabilities(corrupted);
  assert.equal(result.effective.embeddingMode, 'declarative', 'undocumented embeddingMode -> safe floor');
  assert.equal(result.effective.hookBus, 'none', 'unknown hookBus value -> safe floor');
  // Untouched axes still negotiate to their declared (documented) values.
  assert.equal(result.effective.stateIO, CLAUDE_AXES.stateIO);
});

// -- AC2: the hardcoded string-equality branches are retired ------------------

test('claude descriptor declares runtime.hostBehaviors (the folded-in host behaviors)', () => {
  const hb = CLAUDE_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object', 'capabilities/claude/capability.json must declare runtime.hostBehaviors');
  // The behaviors that replaced the 13 `runtime === 'claude'` branches.
  assert.equal(hb.permissionsSchema, 'claude');
  assert.equal(hb.localInstallStyle, 'legacy-flat');
  assert.equal(hb.sourceMarkerFile, '.gsd-source');
  assert.equal(hb.authorsCanonicalWorkflow, true);
  assert.equal(hb.ownsClaudePaths, true);
  assert.equal(hb.nativeModelAliases, true);
  assert.equal(hb.skillsGlobalOnboarding, true);
  assert.equal(hb.attributionSource, 'settings-json-commit');
  assert.deepEqual(hb.agentFrontmatterExtensions, ['effort']);
  assert.equal(hb.settingsFileByScope.local, 'settings.local.json');
  assert.equal(hb.settingsFileByScope.global, 'settings.json');
});

test('bin/install.js contains no `runtime === "claude"` / `runtime !== "claude"` string-equality branches (AC2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'install.js'), 'utf8');
  // Strip comments + backtick/inline-code spans so PROSE mentions of the old
  // pattern (a comment explaining "not a string-equality branch") do not
  // false-positive — only LIVE code counts.
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\/\/[^\r\n]*/g, '')        // line comments (CRLF-safe)
    .replace(/`[^`]*`/g, '');            // backtick / inline-code spans
  const offenders = codeOnly.match(/runtime\s*[!=]==\s*'claude'/g) || [];
  assert.deepEqual(
    offenders,
    [],
    `AC2: every hardcoded runtime==='claude'/!=='claude' branch must be descriptor-driven; found: ${offenders.join(', ')}`,
  );
});

// -- Reviewer #2106 (elevated): #338 privacy fail-safe on registry-load failure --
// If the first-party capability registry fails to load, `_hostBehaviors('claude')`
// would return {} and route a claude LOCAL install to the repo-shared settings.json
// instead of the gitignored settings.local.json — silently reintroducing #338. The
// reference host must degrade CLOSED (safe) for its privacy-critical keys.

test('claude #338-critical host behaviors degrade CLOSED when the capability registry cannot load', () => {
  // Simulate a broken bundle: registry is undefined.
  const degraded = installMod._resolveHostBehaviors('claude', undefined);
  assert.equal(degraded.settingsFileByScope.local, 'settings.local.json',
    '#338: a claude LOCAL install must still route to the gitignored settings.local.json');
  assert.equal(degraded.settingsFileByScope.global, 'settings.json');
  assert.equal(degraded.permissionsSchema, 'claude', 'permission cleanup/merge must still apply');
  assert.equal(degraded.sourceMarkerFile, '.gsd-source');
});

test('with the registry present, claude host behaviors come from the live descriptor (superset of the fail-safe floor)', () => {
  const reg = require('../gsd-core/bin/lib/capability-registry.cjs');
  const declared = installMod._resolveHostBehaviors('claude', reg);
  assert.equal(declared.settingsFileByScope.local, 'settings.local.json');
  assert.equal(declared.localInstallStyle, 'legacy-flat');
  assert.equal(declared.authorsCanonicalWorkflow, true);
  // The fail-safe floor is a strict subset of what the descriptor declares.
  for (const k of Object.keys(installMod.FALLBACK_HOST_BEHAVIORS.claude)) {
    assert.ok(k in declared, `descriptor must still declare the #338-critical key '${k}'`);
  }
});

test('a non-reference runtime has no fail-safe fallback (degrades to the generic path)', () => {
  assert.deepEqual(installMod._resolveHostBehaviors('opencode', undefined), {});
  assert.deepEqual(installMod._resolveHostBehaviors('codex', undefined), {});
});

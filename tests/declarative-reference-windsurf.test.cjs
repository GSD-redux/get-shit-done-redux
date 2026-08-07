// allow-test-rule: structural-regression-guard — AC2: assert no `runtime === 'windsurf'` string-equality branch, no live `isWindsurf` read remains in bin/install.js, src/install-engine.cts, src/surface.cts, or src/runtime-artifact-conversion.cts — a source-text property, so source-grep is the faithful check (#2100)
'use strict';

/**
 * Declarative reference host — Windsurf (#2100 / ADR-1239 EoS).
 *
 * STAGE 1 (folds): Windsurf already installs through the descriptor-driven
 * artifactLayout (agents/commands, each with a named `converter`), and its
 * capability.json already declares `hostIntegration` + `hostBehaviors` axes
 * (skipSharedHooksInstall, legacyDevinSkillsCleanup,
 * installsCommandBodiesForWorkflowDelegation, verificationStyle). Every
 * former `isWindsurf` branch in bin/install.js was folded onto those
 * descriptor axes (see the `#2100: isWindsurf dropped` comments left at the
 * fold sites).
 *
 * STAGE 2 (this file's focus, HOOK-BRIDGE): Windsurf's `hooksSurface` moved
 * from `"none"` to `"windsurf-hooks-json"` — GSD's write/command safety
 * guards are now wired into Cascade's native `.windsurf/hooks.json` /
 * `~/.codeium/windsurf/hooks.json` hook bus via `writeWindsurfHooksJson`
 * (mirrors `writeCursorHooksJson`'s infra shape, but Cascade blocks via EXIT
 * CODE 2 + stderr, not Cursor's stdout-JSON `{block,reason}` form). Only 2 of
 * Cascade's documented hook events (pre_write_code, pre_run_command) have a
 * blocking counterpart wired — Cascade has no context-injection channel, so
 * the 4 advisory events GSD registers on Cursor have no Windsurf analog.
 * Hook-bus mechanics (writer/reconcile/remove + the 2 guard scripts spawned
 * directly) are covered in tests/windsurf-hooks-bridge.test.cjs — not
 * duplicated here.
 *
 * This test is the reference-host dogfood mirroring
 * tests/declarative-reference-copilot.test.cjs: it (1) classifies Windsurf's
 * profile via profileOf, (2) confirms the public declarative adapter
 * classifies it as declarative, (3) round-trips a real install proving a
 * gsd agent surface is emitted, (4) proves negotiation fails CLOSED on a
 * corrupted descriptor, (5) proves the validator accepts the descriptor,
 * (6) asserts the new hooksSurface value + GATE A membership, and (7)
 * source-greps the folded modules for the retired `isWindsurf` branches (AC2).
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const {
  profileOf,
  negotiateHostCapabilities,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');
const { validateCapability } = require('../gsd-core/bin/lib/capability-validator.cjs');
const { createDeclarativeAdapter } = require('../gsd-core/bin/lib/adapter-declarative.cjs');
const {
  resolveRuntimeConfigIntent,
  resolveInstallPlan,
} = require('../gsd-core/bin/lib/runtime-config-adapter-registry.cjs');
const { cleanup } = require('./helpers.cjs');
const { walk, runMinimalInstall, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');

const DESC = path.join(__dirname, '..', 'capabilities', 'windsurf', 'capability.json');
const WINDSURF_CAP = JSON.parse(fs.readFileSync(DESC, 'utf8'));
const WINDSURF_AXES = WINDSURF_CAP.runtime.hostIntegration;

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { BUILD_TIMEOUT_MS: BUILD_HOOKS_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// hooks/dist is gitignored and built (mirrors golden-install-parity harness).
before(() => {
  const r = runNode([BUILD_SCRIPT], { timeoutMs: BUILD_HOOKS_TIMEOUT_MS });
  throwIfFailed(r, `node ${BUILD_SCRIPT}`);
});

test('Windsurf classifies as the declarative-cli reference profile (profileOf)', () => {
  const desc = JSON.parse(fs.readFileSync(DESC, 'utf8'));
  const axes = desc.runtime.hostIntegration;
  assert.ok(axes && axes.embeddingMode, 'windsurf descriptor declares hostIntegration axes');
  assert.equal(profileOf(axes), 'declarative-cli', 'Windsurf is a Declarative-CLI host');
});

test('the public declarative adapter classifies Windsurf as a declarative host', () => {
  const adapter = createDeclarativeAdapter({ runtime: 'windsurf' });
  assert.equal(adapter.kind, 'declarative');
  assert.equal(adapter.runtime, 'windsurf');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('a real Windsurf install emits a gsd agent surface (invocable)', () => {
  const { configDir, root } = runMinimalInstall({ runtime: 'windsurf', scope: 'global' });
  try {
    const files = walk(configDir);
    assert.ok(files.length > 0, 'install must emit artifacts');
    const gsdSurface = files.filter((f) => /gsd/i.test(path.relative(configDir, f)));
    assert.ok(gsdSurface.length > 0, 'install must emit a gsd agent surface (declarative reference)');
    const agentsDir = path.join(configDir, 'agents');
    assert.ok(fs.existsSync(agentsDir), 'agents/ directory must exist');
    const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(agentFiles.length > 0, 'agents/ must contain gsd-*.md files');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// #2100 EoS/windsurf — fail-closed negotiation + validator acceptance +
// the folded descriptor (mirrors codebuddy/antigravity/qwen/copilot reference tests).
// ---------------------------------------------------------------------------

test('negotiateHostCapabilities never throws for windsurf, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...WINDSURF_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...WINDSURF_AXES, embeddingMode: 'future-unknown' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...WINDSURF_AXES, dispatch: 'corrupted-not-an-object' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...WINDSURF_AXES, dispatch: { ...WINDSURF_AXES.dispatch, maxDepth: 'not-a-number' } }));
});

test('a partial/empty windsurf descriptor degrades to the safe floor, not the declarative-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['declarative-cli']);
  assert.ok(result.warnings.length > 0);
});

test('capabilities/windsurf/capability.json validates — no errors', () => {
  const errors = validateCapability(WINDSURF_CAP, 'windsurf');
  assert.deepEqual(errors, [], `validateCapability must return no errors, got: ${JSON.stringify(errors)}`);
});

// ---------------------------------------------------------------------------
// #2100 Stage 2 — hooksSurface moved from 'none' to 'windsurf-hooks-json'
// ---------------------------------------------------------------------------

test('windsurf descriptor declares hooksSurface: windsurf-hooks-json', () => {
  assert.equal(WINDSURF_CAP.runtime.hooksSurface, 'windsurf-hooks-json');
});

test('windsurf installSurface stays profile-marker-only (unchanged by Stage 2)', () => {
  const intent = resolveRuntimeConfigIntent('windsurf');
  assert.equal(intent.installSurface, 'profile-marker-only');
  assert.equal(intent.writesSharedSettings, false);
  assert.equal(intent.finishPermissionWriter, null);
});

test('resolveInstallPlan(windsurf).hooksSurface is windsurf-hooks-json', () => {
  const plan = resolveInstallPlan('windsurf');
  assert.equal(plan.hooksSurface, 'windsurf-hooks-json');
  assert.equal(plan.installSurface, 'profile-marker-only');
});

// -- AC2: the hardcoded branches are retired across all folded modules ------

test('no `runtime === "windsurf"` string-equality branch (nor live `isWindsurf` read) remains in bin/install.js, src/install-engine.cts, src/surface.cts, or src/runtime-artifact-conversion.cts (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  const repoRoot = path.join(__dirname, '..');
  const files = [
    path.join(repoRoot, 'bin', 'install.js'),
    path.join(repoRoot, 'src', 'install-engine.cts'),
    path.join(repoRoot, 'src', 'surface.cts'),
    path.join(repoRoot, 'src', 'runtime-artifact-conversion.cts'),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const stripped = strip(src);

    const eqOffenders = stripped.match(/runtime\s*[!=]==\s*["']windsurf["']/g) || [];
    assert.deepEqual(eqOffenders, [],
      `AC2: no hardcoded runtime==='windsurf' branch may remain in ${path.relative(repoRoot, file)}; found: ${eqOffenders.join(', ')}`);

    // Excludes legit enumeration sites: --windsurf CLI flag parsing, numbered-menu
    // maps, allRuntimes/_DESCRIPTOR_AGENTS_RUNTIMES set literals, config-dir
    // lists, the windsurf conversion FUNCTION names (convertClaudeAgentToWindsurfAgent
    // / convertClaudeCommandToWindsurfWorkflow), and hooksSurface==='windsurf-hooks-json'
    // / installSurface==='profile-marker-only' (descriptor-field strings, not
    // runtime literals) — none of those contain the token `isWindsurf`, so a
    // literal-word match is precise here.
    const isWindsurfHits = stripped.match(/\bisWindsurf\b/g) || [];
    assert.deepEqual(isWindsurfHits, [],
      `AC2: no live isWindsurf read may remain in ${path.relative(repoRoot, file)}; found ${isWindsurfHits.length} occurrence(s)`);
  }
});

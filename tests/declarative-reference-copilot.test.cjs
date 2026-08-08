// allow-test-rule: structural-regression-guard — AC2: assert no `runtime === 'copilot'` string-equality branch, no live `isCopilot` read remains in bin/install.js, src/install-engine.cts, src/surface.cts, or src/runtime-artifact-conversion.cts — a source-text property, so source-grep is the faithful check (#2099, expanded #2103)
'use strict';

/**
 * Declarative reference host — GitHub Copilot (#2099 / ADR-1239 EoS).
 *
 * Copilot already installs through the descriptor-driven artifactLayout
 * (skills/agents, each with a named `converter`), and its capability.json
 * already declares `hostIntegration` + `dispatch` axes. Issue #2099's
 * literal premises about a "legacy exclusion list" / writesSharedSettings
 * mismatch and a hardcoded RUNTIME_CONTENT_DISPATCH branch were WRONG (see
 * the deep-research writeup on the issue) — this migration instead folds
 * the real residual `isCopilot` branches:
 *   1. src/install-engine.cts's `.agent.md` destination-suffix rename —
 *      folded onto `hostBehaviors.agentFileExtension`.
 *   2. bin/install.js uninstall's two Copilot side-effect branches
 *      (repo-root AGENTS.md cleanup + copilot-instructions.md/hook
 *      cleanup) — folded onto `resolveInstallPlan(runtime).installSurface
 *      === 'copilot-instructions'` (unique to copilot, so byte-parity).
 *   3. bin/install.js's two `skipSharedHooksInstall` checks — folded onto
 *      `hostBehaviors.skipSharedHooksInstall:true` (copilot's golden has
 *      only hooks/gsd-session.json, no shared gsd-*.js scripts).
 *   4. bin/install.js's dead legacy agent-converter dispatch arm in the
 *      inline agent-copy loop — unreachable because copilot is a member of
 *      `_DESCRIPTOR_AGENTS_RUNTIMES` (installRuntimeArtifacts already wrote
 *      the agents before that loop runs) — deleted outright.
 *
 * This test is the reference-host dogfood mirroring
 * tests/declarative-reference-codebuddy.test.cjs: it (1) classifies
 * Copilot's profile via profileOf, (2) confirms the public declarative
 * adapter classifies it as declarative, (3) round-trips a real install
 * proving a gsd agent/skill surface is emitted, (4) proves negotiation
 * fails CLOSED on a corrupted descriptor, (5) proves the validator accepts
 * the descriptor, and (6) source-greps the folded modules for the retired
 * `isCopilot` branches (AC2).
 *
 * UPGRADE 1 (multi-event hook bus) + UPGRADE 2 (dispatch.background
 * negotiation) live-install coverage is in tests/copilot-upgrades.test.cjs
 * — not duplicated here.
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
const { cleanup } = require('./helpers.cjs');
const { walk, runMinimalInstall, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');

const DESC = path.join(__dirname, '..', 'capabilities', 'copilot', 'capability.json');
const COPILOT_CAP = JSON.parse(fs.readFileSync(DESC, 'utf8'));
const COPILOT_AXES = COPILOT_CAP.runtime.hostIntegration;

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { BUILD_TIMEOUT_MS: BUILD_HOOKS_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// hooks/dist is gitignored and built (mirrors golden-install-parity harness).
before(() => {
  throwIfFailed(runNode([BUILD_SCRIPT], { timeoutMs: BUILD_HOOKS_TIMEOUT_MS }), `node ${BUILD_SCRIPT}`);
});

test('Copilot classifies as the declarative-cli reference profile (profileOf)', () => {
  const desc = JSON.parse(fs.readFileSync(DESC, 'utf8'));
  const axes = desc.runtime.hostIntegration;
  assert.ok(axes && axes.embeddingMode, 'copilot descriptor declares hostIntegration axes');
  assert.equal(profileOf(axes), 'declarative-cli',
    'Copilot is a Declarative-CLI host');
});

test('the public declarative adapter classifies Copilot as a declarative host', () => {
  const adapter = createDeclarativeAdapter({ runtime: 'copilot' });
  assert.equal(adapter.kind, 'declarative');
  assert.equal(adapter.runtime, 'copilot');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('a real Copilot install emits a gsd agent/skill surface (invocable)', () => {
  const { configDir, root } = runMinimalInstall({ runtime: 'copilot', scope: 'global' });
  try {
    const files = walk(configDir);
    assert.ok(files.length > 0, 'install must emit artifacts');
    const gsdSurface = files.filter((f) => /gsd/i.test(path.relative(configDir, f)));
    assert.ok(gsdSurface.length > 0,
      'install must emit a gsd agent/skill surface (declarative reference)');
    const agentsDir = path.join(configDir, 'agents');
    assert.ok(fs.existsSync(agentsDir), 'agents/ directory must exist');
    const agentFiles = fs.readdirSync(agentsDir)
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.agent.md'));
    assert.ok(agentFiles.length > 0, 'agents/ must contain gsd-*.agent.md files');
    const skillsDir = path.join(configDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ directory must exist');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// #2099 EoS/copilot — fail-closed negotiation + validator acceptance +
// the folded descriptor (mirrors codebuddy/antigravity/qwen reference tests).
// ---------------------------------------------------------------------------

test('negotiateHostCapabilities never throws for copilot, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...COPILOT_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...COPILOT_AXES, embeddingMode: 'future-unknown' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...COPILOT_AXES, dispatch: 'corrupted-not-an-object' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...COPILOT_AXES, dispatch: { ...COPILOT_AXES.dispatch, maxDepth: 'not-a-number' } }));
});

test('a partial/empty copilot descriptor degrades to the safe floor, not the declarative-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['declarative-cli']);
  assert.ok(result.warnings.length > 0);
});

test('capabilities/copilot/capability.json validates — no errors', () => {
  const errors = validateCapability(COPILOT_CAP, 'copilot');
  assert.deepEqual(errors, [], `validateCapability must return no errors, got: ${JSON.stringify(errors)}`);
});

// -- AC2: the hardcoded branches are retired across all folded modules ------

test('no `runtime === "copilot"` string-equality branch (nor live `isCopilot` read) remains in bin/install.js, src/install-engine.cts, src/surface.cts, or src/runtime-artifact-conversion.cts (AC2)', () => {
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

    // NIT-1: catch both quote styles (single- and double-quoted 'copilot').
    const eqOffenders = stripped.match(/runtime\s*[!=]==\s*["']copilot["']/g) || [];
    assert.deepEqual(eqOffenders, [],
      `AC2: no hardcoded runtime==='copilot' branch may remain in ${path.relative(repoRoot, file)}; found: ${eqOffenders.join(', ')}`);

    // Excludes legit enumeration sites: --copilot CLI flag parsing, the
    // '7':'copilot' numbered-menu map, allRuntimes/_DESCRIPTOR_AGENTS_RUNTIMES
    // set literals, config-dir lists, the copilot conversion FUNCTION names
    // (convertClaudeCommandToCopilotSkill / convertClaudeAgentToCopilotAgent /
    // convertCopilotToolName), and installSurface==='copilot-instructions'
    // (a descriptor-field string, not a runtime literal) — none of those
    // contain the token `isCopilot`, so a literal-word match is precise here.
    const isCopilotHits = stripped.match(/\bisCopilot\b/g) || [];
    assert.deepEqual(isCopilotHits, [],
      `AC2: no live isCopilot read may remain in ${path.relative(repoRoot, file)}; found ${isCopilotHits.length} occurrence(s)`);
  }
});

// allow-test-rule: structural-regression-guard — AC2: assert no `runtime === 'codebuddy'` string-equality branch, no `isCodebuddy` conversion helper, no `canonical === 'codebuddy'` branch remains in bin/install.js, src/runtime-artifact-conversion.cts, src/shell-command-projection.cts, src/runtime-name-policy.cts — a source-text property, so source-grep is the faithful check (#2098)
'use strict';

/**
 * Declarative reference host — CodeBuddy (#2098 / ADR-1239 EoS).
 *
 * CodeBuddy already installs through the descriptor-driven artifactLayout
 * (commands/skills/agents, each with a named `converter`), and its
 * capability.json already declares `hostIntegration` + `dispatch` axes.
 * Unlike antigravity/qwen (#2096/#2092), CodeBuddy was NOT migrated off a
 * legacy runtime-keyed branch chain wholesale — issue #2098 found it was
 * already descriptor-driven except for two residual `isCodebuddy` branches
 * in bin/install.js:
 *   1. a duplicate `commands/` slash-command output report (byte-identical
 *      to the generic `hostBehaviors.reportCommandsDir` block) — folded onto
 *      `hostBehaviors.reportCommandsDir` and deleted. Cursor retired that
 *      parallel commands surface later in #2644.
 *   2. a dead legacy agent-converter dispatch arm in the inline agent-copy
 *      loop, unreachable because codebuddy is a member of
 *      `_DESCRIPTOR_AGENTS_RUNTIMES` (installRuntimeArtifacts already wrote
 *      the agents before that loop runs) — deleted outright.
 *
 * This test is the reference-host dogfood mirroring
 * tests/declarative-reference-antigravity.test.cjs: it (1) classifies
 * CodeBuddy's profile via profileOf, (2) confirms the public declarative
 * adapter classifies it as declarative, (3) round-trips a real install
 * proving a gsd command surface is emitted, (4) proves negotiation fails
 * CLOSED on a corrupted descriptor, (5) proves the validator accepts the
 * descriptor, and (6) source-greps the folded modules for the retired
 * `isCodebuddy` branches (AC2).
 *
 * UPGRADE 1 (extended hook events) + UPGRADE 2 (dispatch.background
 * negotiation) live-install coverage is in tests/codebuddy-upgrades.test.cjs
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

const DESC = path.join(__dirname, '..', 'capabilities', 'codebuddy', 'capability.json');
const CODEBUDDY_CAP = JSON.parse(fs.readFileSync(DESC, 'utf8'));
const CODEBUDDY_AXES = CODEBUDDY_CAP.runtime.hostIntegration;
// scripts/build-hooks.js copies pre-built hook files into hooks/dist and
// syntax-checks them with vm — it does not compile/bundle anything. See
// tests/helpers/timeouts.cjs for the class-norm justification.
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// hooks/dist is gitignored and built (mirrors golden-install-parity harness).
before(() => {
  throwIfFailed(
    runNode([BUILD_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }),
    `node ${BUILD_SCRIPT}`,
  );
});

test('CodeBuddy classifies as the declarative-cli reference profile (profileOf)', () => {
  const desc = JSON.parse(fs.readFileSync(DESC, 'utf8'));
  const axes = desc.runtime.hostIntegration;
  assert.ok(axes && axes.embeddingMode, 'codebuddy descriptor declares hostIntegration axes');
  assert.equal(profileOf(axes), 'declarative-cli',
    'CodeBuddy is a Declarative-CLI host');
});

test('the public declarative adapter classifies CodeBuddy as a declarative host', () => {
  const adapter = createDeclarativeAdapter({ runtime: 'codebuddy' });
  assert.equal(adapter.kind, 'declarative');
  assert.equal(adapter.runtime, 'codebuddy');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('a real CodeBuddy install emits a gsd command/skill surface (invocable)', () => {
  const { configDir, root } = runMinimalInstall({ runtime: 'codebuddy', scope: 'global' });
  try {
    const files = walk(configDir);
    assert.ok(files.length > 0, 'install must emit artifacts');
    // CodeBuddy uses a flat commands/gsd-*.md slash-command surface
    // (CONTEXT.md installer module; capabilities/codebuddy/capability.json
    // artifactLayout `kind: "commands"`).
    const gsdSurface = files.filter((f) => /gsd/i.test(path.relative(configDir, f)));
    assert.ok(gsdSurface.length > 0,
      'install must emit a gsd command/skill surface (declarative reference)');
    const commandsDir = path.join(configDir, 'commands');
    assert.ok(fs.existsSync(commandsDir), 'commands/ directory must exist');
    const cmdFiles = fs.readdirSync(commandsDir)
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(cmdFiles.length > 0, 'commands/ must contain gsd-*.md slash commands');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// #2098 EoS/codebuddy — fail-closed negotiation + validator acceptance +
// the folded descriptor (mirrors antigravity/qwen reference tests).
// ---------------------------------------------------------------------------

test('negotiateHostCapabilities never throws for codebuddy, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...CODEBUDDY_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...CODEBUDDY_AXES, embeddingMode: 'future-unknown' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...CODEBUDDY_AXES, dispatch: 'corrupted-not-an-object' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...CODEBUDDY_AXES, dispatch: { ...CODEBUDDY_AXES.dispatch, maxDepth: 'not-a-number' } }));
});

test('a partial/empty codebuddy descriptor degrades to the safe floor, not the declarative-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['declarative-cli']);
  assert.ok(result.warnings.length > 0);
});

test('capabilities/codebuddy/capability.json validates — no errors', () => {
  const errors = validateCapability(CODEBUDDY_CAP, 'codebuddy');
  assert.deepEqual(errors, [], `validateCapability must return no errors, got: ${JSON.stringify(errors)}`);
});

// -- AC2: the hardcoded branches are retired across all folded modules -------

test('no `runtime === "codebuddy"` string-equality branch (nor `isCodebuddy` conversion helper / `canonical === "codebuddy"`) remains in the descriptor-migrated modules (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  const repoRoot = path.join(__dirname, '..');
  const files = [
    path.join(repoRoot, 'bin', 'install.js'),
    path.join(repoRoot, 'src', 'runtime-artifact-conversion.cts'),
    path.join(repoRoot, 'src', 'shell-command-projection.cts'),
    path.join(repoRoot, 'src', 'runtime-name-policy.cts'),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const stripped = strip(src);

    const eqOffenders = stripped.match(/runtime\s*[!=]==\s*'codebuddy'/g) || [];
    assert.deepEqual(eqOffenders, [],
      `AC2: no hardcoded runtime==='codebuddy' branch may remain in ${path.relative(repoRoot, file)}; found: ${eqOffenders.join(', ')}`);

    const isCodebuddyHits = stripped.match(/\bisCodebuddy\b/g) || [];
    assert.deepEqual(isCodebuddyHits, [],
      `AC2: no live isCodebuddy read may remain in ${path.relative(repoRoot, file)}; found ${isCodebuddyHits.length} occurrence(s)`);

    const canonicalOffenders = stripped.match(/canonical\s*===\s*'codebuddy'/g) || [];
    assert.deepEqual(canonicalOffenders, [],
      `AC2: no canonical==='codebuddy' branch may remain in ${path.relative(repoRoot, file)}; found: ${canonicalOffenders.join(', ')}`);
  }
});

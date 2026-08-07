// allow-test-rule: structural-regression-guard — AC2: assert no `runtime === 'zcode'` string-equality branch, no live `isZcode` read remains in bin/install.js, src/install-engine.cts, src/surface.cts, or src/runtime-artifact-conversion.cts — a source-text property, so source-grep is the faithful check (#2101)
'use strict';

/**
 * Declarative reference host — ZCode (#2101 / ADR-1239 EoS).
 *
 * ZCode already installs through the descriptor-driven artifactLayout
 * (nested skills/, flat commands/, flat agents/, each with a named
 * `converter`), and its capability.json already declared `hostIntegration`
 * axes. Issue #2101 found ZCode was already descriptor-driven except for one
 * residual `isZcode` branch in bin/install.js: the shared-hooks-install
 * exclusion (`&& !isZcode`), kept hardcoded because zcode's `hostBehaviors`
 * block was previously empty. ZCode's golden install tree has ZERO hook
 * files (verified), so folding this onto `hostBehaviors.skipSharedHooksInstall`
 * is byte-parity — the same fold already done for
 * windsurf/copilot/cursor/cline/kilo/trae (#2089/#2090/#2093/#2094/#2099/#2100).
 *
 * This test is the reference-host dogfood mirroring
 * tests/declarative-reference-windsurf.test.cjs: it (1) classifies ZCode's
 * profile via profileOf, (2) confirms the public declarative adapter
 * classifies it as declarative, (3) round-trips a real install proving a
 * gsd surface is emitted, (4) proves negotiation fails CLOSED on a corrupted
 * descriptor, (5) proves the validator accepts the descriptor, and (6)
 * source-greps the folded modules for the retired `isZcode` branch (AC2).
 *
 * Both capability upgrades anticipated by the issue (hook automation via
 * ZCode's plugin Hook component; native MCP registration) remain BLOCKED —
 * ZCode's docs do not publish the on-disk config format/location/schema for
 * either surface (see docs/reference/host-integration-capability-matrix.md
 * ## zcode for the cited doc URLs and rationale). No upgrade code is added
 * here; implementing a guessed format would risk a false-green descriptor.
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

const DESC = path.join(__dirname, '..', 'capabilities', 'zcode', 'capability.json');
const ZCODE_CAP = JSON.parse(fs.readFileSync(DESC, 'utf8'));
const ZCODE_AXES = ZCODE_CAP.runtime.hostIntegration;
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

test('ZCode classifies as the declarative-cli reference profile (profileOf)', () => {
  const desc = JSON.parse(fs.readFileSync(DESC, 'utf8'));
  const axes = desc.runtime.hostIntegration;
  assert.ok(axes && axes.embeddingMode, 'zcode descriptor declares hostIntegration axes');
  assert.equal(profileOf(axes), 'declarative-cli', 'ZCode is a Declarative-CLI host');
});

test('the public declarative adapter classifies ZCode as a declarative host', () => {
  const adapter = createDeclarativeAdapter({ runtime: 'zcode' });
  assert.equal(adapter.kind, 'declarative');
  assert.equal(adapter.runtime, 'zcode');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('a real ZCode install emits an invocable gsd skill/command/agent surface', () => {
  const { configDir, root } = runMinimalInstall({ runtime: 'zcode', scope: 'global' });
  try {
    const files = walk(configDir);
    assert.ok(files.length > 0, 'install must emit artifacts');
    const gsdSurface = files.filter((f) => /gsd/i.test(path.relative(configDir, f)));
    assert.ok(gsdSurface.length > 0, 'install must emit a gsd surface (declarative reference)');

    // ZCode's artifactLayout (capabilities/zcode/capability.json) declares
    // nested skills/, flat commands/, and flat agents/ — verify all three.
    const skillsDir = path.join(configDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ directory must exist');
    const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(skillDirs.length > 0, 'skills/ must contain nested gsd-* skill directories');
    const firstSkillFiles = fs.readdirSync(path.join(skillsDir, skillDirs[0].name));
    assert.ok(firstSkillFiles.includes('SKILL.md'), 'each nested skill dir must contain SKILL.md');

    const commandsDir = path.join(configDir, 'commands');
    assert.ok(fs.existsSync(commandsDir), 'commands/ directory must exist');
    const cmdFiles = fs.readdirSync(commandsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(cmdFiles.length > 0, 'commands/ must contain flat gsd-*.md slash commands');

    const agentsDir = path.join(configDir, 'agents');
    assert.ok(fs.existsSync(agentsDir), 'agents/ directory must exist');
    const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(agentFiles.length > 0, 'agents/ must contain flat gsd-*.md agent files');

    // #2101: zcode's shared-hooks exclusion is now descriptor-driven
    // (hostBehaviors.skipSharedHooksInstall:true) — golden has zero hook
    // files, so no hooks/ directory should be installed.
    assert.ok(!fs.existsSync(path.join(configDir, 'hooks')), 'zcode install must not emit a hooks/ directory');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// #2101 EoS/zcode — fail-closed negotiation + validator acceptance +
// the folded descriptor (mirrors codebuddy/windsurf/augment reference tests).
// ---------------------------------------------------------------------------

test('negotiateHostCapabilities never throws for zcode, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...ZCODE_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...ZCODE_AXES, embeddingMode: 'future-unknown' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...ZCODE_AXES, dispatch: 'corrupted-not-an-object' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...ZCODE_AXES, dispatch: { ...ZCODE_AXES.dispatch, maxDepth: 'not-a-number' } }));
});

test('a partial/empty zcode descriptor degrades to the safe floor, not the declarative-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['declarative-cli']);
  assert.ok(result.warnings.length > 0);
});

// AC-style proof: the 2 still-`undocumented` dispatch sub-axes (nested/
// maxDepth) must degrade to the most-restrictive KNOWN value, never their
// optimistic value. Unlike augment (3 undocumented sub-axes) or antigravity
// (4), zcode documents namedDispatch/background/subagentToolkit/
// backgroundDispatch, leaving only nested + maxDepth undocumented. Real
// values confirmed via:
//   node -e "const {negotiateHostCapabilities}=require('./gsd-core/bin/lib/host-integration.cjs');
//            const cap=require('./capabilities/zcode/capability.json');
//            console.log(negotiateHostCapabilities(cap.runtime.hostIntegration).effective.dispatch)"
// -> { namedDispatch:true, nested:false, maxDepth:0, background:false, subagentToolkit:'full', backgroundDispatch:false }
test("zcode's 2 still-undocumented dispatch sub-axes (nested/maxDepth) degrade to the most-restrictive known value, not their optimistic value", () => {
  // Sanity: the descriptor itself still declares these 2 as the undocumented
  // sentinel, while namedDispatch/background/subagentToolkit/backgroundDispatch
  // are documented.
  assert.equal(ZCODE_AXES.dispatch.nested, 'undocumented');
  assert.equal(ZCODE_AXES.dispatch.maxDepth, 'undocumented');
  assert.equal(ZCODE_AXES.dispatch.namedDispatch, true, 'sanity: namedDispatch is documented, not part of the undocumented set');
  assert.equal(ZCODE_AXES.dispatch.background, false, 'sanity: background is documented, not part of the undocumented set');
  assert.equal(ZCODE_AXES.dispatch.subagentToolkit, 'full', 'sanity: subagentToolkit is documented, not part of the undocumented set');
  assert.equal(ZCODE_AXES.dispatch.backgroundDispatch, false, 'sanity: backgroundDispatch is documented, not part of the undocumented set');

  const { effective, warnings } = negotiateHostCapabilities(ZCODE_AXES);

  assert.equal(effective.dispatch.nested, false, 'undocumented nested must degrade to false, never true');
  assert.equal(effective.dispatch.maxDepth, 0, 'undocumented maxDepth must degrade to 0, never -1/unbounded');

  // namedDispatch/background/subagentToolkit/backgroundDispatch are documented
  // — they are trusted and survive negotiation unchanged.
  assert.equal(effective.dispatch.namedDispatch, true, "documented 'true' namedDispatch is trusted, unlike the undocumented sub-axes");
  assert.equal(effective.dispatch.background, false, "documented 'false' background is trusted");
  assert.equal(effective.dispatch.subagentToolkit, 'full', "documented 'full' subagentToolkit is trusted, unlike the undocumented sub-axes");
  assert.equal(effective.dispatch.backgroundDispatch, false, "documented 'false' backgroundDispatch is trusted");

  assert.ok(
    warnings.some((w) => w.includes('dispatch.nested') && w.includes('undocumented')),
    'a warning must be raised for the undocumented dispatch.nested axis',
  );
  assert.ok(
    warnings.some((w) => w.includes('dispatch.maxDepth')),
    'a warning must be raised for the undocumented dispatch.maxDepth axis (reported as missing/non-number)',
  );
});

test('capabilities/zcode/capability.json validates — no errors', () => {
  const errors = validateCapability(ZCODE_CAP, 'zcode');
  assert.deepEqual(errors, [], `validateCapability must return no errors, got: ${JSON.stringify(errors)}`);
});

// -- AC2: the hardcoded branch is retired across all folded modules ---------

test('no `runtime === "zcode"` string-equality branch (nor live `isZcode` read) remains in bin/install.js, src/install-engine.cts, src/surface.cts, or src/runtime-artifact-conversion.cts (AC2)', () => {
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

    const eqOffenders = stripped.match(/runtime\s*[!=]==\s*["']zcode["']/g) || [];
    assert.deepEqual(eqOffenders, [],
      `AC2: no hardcoded runtime==='zcode' branch may remain in ${path.relative(repoRoot, file)}; found: ${eqOffenders.join(', ')}`);

    // Excludes legit enumeration sites: --zcode CLI flag parsing, the numbered
    // menu map ('16': 'zcode'), the allRuntimes set literal, help/usage text,
    // and the `// #2101: isZcode dropped` comment (stripped above) — none of
    // those contain the token `isZcode`, so a literal-word match is precise.
    const isZcodeHits = stripped.match(/\bisZcode\b/g) || [];
    assert.deepEqual(isZcodeHits, [],
      `AC2: no live isZcode read may remain in ${path.relative(repoRoot, file)}; found ${isZcodeHits.length} occurrence(s)`);
  }
});

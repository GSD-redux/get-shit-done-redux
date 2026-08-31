'use strict';

/**
 * golden-parity-single-source.test.cjs — anti-divergence guard (#2266, carried
 * forward by #2724 / ADR-2719 Phase 4).
 *
 * tests/golden-install-parity.test.cjs and scripts/gen-golden-install-parity-zcode.cjs
 * used to each carry their OWN inline copy of buildParityManifest plus its 4
 * exclusion constants (VOLATILE_FILES, HOOK_CONFIG_FILES,
 * HOOK_CONFIG_RELATIVE_PATHS, EXCLUDED_PREFIXES). The two copies drifted —
 * the generator's copy was missing the realpath/`<HOME>` normalization the
 * test harness's copy had — and shipped broken fixtures three times (#2086,
 * #2095, #2100). Phase 1 of the golden-install-parity redesign (#2266)
 * consolidated both call sites onto a single canonical implementation in
 * tests/helpers/install-shared.cjs. ADR-2264 Phase 1 (that consolidation) is
 * explicitly RETAINED by ADR-2719 — #2724 deletes the two ORIGINAL consumers
 * (golden-install-parity.test.cjs, gen-golden-install-parity-zcode.cjs), but
 * their two REPLACEMENTS (tests/helpers/emitted-runtime.cjs's currentManifests
 * and tests/helpers/emitted-provenance.cjs's loadManifests) import
 * buildParityManifest the exact same way, so the divergence risk this guard
 * exists for is unchanged — only the consumer names moved.
 *
 * This guard (mirrors the ADR-2121 anti-divergence pattern) enforces that
 * consolidation stays consolidated:
 *   1. install-shared.cjs actually exports a working buildParityManifest +
 *      the 4 exclusion constants with the expected shapes.
 *   2. No downstream consumer re-declares its own inline copy of the builder
 *      function or the exclusion constants.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');

test('install-shared.cjs exports the canonical buildParityManifest + exclusion constants (#2266)', () => {
  const installShared = require('./helpers/install-shared.cjs');

  assert.equal(
    typeof installShared.buildParityManifest,
    'function',
    'install-shared.cjs must export buildParityManifest as the single source of truth'
  );

  assert.ok(
    installShared.VOLATILE_FILES instanceof Set,
    'VOLATILE_FILES must be a Set'
  );
  assert.ok(
    installShared.VOLATILE_FILES.has('gsd-file-manifest.json'),
    "VOLATILE_FILES must keep 'gsd-file-manifest.json' excluded (#2872 acceptance " +
    'criterion: the manifest gained manifestVersion/runtime/scope, but its `timestamp` ' +
    'field is unchanged and still varies per install — if this ever stops being true, ' +
    'the golden fixtures start hashing a per-install timestamp)'
  );
  assert.ok(
    installShared.HOOK_CONFIG_FILES instanceof Set,
    'HOOK_CONFIG_FILES must be a Set'
  );
  assert.ok(
    installShared.HOOK_CONFIG_RELATIVE_PATHS instanceof Set,
    'HOOK_CONFIG_RELATIVE_PATHS must be a Set'
  );
  assert.ok(
    Array.isArray(installShared.EXCLUDED_PREFIXES),
    'EXCLUDED_PREFIXES must be an array'
  );
  assert.ok(
    installShared.EXCLUDED_PREFIXES.includes('gsd-core/bin/lib/'),
    "EXCLUDED_PREFIXES must include 'gsd-core/bin/lib/' (compiled runtime artifacts, build-environment-dependent)"
  );
});

// The anti-divergence check below reads the two downstream .cjs source files
// as plain text to prove they no longer re-declare the builder/constants
// inline — the runtime-contract-under-test IS the source text (whether a
// second inline copy exists), not behavior a require() could exercise.
//
// ALL FIVE identifiers are guarded, not just buildParityManifest + VOLATILE_FILES:
// the drift that shipped broken fixtures was a MISSING exclusion-constant entry
// (#2100 = generator's HOOK_CONFIG_FILES copy lacked settings.local.json; #2095 =
// kimi's HOOK_CONFIG_RELATIVE_PATHS entry), so a re-declared HOOK_CONFIG_FILES /
// HOOK_CONFIG_RELATIVE_PATHS / EXCLUDED_PREFIXES is exactly the failure class this
// guard exists to prevent — checking only two of four would leave that gap open.
const FORBIDDEN_INLINE = [
  { label: 'buildParityManifest',        re: /function\s+buildParityManifest/ },
  { label: 'VOLATILE_FILES',             re: /const\s+VOLATILE_FILES\s*=\s*new\s+Set/ },
  { label: 'HOOK_CONFIG_FILES',          re: /const\s+HOOK_CONFIG_FILES\s*=\s*new\s+Set/ },
  { label: 'HOOK_CONFIG_RELATIVE_PATHS', re: /const\s+HOOK_CONFIG_RELATIVE_PATHS\s*=\s*new\s+Set/ },
  { label: 'EXCLUDED_PREFIXES',          re: /const\s+EXCLUDED_PREFIXES\s*=\s*\[/ },
];

const CONSUMERS = [
  { name: 'tests/helpers/emitted-runtime.cjs',    rel: ['tests', 'helpers', 'emitted-runtime.cjs'],    from: './install-shared.cjs' },
  { name: 'tests/helpers/emitted-provenance.cjs', rel: ['tests', 'helpers', 'emitted-provenance.cjs'], from: './install-shared.cjs' },
];

for (const consumer of CONSUMERS) {
  test(`${consumer.name} does not re-declare an inline buildParityManifest or any exclusion constant (#2266)`, () => {
    // allow-test-rule: source-text-is-the-product (see #2266)
    // Source text is the product for this anti-divergence check.
    const content = fs.readFileSync(path.join(ROOT, ...consumer.rel), 'utf8');
    for (const { label, re } of FORBIDDEN_INLINE) {
      assert.ok(
        !re.test(content),
        `${consumer.name} must import ${label} from ${consumer.from}, not re-declare it inline`
      );
    }
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-1575-agent-descriptor-parity.test.cjs — consolidation epic #1969 (H3 #3336)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-1575-agent-descriptor-parity', () => {

// --- #1575 — surface/install byte-identical agent-output parity (ADR-1235 §0) ---
// Folded in from tests/issue-1575-agent-descriptor-parity.test.cjs (H3 wave 4,
// #3336). Distinct anti-divergence concern from the manifest-builder guards
// above: this asserts applySurface() and installRuntimeArtifacts() produce
// byte-identical agent output for every descriptor-driven runtime, run against
// the SAME configDir so pathPrefix/attribution/converter outputs must match.

process.env.GSD_TEST_MODE = '1';

const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');
const { applySurface } = require('../gsd-core/bin/lib/surface.cjs');
const { loadSkillsManifest, resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');
const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const { cleanup, sandboxHome } = require('./helpers.cjs');

const COMMANDS_GSD = path.join(ROOT, 'commands', 'gsd');

// The 7 descriptor-driven agent runtimes (cline deferred per code comment:
// rules-only local branch + local/global complication).
const DESCRIPTOR_RUNTIMES = [
  'cursor',
  'windsurf',
  'augment',
  'trae',
  'codebuddy',
  'copilot',
  'antigravity',
];

function snapshotAgents(agentsDir) {
  const snap = new Map();
  if (!fs.existsSync(agentsDir)) return snap;
  for (const name of fs.readdirSync(agentsDir)) {
    if (!name.startsWith('gsd-')) continue;
    if (!name.endsWith('.md') && !name.endsWith('.agent.md')) continue;
    snap.set(name, fs.readFileSync(path.join(agentsDir, name), 'utf8'));
  }
  return snap;
}

// Shared manifest + profile so both paths see the same source agents.
const parity1575Manifest = loadSkillsManifest(COMMANDS_GSD);
const parity1575Profile = resolveProfile({ modes: ['full'], manifest: parity1575Manifest });
// Same attribution resolver for both paths (undefined → no Co-Authored-By mutation).
const resolveAttribution1575 = () => undefined;

describe('#1575 — golden-parity: surface path matches install path for descriptor-driven agents', () => {

  for (const runtime of DESCRIPTOR_RUNTIMES) {
    test(`${runtime}: surface agents byte-identical to install agents`, (t) => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-1575-${runtime}-`));
      t.after(() => { try { cleanup(configDir); } catch { /* best-effort */ } });
      // #3738: antigravity's skills/agents kinds declare a global `home`
      // override resolved from os.homedir() — sandbox HOME to the configDir
      // (the #3712 marker real-home-guard needs) so the override resolves
      // inside the sandbox instead of the runner's real home.
      sandboxHome(t, configDir);

      // Step 1: install path writes agents
      installRuntimeArtifacts(runtime, configDir, 'global', parity1575Profile, resolveAttribution1575);

      // Step 2: snapshot agent files at the installer's REAL destination —
      // honor the kind `home` override (codex → ~/.agents, antigravity →
      // ~/.gemini/config per #3738) exactly like assertDestWithinConfigHome's
      // root selection, never assume configDir/agents.
      const parityLayout = resolveRuntimeArtifactLayout(runtime, configDir, 'global');
      const parityAgentsKind = parityLayout.kinds.find((k) => k.kind === 'agents');
      const agentsDir = path.join(parityAgentsKind.home ?? configDir, parityAgentsKind.destSubpath);
      const installSnap = snapshotAgents(agentsDir);
      assert.ok(installSnap.size > 0, `${runtime}: install must produce at least one gsd-* agent`);

      // Step 3: surface path re-materializes into the SAME configDir
      const layout = resolveRuntimeArtifactLayout(runtime, configDir, 'global');
      applySurface(configDir, layout, parity1575Manifest, undefined, undefined, { resolveAttribution: resolveAttribution1575 });

      // Step 4: compare byte-for-byte
      const surfaceSnap = snapshotAgents(agentsDir);

      // File lists must match
      const installFiles = [...installSnap.keys()].sort();
      const surfaceFiles = [...surfaceSnap.keys()].sort();
      assert.deepEqual(
        surfaceFiles,
        installFiles,
        `${runtime}: file lists must match after surface. Install: [${installFiles.join(', ')}] Surface: [${surfaceFiles.join(', ')}]`,
      );

      // Content must match byte-for-byte
      for (const [fileName, installContent] of installSnap) {
        const surfaceContent = surfaceSnap.get(fileName);
        assert.strictEqual(
          surfaceContent,
          installContent,
          `${runtime}/${fileName}: surface content must be byte-identical to install content`,
        );
      }
    });
  }

  test('cursor with non-undefined attribution: surface agents byte-identical to install agents (M2 coverage)', (t) => {
    // M2 regression guard: verify parity holds when resolveAttribution returns
    // a real value. Source agents don't carry Co-Authored-By, so processAttribution
    // is a no-op (it replaces existing lines, doesn't add new ones). But this test
    // proves the agentCtx threading is correct for both paths regardless.
    const attrResolver = () => 'Test Bot <test@example.com>';
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1575-attr-'));
    t.after(() => { try { cleanup(configDir); } catch { /* best-effort */ } });

    installRuntimeArtifacts('cursor', configDir, 'global', parity1575Profile, attrResolver);

    const agentsDir = path.join(configDir, 'agents');
    const installSnap = snapshotAgents(agentsDir);
    assert.ok(installSnap.size > 0, 'install must produce agents');

    const layout = resolveRuntimeArtifactLayout('cursor', configDir, 'global');
    applySurface(configDir, layout, parity1575Manifest, undefined, undefined, { resolveAttribution: attrResolver });

    const surfaceSnap = snapshotAgents(agentsDir);
    for (const [fileName, installContent] of installSnap) {
      assert.strictEqual(surfaceSnap.get(fileName), installContent,
        `cursor/${fileName}: content must be byte-identical with non-undefined attribution`);
    }
  });

  test('copilot: agents installed as .agent.md (filename rename parity)', (t) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1575-copilot-rename-'));
    t.after(() => { try { cleanup(configDir); } catch { /* best-effort */ } });

    installRuntimeArtifacts('copilot', configDir, 'global', parity1575Profile, resolveAttribution1575);

    const agentsDir = path.join(configDir, 'agents');
    assert.ok(fs.existsSync(agentsDir), 'copilot agents dir must exist');
    const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.startsWith('gsd-'));
    assert.ok(agentFiles.length > 0, 'copilot must have installed agents');
    assert.ok(
      agentFiles.every((f) => f.endsWith('.agent.md')),
      `copilot agents must be .agent.md, got: [${agentFiles.slice(0, 3).join(', ')}]`,
    );
  });
});

describe('#1575 — surface path: no prune data-loss over pre-existing legacy agents', () => {
  test('pre-existing gsd-* agents not in staged set are pruned; user agents preserved', (t) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1575-prune-'));
    t.after(() => { try { cleanup(configDir); } catch { /* best-effort */ } });

    // Seed a pre-existing legacy .agent.md (simulating a prior install)
    const agentsDir = path.join(configDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'gsd-old-defunct.agent.md'), '# Old\n');
    fs.writeFileSync(path.join(agentsDir, 'user-custom.md'), '# User\n');

    // Install (should prune stale gsd-*, preserve user agents)
    installRuntimeArtifacts('copilot', configDir, 'global', parity1575Profile, resolveAttribution1575);

    const afterInstall = fs.readdirSync(agentsDir);
    assert.ok(!afterInstall.includes('gsd-old-defunct.agent.md'), 'stale gsd-* agent must be pruned');
    assert.ok(afterInstall.includes('user-custom.md'), 'user agent must be preserved');

    // Now surface over the install — must converge to the same state
    const layout = resolveRuntimeArtifactLayout('copilot', configDir, 'global');
    applySurface(configDir, layout, parity1575Manifest, undefined, undefined, { resolveAttribution: resolveAttribution1575 });

    const afterSurface = fs.readdirSync(agentsDir);
    // Same set of agent files as after install
    const installAgents = afterInstall.filter((f) => f.startsWith('gsd-')).sort();
    const surfaceAgents = afterSurface.filter((f) => f.startsWith('gsd-')).sort();
    assert.deepEqual(surfaceAgents, installAgents, 'surface must converge to same agent set as install');
    assert.ok(afterSurface.includes('user-custom.md'), 'user agent still preserved after surface');
  });
});
  });
}

test('runMinimalInstall resolves local config dirs from RUNTIME_META alone (#3031)', () => {
  // install-shared.cjs used to carry a SECOND, hand-maintained local-dir map
  // beside RUNTIME_META. It drifted: four runtimes present in RUNTIME_META
  // (hermes, kimi, kimi-code, zcode) were missing from it, so `scope: 'local'`
  // for any of them resolved `path.join(root, undefined)` and threw a bare
  // TypeError naming neither the runtime nor the map at fault. #3023 had
  // already hit this for `pi` and fixed it by adding one more entry, which
  // left the divergence itself intact for the next runtime to rediscover.
  //
  // Same anti-divergence pattern as the buildParityManifest guard above: the
  // duplicate is gone, and this asserts it does not come back.
  const helperSrc = fs.readFileSync(
    path.join(ROOT, 'tests', 'helpers', 'install-shared.cjs'),
    'utf8',
  );
  assert.doesNotMatch(
    helperSrc,
    /const\s+LOCAL_DIR_NAME\s*=/,
    'install-shared.cjs must not re-declare a second local-dir map beside RUNTIME_META',
  );

  // Every runtime the harness knows about must be usable at local scope.
  const { RUNTIME_META } = require('./helpers/install-shared.cjs');
  const missing = Object.entries(RUNTIME_META)
    .filter(([, meta]) => !meta.localDir)
    .map(([runtime]) => runtime);
  assert.deepEqual(missing, [],
    'every RUNTIME_META entry needs a localDir or local-scope installs throw on path.join(root, undefined)');
});

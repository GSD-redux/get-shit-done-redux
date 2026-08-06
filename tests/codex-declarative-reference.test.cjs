// allow-test-rule: structural-regression-guard — AC2 requires asserting no `runtime === 'codex'` string-equality and no positive `isCodex` branch remain in bin/install.js/src — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2088)
'use strict';

/**
 * codex declarative reference host — ADR-1239 Phase D / #2088 (EoS/codex).
 *
 * Proves Codex is driven through the PUBLIC Host-Integration Interface (the
 * declarative embedding mode), that its negotiated axes classify + negotiate
 * correctly (including the documented `maxDepth === 1 → flat` dispatch
 * degradation), that negotiation fails CLOSED on a corrupted descriptor, that
 * the three Context7-verified UPGRADES land on the user-reachable surface
 * (skill-root → $HOME/.agents/skills, the 6 new hooks.json lifecycle events, and
 * explicit `[agents] max_depth` dispatch tuning), and that the migration retired
 * the hardcoded `runtime === 'codex'` / positive-`isCodex` projection (folded
 * into descriptor-driven `runtime.hostBehaviors`).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.GSD_TEST_MODE = '1';

const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const { createDeclarativeAdapter } = require('../gsd-core/bin/lib/adapter-declarative.cjs');
const {
  profileOf,
  negotiateHostCapabilities,
  degradationFor,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const install = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

const CODEX_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'codex', 'capability.json'), 'utf8'),
);
const CODEX_AXES = CODEX_CAP.runtime.hostIntegration;

// -- AC2: driven through the public interface (declarative embedding mode) ----

test('codex axes classify as the declarative-cli reference profile', () => {
  assert.equal(profileOf(CODEX_AXES), 'declarative-cli');
});

test('createDeclarativeAdapter classifies codex as declarative + delegates install to the engine', () => {
  const adapter = createDeclarativeAdapter({ runtime: 'codex' });
  assert.equal(adapter.kind, 'declarative');
  assert.equal(adapter.runtime, 'codex');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('the composed-registry install adapter drives codex install/uninstall', () => {
  const adapter = createImperativeAdapter({ runtime: 'codex' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'codex');
  assert.ok(adapter.registry && typeof adapter.registry === 'object');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

// -- AC3: every negotiated axis populated (no undocumented sentinel) ----------

test('every codex hostIntegration axis is populated (zero undocumented sentinels)', () => {
  const axisVals = [
    CODEX_AXES.embeddingMode, CODEX_AXES.commandSurface, CODEX_AXES.modelMode,
    CODEX_AXES.hookBus, CODEX_AXES.stateIO, CODEX_AXES.transport, CODEX_AXES.runtime,
  ];
  for (const v of axisVals) {
    assert.notEqual(v, UNDOCUMENTED, `axis must be documented, got ${v}`);
    assert.ok(typeof v === 'string' && v.length > 0);
  }
  const d = CODEX_AXES.dispatch;
  for (const k of ['namedDispatch', 'nested', 'maxDepth', 'subagentToolkit', 'background', 'backgroundDispatch']) {
    assert.notEqual(d[k], UNDOCUMENTED, `dispatch.${k} must be documented`);
    assert.notEqual(d[k], undefined, `dispatch.${k} must be present`);
  }
  assert.equal(d.embeddingMode, undefined); // sanity: dispatch has no stray keys
});

// -- AC5: dispatch degrades to flat because maxDepth === 1 -------------------

test('dispatch degrades to FLAT for codex — maxDepth===1 even though nested/background are all true', () => {
  assert.equal(CODEX_AXES.dispatch.nested, true);
  assert.equal(CODEX_AXES.dispatch.background, true);
  assert.equal(CODEX_AXES.dispatch.backgroundDispatch, true);
  assert.equal(CODEX_AXES.dispatch.maxDepth, 1);

  const flat = degradationFor('dispatch', CODEX_AXES);
  assert.equal(flat.level, 'degraded', 'maxDepth===1 must degrade dispatch, not grant full nesting');
  assert.match(flat.fallback, /flat dispatch/, 'the documented fallback is flat/inline waves');

  // Prove maxDepth is the cause: at depth 2 the same axes grant full dispatch.
  const deeper = { ...CODEX_AXES, dispatch: { ...CODEX_AXES.dispatch, maxDepth: 2 } };
  assert.equal(degradationFor('dispatch', deeper).level, 'full');
});

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for codex, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...CODEX_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...CODEX_AXES, embeddingMode: 'future-unknown' }));
});

test('a partial/empty codex descriptor degrades to the safe floor, not the declarative-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['declarative-cli']);
  assert.ok(result.warnings.length > 0);
});

// -- AC2: the hardcoded projection is retired --------------------------------

test('codex descriptor declares runtime.hostBehaviors (the folded-in behaviors)', () => {
  const hb = CODEX_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.tomlConfigInstall, true, 'config.toml + agent-toml + hooks.json install runs through the descriptor gate');
  assert.equal(hb.cleanupSkillSidecars, true);
  assert.equal(hb.agentTomlFiles, true);
  assert.equal(hb.frontmatterDialect, 'codex');
  assert.equal(hb.reapplyCommand, '$gsd-update --reapply');
});

test('no `runtime === "codex"` string-equality and no positive `isCodex` gate remain in the install source (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  for (const rel of ['bin/install.js', 'src/install-engine.cts', 'src/runtime-artifact-conversion.cts']) {
    const raw = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const src = strip(raw);

    const stringEq = src.match(/runtime\s*[!=]==\s*'codex'/g) || [];
    assert.deepEqual(stringEq, [], `AC2: no hardcoded runtime==='codex' branch may remain in ${rel}; found: ${stringEq.join(', ')}`);

    // Every `isCodex` reference must be either a runtimeFlags(...) destructure
    // line or a NEGATED occurrence inside a shared multi-runtime roster
    // (`!isCodex && !isCopilot && ...`). A positive `isCodex` gate is forbidden.
    for (const line of src.split(/\r?\n/)) {
      if (!/\bisCodex\b/.test(line)) continue;
      if (/runtimeFlags\s*\(/.test(line)) continue; // destructure declaration
      const positive = line.replace(/!\s*isCodex\b/g, '').match(/\bisCodex\b/);
      assert.equal(positive, null, `AC2: positive isCodex gate forbidden in ${rel}: ${line.trim()}`);
    }
  }
});

// -- AC4 upgrade 3: skill root is the canonical $HOME/.agents/skills ---------

test('upgrade 3 — codex skills resolve to $HOME/.agents/skills, not the deprecated $CODEX_HOME/skills', () => {
  const codexHome = path.join(os.homedir(), '.codex');
  const root = install._resolveSkillsRootDir('codex', codexHome, 'global');
  assert.equal(root, path.join(os.homedir(), '.agents', 'skills'),
    'skills must install to the canonical ~/.agents/skills root');
  assert.ok(!root.startsWith(codexHome), 'skills must NOT land under the deprecated $CODEX_HOME/skills');
});

test('upgrade 3 — the pre-move location is migrated (stale ~/.codex/skills/gsd-* cleaned; user content preserved)', () => {
  const codexHome = path.join(os.homedir(), '.codex');
  const oldDir = install._resolveMovedSkillsOldDir('codex', codexHome, 'global');
  assert.equal(oldDir, path.join(codexHome, 'skills'), 'the pre-move location is $CODEX_HOME/skills');
  // A runtime with no home override yields null (no false migration).
  assert.equal(install._resolveMovedSkillsOldDir('kimi', path.join(os.homedir(), '.kimi'), 'global'), null);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-migrate-'));
  const skillsDir = path.join(tmp, 'skills');
  fs.mkdirSync(path.join(skillsDir, 'gsd-plan'), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'gsd-dev-preferences'), { recursive: true }); // user-owned, preserved
  fs.mkdirSync(path.join(skillsDir, 'my-own-skill'), { recursive: true });        // non-gsd, preserved
  try {
    const removed = install.cleanupMovedSkillsOldLocation(skillsDir, 'gsd-');
    assert.equal(removed, 1, 'only the managed gsd-plan dir is removed');
    assert.ok(!fs.existsSync(path.join(skillsDir, 'gsd-plan')), 'stale managed skill removed');
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-dev-preferences')), 'user-owned gsd-dev-preferences preserved');
    assert.ok(fs.existsSync(path.join(skillsDir, 'my-own-skill')), 'non-gsd dir preserved');
  } finally {
    cleanup(tmp);
  }
});

// -- AC4 upgrade 1: the 6 new hooks.json lifecycle events are registered ------

test('upgrade 1 — codex registers all documented hooks.json lifecycle events, incl. the 6 new in #2088', () => {
  const expected = [
    'SubagentStart', 'Stop', 'PostToolUse',       // #772
    'PreToolUse', 'PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStop', 'UserPromptSubmit', // #2088
  ];
  assert.deepEqual(install.CODEX_EXTENDED_HOOK_EVENTS, expected,
    'the shared install/uninstall event list must contain the 3 original + 6 new events');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-'));
  try {
    fs.mkdirSync(path.join(tmp, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'hooks', 'gsd-context-monitor.js'), '// stub');
    fs.writeFileSync(path.join(tmp, 'hooks', 'gsd-check-update.js'), '// stub');
    for (const ev of install.CODEX_EXTENDED_HOOK_EVENTS) {
      install.ensureCodexHooksJsonEvent(tmp, ev, { absoluteRunner: '/usr/bin/node', platform: 'linux' });
    }
    install.ensureCodexHooksJsonSessionStart(tmp, { absoluteRunner: '/usr/bin/node', platform: 'linux' });
    const hooksJson = JSON.parse(fs.readFileSync(path.join(tmp, 'hooks.json'), 'utf8'));
    const registered = Object.keys(hooksJson.hooks || hooksJson || {});
    for (const ev of ['PreToolUse', 'PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStop', 'UserPromptSubmit']) {
      assert.ok(registered.includes(ev), `#2088 must register the ${ev} hook in hooks.json`);
    }
    assert.ok(registered.includes('SessionStart'), 'the SessionStart baseline stays registered');
  } finally {
    cleanup(tmp);
  }
});

test('upgrade 1 — extendedHookEvents descriptor reconciled to the schema-valid wired subset (no longer [])', () => {
  assert.deepEqual(CODEX_CAP.runtime.extendedHookEvents, ['SubagentStop', 'Stop', 'PreCompact'],
    'reconciled from [] to the wired extended-lifecycle events expressible in the cross-runtime vocabulary');
});

// -- AC4 upgrade 2: explicit [agents] max_depth dispatch tuning ---------------

test('upgrade 2 — the managed config block writes [agents] max_depth = 1', () => {
  const block = install.generateCodexConfigBlock(
    [{ name: 'gsd-foo', description: 'Foo' }, { name: 'gsd-bar', description: 'Bar' }],
    path.join(os.homedir(), '.codex'),
  );
  assert.match(block, /\[agents\]\nmax_depth = 1\n/, 'the block pins max_depth = 1 on a bare [agents] table');
  // #2406: the bare [agents] scalar table is the ONLY [agents]-namespaced
  // content the block emits — no [agents.gsd-*] role sub-tables. Codex
  // auto-discovers roles from the standalone agents/<name>.toml files, so a
  // config.toml role table pointing config_file back at that same file was a
  // second, duplicate registration of the same role.
  assert.doesNotMatch(block, /\[agents\.gsd-foo\]/, 'no [agents.gsd-foo] role table');
  assert.doesNotMatch(block, /config_file/, 'no config_file line');
});

test('upgrade 2 — validateCodexConfigSchema accepts the managed [agents] block but still rejects break-forms', () => {
  const block = install.generateCodexConfigBlock([{ name: 'gsd-foo', description: 'Foo' }], path.join(os.homedir(), '.codex'));
  assert.equal(install.validateCodexConfigSchema(block).ok, true, 'known-scalar [agents] table must validate');

  // Still rejects the actual #2760 break-forms.
  assert.equal(install.validateCodexConfigSchema('[[agents]]\nname = "x"\n').ok, false, '[[agents]] sequence still rejected');
  assert.equal(install.validateCodexConfigSchema('[agents]\ndefault = "x"\n').ok, false, 'bare [agents] with an unknown key still rejected');

  // A user's own AgentsToml scalar table is now accepted (no longer over-rejected).
  assert.equal(install.validateCodexConfigSchema('[agents]\nmax_threads = 4\n').ok, true, 'user known-scalar [agents] accepted');
  assert.equal(install.codexBareAgentsHasOnlyKnownScalars('max_depth = 1\n'), true);
  assert.equal(install.codexBareAgentsHasOnlyKnownScalars('default = "x"\n'), false);
});

test('upgrade 2 — uninstall removes the managed [agents] max_depth block', () => {
  const block = install.generateCodexConfigBlock([{ name: 'gsd-foo', description: 'Foo' }], path.join(os.homedir(), '.codex'));
  const stripped = install.stripGsdFromCodexConfig('model = "gpt-5"\n\n' + block);
  assert.ok(stripped === null || !/\[agents\]/.test(stripped), `uninstall must remove the managed [agents] block; got: ${JSON.stringify(stripped)}`);
});

// Regression (#2088 review): install must NOT silently drop a user's own
// AgentsToml scalar tuning when it purges the bare [agents] table to add max_depth.
test('upgrade 2 — install preserves the user\'s own AgentsToml scalars (max_threads etc.), GSD-manages max_depth', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-agents-merge-'));
  try {
    const cfgPath = path.join(tmp, 'config.toml');
    fs.writeFileSync(cfgPath, '[agents]\nmax_threads = 4\nmax_depth = 9\ninterrupt_message = false\n\n[model]\nname = "o3"\n');

    // extract helper: user scalars except the GSD-managed max_depth.
    const scalars = install.extractCodexUserAgentsScalars(fs.readFileSync(cfgPath, 'utf8'));
    assert.ok(scalars.includes('max_threads = 4'), 'max_threads is a preserved user scalar');
    assert.ok(scalars.includes('interrupt_message = false'), 'interrupt_message is a preserved user scalar');
    assert.ok(!scalars.some((s) => s.startsWith('max_depth')), 'max_depth is GSD-managed, not preserved from the user');

    install.mergeCodexConfig(cfgPath, install.generateCodexConfigBlock([{ name: 'gsd-foo', description: 'Foo' }], tmp));
    const merged = fs.readFileSync(cfgPath, 'utf8');

    assert.match(merged, /max_threads = 4/, 'user max_threads must survive install');
    assert.match(merged, /interrupt_message = false/, 'user interrupt_message must survive install');
    assert.match(merged, /max_depth = 1/, 'GSD pins max_depth = 1');
    assert.doesNotMatch(merged, /max_depth = 9/, 'user max_depth is overridden by the GSD-managed value');
    assert.equal((merged.match(/^\[agents\]$/mg) || []).length, 1, 'exactly one managed [agents] table (no duplicate)');
    assert.equal(install.validateCodexConfigSchema(merged).ok, true, 'the merged config still validates');
    // #2406: the fresh block never emitted an [agents.gsd-foo] role table in
    // the first place — canonical registration lives only in the standalone
    // TOML, so there is nothing gsd-foo-shaped in config.toml to begin with.
    assert.doesNotMatch(merged, /gsd-foo/, 'no [agents.gsd-foo] role table in the merged config');

    // Symmetric: uninstall restores the user's scalars and drops GSD's max_depth.
    const uninstalled = install.stripGsdFromCodexConfig(merged);
    assert.match(uninstalled, /max_threads = 4/, 'uninstall restores the user\'s max_threads');
    assert.match(uninstalled, /interrupt_message = false/, 'uninstall restores interrupt_message');
    assert.doesNotMatch(uninstalled, /max_depth/, 'uninstall drops the GSD-managed max_depth');
    assert.doesNotMatch(uninstalled, /gsd-foo/, 'no [agents.gsd-foo] role table remains after uninstall either');
    assert.equal(install.validateCodexConfigSchema(uninstalled).ok, true, 'the restored config validates');
  } finally {
    cleanup(tmp);
  }
});

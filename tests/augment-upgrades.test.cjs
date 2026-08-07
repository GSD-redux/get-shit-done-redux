'use strict';

/**
 * Augment Code capability UPGRADES — ADR-1239 / #2097 (EoS/augment migration).
 *
 * Mirrors tests/antigravity-upgrades.test.cjs's structure. Augment already
 * shipped as a declarative-CLI host prior to #2097 (nested-skill artifact
 * layout, settings-json hook surface, Claude hook event dialect, dispatch
 * namedDispatch/background/subagentToolkit:'full'), so UPGRADE 1 (dispatch)
 * and UPGRADE 2 (hook-bus) below are REGRESSION locks on that pre-existing
 * wiring, not new capabilities. UPGRADE 3 (MCP companion) IS new: #2097 adds
 * `mergeGsdMcpServerIntoSettings`, registering the GSD companion MCP server
 * inside Augment's own settings.json `mcpServers` block (Augment hosts MCP
 * there, unlike Antigravity's standalone mcp_config.json) — non-destructively
 * appending GSD's own entry while preserving any other user-configured
 * `mcpServers` entries. Uninstall removes only the GSD-owned `gsd` entry.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode } = require('./helpers/process-seam.cjs');

const { runMinimalInstall, installerEnv, INSTALL_SCRIPT } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');
const {
  mergeGsdMcpServerIntoSettings,
} = require('../bin/install.js');
const { negotiateHostCapabilities } = require('../gsd-core/bin/lib/host-integration.cjs');
const { PACKAGE_NAME } = require('../gsd-core/bin/lib/package-identity.cjs');

const AUGMENT_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'augment', 'capability.json'), 'utf8'),
);

// ---------------------------------------------------------------------------
// UPGRADE 1: dispatch — descriptor + negotiation regression lock
// ---------------------------------------------------------------------------

test('capabilities/augment/capability.json declares dispatch.namedDispatch/background/subagentToolkit for full subagent support (UPGRADE 1)', () => {
  const dispatch = AUGMENT_CAP.runtime.hostIntegration.dispatch;
  assert.equal(dispatch.namedDispatch, true);
  assert.equal(dispatch.background, true);
  assert.equal(dispatch.subagentToolkit, 'full');
});

test('negotiateHostCapabilities does NOT flatten dispatch for augment — namedDispatch/background/subagentToolkit survive negotiation (UPGRADE 1)', () => {
  const { effective } = negotiateHostCapabilities(AUGMENT_CAP.runtime.hostIntegration);
  assert.equal(effective.dispatch.namedDispatch, true,
    'documented namedDispatch:true must survive negotiation unflattened');
  assert.equal(effective.dispatch.background, true,
    'documented background:true must survive negotiation unflattened (not capped to false)');
  assert.equal(effective.dispatch.subagentToolkit, 'full',
    'documented subagentToolkit:full must survive negotiation unflattened');
});

// ---------------------------------------------------------------------------
// UPGRADE 2: hook-bus — live install proves the settings.json hook surface
// (SessionStart/PostToolUse/PreToolUse) is actually wired for augment.
// ---------------------------------------------------------------------------

for (const scope of ['global', 'local']) {
  test(`augment --${scope}: settings.json contains GSD's managed hook entries (UPGRADE 2)`, (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'augment', scope });
    t.after(() => cleanup(root));

    const settingsPath = path.join(configDir, 'settings.json');
    assert.ok(fs.existsSync(settingsPath), `${settingsPath} must exist`);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.hooks && typeof settings.hooks === 'object', 'settings.hooks must be an object');

    // Augment's hookEvents dialect is 'claude' (capabilities/augment/capability.json),
    // so it gets the Claude-dialect event names (PostToolUse/PreToolUse), not
    // antigravity's gemini-dialect (AfterTool/BeforeTool).
    assert.ok(Array.isArray(settings.hooks.SessionStart) && settings.hooks.SessionStart.length > 0,
      'settings.hooks.SessionStart must be registered');
    assert.ok(Array.isArray(settings.hooks.PostToolUse) && settings.hooks.PostToolUse.length > 0,
      'settings.hooks.PostToolUse must be registered');
    assert.ok(Array.isArray(settings.hooks.PreToolUse) && settings.hooks.PreToolUse.length > 0,
      'settings.hooks.PreToolUse must be registered');

    const hasGsdCommand = (entries) => entries.some(
      (entry) => entry && Array.isArray(entry.hooks) &&
        entry.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes('gsd-')),
    );
    assert.ok(hasGsdCommand(settings.hooks.SessionStart), 'SessionStart must reference a gsd- managed hook');
    assert.ok(hasGsdCommand(settings.hooks.PostToolUse), 'PostToolUse must reference a gsd- managed hook');
    assert.ok(hasGsdCommand(settings.hooks.PreToolUse), 'PreToolUse must reference a gsd- managed hook');
  });
}

// ---------------------------------------------------------------------------
// UPGRADE 3: MCP companion config — direct-unit idempotency + preservation
// (mirrors antigravity's configureAntigravityMcpConfig unit tests exactly,
// scoped to the in-memory settings object mergeGsdMcpServerIntoSettings mutates).
// ---------------------------------------------------------------------------

test('mergeGsdMcpServerIntoSettings adds mcpServers.gsd with command "npx" and args including gsd-mcp-server + PACKAGE_NAME', () => {
  const settings = {};
  mergeGsdMcpServerIntoSettings(settings);
  assert.ok(settings.mcpServers && settings.mcpServers.gsd, 'mcpServers.gsd must be present');
  assert.equal(settings.mcpServers.gsd.command, 'npx');
  assert.deepEqual(settings.mcpServers.gsd.args, ['-y', '-p', PACKAGE_NAME, 'gsd-mcp-server']);
});

test('mergeGsdMcpServerIntoSettings is idempotent — a second call does not clobber an existing gsd entry', () => {
  const settings = {};
  mergeGsdMcpServerIntoSettings(settings);
  // Simulate a user hand-edit of the gsd entry after install.
  settings.mcpServers.gsd.args.push('--custom-flag');

  mergeGsdMcpServerIntoSettings(settings);

  assert.ok(settings.mcpServers.gsd.args.includes('--custom-flag'),
    "a user-owned gsd override is never clobbered (Hyrum's Law)");
  assert.equal(Object.keys(settings.mcpServers).length, 1, 'exactly one mcpServers entry (gsd)');
});

test('mergeGsdMcpServerIntoSettings preserves a pre-existing unrelated mcpServers entry', () => {
  const settings = {
    mcpServers: {
      'my-own-server': { command: 'my-tool', args: ['--flag'] },
    },
  };
  mergeGsdMcpServerIntoSettings(settings);

  assert.deepEqual(settings.mcpServers['my-own-server'], { command: 'my-tool', args: ['--flag'] });
  assert.ok(settings.mcpServers.gsd);
  assert.equal(Object.keys(settings.mcpServers).length, 2, 'both entries present');
});

test('mergeGsdMcpServerIntoSettings recovers a corrupted (non-object) mcpServers field', () => {
  const settingsArrayCase = { mcpServers: ['not', 'an', 'object'] };
  mergeGsdMcpServerIntoSettings(settingsArrayCase);
  assert.ok(settingsArrayCase.mcpServers.gsd, 'array mcpServers must be recovered to an object with gsd set');

  const settingsStringCase = { mcpServers: 'corrupted-string' };
  mergeGsdMcpServerIntoSettings(settingsStringCase);
  assert.ok(settingsStringCase.mcpServers.gsd, 'non-object mcpServers must be recovered to an object with gsd set');
});

// ---------------------------------------------------------------------------
// UPGRADE 3: MCP companion config — live install (both scopes) proves the
// end-to-end wiring through finishInstall, not just the unit function.
// ---------------------------------------------------------------------------

for (const scope of ['global', 'local']) {
  test(`augment --${scope}: settings.json registers the gsd MCP companion (UPGRADE 3)`, (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'augment', scope });
    t.after(() => cleanup(root));

    const settingsPath = path.join(configDir, 'settings.json');
    assert.ok(fs.existsSync(settingsPath), `${settingsPath} must exist`);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.mcpServers && settings.mcpServers.gsd, 'mcpServers.gsd must be present');
    assert.equal(settings.mcpServers.gsd.command, 'npx');
    assert.deepEqual(settings.mcpServers.gsd.args, ['-y', '-p', PACKAGE_NAME, 'gsd-mcp-server']);
  });
}

test('augment --global: reinstalling does not duplicate or clobber the gsd MCP companion entry (live-install idempotency)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-augment-mcp-idem-'));
  t.after(() => cleanup(root));

  const args = [INSTALL_SCRIPT, '--augment', '--global', '--config-dir', root];
  const env = installerEnv({ HOME: root, USERPROFILE: root });

  const first = runNode(args, { env, timeoutMs: 120000 });
  assert.strictEqual(first.exitCode, 0, `first install failed: ${first.stderr}`);

  const settingsPath = path.join(root, 'settings.json');
  const afterFirst = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.ok(afterFirst.mcpServers.gsd);
  // Simulate a user hand-edit of the gsd entry between installs.
  afterFirst.mcpServers.gsd.args.push('--custom-flag');
  fs.writeFileSync(settingsPath, JSON.stringify(afterFirst, null, 2) + '\n');

  const second = runNode(args, { env, timeoutMs: 120000 });
  assert.strictEqual(second.exitCode, 0, `second install failed: ${second.stderr}`);

  const afterSecond = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(Object.keys(afterSecond.mcpServers).length, 1, 'reinstall must not duplicate the gsd entry');
  assert.ok(afterSecond.mcpServers.gsd.args.includes('--custom-flag'),
    "a user-owned gsd override is never clobbered across reinstall (Hyrum's Law)");
});

test('augment --global: installing preserves a pre-existing unrelated mcpServers entry (live-install preservation)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-augment-mcp-preserve-'));
  fs.mkdirSync(root, { recursive: true });
  t.after(() => cleanup(root));

  // Pre-seed settings.json with a user's own MCP server BEFORE install runs.
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
    mcpServers: {
      other: { command: 'my-tool', args: ['--flag'] },
    },
  }, null, 2));

  const args = [INSTALL_SCRIPT, '--augment', '--global', '--config-dir', root];
  const result = runNode(args, {
    env: installerEnv({ HOME: root, USERPROFILE: root }),
    timeoutMs: 120000,
  });
  assert.strictEqual(result.exitCode, 0, `install failed: ${result.stderr}`);

  const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.mcpServers.other, { command: 'my-tool', args: ['--flag'] },
    "the user's pre-existing mcpServers entry must be preserved");
  assert.ok(settings.mcpServers.gsd, 'the gsd companion entry must also be present');
});

// ---------------------------------------------------------------------------
// Uninstall — symmetric cleanup for the MCP companion entry.
// ---------------------------------------------------------------------------

test('augment --global uninstall removes only the GSD-owned mcpServers.gsd entry, preserving user data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-augment-uninstall-'));
  t.after(() => cleanup(root));

  const env = installerEnv({ HOME: root, USERPROFILE: root });
  const installArgs = [INSTALL_SCRIPT, '--augment', '--global', '--config-dir', root];
  const installResult = runNode(installArgs, { env, timeoutMs: 120000 });
  assert.strictEqual(installResult.exitCode, 0, `install failed: ${installResult.stderr}`);

  // Seed user-owned data alongside GSD's contributions, post-install.
  const settingsPath = path.join(root, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.mcpServers['my-own-server'] = { command: 'my-tool', args: [] };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  const uninstallArgs = [INSTALL_SCRIPT, '--augment', '--global', '--config-dir', root, '--uninstall'];
  const uninstallResult = runNode(uninstallArgs, { env, timeoutMs: 120000 });
  assert.strictEqual(uninstallResult.exitCode, 0, `uninstall failed: ${uninstallResult.stderr}`);

  const settingsAfter = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settingsAfter.mcpServers && settingsAfter.mcpServers.gsd, undefined, 'gsd MCP entry removed');
  assert.deepEqual(settingsAfter.mcpServers['my-own-server'], { command: 'my-tool', args: [] },
    'user MCP server preserved');
});

'use strict';

/**
 * antigravity capability UPGRADES — ADR-1239 Phase B / #2096 (EoS/antigravity).
 *
 * Drives the user-reachable surface (spawned `bin/install.js` via
 * `runMinimalInstall`) plus targeted unit coverage to prove the two real
 * upgrades Antigravity contributes as part of the imperative-adapter
 * migration:
 *
 *   UPGRADE 1 — permission-writer: `configureAntigravityPermissions` writes
 *   Antigravity's native `{"permissions":{"allow":[...]}}` schema
 *   (antigravity.google/docs/cli/permissions) into the SAME settings.json
 *   GSD's own hook registration writes, non-destructively appending GSD's own
 *   read_file/command allow rules while preserving any existing user
 *   permissions (allow/deny/ask). Uninstall removes only the GSD-owned rules.
 *
 *   UPGRADE 2 — MCP companion config: `configureAntigravityMcpConfig` writes
 *   a standalone `mcp_config.json` (antigravity.google/docs/cli/gcli-migration)
 *   registering the `gsd` MCP server (`bin/gsd-mcp-server.js`, the SAME
 *   companion OpenCode/Kilo document/wire), non-destructively preserving any
 *   other user-configured `mcpServers` entries. Uninstall removes only the
 *   `gsd` entry.
 *
 * Both writers are NOT GSD_TEST_MODE-gated (mirrors Kilo's dispatch, not
 * OpenCode's) — runMinimalInstall strips GSD_TEST_MODE from the spawned
 * installer's env, so both fire during a "minimal" install too.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runNode } = require('./helpers/process-seam.cjs');

const { runMinimalInstall, installerEnv, INSTALL_SCRIPT } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');
const {
  toTildePosixPath,
  buildAntigravityAllowRules,
  configureAntigravityPermissions,
  configureAntigravityMcpConfig,
} = require('../bin/install.js');
const { PROTOCOL_VERSION } = require('../gsd-core/bin/lib/mcp-server.cjs');
const { PACKAGE_NAME } = require('../gsd-core/bin/lib/package-identity.cjs');

const MCP_SERVER_BIN = path.join(__dirname, '..', 'bin', 'gsd-mcp-server.js');

const ANTIGRAVITY_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'antigravity', 'capability.json'), 'utf8'),
);

// ---------------------------------------------------------------------------
// Descriptor boundary — permissionWriter wiring
// ---------------------------------------------------------------------------

test('capabilities/antigravity/capability.json declares runtime.permissionWriter: "antigravity"', () => {
  assert.equal(ANTIGRAVITY_CAP.runtime.permissionWriter, 'antigravity');
});

// ---------------------------------------------------------------------------
// UPGRADE 1: permission-writer unit coverage (toTildePosixPath / rule builder)
// ---------------------------------------------------------------------------

test('toTildePosixPath collapses a homedir-rooted path to "~/..." form', () => {
  const home = require('node:os').homedir();
  assert.equal(toTildePosixPath(path.join(home, '.gemini', 'antigravity')), '~/.gemini/antigravity');
});

test('toTildePosixPath leaves a non-homedir path as an absolute posix path', () => {
  assert.equal(toTildePosixPath('/var/tmp/some-config-dir'), '/var/tmp/some-config-dir');
});

test('buildAntigravityAllowRules emits the 4 documented "action(target)" rule strings', () => {
  const rules = buildAntigravityAllowRules('/tmp/ag-config');
  assert.deepEqual(rules, [
    'read_file(/tmp/ag-config/gsd-core/*)',
    'read_file(/tmp/ag-config/agents/gsd-*)',
    'read_file(/tmp/ag-config/skills/gsd-*)',
    'command(node /tmp/ag-config/hooks/*)',
  ]);
});

// ---------------------------------------------------------------------------
// UPGRADE 1: live install — settings.json permissions.allow (both scopes)
// ---------------------------------------------------------------------------

for (const scope of ['global', 'local']) {
  test(`antigravity --${scope}: settings.json permissions.allow contains GSD's rules (UPGRADE 1)`, (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'antigravity', scope });
    t.after(() => cleanup(root));

    const settingsPath = path.join(configDir, 'settings.json');
    assert.ok(fs.existsSync(settingsPath), `${settingsPath} must exist`);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.permissions && Array.isArray(settings.permissions.allow), 'permissions.allow must be an array');

    // Asserting on the exact rule strings here would require reproducing
    // toTildePosixPath's os.homedir()-relative substitution from OUTSIDE the
    // spawned installer subprocess: runMinimalInstall overrides that
    // subprocess's HOME to `root`, so for --global (configDir === root ===
    // that subprocess's HOME) every rule collapses to the bare `~/...` form,
    // while THIS test process's own (unrelated, real) os.homedir() would
    // reconstruct full absolute paths instead — a guaranteed mismatch that
    // has nothing to do with correctness. Assert on the documented rule
    // SHAPE (action + path suffix) instead, which holds regardless of
    // whether the prefix collapsed to `~` or stayed a full absolute path.
    const expectedShapes = [
      { action: 'read_file(', suffix: '/gsd-core/*)' },
      { action: 'read_file(', suffix: '/agents/gsd-*)' },
      { action: 'read_file(', suffix: '/skills/gsd-*)' },
      { action: 'command(node ', suffix: '/hooks/*)' },
    ];
    for (const { action, suffix } of expectedShapes) {
      const found = settings.permissions.allow.some((rule) => rule.startsWith(action) && rule.endsWith(suffix));
      assert.ok(found, `permissions.allow must include a rule shaped like "${action}...${suffix}" — got ${JSON.stringify(settings.permissions.allow)}`);
    }
    // Priority-scoping (deny/ask) is a user-owned decision — GSD never writes it.
    assert.equal(settings.permissions.deny, undefined, 'GSD must never write permissions.deny');
    assert.equal(settings.permissions.ask, undefined, 'GSD must never write permissions.ask');
  });
}

test('configureAntigravityPermissions is idempotent — a second call adds no duplicate rules', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-ag-perm-idem-'));
  t.after(() => cleanup(root));

  configureAntigravityPermissions(true, root);
  configureAntigravityPermissions(true, root);
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  assert.equal(settings.permissions.allow.length, new Set(settings.permissions.allow).size, 'no duplicate allow entries');
  assert.equal(settings.permissions.allow.length, buildAntigravityAllowRules(root).length);
});

test('configureAntigravityPermissions preserves a pre-existing user permissions block (allow/deny/ask)', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-ag-perm-preserve-'));
  t.after(() => cleanup(root));

  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
    permissions: {
      allow: ['command(git)'],
      deny: ['command(rm -rf)'],
      ask: ['command(*)'],
    },
    userCustomField: 'preserve-me',
  }, null, 2));

  configureAntigravityPermissions(true, root);

  const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.allow.includes('command(git)'), 'pre-existing allow entry preserved');
  assert.deepEqual(settings.permissions.deny, ['command(rm -rf)'], 'deny block untouched');
  assert.deepEqual(settings.permissions.ask, ['command(*)'], 'ask block untouched');
  assert.equal(settings.userCustomField, 'preserve-me', 'unrelated top-level user fields preserved');
  for (const rule of buildAntigravityAllowRules(root)) {
    assert.ok(settings.permissions.allow.includes(rule));
  }
});

// ---------------------------------------------------------------------------
// UPGRADE 2: MCP companion config — live install (both scopes)
// ---------------------------------------------------------------------------

for (const scope of ['global', 'local']) {
  test(`antigravity --${scope}: mcp_config.json registers the gsd MCP companion (UPGRADE 2)`, (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'antigravity', scope });
    t.after(() => cleanup(root));

    const mcpConfigPath = path.join(configDir, 'mcp_config.json');
    assert.ok(fs.existsSync(mcpConfigPath), `${mcpConfigPath} must exist`);

    const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
    assert.ok(mcpConfig.mcpServers && mcpConfig.mcpServers.gsd, 'mcpServers.gsd must be present');
    assert.equal(mcpConfig.mcpServers.gsd.command, 'npx');
    assert.deepEqual(mcpConfig.mcpServers.gsd.args, ['-y', '-p', PACKAGE_NAME, 'gsd-mcp-server']);
  });
}

test('configureAntigravityMcpConfig is idempotent — a second call does not clobber an existing gsd entry', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-ag-mcp-idem-'));
  t.after(() => cleanup(root));

  configureAntigravityMcpConfig(true, root);
  // Simulate a user hand-edit of the gsd entry after install.
  const configPath = path.join(root, 'mcp_config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.mcpServers.gsd.args.push('--custom-flag');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  configureAntigravityMcpConfig(true, root);

  const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.ok(after.mcpServers.gsd.args.includes('--custom-flag'), 'a user-owned gsd override is never clobbered (Hyrum\'s Law)');
});

test('configureAntigravityMcpConfig preserves a pre-existing unrelated mcpServers entry', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-ag-mcp-preserve-'));
  t.after(() => cleanup(root));

  fs.writeFileSync(path.join(root, 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      'my-own-server': { command: 'my-tool', args: ['--flag'] },
    },
  }, null, 2));

  configureAntigravityMcpConfig(true, root);

  const config = JSON.parse(fs.readFileSync(path.join(root, 'mcp_config.json'), 'utf8'));
  assert.deepEqual(config.mcpServers['my-own-server'], { command: 'my-tool', args: ['--flag'] });
  assert.ok(config.mcpServers.gsd);
});

// AC-style proof: the companion mcp_config.json points at (bin/gsd-mcp-server.js)
// is actually reachable, not just documented. Mirrors tests/gsd-mcp-server-bin.test.cjs
// exactly (same shim, same line-delimited JSON-RPC over stdio).
test('UPGRADE 2: gsd-mcp-server companion is reachable — spawn, initialize, tools/list over stdio', () => {
  const stdin = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ].join('\n') + '\n';

  const res = spawnSync(process.execPath, [MCP_SERVER_BIN], {
    input: stdin,
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, GSD_TEST_MODE: '1' },
  });

  assert.strictEqual(res.status, 0, `gsd-mcp-server must exit cleanly on stdin EOF; stderr: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 2, 'one response per request');
  assert.strictEqual(lines[0].result.protocolVersion, PROTOCOL_VERSION, 'initialize handshake succeeds');
  const toolNames = lines[1].result.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(
    toolNames,
    ['gsd_invoke_command', 'gsd_read_state', 'gsd_write_state'],
    'the companion the mcp_config.json entry connects to advertises the real GSD tool surface',
  );
});

// ---------------------------------------------------------------------------
// Uninstall — symmetric cleanup for both upgrades
// ---------------------------------------------------------------------------

test('antigravity --global uninstall removes only GSD-owned permissions.allow rules + mcpServers.gsd, preserving user data', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-ag-uninstall-'));
  t.after(() => cleanup(root));

  const args = [INSTALL_SCRIPT, '--antigravity', '--global', '--config-dir', root];
  const installResult = runNode(args, {
    env: installerEnv({ HOME: root, USERPROFILE: root }),
    timeoutMs: 120000,
  });
  assert.strictEqual(installResult.exitCode, 0, `install failed: ${installResult.stderr}`);

  // Seed user-owned data alongside GSD's contributions, post-install.
  const settingsPath = path.join(root, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.permissions.allow.push('command(git)');
  settings.permissions.deny = ['command(rm -rf)'];
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  const mcpConfigPath = path.join(root, 'mcp_config.json');
  const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
  mcpConfig.mcpServers['my-own-server'] = { command: 'my-tool', args: [] };
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');

  const uninstallArgs = [INSTALL_SCRIPT, '--antigravity', '--global', '--config-dir', root, '--uninstall'];
  const uninstallResult = runNode(uninstallArgs, {
    env: installerEnv({ HOME: root, USERPROFILE: root }),
    timeoutMs: 120000,
  });
  assert.strictEqual(uninstallResult.exitCode, 0, `uninstall failed: ${uninstallResult.stderr}`);

  const settingsAfter = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(settingsAfter.permissions.allow, ['command(git)'], 'GSD allow rules removed, user rule preserved');
  assert.deepEqual(settingsAfter.permissions.deny, ['command(rm -rf)'], 'user deny rule preserved');

  const mcpConfigAfter = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
  assert.equal(mcpConfigAfter.mcpServers.gsd, undefined, 'gsd MCP entry removed');
  assert.deepEqual(mcpConfigAfter.mcpServers['my-own-server'], { command: 'my-tool', args: [] }, 'user MCP server preserved');
});

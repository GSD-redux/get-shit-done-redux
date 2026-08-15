/**
 * Regression tests for OpenCode permission config handling.
 *
 * Ensures the installer does not crash when opencode.json uses the valid
 * top-level string form: "permission": "allow", and that path-specific
 * permissions are written against the actual resolved install directory.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { configureOpencodePermissions } = require('../bin/install.js');
const { PACKAGE_NAME } = require('../gsd-core/bin/lib/package-identity.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const envKeys = ['OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'XDG_CONFIG_HOME'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function restoreEnv(snapshot) {
  for (const key of envKeys) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

describe('configureOpencodePermissions', () => {
  let configDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-opencode-');
  });

  afterEach(() => {
    cleanup(configDir);
    restoreEnv(originalEnv);
  });

  test('does not crash or rewrite top-level string permissions', () => {
    const configPath = path.join(configDir, 'opencode.json');
    const original = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      permission: 'allow',
      skills: { paths: ['/tmp/skills'] },
    }, null, 2) + '\n';

    fs.writeFileSync(configPath, original);
    process.env.OPENCODE_CONFIG_DIR = configDir;

    assert.doesNotThrow(() => configureOpencodePermissions(true, configDir));
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), original);
  });

  test('adds path-specific read and external_directory permissions for object configs', () => {
    const configPath = path.join(configDir, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({ permission: {} }, null, 2) + '\n');
    process.env.OPENCODE_CONFIG_DIR = configDir;

    configureOpencodePermissions(true, configDir);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const gsdPath = `${configDir.replace(/\\/g, '/')}/gsd-core/*`;

    assert.strictEqual(config.permission.read[gsdPath], 'allow');
    assert.strictEqual(config.permission.external_directory[gsdPath], 'allow');
  });

  test('registers the companion MCP server (mcp.gsd) for object configs (#1682)', () => {
    const configPath = path.join(configDir, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({ permission: {} }, null, 2) + '\n');
    process.env.OPENCODE_CONFIG_DIR = configDir;

    configureOpencodePermissions(true, configDir);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(config.mcp.gsd, {
      type: 'local',
      command: ['npx', '-y', '-p', PACKAGE_NAME, 'gsd-mcp-server'],
      enabled: true,
    });
  });

  test('does not clobber a user-defined mcp.gsd entry (#1682)', () => {
    const configPath = path.join(configDir, 'opencode.json');
    const userMcp = { type: 'local', command: ['node', '/custom/server.js'], enabled: false };
    fs.writeFileSync(configPath, JSON.stringify({ permission: {}, mcp: { gsd: userMcp } }, null, 2) + '\n');
    process.env.OPENCODE_CONFIG_DIR = configDir;

    configureOpencodePermissions(true, configDir);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // User's own mcp.gsd is preserved untouched (Hyrum's Law — non-clobbering).
    assert.deepEqual(config.mcp.gsd, userMcp);
  });

  test('finishInstall passes the REAL resolved config dir to OpenCode permissions (not a hardcoded path)', () => {
    // Behavioral replacement for a source-grep assertion (#3466): spawns the
    // real installer CLI end-to-end (`bin/install.js --opencode --global
    // --config-dir <configDir>`) — the only code path that actually reaches
    // finishInstall's `configureOpencodePermissions(isGlobal, configDir);`
    // call site (the exported `install()` function alone does NOT call
    // finishInstall — only the CLI/installAllRuntimes flow does, and that
    // flow is also where the GSD_TEST_MODE gate on this writer is normally
    // active, so a real spawn — whose env deliberately excludes
    // GSD_TEST_MODE via installerEnv() — is required to exercise it) —
    // then asserts the resulting opencode.json's permission paths are
    // anchored on THAT exact config dir. A hardcoded or stale configDir at
    // the finishInstall call site would write permission paths anchored on
    // the wrong directory (or fail to find/produce opencode.json at all),
    // so this can only pass if the real, per-call configDir reaches
    // configureOpencodePermissions.
    const result = runNode(
      [INSTALL_SCRIPT, '--opencode', '--global', '--config-dir', configDir],
      { env: installerEnv(), timeoutMs: INSTALL_TIMEOUT_MS },
    );
    assert.strictEqual(
      result.exitCode, 0,
      `installer must exit 0 for --opencode --global\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );

    const configPath = path.join(configDir, 'opencode.json');
    assert.ok(
      fs.existsSync(configPath),
      'finishInstall must write opencode.json into the resolved config dir'
    );
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const gsdPath = `${configDir.replace(/\\/g, '/')}/gsd-core/*`;
    assert.strictEqual(
      config.permission?.read?.[gsdPath], 'allow',
      'finishInstall must call configureOpencodePermissions with the REAL resolved configDir, ' +
      `not a hardcoded path — expected a read permission entry for ${gsdPath}`
    );
    assert.strictEqual(
      config.permission?.external_directory?.[gsdPath], 'allow',
      `expected an external_directory permission entry for ${gsdPath}`
    );
  });
});

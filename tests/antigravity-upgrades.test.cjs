// docs-guard-exempt: docs/cli/... substrings are external antigravity.google URL citations in comments, not repo paths.
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

// ---------------------------------------------------------------------------
// #4332 — guard vocabulary: matchers, payload envelope, and the inlined copies
//
// `install --antigravity` translated the hook EVENT names (BeforeTool /
// AfterTool, ADR-857/1016 #1077) but left the matchers and the guards' payload
// reads in Claude Code's vocabulary. Every guard was registered, spawned, and
// then exited 0 on `data.tool_name === undefined` — the #2304 defect (Kimi)
// one runtime over, with Antigravity's nested `toolCall` envelope on top.
// ---------------------------------------------------------------------------

const HOOKS_SURFACE = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const { toAntigravityMatcher, ANTIGRAVITY_TOOL_MATCHERS, applySettingsJsonHooks } = HOOKS_SURFACE;

// Claude Code tool names that must never survive into an Antigravity matcher.
// Antigravity's own vocabulary is write_to_file / replace_file_content /
// multi_replace_file_content / view_file / run_command / grep_search.
const CLAUDE_TOOL_TOKENS = ['Write', 'Edit', 'MultiEdit', 'Read', 'Bash', 'Grep'];

test('toAntigravityMatcher translates every Claude tool token GSD registers (#4332)', () => {
  assert.equal(toAntigravityMatcher('Write|Edit'), 'write_to_file|replace_file_content');
  assert.equal(toAntigravityMatcher('Write'), 'write_to_file');
  assert.equal(toAntigravityMatcher('Read'), 'view_file');
  assert.equal(toAntigravityMatcher('Read|Grep|Bash'), 'view_file|grep_search|run_command');
  assert.equal(
    toAntigravityMatcher('Write|Edit|MultiEdit'),
    'write_to_file|replace_file_content|multi_replace_file_content');
});

test('toAntigravityMatcher is idempotent — a reinstall over a migrated settings.json is a no-op (#4332)', () => {
  for (const matcher of ['Write|Edit', 'Read|Grep|Bash', 'Bash|Edit|Write|MultiEdit|Agent|Task']) {
    const once = toAntigravityMatcher(matcher);
    assert.equal(toAntigravityMatcher(once), once, `${matcher} must survive a second translation`);
  }
});

test('a token with no Antigravity equivalent is carried through, never dropped (#4332)', () => {
  // Antigravity exposes no dispatch tool, so Agent|Task has no translation.
  // Dropping it would leave gsd-agent-isolation-guard registered against an
  // EMPTY matcher — worse than the dormancy this fix removes.
  assert.equal(toAntigravityMatcher('Agent|Task'), 'Agent|Task');
  assert.equal(
    toAntigravityMatcher('Bash|Edit|Write|MultiEdit|Agent|Task'),
    'run_command|replace_file_content|write_to_file|multi_replace_file_content|Agent|Task');
});

test('translation collapses duplicates rather than emitting a repeated token (#4332)', () => {
  assert.equal(toAntigravityMatcher('Write|write_to_file'), 'write_to_file');
});

test('ANTIGRAVITY_TOOL_MATCHERS is a Map, so prototype keys cannot resolve (#4332)', () => {
  assert.ok(ANTIGRAVITY_TOOL_MATCHERS instanceof Map);
  for (const key of ['constructor', '__proto__', 'toString']) {
    assert.equal(ANTIGRAVITY_TOOL_MATCHERS.get(key), undefined);
    assert.equal(toAntigravityMatcher(key), key, `${key} must fall through untranslated`);
  }
});

test(`antigravity --global: every registered GSD matcher is in Antigravity's vocabulary (#4332)`, (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'antigravity', scope: 'global' });
  t.after(() => cleanup(root));

  const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
  assert.ok(settings.hooks && typeof settings.hooks === 'object', 'settings.hooks must exist');

  const gsdEntries = [];
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const isGsd = Array.isArray(entry.hooks) &&
        entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes('gsd-'));
      if (isGsd && typeof entry.matcher === 'string') gsdEntries.push({ event, matcher: entry.matcher });
    }
  }
  assert.ok(gsdEntries.length > 0, 'the install must register at least one matched GSD hook');

  for (const { event, matcher } of gsdEntries) {
    // FileChanged carries a path matcher (config.json), not a tool matcher.
    if (event === 'FileChanged') continue;
    for (const token of matcher.split('|')) {
      assert.ok(
        !CLAUDE_TOOL_TOKENS.includes(token),
        `${event} matcher "${matcher}" still carries Claude Code's "${token}" — the guard cannot fire on Antigravity`);
    }
  }

  // The events themselves stay in Antigravity's dialect (unchanged by #4332).
  assert.ok(Array.isArray(settings.hooks.BeforeTool), 'BeforeTool must be the PreToolUse dialect');
});

// Registration is guarded by `fs.existsSync(<hook file>)`, so a target dir that
// does not exist exercises the MIGRATION pass alone — which is the whole point
// of these two cases: an install made before #4332 already has its entries and
// never reaches the registration branches.
function migrationOnlyOpts({ runtime, hookEvents }) {
  return {
    runtime,
    hookEvents,
    isGlobal: true,
    targetDir: path.join(require('node:os').tmpdir(), 'gsd-4332-no-such-target'),
    postToolEvent: hookEvents === 'gemini' ? 'AfterTool' : 'PostToolUse',
    hooksSurface: 'settings-json',
    updateCheckCommand: null,
    contextMonitorCommand: null,
    promptGuardCommand: null,
    readGuardCommand: null,
    readInjectionScannerCommand: null,
    configReloadCommand: null,
    hookOpts: {},
    localCmd: () => null,
    localShellCmd: () => null,
  };
}

test('an existing install carrying Claude matchers is migrated in place (#4332)', () => {
  // The `has<X>Hook` checks skip re-registration when a hook is already
  // present, so without a migration pass an install made before this fix would
  // stay dormant forever.
  const settings = {
    hooks: {
      BeforeTool: [
        { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node ~/.gemini/antigravity/hooks/gsd-read-guard.js' }] },
        { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node /home/u/my-own-hook.js' }] },
      ],
      AfterTool: [
        { matcher: 'Read', hooks: [{ type: 'command', command: 'node ~/.gemini/antigravity/hooks/gsd-read-injection-scanner.js' }] },
      ],
    },
  };
  applySettingsJsonHooks(settings, migrationOnlyOpts({ runtime: 'antigravity', hookEvents: 'gemini' }));

  assert.equal(settings.hooks.BeforeTool[0].matcher, 'write_to_file|replace_file_content',
    'the GSD guard entry must be migrated');
  assert.equal(settings.hooks.BeforeTool[1].matcher, 'Write|Edit',
    "a user's own hook keeps the matcher the user wrote");
  assert.equal(settings.hooks.AfterTool[0].matcher, 'view_file');
});

test('the matcher migration does not touch a non-gemini runtime (#4332)', () => {
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/gsd-read-guard.js' }] },
      ],
    },
  };
  applySettingsJsonHooks(settings, migrationOnlyOpts({ runtime: 'claude', hookEvents: 'claude' }));
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Write|Edit');
});

// ── the inlined normalizeAntigravityPayload copies ──────────────────────────

// allow-test-rule: source-text-is-the-product #4332 — like the Kimi parity test
// (tests/kimi-guard-normalization-parity.test.cjs), the inlined copies have no
// runtime binding, so their source text IS the artifact under test.
const AG_MARKER = 'const ANTIGRAVITY_TOOL_NAMES';
const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const AG_BLOCK_FILES = fs
  .readdirSync(HOOKS_DIR)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => fs.readFileSync(path.join(HOOKS_DIR, f), 'utf8').includes(AG_MARKER))
  .map((f) => `hooks/${f}`)
  .sort();

// The seven guards #4332 normalizes. A scan that misses one of these is a
// broken scan, not a passing test.
const AG_NORMALIZED_GUARDS = [
  'hooks/gsd-prompt-guard.js',
  'hooks/gsd-read-guard.js',
  'hooks/gsd-read-injection-scanner.js',
  'hooks/gsd-secret-read-guard.js',
  'hooks/gsd-workflow-guard.js',
  'hooks/gsd-worktree-path-guard.js',
  'hooks/gsd-write-guard.js',
];

function extractAgBlock(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = src.indexOf(AG_MARKER);
  assert.notEqual(start, -1, `${file}: ${AG_MARKER} block not found`);
  const end = src.indexOf('\n}\n', src.indexOf('function normalizeAntigravityPayload', start));
  assert.notEqual(end, -1, `${file}: normalizeAntigravityPayload block not terminated`);
  return src.slice(start, end);
}

test('every guard the KIMI block reaches also carries the ANTIGRAVITY block (#4332)', () => {
  for (const guard of AG_NORMALIZED_GUARDS) {
    assert.ok(AG_BLOCK_FILES.includes(guard), `${guard} must carry the ${AG_MARKER} block`);
  }
});

test('the inlined ANTIGRAVITY blocks are byte-identical across guards (#4332)', () => {
  const [first, ...rest] = AG_BLOCK_FILES;
  const reference = extractAgBlock(first);
  for (const file of rest) {
    assert.equal(extractAgBlock(file), reference,
      `${file}'s copy has drifted from ${first}'s — the copies have no runtime binding, this test is the binding`);
  }
});

test('every guard runs the Antigravity normalizer before the Kimi one (#4332)', () => {
  for (const guard of AG_NORMALIZED_GUARDS) {
    const src = fs.readFileSync(path.join(__dirname, '..', guard), 'utf8');
    assert.match(src, /normalizeKimiPayload\(normalizeAntigravityPayload\(JSON\.parse\(/,
      `${guard} parses its payload without lifting Antigravity's envelope first`);
  }
});


// ── behavior of the inlined normalizer ──────────────────────────────────────

// allow-test-rule: source-text-is-the-product #4332 — normalizeAntigravityPayload
// is inlined per hook with no require()-able binding (same rationale as the Kimi
// block), so the only way to exercise it is to extract and eval it, mirroring
// tests/kimi-normalize-payload.property.test.cjs.
function loadAntigravityNormalizer() {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(HOOKS_DIR, 'gsd-worktree-path-guard.js'), 'utf8');
  const start = src.indexOf(AG_MARKER);
  assert.notEqual(start, -1, `${AG_MARKER} block not found in hook source`);
  const endMarker = '  return data;\n}';
  const end = src.indexOf(endMarker, src.indexOf('function normalizeAntigravityPayload', start));
  assert.notEqual(end, -1, 'normalizeAntigravityPayload end not found in hook source');
  const ctx = { module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(
    `${src.slice(start, end + endMarker.length)}\nmodule.exports = { normalizeAntigravityPayload, ANTIGRAVITY_TOOL_NAMES };`,
    ctx);
  return ctx.module.exports;
}

const { normalizeAntigravityPayload, ANTIGRAVITY_TOOL_NAMES } = loadAntigravityNormalizer();

test('extraction floor — the evaluated block is a working normalizer (#4332)', () => {
  assert.equal(typeof normalizeAntigravityPayload, 'function');
  assert.ok(ANTIGRAVITY_TOOL_NAMES.size > 0, 'ANTIGRAVITY_TOOL_NAMES extracted empty');
  assert.ok(ANTIGRAVITY_TOOL_NAMES.has('write_to_file'));
});

test("Antigravity's nested envelope is lifted into the shape guards read (#4332)", () => {
  const out = normalizeAntigravityPayload({
    toolCall: { name: 'write_to_file', args: { AbsolutePath: '/repo/src/a.ts', TargetFile: 'src/a.ts' } },
    conversationId: 'conv-1',
  });
  assert.equal(out.tool_name, 'Write');
  assert.equal(out.tool_input.file_path, '/repo/src/a.ts');
  assert.equal(out.session_id, 'conv-1');
});

test('AbsolutePath is authoritative over TargetFile, in either key order (#4332)', () => {
  // Same invariant as Kimi's `path` over a model-supplied `file_path`
  // (#2547/#2752): a guard must inspect the path that will actually be
  // written, never a relative sibling that resolves somewhere else.
  for (const args of [
    { AbsolutePath: '/repo/real.ts', TargetFile: '../escape.ts' },
    { TargetFile: '../escape.ts', AbsolutePath: '/repo/real.ts' },
  ]) {
    const out = normalizeAntigravityPayload({ toolCall: { name: 'replace_file_content', args } });
    assert.equal(out.tool_name, 'Edit');
    assert.equal(out.tool_input.file_path, '/repo/real.ts');
  }
});

test('every Antigravity file/command tool resolves to the name guards check (#4332)', () => {
  const expected = [
    ['write_to_file', 'Write'],
    ['replace_file_content', 'Edit'],
    ['multi_replace_file_content', 'Edit'],
    ['view_file', 'Read'],
    ['run_command', 'Bash'],
    ['grep_search', 'Grep'],
  ];
  for (const [antigravityName, claudeName] of expected) {
    const out = normalizeAntigravityPayload({ toolCall: { name: antigravityName, args: {} } });
    assert.equal(out.tool_name, claudeName, `${antigravityName} must normalize to ${claudeName}`);
  }
});

test('a run_command payload exposes its command line where guards read it (#4332)', () => {
  const out = normalizeAntigravityPayload({ toolCall: { name: 'run_command', args: { CommandLine: 'git commit -m x' } } });
  assert.equal(out.tool_name, 'Bash');
  assert.equal(out.tool_input.command, 'git commit -m x');
});

test('normalization is total and never throws on what JSON can express (#4332)', () => {
  const hostile = [
    null, undefined, 0, '', [], true,
    { toolCall: null }, { toolCall: 'x' }, { toolCall: {} },
    { toolCall: { name: 42 } },
    { toolCall: { name: 'write_to_file' } },
    { toolCall: { name: 'write_to_file', args: null } },
    { toolCall: { name: 'write_to_file', args: [] } },
    { toolCall: { name: 'write_to_file', args: { AbsolutePath: [] } } },
    { toolCall: { name: 'write_to_file', args: { AbsolutePath: { toString: null } } } },
    { toolCall: { name: 'unknown_tool', args: { AbsolutePath: '/x' } } },
  ];
  for (const payload of hostile) {
    assert.doesNotThrow(() => normalizeAntigravityPayload(payload), `threw on ${JSON.stringify(payload)}`);
  }
  // A crash here would land in each guard's outer `catch { exit(0) }` — the
  // crash-to-allow downgrade #2547 closed for Kimi.
  const unknown = normalizeAntigravityPayload({ toolCall: { name: 'unknown_tool' }, tool_name: 'Write' });
  assert.equal(unknown.tool_name, 'Write', 'an unknown tool must not rewrite an existing tool_name');
});

test('a Claude Code or Kimi payload passes through untouched (#4332)', () => {
  const claude = { tool_name: 'Write', tool_input: { file_path: '/a.ts' }, session_id: 's1' };
  assert.deepEqual(normalizeAntigravityPayload({ ...claude }), claude);
  const kimi = { tool_name: 'WriteFile', tool_input: { path: '/a.ts' } };
  assert.deepEqual(normalizeAntigravityPayload({ ...kimi }), kimi);
});

test('a real session_id is never overwritten by conversationId (#4332)', () => {
  const out = normalizeAntigravityPayload({
    toolCall: { name: 'view_file', args: { AbsolutePath: '/a.ts' } },
    session_id: 'real', conversationId: 'conv',
  });
  assert.equal(out.session_id, 'real');
});

test("each guard's matcher vocabulary has a reverse entry in its name map (#4332)", () => {
  // The installer registers Antigravity matchers; the guards read the payload.
  // A vocabulary extension that updates one side without the other is exactly
  // the #2304 failure mode, so bind them here.
  for (const [claudeName, antigravityName] of ANTIGRAVITY_TOOL_MATCHERS) {
    // MultiEdit is the one non-identity inverse, deliberately: the guards
    // check `tool_name === 'Edit'`, so both replace_file_content and
    // multi_replace_file_content normalize to Edit — exactly what Kimi's
    // StrReplaceFile does for Edit|MultiEdit.
    const expected = claudeName === 'MultiEdit' ? 'Edit' : claudeName;
    assert.equal(
      ANTIGRAVITY_TOOL_NAMES.get(antigravityName), expected,
      `the guards' ANTIGRAVITY_TOOL_NAMES has no ${expected} entry for ${antigravityName} (registered as the ${claudeName} matcher) — the matcher would fire onto a dormant guard`);
  }
});

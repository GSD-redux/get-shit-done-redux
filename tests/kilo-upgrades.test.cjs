'use strict';

/**
 * kilo capability UPGRADES — ADR-1239 Phase D / #2093 (EoS/kilo).
 *
 * Drives the user-reachable surface (spawned `bin/install.js` via
 * `runMinimalInstall`) plus targeted unit coverage to prove the four real
 * upgrades Kilo contributes as part of the imperative-adapter migration:
 *
 *   UPGRADE 1 — native hook-bus plugin: `.kilo/plugins/gsd-core.js`, a
 *   byte-identical copy of `.opencode/plugins/gsd-core.js` (Kilo is an
 *   OpenCode fork sharing the same plugin/extension event bus).
 *
 *   UPGRADE 2 — active-model routing: `convertClaudeToKiloFrontmatter` now
 *   emits a `model:` field from the resolved model override instead of
 *   always stripping it (mirrors the OpenCode upgrade, #2256).
 *
 *   UPGRADE 3 — MCP companion documented + reachable: `docs/how-to/connect-gsd-mcp-server.md`
 *   covers Kilo's `mcp`-keyed config (not `mcpServers`), and the companion the
 *   doc points at (`bin/gsd-mcp-server.js`) is proven live by spawning it and
 *   performing a real initialize + tools/list handshake (AC4: "test: connect
 *   and list tools") — mirrors tests/gsd-mcp-server-bin.test.cjs exactly.
 *
 *   UPGRADE 4 — named subagent dispatch: GSD's specialist agents install as
 *   `<configDir>/agents/gsd-*.md` with `mode: subagent` + a `permission:`
 *   block — the slug Kilo's Task tool dispatches by.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runMinimalInstall, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');
const { listAgentFiles } = require('./helpers/agent-roster.cjs');
const { convertClaudeToKiloFrontmatter } = require('../bin/install.js');
const { PROTOCOL_VERSION } = require('../gsd-core/bin/lib/mcp-server.cjs');

const MCP_SERVER_BIN = path.join(__dirname, '..', 'bin', 'gsd-mcp-server.js');

const KILO_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'kilo', 'capability.json'), 'utf8'),
);

const ADAPTER_SRC = path.join(__dirname, '..', '.kilo', 'plugins', 'gsd-core.js');
const OPENCODE_ADAPTER_SRC = path.join(__dirname, '..', '.opencode', 'plugins', 'gsd-core.js');

/** Extract the YAML frontmatter block (between the first pair of `---` lines), or null. */
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// UPGRADE 1: native hook-bus plugin (.kilo/plugins/gsd-core.js)
// ---------------------------------------------------------------------------

for (const scope of ['global', 'local']) {
  test(`kilo --${scope}: installs .../plugins/gsd-core.js byte-identical to the repo source (UPGRADE 1)`, (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'kilo', scope });
    t.after(() => cleanup(root));

    const installedPluginPath = path.join(configDir, 'plugins', 'gsd-core.js');
    assert.ok(fs.existsSync(installedPluginPath), `${installedPluginPath} must exist`);

    const installed = fs.readFileSync(installedPluginPath);
    const source = fs.readFileSync(ADAPTER_SRC);
    assert.ok(installed.equals(source), 'installed plugin must byte-equal the repo .kilo/plugins/gsd-core.js source');
  });
}

// Faithful emulation of a plugin loader: `getServerPlugin` accepts a bare
// function OR an object with a `.server` function (mirrors the OpenCode
// loader contract Kilo forked, tests/opencode-plugin-adapter.test.cjs).
function getServerPlugin(entry) {
  if (typeof entry === 'function') return entry;
  if (entry && typeof entry === 'object' && typeof entry.server === 'function') return entry.server;
  return null;
}
function loaderExtract(mod) {
  const servers = [];
  for (const entry of Object.values(mod)) {
    const s = getServerPlugin(entry);
    if (!s) throw new TypeError('Plugin export is not a function');
    servers.push(s);
  }
  return servers;
}

test('.kilo/plugins/gsd-core.js loads as raw CommonJS and exposes id "gsd-core" + server._internals (UPGRADE 1)', () => {
  const mod = require(ADAPTER_SRC);
  assert.equal(mod.id, 'gsd-core');
  // NON-ENUMERABLE so it never lands in Object.values (would throw in the loader loop).
  assert.ok(!Object.keys(mod).includes('id'), 'id must be non-enumerable');
  const servers = loaderExtract(mod); // must not throw
  assert.equal(servers.length, 1);
  assert.equal(typeof servers[0], 'function');
  assert.equal(typeof mod.server._internals, 'object');
  assert.ok(mod.server._internals, 'server._internals must be present');
});

// DEFECT.GENERATIVE-FIX parity guard: .kilo/plugins/gsd-core.js is a deliberate
// byte-copy of .opencode/plugins/gsd-core.js (Kilo is an OpenCode fork sharing
// the same plugin/extension event bus, see the UPGRADE 1 doc comment above).
// Nothing enforces that copy relationship — a future edit to either file that
// forgets its twin would silently drift the two runtimes apart. This fails the
// instant that happens.
test('.kilo/plugins/gsd-core.js stays byte-identical to .opencode/plugins/gsd-core.js (Kilo is an OpenCode fork; parity guard, UPGRADE 1)', () => {
  const kilo = fs.readFileSync(ADAPTER_SRC, 'utf8');
  const opencode = fs.readFileSync(OPENCODE_ADAPTER_SRC, 'utf8');
  assert.equal(
    kilo,
    opencode,
    '.kilo/plugins/gsd-core.js and .opencode/plugins/gsd-core.js must stay byte-identical — ' +
      'Kilo is an OpenCode fork and intentionally reuses the same plugin verbatim; if you edited ' +
      'one, mirror the change into the other (or this guard will keep failing).',
  );
});

// ---------------------------------------------------------------------------
// UPGRADE 2: active-model routing (convertClaudeToKiloFrontmatter)
// ---------------------------------------------------------------------------

const SAMPLE_AGENT = `---
name: gsd-executor
description: Executes GSD plans with atomic commits
tools: Read, Write, Edit, Bash, Grep, Glob
color: yellow
---

<role>
You are a GSD plan executor.
</role>`;

const SAMPLE_COMMAND = `---
name: gsd-execute-phase
description: Execute all plans in a phase
allowed-tools:
  - Read
  - Write
  - Bash
---

Execute the phase plan.`;

test('UPGRADE 2: convertClaudeToKiloFrontmatter emits model: when isAgent + modelOverride is provided', () => {
  const result = convertClaudeToKiloFrontmatter(SAMPLE_AGENT, { isAgent: true, modelOverride: 'anthropic/claude-sonnet-5' });
  const frontmatter = result.split('---')[1];
  assert.match(frontmatter, /^model: anthropic\/claude-sonnet-5$/m, 'model: field must carry the resolved override');
});

test('UPGRADE 2: convertClaudeToKiloFrontmatter emits NO model: when isAgent + modelOverride is null', () => {
  const result = convertClaudeToKiloFrontmatter(SAMPLE_AGENT, { isAgent: true, modelOverride: null });
  const frontmatter = result.split('---')[1];
  assert.ok(!/^model:/m.test(frontmatter), 'model: field must be absent when no override is resolved');
});

test('UPGRADE 2: convertClaudeToKiloFrontmatter emits NO model: for commands, even with a modelOverride (commands strip)', () => {
  const result = convertClaudeToKiloFrontmatter(SAMPLE_COMMAND, { isAgent: false, modelOverride: 'x' });
  const frontmatter = result.split('---')[1];
  assert.ok(!/^model:/m.test(frontmatter), 'commands never carry a model: field, regardless of modelOverride');
});

// Note: a bare runMinimalInstall does NOT configure a runtime model_overrides/
// model_profile_overrides config, so installed agents will NOT carry a model:
// line from a plain install — that is expected (readGsdEffectiveModelOverrides
// / readGsdRuntimeProfileResolver resolve to nothing) and is NOT a regression.
// The unit tests above are the correct surface for proving U2's "stop
// stripping, emit requested model" behavior change.

// ---------------------------------------------------------------------------
// UPGRADE 3: MCP companion documented
// ---------------------------------------------------------------------------

// allow-test-rule: docs-parity (#2093) — docs/how-to/connect-gsd-mcp-server.md
// must document Kilo's real mcp-keyed config (not mcpServers); the doc prose IS
// the canonical statement of that fact and there is no runtime API to enumerate
// it, so reading the file and asserting on its text is the only parity check
// available.
test('UPGRADE 3: docs/how-to/connect-gsd-mcp-server.md documents Kilo\'s mcp-keyed config', () => {
  const docPath = path.join(__dirname, '..', 'docs', 'how-to', 'connect-gsd-mcp-server.md');
  const doc = fs.readFileSync(docPath, 'utf8');
  assert.match(doc, /Kilo/, 'doc must mention Kilo');
  assert.match(doc, /`mcp` key \(\*\*not\*\* `mcpServers`\)/,
    'doc must call out the mcp (not mcpServers) key for Kilo/OpenCode');
  assert.ok(doc.includes('"mcp"'), 'doc must show the literal "mcp" config key');
  assert.ok(doc.includes('opencode.jsonc') || doc.includes('opencode.json'),
    'doc must name Kilo\'s native config file (shared with OpenCode\'s schema)');
});

// AC4 ("test: connect and list tools"): prove the companion Kilo's `mcp` config
// points at (bin/gsd-mcp-server.js) is actually reachable, not just documented.
// Mirrors tests/gsd-mcp-server-bin.test.cjs's spawn/handshake mechanism exactly
// (same shim, same line-delimited JSON-RPC over stdio, same clean-exit-on-EOF
// contract) rather than reinventing the protocol handshake.
test('UPGRADE 3: gsd-mcp-server companion is reachable — spawn, initialize, tools/list over stdio (AC4)', () => {
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
  assert.strictEqual(lines[0].id, 1);
  assert.strictEqual(lines[0].result.protocolVersion, PROTOCOL_VERSION, 'initialize handshake succeeds');

  const toolNames = lines[1].result.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(
    toolNames,
    ['gsd_invoke_command', 'gsd_read_state', 'gsd_write_state'],
    'the companion Kilo\'s mcp config connects to advertises the real GSD tool surface',
  );
});

// ---------------------------------------------------------------------------
// UPGRADE 4: named subagent dispatch (agents/*.md, mode: subagent)
// ---------------------------------------------------------------------------

const KILO_AGENT_PERMISSION_KEYS = [
  'read', 'edit', 'bash', 'grep', 'glob', 'task',
  'webfetch', 'websearch', 'skill', 'question', 'todowrite', 'list', 'codesearch', 'lsp',
];

for (const scope of ['global', 'local']) {
  test(`kilo --${scope}: native agents/*.md subagent projection with mode: subagent (UPGRADE 4)`, (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'kilo', scope });
    t.after(() => cleanup(root));

    const agentsDir = path.join(configDir, 'agents');
    assert.ok(fs.existsSync(agentsDir), `${agentsDir} must exist`);

    const expectedNames = listAgentFiles();
    assert.equal(expectedNames.length, 34,
      'sanity: shipped GSD agent roster is 34 files — update this boundary if the roster changes');

    const installedFiles = fs.readdirSync(agentsDir)
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(installedFiles.length >= expectedNames.length,
      `expected at least ${expectedNames.length} installed agents under ${agentsDir}, got ${installedFiles.length}`);
    for (const name of expectedNames) {
      assert.ok(installedFiles.includes(`${name}.md`), `${name}.md must be installed under ${agentsDir}`);
    }

    for (const known of ['gsd-code-reviewer', 'gsd-planner', 'gsd-executor']) {
      const filePath = path.join(agentsDir, `${known}.md`);
      assert.ok(fs.existsSync(filePath), `${filePath} must exist`);

      const content = fs.readFileSync(filePath, 'utf8');
      const fm = parseFrontmatter(content);
      assert.ok(fm, `${known}.md must have YAML frontmatter`);

      assert.match(fm, /^name:\s*\S+/m, `${known}.md frontmatter must declare name:`);
      assert.match(fm, /^mode:\s*subagent\s*$/m,
        `${known}.md frontmatter must declare mode: subagent (the slug Kilo's Task tool dispatches by)`);

      assert.match(fm, /^permission:\s*$/m, `${known}.md frontmatter must declare a permission: block`);
      for (const key of KILO_AGENT_PERMISSION_KEYS) {
        assert.match(fm, new RegExp(`^\\s+${key}:\\s*(allow|deny)\\s*$`, 'm'),
          `${known}.md permission: block must declare ${key}: allow|deny`);
      }

      // Branding-residue checks are scoped to the FRONTMATTER — the part the
      // opencode/kilo converter fully rewrites into Kilo-native form. The agent
      // BODY legitimately retains Claude-Code source references byte-identical to
      // opencode's installed agents (verified): the shared runtime-launcher shell
      // preamble's git-root `.claude/` fallback
      // (`${RUNTIME_DIR:-$(git rev-parse --show-toplevel)/.claude/…}`) and prose
      // product-name mentions (e.g. "…inside a Claude Code worktree…"). These are
      // family-wide launcher/prose artifacts, not kilo conversion defects — the
      // opencode/kilo family, unlike qwen's aggressive converter, does not rewrite
      // body prose.
      assert.ok(!fm.includes('CLAUDE.md'), `${known}.md frontmatter must not contain residual "CLAUDE.md"`);
      assert.ok(!fm.includes('Claude Code'), `${known}.md frontmatter must not contain residual "Claude Code"`);
      assert.ok(!fm.includes('.claude/'), `${known}.md frontmatter must not contain residual ".claude/"`);
    }
  });
}

// -- boundary/negative: hooksSurface:'none' + subagentToolkit stays undocumented

test('capabilities/kilo/capability.json extendedHookEvents is exactly [] (hooksSurface: "none") and dispatch.subagentToolkit stays "undocumented"', () => {
  assert.deepEqual(KILO_CAP.runtime.extendedHookEvents, []);
  assert.equal(KILO_CAP.runtime.hooksSurface, 'none');
  assert.equal(KILO_CAP.runtime.hostIntegration.dispatch.subagentToolkit, 'undocumented');
});

// ---------------------------------------------------------------------------
// #2305: the shared guard hooks Kilo's native plugin spawns must be STAGED.
//
// Kilo's capability descriptor used to declare BOTH hostBehaviors.nativePlugin
// (a plugin that spawns the shared PreToolUse guard scripts as subprocesses)
// AND hostBehaviors.skipSharedHooksInstall:true (which suppresses staging of
// hooks/*.js into the config dir). The plugin's runHook treats an absent hook
// script as a silent allow, so every guard it spawned no-opped on a normal
// Kilo install. OpenCode (same plugin, hooks staged) is the reference shape.
// ---------------------------------------------------------------------------

// hooks/dist is gitignored and built; the scoped CI lane does not run
// build:hooks, so a real install there would stage no hooks/ dir. Build it
// idempotently (mirrors golden-install-parity + install-minimal-hooks).
before(() => {
  const build = spawnSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf8' });
  assert.equal(build.status, 0, `build:hooks failed: ${build.stderr}`);
});

// The three PreToolUse guards the plugin spawns that ship today. When a new
// guard lands on the plugin's dispatch path, add it here.
const PLUGIN_GUARD_HOOKS = [
  'gsd-prompt-guard.js',
  'gsd-read-guard.js',
  'gsd-worktree-path-guard.js',
  'gsd-workflow-guard.js',
];

for (const scope of ['global', 'local']) {
  test(`kilo --${scope}: stages the guard hook scripts where the native plugin resolves them (#2305)`, (t) => {
    const { manifest, configDir, root } = runMinimalInstall({ runtime: 'kilo', scope });
    t.after(() => cleanup(root));

    // The shared hooks bundle lands in the config dir, next to gsd-core/.
    for (const hook of PLUGIN_GUARD_HOOKS) {
      const hookPath = path.join(configDir, 'hooks', hook);
      assert.ok(fs.existsSync(hookPath), `${hookPath} must be staged by the install`);
    }
    // #2544: the CommonJS marker is staged INSIDE the directories GSD owns and
    // fills — hooks/ (the staged guard scripts) and plugins/ (the native
    // adapter) — never at the config root, which is user-writable territory on
    // Kilo (where a package.json declares local-plugin npm dependencies).
    for (const ownedDir of ['hooks', 'plugins']) {
      const marker = path.join(configDir, ownedDir, 'package.json');
      assert.ok(fs.existsSync(marker), `CommonJS package.json marker must be staged in ${ownedDir}/`);
      assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).type, 'commonjs');
    }
    assert.ok(!fs.existsSync(path.join(configDir, 'package.json')),
      'the config root must not receive a GSD package.json (#2544)');

    // Staged hooks are tracked in the manifest (drift/uninstall accounting).
    assert.ok(manifest && manifest.files['hooks/gsd-prompt-guard.js'],
      'manifest must track the staged guard hooks');

    // The installed plugin's own walk-up resolution (hooks/ + gsd-core/ both
    // present) lands on the config dir — i.e. HOOKS_DIR points at the staged
    // scripts, closing the resolveRepoRoot fallback miss from #2305.
    const installedPlugin = path.join(configDir, 'plugins', 'gsd-core.js');
    assert.ok(fs.existsSync(installedPlugin), 'native plugin must be staged');
    delete require.cache[require.resolve(installedPlugin)];
    const mod = require(installedPlugin);
    assert.equal(mod.server._internals.REPO_ROOT, fs.realpathSync(configDir),
      'plugin REPO_ROOT must resolve to the config dir (hooks/ + gsd-core/ siblings)');
  });
}

test('kilo: a disallowed write through the REAL installed tree is rejected by the worktree-path guard (#2305)', async (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'kilo', scope: 'global' });
  t.after(() => cleanup(root));

  // Build a GSD-shaped executor worktree: gsd-worktree-path-guard hard-blocks
  // only when cwd is a linked worktree on a worktree-agent-* branch and the
  // write targets an absolute path outside that worktree's toplevel.
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kilo-2305-')));
  t.after(() => cleanup(scratch));
  const mainRepo = path.join(scratch, 'main');
  fs.mkdirSync(mainRepo, { recursive: true });
  const git = (args, cwd) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r;
  };
  git(['init', '-q'], mainRepo);
  fs.writeFileSync(path.join(mainRepo, 'seed.md'), 'seed');
  git(['add', 'seed.md'], mainRepo);
  git(['commit', '-q', '-m', 'seed'], mainRepo);
  const wt = path.join(scratch, 'wt');
  git(['worktree', 'add', '-q', '-b', 'worktree-agent-2305', wt], mainRepo);

  // Load the plugin exactly as installed and pin its cwd to the worktree.
  const installedPlugin = path.join(configDir, 'plugins', 'gsd-core.js');
  delete require.cache[require.resolve(installedPlugin)];
  const mod = require(installedPlugin);
  const handlers = await mod.server({ directory: wt });

  // A write escaping the worktree back into the main repo must be BLOCKED —
  // pre-#2305 no hook script was staged, so this silently resolved (allow).
  await assert.rejects(
    () => handlers['tool.execute.before'](
      { tool: 'write' },
      { args: { filePath: path.join(mainRepo, 'escape.md'), content: 'x' } },
    ),
    /./,
    'guard must reject the out-of-worktree write through the installed Kilo tree',
  );

  // Control: the same write kept inside the worktree passes.
  await handlers['tool.execute.before'](
    { tool: 'write' },
    { args: { filePath: path.join(wt, 'inside.md'), content: 'x' } },
  );
});

// Regression guard for the descriptor-contradiction CLASS, not just Kilo: a
// runtime whose nativePlugin spawns the shared hooks while its descriptor
// suppresses staging them re-creates #2305 for that runtime.
test('no capability declares BOTH hostBehaviors.nativePlugin and skipSharedHooksInstall:true (#2305)', () => {
  const capsDir = path.join(__dirname, '..', 'capabilities');
  for (const entry of fs.readdirSync(capsDir)) {
    const capPath = path.join(capsDir, entry, 'capability.json');
    if (!fs.existsSync(capPath)) continue;
    const cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));
    const hb = cap.runtime && cap.runtime.hostBehaviors;
    if (!hb || !hb.nativePlugin) continue;
    assert.notEqual(hb.skipSharedHooksInstall, true,
      `${entry}: declares a nativePlugin (which spawns the shared hooks) while ` +
      'also declaring skipSharedHooksInstall:true — the hooks it depends on ' +
      'would never be staged (#2305)');
  }
});

'use strict';

/**
 * opencode-plugin-adapter.test.cjs — unit + integration coverage for the
 * OpenCode native plugin adapter (.opencode/plugins/gsd-core.js, issue #1914).
 *
 * The adapter bridges OpenCode's plugin event bus onto GSD's existing hook
 * scripts by spawning them as subprocesses. These tests exercise it WITHOUT a
 * live OpenCode runtime by:
 *   1. Unit-testing the pure translation helpers exposed on `_internals`.
 *   2. Building a temp "install" layout (hooks/ with deterministic STUB hooks +
 *      gsd-core/ + plugins/gsd-core.js) and driving the plugin's returned
 *      handlers directly, asserting the real spawn bridge maps block/advisory/
 *      allow correctly and that REPO_ROOT resolves to the payload dir.
 *
 * Cross-platform note: filesystem-failure paths are not exercised here; the
 * adapter's own error handling swallows spawn failures by design (a broken hook
 * must never break a tool call). A MISSING hook script likewise never breaks
 * the tool call, but since #2305 it warns loudly (once per hook file) — a
 * silently-absent guard script was exactly how every Kilo guard no-opped.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('os');
const { cleanup } = require('./helpers.cjs');

const ADAPTER_SRC = path.join(__dirname, '..', '.opencode', 'plugins', 'gsd-core.js');

// ---------------------------------------------------------------------------
// Pure-helper unit tests (no filesystem / no spawn)
// ---------------------------------------------------------------------------

// Test-only helpers hang off the exported `server` function (see adapter export
// note) so they never appear as top-level exports the OpenCode loader iterates.
const _internals = require(ADAPTER_SRC).server._internals;

// Faithful emulation of OpenCode's loader: `getServerPlugin` accepts a bare
// function OR an object with a `.server` function, else the loader THROWS.
function getServerPlugin(entry) {
  if (typeof entry === 'function') return entry;
  if (entry && typeof entry === 'object' && typeof entry.server === 'function') return entry.server;
  return null;
}
// Emulate the loader loop: `for (const entry of Object.values(mod)) { … throw if null }`.
function loaderExtract(mod) {
  const servers = [];
  for (const entry of Object.values(mod)) {
    const s = getServerPlugin(entry);
    if (!s) throw new TypeError('Plugin export is not a function');
    servers.push(s);
  }
  return servers;
}

test('export survives the loader loop as raw CommonJS (require)', () => {
  const mod = require(ADAPTER_SRC);
  // `id` must be readable for identity/dedup...
  assert.equal(mod.id, 'gsd-core');
  // ...but NON-ENUMERABLE so it never lands in Object.values (would throw).
  assert.ok(!Object.keys(mod).includes('id'), 'id must be non-enumerable');
  const servers = loaderExtract(mod); // must not throw
  assert.equal(servers.length, 1);
  assert.equal(typeof servers[0], 'function');
  // Internals hang off the server fn, never as a sibling top-level export.
  assert.equal(mod._internals, undefined);
  assert.equal(typeof mod.server._internals, 'object');
});

test('export survives the loader loop as an ESM/Bun namespace (default + synthesized)', () => {
  const raw = require(ADAPTER_SRC);
  // Worst-case ESM interop: default plus any lexer-synthesized named exports.
  // Because module.exports is assigned from a variable, only `default` is
  // realistically synthesized — but assert robustness even if `server` leaks.
  for (const ns of [{ default: raw }, { default: raw, server: raw.server }]) {
    assert.doesNotThrow(() => loaderExtract(ns), `loader threw on namespace ${Object.keys(ns)}`);
  }
});

test('mapToolName maps OpenCode tool names to Claude names', () => {
  assert.equal(_internals.mapToolName('read'), 'Read');
  assert.equal(_internals.mapToolName('write'), 'Write');
  assert.equal(_internals.mapToolName('edit'), 'Edit');
  assert.equal(_internals.mapToolName('bash'), 'Bash');
  assert.equal(_internals.mapToolName('apply_patch'), 'MultiEdit');
  assert.equal(_internals.mapToolName('webfetch'), 'WebFetch');
  // Unknown tools pass through unchanged; empty is empty.
  assert.equal(_internals.mapToolName('mystery'), 'mystery');
  assert.equal(_internals.mapToolName(''), '');
});

test('mapToolInput normalizes camelCase + snake_case arg keys', () => {
  const out = _internals.mapToolInput({
    filePath: '/a/b.txt',
    oldString: 'x',
    newString: 'y',
    command: 'ls',
    url: 'http://e',
  });
  assert.deepEqual(out, {
    file_path: '/a/b.txt',
    old_string: 'x',
    new_string: 'y',
    command: 'ls',
    url: 'http://e',
  });
  // path/file_path aliases also resolve to file_path.
  assert.equal(_internals.mapToolInput({ path: '/p' }).file_path, '/p');
  assert.deepEqual(_internals.mapToolInput(null), {});
});

test('parseFrontmatter splits frontmatter and body', () => {
  const { frontmatter, body } = _internals.parseFrontmatter(
    '---\ndescription: A command\nmode: primary\n---\nHello body\n',
  );
  assert.equal(frontmatter.description, 'A command');
  assert.equal(frontmatter.mode, 'primary');
  assert.equal(body, 'Hello body\n');
  // No frontmatter → whole content is body.
  const plain = _internals.parseFrontmatter('just text');
  assert.deepEqual(plain.frontmatter, {});
  assert.equal(plain.body, 'just text');
});

test('handleHookResult: block decision throws with the hook reason', () => {
  assert.throws(
    () => _internals.handleHookResult(
      { stdout: JSON.stringify({ decision: 'block', reason: 'blocked!' }), exitCode: 0 },
    ),
    /blocked!/,
  );
});

test('handleHookResult: exit code 2 is a hard block even without JSON', () => {
  assert.throws(
    () => _internals.handleHookResult({ stdout: '', exitCode: 2 }),
    /Blocked by GSD hook/,
  );
});

test('handleHookResult: advisory sets metadata + does not throw', () => {
  const output = {};
  assert.doesNotThrow(() =>
    _internals.handleHookResult(
      { stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'heads up' } }), exitCode: 0 },
      output,
    ),
  );
  assert.deepEqual(output.metadata._gsdAdvisory, ['heads up']);
});

test('handleHookResult: multiple advisories accumulate (no clobber)', () => {
  // A single tool call runs several advisory hooks in sequence; each must be
  // preserved, not overwritten by the next.
  const output = {};
  const advise = (ctx) =>
    _internals.handleHookResult(
      { stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: ctx } }), exitCode: 0 },
      output,
    );
  advise('prompt-guard note');
  advise('read-guard note');
  advise('workflow-guard note');
  assert.deepEqual(output.metadata._gsdAdvisory, [
    'prompt-guard note',
    'read-guard note',
    'workflow-guard note',
  ]);
});

test('handleHookResult: silent allow is a no-op', () => {
  const output = {};
  assert.doesNotThrow(() => _internals.handleHookResult({ stdout: '', exitCode: 0 }, output));
  assert.deepEqual(output, {});
});

// ---------------------------------------------------------------------------
// Integration: drive the plugin against a temp install layout with STUB hooks
// ---------------------------------------------------------------------------

// Build a self-contained payload dir: <root>/hooks/<stub>.js, <root>/gsd-core/,
// and <root>/plugins/gsd-core.js (a copy of the adapter). Returns the loaded
// plugin module for that layout. Each stub hook echoes a fixed JSON verdict.
function buildInstalledLayout(t, stubHooks) {
  // realpath so `root` matches Node's realpath-resolved __dirname inside the
  // copied plugin (macOS /var → /private/var symlink would otherwise diverge).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-plugin-')));
  t.after(() => cleanup(root));

  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gsd-core', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });

  for (const [name, jsBody] of Object.entries(stubHooks)) {
    fs.writeFileSync(path.join(root, 'hooks', name), jsBody);
  }

  // Copy the real adapter into the payload's plugins/ dir so REPO_ROOT resolves
  // to `root` via the walk-up probe (root has both hooks/ and gsd-core/).
  const dest = path.join(root, 'plugins', 'gsd-core.js');
  fs.copyFileSync(ADAPTER_SRC, dest);
  // Fresh module instance (bypass require cache — each layout is distinct).
  delete require.cache[require.resolve(dest)];
  const mod = require(dest);
  return { root, mod };
}

// A stub hook that reads stdin (ignored) and prints the given verdict JSON.
function stubHook(verdictJson, exitCode = 0) {
  return `
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
  process.stdout.write(${JSON.stringify(verdictJson)});
  process.exit(${exitCode});
});
process.stdin.on('error',()=>process.exit(${exitCode}));
if(process.stdin.isTTY){process.stdout.write(${JSON.stringify(verdictJson)});process.exit(${exitCode});}
`;
}

test('REPO_ROOT resolves to the payload dir in an installed layout', (t) => {
  const { root, mod } = buildInstalledLayout(t, {});
  assert.equal(mod.server._internals.REPO_ROOT, fs.realpathSync(root));
  // No source commands/gsd/ present → treated as installed (not package) tree.
  assert.equal(mod.server._internals.IS_PACKAGE_TREE, false);
});

test('tool.execute.before: a blocking hook aborts the tool call (throws)', async (t) => {
  const { mod } = buildInstalledLayout(t, {
    'gsd-prompt-guard.js': stubHook(JSON.stringify({ decision: 'block', reason: 'injection detected' })),
  });
  const handlers = await mod.server({ directory: process.cwd() });
  await assert.rejects(
    () => handlers['tool.execute.before'](
      { tool: 'write' },
      { args: { filePath: '/proj/.planning/x.md', content: 'evil' } },
    ),
    /injection detected/,
  );
});

test('tool.execute.before: a silent hook allows the tool call (no throw)', async (t) => {
  const { mod } = buildInstalledLayout(t, {
    'gsd-prompt-guard.js': stubHook(''),
    'gsd-read-guard.js': stubHook(''),
    'gsd-worktree-path-guard.js': stubHook(''),
    'gsd-workflow-guard.js': stubHook(''),
  });
  const handlers = await mod.server({ directory: process.cwd() });
  await assert.doesNotReject(() =>
    handlers['tool.execute.before'](
      { tool: 'write' },
      { args: { filePath: '/proj/notes.md', content: 'ok' } },
    ),
  );
});

test('tool.execute.after: Read content rewriting maps ~/.claude/gsd-core paths', async (t) => {
  const { root, mod } = buildInstalledLayout(t, {
    'gsd-read-injection-scanner.js': stubHook(''),
  });
  const handlers = await mod.server({ directory: process.cwd() });
  // A file under the payload's gsd-core/workflows is a GSD-managed file, so its
  // Read output is rewritten (canonical ~/.claude/gsd-core/ → real payload path).
  const managed = path.join(root, 'gsd-core', 'workflows', 'x.md');
  const output = { output: 'see ~/.claude/gsd-core/references/foo.md for details' };
  await handlers['tool.execute.after']({ tool: 'read', args: { filePath: managed } }, output);
  // The adapter rewrites `~/.claude/gsd-core/` → `${GSD_CORE}/`, where GSD_CORE
  // is `path.join(root, 'gsd-core')` (OS-native separators). Assert with a plain
  // string include, NOT a RegExp built from a path — on Windows the backslashes
  // in the path would be interpreted as regex escapes and never match.
  const expected = path.join(root, 'gsd-core') + '/references/foo.md';
  assert.ok(
    output.output.includes(expected),
    `expected rewritten path "${expected}" in output: ${output.output}`,
  );
  assert.ok(
    !output.output.includes('~/.claude/gsd-core/'),
    'canonical ~/.claude/gsd-core/ prefix must be rewritten away',
  );
});

test('missing hook script warns loudly but still allows (never breaks the tool call, #2305)', async (t) => {
  // No hook stubs written at all → every runHook finds no file → allow, but
  // each absent guard script must be warned about (once per hook file): a
  // silently-missing guard is how #2305 no-opped every Kilo guard.
  const { mod } = buildInstalledLayout(t, {});
  const warnings = [];
  const realConsoleError = console.error;
  t.after(() => { console.error = realConsoleError; });
  console.error = (...args) => { warnings.push(args.join(' ')); };
  const handlers = await mod.server({ directory: process.cwd() });
  await assert.doesNotReject(() =>
    handlers['tool.execute.before'](
      { tool: 'edit' },
      { args: { filePath: '/proj/a.md', old_string: 'a', new_string: 'b' } },
    ),
  );
  const missingWarnings = warnings.filter((w) => w.includes('hook script missing'));
  assert.ok(missingWarnings.length > 0, 'a missing guard script must be warned about');
  // Warn-once: driving a second identical tool call must not re-warn.
  const warnedOnce = missingWarnings.length;
  await assert.doesNotReject(() =>
    handlers['tool.execute.before'](
      { tool: 'edit' },
      { args: { filePath: '/proj/a.md', old_string: 'a', new_string: 'b' } },
    ),
  );
  assert.equal(
    warnings.filter((w) => w.includes('hook script missing')).length,
    warnedOnce,
    'the missing-hook warning fires once per hook file, not once per tool call',
  );
});

test('config hook is a no-op in installed (non-package) layout', async (t) => {
  const { mod } = buildInstalledLayout(t, {});
  const handlers = await mod.server({ directory: process.cwd() });
  const config = {};
  await handlers.config(config);
  // No commands/agents/skills registered — native file copy owns that surface.
  assert.deepEqual(config, {});
});

// ---------------------------------------------------------------------------
// Session lifecycle + opencode-subset surface parity (#1682 Slice 1b/c)
// ---------------------------------------------------------------------------

test('session.idle event is handled (no-op sentinel) without throwing', async (t) => {
  const { mod } = buildInstalledLayout(t, {});
  const handlers = await mod.server({ directory: process.cwd() });
  // session.idle ↔ Claude Stop lifecycle point; recognized no-op today.
  await assert.doesNotReject(() => handlers.event({ event: { type: 'session.idle' } }));
});

test('experimental.session.compacting injects the GSD state breadcrumb', async (t) => {
  const { mod } = buildInstalledLayout(t, { 'gsd-context-monitor.js': stubHook('') });
  const handlers = await mod.server({ directory: process.cwd() });
  // Compaction fires only with an active session; session.created sets it.
  await handlers.event({
    event: { type: 'session.created', properties: { info: { id: 's1', directory: process.cwd() } } },
  });
  const output = {};
  await handlers['experimental.session.compacting']({}, output);
  assert.ok(Array.isArray(output.context) && output.context.length > 0, 'compaction injects a GSD breadcrumb');
  assert.ok(output.context.some((c) => /GSD/.test(c)), 'breadcrumb is GSD-tagged');
});

test('plugin implements the full declared opencode extension-event surface (Claude parity — #1943)', async (t) => {
  const { extensionEventSurfaceFor } = require('../gsd-core/bin/lib/host-integration.cjs');
  const surface = extensionEventSurfaceFor('opencode');
  assert.ok(surface, 'opencode is a consumed extensionEvents dialect (non-null surface)');
  // The engine — not the host bus — owns workflow-phase sequencing on this host.
  assert.ok(!surface.some((e) => /plan:|verify:|ship:/.test(e)),
    'opencode extension events include no workflow-phase events');

  const { mod } = buildInstalledLayout(t, {});
  const handlers = await mod.server({ directory: process.cwd() });
  // Tool + compaction events are top-level handler keys.
  for (const ev of ['tool.execute.before', 'tool.execute.after', 'experimental.session.compacting']) {
    assert.equal(typeof handlers[ev], 'function', `plugin exposes a handler for ${ev}`);
  }
  // Session/file events dispatch through the `event` handler.
  assert.equal(typeof handlers.event, 'function', 'plugin exposes an event dispatcher');
  // Every declared surface event resolves to a plugin handler. Session /
  // permission / error events dispatch through the `event` handler (not
  // top-level handler keys). #2087 added permission.asked/replied + session.error.
  const EVENT_DISPATCHED = new Set([
    'session.created', 'session.idle', 'file.edited',
    'permission.asked', 'permission.replied', 'session.error',
  ]);
  for (const ev of surface) {
    const covered = typeof handlers[ev] === 'function' || EVENT_DISPATCHED.has(ev);
    assert.ok(covered, `plugin covers opencode extension event: ${ev}`);
  }
});

// ---------------------------------------------------------------------------
// Installer integration: copy → manifest → uninstall (real bin/install.js)
// ---------------------------------------------------------------------------

test('installer copies plugin as .js, records it in the manifest, and removes it on uninstall', (t) => {
  const { spawnSync } = require('node:child_process');
  const installer = path.join(__dirname, '..', 'bin', 'install.js');
  const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-install-')));
  t.after(() => cleanup(cfg));

  const run = (args) =>
    spawnSync(process.execPath, [installer, '--opencode', '--global', '--config-dir', cfg, ...args], {
      encoding: 'utf8',
    });

  // Install
  const install = run([]);
  assert.equal(install.status, 0, `install failed: ${install.stderr}`);

  const pluginPath = path.join(cfg, 'plugins', 'gsd-core.js');
  assert.ok(fs.existsSync(pluginPath), 'plugin must land at plugins/gsd-core.js (matches OpenCode {plugin,plugins}/*.{ts,js} glob)');
  assert.ok(!fs.existsSync(path.join(cfg, 'plugins', 'gsd-core.cjs')), 'must NOT ship a .cjs (never auto-discovered)');

  // Manifest records the plugin for drift/uninstall accounting.
  const manifest = JSON.parse(fs.readFileSync(path.join(cfg, 'gsd-file-manifest.json'), 'utf8'));
  assert.ok(manifest.files['plugins/gsd-core.js'], 'manifest must track plugins/gsd-core.js');

  // The installed plugin loads and resolves REPO_ROOT to the config dir.
  delete require.cache[require.resolve(pluginPath)];
  const installed = require(pluginPath);
  assert.equal(installed.id, 'gsd-core');
  assert.equal(installed.server._internals.REPO_ROOT, cfg);
  assert.equal(installed.server._internals.IS_PACKAGE_TREE, false);

  // Uninstall removes the plugin and prunes the (now empty) plugins/ dir.
  const uninstall = run(['--uninstall']);
  assert.equal(uninstall.status, 0, `uninstall failed: ${uninstall.stderr}`);
  assert.ok(!fs.existsSync(pluginPath), 'plugin must be removed on uninstall');
  assert.ok(!fs.existsSync(path.join(cfg, 'plugins')), 'empty plugins/ dir must be pruned');
});

// ---------------------------------------------------------------------------
// #2697: context-monitor subprocess is skipped in-process when context_warnings
// is disabled, instead of paying a full Node boot inside the child only to exit.
// The plugin destructures spawnSync at require-time, so we intercept by
// monkeypatching require('child_process').spawnSync BEFORE loading the copied
// plugin, recording every spawn's argv. Restore in t.after.
// ---------------------------------------------------------------------------

/**
 * Build an installed layout, intercept spawnSync, and return { handlers, spawns, projectDir }.
 * `planningConfig` (object|null) is written to <projectDir>/.planning/config.json; null = absent.
 */
async function buildLayoutWithSpawnTrace(t, { stubHooks, planningConfig }) {
  const cp = require('node:child_process');
  const spawns = [];
  const realSpawnSync = cp.spawnSync;
  // IMPORTANT: the plugin destructures spawnSync at require-time
  // (`const { spawnSync } = require("child_process")`), so the patch MUST be in
  // place BEFORE buildInstalledLayout requires the copied plugin, or the plugin
  // captures the original spawnSync and our trace records nothing.
  cp.spawnSync = (...args) => {
    spawns.push(args);
    // Return an allow/no-op result so the adapter's handleHookResult path completes.
    return { stdout: '', status: 0, signal: null };
  };
  t.after(() => { cp.spawnSync = realSpawnSync; });

  const { mod } = buildInstalledLayout(t, stubHooks || {});

  // Project dir is the cwd the plugin reads config from (currentCwd).
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-proj-')));
  t.after(() => cleanup(projectDir));
  if (planningConfig !== null) {
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify(planningConfig),
    );
  }

  const handlers = await mod.server({ directory: projectDir });
  // Establish an active session — the context-monitor dispatch is gated on
  // currentSessionId, which session.created populates. Without this the gate
  // short-circuits on the first operand (null) and the toggle is never reached,
  // making the "disabled" assertions pass vacuously and the "enabled" ones fail.
  await handlers.event({
    event: { type: 'session.created', properties: { info: { id: 's1', directory: projectDir } } },
  });
  return { handlers, spawns, projectDir };
}

function spawnTargetedMonitor(spawns) {
  return spawns.some((a) => {
    const argv = a[1];
    return Array.isArray(argv) && argv.some((s) => String(s).includes('gsd-context-monitor.js'));
  });
}

test('#2697: context-monitor subprocess is skipped when context_warnings is disabled', async (t) => {
  const { handlers, spawns } = await buildLayoutWithSpawnTrace(t, {
    stubHooks: { 'gsd-context-monitor.js': stubHook('') },
    planningConfig: { hooks: { context_warnings: false } },
  });
  // Bash is a non-Read tool → reaches the context-monitor dispatch.
  await handlers['tool.execute.after']({ tool: 'bash', args: { command: 'echo hi' } }, {});
  assert.ok(
    !spawnTargetedMonitor(spawns),
    `context-monitor spawn must be skipped when context_warnings:false; spawn argvs: ${JSON.stringify(spawns)}`,
  );
});

test('#2697: context-monitor subprocess still runs when config is absent (default enabled)', async (t) => {
  const { handlers, spawns } = await buildLayoutWithSpawnTrace(t, {
    stubHooks: { 'gsd-context-monitor.js': stubHook('') },
    planningConfig: null,
  });
  await handlers['tool.execute.after']({ tool: 'bash', args: { command: 'echo hi' } }, {});
  assert.ok(
    spawnTargetedMonitor(spawns),
    'context-monitor spawn must still occur when the config toggle is absent (default = enabled)',
  );
});

test('#2697: context-monitor subprocess runs when context_warnings explicitly true', async (t) => {
  const { handlers, spawns } = await buildLayoutWithSpawnTrace(t, {
    stubHooks: { 'gsd-context-monitor.js': stubHook('') },
    planningConfig: { hooks: { context_warnings: true } },
  });
  await handlers['tool.execute.after']({ tool: 'bash', args: { command: 'echo hi' } }, {});
  assert.ok(
    spawnTargetedMonitor(spawns),
    'context-monitor spawn must occur when context_warnings is explicitly true',
  );
});

test('#2697: context-monitor subprocess runs when config.json is unparseable (defaults enabled)', async (t) => {
  const cp = require('node:child_process');
  const spawns = [];
  const realSpawnSync = cp.spawnSync;
  // Patch BEFORE requiring the plugin (it destructures spawnSync at require-time).
  cp.spawnSync = (...args) => { spawns.push(args); return { stdout: '', status: 0, signal: null }; };
  t.after(() => { cp.spawnSync = realSpawnSync; });

  const { mod } = buildInstalledLayout(t, { 'gsd-context-monitor.js': stubHook('') });
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-proj-')));
  t.after(() => cleanup(projectDir));
  fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
  // Malformed JSON → the in-process check must treat it as "enabled" (Postel: conservative).
  fs.writeFileSync(path.join(projectDir, '.planning', 'config.json'), '{ not valid json');

  const handlers = await mod.server({ directory: projectDir });
  // Establish an active session (the dispatch is gated on currentSessionId).
  await handlers.event({
    event: { type: 'session.created', properties: { info: { id: 's1', directory: projectDir } } },
  });
  await handlers['tool.execute.after']({ tool: 'bash', args: { command: 'echo hi' } }, {});
  assert.ok(
    spawnTargetedMonitor(spawns),
    'context-monitor spawn must occur when config.json is unparseable (defaults = enabled)',
  );
});

test('#2697: context-monitor skipped for Write when context_warnings disabled (not Bash-specific)', async (t) => {
  const { handlers, spawns } = await buildLayoutWithSpawnTrace(t, {
    stubHooks: { 'gsd-context-monitor.js': stubHook('') },
    planningConfig: { hooks: { context_warnings: false } },
  });
  // Write reaches context-monitor dispatch (non-Read); the guard hooks run before it
  // via tool.execute.before, not here, so the after-handler only hits the monitor.
  await handlers['tool.execute.after'](
    { tool: 'write', args: { filePath: '/proj/a.md', content: 'x' } },
    {},
  );
  assert.ok(
    !spawnTargetedMonitor(spawns),
    `context-monitor spawn must be skipped for Write when context_warnings:false; spawn argvs: ${JSON.stringify(spawns)}`,
  );
});

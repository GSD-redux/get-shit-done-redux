const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode, runHook } = require('./helpers/process-seam.cjs');
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const { HOOKS_TO_COPY } = require('../scripts/build-hooks.js');

const REPO_ROOT = path.join(__dirname, '..');
const RESOLVER_HOOK = 'gsd-node-runner.sh';
const FOREIGN_NODE = '/nonexistent-envA/bin/node';
const STUB_HOOK_BODY = ['#!/usr/bin/env node', 'process.stdout.write("hook-ran-ok");', ''].join('\n');
const MANAGED_JS_HOOKS = [
  'gsd-check-update.js',
  'gsd-config-reload.js',
  'gsd-statusline.js',
  'gsd-context-monitor.js',
  'gsd-prompt-guard.js',
  'gsd-read-guard.js',
  'gsd-read-injection-scanner.js',
  'gsd-update-banner.js',
  'gsd-workflow-guard.js',
];
const GUARD_HOOKS = [
  'gsd-write-guard.js',
  'gsd-agent-isolation-guard.js',
  'gsd-worktree-path-guard.js',
  'gsd-secret-read-guard.js',
];

// Every quoted absolute-node token (POSIX-form as emitted, .exe for win32
// projections) becomes the foreign environment's nonexistent path — the exact
// string a shared config root holds in environment B.
function foreignizeNodeTokens(command) {
  return command.replace(/"(\/[^"]*\/node(\.exe)?)"/g, `"${FOREIGN_NODE}"`);
}

function isAbsoluteNodeTokenQuoted(token) {
  return /^"(\/[^"]*\/node(\.exe)?)?"$/.test(token);
}

function makeHookTree(t, homeDirName) {
  const home = createTempDir(homeDirName);
  const configDir = path.join(home, '.claude');
  fs.mkdirSync(path.join(configDir, 'hooks'), { recursive: true });
  for (const hook of [...MANAGED_JS_HOOKS, ...GUARD_HOOKS]) {
    fs.writeFileSync(path.join(configDir, 'hooks', hook), STUB_HOOK_BODY);
  }
  fs.writeFileSync(path.join(configDir, 'hooks', 'gsd-session-state.sh'), '#!/bin/sh\nexit 0\n');
  const repoResolver = path.join(REPO_ROOT, 'hooks', RESOLVER_HOOK);
  if (fs.existsSync(repoResolver)) {
    fs.copyFileSync(repoResolver, path.join(configDir, 'hooks', RESOLVER_HOOK));
  }
  t.after(() => cleanup(home));
  return { home, configDir };
}

function withHome(t, home) {
  const origHome = process.env.HOME;
  const origProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origProfile;
  });
}

function makeNodeStub(t, label) {
  const dir = createTempDir(`gsd3662-stub-${label}`);
  const stubPath = path.join(dir, 'node');
  fs.writeFileSync(stubPath, ['#!/bin/sh', `echo "STUB-NODE:$1"`, ''].join('\n'));
  fs.chmodSync(stubPath, 0o755);
  t.after(() => cleanup(dir));
  return stubPath;
}

function posixRealNodeDir() {
  return process.execPath.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
}

function writeCommandFile(t, command, name) {
  const file = path.join(createTempDir('gsd3662-cmd'), `${name}.cmd`);
  fs.writeFileSync(file, command + '\n');
  t.after(() => cleanup(path.dirname(file)));
  return file;
}

// Local class departure (CONTRIBUTING "Class-norm timeouts"): each execution
// row spans a bash spawn + a node child against a tiny script; 20s absorbs
// cold CI-runner startup for both without approaching the 600s ceiling. The
// existing classes (PROBE/GIT/BUILD/INSTALL) each describe a single-process
// shape, not this bash+node pair.
const RUN_TIMEOUT_MS = 20000;

// POSIX-sh execution semantics (the emitted command grammar) are proven on the
// POSIX lanes; win32 lanes prove the structural projection (see the win32
// describe below) — Git Bash availability is not guaranteed on every runner.
function skipOnWin32(t, reason) {
  if (process.platform === 'win32') {
    t.skip(reason);
    return true;
  }
  return false;
}

describe('#3662 runtime-resolving managed hook runners', () => {
  describe('emitted commands resolve node at run time (criteria 1+2)', () => {
    test('portable hook command resolves node when baked path is absent', (t) => {
      if (skipOnWin32(t, 'POSIX sh execution lane; win32 structural coverage below')) return;
      const { home, configDir } = makeHookTree(t, 'portable-run');
      withHome(t, home);
      const emitted = hooksSurface.buildHookCommand(configDir, 'gsd-statusline.js', {
        portableHooks: true,
        runtime: 'claude',
      });
      assert.ok(typeof emitted === 'string' && emitted.length > 0);
      const foreign = foreignizeNodeTokens(emitted);
      const file = writeCommandFile(t, foreign, 'portable');
      const result = runHook(file, [], {
        interpreter: 'bash',
        cwd: home,
        env: { ...process.env, HOME: home, PATH: `${posixRealNodeDir()}:/usr/bin:/bin` },
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.equal(result.exitCode, 0, `command: ${foreign}\nstderr: ${result.stderr}`);
      assert.equal(result.stdout, 'hook-ran-ok');
    });

    test('plain hook command resolves node when baked path is absent', (t) => {
      if (skipOnWin32(t, 'POSIX sh execution lane; win32 structural coverage below')) return;
      const { home, configDir } = makeHookTree(t, 'plain-run');
      withHome(t, home);
      const emitted = hooksSurface.buildHookCommand(configDir, 'gsd-statusline.js', {
        runtime: 'claude',
      });
      assert.ok(typeof emitted === 'string' && emitted.length > 0);
      const foreign = foreignizeNodeTokens(emitted);
      const file = writeCommandFile(t, foreign, 'plain');
      const result = runHook(file, [], {
        interpreter: 'bash',
        cwd: home,
        env: { ...process.env, HOME: home, PATH: `${posixRealNodeDir()}:/usr/bin:/bin` },
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.equal(result.exitCode, 0, `command: ${foreign}\nstderr: ${result.stderr}`);
      assert.equal(result.stdout, 'hook-ran-ok');
    });

    test('chain prefers the baked absolute runner first', (t) => {
      if (skipOnWin32(t, 'POSIX sh execution lane; win32 structural coverage below')) return;
      const { home, configDir } = makeHookTree(t, 'chain-order');
      withHome(t, home);
      const stub = makeNodeStub(t, 'chain-order');
      const emitted = hooksSurface.buildHookCommand(configDir, 'gsd-statusline.js', {
        runtime: 'claude',
        execPath: stub,
      });
      assert.ok(typeof emitted === 'string', `no command emitted: ${emitted}`);
      const file = writeCommandFile(t, emitted, 'chain-order');
      const result = runHook(file, [], {
        interpreter: 'bash',
        cwd: home,
        env: { ...process.env, HOME: home, PATH: `${posixRealNodeDir()}:/usr/bin:/bin` },
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.equal(result.exitCode, 0, `command: ${emitted}\nstderr: ${result.stderr}`);
      assert.match(result.stdout, /^STUB-NODE:\S+gsd-statusline\.js/);
    });

    test('resolver prefers its first argument', (t) => {
      if (skipOnWin32(t, 'POSIX sh execution lane; win32 structural coverage below')) return;
      const { home, configDir } = makeHookTree(t, 'resolver-order');
      withHome(t, home);
      const stub = makeNodeStub(t, 'resolver-order');
      const emitted = hooksSurface.buildHookCommand(configDir, 'gsd-statusline.js', {
        portableHooks: true,
        runtime: 'claude',
        execPath: stub,
      });
      assert.ok(typeof emitted === 'string', `no command emitted: ${emitted}`);
      const file = writeCommandFile(t, emitted, 'resolver-order');
      const result = runHook(file, [], {
        interpreter: 'bash',
        cwd: home,
        env: { ...process.env, HOME: home, PATH: `${posixRealNodeDir()}:/usr/bin:/bin` },
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.equal(result.exitCode, 0, `command: ${emitted}\nstderr: ${result.stderr}`);
      assert.match(result.stdout, /^STUB-NODE:\S+gsd-statusline\.js/);
    });

    test('chain resolves with the real execPath under a minimal PATH', (t) => {
      if (skipOnWin32(t, 'POSIX sh execution lane; win32 structural coverage below')) return;
      const { home, configDir } = makeHookTree(t, 'minimal-path');
      withHome(t, home);
      const emitted = hooksSurface.buildHookCommand(configDir, 'gsd-statusline.js', {
        runtime: 'claude',
      });
      assert.ok(typeof emitted === 'string');
      const file = writeCommandFile(t, emitted, 'minimal-path');
      const result = runHook(file, [], {
        interpreter: 'bash',
        cwd: home,
        env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' },
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.equal(result.exitCode, 0, `command: ${emitted}\nstderr: ${result.stderr}`);
      assert.equal(result.stdout, 'hook-ran-ok');
    });

    test('no bare node token in any emitted hook command', (t) => {
      const { home, configDir } = makeHookTree(t, 'bare-node');
      withHome(t, home);
      for (const hook of MANAGED_JS_HOOKS) {
        for (const portableHooks of [false, true]) {
          const emitted = hooksSurface.buildHookCommand(configDir, hook, {
            portableHooks,
            runtime: 'claude',
          });
          assert.ok(typeof emitted === 'string', `${hook} (portable=${portableHooks}) emitted nothing`);
          assert.ok(
            !/(^|\s)["']?node["']?(\s|$)/.test(emitted),
            `${hook} (portable=${portableHooks}) carries a bare node token: ${emitted}`,
          );
        }
      }
    });

    test('every managed js hook emits a resolving runner', (t) => {
      const { home, configDir } = makeHookTree(t, 'all-managed');
      withHome(t, home);
      for (const hook of MANAGED_JS_HOOKS) {
        const plain = hooksSurface.buildHookCommand(configDir, hook, { runtime: 'claude' });
        assert.ok(
          typeof plain === 'string' && plain.startsWith('"$(for n in '),
          `${hook} plain runner is not the resolve chain: ${plain}`,
        );
        const portable = hooksSurface.buildHookCommand(configDir, hook, {
          portableHooks: true,
          runtime: 'claude',
        });
        assert.ok(
          typeof portable === 'string' && portable.includes(RESOLVER_HOOK),
          `${hook} portable command does not route through the resolver: ${portable}`,
        );
      }
    });
  });

  describe('update convergence — the mixed state cannot persist (criterion 3)', () => {
    function settingsWith(entries) {
      return {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write',
              hooks: entries.map((command) => ({ type: 'command', command })),
            },
          ],
        },
      };
    }

    test('update converges the mixed-state foreign runners from the issue', () => {
      const settings = settingsWith([
        `"${FOREIGN_NODE}" "/home/u/.claude/hooks/gsd-write-guard.js"`,
        `"/usr/bin/node" "/home/u/.claude/hooks/gsd-read-guard.js"`,
      ]);
      const changed = hooksSurface.rewriteLegacyManagedNodeHookCommands(
        settings,
        hooksSurface.buildNodeRunnerChainToken(),
        { platform: 'darwin', runtime: 'claude' },
      );
      assert.equal(changed, true, 'rewriter reported no change over a mixed-state install');
      for (const entry of settings.hooks.PreToolUse[0].hooks) {
        assert.ok(
          entry.command.startsWith('"$(for n in '),
          `entry not converged to the resolve chain: ${entry.command}`,
        );
        assert.ok(
          !isAbsoluteNodeTokenQuoted(entry.command.split(' ')[0] || ''),
          `absolute runner survived: ${entry.command}`,
        );
      }
    });

    test('rewriter converges the three guard hooks', () => {
      const settings = settingsWith(
        GUARD_HOOKS.map((hook) => `"${FOREIGN_NODE}" "/home/u/.claude/hooks/${hook}"`),
      );
      const changed = hooksSurface.rewriteLegacyManagedNodeHookCommands(
        settings,
        hooksSurface.buildNodeRunnerChainToken(),
        { platform: 'darwin', runtime: 'claude' },
      );
      assert.equal(changed, true);
      for (const entry of settings.hooks.PreToolUse[0].hooks) {
        assert.ok(
          entry.command.startsWith('"$(for n in '),
          `guard entry not converged: ${entry.command}`,
        );
      }
    });

    test('user and args-form entries are never rewritten', () => {
      const userCommand = `"/usr/bin/node" "/home/u/own-tools/not-gsd.js"`;
      const argsFormCommand = `"${FOREIGN_NODE}" "/home/u/.claude/hooks/gsd-statusline.js"`;
      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write',
              hooks: [
                { type: 'command', command: userCommand },
                { type: 'command', command: argsFormCommand, args: ['extra'] },
              ],
            },
          ],
        },
      };
      hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), {
        platform: 'darwin',
        runtime: 'claude',
      });
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, userCommand);
      assert.equal(settings.hooks.PreToolUse[0].hooks[1].command, argsFormCommand);
    });

    test('unmanaged basenames are not converged', () => {
      const command = `"${FOREIGN_NODE}" "/home/u/.claude/hooks/my-own-hook.js"`;
      const settings = settingsWith([command]);
      const changed = hooksSurface.rewriteLegacyManagedNodeHookCommands(
        settings,
        hooksSurface.buildNodeRunnerChainToken(),
        { platform: 'darwin', runtime: 'claude' },
      );
      assert.equal(changed, false);
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, command);
    });

    test('legacy bare-node entries are still converged', () => {
      const settings = settingsWith([`node "/home/u/.claude/hooks/gsd-statusline.js"`]);
      const changed = hooksSurface.rewriteLegacyManagedNodeHookCommands(
        settings,
        hooksSurface.buildNodeRunnerChainToken(),
        { platform: 'darwin', runtime: 'claude' },
      );
      assert.equal(changed, true);
      assert.ok(
        settings.hooks.PreToolUse[0].hooks[0].command.startsWith('"$(for n in '),
        `bare-node entry not converged: ${settings.hooks.PreToolUse[0].hooks[0].command}`,
      );
    });

    test('rewriter is idempotent and leaves resolving shapes alone', () => {
      const chainCommand = `"$(for n in "${FOREIGN_NODE}" "$(command -v node)" /usr/local/bin/node /usr/bin/node; do [ -x "$n" ] && { [ "\${n#/}" != "$n" ] || [ "\${n#?:}" != "$n" ]; } && printf '%s' "$n" && break; done)" "/home/u/.claude/hooks/gsd-statusline.js"`;
      const resolverCommand = `bash "/home/u/.claude/hooks/${RESOLVER_HOOK}" "${FOREIGN_NODE}" "/home/u/.claude/hooks/gsd-statusline.js"`;
      const settings = settingsWith([chainCommand, resolverCommand]);
      const changed = hooksSurface.rewriteLegacyManagedNodeHookCommands(
        settings,
        hooksSurface.buildNodeRunnerChainToken(),
        { platform: 'darwin', runtime: 'claude' },
      );
      assert.equal(changed, false, 'already-resolving entries were churned');
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, chainCommand);
      assert.equal(settings.hooks.PreToolUse[0].hooks[1].command, resolverCommand);
    });
  });

  describe('resolver script (hooks/gsd-node-runner.sh)', () => {
    test('installer stages the node resolver script', () => {
      const repoResolver = path.join(REPO_ROOT, 'hooks', RESOLVER_HOOK);
      assert.ok(fs.existsSync(repoResolver), `${RESOLVER_HOOK} missing from hooks/`);
      assert.ok(
        HOOKS_TO_COPY.includes(RESOLVER_HOOK),
        `${RESOLVER_HOOK} missing from HOOKS_TO_COPY (build-hooks.js)`,
      );
      const build = runNode([path.join(REPO_ROOT, 'scripts', 'build-hooks.js')], {
        timeoutMs: BUILD_TIMEOUT_MS,
      });
      assert.equal(build.exitCode, 0, `build-hooks failed: ${build.stderr}`);
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, 'hooks', 'dist', RESOLVER_HOOK)),
        `${RESOLVER_HOOK} not copied to hooks/dist/`,
      );
    });

    test('resolver fails visibly when no node can be found', (t) => {
      if (skipOnWin32(t, 'POSIX sh execution lane')) return;
      const { home, configDir } = makeHookTree(t, 'resolver-none');
      const resolver = path.join(configDir, 'hooks', RESOLVER_HOOK);
      assert.ok(fs.existsSync(resolver), 'resolver not staged into fixture');
      const emptyBin = createTempDir('gsd3662-emptybin');
      t.after(() => cleanup(emptyBin));
      const result = runHook(resolver, [FOREIGN_NODE, path.join(configDir, 'hooks', 'gsd-statusline.js')], {
        interpreter: 'bash',
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${emptyBin}:/usr/bin:/bin`,
          GSD_NODE_RUNNER_NO_FALLBACKS: '1',
        },
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.notEqual(result.exitCode, 0, 'resolver silently succeeded with no node anywhere');
      assert.ok(result.stderr.length > 0, 'resolver produced no stderr diagnostic');
      assert.ok(!/\bnode\b\s+\S*gsd-statusline/.test(result.stderr + result.stdout), 'resolver leaked a bare-node invocation');
    });
  });

  describe('unchanged surfaces (criterion 5)', () => {
    test('sh hook commands are unchanged', (t) => {
      const { home, configDir } = makeHookTree(t, 'sh-pins');
      withHome(t, home);
      const plain = hooksSurface.buildHookCommand(configDir, 'gsd-session-state.sh', {
        runtime: 'claude',
      });
      // The pre-#3662 .sh shapes, byte for byte: claude-on-win32 omits the
      // bash runner entirely (shellHookOmitsBashRunner, #580/#3393) and emits
      // the bare script token; POSIX prefixes resolveBashRunner's answer.
      const bareSh = process.platform === 'win32';
      const shRunner = hooksSurface.resolveBashRunner({ platform: process.platform }) || 'bash';
      const plainScript = JSON.stringify(path.join(configDir, 'hooks', 'gsd-session-state.sh').replace(/\\/g, '/'));
      assert.equal(plain, bareSh ? plainScript : `${shRunner} ${plainScript}`);
      const portable = hooksSurface.buildHookCommand(configDir, 'gsd-session-state.sh', {
        portableHooks: true,
        runtime: 'claude',
      });
      assert.equal(portable, bareSh ? '"$HOME/.claude/hooks/gsd-session-state.sh"' : `${shRunner} "$HOME/.claude/hooks/gsd-session-state.sh"`);
    });

    test('chain embeds shell-hostile baked paths safely', (t) => {
      if (skipOnWin32(t, 'POSIX sh execution lane')) return;
      const { home, configDir } = makeHookTree(t, 'hostile-path');
      withHome(t, home);
      const hostileDir = createTempDir('gsd3662-hostile');
      const weird = path.join(hostileDir, 'sp ace$dollar');
      fs.mkdirSync(weird, { recursive: true });
      t.after(() => cleanup(hostileDir));
      const stubPath = path.join(weird, 'node');
      fs.writeFileSync(stubPath, ['#!/bin/sh', 'echo "STUB-NODE:$1"', ''].join('\n'));
      fs.chmodSync(stubPath, 0o755);
      const emitted = hooksSurface.buildHookCommand(configDir, 'gsd-statusline.js', {
        runtime: 'claude',
        execPath: stubPath,
      });
      assert.ok(typeof emitted === 'string');
      const file = writeCommandFile(t, emitted, 'hostile');
      const result = runHook(file, [], {
        interpreter: 'bash',
        cwd: home,
        env: { ...process.env, HOME: home, PATH: `${posixRealNodeDir()}:/usr/bin:/bin` },
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.equal(result.exitCode, 0, `command: ${emitted}\nstderr: ${result.stderr}`);
      assert.match(result.stdout, /^STUB-NODE:\S*gsd-statusline\.js/, 'script path split or expanded by the shell');
    });

    test('chain stays valid sh when no candidate resolves', (t) => {
      if (skipOnWin32(t, 'POSIX sh execution lane')) return;
      const { home, configDir } = makeHookTree(t, 'sh-valid');
      withHome(t, home);
      const emitted = hooksSurface.buildHookCommand(configDir, 'gsd-statusline.js', {
        runtime: 'claude',
        execPath: FOREIGN_NODE,
      });
      assert.ok(typeof emitted === 'string');
      const foreign = foreignizeNodeTokens(emitted);
      const file = writeCommandFile(t, foreign, 'sh-valid');
      const dir = createTempDir('gsd3662-shn');
      const checker = path.join(dir, 'syntax-check.sh');
      fs.writeFileSync(checker, ['#!/bin/sh', 'exec bash -n "$1"', ''].join('\n'));
      fs.chmodSync(checker, 0o755);
      t.after(() => cleanup(dir));
      const result = runHook(checker, [file], {
        interpreter: 'bash',
        env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' },
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.equal(result.exitCode, 0, `bash -n rejected the emitted command (${foreign}): ${result.stderr}`);
    });

    test('win32 projection keeps forward-slash paths in the chain', () => {
      const emitted = hooksSurface.buildHookCommand('C:\\Users\\u\\.claude', 'gsd-statusline.js', {
        runtime: 'claude',
        platform: 'win32',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
      });
      assert.ok(typeof emitted === 'string', `no command emitted: ${emitted}`);
      assert.ok(emitted.includes('"$(for n in '), `win32 chain shape missing: ${emitted}`);
      assert.ok(emitted.includes('C:/Program Files/nodejs/node.exe'), `forward-slash baked path missing: ${emitted}`);
      assert.ok(!emitted.includes('\\'), `backslash survived win32 projection: ${emitted}`);
    });
  });

  describe('managed-set parity (RULESET.GENERATIVE-FIX)', () => {
    // #3662: the guard basenames live in TWO parallel surfaces — the runner
    // rewriter's gate (MANAGED_HOOK_BASENAMES_BY_SURFACE, via
    // isManagedHookBasename) and the command recognizer
    // (MANAGED_HOOK_COMMAND_BASENAMES_BY_SURFACE, via isManagedHookCommand —
    // uninstall + settings-migration recognition). The two lists must agree
    // on every JS hook; this row fails the moment one gains a basename the
    // other lacks.
    test('every managed js basename is recognized by both managed sets', () => {
      const projection = require('../gsd-core/bin/lib/shell-command-projection.cjs');
      for (const basename of [...MANAGED_JS_HOOKS, ...GUARD_HOOKS]) {
        const scriptPath = `/home/u/.claude/hooks/${basename}`;
        assert.ok(
          projection.isManagedHookBasename(scriptPath, { surface: 'settings-json' }),
          `${basename} missing from the runner-rewriter gate set (isManagedHookBasename)`,
        );
        const command = `"/usr/bin/node" "${scriptPath}"`;
        assert.ok(
          projection.isManagedHookCommand(command, { surface: 'settings-json' }),
          `${basename} missing from the command recognizer set (isManagedHookCommand)`,
        );
      }
    });
  });

  describe('kimi config.toml surface', () => {
    test('kimi toml hook commands resolve node at run time', (t) => {
      if (skipOnWin32(t, 'POSIX sh execution lane')) return;
      const { home, configDir } = makeHookTree(t, 'kimi-run');
      withHome(t, home);
      const block = hooksSurface.buildKimiHooksTomlBlock(configDir, {
        hookOpts: { portableHooks: false, runtime: 'kimi' },
      });
      assert.ok(typeof block === 'string' && block.length > 0, 'kimi hooks block not built');
      const commands = [...block.matchAll(/^command = "(.*)"$/gm)].map((m) =>
        m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
      );
      assert.ok(commands.length > 0, 'no command entries found in kimi block');
      const jsCommand = commands.find((c) => c.includes('gsd-prompt-guard.js'));
      assert.ok(jsCommand, `no gsd-prompt-guard.js command in block: ${commands.join(' | ')}`);
      const foreign = foreignizeNodeTokens(jsCommand);
      const file = writeCommandFile(t, foreign, 'kimi');
      const result = runHook(file, [], {
        interpreter: 'bash',
        cwd: home,
        env: { ...process.env, HOME: home, PATH: `${posixRealNodeDir()}:/usr/bin:/bin` },
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.equal(result.exitCode, 0, `command: ${foreign}\nstderr: ${result.stderr}`);
      assert.equal(result.stdout, 'hook-ran-ok');
    });
  });
});

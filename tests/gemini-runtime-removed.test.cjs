/**
 * #1928 — Gemini CLI runtime removal + Antigravity redirect.
 *
 * Google sunset Gemini CLI on 2026-06-18; Antigravity CLI is the official
 * successor. GSD removes the `gemini` runtime and turns `--gemini` into an
 * explicit deprecation redirect (NOT a silent alias — Hyrum's Law, per the
 * issue's rejected alternative #2).
 *
 * Coverage:
 *   A. CLI redirect contract (spawned installer): the sunset notice, the
 *      no-silent-install failure path, clean UX (no stack trace), and that a
 *      co-selected valid runtime still installs.
 *   B. The `gemini` runtime is gone from every runtime-name-policy surface.
 *   C. Antigravity is PRESERVED everywhere it shared surface with gemini
 *      (GEMINI.md instruction file + the shared convertGeminiToolName tool
 *      vocabulary) — the shared-infra regression this change had to avoid.
 */

'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runMinimalInstall, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');

const ROOT = path.join(__dirname, '..');
const INSTALL_JS = path.join(ROOT, 'bin', 'install.js');

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { BUILD_TIMEOUT_MS: BUILD_HOOKS_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// hooks/dist is gitignored + built; build it idempotently so a real install
// emits hooks (mirrors golden-install-parity / install-minimal-hooks).
before(() => {
  throwIfFailed(runNode([BUILD_SCRIPT], { timeoutMs: BUILD_HOOKS_TIMEOUT_MS }), `node ${BUILD_SCRIPT}`);
});

const {
  canonicalizeRuntimeName,
  getRuntimeLabel,
  getGlobalConfigHomeFragment,
  getRuntimeNewProjectCommand,
  runtimeFlags,
  getProjectInstructionFile,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-name-policy.cjs'));

const registry = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs'));

const { convertClaudeAgentToAntigravityAgent } = require('../bin/install.js');

// Run the installer as a subprocess with an isolated HOME so no install can
// touch the real machine. Runtime-config env overrides are stripped so the
// child resolves config dirs strictly under the temp HOME.
function runInstaller(args, homeDir) {
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, GSD_TEST_MODE: '1' };
  for (const k of [
    'CLAUDE_CONFIG_DIR', 'GEMINI_CONFIG_DIR', 'ANTIGRAVITY_CONFIG_DIR',
    'XDG_CONFIG_HOME', 'CODEX_CONFIG_DIR', 'OPENCODE_CONFIG_DIR', 'KILO_CONFIG_DIR',
  ]) delete env[k];
  return spawnSync(process.execPath, [INSTALL_JS, ...args], {
    cwd: homeDir, env, encoding: 'utf8', timeout: 120000,
  });
}

describe('#1928 --gemini CLI deprecation redirect', () => {
  test('--gemini alone prints the sunset notice and exits non-zero without installing', (t) => {
    const home = createTempDir('gsd-1928-gemini-only-');
    t.after(() => cleanup(home));

    const r = runInstaller(['--gemini'], home);
    const out = `${r.stdout || ''}${r.stderr || ''}`;

    assert.strictEqual(r.status, 1, 'a bare --gemini must exit 1, not silently fall through to a Claude install');
    assert.match(out, /sunset by Google on 2026-06-18/, 'must cite the 2026-06-18 sunset date');
    assert.match(out, /--antigravity/, 'must redirect the user to --antigravity');
    assert.match(out, /Antigravity CLI \(the official successor\)/);
    // No silent install: nothing was written under the isolated HOME.
    assert.ok(!fs.existsSync(path.join(home, '.gemini')), 'must not create a .gemini runtime dir');
    assert.ok(!fs.existsSync(path.join(home, '.claude')), 'bare --gemini must not silently install Claude');
  });

  test('--gemini --global still exits 1 (removed flag regardless of scope)', (t) => {
    const home = createTempDir('gsd-1928-gemini-global-');
    t.after(() => cleanup(home));

    const r = runInstaller(['--gemini', '--global'], home);
    assert.strictEqual(r.status, 1);
    assert.match(`${r.stdout || ''}${r.stderr || ''}`, /sunset by Google on 2026-06-18/);
  });

  test('the redirect is a clean message — no stack trace leaks to the user', (t) => {
    const home = createTempDir('gsd-1928-gemini-clean-');
    t.after(() => cleanup(home));

    const r = runInstaller(['--gemini'], home);
    const err = r.stderr || '';
    assert.doesNotMatch(err, /^\s+at .+:\d+:\d+/m, 'no V8 stack frame in redirect output');
    assert.doesNotMatch(err, /\bError:|\bTypeError:|\bthrow\b/, 'no thrown-error prose in redirect output');
  });

  test('--gemini --help still prints usage (the redirect must not suppress help)', (t) => {
    const home = createTempDir('gsd-1928-gemini-help-');
    t.after(() => cleanup(home));

    const r = runInstaller(['--gemini', '--help'], home);
    assert.strictEqual(r.status, 0, '--help must exit 0, not the redirect error code');
    assert.match(`${r.stdout || ''}`, /Usage:/, 'the usage/help block must still print to stdout');
    assert.match(`${r.stderr || ''}`, /sunset by Google on 2026-06-18/, 'the notice also prints');
  });

  test('--gemini --uninstall guides manual cleanup and does NOT uninstall Claude', (t) => {
    const home = createTempDir('gsd-1928-gemini-uninstall-');
    t.after(() => cleanup(home));

    // Sentinel: a pre-existing Claude install that must survive. Run WITHOUT
    // GSD_TEST_MODE so the real uninstall dispatch is active — the redirect must
    // exit before it (the dispatch defaults an empty selection to 'claude').
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'sentinel.txt'), 'keep me');
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.GSD_TEST_MODE;
    delete env.CLAUDE_CONFIG_DIR;
    const r = spawnSync(process.execPath, [INSTALL_JS, '--gemini', '--uninstall', '--global'], {
      cwd: home, env, encoding: 'utf8', timeout: 120000,
    });

    assert.strictEqual(r.status, 1, 'must exit 1, not fall through to the uninstall dispatch');
    assert.match(`${r.stderr || ''}`, /`--gemini --uninstall` is no longer available/, 'must guide manual cleanup');
    assert.ok(fs.existsSync(path.join(home, '.claude', 'sentinel.txt')),
      'the Claude install must NOT be uninstalled (the dispatch defaults empty selection to claude)');
  });

  test('--gemini co-selected with a valid runtime prints the notice AND still installs the other runtime', (t) => {
    // Hermetic install via the repo harness (explicit --config-dir + isolated
    // HOME). `--gemini` is added alongside a valid runtime (codex): the installer
    // prints the notice but does NOT exit 1 (runMinimalInstall asserts status 0
    // internally) and installs codex.
    const { manifest, root, stderr } = runMinimalInstall({ runtime: 'codex', scope: 'global', extraArgs: ['--gemini'] });
    t.after(() => cleanup(root));

    assert.match(stderr, /sunset by Google on 2026-06-18/, 'the redirect notice still prints alongside the valid install');
    assert.match(stderr, /--antigravity/);
    assert.ok(manifest, 'the co-selected codex runtime must be installed (manifest written)');
  });

  test('control: an install WITHOUT --gemini does not print the sunset notice', (t) => {
    const { root, stderr } = runMinimalInstall({ runtime: 'codex', scope: 'global' });
    t.after(() => cleanup(root));
    assert.doesNotMatch(stderr, /sunset by Google/, 'the notice must be conditional on --gemini');
  });
});

describe('#1928 gemini removed from every runtime-name-policy surface', () => {
  test('gemini aliases no longer canonicalize', () => {
    for (const alias of ['gemini', 'gemini-cli', 'gemini-code']) {
      assert.strictEqual(canonicalizeRuntimeName(alias), null, `${alias} must not resolve to a known runtime`);
    }
  });

  test('gemini falls back on label / config-fragment / new-project surfaces', () => {
    assert.strictEqual(getRuntimeLabel('gemini'), 'Claude Code', 'label table entry removed → fail-closed default');
    assert.strictEqual(getGlobalConfigHomeFragment('gemini'), "'.claude'", 'config-home fragment removed → default');
    assert.strictEqual(getRuntimeNewProjectCommand('gemini'), '/gsd-new-project', 'new-project override removed → default');
  });

  test('runtimeFlags has no isGemini and covers exactly the non-claude, CLI-installable registry runtimes (count-agnostic)', () => {
    const flags = runtimeFlags('claude');
    assert.ok(!('isGemini' in flags), 'isGemini flag must be gone');
    // The flag set tracks the non-claude registry runtimes (one is<Runtime> per
    // id), so adding a runtime updates the count automatically — no hand-pinned
    // number that would break on the next runtime addition.
    // #2103: registry runtimes with installSurface === 'none' (e.g. vscode —
    // Marketplace/VSIX-distributed, never CLI-installed) have no --<rt> flag
    // by design (see tests/runtime-flags.test.cjs's NON_INSTALLABLE_RUNTIMES)
    // and are excluded from this count too.
    const expectedNonClaudeCount = Object.keys(registry.runtimes)
      .filter((id) => id !== 'claude' && registry.runtimes[id].runtime.installSurface !== 'none')
      .length;
    assert.strictEqual(Object.keys(flags).length, expectedNonClaudeCount,
      'flag count must equal the non-claude, CLI-installable registry runtime count');
  });

  test('gemini no longer maps to GEMINI.md (defaults to AGENTS.md)', () => {
    assert.strictEqual(getProjectInstructionFile('gemini'), 'AGENTS.md');
  });
});

describe('#1928 Antigravity preserved (shared surface with the removed gemini runtime)', () => {
  test('antigravity still resolves and keeps its GEMINI.md instruction file', () => {
    assert.strictEqual(canonicalizeRuntimeName('antigravity'), 'antigravity');
    assert.strictEqual(canonicalizeRuntimeName('antigravity-cli'), 'antigravity');
    assert.strictEqual(getProjectInstructionFile('antigravity'), 'GEMINI.md',
      'Antigravity CLI reads GEMINI.md as its contextFileName — this mapping must survive gemini removal');
    assert.strictEqual(getRuntimeLabel('antigravity'), 'Antigravity');
  });

  test('the shared Gemini-backend tool vocabulary still powers Antigravity agent conversion', () => {
    const input = ['---', 'name: gsd-x', 'description: d', 'tools: Read, Write, WebFetch, Skill', '---', '', 'body'].join('\n');
    const toolsLine = convertClaudeAgentToAntigravityAgent(input).split('\n').find((l) => l.startsWith('tools:')) || '';
    assert.ok(toolsLine.includes('read_file'), 'Read → read_file via the retained convertGeminiToolName');
    assert.ok(toolsLine.includes('write_file'), 'Write → write_file');
    assert.ok(toolsLine.includes('web_fetch'), 'WebFetch → web_fetch');
    assert.ok(!/\bskill\b/.test(toolsLine), 'Skill is still excluded (would be an invalid backend tool name)');
  });
});

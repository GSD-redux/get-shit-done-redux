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

// ---------------------------------------------------------------------------
// D. #4347 — the shell resolver and the JS registry cannot silently diverge
//
// The JS resolver dropped `gemini` in #1928 and a test pins the absence
// (tests/declarative-reference-antigravity.test.cjs:307). The SHELL resolver's
// `_gsd_at` chain in gsd-core/workflows/_runtime-launcher.snippet.sh is a flat
// hand-written list fanned out to 120+ files by scripts/sync-runtime-launcher.cjs,
// and nothing compared it against the registry — so it kept probing
// `${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/`. On a host that exports
// GEMINI_CONFIG_DIR the two resolvers picked different installs from the same
// environment.
//
// This block is the missing binding: every runtime-home env var the shell side
// probes must be one the JS side recognizes, whichever way a future
// remove-vs-keep call goes.
// ---------------------------------------------------------------------------

// allow-test-rule: source-text-is-the-product #4347 — the launcher snippet is a
// SHELL fragment inlined into Markdown; there is no module to require, so its
// text is the artifact under test (same contract as the Kimi guard parity test).
const LAUNCHER_SNIPPET = path.join(ROOT, 'gsd-core', 'workflows', '_runtime-launcher.snippet.sh');

// Shell-only env vars that are legitimate WITHOUT a registry runtime, each
// because src/runtime-homes.cts declares the id in
// LEGACY_NON_REGISTRY_RUNTIME_IDS and getGlobalConfigDir() carries a real
// dedicated branch for it. That constant's own doc states the admission rule:
// an id belongs here only after confirming the dedicated branch exists. Adding
// a var here is therefore a deliberate, reviewable act — not a way to silence
// this test.
const LEGACY_SHELL_ONLY_HOME_VARS = new Set([
  'GROK_AGENTS_HOME',   // grok — getGlobalConfigDir()'s ~/.agents branch
]);

// Not runtime homes: the chain's own locals and the generic XDG base that two
// registry descriptors (kilo, opencode) already declare as a fallback.
const NON_RUNTIME_HOME_VARS = new Set(['RUNTIME_DIR', 'HOME', 'XDG_CONFIG_HOME', '_GSD_SHIM_NAME']);

function registryHomeEnvVars() {
  const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');
  const out = new Set();
  for (const entry of Object.values(runtimes)) {
    for (const name of entry?.runtime?.configHome?.env ?? []) out.add(name);
  }
  return out;
}

// Every `${VAR:-default}` expansion that names a RUNTIME HOME — i.e. one whose
// quoted arm resolves a `/gsd-core/bin/` shim path. Scoped that way so the
// chain's own locals (`${GSD_TOOLS:-}`, `${CLAUDE_ENV_FILE:-}`) are not mistaken
// for runtime homes, and so the nested XDG form
// (`${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}`) is
// still swept.
function shellHomeEnvVars(text) {
  const out = new Set();
  for (const match of text.matchAll(/\$\{([A-Z_][A-Z0-9_]*):-/g)) {
    const name = match[1];
    if (NON_RUNTIME_HOME_VARS.has(name)) continue;
    const armEnd = text.indexOf('"', match.index);
    const arm = armEnd === -1 ? text.slice(match.index) : text.slice(match.index, armEnd);
    if (!arm.includes('/gsd-core/bin/')) continue;
    out.add(name);
  }
  return out;
}

describe('#4347 shell launcher / JS registry runtime-home parity', () => {
  test('every env var the launcher snippet probes is a registry-recognized runtime home', () => {
    const recognized = registryHomeEnvVars();
    const probed = shellHomeEnvVars(fs.readFileSync(LAUNCHER_SNIPPET, 'utf8'));

    assert.ok(probed.size > 5, `precondition: the snippet must probe real runtime homes — got ${probed.size}`);
    const orphans = [...probed].filter((name) => !recognized.has(name) && !LEGACY_SHELL_ONLY_HOME_VARS.has(name));
    assert.deepEqual(orphans, [],
      `the shell resolver probes ${orphans.join(', ')}, which the capability registry does not recognize as a ` +
      'runtime home. Either the runtime is real (add it to the registry), or the arm is dead (remove it from ' +
      '_runtime-launcher.snippet.sh and re-run `npm run sync:launcher`), or it is a deliberate legacy arm ' +
      '(declare it in LEGACY_SHELL_ONLY_HOME_VARS with the reason).');
  });

  test('the registry runtime homes the launcher omits are omitted deliberately', () => {
    // The reverse direction is intentionally NOT an equality: a registry
    // runtime with no shell arm simply cannot be resolved by an entry-point
    // script, which is a coverage question, not a divergence. Pinned as a
    // named set so ADDING a runtime surfaces here instead of silently
    // widening the gap.
    const recognized = registryHomeEnvVars();
    const probed = shellHomeEnvVars(fs.readFileSync(LAUNCHER_SNIPPET, 'utf8'));
    const missing = [...recognized].filter((name) => !probed.has(name) && !NON_RUNTIME_HOME_VARS.has(name)).sort();
    assert.deepEqual(missing, [
      'COPILOT_HOME',        // copilot's secondary alias; COPILOT_CONFIG_DIR is probed
      'KILO_CONFIG',         // kilo's file-path form; KILO_CONFIG_DIR is probed
      'KIMI_CODE_HOME',
      'KIMI_CONFIG_DIR',
      'OPENCODE_CONFIG',     // opencode's file-path form; OPENCODE_CONFIG_DIR is probed
      'PI_CODING_AGENT_DIR',
      'ZCODE_CONFIG_DIR',
    ], 'a registry runtime home gained or lost a launcher arm — confirm that is intended');
  });

  test('no propagated copy of the resolver carries an env var the snippet dropped', () => {
    // AC4 of the issue: propagated copies move WITH the source, never as a
    // hand-patched subset. `commands/` carries an older if/elif form that
    // sync-runtime-launcher.cjs does not regenerate, so it is swept here too.
    const roots = ['gsd-core/workflows', 'agents', 'commands'];
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.md')) continue;
        // allow-test-rule: source-text-is-the-product #4347 — the propagated
        // resolver is inlined shell text inside Markdown; there is nothing to
        // require.
        const text = fs.readFileSync(full, 'utf8');
        if (!text.includes('_GSD_SHIM_NAME')) continue;   // no resolver in this file
        for (const name of shellHomeEnvVars(text)) {
          if (registryHomeEnvVars().has(name) || LEGACY_SHELL_ONLY_HOME_VARS.has(name)) continue;
          offenders.push(`${path.relative(ROOT, full)}: ${name}`);
        }
      }
    };
    for (const root of roots) walk(path.join(ROOT, root));
    assert.deepEqual(offenders.sort(), [],
      'a propagated resolver copy probes an env var the registry does not recognize — re-run `npm run sync:launcher`');
  });
});

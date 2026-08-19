/**
 * Stale-bake guard tests (#1688, follow-up to #1650).
 *
 * Regression contract: on a static-frontmatter runtime (codex/opencode/kilo), if
 * `.planning/config.json` or `~/.gsd/defaults.json` was edited AFTER the
 * installed agent files were baked, `warnIfStaleBake` MUST emit a single
 * stderr warning naming the config path and the remediation command. Before
 * this module existed, the same condition was silent — the sub-agent would
 * keep using the base model with no signal (the #1650 failure mode).
 *
 * Conventions: behavioural assertions only (no readFileSync+.includes on
 * source), boundary coverage at the mtime threshold (limit-1 / limit /
 * limit+1), a fast-check property for the comparison contract, and a parity
 * assertion that STATIC_FRONTMATTER_RUNTIMES stays in sync with the bake
 * paths exposed by bin/install.js.
 */
'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  STATIC_FRONTMATTER_RUNTIMES,
  detectStaleBake,
  formatStaleBakeWarning,
  resolveRuntimeFromConfig,
  resolveAgentDir,
  warnIfStaleBake,
  _resetWarnedForTests,
} = require('../gsd-core/bin/lib/stale-bake-guard.cjs');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Pure decision function — boundary coverage at the mtime threshold
// ---------------------------------------------------------------------------
describe('stale-bake-guard.detectStaleBake (pure decision)', () => {
  const AGENT_MS = 1_700_000_000_000;

  test('claude runtime → null (spawn-time runtime, guard does not apply)', () => {
    assert.equal(detectStaleBake({ runtime: 'claude', configMtimeMs: AGENT_MS + 1000, agentMtimeMs: AGENT_MS }), null);
  });

  test('unknown runtime → null', () => {
    assert.equal(detectStaleBake({ runtime: 'gemini', configMtimeMs: AGENT_MS + 1000, agentMtimeMs: AGENT_MS }), null);
  });

  test('limit-1: config strictly OLDER than agents → null (not stale)', () => {
    assert.equal(detectStaleBake({ runtime: 'opencode', configMtimeMs: AGENT_MS - 1, agentMtimeMs: AGENT_MS }), null);
  });

  test('limit: config EQUAL to agents → null (boundary, not stale)', () => {
    assert.equal(detectStaleBake({ runtime: 'opencode', configMtimeMs: AGENT_MS, agentMtimeMs: AGENT_MS }), null);
  });

  test('limit+1: config strictly NEWER than agents → stale (the #1650 condition)', () => {
    assert.deepEqual(
      detectStaleBake({ runtime: 'opencode', configMtimeMs: AGENT_MS + 1, agentMtimeMs: AGENT_MS }),
      { stale: true, deltaMs: 1 },
    );
  });

  test('codex runtime honored symmetrically with opencode', () => {
    assert.deepEqual(
      detectStaleBake({ runtime: 'codex', configMtimeMs: AGENT_MS + 5000, agentMtimeMs: AGENT_MS }),
      { stale: true, deltaMs: 5000 },
    );
  });

  test('kilo runtime honored symmetrically with opencode/codex (#2093)', () => {
    assert.deepEqual(
      detectStaleBake({ runtime: 'kilo', configMtimeMs: AGENT_MS + 5000, agentMtimeMs: AGENT_MS }),
      { stale: true, deltaMs: 5000 },
    );
  });

  test('non-finite mtimes rejected (NaN / Infinity)', () => {
    assert.equal(detectStaleBake({ runtime: 'opencode', configMtimeMs: NaN, agentMtimeMs: AGENT_MS }), null);
    assert.equal(detectStaleBake({ runtime: 'opencode', configMtimeMs: Infinity, agentMtimeMs: AGENT_MS }), null);
    assert.equal(detectStaleBake({ runtime: 'opencode', configMtimeMs: AGENT_MS, agentMtimeMs: -Infinity }), null);
  });

  test('non-number mtimes rejected', () => {
    assert.equal(detectStaleBake({ runtime: 'opencode', configMtimeMs: '1700', agentMtimeMs: AGENT_MS }), null);
    assert.equal(detectStaleBake({ runtime: 'opencode', configMtimeMs: undefined, agentMtimeMs: AGENT_MS }), null);
    assert.equal(detectStaleBake({ runtime: 'opencode', configMtimeMs: null, agentMtimeMs: AGENT_MS }), null);
  });
});

// ---------------------------------------------------------------------------
// Pure formatter
// ---------------------------------------------------------------------------
describe('stale-bake-guard.formatStaleBakeWarning (pure formatter)', () => {
  test('empty string when not stale (decision delegated to detectStaleBake)', () => {
    assert.equal(
      formatStaleBakeWarning({ runtime: 'opencode', configPath: '/x', configMtimeMs: 100, agentMtimeMs: 200 }),
      '',
    );
  });

  test('opencode warning includes path, ISO date, runtime name, --opencode flag, and gsd update', () => {
    const w = formatStaleBakeWarning({
      runtime: 'opencode',
      configPath: '/home/u/proj/.planning/config.json',
      configMtimeMs: 1_700_000_000_000,
      agentMtimeMs: 1_699_999_999_000,
    });
    assert.match(w, /\/home\/u\/proj\/\.planning\/config\.json/);
    assert.match(w, /2023-11-14T22:13:20\.000Z/); // ISO rendering of the config mtime
    assert.match(w, /'opencode'/);
    assert.match(w, /gsd install --opencode/);
    assert.match(w, /gsd update/);
  });

  test('codex warning uses --codex flag (not --opencode)', () => {
    const w = formatStaleBakeWarning({ runtime: 'codex', configPath: '/x', configMtimeMs: 1_700_000_000_000, agentMtimeMs: 1 });
    assert.match(w, /gsd install --codex/);
    assert.doesNotMatch(w, /--opencode/);
  });

  test('kilo warning uses --kilo flag (not --opencode/--codex) (#2093)', () => {
    const w = formatStaleBakeWarning({ runtime: 'kilo', configPath: '/x', configMtimeMs: 1_700_000_000_000, agentMtimeMs: 1 });
    assert.match(w, /gsd install --kilo/);
    assert.doesNotMatch(w, /--opencode/);
    assert.doesNotMatch(w, /--codex\b/);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe('stale-bake-guard.resolveRuntimeFromConfig', () => {
  test('returns runtime string when set', () => {
    assert.equal(resolveRuntimeFromConfig({ runtime: 'opencode' }), 'opencode');
  });
  test('defaults to claude when unset / null / undefined', () => {
    assert.equal(resolveRuntimeFromConfig({}), 'claude');
    assert.equal(resolveRuntimeFromConfig(null), 'claude');
    assert.equal(resolveRuntimeFromConfig(undefined), 'claude');
  });
  test('ignores non-string runtime', () => {
    assert.equal(resolveRuntimeFromConfig({ runtime: 42 }), 'claude');
    assert.equal(resolveRuntimeFromConfig({ runtime: '' }), 'claude');
  });
});

describe('stale-bake-guard.resolveAgentDir (env-var aware)', () => {
  // Per DEFECT.WINDOWS-TEST-PORTABILITY: normalize the path-returning fn's
  // result to POSIX forward slashes via .replace(/\\/g, '/') and compare
  // against a POSIX literal. This is stronger than path.join-ing both sides
  // (which would mask a malformed backslash-on-POSIX return) and stays
  // green on every platform. Do NOT hardcode a forward-slash literal against
  // the raw return — that fails windows-latest CI.
  const posix = (p) => String(p).replace(/\\/g, '/');

  // #2093: fixed from the stale singular `.../agent` — the real installer
  // writes to the plural `agents/` dir (bin/install.js's universal
  // `agentsDest = path.join(targetDir, 'agents')`), verified against a live
  // `--opencode --global` install. The prior singular assertion here matched
  // the (wrong) implementation, which made `warnIfStaleBake` a silent no-op
  // for opencode in production — see resolveAgentDir's inline comment.
  test('opencode default lands under ~/.config/opencode/agents', () => {
    assert.equal(posix(resolveAgentDir('opencode', { env: {}, homedir: () => '/H' })), '/H/.config/opencode/agents');
  });
  test('opencode honors OPENCODE_CONFIG_DIR', () => {
    assert.equal(posix(resolveAgentDir('opencode', { env: { OPENCODE_CONFIG_DIR: '/custom/oc' }, homedir: () => '/H' })), '/custom/oc/agents');
  });
  test('codex default lands under ~/.codex/agents', () => {
    assert.equal(posix(resolveAgentDir('codex', { env: {}, homedir: () => '/H' })), '/H/.codex/agents');
  });
  test('codex honors CODEX_HOME', () => {
    assert.equal(posix(resolveAgentDir('codex', { env: { CODEX_HOME: '/custom/cx' }, homedir: () => '/H' })), '/custom/cx/agents');
  });
  test('kilo default lands under ~/.config/kilo/agents (#2093)', () => {
    assert.equal(posix(resolveAgentDir('kilo', { env: {}, homedir: () => '/H' })), '/H/.config/kilo/agents');
  });
  test('kilo honors KILO_CONFIG_DIR (#2093)', () => {
    assert.equal(posix(resolveAgentDir('kilo', { env: { KILO_CONFIG_DIR: '/custom/ko' }, homedir: () => '/H' })), '/custom/ko/agents');
  });
  test('unsupported runtime → null', () => {
    assert.equal(resolveAgentDir('gemini', { env: {}, homedir: () => '/H' }), null);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator with fixtures
// ---------------------------------------------------------------------------
describe('stale-bake-guard.warnIfStaleBake (orchestrator, fixtures)', () => {
  let tmpRoot;
  let chunks;
  let stderrStub;

  beforeEach(() => {
    _resetWarnedForTests();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stalebake-'));
    chunks = [];
    stderrStub = { write: (s) => { chunks.push(String(s)); } };
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  function setMtime(p, ms) {
    const t = new Date(ms);
    fs.utimesSync(p, t, t);
  }

  function setupProject({ runtime, configMtime, agentDir, agentMtime, agentFiles = ['gsd-executor.md'] }) {
    fs.mkdirSync(path.join(tmpRoot, '.planning'), { recursive: true });
    const cfgPath = path.join(tmpRoot, '.planning', 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ runtime }));
    if (configMtime != null) setMtime(cfgPath, configMtime);
    if (agentDir) {
      fs.mkdirSync(agentDir, { recursive: true });
      for (const f of agentFiles) {
        const p = path.join(agentDir, f);
        fs.writeFileSync(p, '---\nname: test\n---\n');
        if (agentMtime != null) setMtime(p, agentMtime);
      }
    }
  }

  // Use ms in the recent-past range that every filesystem accepts reliably
  // (avoid APFS/2038+/year-2128 edge cases that some platforms round oddly).
  const NEWER = Date.parse('2026-06-24T12:00:00Z');
  const OLDER = Date.parse('2026-05-01T08:00:00Z');

  function ocEnv(agentParentDir) {
    return { OPENCODE_CONFIG_DIR: agentParentDir };
  }
  function cxEnv(agentParentDir) {
    return { CODEX_HOME: agentParentDir };
  }
  function koEnv(agentParentDir) {
    return { KILO_CONFIG_DIR: agentParentDir };
  }

  test('claude runtime → no warning even when config is newer than agents', () => {
    // OpenCode agent dir shape so the runtime path resolves, but runtime is claude.
    const agentParent = path.join(tmpRoot, 'oc-config');
    const agentDir = path.join(agentParent, 'agents');
    setupProject({ runtime: 'claude', configMtime: NEWER, agentDir, agentMtime: OLDER });
    const wrote = warnIfStaleBake(tmpRoot, { stderr: stderrStub, homedir: () => tmpRoot, env: ocEnv(agentParent) });
    assert.equal(wrote, false);
    assert.deepEqual(chunks, []);
  });

  test('opencode: config NEWER than agents → warning written (the #1650 failure mode)', () => {
    const agentParent = path.join(tmpRoot, 'oc-config');
    const agentDir = path.join(agentParent, 'agents');
    setupProject({ runtime: 'opencode', configMtime: NEWER, agentDir, agentMtime: OLDER });
    const wrote = warnIfStaleBake(tmpRoot, { stderr: stderrStub, homedir: () => tmpRoot, env: ocEnv(agentParent) });
    assert.equal(wrote, true);
    assert.equal(chunks.length, 1);
    assert.match(chunks[0], /model config in .*config\.json changed since agents were last baked/);
    assert.match(chunks[0], /'opencode'/);
    assert.match(chunks[0], /gsd install --opencode/);
  });

  test('codex: config NEWER than agents → warning written with --codex flag', () => {
    const agentParent = path.join(tmpRoot, 'cx-home');
    const agentDir = path.join(agentParent, 'agents');
    setupProject({ runtime: 'codex', configMtime: NEWER, agentDir, agentMtime: OLDER, agentFiles: ['gsd-executor.toml'] });
    const wrote = warnIfStaleBake(tmpRoot, { stderr: stderrStub, homedir: () => tmpRoot, env: cxEnv(agentParent) });
    assert.equal(wrote, true);
    assert.match(chunks[0], /gsd install --codex/);
  });

  // #2093: kilo bakes model: like opencode (same static-frontmatter constraint).
  test('kilo: config NEWER than agents → warning written with --kilo flag', () => {
    const agentParent = path.join(tmpRoot, 'ko-config');
    const agentDir = path.join(agentParent, 'agents');
    setupProject({ runtime: 'kilo', configMtime: NEWER, agentDir, agentMtime: OLDER });
    const wrote = warnIfStaleBake(tmpRoot, { stderr: stderrStub, homedir: () => tmpRoot, env: koEnv(agentParent) });
    assert.equal(wrote, true);
    assert.equal(chunks.length, 1);
    assert.match(chunks[0], /model config in .*config\.json changed since agents were last baked/);
    assert.match(chunks[0], /'kilo'/);
    assert.match(chunks[0], /gsd install --kilo/);
  });

  test('kilo: config OLDER than agents → no warning (boundary limit-1)', () => {
    const agentParent = path.join(tmpRoot, 'ko-config');
    const agentDir = path.join(agentParent, 'agents');
    setupProject({ runtime: 'kilo', configMtime: OLDER, agentDir, agentMtime: NEWER });
    const wrote = warnIfStaleBake(tmpRoot, { stderr: stderrStub, homedir: () => tmpRoot, env: koEnv(agentParent) });
    assert.equal(wrote, false);
    assert.deepEqual(chunks, []);
  });

  test('opencode: config OLDER than agents → no warning (boundary limit-1)', () => {
    const agentParent = path.join(tmpRoot, 'oc-config');
    const agentDir = path.join(agentParent, 'agents');
    setupProject({ runtime: 'opencode', configMtime: OLDER, agentDir, agentMtime: NEWER });
    const wrote = warnIfStaleBake(tmpRoot, { stderr: stderrStub, homedir: () => tmpRoot, env: ocEnv(agentParent) });
    assert.equal(wrote, false);
    assert.deepEqual(chunks, []);
  });

  test('opencode: config EQUAL to agents → no warning (boundary limit)', () => {
    const agentParent = path.join(tmpRoot, 'oc-config');
    const agentDir = path.join(agentParent, 'agents');
    setupProject({ runtime: 'opencode', configMtime: NEWER, agentDir, agentMtime: NEWER });
    const wrote = warnIfStaleBake(tmpRoot, { stderr: stderrStub, homedir: () => tmpRoot, env: ocEnv(agentParent) });
    assert.equal(wrote, false);
  });

  test('opencode: agent dir missing (runtime not installed) → no warning, no throw', () => {
    setupProject({ runtime: 'opencode', configMtime: NEWER, agentDir: null });
    const wrote = warnIfStaleBake(tmpRoot, {
      stderr: stderrStub,
      homedir: () => tmpRoot,
      env: ocEnv(path.join(tmpRoot, 'nonexistent-oc')),
    });
    assert.equal(wrote, false);
    assert.deepEqual(chunks, []);
  });

  test('opencode: agent dir present but no gsd-* files → no warning', () => {
    const agentParent = path.join(tmpRoot, 'oc-config');
    const agentDir = path.join(agentParent, 'agents');
    setupProject({ runtime: 'opencode', configMtime: NEWER, agentDir, agentMtime: OLDER, agentFiles: ['some-other-agent.md'] });
    const wrote = warnIfStaleBake(tmpRoot, { stderr: stderrStub, homedir: () => tmpRoot, env: ocEnv(agentParent) });
    assert.equal(wrote, false);
  });

  test('dedup: second call with same (runtime, cwd) → no repeat warning', () => {
    const agentParent = path.join(tmpRoot, 'oc-config');
    const agentDir = path.join(agentParent, 'agents');
    setupProject({ runtime: 'opencode', configMtime: NEWER, agentDir, agentMtime: OLDER });
    const opts = { stderr: stderrStub, homedir: () => tmpRoot, env: ocEnv(agentParent) };
    const w1 = warnIfStaleBake(tmpRoot, opts);
    const w2 = warnIfStaleBake(tmpRoot, opts);
    assert.equal(w1, true);
    assert.equal(w2, false);
    assert.equal(chunks.length, 1);
  });

  test('global ~/.gsd/defaults.json (in tmp homedir) NEWER than agents → warning', () => {
    const agentParent = path.join(tmpRoot, 'oc-config');
    const agentDir = path.join(agentParent, 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    const ap = path.join(agentDir, 'gsd-executor.md');
    fs.writeFileSync(ap, '---\n---\n');
    setMtime(ap, OLDER);
    // project config older than agents, but GLOBAL config newer → warning
    fs.mkdirSync(path.join(tmpRoot, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.planning', 'config.json'), JSON.stringify({ runtime: 'opencode' }));
    setMtime(path.join(tmpRoot, '.planning', 'config.json'), OLDER - 1000);
    fs.mkdirSync(path.join(tmpRoot, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.gsd', 'defaults.json'), JSON.stringify({}));
    setMtime(path.join(tmpRoot, '.gsd', 'defaults.json'), NEWER);
    const wrote = warnIfStaleBake(tmpRoot, { stderr: stderrStub, homedir: () => tmpRoot, env: ocEnv(agentParent) });
    assert.equal(wrote, true);
    assert.match(chunks[0], /defaults\.json/);
  });

  test('guard never throws — stderr.write failure is swallowed', () => {
    const agentParent = path.join(tmpRoot, 'oc-config');
    const agentDir = path.join(agentParent, 'agents');
    setupProject({ runtime: 'opencode', configMtime: NEWER, agentDir, agentMtime: OLDER });
    const throwingStderr = { write: () => { throw new Error('boom'); } };
    let threw = false;
    try {
      warnIfStaleBake(tmpRoot, { stderr: throwingStderr, homedir: () => tmpRoot, env: ocEnv(agentParent) });
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
  });
});

// ---------------------------------------------------------------------------
// Property tests for the comparison contract (RULESET.TESTS.property-based-testing)
// ---------------------------------------------------------------------------
describe('stale-bake-guard property tests (fast-check)', () => {
  let fc;
  try {
    fc = require('fast-check');
  } catch {
    test('fast-check not installed — property tests skipped', { skip: true }, () => {});
    return;
  }

  test('detectStaleBake is threshold-monotonic across the agent-mtime boundary', () => {
    fc.assert(fc.property(
      fc.record({
        runtime: fc.constantFrom('opencode', 'codex'),
        agentMs: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER - 1 }),
      }),
      ({ runtime, agentMs }) => {
        const below = detectStaleBake({ runtime, configMtimeMs: agentMs - 1, agentMtimeMs: agentMs });
        const at = detectStaleBake({ runtime, configMtimeMs: agentMs, agentMtimeMs: agentMs });
        const above = detectStaleBake({ runtime, configMtimeMs: agentMs + 1, agentMtimeMs: agentMs });
        assert.equal(below, null, 'config older than agents must not be stale');
        assert.equal(at, null, 'config equal to agents must not be stale');
        assert.deepEqual(above, { stale: true, deltaMs: 1 }, 'config strictly newer must be stale with deltaMs=1');
        return true;
      },
    ), { numRuns: 200 });
  });

  test('claude runtime is always null regardless of mtimes', () => {
    fc.assert(fc.property(
      fc.integer(), fc.integer(),
      (c, a) => detectStaleBake({ runtime: 'claude', configMtimeMs: c, agentMtimeMs: a }) === null,
    ), { numRuns: 200 });
  });
});

// ---------------------------------------------------------------------------
// Parity assertion (DEFECT.GENERATIVE-FIX): STATIC_FRONTMATTER_RUNTIMES must
// stay in sync with the bake paths in bin/install.js. Behavioural: we call the
// exported converter + resolver and assert each listed runtime actually wires a
// baked model. Catches drift if someone adds a runtime to the set without a
// matching bake path (or breaks the opencode bake the whole guard rests on).
// ---------------------------------------------------------------------------
describe('stale-bake-guard parity with bin/install.js bake paths', () => {
  let install;
  try {
    install = require(path.join(REPO_ROOT, 'bin', 'install.js'));
  } catch {
    test('bin/install.js not loadable in this env — parity test skipped', { skip: true }, () => {});
    return;
  }

  test('STATIC_FRONTMATTER_RUNTIMES is exactly codex + kilo + opencode (no silent drift)', () => {
    assert.deepEqual([...STATIC_FRONTMATTER_RUNTIMES].sort(), ['codex', 'kilo', 'opencode']);
  });

  test('opencode converter bakes a model: line when modelOverride is provided', () => {
    const sample = '---\nname: gsd-executor\ndescription: x\nmodel: sonnet\ntools: Read\n---\nbody\n';
    const out = install.convertClaudeToOpencodeFrontmatter(sample, { isAgent: true, modelOverride: 'opencode-go/deepseek-v4-flash' });
    assert.ok(
      typeof out === 'string' && out.includes('model: opencode-go/deepseek-v4-flash'),
      'opencode converter no longer bakes modelOverride — STATIC_FRONTMATTER_RUNTIMES is stale vs bin/install.js',
    );
  });

  // #2093: kilo bakes model: the same way opencode does (same static-frontmatter constraint).
  test('kilo converter bakes a model: line when modelOverride is provided', () => {
    const sample = '---\nname: gsd-executor\ndescription: x\nmodel: sonnet\ntools: Read\n---\nbody\n';
    const out = install.convertClaudeToKiloFrontmatter(sample, { isAgent: true, modelOverride: 'anthropic/claude-sonnet-5' });
    assert.ok(
      typeof out === 'string' && out.includes('model: anthropic/claude-sonnet-5'),
      'kilo converter no longer bakes modelOverride — STATIC_FRONTMATTER_RUNTIMES is stale vs bin/install.js',
    );
  });

  test('kilo converter omits model: when no override (stale-bake fallback shape)', () => {
    const sample = '---\nname: gsd-executor\ndescription: x\nmodel: sonnet\ntools: Read\n---\nbody\n';
    const out = install.convertClaudeToKiloFrontmatter(sample, { isAgent: true });
    assert.ok(typeof out === 'string', 'converter must return a string');
    assert.doesNotMatch(out, /^model:/m, 'no-override path should not emit a model: line');
  });

  test('opencode converter omits model: when no override (stale-bake fallback shape)', () => {
    const sample = '---\nname: gsd-executor\ndescription: x\nmodel: sonnet\ntools: Read\n---\nbody\n';
    const out = install.convertClaudeToOpencodeFrontmatter(sample, { isAgent: true });
    assert.ok(typeof out === 'string', 'converter must return a string');
    assert.doesNotMatch(out, /^model:/m, 'no-override path should not emit a model: line');
  });

  test('readGsdEffectiveModelOverrides resolves codex + opencode overrides from .planning/config.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-parity-'));
    // #2152: sandbox HOME so the real ~/.gsd/defaults.json cannot bleed its global
    // model_overrides into this project-only assertion (hermeticity). Mirrors the
    // sibling subtests that pass a homedir option to warnIfStaleBake.
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-parity-home-'));
    try {
      fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.planning', 'config.json'),
        JSON.stringify({ model_overrides: { 'gsd-executor': 'opencode-go/flash', 'gsd-planner': 'openai/gpt-5' } }),
      );
      const { readGsdEffectiveModelOverrides } = require(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'install-model-override-resolver.cjs'));
      const resolved = readGsdEffectiveModelOverrides(tmp, { homedir: () => sandboxHome });
      assert.deepEqual(resolved, { 'gsd-executor': 'opencode-go/flash', 'gsd-planner': 'openai/gpt-5' });
    } finally {
      cleanup(tmp);
      cleanup(sandboxHome);
    }
  });
});

'use strict';

/**
 * Equivalence proof for ADR-857 phase 5b: descriptor-driven getGlobalConfigDir.
 *
 * For every runtime in the 15-entry capability registry, plus grok and unknown
 * runtime, this test asserts that getGlobalConfigDir() produces exactly the
 * same path that the old hardcoded switch produced (golden expected values
 * captured from the switch BEFORE any edits). All assertions are byte-identical.
 *
 * The injected opts seam on resolveConfigHomeFromDescriptor is used to control:
 *   - the env record (avoid ambient env var pollution)
 *   - the home directory (make tests hermetic)
 *   - existsSync (control probe-hit / probe-miss scenarios)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const {
  getGlobalConfigDir,
  getGlobalSkillsBase,
  resolveAntigravityGlobalDir,
  resolveKimiGlobalDir,
  resolveKimiHooksTomlDir,
  resolveConfigHomeFromDescriptor,
  resolveSkillsBaseFromDescriptor,
  detectAntigravityDirAmbiguity,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'));

const HOME = os.homedir();

// ── Helper: run fn with process.env temporarily mutated ──────────────────────

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k] of Object.entries(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// All env vars for all runtimes — cleared in each test that calls getGlobalConfigDir directly
const ALL_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'CODEX_HOME',
  'GROK_AGENTS_HOME', 'COPILOT_CONFIG_DIR', 'COPILOT_HOME', 'ANTIGRAVITY_CONFIG_DIR',
  'WINDSURF_CONFIG_DIR', 'AUGMENT_CONFIG_DIR', 'TRAE_CONFIG_DIR', 'QWEN_CONFIG_DIR',
  'HERMES_HOME', 'CODEBUDDY_CONFIG_DIR', 'CLINE_CONFIG_DIR', 'KIMI_CONFIG_DIR',
  'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'KILO_CONFIG_DIR', 'KILO_CONFIG',
  'XDG_CONFIG_HOME', 'PI_CODING_AGENT_DIR',
];

function clearAllEnvKeys() {
  const saved = {};
  for (const k of ALL_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return saved;
}

function restoreEnvKeys(saved) {
  for (const k of ALL_ENV_KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
}

// ── STEP 0: golden scenarios captured from old switch BEFORE edits ────────────

// GOLDEN DEFAULTS (no env vars set, no existsSync probe hits).
// kimi is NOT included here because it depends on real filesystem probing —
// its probe-miss/hit scenarios are covered separately via injected existsSync.
// antigravity default also depends on probing; the default assumes NO dirs exist.
const GOLDEN_DEFAULTS = {
  claude:      path.join(HOME, '.claude'),
  cursor:      path.join(HOME, '.cursor'),
  codex:       path.join(HOME, '.codex'),
  grok:        path.join(HOME, '.agents'),
  copilot:     path.join(HOME, '.copilot'),
  antigravity: path.join(HOME, '.gemini', 'antigravity'),  // probe-miss → first candidate
  windsurf:    path.join(HOME, '.codeium', 'windsurf'),
  augment:     path.join(HOME, '.augment'),
  trae:        path.join(HOME, '.trae'),
  qwen:        path.join(HOME, '.qwen'),
  hermes:      path.join(HOME, '.hermes'),
  codebuddy:   path.join(HOME, '.codebuddy'),
  cline:       path.join(HOME, '.cline'),
  opencode:    path.join(HOME, '.config', 'opencode'),
  kilo:        path.join(HOME, '.config', 'kilo'),
  zcode:       path.join(HOME, '.zcode'),
  pi:          path.join(HOME, '.pi', 'agent'),  // dot-home-nested, no probe (like windsurf)
};

// ── GOLDEN DEFAULTS ────────────────────────────────────────────────────────────

describe('descriptor-driven equivalence: defaults (no env vars, no probe hits)', () => {
  // kimi is excluded: its default depends on real filesystem probing (probe-hit/miss
  // vary by machine). kimi probe scenarios are covered in the generic-agents-root suite
  // with injected existsSync.
  // antigravity is excluded: it also depends on real fs probing (probe candidates
  // ~/.gemini/antigravity, ~/.gemini/antigravity-ide, ~/.gemini/antigravity-cli);
  // a machine that has antigravity-ide or antigravity-cli but not antigravity gets a
  // different result. antigravity probe scenarios are covered in the dot-home-nested
  // suite with injected existsSync.
  for (const [runtime, expected] of Object.entries(GOLDEN_DEFAULTS).filter(
    ([r]) => r !== 'antigravity',
  )) {
    test(`${runtime} default resolves to its golden config dir`, () => {
      const saved = clearAllEnvKeys();
      try {
        assert.strictEqual(getGlobalConfigDir(runtime), expected, `${runtime} default → ${expected}`);
      } finally {
        restoreEnvKeys(saved);
      }
    });
  }

  test('unknown runtime falls back to ~/.claude (CLAUDE_CONFIG_DIR unset)', () => {
    const saved = clearAllEnvKeys();
    try {
      assert.strictEqual(getGlobalConfigDir('totally-unknown-runtime-xyz'), path.join(HOME, '.claude'));
    } finally {
      restoreEnvKeys(saved);
    }
  });
});

// ── GOLDEN ENV OVERRIDES ──────────────────────────────────────────────────────

describe('descriptor-driven equivalence: env-var overrides', () => {
  const cases = [
    { runtime: 'claude',    envKey: 'CLAUDE_CONFIG_DIR',    value: '/custom/claude' },
    { runtime: 'cursor',    envKey: 'CURSOR_CONFIG_DIR',    value: '/custom/cursor' },
    { runtime: 'codex',     envKey: 'CODEX_HOME',           value: '/custom/codex' },
    { runtime: 'grok',      envKey: 'GROK_AGENTS_HOME',     value: '/custom/grok' },
    { runtime: 'augment',   envKey: 'AUGMENT_CONFIG_DIR',   value: '/custom/augment' },
    { runtime: 'trae',      envKey: 'TRAE_CONFIG_DIR',      value: '/custom/trae' },
    { runtime: 'qwen',      envKey: 'QWEN_CONFIG_DIR',      value: '/custom/qwen' },
    { runtime: 'hermes',    envKey: 'HERMES_HOME',          value: '/custom/hermes' },
    { runtime: 'codebuddy', envKey: 'CODEBUDDY_CONFIG_DIR', value: '/custom/codebuddy' },
    { runtime: 'cline',     envKey: 'CLINE_CONFIG_DIR',     value: '/custom/cline' },
    { runtime: 'windsurf',  envKey: 'WINDSURF_CONFIG_DIR',  value: '/custom/windsurf' },
    { runtime: 'antigravity', envKey: 'ANTIGRAVITY_CONFIG_DIR', value: '/custom/antigravity' },
    { runtime: 'kimi',      envKey: 'KIMI_CONFIG_DIR',      value: '/custom/kimi' },
    { runtime: 'opencode',  envKey: 'OPENCODE_CONFIG_DIR',  value: '/custom/opencode' },
    { runtime: 'kilo',      envKey: 'KILO_CONFIG_DIR',      value: '/custom/kilo' },
    { runtime: 'pi',        envKey: 'PI_CODING_AGENT_DIR',  value: '/custom/pi-agent' },
  ];

  for (const { runtime, envKey, value } of cases) {
    test(`${runtime}: ${envKey} override → ${value}`, () => {
      const saved = clearAllEnvKeys();
      process.env[envKey] = value;
      try {
        assert.strictEqual(getGlobalConfigDir(runtime), value);
      } finally {
        restoreEnvKeys(saved);
      }
    });
  }

  // copilot: COPILOT_CONFIG_DIR takes precedence over COPILOT_HOME
  test('copilot: COPILOT_CONFIG_DIR override (first env wins)', () => {
    const saved = clearAllEnvKeys();
    process.env['COPILOT_CONFIG_DIR'] = '/custom/copilot-dir';
    process.env['COPILOT_HOME'] = '/should/not/win';
    try {
      assert.strictEqual(String(getGlobalConfigDir('copilot')).replace(/\\/g, '/'), '/custom/copilot-dir');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('copilot: COPILOT_HOME fallback when COPILOT_CONFIG_DIR absent', () => {
    const saved = clearAllEnvKeys();
    process.env['COPILOT_HOME'] = '/custom/copilot-home';
    try {
      assert.strictEqual(String(getGlobalConfigDir('copilot')).replace(/\\/g, '/'), '/custom/copilot-home');
    } finally {
      restoreEnvKeys(saved);
    }
  });
});

// ── GOLDEN TILDE EXPANSION ─────────────────────────────────────────────────────

describe('descriptor-driven equivalence: tilde expansion in env overrides', () => {
  test('claude: CLAUDE_CONFIG_DIR=~/foo expands to homedir/foo', () => {
    withEnv({ CLAUDE_CONFIG_DIR: '~/foo' }, () => {
      assert.strictEqual(getGlobalConfigDir('claude'), path.join(HOME, 'foo'));
    });
  });

  test('kimi: KIMI_CONFIG_DIR=~/kimi expands to homedir/kimi', () => {
    withEnv({ KIMI_CONFIG_DIR: '~/kimi' }, () => {
      assert.strictEqual(getGlobalConfigDir('kimi'), path.join(HOME, 'kimi'));
    });
  });

  test('pi: PI_CODING_AGENT_DIR=~/pi-agent expands to homedir/pi-agent', () => {
    withEnv({ PI_CODING_AGENT_DIR: '~/pi-agent' }, () => {
      assert.strictEqual(getGlobalConfigDir('pi'), path.join(HOME, 'pi-agent'));
    });
  });
});

// ── #3023: PI_CODING_AGENT_DIR override — pi's own upstream config-dir env var ──
//
// pi's real source (`packages/coding-agent/src/config.ts`) reads
// `PI_CODING_AGENT_DIR` to override its GLOBAL agent dir outright — the whole
// `~/.pi/agent` path, not just the `.pi` segment. That is exactly the
// dot-home-nested env-override shape `resolveConfigHomeFromDescriptor` already
// implements for antigravity/windsurf: `env[0]` set -> `expandTilde(value)`
// returned directly, no join with parent/name. Adding the var to pi's
// `capabilities/pi/capability.json` `configHome.env` was the whole fix; no new
// resolver branch was needed.
describe('#3023: pi PI_CODING_AGENT_DIR — dot-home-nested override semantics', () => {
  test('unset -> default ~/.pi/agent', () => {
    const result = resolveConfigHomeFromDescriptor(
      { kind: 'dot-home-nested', name: 'agent', parent: '.pi', env: ['PI_CODING_AGENT_DIR'] },
      { env: {}, home: '/home/u', existsSync: () => false },
    );
    assert.strictEqual(result, path.join('/home/u', '.pi', 'agent'));
  });

  test('set -> full override wins outright (whole path, not joined with parent/name)', () => {
    const result = resolveConfigHomeFromDescriptor(
      { kind: 'dot-home-nested', name: 'agent', parent: '.pi', env: ['PI_CODING_AGENT_DIR'] },
      { env: { PI_CODING_AGENT_DIR: '/custom/pi-agent' }, home: '/home/u', existsSync: () => false },
    );
    assert.strictEqual(result, '/custom/pi-agent');
  });

  // Tilde expansion against an INJECTED home (not the real os.homedir()) is
  // covered below in "expandTilde honors an injected opts.home" — the fix for
  // the bug where `expandTilde` ignored `resolveConfigHomeFromDescriptor`'s
  // `opts.home` and always resolved `~` against the real os.homedir(), shared
  // by every dot-home/dot-home-nested/xdg/generic-agents-root env override.

  test('empty-string env value falls back to the default, never redirects to a bogus path', () => {
    const result = resolveConfigHomeFromDescriptor(
      { kind: 'dot-home-nested', name: 'agent', parent: '.pi', env: ['PI_CODING_AGENT_DIR'] },
      { env: { PI_CODING_AGENT_DIR: '' }, home: '/home/u', existsSync: () => false },
    );
    assert.strictEqual(result, path.join('/home/u', '.pi', 'agent'));
  });
});

// ── expandTilde honors an injected opts.home (not just the real os.homedir()) ─
//
// `expandTilde` used to hardcode `os.homedir()` and ignore the `home` that
// `resolveConfigHomeFromDescriptor` had already resolved from `opts.home`.
// Every configHome.env override (claude's CLAUDE_CONFIG_DIR, pi's
// PI_CODING_AGENT_DIR, antigravity, windsurf, ...) routes a tilde-prefixed
// value through this seam. A caller that injects a sandbox `home` — exactly
// what hermetic tests do to keep installs inside a temp dir — silently got
// the developer's REAL home directory back instead, both a correctness bug
// and a test-escape hazard.
describe('expandTilde honors an injected opts.home (regression)', () => {
  const INJECTED_HOME = path.join(os.tmpdir(), 'gsd-injected-home-fixture');

  test('claude (dot-home): CLAUDE_CONFIG_DIR=~/custom + injected home → resolves under injected home, not os.homedir()', () => {
    const result = resolveConfigHomeFromDescriptor(
      { kind: 'dot-home', name: '.claude', env: ['CLAUDE_CONFIG_DIR'] },
      { env: { CLAUDE_CONFIG_DIR: '~/custom' }, home: INJECTED_HOME },
    );
    assert.strictEqual(result, path.join(INJECTED_HOME, 'custom'));
    assert.notStrictEqual(result, path.join(HOME, 'custom'));
  });

  test('pi (dot-home-nested): PI_CODING_AGENT_DIR=~/custom + injected home → resolves under injected home, not os.homedir()', () => {
    const result = resolveConfigHomeFromDescriptor(
      { kind: 'dot-home-nested', name: 'agent', parent: '.pi', env: ['PI_CODING_AGENT_DIR'] },
      { env: { PI_CODING_AGENT_DIR: '~/custom' }, home: INJECTED_HOME },
    );
    assert.strictEqual(result, path.join(INJECTED_HOME, 'custom'));
    assert.notStrictEqual(result, path.join(HOME, 'custom'));
  });

  test('claude: absolute env override + injected home → unchanged (tilde expansion not triggered)', () => {
    const result = resolveConfigHomeFromDescriptor(
      { kind: 'dot-home', name: '.claude', env: ['CLAUDE_CONFIG_DIR'] },
      { env: { CLAUDE_CONFIG_DIR: '/absolute/custom' }, home: INJECTED_HOME },
    );
    assert.strictEqual(result, '/absolute/custom');
  });

  test('pi: absolute env override + injected home → unchanged (tilde expansion not triggered)', () => {
    const result = resolveConfigHomeFromDescriptor(
      { kind: 'dot-home-nested', name: 'agent', parent: '.pi', env: ['PI_CODING_AGENT_DIR'] },
      { env: { PI_CODING_AGENT_DIR: '/absolute/custom' }, home: INJECTED_HOME },
    );
    assert.strictEqual(result, '/absolute/custom');
  });

  test('claude: no injected home → still resolves under the real os.homedir() (no behavior change for production callers)', () => {
    assert.strictEqual(
      resolveConfigHomeFromDescriptor(
        { kind: 'dot-home', name: '.claude', env: ['CLAUDE_CONFIG_DIR'] },
        { env: { CLAUDE_CONFIG_DIR: '~/custom' } },
      ),
      path.join(HOME, 'custom'),
    );
  });

  test('pi: no injected home → still resolves under the real os.homedir() (no behavior change for production callers)', () => {
    assert.strictEqual(
      resolveConfigHomeFromDescriptor(
        { kind: 'dot-home-nested', name: 'agent', parent: '.pi', env: ['PI_CODING_AGENT_DIR'] },
        { env: { PI_CODING_AGENT_DIR: '~/custom' } },
      ),
      path.join(HOME, 'custom'),
    );
  });

  test('claude: no injected home, via getGlobalConfigDir (real end-to-end seam) → real os.homedir()', () => {
    withEnv({ CLAUDE_CONFIG_DIR: '~/custom' }, () => {
      assert.strictEqual(getGlobalConfigDir('claude'), path.join(HOME, 'custom'));
    });
  });

  test('pi: no injected home, via getGlobalConfigDir (real end-to-end seam) → real os.homedir()', () => {
    withEnv({ PI_CODING_AGENT_DIR: '~/custom' }, () => {
      assert.strictEqual(getGlobalConfigDir('pi'), path.join(HOME, 'custom'));
    });
  });
});

// ── #3023 review finding 1: whitespace-only env override must fall back ──────
//
// expandTilde's old call sites gated on a bare `if (val)`, which is falsy
// only for `''`. A whitespace-only value (e.g. `PI_CODING_AGENT_DIR='   '`,
// which a broken shell template can produce when a substitution is blank but
// still quoted) passed the truthy check and resolved to the literal
// three-space string instead of falling back to the descriptor default. The
// fix gates every env-override consumption site in
// resolveConfigHomeFromDescriptor on `hasNonBlankOverride` (real string, at
// least one non-whitespace char) instead of bare truthiness — covering
// dot-home, dot-home-nested, all three xdg steps, and generic-agents-root
// alike (same class, same fix, not just pi's branch).
//
// Leading/trailing whitespace on an otherwise non-blank value is deliberately
// NOT trimmed (see hasNonBlankOverride's doc comment in runtime-homes.cts):
// this module never trims env-var path values elsewhere, so trimming here
// would make some non-whitespace values behave differently from before this
// fix, violating "default behavior for every non-whitespace value must stay
// byte-identical". Only entirely-blank values are rejected.
describe('#3023 review finding 1: whitespace-only env override falls back to default (regression)', () => {
  const CLAUDE_DESCRIPTOR = { kind: 'dot-home', name: '.claude', env: ['CLAUDE_CONFIG_DIR'] };
  const PI_DESCRIPTOR = { kind: 'dot-home-nested', name: 'agent', parent: '.pi', env: ['PI_CODING_AGENT_DIR'] };

  describe('claude (dot-home)', () => {
    test('whitespace-only env value falls back to the descriptor default, never the literal whitespace string', () => {
      const result = resolveConfigHomeFromDescriptor(CLAUDE_DESCRIPTOR, {
        env: { CLAUDE_CONFIG_DIR: '   ' },
        home: '/home/u',
      });
      assert.strictEqual(result, path.join('/home/u', '.claude'));
      assert.notStrictEqual(result, '   ');
    });

    test('empty-string env value falls back to the default (existing behavior preserved)', () => {
      const result = resolveConfigHomeFromDescriptor(CLAUDE_DESCRIPTOR, {
        env: { CLAUDE_CONFIG_DIR: '' },
        home: '/home/u',
      });
      assert.strictEqual(result, path.join('/home/u', '.claude'));
    });

    test('unset env value falls back to the default', () => {
      const result = resolveConfigHomeFromDescriptor(CLAUDE_DESCRIPTOR, {
        env: {},
        home: '/home/u',
      });
      assert.strictEqual(result, path.join('/home/u', '.claude'));
    });

    test('env value with interior spaces resolves under the injected home, spaces intact (guard is not over-broad)', () => {
      const result = resolveConfigHomeFromDescriptor(CLAUDE_DESCRIPTOR, {
        env: { CLAUDE_CONFIG_DIR: '~/My Agent Dir' },
        home: '/home/u',
      });
      assert.strictEqual(result, path.join('/home/u', 'My Agent Dir'));
    });

    test('normal absolute path env value is unchanged', () => {
      const result = resolveConfigHomeFromDescriptor(CLAUDE_DESCRIPTOR, {
        env: { CLAUDE_CONFIG_DIR: '/custom/claude' },
        home: '/home/u',
      });
      assert.strictEqual(result, '/custom/claude');
    });
  });

  describe('pi (dot-home-nested)', () => {
    test('whitespace-only env value falls back to the descriptor default, never the literal whitespace string', () => {
      const result = resolveConfigHomeFromDescriptor(PI_DESCRIPTOR, {
        env: { PI_CODING_AGENT_DIR: '   ' },
        home: '/home/u',
        existsSync: () => false,
      });
      assert.strictEqual(result, path.join('/home/u', '.pi', 'agent'));
      assert.notStrictEqual(result, '   ');
    });

    test('empty-string env value falls back to the default (existing behavior preserved)', () => {
      const result = resolveConfigHomeFromDescriptor(PI_DESCRIPTOR, {
        env: { PI_CODING_AGENT_DIR: '' },
        home: '/home/u',
        existsSync: () => false,
      });
      assert.strictEqual(result, path.join('/home/u', '.pi', 'agent'));
    });

    test('unset env value falls back to the default', () => {
      const result = resolveConfigHomeFromDescriptor(PI_DESCRIPTOR, {
        env: {},
        home: '/home/u',
        existsSync: () => false,
      });
      assert.strictEqual(result, path.join('/home/u', '.pi', 'agent'));
    });

    test('env value with interior spaces resolves under the injected home, spaces intact (guard is not over-broad)', () => {
      const result = resolveConfigHomeFromDescriptor(PI_DESCRIPTOR, {
        env: { PI_CODING_AGENT_DIR: '~/My Agent Dir' },
        home: '/home/u',
        existsSync: () => false,
      });
      assert.strictEqual(result, path.join('/home/u', 'My Agent Dir'));
    });

    test('normal absolute path env value is unchanged', () => {
      const result = resolveConfigHomeFromDescriptor(PI_DESCRIPTOR, {
        env: { PI_CODING_AGENT_DIR: '/custom/pi-agent' },
        home: '/home/u',
        existsSync: () => false,
      });
      assert.strictEqual(result, '/custom/pi-agent');
    });
  });

  // Full branch coverage: the same whitespace-only guard applies to every
  // env-override consumption site in resolveConfigHomeFromDescriptor, not
  // just dot-home/dot-home-nested. Each of these fails before the fix and
  // passes after.
  describe('remaining branches (xdg all 3 steps, generic-agents-root)', () => {
    test('xdg env[0] (direct override): whitespace-only falls back to default', () => {
      const result = resolveConfigHomeFromDescriptor(
        { kind: 'xdg', name: 'opencode', env: ['OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'XDG_CONFIG_HOME'] },
        { env: { OPENCODE_CONFIG_DIR: '   ' }, home: '/home/u' },
      );
      assert.strictEqual(result, path.join('/home/u', '.config', 'opencode'));
    });

    test('xdg env[1] (file-path override): whitespace-only falls through to default (not env[2])', () => {
      const result = resolveConfigHomeFromDescriptor(
        { kind: 'xdg', name: 'opencode', env: ['OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'XDG_CONFIG_HOME'] },
        { env: { OPENCODE_CONFIG: '   ' }, home: '/home/u' },
      );
      assert.strictEqual(result, path.join('/home/u', '.config', 'opencode'));
    });

    test('xdg env[2] (XDG_CONFIG_HOME): whitespace-only falls back to default', () => {
      const result = resolveConfigHomeFromDescriptor(
        { kind: 'xdg', name: 'opencode', env: ['OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'XDG_CONFIG_HOME'] },
        { env: { XDG_CONFIG_HOME: '   ' }, home: '/home/u' },
      );
      assert.strictEqual(result, path.join('/home/u', '.config', 'opencode'));
    });

    test('generic-agents-root: whitespace-only env override falls back to probe/default', () => {
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'generic-agents-root',
          name: 'agents',
          env: ['KIMI_CONFIG_DIR'],
          probe: ['~/.config/agents', '~/.agents'],
          probeExists: 'skills',
        },
        { env: { KIMI_CONFIG_DIR: '   ' }, home: '/home/u', existsSync: () => false },
      );
      assert.strictEqual(result, path.join('/home/u', '.config', 'agents'));
    });
  });
});

// ── GOLDEN XDG SCENARIOS ──────────────────────────────────────────────────────

describe('descriptor-driven equivalence: xdg runtimes (opencode, kilo)', () => {
  // opencode
  test('opencode: OPENCODE_CONFIG (file-path) → dirname', () => {
    const saved = clearAllEnvKeys();
    process.env['OPENCODE_CONFIG'] = '/home/u/cfg/opencode.json';
    try {
      assert.strictEqual(String(getGlobalConfigDir('opencode')).replace(/\\/g, '/'), '/home/u/cfg');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('opencode: OPENCODE_CONFIG_DIR takes precedence over OPENCODE_CONFIG', () => {
    const saved = clearAllEnvKeys();
    process.env['OPENCODE_CONFIG_DIR'] = '/dir/wins';
    process.env['OPENCODE_CONFIG'] = '/file/loses.json';
    try {
      assert.strictEqual(String(getGlobalConfigDir('opencode')).replace(/\\/g, '/'), '/dir/wins');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('opencode: OPENCODE_CONFIG takes precedence over XDG_CONFIG_HOME', () => {
    const saved = clearAllEnvKeys();
    process.env['OPENCODE_CONFIG'] = '/cfg/opencode.json';
    process.env['XDG_CONFIG_HOME'] = '/xdg/should/lose';
    try {
      assert.strictEqual(String(getGlobalConfigDir('opencode')).replace(/\\/g, '/'), '/cfg');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('opencode: XDG_CONFIG_HOME → ~/.config/opencode subdir', () => {
    const saved = clearAllEnvKeys();
    process.env['XDG_CONFIG_HOME'] = '/xdg';
    try {
      assert.strictEqual(getGlobalConfigDir('opencode'), path.join('/xdg', 'opencode'));
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('opencode: tilde in OPENCODE_CONFIG → dirname expands tilde', () => {
    const saved = clearAllEnvKeys();
    process.env['OPENCODE_CONFIG'] = '~/cfg/opencode.json';
    try {
      assert.strictEqual(getGlobalConfigDir('opencode'), path.join(HOME, 'cfg'));
    } finally {
      restoreEnvKeys(saved);
    }
  });

  // kilo
  test('kilo: KILO_CONFIG (file-path) → dirname', () => {
    const saved = clearAllEnvKeys();
    process.env['KILO_CONFIG'] = '/home/u/cfg/kilo.json';
    try {
      assert.strictEqual(String(getGlobalConfigDir('kilo')).replace(/\\/g, '/'), '/home/u/cfg');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('kilo: KILO_CONFIG_DIR takes precedence over KILO_CONFIG', () => {
    const saved = clearAllEnvKeys();
    process.env['KILO_CONFIG_DIR'] = '/dir/wins';
    process.env['KILO_CONFIG'] = '/file/loses.json';
    try {
      assert.strictEqual(String(getGlobalConfigDir('kilo')).replace(/\\/g, '/'), '/dir/wins');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('kilo: KILO_CONFIG takes precedence over XDG_CONFIG_HOME', () => {
    const saved = clearAllEnvKeys();
    process.env['KILO_CONFIG'] = '/cfg/kilo.json';
    process.env['XDG_CONFIG_HOME'] = '/xdg/should/lose';
    try {
      assert.strictEqual(String(getGlobalConfigDir('kilo')).replace(/\\/g, '/'), '/cfg');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('kilo: XDG_CONFIG_HOME → ~/.config/kilo subdir', () => {
    const saved = clearAllEnvKeys();
    process.env['XDG_CONFIG_HOME'] = '/xdg';
    try {
      assert.strictEqual(getGlobalConfigDir('kilo'), path.join('/xdg', 'kilo'));
    } finally {
      restoreEnvKeys(saved);
    }
  });
});

// ── GOLDEN DOT-HOME-NESTED (antigravity probe) ────────────────────────────────

describe('descriptor-driven equivalence: dot-home-nested antigravity probe hit/miss', () => {
  test('antigravity probe-miss → ~/.gemini/antigravity (first candidate)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-antigravity-miss-'));
    try {
      // no candidates exist → fallback to first
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'dot-home-nested',
          name: 'antigravity',
          parent: '.gemini',
          env: ['ANTIGRAVITY_CONFIG_DIR'],
          probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
        },
        { env: {}, home: tmpHome, existsSync: () => false },
      );
      assert.strictEqual(result, path.join(tmpHome, '.gemini', 'antigravity'));
    } finally {
      cleanup(tmpHome);
    }
  });

  test('antigravity probe-hit antigravity → returns ~/.gemini/antigravity', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-antigravity-hit-'));
    try {
      const hitPath = path.join(tmpHome, '.gemini', 'antigravity');
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'dot-home-nested',
          name: 'antigravity',
          parent: '.gemini',
          env: ['ANTIGRAVITY_CONFIG_DIR'],
          probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
        },
        { env: {}, home: tmpHome, existsSync: (p) => p === hitPath },
      );
      assert.strictEqual(result, hitPath);
    } finally {
      cleanup(tmpHome);
    }
  });

  test('antigravity probe-hit antigravity-ide → returns ~/.gemini/antigravity-ide', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-antigravity-ide-'));
    try {
      const hitPath = path.join(tmpHome, '.gemini', 'antigravity-ide');
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'dot-home-nested',
          name: 'antigravity',
          parent: '.gemini',
          env: ['ANTIGRAVITY_CONFIG_DIR'],
          probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
        },
        { env: {}, home: tmpHome, existsSync: (p) => p === hitPath },
      );
      assert.strictEqual(result, hitPath);
    } finally {
      cleanup(tmpHome);
    }
  });

  test('antigravity probe-hit antigravity-cli (only cli exists) → returns ~/.gemini/antigravity-cli', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-antigravity-cli-'));
    try {
      const hitPath = path.join(tmpHome, '.gemini', 'antigravity-cli');
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'dot-home-nested',
          name: 'antigravity',
          parent: '.gemini',
          env: ['ANTIGRAVITY_CONFIG_DIR'],
          probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
        },
        { env: {}, home: tmpHome, existsSync: (p) => p === hitPath },
      );
      assert.strictEqual(result, hitPath);
    } finally {
      cleanup(tmpHome);
    }
  });

  // ── #213/#217 coexistence regression: probeExists disambiguation ──────────
  // Before probeExists on dot-home-nested, first-bare-existing-wins meant a CLI
  // user (antigravity-cli) who also had the IDE's ~/.gemini/antigravity dir
  // present was shadowed to the legacy dir (probed first). probeExists =
  // 'gsd-core/VERSION' makes the dir GSD actually owns win, regardless of order.
  const AG_PROBE = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
  const AG_MARKER = path.join('gsd-core', 'VERSION');

  function antigravityDescriptor(withMarker) {
    const d = {
      kind: 'dot-home-nested',
      name: 'antigravity',
      parent: '.gemini',
      env: ['ANTIGRAVITY_CONFIG_DIR'],
      probe: AG_PROBE,
    };
    if (withMarker) d.probeExists = AG_MARKER;
    return d;
  }

  test('coexistence: legacy antigravity + antigravity-cli both exist, only cli is GSD-marked → returns antigravity-cli', () => {
    const home = '/home/u';
    const cliDir = path.join(home, '.gemini', 'antigravity-cli');
    const legacyDir = path.join(home, '.gemini', 'antigravity');
    const markerPath = path.join(cliDir, AG_MARKER);
    // Both dirs exist on disk; only the cli dir carries gsd-core/VERSION.
    const existsSync = (p) =>
      p === markerPath || p === cliDir || p === legacyDir;
    const result = resolveConfigHomeFromDescriptor(antigravityDescriptor(true), {
      env: {},
      home,
      existsSync,
    });
    assert.strictEqual(result, cliDir, 'GSD-marked cli dir must win over bare-existing legacy dir');
  });

  test('coexistence WITHOUT probeExists still shadows to legacy (documents the pre-fix behavior)', () => {
    const home = '/home/u';
    const cliDir = path.join(home, '.gemini', 'antigravity-cli');
    const legacyDir = path.join(home, '.gemini', 'antigravity');
    const existsSync = (p) => p === cliDir || p === legacyDir;
    const result = resolveConfigHomeFromDescriptor(antigravityDescriptor(false), {
      env: {},
      home,
      existsSync,
    });
    // No marker → legacy first-bare-existing wins. This is exactly the #217 bug
    // and proves probeExists is the load-bearing fix.
    assert.strictEqual(result, legacyDir);
  });

  test('coexistence: legacy + ide both exist, only ide is GSD-marked → returns antigravity-ide', () => {
    const home = '/home/u';
    const ideDir = path.join(home, '.gemini', 'antigravity-ide');
    const legacyDir = path.join(home, '.gemini', 'antigravity');
    const markerPath = path.join(ideDir, AG_MARKER);
    const existsSync = (p) => p === markerPath || p === ideDir || p === legacyDir;
    const result = resolveConfigHomeFromDescriptor(antigravityDescriptor(true), {
      env: {},
      home,
      existsSync,
    });
    assert.strictEqual(result, ideDir);
  });

  test('marker on legacy dir: GSD lives in legacy antigravity (a real 1.x install) → returns legacy even when cli dir exists bare', () => {
    const home = '/home/u';
    const legacyDir = path.join(home, '.gemini', 'antigravity');
    const cliDir = path.join(home, '.gemini', 'antigravity-cli');
    const markerPath = path.join(legacyDir, AG_MARKER);
    // Legacy carries the marker; cli dir exists but is not GSD's. Legacy wins.
    const existsSync = (p) => p === markerPath || p === legacyDir || p === cliDir;
    const result = resolveConfigHomeFromDescriptor(antigravityDescriptor(true), {
      env: {},
      home,
      existsSync,
    });
    assert.strictEqual(result, legacyDir);
  });

  test('no marker anywhere (dirs exist but no GSD installed yet): falls back to bare-existence first match', () => {
    const home = '/home/u';
    const ideDir = path.join(home, '.gemini', 'antigravity-ide');
    // Only ide dir exists, no gsd-core/VERSION anywhere → pass 2 returns ide.
    const existsSync = (p) => p === ideDir;
    const result = resolveConfigHomeFromDescriptor(antigravityDescriptor(true), {
      env: {},
      home,
      existsSync,
    });
    assert.strictEqual(result, ideDir, 'with no marker, bare-existence pass still resolves the single existing 2.x dir');
  });

  test('probeExists present but nothing exists → fallback to probe[0] (legacy default preserved)', () => {
    const home = '/home/u';
    const result = resolveConfigHomeFromDescriptor(antigravityDescriptor(true), {
      env: {},
      home,
      existsSync: () => false,
    });
    assert.strictEqual(result, path.join(home, '.gemini', 'antigravity'));
  });

  test('antigravity: ANTIGRAVITY_CONFIG_DIR env override wins over any probe', () => {
    const result = resolveConfigHomeFromDescriptor(
      {
        kind: 'dot-home-nested',
        name: 'antigravity',
        parent: '.gemini',
        env: ['ANTIGRAVITY_CONFIG_DIR'],
        probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
      },
      { env: { ANTIGRAVITY_CONFIG_DIR: '/custom/ag' }, home: '/home/u', existsSync: () => true },
    );
    assert.strictEqual(result, '/custom/ag');
  });

  test('windsurf (no probe) → ~/.codeium/windsurf regardless of existsSync', () => {
    const result = resolveConfigHomeFromDescriptor(
      {
        kind: 'dot-home-nested',
        name: 'windsurf',
        parent: '.codeium',
        env: ['WINDSURF_CONFIG_DIR'],
      },
      { env: {}, home: '/home/u', existsSync: () => true },
    );
    assert.strictEqual(result, path.join('/home/u', '.codeium', 'windsurf'));
  });
});

// ── #213/#217 thread-4: existing-install ambiguity detector ───────────────────
describe('detectAntigravityDirAmbiguity (migration/operator-guidance signal)', () => {
  const HOMEU = '/home/u';
  const dir = (name) => path.join(HOMEU, '.gemini', name);
  const markerOf = (name) => path.join(dir(name), 'gsd-core', 'VERSION');

  test('single dir present → not ambiguous', () => {
    const cli = dir('antigravity-cli');
    const r = detectAntigravityDirAmbiguity({
      env: {},
      home: HOMEU,
      existsSync: (p) => p === cli || p === markerOf('antigravity-cli'),
    });
    assert.strictEqual(r.ambiguous, false);
    assert.strictEqual(r.resolved, cli);
    assert.deepStrictEqual(r.presentDirs, [cli]);
    assert.deepStrictEqual(r.gsdMarkedDirs, [cli]);
    assert.strictEqual(r.envOverridden, false);
  });

  test('legacy + cli both present, GSD marked in cli → ambiguous, resolves to cli', () => {
    const legacy = dir('antigravity');
    const cli = dir('antigravity-cli');
    const r = detectAntigravityDirAmbiguity({
      env: {},
      home: HOMEU,
      existsSync: (p) => p === legacy || p === cli || p === markerOf('antigravity-cli'),
    });
    assert.strictEqual(r.ambiguous, true, 'two probe dirs present must flag ambiguity');
    assert.strictEqual(r.resolved, cli, 'marker disambiguates resolution to cli');
    assert.deepStrictEqual(r.presentDirs.sort(), [legacy, cli].sort());
    assert.deepStrictEqual(r.gsdMarkedDirs, [cli]);
  });

  test('misinstall surface: legacy + cli present but GSD marked ONLY in legacy → ambiguous, resolves to legacy', () => {
    // This is exactly the #217 victim: GSD was written into the legacy/IDE dir,
    // so the marker is in legacy and the resolver keeps it there. The detector
    // flags ambiguity so the installer/update can prompt the operator.
    const legacy = dir('antigravity');
    const cli = dir('antigravity-cli');
    const r = detectAntigravityDirAmbiguity({
      env: {},
      home: HOMEU,
      existsSync: (p) => p === legacy || p === cli || p === markerOf('antigravity'),
    });
    assert.strictEqual(r.ambiguous, true);
    assert.strictEqual(r.resolved, legacy);
    assert.deepStrictEqual(r.gsdMarkedDirs, [legacy]);
  });

  test('env override short-circuits: envOverridden flag set when ANTIGRAVITY_CONFIG_DIR present', () => {
    const r = detectAntigravityDirAmbiguity({
      env: { ANTIGRAVITY_CONFIG_DIR: '/custom/ag' },
      home: HOMEU,
      existsSync: () => true,
    });
    assert.strictEqual(r.envOverridden, true);
    assert.strictEqual(r.resolved, '/custom/ag', 'env override wins over probe entirely');
  });
});

// ── GOLDEN GENERIC-AGENTS-ROOT (kimi probe) ───────────────────────────────────

describe('descriptor-driven equivalence: generic-agents-root kimi probe hit/miss', () => {
  test('kimi probe-miss → recommended root ~/.config/agents', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-kimi-miss-'));
    try {
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'generic-agents-root',
          name: 'agents',
          env: ['KIMI_CONFIG_DIR'],
          probe: ['~/.config/agents', '~/.agents'],
          probeExists: 'skills',
        },
        { env: {}, home: tmpHome, existsSync: () => false },
      );
      assert.strictEqual(result, path.join(tmpHome, '.config', 'agents'));
    } finally {
      cleanup(tmpHome);
    }
  });

  test('kimi probe-hit on recommended root ~/.config/agents/skills', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-kimi-recommended-'));
    try {
      const recommended = path.join(tmpHome, '.config', 'agents');
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'generic-agents-root',
          name: 'agents',
          env: ['KIMI_CONFIG_DIR'],
          probe: ['~/.config/agents', '~/.agents'],
          probeExists: 'skills',
        },
        {
          env: {},
          home: tmpHome,
          existsSync: (p) => p === path.join(recommended, 'skills'),
        },
      );
      assert.strictEqual(result, recommended);
    } finally {
      cleanup(tmpHome);
    }
  });

  test('kimi probe-hit on fallback ~/.agents/skills (recommended does not exist)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-kimi-fallback-'));
    try {
      const fallback = path.join(tmpHome, '.agents');
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'generic-agents-root',
          name: 'agents',
          env: ['KIMI_CONFIG_DIR'],
          probe: ['~/.config/agents', '~/.agents'],
          probeExists: 'skills',
        },
        {
          env: {},
          home: tmpHome,
          existsSync: (p) => p === path.join(fallback, 'skills'),
        },
      );
      assert.strictEqual(result, fallback);
    } finally {
      cleanup(tmpHome);
    }
  });

  test('kimi: KIMI_CONFIG_DIR env override wins over any probe', () => {
    const result = resolveConfigHomeFromDescriptor(
      {
        kind: 'generic-agents-root',
        name: 'agents',
        env: ['KIMI_CONFIG_DIR'],
        probe: ['~/.config/agents', '~/.agents'],
        probeExists: 'skills',
      },
      { env: { KIMI_CONFIG_DIR: '/custom/kimi' }, home: '/home/u', existsSync: () => true },
    );
    assert.strictEqual(result, '/custom/kimi');
  });

  // Verify resolveKimiGlobalDir wrapper delegates correctly
  test('resolveKimiGlobalDir wrapper: probe-miss → recommended root', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-rkgd-miss-'));
    try {
      assert.strictEqual(
        resolveKimiGlobalDir({ env: {}, home: tmpHome, existsSync: () => false }),
        path.join(tmpHome, '.config', 'agents'),
      );
    } finally {
      cleanup(tmpHome);
    }
  });

  test('resolveKimiGlobalDir wrapper: fallback probe-hit', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-rkgd-hit-'));
    try {
      const fallback = path.join(tmpHome, '.agents');
      assert.strictEqual(
        resolveKimiGlobalDir({
          env: {},
          home: tmpHome,
          existsSync: (p) => p === path.join(fallback, 'skills'),
        }),
        fallback,
      );
    } finally {
      cleanup(tmpHome);
    }
  });

  // Verify resolveAntigravityGlobalDir wrapper delegates correctly
  test('resolveAntigravityGlobalDir wrapper: probe-miss → ~/.gemini/antigravity', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-ragd-miss-'));
    try {
      assert.strictEqual(
        resolveAntigravityGlobalDir({ env: {}, home: tmpHome, existsSync: () => false }),
        path.join(tmpHome, '.gemini', 'antigravity'),
      );
    } finally {
      cleanup(tmpHome);
    }
  });

  test('resolveAntigravityGlobalDir wrapper: probe-hit antigravity-ide', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-ragd-hit-'));
    try {
      const hitPath = path.join(tmpHome, '.gemini', 'antigravity-ide');
      assert.strictEqual(
        resolveAntigravityGlobalDir({
          env: {},
          home: tmpHome,
          existsSync: (p) => p === hitPath,
        }),
        hitPath,
      );
    } finally {
      cleanup(tmpHome);
    }
  });
});

// ── GOLDEN EXPLICIT DIR OVERRIDE ──────────────────────────────────────────────

describe('descriptor-driven equivalence: explicitDir short-circuit', () => {
  test('explicitDir absolute path returned as-is (any runtime)', () => {
    assert.strictEqual(String(getGlobalConfigDir('claude', '/tmp/explicit')).replace(/\\/g, '/'), '/tmp/explicit');
    assert.strictEqual(String(getGlobalConfigDir('opencode', '/tmp/explicit')).replace(/\\/g, '/'), '/tmp/explicit');
    assert.strictEqual(String(getGlobalConfigDir('kimi', '/tmp/explicit')).replace(/\\/g, '/'), '/tmp/explicit');
    assert.strictEqual(String(getGlobalConfigDir('grok', '/tmp/explicit')).replace(/\\/g, '/'), '/tmp/explicit');
  });

  test('explicitDir with ~ is expanded', () => {
    assert.strictEqual(
      getGlobalConfigDir('claude', '~/foo'),
      path.join(HOME, 'foo'),
    );
  });

  test('explicitDir wins even when env var is set', () => {
    withEnv({ CLAUDE_CONFIG_DIR: '/should/not/win' }, () => {
      assert.strictEqual(String(getGlobalConfigDir('claude', '/explicit/wins')).replace(/\\/g, '/'), '/explicit/wins');
    });
  });
});

// ── GOLDEN GROK (not in registry, hardcoded) ──────────────────────────────────

describe('descriptor-driven equivalence: grok (not in registry)', () => {
  test('grok default → ~/.agents', () => {
    const saved = clearAllEnvKeys();
    try {
      assert.strictEqual(getGlobalConfigDir('grok'), path.join(HOME, '.agents'));
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('grok: GROK_AGENTS_HOME override', () => {
    withEnv({ GROK_AGENTS_HOME: '/custom/grok-agents' }, () => {
      assert.strictEqual(String(getGlobalConfigDir('grok')).replace(/\\/g, '/'), '/custom/grok-agents');
    });
  });

  test('grok: GROK_AGENTS_HOME tilde expansion', () => {
    withEnv({ GROK_AGENTS_HOME: '~/grok' }, () => {
      assert.strictEqual(getGlobalConfigDir('grok'), path.join(HOME, 'grok'));
    });
  });
});

// ── GOLDEN UNKNOWN RUNTIME (Claude fallback) ──────────────────────────────────

describe('descriptor-driven equivalence: unknown runtime fallback', () => {
  test('unknown runtime → ~/.claude default', () => {
    const saved = clearAllEnvKeys();
    try {
      assert.strictEqual(getGlobalConfigDir('no-such-runtime'), path.join(HOME, '.claude'));
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('unknown runtime → CLAUDE_CONFIG_DIR if set', () => {
    withEnv({ CLAUDE_CONFIG_DIR: '/custom/claude-for-unknown' }, () => {
      assert.strictEqual(String(getGlobalConfigDir('no-such-runtime')).replace(/\\/g, '/'), '/custom/claude-for-unknown');
    });
  });
});

describe('descriptor-driven global skills base', () => {
  test('hermes skills base is derived from descriptor artifact layout', () => {
    const saved = clearAllEnvKeys();
    try {
      assert.strictEqual(getGlobalSkillsBase('hermes'), path.join(HOME, '.hermes', 'skills', 'gsd'));
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('kilo skills base is derived from configHome.skillsHome descriptor', () => {
    const saved = clearAllEnvKeys();
    try {
      assert.strictEqual(getGlobalSkillsBase('kilo'), path.join(HOME, '.kilo', 'skills'));
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('synthetic runtime skillsHome descriptor resolves without a runtime-name branch', () => {
    const base = resolveSkillsBaseFromDescriptor(
      {
        kind: 'xdg',
        name: 'futurecli',
        env: ['FUTURE_CONFIG_DIR', 'FUTURE_CONFIG', 'XDG_CONFIG_HOME'],
        skillsHome: {
          kind: 'dot-home',
          name: '.futurecli',
          env: ['FUTURE_SKILLS_HOME'],
        },
      },
      {
        env: { FUTURE_SKILLS_HOME: '/custom/future-skills' },
        home: '/home/u',
        existsSync: () => false,
      },
    );

    assert.strictEqual(base, path.join('/custom/future-skills', 'skills'));
  });
});

// ── GOLDEN PARITY: getGlobalConfigDir via process.env for every non-probe registry runtime ──

describe('descriptor-driven parity: 13 non-probe registry runtimes × no-env-vars = golden defaults', () => {
  // This is the hardest assertion: it drives getGlobalConfigDir() (which calls
  // the registry internally) and compares against GOLDEN_DEFAULTS captured from
  // the old switch. Any discrepancy means a regression.
  // kimi is excluded because its default depends on real filesystem probing.
  // antigravity is excluded because it also depends on real fs probing — a machine
  // with ~/.gemini/antigravity-ide or ~/.gemini/antigravity-cli (but not
  // ~/.gemini/antigravity) gets a different result. Probe scenarios are covered in
  // the dot-home-nested suite with injected existsSync.
  // grok is excluded because it is not in the registry (hardcoded branch).
  const registryRuntimes = Object.keys(GOLDEN_DEFAULTS).filter(
    r => r !== 'grok' && r !== 'antigravity',
  );

  for (const runtime of registryRuntimes) {
    test(`${runtime} via getGlobalConfigDir matches its golden default`, () => {
      const saved = clearAllEnvKeys();
      try {
        assert.strictEqual(
          getGlobalConfigDir(runtime),
          GOLDEN_DEFAULTS[runtime],
          `${runtime} via getGlobalConfigDir matches golden: ${GOLDEN_DEFAULTS[runtime]}`,
        );
      } finally {
        restoreEnvKeys(saved);
      }
    });
  }
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3126-global-skills-base-runtime-path.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3126-global-skills-base-runtime-path (consolidation epic #1969 B3 #1972)", () => {
'use strict';
// Regression guard for bug #3126.
//
// buildAgentSkillsBlock() in init.cjs hardcoded `globalSkillsBase` to
// `~/.claude/skills` regardless of the active runtime. On a Cursor install,
// global: skills live under `~/.cursor/skills`, causing every global: lookup
// to silently fail with:
//   [agent-skills] WARNING: Global skill not found at "~/.cursor/skills/X/SKILL.md" — skipping
//
// Fix introduces gsd-core/bin/lib/runtime-homes.cjs with first-class
// support for every supported runtime, including:
//   - hermes: nested skills/gsd/<skillName>/ layout (#2841)
//   - cline: rules-based, returns null (no skills directory)
//   - CLAUDE_CONFIG_DIR env var for Claude (was missing)
//   - All other runtime-specific env vars

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const {
  getGlobalConfigDir,
  getGlobalSkillsBase,
  getGlobalSkillDir,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'));

// #4312: captured before any test pins HOME, so the pin guard below can assert
// it is actually in effect rather than trusting that it is.
const REAL_HOME_AT_LOAD = os.homedir();

// Helper: run fn with an env var temporarily set
function withEnv(key, value, fn) {
  const orig = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); }
  finally {
    if (orig === undefined) delete process.env[key];
    else process.env[key] = orig;
  }
}

describe('bug #3126: runtime-homes getGlobalConfigDir — defaults', () => {
  // #4312: the expectations are RELATIVE segments, resolved against a fixture
  // home inside each test rather than against the real os.homedir(). antigravity
  // resolves through an fs probe (~/.gemini/antigravity{,-ide,-cli}), so a
  // contributor who has antigravity-cli installed — and nothing else — got
  // `.gemini/antigravity-cli` here and a red suite from a clean clone. The
  // neighbouring GOLDEN DEFAULTS block already states this hazard and skips
  // antigravity for it; pinning the home keeps the row instead of dropping it,
  // and makes every other row immune to an installed runtime at the same time.
  // The probe's PREFERENCE order is covered with an injected existsSync in the
  // dot-home-nested suite, so nothing is lost here.
  const defaults = [
    ['claude',      ['.claude']],
    ['cursor',      ['.cursor']],
    ['codex',       ['.codex']],
    ['copilot',     ['.copilot']],
    ['antigravity', ['.gemini', 'antigravity']],
    ['windsurf',    ['.codeium', 'windsurf']],
    ['augment',     ['.augment']],
    ['trae',        ['.trae']],
    ['qwen',        ['.qwen']],
    ['hermes',      ['.hermes']],
    ['codebuddy',   ['.codebuddy']],
    ['cline',       ['.cline']],
    ['opencode',    ['.config', 'opencode']],
    ['kilo',        ['.config', 'kilo']],
  ];
  for (const [runtime, segments] of defaults) {
    test(`${runtime} default configDir`, (t) => {
      // os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows; both are
      // set so the fixture holds on either. An EMPTY home is the point: it is
      // the state the golden defaults describe — no probe candidate present.
      const fixtureHome = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'gsd-4312-home-'));
      const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      process.env.HOME = fixtureHome;
      process.env.USERPROFILE = fixtureHome;
      t.after(() => {
        for (const [k, v] of Object.entries(savedHome)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        cleanup(fixtureHome);
      });
      const expected = path.join(fixtureHome, ...segments);
      // Derive env-var list from the registry so new runtimes are auto-covered.
      // GROK_AGENTS_HOME is kept explicitly (grok has no registry entry).
      const { runtimes: _reg3126 } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs'));
      const _regEnvKeys3126 = Object.values(_reg3126).flatMap((r) => {
        const ch = r.runtime?.configHome;
        if (!ch) return [];
        const envs = Array.isArray(ch.env) ? ch.env : [];
        const skillsEnvs = ch.skillsHome && Array.isArray(ch.skillsHome.env) ? ch.skillsHome.env : [];
        return [...envs, ...skillsEnvs];
      });
      const envKeys = [...new Set([..._regEnvKeys3126, 'GROK_AGENTS_HOME', 'XDG_CONFIG_HOME'])];
      const saved = {};
      for (const k of envKeys) { saved[k] = process.env[k]; delete process.env[k]; }
      try {
        assert.strictEqual(getGlobalConfigDir(runtime), expected);
      } finally {
        for (const k of envKeys) {
          if (saved[k] !== undefined) process.env[k] = saved[k];
        }
      }
    });
  }
  // #4312 regression guard, deterministic on CI: the rows above are only
  // hermetic while the home pin is actually in effect. Asserting the pin itself
  // fails on EVERY machine if someone drops it, instead of only on a machine
  // that happens to have an antigravity-cli install — which is what let the
  // original defect survive seven commits.
  test('#4312: the default rows run against a pinned, empty fixture home', (t) => {
    const realHome = REAL_HOME_AT_LOAD;
    const fixtureHome = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'gsd-4312-pin-'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = fixtureHome;
    process.env.USERPROFILE = fixtureHome;
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      cleanup(fixtureHome);
    });
    assert.notStrictEqual(os.homedir(), realHome,
      'os.homedir() must follow the pinned fixture, not the developer\'s real home');
    assert.deepEqual(require('node:fs').readdirSync(fixtureHome), [],
      'the fixture home must be empty — a golden DEFAULT is what resolution returns with no probe candidate present');
    assert.strictEqual(getGlobalConfigDir('antigravity'), path.join(fixtureHome, '.gemini', 'antigravity'));
  });

  // The other half of the same contract: the probe is real, and it is why the
  // rows cannot assert against whatever home the contributor happens to have.
  test('#4312: an antigravity-cli install moves the resolved dir — the hazard the pin exists for', (t) => {
    const decoyHome = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'gsd-4312-decoy-'));
    require('node:fs').mkdirSync(path.join(decoyHome, '.gemini', 'antigravity-cli'), { recursive: true });
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = decoyHome;
    process.env.USERPROFILE = decoyHome;
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      cleanup(decoyHome);
    });
    assert.strictEqual(getGlobalConfigDir('antigravity'), path.join(decoyHome, '.gemini', 'antigravity-cli'),
      'the fs probe is documented behaviour — a default row asserting the real home is asserting this away');
  });

  test('unknown runtime falls back to ~/.claude', () => {
    withEnv('CLAUDE_CONFIG_DIR', undefined, () => {
      assert.strictEqual(getGlobalConfigDir('unknown-xyz'), path.join(os.homedir(), '.claude'));
    });
  });
});

describe('bug #3126: runtime-homes env-var overrides', () => {
  test('claude respects CLAUDE_CONFIG_DIR (was missing in old code)', () => {
    withEnv('CLAUDE_CONFIG_DIR', '/custom/claude', () => {
      assert.strictEqual(String(getGlobalConfigDir('claude')).replace(/\\/g, '/'), '/custom/claude');
    });
  });
  test('cursor respects CURSOR_CONFIG_DIR', () => {
    withEnv('CURSOR_CONFIG_DIR', '/custom/cursor', () => {
      assert.strictEqual(String(getGlobalConfigDir('cursor')).replace(/\\/g, '/'), '/custom/cursor');
    });
  });
  test('opencode respects OPENCODE_CONFIG_DIR', () => {
    withEnv('OPENCODE_CONFIG_DIR', '/custom/opencode', () => {
      withEnv('XDG_CONFIG_HOME', undefined, () => {
        assert.strictEqual(String(getGlobalConfigDir('opencode')).replace(/\\/g, '/'), '/custom/opencode');
      });
    });
  });
  test('opencode uses XDG_CONFIG_HOME when OPENCODE_CONFIG_DIR absent', () => {
    withEnv('OPENCODE_CONFIG_DIR', undefined, () => {
      withEnv('OPENCODE_CONFIG', undefined, () => {
        withEnv('XDG_CONFIG_HOME', '/xdg', () => {
          assert.strictEqual(getGlobalConfigDir('opencode'), path.join('/xdg', 'opencode'));
        });
      });
    });
  });
  test('kilo uses XDG_CONFIG_HOME when KILO_CONFIG_DIR absent', () => {
    withEnv('KILO_CONFIG_DIR', undefined, () => {
      withEnv('KILO_CONFIG', undefined, () => {
        withEnv('XDG_CONFIG_HOME', '/xdg', () => {
          assert.strictEqual(getGlobalConfigDir('kilo'), path.join('/xdg', 'kilo'));
        });
      });
    });
  });

  test('antigravity detects 2.x IDE dir when legacy dir is absent', () => {
    const home = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'gsd-antigravity-home-'));
    try {
      require('node:fs').mkdirSync(path.join(home, '.gemini', 'antigravity-ide'), { recursive: true });
      const savedHome = process.env.HOME;
      const savedUserProfile = process.env.USERPROFILE;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      withEnv('ANTIGRAVITY_CONFIG_DIR', undefined, () => {
        assert.strictEqual(
          getGlobalConfigDir('antigravity'),
          path.join(home, '.gemini', 'antigravity-ide'),
        );
      });
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
    } finally {
      cleanup(home);
    }
  });
});

describe('bug #3126: runtime-homes getGlobalSkillsBase', () => {
  test('most runtimes: skills at <configDir>/skills', () => {
    withEnv('CURSOR_CONFIG_DIR', undefined, () => {
      assert.strictEqual(
        getGlobalSkillsBase('cursor'),
        path.join(os.homedir(), '.cursor', 'skills'),
      );
    });
  });
  test('hermes: skills at <configDir>/skills/gsd (nested layout #2841)', () => {
    withEnv('HERMES_HOME', undefined, () => {
      assert.strictEqual(
        getGlobalSkillsBase('hermes'),
        path.join(os.homedir(), '.hermes', 'skills', 'gsd'),
      );
    });
  });
  test('cline: returns ~/.cline/skills (skills-capable since v3.48.0 — #782)', () => {
    withEnv('CLINE_CONFIG_DIR', undefined, () => {
      assert.strictEqual(
        getGlobalSkillsBase('cline'),
        path.join(os.homedir(), '.cline', 'skills'),
      );
    });
  });
});

describe('bug #3126: runtime-homes getGlobalSkillDir', () => {
  test('cursor: <configDir>/skills/<skillName>', () => {
    withEnv('CURSOR_CONFIG_DIR', undefined, () => {
      assert.strictEqual(
        getGlobalSkillDir('cursor', 'gsd-executor'),
        path.join(os.homedir(), '.cursor', 'skills', 'gsd-executor'),
      );
    });
  });
  test('hermes: <configDir>/skills/gsd/<skillName>', () => {
    withEnv('HERMES_HOME', undefined, () => {
      assert.strictEqual(
        getGlobalSkillDir('hermes', 'gsd-executor'),
        path.join(os.homedir(), '.hermes', 'skills', 'gsd', 'gsd-executor'),
      );
    });
  });
  test('cline: returns ~/.cline/skills/gsd-executor (skills-capable since v3.48.0 — #782)', () => {
    withEnv('CLINE_CONFIG_DIR', undefined, () => {
      assert.strictEqual(
        getGlobalSkillDir('cline', 'gsd-executor'),
        path.join(os.homedir(), '.cline', 'skills', 'gsd-executor'),
      );
    });
  });
});

describe('getGlobalConfigDir — explicitDir override and opencode/kilo file-path precedence', () => {
  // ── explicitDir override ──────────────────────────────────────────────────
  test('explicitDir absolute path is returned as-is (claude)', () => {
    assert.strictEqual(String(getGlobalConfigDir('claude', '/tmp/x')).replace(/\\/g, '/'), '/tmp/x');
  });

  test('explicitDir with tilde is expanded (opencode)', () => {
    assert.strictEqual(
      getGlobalConfigDir('opencode', '~/foo'),
      path.join(os.homedir(), 'foo'),
    );
  });

  test('explicitDir wins even when OPENCODE_CONFIG_DIR is also set', () => {
    withEnv('OPENCODE_CONFIG_DIR', '/should/not/win', () => {
      assert.strictEqual(String(getGlobalConfigDir('opencode', '/explicit/wins')).replace(/\\/g, '/'), '/explicit/wins');
    });
  });

  // ── opencode: OPENCODE_CONFIG file-path step ──────────────────────────────
  test('opencode: OPENCODE_CONFIG → path.dirname(expandTilde(value))', () => {
    withEnv('OPENCODE_CONFIG_DIR', undefined, () => {
      withEnv('XDG_CONFIG_HOME', undefined, () => {
        withEnv('OPENCODE_CONFIG', '/home/u/cfg/opencode.json', () => {
          assert.strictEqual(String(getGlobalConfigDir('opencode')).replace(/\\/g, '/'), '/home/u/cfg');
        });
      });
    });
  });

  test('opencode: OPENCODE_CONFIG_DIR takes precedence over OPENCODE_CONFIG', () => {
    withEnv('OPENCODE_CONFIG_DIR', '/dir/wins', () => {
      withEnv('OPENCODE_CONFIG', '/file/loses.json', () => {
        assert.strictEqual(String(getGlobalConfigDir('opencode')).replace(/\\/g, '/'), '/dir/wins');
      });
    });
  });

  test('opencode: OPENCODE_CONFIG takes precedence over XDG_CONFIG_HOME', () => {
    withEnv('OPENCODE_CONFIG_DIR', undefined, () => {
      withEnv('OPENCODE_CONFIG', '/cfg/opencode.json', () => {
        withEnv('XDG_CONFIG_HOME', '/xdg/should/lose', () => {
          assert.strictEqual(String(getGlobalConfigDir('opencode')).replace(/\\/g, '/'), '/cfg');
        });
      });
    });
  });

  test('opencode: default ~/.config/opencode when no env vars set', () => {
    withEnv('OPENCODE_CONFIG_DIR', undefined, () => {
      withEnv('OPENCODE_CONFIG', undefined, () => {
        withEnv('XDG_CONFIG_HOME', undefined, () => {
          assert.strictEqual(
            getGlobalConfigDir('opencode'),
            path.join(os.homedir(), '.config', 'opencode'),
          );
        });
      });
    });
  });

  // ── kilo: KILO_CONFIG file-path step ─────────────────────────────────────
  test('kilo: KILO_CONFIG → path.dirname(expandTilde(value))', () => {
    withEnv('KILO_CONFIG_DIR', undefined, () => {
      withEnv('XDG_CONFIG_HOME', undefined, () => {
        withEnv('KILO_CONFIG', '/home/u/cfg/kilo.json', () => {
          assert.strictEqual(String(getGlobalConfigDir('kilo')).replace(/\\/g, '/'), '/home/u/cfg');
        });
      });
    });
  });

  test('kilo: KILO_CONFIG_DIR takes precedence over KILO_CONFIG', () => {
    withEnv('KILO_CONFIG_DIR', '/dir/wins', () => {
      withEnv('KILO_CONFIG', '/file/loses.json', () => {
        assert.strictEqual(String(getGlobalConfigDir('kilo')).replace(/\\/g, '/'), '/dir/wins');
      });
    });
  });

  test('kilo: KILO_CONFIG takes precedence over XDG_CONFIG_HOME', () => {
    withEnv('KILO_CONFIG_DIR', undefined, () => {
      withEnv('KILO_CONFIG', '/cfg/kilo.json', () => {
        withEnv('XDG_CONFIG_HOME', '/xdg/should/lose', () => {
          assert.strictEqual(String(getGlobalConfigDir('kilo')).replace(/\\/g, '/'), '/cfg');
        });
      });
    });
  });

  test('kilo: default ~/.config/kilo when no env vars set', () => {
    withEnv('KILO_CONFIG_DIR', undefined, () => {
      withEnv('KILO_CONFIG', undefined, () => {
        withEnv('XDG_CONFIG_HOME', undefined, () => {
          assert.strictEqual(
            getGlobalConfigDir('kilo'),
            path.join(os.homedir(), '.config', 'kilo'),
          );
        });
      });
    });
  });
});

describe('bug #3126: buildAgentSkillsBlock resolves the agent-skills path per runtime (not hardcoded .claude)', () => {
  // Behavioral replacement (#3466) for the three init.cjs source-grep assertions
  // ("no hardcoded ~/.claude/skills assignment", "requires runtime-homes",
  // "warning message no longer hardcodes ~/.claude/skills"). Those proved a
  // STRING was absent/present in init.cjs's text; they would pass even if
  // buildAgentSkillsBlock resolved the WRONG path for a non-claude runtime, as
  // long as the literal old hardcoded expression didn't reappear verbatim. This
  // drives buildAgentSkillsBlock() itself — the real exported function bug
  // #3126 fixed — for two DIFFERENT runtimes with real fixture skill files
  // under real per-runtime config dirs, and asserts each resolves under ITS
  // OWN runtime's skills dir and never falls back to (or leaks into) the
  // other's.
  const fs = require('node:fs');
  const { buildAgentSkillsBlock } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'init.cjs'));

  /**
   * Creates a temp config dir with a real `skills/<skillName>/SKILL.md` fixture,
   * points `configDirEnvKey` at it for the duration of `fn`, and cleans up
   * (including restoring the env var) afterward.
   */
  function withSkillFixture(configDirEnvKey, skillName, fn) {
    const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3126-skills-'));
    const skillDir = path.join(tmpConfigDir, 'skills', skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# fixture skill\n');
    const saved = process.env[configDirEnvKey];
    process.env[configDirEnvKey] = tmpConfigDir;
    try {
      return fn(tmpConfigDir);
    } finally {
      if (saved === undefined) delete process.env[configDirEnvKey];
      else process.env[configDirEnvKey] = saved;
      cleanup(tmpConfigDir);
    }
  }

  test('cursor: resolves under CURSOR_CONFIG_DIR/skills, never falls back to .claude/skills', () => {
    withSkillFixture('CURSOR_CONFIG_DIR', 'gsd-executor', (tmpConfigDir) => {
      const diagnostics = { warnings: [] };
      const block = buildAgentSkillsBlock(
        { runtime: 'cursor', agent_skills: { 'gsd-executor': 'global:gsd-executor' } },
        'gsd-executor',
        tmpConfigDir,
        diagnostics,
      );
      const expectedRef = path.join(tmpConfigDir, 'skills', 'gsd-executor', 'SKILL.md').replace(/\\/g, '/');
      assert.ok(block.includes(expectedRef), `expected block to include ${expectedRef}, got: ${block}`);
      assert.ok(!block.includes('.claude/skills'), `cursor resolution must not fall back to .claude/skills, got: ${block}`);
      assert.deepEqual(diagnostics.warnings, [], `expected no warnings, got: ${JSON.stringify(diagnostics.warnings)}`);
    });
  });

  test('claude: resolves under CLAUDE_CONFIG_DIR/skills, never leaks into .cursor/skills', () => {
    withSkillFixture('CLAUDE_CONFIG_DIR', 'gsd-executor', (tmpConfigDir) => {
      const diagnostics = { warnings: [] };
      const block = buildAgentSkillsBlock(
        { runtime: 'claude', agent_skills: { 'gsd-executor': 'global:gsd-executor' } },
        'gsd-executor',
        tmpConfigDir,
        diagnostics,
      );
      const expectedRef = path.join(tmpConfigDir, 'skills', 'gsd-executor', 'SKILL.md').replace(/\\/g, '/');
      assert.ok(block.includes(expectedRef), `expected block to include ${expectedRef}, got: ${block}`);
      assert.ok(!block.includes('.cursor/skills'), `claude resolution must not use .cursor/skills, got: ${block}`);
      assert.deepEqual(diagnostics.warnings, [], `expected no warnings, got: ${JSON.stringify(diagnostics.warnings)}`);
    });
  });

  test('per-runtime resolution: two different runtimes in the same process each resolve into THEIR OWN config dir, never the other\'s', () => {
    // Proves this isn't a single special-cased runtime — cursor and claude,
    // driven back-to-back, must never cross-resolve into each other's fixture dir.
    withSkillFixture('CURSOR_CONFIG_DIR', 'gsd-executor', (cursorDir) => {
      withSkillFixture('CLAUDE_CONFIG_DIR', 'gsd-executor', (claudeDir) => {
        const cursorBlock = buildAgentSkillsBlock(
          { runtime: 'cursor', agent_skills: { x: 'global:gsd-executor' } }, 'x', cursorDir, { warnings: [] },
        );
        const claudeBlock = buildAgentSkillsBlock(
          { runtime: 'claude', agent_skills: { x: 'global:gsd-executor' } }, 'x', claudeDir, { warnings: [] },
        );
        const cursorPosix = cursorDir.replace(/\\/g, '/');
        const claudePosix = claudeDir.replace(/\\/g, '/');
        assert.ok(cursorBlock.includes(cursorPosix), `cursor block must reference its own config dir, got: ${cursorBlock}`);
        assert.ok(!cursorBlock.includes(claudePosix), `cursor block must not reference claude's config dir, got: ${cursorBlock}`);
        assert.ok(claudeBlock.includes(claudePosix), `claude block must reference its own config dir, got: ${claudeBlock}`);
        assert.ok(!claudeBlock.includes(cursorPosix), `claude block must not reference cursor's config dir, got: ${claudeBlock}`);
      });
    });
  });
});
  });
}

// ── resolveKimiHooksTomlDir: per-runtime hooks root (#2755) ──────────────────

describe('resolveKimiHooksTomlDir — per-runtime hooks root (#2755)', () => {
  // Pure path computation; the fixture home never needs to exist on disk.
  const FIXTURE_HOME = path.join(os.tmpdir(), 'gsd-2755-home-fixture');
  const at = (...seg) => path.join(FIXTURE_HOME, ...seg);

  test('a bare call does not throw', () => {
    assert.doesNotThrow(() => resolveKimiHooksTomlDir());
  });

  test('an omitted runtime still resolves Kimi CLI\'s ~/.kimi (back-compat)', () => {
    // The function is exported; callers and tests outside this diff pass no
    // runtime, and their destination must not move.
    assert.equal(resolveKimiHooksTomlDir({ home: FIXTURE_HOME, env: {} }), at('.kimi'));
  });

  test('runtime "kimi" resolves ~/.kimi', () => {
    assert.equal(
      resolveKimiHooksTomlDir({ home: FIXTURE_HOME, env: {}, runtime: 'kimi' }),
      at('.kimi'),
    );
  });

  test('runtime "kimi-code" resolves ~/.kimi-code', () => {
    assert.equal(
      resolveKimiHooksTomlDir({ home: FIXTURE_HOME, env: {}, runtime: 'kimi-code' }),
      at('.kimi-code'),
    );
  });

  test('KIMI_SHARE_DIR overrides the kimi root', () => {
    assert.equal(
      String(resolveKimiHooksTomlDir({ home: FIXTURE_HOME, env: { KIMI_SHARE_DIR: '/share' }, runtime: 'kimi' })).replace(/\\/g, '/'),
      '/share',
    );
  });

  test('KIMI_CODE_HOME overrides the kimi-code root', () => {
    assert.equal(
      String(resolveKimiHooksTomlDir({ home: FIXTURE_HOME, env: { KIMI_CODE_HOME: '/kcode' }, runtime: 'kimi-code' })).replace(/\\/g, '/'),
      '/kcode',
    );
  });

  test('KIMI_SHARE_DIR does not hijack the kimi-code root', () => {
    // KIMI_SHARE_DIR is Kimi CLI's own upstream var. Before #2755 it silently
    // redirected kimi-code too — that accident was the issue's suggested
    // workaround, and the fix must make it inert.
    assert.equal(
      resolveKimiHooksTomlDir({ home: FIXTURE_HOME, env: { KIMI_SHARE_DIR: '/share' }, runtime: 'kimi-code' }),
      at('.kimi-code'),
    );
  });

  test('KIMI_CODE_HOME does not hijack the kimi root', () => {
    assert.equal(
      resolveKimiHooksTomlDir({ home: FIXTURE_HOME, env: { KIMI_CODE_HOME: '/kcode' }, runtime: 'kimi' }),
      at('.kimi'),
    );
  });

  test('an unknown runtime falls back to ~/.kimi', () => {
    assert.equal(
      resolveKimiHooksTomlDir({ home: FIXTURE_HOME, env: {}, runtime: 'not-a-kimi' }),
      at('.kimi'),
    );
  });

  test('every kimi-hooks-toml runtime resolves a distinct hooks root', () => {
    // Divergence guard (CLAUDE.md → Generative Fix Divergence). The resolver
    // hardcodes the two Kimi roots while the capability registry independently
    // decides which runtimes use the kimi-hooks-toml surface. If a third one is
    // ever added without teaching the resolver its root, it silently inherits
    // ~/.kimi — which IS the #2755 defect, re-created. This fails the moment
    // those two surfaces drift apart.
    const capsDir = path.join(ROOT, 'capabilities');
    const ids = fs.readdirSync(capsDir).filter((id) => {
      const file = path.join(capsDir, id, 'capability.json');
      if (!fs.existsSync(file)) return false;
      return JSON.parse(fs.readFileSync(file, 'utf8'))?.runtime?.hooksSurface === 'kimi-hooks-toml';
    });

    assert.deepEqual(ids.sort(), ['kimi', 'kimi-code'],
      'the kimi-hooks-toml runtime set changed — teach resolveKimiHooksTomlDir the new root, then update this list');

    const roots = ids.map((id) => resolveKimiHooksTomlDir({ home: FIXTURE_HOME, env: {}, runtime: id }));
    assert.equal(new Set(roots).size, roots.length,
      `each kimi-hooks-toml runtime must resolve its own root; got ${JSON.stringify(roots)}`);
  });
});

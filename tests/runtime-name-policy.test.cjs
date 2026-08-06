'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const {
  canonicalizeRuntimeName,
  resolveRuntimeNameFromCandidates,
  getProjectInstructionFile,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-name-policy.cjs'));

describe('runtime-name-policy canonical runtime ids', () => {
  test('canonicalizes Kimi without adding extra aliases', () => {
    assert.strictEqual(canonicalizeRuntimeName('kimi'), 'kimi');
    assert.strictEqual(canonicalizeRuntimeName(' KIMI '), 'kimi');
    assert.strictEqual(resolveRuntimeNameFromCandidates('', null, 'kimi'), 'kimi');
    assert.strictEqual(canonicalizeRuntimeName('kimi-cli'), null);
  });

  test('canonicalizes devin-desktop to windsurf (#792)', () => {
    assert.strictEqual(canonicalizeRuntimeName('devin-desktop'), 'windsurf');
    assert.strictEqual(canonicalizeRuntimeName('DEVIN-DESKTOP'), 'windsurf');
    assert.strictEqual(resolveRuntimeNameFromCandidates('devin-desktop'), 'windsurf');
  });
});

describe('runtime-name-policy windsurf alias parity — manifest vs FALLBACK_ALIASES (#792)', () => {
  // DEFECT.GENERATIVE-FIX: manifest and FALLBACK_ALIASES are manually mirrored;
  // this test fails if they diverge for the windsurf key.
  const manifestPath = path.join(ROOT, 'gsd-core', 'bin', 'shared', 'runtime-aliases.manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  test('manifest windsurf array includes devin-desktop', () => {
    assert.ok(
      Array.isArray(manifest.windsurf) && manifest.windsurf.includes('devin-desktop'),
      `runtime-aliases.manifest.json windsurf array must include 'devin-desktop'; got: ${JSON.stringify(manifest.windsurf)}`,
    );
  });

  test('FALLBACK_ALIASES windsurf includes devin-desktop (via canonicalization round-trip)', () => {
    // The built module merges manifest over FALLBACK_ALIASES; if the manifest is present
    // this verifies the combined set. The manifest test above separately guards the manifest.
    // Here we verify the live canonicalizer sees devin-desktop -> windsurf.
    assert.strictEqual(
      canonicalizeRuntimeName('devin-desktop'),
      'windsurf',
      'devin-desktop must resolve to windsurf via alias lookup',
    );
  });

  test('manifest and FALLBACK_ALIASES windsurf alias sets are identical', () => {
    // Read FALLBACK_ALIASES from source to detect manual drift before a build.
    const srcPath = path.join(ROOT, 'src', 'runtime-name-policy.cts');
    // allow-test-rule: source-text-is-the-product
    // FALLBACK_ALIASES source text IS the product contract for runtimes that can't load the manifest at runtime; verifying
    // both surfaces contain the same windsurf aliases catches manual-mirror drift.
    const src = fs.readFileSync(srcPath, 'utf8');
    const match = src.match(/windsurf:\s*\[([^\]]+)\]/);
    assert.ok(match, 'FALLBACK_ALIASES windsurf row must exist in src/runtime-name-policy.cts');
    const srcAliases = match[1]
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const manifestAliases = [...manifest.windsurf].sort();
    assert.deepStrictEqual(
      [...srcAliases].sort(),
      manifestAliases,
      `FALLBACK_ALIASES windsurf=${JSON.stringify(srcAliases.sort())} must match manifest windsurf=${JSON.stringify(manifestAliases)}`,
    );
  });
});

describe('runtime-name-policy getProjectInstructionFile (#1529)', () => {
  test('claude maps to .claude/CLAUDE.md (kept-as-is boundary case)', () => {
    assert.strictEqual(getProjectInstructionFile('claude'), '.claude/CLAUDE.md');
  });

  test('codex maps to AGENTS.md', () => {
    assert.strictEqual(getProjectInstructionFile('codex'), 'AGENTS.md');
  });

  test('opencode maps to AGENTS.md (the #1529 bug surface)', () => {
    assert.strictEqual(getProjectInstructionFile('opencode'), 'AGENTS.md');
  });

  test('kilo maps to AGENTS.md', () => {
    assert.strictEqual(getProjectInstructionFile('kilo'), 'AGENTS.md');
  });

  test('kimi maps to AGENTS.md', () => {
    assert.strictEqual(getProjectInstructionFile('kimi'), 'AGENTS.md');
  });

  test('copilot maps to .github/copilot-instructions.md (GitHub docs read path)', () => {
    assert.strictEqual(getProjectInstructionFile('copilot'), '.github/copilot-instructions.md');
  });

  test('gemini is no longer a known runtime — falls back to AGENTS.md (#1928: Gemini CLI runtime removed)', () => {
    assert.strictEqual(getProjectInstructionFile('gemini'), 'AGENTS.md');
  });

  test('antigravity maps to GEMINI.md', () => {
    assert.strictEqual(getProjectInstructionFile('antigravity'), 'GEMINI.md');
  });

  test('unknown runtime maps to AGENTS.md (safe cross-agent default, boundary case)', () => {
    assert.strictEqual(getProjectInstructionFile('future-runtime-xyz'), 'AGENTS.md');
    assert.strictEqual(getProjectInstructionFile(''), 'AGENTS.md');
    assert.strictEqual(getProjectInstructionFile(null), 'AGENTS.md');
    assert.strictEqual(getProjectInstructionFile(undefined), 'AGENTS.md');
  });

  test('aliases normalize via canonicalizeRuntimeName before mapping', () => {
    // codex-cli is an alias for codex; it must resolve to the codex mapping.
    assert.strictEqual(getProjectInstructionFile('codex-cli'), 'AGENTS.md');
    // opencode-cli is an alias for opencode.
    assert.strictEqual(getProjectInstructionFile('opencode-cli'), 'AGENTS.md');
    // gemini-cli was an alias for gemini; the gemini runtime was removed
    // (#1928) so it is now an unrecognized runtime -> safe AGENTS.md default.
    assert.strictEqual(getProjectInstructionFile('gemini-cli'), 'AGENTS.md');
    // github-copilot is an alias for copilot.
    assert.strictEqual(getProjectInstructionFile('github-copilot'), '.github/copilot-instructions.md');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-783-kilo-global-skills-base.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-783-kilo-global-skills-base (consolidation epic #1969 B3 #1972)", () => {
'use strict';
// Regression guard for bug #783.
//
// getGlobalSkillsBase('kilo') was returning ~/.config/kilo/skills (the XDG
// config dir) instead of ~/.kilo/skills — where Kilo Code actually discovers
// global skills per its docs:
//   https://kilo.ai/docs/customize/skills
//   "Global skills are located in the `.kilo` directory within your Home
//    directory: ~/.kilo/skills/"
//
// The fix adds a special case in getGlobalSkillsBase() that resolves kilo's
// skills dir from HOME (not from the XDG config dir). The config dir at
// ~/.config/kilo is still CORRECT for commands (command/) and must stay
// unchanged — this test verifies both roles are separate.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const {
  getGlobalConfigDir,
  getGlobalSkillsBase,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'));

// Helper: temporarily override env vars for a test, restoring them afterwards.
function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key] of Object.entries(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// Clear all kilo-relevant env vars so tests are hermetic.
const kiloEnvClears = {
  KILO_CONFIG_DIR: undefined,
  XDG_CONFIG_HOME: undefined,
};

describe('bug #783: kilo global skills dir is ~/.kilo/skills, not ~/.config/kilo/skills', () => {
  test('getGlobalSkillsBase("kilo") resolves to ~/.kilo/skills', () => {
    withEnv(kiloEnvClears, () => {
      assert.strictEqual(
        getGlobalSkillsBase('kilo'),
        path.join(os.homedir(), '.kilo', 'skills'),
      );
    });
  });

  test('getGlobalConfigDir("kilo") still resolves to ~/.config/kilo (config dir unchanged)', () => {
    withEnv(kiloEnvClears, () => {
      assert.strictEqual(
        getGlobalConfigDir('kilo'),
        path.join(os.homedir(), '.config', 'kilo'),
      );
    });
  });

  test('kilo skills dir and config dir are decoupled (not equal, not nested)', () => {
    withEnv(kiloEnvClears, () => {
      const skillsBase = getGlobalSkillsBase('kilo');
      const configDir = getGlobalConfigDir('kilo');

      assert.notStrictEqual(skillsBase, configDir, 'skills dir must differ from config dir');
      assert.ok(
        !skillsBase.startsWith(configDir + path.sep),
        `skills dir (${skillsBase}) must not be nested under config dir (${configDir})`,
      );
      assert.ok(
        !configDir.startsWith(skillsBase + path.sep),
        `config dir (${configDir}) must not be nested under skills dir (${skillsBase})`,
      );
    });
  });

  test('getGlobalSkillsBase("kilo") is NOT affected by KILO_CONFIG_DIR override', () => {
    // Skills always live in ~/.kilo/skills regardless of XDG/config-dir overrides.
    withEnv({ KILO_CONFIG_DIR: '/tmp/custom-kilo-config', XDG_CONFIG_HOME: undefined }, () => {
      assert.strictEqual(
        getGlobalSkillsBase('kilo'),
        path.join(os.homedir(), '.kilo', 'skills'),
      );
    });
  });

  test('getGlobalSkillsBase("kilo") is NOT affected by XDG_CONFIG_HOME override', () => {
    withEnv({ KILO_CONFIG_DIR: undefined, XDG_CONFIG_HOME: '/tmp/custom-xdg' }, () => {
      assert.strictEqual(
        getGlobalSkillsBase('kilo'),
        path.join(os.homedir(), '.kilo', 'skills'),
      );
    });
  });
});
  });
}

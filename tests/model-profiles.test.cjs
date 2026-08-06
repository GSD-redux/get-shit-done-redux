/**
 * Model Profiles Tests
 *
 * Tests for MODEL_PROFILES data structure, VALID_PROFILES list,
 * formatAgentToModelMapAsTable, getAgentToModelMapForProfile,
 * and resolveModelInternal precedence (override > profile > default).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const {
  MODEL_PROFILES,
  VALID_PROFILES,
  formatAgentToModelMapAsTable,
  getAgentToModelMapForProfile,
} = require('../gsd-core/bin/lib/model-profiles.cjs');

const { resolveModelInternal } = require('../gsd-core/bin/lib/model-resolver.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { listAgentFiles } = require('./helpers/agent-roster.cjs');

// ─── temp-project helpers ──────────────────────────────────────────────────────

function writeConfig(tmpDir, obj) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify(obj, null, 2),
    'utf-8'
  );
}

// ─── MODEL_PROFILES data integrity ────────────────────────────────────────────

describe('MODEL_PROFILES', () => {
  test('contains every shipped gsd agent file on disk (#3229)', () => {
    // Canonical source roster (sorted gsd-* basenames without .md) — shared helper.
    const expectedAgents = listAgentFiles();
    const actualAgents = Object.keys(MODEL_PROFILES).sort();
    assert.deepStrictEqual(actualAgents, expectedAgents);
  });

  test('every agent has quality, balanced, budget, and adaptive profiles', () => {
    for (const [agent, profiles] of Object.entries(MODEL_PROFILES)) {
      assert.ok(profiles.quality, `${agent} missing quality profile`);
      assert.ok(profiles.balanced, `${agent} missing balanced profile`);
      assert.ok(profiles.budget, `${agent} missing budget profile`);
      assert.ok(profiles.adaptive, `${agent} missing adaptive profile`);
    }
  });

  test('all profile values are valid model aliases', () => {
    const validModels = ['opus', 'sonnet', 'haiku'];
    for (const [agent, profiles] of Object.entries(MODEL_PROFILES)) {
      for (const [profile, model] of Object.entries(profiles)) {
        assert.ok(
          validModels.includes(model),
          `${agent}.${profile} has invalid model "${model}" — expected one of ${validModels.join(', ')}`
        );
      }
    }
  });

  test('quality profile never uses haiku', () => {
    for (const [agent, profiles] of Object.entries(MODEL_PROFILES)) {
      assert.notStrictEqual(
        profiles.quality, 'haiku',
        `${agent} quality profile should not use haiku`
      );
    }
  });
});

// ─── VALID_PROFILES ───────────────────────────────────────────────────────────

describe('VALID_PROFILES', () => {
  test('contains quality, balanced, budget, adaptive, and inherit', () => {
    assert.deepStrictEqual(VALID_PROFILES.sort(), ['adaptive', 'balanced', 'budget', 'inherit', 'quality']);
  });

  test('includes all MODEL_PROFILES keys plus inherit', () => {
    const fromData = Object.keys(MODEL_PROFILES['gsd-planner']);
    for (const profile of fromData) {
      assert.ok(VALID_PROFILES.includes(profile), `VALID_PROFILES should include ${profile}`);
    }
    assert.ok(VALID_PROFILES.includes('inherit'), 'VALID_PROFILES should include inherit');
  });
});

// ─── getAgentToModelMapForProfile ─────────────────────────────────────────────

describe('getAgentToModelMapForProfile', () => {
  test('returns correct models for balanced profile', () => {
    const map = getAgentToModelMapForProfile('balanced');
    assert.strictEqual(map['gsd-planner'], 'opus');
    assert.strictEqual(map['gsd-codebase-mapper'], 'haiku');
    assert.strictEqual(map['gsd-verifier'], 'sonnet');
  });

  test('returns correct models for budget profile', () => {
    const map = getAgentToModelMapForProfile('budget');
    assert.strictEqual(map['gsd-planner'], 'sonnet');
    assert.strictEqual(map['gsd-phase-researcher'], 'haiku');
  });

  test('returns correct models for quality profile', () => {
    const map = getAgentToModelMapForProfile('quality');
    assert.strictEqual(map['gsd-planner'], 'opus');
    assert.strictEqual(map['gsd-executor'], 'opus');
  });

  test('returns correct models for adaptive profile', () => {
    const map = getAgentToModelMapForProfile('adaptive');
    assert.strictEqual(map['gsd-planner'], 'opus', 'planner should use opus in adaptive');
    assert.strictEqual(map['gsd-debugger'], 'opus', 'debugger should use opus in adaptive');
    assert.strictEqual(map['gsd-executor'], 'sonnet', 'executor should use sonnet in adaptive');
    assert.strictEqual(map['gsd-codebase-mapper'], 'haiku', 'mapper should use haiku in adaptive');
    assert.strictEqual(map['gsd-plan-checker'], 'haiku', 'checker should use haiku in adaptive');
  });

  // ─── resolution order: override > profile > default ─────────────────────────
  // Uses gsd-phase-researcher because it has visibly distinct values at every
  // level: balanced (default) = sonnet, budget (profile) = haiku, override = opus.
  // Each tier must beat the one below it; the test goes RED if resolveModelInternal
  // ignores model_overrides (returns 'haiku') or conflates default with profile
  // (returns 'sonnet' instead of 'haiku' for budget).
  describe('resolution order: override > profile > default', () => {
    // agent under test — must have three distinct model values across tiers
    const AGENT = 'gsd-phase-researcher';
    const EXPECTED_DEFAULT = 'sonnet'; // balanced profile (no config)
    const EXPECTED_PROFILE = 'haiku';  // budget profile
    const EXPECTED_OVERRIDE = 'opus';  // explicit model_overrides entry

    let tmpDir;
    beforeEach(() => { tmpDir = createTempProject(); });
    afterEach(() => { cleanup(tmpDir); tmpDir = null; });

    test('default (no config) resolves to balanced profile model', () => {
      // Sanity-check: balanced is the profile tier when no config is present.
      assert.strictEqual(
        resolveModelInternal(tmpDir, AGENT),
        EXPECTED_DEFAULT,
        `expected balanced-profile default "${EXPECTED_DEFAULT}" but got a different model`
      );
    });

    test('profile setting (budget) beats the balanced default', () => {
      writeConfig(tmpDir, { model_profile: 'budget' });
      assert.strictEqual(
        resolveModelInternal(tmpDir, AGENT),
        EXPECTED_PROFILE,
        `expected budget-profile model "${EXPECTED_PROFILE}" but got a different model`
      );
    });

    test('model_overrides entry beats the active profile', () => {
      // budget profile would give haiku; override must win with opus
      writeConfig(tmpDir, {
        model_profile: 'budget',
        model_overrides: { [AGENT]: EXPECTED_OVERRIDE },
      });
      assert.strictEqual(
        resolveModelInternal(tmpDir, AGENT),
        EXPECTED_OVERRIDE,
        `expected override "${EXPECTED_OVERRIDE}" to beat budget-profile model "${EXPECTED_PROFILE}"`
      );
    });

    test('model_overrides beats the default profile too (no explicit profile key)', () => {
      // Even without an explicit model_profile, override still wins over default
      writeConfig(tmpDir, {
        model_overrides: { [AGENT]: EXPECTED_OVERRIDE },
      });
      assert.strictEqual(
        resolveModelInternal(tmpDir, AGENT),
        EXPECTED_OVERRIDE,
        `expected override "${EXPECTED_OVERRIDE}" to beat balanced default "${EXPECTED_DEFAULT}"`
      );
    });
  });

  test('returns all agents in the map', () => {
    const map = getAgentToModelMapForProfile('balanced');
    const agentCount = Object.keys(MODEL_PROFILES).length;
    assert.strictEqual(Object.keys(map).length, agentCount);
  });
});

// ─── formatAgentToModelMapAsTable ─────────────────────────────────────────────

describe('formatAgentToModelMapAsTable', () => {
  test('produces a table with header and separator', () => {
    const map = { 'gsd-planner': 'opus', 'gsd-executor': 'sonnet' };
    const table = formatAgentToModelMapAsTable(map);
    assert.ok(table.includes('Agent'), 'should have Agent header');
    assert.ok(table.includes('Model'), 'should have Model header');
    assert.ok(table.includes('─'), 'should have separator line');
    assert.ok(table.includes('gsd-planner'), 'should list agent');
    assert.ok(table.includes('opus'), 'should list model');
  });

  test('pads columns correctly', () => {
    const map = { 'a': 'opus', 'very-long-agent-name': 'haiku' };
    const table = formatAgentToModelMapAsTable(map);
    const lines = table.split('\n').filter(l => l.trim());
    // Separator line uses ┼, data/header lines use │
    const dataLines = lines.filter(l => l.includes('│'));
    const pipePositions = dataLines.map(l => l.indexOf('│'));
    const unique = [...new Set(pipePositions)];
    assert.strictEqual(unique.length, 1, 'all data lines should align on │');
  });

  test('handles empty map', () => {
    const table = formatAgentToModelMapAsTable({});
    assert.ok(table.includes('Agent'), 'should still have header');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-384-agents-runtime-aware.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-384-agents-runtime-aware (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for bug #384 — getAgentsDir() is runtime-blind.
 *
 * Before the fix, getAgentsDir() always resolved to the Claude path
 * (~/.claude/agents) regardless of the active runtime, so on an OpenCode
 * install checkAgentsInstalled() always returned agents_installed=false and
 * agent_runtime was not surfaced at all.
 *
 * After the fix:
 *  - GSD_RUNTIME=opencode + OPENCODE_CONFIG_DIR pointing at a temp dir →
 *    agents_installed=true, agent_runtime='opencode', agents_dir under the
 *    opencode config dir
 *  - No GSD_RUNTIME + GSD_AGENTS_DIR pointing at a temp dir →
 *    agents_installed=true, agent_runtime='claude'
 *  - GSD_RUNTIME=opencode but agents dir empty →
 *    agents_installed=false, agent_runtime='opencode'
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const MODEL_PROFILES = require('../gsd-core/bin/lib/model-profiles.cjs').MODEL_PROFILES;
const EXPECTED_AGENTS = Object.keys(MODEL_PROFILES);

/**
 * Create an agents directory under configDir/agents and populate it with
 * the expected agent .md files.
 */
function createAgentsInConfigDir(configDir) {
  const agentsDir = path.join(configDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const name of EXPECTED_AGENTS) {
    fs.writeFileSync(
      path.join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: Test agent\ntools: Read, Bash\ncolor: cyan\n---\nAgent content.\n`
    );
  }
  return agentsDir;
}

describe('bug #384 — getAgentsDir() is runtime-aware', () => {
  let tmpDir;
  let opencodeConfigDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Separate temp dir to act as the opencode global config dir
    opencodeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-opencode-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(opencodeConfigDir);
  });

  // ── Test 1: opencode runtime resolves the opencode agents path ──────────────

  test('GSD_RUNTIME=opencode finds agents under OPENCODE_CONFIG_DIR/agents', () => {
    // Place agents under the opencode config dir that getGlobalConfigDir('opencode')
    // will return when OPENCODE_CONFIG_DIR is set.
    const agentsDir = createAgentsInConfigDir(opencodeConfigDir);

    const result = runGsdTools(
      ['init', 'quick', 'test description', '--raw'],
      tmpDir,
      {
        GSD_RUNTIME: 'opencode',
        OPENCODE_CONFIG_DIR: opencodeConfigDir,
        // Ensure the process HOME does NOT have a conflicting ~/.claude/agents
        // that might accidentally produce a false positive via GSD_AGENTS_DIR
        // (we must NOT set GSD_AGENTS_DIR here — the whole point is that the fix
        // uses the runtime-aware path without needing GSD_AGENTS_DIR).
      }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);

    assert.strictEqual(output.agents_installed, true,
      `agents_installed must be true when agents exist under OPENCODE_CONFIG_DIR/agents. ` +
      `agents_dir=${output.agents_dir}, agent_runtime=${output.agent_runtime}`);

    assert.strictEqual(output.agent_runtime, 'opencode',
      'agent_runtime must be "opencode" when GSD_RUNTIME=opencode');

    assert.strictEqual(output.agents_dir, agentsDir,
      `agents_dir must point at the opencode agents dir (${agentsDir}), got: ${output.agents_dir}`);
  });

  // ── Test 2: claude fallback via GSD_AGENTS_DIR ──────────────────────────────

  test('default runtime (no GSD_RUNTIME) with GSD_AGENTS_DIR → agents_installed=true, agent_runtime=claude', () => {
    // Classic GSD_AGENTS_DIR override: no runtime set, use the env shortcut
    createAgentsInConfigDir(tmpDir);
    // GSD_AGENTS_DIR points directly at the agents dir (not the config dir)
    const directAgentsDir = path.join(tmpDir, 'agents');

    // #2540 round 8: this test's premise is "nothing anywhere asserts a
    // runtime → claude", and the resolution chain now includes
    // ~/.gsd/defaults.json — sandbox HOME so a dev machine's persisted
    // runtime cannot assert one.
    const isolatedHome = path.join(tmpDir, 'isolated-home');
    fs.mkdirSync(isolatedHome, { recursive: true });
    const result = runGsdTools(
      ['init', 'quick', 'test description', '--raw'],
      tmpDir,
      {
        GSD_AGENTS_DIR: directAgentsDir,
        // Explicitly unset GSD_RUNTIME so no runtime override applies
        GSD_RUNTIME: '',
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
      }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);

    assert.strictEqual(output.agents_installed, true,
      `agents_installed must be true when GSD_AGENTS_DIR points at a populated agents dir. ` +
      `agents_dir=${output.agents_dir}`);

    assert.strictEqual(output.agent_runtime, 'claude',
      'agent_runtime must be "claude" when no GSD_RUNTIME is set');

    assert.strictEqual(output.agents_dir, directAgentsDir,
      `agents_dir must match GSD_AGENTS_DIR override`);
  });

  // ── Test 3 (negative): opencode runtime, empty agents dir ───────────────────

  test('GSD_RUNTIME=opencode with empty agents dir → agents_installed=false, agent_runtime still surfaced', () => {
    // Create the opencode config dir but leave agents/ empty (no files)
    const emptyAgentsDir = path.join(opencodeConfigDir, 'agents');
    fs.mkdirSync(emptyAgentsDir, { recursive: true });

    const result = runGsdTools(
      ['init', 'quick', 'test description', '--raw'],
      tmpDir,
      {
        GSD_RUNTIME: 'opencode',
        OPENCODE_CONFIG_DIR: opencodeConfigDir,
      }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);

    assert.strictEqual(output.agents_installed, false,
      'agents_installed must be false when agents dir is empty');

    assert.strictEqual(output.agent_runtime, 'opencode',
      'agent_runtime must still be surfaced even when agents are missing');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3024-dynamic-routing.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3024-dynamic-routing (consolidation epic #1969 B3 #1972)", () => {
/**
 * Feature test for issue #3024 — dynamic routing with failure-tier escalation.
 *
 * Adds a `dynamic_routing` block to .planning/config.json:
 *
 *   {
 *     "dynamic_routing": {
 *       "enabled": true,
 *       "tier_models": {
 *         "light":    "haiku",
 *         "standard": "sonnet",
 *         "heavy":    "opus"
 *       },
 *       "escalate_on_failure": true,
 *       "max_escalations": 1
 *     }
 *   }
 *
 * Each agent has a default tier (light/standard/heavy). When dynamic
 * routing is enabled, the resolver picks `tier_models[default_tier]`
 * for the first attempt. On orchestrator-detected soft failure, the
 * orchestrator calls the resolver again with `attempt: 1`, which
 * returns the next tier up (capped at `max_escalations`).
 *
 * This PR delivers the JS-layer infrastructure: schema + tier map +
 * resolver + escalation helpers. Orchestrator adoption is incremental
 * follow-up — this PR's contract is the resolver function and the
 * config it consumes.
 *
 * Resolution precedence (highest → lowest):
 *   1. model_overrides[agent]              (full IDs accepted; targeted)
 *   2. dynamic_routing.tier_models[tier]   (NEW; escalation-aware)
 *   3. models[phase_type]                  (#3023; coarse phase-level)
 *   4. model_profile                       (per-agent column)
 *   5. Runtime default
 *
 * Tests are typed-IR / structural — assert on the value returned by
 * resolveModelForTier or isValidConfigKey, not stdout/grep.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveModelInternal,
  resolveModelForTier,
} = require('../gsd-core/bin/lib/model-resolver.cjs');
const {
  AGENT_DEFAULT_TIERS,
  VALID_AGENT_TIERS,
  MODEL_PROFILES,
  nextTier,
} = require('../gsd-core/bin/lib/model-profiles.cjs');
const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');

const { createTempDir, cleanup } = require('./helpers.cjs');
const makeTmp = (prefix) => createTempDir(`gsd-3024-${prefix}-`);
function writeConfig(dir, config) {
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config, null, 2));
}
function rmr(p) { cleanup(p); }

// ─── Schema: AGENT_DEFAULT_TIERS coverage + valid tier set ──────────────────

describe('#3024 schema: every agent has a default tier (light/standard/heavy)', () => {
  test('AGENT_DEFAULT_TIERS exported as a non-empty object', () => {
    assert.equal(typeof AGENT_DEFAULT_TIERS, 'object');
    assert.ok(AGENT_DEFAULT_TIERS !== null);
    assert.ok(Object.keys(AGENT_DEFAULT_TIERS).length > 0);
  });

  test('VALID_AGENT_TIERS exposes exactly {light, standard, heavy}', () => {
    assert.deepStrictEqual([...VALID_AGENT_TIERS].sort(), ['heavy', 'light', 'standard']);
  });

  test('every agent in MODEL_PROFILES has a default tier', () => {
    const missing = Object.keys(MODEL_PROFILES).filter((a) => !AGENT_DEFAULT_TIERS[a]);
    assert.deepStrictEqual(missing, []);
  });

  test('every assigned tier is one of the three valid tiers', () => {
    const invalid = Object.entries(AGENT_DEFAULT_TIERS).filter(
      ([, t]) => !VALID_AGENT_TIERS.has(t)
    );
    assert.deepStrictEqual(invalid, []);
  });
});

// ─── nextTier helper ────────────────────────────────────────────────────────

describe('#3024 nextTier helper', () => {
  test('exported as a function', () => {
    assert.equal(typeof nextTier, 'function');
  });

  test('light → standard → heavy → heavy (caps at heavy)', () => {
    assert.equal(nextTier('light'), 'standard');
    assert.equal(nextTier('standard'), 'heavy');
    assert.equal(nextTier('heavy'), 'heavy', 'already at top — stays at heavy');
  });

  test('returns null for invalid input', () => {
    assert.equal(nextTier('jumbo'), null);
    assert.equal(nextTier(null), null);
    assert.equal(nextTier(undefined), null);
  });
});

// ─── Resolver behavior: dynamic routing, disabled mode ──────────────────────

describe('#3024 resolveModelForTier: disabled mode is a no-op (acceptance criterion 1)', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('disabled'); });
  afterEach(() => { rmr(projectDir); });

  test('exported as a function', () => {
    assert.equal(typeof resolveModelForTier, 'function');
  });

  test('with no dynamic_routing block, falls back to resolveModelInternal', () => {
    writeConfig(projectDir, { model_profile: 'balanced' });
    // resolveModelForTier with attempt=0 must match resolveModelInternal.
    const baseline = resolveModelInternal(projectDir, 'gsd-phase-researcher');
    assert.equal(resolveModelForTier(projectDir, 'gsd-phase-researcher', 0), baseline);
  });

  test('with dynamic_routing.enabled=false, attempt argument is ignored — same as resolveModelInternal', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      dynamic_routing: {
        enabled: false,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
      },
    });
    const baseline = resolveModelInternal(projectDir, 'gsd-phase-researcher');
    // attempt=0 and attempt=1 both ignored when disabled
    assert.equal(resolveModelForTier(projectDir, 'gsd-phase-researcher', 0), baseline);
    assert.equal(resolveModelForTier(projectDir, 'gsd-phase-researcher', 1), baseline);
  });
});

// ─── Resolver behavior: dynamic routing, enabled ────────────────────────────

describe('#3024 resolveModelForTier: enabled mode picks tier_models[default_tier]', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('enabled'); });
  afterEach(() => { rmr(projectDir); });

  test('attempt=0 returns tier_models[agent_default_tier] (acceptance criterion 2)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
      },
    });
    // gsd-codebase-mapper has light default tier per AGENT_DEFAULT_TIERS.
    // CR nitpick (#3031): assert preconditions explicitly so a tier
    // re-mapping in AGENT_DEFAULT_TIERS surfaces as a test failure
    // instead of a silent skip.
    assert.equal(AGENT_DEFAULT_TIERS['gsd-codebase-mapper'], 'light',
      'gsd-codebase-mapper expected to be light tier');
    assert.equal(resolveModelForTier(projectDir, 'gsd-codebase-mapper', 0), 'haiku');
    assert.equal(AGENT_DEFAULT_TIERS['gsd-planner'], 'heavy',
      'gsd-planner expected to be heavy tier');
    assert.equal(resolveModelForTier(projectDir, 'gsd-planner', 0), 'opus');
  });

  test('attempt=1 escalates to next tier up (acceptance criterion 3)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 1,
      },
    });
    // For an agent with default tier 'light', attempt=1 should give 'standard' tier model.
    const lightAgent = Object.entries(AGENT_DEFAULT_TIERS).find(([, t]) => t === 'light')?.[0];
    assert.ok(lightAgent, 'AGENT_DEFAULT_TIERS must contain at least one light agent');
    assert.equal(resolveModelForTier(projectDir, lightAgent, 0), 'haiku');
    assert.equal(resolveModelForTier(projectDir, lightAgent, 1), 'sonnet');
    // For a 'standard' agent, attempt=1 should give 'heavy' model.
    const stdAgent = Object.entries(AGENT_DEFAULT_TIERS).find(([, t]) => t === 'standard')?.[0];
    assert.ok(stdAgent, 'AGENT_DEFAULT_TIERS must contain at least one standard agent');
    assert.equal(resolveModelForTier(projectDir, stdAgent, 0), 'sonnet');
    assert.equal(resolveModelForTier(projectDir, stdAgent, 1), 'opus');
  });

  test('attempts beyond max_escalations cap at the highest reachable tier (acceptance criterion 4)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 1, // cap at 1 escalation total
      },
    });
    const lightAgent = Object.entries(AGENT_DEFAULT_TIERS).find(([, t]) => t === 'light')?.[0];
    assert.ok(lightAgent, 'AGENT_DEFAULT_TIERS must contain at least one light agent');
    // attempts beyond max_escalations should not exceed max_escalations'
    // tier — i.e. attempt=2 with max=1 = same as attempt=1.
    assert.equal(resolveModelForTier(projectDir, lightAgent, 2), 'sonnet',
      'attempt=2 with max_escalations=1 caps at attempt=1 tier');
    assert.equal(resolveModelForTier(projectDir, lightAgent, 5), 'sonnet');
  });

  test('"heavy" agents stay at heavy (no tier above)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
    });
    const heavyAgent = Object.entries(AGENT_DEFAULT_TIERS).find(([, t]) => t === 'heavy')?.[0];
    assert.ok(heavyAgent, 'AGENT_DEFAULT_TIERS must contain at least one heavy agent');
    assert.equal(resolveModelForTier(projectDir, heavyAgent, 0), 'opus');
    // Already at heavy — escalation cannot go higher.
    assert.equal(resolveModelForTier(projectDir, heavyAgent, 1), 'opus');
    assert.equal(resolveModelForTier(projectDir, heavyAgent, 5), 'opus');
  });

  test('default max_escalations is 1 when omitted', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        // max_escalations omitted — default to 1
      },
    });
    const lightAgent = Object.entries(AGENT_DEFAULT_TIERS).find(([, t]) => t === 'light')?.[0];
    assert.ok(lightAgent, 'AGENT_DEFAULT_TIERS must contain at least one light agent');
    // attempt=1 escalates; attempt=2 should cap at attempt=1 (default max=1)
    assert.equal(resolveModelForTier(projectDir, lightAgent, 1), 'sonnet');
    assert.equal(resolveModelForTier(projectDir, lightAgent, 2), 'sonnet');
  });

  // ─── CR Major (#3031): escalate_on_failure: false honored ──────────────

  test('escalate_on_failure:false disables escalation even when attempt > 0 (CR Major)', () => {
    // Pre-fix bug: an orchestrator that always passes attempt+1 on retry
    // would silently escalate even though the user opted out via
    // escalate_on_failure:false. The kill-switch must short-circuit
    // every attempt back to the default tier.
    writeConfig(projectDir, {
      model_profile: 'balanced',
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: false, // ← kill-switch
        max_escalations: 5,
      },
    });
    const lightAgent = Object.entries(AGENT_DEFAULT_TIERS).find(([, t]) => t === 'light')?.[0];
    assert.ok(lightAgent, 'AGENT_DEFAULT_TIERS must contain at least one light agent');
    // Every attempt must resolve to the default (light → haiku),
    // regardless of how high the orchestrator bumped the counter.
    assert.equal(resolveModelForTier(projectDir, lightAgent, 0), 'haiku');
    assert.equal(resolveModelForTier(projectDir, lightAgent, 1), 'haiku',
      'escalate_on_failure:false must not escalate even at attempt=1');
    assert.equal(resolveModelForTier(projectDir, lightAgent, 5), 'haiku');
  });

  test('escalate_on_failure:true (explicit) escalates normally', () => {
    // Sanity: explicit true matches the default truthy behavior.
    writeConfig(projectDir, {
      model_profile: 'balanced',
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 1,
      },
    });
    const lightAgent = Object.entries(AGENT_DEFAULT_TIERS).find(([, t]) => t === 'light')?.[0];
    assert.ok(lightAgent);
    assert.equal(resolveModelForTier(projectDir, lightAgent, 1), 'sonnet');
  });
});

// ─── Resolver precedence ────────────────────────────────────────────────────

describe('#3024 precedence: per-agent override > dynamic_routing > models > profile', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('precedence'); });
  afterEach(() => { rmr(projectDir); });

  test('per-agent model_overrides beats dynamic_routing (acceptance criterion: override wins)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      model_overrides: { 'gsd-codebase-mapper': 'openai/gpt-5' },
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
      },
    });
    // Per-agent override always wins, even at escalated attempt.
    assert.equal(resolveModelForTier(projectDir, 'gsd-codebase-mapper', 0), 'openai/gpt-5');
    assert.equal(resolveModelForTier(projectDir, 'gsd-codebase-mapper', 1), 'openai/gpt-5');
  });

  test('dynamic_routing beats phase-type models (#3023)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { research: 'opus' }, // phase-type would say opus
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
      },
    });
    // gsd-codebase-mapper is research phase-type; phase-type would give 'opus',
    // but dynamic routing (light default → haiku) wins.
    if (AGENT_DEFAULT_TIERS['gsd-codebase-mapper'] === 'light') {
      assert.equal(resolveModelForTier(projectDir, 'gsd-codebase-mapper', 0), 'haiku');
    }
  });
});

// ─── Schema validation ──────────────────────────────────────────────────────

describe('#3024 config-schema: dynamic_routing.* validation', () => {
  test('dynamic_routing.enabled is a valid config key', () => {
    assert.equal(isValidConfigKey('dynamic_routing.enabled'), true);
  });

  test('dynamic_routing.escalate_on_failure is a valid config key', () => {
    assert.equal(isValidConfigKey('dynamic_routing.escalate_on_failure'), true);
  });

  test('dynamic_routing.max_escalations is a valid config key', () => {
    assert.equal(isValidConfigKey('dynamic_routing.max_escalations'), true);
  });

  test('dynamic_routing.tier_models.<tier> for each valid tier', () => {
    for (const t of ['light', 'standard', 'heavy']) {
      assert.equal(isValidConfigKey(`dynamic_routing.tier_models.${t}`), true);
    }
  });

  test('unknown tier in tier_models is rejected', () => {
    assert.equal(isValidConfigKey('dynamic_routing.tier_models.jumbo'), false);
    assert.equal(isValidConfigKey('dynamic_routing.tier_models.medium'), false);
  });

  test('unknown dynamic_routing.* keys are rejected', () => {
    assert.equal(isValidConfigKey('dynamic_routing.foo'), false);
    assert.equal(isValidConfigKey('dynamic_routing'), false,
      'bare dynamic_routing (no field) must not be a config-set target');
  });
});
  });
}

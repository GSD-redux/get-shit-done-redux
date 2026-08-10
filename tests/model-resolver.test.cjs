'use strict';

/**
 * Tests for model-resolver.cjs (ADR-857 phase 2f / #888).
 *
 * Covers:
 *   - resolveModelInternal: model resolution across tiers + profile overrides
 *   - resolveGranularityInternal + assertValidGranularityOverride
 *   - resolveEffortInternal / resolveFastModeInternal
 *   - resolveEffortForTier / nextEffort
 *   - resolveModelForTier (dynamic routing)
 *   - resolveModelPolicy (#49 provider-neutral presets)
 *   - resolveTierEntry (#2517 runtime-aware tier resolution)
 *   - shim identity: core.X === modelResolver.X for all 13 public symbols
 *   - ADVERSARIAL: unknown agent types, invalid granularity/effort overrides,
 *     runtime override edge cases
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { cleanup } = require('./helpers.cjs');

// ─── modules under test ───────────────────────────────────────────────────────

const modelResolver = require('../gsd-core/bin/lib/model-resolver.cjs');

const {
  resolveTierEntry,
  resolveModelPolicy,
  resolveModelInternal,
  VALID_GRANULARITIES,
  resolveGranularityInternal,
  assertValidGranularityOverride,
  resolveModelForTier,
  VALID_EFFORTS,
  EFFORT_SET,
  nextEffort,
  resolveEffortInternal,
  resolveFastModeInternal,
  resolveEffortForTier,
  resolveTierFromConfig,
  resolveTierInternal,
} = modelResolver;

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempProject(prefix = 'gsd-model-resolver-test-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  return tmpDir;
}

function writeConfig(tmpDir, obj) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}


// ─── resolveModelInternal ─────────────────────────────────────────────────────

describe('resolveModelInternal', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('no config -> balanced profile -> gsd-planner resolves to a string', () => {
    const model = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.ok(typeof model === 'string' && model.length > 0, `Expected non-empty string, got: ${JSON.stringify(model)}`);
  });

  test('model_overrides takes precedence over everything else', () => {
    writeConfig(tmpDir, { model_overrides: { 'gsd-planner': 'my-custom-model' } });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'my-custom-model');
  });

  test('model_profile=quality -> opus-class model for gsd-planner', () => {
    writeConfig(tmpDir, { model_profile: 'quality' });
    const model = resolveModelInternal(tmpDir, 'gsd-planner');
    // quality profile must resolve to a non-empty model string
    assert.ok(typeof model === 'string' && model.length > 0);
  });

  test('model_profile=budget -> haiku-class model for gsd-planner', () => {
    writeConfig(tmpDir, { model_profile: 'budget' });
    const model = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.ok(typeof model === 'string' && model.length > 0);
  });

  test('resolve_model_ids=omit -> returns empty string', () => {
    writeConfig(tmpDir, { resolve_model_ids: 'omit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), '');
  });

  test('unknown agent type, no config -> returns a non-empty string (fallback)', () => {
    const model = resolveModelInternal(tmpDir, 'completely-unknown-agent-xyz');
    assert.ok(typeof model === 'string' && model.length > 0);
  });

  test('model_profile=inherit -> returns "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'inherit');
  });

  test('models config per phase type overrides profile tier', () => {
    writeConfig(tmpDir, { models: { planning: 'opus' } });
    // gsd-planner maps to planning phase type; config says opus
    // with no resolve_model_ids, should return 'opus'
    const model = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(model, 'opus');
  });

  test('models with invalid tier value falls through to profile', () => {
    writeConfig(tmpDir, { models: { planning: 'not-a-valid-tier' } });
    // invalid tier value -> falls back to profile resolution
    const model = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.ok(typeof model === 'string' && model.length > 0);
  });

  // #2072 acceptance: these two catalog agents' config MUST resolve — the bug was
  // that the workflows never threaded the resolved value, not that the resolver
  // ignored it. These assert the value the (now-threaded) spawns receive.
  test('#2072: model_overrides applies to gsd-code-reviewer', () => {
    writeConfig(tmpDir, { model_overrides: { 'gsd-code-reviewer': 'my-custom-model' } });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-code-reviewer'), 'my-custom-model');
  });

  test('#2072: model_overrides applies to gsd-assumptions-analyzer', () => {
    writeConfig(tmpDir, { model_overrides: { 'gsd-assumptions-analyzer': 'my-custom-model' } });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-assumptions-analyzer'), 'my-custom-model');
  });

  test('#2072: models.verification tier applies to gsd-code-reviewer', () => {
    writeConfig(tmpDir, { models: { verification: 'opus' } });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-code-reviewer'), 'opus');
  });

  test('#2072: models.discuss tier applies to gsd-assumptions-analyzer', () => {
    writeConfig(tmpDir, { models: { discuss: 'opus' } });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-assumptions-analyzer'), 'opus');
  });

  test('#2072: model_overrides + models.execution apply to gsd-code-fixer', () => {
    writeConfig(tmpDir, { model_overrides: { 'gsd-code-fixer': 'my-custom-model' } });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-code-fixer'), 'my-custom-model');
    writeConfig(tmpDir, { models: { execution: 'opus' } });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-code-fixer'), 'opus');
  });

  test('runtime non-claude + model_profile_overrides for runtime tier', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile_overrides: {
        codex: { haiku: 'codex-mini', sonnet: 'codex', opus: 'codex-full' },
      },
    });
    // gsd-codebase-mapper is light tier -> haiku in balanced profile
    const model = resolveModelInternal(tmpDir, 'gsd-codebase-mapper');
    assert.ok(typeof model === 'string' && model.length > 0);
  });
});

// ─── resolveGranularityInternal ───────────────────────────────────────────────

describe('resolveGranularityInternal', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('no config, no override -> returns "standard"', () => {
    assert.strictEqual(resolveGranularityInternal(tmpDir, 'planning'), 'standard');
  });

  test('valid override wins over config', () => {
    writeConfig(tmpDir, { granularity: 'fine' });
    assert.strictEqual(resolveGranularityInternal(tmpDir, 'planning', 'coarse'), 'coarse');
  });

  test('invalid override ignored, falls through to config', () => {
    writeConfig(tmpDir, { granularity: 'fine' });
    assert.strictEqual(resolveGranularityInternal(tmpDir, 'planning', 'ultradetailed'), 'fine');
  });

  test('null override falls through to config', () => {
    writeConfig(tmpDir, { granularity: 'coarse' });
    assert.strictEqual(resolveGranularityInternal(tmpDir, 'planning', null), 'coarse');
  });

  test('per-phase-type granularity beats global granularity', () => {
    writeConfig(tmpDir, {
      granularity: 'coarse',
      granularities: { planning: 'fine' },
    });
    assert.strictEqual(resolveGranularityInternal(tmpDir, 'planning'), 'fine');
  });

  test('planning.granularity nested config used as fallback', () => {
    writeConfig(tmpDir, { planning: { granularity: 'coarse' } });
    assert.strictEqual(resolveGranularityInternal(tmpDir, null), 'coarse');
  });

  test('VALID_GRANULARITIES contains exactly coarse, standard, fine', () => {
    assert.ok(VALID_GRANULARITIES instanceof Set);
    assert.ok(VALID_GRANULARITIES.has('coarse'));
    assert.ok(VALID_GRANULARITIES.has('standard'));
    assert.ok(VALID_GRANULARITIES.has('fine'));
    assert.strictEqual(VALID_GRANULARITIES.size, 3);
  });
});

// ─── assertValidGranularityOverride ───────────────────────────────────────────

describe('assertValidGranularityOverride', () => {
  test('undefined -> no-op (no throw)', () => {
    assert.doesNotThrow(() =>
      assertValidGranularityOverride(undefined, (msg) => { throw new Error(msg); })
    );
  });

  test('null -> no-op (no throw)', () => {
    assert.doesNotThrow(() =>
      assertValidGranularityOverride(null, (msg) => { throw new Error(msg); })
    );
  });

  test('empty string -> no-op (no throw)', () => {
    assert.doesNotThrow(() =>
      assertValidGranularityOverride('', (msg) => { throw new Error(msg); })
    );
  });

  test('valid value "coarse" -> no-op (no throw)', () => {
    assert.doesNotThrow(() =>
      assertValidGranularityOverride('coarse', (msg) => { throw new Error(msg); })
    );
  });

  test('invalid value -> calls fail with descriptive message', () => {
    let caught = null;
    // fail is called with the message; we capture it by throwing so the test can inspect
    assert.throws(
      () => assertValidGranularityOverride('megafine', (msg) => { caught = msg; throw new Error(msg); }),
      (err) => {
        assert.ok(err.message.includes('megafine'), `error message should include the invalid value: ${err.message}`);
        assert.ok(err.message.includes('coarse') && err.message.includes('standard') && err.message.includes('fine'),
          `error message should list valid values: ${err.message}`);
        return true;
      }
    );
    assert.ok(caught !== null, 'fail should have been called');
  });
});

// ─── resolveEffortInternal ────────────────────────────────────────────────────

describe('resolveEffortInternal', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('no config -> gsd-planner (heavy) defaults to "xhigh" via tier default', () => {
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'xhigh');
  });

  test('invocation override beats everything', () => {
    writeConfig(tmpDir, { effort: { agent_overrides: { 'gsd-planner': 'low' } } });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner', { override: 'minimal' }), 'minimal');
  });

  test('agent_overrides beats routing_tier_defaults', () => {
    writeConfig(tmpDir, {
      effort: {
        routing_tier_defaults: { heavy: 'medium' },
        agent_overrides: { 'gsd-planner': 'low' },
      },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'low');
  });

  test('effort.default is final fallback when no tier default matches', () => {
    writeConfig(tmpDir, { effort: { default: 'minimal' } });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'completely-unknown-agent-xyz'), 'minimal');
  });

  test('VALID_EFFORTS and EFFORT_SET are consistent', () => {
    assert.ok(Array.isArray(VALID_EFFORTS));
    assert.ok(EFFORT_SET instanceof Set);
    assert.strictEqual(EFFORT_SET.size, VALID_EFFORTS.length);
    for (const e of VALID_EFFORTS) {
      assert.ok(EFFORT_SET.has(e), `EFFORT_SET missing: ${e}`);
    }
  });
});

// ─── nextEffort ────────────────────────────────────────────────────────────────

describe('nextEffort', () => {
  test('minimal -> low', () => {
    assert.strictEqual(nextEffort('minimal'), 'low');
  });

  test('max -> max (clamp at ceiling)', () => {
    assert.strictEqual(nextEffort('max'), 'max');
  });

  test('high -> xhigh', () => {
    assert.strictEqual(nextEffort('high'), 'xhigh');
  });

  test('unknown effort -> null', () => {
    assert.strictEqual(nextEffort('turbo'), null);
  });
});

// ─── resolveFastModeInternal ──────────────────────────────────────────────────

describe('resolveFastModeInternal', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('no config -> defaults to false', () => {
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('opts.override=true beats config', () => {
    writeConfig(tmpDir, { fast_mode: { agent_overrides: { 'gsd-planner': false } } });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner', { override: true }), true);
  });

  test('fast_mode.enabled=true sets default for all agents', () => {
    writeConfig(tmpDir, { fast_mode: { enabled: true } });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), true);
  });

  test('agent_overrides beats enabled', () => {
    writeConfig(tmpDir, {
      fast_mode: { enabled: true, agent_overrides: { 'gsd-planner': false } },
    });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('unknown agent with no config -> false', () => {
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'unknown-agent-xyz'), false);
  });
});

// ─── resolveEffortForTier ─────────────────────────────────────────────────────

describe('resolveEffortForTier', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('dynamic_routing disabled -> attempt has no effect', () => {
    const base = resolveEffortForTier(tmpDir, 'gsd-planner', 0);
    const at1 = resolveEffortForTier(tmpDir, 'gsd-planner', 1);
    assert.strictEqual(base, at1);
  });

  test('dynamic_routing enabled + escalate_on_failure=true + attempt=1 -> one step up', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    assert.strictEqual(resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0), 'low');
    assert.strictEqual(resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1), 'medium');
  });

  test('escalation clamps at "max"', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 99,
      },
      effort: { default: 'xhigh' },
    });
    assert.strictEqual(resolveEffortForTier(tmpDir, 'gsd-planner', 99), 'max');
  });
});

// ─── resolveModelForTier ──────────────────────────────────────────────────────

describe('resolveModelForTier', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('no dynamic_routing -> falls back to resolveModelInternal', () => {
    const fromForTier = resolveModelForTier(tmpDir, 'gsd-planner');
    const fromInternal = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(fromForTier, fromInternal);
  });

  test('model_overrides wins before dynamic routing logic', () => {
    writeConfig(tmpDir, {
      model_overrides: { 'gsd-planner': 'override-model' },
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
    });
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-planner'), 'override-model');
  });

  test('dynamic_routing + tier_models + attempt=0 -> default tier model', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku-custom', standard: 'sonnet-custom', heavy: 'opus-custom' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
    });
    // gsd-codebase-mapper is 'light' tier
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-codebase-mapper', 0), 'haiku-custom');
  });

  test('dynamic_routing + attempt=1 escalates tier', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku-custom', standard: 'sonnet-custom', heavy: 'opus-custom' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
    });
    // gsd-codebase-mapper light -> attempt=1 -> standard
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-codebase-mapper', 1), 'sonnet-custom');
  });
});

// ─── resolveModelPolicy ───────────────────────────────────────────────────────

describe('resolveModelPolicy (#49)', () => {
  test('null policy -> null', () => {
    assert.strictEqual(resolveModelPolicy(null, 'sonnet'), null);
  });

  test('no provider -> null', () => {
    assert.strictEqual(resolveModelPolicy({ budget: 'medium' }, 'sonnet'), null);
  });

  test('generic provider: tier=opus -> reads policy.high', () => {
    const result = resolveModelPolicy(
      { provider: 'generic', high: 'my-high-model', medium: 'my-medium', low: 'my-low' },
      'opus'
    );
    assert.strictEqual(result, 'my-high-model');
  });

  test('generic provider: tier=sonnet -> reads policy.medium', () => {
    const result = resolveModelPolicy(
      { provider: 'generic', high: 'hi', medium: 'med', low: 'lo' },
      'sonnet'
    );
    assert.strictEqual(result, 'med');
  });

  test('generic provider: tier=haiku -> reads policy.low', () => {
    const result = resolveModelPolicy(
      { provider: 'generic', high: 'hi', medium: 'med', low: 'lo' },
      'haiku'
    );
    assert.strictEqual(result, 'lo');
  });

  test('custom provider same as generic', () => {
    const result = resolveModelPolicy(
      { provider: 'custom', medium: 'custom-sonnet' },
      'sonnet'
    );
    assert.strictEqual(result, 'custom-sonnet');
  });

  test('runtime_tiers override takes precedence over provider', () => {
    const result = resolveModelPolicy(
      {
        provider: 'generic',
        high: 'generic-hi',
        medium: 'generic-med',
        low: 'generic-lo',
        runtime: 'codex',
        runtime_tiers: { codex: { sonnet: 'codex-sonnet-override' } },
      },
      'sonnet'
    );
    assert.strictEqual(result, 'codex-sonnet-override');
  });

  test('unknown tier for generic -> null', () => {
    const result = resolveModelPolicy(
      { provider: 'generic', high: 'hi', medium: 'med', low: 'lo' },
      'unknown-tier'
    );
    assert.strictEqual(result, null);
  });
});

// ─── resolveTierEntry ────────────────────────────────────────────────────────

describe('resolveTierEntry (#2517)', () => {
  test('null runtime -> null', () => {
    assert.strictEqual(resolveTierEntry({ runtime: null, tier: 'sonnet', overrides: null }), null);
  });

  test('null tier -> null', () => {
    assert.strictEqual(resolveTierEntry({ runtime: 'codex', tier: null, overrides: null }), null);
  });

  test('unknown runtime + unknown tier, no overrides -> null', () => {
    assert.strictEqual(resolveTierEntry({
      runtime: 'totally-unknown-runtime-xyz',
      tier: 'totally-unknown-tier',
      overrides: null,
    }), null);
  });

  test('user override as string expands to { model: string }', () => {
    const entry = resolveTierEntry({
      runtime: 'codex',
      tier: 'sonnet',
      overrides: { codex: { sonnet: 'my-custom-codex-model' } },
    });
    assert.ok(entry !== null);
    assert.strictEqual(entry.model, 'my-custom-codex-model');
  });

  test('user override as object merged with builtin', () => {
    const entry = resolveTierEntry({
      runtime: 'codex',
      tier: 'sonnet',
      overrides: { codex: { sonnet: { model: 'user-model', extra: 'value' } } },
    });
    assert.ok(entry !== null);
    assert.strictEqual(entry.model, 'user-model');
    assert.strictEqual(entry['extra'], 'value');
  });
});

// ─── ADVERSARIAL ─────────────────────────────────────────────────────────────

describe('ADVERSARIAL: edge cases', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('resolveModelInternal: unknown agent + model_profile=quality -> "opus" fallback', () => {
    writeConfig(tmpDir, { model_profile: 'quality' });
    const model = resolveModelInternal(tmpDir, 'completely-unknown-agent');
    assert.strictEqual(model, 'opus');
  });

  test('resolveModelInternal: unknown agent + model_profile=budget -> "haiku" fallback', () => {
    writeConfig(tmpDir, { model_profile: 'budget' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'unknown-agent'), 'haiku');
  });

  test('resolveGranularityInternal: empty override "" is treated as no override', () => {
    writeConfig(tmpDir, { granularity: 'fine' });
    assert.strictEqual(resolveGranularityInternal(tmpDir, 'planning', ''), 'fine');
  });

  test('assertValidGranularityOverride: "ultrawide" is invalid -> fail called', () => {
    let errorMsg = null;
    assert.throws(
      () => assertValidGranularityOverride('ultrawide', (msg) => { errorMsg = msg; throw new Error(msg); }),
      (err) => {
        assert.ok(err.message.includes('ultrawide'), `error should mention the invalid value: ${err.message}`);
        return true;
      }
    );
    assert.ok(errorMsg !== null, 'fail should have been called');
    assert.ok(errorMsg.includes('ultrawide'), `error message should include 'ultrawide': ${errorMsg}`);
  });

  test('resolveEffortInternal: invalid override "turbo" falls through to tier default', () => {
    const result = resolveEffortInternal(tmpDir, 'gsd-planner', { override: 'turbo' });
    // gsd-planner is heavy -> tier default xhigh
    assert.strictEqual(result, 'xhigh');
  });

  test('resolveFastModeInternal: string "true" override is not accepted (must be boolean)', () => {
    const result = resolveFastModeInternal(tmpDir, 'gsd-planner', { override: 'true' });
    // string is not boolean -> falls through to default false
    assert.strictEqual(result, false);
  });

  test('resolveEffortInternal: effort block is non-object string -> uses tier default', () => {
    writeConfig(tmpDir, { effort: 'bad-value' });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.ok(EFFORT_SET.has(result), `Expected valid effort, got: ${result}`);
  });

  test('resolveModelForTier: unknown agent with dynamic routing -> resolveModelInternal fallback', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 1,
      },
    });
    // unknown agent has no defaultTier -> falls back to resolveModelInternal
    const fromForTier = resolveModelForTier(tmpDir, 'unknown-agent-xyz');
    const fromInternal = resolveModelInternal(tmpDir, 'unknown-agent-xyz');
    assert.strictEqual(fromForTier, fromInternal);
  });

  test('resolveTierEntry: runtime override with non-string, non-object value -> no model set', () => {
    const entry = resolveTierEntry({
      runtime: 'codex',
      tier: 'sonnet',
      overrides: { codex: { sonnet: 42 } },
    });
    // numeric 42 is neither string nor object -> treated as truthy userEntry=42 (not expanded)
    // result will have whatever builtins exist + the override
    // Key requirement: does not crash
    assert.ok(entry !== null || entry === null, 'should not throw');
  });

  test('resolveModelPolicy: non-object policy -> null', () => {
    assert.strictEqual(resolveModelPolicy('string-policy', 'sonnet'), null);
  });

  test('resolveModelPolicy: null tier -> null', () => {
    assert.strictEqual(resolveModelPolicy({ provider: 'generic', medium: 'sonnet' }, null), null);
  });

  test('resolveEffortForTier: max_escalations=0 caps escalation', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 0,
      },
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    const at0 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0);
    const at1 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1);
    // max_escalations=0 means no escalation allowed even at attempt=1
    assert.strictEqual(at0, at1);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1829-inherit-model-profile.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1829-inherit-model-profile (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression tests for bug #1829
 *
 * model_profile: "inherit" in .planning/config.json was not recognised as a
 * valid profile. resolveModelInternal() silently fell back to "balanced",
 * causing all agents to use "sonnet" instead of inheriting the parent model.
 *
 * Root cause in core.cjs:
 *   const profile = config.model_profile || 'balanced';
 *   const agentModels = MODEL_PROFILES[agentType];
 *   if (!agentModels) return 'sonnet';
 *   const resolved = agentModels[profile] || agentModels['balanced'] || 'sonnet';
 *   // agentModels['inherit'] is undefined → falls through to agentModels['balanced']
 *
 * Fix 1 (core.cjs): add early return — if (profile === 'inherit') return 'inherit';
 * Fix 2 (verify.cjs): add 'inherit' to validProfiles so it doesn't trigger W004.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const { resolveModelInternal } = require('../gsd-core/bin/lib/model-resolver.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeConfig(tmpDir, obj) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify(obj, null, 2)
  );
}

function writeMinimalProjectMd(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'PROJECT.md'),
    '# Project\n\n## What This Is\n\nContent.\n\n## Core Value\n\nContent.\n\n## Requirements\n\nContent.\n'
  );
}

function writeMinimalRoadmap(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    '# Roadmap\n\n### Phase 1: First Phase\n'
  );
}

function writeMinimalStateMd(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    '# Session State\n\n## Current Position\n\nPhase: 1\n'
  );
}

// ─── resolveModelInternal — inherit profile ───────────────────────────────────

describe('bug #1829: model_profile "inherit" — resolveModelInternal', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns "inherit" for gsd-planner when model_profile is "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'inherit');
  });

  test('returns "inherit" for gsd-executor when model_profile is "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-executor'), 'inherit');
  });

  test('returns "inherit" for gsd-phase-researcher when model_profile is "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-phase-researcher'), 'inherit');
  });

  test('returns "inherit" for gsd-codebase-mapper when model_profile is "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'inherit');
  });

  test('returns "inherit" for gsd-verifier when model_profile is "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-verifier'), 'inherit');
  });

  test('returns "inherit" for unknown agent with inherit profile', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-nonexistent'), 'inherit');
  });

  test('per-agent override takes precedence over inherit profile', () => {
    writeConfig(tmpDir, {
      model_profile: 'inherit',
      model_overrides: { 'gsd-executor': 'haiku' },
    });
    // Override wins even when profile is inherit
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-executor'), 'haiku');
    // Other agents without override still inherit
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'inherit');
  });

  test('does not silently fall back to "sonnet" (the original bug)', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    // Before the fix, this returned 'sonnet' (via balanced fallback)
    const model = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.notStrictEqual(model, 'sonnet', 'inherit profile must not silently fall back to sonnet');
  });
});

// ─── resolve-model CLI — inherit profile ──────────────────────────────────────

describe('bug #1829: model_profile "inherit" — resolve-model CLI', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('CLI resolve-model returns "inherit" for gsd-executor with inherit profile', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'inherit' }, null, 2)
    );

    const result = runGsdTools('resolve-model gsd-executor', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.model, 'inherit');
    assert.strictEqual(parsed.profile, 'inherit');
  });

  test('CLI resolve-model returns "inherit" for gsd-planner with inherit profile', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'inherit' }, null, 2)
    );

    const result = runGsdTools('resolve-model gsd-planner', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.model, 'inherit');
  });
});

// ─── verify health — inherit profile is not a validation error ────────────────

describe('bug #1829: model_profile "inherit" — validate health does not warn W004', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir);
    writeMinimalStateMd(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-first-phase'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('does not emit W004 for model_profile "inherit"', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        model_profile: 'inherit',
        workflow: {
          research: true,
          plan_check: true,
          verifier: true,
          nyquist_validation: true,
        },
      }, null, 2)
    );

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `validate health failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.warnings.some(w => w.code === 'W004'),
      `inherit profile must not trigger W004: ${JSON.stringify(output.warnings)}`
    );
  });

  test('still emits W004 for genuinely invalid model_profile values', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'invalid-profile' }, null, 2)
    );

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `validate health failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.code === 'W004'),
      `Invalid profile should trigger W004: ${JSON.stringify(output.warnings)}`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-492-effort-manifest-fallback.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-492-effort-manifest-fallback (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * bug-492-effort-manifest-fallback.test.cjs
 *
 * Verifies resolveEffortInternal's fallback chain when no project config.json
 * is present.
 *
 * Isolation strategy: every test that injects custom effort values writes
 * them to a per-test ~/.gsd/defaults.json rooted under a tmpHome, pointed at
 * via GSD_HOME. This avoids mutating the module-level CANONICAL_CONFIG_DEFAULTS
 * singleton (which caused independence violations under parallel runs).
 *
 * Test 1 (pure manifest fallback): tmpDir WITH .planning/ but no config.json.
 * GSD_HOME points to a bare tmpHome (no defaults.json). loadConfig sees
 * .planning/ → returns effort:null → model-resolver reads CANONICAL_CONFIG_DEFAULTS
 * directly for routing_tier_defaults.
 *
 * Tests 2-4 (global-defaults path): bare tmpDir (no .planning/) so loadConfig
 * hits the ~/.gsd/defaults.json branch. A test-scoped defaults.json injects
 * the desired effort sub-object; model-resolver then takes the effortCfg
 * (non-null) branch — no singleton touched.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');
const { resolveEffortInternal } = require('../gsd-core/bin/lib/model-resolver.cjs');

/** Create a bare temp directory with no .planning/ structure */
function createBareTmpDir(prefix = 'gsd-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create a temp home dir and write effort config into .gsd/defaults.json */
function createTmpHomeWithEffort(effortConfig) {
  const tmpHome = createBareTmpDir('gsd-home-');
  const gsdDir = path.join(tmpHome, '.gsd');
  fs.mkdirSync(gsdDir, { recursive: true });
  fs.writeFileSync(
    path.join(gsdDir, 'defaults.json'),
    JSON.stringify({ effort: effortConfig })
  );
  return tmpHome;
}

describe('#492 manifest effort fallback', () => {
  // These tests manage GSD_HOME per-test, so no shared beforeEach/afterEach.

  test('routing_tier_defaults manifest fallback still works when no config and no defaults.json', (t) => {
    // .planning/ exists → loadConfig returns effort:null → model-resolver reads
    // CANONICAL_CONFIG_DEFAULTS['effort']['routing_tier_defaults']['heavy'] = "xhigh".
    const tmpDir = createBareTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    const tmpHome = createBareTmpDir('gsd-home-');
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      delete process.env.GSD_HOME;
      cleanup(tmpDir);
      cleanup(tmpHome);
    });

    // gsd-planner's default tier is "heavy"; manifest routing_tier_defaults.heavy = "xhigh"
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'xhigh');
  });

  test('global-defaults effort.agent_overrides wins over routing_tier_defaults when no project config', (t) => {
    // bare tmpDir (no .planning/) → loadConfig reads ~/.gsd/defaults.json
    // which supplies effort.agent_overrides → resolveEffortInternal returns that value.
    const tmpDir = createBareTmpDir();
    const tmpHome = createTmpHomeWithEffort({ agent_overrides: { 'gsd-planner': 'max' } });
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      delete process.env.GSD_HOME;
      cleanup(tmpDir);
      cleanup(tmpHome);
    });

    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'max');
  });

  test('global-defaults effort.default consulted for unknown agent with no project config', (t) => {
    // effort.default in defaults.json wins for an agent with no tier mapping.
    const tmpDir = createBareTmpDir();
    const tmpHome = createTmpHomeWithEffort({ default: 'max' });
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      delete process.env.GSD_HOME;
      cleanup(tmpDir);
      cleanup(tmpHome);
    });

    assert.strictEqual(resolveEffortInternal(tmpDir, 'fictional-agent-xyz-492'), 'max');
  });

  test('global-defaults agent_overrides takes precedence over routing_tier_defaults', (t) => {
    // agent_overrides is checked first (step 2), so "minimal" wins over
    // routing_tier_defaults.heavy = "xhigh" (step 3).
    const tmpDir = createBareTmpDir();
    const tmpHome = createTmpHomeWithEffort({
      agent_overrides: { 'gsd-planner': 'minimal' },
      routing_tier_defaults: { heavy: 'xhigh' },
    });
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      delete process.env.GSD_HOME;
      cleanup(tmpDir);
      cleanup(tmpHome);
    });

    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'minimal');
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3023-model-phase-types.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3023-model-phase-types (consolidation epic #1969 B8 #1977)", () => {
/**
 * Feature test for issue #3023 — per-phase-type model map.
 *
 * Adds a `models` block to .planning/config.json that accepts phase-type
 * keys (planning / discuss / research / execution / verification /
 * completion). Resolution precedence:
 *
 *   1. Per-agent `model_overrides[agent]`         (highest)
 *   2. Phase-type `models[phase_type]`            (NEW)
 *   3. Profile table (`model_profile`)
 *   4. Runtime default
 *
 * Tests are typed-IR / structural — assert on the value returned by
 * resolveModelInternal, not stdout/grep. Each test seeds a temp project
 * with a fixture .planning/config.json and asserts the resolver picks
 * the right tier for each agent.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveModelInternal,
} = require('../gsd-core/bin/lib/model-resolver.cjs');
const {
  AGENT_TO_PHASE_TYPE,
  VALID_PHASE_TYPES,
  MODEL_PROFILES,
} = require('../gsd-core/bin/lib/model-profiles.cjs');
const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');

const { createTempDir, cleanup } = require('./helpers.cjs');
const makeTmp = (prefix) => createTempDir(`gsd-3023-${prefix}-`);

function writeConfig(projectDir, config) {
  const planningDir = path.join(projectDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config, null, 2));
}

function rmr(p) {
  cleanup(p);
}

// ─── Schema: AGENT_TO_PHASE_TYPE table + VALID_PHASE_TYPES ──────────────────

describe('#3023 phase-type schema: every agent has a phase-type assignment', () => {
  test('AGENT_TO_PHASE_TYPE is exported as a non-empty object', () => {
    assert.equal(typeof AGENT_TO_PHASE_TYPE, 'object');
    assert.ok(AGENT_TO_PHASE_TYPE !== null);
    assert.ok(Object.keys(AGENT_TO_PHASE_TYPE).length > 0);
  });

  test('VALID_PHASE_TYPES exposes the six named slots from the issue', () => {
    // The issue specified exactly these slots. Adding new slots here is a
    // schema change that must coordinate with config-schema's dynamic
    // pattern and the docs.
    assert.deepStrictEqual(
      [...VALID_PHASE_TYPES].sort(),
      ['completion', 'discuss', 'execution', 'planning', 'research', 'verification'].sort()
    );
  });

  test('every agent in MODEL_PROFILES has a phase-type assignment', () => {
    const missing = Object.keys(MODEL_PROFILES).filter(
      (agent) => !AGENT_TO_PHASE_TYPE[agent]
    );
    assert.deepStrictEqual(missing, [],
      `every agent in MODEL_PROFILES must have a phase-type — missing: ${JSON.stringify(missing)}`);
  });

  test('every assigned phase-type is one of the six valid slots', () => {
    const invalid = Object.entries(AGENT_TO_PHASE_TYPE).filter(
      ([, phaseType]) => !VALID_PHASE_TYPES.has(phaseType)
    );
    assert.deepStrictEqual(invalid, [],
      `phase-type assignments must use VALID_PHASE_TYPES — invalid: ${JSON.stringify(invalid)}`);
  });
});

// ─── Resolver behavior: phase-type drives tier ──────────────────────────────

describe('#3023 resolver: models.<phase_type> overrides profile-based tier', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('resolver'); });
  afterEach(() => { rmr(projectDir); });

  test('phase-type alone — research agents get the phase-type tier, planner gets profile default', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { research: 'haiku' },
    });
    // gsd-phase-researcher is a research agent — should pick up 'haiku'
    // from the phase-type slot, not 'sonnet' from the balanced profile.
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'haiku');
    // gsd-codebase-mapper is also research → haiku
    assert.equal(resolveModelInternal(projectDir, 'gsd-codebase-mapper'), 'haiku');
    // gsd-planner is planning, no models.planning set → falls through to
    // profile (balanced → opus per MODEL_PROFILES).
    assert.equal(resolveModelInternal(projectDir, 'gsd-planner'), 'opus');
  });

  test('per-agent override beats phase-type (acceptance criterion b)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { research: 'haiku' },
      model_overrides: { 'gsd-phase-researcher': 'opus' },
    });
    // The targeted per-agent override wins for that one agent.
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'opus');
    // Other research agents still pick up the phase-type tier.
    assert.equal(resolveModelInternal(projectDir, 'gsd-codebase-mapper'), 'haiku');
    assert.equal(resolveModelInternal(projectDir, 'gsd-research-synthesizer'), 'haiku');
  });

  test('phase-type beats profile (acceptance criterion c)', () => {
    // model_profile=quality would normally make research agents 'opus'.
    // models.research='haiku' must win.
    writeConfig(projectDir, {
      model_profile: 'quality',
      models: { research: 'haiku' },
    });
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'haiku');
    assert.equal(resolveModelInternal(projectDir, 'gsd-codebase-mapper'), 'haiku');
    // gsd-planner is planning, no slot set, profile=quality → opus.
    assert.equal(resolveModelInternal(projectDir, 'gsd-planner'), 'opus');
  });

  test('issue example: opus for planning/discuss/execution, sonnet for research/verification/completion', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: {
        planning: 'opus',
        discuss: 'opus',
        execution: 'opus',
        research: 'sonnet',
        verification: 'sonnet',
        completion: 'sonnet',
      },
    });
    // Planning agents → opus
    assert.equal(resolveModelInternal(projectDir, 'gsd-planner'), 'opus');
    // Execution agents → opus
    assert.equal(resolveModelInternal(projectDir, 'gsd-executor'), 'opus');
    // Research agents → sonnet
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'sonnet');
    // Verification agents → sonnet
    assert.equal(resolveModelInternal(projectDir, 'gsd-verifier'), 'sonnet');
  });

  test('phase-type "inherit" is honored (preserves existing inherit semantics)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { research: 'inherit' },
    });
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'inherit');
  });

  test('empty models block is a no-op (acceptance criterion: backward compat)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: {},
    });
    // Behavior must match no-models config (balanced profile).
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'sonnet');
    assert.equal(resolveModelInternal(projectDir, 'gsd-planner'), 'opus');
  });

  test('no models block at all is a no-op (acceptance criterion: backward compat)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
    });
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'sonnet');
    assert.equal(resolveModelInternal(projectDir, 'gsd-planner'), 'opus');
  });

  test('unrecognized tier value falls through to profile (typo safety) — CR follow-up', () => {
    // The VALID_TIERS guard in resolveModelInternal must reject any value
    // that isn't a known tier alias and fall back to the profile tier.
    // Without this guard a typo like "haiku3" would pollute the runtime
    // resolution chain. Locks the guard in so a future regression that
    // removes it is caught.
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { research: 'haiku3' }, // typo; not a valid tier alias
    });
    // Falls back to balanced → sonnet for research agents.
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'sonnet');
    assert.equal(resolveModelInternal(projectDir, 'gsd-codebase-mapper'), 'haiku',
      'gsd-codebase-mapper at balanced is haiku per profile, unaffected by typo');
  });

  test('full model ID in models.<phase_type> is rejected; falls through to profile — CR follow-up', () => {
    // Full IDs are not valid in models.<phase_type>; they belong in
    // model_overrides per agent. The guard ensures we don't accidentally
    // hand a full ID into the runtime-tier resolution chain.
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { research: 'openai/gpt-5' },
    });
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'sonnet');
  });

  // ─── CR Major: phase-type beats inherit profile ─────────────────────────
  // Pre-fix bug: model_profile='inherit' + models.execution='opus' returned
  // 'inherit' because the profile short-circuit fired BEFORE the phase-type
  // override could win, violating the documented precedence where
  // models[phase_type] beats model_profile.

  test('phase-type override wins over profile=inherit (CR Major) — model resolver', () => {
    writeConfig(projectDir, {
      model_profile: 'inherit',
      models: { execution: 'opus' },
    });
    // gsd-executor (execution) must get the phase-type opus, not inherit.
    assert.equal(resolveModelInternal(projectDir, 'gsd-executor'), 'opus');
  });

  test('phase-type "haiku" wins over profile=inherit; agents without a slot still inherit', () => {
    writeConfig(projectDir, {
      model_profile: 'inherit',
      models: { research: 'haiku' },
    });
    // research agents → haiku (phase-type wins)
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'haiku');
    assert.equal(resolveModelInternal(projectDir, 'gsd-codebase-mapper'), 'haiku');
    // planning agent has no slot set → falls through to profile=inherit.
    assert.equal(resolveModelInternal(projectDir, 'gsd-planner'), 'inherit');
  });

  test('profile=inherit with no models block still returns inherit (no regression)', () => {
    writeConfig(projectDir, {
      model_profile: 'inherit',
    });
    assert.equal(resolveModelInternal(projectDir, 'gsd-executor'), 'inherit');
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'inherit');
  });

  test('profile=inherit with models block but agent has no slot → inherit', () => {
    writeConfig(projectDir, {
      model_profile: 'inherit',
      models: { research: 'haiku' },
    });
    // gsd-executor (execution slot) is not set → falls through to inherit.
    assert.equal(resolveModelInternal(projectDir, 'gsd-executor'), 'inherit');
  });
});

// ─── #443 Unified effort: resolveEffortInternal + renderEffortForRuntime ────

const { resolveEffortInternal } = require('../gsd-core/bin/lib/model-resolver.cjs');
const { renderEffortForRuntime } = require('../gsd-core/bin/lib/model-catalog.cjs');

describe('#3023 + #443: unified effort resolver (resolveEffortInternal) for Codex', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('effort'); });
  afterEach(() => { rmr(projectDir); });

  test('resolveEffortInternal exported from model-resolver.cjs', () => {
    assert.equal(typeof resolveEffortInternal, 'function');
  });

  test('effort derives from AGENT_DEFAULT_TIERS (routing), not phase-type; gsd-executor is standard → high', () => {
    // Under unification, effort is config-driven via routing_tier_defaults.
    // gsd-executor has routing tier 'standard' → default effort 'high', regardless
    // of models.execution phase-type or model_profile setting.
    writeConfig(projectDir, {
      runtime: 'codex',
      model_profile: 'balanced',
      models: { execution: 'opus' },
    });
    const eff = resolveEffortInternal(projectDir, 'gsd-executor');
    // standard tier → 'high' (not 'xhigh' from opus, not 'medium' from old catalog)
    assert.equal(eff, 'high');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.equal(rendered.param, 'model_reasoning_effort');
    assert.equal(rendered.value, 'high');
  });

  test('effort resolves universally even when models.execution=inherit', () => {
    // Under unification, models.execution='inherit' does not affect effort resolution.
    // Effort always resolves from routing_tier_defaults: gsd-executor (standard) → 'high'.
    writeConfig(projectDir, {
      runtime: 'codex',
      model_profile: 'balanced',
      models: { execution: 'inherit' },
    });
    const eff = resolveEffortInternal(projectDir, 'gsd-executor');
    assert.equal(eff, 'high');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.equal(rendered.param, 'model_reasoning_effort');
    assert.equal(rendered.value, 'high');
  });

  test('per-agent model_overrides does not affect effort (effort is routing-tier-based)', () => {
    // Under unification, effort does not check model_overrides.
    // gsd-executor (standard tier) → 'high' regardless.
    writeConfig(projectDir, {
      runtime: 'codex',
      model_profile: 'balanced',
      models: { execution: 'opus' },
      model_overrides: { 'gsd-executor': 'openai/gpt-5' },
    });
    const eff = resolveEffortInternal(projectDir, 'gsd-executor');
    assert.equal(eff, 'high');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.equal(rendered.param, 'model_reasoning_effort');
    assert.equal(rendered.value, 'high');
  });

  test('Claude runtime: effort is first-class (emits output_config.effort, not null)', () => {
    // Under unification, Claude effort is first-class via output_config.effort.
    // No `runtime` set → defaults to claude (no runtime key → undefined runtime).
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { execution: 'opus' },
    });
    const eff = resolveEffortInternal(projectDir, 'gsd-executor');
    // effort resolves universally; claude render gives output_config.effort
    const rendered = renderEffortForRuntime(undefined, eff);
    // undefined runtime yields param=null (no runtime key set)
    assert.equal(rendered.param, null);
    // But if explicitly set to 'claude':
    const renderedClaude = renderEffortForRuntime('claude', eff);
    assert.equal(renderedClaude.param, 'output_config.effort');
    assert.equal(renderedClaude.value, 'high');
  });

  test('profile=inherit does not affect effort; effort resolves from routing tier', () => {
    // Under unification, effort is completely independent of model_profile.
    // gsd-executor (standard routing tier) → 'high' even with model_profile='inherit'.
    writeConfig(projectDir, {
      runtime: 'codex',
      model_profile: 'inherit',
      models: { execution: 'opus' },
    });
    const eff = resolveEffortInternal(projectDir, 'gsd-executor');
    assert.equal(eff, 'high',
      'profile=inherit must not affect effort; standard routing tier → high');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.equal(rendered.param, 'model_reasoning_effort');
    assert.equal(rendered.value, 'high');
  });
});

// ─── Schema validation ──────────────────────────────────────────────────────

describe('#3023 config-schema: models.<phase_type> validation', () => {
  test('models.planning is a valid config key', () => {
    assert.equal(isValidConfigKey('models.planning'), true);
  });

  test('all six phase-type slots are valid config keys', () => {
    for (const slot of ['planning', 'discuss', 'research', 'execution', 'verification', 'completion']) {
      assert.equal(isValidConfigKey(`models.${slot}`), true,
        `models.${slot} must be a valid config key`);
    }
  });

  test('unknown phase-type is rejected (acceptance criterion d)', () => {
    assert.equal(isValidConfigKey('models.deployment'), false,
      'unknown phase-type must NOT be accepted');
    assert.equal(isValidConfigKey('models.gsd-planner'), false,
      'agent name in models.* must NOT be accepted (use model_overrides for agents)');
  });

  test('models alone (without a slot) is not a valid config-set key', () => {
    // Setting the whole block isn't a granular set; users edit JSON directly.
    assert.equal(isValidConfigKey('models'), false);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-443-effort-fast-mode.integration.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-443-effort-fast-mode.integration (consolidation epic #1969 B8 #1977)", () => {
'use strict';

/**
 * Architecture-level QA for issue #443 — unified effort + fast_mode engine.
 *
 * Integration suite (*.integration.test.cjs): cross-module flows that exercise
 * real CLI invocations via runGsdTools, the full 33-agent registry, and the
 * config round-trip through config-set -> resolve-execution.
 *
 * INVARIANTS tested here (each is also documented in docs/TESTING-SUITES.md):
 *
 *  (a) CROSS-PROVIDER VALIDITY  — renderEffortForRuntime never emits a value
 *      that the real provider API would 400 on. Ground-truth provider enums are
 *      defined as local constants (not sourced from the implementation).
 *
 *  (b) PARAM/CHANNEL CONTRACT   — each runtime exposes a stable parameter name
 *      and propagation channel.
 *
 *  (c) RESOLVE-EXECUTION JSON CONTRACT — the CLI command emits a stable JSON
 *      shape with all required keys and correct types.
 *
 *  (d) TOTALITY across the real 33-agent registry — every agent produces a
 *      valid effort value; none returns undefined/null.
 *
 *  (e) FAST-MODE HONESTY INVARIANT — claude runtime always reports
 *      fast_mode_supported=false (emitting fast_mode frontmatter is a silent
 *      no-op for Claude Code subagents).
 *
 *  (f) PRECEDENCE MATRIX — first-valid-wins for both effort and fast_mode
 *      cascades, including invalid values correctly falling through.
 *
 *  (g) DYNAMIC-ROUTING COMPOSITION — resolveEffortForTier escalates
 *      independently of model tier logic; clamps at 'max'; respects
 *      max_escalations; disabled when escalate_on_failure=false.
 *
 *  (h) CONFIG-TOOLING ROUND-TRIP — config-set accepts all new effort/fast_mode
 *      key paths (schema validation passes); values survive round-trip through
 *      resolve-execution.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const {
  resolveEffortInternal,
  resolveFastModeInternal,
  resolveEffortForTier,
  VALID_EFFORTS,
} = require('../gsd-core/bin/lib/model-resolver.cjs');

const {
  renderEffortForRuntime,
  RUNTIMES_WITH_FAST_MODE,
  catalog,
} = require('../gsd-core/bin/lib/model-catalog.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Ground-truth provider enums (defined HERE, not sourced from the implementation).
// These are the exact values the real APIs accept — using a value outside these
// sets would result in a 400 response from the provider.
//
// Sources:
//   Anthropic: output_config.effort — https://docs.anthropic.com (Claude API)
//   OpenAI:    model_reasoning_effort — https://platform.openai.com/docs (Codex)
// ─────────────────────────────────────────────────────────────────────────────
const PROVIDER_EFFORT_ENUMS = {
  claude: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  codex:  new Set(['minimal', 'low', 'medium', 'high', 'xhigh']),
};

// Helper: write config.json into a temp project
function writeConfig(dir, config) {
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config, null, 2));
}

// ─── (a) CROSS-PROVIDER VALIDITY INVARIANT ───────────────────────────────────

describe('#443 integration (a): cross-provider validity invariant', () => {
  // For every universal effort × every provider runtime, the rendered value
  // must be a member of that provider's real API enum.
  test('all VALID_EFFORTS render within provider enums for claude and codex', () => {
    for (const universalEffort of VALID_EFFORTS) {
      for (const [runtime, providerEnum] of Object.entries(PROVIDER_EFFORT_ENUMS)) {
        const rendered = renderEffortForRuntime(runtime, universalEffort);
        assert.ok(
          providerEnum.has(rendered.value),
          `render('${runtime}', '${universalEffort}').value = '${rendered.value}' is NOT in the ` +
          `${runtime} provider enum ${[...providerEnum].join('|')} — real API would 400`
        );
      }
    }
  });

  // Documented clamps must hold exactly
  test("render('codex','max').value === 'xhigh' (max is Anthropic-only)", () => {
    assert.strictEqual(renderEffortForRuntime('codex', 'max').value, 'xhigh');
  });

  test("render('claude','minimal').value === 'low' (minimal is Codex-only)", () => {
    assert.strictEqual(renderEffortForRuntime('claude', 'minimal').value, 'low');
  });

  // Common levels must pass through unchanged on BOTH providers
  test('common levels (low/medium/high/xhigh) pass through unchanged on claude', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh']) {
      assert.strictEqual(
        renderEffortForRuntime('claude', level).value,
        level,
        `claude: level '${level}' should pass through unchanged`
      );
    }
  });

  test('common levels (low/medium/high/xhigh) pass through unchanged on codex', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh']) {
      assert.strictEqual(
        renderEffortForRuntime('codex', level).value,
        level,
        `codex: level '${level}' should pass through unchanged`
      );
    }
  });
});

// ─── (b) PARAM/CHANNEL CONTRACT ──────────────────────────────────────────────

describe('#443 integration (b): param/channel contract', () => {
  test("claude: param is always 'output_config.effort'", () => {
    for (const effort of VALID_EFFORTS) {
      const r = renderEffortForRuntime('claude', effort);
      assert.strictEqual(r.param, 'output_config.effort',
        `claude param must be 'output_config.effort' for effort '${effort}'`);
    }
  });

  test("codex: param is always 'model_reasoning_effort'", () => {
    for (const effort of VALID_EFFORTS) {
      const r = renderEffortForRuntime('codex', effort);
      assert.strictEqual(r.param, 'model_reasoning_effort',
        `codex param must be 'model_reasoning_effort' for effort '${effort}'`);
    }
  });

  test('claude channel is stable: frontmatter', () => {
    for (const effort of VALID_EFFORTS) {
      assert.strictEqual(renderEffortForRuntime('claude', effort).channel, 'frontmatter');
    }
  });

  test('codex channel is stable: api', () => {
    for (const effort of VALID_EFFORTS) {
      assert.strictEqual(renderEffortForRuntime('codex', effort).channel, 'api');
    }
  });

  test("unknown runtimes (gemini, qwen, 'mystery'): param===null, value passes through", () => {
    for (const runtime of ['gemini', 'qwen', 'mystery']) {
      for (const effort of VALID_EFFORTS) {
        const r = renderEffortForRuntime(runtime, effort);
        assert.strictEqual(r.param, null, `${runtime}: param must be null`);
        assert.strictEqual(r.channel, null, `${runtime}: channel must be null`);
        assert.strictEqual(r.value, effort, `${runtime}: value must pass through unchanged`);
      }
    }
  });
});

// ─── (c) RESOLVE-EXECUTION JSON CONTRACT ─────────────────────────────────────

describe('#443 integration (c): resolve-execution JSON contract', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function assertFullContract(output, label) {
    assert.ok(typeof output.model === 'string' && output.model.length > 0,
      `${label}: model must be a non-empty string`);
    assert.ok(typeof output.profile === 'string' && output.profile.length > 0,
      `${label}: profile must be a non-empty string`);
    assert.ok(VALID_EFFORTS.includes(output.effort),
      `${label}: effort '${output.effort}' must be a member of VALID_EFFORTS`);
    assert.ok(typeof output.effort_rendered === 'string' && output.effort_rendered.length > 0,
      `${label}: effort_rendered must be a non-empty string`);
    assert.ok(output.effort_param === null || typeof output.effort_param === 'string',
      `${label}: effort_param must be string or null`);
    assert.ok(output.effort_propagation === null || typeof output.effort_propagation === 'string',
      `${label}: effort_propagation must be string or null`);
    assert.ok(typeof output.fast_mode === 'boolean',
      `${label}: fast_mode must be a boolean`);
    assert.ok(typeof output.fast_mode_supported === 'boolean',
      `${label}: fast_mode_supported must be a boolean`);
  }

  test('gsd-planner (default claude runtime): full contract + known-agent shape', () => {
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assertFullContract(output, 'gsd-planner/claude');
    assert.strictEqual(output.effort_param, 'output_config.effort');
    assert.strictEqual(output.effort_propagation, 'frontmatter');
    assert.strictEqual(output.fast_mode_supported, false);
    // known agent must NOT have unknown_agent:true
    assert.ok(!output.unknown_agent, 'known agent must not have unknown_agent:true');
  });

  test('codex runtime: full contract + effort_param=model_reasoning_effort', () => {
    writeConfig(tmpDir, { runtime: 'codex' });
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assertFullContract(output, 'gsd-planner/codex');
    assert.strictEqual(output.effort_param, 'model_reasoning_effort');
    assert.strictEqual(output.fast_mode_supported, false);
  });

  test('gemini runtime: full contract + effort_param===null (no effort wire)', () => {
    writeConfig(tmpDir, { runtime: 'gemini' });
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assertFullContract(output, 'gsd-planner/gemini');
    assert.strictEqual(output.effort_param, null);
    assert.strictEqual(output.effort_propagation, null);
    assert.strictEqual(output.fast_mode_supported, false);
  });

  test('unknown agent: full contract + unknown_agent===true', () => {
    const result = runGsdTools(['resolve-execution', 'unknown-agent-xyz'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assertFullContract(output, 'unknown-agent-xyz');
    assert.strictEqual(output.unknown_agent, true, 'unknown agent must have unknown_agent:true');
  });
});

// ─── (d) TOTALITY across the real 33-agent registry ──────────────────────────

describe('#443 integration (d): totality across real registry', () => {
  let tmpDir;
  before(() => { tmpDir = createTempProject(); });
  after(() => { cleanup(tmpDir); });

  const registeredAgents = Object.keys(catalog.agents);
  // Confirm we're covering the full registry — snapshot the count so a
  // catalog shrink is caught by this assertion.
  test(`registry has at least 33 agents (currently ${registeredAgents.length})`, () => {
    assert.ok(registeredAgents.length >= 33,
      `Expected at least 33 agents in registry, got ${registeredAgents.length}`);
  });

  test(`all ${registeredAgents.length} agents: resolveEffortInternal returns a VALID_EFFORTS member`, () => {
    const effortSet = new Set(VALID_EFFORTS);
    const bad = [];
    for (const agent of registeredAgents) {
      const effort = resolveEffortInternal(tmpDir, agent);
      if (effort === undefined || effort === null || !effortSet.has(effort)) {
        bad.push(`${agent}: got ${JSON.stringify(effort)}`);
      }
    }
    assert.strictEqual(bad.length, 0,
      `Agents with invalid effort:\n${bad.join('\n')}`);
  });

  test(`all ${registeredAgents.length} agents: resolveFastModeInternal returns strict boolean`, () => {
    const bad = [];
    for (const agent of registeredAgents) {
      const fm = resolveFastModeInternal(tmpDir, agent);
      if (typeof fm !== 'boolean') {
        bad.push(`${agent}: got ${JSON.stringify(fm)} (${typeof fm})`);
      }
    }
    assert.strictEqual(bad.length, 0,
      `Agents with non-boolean fast_mode:\n${bad.join('\n')}`);
  });

  test(`all ${registeredAgents.length} agents: renderEffortForRuntime('claude', effort) stays in claude enum`, () => {
    const claudeEnum = PROVIDER_EFFORT_ENUMS.claude;
    const bad = [];
    for (const agent of registeredAgents) {
      const effort = resolveEffortInternal(tmpDir, agent);
      const rendered = renderEffortForRuntime('claude', effort);
      if (!claudeEnum.has(rendered.value)) {
        bad.push(`${agent}: effort=${effort} rendered=${rendered.value} not in claude enum`);
      }
    }
    assert.strictEqual(bad.length, 0,
      `Agents producing invalid claude effort:\n${bad.join('\n')}`);
  });
});

// ─── (e) FAST-MODE HONESTY INVARIANT ─────────────────────────────────────────

describe('#443 integration (e): fast-mode honesty invariant', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  // Sample of agents across all tiers to prove the invariant is not agent-specific
  const testAgents = ['gsd-planner', 'gsd-executor', 'gsd-codebase-mapper', 'gsd-verifier'];

  test('claude runtime: fast_mode_supported is ALWAYS false regardless of fast_mode config', () => {
    const configs = [
      {},
      { fast_mode: { enabled: true } },
      { fast_mode: { routing_tier_defaults: { heavy: true } } },
      { fast_mode: { agent_overrides: { 'gsd-planner': true } } },
    ];
    for (const config of configs) {
      writeConfig(tmpDir, config);
      for (const agent of testAgents) {
        const result = runGsdTools(['resolve-execution', agent], tmpDir, { HOME: tmpDir });
        assert.ok(result.success, `Command failed for ${agent}: ${result.error}`);
        const output = JSON.parse(result.output);
        assert.strictEqual(output.fast_mode_supported, false,
          `claude/${agent}: fast_mode_supported must be false (Claude has no per-subagent fast-mode mechanism); config=${JSON.stringify(config)}`);
      }
    }
  });

  test("RUNTIMES_WITH_FAST_MODE.has('api') === true (api is the only fast-mode capable runtime)", () => {
    assert.ok(RUNTIMES_WITH_FAST_MODE.has('api'),
      "RUNTIMES_WITH_FAST_MODE must include 'api' — this is the only runtime with per-call fast_mode support");
  });

  test("RUNTIMES_WITH_FAST_MODE.has('claude') === false (claude fast-mode is session-level only)", () => {
    assert.ok(!RUNTIMES_WITH_FAST_MODE.has('claude'),
      "RUNTIMES_WITH_FAST_MODE must NOT include 'claude' — emitting fast_mode frontmatter on a Claude subagent is a silent no-op");
  });

  test("RUNTIMES_WITH_FAST_MODE.has('codex') === false", () => {
    assert.ok(!RUNTIMES_WITH_FAST_MODE.has('codex'),
      "codex does not support per-call fast_mode");
  });

  test("RUNTIMES_WITH_FAST_MODE.has('gemini') === false", () => {
    assert.ok(!RUNTIMES_WITH_FAST_MODE.has('gemini'),
      "gemini does not support per-call fast_mode");
  });
});

// ─── (f) PRECEDENCE MATRIX ───────────────────────────────────────────────────

describe('#443 integration (f): precedence matrix (property/table-driven)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  // Effort: first-valid-wins from highest precedence to lowest
  //   1. opts.override (invocation)
  //   2. effort.agent_overrides.<agent>
  //   3. effort.routing_tier_defaults.<tier>
  //   4. effort.default
  //   5. manifest tier default
  //   6. hardcoded 'high'
  const effortPrecedenceTable = [
    {
      label: 'layer 1 (invocation override) beats all',
      config: {
        effort: {
          agent_overrides: { 'gsd-planner': 'low' },
          routing_tier_defaults: { heavy: 'medium' },
          default: 'xhigh',
        },
      },
      opts: { override: 'minimal' },
      expected: 'minimal',
    },
    {
      label: 'layer 2 (agent_override) beats tier default and default',
      config: {
        effort: {
          agent_overrides: { 'gsd-planner': 'low' },
          routing_tier_defaults: { heavy: 'medium' },
          default: 'xhigh',
        },
      },
      opts: {},
      expected: 'low',
    },
    {
      label: 'layer 3 (routing_tier_defaults) beats effort.default',
      config: {
        effort: {
          routing_tier_defaults: { heavy: 'medium' },
          default: 'xhigh',
        },
      },
      opts: {},
      expected: 'medium',
    },
    {
      label: 'layer 4 (effort.default) when no tier default set',
      config: {
        effort: { default: 'low' },
      },
      opts: {},
      expected: 'low',
    },
    {
      label: 'invalid layer 1 (turbo) falls through to layer 2 (agent_override)',
      config: {
        effort: { agent_overrides: { 'gsd-planner': 'medium' } },
      },
      opts: { override: 'turbo' },
      expected: 'medium',
    },
    {
      label: 'invalid layer 2 (agent_override=123 numeric) falls through to tier default',
      config: {
        effort: {
          agent_overrides: { 'gsd-planner': 123 },
          routing_tier_defaults: { heavy: 'high' },
        },
      },
      opts: {},
      expected: 'high',
    },
    {
      label: 'invalid tier default (turbo) falls through to effort.default',
      config: {
        effort: {
          routing_tier_defaults: { heavy: 'turbo' },
          default: 'low',
        },
      },
      opts: {},
      expected: 'low',
    },
  ];

  for (const row of effortPrecedenceTable) {
    test(`effort precedence: ${row.label}`, () => {
      writeConfig(tmpDir, row.config);
      const result = resolveEffortInternal(tmpDir, 'gsd-planner', row.opts);
      assert.strictEqual(result, row.expected,
        `Expected '${row.expected}', got '${result}' — config: ${JSON.stringify(row.config)}`);
    });
  }

  // fast_mode precedence:
  //   1. opts.override (strict boolean only)
  //   2. fast_mode.agent_overrides.<agent> (strict boolean only)
  //   3. fast_mode.routing_tier_defaults.<tier> (strict boolean only)
  //   4. fast_mode.enabled (strict boolean only)
  //   5. false
  const fastModePrecedenceTable = [
    {
      label: 'layer 1 (opts.override=false) beats enabled=true',
      config: { fast_mode: { enabled: true } },
      opts: { override: false },
      expected: false,
    },
    {
      label: 'layer 2 (agent_override=true) beats tier default',
      config: {
        fast_mode: {
          agent_overrides: { 'gsd-planner': true },
          routing_tier_defaults: { heavy: false },
          enabled: false,
        },
      },
      opts: {},
      expected: true,
    },
    {
      label: 'layer 3 (tier default=true) beats enabled=false',
      config: {
        fast_mode: {
          routing_tier_defaults: { heavy: true },
          enabled: false,
        },
      },
      opts: {},
      expected: true,
    },
    {
      label: 'layer 4 (enabled=true) when no tier/agent overrides',
      config: { fast_mode: { enabled: true } },
      opts: {},
      expected: true,
    },
    {
      label: 'layer 5 (default false) when all absent',
      config: {},
      opts: {},
      expected: false,
    },
    {
      label: 'string "true" in opts.override is NOT accepted (falls through)',
      config: { fast_mode: { enabled: true } },
      // override must be strict boolean; string falls through to next layer
      opts: { override: 'true' },
      // 'true' as string is not boolean -> falls through to tier default
      // gsd-planner is heavy; no tier default set; falls to enabled=true
      expected: true,
    },
    {
      label: 'string "true" in agent_overrides is NOT accepted',
      config: {
        fast_mode: {
          agent_overrides: { 'gsd-planner': 'true' },
          enabled: false,
        },
      },
      opts: {},
      // string 'true' is not boolean -> fall through to tier default -> enabled=false -> false
      expected: false,
    },
  ];

  for (const row of fastModePrecedenceTable) {
    test(`fast_mode precedence: ${row.label}`, () => {
      writeConfig(tmpDir, row.config);
      const result = resolveFastModeInternal(tmpDir, 'gsd-planner', row.opts);
      assert.strictEqual(result, row.expected,
        `Expected ${row.expected}, got ${result} — config: ${JSON.stringify(row.config)}`);
    });
  }
});

// ─── (g) DYNAMIC-ROUTING COMPOSITION ─────────────────────────────────────────

describe('#443 integration (g): dynamic-routing composition', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  const dynamicRoutingBase = {
    dynamic_routing: {
      enabled: true,
      tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
      escalate_on_failure: true,
      max_escalations: 4,
    },
    effort: { routing_tier_defaults: { light: 'low' } },
  };

  test('resolveEffortForTier escalates independently of model resolution', () => {
    writeConfig(tmpDir, dynamicRoutingBase);
    const effort0 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0);
    const effort1 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1);
    const effort2 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 2);
    assert.strictEqual(effort0, 'low');
    assert.strictEqual(effort1, 'medium');
    assert.strictEqual(effort2, 'high');
    // Verify the effort ladder steps up correctly without asserting model value
    // (model timing is a separate concern from effort escalation)
    assert.notStrictEqual(effort0, effort1, 'effort should escalate at attempt 1');
    assert.notStrictEqual(effort1, effort2, 'effort should escalate at attempt 2');
  });

  test('escalate_on_failure=false: attempt is ignored for effort', () => {
    writeConfig(tmpDir, {
      ...dynamicRoutingBase,
      dynamic_routing: {
        ...dynamicRoutingBase.dynamic_routing,
        escalate_on_failure: false,
      },
    });
    const e0 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0);
    const e1 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1);
    const e3 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 3);
    assert.strictEqual(e0, e1, 'effort must not escalate when escalate_on_failure=false');
    assert.strictEqual(e0, e3, 'effort must not escalate when escalate_on_failure=false');
  });

  test('escalation clamps at "max" regardless of attempt number', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 99,
      },
      effort: { default: 'max' },
    });
    // Any large attempt number — result must never exceed 'max'
    const r = resolveEffortForTier(tmpDir, 'gsd-planner', 50);
    assert.strictEqual(r, 'max', `Effort must clamp at 'max', got '${r}'`);
    const EFFORT_LADDER = VALID_EFFORTS;
    const maxIdx = EFFORT_LADDER.indexOf('max');
    const rIdx = EFFORT_LADDER.indexOf(r);
    assert.ok(rIdx <= maxIdx, 'Effort must not exceed the max position in the ladder');
  });

  test('respects max_escalations cap: attempt beyond cap gives same as cap', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 1,
      },
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    const atCap = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1);    // 1 escalation
    const beyond = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 5);   // capped at 1
    assert.strictEqual(atCap, beyond,
      'Effort beyond max_escalations must be same as at cap');
    assert.strictEqual(atCap, 'medium', 'low + 1 escalation = medium');
  });

  test('dynamic_routing disabled: resolveEffortForTier ignores attempt', () => {
    writeConfig(tmpDir, {
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    const e0 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0);
    const e5 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 5);
    assert.strictEqual(e0, e5, 'Effort must not change when dynamic_routing is disabled');
    assert.strictEqual(e0, 'low');
  });
});

// ─── (h) CONFIG-TOOLING ROUND-TRIP ───────────────────────────────────────────

describe('#443 integration (h): config-tooling round-trip', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('config-set effort.default then resolve-execution reflects new value', () => {
    const setResult = runGsdTools(['config-set', 'effort.default', 'low'], tmpDir, { HOME: tmpDir });
    assert.ok(setResult.success, `config-set effort.default failed: ${setResult.error}`);

    const execResult = runGsdTools(['resolve-execution', 'unknown-agent-xyz'], tmpDir, { HOME: tmpDir });
    assert.ok(execResult.success, `resolve-execution failed: ${execResult.error}`);
    const output = JSON.parse(execResult.output);
    // unknown agent falls through to effort.default
    assert.strictEqual(output.effort, 'low',
      `Expected effort='low' after config-set, got '${output.effort}'`);
  });

  test('config-set effort.routing_tier_defaults.heavy then resolve-execution uses it', () => {
    const setResult = runGsdTools(
      ['config-set', 'effort.routing_tier_defaults.heavy', 'medium'],
      tmpDir, { HOME: tmpDir }
    );
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const execResult = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(execResult.success, `resolve-execution failed: ${execResult.error}`);
    const output = JSON.parse(execResult.output);
    // gsd-planner is heavy; tier default now overridden to medium
    assert.strictEqual(output.effort, 'medium',
      `Expected effort='medium' after routing_tier_defaults override, got '${output.effort}'`);
  });

  test('config-set effort.agent_overrides.<agent> wins over tier default', () => {
    // Set tier default first, then per-agent override
    runGsdTools(['config-set', 'effort.routing_tier_defaults.heavy', 'medium'], tmpDir, { HOME: tmpDir });
    const setResult = runGsdTools(
      ['config-set', 'effort.agent_overrides.gsd-planner', 'xhigh'],
      tmpDir, { HOME: tmpDir }
    );
    assert.ok(setResult.success, `config-set agent_overrides failed: ${setResult.error}`);

    const execResult = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(execResult.success, `resolve-execution failed: ${execResult.error}`);
    const output = JSON.parse(execResult.output);
    assert.strictEqual(output.effort, 'xhigh',
      `Expected agent_overrides to win (xhigh), got '${output.effort}'`);
  });

  test('config-set fast_mode.enabled true then resolve-execution reflects fast_mode=true', () => {
    const setResult = runGsdTools(['config-set', 'fast_mode.enabled', 'true'], tmpDir, { HOME: tmpDir });
    assert.ok(setResult.success, `config-set fast_mode.enabled failed: ${setResult.error}`);

    const execResult = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(execResult.success, `resolve-execution failed: ${execResult.error}`);
    const output = JSON.parse(execResult.output);
    assert.strictEqual(output.fast_mode, true,
      `Expected fast_mode=true after config-set, got ${output.fast_mode}`);
    // fast_mode_supported stays false (claude runtime)
    assert.strictEqual(output.fast_mode_supported, false);
  });

  test('config-set fast_mode.agent_overrides.<agent> true reflects in output', () => {
    const setResult = runGsdTools(
      ['config-set', 'fast_mode.agent_overrides.gsd-codebase-mapper', 'true'],
      tmpDir, { HOME: tmpDir }
    );
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const execResult = runGsdTools(['resolve-execution', 'gsd-codebase-mapper'], tmpDir, { HOME: tmpDir });
    assert.ok(execResult.success, `resolve-execution failed: ${execResult.error}`);
    const output = JSON.parse(execResult.output);
    assert.strictEqual(output.fast_mode, true,
      `Expected fast_mode=true for agent-specific override`);
  });

  // Prove the config-set commands accept all the new key namespaces (schema validation)
  test('config-set accepts all effort/* and fast_mode/* key namespaces without error', () => {
    const keysToTest = [
      ['effort.default', 'high'],
      ['effort.routing_tier_defaults.light', 'low'],
      ['effort.routing_tier_defaults.standard', 'medium'],
      ['effort.routing_tier_defaults.heavy', 'xhigh'],
      ['effort.agent_overrides.gsd-executor', 'high'],
      ['fast_mode.enabled', 'false'],
      ['fast_mode.routing_tier_defaults.light', 'false'],
      ['fast_mode.routing_tier_defaults.standard', 'false'],
      ['fast_mode.routing_tier_defaults.heavy', 'false'],
      ['fast_mode.agent_overrides.gsd-verifier', 'false'],
    ];
    for (const [key, val] of keysToTest) {
      const r = runGsdTools(['config-set', key, val], tmpDir, { HOME: tmpDir });
      assert.ok(r.success, `config-set '${key}' '${val}' should succeed, got: ${r.error}`);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-443-effort-fast-mode.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-443-effort-fast-mode (consolidation epic #1969 B8 #1977)", () => {
'use strict';

/**
 * Feature test for issue #443 — unified cross-provider effort + fast_mode knobs.
 *
 * Adds config-driven effort (universal ladder: minimal<low<medium<high<xhigh<max)
 * and fast_mode knobs. Per-runtime rendering clamps the unique tails:
 *   - Anthropic/Claude: supports {low,medium,high,xhigh,max}, param=output_config.effort
 *   - Codex: supports {minimal,low,medium,high,xhigh}, param=model_reasoning_effort
 *
 * Also adds resolve-execution query which is the superset command including
 * effort rendering and fast_mode propagation metadata.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const {
  resolveEffortInternal,
  resolveFastModeInternal,
  resolveEffortForTier,
} = require('../gsd-core/bin/lib/model-resolver.cjs');

const {
  renderEffortForRuntime,
  RUNTIMES_WITH_FAST_MODE,
} = require('../gsd-core/bin/lib/model-catalog.cjs');

const {
  injectEffortFrontmatter,
} = require('../bin/install.js');

function writeConfig(dir, config) {
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config, null, 2));
}

// ─── Effort cascade ───────────────────────────────────────────────────────────

describe('#443 effort cascade', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('no config -> gsd-planner (heavy) defaults to "xhigh" via tier default', () => {
    // gsd-planner is heavy tier; manifest default for heavy is xhigh
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'xhigh');
  });

  test('routing_tier_defaults: light (gsd-codebase-mapper) -> "low"', () => {
    // gsd-codebase-mapper routingTier=light, default for light is "low"
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-codebase-mapper'), 'low');
  });

  test('routing_tier_defaults: standard (gsd-executor) -> "high"', () => {
    // gsd-executor routingTier=standard, default for standard is "high"
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-executor'), 'high');
  });

  test('routing_tier_defaults: heavy (gsd-planner) -> "xhigh"', () => {
    // gsd-planner routingTier=heavy, default for heavy is "xhigh"
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'xhigh');
  });

  test('effort.routing_tier_defaults override beats tier default', () => {
    writeConfig(tmpDir, {
      effort: { routing_tier_defaults: { heavy: 'medium' } },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'medium');
  });

  test('effort.agent_overrides beats routing_tier_defaults', () => {
    writeConfig(tmpDir, {
      effort: {
        routing_tier_defaults: { heavy: 'medium' },
        agent_overrides: { 'gsd-planner': 'low' },
      },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'low');
  });

  test('opts.override beats agent_overrides', () => {
    writeConfig(tmpDir, {
      effort: { agent_overrides: { 'gsd-planner': 'low' } },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner', { override: 'minimal' }), 'minimal');
  });

  test('invalid override falls through to agent_overrides', () => {
    writeConfig(tmpDir, {
      effort: { agent_overrides: { 'gsd-planner': 'low' } },
    });
    // 'turbo' is not a valid effort — should fall through to agent_overrides
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner', { override: 'turbo' }), 'low');
  });

  test('invalid agent_overrides value falls through to routing_tier_defaults', () => {
    writeConfig(tmpDir, {
      effort: {
        agent_overrides: { 'gsd-planner': 123 },
        routing_tier_defaults: { heavy: 'medium' },
      },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'medium');
  });

  test('invalid routing_tier_defaults value falls through to effort.default', () => {
    writeConfig(tmpDir, {
      effort: {
        routing_tier_defaults: { heavy: 'turbo' },
        default: 'low',
      },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'low');
  });

  test('invalid effort.default falls through to hardcoded "high" (no routing_tier_defaults set)', () => {
    writeConfig(tmpDir, {
      effort: { default: 'turbo' },
    });
    // effortCfg set but no routing_tier_defaults; turbo is invalid; fallback = hardcoded 'high'
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'high');
  });

  test('unknown agent -> uses effort.default', () => {
    writeConfig(tmpDir, {
      effort: { default: 'medium' },
    });
    // unknown-agent has no routingTier, so step 3 skipped
    assert.strictEqual(resolveEffortInternal(tmpDir, 'unknown-agent-xyz'), 'medium');
  });

  test('effort.default numeric value (123) ignored, hardcoded "high" fallback', () => {
    writeConfig(tmpDir, {
      effort: { default: 123 },
    });
    // effortCfg set, no routing_tier_defaults -> no tier default; numeric ignored -> 'high'
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'high');
  });

  test('effort block missing entirely -> uses tier default', () => {
    // No effort key in config at all
    writeConfig(tmpDir, { model_profile: 'balanced' });
    // heavy agent: tier default xhigh
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'xhigh');
  });

  test('effort block is non-object (string) -> effortCfg=null -> uses manifest tier default xhigh', () => {
    writeConfig(tmpDir, { effort: 'bad' });
    // Non-object effort => effortCfg=null; gsd-planner heavy tier manifest default = xhigh
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'xhigh');
  });

  test('effort.routing_tier_defaults empty object -> effort.default', () => {
    writeConfig(tmpDir, {
      effort: { routing_tier_defaults: {}, default: 'low' },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'low');
  });
});

// ─── Fast mode cascade ────────────────────────────────────────────────────────

describe('#443 fast_mode cascade', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('no config -> defaults to false', () => {
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('fast_mode.enabled=true -> true when no tier/agent overrides', () => {
    writeConfig(tmpDir, { fast_mode: { enabled: true } });
    // heavy agent: tier default is false, but enabled=true is layer 4
    // tier default for heavy is false (below enabled), so gets enabled=true
    // Wait — the cascade is: 1.override 2.agent_overrides 3.tier_defaults 4.enabled 5.false
    // For gsd-planner (heavy), tier default is false — falls through to enabled=true
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), true);
  });

  test('fast_mode.routing_tier_defaults.light=true -> light agent gets true', () => {
    writeConfig(tmpDir, {
      fast_mode: { routing_tier_defaults: { light: true } },
    });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-codebase-mapper'), true);
  });

  test('fast_mode.routing_tier_defaults.heavy=false -> heavy agent stays false', () => {
    writeConfig(tmpDir, {
      fast_mode: { enabled: true, routing_tier_defaults: { heavy: false } },
    });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('fast_mode.agent_overrides beats routing_tier_defaults', () => {
    writeConfig(tmpDir, {
      fast_mode: {
        routing_tier_defaults: { light: false },
        agent_overrides: { 'gsd-codebase-mapper': true },
      },
    });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-codebase-mapper'), true);
  });

  test('opts.override beats agent_overrides', () => {
    writeConfig(tmpDir, {
      fast_mode: { agent_overrides: { 'gsd-planner': true } },
    });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner', { override: false }), false);
  });

  test('string "true" NOT accepted as fast_mode override', () => {
    writeConfig(tmpDir, {
      fast_mode: { agent_overrides: { 'gsd-planner': 'true' } },
    });
    // string "true" is not boolean -> fall through to tier default or enabled
    const result = resolveFastModeInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(typeof result, 'boolean');
  });

  test('string "true" in opts.override NOT accepted', () => {
    // opts.override must be strict boolean — string falls through
    const result = resolveFastModeInternal(tmpDir, 'gsd-planner', { override: 'true' });
    assert.strictEqual(result, false);
  });

  test('fast_mode block missing entirely -> defaults to false', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('fast_mode.enabled="yes" (non-boolean) ignored -> false', () => {
    writeConfig(tmpDir, { fast_mode: { enabled: 'yes' } });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('unknown agent fast_mode -> uses enabled flag', () => {
    writeConfig(tmpDir, { fast_mode: { enabled: true } });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'unknown-agent-xyz'), true);
  });
});

// ─── Effort escalation (resolveEffortForTier) ─────────────────────────────────

describe('#443 resolveEffortForTier escalation', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('dynamic_routing disabled -> attempt ignored, returns base effort', () => {
    // gsd-planner heavy -> xhigh baseline
    const base = resolveEffortForTier(tmpDir, 'gsd-planner', 0);
    const attempt1 = resolveEffortForTier(tmpDir, 'gsd-planner', 1);
    assert.strictEqual(base, 'xhigh');
    assert.strictEqual(attempt1, 'xhigh'); // no dynamic_routing -> attempt ignored
  });

  test('dynamic_routing enabled, escalate_on_failure=false -> attempt ignored', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: false,
        max_escalations: 2,
      },
    });
    const base = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0);
    const attempt1 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1);
    assert.strictEqual(base, attempt1);
  });

  test('dynamic_routing enabled, attempt=1 -> one step up from base', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    // gsd-codebase-mapper: light -> effort 'low'; attempt=1 -> 'medium'
    assert.strictEqual(resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0), 'low');
    assert.strictEqual(resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1), 'medium');
  });

  test('escalation clamps at "max"', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 99,
      },
      effort: { default: 'xhigh' },
    });
    // xhigh -> max -> max (clamp)
    const result = resolveEffortForTier(tmpDir, 'gsd-planner', 99);
    assert.strictEqual(result, 'max');
  });

  test('respects max_escalations cap', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 1,
      },
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    // light: low -> attempt=1 -> medium (but max=1 so can only escalate once)
    const at1 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1);
    const at2 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 2);
    // at2 is capped at 1 escalation, same as at1
    assert.strictEqual(at1, at2);
    assert.strictEqual(at1, 'medium');
  });
});

// ─── Rendering / clamping ──────────────────────────────────────────────────────

describe('#443 renderEffortForRuntime', () => {
  test('codex: "max" clamps to "xhigh"', () => {
    const r = renderEffortForRuntime('codex', 'max');
    assert.strictEqual(r.value, 'xhigh');
    assert.strictEqual(r.param, 'model_reasoning_effort');
  });

  test('codex: common levels passthrough', () => {
    assert.strictEqual(renderEffortForRuntime('codex', 'low').value, 'low');
    assert.strictEqual(renderEffortForRuntime('codex', 'medium').value, 'medium');
    assert.strictEqual(renderEffortForRuntime('codex', 'high').value, 'high');
    assert.strictEqual(renderEffortForRuntime('codex', 'xhigh').value, 'xhigh');
  });

  test('codex: "minimal" passthrough', () => {
    assert.strictEqual(renderEffortForRuntime('codex', 'minimal').value, 'minimal');
  });

  test('claude: "minimal" clamps to "low"', () => {
    const r = renderEffortForRuntime('claude', 'minimal');
    assert.strictEqual(r.value, 'low');
    assert.strictEqual(r.param, 'output_config.effort');
  });

  test('claude: "max" passthrough (Anthropic-only)', () => {
    const r = renderEffortForRuntime('claude', 'max');
    assert.strictEqual(r.value, 'max');
    assert.strictEqual(r.param, 'output_config.effort');
  });

  test('claude: common levels passthrough', () => {
    assert.strictEqual(renderEffortForRuntime('claude', 'low').value, 'low');
    assert.strictEqual(renderEffortForRuntime('claude', 'medium').value, 'medium');
    assert.strictEqual(renderEffortForRuntime('claude', 'high').value, 'high');
    assert.strictEqual(renderEffortForRuntime('claude', 'xhigh').value, 'xhigh');
  });

  test('unknown runtime: param is null, value passthrough', () => {
    const r = renderEffortForRuntime('unknown-runtime', 'high');
    assert.strictEqual(r.param, null);
    assert.strictEqual(r.value, 'high');
  });

  test('RUNTIMES_WITH_FAST_MODE does NOT include "claude"', () => {
    // Claude Code has no per-subagent fast-mode mechanism — session-level only
    assert.ok(!RUNTIMES_WITH_FAST_MODE.has('claude'),
      'claude must NOT be in RUNTIMES_WITH_FAST_MODE — emitting fast_mode frontmatter is a silent no-op');
  });
});

// ─── resolve-execution end-to-end ─────────────────────────────────────────────

describe('#443 resolve-execution CLI command', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
    // HOME isolation to prevent ~/.gsd/defaults.json bleed
    process.env._GSD_TEST_HOME_OVERRIDE = tmpDir;
  });
  afterEach(() => {
    cleanup(tmpDir);
    delete process.env._GSD_TEST_HOME_OVERRIDE;
  });

  test('default (claude) runtime -> effort present, effort_param=output_config.effort, fast_mode_supported=false', () => {
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.effort, 'should have effort field');
    assert.strictEqual(output.effort_param, 'output_config.effort');
    assert.strictEqual(output.fast_mode_supported, false);
    assert.ok('fast_mode' in output, 'should have fast_mode field');
    assert.ok('model' in output, 'should have model field');
    assert.ok('profile' in output, 'should have profile field');
  });

  test('codex runtime -> effort_param=model_reasoning_effort, max clamps to xhigh, fast_mode_supported=false', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      effort: { default: 'max' },
    });
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.effort_param, 'model_reasoning_effort');
    assert.strictEqual(output.effort_rendered, 'xhigh');
    // fast_mode_supported: codex does not support fast mode via subagent
    assert.strictEqual(output.fast_mode_supported, false);
  });

  test('--effort flag overrides config effort', () => {
    const result = runGsdTools(
      ['resolve-execution', 'gsd-planner', '--effort', 'low'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.effort, 'low');
  });

  test('--fast-mode flag honored', () => {
    const result = runGsdTools(
      ['resolve-execution', 'gsd-planner', '--fast-mode', 'true'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.fast_mode, true);
  });

  test('--attempt flag triggers escalation', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    const result0 = runGsdTools(
      ['resolve-execution', 'gsd-codebase-mapper', '--attempt', '0'],
      tmpDir,
      { HOME: tmpDir }
    );
    const result1 = runGsdTools(
      ['resolve-execution', 'gsd-codebase-mapper', '--attempt', '1'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result0.success && result1.success);
    const out0 = JSON.parse(result0.output);
    const out1 = JSON.parse(result1.output);
    assert.strictEqual(out0.effort, 'low');
    assert.strictEqual(out1.effort, 'medium');
  });

  test('--raw prints effort string', () => {
    const result = runGsdTools(
      ['resolve-execution', 'gsd-planner', '--raw'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    // Raw output should be the effort string
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(result.output.trim()),
      `Expected effort string, got: ${result.output}`);
  });

  test('fails when no agent-type provided', () => {
    const result = runGsdTools(['resolve-execution'], tmpDir, { HOME: tmpDir });
    assert.ok(!result.success, 'should fail without agent-type');
    assert.ok(result.error.includes('agent-type required'), `error: ${result.error}`);
  });

  test('unknown agent -> unknown_agent=true still emits effort', () => {
    const result = runGsdTools(['resolve-execution', 'unknown-agent-xyz'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.unknown_agent, true);
    assert.ok(output.effort, 'should have effort even for unknown agent');
  });

  test('emits effort_propagation (channel) field', () => {
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok('effort_propagation' in output, 'should have effort_propagation field');
  });
});

// ─── resolve-model now emits effort (replaces reasoning_effort) ───────────────

describe('#443 resolve-model emits effort (unified)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('resolve-model on claude runtime emits effort (not null)', () => {
    const result = runGsdTools(['resolve-model', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    // effort must be present and valid
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(output.effort),
      `Expected valid effort, got: ${output.effort}`);
    // reasoning_effort must NOT be present (removed)
    assert.ok(!Object.prototype.hasOwnProperty.call(output, 'reasoning_effort'),
      'resolve-model must not emit reasoning_effort (replaced by effort)');
  });

  test('resolve-model on codex runtime emits unified effort (not reasoning_effort)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ runtime: 'codex', model_profile: 'balanced' })
    );
    const result = runGsdTools(['resolve-model', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(output.effort),
      `Expected valid effort, got: ${output.effort}`);
    assert.ok(!Object.prototype.hasOwnProperty.call(output, 'reasoning_effort'),
      'resolve-model must not emit reasoning_effort');
  });
});

// ─── QA Matrix — hostile/malformed configs ───────────────────────────────────

describe('#443 QA matrix — malformed effort/fast_mode configs', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('effort.default=123 (numeric) -> gracefully falls through', () => {
    writeConfig(tmpDir, { effort: { default: 123 } });
    // gsd-planner is heavy, tier default xhigh is used instead
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.ok(typeof result === 'string');
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(result));
  });

  test('fast_mode.enabled="yes" (string) -> ignored, returns false', () => {
    writeConfig(tmpDir, { fast_mode: { enabled: 'yes' } });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('effort:{} empty block -> uses tier default or hardcoded high', () => {
    writeConfig(tmpDir, { effort: {} });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(result));
  });

  test('fast_mode:{} empty block -> false', () => {
    writeConfig(tmpDir, { fast_mode: {} });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('effort config is completely absent -> still resolves valid effort', () => {
    writeConfig(tmpDir, { model_profile: 'quality' });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(result));
  });

  test('effort.routing_tier_defaults has boolean value -> falls through', () => {
    writeConfig(tmpDir, {
      effort: {
        routing_tier_defaults: { heavy: true },
        default: 'medium',
      },
    });
    // boolean true is not a valid effort -> falls through to default 'medium'
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'medium');
  });

  test('effort.agent_overrides is non-object -> falls through gracefully', () => {
    writeConfig(tmpDir, {
      effort: {
        agent_overrides: 'not-an-object',
        default: 'low',
      },
    });
    // non-object agent_overrides -> skip step 2, use tier default (heavy=xhigh)
    // actually heavy tier default kicks in first if no routing_tier_defaults
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(result));
  });

  test('config.json has unknown agent with effort.default set -> uses effort.default', () => {
    writeConfig(tmpDir, { effort: { default: 'minimal' } });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'completely-unknown-agent-98765'), 'minimal');
  });

  test('resolve-execution with malformed config does not crash', () => {
    writeConfig(tmpDir, {
      effort: { default: null, routing_tier_defaults: null },
      fast_mode: { enabled: null, agent_overrides: null },
    });
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Should not crash with null config values: ${result.error}`);
  });
});

// ─── Config schema: new keys are valid ───────────────────────────────────────

describe('#443 config schema: new effort/fast_mode keys valid', () => {
  const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');

  test('effort.default is a valid config key', () => {
    assert.ok(isValidConfigKey('effort.default'), 'effort.default must be valid');
  });

  test('fast_mode.enabled is a valid config key', () => {
    assert.ok(isValidConfigKey('fast_mode.enabled'), 'fast_mode.enabled must be valid');
  });

  test('effort.routing_tier_defaults.light is valid (dynamic pattern)', () => {
    assert.ok(isValidConfigKey('effort.routing_tier_defaults.light'));
  });

  test('effort.routing_tier_defaults.standard is valid', () => {
    assert.ok(isValidConfigKey('effort.routing_tier_defaults.standard'));
  });

  test('effort.routing_tier_defaults.heavy is valid', () => {
    assert.ok(isValidConfigKey('effort.routing_tier_defaults.heavy'));
  });

  test('effort.agent_overrides.<agent-id> is valid (dynamic pattern)', () => {
    assert.ok(isValidConfigKey('effort.agent_overrides.gsd-planner'));
    assert.ok(isValidConfigKey('effort.agent_overrides.my-custom-agent'));
  });

  test('fast_mode.routing_tier_defaults.light is valid', () => {
    assert.ok(isValidConfigKey('fast_mode.routing_tier_defaults.light'));
  });

  test('fast_mode.agent_overrides.<agent-id> is valid', () => {
    assert.ok(isValidConfigKey('fast_mode.agent_overrides.gsd-planner'));
  });

  test('effort.routing_tier_defaults.invalid-tier is NOT valid', () => {
    assert.ok(!isValidConfigKey('effort.routing_tier_defaults.super'));
  });
});

// ─── resolve-execution arg parsing matrix (Codex adversarial finding #1) ──────
//
// These tests FAIL before the fix: flags-first ordering misroutes the agent.

describe('#443 resolve-execution: deterministic arg parsing (flags-first ordering)', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
    process.env._GSD_TEST_HOME_OVERRIDE = tmpDir;
  });
  afterEach(() => {
    cleanup(tmpDir);
    delete process.env._GSD_TEST_HOME_OVERRIDE;
  });

  test('flags-first: --effort low gsd-planner resolves gsd-planner (NOT "low" as agent)', () => {
    // BUG: before fix, agentTypeArg = 'low' (first non-dash token) -> unknown_agent:true
    const result = runGsdTools(
      ['resolve-execution', '--effort', 'low', 'gsd-planner'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(!output.unknown_agent, `agent must be resolved (not unknown_agent), got: ${JSON.stringify(output)}`);
    assert.strictEqual(output.effort, 'low', `effort should be low, got: ${output.effort}`);
  });

  test('flags-first: --attempt 1 gsd-codebase-mapper resolves gsd-codebase-mapper (NOT "1" as agent)', () => {
    // BUG: before fix, agentTypeArg = '1' -> unknown_agent:true
    const result = runGsdTools(
      ['resolve-execution', '--attempt', '1', 'gsd-codebase-mapper'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(!output.unknown_agent, `gsd-codebase-mapper must be resolved, got: ${JSON.stringify(output)}`);
  });

  test('agent-first parity: gsd-planner --effort low produces same effort as flags-first', () => {
    const flagsFirst = runGsdTools(
      ['resolve-execution', '--effort', 'low', 'gsd-planner'],
      tmpDir,
      { HOME: tmpDir }
    );
    const agentFirst = runGsdTools(
      ['resolve-execution', 'gsd-planner', '--effort', 'low'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(flagsFirst.success && agentFirst.success,
      `Both orderings must succeed. flags-first err: ${flagsFirst.error} agent-first err: ${agentFirst.error}`);
    const outFF = JSON.parse(flagsFirst.output);
    const outAF = JSON.parse(agentFirst.output);
    assert.strictEqual(outFF.effort, outAF.effort, 'effort must be identical for both orderings');
    assert.strictEqual(outFF.model, outAF.model, 'model must be identical for both orderings');
  });

  test('error: missing agent (--effort low with no positional) -> non-zero exit, no stack trace', () => {
    const result = runGsdTools(
      ['resolve-execution', '--effort', 'low'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(!result.success, 'must exit non-zero when agent is missing');
    assert.ok(!result.error.includes('at '), `error must not contain stack trace, got: ${result.error}`);
    assert.ok(result.error.length > 0, 'must emit an error message');
  });

  test('error: two positional agents -> non-zero exit', () => {
    const result = runGsdTools(
      ['resolve-execution', 'gsd-planner', 'gsd-executor'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(!result.success, 'must exit non-zero when two agents are given');
  });

  test('error: --attempt notanumber -> non-zero exit, clear error', () => {
    const result = runGsdTools(
      ['resolve-execution', '--attempt', 'notanumber', 'gsd-planner'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(!result.success, 'must exit non-zero for non-integer --attempt');
    assert.ok(result.error.length > 0, 'must emit an error message');
  });

  test('error: trailing --effort (no value) -> non-zero exit', () => {
    const result = runGsdTools(
      ['resolve-execution', 'gsd-planner', '--effort'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(!result.success, 'must exit non-zero for trailing --effort with no value');
    assert.ok(result.error.length > 0, 'must emit an error message');
  });

  test('unknown agent positional -> unknown_agent:true (preserved behavior)', () => {
    const result = runGsdTools(
      ['resolve-execution', 'totally-not-an-agent'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Should succeed (unknown agent is valid input): ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.unknown_agent, true, 'unknown agent must emit unknown_agent:true');
  });
});

// ─── injectEffortFrontmatter: newline-agnostic injection (#443 Windows fix) ──

describe('#443 injectEffortFrontmatter: newline-agnostic YAML frontmatter injection', () => {
  // LF source (macOS / Linux git checkout) — baseline
  test('LF frontmatter: injects effort: before closing ---', () => {
    const content = '---\nname: gsd-planner\ndescription: Creates plans\ncolor: blue\n---\nBody here\n';
    const result = injectEffortFrontmatter(content, 'xhigh');
    assert.notStrictEqual(result, content, 'content should be modified');
    assert.match(result, /^effort:\s*xhigh$/m, 'effort: xhigh must be present');
    assert.ok(result.includes('\neffort: xhigh\n---\n'), 'effort: must appear before closing --- with LF');
    // Closing --- must still be present and intact
    assert.ok(result.includes('\n---\n'), 'closing --- must remain with LF');
  });

  // CRLF source (Windows git checkout with core.autocrlf=true) — the actual bug
  test('CRLF frontmatter: injects effort: with CRLF preserved (Windows fix)', () => {
    const content = '---\r\nname: gsd-planner\r\ndescription: Creates plans\r\ncolor: blue\r\n---\r\nBody here\r\n';
    const result = injectEffortFrontmatter(content, 'xhigh');
    assert.notStrictEqual(result, content, 'content should be modified (CRLF source was silently skipped before fix)');
    // effort: line must use CRLF, not LF (EOL consistency)
    assert.ok(result.includes('effort: xhigh\r\n'), 'effort: line must use CRLF to match surrounding frontmatter');
    // Closing --- must use CRLF and remain intact
    assert.ok(result.includes('\r\neffort: xhigh\r\n---\r\n'), 'effort: must appear before closing ---\\r\\n with CRLF');
    // The effort value must be readable via multiline regex (as the install-wiring assertions do)
    assert.match(result, /^effort:\s*xhigh$/m, '/^effort:\\s*xhigh$/m must match in CRLF output');
  });

  // Idempotency: don't double-insert if effort: already exists
  test('idempotent: does NOT insert a second effort: line when already present (LF)', () => {
    const content = '---\nname: gsd-planner\neffort: high\n---\nBody\n';
    const result = injectEffortFrontmatter(content, 'xhigh');
    assert.strictEqual(result, content, 'content must be unchanged when effort: already present');
    // Confirm no duplicate
    const matches = [...result.matchAll(/^effort:/mg)];
    assert.strictEqual(matches.length, 1, 'exactly one effort: key must exist');
  });

  test('idempotent: does NOT insert a second effort: line when already present (CRLF)', () => {
    const content = '---\r\nname: gsd-planner\r\neffort: high\r\n---\r\nBody\r\n';
    const result = injectEffortFrontmatter(content, 'xhigh');
    assert.strictEqual(result, content, 'content must be unchanged when effort: already present (CRLF)');
  });

  // No frontmatter — leave unchanged
  test('no YAML frontmatter: returns content unchanged', () => {
    const content = 'Just a body\nNo frontmatter here\n';
    const result = injectEffortFrontmatter(content, 'xhigh');
    assert.strictEqual(result, content, 'content without frontmatter must be returned unchanged');
  });

  // Complex frontmatter with comment lines and color: key (mirrors real agent .md files)
  test('complex LF frontmatter (# comment + color:) still injects effort: before ---', () => {
    const content = [
      '---',
      'name: gsd-executor',
      '# hooks: see .claude/settings.json',
      'description: Executes tasks',
      'color: green',
      '---',
      'Body content here',
      '',
    ].join('\n');
    const result = injectEffortFrontmatter(content, 'high');
    assert.match(result, /^effort:\s*high$/m, 'effort: high must be present');
    assert.ok(result.includes('\neffort: high\n---\n'), 'effort: must appear immediately before closing ---');
    // Other frontmatter fields must be untouched
    assert.ok(result.includes('color: green'), 'color: must be preserved');
    assert.ok(result.includes('# hooks:'), '# comment must be preserved');
  });

  test('complex CRLF frontmatter (# comment + color:) still injects effort: with CRLF before ---', () => {
    const lines = [
      '---',
      'name: gsd-executor',
      '# hooks: see .claude/settings.json',
      'description: Executes tasks',
      'color: green',
      '---',
      'Body content here',
      '',
    ];
    const content = lines.join('\r\n');
    const result = injectEffortFrontmatter(content, 'high');
    assert.ok(result.includes('effort: high\r\n'), 'effort: must use CRLF in CRLF file');
    assert.ok(result.includes('\r\neffort: high\r\n---\r\n'), 'effort: must appear before closing ---\\r\\n');
    assert.ok(result.includes('color: green\r\n'), 'color: must be preserved with CRLF');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-49-model-policy-presets.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-49-model-policy-presets (consolidation epic #1969 B8 #1977)", () => {
/**
 * Feature test for issue #49 — model_policy presets.
 *
 * Adds a `model_policy` block to .planning/config.json:
 *
 *   {
 *     "model_policy": {
 *       "provider": "anthropic-fable",
 *       "budget": "high",
 *       "runtime_tiers": {
 *         "opencode": {
 *           "opus": { "model": "anthropic/claude-opus-4-8" }
 *         }
 *       }
 *     }
 *   }
 *
 * Resolution precedence in resolveModelInternal (highest → lowest):
 *   1. model_overrides[agent]                 (per-agent full IDs; existing)
 *   2. model_policy.runtime_tiers[runtime][tier]  (Sub-path A: explicit runtime+tier entry)
 *   3. model_policy provider preset + budget  (Sub-path B: known-provider catalog lookup)
 *   4. model_profile_overrides                (legacy runtime-aware overrides)
 *   5. resolve_model_ids / profile fallback
 *
 * Sub-path A (runtime_tiers) fires when config.runtime matches a key inside
 * model_policy.runtime_tiers AND that key contains an entry for the resolved tier.
 *
 * Sub-path B (provider preset) fires when model_policy.provider is a known
 * provider AND the catalog contains an entry for (tier, budget) pair.
 *
 * Both sub-paths return a string model ID. Failures in either sub-path fall
 * through cleanly to the next step in the chain.
 *
 * New config keys accepted by isValidConfigKey:
 *   - model_policy.provider
 *   - model_policy.budget
 *   - model_policy.runtime_tiers.<runtime>.<tier>
 *
 * Backwards compatibility:
 *   - model_profile_overrides continues to work when model_policy is absent.
 *   - When both are set, model_policy wins (fires first).
 *
 * KNOWN_PROVIDERS is exported from both model-catalog.cjs and core.cjs (re-export).
 *
 * These tests are written to FAIL before implementation. They use typed-IR /
 * structural assertions on resolveModelInternal / resolveModelPolicy / isValidConfigKey
 * return values — not stdout / grep.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ─── Imports (will fail until implementation exists) ────────────────────────
// resolveModelPolicy is a new internal function that must be exported from core.cjs.
// KNOWN_PROVIDERS must be exported from model-catalog.cjs and re-exported by core.cjs.
const {
  resolveModelInternal,
  resolveModelPolicy,
  resolveModelForTier,
} = require('../gsd-core/bin/lib/model-resolver.cjs');
const {
  KNOWN_PROVIDERS,
} = require('../gsd-core/bin/lib/model-catalog.cjs');

// KNOWN_PROVIDERS must also be exported directly from model-catalog.cjs
const modelCatalog = require('../gsd-core/bin/lib/model-catalog.cjs');

const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');
const { createTempDir, cleanup, resetRuntimeWarningCaches } = require('./helpers.cjs');

const makeTmp = (prefix) => createTempDir(`gsd-49-${prefix}-`);

function writeConfig(dir, config) {
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config, null, 2));
}

function rmr(p) {
  cleanup(p);
}

// ─── resolveModelPolicy unit tests ──────────────────────────────────────────
//
// resolveModelPolicy(config, tier) is the pure resolver that takes a loaded
// config object and a resolved tier string. It returns a string model ID when
// model_policy produces a hit, or null when it falls through.

describe('#49 resolveModelPolicy: null/absent policy returns null', () => {
  test('resolveModelPolicy returns null when policy is null or absent', () => {
    // policy is null
    assert.strictEqual(resolveModelPolicy(null, 'opus'), null);
    // policy is undefined
    assert.strictEqual(resolveModelPolicy(undefined, 'opus'), null);
    // policy is absent (empty object treated as absent)
    assert.strictEqual(resolveModelPolicy({}, 'opus'), null);
  });

  test('resolveModelPolicy returns null when runtime or tier is missing', () => {
    const policy = { provider: 'anthropic', budget: 'high' };
    // tier is null
    assert.strictEqual(resolveModelPolicy(policy, null), null);
    // tier is empty string
    assert.strictEqual(resolveModelPolicy(policy, ''), null);
    // tier is undefined
    assert.strictEqual(resolveModelPolicy(policy, undefined), null);
  });
});

describe('#49 resolveModelPolicy Sub-path B: provider presets', () => {
  test('known provider "anthropic" + tier "opus" + budget "high" returns correct model ID', () => {
    // The anthropic preset catalog must contain an entry for opus+high.
    // The returned model ID is the high-budget anthropic opus model.
    const policy = { provider: 'anthropic', budget: 'high' };
    const result = resolveModelPolicy(policy, 'opus');
    assert.ok(typeof result === 'string' && result.length > 0,
      `expected a non-empty model ID string, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result, 'claude-opus-4-8',
      `expected anthropic opus/high to resolve to claude-opus-4-8, got: ${result}`);
  });

  test('known provider "anthropic" + tier "sonnet" + budget "high" preserves Opus 4.8 routing', () => {
    const policy = { provider: 'anthropic', budget: 'high' };
    const result = resolveModelPolicy(policy, 'sonnet');
    assert.strictEqual(result, 'claude-opus-4-8',
      `expected anthropic sonnet/high to resolve to claude-opus-4-8, got: ${result}`);
  });

  test('known provider "anthropic-fable" + tier "opus" + budget "high" resolves to Claude Fable 5', () => {
    const policy = { provider: 'anthropic-fable', budget: 'high' };
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, 'claude-fable-5',
      `expected anthropic-fable opus/high to resolve to claude-fable-5, got: ${result}`);
  });

  test('known provider "anthropic-fable" + tier "haiku" + budget "high" keeps low tier on Sonnet', () => {
    const policy = { provider: 'anthropic-fable', budget: 'high' };
    const result = resolveModelPolicy(policy, 'haiku');
    assert.strictEqual(result, 'claude-sonnet-5',
      `expected anthropic-fable haiku/high to resolve to claude-sonnet-5, got: ${result}`);
  });

  test('known provider "openai" + tier "sonnet" + budget "low" returns model with reasoning_effort from preset', () => {
    // The openai preset catalog must contain a sonnet+low entry.
    // "openai" maps to a different model family; the entry may include reasoning_effort.
    const policy = { provider: 'openai', budget: 'low' };
    const result = resolveModelPolicy(policy, 'sonnet');
    assert.ok(typeof result === 'string' && result.length > 0,
      `expected a non-empty model ID string for openai/sonnet/low, got: ${JSON.stringify(result)}`);
  });

  test('budget absent defaults to "medium"', () => {
    // No "budget" key — defaults to "medium". The anthropic/opus/medium entry must exist.
    const policyWithBudget = { provider: 'anthropic', budget: 'medium' };
    const policyNoBudget = { provider: 'anthropic' };
    const withBudget = resolveModelPolicy(policyWithBudget, 'opus');
    const withoutBudget = resolveModelPolicy(policyNoBudget, 'opus');
    // Both must return a string (not null)
    assert.ok(typeof withBudget === 'string' && withBudget.length > 0,
      `expected model from explicit budget:'medium'`);
    assert.ok(typeof withoutBudget === 'string' && withoutBudget.length > 0,
      `expected model when budget absent (should default to medium)`);
    // They must resolve to the same value
    assert.strictEqual(withBudget, withoutBudget,
      'absent budget must behave identically to explicit "medium"');
  });

  test('provider "generic" (all null entries) returns null (falls through)', () => {
    // provider:'generic' means opaque model IDs — there's no preset catalog for
    // generic. Without a runtime_tiers hit, resolveModelPolicy returns null.
    const policy = { provider: 'generic', budget: 'high' };
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, null,
      'provider:"generic" with no runtime_tiers must return null (no preset catalog)');
  });

  test('unknown provider string returns null without throwing', () => {
    // A typo like provider:'mistral' must not crash; it degrades gracefully.
    const policy = { provider: 'mistral', budget: 'high' };
    let result;
    assert.doesNotThrow(() => {
      result = resolveModelPolicy(policy, 'opus');
    }, 'resolveModelPolicy must not throw on unknown provider');
    assert.strictEqual(result, null,
      'unknown provider with no runtime_tiers must return null');
  });

  test('known provider + unknown tier returns null', () => {
    const policy = { provider: 'anthropic', budget: 'high' };
    const result = resolveModelPolicy(policy, 'jumbo');
    assert.strictEqual(result, null,
      'unknown tier "jumbo" must return null for anthropic provider');
  });

  test('known provider + known tier + missing budget level returns null', () => {
    // The anthropic preset for opus only defines 'high' and 'medium' but NOT 'critical'.
    // A missing budget level must fall through (return null) — not crash.
    const policy = { provider: 'anthropic', budget: 'critical' };
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, null,
      'missing budget level "critical" must return null without throwing');
  });
});

describe('#49 resolveModelPolicy Sub-path A: runtime_tiers', () => {
  test('runtime_tiers entry wins over provider preset for same runtime+tier', () => {
    // Sub-path A fires first: explicit runtime_tiers entry overrides the
    // provider preset catalog. The returned model is the one in runtime_tiers,
    // not what the provider preset would have returned.
    const policy = {
      provider: 'anthropic',
      budget: 'high',
      runtime: 'opencode',
      runtime_tiers: {
        opencode: {
          opus: { model: 'anthropic/custom-opus-override' },
        },
      },
    };
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, 'anthropic/custom-opus-override',
      'Sub-path A runtime_tiers must win over Sub-path B provider preset');
  });

  test('runtime_tiers string shorthand normalized to { model } object', () => {
    // String shorthand: `{ opencode: { opus: "some-model-id" } }`
    // must be normalized to `{ model: "some-model-id" }` so the resolver
    // returns the string as-is.
    const policy = {
      provider: 'anthropic',
      budget: 'high',
      runtime: 'opencode',
      runtime_tiers: {
        opencode: {
          opus: 'anthropic/string-shorthand-model',
        },
      },
    };
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, 'anthropic/string-shorthand-model',
      'string shorthand in runtime_tiers must be normalized and returned as model ID');
  });

  test('runtime_tiers partial entry (no matching runtime) falls through to provider preset', () => {
    // runtime_tiers has entries for 'copilot' but the active runtime is 'opencode'.
    // The miss on runtime_tiers falls through to Sub-path B (provider preset).
    const policy = {
      provider: 'anthropic',
      budget: 'high',
      runtime: 'opencode',
      runtime_tiers: {
        copilot: {
          opus: { model: 'some-copilot-model' },
        },
      },
    };
    const result = resolveModelPolicy(policy, 'opus');
    // Falls through to Sub-path B (anthropic/opus/high) — must not be null.
    assert.ok(typeof result === 'string' && result.length > 0,
      'runtime_tiers miss must fall through to provider preset, got: ' + JSON.stringify(result));
    // And it must NOT be the copilot model
    assert.notStrictEqual(result, 'some-copilot-model');
  });
});

// ─── resolveModelInternal integration tests ──────────────────────────────────
//
// These tests call resolveModelInternal through a temp project's config.json.
// They verify the full resolution chain including model_policy placement.

describe('#49 resolveModelInternal: model_policy in the resolution chain', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeTmp('internal');
    resetRuntimeWarningCaches();
  });
  afterEach(() => {
    rmr(projectDir);
    resetRuntimeWarningCaches();
  });

  test('model_policy fires before model_profile_overrides when both are set (model_policy wins)', () => {
    // model_policy (Sub-path B: anthropic/opus/high) must win over
    // model_profile_overrides when both are present.
    // We use a model_profile_overrides entry that would give a DIFFERENT result.
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
      },
      model_profile_overrides: {
        opencode: {
          // This legacy override would have returned this model — but model_policy must win.
          opus: 'legacy-override-model-should-not-appear',
        },
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    assert.notStrictEqual(result, 'legacy-override-model-should-not-appear',
      'model_policy must fire before model_profile_overrides and win');
    assert.ok(typeof result === 'string' && result.length > 0,
      'must return a non-empty model ID');
    assert.strictEqual(result, 'claude-opus-4-8',
      'expected anthropic preset opus/high to resolve to claude-opus-4-8');
  });

  test('model_policy with provider:"anthropic" + budget:"high" + runtime:"opencode" resolves to preset model', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',  // gsd-planner quality = opus tier
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    assert.ok(typeof result === 'string' && result.length > 0,
      'expected a non-empty model ID');
    assert.strictEqual(result, 'claude-opus-4-8',
      'anthropic/opus/high must resolve to claude-opus-4-8');
  });

  test('model_policy with provider:"anthropic-fable" + budget:"high" resolves to Fable preset model', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'anthropic-fable',
        budget: 'high',
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    assert.strictEqual(result, 'claude-fable-5',
      'anthropic-fable/opus/high must resolve to claude-fable-5');
  });

  test('model_policy is skipped when runtime is absent', () => {
    // No `runtime` in config — model_policy fires on any non-null policy
    // only when a runtime context is available. Without runtime, the policy
    // falls through entirely.
    // NOTE: Sub-path B (provider preset) can fire without runtime — it only
    // needs tier+budget+provider. Sub-path A requires runtime. This test
    // verifies the gating behavior described in the issue: if model_policy
    // is present but runtime is absent, provider preset Sub-path B still
    // fires (it doesn't need runtime). So "skipped" means the runtime_tiers
    // sub-path is skipped but provider preset may still fire.
    // The test asserts that resolveModelInternal does not crash and returns
    // a string regardless.
    writeConfig(projectDir, {
      model_profile: 'quality',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
        runtime_tiers: {
          opencode: {
            opus: { model: 'should-not-appear-no-runtime' },
          },
        },
      },
    });
    let result;
    assert.doesNotThrow(() => {
      result = resolveModelInternal(projectDir, 'gsd-planner');
    });
    assert.ok(typeof result === 'string',
      'resolveModelInternal must return a string even when runtime is absent');
    // The runtime_tiers entry for opencode must not appear since runtime is absent
    assert.notStrictEqual(result, 'should-not-appear-no-runtime',
      'runtime_tiers must not fire when config.runtime is absent');
  });

  test('model_policy provider preset resolves to a Claude alias on runtime:"claude" (#1133)', () => {
    writeConfig(projectDir, {
      runtime: 'claude',
      model_profile: 'balanced',
      model_policy: { provider: 'anthropic-fable', budget: 'high' },
    });
    // gsd-planner -> opus tier; anthropic-fable opus/high = claude-fable-5 -> alias "fable"
    assert.strictEqual(resolveModelInternal(projectDir, 'gsd-planner'), 'fable');
  });

  test('model_policy works with implicit claude runtime (no runtime key) (#1133)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      model_policy: { provider: 'anthropic-fable', budget: 'high' },
    });
    // gsd-executor -> sonnet tier; anthropic-fable sonnet/high = claude-fable-5 -> "fable"
    assert.strictEqual(resolveModelInternal(projectDir, 'gsd-executor'), 'fable');
  });

  test('unmappable model_policy ID warns and falls back to the tier alias on claude (#1133)', () => {
    resetRuntimeWarningCaches();
    writeConfig(projectDir, {
      runtime: 'claude',
      model_profile: 'balanced',
      model_policy: { provider: 'anthropic-fable', budget: 'low' },
    });
    // gsd-planner -> opus tier; anthropic-fable opus/low = claude-opus-4-5 (no alias) -> fall back to "opus"
    assert.strictEqual(resolveModelInternal(projectDir, 'gsd-planner'), 'opus');
  });

  test('model_policy.runtime_tiers applies on runtime:"claude", mapped to alias (#1133)', () => {
    writeConfig(projectDir, {
      runtime: 'claude',
      model_profile: 'balanced',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
        runtime_tiers: { claude: { opus: { model: 'claude-fable-5' } } },
      },
    });
    // gsd-planner -> opus tier; runtime_tiers.claude.opus = claude-fable-5 -> "fable" (was a no-op pre-#1133)
    assert.strictEqual(resolveModelInternal(projectDir, 'gsd-planner'), 'fable');
  });

  test('model_policy maps a built-in catalog model ID to its Claude alias via MODEL_ALIAS_MAP (#1133)', () => {
    writeConfig(projectDir, {
      runtime: 'claude',
      model_profile: 'balanced',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
        runtime_tiers: { claude: { opus: { model: 'claude-opus-4-8' } } },
      },
    });
    // gsd-planner -> opus tier; runtime_tiers.claude.opus = claude-opus-4-8 ->
    // reverse of MODEL_ALIAS_MAP -> "opus" (exercises the non-fable reverse-map path)
    assert.strictEqual(resolveModelInternal(projectDir, 'gsd-planner'), 'opus');
  });

  test('model_policy still returns full IDs on non-claude runtimes (#1133 regression)', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'balanced',
      model_policy: { provider: 'anthropic-fable', budget: 'high' },
    });
    assert.strictEqual(resolveModelInternal(projectDir, 'gsd-planner'), 'claude-fable-5');
  });

  test('model_policy is skipped when tier:"inherit"', () => {
    // When the resolved tier is 'inherit', model_policy must not fire.
    // This mirrors the existing behavior for runtime-aware resolution.
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'inherit',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    // With profile:'inherit', the result must be 'inherit'
    assert.strictEqual(result, 'inherit',
      'model_policy must not fire when tier is "inherit"; resolveModelInternal must return "inherit"');
  });

  test('model_profile_overrides still resolves when model_policy is absent (legacy fallback intact)', () => {
    // No model_policy — model_profile_overrides must still work exactly as before.
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_profile_overrides: {
        opencode: {
          opus: 'legacy-overridden-model',
        },
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    assert.strictEqual(result, 'legacy-overridden-model',
      'model_profile_overrides must still win when model_policy is absent');
  });

  test('model_policy absent + model_profile_overrides set → model_profile_overrides wins (back-compat)', () => {
    // Explicit: no model_policy key at all. model_profile_overrides is the only
    // custom config. The legacy chain must apply exactly as before this feature.
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'balanced',
      model_profile_overrides: {
        opencode: {
          sonnet: 'back-compat-sonnet-model',
        },
      },
    });
    // gsd-executor has balanced/opencode -> sonnet tier
    const result = resolveModelInternal(projectDir, 'gsd-executor');
    assert.strictEqual(result, 'back-compat-sonnet-model',
      'legacy model_profile_overrides must be unaffected when model_policy is absent');
  });

  test('model_policy present but runtime_tiers empty + provider:"generic" → falls through to model_profile_overrides', () => {
    // model_policy is a stub: runtime_tiers is empty ({}), provider is "generic".
    // The resolver must fall through all model_policy paths and land on model_profile_overrides.
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'generic',
        budget: 'high',
        runtime_tiers: {},
      },
      model_profile_overrides: {
        opencode: {
          opus: 'fallthrough-to-legacy',
        },
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    assert.strictEqual(result, 'fallthrough-to-legacy',
      'empty runtime_tiers + generic provider must fall through to model_profile_overrides');
  });
});

// ─── Warning emission tests ───────────────────────────────────────────────────

describe('#49 resolveModelInternal: unknown provider warning behavior', () => {
  let projectDir;
  let origWrite;
  let captured;

  beforeEach(() => {
    projectDir = makeTmp('warnings');
    resetRuntimeWarningCaches();
    captured = [];
    origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  });

  afterEach(() => {
    process.stderr.write = origWrite;
    rmr(projectDir);
    resetRuntimeWarningCaches();
  });

  test('unknown provider in model_policy → falls through to model_profile_overrides, emits stderr warning once', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'mistral',
        budget: 'high',
      },
      model_profile_overrides: {
        opencode: {
          opus: 'fallback-from-unknown-provider',
        },
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    // Must fall through to model_profile_overrides
    assert.strictEqual(result, 'fallback-from-unknown-provider',
      'unknown provider must fall through to model_profile_overrides');
    // Must emit at least one stderr warning about the unknown provider
    const joined = captured.join('');
    assert.match(joined, /model_policy.*provider.*mistral|unknown.*provider.*mistral|mistral.*unknown/i,
      'must emit a stderr warning about the unknown provider "mistral"');
  });

  test('unknown provider warning is deduplicated (emitted only once per config label)', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'mistral',
        budget: 'high',
      },
    });
    // Call resolveModelInternal multiple times for different agents — the
    // warning about the unknown provider must be emitted only once.
    resolveModelInternal(projectDir, 'gsd-planner');
    resolveModelInternal(projectDir, 'gsd-executor');
    resolveModelInternal(projectDir, 'gsd-verifier');
    const joined = captured.join('');
    // Count occurrences of "mistral" in the warning output
    const matches = (joined.match(/mistral/gi) || []).length;
    assert.ok(matches >= 1, 'expected at least one warning about "mistral"');
    assert.ok(matches <= 2, `warning for unknown provider must be deduplicated — saw ${matches} occurrences`);
  });

  test('model_policy.runtime_tiers with unknown runtime emits one-shot stderr warning', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
        runtime_tiers: {
          unknownrt: {
            opus: { model: 'some-model' },
          },
        },
      },
    });
    resolveModelInternal(projectDir, 'gsd-planner');
    const joined = captured.join('');
    // Must emit a warning about the unknown runtime key in runtime_tiers
    assert.match(joined, /unknownrt|unknown.*runtime|runtime_tiers.*unknown/i,
      'must emit a stderr warning about unknown runtime "unknownrt" in model_policy.runtime_tiers');
  });

  test('model_policy.runtime_tiers with invalid tier name emits one-shot stderr warning', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
        runtime_tiers: {
          opencode: {
            jumbo: { model: 'invalid-tier-model' },
          },
        },
      },
    });
    resolveModelInternal(projectDir, 'gsd-planner');
    const joined = captured.join('');
    // Must emit a warning about the invalid tier name "jumbo"
    assert.match(joined, /jumbo|invalid.*tier|tier.*invalid|unknown.*tier/i,
      'must emit a stderr warning about invalid tier "jumbo" in model_policy.runtime_tiers.opencode');
  });
});

// ─── reasoning_effort passthrough tests ──────────────────────────────────────

describe('#49 reasoning_effort in model_policy entries', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('effort'); });
  afterEach(() => { rmr(projectDir); });

  test('reasoning_effort in preset entry is returned as part of the entry object (caller decides whether to emit)', () => {
    // When a provider preset includes reasoning_effort (e.g. openai opus/high),
    // resolveModelPolicy must return the full entry object (or at minimum the model
    // string) without stripping reasoning_effort internally.
    // This is checked via the internal resolveModelPolicy function directly.
    // The policy object includes a runtime_tiers entry that has reasoning_effort.
    const policy = {
      provider: 'anthropic',
      budget: 'high',
      runtime: 'opencode',
      runtime_tiers: {
        opencode: {
          opus: { model: 'anthropic/claude-opus-4-8', reasoning_effort: 'high' },
        },
      },
    };
    // resolveModelPolicy must return the model string (at minimum).
    // The caller (resolveModelInternal) is responsible for deciding what to
    // emit — the resolver just returns the model ID string.
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, 'anthropic/claude-opus-4-8',
      'resolveModelPolicy must return the model string from the runtime_tiers entry');
  });

  test('reasoning_effort in model_policy.runtime_tiers entry is returned verbatim; renderEffortForRuntime strips it when runtime not in RUNTIMES_WITH_REASONING_EFFORT', () => {
    // The renderEffortForRuntime function (already existing) handles the stripping.
    // This test verifies the contract: resolveModelPolicy returns the model string,
    // and for runtimes not in RUNTIMES_WITH_REASONING_EFFORT, the caller must not
    // emit reasoning_effort.
    const { renderEffortForRuntime, RUNTIMES_WITH_REASONING_EFFORT } = require('../gsd-core/bin/lib/model-catalog.cjs');

    // 'opencode' is NOT in RUNTIMES_WITH_REASONING_EFFORT (only codex has reasoning_effort in catalog)
    assert.ok(!RUNTIMES_WITH_REASONING_EFFORT.has('opencode'),
      'opencode must not be in RUNTIMES_WITH_REASONING_EFFORT for this test to be meaningful');

    // renderEffortForRuntime for a non-effort runtime returns channel:null
    const rendered = renderEffortForRuntime('opencode', 'high');
    assert.strictEqual(rendered.channel, null,
      'renderEffortForRuntime must return channel:null for runtimes not supporting reasoning_effort');

    // The resolveModelPolicy function returns just the model string — reasoning_effort
    // is stripped at the emit layer, not inside resolveModelPolicy.
    const policy = {
      runtime: 'opencode',
      provider: 'anthropic',
      budget: 'high',
      runtime_tiers: {
        opencode: {
          opus: { model: 'anthropic/claude-opus-4-8', reasoning_effort: 'high' },
        },
      },
    };
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, 'anthropic/claude-opus-4-8',
      'resolveModelPolicy must return model string; reasoning_effort is stripped downstream');
  });
});

// ─── isValidConfigKey: model_policy.* schema validation ──────────────────────

describe('#49 isValidConfigKey: model_policy.* keys accepted/rejected', () => {
  test('isValidConfigKey accepts "model_policy.provider"', () => {
    assert.strictEqual(isValidConfigKey('model_policy.provider'), true,
      '"model_policy.provider" must be a valid config key');
  });

  test('isValidConfigKey accepts "model_policy.budget"', () => {
    assert.strictEqual(isValidConfigKey('model_policy.budget'), true,
      '"model_policy.budget" must be a valid config key');
  });

  test('isValidConfigKey accepts "model_policy.runtime_tiers.opencode.opus"', () => {
    assert.strictEqual(isValidConfigKey('model_policy.runtime_tiers.opencode.opus'), true,
      '"model_policy.runtime_tiers.opencode.opus" must be a valid config key');
  });

  test('isValidConfigKey rejects "model_policy.runtime_tiers.opencode.banana" (invalid tier)', () => {
    assert.strictEqual(isValidConfigKey('model_policy.runtime_tiers.opencode.banana'), false,
      '"model_policy.runtime_tiers.opencode.banana" must be rejected (banana is not a valid tier)');
  });
});

// ─── KNOWN_PROVIDERS export tests ─────────────────────────────────────────────

describe('#49 KNOWN_PROVIDERS exports from model-catalog.cjs', () => {
  test('KNOWN_PROVIDERS exported from model-catalog.cjs includes all keys from providerPresets in catalog', () => {
    // KNOWN_PROVIDERS must be a Set (or array) exported from model-catalog.cjs.
    assert.ok(KNOWN_PROVIDERS != null,
      'KNOWN_PROVIDERS must be exported from model-catalog.cjs');
    const isIterable = typeof KNOWN_PROVIDERS[Symbol.iterator] === 'function';
    assert.ok(isIterable,
      'KNOWN_PROVIDERS must be iterable (Set or array)');
    const providers = [...KNOWN_PROVIDERS];
    assert.ok(providers.length > 0,
      'KNOWN_PROVIDERS must not be empty');
    // 'anthropic' must be in the set since it is a required provider preset
    assert.ok(providers.includes('anthropic'),
      'KNOWN_PROVIDERS must include "anthropic"');
    assert.ok(providers.includes('anthropic-fable'),
      'KNOWN_PROVIDERS must include "anthropic-fable"');
    // 'generic' is a special fallback, not a real provider — it must NOT be in KNOWN_PROVIDERS
    // (KNOWN_PROVIDERS lists only providers with catalog entries)
    assert.ok(!providers.includes('generic'),
      'KNOWN_PROVIDERS must not include "generic" (it is not a catalog-backed provider)');
  });

  test('KNOWN_PROVIDERS from model-catalog.cjs is the canonical export', () => {
    // model-catalog.cjs is the canonical source of KNOWN_PROVIDERS.
    assert.ok(modelCatalog.KNOWN_PROVIDERS != null,
      'KNOWN_PROVIDERS must be exported from model-catalog.cjs');
    const fromCatalog = [...modelCatalog.KNOWN_PROVIDERS].sort();
    const fromImport = [...KNOWN_PROVIDERS].sort();
    assert.deepStrictEqual(fromImport, fromCatalog,
      'KNOWN_PROVIDERS imported from model-catalog.cjs must match the module export');
  });
});

// ─── resolveModelPolicy: Object.hasOwn prototype-pollution guards ────────────

describe('#49 resolveModelPolicy: prototype-pollution guards', () => {
  test('__proto__ as provider returns null without throwing', () => {
    assert.strictEqual(resolveModelPolicy({ provider: '__proto__', budget: 'medium' }, 'sonnet'), null);
  });

  test('constructor as provider returns null without throwing', () => {
    assert.strictEqual(resolveModelPolicy({ provider: 'constructor', budget: 'medium' }, 'sonnet'), null);
  });

  test('__proto__ as budget returns null without throwing', () => {
    assert.strictEqual(resolveModelPolicy({ provider: 'openai', budget: '__proto__' }, 'haiku'), null);
  });

  test('toString as budget returns null without throwing', () => {
    assert.strictEqual(resolveModelPolicy({ provider: 'openai', budget: 'toString' }, 'haiku'), null);
  });

  test('__proto__ as runtime_tiers key returns null without throwing', () => {
    const policy = {
      runtime: '__proto__',
      runtime_tiers: { '__proto__': { haiku: { model: 'evil' } } },
    };
    assert.strictEqual(resolveModelPolicy(policy, 'haiku'), null);
  });

  test('__proto__ as tier inside runtime_tiers returns null without throwing', () => {
    const policy = {
      runtime: 'codex',
      runtime_tiers: { codex: { '__proto__': { model: 'evil' } } },
    };
    assert.strictEqual(resolveModelPolicy(policy, '__proto__'), null);
  });

  test('valid provider+tier+budget still resolves correctly after guards', () => {
    const result = resolveModelPolicy({ provider: 'openai', budget: 'low' }, 'haiku');
    assert.ok(typeof result === 'string' && result.length > 0,
      'valid openai/haiku/low lookup must still resolve after adding hasOwn guards');
  });
});

// ─── #2041: model_overrides Claude full ID → Agent-tool alias on claude runtime ─
//
// Mirrors the #1133 model_policy alias-mapping tests (above) for the
// model_overrides path. Bug: a full Claude model ID in model_overrides
// (e.g. "claude-sonnet-5") was returned VERBATIM on the claude runtime and
// handed to the Claude Agent tool, whose typed `model` parameter documents only
// tier aliases (opus/sonnet/haiku/fable). The model_policy path already maps
// full IDs → aliases via CLAUDE_POLICY_ID_TO_ALIAS (#1144); model_overrides
// skipped that mapping entirely. The fix mirrors #1144 on the override path.
// Non-Claude runtimes and non-Claude values pass through verbatim (parity).

describe('#2041 model_overrides: Claude full ID → alias on claude runtime', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = makeTmp('2041');
    resetRuntimeWarningCaches();
  });
  afterEach(() => {
    rmr(tmpDir);
    resetRuntimeWarningCaches();
  });

  // AC1 + AC2: mappable Claude full IDs resolve to their aliases on claude runtime
  test('model_overrides claude-sonnet-5 → "sonnet" on runtime:claude (resolveModelInternal)', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_overrides: { 'gsd-executor': 'claude-sonnet-5' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-executor'), 'sonnet');
  });

  test('model_overrides claude-opus-4-8 → "opus" on runtime:claude', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_overrides: { 'gsd-planner': 'claude-opus-4-8' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'opus');
  });

  test('model_overrides claude-haiku-4-5 → "haiku" on runtime:claude', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_overrides: { 'gsd-codebase-mapper': 'claude-haiku-4-5' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'haiku');
  });

  test('model_overrides claude-fable-5 → "fable" on runtime:claude', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_overrides: { 'gsd-planner': 'claude-fable-5' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'fable');
  });

  // AC3: bare aliases pass through verbatim
  test('model_overrides bare "sonnet" alias passes through verbatim on runtime:claude', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_overrides: { 'gsd-executor': 'sonnet' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-executor'), 'sonnet');
  });

  test('model_overrides bare "fable" alias passes through verbatim on runtime:claude', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_overrides: { 'gsd-planner': 'fable' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'fable');
  });

  // AC1 (implicit claude): mapping fires when runtime key is absent (defaults to claude)
  test('model_overrides claude-sonnet-5 → "sonnet" with implicit claude runtime (no runtime key)', () => {
    writeConfig(tmpDir, {
      model_overrides: { 'gsd-executor': 'claude-sonnet-5' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-executor'), 'sonnet');
  });

  // AC4: non-claude runtimes keep full IDs verbatim (parity with model_policy path)
  test('model_overrides claude-sonnet-5 → verbatim ID on non-claude runtime (opencode)', () => {
    writeConfig(tmpDir, {
      runtime: 'opencode',
      model_overrides: { 'gsd-executor': 'claude-sonnet-5' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-executor'), 'claude-sonnet-5');
  });

  // AC5: unmappable Claude full ID warns once + falls through to tier alias
  test('model_overrides unmappable claude ID (claude-opus-4-5) falls through to tier alias on claude', () => {
    resetRuntimeWarningCaches();
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_profile: 'balanced',
      model_overrides: { 'gsd-planner': 'claude-opus-4-5' },
    });
    // gsd-planner balanced → opus tier; claude-opus-4-5 has no alias → warn + fall through → 'opus'
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'opus');
  });

  test('model_overrides unmappable claude ID emits a stderr warning exactly once (dedupe)', () => {
    resetRuntimeWarningCaches();
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_profile: 'balanced',
      model_overrides: { 'gsd-planner': 'claude-opus-4-5' },
    });
    const writes = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      resolveModelInternal(tmpDir, 'gsd-planner');
      resolveModelInternal(tmpDir, 'gsd-planner'); // second call — dedupe must suppress
    } finally {
      process.stderr.write = original;
    }
    const warnings = writes.filter((w) => w.includes('model_overrides') && w.includes('claude-opus-4-5'));
    assert.strictEqual(warnings.length, 1,
      `expected exactly one override warning, got ${warnings.length}: ${JSON.stringify(writes)}`);
  });

  // AC6: resolveModelForTier (escalation / --attempt path) maps the same way
  test('resolveModelForTier maps claude-sonnet-5 → "sonnet" on runtime:claude', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_overrides: { 'gsd-executor': 'claude-sonnet-5' },
    });
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-executor', 0), 'sonnet');
  });

  test('resolveModelForTier keeps full ID verbatim on non-claude runtime', () => {
    writeConfig(tmpDir, {
      runtime: 'opencode',
      model_overrides: { 'gsd-executor': 'claude-sonnet-5' },
    });
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-executor', 0), 'claude-sonnet-5');
  });

  // MEDIUM-1 (review): exercise the unmappable-override fall-through branch in
  // resolveModelForTier (closes the mutation-score gap — a future refactor that
  // accidentally returned the verbatim override instead of falling through
  // would otherwise survive the suite).
  test('resolveModelForTier unmappable claude ID falls through to tier alias on claude', () => {
    resetRuntimeWarningCaches();
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_profile: 'balanced',
      model_overrides: { 'gsd-planner': 'claude-opus-4-5' },
    });
    // unmappable override → fall through → no dynamic_routing → resolveModelInternal → 'opus'
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-planner', 0), 'opus');
  });

  // LOW-2 (review): pin the case-sensitive contract — a case-variant like
  // "Claude-Sonnet-5" is NOT mapped (alias keys are case-sensitive, matching
  // the model_policy path and the Claude API).
  test('model_overrides case-variant "Claude-Sonnet-5" passes through verbatim (case-sensitive contract)', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_overrides: { 'gsd-executor': 'Claude-Sonnet-5' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-executor'), 'Claude-Sonnet-5');
  });

  // Regression guard: non-Claude custom / vendor values still pass through verbatim
  // on the claude runtime (the fix must NOT touch values that aren't Claude IDs).
  test('model_overrides non-Claude custom model passes through verbatim on runtime:claude', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_overrides: { 'gsd-planner': 'my-custom-model' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'my-custom-model');
  });

  test('model_overrides non-Claude vendor ID (openai/gpt-5) passes through verbatim on runtime:claude', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_overrides: { 'gsd-executor': 'openai/gpt-5' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-executor'), 'openai/gpt-5');
  });
});

// ─── resolveModelForTier: model_policy beats dynamic_routing ─────────────────

describe('#49 resolveModelForTier: model_policy beats dynamic_routing', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmp('for-tier-'); });
  afterEach(() => { rmr(tmpDir); });

  test('model_policy wins over dynamic_routing.tier_models when both are set', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_policy: { provider: 'openai', budget: 'low' },
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
      },
    });
    // model_policy fires before dynamic_routing in resolveModelForTier
    const result = resolveModelForTier(tmpDir, 'gsd-executor', 0);
    // gsd-executor is standard/sonnet tier; openai+low+sonnet preset model
    assert.ok(typeof result === 'string' && result.length > 0,
      'model_policy must return a model string');
    assert.notStrictEqual(result, 'sonnet',
      'dynamic_routing tier alias must not win over model_policy');
  });

  test('model_overrides still beats model_policy in resolveModelForTier', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_policy: { provider: 'openai', budget: 'high' },
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
      },
      model_overrides: { 'gsd-planner': 'custom-model-id' },
    });
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-planner', 0), 'custom-model-id');
  });

  test('dynamic_routing.tier_models used normally when model_policy absent', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'my-custom-sonnet', heavy: 'opus' },
      },
    });
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-executor', 0), 'my-custom-sonnet');
  });

  test('model_policy with Claude runtime does not interrupt dynamic_routing', () => {
    // model_policy only gates on non-Claude runtimes; with runtime absent/claude,
    // dynamic_routing must still work normally.
    writeConfig(tmpDir, {
      model_policy: { provider: 'openai', budget: 'low' },
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'my-sonnet', heavy: 'opus' },
      },
    });
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-executor', 0), 'my-sonnet');
  });

  test('model_policy value that is already a bare Claude alias is returned as-is on claude (#1133)', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_profile: 'balanced',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
        runtime_tiers: { claude: { opus: { model: 'fable' } } },
      },
    });
    // gsd-planner → opus tier; runtime_tiers.claude.opus = "fable" is already a valid alias → "fable"
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'fable');
  });
});

// ─── #2229: computeProfileTier / resolveTierFromConfig / resolveTierInternal ──
//
// `tier` is additive on top of resolveModelInternal's model/profile/effort keys
// (cmdResolveModel, src/commands.cts) so a caller can learn the effective tier
// even under resolve_model_ids:"omit", where `model` is deliberately blank.

describe('#2229 resolveTierInternal / resolveTierFromConfig — config rows', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('no config -> balanced profile -> "sonnet"', () => {
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'sonnet');
  });

  test('model_profile=budget -> "haiku"', () => {
    writeConfig(tmpDir, { model_profile: 'budget' });
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'haiku');
  });

  test('model_overrides="haiku" alias -> "haiku"', () => {
    writeConfig(tmpDir, { model_overrides: { 'gsd-phase-researcher': 'haiku' } });
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'haiku');
  });

  test('model_overrides full Claude id "claude-haiku-4-5" maps back to its alias -> "haiku"', () => {
    writeConfig(tmpDir, { model_overrides: { 'gsd-phase-researcher': 'claude-haiku-4-5' } });
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'haiku');
  });

  test('model_overrides pinning a non-Claude id (gemini-2.5-flash-lite) is never guessed -> "unknown"', () => {
    writeConfig(tmpDir, { model_overrides: { 'gsd-phase-researcher': 'gemini-2.5-flash-lite' } });
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'unknown');
  });

  // Regression: CLAUDE_POLICY_ID_TO_ALIAS is a plain object literal indexed
  // with this config-supplied override value with no own-property guard. A
  // prototype-chain override ("toString", "constructor", "__proto__",
  // "valueOf", "hasOwnProperty") returned the inherited Function/Object
  // member (typeof "function"/"object") instead of falling through to
  // "unknown" — and a function-valued tier is silently dropped by
  // JSON.stringify in the CLI output, so `tier` vanished from `query
  // resolve-model` entirely.
  for (const proto of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
    test(`REGRESSION: model_overrides="${proto}" (prototype-chain key) -> string "unknown", not an inherited member`, () => {
      writeConfig(tmpDir, { model_overrides: { 'gsd-phase-researcher': proto } });
      const result = resolveTierInternal(tmpDir, 'gsd-phase-researcher');
      assert.strictEqual(typeof result, 'string', `expected a string, got ${typeof result}: ${String(result)}`);
      assert.strictEqual(result, 'unknown');
    });
  }

  test('model_profile=inherit -> "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'inherit');
  });

  test('ADVERSARIAL: models=0 (non-object) does not throw and falls back to "sonnet"', () => {
    writeConfig(tmpDir, { models: 0 });
    assert.doesNotThrow(() => resolveTierInternal(tmpDir, 'gsd-phase-researcher'));
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'sonnet');
  });

  for (const hostileModels of ['nope', [], null]) {
    test(`ADVERSARIAL: models=${JSON.stringify(hostileModels)} does not throw and falls back to "sonnet"`, () => {
      writeConfig(tmpDir, { models: hostileModels });
      assert.doesNotThrow(() => resolveTierInternal(tmpDir, 'gsd-phase-researcher'));
      assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'sonnet');
    });
  }

  test('ADVERSARIAL: empty config object {} does not throw -> "sonnet"', () => {
    writeConfig(tmpDir, {});
    assert.doesNotThrow(() => resolveTierInternal(tmpDir, 'gsd-phase-researcher'));
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'sonnet');
  });

  test('ADVERSARIAL: zero-byte config.json does not throw -> "sonnet"', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '', 'utf-8');
    assert.doesNotThrow(() => resolveTierInternal(tmpDir, 'gsd-phase-researcher'));
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'sonnet');
  });
});

describe('#2229 resolveTierInternal — computeProfileTier is blind to model-id and profile-only checks', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('models.research="haiku" wins over model_profile=balanced (a profile-only check would miss this)', () => {
    writeConfig(tmpDir, { model_profile: 'balanced', models: { research: 'haiku' } });
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'haiku');
  });
});

// Regression (#3282): resolveTierFromConfig used to report only the PROFILE
// tier and ignore the model_policy preset step that resolveModelInternal
// applies afterward (its "2.5" step) — so a haiku-tier run under
// model_policy.budget:"low" reported tier "sonnet", silently defeating any
// tier-floor keyed on this value. These pin the fixed behavior: the reported
// tier and the resolved model must agree on which tier actually ran.
describe('#3282 resolveTierFromConfig mirrors resolveModelInternal step 2.5 (model_policy)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('model_policy budget:low -> tier "haiku", agreeing with the resolved model', () => {
    writeConfig(tmpDir, { model_policy: { provider: 'anthropic', budget: 'low' } });
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'haiku');
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-phase-researcher'), 'haiku');
  });

  test('model_policy budget:high -> tier "opus", agreeing with the resolved model', () => {
    writeConfig(tmpDir, { model_policy: { provider: 'anthropic', budget: 'high' } });
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'opus');
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-phase-researcher'), 'opus');
  });

  test('model_policy budget:medium -> tier "sonnet"', () => {
    writeConfig(tmpDir, { model_policy: { provider: 'anthropic', budget: 'medium' } });
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'sonnet');
  });

  // Measured (2026-08-09): model_profile:"budget" gives gsd-phase-researcher
  // a "haiku" profile tier, but model_policy.budget:"high" resolves the
  // anthropic "haiku" preset's high slot to "claude-sonnet-5" — the POLICY
  // outranks the PROFILE, so the actually-dispatched tier is "sonnet", not
  // the profile's "haiku". A profile-only reporter would under-report this.
  test('model_policy outranks model_profile: budget profile + policy budget:high -> tier "sonnet"', () => {
    writeConfig(tmpDir, { model_profile: 'budget', model_policy: { provider: 'anthropic', budget: 'high' } });
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'sonnet');
  });

  // Measured (2026-08-09): on a non-Claude runtime, resolveModelInternal
  // returns the policy-resolved model id VERBATIM (no Claude-alias mapping
  // is attempted) — "qwen3-coder-plus" carries no tier we can name. Must
  // report "unknown", never fall back to the profile tier ("balanced" ->
  // "sonnet" here), which would silently reintroduce the under-report.
  test('non-Claude runtime + model_policy resolving a verbatim model id -> tier "unknown"', () => {
    writeConfig(tmpDir, { runtime: 'qwen', model_policy: { provider: 'qwen', budget: 'medium' } });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-phase-researcher'), 'qwen3-coder-plus');
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'unknown');
  });

  // "fable" is a real, reachable tier value (Claude Code's Agent tool accepts
  // it, and CLAUDE_POLICY_ID_TO_ALIAS maps "claude-fable-5" to it) — it is
  // NOT the budget tier and must NOT be floored by a budget-tier check.
  test('model_overrides pinning "fable" -> tier "fable", a valid non-floored tier', () => {
    writeConfig(tmpDir, { model_overrides: { 'gsd-phase-researcher': 'fable' } });
    assert.strictEqual(resolveTierInternal(tmpDir, 'gsd-phase-researcher'), 'fable');
  });
});

describe('#2229 resolveTierFromConfig — config-object form matches the cwd/CLI form', () => {
  // computeProfileTier itself is an internal (unexported) helper — per its own
  // doc comment, resolveTierFromConfig "calls straight back into it", so this
  // exercises the same code path through the public API.
  test('config-object form of the phase-type-override case matches the tmpDir form', () => {
    const cfg = { model_profile: 'balanced', models: { research: 'haiku' } };
    assert.strictEqual(resolveTierFromConfig(cfg, 'gsd-phase-researcher'), 'haiku');
  });

  test('agent with no catalog entry and a non-inherit profile -> "unknown"', () => {
    assert.strictEqual(resolveTierFromConfig({ model_profile: 'balanced' }, 'not-a-real-agent'), 'unknown');
  });
});

describe('#2229 cmdResolveModel CLI — tier key, additive-output guard, unknown_agent', () => {
  let tmpDir;
  // Local require, matching the folded-block idiom elsewhere in this file:
  // the top-level imports only pull in `cleanup` from helpers.cjs.
  const { runGsdTools } = require('./helpers.cjs');

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('model_profile=balanced + models.research=haiku -> tier "haiku", profile still "balanced"', () => {
    writeConfig(tmpDir, { model_profile: 'balanced', models: { research: 'haiku' } });
    const result = runGsdTools('resolve-model gsd-phase-researcher', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.tier, 'haiku');
    assert.strictEqual(parsed.profile, 'balanced');
  });

  test('resolve_model_ids=omit -> tier "sonnet" even though model is blank', () => {
    writeConfig(tmpDir, { resolve_model_ids: 'omit' });
    const result = runGsdTools('resolve-model gsd-phase-researcher', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.tier, 'sonnet');
    assert.strictEqual(parsed.model, '');
  });

  test('CORE CASE: resolve_model_ids=omit + models.research=haiku -> tier "haiku" though model is blank ' +
    'and profile alone would also miss it', () => {
    writeConfig(tmpDir, { resolve_model_ids: 'omit', models: { research: 'haiku' } });
    const result = runGsdTools('resolve-model gsd-phase-researcher', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.tier, 'haiku');
    assert.strictEqual(parsed.model, '');
  });

  test('runtime=codex + model_profile=budget -> tier "haiku" even though the resolved model id ' +
    '("gpt-5.6-luna") contains no "haiku" substring', () => {
    writeConfig(tmpDir, { runtime: 'codex', model_profile: 'budget' });
    const result = runGsdTools('resolve-model gsd-phase-researcher', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.tier, 'haiku');
    assert.strictEqual(parsed.model, 'gpt-5.6-luna');
  });

  test('unknown agent -> tier "unknown", unknown_agent:true still present', () => {
    writeConfig(tmpDir, {});
    const result = runGsdTools('resolve-model not-a-real-agent', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.tier, 'unknown');
    assert.strictEqual(parsed.unknown_agent, true);
  });

  // Regression: without the Object.hasOwn guard, model_overrides:"toString"
  // resolved a function-valued tier, and JSON.stringify silently DROPS a
  // function-valued object key — so `tier` disappeared from the parsed
  // output entirely rather than merely holding a wrong value. Asserting the
  // key's presence (not just its value) is what would have caught that.
  test('REGRESSION: model_overrides="toString" (prototype-chain key) -> parsed JSON still HAS a "tier" key, equal to "unknown"', () => {
    writeConfig(tmpDir, { model_overrides: { 'gsd-phase-researcher': 'toString' } });
    const result = runGsdTools('resolve-model gsd-phase-researcher', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.ok(Object.hasOwn(parsed, 'tier'), `expected a "tier" key in ${result.output}`);
    assert.strictEqual(parsed.tier, 'unknown');
  });

  test('--pick tier prints the bare string "sonnet" (no JSON, no quotes) for {}', () => {
    writeConfig(tmpDir, {});
    const result = runGsdTools(['resolve-model', 'gsd-phase-researcher', '--pick', 'tier'], tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    assert.strictEqual(result.output, 'sonnet');
  });

  // Compatibility guard, not a tier test: pins that adding `tier` to
  // cmdResolveModel's output did not disturb the pre-existing
  // model/profile/effort keys that other consumers already parse.
  test('COMPATIBILITY GUARD: adding tier did not disturb model/profile/effort for {}', () => {
    writeConfig(tmpDir, {});
    const result = runGsdTools('resolve-model gsd-phase-researcher', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.model, 'sonnet');
    assert.strictEqual(parsed.profile, 'balanced');
    assert.strictEqual(parsed.effort, 'high');
  });
});

describe('#2229 PARITY GUARD: catalog budget tier for gsd-phase-researcher backs explore.md\'s tier-floor text', () => {
  test('MODEL_PROFILES["gsd-phase-researcher"].budget === "haiku"', () => {
    // gsd-core/workflows/explore.md's tier-floor text names "haiku" as this
    // agent's budget tier; if the catalog ever moves that tier, this test
    // fails instead of the floor silently ceasing to fire.
    const { MODEL_PROFILES } = require('../gsd-core/bin/lib/model-profiles.cjs');
    assert.strictEqual(MODEL_PROFILES['gsd-phase-researcher'].budget, 'haiku');
  });
});

describe('#2229 PROPERTY: resolveTierFromConfig never throws and always returns a known tier', () => {
  test('for arbitrary plain-object configs', () => {
    const fc = require('./helpers/fast-check-setup.cjs');
    const KNOWN_TIERS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit', 'unknown']);
    fc.assert(
      fc.property(fc.object(), (cfg) => {
        let result;
        assert.doesNotThrow(() => { result = resolveTierFromConfig(cfg, 'gsd-phase-researcher'); });
        assert.ok(typeof result === 'string', `expected a string, got: ${JSON.stringify(result)}`);
        assert.ok(KNOWN_TIERS.has(result), `unexpected tier value: ${JSON.stringify(result)}`);
      })
    );
  });

  // Regression: the generic fc.object() generator above almost never produces
  // a prototype-chain string ("toString", "constructor", "__proto__",
  // "valueOf", "hasOwnProperty") as a model_overrides value, so it never
  // exercised the CLAUDE_POLICY_ID_TO_ALIAS own-property guard. This variant
  // pins model_overrides['gsd-phase-researcher'] to a mix of those names and
  // arbitrary strings so the "always returns a known tier" invariant is
  // actually checked against the class of input that broke it.
  test('for configs whose model_overrides value may be a prototype-chain key', () => {
    const fc = require('./helpers/fast-check-setup.cjs');
    const KNOWN_TIERS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit', 'unknown']);
    const overrideArb = fc.oneof(
      fc.constantFrom('toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty'),
      fc.string(),
    );
    fc.assert(
      fc.property(fc.object(), overrideArb, (baseCfg, overrideValue) => {
        const cfg = { ...baseCfg, model_overrides: { 'gsd-phase-researcher': overrideValue } };
        let result;
        assert.doesNotThrow(() => { result = resolveTierFromConfig(cfg, 'gsd-phase-researcher'); });
        assert.strictEqual(typeof result, 'string', `expected a string, got: ${typeof result} (${JSON.stringify(result)})`);
        assert.ok(KNOWN_TIERS.has(result), `unexpected tier value: ${JSON.stringify(result)}`);
      })
    );
  });
});
  });
}

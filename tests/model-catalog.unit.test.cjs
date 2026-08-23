'use strict';

/**
 * FAST, IN-PROCESS mutation-testing surface for `model-catalog.cjs` (#3007).
 *
 * Root cause this file exists to fix: `model-catalog.cjs` was entirely
 * outside Stryker's covered-module list, so the #3007 per-model Codex effort
 * rewrite (`renderEffortForRuntime`, `CODEX_MODEL_EFFORT`, the 'ultra'
 * rejection, the ladder walk-up) had zero mutation coverage. Following the
 * #2790 precedent (see `tests/planning-inspect.unit.test.cjs`), this is a
 * dedicated, spawn-free, in-process unit file rather than pointing the shard
 * at an integration test — `tests/model-resolver.test.cjs` uses
 * `runGsdTools` heavily and would hit the same 15-minute shard-cap cancel
 * that #2790 documented (one `node --test <file>` invocation costs whatever
 * its slowest case costs, per mutant).
 *
 * NEVER spawn a child process here — no `runGsdTools`, `spawnSync`,
 * `execFileSync`, or CLI invocation of any kind, and no filesystem writes.
 * Every case below requires the BUILT `.cjs` artifact directly and calls its
 * exports in-process.
 *
 * Every value asserted below was verified by requiring the built lib
 * directly and inspecting the real returned object — never guessed from
 * reading the source alone (CLAUDE.md "verify assertions by executing, not
 * retyping").
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../gsd-core/bin/lib/model-catalog.cjs');

const {
  VALID_TIERS,
  VALID_AGENT_TIERS,
  KNOWN_RUNTIMES,
  KNOWN_PROVIDERS,
  RUNTIMES_WITH_REASONING_EFFORT,
  RUNTIMES_WITH_FAST_MODE,
  ADAPTIVE_TIER_VALUES,
  CODEX_MODEL_EFFORT,
  MODEL_ALIAS_MAP,
  PROVIDER_PRESETS,
  isAnthropicFlavoredModel,
  getAgentToModelMapForProfile,
  formatAgentToModelMapAsTable,
  renderEffortArgv,
  renderEffortForRuntime,
  nextTier,
  mergeEffortTierDefaults,
} = catalog;

describe('model-catalog: exported enums/maps', () => {
  test('VALID_TIERS is opus/sonnet/haiku plus inherit', () => {
    assert.deepEqual(new Set(VALID_TIERS), new Set(['opus', 'sonnet', 'haiku', 'inherit']));
  });

  test('VALID_AGENT_TIERS is light/standard/heavy', () => {
    assert.deepEqual(new Set(VALID_AGENT_TIERS), new Set(['light', 'standard', 'heavy']));
  });

  test('ADAPTIVE_TIER_VALUES excludes inherit', () => {
    assert.deepEqual(new Set(ADAPTIVE_TIER_VALUES), new Set(['opus', 'sonnet', 'haiku']));
    assert.equal(ADAPTIVE_TIER_VALUES.has('inherit'), false);
  });

  test('KNOWN_RUNTIMES includes codex and claude', () => {
    assert.equal(KNOWN_RUNTIMES.has('codex'), true);
    assert.equal(KNOWN_RUNTIMES.has('claude'), true);
  });

  test('KNOWN_PROVIDERS excludes generic sentinel', () => {
    assert.equal(KNOWN_PROVIDERS.has('generic'), false);
    assert.equal(KNOWN_PROVIDERS.has('anthropic'), true);
    assert.equal(KNOWN_PROVIDERS.has('openai'), true);
  });

  test('RUNTIMES_WITH_REASONING_EFFORT is codex-only', () => {
    assert.deepEqual(new Set(RUNTIMES_WITH_REASONING_EFFORT), new Set(['codex']));
  });

  test('RUNTIMES_WITH_FAST_MODE is api-only', () => {
    assert.deepEqual(new Set(RUNTIMES_WITH_FAST_MODE), new Set(['api']));
  });

  test('CODEX_MODEL_EFFORT has a baseline and per-model sets, sol includes ultra', () => {
    assert.ok(CODEX_MODEL_EFFORT['_baseline'] instanceof Set);
    assert.equal(CODEX_MODEL_EFFORT['_baseline'].has('max'), true);
    assert.equal(CODEX_MODEL_EFFORT['gpt-5.6-sol'].has('ultra'), true);
    assert.equal(CODEX_MODEL_EFFORT['gpt-5.6-terra'].has('ultra'), false);
    assert.equal(CODEX_MODEL_EFFORT['gpt-5.6-luna'].has('ultra'), false);
  });

  test('MODEL_ALIAS_MAP maps opus/sonnet/haiku to claude model ids', () => {
    assert.equal(MODEL_ALIAS_MAP.opus, 'claude-opus-4-8');
    assert.equal(MODEL_ALIAS_MAP.sonnet, 'claude-sonnet-5');
    assert.equal(MODEL_ALIAS_MAP.haiku, 'claude-haiku-4-5');
  });

  test('PROVIDER_PRESETS is a non-empty object keyed by provider name', () => {
    assert.equal(typeof PROVIDER_PRESETS, 'object');
    assert.ok(Object.keys(PROVIDER_PRESETS).length > 0);
    assert.ok('anthropic' in PROVIDER_PRESETS);
  });
});

describe('model-catalog: isAnthropicFlavoredModel', () => {
  test('bare tier aliases are flavored', () => {
    assert.equal(isAnthropicFlavoredModel('opus'), true);
    assert.equal(isAnthropicFlavoredModel('sonnet'), true);
    assert.equal(isAnthropicFlavoredModel('haiku'), true);
    assert.equal(isAnthropicFlavoredModel('fable'), true);
  });

  test('claude-* ids are flavored in every provider namespacing', () => {
    assert.equal(isAnthropicFlavoredModel('claude-opus-4-8'), true);
    assert.equal(isAnthropicFlavoredModel('anthropic/claude-opus-4-8'), true);
    assert.equal(isAnthropicFlavoredModel('us.anthropic.claude-opus-4-8'), true);
  });

  test('negative case: gpt-* id is not flavored', () => {
    assert.equal(isAnthropicFlavoredModel('gpt-5.6-sol'), false);
  });

  test('non-string input is not flavored', () => {
    assert.equal(isAnthropicFlavoredModel(123), false);
    assert.equal(isAnthropicFlavoredModel(null), false);
    assert.equal(isAnthropicFlavoredModel(undefined), false);
  });
});

describe('model-catalog: getAgentToModelMapForProfile / formatAgentToModelMapAsTable', () => {
  const EXPECTED_PLANNER_TIER = { quality: 'opus', balanced: 'opus', budget: 'sonnet', adaptive: 'opus' };
  const EXPECTED_MAPPER_TIER = { quality: 'sonnet', balanced: 'haiku', budget: 'haiku', adaptive: 'haiku' };

  for (const profile of ['quality', 'balanced', 'budget', 'adaptive']) {
    test(`profile '${profile}' returns the expected tier for known agents`, () => {
      const map = getAgentToModelMapForProfile(profile);
      assert.equal(map['gsd-planner'], EXPECTED_PLANNER_TIER[profile]);
      assert.equal(map['gsd-codebase-mapper'], EXPECTED_MAPPER_TIER[profile]);
      assert.ok(Object.keys(map).length > 0);
      for (const value of Object.values(map)) {
        assert.equal(typeof value, 'string');
        assert.ok(value.length > 0);
      }
    });
  }

  test("profile 'inherit' maps every agent to the literal string 'inherit'", () => {
    const map = getAgentToModelMapForProfile('inherit');
    for (const value of Object.values(map)) {
      assert.equal(value, 'inherit');
    }
  });

  test('invalid profile falls back to balanced', () => {
    const balanced = getAgentToModelMapForProfile('balanced');
    const invalid = getAgentToModelMapForProfile('totally-bogus-profile');
    assert.deepEqual(invalid, balanced);
  });

  test('formatAgentToModelMapAsTable pads columns and renders a header/separator', () => {
    const out = formatAgentToModelMapAsTable({ agentA: 'model-x', b: 'model-y-longer' });
    const lines = out.split('\n');
    assert.equal(lines[0].includes('Agent'), true);
    assert.equal(lines[0].includes('Model'), true);
    assert.equal(lines[1].includes('┼'), true);
    assert.equal(lines[2].includes('agentA'), true);
    assert.equal(lines[2].includes('model-x'), true);
    assert.equal(lines[3].includes('model-y-longer'), true);
  });
});

describe('model-catalog: renderEffortForRuntime — codex per-model', () => {
  test("sol's 'max' passes through unclamped", () => {
    const r = renderEffortForRuntime('codex', 'max', 'gpt-5.6-sol');
    assert.equal(r.value, 'max');
    assert.equal(r.clamped, false);
    assert.equal(r.reason, null);
    assert.equal(r.param, 'model_reasoning_effort');
    assert.equal(r.channel, 'api');
  });

  test("'minimal' clamps up to 'low' with clamped:true and a non-empty reason (sol/terra/luna)", () => {
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const r = renderEffortForRuntime('codex', 'minimal', model);
      assert.equal(r.value, 'low');
      assert.equal(r.clamped, true);
      assert.equal(typeof r.reason, 'string');
      assert.ok(r.reason.length > 0);
      assert.ok(r.reason.includes(model));
    }
  });

  test("'ultra' is rejected outright even for sol which advertises it (value:null)", () => {
    const r = renderEffortForRuntime('codex', 'ultra', 'gpt-5.6-sol');
    assert.equal(r.value, null);
    assert.equal(r.param, null);
    assert.equal(r.channel, null);
    assert.equal(r.clamped, false);
    assert.ok(r.reason.includes('#2167'));
  });

  test('low/medium/high/xhigh pass through unclamped with reason:null', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh']) {
      const r = renderEffortForRuntime('codex', level, 'gpt-5.6-terra');
      assert.equal(r.value, level);
      assert.equal(r.clamped, false);
      assert.equal(r.reason, null);
    }
  });

  test('unknown model falls back to the family baseline', () => {
    const r = renderEffortForRuntime('codex', 'max', 'gpt-9-never-heard-of-it');
    assert.equal(r.value, 'max');
    assert.equal(r.clamped, false);
  });

  test('omitted / null / empty-string model all fall back to the family baseline', () => {
    const omitted = renderEffortForRuntime('codex', 'minimal');
    const nullModel = renderEffortForRuntime('codex', 'minimal', null);
    const emptyModel = renderEffortForRuntime('codex', 'minimal', '');
    for (const r of [omitted, nullModel, emptyModel]) {
      assert.equal(r.value, 'low');
      assert.equal(r.clamped, true);
      assert.ok(r.reason.includes('codex family baseline'));
    }
  });

  test("off-ladder input ('MAX') falls through to the runtime-level clamp unchanged", () => {
    const r = renderEffortForRuntime('codex', 'MAX', 'gpt-5.6-terra');
    assert.equal(r.value, 'MAX');
    assert.equal(r.clamped, false);
    assert.equal(r.reason, null);
  });
});

describe('model-catalog: renderEffortForRuntime — cross-runtime', () => {
  test("'inherit' passes through on every known runtime", () => {
    for (const runtime of [...KNOWN_RUNTIMES, 'totally-unknown-runtime']) {
      const r = renderEffortForRuntime(runtime, 'inherit');
      assert.equal(r.value, 'inherit');
      assert.equal(r.param, null);
      assert.equal(r.channel, null);
      assert.equal(r.clamped, false);
      assert.equal(r.reason, null);
    }
  });

  test('unknown runtime passes the requested value through unchanged', () => {
    const r = renderEffortForRuntime('totally-unknown-runtime', 'high');
    assert.equal(r.value, 'high');
    assert.equal(r.param, null);
    assert.equal(r.channel, null);
    assert.equal(r.clamped, false);
  });

  test('claude passes high through unchanged and clamps minimal to low', () => {
    const high = renderEffortForRuntime('claude', 'high');
    assert.equal(high.value, 'high');
    assert.equal(high.clamped, false);
    assert.equal(high.reason, null);

    const minimal = renderEffortForRuntime('claude', 'minimal');
    assert.equal(minimal.value, 'low');
    assert.equal(minimal.clamped, true);
    assert.ok(minimal.reason.includes('claude'));
  });
});

describe('model-catalog: renderEffortArgv', () => {
  test("effortSurface gate: 'none'/undefined produce empty, 'argv' produces an argument", () => {
    assert.deepEqual(renderEffortArgv('codex', 'max', 'none'), { argv: [], value: null, host: 'codex' });
    assert.deepEqual(renderEffortArgv('codex', 'max', undefined), { argv: [], value: null, host: 'codex' });
    const r = renderEffortArgv('codex', 'max', 'argv');
    assert.deepEqual(r.argv, ['-c', 'model_reasoning_effort=max']);
    assert.equal(r.value, 'max');
  });

  test("codex 'max' passes through, 'minimal' clamps to 'low'", () => {
    const max = renderEffortArgv('codex', 'max', 'argv');
    assert.deepEqual(max.argv, ['-c', 'model_reasoning_effort=max']);
    assert.equal(max.value, 'max');

    const minimal = renderEffortArgv('codex', 'minimal', 'argv');
    assert.deepEqual(minimal.argv, ['-c', 'model_reasoning_effort=low']);
    assert.equal(minimal.value, 'low');
  });

  test('unknown host produces empty result, never throws', () => {
    const r = renderEffortArgv('totally-bogus-host', 'high', 'argv');
    assert.deepEqual(r, { argv: [], value: null, host: 'totally-bogus-host' });
  });

  test('prototype-chain host names (__proto__, constructor, toString) return empty, never throw', () => {
    for (const host of ['__proto__', 'constructor', 'toString']) {
      const r = renderEffortArgv(host, 'high', 'argv');
      assert.deepEqual(r.argv, []);
      assert.equal(r.value, null);
      assert.equal(r.host, host);
    }
  });
});

describe('model-catalog: nextTier', () => {
  // Probed directly against the built module: light -> standard -> heavy,
  // and heavy SATURATES at 'heavy' rather than wrapping back to 'light'.
  test("advances light -> standard and standard -> heavy", () => {
    assert.equal(nextTier('light'), 'standard');
    assert.equal(nextTier('standard'), 'heavy');
  });

  test("saturates at the top tier: 'heavy' stays 'heavy'", () => {
    assert.equal(nextTier('heavy'), 'heavy');
  });

  test('unknown/garbage tier returns null', () => {
    assert.equal(nextTier('bogus'), null);
    assert.equal(nextTier('LIGHT'), null); // case-sensitive, not in the order array
  });

  test('empty string, null, undefined, and non-string input all return null', () => {
    assert.equal(nextTier(''), null);
    assert.equal(nextTier(null), null);
    assert.equal(nextTier(undefined), null);
    assert.equal(nextTier(123), null);
  });
});

describe('model-catalog: mergeEffortTierDefaults (#3531)', () => {
  const manifest = { opus: 'sonnet', sonnet: 'haiku', haiku: 'opus' };
  const isValid = (v) => typeof v === 'string' && ['opus', 'sonnet', 'haiku'].includes(v);

  test('absent/empty override leaves the manifest values untouched', () => {
    assert.deepEqual(mergeEffortTierDefaults(manifest, undefined, isValid), manifest);
    assert.deepEqual(mergeEffortTierDefaults(manifest, {}, isValid), manifest);
  });

  test('partial override changes only the named tier; other tiers keep their built-in values', () => {
    const merged = mergeEffortTierDefaults(manifest, { sonnet: 'opus' }, isValid);
    assert.equal(merged.sonnet, 'opus');
    assert.equal(merged.opus, manifest.opus);
    assert.equal(merged.haiku, manifest.haiku);
  });

  test('an invalid override value for a tier is ignored; the built-in for that tier is retained', () => {
    const merged = mergeEffortTierDefaults(manifest, { sonnet: 'bogus' }, isValid);
    assert.equal(merged.sonnet, manifest.sonnet);
  });

  test('an override key not present in the manifest is still merged in (isValid gates values, not tier names)', () => {
    const merged = mergeEffortTierDefaults(manifest, { newtier: 'opus' }, isValid);
    assert.equal(merged.newtier, 'opus');
    assert.equal(merged.opus, manifest.opus);
    assert.equal(merged.sonnet, manifest.sonnet);
    assert.equal(merged.haiku, manifest.haiku);
  });

  test('__proto__/constructor/prototype override keys are skipped (house pollution guard)', () => {
    const merged = mergeEffortTierDefaults(manifest, { __proto__: 'opus', constructor: 'sonnet', prototype: 'haiku' }, isValid);
    assert.deepEqual(merged, manifest);
    assert.equal(Object.prototype.hasOwnProperty.call(merged, '__proto__'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(merged, 'constructor'), false);
  });

  test('null, non-object, and array config all leave the manifest untouched', () => {
    assert.deepEqual(mergeEffortTierDefaults(manifest, null, isValid), manifest);
    assert.deepEqual(mergeEffortTierDefaults(manifest, 'bogus', isValid), manifest);
    assert.deepEqual(mergeEffortTierDefaults(manifest, ['x'], isValid), manifest);
  });

  test('a falsy/missing manifest merges over an empty base object', () => {
    assert.deepEqual(mergeEffortTierDefaults(null, { sonnet: 'opus' }, isValid), { sonnet: 'opus' });
  });

  test('the function is pure: it never mutates the manifest it is given', () => {
    const original = { ...manifest };
    mergeEffortTierDefaults(manifest, { sonnet: 'opus' }, isValid);
    assert.deepEqual(manifest, original);
  });
});

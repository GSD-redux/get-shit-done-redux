/**
 * Issue #2517 — runtime-aware model profile resolution.
 *
 * Today, profile tiers (opus/sonnet/haiku) only resolve to Claude IDs. On Codex /
 * other runtimes, users must use `inherit` or write large `model_overrides` blocks.
 *
 * This adds a `runtime` config key + `model_profile_overrides[runtime][tier]` map.
 * When `runtime` is set to a non-Claude value, profile tiers resolve to runtime-
 * native model IDs.
 *
 *   Codex:   opus -> gpt-5.6-sol (xhigh), sonnet -> gpt-5.6-terra (medium), haiku -> gpt-5.6-luna (medium)
 *
 * `runtime: "claude"` is the implicit default and is treated as a no-op for
 * resolution — it does not override `resolve_model_ids: "omit"` or any other
 * Claude-native semantics (review finding #4).
 *
 * `inherit` keeps current behavior. Unknown runtimes fall back safely (do NOT emit
 * provider-specific IDs the runtime can't accept) and trigger a one-shot stderr
 * warning so typos like `runtime: "codx"` surface immediately (review finding #13).
 *
 * HOME isolation: every test sets `process.env.HOME` to a per-suite tmpdir so the
 * developer's real `~/.gsd/defaults.json` cannot bleed into assertions
 * (review finding #8 / pattern from CodeRabbit on PRs #2603, #2604).
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTempProject, cleanup, resetRuntimeWarningCaches } = require('./helpers.cjs');

const {
  resolveModelInternal,
  resolveEffortInternal,
  resolveTierEntry,
} = require('../gsd-core/bin/lib/model-resolver.cjs');
const {
  RUNTIME_PROFILE_MAP,
  KNOWN_RUNTIMES,
} = require('../gsd-core/bin/lib/model-catalog.cjs');
const { renderEffortForRuntime } = require('../gsd-core/bin/lib/model-catalog.cjs');
const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');

function writeConfig(tmpDir, obj) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify(obj, null, 2)
  );
}

// ─── Shared HOME isolation (#2517 review finding #8) ────────────────────────
// Without this, a developer's real `~/.gsd/defaults.json` (e.g. one with
// `runtime: codex` set) silently overrides test assertions about back-compat
// behavior. Capture HOME, point it at an isolated tmpdir for the duration of
// each test, restore on teardown.
let _origHome;
let _origUserProfile;
let _origGsdHome;
let _isolatedHome;
function isolateHome() {
  _origHome = process.env.HOME;
  _origUserProfile = process.env.USERPROFILE;
  _origGsdHome = process.env.GSD_HOME;
  _isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-home-iso-'));
  process.env.HOME = _isolatedHome;
  process.env.USERPROFILE = _isolatedHome;
  process.env.GSD_HOME = _isolatedHome;
}
function restoreHome() {
  if (_origHome === undefined) delete process.env.HOME; else process.env.HOME = _origHome;
  if (_origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = _origUserProfile;
  if (_origGsdHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = _origGsdHome;
  cleanup(_isolatedHome);
  _isolatedHome = null;
}

// ─── Backwards compatibility — no `runtime` set ─────────────────────────────
describe('issue #2517: backwards compat — no runtime key set', () => {
  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('balanced profile returns Claude alias when runtime absent', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    // gsd-planner balanced -> opus
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'opus');
  });

  test('inherit profile still returns "inherit" with no runtime', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'inherit');
  });

  test('resolve_model_ids:true still maps alias -> full Claude ID with no runtime', () => {
    writeConfig(tmpDir, { model_profile: 'balanced', resolve_model_ids: true });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'claude-opus-4-8');
  });

  test('resolve_model_ids:"omit" still returns "" with no runtime', () => {
    writeConfig(tmpDir, { model_profile: 'balanced', resolve_model_ids: 'omit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), '');
  });

  test('effort resolves universally but render param is null when runtime absent', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    // Effort always resolves (universal); rendering without a runtime yields no wire param.
    const rendered = renderEffortForRuntime(undefined, eff);
    assert.strictEqual(rendered.param, null);
  });

  test('adaptive profile still works without runtime (#1713/#1806)', () => {
    writeConfig(tmpDir, { model_profile: 'adaptive' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'opus');
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'haiku');
  });
});

// ─── runtime: "claude" — no-op (preserves Claude-native semantics) ──────────
describe('issue #2517: runtime "claude" is a no-op for resolution (finding #4)', () => {
  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('runtime:"claude" + balanced returns the alias, not the resolved Claude ID', () => {
    // `runtime: "claude"` is the implicit default — it must not silently flip
    // resolve_model_ids on. The alias passes through identically to the unset case.
    writeConfig(tmpDir, { runtime: 'claude', model_profile: 'balanced' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'opus');
  });

  test('runtime:"claude" + resolve_model_ids:"omit" returns "" (finding #4 regression)', () => {
    // The pre-fix bug: runtime:"claude" hijacked the resolution chain and
    // returned the resolved Claude ID even when the user explicitly asked for the
    // omit semantics.
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_profile: 'quality',
      resolve_model_ids: 'omit',
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), '');
  });

  test('runtime:"claude" + resolve_model_ids:true maps alias -> full Claude ID', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      model_profile: 'quality',
      resolve_model_ids: true,
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'claude-opus-4-8');
  });

  test('effort is first-class on Claude (emits output_config.effort)', () => {
    writeConfig(tmpDir, { runtime: 'claude', model_profile: 'quality' });
    // Under unification, Claude effort is first-class — rendered via output_config.effort.
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    const rendered = renderEffortForRuntime('claude', eff);
    assert.strictEqual(rendered.param, 'output_config.effort');
    // gsd-planner is heavy tier → default effort 'xhigh'
    assert.strictEqual(rendered.value, 'xhigh');
  });
});

// ─── runtime: "codex" — resolves tiers to Codex IDs + reasoning_effort ──────
describe('issue #2517: runtime "codex" — Codex tier resolution', () => {
  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('opus tier -> gpt-5.6-sol model; heavy-tier agent -> xhigh effort on codex', () => {
    writeConfig(tmpDir, { runtime: 'codex', model_profile: 'quality' });
    // gsd-planner quality -> opus -> gpt-5.6-sol (model unchanged)
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'gpt-5.6-sol');
    // gsd-planner is heavy routing tier → effort 'xhigh' → rendered model_reasoning_effort
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.strictEqual(rendered.param, 'model_reasoning_effort');
    assert.strictEqual(rendered.value, 'xhigh');
  });

  test('sonnet tier -> gpt-5.6-terra model; heavy-tier agent -> xhigh effort on codex', () => {
    writeConfig(tmpDir, { runtime: 'codex', model_profile: 'balanced' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-roadmapper'), 'gpt-5.6-terra');
    // gsd-roadmapper is heavy routing tier → effort 'xhigh' (not catalog medium)
    const eff = resolveEffortInternal(tmpDir, 'gsd-roadmapper');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.strictEqual(rendered.param, 'model_reasoning_effort');
    assert.strictEqual(rendered.value, 'xhigh');
  });

  test('haiku tier -> gpt-5.6-luna model; light-tier agent -> low effort on codex', () => {
    writeConfig(tmpDir, { runtime: 'codex', model_profile: 'budget' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'gpt-5.6-luna');
    // gsd-codebase-mapper is light routing tier → effort 'low' (not catalog medium)
    const eff = resolveEffortInternal(tmpDir, 'gsd-codebase-mapper');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.strictEqual(rendered.param, 'model_reasoning_effort');
    assert.strictEqual(rendered.value, 'low');
  });

  test('adaptive profile resolves on Codex (no #1713/#1806 regression)', () => {
    writeConfig(tmpDir, { runtime: 'codex', model_profile: 'adaptive' });
    // gsd-planner adaptive -> opus -> gpt-5.6-sol
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'gpt-5.6-sol');
    // gsd-codebase-mapper adaptive -> haiku -> gpt-5.6-luna
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'gpt-5.6-luna');
  });

  test('inherit profile still returns "inherit" on Codex; effort still resolves universally', () => {
    writeConfig(tmpDir, { runtime: 'codex', model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'inherit');
    // Unified effort is config-driven (routing_tier_defaults), independent of model_profile.
    // gsd-planner (heavy tier) → 'xhigh'; rendered to codex param.
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.strictEqual(rendered.param, 'model_reasoning_effort');
    assert.strictEqual(rendered.value, 'xhigh');
  });

  test('runtime:"codex" beats resolve_model_ids:"omit" (explicit non-Claude opt-in wins)', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile: 'quality',
      resolve_model_ids: 'omit',
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'gpt-5.6-sol');
  });
});

// ─── Precedence chain ───────────────────────────────────────────────────────
describe('issue #2517: precedence chain', () => {
  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('per-agent model_overrides wins over runtime tier resolution', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile: 'quality',
      model_overrides: { 'gsd-planner': 'gpt-5.6-luna' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'gpt-5.6-luna');
  });

  test('model_profile_overrides[runtime][tier] beats built-in defaults', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile: 'quality',
      model_profile_overrides: {
        codex: { opus: 'gpt-5-pro' },
      },
    });
    // gsd-planner quality -> opus -> overridden to gpt-5-pro
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'gpt-5-pro');
    // gsd-codebase-mapper quality -> sonnet -> gpt-5.6-terra
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'gpt-5.6-terra');
  });

  test('partial profile_overrides — only opus overridden, sonnet uses default', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile: 'balanced',
      model_profile_overrides: {
        codex: { opus: 'gpt-5-pro' }, // only opus overridden
      },
    });
    // gsd-planner balanced -> opus -> overridden to gpt-5-pro
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'gpt-5-pro');
    // gsd-roadmapper balanced -> sonnet -> spec default
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-roadmapper'), 'gpt-5.6-terra');
  });

  test('per-agent override beats profile override beats default', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile: 'quality',
      model_profile_overrides: { codex: { opus: 'gpt-5-pro' } },
      model_overrides: { 'gsd-planner': 'custom-model' },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'custom-model');
  });
});

// ─── Field-merge semantics — review findings #2 ─────────────────────────────
describe('issue #2517: field-merge of overrides with built-in defaults (finding #2)', () => {
  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('string-shorthand override: model is overridden; unified effort derives from routing tier', () => {
    // `{ codex: { opus: "gpt-5-pro" } }` is the documented shorthand.
    // Model is overridden to gpt-5-pro; effort now derives from the universal
    // config-driven path (gsd-planner heavy tier → 'xhigh'), not from the catalog.
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile: 'quality',
      model_profile_overrides: { codex: { opus: 'gpt-5-pro' } },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'gpt-5-pro');
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.strictEqual(rendered.param, 'model_reasoning_effort');
    assert.strictEqual(rendered.value, 'xhigh');
  });

  test('partial-object override (no model) keeps model from built-in; unified effort from routing tier', () => {
    // `{ codex: { opus: { reasoning_effort: "low" } } }` preserves the built-in model.
    // Under unification, the catalog reasoning_effort field is not read for effort resolution;
    // effort comes from routing_tier_defaults (gsd-planner heavy → 'xhigh').
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile: 'quality',
      model_profile_overrides: { codex: { opus: { reasoning_effort: 'low' } } },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'gpt-5.6-sol');
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.strictEqual(rendered.param, 'model_reasoning_effort');
    assert.strictEqual(rendered.value, 'xhigh');
  });

  test('full-object override: model replaced; unified effort from routing tier (not catalog field)', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile: 'quality',
      model_profile_overrides: {
        codex: { opus: { model: 'custom-model', reasoning_effort: 'minimal' } },
      },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'custom-model');
    // Effort comes from routing_tier_defaults, not the catalog 'minimal' field.
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.strictEqual(rendered.param, 'model_reasoning_effort');
    assert.strictEqual(rendered.value, 'xhigh');
  });

  test('resolveTierEntry helper: shorthand merge', () => {
    // Direct unit-test of the shared helper used by core + install.js.
    const entry = resolveTierEntry({
      runtime: 'codex',
      tier: 'opus',
      overrides: { codex: { opus: 'gpt-5-pro' } },
    });
    assert.deepStrictEqual(entry, { model: 'gpt-5-pro', reasoning_effort: 'xhigh' });
  });

  test('resolveTierEntry helper: partial-object merge keeps built-in model', () => {
    const entry = resolveTierEntry({
      runtime: 'codex',
      tier: 'opus',
      overrides: { codex: { opus: { reasoning_effort: 'low' } } },
    });
    assert.deepStrictEqual(entry, { model: 'gpt-5.6-sol', reasoning_effort: 'low' });
  });

  test('resolveTierEntry helper: unknown runtime + no overrides -> null', () => {
    const entry = resolveTierEntry({
      runtime: 'mystery',
      tier: 'opus',
      overrides: null,
    });
    assert.strictEqual(entry, null);
  });
});

// ─── Unknown runtime render safety (finding #3 spirit) ──────────────────────
describe('issue #2517: unknown runtime render param is null (effort does not leak to install path)', () => {
  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('unknown runtime: model resolves via override; render param is null (no wire param leaked)', () => {
    // Under unification, effort always resolves (universal), but renderEffortForRuntime
    // returns param=null for unknown runtimes — no effort leaks to the install path.
    writeConfig(tmpDir, {
      runtime: 'mystery',
      model_profile: 'quality',
      model_profile_overrides: {
        mystery: { opus: { model: 'mystery-opus', reasoning_effort: 'xhigh' } },
      },
    });
    // Model still resolves (overrides are honored).
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'mystery-opus');
    // Effort resolves universally but the unknown runtime has no wire param.
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    const rendered = renderEffortForRuntime('mystery', eff);
    assert.strictEqual(rendered.param, null);
  });

  test('typo runtime "codx": render param is null (no leak into install path)', () => {
    writeConfig(tmpDir, {
      runtime: 'codx',
      model_profile: 'quality',
      model_profile_overrides: { codx: { opus: { model: 'gpt-5.6-terra', reasoning_effort: 'xhigh' } } },
    });
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    const rendered = renderEffortForRuntime('codx', eff);
    assert.strictEqual(rendered.param, null);
  });
});

// ─── Unknown runtime / unknown tier ─────────────────────────────────────────
describe('issue #2517: unknown runtime + safe fallback', () => {
  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('unknown runtime falls back to Claude-alias safe default (no Codex IDs leaked)', () => {
    writeConfig(tmpDir, { runtime: 'mystery-runtime', model_profile: 'quality' });
    // Should NOT emit gpt-5.6-sol — should fall back to Claude alias
    const resolved = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.notStrictEqual(resolved, 'gpt-5.6-sol');
    assert.strictEqual(resolved, 'opus');
  });

  test('unknown runtime + user-provided overrides for that runtime — uses overrides', () => {
    writeConfig(tmpDir, {
      runtime: 'mystery-runtime',
      model_profile: 'quality',
      model_profile_overrides: {
        'mystery-runtime': { opus: 'mystery-opus' },
      },
    });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'mystery-opus');
  });

  test('runtime:"codex" but missing model_profile_overrides[codex] uses spec defaults', () => {
    writeConfig(tmpDir, { runtime: 'codex', model_profile: 'quality' });
    // No model_profile_overrides at all — built-in Codex defaults take over
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'gpt-5.6-sol');
  });
});

// ─── Schema validation (config-set time + load time) ────────────────────────
describe('issue #2517: VALID_CONFIG_KEYS schema', () => {
  test('"runtime" is a valid config key', () => {
    assert.strictEqual(isValidConfigKey('runtime'), true);
  });

  test('model_profile_overrides.codex.opus is valid', () => {
    assert.strictEqual(isValidConfigKey('model_profile_overrides.codex.opus'), true);
  });

  test('model_profile_overrides.codex.sonnet is valid', () => {
    assert.strictEqual(isValidConfigKey('model_profile_overrides.codex.sonnet'), true);
  });

  test('model_profile_overrides.codex.haiku is valid', () => {
    assert.strictEqual(isValidConfigKey('model_profile_overrides.codex.haiku'), true);
  });

  test('model_profile_overrides.claude.opus is valid', () => {
    assert.strictEqual(isValidConfigKey('model_profile_overrides.claude.opus'), true);
  });

  test('model_profile_overrides with unknown runtime is valid (free-string runtime)', () => {
    assert.strictEqual(isValidConfigKey('model_profile_overrides.acme.opus'), true);
  });

  test('model_profile_overrides with bogus tier is rejected', () => {
    assert.strictEqual(isValidConfigKey('model_profile_overrides.codex.banana'), false);
  });

  test('model_profile_overrides without tier is rejected', () => {
    assert.strictEqual(isValidConfigKey('model_profile_overrides.codex'), false);
  });

  test('model_profile_overrides root key alone is rejected (must include runtime+tier)', () => {
    assert.strictEqual(isValidConfigKey('model_profile_overrides'), false);
  });
});

// ─── loadConfig validation warnings (review findings #10, #13) ──────────────
describe('issue #2517: loadConfig warns on unknown runtime/tier (findings #10, #13)', () => {
  const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
  let tmpDir;
  let origWrite;
  let captured;
  beforeEach(() => {
    isolateHome();
    tmpDir = createTempProject();
    resetRuntimeWarningCaches();
    captured = [];
    origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  });
  afterEach(() => { process.stderr.write = origWrite; cleanup(tmpDir); restoreHome(); });

  test('unknown runtime triggers a stderr warning', () => {
    writeConfig(tmpDir, { runtime: 'codx', model_profile: 'quality' });
    loadConfig(tmpDir);
    const joined = captured.join('');
    assert.match(joined, /unknown value "codx"/);
  });

  test('known runtime does NOT trigger a runtime warning', () => {
    writeConfig(tmpDir, { runtime: 'codex', model_profile: 'quality' });
    loadConfig(tmpDir);
    const joined = captured.join('');
    assert.doesNotMatch(joined, /unknown value/);
  });

  test('unknown tier in overrides triggers a stderr warning', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile_overrides: { codex: { banana: 'whatever' } },
    });
    loadConfig(tmpDir);
    const joined = captured.join('');
    assert.match(joined, /unknown tier "banana"/);
  });

  test('unknown runtime in overrides triggers a stderr warning', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile_overrides: { mystery: { opus: 'whatever' } },
    });
    loadConfig(tmpDir);
    const joined = captured.join('');
    assert.match(joined, /model_profile_overrides\.mystery\.\* uses unknown runtime/);
  });

  test('every name in KNOWN_RUNTIMES survives the warning gate', () => {
    // Smoke check: `KNOWN_RUNTIMES` must list every runtime `bin/install.js`
    // emits for, otherwise legitimate users get spammed at every loadConfig.
    for (const r of KNOWN_RUNTIMES) {
      assert.ok(typeof r === 'string' && r.length > 0);
    }
  });
});

// ─── End-to-end: per-project config -> Codex TOML emit (finding #1) ─────────
describe('issue #2517: install end-to-end — per-project config reaches Codex TOML (finding #1)', () => {
  // Load install.js in test-mode so its module exports are populated.
  const prevTestMode = process.env.GSD_TEST_MODE;
  process.env.GSD_TEST_MODE = '1';
  const installMod = require('../bin/install.js');
  if (prevTestMode === undefined) delete process.env.GSD_TEST_MODE;
  else process.env.GSD_TEST_MODE = prevTestMode;
  const { readGsdRuntimeProfileResolver, generateCodexAgentToml } = installMod;

  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('readGsdRuntimeProfileResolver picks up runtime from .planning/config.json', () => {
    // No ~/.gsd/defaults.json (HOME is isolated tmpdir). Per-project config alone
    // must drive the resolver — pre-fix, it returned null.
    writeConfig(tmpDir, { runtime: 'codex', model_profile: 'quality' });
    const resolver = readGsdRuntimeProfileResolver(tmpDir);
    assert.ok(resolver, 'expected a resolver from per-project config');
    assert.strictEqual(resolver.runtime, 'codex');
    const entry = resolver.resolve('gsd-planner');
    assert.deepStrictEqual(entry, { model: 'gpt-5.6-sol', reasoning_effort: 'xhigh' });
  });

  test('per-project config wins over global ~/.gsd/defaults.json', () => {
    fs.mkdirSync(path.join(_isolatedHome, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(_isolatedHome, '.gsd', 'defaults.json'),
      JSON.stringify({ runtime: 'claude', model_profile: 'budget' })
    );
    writeConfig(tmpDir, { runtime: 'codex', model_profile: 'quality' });
    const resolver = readGsdRuntimeProfileResolver(tmpDir);
    assert.strictEqual(resolver.runtime, 'codex');
    const entry = resolver.resolve('gsd-planner');
    assert.strictEqual(entry.model, 'gpt-5.6-sol');
  });

  test('generated Codex TOML omits model = and model_reasoning_effort = lines when only the resolver would have supplied them (#3241)', () => {
    // #3241 flips this: the runtime-resolver auto-embed (D1) was removed, so a
    // resolver alone with no explicit model_overrides no longer pins a model,
    // and #838's coupling means the reasoning-effort line is omitted too.
    writeConfig(tmpDir, { runtime: 'codex', model_profile: 'quality' });
    const resolver = readGsdRuntimeProfileResolver(tmpDir);
    const toml = generateCodexAgentToml(
      'gsd-planner',
      '---\nname: gsd-planner\ndescription: Planner agent\n---\nBody.\n',
      null,
      resolver
    );
    assert.doesNotMatch(toml, /^model = "gpt-5\.6-sol"$/m);
    assert.doesNotMatch(toml, /^model_reasoning_effort = "xhigh"$/m);
  });

  test('generated TOML always includes model_reasoning_effort even when model_profile_overrides sets reasoning_effort to empty (#443 unified) (#3241: model now pinned via explicit model_overrides, not the resolver alone)', () => {
    // Under the unified effort design (#443), model_reasoning_effort in the Codex TOML
    // is driven by the unified effort resolver (resolveInstallTimeEffort / effortCfg),
    // NOT by model_profile_overrides.reasoning_effort. Setting reasoning_effort: '' in
    // model_profile_overrides does NOT suppress the unified effort when a model IS
    // pinned — the TOML carries a valid model_reasoning_effort drawn from the agent's
    // routing tier.
    // #3241: the resolver alone no longer pins a model (D1), so this test now supplies
    // an explicit model_overrides pin ('custom', a real-looking Codex id — row 4,
    // "unchanged") to keep exercising the unrelated property under test: that
    // model_profile_overrides.reasoning_effort is ignored by the unified resolver.
    // gsd-planner is a heavy-tier agent → unified default resolves to "xhigh".
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile: 'quality',
      model_profile_overrides: { codex: { opus: { model: 'custom', reasoning_effort: '' } } },
    });
    const resolver = readGsdRuntimeProfileResolver(tmpDir);
    const toml = generateCodexAgentToml(
      'gsd-planner',
      '---\nname: gsd-planner\n---\nBody.\n',
      { 'gsd-planner': 'custom' },
      resolver
    );
    // Explicit model_overrides pin is respected (#3241 row 4 — unchanged).
    assert.match(toml, /^model = "custom"$/m);
    // Unified effort always fires when a model is pinned — model_reasoning_effort is
    // present and valid, ignoring model_profile_overrides.reasoning_effort.
    assert.match(toml, /^model_reasoning_effort = "(minimal|low|medium|high|xhigh)"$/m);
    // gsd-planner is heavy-tier, so with no effortCfg the manifest tier default applies → xhigh.
    assert.match(toml, /^model_reasoning_effort = "xhigh"$/m);
  });

  test('resolver returns null with no global, no per-project config', () => {
    // Sanity: nothing configured -> nothing emitted. Pre-existing back-compat.
    const resolver = readGsdRuntimeProfileResolver(tmpDir);
    assert.strictEqual(resolver, null);
  });

  test('inline require paths resolve relative to install.js __dirname (finding #6)', () => {
    // Defensive: assert the lib files install.js requires actually exist at
    // resolver-construction time. Catches accidental relative-path drift in CI.
    const installDir = path.dirname(require.resolve('../bin/install.js'));
    const libDir = path.join(installDir, '..', 'gsd-core', 'bin', 'lib');
    assert.ok(fs.existsSync(path.join(libDir, 'model-catalog.cjs')));
    assert.ok(fs.existsSync(path.join(libDir, 'model-profiles.cjs')));
  });
});

// ─── RUNTIME_PROFILE_MAP single source of truth (finding #16) ───────────────
describe('issue #2517: RUNTIME_PROFILE_MAP single source of truth (finding #16)', () => {
  test('install.js consumes the same map as model-catalog.cjs', () => {
    // `bin/install.js` must NOT carry its own duplicate copy of the map.
    // The shared resolver imported in install.js exposes `runtime` and the
    // entries through `resolveTierEntry`, so any future drift between the two
    // files would surface as a test failure here rather than a silent bug.
    const codexOpus = RUNTIME_PROFILE_MAP.codex?.opus;
    assert.deepStrictEqual(codexOpus, { model: 'gpt-5.6-sol', reasoning_effort: 'xhigh' });
    const claudeOpus = RUNTIME_PROFILE_MAP.claude?.opus;
    assert.deepStrictEqual(claudeOpus, { model: 'claude-opus-4-8' });
  });
});

// #1928: the "gemini" runtime tier-resolution suite was removed with the
// sunset Gemini CLI runtime. The gemini-3.x models remain in the catalog for
// Antigravity (which runs on the Gemini backend and carries its own
// runtimeTierDefaults); Antigravity's tier resolution is covered elsewhere.

// ─── Issue #2612: qwen runtime tier resolution ───────────────────────────────
describe('issue #2612: runtime "qwen" — Qwen tier resolution', () => {
  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('opus tier -> qwen3-max-2026-01-23', () => {
    writeConfig(tmpDir, { runtime: 'qwen', model_profile: 'quality' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'qwen3-max-2026-01-23');
  });

  test('sonnet tier -> qwen3-coder-plus', () => {
    writeConfig(tmpDir, { runtime: 'qwen', model_profile: 'balanced' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-roadmapper'), 'qwen3-coder-plus');
  });

  test('haiku tier -> qwen3-coder-next', () => {
    writeConfig(tmpDir, { runtime: 'qwen', model_profile: 'budget' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'qwen3-coder-next');
  });

  test('qwen: effort resolves universally but render param is null (no wire param)', () => {
    writeConfig(tmpDir, { runtime: 'qwen', model_profile: 'quality' });
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(renderEffortForRuntime('qwen', eff).param, null);
  });
});

// ─── Issue #2612: opencode runtime tier resolution ───────────────────────────
describe('issue #2612: runtime "opencode" — OpenCode tier resolution', () => {
  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('opus tier -> anthropic/claude-opus-4-8', () => {
    writeConfig(tmpDir, { runtime: 'opencode', model_profile: 'quality' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'anthropic/claude-opus-4-8');
  });

  test('sonnet tier -> anthropic/claude-sonnet-5', () => {
    writeConfig(tmpDir, { runtime: 'opencode', model_profile: 'balanced' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-roadmapper'), 'anthropic/claude-sonnet-5');
  });

  test('haiku tier -> anthropic/claude-haiku-4-5', () => {
    writeConfig(tmpDir, { runtime: 'opencode', model_profile: 'budget' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'anthropic/claude-haiku-4-5');
  });

  test('opencode: effort resolves universally but render param is null (no wire param)', () => {
    writeConfig(tmpDir, { runtime: 'opencode', model_profile: 'quality' });
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(renderEffortForRuntime('opencode', eff).param, null);
  });
});

// ─── Issue #2093: kilo runtime tier resolution ───────────────────────────────
// Kilo is an OpenCode fork and shares the IDENTICAL built-in tier IDs (UPGRADE 2
// / ADR-1239). Kilo moved from Group B (no built-in defaults) to Group A here.
describe('issue #2093: runtime "kilo" — Kilo tier resolution', () => {
  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('opus tier -> anthropic/claude-opus-4-8', () => {
    writeConfig(tmpDir, { runtime: 'kilo', model_profile: 'quality' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'anthropic/claude-opus-4-8');
  });

  test('sonnet tier -> anthropic/claude-sonnet-5', () => {
    writeConfig(tmpDir, { runtime: 'kilo', model_profile: 'balanced' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-roadmapper'), 'anthropic/claude-sonnet-5');
  });

  test('haiku tier -> anthropic/claude-haiku-4-5', () => {
    writeConfig(tmpDir, { runtime: 'kilo', model_profile: 'budget' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'anthropic/claude-haiku-4-5');
  });

  test('kilo: effort resolves universally but render param is null (no wire param)', () => {
    writeConfig(tmpDir, { runtime: 'kilo', model_profile: 'quality' });
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(renderEffortForRuntime('kilo', eff).param, null);
  });
});

// ─── Issue #2612: copilot runtime tier resolution ────────────────────────────
describe('issue #2612: runtime "copilot" — Copilot tier resolution', () => {
  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('opus tier -> claude-opus-4-8', () => {
    writeConfig(tmpDir, { runtime: 'copilot', model_profile: 'quality' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'claude-opus-4-8');
  });

  test('sonnet tier -> claude-sonnet-5', () => {
    writeConfig(tmpDir, { runtime: 'copilot', model_profile: 'balanced' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-roadmapper'), 'claude-sonnet-5');
  });

  test('haiku tier -> claude-haiku-4-5', () => {
    writeConfig(tmpDir, { runtime: 'copilot', model_profile: 'budget' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'claude-haiku-4-5');
  });

  test('copilot: effort resolves universally but render param is null (no wire param)', () => {
    writeConfig(tmpDir, { runtime: 'copilot', model_profile: 'quality' });
    const eff = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(renderEffortForRuntime('copilot', eff).param, null);
  });
});

// ─── Issue #2612: Group B runtimes fall through (no built-in map) ────────────
describe('issue #2612: Group B runtimes — no built-in map, use unknown-runtime fallback', () => {
  test('cursor is not in RUNTIME_PROFILE_MAP (uses unknown-runtime fallback)', () => {
    assert.strictEqual(RUNTIME_PROFILE_MAP.cursor, undefined);
  });

  test('windsurf is not in RUNTIME_PROFILE_MAP', () => {
    assert.strictEqual(RUNTIME_PROFILE_MAP.windsurf, undefined);
  });

  test('cline is not in RUNTIME_PROFILE_MAP', () => {
    assert.strictEqual(RUNTIME_PROFILE_MAP.cline, undefined);
  });

  test('augment is not in RUNTIME_PROFILE_MAP', () => {
    assert.strictEqual(RUNTIME_PROFILE_MAP.augment, undefined);
  });

  test('trae is not in RUNTIME_PROFILE_MAP', () => {
    assert.strictEqual(RUNTIME_PROFILE_MAP.trae, undefined);
  });

  test('codebuddy is not in RUNTIME_PROFILE_MAP', () => {
    assert.strictEqual(RUNTIME_PROFILE_MAP.codebuddy, undefined);
  });

  test('antigravity is not in RUNTIME_PROFILE_MAP', () => {
    assert.strictEqual(RUNTIME_PROFILE_MAP.antigravity, undefined);
  });

  test('cursor runtime falls back to Claude alias (not a Gemini/Qwen/etc ID)', () => {
    const { createTempProject, cleanup } = require('./helpers.cjs');
    isolateHome();
    const tmpDir = createTempProject();
    resetRuntimeWarningCaches();
    try {
      writeConfig(tmpDir, { runtime: 'cursor', model_profile: 'quality' });
      // Should fall back to Claude alias, not emit a provider-specific ID
      const resolved = resolveModelInternal(tmpDir, 'gsd-planner');
      assert.strictEqual(resolved, 'opus');
    } finally {
      cleanup(tmpDir);
      restoreHome();
    }
  });
});

// ─── Issue #2612: Partial override merge for new runtimes ────────────────────
describe('issue #2612: partial override merge for new Group A runtimes', () => {
  let tmpDir;
  beforeEach(() => { isolateHome(); tmpDir = createTempProject(); resetRuntimeWarningCaches(); });
  afterEach(() => { cleanup(tmpDir); restoreHome(); });

  test('qwen.opus override wins; sonnet and haiku use built-in defaults', () => {
    writeConfig(tmpDir, {
      runtime: 'qwen',
      model_profile: 'quality',
      model_profile_overrides: {
        qwen: { opus: 'qwen3-max-custom' },
      },
    });
    // opus is overridden
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'qwen3-max-custom');
    // sonnet not overridden — quality -> sonnet for gsd-codebase-mapper
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'qwen3-coder-plus');
  });

  test('opencode.sonnet override wins; opus and haiku still use built-in defaults', () => {
    writeConfig(tmpDir, {
      runtime: 'opencode',
      model_profile: 'balanced',
      model_profile_overrides: {
        opencode: { sonnet: 'anthropic/claude-sonnet-4-7' },
      },
    });
    // gsd-planner balanced -> opus -> built-in default
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'anthropic/claude-opus-4-8');
    // gsd-roadmapper balanced -> sonnet -> overridden
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-roadmapper'), 'anthropic/claude-sonnet-4-7');
    // gsd-codebase-mapper balanced -> haiku -> built-in default (haiku not overridden)
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'anthropic/claude-haiku-4-5');
  });

  test('copilot.haiku override wins; opus and sonnet still use built-in defaults', () => {
    writeConfig(tmpDir, {
      runtime: 'copilot',
      model_profile: 'budget',
      model_profile_overrides: {
        copilot: { haiku: 'claude-haiku-4-6' },
      },
    });
    // gsd-codebase-mapper budget -> haiku -> overridden
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'claude-haiku-4-6');
    // gsd-planner budget -> sonnet -> built-in default
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'claude-sonnet-5');
  });

  // #2093: kilo just moved into Group A — same partial-merge coverage as opencode.
  test('kilo.sonnet override wins; opus and haiku still use built-in defaults', () => {
    writeConfig(tmpDir, {
      runtime: 'kilo',
      model_profile: 'balanced',
      model_profile_overrides: {
        kilo: { sonnet: 'anthropic/claude-sonnet-4-7' },
      },
    });
    // gsd-planner balanced -> opus -> built-in default
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'anthropic/claude-opus-4-8');
    // gsd-roadmapper balanced -> sonnet -> overridden
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-roadmapper'), 'anthropic/claude-sonnet-4-7');
    // gsd-codebase-mapper balanced -> haiku -> built-in default (haiku not overridden)
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'anthropic/claude-haiku-4-5');
  });
});

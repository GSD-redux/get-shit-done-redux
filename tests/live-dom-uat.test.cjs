'use strict';

/**
 * live-dom-uat capability — #2856
 *
 * Enhancement shape approved at triage: browser MCP reach is NOT added to
 * agents/gsd-executor.md. Instead a default-off capability owns one boolean
 * config key, one purpose-built agent that carries the browser globs in its
 * OWN tools: line, and one additive step hook at execute:wave:post.
 *
 * Risk zone under test (in order):
 *   1. Containment — no browser reach when workflow.live_dom_uat is off.
 *   2. No regression of the pre-existing mcp__playwright__* path in verify-work.
 *   3. The key must not parse-and-do-nothing.
 *
 * Rules honoured: behavioural assertions against the real resolver + real
 * generated registry; shipped-.md reads only where the deployed text IS the
 * runtime contract (agent/workflow markdown), each site carrying an adjacent
 * allow-test-rule marker.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { resolveLoopHooks } = require('../gsd-core/bin/lib/loop-resolver.cjs');
const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');
const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');

const REPO_ROOT = path.join(__dirname, '..');

const CAP_ID = 'live-dom-uat';
const KEY = 'workflow.live_dom_uat';
const AGENT = 'gsd-dom-verifier';
const POINT = 'execute:wave:post';

/** The browser MCP families this capability grants — the single source of truth. */
const BROWSER_GLOBS = ['mcp__chrome-devtools__*', 'mcp__claude-in-chrome__*'];

const AGENT_PATH = path.join(REPO_ROOT, 'agents', `${AGENT}.md`);
const EXECUTOR_PATH = path.join(REPO_ROOT, 'agents', 'gsd-executor.md');
const UI_VERIFY_PATH = path.join(
  REPO_ROOT, 'gsd-core', 'workflows', 'verify-work', 'steps', 'automated-ui-verification.md',
);
const MANIFEST_PATH = path.join(REPO_ROOT, 'capabilities', CAP_ID, 'capability.json');

const CANONICAL_POINTS = [
  'discuss:pre', 'discuss:post', 'plan:pre', 'plan:post',
  'execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post',
  'verify:pre', 'verify:post', 'ship:pre', 'ship:post',
];

/**
 * Synthetic registry carrying our real step declaration at execute:wave:post.
 * Mirrors the fixture shape in tests/loop-hooks-empty-points-e2e.test.cjs so the
 * resolver sees the same envelope production hands it.
 */
function buildRegistry() {
  const byLoopPoint = {};
  for (const p of CANONICAL_POINTS) byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
  byLoopPoint[POINT] = {
    steps: [{
      capId: CAP_ID,
      when: KEY,
      ref: { agent: AGENT },
      fragment: { path: 'fragments/execute-wave-post.md' },
      produces: ['DOM-VERIFY.md'],
      consumes: ['PLAN.md'],
      onError: 'skip',
    }],
    contributions: [],
    gates: [],
  };
  return { byLoopPoint, configSchema: { [KEY]: { default: false } } };
}

/** Resolve our hook out of a result, or undefined. */
function ourHook(result) {
  return result.activeHooks.find((h) => h.capId === CAP_ID);
}

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

/** Extract the `tools:` declaration from an agent's frontmatter as a token list. */
function agentTools(agentPath) {
  const src = fs.readFileSync(agentPath, 'utf8');
  const nl = src.indexOf('\n---', 3);
  const fm = src.slice(0, nl < 0 ? src.length : nl);
  const lines = fm.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith('tools:'));
  if (idx === -1) return [];
  const inline = lines[idx].slice('tools:'.length).trim();
  if (inline) return inline.split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = idx + 1; i < lines.length; i += 1) {
    const m = /^\s*-\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

/** Every mcp__ glob an agent declares, minus the context7 pair every agent may carry. */
function browserGlobsOf(agentPath) {
  return agentTools(agentPath)
    .filter((t) => t.startsWith('mcp__'))
    .filter((t) => !t.includes('context7'))
    .sort();
}

/**
 * The browser families named inside the workflow's key-gated live-DOM block.
 * The block is delimited by an HTML comment so this assertion has a stable
 * anchor and cannot drift onto unrelated prose elsewhere in the file.
 */
function liveDomBlock() {
  const src = fs.readFileSync(UI_VERIFY_PATH, 'utf8');
  const open = src.indexOf('<!-- gsd:live-dom-families -->');
  const close = src.indexOf('<!-- /gsd:live-dom-families -->');
  assert.ok(open !== -1, 'automated-ui-verification.md must open a gsd:live-dom-families block');
  assert.ok(close > open, 'automated-ui-verification.md must close the gsd:live-dom-families block');
  return src.slice(open, close);
}

// ─── 1. Registry projection ──────────────────────────────────────────────────

describe('live-dom-uat: capability manifest and registry projection', () => {
  test('manifestDeclaresDefaultOffBooleanKeyOwnedByThisCapability', () => {
    const m = readManifest();
    assert.equal(m.id, CAP_ID);
    assert.equal(m.activationKey, KEY, 'capability must be gated by its own activation key');
    const slice = m.config[KEY];
    assert.equal(slice.type, 'boolean', 'array/object slices are dropped as malformed');
    assert.equal(slice.default, false, 'the key is default-OFF — this is the containment');
  });

  test('manifestOwnsTheAgentAndDeclaresOneAdditiveStep', () => {
    const m = readManifest();
    assert.deepStrictEqual(m.agents, [AGENT]);
    assert.equal(m.steps.length, 1);
    const step = m.steps[0];
    assert.equal(step.point, POINT);
    assert.deepStrictEqual(step.ref, { agent: AGENT });
    assert.equal(step.when, KEY, 'step must carry the same key as the capability');
    assert.equal(step.onError, 'skip', 'a step hook is additive and must never halt the host');
  });

  test('manifestDeclaresNoGatesSoItCannotBlockTheHost', () => {
    const m = readManifest();
    assert.deepStrictEqual(m.gates, [], 'live-DOM verification is advisory, never blocking');
  });

  test('fragmentPathResolvesOnDisk', () => {
    const m = readManifest();
    const rel = m.steps[0].fragment.path;
    const abs = path.join(REPO_ROOT, 'capabilities', CAP_ID, rel);
    assert.ok(fs.statSync(abs).isFile(), `declared fragment must exist: ${rel}`);
    assert.ok(fs.statSync(abs).size > 0, 'fragment must not be empty');
  });

  test('manifestVersionMatchesSiblingSweep', () => {
    const sibling = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'research', 'capability.json'), 'utf8'),
    );
    assert.equal(readManifest().version, sibling.version,
      'capability versions move as one release-time sweep');
  });

  test('generatedRegistryProjectsKeyAgentAndLoopPoint', () => {
    assert.equal(realRegistry.configSchema[KEY].owner, CAP_ID);
    assert.equal(realRegistry.configSchema[KEY].type, 'boolean');
    assert.equal(realRegistry.configSchema[KEY].default, false);
    assert.ok(realRegistry.byAgent[AGENT], 'registry must index the agent');
    const steps = realRegistry.byLoopPoint[POINT].steps;
    assert.ok(steps.some((s) => s.capId === CAP_ID), `registry must carry a ${CAP_ID} step at ${POINT}`);
  });

  test('exactlyOneCapabilityOwnsTheKey', () => {
    const owners = Object.entries(realRegistry.configSchema)
      .filter(([k]) => k === KEY)
      .map(([, v]) => v.owner);
    assert.deepStrictEqual(owners, [CAP_ID], 'a config key may be owned by exactly one capability');
  });
});

// ─── 2. Containment: hook activation ─────────────────────────────────────────

describe('live-dom-uat: the hook does not render unless the key is on', () => {
  const ACTIVE = { [CAP_ID]: { enabled: true, active: true } };

  test('hookAbsentWhenKeyDefaultsOff', () => {
    const r = resolveLoopHooks({
      point: POINT, registry: buildRegistry(), config: {}, capabilityStatesById: ACTIVE,
    });
    assert.equal(ourHook(r), undefined, 'absent key must not activate browser reach');
  });

  test('hookAbsentWhenKeyExplicitlyFalse', () => {
    const r = resolveLoopHooks({
      point: POINT,
      registry: buildRegistry(),
      config: { workflow: { live_dom_uat: false } },
      capabilityStatesById: ACTIVE,
    });
    assert.equal(ourHook(r), undefined);
  });

  test('hookRendersWhenKeyOnAndCapabilityActive', () => {
    const r = resolveLoopHooks({
      point: POINT,
      registry: buildRegistry(),
      config: { workflow: { live_dom_uat: true } },
      capabilityStatesById: ACTIVE,
    });
    const hook = ourHook(r);
    assert.ok(hook, 'key on + capability active must render the step');
    assert.deepStrictEqual(hook.ref, { agent: AGENT });
    assert.equal(hook.kind, 'step');
  });

  test('resolvedStepIsAdditiveAndNeverHalts', () => {
    const r = resolveLoopHooks({
      point: POINT,
      registry: buildRegistry(),
      config: { workflow: { live_dom_uat: true } },
      capabilityStatesById: ACTIVE,
    });
    const hook = ourHook(r);
    assert.equal(hook.onError, 'skip');
    assert.notEqual(hook.blocking, true, 'a step hook must never be blocking');
  });

  test('hookAbsentWhenCapabilityConfigDisabled', () => {
    const r = resolveLoopHooks({
      point: POINT,
      registry: buildRegistry(),
      config: { workflow: { live_dom_uat: true } },
      capabilityStatesById: { [CAP_ID]: { enabled: true, active: false } },
    });
    assert.equal(ourHook(r), undefined,
      'installed-but-config-disabled must not render — the gate is fail-closed');
  });

  test('hookAbsentWhenCapabilityStateEntryMissing', () => {
    const r = resolveLoopHooks({
      point: POINT,
      registry: buildRegistry(),
      config: { workflow: { live_dom_uat: true } },
      capabilityStatesById: { 'some-other-cap': { enabled: true, active: true } },
    });
    assert.equal(ourHook(r), undefined, 'a missing state entry is fail-closed, not permissive');
  });

  test('withNoCapabilityStateMapTheKeyAloneStillGates', () => {
    // Production sometimes omits capabilityStatesById entirely; the `when` guard
    // is then the only gate and must still hold. Asserted for BOTH polarities so
    // this pins gating rather than the absence of a map.
    const off = resolveLoopHooks({ point: POINT, registry: buildRegistry(), config: {} });
    assert.equal(ourHook(off), undefined);
    const on = resolveLoopHooks({
      point: POINT, registry: buildRegistry(), config: { workflow: { live_dom_uat: true } },
    });
    assert.ok(ourHook(on), 'key on with no state map must still render');
  });
});

// ─── 3. The key must not parse-and-do-nothing ────────────────────────────────

describe('live-dom-uat: config key acceptance and coercion', () => {
  test('configKeyIsRecognisedByConfigValidation', () => {
    assert.equal(isValidConfigKey(KEY), true,
      'an unregistered key is silently dropped — the key would parse and do nothing');
  });

  test('configSetAcceptsAndPersistsTheKey', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(`config-set ${KEY} true`, tmpDir);
    assert.ok(result.success, `config-set must accept ${KEY}: ${result.error}`);

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8'));
    assert.strictEqual(cfg.workflow?.live_dom_uat, true, 'value must persist as a boolean');
  });

  test('configSetAcceptsFalse', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(`config-set ${KEY} false`, tmpDir);
    assert.ok(result.success, `config-set must accept false: ${result.error}`);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8'));
    assert.strictEqual(cfg.workflow?.live_dom_uat, false);
  });

  test('configSetRejectsANonBooleanValue', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(`config-set ${KEY} banana`, tmpDir);
    assert.ok(!result.success, 'config-set must reject a non-boolean for a boolean slice');
  });

  // The containment proof that matters: a value hand-written into config.json,
  // bypassing config-set's validation entirely. loadConfig's federated merge
  // type-checks the slice and substitutes the slice default, so the resolver
  // only ever sees a real boolean. Asserted end-to-end through the real
  // registry, because resolveLoopHooks alone gates on truthiness by design —
  // type safety is the config layer's job, and this proves the layers compose.
  for (const [label, value] of [
    ['stringTrue', '"true"'],
    ['stringFalse', '"false"'],
    ['numberOne', '1'],
    ['numberZero', '0'],
    ['nullValue', 'null'],
    ['emptyArray', '[]'],
    ['emptyObject', '{}'],
  ]) {
    test(`handWrittenNonBooleanNeverActivates_${label}`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));

      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'config.json'),
        `{"workflow":{"live_dom_uat":${value}}}`,
      );

      const cfg = loadConfig(tmpDir);
      assert.strictEqual(cfg.workflow?.live_dom_uat, false,
        `${label} must resolve to the slice default, not survive as a truthy value`);

      const r = resolveLoopHooks({
        point: POINT,
        registry: realRegistry,
        config: cfg,
        cwd: tmpDir,
        capabilityStatesById: { [CAP_ID]: { enabled: true, active: true } },
      });
      assert.equal(ourHook(r), undefined, `${label} must not activate browser reach`);
    });
  }

  test('absentKeyResolvesToTheSchemaDefault', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const cfg = loadConfig(tmpDir);
    assert.strictEqual(cfg.workflow?.live_dom_uat, false,
      'with no config written at all, the slice default is what the loop sees');
  });

  test('property: no hand-written non-boolean ever activates the hook', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const configPath = path.join(tmpDir, '.planning', 'config.json');

    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(0),
          fc.constant(''),
          fc.string(),
          fc.integer(),
          fc.array(fc.integer()),
          fc.dictionary(fc.string(), fc.integer()),
        ),
        (value) => {
          fs.writeFileSync(configPath, JSON.stringify({ workflow: { live_dom_uat: value } }));
          const cfg = loadConfig(tmpDir);
          if (cfg.workflow?.live_dom_uat !== false) return false;
          const r = resolveLoopHooks({
            point: POINT,
            registry: realRegistry,
            config: cfg,
            cwd: tmpDir,
            capabilityStatesById: { [CAP_ID]: { enabled: true, active: true } },
          });
          return ourHook(r) === undefined;
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ─── 4. Shipped-text contracts ───────────────────────────────────────────────

describe('live-dom-uat: shipped agent and workflow text', () => {
  test('domVerifierCarriesTheBrowserGlobsInItsOwnToolsLine', () => {
    // allow-test-rule: source-text-is-the-product (#2856)
    // An agent's frontmatter IS its tool grant at runtime; there is no API to
    // enumerate a not-yet-spawned agent's permissions.
    assert.deepStrictEqual(browserGlobsOf(AGENT_PATH), [...BROWSER_GLOBS].sort());
  });

  test('executorSurfaceIsUnchangedInEveryConfiguration', () => {
    // allow-test-rule: source-text-is-the-product (#2856)
    // Criterion 4 of the approved shape is an ABSENCE, observable only in the
    // deployed agent text. This is the guard against the shape that was refused.
    const tools = agentTools(EXECUTOR_PATH);
    for (const glob of BROWSER_GLOBS) {
      assert.ok(!tools.includes(glob),
        `gsd-executor must never carry ${glob} — triage refused widening its surface`);
    }
    assert.ok(!tools.some((t) => t.startsWith('mcp__') && !t.includes('context7')),
      'gsd-executor may carry no MCP family beyond context7');
  });

  test('browserGlobParityAcrossAgentAndWorkflowSurfaces', () => {
    // allow-test-rule: source-text-is-the-product (#2856)
    // Two surfaces now carry one list (DEFECT class: generative fix divergence).
    // This fails if either surface gains or loses a family without the other.
    const block = liveDomBlock();
    const named = BROWSER_GLOBS.filter((g) => block.includes(g)).sort();
    assert.deepStrictEqual(named, browserGlobsOf(AGENT_PATH),
      'the workflow detection block and the agent tools line must name the same families');
  });

  test('newFamilyBranchRequiresBothPresenceAndTheKey', () => {
    // allow-test-rule: source-text-is-the-product (#2856)
    const block = liveDomBlock();
    assert.ok(block.includes(KEY),
      'the new-family branch must name the config key — presence alone is not sufficient');
    for (const glob of BROWSER_GLOBS) {
      assert.ok(block.includes(glob), `the new-family branch must name ${glob}`);
    }
  });

  test('playwrightBranchIsNotGatedOnTheNewKey', () => {
    // allow-test-rule: source-text-is-the-product (#2856)
    // Hyrum's Law regression guard: mcp__playwright__* works today on presence +
    // ui-phase-active. Pulling it behind a default-off key would silently remove
    // working behaviour on upgrade. The playwright path must sit OUTSIDE the
    // key-gated block entirely.
    const src = fs.readFileSync(UI_VERIFY_PATH, 'utf8');
    const block = liveDomBlock();
    assert.ok(src.includes('mcp__playwright__'), 'the playwright path must still exist');
    assert.ok(!block.includes('mcp__playwright__'),
      'playwright must not be inside the key-gated block — that would be a silent regression');
  });
});

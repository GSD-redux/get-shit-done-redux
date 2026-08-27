'use strict';

/**
 * tests/mutation-tap-runner-wiring.test.cjs
 *
 * Pins the #3915 tap-runner wiring — the config contract AND the
 * workflow<->config parity, because the injected env token lives on two
 * surfaces (`.github/workflows/mutation.yml`'s per-shard `env:` block and
 * `stryker.config.mjs`'s reader of it) and silent drift between them would
 * make every shard silently fall back to running the FULL default test list
 * instead of its own module's tests — slow, wrong, and (because Stryker
 * would still find SOME test constraining each mutant) green.
 *
 * FAILING-FIRST (#3915): stryker.config.mjs still declares `testRunner:
 * 'command'` with a `commandRunner.command` built from `MUTATION_TEST_CMD`,
 * and mutation.yml still injects `MUTATION_TEST_CMD` / `matrix.isolation`.
 * Every test below targets the tap-runner shape those files do not have yet.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'stryker.config.mjs');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'mutation.yml');

// Env keys this config is known to read. Every key is saved/restored so a
// test's env override can never leak into a sibling test.
const RELEVANT_ENV_KEYS = ['MUTATION_TEST_FILES', 'MUTATION_TEST_CMD', 'MUTATION_BREAK'];

// Cache-busting counter: importing the SAME file:// URL twice returns the
// SAME cached ES module record, so an env-dependent config test that reused
// one URL across calls would silently observe the FIRST call's env forever —
// every subsequent env-dependent assertion would pass or fail for the wrong
// reason. Incrementing this per call forces a fresh module evaluation.
let _importCounter = 0;

/**
 * Load stryker.config.mjs with `env` applied on top of process.env for the
 * duration of the import, then restore process.env exactly. `env` values of
 * `undefined` delete the corresponding key rather than setting it.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<object>} the config module's default export
 */
async function loadConfig(env) {
  // Save/restore the UNION of RELEVANT_ENV_KEYS and Object.keys(env), not just the fixed
  // list: the PARITY test below discovers its env key NAME from the parsed workflow file
  // rather than hardcoding it, so a key outside RELEVANT_ENV_KEYS can reach here — saving
  // only the fixed list would let that discovered key leak into sibling tests.
  const keysToRestore = new Set([...RELEVANT_ENV_KEYS, ...Object.keys(env)]);
  const saved = {};
  for (const key of keysToRestore) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const mod = await import(`${pathToFileURL(CONFIG_PATH).href}?v=${_importCounter++}`);
    return mod.default;
  } finally {
    for (const key of keysToRestore) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('stryker.config.mjs: tap runner contract (#3915)', () => {
  test("testRunner === 'tap'", async () => {
    const config = await loadConfig({});
    assert.strictEqual(config.testRunner, 'tap');
  });

  test("coverageAnalysis === 'perTest'", async () => {
    const config = await loadConfig({});
    assert.strictEqual(config.coverageAnalysis, 'perTest');
  });

  test("coverageAnalysis !== 'off' (the literal condition #3915 requires to stop being true)", async () => {
    const config = await loadConfig({});
    assert.notStrictEqual(config.coverageAnalysis, 'off');
  });

  test('no own-property commandRunner (the command runner is gone)', async () => {
    const config = await loadConfig({});
    assert.ok(!Object.prototype.hasOwnProperty.call(config, 'commandRunner'));
  });

  test('tap.forceBail === false', async () => {
    const config = await loadConfig({});
    assert.strictEqual(config.tap.forceBail, false);
  });

  test('no own-property buildCommand, and tap has no own-property nodeArgs (no rebuild step reintroduced, ADR-457)', async () => {
    const config = await loadConfig({});
    assert.ok(!Object.prototype.hasOwnProperty.call(config, 'buildCommand'));
    assert.ok(!Object.prototype.hasOwnProperty.call(config.tap, 'nodeArgs'));
  });

  test('MUTATION_TEST_FILES set → tap.testFiles deep-equals the parsed entries', async () => {
    const config = await loadConfig({
      MUTATION_TEST_FILES: 'tests/frontmatter.unit.test.cjs tests/unusable-input.test.cjs',
    });
    assert.deepStrictEqual(config.tap.testFiles, [
      'tests/frontmatter.unit.test.cjs',
      'tests/unusable-input.test.cjs',
    ]);
  });

  test('MUTATION_BREAK set → thresholds.break reflects it unchanged (re-proved after the runner swap)', async () => {
    const config = await loadConfig({ MUTATION_BREAK: '72' });
    assert.strictEqual(config.thresholds.break, 72);
  });

  test('MUTATION_TEST_FILES set but empty → fail-closed survives all the way to config load', async () => {
    await assert.rejects(() => loadConfig({ MUTATION_TEST_FILES: '' }));
  });

  test('mutate scope unchanged by the runner swap', async () => {
    const config = await loadConfig({});
    assert.ok(Array.isArray(config.mutate));
    assert.ok(config.mutate.includes('gsd-core/bin/lib/**/*.cjs'));
    assert.ok(
      config.mutate.some((entry) => entry.startsWith('!gsd-core/bin/lib/')),
      'mutate array must still carry at least one !gsd-core/bin/lib/... exclusion'
    );
  });
});

describe('mutation.yml <-> stryker.config.mjs: injected env parity (#3915)', () => {
  const workflowDoc = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  const mutateJob = workflowDoc.jobs.mutate;
  const runStrykerStep = mutateJob.steps.find(
    (step) => typeof step.name === 'string' && step.name.startsWith('Run Stryker')
  );

  test("the 'Run Stryker' step exists", () => {
    assert.ok(runStrykerStep, "no step in the mutate job's steps has a name starting with 'Run Stryker'");
  });

  test('step.env has key MUTATION_TEST_FILES', () => {
    assert.ok(Object.prototype.hasOwnProperty.call(runStrykerStep.env, 'MUTATION_TEST_FILES'));
  });

  test('step.env does NOT have key MUTATION_TEST_CMD', () => {
    assert.ok(!Object.prototype.hasOwnProperty.call(runStrykerStep.env, 'MUTATION_TEST_CMD'));
  });

  test('MUTATION_TEST_FILES value references matrix.tests (derived from mutation-matrix.cjs)', () => {
    assert.ok(String(runStrykerStep.env.MUTATION_TEST_FILES).includes('matrix.tests'));
  });

  test('MUTATION_BREAK still references matrix.minScore', () => {
    assert.ok(Object.prototype.hasOwnProperty.call(runStrykerStep.env, 'MUTATION_BREAK'));
    assert.ok(String(runStrykerStep.env.MUTATION_BREAK).includes('matrix.minScore'));
  });

  test('no value anywhere in the step env mentions --test-isolation', () => {
    for (const value of Object.values(runStrykerStep.env)) {
      assert.ok(!String(value).includes('--test-isolation'), `unexpected --test-isolation reference: ${value}`);
    }
  });

  test('no value anywhere in the whole mutate job mentions matrix.isolation', () => {
    const serialized = JSON.stringify(mutateJob);
    assert.ok(!serialized.includes('matrix.isolation'), 'mutate job still references matrix.isolation');
  });

  test("the step's run string does not contain '${{' (no direct interpolation inside run:, CONTRIBUTING.md)", () => {
    assert.ok(!runStrykerStep.run.includes('${{'), 'run: block contains a direct ${{ }} interpolation');
  });

  test('PARITY: the env key name discovered from the workflow drives the config test directly, so the two surfaces cannot drift', async () => {
    // Find the key in step.env that starts with MUTATION_TEST_ — this is read
    // from the PARSED workflow document, not hardcoded, so a rename on either
    // surface (the workflow's env key, or stryker.config.mjs's reader of it)
    // breaks this test instead of the two silently drifting apart.
    const discoveredKey = Object.keys(runStrykerStep.env).find((k) => k.startsWith('MUTATION_TEST_'));
    assert.ok(discoveredKey, 'no MUTATION_TEST_* key found in the Run Stryker step env');

    const config = await loadConfig({ [discoveredKey]: 'tests/frontmatter.unit.test.cjs' });
    assert.deepStrictEqual(config.tap.testFiles, ['tests/frontmatter.unit.test.cjs']);
  });
});

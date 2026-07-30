'use strict';

/**
 * Reviewer config-key federation — ADR-2782 D9 (config half), Phase 4 (#2797).
 *
 * Four key families move from the central config-schema to federated `config`
 * slices owned by their lane capabilities. Three keys deliberately stay central,
 * because a key describing policy *across* lanes must not be federated *into*
 * one.
 *
 * The trap this suite exists to catch: two of the four families were governed by
 * central DYNAMIC PATTERNS rather than exact keys. `isCentralConfigKey` consults
 * those patterns, and `mergeFederatedConfig` skips every key for which it returns
 * true — so declaring a slice while the pattern survives yields an INERT slice
 * and a green build. Assertions here are on provenance (`isCentralConfigKey` vs
 * `isCapabilityConfigKey`), not merely on validity, because validity alone cannot
 * tell a working migration from a no-op.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const configSchema = require('../gsd-core/bin/lib/config-schema.cjs');
const capValidator = require('../gsd-core/bin/lib/capability-validator.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const gen = require('../scripts/gen-capability-registry.cjs');

/** Keys that moved to a lane capability, with the lane that must own each. */
const FEDERATED = {
  'review.models.gemini': 'gemini',
  'review.models.claude': 'claude',
  'review.models.codex': 'codex',
  'review.models.opencode': 'opencode',
  // The suffix is the lane's binary/flag alias, NOT its slug `antigravity` —
  // preserved verbatim so existing .planning/config.json files keep working.
  'review.models.agy': 'antigravity',
  'review.models.ollama': 'ollama',
  'review.models.lm_studio': 'lm-studio',
  'review.models.llama_cpp': 'llama-cpp',
  'review.ollama_host': 'ollama',
  'review.lm_studio_host': 'lm-studio',
  'review.llama_cpp_host': 'llama-cpp',
  'review.max_prompt_tokens_per_reviewer.ollama': 'ollama',
  'review.max_prompt_tokens_per_reviewer.lm_studio': 'lm-studio',
  'review.max_prompt_tokens_per_reviewer.llama_cpp': 'llama-cpp',
};

/** Keys D9 names as staying central — policy across lanes, not lane properties. */
const CENTRAL_SURVIVORS = [
  'review.max_prompt_tokens',
  'review.default_reviewers',
  'review.reviewer_instances.myinstance.cli',
];

describe('reviewer config federation — provenance actually moved (#2797)', () => {
  test('every federated key is owned by a capability and no longer central', () => {
    for (const [key, owner] of Object.entries(FEDERATED)) {
      assert.equal(
        configSchema.isCentralConfigKey(key), false,
        `${key} must NOT be central — while it is, mergeFederatedConfig skips it and the slice is inert`,
      );
      assert.equal(
        configSchema.isCapabilityConfigKey(key), true,
        `${key} must be owned by a capability config slice`,
      );
      assert.equal(configSchema.isValidConfigKey(key), true, `${key} must remain valid`);
      assert.equal(
        registry.configSchema[key] && registry.configSchema[key].owner, owner,
        `${key} must be owned by "${owner}"`,
      );
    }
  });

  test('the keys D9 keeps central are untouched', () => {
    for (const key of CENTRAL_SURVIVORS) {
      assert.equal(configSchema.isCentralConfigKey(key), true, `${key} must stay central`);
      assert.equal(
        configSchema.isCapabilityConfigKey(key), false,
        `${key} describes policy across lanes and must not be federated into one`,
      );
    }
  });

  test('no capability claims a policy-across-lanes key', () => {
    const owned = new Set(Object.keys(registry.configSchema || {}));
    for (const key of ['review.max_prompt_tokens', 'review.default_reviewers', 'review.reviewer_instances']) {
      assert.equal(owned.has(key), false, `${key} must not appear in any capability slice`);
    }
  });

  test('the container key remains central so whole-object get/set still works', () => {
    // Only the per-slug leaves federate. Narrowing the container is a separate
    // decision D9 did not make; locking today's behavior so a future change is
    // deliberate rather than accidental.
    assert.equal(configSchema.isCentralConfigKey('review.max_prompt_tokens_per_reviewer'), true);
  });

  test('a lane with no model flag and no host owns no config keys', () => {
    // Absent-safe (ADR-2782 D4): qwen, cursor and coderabbit take neither a model
    // argument nor a host, so they declare nothing. That is not a coverage hole.
    const owners = Object.values(registry.configSchema || {}).map((e) => e && e.owner);
    for (const laneId of ['qwen', 'cursor', 'coderabbit']) {
      assert.equal(owners.includes(laneId), false, `${laneId} must declare no config keys`);
    }
  });
});

describe('reviewer config federation — the disclosed tightening (#2797)', () => {
  test('a model key naming no declared lane is rejected', () => {
    // Was accepted by the central pattern ^review\.models\.[a-zA-Z0-9_-]+$.
    // The exclusivity invariant forbids keeping that pattern alongside the
    // federated keys, so this tightening is unavoidable — and desirable: it
    // catches typos and stale keys that previously validated silently.
    assert.equal(configSchema.isValidConfigKey('review.models.__not_a_lane__'), false);
  });

  test('a per-lane budget key naming no declared lane is rejected', () => {
    assert.equal(
      configSchema.isValidConfigKey('review.max_prompt_tokens_per_reviewer.__nope__'), false,
    );
  });

  test('the hyphenated capability id is not a config key', () => {
    // The directory is `lm-studio`; the config key uses the slug `lm_studio`.
    // Conflating them yields a key no user has ever set.
    assert.equal(configSchema.isValidConfigKey('review.lm-studio_host'), false);
    assert.equal(configSchema.isValidConfigKey('review.lm_studio_host'), true);
  });
});

describe('reviewer config federation — end-to-end through the CLI (#2797)', () => {
  test('a federated model key round-trips: set, persist, get', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const set = runGsdTools('config-set review.models.ollama llama3', tmpDir);
    assert.ok(set.success, `config-set must accept the federated key: ${set.error || ''}`);

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    assert.equal(cfg.review?.models?.ollama, 'llama3', 'value must be persisted');

    const get = runGsdTools('query config-get review.models.ollama --raw', tmpDir);
    assert.ok(get.success, 'config-get must resolve the federated key');
  });

  test('a federated host key round-trips', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const set = runGsdTools('config-set review.ollama_host http://127.0.0.1:9999', tmpDir);
    assert.ok(set.success, `config-set must accept the federated host key: ${set.error || ''}`);

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    assert.equal(cfg.review?.ollama_host, 'http://127.0.0.1:9999');
  });

  test('a central survivor still round-trips unchanged', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const set = runGsdTools('config-set review.max_prompt_tokens 8000', tmpDir);
    assert.ok(set.success, `the global budget must stay settable: ${set.error || ''}`);

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    assert.equal(cfg.review?.max_prompt_tokens, 8000);
  });

  test('an existing config carrying federated keys loads unchanged — no migration', (t) => {
    // The acceptance criterion: key NAMES and existing files are unchanged; only
    // validation provenance moved. A file written before this phase must still load.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const cfgPath = path.join(tmpDir, '.planning', 'config.json');
    const pre = {
      review: {
        models: { ollama: 'llama3', agy: 'gemini-3-pro' },
        ollama_host: 'http://localhost:11434',
        max_prompt_tokens_per_reviewer: { ollama: 6000 },
        max_prompt_tokens: 8000,
      },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(pre, null, 2));

    const get = runGsdTools('query config-get review.models.ollama --raw', tmpDir);
    assert.ok(get.success, 'a pre-existing federated value must still resolve');

    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    assert.deepEqual(after, pre, 'reading must not rewrite the file');
  });

  test('an unset per-lane budget resolves to the -1 sentinel, not 0', (t) => {
    // 0 is a LEGITIMATE per-lane budget meaning "do not trim this lane" — the
    // guard in prepare_trimmed_prompt_for_reviewer returns early on it. A
    // federated key always resolves to its declared default, so if that default
    // were 0, "unset" and "deliberately disabled" would be indistinguishable and
    // the workflow's fallback-to-global branch could not tell them apart.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const get = runGsdTools(
      'query config-get review.max_prompt_tokens_per_reviewer.ollama --raw', tmpDir,
    );
    assert.strictEqual((get.output || '').trim(), '-1',
      'an unset per-lane budget must read back as the -1 sentinel');
  });

  test('an explicit per-lane budget of 0 survives federation', (t) => {
    // The regression this guards: treating 0 as "unset" in the workflow fallback
    // would silently switch a user who disabled trimming for one lane onto the
    // global budget instead.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const set = runGsdTools('config-set review.max_prompt_tokens_per_reviewer.ollama 0', tmpDir);
    assert.ok(set.success, `config-set must accept an explicit 0: ${set.error || ''}`);

    const get = runGsdTools(
      'query config-get review.max_prompt_tokens_per_reviewer.ollama --raw', tmpDir,
    );
    assert.strictEqual((get.output || '').trim(), '0',
      'an explicit 0 must survive as 0, distinguishable from unset');
  });

  test('an explicit per-lane budget value round-trips', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    runGsdTools('config-set review.max_prompt_tokens_per_reviewer.ollama 6000', tmpDir);
    const get = runGsdTools(
      'query config-get review.max_prompt_tokens_per_reviewer.ollama --raw', tmpDir,
    );
    assert.strictEqual((get.output || '').trim(), '6000');
  });

  test('a model key naming no declared lane is rejected by the CLI', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const set = runGsdTools('config-set review.models.__not_a_lane__ x', tmpDir);
    assert.equal(set.success, false, 'an unknown lane key must be rejected, not silently accepted');
  });
});

describe('exclusivity gate sees dynamic patterns (#2797)', () => {
  const slice = { type: 'string', default: '', description: 'x' };
  const capWith = (key) => new Map([['acme', { config: { [key]: slice } }]]);

  test('the shipped capability set passes the extended gate', () => {
    // The production-shape row: proves the cutover is COMPLETE, not merely
    // declared. If any federated key still had a central pattern, this fails.
    const errors = capValidator.validateCrossCapability(
      new Map(Object.entries(registry.capabilities || {})),
      gen.loadCentralConfigKeys(),
      gen.loadCentralConfigPatterns(),
    );
    assert.deepEqual(errors, [], `shipped capabilities must pass: ${JSON.stringify(errors)}`);
  });

  test('a federated key colliding with a central PATTERN fails the gate', () => {
    // The gap this phase closes. `centralKeys` is built from validKeys alone, so
    // before the fix this returned [] and the inert slice shipped green.
    const errors = capValidator.validateCrossCapability(
      capWith('review.reviewer_instances.acme.cli'),
      new Set(),
      gen.loadCentralConfigPatterns(),
    );
    assert.equal(errors.length, 1, `expected one pattern-collision error, got ${JSON.stringify(errors)}`);
    assert.match(errors[0], /matched by central config-schema pattern/);
    assert.match(errors[0], /review\.reviewer_instances\.acme\.cli/);
  });

  test('a federated key colliding with an exact central key still fails', () => {
    const errors = capValidator.validateCrossCapability(
      capWith('review.max_prompt_tokens'),
      new Set(['review.max_prompt_tokens']),
      [],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /exists in the central config-schema/);
  });

  test('a cleanly federated key passes', () => {
    const errors = capValidator.validateCrossCapability(
      capWith('review.models.ollama'),
      gen.loadCentralConfigKeys(),
      gen.loadCentralConfigPatterns(),
    );
    assert.deepEqual(errors, []);
  });

  test('two capabilities declaring one key still collide', () => {
    const errors = capValidator.validateCrossCapability(
      new Map([
        ['a', { config: { 'x.y': slice } }],
        ['b', { config: { 'x.y': slice } }],
      ]),
      new Set(),
      [],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /owned by both/);
  });

  test('omitting the patterns argument preserves the pre-#2797 signature', () => {
    // Back-compat: existing callers passing two arguments must not start seeing
    // pattern errors they cannot act on.
    const errors = capValidator.validateCrossCapability(
      capWith('review.reviewer_instances.acme.cli'),
      new Set(),
    );
    assert.deepEqual(errors, []);
  });

  test('loadCentralConfigPatterns reads the same manifest the runtime reads', () => {
    const pats = gen.loadCentralConfigPatterns();
    assert.ok(pats.length > 0, 'expected the central schema to declare patterns');
    for (const p of pats) assert.ok(p instanceof RegExp);
    // The two families this phase removed must be gone.
    const sources = pats.map((p) => p.source);
    assert.equal(sources.some((s) => s.includes('review\\.models')), false,
      'the review.models pattern must be removed — it is federated now');
    assert.equal(sources.some((s) => s.includes('max_prompt_tokens_per_reviewer')), false,
      'the per-reviewer budget pattern must be removed — it is federated now');
  });

  test('an absent manifest returns no patterns — the legitimate case', () => {
    assert.deepEqual(gen.loadCentralConfigPatterns('/nonexistent/path.json'), []);
  });

  test('a MALFORMED manifest throws rather than silently reporting no patterns', (t) => {
    // Fail-open here would defeat the gate this function exists to feed: with
    // zero patterns, the pattern-collision check silently passes and an inert
    // federated slice ships green. `loadCentralConfigKeys` reads the same file
    // and throws on the same failure class — the two must not disagree about
    // what a broken manifest means.
    const dir = createTempDir('gsd-2797-badmanifest-');
    t.after(() => cleanup(dir));

    const bad = path.join(dir, 'broken.json');
    fs.writeFileSync(bad, '{ "validKeys": [ this is not json');

    assert.throws(
      () => gen.loadCentralConfigPatterns(bad),
      (err) => err && /malformed|JSON/i.test(String(err.message)),
      'a broken manifest must fail closed, not return []',
    );
  });

  test('an unreadable manifest path throws rather than returning no patterns', (t) => {
    // A directory where a file is expected yields EISDIR, not ENOENT — the
    // "absent" carve-out must not swallow it.
    const dir = createTempDir('gsd-2797-dirmanifest-');
    t.after(() => cleanup(dir));

    assert.throws(
      () => gen.loadCentralConfigPatterns(dir),
      'reading a directory as the manifest must fail closed',
    );
  });
});

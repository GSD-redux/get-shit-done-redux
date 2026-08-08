'use strict';

/**
 * `init.debug` — the dedicated init entry point for `/gsd:debug` (#3149).
 *
 * Prerequisite for #3128 condition 1: ADR-1671 admission gate (2), "a fact the
 * init seam demonstrably computes at a real entry point"
 * (`docs/adr/1671-dynamic-context-management-platform.md:122-131`). Before this,
 * `gsd-core/workflows/debug.md` was one of the last workflows with no `cmdInit*`
 * of its own, so no debug-scoped fact could ever be computed and any `when=` atom
 * naming one would have evaluated FALSE forever — the silent-exclusion bug that
 * rule exists to prevent.
 *
 * Matrix: `.gsd/phase/feat-3149-cmdinitdebug/50-test-matrix.md` groups A-E, G3.
 *
 * Every test drives the REAL CLI (`runGsdTools` spawns `gsd-tools.cjs`) rather
 * than requiring `cmdInitDebug` directly — the handler is not exported, and the
 * flag plumbing under test exists only at the `init-command-router.cjs` seam.
 * Same rationale recorded in `tests/section-manifest-init-facts.test.cjs:10-14`.
 *
 * Group A is the load-bearing half: this change's entire claim is "one round-trip
 * instead of three, with identical resolved values", so each A-row cross-checks
 * `init.debug` against the exact command it replaced.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runGsdTools, cleanup, createTempDir, createTempProject } = require('./helpers.cjs');

function writeConfig(tmpDir, config, { ws = null } = {}) {
  const dir = ws
    ? path.join(tmpDir, '.planning', 'workstreams', ws)
    : path.join(tmpDir, '.planning');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

/** Runs a gsd-tools query and parses its JSON, asserting a clean exit first. */
function runJson(argv, cwd, env = {}) {
  const result = runGsdTools(argv, cwd, env);
  assert.ok(result.success, `Command failed: ${result.error}`);
  return JSON.parse(result.output);
}

// ─── Group A: equivalence with the three calls init.debug replaces ──────────

describe('init.debug resolves identically to the three calls it replaces (matrix §A)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('init-debug-a-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('debug_dir matches state.load exactly (row A1)', () => {
    const viaInit = runJson(['init', 'debug'], tmpDir);
    const viaState = runJson(['query', 'state.load'], tmpDir);

    assert.equal(
      viaInit.debug_dir,
      viaState.debug_dir,
      'init.debug must resolve the same debug directory state.load does — debug.md builds ' +
      'debug_file_path from it (#2376) and a divergence silently writes sessions elsewhere'
    );
  });

  test('debug_dir agrees with state.load under an active workstream (row A2)', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'ws1'), { recursive: true });

    const viaInit = runJson(['init', 'debug'], tmpDir, { GSD_WORKSTREAM: 'ws1' });
    const viaState = runJson(['query', 'state.load'], tmpDir, { GSD_WORKSTREAM: 'ws1' });

    assert.equal(viaInit.debug_dir, viaState.debug_dir);
    assert.match(
      viaInit.debug_dir,
      /\/workstreams\/ws1\/debug$/,
      'an active workstream must scope debug_dir into that workstream, not the project root'
    );
  });

  test('commit_docs matches state.load (row A3)', () => {
    writeConfig(tmpDir, { planning: { commit_docs: false } });

    const viaInit = runJson(['init', 'debug'], tmpDir);
    const viaState = runJson(['query', 'state.load'], tmpDir);

    assert.equal(viaInit.commit_docs, viaState.config.commit_docs);
    assert.equal(viaInit.commit_docs, false, 'sanity: the configured value, not the default');
  });

  test('response_language matches state.load config (row A4)', () => {
    writeConfig(tmpDir, { response_language: 'es' });

    const viaInit = runJson(['init', 'debug'], tmpDir);
    const viaState = runJson(['query', 'state.load'], tmpDir);

    assert.equal(viaInit.response_language, viaState.config.response_language);
    assert.equal(viaInit.response_language, 'es');
  });

  test('debugger_model matches the resolve-model query (row A5)', () => {
    const viaInit = runJson(['init', 'debug'], tmpDir);
    const viaResolve = runJson(['query', 'resolve-model', 'gsd-debugger'], tmpDir);

    assert.equal(
      viaInit.debugger_model,
      viaResolve.model,
      'debug.md omits the model param when this is empty or "inherit" (#2517) — the value ' +
      'must be the same one resolve-model produced, not a re-derived default'
    );
  });

  test('tdd_mode matches config-get when set (row A6)', () => {
    writeConfig(tmpDir, { workflow: { tdd_mode: true } });

    const viaInit = runJson(['init', 'debug'], tmpDir);
    const viaConfigGet = runGsdTools(['query', 'config-get', 'workflow.tdd_mode', '--raw'], tmpDir);

    assert.ok(viaConfigGet.success);
    assert.equal(viaInit.tdd_mode, true);
    assert.equal(String(viaInit.tdd_mode), viaConfigGet.output.trim());
  });

  test('tdd_mode matches config-get when the key is absent (row A7)', () => {
    writeConfig(tmpDir, {});

    const viaInit = runJson(['init', 'debug'], tmpDir);
    const viaConfigGet = runGsdTools(['query', 'config-get', 'workflow.tdd_mode', '--raw'], tmpDir);

    assert.equal(viaInit.tdd_mode, false);
    assert.equal(String(viaInit.tdd_mode), viaConfigGet.output.trim());
  });

  test('tdd_mode matches config-get under workstream inheritance (row A8)', () => {
    // The one case where the two resolution paths could genuinely disagree:
    // `config-get` inherits from the ROOT config when an active workstream has
    // no config.json of its own (#2702, src/config.cts), while the init seam
    // reads loadConfig's root+workstream merge (src/config-loader.cts). Both
    // must land on the same boolean or the consolidation changes behavior for
    // workstream users.
    writeConfig(tmpDir, { workflow: { tdd_mode: true } });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'ws1'), { recursive: true });

    const viaInit = runJson(['init', 'debug'], tmpDir, { GSD_WORKSTREAM: 'ws1' });
    const viaConfigGet = runGsdTools(
      ['query', 'config-get', 'workflow.tdd_mode', '--raw'],
      tmpDir,
      { GSD_WORKSTREAM: 'ws1' }
    );

    assert.equal(viaInit.tdd_mode, true, 'the root value must be inherited, not lost');
    assert.equal(String(viaInit.tdd_mode), viaConfigGet.output.trim());
  });

  test('honors workflow.tdd_mode, ignores a bare top-level tdd_mode (row A9)', () => {
    // The invariant tests/debug-session-management.test.cjs used to guard by
    // grepping debug.md for `config-get workflow.tdd_mode`. Asserted here
    // behaviorally instead, which is strictly stronger: a bare top-level key
    // must NOT be honored, whatever the read mechanism.
    writeConfig(tmpDir, { tdd_mode: true });
    assert.equal(
      runJson(['init', 'debug'], tmpDir).tdd_mode,
      false,
      'a bare top-level tdd_mode key must be ignored — the canonical key is workflow.tdd_mode'
    );

    writeConfig(tmpDir, { workflow: { tdd_mode: true } });
    assert.equal(
      runJson(['init', 'debug'], tmpDir).tdd_mode,
      true,
      'the canonical workflow.tdd_mode key must be honored'
    );
  });
});

// ─── Group B: bundle shape ─────────────────────────────────────────────────

describe('init.debug bundle shape (matrix §B)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('init-debug-b-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('emits the documented field set (row B1)', () => {
    const output = runJson(['init', 'debug'], tmpDir);

    for (const key of ['project_root', 'debug_dir', 'commit_docs', 'debugger_model', 'tdd_mode', 'diagnose']) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(output, key),
        `init.debug must emit "${key}"`
      );
    }
    assert.ok(
      Object.prototype.hasOwnProperty.call(output, 'section_manifest'),
      'section_manifest must be present even when it degrades to null'
    );
  });

  test('omits response_language entirely when unset (row B2)', () => {
    writeConfig(tmpDir, {});
    const output = runJson(['init', 'debug'], tmpDir);

    assert.equal(
      Object.prototype.hasOwnProperty.call(output, 'response_language'),
      false,
      'withProjectRoot injects response_language ONLY when configured — an absent key means ' +
      '"English", and emitting null/"" instead would make absence look like a degraded read'
    );
  });

  test('debug_dir is an absolute POSIX path (row B3)', () => {
    const output = runJson(['init', 'debug'], tmpDir);

    assert.equal(output.debug_dir.includes('\\'), false, 'no backslash separators (#2376)');
    assert.ok(output.debug_dir.endsWith('/debug'), 'points at the debug directory');
    assert.notEqual(output.debug_dir, 'debug');
    assert.notEqual(output.debug_dir, '.planning/debug', 'must be absolute, never a bare relative literal');
  });

  test('succeeds with no .planning directory (row B4)', () => {
    const bare = createTempDir('init-debug-bare-');
    try {
      const result = runGsdTools(['init', 'debug'], bare);
      assert.ok(result.success, `must not require an initialized project: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.ok(output.debug_dir.endsWith('/debug'));
    } finally {
      cleanup(bare);
    }
  });

  test('succeeds on an empty config object (row B5)', () => {
    writeConfig(tmpDir, {});
    const output = runJson(['init', 'debug'], tmpDir);
    assert.equal(output.tdd_mode, false);
  });

  test('survives valid-JSON-not-an-object config (row B6)', () => {
    // Valid JSON that is not an object is the input class nobody enumerates:
    // every one of these parses cleanly and then fails on property access.
    for (const body of ['0', '"str"', '[]', 'null', 'true']) {
      fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), body);

      const result = runGsdTools(['init', 'debug'], tmpDir);
      assert.ok(result.success, `config.json = ${body} must degrade, not crash: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.equal(output.tdd_mode, false, `config.json = ${body} must resolve tdd_mode to false`);
      assert.ok(output.debug_dir.endsWith('/debug'));
    }
  });

  test('survives a present-but-empty config file (row B7)', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '');

    const result = runGsdTools(['init', 'debug'], tmpDir);
    assert.ok(result.success, `an empty config file must degrade, not crash: ${result.error}`);
    assert.equal(JSON.parse(result.output).tdd_mode, false);
  });

  test('is insensitive to CRLF in config.json (row B8)', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      '{\r\n  "workflow": {\r\n    "tdd_mode": true\r\n  }\r\n}\r\n'
    );

    const output = runJson(['init', 'debug'], tmpDir);
    assert.equal(output.tdd_mode, true, 'CRLF must not change how the config parses');
  });
});

// ─── Group C: --diagnose forwarding + CLI negative matrix ──────────────────

describe('init.debug --diagnose forwarding and hostile argv (matrix §C)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('init-debug-c-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('--diagnose surfaces as diagnose:true (row C1)', () => {
    const output = runJson(['init', 'debug', '--diagnose'], tmpDir);
    assert.equal(output.diagnose, true);
  });

  test('absent --diagnose is false, not undefined (row C2)', () => {
    const output = runJson(['init', 'debug'], tmpDir);
    assert.equal(output.diagnose, false);
    assert.notEqual(output.diagnose, undefined, 'parseNamedArgs materializes false; never leak undefined');
  });

  test('duplicate --diagnose is idempotent (row C3)', () => {
    const output = runJson(['init', 'debug', '--diagnose', '--diagnose'], tmpDir);
    assert.equal(output.diagnose, true);
  });

  test('ignores an unrecognized flag (row C4)', () => {
    const result = runGsdTools(['init', 'debug', '--nope'], tmpDir);
    assert.ok(result.success, `an unknown flag must not fail the command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.equal(output.diagnose, false);
  });

  test('survives a flag-shaped trailing token (row C5)', () => {
    const result = runGsdTools(['init', 'debug', '--diagnose', '--weird'], tmpDir);
    assert.ok(result.success, `must not crash on a flag-shaped token: ${result.error}`);
    assert.equal(JSON.parse(result.output).diagnose, true);
  });

  test('does not interpolate shell metacharacters (row C6)', () => {
    const canary = path.join(tmpDir, 'PWNED');
    const hostile = `; touch ${canary}; $(touch ${canary}) \`touch ${canary}\` && touch ${canary}`;

    const result = runGsdTools(['init', 'debug', hostile], tmpDir);

    assert.ok(result.success, `hostile argv must not fail the command: ${result.error}`);
    assert.equal(fs.existsSync(canary), false, 'no shell interpolation of an attacker-controlled argument');
    assert.equal(result.output.includes('    at '), false, 'no stack trace in non-debug output');
  });

  test('survives a very long argument (row C7/C8)', () => {
    const long = 'x'.repeat(8192);
    const unicode = 'ünïcødé-🐛-测试';

    for (const arg of [long, unicode]) {
      const result = runGsdTools(['init', 'debug', arg], tmpDir);
      assert.ok(result.success, `argument of length ${arg.length} must not crash: ${result.error}`);
      assert.equal(JSON.parse(result.output).diagnose, false);
    }
  });
});

// ─── Group D: section_manifest, null vs [] ─────────────────────────────────

describe('init.debug section_manifest degradation (matrix §D)', () => {
  let tmpDir;
  let manifestDir;

  beforeEach(() => {
    tmpDir = createTempProject('init-debug-d-');
    manifestDir = createTempDir('init-debug-d-manifest-');
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(manifestDir);
  });

  function withManifest(body) {
    const manifestPath = path.join(manifestDir, 'manifest.json');
    fs.writeFileSync(manifestPath, typeof body === 'string' ? body : JSON.stringify(body));
    return { GSD_SECTION_MANIFEST: manifestPath };
  }

  test('section_manifest is null while debug has no manifest key (row D1)', () => {
    // Drives the SHIPPED artifact deliberately: `debug` carries no gsd:section
    // markers until #3128, so the shipped manifest has no `debug` key and the
    // field must degrade to null — which debug.md reads as "read everything".
    const output = runJson(['init', 'debug'], tmpDir);
    assert.equal(output.section_manifest, null);
  });

  test('an explicit empty debug key computes [], not null (row D2)', () => {
    const output = runJson(['init', 'debug'], tmpDir, withManifest({ workflows: { debug: [] } }));

    assert.notEqual(output.section_manifest, null, 'a present key must never collapse to the degraded value');
    assert.deepEqual(output.section_manifest.included, []);
    assert.deepEqual(output.section_manifest.excluded, []);
  });

  test('selects an always-section for the debug workflow (row D3)', () => {
    // Proves the workflow key really is 'debug' — a handler passing the wrong
    // name would silently return null forever and look identical to D1.
    const output = runJson(['init', 'debug'], tmpDir, withManifest({
      workflows: {
        debug: [{ id: 'probe-protocol', when: 'always', read: 'gsd-core/workflows/debug/steps/probe-protocol.md' }],
      },
    }));

    assert.notEqual(output.section_manifest, null);
    assert.equal(output.section_manifest.workflow, 'debug');
    assert.deepEqual(output.section_manifest.included, ['probe-protocol']);
    assert.deepEqual(output.section_manifest.read, ['gsd-core/workflows/debug/steps/probe-protocol.md']);
  });

  test('a missing manifest file degrades to null (row D4)', () => {
    const missing = path.join(manifestDir, 'does-not-exist.json');
    assert.equal(fs.existsSync(missing), false, 'sanity: file must not exist');

    const result = runGsdTools(['init', 'debug'], tmpDir, { GSD_SECTION_MANIFEST: missing });
    assert.ok(result.success, `a missing manifest must not crash: ${result.error}`);
    assert.equal(JSON.parse(result.output).section_manifest, null);
  });

  test('a malformed manifest degrades to null (row D5)', () => {
    const result = runGsdTools(['init', 'debug'], tmpDir, withManifest('{ not json'));
    assert.ok(result.success, `a malformed manifest must not crash: ${result.error}`);
    assert.equal(JSON.parse(result.output).section_manifest, null);
  });

  test('a pre-6.1 flat manifest shape degrades to null (row D6)', () => {
    // The pre-#2992 shape had no workflow key at all. Accepting it would
    // mis-attribute some other workflow's sections to debug.
    const result = runGsdTools(['init', 'debug'], tmpDir, withManifest({ sections: [{ id: 'x', when: 'always' }] }));
    assert.ok(result.success);
    assert.equal(JSON.parse(result.output).section_manifest, null);
  });
});

// ─── Group E: PlanningPaths.debug ──────────────────────────────────────────

describe('planningPaths exposes the debug directory (matrix §E)', () => {
  const { planningPaths } = require('../gsd-core/bin/lib/planning-workspace.cjs');
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('init-debug-e-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('planningPaths exposes debug (row E1)', () => {
    assert.equal(planningPaths(tmpDir).debug, path.join(tmpDir, '.planning', 'debug'));
  });

  test('planningPaths.debug is workstream-scoped (row E2)', () => {
    assert.equal(
      planningPaths(tmpDir, 'feature-x').debug,
      path.join(tmpDir, '.planning', 'workstreams', 'feature-x', 'debug')
    );
  });

  test('planningPaths.debug does not weaken the traversal guard (row E4)', () => {
    assert.throws(() => planningPaths(tmpDir, '../../etc'), /invalid path characters/);
    assert.throws(() => planningPaths(tmpDir, 'foo/bar'), /invalid path characters/);
  });
});

// ─── Group G: regressions this change must not cause ───────────────────────

describe('init.debug does not widen the applicability grammar (matrix §G)', () => {
  test('WHEN_VOCABULARY is unchanged at 29 entries (row G3)', () => {
    // ADR-1671: the vocabulary is CLOSED and widening it is a coordinated
    // amendment. This PR delivers admission gate (2) only — the atom that
    // consumes it belongs to #3128, which owns the amendment.
    const { WHEN_VOCABULARY } = require('../gsd-core/bin/lib/workflow-fragments.cjs');
    assert.equal(WHEN_VOCABULARY.length, 29);
    assert.equal(WHEN_VOCABULARY.includes('flag:--diagnose'), false);
    assert.equal(WHEN_VOCABULARY.includes('flag:--runtime-probes'), false);
  });
});

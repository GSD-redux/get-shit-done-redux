'use strict';

/**
 * adr857-core-without-capabilities.test.cjs
 *
 * ADR-857 deliverable B — "the core loop ships and runs without any plug-in"
 * (Consequences, §"Positive": "The core loop ships and runs without any plug-in;
 * plan-phase.md/execute-phase.md shrink to the irreducible five steps.")
 *
 * Verified contracts:
 *   B1. All 12 canonical loop points return activeHooks:[] when every
 *       capability when-key is explicitly false (real registry, all-caps-off config).
 *   B2. The CLI `loop render-hooks <point>` exits 0 and emits activeHooks:[],
 *       placeholder rendered for representative points with all-caps-off config.
 *   B3. Init bundles for the 5-step loop's entry seam (plan-phase, execute-phase,
 *       verify-work) resolve with exit 0 and valid JSON when capabilities are off.
 *   B4. An EMPTY registry (byLoopPoint:{}) at all 12 points → activeHooks:[]
 *       (loop tolerates a capability-less install).
 *   B5. [BVA] Exactly one capability ON (tdd_mode) → that capability's points
 *       non-empty, all OTHER points still empty (caps are additive; core is baseline).
 *
 * RULESET: no readFileSync + .includes() on source files (source-grep ban).
 * All assertions drive real exported functions / subprocess and inspect typed results.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execFileSync } = require('child_process');

// ── Module under test ─────────────────────────────────────────────────────────

const {
  resolveLoopHooks,
  renderLoopHooks,
  CANONICAL_POINTS,
} = require('../gsd-core/bin/lib/loop-resolver.cjs');

// Real registry (compiled from capabilities/ at build time)
const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

// ── Helpers from test harness ─────────────────────────────────────────────────

const { cleanup } = require('./helpers.cjs');

// ── Paths ─────────────────────────────────────────────────────────────────────

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

// ── Config fixtures ───────────────────────────────────────────────────────────

/**
 * All 12 canonical loop points. Derived from the exported constant so the
 * assertion set cannot drift from the resolver's own authoritative list.
 */
const ALL_12_POINTS = [...CANONICAL_POINTS];

/**
 * All when-keys discovered from the real registry, set to false.
 * Built by scanning every hook in every loop point's steps/contributions/gates arrays.
 * This gives us a "caps-off" config that passes through the activation resolver as
 * explicitly false rather than relying on missing-key default behaviour.
 *
 * Structure: nested (workflow.* → workflow:{...}, intel.enabled → intel:{enabled:false})
 * because _getNestedConfigValue expects a nested object, not a flat dotted key.
 */
function buildAllFalseConfig() {
  const workflow = {};
  const intel = {};
  for (const point of ALL_12_POINTS) {
    const entry = realRegistry.byLoopPoint[point];
    if (!entry) continue;
    for (const kind of ['steps', 'contributions', 'gates']) {
      for (const hook of entry[kind] || []) {
        const when = hook.when;
        if (typeof when !== 'string' || !when) continue;
        if (when.startsWith('workflow.')) {
          const key = when.slice('workflow.'.length);
          workflow[key] = false;
        } else if (when === 'intel.enabled') {
          intel.enabled = false;
        }
        // Any future top-level keys would need extending here.
      }
    }
  }
  return { workflow, intel };
}

const ALL_FALSE_CONFIG = buildAllFalseConfig();

/**
 * All-false config with tdd_mode: true.
 * Only workflow.tdd_mode differs from ALL_FALSE_CONFIG.
 */
function buildTddOnlyConfig() {
  return {
    ...ALL_FALSE_CONFIG,
    workflow: { ...ALL_FALSE_CONFIG.workflow, tdd_mode: true },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Run gsd-tools subprocess and return { exitCode, output }.
 * Does NOT throw on non-zero exit — let the test assert.
 */
function runCli(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [GSD_TOOLS, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 30000,
    });
    return { exitCode: 0, output: stdout.trim() };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      output: err.stdout?.toString().trim() ?? '',
      error: err.stderr?.toString().trim() ?? '',
    };
  }
}

/** Create a temp project dir with a .planning/ sub-dir. */
function makeProject(configJson = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr857-b-'));
  const planning = path.join(dir, '.planning');
  fs.mkdirSync(planning, { recursive: true });
  if (configJson !== null) {
    fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify(configJson), 'utf8');
  }
  return dir;
}

/** Remove a temp dir safely. */
function removeTmp(dir) {
  if (dir) cleanup(dir);
}

// ─────────────────────────────────────────────────────────────────────────────
// B1. [happy/aggregate] All 12 points → activeHooks:[] with all-caps-off config
// ─────────────────────────────────────────────────────────────────────────────

describe('B1 — real registry, all-caps-off config: every canonical point resolves to activeHooks:[]', () => {
  test('all 12 CANONICAL_POINTS return activeHooks:[] simultaneously when every capability when-key is false', () => {
    const failures = [];
    for (const point of ALL_12_POINTS) {
      const result = resolveLoopHooks({
        point,
        registry: realRegistry,
        config: ALL_FALSE_CONFIG,
      });

      // Shape guard — result must be an object with an array
      assert.ok(result && typeof result === 'object', `${point}: result must be an object`);
      assert.ok(Array.isArray(result.activeHooks), `${point}: activeHooks must be an array`);

      if (result.activeHooks.length !== 0) {
        failures.push({
          point,
          count: result.activeHooks.length,
          capIds: result.activeHooks.map(h => h.capId),
        });
      }
    }

    // Genuine assertion: if any point has activeHooks, report them concretely.
    // This fails on regression to the specific wrong value, not just "not empty".
    assert.deepStrictEqual(
      failures,
      [],
      `Expected zero active hooks at all 12 points with all-caps-off config but got: ${JSON.stringify(failures)}`,
    );
  });

  test('CANONICAL_POINTS exports exactly 12 points', () => {
    assert.strictEqual(
      ALL_12_POINTS.length,
      12,
      `CANONICAL_POINTS must have 12 entries (ADR-857 §"Loop Extension Points (the 12)"), got ${ALL_12_POINTS.length}`,
    );
  });

  test('each of the 12 known point names is present in CANONICAL_POINTS', () => {
    const expected = [
      'discuss:pre', 'discuss:post',
      'plan:pre', 'plan:post',
      'execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post',
      'verify:pre', 'verify:post',
      'ship:pre', 'ship:post',
    ];
    for (const p of expected) {
      assert.ok(
        ALL_12_POINTS.includes(p),
        `Expected canonical point "${p}" to be in CANONICAL_POINTS`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B2. [happy] CLI render-hooks E2E: exit 0, activeHooks:[], placeholder rendered
// ─────────────────────────────────────────────────────────────────────────────

describe('B2 — CLI loop render-hooks: exit 0, activeHooks:[], placeholder for all-caps-off project', () => {
  let tmpDir;

  before(() => {
    tmpDir = makeProject(ALL_FALSE_CONFIG);
  });

  after(() => {
    removeTmp(tmpDir);
    tmpDir = null;
  });

  for (const point of ['plan:pre', 'execute:wave:post', 'ship:post']) {
    test(`loop render-hooks ${point} → exit 0, activeHooks:[], non-empty rendered placeholder`, () => {
      const { exitCode, output, error } = runCli(['loop', 'render-hooks', point], tmpDir);

      assert.strictEqual(
        exitCode,
        0,
        `Expected exit 0 for "loop render-hooks ${point}" with all-caps-off config; got ${exitCode}. stderr: ${error ?? ''}`,
      );

      // Must parse as JSON
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch (e) {
        assert.fail(`CLI output for ${point} is not valid JSON: ${output.slice(0, 200)}`);
      }

      // activeHooks must be present and empty
      assert.ok(
        Array.isArray(parsed.activeHooks),
        `${point}: activeHooks must be an array`,
      );
      assert.strictEqual(
        parsed.activeHooks.length,
        0,
        `${point}: expected activeHooks:[] with all-caps-off config, got ${JSON.stringify(parsed.activeHooks)}`,
      );

      // rendered field must be a non-empty placeholder string (loop still renders output)
      assert.ok(
        typeof parsed.rendered === 'string' && parsed.rendered.length > 0,
        `${point}: rendered must be a non-empty string, got ${JSON.stringify(parsed.rendered)}`,
      );

      // Genuine assertion: the placeholder contains the point name so it doesn't silently
      // return a generic empty string detached from the requested point.
      assert.ok(
        parsed.rendered.includes(point),
        `${point}: rendered placeholder must reference the point name "${point}", got: "${parsed.rendered}"`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B3. [happy] Init bundles resolve with exit 0 and valid JSON with caps off
// ─────────────────────────────────────────────────────────────────────────────

describe('B3 — init bundles for 5-step loop entry seam: exit 0 and valid JSON with capabilities off', () => {
  // Cases: the 5-step loop's main init entry points (those available without git)
  const INIT_CASES = [
    // #3884 (ADR-3473 §8.4): these three init subcommands take the phase as a
    // bare POSITIONAL (docs/CLI-TOOLS.md:775 `init plan-phase <phase>`, :787
    // `init execute-phase <phase>`) — there is no `--phase` flag for any of
    // them. Under the pre-#3884 permissive parser, `--phase 01-stub` silently
    // resolved to phase_found:false (args[2] literally became the string
    // "--phase"), which these tests never caught because they only checked
    // exit 0 and key PRESENCE. Corrected to the real, documented positional
    // form and strengthened to assert phase_found === true so a future
    // regression of this kind fails loudly instead of passing vacuously.
    {
      label: 'init plan-phase',
      args: ['init', 'plan-phase', '01-stub'],
      // Required fields that prove the bundle is a real JSON object used by the loop
      requiredFields: ['tdd_mode', 'phase_found', 'planning_exists'],
    },
    {
      label: 'init execute-phase',
      args: ['init', 'execute-phase', '01-stub'],
      requiredFields: ['tdd_mode', 'phase_found', 'config_exists'],
    },
    {
      label: 'init verify-work',
      args: ['init', 'verify-work', '01-stub'],
      requiredFields: ['phase_found', 'commit_docs'],
    },
  ];

  for (const { label, args, requiredFields } of INIT_CASES) {
    describe(label, () => {
      let tmpDir;

      before(() => {
        // Bare project with .planning/ but all caps off in config
        tmpDir = makeProject(ALL_FALSE_CONFIG);
        // A real phase directory matching the "01-stub" argument used by every
        // INIT_CASES entry above — without it, phase_found is trivially false
        // regardless of whether the CLI call shape is correct, and the
        // strengthened phase_found:true assertion below could not distinguish
        // a working positional form from the #3358-class silent-drop bug.
        fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-stub'), { recursive: true });
      });

      after(() => {
        removeTmp(tmpDir);
        tmpDir = null;
      });

      test(`${label} exits 0 with capabilities off`, () => {
        const { exitCode, error } = runCli(args, tmpDir);
        assert.strictEqual(
          exitCode,
          0,
          `${label}: expected exit 0 with all-caps-off project, got ${exitCode}. stderr: ${error ?? ''}`,
        );
      });

      test(`${label} returns parseable JSON with expected fields`, () => {
        const { output } = runCli(args, tmpDir);
        let parsed;
        try {
          parsed = JSON.parse(output);
        } catch (e) {
          assert.fail(`${label}: output is not valid JSON: ${output.slice(0, 200)}`);
        }
        assert.ok(
          parsed && typeof parsed === 'object' && !Array.isArray(parsed),
          `${label}: JSON must be a plain object`,
        );
        for (const field of requiredFields) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(parsed, field),
            `${label}: bundle must contain field "${field}", got keys: ${Object.keys(parsed).join(', ')}`,
          );
        }
        // Genuine assertion, not merely key presence (see the fix note on
        // INIT_CASES above): the seeded project has a real "01-stub" phase
        // directory, so the phase MUST actually resolve. A silently-dropped
        // phase argument still has a `phase_found` key (value `false`) — key
        // presence alone would pass on that defect.
        assert.strictEqual(
          parsed.phase_found,
          true,
          `${label}: phase "01-stub" must actually resolve (phase_found:true), got: ${JSON.stringify(parsed.phase_found)}`,
        );
      });

      test(`${label} returns parseable JSON with bare project (no config at all)`, () => {
        const bareDir = makeProject(null); // no config.json
        try {
          const { exitCode, output, error } = runCli(args, bareDir);
          assert.strictEqual(
            exitCode,
            0,
            `${label}: expected exit 0 with bare project (no config), got ${exitCode}. stderr: ${error ?? ''}`,
          );
          let parsed;
          try {
            parsed = JSON.parse(output);
          } catch (e) {
            assert.fail(`${label}: bare project output is not valid JSON: ${output.slice(0, 200)}`);
          }
          assert.ok(
            parsed && typeof parsed === 'object' && !Array.isArray(parsed),
            `${label}: bare project JSON must be a plain object`,
          );
        } finally {
          removeTmp(bareDir);
        }
      });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B4. [negative] Empty registry → activeHooks:[] at all 12 points
// ─────────────────────────────────────────────────────────────────────────────

describe('B4 — empty registry (byLoopPoint:{}) at all 12 points → activeHooks:[]', () => {
  const EMPTY_REGISTRY = {
    byLoopPoint: {},
    capabilities: {},
    configKeys: {},
    configSchema: {},
    commandFamilies: {},
  };

  test('loop tolerates a capability-less install: all 12 points return activeHooks:[]', () => {
    const failures = [];
    for (const point of ALL_12_POINTS) {
      const result = resolveLoopHooks({
        point,
        registry: EMPTY_REGISTRY,
        config: {},
      });
      assert.ok(
        result && typeof result === 'object',
        `${point}: result must be an object`,
      );
      assert.ok(
        Array.isArray(result.activeHooks),
        `${point}: activeHooks must be an array`,
      );
      if (result.activeHooks.length !== 0) {
        failures.push({
          point,
          count: result.activeHooks.length,
          capIds: result.activeHooks.map(h => h.capId),
        });
      }
    }
    assert.deepStrictEqual(
      failures,
      [],
      `Empty registry: expected zero active hooks at all 12 points, got non-empty at: ${JSON.stringify(failures)}`,
    );
  });

  test('empty registry does not throw for any of the 12 canonical points', () => {
    for (const point of ALL_12_POINTS) {
      assert.doesNotThrow(
        () => resolveLoopHooks({ point, registry: EMPTY_REGISTRY, config: {} }),
        `resolveLoopHooks must not throw for empty registry at point "${point}"`,
      );
    }
  });

  test('renderLoopHooks with empty activeHooks returns a non-empty placeholder string', () => {
    const placeholder = renderLoopHooks({ point: 'plan:pre', activeHooks: [] });
    assert.ok(
      typeof placeholder === 'string' && placeholder.length > 0,
      `renderLoopHooks must return a non-empty string for empty activeHooks, got: ${JSON.stringify(placeholder)}`,
    );
    // Specific value check — genuineness: this must change if the placeholder format changes
    assert.strictEqual(
      placeholder,
      '_No active hooks at plan:pre._',
      `renderLoopHooks placeholder must be "_No active hooks at plan:pre._", got: "${placeholder}"`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B5. [BVA] One capability ON (tdd_mode) → its 2 points non-empty, 10 others empty
// ─────────────────────────────────────────────────────────────────────────────

describe('B5 — BVA: tdd_mode ON, all other caps OFF → additive: only tdd points active', () => {
  // tdd contributes at plan:pre and execute:post (verified from capability registry)
  const TDD_ACTIVE_POINTS = ['plan:pre', 'execute:post'];
  const TDD_INACTIVE_POINTS = ALL_12_POINTS.filter(p => !TDD_ACTIVE_POINTS.includes(p));
  const TDD_ON_CONFIG = buildTddOnlyConfig();

  test('plan:pre has exactly 1 active hook and it belongs to tdd', () => {
    const result = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: TDD_ON_CONFIG,
    });
    assert.ok(Array.isArray(result.activeHooks), 'activeHooks must be an array');
    assert.strictEqual(
      result.activeHooks.length,
      1,
      `plan:pre: expected 1 active hook (tdd), got ${result.activeHooks.length}: ${JSON.stringify(result.activeHooks.map(h => h.capId))}`,
    );
    assert.strictEqual(
      result.activeHooks[0].capId,
      'tdd',
      `plan:pre: expected activeHooks[0].capId to be "tdd", got "${result.activeHooks[0].capId}"`,
    );
  });

  test('execute:post has exactly 1 active hook and it belongs to tdd', () => {
    const result = resolveLoopHooks({
      point: 'execute:post',
      registry: realRegistry,
      config: TDD_ON_CONFIG,
    });
    assert.ok(Array.isArray(result.activeHooks), 'activeHooks must be an array');
    assert.strictEqual(
      result.activeHooks.length,
      1,
      `execute:post: expected 1 active hook (tdd gate), got ${result.activeHooks.length}: ${JSON.stringify(result.activeHooks.map(h => h.capId))}`,
    );
    assert.strictEqual(
      result.activeHooks[0].capId,
      'tdd',
      `execute:post: expected activeHooks[0].capId to be "tdd", got "${result.activeHooks[0].capId}"`,
    );
  });

  test('all 10 non-tdd points return activeHooks:[] even with tdd_mode ON', () => {
    const failures = [];
    for (const point of TDD_INACTIVE_POINTS) {
      const result = resolveLoopHooks({
        point,
        registry: realRegistry,
        config: TDD_ON_CONFIG,
      });
      assert.ok(Array.isArray(result.activeHooks), `${point}: activeHooks must be an array`);
      if (result.activeHooks.length !== 0) {
        failures.push({
          point,
          count: result.activeHooks.length,
          capIds: result.activeHooks.map(h => h.capId),
        });
      }
    }
    assert.deepStrictEqual(
      failures,
      [],
      `Expected 10 non-tdd points to be empty with tdd_mode ON, got non-zero at: ${JSON.stringify(failures)}`,
    );
  });

  test('tdd hook at plan:pre is a contribution kind (not a gate or step)', () => {
    const result = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: TDD_ON_CONFIG,
    });
    assert.strictEqual(
      result.activeHooks.length,
      1,
      'Expected exactly 1 active hook at plan:pre with tdd ON',
    );
    assert.strictEqual(
      result.activeHooks[0].kind,
      'contribution',
      `plan:pre tdd hook must be kind "contribution", got "${result.activeHooks[0].kind}"`,
    );
  });

  test('tdd hook at execute:post is a gate kind (not a contribution or step)', () => {
    const result = resolveLoopHooks({
      point: 'execute:post',
      registry: realRegistry,
      config: TDD_ON_CONFIG,
    });
    assert.strictEqual(
      result.activeHooks.length,
      1,
      'Expected exactly 1 active hook at execute:post with tdd ON',
    );
    assert.strictEqual(
      result.activeHooks[0].kind,
      'gate',
      `execute:post tdd hook must be kind "gate", got "${result.activeHooks[0].kind}"`,
    );
  });

  test('turning tdd_mode OFF restores both tdd points to activeHooks:[]', () => {
    // Regression check: tdd_mode OFF → both previously-active points go back to empty
    const tddOffConfig = buildAllFalseConfig(); // tdd_mode: false
    for (const point of TDD_ACTIVE_POINTS) {
      const result = resolveLoopHooks({
        point,
        registry: realRegistry,
        config: tddOffConfig,
      });
      assert.strictEqual(
        result.activeHooks.length,
        0,
        `${point}: expected activeHooks:[] with tdd_mode OFF, got ${JSON.stringify(result.activeHooks.map(h => h.capId))}`,
      );
    }
  });
});

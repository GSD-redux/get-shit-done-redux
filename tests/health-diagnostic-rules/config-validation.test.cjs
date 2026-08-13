'use strict';

/**
 * Tests for `src/health-diagnostic-rules/config-validation.cts` (Phase 11,
 * #3309, ADR-3180 §8.2/§8.3/§8.5) — group "config.json validation": W003,
 * E005, W004, W008, W016, W012, W013, W014, W015, W022.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * Test matrix: .gsd/phase/refactor-3309-health-diagnostic-rule-table/50-test-matrix.md
 *
 * Fixture provenance (§8.5 + CONTRIBUTING "Fixture provenance (#2371)"):
 *
 * - W003, W008, W016 are STRUCTURAL ABSENCE (a file, or a key, is missing) —
 *   exempt from external-citation provenance, mirrors
 *   tests/health-diagnostic-rules/root-existence.test.cjs's own framing.
 * - E005, W004, W012, W013, W014, W015, W022 are MECHANICAL MUTATION: each
 *   fixture starts from `gsd-core/templates/config.json` (the real shipped
 *   shape, parsed once as `BASE_CONFIG`) with exactly ONE field changed to
 *   the invalid value under test, per the design doc's Fixture provenance
 *   §4. `w022`'s `models` key and `branching_strategy`/`context_window`/
 *   `phase_branch_template`/`milestone_branch_template` are not present in
 *   the shipped default at all (they are optional, additive keys) — for
 *   those the "one field changed" mutation is adding exactly that one key
 *   with its invalid value, the generic-mutation equivalent when there is no
 *   existing value to corrupt.
 *
 * Every fixture is driven through the REAL `buildPlanningSnapshot(cwd)`
 * against a REAL temp `.planning/` directory with a REAL config.json file
 * written to disk — mirrors tests/planning-snapshot.test.cjs's own
 * `writeConfig` helper exactly (same shape, same call site convention).
 *
 * TDD RED: `src/health-diagnostic-rules/config-validation.cts` does not
 * exist yet at the start of this batch — this file's
 * `require('../../gsd-core/bin/lib/health-diagnostic-rules/config-validation.cjs')`
 * throws MODULE_NOT_FOUND until this batch's implementation lands.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('../helpers.cjs');

const configValidation = require('../../gsd-core/bin/lib/health-diagnostic-rules/config-validation.cjs');
const { RULES } = configValidation;

const { buildPlanningSnapshot } = require('../../gsd-core/bin/lib/planning-snapshot.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK } = require('../../gsd-core/bin/lib/health-diagnostic.cjs');

// Real shipped default, parsed once — the mutation base for every
// MECHANICAL MUTATION fixture below (design doc Fixture provenance §4).
const TEMPLATE_CONFIG_PATH = path.join(__dirname, '..', '..', 'gsd-core', 'templates', 'config.json');
const BASE_CONFIG = JSON.parse(fs.readFileSync(TEMPLATE_CONFIG_PATH, 'utf-8'));

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeConfig(cwd, obj) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'config.json'), JSON.stringify(obj));
}

function writeRawConfig(cwd, rawText) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'config.json'), rawText);
}

// Deep-clones BASE_CONFIG and applies exactly one mutation, mirroring the
// design doc's "mechanical, rule-blind mutation of the real shipped
// template" fixture class.
function mutatedConfig(mutate) {
  const clone = JSON.parse(JSON.stringify(BASE_CONFIG));
  mutate(clone);
  return clone;
}

function ruleFor(code) {
  const rule = RULES.find((r) => r.code === code);
  assert.ok(rule, `rule ${code} not found in RULES`);
  return rule;
}

// ─── RULES shape ────────────────────────────────────────────────────────────

describe('RULES (config-validation group)', () => {
  test('exports exactly 10 rules: W003, E005, W004, W008, W016, W012, W013, W014, W015, W022', () => {
    assert.deepEqual(
      RULES.map((r) => r.code).sort(),
      ['E005', 'W003', 'W004', 'W008', 'W012', 'W013', 'W014', 'W015', 'W016', 'W022'].sort(),
    );
  });

  test('E005 is severity ERROR; the rest are severity WARNING', () => {
    assert.equal(ruleFor('E005').severity, SEVERITY.ERROR);
    for (const code of ['W003', 'W004', 'W008', 'W012', 'W013', 'W014', 'W015', 'W016', 'W022']) {
      assert.equal(ruleFor(code).severity, SEVERITY.WARNING, `${code} should be WARNING`);
    }
  });
});

// ─── W003 — config.json not found ───────────────────────────────────────────

describe('W003 — config.json not found', () => {
  test('fires when config.json is absent (structural absence)', (t) => {
    const cwd = createTempDir('gsd-3309-w003-1-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W003').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W003',
        severity: SEVERITY.WARNING,
        message: 'config.json not found',
        remedy: { action: REMEDY_ACTION.CREATE_CONFIG, risk: REMEDY_RISK.NONE, args: {} },
      },
    ]);
  });

  test('does not fire when config.json exists', (t) => {
    const cwd = createTempDir('gsd-3309-w003-2-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W003').check(snapshot), []);
  });
});

// ─── E005 — config.json JSON parse error ────────────────────────────────────

describe('E005 — config.json invalid JSON', () => {
  test('fires when config.json exists but is unparseable', (t) => {
    const cwd = createTempDir('gsd-3309-e005-1-');
    t.after(() => cleanup(cwd));
    writeRawConfig(cwd, '{ not valid json');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('E005').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'E005',
        severity: SEVERITY.ERROR,
        message: 'config.json: JSON parse error',
        remedy: { action: REMEDY_ACTION.RESET_CONFIG, risk: REMEDY_RISK.DESTRUCTIVE, args: {} },
      },
    ]);
  });

  test('does not fire when config.json is absent (that is W003s job)', (t) => {
    const cwd = createTempDir('gsd-3309-e005-2-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('E005').check(snapshot), []);
    assert.equal(ruleFor('W003').check(snapshot).length, 1);
  });

  test('does not fire when config.json is well-formed', (t) => {
    const cwd = createTempDir('gsd-3309-e005-3-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('E005').check(snapshot), []);
  });
});

// ─── W004 — invalid model_profile ───────────────────────────────────────────

describe('W004 — invalid model_profile', () => {
  test('fires on an invalid model_profile value (mutated shipped config)', (t) => {
    const cwd = createTempDir('gsd-3309-w004-1-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.model_profile = 'not-a-real-profile';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W004').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W004',
        severity: SEVERITY.WARNING,
        message: 'config.json: invalid model_profile "not-a-real-profile"',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Valid values: quality, balanced, budget, adaptive, inherit' },
        },
      },
    ]);
  });

  test('does not fire on a valid model_profile', (t) => {
    const cwd = createTempDir('gsd-3309-w004-2-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.model_profile = 'balanced';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W004').check(snapshot), []);
  });

  test('does not fire when model_profile is absent', (t) => {
    const cwd = createTempDir('gsd-3309-w004-3-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W004').check(snapshot), []);
  });
});

// ─── W008 — workflow.nyquist_validation absent ──────────────────────────────

describe('W008 — workflow.nyquist_validation absent', () => {
  test('fires when workflow is present but nyquist_validation key is deleted', (t) => {
    const cwd = createTempDir('gsd-3309-w008-1-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      delete c.workflow.nyquist_validation;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W008').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W008',
        severity: SEVERITY.WARNING,
        message: 'config.json: workflow.nyquist_validation absent (defaults to enabled but agents may skip)',
        remedy: { action: REMEDY_ACTION.ADD_NYQUIST_KEY, risk: REMEDY_RISK.NONE, args: {} },
      },
    ]);
  });

  test('does not fire when nyquist_validation is present (shipped default)', (t) => {
    const cwd = createTempDir('gsd-3309-w008-2-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W008').check(snapshot), []);
  });

  test('does not fire when workflow itself is absent (guard mirrors original)', (t) => {
    const cwd = createTempDir('gsd-3309-w008-3-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      delete c.workflow;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W008').check(snapshot), []);
  });
});

// ─── W016 — workflow.ai_integration_phase absent ────────────────────────────

describe('W016 — workflow.ai_integration_phase absent', () => {
  test('fires on the unmodified shipped default — ai_integration_phase is not in the template at all (structural absence)', (t) => {
    const cwd = createTempDir('gsd-3309-w016-1-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W016').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W016',
        severity: SEVERITY.WARNING,
        message:
          'config.json: workflow.ai_integration_phase absent (defaults to enabled — run /gsd-ai-integration-phase before planning AI system phases)',
        remedy: { action: REMEDY_ACTION.ADD_AI_INTEGRATION_PHASE_KEY, risk: REMEDY_RISK.NONE, args: {} },
      },
    ]);
  });

  test('does not fire when ai_integration_phase key is present', (t) => {
    const cwd = createTempDir('gsd-3309-w016-2-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.workflow.ai_integration_phase = true;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W016').check(snapshot), []);
  });

  test('does not fire when workflow itself is absent (guard mirrors original)', (t) => {
    const cwd = createTempDir('gsd-3309-w016-3-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      delete c.workflow;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W016').check(snapshot), []);
  });
});

// ─── W012 — invalid branching_strategy ──────────────────────────────────────

describe('W012 — invalid branching_strategy', () => {
  test('fires on an invalid branching_strategy value', (t) => {
    const cwd = createTempDir('gsd-3309-w012-1-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.branching_strategy = 'bogus-strategy';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W012').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W012',
        severity: SEVERITY.WARNING,
        message: 'config.json: invalid branching_strategy "bogus-strategy"',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Valid values: none, phase, milestone' },
        },
      },
    ]);
  });

  for (const valid of ['none', 'phase', 'milestone']) {
    test(`does not fire on valid branching_strategy "${valid}"`, (t) => {
      const cwd = createTempDir('gsd-3309-w012-valid-');
      t.after(() => cleanup(cwd));
      const cfg = mutatedConfig((c) => {
        c.branching_strategy = valid;
      });
      writeConfig(cwd, cfg);

      const snapshot = buildPlanningSnapshot(cwd);
      assert.deepEqual(ruleFor('W012').check(snapshot), []);
    });
  }

  test('does not fire when branching_strategy is absent', (t) => {
    const cwd = createTempDir('gsd-3309-w012-2-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W012').check(snapshot), []);
  });
});

// ─── W013 — context_window not a positive integer ───────────────────────────

describe('W013 — context_window not a positive integer', () => {
  test('fires on a non-integer context_window', (t) => {
    const cwd = createTempDir('gsd-3309-w013-1-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.context_window = 3.5;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W013').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W013',
        severity: SEVERITY.WARNING,
        message: 'config.json: context_window should be a positive integer, got "3.5"',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Set to 200000 (default) or 1000000 (for 1M models)' },
        },
      },
    ]);
  });

  test('fires on a non-positive context_window (boundary: 0)', (t) => {
    const cwd = createTempDir('gsd-3309-w013-2-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.context_window = 0;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.equal(ruleFor('W013').check(snapshot).length, 1);
  });

  test('fires on a negative context_window', (t) => {
    const cwd = createTempDir('gsd-3309-w013-3-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.context_window = -1;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.equal(ruleFor('W013').check(snapshot).length, 1);
  });

  test('does not fire on a valid positive integer (boundary: 1)', (t) => {
    const cwd = createTempDir('gsd-3309-w013-4-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.context_window = 1;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W013').check(snapshot), []);
  });

  test('does not fire on the conventional default (200000)', (t) => {
    const cwd = createTempDir('gsd-3309-w013-5-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.context_window = 200000;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W013').check(snapshot), []);
  });

  test('does not fire when context_window is absent', (t) => {
    const cwd = createTempDir('gsd-3309-w013-6-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W013').check(snapshot), []);
  });
});

// ─── W014 — phase_branch_template missing {phase} ───────────────────────────

describe('W014 — phase_branch_template missing {phase} placeholder', () => {
  test('fires when the placeholder is stripped', (t) => {
    const cwd = createTempDir('gsd-3309-w014-1-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.phase_branch_template = 'phase/no-placeholder-here';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W014').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W014',
        severity: SEVERITY.WARNING,
        message: 'config.json: phase_branch_template missing {phase} placeholder',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Template must include {phase} for phase number substitution' },
        },
      },
    ]);
  });

  test('does not fire when the placeholder is present', (t) => {
    const cwd = createTempDir('gsd-3309-w014-2-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.phase_branch_template = 'phase/{phase}';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W014').check(snapshot), []);
  });

  test('does not fire when phase_branch_template is absent', (t) => {
    const cwd = createTempDir('gsd-3309-w014-3-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W014').check(snapshot), []);
  });
});

// ─── W015 — milestone_branch_template missing {milestone} ──────────────────

describe('W015 — milestone_branch_template missing {milestone} placeholder', () => {
  test('fires when the placeholder is stripped', (t) => {
    const cwd = createTempDir('gsd-3309-w015-1-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.milestone_branch_template = 'milestone/no-placeholder-here';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W015').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W015',
        severity: SEVERITY.WARNING,
        message: 'config.json: milestone_branch_template missing {milestone} placeholder',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Template must include {milestone} for version substitution' },
        },
      },
    ]);
  });

  test('does not fire when the placeholder is present', (t) => {
    const cwd = createTempDir('gsd-3309-w015-2-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.milestone_branch_template = 'milestone/{milestone}';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W015').check(snapshot), []);
  });

  test('does not fire when milestone_branch_template is absent', (t) => {
    const cwd = createTempDir('gsd-3309-w015-3-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W015').check(snapshot), []);
  });
});

// ─── W022 — models malformed (3 internal conditions, 1 code) ───────────────

describe('W022 — config.json models malformed', () => {
  test('(a) unknown phase type key fires', (t) => {
    const cwd = createTempDir('gsd-3309-w022a-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = { not_a_real_phase_type: 'sonnet' };
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W022').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W022',
        severity: SEVERITY.WARNING,
        message: 'config.json: models has an unknown phase type "not_a_real_phase_type" which will be ignored',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: {
            command: 'Valid phase types: planning, discuss, research, execution, verification, completion',
          },
        },
      },
    ]);
  });

  test('(b) known phase type with an invalid tier value fires', (t) => {
    const cwd = createTempDir('gsd-3309-w022b-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = { planning: 'not-a-real-tier' };
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W022').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W022',
        severity: SEVERITY.WARNING,
        message: 'config.json: models.planning has an invalid tier value "not-a-real-tier" which will be ignored',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Valid tiers: opus, sonnet, haiku, inherit' },
        },
      },
    ]);
  });

  test('(c) models present but not an object fires, and does NOT also run (a)/(b)', (t) => {
    const cwd = createTempDir('gsd-3309-w022c-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = 'not-an-object';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W022').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W022',
        severity: SEVERITY.WARNING,
        message:
          'config.json: models is set to "not-an-object", but must be an object mapping phase types to tiers — this value will be ignored',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: {
            command: 'Set models to an object like {"planning": "sonnet"}, or remove the key to use profile defaults',
          },
        },
      },
    ]);
  });

  test('(c) an array also counts as "not an object" (Array.isArray guard)', (t) => {
    const cwd = createTempDir('gsd-3309-w022c-array-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = ['sonnet'];
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W022').check(snapshot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'W022');
  });

  test('multiple malformed entries in one models object each produce their own diagnostic', (t) => {
    const cwd = createTempDir('gsd-3309-w022-multi-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = { planning: 'bogus-tier', not_a_real_phase_type: 'sonnet' };
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W022').check(snapshot);
    assert.equal(diagnostics.length, 2);
    for (const d of diagnostics) assert.equal(d.code, 'W022');
  });

  test('does not fire when models is a well-formed object', (t) => {
    const cwd = createTempDir('gsd-3309-w022-ok-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = { planning: 'sonnet', research: 'inherit' };
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W022').check(snapshot), []);
  });

  test('does not fire when models is absent', (t) => {
    const cwd = createTempDir('gsd-3309-w022-absent-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W022').check(snapshot), []);
  });

  test('does not fire when models is null', (t) => {
    const cwd = createTempDir('gsd-3309-w022-null-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = null;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W022').check(snapshot), []);
  });
});

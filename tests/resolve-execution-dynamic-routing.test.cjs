/**
 * GSD Tools Tests - resolve-execution dynamic_routing MODEL escalation (#2068)
 *
 * Regression coverage for #2068: `cmdResolveExecution` (src/commands.cts) now
 * resolves the model via `resolveModelForTier(cwd, agentType, opts.attempt)`
 * instead of `resolveModelInternal`, so `dynamic_routing` escalates the MODEL
 * (heavy tier) per `--attempt`, not just the reasoning effort. When
 * `dynamic_routing` is disabled/absent, `resolveModelForTier` falls back to
 * `resolveModelInternal` and behavior is unchanged.
 *
 * gsd-executor's default routing tier is "standard" (one-step ladder to
 * "heavy" under the default max_escalations:1). gsd-codebase-mapper's default
 * routing tier is "light" (two-step ladder light -> standard -> heavy),
 * confirmed via gsd-core/bin/shared/model-catalog.json and by running the
 * built CLI directly before writing these assertions (see PR discussion).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function writeConfig(tmpDir, config) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify(config),
  );
}

function resolveExecution(tmpDir, agent, attempt) {
  const result = runGsdTools(`resolve-execution ${agent} --attempt ${attempt}`, tmpDir);
  assert.ok(result.success, `resolve-execution ${agent} --attempt ${attempt} failed: ${result.error}`);
  return JSON.parse(result.output);
}

describe('resolve-execution: dynamic_routing model escalation (#2068)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  describe('gsd-executor (default tier: standard)', () => {
    beforeEach(() => {
      writeConfig(tmpDir, {
        dynamic_routing: {
          enabled: true,
          tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        },
      });
    });

    test('attempt 0 resolves the default standard-tier model (sonnet)', () => {
      const parsed = resolveExecution(tmpDir, 'gsd-executor', 0);
      assert.strictEqual(parsed.model, 'sonnet');
      assert.ok(typeof parsed.effort === 'string' && parsed.effort.length > 0);
    });

    // FAIL-FIRST REGRESSION (#2068): before the fix, cmdResolveExecution called
    // resolveModelInternal (which ignores --attempt entirely), so this assertion
    // would observe "sonnet" instead of the escalated "opus". This is the case
    // that pins the bug fixed by routing through resolveModelForTier.
    test('attempt 1 escalates the MODEL to the heavy tier (opus) — fail-first regression for #2068', () => {
      const parsed = resolveExecution(tmpDir, 'gsd-executor', 1);
      assert.strictEqual(parsed.model, 'opus');
    });

    test('attempt 2 stays capped at the heavy tier (opus) — default max_escalations:1', () => {
      const parsed = resolveExecution(tmpDir, 'gsd-executor', 2);
      assert.strictEqual(parsed.model, 'opus');
    });

    test('attempt 3 stays capped at the heavy tier (opus) — default max_escalations:1', () => {
      const parsed = resolveExecution(tmpDir, 'gsd-executor', 3);
      assert.strictEqual(parsed.model, 'opus');
    });
  });

  describe('gsd-executor: dynamic_routing absent (non-opted-in behavior preserved)', () => {
    test('attempt 1 resolves the profile-resolved model (sonnet), unaffected by --attempt', () => {
      writeConfig(tmpDir, {});
      const parsed = resolveExecution(tmpDir, 'gsd-executor', 1);
      assert.strictEqual(
        parsed.model,
        'sonnet',
        'without dynamic_routing, resolveModelForTier must fall back to resolveModelInternal ' +
          'and --attempt must have no effect on the resolved model',
      );
    });
  });

  // ─── Escalation-CAP boundary (PR #2083 review follow-up) ──────────────────
  //
  // gsd-codebase-mapper's default tier is "light", giving a 3-tier ladder
  // (light -> standard -> heavy) that is longer than max_escalations:2, so the
  // cap-at-max_escalations behavior is actually observable (unlike
  // gsd-executor's 1-step ladder, where "at cap" and "past cap" look the same).
  //
  // Actual values confirmed by running the built CLI directly against a temp
  // project before writing these assertions:
  //   attempt 0 -> haiku (light)
  //   attempt 1 -> sonnet (standard)
  //   attempt 2 -> opus (heavy)   [== max_escalations]
  //   attempt 3 -> opus (heavy)   [max_escalations + 1; must not advance further]
  describe('gsd-codebase-mapper (default tier: light) — cap boundary at max_escalations', () => {
    beforeEach(() => {
      writeConfig(tmpDir, {
        dynamic_routing: {
          enabled: true,
          max_escalations: 2,
          tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        },
      });
    });

    test('attempt 0 resolves the default light-tier model (haiku)', () => {
      const parsed = resolveExecution(tmpDir, 'gsd-codebase-mapper', 0);
      assert.strictEqual(parsed.model, 'haiku');
    });

    test('attempt 1 escalates one step to the standard-tier model (sonnet)', () => {
      const parsed = resolveExecution(tmpDir, 'gsd-codebase-mapper', 1);
      assert.strictEqual(parsed.model, 'sonnet');
    });

    // Boundary: max_escalations - 1 (attempt 1) is covered above; this is
    // exactly max_escalations (attempt 2) — the ladder reaches its cap here.
    test('attempt 2 (== max_escalations) escalates fully to the heavy-tier model (opus)', () => {
      const parsed = resolveExecution(tmpDir, 'gsd-codebase-mapper', 2);
      assert.strictEqual(parsed.model, 'opus');
    });

    // Boundary: max_escalations + 1 (attempt 3) — the model must NOT advance
    // beyond heavy; it stays pinned at the cap reached at attempt 2.
    test('attempt 3 (== max_escalations + 1) stays capped at the heavy-tier model (opus), does not advance further', () => {
      const parsed = resolveExecution(tmpDir, 'gsd-codebase-mapper', 3);
      assert.strictEqual(parsed.model, 'opus');
    });
  });

  // #2068 (review WR-01/WR-02): with dynamic_routing ENABLED but NO --attempt
  // flag, the model must resolve via the classic profile path — symmetric with
  // effort (which also only consults the tier ladder when --attempt is explicit).
  // Without the gate, an omitted --attempt would silently switch the model to the
  // tier map (attempt 0) while effort stayed classic.
  describe('gsd-executor: dynamic_routing enabled but --attempt omitted (model stays classic)', () => {
    let tmpDir;
    beforeEach(() => {
      tmpDir = createTempProject();
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'config.json'),
        JSON.stringify({ dynamic_routing: { enabled: true, tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' } } }),
      );
    });
    afterEach(() => { cleanup(tmpDir); });

    test('no --attempt flag -> classic profile-resolved model (sonnet), not tier-map-driven', () => {
      const result = runGsdTools('resolve-execution gsd-executor', tmpDir);
      assert.ok(result.success, `command failed: ${result.error}`);
      const parsed = JSON.parse(result.output);
      assert.strictEqual(parsed.model, 'sonnet');
    });
  });
});

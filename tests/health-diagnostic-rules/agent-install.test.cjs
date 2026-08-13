'use strict';

/**
 * Tests for `src/health-diagnostic-rules/agent-install.cts` (Phase 11, #3309,
 * ADR-3180 §8.2/§8.3/§8.5) — the W010 rule (agent installation is
 * incomplete), 4 mutually exclusive trigger conditions ported from
 * `verify.cts:1992-2027`, plus the "0 missing 0 incomplete" (no diagnostic)
 * case and the `scope === SCOPE.UNREADABLE` silent case.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * Test matrix: .gsd/phase/refactor-3309-health-diagnostic-rule-table/50-test-matrix.md
 *
 * Fixture provenance (#2371): `checkAgentsInstalled` scans a REAL filesystem
 * agents directory, not `.planning/`. Per the design doc's Fixture
 * provenance §, this file REUSES rather than reinvents:
 *   - `createCompleteAgentsDir`/`withAgentsDirOverride` are copied verbatim
 *     from `tests/planning-snapshot.test.cjs`'s own `agentInstall field`
 *     describe block (Phase 11's own foundational batch already established
 *     this exact GSD_AGENTS_DIR-override technique for driving
 *     `buildPlanningSnapshot` against a controlled agents dir).
 *   - The manifest-driven "incomplete" fixture shape (a `gsd-file-manifest.json`
 *     alongside the agents dir, tracking a `.toml` key that is absent on disk
 *     for one agent) is copied from `tests/agent-install-check.test.cjs`'s
 *     "a partial manifest-backed local installation remains selected and
 *     incomplete" / "partial manifest: agent.toml absent but agent.md
 *     present" tests — the same manifest resolution
 *     (`readInstallManifest(path.dirname(agentsDir))`) `checkAgentsInstalled`
 *     itself uses.
 * Every fixture below is structural absence/presence of agent files, exempt
 * from the provenance concern (no document format is being modeled).
 *
 * Uses the REAL `buildPlanningSnapshot(cwd)` (`src/planning-snapshot.cts`)
 * for every case except the UNREADABLE-scope case, which constructs the
 * minimal `{agentInstall: {value, scope}}` slice a `Rule.check(snapshot)`
 * actually reads — not a mock of `checkAgentsInstalled` (no owner is
 * reimplemented or stubbed), just the documented `Scope` contract's
 * UNREADABLE member, which is not otherwise reachable through the real
 * filesystem scan without monkeypatching an owner internal.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('../helpers.cjs');

const planningSnapshotLib = require('../../gsd-core/bin/lib/planning-snapshot.cjs');
const { buildPlanningSnapshot } = planningSnapshotLib;
const { SCOPE } = require('../../gsd-core/bin/lib/planning-scope.cjs');
const { PACKAGE_NAME } = require('../../gsd-core/bin/lib/package-identity.cjs');
const { MODEL_PROFILES } = require('../../gsd-core/bin/lib/model-profiles.cjs');
const EXPECTED_AGENTS = Object.keys(MODEL_PROFILES);

const { RULES } = require('../../gsd-core/bin/lib/health-diagnostic-rules/agent-install.cjs');
const rule = RULES.find((r) => r.code === 'W010');

// ─── Fixture helpers (copied verbatim from tests/planning-snapshot.test.cjs's
// agentInstall describe block — see module header) ─────────────────────────

function createCompleteAgentsDir(agentsDir) {
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const agent of EXPECTED_AGENTS) {
    fs.writeFileSync(path.join(agentsDir, `${agent}.toml`), `name = "${agent}"\n`);
  }
}

function withAgentsDirOverride(t, agentsDir) {
  const saved = process.env['GSD_AGENTS_DIR'];
  process.env['GSD_AGENTS_DIR'] = agentsDir;
  t.after(() => {
    if (saved === undefined) delete process.env['GSD_AGENTS_DIR'];
    else process.env['GSD_AGENTS_DIR'] = saved;
  });
}

// Manifest-driven "incomplete agent" fixture shape, copied from
// tests/agent-install-check.test.cjs's partial-manifest tests (see module
// header). `agentsDir`'s PARENT directory is where checkAgentsInstalled
// resolves gsd-file-manifest.json from (readInstallManifest(dirname(agentsDir))).
function writeManifest(agentsDir, manifestFiles) {
  fs.writeFileSync(
    path.join(path.dirname(agentsDir), 'gsd-file-manifest.json'),
    JSON.stringify({ files: manifestFiles }),
  );
}

describe('agent-install rule (W010)', () => {
  test('module exports exactly one W010 rule', () => {
    assert.ok(rule, 'RULES must contain a W010 entry');
    assert.strictEqual(RULES.length, 1);
    assert.strictEqual(rule.code, 'W010');
    assert.strictEqual(rule.severity, 'warning');
  });

  test('0 missing 0 incomplete: all agents present — no diagnostic', (t) => {
    const cwd = createTempDir('gsd-3309-w010-clean-');
    t.after(() => cleanup(cwd));
    const agentsDir = path.join(cwd, 'agents-complete');
    createCompleteAgentsDir(agentsDir);
    withAgentsDirOverride(t, agentsDir);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.strictEqual(snapshot.agentInstall.scope, SCOPE.COMPLETE);
    assert.deepStrictEqual(rule.check(snapshot), []);
  });

  test('condition 1: zero agents installed at all (agents dir absent)', (t) => {
    const cwd = createTempDir('gsd-3309-w010-zero-');
    t.after(() => cleanup(cwd));
    const agentsDir = path.join(cwd, 'agents-absent');
    withAgentsDirOverride(t, agentsDir);
    // agentsDir deliberately never created.

    const snapshot = buildPlanningSnapshot(cwd);
    assert.strictEqual(snapshot.agentInstall.scope, SCOPE.COMPLETE);
    assert.strictEqual(snapshot.agentInstall.value.installed_agents.length, 0);

    const diagnostics = rule.check(snapshot);
    assert.strictEqual(diagnostics.length, 1);
    const [d] = diagnostics;
    assert.strictEqual(d.code, 'W010');
    assert.strictEqual(d.severity, 'warning');
    assert.strictEqual(
      d.message,
      `No GSD agents found in ${agentsDir} — Task(subagent_type="gsd-*") will fall back to general-purpose`,
    );
    assert.deepStrictEqual(d.remedy, {
      action: 'advise',
      risk: 'none',
      args: { command: `Run the GSD installer: npx ${PACKAGE_NAME}@latest` },
    });
  });

  test('condition 2: some agents incomplete (missing generated file), zero fully missing', (t) => {
    const cwd = createTempDir('gsd-3309-w010-incomplete-');
    t.after(() => cleanup(cwd));
    const agentsDir = path.join(cwd, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }
    const incompleteAgent = EXPECTED_AGENTS[0];
    // Manifest tracks every agent's .md (present) plus a .toml for
    // incompleteAgent only (absent on disk) — makes exactly one agent
    // incomplete while presence (missing_agents) stays empty.
    const manifestFiles = {};
    for (const agent of EXPECTED_AGENTS) manifestFiles[`agents/${agent}.md`] = {};
    manifestFiles[`agents/${incompleteAgent}.toml`] = {};
    writeManifest(agentsDir, manifestFiles);
    withAgentsDirOverride(t, agentsDir);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.strictEqual(snapshot.agentInstall.value.missing_agents.length, 0);
    assert.deepStrictEqual(snapshot.agentInstall.value.incomplete_agents, [incompleteAgent]);

    const diagnostics = rule.check(snapshot);
    assert.strictEqual(diagnostics.length, 1);
    const [d] = diagnostics;
    assert.strictEqual(d.code, 'W010');
    assert.strictEqual(
      d.message,
      `Incomplete agent installs (missing generated file): ${incompleteAgent} — affected workflows may fall back to general-purpose`,
    );
    assert.deepStrictEqual(d.remedy, {
      action: 'advise',
      risk: 'none',
      args: { command: `Re-run the GSD installer to complete the install: npx ${PACKAGE_NAME}@latest` },
    });
  });

  test('condition 3: both missing AND incomplete agents present', (t) => {
    const cwd = createTempDir('gsd-3309-w010-both-');
    t.after(() => cleanup(cwd));
    const agentsDir = path.join(cwd, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const [missingAgent, incompleteAgent, ...restAgents] = EXPECTED_AGENTS;
    // missingAgent: no files at all, no manifest entry — stays purely missing.
    for (const agent of [incompleteAgent, ...restAgents]) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }
    const manifestFiles = {};
    manifestFiles[`agents/${incompleteAgent}.md`] = {};
    manifestFiles[`agents/${incompleteAgent}.toml`] = {}; // absent on disk -> incomplete
    for (const agent of restAgents) manifestFiles[`agents/${agent}.md`] = {};
    writeManifest(agentsDir, manifestFiles);
    withAgentsDirOverride(t, agentsDir);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snapshot.agentInstall.value.missing_agents, [missingAgent]);
    assert.deepStrictEqual(snapshot.agentInstall.value.incomplete_agents, [incompleteAgent]);

    const diagnostics = rule.check(snapshot);
    assert.strictEqual(diagnostics.length, 1);
    const [d] = diagnostics;
    assert.strictEqual(d.code, 'W010');
    assert.strictEqual(
      d.message,
      `Missing 1 GSD agents: ${missingAgent}; incomplete agent installs (missing generated file): ${incompleteAgent} — affected workflows will fall back to general-purpose`,
    );
    assert.deepStrictEqual(d.remedy, {
      action: 'advise',
      risk: 'none',
      args: { command: `Run the GSD installer: npx ${PACKAGE_NAME}@latest` },
    });
  });

  test('condition 4: agents missing only (no incomplete)', (t) => {
    const cwd = createTempDir('gsd-3309-w010-missing-only-');
    t.after(() => cleanup(cwd));
    const agentsDir = path.join(cwd, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const [missingAgent, ...restAgents] = EXPECTED_AGENTS;
    for (const agent of restAgents) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }
    const manifestFiles = {};
    for (const agent of restAgents) manifestFiles[`agents/${agent}.md`] = {};
    writeManifest(agentsDir, manifestFiles);
    withAgentsDirOverride(t, agentsDir);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snapshot.agentInstall.value.missing_agents, [missingAgent]);
    assert.deepStrictEqual(snapshot.agentInstall.value.incomplete_agents, []);

    const diagnostics = rule.check(snapshot);
    assert.strictEqual(diagnostics.length, 1);
    const [d] = diagnostics;
    assert.strictEqual(d.code, 'W010');
    assert.strictEqual(
      d.message,
      `Missing 1 GSD agents: ${missingAgent} — affected workflows will fall back to general-purpose`,
    );
    assert.deepStrictEqual(d.remedy, {
      action: 'advise',
      risk: 'none',
      args: { command: `Run the GSD installer: npx ${PACKAGE_NAME}@latest` },
    });
  });

  test('scope UNREADABLE (agent scan itself threw): no diagnostic, mirrors verify.cts\'s silent catch', () => {
    // Minimal snapshot slice — see module header for why this is not an
    // owner mock: UNREADABLE is a real, documented Scope member that
    // buildAgentInstallField sets when checkAgentsInstalled throws
    // (planning-snapshot.cts's own try/catch), and the rule's whole
    // contract is `(snapshot) => Diagnostic[]` — it never calls the owner
    // itself.
    const snapshot = {
      agentInstall: {
        scope: SCOPE.UNREADABLE,
        value: {
          agents_installed: false,
          missing_agents: [],
          installed_agents: [],
          incomplete_agents: [],
          agents_dir: '',
          agent_runtime: 'claude',
        },
      },
    };
    assert.deepStrictEqual(rule.check(snapshot), []);
  });
});

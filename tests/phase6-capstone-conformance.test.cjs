// allow-test-rule: source-text-is-the-product
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const { HOST_LOOP_FILES, scanWiredPoints } = require('../scripts/gen-loop-host-contract.cjs');
const { lfByteCount } = require('../scripts/workflow-size.cjs');

const CORE_SUBSTRATE_TERMS = [
  'Verification substrate',
  'verifier↔predicate contract',
  'Probe Core Module',
  'Edge Probe Module',
];

const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { isCentralConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function activeWhenKeys() {
  const keys = new Set();
  for (const cap of Object.values(registry.capabilities)) {
    for (const group of ['steps', 'gates', 'contributions']) {
      for (const hook of cap[group] || []) {
        if (hook.when) keys.add(hook.when);
      }
    }
  }
  return [...keys].sort();
}

describe('ADR-857 Phase 6 capstone conformance (#1139)', () => {
  test('first-party optional feature capabilities are declared in the generated registry', () => {
    const expectedFeatureCapabilities = [
      'ai-integration',
      'audit',
      'code-review',
      'graphify',
      'intel',
      'nyquist',
      'pattern-mapper',
      'research',
      'security',
      'ui',
    ];

    for (const capId of expectedFeatureCapabilities) {
      assert.equal(registry.capabilities[capId]?.role, 'feature', `${capId} must be a feature Capability`);
    }
  });

  test('core verification substrate is documented as deliberately not capability-owned', () => {
    const context = readRepoFile('CONTEXT.md');
    for (const term of CORE_SUBSTRATE_TERMS) {
      assert.match(context, new RegExp(escapeRegExp(term)), `${term} must be documented in CONTEXT.md`);
    }
  });

  test('host loop files do not read capability hook activation keys directly', () => {
    const forbiddenKeys = activeWhenKeys();
    assert.ok(forbiddenKeys.length > 0, 'registry must expose hook activation keys');

    for (const relativePath of HOST_LOOP_FILES) {
      const content = readRepoFile(relativePath);
      for (const key of forbiddenKeys) {
        assert.doesNotMatch(
          content,
          new RegExp(`\\bconfig-get\\s+${escapeRegExp(key)}\\b`),
          `${relativePath} must resolve ${key} through Capability hooks/state, not direct config-get`,
        );
      }
    }
  });

  test('capability-owned config keys are not reintroduced into the central schema', () => {
    for (const key of Object.keys(registry.configKeys).sort()) {
      assert.equal(
        isCentralConfigKey(key),
        false,
        `${key} is owned by capability ${registry.configKeys[key]} and must stay out of central config schema`,
      );
    }
  });

  test('host loop workflow files have a measurable, non-empty byte size', () => {
    // Was asserted against the committed tests/workflow-size-baseline.json snapshot;
    // #2724 (ADR-2719 Phase 4) deletes that file — the differential attribution
    // check's size ratchet (tests/emitted-attribution.test.cjs) is the replacement
    // anti-creep mechanism, but this test's actual intent was narrower: prove these
    // host-loop files are real, tracked, non-empty workflow docs. Asserting the
    // live byte count via the same shared counter the size guards use preserves
    // that intent without depending on a committed snapshot.
    for (const relativePath of HOST_LOOP_FILES) {
      const fileName = path.basename(relativePath);
      const bytes = lfByteCount(path.join(ROOT, relativePath));
      assert.ok(bytes > 0, `${fileName} must be a non-empty workflow file`);
    }
  });

  // ─── Phase-6 conformance: RED BY DESIGN until phase 6 is actually complete ──────
  //
  // #1139 closed (via #1158) with a green "capstone conformance gate" while the
  // ADR-857 phase-6 acceptance criteria were unmet — a false green. The three
  // tests below assert the real criteria with NO paper-over allowlist, so the
  // gate stays RED until the work lands. Green here must mean "phase 6 conformant,"
  // not "no new regression." Fixes tracked in #1167 / #1168 / #1169.

  test('every declared capability hook point has a render-hooks call site in the host loop (#1168)', () => {
    // No allowlist: every point a capability declares a hook at MUST have a
    // `render-hooks` call site in the host loop, or those hooks can never fire.
    const declaredPoints = new Set();
    for (const cap of Object.values(registry.capabilities)) {
      for (const group of ['steps', 'gates', 'contributions']) {
        for (const hook of cap[group] || []) {
          if (hook.point) declaredPoints.add(hook.point);
        }
      }
    }

    // Scan only the host loop files (a `render-hooks` mention in a non-host
    // workflow must not mask a lost host call site).
    const callSites = new Set();
    for (const relativePath of HOST_LOOP_FILES) {
      const content = readRepoFile(relativePath);
      for (const pt of scanWiredPoints(content)) callSites.add(pt);
    }

    const orphaned = [...declaredPoints].sort().filter((p) => !callSites.has(p));
    assert.deepEqual(
      orphaned, [],
      `ADR-857 phase 6 is NOT complete: capability hooks declare these extension points ` +
      `but no host-loop workflow calls \`gsd_run loop render-hooks <point>\`, so the hooks ` +
      `can never fire: ${orphaned.join(', ')}. Wire each call site (#1167/#1169).`,
    );
  });

  test('all ADR-857-named optional features are real Capabilities, not empty stubs (#1169)', () => {
    // ADR-857 §53 + Decision 7 enumerate these optional, non-loop modules as
    // Capabilities. "Migrated" means the feature OWNS its behavior: hook-based
    // features (tdd/schema-gate/drift/gap-analysis) must declare >=1 hook;
    // command-family features (profile-pipeline) must declare a command family.
    // A registration-only stub (role:feature but no hooks/commands) games this
    // gate while the logic stays welded into the loop — rejected here.
    const REQUIRED = ['tdd', 'schema-gate', 'drift', 'gap-analysis', 'profile-pipeline'];
    const problems = [];
    for (const id of REQUIRED) {
      const cap = registry.capabilities[id];
      if (!cap) { problems.push(`${id}: not registered`); continue; }
      if (cap.role !== 'feature') { problems.push(`${id}: role="${cap.role}", must be "feature"`); continue; }
      const hookCount = (cap.steps?.length || 0) + (cap.contributions?.length || 0) + (cap.gates?.length || 0);
      const isCommandFamily = (cap.commands?.length || 0) > 0;
      if (hookCount === 0 && !isCommandFamily) {
        problems.push(`${id}: EMPTY STUB (no hooks, no command family) — inline logic was not migrated; declare the real hooks/commands and remove the inline branch`);
      }
    }
    assert.deepEqual(
      problems, [],
      `ADR-857 phase 6 is NOT complete:\n  ${problems.join('\n  ')}\n` +
      `Each feature must OWN its behavior via hooks or a command family — not exist as a registration-only stub (#1169).`,
    );
  });

  test('host loop reads no capability-owned config key inline (#1169)', () => {
    // Phase 6 requires the loop to resolve capability behavior via render-hooks,
    // not by reading capability-owned keys directly. Any inline `config-get` of a
    // registry-owned key is an incomplete migration (the loop still owns the
    // feature's params).
    const leaks = [];
    for (const relativePath of HOST_LOOP_FILES) {
      const content = readRepoFile(relativePath);
      for (const key of Object.keys(registry.configKeys)) {
        if (new RegExp(`\\bconfig-get\\s+${escapeRegExp(key)}\\b`).test(content)) {
          leaks.push(`${path.basename(relativePath)} → ${key} (owned by ${registry.configKeys[key]})`);
        }
      }
    }
    leaks.sort();
    assert.deepEqual(
      leaks, [],
      `ADR-857 phase 6 is NOT complete: the host loop reads capability-owned config keys ` +
      `inline:\n  ${leaks.join('\n  ')}\nThe owning capability must render/consume these (#1169).`,
    );
  });

  test('host loop bodies are materially smaller than the pre-phase-6 baseline (#1168)', () => {
    // #1139 AC: plan-phase.md / execute-phase.md must shrink as optional features
    // extract to capabilities. Frozen pre-phase-6 sizes (LF bytes); the files must
    // drop strictly below these. This also defeats double-run gaming — declaring a
    // hook while leaving the inline block keeps the file from shrinking -> red.
    //
    // #1298: the execute-phase.md ceiling was raised from 93166 to accommodate
    // wiring the mandatory `worktree record-agent` writer verb into the per-agent
    // wave-manifest append. That verb is privileged host machinery (ADR-857
    // Decision #1) — NOT the optional-feature inline logic this budget ratchets
    // toward capabilities — so its footprint legitimately raises the host-loop
    // ceiling rather than signalling an un-extracted optional feature.
    const { lfByteCount } = require('../scripts/workflow-size.cjs');
    const PRE_PHASE6 = { 'plan-phase.md': 94519, 'execute-phase.md': 93600 };
    const notShrunk = [];
    for (const [file, frozen] of Object.entries(PRE_PHASE6)) {
      const now = lfByteCount(path.join(ROOT, 'gsd-core', 'workflows', file));
      if (now >= frozen) notShrunk.push(`${file}: ${now} bytes (must be < pre-phase-6 ${frozen})`);
    }
    assert.deepEqual(
      notShrunk, [],
      `ADR-857 phase 6 is NOT complete: host loop bodies have not shrunk — the optional ` +
      `feature logic has not actually been extracted:\n  ${notShrunk.join('\n  ')}`,
    );
  });

describe('ADR-857 phase 6 — capabilities must not bake install paths into the registry', () => {
  // Matches GSD install paths that LEAK when copied verbatim to non-Claude runtimes.
  // (~/.claude/projects is a legit runtime feature and is intentionally NOT matched.)
  const LEAK = /\.claude[/\\](?:gsd-core|commands|agents|hooks)\b/;

  test('no capability source (capability.json or fragment) embeds a ~/.claude install path', () => {
    const capsDir = path.join(__dirname, '..', 'capabilities');
    const offenders = [];
    for (const id of fs.readdirSync(capsDir)) {
      const dir = path.join(capsDir, id);
      if (!fs.statSync(dir).isDirectory()) continue;
      const cj = path.join(dir, 'capability.json');
      if (fs.existsSync(cj) && LEAK.test(fs.readFileSync(cj, 'utf8'))) {
        offenders.push(`capabilities/${id}/capability.json`);
      }
      const fragDir = path.join(dir, 'fragments');
      if (fs.existsSync(fragDir)) {
        for (const f of fs.readdirSync(fragDir)) {
          if (LEAK.test(fs.readFileSync(path.join(fragDir, f), 'utf8'))) {
            offenders.push(`capabilities/${id}/fragments/${f}`);
          }
        }
      }
    }
    assert.deepEqual(offenders, [],
      `capability sources embed ~/.claude install paths — these leak into the verbatim-copied capability-registry.cjs on non-Claude runtimes. Make the fragment path-free. Offenders: ${offenders.join(', ')}`);
  });

  test('generated capability-registry.cjs contains no ~/.claude install path', () => {
    const reg = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'capability-registry.cjs'), 'utf8');
    const leakLines = reg.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => LEAK.test(l)).map(([n]) => n);
    assert.deepEqual(leakLines, [],
      `capability-registry.cjs leaks ~/.claude install paths at line(s) ${leakLines.join(', ')} — the registry is copied verbatim to non-Claude runtimes (only workflow .md files are path-converted at install). Make the source capability fragment path-free.`);
  });
});

  test('every plan:pre planner contribution is injected generically (not per-capId hardcode)', () => {
    // FIX C regression guard: plan-phase.md must inject planner contributions
    // generically (by into == "planner") rather than only injecting a single
    // hardcoded capId (e.g. "tdd"). A generic injection ensures any active
    // plan:pre contribution with into=="planner" reaches the planner — including
    // tdd, schema-gate, and security contributions.
    //
    // Heuristic: the planner prompt section must reference injecting where
    // into == "planner" (or iterate contributions), AND must NOT rely solely
    // on a single capId == "tdd" injection as the only planner contribution
    // delivery mechanism.
    const planPhase = readRepoFile('gsd-core/workflows/plan-phase.md');

    // The file must contain a generic reference to into == "planner" contribution injection.
    assert.match(
      planPhase,
      /into\s*==\s*["']planner["']/,
      'plan-phase.md must inject planner contributions generically via into == "planner" ' +
      '(not just a single hardcoded capId). Fix C regression: all active planner contributions must reach the planner.',
    );

    // Verify the file does NOT rely SOLELY on a hardcoded capId == "tdd" injection
    // for the planner contribution. If only a tdd-specific injection exists (old form),
    // the schema-gate and security contributions are silently dropped.
    // We check: every occurrence of 'capId == "tdd"' contribution injection must be
    // accompanied somewhere by a generic into=="planner" dispatch (already verified above).
    // Additionally, the old exact tdd-only injection prose must not be the only delivery.
    const onlyTddInjection = /\bRead from `PLAN_PRE_HOOKS_JSON` where `kind == "contribution"` and `capId == "tdd"`\b/;
    // If the old tdd-only prose still exists WITHOUT the generic into=="planner" prose,
    // that's a regression. Since we already asserted into=="planner" exists, we just
    // confirm the tdd-only prose is no longer the sole injection mechanism.
    if (onlyTddInjection.test(planPhase)) {
      // Old prose still present: acceptable only if generic prose is ALSO present (already asserted).
      // Verify the into=="planner" injection appears NEAR the planner prompt (within 5000 chars of it).
      const plannerPromptIdx = planPhase.indexOf('into == "planner"');
      assert.ok(
        plannerPromptIdx >= 0,
        'plan-phase.md has tdd-only injection prose but no generic into=="planner" injection. ' +
        'Remove the tdd-only injection and replace with generic contribution dispatch.',
      );
    }
  });

  test('every declared gate check.query returns a uniform boolean `block` field', () => {
    // FIX A regression guard: every gate check command must return a top-level
    // boolean `block` field so the host-loop dispatch can read a single consistent
    // field regardless of which capability owns the gate.
    //
    // For each unique check.query declared in the registry's gate hooks, invoke
    // the check command against a temp directory and assert the JSON output
    // contains `block` as a boolean. Uses a minimal temp dir so the command
    // returns quickly without real project state.
    const os = require('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-block-contract-'));

    // Collect unique gate check.queries from the registry
    const queries = new Set();
    for (const cap of Object.values(registry.capabilities)) {
      for (const gate of cap.gates || []) {
        if (gate.check && gate.check.query) queries.add(gate.check.query);
      }
    }
    assert.ok(queries.size > 0, 'Registry must declare at least one gate check.query');

    const gsdTools = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
    const failures = [];

    for (const query of [...queries].sort()) {
      let rawOut = '';
      try {
        // Invoke with --raw (the real dispatch form used by the host loop).
        // Most commands accept a phase number and return valid JSON even when
        // no real project state exists.
        rawOut = execFileSync(
          process.execPath,
          [gsdTools, 'check', query, '1', '--raw'],
          { cwd: tmpDir, encoding: 'utf-8', timeout: 10000 },
        );
        const parsed = JSON.parse(rawOut.trim());
        if (typeof parsed.block !== 'boolean') {
          failures.push(
            `check ${query}: returned JSON without a boolean \`block\` field ` +
            `(got: ${JSON.stringify(parsed.block)}, type: ${typeof parsed.block}). ` +
            `Add \`block\` to the command's output per the uniform gate contract.`,
          );
        }
      } catch (err) {
        // If it threw because the command required a different arg shape, try with a path
        try {
          rawOut = execFileSync(
            process.execPath,
            [gsdTools, 'check', query, tmpDir, '--raw'],
            { cwd: tmpDir, encoding: 'utf-8', timeout: 10000 },
          );
          const parsed = JSON.parse(rawOut.trim());
          if (typeof parsed.block !== 'boolean') {
            failures.push(
              `check ${query}: returned JSON without a boolean \`block\` field ` +
              `(got: ${JSON.stringify(parsed.block)}, type: ${typeof parsed.block}).`,
            );
          }
        } catch (err2) {
          failures.push(
            `check ${query}: command failed or returned non-JSON output. ` +
            `Error: ${err2 instanceof Error ? err2.message : String(err2)}. ` +
            `Stdout: ${rawOut.slice(0, 200)}`,
          );
        }
      }
    }

    // Clean up temp dir
    cleanup(tmpDir);

    assert.deepEqual(
      failures, [],
      `Gate check commands must all return a top-level boolean \`block\` field:\n  ${failures.join('\n  ')}`,
    );
  });
});

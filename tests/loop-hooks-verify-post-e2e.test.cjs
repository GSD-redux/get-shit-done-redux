'use strict';

/**
 * loop-hooks-verify-post-e2e.test.cjs
 *
 * E2E content tests for the verify:post hook point — ADR-857 phase 6.
 *
 * Coverage focus (backlog: hook-e2e-gaps.md § verify:post):
 *   - All-on: 3 hooks in registry order (nyquist → security → ui) with
 *     correct kind/ref.skill/onError (halt for nyquist+security, skip for ui)
 *   - No-config: schema defaults activate all 3
 *   - Per-key false: each of the 3 BVA cases excludes only that one step
 *   - All-false: empty activeHooks + valid envelope shape
 *   - Surface-disable (via capabilityStatesById on pure resolver): ui/security
 *     cluster excluded; remaining steps correct
 *   - Malformed config.json: falls back to schema defaults (3 active)
 *   - Deterministic ordering: two calls produce identical activeHooks arrays
 *
 * Hard rules enforced here:
 *   - Every test drives real resolver or CLI subprocess — no readFileSync source-grep
 *   - Genuine assertions: negative/BVA cases assert the SPECIFIC differing value
 *   - Each test owns its own fixture (isolated tmpDir); cleanup in afterEach
 */

const { describe, test, before, after, afterEach } = require('node:test');
const { cleanup, installSpawnEnv } = require('./helpers.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// ── Real modules under test ────────────────────────────────────────────────────
const {
  resolveLoopHooks,
  renderLoopHooks,
} = require('../gsd-core/bin/lib/loop-resolver.cjs');
const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

// ── CLI path ───────────────────────────────────────────────────────────────────
const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

/**
 * Invoke gsd-tools CLI with spawnSync and return the parsed result.
 *
 * #4204: uses helpers.cjs's installSpawnEnv() rather than a hand-rolled env,
 * because it sandboxes HOME (so capability-loader's overlayRoots and
 * resolveCapabilityRuntimeState's registry load — both of which fall back to
 * os.homedir() — never reach the real machine) AND clears the full
 * config-location env list (GSD_HOME, GSD_RUNTIME, CLAUDE_CONFIG_DIR, etc.),
 * not just a GSD_-prefix strip. Without it, a capability genuinely installed
 * on the host running the suite (e.g. beads, markdown-linting) leaked into
 * the verify:post registry and inflated the exact-count assertions below.
 */
function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [GSD_TOOLS, ...args], {
    cwd,
    encoding: 'utf8',
    env: installSpawnEnv(),
    timeout: 60000,
  });
  return result;
}

/** Create a temp dir with a .planning/ subdirectory (no config.json). */
function makeTmpProject() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vpost-e2e-'));
  fs.mkdirSync(path.join(d, '.planning'), { recursive: true });
  return d;
}

/** Write .planning/config.json with the given object. */
function writeConfig(tmpDir, cfg) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify(cfg),
    'utf8',
  );
}

// ── Fixtures shared across all-on and ordering tests ─────────────────────────
let allOnDir; // .planning/config.json with all three verify:post flags = true
let noConfigDir; // .planning/ but NO config.json
let allOffDir; // all three flags explicitly false

before(() => {
  allOnDir = makeTmpProject();
  writeConfig(allOnDir, {
    workflow: { nyquist_validation: true, security_enforcement: true, ui_review: true },
  });

  noConfigDir = makeTmpProject();
  // No config.json — schema defaults (all true) should activate all three

  allOffDir = makeTmpProject();
  writeConfig(allOffDir, {
    workflow: { nyquist_validation: false, security_enforcement: false, ui_review: false },
  });
});

after(() => {
  for (const d of [allOnDir, noConfigDir, allOffDir]) {
    if (d) cleanup(d);
  }
});

// Per-test isolation: each test creates its own dir; afterEach cleans it up.
let perTestDir = null;
afterEach(() => {
  if (perTestDir) {
    cleanup(perTestDir);
    perTestDir = null;
  }
});

// ─── 1. All-on: three hooks in correct order with full typed shape ─────────────

describe('verify:post — all-on config activates all three steps in registry order', () => {
  test('[happy] CLI returns 3 active hooks: nyquist→security→ui with correct capId, kind, ref.skill', () => {
    const result = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', allOnDir],
      allOnDir,
    );
    assert.strictEqual(result.status, 0, `CLI exited non-zero: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim());

    assert.strictEqual(envelope.point, 'verify:post');
    assert.strictEqual(envelope.activeHooks.length, 3,
      `Expected 3 active hooks, got ${envelope.activeHooks.length}: ${JSON.stringify(envelope.activeHooks.map(h => h.capId))}`);

    // Step 1: nyquist
    const [nyquist, security, ui] = envelope.activeHooks;
    assert.strictEqual(nyquist.capId, 'nyquist');
    assert.strictEqual(nyquist.kind, 'step');
    assert.strictEqual(nyquist.ref.skill, 'validate-phase');
    assert.strictEqual(nyquist.onError, 'halt');

    // Step 2: security
    assert.strictEqual(security.capId, 'security');
    assert.strictEqual(security.kind, 'step');
    assert.strictEqual(security.ref.skill, 'secure-phase');
    assert.strictEqual(security.onError, 'halt');

    // Step 3: ui
    assert.strictEqual(ui.capId, 'ui');
    assert.strictEqual(ui.kind, 'step');
    assert.strictEqual(ui.ref.skill, 'ui-review');
    assert.strictEqual(ui.onError, 'skip');
  });

  test('[happy] CLI returns rendered markdown with Step 1/2/3 in correct order', () => {
    const result = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', allOnDir],
      allOnDir,
    );
    assert.strictEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout.trim());

    // Rendered text must contain all three steps in correct order
    const { rendered } = envelope;
    assert.ok(typeof rendered === 'string' && rendered.length > 0, 'rendered must be non-empty string');

    const step1Pos = rendered.indexOf('validate-phase');
    const step2Pos = rendered.indexOf('secure-phase');
    const step3Pos = rendered.indexOf('ui-review');
    assert.ok(step1Pos < step2Pos, `nyquist (pos ${step1Pos}) must come before security (pos ${step2Pos}) in rendered`);
    assert.ok(step2Pos < step3Pos, `security (pos ${step2Pos}) must come before ui (pos ${step3Pos}) in rendered`);

    // Rendered must NOT be the placeholder (all hooks active)
    assert.ok(
      !rendered.includes('_No active hooks at verify:post._'),
      'rendered must not be the empty-hooks placeholder when all are active',
    );
  });
});

// ─── 2. No-config: schema defaults activate all 3 ─────────────────────────────

describe('verify:post — no config.json falls back to schema defaults (all three active)', () => {
  test('[happy] CLI with no config.json returns 3 active hooks via schema default=true', () => {
    const result = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', noConfigDir],
      noConfigDir,
    );
    assert.strictEqual(result.status, 0, `CLI exited non-zero: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim());

    assert.strictEqual(envelope.point, 'verify:post');
    assert.strictEqual(envelope.activeHooks.length, 3,
      `Schema defaults should activate 3 hooks, got ${envelope.activeHooks.length}`);

    // Verify capIds — schema default=true for all three
    const capIds = envelope.activeHooks.map(h => h.capId);
    assert.deepEqual(capIds, ['nyquist', 'security', 'ui'],
      `Expected ['nyquist','security','ui'], got ${JSON.stringify(capIds)}`);
  });

  test('[happy] pure resolveLoopHooks with realRegistry and empty config activates all 3 (schema default path)', () => {
    const resolved = resolveLoopHooks({
      point: 'verify:post',
      registry: realRegistry,
      config: {},
    });
    assert.strictEqual(resolved.point, 'verify:post');
    assert.strictEqual(resolved.activeHooks.length, 3,
      `Expected 3 active hooks via schema default, got ${resolved.activeHooks.length}`);
    assert.deepEqual(
      resolved.activeHooks.map(h => h.capId),
      ['nyquist', 'security', 'ui'],
    );
  });
});

// ─── 3. All-false: empty hooks + valid 3-key envelope ─────────────────────────

describe('verify:post — all three flags explicitly false returns empty activeHooks', () => {
  test('[negative] CLI with all-false config returns activeHooks:[] and placeholder rendered', () => {
    const result = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', allOffDir],
      allOffDir,
    );
    assert.strictEqual(result.status, 0, `CLI exited non-zero: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim());

    // Genuine assertion: MUST be 0 (not 1 or 3) — verifies filtering actually works
    assert.strictEqual(envelope.activeHooks.length, 0,
      `Expected 0 hooks when all flags=false, got ${envelope.activeHooks.length}: ${JSON.stringify(envelope.activeHooks.map(h => h.capId))}`);
    assert.deepEqual(envelope.activeHooks, []);
    assert.strictEqual(envelope.rendered, '_No active hooks at verify:post._');
    assert.strictEqual(envelope.point, 'verify:post');
  });

  test('[negative] pure resolveLoopHooks with all-false config returns empty activeHooks', () => {
    const resolved = resolveLoopHooks({
      point: 'verify:post',
      registry: realRegistry,
      config: { workflow: { nyquist_validation: false, security_enforcement: false, ui_review: false } },
    });
    // Must be exactly 0, not 1 or 3
    assert.strictEqual(resolved.activeHooks.length, 0);
    assert.strictEqual(renderLoopHooks(resolved), '_No active hooks at verify:post._');
  });
});

// ─── 4. BVA: per-key false excludes only that one step ────────────────────────

describe('verify:post — per-key BVA: each false excludes only that single step', () => {
  test('[bva] nyquist_validation=false excludes ONLY nyquist; security+ui remain (length=2)', () => {
    perTestDir = makeTmpProject();
    writeConfig(perTestDir, {
      workflow: { nyquist_validation: false, security_enforcement: true, ui_review: true },
    });

    const result = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', perTestDir],
      perTestDir,
    );
    assert.strictEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout.trim());

    // Genuine BVA: must be exactly 2, not 3 or 0
    assert.strictEqual(envelope.activeHooks.length, 2,
      `Expected 2 hooks (security+ui), got ${envelope.activeHooks.length}: ${JSON.stringify(envelope.activeHooks.map(h => h.capId))}`);

    const capIds = envelope.activeHooks.map(h => h.capId);
    assert.ok(!capIds.includes('nyquist'), `nyquist must be absent when nyquist_validation=false, got ${JSON.stringify(capIds)}`);
    assert.strictEqual(capIds[0], 'security', `First remaining hook must be security`);
    assert.strictEqual(capIds[1], 'ui', `Second remaining hook must be ui`);
  });

  test('[bva] security_enforcement=false excludes ONLY security; nyquist+ui remain (length=2)', () => {
    perTestDir = makeTmpProject();
    writeConfig(perTestDir, {
      workflow: { nyquist_validation: true, security_enforcement: false, ui_review: true },
    });

    const result = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', perTestDir],
      perTestDir,
    );
    assert.strictEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout.trim());

    // Genuine BVA: must be exactly 2, not 3 or 0
    assert.strictEqual(envelope.activeHooks.length, 2,
      `Expected 2 hooks (nyquist+ui), got ${envelope.activeHooks.length}: ${JSON.stringify(envelope.activeHooks.map(h => h.capId))}`);

    const capIds = envelope.activeHooks.map(h => h.capId);
    assert.ok(!capIds.includes('security'), `security must be absent when security_enforcement=false, got ${JSON.stringify(capIds)}`);
    assert.strictEqual(capIds[0], 'nyquist', `First remaining hook must be nyquist`);
    assert.strictEqual(capIds[1], 'ui', `Second remaining hook must be ui`);
  });

  test('[bva] ui_review=false excludes ONLY ui; nyquist+security remain (length=2)', () => {
    perTestDir = makeTmpProject();
    writeConfig(perTestDir, {
      workflow: { nyquist_validation: true, security_enforcement: true, ui_review: false },
    });

    const result = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', perTestDir],
      perTestDir,
    );
    assert.strictEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout.trim());

    // Genuine BVA: must be exactly 2, not 3 or 0
    assert.strictEqual(envelope.activeHooks.length, 2,
      `Expected 2 hooks (nyquist+security), got ${envelope.activeHooks.length}: ${JSON.stringify(envelope.activeHooks.map(h => h.capId))}`);

    const capIds = envelope.activeHooks.map(h => h.capId);
    assert.ok(!capIds.includes('ui'), `ui must be absent when ui_review=false, got ${JSON.stringify(capIds)}`);
    assert.strictEqual(capIds[0], 'nyquist', `First remaining hook must be nyquist`);
    assert.strictEqual(capIds[1], 'security', `Second remaining hook must be security`);
  });
});

// ─── 5. Surface-disable via capabilityStatesById (pure resolver) ──────────────

describe('verify:post — surface-disable: capabilityStatesById filters hooks', () => {
  // Phase 4 note: the resolver now gates on `active` (not `enabled`), so
  // capabilityStatesById entries must carry active:false to suppress a hook.
  // Real CapabilityStateEntry objects from resolveCapabilityRuntimeState carry both
  // enabled and active; fixtures here mirror that shape.
  test('[negative] ui disabled via capabilityStatesById→active:false excludes ui step; nyquist+security remain', () => {
    const capabilityStatesById = new Map([
      ['nyquist', { enabled: true, active: true }],
      ['security', { enabled: true, active: true }],
      ['ui', { enabled: false, active: false }],
    ]);
    const resolved = resolveLoopHooks({
      point: 'verify:post',
      registry: realRegistry,
      config: { workflow: { nyquist_validation: true, security_enforcement: true, ui_review: true } },
      capabilityStatesById,
    });

    // Genuine assertion: must be 2 (not 3) — proves surface filter excludes ui
    assert.strictEqual(resolved.activeHooks.length, 2,
      `Expected 2 hooks with ui disabled, got ${resolved.activeHooks.length}: ${JSON.stringify(resolved.activeHooks.map(h => h.capId))}`);

    const capIds = resolved.activeHooks.map(h => h.capId);
    assert.ok(!capIds.includes('ui'), `ui must be filtered out when capability disabled`);
    assert.strictEqual(capIds[0], 'nyquist');
    assert.strictEqual(capIds[1], 'security');
  });

  test('[negative] security disabled via capabilityStatesById excludes security step; nyquist+ui remain', () => {
    const capabilityStatesById = new Map([
      ['nyquist', { enabled: true, active: true }],
      ['security', { enabled: false, active: false }],
      ['ui', { enabled: true, active: true }],
    ]);
    const resolved = resolveLoopHooks({
      point: 'verify:post',
      registry: realRegistry,
      config: { workflow: { nyquist_validation: true, security_enforcement: true, ui_review: true } },
      capabilityStatesById,
    });

    // Genuine: must be 2 (not 3) — proves security cluster exclusion
    assert.strictEqual(resolved.activeHooks.length, 2,
      `Expected 2 hooks with security disabled, got ${resolved.activeHooks.length}`);

    const capIds = resolved.activeHooks.map(h => h.capId);
    assert.ok(!capIds.includes('security'), `security must be filtered out when capability disabled`);
    assert.strictEqual(capIds[0], 'nyquist');
    assert.strictEqual(capIds[1], 'ui');
  });

  test('[empty-resolution] all three disabled via capabilityStatesById returns empty activeHooks with valid envelope', () => {
    const capabilityStatesById = new Map([
      ['nyquist', { enabled: false, active: false }],
      ['security', { enabled: false, active: false }],
      ['ui', { enabled: false, active: false }],
    ]);
    const resolved = resolveLoopHooks({
      point: 'verify:post',
      registry: realRegistry,
      config: { workflow: { nyquist_validation: true, security_enforcement: true, ui_review: true } },
      capabilityStatesById,
    });

    assert.strictEqual(resolved.point, 'verify:post');
    assert.deepEqual(resolved.activeHooks, []);
    assert.strictEqual(renderLoopHooks(resolved), '_No active hooks at verify:post._');
  });
});

// ─── 6. Malformed config.json: falls back to schema defaults ──────────────────

describe('verify:post — malformed config.json: schema defaults fire (3 active, no crash)', () => {
  test('[negative] CLI with malformed config.json exits 0 and returns all 3 hooks via schema defaults', () => {
    perTestDir = makeTmpProject();
    fs.writeFileSync(
      path.join(perTestDir, '.planning', 'config.json'),
      '{ broken json',
      'utf8',
    );

    const result = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', perTestDir],
      perTestDir,
    );
    assert.strictEqual(result.status, 0, `CLI must not crash on malformed config: ${result.stderr}`);

    const envelope = JSON.parse(result.stdout.trim());
    assert.strictEqual(envelope.point, 'verify:post');
    // Schema defaults (all true) must activate all 3 when config.json parse fails
    assert.strictEqual(envelope.activeHooks.length, 3,
      `Expected 3 hooks via schema defaults on malformed config, got ${envelope.activeHooks.length}`);

    const capIds = envelope.activeHooks.map(h => h.capId);
    assert.deepEqual(capIds, ['nyquist', 'security', 'ui']);
  });
});

// ─── 7. Deterministic ordering: two calls produce identical results ────────────

describe('verify:post — deterministic ordering: repeated calls produce identical activeHooks', () => {
  test('[happy] two resolveLoopHooks calls return identical activeHooks arrays (order stability)', () => {
    const config = {
      workflow: { nyquist_validation: true, security_enforcement: true, ui_review: true },
    };
    const first = resolveLoopHooks({ point: 'verify:post', registry: realRegistry, config });
    const second = resolveLoopHooks({ point: 'verify:post', registry: realRegistry, config });

    // Genuine: both must have exactly the same structure
    assert.deepEqual(first.activeHooks, second.activeHooks,
      'Two resolver calls must produce identical activeHooks (determinism)');
    assert.deepEqual(
      first.activeHooks.map(h => h.capId),
      ['nyquist', 'security', 'ui'],
      'Order must be nyquist→security→ui',
    );
  });

  test('[happy] two CLI invocations return identical stdout (CLI-level determinism)', () => {
    const call1 = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', allOnDir],
      allOnDir,
    );
    const call2 = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', allOnDir],
      allOnDir,
    );

    assert.strictEqual(call1.status, 0);
    assert.strictEqual(call2.status, 0);

    const env1 = JSON.parse(call1.stdout.trim());
    const env2 = JSON.parse(call2.stdout.trim());

    assert.deepEqual(env1.activeHooks, env2.activeHooks,
      'Two CLI calls must produce identical activeHooks');
    assert.strictEqual(env1.rendered, env2.rendered,
      'Two CLI calls must produce identical rendered output');
  });
});

// ─── 8. onError fields per-hook (halt for nyquist+security, skip for ui) ──────

describe('verify:post — onError semantics: halt for nyquist+security, skip for ui', () => {
  test('[bva] onError is exactly "halt" for nyquist, "halt" for security, "skip" for ui — pure resolver', () => {
    const resolved = resolveLoopHooks({
      point: 'verify:post',
      registry: realRegistry,
      config: { workflow: { nyquist_validation: true, security_enforcement: true, ui_review: true } },
    });

    assert.strictEqual(resolved.activeHooks.length, 3);
    // Genuine BVA: each onError must match the exact canonical value
    assert.strictEqual(resolved.activeHooks[0].onError, 'halt',
      `nyquist onError must be 'halt', got '${resolved.activeHooks[0].onError}'`);
    assert.strictEqual(resolved.activeHooks[1].onError, 'halt',
      `security onError must be 'halt', got '${resolved.activeHooks[1].onError}'`);
    assert.strictEqual(resolved.activeHooks[2].onError, 'skip',
      `ui onError must be 'skip', got '${resolved.activeHooks[2].onError}'`);
  });

  test('[bva] CLI envelope preserves onError values in the correct field position', () => {
    const result = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', allOnDir],
      allOnDir,
    );
    assert.strictEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout.trim());

    // Genuine BVA: assert specific onError value at each position, not just presence
    assert.strictEqual(envelope.activeHooks[0].onError, 'halt');
    assert.strictEqual(envelope.activeHooks[1].onError, 'halt');
    assert.strictEqual(envelope.activeHooks[2].onError, 'skip');
  });
});

// ─── 9. Envelope shape: exactly 3 keys, no spurious 'warnings' ────────────────

describe('verify:post — envelope shape pins Hyrum\'s Law contract', () => {
  test('[happy] all-on CLI response has exactly 3 envelope keys: point, activeHooks, rendered', () => {
    const result = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', allOnDir],
      allOnDir,
    );
    assert.strictEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout.trim());

    // When state.warnings is empty, the envelope must have exactly 3 keys
    const keys = Object.keys(envelope).sort();
    assert.deepEqual(keys, ['activeHooks', 'point', 'rendered'],
      `Envelope must have exactly 3 keys, got: ${JSON.stringify(keys)}`);
  });

  test('[negative] all-off CLI response envelope still has exactly 3 keys (no extra warnings key)', () => {
    const result = runCli(
      ['loop', 'render-hooks', 'verify:post', '--raw', '--cwd', allOffDir],
      allOffDir,
    );
    assert.strictEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout.trim());

    // All-false path: 3 keys, not more
    const keys = Object.keys(envelope).sort();
    assert.deepEqual(keys, ['activeHooks', 'point', 'rendered'],
      `Empty-hooks envelope must have exactly 3 keys, got: ${JSON.stringify(keys)}`);
    assert.strictEqual(envelope.point, 'verify:post');
    assert.deepEqual(envelope.activeHooks, []);
  });
});

// ─── 10. Real registry byLoopPoint shape check (no drift guard) ───────────────

describe('verify:post — real registry has exactly 4 steps and 0 contributions+gates', () => {
  test('[happy] realRegistry.byLoopPoint[verify:post] has 4 steps, 0 contributions, 0 gates', () => {
    const entry = realRegistry.byLoopPoint['verify:post'];
    assert.ok(entry, 'verify:post must exist in registry');
    assert.strictEqual(entry.steps.length, 4,
      `Expected 4 steps at verify:post, got ${entry.steps.length}`);
    assert.strictEqual(entry.contributions.length, 0,
      `Expected 0 contributions at verify:post, got ${entry.contributions.length}`);
    assert.strictEqual(entry.gates.length, 0,
      `Expected 0 gates at verify:post, got ${entry.gates.length}`);
  });

  test('[happy] registry steps at verify:post have correct capIds in order (mempalace→nyquist→security→ui)', () => {
    const entry = realRegistry.byLoopPoint['verify:post'];
    const capIds = entry.steps.map(s => s.capId);
    assert.deepEqual(capIds, ['mempalace', 'nyquist', 'security', 'ui'],
      `Registry must have steps in mempalace→nyquist→security→ui order, got ${JSON.stringify(capIds)}`);
  });
});

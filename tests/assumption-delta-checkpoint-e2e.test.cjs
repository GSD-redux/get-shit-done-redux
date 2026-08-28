'use strict';

/**
 * E2E capability-wiring tests for the assumption-delta checkpoint (#1561).
 *
 * Drives the real `loop render-hooks plan:pre` CLI subprocess against temp
 * projects with different config values and asserts on the typed envelope's
 * activeHooks — proving the capability contribution activates/deactivates by
 * config (acceptance criteria #4 non-blocking advisory + #6 capability hook).
 *
 * CONTENT/E2E only: every test drives a real CLI subprocess. No readFileSync
 * source-grep. Genuine assertions: each case asserts the SPECIFIC differing
 * value (capId presence/absence), not a count (plan:pre carries other
 * default-on contributions owned by other capabilities).
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { cleanup, TEST_ENV_BASE } = require('./helpers.cjs');

const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

function runTools(args, cwd) {
  const argv = Array.isArray(args)
    ? args
    : (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
        .map((t) => t.replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1'));

  try {
    const stdout = execFileSync(process.execPath, [TOOLS_PATH, ...argv], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, ...TEST_ENV_BASE },
      timeout: 60000,
    });
    return { success: true, output: stdout.trim(), exitCode: 0, error: '' };
  } catch (err) {
    return {
      success: false,
      output: err.stdout?.toString().trim() || '',
      error: err.stderr?.toString().trim() || err.message,
      exitCode: err.status ?? 1,
    };
  }
}

function makeProject(config) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-adelta-'));
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify(config),
    'utf8'
  );
  return tmpDir;
}

function planPreHooks(cwd) {
  const result = runTools('loop render-hooks plan:pre --raw', cwd);
  assert.ok(result.success, `render-hooks plan:pre should succeed. stderr: ${result.error}`);
  const envelope = JSON.parse(result.output);
  assert.strictEqual(envelope.point, 'plan:pre', 'point field must be plan:pre');
  assert.ok(Array.isArray(envelope.activeHooks), 'activeHooks must be an array');
  return envelope;
}

function findCap(envelope, capId) {
  return envelope.activeHooks.find((h) => h.capId === capId) || null;
}

// ─── ROADMAP fixture for the scan query ──────────────────────────────────────
const ROADMAP = [
  '# Roadmap',
  '',
  '## v1.0.0',
  '',
  '### Phase 1: Add a second auth method alongside passwords',
  '**Goal:** Users can authenticate via SSO in addition to passwords',
  '**Success Criteria**:',
  '1. SSO login works',
  '2. Password login still works',
  '',
  '### Phase 2: Refactor the parser for readability',
  '**Goal:** Smaller functions, no behavior change',
  '**Success Criteria**:',
  '1. All existing tests still pass',
  '',
].join('\n');

function makeRoadmapProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-adelta-rm-'));
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), ROADMAP, 'utf8');
  return tmpDir;
}

function scanQuery(cwd, phase, extra) {
  const argv = ['query', 'assumption-delta', 'scan', String(phase)];
  if (extra) argv.push(...extra);
  return runTools(argv, cwd);
}

describe('assumption-delta scan query — phase-section detection (#1561)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('phase with a pluralization signal → detected:true', () => {
    tmpDir = makeRoadmapProject();
    const r = scanQuery(tmpDir, 1, ['--json']);
    assert.ok(r.success, `scan should succeed. stderr: ${r.error}`);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.detected, true);
    assert.ok(parsed.signals.some((s) => s.kind === 'pluralization'), 'phase 1 must trip pluralization');
  });

  test('phase with no signal → detected:false (low false-positive)', () => {
    tmpDir = makeRoadmapProject();
    const r = scanQuery(tmpDir, 2, ['--json']);
    assert.ok(r.success, `scan should succeed. stderr: ${r.error}`);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.detected, false);
    assert.deepStrictEqual(parsed.signals, []);
  });

  test('unknown phase → skipped, no throw (graceful) (#3909)', () => {
    tmpDir = makeRoadmapProject();
    const r = scanQuery(tmpDir, 999, ['--json']);
    assert.ok(r.success, `scan should succeed on unknown phase. stderr: ${r.error}`);
    const parsed = JSON.parse(r.output);
    // This asserted `detected:false` until #3909. That was the fabrication
    // itself pinned as intended behavior: phase 999 does not exist, so the
    // detector was handed the empty string and its "no core assumption
    // changed" answer described nothing. The graceful-degradation contract
    // the test was protecting (succeeds, does not throw) is unchanged.
    assert.strictEqual(parsed.skipped, true);
    assert.strictEqual(parsed.reason, 'phase_unresolved');
    assert.strictEqual(parsed.detected, undefined);
  });

  test('--terms override narrows the vocabulary (custom cue fires, default cue does not)', () => {
    tmpDir = makeRoadmapProject();
    // phase 1 trips "second" by default; override to "xyzzy" → must NOT fire
    const r = scanQuery(tmpDir, 1, ['--json', '--terms', 'xyzzy']);
    assert.ok(r.success, `scan should succeed. stderr: ${r.error}`);
    assert.strictEqual(JSON.parse(r.output).detected, false);
  });

  test('missing phase arg → non-zero exit (usage error)', () => {
    tmpDir = makeRoadmapProject();
    const r = runTools(['query', 'assumption-delta', 'scan'], tmpDir);
    assert.notStrictEqual(r.exitCode, 0, 'scan with no phase must exit non-zero');
  });

  // ── Hardening (Codex Step-4 review): malformed args ──────────────────────
  test('flag-shaped phase (scan --json) → non-zero exit, not treated as phase', () => {
    tmpDir = makeRoadmapProject();
    const r = runTools(['query', 'assumption-delta', 'scan', '--json'], tmpDir);
    assert.notStrictEqual(r.exitCode, 0, '"--json" must not be accepted as a phase number');
  });

  test('empty --terms restores curated defaults (detected, not disabled)', () => {
    tmpDir = makeRoadmapProject();
    const r = scanQuery(tmpDir, 1, ['--terms', '', '--json']);
    assert.ok(r.success, `scan should succeed. stderr: ${r.error}`);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.detected, true, 'phase 1 must still trip defaults under empty --terms');
    assert.ok(parsed.terms.pluralization.includes('second'));
  });

  test('flag-shaped --terms value (--terms --json) falls back to defaults, not treated as a term', () => {
    tmpDir = makeRoadmapProject();
    const r = scanQuery(tmpDir, 1, ['--terms', '--json']);
    assert.ok(r.success, `scan should succeed. stderr: ${r.error}`);
    const parsed = JSON.parse(r.output);
    // 'json' must NOT have been consumed as a pluralization cue; defaults apply.
    assert.ok(!parsed.terms.pluralization.includes('json'), '"--json" must not become a trigger term');
    assert.ok(parsed.terms.pluralization.includes('second'), 'defaults restored');
  });
});

describe('assumption-delta capability — plan:pre render-hooks wiring (#1561)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('default config (no toggle): assumption-delta contribution is ACTIVE', () => {
    tmpDir = makeProject({});
    const env = planPreHooks(tmpDir);
    const hook = findCap(env, 'assumption-delta');
    assert.ok(hook, 'assumption-delta contribution must be active under default config');
    assert.strictEqual(hook.kind, 'contribution', 'must be a non-blocking contribution, not a gate');
    assert.strictEqual(hook.into, 'planner', 'contribution injects into the planner role');
    assert.strictEqual(hook.when, 'workflow.assumption_delta', 'when must gate on workflow.assumption_delta');
    assert.strictEqual(hook.onError, 'skip', 'onError must be skip (advisory, never halts)');
    // The fragment body must be inlined so the planner receives concrete prose.
    const frag = hook.fragment && hook.fragment.inline ? hook.fragment.inline : hook.fragment;
    assert.ok(typeof frag === 'string' && frag.length > 0, 'fragment must be inlined as non-empty text');
    assert.ok(
      /Assumption-Delta Architecture Checkpoint/i.test(frag),
      'inlined fragment must carry the checkpoint heading'
    );
  });

  test('workflow.assumption_delta=true: contribution is ACTIVE', () => {
    tmpDir = makeProject({ workflow: { assumption_delta: true } });
    const env = planPreHooks(tmpDir);
    assert.ok(findCap(env, 'assumption-delta'), 'must be active when explicitly true');
  });

  test('workflow.assumption_delta=false: contribution is INACTIVE (absent from activeHooks)', () => {
    tmpDir = makeProject({ workflow: { assumption_delta: false } });
    const env = planPreHooks(tmpDir);
    assert.strictEqual(
      findCap(env, 'assumption-delta'),
      null,
      'must NOT appear in activeHooks when disabled — other default-on plan:pre hooks may still be present'
    );
  });

  test('non-blocking guarantee: no assumption-delta entry is ever a blocking gate', () => {
    // Advisory contract (acceptance #4): the checkpoint informs; it never blocks.
    // Across both on/off states the capability must never surface as kind=gate
    // with blocking=true.
    tmpDir = makeProject({ workflow: { assumption_delta: true } });
    const env = planPreHooks(tmpDir);
    const gates = env.activeHooks.filter((h) => h.kind === 'gate');
    assert.ok(
      gates.every((g) => g.capId !== 'assumption-delta'),
      'assumption-delta must never register a blocking gate at plan:pre'
    );
  });
});

// ─── An unresolved phase section is not a negative verdict (#3909, P5) ────────
// `routeAssumptionDelta` fed `detectAssumptionDelta(section ?? '')`, so a phase
// section that could not be resolved at all (no ROADMAP.md, unknown phase
// number) was scanned as the empty string and reported as an examined-and-
// negative result. That is a fabricated verdict: the probe never had input.
// The route now reports the skipped-with-reason shape instead. Exit code stays
// 0 — this is an ADR-2980 degraded result reported through the payload, and
// ADR-3889 P8 pins the gsd-tools projection at v1.
describe('query assumption-delta scan — unresolved phase reports skipped (#3909)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  function writeRoadmap(dir, body) {
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), body, 'utf8');
  }

  function scan(cwd, phase, extra = []) {
    const r = runTools(['query', 'assumption-delta', 'scan', phase, '--json', ...extra], cwd);
    return { raw: r, json: JSON.parse(r.output) };
  }

  test('CONTROL: a resolved section with no cues still reports detected:false', () => {
    tmpDir = makeProject({ workflow: { assumption_delta: true } });
    writeRoadmap(tmpDir, '# Roadmap\n\n### Phase 01: Cleanup\n\nRefactor the internal state machine.\n');
    const { raw, json } = scan(tmpDir, '01');
    assert.strictEqual(raw.exitCode, 0);
    assert.strictEqual(json.detected, false, 'an examined section with no cues is a real negative');
    assert.strictEqual(json.skipped, undefined, 'a real scan must NOT be reported as skipped');
  });

  test('CONTROL: a resolved section with a pluralization cue still detects', () => {
    tmpDir = makeProject({ workflow: { assumption_delta: true } });
    writeRoadmap(tmpDir, '# Roadmap\n\n### Phase 01: Auth\n\nAdd a second authentication method.\n');
    const { json } = scan(tmpDir, '01');
    assert.strictEqual(json.detected, true);
    assert.strictEqual(json.skipped, undefined);
  });

  test('no ROADMAP.md at all reports skipped, not detected:false', () => {
    tmpDir = makeProject({ workflow: { assumption_delta: true } });
    const { raw, json } = scan(tmpDir, '01');
    assert.strictEqual(json.skipped, true, 'a probe with no input must not assert a verdict');
    assert.strictEqual(json.reason, 'phase_unresolved');
    assert.strictEqual(
      json.detected,
      undefined,
      'a skipped payload must carry no detected key — that is what makes it distinguishable',
    );
    assert.strictEqual(raw.exitCode, 0, 'degraded result stays exit 0 (ADR-2980; P8 pins v1)');
  });

  test('a ROADMAP.md that does not contain the phase reports skipped', () => {
    tmpDir = makeProject({ workflow: { assumption_delta: true } });
    writeRoadmap(tmpDir, '# Roadmap\n\n### Phase 01: Auth\n\nAdd a second authentication method.\n');
    const { json } = scan(tmpDir, '99');
    assert.strictEqual(json.skipped, true, 'an unknown phase number resolves to nothing');
    assert.strictEqual(json.reason, 'phase_unresolved');
  });

  test('BOUNDARY: a resolved but body-less section is EXAMINED, not skipped', () => {
    tmpDir = makeProject({ workflow: { assumption_delta: true } });
    writeRoadmap(tmpDir, '# Roadmap\n\n### Phase 01: Empty\n\n   \n\t\n\n### Phase 02: Next\n\nBody.\n');
    const { json } = scan(tmpDir, '01');
    // The resolver returns the heading line alone for a body-less section, so
    // the phase WAS found and the detector did examine what the roadmap holds
    // for it. `skipped` is reserved for the cases where the resolver returns
    // null — an unknown phase number, or no ROADMAP.md at all. Pinning that
    // line here keeps the distinction the issue actually asks for (found vs
    // not found) from drifting into a vaguer "looks empty to me".
    assert.strictEqual(json.skipped, undefined, 'a resolved section is not a skip');
    assert.strictEqual(json.detected, false, 'the heading alone carries no cues — a real negative');
  });

  test('--terms does not rescue an unresolved phase', () => {
    tmpDir = makeProject({ workflow: { assumption_delta: true } });
    const { json } = scan(tmpDir, '01', ['--terms', 'second,alternative']);
    assert.strictEqual(json.skipped, true, 'a vocabulary override cannot manufacture a scan');
    assert.strictEqual(json.reason, 'phase_unresolved');
  });
});

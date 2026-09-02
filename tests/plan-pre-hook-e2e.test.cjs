'use strict';

/**
 * plan-pre-hook-e2e.test.cjs — E2E content tests for plan:pre hook resolution.
 *
 * ADR-857 phase 6 capstone conformance — gap-backlog: plan:pre
 * All tests drive real CLI subprocess or real resolver with real registry.
 * No source-grep — RULESET.TESTS.no-source-grep.
 *
 * Covers:
 *   1. intel.enabled=true → step ref.command='intel api-surface', rendered contains 'intel api-surface'
 *   2. tdd_mode=true → tdd contribution fragment contains '<tdd_mode_active>'
 *   3. security_enforcement=true + explicit asvs/block_on → configValues resolved from config
 *   4. BVA: security defaults (asvs_level=1, block_on='high') when only enforcement=true
 *   5. All plan:pre when-keys false → empty activeHooks + placeholder rendered
 *   6. check ui.plan-gate: frontend + no-spec → block:true, exit 0
 *   7. check ui.plan-gate: frontend + spec present → block:false, exit 0
 *   8. check ui.plan-gate: missing phase arg → exit 1, clear error message
 *   9. BVA: check ui.plan-gate phase=99 (nonexistent) → phaseLookupFailed:true, block:false
 *  10. BVA: intel api-surface symbolCount=0 → stale:true + Incomplete banner
 *  11. BVA: intel api-surface symbolCount=1 fresh → stale:false + symbol in file
 *  12. ui cluster disabled via surface + tdd + intel on → no ui hooks, intel+tdd present
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

// ─── Subprocess helper (isolated env, no ambient GSD_ vars) ───────────────────

const CLEAN_ENV = {
  GSD_SESSION_KEY: '',
  CODEX_THREAD_ID: '',
  CLAUDE_SESSION_ID: '',
  CLAUDE_CODE_SSE_PORT: '',
  OPENCODE_SESSION_ID: '',
  GEMINI_SESSION_ID: '',
  CURSOR_SESSION_ID: '',
  WINDSURF_SESSION_ID: '',
  TERM_SESSION_ID: '',
  WT_SESSION: '',
  TMUX_PANE: '',
  ZELLIJ_SESSION_NAME: '',
  TTY: '',
  SSH_TTY: '',
  GSD_WORKSTREAM: '',
  GSD_PROJECT: '',
};

/**
 * Run gsd-tools via spawnSync. Returns { status, stdout, stderr }.
 * Passes env overrides merged on top of process.env + CLEAN_ENV.
 */
function runTools(args, cwd, envOverrides = {}) {
  return spawnSync(
    process.execPath,
    [GSD_TOOLS, ...args],
    {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, ...CLEAN_ENV, ...envOverrides },
    },
  );
}

/**
 * Parse JSON stdout from runTools result — throws with diagnostic on failure.
 */
function parseEnvelope(result, label = '') {
  try {
    return JSON.parse(result.stdout.trim());
  } catch (e) {
    throw new Error(
      `${label}: JSON.parse failed.\n` +
      `stdout=${result.stdout?.slice(0, 300)}\n` +
      `stderr=${result.stderr?.slice(0, 300)}\n` +
      `status=${result.status}`
    );
  }
}

// ─── Fixture factory helpers ──────────────────────────────────────────────────

function makePlanningDir(tmpDir, configObj = null) {
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  if (configObj !== null) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify(configObj),
      'utf8',
    );
  }
}

function makeProject(configObj = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pre-e2e-'));
  makePlanningDir(tmpDir, configObj);
  return tmpDir;
}

// ─── 1. intel.enabled=true emits step with ref.command and rendered text ──────

describe('plan:pre intel step — ref.command and rendered text', () => {
  let tmpDir;
  before(() => {
    tmpDir = makeProject({ intel: { enabled: true } });
  });
  after(() => cleanup(tmpDir));

  test('[happy] intel.enabled=true: activeHooks has intel step with ref.command="intel api-surface"', () => {
    const result = runTools(['loop', 'render-hooks', 'plan:pre', '--cwd', tmpDir, '--raw'], tmpDir);
    assert.strictEqual(result.status, 0, `exit non-zero. stderr=${result.stderr?.slice(0, 300)}`);
    const envelope = parseEnvelope(result, 'intel-step');

    assert.strictEqual(envelope.point, 'plan:pre');
    assert.ok(Array.isArray(envelope.activeHooks), 'activeHooks must be array');

    const intelHook = envelope.activeHooks.find(h => h.capId === 'intel');
    assert.ok(intelHook !== undefined, 'intel hook must be present when intel.enabled=true');
    assert.strictEqual(intelHook.kind, 'step', 'intel hook kind must be step');
    assert.deepEqual(intelHook.ref, { command: 'intel api-surface' },
      'ref must be {command:"intel api-surface"} not a JSON blob');

    // Rendered text: check it contains "intel api-surface" (as part of the JSON or label)
    assert.ok(
      envelope.rendered.includes('intel api-surface'),
      `rendered must contain 'intel api-surface'. Got: ${envelope.rendered.slice(0, 200)}`,
    );
    // Rendered must be structured step text, not a bare JSON object dump.
    // A structured render includes human-readable step metadata (- produces:, - when:).
    assert.ok(
      envelope.rendered.includes('- produces:') && envelope.rendered.includes('- when:'),
      'intel step must render as a structured step (with produces/when labels), not an opaque blob',
    );
    // Also assert the produces path appears
    assert.ok(
      envelope.rendered.includes('.planning/intel/API-SURFACE.md'),
      'rendered must include the produced file path',
    );
  });
});

// ─── 2. tdd_mode=true emits tdd contribution with <tdd_mode_active> ───────────

describe('plan:pre tdd contribution — fragment.inline contains <tdd_mode_active>', () => {
  let tmpDir;
  before(() => {
    tmpDir = makeProject({ workflow: { tdd_mode: true } });
  });
  after(() => cleanup(tmpDir));

  test('[happy] tdd_mode=true: tdd contribution fragment.inline contains <tdd_mode_active>', () => {
    const result = runTools(['loop', 'render-hooks', 'plan:pre', '--cwd', tmpDir, '--raw'], tmpDir);
    assert.strictEqual(result.status, 0, `exit non-zero. stderr=${result.stderr?.slice(0, 300)}`);
    const envelope = parseEnvelope(result, 'tdd-contribution');

    const tddHook = envelope.activeHooks.find(h => h.capId === 'tdd');
    assert.ok(tddHook !== undefined, 'tdd hook must be present when tdd_mode=true');
    assert.strictEqual(tddHook.kind, 'contribution', 'tdd hook kind must be contribution');
    assert.ok(
      tddHook.fragment && typeof tddHook.fragment.inline === 'string',
      'tdd hook must have fragment.inline string',
    );
    assert.ok(
      tddHook.fragment.inline.includes('<tdd_mode_active>'),
      `fragment.inline must contain '<tdd_mode_active>'. Got: ${tddHook.fragment.inline.slice(0, 200)}`,
    );

    // Rendered text must also contain the tag
    assert.ok(
      envelope.rendered.includes('<tdd_mode_active>'),
      `rendered must contain '<tdd_mode_active>'. Got: ${envelope.rendered.slice(0, 200)}`,
    );
  });
});

// ─── 3. security contribution emits configValues from explicit config ──────────

describe('plan:pre security contribution — configValues from explicit config', () => {
  let tmpDir;
  before(() => {
    tmpDir = makeProject({
      workflow: {
        security_enforcement: true,
        security_asvs_level: 3,
        security_block_on: 'critical',
      },
    });
  });
  after(() => cleanup(tmpDir));

  test('[happy] security_enforcement=true + explicit asvs=3 + block_on=critical: configValues match config', () => {
    const result = runTools(['loop', 'render-hooks', 'plan:pre', '--cwd', tmpDir, '--raw'], tmpDir);
    assert.strictEqual(result.status, 0, `exit non-zero. stderr=${result.stderr?.slice(0, 300)}`);
    const envelope = parseEnvelope(result, 'security-configValues-explicit');

    const secHook = envelope.activeHooks.find(h => h.capId === 'security');
    assert.ok(secHook !== undefined, 'security hook must be present when security_enforcement=true');
    assert.strictEqual(secHook.kind, 'contribution', 'security hook kind must be contribution');
    assert.ok(secHook.configValues !== undefined, 'security hook must have configValues');
    assert.strictEqual(secHook.configValues.security_asvs_level, 3,
      'security_asvs_level must be 3 (from config, not default 1)');
    assert.strictEqual(secHook.configValues.security_block_on, 'critical',
      'security_block_on must be critical (from config, not default high)');
  });
});

// ─── 4. BVA: security defaults when enforcement=true but levels not set ────────

describe('plan:pre security contribution — BVA: default configValues', () => {
  let tmpDir;
  before(() => {
    tmpDir = makeProject({ workflow: { security_enforcement: true } });
  });
  after(() => cleanup(tmpDir));

  test('[bva] security_enforcement=true only: configValues use schema defaults (asvs=1, block_on=high)', () => {
    const result = runTools(['loop', 'render-hooks', 'plan:pre', '--cwd', tmpDir, '--raw'], tmpDir);
    assert.strictEqual(result.status, 0, `exit non-zero. stderr=${result.stderr?.slice(0, 300)}`);
    const envelope = parseEnvelope(result, 'security-configValues-defaults');

    const secHook = envelope.activeHooks.find(h => h.capId === 'security');
    assert.ok(secHook !== undefined, 'security hook must be present');
    assert.ok(secHook.configValues !== undefined, 'security hook must have configValues');
    // BVA: schema defaults — must be 1 and 'high', NOT 3 or 'critical'
    assert.strictEqual(secHook.configValues.security_asvs_level, 1,
      'default asvs_level must be 1 when not set in config');
    assert.strictEqual(secHook.configValues.security_block_on, 'high',
      'default block_on must be high when not set in config');
  });
});

// ─── 5. All plan:pre when-keys false → empty activeHooks + placeholder ─────────

describe('plan:pre all-off — empty resolution', () => {
  let tmpDir;
  before(() => {
    tmpDir = makeProject({
      workflow: {
        ai_integration_phase: false,
        api_coverage_gate: false,
        tdd_mode: false,
        security_enforcement: false,
        ui_phase: false,
        ui_safety_gate: false,
        research: false,
        pattern_mapper: false,
        schema_push_detection: false,
        plan_drift_precheck: false,
        context_drift_precheck: false,
        assumption_delta: false,
      },
      intel: { enabled: false },
    });
  });
  after(() => cleanup(tmpDir));

  test('[negative] all plan:pre when-keys false: activeHooks empty, rendered is placeholder', () => {
    const result = runTools(['loop', 'render-hooks', 'plan:pre', '--cwd', tmpDir, '--raw'], tmpDir);
    assert.strictEqual(result.status, 0, `exit non-zero. stderr=${result.stderr?.slice(0, 300)}`);
    const envelope = parseEnvelope(result, 'all-off');

    assert.deepEqual(envelope.activeHooks, [],
      `activeHooks must be empty when all flags false. Got: ${JSON.stringify(envelope.activeHooks.map(h=>h.capId))}`);
    assert.strictEqual(envelope.rendered, '_No active hooks at plan:pre._',
      'rendered must be placeholder when no active hooks');
  });
});

// ─── 6. check ui.plan-gate: frontend + no-spec → block:true ──────────────────

describe('check ui.plan-gate — frontend phase, no UI-SPEC', () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pre-ui-gate-'));
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(path.join(planningDir, 'phases', '01-dashboard'), { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Project Roadmap',
        '',
        '## Phase 1: Dashboard',
        '',
        'Build the user interface and frontend dashboard components.',
        '',
      ].join('\n'),
      'utf8',
    );
    // Static frontend evidence (#3312): block requires token match AND structural
    // corroboration — this fixture is a real frontend repo.
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App.tsx'), 'export function App() { return null; }\n', 'utf8');
    // No UI-SPEC.md in phase dir
  });
  after(() => cleanup(tmpDir));

  test('[happy] frontend phase + evidence + no UI-SPEC: block:true, frontend:true, hasUiSpec:false, exit 0', () => {
    const result = runTools(['check', 'ui.plan-gate', '1', '--raw'], tmpDir);
    assert.strictEqual(result.status, 0, `exit non-zero. stderr=${result.stderr?.slice(0, 300)}`);
    const out = parseEnvelope(result, 'ui-plan-gate-no-spec');

    assert.strictEqual(out.frontend, true, 'frontend must be true for frontend-keyword phase');
    assert.strictEqual(out.hasFrontendEvidence, true, 'src/App.tsx is frontend evidence');
    assert.strictEqual(out.hasUiSpec, false, 'hasUiSpec must be false when no spec file exists');
    assert.strictEqual(out.block, true, 'block must be true (frontend && hasFrontendEvidence && !hasUiSpec)');
    assert.strictEqual(out.uiSpecPath, null, 'uiSpecPath must be null when spec absent');
    // matchedToken is the FIRST match in the phase section — the "## Phase 1:
    // Dashboard" heading precedes the body, so the first match is `dashboard`.
    assert.strictEqual(out.matchedToken, 'dashboard', 'matchedToken surfaces what tripped the sniffer');
  });
});

// ─── 6b. check ui.plan-gate: #3312 — token match without frontend evidence ────

describe('check ui.plan-gate — #3312 proper-noun token match, no frontend evidence', () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pre-ui-gate-3312-'));
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(path.join(planningDir, 'phases', '01-infra'), { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Project Roadmap',
        '',
        '## Phase 1: Infra',
        '',
        'Fix broken references in dashboard-financeiro, update .env.tpl and CI workflows.',
        '',
      ].join('\n'),
      'utf8',
    );
    // Markdown/bash/config repo by design: no src/, no package.json, no component files.
  });
  after(() => cleanup(tmpDir));

  test('[regression] dashboard-financeiro mention in non-frontend repo: frontend:true but block:false', () => {
    const result = runTools(['check', 'ui.plan-gate', '1', '--raw'], tmpDir);
    assert.strictEqual(result.status, 0, `exit non-zero. stderr=${result.stderr?.slice(0, 300)}`);
    const out = parseEnvelope(result, 'ui-plan-gate-3312');

    assert.strictEqual(out.frontend, true,
      'sniffer still matches `dashboard` at the hyphen boundary (micro-frontend rule)');
    assert.strictEqual(out.hasFrontendEvidence, false,
      'markdown/bash repo has no component files and no UI-framework dependency');
    assert.strictEqual(out.block, false,
      '#3312: token match without structural evidence must NOT block planning');
    assert.strictEqual(out.matchedToken, 'dashboard', 'matchedToken surfaces the proper-noun trigger');
    assert.ok(
      typeof out.matchedLine === 'string' && out.matchedLine.includes('dashboard-financeiro'),
      'matchedLine surfaces the line for one-second operator triage',
    );
  });
});

// ─── 7. check ui.plan-gate: frontend + spec present → block:false ─────────────

describe('check ui.plan-gate — frontend phase, UI-SPEC present', () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pre-ui-gate-spec-'));
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(path.join(planningDir, 'phases', '01-dashboard'), { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Project Roadmap',
        '',
        '## Phase 1: Dashboard',
        '',
        'Build the frontend React dashboard with UI forms.',
        '',
      ].join('\n'),
      'utf8',
    );
    // Add a UI-SPEC.md
    fs.writeFileSync(
      path.join(planningDir, 'phases', '01-dashboard', '01-UI-SPEC.md'),
      '# UI Design Contract\n',
      'utf8',
    );
  });
  after(() => cleanup(tmpDir));

  test('[happy] frontend phase + UI-SPEC present: block:false, hasUiSpec:true, uiSpecPath ends with -UI-SPEC.md', () => {
    const result = runTools(['check', 'ui.plan-gate', '1', '--raw'], tmpDir);
    assert.strictEqual(result.status, 0, `exit non-zero. stderr=${result.stderr?.slice(0, 300)}`);
    const out = parseEnvelope(result, 'ui-plan-gate-with-spec');

    assert.strictEqual(out.frontend, true, 'frontend must be true');
    assert.strictEqual(out.hasUiSpec, true, 'hasUiSpec must be true when spec file exists');
    assert.strictEqual(out.block, false, 'block must be false (spec present)');
    assert.ok(
      typeof out.uiSpecPath === 'string' && out.uiSpecPath.endsWith('-UI-SPEC.md'),
      `uiSpecPath must end with -UI-SPEC.md. Got: ${out.uiSpecPath}`,
    );
  });
});

// ─── 8. check ui.plan-gate: missing phase arg → exit 1 + error message ────────

describe('check ui.plan-gate — missing phase argument', () => {
  test('[negative] missing phase arg: exit code 1, stderr contains ui-plan-gate requires a phase argument', () => {
    const result = runTools(['check', 'ui.plan-gate', '--raw']);
    assert.strictEqual(result.exitCode ?? result.status, 1,
      `exit code must be 1. Got: ${result.status}. stderr=${result.stderr?.slice(0, 300)}`);
    assert.ok(
      (result.stderr || '').includes('ui-plan-gate requires a phase argument'),
      `stderr must include 'ui-plan-gate requires a phase argument'. Got: ${result.stderr?.slice(0, 300)}`,
    );
  });
});

// ─── 9. BVA: check ui.plan-gate phase=99 → phaseLookupFailed:true ─────────────

describe('check ui.plan-gate — BVA: non-existent phase 99', () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pre-ui-gate-99-'));
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(path.join(planningDir, 'phases', '01-dashboard'), { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Project Roadmap',
        '',
        '## Phase 1: Dashboard',
        '',
        'Build the frontend dashboard.',
        '',
      ].join('\n'),
      'utf8',
    );
  });
  after(() => cleanup(tmpDir));

  test('[bva] phase=99 (nonexistent in ROADMAP.md with only Phase 1): phaseLookupFailed:true, block:false', () => {
    const result = runTools(['check', 'ui.plan-gate', '99', '--raw'], tmpDir);
    assert.strictEqual(result.status, 0, `exit must be 0. stderr=${result.stderr?.slice(0, 300)}`);
    const out = parseEnvelope(result, 'ui-plan-gate-phase-99');

    assert.strictEqual(out.phaseLookupFailed, true,
      'phaseLookupFailed must be true for a phase not found in ROADMAP.md');
    // When phase lookup fails, frontend defaults to false and block must be false
    assert.strictEqual(out.frontend, false,
      'frontend must be false when phase lookup fails (not silently block:false)');
    assert.strictEqual(out.block, false,
      'block must be false when phase not found — phaseLookupFailed distinguishes this from a clean pass');
  });
});

// ─── 10. BVA: intel api-surface symbolCount=0 → stale:true + Incomplete ──────

describe('intel api-surface — BVA: symbolCount=0 (empty entries)', () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pre-intel-empty-'));
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(path.join(planningDir, 'intel'), { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ intel: { enabled: true } }), 'utf8');
    // api-map.json with empty object entries
    fs.writeFileSync(
      path.join(planningDir, 'intel', 'api-map.json'),
      JSON.stringify({ entries: {} }),
      'utf8',
    );
  });
  after(() => cleanup(tmpDir));

  test('[bva] symbolCount=0: exit 0, stale:true, symbolCount:0, written file contains Incomplete banner', () => {
    const result = runTools(['intel', 'api-surface', '--raw'], tmpDir);
    assert.strictEqual(result.status, 0, `exit non-zero. stderr=${result.stderr?.slice(0, 300)}`);
    const out = parseEnvelope(result, 'intel-api-surface-empty');

    assert.strictEqual(out.symbolCount, 0, 'symbolCount must be 0 for empty entries');
    assert.strictEqual(out.stale, true, 'stale must be true when no _meta.updated_at');
    assert.ok(typeof out.written === 'string' && out.written.endsWith('API-SURFACE.md'),
      `written must be a path ending in API-SURFACE.md. Got: ${out.written}`);

    // Content check — the written file must contain the Incomplete banner
    const content = fs.readFileSync(out.written, 'utf8');
    assert.ok(
      content.includes('Incomplete'),
      `API-SURFACE.md must contain 'Incomplete' banner when symbolCount=0. Got: ${content.slice(0, 300)}`,
    );
  });
});

// ─── 11. BVA: intel api-surface symbolCount=1 fresh → stale:false ─────────────

describe('intel api-surface — BVA: symbolCount=1, fresh _meta', () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pre-intel-one-'));
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(path.join(planningDir, 'intel'), { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ intel: { enabled: true } }), 'utf8');
    // api-map.json with one entry object and fresh _meta
    fs.writeFileSync(
      path.join(planningDir, 'intel', 'api-map.json'),
      JSON.stringify({
        entries: {
          getUserById: {
            file: 'src/api/users.ts',
            kind: 'function',
            signature: 'getUserById(id: string): Promise<User>',
          },
        },
        _meta: { updated_at: new Date().toISOString() },
      }),
      'utf8',
    );
  });
  after(() => cleanup(tmpDir));

  test('[bva] symbolCount=1 with fresh _meta.updated_at: exit 0, stale:false, symbolCount:1', () => {
    const result = runTools(['intel', 'api-surface', '--raw'], tmpDir);
    assert.strictEqual(result.status, 0, `exit non-zero. stderr=${result.stderr?.slice(0, 300)}`);
    const out = parseEnvelope(result, 'intel-api-surface-one-entry');

    assert.strictEqual(out.symbolCount, 1, 'symbolCount must be 1 for one entry');
    assert.strictEqual(out.stale, false, 'stale must be false when _meta.updated_at is fresh (<24h)');
    assert.ok(typeof out.written === 'string' && out.written.endsWith('API-SURFACE.md'),
      `written must be API-SURFACE.md path. Got: ${out.written}`);

    // Content check — symbol must appear in the file
    const content = fs.readFileSync(out.written, 'utf8');
    assert.ok(
      content.includes('getUserById'),
      `API-SURFACE.md must contain 'getUserById' symbol. Got: ${content.slice(0, 300)}`,
    );
  });
});

// ─── 12. ui cluster disabled + tdd + intel on → no ui hooks, intel+tdd present ─

describe('plan:pre surface cluster filter — ui disabled, tdd+intel active', () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pre-surface-'));
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    // Enable intel, tdd, and also ui things in project config
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({
        intel: { enabled: true },
        workflow: {
          tdd_mode: true,
          ui_phase: true,
          ui_safety_gate: true,
          security_enforcement: false,
          research: false,
          pattern_mapper: false,
          schema_push_detection: false,
          ai_integration_phase: false,
        },
      }),
      'utf8',
    );
    // .gsd-surface.json disabling UI cluster in same dir (config-dir = tmpDir)
    fs.writeFileSync(
      path.join(tmpDir, '.gsd-surface.json'),
      JSON.stringify({
        baseProfile: 'full',
        disabledClusters: ['ui'],
        explicitAdds: [],
        explicitRemoves: [],
      }),
      'utf8',
    );
  });
  after(() => cleanup(tmpDir));

  test('[empty-resolution/surface] ui cluster disabled: no ui hooks; intel and tdd hooks present', () => {
    const result = runTools(
      ['loop', 'render-hooks', 'plan:pre', '--cwd', tmpDir, '--config-dir', tmpDir, '--raw'],
      tmpDir,
    );
    assert.strictEqual(result.status, 0, `exit non-zero. stderr=${result.stderr?.slice(0, 300)}`);
    const envelope = parseEnvelope(result, 'ui-cluster-disabled');

    // No ui hooks — specific assertion on the differing field
    const uiHooks = envelope.activeHooks.filter(h => h.capId === 'ui');
    assert.strictEqual(uiHooks.length, 0,
      `ui cluster disabled must suppress all ui hooks. Got ui hooks: ${JSON.stringify(uiHooks)}`);

    // intel hook must be present (not suppressed by ui cluster disable)
    const intelHooks = envelope.activeHooks.filter(h => h.capId === 'intel');
    assert.strictEqual(intelHooks.length, 1,
      `intel hook must be present. Got: ${JSON.stringify(envelope.activeHooks.map(h => h.capId))}`);

    // tdd hook must be present
    const tddHooks = envelope.activeHooks.filter(h => h.capId === 'tdd');
    assert.strictEqual(tddHooks.length, 1,
      `tdd hook must be present. Got: ${JSON.stringify(envelope.activeHooks.map(h => h.capId))}`);
  });
});

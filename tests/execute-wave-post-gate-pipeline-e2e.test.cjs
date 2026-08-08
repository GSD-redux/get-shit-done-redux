'use strict';

/**
 * execute-wave-post-gate-pipeline-e2e.test.cjs
 *
 * ADR-857 Phase 6 capstone E2E content tests for the execute:wave:post hook pipeline.
 *
 * Hook: execute:wave:post
 * Three gates registered in the real capability-registry.cjs:
 *   1. drift / verify.schema-drift  — blocking=true,  onError=skip
 *   2. drift / verify.codebase-drift — blocking=false, onError=skip
 *   3. ui   / ui.safety-gate        — blocking=true,  onError=halt
 *
 * Focus areas:
 *   A. loop render-hooks execute:wave:post — resolution full/partial/none
 *   B. check verify.schema-drift — no-schema/block/GSD_SKIP_SCHEMA_CHECK bypass
 *   C. check verify.codebase-drift — BVA threshold-1/threshold/auto-remap/no-STRUCTURE.md
 *   D. check ui.safety-gate — frontend+UI-file/+spec/missing-arg
 *   E. Full pipeline chain (render-hooks → dispatch each gate)
 *
 * All tests drive real CLI commands or real resolver functions.
 * No readFileSync source-grep.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

// ─── Test-local git helper ───────────────────────────────────────────────────
// Inline — NOT modifying tests/helpers.cjs per task rules.

function gitSync(args, cwd) {
  return gitOrThrow(args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' } }).trim();
}

function initGitRepo(dir) {
  gitSync(['init'], dir);
  gitSync(['config', 'user.email', 'test@test.com'], dir);
  gitSync(['config', 'user.name', 'Test'], dir);
  gitSync(['config', 'commit.gpgsign', 'false'], dir);
}

function gitAddCommit(dir, message) {
  gitSync(['add', '-A'], dir);
  gitSync(['commit', '--allow-empty', '-m', message], dir);
}

// ─── GSD CLI runner ──────────────────────────────────────────────────────────

/**
 * Run gsd-tools and return { status, stdout, stderr, parsed? }.
 * When raw=true the tool emits JSON; parsed is set on success.
 */
function runTool(args, { cwd, env = {} } = {}) {
  const childEnv = {
    ...process.env,
    GSD_SESSION_KEY: '',
    CODEX_THREAD_ID: '',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SSE_PORT: '',
    ...env,
  };
  const r = spawnSync(process.execPath, [GSD_TOOLS, ...args], {
    cwd: cwd || os.tmpdir(),
    encoding: 'utf8',
    env: childEnv,
    timeout: 60000,
  });
  const result = { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  if (r.stdout && r.stdout.trim().startsWith('{')) {
    try { result.parsed = JSON.parse(r.stdout.trim()); } catch { /* non-JSON or partial */ }
  }
  return result;
}

// ─── Shared fixture teardown ─────────────────────────────────────────────────

const tmpDirs = [];
function makeTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-wave-post-'));
  tmpDirs.push(d);
  return d;
}

after(() => { for (const d of tmpDirs) { try { cleanup(d); } catch { /* best-effort */ } } });

// ─── Section A: loop render-hooks execute:wave:post ──────────────────────────

describe('A. loop render-hooks execute:wave:post — resolution', () => {

  test('[happy] full resolution: all 3 gates present with default config', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    // default config — schema_drift_gate and ui_safety_gate both default to true
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}');

    const r = runTool(['loop', 'render-hooks', 'execute:wave:post', '--raw'], { cwd: dir });
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.ok(r.parsed, `stdout not JSON: ${r.stdout}`);
    const env = r.parsed;

    assert.strictEqual(env.point, 'execute:wave:post');
    assert.ok(Array.isArray(env.activeHooks), 'activeHooks must be an array');
    // Real registry: 3 gates (schema-drift blocking, codebase-drift non-blocking, ui-safety blocking)
    assert.strictEqual(env.activeHooks.length, 3,
      `expected 3 gates; got ${env.activeHooks.length}: ${JSON.stringify(env.activeHooks.map(h => h.capId || h.check?.query))}`);

    // Verify the three expected gate queries
    const queries = env.activeHooks.map(h => h.check?.query);
    assert.ok(queries.includes('verify.schema-drift'), 'verify.schema-drift gate must be present');
    assert.ok(queries.includes('verify.codebase-drift'), 'verify.codebase-drift gate must be present');
    assert.ok(queries.includes('ui.safety-gate'), 'ui.safety-gate gate must be present');
  });

  test('[negative] no gates returned when schema_drift_gate=false AND ui_safety_gate=false — all suppressed', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { schema_drift_gate: false, ui_safety_gate: false } }),
    );

    const r = runTool(['loop', 'render-hooks', 'execute:wave:post', '--raw'], { cwd: dir });
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.ok(r.parsed, `stdout not JSON: ${r.stdout}`);
    const env = r.parsed;

    assert.strictEqual(env.point, 'execute:wave:post');
    // This is the SPECIFIC differing value — must be 0, not 1, 2, or 3
    assert.strictEqual(env.activeHooks.length, 0,
      `expected 0 active hooks when both gates suppressed; got ${env.activeHooks.length}`);
    assert.strictEqual(env.rendered, '_No active hooks at execute:wave:post._');
  });

  test('[bva] partial suppression: schema_drift_gate=false → only ui gate present (1 hook)', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    // schema_drift_gate=false suppresses BOTH drift gates (both use this when key)
    // ui_safety_gate defaults to true so ui.safety-gate stays active
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { schema_drift_gate: false, ui_safety_gate: true } }),
    );

    const r = runTool(['loop', 'render-hooks', 'execute:wave:post', '--raw'], { cwd: dir });
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.ok(r.parsed, `stdout not JSON: ${r.stdout}`);
    const env = r.parsed;

    // Specific differing value: exactly 1 hook, not 3 or 0
    assert.strictEqual(env.activeHooks.length, 1,
      `expected 1 hook (only ui); got ${env.activeHooks.length}: ${JSON.stringify(env.activeHooks.map(h => h.check?.query))}`);
    assert.strictEqual(env.activeHooks[0].check?.query, 'ui.safety-gate',
      `remaining hook must be ui.safety-gate, got ${env.activeHooks[0].check?.query}`);
    assert.strictEqual(env.activeHooks[0].capId, 'ui');
  });

});

// ─── Section B: check verify.schema-drift ────────────────────────────────────

describe('B. check verify.schema-drift — CLI route', () => {

  // Helper: build a minimal git repo with a phase dir containing a PLAN.md
  function buildSchemaDriftFixture({ hasSchemaFile = false } = {}) {
    const dir = makeTmpDir();
    initGitRepo(dir);

    fs.mkdirSync(path.join(dir, '.planning', 'phases', '01-setup'), { recursive: true });

    // Write a PLAN.md with files_modified
    const schemaEntry = hasSchemaFile ? 'prisma/schema.prisma' : 'src/index.ts';
    const planContent = [
      '# 01 Plan',
      '',
      `files_modified: [${schemaEntry}]`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, '.planning', 'phases', '01-setup', '01-PLAN.md'), planContent);

    // Write README so git has something to commit
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
    gitAddCommit(dir, 'initial commit');

    return dir;
  }

  test('[happy] block:false when no schema files in PLAN.md — happy path', () => {
    const dir = buildSchemaDriftFixture({ hasSchemaFile: false });

    const r = runTool(['check', 'verify.schema-drift', '1', '--raw'], { cwd: dir });
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.ok(r.parsed, `stdout not JSON: ${r.stdout}`);
    const result = r.parsed;

    // Specific typed fields
    assert.strictEqual(result.block, false, `block must be false for non-schema file; got ${result.block}`);
    assert.strictEqual(result.drift_detected, false,
      `drift_detected must be false; got ${result.drift_detected}`);
    assert.strictEqual(result.skipped, false,
      `skipped must be false; got ${result.skipped}`);
  });

  test('[negative] block:true when schema file in PLAN.md and no push executed — fail-closed', () => {
    const dir = buildSchemaDriftFixture({ hasSchemaFile: true });
    // No SUMMARY.md with push evidence is written — so schema drift detected

    const r = runTool(['check', 'verify.schema-drift', '1', '--raw'], { cwd: dir });
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.ok(r.parsed, `stdout not JSON: ${r.stdout}`);
    const result = r.parsed;

    // Specific: block must be TRUE here (not false) — FAIL if block is still false
    assert.strictEqual(result.block, true, `block must be true when schema file has no push; got ${result.block}`);
    assert.strictEqual(result.drift_detected, true,
      `drift_detected must be true; got ${result.drift_detected}`);
    // unpushed_orms must contain 'prisma'
    assert.ok(Array.isArray(result.unpushed_orms), 'unpushed_orms must be an array');
    assert.ok(result.unpushed_orms.includes('prisma'),
      `unpushed_orms must include 'prisma'; got ${JSON.stringify(result.unpushed_orms)}`);
  });

  test('[negative] GSD_SKIP_SCHEMA_CHECK=true → block:false, skipped:true even with schema drift', () => {
    const dir = buildSchemaDriftFixture({ hasSchemaFile: true });

    const r = runTool(['check', 'verify.schema-drift', '1', '--raw'], {
      cwd: dir,
      env: { GSD_SKIP_SCHEMA_CHECK: 'true' },
    });
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.ok(r.parsed, `stdout not JSON: ${r.stdout}`);
    const result = r.parsed;

    // Specific: block must be FALSE (bypassed) even though drift was detected
    assert.strictEqual(result.block, false,
      `block must be false with GSD_SKIP_SCHEMA_CHECK=true; got ${result.block}`);
    assert.strictEqual(result.skipped, true,
      `skipped must be true; got ${result.skipped}`);
    // drift_detected should still be true (bypass doesn't mask detection)
    assert.strictEqual(result.drift_detected, true,
      `drift_detected must be true even when bypassed; got ${result.drift_detected}`);
  });

});

// ─── Section C: check verify.codebase-drift — BVA ────────────────────────────

describe('C. check verify.codebase-drift — BVA at threshold', () => {

  /**
   * Build a git repo with STRUCTURE.md stamped at an initial commit,
   * then add N new barrel exports in a second commit to trigger drift detection.
   */
  function buildCodebaseDriftFixture({ barrelCount = 0, driftAction = 'warn', threshold = 3 } = {}) {
    const dir = makeTmpDir();
    initGitRepo(dir);

    fs.mkdirSync(path.join(dir, '.planning', 'codebase'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });

    // Write config.json
    const config = {
      workflow: {
        drift_threshold: threshold,
        drift_action: driftAction,
      },
    };
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config));

    // Initial commit with STRUCTURE.md + config
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
    // Write STRUCTURE.md stub — will be stamped after initial commit
    fs.writeFileSync(
      path.join(dir, '.planning', 'codebase', 'STRUCTURE.md'),
      '# Structure\n\nInitial layout.\n',
    );
    gitAddCommit(dir, 'initial commit');

    // Stamp STRUCTURE.md with last_mapped_commit = HEAD of initial commit
    const headSha = gitSync(['rev-parse', 'HEAD'], dir);
    const stampedContent = `---\nlast_mapped_commit: ${headSha}\n---\n# Structure\n\nInitial layout.\n`;
    fs.writeFileSync(path.join(dir, '.planning', 'codebase', 'STRUCTURE.md'), stampedContent);
    gitAddCommit(dir, 'stamp STRUCTURE.md with last_mapped_commit');

    // Add the new barrel exports in a third commit (these are "new" since last map)
    if (barrelCount > 0) {
      for (let i = 0; i < barrelCount; i++) {
        const pkgName = `pkg-${i}`;
        fs.mkdirSync(path.join(dir, 'packages', pkgName, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'packages', pkgName, 'src', 'index.ts'),
          `export const val${i} = ${i};\n`,
        );
      }
      gitAddCommit(dir, `add ${barrelCount} new barrel exports`);

      // Re-read head sha and update STRUCTURE.md stamp to the pre-barrel commit
      // (so all the barrel files are "new" relative to last_mapped_commit)
      // Actually: we want the stamp to be at the commit BEFORE the barrels were added,
      // so we need to get the second commit's SHA.
      // We already have stamped at the second commit. The third commit added barrels.
      // The stamp still points to the initial commit, so diff = all new barrel files.
    }

    return dir;
  }

  test('[bva] threshold-1 (2 elements) → block:false, action_required:false — just-under boundary', () => {
    // threshold=3, barrelCount=2 → 2 < 3 → no block
    const dir = buildCodebaseDriftFixture({ barrelCount: 2, threshold: 3 });

    const r = runTool(['check', 'verify.codebase-drift', '--raw'], { cwd: dir });
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.ok(r.parsed, `stdout not JSON: ${r.stdout}`);
    const result = r.parsed;

    // Specific: block must be FALSE at threshold-1
    assert.strictEqual(result.block, false,
      `block must be false at threshold-1 (2 elements); got ${result.block}`);
    assert.strictEqual(result.action_required, false,
      `action_required must be false; got ${result.action_required}`);
    assert.ok(Array.isArray(result.elements),
      `elements must be an array; got ${typeof result.elements}`);
    assert.strictEqual(result.elements.length, 2,
      `elements.length must be exactly 2; got ${result.elements.length}`);
    assert.strictEqual(result.directive, 'none',
      `directive must be 'none'; got ${result.directive}`);
    assert.strictEqual(result.skipped, false,
      `skipped must be false; got ${result.skipped}`);
  });

  test('[bva] threshold exactly (3 elements) → block:true, action_required:true — at boundary', () => {
    // threshold=3, barrelCount=3 → 3 >= 3 → block
    const dir = buildCodebaseDriftFixture({ barrelCount: 3, threshold: 3 });

    const r = runTool(['check', 'verify.codebase-drift', '--raw'], { cwd: dir });
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.ok(r.parsed, `stdout not JSON: ${r.stdout}`);
    const result = r.parsed;

    // Specific: block must be TRUE at exactly threshold — FAIL if still false
    assert.strictEqual(result.block, true,
      `block must be true at threshold (3 elements); got ${result.block}`);
    assert.strictEqual(result.action_required, true,
      `action_required must be true; got ${result.action_required}`);
    assert.strictEqual(result.elements.length, 3,
      `elements.length must be exactly 3; got ${result.elements.length}`);
    assert.strictEqual(result.directive, 'warn',
      `directive must be 'warn'; got ${result.directive}`);
    assert.strictEqual(result.spawn_mapper, false,
      `spawn_mapper must be false for warn action; got ${result.spawn_mapper}`);
  });

  test('[happy] drift_action=auto-remap + threshold exceeded → block:true, spawn_mapper:true', () => {
    const dir = buildCodebaseDriftFixture({ barrelCount: 3, driftAction: 'auto-remap', threshold: 3 });

    const r = runTool(['check', 'verify.codebase-drift', '--raw'], { cwd: dir });
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.ok(r.parsed, `stdout not JSON: ${r.stdout}`);
    const result = r.parsed;

    assert.strictEqual(result.block, true,
      `block must be true; got ${result.block}`);
    assert.strictEqual(result.action_required, true,
      `action_required must be true; got ${result.action_required}`);
    // Specific: spawn_mapper must be TRUE for auto-remap action
    assert.strictEqual(result.spawn_mapper, true,
      `spawn_mapper must be true for auto-remap; got ${result.spawn_mapper}`);
    assert.strictEqual(result.directive, 'auto-remap',
      `directive must be 'auto-remap'; got ${result.directive}`);
  });

  test('[empty-resolution] STRUCTURE.md absent → block:false, skipped:true, reason:no-structure-md', () => {
    const dir = makeTmpDir();
    initGitRepo(dir);
    // Create .planning/codebase/ dir but NO STRUCTURE.md
    fs.mkdirSync(path.join(dir, '.planning', 'codebase'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
    gitAddCommit(dir, 'initial commit');

    const r = runTool(['check', 'verify.codebase-drift', '--raw'], { cwd: dir });
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.ok(r.parsed, `stdout not JSON: ${r.stdout}`);
    const result = r.parsed;

    assert.strictEqual(result.block, false,
      `block must be false when STRUCTURE.md absent; got ${result.block}`);
    assert.strictEqual(result.skipped, true,
      `skipped must be true; got ${result.skipped}`);
    assert.strictEqual(result.reason, 'no-structure-md',
      `reason must be 'no-structure-md'; got ${result.reason}`);
    assert.strictEqual(result.action_required, false,
      `action_required must be false; got ${result.action_required}`);
  });

});

// ─── Section D: check ui.safety-gate ─────────────────────────────────────────

describe('D. check ui.safety-gate — CLI subprocess route', () => {

  /**
   * Build a git repo fixture for ui.safety-gate tests.
   *
   * Sequence:
   *   commit 1: initial commit with README
   *   commit 2: add src/components/Button.tsx (UI file)
   * Optional: create .planning/phases/01-phase/01-UI-SPEC.md
   */
  function buildUiSafetyGateFixture({ hasUiSpec = false, frontend = true } = {}) {
    const dir = makeTmpDir();
    initGitRepo(dir);

    // Create planning dirs
    fs.mkdirSync(path.join(dir, '.planning', 'phases', '01-phase'), { recursive: true });

    // Write ROADMAP.md with a frontend Phase 1 section.
    // getRoadmapPhaseWithFallback requires ## or ### heading (not #) for phase lookup.
    const phaseText = frontend
      ? '## Phase 1: dashboard frontend\n\nBuild the user-facing dashboard UI component.\n'
      : '## Phase 1: backend api\n\nBuild the backend API endpoints only.\n';
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), phaseText);

    // Initial commit
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
    gitAddCommit(dir, 'initial commit');

    // Optionally add UI-SPEC before the UI file commit
    if (hasUiSpec) {
      fs.writeFileSync(
        path.join(dir, '.planning', 'phases', '01-phase', '01-UI-SPEC.md'),
        '# UI Spec\n\nDesign contract for Phase 1.\n',
      );
      gitAddCommit(dir, 'add UI-SPEC');
    }

    // Second commit: add a UI file (matches UI_FILE_EXTENSIONS_RE: .tsx)
    fs.mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'components', 'Button.tsx'),
      'export const Button = () => null;\n',
    );
    gitAddCommit(dir, 'add Button.tsx component');

    return dir;
  }

  test('[negative] block:true when frontend phase + UI file changed + no UI-SPEC — live block path', () => {
    const dir = buildUiSafetyGateFixture({ hasUiSpec: false, frontend: true });

    const r = runTool(['check', 'ui.safety-gate', '1', '--raw'], { cwd: dir });
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.ok(r.parsed, `stdout not JSON: ${r.stdout}`);
    const result = r.parsed;

    // Specific: block must be TRUE — fails if block is false
    assert.strictEqual(result.block, true,
      `block must be true: frontend=${result.frontend} hasUiFiles=${result.hasUiFiles} hasUiSpec=${result.hasUiSpec}`);
    assert.strictEqual(result.frontend, true,
      `frontend must be true; got ${result.frontend}`);
    assert.strictEqual(result.hasUiFiles, true,
      `hasUiFiles must be true; got ${result.hasUiFiles}`);
    assert.strictEqual(result.hasUiSpec, false,
      `hasUiSpec must be false; got ${result.hasUiSpec}`);
  });

  test('[happy] block:false when frontend phase + UI file changed + UI-SPEC present — gate passes', () => {
    const dir = buildUiSafetyGateFixture({ hasUiSpec: true, frontend: true });

    const r = runTool(['check', 'ui.safety-gate', '1', '--raw'], { cwd: dir });
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.ok(r.parsed, `stdout not JSON: ${r.stdout}`);
    const result = r.parsed;

    // Specific: block must be FALSE when spec is present
    assert.strictEqual(result.block, false,
      `block must be false when UI-SPEC exists; got block=${result.block}`);
    assert.strictEqual(result.frontend, true,
      `frontend must be true; got ${result.frontend}`);
    assert.strictEqual(result.hasUiFiles, true,
      `hasUiFiles must be true; got ${result.hasUiFiles}`);
    assert.strictEqual(result.hasUiSpec, true,
      `hasUiSpec must be true; got ${result.hasUiSpec}`);
  });

  test('[negative] exits non-zero with error message when phase argument is missing', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });

    const r = runTool(['check', 'ui.safety-gate', '--raw'], { cwd: dir });

    // Specific: exit must be NON-ZERO — FAIL if 0
    assert.notStrictEqual(r.status, 0,
      `expected non-zero exit for missing phase arg; got ${r.status}`);
    const combined = r.stdout + r.stderr;
    assert.ok(
      combined.includes('ui-safety-gate requires a phase argument'),
      `error message must mention 'ui-safety-gate requires a phase argument'; got: ${combined}`,
    );
  });

});

// ─── Section E: Full execute:wave:post pipeline chain ────────────────────────

describe('E. Full execute:wave:post pipeline — render-hooks then dispatch gates', () => {

  test('[happy] Full chain: render-hooks discovers 3 gates → schema-drift block:false → codebase-drift block:false', () => {
    // Build fixture: git repo, non-frontend ROADMAP, fresh STRUCTURE.md stamped at current HEAD
    const dir = makeTmpDir();
    initGitRepo(dir);

    fs.mkdirSync(path.join(dir, '.planning', 'codebase'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.planning', 'phases', '01-setup'), { recursive: true });

    // Non-frontend ROADMAP so ui.safety-gate doesn't block (no UI files changed).
    // Use ## heading — getRoadmapPhaseWithFallback requires ## or ### (not #).
    fs.writeFileSync(
      path.join(dir, '.planning', 'ROADMAP.md'),
      '## Phase 1: backend setup\n\nConfigure server-side services.\n',
    );
    // PLAN.md with only non-schema files
    fs.writeFileSync(
      path.join(dir, '.planning', 'phases', '01-setup', '01-PLAN.md'),
      'files_modified: [src/server.ts, package.json]\n',
    );

    // Write STRUCTURE.md stub (no frontmatter stamp initially)
    fs.writeFileSync(
      path.join(dir, '.planning', 'codebase', 'STRUCTURE.md'),
      '# Structure\n\nInitial codebase layout.\n',
    );
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
    gitAddCommit(dir, 'initial commit');

    // Stamp STRUCTURE.md with current HEAD so there is no drift since last map
    const headSha = gitSync(['rev-parse', 'HEAD'], dir);
    fs.writeFileSync(
      path.join(dir, '.planning', 'codebase', 'STRUCTURE.md'),
      `---\nlast_mapped_commit: ${headSha}\n---\n# Structure\n\nInitial codebase layout.\n`,
    );
    gitAddCommit(dir, 'stamp STRUCTURE.md');

    // --- Step 1: render-hooks → discover gates ---
    const step1 = runTool(['loop', 'render-hooks', 'execute:wave:post', '--raw'], { cwd: dir });
    assert.strictEqual(step1.status, 0, `step1 exit non-zero: ${step1.stderr}`);
    assert.ok(step1.parsed, `step1 not JSON: ${step1.stdout}`);
    const envelope = step1.parsed;

    assert.strictEqual(envelope.point, 'execute:wave:post');
    assert.strictEqual(envelope.activeHooks.length, 3,
      `step1: expected 3 gates, got ${envelope.activeHooks.length}`);

    // Confirm schema-drift gate is present and has correct metadata
    const schemaDriftHook = envelope.activeHooks.find(h => h.check?.query === 'verify.schema-drift');
    assert.ok(schemaDriftHook, 'verify.schema-drift gate must be in activeHooks');
    assert.strictEqual(schemaDriftHook.blocking, true, 'schema-drift gate must be blocking');
    assert.strictEqual(schemaDriftHook.onError, 'skip', 'schema-drift onError must be skip');

    // --- Step 2: dispatch schema-drift gate ---
    const step2 = runTool(['check', 'verify.schema-drift', '1', '--raw'], { cwd: dir });
    assert.strictEqual(step2.status, 0, `step2 exit non-zero: ${step2.stderr}`);
    assert.ok(step2.parsed, `step2 not JSON: ${step2.stdout}`);
    assert.strictEqual(step2.parsed.block, false,
      `step2 schema-drift block must be false; got ${step2.parsed.block}`);

    // --- Step 3: dispatch codebase-drift gate ---
    const step3 = runTool(['check', 'verify.codebase-drift', '--raw'], { cwd: dir });
    assert.strictEqual(step3.status, 0, `step3 exit non-zero: ${step3.stderr}`);
    assert.ok(step3.parsed, `step3 not JSON: ${step3.stdout}`);
    // After stamping and committing with no new barrel/migration files, no drift
    // (the stamp commit itself is just config changes — not drift categories)
    assert.strictEqual(step3.parsed.block, false,
      `step3 codebase-drift block must be false; got ${step3.parsed.block}`);
  });

});

// ─── Section F: real registry shape assertions (pure-function) ────────────────

describe('F. Real registry execute:wave:post shape — guard against accidental changes', () => {

  const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

  test('[happy] real registry execute:wave:post has exactly 3 gates with correct queries', () => {
    const point = realRegistry.byLoopPoint['execute:wave:post'];
    assert.ok(point, 'byLoopPoint must have execute:wave:post key');
    assert.ok(Array.isArray(point.gates), 'gates must be an array');

    // Specific: exactly 3 gates — fails if someone adds or removes one
    assert.strictEqual(point.gates.length, 3,
      `execute:wave:post must have exactly 3 gates; got ${point.gates.length}`);

    const queries = point.gates.map(g => g.check?.query);
    assert.ok(queries.includes('verify.schema-drift'), 'verify.schema-drift gate must exist');
    assert.ok(queries.includes('verify.codebase-drift'), 'verify.codebase-drift gate must exist');
    assert.ok(queries.includes('ui.safety-gate'), 'ui.safety-gate gate must exist');
  });

  test('[happy] real registry: schema-drift gate is blocking=true, codebase-drift is blocking=false', () => {
    const gates = realRegistry.byLoopPoint['execute:wave:post'].gates;
    const schemaDrift = gates.find(g => g.check?.query === 'verify.schema-drift');
    const codebaseDrift = gates.find(g => g.check?.query === 'verify.codebase-drift');

    assert.strictEqual(schemaDrift.blocking, true,
      `schema-drift gate must be blocking=true; got ${schemaDrift.blocking}`);
    assert.strictEqual(codebaseDrift.blocking, false,
      `codebase-drift gate must be blocking=false; got ${codebaseDrift.blocking}`);
  });

  test('[happy] real registry: ui.safety-gate is blocking=true, onError=halt', () => {
    const gates = realRegistry.byLoopPoint['execute:wave:post'].gates;
    const uiGate = gates.find(g => g.check?.query === 'ui.safety-gate');

    assert.ok(uiGate, 'ui.safety-gate gate must exist');
    assert.strictEqual(uiGate.blocking, true,
      `ui.safety-gate must be blocking=true; got ${uiGate.blocking}`);
    assert.strictEqual(uiGate.onError, 'halt',
      `ui.safety-gate onError must be 'halt'; got ${uiGate.onError}`);
  });

  test('[happy] real registry: execute:wave:post has no steps and 2 contributions (external-job executor + mempalace capture-problems)', () => {
    const point = realRegistry.byLoopPoint['execute:wave:post'];
    assert.strictEqual(point.steps.length, 0,
      `execute:wave:post steps must be empty; got ${point.steps.length}`);
    // #2285: claude-orchestration's dispatch-backend-selector contribution moved
    // from execute:wave:post to execute:wave:pre — wave:post fires AFTER the
    // wave already dispatched inline, too late to select a dispatch backend.
    assert.strictEqual(point.contributions.length, 2,
      `execute:wave:post must have 2 contributions (external-job + mempalace); got ${point.contributions.length}`);
    const capIds = point.contributions.map(c => c.capId).sort();
    assert.deepStrictEqual(capIds, ['external-job', 'mempalace'],
      `execute:wave:post contributions must be external-job + mempalace; got ${capIds.join(',')}`);
  });

  test('[happy] real registry: execute:wave:pre has 1 contribution (claude-orchestration dispatch-backend selector, #2285)', () => {
    const point = realRegistry.byLoopPoint['execute:wave:pre'];
    assert.strictEqual(point.steps.length, 0,
      `execute:wave:pre steps must be empty; got ${point.steps.length}`);
    assert.strictEqual(point.contributions.length, 1,
      `execute:wave:pre must have 1 contribution (claude-orchestration); got ${point.contributions.length}`);
    const capIds = point.contributions.map(c => c.capId).sort();
    assert.deepStrictEqual(capIds, ['claude-orchestration'],
      `execute:wave:pre contributions must be claude-orchestration; got ${capIds.join(',')}`);
  });

});

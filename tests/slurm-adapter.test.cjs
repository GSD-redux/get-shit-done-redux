'use strict';
process.env.GSD_TEST_MODE = '1';

// Refinements for issue #1164 (PR #1998 follow-up):
// - A: document the execute:wave:post choice (at the time of #1164, wave:pre
//      was declared but not dispatched by execute-phase.md; wiring it was a
//      core-loop change #1164 put out of scope. #2285 later wired wave:pre —
//      see gsd-core/workflows/execute-phase.md step 2.75 and the
//      claude-orchestration capability, which moved to wave:pre for that
//      reason).
// - B: external_job.artifact_dir is now consumed by the adapter (was declared
//      but unused).
// - C: external_job.submit_timeout_ms / poll_timeout_ms are now read from
//      config (were shadowed by env-only reads).
// - D: CLI surface (parseFlags, findPlanningDir, resolveExternalJobSettings,
//      formatShowReport) now has unit coverage.

const { test } = require('node:test');
const { cleanup } = require('./helpers.cjs'); // #4020: fixture-tree removal
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
    parseFlags,
    findPlanningDir,
    resolveExternalJobSettings,
    formatShowReport,
    ExitError,
} = require('../scripts/slurm-adapter.cjs');

// Minimal registry stand-in: only configSchema defaults are consulted by
// resolveConfigKey Level 4 (capability-activation.cjs). Real registry comes
// from gsd-core/bin/lib/capability-registry.cjs at runtime.
function fakeRegistry() {
    return {
        configSchema: {
            'external_job.submit_timeout_ms': { owner: 'external-job', type: 'number', default: 30000 },
            'external_job.poll_timeout_ms': { owner: 'external-job', type: 'number', default: 15000 },
            'external_job.artifact_dir': { owner: 'external-job', type: 'string', default: 'Artifacts/jobs' },
        },
    };
}

// ─── parseFlags ───────────────────────────────────────────────────────────────

test('parseFlags collects --key value pairs and a `--` rest array', () => {
    const f = parseFlags(['--plan', '3.1', '--phase', '3', '--', 'sbatch', '--parsable', './run.sh']);
    assert.strictEqual(f.plan, '3.1');
    assert.strictEqual(f.phase, '3');
    assert.deepStrictEqual(f['--'], ['sbatch', '--parsable', './run.sh']);
    assert.deepStrictEqual(f._, []);
});

test('parseFlags collects positional args into _', () => {
    const f = parseFlags(['submit', '--job', '123']);
    assert.deepStrictEqual(f._, ['submit']);
    assert.strictEqual(f.job, '123');
});

test('parseFlags handles a missing `--` rest gracefully (no rest array)', () => {
    const f = parseFlags(['--job', '123']);
    assert.strictEqual(f.job, '123');
    assert.strictEqual(f['--'], undefined);
});

// ─── findPlanningDir ──────────────────────────────────────────────────────────

test('findPlanningDir walks up to the nearest .planning and returns its path', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-slurm-'));
    t.after(() => cleanup(root)); // #4020: no leaked fixture tree on the success path
    const planning = path.join(root, '.planning');
    fs.mkdirSync(planning);
    const nested = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    assert.strictEqual(findPlanningDir(nested), planning);
});

test('findPlanningDir fails closed (ExitError) when no .planning is reachable', (t) => {
    // A tmp dir with no .planning anywhere up to the walk bound (10 levels).
    // Use a fresh tmp and create 11 nested dirs so the walk can't escape to a
    // parent that happens to contain .planning (e.g. the repo root).
    const deep = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-slurm-noplan-'));
    t.after(() => cleanup(deep)); // #4020
    let cur = deep;
    for (let i = 0; i < 12; i++) {
        cur = path.join(cur, `n${i}`);
        fs.mkdirSync(cur);
    }
    assert.throws(() => findPlanningDir(cur), (e) => e instanceof ExitError && e.code === 1);
});

// ─── resolveExternalJobSettings (#1164 refinements B + C) ─────────────────────

test('resolveExternalJobSettings falls back to registry defaults when config and env are empty', () => {
    const s = resolveExternalJobSettings({ config: {}, env: {}, registry: fakeRegistry() });
    assert.strictEqual(s.submitTimeoutMs, 30000);
    assert.strictEqual(s.pollTimeoutMs, 15000);
    assert.strictEqual(s.artifactDir, 'Artifacts/jobs');
});

test('resolveExternalJobSettings reads nested config values (config key now functional, was unused)', () => {
    const config = {
        external_job: {
            submit_timeout_ms: 45000,
            poll_timeout_ms: 9000,
            artifact_dir: 'Artifacts/hpc',
        },
    };
    const s = resolveExternalJobSettings({ config, env: {}, registry: fakeRegistry() });
    assert.strictEqual(s.submitTimeoutMs, 45000, 'submit_timeout_ms from config');
    assert.strictEqual(s.pollTimeoutMs, 9000, 'poll_timeout_ms from config');
    assert.strictEqual(s.artifactDir, 'Artifacts/hpc', 'artifact_dir from config');
});

test('resolveExternalJobSettings: env override beats config (precedence env > config > default)', () => {
    const config = { external_job: { submit_timeout_ms: 45000, poll_timeout_ms: 9000 } };
    const env = {
        GSD_SLURM_SUBMIT_TIMEOUT_MS: '7777',
        GSD_SLURM_POLL_TIMEOUT_MS: '8888',
        GSD_EXTERNAL_JOB_ARTIFACT_DIR: 'Artifacts/env',
    };
    const s = resolveExternalJobSettings({ config, env, registry: fakeRegistry() });
    assert.strictEqual(s.submitTimeoutMs, 7777, 'env submit wins');
    assert.strictEqual(s.pollTimeoutMs, 8888, 'env poll wins');
    assert.strictEqual(s.artifactDir, 'Artifacts/env', 'env artifact_dir wins');
});

test('resolveExternalJobSettings degrades to hardcoded defaults when registry is absent and config empty', () => {
    // Defensive: if a caller passes no registry (e.g. a minimal embed), the
    // adapter must still produce sane timeouts (CLAUDE.md bounded-subprocess).
    const s = resolveExternalJobSettings({ config: {}, env: {} });
    assert.strictEqual(s.submitTimeoutMs, 30000);
    assert.strictEqual(s.pollTimeoutMs, 15000);
    assert.strictEqual(s.artifactDir, 'Artifacts/jobs');
});

test('resolveExternalJobSettings ignores a non-numeric config value (no guessing — falls back)', () => {
    const config = { external_job: { submit_timeout_ms: 'not-a-number' } };
    const s = resolveExternalJobSettings({ config, env: {}, registry: fakeRegistry() });
    // Bad config value must not produce NaN that would unbound execFileSync.
    assert.ok(Number.isFinite(s.submitTimeoutMs), 'submit must stay finite');
    assert.strictEqual(s.submitTimeoutMs, 30000, 'fell back to registry default');
});

// ─── formatShowReport (trust boundary: surface commands, never auto-run) ──────

test('formatShowReport surfaces job identity, status, terminal_details, and the UNTRUSTED command hint', () => {
    const manifest = {
        job_id: '12345',
        plan_id: '3.1',
        backend: 'slurm',
        status: 'completed-unverified',
        terminal_details: { reason: 'ok', exit_code: 0 },
        submit_command: 'sbatch --parsable ./run.sh',
        verification_command: 'python -m verify.py 12345',
        resume_command: '/gsd:execute-phase 3',
    };
    const out = formatShowReport(manifest);
    assert.match(out, /job 12345 \(plan 3\.1, backend slurm\)/);
    assert.match(out, /status: completed-unverified/);
    assert.match(out, /terminal_details:/);
    assert.match(out, /UNTRUSTED — confirm before running/);
    assert.match(out, /verification_command: python -m verify\.py 12345/);
});

test('formatShowReport omits the terminal_details line when none are present', () => {
    const manifest = {
        job_id: '1', plan_id: '1', backend: 'slurm', status: 'running',
        submit_command: 's', verification_command: 'v', resume_command: 'r',
        terminal_details: null,
    };
    const out = formatShowReport(manifest);
    assert.doesNotMatch(out, /terminal_details:/, 'no details line when null');
    assert.match(out, /status: running/);
});

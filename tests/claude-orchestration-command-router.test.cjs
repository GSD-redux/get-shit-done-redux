'use strict';

/**
 * claude-orchestration-command-router.test.cjs — end-to-end tests for the
 * `gsd-tools claude-orchestration` command surface (#1143).
 *
 * Exercises the full dispatch path: gsd-tools → dispatchCapabilityCommand →
 * routeClaudeOrchestrationCommand → the pure detect/emitter functions.
 *
 * NOTE: runGsdTools() returns { success, output, exitCode, error } — it does
 * NOT throw on a non-zero exit (helpers.cjs). Tests assert `.success` and parse
 * `.output`, and check `.error` on the failure path.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WAVES_MANIFEST = {
  waves: [
    {
      id: 'w1',
      plans: [
        { id: 'p1', brief: 'Implement the foo module', files_modified: ['src/foo.cts'] },
        { id: 'p2', brief: 'Wire the bar seam', files_modified: ['src/bar.cts'] },
      ],
    },
  ],
};

function writeManifest(tmpDir) {
  const manifestPath = path.join(tmpDir, 'waves.json');
  fs.writeFileSync(manifestPath, JSON.stringify(WAVES_MANIFEST), 'utf8');
  return manifestPath;
}

/** Run the command and assert it succeeded, returning the parsed JSON output. */
function runAndParse(args, cwd) {
  const res = runGsdTools(args, cwd);
  assert.strictEqual(res.success, true, 'command should succeed; stderr: ' + (res.error || ''));
  assert.ok(res.output.length > 0, 'command should emit output');
  return JSON.parse(res.output);
}

// ─── emit-workflow ────────────────────────────────────────────────────────────

describe('claude-orchestration emit-workflow (CLI)', () => {
  test('emits a Workflow script with parallel barriers, gsd-executor + worktree, and resumeFromRunId', () => {
    const tmp = createTempProject('claw-emit-');
    try {
      const manifestPath = writeManifest(tmp);
      const parsed = runAndParse([
        'claude-orchestration', 'emit-workflow',
        '--waves', manifestPath,
        '--run-id', 'run-cli-1143',
        '--phase-dir', '.planning/phases/01-foo',
      ], tmp);
      assert.ok(typeof parsed.script === 'string' && parsed.script.length > 0);
      assert.ok(parsed.script.includes('parallel('), 'parallel() barrier emitted');
      assert.ok(parsed.script.includes('gsd-executor'), 'gsd-executor agentType');
      assert.ok(parsed.script.includes('worktree'), 'worktree isolation');
      // #2590: never CALLED — it is a Workflow tool input, not a script function.
      assert.ok(!/^\s*resumeFromRunId\s*\(/m.test(parsed.script), 'must not CALL resumeFromRunId');
      assert.ok(parsed.script.includes('run-cli-1143'), 'carries the run id');
      assert.strictEqual(parsed.summary.resumeRunId, 'run-cli-1143');
      assert.strictEqual(parsed.summary.waves, 1);
      assert.strictEqual(parsed.summary.plans, 2);
    } finally {
      cleanup(tmp);
    }
  });

  test('budget flag threads a shared token pool into the script', () => {
    const tmp = createTempProject('claw-budget-');
    try {
      const manifestPath = writeManifest(tmp);
      const parsed = runAndParse([
        'claude-orchestration', 'emit-workflow',
        '--waves', manifestPath,
        '--run-id', 'r',
        '--budget', '750000',
      ], tmp);
      // #2590: `budget` is read-only; budget(750000) threw "budget is not a
      // function". The intended pool is recorded, not called.
      assert.ok(!/^\s*budget\s*\(/m.test(parsed.script), 'must not CALL budget()');
      assert.ok(parsed.script.includes('750000'));
      assert.strictEqual(parsed.summary.budgetTokens, 750000);
    } finally {
      cleanup(tmp);
    }
  });

  test('missing --waves -> non-zero exit with a diagnostic', () => {
    const tmp = createTempProject('claw-noargs-');
    try {
      const res = runGsdTools([
        'claude-orchestration', 'emit-workflow', '--run-id', 'r',
      ], tmp);
      assert.strictEqual(res.success, false, 'missing --waves must fail');
      assert.ok(res.exitCode !== 0, 'non-zero exit');
      assert.match(res.error || '', /--waves/);
    } finally {
      cleanup(tmp);
    }
  });
});

// ─── detect-backend ───────────────────────────────────────────────────────────

describe('claude-orchestration detect-backend (CLI)', () => {
  test('default config (capability off) -> inline, even on Claude', () => {
    const tmp = createTempProject('claw-detect-');
    try {
      const parsed = runAndParse([
        'claude-orchestration', 'detect-backend',
        '--runtime', 'claude',
        '--agent-sdk-version', '1.0.0',
      ], tmp);
      assert.strictEqual(parsed.backend, 'inline');
      assert.strictEqual(parsed.available, false);
      assert.match(parsed.reason, /disabled/);
    } finally {
      cleanup(tmp);
    }
  });

  test('enabled + claude + capable + new-enough SDK -> workflow', () => {
    const tmp = createTempProject('claw-detect-on-');
    try {
      fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.planning', 'config.json'),
        JSON.stringify({ claude_orchestration: { enabled: true, execution_backend: 'auto' } }),
        'utf8',
      );
      const parsed = runAndParse([
        'claude-orchestration', 'detect-backend',
        '--runtime', 'claude',
        '--agent-sdk-version', '1.2.0',
      ], tmp);
      assert.strictEqual(parsed.backend, 'workflow');
      assert.strictEqual(parsed.available, true);
    } finally {
      cleanup(tmp);
    }
  });

  test('non-Claude runtime -> inline (criterion 6)', () => {
    const tmp = createTempProject('claw-detect-nonclaude-');
    try {
      fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.planning', 'config.json'),
        JSON.stringify({ claude_orchestration: { enabled: true } }),
        'utf8',
      );
      const parsed = runAndParse([
        'claude-orchestration', 'detect-backend',
        '--runtime', 'codex',
        '--agent-sdk-version', '1.0.0',
      ], tmp);
      assert.strictEqual(parsed.backend, 'inline');
      assert.match(parsed.reason, /claude/i);
    } finally {
      cleanup(tmp);
    }
  });
});

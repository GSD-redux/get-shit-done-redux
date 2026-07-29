/**
 * #2590 — every emitted Workflow script was rejected by the Workflow tool.
 *
 * `emitWorkflowScript` generated four constructs the tool does not accept. The
 * first was fatal on its own, so the backend could never dispatch a wave:
 *
 *   1. no `export const meta = {…}` first statement  -> whole script rejected
 *   2. `resumeFromRunId("<id>")`  -> "resumeFromRunId is not defined"
 *      (it is a Workflow TOOL INPUT parameter, not a script function)
 *   3. `budget(<n>)`             -> "budget is not a function"
 *      (`budget` is a read-only object { total, spent(), remaining() })
 *   4. `parallel(agent(…), agent(…))` -> "parallel() expects an array of functions"
 *
 * Plus two secondary defects that kept the emitted script from ever being
 * REACHED, which is why this shipped undetected:
 *
 *   5. nothing resolved the Agent SDK version, so gate 5 returned
 *      `agent_sdk_version_unknown` on every automated run
 *   6. the runtime fallback was `--runtime > GSD_RUNTIME > 'unknown'`, diverging
 *      from the canonical `GSD_RUNTIME > config.runtime > 'claude'`, so any
 *      invocation without --runtime reported `runtime_not_claude`
 *
 * The script assertions parse the emitted text as a real ES module rather than
 * pattern-matching it, so a syntactically invalid script fails outright.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');

const core = require('../gsd-core/bin/lib/claude-orchestration.cjs');
const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

function emit(overrides) {
  const input = Object.assign({
    phaseDir: '.planning/phases/01',
    runId: 'execute-1',
    waves: [{ id: 'wave-1', plans: [{ id: '01-01', brief: 'noop', files_modified: ['a.ts'] }] }],
  }, overrides || {});
  const r = core.emitWorkflowScript(input);
  assert.ok(r.ok, `emit failed: ${JSON.stringify(r)}`);
  return r;
}

/** First non-comment, non-blank line — the script's first actual statement. */
function firstStatement(script) {
  return script.split('\n').map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('//')) || '';
}

describe('#2590: emitted Workflow scripts satisfy the Workflow tool contract', () => {
  test('the emitted script is syntactically valid as an ES module', () => {
    // `export const meta` + top-level `await` only parse in module context —
    // which is exactly the context the Workflow tool runs the script in.
    const { script } = emit({
      waves: [
        { id: 'w1', plans: [
          { id: 'a', brief: 'one', files_modified: ['a.ts'] },
          { id: 'b', brief: 'two', files_modified: ['b.ts'] },
        ] },
        { id: 'w2', plans: [{ id: 'c', brief: 'three', files_modified: ['c.ts'] }] },
      ],
    });
    // .mjs so node parses it in module context, inside a helper temp dir so
    // cleanup() carries the Windows-EBUSY retry budget.
    const dir = createTempDir('gsd-2590-parse-');
    const f = path.join(dir, 'emitted.mjs');
    fs.writeFileSync(f, script);
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      assert.fail(`emitted script does not parse: ${e.stderr ? e.stderr.toString() : e.message}`);
    } finally {
      cleanup(dir);
    }
  });

  test('1. `export const meta` is the first statement', () => {
    const { script } = emit();
    assert.match(
      firstStatement(script),
      /^export const meta = \{/,
      'the Workflow tool rejects any script whose first statement is not the meta block',
    );
  });

  test('meta.phases titles match the emitted phase() calls exactly', () => {
    // The tool matches phase titles by exact string; a mismatch silently splits
    // progress into an unnamed group.
    const { script } = emit({
      waves: [
        { id: 'alpha', plans: [{ id: 'a', brief: 'one', files_modified: ['a.ts'] }] },
        { id: 'beta', plans: [{ id: 'b', brief: 'two', files_modified: ['b.ts'] }] },
      ],
    });
    const metaTitles = [...script.matchAll(/\{ title: "([^"]+)"/g)].map((m) => m[1]);
    const phaseTitles = [...script.matchAll(/^phase\("([^"]+)"\)/gm)].map((m) => m[1]);
    assert.deepEqual(metaTitles, ['Wave alpha', 'Wave beta']);
    assert.deepEqual(phaseTitles, metaTitles, 'phase() titles must match meta.phases exactly');
  });

  test('duplicate wave ids are rejected (phase titles must map 1:1)', () => {
    // Two waves sharing an id emit two identical `phase("Wave x")` calls and two
    // identical meta.phases entries; the tool matches titles by exact string, so
    // the second wave's agents would be attributed to the first's progress group.
    const r = core.emitWorkflowScript({
      phaseDir: '.planning/phases/01',
      runId: 'execute-1',
      waves: [
        { id: 'dup', plans: [{ id: 'a', brief: 'one', files_modified: ['a.ts'] }] },
        { id: 'dup', plans: [{ id: 'b', brief: 'two', files_modified: ['b.ts'] }] },
      ],
    });
    assert.equal(r.ok, false, 'duplicate wave ids must be rejected, not silently merged');
    assert.match(String(r.reason), /duplicate wave id/);
  });

  test('distinct wave ids are still accepted (the boundary either side)', () => {
    const r = core.emitWorkflowScript({
      phaseDir: '.planning/phases/01',
      runId: 'execute-1',
      waves: [
        { id: 'w1', plans: [{ id: 'a', brief: 'one', files_modified: ['a.ts'] }] },
        { id: 'w2', plans: [{ id: 'b', brief: 'two', files_modified: ['b.ts'] }] },
      ],
    });
    assert.equal(r.ok, true, `distinct wave ids must pass: ${JSON.stringify(r)}`);
  });

  test('2. resumeFromRunId is never CALLED (it is a tool input, not a function)', () => {
    const { script, summary } = emit({ runId: 'execute-7' });
    assert.ok(
      !/^\s*resumeFromRunId\s*\(/m.test(script),
      'calling resumeFromRunId() throws "resumeFromRunId is not defined"',
    );
    // The run id must still reach the caller, which passes it as the tool input.
    assert.equal(summary.resumeRunId, 'execute-7');
  });

  test('3. budget is never CALLED, at and around the boundary', () => {
    // budgetTokens is floored at > 0; check 0 (rejected), 1 (accepted), and a
    // large value — none may produce a budget(...) call.
    for (const tokens of [0, 1, 500000]) {
      const { script, summary } = emit({ budgetTokens: tokens });
      assert.ok(
        !/^\s*budget\s*\(/m.test(script),
        `budgetTokens=${tokens}: calling budget() throws "budget is not a function"`,
      );
      assert.equal(summary.budgetTokens, tokens > 0 ? tokens : null);
    }
  });

  test('4. parallel() receives an array of thunks, not agent() results', () => {
    const { script } = emit({
      waves: [{ id: 'w', plans: [
        { id: 'a', brief: 'one', files_modified: ['a.ts'] },
        { id: 'b', brief: 'two', files_modified: ['b.ts'] },
      ] }],
    });
    assert.ok(/parallel\(\[/.test(script), 'parallel() expects an array of functions');
    assert.ok(
      !/parallel\(\s*agent\(/.test(script),
      'passing agent() results directly both throws and starts every agent eagerly',
    );
    // Each agent must be wrapped in a thunk so parallel() can bound concurrency.
    const agents = [...script.matchAll(/agent\("/g)].length;
    const thunks = [...script.matchAll(/\(\) => agent\("/g)].length;
    assert.equal(thunks, agents, 'every agent() must be wrapped in a () => thunk');
  });

  test('single-plan stages also emit an array (regression: the 1-plan branch)', () => {
    // The pre-fix code had a SEPARATE single-plan branch that emitted
    // `parallel(\n agent(...)\n)` — valid-looking but the same defect.
    const { script } = emit();
    assert.ok(/parallel\(\[/.test(script));
    assert.equal([...script.matchAll(/\(\) => agent\("/g)].length, 1);
  });

  test('per-plan worktree isolation still mirrors use_worktree', () => {
    const { script } = emit({
      waves: [{ id: 'w', plans: [
        { id: 'a', brief: 'iso', files_modified: ['a.ts'] },
        { id: 'b', brief: 'noiso', files_modified: ['b.ts'], use_worktree: false },
      ] }],
    });
    assert.match(script, /agent\("iso", \{ agentType: "gsd-executor", isolation: "worktree" \}\)/);
    assert.match(script, /agent\("noiso", \{ agentType: "gsd-executor" \}\)/);
  });
});

describe('#2590: the backend is reachable without hand-passed flags', () => {
  function repro() {
    const dir = createTempDir('gsd-2590-repro-');
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ claude_orchestration: { enabled: true } }),
    );
    fs.writeFileSync(
      path.join(dir, 'waves.json'),
      JSON.stringify({ waves: [{ id: 'wave-1', plans: [{ id: '01-01', brief: 'noop', files_modified: ['a.ts'] }] }] }),
    );
    return dir;
  }

  function resolve(dir, extraArgs) {
    const out = execFileSync(process.execPath, [
      TOOLS, 'claude-orchestration', 'resolve-wave-dispatch',
      '--waves', 'waves.json', '--run-id', 'execute-1',
      '--phase-dir', '.planning/phases/01', '--raw',
      ...(extraArgs || []),
    ], { cwd: dir, encoding: 'utf8' });
    return JSON.parse(out);
  }

  test('5+6. no --runtime and no --agent-sdk-version still reaches the version gate', () => {
    const dir = repro();
    try {
      const r = resolve(dir);
      // Pre-fix this was `agent_sdk_version_unknown` (nothing resolved a
      // version) or `runtime_not_claude` (the divergent fallback). Either is a
      // regression; the version gate must now be reached and answer truthfully.
      assert.notEqual(r.reason, 'agent_sdk_version_unknown',
        'the router must resolve the installed SDK version itself');
      assert.notEqual(r.reason, 'runtime_not_claude',
        'runtime must fall back to the canonical config.runtime > claude chain');
    } finally {
      cleanup(dir);
    }
  });

  test('an SDK version above the floor activates the workflow backend end to end', () => {
    const dir = repro();
    try {
      const r = resolve(dir, ['--agent-sdk-version', '0.3.149']);
      assert.equal(r.backend, 'workflow', `expected workflow backend, got ${JSON.stringify(r)}`);
      assert.ok(typeof r.script === 'string' && r.script.length > 0);
      assert.match(firstStatement(r.script), /^export const meta = \{/);
    } finally {
      cleanup(dir);
    }
  });

  test('an explicit --agent-sdk-version still wins over the installed one', () => {
    const dir = repro();
    try {
      // A deliberately ancient pin must be honored (and decline), proving the
      // flag is not ignored now that a fallback exists.
      const r = resolve(dir, ['--agent-sdk-version', '0.0.1']);
      assert.equal(r.backend, 'inline');
      assert.equal(r.reason, 'agent_sdk_version_below_floor');
    } finally {
      cleanup(dir);
    }
  });

  test('GSD_AGENT_SDK_VERSION is honored between the flag and the installed version', () => {
    const dir = repro();
    try {
      const out = execFileSync(process.execPath, [
        TOOLS, 'claude-orchestration', 'resolve-wave-dispatch',
        '--waves', 'waves.json', '--run-id', 'execute-1',
        '--phase-dir', '.planning/phases/01', '--raw',
      ], { cwd: dir, encoding: 'utf8', env: { ...process.env, GSD_AGENT_SDK_VERSION: '0.3.149' } });
      assert.equal(JSON.parse(out).backend, 'workflow');
    } finally {
      cleanup(dir);
    }
  });
});

'use strict';

// #4422 — base-branch health gate.
//
// Risk asymmetry drives this suite (see scripts/ci-next-health.cjs's header):
//   false positive (a healthy `next` called RED)   => blocks every PR merge
//     until a human notices and applies the `fix-next` bypass label.
//   false negative (a broken `next` called healthy) => reproduces the #4422
//     incident exactly (three unrelated PRs merged on top of an already-broken
//     `next`).
// Unlike the mergeability preflight, this gate does NOT fail open on a
// definite RED signal — only on an unavailable/inapplicable one.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const fc = require('fast-check');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci-next-health.cjs');

const {
  VERDICT,
  BYPASS_LABEL,
  classifyRunConclusion,
  resolveNextHealth,
  main,
} = require('../scripts/ci-next-health.cjs');

// ---------------------------------------------------------------------------
// Fakes. The seams are parameters, not module patches — no global state, so
// every case is order-independent.
// ---------------------------------------------------------------------------

/** A fetchLatestRun fake that replays a scripted response; an Error is thrown. */
function scriptedFetch(response) {
  const calls = [];
  const fn = async (branch) => {
    calls.push(branch);
    if (response instanceof Error) throw response;
    return response;
  };
  fn.calls = calls;
  return fn;
}

function runPayload(conclusion, htmlUrl = 'https://github.com/open-gsd/gsd-core/actions/runs/1') {
  return { workflow_runs: [{ conclusion, html_url: htmlUrl }] };
}

// ---------------------------------------------------------------------------
// A. classifyRunConclusion — pure
// ---------------------------------------------------------------------------

describe('ci-next-health: classifyRunConclusion', () => {
  test('classifies an undefined payload as INDETERMINATE', () => {
    assert.equal(classifyRunConclusion(undefined), VERDICT.INDETERMINATE);
  });

  test('classifies a null payload as INDETERMINATE', () => {
    assert.equal(classifyRunConclusion(null), VERDICT.INDETERMINATE);
  });

  test('classifies a non-object payload as INDETERMINATE', () => {
    for (const value of [0, 'str', true, 42]) {
      assert.equal(classifyRunConclusion(value), VERDICT.INDETERMINATE);
    }
  });

  test('classifies a payload whose workflow_runs is not an array as INDETERMINATE', () => {
    for (const value of [undefined, null, 'x', {}, 1]) {
      assert.equal(classifyRunConclusion({ workflow_runs: value }), VERDICT.INDETERMINATE);
    }
  });

  test('classifies an empty workflow_runs array as CLEAN', () => {
    // A brand-new release/**/hotfix/** branch with no Tests history yet must
    // not be permanently unmergeable.
    assert.equal(classifyRunConclusion({ workflow_runs: [] }), VERDICT.CLEAN);
  });

  test('classifies conclusion: success as CLEAN', () => {
    assert.equal(classifyRunConclusion(runPayload('success')), VERDICT.CLEAN);
  });

  test('classifies conclusion: failure as RED', () => {
    assert.equal(classifyRunConclusion(runPayload('failure')), VERDICT.RED);
  });

  test('classifies conclusion: cancelled as RED', () => {
    // A cancelled/timed-out run on the base branch is not evidence of health.
    assert.equal(classifyRunConclusion(runPayload('cancelled')), VERDICT.RED);
  });

  test('classifies every non-success conclusion as RED', () => {
    for (const conclusion of ['timed_out', 'action_required', 'neutral', 'skipped', 'stale']) {
      assert.equal(
        classifyRunConclusion(runPayload(conclusion)),
        VERDICT.RED,
        `conclusion=${conclusion} must be RED`,
      );
    }
  });

  test('only reads the FIRST run in workflow_runs', () => {
    const payload = { workflow_runs: [{ conclusion: 'success' }, { conclusion: 'failure' }] };
    assert.equal(classifyRunConclusion(payload), VERDICT.CLEAN);
  });

  test('VERDICT is frozen and its atom set is locked', () => {
    assert.ok(Object.isFrozen(VERDICT));
    assert.deepEqual(
      Object.keys(VERDICT).sort(),
      ['BYPASSED', 'CLEAN', 'INDETERMINATE', 'RED', 'SKIPPED_NOT_APPLICABLE'],
    );
  });

  // A well-formed payload has an ARRAY workflow_runs of length 0 or 1, whose
  // sole element (if present) carries an arbitrary `conclusion` string. A
  // malformed payload is anything else: a non-object payload, or an object
  // whose `workflow_runs` is not an array.
  const wellFormedPayloadArb = fc.record({
    workflow_runs: fc.oneof(
      fc.constant([]),
      fc.tuple(fc.record({ conclusion: fc.string() })),
    ),
  });

  const malformedNonArrayRunsArb = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.dictionary(fc.string(), fc.string()),
  );

  const malformedPayloadArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.record({ workflow_runs: malformedNonArrayRunsArb }),
  );

  const payloadArb = fc.oneof(wellFormedPayloadArb, malformedPayloadArb);

  test('CLEAN iff (workflow_runs is empty) or (first run succeeded); everything else RED or INDETERMINATE (property)', () => {
    fc.assert(
      fc.property(payloadArb, (payload) => {
        const verdict = classifyRunConclusion(payload);

        const isObject = payload !== null && typeof payload === 'object';
        const hasArrayRuns = isObject && Array.isArray(payload.workflow_runs);

        if (!hasArrayRuns) {
          return verdict === VERDICT.INDETERMINATE;
        }

        const isClean = payload.workflow_runs.length === 0
          || payload.workflow_runs[0].conclusion === 'success';

        if (isClean) return verdict === VERDICT.CLEAN;
        return verdict === VERDICT.RED;
      }),
      { seed: 4422, numRuns: 500, verbose: true },
    );
  });
});

// ---------------------------------------------------------------------------
// B. resolveNextHealth — dependency-injected orchestrator
// ---------------------------------------------------------------------------

describe('ci-next-health: resolveNextHealth', () => {
  test('a push event is SKIPPED_NOT_APPLICABLE without calling fetchLatestRun', async () => {
    const fetchLatestRun = scriptedFetch(runPayload('failure'));
    const result = await resolveNextHealth({ fetchLatestRun, eventName: 'push', baseRef: 'next', labels: [] });
    assert.equal(result.verdict, VERDICT.SKIPPED_NOT_APPLICABLE);
    assert.equal(fetchLatestRun.calls.length, 0);
  });

  test('workflow_dispatch is SKIPPED_NOT_APPLICABLE without calling fetchLatestRun', async () => {
    const fetchLatestRun = scriptedFetch(runPayload('failure'));
    const result = await resolveNextHealth({
      fetchLatestRun, eventName: 'workflow_dispatch', baseRef: 'next', labels: [],
    });
    assert.equal(result.verdict, VERDICT.SKIPPED_NOT_APPLICABLE);
    assert.equal(fetchLatestRun.calls.length, 0);
  });

  test('an unknown/absent event name is SKIPPED_NOT_APPLICABLE without calling', async () => {
    for (const eventName of ['', undefined, 'schedule', 'release', 'issues']) {
      const fetchLatestRun = scriptedFetch(runPayload('failure'));
      const result = await resolveNextHealth({ fetchLatestRun, eventName, baseRef: 'next', labels: [] });
      assert.equal(result.verdict, VERDICT.SKIPPED_NOT_APPLICABLE);
      assert.equal(fetchLatestRun.calls.length, 0);
    }
  });

  test('a pull_request event with no resolvable base ref is INDETERMINATE', async () => {
    for (const baseRef of [undefined, null, '', '   ']) {
      const fetchLatestRun = scriptedFetch(runPayload('failure'));
      const result = await resolveNextHealth({ fetchLatestRun, eventName: 'pull_request', baseRef, labels: [] });
      assert.equal(result.verdict, VERDICT.INDETERMINATE);
      assert.equal(fetchLatestRun.calls.length, 0);
    }
  });

  test('a merge_group event with no resolvable base ref is INDETERMINATE', async () => {
    const fetchLatestRun = scriptedFetch(runPayload('failure'));
    const result = await resolveNextHealth({ fetchLatestRun, eventName: 'merge_group', baseRef: '', labels: [] });
    assert.equal(result.verdict, VERDICT.INDETERMINATE);
    assert.equal(fetchLatestRun.calls.length, 0);
  });

  test('a throwing fetchLatestRun degrades to INDETERMINATE', async () => {
    const fetchLatestRun = scriptedFetch(new Error('ECONNRESET'));
    const result = await resolveNextHealth({ fetchLatestRun, eventName: 'pull_request', baseRef: 'next', labels: [] });
    assert.equal(result.verdict, VERDICT.INDETERMINATE);
  });

  test('a RED verdict with the fix-next label is BYPASSED', async () => {
    const fetchLatestRun = scriptedFetch(runPayload('failure'));
    const result = await resolveNextHealth({
      fetchLatestRun, eventName: 'pull_request', baseRef: 'next', labels: ['needs-triage', BYPASS_LABEL],
    });
    assert.equal(result.verdict, VERDICT.BYPASSED);
  });

  test('a RED verdict with no matching label stays RED', async () => {
    const fetchLatestRun = scriptedFetch(runPayload('failure'));
    const result = await resolveNextHealth({
      fetchLatestRun, eventName: 'pull_request', baseRef: 'next', labels: ['needs-triage'],
    });
    assert.equal(result.verdict, VERDICT.RED);
  });

  test('a RED verdict with an absent labels array stays RED (merge_group has no label surface)', async () => {
    const fetchLatestRun = scriptedFetch(runPayload('failure'));
    const result = await resolveNextHealth({
      fetchLatestRun, eventName: 'merge_group', baseRef: 'next', labels: undefined,
    });
    assert.equal(result.verdict, VERDICT.RED);
  });

  test('a CLEAN verdict (success conclusion) is not affected by labels', async () => {
    const fetchLatestRun = scriptedFetch(runPayload('success'));
    const result = await resolveNextHealth({
      fetchLatestRun, eventName: 'pull_request', baseRef: 'next', labels: [BYPASS_LABEL],
    });
    assert.equal(result.verdict, VERDICT.CLEAN);
  });

  test('a CLEAN verdict (empty workflow_runs array)', async () => {
    const fetchLatestRun = scriptedFetch({ workflow_runs: [] });
    const result = await resolveNextHealth({
      fetchLatestRun, eventName: 'pull_request', baseRef: 'release/1.0', labels: [],
    });
    assert.equal(result.verdict, VERDICT.CLEAN);
  });

  test('merge_group resolves the same way as pull_request given a base ref', async () => {
    const fetchLatestRun = scriptedFetch(runPayload('success'));
    const result = await resolveNextHealth({
      fetchLatestRun, eventName: 'merge_group', baseRef: 'next', labels: [],
    });
    assert.equal(result.verdict, VERDICT.CLEAN);
    assert.deepEqual(fetchLatestRun.calls, ['next']);
  });
});

// ---------------------------------------------------------------------------
// C. main() — integration through the process seam against a real local API.
//
// The CLI's real fetch path is exercised by pointing GITHUB_API_URL at a
// throwaway localhost server, so no production test-mode branch exists and
// nothing reaches api.github.com.
// ---------------------------------------------------------------------------

const SENTINEL_TOKEN = 'ghs_sentinel_must_never_be_echoed_4422';

/** Start a one-shot API stub. `handler(requestCount)` returns { status, body }. */
async function startApiStub(handler) {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    const { status, body } = handler(requestCount++);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    get requestCount() { return requestCount; },
  };
}

function runCli(env, { outputPath } = {}) {
  return runNode([SCRIPT], {
    cwd: ROOT,
    timeoutMs: PROBE_TIMEOUT_MS,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'open-gsd/gsd-core',
      GITHUB_TOKEN: SENTINEL_TOKEN,
      GITHUB_BASE_REF: 'next',
      ...(outputPath ? { GITHUB_OUTPUT: outputPath } : {}),
      ...env,
    },
  });
}

// `runNode` (tests/helpers/process-seam.cjs) is spawnSync: it blocks this
// process's event loop for the whole child lifetime. `startApiStub` is an
// http.createServer living in THIS process, so while spawnSync blocks, the
// stub can never accept the child's connection. Any test that needs the stub
// must instead call main() in-process, which keeps this process's event loop
// live so the stub can actually answer. Mirrors tests/ci-pr-mergeability.test.cjs.
async function callMain(t, env, { outputPath } = {}) {
  const overrides = {
    GITHUB_REPOSITORY: 'open-gsd/gsd-core',
    GITHUB_TOKEN: SENTINEL_TOKEN,
    GITHUB_BASE_REF: 'next',
    ...(outputPath ? { GITHUB_OUTPUT: outputPath } : {}),
    ...env,
  };
  const saved = new Map();
  for (const key of Object.keys(overrides)) saved.set(key, process.env[key]);
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const stdout = [];
  const stderr = [];
  t.mock.method(process.stdout, 'write', (chunk) => { stdout.push(String(chunk)); return true; });
  t.mock.method(process.stderr, 'write', (chunk) => { stderr.push(String(chunk)); return true; });

  const code = await main([]);
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

function readOutputs(outputPath) {
  const raw = fs.readFileSync(outputPath, 'utf8');
  const outputs = {};
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) outputs[line.slice(0, index)] = line.slice(index + 1);
  }
  return outputs;
}

describe('ci-next-health: CLI', () => {
  test('exits 0 and writes a skip verdict on a push event', (t) => {
    const dir = createTempDir('next-health-skip-');
    t.after(() => cleanup(dir));
    const outputPath = path.join(dir, 'gh-output');

    const result = runCli({ GITHUB_EVENT_NAME: 'push' }, { outputPath });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(readOutputs(outputPath).verdict, VERDICT.SKIPPED_NOT_APPLICABLE);
  });

  test('exits 1 and annotates the failing run on a RED base branch', async (t) => {
    const dir = createTempDir('next-health-red-');
    const api = await startApiStub(() => ({
      status: 200,
      body: { workflow_runs: [{ conclusion: 'failure', html_url: 'https://example.test/runs/99' }] },
    }));
    t.after(async () => { await api.close(); cleanup(dir); });
    const outputPath = path.join(dir, 'gh-output');

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url, PR_LABELS: '' },
      { outputPath },
    );

    assert.equal(result.code, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const combined = `${result.stdout}${result.stderr}`;
    assert.ok(combined.includes('::error::'), 'must emit a workflow error annotation');
    assert.match(combined, /https:\/\/example\.test\/runs\/99/, 'must name the failing run URL');
    assert.equal(readOutputs(outputPath).verdict, VERDICT.RED);
  });

  test('exits 0 with a warning when the fix-next label bypasses a RED base branch', async (t) => {
    const dir = createTempDir('next-health-bypass-');
    const api = await startApiStub(() => ({
      status: 200,
      body: { workflow_runs: [{ conclusion: 'failure', html_url: 'https://example.test/runs/100' }] },
    }));
    t.after(async () => { await api.close(); cleanup(dir); });
    const outputPath = path.join(dir, 'gh-output');

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url, PR_LABELS: `needs-triage,${BYPASS_LABEL}` },
      { outputPath },
    );

    assert.equal(result.code, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const combined = `${result.stdout}${result.stderr}`;
    assert.ok(combined.includes('::warning::'), 'must warn that a human bypassed the gate');
    assert.match(combined, /https:\/\/example\.test\/runs\/100/, 'the warning must name the failing run URL');
    assert.ok(!combined.includes('::error::'), 'a bypassed gate must not also emit an error annotation');
    assert.equal(readOutputs(outputPath).verdict, VERDICT.BYPASSED);
  });

  test('exits 0 on a clean base branch', async (t) => {
    const dir = createTempDir('next-health-clean-');
    const api = await startApiStub(() => ({ status: 200, body: { workflow_runs: [{ conclusion: 'success' }] } }));
    t.after(async () => { await api.close(); cleanup(dir); });
    const outputPath = path.join(dir, 'gh-output');

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url, PR_LABELS: '' },
      { outputPath },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(readOutputs(outputPath).verdict, VERDICT.CLEAN);
  });

  test('resolves the merge_group base ref from MERGE_GROUP_BASE_REF, stripping refs/heads/', async (t) => {
    const dir = createTempDir('next-health-mergequeue-');
    const api = await startApiStub(() => ({ status: 200, body: { workflow_runs: [{ conclusion: 'success' }] } }));
    t.after(async () => { await api.close(); cleanup(dir); });
    const outputPath = path.join(dir, 'gh-output');

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'merge_group', MERGE_GROUP_BASE_REF: 'refs/heads/next', GITHUB_API_URL: api.url },
      { outputPath },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(readOutputs(outputPath).verdict, VERDICT.CLEAN);
  });

  test('fails open when the API rejects the read', async (t) => {
    const dir = createTempDir('next-health-403-');
    const api = await startApiStub(() => ({ status: 403, body: { message: 'Resource not accessible' } }));
    t.after(async () => { await api.close(); cleanup(dir); });
    const outputPath = path.join(dir, 'gh-output');

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url },
      { outputPath },
    );

    assert.equal(result.code, 0, 'an unreadable base branch is not a red base branch');
    assert.equal(readOutputs(outputPath).verdict, VERDICT.INDETERMINATE);
  });

  test('fails open when the API body is not a JSON object', async (t) => {
    const dir = createTempDir('next-health-badjson-');
    const api = await startApiStub(() => ({ status: 200, body: 'not json at all' }));
    t.after(async () => { await api.close(); cleanup(dir); });
    const outputPath = path.join(dir, 'gh-output');

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url },
      { outputPath },
    );

    assert.equal(result.code, 0);
    assert.equal(readOutputs(outputPath).verdict, VERDICT.INDETERMINATE);
  });

  test('works when GITHUB_OUTPUT is not set', (t) => {
    const dir = createTempDir('next-health-nooutput-');
    t.after(() => cleanup(dir));

    const result = runCli({ GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: '' });

    assert.equal(result.exitCode, 0, result.stderr);
  });

  test('an unwritable GITHUB_OUTPUT does not change the exit code', async (t) => {
    // A failure while REPORTING the verdict must never invert the gate.
    // Injected by pointing at a path whose parent does not exist — no mode-bit
    // tricks, which root Docker/CI silently bypasses.
    const dir = createTempDir('next-health-badout-');
    const api = await startApiStub(() => ({ status: 200, body: { workflow_runs: [{ conclusion: 'failure' }] } }));
    t.after(async () => { await api.close(); cleanup(dir); });
    const outputPath = path.join(dir, 'no-such-dir', 'gh-output');

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url, PR_LABELS: '' },
      { outputPath },
    );

    assert.equal(result.code, 1, 'a RED base branch must still exit 1 when the output write fails');
  });

  test('never echoes the token', async (t) => {
    const dir = createTempDir('next-health-token-');
    const api = await startApiStub(() => ({ status: 500, body: { message: 'boom' } }));
    t.after(async () => { await api.close(); cleanup(dir); });

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url },
      { outputPath: path.join(dir, 'gh-output') },
    );

    assert.ok(!`${result.stdout}${result.stderr}`.includes(SENTINEL_TOKEN));
  });

  test('reports a failure without a stack trace', async (t) => {
    const dir = createTempDir('next-health-nostack-');
    const api = await startApiStub(() => ({ status: 200, body: { workflow_runs: [{ conclusion: 'failure' }] } }));
    t.after(async () => { await api.close(); cleanup(dir); });

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url, PR_LABELS: '' },
      { outputPath: path.join(dir, 'gh-output') },
    );

    assert.ok(!`${result.stdout}${result.stderr}`.includes('    at '), 'no raw stack frames');
  });

  test('prints usage', () => {
    const result = runNode([SCRIPT, '--help'], { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(result.exitCode, 0);
    assert.ok(/Usage/i.test(result.stdout));
  });

  test('rejects an unknown argument', () => {
    const result = runNode([SCRIPT, '--nope'], { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.notEqual(result.exitCode, 0);
    assert.ok(`${result.stdout}${result.stderr}`.includes('--nope'));
  });
});

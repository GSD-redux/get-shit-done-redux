'use strict';

// #3833 — PR mergeability preflight.
//
// Risk asymmetry drives this suite (see .gsd/phase/.../50-test-matrix.md):
//   false positive (clean PR called CONFLICTED) => every compute lane in all
//     eight gated workflows skips, on every PR. Repo-wide outage.
//   false negative (conflict missed)            => today's behavior; the per-job
//     scripts/ci-rebase-check.cjs backstop still catches it.
// So the weight is on the false-positive surface: the single predicate
// `mergeable === false`, and every falsy-but-not-false value around it.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const yaml = require('js-yaml');
const fc = require('fast-check');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci-pr-mergeability.cjs');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const PREFLIGHT_WORKFLOW = 'pr-mergeable-preflight.yml';
const PREFLIGHT_USES = `./.github/workflows/${PREFLIGHT_WORKFLOW}`;

const {
  VERDICT,
  MAX_ATTEMPTS,
  classifyMergeability,
  nextDelayMs,
  resolveMergeability,
  main,
} = require('../scripts/ci-pr-mergeability.cjs');

// ---------------------------------------------------------------------------
// Fakes. The seams are parameters, not module patches — no global state, so
// every case is order-independent.
// ---------------------------------------------------------------------------

/** A fetchPr fake that replays a script of responses; a value that is an Error is thrown. */
function scriptedFetch(responses) {
  const calls = [];
  const fn = async (prNumber) => {
    const index = calls.length;
    calls.push(prNumber);
    const next = index < responses.length ? responses[index] : responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

/** A sleep fake that records the delays it was asked for and never actually waits. */
function recordingSleep() {
  const delays = [];
  const fn = async (ms) => { delays.push(ms); };
  fn.delays = delays;
  return fn;
}

const PR = { number: 4242 };

function resolveWith(overrides) {
  return resolveMergeability({
    eventName: 'pull_request',
    prNumber: PR.number,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// A. classifyMergeability — pure
// ---------------------------------------------------------------------------

describe('ci-pr-mergeability: classifyMergeability', () => {
  test('classifies mergeable true as MERGEABLE', () => {
    assert.equal(classifyMergeability({ mergeable: true }), VERDICT.MERGEABLE);
  });

  test('classifies mergeable false as CONFLICTED', () => {
    assert.equal(classifyMergeability({ mergeable: false }), VERDICT.CONFLICTED);
  });

  test('classifies mergeable null as INDETERMINATE, never CONFLICTED', () => {
    // GitHub's documented "background computation is in progress" sentinel.
    assert.equal(classifyMergeability({ mergeable: null }), VERDICT.INDETERMINATE);
  });

  test('classifies mergeable undefined as INDETERMINATE', () => {
    assert.equal(classifyMergeability({ mergeable: undefined }), VERDICT.INDETERMINATE);
  });

  test('classifies an absent mergeable key as INDETERMINATE', () => {
    assert.equal(classifyMergeability({ id: 1 }), VERDICT.INDETERMINATE);
  });

  test('never treats a falsy non-false mergeable as CONFLICTED', () => {
    // This is the row that forecloses `if (!mergeable) return CONFLICTED`.
    for (const value of [0, -0, '', NaN, null, undefined]) {
      assert.equal(
        classifyMergeability({ mergeable: value }),
        VERDICT.INDETERMINATE,
        `falsy value ${String(value)} must not be a conflict`,
      );
    }
  });

  test('never treats a truthy non-true mergeable as MERGEABLE', () => {
    for (const value of [1, 'true', 'false', {}, [], 'yes']) {
      assert.equal(
        classifyMergeability({ mergeable: value }),
        VERDICT.INDETERMINATE,
        `truthy value ${JSON.stringify(value)} must not be a clean verdict`,
      );
    }
  });

  test('mergeable_state does not override a null mergeable', () => {
    assert.equal(
      classifyMergeability({ mergeable: null, mergeable_state: 'dirty' }),
      VERDICT.INDETERMINATE,
    );
  });

  test('blocked mergeable_state is not a conflict', () => {
    // `blocked` means "required checks have not passed" — always true while
    // this very job is running. Classifying on it self-deadlocks the pipeline.
    assert.equal(
      classifyMergeability({ mergeable: true, mergeable_state: 'blocked' }),
      VERDICT.MERGEABLE,
    );
  });

  test('only mergeable decides the verdict, across every mergeable_state', () => {
    for (const state of ['behind', 'unstable', 'draft', 'unknown', 'clean', 'dirty']) {
      assert.equal(
        classifyMergeability({ mergeable: true, mergeable_state: state }),
        VERDICT.MERGEABLE,
        `mergeable_state=${state} must not change a clean verdict`,
      );
    }
  });

  test('degrades a non-object payload to INDETERMINATE without throwing', () => {
    for (const value of [null, undefined, 0, 'str', true, 42]) {
      assert.equal(classifyMergeability(value), VERDICT.INDETERMINATE);
    }
  });

  test('VERDICT is frozen and its atom set is locked', () => {
    assert.ok(Object.isFrozen(VERDICT));
    assert.deepEqual(
      Object.keys(VERDICT).sort(),
      ['CONFLICTED', 'INDETERMINATE', 'MERGEABLE', 'SKIPPED_NOT_A_PR'],
    );
  });

  test('CONFLICTED iff mergeable === false (property)', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const verdict = classifyMergeability({ mergeable: value });
        return (verdict === VERDICT.CONFLICTED) === (value === false);
      }),
      { seed: 3833, numRuns: 500, verbose: true },
    );
  });
});

// ---------------------------------------------------------------------------
// B. nextDelayMs — pure
// ---------------------------------------------------------------------------

describe('ci-pr-mergeability: nextDelayMs', () => {
  test('first retry waits one base interval', () => {
    assert.equal(nextDelayMs(1, { baseMs: 1000 }), 1000);
  });

  test('backoff is strictly increasing and finite across the budget', () => {
    let previous = 0;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const delay = nextDelayMs(attempt, { baseMs: 1000 });
      assert.ok(Number.isFinite(delay), `delay for attempt ${attempt} must be finite`);
      assert.ok(delay > previous, `delay must increase: ${delay} !> ${previous}`);
      previous = delay;
    }
  });

  test('clamps a non-positive attempt to one base interval', () => {
    for (const attempt of [0, -1, -99, NaN, undefined]) {
      assert.equal(nextDelayMs(attempt, { baseMs: 1000 }), 1000);
    }
  });

  test('total backoff across the full budget stays within the job budget', () => {
    let total = 0;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) total += nextDelayMs(attempt);
    // The preflight job is capped at 3 minutes; the sleeps alone must not
    // approach it, or a slow API turns the optimization into a stall.
    assert.ok(total < 60_000, `total backoff ${total}ms must stay under 60s`);
  });
});

// ---------------------------------------------------------------------------
// C. resolveMergeability — dependency-injected poll loop
// ---------------------------------------------------------------------------

describe('ci-pr-mergeability: resolveMergeability', () => {
  test('resolves on the first read without sleeping', async () => {
    const fetchPr = scriptedFetch([{ mergeable: true }]);
    const sleep = recordingSleep();
    const result = await resolveWith({ fetchPr, sleep });
    assert.equal(result.verdict, VERDICT.MERGEABLE);
    assert.equal(fetchPr.calls.length, 1);
    assert.equal(sleep.delays.length, 0);
  });

  test('polls past a cold null read', async () => {
    const fetchPr = scriptedFetch([{ mergeable: null }, { mergeable: true }]);
    const sleep = recordingSleep();
    const result = await resolveWith({ fetchPr, sleep });
    assert.equal(result.verdict, VERDICT.MERGEABLE);
    assert.equal(fetchPr.calls.length, 2);
    assert.equal(sleep.delays.length, 1);
  });

  test('stops polling the moment a conflict is known', async () => {
    const fetchPr = scriptedFetch([{ mergeable: false }]);
    const sleep = recordingSleep();
    const result = await resolveWith({ fetchPr, sleep });
    assert.equal(result.verdict, VERDICT.CONFLICTED);
    assert.equal(fetchPr.calls.length, 1);
    assert.equal(sleep.delays.length, 0);
  });

  test('a late false is still a conflict', async () => {
    const fetchPr = scriptedFetch([
      { mergeable: null }, { mergeable: null }, { mergeable: false },
    ]);
    const result = await resolveWith({ fetchPr, sleep: recordingSleep() });
    assert.equal(result.verdict, VERDICT.CONFLICTED);
    assert.equal(fetchPr.calls.length, 3);
  });

  test('resolves at limit-1 attempts', async () => {
    const responses = Array.from({ length: MAX_ATTEMPTS - 2 }, () => ({ mergeable: null }));
    responses.push({ mergeable: true });
    const fetchPr = scriptedFetch(responses);
    const result = await resolveWith({ fetchPr, sleep: recordingSleep() });
    assert.equal(result.verdict, VERDICT.MERGEABLE);
    assert.equal(fetchPr.calls.length, MAX_ATTEMPTS - 1);
  });

  test('resolves on the final permitted attempt', async () => {
    const responses = Array.from({ length: MAX_ATTEMPTS - 1 }, () => ({ mergeable: null }));
    responses.push({ mergeable: true });
    const fetchPr = scriptedFetch(responses);
    const result = await resolveWith({ fetchPr, sleep: recordingSleep() });
    assert.equal(result.verdict, VERDICT.MERGEABLE);
    assert.equal(fetchPr.calls.length, MAX_ATTEMPTS);
  });

  test('stops at the budget and never makes a sixth call', async () => {
    // The fake would answer null forever; the budget is what must stop it.
    const fetchPr = scriptedFetch([{ mergeable: null }]);
    const sleep = recordingSleep();
    const result = await resolveWith({ fetchPr, sleep });
    assert.equal(result.verdict, VERDICT.INDETERMINATE);
    assert.equal(fetchPr.calls.length, MAX_ATTEMPTS);
    assert.equal(sleep.delays.length, MAX_ATTEMPTS - 1);
  });

  test('honours a budget of one', async () => {
    const fetchPr = scriptedFetch([{ mergeable: null }]);
    const sleep = recordingSleep();
    const result = await resolveWith({ fetchPr, sleep, maxAttempts: 1 });
    assert.equal(result.verdict, VERDICT.INDETERMINATE);
    assert.equal(fetchPr.calls.length, 1);
    assert.equal(sleep.delays.length, 0);
  });

  test('a non-positive budget makes no API call', async () => {
    for (const maxAttempts of [0, -1]) {
      const fetchPr = scriptedFetch([{ mergeable: false }]);
      const result = await resolveWith({ fetchPr, sleep: recordingSleep(), maxAttempts });
      assert.equal(result.verdict, VERDICT.INDETERMINATE);
      assert.equal(fetchPr.calls.length, 0);
    }
  });

  test('a throwing fetch degrades to INDETERMINATE', async () => {
    const fetchPr = scriptedFetch([new Error('ECONNRESET')]);
    const result = await resolveWith({ fetchPr, sleep: recordingSleep() });
    assert.equal(result.verdict, VERDICT.INDETERMINATE);
    assert.equal(fetchPr.calls.length, MAX_ATTEMPTS);
  });

  test('recovers from a transient fetch error', async () => {
    const fetchPr = scriptedFetch([new Error('503'), { mergeable: true }]);
    const result = await resolveWith({ fetchPr, sleep: recordingSleep() });
    assert.equal(result.verdict, VERDICT.MERGEABLE);
    assert.equal(fetchPr.calls.length, 2);
  });

  test('a conflict after a transient error is still reported', async () => {
    const fetchPr = scriptedFetch([new Error('503'), { mergeable: false }]);
    const result = await resolveWith({ fetchPr, sleep: recordingSleep() });
    assert.equal(result.verdict, VERDICT.CONFLICTED);
  });

  test('makes no API call on a push event', async () => {
    const fetchPr = scriptedFetch([{ mergeable: false }]);
    const sleep = recordingSleep();
    const result = await resolveMergeability({
      eventName: 'push', prNumber: PR.number, fetchPr, sleep,
    });
    assert.equal(result.verdict, VERDICT.SKIPPED_NOT_A_PR);
    assert.equal(fetchPr.calls.length, 0);
    assert.equal(sleep.delays.length, 0);
  });

  test('makes no API call on workflow_dispatch', async () => {
    const fetchPr = scriptedFetch([{ mergeable: false }]);
    const result = await resolveMergeability({
      eventName: 'workflow_dispatch', prNumber: PR.number, fetchPr, sleep: recordingSleep(),
    });
    assert.equal(result.verdict, VERDICT.SKIPPED_NOT_A_PR);
    assert.equal(fetchPr.calls.length, 0);
  });

  test('an unknown event name makes no API call', async () => {
    for (const eventName of ['', undefined, 'schedule', 'release']) {
      const fetchPr = scriptedFetch([{ mergeable: false }]);
      const result = await resolveMergeability({
        eventName, prNumber: PR.number, fetchPr, sleep: recordingSleep(),
      });
      assert.equal(result.verdict, VERDICT.SKIPPED_NOT_A_PR);
      assert.equal(fetchPr.calls.length, 0);
    }
  });

  test('a missing PR number resolves INDETERMINATE without calling', async () => {
    for (const prNumber of [undefined, null, 0, -1, NaN, '12']) {
      const fetchPr = scriptedFetch([{ mergeable: true }]);
      const result = await resolveMergeability({
        eventName: 'pull_request', prNumber, fetchPr, sleep: recordingSleep(),
      });
      assert.equal(result.verdict, VERDICT.INDETERMINATE);
      assert.equal(fetchPr.calls.length, 0);
    }
  });

  test('successive resolutions do not share state', async () => {
    const first = scriptedFetch([{ mergeable: null }]);
    await resolveWith({ fetchPr: first, sleep: recordingSleep() });
    assert.equal(first.calls.length, MAX_ATTEMPTS);

    const second = scriptedFetch([{ mergeable: true }]);
    const result = await resolveWith({ fetchPr: second, sleep: recordingSleep() });
    assert.equal(result.verdict, VERDICT.MERGEABLE);
    assert.equal(second.calls.length, 1, 'the second run must start from a fresh budget');
  });
});

// ---------------------------------------------------------------------------
// D. main() — integration through the process seam against a real local API.
//
// The CLI's real fetch path is exercised by pointing GITHUB_API_URL at a
// throwaway localhost server, so no production test-mode branch exists and
// nothing reaches api.github.com.
// ---------------------------------------------------------------------------

const SENTINEL_TOKEN = 'ghs_sentinel_must_never_be_echoed_3833';

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
      PR_NUMBER: String(PR.number),
      GSD_PR_MERGEABILITY_BASE_DELAY_MS: '1',
      ...(outputPath ? { GITHUB_OUTPUT: outputPath } : {}),
      ...env,
    },
  });
}

// `runNode` (tests/helpers/process-seam.cjs) is spawnSync: it blocks this
// process's event loop for the whole child lifetime. `startApiStub` is an
// http.createServer living in THIS process, so while spawnSync blocks, the
// stub can never accept the child's connection — the child's fetch hangs on
// every attempt until its own AbortSignal.timeout fires, five attempts in a
// row, blowing past PROBE_TIMEOUT_MS. The observed symptom was exitCode:null
// with empty stdout/stderr (caught by the remote runner, not locally, since
// the deadlock's exact timing depends on scheduler contention). Any test that
// needs the stub must instead call main() in-process, which keeps this
// process's event loop live so the stub can actually answer.
/**
 * Invoke main() in-process with a controlled environment, capturing writes.
 * See the comment above for why this exists instead of routing through the
 * runNode/spawnSync seam whenever an in-process HTTP stub is involved.
 */
async function callMain(t, env, { outputPath } = {}) {
  const overrides = {
    GITHUB_REPOSITORY: 'open-gsd/gsd-core',
    GITHUB_TOKEN: SENTINEL_TOKEN,
    GITHUB_BASE_REF: 'next',
    PR_NUMBER: String(PR.number),
    GSD_PR_MERGEABILITY_BASE_DELAY_MS: '1',
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

// Split by what each case actually needs: stub-backed cases call main()
// in-process via callMain() (spawnSync would deadlock against the
// in-process HTTP stub — see the comment above callMain()); the remaining
// argv/exit-code-as-a-process cases stay on the runCli()/runNode seam since
// they assert real process argv parsing and exit-code plumbing.
describe('ci-pr-mergeability: CLI', () => {
  test('exits 0 and writes a skip verdict on a push event', (t) => {
    const dir = createTempDir('mergeability-skip-');
    t.after(() => cleanup(dir));
    const outputPath = path.join(dir, 'gh-output');

    const result = runCli({ GITHUB_EVENT_NAME: 'push' }, { outputPath });

    assert.equal(result.exitCode, 0, result.stderr);
    const outputs = readOutputs(outputPath);
    assert.equal(outputs.verdict, VERDICT.SKIPPED_NOT_A_PR);
    assert.equal(outputs.mergeable, 'true');
  });

  test('exits 1 and annotates the conflict', async (t) => {
    const dir = createTempDir('mergeability-conflict-');
    const api = await startApiStub(() => ({ status: 200, body: { mergeable: false, mergeable_state: 'dirty' } }));
    t.after(async () => { await api.close(); cleanup(dir); });
    const outputPath = path.join(dir, 'gh-output');

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url },
      { outputPath },
    );

    assert.equal(result.code, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const combined = `${result.stdout}${result.stderr}`;
    assert.ok(combined.includes('::error::'), 'must emit a workflow error annotation');
    assert.ok(combined.includes('next'), 'the annotation must name the base branch');
    assert.equal(readOutputs(outputPath).verdict, VERDICT.CONFLICTED);
  });

  test('exits 0 on a mergeable PR', async (t) => {
    const dir = createTempDir('mergeability-clean-');
    const api = await startApiStub(() => ({ status: 200, body: { mergeable: true, mergeable_state: 'clean' } }));
    t.after(async () => { await api.close(); cleanup(dir); });
    const outputPath = path.join(dir, 'gh-output');

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url },
      { outputPath },
    );

    assert.equal(result.code, 0, result.stderr);
    const outputs = readOutputs(outputPath);
    assert.equal(outputs.verdict, VERDICT.MERGEABLE);
    assert.equal(outputs.mergeable, 'true');
  });

  test('fails open with a warning when mergeability is unknown', async (t) => {
    const dir = createTempDir('mergeability-unknown-');
    const api = await startApiStub(() => ({ status: 200, body: { mergeable: null } }));
    t.after(async () => { await api.close(); cleanup(dir); });
    const outputPath = path.join(dir, 'gh-output');

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url },
      { outputPath },
    );

    assert.equal(result.code, 0, `an unknown mergeability must not block: ${result.stderr}`);
    const combined = `${result.stdout}${result.stderr}`;
    assert.ok(combined.includes('::warning::'), 'must warn');
    assert.ok(!combined.includes('::error::'), 'must not emit an error annotation');
    assert.equal(readOutputs(outputPath).verdict, VERDICT.INDETERMINATE);
    assert.equal(api.requestCount, MAX_ATTEMPTS, 'must exhaust exactly the budget');
  });

  test('fails open when the API rejects the read', async (t) => {
    const dir = createTempDir('mergeability-403-');
    const api = await startApiStub(() => ({ status: 403, body: { message: 'Resource not accessible' } }));
    t.after(async () => { await api.close(); cleanup(dir); });
    const outputPath = path.join(dir, 'gh-output');

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url },
      { outputPath },
    );

    assert.equal(result.code, 0, 'an unreadable PR is not an unmergeable PR');
    assert.equal(readOutputs(outputPath).verdict, VERDICT.INDETERMINATE);
  });

  test('fails open when the API body is not a JSON object', async (t) => {
    const dir = createTempDir('mergeability-badjson-');
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
    const dir = createTempDir('mergeability-nooutput-');
    t.after(() => cleanup(dir));

    const result = runCli({ GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: '' });

    assert.equal(result.exitCode, 0, result.stderr);
  });

  test('an unwritable GITHUB_OUTPUT does not change the exit code', async (t) => {
    // A failure while REPORTING the verdict must never invert the gate.
    // Injected by pointing at a path whose parent does not exist — no mode-bit
    // tricks, which root Docker/CI silently bypasses.
    const dir = createTempDir('mergeability-badout-');
    const api = await startApiStub(() => ({ status: 200, body: { mergeable: false } }));
    t.after(async () => { await api.close(); cleanup(dir); });
    const outputPath = path.join(dir, 'no-such-dir', 'gh-output');

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url },
      { outputPath },
    );

    assert.equal(result.code, 1, 'a conflict must still exit 1 when the output write fails');
  });

  test('never echoes the token', async (t) => {
    const dir = createTempDir('mergeability-token-');
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
    const dir = createTempDir('mergeability-nostack-');
    const api = await startApiStub(() => ({ status: 200, body: { mergeable: false } }));
    t.after(async () => { await api.close(); cleanup(dir); });

    const result = await callMain(
      t,
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_API_URL: api.url },
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

// ---------------------------------------------------------------------------
// E. Workflow wiring — structural assertions on the parsed YAML object graph.
//
// CONTRIBUTING.md:842 bans raw-text matching on test outputs regardless of
// whether the text came from a source file — broader than local/no-source-grep's
// .cjs/.js/.ts scope. Every assertion below reads the parsed object graph
// (yaml.load), not the raw file text, EXCEPT the single absence check further
// down ('security and policy lanes are never gated on mergeability'): a
// structural read cannot see a comment or an unreachable key, so that one
// test deliberately keeps a raw scan, justified inline at its call site.
// ---------------------------------------------------------------------------

/** workflow file -> job ids that must be gated on the preflight. */
const GATED = Object.freeze({
  'test.yml': ['lint-tests', 'test', 'test-inert', 'test-full', 'coverage-gate', 'qa-loop-walk', 'required-tests'],
  'install-smoke.yml': ['smoke', 'smoke-unpacked'],
  'mutation.yml': ['detect', 'mutation-gate'],
  'security-scan.yml': ['security'],
  'docs-required.yml': ['docs-lint'],
  'changeset-required.yml': ['changeset-lint'],
  'default-flip-documentation.yml': ['default-flip-documentation'],
  'branch-naming.yml': ['check-branch'],
});

/** Lanes that must keep running on a conflicted PR — security and policy. */
const NEVER_GATED = Object.freeze([
  'auto-close-unsolicited-prs.yml',
  'close-draft-prs.yml',
  'pr-target-validator.yml',
  'pr-title-validator.yml',
  'pr-template-format.yml',
  'require-issue-link.yml',
  'dismiss-unauthorized-pr-approvals.yml',
]);

function loadWorkflow(name) {
  return yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'));
}

function rawWorkflow(name) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8');
}

function needsOf(job) {
  const needs = job && job.needs;
  if (!needs) return [];
  return Array.isArray(needs) ? needs : [needs];
}

function preflightJobIds(doc) {
  return Object.entries(doc.jobs || {})
    .filter(([, job]) => job && job.uses === PREFLIGHT_USES)
    .map(([id]) => id);
}

describe('ci-pr-mergeability: workflow wiring', () => {
  test('the preflight workflow exists and is call-only', () => {
    const doc = loadWorkflow(PREFLIGHT_WORKFLOW);
    // `on: workflow_call` parses to the key `true` under YAML 1.1 unless quoted;
    // accept either shape rather than pinning the parser's quirk.
    const triggers = doc.on || doc[true];
    assert.deepEqual(Object.keys(triggers), ['workflow_call']);
    assert.equal(doc.concurrency, undefined, 'a matching concurrency group would cancel the caller');
  });

  function findCheckoutStep() {
    const doc = loadWorkflow(PREFLIGHT_WORKFLOW);
    const job = doc.jobs.mergeability;
    const step = (job.steps || []).find(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'),
    );
    assert.ok(step, 'the mergeability job must have an actions/checkout step');
    return step;
  }

  test('the preflight checks out the base sha, never the merge ref', () => {
    const step = findCheckoutStep();
    const ref = step.with && step.with.ref;
    assert.equal(typeof ref, 'string');
    // For a CONFLICTED PR refs/pull/N/merge is stale or absent, so a default
    // checkout fails on exactly the PRs this job exists to diagnose; pinning
    // the base sha also means no PR-supplied code is fetched or executed.
    assert.ok(
      ref.includes('github.event.pull_request.base.sha'),
      'the checkout must pin ref: to pull_request.base.sha',
    );
  });

  test('the preflight checkout is shallow, sparse, and credential-free', () => {
    const step = findCheckoutStep();
    const { with: withArgs } = step;
    assert.equal(withArgs['fetch-depth'], 1, 'fetch-depth must be the number 1');
    // The point is it checks out only what it runs.
    assert.equal(typeof withArgs['sparse-checkout'], 'string');
    assert.equal(withArgs['sparse-checkout'].trim(), 'scripts');
    assert.equal(withArgs['persist-credentials'], false, 'must not persist credentials');
  });

  test('the preflight fails open when the script is absent at the base sha', () => {
    // The checkout above pins ref: to pull_request.base.sha, so `node
    // scripts/ci-pr-mergeability.cjs` runs the copy that exists on the BASE
    // branch, not on the PR. On the very PR that introduces this script, the
    // base has no such file; the same is true for any PR whose base predates
    // it. An absent script is not evidence of a conflict — it is undetermined
    // — so the run step must take the same fail-open path as an unknown
    // `mergeable`, not fail the job. That arm only ever fires while the base
    // lacks the script, so once the fix lands on the base it goes silent and
    // looks, to a future reader, like dead code safe to delete. This test
    // exists to keep it from being deleted.
    const doc = loadWorkflow(PREFLIGHT_WORKFLOW);
    const step = (doc.jobs.mergeability.steps || []).find((s) => s.id === 'check');
    assert.ok(step, 'the mergeability job must have a step with id: check');
    const { run } = step;
    assert.equal(typeof run, 'string', 'the check step must have a run: script');

    assert.match(
      run,
      /if\s+\[\s+!\s+-f\s+scripts\/ci-pr-mergeability\.cjs\s+\]/,
      'the script must guard on the absence of scripts/ci-pr-mergeability.cjs before invoking it',
    );
    assert.ok(
      run.includes('::warning::'),
      'an absent script at the base sha must warn, not error',
    );
    assert.ok(
      !run.includes('::error::'),
      'an absent script at the base sha must not emit an error annotation',
    );
    assert.ok(
      run.includes('verdict=INDETERMINATE'),
      'the bootstrap arm must report verdict=INDETERMINATE, the same as any other unresolved read',
    );
    assert.ok(
      run.includes('mergeable=true'),
      'the bootstrap arm must fail open with mergeable=true so downstream gates are not blocked',
    );
    assert.ok(
      run.includes('exit 0'),
      'the bootstrap arm must exit 0 so the job itself does not go red on a missing script',
    );
    assert.ok(
      run.includes('node scripts/ci-pr-mergeability.cjs'),
      'the normal path must still invoke the real script once it exists at the base sha',
    );
    assert.ok(
      !run.includes('${{'),
      'CONTRIBUTING.md: run: blocks must not interpolate a GitHub expression',
    );
  });

  for (const [name, jobIds] of Object.entries(GATED)) {
    test(`${name} calls the preflight`, () => {
      const ids = preflightJobIds(loadWorkflow(name));
      assert.equal(ids.length, 1, `${name} must have exactly one preflight caller job, found ${ids.length}`);
    });

    test(`${name}: every gated compute job needs the preflight`, () => {
      const doc = loadWorkflow(name);
      const [callerId] = preflightJobIds(doc);
      for (const jobId of jobIds) {
        const job = (doc.jobs || {})[jobId];
        assert.ok(job, `${name}: job "${jobId}" not found — the gate list has drifted from the workflow`);
        assert.ok(
          needsOf(job).includes(callerId),
          `${name}: job "${jobId}" must declare needs: ${callerId}`,
        );
      }
    });

    test(`${name}: the preflight caller grants the scopes the preflight needs`, () => {
      // A calling job's `permissions` REPLACES the workflow default; it does
      // not merge. branch-naming.yml's workflow default is `{}`, so an implicit
      // inherit would starve the API read.
      const doc = loadWorkflow(name);
      const [callerId] = preflightJobIds(doc);
      const permissions = (doc.jobs || {})[callerId].permissions;
      assert.equal(permissions && permissions['contents'], 'read', `${name}: caller needs contents: read`);
      assert.equal(permissions && permissions['pull-requests'], 'read', `${name}: caller needs pull-requests: read`);
    });
  }

  test('release.yml grants install-smoke the scopes its nested preflight requests', () => {
    // release.yml -> install-smoke.yml -> pr-mergeable-preflight.yml is a
    // nested reusable-workflow chain. A nested job may only DOWNGRADE the
    // caller's permissions, so a request the caller never granted fails the
    // whole release run before a single step executes.
    const doc = loadWorkflow('release.yml');
    const callers = Object.entries(doc.jobs || {})
      .filter(([, job]) => job && job.uses === './.github/workflows/install-smoke.yml');
    assert.ok(callers.length >= 2, 'expected release.yml to call install-smoke.yml');
    for (const [id, job] of callers) {
      assert.equal(job.permissions && job.permissions['pull-requests'], 'read',
        `release.yml job "${id}" must grant pull-requests: read for the nested preflight`);
    }
  });

  test('security and policy lanes are never gated on mergeability', () => {
    // Deliberate raw scan, not a structural read: this asserts ABSENCE
    // anywhere in the file, and the parsed object graph cannot see a
    // commented-out or otherwise unreachable reference — exactly what this
    // test must still catch.
    for (const name of NEVER_GATED) {
      const raw = rawWorkflow(name);
      assert.ok(
        !raw.includes(PREFLIGHT_WORKFLOW),
        `${name} must keep running on a conflicted PR — a gated auto-close lets a drive-by PR evade it`,
      );
    }
  });

  test('no run block added by this change interpolates a GitHub expression', () => {
    // CONTRIBUTING.md, final line: no ${{ }} in `run:` blocks — bind via env:.
    for (const name of [PREFLIGHT_WORKFLOW, 'mutation.yml']) {
      const doc = loadWorkflow(name);
      for (const [jobId, job] of Object.entries(doc.jobs || {})) {
        for (const step of (job.steps || [])) {
          if (typeof step.run !== 'string') continue;
          assert.ok(
            !step.run.includes('${{'),
            `${name}: jobs.${jobId} has a run block interpolating an expression; bind it via env:`,
          );
        }
      }
    }
  });

  test('required-tests reports red rather than absent when the preflight fails', () => {
    const doc = loadWorkflow('test.yml');
    const job = doc.jobs['required-tests'];
    assert.equal(job.if, 'always()', 'required-tests must still evaluate when upstream jobs skip');
    const script = (job.steps || []).map((s) => s.run || '').join('\n');
    assert.ok(
      /PREFLIGHT_RESULT/.test(script),
      'required-tests must have an explicit preflight arm so the required context goes red, not absent',
    );
  });

  test('a gated job whose if() overrides the implicit success() must check the preflight result itself', () => {
    // GitHub Actions applies an implicit success() to a job-level `if:` unless
    // that `if:` already contains a status-check function: "By default, GitHub
    // Actions applies a success() check to steps unless another status function
    // is specified" and "you must explicitly include failure() to override the
    // default success() check that is otherwise applied automatically."
    //
    // So for a job with a plain `if:` (no status function), `needs: preflight`
    // alone correctly skips it when the preflight fails — nothing extra is
    // required. But the moment a job's `if:` contains always(), failure(), or
    // cancelled(), that implicit success() is gone and `needs:` stops gating
    // it. Such a job runs even on a conflicted PR and must therefore check the
    // preflight result itself.
    //
    // Today exactly two gated jobs are in that category and both already
    // handle it: test.yml's required-tests (if: always(), with a
    // PREFLIGHT_RESULT arm) and mutation.yml's mutation-gate (if: always() &&
    // ..., with a PREFLIGHT arm). This test exists to catch a FUTURE edit that
    // adds always() to, say, `test` or `coverage-gate` — which would silently
    // make the whole gate inert on the most expensive lanes while every
    // existing assertion kept passing.
    const STATUS_FUNCTION = /always\(\)|failure\(\)|cancelled\(\)/;
    const violations = [];
    let inspected = 0;
    for (const [name, jobIds] of Object.entries(GATED)) {
      const doc = loadWorkflow(name);
      for (const jobId of jobIds) {
        const job = (doc.jobs || {})[jobId];
        const condition = typeof job.if === 'string' ? job.if : '';
        if (!STATUS_FUNCTION.test(condition)) continue;
        inspected++;
        const checksPreflightInIf = /needs\.preflight\.result/.test(condition);
        const stepsText = JSON.stringify(job.steps || []);
        const checksPreflightInSteps = /PREFLIGHT/.test(stepsText);
        if (!checksPreflightInIf && !checksPreflightInSteps) {
          violations.push(`${name}:${jobId} (if: ${condition})`);
        }
      }
    }
    assert.ok(
      inspected > 0,
      'expected at least one gated job with a status-function if(); a vacuous pass here means the invariant is no longer being checked',
    );
    assert.deepEqual(
      violations,
      [],
      `these jobs override the implicit success() with a status function in if:, so \`needs: preflight\` no longer gates them — each must test needs.preflight.result (or read PREFLIGHT_RESULT in a step) itself: ${violations.join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// F. ci-test-scope ripple — the preflight workflow must never be marked inert.
// ---------------------------------------------------------------------------

describe('ci-pr-mergeability: ci-test-scope protection', () => {
  const scope = require('../scripts/ci-test-scope.cjs');

  test('the preflight workflow is protected from being marked inert', () => {
    assert.ok(
      scope.PROTECTED_WORKFLOWS.has(PREFLIGHT_WORKFLOW),
      'a workflow that gates every compute lane must never be demoted to the inert lane',
    );
  });

  test('every protected workflow name refers to a real file', () => {
    // Parity assertion: the literal name list and the real filenames are two
    // surfaces over one fact. Without this, a rename silently un-protects a
    // gating workflow and CI stays green.
    const missing = [...scope.PROTECTED_WORKFLOWS]
      .filter((name) => !fs.existsSync(path.join(WORKFLOWS_DIR, name)))
      .sort();
    assert.deepEqual(missing, [], `PROTECTED_WORKFLOWS names files that do not exist: ${missing.join(', ')}`);
  });
});

/**
 * #2605 — the local OpenAI-compatible lanes (ollama / lm_studio / llama.cpp) dropped silently.
 *
 * The original defects, all of which made a failed lane indistinguishable from a clean empty
 * review: bare `curl -s` suppressed curl's own error text; the response was piped straight into
 * `jq` so the BODY — where an OpenAI-compatible server puts its error JSON on an HTTP 4xx/5xx while
 * curl still exits 0 — was discarded unread; nothing was written when content was empty, so the
 * file never existed and `write_reviews` omitted the section entirely; and a whitespace-only reply
 * passed the byte-counting `[ ! -s … ]` guard as a successful review.
 *
 * Phase 5b (#2799) replaced the curl/jq pipeline with an in-process HTTP call and `JSON.parse`, so
 * this suite drives the runner instead of extracting and executing shell. Two of the original
 * defects are now structurally impossible rather than merely guarded: there is no pipe to discard
 * the body, and no `echo` to swallow a `-n`-shaped reply.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
const { runLane, runOpenAiCompatible } = require('../gsd-core/bin/lib/review-lane-runner.cjs');

const RUN = '/run';
const ROOT = '/repo';
const HTTP_LANES = REVIEWER_LANES.filter((l) => l.transport === 'openai-http');

function planFor(slug, config = {}) {
  const lane = REVIEWER_LANES.find((l) => l.slug === slug);
  const r = resolveLanePlan({ lane, configGet: (k) => config[k], runDir: RUN, repoRoot: ROOT });
  assert.equal(r.ok, true);
  return r.plan;
}

/**
 * These lanes declare an `http-reachable` probe, so the runner performs a GET on /v1/models BEFORE
 * the chat call. The stub must answer that separately — otherwise the lane is reported unreachable
 * and never reaches the invocation these tests are actually about.
 */
function reachableThen(chatResponse) {
  return async (url, opts) =>
    opts.method === 'GET'
      ? { ok: true, status: 200, body: JSON.stringify({ data: [{ id: 'stub-model' }] }) }
      : (typeof chatResponse === 'function' ? chatResponse(url, opts) : chatResponse);
}

function deps(httpJson, files = { [`${RUN}/gsd-review-prompt.md`]: 'PLAN' }) {
  const warnings = [];
  return {
    files,
    warnings,
    spawn: () => ({ status: 0, stdout: '', stderr: '' }),
    httpJson,
    readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files,
    hasBinary: () => true,
    configGet: () => undefined,
    homeDir: '/home/u',
    warn: (m) => warnings.push(m),
  };
}

const okBody = (content) => ({
  ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }),
});

describe('#2605 local OpenAI-compatible lanes produce diagnosable output', () => {
  for (const lane of HTTP_LANES) {
    test(`${lane.slug}: an unreachable endpoint produces a stub carrying the transport error`, async () => {
      const p = planFor(lane.slug);
      const d = deps(reachableThen({ ok: false, status: 0, body: '', error: 'ECONNREFUSED' }));
      const r = await runLane(p, d, { repoRoot: ROOT });
      assert.equal(r.stubbed, true);
      assert.ok(d.files[p.reviewPath].includes('ECONNREFUSED'),
        'the transport error must be visible — bare `curl -s` used to swallow it');
    });

    test(`${lane.slug}: an HTTP error body is preserved in the stub`, async () => {
      // The body is the ONLY evidence on a 4xx/5xx: such a server returns its error JSON there and
      // curl still exits 0, so stderr is empty. The old pipe into jq discarded it.
      const p = planFor(lane.slug);
      const d = deps(reachableThen({ ok: false, status: 404, body: '{"error":"model not found"}' }));
      await runLane(p, d, { repoRoot: ROOT });
      assert.ok(d.files[p.reviewPath].includes('Raw response body:'));
      assert.ok(d.files[p.reviewPath].includes('model not found'));
    });

    test(`${lane.slug}: an empty 200 response still produces a file`, async () => {
      // Previously nothing was written, so the file never existed, write_reviews omitted the
      // section, and the result was indistinguishable from the reviewer never being selected.
      const p = planFor(lane.slug);
      const d = deps(reachableThen(okBody('')));
      const r = await runLane(p, d, { repoRoot: ROOT });
      assert.equal(r.stubbed, true);
      assert.ok(d.files[p.reviewPath] !== undefined, 'a file must exist even on an empty reply');
      assert.ok(d.files[p.reviewPath].includes('failed or returned empty output'));
    });

    test(`${lane.slug}: a whitespace-only response is empty, not a successful review`, async () => {
      // `[ ! -s … ]` counted BYTES, so "   " passed as a real review.
      const p = planFor(lane.slug);
      const d = deps(reachableThen(okBody('   \n\t ')));
      const r = await runLane(p, d, { repoRoot: ROOT });
      assert.equal(r.stubbed, true);
    });

    test(`${lane.slug}: a reply that is exactly an echo option is NOT misclassified`, async () => {
      // `echo "$VAR"` would write 0 bytes for `-n`/`-e`/`-E`. Nothing here goes through echo, so
      // this is structurally impossible now — locked anyway.
      const p = planFor(lane.slug);
      const d = deps(reachableThen(okBody('-n')));
      const r = await runLane(p, d, { repoRoot: ROOT });
      assert.equal(r.stubbed, false);
      assert.ok(d.files[p.reviewPath].includes('-n'));
      assert.ok(!d.files[p.reviewPath].includes('failed or returned empty output'));
    });

    test(`${lane.slug}: a successful review passes through untouched`, async () => {
      const p = planFor(lane.slug);
      const d = deps(reachableThen(okBody('## Findings\nreal review')));
      const r = await runLane(p, d, { repoRoot: ROOT });
      assert.equal(r.stubbed, false);
      assert.ok(d.files[p.reviewPath].includes('## Findings'));
      assert.ok(!d.files[p.reviewPath].includes('failed or returned empty output'));
    });
  }

  test('a served-model mismatch is warned about, not silently accepted', async () => {
    const p = planFor('lm_studio', { 'review.models.lm_studio': 'asked-for' });
    const d = deps(async () => ({
      ok: true, status: 200,
      body: JSON.stringify({ model: 'actually-served', choices: [{ message: { content: 'R' } }] }),
    }));
    const out = await runOpenAiCompatible(p, 'PLAN', d);
    assert.equal(out.review, 'R');
    assert.ok(d.warnings.some((w) => w.includes('actually-served') && w.includes('asked-for')));
  });

  test('neither jq nor curl is required by any of these lanes', () => {
    // The dependency is gone, not merely satisfied: parsing is JSON.parse and the request is
    // in-process. `jq` is absent on stock Windows/Git-Bash (#2589), which gated these lanes.
    for (const lane of HTTP_LANES) {
      assert.deepStrictEqual([...lane.requiresBinaries], [], `${lane.slug} still declares a binary`);
    }
  });
});

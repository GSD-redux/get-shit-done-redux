/**
 * Reviewer lane runner — execution, probes, handlers, egress (ADR-2782 Phase 5b, #2799).
 *
 * Every dependency is injected, so these are behavioural tests over the real control flow with no
 * network, no spawn and no clock. Where a filesystem failure is forced it is done by making the
 * injected `writeFile`/`readFile` throw — never by `chmod 0o000`, which root bypasses, silently
 * turning the test into a vacuous pass in root Docker/CI.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { resolveLanePlan, LANE_UNAVAILABLE } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
const {
  checkEgressHost,
  probeLane,
  runLane,
  writeReviewOrStub,
  handleOpencodeOutput,
  stampBlindReview,
  antigravityTranscriptFallback,
  runOpenAiCompatible,
} = require('../gsd-core/bin/lib/review-lane-runner.cjs');

const RUN = '/run';
const ROOT = '/repo';

function plan(slug, config = {}) {
  const lane = REVIEWER_LANES.find((l) => l.slug === slug);
  const r = resolveLanePlan({ lane, configGet: (k) => config[k], runDir: RUN, repoRoot: ROOT });
  assert.equal(r.ok, true, `${slug} failed to resolve`);
  return r.plan;
}

/** An in-memory dependency set. Overrides replace individual seams per test. */
function deps(overrides = {}) {
  const files = overrides.files || {};
  const warnings = [];
  const spawns = [];
  const base = {
    files,
    warnings,
    spawns,
    spawn: (binary, argv, opts) => {
      spawns.push({ binary, argv, opts });
      return { status: 0, stdout: '', stderr: '' };
    },
    httpJson: async () => ({ ok: true, status: 200, body: '{}' }),
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files,
    hasBinary: () => true,
    configGet: () => undefined,
    homeDir: '/home/u',
    warn: (m) => warnings.push(m),
  };
  return Object.assign(base, overrides);
}

describe('runner — egress host re-verification (ADR-2782 D5 rules 2-4)', () => {
  test('no consent record ALLOWS — first-party lanes are never consent-gated', () => {
    // Blocking on absence would break every existing local-model user on upgrade: ollama,
    // lm_studio and llama_cpp ship inside the SHA-pinned distribution and have no consent record.
    assert.equal(checkEgressHost(undefined, 'http://localhost:11434').allowed, true);
    assert.equal(checkEgressHost(null, 'http://localhost:11434').allowed, true);
  });

  test('a record predating the field ALLOWS — absence must not force re-consent', () => {
    // D4 rule 5: an absent field must not perturb consent, or every installed capability
    // re-prompts on upgrade.
    assert.equal(checkEgressHost('', 'http://localhost:8080').allowed, true);
  });

  test('a matching destination proceeds', () => {
    const r = checkEgressHost('http://localhost:8080', 'http://localhost:8080');
    assert.equal(r.allowed, true);
  });

  test('a changed destination BLOCKS and names both hosts', () => {
    const r = checkEgressHost('http://localhost:8080', 'http://evil.example');
    assert.equal(r.allowed, false);
    assert.equal(r.consentedHost, 'http://localhost:8080');
    assert.equal(r.currentHost, 'http://evil.example');
  });

  test('cosmetic host edits are not a change', () => {
    for (const [a, b] of [
      ['http://localhost:8080', 'http://localhost:8080/'],
      ['http://a.com:80', 'http://a.com'],
      ['http://A.com', 'http://a.com'],
    ]) {
      assert.equal(checkEgressHost(a, b).allowed, true, `${a} vs ${b}`);
    }
  });

  test('a non-string consented value is treated as absent, never coerced', () => {
    for (const v of [42, {}, [], true]) {
      assert.equal(checkEgressHost(v, 'http://a.com').allowed, true);
    }
  });

  test('a blocked lane never reaches the network and writes no review', async () => {
    const p = plan('ollama');
    const d = deps();
    const r = await runLane(p, d, { consentedHost: 'http://elsewhere.example', repoRoot: ROOT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, LANE_UNAVAILABLE.EGRESS_HOST_CHANGED);
    assert.equal(d.files[p.reviewPath], undefined, 'a blocked lane must not write a review');
    assert.ok(d.warnings.some((w) => w.includes('elsewhere.example')));
  });

  test('a spawn lane skips the host check entirely', async () => {
    const p = plan('qwen');
    const d = deps({ spawn: () => ({ status: 0, stdout: 'review', stderr: '' }) });
    // A stale host on a spawn lane must be inert, not a block.
    const r = await runLane(p, d, { consentedHost: 'http://stale.example', repoRoot: ROOT });
    assert.equal(r.ok, true);
  });
});

describe('runner — probe (ADR-2782 D7)', () => {
  test('command-exists both ways', async () => {
    const p = plan('gemini');
    assert.equal((await probeLane(p, deps({ hasBinary: () => true }))).available, true);
    const miss = await probeLane(p, deps({ hasBinary: () => false }));
    assert.equal(miss.available, false);
    assert.equal(miss.reason, LANE_UNAVAILABLE.MISSING_BINARY);
  });

  test('command-capability accepts the right tool and REJECTS the wrong one', async () => {
    // This is the entire reason D7 ships wider than existence: `kimi` is claimed by both Kimi Code
    // CLI and the legacy Python kimi-cli, and an existence-only probe registers the wrong tool.
    const p = plan('kimi-code');
    const real = await probeLane(p, deps({
      spawn: () => ({ status: 0, stdout: 'usage: kimi --output-format json -p', stderr: '' }),
    }));
    assert.equal(real.available, true);

    const legacy = await probeLane(p, deps({
      spawn: () => ({ status: 0, stdout: 'usage: kimi --print --work-dir DIR', stderr: '' }),
    }));
    assert.equal(legacy.available, false);
    assert.equal(legacy.reason, LANE_UNAVAILABLE.PROBE_FAILED);
  });

  test('a capability probe that times out reports unavailable, never hangs', async () => {
    // The original probe (closed PR #2776) was an unbounded `kimi --help | grep` that ran on EVERY
    // review regardless of flags — a live instance of the named Unbounded Subprocesses defect.
    const p = plan('kimi-code');
    const r = await probeLane(p, deps({
      spawn: () => ({ status: null, stdout: '', stderr: '', errorCode: 'ETIMEDOUT' }),
    }));
    assert.equal(r.available, false);
    assert.equal(r.reason, LANE_UNAVAILABLE.PROBE_TIMEOUT);
  });

  test('the capability probe passes the declared bound to the spawn', async () => {
    const p = plan('kimi-code');
    const d = deps({ spawn: (b, a, o) => { d.spawns.push({ b, a, o }); return { status: 0, stdout: '--output-format', stderr: '' }; } });
    await probeLane(p, d);
    const call = d.spawns[d.spawns.length - 1];
    assert.equal(typeof call.o.timeoutMs, 'number');
    assert.ok(call.o.timeoutMs > 0, 'every probe that starts a process MUST be bounded');
  });

  test('a missing required binary is named rather than left to fail obscurely', async () => {
    const p = { ...plan('gemini'), requiresBinaries: ['jq'] };
    const r = await probeLane(p, deps({ hasBinary: (n) => n !== 'jq' }));
    assert.equal(r.available, false);
    assert.equal(r.reason, LANE_UNAVAILABLE.MISSING_REQUIRED_BINARY);
  });

  test('no shipped lane still requires jq or curl', () => {
    // Phase 5b moved parsing to JSON.parse and HTTP to fetch. Leaving a stale requiresBinaries
    // entry would report lanes unavailable on stock Windows for a dependency they no longer use.
    for (const lane of REVIEWER_LANES) {
      for (const bin of lane.requiresBinaries) {
        assert.ok(bin !== 'jq' && bin !== 'curl', `${lane.slug} still declares ${bin}`);
      }
    }
  });

  test('http-reachable reports unreachable rather than throwing', async () => {
    const p = plan('ollama');
    const r = await probeLane(p, deps({ httpJson: async () => ({ ok: false, status: 0, body: '', error: 'ECONNREFUSED' }) }));
    assert.equal(r.available, false);
    assert.equal(r.reason, LANE_UNAVAILABLE.HOST_UNREACHABLE);
  });
});

describe('runner — empty-output policy (#2494 / #2605 / #2794)', () => {
  test('a real review is written verbatim', () => {
    const p = plan('gemini');
    const d = deps();
    const r = writeReviewOrStub(p, '## Findings\nreal', d);
    assert.equal(r.stubbed, false);
    assert.ok(d.files[p.reviewPath].startsWith('## Findings'));
  });

  test('empty output writes a stub carrying the captured stderr', () => {
    const p = plan('gemini');
    const d = deps({ files: { [`${RUN}/gsd-review-gemini.err`]: 'auth failed' } });
    const r = writeReviewOrStub(p, '', d);
    assert.equal(r.stubbed, true);
    assert.ok(d.files[p.reviewPath].includes('failed or returned empty output'));
    assert.ok(d.files[p.reviewPath].includes('auth failed'));
  });

  test('whitespace-only output is stubbed on every lane', () => {
    // Before this, `[ ! -s file ]` counted bytes so "   " rendered as a clean review on five lanes.
    for (const slug of ['gemini', 'claude', 'codex', 'qwen', 'cursor']) {
      const p = plan(slug);
      const d = deps();
      assert.equal(writeReviewOrStub(p, '   \n', d).stubbed, true, `${slug} accepted whitespace`);
    }
  });

  test('the stub is distinguishable from a real review', () => {
    // The ambiguity between "failed" and "ran cleanly with nothing to report" IS the defect.
    const p = plan('gemini');
    const d = deps();
    writeReviewOrStub(p, '', d);
    assert.ok(/failed or returned empty output/.test(d.files[p.reviewPath]));
  });

  test('an http lane appends the raw response body', () => {
    // An OpenAI-compatible server reports errors with a 4xx/5xx and the JSON in the BODY, so
    // stderr alone is empty and the body is the only evidence. The bash piped it into jq and lost it.
    const p = plan('ollama');
    const d = deps();
    writeReviewOrStub(p, '', d, '{"error":{"message":"model not found"}}');
    assert.ok(d.files[p.reviewPath].includes('Raw response body:'));
    assert.ok(d.files[p.reviewPath].includes('model not found'));
  });

  test('a filesystem write failure degrades rather than crashing the run', () => {
    // Injected by making the seam throw — never chmod 0o000, which root bypasses.
    const p = plan('gemini');
    const d = deps({ writeFile: () => { throw new Error('EROFS'); } });
    assert.throws(() => writeReviewOrStub(p, 'x', d), /EROFS/);
  });
});

describe('runner — opencode handler (#1936)', () => {
  test('the review is rebuilt from assistant text parts', () => {
    const stream = [
      JSON.stringify({ type: 'text', part: { text: 'first' } }),
      JSON.stringify({ type: 'text', part: { text: 'second' } }),
    ].join('\n');
    assert.equal(handleOpencodeOutput(stream).review, 'first\nsecond');
  });

  test('a malformed line is skipped, not fatal to the whole review', () => {
    // Losing an entire review to one bad line would be strictly worse than the bug this fixes.
    const stream = [
      JSON.stringify({ type: 'text', part: { text: 'kept' } }),
      'NOT JSON AT ALL',
      '{"truncated":',
      JSON.stringify({ type: 'text', part: { text: 'also kept' } }),
    ].join('\n');
    assert.equal(handleOpencodeOutput(stream).review, 'kept\nalso kept');
  });

  test('a zero-output turn surfaces the stop reason and token count', () => {
    const stream = JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: { output: 0 } } });
    const r = handleOpencodeOutput(stream);
    assert.equal(r.review, '');
    assert.ok(r.diagnostic.includes('stop'));
    assert.ok(r.diagnostic.includes('0'));
  });

  test('the raw JSON envelope never becomes the review', async () => {
    // The regression this locks: a plain stdout copy would write the JSON stream into REVIEWS.md.
    const p = plan('opencode');
    const stream = JSON.stringify({ type: 'text', part: { text: 'THE REVIEW' } });
    const d = deps({ spawn: () => ({ status: 0, stdout: stream, stderr: '' }) });
    await runLane(p, d, { repoRoot: ROOT });
    assert.equal(d.files[p.reviewPath].trim(), 'THE REVIEW');
    assert.ok(!d.files[p.reviewPath].includes('"type"'));
  });

  test('CRLF in the stream is handled', () => {
    const stream = [
      JSON.stringify({ type: 'text', part: { text: 'a' } }),
      JSON.stringify({ type: 'text', part: { text: 'b' } }),
    ].join('\r\n');
    assert.equal(handleOpencodeOutput(stream).review, 'a\nb');
  });
});

describe('runner — antigravity handler (#2073 / #2176)', () => {
  const CACHE = '/home/u/.gemini/antigravity-cli/cache/last_conversations.json';
  const TX = (id) => `/home/u/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`;
  const entry = (content) =>
    JSON.stringify({ source: 'MODEL', status: 'DONE', type: 'PLANNER_RESPONSE', content });

  test('the watermark prevents a PRIOR run’s response leaking in as this one', () => {
    // Without it the fallback reads the last PLANNER_RESPONSE regardless of when it was written,
    // silently presenting a stale review as the current one.
    const files = {
      [CACHE]: JSON.stringify({ [ROOT]: 'c1' }),
      [TX('c1')]: [entry('STALE FROM LAST RUN')].join('\n'),
    };
    const d = deps({ files });
    const got = antigravityTranscriptFallback(ROOT, { convId: 'c1', lines: 1 }, d);
    assert.equal(got, '', 'nothing was appended after the watermark, so nothing may be returned');
  });

  test('a response appended after the watermark IS returned', () => {
    const files = {
      [CACHE]: JSON.stringify({ [ROOT]: 'c1' }),
      [TX('c1')]: [entry('old'), entry('THIS RUN')].join('\n'),
    };
    const d = deps({ files });
    assert.equal(antigravityTranscriptFallback(ROOT, { convId: 'c1', lines: 1 }, d), 'THIS RUN');
  });

  test('a new conversation id means every line is new (skip 0)', () => {
    const files = {
      [CACHE]: JSON.stringify({ [ROOT]: 'c2' }),
      [TX('c2')]: [entry('FRESH SESSION')].join('\n'),
    };
    const d = deps({ files });
    assert.equal(antigravityTranscriptFallback(ROOT, { convId: 'c1', lines: 9 }, d), 'FRESH SESSION');
  });

  test('workspace lookup is case-insensitive', () => {
    const files = {
      [CACHE]: JSON.stringify({ '/REPO': 'c1' }),
      [TX('c1')]: [entry('found')].join('\n'),
    };
    assert.equal(antigravityTranscriptFallback('/repo', { convId: '', lines: 0 }, deps({ files })), 'found');
  });

  test('a missing cache or transcript degrades to empty, never throws', () => {
    assert.equal(antigravityTranscriptFallback(ROOT, { convId: '', lines: 0 }, deps()), '');
    const d = deps({ files: { [CACHE]: 'NOT JSON' } });
    assert.equal(antigravityTranscriptFallback(ROOT, { convId: '', lines: 0 }, d), '');
  });

  test('the blind-review marker is anchored to the head of the output', () => {
    assert.ok(stampBlindReview('REVIEWED-WITHOUT-REPO-ACCESS\nbody').startsWith('> [reviewed-without-repo-access]'));
  });

  test('a review that merely QUOTES the marker further down is NOT stamped', () => {
    // A grounded review of this very file would otherwise be mis-stamped and down-weighted.
    const quoting = ['1', '2', '3', '4', '5', '6', 'we look for REVIEWED-WITHOUT-REPO-ACCESS here'].join('\n');
    assert.ok(!stampBlindReview(quoting).startsWith('>'));
  });

  test('the scratch-dir tell requires a workspace DECLARATION, not a mention', () => {
    const declared = 'my working directory is /home/u/.gemini/antigravity-cli/scratch so I could not read';
    assert.ok(stampBlindReview(declared).startsWith('>'));
    const mention = 'the path .gemini/antigravity-cli/scratch appears in the plan under review';
    assert.ok(!stampBlindReview(mention).startsWith('>'));
  });

  test('a non-zero exit discards partial output so the fallback can take over', async () => {
    // The spawn APPENDS to the transcript, as the real `agy` does. That ordering is the whole
    // point of the watermark: only what this run wrote may be read back. A test that pre-seeds the
    // response instead would be asserting that a STALE entry leaks through — the exact bug the
    // watermark exists to prevent — so it must be written this way round.
    const p = plan('antigravity');
    const files = {
      [CACHE]: JSON.stringify({ [ROOT]: 'c1' }),
      [TX('c1')]: [entry('from a PREVIOUS run')].join('\n'),
    };
    const d = deps({
      files,
      spawn: () => {
        files[TX('c1')] = [entry('from a PREVIOUS run'), entry('FROM TRANSCRIPT')].join('\n');
        return { status: 124, stdout: 'partial garbage', stderr: '' };
      },
    });
    await runLane(p, d, { repoRoot: ROOT });
    assert.ok(d.files[p.reviewPath].includes('FROM TRANSCRIPT'));
    assert.ok(!d.files[p.reviewPath].includes('partial garbage'), 'rc!=0 must discard stdout');
    assert.ok(!d.files[p.reviewPath].includes('PREVIOUS'), 'the pre-run entry must stay invisible');
  });
});

describe('runner — openai-compatible handler', () => {
  test('the configured model is used and discovery is skipped', async () => {
    const p = plan('ollama', { 'review.models.ollama': 'pinned' });
    let posted = null;
    const d = deps({
      httpJson: async (url, o) => {
        if (o.method === 'POST') { posted = JSON.parse(o.body); return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: 'R' } }] }) }; }
        return { ok: true, status: 200, body: JSON.stringify({ data: [{ id: 'discovered' }] }) };
      },
    });
    const r = await runOpenAiCompatible(p, 'PROMPT', d);
    assert.equal(posted.model, 'pinned');
    assert.equal(r.review, 'R');
  });

  test('an unset model discovers the first from /v1/models', async () => {
    const p = plan('ollama');
    let posted = null;
    const d = deps({
      httpJson: async (url, o) => {
        if (o.method === 'POST') { posted = JSON.parse(o.body); return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: 'R' } }] }) }; }
        return { ok: true, status: 200, body: JSON.stringify({ data: [{ id: 'discovered' }] }) };
      },
    });
    await runOpenAiCompatible(p, 'P', d);
    assert.equal(posted.model, 'discovered');
  });

  test('discovery failure falls back to the declared fallbackModel', async () => {
    const p = plan('ollama');
    let posted = null;
    const d = deps({
      httpJson: async (url, o) => {
        if (o.method === 'POST') { posted = JSON.parse(o.body); return { ok: true, status: 200, body: '{}' }; }
        return { ok: false, status: 0, body: '', error: 'refused' };
      },
    });
    await runOpenAiCompatible(p, 'P', d);
    assert.equal(posted.model, 'llama3');
  });

  test('a served-model mismatch warns without failing the review', async () => {
    const p = plan('lm_studio', { 'review.models.lm_studio': 'asked' });
    const d = deps({
      httpJson: async () => ({ ok: true, status: 200, body: JSON.stringify({ model: 'served', choices: [{ message: { content: 'R' } }] }) }),
    });
    const r = await runOpenAiCompatible(p, 'P', d);
    assert.equal(r.review, 'R');
    assert.ok(d.warnings.some((w) => w.includes('served') && w.includes('asked')));
  });

  test('an HTTP error body is preserved for the stub', async () => {
    const p = plan('ollama');
    const d = deps({
      httpJson: async (url, o) =>
        o.method === 'POST'
          ? { ok: false, status: 404, body: '{"error":"no such model"}' }
          : { ok: false, status: 0, body: '' },
    });
    const r = await runOpenAiCompatible(p, 'P', d);
    assert.equal(r.review, '');
    assert.ok(r.rawBody.includes('no such model'));
  });

  test('a non-JSON response body does not throw', async () => {
    const p = plan('ollama');
    const d = deps({ httpJson: async () => ({ ok: true, status: 200, body: '<html>502</html>' }) });
    const r = await runOpenAiCompatible(p, 'P', d);
    assert.equal(r.review, '');
    assert.ok(r.rawBody.includes('502'));
  });
});

describe('runner — orchestration', () => {
  test('an unavailable lane requested EXPLICITLY is surfaced (D4 carve-out)', async () => {
    const p = plan('gemini');
    const d = deps({ hasBinary: () => false });
    const r = await runLane(p, d, { repoRoot: ROOT, explicitlyRequested: true });
    assert.equal(r.ok, false);
    assert.ok(d.warnings.some((w) => w.includes('explicitly requested')));
  });

  test('an unavailable lane nobody asked for is quiet but still reported', async () => {
    const p = plan('gemini');
    const d = deps({ hasBinary: () => false });
    const r = await runLane(p, d, { repoRoot: ROOT, explicitlyRequested: false });
    assert.equal(r.ok, false);
    assert.equal(r.reason, LANE_UNAVAILABLE.MISSING_BINARY);
    assert.deepStrictEqual(d.warnings, []);
  });

  test('a file-arg lane reads its review from the file, not stdout', async () => {
    // Codex writes via -o and its stdout carries Windows teardown noise after the final message
    // (#1698); a stdout redirect would append that to a non-empty file and slip past the guard.
    const p = plan('codex');
    const d = deps({
      files: { [`${RUN}/gsd-review-codex.md`]: 'FROM FILE' },
      spawn: () => ({ status: 0, stdout: 'TEARDOWN NOISE', stderr: '' }),
    });
    await runLane(p, d, { repoRoot: ROOT });
    assert.ok(d.files[p.reviewPath].includes('FROM FILE'));
    assert.ok(!d.files[p.reviewPath].includes('TEARDOWN NOISE'));
  });

  test('stderr is always captured to the sidecar, never discarded', async () => {
    const p = plan('gemini');
    const d = deps({ spawn: () => ({ status: 0, stdout: 'R', stderr: 'a warning' }) });
    await runLane(p, d, { repoRoot: ROOT });
    assert.equal(d.files[p.errPath], 'a warning');
  });

  test('the prompt reaches stdin for a stdin lane', async () => {
    const p = plan('gemini');
    const d = deps({
      files: { [`${RUN}/gsd-review-prompt.md`]: 'THE PLAN' },
      spawn: (b, a, o) => { d.spawns.push({ b, a, o }); return { status: 0, stdout: 'R', stderr: '' }; },
    });
    await runLane(p, d, { repoRoot: ROOT });
    assert.equal(d.spawns[0].o.input, 'THE PLAN');
  });

  test('a prompt-less lane is fed nothing', async () => {
    const p = plan('coderabbit');
    const d = deps({
      files: { [`${RUN}/gsd-review-prompt.md`]: 'THE PLAN' },
      spawn: (b, a, o) => { d.spawns.push({ b, a, o }); return { status: 0, stdout: 'R', stderr: '' }; },
    });
    await runLane(p, d, { repoRoot: ROOT });
    assert.equal(d.spawns[0].o.input, undefined);
  });

  test('every spawn carries a positive timeout', async () => {
    // DEFECT.UNBOUNDED-SUBPROCESS: a frozen sync spawn cannot be interrupted and hangs a whole CI
    // chunk to its 10-minute kill with `# fail 0` and no `not ok`.
    for (const lane of REVIEWER_LANES.filter((l) => l.transport === 'spawn')) {
      const p = plan(lane.slug);
      const d = deps({ spawn: (b, a, o) => { d.spawns.push({ b, a, o }); return { status: 0, stdout: 'R', stderr: '' }; } });
      await runLane(p, d, { repoRoot: ROOT });
      for (const s of d.spawns) {
        assert.ok(s.o.timeoutMs > 0, `${lane.slug} spawned unbounded`);
      }
    }
  });
});

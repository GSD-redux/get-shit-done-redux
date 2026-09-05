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
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { resolveLanePlan, resolveLaneEffort, LANE_UNAVAILABLE } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
const {
  checkEgressHost,
  probeLane,
  runLane,
  writeReviewOrStub,
  handleOpencodeOutput,
  stampBlindReview,
  stampUngroundedReview,
  antigravityWatermark,
  antigravityTranscriptFallback,
  runOpenAiCompatible,
  MODEL_SOURCE,
  UNRESOLVED_MODEL,
  parseModelBanner,
  parseTranscriptModel,
  resolveSpawnModel,
  BANNER_SCAN_LINES,
  MODEL_VALUE_MAX,
} = require('../gsd-core/bin/lib/review-lane-runner.cjs');

const REVIEW_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'review.md');

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

  /**
   * A plan built through the SAME two steps the CLI runs (#4255): resolve the lane's review
   * effort, then expand it into argv. `plan()` above passes no effort at all, which is the right
   * default for rows that do not care — but a stub row asserting the effort must not invent it.
   */
  function planWithEffort(slug) {
    const lane = REVIEWER_LANES.find((l) => l.slug === slug);
    const eff = resolveLaneEffort(lane, () => undefined, (host, level) => ({
      argv: ['-c', `model_reasoning_effort=${level}`], value: level,
    }));
    const r = resolveLanePlan({
      lane, configGet: () => undefined, runDir: RUN, repoRoot: ROOT,
      effortArgs: eff.argv, effortValue: eff.value,
    });
    assert.equal(r.ok, true, `${slug} failed to resolve`);
    return r.plan;
  }

  test('#4255 — the stub names the effort and says the exit was clean', () => {
    // A crash, a timeout kill and a model that ended its turn without writing a final message all
    // reach the stub as the same zero bytes. The third is what a too-low reasoning effort produces
    // on a large source-grounded prompt, and it was indistinguishable from the first two — the
    // operator read "Codex failed" and went looking for a broken CLI. The stub now names the level
    // it ran at (the value they would change) and how the process actually ended.
    const p = planWithEffort('codex');
    const d = deps();
    writeReviewOrStub(p, '', d, undefined, { status: 0 });
    const out = d.files[p.reviewPath];
    assert.ok(out.includes('failed or returned empty output'),
      'the header every downstream reader greps for must be untouched');
    assert.ok(/ran at effort=high/.test(out), 'the stub must name the effort the lane ran at');
    assert.ok(/exited cleanly inside the timeout/.test(out));
    assert.ok(/ending its turn without writing a final message/.test(out),
      'a clean exit with no output must be named as the likeliest cause, not left reading as a crash');
    assert.ok(/most often/.test(out),
      'the cause is hedged on purpose: a clean empty exit is consistent with a stopped-short model '
      + 'AND with a CLI writing its output somewhere this lane did not read');
  });

  test('#4255 — a timeout kill and a crash are NOT reported as stopping short', () => {
    // The non-vacuity half: the stopped-short hint must be earned by a clean exit, or it is
    // advice that sends the operator to raise effort on a lane that was killed or crashed.
    const timedOut = deps();
    writeReviewOrStub(planWithEffort('codex'), '', timedOut, undefined, { status: null, errorCode: 'ETIMEDOUT' });
    const t = timedOut.files[planWithEffort('codex').reviewPath];
    assert.ok(/killed by the outer timeout/.test(t));
    assert.ok(!/most often/.test(t), 'a timeout is not a model stopping short');

    const crashed = deps();
    writeReviewOrStub(planWithEffort('codex'), '', crashed, undefined, { status: 127 });
    const c = crashed.files[planWithEffort('codex').reviewPath];
    assert.ok(/exited with status 127/.test(c));
    assert.ok(!/most often/.test(c), 'a non-zero exit is not a model stopping short');

    // `status` is null for a process that never started or died on a signal, exactly as it is for
    // a timeout kill. Reporting "status null" named nothing the operator could act on, and the
    // two must not collapse into one another (Codex review of #4255).
    for (const [label, out, expect] of [
      ['binary missing', { status: null, errorCode: 'ENOENT' }, /did not exit normally \(ENOENT\)/],
      ['killed by a signal', { status: null }, /did not exit normally \(killed by a signal\)/],
    ]) {
      const d = deps();
      writeReviewOrStub(planWithEffort('codex'), '', d, undefined, out);
      const text = d.files[planWithEffort('codex').reviewPath];
      assert.match(text, expect, `${label} must be named, not reported as "status null"`);
      assert.ok(!/status null/.test(text), `${label}: "status null" tells the operator nothing`);
      assert.ok(!/most often/.test(text), `${label} is not a model stopping short`);
    }
  });

  test('#4255 — an HTTP lane is not described as having a reviewer CLI', () => {
    // ollama is reached directly over HTTP: there is no CLI, so "the CLI's own configuration
    // applied" would be a lie about what ran (Codex review of #4255).
    const p = plan('ollama');
    const d = deps();
    writeReviewOrStub(p, '', d, undefined, { status: 0 });
    const out = d.files[p.reviewPath];
    assert.ok(/HTTP lane/.test(out));
    assert.ok(!/reviewer CLI/.test(out), 'an HTTP lane has no reviewer CLI to attribute anything to');
    assert.ok(!/effort=/.test(out), 'no level may be claimed for a transport that carries none');
  });

  test('#4255 — a lane that sent no effort argument says so, rather than naming a level', () => {
    // gemini declares no effort channel, so `plan.effort` is null. Printing a level there would
    // be a lie about what reached the CLI; the stub says the CLI's own configuration applied.
    const p = plan('gemini');
    const d = deps();
    writeReviewOrStub(p, '', d, undefined, { status: 0 });
    const out = d.files[p.reviewPath];
    assert.ok(/no effort argument, so the reviewer CLI's own configuration applied/.test(out));
    assert.ok(!/effort=/.test(out), 'no level may be claimed for a lane that sent none');
  });

  test('#4255 — the diagnosis is added even when the outcome is unknown', () => {
    // The HTTP path has no spawn outcome to pass. The effort half still applies, so the line is
    // still written — just without the exit clause it cannot honestly make.
    const p = planWithEffort('codex');
    const d = deps();
    writeReviewOrStub(p, '', d);
    assert.ok(/ran at effort=high/.test(d.files[p.reviewPath]));
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
    // #3194: 'THE REVIEW' cites no file:line evidence, so the runner stamps it before
    // writing — the assertion is therefore anchored on the review BODY, not byte-exact
    // equality with the whole file.
    const p = plan('opencode');
    const stream = JSON.stringify({ type: 'text', part: { text: 'THE REVIEW' } });
    const d = deps({ spawn: () => ({ status: 0, stdout: stream, stderr: '' }) });
    await runLane(p, d, { repoRoot: ROOT });
    assert.ok(d.files[p.reviewPath].endsWith('THE REVIEW\n'));
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

  // ── antigravityWatermark (#3118) ───────────────────────────────────────────
  //
  // Every test above hands the fallback a HAND-WRITTEN mark. None of them calls
  // `antigravityWatermark`, so none says anything about whether the mark a real run produces is
  // correct. The producer had zero test references before this block; the fail-open below lived
  // entirely in that gap.
  describe('antigravityWatermark — the mark a real run actually produces', () => {
    test('returns an empty mark when the conversation cache is absent', () => {
      assert.deepEqual(antigravityWatermark(ROOT, deps()), { convId: '', lines: 0, fullLines: 0 });
    });

    test('returns an empty mark when the cache is not valid JSON', () => {
      const d = deps({ files: { [CACHE]: 'NOT JSON' } });
      assert.deepEqual(antigravityWatermark(ROOT, d), { convId: '', lines: 0, fullLines: 0 });
    });

    test('returns an empty mark when the workspace has no conversation', () => {
      const d = deps({ files: { [CACHE]: JSON.stringify({ '/somewhere/else': 'c9' }) } });
      assert.deepEqual(antigravityWatermark(ROOT, d), { convId: '', lines: 0, fullLines: 0 });
    });

    for (const [label, body] of [
      ['a number', '0'],
      ['a string', '"just a string"'],
      ['an array', '[]'],
      ['null', 'null'],
      ['a boolean', 'true'],
    ]) {
      test(`a conversation cache that is ${label} yields an empty mark`, () => {
        // Valid JSON that is not an object still reaches hasOwnProperty / Object.entries.
        const d = deps({ files: { [CACHE]: body } });
        assert.deepEqual(antigravityWatermark(ROOT, d), { convId: '', lines: 0, fullLines: 0 });
      });
    }

    test('ignores a non-string conversation id', () => {
      const d = deps({ files: { [CACHE]: JSON.stringify({ [ROOT]: 42 }) } });
      assert.equal(antigravityWatermark(ROOT, d).convId, '');
    });

    test('ignores an empty-string conversation id', () => {
      const d = deps({ files: { [CACHE]: JSON.stringify({ [ROOT]: '' }) } });
      assert.equal(antigravityWatermark(ROOT, d).convId, '');
    });

    test('resolves the workspace case-insensitively', () => {
      const d = deps({ files: { [CACHE]: JSON.stringify({ '/REPO': 'c1' }), [TX('c1')]: entry('x') } });
      assert.equal(antigravityWatermark('/repo', d).convId, 'c1');
    });

    test('keeps the conversation id when the transcript does not exist yet', () => {
      // Distinct from the cases above: the conversation is KNOWN, it simply has no transcript.
      const d = deps({ files: { [CACHE]: JSON.stringify({ [ROOT]: 'c1' }) } });
      assert.deepEqual(antigravityWatermark(ROOT, d), { convId: 'c1', lines: 0, fullLines: 0 });
    });

    test('counts the non-blank transcript lines', () => {
      const files = { [CACHE]: JSON.stringify({ [ROOT]: 'c1' }), [TX('c1')]: [entry('a'), entry('b')].join('\n') };
      assert.equal(antigravityWatermark(ROOT, deps({ files })).lines, 2);
    });

    test('fullLines counts transcript_full.jsonl independently of lines (#2295)', () => {
      // ONE MARK COVERS TWO FILES, and the whole reason a second field exists is that one count
      // cannot substitute for the other — assert that directly rather than merely locking a shape.
      const FULL_TX = (id) => `/home/u/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript_full.jsonl`;
      const files = {
        [CACHE]: JSON.stringify({ [ROOT]: 'c1' }),
        [TX('c1')]: [entry('a'), entry('b')].join('\n'), // 2 non-blank lines
        [FULL_TX('c1')]: [
          JSON.stringify({ model: 'x' }),
          '',
          JSON.stringify({ model: 'y' }),
          JSON.stringify({ model: 'z' }),
        ].join('\n'), // 3 non-blank lines
      };
      const mark = antigravityWatermark(ROOT, deps({ files }));
      assert.equal(mark.lines, 2, 'transcript.jsonl count must be unaffected by transcript_full.jsonl');
      assert.equal(mark.fullLines, 3, 'transcript_full.jsonl count must be unaffected by transcript.jsonl');
      assert.notEqual(mark.lines, mark.fullLines, 'the two counts must be free to diverge');
    });

    test('an empty transcript is zero lines, not an unreadable one', () => {
      // Negative space for the fix: a genuinely empty transcript must NOT degrade.
      const files = { [CACHE]: JSON.stringify({ [ROOT]: 'c1' }), [TX('c1')]: '' };
      const mark = antigravityWatermark(ROOT, deps({ files }));
      assert.equal(mark.lines, 0);
      assert.notEqual(mark.unreadable, true, 'an empty transcript is readable, just empty');
    });

    test('whitespace-only transcript lines are not counted', () => {
      const files = { [CACHE]: JSON.stringify({ [ROOT]: 'c1' }), [TX('c1')]: '\n   \n\t\n' };
      const mark = antigravityWatermark(ROOT, deps({ files }));
      assert.equal(mark.lines, 0);
      assert.notEqual(mark.unreadable, true);
    });

    test('counts CRLF transcript lines the same as LF', () => {
      const lf = { [CACHE]: JSON.stringify({ [ROOT]: 'c1' }), [TX('c1')]: [entry('a'), entry('b')].join('\n') };
      const crlf = { [CACHE]: JSON.stringify({ [ROOT]: 'c1' }), [TX('c1')]: [entry('a'), entry('b')].join('\r\n') };
      assert.equal(
        antigravityWatermark(ROOT, deps({ files: lf })).lines,
        antigravityWatermark(ROOT, deps({ files: crlf })).lines,
      );
    });

    test('does not report zero lines when the transcript could not be read', () => {
      // THE FAIL-OPEN. The transcript EXISTS and its conversation pre-dates this run, so its
      // content is definitionally stale — but the read threw, so the count is unknown. Returning
      // `lines: 0` is indistinguishable from "genuinely empty" and asserts a fact the function
      // could not verify.
      const files = { [CACHE]: JSON.stringify({ [ROOT]: 'c1' }), [TX('c1')]: 'unused' };
      const d = deps({ files });
      const realRead = d.readFile;
      d.readFile = (p) => {
        if (p === TX('c1')) throw new Error('EACCES');
        return realRead(p);
      };

      const mark = antigravityWatermark(ROOT, d);
      assert.equal(mark.convId, 'c1', 'the conversation id was resolved and stays trustworthy');
      assert.equal(mark.unreadable, true, 'an unreadable transcript must be distinguishable from an empty one');
    });

    test('the fallback declines when the watermark could not be established', () => {
      // The CONSEQUENCE of the branch above. The watermark read fails; the fallback's own read
      // then succeeds (transient EACCES, a concurrent writer, a partial flush). With `lines: 0`
      // and a matching convId the fallback skips nothing and returns a PREVIOUS run's review as
      // this run's — the precise failure the "never stale" docstring promises cannot happen.
      const files = { [CACHE]: JSON.stringify({ [ROOT]: 'c1' }), [TX('c1')]: entry('STALE FROM LAST RUN') };
      const marking = deps({ files });
      const realRead = marking.readFile;
      marking.readFile = (p) => {
        if (p === TX('c1')) throw new Error('EACCES');
        return realRead(p);
      };
      const mark = antigravityWatermark(ROOT, marking);

      assert.equal(
        antigravityTranscriptFallback(ROOT, mark, deps({ files })),
        '',
        'an unverified watermark must not license replaying the transcript',
      );
    });

    test('the fallback still skips exactly the pre-run lines when the mark is sound', () => {
      // Negative space for the fix: a sound mark must keep working end-to-end, producer included.
      const files = { [CACHE]: JSON.stringify({ [ROOT]: 'c1' }), [TX('c1')]: entry('old') };
      const mark = antigravityWatermark(ROOT, deps({ files }));
      assert.equal(mark.lines, 1);

      files[TX('c1')] = [entry('old'), entry('THIS RUN')].join('\n');
      assert.equal(antigravityTranscriptFallback(ROOT, mark, deps({ files })), 'THIS RUN');
    });
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

// #3086: spawn errors (ENOENT on Windows .cmd shims, ETIMEDOUT, etc.) must be
// surfaced in the err file so the stub reviewer output explains WHY the lane
// produced nothing, rather than silently dropping the error code.

describe('runner — #3086: spawn errorCode surfaced in err file', () => {
  test('a spawn ENOENT writes the error code to the err file', async () => {
    const p = plan('gemini');
    const d = deps({
      spawn: () => ({ status: null, stdout: '', stderr: '', errorCode: 'ENOENT' }),
    });
    await runLane(p, d, { repoRoot: ROOT });
    const errContent = d.files[p.errPath] || '';
    assert.ok(errContent.includes('ENOENT'),
      `err file must include the spawn error code; got: ${errContent}`);
  });

  test('a spawn ETIMEDOUT writes the error code to the err file', async () => {
    const p = plan('codex');
    const d = deps({
      spawn: () => ({ status: null, stdout: '', stderr: '', errorCode: 'ETIMEDOUT' }),
    });
    await runLane(p, d, { repoRoot: ROOT });
    const errContent = d.files[p.errPath] || '';
    assert.ok(errContent.includes('ETIMEDOUT'),
      `err file must include the spawn error code; got: ${errContent}`);
  });

  test('a successful spawn with stderr does NOT add a spawn error marker', async () => {
    const p = plan('gemini');
    const d = deps({
      spawn: () => ({ status: 0, stdout: '## Review\nok', stderr: 'some warning', errorCode: undefined }),
    });
    await runLane(p, d, { repoRoot: ROOT });
    const errContent = d.files[p.errPath] || '';
    assert.ok(!errContent.includes('[spawn error:'),
      `err file must NOT contain a spawn error marker on success; got: ${errContent}`);
    assert.ok(errContent.includes('some warning'),
      'legitimate stderr should still be written');
  });
});

// Folded from tests/fix-2494-review-claude-gemini-empty-guard.test.cjs (#3334/H3).
//
// #2494 — a failed reviewer lane must be diagnosable, never a silent drop. Before the fix, gemini
// and claude sent stderr to `/dev/null` and wrote nothing on failure. A failed lane — CLI missing,
// unauthenticated, rate-limited, crashed, any exit that writes no stdout — left a zero-byte file
// that `write_reviews` rendered as "a reviewer that ran cleanly with nothing to report", silently
// dropping a lane from the cross-AI consensus while `present_results` reported success. The policy
// is uniform across every lane now rather than fixed per-leg, so these assertions run over the
// whole spawn roster instead of the two legs the issue named.
describe('#2494 — a failed lane writes a diagnosable stub, not a zero-byte file', () => {
  /** Lanes whose empty-output policy is the shared stub (antigravity owns its own diagnostics). */
  const STUB_LANES = REVIEWER_LANES.filter(
    (l) => l.transport === 'spawn' && l.emptyOutput === 'stub-with-stderr',
  );

  function planFor(slug) {
    const lane = REVIEWER_LANES.find((l) => l.slug === slug);
    const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: RUN, repoRoot: ROOT });
    assert.equal(r.ok, true, `${slug} failed to resolve`);
    return r.plan;
  }

  function deps(spawnResult, files = {}) {
    return {
      files,
      // `kimi-code` declares a `command-capability` probe, so the runner spawns `--help` BEFORE the
      // review. Answer that separately or the probe fails and the lane never reaches the invocation
      // this test is about.
      spawn: (binary, argv) =>
        argv && argv.length === 1 && argv[0] === '--help'
          ? { status: 0, stdout: '--output-format', stderr: '' }
          : spawnResult,
      httpJson: async () => ({ ok: true, status: 200, body: '{}' }),
      readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
      writeFile: (p, c) => { files[p] = c; },
      exists: (p) => p in files,
      hasBinary: () => true,
      configGet: () => undefined,
      homeDir: '/home/u',
      warn: () => {},
    };
  }

  for (const lane of STUB_LANES) {
    test(`${lane.slug}: a lane that exits non-zero with no stdout is stubbed`, async () => {
      const p = planFor(lane.slug);
      const d = deps({ status: 127, stdout: '', stderr: 'command not found' });
      const r = await runLane(p, d, { repoRoot: ROOT });

      assert.equal(r.stubbed, true, 'a failed lane must be reported as stubbed');
      const review = d.files[p.reviewPath];
      assert.ok(review !== undefined, 'a review file must exist after a failed lane');
      assert.notStrictEqual(review.trim(), '', 'the review file must not be empty');
      assert.ok(
        review.includes('failed or returned empty output'),
        'the stub must be distinguishable from a real review',
      );
    });

    test(`${lane.slug}: stderr is captured to a .err sidecar, never discarded`, async () => {
      // The sidecar is the difference between "this lane failed" and "this lane failed BECAUSE…".
      // Without it every failure mode looks identical to every other.
      const p = planFor(lane.slug);
      const d = deps({ status: 1, stdout: '', stderr: 'HTTP 429 rate limited' });
      await runLane(p, d, { repoRoot: ROOT });

      assert.equal(d.files[p.errPath], 'HTTP 429 rate limited', 'stderr must reach the sidecar');
      assert.ok(
        d.files[p.reviewPath].includes('HTTP 429 rate limited'),
        'and must be surfaced in the stub, where a reader will actually see it',
      );
      assert.ok(p.reviewPath.endsWith('.md'), 'review output path unchanged');
    });
  }

  test('a successful review passes through untouched', async () => {
    const p = planFor('gemini');
    const d = deps({ status: 0, stdout: 'Looks good.\n', stderr: '' });
    const r = await runLane(p, d, { repoRoot: ROOT });

    assert.equal(r.stubbed, false);
    assert.ok(d.files[p.reviewPath].includes('Looks good.'));
    assert.ok(
      !d.files[p.reviewPath].includes('failed or returned empty output'),
      'a real review must never carry the failure header',
    );
  });

  test('no lane sends stderr to /dev/null — the sidecar is unconditional', async () => {
    // The original defect in one line, asserted over the whole roster rather than the two legs the
    // issue named: the policy is uniform now, and a future lane must not be able to opt out.
    for (const lane of STUB_LANES) {
      const p = planFor(lane.slug);
      const d = deps({ status: 0, stdout: 'ok', stderr: 'a warning' });
      await runLane(p, d, { repoRoot: ROOT });
      assert.equal(d.files[p.errPath], 'a warning', `${lane.slug} discarded stderr`);
    }
  });
});

// Folded from tests/fix-2605-review-local-server-empty-guard.test.cjs (#3334/H3).
//
// #2605 — the local OpenAI-compatible lanes (ollama / lm_studio / llama.cpp) dropped silently. The
// original defects, all of which made a failed lane indistinguishable from a clean empty review:
// bare `curl -s` suppressed curl's own error text; the response was piped straight into `jq` so the
// BODY — where an OpenAI-compatible server puts its error JSON on an HTTP 4xx/5xx while curl still
// exits 0 — was discarded unread; nothing was written when content was empty, so the file never
// existed and `write_reviews` omitted the section entirely; and a whitespace-only reply passed the
// byte-counting `[ ! -s … ]` guard as a successful review.
describe('#2605 local OpenAI-compatible lanes produce diagnosable output', () => {
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

  // NOTE: 'a served-model mismatch is warned about, not silently accepted' (originally in
  // fix-2605-review-local-server-empty-guard.test.cjs) was DROPPED here as a genuine duplicate of
  // "runner — openai-compatible handler > a served-model mismatch warns without failing the review"
  // above: same lane (lm_studio), same call path (runOpenAiCompatible directly), same assertion
  // shape (review content + a warning naming both the served and asked-for model), differing only
  // in the literal string labels used for the mismatched model names.

  test('neither jq nor curl is required by any of these lanes', () => {
    // The dependency is gone, not merely satisfied: parsing is JSON.parse and the request is
    // in-process. `jq` is absent on stock Windows/Git-Bash (#2589), which gated these lanes.
    for (const lane of HTTP_LANES) {
      assert.deepStrictEqual([...lane.requiresBinaries], [], `${lane.slug} still declares a binary`);
    }
  });
});

// Folded from tests/fix-2794-review-qwen-empty-guard.test.cjs (#3334/H3).
//
// #2794 — the qwen reviewer leg was the last one still sending stderr to /dev/null. Every other lane
// captured stderr to a `.err` sidecar and appended it to the stub (#2494/#2605); qwen wrote a bare
// "failed or returned empty output." with no diagnostic at all, so a missing binary, an auth prompt
// and a rate-limit were indistinguishable from each other AND from a clean empty review.
describe('#2794 qwen reviewer stderr capture', () => {
  function planFor(slug) {
    const lane = REVIEWER_LANES.find((l) => l.slug === slug);
    const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: RUN, repoRoot: ROOT });
    assert.equal(r.ok, true);
    return r.plan;
  }

  function deps(spawnResult, files = {}, hasBinary = () => true) {
    return {
      files,
      spawn: () => spawnResult,
      httpJson: async () => ({ ok: true, status: 200, body: '{}' }),
      readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
      writeFile: (p, c) => { files[p] = c; },
      exists: (p) => p in files,
      hasBinary,
      configGet: () => undefined,
      homeDir: '/home/u',
      warn: () => {},
    };
  }

  test('writes the review on success', async () => {
    const p = planFor('qwen');
    const d = deps({ status: 0, stdout: '## Qwen findings\nall good\n', stderr: '' });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.equal(r.stubbed, false);
    assert.ok(d.files[p.reviewPath].includes('## Qwen findings'));
  });

  test('a failed lane surfaces its stderr in the review stub', async () => {
    const p = planFor('qwen');
    const d = deps({ status: 1, stdout: '', stderr: 'auth required: run `qwen login`' });
    await runLane(p, d, { repoRoot: ROOT });
    assert.ok(d.files[p.reviewPath].includes('auth required'),
      'the diagnostic must reach the review, not just the sidecar');
    assert.equal(d.files[p.errPath], 'auth required: run `qwen login`');
  });

  test('a silently empty lane still produces a diagnosable stub', async () => {
    const p = planFor('qwen');
    const d = deps({ status: 0, stdout: '', stderr: '' });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.equal(r.stubbed, true);
    assert.ok(d.files[p.reviewPath].includes('failed or returned empty output'));
  });

  test('a missing qwen binary reports unavailable rather than an empty review', async () => {
    // Stronger than the original: the lane is now reported with a TYPED reason before it is ever
    // spawned, instead of producing a stub that looked the same as every other failure.
    const p = planFor('qwen');
    const d = deps({ status: 0, stdout: '', stderr: '' }, {}, () => false);
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing_binary');
    assert.equal(d.files[p.reviewPath], undefined, 'no review file for a lane that never ran');
  });

  test('the sidecar is structural — no lane can opt out of it', async () => {
    // The #2794 defect was one lane diverging from a convention every other lane followed. There is
    // no per-lane place to diverge any more; this asserts that directly.
    for (const lane of REVIEWER_LANES.filter((l) => l.transport === 'spawn')) {
      const p = planFor(lane.slug);
      assert.ok(p.errPath.endsWith('.err'), `${lane.slug} must declare a stderr sidecar`);
      assert.notEqual(p.errPath, '/dev/null');
    }
  });
});

// #3194 — a source-grounded lane's grounding is VERIFIED from its review output, never trusted
// from its declaration. The gemini lane declares evidenceClass 'source-grounded', but nothing at
// invocation obliged grounding and nothing verified it, so measured plan-only reviews (zero real
// file:line citations, invented PLAN-line references) rode the declared class at full consensus
// weight — the weakest review getting the strongest weight, silently. The fix stamps a
// down-weight marker onto a citation-free review BEFORE it reaches {run_dir}/gsd-review-<slug>.md,
// and the Consensus Summary step recognizes the marker exactly as it already recognizes
// [reviewed-without-repo-access] (#2176).
describe('#3194 — evidence grounding is verified from review output, not declared', () => {
  const MARKER = '[reviewed-without-source-citations]';

  // The measured failure shape: a review of the pasted plan text only, restating the plan's own
  // claims with invented plan-line references — "line 42", "L12-L18" — and NO file path anywhere,
  // which is what separates a plan-line reference from a source citation.
  const PLAN_ONLY = [
    '## Review',
    '',
    'The plan looks broadly sound. Per step 2 (see line 42) the executor writes the phase',
    'artifact, and the roadmap item at line 5 is already covered by step 1 (L12-L18).',
    'One concern: the verification at line 77 lacks a timeout.',
  ].join('\n');

  const CITED = `${PLAN_ONLY}\n\nHowever, src/executor/run-phase.cts:214 has no timeout guard.`;

  describe('stampUngroundedReview — the citation check, table-tested at 0 vs 1', () => {
    test('a plan-only review with invented plan-line references IS stamped', () => {
      const out = stampUngroundedReview(PLAN_ONLY);
      assert.ok(out.startsWith(`> ${MARKER}`), 'the marker must be prepended to the head');
      assert.ok(/down-weight/i.test(out), 'the stamp must instruct down-weighting');
      assert.ok(out.endsWith(PLAN_ONLY), 'the review body must survive verbatim after the stamp');
    });

    test('a single real file:line citation keeps the review at full weight', () => {
      assert.equal(stampUngroundedReview(CITED), CITED, 'a grounded review passes through untouched');
    });

    test('citation shapes: paths, backticks, root files, ranges, windows separators, absolutes', () => {
      for (const body of [
        'see src/foo.cts:42 for the guard',
        'see `src/foo.cts:42` for the guard',
        'README.md:12 documents the flag',
        'a/b/c.py:7-9 duplicates the loop',
        'src\\foo.cts:42 windows path',
        '(src/foo.cts:42) in parens',
        'absolute /Users/u/repo/src/x.ts:9 citation',
      ]) {
        assert.ok(!stampUngroundedReview(body).includes(MARKER), `${body} must count as grounded`);
      }
    });

    test('non-citations: bare line refs, times, URLs — none count as grounding', () => {
      for (const body of [
        'see line 42',
        'plan line 5 says',
        'the run took 12:30',
        'server at http://localhost:8080 responded',
        'fetch https://example.com/x first',
      ]) {
        assert.ok(stampUngroundedReview(body).includes(MARKER), `${body} must not count as grounded`);
      }
    });

    test('empty and whitespace-only reviews pass through unstamped', () => {
      // The empty-output policy owns that case with a diagnostic stub; the stamp must not
      // decorate a stub.
      assert.equal(stampUngroundedReview(''), '');
      assert.equal(stampUngroundedReview('  \n'), '  \n');
    });

    test('an already-stamped review is not stamped twice', () => {
      const once = stampUngroundedReview(PLAN_ONLY);
      assert.ok(once.includes(MARKER));
      assert.equal(stampUngroundedReview(once), once, 'stamping must be idempotent');
    });
  });

  describe('runLane — the stamp reaches {run_dir}/gsd-review-<slug>.md', () => {
    test('gemini: zero citations → the review file carries the down-weight marker', async () => {
      const p = plan('gemini');
      const d = deps({ spawn: () => ({ status: 0, stdout: PLAN_ONLY, stderr: '' }) });
      await runLane(p, d, { repoRoot: ROOT });
      assert.ok(
        d.files[p.reviewPath].startsWith(`> ${MARKER}`),
        'the marker must be prepended before the review is written',
      );
    });

    test('gemini: one citation → full weight, no marker', async () => {
      const p = plan('gemini');
      const d = deps({ spawn: () => ({ status: 0, stdout: CITED, stderr: '' }) });
      await runLane(p, d, { repoRoot: ROOT });
      assert.ok(!d.files[p.reviewPath].includes(MARKER));
    });

    test('coderabbit (diff-only): NOT stamped — its existing weighting must not change', async () => {
      // Out-of-scope surface: CodeRabbit is already down-weighted via its declared diff-only
      // class; the citation check must not add a second, redundant signal on top.
      const p = plan('coderabbit');
      const d = deps({ spawn: () => ({ status: 0, stdout: PLAN_ONLY, stderr: '' }) });
      await runLane(p, d, { repoRoot: ROOT });
      assert.ok(!d.files[p.reviewPath].includes(MARKER));
    });

    test('ollama (openai-http, source-grounded): the http path stamps too', async () => {
      // The probe GET on /v1/models must be answered separately or the lane never reaches the
      // chat call these assertions are about (same shape as the #2605 suite's reachableThen).
      const laneDeps = (content) => deps({
        httpJson: async (url, opts) =>
          opts.method === 'GET'
            ? { ok: true, status: 200, body: JSON.stringify({ data: [{ id: 'stub-model' }] }) }
            : {
                ok: true, status: 200,
                body: JSON.stringify({ choices: [{ message: { content } }] }),
              },
      });

      const d0 = laneDeps(PLAN_ONLY);
      const p0 = plan('ollama');
      await runLane(p0, d0, { repoRoot: ROOT });
      assert.ok(
        d0.files[p0.reviewPath].startsWith(`> ${MARKER}`),
        'zero citations must stamp on the http path',
      );

      const d1 = laneDeps(CITED);
      const p1 = plan('ollama');
      await runLane(p1, d1, { repoRoot: ROOT });
      assert.ok(!d1.files[p1.reviewPath].includes(MARKER), 'a citation must not stamp');
    });
  });

  test('the resolved plan carries the declared evidenceClass (#3194 seam)', () => {
    // The runner gates the stamp on this field; before #3194 the plan did not carry it at all,
    // so the executor had no access to the declaration it was supposed to verify.
    assert.equal(plan('gemini').evidenceClass, 'source-grounded');
    assert.equal(plan('ollama').evidenceClass, 'source-grounded');
    assert.equal(plan('coderabbit').evidenceClass, 'diff-only');
  });

  test('the Consensus Summary step recognizes the marker, like [reviewed-without-repo-access]', () => {
    // The down-weight only happens if the consensus instruction knows the marker. This locks
    // the review.md prose to the runner's stamp so the two cannot drift apart silently.
    const prose = fs.readFileSync(REVIEW_MD, 'utf-8');
    const step = prose.slice(prose.indexOf('## Consensus Summary'));
    assert.ok(step.length > 0, 'review.md must carry a Consensus Summary step');
    assert.ok(step.includes(MARKER), 'the consensus step must name the ungrounded marker');
    assert.ok(
      step.includes('[reviewed-without-repo-access]'),
      'the existing blind-review recognition must survive alongside it',
    );
  });
});

/* ------------------------------------------------------------------ *
 * #2295 — the resolved model, recorded per lane
 * ------------------------------------------------------------------ */

/** A `transcript_full.jsonl` body: one compact JSON value per line. */
const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n');

/** The Antigravity on-disk paths, both of them, for a given conversation id. */
const CACHE = '/home/u/.gemini/antigravity-cli/cache/last_conversations.json';
const fullPath = (id) => `/home/u/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript_full.jsonl`;
const txPath = (id) => `/home/u/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`;

describe('#2295 — MODEL_SOURCE contract', () => {
  test('the member set is locked — adding one is three coordinated changes', () => {
    // Same discipline PARITY_VIOLATION and LANE_UNAVAILABLE already carry: enum + emitting site
    // + this assertion. A new source that never reaches a caller is not a feature.
    assert.deepEqual(Object.keys(MODEL_SOURCE).sort(), [
      'BANNER', 'PINNED', 'REQUESTED', 'SERVED', 'TRANSCRIPT', 'UNKNOWN',
    ]);
    assert.equal(Object.isFrozen(MODEL_SOURCE), true, 'the enum must be frozen');
  });

  test('the unresolved sentinel satisfies the value-source biconditional', () => {
    // The biconditional is the whole readability contract of the frontmatter block: a reader must
    // be able to tell "nothing recorded" from "nothing to look at" without a second lookup.
    assert.equal(UNRESOLVED_MODEL.value, null);
    assert.equal(UNRESOLVED_MODEL.source, MODEL_SOURCE.UNKNOWN);
    assert.equal(Object.isFrozen(UNRESOLVED_MODEL), true);
  });
});

describe('#2295 — parseModelBanner', () => {
  test('parses a bare banner line', () => {
    assert.equal(parseModelBanner('model: gpt-5.6-sol'), 'gpt-5.6-sol');
  });

  test('tolerates banner chrome and leading whitespace', () => {
    const banner = [
      '  OpenAI Codex  (v0.144.3)',
      '--------',
      '  model: gpt-5.6-sol',
      'workdir: /repo',
    ].join('\n');
    assert.equal(parseModelBanner(banner), 'gpt-5.6-sol');
  });

  test('an adjacent reasoning-effort line is not absorbed into the value', () => {
    assert.equal(parseModelBanner('model: gpt-5.6-sol\nreasoning effort: high'), 'gpt-5.6-sol');
  });

  test('CRLF parses identically to LF', () => {
    assert.equal(parseModelBanner('model: gpt-5.6-sol\r\nworkdir: /repo\r\n'), 'gpt-5.6-sol');
  });

  test('no model line yields null', () => {
    assert.equal(parseModelBanner('OpenAI Codex\nworkdir: /repo'), null);
  });

  test('an empty or whitespace-only value yields null', () => {
    assert.equal(parseModelBanner('model:'), null);
    assert.equal(parseModelBanner('model:    '), null);
  });

  test('TWO DIFFERENT values are ambiguous and yield null — never first-wins', () => {
    // Postel's modern caveat: liberal must not mean "guess silently". Two candidates is an
    // ambiguity, and picking one would attribute the review to a model on a coin flip.
    assert.equal(parseModelBanner('model: gpt-5.6-sol\nmodel: o4-mini'), null);
  });

  test('two IDENTICAL values are not ambiguous', () => {
    assert.equal(parseModelBanner('model: gpt-5.6-sol\nmodel: gpt-5.6-sol'), 'gpt-5.6-sol');
  });

  test('the scan window boundary holds at limit-1, limit and limit+1', () => {
    const at = (n) => parseModelBanner([...Array(n).fill('noise'), 'model: gpt-5.6-sol'].join('\n'));
    assert.equal(at(BANNER_SCAN_LINES - 2), 'gpt-5.6-sol', 'limit-1 is inside the window');
    assert.equal(at(BANNER_SCAN_LINES - 1), 'gpt-5.6-sol', 'limit is inside the window');
    assert.equal(at(BANNER_SCAN_LINES), null, 'limit+1 is outside the window');
  });

  test('an over-long value is rejected rather than truncated', () => {
    assert.equal(
      parseModelBanner(`model: ${'m'.repeat(MODEL_VALUE_MAX - 1)}`),
      'm'.repeat(MODEL_VALUE_MAX - 1),
      'one under the cap is still a model',
    );
    assert.equal(
      parseModelBanner(`model: ${'m'.repeat(MODEL_VALUE_MAX)}`),
      'm'.repeat(MODEL_VALUE_MAX),
      'exactly at the cap is still a model',
    );
    assert.equal(parseModelBanner(`model: ${'m'.repeat(MODEL_VALUE_MAX + 1)}`), null);
  });

  test('degenerate inputs yield null without throwing', () => {
    for (const input of ['', '\n', '\r\n', '   ', 'x'.repeat(100000)]) {
      assert.equal(parseModelBanner(input), null);
    }
  });

  test('a hostile value is recorded inert, never interpreted', () => {
    // The value is data on its way to a markdown frontmatter field. It is never re-emitted as
    // argv and never shell-interpolated, so the contract is simply "verbatim or rejected".
    assert.equal(parseModelBanner('model: $(rm -rf /)'), '$(rm -rf /)');
    assert.equal(parseModelBanner('model: `id`; echo pwned'), '`id`; echo pwned');
  });

  test('the unset sentinels are not models', () => {
    // Shared with the config path rather than re-derived — one source for "what counts as
    // unset", so the two can never disagree.
    for (const v of ['null', 'undefined']) assert.equal(parseModelBanner(`model: ${v}`), null);
  });

  test('a control character in the value is rejected — DEL and unit separator', () => {
    // The line-split already isolates `\n`/`\r` before a banner value is ever built, so those
    // two are covered structurally here; the remaining C0/DEL range still reaches
    // `normalizeModelValue` inside one line and must be refused the same way.
    assert.equal(parseModelBanner(`model: gpt-5${String.fromCharCode(127)}`), null, 'DEL');
    assert.equal(parseModelBanner(`model: gpt-5${String.fromCharCode(31)}`), null, 'unit separator');
    assert.equal(parseModelBanner(`model: gpt-5${String.fromCharCode(9)}sol`), null, 'tab');
  });

  test('a colon-bearing model id still parses in full — the fix must not over-reject', () => {
    assert.equal(parseModelBanner('model: llama3:70b'), 'llama3:70b');
  });
});

describe('#2295 — parseTranscriptModel', () => {
  test('parses a top-level settings model', () => {
    assert.equal(
      parseTranscriptModel(jsonl({ type: 'SETTINGS', model: 'Gemini 3.5 Flash (Medium)' })),
      'Gemini 3.5 Flash (Medium)',
    );
  });

  test('parses a model nested one level under a settings wrapper', () => {
    // Depth is BOUNDED AT TWO and stated, not recursive: the wrapper key name is not knowable
    // without guessing, but the depth is. Anything deeper degrades to unknown.
    assert.equal(
      parseTranscriptModel(jsonl({ type: 'SETTINGS', settings: { model: 'Gemini 3.5 Flash (Medium)' } })),
      'Gemini 3.5 Flash (Medium)',
    );
  });

  test('a model buried at depth three is NOT found', () => {
    assert.equal(parseTranscriptModel(jsonl({ a: { b: { model: 'too-deep' } } })), null);
  });

  test('the LAST settings entry wins', () => {
    const body = jsonl(
      { type: 'SETTINGS', model: 'first' },
      { source: 'MODEL', content: 'a review' },
      { type: 'SETTINGS', model: 'second' },
    );
    assert.equal(parseTranscriptModel(body), 'second');
  });

  test('prose merely containing the word model is ignored', () => {
    const body = jsonl({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'the model: gpt-5 is wrong here' });
    assert.equal(parseTranscriptModel(body), null);
  });

  test('a line parsing to null is ignored (typeof null === object)', () => {
    assert.equal(parseTranscriptModel(['null', JSON.stringify({ model: 'real' })].join('\n')), 'real');
    assert.equal(parseTranscriptModel('null'), null);
  });

  test('array, scalar and string lines are ignored', () => {
    assert.equal(parseTranscriptModel(jsonl([{ model: 'in-an-array' }], 7, 'a string')), null);
  });

  test('one unparseable line does not poison the file', () => {
    const body = ['{not json', JSON.stringify({ model: 'survivor' }), 'also{ not'].join('\n');
    assert.equal(parseTranscriptModel(body), 'survivor');
  });

  test('a non-string model value is ignored, never coerced', () => {
    assert.equal(parseTranscriptModel(jsonl({ model: 0 }, { model: true }, { model: { id: 'x' } })), null);
  });

  test('prototype keys never resolve as a model', () => {
    // Own-property lookup only. A transcript is third-party JSON on a trust boundary; a
    // `constructor`-shaped entry must not walk up to Object.prototype.
    assert.equal(parseTranscriptModel('{"__proto__":{"model":"polluted"}}'), null);
    assert.equal(parseTranscriptModel('{"constructor":{"model":"polluted"}}'), null);
    assert.equal({}.model, undefined, 'no global prototype was mutated');
  });

  test('degenerate transcripts yield null without throwing', () => {
    for (const input of ['', '\n\n', '   \r\n  ', '[]', '{}']) {
      assert.equal(parseTranscriptModel(input), null);
    }
  });

  test('CRLF transcripts parse identically', () => {
    assert.equal(parseTranscriptModel(`${JSON.stringify({ model: 'crlf-ok' })}\r\n`), 'crlf-ok');
  });

  test('a newline in a recovered value cannot forge a frontmatter key', () => {
    // The sharpest reach of this defect: a value carrying `\n` lands verbatim in REVIEWS.md YAML
    // frontmatter, so this exact shape forges a `reviewers:` sibling key if not refused.
    const NL = String.fromCharCode(10);
    const hostile = JSON.stringify({ model: `gemini${NL}reviewers: [forged]${NL}model_sources:` });
    assert.equal(parseTranscriptModel(hostile), null);
  });

  test('every C0 control, DEL and every C1 control is rejected the same way', () => {
    for (const code of [10, 13, 9, 31, 127, 128, 159]) {
      const hostile = JSON.stringify({ model: `gemini${String.fromCharCode(code)}x` });
      assert.equal(parseTranscriptModel(hostile), null, `code ${code}`);
    }
  });

  test('a colon-bearing and a space-bearing model id still parse — the fix must not over-reject', () => {
    assert.equal(parseTranscriptModel(jsonl({ model: 'llama3:70b' })), 'llama3:70b');
    assert.equal(parseTranscriptModel(jsonl({ model: 'Gemini 3.5 Flash (Medium)' })), 'Gemini 3.5 Flash (Medium)');
  });
});

describe('#2295 — resolveLanePlan records only a model that was APPLIED', () => {
  test('a configured model that reached argv is recorded on the plan', () => {
    const p = plan('gemini', { 'review.models.gemini': 'gemini-3-pro' });
    assert.equal(p.model, 'gemini-3-pro');
    assert.ok(p.argv.includes('gemini-3-pro'), 'and it really is in argv');
  });

  test('an unset config yields no plan model', () => {
    assert.equal(plan('gemini').model, null);
  });

  test('a lane declaring no modelConfigKey records no model', () => {
    assert.equal(plan('cursor').model, null);
    assert.equal(plan('coderabbit').model, null);
  });

  test('the unset sentinels do not become a model', () => {
    for (const v of ['', '   ', 'null', 'undefined']) {
      assert.equal(plan('gemini', { 'review.models.gemini': v }).model, null, `sentinel ${JSON.stringify(v)}`);
    }
  });

  test('a non-string config value is not coerced into a model', () => {
    for (const v of [0, 42, true, { id: 'x' }, ['x']]) {
      assert.equal(plan('gemini', { 'review.models.gemini': v }).model, null);
    }
  });

  test('a lane with a modelConfigKey but NO modelArg records nothing — it never reached argv', () => {
    // The gap this closes: a third-party overlay body can declare a model key and forget the
    // argument that carries it. The CLI then reviews with its own default while the config says
    // otherwise. Recording the config value here would assert a model that never ran — the
    // inverse of the very failure #2295 exists to end.
    const gemini = REVIEWER_LANES.find((l) => l.slug === 'gemini');
    const lane = {
      ...gemini,
      slug: 'noarg',
      modelConfigKey: 'review.models.noarg',
      invoke: { ...gemini.invoke, modelArg: null },
    };
    const r = resolveLanePlan({
      lane,
      configGet: (k) => (k === 'review.models.noarg' ? 'ghost-model' : undefined),
      runDir: RUN,
      repoRoot: ROOT,
    });
    assert.equal(r.ok, true);
    assert.equal(r.plan.model, null, 'a model that never reached argv is not a resolved model');
    assert.ok(!r.plan.argv.includes('ghost-model'), 'and it really is absent from argv');
  });

  test('the http plan model field is unchanged', () => {
    assert.equal(plan('ollama', { 'review.models.ollama': 'llama3' }).model, 'llama3');
    assert.equal(plan('ollama').model, null);
  });
});

describe('#2295 — runLane reports the resolved model', () => {
  test('a pinned spawn model is reported as pinned', async () => {
    const p = plan('gemini', { 'review.models.gemini': 'gemini-3-pro' });
    const d = deps({ spawn: () => ({ status: 0, stdout: 'a review with src/x.ts:10 evidence', stderr: '' }) });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'gemini-3-pro', source: MODEL_SOURCE.PINNED });
  });

  test('a file-output lane recovers its model from the stdout banner', async () => {
    const p = plan('codex');
    const d = deps({
      spawn: () => ({ status: 0, stdout: 'model: gpt-5.6-sol\nworkdir: /repo', stderr: '' }),
      files: { [p.outputTarget.path]: 'a review citing src/x.ts:10' },
    });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'gpt-5.6-sol', source: MODEL_SOURCE.BANNER });
  });

  test('a file-output lane recovers its model from the stderr banner', async () => {
    const p = plan('codex');
    const d = deps({
      spawn: () => ({ status: 0, stdout: '', stderr: 'model: gpt-5.6-sol' }),
      files: { [p.outputTarget.path]: 'a review citing src/x.ts:10' },
    });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'gpt-5.6-sol', source: MODEL_SOURCE.BANNER });
  });

  test('a pinned model outranks a banner', async () => {
    const p = plan('codex', { 'review.models.codex': 'o4-mini' });
    const d = deps({
      spawn: () => ({ status: 0, stdout: 'model: gpt-5.6-sol', stderr: '' }),
      files: { [p.outputTarget.path]: 'a review citing src/x.ts:10' },
    });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'o4-mini', source: MODEL_SOURCE.PINNED });
  });

  test('a STDOUT lane never parses its own review text as a banner', async () => {
    // The headline negative. A stdout lane's review lands in exactly the buffer the banner scan
    // would read, so a review that DISCUSSES a model would be recorded as that lane's model.
    const p = plan('gemini');
    const d = deps({
      spawn: () => ({ status: 0, stdout: 'model: gpt-5 is the wrong choice, see src/x.ts:10', stderr: '' }),
    });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, UNRESOLVED_MODEL, 'review prose is not a banner');
  });

  test('an unavailable lane reports unknown and still reports its reason', async () => {
    const p = plan('gemini');
    const r = await runLane(p, deps({ hasBinary: () => false }), { repoRoot: ROOT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, LANE_UNAVAILABLE.MISSING_BINARY);
    assert.deepEqual(r.model, UNRESOLVED_MODEL);
  });

  test('a lane blocked on egress reports unknown and spawns nothing', async () => {
    const p = plan('ollama');
    const d = deps();
    const r = await runLane(p, d, { repoRoot: ROOT, consentedHost: 'http://elsewhere:1234' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, LANE_UNAVAILABLE.EGRESS_HOST_CHANGED);
    assert.deepEqual(r.model, UNRESOLVED_MODEL);
    assert.equal(d.spawns.length, 0);
  });

  test('a stubbed lane still reports the model it invoked', async () => {
    // #2073 mode 2 is exactly this shape: a pinned model that 404s server-side exits 0 with empty
    // output. The model is the diagnosis, so dropping it on the stub path throws away the evidence.
    const p = plan('codex', { 'review.models.codex': 'does-not-exist' });
    const d = deps({ spawn: () => ({ status: 0, stdout: '', stderr: '' }) });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.equal(r.stubbed, true);
    assert.deepEqual(r.model, { value: 'does-not-exist', source: MODEL_SOURCE.PINNED });
  });

  test('a review.models.gemini configured with an embedded newline records UNRESOLVED_MODEL, not pinned', async () => {
    // `configString` (review-lane-invocation.cjs) is pre-existing and out of scope — it does not
    // strip control characters, so `plan.model` itself still carries the hostile value. The
    // rejection MUST happen at the `resolveSpawnModel` pinned arm, the one choke point every
    // recorded model routes through, so a control character configured into `review.models.<slug>`
    // never reaches the REVIEWS.md frontmatter as a `pinned` value.
    const NL = String.fromCharCode(10);
    const hostile = `gemini-3-pro${NL}reviewers: [forged]`;
    const p = plan('gemini', { 'review.models.gemini': hostile });
    assert.equal(p.model, hostile, 'the pre-existing configString gate is unchanged — out of scope here');
    const d = deps({ spawn: () => ({ status: 0, stdout: 'a review citing src/x.ts:10', stderr: '' }) });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, UNRESOLVED_MODEL, 'refused at the recordedModel choke point, not silently rewritten');
  });
});

describe('#2295 — resolveLanePlan records effort only when it actually expanded', () => {
  test('effortArgs + effortValue on an argv-effort-channel lane sets plan.effort', () => {
    const lane = REVIEWER_LANES.find((l) => l.slug === 'codex');
    assert.equal(lane.invoke.effortChannel, 'argv');
    const r = resolveLanePlan({
      lane,
      configGet: () => undefined,
      runDir: RUN,
      repoRoot: ROOT,
      effortArgs: ['-c', 'model_reasoning_effort=low'],
      effortValue: 'low',
    });
    assert.equal(r.ok, true);
    assert.equal(r.plan.effort, 'low');
  });

  test('the same lane with an empty effortArgs records no effort', () => {
    const lane = REVIEWER_LANES.find((l) => l.slug === 'codex');
    const r = resolveLanePlan({
      lane,
      configGet: () => undefined,
      runDir: RUN,
      repoRoot: ROOT,
      effortArgs: [],
      effortValue: 'low',
    });
    assert.equal(r.ok, true);
    assert.equal(r.plan.effort, null);
  });

  test('a lane whose effortChannel is not argv records no effort, even with an effortValue passed', () => {
    const lane = REVIEWER_LANES.find((l) => l.slug === 'gemini');
    assert.equal(lane.invoke.effortChannel, 'none', 'gemini must declare no argv effort channel for this test to be meaningful');
    const r = resolveLanePlan({
      lane,
      configGet: () => undefined,
      runDir: RUN,
      repoRoot: ROOT,
      effortArgs: ['-c', 'model_reasoning_effort=low'],
      effortValue: 'low',
    });
    assert.equal(r.ok, true);
    assert.equal(r.plan.effort, null);
  });
});

describe('#2295 — the recorded model carries an applied reasoning effort', () => {
  /** A plan with an effort really expanded into argv, built the same way `resolveLanePlan` is in production. */
  function planWithEffort(slug, config, effortValue) {
    const lane = REVIEWER_LANES.find((l) => l.slug === slug);
    const r = resolveLanePlan({
      lane,
      configGet: (k) => config[k],
      runDir: RUN,
      repoRoot: ROOT,
      effortArgs: ['--effort', effortValue],
      effortValue,
    });
    assert.equal(r.ok, true, `${slug} failed to resolve`);
    return r.plan;
  }

  test('a lane with no applied effort records the bare model id, unchanged (regression guard)', async () => {
    const p = plan('gemini', { 'review.models.gemini': 'gemini-3-pro' });
    assert.equal(p.effort, null);
    const d = deps({ spawn: () => ({ status: 0, stdout: 'a review with src/x.ts:10 evidence', stderr: '' }) });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'gemini-3-pro', source: MODEL_SOURCE.PINNED });
  });

  test('a pinned codex model plus an applied effort records "o4-mini (reasoning=low)"', async () => {
    const p = planWithEffort('codex', { 'review.models.codex': 'o4-mini' }, 'low');
    const d = deps({
      spawn: () => ({ status: 0, stdout: '', stderr: '' }),
      files: { [p.outputTarget.path]: 'a review citing src/x.ts:10' },
    });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'o4-mini (reasoning=low)', source: MODEL_SOURCE.PINNED });
  });

  test('a banner-recovered model plus an applied effort records "gpt-5.6-sol (reasoning=low)"', async () => {
    const p = planWithEffort('codex', {}, 'low');
    const d = deps({
      spawn: () => ({ status: 0, stdout: 'model: gpt-5.6-sol', stderr: '' }),
      files: { [p.outputTarget.path]: 'a review citing src/x.ts:10' },
    });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'gpt-5.6-sol (reasoning=low)', source: MODEL_SOURCE.BANNER });
  });

  test('an applied effort with no recoverable model still records UNRESOLVED_MODEL — never a bare (reasoning=low)', async () => {
    const p = planWithEffort('codex', {}, 'low');
    const d = deps({
      spawn: () => ({ status: 0, stdout: 'no banner line here', stderr: '' }),
      files: { [p.outputTarget.path]: 'a review citing src/x.ts:10' },
    });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, UNRESOLVED_MODEL);
  });

  test('an effort value carrying a control character is refused — bare model id, no suffix', async () => {
    const NL = String.fromCharCode(10);
    const p = planWithEffort('codex', { 'review.models.codex': 'o4-mini' }, `low${NL}evil`);
    const d = deps({
      spawn: () => ({ status: 0, stdout: '', stderr: '' }),
      files: { [p.outputTarget.path]: 'a review citing src/x.ts:10' },
    });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'o4-mini', source: MODEL_SOURCE.PINNED });
  });
});

describe('#2295 — antigravity recovers its model from transcript_full.jsonl', () => {
  const CONV = 'conv-1';
  const settings = (m) => JSON.stringify({ type: 'SETTINGS', model: m });
  const response = (c) => JSON.stringify({ source: 'MODEL', status: 'DONE', type: 'PLANNER_RESPONSE', content: c });

  /** deps with both transcripts seeded; `full` is the transcript_full body. */
  const agyDeps = (full, { tx = '', cache = { [ROOT]: CONV } } = {}) =>
    deps({
      files: {
        [CACHE]: JSON.stringify(cache),
        [txPath(CONV)]: tx,
        [fullPath(CONV)]: full,
      },
      spawn: () => ({ status: 0, stdout: 'a review citing src/x.ts:10', stderr: '' }),
    });

  test("a settings entry written AFTER the watermark is this run's model", async () => {
    const before = settings('Gemini 3.5 Flash (Medium)');
    const d = agyDeps(before);
    // The watermark is taken pre-spawn; the spawn appends the real settings line.
    d.spawn = () => {
      d.files[fullPath(CONV)] = [before, settings('Gemini 3.5 Pro')].join('\n');
      return { status: 0, stdout: 'a review citing src/x.ts:10', stderr: '' };
    };
    const r = await runLane(plan('antigravity'), d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'Gemini 3.5 Pro', source: MODEL_SOURCE.TRANSCRIPT });
  });

  test("a same-session PRE-watermark entry is accepted — the session model is still this run's", async () => {
    // Deliberately looser than the review body's staleness rule, and for a stated reason:
    // last_conversations.json is keyed by WORKSPACE, so a matching conv-id means agy reused the
    // same session. That session's model IS the model this run ran under. A strict
    // post-watermark-only scan would report `unknown` for most real runs.
    const r = await runLane(plan('antigravity'), agyDeps(settings('Gemini 3.5 Flash (Medium)')), { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'Gemini 3.5 Flash (Medium)', source: MODEL_SOURCE.TRANSCRIPT });
  });

  test('an unreadable full transcript declines rather than guessing', async () => {
    // #3118's fail-closed shape, applied to the model arm: a file that indisputably exists but
    // could not be read is not the same fact as an absent one.
    const d = agyDeps(settings('Gemini 3.5 Pro'));
    const realRead = d.readFile;
    d.readFile = (p) => {
      if (p === fullPath(CONV)) throw new Error('EACCES');
      return realRead(p);
    };
    const r = await runLane(plan('antigravity'), d, { repoRoot: ROOT });
    assert.deepEqual(r.model, UNRESOLVED_MODEL);
  });

  test('a read failure never fails the lane — the review is still written', async () => {
    const d = agyDeps(settings('Gemini 3.5 Pro'));
    const realRead = d.readFile;
    d.readFile = (p) => {
      if (p === fullPath(CONV)) throw new Error('EACCES');
      return realRead(p);
    };
    const p = plan('antigravity');
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.equal(r.ok, true);
    assert.ok(d.files[p.reviewPath], 'the review must still land on disk');
  });

  test('an absent cache, an absent transcript and a corrupt cache all yield unknown', async () => {
    const noCache = deps({ spawn: () => ({ status: 0, stdout: 'a review citing src/x.ts:10', stderr: '' }) });
    assert.deepEqual((await runLane(plan('antigravity'), noCache, { repoRoot: ROOT })).model, UNRESOLVED_MODEL);

    const noTx = deps({
      files: { [CACHE]: JSON.stringify({ [ROOT]: CONV }) },
      spawn: () => ({ status: 0, stdout: 'a review citing src/x.ts:10', stderr: '' }),
    });
    assert.deepEqual((await runLane(plan('antigravity'), noTx, { repoRoot: ROOT })).model, UNRESOLVED_MODEL);

    for (const corrupt of ['null', '[]', '{not json']) {
      const d = deps({
        files: { [CACHE]: corrupt, [fullPath(CONV)]: settings('never-read') },
        spawn: () => ({ status: 0, stdout: 'a review citing src/x.ts:10', stderr: '' }),
      });
      assert.deepEqual(
        (await runLane(plan('antigravity'), d, { repoRoot: ROOT })).model,
        UNRESOLVED_MODEL,
        `corrupt cache ${corrupt}`,
      );
    }
  });

  test('the workspace lookup stays case-insensitive', async () => {
    const d = agyDeps(settings('Gemini 3.5 Pro'), { cache: { [ROOT.toUpperCase()]: CONV } });
    const r = await runLane(plan('antigravity'), d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'Gemini 3.5 Pro', source: MODEL_SOURCE.TRANSCRIPT });
  });

  test('a pinned agy model short-circuits the transcript arm entirely', async () => {
    const d = agyDeps(settings('Gemini 3.5 Flash (Medium)'));
    const p = plan('antigravity', { 'review.models.agy': 'Gemini 3.5 Pro' });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'Gemini 3.5 Pro', source: MODEL_SOURCE.PINNED });
  });

  test('a transcript whose only entries are responses yields unknown', async () => {
    const r = await runLane(plan('antigravity'), agyDeps(response('a review')), { repoRoot: ROOT });
    assert.deepEqual(r.model, UNRESOLVED_MODEL);
  });
});

describe('#2295 — openai-http reports what the server actually served', () => {
  const httpDeps = (body, { status = 200, ok = true, models } = {}) =>
    deps({
      httpJson: async (url) =>
        url.endsWith('/v1/models')
          ? { ok: true, status: 200, body: JSON.stringify({ data: models ? [{ id: models }] : [] }) }
          : { ok, status, body },
    });

  const completion = (extra) => JSON.stringify({
    ...extra,
    choices: [{ message: { content: 'a review citing src/x.ts:10' } }],
  });

  test('a served model is recorded as served', async () => {
    const d = httpDeps(completion({ model: 'llama3:70b' }), { models: 'llama3:8b' });
    const r = await runLane(plan('ollama'), d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'llama3:70b', source: MODEL_SOURCE.SERVED });
  });

  test('served outranks pinned AND the existing mismatch warning still fires', async () => {
    const d = httpDeps(completion({ model: 'llama3:70b' }));
    const r = await runLane(plan('ollama', { 'review.models.ollama': 'llama3:8b' }), d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'llama3:70b', source: MODEL_SOURCE.SERVED },
      'what actually ran beats what was asked for');
    assert.ok(d.warnings.some((w) => w.includes('served model')), 'the ADR-2782 mismatch warning must survive');
  });

  test('a discovered model with no served echo is recorded as requested', async () => {
    const d = httpDeps(completion({}), { models: 'llama3:8b' });
    const r = await runLane(plan('ollama'), d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'llama3:8b', source: MODEL_SOURCE.REQUESTED });
  });

  test('the declared fallbackModel is recorded as requested when discovery finds nothing', async () => {
    const d = httpDeps(completion({}));
    const p = plan('ollama');
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: p.fallbackModel, source: MODEL_SOURCE.REQUESTED });
  });

  test('an unparseable body still records what was requested', async () => {
    const d = httpDeps('<html>502 Bad Gateway</html>', { models: 'llama3:8b' });
    const r = await runLane(plan('ollama'), d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'llama3:8b', source: MODEL_SOURCE.REQUESTED });
  });

  test('an http failure with an empty body still records what was requested', async () => {
    const d = httpDeps('', { ok: false, status: 500, models: 'llama3:8b' });
    const r = await runLane(plan('ollama'), d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'llama3:8b', source: MODEL_SOURCE.REQUESTED });
  });

  test('a non-string served model is ignored, never coerced', async () => {
    const d = httpDeps(completion({ model: 42 }), { models: 'llama3:8b' });
    const r = await runLane(plan('ollama'), d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'llama3:8b', source: MODEL_SOURCE.REQUESTED });
  });

  test('a server echoing a control-character-bearing model falls back to requested, never a forged served value', async () => {
    // The sharpest reach of this defect: an OpenAI-compatible server is REMOTE-controlled, and its
    // response body's `model` field lands verbatim in REVIEWS.md frontmatter as `served` unless
    // refused at the same choke point as every other arm.
    const NL = String.fromCharCode(10);
    const d = httpDeps(completion({ model: `llama3:70b${NL}reviewers: [forged]` }), { models: 'llama3:8b' });
    const r = await runLane(plan('ollama'), d, { repoRoot: ROOT });
    assert.deepEqual(r.model, { value: 'llama3:8b', source: MODEL_SOURCE.REQUESTED });
  });
});

describe('#2295 — properties (pinned seed, bounded runs)', () => {
  /** Deterministic: pinned seed, bounded runs, replay data printed on failure. */
  const FC = { seed: 2295, numRuns: 300 };

  const wellFormed = (v) =>
    v === null || (typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= MODEL_VALUE_MAX);

  test('parseModelBanner is total and its output is always well-formed', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.string({ unit: 'grapheme' }),
          fc.array(fc.string(), { maxLength: 60 }).map((a) => a.join('\n')),
        ),
        (input) => wellFormed(parseModelBanner(input)),
      ),
      FC,
    );
  });

  test('parseTranscriptModel is total and its output is always well-formed', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.array(fc.jsonValue(), { maxLength: 20 }).map((vs) => vs.map((v) => JSON.stringify(v)).join('\n')),
        ),
        (input) => wellFormed(parseTranscriptModel(input)),
      ),
      FC,
    );
  });

  test('every reported spawn model satisfies the value-source biconditional', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('gemini', 'codex', 'antigravity', 'cursor', 'coderabbit'),
        fc.option(fc.string(), { nil: undefined }),
        fc.string(),
        (slug, configured, stdout) => {
          const lane = REVIEWER_LANES.find((l) => l.slug === slug);
          const key = lane.modelConfigKey;
          const r = resolveLanePlan({
            lane,
            configGet: (k) => (key && k === key ? configured : undefined),
            runDir: RUN,
            repoRoot: ROOT,
          });
          if (!r.ok) return true;
          const reported = resolveSpawnModel(
            r.plan,
            { stdout, stderr: '' },
            { convId: '', lines: 0, fullLines: 0 },
            deps(),
            ROOT,
          );
          const isUnknown = reported.source === MODEL_SOURCE.UNKNOWN;
          return isUnknown === (reported.value === null) && wellFormed(reported.value);
        },
      ),
      FC,
    );
  });
});

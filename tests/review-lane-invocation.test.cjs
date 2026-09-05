/**
 * Reviewer lane invocation — the resolver (ADR-2782 Phase 5b, #2799).
 *
 * THE GOLDEN TABLE IS THE POINT OF THIS FILE. Phase 5b deleted ~640 lines of hand-authored per-CLI
 * bash, and every one of those legs encoded a hard-won fix (#2494/#2605 empty output, #1698 Codex
 * stdout teardown noise, #1936 OpenCode zero-output turns, #2073 Antigravity's three modes, #2176
 * repo-root anchoring, #2589 no jq on stock Windows, #2794 Qwen's missing sidecar). Old and new
 * cannot literally run in parallel, so the golden table below IS the strangler-fig substitute: each
 * row is the invocation the bash leg produced, and the resolver must reproduce it exactly.
 *
 * The rows were derived FROM THE LEGS, not from the descriptor types. That direction matters — a
 * table written from the types would agree with the resolver by construction and prove nothing.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const {
  REVIEWER_LANES,
} = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const {
  resolveLanePlan,
  resolveLaneEffort,
  resolveTimeoutMs,
  isEmptyReview,
  normalizeHost,
  fileRefPrompt,
  LANE_UNAVAILABLE,
} = require('../gsd-core/bin/lib/review-lane-invocation.cjs');

const RUN = '/run';
const ROOT = '/repo';
const REVIEW_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'review.md');

/** Deterministic property runs — pinned seed, bounded, replay printed on failure. */
const FC = { seed: 42, numRuns: 200 };

/** Config with every model key set, so the model-bearing rows exercise the configured branch. */
const FULL_CONFIG = {
  'review.models.gemini': 'G',
  'review.models.claude': 'C',
  'review.models.codex': 'X',
  'review.models.opencode': 'O',
  'review.models.cursor': 'U',
  'review.models.agy': 'A',
  'review.models.kimi-code': 'K',
  'review.models.ollama': 'M',
  'review.models.lm_studio': 'M',
  'review.models.llama_cpp': 'M',
};

function resolve(slug, { config = FULL_CONFIG, effortArgs = ['--effort', 'high'] } = {}) {
  const lane = REVIEWER_LANES.find((l) => l.slug === slug);
  assert.ok(lane, `no declared lane '${slug}'`);
  return resolveLanePlan({
    lane,
    configGet: (k) => config[k],
    runDir: RUN,
    repoRoot: ROOT,
    effortArgs,
  });
}

const FILE_REF = fileRefPrompt(`${RUN}/gsd-review-prompt.md`, ROOT);

/**
 * One row per shipped lane: the exact argv its bash leg produced, with a model configured and
 * effort available. `stdin` is the prompt path for a stdin lane, `null` otherwise.
 */
const GOLDEN = [
  { slug: 'gemini', binary: 'gemini', argv: ['-m', 'G', '-p', '-'], stdin: true, out: 'stdout', timeout: 900000 },
  { slug: 'claude', binary: 'claude', argv: ['--model', 'C', '--effort', 'high', '-p', '-'], stdin: true, out: 'stdout', timeout: 1200000 },
  {
    slug: 'codex',
    binary: 'codex',
    // `exec` is a SUBCOMMAND and must stay first; the output file lands mid-argv and the bare `-`
    // stays last. Splicing injected flags positionally produced an invalid invocation.
    argv: ['exec', '--ephemeral', '--model', 'X', '--effort', 'high', '--skip-git-repo-check', '-o', `${RUN}/gsd-review-codex.md`, '-'],
    stdin: true, out: 'file', timeout: 1200000,
  },
  { slug: 'coderabbit', binary: 'coderabbit', argv: ['review', '--prompt-only'], stdin: false, out: 'stdout', timeout: 360000 },
  { slug: 'opencode', binary: 'opencode', argv: ['run', '--model', 'O', '--effort', 'high', '--format', 'json', '-'], stdin: true, out: 'stdout', timeout: 660000 },
  { slug: 'qwen', binary: 'qwen', argv: ['-'], stdin: true, out: 'stdout', timeout: 900000 },
  { slug: 'cursor', binary: 'cursor-agent', argv: ['-p', '--model', 'U', '--mode', 'ask', '--trust', '--output-format', 'text', FILE_REF], stdin: false, out: 'stdout', timeout: 900000 },
  // resolveLanePlan fully resolves {{nativeTimeout}} itself (#3274) — this row proves the
  // unconfigured default reproduces the original literal exactly.
  { slug: 'antigravity', binary: 'agy', argv: ['--print-timeout', '540s', '--model', 'A', '-p', FILE_REF], stdin: false, out: 'stdout', timeout: 600000 },
  { slug: 'kimi-code', binary: 'kimi', argv: ['-m', 'K', '-p', FILE_REF], stdin: false, out: 'stdout', timeout: 900000 },
];

describe('reviewer lane invocation — golden plans (the strangler-fig contract)', () => {
  for (const row of GOLDEN) {
    test(`${row.slug} resolves to its shipped invocation`, () => {
      const r = resolve(row.slug);
      assert.equal(r.ok, true, `${row.slug}: ${r.ok ? '' : r.detail}`);
      const p = r.plan;
      assert.equal(p.transport, 'spawn');
      assert.equal(p.binary, row.binary);
      assert.deepStrictEqual(p.argv, row.argv);
      assert.equal(p.stdin, row.stdin ? `${RUN}/gsd-review-prompt.md` : null);
      assert.equal(p.outputTarget.kind, row.out === 'file' ? 'file' : 'stdout');
      assert.equal(p.timeoutMs, row.timeout);
      // The stderr sidecar is never /dev/null — that is what makes a failed lane diagnosable.
      assert.equal(p.errPath, `${RUN}/gsd-review-${row.slug}.err`);
      assert.equal(p.reviewPath, `${RUN}/gsd-review-${row.slug}.md`);
    });
  }

  test('the golden table covers every spawn lane', () => {
    const spawnSlugs = REVIEWER_LANES.filter((l) => l.transport === 'spawn').map((l) => l.slug).sort();
    assert.deepStrictEqual(GOLDEN.map((g) => g.slug).sort(), spawnSlugs);
  });

  test('the three OpenAI-compatible lanes resolve host, endpoint and discovery', () => {
    for (const [slug, host, fallback] of [
      ['ollama', 'http://localhost:11434', 'llama3'],
      ['lm_studio', 'http://localhost:1234', 'local-model'],
      ['llama_cpp', 'http://localhost:8080', 'local-model'],
    ]) {
      const r = resolve(slug, { config: {} });
      assert.equal(r.ok, true);
      assert.equal(r.plan.transport, 'openai-http');
      // Phase 4 federated every *_host with a default of "", so an unset key MUST fall back to the
      // lane's declared defaultHost or the lane would POST to a garbage URL.
      assert.equal(r.plan.host, host);
      assert.equal(r.plan.url, `${host}/v1/chat/completions`);
      assert.equal(r.plan.modelsUrl, `${host}/v1/models`);
      assert.equal(r.plan.fallbackModel, fallback);
    }
  });

  test('every declared lane resolves — none is left unroutable', () => {
    for (const lane of REVIEWER_LANES) {
      assert.equal(resolve(lane.slug).ok, true, `${lane.slug} failed to resolve`);
    }
  });
});

describe('#3274 — timeoutConfigKey resolves the outer wall-clock cap', () => {
  const AGY_FLOOR = REVIEWER_LANES.find((l) => l.slug === 'antigravity').timeoutFloorMs;
  const AGY_KEY = REVIEWER_LANES.find((l) => l.slug === 'antigravity').timeoutConfigKey;

  test('an absent config key falls back to timeoutFloorMs (row 1)', () => {
    const r = resolve('antigravity', { config: {} });
    assert.equal(r.plan.timeoutMs, AGY_FLOOR);
  });

  test('a configured positive number overrides timeoutFloorMs, seconds -> ms (row 2)', () => {
    const r = resolve('antigravity', { config: { [AGY_KEY]: 900 } });
    assert.equal(r.plan.timeoutMs, 900_000);
  });

  test('0 is treated as unset, not a zero-length timeout (row 3)', () => {
    const r = resolve('antigravity', { config: { [AGY_KEY]: 0 } });
    assert.equal(r.plan.timeoutMs, AGY_FLOOR);
  });

  test('a negative configured timeout is treated as unset (row 4)', () => {
    const r = resolve('antigravity', { config: { [AGY_KEY]: -5 } });
    assert.equal(r.plan.timeoutMs, AGY_FLOOR);
  });

  test('NaN and Infinity are treated as unset (row 5)', () => {
    assert.equal(resolve('antigravity', { config: { [AGY_KEY]: NaN } }).plan.timeoutMs, AGY_FLOOR);
    assert.equal(resolve('antigravity', { config: { [AGY_KEY]: Infinity } }).plan.timeoutMs, AGY_FLOOR);
  });

  test('a non-number configured value is never coerced, falls back (row 6)', () => {
    for (const bad of ['900', true, {}, [], 'null']) {
      const r = resolve('antigravity', { config: { [AGY_KEY]: bad } });
      assert.equal(r.plan.timeoutMs, AGY_FLOOR, `value ${JSON.stringify(bad)} must not resolve to a timeout`);
    }
  });

  test('a lane with no timeoutConfigKey field falls back like an unset key (row 7)', () => {
    const lane = { ...REVIEWER_LANES.find((l) => l.slug === 'gemini') };
    delete lane.timeoutConfigKey;
    const r = resolveLanePlan({ lane, configGet: () => 900, runDir: RUN, repoRoot: ROOT });
    assert.equal(r.ok, true);
    assert.equal(r.plan.timeoutMs, lane.timeoutFloorMs);
  });

  test('resolveTimeoutMs: direct unit — unset falls back to floorMs', () => {
    assert.equal(resolveTimeoutMs(null, 5000, () => undefined), 5000);
    assert.equal(resolveTimeoutMs('some.key', 5000, () => undefined), 5000);
  });

  test('resolveTimeoutMs: direct unit — configured value overrides, seconds -> ms', () => {
    assert.equal(resolveTimeoutMs('some.key', 5000, (k) => (k === 'some.key' ? 30 : undefined)), 30000);
  });

  test('boundary: 0 vs 1 vs a fractional second (row 8)', () => {
    assert.equal(resolve('antigravity', { config: { [AGY_KEY]: 0 } }).plan.timeoutMs, AGY_FLOOR);
    assert.equal(resolve('antigravity', { config: { [AGY_KEY]: 1 } }).plan.timeoutMs, 1000);
    assert.equal(resolve('antigravity', { config: { [AGY_KEY]: 0.5 } }).plan.timeoutMs, 500);
  });

  test("a non-antigravity lane's configured timeout does not touch argv (row 13)", () => {
    const key = REVIEWER_LANES.find((l) => l.slug === 'gemini').timeoutConfigKey;
    const unset = resolve('gemini', { config: {} });
    const configured = resolve('gemini', { config: { [key]: 300 } });
    assert.deepStrictEqual(configured.plan.argv, unset.plan.argv);
    assert.notEqual(configured.plan.timeoutMs, unset.plan.timeoutMs);
  });

  test('property: any positive-second config resolves to exactly seconds * 1000 ms (row 20)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seconds) => {
        const r = resolve('antigravity', { config: { [AGY_KEY]: seconds } });
        assert.equal(r.plan.timeoutMs, seconds * 1000);
      }),
      FC,
    );
  });

  test('property: any hostile config value degrades to timeoutFloorMs, never throws (row 21)', () => {
    const hostile = fc.oneof(
      fc.string(),
      fc.boolean(),
      fc.object(),
      fc.array(fc.anything()),
      fc.constant(0),
      fc.integer({ max: 0 }),
      fc.constant(NaN),
      fc.constant(Infinity),
      fc.constant(-Infinity),
    );
    fc.assert(
      fc.property(hostile, (value) => {
        const r = resolve('antigravity', { config: { [AGY_KEY]: value } });
        assert.equal(r.ok, true);
        assert.equal(r.plan.timeoutMs, AGY_FLOOR);
      }),
      FC,
    );
  });

  test('a configured antigravity timeout derives both the outer cap and the native flag (row 10)', () => {
    const r = resolve('antigravity', { config: { [AGY_KEY]: 900 } });
    assert.equal(r.plan.timeoutMs, 900_000);
    const i = r.plan.argv.indexOf('--print-timeout');
    assert.equal(r.plan.argv[i + 1], '840s');
  });

  test('a native timeout below the 60s buffer clamps to 1s, never 0 or negative (row 11)', () => {
    const r = resolve('antigravity', { config: { [AGY_KEY]: 30 } });
    const i = r.plan.argv.indexOf('--print-timeout');
    assert.equal(r.plan.argv[i + 1], '1s');
  });

  test('boundary around the 60-second native buffer (row 12)', () => {
    const nativeFor = (seconds) => {
      const r = resolve('antigravity', { config: { [AGY_KEY]: seconds } });
      return r.plan.argv[r.plan.argv.indexOf('--print-timeout') + 1];
    };
    assert.equal(nativeFor(59), '1s');   // floor(59)-60 = -1 -> clamped
    assert.equal(nativeFor(60), '1s');   // floor(60)-60 = 0 -> clamped
    assert.equal(nativeFor(61), '1s');   // floor(61)-60 = 1
    assert.equal(nativeFor(121), '61s'); // floor(121)-60 = 61
  });
});

describe('reviewer lane invocation — model resolution', () => {
  test("antigravity resolves its model from review.models.agy, not the slug", () => {
    // The regression this locks: antigravity's slug is `antigravity` but its shipped key is
    // `review.models.agy`. A `review.models.<slug>` convention misses it and silently ignores a
    // configured model — disabling the pinned-model escape hatch #2073 added for a 404ing default.
    const r = resolve('antigravity', { config: { 'review.models.agy': 'agy-2' } });
    assert.ok(r.plan.argv.includes('agy-2'), 'the configured agy model must reach argv');

    const wrongKey = resolve('antigravity', { config: { 'review.models.antigravity': 'nope' } });
    assert.ok(!wrongKey.plan.argv.includes('nope'), 'the slug-derived key must NOT be consulted');
  });

  test('a lane declaring no model key emits no model argument', () => {
    for (const slug of ['qwen', 'coderabbit']) {
      const lane = REVIEWER_LANES.find((l) => l.slug === slug);
      assert.equal(lane.modelConfigKey, null, `${slug} should declare no model key`);
      const r = resolve(slug, { config: { 'review.models.qwen': 'X' } });
      assert.ok(!r.plan.argv.includes('X'));
    }
  });

  test('cursor now declares a model key and arg (#3653) — no longer null', () => {
    const lane = REVIEWER_LANES.find((l) => l.slug === 'cursor');
    assert.equal(lane.modelConfigKey, 'review.models.cursor');
    assert.equal(lane.invoke.modelArg, '--model');
  });

  test('an unconfigured cursor lane invokes exactly as it does today (#3653, byte-identical)', () => {
    const r = resolve('cursor', { config: {} });
    assert.deepStrictEqual(
      r.plan.argv,
      ['-p', '--mode', 'ask', '--trust', '--output-format', 'text', r.plan.argv[r.plan.argv.length - 1]],
    );
  });

  test('a configured review.models.cursor reaches --model, positioned right after -p (#3653)', () => {
    const r = resolve('cursor', { config: { 'review.models.cursor': 'cursor-grok-4.5-high' } });
    const i = r.plan.argv.indexOf('-p');
    assert.equal(r.plan.argv[i + 1], '--model');
    assert.equal(r.plan.argv[i + 2], 'cursor-grok-4.5-high');
  });

  test('unset, empty, whitespace and the literal string "null" all mean unconfigured', () => {
    // `"null"` is the four literal characters `config-get --raw` prints for a missing key — every
    // bash leg tested for it. A config written by an older workflow can still contain it.
    for (const bad of [undefined, null, '', '   ', 'null', 'undefined']) {
      const r = resolve('gemini', { config: { 'review.models.gemini': bad } });
      assert.deepStrictEqual(r.plan.argv, ['-p', '-'], `${JSON.stringify(bad)} must not reach argv`);
    }
  });

  test('a non-string model value is never coerced into argv', () => {
    // String(0) would put "0" in as a model name. A wrong model silently reviewed is worse than no
    // override at all.
    for (const bad of [0, 1, true, false, [], {}, ['a']]) {
      const r = resolve('gemini', { config: { 'review.models.gemini': bad } });
      assert.deepStrictEqual(r.plan.argv, ['-p', '-'], `${JSON.stringify(bad)} must not reach argv`);
    }
  });

  test('shell metacharacters in a model value stay a single inert argv element', () => {
    const hostile = '; rm -rf /; $(whoami) `id` && echo "x"';
    const r = resolve('gemini', { config: { 'review.models.gemini': hostile } });
    assert.deepStrictEqual(r.plan.argv, ['-m', hostile, '-p', '-']);
    // Nothing here builds a shell string; the runner spawns with shell:false and an argv array.
    assert.equal(r.plan.argv.filter((a) => a === hostile).length, 1);
  });

  test('effort argv only reaches lanes declaring effortChannel argv', () => {
    for (const lane of REVIEWER_LANES.filter((l) => l.transport === 'spawn')) {
      const r = resolve(lane.slug, { effortArgs: ['--effort', 'xhigh'] });
      const got = r.plan.argv.includes('--effort');
      assert.equal(got, lane.invoke.effortChannel === 'argv', `${lane.slug} effort mismatch`);
    }
  });
});

describe('reviewer lane invocation — argv-file-ref anchoring (#2176)', () => {
  test('the file-ref prompt names the prompt file AND the absolute repo root', () => {
    // Without the root, an argv-fed CLI does not reliably inherit the review cwd and reviews the
    // plan text in isolation — exactly what the Review Instructions forbid.
    for (const slug of ['cursor', 'antigravity', 'kimi-code']) {
      const r = resolve(slug);
      const arg = r.plan.argv[r.plan.argv.length - 1];
      assert.ok(arg.includes(`${RUN}/gsd-review-prompt.md`), `${slug} must name the prompt file`);
      assert.ok(arg.includes(ROOT), `${slug} must carry the absolute repo root`);
    }
  });

  test('the prompt travels in argv as ONE element, never split', () => {
    const r = resolve('cursor');
    assert.equal(r.plan.argv.filter((a) => a.includes('gsd-review-prompt.md')).length, 1);
  });
});

describe('reviewer lane invocation — absent-safe and hostile input (ADR-2782 D4)', () => {
  const bad = (lane) =>
    resolveLanePlan({ lane, configGet: () => undefined, runDir: RUN, repoRoot: ROOT });

  test('a malformed lane is reported, never thrown on', () => {
    for (const v of [null, undefined, 42, 'gemini', [], true]) {
      const r = bad(v);
      assert.equal(r.ok, false);
      assert.equal(r.reason, LANE_UNAVAILABLE.MALFORMED_LANE);
    }
  });

  test('an unknown handler fails CLOSED', () => {
    // D4 rule 4. A lane naming imperative code this version does not have cannot run "mostly" —
    // the handler is precisely the part data could not express.
    const lane = { ...REVIEWER_LANES[0], handler: 'not-a-real-handler' };
    const r = bad(lane);
    assert.equal(r.ok, false);
    assert.equal(r.reason, LANE_UNAVAILABLE.UNKNOWN_HANDLER);
  });

  test('every handler the descriptor ships is dispatchable', () => {
    // The inverse of the above: a lane declaring a handler the runner cannot dispatch would fail
    // closed at runtime, which is a silent lane loss dressed as a safety feature.
    for (const lane of REVIEWER_LANES) {
      assert.equal(resolve(lane.slug).ok, true, `${lane.slug} handler not dispatchable`);
    }
  });

  test('an unknown transport is reported', () => {
    const r = bad({ ...REVIEWER_LANES[0], transport: 'carrier-pigeon' });
    assert.equal(r.reason, LANE_UNAVAILABLE.UNKNOWN_TRANSPORT);
  });

  test('a spawn lane with no binary is malformed, not a crash', () => {
    const lane = REVIEWER_LANES.find((l) => l.transport === 'spawn');
    const r = bad({ ...lane, invoke: { ...lane.invoke, binary: '' } });
    assert.equal(r.reason, LANE_UNAVAILABLE.MALFORMED_LANE);
  });

  test('file-arg output with no outputArg is malformed', () => {
    // Knowing the review lands in a file is useless without the argument naming it.
    const lane = REVIEWER_LANES.find((l) => l.slug === 'codex');
    const r = bad({ ...lane, invoke: { ...lane.invoke, outputArg: undefined } });
    assert.equal(r.reason, LANE_UNAVAILABLE.MALFORMED_LANE);
  });

  test('a prototype-key slug does not pollute the expansion table', () => {
    // `__proto__` is now rejected outright by the slug grammar (leading `_` is outside
    // `[a-z0-9]`), which is a stronger guarantee than tolerating it. `constructor` and `prototype`
    // ARE valid slugs, so they must resolve normally and still reach no prototype.
    const proto = bad({ ...REVIEWER_LANES[0], slug: '__proto__' });
    assert.equal(proto.ok, false);
    assert.equal(proto.reason, LANE_UNAVAILABLE.MALFORMED_LANE);

    for (const name of ['constructor', 'prototype']) {
      const r = bad({ ...REVIEWER_LANES[0], slug: name });
      assert.equal(r.ok, true, `${name} is a grammatically valid slug`);
      assert.equal(r.plan.slug, name);
      assert.equal(r.plan.reviewPath, `${RUN}/gsd-review-${name}.md`);
      assert.equal({}.polluted, undefined);
    }
  });

  test('an http lane resolving no host at all is malformed rather than POSTing to nowhere', () => {
    const lane = REVIEWER_LANES.find((l) => l.transport === 'openai-http');
    const r = bad({ ...lane, invoke: { ...lane.invoke, defaultHost: '' } });
    assert.equal(r.reason, LANE_UNAVAILABLE.MALFORMED_LANE);
  });

  test('an openai-http lane with no invoke object is malformed, not a crash', () => {
    // Found by adversarial review. The spawn branch guarded with `inv?.binary`; the http branch
    // dereferenced `inv.hostConfigKey` directly and THREW, breaking this module's documented
    // totality. A throw here is worse than it looks: the CLI seam resolves every selected lane in
    // one `.map`, so one malformed overlay manifest would abort the entire review.
    for (const missing of [undefined, null, 42, 'x', []]) {
      const r = bad({ ...REVIEWER_LANES.find((l) => l.transport === 'openai-http'), invoke: missing });
      assert.equal(r.ok, false, `invoke=${JSON.stringify(missing)} must not resolve`);
      assert.equal(r.reason, LANE_UNAVAILABLE.MALFORMED_LANE);
    }
  });

  test('a slug outside the declared grammar cannot reach an artifact path', () => {
    // Found by adversarial review. The slug is concatenated into reviewPath/errPath, so a lane
    // declaring `../../../tmp/evil` produced a path OUTSIDE the run dir that writeReviewOrStub
    // would write to. The grammar is checked upstream by the parity gate and the capability
    // validator, but neither runs on this path — and this module is the overlay-manifest trust
    // boundary, so it enforces its own precondition rather than inheriting one.
    const spawnLane = REVIEWER_LANES.find((l) => l.transport === 'spawn');
    for (const slug of ['../../../tmp/evil', 'a/b', 'a\\b', 'UPPER', '.hidden', '-lead', 'a b']) {
      const r = bad({ ...spawnLane, slug });
      assert.equal(r.ok, false, `slug ${JSON.stringify(slug)} must be rejected`);
      assert.equal(r.reason, LANE_UNAVAILABLE.MALFORMED_LANE);
    }
    // Every shipped slug must still pass — including the snake-case ones.
    for (const lane of REVIEWER_LANES) {
      assert.equal(resolve(lane.slug).ok, true, `${lane.slug} must remain valid`);
    }
  });

  test('the unavailability reason enum is locked', () => {
    // Adding a reason is three coordinated changes: enum, emitting site, and this assertion.
    assert.deepStrictEqual(Object.keys(LANE_UNAVAILABLE).sort(), [
      'BUDGET_TOOL_FAILED',
      'BUDGET_TOO_SMALL',
      'EGRESS_HOST_CHANGED',
      'HOST_UNREACHABLE',
      'MALFORMED_LANE',
      'MISSING_BINARY',
      'MISSING_REQUIRED_BINARY',
      'PROBE_FAILED',
      'PROBE_TIMEOUT',
      'UNKNOWN_HANDLER',
      'UNKNOWN_TRANSPORT',
    ]);
    assert.ok(Object.isFrozen(LANE_UNAVAILABLE));
  });
});

describe('reviewer lane invocation — empty-review classification', () => {
  test('whitespace-only output counts as empty on EVERY lane', () => {
    // `[ ! -s file ]` counted BYTES, so three spaces passed as a successful review. Two legs closed
    // this locally; five did not. Uniformity here is a deliberate, disclosed behaviour change.
    for (const s of ['', ' ', '   ', '\n', '\r\n', '\t', ' \n\t ']) {
      assert.equal(isEmptyReview(s), true, `${JSON.stringify(s)} must count as empty`);
    }
  });

  test('a single non-space character is a review (limit+1)', () => {
    assert.equal(isEmptyReview('x'), false);
    assert.equal(isEmptyReview(' x '), false);
  });

  test('output that is exactly -n / -e / -E is a review, not a swallowed value', () => {
    // `echo "$VAR"` would write 0 bytes for these and misclassify a real reply. Nothing in this
    // path goes through echo, so the hazard is structurally impossible — locked here anyway.
    for (const s of ['-n', '-e', '-E']) assert.equal(isEmptyReview(s), false);
  });

  test('a non-string is empty, never thrown on', () => {
    for (const v of [undefined, null, 0, {}, []]) assert.equal(isEmptyReview(v), true);
  });
});

describe('reviewer lane invocation — host normalization (D5 comparison input)', () => {
  test('cosmetic differences are NOT destination changes', () => {
    // A warning that fires on a trailing slash is a warning users learn to dismiss — which would
    // defeat the one prompt that actually matters.
    const same = [
      ['http://localhost:8080', 'http://localhost:8080/'],
      ['http://localhost:8080', 'http://LOCALHOST:8080'],
      ['http://a.com:80', 'http://a.com'],
      ['https://a.com:443', 'https://a.com'],
      ['http://a.com/v1/', 'http://a.com/v1'],
    ];
    for (const [a, b] of same) {
      assert.equal(normalizeHost(a), normalizeHost(b), `${a} vs ${b}`);
    }
  });

  test('a real destination change survives normalization', () => {
    assert.notEqual(normalizeHost('http://localhost:8080'), normalizeHost('http://evil.example'));
    assert.notEqual(normalizeHost('http://a.com:8080'), normalizeHost('http://a.com:9090'));
    assert.notEqual(normalizeHost('http://a.com'), normalizeHost('https://a.com'));
  });

  test('an unparseable host is compared verbatim, never silently rewritten', () => {
    assert.equal(normalizeHost('not a url'), 'not a url');
    assert.equal(normalizeHost(''), '');
  });

  test('a scheme-less host is not rewritten into a fake URL', () => {
    // Found by adversarial review. `new URL('localhost:11434')` PARSES — protocol `localhost:`,
    // empty hostname — so a plausible but scheme-less config value was being rewritten to
    // `localhost://11434` and then both compared and requested as if it were a real destination.
    // No hostname means it is not a URL; return it verbatim so it fails visibly.
    assert.equal(normalizeHost('localhost:11434'), 'localhost:11434');
    assert.equal(normalizeHost('example.com:8080'), 'example.com:8080');
    // A real URL still normalizes.
    assert.equal(normalizeHost('http://LocalHost:8080/'), 'http://localhost:8080');
  });
});

describe('reviewer lane invocation — properties', () => {
  test('the resolver is total over arbitrary lane input', () => {
    // Third-party overlay manifests reach this function. A resolver that throws on bad input cannot
    // report on it, and a gate that crashes is indistinguishable from one never run.
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (lane, cfgValue) => {
        let r;
        try {
          r = resolveLanePlan({
            lane,
            configGet: () => cfgValue,
            runDir: RUN,
            repoRoot: ROOT,
          });
        } catch {
          return false;
        }
        return typeof r === 'object' && r !== null && typeof r.ok === 'boolean';
      }),
      FC,
    );
  });

  test('a resolved argv never contains a placeholder token', () => {
    // An unexpanded `{{model}}` reaching a real CLI is an argument that means nothing to it.
    fc.assert(
      fc.property(
        fc.constantFrom(...REVIEWER_LANES.filter((l) => l.transport === 'spawn').map((l) => l.slug)),
        fc.option(fc.string(), { nil: undefined }),
        fc.array(fc.string(), { maxLength: 4 }),
        (slug, model, effortArgs) => {
          const lane = REVIEWER_LANES.find((l) => l.slug === slug);
          const r = resolveLanePlan({
            lane,
            configGet: () => model,
            runDir: RUN,
            repoRoot: ROOT,
            effortArgs,
          });
          if (!r.ok) return false;
          return !r.plan.argv.some((a) => /^\{\{(model|effort|output|prompt)\}\}$/.test(a));
        },
      ),
      FC,
    );
  });

  test('resolution is deterministic for identical input', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REVIEWER_LANES.map((l) => l.slug)),
        fc.option(fc.string(), { nil: undefined }),
        (slug, model) => {
          const lane = REVIEWER_LANES.find((l) => l.slug === slug);
          const input = { lane, configGet: () => model, runDir: RUN, repoRoot: ROOT };
          return JSON.stringify(resolveLanePlan(input)) === JSON.stringify(resolveLanePlan(input));
        },
      ),
      FC,
    );
  });
});

// Folded in from tests/fix-2358-review-temp-path-scoping.test.cjs (#3334 H3 test-hygiene fold-in).
//
// #2358 — review.md (and ship.md's external peer-review step) wrote every temp file to a
// hardcoded, phase-number-only path under /tmp, which two GSD projects sharing a phase number
// could collide on. The fix threads a single run-scoped `mktemp -d` directory through every
// review.md temp path.
describe('#2358 review.md temp paths are run-scoped, not phase-only', () => {
  const reviewMdContent = fs.readFileSync(REVIEW_MD, 'utf-8');

  test('no bare, unscoped /tmp/gsd-review-* path remains', () => {
    assert.ok(
      !reviewMdContent.includes('/tmp/gsd-review'),
      'review.md must not contain any hardcoded /tmp/gsd-review* literal — ' +
      'every review temp path must be rooted under the run-scoped mktemp directory'
    );
  });

  test('creates exactly one run-scoped directory via the portable ${TMPDIR:-/tmp} seam', () => {
    const mktempAssignments = reviewMdContent.match(/RUN_DIR=\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/gsd-review-XXXXXX"\)/g) || [];
    assert.equal(
      mktempAssignments.length, 1,
      'review.md must create the run directory with exactly one `mktemp -d "${TMPDIR:-/tmp}/gsd-review-XXXXXX"` — ' +
      'a hardcoded /tmp (no ${TMPDIR:-/tmp} seam) breaks on Windows, and re-mktemp-ing per block would break the ' +
      'write/read pairing between build_prompt and the local-reviewer budget-trimming reads'
    );
  });

  test('every downstream temp path is threaded through {run_dir} / $RUN_DIR, not re-derived from {phase}', () => {
    assert.ok(
      /\{run_dir\}\/gsd-review-/.test(reviewMdContent),
      'reviewer blocks must reference {run_dir}/gsd-review-... (the run-scoped placeholder)'
    );
    assert.ok(
      /\$\{RUN_DIR\}\/gsd-review-/.test(reviewMdContent),
      'the build_prompt section-file writes must reference ${RUN_DIR}/gsd-review-... (the run-scoped shell var)'
    );
    // The old isolation key must be gone entirely from path construction.
    assert.ok(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored review.md workflow, bounded prose, not adversarial input
      !/\/tmp\/gsd-review[^\r\n]*\{phase\}/.test(reviewMdContent),
      'no temp path may still be keyed on a bare {phase} placeholder'
    );
    assert.ok(
      !/\$\{PHASE\}-(?:instructions|roadmap|plan|project|context|research|requirements)\.md/.test(reviewMdContent),
      'no temp path may still be keyed on the ${PHASE} shell var'
    );
  });

  // Phase 5b (#2799) moved these strings out of review.md's bash and into the resolver and the
  // antigravity handler, so the assertions follow them. The invariant is unchanged and is what
  // #2358 was about: every reviewer artifact must live under the run-scoped mktemp directory, never
  // a bare `{phase}`-keyed /tmp path that a concurrent review could collide with.
  test('every lane anchors its prompt and artifacts under the run dir', () => {
    const RUN_2358 = '/run-scoped';
    for (const lane of REVIEWER_LANES) {
      const r = resolveLanePlan({
        lane, configGet: () => undefined, runDir: RUN_2358, repoRoot: '/repo',
      });
      assert.equal(r.ok, true, `${lane.slug} failed to resolve`);
      const p = r.plan;
      assert.ok(p.reviewPath.startsWith(`${RUN_2358}/`), `${lane.slug} review path escapes the run dir`);
      assert.ok(p.errPath.startsWith(`${RUN_2358}/`), `${lane.slug} err path escapes the run dir`);
      assert.ok(p.promptPath.startsWith(`${RUN_2358}/`), `${lane.slug} prompt path escapes the run dir`);
    }
  });

  test('the argv-borne prompt instruction references the run-scoped path', () => {
    const RUN_2358 = '/run-scoped';
    const fileRefLanes = REVIEWER_LANES.filter(
      (l) => l.transport === 'spawn' && l.invoke.promptChannel === 'argv-file-ref',
    );
    assert.ok(fileRefLanes.length > 0, 'expected at least one argv-file-ref lane');
    for (const lane of fileRefLanes) {
      const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: RUN_2358, repoRoot: '/repo' });
      const arg = r.plan.argv[r.plan.argv.length - 1];
      assert.ok(arg.includes(`${RUN_2358}/gsd-review-prompt.md`), `${lane.slug} prompt not run-scoped`);
    }
  });

  test('an instance writes under the run dir, keyed by its own identity', () => {
    // Two instances of one adapter must not overwrite each other, and neither may escape the run
    // dir — the identity is sanitized to a flat filename.
    const lane = REVIEWER_LANES.find((l) => l.slug === 'opencode');
    const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: '/run-scoped', repoRoot: '/repo' });
    assert.ok(r.plan.reviewPath.startsWith('/run-scoped/'));
  });
});

describe('#2358 design principle: run-scoped temp dirs never collide across projects/phases', () => {
  // review.md and ship.md are markdown instructions an AI agent executes, not
  // node-executable code, so this does not shell out to the literal snippet —
  // it validates the underlying guarantee the fix relies on (mktemp-style
  // randomized-suffix isolation) using Node's built-in equivalent, which is
  // cross-platform (Windows included) unlike shelling out to `mktemp`/bash.
  test('two runs — even for the same phase number, same or different project — get distinct run dirs', (t) => {
    const prefix = path.join(os.tmpdir(), 'gsd-review-');
    const runDirA = fs.mkdtempSync(prefix);
    const runDirB = fs.mkdtempSync(prefix);
    // helpers.cleanup (not raw fs.rmSync) carries the Windows-EBUSY retry budget.
    t.after(() => {
      cleanup(runDirA);
      cleanup(runDirB);
    });
    assert.notEqual(
      runDirA, runDirB,
      'two review runs sharing the same phase number must never resolve to the same run-scoped directory'
    );
    const phase = '10'; // same phase number in both "projects" — the historical collision case
    const staleProjectAPath = path.join(runDirA, `gsd-review-prompt.md`);
    const laterProjectBPath = path.join(runDirB, `gsd-review-prompt.md`);
    assert.notEqual(
      staleProjectAPath, laterProjectBPath,
      `phase ${phase} in two different runs must not resolve to the same prompt path`
    );
  });
});

describe('#4255 — lane effort comes from REVIEW config, never from another agent', () => {
  // Before this fix `review-lane plan` resolved every lane's effort by spawning
  // `query resolve-execution gsd-plan-checker --host <slug>`. The agent id was a hardcoded
  // literal, so `--host` chose only the argv RENDERING while the LEVEL always came from the
  // installed plan-checker's frontmatter — `low` under every shipped model profile. A cross-AI
  // review is the opposite workload from a fast structural verifier, the rendered argument is a
  // CLI config OVERRIDE (so it beat the effort the operator had set for that CLI), and at `low` a
  // large source-grounded prompt makes the model end its turn with no final message: the lane
  // came back empty and its stub read as a crash.
  //
  // These rows pin the replacement. `renderArgv` is injected, so they assert the RESOLUTION —
  // which level wins, and whether an argument is emitted at all — independently of any host's
  // argv syntax. The syntax itself stays pinned by the GOLDEN table above.

  /** Stand-in for the host renderer: echoes the level back in a recognisable shape. */
  const render = (host, level) => ({ argv: ['-c', `effort=${level}`], value: level });
  /** A host that declares no argv effort surface — renders nothing, as ADR-2481 requires. */
  const renderNone = () => ({ argv: [], value: null });
  const lane = (slug) => REVIEWER_LANES.find((l) => l.slug === slug);

  test('the declared default is used when nothing is configured — high on the prompt-fed lanes', () => {
    for (const slug of ['codex', 'claude', 'opencode']) {
      const r = resolveLaneEffort(lane(slug), () => undefined, render);
      assert.equal(r.value, 'high', `${slug} must default to high, not to another agent's level`);
      assert.equal(r.source, 'lane-default');
      assert.deepEqual(r.argv, ['-c', 'effort=high']);
    }
  });

  test("a lane's own config key wins over the declared default", () => {
    const r = resolveLaneEffort(lane('codex'), (k) => (k === 'review.effort.codex' ? 'xhigh' : undefined), render);
    assert.equal(r.value, 'xhigh');
    assert.equal(r.source, 'config');
  });

  test('each lane reads ONLY its own key — one lane’s effort never leaks into another', () => {
    const configGet = (k) => (k === 'review.effort.codex' ? 'minimal' : undefined);
    assert.equal(resolveLaneEffort(lane('codex'), configGet, render).value, 'minimal');
    assert.equal(resolveLaneEffort(lane('claude'), configGet, render).value, 'high',
      'claude must fall back to its OWN default, not pick up the codex key');
  });

  test('a configured `inherit` emits NO argument, so the reviewer CLI’s own config decides', () => {
    const r = resolveLaneEffort(lane('codex'), () => 'inherit', render);
    assert.deepEqual(r.argv, []);
    assert.equal(r.value, null);
    assert.equal(r.source, 'none');
  });

  test('a lane declaring no review effort at all emits no argument', () => {
    // The non-vacuity half of the row above: `none` must be reachable from the DECLARATION too,
    // not only from an explicit `inherit`. Nine shipped lanes have no effort channel to feed.
    for (const l of REVIEWER_LANES.filter((x) => x.effortConfigKey === null)) {
      const r = resolveLaneEffort(l, () => 'high', render);
      assert.deepEqual(r.argv, [], `${l.slug} declares no effort key and must emit nothing`);
      assert.equal(r.source, 'none');
    }
  });

  test('an unrecognized level is REFUSED, not forwarded to the CLI', () => {
    // Forwarding a typo renders an argument the CLI rejects, which kills the lane outright — a
    // strictly worse outcome than the level the operator meant. Fall back to the declared default.
    for (const bogus of ['hihg', 'HIGH ', 'very-high', '', '  ', 'null']) {
      const r = resolveLaneEffort(lane('codex'), () => bogus, render);
      assert.equal(r.value, 'high', `'${bogus}' must fall back to the lane default`);
      assert.equal(r.source, 'lane-default');
    }
  });

  test('a non-string configured value is ignored rather than rendered', () => {
    for (const bogus of [42, true, null, {}, ['high']]) {
      const r = resolveLaneEffort(lane('codex'), () => bogus, render);
      assert.equal(r.value, 'high', `${JSON.stringify(bogus)} must not reach the renderer`);
    }
  });

  test('the host’s negotiated surface still decides — a renderer that emits nothing yields none', () => {
    // ADR-1239/#2481's trust-boundary invariant: a lane cannot talk a host into accepting an
    // argument its negotiated effortSurface does not declare, however the lane is configured.
    const r = resolveLaneEffort(lane('codex'), () => 'xhigh', renderNone);
    assert.deepEqual(r.argv, []);
    assert.equal(r.source, 'none');
  });

  test('the documented clamp is what the catalog actually does', () => {
    // The configuration reference tells the operator which levels survive per host, and a prose
    // claim about behaviour is a claim that can rot. Pin it against the real renderer so the two
    // cannot drift. (No file is read here — the lane's clamp table IS the thing being asserted.)
    const mc = require('../gsd-core/bin/lib/model-catalog.cjs');
    const seen = {};
    for (const host of ['codex', 'claude', 'opencode']) {
      seen[host] = Object.fromEntries(
        ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
          .map((l) => [l, mc.renderEffortArgv(host, l, 'argv').value]),
      );
    }
    assert.equal(seen.codex.minimal, 'low', 'codex clamps minimal to low');
    assert.equal(seen.claude.minimal, 'low', 'claude clamps minimal to low');
    assert.equal(seen.opencode.minimal, 'minimal', 'opencode accepts minimal as-is');
    for (const host of ['codex', 'claude', 'opencode']) {
      for (const l of ['low', 'medium', 'high', 'xhigh', 'max']) {
        assert.equal(seen[host][l], l, `${host} must pass ${l} through unchanged`);
      }
    }
  });

  test('the renderer’s clamped value is recorded, not the level asked for', () => {
    // #2295 records the effort in REVIEWS.md as `model (reasoning=LEVEL)`. When a host clamps
    // (`max` -> `xhigh` on codex), the recorded level must be what actually ran.
    const clamping = () => ({ argv: ['-c', 'effort=xhigh'], value: 'xhigh' });
    const r = resolveLaneEffort(lane('codex'), () => 'max', clamping);
    assert.equal(r.value, 'xhigh', 'the clamped level is what ran, so it is what is recorded');
  });

  test('a malformed lane object degrades to no effort instead of throwing', () => {
    // The resolver is called from gsd-tools.cjs (untyped) with a lane looked up by slug, which
    // can miss. Losing one lane's effort is recoverable; a throw there takes down every lane.
    for (const bad of [null, undefined, {}, { slug: 'x' }]) {
      assert.deepEqual(resolveLaneEffort(bad, () => 'high', render).argv, []);
    }
  });

  test('resolved effort reaches argv only for lanes declaring effortChannel argv', () => {
    for (const l of REVIEWER_LANES) {
      const eff = resolveLaneEffort(l, () => undefined, render);
      const r = resolveLanePlan({
        lane: l, configGet: () => undefined, runDir: RUN, repoRoot: ROOT,
        effortArgs: eff.argv, effortValue: eff.value,
      });
      if (!r.ok || r.plan.transport !== 'spawn') continue;
      const carriesEffort = r.plan.argv.some((a) => String(a).startsWith('effort='));
      assert.equal(carriesEffort, l.invoke.effortChannel === 'argv',
        `${l.slug}: effort argv must appear exactly when the lane declares the channel`);
      assert.equal(r.plan.effort, l.invoke.effortChannel === 'argv' ? 'high' : null,
        `${l.slug}: the recorded effort must match what actually expanded`);
    }
  });
});

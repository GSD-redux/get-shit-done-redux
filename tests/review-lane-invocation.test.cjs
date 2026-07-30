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

const {
  REVIEWER_LANES,
} = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const {
  resolveLanePlan,
  isEmptyReview,
  normalizeHost,
  fileRefPrompt,
  LANE_UNAVAILABLE,
} = require('../gsd-core/bin/lib/review-lane-invocation.cjs');

const RUN = '/run';
const ROOT = '/repo';

/** Deterministic property runs — pinned seed, bounded, replay printed on failure. */
const FC = { seed: 42, numRuns: 200 };

/** Config with every model key set, so the model-bearing rows exercise the configured branch. */
const FULL_CONFIG = {
  'review.models.gemini': 'G',
  'review.models.claude': 'C',
  'review.models.codex': 'X',
  'review.models.opencode': 'O',
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
  { slug: 'cursor', binary: 'cursor-agent', argv: ['-p', '--mode', 'ask', '--trust', '--output-format', 'text', FILE_REF], stdin: false, out: 'stdout', timeout: 900000 },
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
    for (const slug of ['qwen', 'cursor', 'coderabbit']) {
      const lane = REVIEWER_LANES.find((l) => l.slug === slug);
      assert.equal(lane.modelConfigKey, null, `${slug} should declare no model key`);
      const r = resolve(slug, { config: { 'review.models.qwen': 'X', 'review.models.cursor': 'X' } });
      assert.ok(!r.plan.argv.includes('X'));
    }
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

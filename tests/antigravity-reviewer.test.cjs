/**
 * Antigravity (agy) reviewer lane — the #2073 invariants.
 *
 * These tests pinned the three real failure modes of agy 1.0.16 against the hand-authored bash
 * block in `gsd-core/workflows/review.md`. Phase 5b (#2799) deleted that block: the lane is now
 * declared data plus a named first-party handler, so the assertions move to those surfaces — and
 * the source-text exemption this file used to carry is no longer needed, because nothing here reads
 * a source file any more.
 *
 * The move is an upgrade, not a translation. The old tests could only prove that certain TEXT
 * appeared in a markdown fence; these prove the resolved invocation and the handler's actual
 * behaviour. Every #2073 mode below is the same invariant, checked where it now lives.
 *
 * One invariant deliberately CHANGED, and is recorded here rather than silently dropped: mode 3's
 * external `timeout`/`gtimeout` probe is gone. The bash needed it because `--print-timeout` cannot
 * fire before agy creates a session, and stock macOS ships neither killer — so on a stock Mac that
 * leg ran unbounded. The runner spawns with Node's native timeout, which is always available, so
 * the outer bound is now unconditional. The invariant ("a pre-session stall is bounded") got
 * stronger; only the mechanism changed.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
const {
  antigravityDiagnostic,
  antigravityTranscriptFallback,
  stampBlindReview,
  runLane,
} = require('../gsd-core/bin/lib/review-lane-runner.cjs');

const RUN = '/run';
const ROOT = '/repo';
const HOME = '/home/u';

const LANE = REVIEWER_LANES.find((l) => l.slug === 'antigravity');

function planFor(config = {}) {
  const r = resolveLanePlan({ lane: LANE, configGet: (k) => config[k], runDir: RUN, repoRoot: ROOT });
  assert.equal(r.ok, true);
  return r.plan;
}

function deps(overrides = {}) {
  const files = overrides.files || {};
  const warnings = [];
  return Object.assign(
    {
      files,
      warnings,
      spawn: () => ({ status: 0, stdout: '', stderr: '' }),
      httpJson: async () => ({ ok: true, status: 200, body: '{}' }),
      readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
      writeFile: (p, c) => { files[p] = c; },
      exists: (p) => p in files,
      hasBinary: () => true,
      configGet: () => undefined,
      homeDir: HOME,
      warn: (m) => warnings.push(m),
    },
    overrides,
  );
}

describe('Antigravity lane — #2073 mode 1 (exec arg-list overflow)', () => {
  test('the prompt travels by FILE REFERENCE, never inlined', () => {
    // Inline `-p "$(cat <prompt>)"` overflowed the exec arg list on a large prompt set (~197 KB),
    // failing with rc 126 in a way indistinguishable from a model failure.
    assert.equal(LANE.invoke.promptChannel, 'argv-file-ref');
    const argv = planFor().argv;
    const promptArg = argv[argv.length - 1];
    assert.ok(promptArg.includes(`${RUN}/gsd-review-prompt.md`), 'must reference the prompt file');
    assert.ok(promptArg.length < 1000, 'the reference must stay short, never carry the prompt body');
  });

  test('the prompt argument carries the absolute repo root (#2176)', () => {
    // Without the anchor agy reviews the plan text in isolation from its own scratch dir.
    const argv = planFor().argv;
    assert.ok(argv[argv.length - 1].includes(ROOT));
  });
});

describe('Antigravity lane — #2073 mode 2 (a pinned model that 404s)', () => {
  test('review.models.agy reaches argv as --model', () => {
    // The slug is `antigravity` but the shipped key is `review.models.agy`; resolving by slug
    // would silently ignore the very escape hatch this mode exists to provide.
    assert.equal(LANE.modelConfigKey, 'review.models.agy');
    const argv = planFor({ 'review.models.agy': 'gemini-x' }).argv;
    const i = argv.indexOf('--model');
    assert.ok(i !== -1, '--model must be present when the key is set');
    assert.equal(argv[i + 1], 'gemini-x');
  });

  test('no model configured emits no --model', () => {
    assert.ok(!planFor().argv.includes('--model'));
  });

  test('the diagnostic surfaces agy cli.log rather than a generic stub', () => {
    // This mode exits 0 with empty stdout AND an empty transcript — every other signal reads as a
    // clean run. The log is the only evidence there was a failure at all.
    const files = {
      [`${HOME}/.gemini/antigravity-cli/cli.log`]: [
        'routine',
        'agent executor error: Publisher model NOT_FOUND gemini-x',
      ].join('\n'),
    };
    const out = antigravityDiagnostic(deps({ files }));
    assert.ok(out.includes('NOT_FOUND'), 'the log line must be surfaced');
    assert.ok(out.includes('agy models'), 'the remedy must be named');
  });

  test('an absent log still yields the pre-session-stall tell', () => {
    const out = antigravityDiagnostic(deps());
    assert.ok(out.includes('pre-session-stall'));
    assert.ok(!out.includes('agy models'), 'no hint should be invented without evidence');
  });
});

describe('Antigravity lane — #2073 mode 3 (pre-session stall)', () => {
  test('the outer wall-clock bound is declared and unconditional', () => {
    // The bash probed for GNU `timeout` / `gtimeout` and fell back to --print-timeout alone when
    // neither existed — which is stock macOS, so that leg ran unbounded there. The bound is now
    // the plan's own timeout, enforced by the spawn on every platform.
    assert.equal(LANE.timeoutFloorMs, 600000);
    assert.equal(planFor().timeoutMs, 600000);
  });

  test('the tool-native inner timeout stays in argv', () => {
    // Two-level by design: a 600s outer cap over a 540s native --print-timeout. The descriptor
    // carries ONE scalar; the inner bound is the lane's own argument (ADR-2782 D6).
    const argv = planFor().argv;
    const i = argv.indexOf('--print-timeout');
    assert.ok(i !== -1);
    assert.equal(argv[i + 1], '540s');
  });

  test('the REVIEW spawn receives the outer bound, and every spawn is bounded', async () => {
    const p = planFor();
    const calls = [];
    const d = deps({
      spawn: (b, a, o) => { calls.push({ argv: a, opts: o }); return { status: 0, stdout: 'a review', stderr: '' }; },
    });
    await runLane(p, d, { repoRoot: ROOT });

    // The handler also spawns `agy --help` to probe --add-dir, so target the review invocation by
    // its shape rather than by position — a positional assertion silently follows the wrong call
    // the moment another probe is added.
    const review = calls.find((c) => c.argv.includes('-p'));
    assert.ok(review, 'expected a review invocation');
    assert.equal(review.opts.timeoutMs, 600000);

    for (const c of calls) {
      assert.ok(c.opts.timeoutMs > 0, `unbounded spawn: ${c.argv.join(' ')}`);
    }
  });

  test('no prompt is fed on stdin, so a tty stall is impossible', () => {
    // The bash tied stdin to /dev/null for exactly this reason.
    assert.equal(planFor().stdin, null);
  });
});

describe('Antigravity lane — transcript fallback and staleness', () => {
  const CACHE = `${HOME}/.gemini/antigravity-cli/cache/last_conversations.json`;
  const TX = (id) => `${HOME}/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`;
  const entry = (content) =>
    JSON.stringify({ source: 'MODEL', status: 'DONE', type: 'PLANNER_RESPONSE', content });

  test('the lane is handler-owned, so the generic stub cannot pre-empt the fallback', () => {
    assert.equal(LANE.emptyOutput, 'handler-owned');
    assert.equal(LANE.handler, 'antigravity');
  });

  test('a response written by THIS run is read back', () => {
    const files = {
      [CACHE]: JSON.stringify({ [ROOT]: 'c1' }),
      [TX('c1')]: [entry('old'), entry('NEW')].join('\n'),
    };
    assert.equal(antigravityTranscriptFallback(ROOT, { convId: 'c1', lines: 1 }, deps({ files })), 'NEW');
  });

  test('a response from a PRIOR run is never presented as this one', () => {
    const files = { [CACHE]: JSON.stringify({ [ROOT]: 'c1' }), [TX('c1')]: entry('STALE') };
    assert.equal(antigravityTranscriptFallback(ROOT, { convId: 'c1', lines: 1 }, deps({ files })), '');
  });

  test('a blind review is marked so consensus can down-weight it (#2176)', () => {
    assert.ok(
      stampBlindReview('REVIEWED-WITHOUT-REPO-ACCESS\nx').includes('[reviewed-without-repo-access]'),
    );
  });

  test('all three layers failing still writes a diagnosable artifact, never an empty file', async () => {
    const p = planFor();
    const d = deps({ spawn: () => ({ status: 1, stdout: '', stderr: 'boom' }) });
    const r = await runLane(p, d, { repoRoot: ROOT });
    assert.equal(r.stubbed, true);
    assert.ok(d.files[p.reviewPath].includes('failed or returned empty output'));
    assert.ok(d.files[p.reviewPath].includes('pre-session-stall'));
  });
});

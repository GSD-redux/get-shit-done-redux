/**
 * Antigravity reviewer repo-grounding (#2176).
 *
 * The agy leg once invoked the CLI without granting it the repo under review — no `--add-dir` and
 * no absolute repo-root anchor in the prompt — so the agent anchored on its own
 * `~/.gemini/antigravity-cli/scratch` dir and reviewed the plan text in isolation, which is exactly
 * what the Review Instructions forbid.
 *
 * Phase 5b (#2799) deleted that bash. Both fixes now live in the named `antigravity` handler, which
 * is where they belong: "add this flag only when the binary's --help mentions it" is a conditional,
 * and conditionals escape to a handler rather than accreting inside the descriptor (ADR-2782 D6).
 * These tests moved with them, so this file no longer reads any source text and the source-text
 * exemption it used to carry is gone.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
const {
  antigravityArgv,
  antigravityPrompt,
  stampBlindReview,
} = require('../gsd-core/bin/lib/review-lane-runner.cjs');

const RUN = '/run';
const ROOT = '/abs/repo';

function planFor(slug) {
  const lane = REVIEWER_LANES.find((l) => l.slug === slug);
  const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: RUN, repoRoot: ROOT });
  assert.equal(r.ok, true);
  return r.plan;
}

/** A spawn stub whose `--help` either advertises `--add-dir` or does not. */
const helpSaying = (text) => ({ spawn: () => ({ status: 0, stdout: text, stderr: '' }) });

describe('#2176 — agy receives the repo under review', () => {
  test('--add-dir is passed with the repo root when the binary supports it', () => {
    const p = planFor('antigravity');
    const argv = antigravityArgv(p.argv, p.promptPath, ROOT, helpSaying('--add-dir  --model'));
    const i = argv.indexOf('--add-dir');
    assert.ok(i !== -1, '--add-dir must be passed when supported');
    assert.equal(argv[i + 1], ROOT);
  });

  test('--add-dir is CAPABILITY-PROBED, not assumed', () => {
    // An older agy rejects an unknown flag outright. A lane that fails to start is worse than one
    // running on the prompt anchor alone, so support is probed rather than presumed.
    const p = planFor('antigravity');
    const argv = antigravityArgv(p.argv, p.promptPath, ROOT, helpSaying('no such flag here'));
    assert.ok(!argv.includes('--add-dir'));
  });

  test('the probe is bounded', () => {
    const p = planFor('antigravity');
    const calls = [];
    antigravityArgv(p.argv, p.promptPath, ROOT, {
      spawn: (b, a, o) => { calls.push(o); return { status: 0, stdout: '', stderr: '' }; },
    });
    assert.ok(calls.every((c) => c.timeoutMs > 0), 'every process-starting probe must be bounded');
  });

  test('adding --add-dir keeps the prompt last', () => {
    const p = planFor('antigravity');
    const argv = antigravityArgv(p.argv, p.promptPath, ROOT, helpSaying('--add-dir'));
    assert.equal(argv[argv.length - 2], '-p');
    assert.ok(argv[argv.length - 1].includes(RUN));
  });

  test('a probe that throws degrades to no flag rather than failing the lane', () => {
    const p = planFor('antigravity');
    const argv = antigravityArgv(p.argv, p.promptPath, ROOT, {
      spawn: () => { throw new Error('spawn failed'); },
    });
    assert.ok(!argv.includes('--add-dir'));
    assert.ok(argv.length > 0);
  });
});

describe('#2176 — the prompt is anchored and demands a self-report', () => {
  test('the prompt carries the ABSOLUTE repo root', () => {
    const prompt = antigravityPrompt(`${RUN}/gsd-review-prompt.md`, ROOT);
    assert.ok(prompt.includes(ROOT));
  });

  test('the prompt mandates REVIEWED-WITHOUT-REPO-ACCESS when the repo is unreadable', () => {
    // Without this clause a blind review is indistinguishable from a grounded one and its verdict
    // is counted at full consensus weight.
    const prompt = antigravityPrompt(`${RUN}/gsd-review-prompt.md`, ROOT);
    assert.ok(prompt.includes('REVIEWED-WITHOUT-REPO-ACCESS'));
  });

  test('the self-report variant actually reaches argv', () => {
    const p = planFor('antigravity');
    const argv = antigravityArgv(p.argv, p.promptPath, ROOT, helpSaying(''));
    assert.ok(argv[argv.length - 1].includes('REVIEWED-WITHOUT-REPO-ACCESS'));
  });

  test('cursor carries the same absolute-root anchor (#2176 AC5)', () => {
    // Identical gap, identical fix — cursor-agent also takes the prompt in argv and does not
    // reliably inherit the review cwd.
    const p = planFor('cursor');
    assert.ok(p.argv[p.argv.length - 1].includes(ROOT));
  });

  test('kimi-code carries it too', () => {
    const p = planFor('kimi-code');
    assert.ok(p.argv[p.argv.length - 1].includes(ROOT));
  });
});

describe('#2176 — blind-review marking', () => {
  test('a self-reported blind review is stamped', () => {
    const out = stampBlindReview('REVIEWED-WITHOUT-REPO-ACCESS\nthe review');
    assert.ok(out.includes('[reviewed-without-repo-access]'));
  });

  test('a scratch-dir workspace DECLARATION is stamped', () => {
    const out = stampBlindReview('my working directory is ~/.gemini/antigravity-cli/scratch, so');
    assert.ok(out.includes('[reviewed-without-repo-access]'));
  });

  test('a grounded review that merely QUOTES the marker is not stamped', () => {
    // A review OF this very file must not be mis-stamped and down-weighted.
    const quoting = ['a', 'b', 'c', 'd', 'e', 'f', 'the tell is REVIEWED-WITHOUT-REPO-ACCESS'].join('\n');
    assert.ok(!stampBlindReview(quoting).includes('[reviewed-without-repo-access]'));
  });

  test('an ordinary mention of the scratch path is not a declaration', () => {
    const mention = 'the plan references .gemini/antigravity-cli/scratch as an example path';
    assert.ok(!stampBlindReview(mention).includes('[reviewed-without-repo-access]'));
  });

  test('an empty review is left alone', () => {
    assert.equal(stampBlindReview(''), '');
  });
});

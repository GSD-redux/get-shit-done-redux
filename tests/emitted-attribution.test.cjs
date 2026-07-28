'use strict';

/**
 * emitted-attribution.test.cjs — the differential attribution check (#2723,
 * ADR-2719 §1/§3/§4/§5/§6, epic #2719 Phase 3).
 *
 * Runs BESIDE tests/golden-install-parity.test.cjs — both green, fixtures untouched.
 * Any PR where the golden fails and this passes is a Phase 2 provenance-table hole;
 * that disagreement is the entire point of the dual-run window, and Phase 4 (#2724)
 * must not land until it has been observed on real PRs.
 *
 * The law: every emitted path whose hash moved between `next` HEAD and PR HEAD must be
 * attributable — through the Phase 2 table — to a path the PR actually changed.
 * Unattributable deltas fail with the paths NAMED. The only way through is a committed
 * acknowledgment, never a flag (a contributor facing a red gate sets a flag, which is
 * what UPDATE_GOLDEN=1 is today).
 *
 * Structure: the pure law is exercised against synthetic manifests, which is what makes
 * the four failing-first criteria practical to assert at all — and then the final test
 * runs that same law against the REAL tree: 19 actual installer spawns for the current
 * side, `git show origin/next:<fixture>` for the baseline side, real `git diff` for the
 * changed paths, and the real `tests/emitted-drift-ack.json`.
 *
 * That last test is load-bearing. Without it this file would be interface-only — every
 * assertion true of hand-built inputs and none of the repo — which is the
 * promised-but-not-built failure this epic keeps finding in its own predecessors.
 * Verified by injecting an uncommitted edit to a shipped workflow: emitted output moves
 * but the path never appears in `git diff origin/next...HEAD`, and the check names all
 * 18 affected emitted paths.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fc = require('fast-check');

const { cleanup } = require('./helpers.cjs');
const { BUILD_SCRIPT } = require('./helpers/install-shared.cjs');
const {
  resolveChangedPaths,
  resolveBase,
  baseRefCandidates,
  baselineManifestsAtRef,
  baselineSizesAtRef,
  currentManifests,
  currentSizes,
  readAckFile,
} = require('./helpers/emitted-runtime.cjs');

const { EXPECTED_MANIFEST_COUNT } = require('./helpers/emitted-provenance.cjs');
const {
  ACK_VERSION,
  sourceSatisfiedBy,
  parseAck,
  diffEmitted,
  formatReport,
} = require('./helpers/emitted-diff.cjs');

const {
  BASELINE_ENV,
  BASELINE_VERSION,
  resolveBaseline,
} = require('./helpers/emitted-baseline.cjs');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** A real emitted key + its real source, so rows assert the shape production uses. */
const WORKFLOW_KEY = 'gsd-core/workflows/plan-phase.md';
const WORKFLOW_SRC = 'gsd-core/workflows/plan-phase.md';
const SKILL_KEY = 'skills/gsd-add-tests/SKILL.md';
const SKILL_SRC = 'commands/gsd/add-tests.md';

const mf = (obj) => ({ claude: obj });

// ─── Attribution: the conservation law ───────────────────────────────────────

test('unchanged hashes are not reported', () => {
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'aaa' }),
    changedPaths: [],
  });
  assert.equal(r.moved, 0);
  assert.equal(r.attributed.length, 0);
  assert.equal(r.unattributable.length, 0);
  assert.ok(r.ok);
});

test('a moved hash whose source changed is attributed', () => {
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb' }),
    changedPaths: [WORKFLOW_SRC],
  });
  assert.equal(r.moved, 1);
  assert.equal(r.unattributable.length, 0);
  assert.equal(r.attributed.length, 1);
  assert.equal(r.attributed[0].via, WORKFLOW_SRC);
  assert.ok(r.ok);
});

test('a trailing-slash source entry matches by prefix, segment-aware', () => {
  // Kimi's root agent aggregates all of agents/ — a Phase 2 prefix source.
  assert.equal(sourceSatisfiedBy('agents/', new Set(['agents/gsd-planner.md'])), 'agents/gsd-planner.md');
  // Hostile: a bare startsWith would over-attribute here. It must NOT match.
  assert.equal(sourceSatisfiedBy('agents/', new Set(['agentsfoo/x.md'])), null);
  // Exact entries compare exactly.
  assert.equal(sourceSatisfiedBy('a/b.md', new Set(['a/b.md'])), 'a/b.md');
  assert.equal(sourceSatisfiedBy('a/b.md', new Set(['a/b.md.bak'])), null);

  const r = diffEmitted({
    baseline: { kimi: { 'agents/gsd.yaml': 'aaa' } },
    current: { kimi: { 'agents/gsd.yaml': 'bbb' } },
    changedPaths: ['agents/gsd-planner.md'],
  });
  assert.equal(r.unattributable.length, 0, 'prefix source should attribute');
  assert.equal(r.attributed[0].via, 'agents/gsd-planner.md');
});

test('a moved hash nothing explains is unattributable and named', () => {
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb' }),
    changedPaths: ['README.md'],
  });
  assert.equal(r.unattributable.length, 1);
  const u = r.unattributable[0];
  assert.equal(u.rel, WORKFLOW_KEY);
  assert.equal(u.runtime, 'claude');
  assert.equal(u.ruleId, 'gsd-core-verbatim');
  assert.deepEqual(u.expectedSources, [WORKFLOW_SRC]);
  assert.ok(!r.ok);

  // ADR-2719 §1 sells the design on this message — it is a deliverable.
  const msg = formatReport(r);
  assert.match(msg, /changed that nothing in this diff explains/);
  assert.ok(msg.includes(WORKFLOW_KEY));
  assert.ok(msg.includes(WORKFLOW_SRC), 'the message must say what WOULD have explained it');
});

test('synthesized paths are exempt from attribution', () => {
  const r = diffEmitted({
    baseline: mf({ 'gsd-core/VERSION': 'aaa' }),
    current: mf({ 'gsd-core/VERSION': 'bbb' }),
    changedPaths: [],
  });
  assert.equal(r.unattributable.length, 0, 'install-time state can never be unexplained');
  assert.equal(r.attributed[0].via, '<synthesized: exempt>');
  assert.ok(r.ok);
});

test('code-derived paths attribute to their emitting source file', () => {
  // Phase 2 deliberately refused to mark these exempt; this is why.
  const r = diffEmitted({
    baseline: { cline: { '.clinerules/gsd.md': 'aaa' } },
    current: { cline: { '.clinerules/gsd.md': 'bbb' } },
    changedPaths: ['src/runtime-hooks-surface.cts'],
  });
  assert.equal(r.unattributable.length, 0);
  assert.equal(r.attributed[0].via, 'src/runtime-hooks-surface.cts');

  const blind = diffEmitted({
    baseline: { cline: { '.clinerules/gsd.md': 'aaa' } },
    current: { cline: { '.clinerules/gsd.md': 'bbb' } },
    changedPaths: ['README.md'],
  });
  assert.equal(blind.unattributable.length, 1, 'had these been exempt, this ripple would be invisible forever');
});

test('an added emitted key is a ripple too', () => {
  const r = diffEmitted({
    baseline: mf({}),
    current: mf({ [WORKFLOW_KEY]: 'bbb' }),
    changedPaths: ['README.md'],
  });
  assert.equal(r.moved, 1);
  assert.equal(r.unattributable.length, 1);
  assert.equal(r.unattributable[0].change, 'added');
});

test('a removed emitted key is reported', () => {
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({}),
    changedPaths: [WORKFLOW_SRC],
  });
  assert.equal(r.removed.length, 1);
  assert.equal(r.removed[0].change, 'removed');
  assert.equal(r.unattributable.length, 0, 'the deletion is explained by the source change');
});

test('moved hashes with no changed paths are all unattributable', () => {
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa', [SKILL_KEY]: 'ccc' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb', [SKILL_KEY]: 'ddd' }),
    changedPaths: [],
  });
  assert.equal(r.unattributable.length, 2, 'emitted output moving with zero source changes is a real finding');
  assert.ok(!r.ok);
});

test('a failed git diff is an error, not an empty change set', () => {
  // Treating a git failure as "nothing changed" would make everything unattributable —
  // a failure storm that reads exactly like a real finding.
  const r = diffEmitted({ baseline: mf({}), current: mf({}), changedPaths: null });
  assert.ok(!r.ok);
  assert.match(r.errors.join('\n'), /changedPaths must be an array/);
});

test('an unattributable-by-table path surfaces as an error', () => {
  const r = diffEmitted({
    baseline: mf({ 'totally/unknown/thing.md': 'aaa' }),
    current: mf({ 'totally/unknown/thing.md': 'bbb' }),
    changedPaths: [],
  });
  assert.ok(!r.ok);
  assert.match(r.errors.join('\n'), /no rule matches/);
  assert.equal(r.unattributable.length, 0, 'a table hole is an error, not a silent skip');
});

// ─── Acknowledgment file ─────────────────────────────────────────────────────

test('an acked ripple passes and is echoed', () => {
  const ack = { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'converter change, #2723' } } };
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb' }),
    changedPaths: ['README.md'],
    ack,
  });
  assert.equal(r.unattributable.length, 0);
  assert.equal(r.acked.length, 1);
  assert.equal(r.acked[0].reason, 'converter change, #2723');
  assert.ok(r.ok);
});

test('a stale ack entry fails', () => {
  // An ack that outlives its ripple pre-clears the NEXT one on that path.
  const ack = { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'old' } } };
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'aaa' }),
    changedPaths: [],
    ack,
  });
  assert.deepEqual(r.staleAcks, [WORKFLOW_KEY]);
  assert.ok(!r.ok);
  assert.match(formatReport(r), /stale acknowledgment/);
});

test('an ack without a reason fails', () => {
  for (const bad of [{ reason: '' }, { reason: '   ' }, {}, null, 42]) {
    const r = diffEmitted({
      baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
      current: mf({ [WORKFLOW_KEY]: 'bbb' }),
      changedPaths: [],
      ack: { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: bad } },
    });
    assert.ok(!r.ok, `${JSON.stringify(bad)} must be rejected`);
    assert.match(r.errors.join('\n'), /has no non-empty "reason"/);
  }
});

test('an absent ack file means no acks', () => {
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb' }),
    changedPaths: [WORKFLOW_SRC],
    ack: null,
  });
  assert.equal(r.errors.length, 0);
  assert.ok(r.ok, 'the healthy steady state is no ack file at all');
});

test('a live ack and a stale ack together: only the stale one is named', () => {
  const ack = {
    version: ACK_VERSION,
    paths: {
      [WORKFLOW_KEY]: { reason: 'live ripple' },
      [SKILL_KEY]: { reason: 'stale' },
    },
  };
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa', [SKILL_KEY]: 'ccc' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb', [SKILL_KEY]: 'ccc' }),
    changedPaths: [],
    ack,
  });
  assert.deepEqual(r.staleAcks, [SKILL_KEY], 'the live one must not be named');
});

test('non-object ack JSON is rejected, not treated as empty', () => {
  // Reading these as "no acks" would SILENTLY DISARM the gate — indistinguishable
  // from a healthy run, which is the worst failure available here.
  for (const bad of [0, 'a string', [], true]) {
    const { errors } = parseAck(bad);
    assert.ok(errors.length > 0, `${JSON.stringify(bad)} must be rejected`);
    assert.match(errors.join('\n'), /must be a JSON object/);
  }
  assert.deepEqual(parseAck(null).errors, [], 'absent is legal');
  assert.deepEqual(parseAck({}).errors, [], 'empty object is legal');
  assert.equal(parseAck({ version: 99, paths: {} }).errors.length, 1, 'version drift is caught');
});

// ─── The acceptance criteria, failing-first ──────────────────────────────────

test('a ripple names the unexplained path and not the explained one', () => {
  // #2723 AC: "edit one source file, corrupt an unrelated emitted file, assert the
  // check names the unattributable paths."
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa', [SKILL_KEY]: 'ccc' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb', [SKILL_KEY]: 'ddd' }),
    changedPaths: [WORKFLOW_SRC], // only the workflow source was edited
  });
  assert.equal(r.unattributable.length, 1);
  assert.equal(r.unattributable[0].rel, SKILL_KEY, 'the unrelated emitted file is the finding');
  assert.equal(r.attributed.length, 1);
  assert.equal(r.attributed[0].rel, WORKFLOW_KEY, 'the explained one must NOT be reported');
  assert.ok(!r.ok);
});

test('a converter change fails without an ack and passes with one', () => {
  // #2723 AC: "simulate a legitimate converter change: assert it fails without an ack
  // entry and passes with one." A converter edit moves emitted bytes for files whose
  // sources nobody touched — ADR-2264's "~5% git cannot review".
  const moved = {};
  const base = {};
  for (let i = 0; i < 25; i++) {
    base[`skills/gsd-cmd-${i}/SKILL.md`] = `h${i}`;
    moved[`skills/gsd-cmd-${i}/SKILL.md`] = `x${i}`;
  }
  const changedPaths = ['src/runtime-artifact-conversion.cts'];

  const without = diffEmitted({ baseline: mf(base), current: mf(moved), changedPaths });
  assert.equal(without.unattributable.length, 25);
  assert.ok(!without.ok, 'a converter change must not pass silently');

  const paths = {};
  for (const rel of Object.keys(moved)) paths[rel] = { reason: 'converter rewrite, ADR-2719' };
  const withAck = diffEmitted({
    baseline: mf(base), current: mf(moved), changedPaths,
    ack: { version: ACK_VERSION, paths },
  });
  assert.equal(withAck.unattributable.length, 0);
  assert.equal(withAck.acked.length, 25);
  assert.ok(withAck.ok);
});

test('growth is reported with its exact byte delta and needs an ack', () => {
  // ADR-2719 must-have 6, added by an /adr-phase-coverage audit precisely because
  // scope item 5 promised it and no criterion asserted it.
  const sizeBaseline = { 'verify-work.md': 10000, 'plan-phase.md': 8000 };
  const sizeCurrent = { 'verify-work.md': 11247, 'plan-phase.md': 8000 };

  const without = diffEmitted({
    baseline: mf({}), current: mf({}), changedPaths: [], sizeBaseline, sizeCurrent,
  });
  assert.equal(without.grown.length, 1);
  assert.deepEqual(without.grown[0], {
    name: 'verify-work.md', from: 10000, to: 11247, delta: 1247, acked: false,
  });
  assert.ok(!without.ok, 'unacked growth must block');
  assert.match(formatReport(without), /verify-work\.md grew 1247 bytes/);

  const withAck = diffEmitted({
    baseline: mf({}), current: mf({}), changedPaths: [], sizeBaseline, sizeCurrent,
    ack: { version: ACK_VERSION, paths: { 'verify-work.md': { reason: 'new UAT section' } } },
  });
  assert.equal(withAck.grown[0].acked, true);
  assert.ok(withAck.ok);
});

test('an ack consumed by size growth alone is not reported as stale', () => {
  // Ordering regression: stale-ack detection must run AFTER the size pass. Computing it
  // between the hash pass and the size pass reports a legitimate growth ack as stale —
  // a false failure that would push contributors to delete the very ack that is working.
  const r = diffEmitted({
    baseline: mf({}),
    current: mf({}),
    changedPaths: [],
    sizeBaseline: { 'verify-work.md': 10000 },
    sizeCurrent: { 'verify-work.md': 11247 },
    ack: { version: ACK_VERSION, paths: { 'verify-work.md': { reason: 'new UAT section' } } },
  });
  assert.deepEqual(r.staleAcks, [], 'a growth-consumed ack is live, not stale');
  assert.equal(r.grown[0].acked, true);
  assert.ok(r.ok);
});

test('shrinkage is reported but needs no ack', () => {
  const r = diffEmitted({
    baseline: mf({}), current: mf({}), changedPaths: [],
    sizeBaseline: { 'a.md': 9000 }, sizeCurrent: { 'a.md': 8000 },
  });
  assert.deepEqual(r.shrunk, [{ name: 'a.md', from: 9000, to: 8000, delta: 1000 }]);
  assert.ok(r.ok, 'shrinkage is not creep — gating it would punish what the ratchet wants');
});

// ─── Baseline resolution + staleness ─────────────────────────────────────────

const goodBaseline = (sha) => ({
  version: BASELINE_VERSION,
  sha,
  manifests: { claude: { [WORKFLOW_KEY]: 'aaa' } },
  sizes: { 'plan-phase.md': 100 },
});

test('a stale baseline cache key is detected, not used', () => {
  // ADR-2719 §5: the one thing that has to be exactly right.
  const r = resolveBaseline({
    expectedSha: SHA_A,
    env: {},
    cachePath: 'cache.json',
    readJson: () => goodBaseline(SHA_B),
  });
  assert.ok(!r.ok);
  assert.match(r.errors.join('\n'), /STALE baseline/);
  assert.ok(r.errors.join('\n').includes(SHA_B) && r.errors.join('\n').includes(SHA_A));
});

test('a matching baseline sha is accepted', () => {
  const r = resolveBaseline({
    expectedSha: SHA_A, env: {}, cachePath: 'cache.json',
    readJson: () => goodBaseline(SHA_A),
  });
  assert.ok(r.ok);
  assert.equal(r.sha, SHA_A);
  assert.equal(r.via, 'cache:cache.json');
  assert.deepEqual(r.sizeBaseline, { 'plan-phase.md': 100 });
});

test('an unavailable baseline fails explicitly rather than skipping', () => {
  // ADR-2719 §6 — in node:test a bare `return` is a PASS, which would fail the gate open.
  const r = resolveBaseline({
    expectedSha: SHA_A, env: {}, cachePath: 'cache.json',
    readJson: () => null,
  });
  assert.ok(!r.ok);
  assert.equal(r.via, 'none');
  assert.match(r.errors.join('\n'), /bare `return` is a PASS/);
});

test('a malformed baseline is rejected', () => {
  for (const bad of [0, 'str', [], true]) {
    const r = resolveBaseline({
      expectedSha: SHA_A, env: {}, cachePath: 'c.json', readJson: () => bad,
    });
    assert.ok(!r.ok, `${JSON.stringify(bad)} must be rejected`);
  }
  const noSha = resolveBaseline({
    expectedSha: SHA_A, env: {}, cachePath: 'c.json',
    readJson: () => ({ version: BASELINE_VERSION, manifests: {} }),
  });
  assert.match(noSha.errors.join('\n'), /must be a 40-hex commit sha/);
});

test('baseline resolution precedence is explicit and reported', () => {
  // env wins over cache…
  const viaEnv = resolveBaseline({
    expectedSha: SHA_A,
    env: { [BASELINE_ENV]: '/tmp/from-cache-restore.json' },
    cachePath: 'cache.json',
    readJson: (p) => (p === '/tmp/from-cache-restore.json' ? goodBaseline(SHA_A) : goodBaseline(SHA_B)),
  });
  assert.ok(viaEnv.ok);
  assert.equal(viaEnv.via, `env:${BASELINE_ENV}`);

  // …and an explicitly-pointed-at stale baseline is a hard stop, not a fall-through:
  // the operator said "use this one".
  const envStale = resolveBaseline({
    expectedSha: SHA_A,
    env: { [BASELINE_ENV]: '/tmp/x.json' },
    cachePath: 'cache.json',
    readJson: () => goodBaseline(SHA_B),
    buildFallback: () => goodBaseline(SHA_A),
  });
  assert.ok(!envStale.ok, 'an explicit stale baseline must not silently fall through');

  // a stale CACHE, by contrast, falls through to the build fallback
  const viaBuild = resolveBaseline({
    expectedSha: SHA_A, env: {}, cachePath: 'cache.json',
    readJson: () => goodBaseline(SHA_B),
    buildFallback: () => goodBaseline(SHA_A),
  });
  assert.ok(viaBuild.ok);
  assert.equal(viaBuild.via, 'build');
});

test('base-ref candidates are ordered most-specific first and de-duplicated', () => {
  // The gate went red on its first matrix run because it hard-depended on
  // `origin/next`, which cannot exist in the gsd-test container (shallow clone +
  // base/head merge, no remote-tracking refs). Candidate order is the fix, so it is
  // pinned rather than left implicit.
  assert.deepEqual(
    baseRefCandidates({ GSD_EMITTED_BASE: 'abc123', GITHUB_BASE_REF: 'next' }),
    ['abc123', 'origin/next', 'next'],
    'an explicit override wins, then the Actions base ref, then the defaults',
  );
  assert.deepEqual(
    baseRefCandidates({ GITHUB_BASE_REF: 'release/1.9' }),
    ['origin/release/1.9', 'release/1.9', 'origin/next', 'next'],
    'a non-next base ref is honored before falling back',
  );
  assert.deepEqual(
    baseRefCandidates({}),
    ['origin/next', 'next'],
    'with no env, the repo defaults are the only candidates',
  );
  // De-duplication matters: GITHUB_BASE_REF=next must not produce origin/next twice.
  const dupes = baseRefCandidates({ GITHUB_BASE_REF: 'next' });
  assert.equal(new Set(dupes).size, dupes.length);
});

test('an unreadable baseline surfaces an error', () => {
  const r = resolveBaseline({
    expectedSha: SHA_A, env: {}, cachePath: 'c.json',
    readJson: () => { throw new Error('injected read failure'); },
  });
  assert.ok(!r.ok);
  assert.match(r.errors.join('\n'), /injected read failure/);
});

test('readAckFile: absent is legal, malformed and unreadable are not', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-ack-'));
  try {
    const ackPath = path.join(tmp, 'emitted-drift-ack.json');

    // Absent == no acks. The healthy steady state.
    assert.equal(readAckFile(ackPath), null);

    // Present and valid.
    fs.writeFileSync(ackPath, JSON.stringify({ version: ACK_VERSION, paths: {} }));
    assert.deepEqual(readAckFile(ackPath), { version: ACK_VERSION, paths: {} });

    // Present but empty — must NOT be read as absent.
    fs.writeFileSync(ackPath, '');
    assert.throws(() => readAckFile(ackPath), /present but empty/);

    // Present but not JSON.
    fs.writeFileSync(ackPath, '{not json');
    assert.throws(() => readAckFile(ackPath), /not valid JSON/);

    // Unreadable: monkeypatch the fs method, restore in `finally`. NEVER chmod 0o000 —
    // root bypasses mode bits, so the test would silently pass with zero coverage in
    // root Docker/CI. This exercises the SUT (readAckFile), not fs itself.
    fs.writeFileSync(ackPath, JSON.stringify({ version: ACK_VERSION, paths: {} }));
    const orig = fs.readFileSync;
    try {
      fs.readFileSync = () => { throw new Error('injected ack read failure'); };
      assert.throws(() => readAckFile(ackPath), /injected ack read failure/);
    } finally {
      fs.readFileSync = orig;
    }
    // Restoration is real, not assumed.
    assert.deepEqual(readAckFile(ackPath), { version: ACK_VERSION, paths: {} });
  } finally {
    cleanup(tmp);
  }
});

test('formatReport truncation is exact at limit-1 / limit / limit+1', () => {
  // sampleLimit gates a real branch. CLAUDE.md's boundary rule applies to it like any
  // other limit; the earlier suite named a test "limit+1" that tested no numeric limit
  // at all, which is worse than no coverage because it reads as covered.
  const build = (n) => {
    const baseline = {}; const current = {};
    for (let i = 0; i < n; i++) {
      const k = `gsd-core/workflows/w${String(i).padStart(3, '0')}.md`;
      baseline[k] = 'a'; current[k] = 'b';
    }
    return diffEmitted({ baseline: mf(baseline), current: mf(current), changedPaths: [] });
  };

  const at19 = formatReport(build(19), { sampleLimit: 20 });
  assert.ok(at19.includes('w018.md'), 'limit-1 lists every path');
  assert.ok(!at19.includes('…and'), 'limit-1 must not truncate');

  const at20 = formatReport(build(20), { sampleLimit: 20 });
  assert.ok(at20.includes('w019.md'), 'at the limit the last path is listed');
  assert.ok(!at20.includes('…and'), 'exactly at the limit must not truncate');

  const at21 = formatReport(build(21), { sampleLimit: 20 });
  assert.ok(at21.includes('…and 1 more'), 'limit+1 truncates and says how many were hidden');
  assert.ok(!at21.includes('w020.md'), 'the 21st path is not listed');
});

// ─── Independence + purity ───────────────────────────────────────────────────

test('the differential covers every runtime present in either manifest', () => {
  const baseline = { claude: { [WORKFLOW_KEY]: 'a' }, kimi: { [WORKFLOW_KEY]: 'a' } };
  const current = { claude: { [WORKFLOW_KEY]: 'b' }, opencode: { [WORKFLOW_KEY]: 'c' } };
  const r = diffEmitted({ baseline, current, changedPaths: [] });
  const seen = new Set([...r.unattributable, ...r.attributed, ...r.removed].map((x) => x.runtime));
  assert.deepEqual([...seen].sort(), ['claude', 'kimi', 'opencode'],
    'a runtime present on only one side must still be evaluated');
});

test('diff is pure and repeatable', () => {
  const args = {
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb' }),
    // 3 elements in deliberately unsorted order, so an in-place sort would be visible.
    changedPaths: ['zzz/last.md', WORKFLOW_SRC, 'aaa/first.md'],
  };
  const frozen = JSON.stringify(args);
  const a = diffEmitted(args);
  const b = diffEmitted(args);
  assert.deepEqual(b, a);
  assert.equal(JSON.stringify(args), frozen, 'inputs must not be mutated');
});

// ─── Property: conservation ──────────────────────────────────────────────────

test('property: every moved key lands in exactly one bucket', () => {
  // The conservation law itself. A key silently dropped from all three buckets is a
  // hole in the very invariant ADR-2719 asserts — and it is the failure a hand-written
  // example set is least likely to find.
  const keys = [WORKFLOW_KEY, SKILL_KEY, 'agents/gsd-planner.md', 'scripts/lib/cli-exit.cjs'];
  const sources = { [WORKFLOW_KEY]: WORKFLOW_SRC, [SKILL_KEY]: SKILL_SRC,
    'agents/gsd-planner.md': 'agents/gsd-planner.md', 'scripts/lib/cli-exit.cjs': 'scripts/lib/cli-exit.cjs' };

  fc.assert(
    fc.property(
      fc.subarray(keys, { minLength: 1 }),          // which keys move
      fc.subarray(keys),                             // which sources the PR changed
      fc.subarray(keys),                             // which keys are acked
      (movedKeys, changedKeys, ackedKeys) => {
        const baseline = {}; const current = {};
        for (const k of keys) { baseline[k] = 'h'; current[k] = movedKeys.includes(k) ? 'x' : 'h'; }
        const ackPaths = {};
        for (const k of ackedKeys) ackPaths[k] = { reason: 'property' };

        const r = diffEmitted({
          baseline: mf(baseline),
          current: mf(current),
          changedPaths: changedKeys.map((k) => sources[k]),
          ack: { version: ACK_VERSION, paths: ackPaths },
        });

        if (r.errors.length) return false;
        const bucketed = [
          ...r.attributed.map((x) => x.rel),
          ...r.unattributable.map((x) => x.rel),
          ...r.acked.map((x) => x.rel),
        ];
        // exactly-once, and exactly the moved set — no key invented, none dropped
        return bucketed.length === movedKeys.length
          && new Set(bucketed).size === bucketed.length
          && movedKeys.every((k) => bucketed.includes(k));
      },
    ),
    { numRuns: 400 },
  );
});

// ─── The real thing: the law, run against the actual tree ───────────────────
//
// Everything above exercises the pure law against synthetic input, which is what makes
// the acceptance criteria practical to assert at all. This block is what stops the
// phase from being interface-only: it builds the CURRENT emitted manifests for real
// (one installer spawn per runtime), reads the BASELINE from `origin/next`, resolves
// the changed paths with real git, reads the real ack file, and runs the conservation
// law over all of it.
//
// Baseline source note: `git show origin/next:<fixture>` — next's RECORDED emitted
// state. Deliberately not the working-tree fixtures, which are whatever this PR's
// author regenerated; comparing against those would be vacuous. Phase 4 (#2724)
// deletes the fixtures and swaps in resolveBaseline's cache path, which is already
// implemented and tested above.

test('differential attribution over the real tree', { timeout: 900_000 }, async (t) => {
  if (process.platform === 'win32') {
    // Mirrors the golden harness: install output is platform-specific on Windows
    // (backslash paths), so parity is asserted on macOS + Linux. An explicit t.skip,
    // never a bare `return` — in node:test that would be a PASS (ADR-2719 §6).
    t.skip('emitted parity is asserted on macOS + Linux; Windows install output is platform-specific');
    return;
  }

  // hooks/dist is gitignored and built (DEFECT.HOOKS-DIST-SCOPED-CI): the scoped CI
  // lane does not run build:hooks, so a real install there would emit no hooks/ dir.
  // Build idempotently, exactly as the golden harness does.
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });

  // The base ref is not universally available. The gsd-test runner shallow-clones and
  // merges base+head, so no `origin/*` remote-tracking ref exists in the container —
  // this test went red on its first matrix run for exactly that reason, which is the
  // resolver doing its job and the dependency being wrong.
  //
  // An explicit t.skip is the ADR-sanctioned response for a genuine environmental
  // skip: it is REPORTED as skipped, unlike a bare `return`, which node:test scores as
  // a PASS (ADR-2719 §6). Hard-failing instead would make the suite permanently red
  // wherever a base ref cannot exist by construction, which is not a propagation
  // finding — it is a statement about the checkout.
  const resolved = resolveBase();
  if (!resolved) {
    t.skip(
      'no base ref resolvable — tried ' + baseRefCandidates().join(', ') +
      '. The differential gate did NOT run here. It binds in the CI test lanes, which ' +
      'fetch the base ref explicitly; set GSD_EMITTED_BASE=<ref|sha> to run it elsewhere.',
    );
    return;
  }
  const { ref: base, sha: baseSha } = resolved;
  assert.match(baseSha, /^[0-9a-f]{40}$/);

  const baseline = baselineManifestsAtRef(base);
  assert.ok(
    baseline && Object.keys(baseline).length > 0,
    `no baseline manifests found at ${base}. During the dual-run window these come from the ` +
    'committed golden fixtures at that ref; after Phase 4 they come from the cached ' +
    'baseline artifact via resolveBaseline().',
  );

  const changedPaths = resolveChangedPaths(base);
  const ack = readAckFile();
  const current = currentManifests();

  // Assert against the INDEPENDENT expected count, not just baseline-vs-current.
  // Comparing the two sides to each other cannot catch a family dropped from BOTH —
  // which is exactly what happened with claude-local: 18 === 18 passed vacuously while
  // the 19th family went unchecked.
  assert.equal(
    Object.keys(baseline).length,
    EXPECTED_MANIFEST_COUNT,
    `baseline must cover all ${EXPECTED_MANIFEST_COUNT} emitted manifest families`,
  );
  assert.equal(
    Object.keys(current).length,
    EXPECTED_MANIFEST_COUNT,
    `current must cover all ${EXPECTED_MANIFEST_COUNT} emitted manifest families`,
  );
  assert.ok(baseline['claude-local'], 'the claude local-scope layout (#2086) must be covered');
  assert.ok(current['claude-local'], 'the claude local-scope layout (#2086) must be covered');

  const result = diffEmitted({
    baseline,
    current,
    changedPaths,
    ack,
    sizeBaseline: baselineSizesAtRef(base),
    sizeCurrent: currentSizes(),
  });

  assert.ok(
    result.ok,
    `emitted-attribution failed against ${base}@${baseSha.slice(0, 12)}:\n\n${formatReport(result)}`,
  );
});

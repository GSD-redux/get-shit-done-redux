'use strict';

/**
 * emitted-attribution.test.cjs — the differential attribution check (#2723/#2724,
 * ADR-2719 §1/§3/§4/§5/§6, epic #2719 Phases 3-4).
 *
 * This is the SOLE gate for emitted-artifact propagation (#2724, Phase 4 cutover).
 * `tests/golden-install-parity.test.cjs` — the committed path->hash fixtures it dual-ran
 * beside during Phase 3 — is deleted. The dual-run window it ran on real PRs (#2412,
 * #2566, #2728) surfaced two real defects (#2750, #2760), both now fixed and merged; no
 * disagreement between the two checks was ever observed once both landed correctly.
 *
 * The law: every emitted path whose hash moved between `next` HEAD and PR HEAD must be
 * attributable — through the Phase 2 table — to a path the PR actually changed.
 * Unattributable deltas fail with the paths NAMED. The only way through is a committed
 * acknowledgment, never a flag (a contributor facing a red gate sets a flag, which is
 * what UPDATE_GOLDEN=1 used to be, before #2724 removed it).
 *
 * Structure: the pure law is exercised against synthetic manifests, which is what makes
 * the four failing-first criteria practical to assert at all — and then the final test
 * runs that same law against the REAL tree: 19 actual installer spawns for the current
 * side, `resolveBaseline()` (env / cache / in-job build) for the baseline side, real
 * `git diff` for the changed paths, and the real `tests/emitted-drift-ack.json`.
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
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fc = require('fast-check');

const { cleanup, createTempDir } = require('./helpers.cjs');
const { BUILD_SCRIPT, buildParityManifest, buildInstallTree, PKG_VERSION } = require('./helpers/install-shared.cjs');
const {
  resolveChangedPaths,
  resolveBase,
  baseRefCandidates,
  buildBaselineAtRef,
  currentManifests,
  currentSizes,
  readAckFile,
  readAckFileAtRef,
  ACK_REPO_PATH,
  baselineFamilyNamesAtRef,
  MANIFEST_FAMILIES,
  MINIMUM_MANIFEST_FAMILIES,
  REGISTRY_SIGNAL_PATHS,
  FAMILY_REASON,
  touchesRuntimeRegistry,
  reconcileFamilies,
  safeDirArgs,
  measuredPackageVersion,
} = require('./helpers/emitted-runtime.cjs');

const { EXPECTED_MANIFEST_COUNT, loadManifests } = require('./helpers/emitted-provenance.cjs');
const { validateAckText } = require('../scripts/lint-emitted-drift-ack.cjs');
const {
  ACK_VERSION,
  ACK_FILE,
  NEW_FILE_CAP,
  REMEDIATION,
  sourceSatisfiedBy,
  parseAck,
  diffEmitted,
  buildReport,
  formatReport,
} = require('./helpers/emitted-diff.cjs');

const {
  BASELINE_ENV,
  BASELINE_VERSION,
  resolveBaseline,
} = require('./helpers/emitted-baseline.cjs');


const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** This checkout's own root — used to build a synthetic commit in-place (see
 *  `buildBaselineAtRef resolves a baseline via the in-job build...` below). */
const REPO_ROOT = path.join(__dirname, '..');

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

// ─── Transform attribution (#2757 defect 1) ──────────────────────────────────
//
// A `kind: 'derived'` rule's bytes can legitimately move for a second reason the
// `sources`-only design cannot express: the TRANSFORM code that generates the
// derived artifact changed, not the source it derives from. Replays the #2566
// shape verbatim: 16 emitted `agents/*.toml` moved, the diff touches
// `src/runtime-artifact-conversion.cts` and zero `agents/*.md`.

test('a derived path explained only by a transform change is attributed (#2566 shape)', () => {
  const moved = {};
  const base = {};
  const agentNames = [
    'gsd-planner', 'gsd-executor', 'gsd-verifier', 'gsd-code-reviewer',
    'gsd-security-auditor', 'gsd-nyquist-auditor', 'gsd-doc-writer', 'gsd-roadmapper',
    'gsd-phase-researcher', 'gsd-pattern-mapper', 'gsd-plan-checker', 'gsd-debugger',
    'gsd-ui-checker', 'gsd-eval-planner', 'gsd-framework-selector', 'gsd-code-fixer',
  ];
  assert.equal(agentNames.length, 16, 'the #2566 reproduction is 16 emitted .toml files');
  for (const name of agentNames) {
    base[`agents/${name}.toml`] = `before-${name}`;
    moved[`agents/${name}.toml`] = `after-${name}`;
  }

  // Before the fix, `agents-toml-derived` has no `transforms` field: this must fail.
  const withoutTransformChange = diffEmitted({
    baseline: mf(base),
    current: mf(moved),
    // Deliberately NOT `src/runtime-artifact-conversion.cts` — proves the negative
    // (an unrelated source change does not accidentally attribute).
    changedPaths: ['README.md'],
  });
  assert.equal(withoutTransformChange.unattributable.length, 16);
  assert.ok(!withoutTransformChange.ok);

  // The actual #2566 shape: the diff touches the transform, not any agents/*.md.
  const withTransformChange = diffEmitted({
    baseline: mf(base),
    current: mf(moved),
    changedPaths: ['src/runtime-artifact-conversion.cts'],
  });
  assert.equal(
    withTransformChange.unattributable.length, 0,
    'a transform-only change must attribute every moved derived path',
  );
  assert.equal(withTransformChange.attributed.length, 16);
  for (const rec of withTransformChange.attributed) {
    assert.equal(rec.via, 'src/runtime-artifact-conversion.cts');
    assert.equal(rec.ruleId, 'agents-toml-derived');
  }
  assert.ok(withTransformChange.ok);
});

test('an identity-classified agent .md moved by a transform-only change is unattributable (#2757 defect 2, pre-fix shape)', () => {
  // Reproduces the maintainer's follow-up: codex's agents/*.md hash moves without any
  // agents/*.md in the diff. Whether this attributes now depends entirely on whether
  // `agents-verbatim` has been reclassified to `derived` with `transforms` declared —
  // this test asserts the REAL, current behavior of the shipped table, so it doubles
  // as the defect-2 regression once the fix lands (the id in the rule table has not
  // changed, only `kind`/`transforms`, so this same test proves both "was broken" and
  // "is fixed" depending on which commit runs it).
  const r = diffEmitted({
    baseline: { codex: { 'agents/gsd-nyquist-auditor.md': 'before' } },
    current: { codex: { 'agents/gsd-nyquist-auditor.md': 'after' } },
    changedPaths: ['src/runtime-artifact-conversion.cts'],
  });
  assert.equal(r.unattributable.length, 0, 'a declared transform must explain the moved identity-family path');
  assert.equal(r.attributed[0].ruleId, 'agents-verbatim');
  assert.equal(r.attributed[0].via, 'src/runtime-artifact-conversion.cts');
  assert.ok(r.ok);
});

test('a moved derived path with neither source nor transform in the diff still fails, named', () => {
  const r = diffEmitted({
    baseline: mf({ 'agents/gsd-planner.toml': 'before' }),
    current: mf({ 'agents/gsd-planner.toml': 'after' }),
    changedPaths: ['docs/README.md'],
  });
  assert.equal(r.unattributable.length, 1);
  assert.equal(r.unattributable[0].rel, 'agents/gsd-planner.toml');
  assert.deepEqual(r.unattributable[0].expectedSources, ['agents/gsd-planner.md']);
  assert.ok(
    r.unattributable[0].expectedTransforms.includes('src/runtime-artifact-conversion.cts'),
    'the message must be able to say what transform WOULD have explained it too',
  );
  const msg = formatReport(r);
  assert.ok(msg.includes('agents/gsd-planner.toml'));
  assert.ok(msg.includes('src/runtime-artifact-conversion.cts'), 'the transform hint must appear in the report');
});

test('an unrelated src file does not attribute a moved derived path (transforms list stays narrow)', () => {
  // The review's own risk: a transform list that is too broad silently excuses real
  // ripples. src/state-document.cts has nothing to do with agent conversion.
  const r = diffEmitted({
    baseline: mf({ 'agents/gsd-planner.toml': 'before' }),
    current: mf({ 'agents/gsd-planner.toml': 'after' }),
    changedPaths: ['src/state-document.cts'],
  });
  assert.equal(r.unattributable.length, 1, 'an unrelated src/*.cts file must NOT excuse the ripple');
  assert.ok(!r.ok);
});

test('bin/install.js alone does not attribute a moved agent artifact (deliberate exclusion)', () => {
  // bin/install.js implements the final splice (injectEffortFrontmatter,
  // generateCodexAgentToml) but is deliberately excluded from AGENT_TRANSFORM_SRCS —
  // at 13k+ lines spanning every installer concern, including it would be the blanket
  // escape hatch ADR-2719 warns against. This proves the exclusion holds in the
  // shipped table, not just in the design doc.
  const r = diffEmitted({
    baseline: mf({ 'agents/gsd-planner.toml': 'before' }),
    current: mf({ 'agents/gsd-planner.toml': 'after' }),
    changedPaths: ['bin/install.js'],
  });
  assert.equal(r.unattributable.length, 1, 'bin/install.js alone must not attribute — it is not a declared transform');
  assert.ok(!r.ok);
});

test('a moved path with a source match wins over an also-present transform match (deterministic via)', () => {
  const r = diffEmitted({
    baseline: mf({ 'agents/gsd-planner.toml': 'before' }),
    current: mf({ 'agents/gsd-planner.toml': 'after' }),
    changedPaths: ['agents/gsd-planner.md', 'src/runtime-artifact-conversion.cts'],
  });
  assert.equal(r.unattributable.length, 0);
  assert.equal(r.attributed[0].via, 'agents/gsd-planner.md', 'sources are checked before transforms');
});

test('a transform-explained converter ripple still needs no ack (transforms are a first-class attribution, not a workaround)', () => {
  // Contrast with 'a converter change fails without an ack and passes with one' above:
  // THAT test simulates a family with NO transforms declared, so it correctly still
  // requires an ack. agents-toml-derived DOES declare a transform, so the equivalent
  // ripple must attribute directly, with no ack needed at all.
  const moved = {};
  const base = {};
  for (let i = 0; i < 5; i++) {
    base[`agents/gsd-fixture-${i}.toml`] = `h${i}`;
    moved[`agents/gsd-fixture-${i}.toml`] = `x${i}`;
  }
  const r = diffEmitted({
    baseline: mf(base),
    current: mf(moved),
    changedPaths: ['src/runtime-artifact-conversion.cts'],
  });
  assert.equal(r.unattributable.length, 0);
  assert.equal(r.acked.length, 0, 'no ack was needed — the transform explains it directly');
  assert.ok(r.ok);
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
    baseAck: null,
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
    baseAck: null,
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
      baseAck: null,
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
    baseAck: null,
  });
  assert.deepEqual(r.staleAcks, [SKILL_KEY], 'the live one must not be named');
});

// ─── Ack lifecycle: an ack is scoped to the diff that introduced it (#2789) ──
//
// Every other input to the law is base-relative — `baseline` vs `current`, `changedPaths`
// from `git diff base...HEAD`. The ack set was the one absolute input, read only from
// HEAD. That mismatch is what made a MERGED ack look identical to a never-explained one:
// both present as "no delta consumed it", so merging an ack the PR lane had accepted
// reddened `next` and every PR branching off it (#2768).
//
// `baseAck` closes it. An entry already present at the base is SPENT — its ripple is
// absorbed, it is not this diff's to answer for, and it may no longer clear anything.

test('an ack already present at the base is spent — not stale, and it does not fail', () => {
  // The #2768 shape exactly: the ack merged, so the base carries it and no delta remains.
  const ack = { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'deliberate growth' } } };
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'aaa' }),
    changedPaths: [],
    ack,
    baseAck: ack,
  });
  assert.deepEqual(r.staleAcks, [], 'an absorbed ripple is the ack SUCCEEDING, not failing');
  assert.deepEqual(r.spentAcks, [WORKFLOW_KEY], 'still surfaced, so it can be cleaned up');
  assert.ok(r.ok);
});

test('a spent ack cannot pre-clear a NEW ripple on its own path', () => {
  // ADR-2719's own named hazard. Today a leftover ack silently clears the next ripple;
  // scoped to its diff it cannot, so the new ripple must be explained on its own terms.
  const ack = { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'last time' } } };
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb' }), // a genuinely new, unexplained move
    changedPaths: [],
    ack,
    baseAck: ack,
  });
  assert.equal(r.acked.length, 0, 'a spent ack must not absorb a new ripple');
  assert.equal(r.unattributable.length, 1);
  assert.ok(!r.ok);
});

test('re-arming a spent ack costs actual prose — not whitespace, not a decorative field', () => {
  // Re-arming is legitimate; it is how a contributor says "this is a NEW ripple, and here
  // is why". But the reason is the whole artifact a reviewer reads, so it must cost a
  // real explanation. Both of these once re-armed an ack whose justification still
  // described the PREVIOUS ripple, showing a reviewer nothing new in the ack file's diff.
  const base = { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'the same words' } } };
  const newRipple = {
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb' }), // genuinely new and unexplained
    changedPaths: [],
    baseAck: base,
  };

  const doubledSpace = diffEmitted({
    ...newRipple,
    ack: { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'the  same   words' } } },
  });
  assert.equal(doubledSpace.acked.length, 0, 'internal whitespace must not re-arm');
  assert.ok(!doubledSpace.ok);

  const decoratedField = diffEmitted({
    ...newRipple,
    ack: { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'the same words', runtime: 'claude' } } },
  });
  assert.equal(decoratedField.acked.length, 0, 'an unrelated field must not re-arm');
  assert.ok(!decoratedField.ok);

  // …while genuinely new prose still does.
  const reworded = diffEmitted({
    ...newRipple,
    ack: { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'a different, specific explanation' } } },
  });
  assert.equal(reworded.acked.length, 1);
  assert.ok(reworded.ok);
});

test('spent entries are reported sorted, and modelled in buildReport not just rendered', () => {
  // Insertion order is deliberately REVERSE-sorted (`skills/…` before `gsd-core/…`), so
  // the assertion bites: comparing against a sorted copy of the result would pass even
  // with the sort deleted, and asserting on an already-ordered fixture proves nothing.
  const both = {
    version: ACK_VERSION,
    paths: { [SKILL_KEY]: { reason: 'second' }, [WORKFLOW_KEY]: { reason: 'first' } },
  };
  assert.ok(SKILL_KEY > WORKFLOW_KEY, 'the fixture must be inserted out of order to be a real test');

  const r = diffEmitted({
    baseline: mf({ 'gsd-core/workflows/zzz.md': 'aaa' }),
    current: mf({ 'gsd-core/workflows/zzz.md': 'bbb' }), // an unrelated failure to render under
    changedPaths: [],
    ack: both,
    baseAck: both,
  });
  assert.deepEqual(r.spentAcks, [WORKFLOW_KEY, SKILL_KEY], 'spent entries must come back sorted');

  const block = buildReport(r).blocks.find((b) => b.kind === 'spent-acks');
  assert.ok(block, 'spent acks must be modelled in the IR, so tests need no raw text matching');
  assert.equal(block.count, 2);
  assert.deepEqual(block.items, r.spentAcks);
});

test('buildReport and formatReport agree about spent acks on a PASSING run', () => {
  // `formatReport` is documented as a pure rendering of `buildReport`. The spent section
  // is the one block whose emit-condition could drift, because a passing run must render
  // nothing — so the IR must withhold it there too, or a JSON reporter built on the IR
  // would report spent acks for a green run while the text reporter stayed silent.
  const spent = { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'absorbed' } } };
  const passing = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'aaa' }),
    changedPaths: [],
    ack: spent,
    baseAck: spent,
  });
  assert.ok(passing.ok);
  assert.deepEqual(passing.spentAcks, [WORKFLOW_KEY], 'the datum is still on the result object');
  assert.equal(formatReport(passing), '');
  assert.equal(
    buildReport(passing).blocks.find((b) => b.kind === 'spent-acks'),
    undefined,
    'the IR must not carry a block the renderer suppresses',
  );
});

test('ackDocument survives a __proto__ key instead of silently teaching an empty document', () => {
  // `key` comes from repo/emitted paths. On a plain object `__proto__` sets the prototype
  // rather than a property, so JSON.stringify would emit `"paths":{}` — remediation text
  // that teaches the contributor to acknowledge nothing at all.
  const doc = JSON.parse(REMEDIATION.ackDocument([
    { key: '__proto__', reason: 'hostile key' },
    { key: 'plan-phase.md', reason: 'ordinary key' },
  ]));
  assert.deepEqual(Object.keys(doc.paths).sort(), ['__proto__', 'plan-phase.md']);
  assert.equal(doc.paths.__proto__.reason, 'hostile key');
  assert.equal(({}).reason, undefined, 'Object.prototype must be untouched');
});

test('a clean run renders NOTHING, even when spent entries exist', () => {
  // `formatReport` returning prose for an ok result reads as "something is wrong".
  const spent = { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'absorbed' } } };
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'aaa' }),
    changedPaths: [],
    ack: spent,
    baseAck: spent,
  });
  assert.ok(r.ok);
  assert.deepEqual(r.spentAcks, [WORKFLOW_KEY]);
  assert.equal(formatReport(r), '', 'a passing run must render an empty report');
});

test('an ack whose reason changed in this diff is live again', () => {
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb' }),
    changedPaths: [],
    ack: { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'THIS ripple, freshly explained' } } },
    baseAck: { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'the previous one' } } },
  });
  assert.equal(r.acked.length, 1, 'rewriting the reason re-arms the ack for the new ripple');
  assert.deepEqual(r.staleAcks, []);
  assert.ok(r.ok);
});

test('an ack absent from the base is live and consumes its ripple', () => {
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb' }),
    changedPaths: [],
    ack: { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'new in this PR' } } },
    baseAck: { version: ACK_VERSION, paths: { [SKILL_KEY]: { reason: 'unrelated, already merged' } } },
  });
  assert.equal(r.acked.length, 1);
  assert.deepEqual(r.staleAcks, []);
  assert.ok(r.ok);
});

test('a LIVE ack that nothing consumes is still stale and still fails', () => {
  // The softening must not reach the case the rule exists for: an ack written in THIS
  // diff that never explained anything is an authoring mistake, and blame lands right.
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'aaa' }),
    changedPaths: [],
    ack: { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'explains nothing' } } },
    baseAck: { version: ACK_VERSION, paths: { [SKILL_KEY]: { reason: 'unrelated' } } },
  });
  assert.deepEqual(r.staleAcks, [WORKFLOW_KEY]);
  assert.deepEqual(r.spentAcks, []);
  assert.ok(!r.ok);
});

test('an absent or unreadable base ack inherits NOTHING — the gate stays armed', () => {
  // Omission is not evidence that an entry was already merged. Every unknown here fails
  // toward the strict reading, so a base we could not read cannot excuse a stale ack.
  // `undefined` is deliberately NOT in this list: a destructuring default fires on it, so
  // it takes the OMITTED path and fails with "baseAck was not supplied" — a different
  // rule, covered by its own test above. Including it here would look like coverage of
  // the staleness path while asserting something else entirely.
  for (const baseAck of [null, {}, { version: ACK_VERSION }, 'not-an-object', 42, []]) {
    const r = diffEmitted({
      baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
      current: mf({ [WORKFLOW_KEY]: 'aaa' }),
      changedPaths: [],
      ack: { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'x' } } },
      baseAck,
    });
    assert.deepEqual(r.staleAcks, [WORKFLOW_KEY], `baseAck ${JSON.stringify(baseAck)} must inherit nothing`);
    assert.ok(!r.ok);
  }
});

// ─── Pre-merge lint parity (#2789) ───────────────────────────────────────────
//
// `scripts/lint-emitted-drift-ack.cjs` blocks a broken ack document from ever reaching
// the base branch, where the base-side reader's (correct) loud failure would be
// expensive. It cannot reuse `parseAck`: `scripts/` ships in the npm package and `tests/`
// does not, so requiring across that line would be a MODULE_NOT_FOUND in the published
// package. Two validators of one schema is exactly the divergence this repo requires a
// parity assertion for — so the corpus below runs through BOTH and must get the same
// verdict from each.

test('the pre-merge lint and the gate parser agree on what is schema-valid', () => {
  const corpus = [
    // [label, raw text, expected schema-valid?]
    ['absent-equivalent empty object', '{}', true],
    ['versioned, no paths', '{"version":1}', true],
    ['empty paths', '{"version":1,"paths":{}}', true],
    ['one good entry', '{"version":1,"paths":{"a.md":{"reason":"why"}}}', true],
    ['bare-string reason', '{"version":1,"paths":{"a.md":"why"}}', true],
    ['no version key', '{"paths":{"a.md":{"reason":"why"}}}', true],
    ['unknown extra field', '{"version":1,"paths":{"a.md":{"reason":"why","note":"x"}}}', true],
    ['bad JSON', '{ not json', false],
    ['array document', '[]', false],
    ['scalar document', '42', false],
    ['string document', '"nope"', false],
    // NOT here: a document of literally `null`. `parseAck` uses null as its
    // "absent == no acks" sentinel and reads it as legal, so it is schema-valid on both
    // sides; the lint rejects it on POLICY instead. Covered in the entryless test below.
    ['wrong version', '{"version":9,"paths":{}}', false],
    ['paths is an array', '{"version":1,"paths":[]}', false],
    ['paths is a scalar', '{"version":1,"paths":7}', false],
    ['empty reason', '{"version":1,"paths":{"a.md":{"reason":""}}}', false],
    ['whitespace reason', '{"version":1,"paths":{"a.md":{"reason":"   "}}}', false],
    ['missing reason', '{"version":1,"paths":{"a.md":{}}}', false],
    ['numeric reason', '{"version":1,"paths":{"a.md":42}}', false],
  ];

  for (const [label, raw, expectedValid] of corpus) {
    const lint = validateAckText(raw);
    const lintValid = lint.schemaErrors.length === 0;

    // The gate's own parser, fed the same document the same way `readAckFile` would.
    let gateValid;
    try {
      gateValid = parseAck(JSON.parse(raw)).errors.length === 0;
    } catch {
      gateValid = false; // unparseable JSON never reaches parseAck; readAckFile throws first
    }

    assert.equal(lintValid, expectedValid, `lint verdict for ${label}`);
    assert.equal(
      gateValid, lintValid,
      `DIVERGENCE on ${label}: the pre-merge lint and parseAck disagree, so one of them `
      + 'would let a document through that the other rejects',
    );
  }
});

test('the lint additionally rejects a present-but-entryless document the parser accepts', () => {
  // This is policy, not schema, and the one place the two surfaces are MEANT to differ:
  // `parseAck` must treat `{}` as "no acks" (legal) so an absent-equivalent document
  // never fails the gate mid-run, while the lint refuses to let one be COMMITTED,
  // because it acknowledges nothing and only confuses the next reader.
  // `null` belongs here rather than in the schema corpus: it is the gate's own
  // "absent == no acks" sentinel, so it is legal to PARSE and still wrong to COMMIT.
  for (const raw of ['{}', '{"version":1}', '{"version":1,"paths":{}}', 'null']) {
    const r = validateAckText(raw);
    assert.deepEqual(r.schemaErrors, [], `${raw} must be schema-valid`);
    assert.equal(r.policyErrors.length, 1, `${raw} must trip the delete-the-file policy`);
    assert.ok(!r.ok);
    assert.deepEqual(parseAck(JSON.parse(raw)).errors, [], `${raw} must stay legal for the gate`);
  }
});

test('the lint passes on an absent file — the healthy steady state', () => {
  const r = validateAckText(null);
  assert.deepEqual(r.schemaErrors, []);
  assert.deepEqual(r.policyErrors, []);
  assert.ok(r.ok);
});

test('the lint rejects a present-but-empty file rather than reading it as absent', () => {
  for (const raw of ['', '   ', '\n\t ']) {
    const r = validateAckText(raw);
    assert.equal(r.schemaErrors.length, 1, `${JSON.stringify(raw)} must be rejected`);
    // Asserting the SPECIFIC message, not just the count: deleting the empty-file branch
    // leaves `JSON.parse('')` throwing its own single error, so a bare count passes either
    // way and the branch can be removed with no test failing.
    assert.match(r.schemaErrors[0], /present but empty/, `${JSON.stringify(raw)} must name emptiness`);
    assert.ok(!r.ok);
  }
});

// ─── readAckFileAtRef: the base-side reader (#2789) ──────────────────────────
//
// This half never runs in the remote runner — the real-tree test skips there, because a
// shallow clone has no `origin/*` to resolve. Without these, replacing the body with
// `return null` would fail nothing while silently restoring the pre-#2789 gate. The git
// runner is injected rather than monkeypatched: deterministic on every OS, and no
// dependence on the host repo's actual refs.

const fakeGit = (handlers) => (args) => {
  if (args[0] === 'ls-tree') return handlers.lsTree ? handlers.lsTree() : `${ACK_REPO_PATH}\n`;
  if (args[0] === 'show') return handlers.show ? handlers.show() : '{}';
  throw new Error(`unexpected git call: ${args.join(' ')}`);
};

test('readAckFileAtRef: absent at the ref is the healthy steady state and returns null', () => {
  // ls-tree exits 0 with EMPTY output when the path simply is not there.
  const doc = readAckFileAtRef(SHA_A, { run: fakeGit({ lsTree: () => '\n' }) });
  assert.equal(doc, null);
});

test('readAckFileAtRef: present and valid parses through', () => {
  const payload = { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'r' } } };
  const doc = readAckFileAtRef(SHA_A, {
    run: fakeGit({ show: () => JSON.stringify(payload) }),
  });
  assert.deepEqual(doc, payload);
});

test('readAckFileAtRef: a READ FAILURE throws — it must never degrade to "inherit nothing"', () => {
  // The whole point. Returning null here looks armed (every entry stays live) but a LIVE
  // entry is precisely the one that CAN CONSUME a delta, so a genuinely new unexplained
  // ripple would come back `acked` instead of `unattributable` — silently the entire
  // pre-#2789 gate. Same law as resolveChangedPaths: a failed git read is an error.
  const boom = () => { throw new Error('injected git failure'); };

  assert.throws(
    () => readAckFileAtRef(SHA_A, { run: fakeGit({ lsTree: boom }) }),
    /could not list the ack/,
  );
  assert.throws(
    () => readAckFileAtRef(SHA_A, { run: fakeGit({ show: boom }) }),
    /exists at .* but could not be read/,
  );
});

test('readAckFileAtRef: present but empty or unparseable throws, like the head-side reader', () => {
  assert.throws(
    () => readAckFileAtRef(SHA_A, { run: fakeGit({ show: () => '   \n' }) }),
    /present at .* but empty/,
  );
  assert.throws(
    () => readAckFileAtRef(SHA_A, { run: fakeGit({ show: () => '{ not json' }) }),
    /is not valid JSON/,
  );
});

test('readAckFileAtRef: refuses an option-shaped ref rather than handing it to git', () => {
  // execFileSync's array form stops shell metacharacters but NOT git's option parsing:
  // `git show` honors --output=<file>, which writes. The guard belongs with the argument,
  // since this helper is exported and its callers are not the only possible ones.
  const never = () => { throw new Error('git must not be invoked at all'); };
  for (const bad of ['--output=/tmp/pwn', '-next', '--upload-pack=x', '', null, undefined, 42]) {
    assert.throws(
      () => readAckFileAtRef(bad, { run: fakeGit({ lsTree: never, show: never }) }),
      /refusing to read the ack/,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('OMITTING baseAck while an ack is present is a loud error, never a silent pass', () => {
  // This is what makes the production seam non-revertible in silence. Drop `baseAck:`
  // from the real-tree call and the gate fails loudly here, instead of quietly restoring
  // #2768 with every other test still green. Same discipline the module already applies
  // to `changedPaths`: a missing input is an error, not an empty set.
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'aaa' }),
    changedPaths: [],
    ack: { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'x' } } },
  });
  assert.ok(!r.ok);
  assert.match(r.errors.join('\n'), /baseAck was not supplied/);
});

test('with no ack ENTRIES, baseAck is not required — the healthy steady state stays quiet', () => {
  // Absence of an ack file is the normal case for almost every PR. It must not be made
  // to carry a new required argument it has no use for — and neither must a document
  // that is present but declares nothing, which `parseAck` accepts as legal (see
  // 'non-object ack JSON is rejected'). Only a real ENTRY can be spent or live, so only
  // a real entry needs the base side.
  for (const ack of [undefined, null, {}, { version: ACK_VERSION }, { paths: {} }]) {
    const r = diffEmitted({
      baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
      current: mf({ [WORKFLOW_KEY]: 'bbb' }),
      changedPaths: [WORKFLOW_SRC],
      ack,
    });
    assert.deepEqual(r.errors, [], `ack ${JSON.stringify(ack)} must need no baseAck`);
    assert.ok(r.ok);
  }
});

test('a spent size-growth ack neither fails nor clears a further growth', () => {
  const ack = { version: ACK_VERSION, paths: { 'plan-phase.md': { reason: 'grew once, deliberately' } } };
  const shared = {
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'aaa' }),
    changedPaths: [],
    ack,
    baseAck: ack,
  };

  // Absorbed: base and current agree on size, so there is no growth left to explain.
  const settled = diffEmitted({ ...shared, sizeBaseline: { 'plan-phase.md': 5000 }, sizeCurrent: { 'plan-phase.md': 5000 } });
  assert.deepEqual(settled.staleAcks, []);
  assert.ok(settled.ok);

  // A further growth is a NEW ripple: the spent ack must not silently absorb it.
  const grewAgain = diffEmitted({ ...shared, sizeBaseline: { 'plan-phase.md': 5000 }, sizeCurrent: { 'plan-phase.md': 5400 } });
  assert.equal(grewAgain.grown.length, 1);
  assert.equal(grewAgain.grown[0].acked, false, 'a spent ack must not clear a further growth');
  assert.ok(!grewAgain.ok);
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
    baseAck: null,
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
    baseAck: null,
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
    baseAck: null,
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

// ─── The failure must name its own remedy (#2778, ADR-2719 §3) ───────────────
//
// A gate that states a requirement and withholds the means of satisfying it is not a
// gate, it is a maintainer round-trip. ADR-2719 §3 makes the acknowledgment a
// *conspicuous declaration a contributor makes deliberately* — which only works if the
// contributor can discover how to make it. Observed live on #2543: real growth from a
// legitimate feature change, a red lane, and no self-serve path out of it.
//
// These assert on `buildReport`'s typed IR, not on rendered prose — CONTRIBUTING.md
// ("Prohibited: Raw Text Matching on Test Outputs") requires a human formatter to expose
// a structured surface so a reworded sentence is never a failing test. Exactly two tests
// below touch the rendered string, and only to prove the renderer emits the IR at all.
//
// They also use the bare `buildReport(r)` / `formatReport(r)` form, because that is what
// the real-tree test at the bottom of this file calls: a row that only ever passed an
// explicit `sampleLimit` would prove a property no shipping caller exercises.

/** The growth-only shape: a size ratchet trip with NO unattributable hash movement. */
const growthOnly = (extra = {}) => diffEmitted({
  baseline: mf({}),
  current: mf({}),
  changedPaths: [],
  sizeBaseline: { 'explore.md': 11127 },
  sizeCurrent: { 'explore.md': 13230 },
  // Sits BEFORE the spread so a row can still override it, while every row that passes
  // an `ack` inline gets the explicit "nothing inherited from the base" reading rather
  // than tripping `diffEmitted`'s required-baseAck error (#2789).
  baseAck: null,
  ...extra,
});

/** The one block of `kind`, or undefined. */
const blockOf = (report, kind) => report.blocks.find((b) => b.kind === kind);

test('a growth-only failure carries the byte delta, the key rule, and an ack entry', () => {
  // The pre-#2778 report stopped after the byte delta. The suite's only coverage of the
  // remediation reached it through the UNATTRIBUTABLE branch, so a growth-only regression
  // was invisible — which is why this fixture carries no hash movement at all.
  const r = growthOnly();
  assert.equal(r.unattributable.length, 0, 'this fixture must isolate the growth branch');
  assert.ok(!r.ok);

  const report = buildReport(r);
  const growth = blockOf(report, 'unacked-growth');
  assert.ok(growth, 'the growth branch must produce a block');
  assert.equal(growth.count, 1);
  assert.deepEqual(growth.items[0], {
    name: 'explore.md', from: 11127, to: 13230, delta: 2103, acked: false,
  });
  assert.equal(growth.keyRule, REMEDIATION.growthKeyRule, 'growth keys on the bare filename');

  assert.deepEqual(report.ackable, [
    { key: 'explore.md', reason: REMEDIATION.growthReason },
  ], 'the ack entry must be keyed on the file that actually grew');
});

test('the renderer emits the ack file, the document, and the do-not-regenerate line', () => {
  // The one place rendered text is the object of the test: proving the IR above actually
  // reaches the contributor. Everything it asserts is an identity comparison against the
  // frozen surface, so rewording any sentence cannot fail this.
  const msg = formatReport(growthOnly());
  assert.ok(msg.includes('explore.md grew 2103 bytes (11127 -> 13230)'), 'the delta still leads');
  assert.ok(msg.includes(REMEDIATION.ackFile), 'the message must name the ack file');
  assert.ok(msg.includes(REMEDIATION.createIfAbsent), 'it must say the file may not exist yet');
  assert.ok(msg.includes(REMEDIATION.growthKeyRule), 'it must state the bare-filename key rule');
  assert.ok(msg.includes(REMEDIATION.doNotRegenerate), 'it must say not to regenerate');
  assert.ok(
    msg.includes(REMEDIATION.ackDocument([{ key: 'explore.md', reason: REMEDIATION.growthReason }])),
    'the printed document must be the one the IR describes',
  );
});

test('the document the report teaches is accepted by parseAck', () => {
  // The divergence killer. A report that teaches a schema the parser rejects is worse
  // than no report: the contributor follows it, is rejected anyway, and now distrusts the
  // gate. This pins the taught shape to the accepted shape in one assertion.
  const taught = REMEDIATION.ackDocument([{ key: 'explore.md', reason: 'a real reason' }]);
  const { entries, errors } = parseAck(JSON.parse(taught));
  assert.deepEqual(errors, [], 'the taught document must parse with zero errors');
  assert.equal(entries.get('explore.md').reason, 'a real reason');

  // And it must actually clear the gate it is offered to clear.
  const r = growthOnly({ ack: JSON.parse(taught) });
  assert.equal(r.grown[0].acked, true);
  assert.deepEqual(r.staleAcks, []);
  assert.ok(r.ok, 'following the printed instructions must turn the lane green');
});

test('the taught document derives its version from ACK_VERSION', () => {
  // A hand-typed `"version": 1` beside a live ACK_VERSION is the generative-fix-divergence
  // class: bump one, the other lies. Asserting the relationship — not the literal — is
  // what makes the bump safe.
  assert.equal(JSON.parse(REMEDIATION.ackDocument([{ key: 'x.md', reason: 'r' }])).version, ACK_VERSION);
});

test('the remediation surface is frozen and names the ack file once', () => {
  assert.ok(Object.isFrozen(REMEDIATION), 'the exported surface must not be mutable');
  assert.equal(REMEDIATION.ackFile, ACK_FILE, 'one definition, not a second literal');
});

test('a ripple and a growth in one report share ONE document', () => {
  // The combination nobody writes down, and the most likely real shape: a feature PR that
  // both grows a workflow AND ripples an emitted path.
  //
  // Caught in review: printing a complete document per branch made each read as "the file
  // to create", so a contributor pasting the second over the first silently loses the
  // first acknowledgment — an ack-lost failure with no signal. One document, one file.
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'bbb' }),
    changedPaths: ['README.md'],
    sizeBaseline: { 'explore.md': 11127 },
    sizeCurrent: { 'explore.md': 13230 },
  });
  const report = buildReport(r);
  assert.equal(blockOf(report, 'unattributable').keyRule, REMEDIATION.rippleKeyRule);
  assert.equal(blockOf(report, 'unacked-growth').keyRule, REMEDIATION.growthKeyRule);

  // Both key spaces, one ack set, in list order.
  assert.deepEqual(report.ackable, [
    { key: WORKFLOW_KEY, reason: REMEDIATION.rippleReason },
    { key: 'explore.md', reason: REMEDIATION.growthReason },
  ]);

  // And the rendered document is genuinely one object holding both.
  const doc = JSON.parse(REMEDIATION.ackDocument(report.ackable));
  assert.deepEqual(Object.keys(doc.paths).sort(), [WORKFLOW_KEY, 'explore.md'].sort());
  const { errors } = parseAck(doc);
  assert.deepEqual(errors, [], 'the combined document must parse');

  const msg = formatReport(r);
  assert.equal(
    msg.split('{"version"').length - 1, 1,
    'exactly one document may be printed — two would invite pasting one over the other',
  );
});

test('a stale ack names the file it lives in and the delete-the-file case', () => {
  // Pre-#2778 this said acks "must be deleted" without naming the file they live in. It
  // also never said what to do when the last entry goes: an empty-but-present ack file
  // parses fine and is "legal", but it destroys the ADR-2719 §3 property that the file's
  // PRESENCE is the alarm.
  const r = diffEmitted({
    baseline: mf({ [WORKFLOW_KEY]: 'aaa' }),
    current: mf({ [WORKFLOW_KEY]: 'aaa' }),
    changedPaths: [],
    ack: { version: ACK_VERSION, paths: { [WORKFLOW_KEY]: { reason: 'old' } } },
    baseAck: null,
  });
  const stale = blockOf(buildReport(r), 'stale-acks');
  assert.deepEqual(stale.items, [WORKFLOW_KEY]);
  assert.equal(stale.fix, REMEDIATION.staleAckFix);
  assert.match(stale.fix, /delete the file/, 'the last-entry case must be covered');

  // A stale-only report has nothing to acknowledge — it must NOT offer a document.
  assert.deepEqual(buildReport(r).ackable, [], 'deleting an ack is not acknowledging one');
});

test('growth and a stale ack in one report keep both remedies', () => {
  // The contributor is adding one entry and removing another in the same file.
  const r = growthOnly({ ack: { version: ACK_VERSION, paths: { 'gone.md': { reason: 'outlived' } } } });
  assert.deepEqual(r.staleAcks, ['gone.md']);
  assert.equal(r.grown[0].acked, false);

  const report = buildReport(r);
  assert.ok(blockOf(report, 'unacked-growth'), 'the growth still needs an ack');
  assert.ok(blockOf(report, 'stale-acks'), 'the stale entry still needs deleting');
  assert.deepEqual(report.ackable, [{ key: 'explore.md', reason: REMEDIATION.growthReason }],
    'only the growth is ackable; the stale entry is removed, not added');
});

test('the validation early-return renders instead of throwing', () => {
  // Found while building #2778. diffEmitted's input-validation early return omitted
  // `newFileCapExceeded`, and formatReport reads `result.newFileCapExceeded.length`
  // unconditionally — so this path threw `TypeError: Cannot read properties of
  // undefined` instead of printing its errors.
  //
  // Worst possible place for it: this branch is what runs when `git diff` failed or a
  // manifest came back malformed. The crash replaced the only message that would have
  // named the infrastructure problem, and a TypeError in a test helper reads like a
  // broken test rather than a broken environment.
  for (const bad of [
    { baseline: null, current: {}, changedPaths: [] },
    { baseline: {}, current: null, changedPaths: [] },
    { baseline: {}, current: {}, changedPaths: null },
    { baseline: [], current: {}, changedPaths: [] },
  ]) {
    const r = diffEmitted(bad);
    assert.ok(!r.ok);
    assert.ok(r.errors.length > 0);
    assert.deepEqual(r.newFileCapExceeded, [], 'every returned shape must carry every bucket');

    const report = buildReport(r);
    assert.equal(blockOf(report, 'errors').count, r.errors.length, 'the errors must render');
    assert.deepEqual(report.ackable, [], 'a malformed input is not something to acknowledge');
  }
});

test('a failed git diff renders as an error, never as "nothing changed"', () => {
  // The comment on that validation branch says a failed `git diff` must never be read as
  // an empty change set. That contract is only worth anything if the resulting report is
  // renderable — which it was not until the bucket above was restored.
  const r = diffEmitted({ baseline: mf({}), current: mf({}), changedPaths: null });
  assert.match(r.errors.join('\n'), /changedPaths must be an array/);
  assert.match(formatReport(r), /changedPaths must be an array/);
});

test('a passing result produces no blocks and nothing to acknowledge', () => {
  // Remediation must never leak into a green run — it is failure text, not advice.
  const report = buildReport(diffEmitted({ baseline: mf({}), current: mf({}), changedPaths: [] }));
  assert.deepEqual(report.blocks, []);
  assert.deepEqual(report.ackable, []);
  assert.equal(formatReport(diffEmitted({ baseline: mf({}), current: mf({}), changedPaths: [] })), '');
});

test('an acked growth produces no block and nothing to acknowledge', () => {
  // The contributor already did the thing the remediation asks for; repeating it is noise.
  const r = growthOnly({
    ack: { version: ACK_VERSION, paths: { 'explore.md': { reason: 'new mode section' } } },
    baseAck: null,
  });
  assert.ok(r.ok);
  const report = buildReport(r);
  assert.equal(blockOf(report, 'unacked-growth'), undefined, 'an acknowledged growth is not a failure');
  assert.deepEqual(report.ackable, []);
});

test('shrinkage produces no block and nothing to acknowledge', () => {
  const r = diffEmitted({
    baseline: mf({}), current: mf({}), changedPaths: [],
    sizeBaseline: { 'a.md': 9000 }, sizeCurrent: { 'a.md': 8000 },
  });
  assert.deepEqual(buildReport(r).blocks, [], 'shrinkage is reported in the result, never as failure');
  assert.deepEqual(buildReport(r).ackable, []);
});

test('a mixed grown set offers an ack entry only for the unacked files', () => {
  const r = diffEmitted({
    baseline: mf({}), current: mf({}), changedPaths: [],
    sizeBaseline: { 'kept.md': 100, 'loud.md': 100 },
    sizeCurrent: { 'kept.md': 200, 'loud.md': 200 },
    ack: { version: ACK_VERSION, paths: { 'kept.md': { reason: 'declared' } } },
    baseAck: null,
  });
  const report = buildReport(r);
  const growth = blockOf(report, 'unacked-growth');
  assert.equal(growth.count, 1, 'only the unacked one is counted');
  assert.deepEqual(growth.items.map((g) => g.name), ['loud.md']);
  assert.deepEqual(report.ackable, [{ key: 'loud.md', reason: REMEDIATION.growthReason }],
    'the document must key on the unacked file, not the acked one');
});

test('the ack set is capped at the sample limit at limit-1 / limit / limit+1', () => {
  // CLAUDE.md's boundary rule. The document must not name rows the report chose not to
  // print — a contributor cannot acknowledge a path they were never shown.
  const build = (n) => {
    const sizeBaseline = {}; const sizeCurrent = {};
    for (let i = 0; i < n; i++) {
      const k = `g${String(i).padStart(3, '0')}.md`;
      sizeBaseline[k] = 100; sizeCurrent[k] = 200;
    }
    return diffEmitted({ baseline: mf({}), current: mf({}), changedPaths: [], sizeBaseline, sizeCurrent });
  };
  for (const [n, expected] of [[19, 19], [20, 20], [21, 20]]) {
    const report = buildReport(build(n), { sampleLimit: 20 });
    assert.equal(blockOf(report, 'unacked-growth').count, n, `count reports all ${n}`);
    assert.equal(report.ackable.length, expected, `the document names ${expected} at n=${n}`);
    assert.ok(
      formatReport(build(n), { sampleLimit: 20 }).includes(REMEDIATION.growthKeyRule),
      `the key rule must survive n=${n}`,
    );
  }
});

test('the new-file cap block carries no ack affordance', () => {
  // The cap is NOT ack-able — the fix is extraction. Offering a document here would teach
  // a contributor to write an entry that cannot clear the gate, which is worse than the
  // silence it replaced.
  const r = diffEmitted({
    baseline: mf({}), current: mf({}), changedPaths: [],
    sizeBaseline: {}, sizeCurrent: { 'new-workflow.md': NEW_FILE_CAP + 1 },
  });
  const report = buildReport(r);
  const cap = blockOf(report, 'new-file-cap');
  assert.equal(cap.count, 1);
  assert.equal(cap.keyRule, undefined, 'the cap has no key rule because it has no ack');
  assert.deepEqual(report.ackable, [], 'the cap must never offer an acknowledgment');
  assert.ok(!formatReport(r).includes(REMEDIATION.ackFile), 'and must not point at the ack file');
});

// ─── New-file cap (ADR-1610 Decision point 3, revived after #2724) ───────────
//
// tests/workflow-size-baseline.json used to double as the "has this file been
// baselined before" signal a NEW_FILE_CAP check keyed off. #2724 deleted it without
// reviving that check anywhere — a brand-new workflow/agent file (present in
// sizeCurrent, absent from sizeBaseline) got zero size scrutiny at all, silently
// loosening the bound from 32768 (ADR-1610) to whichever tier cap it happened to
// fall under (DEFAULT_CAP = 40960, nearly 8 KiB looser) with nothing in CI to say so.
// A file in that gap risks silent truncation at the Codex `project_doc_max_bytes`
// anchor. Not ack-able — same as the tier hard caps, the fix is extraction.

test('a brand-new file at exactly the cap is accepted (limit)', () => {
  const r = diffEmitted({
    baseline: mf({}), current: mf({}), changedPaths: [],
    sizeBaseline: {}, sizeCurrent: { 'new-workflow.md': NEW_FILE_CAP },
  });
  assert.deepEqual(r.newFileCapExceeded, []);
  assert.ok(r.ok, `exactly ${NEW_FILE_CAP} bytes must be accepted`);
});

test('a brand-new file one byte over the cap is rejected (limit+1)', () => {
  const r = diffEmitted({
    baseline: mf({}), current: mf({}), changedPaths: [],
    sizeBaseline: {}, sizeCurrent: { 'new-workflow.md': NEW_FILE_CAP + 1 },
  });
  assert.deepEqual(r.newFileCapExceeded, [
    { name: 'new-workflow.md', bytes: NEW_FILE_CAP + 1, cap: NEW_FILE_CAP },
  ]);
  assert.ok(!r.ok, `${NEW_FILE_CAP + 1} bytes must be rejected`);
  assert.match(formatReport(r), /new-workflow\.md is 32769 bytes/);
});

test('a brand-new file one byte under the cap is accepted (limit-1)', () => {
  const r = diffEmitted({
    baseline: mf({}), current: mf({}), changedPaths: [],
    sizeBaseline: {}, sizeCurrent: { 'new-workflow.md': NEW_FILE_CAP - 1 },
  });
  assert.deepEqual(r.newFileCapExceeded, []);
  assert.ok(r.ok, `${NEW_FILE_CAP - 1} bytes must be accepted`);
});

test('the new-file cap is not ack-able (extraction, not acknowledgment, is the fix)', () => {
  const r = diffEmitted({
    baseline: mf({}), current: mf({}), changedPaths: [],
    sizeBaseline: {}, sizeCurrent: { 'new-workflow.md': NEW_FILE_CAP + 1 },
    ack: { version: ACK_VERSION, paths: { 'new-workflow.md': { reason: 'trying to bypass it' } } },
    baseAck: null,
  });
  assert.equal(r.newFileCapExceeded.length, 1, 'an ack entry must not exempt the new-file cap');
  assert.ok(!r.ok);
});

test('an existing (baselined) file is governed by growth, not the new-file cap', () => {
  // A file already IN sizeBaseline is not "new" even if it happens to sit above
  // NEW_FILE_CAP — that is the tier hard cap's job, not this one's.
  const r = diffEmitted({
    baseline: mf({}), current: mf({}), changedPaths: [],
    sizeBaseline: { 'old.md': NEW_FILE_CAP + 5000 },
    sizeCurrent: { 'old.md': NEW_FILE_CAP + 5000 },
  });
  assert.deepEqual(r.newFileCapExceeded, []);
  assert.deepEqual(r.grown, []);
  assert.ok(r.ok);
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
  //
  // #2854: this fixture used to be named '/tmp/from-cache-restore.json', which asserted
  // the exact conflation that broke CI — a CI cache restore is NOT an operator pin, and
  // naming it one here documented the defect as intended behavior. The hard stop is a
  // real guarantee for a HAND-SET path and is preserved; what changed is that CI no
  // longer routes its restore through this door at all.
  const envStale = resolveBaseline({
    expectedSha: SHA_A,
    env: { [BASELINE_ENV]: '/tmp/operator-pinned-baseline.json' },
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

// ── #2854: a CI cache restore is not an operator pin ─────────────────────────────
//
// ADR-2719 §5: "Cache miss falls back to an in-job build at `origin/next`." The PR lane
// restores the baseline keyed on the PR's RECORDED base sha (`test.yml:198`) while the
// gate resolves the base ref LIVE (`resolveBase()`), so the two drift whenever `next`
// advances between a PR's last sync and its run. The restore was published straight to
// GSD_EMITTED_BASELINE, where a mismatch is fatal — turning a recoverable cache into a
// hard failure on diffs that touched nothing related. The export step is the boundary
// that must be conservative in what it sends.

const CI_CACHE_PATH = '.gsd-cache/emitted-baseline.json';

/** Resolve exactly as CI does: cache restored to the DEFAULT path, nothing announced. */
const resolveAsCI = (doc, expectedSha = SHA_A) => resolveBaseline({
  expectedSha,
  env: {},                                   // no operator pin — this is the whole point
  cachePath: CI_CACHE_PATH,
  readJson: typeof doc === 'function' ? doc : () => doc,
  buildFallback: () => goodBaseline(expectedSha),
});

test('#2854: a drifted cache restore degrades to the in-job build', () => {
  const r = resolveAsCI(goodBaseline(SHA_B));    // restored under a drifted key
  assert.ok(r.ok, `must resolve via the in-job build; got: ${(r.errors || []).join('; ')}`);
  assert.equal(r.via, 'build');
  assert.equal(r.sha, SHA_A);
  assert.deepEqual(r.attempted, [`cache:${CI_CACHE_PATH}`, 'build'],
    'the cache must be tried and rejected before the build, and the trail must say so');
});

test('#2854: a current cache restore is used directly (the fast path survives)', () => {
  const r = resolveAsCI(goodBaseline(SHA_A));
  assert.ok(r.ok);
  assert.equal(r.via, `cache:${CI_CACHE_PATH}`, 'a valid cache must not pay for a rebuild');
});

test('#2854: every recoverable malformation degrades rather than failing the run', () => {
  // The blocker an isolated reviewer caught: an earlier revision gated only on sha
  // equality, so a doc with the RIGHT sha but a wrong schema version or broken
  // manifests was announced as an operator pin and hard-stopped downstream —
  // reproducing this bug's own class, triggered by malformation instead of staleness.
  // Routing through the cache path makes every one of these recoverable by construction.
  const cases = {
    'stale sha': goodBaseline(SHA_B),
    'wrong schema version': { version: BASELINE_VERSION + 998, sha: SHA_A, manifests: { c: {} }, sizes: {} },
    'manifests is an array': { version: BASELINE_VERSION, sha: SHA_A, manifests: [], sizes: {} },
    'manifests absent': { version: BASELINE_VERSION, sha: SHA_A },
    'sha absent': { version: BASELINE_VERSION, manifests: { c: {} }, sizes: {} },
    'sha not 40-hex': { version: BASELINE_VERSION, sha: 'g'.repeat(40), manifests: { c: {} }, sizes: {} },
    'absent file': null,
  };

  for (const [name, doc] of Object.entries(cases)) {
    const r = resolveAsCI(doc);
    assert.ok(r.ok, `${name}: must degrade to the build, not fail — got ${(r.errors || []).join('; ')}`);
    assert.equal(r.via, 'build', `${name}: must reach the in-job build`);
  }
});

test('#2854: sha length boundary — 39, 40, 41 hex', () => {
  // limit-1 / limit / limit+1 on the 40-hex contract validateBaseline enforces.
  for (const len of [39, 41]) {
    const r = resolveAsCI({ version: BASELINE_VERSION, sha: 'a'.repeat(len), manifests: { c: {} }, sizes: {} });
    assert.equal(r.via, 'build', `${len} hex is not a sha — must not be used as the baseline`);
  }
  const exact = resolveAsCI(goodBaseline(SHA_A));
  assert.equal(exact.via, `cache:${CI_CACHE_PATH}`, '40 hex matching is the contract');
});

test('#2854: valid JSON that is not an object degrades rather than passing vacuously', () => {
  for (const doc of [0, 'str', [], true]) {
    const r = resolveAsCI(doc);
    assert.ok(r.ok, `${JSON.stringify(doc)}: must degrade to the build`);
    assert.equal(r.via, 'build', `${JSON.stringify(doc)} must never read as a usable baseline`);
  }
});

test('#2854: an unreadable cache degrades and does not throw', () => {
  // Deterministic IO failure by injection — never chmod 0o000, which root bypasses.
  const r = resolveAsCI(() => { throw new Error('EACCES: permission denied'); });
  assert.ok(r.ok);
  assert.equal(r.via, 'build');
});

test('#2854: the cache is used exactly when it is valid for the sha under test', () => {
  const hex40 = fc.string({
    unit: fc.constantFrom(...'0123456789abcdef'), minLength: 40, maxLength: 40,
  });
  fc.assert(fc.property(hex40, hex40, (built, expected) => {
    const r = resolveAsCI(goodBaseline(built), expected);
    // Always resolves; the only question is whether it paid for a rebuild.
    if (!r.ok) return false;
    return (r.via === `cache:${CI_CACHE_PATH}`) === (built === expected);
  }), { numRuns: 200 });
});

test('#2854: the gate is pinned to the SAME base the tree was merged with', () => {
  // The deepest half of this bug. "Rebase check" merges `pull_request.base.sha`,
  // pinned by #2472 so all 12 matrix jobs agree on one tree. But resolveBase()
  // otherwise falls through to `origin/next`, which `fetch-depth: 0` leaves at the
  // LIVE tip. When `next` advanced mid-flight the gate compared a tree built on
  // base.sha against a baseline at a NEWER commit — so the correctly-keyed cache
  // was rejected as "stale" and the run died. Worse than dying would be surviving:
  // a baseline at the wrong commit attributes other people's merges to this PR.
  //
  // Two surfaces read one value, which is the generative-divergence shape this repo
  // has been bitten by before, so the parity is asserted rather than assumed.
  const yaml = require('js-yaml');
  const wf = yaml.load(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'));

  const jobsUnderTest = Object.entries(wf.jobs).filter(([, job]) =>
    (job.steps || []).some((s) => typeof s.run === 'string' && s.run.includes('ci-rebase-check.cjs')));

  assert.ok(jobsUnderTest.length >= 2,
    `expected the rebase-pinned jobs to be found, got ${jobsUnderTest.length}`);

  for (const [name, job] of jobsUnderTest) {
    const rebaseStep = job.steps.find((s) => typeof s.run === 'string' && s.run.includes('ci-rebase-check.cjs'));
    const mergedBase = (rebaseStep.env || {}).CI_REBASE_BASE_SHA;
    const gateBase = (job.env || {}).GSD_EMITTED_BASE;

    assert.ok(mergedBase, `job ${name}: rebase step must pin CI_REBASE_BASE_SHA`);
    assert.equal(gateBase, mergedBase,
      `job ${name}: the emitted gate's base (GSD_EMITTED_BASE=${JSON.stringify(gateBase)}) must equal ` +
      `the commit the tree was merged with (CI_REBASE_BASE_SHA=${JSON.stringify(mergedBase)}). ` +
      'Diverging them makes the differential compare a tree against a baseline from a ' +
      'different commit, which mis-attributes unrelated merges to this PR.');
  }
});

test('#2854: an explicit base pin outranks the live branch tip', () => {
  // The mechanism the workflow pin relies on: GSD_EMITTED_BASE must win over
  // origin/<base>, or setting it in CI would change nothing.
  const pinned = 'c'.repeat(40);
  assert.equal(baseRefCandidates({ GSD_EMITTED_BASE: pinned, GITHUB_BASE_REF: 'next' })[0], pinned,
    'an explicit pin must be tried before origin/next');
});

test('#2854: an EMPTY base pin is ignored, not treated as a candidate', () => {
  // The pin is job-level env, so on push/workflow_dispatch — where there is no
  // pull_request — `${{ github.event.pull_request.base.sha }}` renders as an empty
  // string rather than being unset. baseRefCandidates' truthy check already excludes
  // it, but nothing asserted that, so narrowing the check to `!== undefined` would
  // silently push '' as the first candidate and have `git rev-parse ''` decide the
  // baseline. Pinned here because the workflow now guarantees this input shape.
  assert.deepEqual(
    baseRefCandidates({ GSD_EMITTED_BASE: '', GITHUB_BASE_REF: 'next' }),
    baseRefCandidates({ GITHUB_BASE_REF: 'next' }),
    'an empty pin must behave exactly as an absent one',
  );
  assert.ok(!baseRefCandidates({ GSD_EMITTED_BASE: '', GITHUB_BASE_REF: 'next' }).includes(''),
    'the empty string must never become a base-ref candidate');
});

test('#2854: the resolution summary names only sources actually attempted', () => {
  // The caller's assertion message hardcoded "(tried env, <cache>, and an in-job build)"
  // on every failure, including early returns that reached none of them.
  const envOnly = resolveBaseline({
    expectedSha: SHA_A,
    env: { [BASELINE_ENV]: '/tmp/operator-pinned-baseline.json' },
    cachePath: 'cache.json',
    readJson: () => goodBaseline(SHA_B),
    buildFallback: () => goodBaseline(SHA_A),
  });
  assert.ok(!envOnly.ok);
  assert.deepEqual(envOnly.attempted, [`env:${BASELINE_ENV}`],
    'an env hard stop reaches neither the cache nor the build — the summary must say so');

  const allThree = resolveBaseline({
    expectedSha: SHA_A, env: {}, cachePath: 'cache.json',
    readJson: () => goodBaseline(SHA_B),
    buildFallback: () => goodBaseline(SHA_A),
  });
  assert.deepEqual(allThree.attempted, ['cache:cache.json', 'build']);
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

// ─── buildBaselineAtRef: the in-job build must bootstrap without its own generator ──

test(
  'buildBaselineAtRef resolves a baseline via the in-job build even when the generator '
  + 'script is absent at the ref (#2767 regression)',
  { timeout: 300_000 },
  (t) => {
    // Mirrors "differential attribution over the real tree": install output is
    // platform-specific on Windows, and this drives the same heavy worktree +
    // build:lib + 19-installer pipeline.
    if (process.platform === 'win32') {
      t.skip('emitted parity is asserted on macOS + Linux; Windows install output is platform-specific');
      return;
    }

    // Hermetic by construction (#2767 review finding B). This test used to resolve a
    // real base ref (typically `origin/next`) and skip unless that ref, checked via
    // `git cat-file -e`, still LACKED scripts/gen-emitted-baseline.cjs — the file THIS
    // PR adds. That was true only until this PR merged: after merge every resolvable
    // base ref carries the file, the precondition is permanently false, and the test
    // would skip forever, losing all regression value silently (a skip reads as green).
    // It also depended on `origin/next` being resolvable at all, which the gsd-test
    // runner's shallow clone + base/head merge does not guarantee (no remote-tracking
    // refs) — the same non-hermetic-history failure mode "baseline families are
    // enumerated from the ref, not from the current registry" (above) was rewritten to
    // avoid, by building its own throwaway git repo instead of reaching for this
    // repo's history.
    //
    // That precedent doesn't directly transplant here: `buildBaselineAtRef` needs a
    // REAL, buildable gsd-core tree (`npm run build:lib`, the compiled `bin/lib/*.cjs`,
    // `node_modules`) to produce a real manifest — a minimal from-scratch repo has none
    // of that. So instead of a from-scratch repo, this synthesizes the missing-generator
    // condition IN-PLACE with git plumbing: read this checkout's own HEAD tree into a
    // scratch index (a temp `GIT_INDEX_FILE`, never the real `.git/index`), remove just
    // `scripts/gen-emitted-baseline.cjs` from that index, write the resulting tree, and
    // commit it as a child of HEAD. The result is one loose commit object — a real,
    // buildable tree identical to HEAD's except missing the one file under test — that
    // is never referenced by any branch, tag, or ref, so it is not checked out, not
    // pushed, and needs no cleanup beyond the scratch index directory itself. The real
    // working tree, HEAD, and index of this checkout are never touched.
    const tmpIndexDir = createTempDir('emitted-baseline-synth-index-');
    t.after(() => cleanup(tmpIndexDir));
    const tmpIndexFile = path.join(tmpIndexDir, 'index');
    const gitEnv = {
      ...process.env,
      GIT_INDEX_FILE: tmpIndexFile,
      GIT_AUTHOR_NAME: 'GSD Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'GSD Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    // `-c safe.directory=<REPO_ROOT>` via the shared `safeDirArgs` (emitted-runtime.cjs):
    // the remote runner mounts this repo at a path owned by a different uid, and git's
    // dubious-ownership protection refuses every operation there otherwise — this test
    // proved that the hard way (#2767 review) when its first `git rev-parse HEAD` failed
    // closed. Reusing the SAME helper `buildBaselineAtRef` now uses (below) rather than
    // hand-rolling the flag here keeps the fix from silently diverging per call site.
    const run = (...args) => execFileSync('git', [...safeDirArgs(REPO_ROOT), ...args], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    const headSha = run('rev-parse', 'HEAD');
    run('read-tree', 'HEAD');
    run('update-index', '--force-remove', 'scripts/gen-emitted-baseline.cjs');
    const syntheticTree = run('write-tree');
    const syntheticSha = run(
      'commit-tree', syntheticTree, '-p', headSha, '-m',
      'synthetic: missing scripts/gen-emitted-baseline.cjs (#2767 test fixture — unreferenced, never pushed)',
    );

    // Precondition, ASSERTED not assumed: the synthetic commit truly lacks the file —
    // otherwise this test would prove nothing.
    assert.throws(
      () => execFileSync('git', [...safeDirArgs(REPO_ROOT), 'cat-file', '-e', `${syntheticSha}:scripts/gen-emitted-baseline.cjs`], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, stdio: 'pipe',
      }),
      /./,
      'the synthetic ref must genuinely lack the generator script for this test to prove anything',
    );

    // The actual regression assertion: this must NOT throw "Cannot find module", and
    // must produce a well-formed baseline artifact measuring the SYNTHETIC ref, not the
    // caller's own tree. Before the #2767 fix, `buildBaselineAtRef` unconditionally ran
    // `<worktreeDir>/scripts/gen-emitted-baseline.cjs` — the checked-out WORKTREE'S OWN
    // copy — which fails closed with `Cannot find module` for exactly this ref shape.
    const artifact = buildBaselineAtRef(syntheticSha, { cwd: REPO_ROOT });
    assert.equal(artifact.version, BASELINE_VERSION);
    assert.equal(
      artifact.sha, syntheticSha,
      'the artifact must report the REF\'s sha, not the caller checkout\'s',
    );
    assert.ok(artifact.manifests && typeof artifact.manifests === 'object');
    assert.ok(
      Object.keys(artifact.manifests).length >= MINIMUM_MANIFEST_FAMILIES,
      `expected at least ${MINIMUM_MANIFEST_FAMILIES} manifest families, got ${Object.keys(artifact.manifests).length}`,
    );
    assert.ok(artifact.sizes && Object.keys(artifact.sizes).length > 0, 'sizes must be non-empty');
  },
);

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
          baseAck: null,
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

// ─── Family reconciliation (#2723 correction) ────────────────────────────────
//
// #2723 shipped `EXPECTED_MANIFEST_COUNT = 19` asserted against BOTH the baseline (built
// at the base ref) and the current tree (built at PR HEAD). Those sides legitimately
// differ by one family whenever a PR adds or removes a runtime, so no value satisfied
// both: 19 rejected the current side, 20 rejected the baseline side. Every runtime-adding
// PR was hard-blocked — found by tracing #2005 (Qoder) through the gate.
//
// Driven at PURE-FUNCTION altitude on purpose. The real-tree test below skips wherever no
// base ref exists (the gsd-test runner shallow-clones, so `origin/*` is absent), so a
// regression written at that altitude would silently skip on the very runner that has to
// prove RED.

const ALL_FAMILIES = MANIFEST_FAMILIES.map((f) => f.name);
const REGISTRY_CHANGE = ['tests/helpers/install-shared.cjs'];
// The shape a shipping caller passes: repo-relative POSIX paths from `git diff --name-only`.
const CONTENT_ONLY_CHANGE = ['gsd-core/workflows/plan-phase.md'];

const derivedOf = (names) => names.map((name) => ({ name, runtime: name, scope: 'global' }));
const manifestsOf = (names) => Object.fromEntries(names.map((n) => [n, { 'some/emitted/path': 'hash' }]));

/** Build a fully-consistent reconciliation input, then override one facet per test. */
function reconcileWith({ derivedNames = ALL_FAMILIES, fixtureNames, baselineNames, currentNames, ...rest }) {
  return reconcileFamilies({
    derived: derivedOf(derivedNames),
    fixtures: fixtureNames || derivedNames,
    baseline: manifestsOf(baselineNames || derivedNames),
    current: manifestsOf(currentNames || derivedNames),
    changedPaths: CONTENT_ONLY_CHANGE,
    ...rest,
  });
}

const codesOf = (r) => r.errors.map((e) => e.code);

test('reason codes are a frozen, locked set', () => {
  assert.deepEqual(Object.keys(FAMILY_REASON).sort(), [
    'ADDED_UNATTRIBUTED', 'BAD_CHANGED_PATHS', 'BASELINE_UNUSABLE', 'BELOW_FLOOR',
    'CURRENT_UNUSABLE', 'DERIVED_UNUSABLE', 'DROPPED_UNATTRIBUTED',
    'FIXTURES_UNUSABLE', 'FIXTURE_WITHOUT_RUNTIME', 'MISSING_CLAUDE_LOCAL',
    'RUNTIME_WITHOUT_FIXTURE',
  ]);
  assert.ok(Object.isFrozen(FAMILY_REASON));
});

test('passes when every family signal agrees', () => {
  assert.deepEqual(reconcileWith({}), { ok: true, errors: [] });
});

test('the count export agrees with the derived family set (divergence guard)', () => {
  // The #2723 defect was two surfaces carrying independent notions of this number.
  assert.equal(EXPECTED_MANIFEST_COUNT, MANIFEST_FAMILIES.length);
  assert.ok(EXPECTED_MANIFEST_COUNT >= MINIMUM_MANIFEST_FAMILIES);
});

// ── The deadlock itself ──────────────────────────────────────────────────────

test('permits an added family attributed to a runtime-registry change', () => {
  const withQoder = [...ALL_FAMILIES, 'qoder'];
  const r = reconcileWith({
    derivedNames: withQoder,
    baselineNames: ALL_FAMILIES,   // base ref predates the new runtime
    currentNames: withQoder,
    changedPaths: REGISTRY_CHANGE,
  });
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('rejects an added family with no runtime-registry change, naming it', () => {
  const withQoder = [...ALL_FAMILIES, 'qoder'];
  const r = reconcileWith({
    derivedNames: withQoder,
    baselineNames: ALL_FAMILIES,
    currentNames: withQoder,
    changedPaths: CONTENT_ONLY_CHANGE,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [{ code: FAMILY_REASON.ADDED_UNATTRIBUTED, family: 'qoder' }]);
});

test('permits a dropped family attributed to a runtime-registry change', () => {
  const without = ALL_FAMILIES.filter((n) => n !== 'trae');
  const r = reconcileWith({
    derivedNames: without,
    baselineNames: ALL_FAMILIES,
    currentNames: without,
    changedPaths: REGISTRY_CHANGE,
    minimum: 18,
  });
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('rejects a silently dropped family, naming it', () => {
  const without = ALL_FAMILIES.filter((n) => n !== 'trae');
  const r = reconcileWith({
    derivedNames: without,
    baselineNames: ALL_FAMILIES,
    currentNames: without,
    changedPaths: CONTENT_ONLY_CHANGE,
    minimum: 18,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [{ code: FAMILY_REASON.DROPPED_UNATTRIBUTED, family: 'trae' }]);
});

test('attribution is the ONLY permission path, symmetrically', () => {
  // No ack-style bypass on either side: a one-sided escape hatch would make removals
  // easier to wave through than additions, and the drift-ack file covers unattributable
  // emitted-PATH deltas, not family churn.
  const without = ALL_FAMILIES.filter((n) => n !== 'trae');
  const added = [...ALL_FAMILIES, 'qoder'];
  for (const [names, baselineNames, code, family] of [
    [without, ALL_FAMILIES, FAMILY_REASON.DROPPED_UNATTRIBUTED, 'trae'],
    [added, ALL_FAMILIES, FAMILY_REASON.ADDED_UNATTRIBUTED, 'qoder'],
  ]) {
    const r = reconcileWith({
      derivedNames: names, baselineNames, currentNames: names,
      changedPaths: CONTENT_ONLY_CHANGE, minimum: 18,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, [{ code, family }]);
  }
});

test('an add and a drop together are permitted when attributed', () => {
  const swapped = [...ALL_FAMILIES.filter((n) => n !== 'trae'), 'qoder'];
  const r = reconcileWith({
    derivedNames: swapped,
    baselineNames: ALL_FAMILIES,
    currentNames: swapped,
    changedPaths: REGISTRY_CHANGE,
  });
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('an EQUAL-COUNT membership swap is caught in both directions', () => {
  // 19 in, 19 out — invisible to any count-based check. This is why the contract is
  // set-based rather than numeric.
  const swapped = [...ALL_FAMILIES.filter((n) => n !== 'trae'), 'qoder'];
  const r = reconcileWith({
    derivedNames: swapped,
    baselineNames: ALL_FAMILIES,
    currentNames: swapped,
    changedPaths: CONTENT_ONLY_CHANGE,
  });
  assert.equal(swapped.length, ALL_FAMILIES.length, 'the swap must leave the totals equal');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.slice().sort((a, b) => a.code.localeCompare(b.code)), [
    { code: FAMILY_REASON.ADDED_UNATTRIBUTED, family: 'qoder' },
    { code: FAMILY_REASON.DROPPED_UNATTRIBUTED, family: 'trae' },
  ]);
});

// ── Single-tree drift ────────────────────────────────────────────────────────

test('rejects a fixture with no registered runtime, naming it', () => {
  const r = reconcileWith({ fixtureNames: [...ALL_FAMILIES, 'ghost'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [{ code: FAMILY_REASON.FIXTURE_WITHOUT_RUNTIME, family: 'ghost' }]);
});

test('rejects a registered runtime with no fixture, naming it', () => {
  const r = reconcileWith({
    derivedNames: [...ALL_FAMILIES, 'qoder'],
    fixtureNames: ALL_FAMILIES,
    baselineNames: [...ALL_FAMILIES, 'qoder'],
    currentNames: [...ALL_FAMILIES, 'qoder'],
    changedPaths: REGISTRY_CHANGE,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [{ code: FAMILY_REASON.RUNTIME_WITHOUT_FIXTURE, family: 'qoder' }]);
});

// ── The absolute floor: limit-1 / limit / limit+1 ────────────────────────────

test('floor is enforced at limit-1 / limit / limit+1', () => {
  const eighteen = ALL_FAMILIES.filter((n) => n !== 'trae');          // limit-1
  const twenty = [...ALL_FAMILIES, 'qoder'];                          // limit+1

  const below = reconcileWith({
    derivedNames: eighteen, baselineNames: eighteen, currentNames: eighteen,
  });
  assert.equal(below.ok, false);
  assert.ok(codesOf(below).includes(FAMILY_REASON.BELOW_FLOOR));

  assert.deepEqual(reconcileWith({}), { ok: true, errors: [] });      // limit == 19

  const above = reconcileWith({
    derivedNames: twenty, baselineNames: twenty, currentNames: twenty,
  });
  assert.deepEqual(above, { ok: true, errors: [] });
});

test('a uniformly shrunken universe fails on the floor', () => {
  // The Goodhart move the old literal permitted: drop a runtime AND its fixture together
  // and lower the constant, and 18 === 18 passes over a smaller world.
  const eighteen = ALL_FAMILIES.filter((n) => n !== 'trae');
  const r = reconcileWith({
    derivedNames: eighteen, fixtureNames: eighteen,
    baselineNames: eighteen, currentNames: eighteen,
    changedPaths: REGISTRY_CHANGE,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(codesOf(r), [FAMILY_REASON.BELOW_FLOOR]);
});

// ── #2086: claude-local is pinned by name on both sides ──────────────────────

test('a missing claude-local family is named on either side', () => {
  const noLocal = ALL_FAMILIES.filter((n) => n !== 'claude-local');
  const missingCurrent = reconcileWith({
    currentNames: noLocal, changedPaths: REGISTRY_CHANGE,
  });
  assert.ok(codesOf(missingCurrent).includes(FAMILY_REASON.MISSING_CLAUDE_LOCAL));

  const missingBaseline = reconcileWith({
    baselineNames: noLocal, changedPaths: REGISTRY_CHANGE,
  });
  assert.ok(codesOf(missingBaseline).includes(FAMILY_REASON.MISSING_CLAUDE_LOCAL));
});

// ── Hostile / malformed input: explicit failure, never a quiet ok ────────────

test('unusable baseline and current are rejected explicitly, not read as empty', () => {
  for (const bad of [null, undefined, [], 'nope', 0]) {
    const r = reconcileFamilies({
      derived: derivedOf(ALL_FAMILIES), fixtures: ALL_FAMILIES,
      baseline: bad, current: manifestsOf(ALL_FAMILIES), changedPaths: [],
    });
    assert.deepEqual(r, { ok: false, errors: [{ code: FAMILY_REASON.BASELINE_UNUSABLE }] });
  }
  for (const bad of [null, undefined, [], 'nope', 0]) {
    const r = reconcileFamilies({
      derived: derivedOf(ALL_FAMILIES), fixtures: ALL_FAMILIES,
      baseline: manifestsOf(ALL_FAMILIES), current: bad, changedPaths: [],
    });
    assert.deepEqual(r, { ok: false, errors: [{ code: FAMILY_REASON.CURRENT_UNUSABLE }] });
  }
});

test('a non-array changedPaths is an explicit error, never a silent "no registry change"', () => {
  for (const bad of [null, undefined, 'tests/helpers/install-shared.cjs', {}, 7]) {
    const r = reconcileWith({ changedPaths: bad });
    assert.deepEqual(r, { ok: false, errors: [{ code: FAMILY_REASON.BAD_CHANGED_PATHS }] });
  }
});

test('malformed derived and fixtures inputs fail with a verdict, not a TypeError', () => {
  // Every input is gated. An unhandled throw here would read as an infrastructure fault
  // rather than a gate verdict, which is how a propagation check goes quiet.
  for (const bad of [null, undefined, 'nope', {}, [{ nope: 1 }], [null]]) {
    const r = reconcileFamilies({
      derived: bad, fixtures: ALL_FAMILIES,
      baseline: manifestsOf(ALL_FAMILIES), current: manifestsOf(ALL_FAMILIES),
      changedPaths: [],
    });
    assert.deepEqual(r, { ok: false, errors: [{ code: FAMILY_REASON.DERIVED_UNUSABLE }] });
  }
  for (const bad of [null, undefined, 'nope', {}, [1], [null]]) {
    const r = reconcileFamilies({
      derived: derivedOf(ALL_FAMILIES), fixtures: bad,
      baseline: manifestsOf(ALL_FAMILIES), current: manifestsOf(ALL_FAMILIES),
      changedPaths: [],
    });
    assert.deepEqual(r, { ok: false, errors: [{ code: FAMILY_REASON.FIXTURES_UNUSABLE }] });
  }
});

// ── Registry attribution ─────────────────────────────────────────────────────

test('each registry-signal path independently attributes a family change', () => {
  for (const p of [...REGISTRY_SIGNAL_PATHS, 'capabilities/qoder/capability.json']) {
    assert.equal(touchesRuntimeRegistry([p]), true, `${p} should attribute`);
  }
  // Narrow on purpose: surfaces that merely accompany a runtime addition must NOT
  // excuse an unattributed family delta.
  for (const p of ['src/runtime-name-policy.cts', 'gsd-core/bin/lib/capability-registry.cjs']) {
    assert.equal(touchesRuntimeRegistry([p]), false, `${p} must NOT attribute on its own`);
  }
});

test('backslash-separated registry paths normalize unconditionally', () => {
  // Path separators normalize on every platform — backslash paths arrive on Linux too.
  assert.equal(touchesRuntimeRegistry(['tests\\helpers\\install-shared.cjs']), true);
  assert.equal(touchesRuntimeRegistry(['capabilities\\qoder\\capability.json']), true);
});

test('near-miss paths do not attribute a family change', () => {
  for (const p of [
    'capabilities/qoder/other.json',
    'capabilities/capability.json',
    'tests/helpers/install-shared.cjs.bak',
    'docs/tests/helpers/install-shared.cjs',
    'gsd-core/workflows/plan-phase.md',
  ]) {
    assert.equal(touchesRuntimeRegistry([p]), false, `${p} should NOT attribute`);
  }
  assert.equal(touchesRuntimeRegistry([]), false);
});

// ── The baseline must come from the REF, not from HEAD's registry ────────────

test('baseline families are enumerated from the ref, not from the current registry', (t) => {
  // Regression: enumerating the baseline from MANIFEST_FAMILIES (imported at module load,
  // so it describes PR HEAD) makes a REMOVED runtime invisible — the name is already gone
  // from the current registry, so the base ref is never asked for it, and the dropped-
  // family check can never fire in production even though its unit tests pass.
  //
  // Built as its own git repo rather than reaching for this repo's history. The gsd-test
  // runner shallow-clones base+head, so `rev-list --max-parents=0` there returns the
  // GRAFTED boundary commit — a recent one carrying every fixture — not a true root. (This
  // repo also has two root commits locally.) A history-dependent assertion passes on a full
  // clone and fails in the runner, which is exactly what it did.
  const repo = createTempDir('emitted-baseline-ref');
  t.after(() => cleanup(repo));
  // No `safeDirArgs` needed here (unlike the #2767 fix above): `repo` is a directory
  // this same process just created with `mkdtempSync` + `git init`, so its owner is
  // always the uid running the test regardless of container — it is never the
  // externally-mounted repo path the dubious-ownership check reacts to.
  const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });

  run('init', '--quiet', '-b', 'main');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Test');
  const fixtureDir = path.join(repo, ...'tests/fixtures/golden-install-parity'.split('/'));
  fs.mkdirSync(fixtureDir, { recursive: true });

  // Deliberately includes a family that is NOT in today's registry. This is the real
  // discriminator: a registry-derived implementation can never report it, because the name
  // does not exist in MANIFEST_FAMILIES — which is precisely how a REMOVED runtime went
  // invisible and made the dropped-family check unreachable in production.
  const atRefOnly = 'zzz-retired-runtime';
  const committed = ['claude', 'claude-local', atRefOnly];
  for (const name of committed) {
    fs.writeFileSync(path.join(fixtureDir, `${name}.json`), JSON.stringify({ 'a/b': 'hash' }));
  }
  run('add', '-A');
  run('commit', '--quiet', '-m', 'fixtures');

  assert.ok(
    !ALL_FAMILIES.includes(atRefOnly),
    'the probe family must be absent from the current registry for this test to discriminate',
  );
  assert.deepEqual(
    baselineFamilyNamesAtRef('HEAD', { cwd: repo }).slice().sort(),
    committed.slice().sort(),
    'the baseline must report what the REF carries, including a family the current registry lacks',
  );

  // A ref that cannot be resolved yields nothing rather than throwing, which is the
  // post-cutover signal to fall back to resolveBaseline's cache path.
  assert.deepEqual(baselineFamilyNamesAtRef('refs/heads/no-such-ref-2723', { cwd: repo }), []);

  // Deliberately NOT asserted against the ambient checkout. Reading this repo's own HEAD is
  // not guaranteed inside the runner container — it returned [] there, which is this
  // function's documented behavior when git cannot read the ref, not a defect. Asserting on
  // it tests the checkout rather than the code, and the temp repo above already proves the
  // property that matters: the family set follows the REF. The ambient path is covered by
  // the real-tree test, which skips explicitly when no base ref is resolvable.
  //
  // A git failure is never silently permissive downstream: baselineManifestsAtRef returns
  // null on an empty family set, and the real-tree test asserts the baseline is non-empty.
});

// ── Independence / purity ────────────────────────────────────────────────────

test('reconciliation is pure across repeated calls', () => {
  const args = {
    derivedNames: [...ALL_FAMILIES, 'qoder'],
    baselineNames: ALL_FAMILIES,
    currentNames: [...ALL_FAMILIES, 'qoder'],
    changedPaths: CONTENT_ONLY_CHANGE,
  };
  assert.deepEqual(reconcileWith(args), reconcileWith(args));
});

// ── Property: the reported delta is exactly the set difference ───────────────

test('property: reported added/dropped are exactly the set differences', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }).filter((s) => !/^\s*$/.test(s)), { minLength: 0, maxLength: 5 }),
      fc.uniqueArray(fc.integer({ min: 0, max: ALL_FAMILIES.length - 2 }), { minLength: 0, maxLength: 4 }),
      (rawAdds, dropIdx) => {
        const added = rawAdds.filter((s) => !ALL_FAMILIES.includes(s));
        // never drop claude-local: it has its own dedicated assertion
        const dropped = dropIdx
          .map((i) => ALL_FAMILIES[i])
          .filter((n) => n !== 'claude-local');
        const current = [...ALL_FAMILIES.filter((n) => !dropped.includes(n)), ...added];

        const r = reconcileFamilies({
          derived: derivedOf(current),
          fixtures: current,
          baseline: manifestsOf(ALL_FAMILIES),
          current: manifestsOf(current),
          changedPaths: CONTENT_ONLY_CHANGE,
          minimum: 0,
        });

        const reportedAdded = r.errors
          .filter((e) => e.code === FAMILY_REASON.ADDED_UNATTRIBUTED).map((e) => e.family).sort();
        const reportedDropped = r.errors
          .filter((e) => e.code === FAMILY_REASON.DROPPED_UNATTRIBUTED).map((e) => e.family).sort();

        assert.deepEqual(reportedAdded, [...new Set(added)].sort());
        assert.deepEqual(reportedDropped, [...new Set(dropped)].sort());
        return true;
      },
    ),
    { numRuns: 200, seed: 2723 },
  );
});

// ─── The real thing: the law, run against the actual tree ───────────────────
//
// Everything above exercises the pure law against synthetic input, which is what makes
// the acceptance criteria practical to assert at all. This block is what stops the
// phase from being interface-only: it builds the CURRENT emitted manifests for real
// (one installer spawn per runtime), resolves the BASELINE via `resolveBaseline()`,
// resolves the changed paths with real git, reads the real ack file, and runs the
// conservation law over all of it.
//
// Baseline source note (#2724, post-cutover): the committed golden fixtures this test
// used to read via `git show origin/next:<fixture>` are deleted. `resolveBaseline()`'s
// documented precedence takes over: `GSD_EMITTED_BASELINE` env (CI's PR-lane cache
// restore, keyed on the PR's base sha) -> the on-disk cache at
// `.gsd-cache/emitted-baseline.json` (populated by CI's push-to-next publish step,
// scripts/gen-emitted-baseline.cjs) -> an in-job build (a throwaway `git worktree`
// checked out at `base`, running the same script there — slow but never absent). Never
// the working-tree fixtures, which would be whatever this PR's author regenerated;
// comparing against those would be vacuous.

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

  // Phase 4 (#2724): the golden fixtures this used to read via `baselineManifestsAtRef`
  // (git show <base>:<fixture>) are deleted, so the baseline now comes through
  // `resolveBaseline()`'s documented precedence: GSD_EMITTED_BASELINE env (CI's PR-lane
  // cache restore) -> the on-disk cache (CI's push-to-next publish step) -> an in-job
  // build at `base` (a throwaway git worktree + scripts/gen-emitted-baseline.cjs) ->
  // explicit failure. The build fallback is deliberately the slow path — it exists so a
  // cache miss degrades rather than fails outright (ADR-2719 §5).
  const readBaselineJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
  const resolvedBaseline = resolveBaseline({
    expectedSha: baseSha,
    readJson: readBaselineJson,
    buildFallback: () => buildBaselineAtRef(base),
  });
  assert.ok(
    resolvedBaseline.ok,
    // #2854: report the sources actually reached, not a hardcoded list of all three. An
    // early return could claim it "tried an in-job build" it never called, which sent
    // contributors hunting a rebuild that had not run.
    `no usable emitted baseline for ${base}@${baseSha.slice(0, 12)} (tried ` +
    `${(resolvedBaseline.attempted || []).join(', ') || 'nothing'}):` +
    `\n  ${(resolvedBaseline.errors || []).join('\n  ')}`,
  );
  const baseline = resolvedBaseline.baseline;
  assert.ok(baseline && Object.keys(baseline).length > 0, `resolved baseline via ${resolvedBaseline.via} has no families`);

  const changedPaths = resolveChangedPaths(base);
  const ack = readAckFile();
  const current = currentManifests();

  // Consult the base side ONLY when this tree actually has a document to classify.
  // `readAckFileAtRef` throws on a base it cannot read, which is right — but reading it
  // unconditionally would DEADLOCK the repo if `next` ever carried a corrupt ack (a bad
  // merge leaving conflict markers in exactly the file class this epic exists over):
  // every PR would go red, INCLUDING the PR that deletes the corrupt file and repairs
  // base. A tree carrying no ack has nothing to inherit, so it needs no base read — which
  // is precisely the shape of the repair PR, and it lands and unblocks everyone.
  const baseAck = ack === null ? null : readAckFileAtRef(baseSha);

  // Reconcile the family SET across three independent signals, rather than asserting one
  // count against both sides. The baseline is built at the base ref and the current tree
  // at PR HEAD, so the two legitimately differ by a family whenever a PR adds or removes
  // a runtime — a single shared literal could satisfy neither side at once (#2723), and
  // a count cannot see a membership swap that leaves the total unchanged either way.
  const familyVerdict = reconcileFamilies({
    derived: MANIFEST_FAMILIES,
    fixtures: loadManifests().map((m) => m.file.replace(/\.json$/, '')),
    baseline,
    current,
    changedPaths,
  });
  assert.ok(
    familyVerdict.ok,
    'emitted manifest family set is not reconciled:\n  ' +
    familyVerdict.errors
      .map((e) => (e.family ? `${e.code}: ${e.family}` : e.code))
      .join('\n  '),
  );

  const result = diffEmitted({
    baseline,
    current,
    changedPaths,
    ack,
    // The base side of the ack lifecycle (#2789). Without it a MERGED ack is
    // indistinguishable from one that never explained anything, which is what reddened
    // `next` for five commits and every PR branching off it (#2768). Entries already
    // present here are spent: inert, never stale, and unable to pre-clear a new ripple.
    //
    // Keyed on `baseSha`, not `base`: the baseline half is already validated against that
    // exact sha, so both halves of the base side provably describe the SAME commit, and a
    // ref that moved between `resolveBase()` and here cannot split them.
    baseAck,
    sizeBaseline: resolvedBaseline.sizeBaseline,
    sizeCurrent: currentSizes(),
  });

  assert.ok(
    result.ok,
    `emitted-attribution failed against ${base}@${baseSha.slice(0, 12)}:\n\n${formatReport(result)}`,
  );
});

// ─── Cross-tree version normalization (#2891) ──────────────────────────────────
//
// #2767's `currentManifests({ repoRoot })` spawns a DIFFERENT checkout's installer
// but, before this fix, still normalized the emitted content against THIS checkout's
// PKG_VERSION — so a version-bumped current tree compared against an older-version
// baseline worktree never collapsed the baseline's `// gsd-hook-version: <old>` stamp
// to '<VERSION>', every one of that baseline's emitted files spuriously "differed",
// and the differential attribution gate above (the real-tree test) failed with all
// 364 emitted hook paths unattributed. These tests pin the mechanism directly against
// `buildParityManifest`'s `pkgVersion` option and `measuredPackageVersion`, the two
// pieces `currentManifests` composes to fix it, rather than only against the
// expensive real-tree gate.

function makeVersionStampedTree(hookVersion) {
  const root = createTempDir('gsd-test-ppm-version-');
  const configDir = path.join(root, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'hook.js'),
    `// gsd-hook-version: ${hookVersion}\nconsole.log('hook body unchanged across versions');\n`,
  );
  return { root, configDir };
}

test('buildParityManifest: same content at two different pkgVersions hashes identically when each is normalized against its OWN version (#2891)', () => {
  const a = makeVersionStampedTree('1.8.0');
  const b = makeVersionStampedTree('1.9.0');
  try {
    const manifestA = buildParityManifest(a.configDir, a.root, { pkgVersion: '1.8.0' });
    const manifestB = buildParityManifest(b.configDir, b.root, { pkgVersion: '1.9.0' });
    assert.equal(
      manifestA['hook.js'],
      manifestB['hook.js'],
      'byte-identical-apart-from-version-stamp files must hash identically once each side ' +
      'is normalized against the version that actually produced it'
    );
  } finally {
    cleanup(a.root);
    cleanup(b.root);
  }
});

test('buildParityManifest: hash of a measured tree does not depend on the MEASURING repo\'s own version (#2891)', () => {
  // Reproduces the real cross-tree shape: content stamped with version X, normalized
  // with the EXPLICIT pkgVersion of the tree that produced it (X) — never with this
  // checkout's own PKG_VERSION (Y), which is what the pre-fix bug silently defaulted to.
  const measuredVersion = '7.7.7';
  assert.notEqual(
    measuredVersion,
    PKG_VERSION,
    'test fixture must use a version distinct from this checkout\'s own PKG_VERSION for the assertion below to be meaningful'
  );
  const tree = makeVersionStampedTree(measuredVersion);
  try {
    const manifest = buildParityManifest(tree.configDir, tree.root, { pkgVersion: measuredVersion });
    // The stamp must have collapsed to '<VERSION>' — if it hadn't (e.g. because the
    // measuring repo's own PKG_VERSION had been used instead), the raw '7.7.7' would
    // still be present pre-hash and this hash would differ from a control manifest
    // built directly against the sentinel-substituted content.
    const controlContent = `// gsd-hook-version: <VERSION>\nconsole.log('hook body unchanged across versions');\n`;
    const controlHash = crypto.createHash('sha256').update(controlContent).digest('hex').slice(0, 16);
    assert.equal(
      manifest['hook.js'],
      controlHash,
      'hash must reflect the version-stamp collapsing to <VERSION> using the MEASURED tree\'s ' +
      'own version, independent of whatever PKG_VERSION the measuring repo happens to be at'
    );
  } finally {
    cleanup(tree.root);
  }
});

test('buildParityManifest: pkgVersion guard rejects empty/undefined/null/non-string/non-semver-shaped and never corrupts the manifest (#2891)', () => {
  const tree = makeVersionStampedTree('1.8.0');
  try {
    // Omitting pkgVersion entirely is legitimate (defaults to this checkout's own
    // PKG_VERSION) and must NOT throw.
    assert.doesNotThrow(() => buildParityManifest(tree.configDir, tree.root));

    // Explicitly passing a bad value must throw — including an EXPLICIT `undefined`,
    // which is deliberately NOT treated the same as omitting the key (see the `in`
    // guard in install-shared.cjs: a caller-side bug that resolves a version to
    // `undefined` must fail loudly, never silently fall back to this checkout's own
    // version). '1' and '12' are shape failures (#2891 review FINDING 2): a
    // non-semver-shaped string like '1' must be rejected, not silently accepted and
    // later matched as a substring of unrelated numeric content (e.g. 'v 1.8.0 x').
    for (const bad of ['', undefined, null, 42, '1', '12']) {
      assert.throws(
        () => buildParityManifest(tree.configDir, tree.root, { pkgVersion: bad }),
        /pkgVersion must be a non-empty semver-ish string/,
        `expected pkgVersion=${JSON.stringify(bad)} to throw`
      );
    }

    // Corruption check: an empty pkgVersion, if it ever reached blind substring
    // replacement, would corrupt content that merely contains matching characters.
    // Confirm the guard fires BEFORE that — a file whose entire content is 'abc' must
    // never make it into a manifest via a '' pkgVersion.
    const corruptibleRoot = createTempDir('gsd-test-ppm-corrupt-');
    const corruptibleDir = path.join(corruptibleRoot, 'cfg');
    fs.mkdirSync(corruptibleDir, { recursive: true });
    fs.writeFileSync(path.join(corruptibleDir, 'f.txt'), 'abc');
    try {
      assert.throws(
        () => buildParityManifest(corruptibleDir, corruptibleRoot, { pkgVersion: '' }),
        /pkgVersion must be a non-empty semver-ish string/
      );
    } finally {
      cleanup(corruptibleRoot);
    }
  } finally {
    cleanup(tree.root);
  }
});

test('buildParityManifest: pkgVersion shape guard boundary — limit-1/limit/limit+1 by length (#2891 review FINDING 2)', () => {
  const tree = makeVersionStampedTree('1.8.0');
  try {
    // '0.0.0' is the shortest string SEMVER_ISH_RE accepts (5 chars: MAJOR.MINOR.PATCH,
    // all single-digit, no prerelease/build) — the "limit" case.
    assert.doesNotThrow(
      () => buildParityManifest(tree.configDir, tree.root, { pkgVersion: '0.0.0' }),
      'a minimal valid MAJOR.MINOR.PATCH string must be accepted (limit)'
    );
    // '12' (limit+1 relative to the 1-char failure below, and still nowhere near
    // semver-shaped) must still be rejected.
    assert.throws(
      () => buildParityManifest(tree.configDir, tree.root, { pkgVersion: '12' }),
      /pkgVersion must be a non-empty semver-ish string/,
      'a 2-char non-semver-shaped string must be rejected (limit+1 by length from \'1\')'
    );
    // '1' (limit-1 relative to '12') must be rejected — the concrete regression this
    // guard exists to close: {pkgVersion:'1'} was previously ACCEPTED and rewrote
    // 'v 1.8.0 x' to 'v <VERSION>.8.0 x' via a bare-substring match.
    assert.throws(
      () => buildParityManifest(tree.configDir, tree.root, { pkgVersion: '1' }),
      /pkgVersion must be a non-empty semver-ish string/,
      'a 1-char string must be rejected (limit-1)'
    );
  } finally {
    cleanup(tree.root);
  }
});

test('buildParityManifest: pkgVersion is honored when reachable via the PROTOTYPE CHAIN, not only as an own key (#2891 review FINDING 4)', () => {
  const tree = makeVersionStampedTree('7.7.7');
  try {
    // Object.create({pkgVersion:'7.7.7'}) has NO own 'pkgVersion' key, but the key IS
    // reachable via `in` — before the fix this silently fell through to this
    // checkout's own PKG_VERSION (the exact silent-fallback the guard exists to
    // prevent), reached via a different vector than an explicit own-key bad value.
    const opts = Object.create({ pkgVersion: '7.7.7' });
    const manifest = buildParityManifest(tree.configDir, tree.root, opts);
    const controlContent = `// gsd-hook-version: <VERSION>\nconsole.log('hook body unchanged across versions');\n`;
    const controlHash = crypto.createHash('sha256').update(controlContent).digest('hex').slice(0, 16);
    assert.equal(
      manifest['hook.js'],
      controlHash,
      'an inherited pkgVersion must be read and normalized against, not silently ignored in favor of this checkout\'s own PKG_VERSION'
    );
  } finally {
    cleanup(tree.root);
  }
});

test('buildParityManifest: opts guard rejects null/non-object (#2891 review FINDING 5)', () => {
  const tree = makeVersionStampedTree('1.8.0');
  try {
    for (const bad of [null, 'x', 42, true, []]) {
      assert.throws(
        () => buildParityManifest(tree.configDir, tree.root, bad),
        /opts must be a plain object or omitted/,
        `expected opts=${JSON.stringify(bad)} to throw a clear message, not a raw TypeError`
      );
    }
  } finally {
    cleanup(tree.root);
  }
});

test('buildInstallTree: no longer accepts/forwards an opts argument, so a bad third argument is silently ignored rather than reaching buildParityManifest\'s guard (#2891 review FINDINGS 5+6)', () => {
  // FINDING 6 removed buildInstallTree's dead opts-forwarding parameter (pkgVersion
  // never affects the emitted FILE SET, only content hashes, and no caller ever passed
  // a third argument). A consequence: buildInstallTree(cd, root, null) — the exact
  // FINDING 5 repro against the OLD forwarding code — no longer reaches
  // buildParityManifest's opts guard at all; the extra argument is simply unused,
  // consistent with ordinary JS call semantics, and buildParityManifest gets its
  // default `{}`. This must NOT throw.
  const tree = makeVersionStampedTree('1.8.0');
  try {
    assert.doesNotThrow(() => buildInstallTree(tree.configDir, tree.root, null));
    assert.deepEqual(
      buildInstallTree(tree.configDir, tree.root, null),
      buildInstallTree(tree.configDir, tree.root),
      'a discarded third argument must not change the result'
    );
  } finally {
    cleanup(tree.root);
  }
});

test('measuredPackageVersion: resolves this checkout\'s version with no repoRoot, the measured tree\'s version with one, and fails closed (#2891)', () => {
  // No repoRoot at all (key genuinely absent): this checkout's own PKG_VERSION, no
  // filesystem I/O.
  assert.equal(measuredPackageVersion(), PKG_VERSION);
  // Explicit `undefined` is the ONLY falsy value treated as "this checkout" — every
  // OTHER falsy value ('', 0, false) is a caller-side bug and must fail closed rather
  // than silently defaulting, consistent with `currentManifests`' installScript gate
  // and with `buildParityManifest`'s pkgVersion guard (#2891 review FINDING 7).
  assert.equal(measuredPackageVersion(undefined), PKG_VERSION);
  for (const bad of ['', 0, false]) {
    assert.throws(
      () => measuredPackageVersion(bad),
      /repoRoot must be a non-empty path or omitted entirely/,
      `expected repoRoot=${JSON.stringify(bad)} to throw`
    );
  }

  // A different tree's package.json: its OWN version, not this checkout's.
  const measuredRoot = createTempDir('gsd-test-mpv-ok-');
  try {
    fs.writeFileSync(
      path.join(measuredRoot, 'package.json'),
      JSON.stringify({ name: 'measured-tree', version: '9.9.9' }),
    );
    assert.equal(measuredPackageVersion(measuredRoot), '9.9.9');
  } finally {
    cleanup(measuredRoot);
  }

  // Missing package.json: fails closed, never falls back to this checkout's version.
  const missingRoot = createTempDir('gsd-test-mpv-missing-');
  try {
    assert.throws(() => measuredPackageVersion(missingRoot), /cannot read/);
  } finally {
    cleanup(missingRoot);
  }

  // Unparseable package.json.
  const badJsonRoot = createTempDir('gsd-test-mpv-badjson-');
  try {
    fs.writeFileSync(path.join(badJsonRoot, 'package.json'), '{not json');
    assert.throws(() => measuredPackageVersion(badJsonRoot), /not valid JSON/);
  } finally {
    cleanup(badJsonRoot);
  }

  // Version-less package.json (key ABSENT entirely) — the only branch the pre-review
  // test suite drove.
  const noVersionRoot = createTempDir('gsd-test-mpv-noversion-');
  try {
    fs.writeFileSync(path.join(noVersionRoot, 'package.json'), JSON.stringify({ name: 'no-version' }));
    assert.throws(() => measuredPackageVersion(noVersionRoot), /no non-empty string "version" field/);
  } finally {
    cleanup(noVersionRoot);
  }

  // "version" key PRESENT but an empty string — a distinct branch from "absent"
  // (`typeof '' === 'string'` but `''.length === 0`); the pre-review suite never drove
  // it and both surviving mutants collapse this into the absent-key case (#2891 review
  // FINDING 3).
  const emptyVersionRoot = createTempDir('gsd-test-mpv-emptyversion-');
  try {
    fs.writeFileSync(path.join(emptyVersionRoot, 'package.json'), JSON.stringify({ version: '' }));
    assert.throws(() => measuredPackageVersion(emptyVersionRoot), /no non-empty string "version" field/);
  } finally {
    cleanup(emptyVersionRoot);
  }

  // "version" key PRESENT but non-string (e.g. a bare JSON number) — the other branch
  // `typeof version !== 'string'` guards, distinct from both "absent" and "empty
  // string" (#2891 review FINDING 3).
  const numericVersionRoot = createTempDir('gsd-test-mpv-numericversion-');
  try {
    fs.writeFileSync(path.join(numericVersionRoot, 'package.json'), JSON.stringify({ version: 123 }));
    assert.throws(() => measuredPackageVersion(numericVersionRoot), /no non-empty string "version" field/);
  } finally {
    cleanup(numericVersionRoot);
  }

  // Unreadable package.json: monkeypatch fs.readFileSync (NEVER chmod 0o000 — root
  // bypasses mode bits and the test would silently pass with zero coverage in root
  // Docker/CI). Save original, override to throw, assert.throws, restore in `finally`.
  const unreadableRoot = createTempDir('gsd-test-mpv-unreadable-');
  try {
    fs.writeFileSync(path.join(unreadableRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    const orig = fs.readFileSync;
    try {
      fs.readFileSync = () => { throw new Error('injected package.json read failure'); };
      assert.throws(() => measuredPackageVersion(unreadableRoot), /injected package\.json read failure/);
    } finally {
      fs.readFileSync = orig;
    }
    // Restoration is real, not assumed.
    assert.equal(measuredPackageVersion(unreadableRoot), '1.0.0');
  } finally {
    cleanup(unreadableRoot);
  }
});

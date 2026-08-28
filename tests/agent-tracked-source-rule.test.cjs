/**
 * #3645: gsd-planner and gsd-pattern-mapper must write only git-TRACKED
 * source paths into PLAN.md / PATTERNS.md — never a gitignored install/
 * runtime mirror (e.g. <root>/.gsd/capabilities/<id>/... synced from a
 * plugin's tracked tree). Executors that trust a mirror path edit a copy
 * whose changes die on the next sync; the wrong path also self-propagates
 * across phases because pattern-mapper builds on prior phases' docs.
 *
 * Enforcement points: gsd-pattern-mapper.md carries the gate inline (its
 * size tier has headroom); the PLANNER agent file is frozen under a
 * 49152-LF-char cap asserted by four other suites, so the planner-side rule
 * is projected onto its spawn contract in gsd-core/workflows/plan-phase.md
 * (the #3297 precedent for requirements the spawned agent must honor).
 *
 * Shipped-content contract rows: the agent/workflow text IS the product the
 * runtime loads, so asserting its contract lines tests the deployed behavior.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

describe('#3645 — agents write only git-tracked source paths', () => {
  // allow-test-rule: source-text-is-the-product (#3645)
  // The workflow prompt block below IS the runtime instruction shipped to
  // every plan-phase run; testing its content tests the deployed contract.
  const planPhase = fs.readFileSync(path.join(WORKFLOWS_DIR, 'plan-phase.md'), 'utf8');

  // allow-test-rule: source-text-is-the-product (#3645)
  // The agent gate text IS the runtime instruction; testing it tests the
  // deployed contract — if the tracked-source gate is absent, the agent
  // does not enforce it.
  const mapper = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-pattern-mapper.md'), 'utf8');

  test('planner spawn contract carries the #3645 tracked-source rule', () => {
    const block = planPhase.split('<tracked_source_paths>')[1]?.split('</tracked_source_paths>')[0];
    assert.ok(block, 'plan-phase.md must carry the <tracked_source_paths> block in the planner spawn prompt (#3645)');
    assert.ok(/files_modified/.test(block) && /must_haves/.test(block),
      'the block must govern files_modified and must_haves paths');
    assert.ok(block.includes('git ls-files'),
      'the block must instruct git ls-files verification (#3645)');
    assert.ok(/GSD_SOURCE_MIRROR_SENTINEL|\.gsd\/capabilities/.test(block),
      'the block must name the gitignored install-mirror shape it rejects');
    assert.ok(/plugins\//.test(block),
      'the block must point at tracked plugin-source fallback locations');
  });

  test('planner spawn contract re-verifies inherited PATTERNS.md paths (#3645)', () => {
    const block = planPhase.split('<tracked_source_paths>')[1]?.split('</tracked_source_paths>')[0];
    assert.ok(/PATTERNS_PATH/.test(block) && /inherit/.test(block),
      'the block must cover paths inherited from {PATTERNS_PATH} and prior phases');
  });

  test('gsd-pattern-mapper emits only tracked analog paths (#3645)', () => {
    assert.ok(mapper.includes('git ls-files'),
      'gsd-pattern-mapper.md must verify analog paths via git ls-files (#3645)');
    assert.ok(mapper.includes('gitignored install/runtime mirror'),
      'the mapper must name the gitignored-mirror rejection explicitly (#3645)');
    assert.ok(mapper.includes('never emit mirror paths'),
      'PATTERNS.md output must be required to never carry mirror paths (#3645)');
    assert.ok(/plugins\//.test(mapper) && /capabilities\//.test(mapper),
      'the mapper must name tracked-origin fallback locations (#3645)');
  });

  test('the frozen planner agent file is untouched by #3645', () => {
    // The planner is pinned under a 49152-LF-char cap by four suites; the
    // rule lives in its spawn contract instead. Guard the freeze: #3645
    // must not have grown the agent file past its baseline.
    const src = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-planner.md'), 'utf8');
    const lf = src.replace(/\r\n/g, '\n').length;
    assert.ok(lf < 49152, `gsd-planner.md is ${lf} LF chars — must stay < 49152 (#3645 keeps the planner frozen; enforcement lives in plan-phase.md)`);
    assert.ok(!src.includes('Tracked-source'),
      'the rule belongs in the spawn contract, not the frozen agent file (#3645)');
  });

  // A prior version of this suite pinned the EXISTENCE and CONTENTS of the `3645` and
  // `3409` emitted-drift-acks fragments. An ack is scoped to the diff that introduced
  // it: once #3645 merged and its growth is in `next`'s baseline, the acknowledgment
  // can never clear anything again. ADR-3942 moved the acknowledgment off the tree
  // entirely — it is now a commit trailer (`Emitted-Drift-Ack-Hash:` /
  // `Emitted-Drift-Ack-Growth:`) read from `git log $(git merge-base <base> HEAD)..HEAD`,
  // so a merged one is out of range by construction. There is no artifact left in the
  // tree to pin even if a test wanted to. A test may therefore never pin an
  // acknowledgment's existence or its prose; #3645's actual protection is the two
  // behavioral tests above — the mapper emitting only tracked analog paths, and the
  // frozen planner file staying untouched — which this change leaves exactly as they
  // were. The growth itself is protected by `next`'s emitted baseline (the differential
  // attribution check), not by the (now nonexistent) acknowledgment artifact.
});

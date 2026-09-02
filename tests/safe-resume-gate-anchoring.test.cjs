'use strict';

/**
 * #4003 — the safe_resume_gate / TDD RED / completion spot-check commit greps.
 *
 * The gate keyed on the padded `{phase_number}-{plan_padded}` as a bare substring:
 * unanchored (any prior milestone's same-numbered plan matches) and padding-blind
 * (the commit protocol — agents/gsd-executor.md <task_commit_protocol>,
 * gsd-core/references/tdd.md:99 — specifies no padding rule, and both spellings are
 * live in this repository's history). Workflow text IS the deployed product here, so
 * the shape assertions are the faithful check; the behavioral fixture row runs the
 * actual pipeline against a crafted history.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');

describe('#4003 — safe_resume_gate commit-scope greps', () => {
  test('safe_resume_gate greps an anchored, padding-tolerant plan scope', () => {
    const w = fs.readFileSync(WORKFLOW, 'utf8');
    // Anchored, ERE, zero-pad-tolerant on BOTH components — matches feat(2-02): and
    // feat(02-02): alike, never a substring elsewhere in the message.
    assert.match(w, /--grep="\$\{PLAN_SCOPE_RE\}"/, 'the gate must grep the derived scope regex, not a padded literal');
    assert.match(w, /PLAN_SCOPE_RE=\^\[a-z\]\+\\\(\(0\*\$\{PHASE_N\}\)-\(0\*\$\{PLAN_N\}\)\)\\\):/,
      'the scope regex must be anchored to the commit-scope position and zero-pad-tolerant');
    // Padding normalization from the substituted, possibly-padded placeholders.
    assert.match(w, /10#\{phase_number\}/, 'phase component must be zero-stripped via arithmetic base-10');
    assert.match(w, /10#\{plan_padded\}/, 'plan component must be zero-stripped via arithmetic base-10');
    // The old unanchored padded-literal grep must be gone.
    assert.doesNotMatch(w, /--grep="\$\{CURRENT_PLAN_ID\}"/,
      'the bare substring grep over the padded id must not remain');
  });

  test('the gate bounds history to the current milestone with a no-tag fallback', () => {
    const w = fs.readFileSync(WORKFLOW, 'utf8');
    assert.match(w, /git describe --tags --abbrev=0/,
      'the milestone bound derives from the most recent reachable tag (complete-milestone git_tag)');
    assert.match(w, /MILESTONE_BASE\+[^}]*\.\.\.?\^?HEAD|MILESTONE_BASE\.\.\^?HEAD/,
      'the bounded invocation must range BASE..HEAD');
    // Degrade must keep the anchor: a repo with no tags still gets the positional grep.
    assert.match(w, /MILESTONE_BASE=.*|| *echo *""/, 'a missing tag base must degrade to empty, not fail the gate');
  });

  test('tdd red gate tolerates both commit-scope spellings (#4011 keying untouched)', () => {
    const w = fs.readFileSync(WORKFLOW, 'utf8');
    assert.match(w, /--grep="\$\{PLAN_SCOPE_RE\}" -- "\*\*\/\*\.test\.\*/,
      'the RED grep must use the same anchored padding-tolerant scope');
    assert.doesNotMatch(w, /--grep="\^test\(\$\{PHASE_NUMBER\}-\$\{PLAN_ID\}\):"/,
      'the padded-literal RED grep must not remain');
    assert.match(w, /TDD_MODE.*=.*true/, '#4011 TDD_MODE keying preserved');
  });

  test('completion spot-check uses the anchored scope and keeps its time bound', () => {
    const w = fs.readFileSync(WORKFLOW, 'utf8');
    assert.doesNotMatch(w, /--grep="\{phase_number\}-\{plan_padded\}"/,
      'the raw padded placeholder substring grep must not remain');
    assert.match(w, /--since="1 hour ago"/, 'the spot-check keeps its temporal bound');
  });

  test('the gate pipeline separates same-scope commits across a milestone tag (behavioral)', (t) => {
    // Reproduces the report on a crafted history: an OLD milestone commit with the
    // same scope, a tag, then THIS plan's unpadded commits. The pipeline shape is
    // the workflow's: tag base (when present) + anchored, padding-tolerant ERE.
    const repo = createTempGitProject('gsd-4003-gate-');
    t.after(() => cleanup(repo));
    const g = (args) => gitOrThrow(args, { cwd: repo });

    g(['commit', '--allow-empty', '-m', 'feat(02-02): old milestone same-scope commit']);
    g(['tag', 'v9.0.0']);
    g(['commit', '--allow-empty', '-m', 'test(2-02): RED for this plan']);
    g(['commit', '--allow-empty', '-m', 'feat(2-02): GREEN for this plan']);
    g(['commit', '--allow-empty', '-m', 'feat(2-20): adjacent plan must not match']);
    g(['commit', '--allow-empty', '-m', 'feat: mentions 02-02 in prose but not in scope']);

    const scope = '^[a-z]+\\((0*2)-(0*2)\\):';
    const base = g(['describe', '--tags', '--abbrev=0']).trim();
    const bounded = g(['log', '--oneline', '-E', `${base}..HEAD`, `--grep=${scope}`]).trim().split('\n');
    assert.ok(bounded.some((l) => /test\(2-02\): RED for this plan/.test(l)), 'this plan RED commit is found');
    assert.ok(bounded.some((l) => /feat\(2-02\): GREEN for this plan/.test(l)), 'this plan GREEN commit is found');
    assert.ok(!bounded.some((l) => /old milestone same-scope/.test(l)), 'the pre-tag same-scope commit is excluded');
    assert.ok(!bounded.some((l) => /adjacent plan/.test(l)), 'an adjacent plan scope does not match');
    assert.ok(!bounded.some((l) => /in prose/.test(l)), 'a prose mention outside the scope position does not match');

    // No-tag fallback: strip the tag, keep the anchor — the old milestone commit
    // becomes reachable again, but prose/adjacent scopes still never match.
    g(['tag', '-d', 'v9.0.0']);
    const unbounded = g(['log', '--oneline', '-E', `--grep=${scope}`]).trim().split('\n');
    assert.ok(unbounded.some((l) => /old milestone same-scope/.test(l)),
      'without a tag base the anchor alone cannot exclude prior milestones (degrade is honest)');
    assert.ok(!unbounded.some((l) => /in prose/.test(l)), 'the anchor still holds without a tag');
  });
});

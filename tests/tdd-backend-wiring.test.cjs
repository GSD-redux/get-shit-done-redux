'use strict';

/**
 * #4264/#4265/#4266 (epic #4272 Phase 2) — TDD_APPLICABLE is USED (as a
 * `${TDD_APPLICABLE ? ... : ...}` ternary, per #3990) in both executor
 * dispatch backends but was never ASSIGNED anywhere: `phase.tdd-applicable`
 * (Phase 1, #4273) computed the predicate, but no workflow ever called it.
 * That is a silent "absence resolves to false" defect (ADR-3473 §8.4) — an
 * un-substituted `${TDD_APPLICABLE ...}` marker is JS-truthy as literal text,
 * so a real TDD plan would have silently dropped its RED/GREEN/REFACTOR
 * procedure while never producing an error.
 *
 * These are shape assertions on the raw workflow-markdown TEXT: the deployed
 * text IS the runtime-loaded product (an LLM orchestrator reads it top to
 * bottom and composes/executes it) — same rationale as
 * tdd-single-statement.test.cjs's header comment. `readFileSync` here targets
 * `.md` files only, never a `.cjs`/`.js`/`.ts` source path, so
 * `local/no-source-grep` does not apply and no `allow-test-rule` marker is
 * needed (confirmed against tdd-single-statement.test.cjs, which reads the
 * same two files with no such marker).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HARNESS_PATH = 'gsd-core/workflows/execute-phase.md';
const WORKTREE_PATH = 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md';
const TDD_STEP_FRAGMENT_PATH = 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md';

// #4272-phase-6 byte-ceiling extraction (two commits ago): the harness
// backend's TDD_APPLICABLE assignment + phase.tdd-applicable call moved OUT
// of execute-phase.md and into the tdd-applicability-resolution.md step
// fragment; execute-phase.md itself now carries only a one-line REFERENCE to
// that fragment. The worktree backend was not affected — it still carries
// everything inline in executor-isolation-dispatch.md. `referenceFile` is
// where the reader/orchestrator encounters the backend (and, for the
// harness, where the one-line pointer + the ${TDD_APPLICABLE...} USE live);
// `assignmentFile` is where TDD_APPLICABLE is actually ASSIGNED.
const BACKENDS = {
  'execute-phase.md': { referenceFile: HARNESS_PATH, assignmentFile: TDD_STEP_FRAGMENT_PATH },
  'executor-isolation-dispatch.md': { referenceFile: WORKTREE_PATH, assignmentFile: WORKTREE_PATH },
};

// #4268: the two backends' `gsd_run query phase.tdd-applicable` calls differ
// today ONLY in their variable-name prefix (`TDD_APPLICABLE_RAW=$(...)` vs
// `_TDD_APPLICABLE_RAW=$(...)`), and nothing asserts the command-substitution
// CONTENT itself stays byte-identical — a one-word divergence (e.g. dropping
// `2>/dev/null` or changing `--pick applicable` in only one backend) ships
// green. This extracts the call starting at `gsd_run query
// phase.tdd-applicable` through the end of the line, stripping only the
// trailing `)` that closes the `$( ... )` command substitution — i.e.
// everything up to and including the variable-name-and-`=$(` prefix is
// discarded, exactly per #4268.
function extractQueryCall(line) {
  const start = line.indexOf('gsd_run query phase.tdd-applicable');
  if (start === -1) return null;
  let call = line.slice(start);
  if (call.endsWith(')')) call = call.slice(0, -1);
  return call;
}

describe('#4266 — TDD_APPLICABLE is actually computed in both backends', () => {
  // A backend may assign TDD_APPLICABLE directly from the `gsd_run query
  // phase.tdd-applicable` call (harness: `TDD_APPLICABLE=$(gsd_run query
  // phase.tdd-applicable ...)`) or via an intermediate raw/rc pair mirroring
  // the existing ISOLATION resolution pattern (worktree: `_TDD_APPLICABLE_RAW
  // =$(gsd_run query phase.tdd-applicable ...)` ... `TDD_APPLICABLE=
  // "$_TDD_APPLICABLE_RAW"`) — either shape is fine as long as the assignment
  // exists AND is fed by a real phase.tdd-applicable call within a small
  // preceding window, not a bare/silent default.
  function assertTddApplicableIsComputed(name, filePath) {
    const text = read(filePath);
    const lines = text.split('\n');
    const assignIdx = lines.findIndex((l) => /^\s*TDD_APPLICABLE=/.test(l));
    assert.ok(assignIdx !== -1, `${name} must assign TDD_APPLICABLE, not just reference it`);
    const windowStart = Math.max(0, assignIdx - 8);
    const window = lines.slice(windowStart, assignIdx + 1).join('\n');
    assert.ok(
      window.includes('phase.tdd-applicable'),
      `${name}'s TDD_APPLICABLE assignment must be fed by a phase.tdd-applicable call within a few lines above it, got window: ${window}`,
    );
  }

  test('harness backend (execute-phase.md) assigns TDD_APPLICABLE via phase.tdd-applicable', () => {
    // Assignment now lives in the extracted tdd-applicability-resolution.md
    // step fragment, not in execute-phase.md itself (#4272-phase-6).
    assertTddApplicableIsComputed('execute-phase.md', BACKENDS['execute-phase.md'].assignmentFile);
  });

  test('worktree backend (executor-isolation-dispatch.md) assigns TDD_APPLICABLE via phase.tdd-applicable', () => {
    assertTddApplicableIsComputed('executor-isolation-dispatch.md', BACKENDS['executor-isolation-dispatch.md'].assignmentFile);
  });

  for (const [name, cfg] of Object.entries(BACKENDS)) {
    test(`${name}'s phase.tdd-applicable call is plan-scoped, not phase-scoped`, () => {
      const text = read(cfg.assignmentFile);
      const callLine = text.split('\n').find((l) => l.includes('phase.tdd-applicable') && l.includes('gsd_run query'));
      assert.ok(callLine, `${name} must carry a gsd_run query phase.tdd-applicable call`);
      assert.ok(
        callLine.includes('{phase_dir}') && callLine.includes('{plan_file}'),
        `${name}'s phase.tdd-applicable call must pass the per-plan {phase_dir}/{plan_file} path, got: ${callLine.trim()}`,
      );
    });
  }

  test('both backends assign TDD_APPLICABLE before every ${TDD_APPLICABLE...} use (document order)', () => {
    // Worktree backend: assignment and every ${TDD_APPLICABLE...} use live
    // in the same file — same-file ordering check.
    {
      const text = read(BACKENDS['executor-isolation-dispatch.md'].assignmentFile);
      const lines = text.split('\n');
      const assignIdx = lines.findIndex((l) => /^\s*TDD_APPLICABLE=/.test(l));
      assert.ok(assignIdx !== -1, 'executor-isolation-dispatch.md has no TDD_APPLICABLE assignment');
      const useIndices = [];
      lines.forEach((l, i) => {
        if (/\$\{TDD_APPLICABLE\b/.test(l)) useIndices.push(i);
      });
      assert.ok(useIndices.length > 0, 'executor-isolation-dispatch.md has no ${TDD_APPLICABLE...} use to check ordering against');
      for (const useIdx of useIndices) {
        assert.ok(
          assignIdx < useIdx,
          `executor-isolation-dispatch.md: TDD_APPLICABLE is used at line ${useIdx + 1} before it is assigned at line ${assignIdx + 1}`,
        );
      }
    }

    // Harness backend: the assignment was extracted into
    // tdd-applicability-resolution.md (#4272-phase-6); execute-phase.md no
    // longer contains the assignment at all, only a one-line REFERENCE to
    // where it's resolved followed (later) by the ${TDD_APPLICABLE...} USE.
    // Confirm the fragment does assign it, and that in execute-phase.md the
    // reference precedes every use.
    {
      const fragmentText = read(BACKENDS['execute-phase.md'].assignmentFile);
      assert.ok(
        /^\s*TDD_APPLICABLE=/m.test(fragmentText),
        'tdd-applicability-resolution.md has no TDD_APPLICABLE assignment',
      );

      const text = read(BACKENDS['execute-phase.md'].referenceFile);
      const lines = text.split('\n');
      const refIdx = lines.findIndex(
        (l) => l.includes('tdd-applicability-resolution.md') && l.includes('TDD-applicability resolution'),
      );
      assert.ok(refIdx !== -1, 'execute-phase.md must carry a one-line reference to tdd-applicability-resolution.md');
      const useIndices = [];
      lines.forEach((l, i) => {
        if (/\$\{TDD_APPLICABLE\b/.test(l)) useIndices.push(i);
      });
      assert.ok(useIndices.length > 0, 'execute-phase.md has no ${TDD_APPLICABLE...} use to check ordering against');
      for (const useIdx of useIndices) {
        assert.ok(
          refIdx < useIdx,
          `execute-phase.md: TDD_APPLICABLE is used at line ${useIdx + 1} before the reference to its resolution at line ${refIdx + 1}`,
        );
      }
    }
  });

  test('both tdd.md embed-line comments describe the same three real sources (#4265)', () => {
    for (const [name, cfg] of Object.entries(BACKENDS)) {
      const text = read(cfg.referenceFile);
      const line = text.split('\n').find((l) => /tdd\.md/.test(l) && /TDD_APPLICABLE \?/.test(l));
      assert.ok(line, `${name} still lists tdd.md as a conditional embed entry`);
      assert.ok(line.includes('type: tdd'), `${name}'s tdd.md comment must mention plan type: tdd, got: ${line.trim()}`);
      assert.ok(line.includes('tdd="true"'), `${name}'s tdd.md comment must mention the tdd="true" task attribute (#4265), got: ${line.trim()}`);
      assert.ok(
        line.includes('workflow.tdd_mode') || line.includes('config'),
        `${name}'s tdd.md comment must mention the workflow.tdd_mode config default, got: ${line.trim()}`,
      );
    }
  });

  test('worktree backend fail-closes on an un-substituted ${TDD_APPLICABLE marker, matching the ${AGENT_SKILLS} check shape', () => {
    const text = read(WORKTREE_PATH);
    const lines = text.split('\n');
    const skillsIdx = lines.findIndex((l) => l.includes("grep -q '\\${AGENT_SKILLS}'"));
    assert.ok(skillsIdx !== -1, 'worktree backend must still carry the existing ${AGENT_SKILLS} fail-closed check');
    const tddCheckIdx = lines.findIndex((l) => l.includes("grep -q '\\${TDD_APPLICABLE"));
    assert.ok(tddCheckIdx !== -1, 'worktree backend must carry a fail-closed grep check for an unresolved ${TDD_APPLICABLE marker');
    // Same shape: FATAL message + exit 1 within the following couple of lines.
    const block = lines.slice(tddCheckIdx, tddCheckIdx + 4).join('\n');
    assert.ok(/FATAL:/.test(block), 'the ${TDD_APPLICABLE check must emit a FATAL message like the ${AGENT_SKILLS} check');
    assert.ok(/exit 1/.test(block), 'the ${TDD_APPLICABLE check must exit 1 like the ${AGENT_SKILLS} check');
  });

  test('harness backend references the tdd-applicability-resolution step fragment before Agent() is called, and that fragment states a MANDATORY pre-dispatch halt covering TDD_APPLICABLE, CONTEXT_WINDOW, and AGENT_SKILLS', () => {
    // #4272-phase-6 byte-ceiling extraction: the "MANDATORY pre-dispatch check"
    // paragraph moved out of execute-phase.md into
    // tdd-applicability-resolution.md (mirroring per-plan-executor-routing.md);
    // the host file now carries only a one-line reference to it.
    const text = read(HARNESS_PATH);
    const lines = text.split('\n');
    // The literal executor dispatch call sits alone on its own line
    // (`   Agent(`), inside the per-plan spawn section (step 3) — distinct
    // from the many inline `` `Agent(...)` `` prose mentions elsewhere in
    // this file (e.g. the runtime-compatibility table at line ~22).
    const agentCallIdx = lines.findIndex((l) => /^\s*Agent\($/.test(l));
    assert.ok(agentCallIdx !== -1, 'execute-phase.md must contain the literal Agent( dispatch-call line');
    const before = lines.slice(0, agentCallIdx).join('\n');
    assert.ok(
      before.includes('execute-phase/steps/tdd-applicability-resolution.md'),
      'execute-phase.md must reference the tdd-applicability-resolution.md step fragment before the Agent() call',
    );

    const fragment = read(TDD_STEP_FRAGMENT_PATH);
    const checkIdx = fragment.indexOf('MANDATORY');
    assert.ok(checkIdx !== -1, 'tdd-applicability-resolution.md must state a MANDATORY pre-dispatch check');
    const checkText = fragment.slice(checkIdx);
    for (const marker of ['TDD_APPLICABLE', 'CONTEXT_WINDOW', 'AGENT_SKILLS']) {
      assert.ok(checkText.includes(marker), `pre-dispatch check must name ${marker}`);
    }
    assert.ok(/HALT/i.test(checkText), 'pre-dispatch check must instruct an explicit halt, not a soft warning');
  });

  test('regression: tdd-single-statement.test.cjs assertions still hold by inspection', () => {
    for (const [name, cfg] of Object.entries(BACKENDS)) {
      const text = read(cfg.referenceFile);
      const line = text.split('\n').find((l) => /tdd\.md/.test(l) && /TDD_APPLICABLE/.test(l));
      assert.ok(line, `${name} still lists tdd.md as a conditional embed entry`);
      assert.ok(/TDD_APPLICABLE \?/.test(line), `${name}'s tdd.md entry must stay conditional on TDD_APPLICABLE (#3990)`);
    }
  });

  test('RED-first: the predicate-equality comparison actually has teeth on a one-token divergence', () => {
    // Prove the comparison catches a divergence BEFORE trusting it against
    // the real files — a deliberately mutated in-memory pair, no file edits.
    const original = 'gsd_run query phase.tdd-applicable "{phase_dir}/{plan_file}" --pick applicable 2>/dev/null';
    const mutated = original.replace('--pick applicable', '--pick other');
    assert.notEqual(mutated, original, 'sanity: the mutated fixture must actually differ from the original');
    assert.throws(
      () => assert.equal(mutated, original),
      (err) => err instanceof assert.AssertionError,
      'assert.equal must fail on a one-token divergence between two backends\' predicate calls — otherwise the real-file check below has no teeth',
    );
  });

  test('both backends\' gsd_run query phase.tdd-applicable command-substitution calls are byte-identical', () => {
    // #4268 Standards review: both real backend files also carry this exact
    // substring inside an unrelated FATAL echo message a few lines after the
    // real assignment line (`echo "FATAL: ... 'gsd_run query
    // phase.tdd-applicable' failed. ..."`). A bare `.includes()` match
    // happened to work only because `.find()` hits the assignment line
    // first in document order. Anchor on `=$(` immediately before the call —
    // only the real `..._RAW=$(gsd_run query phase.tdd-applicable ...)`
    // assignment line has that shape; the FATAL message's `'gsd_run query
    // phase.tdd-applicable' failed` is preceded by a quote, not `=$(`.
    const harnessLine = read(BACKENDS['execute-phase.md'].assignmentFile)
      .split('\n')
      .find((l) => l.includes('=$(gsd_run query phase.tdd-applicable'));
    const worktreeLine = read(BACKENDS['executor-isolation-dispatch.md'].assignmentFile)
      .split('\n')
      .find((l) => l.includes('=$(gsd_run query phase.tdd-applicable'));
    assert.ok(harnessLine, 'execute-phase.md backend must carry a gsd_run query phase.tdd-applicable call');
    assert.ok(worktreeLine, 'executor-isolation-dispatch.md backend must carry a gsd_run query phase.tdd-applicable call');

    const harnessCall = extractQueryCall(harnessLine);
    const worktreeCall = extractQueryCall(worktreeLine);
    assert.equal(
      harnessCall,
      worktreeCall,
      '#4268: the harness and worktree backends must issue byte-identical phase.tdd-applicable command-substitution calls ' +
        '(only the variable-name-and-`=$(` prefix may differ), got:\n' +
        `  execute-phase.md (harness):              ${harnessCall}\n` +
        `  executor-isolation-dispatch.md (worktree): ${worktreeCall}`,
    );
  });
});

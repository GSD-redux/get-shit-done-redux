/**
 * gsd-executor agent — MVP+TDD gate section contract
 * Verifies the agent definition contains a section instructing the executor
 * to halt and report when the runtime gate trips.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENT = path.join(__dirname, '..', 'agents', 'gsd-executor.md');
const REF = path.join(__dirname, '..', 'gsd-core', 'references', 'execute-mvp-tdd.md');

describe('gsd-executor — MVP+TDD gate section', () => {
  const content = fs.readFileSync(AGENT, 'utf-8');

  test('agent defines a TDD Gate section keyed on TDD_MODE alone (#4011)', () => {
    assert.match(content, /MVP\+TDD\s*Gate|MVP[\s-]?TDD[\s-]?gate|TDD\s*Gate/i, 'must label the gate');
    // The gate's trigger must not require MVP_MODE (#4011): a discipline gate
    // keyed to a product-scope flag is silently inert on non-MVP phases.
    const gateSection = content.slice(
      content.search(/## (?:MVP\+TDD )?TDD Gate/i),
      content.indexOf('##', content.search(/## (?:MVP\+TDD )?TDD Gate/i) + 3),
    );
    assert.ok(!/MVP_MODE\s*=\s*"?"?true"?.{0,80}TDD_MODE|both .MVP_MODE.= true and .TDD_MODE.= true/i.test(gateSection),
      'the executor gate section must trigger on TDD_MODE alone, not the MVP intersection (#4011)');
  });

  test('agent instructs halt-and-report when gate trips', () => {
    assert.match(content, /halt|stop[^\n]*gate|gate[^\n]*halt/i, 'must instruct halt');
    assert.match(content, /report|surface|emit/i, 'must instruct report');
  });

  test('agent references execute-mvp-tdd.md', () => {
    assert.match(content, /execute-mvp-tdd\.md/, 'must reference the gate semantics file');
  });

  test('referenced file exists on disk', () => {
    assert.ok(fs.existsSync(REF), `${REF} must exist`);
  });
});

describe('gsd-executor — state.* calls use the named-only router form (#1863 regression)', () => {
  // The runtime state-command router (gsd-core/bin/lib/state-command-router.cjs)
  // parses record-metric / add-decision / add-blocker / record-session named-only
  // via parseNamedArgs. Positional values are silently dropped, so state.cjs then
  // throws its required-arg error and metrics/decisions/blockers/session continuity
  // are never recorded. Each invocation in the executor agent must therefore pass
  // the named flags the router expects (mirrors gsd-core/workflows/execute-plan.md).
  const content = fs.readFileSync(AGENT, 'utf-8');

  // Capture a `gsd_run query state.<cmd> ...` invocation, including backslash-continued lines.
  function invocation(cmd) {
    const re = new RegExp(String.raw`gsd_run query state\.${cmd}\b(?:[^\r\n]*\\\r?\n)*[^\r\n]*`);
    const m = content.match(re);
    assert.ok(m, `executor must invoke state.${cmd}`);
    return m[0];
  }

  test('record-metric passes --phase/--plan/--duration/--tasks/--files', () => {
    const call = invocation('record-metric');
    for (const flag of ['--phase', '--plan', '--duration', '--tasks', '--files']) {
      assert.ok(call.includes(flag), `record-metric must pass ${flag}, got:\n${call}`);
    }
  });

  test('add-decision passes --summary (or --summary-file)', () => {
    assert.match(invocation('add-decision'), /--summary(?:-file)?\b/);
  });

  test('add-blocker passes --text (or --text-file)', () => {
    assert.match(invocation('add-blocker'), /--text(?:-file)?\b/);
  });

  test('record-session passes --stopped-at and --resume-file', () => {
    const call = invocation('record-session');
    assert.ok(call.includes('--stopped-at'), 'record-session must pass --stopped-at');
    assert.ok(call.includes('--resume-file'), 'record-session must pass --resume-file');
  });

  test('no state.* call leads with a bare positional (quoted) value — the #1863 bug', () => {
    // Buggy multi-line form: `state.<cmd> \` then a line whose first token is a quote.
    const continued = /state\.(?:record-metric|add-decision|add-blocker|record-session)\b[^\r\n]*\\\r?\n\s*"/;
    assert.ok(!continued.test(content),
      'state.* calls must lead with --flags, not a positional quoted value on the next line');
    // Buggy same-line form: `state.<cmd> "..."`
    const inline = /state\.(?:record-metric|add-decision|add-blocker|record-session)\s+"/;
    assert.ok(!inline.test(content),
      'state.* calls must not pass a positional value immediately after the command');
  });

  test('sibling workflow record-session calls also use named flags (#1863 completeness)', () => {
    // The same named-only router backs milestone-summary.md and forensics.md; both
    // previously passed record-session positionally (`"" "stopped-at" "resume-file"`),
    // silently dropping the values. Guard them alongside the executor.
    for (const rel of ['gsd-core/workflows/milestone-summary.md', 'gsd-core/workflows/forensics.md']) {
      const wf = fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8');
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored workflow markdown, bounded prose, not adversarial input
      const m = wf.match(/gsd_run query state\.record-session\b(?:[^\r\n]*\\\r?\n)*[^\r\n]*/);
      assert.ok(m, `${rel} must invoke state.record-session`);
      assert.ok(m[0].includes('--stopped-at') && m[0].includes('--resume-file'),
        `${rel} record-session must use --stopped-at/--resume-file, got:\n${m[0]}`);
      assert.ok(!/state\.record-session\s+"/.test(wf),
        `${rel} record-session must not lead with a positional value`);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3097-3099-executor-worktree-path-safety.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3097-3099-executor-worktree-path-safety (consolidation epic #1969 B7 #1976)", () => {
'use strict';
// allow-test-rule: source-text-is-the-product (see #3097)
// Reads markdown product files (gsd-executor.md, worktree-path-safety.md) to
// verify structural protocol.

// Regression guards for bug #3097 and #3099.
//
// #3097: gsd-executor's worktree HEAD guard used `if [ -f .git ]` to detect
// worktree mode. After a Bash `cd` out of the worktree into the main repo,
// `.git` is a DIRECTORY (not a file), so the test is false and the entire
// HEAD safety block is silently skipped. Commits then land on whatever branch
// the main repo has checked out — not the per-agent worktree branch.
//
// #3099: Executor agents construct absolute paths from `pwd` captured in the
// orchestrator context (main repo root). Edit/Write calls using these paths
// resolve to the main repo, not the worktree. git commit from the worktree
// sees a clean tree; the work is silently lost or leaks to main.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const executorSrc = fs.readFileSync(
  path.join(ROOT, 'agents', 'gsd-executor.md'), 'utf8',
);
const executePhaseSrc = fs.readFileSync(
  path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md'), 'utf8',
);

describe('bug #3097: cwd-drift sentinel in gsd-executor.md', () => {
  test('task_commit_protocol has cwd-drift assertion step (0a)', () => {
    const protocolIdx = executorSrc.indexOf('<task_commit_protocol>');
    const protocolEnd = executorSrc.indexOf('</task_commit_protocol>');
    assert.ok(protocolIdx !== -1 && protocolEnd !== -1, 'task_commit_protocol block not found');
    const protocol = executorSrc.slice(protocolIdx, protocolEnd);
    assert.ok(
      protocol.includes('cwd') || protocol.includes('drift') || protocol.includes('gsd-spawn-toplevel'),
      'task_commit_protocol missing cwd-drift assertion step — #3097 fix not applied',
    );
  });

  test('sentinel uses git rev-parse --git-dir to detect worktree', () => {
    const protocolIdx = executorSrc.indexOf('<task_commit_protocol>');
    const protocolEnd = executorSrc.indexOf('</task_commit_protocol>');
    const protocol = executorSrc.slice(protocolIdx, protocolEnd);
    assert.ok(
      protocol.includes('rev-parse --git-dir') || protocol.includes('worktrees/'),
      'cwd-drift detection does not use git rev-parse --git-dir or .git/worktrees/ pattern',
    );
  });

  test('cwd-drift check precedes HEAD assertion', () => {
    const protocolIdx = executorSrc.indexOf('<task_commit_protocol>');
    const protocolEnd = executorSrc.indexOf('</task_commit_protocol>');
    const protocol = executorSrc.slice(protocolIdx, protocolEnd);
    const driftIdx = protocol.search(/cwd.drift|gsd-spawn-toplevel|drift.*assertion/i);
    const headIdx = protocol.indexOf('Pre-commit HEAD safety assertion');
    assert.ok(driftIdx !== -1, 'cwd-drift assertion not found');
    assert.ok(headIdx !== -1, 'HEAD assertion not found');
    assert.ok(driftIdx < headIdx, 'cwd-drift assertion must precede HEAD assertion (step 0a before step 0)');
  });
});

describe('bug #3099: absolute-path safety guidance in gsd-executor.md', () => {
  test('task_commit_protocol documents absolute-path safety', () => {
    const protocolIdx = executorSrc.indexOf('<task_commit_protocol>');
    const protocolEnd = executorSrc.indexOf('</task_commit_protocol>');
    const protocol = executorSrc.slice(protocolIdx, protocolEnd);
    assert.ok(
      (protocol.includes('absolute') || protocol.includes('absolute-path')) &&
      (protocol.includes('worktree') || protocol.includes('WT_ROOT')),
      'task_commit_protocol missing absolute-path safety guidance — #3099 fix not applied',
    );
  });

  test('execute-phase.md parallel_execution block references path safety', () => {
    const parallelIdx = executePhaseSrc.indexOf('<parallel_execution>');
    assert.ok(parallelIdx !== -1, 'parallel_execution block not found in execute-phase.md');
    // Verify the worktree-path-safety.md reference is present in the execution_context
    // (loaded via @ reference rather than inlined — the safe extract pattern)
    assert.ok(
      executePhaseSrc.includes('worktree-path-safety.md'),
      'execute-phase.md does not reference worktree-path-safety.md in execution_context',
    );
  });

  test('execute-phase prompt anchors subagent file paths to project_root before required_reading (#280)', () => {
    // Anchor on the dispatch's PROJECT_ROOT computation, then require the
    // nearest <required_reading> block to open just before it — the executor
    // must be told to compute the root BEFORE reading the listed files
    // (#3423 note: execute-phase carries several such blocks, so a bare
    // indexOf on the tag can anchor to the wrong one).
    const prIdx = executePhaseSrc.indexOf('PROJECT_ROOT=$(git rev-parse --show-toplevel');
    assert.ok(prIdx !== -1, 'executor dispatch must compute PROJECT_ROOT in the prompt');
    const filesIdx = executePhaseSrc.lastIndexOf('<required_reading>', prIdx);
    assert.ok(filesIdx !== -1, 'required_reading block not found before the PROJECT_ROOT computation');
    assert.ok(prIdx - filesIdx < 1800, 'required_reading block must sit adjacent to the PROJECT_ROOT computation');
    const dispatchSnippet = executePhaseSrc.slice(filesIdx, filesIdx + 1800);
    assert.ok(
      dispatchSnippet.includes('${PROJECT_ROOT}/'),
      'executor required_reading paths must be anchored to ${PROJECT_ROOT}/',
    );
  });

  test('worktree-path-safety.md reference file exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'gsd-core', 'references', 'worktree-path-safety.md')),
      'gsd-core/references/worktree-path-safety.md does not exist',
    );
  });

  test('worktree-path-safety.md contains cwd-drift and absolute-path guards', () => {
    const safetySrc = fs.readFileSync(
      path.join(ROOT, 'gsd-core', 'references', 'worktree-path-safety.md'), 'utf8',
    );
    assert.ok(safetySrc.includes('gsd-spawn-toplevel') || safetySrc.includes('cwd-drift'),
      'worktree-path-safety.md missing cwd-drift sentinel content');
    assert.ok(safetySrc.includes('WT_ROOT') || safetySrc.includes('absolute'),
      'worktree-path-safety.md missing absolute-path guard content');
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #4254 — sequential executors must inherit the orchestrator's root pin.
// The workflow and agent markdown are executable instruction surfaces, so the
// test exercises the shipped guard against a real linked-worktree fixture.
// ────────────────────────────────────────────────────────────────────────
{
  // allow-test-rule: source-text-is-the-product see #4254
  const workflow = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'), 'utf8');
  // allow-test-rule: source-text-is-the-product see #4254
  const agent = fs.readFileSync(path.join(__dirname, '..', 'agents', 'gsd-executor.md'), 'utf8');
  // allow-test-rule: source-text-is-the-product see #4254
  const safetyReference = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'references', 'worktree-path-safety.md'), 'utf8');
  const { createTempGitProject, cleanup } = require('./helpers.cjs');
  const { runHook } = require('./helpers/process-seam.cjs');
  const { gitOrThrow } = require('./helpers/git-fixture.cjs');
  const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
  }

  function extractRootGuard(source, surface) {
    const marker = '# gsd:guard=executor-project-root-pin';
    const fences = source.split('```');
    const guard = fences.find((body) => body.includes(marker));
    assert.ok(guard, `${surface} must ship the mode-agnostic project-root guard (#4254)`);
    return guard.replace(/^bash\r?\n/, '').trim();
  }

  function rootGuardScript(suppliedRoot) {
    const script = extractRootGuard(safetyReference, 'worktree-path-safety reference');
    const assignment = /^SUPPLIED_PROJECT_ROOT=.*$/m;
    assert.match(script, assignment, 'guard must materialize the supplied literal into a shell variable');
    return script.replace(assignment, `SUPPLIED_PROJECT_ROOT=${shellQuote(suppliedRoot)}`);
  }

  function runRootGuard(cwd, suppliedRoot, markerPath) {
    const script = [
      rootGuardScript(suppliedRoot),
      `printf 'write reached\\n' > ${shellQuote(markerPath)}`,
    ].join('\n');
    return runHook('-c', [script], {
      interpreter: 'bash',
      cwd,
      timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  }

  test('#4254: sequential prompt pins the literal orchestrator root at compose time', () => {
    const start = workflow.indexOf('**Sequential mode**');
    const end = workflow.indexOf('4. **Wait for all agents', start);
    assert.ok(start !== -1 && end !== -1, 'sequential dispatch section must exist');
    const sequential = workflow.slice(start, end);
    assert.match(sequential, /<project_root_pin>/, 'sequential prompt must carry an explicit root pin');
    assert.match(sequential, /ORCHESTRATOR_WT/, 'the pin must come from the already-validated orchestrator root');
    assert.match(
      sequential,
      /replace[\s\S]*PROJECT_ROOT=\$\(git rev-parse --show-toplevel[\s\S]*literal value/i,
      'sequential composition must replace worker-side root derivation with the literal pin',
    );
  });

  test('#4254: isolated prompt keeps its worker-local root derivation and receives no orchestrator pin', () => {
    const isolated = workflow.slice(
      workflow.indexOf('**Worktree mode**'),
      workflow.indexOf('**Sequential mode**'),
    );
    assert.match(isolated, /PROJECT_ROOT=\$\(git rev-parse --show-toplevel/, 'isolated executor keeps its own root');
    assert.doesNotMatch(isolated, /<project_root_pin>/, 'isolated prompt must not inherit the orchestrator root');
  });

  test('#4254: executor loads the mode-agnostic supplied-root guard', () => {
    const start = agent.indexOf('<project_root_safety>');
    const end = agent.indexOf('</project_root_safety>', start);
    assert.ok(start !== -1 && end !== -1, 'executor must define project-root safety');
    const safety = agent.slice(start, end);
    assert.match(safety, /worktree-path-safety\.md/, 'executor must load the executable safety reference');
    assert.match(safety, /every mode.*before the first Edit\/Write and every commit/is);
    assert.match(safety, /missing pin warns and proceeds/i);
  });

  test('#4254: supplied-root mismatch halts before the first write', () => {
    const repo = createTempGitProject('gsd-4254-wrong-cwd-');
    try {
      const worktree = path.join(repo, 'linked worktree');
      gitOrThrow(['worktree', 'add', '-q', '-b', 'fix/4254-fixture', worktree], { cwd: repo });
      const markerPath = path.join(repo, 'write-marker');
      const result = runRootGuard(repo, worktree, markerPath);
      assert.equal(result.exitCode, 1, `mismatch must halt: ${result.stderr}`);
      assert.equal(fs.existsSync(markerPath), false, 'no write may run after a root mismatch');
    } finally {
      cleanup(repo);
    }
  });

  test('#4254: missing pin warns and proceeds for older/isolated dispatch compatibility', () => {
    const repo = createTempGitProject('gsd-4254-missing-pin-');
    try {
      const markerPath = path.join(repo, 'write-marker');
      const result = runRootGuard(repo, '', markerPath);
      assert.equal(result.exitCode, 0, `missing pin must remain compatible: ${result.stderr}`);
      assert.equal(fs.existsSync(markerPath), true, 'missing-pin compatibility path must proceed');
    } finally {
      cleanup(repo);
    }
  });
}

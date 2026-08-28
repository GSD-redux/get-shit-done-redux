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

  test('agent defines an MVP+TDD Gate section', () => {
    assert.match(content, /MVP\+TDD\s*Gate|MVP[\s-]?TDD[\s-]?gate/i, 'must label the gate');
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
// RED contract — gsd-core/references/tdd.md (#3770)
//
// #3770: the RED step said only "run (MUST fail)". Any non-zero exit was
// accepted as RED, so a collection error, a crashed fixture, or an unrelated
// failing test all authorized GREEN — while a legitimate outside-in RED that
// never reaches the test body looked identical. The fix is a declared contract
// plus observed evidence, both defined in gsd-core/references/tdd.md.
// ────────────────────────────────────────────────────────────────────────

const { runNode, runGit } = require('./helpers/process-seam.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const TDD_REF = path.join(__dirname, '..', 'gsd-core', 'references', 'tdd.md');

/** The h2 whose body carries the whole contract. */
const CONTRACT_HEADING = 'RED Contract';

/**
 * Slice a markdown h2 section: the heading line through the line before the
 * next h2 (or EOF). Throws when the heading is absent, so a deleted or renamed
 * section fails loudly instead of silently yielding an empty slice.
 * Shared by every contract test below.
 */
function sliceH2(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) throw new Error(`h2 "## ${heading}" not found in tdd.md`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** Slice an h3 subsection out of an already-sliced h2 section. */
function sliceH3(sectionText, heading) {
  const lines = sectionText.split('\n');
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (start === -1) throw new Error(`h3 "### ${heading}" not found in the RED Contract section`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ') || lines[i].startsWith('### ')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** Every fenced block body in a slice, fences excluded. */
function fencedBlocks(text) {
  const blocks = [];
  let open = false;
  let buf = [];
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (open) { blocks.push(buf.join('\n')); buf = []; }
      open = !open;
      continue;
    }
    if (open) buf.push(line);
  }
  return blocks;
}

/** The one fenced block a subsection is specified to carry. */
function soleFencedBlock(sectionText, h3) {
  const blocks = fencedBlocks(sliceH3(sectionText, h3));
  assert.strictEqual(blocks.length, 1, `### ${h3} must carry exactly one fenced block`);
  return blocks[0];
}

function runIsBehaviorAdding(taskContent) {
  const result = runNode(
    [GSD_TOOLS, 'query', 'task.is-behavior-adding', '--task-content', taskContent],
  );
  assert.strictEqual(result.exitCode, 0, `gsd-tools exited ${result.exitCode}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const CONTRACT_TASK_LINES = [
  '<task type="auto" tdd="true">',
  '  <files>src/pricing.py, tests/test_pricing.py</files>',
  '  <behavior>Applying a discount reduces the order total.</behavior>',
  '  <red_contract>',
  '    <target_test>tests/test_pricing.py::test_discount_reduces_total</target_test>',
  '    <implementation_target>pricing.apply_discount</implementation_target>',
  '    <expected_failure>',
  '      <phase>call</phase>',
  '      <class_or_mode>AssertionError</class_or_mode>',
  '      <subject>tests/test_pricing.py::test_discount_reduces_total</subject>',
  '    </expected_failure>',
  '  </red_contract>',
  '</task>',
];

describe('RED contract — router still classifies a red_contract-carrying task (#3770)', () => {
  test('a tdd task carrying both <behavior> and <red_contract> is behavior-adding', () => {
    const parsed = runIsBehaviorAdding(CONTRACT_TASK_LINES.join('\n'));
    assert.strictEqual(parsed.is_behavior_adding, true,
      'adding a <red_contract> sibling must not un-gate the MVP+TDD router');
    assert.strictEqual(parsed.checks.has_behavior_block, true,
      '<behavior> must still be seen alongside <red_contract>');
  });

  test('the same task without <behavior> is not behavior-adding (guard is non-vacuous)', () => {
    const withoutBehavior = CONTRACT_TASK_LINES
      .filter((line) => !line.includes('<behavior>'))
      .join('\n');
    const parsed = runIsBehaviorAdding(withoutBehavior);
    assert.strictEqual(parsed.is_behavior_adding, false,
      '<red_contract> alone must not satisfy the behavior-adding predicate');
    assert.strictEqual(parsed.checks.has_behavior_block, false,
      'has_behavior_block must be false when <behavior> is absent');
  });
});

// allow-test-rule: source-text-is-the-product (see #3770)
// tdd.md is runtime-loaded instruction text embedded verbatim into every
// executor dispatch — its text IS the deployed contract, so reading the file
// is testing the product, not grepping an implementation.
describe('RED contract — gsd-core/references/tdd.md (#3770)', () => {
  const contract = sliceH2(fs.readFileSync(TDD_REF, 'utf-8'), CONTRACT_HEADING);

  /** The `### Evidence` fixture, as the single trailer line it must be. */
  function trailerLine() {
    const lines = soleFencedBlock(contract, 'Evidence')
      .split('\n').map((line) => line.trim()).filter(Boolean);
    assert.strictEqual(lines.length, 1, '### Evidence must carry the trailer as exactly one line');
    return lines[0];
  }

  test('### Declaration names exactly the seven contract tags', () => {
    const block = soleFencedBlock(contract, 'Declaration');
    const found = new Set();
    for (const match of block.matchAll(/<\/?([a-z][a-z_]{0,60})[\s>]/g)) found.add(match[1]);
    assert.deepStrictEqual(
      [...found].sort(),
      ['class_or_mode', 'expected_failure', 'implementation_target', 'phase',
        'red_contract', 'subject', 'target_test'],
      'the declaration example must carry exactly the seven contract tags — ' +
      'a stray, renamed or dropped field is a schema change. See #3770.',
    );
  });

  test('### Evidence names exactly the seven trailer fields', () => {
    const line = trailerLine();
    const parsed = JSON.parse(line.slice(line.indexOf(':') + 1));
    assert.deepStrictEqual(
      Object.keys(parsed).sort(),
      ['actual', 'command', 'exit_status', 'expected', 'selected_count',
        'target_executed', 'target_test'],
      'the trailer must carry exactly the seven evidence fields — the exact-seven ' +
      'key set is itself the fail-closed mechanism: a foreign or future schema ' +
      'fails equality rather than being partially honoured. See #3770.',
    );
    for (const side of ['expected', 'actual']) {
      assert.deepStrictEqual(
        Object.keys(parsed[side]).sort(),
        ['class_or_mode', 'phase', 'subject'],
        `${side} must hold exactly phase, class_or_mode and subject`,
      );
    }
  });

  test('the evidence fixture survives git interpret-trailers as one JSON trailer', () => {
    // Non-vacuity is git's own charset rule: an underscored token (red_evidence)
    // is silently dropped by interpret-trailers and by %(trailers:key=...), which
    // would make the whole gate inert. Verified against git 2.55.0.
    const line = trailerLine();
    const key = line.slice(0, line.indexOf(':'));
    const message = `test(0-00): add failing test\n\nBody paragraph.\n\n${line}\n`;
    const result = runGit(['interpret-trailers', '--parse'], { input: message });
    assert.strictEqual(result.exitCode, 0, `git interpret-trailers failed: ${result.stderr}`);
    const parsedLines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
    assert.strictEqual(parsedLines.length, 1,
      `git parsed ${parsedLines.length} trailers from the fixture, expected exactly 1 — ` +
      'an underscore or other invalid token character makes the trailer inert. See #3770.');
    const sep = parsedLines[0].indexOf(':');
    assert.strictEqual(parsedLines[0].slice(0, sep), key,
      'git must round-trip the documented trailer token unchanged');
    JSON.parse(parsedLines[0].slice(sep + 1));
  });

  test('the predicate scopes selection and execution to the target-test arm', () => {
    const lines = soleFencedBlock(contract, 'RED Predicate').split('\n');
    const openers = [];
    const disjunctions = [];
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.endsWith('(')) openers.push(i);
      if (trimmed === 'OR') disjunctions.push(i);
    });
    assert.strictEqual(openers.length, 1, 'the predicate must open exactly one parenthesised group');
    assert.strictEqual(disjunctions.length, 1, 'the parenthesised group must have exactly two arms');
    assert.ok(openers[0] < disjunctions[0], 'the group must open before the disjunction keyword');

    for (const field of ['selected_count', 'target_executed']) {
      const hits = [];
      lines.forEach((line, i) => { if (line.includes(field)) hits.push(i); });
      assert.ok(hits.length > 0, `${field} must appear in the predicate at all`);
      for (const i of hits) {
        assert.ok(i > openers[0] && i < disjunctions[0],
          `${field} on predicate line ${i + 1} sits outside the target-test arm. ` +
          'Hoisted above the group it blocks every outside-in RED (which reports 0 and ' +
          'false by construction); pushed below the keyword it stops guarding the target ' +
          'arm. It belongs strictly between the opener and the disjunction. See #3770.');
      }
    }

    const outsideInArm = lines.slice(disjunctions[0] + 1).join('\n');
    assert.match(outsideInArm, /plan\.implementation_target/,
      'the outside-in arm must anchor the observed subject to the declared implementation target');
    assert.match(outsideInArm, /outside-in missing-target mode/,
      'the outside-in arm must keep its second conjunct — without it, any declaration whose ' +
      'expected class happens to match slips through. Dropped twice already. See #3770.');
  });
});

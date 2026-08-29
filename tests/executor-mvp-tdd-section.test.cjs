/**
 * gsd-executor agent — MVP+TDD gate section contract
 * Verifies the agent definition contains a section instructing the executor
 * to halt and report when the runtime gate trips.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

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

const { runNode, runGit, runHook } = require('./helpers/process-seam.cjs');
const { createTempDir, createTempGitProject, cleanup } = require('./helpers.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const TDD_REF = path.join(__dirname, '..', 'gsd-core', 'references', 'tdd.md');
const PLANNER = path.join(__dirname, '..', 'agents', 'gsd-planner.md');

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

/** tdd.md exactly as shipped, and the `## RED Contract` h2 it carries. */
const TDD_SOURCE = fs.readFileSync(TDD_REF, 'utf-8');
const CONTRACT = sliceH2(TDD_SOURCE, CONTRACT_HEADING);

/** The `### Evidence` fixture, as the single trailer line it must be. */
function trailerLine() {
  const lines = soleFencedBlock(CONTRACT, 'Evidence')
    .split('\n').map((line) => line.trim()).filter(Boolean);
  assert.strictEqual(lines.length, 1, '### Evidence must carry the trailer as exactly one line');
  return lines[0];
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
  test('### Declaration names exactly the seven contract tags', () => {
    const block = soleFencedBlock(CONTRACT, 'Declaration');
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

  test('the outside-in missing-target mode is defined by a declared-field equality', () => {
    const declaration = sliceH3(CONTRACT, 'Declaration');
    const opener = '| `expected_failure.subject` |';
    const rows = declaration.split('\n').filter((line) => line.trim().startsWith(opener));
    assert.strictEqual(rows.length, 1,
      `### Declaration must carry exactly one "${opener}" field row to define the mode in`);
    const row = rows[0];

    assert.ok(row.includes('is an outside-in missing-target mode'),
      'the subject row must name the mode with the predicate\'s own spelling. The second arm ' +
      'reads `plan.expected_failure is an outside-in missing-target mode`; a definition that ' +
      'spells it differently is not lexically bound to the conjunct it defines. See #3770.');
    assert.match(row, /`expected_failure\.subject`[^|]*equals[^|]*`implementation_target`/,
      'the mode must be defined as an equality between two declared fields — ' +
      '`expected_failure.subject` equal to `implementation_target`. Phase 3 has to mechanize ' +
      'the second arm from the declaration alone; a descriptive gloss is not decidable. ' +
      'See #3770.');
    assert.ok(row.includes('never routes on the observed'),
      'the row must keep the true half of the routing claim: the predicate never routes on ' +
      'the OBSERVED subject. See #3770.');
    assert.ok(!row.includes('and never routes on it'),
      'the row still claims the predicate never routes on `expected_failure.subject`. That ' +
      'is false and it is what left the second arm unmechanizable: the declared equality is ' +
      'the only decidable meaning the arm has. See #3770.');

    for (const [where, text] of [
      ['### Declaration', declaration],
      ['the ### RED Predicate block', soleFencedBlock(CONTRACT, 'RED Predicate')],
      ['### Outcomes', sliceH3(CONTRACT, 'Outcomes')],
    ]) {
      assert.ok(text.includes('outside-in missing-target mode'),
        `${where} must spell the mode "outside-in missing-target mode". The predicate, its ` +
        'definition and its outcome row have to name one thing one way, or the existing ' +
        'outside-in assertion pins a spelling the rest of the file does not use. See #3770.');
    }
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

    // STATIC BOUNDS CHECK — this assertion passes against baseline text and has
    // no honest RED, because the shipped exemplar's `command` is already
    // credential-free. It is a fence against a FUTURE edit, not evidence that
    // anything was repaired, and it is deliberately NOT counted among this
    // plan's mutation-killed assertions.
    assert.doesNotMatch(parsed.command,
      /\bsk-[A-Za-z0-9]|:\/\/[^/\s:]+:[^/\s@]+@|--?(token|password|secret|api[-_]?key)[= ]\S/i,
      'the contract must not teach a leak by example: the shipped `command` exemplar must ' +
      'carry no credential-shaped value. `command` lands in a git trailer, and a git trailer ' +
      'lands in permanent published history that `git commit --amend` cannot unpublish once ' +
      'pushed. See #3770 (CR-10).');
  });

  test("the contract's shipped definitions, outcome rows and obligations are each pinned", () => {
    // One row per load-bearing line the suite used to tolerate deleting: every one of
    // these was mutated away against a green suite (02-VERIFICATION.md N2, N3, N5, N6,
    // N8, N9). A future obligation costs one row here, not one new test. `verdict` is
    // non-null only for ### Outcomes rows, and it is asserted on the SAME line as the
    // needle, so deleting a row and flipping its verdict both fail.
    const rows = [
      {
        section: 'Evidence',
        needle: '`command` lands in permanent published Git history',
        verdict: null,
        why: "this is the phase's only security control and 02-SECURITY.md records T-02-02 as "
          + 'closed on the strength of it; mutation N9 deleted it against a green suite',
      },
      {
        section: 'Evidence',
        needle: 'This is an obligation, not a pattern list',
        verdict: null,
        why: 'the obligation form is load-bearing — narrowed to a pattern list, every unlisted '
          + 'credential position leaks by omission',
      },
      {
        section: 'Evidence',
        needle: "`target_executed` is true when some member of the run's executed-and-reported set",
        verdict: null,
        why: '`target_executed` is a conjunct of the target-test arm, and a conjunct whose term '
          + 'the contract never defines is unmechanizable by the coded gate — CR-01 exactly',
      },
      {
        section: 'Evidence',
        needle: '`id_matches(observed, declared)` is true when `observed === declared`',
        verdict: null,
        why: 'the predicate body uses `id_matches` and that use is already pinned; deleting only '
          + 'its definition reproduces CR-01',
      },
      {
        section: 'Evidence',
        needle: '`declared` followed **immediately** by a runner-native variant delimiter',
        verdict: null,
        why: 'a definition narrowed to exact equality alone blocks the legitimate parameterized '
          + 'RED that `id_matches` exists to admit, so both halves must be pinned',
      },
      {
        section: 'Outcomes',
        needle: 'Zero tests selected',
        verdict: 'block',
        why: 'the Outcomes rows ARE REDC-03 in shipped form, so an unpinned row is an unpinned '
          + 'requirement',
      },
      {
        section: 'Outcomes',
        needle: 'Suite failed to collect or parse',
        verdict: 'block',
        why: 'a test-file SyntaxError is not the declared missing target and must never '
          + 'authorize GREEN',
      },
      {
        section: 'Outcomes',
        needle: 'Fixture or setup crashed before the target assertion',
        verdict: 'block',
        why: 'a crash before the target assertion proves nothing about the target behavior',
      },
      {
        section: 'Outcomes',
        needle: 'A different test failed',
        verdict: 'block',
        why: "this row IS #3770's original defect; mutation N5 deleted it and the suite stayed "
          + 'green',
      },
      {
        section: 'Outcomes',
        needle: 'Genuine target-behavior failure',
        verdict: 'authorize',
        why: 'the one outcome the whole contract exists to admit',
      },
      {
        section: 'Outcomes',
        needle: 'Outside-in: the declared implementation target is missing',
        verdict: 'authorize',
        why: 'the outside-in arm is authorized with no selection or execution condition, and '
          + 'deleting the row is how that permission silently disappears',
      },
      {
        section: 'Outcomes',
        needle: 'Fixture is itself the behavior under test',
        verdict: 'authorize',
        why: 'a fixture-phase failure is legitimate RED when the fixture is the behavior',
      },
      {
        section: 'Outcomes',
        needle: 'Unexpected pass',
        verdict: 'halt',
        why: 'mutation N6 deleted it and the suite stayed green; halt is not block, and a '
          + 'flipped verdict would have the cycle retry a passing test forever',
      },
      {
        section: 'RED Predicate',
        needle: '`exit_status == 0` is an unexpected pass',
        verdict: null,
        why: 'the halt rule sits outside the predicate and nothing else in the file states it',
      },
      {
        section: 'RED Predicate',
        needle: 'neither valid RED nor an invalid RED to retry — halt the cycle',
        verdict: null,
        why: "mutation N8 deleted the whole paragraph — ROADMAP Phase 2 SC3's second half — "
          + 'and the suite stayed green',
      },
      {
        section: 'Evidence',
        needle: 'Recorded for audit only: the predicate reads no field of it',
        verdict: null,
        why: 'without the stated limitation a coded-gate implementer reads `command` as '
          + 'validated input bound to `target_test`, which nothing in the predicate makes it',
      },
      {
        section: 'Evidence',
        needle: 'a credential typed literally has no originating variable to name',
        verdict: null,
        why: 'the obligation\'s only remedy was to substitute the originating variable\'s '
          + 'placeholder name, which has no meaning for a credential typed literally — so the '
          + 'shipped remedy covered neither of the two positions the review reproduced',
      },
      {
        section: 'RED Predicate',
        needle: 'no condition proving the target test exists',
        verdict: null,
        why: 'the arm-2 scoping rationale must name the compensating condition, which lives in '
          + 'execute-mvp-tdd.md, or the coded gate gets built with a real hole in it',
      },
      {
        section: 'RED Predicate',
        needle: 'does not prove that the missing entity is the declared `implementation_target`',
        verdict: null,
        why: 'arm 2 proves the failure belongs to the declared TEST FILE, not that it concerns '
          + 'the declared implementation target — an unrelated missing dependency in that same '
          + 'file, at the same declared phase and class, satisfies every conjunct. Deleting the '
          + 'note would leave the contract silently claiming a guarantee it does not provide, '
          + 'and Phase 3 would build a coded gate from that claim',
      },
      {
        section: 'Declaration',
        needle: 'offers no single test id to select — and record `expected_failure.subject`, '
          + '`target_test` and the observed `actual.subject`',
        verdict: null,
        why: '`id_matches` admits an observed id equal to or longer than the declared one, never '
          + 'shorter, and go reports a compile-time miss against `./pricing_test.go:6:12` while '
          + 'the declaration says `./pricing_test.go` — the unmatched suffix begins `:` and not '
          + '`[`, so unless the rule binds the OBSERVED `actual.subject` too, `id_matches` is '
          + 'false and a legitimate go outside-in RED is rejected by the contract that exists to '
          + 'admit it. The needle spans the junction between the granularity half and the '
          + 'recording half on purpose: one sentence carrying two ideas can be half-deleted',
      },
      {
        section: 'Declaration',
        needle: 'Recorded for audit only: the predicate reads no field of it',
        verdict: null,
        why: '`implementation_target` has no predicate role; a reader who believes the predicate '
          + 'compares it will re-derive the unsatisfiable arm 2 this plan removed',
      },
      {
        section: 'Declaration',
        needle: 'The production module or symbol GREEN will create or change',
        verdict: null,
        why: 'the shipped exemplar expects a `call`-phase `AssertionError`, which requires the '
          + 'symbol to already exist; a create-only definition makes the exemplar’s own '
          + 'declared state unreachable',
      },
      {
        section: 'Declaration',
        needle: 'a mode marker naming production intent, not a prediction of what the runner '
          + 'will print',
        verdict: null,
        why: 'with the observed subject always the test file, the declared equality is the ONLY '
          + 'thing left that selects arm 2, and it selects from declared fields alone before any '
          + 'run',
      },
      {
        section: 'Evidence',
        needle: '`id_matches` relates the observed subject to `plan.target_test` in both arms',
        verdict: null,
        why: 'the sentence said the relation applies to the target-test arm only, which becomes '
          + 'false the moment arm 2 uses it; a stale scoping sentence is how a reader concludes '
          + 'the two arms compare different things',
      },
    ];

    for (const row of rows) {
      const hits = sliceH3(CONTRACT, row.section).split('\n')
        .filter((line) => line.includes(row.needle));
      assert.strictEqual(hits.length, 1,
        `### ${row.section} must carry exactly one line containing "${row.needle}" — ${row.why}. `
        + `Found ${hits.length}. See #3770.`);
      if (row.verdict !== null) {
        assert.ok(hits[0].trim().endsWith(`| ${row.verdict} |`),
          `the "${row.needle}" outcome must keep the verdict \`${row.verdict}\` on its own row — `
          + `${row.why}. Observed: ${hits[0].trim()}. See #3770.`);
      }
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
    const lines = soleFencedBlock(CONTRACT, 'RED Predicate').split('\n');
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

    // Sliced, not whole-block: moving the anchor down into the outside-in arm
    // must fail here too, and a whole-block match would happily accept it.
    const targetArm = lines.slice(openers[0] + 1, disjunctions[0]).join('\n');
    assert.match(targetArm, /AND id_matches\(actual\.subject, plan\.target_test\)/,
      'the target-test arm must keep its subject anchor. Without it the arm reduces to ' +
      '`selected_count > 0 AND target_executed` plus the shared comparisons, which a run ' +
      'where a DIFFERENT test failed satisfies — the outcome the Outcomes table says must ' +
      'block, and the original defect. See #3770.');

    const outsideInArm = lines.slice(disjunctions[0] + 1).join('\n');
    const arm2Anchor = '    id_matches(actual.subject, plan.target_test)';
    assert.match(outsideInArm,
      new RegExp(`^${escapeRegex(arm2Anchor)}$`, 'm'),
      'the outside-in arm must anchor the observed subject on the DECLARED TARGET TEST. ' +
      '`actual.subject == plan.implementation_target` is unsatisfiable: no runner reports an ' +
      'outside-in miss against the implementation symbol — pytest reports it against the test ' +
      'file and go against `./pricing_test.go:6:12` — so the only routes to a passing arm were ' +
      'to fabricate the subject or to abandon outside-in RED. Matched as a whole line under ' +
      '`^…$` with the `m` flag, so a paraphrase, a reordering or a superset line fails here ' +
      'rather than passing on a substring. See #3770.');
    assert.match(outsideInArm, /outside-in missing-target mode/,
      'the outside-in arm must keep its second conjunct — without it, any declaration whose ' +
      'expected class happens to match slips through. Dropped twice already. See #3770.');
  });

  test("the predicate's four shared conjuncts are active above the arms", () => {
    const lines = soleFencedBlock(CONTRACT, 'RED Predicate').split('\n');
    const leadingOf = (line) => line.slice(0, line.length - line.trimStart().length);

    const opener = lines.findIndex((line) => line.trim().endsWith('('));
    assert.ok(opener > -1, 'the predicate must open a parenthesised group');
    const anchor = lines.findIndex((line) => line.trim() === 'exit_status != 0');
    assert.ok(anchor > -1, 'the predicate must carry `exit_status != 0` as its first conjunct');
    const sharedIndent = leadingOf(lines[anchor]);

    // Trimmed-form equality, so a `# `-prefixed line can never satisfy it: a
    // conjunct commented back out reads as absent, exactly like a deleted one.
    for (const conjunct of [
      'AND trailer.expected == plan.expected_failure',
      'AND actual.phase == expected.phase',
      'AND actual.class_or_mode == expected.class_or_mode',
      'AND trailer.target_test == plan.target_test',
    ]) {
      const i = lines.findIndex((line) => line.trim() === conjunct);
      assert.ok(i > -1,
        `the shared conjunct \`${conjunct}\` is missing or commented out. All four shared ` +
        'conjuncts are unconditional: two pin the trailer\'s `expected` and `target_test` ' +
        'echoes to the plan declaration, and the other two only carry meaning once that ' +
        'pinning holds. This assertion IS the mutation test — deleting the line turns the ' +
        'suite red, which is what nothing did before. See #3770.');
      assert.ok(i < opener,
        `the shared conjunct \`${conjunct}\` sits on predicate line ${i + 1}, at or below the ` +
        `parenthesised group opener on line ${opener + 1}. A shared conjunct pushed into the ` +
        'group stops guarding the arm it is not in. See #3770.');
      assert.strictEqual(leadingOf(lines[i]), sharedIndent,
        `the shared conjunct \`${conjunct}\` is indented ${leadingOf(lines[i]).length} spaces, ` +
        `not the ${sharedIndent.length} of \`exit_status != 0\`. Depth is the only thing ` +
        'distinguishing a shared conjunct from an arm conjunct in this block. See #3770.');
    }
  });

  test(
    "the predicate's prose names the pinning pair and claims nothing the predicate does not do",
    () => {
      // Everything after the closing fence: the prose paragraphs only. The scoping is
      // load-bearing twice — the positive assertions must not be satisfiable by the
      // fence's own conjunct lines, and the negative must not reach the halt rule's
      // legitimate `fails the first conjunct` at the foot of the same h3.
      const prose = sliceH3(CONTRACT, 'RED Predicate').split('```')[2];
      assert.ok(prose, '### RED Predicate must carry prose below its fenced block');

      for (const conjunct of [
        'trailer.expected == plan.expected_failure',
        'trailer.target_test == plan.target_test',
      ]) {
        assert.ok(prose.includes(conjunct),
          `the pinning-pair sentence must name \`${conjunct}\` by its text, not by position. `
          + "An ordinal contradicts this same file's inclusive conjunct counting eighteen lines "
          + 'below, and mutation N13 rewrote that ordinal in the opposite direction against a '
          + 'green suite — it was unpinned in both directions. See #3770.');
      }

      const ordinalPair = new RegExp(
        '\\b(first|second|third|fourth|fifth)\\s{1,3}and\\s{1,3}'
        + '(first|second|third|fourth|fifth)\\s{1,3}shared\\s{1,3}conjuncts\\b',
        'i',
      );
      assert.doesNotMatch(prose, ordinalPair,
        'the prose must not name the shared conjuncts as an ordinal pair. The counting is '
        + 'ambiguous against the halt rule eighteen lines below, which counts inclusively, so '
        + 'one of the two statements is always wrong. Name them by their text. See #3770.');

      assert.ok(!prose.includes('strictly stronger'),
        'the prose must not claim that omitting the `subject` comparison is strictly stronger. '
        + 'It is false in a reachable configuration: arm 1 never requires '
        + '`expected.subject == plan.target_test`, so an outside-in declaration judged by arm 1 '
        + 'is authorized with `actual.subject != expected.subject`. See 02-VERIFICATION.md '
        + 'Warning 5(a) and #3770.');
    },
  );
});

/**
 * `<red_contract>` is a SIBLING of `<behavior>`, never an attribute on it:
 * src/task-command-router.cts's literal `<behavior>` regex tolerates no
 * attributes, so an attributed element would silently exempt the task from the
 * MVP+TDD gate. Equal leading whitespace on the two opening lines is that proof.
 */
function assertSiblingRedContract(block, where) {
  const lines = block.split('\n');
  const opener = (tag) => {
    const i = lines.findIndex((line) => line.trimStart().startsWith(`<${tag}>`));
    assert.ok(i > -1, `${where} must show <${tag}> — a worked example that omits it teaches the ` +
      'pre-#3770 shape, which is what a reader copies. See #3770.');
    return lines[i];
  };
  const behavior = opener('behavior');
  const redContract = opener('red_contract');
  const indentOf = (line) => line.slice(0, line.length - line.trimStart().length);
  assert.strictEqual(indentOf(redContract), indentOf(behavior),
    `${where} must place <red_contract> as a SIBLING of <behavior>, at the same depth. ` +
    'Nested inside <behavior>, or hung off it as an attribute, it stops being the element ' +
    'the contract mandates. See #3770.');
}

// allow-test-rule: source-text-is-the-product (see #3770)
// The worked examples in tdd.md and gsd-planner.md are the shapes a planner
// copies; their shipped text IS the instruction, so reading it is the test.
describe('RED contract — worked examples carry <red_contract> (#3770)', () => {
  test('the TDD Plan Structure template carries <red_contract> beside <behavior>', () => {
    const blocks = fencedBlocks(sliceH2(TDD_SOURCE, 'TDD Plan Structure'));
    assert.strictEqual(blocks.length, 1, '## TDD Plan Structure must carry one fenced template');
    assertSiblingRedContract(blocks[0], 'the TDD Plan Structure template');

    for (const tag of ['target_test', 'implementation_target', 'phase', 'class_or_mode', 'subject']) {
      assert.ok(blocks[0].includes(`<${tag}>`),
        `the TDD Plan Structure template must show the <${tag}> leaf — a <red_contract> with ` +
        'missing leaves declares nothing the predicate can pin against. See #3770.');
    }
  });

  test('the Red-Green-Refactor RED step points at the RED contract', () => {
    const cycle = sliceH2(TDD_SOURCE, 'Red-Green-Refactor Cycle');
    assert.ok(cycle.includes('**RED - Write failing test:**'),
      'the cycle must still carry its RED step — this guards the two assertions below ' +
      'from passing vacuously against a deleted section');
    assert.ok(cycle.includes('tdd="true"'),
      'the RED step must say which tasks the extra obligation binds');
    assert.ok(cycle.includes('red_contract_spec'),
      'the RED step must point forward at <red_contract_spec>. Left as bare "it MUST fail" it ' +
      'restates the exact pre-#3770 rule this contract replaces, 17 lines above the replacement. ' +
      'See #3770.');
  });

  test("the planner's task-level TDD example carries <red_contract> beside <behavior>", () => {
    const tddBlocks = fencedBlocks(fs.readFileSync(PLANNER, 'utf-8'))
      .filter((block) => block.includes('tdd="true"'));
    assert.strictEqual(tddBlocks.length, 1,
      'gsd-planner.md must carry exactly one tdd="true" worked example to guard');
    assertSiblingRedContract(tddBlocks[0], "the planner's task-level TDD example");
  });
});

// allow-test-rule: source-text-is-the-product (see #3770)
// tdd.md is the canonical RED source; these guard it against contradicting
// itself two headings below the contract it now owns.
describe("RED contract — tdd.md's own gate sections defer to it (#3770)", () => {
  test("tdd.md's own gate sections defer to the RED contract", () => {
    const start = TDD_SOURCE.indexOf('## Gate Enforcement Rules');
    assert.ok(start > -1, 'tdd.md must carry ## Gate Enforcement Rules');
    const end = TDD_SOURCE.indexOf('</gate_enforcement>', start);
    assert.ok(end > -1, 'the gate-enforcement region must be closed');
    const gates = TDD_SOURCE.slice(start, end);

    assert.ok(gates.includes('| RED |'),
      'the Gate Definitions table must still carry its RED row — this guards the negative ' +
      'assertion below from being satisfied by deleting the table');
    assert.ok(gates.includes('red-evidence'),
      'the gate region must name the red-evidence: trailer it validates against');
    assert.ok(gates.includes('RED Contract'),
      'the gate region must cite the RED Contract section rather than re-deciding RED itself');
    // The pre-#3770 rule, scoped to this region only: ## RED Contract and its
    // Outcomes table legitimately discuss failing before implementation.
    assert.ok(!gates.includes('Test exists AND fails before implementation'),
      'the gate region still presents the commit-subject-only rule as the RED validation. ' +
      'Two versions of RED then coexist unqualified in the same canonical file. See #3770.');
  });

  test('the executor gate snippet matches on the commit subject and guards the empty SHA', () => {
    const snippet = soleFencedBlock(
      sliceH2(TDD_SOURCE, 'Gate Enforcement Rules'), 'Executor Gate Validation',
    );

    // Scoped to the fenced block, not the file: prose elsewhere may legitimately
    // explain why the whole-message flag is wrong, and a file-wide negative would
    // forbid its own rationale.
    assert.ok(!snippet.includes('--grep='), // planner-discipline-allow: --grep=
      'the gate snippet still searches the whole commit message. That matches a commit which ' +
      'merely quotes a `test(...)` subject in its body, and `head -1` then prefers it because ' +
      'git logs newest-first — so the executor reads the wrong commit\'s trailer. Reproduced ' +
      'on git 2.55.0. See #3770.');

    for (const kind of ['feat', 'refactor']) {
      const anchored = `grep -m1 -E "^[0-9a-f]+ ${kind}\\(`;
      assert.ok(snippet.includes(anchored),
        `the ${kind}(...) search must be anchored to the commit subject via \`${anchored}\`. ` +
        'All three searches share the same defect, so all three carry the fix. See #3770.');
    }

    // The RED search is split out of the loop above because its record gained
    // fields: it now selects on the trailer as well as the subject, in one
    // pass. This is STRICTLY MORE SPECIFIC than the shared `^[0-9a-f]+ test\(`
    // prefix it replaces — the subject anchor is still required, and a
    // non-empty trailer field is required alongside it. See #3770.
    assert.ok(snippet.includes(`grep -m1 -E "^[0-9a-f]+\${TAB}[^\${TAB}]+\${TAB}test\\(`),
      'the RED search must select the newest candidate that is BOTH anchored to this plan\'s ' +
      'commit subject AND carries a non-empty red-evidence: trailer field. Selecting on ' +
      'position alone (CR-04) lets a newer trailerless same-plan commit shadow the real RED.');

    assert.match(snippet, /if \[ -z "\$RED_SHA" \]/,
      'the snippet must guard the empty RED_SHA. Unguarded, `git log -1 --format=… ""` exits ' +
      '128 with a fatal ambiguous-argument error — and that is the most likely gate trip of ' +
      'all. See #3770.');
    assert.ok(snippet.includes('missing_red_commit'),
      'no commit whose subject matches is a different outcome from a commit that exists ' +
      'without the trailer; the snippet must report it as `missing_red_commit`. See #3770.');
  });

  test('the shipped gate snippet runs clean on a compliant plan and reads the right commit', (t) => {
    const snippet = soleFencedBlock(
      sliceH2(TDD_SOURCE, 'Gate Enforcement Rules'), 'Executor Gate Validation',
    );

    // The snippet is EXTRACTED and EXECUTED, never retyped: CR-03 shipped
    // because a text assertion judged the block's last statement "exit-safe"
    // by reading it. A gate's exit status is only observable by running it.
    // Mechanism copied from tests/unreachable-shell-guard.test.cjs:144-150 —
    // a script PATH through the process seam, never a `bash -c` argv string
    // (#2650: quote-dense multi-line scripts do not survive Windows argv
    // serialization). One script under test, so it is written ONCE here
    // rather than copied into a fourth runBashScript helper.
    const scriptDir = createTempDir('gsd-3770-gate-sh-');
    t.after(() => cleanup(scriptDir));
    const scriptPath = path.join(scriptDir, 'gate.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\nset -e\n${snippet}`, { mode: 0o755 });

    const runGate = (cwd) => runHook(scriptPath, [], {
      interpreter: 'bash', cwd, env: { ...process.env, PHASE: '08', PLAN: '02' },
    });

    // Derived from the shipped `### Evidence` fixture, never retyped; the
    // marker makes the emitted value say WHICH commit was selected.
    const shipped = trailerLine();
    const evidence = (mark) => {
      const parsed = JSON.parse(shipped.slice(shipped.indexOf('{')));
      parsed.command = `${parsed.command} # ${mark}`;
      return `red-evidence: ${JSON.stringify(parsed)}`;
    };

    const newRepo = () => {
      // createTempGitProject already runs init, user.email, user.name and
      // commit.gpgsign false. The ONE thing it does not do is disarm a
      // globally configured core.hooksPath, which would otherwise run this
      // machine's commit-msg hook inside the fixture.
      const dir = createTempGitProject('gsd-3770-gate-');
      t.after(() => cleanup(dir));
      runGit(['config', 'core.hooksPath', ''], { cwd: dir });
      return dir;
    };
    const commit = (cwd, file, subject, trailer) => {
      const abs = path.join(cwd, file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `# ${subject}\n`);
      runGit(['add', file], { cwd });
      // A second -m so git parses the trailer as a TRAILER, not body prose.
      runGit(trailer ? ['commit', '-m', subject, '-m', trailer] : ['commit', '-m', subject], { cwd });
      return runGit(['rev-parse', 'HEAD'], { cwd }).stdout.trim();
    };

    // ── S1, compliant RED-only (CR-03) ───────────────────────────────────
    // The normal state of EVERY plan between RED and GREEN.
    const s1 = newRepo();
    commit(s1, 'tests/test_pricing.py', 'test(08-02): add failing test for discount', evidence('S1'));
    const r1 = runGate(s1);
    assert.strictEqual(r1.exitCode, 0,
      'CR-03: the shipped gate must exit 0 on a compliant RED-only plan. It exits 1 today, and ' +
      'that is the normal state of every plan between RED and GREEN, so an agent keying off ' +
      'the exit status reads a gate failure where none exists. See #3770.');
    assert.ok(r1.stdout.includes('# S1'),
      'the gate must emit the RED commit\'s trailer value');
    assert.ok(!r1.stdout.includes('add failing test for discount'),
      'the gate must emit the TRAILER, never a commit subject');
    assert.match(r1.stdout, /feat\(08-02\)|GREEN/,
      'an absent GREEN commit must still be REPORTED — the report survives while the gate ' +
      'stays open, because this block also runs mid-cycle');

    // ── S2, the five-condition repository (CR-04, plus M1 and M4) ────────
    const s2 = newRepo();
    const realRed = commit(s2, 'tests/test_pricing.py',
      'test(08-02): add failing test for discount', evidence('S2-REAL'));
    commit(s2, 'src/pricing.py', 'feat(08-02): implement discount');
    // Newer, same plan, trailerless — the shadow decoy — AND a body that
    // mentions red-evidence: mid-message so it cannot parse as a trailer.
    runGit(['commit', '--allow-empty', '-m', 'test(08-02): add another failing test',
      '-m', 'red-evidence: S2-BODY-PROSE', '-m', 'trailing paragraph so the above is body, not a trailer'],
    { cwd: s2 });
    fs.writeFileSync(path.join(s2, 'tests', 'test_pricing.py'), '# another\n');
    runGit(['add', 'tests/test_pricing.py'], { cwd: s2 });
    runGit(['commit', '--amend', '--no-edit'], { cwd: s2 });
    // NO refactor(...) commit anywhere. Newest commit is the cross-plan decoy.
    commit(s2, 'tests/test_other.py', 'test(09-01): unrelated plan', evidence('S2-CROSS'));
    const r2 = runGate(s2);
    assert.strictEqual(r2.exitCode, 0,
      'the five-condition repository is compliant: an absent OPTIONAL refactor commit is not ' +
      'a violation. See #3770.');
    assert.ok(r2.stdout.includes('# S2-REAL'),
      `CR-04: the gate must select the newest commit that is BOTH plan-scoped AND ` +
      `evidence-bearing (${realRed}). Selecting on position alone lets a newer trailerless ` +
      'same-plan commit shadow the real RED. See #3770.');
    assert.ok(!r2.stdout.includes('# S2-CROSS'),
      'CR-11 M1: an unscoped `test\\(` selects the cross-plan decoy — the NEWEST commit here — ' +
      'and authorizes this plan\'s GREEN on another plan\'s RED. See #3770.');
    assert.ok(!r2.stdout.includes('S2-BODY-PROSE'),
      'CR-11 M4: reading %B instead of the trailer key reads a commit that merely QUOTES a ' +
      'red-evidence: line in its body as if it were evidence. See #3770.');
    assert.ok(!r2.stdout.includes('add another failing test'),
      'the gate must emit the trailer, never a commit subject');

    // ── S3, RED commit touches no test file (CR-02, F1) ──────────────────
    const s3 = newRepo();
    commit(s3, 'src/pricing.py', 'test(08-02): add failing test for discount', evidence('S3'));
    const r3 = runGate(s3);
    assert.notStrictEqual(r3.exitCode, 0,
      'F1 / T-02-05-13: a RED commit that touches NO test file is a violation, and the ' +
      'snippet must exit NON-ZERO on it. The previous draft asserted exitCode === 0 here; ' +
      'that assertion IS the finding, not the fix. The threat model\'s own words are that ' +
      'the exit status and the commit selection ARE the gate, so a violation that prints and ' +
      'returns 0 makes the only shipped gate a diagnostic. Do not relax this without ' +
      'arguing with that reason. See #3770.');
    assert.match(r3.stdout, /touches no test file/,
      'CR-02: the gate must REPORT that the RED commit touches no test file. The ' +
      'compensating condition previously lived only in execute-mvp-tdd.md, which loads only ' +
      'when MVP_MODE=true — not this project\'s live path (upstream #4011). See #3770.');

    // ── S4, matching commits with no evidence (CR-04, F1) ────────────────
    const s4 = newRepo();
    commit(s4, 'tests/test_pricing.py', 'test(08-02): add failing test for discount');
    commit(s4, 'tests/test_more.py', 'test(08-02): add failing test for discount');
    const r4 = runGate(s4);
    assert.notStrictEqual(r4.exitCode, 0,
      'F1: matching commits that carry no evidence is a violation and must exit NON-ZERO');
    assert.match(r4.stdout, /none carries a `?red-evidence:/,
      'the two RED failures need DIFFERENT remedies and must stay distinguished: this one ' +
      'means amend the trailer onto the commit you already made, and it is NOT ' +
      'missing_red_commit, which means write one. See #3770.');
    assert.ok(!r4.stdout.includes('missing_red_commit'),
      'matching-commits-without-evidence must not be reported as missing_red_commit');

    // ── S5, no subject-matching commit at all (F2) ───────────────────────
    const s5 = newRepo();
    commit(s5, 'src/pricing.py', 'feat(08-02): implement discount');
    const r5 = runGate(s5);
    assert.notStrictEqual(r5.exitCode, 0,
      'F2: no RED commit at all is a violation and must exit NON-ZERO. The previous draft let ' +
      'this case fall through to an exit-0 tail. See #3770.');
    assert.ok(r5.stdout.includes('missing_red_commit'),
      'the snippet must echo `missing_red_commit` verbatim when no subject matches');
  });

  test('every surface that instructs on the unexpected pass defers to the RED Contract', () => {
    const EXECUTOR = fs.readFileSync(AGENT, 'utf-8');
    const EXECUTE_PLAN = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan.md'), 'utf-8',
    );

    // Region-scoped, never file-scoped: `## RED Contract`'s own Outcomes table
    // and its halt rule legitimately discuss the unexpected pass, and a
    // file-wide negative would forbid the contract's own statement of it.
    const region = (source, from, to, label) => {
      const start = source.indexOf(from);
      assert.ok(start > -1, `${label}: missing region start marker ${from}`);
      const end = source.indexOf(to, start + from.length);
      assert.ok(end > -1, `${label}: missing region end marker ${to}`);
      return source.slice(start, end);
    };

    // The FIRST region is the `**Test doesn't fail in RED phase:**` SUBSECTION,
    // not the whole <error_handling> block. That block also contains
    // `**Unrelated tests break:**`, which legitimately ends in the same
    // fix-and-proceed guidance — a broken unrelated test is NOT an unexpected
    // pass, and that guidance is correct and stays. A negative over the whole
    // block would either fail permanently or be weakened until it caught
    // nothing.
    const redPhaseSubsection = region(TDD_SOURCE,
      "**Test doesn't fail in RED phase:**", '**Test doesn\'t pass in GREEN phase:**', 'tdd.md RED-phase subsection');
    assert.ok(redPhaseSubsection.includes("**Test doesn't fail in RED phase:**"),
      'the slice must start at the RED-phase heading');
    assert.ok(!redPhaseSubsection.includes('**Unrelated tests break:**'),
      'the slice must EXCLUDE the unrelated-tests subsection, whose fix-and-proceed guidance is ' +
      'correct. A later reflow that silently widens this slice must fail HERE, rather than ' +
      'quietly degrading the negative below into one that catches nothing. See #3770.');

    const regions = [
      { label: 'tdd.md RED-phase subsection', text: redPhaseSubsection },
      {
        label: 'tdd.md ### Fail-Fast Rules',
        text: region(TDD_SOURCE, '### Fail-Fast Rules', '### Executor Gate Validation', 'tdd.md fail-fast'),
      },
      {
        label: 'gsd-executor.md <tdd_execution>',
        text: region(EXECUTOR, '<tdd_execution>', '</tdd_execution>', 'executor tdd_execution'),
        consumer: true,
      },
      {
        label: 'execute-plan.md <tdd_plan_execution>',
        text: region(EXECUTE_PLAN, '<tdd_plan_execution>', '</tdd_plan_execution>', 'execute-plan tdd_plan_execution'),
        consumer: true,
      },
    ];

    for (const { label, text } of regions) {
      // POSITIVE anchor: deleting the section must not satisfy the negative.
      assert.match(text, /RED Contract|red_contract_spec|RED contract/,
        `${label} must CITE the RED Contract for the unexpected-pass case. Without this ` +
        'anchor the negative below is satisfied by deleting the section. See #3770.');
      // NEGATIVE, region-scoped.
      assert.ok(!/fix the test and continue|Fix before proceeding|Investigate and fix the test before proceeding|investigate test\/existing feature/.test(text),
        `${label} still instructs the executor to repair the test and CONTINUE on an ` +
        'unexpected pass. That is the exact retry loop the contract\'s `halt` verdict forbids: ' +
        'an executor that continues authorizes GREEN on a test that never failed ' +
        '(T-02-05-08). See #3770.');
    }

    for (const { label, text } of regions.filter((r) => r.consumer)) {
      assert.ok(text.includes('<red_contract>'),
        `${label} must name the literal <red_contract> element the executor reads. Both ` +
        'consuming surfaces are covered by their own row here, so neither is protected by a ' +
        'one-time acceptance grep. See #3770 (CR-05, CR-06).');
      // The halt VERDICT itself, anchored inside the sentence that names the
      // element, so softening `halt` to `continue` on either surface — or
      // letting the two drift apart — turns the suite red.
      assert.match(text, /<red_contract>[^.]*halts|halts[^.]*<red_contract>/,
        `${label} must state that a tdd="true" task carrying NO <red_contract> HALTS. ` +
        'Fail-closed, on the actor that actually hits the case. Asserting the element name ' +
        'alone would let `halt` soften to `continue` unnoticed. See #3770 (CR-05).');
    }

    const executorRegion = regions.find((r) => r.label.startsWith('gsd-executor')).text;
    // Scoped to the gate-sequence CHECKLIST, not the whole region: the RED step
    // above it also mentions the trailer, so a region-wide match passes while
    // item 1 still carries the pre-#3770 commit-existence rule — which is
    // exactly the surface CR-06 is about. Caught by mutation T9.
    const gateSeqStart = executorRegion.indexOf('**Gate sequence validation:**');
    assert.ok(gateSeqStart > -1, 'gsd-executor.md must carry the gate-sequence checklist');
    const gateItem1 = executorRegion.slice(gateSeqStart).split('\n').find((l) => l.trim().startsWith('1.'));
    assert.ok(gateItem1 && gateItem1.includes('red-evidence:'),
      'gsd-executor.md gate-sequence item 1 must require the `test(...)` commit to CARRY the ' +
      '`red-evidence:` trailer, not merely to exist. This is the inline checklist the executor ' +
      'follows without resolving any citation, so REDC-06 is unmet while it still carries the ' +
      'pre-#3770 rule (T-02-05-07). See #3770 (CR-06).');
    assert.match(executorRegion, /credential/i,
      'gsd-executor.md must carry the credential-redaction clause on the surface that actually ' +
      'WRITES the trailer. A git trailer lands in permanent published history and cannot be ' +
      'unpublished once pushed; reaching the obligation only through a citation that did not ' +
      'resolve is T-02-05-09. Positive presence assertion, so the executor-side obligation is ' +
      'guarded against deletion exactly as the tdd.md-side one already is. See #3770 (CR-10).');
  });

  test('the MVP+TDD gate reference does not claim a capability the contract disclaims', () => {
    const ref = fs.readFileSync(REF, 'utf-8');
    const start = ref.indexOf('## What the gate checks');
    assert.ok(start > -1, 'execute-mvp-tdd.md must carry ## What the gate checks');
    const rest = ref.indexOf('\n## ', start + 1);
    const checks = rest > -1 ? ref.slice(start, rest) : ref.slice(start);

    assert.ok(checks.includes('is not yet mechanised'),
      'the gate checks must say that judging the recorded run against the RED predicate is not '
      + 'yet mechanised. tdd.md says so in as many words and defers that judgment to the coded '
      + 'gate; an executor told otherwise reports a verdict it never computed. See #3770.');
    assert.ok(!checks.includes('satisfies the RED predicate'),
      'the gate checks must not claim the trailer\'s recorded run satisfies the RED predicate. '
      + 'The region is scoped to the checks so the escalation section below stays free to '
      + 'discuss the predicate. See #3770.');
    assert.ok(checks.includes('`~/.claude/gsd-core/references/tdd.md`'),
      'the rewritten check must keep the install-resolvable citation verbatim. Without this the '
      + 'capability claim could be dropped by deleting the whole line, taking one of the four '
      + 'RED-contract consumer references with it. See #3770.');

    const codeStart = ref.indexOf('Reason: {');
    assert.ok(codeStart > -1, 'the halt report must carry a `Reason: {...}` vocabulary line');
    assert.strictEqual(ref.indexOf('Reason: {', codeStart + 1), -1,
      'the halt report must carry exactly one reason-code vocabulary');
    const codeLine = ref.slice(codeStart, ref.indexOf('}', codeStart) + 1);
    for (const code of ['missing_red_commit', 'missing_red_evidence',
      'red_commit_not_failing', 'feat_before_test']) {
      assert.ok(codeLine.includes(code),
        `the reason vocabulary must offer \`${code}\`. tdd.md distinguishes three RED failures `
        + 'and the shipped vocabulary named two of them, leaving a matching commit whose '
        + 'red-evidence: value comes back empty with no word for what happened. The new code is '
        + 'an addition, so the three existing codes must survive it. See #3770.');
    }
  });

  test("the Commit Pattern's RED exemplar carries the Evidence trailer verbatim", () => {
    const blocks = fencedBlocks(sliceH2(TDD_SOURCE, 'Commit Pattern for TDD Plans'));
    assert.strictEqual(blocks.length, 1, '## Commit Pattern must carry one fenced block');
    assert.ok(blocks[0].split('\n').includes(trailerLine()),
      'the RED exemplar must reproduce the ### Evidence trailer line byte-for-byte. Strict ' +
      'equality against the single fixture is what stops the two exemplars drifting apart — ' +
      'a retyped or re-wrapped copy is exactly the drift. See #3770.');

    // The feature token comes from the fixture itself, never a literal: a future fixture
    // change that also updates the subjects still passes, one that updates only the
    // trailer fails.
    const line = trailerLine();
    const targetTest = JSON.parse(line.slice(line.indexOf(':') + 1)).target_test;
    const feature = targetTest.slice(targetTest.lastIndexOf('::') + 2)
      .replace(/^test_/, '').split('_')[0];
    assert.ok(feature.length > 2, 'the fixture target_test must yield a feature token');

    const subjects = blocks[0].split('\n')
      .filter((l) => /^(test|feat|refactor)\(/.test(l));
    assert.strictEqual(subjects.length, 3, 'the exemplar must carry three commit subjects');
    for (const subject of subjects) {
      assert.ok(subject.toLowerCase().includes(feature),
        `the exemplar subject "${subject}" must name the feature \`${feature}\` its own `
        + 'red-evidence: trailer records. An exemplar that pairs one feature\'s subject with '
        + "another feature's evidence teaches the reader that the two are unrelated, which is "
        + 'exactly the coupling the contract asserts. See #3770.');
    }
  });
});

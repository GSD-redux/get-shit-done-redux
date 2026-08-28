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
        section: 'RED Predicate',
        needle: 'no condition proving the target test exists',
        verdict: null,
        why: 'the arm-2 scoping rationale must name the compensating condition, which lives in '
          + 'execute-mvp-tdd.md, or the coded gate gets built with a real hole in it',
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
    assert.match(outsideInArm, /plan\.implementation_target/,
      'the outside-in arm must anchor the observed subject to the declared implementation target');
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

    for (const kind of ['test', 'feat', 'refactor']) {
      const anchored = `grep -m1 -E "^[0-9a-f]+ ${kind}\\(`;
      assert.ok(snippet.includes(anchored),
        `the ${kind}(...) search must be anchored to the commit subject via \`${anchored}\`. ` +
        'All three searches share the same defect, so all three carry the fix. See #3770.');
    }

    assert.match(snippet, /if \[ -z "\$RED_SHA" \]/,
      'the snippet must guard the empty RED_SHA. Unguarded, `git log -1 --format=… ""` exits ' +
      '128 with a fatal ambiguous-argument error — and that is the most likely gate trip of ' +
      'all. See #3770.');
    assert.ok(snippet.includes('missing_red_commit'),
      'no commit whose subject matches is a different outcome from a commit that exists ' +
      'without the trailer; the snippet must report it as `missing_red_commit`. See #3770.');
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

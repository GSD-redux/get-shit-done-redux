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

const { runNode, runGit, runHook } = require('./helpers/process-seam.cjs');
const { createTempDir, createTempGitProject, cleanup } = require('./helpers.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const TDD_REF = path.join(__dirname, '..', 'gsd-core', 'references', 'tdd.md');
const PLANNER = path.join(__dirname, '..', 'agents', 'gsd-planner.md');

// `gsd-core/bin/lib/red-evidence-predicate.cjs` does not exist while this
// commit is RED — a top-level `require` of it would abort module load and
// mask every other assertion in this file behind one `MODULE_NOT_FOUND`. The
// path is resolved here; the module itself is required lazily, inside the
// body of each test that needs it. See #3770 (D-24).
const RED_EVIDENCE_PREDICATE_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'red-evidence-predicate.cjs',
);

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

  test('### Evidence names exactly the eight trailer fields', () => {
    const line = trailerLine();
    const parsed = JSON.parse(line.slice(line.indexOf(':') + 1));
    assert.deepStrictEqual(
      Object.keys(parsed).sort(),
      ['actual', 'command', 'exit_status', 'expected', 'location', 'selected_count',
        'target_executed', 'target_test'],
      'the trailer must carry exactly the eight evidence fields — the exact-eight ' +
      'key set is itself the fail-closed mechanism: a foreign or future schema ' +
      'fails equality rather than being partially honoured. See #3770 (D-03).',
    );
    for (const side of ['expected', 'actual']) {
      assert.deepStrictEqual(
        Object.keys(parsed[side]).sort(),
        ['class_or_mode', 'phase', 'subject'],
        `${side} must hold exactly phase, class_or_mode and subject`,
      );
    }
    assert.deepStrictEqual(
      Object.keys(parsed.location).sort(),
      ['declared', 'observed'],
      '`location` must hold exactly declared and observed, named — not `expected`/`actual` — ' +
      'because both sides are executor-declared and executor-observed, never plan-declared. See #3770 (D-05).',
    );
    for (const side of ['declared', 'observed']) {
      assert.deepStrictEqual(
        Object.keys(parsed.location[side]).sort(),
        ['file', 'line'],
        `location.${side} must hold exactly file and line — no column. See #3770 (D-06).`,
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
        needle: 'does not prove the missing entity is the declared `implementation_target`',
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
      // The three residual-family rows. Each guards text that NOTHING COMPUTES:
      // row existence and row verdict are both computed by the Outcomes
      // agreement test above, which is why the seven pinned Outcomes rows were
      // dropped rather than extended. These three are prose and a clause.
      {
        section: 'RED Predicate',
        needle: 'What arm 1 proves and what it does not',
        verdict: null,
        why: 'arm 2 has carried a named residual since 02-04 and arm 1 has not, yet arm 1 admits '
          + 'the same class of unrelated failure: the predicate never consumes the plan\'s '
          + '<behavior>, so an unrelated assertion failing first in the declared test, at the '
          + 'declared phase with the declared class, produces a vector identical to the genuine '
          + 'one. Without the paragraph the contract silently claims a guarantee it does not '
          + 'provide, and Phase 3 builds a coded gate from that claim',
      },
      {
        section: 'Evidence',
        needle: 'a vector carrying additional keys is not this vector',
        verdict: null,
        why: 'the exact-seven-key equality is fail-closed BY DESIGN, which means the residuals '
          + 'above cannot be closed by adding a field at runtime. Without the sentence naming '
          + 'the extension path, the schema reads as having designed its own discriminator out, '
          + 'and Phase 3 inherits a contract it cannot extend without appearing to break it',
      },
      {
        section: 'Outcomes',
        needle: 'unless the declaration names that class itself',
        verdict: null,
        why: 'the unscoped clause asserts something FALSE for the one declaration that names '
          + '`SyntaxError` as its own `class_or_mode`: there the classes agree, this row\'s '
          + 'condition does not hold, and the outside-in row governs instead. The verdict and '
          + 'the row title are untouched — only the illustrative clause was over-general',
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

  // ── THE SHIPPED PREDICATE, EVALUATED RATHER THAN PINNED ──────────────────
  // Everything above this line proves the fence CONTAINS certain text. None of
  // it proves what the fence DECIDES. That gap is #3770: a conjunct can be
  // present, correctly spelled and correctly indented while the contract it
  // composes authorizes a run it must block. The block below reads the shipped
  // fence as STRUCTURED INPUT to an evaluator and asserts the VERDICT it
  // computes for a table of evidence vectors, so deleting `AND target_executed`
  // stops being a broken string match and becomes `target-not-executed`
  // flipping from `block` to `authorize` — which is the defect, stated as the
  // defect. See #3770.

  /**
   * The `### RED Predicate` fence, split into its shared conjuncts and its two
   * arms BY POSITION — the group opener, the `OR`, the closer — which is the
   * reading rule the section itself ships two lines above the fence: `AND`
   * binds tighter than `OR`, so the parenthesised group is exactly two arms.
   * Indentation is never consulted; it is presentation, and position is the
   * grammar.
   *
   * Every structural expectation THROWS with the observed count rather than
   * degrading to a permissive parse. A reader that silently treated every atom
   * as shared, or every atom as arm 1, would compute a verdict for every vector
   * below and agree with the table by accident — a green suite proving nothing.
   * See #3770 (T-02-06-01).
   */
  function parsePredicateFence() {
    const lines = soleFencedBlock(CONTRACT, 'RED Predicate')
      .split('\n').map((line) => line.trim()).filter(Boolean);

    assert.strictEqual(lines[0], 'valid_red =',
      `the RED Predicate block must open with its \`valid_red =\` header. Observed: `
      + `"${lines[0]}". Without the assignment the block is an expression fragment, and every `
      + 'arm below is read from an offset that has shifted by one. See #3770.');

    const indicesWhere = (match) => lines
      .map((line, i) => (match(line) ? i : -1)).filter((i) => i !== -1);
    const openers = indicesWhere((line) => line.endsWith('('));
    const disjunctions = indicesWhere((line) => line === 'OR');
    const closers = indicesWhere((line) => line === ')');

    assert.strictEqual(openers.length, 1,
      `the predicate must open exactly one parenthesised group; found ${openers.length}. `
      + 'The two-arm reading this evaluator implements is not defined for any other shape, so '
      + 'it refuses to guess rather than falling back to a permissive parse. See #3770.');
    assert.strictEqual(disjunctions.length, 1,
      `the parenthesised group must carry exactly one \`OR\`; found ${disjunctions.length}. `
      + 'See #3770.');
    assert.strictEqual(closers.length, 1,
      `the parenthesised group must be closed exactly once; found ${closers.length}. `
      + 'See #3770.');
    assert.ok(openers[0] < disjunctions[0] && disjunctions[0] < closers[0],
      `the group must open (line ${openers[0] + 1}), disjoin (line ${disjunctions[0] + 1}) and `
      + `close (line ${closers[0] + 1}) in that order. See #3770.`);

    const atom = (line) => line.replace(/^AND /, '');
    return {
      shared: lines.slice(1, openers[0]).map(atom),
      arm1: lines.slice(openers[0] + 1, disjunctions[0]).map(atom),
      arm2: lines.slice(disjunctions[0] + 1, closers[0]).map(atom),
    };
  }

  /** `id_matches`, exactly as the `### Evidence` blockquote at tdd.md:187-190 defines it. */
  function idMatches(observed, declared) {
    if (observed === declared) return true;
    return observed.startsWith(declared) && observed.slice(declared.length).startsWith('[');
  }

  /** `expected_failure` structural equality over the three fields the schema declares. */
  const sameTriple = (a, b) => a.phase === b.phase
    && a.class_or_mode === b.class_or_mode
    && a.subject === b.subject;

  /**
   * `location` equality: file compared by basename only, line compared strictly.
   * `path.win32.basename` per D-08 — it normalizes BOTH `/` and `\` separators,
   * so a POSIX-reported path and a Windows-reported path for the same file
   * still compare equal; `path.posix.basename` would leave a `\`-separated
   * path's basename as the whole string.
   */
  const sameLocation = (a, b) =>
    path.win32.basename(a.file) === path.win32.basename(b.file) && a.line === b.line;

  /**
   * The set of `plan`/`trailer` top-level field names whose value differs
   * between two vector objects, computed structurally (never hardcoded).
   * Used to prove a residual literal and its legitimate twin differ on
   * `location` and nothing else (D-31).
   */
  const differingTopLevelKeys = (a, b) => {
    const keys = new Set();
    for (const section of ['plan', 'trailer']) {
      const allKeys = new Set([...Object.keys(a[section]), ...Object.keys(b[section])]);
      for (const key of allKeys) {
        if (JSON.stringify(a[section][key]) !== JSON.stringify(b[section][key])) keys.add(key);
      }
    }
    return [...keys].sort();
  };

  /**
   * One evaluator per DISTINCT atom, keyed by the atom's text exactly as the
   * fence carries it with a leading `AND ` stripped. TEN keys for fifteen
   * statement lines: `valid_red =`, `AND (`, `OR` and `)` are structure, and
   * `id_matches(actual.subject, plan.target_test)` occupies one line in each
   * arm as a single atom.
   *
   * A key that no longer appears in the fence, or a fence atom with no key
   * here, is caught by the set equality in its OWN test below. Separating that
   * test from the verdict test is deliberate: node:test stops a test at its
   * first failed assertion, so a set equality sharing a test with the case loop
   * would mask every named case flip behind "the atom set drifted" — the same
   * masking the byte-freeze gave, and the reason it was a poor control. Split,
   * a deleted conjunct reports BOTH the drift and the case it flips.
   * See #3770 (T-02-06-02).
   */
  const PREDICATE_ATOMS = new Map([
    ['exit_status != 0', (v) => v.trailer.exit_status !== 0],
    ['trailer.expected == plan.expected_failure',
      (v) => sameTriple(v.trailer.expected, v.plan.expected_failure)],
    ['actual.phase == expected.phase',
      (v) => v.trailer.actual.phase === v.trailer.expected.phase],
    ['actual.class_or_mode == expected.class_or_mode',
      (v) => v.trailer.actual.class_or_mode === v.trailer.expected.class_or_mode],
    ['trailer.target_test == plan.target_test',
      (v) => v.trailer.target_test === v.plan.target_test],
    ['location.observed == location.declared',
      (v) => sameLocation(v.trailer.location.observed, v.trailer.location.declared)],
    ['selected_count > 0', (v) => v.trailer.selected_count > 0],
    ['target_executed', (v) => v.trailer.target_executed === true],
    ['id_matches(actual.subject, plan.target_test)',
      (v) => idMatches(v.trailer.actual.subject, v.plan.target_test)],
    ['plan.expected_failure is an outside-in missing-target mode',
      (v) => v.plan.expected_failure.subject === v.plan.implementation_target],
  ]);

  /**
   * The verdict the SHIPPED fence produces for one evidence vector, with the
   * atoms that failed, so a disagreement names the conjunct that decided it.
   *
   * Atoms are evaluated EAGERLY, never through a short-circuiting `every`: an
   * unresolvable atom must always reach its `throw`. A `Map.get` miss that
   * short-circuited past the lookup, or that defaulted to `true`, would turn
   * every future paraphrase of this fence into a silent authorization — the
   * exact failure #3770 documents. The throw is the fail-closed FLOOR; the set
   * equality above it is the readable report that names both halves of the
   * drift. See #3770 (T-02-06-02).
   */
  function evaluateFence(parsed, vector) {
    const truths = (atoms) => atoms.map((text) => {
      const evaluator = PREDICATE_ATOMS.get(text);
      if (!evaluator) {
        throw new Error(
          `the RED Predicate carries an atom with no evaluator: "${text}". An unresolved atom `
          + 'is never treated as satisfied — a permissive default would convert a reworded '
          + 'conjunct into an authorization. Add the evaluator, or revert the reword. See #3770.');
      }
      return [text, evaluator(vector)];
    });
    const shared = truths(parsed.shared);
    const arm1 = truths(parsed.arm1);
    const arm2 = truths(parsed.arm2);
    const holds = (pairs) => pairs.every(([, ok]) => ok);
    return {
      verdict: holds(shared) && (holds(arm1) || holds(arm2)) ? 'authorize' : 'block',
      failed: [...shared, ...arm1, ...arm2].filter(([, ok]) => !ok).map(([text]) => text),
    };
  }

  /**
   * An evidence vector in the shape `### Evidence` ships — the seven trailer
   * keys plus the plan's `<red_contract>` declaration — with the genuine
   * target-behavior failure as its base and one field overridden per case, so
   * each blocking case blocks for exactly ONE reason and deleting the conjunct
   * that decides it FLIPS the verdict.
   *
   * The six cases that participate in a residual identity pair do NOT use this
   * factory: they are written out as full literals below, twice, on purpose.
   */
  function vector({ plan = {}, trailer = {} }) {
    return {
      plan: {
        target_test: 'tests/test_pricing.py::test_discount_reduces_total',
        implementation_target: 'pricing.apply_discount',
        expected_failure: {
          phase: 'call',
          class_or_mode: 'AssertionError',
          subject: 'tests/test_pricing.py::test_discount_reduces_total',
        },
        ...plan,
      },
      trailer: {
        command: 'pytest tests/test_pricing.py::test_discount_reduces_total -q',
        exit_status: 1,
        target_test: 'tests/test_pricing.py::test_discount_reduces_total',
        selected_count: 1,
        target_executed: true,
        expected: {
          phase: 'call',
          class_or_mode: 'AssertionError',
          subject: 'tests/test_pricing.py::test_discount_reduces_total',
        },
        actual: {
          phase: 'call',
          class_or_mode: 'AssertionError',
          subject: 'tests/test_pricing.py::test_discount_reduces_total',
        },
        location: {
          declared: { file: 'tests/test_pricing.py', line: 8 },
          observed: { file: 'tests/test_pricing.py', line: 8 },
        },
        ...trailer,
      },
    };
  }

  /**
   * A minimal `tdd="true"` behavior-adding task body carrying one `<red_contract>`
   * built from a vector's `plan` fields, for the module-vs-fence differential
   * test and the fail-closed-floor assertions below. `redContractCount` lets a
   * test deliberately produce zero or two blocks to exercise the cardinality
   * guard (D-24).
   */
  function buildTaskContent(plan, { redContractCount = 1 } = {}) {
    const block = `<red_contract>
  <target_test>${plan.target_test}</target_test>
  <implementation_target>${plan.implementation_target}</implementation_target>
  <expected_failure>
    <phase>${plan.expected_failure.phase}</phase>
    <class_or_mode>${plan.expected_failure.class_or_mode}</class_or_mode>
    <subject>${plan.expected_failure.subject}</subject>
  </expected_failure>
</red_contract>`;
    return `<task tdd="true">
  <behavior>Applies a discount and asserts the resulting total.</behavior>
  <files>src/pricing.py</files>
${Array(redContractCount).fill(block).join('\n')}
</task>`;
  }

  // ── THE THREE RESIDUAL PAIRS ─────────────────────────────────────────────
  // Each pair below is TWO SEPARATELY WRITTEN OBJECT LITERALS with identical
  // fields: a legitimate case, and an illegitimate one the contract cannot
  // tell apart from it. They are deliberately NOT a shared constant, a spread
  // copy or one reference asserted against itself — `deepStrictEqual(x, x)`
  // asserts nothing, and the whole point of these pairs is that adding ONE
  // field to the residual literal is a real one-line mutation that turns the
  // pair red. Phase 3 cannot add a working discriminator and leave them green.
  // Do not compress them. See #3770 (F-1, BL-1).

  const GENUINE = {
    plan: {
      target_test: 'tests/test_pricing.py::test_discount_reduces_total',
      implementation_target: 'pricing.apply_discount',
      expected_failure: {
        phase: 'call',
        class_or_mode: 'AssertionError',
        subject: 'tests/test_pricing.py::test_discount_reduces_total',
      },
    },
    trailer: {
      command: 'pytest tests/test_pricing.py::test_discount_reduces_total -q',
      exit_status: 1,
      target_test: 'tests/test_pricing.py::test_discount_reduces_total',
      selected_count: 1,
      target_executed: true,
      expected: {
        phase: 'call',
        class_or_mode: 'AssertionError',
        subject: 'tests/test_pricing.py::test_discount_reduces_total',
      },
      actual: {
        phase: 'call',
        class_or_mode: 'AssertionError',
        subject: 'tests/test_pricing.py::test_discount_reduces_total',
      },
      location: {
        declared: { file: 'tests/test_pricing.py', line: 8 },
        observed: { file: '/srv/build/tests/test_pricing.py', line: 8 },
      },
    },
  };

  const UNRELATED_ASSERTION_IN_TARGET_TEST = {
    plan: {
      target_test: 'tests/test_pricing.py::test_discount_reduces_total',
      implementation_target: 'pricing.apply_discount',
      expected_failure: {
        phase: 'call',
        class_or_mode: 'AssertionError',
        subject: 'tests/test_pricing.py::test_discount_reduces_total',
      },
    },
    trailer: {
      command: 'pytest tests/test_pricing.py::test_discount_reduces_total -q',
      exit_status: 1,
      target_test: 'tests/test_pricing.py::test_discount_reduces_total',
      selected_count: 1,
      target_executed: true,
      expected: {
        phase: 'call',
        class_or_mode: 'AssertionError',
        subject: 'tests/test_pricing.py::test_discount_reduces_total',
      },
      actual: {
        phase: 'call',
        class_or_mode: 'AssertionError',
        subject: 'tests/test_pricing.py::test_discount_reduces_total',
      },
      location: {
        declared: { file: 'tests/test_pricing.py', line: 12 },
        observed: { file: 'tests/test_pricing.py', line: 8 },
      },
    },
  };

  const OUTSIDE_IN = {
    plan: {
      target_test: 'tests/test_pricing.py',
      implementation_target: 'pricing.apply_discount',
      expected_failure: {
        phase: 'collection',
        class_or_mode: 'ImportError',
        subject: 'pricing.apply_discount',
      },
    },
    trailer: {
      command: 'pytest tests/test_pricing.py -q',
      exit_status: 2,
      target_test: 'tests/test_pricing.py',
      selected_count: 0,
      target_executed: false,
      expected: {
        phase: 'collection',
        class_or_mode: 'ImportError',
        subject: 'pricing.apply_discount',
      },
      actual: {
        phase: 'collection',
        class_or_mode: 'ImportError',
        subject: 'tests/test_pricing.py',
      },
      location: {
        declared: { file: 'test_oi.py', line: 3 },
        observed: { file: 'test_oi.py', line: 3 },
      },
    },
  };

  const UNRELATED_MISSING_DEP_IN_TARGET_FILE = {
    plan: {
      target_test: 'tests/test_pricing.py',
      implementation_target: 'pricing.apply_discount',
      expected_failure: {
        phase: 'collection',
        class_or_mode: 'ImportError',
        subject: 'pricing.apply_discount',
      },
    },
    trailer: {
      command: 'pytest tests/test_pricing.py -q',
      exit_status: 2,
      target_test: 'tests/test_pricing.py',
      selected_count: 0,
      target_executed: false,
      expected: {
        phase: 'collection',
        class_or_mode: 'ImportError',
        subject: 'pricing.apply_discount',
      },
      actual: {
        phase: 'collection',
        class_or_mode: 'ImportError',
        subject: 'tests/test_pricing.py',
      },
      location: {
        declared: { file: 'test_oi.py', line: 3 },
        observed: { file: 'test_oi.py', line: 2 },
      },
    },
  };

  const FIXTURE_IS_THE_BEHAVIOR = {
    plan: {
      target_test: 'tests/test_pricing.py::test_discount_reduces_total',
      implementation_target: 'pricing.apply_discount',
      expected_failure: {
        phase: 'setup',
        class_or_mode: 'RuntimeError',
        subject: 'tests/test_pricing.py::test_discount_reduces_total',
      },
    },
    trailer: {
      command: 'pytest tests/test_pricing.py::test_discount_reduces_total -q',
      exit_status: 1,
      target_test: 'tests/test_pricing.py::test_discount_reduces_total',
      selected_count: 1,
      target_executed: true,
      expected: {
        phase: 'setup',
        class_or_mode: 'RuntimeError',
        subject: 'tests/test_pricing.py::test_discount_reduces_total',
      },
      actual: {
        phase: 'setup',
        class_or_mode: 'RuntimeError',
        subject: 'tests/test_pricing.py::test_discount_reduces_total',
      },
      location: {
        declared: { file: 'test_pricing.py', line: 5 },
        observed: { file: 'test_pricing.py', line: 5 },
      },
    },
  };

  const UNRELATED_FIXTURE_CRASH = {
    plan: {
      target_test: 'tests/test_pricing.py::test_discount_reduces_total',
      implementation_target: 'pricing.apply_discount',
      expected_failure: {
        phase: 'setup',
        class_or_mode: 'RuntimeError',
        subject: 'tests/test_pricing.py::test_discount_reduces_total',
      },
    },
    trailer: {
      command: 'pytest tests/test_pricing.py::test_discount_reduces_total -q',
      exit_status: 1,
      target_test: 'tests/test_pricing.py::test_discount_reduces_total',
      selected_count: 1,
      target_executed: true,
      expected: {
        phase: 'setup',
        class_or_mode: 'RuntimeError',
        subject: 'tests/test_pricing.py::test_discount_reduces_total',
      },
      actual: {
        phase: 'setup',
        class_or_mode: 'RuntimeError',
        subject: 'tests/test_pricing.py::test_discount_reduces_total',
      },
      location: {
        declared: { file: 'test_pricing.py', line: 5 },
        observed: { file: 'conftest.py', line: 5 },
      },
    },
  };

  /**
   * Fifteen evidence vectors with HARDCODED verdicts. Nine isolate one conjunct
   * each, so deleting that conjunct flips exactly this case; three are the
   * authorizing cases the contract exists to admit; three are the residuals it
   * admits and should not.
   *
   * `outcome_row` names the `### Outcomes` row this case IS, or null where the
   * table has no row for it. Where it is non-null the row's shipped verdict is
   * COMPARED against the verdict computed here, so the table can no longer
   * drift from the predicate the way the outside-in row did.
   */
  const EVIDENCE_VECTORS = [
    {
      id: 'exit-zero',
      outcome_row: null,
      verdict: 'block',
      why: 'isolates `exit_status != 0`. Every other conjunct holds, so deleting the first '
        + 'shared conjunct authorizes a PASSING run — the halt rule at the foot of the section '
        + 'is what catches it afterwards, and the predicate must still refuse it. This is the '
        + 'unexpected-pass case: it short-circuits at `exit_status != 0` and never reaches the '
        + '`location` conjunct, so the vector\'s default `location` pair (D-28) proves nothing '
        + 'here — it exists only to satisfy key-set equality.',
      vector: vector({ trailer: { exit_status: 0 } }),
    },
    {
      id: 'trailer-expected-not-pinned',
      outcome_row: null,
      verdict: 'block',
      why: 'isolates `trailer.expected == plan.expected_failure`. The trailer is internally '
        + 'consistent — `actual` agrees with the trailer\'s own `expected` — so the two '
        + 'field comparisons below it both hold and only the pin fails. Without the pin a '
        + 'mis-copied trailer approves itself by agreeing with its own echo.',
      vector: vector({
        trailer: {
          expected: {
            phase: 'call',
            class_or_mode: 'TypeError',
            subject: 'tests/test_pricing.py::test_discount_reduces_total',
          },
          actual: {
            phase: 'call',
            class_or_mode: 'TypeError',
            subject: 'tests/test_pricing.py::test_discount_reduces_total',
          },
        },
      }),
    },
    {
      id: 'fixture-crash',
      outcome_row: 'Fixture or setup crashed before the target assertion',
      verdict: 'block',
      why: 'isolates `actual.phase == expected.phase`. The declared behavior was a call-phase '
        + 'assertion; the run died in setup, so nothing was proved about the target behavior.',
      vector: vector({
        trailer: {
          actual: {
            phase: 'setup',
            class_or_mode: 'AssertionError',
            subject: 'tests/test_pricing.py::test_discount_reduces_total',
          },
        },
      }),
    },
    {
      id: 'collect-parse-error',
      outcome_row: 'Suite failed to collect or parse',
      verdict: 'block',
      why: 'isolates `actual.class_or_mode == expected.class_or_mode`. The phase is held equal '
        + 'deliberately so the class comparison alone decides: a case that blocked for two '
        + 'reasons would survive deleting either one, and would prove neither.',
      vector: vector({
        trailer: {
          actual: {
            phase: 'call',
            class_or_mode: 'SyntaxError',
            subject: 'tests/test_pricing.py::test_discount_reduces_total',
          },
        },
      }),
    },
    {
      id: 'target-test-not-pinned',
      outcome_row: null,
      verdict: 'block',
      why: 'isolates `trailer.target_test == plan.target_test`. The trailer names a shorter id '
        + 'than the plan declared while `actual.subject` still carries the full one, so every '
        + '`id_matches` conjunct holds and only the pin fails. This is the second half of the '
        + 'pinning pair: an executor that widened its own target id would otherwise pass.',
      vector: vector({
        trailer: { target_test: 'tests/test_pricing.py::test_discount' },
      }),
    },
    {
      id: 'zero-tests-selected',
      outcome_row: 'Zero tests selected',
      verdict: 'block',
      why: "isolates arm 2's outside-in mode conjunct. pytest reports `not found:` against the "
        + 'requested node id, so arm 2\'s `id_matches` holds; the declaration is not an '
        + 'outside-in one, so the mode conjunct alone stops the arm. Delete it and a run that '
        + 'selected NO tests authorizes GREEN.',
      vector: vector({
        plan: {
          expected_failure: {
            phase: 'collection',
            class_or_mode: 'UsageError',
            subject: 'tests/test_pricing.py::test_discount_reduces_total',
          },
        },
        trailer: {
          exit_status: 4,
          selected_count: 0,
          target_executed: false,
          expected: {
            phase: 'collection',
            class_or_mode: 'UsageError',
            subject: 'tests/test_pricing.py::test_discount_reduces_total',
          },
          actual: {
            phase: 'collection',
            class_or_mode: 'UsageError',
            subject: 'tests/test_pricing.py::test_discount_reduces_total',
          },
        },
      }),
    },
    {
      id: 'target-not-executed',
      outcome_row: null,
      verdict: 'block',
      why: 'isolates `AND target_executed`. One test was selected and the error was attributed '
        + 'to its node id, but the session aborted before any test result was reported, so no '
        + "member of the run's executed-and-reported set matches the declared target. This is "
        + "the case `target_executed`'s definition exists for, and the conjunct is the only "
        + 'thing blocking it.',
      vector: vector({
        plan: {
          expected_failure: {
            phase: 'setup',
            class_or_mode: 'RuntimeError',
            subject: 'tests/test_pricing.py::test_discount_reduces_total',
          },
        },
        trailer: {
          target_executed: false,
          expected: {
            phase: 'setup',
            class_or_mode: 'RuntimeError',
            subject: 'tests/test_pricing.py::test_discount_reduces_total',
          },
          actual: {
            phase: 'setup',
            class_or_mode: 'RuntimeError',
            subject: 'tests/test_pricing.py::test_discount_reduces_total',
          },
        },
      }),
    },
    {
      id: 'different-test-failed',
      outcome_row: 'A different test failed',
      verdict: 'block',
      why: "isolates the target-test arm's `id_matches` anchor. Two tests ran, the declared "
        + 'target among them and passing, and a DIFFERENT test failed at the declared phase '
        + "with the declared class. This IS #3770's original defect: without the anchor the "
        + 'arm reduces to selection plus execution, which this run satisfies.',
      vector: vector({
        trailer: {
          selected_count: 2,
          actual: {
            phase: 'call',
            class_or_mode: 'AssertionError',
            subject: 'tests/test_pricing.py::test_tax_is_applied',
          },
        },
      }),
    },
    {
      id: 'outside-in-wrong-file',
      outcome_row: null,
      verdict: 'block',
      why: "isolates arm 2's `id_matches` anchor. A legitimate outside-in declaration, but the "
        + 'collection failure was reported against a DIFFERENT test file. Delete the anchor and '
        + 'arm 2 reduces to the declared mode alone — a declaration, not evidence, authorizing '
        + 'itself.',
      vector: vector({
        plan: {
          target_test: 'tests/test_pricing.py',
          expected_failure: {
            phase: 'collection',
            class_or_mode: 'ImportError',
            subject: 'pricing.apply_discount',
          },
        },
        trailer: {
          command: 'pytest tests/test_pricing.py -q',
          exit_status: 2,
          target_test: 'tests/test_pricing.py',
          selected_count: 0,
          target_executed: false,
          expected: {
            phase: 'collection',
            class_or_mode: 'ImportError',
            subject: 'pricing.apply_discount',
          },
          actual: {
            phase: 'collection',
            class_or_mode: 'ImportError',
            subject: 'tests/test_checkout.py',
          },
        },
      }),
    },
    {
      id: 'genuine',
      outcome_row: 'Genuine target-behavior failure',
      verdict: 'authorize',
      why: 'the one outcome the whole contract exists to admit: the declared test was selected, '
        + 'executed, and failed at the declared phase with the declared class.',
      vector: GENUINE,
    },
    {
      id: 'outside-in',
      outcome_row: 'Outside-in: the declared implementation target is missing',
      verdict: 'authorize',
      why: 'the legitimate outside-in RED. It reports 0 selected and false executed BY '
        + 'CONSTRUCTION, which is why those two conjuncts are scoped to arm 1: hoisted above '
        + 'the group they block exactly the case arm 2 exists to admit, and this vector is what '
        + 'turns that hoist red.',
      vector: OUTSIDE_IN,
    },
    {
      id: 'fixture-is-the-behavior',
      outcome_row: 'Fixture is itself the behavior under test',
      verdict: 'authorize',
      why: 'a setup-phase failure is legitimate RED when the fixture IS the declared behavior — '
        + 'the declared and observed phases agree, so the phase comparison never fires.',
      vector: FIXTURE_IS_THE_BEHAVIOR,
    },
    {
      id: 'unrelated-assertion-in-target-test',
      outcome_row: 'Unrelated assertion in the target test',
      verdict: 'block',
      why: 'field-identical to `genuine` on every OTHER field — the assertion that failed is not '
        + "the one the plan's <behavior> describes, an unrelated assertion earlier in the same "
        + 'test body, at the same phase with the same class. `location` is what tells the two '
        + "apart: the declared line is the plan's assertion (12), the observed line is where the "
        + 'run actually failed (8), so `location.observed == location.declared` fails and the '
        + 'predicate blocks it.',
      vector: UNRELATED_ASSERTION_IN_TARGET_TEST,
    },
    {
      id: 'unrelated-missing-dep-in-target-file',
      outcome_row: 'Unrelated missing dependency in the target test file',
      verdict: 'block',
      why: 'field-identical to `outside-in` on every OTHER field — the import that failed is an '
        + 'unrelated third-party dependency, not the declared `implementation_target`. `location` '
        + "is what tells the two apart: the declared import line (3) is the plan's, the observed "
        + 'line (2) is a different import in the same file, so `location.observed == '
        + 'location.declared` fails and the predicate blocks it.',
      vector: UNRELATED_MISSING_DEP_IN_TARGET_FILE,
    },
    {
      id: 'unrelated-fixture-crash',
      outcome_row: 'Unrelated fixture crash at the declared fixture phase',
      verdict: 'block',
      why: 'field-identical to `fixture-is-the-behavior` on every OTHER field — the fixture that '
        + 'crashed is an unrelated one, not the fixture the plan declared as the behavior under '
        + 'test. `location` is what tells the two apart: same line (5) but a DIFFERENT file '
        + '(`conftest.py` vs the declared `test_pricing.py`), so basename comparison fails '
        + '`location.observed == location.declared` and the predicate blocks it.',
      vector: UNRELATED_FIXTURE_CRASH,
    },
    {
      id: 'outside-in-build-phase',
      outcome_row: 'Outside-in: the declared implementation target is missing',
      verdict: 'authorize',
      why: 'a second legitimate outside-in RED, reached in an ecosystem with no collection '
        + 'phase at all: a compiled-language link failure (REGR-04). `selected_count` is 0 and '
        + '`target_executed` is false BY CONSTRUCTION here too, exactly as in `outside-in`, but '
        + 'the location conjunct sits ABOVE the disjunction without acquiring arm 1\'s selection '
        + 'and execution conditions when the outside-in arm is the one that holds — this vector '
        + 'proves that for a phase and class distinct from `outside-in`\'s Python ones, so the '
        + 'shared row cannot be an artifact of one ecosystem\'s vocabulary.',
      vector: vector({
        plan: {
          target_test: 'oi.cpp',
          implementation_target: 'apply_discount(int, double)',
          expected_failure: {
            phase: 'build',
            class_or_mode: 'undefined reference',
            subject: 'apply_discount(int, double)',
          },
        },
        trailer: {
          command: 'g++ -g -o oi oi.cpp -lgtest -lgtest_main -pthread',
          exit_status: 1,
          target_test: 'oi.cpp',
          selected_count: 0,
          target_executed: false,
          expected: {
            phase: 'build',
            class_or_mode: 'undefined reference',
            subject: 'apply_discount(int, double)',
          },
          actual: {
            phase: 'build',
            class_or_mode: 'undefined reference',
            subject: 'oi.cpp',
          },
          location: {
            declared: { file: 'oi.cpp', line: 4 },
            observed: { file: '/srv/build/oi.cpp', line: 4 },
          },
        },
      }),
    },
    {
      id: 'same-basename-different-directory',
      outcome_row: null,
      verdict: 'authorize',
      why: '`path.win32.basename` reduces `tests/unit/test_pricing.py` and '
        + '`tests/integration/test_pricing.py` to the same name, the lines agree, so the vector '
        + 'passes; this is the same-basename, same-line collision the contract already names as '
        + 'the narrowed residual, and the control that would close it is the anti-backfill '
        + 'verification recorded in CONTEXT.md\'s Deferred Ideas. Deliberately NOT a '
        + 'legitimate-RED case and NOT in the frozen five (REGR-04) — it documents a known gap '
        + 'in the discriminator, it does not certify one. Do not "fix" this row by changing the '
        + 'comparison: `normObs.endsWith(\'/\' + normDec) || normDec.endsWith(\'/\' + normObs)` '
        + '— proposed in review — is a strict NARROWING of basename equality that would BLOCK '
        + '`outside-in` and `fixture-is-the-behavior`, manufacturing the exact REGR-04 '
        + 'regression this plan exists to prevent.',
      vector: vector({
        trailer: {
          location: {
            declared: { file: 'tests/unit/test_pricing.py', line: 8 },
            observed: { file: 'tests/integration/test_pricing.py', line: 8 },
          },
        },
      }),
    },
  ];

  test('the five legitimate-RED cases are frozen by id and split by fence-verdict domain '
    + '(REGR-04)', () => {
    const LEGITIMATE_CASE_IDS = [
      'genuine',
      'exit-zero',
      'outside-in',
      'outside-in-build-phase',
      'fixture-is-the-behavior',
    ];
    assert.strictEqual(LEGITIMATE_CASE_IDS.length, 5,
      'REGR-04 names exactly five legitimate-RED cases; a shorter or longer frozen list '
      + 'silently drops or invents one. See #3770.');

    const byId = new Map(EVIDENCE_VECTORS.map((c) => [c.id, c]));
    for (const id of LEGITIMATE_CASE_IDS) {
      assert.ok(byId.has(id),
        `the frozen legitimate-RED case "${id}" is missing from the case table. See #3770.`);
    }

    for (const id of LEGITIMATE_CASE_IDS) {
      const testCase = byId.get(id);
      if (id === 'exit-zero') {
        assert.strictEqual(testCase.verdict, 'block',
          'the `exit-zero` (unexpected-pass) case must declare the fence\'s only other value, '
          + '`block` — `evaluateFence` is two-valued and carries no `halt` token, so `block` is '
          + 'the only value a zero-exit-status vector can carry in this domain. Its halt '
          + 'MEANING is asserted at the module level against `unexpected_pass` elsewhere, not '
          + 'restated here.');
      } else {
        assert.strictEqual(testCase.verdict, 'authorize',
          `REDC-05: the legitimate-RED case "${id}" must declare fence verdict \`authorize\`. `
          + 'A block here is a REGR-04 over-strictness regression: the remedy is correcting the '
          + 'vector data against the probe transcript, never widening the location comparison.');
      }
    }
  });

  test('the RED Predicate fence composes exactly the atoms this evaluator evaluates', () => {
    const parsed = parsePredicateFence();

    // Its OWN test, not a first assertion inside the verdict test below. A
    // REWORDED or ADDED conjunct reports here as what it is — naming the
    // unknown text and any orphaned key — while a DELETED conjunct reports
    // here AND flips its named case in the next test, because neither can
    // mask the other. See #3770.
    assert.deepStrictEqual(
      [...new Set([...parsed.shared, ...parsed.arm1, ...parsed.arm2])].sort(),
      [...PREDICATE_ATOMS.keys()].sort(),
      'the RED Predicate fence carries an atom this evaluator cannot evaluate, or this '
      + 'evaluator carries a key the fence no longer contains. Either is a semantic change to '
      + 'the shipped contract: a reworded conjunct is a NEW conjunct as far as anything reading '
      + 'the fence is concerned, and the four successive paraphrases that each silently dropped '
      + 'one are why this equality exists. Update the fence and this map together, and say in '
      + 'the plan which atom moved and why. See #3770.');

    // The set equality above passes when a conjunct is deleted from BOTH the
    // fence and this map. The hardcoded count is what does not.
    assert.strictEqual(PREDICATE_ATOMS.size, 10,
      `the predicate must compose exactly ten distinct atoms; this map carries `
      + `${PREDICATE_ATOMS.size}. Deleting a conjunct from the fence AND its evaluator here `
      + 'satisfies the set equality above and would otherwise pass unnoticed. See #3770.');
  });

  test('the five shared conjuncts are evaluated above the arms, not inside one', () => {
    // RETAINED-UNSUBSUMED. This is the one surviving fragment of the 02-05
    // shared-conjunct test, kept on evidence and not on argument: with it
    // removed, all four "move a shared conjunct inside the parenthesised group"
    // mutations left the suite GREEN, while every other assertion that test
    // carried — presence, and a conjunct commented back out with a leading
    // `# ` — was killed by the atom-set equality or by a named case flip.
    //
    // A move preserves the atom SET, so the equality above cannot see it, and
    // no evidence vector can either: catching it needs a run that takes ARM 2
    // while violating a shared conjunct, and the shared conjuncts are what make
    // such a run impossible to construct honestly. The partition is therefore
    // asserted directly. A shared conjunct inside arm 1 stops guarding arm 2 —
    // an outside-in RED would no longer have its trailer pinned to the plan at
    // all. The indentation assertion that sat beside this one is NOT retained:
    // the reader splits by position, so depth is presentation now, and no
    // semantic mutation kills it. See #3770.
    const parsed = parsePredicateFence();
    for (const conjunct of [
      'trailer.expected == plan.expected_failure',
      'actual.phase == expected.phase',
      'actual.class_or_mode == expected.class_or_mode',
      'trailer.target_test == plan.target_test',
      'location.observed == location.declared',
    ]) {
      assert.ok(parsed.shared.includes(conjunct),
        `the shared conjunct \`${conjunct}\` is not evaluated above the parenthesised group. `
        + `The predicate's shared conjuncts are [${parsed.shared.join(', ')}]. All five are `
        + 'unconditional: two pin the trailer\'s `expected` and `target_test` echoes to the plan '
        + 'declaration, one binds the observed failure site to the declared one, and the '
        + 'remaining two only carry meaning once that pinning holds. Pushed into an arm, a '
        + 'shared conjunct stops guarding the arm it is not in — scoped into arm 1, '
        + '`location.observed == location.declared` would stop guarding arm 2 and reopen the '
        + 'unrelated-missing-dependency residual (D-11). See #3770.');
    }
  });

  test('the shipped predicate computes the verdict each evidence vector must receive', () => {
    const parsed = parsePredicateFence();

    for (const testCase of EVIDENCE_VECTORS) {
      const { verdict, failed } = evaluateFence(parsed, testCase.vector);
      assert.strictEqual(verdict, testCase.verdict,
        `the shipped RED Predicate ${verdict}s the \`${testCase.id}\` evidence vector; the `
        + `contract requires it to ${testCase.verdict}. ${testCase.why} `
        + `Conjuncts that failed: ${failed.length ? failed.join(' | ') : '(none)'}. `
        + 'This assertion evaluates the fence rather than matching its text, so it fails when '
        + 'the contract\'s MEANING changes and not only when its wording does. See #3770.');
    }
  });

  test('every Outcomes row verdict agrees with what the shipped predicate computes', () => {
    const parsed = parsePredicateFence();
    const outcomes = sliceH3(CONTRACT, 'Outcomes').split('\n');

    for (const testCase of EVIDENCE_VECTORS) {
      if (testCase.outcome_row === null) continue;
      const hits = outcomes.filter((line) => line.includes(testCase.outcome_row));
      assert.strictEqual(hits.length, 1,
        `### Outcomes must carry exactly one row containing "${testCase.outcome_row}", the row `
        + `the \`${testCase.id}\` evidence vector IS. Found ${hits.length}. A deleted row is a `
        + 'deleted requirement, and a row title that CONTAINS another row title breaks the '
        + 'shadowed row\'s lookup rather than its own. See #3770.');

      const { verdict } = evaluateFence(parsed, testCase.vector);
      assert.ok(hits[0].trim().endsWith(`| ${verdict} |`),
        `the "${testCase.outcome_row}" row must carry the verdict the predicate actually `
        + `computes for it, which is \`${verdict}\`. Observed row: ${hits[0].trim()}. The row `
        + 'verdict is COMPUTED here, not pinned as text, so the table cannot drift from the '
        + 'predicate the way the outside-in row did. See #3770 (F-4).');
    }
  });

  test('the residual evidence vectors differ from the cases they shadow only on location', () => {
    // Each pair is two separately written literals, so this is a real
    // constraint and not `assert.notDeepStrictEqual(x, x)`. The discriminator
    // has landed: `location` now tells each residual apart from the
    // legitimate case it shadows, and it must be the ONLY top-level field the
    // pair differs on — merging the two literals into one shared object
    // remains forbidden, since a reference asserted against itself proves
    // nothing. See #3770 (D-31).
    const shadows = 'the discriminator is `location`: the two vectors must differ, and the set '
      + 'of top-level fields on which they differ, computed structurally, must be exactly '
      + '`[\'location\']`. If it fails because the two literals were merged into one shared '
      + 'object, revert that. See #3770 (D-31).';

    for (const [residual, twin, label] of [
      [UNRELATED_ASSERTION_IN_TARGET_TEST, GENUINE,
        "arm 1's residual: an unrelated assertion in the target test"],
      [UNRELATED_MISSING_DEP_IN_TARGET_FILE, OUTSIDE_IN,
        "arm 2's residual: an unrelated missing dependency in the target test file"],
      [UNRELATED_FIXTURE_CRASH, FIXTURE_IS_THE_BEHAVIOR,
        "arm 1's residual at the fixture phase: an unrelated fixture crash"],
    ]) {
      assert.notDeepStrictEqual(residual, twin, `${label}. ${shadows}`);
      assert.deepStrictEqual(differingTopLevelKeys(residual, twin), ['location'],
        `${label}. ${shadows}`);
    }
  });

  test('evaluateFence and the built module compute the same authorize/block verdict for '
    + 'every evidence vector', () => {
    // `gsd-core/bin/lib/red-evidence-predicate.cjs` does not exist while this
    // commit is RED, so the require is inside the test body, never at file
    // scope (D-24). See #3770 (D-22).
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);
    const parsed = parsePredicateFence();

    for (const testCase of EVIDENCE_VECTORS) {
      const { verdict: fenceVerdict } = evaluateFence(parsed, testCase.vector);
      const taskContent = buildTaskContent(testCase.vector.plan);
      const trailerText = `red-evidence: ${JSON.stringify(testCase.vector.trailer)}`;
      const { verdict: moduleVerdict } = evaluateRedEvidence(taskContent, trailerText);

      // The fence is two-valued (`authorize`/`block`); the module is
      // three-valued (`authorize`/`unexpected_pass`/`red_commit_not_failing`),
      // so token equality is the wrong comparison here — the `exit-zero`
      // vector computes `block` on the fence side and `unexpected_pass` on
      // the module side, and every other blocking vector collides the same
      // way. Normalize both to a boolean and assert the three-token
      // distinction separately, per token, below.
      assert.strictEqual(moduleVerdict === 'authorize', fenceVerdict === 'authorize',
        `evidence vector \`${testCase.id}\`: the fence computes \`${fenceVerdict}\` and the `
        + `module computes \`${moduleVerdict}\`; normalized to authorize/not-authorize they `
        + 'must agree. See #3770 (D-22).');
    }

    const zeroExit = EVIDENCE_VECTORS.find((c) => c.id === 'exit-zero');
    const { verdict: zeroExitVerdict } = evaluateRedEvidence(
      buildTaskContent(zeroExit.vector.plan),
      `red-evidence: ${JSON.stringify(zeroExit.vector.trailer)}`,
    );
    assert.strictEqual(zeroExitVerdict, 'unexpected_pass',
      'a zero-exit-status trailer must report `unexpected_pass`, not `red_commit_not_failing` '
      + 'or `block` — the run passed, so nothing failed to evaluate. See #3770 (D-22).');
  });

  test('the built module fails closed on a malformed trailer or a malformed red-contract '
    + 'declaration', () => {
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);
    const validTask = buildTaskContent(GENUINE.plan);
    const validTrailerText = `red-evidence: ${JSON.stringify(GENUINE.trailer)}`;
    const { location, ...sevenKeyTrailer } = GENUINE.trailer;
    void location;

    for (const [label, taskContent, trailerText] of [
      ['an empty-string trailer', validTask, ''],
      ['a non-JSON trailer', validTask, 'red-evidence: not json'],
      ['a seven-key trailer missing `location`', validTask,
        `red-evidence: ${JSON.stringify(sevenKeyTrailer)}`],
      ['a behavior-adding task with no `<red_contract>` block',
        validTask.replace(/<red_contract>[\s\S]*?<\/red_contract>\n?/, ''), validTrailerText],
      ['a behavior-adding task with a duplicated `<red_contract>` block',
        buildTaskContent(GENUINE.plan, { redContractCount: 2 }), validTrailerText],
    ]) {
      const { verdict, reason } = evaluateRedEvidence(taskContent, trailerText);
      assert.strictEqual(verdict, 'red_commit_not_failing',
        `${label} must fail closed to \`red_commit_not_failing\`, never \`authorize\` and `
        + 'never a thrown exception. See #3770 (GATE-01).');
      assert.ok(typeof reason === 'string' && reason.trim().length > 0,
        `${label} must carry a non-empty \`reason\` explaining the fail-closed verdict. `
        + 'See #3770.');
    }
  });

  /**
   * One row per shape obligation on `location`, so the next one costs one record here
   * rather than one new test — same rationale as the load-bearing-line table above.
   * `mutate` receives a deep clone of the shipped `### Evidence` exemplar (parsed through
   * `trailerLine()`, never retyped) and returns the trailer under test, so these cases track
   * the contract automatically and cannot drift from it. See #3770.
   */
  const LOCATION_SHAPE_CASES = [
    { name: '`location` absent from an otherwise valid eight-key trailer',
      mutate: (t) => { delete t.location; return t; }, expected: 'red_commit_not_failing' },
    { name: '`location` present but `declared` absent',
      mutate: (t) => { delete t.location.declared; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`location` present but `observed` absent',
      mutate: (t) => { delete t.location.observed; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`location.observed.file` an empty string',
      mutate: (t) => { t.location.observed.file = ''; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`location.observed.file` `null`',
      mutate: (t) => { t.location.observed.file = null; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`location.observed.file` absent',
      mutate: (t) => { delete t.location.observed.file; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`location.observed.line` absent',
      mutate: (t) => { delete t.location.observed.line; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`location.observed.line` a string ("4") rather than a number',
      mutate: (t) => { t.location.observed.line = '4'; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`location.observed.line` `null`',
      mutate: (t) => { t.location.observed.line = null; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`location.declared` carrying an extra sub-key beyond `file` and `line`',
      mutate: (t) => { t.location.declared.column = 3; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`location.observed` carrying an extra sub-key beyond `file` and `line`',
      mutate: (t) => { t.location.observed.column = 3; return t; },
      expected: 'red_commit_not_failing' },
    { name: 'a ninth top-level key added to an otherwise valid vector',
      mutate: (t) => { t.extra_field = 'unexpected'; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`location.declared.file` and `location.observed.file` BOTH the empty string, '
        + 'lines equal, every key present — the one case key-set equality cannot catch, since '
        + '`path.win32.basename(\'\')` is `\'\'` and the two empty sides compare equal',
      mutate: (t) => {
        t.location.declared.file = '';
        t.location.observed.file = '';
        return t;
      },
      expected: 'red_commit_not_failing' },
    { name: '`declared.line` 8 against `observed.line` 9',
      mutate: (t) => { t.location.observed.line = 9; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`declared.file` `Pricing.test.js` against `observed.file` `pricing.test.js` — '
        + 'basenames that differ in case are different basenames, no case folding',
      mutate: (t) => {
        t.location.declared.file = 'Pricing.test.js';
        t.location.observed.file = 'pricing.test.js';
        return t;
      },
      expected: 'red_commit_not_failing' },
    { name: '`declared.line` 8 against `observed.line` `"8"` as a string',
      mutate: (t) => { t.location.observed.line = '8'; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`declared.file` `tests/pricing.test.js` against `observed.file` '
        + '`/srv/build/tests/pricing.test.js` — a separator split only, no other difference',
      mutate: (t) => {
        t.location.declared.file = 'tests/pricing.test.js';
        t.location.observed.file = '/srv/build/tests/pricing.test.js';
        return t;
      },
      expected: 'authorize' },
    { name: '`declared.file` `tests/pricing.test.js` against `observed.file` '
        + '`C:\\srv\\build\\tests\\pricing.test.js`',
      mutate: (t) => {
        t.location.declared.file = 'tests/pricing.test.js';
        t.location.observed.file = 'C:\\srv\\build\\tests\\pricing.test.js';
        return t;
      },
      expected: 'authorize' },
    { name: '`declared.file` and `observed.file` both bare `pricing.test.js`',
      mutate: (t) => {
        t.location.declared.file = 'pricing.test.js';
        t.location.observed.file = 'pricing.test.js';
        return t;
      },
      expected: 'authorize' },
  ];

  test('shape-check edges: empty, absent and malformed `location` values fail closed; '
    + 'path-form differences alone still authorize (#3770)', () => {
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);
    const exemplarLine = trailerLine();
    const shippedTrailer = JSON.parse(exemplarLine.slice(exemplarLine.indexOf('{')));
    const validTask = buildTaskContent(GENUINE.plan);

    for (const { name, mutate, expected } of LOCATION_SHAPE_CASES) {
      const trailer = mutate(structuredClone(shippedTrailer));
      const { verdict, reason } = evaluateRedEvidence(
        validTask, `red-evidence: ${JSON.stringify(trailer)}`,
      );
      assert.strictEqual(verdict, expected,
        `${name}: expected \`${expected}\`, got \`${verdict}\` (reason: ${reason}). See #3770.`);
      if (expected === 'red_commit_not_failing') {
        assert.ok(typeof reason === 'string' && reason.trim().length > 0,
          `${name} must carry a non-empty \`reason\` naming which check rejected the vector. `
          + 'See #3770.');
      }
    }
  });

  test('a task file carrying two <red_contract> blocks fails closed with a reason naming the '
    + 'ambiguity, even with an otherwise valid trailer (#3770)', () => {
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);
    const exemplarLine = trailerLine();
    const shippedTrailer = JSON.parse(exemplarLine.slice(exemplarLine.indexOf('{')));
    const dualContractTask = buildTaskContent(GENUINE.plan, { redContractCount: 2 });

    const { verdict, reason } = evaluateRedEvidence(
      dualContractTask, `red-evidence: ${JSON.stringify(shippedTrailer)}`,
    );
    assert.strictEqual(verdict, 'red_commit_not_failing',
      'a task file carrying two <red_contract> blocks — two `tdd="true"` tasks in one '
      + 'plan-level file — must fail closed even with an otherwise valid trailer: the '
      + 'ambiguous declaration is what is wrong, not the trailer. This pins the guard that '
      + 'binds the evaluator to the gated task when TASK_FILE resolves to a multi-task plan '
      + 'file. See #3770.');
    assert.match(reason, /contract|ambigu/i,
      `the reason must name the multi-contract ambiguity, got: "${reason}". See #3770.`);
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
    // Pinned IN FULL, through the closing `\):` — not as a prefix. CR-11 M1 is
    // narrowing this needle to a bare `test\(`, which selects a cross-plan
    // decoy; a prefix-only pin cannot see that. Killed by execution in the
    // five-scenario test above; this literal is the guard that still fires on a
    // lane where bash or git is unavailable and that test is skipped.
    assert.ok(snippet.includes(`grep -m1 -E "^[0-9a-f]+\${TAB}[^\${TAB}]+\${TAB}test\\(\${PHASE}-\${PLAN}\\):"`),
      'the RED search must select the newest candidate that is BOTH anchored to this plan\'s ' +
      'commit subject AND carries a non-empty red-evidence: trailer field. Selecting on ' +
      'position alone (CR-04) lets a newer trailerless same-plan commit shadow the real RED; ' +
      'dropping the plan scope (CR-11 M1) lets an unrelated plan\'s RED authorize this ' +
      'plan\'s GREEN. See #3770.');

    // Pinned INDEPENDENTLY of the subject needle above: `%s`, `%B` and
    // `%(trailers:…)` are three different git format operations, so an
    // assertion about the subject field says nothing about the trailer field.
    // `separator=%x20` is inside the pin because it is BEHAVIOUR, not
    // formatting — without it git appends a newline after the value, each
    // record splits across two lines, and the whole single-pass selection
    // breaks. This is CR-11 M4's literal guard, for the skipped-fixture lane.
    assert.ok(snippet.includes('%H%x09%(trailers:key=red-evidence,valueonly,separator=%x20)%x09%s'),
      'the RED record must read the red-evidence TRAILER, in full, with its explicit ' +
      'separator. Reading `%B` instead reintroduces the body-match class the subject anchor ' +
      'was added to close — a commit that merely QUOTES a red-evidence: line would be read as ' +
      'evidence — and its embedded newlines also destroy the record shape. See #3770 (CR-11 M4).');

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

    // ── S1, compliant COMPLETED plan (CR-03) ─────────────────────────────
    // A completed `type: tdd` plan carries both gates. This block runs at
    // completion and nowhere else — `gsd-core/references/tdd.md:453` scopes it
    // that way and `agents/gsd-executor.md:416` is its one consumer, invoking
    // it "after completing the plan" — so RED alone is not the compliant
    // state, it is the mid-cycle state that no shipped consumer gates.
    const s1 = newRepo();
    commit(s1, 'tests/test_pricing.py', 'test(08-02): add failing test for discount', evidence('S1'));
    commit(s1, 'src/pricing.py', 'feat(08-02): implement discount');
    const r1 = runGate(s1);
    assert.strictEqual(r1.exitCode, 0,
      'CR-03: the shipped gate must exit 0 on a compliant completed plan. Both required gates ' +
      'are present and the optional REFACTOR one is not, which is not a violation. See #3770.');
    assert.ok(r1.stdout.includes('# S1'),
      'the gate must emit the RED commit\'s trailer value');
    assert.ok(!r1.stdout.includes('add failing test for discount'),
      'the gate must emit the TRAILER, never a commit subject');
    assert.ok(!r1.stdout.includes('no feat(08-02)'),
      'GREEN is GATED, not reported: with a feat(08-02) commit present there is nothing to ' +
      'report about it. `### Gate Definitions:442` marks GREEN `Required | Yes`, and this ' +
      'scenario is the non-vacuity control on S6 — deleting the feat(08-02) commit above must ' +
      'turn S1 red. See #3770 (F-3).');

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

    // ── S6, completed plan with no GREEN commit (F-3) ────────────────────
    // A fully compliant RED — evidence-bearing, plan-scoped, touching a test
    // file — and no `feat(08-02)` commit at all.
    const s6 = newRepo();
    commit(s6, 'tests/test_pricing.py', 'test(08-02): add failing test for discount', evidence('S6'));
    const r6 = runGate(s6);
    assert.notStrictEqual(r6.exitCode, 0,
      'F-3: `### Gate Definitions:442` marks GREEN `Required | Yes`, and this block runs only ' +
      'after a `type: tdd` plan COMPLETES — tdd.md:453 says so, and agents/gsd-executor.md:416, ' +
      'its one consumer, invokes it there. A completed plan with no GREEN commit is therefore a ' +
      'gate violation, and the shipped snippet exits 0 on it — contradicting its own table on ' +
      'the strength of a mid-cycle run that no shipped consumer performs. See #3770 (F-3).');
    assert.match(r6.stdout, /feat\(08-02\)/,
      'the failure must NAME the missing GREEN commit by the subject pattern the executor has ' +
      'to produce, not merely return a non-zero status. See #3770 (F-3).');
    assert.ok(r6.stdout.includes('# S6'),
      'the RED half of the gate must still pass and still emit its trailer: S6 must fail on ' +
      'GREEN alone, so a regression in RED selection cannot hide behind this scenario');
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

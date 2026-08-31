// docs-guard-exempt: 'docs/notes.md' is a synthetic fixture path written into a scratch repo's task.md for the G6 doc-only-exemption scenario, never a real repo doc read from disk.
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

  test('the halt-reason enum lists exactly the five tokens the three producers emit', () => {
    const refContent = fs.readFileSync(REF, 'utf-8');
    const reasonLineMatch = refContent.match(/Reason:\s{0,5}\{([^}]{1,300})\}/);
    assert.ok(reasonLineMatch, 'execute-mvp-tdd.md must carry a `Reason: {...}` vocabulary line');
    const shippedTokens = reasonLineMatch[1].split('|').map((t) => t.trim()).sort();
    const frozenFive = [
      'missing_red_commit', 'missing_red_evidence', 'red_commit_not_failing',
      'unexpected_pass', 'feat_before_test',
    ].sort();
    assert.deepStrictEqual(shippedTokens, frozenFive,
      'the Reason: enum must list exactly these five tokens, no more and no fewer. ' +
      'Fails today: the shipped enum lists four, missing `unexpected_pass`. See #3770.');

    // The five tokens have three producers, and no single site emits all of them —
    // asserting all five against one source would find two and misreport the set
    // as over- or under-wide.
    const gateSnippet = extractGateSnippet(fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'), 'utf8',
    ));
    // Bash-owned: literals the gate block itself echoes.
    assert.ok(gateSnippet.includes('missing_red_commit'),
      'missing_red_commit is bash-owned and must appear as a literal in the gate block');
    assert.ok(gateSnippet.includes('missing_red_evidence'),
      'missing_red_evidence is bash-owned and must appear as a literal in the gate block');

    // Module-owned (D-14): taken from evaluateRedEvidence's own verdict domain, not
    // scraped from the gate — the gate only ever echoes `${RED_VERDICT}`, a shell
    // expansion, so grepping the snippet for these two would find nothing there.
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);
    const taskContent = CONTRACT_TASK_LINES.join('\n');
    const mismatched = (() => {
      const parsed = JSON.parse(trailerLine().slice(trailerLine().indexOf('{')));
      parsed.location.observed.line += 1;
      return `red-evidence: ${JSON.stringify(parsed)}`;
    })();
    const unexpectedPass = (() => {
      const parsed = JSON.parse(trailerLine().slice(trailerLine().indexOf('{')));
      parsed.exit_status = 0;
      return `red-evidence: ${JSON.stringify(parsed)}`;
    })();
    assert.strictEqual(evaluateRedEvidence(taskContent, mismatched).verdict, 'red_commit_not_failing',
      'red_commit_not_failing is module-owned; this fixture must produce it');
    assert.strictEqual(evaluateRedEvidence(taskContent, unexpectedPass).verdict, 'unexpected_pass',
      'unexpected_pass is module-owned; this fixture must produce it');

    // feat_before_test is emitted by the executor's own sequencing check ("no
    // feat({phase}-{plan}) commit before the failing-test commit"), not by this
    // gate at all — it has no extractable source here, only its presence above.
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
// `executePhaseSrc` above (line ~135) is block-scoped inside the folded
// #3097/#3099 describe block and is not visible here — re-read it under its
// own name rather than reach across the block boundary.
const EXECUTE_PHASE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'), 'utf8',
);

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

/**
 * The MVP+TDD gate's fenced bash block in `execute-phase.md`: the sentence
 * that introduces it through the end of the fenced block that immediately
 * follows. Asserts exactly one such block is found — a silent zero-or-two
 * match would make every gate scenario vacuous (#3770 Phase 3).
 */
function extractGateSnippet(source) {
  const markerIdx = source.indexOf('**MVP+TDD gate.**');
  assert.notStrictEqual(markerIdx, -1,
    'the **MVP+TDD gate.** prose marker was not found in execute-phase.md');
  const endIdx = source.indexOf('</step>', markerIdx);
  assert.notStrictEqual(endIdx, -1, 'no </step> closes the MVP+TDD gate section');
  const blocks = fencedBlocks(source.slice(markerIdx, endIdx));
  assert.strictEqual(blocks.length, 1,
    'the MVP+TDD gate section must carry exactly one fenced bash block');
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

  test('### Evidence names exactly the six trailer fields', () => {
    const line = trailerLine();
    const parsed = JSON.parse(line.slice(line.indexOf(':') + 1));
    assert.deepStrictEqual(
      Object.keys(parsed).sort(),
      ['actual', 'command', 'exit_status', 'expected', 'location', 'target_test'],
      'the trailer must carry exactly the six evidence fields — the exact-six ' +
      'key set is itself the fail-closed mechanism: a foreign or future schema ' +
      'fails equality rather than being partially honoured. See #3770 (D-03, SIMP-01).',
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
        needle: 'still binds nothing about its content to `target_test`',
        verdict: null,
        why: 'the predicate now validates `command` for non-emptiness (GATE-06), but a reader '
          + 'who believes it is validated AGAINST `target_test` will build a coded gate that '
          + 'claims a binding the predicate does not make',
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
        why: 'the outside-in-residual scoping rationale must name the compensating condition, '
          + 'which lives in execute-mvp-tdd.md, or the coded gate gets built with a real hole in it',
      },
      {
        section: 'RED Predicate',
        needle: 'does not prove the missing entity is the declared `implementation_target`',
        verdict: null,
        why: 'the outside-in residual proves the failure belongs to the declared TEST FILE, not '
          + 'that it concerns the declared implementation target — an unrelated missing dependency in that same '
          + 'file, at the same declared phase and class, satisfies every conjunct. Deleting the '
          + 'note would leave the contract silently claiming a guarantee it does not provide, '
          + 'and Phase 3 would build a coded gate from that claim',
      },
      {
        section: 'Declaration',
        needle: 'offers no single test id to select — and record `expected_failure.subject`, '
          + '`target_test` and the observed `actual.subject`',
        verdict: null,
        why: 'the subject-equality conjunct requires an exact match, and go reports a '
          + 'compile-time miss against `./pricing_test.go:6:12` while the declaration says '
          + '`./pricing_test.go` — those strings are not equal, so unless the rule binds the '
          + 'OBSERVED `actual.subject` too, the conjunct is false and a legitimate go outside-in '
          + 'RED is rejected by the contract that exists to admit it. The needle spans the '
          + 'junction between the granularity half and the recording half on purpose: one '
          + 'sentence carrying two ideas can be half-deleted',
      },
      {
        section: 'Declaration',
        needle: 'Recorded for audit only: the predicate reads no field of it',
        verdict: null,
        why: '`implementation_target` has no predicate role; a reader who believes the predicate '
          + 'compares it will re-derive the unsatisfiable outside-in conjunct this plan removed',
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
          + 'thing left that selects the outside-in residual, and it selects from declared '
          + 'fields alone before any run',
      },
      // The two residual-family rows. Each guards text that NOTHING COMPUTES:
      // row existence and row verdict are both computed by the Outcomes
      // agreement test above, which is why the seven pinned Outcomes rows were
      // dropped rather than extended. These two are prose and a clause.
      {
        section: 'RED Predicate',
        needle: 'What the target-test residual admits and what it does not',
        verdict: null,
        why: 'the outside-in residual has carried a named residual since 02-04 and the '
          + 'target-test residual has not, yet the target-test residual admits '
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

  // ── THE SHIPPED MODULE, EVALUATED RATHER THAN PINNED ──────────────────────
  // Everything above this line proves the fence CONTAINS certain text. None of
  // it proves what the BUILT module DECIDES. That gap is #3770: a conjunct can
  // be present, correctly spelled and correctly indented while the contract it
  // composes authorizes a run it must block. The block below calls the
  // shipped `evaluateRedEvidence` directly — never a second, test-local
  // reimplementation of the predicate — and asserts the VERDICT it computes
  // for a table of evidence vectors, so deleting
  // `AND actual.subject == plan.target_test` from the module stops
  // being a broken string match and becomes `different-test-failed` flipping
  // from `red_commit_not_failing` to `authorize` — which is the defect,
  // stated as the defect. See #3770 (D-5).

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
   * An evidence vector in the shape `### Evidence` ships — the six trailer
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
   * Sixteen evidence vectors with HARDCODED verdicts. Eight isolate one conjunct
   * each, so deleting that conjunct flips exactly this case; five are the
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
      outcome_row: 'Unexpected pass',
      verdict: 'unexpected_pass',
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
      verdict: 'red_commit_not_failing',
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
      verdict: 'red_commit_not_failing',
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
      verdict: 'red_commit_not_failing',
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
      verdict: 'red_commit_not_failing',
      why: 'isolates `trailer.target_test == plan.target_test`. The trailer names a shorter id '
        + 'than the plan declared while `actual.subject` still carries the full one, so the '
        + '`actual.subject == plan.target_test` conjunct still holds and only the pin fails. '
        + 'This is the second half of the pinning pair: an executor that widened its own '
        + 'target id would otherwise pass.',
      vector: vector({
        trailer: { target_test: 'tests/test_pricing.py::test_discount' },
      }),
    },
    {
      id: 'zero-tests-selected',
      outcome_row: 'Zero tests selected',
      verdict: 'red_commit_not_failing',
      why: 'isolates `actual.phase == expected.phase`. The planner declared a call-phase failure '
        + 'of the target behavior; the run never got that far and reported at collection '
        + 'instead. The class is held equal deliberately — the same isolation device '
        + '`collect-parse-error` uses in the mirror direction — so the phase comparison alone '
        + 'decides it. This reaches the same conjunct `fixture-crash` reaches, from a second '
        + 'reporter scenario: zero-test discovery, not a setup crash. That is not duplication; '
        + 'the requirement is that the outcome be decided, not that it be decided by a conjunct '
        + 'nothing else uses.',
      vector: vector({
        trailer: {
          exit_status: 4,
          actual: {
            phase: 'collection',
            class_or_mode: 'AssertionError',
            subject: 'tests/test_pricing.py::test_discount_reduces_total',
          },
        },
      }),
    },
    {
      id: 'different-test-failed',
      outcome_row: 'A different test failed',
      verdict: 'red_commit_not_failing',
      why: "isolates the subject-equality anchor. Two tests ran, the declared "
        + 'target among them and passing, and a DIFFERENT test failed at the declared phase '
        + "with the declared class. This IS #3770's original defect: without the anchor the "
        + 'predicate reduces to selection plus execution, which this run satisfies.',
      vector: vector({
        trailer: {
          actual: {
            phase: 'call',
            class_or_mode: 'AssertionError',
            subject: 'tests/test_pricing.py::test_tax_is_applied',
          },
        },
      }),
    },
    {
      id: 'parametrized-variant-subject',
      outcome_row: null,
      verdict: 'red_commit_not_failing',
      why: "isolates the subject-equality conjunct under D-2's exact-equality requirement. "
        + "The plan names "
        + '`test_discount_reduces_total`; the run failed a PARAMETRIZED VARIANT of it, '
        + '`test_discount_reduces_total[case_3]` — a behavior the plan never named. The '
        + 'prefix-plus-bracket branch this plan deletes would have authorized this as '
        + 'evidence for the named behavior; exact equality does not. See #3770 (D-2).',
      vector: vector({
        trailer: {
          actual: {
            phase: 'call',
            class_or_mode: 'AssertionError',
            subject: 'tests/test_pricing.py::test_discount_reduces_total[case_3]',
          },
        },
      }),
    },
    {
      id: 'outside-in-wrong-file',
      outcome_row: null,
      verdict: 'red_commit_not_failing',
      why: "isolates the outside-in subject-equality anchor. A legitimate outside-in declaration, but the "
        + 'collection failure was reported against a DIFFERENT test file. Delete the anchor and '
        + 'the predicate reduces to the declared mode alone — a declaration, not evidence, authorizing '
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
      why: 'the one outcome the whole contract exists to admit: the trailer\'s `actual` triple '
        + 'and `location` agree with the plan\'s declaration and with each other, at the '
        + 'declared phase and class. The predicate does not independently prove the test was '
        + 'collected or executed — see `target-not-executed-fields-agree`.',
      vector: GENUINE,
    },
    {
      id: 'target-not-executed-fields-agree',
      outcome_row: null,
      verdict: 'authorize',
      why: 'the boundary SIMP-01 accepted, pinned so it cannot drift silently. Before the '
        + 'six-key contract, `selected_count > 0` and `target_executed === true` were separate '
        + 'conjuncts, and a trailer reporting a target that never ran was rejected on them. '
        + 'Those fields are gone, so that trailer is now BYTE-IDENTICAL to `genuine` — there is '
        + 'no field left to express the difference in — and it therefore authorizes. This is '
        + 'accepted, not overlooked: both fields were executor-authored inside the same '
        + 'self-reported record, so neither was independent evidence of execution. The vector '
        + 'reuses GENUINE deliberately: that identity IS the claim. If a future change '
        + 'reintroduces an execution conjunct, this vector stops computing `authorize` and '
        + 'fails here, forcing the contract to be updated with it. See #3770 (SIMP-01, CR-01).',
      vector: GENUINE,
    },
    {
      id: 'outside-in',
      outcome_row: 'Outside-in: the declared implementation target is missing',
      verdict: 'authorize',
      why: 'the legitimate outside-in RED: the collection failure is reported against the '
        + 'declared test FILE itself, so `actual.subject == plan.target_test` holds '
        + 'even though no test inside that file ever ran, and this vector is what proves the '
        + 'predicate must admit it.',
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
      verdict: 'red_commit_not_failing',
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
      verdict: 'red_commit_not_failing',
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
      verdict: 'red_commit_not_failing',
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
        + 'phase at all: a compiled-language link failure (REGR-04), exactly as in `outside-in` '
        + 'but for a phase and class distinct from its Python ones. The `location` conjunct '
        + 'holds here without depending on any Python-specific vocabulary, so it cannot be an '
        + 'artifact of one ecosystem\'s phase/class naming.',
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

  test('the five legitimate-RED cases are frozen by id and split by verdict domain '
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
        assert.strictEqual(testCase.verdict, 'unexpected_pass',
          'the `exit-zero` case must declare the module\'s dedicated halt token, '
          + '`unexpected_pass`: the run passed, so nothing failed to evaluate. See #3770.');
      } else {
        assert.strictEqual(testCase.verdict, 'authorize',
          `REDC-05: the legitimate-RED case "${id}" must declare verdict \`authorize\`. `
          + 'A block here is a REGR-04 over-strictness regression: the remedy is correcting the '
          + 'vector data against the probe transcript, never widening the location comparison.');
      }
    }
  });

  test('the RED Predicate fence is derived from what the shipped module actually decides '
    + '(D-5, D-6)', () => {
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);

    // A vector engineered to fail all six post-exit-status conjuncts at once,
    // never used in EVIDENCE_VECTORS (each named scenario there isolates
    // exactly one). Its only job is to drive `failed` to the module's full
    // six-entry order, so the fence can be reconstructed FROM the module's
    // own output instead of re-derived by a second parser over the module's
    // source text — the "no second parser" constraint D-5 sets. See #3770.
    const ALL_CONJUNCTS_FAIL = vector({
      trailer: {
        target_test: 'tests/test_pricing.py::test_totally_unrelated',
        expected: {
          phase: 'setup',
          class_or_mode: 'TypeError',
          subject: 'tests/test_pricing.py::test_totally_unrelated',
        },
        actual: {
          phase: 'call',
          class_or_mode: 'AssertionError',
          subject: 'tests/test_other.py::test_unrelated_behavior',
        },
        location: {
          declared: { file: 'tests/test_pricing.py', line: 8 },
          observed: { file: 'tests/test_other.py', line: 99 },
        },
      },
    });

    const taskContent = buildTaskContent(ALL_CONJUNCTS_FAIL.plan);
    const trailerText = `red-evidence: ${JSON.stringify(ALL_CONJUNCTS_FAIL.trailer)}`;
    const { verdict, failed } = evaluateRedEvidence(taskContent, trailerText);

    assert.strictEqual(verdict, 'red_commit_not_failing',
      'the all-conjuncts-fail vector must still pass every shape gate and reach the checks '
      + 'array, or this test proves nothing about the six post-exit-status conjuncts. See #3770.');

    // Six failed conjuncts, not seven: the fence carries seven statement
    // lines, but `exit_status != 0` is enforced by the module as an early
    // return (D-5's correction), never as a `checks` array entry — so the
    // module's `checks` array composes six. A vector that also drove
    // `exit_status` to 0 would report `unexpected_pass` and never reach
    // `checks` at all.
    assert.strictEqual(failed.length, 6,
      'the module\'s checks array composes exactly six conjuncts (the fence\'s seven lines '
      + `minus the exit_status early return); this vector failed ${failed.length}. `
      + 'See #3770 (D-5).');

    const derivedFence = [
      'valid_red =',
      '  exit_status != 0',
      ...failed.map((conjunct) => `  AND ${conjunct}`),
    ].join('\n');

    assert.strictEqual(soleFencedBlock(CONTRACT, 'RED Predicate').trim(), derivedFence,
      'the ### RED Predicate fence must read back exactly as the shipped module\'s `checks` '
      + 'array order and text compose it, with the exit_status early return restored as the '
      + 'fence\'s first line. This derives the fence from the module\'s OWN verdict rather than '
      + 're-parsing the module\'s source text a second time — the fence and the module cannot '
      + 'drift apart, because one is read directly from the other\'s output. See #3770 (D-5, D-6).');
  });

  test('the shipped module computes the verdict each evidence vector must receive', () => {
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);

    for (const testCase of EVIDENCE_VECTORS) {
      const taskContent = buildTaskContent(testCase.vector.plan);
      const trailerText = `red-evidence: ${JSON.stringify(testCase.vector.trailer)}`;
      const { verdict, failed } = evaluateRedEvidence(taskContent, trailerText);
      assert.strictEqual(verdict, testCase.verdict,
        `the shipped module computes \`${verdict}\` for the \`${testCase.id}\` evidence `
        + `vector; the contract requires \`${testCase.verdict}\`. ${testCase.why} `
        + `Conjuncts that failed: ${failed && failed.length ? failed.join(' | ') : '(none)'}. `
        + 'This assertion evaluates the BUILT module rather than matching fence text, so it '
        + 'fails when the contract\'s MEANING changes and not only when its wording does. '
        + 'See #3770.');
    }
  });

  test('a failing subject-equality check is reported once, from one conjunction with no arms', () => {
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);
    for (const id of ['different-test-failed', 'parametrized-variant-subject']) {
      const vectorCase = EVIDENCE_VECTORS.find((c) => c.id === id);
      const taskContent = buildTaskContent(vectorCase.vector.plan);
      const trailerText = `red-evidence: ${JSON.stringify(vectorCase.vector.trailer)}`;
      const { failed } = evaluateRedEvidence(taskContent, trailerText);

      assert.deepStrictEqual(failed, ['actual.subject == plan.target_test'],
        `the predicate is a single conjunction: for the \`${id}\` vector, the subject-equality `
        + 'check must appear at most once in any failure report, never once per disjunction '
        + 'branch — an exact-equality assertion is what catches a duplicated or spurious extra '
        + 'entry; a length or `includes` check would not. See #3770 (SIMP-02).');
    }
  });

  test('every Outcomes row verdict agrees with what the shipped module computes', () => {
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);
    const outcomes = sliceH3(CONTRACT, 'Outcomes').split('\n');

    // The Outcomes table carries the FENCE's two-plus-halt vocabulary
    // (`block` / `authorize` / `halt`); the module carries three verdict
    // tokens (`red_commit_not_failing` / `authorize` / `unexpected_pass`).
    // This is the one place that vocabulary crossing happens, named
    // explicitly rather than left implicit in a string comparison.
    const TABLE_VERDICT_FOR = {
      authorize: 'authorize',
      red_commit_not_failing: 'block',
      unexpected_pass: 'halt',
    };

    for (const testCase of EVIDENCE_VECTORS) {
      if (testCase.outcome_row === null) continue;
      const hits = outcomes.filter((line) => line.includes(testCase.outcome_row));
      assert.strictEqual(hits.length, 1,
        `### Outcomes must carry exactly one row containing "${testCase.outcome_row}", the row `
        + `the \`${testCase.id}\` evidence vector IS. Found ${hits.length}. A deleted row is a `
        + 'deleted requirement, and a row title that CONTAINS another row title breaks the '
        + 'shadowed row\'s lookup rather than its own. See #3770.');

      const taskContent = buildTaskContent(testCase.vector.plan);
      const trailerText = `red-evidence: ${JSON.stringify(testCase.vector.trailer)}`;
      const { verdict } = evaluateRedEvidence(taskContent, trailerText);
      const tableVerdict = TABLE_VERDICT_FOR[verdict];
      assert.ok(hits[0].trim().endsWith(`| ${tableVerdict} |`),
        `the "${testCase.outcome_row}" row must carry the verdict the BUILT module actually `
        + `computes for it, \`${verdict}\`, mapped to the table's vocabulary as \`${tableVerdict}\`. `
        + `Observed row: ${hits[0].trim()}. The row verdict is COMPUTED here, not pinned as text, `
        + 'so the table cannot drift from the module the way the outside-in row did. '
        + 'See #3770 (F-4).');
    }
  });

  test('zero-test discovery blocks GREEN on the declared-versus-observed phase, not on a '
    + 'selection counter (REGR-02)', () => {
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);
    const zeroTestsSelected = EVIDENCE_VECTORS.find((c) => c.id === 'zero-tests-selected');
    const taskContent = buildTaskContent(zeroTestsSelected.vector.plan);
    const trailerText = `red-evidence: ${JSON.stringify(zeroTestsSelected.vector.trailer)}`;
    const { failed } = evaluateRedEvidence(taskContent, trailerText);

    assert.deepStrictEqual(failed, ['actual.phase == expected.phase'],
      'an honest zero-test run reports a `collection`-phase failure against a `call`-phase '
      + 'declaration; the phase conjunct must be the ONLY one that blocks it. Exact equality, '
      + 'not membership: with no selection-counter conjuncts left in the flat predicate, a second '
      + 'failing conjunct here would satisfy an `includes` check but not this one. See #3770 '
      + '(REGR-02).');
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
        "the target-test residual: an unrelated assertion in the target test"],
      [UNRELATED_MISSING_DEP_IN_TARGET_FILE, OUTSIDE_IN,
        "the outside-in residual: an unrelated missing dependency in the target test file"],
      [UNRELATED_FIXTURE_CRASH, FIXTURE_IS_THE_BEHAVIOR,
        "the target-test residual at the fixture phase: an unrelated fixture crash"],
    ]) {
      assert.notDeepStrictEqual(residual, twin, `${label}. ${shadows}`);
      assert.deepStrictEqual(differingTopLevelKeys(residual, twin), ['location'],
        `${label}. ${shadows}`);
    }
  });

  test('the built module fails closed on a malformed trailer or a malformed red-contract '
    + 'declaration', () => {
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);
    const validTask = buildTaskContent(GENUINE.plan);
    const validTrailerText = `red-evidence: ${JSON.stringify(GENUINE.trailer)}`;
    const { location, ...fiveKeyTrailer } = GENUINE.trailer;
    void location;

    for (const [label, taskContent, trailerText] of [
      ['an empty-string trailer', validTask, ''],
      ['a non-JSON trailer', validTask, 'red-evidence: not json'],
      ['a five-key trailer missing `location`', validTask,
        `red-evidence: ${JSON.stringify(fiveKeyTrailer)}`],
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
   * One row per shape obligation on a trailer field, so the next one costs one record here
   * rather than one new test — same rationale as the load-bearing-line table above.
   * `mutate` receives a deep clone of the shipped `### Evidence` exemplar (parsed through
   * `trailerLine()`, never retyped) and returns the trailer under test, so these cases track
   * the contract automatically and cannot drift from it. See #3770.
   */
  const TRAILER_SHAPE_CASES = [
    { name: '`location` absent from an otherwise valid six-key trailer',
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
    { name: 'a seventh top-level key added to an otherwise valid vector',
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
    { name: '`exit_status` `"0"` — a PASSING run, quoted as a string',
      mutate: (t) => { t.exit_status = '0'; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`exit_status` `null`',
      mutate: (t) => { t.exit_status = null; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`exit_status` `false`',
      mutate: (t) => { t.exit_status = false; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`exit_status` the empty string',
      mutate: (t) => { t.exit_status = ''; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`exit_status` `[0]`',
      mutate: (t) => { t.exit_status = [0]; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`exit_status` `{}`',
      mutate: (t) => { t.exit_status = {}; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`exit_status` `true`',
      mutate: (t) => { t.exit_status = true; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`command` the empty string',
      mutate: (t) => { t.command = ''; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`command` whitespace only ("   ")',
      mutate: (t) => { t.command = '   '; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`command` `null`',
      mutate: (t) => { t.command = null; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`command` a number (12345) rather than a string',
      mutate: (t) => { t.command = 12345; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`actual` carrying a fourth key beyond `phase`, `class_or_mode` and `subject`',
      mutate: (t) => { t.actual.duration_ms = 12; return t; },
      expected: 'red_commit_not_failing' },
    { name: '`expected` carrying a fourth key beyond `phase`, `class_or_mode` and `subject`',
      mutate: (t) => { t.expected.duration_ms = 12; return t; },
      expected: 'red_commit_not_failing' },
  ];

  test('shape-check edges: empty, absent and malformed trailer values fail closed; '
    + 'path-form differences alone still authorize (#3770)', () => {
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);
    const exemplarLine = trailerLine();
    const shippedTrailer = JSON.parse(exemplarLine.slice(exemplarLine.indexOf('{')));
    const validTask = buildTaskContent(GENUINE.plan);

    for (const { name, mutate, expected } of TRAILER_SHAPE_CASES) {
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
        + 'It is false in a reachable configuration: the predicate never requires '
        + '`expected.subject == plan.target_test`, so an outside-in declaration can be '
        + 'authorized with `actual.subject != expected.subject`. See 02-VERIFICATION.md '
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
    // Same stale-mechanisation claim already inverted on execute-mvp-tdd.md.
    // tdd.md carried a second copy, which that fix did not reach; an executor
    // reading the canonical file was still told the gate it is subject to does
    // not exist yet. Negative plus positive, so the claim cannot drift back by
    // deleting the sentence outright.
    assert.ok(!gates.includes('is not yet mechanised'),
      'the gate region must NOT still say the RED-predicate judgment is unmechanised. That ' +
      'deferral held only until Phase 3 shipped the coded gate; execute-phase.md now sets ' +
      'RED_VERDICT from `task.red-evidence-verdict` and halts unless it is `authorize`. This ' +
      'is the canonical RED source, so an executor reading it believes a gate that actually ' +
      'blocks it does not exist. See #3770.');
    assert.ok(gates.includes('task.red-evidence-verdict'),
      'the gate region must name the verb that computes the verdict, so the executor reading ' +
      'the canonical source knows the judgment is mechanised and by what. See #3770.');
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

  // The MVP+TDD gate snippet is pure text extraction — hoisted here so both
  // this test and "the gate finds the RED commit in every ecosystem..."
  // below share ONE extraction and one set of fixture helpers, per #3770
  // Task 6's explicit "do not add a second harness, `newRepo` or `runGate`".
  // Each helper that owns a temp resource takes the CALLING test's own `t`,
  // so `t.after` cleanup still runs at the right scope.
  const EXECUTE_PHASE_SNIPPET = extractGateSnippet(EXECUTE_PHASE_SRC);

  const makeWriteScript = (t) => {
    const scriptDir = createTempDir('gsd-3770-execgate-sh-');
    t.after(() => cleanup(scriptDir));
    return (name, body) => {
      const p = path.join(scriptDir, name);
      fs.writeFileSync(
        p,
        `#!/usr/bin/env bash\nset -e\ngsd_run() { node ${JSON.stringify(GSD_TOOLS)} "$@"; }\n${body}`,
        { mode: 0o755 },
      );
      return p;
    };
  };

  const GATE_BASE_ENV = {
    MVP_MODE: 'true', TDD_MODE: 'true', PHASE_NUMBER: '08', PLAN_ID: '02', TASK_ID: '1',
  };
  const runGate = (script, cwd, taskFile) => runHook(script, [], {
    interpreter: 'bash',
    cwd,
    env: { ...process.env, ...GATE_BASE_ENV, TASK_FILE: taskFile },
  });

  // `CONTRACT_TASK_LINES`' own runner-native id, string-replaced by the
  // optional second argument so a caller can point the SAME fixture at a
  // different ecosystem's id without a second task-file literal (#3770
  // Task 6).
  const DEFAULT_TARGET_ID = 'tests/test_pricing.py::test_discount_reduces_total';
  const behaviorTask = (cwd, id = DEFAULT_TARGET_ID) => {
    const p = path.join(cwd, 'task.md');
    const lines = id === DEFAULT_TARGET_ID
      ? CONTRACT_TASK_LINES
      : CONTRACT_TASK_LINES.map((line) => line.split(DEFAULT_TARGET_ID).join(id));
    fs.writeFileSync(p, lines.join('\n'));
    return p;
  };
  const docOnlyTask = (cwd) => {
    const p = path.join(cwd, 'task.md');
    fs.writeFileSync(p, ['<task type="auto">', '  <files>docs/notes.md</files>', '</task>'].join('\n'));
    return p;
  };

  const g1Trailer = trailerLine();
  const mutateTrailer = (mutator) => {
    const parsed = JSON.parse(g1Trailer.slice(g1Trailer.indexOf('{')));
    mutator(parsed);
    return `red-evidence: ${JSON.stringify(parsed)}`;
  };
  const g2Trailer = mutateTrailer((p) => { p.location.observed.line += 1; });
  const g5Trailer = mutateTrailer((p) => { p.exit_status = 0; });
  // Builds a trailer that authorizes on its own content for a DIFFERENT
  // ecosystem's id and file: `target_test`, `expected.subject` and
  // `actual.subject` all take `id`, and both `location` points take `file`
  // (declared == observed, so `locationsAgree` holds) — only the gate's
  // search and membership behavior is under test, never the predicate's
  // own conjuncts (#3770 Task 6).
  const ecoTrailer = (id, file) => mutateTrailer((p) => {
    p.target_test = id;
    p.expected.subject = id;
    p.actual.subject = id;
    p.location.declared.file = file;
    p.location.observed.file = file;
  });

  const commit = (cwd, file, subject, trailer) => {
    const abs = path.join(cwd, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `# ${subject}\n`);
    runGit(['add', file], { cwd });
    runGit(trailer ? ['commit', '-m', subject, '-m', trailer] : ['commit', '-m', subject], { cwd });
    return runGit(['rev-parse', 'HEAD'], { cwd }).stdout.trim();
  };

  // git.base-branch's tier-4 fallback only recognizes local branches
  // literally named `main`/`master`, which depends on this machine's
  // `init.defaultBranch` and is not portable to CI. Pin the base
  // explicitly via `.planning/config.json` (tier 1) instead, and land all
  // task commits on a second branch forked off it, so RED_RANGE always
  // gets a real, non-trivial boundary regardless of the host's git config.
  const newRepo = (t) => {
    const dir = createTempGitProject('gsd-3770-execgate-');
    t.after(() => cleanup(dir));
    runGit(['config', 'core.hooksPath', ''], { cwd: dir });
    const baseBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).stdout.trim();
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ git: { base_branch: baseBranch } }));
    runGit(['checkout', '-b', 'gsd-3770-work'], { cwd: dir });
    return dir;
  };

  const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);

  test("the extracted MVP+TDD gate block authorizes only on the evaluator's verdict", (t) => {
    // SIBLING of the S1-S6 test above, not an extension of it: that test
    // extracts `### Executor Gate Validation` out of tdd.md and runs it with
    // PHASE/PLAN. This extracts the MVP+TDD gate's own fenced block out of
    // execute-phase.md and runs it with PHASE_NUMBER/PLAN_ID/TASK_ID/TASK_FILE
    // — a different snippet, a different file, its own scenarios. See #3770.
    const snippet = EXECUTE_PHASE_SNIPPET;
    const writeScript = makeWriteScript(t);
    const scriptPath = writeScript('gate.sh', snippet);

    // ── G1, valid evidence (characterization) ────────────────────────────
    const s1 = newRepo(t);
    const taskFile1 = behaviorTask(s1);
    commit(s1, 'tests/test_pricing.py', 'test(08-02): add failing test for discount', g1Trailer);
    const r1 = runGate(scriptPath, s1, taskFile1);
    assert.strictEqual(r1.exitCode, 0,
      'G1: valid evidence with agreeing declared and observed locations must authorize — the ' +
      'paired control that makes the G2 failure attributable to the location mismatch, not to ' +
      'the gate having become unconditionally strict. See #3770.');

    // ── G2, mismatched evidence (RED) ─────────────────────────────────────
    const s2 = newRepo(t);
    const taskFile2 = behaviorTask(s2);
    commit(s2, 'tests/test_pricing.py', 'test(08-02): add failing test for discount', g2Trailer);
    const r2 = runGate(scriptPath, s2, taskFile2);
    assert.notStrictEqual(r2.exitCode, 0,
      'G2: a red-evidence trailer whose observed location disagrees with its declared location ' +
      'must NOT authorize. Fails today: the unchanged gate never reads the trailer. See #3770.');
    assert.strictEqual(
      evaluateRedEvidence(CONTRACT_TASK_LINES.join('\n'), g2Trailer).verdict,
      'red_commit_not_failing',
      'G2 module-owned check: the verdict for this exact task and trailer pair must be ' +
      'red_commit_not_failing.',
    );

    // ── G3, trailerless commit (RED) ──────────────────────────────────────
    const s3 = newRepo(t);
    const taskFile3 = behaviorTask(s3);
    commit(s3, 'tests/test_pricing.py', 'test(08-02): add failing test for discount', undefined);
    const r3 = runGate(scriptPath, s3, taskFile3);
    assert.notStrictEqual(r3.exitCode, 0,
      'G3: a plan-scoped commit with no red-evidence: trailer must NOT authorize — it must ' +
      'classify as missing_red_evidence, not missing_red_commit (D-14), which is a bash-owned ' +
      'distinction asserted against the workflow text, not at runtime. Fails today: the gate ' +
      'authorizes on any subject match. See #3770.');

    // ── G4, no plan-scoped commit at all (characterization) ───────────────
    const s4 = newRepo(t);
    const taskFile4 = behaviorTask(s4);
    const r4 = runGate(scriptPath, s4, taskFile4);
    assert.notStrictEqual(r4.exitCode, 0,
      'G4: with no matching commit at all the gate must trip — the regression guard on the one ' +
      'blocking behavior that must survive this change.');

    // ── G5, unexpected pass (RED) ──────────────────────────────────────────
    const s5 = newRepo(t);
    const taskFile5 = behaviorTask(s5);
    commit(s5, 'tests/test_pricing.py', 'test(08-02): add failing test for discount', g5Trailer);
    const r5 = runGate(scriptPath, s5, taskFile5);
    assert.notStrictEqual(r5.exitCode, 0,
      'G5: a red-evidence trailer recording exit_status 0 means the RED run PASSED — nothing ' +
      'failed to evaluate — and must NOT authorize. Fails today: the gate never reads ' +
      'exit_status. See #3770.');
    assert.strictEqual(
      evaluateRedEvidence(CONTRACT_TASK_LINES.join('\n'), g5Trailer).verdict,
      'unexpected_pass',
      'G5 module-owned check: the verdict for this exact task and trailer pair must be ' +
      'unexpected_pass.',
    );

    // ── G6, exemption (characterization) ────────────────────────────────────
    const s6 = createTempDir('gsd-3770-execgate-g6-');
    t.after(() => cleanup(s6));
    runGit(['init'], { cwd: s6 });
    runGit(['config', 'core.hooksPath', ''], { cwd: s6 });
    const taskFile6 = docOnlyTask(s6);
    const r6b = runGate(scriptPath, s6, taskFile6);
    assert.strictEqual(r6b.exitCode, 0,
      'G6: a doc-only task must exempt outright, with no RED lookup attempted — a repository ' +
      'with zero commits proves it, since any git log or merge-base call here would fail loudly ' +
      '(GATE-04 regression guard).');

    // ── G7, cross-milestone decoy (RED) ────────────────────────────────────
    const s7 = createTempGitProject('gsd-3770-execgate-g7-');
    t.after(() => cleanup(s7));
    runGit(['config', 'core.hooksPath', ''], { cwd: s7 });
    const taskFile7 = behaviorTask(s7);
    const decoySha = commit(
      s7, 'tests/test_pricing.py', 'test(08-02): add failing test for discount', g1Trailer,
    );
    runGit(['branch', 'gsd-3770-g7-base', decoySha], { cwd: s7 });
    fs.mkdirSync(path.join(s7, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(s7, '.planning', 'config.json'),
      JSON.stringify({ git: { base_branch: 'gsd-3770-g7-base' } }));
    commit(s7, 'README.md', 'chore: advance past the decoy commit', undefined);
    const r7 = runGate(scriptPath, s7, taskFile7);
    assert.notStrictEqual(r7.exitCode, 0,
      'G7: a plan-scoped, evidence-bearing commit that predates the derived base ref must NOT ' +
      'authorize, with no qualifying commit after it. Fails today: the unbounded search selects ' +
      'the decoy. See #3770 (Pitfall 5).');
    const unboundedScript = writeScript('gate-unbounded.sh', snippet.replace(
      /\nTAB=\$\(printf '\\t'\)/,
      '\nRED_RANGE="HEAD" # G7 non-vacuity: force the unbounded range\nTAB=$(printf \'\\t\')',
    ));
    const r7Unbounded = runGate(unboundedScript, s7, taskFile7);
    assert.strictEqual(r7Unbounded.exitCode, 0,
      'G7 non-vacuity: the SAME fixture, without the range bound, must select the decoy and ' +
      'authorize — otherwise G7 proves nothing about the bound specifically.');

    // ── G8, source-only evidence (characterization) ─────────────────────────
    const s8 = newRepo(t);
    const taskFile8 = behaviorTask(s8);
    commit(s8, 'src/pricing.py', 'test(08-02): add failing test for discount', g1Trailer);
    const r8 = runGate(scriptPath, s8, taskFile8);
    assert.notStrictEqual(r8.exitCode, 0,
      'G8: a commit whose subject and trailer both qualify but which touches only a source ' +
      'file must NOT authorize — the --changed-files membership check rejects a trailer ' +
      'declaring a file the RED commit never touched. This is the regression guard on that ' +
      'check, not a RED.');
    // `--changed-files` is a REQUIRED flag (Task 5), so simply deleting it trips a DIFFERENT
    // failure (the usage error) rather than defeating the membership check. Forcing its VALUE
    // to a constant that always matches g1Trailer's own declared_file basename, regardless of
    // what the commit actually touched, is what isolates the membership check specifically.
    const forcedMembershipScript = writeScript(
      'gate-forced-membership.sh',
      snippet.split('--changed-files "$(git show --name-only --format= "$RED_SHA")"')
        .join('--changed-files "tests/test_pricing.py"'),
    );
    const r8Stripped = runGate(forcedMembershipScript, s8, taskFile8);
    assert.strictEqual(r8Stripped.exitCode, 0,
      'G8 non-vacuity: the SAME fixture, with --changed-files forced to a value that always ' +
      "satisfies g1Trailer's own declared_file basename regardless of what the commit " +
      'actually touched, must authorize — proving the guard is the membership check and not ' +
      'something else about this fixture.');
  });

  test('the gate finds the RED commit in every ecosystem and halts rather than falling back',
    (t) => {
      const writeScript = makeWriteScript(t);
      const scriptPath = writeScript('gate.sh', EXECUTE_PHASE_SNIPPET);

      // Part one: five ecosystems, each authorizing on `location.declared.file`
      // alone — never on a filename convention the search itself imposes, and
      // never derived from the id. Go's bare `TestDiscountReducesTotal` carries
      // no path at all, so it is the row that proves a scope derived from the
      // id could not do this. The two "blocked today: no" rows (R, JS) are the
      // no-regression arm: without them a change that stopped excluding the
      // three newly supported ecosystems while breaking the two
      // already-working ones would still pass.
      const ECOSYSTEM_ROWS = [
        { name: 'Go', id: 'TestDiscountReducesTotal', file: 'pkg/pricing/pricing_test.go' },
        { name: 'Ruby', id: './spec/pricing_spec.rb[1:1]', file: 'spec/pricing_spec.rb' },
        {
          name: 'Python outside tests/',
          id: 'src/pricing/test_pricing.py::test_discount_reduces_total',
          file: 'src/pricing/test_pricing.py',
        },
        { name: 'R', id: 'test-pricing.R: discount reduces total', file: 'tests/testthat/test-pricing.R' },
        { name: 'JS', id: 'lib/pricing.test.ts > discount reduces the total', file: 'lib/pricing.test.ts' },
      ];
      for (const row of ECOSYSTEM_ROWS) {
        const dir = newRepo(t);
        const taskFile = behaviorTask(dir, row.id);
        commit(dir, row.file, 'test(08-02): add failing test for discount', ecoTrailer(row.id, row.file));
        const result = runGate(scriptPath, dir, taskFile);
        assert.strictEqual(result.exitCode, 0,
          `${row.name}: the gate must authorize on ${JSON.stringify(row.id)} declaring ` +
          `${row.file} — the file comes from location.declared.file, never from a filename ` +
          'convention or the id itself. See #3770 (Task 6, LANG-01).');
      }

      // Part two: the stale-fallback case. An OLDER commit touches the test
      // file with a fully self-consistent trailer. A NEWER commit touches
      // only a source file and declares that same source file, but its
      // trailer's `location.observed` still names the OLDER commit's test
      // file — so the newer commit's own evidence is internally
      // inconsistent and the predicate rejects it outright. With the
      // pathspec, the newer commit is invisible to the search entirely (it
      // never touched a matching file) and `grep -m1` silently falls back
      // to the older, valid-looking evidence from a superseded run. Without
      // the pathspec, the search finds the newer commit first and the gate
      // halts on it instead of silently authorizing stale evidence.
      const staleDir = newRepo(t);
      const staleTaskFile = behaviorTask(staleDir);
      commit(staleDir, 'tests/test_pricing.py', 'test(08-02): add failing test for discount', g1Trailer);
      const staleTrailer = mutateTrailer((p) => { p.location.declared.file = 'src/pricing.py'; });
      commit(staleDir, 'src/pricing.py', 'test(08-02): add failing test for discount', staleTrailer);
      const staleResult = runGate(scriptPath, staleDir, staleTaskFile);
      assert.notStrictEqual(staleResult.exitCode, 0,
        'stale-fallback: a newer, plan-scoped, evidence-bearing commit that touches only a ' +
        'source file must halt the gate, not fall back to an older, valid-looking commit the ' +
        'newer one has superseded. Fails today: the pathspec hides the newer commit from the ' +
        'search entirely and grep -m1 silently selects the older one instead. See #3770 (Task 6).');
      assert.match(`${staleResult.stdout}${staleResult.stderr}`, /red_commit_not_failing/,
        "the halt must be on the newer commit's own internally-inconsistent evidence " +
        '(declared and observed location disagree), not on an unrelated failure such as a ' +
        'missing commit — so the case cannot be satisfied by an unrelated failure.');
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

    assert.ok(!checks.includes('is not yet mechanised'),
      'the gate checks must NOT still say the RED-predicate judgment is unmechanised. That '
      + 'deferral was true only until Phase 3 shipped the coded gate; execute-phase.md now sets '
      + 'RED_VERDICT from `task.red-evidence-verdict` and halts unless it is `authorize`. An '
      + 'executor told the judgment is unmechanised believes a gate it is actually subject to '
      + 'does not exist — the exact class of stale-contract defect #3770 is about. See #3770.');
    assert.ok(checks.includes('task.red-evidence-verdict'),
      'the gate checks must name the verb that computes the verdict, so the executor knows the '
      + 'judgment is mechanised and by what. See #3770.');
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

describe('MVP+TDD gate — the plan\'s two test-verified prohibitions (#3770)', () => {
  test('the gate ships no newly introduced escape hatch', () => {
    const gate = extractGateSnippet(EXECUTE_PHASE_SRC);

    // `--force-mvp-gate` is documented-but-unimplemented and overrides the
    // end-of-phase blocking TDD review, NOT this per-task gate. The prohibition
    // is that this plan must not extend it to reach here.
    assert.ok(!gate.includes('force-mvp-gate') && !gate.includes('FORCE_MVP_GATE'),
      'the per-task gate must not reach `--force-mvp-gate`. It overrides the end-of-phase '
      + 'blocking TDD review; extending it to the per-task RED-evidence check would be '
      + 'indistinguishable in effect from the defect #3770 reports. See 03-03-PLAN.md.');

    // Whitelist the variables the gate may READ, rather than blacklisting
    // hatch-sounding names. A blacklist cannot work here: `GSD_SKIP_TDD_GATE`
    // defeats a `\bSKIP` word-boundary probe (the preceding `_` is a word
    // character), and a hatch is naturally written as an assignment to the
    // predicate variable it subverts, so any name-based exemption for
    // IS_BEHAVIOR_ADDING exempts the hatch too. Reads are enumerable and
    // closed; a new env-var hatch necessarily adds one.
    const ALLOWED_READS = [
      'BASE_BRANCH', 'IS_BEHAVIOR_ADDING', 'MVP_MODE', 'PHASE_NUMBER', 'PLAN_ID',
      'RED_RANGE', 'RED_RECORD', 'RED_SHA', 'RED_TRAILER', 'RED_VERDICT',
      'TAB', 'TASK_FILE', 'TASK_ID', 'TDD_MODE',
    ];
    const reads = [...new Set(
      [...gate.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
    )].sort();
    assert.ok(reads.length > 0, 'the gate must read at least one variable — a zero-length '
      + 'read set would make this assertion vacuous.');
    assert.deepStrictEqual(reads.filter((v) => !ALLOWED_READS.includes(v)), [],
      'the gate read a variable outside its closed set, which is how a newly introduced '
      + 'environment-variable escape hatch enters. No env var, flag, or config key added by '
      + 'this plan may skip the per-task RED-evidence check for a behavior-adding task. If a '
      + 'read is legitimately new, add it here deliberately. See #3770.');

    // The predicate must be established once, from the query, and never
    // reassigned — an `IS_BEHAVIOR_ADDING=false` override is a hatch whatever
    // guards it.
    // Unanchored on purpose: a hatch is written inline as
    // `if [ ... ]; then IS_BEHAVIOR_ADDING=false; fi`, so a `^\s*` anchor
    // would look only where a hatch never appears.
    const behaviorAssigns = [...gate.matchAll(/IS_BEHAVIOR_ADDING=/g)];
    assert.strictEqual(behaviorAssigns.length, 1,
      'IS_BEHAVIOR_ADDING must be assigned exactly once, from '
      + '`gsd_run query task.is-behavior-adding`. A second assignment reopens the gate for '
      + 'a behavior-adding task without touching the check itself. See #3770.');
    assert.ok(gate.includes("IS_BEHAVIOR_ADDING=$(gsd_run query task.is-behavior-adding"),
      'the sole IS_BEHAVIOR_ADDING assignment must come from the query verb, not a literal.');
  });

  test('the verdict-capture line neither swallows, redirects, nor defaults around failure', () => {
    const gate = extractGateSnippet(EXECUTE_PHASE_SRC);

    const verdictLines = gate.split('\n').filter((l) => l.includes('task.red-evidence-verdict'));
    assert.strictEqual(verdictLines.length, 1,
      'the gate must capture the verdict on exactly one line — zero would make this test '
      + 'vacuous, two would leave one of them unchecked.');
    const verdictLine = verdictLines[0];

    // Scoped EXACTLY to the verdict line. These idioms stay correct on the
    // pre-existing `state.update last_gate_trip` call (which records a trip and
    // must not itself abort the report) and on best-effort base-ref derivation
    // (which degrades to today's behavior, not to an authorization).
    for (const idiom of ['2>/dev/null', '|| true', '|| echo']) {
      assert.ok(!verdictLine.includes(idiom),
        `the verdict-capture line must not use \`${idiom}\`. On a configuration read a default `
        + 'is genuinely correct; on the line that captures the verdict it converts a fail-closed '
        + 'gate into a fail-open one — the gate would authorize GREEN precisely when the '
        + 'evaluator could not be consulted. See #3770.');
    }
    assert.ok(verdictLine.includes('|| exit 1'),
      'the verdict-capture line must carry `|| exit 1` so a failed evaluator invocation halts '
      + 'rather than leaving RED_VERDICT empty and falling through. See #3770.');
  });
});

describe('task red-evidence-verdict — evidence file membership (#3770 D-1 revised)', () => {
  const REPO_ROOT = path.join(__dirname, '..');

  function shippedTrailerObject() {
    const line = trailerLine();
    return JSON.parse(line.slice(line.indexOf('{')));
  }

  function trailerTextWithDeclaredFile(declaredFile) {
    const trailer = shippedTrailerObject();
    trailer.location.declared.file = declaredFile;
    return `red-evidence: ${JSON.stringify(trailer)}`;
  }

  function writeTaskFile(cwd) {
    const p = path.join(cwd, 'task.md');
    fs.writeFileSync(p, CONTRACT_TASK_LINES.join('\n'));
    return p;
  }

  function runVerdict(args, cwd) {
    return runNode([GSD_TOOLS, 'query', 'task', 'red-evidence-verdict', ...args], { cwd });
  }

  // Each row mutates only `location.declared.file` on the shipped exemplar,
  // holding `location.observed.file` (`/srv/build/tests/test_pricing.py`)
  // fixed so `locationsAgree`'s own basename comparison keeps passing —
  // every row's basename is `test_pricing.py` — and only the membership
  // test, not the predicate's own verdict, varies row to row.
  const MEMBERSHIP_ROWS = [
    { name: 'the declared file is in the commit',
      declaredFile: 'tests/test_pricing.py', changedFiles: 'tests/test_pricing.py',
      expected: 'authorize' },
    { name: 'a bare-basename declaration',
      declaredFile: 'test_pricing.py', changedFiles: 'tests/test_pricing.py',
      expected: 'authorize' },
    { name: 'a backslash-separated declaration',
      declaredFile: 'tests\\test_pricing.py', changedFiles: 'tests/test_pricing.py',
      expected: 'authorize' },
    { name: 'an absolute declaration',
      declaredFile: '/srv/build/tests/test_pricing.py', changedFiles: 'tests/test_pricing.py',
      expected: 'authorize' },
    { name: 'the commit touches only source',
      declaredFile: 'tests/test_pricing.py', changedFiles: 'src/pricing.py',
      expected: 'red_commit_not_failing' },
    { name: 'the commit touches a DIFFERENT test file',
      declaredFile: 'tests/test_pricing.py', changedFiles: 'tests/test_shipping.py',
      expected: 'red_commit_not_failing' },
    { name: 'an empty changed-file list',
      declaredFile: 'tests/test_pricing.py', changedFiles: '',
      expected: 'red_commit_not_failing' },
    { name: 'blank lines only',
      declaredFile: 'tests/test_pricing.py', changedFiles: '\n\n',
      expected: 'red_commit_not_failing' },
  ];

  test('the verdict verb refuses a commit that does not touch the file its evidence names', (t) => {
    const scratch = createTempDir('gsd-3770-changed-files-');
    t.after(() => cleanup(scratch));
    const taskFile = writeTaskFile(scratch);

    for (const row of MEMBERSHIP_ROWS) {
      const trailerText = trailerTextWithDeclaredFile(row.declaredFile);
      const result = runVerdict(
        ['--task-file', taskFile, '--trailer', trailerText, '--changed-files', row.changedFiles],
        scratch,
      );
      assert.strictEqual(result.exitCode, 0,
        `${row.name}: the verb must exit 0 and report its verdict on stdout, not crash. `
        + `stderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.verdict, row.expected,
        `${row.name}: expected \`${row.expected}\`, got \`${parsed.verdict}\` `
        + `(reason: ${parsed.reason}). declared_file=${JSON.stringify(row.declaredFile)} `
        + `changed_files=${JSON.stringify(row.changedFiles)}. See #3770 (D-1 revised).`);
      if (row.expected === 'red_commit_not_failing') {
        assert.ok(typeof parsed.reason === 'string' && parsed.reason.includes(row.declaredFile),
          `${row.name}: the refusal reason must name the declared file so a human reading it `
          + `can act on it. Got: ${parsed.reason}`);
      }
    }
  });

  test('`--changed-files` is required: omitting it with a valid task file exits non-zero '
    + 'with a usage error', (t) => {
    const scratch = createTempDir('gsd-3770-changed-files-usage-');
    t.after(() => cleanup(scratch));
    const taskFile = writeTaskFile(scratch);
    const trailerText = trailerTextWithDeclaredFile('tests/test_pricing.py');

    const result = runVerdict(['--task-file', taskFile, '--trailer', trailerText], scratch);
    assert.notStrictEqual(result.exitCode, 0,
      'omitting --changed-files must exit non-zero: a gate that cannot ask the membership '
      + 'question must not fall through and authorize.');
    assert.match(`${result.stdout}${result.stderr}`, /--changed-files/,
      'the usage error must name the missing flag.');
  });

  test('`--changed-files` omitted with a task file OUTSIDE the project still reports '
    + '"outside project scope" — pinning that the path guards fire before the usage check', () => {
    const outside = createTempDir('gsd-3770-changed-files-outside-');
    const target = path.join(outside, 'outside.md');
    fs.writeFileSync(target, CONTRACT_TASK_LINES.join('\n'));

    try {
      const result = runVerdict(['--task-file', target, '--trailer', '{}'], REPO_ROOT);
      assert.match(`${result.stdout}${result.stderr}`, /outside project scope/,
        'the path guard must still fire and report "outside project scope" even when '
        + '--changed-files is ALSO missing — the usage check must sit AFTER the path guards, '
        + 'never before them, so a security guard is never reported as a mere arity error. '
        + 'See #3770 (T-04.1-04).');
    } finally {
      cleanup(outside);
    }
  });

  test('a trailer the predicate already rejects keeps its original verdict and reason when '
    + 'the changed-file list is empty', (t) => {
    const scratch = createTempDir('gsd-3770-changed-files-reject-');
    t.after(() => cleanup(scratch));
    const taskFile = writeTaskFile(scratch);
    const trailer = shippedTrailerObject();
    trailer.exit_status = 0; // the predicate already rejects this: `unexpected_pass`.
    const trailerText = `red-evidence: ${JSON.stringify(trailer)}`;

    const result = runVerdict(
      ['--task-file', taskFile, '--trailer', trailerText, '--changed-files', ''],
      scratch,
    );
    const parsed = JSON.parse(result.stdout);
    const { evaluateRedEvidence } = require(RED_EVIDENCE_PREDICATE_PATH);
    const direct = evaluateRedEvidence(CONTRACT_TASK_LINES.join('\n'), trailerText);

    assert.strictEqual(parsed.verdict, direct.verdict,
      'a trailer the predicate already rejects must keep the SAME verdict when the '
      + 'changed-file list is empty: membership is tested only when the evaluator itself '
      + 'already said `authorize`, never used to override an existing rejection.');
    assert.strictEqual(parsed.reason, direct.reason,
      'and the SAME reason: the membership check must not overwrite an already-failing '
      + "trailer's own reason.");
  });
});

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
// #4254 — sequential (non-isolated) executor dispatch had no hard pin to the
// orchestrator's own worktree root: the dispatched prompt told the executor to
// self-derive PROJECT_ROOT via `git rev-parse --show-toplevel`, and every
// existing guard (steps 0a/0b worktree-only, step 0 branch-scoped) is
// self-referential — so an executor spawned with a drifted cwd committed onto
// the wrong checkout silently. The fix ships a mode-agnostic "supplied-root
// pin" guard (step 0p) in worktree-path-safety.md, bound at dispatch time by
// execute-phase.md's SEQUENTIAL branch only (worktree mode keeps its own,
// intentionally different, self-derived root). These tests EXECUTE the shipped
// guard against real git fixtures — no string-only vacuity (#4296 review
// precedent, Blocker 2).
// ────────────────────────────────────────────────────────────────────────
describe('bug #4254: sequential executor supplied-root pin', () => {
  // allow-test-rule: source-text-is-the-product (see #3097) — the reference
  // and the workflow markdown ARE the product under test. ROOT and
  // executePhaseSrc are re-declared here: the folded #3097/#3099 block above
  // declares its own copies inside a closure, out of this describe's scope.
  const ROOT = path.join(__dirname, '..');
  const executePhaseSrc = fs.readFileSync(
    path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md'), 'utf8',
  );
  const safetyRefPath = path.join(ROOT, 'gsd-core', 'references', 'worktree-path-safety.md');
  const pinStepPath = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'sequential-root-pin.md');
  const safetySrc = fs.readFileSync(safetyRefPath, 'utf8');
  const pinStepSrc = fs.readFileSync(pinStepPath, 'utf8');
  const { createTempGitProject, cleanup } = require('./helpers.cjs');
  const { runHook } = require('./helpers/process-seam.cjs');
  const { gitOrThrow } = require('./helpers/git-fixture.cjs');
  const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

  const PIN_MARKER = '# gsd:guard=supplied-root-pin';

  // Extract the shipped guard — the exact ```bash block that carries the
  // marker — so the tests can never pass against a stale or hand-copied body.
  function extractPinGuard() {
    const body = safetySrc.split('```bash\n').find((b) => b.startsWith(PIN_MARKER));
    assert.ok(body, 'worktree-path-safety.md must ship the #4254 supplied-root-pin guard');
    return body.split('```')[0].trim();
  }

  // The composition contract the orchestrator follows at dispatch: a
  // shell-single-quoted literal with `'\''` escaping for embedded quotes.
  const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

  function composeGuard(pinQuotedLiteral) {
    return extractPinGuard().replace("PINNED_ROOT='{PINNED_ROOT}'", `PINNED_ROOT=${pinQuotedLiteral}`);
  }

  // Run the composed guard in `cwd`; `probe` (optional bash line) runs only if
  // the guard passes — proving the write barrier, not just the exit code.
  function runPinGuard(cwd, pin, probe) {
    return runHook('-c', [composeGuard(shellQuote(pin)) + (probe ? `\n${probe}` : '')], {
      interpreter: 'bash',
      cwd,
      timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  }

  // Fixture: a primary checkout plus a linked worktree (the orchestrator's
  // lane). Sibling path — a worktree inside the primary's tree would show up
  // as an untracked directory and muddy the fixtures.
  function makeOrchestratorLane(prefix) {
    const primary = createTempGitProject(prefix);
    const lane = `${primary}-orchestrator-wt`;
    gitOrThrow(['worktree', 'add', '-q', '-b', 'phase/2-1', lane], { cwd: primary });
    return { primary, lane };
  }

  test('#4254: reference ships the supplied-root pin section with composition + runtime contracts', () => {
    assert.match(safetySrc, /## Supplied-root pin — step 0p \(#4254, EVERY mode\)/);
    // Runtime contract: run before first Edit/Write and every commit; HALT on
    // FATAL; warn-and-proceed ONLY when the prompt carries no pin block.
    assert.match(safetySrc, /before your first Edit\/Write and again\s+before every commit/);
    assert.match(safetySrc, /NO `<project_root_pin>` block[\s\S]*?warning line and continue/);
    // The executor must never bind the placeholder itself — that is exactly
    // the #4254 failure mode re-armored as a "fix".
    assert.match(safetySrc, /Never bind\s+`\{PINNED_ROOT\}` yourself/);
    // Composition contract: build-time literal substitution, single-quoted,
    // git-vs-git comparison rationale (the #4296 Windows lesson).
    assert.match(safetySrc, /substituting[\s\S]*`\{PINNED_ROOT\}`[\s\S]*shell-single-quoted/);
    assert.match(safetySrc, /git-vs-git on BOTH sides/);
  });

  test('#4254: RED regression — drifted-cwd executor halts before the wrong-checkout write', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-drift-');
    try {
      // The orchestrator pinned its own lane; the executor's process cwd
      // resolved to the PRIMARY checkout (the issue's exact shape).
      const marker = path.join(primary, 'write-marker');
      const res = runPinGuard(primary, lane, `printf 'W' > ${shellQuote(marker)}`);
      assert.equal(res.exitCode, 1, `mismatched root must halt, got:\n${res.stdout}\n${res.stderr}`);
      assert.equal(fs.existsSync(marker), false, 'no write may run after a root mismatch');
      assert.match(res.stderr, /FATAL[^\n]*#4254/);
      // Loud detection: the FATAL names BOTH roots — the pinned lane and the
      // actual (wrong) primary checkout. The primary's basename is unique to
      // it (the lane appends '-orchestrator-wt'), so matching it inside the
      // Actual-root line proves the right checkout is being named.
      assert.match(res.stderr, /Pinned root:[^\n]*orchestrator-wt/, 'FATAL must name the pinned root');
      const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
      const primaryName = escapeRegex(path.basename(primary));
      assert.match(res.stderr, new RegExp(`Actual root:[^\\n]*${primaryName}`), 'FATAL must name the actual (wrong) root');
      assert.doesNotMatch(res.stderr, new RegExp(`Actual root:[^\\n]*orchestrator-wt`), 'the actual root must NOT be the pinned lane');
      // The FATAL self-describes its stage (and, on capture failures, git's own
      // stderr) — the discriminator whose absence let this class of failure read
      // as "capture returns empty" when the form gate was what fired on Windows.
      assert.match(res.stderr, /Guard stage: root-mismatch/, 'drifted cwd is a root mismatch, not a capture or form failure');
      assert.match(res.stderr, /Diagnostic: actual=.*pinned=.*superproject=<none>/, 'the mismatch diagnostic names both roots and the absent superproject');
    } finally {
      cleanup(primary);
    }
  });

  test('#4254: correct-cwd control — matching root permits the write', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-match-');
    try {
      const marker = path.join(lane, 'write-marker');
      const res = runPinGuard(lane, lane, `printf 'W' > ${shellQuote(marker)}`);
      assert.equal(res.exitCode, 0, `matching root must permit the write, got:\n${res.stderr}`);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'W');
    } finally {
      cleanup(primary);
    }
  });

  test('#4254: unexpanded or empty pin fails closed (never warn-and-proceed inside a pin block)', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-unbound-');
    try {
      const marker = path.join(lane, 'write-marker');
      // Unexpanded: the orchestrator never performed the build-time substitution.
      const unexpanded = runHook('-c', [extractPinGuard() + `\nprintf 'W' > ${shellQuote(marker)}`], {
        interpreter: 'bash', cwd: lane, timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      });
      assert.equal(unexpanded.exitCode, 1, 'an unexpanded {PINNED_ROOT} must halt');
      assert.match(unexpanded.stderr, /Guard stage: pin-unbound/, 'an unexpanded pin halts at the pin-unbound stage');
      // Empty: substituted to nothing — indistinguishable from a forgotten transplant.
      const empty = runHook('-c', [composeGuard("''") + `\nprintf 'W' > ${shellQuote(marker)}`], {
        interpreter: 'bash', cwd: lane, timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      });
      assert.equal(empty.exitCode, 1, 'an empty pin must halt');
      assert.match(empty.stderr, /Guard stage: pin-unbound/, 'an empty pin halts at the pin-unbound stage');
      assert.equal(fs.existsSync(marker), false);
    } finally {
      cleanup(primary);
    }
  });

  test('#4254: normalization — trailing slash, symlink alias, subdirectory cwd, and unresolved temp-root spelling all match', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-norm-');
    try {
      const alias = `${primary}-alias`;
      fs.symlinkSync(lane, alias, 'junction');
      const subdir = path.join(lane, 'nested');
      fs.mkdirSync(subdir);
      // The unresolved spelling of the temp root (macOS: /var/... vs git's
      // resolved /private/var/...): both sides are git-emitted, so the
      // comparison is representation-safe by construction. On platforms
      // without the /var symlink this degenerates to the realpath form and
      // still asserts the matching property.
      const unresolvedLane = fs.realpathSync(lane).replace('/private/var/', '/var/');
      for (const pin of [lane, `${lane}/`, alias, unresolvedLane]) {
        const marker = path.join(lane, 'write-marker');
        const res = runPinGuard(subdir, pin, `printf 'W' > ${shellQuote(marker)}`);
        assert.equal(res.exitCode, 0, `pin form ${pin} must normalize to the same checkout:\n${res.stderr}`);
        fs.unlinkSync(marker);
      }
    } finally {
      cleanup(primary);
    }
  });

  test('#4254: boundary — registered submodule of the pinned checkout commits; unregistered and sibling checkouts halt', () => {
    const primary = createTempGitProject('gsd-4254-super-');
    const subSource = createTempGitProject('gsd-4254-subsource-');
    try {
      gitOrThrow(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'module'], { cwd: primary });
      gitOrThrow(['commit', '-qm', 'chore: register submodule'], { cwd: primary });
      const moduleRoot = path.join(primary, 'module');
      // Registered immediate submodule: legitimate sub_repos work, permitted.
      const inModule = path.join(moduleRoot, 'write-marker');
      assert.equal(runPinGuard(moduleRoot, primary, `printf 'W' > ${shellQuote(inModule)}`).exitCode, 0);
      fs.unlinkSync(inModule);
      // Unregistered nested clone inside the pinned checkout: halts.
      const rogue = path.join(primary, 'rogue-clone');
      gitOrThrow(['clone', '-q', subSource, rogue], { cwd: primary });
      const rogueMarker = path.join(rogue, 'write-marker');
      assert.equal(runPinGuard(rogue, primary, `printf 'W' > ${shellQuote(rogueMarker)}`).exitCode, 1);
      assert.equal(fs.existsSync(rogueMarker), false);
      // Sibling linked worktree of the SAME repo (right repo, wrong checkout —
      // the incident's exact shape): halts.
      const sibling = `${primary}-sibling-wt`;
      gitOrThrow(['worktree', 'add', '-q', '-b', 'phase/9-9', sibling], { cwd: primary });
      const siblingMarker = path.join(sibling, 'write-marker');
      assert.equal(runPinGuard(sibling, primary, `printf 'W' > ${shellQuote(siblingMarker)}`).exitCode, 1);
      assert.equal(fs.existsSync(siblingMarker), false);
    } finally {
      cleanup(primary);
      cleanup(subSource);
    }
  });

  test('#4254: pin outside any git repo, and cwd outside any git repo, both fail closed', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-norepo-');
    const outside = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-4254-outside-'));
    try {
      assert.equal(runPinGuard(lane, outside).exitCode, 1, 'pin outside a repo must halt');
      assert.equal(runPinGuard(outside, lane).exitCode, 1, 'cwd outside a repo must halt');
    } finally {
      cleanup(outside);
      cleanup(primary);
    }
  });

  test('#4254: shell-metacharacter pin is safely quoted — no command substitution executes', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-meta-');
    try {
      const tricky = path.join(primary, `q' $HOME $(touch PWNED) x`);
      fs.symlinkSync(lane, tricky, 'junction');
      const marker = path.join(lane, 'write-marker');
      const res = runPinGuard(lane, tricky, `printf 'W' > ${shellQuote(marker)}`);
      assert.equal(res.exitCode, 0, `quoted metacharacter pin must match its checkout:\n${res.stderr}`);
      assert.equal(fs.existsSync(path.join(lane, 'PWNED')), false, 'command substitution in the pin must not execute');
      assert.equal(fs.existsSync(marker), true);
    } finally {
      cleanup(primary);
    }
  });

  test('#4254: relative pin is rejected; Windows drive-letter forms pass the form gate and fail only at the git lookup', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-forms-');
    try {
      // Relative pins are never trustworthy across cwds — rejected outright,
      // and the FATAL says so at the form-gate stage.
      const rel = runPinGuard(lane, 'relative/path');
      assert.equal(rel.exitCode, 1);
      assert.match(rel.stderr, /Guard stage: form-gate/, 'a relative pin must halt at the form gate');
      // The drive-letter forms Windows produces must be ACCEPTED by the shipped
      // guard's absolute-form gate and then fail only on the git lookup — never
      // on the form rejection: the forward-slash form git EMITS (C:/…) and the
      // backslash form Node's path.join and cmd.exe PRODUCE (C:\…, including
      // RUNNER~1-style short names). The Guard stage line is the discriminator:
      // pinned-capture means the form passed and `git -C` spoke (its stderr rides
      // the Diagnostic line), form-gate means the gate ate the pin — the exact
      // CI defect where every backslash pin died before the actual root was ever
      // computed. Driving the SHIPPED guard also removes the hand-rolled
      // duplicate `case` this row used to carry (the #4296 Minor 1 duplication
      // smell, and itself a transit-fragile copy of the broken pattern).
      for (const driveForm of ['C:/definitely/not/a/repo', 'C:\\definitely\\not\\a\\repo']) {
        const res = runPinGuard(lane, driveForm);
        assert.equal(res.exitCode, 1, `nonexistent drive-letter pin must fail closed (${driveForm})`);
        assert.match(
          res.stderr, /Guard stage: pinned-capture/,
          `drive form ${driveForm} must pass the form gate and halt at the pinned-capture stage, got:\n${res.stderr}`,
        );
        assert.match(res.stderr, /Diagnostic: git -C <pinned root> rev-parse --show-toplevel failed:/, 'the capture failure carries git stderr');
      }
      // Transit hardening, pinned on the shipped text itself: the guard must
      // generate its backslash comparator at RUNTIME (printf octal) and must not
      // contain a doubled backslash anywhere — a backslash written twice does
      // not survive the Windows command-line round-trip into bash (it arrives
      // halved, rewriting any escape pattern that relies on it). Two earlier
      // pattern spellings failed the Windows CI leg on exactly this.
      const guardBody = extractPinGuard();
      assert.doesNotMatch(guardBody, /\\\\/, 'the shipped guard must contain no doubled backslash (Windows transit halves it)');
      assert.match(guardBody, /printf '\\134'/, 'the drive-form gate must generate its backslash comparator at runtime');
    } finally {
      cleanup(primary);
    }
  });

  test('#4254: execute-phase.md sequential branch pins the orchestrator root at build time', () => {
    const sequential = executePhaseSrc.split('**Sequential mode**')[1].split('4. **Wait for all agents')[0];
    assert.ok(sequential.length > 0, 'sequential-mode section not found');
    // The host step delegates the composition detail to the fragment (ADR-857
    // Phase 6 frozen ceiling — execute-phase.md cannot grow) and the prompt
    // gains the pin block plus the per-write/commit instruction.
    assert.match(sequential, /read and execute\s+`execute-phase\/steps\/sequential-root-pin\.md`/);
    assert.match(sequential, /<project_root_pin>/);
    assert.match(sequential, /Run the `<project_root_pin>` guard before your first Edit\/Write and before every commit/);
    // The fragment carries the full build-time embed contract.
    assert.match(pinStepSrc, /ORCHESTRATOR build-time embed/);
    assert.match(pinStepSrc, /\{PINNED_ROOT\}/);
    assert.match(pinStepSrc, /ORCHESTRATOR_WT/);
    assert.match(pinStepSrc, /do not pass this instruction through/i);
    // The self-derivation is replaced with the literal, preserving the
    // `PROJECT_ROOT=` binding the rest of <required_reading> depends on.
    assert.match(pinStepSrc, /replace the self-derivation line/);
    assert.match(pinStepSrc, /PROJECT_ROOT='<the same literal/);
    // Scoping: the fragment must say worktree mode keeps the self-derived form.
    assert.match(pinStepSrc, /sequential-mode\s+ONLY/i);
    // The wave serialization rules moved with it, verbatim in substance.
    assert.match(pinStepSrc, /two non-worktree plans in the same wave must serialize/);
  });

  test('#4254: worktree-mode dispatch is untouched — keeps self-derivation, gains no pin', () => {
    const isolated = executePhaseSrc.slice(
      executePhaseSrc.indexOf('<parallel_execution>'),
      executePhaseSrc.indexOf('**Sequential mode**'),
    );
    assert.ok(isolated.length > 0, 'worktree-mode dispatch slice not found');
    assert.match(isolated, /PROJECT_ROOT=\$\(git rev-parse --show-toplevel/, 'isolated executor keeps its own (correct) root derivation');
    assert.doesNotMatch(isolated, /<project_root_pin>/, 'isolated prompt must not inherit the orchestrator root');
  });
});

// allow-test-rule: source-text-is-the-product (see #3300)
// The workflow markdown IS the installed orchestration contract; these rows
// extract the real shipped bash and execute it, never a hand-copied duplicate.

'use strict';

/**
 * #3300 — the `if ls <glob>` guards for the optional CONTEXT/RESEARCH sections
 * of review.md's build_prompt block are defeated by the block's own nullglob
 * shim (#2962): an unmatched glob expands to nothing, so `ls` runs with zero
 * operands (lists the working directory, exits 0 — guard unconditionally true)
 * and `cat` runs with zero operands and reads STDIN: a 0-byte section file at
 * EOF, an indefinite hang on an open pipe.
 *
 * Behavioral seam: extract the REAL fenced build_prompt block from
 * gsd-core/workflows/review.md (+ its steps/ fragments, via readWorkflowCombined),
 * fill the `{run_dir}` placeholder exactly as the workflow host does, and run the
 * whole block in a temp PHASE_DIR/RUN_DIR under bash and — when present — zsh,
 * the two dialects the block's own `shopt -s nullglob; setopt NULL_GLOB` shim
 * targets. Rows:
 *   1-2  absent sources      -> NO output file created at all (not even 0-byte)
 *   3-6  present sources     -> exact bytes, all matches concatenated in glob order
 *   7-8  open, never-closed stdin pipe -> block completes within a short bound
 *   9    structural: no `if ls` guard survives in any review.md bash fence, and
 *        the #2962 nullglob shim itself is still present (out-of-scope guard).
 *
 * Script transport is temp-FILE based, never `bash -c <script>`: #2650 proved a
 * quote-dense multi-line script does not survive Windows argv serialization
 * (CreateProcess flattening + Git Bash MSYS re-splitting mangles it in transit).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  cleanup,
  createTempDir,
  readWorkflowCombined,
} = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const REVIEW_WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'review.md');

/** How long the open-stdin rows may run before the kill timer fires (issue
 * criterion 3: "completion within a short bound"). The fixed block finishes in
 * single-digit ms; 5s is two orders of magnitude of slack, and the timer turns
 * the pre-fix hang into a clean assertion failure instead of a suite hang. */
const STDIN_BOUND_MS = 5000;

// bash is unconditional (GitHub's windows-latest lanes ship Git Bash; every
// existing bash-spawning test in this suite relies on that). zsh is probed —
// it is the second dialect the shim targets, but it is absent on windows
// lanes, so its rows skip rather than fail there.
function detectShells() {
  const shells = [{ name: 'bash', cmd: 'bash' }];
  const probe = spawnSync('zsh', ['-c', 'exit 0'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true });
  if (!probe.error && probe.status === 0) {
    shells.push({ name: 'zsh', cmd: 'zsh' });
  } else {
    // gsd-core#4109: a skipped zsh lane reads identically to a passing one in
    // this suite's own output, which is exactly why the bash/zsh
    // word-splitting bug class went undetected in CI as long as it did. Make
    // the skip loud so a zsh-less run (e.g. some ubuntu CI images) reads as
    // "zsh coverage unknown", not "all lanes green".
    console.warn(
      '[review-build-prompt-optional-sections.test.cjs] zsh not available — zsh-lane tests SKIPPED, coverage for this shell is UNKNOWN, not verified',
    );
  }
  return shells;
}
const SHELLS = detectShells();

/**
 * Extract the fenced ```bash block of build_prompt — the one that writes
 * `${RUN_DIR}/gsd-review-context.md` — from review.md (+steps). Walks backward
 * from the first `gsd-review-context.md` occurrence to its enclosing fence, the
 * same pattern as tests/plan-phase-stall-detection.test.cjs. Throws (failing the
 * whole describe) if the anchor or fence disappears, so a future relocation of
 * the block cannot silently blank these rows.
 */
function extractBuildPromptBlock() {
  const content = readWorkflowCombined(REVIEW_WORKFLOW);
  const anchorIdx = content.indexOf('gsd-review-context.md');
  assert.notEqual(anchorIdx, -1, 'gsd-review-context.md no longer appears in review.md (+steps)');
  const before = content.slice(0, anchorIdx);
  const fenceOpenRe = /```bash\r?\n/g;
  let lastOpen = -1;
  let m;
  while ((m = fenceOpenRe.exec(before)) !== null) lastOpen = m.index + m[0].length;
  assert.notEqual(lastOpen, -1, 'gsd-review-context.md is not inside a ```bash fence of review.md (+steps)');
  const after = content.slice(lastOpen);
  const closeIdx = after.indexOf('\n```');
  assert.notEqual(closeIdx, -1, 'unterminated ```bash fence around gsd-review-context.md');
  const body = after.slice(0, closeIdx);
  // Bind the extraction to build_prompt, not just "some block that mentions the
  // file": the instructions copy is unique to this block.
  assert.ok(
    body.includes('gsd-review-instructions.md'),
    'extracted block writes gsd-review-context.md but not gsd-review-instructions.md — wrong block',
  );
  return body;
}

/** Every fenced ```bash block of review.md (+steps), for the structural row. */
function extractAllBashBlocks() {
  const content = readWorkflowCombined(REVIEW_WORKFLOW);
  const lines = content.split(/\r?\n/);
  const blocks = scanFencedBlocks(lines)
    .filter((b) => b.closeLineIdx !== -1 && (b.infoString || '').trim() === 'bash')
    .map((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'));
  assert.ok(blocks.length > 0, 'no ```bash blocks found in review.md (+steps)');
  return blocks;
}

/**
 * Temp fixture shaped like the block's real inputs: PHASE_DIR with the given
 * phase files, a fresh RUN_DIR, and the two always-copied section sources the
 * block expects from prompt assembly. cwd is a dir with no .planning/, so the
 * literal-path `[ -f .planning/... ]` guards take their absent branch.
 */
function buildFixture(phaseFiles) {
  const root = createTempDir('gsd-3300-');
  const phaseDir = path.join(root, 'phase');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(phaseDir);
  fs.mkdirSync(runDir);
  for (const [name, body] of Object.entries(phaseFiles)) {
    fs.writeFileSync(path.join(phaseDir, name), body);
  }
  fs.writeFileSync(path.join(root, 'instr.md'), 'instructions\n');
  fs.writeFileSync(path.join(root, 'roadmap.md'), 'roadmap\n');
  return {
    root,
    phaseDir,
    runDir,
    env: {
      ...process.env,
      PHASE_DIR: phaseDir,
      INSTRUCTIONS_BLOCK_FILE: path.join(root, 'instr.md'),
      ROADMAP_SECTION_FILE: path.join(root, 'roadmap.md'),
    },
  };
}

/** Fill the workflow's `{run_dir}` placeholder and stage the script in a file. */
function stageScript(shell, body, fx) {
  const scriptPath = path.join(fx.root, `block-${shell.name}.sh`);
  fs.writeFileSync(scriptPath, body.split('{run_dir}').join(fx.runDir));
  return scriptPath;
}

/** Run the block with stdin at EOF (`ignore`), bounded by PROBE_TIMEOUT_MS. */
function runBlock(shell, body, fx) {
  const scriptPath = stageScript(shell, body, fx);
  return spawnSync(shell.cmd, [scriptPath], {
    cwd: fx.root,
    env: fx.env,
    encoding: 'utf8',
    stdin: 'ignore',
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
}

/**
 * Run the block with an OPEN, unconsumed stdin pipe and a kill timer. Never
 * resolves later than STDIN_BOUND_MS. The pre-fix operand-less `cat` blocks on
 * that pipe; the fixed block never reads stdin at all, so it exits on its own.
 */
function runBlockWithOpenStdin(shell, body, fx) {
  const scriptPath = stageScript(shell, body, fx);
  return new Promise((resolve) => {
    const child = spawn(shell.cmd, [scriptPath], {
      cwd: fx.root,
      env: fx.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Close our end so an orphaned `cat` (SIGKILL kills the shell, not its
      // children) sees EOF and exits instead of outliving the test.
      child.stdin.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ timedOut: true, code: null, signal: 'SIGKILL' });
    }, STDIN_BOUND_MS);
    child.on('error', (err) => finish({ timedOut: false, error: err }));
    child.on('exit', (code, signal) => finish({ timedOut: false, code, signal }));
    // stdin is deliberately never written to and never ended.
  });
}

const readIfPresent = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

describe('#3300 build_prompt optional-section guards under nullglob', () => {
  test('extracts the build_prompt block and keeps the #2962 nullglob shim (out-of-scope guard)', () => {
    const body = extractBuildPromptBlock();
    assert.ok(body.includes('nullglob'), 'block must keep the shopt nullglob half of the #2962 shim');
    assert.ok(body.includes('NULL_GLOB'), 'block must keep the setopt NULL_GLOB half of the #2962 shim');
  });

  for (const shell of SHELLS) {
    test(`[${shell.name}] absent optional sources: no context/research output file is created at all`, (t) => {
      const fx = buildFixture({ '01-PLAN.md': 'plan\n' }); // the common case: PLAN only
      t.after(() => cleanup(fx.root));
      const res = runBlock(shell, extractBuildPromptBlock(), fx);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      // Row 1/2 of the matrix — the failing-first core. Pre-fix these exist
      // as 0-byte files (the `>` redirect creates them before cat blocks or
      // EOFs); post-fix they must not exist at all.
      assert.strictEqual(
        readIfPresent(path.join(fx.runDir, 'gsd-review-context.md')),
        null,
        'gsd-review-context.md must NOT be created when no *-CONTEXT.md exists',
      );
      assert.strictEqual(
        readIfPresent(path.join(fx.runDir, 'gsd-review-research.md')),
        null,
        'gsd-review-research.md must NOT be created when no *-RESEARCH.md exists',
      );
      // The always-on parts of the block still did their job.
      assert.strictEqual(readIfPresent(path.join(fx.runDir, 'gsd-review-plan-00.md')), 'plan\n');
    });

    test(`[${shell.name}] present optional sources: output matches the source exactly`, (t) => {
      const fx = buildFixture({
        '01-PLAN.md': 'plan\n',
        '01-CONTEXT.md': 'ctx\n',
        '01-RESEARCH.md': 'research\n',
      });
      t.after(() => cleanup(fx.root));
      const res = runBlock(shell, extractBuildPromptBlock(), fx);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      assert.strictEqual(readIfPresent(path.join(fx.runDir, 'gsd-review-context.md')), 'ctx\n');
      assert.strictEqual(readIfPresent(path.join(fx.runDir, 'gsd-review-research.md')), 'research\n');
    });

    test(`[${shell.name}] research-only phase: context output stays absent`, (t) => {
      const fx = buildFixture({ '01-PLAN.md': 'plan\n', '01-RESEARCH.md': 'research\n' });
      t.after(() => cleanup(fx.root));
      const res = runBlock(shell, extractBuildPromptBlock(), fx);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      assert.strictEqual(readIfPresent(path.join(fx.runDir, 'gsd-review-context.md')), null);
      assert.strictEqual(readIfPresent(path.join(fx.runDir, 'gsd-review-research.md')), 'research\n');
    });

    test(`[${shell.name}] multiple matches concatenate in glob order (original cat <glob> semantics)`, (t) => {
      const fx = buildFixture({
        '01-PLAN.md': 'plan\n',
        '01-CONTEXT.md': 'A\n',
        '02-CONTEXT.md': 'B\n',
      });
      t.after(() => cleanup(fx.root));
      const res = runBlock(shell, extractBuildPromptBlock(), fx);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      assert.strictEqual(readIfPresent(path.join(fx.runDir, 'gsd-review-context.md')), 'A\nB\n');
    });

    test(`[${shell.name}] open, unconsumed stdin pipe: block completes within ${STDIN_BOUND_MS}ms`, async (t) => {
      const fx = buildFixture({ '01-PLAN.md': 'plan\n' });
      t.after(() => cleanup(fx.root));
      const res = await runBlockWithOpenStdin(shell, extractBuildPromptBlock(), fx);
      assert.ok(!res.timedOut, `block blocked on stdin (killed at ${STDIN_BOUND_MS}ms) — cat ran operand-less`);
      assert.strictEqual(res.code, 0, `block exited ${res.code}${res.signal ? ` (signal ${res.signal})` : ''}`);
    });
  }

  test('structural: no `if ls` guard remains in any review.md bash fence (the idiom, not the instance)', () => {
    const offenders = [];
    for (const [i, block] of extractAllBashBlocks().entries()) {
      block.split('\n').forEach((line, j) => {
        if (/^\s*if\s+ls\s/.test(line)) offenders.push(`block ${i + 1}, line ${j + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      'review.md still guards a glob with `if ls` — under the block-level nullglob shim '
        + '(#2962) an unmatched glob leaves ls operand-less: it lists the cwd and exits 0, '
        + 'so the guard is always true and the following cat runs operand-less and reads '
        + 'stdin (#3300). Guard on the glob expansion itself instead.',
    );
  });
});

// allow-test-rule: source-text-is-the-product (see #2494)
// The Gemini and Claude reviewer dispatch blocks in gsd-core/workflows/review.md
// ARE the runtime contract — the workflow's text is what the reviewing agent
// executes. This suite extracts those two shell blocks verbatim from the
// workflow and runs them under a real bash against a failing CLI stub, so the
// shipped guard is what gets exercised rather than a reimplementation of it.
// The assertions on the produced review file are assertions on that guard's
// documented output contract (the stub line the consensus step must be able to
// tell apart from a clean empty review), not incidental string matching.

/**
 * Regression tests for #2494 — the claude and gemini reviewer legs discarded
 * stderr with no empty-output guard.
 *
 * Before the fix both blocks were `... 2>/dev/null > {run_dir}/gsd-review-<leg>.md`
 * with nothing after: a non-zero exit that wrote no stdout (CLI missing,
 * unauthenticated, rate-limited, timeout-killed, crashed) left a ZERO-BYTE
 * review file with the only diagnostic evidence — stderr — already discarded.
 * The write_reviews step then substituted that empty file into a
 * `## <Reviewer> Review` section indistinguishable from "ran cleanly, nothing
 * to report", silently degrading the advertised N-reviewer consensus to N-1.
 *
 * These tests fail against pre-fix review.md: the produced file is zero-byte,
 * so both the non-empty and the diagnosable-message assertions trip.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const REVIEW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'review.md');

// Normalize CRLF: on a Windows git-autocrlf checkout every line carries a
// trailing \r, which would leave the extracted block's shebang/redirect tokens
// mangled and defeat the fence regexes below.
const WORKFLOW = fs.readFileSync(REVIEW_PATH, 'utf-8').replace(/\r\n/g, '\n');

// This suite executes the extracted blocks with a real bash and a POSIX CLI
// stub on PATH. Gate to non-Windows, mirroring the opencode reconstruction
// suite's win32 skip — the guard logic is platform-independent and is asserted
// in full on every macOS/Linux CI leg.
const skipReason = process.platform === 'win32'
  ? 'extracted block is POSIX shell; guard logic is platform-independent and asserted on macOS/Linux'
  : false;

/**
 * Extract a reviewer dispatch block verbatim from the workflow. If review.md
 * changes the block's shape these throw and the test fails loudly — intended
 * coupling, the same contract the opencode suite pins for its jq programs.
 */
function extractBlock(headingRe, label) {
  const re = new RegExp(`${headingRe}\\n\`\`\`bash\\n([\\s\\S]*?)\\n\`\`\``);
  const m = WORKFLOW.match(re);
  assert.ok(m, `review.md must define the ${label} reviewer dispatch as a bash block (#2494)`);
  return m[1];
}

const GEMINI_BLOCK = extractBlock('\\*\\*Gemini:\\*\\*', 'Gemini');
const CLAUDE_BLOCK = extractBlock('\\*\\*Claude \\(separate session\\):\\*\\*', 'Claude');

const STUB_STDERR = 'gsd-2494-stub: command not found / not authenticated';

let sandbox;

before(() => {
  sandbox = createTempDir('gsd-2494-');
});

after(() => {
  cleanup(sandbox);
});

/**
 * Run one extracted block with `{run_dir}` pointed at a fresh run directory and
 * `stubBody` installed on PATH under the reviewer's binary name.
 *
 * Single exec site for the whole suite so the Windows guard lives in one place:
 * Git Bash (msys2) ignores Node's chmod exec bit for PATH-executed
 * extension-less scripts (DEFECT.WINDOWS-TEST-PORTABILITY), and every suite
 * below is skipped on win32 — this early return keeps the exec unreachable
 * there rather than relying on the skip alone.
 */
function runBlockWithStub({ binName, block, stubBody, env = {} }) {
  if (process.platform === 'win32') return null;

  const caseDir = fs.mkdtempSync(path.join(sandbox, 'run-'));
  const runDir = path.join(caseDir, 'run');
  const binDir = path.join(caseDir, 'bin');
  fs.mkdirSync(runDir);
  fs.mkdirSync(binDir);

  const stub = path.join(binDir, binName);
  fs.writeFileSync(stub, stubBody);
  fs.chmodSync(stub, 0o755);

  fs.writeFileSync(path.join(runDir, 'gsd-review-prompt.md'), '# review prompt\n');

  const script = block.split('{run_dir}').join(runDir);
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, ...env },
  });

  const reviewPath = path.join(runDir, `gsd-review-${binName}.md`);
  return {
    result,
    reviewPath,
    errPath: path.join(runDir, `gsd-review-${binName}.err`),
    review: fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath, 'utf-8') : null,
  };
}

/**
 * The issue's own repro harness: a CLI that writes STUB_STDERR to stderr,
 * nothing to stdout, and exits non-zero.
 */
function runLeg({ binName, block, env = {} }) {
  return runBlockWithStub({
    binName,
    block,
    stubBody: `#!/bin/sh\necho "${STUB_STDERR}" >&2\nexit 127\n`,
    env,
  });
}

/**
 * The guard's contract: the review file exists, is NOT empty, names the leg as
 * failed-or-empty, and carries the captured stderr. The last assertion is what
 * separates this fix from a bare `[ ! -s ]` stub — the evidence has to survive.
 */
function assertDiagnosable({ review, reviewPath, errPath }, legLabel) {
  assert.ok(review !== null, `${legLabel}: review file must exist after a failed lane (#2494)`);
  assert.notStrictEqual(review.trim(), '', `${legLabel}: review file must not be empty after a failed lane (#2494)`);
  assert.match(
    review,
    new RegExp(`${legLabel} review failed or returned empty output`, 'i'),
    `${legLabel}: review file must carry a diagnosable failure line, distinguishable at consensus synthesis from "ran cleanly, nothing to report" (#2494)`,
  );
  assert.ok(
    review.includes(STUB_STDERR),
    `${legLabel}: captured stderr must be appended to the review file, not discarded to /dev/null (#2494)`,
  );
  assert.ok(fs.existsSync(errPath), `${legLabel}: stderr must be captured to a .err sidecar (#2494)`);
  assert.ok(reviewPath.endsWith('.md'), `${legLabel}: review output path unchanged`);
}

describe('#2494 — gemini reviewer leg fails loudly', { skip: skipReason }, () => {
  test('a failing gemini CLI produces a diagnosable stub, not an empty file (model configured)', () => {
    const out = runLeg({ binName: 'gemini', block: GEMINI_BLOCK, env: { GEMINI_MODEL: 'gemini-test-model' } });
    assertDiagnosable(out, 'Gemini');
  });

  test('a failing gemini CLI produces a diagnosable stub, not an empty file (no model configured)', () => {
    const out = runLeg({ binName: 'gemini', block: GEMINI_BLOCK, env: { GEMINI_MODEL: '' } });
    assertDiagnosable(out, 'Gemini');
  });
});

describe('#2494 — claude reviewer leg fails loudly', { skip: skipReason }, () => {
  test('a failing claude CLI produces a diagnosable stub, not an empty file (model configured)', () => {
    const out = runLeg({
      binName: 'claude',
      block: CLAUDE_BLOCK,
      env: { CLAUDE_MODEL: 'claude-test-model', CLAUDE_EFFORT_ARGS: '' },
    });
    assertDiagnosable(out, 'Claude');
  });

  test('a failing claude CLI produces a diagnosable stub, not an empty file (no model configured)', () => {
    const out = runLeg({
      binName: 'claude',
      block: CLAUDE_BLOCK,
      env: { CLAUDE_MODEL: '', CLAUDE_EFFORT_ARGS: '' },
    });
    assertDiagnosable(out, 'Claude');
  });
});

describe('#2494 — the guard does not swallow a successful review', { skip: skipReason }, () => {
  test('gemini stdout is preserved verbatim when the CLI succeeds', () => {
    const out = runBlockWithStub({
      binName: 'gemini',
      block: GEMINI_BLOCK,
      stubBody: '#!/bin/sh\necho "## Real Review"\necho "Looks good."\nexit 0\n',
      env: { GEMINI_MODEL: '' },
    });

    const { review } = out;
    assert.ok(review !== null, 'a successful review must produce a review file (#2494)');
    assert.ok(review.includes('Looks good.'), 'a successful review must pass through untouched (#2494)');
    assert.ok(
      !/failed or returned empty output/i.test(review),
      'the stub must not fire on a non-empty review (#2494)',
    );
  });
});

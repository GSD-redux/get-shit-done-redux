// allow-test-rule: source-text-is-the-product (see #2794)
// The qwen reviewer dispatch block in gsd-core/workflows/review.md IS the runtime
// contract — the workflow's text is what the reviewing agent executes. This suite
// extracts that shell block verbatim and runs it under a real bash against a stubbed
// `qwen`, so the shipped guard is what gets exercised rather than a reimplementation
// of it. Assertions are on the guard's documented output contract (the stub line the
// consensus step must be able to tell apart from a clean empty review, and the
// presence of the captured stderr), not incidental string matching.

/**
 * Regression tests for #2794 — the qwen reviewer leg was the last one still
 * sending stderr to /dev/null.
 *
 * Every other lane captures stderr to a `.err` sidecar and appends it to the
 * empty-output stub (#2494 for claude/gemini, #2605 for the local servers and
 * CodeRabbit). qwen alone ran `2>/dev/null` and wrote a bare
 * "Qwen review failed or returned empty output." with no diagnostic, so a missing
 * binary, an auth prompt, a rate-limit, and a genuinely empty review were all
 * indistinguishable — the same cross-cutting defect landing per-leg that ADR-2782
 * exists to end.
 *
 * These tests fail against pre-fix review.md: the stub carries no stderr, so the
 * diagnostic assertion in E2 trips.
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

// Normalize CRLF: on a Windows autocrlf checkout every line carries a trailing
// \r, which would mangle the extracted block's redirect tokens and defeat the
// fence regex below.
const WORKFLOW = fs.readFileSync(REVIEW_PATH, 'utf-8').replace(/\r\n/g, '\n');

/**
 * Extract the qwen dispatch block verbatim. If review.md changes the block's
 * shape this throws and the test fails loudly — intended coupling, the same
 * contract the #2494 and #2605 suites pin for their legs.
 */
function extractQwenBlock() {
  // `\r?\n` throughout: WORKFLOW is CRLF-normalized above, but the anchors stay
  // CRLF-tolerant so the regex cannot silently miss on a Windows checkout.
  const m = WORKFLOW.match(
    /<!--\s*reviewer-lane:\s*qwen\s*-->\r?\n[\s\S]*?```bash\r?\n([\s\S]*?)\r?\n```/,
  );
  assert.ok(m, 'review.md must define the qwen reviewer dispatch as a bash block (#2794)');
  return m[1];
}

const QWEN_BLOCK = extractQwenBlock();

// The extracted block is POSIX shell. Git Bash on Windows ignores Node's chmod
// exec bit for PATH-executed extension-less scripts, so the stub would never run
// there; the guard logic is platform-independent and is asserted in full on every
// macOS/Linux leg.
const WIN32_SKIP =
  'extracted block is POSIX shell; guard logic is platform-independent and asserted on macOS/Linux';

let sandbox;

before(() => { sandbox = createTempDir('gsd-2794-'); });
after(() => { cleanup(sandbox); });

/**
 * Run the extracted block with `{run_dir}` pointed at a fresh run directory and
 * `qwenBody` installed on PATH as `qwen`. Pass `qwenBody: null` to run with no
 * qwen on PATH at all.
 */
function runQwenLeg(qwenBody) {
  // Single exec site so the Windows guard lives in one place: Git Bash (msys2)
  // ignores Node's chmod exec bit for PATH-executed extension-less scripts
  // (DEFECT.WINDOWS-TEST-PORTABILITY). Every test below is skipped on win32 —
  // this early return keeps the exec unreachable there rather than relying on
  // the skip alone.
  if (process.platform === 'win32') return null;

  const caseDir = fs.mkdtempSync(path.join(sandbox, 'run-'));
  const runDir = path.join(caseDir, 'run');
  const binDir = path.join(caseDir, 'bin');
  fs.mkdirSync(runDir);
  fs.mkdirSync(binDir);

  if (qwenBody !== null) {
    const stub = path.join(binDir, 'qwen');
    fs.writeFileSync(stub, qwenBody);
    fs.chmodSync(stub, 0o755);
  }

  fs.writeFileSync(path.join(runDir, 'gsd-review-prompt.md'), '# review prompt\n');

  const script = QWEN_BLOCK.split('{run_dir}').join(runDir);
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
    // An empty PATH would also break `cat`; prepend the stub dir instead so the
    // no-qwen case still resolves the shell builtins the block needs.
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
  });

  const reviewPath = path.join(runDir, 'gsd-review-qwen.md');
  return {
    result,
    reviewPath,
    errPath: path.join(runDir, 'gsd-review-qwen.err'),
    review: fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath, 'utf-8') : null,
  };
}

const STUB_STDERR = 'gsd-2794-stub: qwen: authentication required';

describe('qwen reviewer leg — empty-output guard (#2794)', () => {
  test('writes the review on success', { skip: process.platform === 'win32' ? WIN32_SKIP : false }, () => {
    const out = runQwenLeg('#!/bin/sh\necho "## Qwen findings"\nexit 0\n');
    assert.ok(out.review !== null, 'review file must exist');
    assert.match(out.review, /Qwen findings/);
    // A successful lane must NOT be decorated with the failure stub.
    assert.doesNotMatch(out.review, /failed or returned empty output/i);
  });

  test('a failed lane surfaces its stderr in the review stub', { skip: process.platform === 'win32' ? WIN32_SKIP : false }, () => {
    // THE regression row. Pre-fix the block ran `2>/dev/null`, so this stderr
    // was discarded and the stub carried no diagnostic at all.
    const out = runQwenLeg(`#!/bin/sh\necho "${STUB_STDERR}" >&2\nexit 1\n`);
    assert.ok(out.review !== null, 'review file must exist after a failed lane');
    assert.notStrictEqual(out.review.trim(), '', 'review file must not be empty');
    assert.match(
      out.review,
      /Qwen review failed or returned empty output/i,
      'stub must name the lane as failed-or-empty so consensus can tell it apart',
    );
    assert.ok(
      out.review.includes(STUB_STDERR),
      `stub must carry the captured stderr; got: ${JSON.stringify(out.review)}`,
    );
    assert.ok(fs.existsSync(out.errPath), 'stderr sidecar must be written');
  });

  test('a silently empty lane still produces a diagnosable stub', { skip: process.platform === 'win32' ? WIN32_SKIP : false }, () => {
    // Boundary: nothing on either stream. The stub line is the only signal, and
    // it must still be present so write_reviews does not render the lane as a
    // reviewer that ran cleanly with nothing to report.
    const out = runQwenLeg('#!/bin/sh\nexit 0\n');
    assert.ok(out.review !== null, 'review file must exist');
    assert.notStrictEqual(out.review.trim(), '', 'review file must not be zero-byte');
    assert.match(out.review, /Qwen review failed or returned empty output/i);
  });

  test('a missing qwen binary produces a diagnosable stub', { skip: process.platform === 'win32' ? WIN32_SKIP : false }, () => {
    const out = runQwenLeg(null);
    assert.ok(out.review !== null, 'review file must exist when the binary is absent');
    assert.notStrictEqual(out.review.trim(), '', 'review file must not be zero-byte');
    assert.match(out.review, /Qwen review failed or returned empty output/i);
    // The shell's own "command not found" lands in the sidecar and is appended,
    // which is the whole point of capturing instead of discarding.
    assert.ok(fs.existsSync(out.errPath), 'stderr sidecar must be written');
  });
});

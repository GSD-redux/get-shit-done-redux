// allow-test-rule: source-text-is-the-product (see #2605)
// The lm_studio and llama_cpp reviewer dispatch blocks in gsd-core/workflows/review.md
// ARE the runtime contract — the workflow's text is what the reviewing agent executes.
// This suite extracts those two shell blocks verbatim from the workflow and runs them
// under a real bash against a stubbed curl, so the shipped guard is what gets exercised
// rather than a reimplementation of it. The assertions on the produced review file are
// assertions on that guard's documented output contract (the stub line the consensus
// step must be able to tell apart from a clean empty review), not incidental string
// matching.

/**
 * Regression tests for #2605 — the lm_studio and llama_cpp reviewer legs dropped
 * empty output with no stub file, the same defect class as #2494 (claude/gemini)
 * but a worse variant.
 *
 * Before the fix both blocks ran `curl -s ... 2>/dev/null` and, when the model
 * returned empty content, wrote NOTHING to
 * `{run_dir}/gsd-review-<leg>.md` — there was no `[ ! -s … ]` stub at all. The
 * review file therefore never existed, `write_reviews` silently omitted that
 * reviewer's section, and the outcome was indistinguishable from the reviewer
 * never having been selected.
 *
 * Two distinct diagnostic holes are covered here, because an OpenAI-compatible
 * server can fail in two ways that leave evidence in different places:
 *   - transport failure (endpoint unreachable): curl writes to STDERR and exits
 *     non-zero. `-s` suppressed that error text entirely, so `-sS` is required.
 *   - application failure (HTTP 4xx/5xx): curl exits 0 and the error JSON is in
 *     the response BODY, so stderr is empty and only the body is diagnosable.
 *     The llama_cpp leg additionally piped curl straight into jq, discarding the
 *     body before anything could inspect it.
 *
 * These tests fail against pre-fix review.md: no review file is produced at all,
 * so the existence assertion trips first.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const REVIEW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'review.md');

// Normalize CRLF: on a Windows git-autocrlf checkout every line carries a
// trailing \r, which would leave the extracted block's redirect tokens mangled
// and defeat the fence regexes below.
const WORKFLOW = fs.readFileSync(REVIEW_PATH, 'utf-8').replace(/\r\n/g, '\n');

// These blocks shell out to a real `jq` (the request body is built with it).
// Gate to jq-present non-Windows hosts, mirroring the opencode reconstruction
// suite — the guard logic is platform-independent and is asserted in full on
// every macOS/Linux CI leg.
let jqAvailable = false;
try {
  execFileSync('jq', ['--version'], { stdio: 'ignore', timeout: 10000, killSignal: 'SIGKILL' });
  jqAvailable = true;
} catch { /* no jq on PATH */ }

const skipReason = process.platform === 'win32'
  ? 'extracted block is POSIX shell; guard logic is platform-independent and asserted on macOS/Linux'
  : (jqAvailable ? false : 'jq not on PATH');

/**
 * Extract a reviewer dispatch block verbatim from the workflow. If review.md
 * changes the block's shape these throw and the test fails loudly — intended
 * coupling, the same contract the #2494 suite pins for the claude/gemini legs.
 */
function extractBlock(headingRe, label) {
  // Some legs (Ollama, CodeRabbit) put an explanatory paragraph between the
  // heading and the fence, so allow non-fence content in between. The lazy
  // quantifiers take the FIRST ```bash fence after the heading, which is that
  // leg's own block.
  const re = new RegExp(`${headingRe}\\n[\\s\\S]*?\`\`\`bash\\n([\\s\\S]*?)\\n\`\`\``);
  const m = WORKFLOW.match(re);
  assert.ok(m, `review.md must define the ${label} reviewer dispatch as a bash block (#2605)`);
  return m[1];
}

const LEGS = [
  {
    key: 'lm_studio',
    label: 'LM Studio',
    budgetVar: 'LM_STUDIO_REVIEWER_BUDGET',
    block: extractBlock('\\*\\*LM Studio \\(local, OpenAI-compatible\\):\\*\\*', 'LM Studio'),
  },
  {
    key: 'llama_cpp',
    label: 'llama.cpp',
    budgetVar: 'LLAMA_CPP_REVIEWER_BUDGET',
    block: extractBlock('\\*\\*llama\\.cpp \\(local, OpenAI-compatible\\):\\*\\*', 'llama.cpp'),
  },
  // Ollama was the least diagnosable of the three local-server legs (bare `-s`,
  // stderr to /dev/null, response piped straight into jq). It emitted a stub, so
  // it never silently vanished — but it is the same family and is held to the
  // same contract here.
  {
    key: 'ollama',
    label: 'Ollama',
    budgetVar: 'OLLAMA_REVIEWER_BUDGET',
    block: extractBlock('\\*\\*Ollama \\(local, OpenAI-compatible\\):\\*\\*', 'Ollama'),
  },
];

const STUB_STDERR = 'gsd-2605-stub: curl: (7) Failed to connect to localhost';
const STUB_ERROR_BODY = '{"error":{"message":"gsd-2605-stub: model not loaded","code":503}}';

let sandbox;

before(() => { sandbox = createTempDir('gsd-2605-'); });
after(() => { cleanup(sandbox); });

/**
 * Run one extracted block with `{run_dir}` pointed at a fresh run directory and
 * `curlBody` installed on PATH as `curl`.
 *
 * `gsd_run` is deliberately NOT stubbed: every call site is
 * `$(gsd_run … || echo "<default>")`, so an absent binary takes the documented
 * default path (no prompt budget, default host, model probed from the server) —
 * which is the configuration the issue reproduces against.
 *
 * Single exec site so the Windows guard lives in one place: Git Bash (msys2)
 * ignores Node's chmod exec bit for PATH-executed extension-less scripts
 * (DEFECT.WINDOWS-TEST-PORTABILITY), and every suite below is skipped on win32 —
 * this early return keeps the exec unreachable there rather than relying on the
 * skip alone.
 */
function runLeg({ leg, curlBody, preamble = '' }) {
  if (process.platform === 'win32') return null;
  if (!jqAvailable) return null;

  const caseDir = fs.mkdtempSync(path.join(sandbox, 'run-'));
  const runDir = path.join(caseDir, 'run');
  const binDir = path.join(caseDir, 'bin');
  fs.mkdirSync(runDir);
  fs.mkdirSync(binDir);

  const stub = path.join(binDir, 'curl');
  fs.writeFileSync(stub, curlBody);
  fs.chmodSync(stub, 0o755);

  fs.writeFileSync(path.join(runDir, 'gsd-review-prompt.md'), '# review prompt\n');

  const script = preamble + leg.block.split('{run_dir}').join(runDir);
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
  });

  const reviewPath = path.join(runDir, `gsd-review-${leg.key}.md`);
  return {
    result,
    reviewPath,
    errPath: path.join(runDir, `gsd-review-${leg.key}.err`),
    review: fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath, 'utf-8') : null,
  };
}

/**
 * A curl stub. The block may call curl twice — once to probe `/v1/models` for a
 * model id, once to POST `/v1/chat/completions` — so the stub branches on the URL
 * and only applies the failure mode to the completion call.
 */
function curlStub({ completionStdout = '', completionStderr = '', exitCode = 0 }) {
  return `#!/bin/sh
for a in "$@"; do
  case "$a" in
    */v1/models) echo '{"data":[{"id":"stub-model"}]}'; exit 0 ;;
  esac
done
${completionStderr ? `echo "${completionStderr}" >&2` : ':'}
${completionStdout ? `cat <<'GSD_EOF'\n${completionStdout}\nGSD_EOF` : ':'}
exit ${exitCode}
`;
}

/**
 * The guard's contract: the review file EXISTS (the #2605 core defect — it did
 * not), is not empty, and names the leg as failed-or-empty so consensus
 * synthesis can tell it apart from "ran cleanly, nothing to report".
 */
function assertDiagnosable(out, legLabel) {
  assert.ok(out.review !== null, `${legLabel}: review file must exist after a failed lane — its absence is what write_reviews silently omitted (#2605)`);
  assert.notStrictEqual(out.review.trim(), '', `${legLabel}: review file must not be empty after a failed lane (#2605)`);
  assert.match(
    out.review,
    new RegExp(`${legLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} review failed or returned empty output`, 'i'),
    `${legLabel}: review file must carry a diagnosable failure line (#2605)`,
  );
}

for (const leg of LEGS) {
  describe(`#2605 — ${leg.label} reviewer leg fails loudly`, { skip: skipReason }, () => {
    test('an unreachable endpoint produces a diagnosable stub carrying curl stderr', () => {
      // Transport failure: curl writes to stderr and exits non-zero. `-s` alone
      // would have suppressed this text, which is why the fix uses `-sS`.
      const out = runLeg({
        leg,
        curlBody: curlStub({ completionStderr: STUB_STDERR, exitCode: 7 }),
      });

      assertDiagnosable(out, leg.label);
      assert.ok(
        out.review.includes(STUB_STDERR),
        `${leg.label}: captured stderr must be appended to the review file, not discarded to /dev/null (#2605)`,
      );
      assert.ok(
        fs.existsSync(out.errPath),
        `${leg.label}: stderr must be captured to a .err sidecar (#2605)`,
      );
    });

    test('an HTTP error body produces a diagnosable stub carrying the raw response', () => {
      // Application failure: an OpenAI-compatible server returns its error JSON in
      // the BODY and curl exits 0, so stderr is empty and only the body is
      // evidence. The llama_cpp leg used to pipe curl straight into jq, throwing
      // the body away before anything could inspect it.
      const out = runLeg({
        leg,
        curlBody: curlStub({ completionStdout: STUB_ERROR_BODY, exitCode: 0 }),
      });

      assertDiagnosable(out, leg.label);
      assert.ok(
        out.review.includes('gsd-2605-stub: model not loaded'),
        `${leg.label}: the raw response body must be preserved — it is the only evidence when curl exits 0 (#2605)`,
      );
    });

    test('an empty 200 response still produces a stub rather than no file', () => {
      // Boundary: a well-formed response whose content is the empty string. This
      // is the exact case the issue reproduces — the old code took the `else`
      // branch and wrote nothing at all.
      const out = runLeg({
        leg,
        curlBody: curlStub({
          completionStdout: '{"choices":[{"message":{"content":""}}]}',
          exitCode: 0,
        }),
      });

      assertDiagnosable(out, leg.label);
    });

    test('a whitespace-only response is treated as empty, not as a successful review', () => {
      // `[ ! -s … ]` counts BYTES, so a reply of "   " was written out and passed
      // the guard as a "successful" but vacuous review — the same
      // indistinguishable-from-success outcome the guard exists to prevent.
      // Command substitution strips trailing newlines but NOT spaces, so this
      // case is not covered by the empty-string case above.
      const out = runLeg({
        leg,
        curlBody: curlStub({
          completionStdout: '{"choices":[{"message":{"content":"   "}}]}',
          exitCode: 0,
        }),
      });

      assertDiagnosable(out, leg.label);
    });

    test('a reply that is exactly an echo option is not misclassified as empty', () => {
      // `echo "$VAR" > file` writes 0 bytes when VAR is exactly `-n`, which would
      // trip the empty guard and DISCARD a genuine reply. printf is required.
      const out = runLeg({
        leg,
        curlBody: curlStub({
          completionStdout: '{"choices":[{"message":{"content":"-n"}}]}',
          exitCode: 0,
        }),
      });

      assert.ok(out.review !== null, `${leg.label}: a reply of "-n" must still produce a review file (#2605)`);
      assert.ok(
        out.review.includes('-n'),
        `${leg.label}: a reply of "-n" must be written verbatim, not swallowed by echo's option parsing (#2605)`,
      );
      assert.ok(
        !/failed or returned empty output/i.test(out.review),
        `${leg.label}: a genuine "-n" reply must not be misclassified as empty (#2605)`,
      );
    });

    test('a budget skip leaves a visible stub rather than no file', () => {
      // The skip path sits one `if` away from the guard and dropped the lane just
      // as silently: no file, so write_reviews omitted the section entirely and
      // the only trace was a stderr warning nothing persists.
      const out = runLeg({
        leg,
        curlBody: curlStub({ completionStdout: '{"choices":[{"message":{"content":"unused"}}]}' }),
        // `gsd_run` supplies the budget, so stubbing the variable directly is
        // useless — the block's first line overwrites it. Drive the skip through
        // `gsd_run` itself: `config-get` yields a non-null budget so the trim
        // branch is entered, and `prompt-budget` returns 2 — the documented
        // "budget too small for the minimum review set" code. Stubbing only the
        // helper would not work for the Ollama leg, whose fence also carries the
        // shared `prepare_trimmed_prompt_for_reviewer` definition and so
        // overrides any stub of it.
        preamble: 'gsd_run() { case "$2" in prompt-budget) return 2 ;; esac; echo 1; }\n'
          + 'prepare_trimmed_prompt_for_reviewer() { return 2; }\n',
      });

      assert.ok(out.review !== null, `${leg.label}: a budget-skipped lane must still produce a review file (#2605)`);
      assert.match(
        out.review,
        /review skipped: prompt budget/i,
        `${leg.label}: a budget-skipped lane must say so in the review file (#2605)`,
      );
    });

    test('a successful review passes through untouched', () => {
      // The guard must not fire on real content, and must not wrap or annotate it.
      const out = runLeg({
        leg,
        curlBody: curlStub({
          completionStdout: '{"choices":[{"message":{"content":"## Real Review\\nLooks good."}}]}',
          exitCode: 0,
        }),
      });

      assert.ok(out.review !== null, `${leg.label}: a successful review must produce a review file (#2605)`);
      assert.ok(
        out.review.includes('Looks good.'),
        `${leg.label}: a successful review must pass through untouched (#2605)`,
      );
      assert.ok(
        !/failed or returned empty output/i.test(out.review),
        `${leg.label}: the stub must not fire on a non-empty review (#2605)`,
      );
    });
  });
}

describe('#2605 — the CodeRabbit leg fails loudly', { skip: skipReason }, () => {
  // CodeRabbit was the last CLI leg still shaped like pre-#2494 code:
  // `2>/dev/null > file` with no stub. A missing or unauthenticated binary left a
  // zero-byte file that write_reviews rendered as "ran cleanly, nothing to report".
  const CODERABBIT_BLOCK = extractBlock('\\*\\*CodeRabbit:\\*\\*', 'CodeRabbit');

  test('a failing coderabbit CLI produces a diagnosable stub, not a zero-byte file', () => {
    if (process.platform === 'win32') return;

    const caseDir = fs.mkdtempSync(path.join(sandbox, 'cr-'));
    const runDir = path.join(caseDir, 'run');
    const binDir = path.join(caseDir, 'bin');
    fs.mkdirSync(runDir);
    fs.mkdirSync(binDir);

    const stub = path.join(binDir, 'coderabbit');
    fs.writeFileSync(stub, `#!/bin/sh\necho "${STUB_STDERR}" >&2\nexit 127\n`);
    fs.chmodSync(stub, 0o755);

    const script = CODERABBIT_BLOCK.split('{run_dir}').join(runDir);
    spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      timeout: 30000,
      killSignal: 'SIGKILL',
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    });

    const reviewPath = path.join(runDir, 'gsd-review-coderabbit.md');
    assert.ok(fs.existsSync(reviewPath), 'CodeRabbit: review file must exist after a failed lane (#2605)');
    const review = fs.readFileSync(reviewPath, 'utf-8');
    assert.notStrictEqual(review.trim(), '', 'CodeRabbit: review file must not be zero-byte after a failed lane (#2605)');
    assert.match(
      review,
      /CodeRabbit review failed or returned empty output/i,
      'CodeRabbit: review file must carry a diagnosable failure line (#2605)',
    );
    assert.ok(
      review.includes(STUB_STDERR),
      'CodeRabbit: captured stderr must be appended, not discarded to /dev/null (#2605)',
    );
  });
});

describe('#2605 — every local-server leg uses -sS so curl errors are not suppressed', { skip: skipReason }, () => {
  test('the chat/completions call captures stderr to a sidecar instead of /dev/null', () => {
    // Pins the two changes that make the stub's evidence real rather than empty.
    // Asserted on the extracted block text because the redirect target is the
    // contract; the behavioural consequence is covered by the suites above.
    for (const leg of LEGS) {
      assert.match(
        leg.block,
        new RegExp(`curl -sS[^\\n]*\\n[^\\n]*-d @- 2>[^\\n]*gsd-review-${leg.key}\\.err`),
        `${leg.label}: the completion call must use -sS and redirect stderr to its .err sidecar (#2605)`,
      );
      assert.ok(
        !new RegExp(`curl -s --max-time 120`).test(leg.block),
        `${leg.label}: the completion call must not use bare -s, which suppresses curl's error text (#2605)`,
      );
    }
  });
});

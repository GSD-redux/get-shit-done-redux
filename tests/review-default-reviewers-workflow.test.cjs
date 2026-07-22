'use strict';

// allow-test-rule: source-text-is-the-product
// Workflow markdown is runtime contract; these assertions verify deployed behavior text.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('review workflow default reviewer selection contract (#3079)', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), 'gsd-core', 'workflows', 'review.md'),
    'utf8'
  );

  test('documents review.default_reviewers no-flag behavior', () => {
    assert.ok(
      workflow.includes('review.default_reviewers'),
      'review workflow must reference review.default_reviewers for no-flag selection'
    );
  });

  test('documents precedence order with explicit flags and --all overrides', () => {
    assert.ok(
      workflow.includes('Individual reviewer flags') &&
      workflow.includes('--all') &&
      workflow.includes('review.default_reviewers'),
      'review workflow must document precedence: flags > --all > review.default_reviewers'
    );
  });

  test('documents unknown/undetected configured slug handling', () => {
    assert.ok(
      workflow.includes('Unknown slugs warn') &&
      workflow.includes('Known-but-undetected slugs'),
      'review workflow must document unknown and undetected slug handling'
    );
  });

  test('documents failure behavior when all configured reviewers unavailable', () => {
    assert.ok(
      workflow.includes('all configured reviewers are unavailable') &&
      workflow.includes('fail'),
      'review workflow must document failure path when configured reviewers are unavailable'
    );
  });
});

describe('review workflow source-grounding requirement in build_prompt (#1318)', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), 'gsd-core', 'workflows', 'review.md'),
    'utf8'
  );

  // Extract ONLY the build_prompt Review Instructions region — the slice of the
  // assembled prompt that is actually piped to the prompt-fed reviewers. The
  // grounding instruction is worthless unless it lives HERE (#1318): asserting
  // against the whole file would still pass if the text drifted into a note,
  // the consensus step, or a comment that never reaches a reviewer's stdin.
  //
  // The region is the fenced prompt's `## Review Instructions` section, from
  // that heading up to the next `## ` heading inside the same fenced block.
  function buildPromptReviewInstructions(src) {
    // Locate the build_prompt step, then its first fenced ```markdown block.
    // NOTE: '<step name="build_prompt">' is a literal anchor — update it if the
    // step is ever renamed or gains/reorders attributes.
    const stepIdx = src.indexOf('<step name="build_prompt">');
    assert.ok(stepIdx !== -1, 'build_prompt step must exist');

    // Fence-run-aware extraction (CommonMark): a naive `indexOf('\n```')` would
    // terminate at the FIRST triple-backtick line, truncating the prompt if its
    // body embeds a fenced code example. Mirror the close rule used by
    // src/markdown-sectionizer.cts stripFencedCode: the closing fence is a line
    // of the SAME char and >= the opener's run length, with no trailing content,
    // so a shorter nested fence inside the block is treated as content (#1318).
    // Backtick-fenced only by design — the build_prompt block is ```markdown.
    const lines = src.slice(stepIdx).split('\n');
    const openRe = /^ {0,3}(`{3,})markdown\s*$/;
    let openLen = 0;
    let bodyStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = openRe.exec(lines[i].replace(/\r$/, ''));
      if (m) { openLen = m[1].length; bodyStart = i + 1; break; }
    }
    assert.ok(bodyStart !== -1, 'build_prompt must contain a ```markdown prompt block');
    const closeRe = new RegExp(`^ {0,3}\`{${openLen},}\\s*$`);
    let bodyEnd = -1;
    for (let i = bodyStart; i < lines.length; i++) {
      if (closeRe.test(lines[i].replace(/\r$/, ''))) { bodyEnd = i; break; }
    }
    assert.ok(bodyEnd !== -1, 'build_prompt markdown fence must be closed');
    const fenced = lines.slice(bodyStart, bodyEnd).join('\n');

    const hdr = fenced.indexOf('## Review Instructions');
    assert.ok(hdr !== -1, 'fenced prompt must contain a ## Review Instructions section');
    // Next top-level `## ` heading after the Review Instructions heading.
    const after = fenced.indexOf('\n## ', hdr + 1);
    return after === -1 ? fenced.slice(hdr) : fenced.slice(hdr, after);
  }

  const reviewInstructions = buildPromptReviewInstructions(workflow);

  test('instructs reviewers to verify plan claims against source and cite file:line', () => {
    // The cross-AI prompt assembled from plan text must push agentic reviewers
    // to open the referenced source and ground findings in evidence, instead of
    // paraphrasing plan text (the false-LOW failure mode in #1318). Assert the
    // instruction lives INSIDE the prompt region, not merely somewhere in file.
    assert.ok(
      reviewInstructions.includes('Verify against source') &&
      reviewInstructions.includes('check each claim against the actual code') &&
      reviewInstructions.includes('`path/to/file:line`'),
      'build_prompt Review Instructions region must require source verification + file:line evidence'
    );
  });

  test('includes a graceful-degradation clause for reviewers without file access', () => {
    // Prompt-only reviewers (ollama / lm_studio / llama.cpp) must flag that they
    // could not verify rather than asserting an unverified finding — and this
    // clause must sit WITHIN the prompt region so reviewers actually receive it.
    assert.ok(
      reviewInstructions.includes('If you cannot read the repo (no file access)') &&
      reviewInstructions.includes('downgrade that finding to an open question'),
      'build_prompt Review Instructions region must degrade gracefully for prompt-only reviewers'
    );
  });

  test('#1318: prompt extraction is fence-run-aware — a nested code fence does not truncate it', () => {
    // Regression guard for the fenceClose hardening. The feature feeds source/plan
    // content (which routinely contains code fences) into the prompt; a naive
    // first-`\n```` close scan would stop at a nested fence and drop everything
    // after it — including the `## Review Instructions` section — yielding a
    // spurious failure or false pass. A 4-backtick outer fence must extract in
    // full past a nested 3-backtick block.
    const synthetic = [
      '<step name="build_prompt">',
      '````markdown',
      '# Prompt',
      'Example for reviewers:',
      '```bash',
      'echo hi',
      '```',
      '## Review Instructions',
      '- Verify against source and cite `path/to/file:line`.',
      '````',
      '</step>',
    ].join('\n');
    const extracted = buildPromptReviewInstructions(synthetic);
    assert.match(extracted, /## Review Instructions/);
    assert.match(extracted, /cite `path\/to\/file:line`/);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-687-agy-timeout.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-687-agy-timeout (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #687)
// review.md is a workflow file whose deployed text IS the runtime contract; the
// agy -p invocation cannot be run in CI, so we assert on its content (issue #687).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reviewPath = path.resolve(__dirname, '..', 'gsd-core', 'workflows', 'review.md');
const read = () => fs.readFileSync(reviewPath, 'utf-8');

describe('bug #687 → #2073: agy print mode bounded by --print-timeout PAIRED with an external timeout', () => {
  // #687 established that agy print mode must be bounded (its native
  // --print-timeout, default 5m). #2073 superseded the "no external killer"
  // half of that contract with documentation:
  //   - agy's own print-mode guidance says to PAIR --print-timeout with an
  //     external terminal `timeout` ("Pair with the terminal timeout= so the
  //     outer call doesn't cut the run short"), because --print-timeout cannot
  //     fire before agy creates a session (a pre-session stall otherwise hangs
  //     unbounded). The external cap is set HIGHER than --print-timeout so it
  //     only backstops a stall, never cuts a healthy run.
  //   - agy gained `--model` in ~1.0.3 (issue #3782's "no --model flag" note
  //     was correct at the time, stale now); review.models.agy is passed as
  //     --model so a pinned model that 404s has an escape hatch.
  //   - the prompt is now a file reference: inline `-p "$(cat …)"` overflows
  //     the exec arg list on a large review prompt (Linux MAX_ARG_STRLEN
  //     128 KB/single-arg → rc 126).

  test('invokes agy with --print-timeout AND a paired external killer when available', () => {
    const c = read();
    assert.match(c, /--print-timeout \d+s?/, 'review.md must pass agy its native --print-timeout');
    // Capability probe for GNU `timeout` / macOS `gtimeout` (stock macOS has neither).
    assert.match(c, /command -v timeout/, 'review.md must probe for the `timeout` killer');
    assert.match(c, /command -v gtimeout/, 'review.md must probe for `gtimeout` (macOS Homebrew)');
    // The external cap (600s) is applied ahead of agy and is >= --print-timeout (540s).
    assert.match(c, /600 agy --print-timeout 540s/,
      'review.md must pair an external cap (600s) >= --print-timeout (540s) with agy (agy guidance)');
  });

  test('external cap is >= --print-timeout, and falls back to bare agy on macOS', () => {
    const c = read();
    const bound = c.match(/(\d+)\s+agy --print-timeout (\d+)s/);
    assert.ok(bound, 'review.md must encode the external-cap + --print-timeout pair');
    assert.ok(
      Number(bound[1]) >= Number(bound[2]),
      'external cap (seconds) must be >= --print-timeout (seconds) so it only backstops a stall',
    );
    // Graceful fallback when no external killer is available (stock macOS).
    assert.match(c, /else\n\s*agy --print-timeout/,
      'review.md must fall back to --print-timeout alone when no external killer is available (macOS)');
  });

  test('uses a file-reference prompt, not inline "$(cat …)" (arg-list overflow, #2073)', () => {
    const c = read();
    assert.doesNotMatch(c, /agy[^\n]*-p "\$\(cat/,
      'review.md must not feed agy the prompt inline via "$(cat …)" — a large review prompt overflows the exec arg list (rc 126)');
    assert.match(c, /Read the file at \{run_dir\}\/gsd-review-prompt\.md/,
      'review.md should pass agy a file-reference prompt (mirrors the Cursor block)');
  });

  test('wires --model from review.models.agy (#2073 mode 2; agy gained --model in ~1.0.3)', () => {
    assert.match(read(), /--model "\$AGY_MODEL"/,
      'review.md must pass --model "$AGY_MODEL" when review.models.agy is set');
  });

  test('discards partial output on non-zero exit so the fallback fires (#687)', () => {
    const c = read();
    assert.match(c, /_AGY_RC.*-ne 0/, 'review.md must check the agy exit code');
    assert.match(c, /: > \{run_dir\}\/gsd-review-antigravity\.md/,
      'review.md must truncate the output file when agy timed out / failed');
  });

  test('no unguarded bare "agy -p" invocation remains at line start', () => {
    // A bare `agy -p …` with no cap was the original #687 hang.
    assert.doesNotMatch(read(), /^agy -p/m,
      'review.md must not invoke a bare `agy -p` unbounded at line start');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-773-codex-exec-automation-flags.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-773-codex-exec-automation-flags (consolidation epic #1969 B4 #1973)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #773)
// Workflow markdown is runtime contract; these assertions verify that
// automated codex exec invocations carry the correct automation flags.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('enh-773: automated codex exec invocations include --ephemeral (hook-trust bypass dropped by #2479)', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), 'gsd-core', 'workflows', 'review.md'),
    'utf8'
  );

  // Extract codex exec INVOCATION lines from code fences. A `codex exec --help`
  // capability probe would not be an automation invocation, so keep it excluded
  // from the per-invocation flag assertions below (#2479 asserts no such probe
  // exists at all).
  const codexExecLines = workflow
    .split(/\r?\n/)
    .filter((line) => line.includes('codex exec') && !line.includes('codex exec --help'));

  test('review.md contains at least one codex exec invocation', () => {
    assert.ok(
      codexExecLines.length > 0,
      'review.md must contain at least one codex exec invocation'
    );
  });

  test('every codex exec invocation includes --ephemeral', () => {
    for (const line of codexExecLines) {
      assert.ok(
        line.includes('--ephemeral'),
        `codex exec invocation is missing --ephemeral:\n  ${line.trim()}`
      );
    }
  });

  test('#2479: no hook-trust bypass — flag and capability probe are both absent', () => {
    // The flag only bypasses *persisted* hook trust (a first-run condition) and
    // flagless invocations work in steady state, while host-harness safety
    // classifiers deny commands carrying it — and cited the probe itself as
    // intent. Inverts the former #1115 gating contract: instead of probe + gated
    // $CODEX_BYPASS_FLAG, the workflow must be free of the literal flag string
    // ANYWHERE in the file — not just on invocation lines — so a line
    // continuation, a renamed carrier variable, or a probe grepping for it are
    // all caught by the same assertion. (The #2479 prose note deliberately
    // describes the flag without spelling it out, keeping the file-wide ban
    // clean.)
    assert.ok(
      !workflow.includes('--dangerously-bypass-hook-trust'),
      'review.md must not contain --dangerously-bypass-hook-trust anywhere (#2479 — file-wide ban covers invocations, continuations, carrier variables, and probes)'
    );
    assert.ok(
      !workflow.includes('CODEX_BYPASS_FLAG'),
      'review.md must not interpolate a $CODEX_BYPASS_FLAG variable (#2479)'
    );
    assert.ok(
      !/codex[^\r\n]*--help[^\r\n]*grep/.test(workflow),
      'review.md must not capability-probe codex flags via `codex --help | grep` (#2479 — the probe itself feeds harness safety classifiers)'
    );
  });

  test('#1115: codex review failures are surfaced, not silently swallowed', () => {
    // stderr must be captured (not discarded to /dev/null) and an empty output
    // must be replaced with a diagnostic, so a broken reviewer is reported.
    for (const line of codexExecLines) {
      assert.ok(
        !line.includes('2>/dev/null'),
        `codex exec must not discard stderr to /dev/null:\n  ${line.trim()}`
      );
    }
    assert.ok(
      /\[ ! -s \{run_dir\}\/gsd-review-codex\.md \]/.test(workflow),
      'review.md must guard against an empty codex review output and surface the failure'
    );
  });

  test('--ephemeral appears before the prompt argument (flag ordering)', () => {
    for (const line of codexExecLines) {
      const ephemeralPos = line.indexOf('--ephemeral');
      const promptPos = line.indexOf(' - ');
      if (promptPos === -1) continue; // no stdin prompt arg on this line
      assert.ok(
        ephemeralPos < promptPos,
        `--ephemeral must appear before the stdin prompt argument:\n  ${line.trim()}`
      );
    }
  });

  test('--skip-git-repo-check is preserved alongside automation flags', () => {
    for (const line of codexExecLines) {
      assert.ok(
        line.includes('--skip-git-repo-check'),
        `codex exec invocation lost --skip-git-repo-check:\n  ${line.trim()}`
      );
    }
  });
});

describe('#1698 regression: codex review is captured via --output-last-message, not stdout', () => {
  // WHY: on some platforms (Windows) `codex exec` writes process-teardown output
  // to stdout *after* the final agent message. A `> FILE` stdout redirect appends
  // that noise to a non-empty file, so it slips past the `[ ! -s … ]` empty-output
  // guard and downstream consumers (severity extraction, the
  // plan-review-convergence "concerns resolved?" gate) parse a polluted review.
  // `-o/--output-last-message <FILE>` writes only the final message — robust on
  // every platform — so each codex invocation must capture via -o and discard stdout.
  const workflow = fs.readFileSync(
    path.join(process.cwd(), 'gsd-core', 'workflows', 'review.md'),
    'utf8'
  );
  const codexExecLines = workflow
    .split(/\r?\n/)
    .filter((line) => line.includes('codex exec') && !line.includes('codex exec --help'));

  test('every codex exec invocation captures the review via -o <FILE>', () => {
    for (const line of codexExecLines) {
      assert.ok(
        /\s-o\s+\{run_dir\}\/gsd-review-codex\.md\b/.test(line),
        `codex exec invocation must capture the review via -o {run_dir}/gsd-review-codex.md:\n  ${line.trim()}`
      );
    }
  });

  test('no codex exec invocation redirects stdout into the review file', () => {
    for (const line of codexExecLines) {
      assert.ok(
        !/>\s*\{run_dir\}\/gsd-review-codex\.md\b/.test(line),
        `codex exec must not redirect stdout into the review file (teardown noise pollutes it); use -o + >/dev/null:\n  ${line.trim()}`
      );
      assert.ok(
        />\s*\/dev\/null\b/.test(line),
        `codex exec must discard stdout to /dev/null so teardown output is not captured:\n  ${line.trim()}`
      );
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// #1936: OpenCode reviewer must not silently yield an empty review
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('#1936: OpenCode reviewer empty-output hardening', () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #1936)
// review.md is a workflow file whose embedded bash IS the runtime contract; the
// `opencode run` invocation on a large agentic prompt cannot be run in CI, so we
// assert on its content.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reviewPath = path.resolve(__dirname, '..', 'gsd-core', 'workflows', 'review.md');
const read = () => fs.readFileSync(reviewPath, 'utf-8');

// Isolate the base OpenCode reviewer block (heading -> next reviewer heading) so
// assertions about its stderr handling don't accidentally match sibling reviewers
// (gemini/claude/coderabbit/qwen legitimately use /dev/null).
function openCodeBlock() {
  const c = read();
  const start = c.indexOf('**OpenCode (via GitHub Copilot):**');
  assert.notStrictEqual(start, -1, 'review.md must contain the base OpenCode reviewer block');
  const rest = c.slice(start + 1);
  const nextHeading = rest.search(/\n\*\*[A-Z][^\n]*:\*\*/);
  return nextHeading === -1 ? c.slice(start) : c.slice(start, start + 1 + nextHeading);
}

describe('bug #1936: OpenCode reviewer must not silently yield an empty review', () => {
  test('captures opencode stderr to a sidecar, never /dev/null', () => {
    const block = openCodeBlock();
    assert.match(block, /opencode run [^\n]*2>\{run_dir\}\/gsd-review-opencode\.err/,
      'the opencode invocation must send stderr to a .err sidecar so failures are diagnosable');
    assert.doesNotMatch(block, /opencode run [^\n]*2>\/dev\/null/,
      'the opencode invocation must not discard stderr to /dev/null (#1936)');
  });

  test('requests structured JSON output and reconstructs review from assistant text parts', () => {
    const block = openCodeBlock();
    assert.match(block, /opencode run [^\n]*--format json/,
      'must invoke opencode with --format json so assistant text parts are recoverable');
    assert.match(block, /select\(\.type=="text"\)\s*\|\s*\.part\.text/,
      'must extract the assistant text parts via `.part.text` from the JSON event stream');
  });

  test('gates the empty-review stub on extracted CONTENT, not output-file size', () => {
    // An empty jq extraction still writes a trailing newline, so a `[ -s file ]`
    // check would treat a content-less review as populated and skip the stub. The
    // block must test the captured text variable instead.
    const block = openCodeBlock();
    assert.match(block, /OPENCODE_REVIEW=\$\(jq/, 'must capture the extraction into a variable');
    assert.match(block, /\[ -n "\$OPENCODE_REVIEW" \]/,
      'must branch on the content of $OPENCODE_REVIEW, not on the size of the .md file');
    assert.doesNotMatch(block, /\[ ! -s \{run_dir\}\/gsd-review-opencode\.md \]/,
      'must not gate the stub on `[ ! -s ...opencode...md ]` (a lone newline defeats it)');
  });

  test('empty-output stub is diagnosable: references #1936, stop reason/tokens, and stderr', () => {
    const block = openCodeBlock();
    assert.match(block, /#1936/, 'the empty-output stub must reference the issue');
    assert.match(block, /step_finish[\s\S]*\.part\.reason[\s\S]*\.part\.tokens\.output/,
      'the stub must surface the stop reason and output-token count from the final step_finish');
    assert.match(block, /cat \{run_dir\}\/gsd-review-opencode\.err/,
      'the stub must append the captured stderr');
  });

  test('does not regress the Codex reviewer block (still captures stderr to .err)', () => {
    // #1936 changes only the OpenCode block; the Codex block's existing
    // stderr-to-sidecar contract must remain intact.
    assert.match(read(), /codex exec [^\n]*2>\{run_dir\}\/gsd-review-codex\.err/,
      'the Codex reviewer block must be left unchanged');
  });
});

  });
}

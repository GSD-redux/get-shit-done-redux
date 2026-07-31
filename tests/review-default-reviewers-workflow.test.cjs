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

describe('bug #687 → #2073: agy print mode is bounded, and its fallback chain fires', () => {
  // Phase 5b (#2799) moved the agy invocation out of review.md's bash into the declared lane plus
  // the named `antigravity` handler, so these assertions follow it.
  //
  // ONE INVARIANT DELIBERATELY CHANGED. The old contract was "--print-timeout PAIRED with an
  // external timeout/gtimeout killer, falling back to bare agy on macOS". That fallback WAS the
  // bug: stock macOS ships neither killer, so the lane ran unbounded there — and --print-timeout
  // cannot fire before agy creates a session (#2073 mode 3), which is the whole reason a second
  // bound existed. spawnSync's native timeout is always available, so the outer bound is now
  // unconditional on every platform. Strictly stronger; only the mechanism changed.
  const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
  const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
  const { runLane } = require('../gsd-core/bin/lib/review-lane-runner.cjs');
  const lane = REVIEWER_LANES.find((l) => l.slug === 'antigravity');
  const planFor = () => {
    const r = resolveLanePlan({ lane, configGet: (k) => ({ 'review.models.agy': 'agy-m' })[k], runDir: '/run', repoRoot: '/repo' });
    assert.equal(r.ok, true);
    return r.plan;
  };

  test('keeps its native --print-timeout AND carries an unconditional outer bound', () => {
    const argv = planFor().argv;
    const i = argv.indexOf('--print-timeout');
    assert.notEqual(i, -1, 'the tool-native inner bound must survive');
    assert.match(argv[i + 1], /^\d+s$/);
    assert.ok(lane.timeoutFloorMs > 0, 'and an outer wall-clock bound must be declared');
  });

  test('the outer bound is larger than the inner one, so it only backstops', () => {
    const argv = planFor().argv;
    const innerSec = parseInt(argv[argv.indexOf('--print-timeout') + 1], 10);
    assert.ok(lane.timeoutFloorMs / 1000 > innerSec,
      'the outer cap must not pre-empt a healthy run bounded by --print-timeout');
  });

  test('uses a file-reference prompt, not inline "$(cat …)" (arg-list overflow, #2073)', () => {
    assert.equal(lane.invoke.promptChannel, 'argv-file-ref');
    const last = planFor().argv.slice(-1)[0];
    assert.ok(last.includes('/run/gsd-review-prompt.md'));
    assert.ok(last.length < 1000, 'the reference must never carry the prompt body');
  });

  test('wires --model from review.models.agy (#2073 mode 2)', () => {
    assert.equal(lane.modelConfigKey, 'review.models.agy');
    const argv = planFor().argv;
    assert.equal(argv[argv.indexOf('--model') + 1], 'agy-m');
  });

  test('discards partial output on non-zero exit so the fallback fires (#687)', async () => {
    const p = planFor();
    const files = {};
    const d = {
      files,
      spawn: () => ({ status: 124, stdout: 'PARTIAL GARBAGE', stderr: '' }),
      httpJson: async () => ({ ok: true, status: 200, body: '{}' }),
      readFile: (x) => { if (!(x in files)) throw new Error('ENOENT'); return files[x]; },
      writeFile: (x, c) => { files[x] = c; },
      exists: (x) => x in files,
      hasBinary: () => true,
      configGet: () => undefined,
      homeDir: '/home/u',
      warn: () => {},
    };
    await runLane(p, d, { repoRoot: '/repo' });
    assert.ok(!files[p.reviewPath].includes('PARTIAL GARBAGE'),
      'a non-zero exit must discard stdout so the transcript fallback and diagnostic can take over');
    assert.ok(files[p.reviewPath].includes('failed or returned empty output'));
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
  // Declared in the lane now rather than grepped out of review.md's bash lines.
  const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
  const codex = REVIEWER_LANES.find((l) => l.slug === 'codex');
  const args = codex.invoke.args.join(' ');

  test('the codex lane uses the exec subcommand', () => {
    assert.ok(args.includes('exec'));
    assert.equal(codex.invoke.args[0], 'exec', 'exec is a SUBCOMMAND and must come first');
  });

  test('codex exec is --ephemeral', () => {
    assert.ok(args.includes('--ephemeral'));
  });

  test('no hook-trust bypass flag is emitted (#2479)', () => {
    assert.ok(!/dangerously|bypass/i.test(args),
      'host-harness safety classifiers deny commands carrying it; a genuine untrusted-hook prompt '
      + 'surfaces through the .err capture and the empty-output stub instead');
  });

  test('#1115: codex review failures are surfaced, not silently swallowed', () => {
    assert.equal(codex.emptyOutput, 'stub-with-stderr',
      'a failed codex run must produce a diagnosable stub carrying its stderr');
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

describe('bug #1936: OpenCode reviewer must not silently yield an empty review', () => {
  // The agent can end its turn with ZERO output tokens, and `--format default` then drops the
  // assistant text entirely. Phase 5b (#2799) made the reconstruction a named first-party handler
  // rather than a jq pipeline in bash, so these assertions are behavioural over that handler.
  const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
  const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
  const { handleOpencodeOutput } = require('../gsd-core/bin/lib/review-lane-runner.cjs');
  const NL = String.fromCharCode(10);
  const lane = REVIEWER_LANES.find((l) => l.slug === 'opencode');

  test('captures opencode stderr to a sidecar, never /dev/null', () => {
    const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: '/run', repoRoot: '/repo' });
    assert.equal(r.ok, true);
    assert.ok(r.plan.errPath.endsWith('.err'));
    assert.notEqual(r.plan.errPath, '/dev/null');
  });

  test('requests structured JSON output and reconstructs from assistant text parts', () => {
    assert.ok(lane.invoke.args.join(' ').includes('--format json'),
      '--format json is the PRIMARY invocation, not a fallback');
    assert.equal(lane.handler, 'opencode', 'reconstruction cannot be expressed as data');
    const stream = [
      JSON.stringify({ type: 'text', part: { text: 'part one' } }),
      JSON.stringify({ type: 'text', part: { text: 'part two' } }),
    ].join(NL);
    assert.equal(handleOpencodeOutput(stream).review, ['part one', 'part two'].join(NL));
  });

  test('gates the empty-review stub on extracted CONTENT, not output-file size', () => {
    // A JSON stream with no assistant text is many BYTES but zero review.
    const noText = JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: { output: 0 } } });
    assert.ok(noText.length > 0, 'the raw stream is non-empty by byte count');
    assert.equal(handleOpencodeOutput(noText).review, '', 'yet the extracted review is empty');
  });

  test('empty-output stub is diagnosable: stop reason and output tokens', () => {
    const stream = JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: { output: 0 } } });
    const out = handleOpencodeOutput(stream);
    assert.ok(out.diagnostic.includes('stop'), 'the stop reason must be surfaced');
    assert.ok(out.diagnostic.includes('0'), 'the output-token count must be surfaced');
  });

  test('does not regress the Codex reviewer (still captures stderr to .err)', () => {
    const codex = REVIEWER_LANES.find((l) => l.slug === 'codex');
    const r = resolveLanePlan({ lane: codex, configGet: () => undefined, runDir: '/run', repoRoot: '/repo' });
    assert.ok(r.plan.errPath.endsWith('.err'));
    assert.equal(r.plan.outputTarget.kind, 'file', 'codex still captures via --output-last-message (#1698)');
  });
});

  });
}

'use strict';

/**
 * Failing-first tests for #3034 (opt-in parallel reviewer lanes).
 *
 * Design:      .gsd/phase/feat-3034-parallel-reviewer-lanes/40-design.md
 * Test matrix: .gsd/phase/feat-3034-parallel-reviewer-lanes/50-test-matrix.md
 *
 * The unit under test is the real, shipped `<step name="invoke_reviewers">`
 * fenced bash block in gsd-core/workflows/review.md — extracted and EXECUTED
 * (never re-typed), with the single I/O seam `gsd_run` replaced by a shell
 * function stub. The feature this file exercises (an opt-in
 * `review.parallel_lanes` config key that backgrounds lane dispatch and
 * joins before aggregation) does not exist yet, so several tests below are
 * expected to be RED against the current shipped block.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createTempDir,
  createTempProject,
  cleanup,
  readFileNormalized,
  runGsdTools,
} = require('./helpers.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { toPosixPath } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const REVIEW_MD_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'review.md');

const SELECTED_3 = 'codex,gemini,claude';

// ─── extraction (source-text-is-the-product) ──────────────────────────────

/**
 * Reads review.md and extracts the fenced bash block inside
 * `<step name="invoke_reviewers">`. Mirrors extractCwdGuardBash() in
 * tests/worktree-cleanup.test.cjs: readFileNormalized() strips CRLF at the
 * read boundary (what actually makes the captured body safe to hand to
 * bash); the `\r?\n` in the fence regex below is redundant on that
 * already-normalized input but kept anyway because a bare `\n` in a
 * markdown-fence-shaped regex trips the local/no-crlf-fragile-split rule.
 */
function extractInvokeReviewersBash() {
  const content = readFileNormalized(REVIEW_MD_PATH);

  const stepMarker = '<step name="invoke_reviewers">';
  const stepIdx = content.indexOf(stepMarker);
  if (stepIdx === -1) {
    throw new Error(`extractInvokeReviewersBash: could not find "${stepMarker}" in ${REVIEW_MD_PATH}`);
  }
  const afterStep = content.slice(stepIdx + stepMarker.length);

  const endMarker = '</step>';
  const endIdx = afterStep.indexOf(endMarker);
  if (endIdx === -1) {
    throw new Error(`extractInvokeReviewersBash: could not find closing "${endMarker}" after invoke_reviewers in ${REVIEW_MD_PATH}`);
  }
  const stepBody = afterStep.slice(0, endIdx);

  const stepBodyLines = stepBody.split(/\r?\n/);
  const fenced = scanFencedBlocks(stepBodyLines).find(
    (b) => b.closeLineIdx !== -1 && ['bash', 'sh'].includes((b.infoString || '').trim()),
  );
  if (!fenced) {
    throw new Error(`extractInvokeReviewersBash: no \`\`\`bash fence found inside invoke_reviewers step in ${REVIEW_MD_PATH}`);
  }
  const block = stepBodyLines.slice(fenced.openLineIdx + 1, fenced.closeLineIdx).join('\n');

  if (!block.trim()) {
    throw new Error('extractInvokeReviewersBash: extracted bash block is empty');
  }
  if (!block.includes('review-lane invoke')) {
    throw new Error('extractInvokeReviewersBash: extracted block does not contain "review-lane invoke" — anchor may have drifted');
  }
  if (!block.includes('SELECTED_REVIEWERS')) {
    throw new Error('extractInvokeReviewersBash: extracted block does not contain "SELECTED_REVIEWERS" — anchor may have drifted');
  }

  return block;
}

// ─── stub preamble ─────────────────────────────────────────────────────────
//
// The ONLY I/O seam the extracted block calls is `gsd_run`. Everything else
// executed by runDispatch() is the real shipped shell text. `barrier` is the
// positive, deterministic concurrency proof this suite uses in place of any
// elapsed-time assertion (CLAUDE.md bans wall-clock assertions).

const STUB_PREAMBLE = [
  'arg_after() {',
  '  local flag="$1"; shift',
  '  while [ $# -gt 0 ]; do',
  '    if [ "$1" = "$flag" ]; then',
  '      printf %s "$2"',
  '      return 0',
  '    fi',
  '    shift',
  '  done',
  '}',
  '',
  'in_list() {',
  '  local needle="$1" list="$2" item old_ifs="$IFS"',
  '  IFS=","',
  '  for item in $list; do',
  '    if [ "$item" = "$needle" ]; then',
  '      IFS="$old_ifs"',
  '      return 0',
  '    fi',
  '  done',
  '  IFS="$old_ifs"',
  '  return 1',
  '}',
  '',
  'dep_of() {',
  '  local slug="$1" pair old_ifs="$IFS"',
  '  IFS=","',
  '  for pair in $STUB_DEPS; do',
  '    case "$pair" in',
  '      "$slug="*)',
  '        printf %s "${pair#*=}"',
  '        IFS="$old_ifs"',
  '        return 0',
  '        ;;',
  '    esac',
  '  done',
  '  IFS="$old_ifs"',
  '}',
  '',
  'wait_for_file() {',
  '  local target="$1" i=0',
  '  while [ ! -f "$target" ] && [ "$i" -lt 200 ]; do',
  '    sleep 0.05',
  '    i=$((i + 1))',
  '  done',
  '}',
  '',
  'barrier() {',
  '  local slug="$1" i=0 count',
  '  touch "$BARRIER_DIR/$slug"',
  '  count=$(ls -1 "$BARRIER_DIR" | wc -l)',
  '  while [ "$count" -lt "$LANE_COUNT" ] && [ "$i" -lt 200 ]; do',
  '    sleep 0.05',
  '    i=$((i + 1))',
  '    count=$(ls -1 "$BARRIER_DIR" | wc -l)',
  '  done',
  '  if [ "$count" -lt "$LANE_COUNT" ]; then',
  '    echo "barrier-timeout:$slug" >> "$TRACE"',
  '    return 1',
  '  fi',
  '  return 0',
  '}',
  '',
  'gsd_run() {',
  '  if [ "$1" = "query" ] && [ "$2" = "config-get" ] && [ "$3" = "review.parallel_lanes" ]; then',
  '    if [ "$STUB_CONFIG_GET_FAILS" = "1" ]; then',
  '      return 1',
  '    fi',
  '    printf %s "$STUB_PARALLEL"',
  '    return 0',
  '  fi',
  '',
  '  if [ "$1" = "query" ] && [ "$2" = "review-lane" ] && [ "$3" = "plan" ]; then',
  '    shift 3',
  '    local sel',
  '    sel="$(arg_after --selected "$@")"',
  '    if in_list "$sel" "$STUB_BUDGET_FAIL"; then',
  '      printf %s \'{"promptBudget": 10}\'',
  '    else',
  '      printf %s \'{"promptBudget": -1}\'',
  '    fi',
  '    return 0',
  '  fi',
  '',
  '  if [ "$1" = "query" ] && [ "$2" = "prompt-budget" ]; then',
  '    shift 2',
  '    local out base slug',
  '    out="$(arg_after --output-prompt "$@")"',
  '    base="$(basename "$out")"',
  '    slug="${base#gsd-review-prompt-}"',
  '    slug="${slug%.md}"',
  '    if in_list "$slug" "$STUB_BUDGET_FAIL"; then',
  '      return 2',
  '    fi',
  '    : > "$out"',
  '    return 0',
  '  fi',
  '',
  '  if [ "$1" = "query" ] && [ "$2" = "review-lane" ] && [ "$3" = "invoke" ]; then',
  '    shift 3',
  '    local slug dep pad',
  '    slug="$(arg_after --slug "$@")"',
  '    echo "start:$slug" >> "$TRACE"',
  '    if [ "$STUB_BARRIER" = "1" ]; then',
  '      barrier "$slug" || true',
  '    fi',
  '    dep="$(dep_of "$slug")"',
  '    if [ -n "$dep" ]; then',
  '      wait_for_file "$RUN_DIR/done-$dep"',
  '    fi',
  '    echo "stub review body for $slug" > "$RUN_DIR/gsd-review-$slug.md"',
  '    pad=""',
  '    if [ "$STUB_PAD_BYTES" -gt 0 ] 2>/dev/null; then',
  '      pad="$(head -c "$STUB_PAD_BYTES" /dev/zero | tr "\\0" "x")"',
  '    fi',
  '    if ! in_list "$slug" "$STUB_SILENT"; then',
  '      printf \'{"slug":"%s","pad":"%s"}\\n\' "$slug" "$pad"',
  '    fi',
  // #3689: the done-file is a cross-process happens-before edge — a
  // dependent lane unblocks the instant this file appears (wait_for_file
  // above just polls for its existence), so everything a dependent may
  // observe (the "end:$slug" trace line) must be written BEFORE the file
  // that releases it. touch-then-echo let a descheduled upstream lose the
  // race to its own dependent, inverting the #3034 completion-order trace.
  '    echo "end:$slug" >> "$TRACE"',
  '    touch "$RUN_DIR/done-$slug"',
  '    if in_list "$slug" "$STUB_FAIL"; then',
  '      return 1',
  '    fi',
  '    return 0',
  '  fi',
  '',
  '  return 0',
  '}',
].join('\n');

// ─── dispatch runner ───────────────────────────────────────────────────────

/**
 * Build the stub env for a runDispatch() call from `opts`. Every key is
 * always present (never omitted) so the generated `set -u` script never
 * dereferences an unset variable — `opts.parallel === null` deliberately
 * maps to the empty string, which is exactly how an unset config key reads
 * back through `config-get --raw`.
 */
function buildEnv(opts, runDir, tracePath, barrierDir) {
  const selected = opts.selected;
  const laneCount = selected.split(',').filter((s) => s.length > 0).length;
  const deps = opts.deps || {};
  return {
    ...process.env,
    SELECTED_REVIEWERS: selected,
    EXPLICIT_FLAG: '',
    STUB_PARALLEL: opts.parallel === null || opts.parallel === undefined ? '' : opts.parallel,
    STUB_CONFIG_GET_FAILS: opts.configGetFails ? '1' : '0',
    STUB_FAIL: (opts.failSlugs || []).join(','),
    STUB_BUDGET_FAIL: (opts.budgetFailSlugs || []).join(','),
    STUB_SILENT: (opts.silentSlugs || []).join(','),
    STUB_BARRIER: opts.barrier ? '1' : '0',
    STUB_DEPS: Object.entries(deps).map(([k, v]) => `${k}=${v}`).join(','),
    STUB_PAD_BYTES: String(opts.padBytes || 0),
    LANE_COUNT: String(laneCount),
    TRACE: tracePath,
    BARRIER_DIR: barrierDir,
  };
}

/**
 * Runs the real extracted invoke_reviewers bash block with the gsd_run stub
 * spliced in front of it. `{run_dir}` is replaced globally with a real temp
 * directory. Returns the dispatch outcome plus the artifacts it produced.
 */
function runDispatch(t, opts) {
  const scriptDir = createTempDir('gsd-3034-script-');
  const runDir = createTempDir('gsd-3034-rundir-');
  const barrierDir = createTempDir('gsd-3034-barrier-');
  t.after(() => {
    cleanup(scriptDir);
    cleanup(runDir);
    cleanup(barrierDir);
  });

  const block = extractInvokeReviewersBash();
  const tracePath = path.join(scriptDir, 'trace.log');
  const env = buildEnv(opts, runDir, tracePath, barrierDir);

  const scriptPath = path.join(scriptDir, 'dispatch.sh');
  const script = [
    '#!/usr/bin/env bash',
    'set -u',
    STUB_PREAMBLE,
    block.split('{run_dir}').join(runDir),
  ].join('\n');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  const result = runHook(scriptPath, [], {
    interpreter: 'bash',
    cwd: runDir,
    env,
    timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
  });

  const jsonlPath = path.join(runDir, 'gsd-review-lane-results.jsonl');
  const jsonl = fs.existsSync(jsonlPath) ? fs.readFileSync(jsonlPath, 'utf-8') : '';
  const lines = jsonl.split('\n').filter((l) => l.trim() !== '');
  const trace = fs.existsSync(tracePath)
    ? readFileNormalized(tracePath).split('\n').filter((l) => l.trim() !== '')
    : [];

  return {
    outcome: result.outcome,
    exitCode: result.exitCode,
    stderr: result.stderr,
    jsonl,
    lines,
    trace,
    runDir,
  };
}

/** Parsed slug order from JSONL lines — never assert on raw JSONL text. */
function slugOrder(lines) {
  return lines.map((l) => JSON.parse(l).slug);
}

function serialTrace(slugs) {
  return slugs.flatMap((s) => [`start:${s}`, `end:${s}`]);
}

// ─── #1/#2 — default and explicit-disabled serial dispatch ───────────────

describe('#3034 default and explicit-disabled dispatch stays serial', () => {
  test('defaultsToSerialDispatchWhenKeyUnset', (t) => {
    const result = runDispatch(t, { selected: SELECTED_3, parallel: null });
    assert.deepEqual(result.trace, serialTrace(['codex', 'gemini', 'claude']));
  });

  test('staysSerialWhenExplicitlyDisabled', (t) => {
    const result = runDispatch(t, { selected: SELECTED_3, parallel: 'false' });
    assert.deepEqual(result.trace, serialTrace(['codex', 'gemini', 'claude']));
  });
});

// ─── #3/#4 — opt-in concurrency and join-before-aggregate ─────────────────

describe('#3034 opt-in concurrency', () => {
  test('dispatchesLanesConcurrentlyWhenEnabled', (t) => {
    const result = runDispatch(t, { selected: SELECTED_3, parallel: 'true', barrier: true });
    const timeouts = result.trace.filter((l) => l.startsWith('barrier-timeout:'));
    assert.deepEqual(timeouts, [], 'no lane should hit the barrier timeout when lanes run concurrently');
  });

  test('joinsAllLanesBeforeAggregation', (t) => {
    // barrier:true is load-bearing, not decoration. Without it the stub lanes
    // finish instantly and a missing `wait` could still race to 3 lines,
    // making this pass intermittently. Held at the barrier, a missing join
    // deterministically aggregates ZERO lines.
    const result = runDispatch(t, { selected: SELECTED_3, parallel: 'true', barrier: true });
    assert.equal(result.lines.length, 3, 'dispatch must return only after every lane wrote its result');
  });
});

// ─── #5/#6 — selection-order preservation ─────────────────────────────────

describe('#3034 JSONL preserves selection order, not completion order', () => {
  test('preservesSelectionOrderSerial', (t) => {
    const result = runDispatch(t, { selected: SELECTED_3, parallel: null });
    assert.deepEqual(slugOrder(result.lines), ['codex', 'gemini', 'claude']);
  });

  test('preservesSelectionOrderParallelDespiteCompletionOrder', (t) => {
    // codex waits on gemini; gemini waits on claude -> forces reverse
    // completion order (claude, gemini, codex) while selection order stays
    // codex, gemini, claude.
    const result = runDispatch(t, {
      selected: SELECTED_3,
      parallel: 'true',
      deps: { codex: 'gemini', gemini: 'claude' },
    });

    const endMarkers = result.trace.filter((l) => l.startsWith('end:'));
    // Pin the fixture actually forced reverse completion first — otherwise
    // the selection-order assertion below would pass vacuously.
    assert.deepEqual(endMarkers, ['end:claude', 'end:gemini', 'end:codex']);

    assert.deepEqual(slugOrder(result.lines), ['codex', 'gemini', 'claude']);
  });
});

// ─── #7/#8 — PIPE_BUF boundary triple (plus one clearly-oversized case) ───

describe('#3034 oversized lane results stay intact under concurrency', () => {
  test('keepsOversizedLaneResultsIntactUnderConcurrency', async (t) => {
    for (const padBytes of [4095, 4096, 4097, 8192]) {
      await t.test(`padBytes=${padBytes}`, (t2) => {
        const result = runDispatch(t2, { selected: SELECTED_3, parallel: 'true', padBytes });
        assert.equal(result.lines.length, 3);
        for (const line of result.lines) {
          assert.doesNotThrow(() => JSON.parse(line), `line failed to parse at padBytes=${padBytes}: ${line.slice(0, 80)}...`);
        }
        assert.deepEqual(slugOrder(result.lines), ['codex', 'gemini', 'claude']);
      });
    }
  });
});

// ─── #9 — single-lane boundary ─────────────────────────────────────────────

describe('#3034 single-lane boundary', () => {
  test('singleLaneParallelMatchesSerial', (t) => {
    const serial = runDispatch(t, { selected: 'codex', parallel: null });
    const parallel = runDispatch(t, { selected: 'codex', parallel: 'true' });

    assert.equal(serial.lines.length, 1);
    assert.equal(parallel.lines.length, 1);
    assert.deepEqual(slugOrder(serial.lines), slugOrder(parallel.lines));

    const serialMd = fs.readFileSync(path.join(serial.runDir, 'gsd-review-codex.md'), 'utf-8');
    const parallelMd = fs.readFileSync(path.join(parallel.runDir, 'gsd-review-codex.md'), 'utf-8');
    assert.equal(serialMd, parallelMd);
  });
});

// ─── #10 — empty selection is a no-op ──────────────────────────────────────

describe('#3034 empty selection', () => {
  test('emptySelectionIsANoOp', (t) => {
    const result = runDispatch(t, { selected: '', parallel: 'true' });
    assert.equal(result.outcome, 'exited');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.lines, []);
    assert.deepEqual(result.trace, []);
  });
});

describe('#3034 duplicate slug in the selection', () => {
  test('duplicateSlugDispatchesOnceAndWritesOneLine', (t) => {
    // A slug repeated in SELECTED_REVIEWERS would otherwise put two
    // concurrent background jobs on the same `>`-truncated per-slug result
    // file, corrupting whichever one finishes last. DISPATCH_SLUGS
    // de-duplicates before dispatch, so codex must run exactly once.
    const result = runDispatch(t, { selected: 'codex,gemini,codex', parallel: 'true' });
    assert.equal(result.outcome, 'exited');
    assert.equal(result.trace.filter((l) => l === 'start:codex').length, 1);
    assert.equal(result.trace.filter((l) => l === 'end:codex').length, 1);
    assert.deepEqual(slugOrder(result.lines), ['codex', 'gemini']);
  });
});

// ─── #11/#12 — lane failure does not abort siblings ────────────────────────

describe('#3034 lane failure does not abort sibling lanes', () => {
  test('laneFailureDoesNotAbortSiblingLanes', (t) => {
    const result = runDispatch(t, { selected: SELECTED_3, parallel: 'true', failSlugs: ['gemini'] });
    assert.equal(result.lines.length, 3, 'a failing lane still contributes its stub result line');
    assert.ok(
      fs.existsSync(path.join(result.runDir, 'gsd-review-gemini.md')),
      'the failing lane\'s diagnostic stub .md must be preserved',
    );
    assert.deepEqual(slugOrder(result.lines), ['codex', 'gemini', 'claude']);
  });

  test('laneFailureSerialUnchanged', (t) => {
    const result = runDispatch(t, { selected: SELECTED_3, parallel: null, failSlugs: ['gemini'] });
    assert.deepEqual(result.trace, serialTrace(['codex', 'gemini', 'claude']));
    assert.equal(result.lines.length, 3);
  });
});

// ─── #13 — budget-too-small skip emits no result line ─────────────────────

describe('#3034 budget-too-small skip', () => {
  test('budgetSkipEmitsNoResultLine', (t) => {
    const result = runDispatch(t, { selected: SELECTED_3, parallel: 'true', budgetFailSlugs: ['gemini'] });
    assert.deepEqual(slugOrder(result.lines), ['codex', 'claude'], 'the budget-skipped lane contributes no result line');
    const stub = fs.readFileSync(path.join(result.runDir, 'gsd-review-gemini.md'), 'utf-8');
    assert.match(stub, /skipped/);
    assert.match(stub, /prompt budget/);
  });
});

// ─── #14/#15 — silent / absent lane contributes no line ───────────────────

describe('#3034 silent lane contributes nothing, not a blank line', () => {
  test('silentLaneContributesNoLine', (t) => {
    const result = runDispatch(t, { selected: SELECTED_3, parallel: 'true', silentSlugs: ['gemini'] });
    assert.deepEqual(slugOrder(result.lines), ['codex', 'claude']);
    // Folded row #15 (absent result file): budgetSkipEmitsNoResultLine above
    // already exercises the "invoke never started, no file at all" shape via
    // its `continue`. This assertion pins the sibling shape: a lane that DID
    // run and wrote nothing must not leave a stray blank JSONL line.
    assert.ok(!result.jsonl.includes('\n\n'), 'an empty lane result must not leave a blank JSONL line');
  });
});

// ─── #16/#17 — non-canonical truthy values stay serial ────────────────────

describe('#3034 non-canonical truthy config values stay serial', () => {
  test('nonCanonicalTruthyValuesStaySerial', async (t) => {
    const nearMisses = ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true '];
    for (const value of nearMisses) {
      await t.test(`parallel_lanes="${value}"`, (t2) => {
        const result = runDispatch(t2, { selected: SELECTED_3, parallel: value });
        assert.deepEqual(result.trace, serialTrace(['codex', 'gemini', 'claude']), `value "${value}" must not opt into parallel dispatch`);
      });
    }
  });
});

// ─── #18 — config-get failure fails safe to serial ─────────────────────────

describe('#3034 broken config tooling fails safe to serial', () => {
  test('configGetFailureFallsBackToSerial', (t) => {
    const result = runDispatch(t, { selected: SELECTED_3, parallel: 'true', configGetFails: true });
    assert.deepEqual(result.trace, serialTrace(['codex', 'gemini', 'claude']));
  });
});

// ─── #19/#20/#21 — config-set registers review.parallel_lanes ─────────────

describe('#3034 review.parallel_lanes config key', () => {
  test('configSetAcceptsAndPersistsParallelLanes', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const setResult = runGsdTools('config-set review.parallel_lanes true', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(config.review?.parallel_lanes, true);
    assert.equal(typeof config.review?.parallel_lanes, 'boolean');

    const getResult = runGsdTools('config-get review.parallel_lanes --raw', tmpDir);
    assert.ok(getResult.success, `config-get failed: ${getResult.error}`);
    assert.equal((getResult.output || '').trim(), 'true');
  });

  test('configSetPersistsBooleanFalse', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const setResult = runGsdTools('config-set review.parallel_lanes false', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(config.review?.parallel_lanes, false);
    assert.equal(typeof config.review?.parallel_lanes, 'boolean');
  });

  test('rejectsUnregisteredNeighbouringKey', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // Missing trailing "s" — proves the whitelist is load-bearing and the
    // two tests above are not vacuous (they'd pass even for an unregistered
    // key if config-set accepted anything).
    const result = runGsdTools('config-set review.parallel_lane true', tmpDir);
    assert.equal(result.success, false, 'an unregistered near-miss key must be rejected');
  });
});

// ─── #22 — serial/parallel artifact equivalence ────────────────────────────

describe('#3034 serial and parallel dispatch produce equivalent artifacts', () => {
  test('serialAndParallelProduceEquivalentArtifacts', (t) => {
    const serial = runDispatch(t, { selected: SELECTED_3, parallel: null });
    const parallel = runDispatch(t, { selected: SELECTED_3, parallel: 'true' });

    assert.deepEqual(slugOrder(serial.lines), slugOrder(parallel.lines));
    assert.deepEqual(
      serial.lines.map((l) => JSON.parse(l)),
      parallel.lines.map((l) => JSON.parse(l)),
    );

    for (const slug of ['codex', 'gemini', 'claude']) {
      const serialMd = fs.readFileSync(path.join(serial.runDir, `gsd-review-${slug}.md`), 'utf-8');
      const parallelMd = fs.readFileSync(path.join(parallel.runDir, `gsd-review-${slug}.md`), 'utf-8');
      assert.equal(serialMd, parallelMd, `gsd-review-${slug}.md must be byte-identical between the two paths`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3352 (ADR-3473 §8.5, phase #3885 item 3) — `write_reviews` must not emit
// REVIEWS.md from failed inputs, and `present_results` must preserve
// per-lane evidence before `rm -rf "{run_dir}"` destroys it.
//
// SEAM CHOICE: `write_reviews`/`present_results` are markdown PROSE
// instructing an LLM agent, not a single executable program — "do not write
// REVIEWS.md" and "display this message" are natural-language directives to
// the agent, not `if`/`fi` around a `Write` call this suite could invoke.
// Asserting on that prose text directly would be source-grep
// (`local/no-source-grep`), which this repo bans. What IS literal,
// deterministic bash in both steps — and is exactly what R2's gate condition
// depends on — is:
//   (1) `write_reviews`'s new gate block, which computes
//       `TOTAL_LANE_FAILURE`/`ALL_LANES_SKIPPED` from the aggregate JSONL
//       and the lane stub files (the ONLY inputs the prose instructions key
//       off of to decide whether to write REVIEWS.md at all);
//   (2) `write_reviews`'s commit block (unchanged text, still real bash);
//   (3) `present_results`'s new preserve-evidence block and its `rm -rf`
//       cleanup block.
// Each is extracted and EXECUTED for real. To observe the documented
// consequence of the gate flags (whether REVIEWS.md and the commit actually
// happen), the driver below applies the step's OWN written contract —
// "If ALL_LANES_SKIPPED=true or TOTAL_LANE_FAILURE=true: do NOT write
// REVIEWS.md and do NOT run the commit. Otherwise: proceed" (review.md, the
// `write_reviews` step, verbatim) — as harness scaffolding around the real
// extracted blocks, the same way STUB_PREAMBLE above supplies scaffolding
// (`arg_after`/`in_list`/...) the extracted `invoke_reviewers` block calls
// into. This is not a re-typed copy of the logic under test: the FLAG
// computation is 100% the real fenced bash; only the "then do the file I/O"
// half — which the real workflow leaves to the LLM's own tool calls — is
// harness glue.
//
// R46 (`preservedEvidenceIsNotSweptIntoTheCommit`) is a regression guard for
// N6, not failing-first evidence: the commit fence's `--files` argument is
// byte-identical before and after #3352 (only the surrounding prose gained
// gating language), so this exact assertion also holds against the pre-fix
// text. It is retained because the invariant it pins (the commit step must
// never widen from the single REVIEWS.md path to a directory glob that
// would sweep `.review-diagnostics/` into a commit) is real and worth a
// permanent pin, and because it only runs at all through this same
// full-flow driver, whose surrounding gate/preserve blocks did not exist
// pre-fix (see the STEP 2 report for the exact pre-fix observation).

function extractStepBody(stepName) {
  const content = readFileNormalized(REVIEW_MD_PATH);
  const stepMarker = `<step name="${stepName}">`;
  const stepIdx = content.indexOf(stepMarker);
  if (stepIdx === -1) {
    throw new Error(`extractStepBody: could not find "${stepMarker}" in ${REVIEW_MD_PATH}`);
  }
  const afterStep = content.slice(stepIdx + stepMarker.length);
  const endIdx = afterStep.indexOf('</step>');
  if (endIdx === -1) {
    throw new Error(`extractStepBody: could not find closing "</step>" after ${stepName} in ${REVIEW_MD_PATH}`);
  }
  return afterStep.slice(0, endIdx);
}

/** Finds the first ```bash/```sh fence in `stepBody` whose text contains every string in `mustInclude`. */
function extractBashFenceContaining(stepBody, mustInclude, label) {
  const stepBodyLines = stepBody.split(/\r?\n/);
  for (const fenced of scanFencedBlocks(stepBodyLines)) {
    if (fenced.closeLineIdx === -1) continue;
    if (!['bash', 'sh'].includes((fenced.infoString || '').trim())) continue;
    const block = stepBodyLines.slice(fenced.openLineIdx + 1, fenced.closeLineIdx).join('\n');
    if (mustInclude.every((s) => block.includes(s))) return block;
  }
  throw new Error(`extractBashFenceContaining: no fence matching ${label} found (looked for ${JSON.stringify(mustInclude)})`);
}

function extractWriteReviewsGateBash() {
  return extractBashFenceContaining(
    extractStepBody('write_reviews'),
    ['TOTAL_LANE_FAILURE', 'ALL_LANES_SKIPPED', 'DISPATCH_SLUGS'],
    'write_reviews #3352 gate block',
  );
}

function extractWriteReviewsCommitBash() {
  return extractBashFenceContaining(
    extractStepBody('write_reviews'),
    ['gsd_run query commit', 'REVIEWS.md'],
    'write_reviews commit block',
  );
}

// #3885: preserve-evidence and cleanup are ONE fenced block (a shell variable
// cannot survive across separate fences), gated on `_PRESERVE_OK` so a failed
// `mkdir -p`/`cp` skips the `rm -rf` and leaves `{run_dir}` intact instead of
// destroying the only copy of the evidence it exists to protect.
function extractPresentResultsPreserveAndCleanupBash() {
  return extractBashFenceContaining(
    extractStepBody('present_results'),
    ['DIAG_DIR', 'nullglob', 'rm -rf', '{run_dir}', '_PRESERVE_OK'],
    'present_results #3352/#3885 preserve+cleanup block',
  );
}

/**
 * Runs the real extracted write_reviews gate+commit blocks and the real
 * present_results preserve+cleanup block, in the documented order, against
 * a fixture run dir. `opts.jsonlLines` seeds the aggregate JSONL (omit/empty
 * for "every lane failed"); `opts.lanes` seeds per-slug `gsd-review-<slug>.md`
 * / `.md`'s sibling `.err`. See the seam-choice comment above this describe
 * block for what is real bash vs. harness glue.
 *
 * `opts.blockDiagDirWithFile`: #3885 root-safe failure injection. Root
 * bypasses `chmod 0o000` entirely (a Docker/CI default), so permission bits
 * cannot induce a `mkdir -p`/`cp` failure deterministically. A filesystem
 * TYPE conflict is root-safe instead: pre-creating a plain FILE at the exact
 * path `mkdir -p` needs to create as a DIRECTORY makes `mkdir -p` fail with
 * "not a directory" for every caller, root included, because it is not a
 * permissions check at all.
 */
function runWriteReviewsFlow(t, opts) {
  const scriptDir = createTempDir('gsd-3352-script-');
  const runDir = createTempDir('gsd-3352-rundir-');
  const phaseDir = createTempDir('gsd-3352-phasedir-');
  t.after(() => {
    cleanup(scriptDir);
    cleanup(runDir);
    cleanup(phaseDir);
  });

  if (opts.blockDiagDirWithFile) {
    fs.writeFileSync(path.join(phaseDir, '.review-diagnostics'), 'blocking file, not a directory\n');
  }

  // #4097: stage the run's OWN input copies exactly as prompt assembly
  // (review.md's section-copy fence) writes them, so the preserve+cleanup
  // block can be observed deciding input vs. evidence. `name` is a bare
  // basename written into the fixture run dir.
  for (const [name, content] of Object.entries(opts.seedFiles || {})) {
    fs.writeFileSync(path.join(runDir, name), content);
  }

  if (opts.jsonlLines && opts.jsonlLines.length > 0) {
    fs.writeFileSync(
      path.join(runDir, 'gsd-review-lane-results.jsonl'),
      opts.jsonlLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
  }
  for (const [slug, files] of Object.entries(opts.lanes || {})) {
    if (files.md !== undefined && files.md !== null) {
      fs.writeFileSync(path.join(runDir, `gsd-review-${slug}.md`), files.md);
    }
    if (files.err !== undefined && files.err !== null) {
      fs.writeFileSync(path.join(runDir, `gsd-review-${slug}.err`), files.err);
    }
  }

  const gateBlock = extractWriteReviewsGateBash();
  const commitBlock = extractWriteReviewsCommitBash();
  const preserveAndCleanupBlock = extractPresentResultsPreserveAndCleanupBash();

  const tracePath = path.join(scriptDir, 'commit-trace.log');
  const reviewsMdPath = path.join(phaseDir, '03-REVIEWS.md');

  // #3885 Windows fix: splice POSIX-form paths into the bash source text, not
  // the OS-native ones `createTempDir()` returns. This is a fixture fix, not
  // a product one — the real workflow never hits this seam with a backslash
  // path in the first place: `{run_dir}` is created by `mktemp -d` running
  // INSIDE the bash block itself (always POSIX-style, even under Git Bash on
  // Windows), and `{phase_dir}` is the `phase_dir` field from
  // `gsd_run query init.review`, which gsd-core/bin/lib/init.cjs already
  // pipes through this exact same `toPosixPath()` before it is ever
  // serialized (see the `phase_dir: ... toPosixPath(...)` call sites there).
  // Splicing a native `C:\Users\...` string directly into unquoted bash
  // source (e.g. the pre-existing, unquoted
  // `--files {phase_dir}/{padded_phase}-REVIEWS.md` commit line) hits bash's
  // own unquoted-backslash removal and silently drops every separator — a
  // test-harness-only failure mode that following the fixture's own
  // production analogue eliminates.
  const runDirPosix = toPosixPath(runDir);
  const phaseDirPosix = toPosixPath(phaseDir);

  const substitute = (block) => block
    .split('{run_dir}').join(runDirPosix)
    .split('{phase_dir}').join(phaseDirPosix)
    .split('{padded_phase}').join('03')
    .split('{N}').join('3');

  const script = [
    '#!/usr/bin/env bash',
    'set -u',
    `SELECTED_REVIEWERS='${opts.selected}'`,
    `TRACE='${tracePath}'`,
    'gsd_run() { printf "%s\\n" "$*" >> "$TRACE"; }',
    substitute(gateBlock),
    'echo "GATE:TOTAL_LANE_FAILURE=$TOTAL_LANE_FAILURE"',
    'echo "GATE:ALL_LANES_SKIPPED=$ALL_LANES_SKIPPED"',
    'if [ "$TOTAL_LANE_FAILURE" = "false" ] && [ "$ALL_LANES_SKIPPED" = "false" ]; then',
    // Harness glue standing in for the agent's own Write tool call (see the
    // seam-choice comment above): the prose says "combine ... into
    // REVIEWS.md" only when the gate above did not fire.
    `  touch '${reviewsMdPath}'`,
    substitute(commitBlock),
    'fi',
    substitute(preserveAndCleanupBlock),
  ].join('\n');

  fs.writeFileSync(path.join(scriptDir, 'flow.sh'), script, { mode: 0o755 });

  // cwd is deliberately scriptDir, NOT runDir: every path this flow touches
  // ($RUN_DIR, $DIAG_DIR, {phase_dir}) is already absolute in the extracted
  // bash text, so the child's cwd is not load-bearing for anything the
  // blocks do — but on Windows a process cannot delete a directory that is
  // its OWN current working directory (unlike POSIX, where rm -rf on your
  // cwd succeeds). Setting cwd to runDir here was a harness artifact with no
  // production analogue (review.md never `cd`s into $RUN_DIR — see
  // gsd-core/workflows/review.md's use of $RUN_DIR, always by absolute
  // path), and it silently defeated `rm -rf "$RUN_DIR"` under Git-Bash on
  // windows-latest: the directory's *contents* were removed but the
  // still-open-as-cwd directory entry itself survived, so
  // `fs.existsSync(runDir)` kept reporting true. This was the actual defect
  // behind the two Windows-only failures — not a path-separator mismatch.
  const result = runHook(path.join(scriptDir, 'flow.sh'), [], {
    interpreter: 'bash',
    cwd: scriptDir,
    timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
  });

  const stdout = result.stdout || '';
  const diagDir = path.join(phaseDir, '.review-diagnostics');
  const commitTrace = fs.existsSync(tracePath)
    ? readFileNormalized(tracePath).split('\n').filter((l) => l.trim() !== '')
    : [];

  return {
    outcome: result.outcome,
    exitCode: result.exitCode,
    stderr: result.stderr,
    totalLaneFailure: /GATE:TOTAL_LANE_FAILURE=(\S+)/.exec(stdout)?.[1],
    allLanesSkipped: /GATE:ALL_LANES_SKIPPED=(\S+)/.exec(stdout)?.[1],
    reviewsMdExists: fs.existsSync(reviewsMdPath),
    runDirExists: fs.existsSync(runDir),
    diagDir,
    diagDirExists: fs.existsSync(diagDir),
    commitTrace,
    runDir,
    phaseDir,
  };
}

const BUDGET_SKIP_MD = (slug) => `${slug} review skipped: prompt budget (500 tokens) too small for the minimum review set.`;
const LANE_FAILURE_MD = (slug) => `${slug} review failed: exit 1`;

describe('#3352 every lane failed writes no REVIEWS.md', () => {
  test('totalLaneFailureWritesNoReviewsMd_3352', (t) => {
    const result = runWriteReviewsFlow(t, {
      selected: 'codex,gemini,claude',
      jsonlLines: [],
      lanes: {
        codex: { md: LANE_FAILURE_MD('codex'), err: 'stack trace: codex crashed\n' },
        gemini: { md: LANE_FAILURE_MD('gemini'), err: 'stack trace: gemini crashed\n' },
        claude: { md: LANE_FAILURE_MD('claude'), err: 'stack trace: claude crashed\n' },
      },
    });
    assert.equal(result.outcome, 'exited');
    assert.equal(result.totalLaneFailure, 'true', `expected TOTAL_LANE_FAILURE=true; stderr=${result.stderr}`);
    assert.equal(result.allLanesSkipped, 'false');
    assert.equal(result.reviewsMdExists, false, 'no REVIEWS.md may be written when every lane failed');
    assert.deepEqual(result.commitTrace, [], 'the commit must not run when every lane failed');
  });
});

describe('#3352 one successful lane still writes REVIEWS.md (R1, must stay green)', () => {
  test('oneSuccessfulLaneStillWritesReviews', (t) => {
    const result = runWriteReviewsFlow(t, {
      selected: 'codex,gemini,claude',
      jsonlLines: [{ slug: 'codex' }],
      lanes: {
        codex: { md: '# Codex review\nlooks good\n' },
        gemini: { md: LANE_FAILURE_MD('gemini'), err: 'stack trace: gemini crashed\n' },
        claude: { md: LANE_FAILURE_MD('claude'), err: 'stack trace: claude crashed\n' },
      },
    });
    assert.equal(result.totalLaneFailure, 'false');
    assert.equal(result.allLanesSkipped, 'false');
    assert.equal(result.reviewsMdExists, true, 'at least one lane succeeded — REVIEWS.md must still be written');
    assert.equal(result.commitTrace.length, 1, 'the commit must run exactly once');
  });
});

describe('#3352 a budget-skipped lane is not a failure (N5)', () => {
  test('budgetSkippedLanesAreNotFailures', (t) => {
    const result = runWriteReviewsFlow(t, {
      selected: 'codex,gemini,claude',
      jsonlLines: [],
      lanes: {
        codex: { md: BUDGET_SKIP_MD('codex') },
        gemini: { md: BUDGET_SKIP_MD('gemini') },
        claude: { md: BUDGET_SKIP_MD('claude') },
      },
    });
    assert.equal(result.allLanesSkipped, 'true', `every lane was budget-skipped, not failed; stderr=${result.stderr}`);
    assert.equal(result.totalLaneFailure, 'false', 'a budget skip must never be classified as a failure');
    assert.equal(result.reviewsMdExists, false, 'nothing to review — REVIEWS.md still must not be written');
    assert.deepEqual(result.commitTrace, []);
  });
});

describe('#3352 successful-lane count boundary (0/1/2)', () => {
  test('successfulLaneCountBoundary', (t) => {
    const zero = runWriteReviewsFlow(t, {
      selected: 'codex,gemini',
      jsonlLines: [],
      lanes: {
        codex: { md: LANE_FAILURE_MD('codex'), err: 'boom\n' },
        gemini: { md: LANE_FAILURE_MD('gemini'), err: 'boom\n' },
      },
    });
    assert.equal(zero.totalLaneFailure, 'true');
    assert.equal(zero.reviewsMdExists, false, '0 successful lanes: no REVIEWS.md');

    const one = runWriteReviewsFlow(t, {
      selected: 'codex,gemini',
      jsonlLines: [{ slug: 'codex' }],
      lanes: {
        codex: { md: '# Codex\nok\n' },
        gemini: { md: LANE_FAILURE_MD('gemini'), err: 'boom\n' },
      },
    });
    assert.equal(one.totalLaneFailure, 'false');
    assert.equal(one.reviewsMdExists, true, '1 successful lane: REVIEWS.md is written');

    const two = runWriteReviewsFlow(t, {
      selected: 'codex,gemini',
      jsonlLines: [{ slug: 'codex' }, { slug: 'gemini' }],
      lanes: {
        codex: { md: '# Codex\nok\n' },
        gemini: { md: '# Gemini\nok\n' },
      },
    });
    assert.equal(two.totalLaneFailure, 'false');
    assert.equal(two.reviewsMdExists, true, '2 successful lanes: REVIEWS.md is written');
  });
});

describe('#3352 per-lane evidence survives cleanup (R3)', () => {
  test('laneEvidenceSurvivesCleanup_3352', (t) => {
    const result = runWriteReviewsFlow(t, {
      selected: 'codex,gemini,claude',
      jsonlLines: [],
      lanes: {
        codex: { md: LANE_FAILURE_MD('codex'), err: 'stack trace: codex crashed\n' },
        gemini: { md: '', err: '' }, // ran, wrote nothing, no error either — nothing to preserve for this slug's .err
        claude: { md: LANE_FAILURE_MD('claude'), err: 'stack trace: claude crashed\n' },
      },
    });

    assert.equal(result.runDirExists, false, 'the run dir must still be destroyed');
    assert.equal(result.diagDirExists, true, 'diagnostics must have been preserved somewhere under phase_dir');

    const codexMd = path.join(result.diagDir, 'gsd-review-codex.md');
    const codexErr = path.join(result.diagDir, 'gsd-review-codex.err');
    const claudeErr = path.join(result.diagDir, 'gsd-review-claude.err');
    assert.ok(fs.existsSync(codexMd), 'codex .md evidence must be preserved');
    assert.equal(fs.readFileSync(codexMd, 'utf-8'), LANE_FAILURE_MD('codex'));
    assert.ok(fs.existsSync(codexErr), 'codex non-empty .err evidence must be preserved');
    assert.ok(fs.existsSync(claudeErr), 'claude non-empty .err evidence must be preserved');

    const geminiErr = path.join(result.diagDir, 'gsd-review-gemini.err');
    assert.equal(fs.existsSync(geminiErr), false, 'an empty .err must not be copied as if it were real evidence');
  });
});

describe('#3885 nothing to preserve still cleans up (must stay green)', () => {
  test('nothingToPreserveStillCleansUp_3885', (t) => {
    // No .md/.err fixtures written at all: `_DIAG_MD`/`_DIAG_ERR` are both
    // empty, so this is the "nothing to preserve" branch, not a failure —
    // `_PRESERVE_OK` starts (and stays) `true`, so cleanup proceeds exactly
    // as if preservation had succeeded.
    const result = runWriteReviewsFlow(t, {
      selected: 'codex,gemini,claude',
      jsonlLines: [],
      lanes: {},
    });

    assert.equal(result.runDirExists, false, 'nothing to preserve is not a failure — run dir must still be removed');
    assert.equal(result.diagDirExists, false, 'no diagnostics directory should be created when there is nothing to copy');
  });
});

describe('#3885 failed preservation leaves run_dir intact (no silent swallow)', () => {
  test('failedPreservationLeavesRunDirIntact_3885', (t) => {
    // Root-safe failure injection: pre-create a plain FILE at the exact path
    // `mkdir -p "$DIAG_DIR"` needs to create as a directory. This is a
    // filesystem TYPE conflict, not a permission check, so it fails `mkdir -p`
    // even when the test runs as root in Docker/CI (where `chmod 0o000`
    // would be silently bypassed and this test would pass with zero real
    // coverage — see #3885's brief).
    const result = runWriteReviewsFlow(t, {
      selected: 'codex,gemini,claude',
      jsonlLines: [],
      blockDiagDirWithFile: true,
      lanes: {
        codex: { md: LANE_FAILURE_MD('codex'), err: 'stack trace: codex crashed\n' },
        gemini: { md: LANE_FAILURE_MD('gemini'), err: 'stack trace: gemini crashed\n' },
        claude: { md: LANE_FAILURE_MD('claude'), err: 'stack trace: claude crashed\n' },
      },
    });

    assert.equal(
      result.runDirExists,
      true,
      'a failed mkdir -p on DIAG_DIR must skip rm -rf and leave run_dir intact — this is the #3885 regression guard',
    );
    // The warning is emitted by the substituted bash script, which names
    // $RUN_DIR in its POSIX-spliced form (see the #3885 comment in
    // runWriteReviewsFlow) — compare against that same form rather than the
    // OS-native `result.runDir`.
    assert.ok(
      result.stderr.includes(toPosixPath(result.runDir)),
      `the failure warning must name the intact run_dir holding the un-preserved evidence; got stderr: ${result.stderr}`,
    );
    // The original per-lane evidence is still readable at its original
    // location, uncorrupted, because it was never moved or destroyed.
    assert.equal(
      fs.readFileSync(path.join(result.runDir, 'gsd-review-codex.md'), 'utf-8'),
      LANE_FAILURE_MD('codex'),
    );
  });
});

describe('#4097 the run\'s own input copies are not preserved as diagnostics', () => {
  // The preserve+cleanup glob assumes every `gsd-review-*.md` in RUN_DIR is
  // lane OUTPUT. But the workflow itself writes the run's assembled INPUTS
  // into RUN_DIR under the same prefix at prompt-assembly time (review.md's
  // section-copy fence): the combined prompt, instructions, roadmap, one copy
  // of every plan under review, project/context/research/requirements
  // sections, and the per-lane trimmed prompts. On a multi-plan phase those
  // byte-identical `.planning/` duplicates bury the actual evidence (a
  // handful of reviewer reports and `.err` sidecars) and grow the phase
  // directory on every review run (#4097).
  const INPUT_COPIES_4097 = {
    'gsd-review-prompt.md': 'combined reviewer prompt\n',
    'gsd-review-instructions.md': 'instructions section\n',
    'gsd-review-roadmap.md': 'roadmap section\n',
    'gsd-review-project.md': 'PROJECT.md copy\n',
    'gsd-review-context.md': 'CONTEXT.md concatenation\n',
    'gsd-review-research.md': 'RESEARCH.md concatenation\n',
    'gsd-review-requirements.md': 'REQUIREMENTS.md copy\n',
    'gsd-review-plan-12.6-01.md': 'plan 12.6-01 duplicate\n',
    'gsd-review-plan-12.6-02.md': 'plan 12.6-02 duplicate\n',
    // Per-lane trimmed prompt written by prepare_trimmed_prompt_for_reviewer
    // — also a run input, also matched by the issue's `gsd-review-prompt*`
    // exclusion prefix.
    'gsd-review-prompt-claude.md': 'budget-trimmed prompt for lane claude\n',
  };

  test('inputCopiesAreNotSweptIntoDiagnostics_4097', (t) => {
    const result = runWriteReviewsFlow(t, {
      selected: 'claude',
      jsonlLines: [{ slug: 'claude' }],
      seedFiles: INPUT_COPIES_4097,
      lanes: {
        claude: { md: '# Claude review\nok\n', err: 'mild stderr warning\n' },
      },
    });

    assert.equal(result.outcome, 'exited');
    assert.equal(result.runDirExists, false, 'successful preservation must still clean up the run dir');
    assert.equal(result.diagDirExists, true, 'real lane evidence must still be preserved');

    const preserved = fs.existsSync(result.diagDir)
      ? fs.readdirSync(result.diagDir).sort()
      : [];
    // Only the lane's own output belongs in the diagnostics folder.
    assert.deepEqual(
      preserved,
      ['gsd-review-claude.err', 'gsd-review-claude.md'],
      `diagnostics must hold exactly the lane report and stderr sidecar, not the run's input copies; got: ${preserved.join(', ')}`,
    );
    assert.equal(
      fs.readFileSync(path.join(result.diagDir, 'gsd-review-claude.md'), 'utf-8'),
      '# Claude review\nok\n',
      'the lane report must be preserved byte-identically',
    );
    for (const inputName of Object.keys(INPUT_COPIES_4097)) {
      assert.equal(
        fs.existsSync(path.join(result.diagDir, inputName)),
        false,
        `input copy ${inputName} must NOT be swept into .review-diagnostics/ (#4097)`,
      );
    }
  });

  test('inputsOnlyRunLeavesNoDiagnosticsDir_4097', (t) => {
    // Inputs only, no lane artifacts at all: inputs are not evidence, so
    // this is the "nothing to preserve" branch — no diagnostics directory is
    // created and cleanup proceeds (#4097 narrowing of #3352's glob).
    const result = runWriteReviewsFlow(t, {
      selected: 'claude',
      jsonlLines: [],
      seedFiles: INPUT_COPIES_4097,
      lanes: {},
    });

    assert.equal(result.runDirExists, false, 'nothing to preserve is not a failure — run dir must still be removed');
    assert.equal(result.diagDirExists, false, 'a run that produced only input copies has no evidence to preserve');
  });
});

describe('#3352 preserved evidence is never swept into the commit (N6)', () => {
  test('preservedEvidenceIsNotSweptIntoTheCommit', (t) => {
    const result = runWriteReviewsFlow(t, {
      selected: 'codex',
      jsonlLines: [{ slug: 'codex' }],
      lanes: {
        codex: { md: '# Codex\nok\n', err: '' },
      },
    });
    assert.equal(result.commitTrace.length, 1, 'exactly one commit call must run');
    const commitArgs = result.commitTrace[0];
    // The commit fence splices `{phase_dir}` into unquoted bash source as a
    // POSIX-form path (see the #3885 comment in runWriteReviewsFlow) — build
    // the expected string the same way rather than via `path.join`, which on
    // win32 would re-insert native backslashes the substituted script never
    // produces.
    assert.ok(
      commitArgs.includes(`${toPosixPath(result.phaseDir)}/03-REVIEWS.md`),
      `commit must name the single REVIEWS.md file; got: ${commitArgs}`,
    );
    assert.ok(
      !commitArgs.includes('.review-diagnostics'),
      `commit must never name the diagnostics directory; got: ${commitArgs}`,
    );
    // The commit step's --files value is a single path, never a glob: a
    // directory glob would expand to MULTIPLE argv tokens by the time
    // `gsd_run` sees them, so more than one path after "--files" is itself
    // the defect this row guards against.
    const filesIdx = commitArgs.indexOf('--files ');
    const afterFiles = commitArgs.slice(filesIdx + '--files '.length).trim();
    assert.equal(afterFiles.split(/\s+/).length, 1, `--files must carry exactly one path; got: ${afterFiles}`);
  });
});

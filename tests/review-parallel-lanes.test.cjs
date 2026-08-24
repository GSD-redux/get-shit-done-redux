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

  const fenceRe = /```(?:bash|sh)\r?\n([\s\S]*?)```/;
  const fenceMatch = fenceRe.exec(stepBody);
  if (!fenceMatch) {
    throw new Error(`extractInvokeReviewersBash: no \`\`\`bash fence found inside invoke_reviewers step in ${REVIEW_MD_PATH}`);
  }
  const block = fenceMatch[1];

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
  '    touch "$RUN_DIR/done-$slug"',
  '    echo "end:$slug" >> "$TRACE"',
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

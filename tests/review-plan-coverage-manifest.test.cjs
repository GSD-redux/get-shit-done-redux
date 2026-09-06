// allow-test-rule: source-text-is-the-product (#3301)
// The workflow markdown IS the installed orchestration contract; these rows
// extract the real shipped bash and execute it, never a hand-copied duplicate.

'use strict';

/**
 * #3301 — reviewers in the cross-AI plan-review workflow are never told the
 * plan ids or the total plan count, so a review that silently covers 6 of 7
 * plans is indistinguishable from one that covers all 7.
 *
 * Two behavioral seams, both extracted from the REAL shipped bash in
 * gsd-core/workflows/review.md (the same pattern as
 * tests/review-build-prompt-optional-sections.test.cjs):
 *
 *   1. build_prompt's plan-copy block — must derive a `.plans-manifest.md`
 *      (plan ids + total count) from the `*-PLAN.md` filenames and append it
 *      to both gsd-review-instructions.md and gsd-review-prompt.md.
 *   2. write_reviews' plan-coverage-check block — must grade each dispatched
 *      lane's review file against that manifest, honoring two named regex
 *      traps (escaped ids, hyphen-boundary exclusion) and skipping stub/empty/
 *      CodeRabbit lanes.
 *
 * Script transport is temp-FILE based, never `bash -c <script>` (#2650 argv
 * mangling on Windows), matching the established convention.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
const REPO_ROOT = path.join(__dirname, '..');

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
      '[review-plan-coverage-manifest.test.cjs] zsh not available — zsh-lane tests SKIPPED, coverage for this shell is UNKNOWN, not verified',
    );
  }
  return shells;
}
const SHELLS = detectShells();

/**
 * Extract the fenced ```bash block of build_prompt that copies *-PLAN.md
 * files — the one that also writes gsd-review-context.md and
 * gsd-review-instructions.md. Same anchor/walk-backward pattern as
 * tests/review-build-prompt-optional-sections.test.cjs.
 */
function extractPlanCopyBlock() {
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
  assert.ok(
    body.includes('gsd-review-instructions.md'),
    'extracted block writes gsd-review-context.md but not gsd-review-instructions.md — wrong block',
  );
  return body;
}

/**
 * Extract the fenced ```bash block of write_reviews that grades plan
 * coverage — anchored on the manifest variable this PR introduces. Walks
 * forward from the write_reviews step marker so it never grabs the earlier
 * (unrelated) gate-check bash block in the same step.
 */
function extractCoverageCheckBlock() {
  const content = readWorkflowCombined(REVIEW_WORKFLOW);
  const stepIdx = content.indexOf('<step name="write_reviews">');
  assert.notEqual(stepIdx, -1, 'write_reviews step must exist');
  const fromStep = content.slice(stepIdx);
  const anchorIdx = fromStep.indexOf('MANIFEST="$RUN_DIR/.plans-manifest.md"');
  assert.notEqual(
    anchorIdx,
    -1,
    'write_reviews must reference .plans-manifest.md — the plan-coverage-check block is missing',
  );
  const before = fromStep.slice(0, anchorIdx);
  const fenceOpenRe = /```bash\r?\n/g;
  let lastOpen = -1;
  let m;
  while ((m = fenceOpenRe.exec(before)) !== null) lastOpen = m.index + m[0].length;
  assert.notEqual(lastOpen, -1, '.plans-manifest.md reference is not inside a ```bash fence of write_reviews');
  const after = fromStep.slice(lastOpen);
  const closeIdx = after.indexOf('\n```');
  assert.notEqual(closeIdx, -1, 'unterminated ```bash fence around the plan-coverage-check block');
  return after.slice(0, closeIdx);
}

/** Every fenced ```bash block of review.md (+steps) — for the CodeRabbit-slug structural row. */
function extractAllBashBlocks() {
  const content = readWorkflowCombined(REVIEW_WORKFLOW);
  const lines = content.split(/\r?\n/);
  return scanFencedBlocks(lines)
    .filter((b) => b.closeLineIdx !== -1 && (b.infoString || '').trim() === 'bash')
    .map((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'));
}

/** Fill the workflow's `{run_dir}` placeholder and stage the script in a file. */
function stageScript(shell, body, root, runDir) {
  const scriptPath = path.join(root, `block-${shell.name}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(scriptPath, body.split('{run_dir}').join(runDir));
  return scriptPath;
}

function runScript(shell, body, root, runDir, env, cwd = root) {
  const scriptPath = stageScript(shell, body, root, runDir);
  return spawnSync(shell.cmd, [scriptPath], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdin: 'ignore',
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
}

const readIfPresent = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/**
 * Fixture for the plan-copy block: a PHASE_DIR with the given *-PLAN.md
 * filenames, a fresh RUN_DIR, and the two always-copied section sources the
 * block expects from prompt assembly.
 */
function buildPlanCopyFixture(planFileNames) {
  const root = createTempDir('gsd-3301-copy-');
  const phaseDir = path.join(root, 'phase');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(phaseDir);
  fs.mkdirSync(runDir);
  for (const name of planFileNames) {
    fs.writeFileSync(path.join(phaseDir, name), 'plan body\n');
  }
  fs.writeFileSync(path.join(root, 'instr.md'), 'instructions\n');
  fs.writeFileSync(path.join(root, 'roadmap.md'), 'roadmap\n');
  return {
    root,
    phaseDir,
    runDir,
    env: {
      PHASE_DIR: phaseDir,
      INSTRUCTIONS_BLOCK_FILE: path.join(root, 'instr.md'),
      ROADMAP_SECTION_FILE: path.join(root, 'roadmap.md'),
    },
  };
}

/** Fixture for the coverage-check block: a RUN_DIR pre-populated with a manifest and lane files. */
function buildCoverageFixture(planIds, lanes) {
  const root = createTempDir('gsd-3301-coverage-');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir);
  const manifestLines = ['', '## Plan Coverage Manifest', '', `Total plans in this review: ${planIds.length}`, ''];
  for (const id of planIds) manifestLines.push(`- ${id}`);
  fs.writeFileSync(path.join(runDir, '.plans-manifest.md'), manifestLines.join('\n') + '\n');
  for (const [slug, content] of Object.entries(lanes)) {
    fs.writeFileSync(path.join(runDir, `gsd-review-${slug}.md`), content);
  }
  return {
    root,
    runDir,
    env: { SELECTED_REVIEWERS: Object.keys(lanes).join(',') },
  };
}

function readCoverageJson(runDir, slug) {
  const p = path.join(runDir, `.plan-coverage-${slug}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/**
 * #4109 — extract the write_reviews gate-check block that counts dispatched
 * vs skipped lanes and sets ALL_LANES_SKIPPED / TOTAL_LANE_FAILURE. Anchored
 * on the JSONL variable at the top of that block (distinct from, and earlier
 * than, the .plans-manifest.md anchor extractCoverageCheckBlock() uses).
 */
function extractGateCheckBlock() {
  const content = readWorkflowCombined(REVIEW_WORKFLOW);
  const anchorIdx = content.indexOf('JSONL="$RUN_DIR/gsd-review-lane-results.jsonl"');
  assert.notEqual(anchorIdx, -1, 'write_reviews must reference gsd-review-lane-results.jsonl — the gate-check block is missing');
  const before = content.slice(0, anchorIdx);
  const fenceOpenRe = /```bash\r?\n/g;
  let lastOpen = -1;
  let m;
  while ((m = fenceOpenRe.exec(before)) !== null) lastOpen = m.index + m[0].length;
  assert.notEqual(lastOpen, -1, 'gsd-review-lane-results.jsonl reference is not inside a ```bash fence of write_reviews');
  const after = content.slice(lastOpen);
  const closeIdx = after.indexOf('\n```');
  assert.notEqual(closeIdx, -1, 'unterminated ```bash fence around the gate-check block');
  const body = after.slice(0, closeIdx);
  assert.ok(
    body.includes('ALL_LANES_SKIPPED'),
    'extracted block references JSONL but not ALL_LANES_SKIPPED — wrong block',
  );
  return body;
}

/**
 * #4109 — extract the invoke_reviewers dispatch + join loops, from the
 * "Split ONCE, de-duplicated" comment (immediately before the DISPATCH_SLUGS
 * accumulator at this site) through the block's own closing fence. This span
 * references run_review_lane() and PARALLEL_LANES, both defined earlier in
 * the SAME fence but out of scope for this extractor — callers must prepend
 * a stub (see buildDispatchFixture / DISPATCH_JOIN_STUB below).
 */
function extractDispatchJoinBlock() {
  const content = readWorkflowCombined(REVIEW_WORKFLOW);
  const anchorIdx = content.indexOf('# Split ONCE, de-duplicated');
  assert.notEqual(anchorIdx, -1, 'invoke_reviewers must contain the "Split ONCE, de-duplicated" comment anchor');
  const after = content.slice(anchorIdx);
  const closeIdx = after.indexOf('\n```');
  assert.notEqual(closeIdx, -1, 'unterminated ```bash fence after the dispatch/join anchor');
  const body = after.slice(0, closeIdx);
  assert.ok(body.includes('DISPATCH_SLUGS='), 'extracted span does not include the DISPATCH_SLUGS accumulator — wrong anchor');
  assert.ok(body.includes('wait'), 'extracted span does not include the join `wait` — anchor did not reach the join loop');
  return body;
}

const DISPATCH_JOIN_STUB = 'run_review_lane() { echo "$1" >> "$RUN_DIR/dispatch-log.txt"; }\nPARALLEL_LANES="false"\n';

/** Fixture for the gate-check block: a RUN_DIR with per-slug stub files, no aggregate JSONL. */
function buildGateCheckFixture(slugs, skippedSlugs) {
  const root = createTempDir('gsd-4109-gate-');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir);
  for (const slug of slugs) {
    if (skippedSlugs.includes(slug)) {
      fs.writeFileSync(
        path.join(runDir, `gsd-review-${slug}.md`),
        `${slug} review skipped: prompt budget (500 tokens) too small for the minimum review set.\n`,
      );
    }
  }
  return {
    root,
    runDir,
    env: { SELECTED_REVIEWERS: slugs.join(',') },
  };
}

/**
 * Fixture for the dispatch/join loops: a RUN_DIR and SELECTED_REVIEWERS.
 * RUN_DIR is passed as an env var (not the `{run_dir}` placeholder) because
 * extractDispatchJoinBlock() starts at the "Split ONCE" comment, AFTER the
 * `RUN_DIR="{run_dir}"` assignment earlier in the same real fence — the
 * aggregate/join loop still references `$RUN_DIR` directly, so it must come
 * from the environment here.
 */
function buildDispatchFixture(selectedReviewersCsv) {
  const root = createTempDir('gsd-4109-dispatch-');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir);
  return {
    root,
    runDir,
    env: { SELECTED_REVIEWERS: selectedReviewersCsv, RUN_DIR: runDir },
  };
}

function readDispatchLog(runDir) {
  const content = readIfPresent(path.join(runDir, 'dispatch-log.txt'));
  if (content === null) return [];
  return content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

describe('#3301 build_prompt derives and appends a plan coverage manifest', () => {
  for (const shell of SHELLS) {
    test(`[${shell.name}] zero plans: manifest reports Total plans: 0 and no ids`, (t) => {
      const fx = buildPlanCopyFixture([]);
      t.after(() => cleanup(fx.root));
      const res = runScript(shell, extractPlanCopyBlock(), fx.root, fx.runDir, fx.env);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const manifest = readIfPresent(path.join(fx.runDir, '.plans-manifest.md'));
      assert.notEqual(manifest, null, '.plans-manifest.md must be written even with zero plans');
      assert.match(manifest, /Total plans in this review: 0/);
    });

    test(`[${shell.name}] one plan: manifest lists the single id and count 1`, (t) => {
      const fx = buildPlanCopyFixture(['01-PLAN.md']);
      t.after(() => cleanup(fx.root));
      const res = runScript(shell, extractPlanCopyBlock(), fx.root, fx.runDir, fx.env);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const manifest = readIfPresent(path.join(fx.runDir, '.plans-manifest.md'));
      assert.match(manifest, /Total plans in this review: 1/);
      assert.match(manifest, /^- 01$/m);
    });

    test(`[${shell.name}] decimal-phase ids are preserved verbatim in the manifest`, (t) => {
      const fx = buildPlanCopyFixture(['12.6-01-PLAN.md', '12.6-02-PLAN.md']);
      t.after(() => cleanup(fx.root));
      const res = runScript(shell, extractPlanCopyBlock(), fx.root, fx.runDir, fx.env);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const manifest = readIfPresent(path.join(fx.runDir, '.plans-manifest.md'));
      assert.match(manifest, /Total plans in this review: 2/);
      assert.match(manifest, /^- 12\.6-01$/m);
      assert.match(manifest, /^- 12\.6-02$/m);
    });

    test(`[${shell.name}] manifest is appended to both gsd-review-instructions.md and gsd-review-prompt.md`, (t) => {
      const fx = buildPlanCopyFixture(['01-PLAN.md']);
      t.after(() => cleanup(fx.root));
      // gsd-review-prompt.md is written earlier in build_prompt (the fenced
      // markdown template); simulate that so the append target pre-exists.
      fs.writeFileSync(path.join(fx.runDir, 'gsd-review-prompt.md'), '# prompt\n');
      const res = runScript(shell, extractPlanCopyBlock(), fx.root, fx.runDir, fx.env);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const instructions = readIfPresent(path.join(fx.runDir, 'gsd-review-instructions.md'));
      const prompt = readIfPresent(path.join(fx.runDir, 'gsd-review-prompt.md'));
      assert.match(instructions, /Plan Coverage Manifest/);
      assert.match(prompt, /Plan Coverage Manifest/);
    });
  }

  test('manifest filename does not collide with either existing RUN_DIR glob', () => {
    const name = '.plans-manifest.md';
    assert.ok(!/^gsd-review-.*\.md$/.test(name), 'must not match the gsd-review-*.md reviewer-report glob');
    assert.ok(!/^gsd-review-plan-.*\.md$/.test(name), 'must not match the gsd-review-plan-*.md plan-copy glob');
  });
});

describe('#3301 Review Instructions require one section per manifest id', () => {
  const workflow = readWorkflowCombined(REVIEW_WORKFLOW);

  test('documents mandatory per-id section requirement before cross-plan content', () => {
    assert.ok(
      workflow.includes('Plan Coverage Manifest'),
      'build_prompt prompt template must reference the Plan Coverage Manifest section',
    );
    assert.ok(
      /plan coverage is mandatory/i.test(workflow),
      'Review Instructions must state that plan coverage is mandatory',
    );
  });
});

describe('#3301 write_reviews grades each lane against the plan coverage manifest', () => {
  for (const shell of SHELLS) {
    test(`[${shell.name}] coverage check: complete when every id appears`, (t) => {
      const fx = buildCoverageFixture(['01', '02'], {
        gemini: '## 01\n\nlooks good\n\n## 02\n\nlooks good too\n',
      });
      t.after(() => cleanup(fx.root));
      const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const cov = readCoverageJson(fx.runDir, 'gemini');
      assert.deepEqual(cov, { complete: true, missing_ids: [], total: 2 });
    });

    test(`[${shell.name}] coverage check: reports the specific missing id (the field-observed "6 of 7" case)`, (t) => {
      const ids = ['01', '02', '03', '04', '05', '06', '07'];
      const body = ids
        .filter((id) => id !== '07')
        .map((id) => `## ${id}\n\ncovered\n`)
        .join('\n');
      const fx = buildCoverageFixture(ids, { qwen: body });
      t.after(() => cleanup(fx.root));
      const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const cov = readCoverageJson(fx.runDir, 'qwen');
      assert.strictEqual(cov.complete, false);
      assert.deepEqual(cov.missing_ids, ['07']);
      assert.strictEqual(cov.total, 7);
    });

    test(`[${shell.name}] coverage check: unescaped dot cannot be satisfied by 12X6-01 (issue trap 1)`, (t) => {
      const fx = buildCoverageFixture(['12.6-01'], {
        codex: 'discussion of 12X6-01 but never the real id\n',
      });
      t.after(() => cleanup(fx.root));
      const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const cov = readCoverageJson(fx.runDir, 'codex');
      assert.strictEqual(cov.complete, false, 'unescaped "." would let 12X6-01 wrongly satisfy 12.6-01');
      assert.deepEqual(cov.missing_ids, ['12.6-01']);
    });

    test(`[${shell.name}] coverage check: a hyphen-prefixed token (T-04-07) does not satisfy id 04-07 (issue trap 2)`, (t) => {
      const fx = buildCoverageFixture(['04-07'], {
        claude: 'six sections away, threat id T-04-07 is discussed at length\n',
      });
      t.after(() => cleanup(fx.root));
      const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const cov = readCoverageJson(fx.runDir, 'claude');
      assert.strictEqual(cov.complete, false, 'a preceding hyphen must not count as a boundary for id 04-07');
      assert.deepEqual(cov.missing_ids, ['04-07']);
    });

    test(`[${shell.name}] coverage check: a plain-prose mention counts as covered, no heading required`, (t) => {
      const fx = buildCoverageFixture(['12.6-01'], {
        gemini: 'This was already covered by plan 12.6-01 above, no separate section needed.\n',
      });
      t.after(() => cleanup(fx.root));
      const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const cov = readCoverageJson(fx.runDir, 'gemini');
      assert.strictEqual(cov.complete, true);
    });

    test(`[${shell.name}] coverage check: a budget-skipped stub is not graded`, (t) => {
      const fx = buildCoverageFixture(['01'], {
        ollama: 'ollama review skipped: prompt budget (500 tokens) too small for the minimum review set.\n',
      });
      t.after(() => cleanup(fx.root));
      const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      assert.strictEqual(readCoverageJson(fx.runDir, 'ollama'), null, 'a budget-skip stub must not be graded');
    });

    test(`[${shell.name}] coverage check: an empty review file is not graded`, (t) => {
      const fx = buildCoverageFixture(['01'], { codex: '' });
      t.after(() => cleanup(fx.root));
      const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      assert.strictEqual(readCoverageJson(fx.runDir, 'codex'), null, 'an empty review file must not be graded');
    });

    test(`[${shell.name}] coverage check: coderabbit lane is exempt from plan-coverage grading`, (t) => {
      const fx = buildCoverageFixture(['01', '02'], {
        coderabbit: 'diff-only review, mentions nothing about plans\n',
      });
      t.after(() => cleanup(fx.root));
      const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      assert.strictEqual(
        readCoverageJson(fx.runDir, 'coderabbit'),
        null,
        'coderabbit never receives the source-grounding prompt and must not be graded',
      );
    });
  }

  test('structural: no lane slug other than coderabbit is hardcoded-excluded (the exemption is named, not general)', () => {
    const offenders = extractAllBashBlocks().filter((b) => /\[\s*"\$SLUG"\s*=\s*"(?!coderabbit)/.test(b));
    assert.deepEqual(offenders, [], 'only the coderabbit exemption may hardcode a slug comparison');
  });

  test('structural: no bare-unquoted DISPATCH_SLUGS consumption remains (#4109)', () => {
    const offenders = extractAllBashBlocks().filter((b) => /for SLUG in \$DISPATCH_SLUGS;/.test(b));
    assert.deepEqual(offenders, [], 'DISPATCH_SLUGS must be quoted or word-split explicitly, not consumed bare — zsh does not IFS-split an unquoted scalar');
  });
});

describe('#3301 REVIEWS.md documents the plan_coverage frontmatter key', () => {
  const workflow = readWorkflowCombined(REVIEW_WORKFLOW);

  test('documents plan_coverage: frontmatter is present only when a lane is incomplete', () => {
    assert.ok(workflow.includes('plan_coverage'), 'write_reviews must document a plan_coverage frontmatter key');
    assert.ok(
      /plan_coverage.*only present if at least one/is.test(workflow),
      'plan_coverage must be documented as present only when at least one graded lane is incomplete',
    );
  });
});

/**
 * #4109 — a zsh word-splitting bug: DISPATCH_SLUGS is built as a
 * space-separated scalar accumulator and consumed via unquoted
 * `for SLUG in $DISPATCH_SLUGS; do`. Bash IFS-splits an unquoted scalar by
 * default; zsh does not, so the entire accumulator (leading space and all)
 * collapses onto ONE bogus iteration under zsh whenever 2+ reviewers are
 * selected. These rows extract the REAL shipped bash from the two remaining
 * untested sites (write_reviews' gate-check block, and invoke_reviewers'
 * dispatch + join loops) and execute it under both shells.
 */
describe('#4109 gate-check counts every dispatched reviewer under both shells', () => {
  for (const shell of SHELLS) {
    test(`[${shell.name}] 2 reviewers both skipped: dispatched=2 skipped=2 all_lanes_skipped=true`, (t) => {
      const fx = buildGateCheckFixture(['claude', 'codex'], ['claude', 'codex']);
      t.after(() => cleanup(fx.root));
      const body = extractGateCheckBlock()
        + '\necho "{\\"dispatched_count\\":${DISPATCHED_COUNT:-0},\\"skipped_count\\":${SKIPPED_COUNT:-0},'
        + '\\"all_lanes_skipped\\":\\"${ALL_LANES_SKIPPED:-false}\\",\\"total_lane_failure\\":\\"${TOTAL_LANE_FAILURE:-false}\\"}"\n';
      const res = runScript(shell, body, fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const out = JSON.parse(res.stdout.trim());
      assert.strictEqual(out.dispatched_count, 2, `expected 2 dispatched slugs, got ${res.stdout}`);
      assert.strictEqual(out.skipped_count, 2, `expected 2 skipped slugs, got ${res.stdout}`);
      assert.strictEqual(out.all_lanes_skipped, 'true');
      assert.strictEqual(out.total_lane_failure, 'false');
    });

    test(`[${shell.name}] mixed skip and total failure: dispatched=2 skipped=1 total_lane_failure=true`, (t) => {
      const fx = buildGateCheckFixture(['claude', 'codex'], ['claude']);
      t.after(() => cleanup(fx.root));
      const body = extractGateCheckBlock()
        + '\necho "{\\"dispatched_count\\":${DISPATCHED_COUNT:-0},\\"skipped_count\\":${SKIPPED_COUNT:-0},'
        + '\\"all_lanes_skipped\\":\\"${ALL_LANES_SKIPPED:-false}\\",\\"total_lane_failure\\":\\"${TOTAL_LANE_FAILURE:-false}\\"}"\n';
      const res = runScript(shell, body, fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const out = JSON.parse(res.stdout.trim());
      assert.strictEqual(out.dispatched_count, 2, `expected 2 dispatched slugs, got ${res.stdout}`);
      assert.strictEqual(out.skipped_count, 1, `expected 1 skipped slug, got ${res.stdout}`);
      assert.strictEqual(out.all_lanes_skipped, 'false');
      assert.strictEqual(out.total_lane_failure, 'true');
    });

    test(`[${shell.name}] single reviewer still counts correctly (boundary)`, (t) => {
      const fx = buildGateCheckFixture(['claude'], ['claude']);
      t.after(() => cleanup(fx.root));
      const body = extractGateCheckBlock()
        + '\necho "{\\"dispatched_count\\":${DISPATCHED_COUNT:-0},\\"skipped_count\\":${SKIPPED_COUNT:-0},'
        + '\\"all_lanes_skipped\\":\\"${ALL_LANES_SKIPPED:-false}\\",\\"total_lane_failure\\":\\"${TOTAL_LANE_FAILURE:-false}\\"}"\n';
      const res = runScript(shell, body, fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const out = JSON.parse(res.stdout.trim());
      assert.strictEqual(out.dispatched_count, 1, `expected 1 dispatched slug, got ${res.stdout}`);
      assert.strictEqual(out.skipped_count, 1, `expected 1 skipped slug, got ${res.stdout}`);
      assert.strictEqual(out.all_lanes_skipped, 'true');
    });

    test(`[${shell.name}] 3 reviewers all skipped (boundary)`, (t) => {
      const fx = buildGateCheckFixture(['claude', 'codex', 'gemini'], ['claude', 'codex', 'gemini']);
      t.after(() => cleanup(fx.root));
      const body = extractGateCheckBlock()
        + '\necho "{\\"dispatched_count\\":${DISPATCHED_COUNT:-0},\\"skipped_count\\":${SKIPPED_COUNT:-0},'
        + '\\"all_lanes_skipped\\":\\"${ALL_LANES_SKIPPED:-false}\\",\\"total_lane_failure\\":\\"${TOTAL_LANE_FAILURE:-false}\\"}"\n';
      const res = runScript(shell, body, fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const out = JSON.parse(res.stdout.trim());
      assert.strictEqual(out.dispatched_count, 3, `expected 3 dispatched slugs, got ${res.stdout}`);
      assert.strictEqual(out.skipped_count, 3, `expected 3 skipped slugs, got ${res.stdout}`);
      assert.strictEqual(out.all_lanes_skipped, 'true');
    });
  }
});

describe('#4109 invoke_reviewers dispatches every deduped reviewer exactly once under both shells', () => {
  for (const shell of SHELLS) {
    test(`[${shell.name}] 2 reviewers each dispatched exactly once`, (t) => {
      const fx = buildDispatchFixture('claude,codex');
      t.after(() => cleanup(fx.root));
      const body = DISPATCH_JOIN_STUB + '\n' + extractDispatchJoinBlock();
      const res = runScript(shell, body, fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const lines = readDispatchLog(fx.runDir);
      assert.deepEqual(lines, ['claude', 'codex']);
    });

    test(`[${shell.name}] duplicate slug in SELECTED_REVIEWERS deduped, dispatched once`, (t) => {
      const fx = buildDispatchFixture('claude,codex,claude');
      t.after(() => cleanup(fx.root));
      const body = DISPATCH_JOIN_STUB + '\n' + extractDispatchJoinBlock();
      const res = runScript(shell, body, fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const lines = readDispatchLog(fx.runDir);
      assert.deepEqual(lines, ['claude', 'codex']);
    });

    test(`[${shell.name}] 3 reviewers each dispatched exactly once (boundary)`, (t) => {
      const fx = buildDispatchFixture('claude,codex,gemini');
      t.after(() => cleanup(fx.root));
      const body = DISPATCH_JOIN_STUB + '\n' + extractDispatchJoinBlock();
      const res = runScript(shell, body, fx.root, fx.runDir, fx.env, REPO_ROOT);
      assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
      const lines = readDispatchLog(fx.runDir);
      assert.deepEqual(lines, ['claude', 'codex', 'gemini']);
    });
  }
});

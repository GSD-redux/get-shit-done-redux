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

function detectShells() {
  const shells = [{ name: 'bash', cmd: 'bash' }];
  const probe = spawnSync('zsh', ['-c', 'exit 0'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true });
  if (!probe.error && probe.status === 0) shells.push({ name: 'zsh', cmd: 'zsh' });
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
  const anchorIdx = fromStep.indexOf('.plans-manifest.md');
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

function runScript(shell, body, root, runDir, env) {
  const scriptPath = stageScript(shell, body, root, runDir);
  return spawnSync(shell.cmd, [scriptPath], {
    cwd: root,
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

describe('#3301 build_prompt derives and appends a plan coverage manifest', () => {
  for (const shell of SHELLS) {
    test(`[${shell.name}] zero plans: manifest reports Total plans: 0 and no ids`, () => {
      const fx = buildPlanCopyFixture([]);
      try {
        const res = runScript(shell, extractPlanCopyBlock(), fx.root, fx.runDir, fx.env);
        assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
        const manifest = readIfPresent(path.join(fx.runDir, '.plans-manifest.md'));
        assert.notEqual(manifest, null, '.plans-manifest.md must be written even with zero plans');
        assert.match(manifest, /Total plans in this review: 0/);
      } finally {
        cleanup(fx.root);
      }
    });

    test(`[${shell.name}] one plan: manifest lists the single id and count 1`, () => {
      const fx = buildPlanCopyFixture(['01-PLAN.md']);
      try {
        const res = runScript(shell, extractPlanCopyBlock(), fx.root, fx.runDir, fx.env);
        assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
        const manifest = readIfPresent(path.join(fx.runDir, '.plans-manifest.md'));
        assert.match(manifest, /Total plans in this review: 1/);
        assert.match(manifest, /^- 01$/m);
      } finally {
        cleanup(fx.root);
      }
    });

    test(`[${shell.name}] decimal-phase ids are preserved verbatim in the manifest`, () => {
      const fx = buildPlanCopyFixture(['12.6-01-PLAN.md', '12.6-02-PLAN.md']);
      try {
        const res = runScript(shell, extractPlanCopyBlock(), fx.root, fx.runDir, fx.env);
        assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
        const manifest = readIfPresent(path.join(fx.runDir, '.plans-manifest.md'));
        assert.match(manifest, /Total plans in this review: 2/);
        assert.match(manifest, /^- 12\.6-01$/m);
        assert.match(manifest, /^- 12\.6-02$/m);
      } finally {
        cleanup(fx.root);
      }
    });

    test(`[${shell.name}] manifest is appended to both gsd-review-instructions.md and gsd-review-prompt.md`, () => {
      const fx = buildPlanCopyFixture(['01-PLAN.md']);
      // gsd-review-prompt.md is written earlier in build_prompt (the fenced
      // markdown template); simulate that so the append target pre-exists.
      fs.writeFileSync(path.join(fx.runDir, 'gsd-review-prompt.md'), '# prompt\n');
      try {
        const res = runScript(shell, extractPlanCopyBlock(), fx.root, fx.runDir, fx.env);
        assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
        const instructions = readIfPresent(path.join(fx.runDir, 'gsd-review-instructions.md'));
        const prompt = readIfPresent(path.join(fx.runDir, 'gsd-review-prompt.md'));
        assert.match(instructions, /Plan Coverage Manifest/);
        assert.match(prompt, /Plan Coverage Manifest/);
      } finally {
        cleanup(fx.root);
      }
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
    test(`[${shell.name}] coverage check: complete when every id appears`, () => {
      const fx = buildCoverageFixture(['01', '02'], {
        gemini: '## 01\n\nlooks good\n\n## 02\n\nlooks good too\n',
      });
      try {
        const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env);
        assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
        const cov = readCoverageJson(fx.runDir, 'gemini');
        assert.deepEqual(cov, { complete: true, missing_ids: [], total: 2 });
      } finally {
        cleanup(fx.root);
      }
    });

    test(`[${shell.name}] coverage check: reports the specific missing id (the field-observed "6 of 7" case)`, () => {
      const ids = ['01', '02', '03', '04', '05', '06', '07'];
      const body = ids
        .filter((id) => id !== '07')
        .map((id) => `## ${id}\n\ncovered\n`)
        .join('\n');
      const fx = buildCoverageFixture(ids, { qwen: body });
      try {
        const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env);
        assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
        const cov = readCoverageJson(fx.runDir, 'qwen');
        assert.strictEqual(cov.complete, false);
        assert.deepEqual(cov.missing_ids, ['07']);
        assert.strictEqual(cov.total, 7);
      } finally {
        cleanup(fx.root);
      }
    });

    test(`[${shell.name}] coverage check: unescaped dot cannot be satisfied by 12X6-01 (issue trap 1)`, () => {
      const fx = buildCoverageFixture(['12.6-01'], {
        codex: 'discussion of 12X6-01 but never the real id\n',
      });
      try {
        const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env);
        assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
        const cov = readCoverageJson(fx.runDir, 'codex');
        assert.strictEqual(cov.complete, false, 'unescaped "." would let 12X6-01 wrongly satisfy 12.6-01');
        assert.deepEqual(cov.missing_ids, ['12.6-01']);
      } finally {
        cleanup(fx.root);
      }
    });

    test(`[${shell.name}] coverage check: a hyphen-prefixed token (T-04-07) does not satisfy id 04-07 (issue trap 2)`, () => {
      const fx = buildCoverageFixture(['04-07'], {
        claude: 'six sections away, threat id T-04-07 is discussed at length\n',
      });
      try {
        const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env);
        assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
        const cov = readCoverageJson(fx.runDir, 'claude');
        assert.strictEqual(cov.complete, false, 'a preceding hyphen must not count as a boundary for id 04-07');
        assert.deepEqual(cov.missing_ids, ['04-07']);
      } finally {
        cleanup(fx.root);
      }
    });

    test(`[${shell.name}] coverage check: a plain-prose mention counts as covered, no heading required`, () => {
      const fx = buildCoverageFixture(['12.6-01'], {
        gemini: 'This was already covered by plan 12.6-01 above, no separate section needed.\n',
      });
      try {
        const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env);
        assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
        const cov = readCoverageJson(fx.runDir, 'gemini');
        assert.strictEqual(cov.complete, true);
      } finally {
        cleanup(fx.root);
      }
    });

    test(`[${shell.name}] coverage check: a budget-skipped stub is not graded`, () => {
      const fx = buildCoverageFixture(['01'], {
        ollama: 'ollama review skipped: prompt budget (500 tokens) too small for the minimum review set.\n',
      });
      try {
        const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env);
        assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
        assert.strictEqual(readCoverageJson(fx.runDir, 'ollama'), null, 'a budget-skip stub must not be graded');
      } finally {
        cleanup(fx.root);
      }
    });

    test(`[${shell.name}] coverage check: an empty review file is not graded`, () => {
      const fx = buildCoverageFixture(['01'], { codex: '' });
      try {
        const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env);
        assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
        assert.strictEqual(readCoverageJson(fx.runDir, 'codex'), null, 'an empty review file must not be graded');
      } finally {
        cleanup(fx.root);
      }
    });

    test(`[${shell.name}] coverage check: coderabbit lane is exempt from plan-coverage grading`, () => {
      const fx = buildCoverageFixture(['01', '02'], {
        coderabbit: 'diff-only review, mentions nothing about plans\n',
      });
      try {
        const res = runScript(shell, extractCoverageCheckBlock(), fx.root, fx.runDir, fx.env);
        assert.strictEqual(res.status, 0, `block exited ${res.status}: ${res.stderr}`);
        assert.strictEqual(
          readCoverageJson(fx.runDir, 'coderabbit'),
          null,
          'coderabbit never receives the source-grounding prompt and must not be graded',
        );
      } finally {
        cleanup(fx.root);
      }
    });
  }

  test('structural: no lane slug other than coderabbit is hardcoded-excluded (the exemption is named, not general)', () => {
    const offenders = extractAllBashBlocks().filter((b) => /\[\s*"\$SLUG"\s*=\s*"(?!coderabbit)/.test(b));
    assert.deepEqual(offenders, [], 'only the coderabbit exemption may hardcode a slug comparison');
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

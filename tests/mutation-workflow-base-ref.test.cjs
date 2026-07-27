'use strict';

/**
 * tests/mutation-workflow-base-ref.test.cjs
 *
 * Regression tests for the mutation-gate base-ref fetch (issue #2452).
 *
 * Background: `.github/workflows/mutation.yml` checks out with `fetch-depth: 0`
 * (full history) and then re-fetched the base branch with `--depth=1`. That
 * shallow re-fetch truncates the base ref's ancestry, so the three-dot diff in
 * scripts/mutation-matrix.cjs (`git diff --name-only origin/<base>...HEAD`)
 * can no longer compute a merge base and aborts with
 * `fatal: origin/next...HEAD: no merge base`, exit 2. The `detect` job then
 * fails and the `mutate` shards never run — the 80% mutation-score threshold
 * goes UNVERIFIED rather than enforced.
 *
 * The failure is branch-position dependent, which is why it went unnoticed: a
 * branch already level with the base incidentally passes (its merge base IS
 * the single fetched commit), while a branch that is BEHIND the base fails.
 *
 * Test 1 is the contract guard (RED on origin/next, GREEN after the fix).
 * Test 2 is a real-git mechanism proof: it reconstructs the runner's ref
 * topology in a temp repo and demonstrates that the shallow fetch breaks the
 * three-dot diff while a full fetch resolves it — proving the fix is both
 * necessary and sufficient rather than asserting on YAML text alone.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const helpers = require('./helpers.cjs');

const WORKFLOWS_DIR = path.resolve(__dirname, '..', '.github', 'workflows');

/**
 * Every workflow whose lint step diffs against the base with the three-dot
 * form (`origin/<base>...HEAD`). All of them need the BASE REF's ancestry, so
 * none may shallow-fetch it. mutation.yml used --depth=1 and failed outright;
 * the other two used --depth=50, shrinking the window further still.
 *
 * This guard covers the base-ref FETCH only. The shallow *checkout* depth on
 * changeset-required.yml / docs-required.yml is a separate, deliberate cost
 * control with fail-closed semantics, owned by
 * tests/policy-lint-shallow-checkout.test.cjs — do not conflate the two.
 */
const THREE_DOT_WORKFLOWS = [
  { file: 'mutation.yml', consumer: 'scripts/mutation-matrix.cjs' },
  { file: 'changeset-required.yml', consumer: 'scripts/changeset/lint.cjs' },
  { file: 'docs-required.yml', consumer: 'scripts/lint-docs-required.cjs' },
];

// Bounded: git subprocesses in tests must never hang a CI lane.
const GIT_TIMEOUT_MS = 30_000;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Extract the `run:` body of the named step from the workflow YAML.
 * Deliberately a small hand parser rather than a YAML dep: this asserts on the
 * literal command line the runner executes, which is the contract at issue.
 *
 * Handles both inline (`run: git fetch ...`) and block-scalar (`run: |`) forms;
 * a block scalar returns its dedented body so a future refactor to multi-line
 * `run:` cannot silently degrade the guard into asserting on the literal "|".
 * Comment lines are skipped so a commented-out step of the same name cannot
 * shadow the real one.
 */
function runBodyForStep(yaml, stepName) {
  const lines = yaml.split(/\r?\n/);
  const nameIdx = lines.findIndex(
    (l) => !/^\s*#/.test(l) && l.includes(`- name: ${stepName}`),
  );
  if (nameIdx === -1) return null;

  for (let i = nameIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // Next step begins -> the step had no run: body.
    if (/^\s*- name:/.test(line) && !/^\s*#/.test(line)) return null;
    const m = line.match(/^\s*run:\s*(.*)$/);
    if (!m) continue;

    const inline = m[1].trim();
    if (!/^[|>][-+]?$/.test(inline)) return inline;

    // Block scalar: collect the indented body until the indentation drops.
    const runIndent = line.match(/^(\s*)/)[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const bodyLine = lines[j];
      if (bodyLine.trim() === '') {
        body.push('');
        continue;
      }
      const indent = bodyLine.match(/^(\s*)/)[1].length;
      if (indent <= runIndent) break;
      body.push(bodyLine.trim());
    }
    return body.join('\n').trim();
  }
  return null;
}

describe('#2452 CI gates: base-ref fetch must preserve ancestry', () => {
  for (const { file, consumer } of THREE_DOT_WORKFLOWS) {
    test(`${file}: "Fetch base ref for diff" does not shallow-fetch the base`, () => {
      const yaml = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
      const runBody = runBodyForStep(yaml, 'Fetch base ref for diff');

      assert.ok(
        runBody,
        `Expected a "Fetch base ref for diff" step with a run: body in ${file}. ` +
          'If the step was renamed, update this test to match — do not delete the guard.',
      );

      assert.ok(
        runBody.startsWith('git fetch origin'),
        `Expected the step to fetch the base ref, got: ${runBody}`,
      );

      assert.ok(
        !/--depth[=\s]/.test(runBody),
        `${file}: the base-ref fetch must NOT be shallow. A --depth fetch truncates ` +
          "the base branch's ancestry, so the three-dot diff in " +
          `${consumer} cannot compute a merge base and the job dies with ` +
          '`fatal: ...: no merge base` (#2452). Offending command: ' +
          runBody,
      );
    });
  }

  // How far the base branch advances past the branch point. Chosen so the
  // merge base sits OUTSIDE the old --depth=50 window, making the boundary
  // between "cushion masks the bug" and "cushion exhausted" directly testable.
  const BASE_ADVANCE = 60;
  // Base chain is: tip … BASE_ADVANCE commits … branch point. So the branch
  // point is the (BASE_ADVANCE + 1)-th commit from the tip — the exact depth
  // at which a shallow base fetch first contains a usable merge base.
  const MERGE_BASE_DEPTH = BASE_ADVANCE + 1;

  test('base-ref fetch depth determines whether the three-dot diff resolves', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2452-'));
    try {
      // ---- origin: a base branch that advances past a feature branch --------
      const origin = path.join(tmp, 'origin');
      fs.mkdirSync(origin);
      git(origin, ['init', '--quiet', '--initial-branch=base']);
      git(origin, ['config', 'user.email', 'test@example.com']);
      git(origin, ['config', 'user.name', 'Test']);
      // Ambient commit.gpgsign=true would otherwise break these commits in CI.
      git(origin, ['config', 'commit.gpgsign', 'false']);

      fs.writeFileSync(path.join(origin, 'seed.txt'), 'seed\n');
      git(origin, ['add', '.']);
      git(origin, ['commit', '--quiet', '-m', 'seed']);

      // Feature branch diverges here — this commit is the merge base.
      git(origin, ['checkout', '--quiet', '-b', 'feature']);
      fs.writeFileSync(path.join(origin, 'covered.cts'), 'export const x = 1;\n');
      git(origin, ['add', '.']);
      git(origin, ['commit', '--quiet', '-m', 'feature change']);

      // Base then advances, leaving `feature` BEHIND — the failing condition.
      git(origin, ['checkout', '--quiet', 'base']);
      for (let n = 1; n <= BASE_ADVANCE; n++) {
        fs.writeFileSync(path.join(origin, `base-${n}.txt`), `${n}\n`);
        git(origin, ['add', '.']);
        git(origin, ['commit', '--quiet', '-m', `base advance ${n}`]);
      }

      // ---- runner: has the PR head, must fetch the base ref separately ------
      // Each variant gets its OWN clone, modelling independent workflow runs.
      // They must not share a repo: once a shallow fetch writes a .git/shallow
      // boundary, a later plain `git fetch` does NOT un-shallow it (that needs
      // --unshallow), so repairing in place would test a scenario the workflow
      // never encounters.
      function runnerDiff(name, baseFetchArgs) {
        const dir = path.join(tmp, name);
        fs.mkdirSync(dir);
        git(dir, ['init', '--quiet']);
        git(dir, ['config', 'user.email', 'test@example.com']);
        git(dir, ['config', 'user.name', 'Test']);
        git(dir, ['config', 'commit.gpgsign', 'false']);
        git(dir, ['remote', 'add', 'origin', origin]);
        git(dir, ['fetch', '--quiet', 'origin', 'feature']);
        git(dir, ['checkout', '--quiet', 'FETCH_HEAD']);
        // The FETCH is inside the try, not before it. A base fetch whose shallow
        // boundary lands short of the merge base can fail during the FETCH itself
        // ("unable to parse commit" — the boundary commit's parent is unavailable)
        // rather than succeeding and leaving the DIFF to fail with "no merge base".
        // Which of the two git picks is version/transport dependent: this test
        // passed on ubuntu-22 and windows-24 and failed on ubuntu-24 for the same
        // commit. Both outcomes mean the same thing for what this guard protects —
        // a shallow base ref cannot resolve the three-dot diff — so both are
        // recorded as ok:false instead of one of them escaping as a crash.
        try {
          git(dir, ['fetch', '--quiet', 'origin', 'base', ...baseFetchArgs]);
          return { ok: true, out: git(dir, ['diff', '--name-only', 'origin/base...HEAD']).trim() };
        } catch (err) {
          return { ok: false, err: String(err.stderr || err.message) };
        }
      }

      // (a) --depth=1 — mutation.yml's pre-fix command. Always broken.
      const depth1 = runnerDiff('runner-depth-1', ['--depth=1']);
      assert.equal(
        depth1.ok,
        false,
        'Expected the three-dot diff to FAIL after a --depth=1 base fetch. ' +
          'If this stops holding, the #2452 mechanism no longer reproduces and ' +
          'this guard needs revisiting.',
      );
      // Asserting git's exact wording couples this guard to a git version:
      // "no merge base" (diff-time) and "unable to parse commit" (fetch-time)
      // are the same condition reported at different stages. CONTRIBUTING also
      // prohibits raw text matching on subprocess output — the typed outcome
      // above (`ok === false`) IS the contract this test exists to pin.
      assert.ok(depth1.err.length > 0, 'a failed shallow diff must report a cause');

      // (b) BOUNDARY, just below: the merge base is one commit out of reach.
      // This is the changeset-required.yml / docs-required.yml --depth=50 case
      // generalized — the cushion only ever postponed the same failure.
      const below = runnerDiff('runner-depth-below', [`--depth=${MERGE_BASE_DEPTH - 1}`]);
      assert.equal(
        below.ok,
        false,
        `Expected FAIL at --depth=${MERGE_BASE_DEPTH - 1} (merge base one commit ` +
          'beyond the shallow boundary) — this is why a bounded cushion is not a fix',
      );
      assert.ok(below.err.length > 0, 'a failed shallow diff must report a cause');

      // (c) BOUNDARY, exactly deep enough: the merge base is the last commit in.
      const atDepth = runnerDiff('runner-depth-at', [`--depth=${MERGE_BASE_DEPTH}`]);
      assert.equal(
        atDepth.ok,
        true,
        `Expected SUCCESS at --depth=${MERGE_BASE_DEPTH} (merge base exactly at the ` +
          `shallow boundary), got: ${atDepth.err}`,
      );
      assert.equal(atDepth.out, 'covered.cts');

      // (d) Unbounded — the shipped fix. Correct regardless of how far behind.
      const full = runnerDiff('runner-full', []);
      assert.equal(full.ok, true, `Expected the full-fetch diff to succeed, got: ${full.err}`);
      assert.equal(
        full.out,
        'covered.cts',
        'After a full base fetch the three-dot diff must resolve and report ' +
          "exactly the feature branch's changed files",
      );
    } finally {
      helpers.cleanup(tmp);
    }
  });
});

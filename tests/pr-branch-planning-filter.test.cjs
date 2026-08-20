'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Failing-first suite for issue #2971 — `/gsd-pr-branch`'s `.planning/` path
 * filter grows a `planning.pr_strict` config switch and its `verify` step
 * stops contradicting the `create_pr_branch` step it is supposed to validate.
 *
 * `tests/helpers/pr-branch-filter.cjs` is the seam this file drives: it
 * PARSES the two shell declarations (`TRANSIENT_DIRS="..."` and
 * `STRUCTURAL_RE="..."`) straight out of `gsd-core/workflows/pr-branch.md`,
 * so the shipped workflow — not a second, hand-copied list in this test file
 * — is the single source of truth for which `.planning/` subdirectories are
 * "transient" and which structural files are carved out of the default
 * filter. Nothing below hardcodes a transient-dir or structural-file list;
 * every layer either builds an inline fixture text and feeds it through
 * `parseWorkflow`, or reads the real shipped file through `readWorkflow`.
 *
 * Six layers, in order:
 *   L1 — pure predicates over an inline workflow-text fixture (no disk, no
 *        subprocess): `classifyCommit` / `forbiddenPaths` / `structuralPaths`
 *        / `otherPlanningPaths` against hand-picked and boundary path lists.
 *   L2 — the real `create_pr_branch` cherry-pick-and-filter recipe, executed
 *        against real git fixtures via `sh -c`. Pins two defects reproduced
 *        empirically against today's shipped recipe (accidental deletion of
 *        untouched base `.planning/` content; a second commit silently
 *        dropped by an "untracked working tree files would be overwritten"
 *        cherry-pick abort) and proves both filter modes end-to-end.
 *   L3 — `planning.pr_strict` registration through the real CLI/config
 *        surfaces: `config-get`/`config-set`, the schema manifest, the
 *        defaults manifest, and `loadConfig`'s flat-root-alias behavior.
 *   L4 — the issue's load-bearing worktree claim, EXECUTED against a real
 *        `git worktree add`, not merely asserted.
 *   L5 — fast-check properties over the pure predicates, seeded and bounded.
 *   L6 — a drift guard over the shipped workflow's prose: this is the one
 *        layer allowed to source-grep, because the `.md` text IS the runtime
 *        contract GSD loads (CONTRIBUTING.md's source-text-is-the-product
 *        exception; the `local/no-source-grep` ESLint rule only covers
 *        `.cjs`/`.js`/`.ts`, never `.md`).
 *
 * Per CLAUDE.md's failing-first regression protocol, most of L1-L6 is
 * EXPECTED to fail until the #2971 implementation lands `planning.pr_strict`
 * in the config manifests/loader and rewrites `pr-branch.md`'s
 * `create_pr_branch`/`verify` steps. No assertion here is softened,
 * try/caught, or skipped to paper over that — a thrown `parseWorkflow` /
 * `readWorkflow` error inside an individual `test()` body is a truthful,
 * individually-attributable failure, not a suite crash, because every call
 * to `readWorkflow()` happens inside a `test()` body rather than at
 * `describe()`-collection time.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  cleanup, createTempProject, runGsdTools, readFileNormalized,
} = require('./helpers.cjs');
const { gitOrThrow, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/git-fixture.cjs');
const {
  WORKFLOW_PATH,
  parseWorkflow,
  readWorkflow,
  extractPickLoop,
  forbiddenRegex,
  forbiddenPaths,
  structuralPaths,
  classifyCommit,
  otherPlanningPaths,
} = require('./helpers/pr-branch-filter.cjs');
const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_DEFAULTS_MANIFEST_PATH = path.join(
  REPO_ROOT, 'gsd-core', 'bin', 'shared', 'config-defaults.manifest.json',
);
const CONFIG_SCHEMA_MANIFEST_PATH = path.join(
  REPO_ROOT, 'gsd-core', 'bin', 'shared', 'config-schema.manifest.json',
);

// ── Shared git-fixture primitives (L2 + L4) ────────────────────────────────

function git(args, cwd) {
  return gitOrThrow(args, { cwd, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['-c', 'init.defaultBranch=main', 'init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test User'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir);
}

function uniqueTmpPath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('#2971 — pr-branch.md planning.pr_strict filter (failing-first)', () => {
  // ── L1: pure predicates (inline text fixtures, no disk) ─────────────────
  describe('L1: pure predicates over an inline workflow-text fixture', () => {
    const FIXTURE_TEXT = [
      'TRANSIENT_DIRS="phases quick research threads todos debug seeds codebase ui-reviews"',
      'STRUCTURAL_RE="^\\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\\.md$|^\\.planning/milestones/"',
    ].join('\n');
    const fixture = parseWorkflow(FIXTURE_TEXT);
    const strictOpts = { strict: true, transientDirs: fixture.transientDirs, structuralRe: fixture.structuralRe };
    const defaultOpts = { strict: false, transientDirs: fixture.transientDirs, structuralRe: fixture.structuralRe };

    test('1: [src/a.ts] includes in both modes', () => {
      assert.strictEqual(classifyCommit(['src/a.ts'], strictOpts), 'include');
      assert.strictEqual(classifyCommit(['src/a.ts'], defaultOpts), 'include');
    });

    test('2: [src/a.ts, .planning/phases/PLAN.md] includes in both modes', () => {
      const files = ['src/a.ts', '.planning/phases/PLAN.md'];
      assert.strictEqual(classifyCommit(files, strictOpts), 'include');
      assert.strictEqual(classifyCommit(files, defaultOpts), 'include');
    });

    test('3: [.planning/phases/PLAN.md] excludes in both modes', () => {
      const files = ['.planning/phases/PLAN.md'];
      assert.strictEqual(classifyCommit(files, strictOpts), 'exclude');
      assert.strictEqual(classifyCommit(files, defaultOpts), 'exclude');
    });

    test('4: [.planning/STATE.md] includes default, excludes strict', () => {
      const files = ['.planning/STATE.md'];
      assert.strictEqual(classifyCommit(files, defaultOpts), 'include');
      assert.strictEqual(classifyCommit(files, strictOpts), 'exclude');
    });

    test('5: [.planning/milestones/m1/x.md] includes default, excludes strict', () => {
      const files = ['.planning/milestones/m1/x.md'];
      assert.strictEqual(classifyCommit(files, defaultOpts), 'include');
      assert.strictEqual(classifyCommit(files, strictOpts), 'exclude');
    });

    test('6: [.planning/config.json] excludes in both modes (third bucket)', () => {
      const files = ['.planning/config.json'];
      assert.strictEqual(classifyCommit(files, defaultOpts), 'exclude');
      assert.strictEqual(classifyCommit(files, strictOpts), 'exclude');
    });

    test('7: [] excludes in both modes', () => {
      assert.strictEqual(classifyCommit([], defaultOpts), 'exclude');
      assert.strictEqual(classifyCommit([], strictOpts), 'exclude');
    });

    test('8: [.planning/STATE.md, src/a.ts] — forbiddenPaths [] default, [.planning/STATE.md] strict', () => {
      const files = ['.planning/STATE.md', 'src/a.ts'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
      assert.deepStrictEqual(forbiddenPaths(files, strictOpts), ['.planning/STATE.md']);
    });

    test('9: LOOKALIKE [src/planning-inspect.cts] — forbiddenPaths [] in both modes', () => {
      const files = ['src/planning-inspect.cts'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
      assert.deepStrictEqual(forbiddenPaths(files, strictOpts), []);
    });

    test('10: LOOKALIKE [.planning-notes/x.md] — forbiddenPaths [] in both modes', () => {
      const files = ['.planning-notes/x.md'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
      assert.deepStrictEqual(forbiddenPaths(files, strictOpts), []);
    });

    test('11: LOOKALIKE [.planningX/x.md] — forbiddenPaths [] in both modes', () => {
      const files = ['.planningX/x.md'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
      assert.deepStrictEqual(forbiddenPaths(files, strictOpts), []);
    });

    test('12: BOUNDARY [.planning/phases.md] (file, stem equals a transient dir) — not forbidden default, forbidden strict', () => {
      const files = ['.planning/phases.md'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
      assert.deepStrictEqual(forbiddenPaths(files, strictOpts), ['.planning/phases.md']);
    });

    test('13: BOUNDARY [.planning/phases/x.md] forbidden in both modes', () => {
      const files = ['.planning/phases/x.md'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), ['.planning/phases/x.md']);
      assert.deepStrictEqual(forbiddenPaths(files, strictOpts), ['.planning/phases/x.md']);
    });

    test('14: every parsed transient dir forbids .planning/<d>/f.md in default mode', () => {
      for (const d of fixture.transientDirs) {
        const p = `.planning/${d}/f.md`;
        assert.deepStrictEqual(
          forbiddenPaths([p], defaultOpts), [p],
          `expected ${p} to be forbidden in default mode`,
        );
      }
    });

    test('15: every structural file is not forbidden default, forbidden strict', () => {
      const structuralRe = new RegExp(fixture.structuralRe);
      for (const name of ['STATE', 'ROADMAP', 'MILESTONES', 'PROJECT', 'REQUIREMENTS']) {
        const p = `.planning/${name}.md`;
        assert.ok(structuralRe.test(p), `fixture bug: STRUCTURAL_RE must accept ${p}`);
        assert.deepStrictEqual(forbiddenPaths([p], defaultOpts), [], `${p} must not be forbidden in default mode`);
        assert.deepStrictEqual(forbiddenPaths([p], strictOpts), [p], `${p} must be forbidden in strict mode`);
      }
    });

    test('16: LOOKALIKE structural names — structuralPaths [] (anchored), land in otherPlanningPaths default', () => {
      const files = ['.planning/STATEX.md', '.planning/STATE.md.bak'];
      assert.deepStrictEqual(structuralPaths(files, defaultOpts), []);
      assert.deepStrictEqual(
        otherPlanningPaths(files, defaultOpts).sort(),
        [...files].sort(),
      );
    });

    test('17: CRLF string form classifies/filters identically to the LF array form', () => {
      const crlf = '.planning/phases/a.md\r\nsrc/b.ts\r\n';
      const arr = ['.planning/phases/a.md', 'src/b.ts'];
      for (const opts of [defaultOpts, strictOpts]) {
        assert.strictEqual(classifyCommit(crlf, opts), classifyCommit(arr, opts));
        assert.deepStrictEqual(forbiddenPaths(crlf, opts), forbiddenPaths(arr, opts));
      }
    });

    test('18: parseWorkflow throws on an absent declaration, and names the count on a duplicate', () => {
      assert.throws(
        () => parseWorkflow('no declarations here\n'),
        /no TRANSIENT_DIRS declaration/,
      );
      assert.throws(
        () => parseWorkflow('TRANSIENT_DIRS="a b"\n'),
        /no STRUCTURAL_RE declaration/,
      );
      const dupTransient = [
        'TRANSIENT_DIRS="a b"',
        'TRANSIENT_DIRS="a b"',
        'STRUCTURAL_RE="^\\.planning/STATE\\.md$"',
      ].join('\n');
      assert.throws(
        () => parseWorkflow(dupTransient),
        /TRANSIENT_DIRS declared 2 times/,
      );
      const dupStructural = [
        'TRANSIENT_DIRS="a b"',
        'STRUCTURAL_RE="^\\.planning/STATE\\.md$"',
        'STRUCTURAL_RE="^\\.planning/STATE\\.md$"',
      ].join('\n');
      assert.throws(
        () => parseWorkflow(dupStructural),
        /STRUCTURAL_RE declared 2 times/,
      );
    });
  });

  // ── L2: the real create_pr_branch recipe, executed against real git ─────
  describe('L2: create_pr_branch recipe (real git)', () => {
    const activeDirs = [];

    function trackDir(dir) {
      activeDirs.push(dir);
      return dir;
    }

    function teardown() {
      while (activeDirs.length) cleanup(activeDirs.pop());
    }

    function currentTransientDirs() {
      return readWorkflow().transientDirs;
    }

    /**
     * Builds a fixture repo:
     *   main:    code.txt, (unless noPlanning) .planning/STATE.md,
     *            .planning/phases/old.md
     *   feature: c1 modifies code.txt + .planning/STATE.md, ADDS
     *            .planning/phases/new.md; c2 modifies code.txt AND the same
     *            .planning/phases/new.md (unless planningOnlySecondCommit,
     *            in which case c2 touches ONLY .planning/phases/new.md).
     *   prbranch: checked out from main (or from main + a conflicting extra
     *            commit on main, when conflict is true).
     */
    function buildFixture({ noPlanning = false, conflict = false, planningOnlySecondCommit = false } = {}) {
      const dir = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-prbranch-')));
      initRepo(dir);
      writeFile(dir, 'code.txt', 'line1\n');
      if (!noPlanning) {
        writeFile(dir, '.planning/STATE.md', 'state v1\n');
        writeFile(dir, '.planning/phases/old.md', 'old plan\n');
      }
      commitAll(dir, 'chore: base');
      git(['branch', 'feature'], dir);

      git(['checkout', '-q', 'feature'], dir);
      writeFile(dir, 'code.txt', 'line1-c1\n');
      writeFile(dir, '.planning/STATE.md', 'state v2\n');
      writeFile(dir, '.planning/phases/new.md', 'new plan v1\n');
      commitAll(dir, 'feat: c1');

      if (planningOnlySecondCommit) {
        writeFile(dir, '.planning/phases/new.md', 'new plan v2\n');
        commitAll(dir, 'docs: c2 planning-only');
      } else {
        writeFile(dir, 'code.txt', 'line1-c1\nline2\n');
        writeFile(dir, '.planning/phases/new.md', 'new plan v2\n');
        commitAll(dir, 'feat: c2');
      }

      git(['checkout', '-q', 'main'], dir);
      if (conflict) {
        writeFile(dir, 'code.txt', 'line1-main\n');
        commitAll(dir, 'chore: main conflicting edit');
      }
      git(['checkout', '-q', '-b', 'prbranch', 'main'], dir);
      return dir;
    }

    function readWorkflowText() {
      return fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    }

    // Builds the exact fixture script L2 executes: fixed shell vars plus the
    // REAL create_pr_branch cherry-pick loop extracted verbatim from
    // pr-branch.md — not a hand-written mirror of it. NOTE: INCLUDED_COMMITS
    // here is deliberately ALL commits `main..feature`; this layer is only
    // proving the filter recipe (rm/checkout/conflict-halt/empty-skip), not
    // `analyze_commits`' include/exclude classification, which L1 covers.
    function buildRecipeScript(filterPaths) {
      return [
        'set -u',
        'CURRENT_BRANCH=feature',
        'PR_BRANCH=prbranch',
        'TARGET=main',
        'INCLUDED_COMMITS=$(git rev-list --reverse main..feature)',
        `FILTER_PATHS="${filterPaths.join(' ')}"`,
        extractPickLoop(readWorkflowText()),
      ].join('\n');
    }

    function runFilterLoop(repoDir, { strict, transientDirs }) {
      const filterPaths = strict ? ['.planning/'] : transientDirs.map((d) => `.planning/${d}/`);
      const script = buildRecipeScript(filterPaths);
      try {
        const stdout = execFileSync('sh', ['-c', script], { cwd: repoDir, encoding: 'utf8', timeout: 30000 });
        return { status: 0, stdout, stderr: '' };
      } catch (err) {
        return {
          status: typeof err.status === 'number' ? err.status : 1,
          stdout: err.stdout || '',
          stderr: err.stderr || '',
        };
      }
    }

    test('19: REGRESSION default — old.md is never staged as deleted', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture();
      const result = runFilterLoop(dir, { strict: false, transientDirs });
      try {
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const lines = git(['diff', '--name-status', 'main..prbranch'], dir)
          .split('\n').map((s) => s.trim()).filter(Boolean);
        const deletedOld = lines.some((l) => l.startsWith('D') && l.includes('.planning/phases/old.md'));
        assert.strictEqual(deletedOld, false, `old.md must never be deleted; diff lines: ${lines.join(' | ')}`);
      } finally {
        teardown();
      }
    });

    test('20: REGRESSION strict — base planning tree is never deleted', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture();
      try {
        const result = runFilterLoop(dir, { strict: true, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const tree = git(['ls-tree', '-r', '--name-only', 'prbranch', '--', '.planning'], dir)
          .split('\n').map((s) => s.trim()).filter(Boolean);
        assert.ok(tree.includes('.planning/STATE.md'), `expected .planning/STATE.md in ${tree.join(', ')}`);
        assert.ok(tree.includes('.planning/phases/old.md'), `expected .planning/phases/old.md in ${tree.join(', ')}`);
      } finally {
        teardown();
      }
    });

    test('21: REGRESSION default — both c1 and c2 land', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture();
      try {
        const result = runFilterLoop(dir, { strict: false, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const count = parseInt(git(['rev-list', '--count', 'main..prbranch'], dir).trim(), 10);
        assert.strictEqual(count, 2, 'both c1 and c2 must land as commits on prbranch');
        const codeContent = fs.readFileSync(path.join(dir, 'code.txt'), 'utf-8');
        assert.ok(codeContent.includes('line2'), `expected c2's line in code.txt, got: ${codeContent}`);
      } finally {
        teardown();
      }
    });

    test('22: REGRESSION strict — both c1 and c2 land', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture();
      try {
        const result = runFilterLoop(dir, { strict: true, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const count = parseInt(git(['rev-list', '--count', 'main..prbranch'], dir).trim(), 10);
        assert.strictEqual(count, 2, 'both c1 and c2 must land as commits on prbranch');
        const codeContent = fs.readFileSync(path.join(dir, 'code.txt'), 'utf-8');
        assert.ok(codeContent.includes('line2'), `expected c2's line in code.txt, got: ${codeContent}`);
      } finally {
        teardown();
      }
    });

    test('23: default end-to-end — diff carries code + STATE.md, nothing forbidden-default', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture();
      try {
        const result = runFilterLoop(dir, { strict: false, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const files = git(['diff', '--name-only', 'main..prbranch'], dir)
          .split('\n').map((s) => s.trim()).filter(Boolean);
        assert.ok(files.includes('code.txt'), `expected code.txt in ${files.join(', ')}`);
        assert.ok(files.includes('.planning/STATE.md'), `expected .planning/STATE.md in ${files.join(', ')}`);
        const re = forbiddenRegex({ strict: false, transientDirs });
        assert.deepStrictEqual(files.filter((f) => re.test(f)), []);
      } finally {
        teardown();
      }
    });

    test('24: strict end-to-end — diff carries code, nothing under .planning/', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture();
      try {
        const result = runFilterLoop(dir, { strict: true, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const files = git(['diff', '--name-only', 'main..prbranch'], dir)
          .split('\n').map((s) => s.trim()).filter(Boolean);
        assert.ok(files.includes('code.txt'), `expected code.txt in ${files.join(', ')}`);
        assert.deepStrictEqual(files.filter((f) => f.startsWith('.planning/')), []);
      } finally {
        teardown();
      }
    });

    test('25: NEGATIVE — a real code conflict is not swallowed by the filter, and the halt path fully unwinds the partial prbranch', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture({ conflict: true });
      try {
        const result = runFilterLoop(dir, { strict: false, transientDirs });
        assert.notStrictEqual(result.status, 0, 'a genuine code conflict must not exit 0');
        assert.ok(
          result.stderr.includes('Conflict outside the .planning/ filter'),
          `expected the real halt message in stderr, got: ${result.stderr}`,
        );
        const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
        assert.strictEqual(
          currentBranch, 'feature',
          `expected the halt path to restore CURRENT_BRANCH (feature), got: ${currentBranch}`,
        );
        assert.throws(
          () => git(['rev-parse', '--verify', 'prbranch'], dir),
          /.*/,
          'expected the partial prbranch to be deleted by the halt path, not left stranded mid cherry-pick',
        );
      } finally {
        teardown();
      }
    });

    test('26: BOUNDARY — main tracks no .planning/ at all; loop still exits 0, both commits land', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture({ noPlanning: true });
      try {
        const result = runFilterLoop(dir, { strict: false, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const count = parseInt(git(['rev-list', '--count', 'main..prbranch'], dir).trim(), 10);
        assert.strictEqual(count, 2);
      } finally {
        teardown();
      }
    });

    test('27: BOUNDARY strict — a planning-only c2 is excluded, only c1 lands', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture({ planningOnlySecondCommit: true });
      try {
        const result = runFilterLoop(dir, { strict: true, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const count = parseInt(git(['rev-list', '--count', 'main..prbranch'], dir).trim(), 10);
        assert.strictEqual(count, 1, 'a commit touching only .planning/ must not land under strict mode');
      } finally {
        teardown();
      }
    });
  });

  // ── L3: planning.pr_strict registration through the real CLI/config ─────
  describe('L3: planning.pr_strict config key registration', () => {
    const activeDirs = [];
    function trackDir(dir) {
      activeDirs.push(dir);
      return dir;
    }
    function teardown() {
      while (activeDirs.length) cleanup(activeDirs.pop());
    }

    test('28: no config.json at all -> config-get planning.pr_strict --raw is false, not "Key not found"', () => {
      const dir = trackDir(createTempProject());
      try {
        const res = runGsdTools(['query', 'config-get', 'planning.pr_strict', '--raw'], dir);
        assert.ok(res.success, `expected success, got: ${res.error}`);
        assert.strictEqual(res.output, 'false');
      } finally {
        teardown();
      }
    });

    test('29: {"planning":{"pr_strict":true}} -> prints true', () => {
      const dir = trackDir(createTempProject());
      try {
        fs.writeFileSync(
          path.join(dir, '.planning', 'config.json'),
          JSON.stringify({ planning: { pr_strict: true } }),
        );
        const res = runGsdTools(['query', 'config-get', 'planning.pr_strict', '--raw'], dir);
        assert.ok(res.success, `expected success, got: ${res.error}`);
        assert.strictEqual(res.output, 'true');
      } finally {
        teardown();
      }
    });

    test('30: {"planning":{"pr_strict":false}} -> prints false', () => {
      const dir = trackDir(createTempProject());
      try {
        fs.writeFileSync(
          path.join(dir, '.planning', 'config.json'),
          JSON.stringify({ planning: { pr_strict: false } }),
        );
        const res = runGsdTools(['query', 'config-get', 'planning.pr_strict', '--raw'], dir);
        assert.ok(res.success, `expected success, got: ${res.error}`);
        assert.strictEqual(res.output, 'false');
      } finally {
        teardown();
      }
    });

    test('31: config-set planning.pr_strict true exits 0 and round-trips through config-get', () => {
      const dir = trackDir(createTempProject());
      try {
        const setRes = runGsdTools(['config-set', 'planning.pr_strict', 'true'], dir);
        assert.ok(setRes.success, `config-set failed: ${setRes.error}`);
        const getRes = runGsdTools(['query', 'config-get', 'planning.pr_strict', '--raw'], dir);
        assert.ok(getRes.success, `config-get failed: ${getRes.error}`);
        assert.strictEqual(getRes.output, 'true');
      } finally {
        teardown();
      }
    });

    test('32: config-set planning.pr_stric true (typo) is rejected with a non-zero exit', () => {
      const dir = trackDir(createTempProject());
      try {
        const res = runGsdTools(['config-set', 'planning.pr_stric', 'true'], dir);
        assert.ok(!res.success, 'a typo\'d key must not be accepted');
        assert.notStrictEqual(res.exitCode, 0);
      } finally {
        teardown();
      }
    });

    test('33: config-defaults.manifest.json parses and planning.pr_strict is strictly false', () => {
      const manifest = JSON.parse(fs.readFileSync(CONFIG_DEFAULTS_MANIFEST_PATH, 'utf-8'));
      assert.strictEqual(
        manifest.planning && manifest.planning.pr_strict,
        false,
        'planning.pr_strict must be present and strictly false (not truthy, not absent)',
      );
    });

    test('34: config-schema.manifest.json validKeys includes planning.pr_strict', () => {
      const schema = JSON.parse(fs.readFileSync(CONFIG_SCHEMA_MANIFEST_PATH, 'utf-8'));
      assert.ok(
        Array.isArray(schema.validKeys) && schema.validKeys.includes('planning.pr_strict'),
        'config-schema.manifest.json validKeys must include "planning.pr_strict"',
      );
    });

    test('35: loadConfig resolves the flat root alias {"pr_strict":true} -> config.pr_strict === true', () => {
      const dir = trackDir(createTempProject());
      try {
        fs.writeFileSync(
          path.join(dir, '.planning', 'config.json'),
          JSON.stringify({ pr_strict: true }),
        );
        const config = loadConfig(dir);
        assert.strictEqual(config.pr_strict, true);
      } finally {
        teardown();
      }
    });

    test('36: loadConfig on {} yields pr_strict === false', () => {
      const dir = trackDir(createTempProject());
      try {
        fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({}));
        const config = loadConfig(dir);
        assert.strictEqual(config.pr_strict, false);
      } finally {
        teardown();
      }
    });
  });

  // ── L4: the issue's load-bearing worktree claim, EXECUTED not asserted ──
  describe('L4: worktree materialization (issue #2971 load-bearing claim)', () => {
    const activeDirs = [];
    const activeWorktrees = [];

    function teardown() {
      while (activeWorktrees.length) {
        const { repoDir, worktreeDir } = activeWorktrees.pop();
        try {
          git(['worktree', 'remove', '--force', worktreeDir], repoDir);
        } catch (_) {
          // best-effort; cleanup() below still removes the directory.
        }
        cleanup(worktreeDir);
      }
      while (activeDirs.length) cleanup(activeDirs.pop());
    }

    test('37: gitignored .planning/ never reaches a linked worktree (commit_docs:false is broken for parallel executors)', () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-prbranch-wt-ignored-'));
      activeDirs.push(repoDir);
      try {
        initRepo(repoDir);
        writeFile(repoDir, '.gitignore', '.planning/\n');
        writeFile(repoDir, '.planning/STATE.md', 'state\n');
        writeFile(repoDir, 'README.md', '# repo\n');
        commitAll(repoDir, 'chore: base (planning gitignored)');
        const sha = git(['rev-parse', 'HEAD'], repoDir).trim();

        const worktreeDir = uniqueTmpPath('gsd-prbranch-wt-linked');
        git(['worktree', 'add', worktreeDir, sha], repoDir);
        activeWorktrees.push({ repoDir, worktreeDir });

        assert.strictEqual(
          fs.existsSync(path.join(worktreeDir, '.planning')),
          false,
          'a worktree built from a commit whose .planning/ was gitignored (never tracked) must not contain .planning/',
        );
      } finally {
        teardown();
      }
    });

    test('38: committed .planning/PLAN.md exists in a linked worktree (commit_docs:true + planning.pr_strict is the working combination)', () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-prbranch-wt-committed-'));
      activeDirs.push(repoDir);
      try {
        initRepo(repoDir);
        writeFile(repoDir, '.planning/PLAN.md', '# Plan\n');
        writeFile(repoDir, 'README.md', '# repo\n');
        commitAll(repoDir, 'chore: base (planning committed)');
        const sha = git(['rev-parse', 'HEAD'], repoDir).trim();

        const worktreeDir = uniqueTmpPath('gsd-prbranch-wt-committed-linked');
        git(['worktree', 'add', worktreeDir, sha], repoDir);
        activeWorktrees.push({ repoDir, worktreeDir });

        assert.ok(
          fs.existsSync(path.join(worktreeDir, '.planning', 'PLAN.md')),
          '.planning/PLAN.md must exist inside a worktree built from a commit that tracked it',
        );
      } finally {
        teardown();
      }
    });
  });

  // ── L5: fast-check properties ─────────────────────────────────────────
  describe('L5: fast-check properties', () => {
    function buildPool(transientDirs) {
      const transientPaths = transientDirs.flatMap((d) => [`.planning/${d}/f.md`, `.planning/${d}/sub/g.md`]);
      const structuralPathsPool = [
        '.planning/STATE.md',
        '.planning/ROADMAP.md',
        '.planning/MILESTONES.md',
        '.planning/PROJECT.md',
        '.planning/REQUIREMENTS.md',
        '.planning/milestones/m1/x.md',
      ];
      const thirdBucket = ['.planning/config.json', '.planning/notes.md'];
      const nonPlanning = ['src/a.ts', 'docs/readme.md', 'package.json', 'src/planning-inspect.cts'];
      return fc.constantFrom(...transientPaths, ...structuralPathsPool, ...thirdBucket, ...nonPlanning);
    }

    test('39: forbiddenPaths(strict) is a superset of forbiddenPaths(default)', () => {
      const { transientDirs, structuralRe } = readWorkflow();
      const pool = buildPool(transientDirs);
      fc.assert(
        fc.property(fc.array(pool, { maxLength: 12 }), (files) => {
          const strictSet = new Set(forbiddenPaths(files, { strict: true, transientDirs, structuralRe }));
          const defaultSet = new Set(forbiddenPaths(files, { strict: false, transientDirs, structuralRe }));
          for (const f of defaultSet) {
            assert.ok(strictSet.has(f), `${f} forbidden in default mode but not in strict mode`);
          }
        }),
        { seed: 2971, numRuns: 300 },
      );
    });

    test('40: forbiddenPaths(strict) equals exactly the members matching /^\\.planning\\//', () => {
      const { transientDirs, structuralRe } = readWorkflow();
      const pool = buildPool(transientDirs);
      fc.assert(
        fc.property(fc.array(pool, { maxLength: 12 }), (files) => {
          const actual = forbiddenPaths(files, { strict: true, transientDirs, structuralRe }).sort();
          const expected = files.filter((f) => /^\.planning\//.test(f)).sort();
          assert.deepStrictEqual(actual, expected);
        }),
        { seed: 2971, numRuns: 300 },
      );
    });

    test('41: no path outside .planning/ is ever in forbiddenPaths, either mode', () => {
      const { transientDirs, structuralRe } = readWorkflow();
      const pool = buildPool(transientDirs);
      fc.assert(
        fc.property(fc.array(pool, { maxLength: 12 }), (files) => {
          for (const strict of [true, false]) {
            const result = forbiddenPaths(files, { strict, transientDirs, structuralRe });
            for (const f of result) {
              assert.ok(f.startsWith('.planning/'), `${f} is outside .planning/ but was forbidden (strict=${strict})`);
            }
          }
        }),
        { seed: 2971, numRuns: 300 },
      );
    });

    test('42: strict mode classifyCommit is include iff a member is outside .planning/', () => {
      const { transientDirs, structuralRe } = readWorkflow();
      const pool = buildPool(transientDirs);
      fc.assert(
        fc.property(fc.array(pool, { maxLength: 12 }), (files) => {
          const actual = classifyCommit(files, { strict: true, transientDirs, structuralRe });
          const expected = files.some((f) => !/^\.planning\//.test(f)) ? 'include' : 'exclude';
          assert.strictEqual(actual, expected);
        }),
        { seed: 2971, numRuns: 300 },
      );
    });
  });

  // ── L6: drift guard over the shipped workflow (prose) ────────────────
  describe('L6: drift guard over the shipped workflow (prose)', () => {
    test('43: workflow declares TRANSIENT_DIRS/STRUCTURAL_RE exactly once; 9 dirs incl. phases + ui-reviews', () => {
      const { transientDirs } = readWorkflow();
      assert.strictEqual(transientDirs.length, 9, `expected 9 transient dirs, got: ${transientDirs.join(', ')}`);
      assert.ok(transientDirs.includes('phases'));
      assert.ok(transientDirs.includes('ui-reviews'));
    });

    test('44: verify step derives from FORBIDDEN_RE, not the old unconditional wc -l count', () => {
      const text = readFileNormalized(WORKFLOW_PATH);
      const occurrences = (text.match(/FORBIDDEN_RE/g) || []).length;
      assert.ok(
        occurrences >= 2,
        `expected FORBIDDEN_RE to appear at least twice (declaration + use), found ${occurrences}`,
      );
      assert.ok(
        !text.includes('grep "^\\.planning/" | wc -l'),
        'the old unconditional `grep "^\\.planning/" | wc -l` count must be gone',
      );
    });

    test('45: create_pr_branch recipe carries every command shape L2 proved correct, in the load-bearing order', () => {
      const text = readFileNormalized(WORKFLOW_PATH);
      const required = [
        'git rm -r -f -q --ignore-unmatch --',
        'git checkout HEAD --',
        '--diff-filter=U',
        'git cherry-pick --quit',
      ];
      for (const needle of required) {
        assert.ok(text.includes(needle), `workflow is missing required recipe fragment: ${needle}`);
      }

      const loop = extractPickLoop(text);
      assert.ok(loop.length > 0, 'extractPickLoop must find exactly one canonical cherry-pick loop');

      const rmIndex = loop.indexOf('git rm -r -f -q --ignore-unmatch --');
      const checkoutIndex = loop.indexOf('git checkout HEAD --');
      assert.ok(rmIndex >= 0 && checkoutIndex >= 0, 'both rm and checkout forms must appear inside the extracted loop');
      assert.ok(
        rmIndex < checkoutIndex,
        'order is load-bearing: `git rm -r -f -q --ignore-unmatch --` must run BEFORE `git checkout HEAD --` — '
          + 'reversing it would restore the target branch\'s file and then immediately delete it, corrupting the PR branch',
      );
    });

    test('46: the old un-stage form is gone', () => {
      const text = readFileNormalized(WORKFLOW_PATH);
      assert.ok(
        !text.includes('git rm -r --cached ".planning/'),
        'the old unconditional `git rm -r --cached ".planning/` form must be removed',
      );
    });

    test('47: the workflow reads the config key', () => {
      const text = readFileNormalized(WORKFLOW_PATH);
      assert.ok(text.includes('config-get planning.pr_strict'), 'workflow must call config-get planning.pr_strict');
    });

    test('48: success criteria no longer claim an unconditional zero', () => {
      const text = readFileNormalized(WORKFLOW_PATH);
      assert.ok(
        !text.includes('- [ ] No .planning/ files in PR branch diff'),
        'the unconditional "No .planning/ files in PR branch diff" success line must be removed/replaced',
      );
    });
  });
});

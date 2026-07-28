'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci-test-scope.cjs');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

function scopeFor(files) {
  const r = spawnSync(process.execPath, [SCRIPT, '--files', files.join(' ')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  return JSON.parse(r.stdout);
}

describe('ci-test-scope.cjs', () => {
  test('docs-only changes: code_changed is false, product_changed false (skip matrix entirely)', () => {
    const result = scopeFor(['docs/usage.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false for docs-only change, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for docs-only change, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, false);
    // docs-parity is NOT in targeted_tests when docs-only (it runs via docs-required.yml instead)
    assert.ok(
      !result.targeted_tests.some(t => t.includes('docs-parity-live-registry')),
      `docs-parity-live-registry must NOT be in targeted_tests for docs-only, got: ${JSON.stringify(result.targeted_tests)}`,
    );
  });

  test('root markdown only: code_changed is false, product_changed false', () => {
    const result = scopeFor(['README.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false for root markdown, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for root markdown, got: ${JSON.stringify(result)}`);
  });

  test('pipeline workflow (test.yml) — product_changed true, full_matrix true, workflow contract tests', () => {
    const result = scopeFor(['.github/workflows/test.yml']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for test.yml, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, true);
    assert.ok(result.targeted_tests.includes('tests/workflow-shell-pinning.test.cjs'));
    assert.ok(result.targeted_tests.includes('tests/release-tarball-smoke-workflow.test.cjs'));
    assert.ok(result.windows_tests.includes('tests/workflow-shell-pinning.test.cjs'));
  });

  test('pipeline workflow (install-smoke.yml) — product_changed true, full_matrix true', () => {
    const result = scopeFor(['.github/workflows/install-smoke.yml']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for install-smoke.yml, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, true);
  });

  test('inert CI only (stale.yml) — code_changed true, product_changed false, full_matrix false', () => {
    const result = scopeFor(['.github/workflows/stale.yml']);
    assert.strictEqual(result.code_changed, true,
      `expected code_changed=true for inert CI, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for inert CI, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, false,
      `expected full_matrix=false for inert CI, got: ${JSON.stringify(result)}`);
    assert.ok(result.targeted_tests.includes('tests/workflow-shell-pinning.test.cjs'),
      `expected workflow-shell-pinning in targeted_tests, got: ${JSON.stringify(result.targeted_tests)}`);
    assert.ok(result.targeted_tests.includes('tests/policy-lint-shallow-checkout.test.cjs'),
      `expected policy-lint-shallow-checkout in targeted_tests for inert CI, got: ${JSON.stringify(result.targeted_tests)}`);
  });

  test('TS runtime sources (src/semver.cts) — code_changed true, product_changed true, full_matrix false, semver tests targeted', () => {
    const result = scopeFor(['src/semver.cts']);
    assert.strictEqual(result.code_changed, true,
      `expected code_changed=true for src/ change, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for src/ change, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, false,
      `expected full_matrix=false for src/-only change (TS runtime sources rule has no fullMatrix), got: ${JSON.stringify(result)}`);
    assert.ok(result.targeted_tests.includes('tests/semver-compare.test.cjs'),
      `expected semver-compare in targeted_tests, got: ${JSON.stringify(result.targeted_tests)}`);
  });

  test('product code (gsd-core/bin/lib/foo.cjs) — product_changed true', () => {
    const result = scopeFor(['gsd-core/bin/lib/foo.cjs']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for gsd-core/ change, got: ${JSON.stringify(result)}`);
  });

  test('unknown/new workflow defaults to pipeline (fail-safe) — product_changed true', () => {
    const result = scopeFor(['.github/workflows/brand-new-thing.yml']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for unknown workflow (fail-safe), got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, true,
      `expected full_matrix=true for unknown workflow (fail-safe), got: ${JSON.stringify(result)}`);
  });

  test('mixed docs + code — escalates to product_changed true', () => {
    // Use bin/gsd (installer rule, fullMatrix:true) to get a code file that reliably triggers full matrix.
    const result = scopeFor(['docs/x.md', 'bin/gsd']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for docs+code, got: ${JSON.stringify(result)}`);
  });

  test('inert CI (docs-required.yml) — includes shallow-checkout policy test, product_changed false', () => {
    const result = scopeFor(['.github/workflows/docs-required.yml']);
    assert.strictEqual(result.code_changed, true,
      `expected code_changed=true for docs-required.yml, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for docs-required.yml, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, false,
      `expected full_matrix=false for docs-required.yml, got: ${JSON.stringify(result)}`);
    assert.ok(result.targeted_tests.includes('tests/policy-lint-shallow-checkout.test.cjs'),
      `expected policy-lint-shallow-checkout in targeted_tests for docs-required.yml, got: ${JSON.stringify(result.targeted_tests)}`);
  });

  test('mixed docs + inert CI — code_changed true, product_changed false (inert lane)', () => {
    const result = scopeFor(['docs/x.md', '.github/workflows/stale.yml']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for docs+inert, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, false);
  });

  test('mixed docs + src — product_changed true', () => {
    const result = scopeFor(['docs/x.md', 'src/semver.cts']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for docs+src, got: ${JSON.stringify(result)}`);
  });

  test('command changes request command tests without full parity matrix', () => {
    const result = scopeFor(['commands/gsd/plan-phase.md']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.full_matrix, false);
    assert.ok(result.targeted_tests.includes('tests/command-contract.test.cjs'));
    assert.ok(result.targeted_tests.includes('tests/commands.test.cjs'));
  });

  test('changed test files are selected directly', () => {
    const result = scopeFor(['tests/run-tests-harness.test.cjs']);
    assert.strictEqual(result.code_changed, true);
    assert.ok(result.targeted_tests.includes('tests/run-tests-harness.test.cjs'));
  });

  test('installer-sensitive changes request full matrix and install tests', () => {
    const result = scopeFor(['bin/gsd']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for bin/gsd, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, true);
    assert.ok(result.targeted_tests.includes('tests/install.test.cjs'));
    // release-tarball-smoke.install.test.cjs is intentionally EXCLUDED from the
    // scoped/targeted lane (SCOPED_LANE_EXCLUDE in ci-test-scope.cjs): it is a
    // 3–6 min npm-pack + global-install integration test that runs via its own
    // install-smoke.yml workflow, not here — running it in the scoped lane too is
    // redundant and overran the per-chunk Windows timeout (epic #1969).
    assert.ok(!result.targeted_tests.includes('tests/release-tarball-smoke.install.test.cjs'),
      `release-tarball-smoke.install.test.cjs must not be in the scoped targeted lane; got: ${JSON.stringify(result.targeted_tests)}`);
  });

  test('missing required CLI values fail with usage', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--files'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.notStrictEqual(r.status, 0);
    // allow-test-rule: CLI usage failure text is user-facing contract for this parser guard.
    assert.match(r.stderr, /--files requires a value/);
    // allow-test-rule: CLI usage banner presence is a user-facing contract.
    assert.match(r.stderr, /Usage:/);
  });

  // bug-408: unconditional DEFAULT_SMOKE_TESTS injection removed; unit fallback added
  test('bug-408: code change with matched rules produces exactly the rule-selected tests (no smoke list appended)', () => {
    // commands/ matches the "command definitions" rule only — no smoke list should be added
    const result = scopeFor(['commands/gsd/plan-phase.md']);
    assert.strictEqual(result.code_changed, true);
    const expectedTests = [
      'tests/command-contract.test.cjs',
      'tests/command-routing-hub.test.cjs',
      'tests/commands.test.cjs',
      'tests/phase-command-router.test.cjs',
      'tests/roadmap-command-router.test.cjs',
    ];
    // Every expected test must be present
    for (const t of expectedTests) {
      assert.ok(result.targeted_tests.includes(t), `expected ${t} in targeted_tests`);
    }
    // No DEFAULT_SMOKE_TESTS files should be injected beyond what the rule selects.
    // The former smoke list contained package-manifest.test.cjs and core.test.cjs —
    // neither is in the "command definitions" rule, so they must not appear.
    assert.ok(!result.targeted_tests.includes('tests/core.test.cjs'),
      'tests/core.test.cjs must NOT be unconditionally injected for command changes');
    assert.ok(!result.targeted_tests.includes('tests/package-manifest.test.cjs'),
      'tests/package-manifest.test.cjs must NOT be unconditionally injected for command changes');
  });

  test('bug-408: code change with no rule match falls back to unit suite token', () => {
    // A plain source file that matches no RULES entry but is under gsd-core/ (code path)
    const result = scopeFor(['gsd-core/src/some-util.js']);
    assert.strictEqual(result.code_changed, true);
    // allow-test-rule: the unit-fallback contract is the exact subject of bug #408.
    assert.deepStrictEqual(result.targeted_tests, ['unit'],
      'targeted_tests must be [\'unit\'] when code changed but no rule matched');
  });

  test('three-dot diff: docs-only PR on a stale base ignores product commits next gained after the merge-base', () => {
    // Reproduces #837: a docs-only PR branched from a slightly older `next`.
    // After the branch point, `next` advances with a PRODUCT commit. A two-dot
    // `git diff base head` would surface that product file (flipping product_changed/
    // full_matrix true); a three-dot `git diff base...head` (vs the merge-base, which is
    // GitHub's PR semantics) must see ONLY the docs change.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-scope-837-'));
    try {
      const git = (...a) => {
        const r = spawnSync('git', a, { cwd: tmp, encoding: 'utf8' });
        assert.strictEqual(r.status, 0, `git ${a.join(' ')} failed: ${r.stderr}`);
        return r.stdout.trim();
      };
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');

      // merge-base: a docs file + a product file (package.json)
      fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true }); // existingTests() reads tests/
      fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'docs', 'a.md'), 'base\n');
      fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
      git('add', '-A');
      git('commit', '-qm', 'merge-base');
      const baseBranch = git('rev-parse', '--abbrev-ref', 'HEAD');

      // PR branch (head): docs-only change
      git('checkout', '-q', '-b', 'feature');
      fs.writeFileSync(path.join(tmp, 'docs', 'a.md'), 'base\nnew docs line\n');
      git('add', '-A');
      git('commit', '-qm', 'docs: add line');
      const head = git('rev-parse', 'HEAD');

      // base advances (next gains a PRODUCT commit after the merge-base)
      git('checkout', '-q', baseBranch);
      fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x","version":"2.0.0"}\n');
      git('add', '-A');
      git('commit', '-qm', 'chore: bump version on next');
      const base = git('rev-parse', 'HEAD');

      const r = spawnSync(process.execPath, [SCRIPT, '--base', base, '--head', head], {
        cwd: tmp,
        encoding: 'utf8',
      });
      assert.strictEqual(r.status, 0, `script failed: stderr=${r.stderr}\nstdout=${r.stdout}`);
      const result = JSON.parse(r.stdout);

      assert.deepStrictEqual(
        result.changed_files,
        ['docs/a.md'],
        `expected three-dot diff to see only the docs file, got: ${JSON.stringify(result.changed_files)}`,
      );
      assert.strictEqual(
        result.product_changed,
        false,
        `docs-only PR must not set product_changed even on a stale base, got: ${JSON.stringify(result)}`,
      );
      assert.strictEqual(
        result.full_matrix,
        false,
        `docs-only PR must not set full_matrix even on a stale base, got: ${JSON.stringify(result)}`,
      );
    } finally {
      cleanup(tmp);
    }
  });
});

describe('ci-test-scope superset invariant (#494, narrowed)', () => {
  // Facet A (narrowed): a changed test file no longer triggers the full
  // parity matrix — instead it must ALWAYS run on the scoped windows lane,
  // so OS-specific breakage in the changed test (the #482 class) is still
  // exercised pre-merge. Ubuntu 22/24 coverage comes via targeted_tests.
  test('A1: a changed test file joins the windows scoped lane without full_matrix', () => {
    const result = scopeFor(['tests/perf-317-context-monitor-fs.test.cjs']);
    assert.strictEqual(result.full_matrix, false,
      `expected full_matrix=false for a tests/**-only change, got: ${JSON.stringify(result)}`);
    assert.ok(result.targeted_tests.includes('tests/perf-317-context-monitor-fs.test.cjs'),
      `expected the changed test in targeted_tests, got: ${JSON.stringify(result.targeted_tests)}`);
    assert.ok(result.windows_tests.includes('tests/perf-317-context-monitor-fs.test.cjs'),
      `expected the changed test in windows_tests, got: ${JSON.stringify(result.windows_tests)}`);
  });

  test('A2: a changed test file with no windows hint still joins the windows lane', () => {
    // commands.test.cjs matches none of the WINDOWS_HINTS substrings — the
    // unconditional changed-test → windows lane rule must include it anyway.
    const result = scopeFor(['tests/commands.test.cjs']);
    assert.strictEqual(result.full_matrix, false);
    assert.ok(result.windows_tests.includes('tests/commands.test.cjs'),
      `expected hint-less changed test in windows_tests, got: ${JSON.stringify(result.windows_tests)}`);
  });

  test('A3: a deleted/nonexistent test path falls back to the unit token, no full_matrix', () => {
    const result = scopeFor(['tests/some-new.test.cjs']);
    assert.strictEqual(result.full_matrix, false);
    // The nonexistent file is filtered by existingTests(); with nothing left,
    // the #408 fallback applies so the targeted lane still runs something.
    assert.deepStrictEqual(result.targeted_tests, ['unit']);
  });

  // Facet B: commands/**, agents/** → code_changed AND docs-parity selected
  // docs/ is NO LONGER in this facet — docs-only PRs skip the matrix entirely.
  test('B1: docs/adr change: code_changed is false (docs skip matrix)', () => {
    const result = scopeFor(['docs/adr/22-plan-drift-guard.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false for docs/** change (matrix skip), got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for docs/** change, got: ${JSON.stringify(result)}`);
    // docs-parity is NOT in targeted_tests (handled by docs-required.yml)
    assert.ok(
      !result.targeted_tests.some(t => t.includes('docs-parity-live-registry')),
      `docs-parity-live-registry must NOT be in targeted_tests for docs-only, got: ${JSON.stringify(result.targeted_tests)}`,
    );
  });

  test('B2: docs locale dir change: code_changed is false (docs skip matrix)', () => {
    const result = scopeFor(['docs/ja-JP/USAGE.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false for docs/ja-JP/** change, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for docs/ja-JP/** change, got: ${JSON.stringify(result)}`);
  });

  test('B3: commands/** change selects docs-parity-live-registry', () => {
    const result = scopeFor(['commands/gsd/plan-phase.md']);
    assert.ok(
      result.targeted_tests.some(t => t.includes('docs-parity-live-registry')),
      `expected docs-parity-live-registry in targeted_tests for commands/** change, got: ${JSON.stringify(result.targeted_tests)}`,
    );
  });
});

describe('INERT_WORKFLOWS allowlist integrity guard', () => {
  // Load the INERT_WORKFLOWS set from the script by spawning it and using --files
  // on a sentinel path, then separately verify the set contents via the filesystem.

  // Known pipeline workflows that MUST NOT appear in INERT_WORKFLOWS.
  // Must stay in sync with PROTECTED_WORKFLOWS in scripts/ci-test-scope.cjs.
  const KNOWN_PIPELINE = [
    'test.yml',
    'install-smoke.yml',
    'mutation.yml',
    'security-scan.yml',
    'release.yml',
  ];

  // Canonical inert workflow list — reused by both tests below.
  const knownInert = [
    'stale.yml', 'branch-cleanup.yml', 'branch-naming.yml', 'auto-label-issues.yml',
    'auto-branch.yml', 'auto-backmerge.yml', 'close-draft-prs.yml',
    'dismiss-unauthorized-pr-approvals.yml', 'pr-target-validator.yml',
    'pr-template-format.yml', 'require-issue-link.yml', 'changeset-required.yml',
    'docs-required.yml', 'discord-changelog.yml',
  ];

  test('all entries in INERT_WORKFLOWS exist under .github/workflows/', () => {
    // We derive the inert set implicitly: any .github/workflows/*.yml that produces
    // full_matrix=false when passed alone is inert. We check the known inert names
    // against the filesystem instead.
    // The canonical list is in the script — we verify each named file exists.
    for (const name of knownInert) {
      const fullPath = path.join(WORKFLOWS_DIR, name);
      assert.ok(
        fs.existsSync(fullPath),
        `INERT_WORKFLOWS entry '${name}' does not exist at ${fullPath}`,
      );
    }
  });

  test('known pipeline workflows are NOT treated as inert (product_changed true, full_matrix true)', () => {
    for (const name of KNOWN_PIPELINE) {
      const result = scopeFor([`.github/workflows/${name}`]);
      assert.strictEqual(result.product_changed, true,
        `${name} must be pipeline (product_changed=true), got: ${JSON.stringify(result)}`);
      assert.strictEqual(result.full_matrix, true,
        `${name} must be pipeline (full_matrix=true), got: ${JSON.stringify(result)}`);
    }
  });

  // Explicit per-workflow guard: each of the five protected workflows must route to
  // the full matrix. This documents intent and proves that PROTECTED_WORKFLOWS
  // enforcement is covered end-to-end via the spawn helper.
  test('all five PROTECTED_WORKFLOWS individually route to full matrix (tamper-evidence)', () => {
    const protected_ = [
      'test.yml',
      'install-smoke.yml',
      'mutation.yml',
      'security-scan.yml',
      'release.yml',
    ];
    for (const name of protected_) {
      const result = scopeFor([`.github/workflows/${name}`]);
      assert.strictEqual(result.product_changed, true,
        `PROTECTED_WORKFLOW ${name}: expected product_changed=true, got: ${JSON.stringify(result)}`);
      assert.strictEqual(result.full_matrix, true,
        `PROTECTED_WORKFLOW ${name}: expected full_matrix=true, got: ${JSON.stringify(result)}`);
    }
  });

  test('every inert workflow produces code_changed=true, product_changed=false, and full_matrix=false', () => {
    for (const name of knownInert) {
      const result = scopeFor([`.github/workflows/${name}`]);
      assert.strictEqual(result.code_changed, true,
        `${name}: expected code_changed=true`);
      assert.strictEqual(result.product_changed, false,
        `${name}: expected product_changed=false`);
      assert.strictEqual(result.full_matrix, false,
        `${name}: expected full_matrix=false`);
    }
  });
});

describe('test.yml changes job contract (#837)', () => {
  // ci-test-scope.cjs uses a three-dot `git diff base...head`, which requires the
  // merge-base commit to be locally present. The `changes` job in test.yml guarantees
  // this via `fetch-depth: 0` on its checkout step. This test pins that contract so
  // any future reduction of fetch-depth fails CI loudly (#837).
  test('changes job checkout step sets fetch-depth: 0 (required for three-dot diff merge-base)', () => {
    const workflowPath = path.join(WORKFLOWS_DIR, 'test.yml');
    const text = fs.readFileSync(workflowPath, 'utf8');
    const lines = text.split(/\r?\n/);

    // Locate the `changes:` job (two-space-indented top-level job key).
    const jobStart = lines.findIndex(l => /^ {2}changes:\s*$/.test(l));
    assert.ok(jobStart !== -1, 'Could not find `  changes:` job in test.yml');

    // Find the next top-level job key at the same two-space indentation to bound the region.
    let jobEnd = lines.length;
    for (let i = jobStart + 1; i < lines.length; i++) {
      if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
        jobEnd = i;
        break;
      }
    }

    const changesJobText = lines.slice(jobStart, jobEnd).join('\n');

    assert.ok(
      /fetch-depth:\s*0/.test(changesJobText),
      'changes job checkout must set `fetch-depth: 0` so the three-dot `git diff base...head` ' +
      'in ci-test-scope.cjs can resolve the merge-base locally (#837). ' +
      'Reducing fetch-depth breaks the three-dot diff and causes incorrect scope detection.',
    );
  });
});

describe('test-full shard matrix parity (#1212)', () => {
  // DEFECT.GENERATIVE-FIX: the sharded windows full-test lane has TWO surfaces
  // that must agree — the `shard:` matrix array (how many parallel jobs run)
  // and the `/N` denominator in `run-tests.cjs --suite unit --shard i/N` (how
  // many slices the runner partitions the suite into). If they diverge (e.g.
  // someone grows `shard: [1,2,3,4]` but leaves `--shard ${{ matrix.shard }}/3`),
  // shards silently overlap and one shard errors out. This parity assertion
  // fails the moment the two drift.
  const yaml = require('js-yaml');

  function loadTestFull() {
    const text = fs.readFileSync(path.join(WORKFLOWS_DIR, 'test.yml'), 'utf8');
    const doc = yaml.load(text);
    return { text, job: doc.jobs['test-full'] };
  }

  test('distinct shard values are 1..N matching the --shard /N denominator, on every leg', () => {
    const { job } = loadTestFull();
    const include = job.strategy.matrix.include;
    assert.ok(Array.isArray(include), 'test-full matrix must enumerate `include:` rows');
    assert.ok(
      include.every(r => Number.isInteger(r.shard)),
      'every include row must carry an integer `shard:` key',
    );

    const distinctShards = [...new Set(include.map(r => r.shard))].sort((a, b) => a - b);
    const n = distinctShards.length;

    // Distinct shard values must be exactly 1..n (1-based, contiguous) so the
    // runner's cost-balanced shard selection covers every file with no gaps/overlaps.
    assert.deepStrictEqual(
      distinctShards,
      Array.from({ length: n }, (_, i) => i + 1),
      `distinct shard values must be 1..${n} (1-based, contiguous), got ${JSON.stringify(distinctShards)}`,
    );

    // Every OS/node leg must appear once per shard (full cross-product) — no
    // leg may silently skip a shard, which would drop a third of its coverage.
    const legs = [...new Set(include.map(r => `${r.os}|${r['node-version']}`))];
    for (const leg of legs) {
      const [os, node] = leg.split('|');
      const shardsForLeg = include
        .filter(r => r.os === os && String(r['node-version']) === node)
        .map(r => r.shard)
        .sort((a, b) => a - b);
      assert.deepStrictEqual(
        shardsForLeg,
        distinctShards,
        `leg ${leg} must run all shards ${JSON.stringify(distinctShards)}, got ${JSON.stringify(shardsForLeg)}`,
      );
    }
    // Full cross-product: every (leg, shard) pair is present exactly once, so
    // the row count equals legs × shards with no duplicate/missing combination.
    const pairKey = r => `${r.os}|${r['node-version']}|${r.shard}`;
    assert.strictEqual(new Set(include.map(pairKey)).size, legs.length * n);
    assert.strictEqual(include.length, legs.length * n);

    // Find the `--shard ${{ matrix.shard }}/<N>` denominator in the unit step.
    const unitStep = job.steps.find(
      s => typeof s.run === 'string' && s.run.includes('run-tests.cjs') && s.run.includes('--shard'),
    );
    assert.ok(unitStep, 'test-full must have a step running run-tests.cjs --shard');
    const m = /--shard\s+\$\{\{\s*matrix\.shard\s*\}\}\/(\d+)/.exec(unitStep.run);
    assert.ok(m, `could not parse --shard i/N denominator from: ${unitStep.run}`);
    const denominator = Number(m[1]);

    assert.strictEqual(
      denominator,
      n,
      `shard count (${n}) and --shard /N denominator (${denominator}) must match — ` +
      `update both the per-row \`shard:\` values and the \`/N\` in the run command together.`,
    );
  });

  // #2472: every job of a run must merge ONE base commit. Each job runs the
  // rebase-check step independently, minutes apart across the matrix, so
  // merging the moving branch ref lets jobs see different trees when the base
  // advances mid-run. The sharded lane makes jobs agree on a PARTITION, and
  // disagreement there places a file in two shards or none — silently, because
  // each job stays internally consistent and CI stays green.
  describe('#2472 base-commit pin', () => {
    const { resolveBaseRefs } = require('../scripts/ci-rebase-check.cjs');
    const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

    test('every rebase-check step pins CI_REBASE_BASE_SHA', () => {
      const doc = yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, 'test.yml'), 'utf8'));
      const steps = Object.values(doc.jobs)
        .flatMap(j => j.steps || [])
        .filter(s => typeof s.run === 'string' && s.run.includes('ci-rebase-check.cjs'));
      assert.ok(steps.length > 0, 'expected at least one rebase-check step');
      for (const s of steps) {
        assert.ok(
          s.env && typeof s.env.CI_REBASE_BASE_SHA === 'string' && s.env.CI_REBASE_BASE_SHA.includes('base.sha'),
          'each rebase-check step must pin CI_REBASE_BASE_SHA to the PR base sha; '
          + 'an unpinned job can merge a different tree than its siblings',
        );
      }
    });

    test('a full 40-hex sha pins both fetch and merge to that commit', () => {
      const r = resolveBaseRefs({ GITHUB_BASE_REF: 'next', CI_REBASE_BASE_SHA: SHA }, 'main');
      assert.strictEqual(r.fetchRef, SHA);
      assert.strictEqual(r.mergeRef, SHA, 'fetch and merge must target the same pinned commit');
      assert.strictEqual(r.pinned, true);
    });

    test('no pin falls back to the branch ref (push / workflow_dispatch)', () => {
      const r = resolveBaseRefs({ GITHUB_BASE_REF: 'next' }, 'main');
      assert.strictEqual(r.fetchRef, 'next');
      assert.strictEqual(r.mergeRef, 'origin/next');
      assert.strictEqual(r.pinned, false);
    });

    // A non-sha value must never reach `git fetch` as a refspec.
    for (const [label, value] of [
      ['short sha', 'abc123'],
      ['uppercase sha', 'A'.repeat(40)],
      ['argument injection', 'next --upload-pack=evil'],
      ['ref expression', 'next^{commit}'],
      ['empty', ''],
    ]) {
      test(`rejects ${label} and falls back to the branch ref`, () => {
        const r = resolveBaseRefs({ GITHUB_BASE_REF: 'next', CI_REBASE_BASE_SHA: value }, 'main');
        assert.strictEqual(r.pinned, false, `"${value}" must not be accepted as a pin`);
        assert.strictEqual(r.fetchRef, 'next');
        assert.strictEqual(r.mergeRef, 'origin/next');
      });
    }
  });

  test('required-tests fan-in still needs test-full and keeps the protected name', () => {
    // Hyrum's Law: branch protection requires a status check literally named
    // "Required tests". Renaming it (or dropping test-full from its needs)
    // would silently break the gate. Pin both.
    const text = fs.readFileSync(path.join(WORKFLOWS_DIR, 'test.yml'), 'utf8');
    const doc = yaml.load(text);
    const fanIn = doc.jobs['required-tests'];
    assert.ok(fanIn, 'required-tests job must exist');
    assert.strictEqual(fanIn.name, 'Required tests', 'the branch-protection check name must stay "Required tests"');
    assert.ok(
      Array.isArray(fanIn.needs) && fanIn.needs.includes('test-full'),
      'required-tests must `needs: test-full` so all shard legs aggregate into the gate',
    );
  });
});

describe('golden-install-parity selection (#1691 drift guard)', () => {
  // Regression: a src/*.cts-only edit recompiles bin/lib/*.cjs (changing installed
  // hashes), but the scoped CI lane was not re-running golden-install-parity —
  // causing golden fixtures to silently drift (#1691 milestone/roadmap cts change).
  // Both the 'TS runtime sources' and 'installer and package layout' rules must now
  // select tests/golden-install-parity.test.cjs.

  test('src/*.cts change selects golden-install-parity (TS runtime sources rule)', () => {
    const result = scopeFor(['src/milestone.cts']);
    assert.strictEqual(result.code_changed, true,
      `expected code_changed=true for src/ change, got: ${JSON.stringify(result)}`);
    assert.ok(
      result.targeted_tests.includes('tests/golden-install-parity.test.cjs'),
      `expected golden-install-parity in targeted_tests for src/*.cts change, got: ${JSON.stringify(result.targeted_tests)}`,
    );
  });

  test('bin/install.js change selects golden-install-parity (installer and package layout rule)', () => {
    const result = scopeFor(['bin/install.js']);
    assert.strictEqual(result.code_changed, true,
      `expected code_changed=true for bin/ change, got: ${JSON.stringify(result)}`);
    assert.ok(
      result.targeted_tests.includes('tests/golden-install-parity.test.cjs'),
      `expected golden-install-parity in targeted_tests for bin/install.js change, got: ${JSON.stringify(result.targeted_tests)}`,
    );
  });
});

describe('shipped install content (golden-parity drift guard, #2267)', () => {
  // #2266 regression: hooks/gsd-statusline.js changed installed output but no
  // RULES entry selected golden-install-parity, so stale golden fixtures merged
  // to `next` undetected. The installer emits hooks/*, commands/*, agents/*,
  // skills/*, gsd-core/workflows/*, gsd-core/templates/*, gsd-core/references/*,
  // gsd-core/bin/shared/*.json, and a handful of shipped scripts/* files — every
  // one of those paths must additionally select golden-install-parity AND the
  // install-tree snapshot (union semantics: this rule ADDS to whatever
  // content-specific rule already matched the path).
  // One path per prefix the rule handles — every installed-source dir the
  // installer emits. gsd-core/contexts/ is the regression for the review miss
  // (a real shipped dir that the initial enumeration omitted).
  const SHIPPED_PATHS = [
    'hooks/gsd-statusline.js', // exact #2266 regression
    'gsd-core/workflows/plan-phase.md',
    'gsd-core/templates/config.json',
    'gsd-core/references/ui-brand.md',
    'gsd-core/contexts/dev.md', // regression: initially omitted from the rule
    'agents/gsd-planner.md',
    'commands/gsd/mempalace-capture.md',
    'skills/gsd-explore/SKILL.md',
    'gsd-core/bin/shared/model-catalog.json',
    'scripts/changeset/lint.cjs',
    'scripts/lib/cli-exit.cjs',
    'scripts/fix-slash-commands.cjs',            // exact-match allowlist entry
    'scripts/gen-capability-registry.cjs',       // exact-match allowlist entry
    'scripts/gen-loop-host-contract.cjs',        // exact-match allowlist entry
  ];

  for (const file of SHIPPED_PATHS) {
    test(`${file} selects golden-install-parity + golden-install-tree`, () => {
      const result = scopeFor([file]);
      assert.strictEqual(result.code_changed, true,
        `expected code_changed=true for ${file}, got: ${JSON.stringify(result)}`);
      assert.ok(
        result.targeted_tests.includes('tests/golden-install-parity.test.cjs'),
        `expected golden-install-parity in targeted_tests for ${file}, got: ${JSON.stringify(result.targeted_tests)}`,
      );
      assert.ok(
        result.targeted_tests.includes('tests/golden-install-tree.test.cjs'),
        `expected golden-install-tree in targeted_tests for ${file}, got: ${JSON.stringify(result.targeted_tests)}`,
      );
    });
  }

  test('docs/ change does NOT select golden-install-parity (negative case)', () => {
    const result = scopeFor(['docs/usage.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false for docs-only change, got: ${JSON.stringify(result)}`);
    assert.ok(
      !result.targeted_tests.includes('tests/golden-install-parity.test.cjs'),
      `docs-only change must NOT select golden-install-parity, got: ${JSON.stringify(result.targeted_tests)}`,
    );
  });

  test('non-shipped scripts/ file does NOT select golden-install-tree (allowlist is exact)', () => {
    // The rule allowlists only 3 named scripts + scripts/changeset|lib/. A
    // sibling script that is code but NOT installed verbatim must NOT pull in
    // the install-tree snapshot — proving this is not a blanket 'scripts/'
    // prefix that would re-run the golden on every script edit. Assert on
    // golden-install-TREE (the rule's dedicated test), not parity: many scripts/
    // paths legitimately select parity via the installer rule's
    // path.includes('install') substring.
    const result = scopeFor(['scripts/build-hooks.js']);
    assert.ok(
      !result.targeted_tests.includes('tests/golden-install-tree.test.cjs'),
      `non-shipped script must NOT select golden-install-tree, got: ${JSON.stringify(result.targeted_tests)}`,
    );
  });
});

describe('differential attribution gates travel with golden-parity (#2758)', () => {
  // #2758: the golden-parity rules ran tests/golden-install-parity.test.cjs on a
  // shipped-content-only PR — the archetypal emitted ripple — but selected neither
  // tests/emitted-provenance.test.cjs nor tests/emitted-attribution.test.cjs. Fix:
  // every rule that selects the golden also selects both emitted gates, so the
  // differential travels with the golden everywhere the golden travels (the
  // ADR-2719 dual-run premise: both green, fixtures untouched, until Phase 4).
  const { RULES } = require('../scripts/ci-test-scope.cjs');
  const GOLDEN = 'tests/golden-install-parity.test.cjs';
  const GATES = ['tests/emitted-provenance.test.cjs', 'tests/emitted-attribution.test.cjs'];

  test('every RULES entry selecting golden-install-parity also selects both emitted gates', () => {
    const goldenRules = RULES.filter(r => r.tests.includes(GOLDEN));
    // Guards the guard: if this count ever drops to 0, the assertion below is
    // vacuously true and would silently stop meaning anything.
    assert.ok(
      goldenRules.length >= 3,
      `expected at least 3 RULES entries selecting ${GOLDEN}, found ${goldenRules.length}: ` +
      `${goldenRules.map(r => r.name).join(', ')}`,
    );
    const offenders = goldenRules.filter(r => !GATES.every(g => r.tests.includes(g)));
    assert.deepStrictEqual(
      offenders.map(r => r.name),
      [],
      `rule(s) select ${GOLDEN} without both emitted gates: ${offenders.map(r => r.name).join(', ')}`,
    );
  });

  test('a pure shipped-content path selects both emitted gates alongside the golden', () => {
    // #2758 AC: "a pure shipped-content path (e.g. gsd-core/workflows/plan-phase.md)
    // selects the differential." The archetypal emitted ripple.
    const result = scopeFor(['gsd-core/workflows/plan-phase.md']);
    assert.strictEqual(result.code_changed, true);
    assert.ok(result.targeted_tests.includes(GOLDEN));
    for (const g of GATES) {
      assert.ok(
        result.targeted_tests.includes(g),
        `expected ${g} in targeted_tests for a shipped-content-only change, got: ${JSON.stringify(result.targeted_tests)}`,
      );
    }
  });

  test('a src/*.cts-only change selects both emitted gates (TS runtime sources rule)', () => {
    const result = scopeFor(['src/milestone.cts']);
    for (const g of GATES) {
      assert.ok(
        result.targeted_tests.includes(g),
        `expected ${g} in targeted_tests for src/ change, got: ${JSON.stringify(result.targeted_tests)}`,
      );
    }
  });

  test('bin/install.js selects both emitted gates (installer and package layout rule)', () => {
    const result = scopeFor(['bin/install.js']);
    for (const g of GATES) {
      assert.ok(
        result.targeted_tests.includes(g),
        `expected ${g} in targeted_tests for bin/install.js, got: ${JSON.stringify(result.targeted_tests)}`,
      );
    }
  });

  test('docs-only change still does NOT select the emitted gates (negative case)', () => {
    const result = scopeFor(['docs/usage.md']);
    for (const g of GATES) {
      assert.ok(!result.targeted_tests.includes(g), `docs-only must NOT select ${g}, got: ${JSON.stringify(result.targeted_tests)}`);
    }
  });
});

describe('RULES totality guard: no rule names a test file absent from disk (#2758)', () => {
  // #2758: Phase 4 (#2724) deletes tests/golden-install-parity.test.cjs. Without an
  // independent guard, a rule still naming it would produce no signal at all —
  // existingTests() (scripts/ci-test-scope.cjs) silently filters missing files out
  // of targeted_tests, so the gate simply stops being selected while CI stays
  // green. This exists independently of the fix above: it catches ANY rule naming
  // ANY absent file, not only the two gate filenames this issue is about.
  const { RULES, missingRuleTestFiles } = require('../scripts/ci-test-scope.cjs');

  test('no RULES entry today references a test file absent from disk', () => {
    assert.deepStrictEqual(
      missingRuleTestFiles(RULES), [],
      'RULES reference test file(s) that do not exist — see missingRuleTestFiles() in scripts/ci-test-scope.cjs',
    );
  });

  test('the guard mechanism itself catches a phantom entry (hostile input)', () => {
    // Runs the REAL checker function used by the module-load assertion in
    // scripts/ci-test-scope.cjs — not a hand-copied reimplementation of it — against
    // a synthetic rule table, proving the mechanism would have caught exactly the
    // Phase-4 shape: a rule naming a file that no longer exists on disk.
    const phantomFile = 'tests/does-not-exist-2758.test.cjs';
    assert.ok(
      !fs.existsSync(path.join(ROOT, phantomFile)),
      'precondition: the phantom file must genuinely not exist for this test to discriminate',
    );
    const synthetic = [
      { name: 'real', tests: ['tests/commands.test.cjs'] },
      { name: 'phantom', tests: [phantomFile, 'tests/commands.test.cjs'] },
    ];
    assert.deepStrictEqual(missingRuleTestFiles(synthetic), [phantomFile]);
  });

  test('an all-real synthetic table reports nothing missing (negative case)', () => {
    const synthetic = [{ name: 'real', tests: ['tests/commands.test.cjs', 'tests/ci-test-scope.test.cjs'] }];
    assert.deepStrictEqual(missingRuleTestFiles(synthetic), []);
  });
});

describe('code_changed=false implies clean output invariant', () => {
  // Fix 1: when code_changed is false, full_matrix, targeted_tests, windows_tests
  // must ALL be empty/false — even if a docs path coincidentally
  // matches a content rule via coarse substring (e.g. path.includes('install') or
  // path.includes('config')).

  test('docs-only: code_changed=false → product_changed=false, full_matrix=false, empty targeted_tests', () => {
    const result = scopeFor(['docs/usage.md']);
    assert.strictEqual(result.code_changed, false);
    assert.strictEqual(result.product_changed, false);
    assert.strictEqual(result.full_matrix, false);
    assert.deepStrictEqual(result.targeted_tests, []);
  });

  // docs/installer-migrations.md contains 'install' → would match the installer rule
  // via path.includes('install'). Normalization must suppress the contradictory output.
  test('docs/installer-migrations.md: code_changed=false AND product_changed=false AND full_matrix=false AND empty targeted_tests', () => {
    const result = scopeFor(['docs/installer-migrations.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false for docs/installer-migrations.md, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for docs/installer-migrations.md, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, false,
      `expected full_matrix=false for docs/installer-migrations.md, got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.targeted_tests, [],
      `expected empty targeted_tests for docs/installer-migrations.md, got: ${JSON.stringify(result.targeted_tests)}`);
  });

  // docs/how-to/configure-model-profiles.md contains 'config' → matches configuration rule.
  test('docs path matching config rule: code_changed=false → empty output (coarse-substring docs suppressed)', () => {
    const result = scopeFor(['docs/how-to/configure-model-profiles.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false);
    assert.strictEqual(result.full_matrix, false);
    assert.deepStrictEqual(result.targeted_tests, []);
  });

  // code_changed=true must produce >= 1 targeted_test or 'unit' fallback.
  test('code_changed=true implies non-empty targeted_tests', () => {
    for (const files of [
      ['src/semver.cts'],
      ['bin/gsd'],
      ['.github/workflows/test.yml'],
      ['.github/workflows/stale.yml'],
    ]) {
      const result = scopeFor(files);
      assert.strictEqual(result.code_changed, true,
        `expected code_changed=true for ${files}, got: ${JSON.stringify(result)}`);
      assert.ok(result.targeted_tests.length >= 1,
        `expected >= 1 targeted_test for ${files}, got: ${JSON.stringify(result.targeted_tests)}`);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-641-files-from-suite-token.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-641-files-from-suite-token (consolidation epic #1969 B6 #1975)", () => {
// Regression test for issue #641:
// `--files-from` with a bare suite token (e.g. "unit") crashes with
// "requested test file(s) not found: unit" instead of expanding the token
// to the matching suite's files.
//
// The bug: selectExplicitFiles() checked `available.has('unit')` against the
// set of *.test.cjs filenames. 'unit' is not a filename, so it landed in
// `missing` and caused exit 2. The fix teaches selectExplicitFiles() to
// delegate bare SUITES members to selectFiles() before the path-existence
// check.
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const HARNESS = path.join(__dirname, '..', 'scripts', 'run-tests.cjs');

const PASS_BODY = `'use strict';
const { test } = require('node:test');
test('noop', () => {});
`;

function seed(dir, names) {
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), PASS_BODY, 'utf8');
  }
}

function runHarness(testDir, args = [], extraEnv = {}) {
  const env = { ...process.env, GSD_TEST_DIR: testDir, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [HARNESS, ...args], {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf8',
  });
}

describe('bug #641 — --files-from with bare suite token', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-641-suite-token-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('--files-from with bare "unit" token expands to unit suite, does not exit 2', () => {
    // Seed a mix: one unit file, one security file.
    seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs']);
    const listPath = path.join(tmpDir, 'ci-selected-tests.txt');
    fs.writeFileSync(listPath, 'unit\n', 'utf8');

    const r = runHarness(tmpDir, ['--files-from', listPath]);

    // Must NOT exit 2 with the "not found" error.
    assert.notStrictEqual(
      r.status,
      2,
      `Expected exit 0 or 1, got 2.\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
    );
    assert.doesNotMatch(
      r.stderr,
      /requested test file\(s\) not found: unit/,
      `Must not emit "not found: unit".\nstderr: ${r.stderr}`,
    );
    // The unit suite file (a.test.cjs) must appear in the run.
    assert.ok(
      r.stderr.includes('a.test.cjs'),
      `Expected a.test.cjs (unit suite) to be selected.\nstderr: ${r.stderr}`,
    );
    // The security suite file must NOT be included (unit token = unit only).
    assert.ok(
      !r.stderr.includes('b.security.test.cjs'),
      `Expected b.security.test.cjs (security suite) to be excluded.\nstderr: ${r.stderr}`,
    );
  });

  test('--files-from with bare "unit" token exits 0 (tests run successfully)', () => {
    seed(tmpDir, ['a.test.cjs']);
    const listPath = path.join(tmpDir, 'ci-selected-tests.txt');
    fs.writeFileSync(listPath, 'unit\n', 'utf8');

    const r = runHarness(tmpDir, ['--files-from', listPath]);

    assert.strictEqual(
      r.status,
      0,
      `Expected exit 0.\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
    );
  });

  test('--files with bare "unit" token also resolves correctly', () => {
    seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs']);
    const r = runHarness(tmpDir, ['--files', 'unit']);

    assert.notStrictEqual(
      r.status,
      2,
      `Expected exit 0, got 2.\nstderr: ${r.stderr}`,
    );
    assert.doesNotMatch(r.stderr, /requested test file\(s\) not found: unit/);
    assert.ok(r.stderr.includes('a.test.cjs'), `a.test.cjs must be selected.\nstderr: ${r.stderr}`);
    assert.ok(!r.stderr.includes('b.security.test.cjs'), `security file must not be selected.\nstderr: ${r.stderr}`);
  });

  test('mixed: suite token "unit" alongside an explicit file resolves both', () => {
    seed(tmpDir, ['a.test.cjs', 'b.test.cjs', 'c.security.test.cjs']);
    const listPath = path.join(tmpDir, 'ci-selected-tests.txt');
    // 'unit' expands to [a.test.cjs, b.test.cjs]; b.test.cjs is explicit too.
    fs.writeFileSync(listPath, 'unit\nb.test.cjs\n', 'utf8');

    const r = runHarness(tmpDir, ['--files-from', listPath]);

    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    // Both unit files present; security not.
    assert.ok(r.stderr.includes('a.test.cjs'), `a.test.cjs must be selected.\nstderr: ${r.stderr}`);
    assert.ok(r.stderr.includes('b.test.cjs'), `b.test.cjs must be selected.\nstderr: ${r.stderr}`);
    assert.ok(!r.stderr.includes('c.security.test.cjs'), `c.security.test.cjs must be excluded.\nstderr: ${r.stderr}`);
  });

  test('#408 fallback: ci-test-scope "unit" sentinel does not crash run-tests', () => {
    // This test simulates the end-to-end #408 fallback path:
    // ci-test-scope produces "unit" (the fallback sentinel for "code changed
    // but no rule matched any test"), ci-prepare-test-scope writes it verbatim,
    // and run-tests must resolve it rather than crash.
    seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs']);
    // Simulate what ci-prepare-test-scope writes: "unit\n"
    const listPath = path.join(tmpDir, '.ci-selected-tests.txt');
    fs.writeFileSync(listPath, 'unit\n', 'utf8');

    const r = runHarness(tmpDir, ['--files-from', listPath]);

    assert.strictEqual(
      r.status,
      0,
      `#408 fallback: expected exit 0 but got ${r.status}.\nstderr: ${r.stderr}`,
    );
    assert.doesNotMatch(r.stderr, /not found: unit/);
    assert.ok(r.stderr.includes('a.test.cjs'), `unit test must run.\nstderr: ${r.stderr}`);
  });
});

// Regression test for issue #1329:
// ci-prepare-test-scope's empty-detection FALLBACK hardcoded an explicit file
// list that included tests/core.test.cjs — a file deleted in #1291. Every
// scoped lane (scope=targeted|windows) that hit the fallback wrote the stale
// path into .ci-selected-tests.txt and crashed run-tests with
// "requested test file(s) not found: core.test.cjs". The fix: existence-filter
// the fallback at write time, fall back to the 'unit' suite sentinel when
// nothing survives, and guard the FALLBACK constant against disk reality.
describe('bug #1329 — ci-prepare-test-scope fallback never emits a deleted file', () => {
  const { FALLBACK, FALLBACK_SENTINEL, SUITE_SENTINELS, resolveSelection } =
    require('../scripts/ci-prepare-test-scope.cjs');
  const REPO_ROOT = path.join(__dirname, '..');

  // Generative parity guard (DEFECT.GENERATIVE-FIX): the FALLBACK constant and
  // the test files on disk are two surfaces that must stay in sync. This fails
  // the instant a refactor deletes a file still named in FALLBACK — which is
  // precisely what #1291 did and CI did not catch.
  test('every FALLBACK entry resolves on disk or is a known suite sentinel', () => {
    for (const entry of FALLBACK) {
      const isSentinel = SUITE_SENTINELS.includes(entry);
      const exists = fs.existsSync(path.join(REPO_ROOT, entry));
      assert.ok(
        isSentinel || exists,
        `FALLBACK entry "${entry}" is neither an existing test file nor a suite sentinel — stale reference will crash scoped CI lanes (see #1329).`,
      );
    }
  });

  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempDir('gsd-1329-fallback-');
    fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty detection drops a non-existent fallback entry instead of emitting it', () => {
    // Create all but the last FALLBACK file under a controlled root, simulating
    // a since-deleted test (the #1329 mechanism), independent of which files
    // FALLBACK happens to name today.
    const present = FALLBACK.slice(0, -1);
    const absent = FALLBACK[FALLBACK.length - 1];
    for (const f of present) {
      fs.writeFileSync(path.join(tmpDir, f), PASS_BODY, 'utf8');
    }

    const lines = resolveSelection({ scope: 'targeted', targeted: '', windows: '', root: tmpDir });

    assert.ok(!lines.includes(absent), `absent file "${absent}" must be filtered out, got: ${lines.join(', ')}`);
    for (const f of present) {
      assert.ok(lines.includes(f), `present file "${f}" must survive, got: ${lines.join(', ')}`);
    }
  });

  test('empty detection with no surviving fallback files falls back to the unit sentinel', () => {
    // tmpDir/tests exists but contains none of the FALLBACK files.
    const lines = resolveSelection({ scope: 'windows', targeted: '', windows: '', root: tmpDir });
    assert.deepStrictEqual(lines, [FALLBACK_SENTINEL]);
  });

  test('detected list passes through verbatim — files and suite sentinels preserved, not existence-filtered', () => {
    // The detected list is already filtered by affected-tests-lib and may carry
    // a suite sentinel; ci-prepare-test-scope must not touch it.
    const lines = resolveSelection({
      scope: 'targeted',
      targeted: 'tests/does-not-exist.test.cjs unit',
      windows: '',
      root: tmpDir,
    });
    assert.deepStrictEqual(lines, ['tests/does-not-exist.test.cjs', 'unit']);
  });

  test('end-to-end: the real script writes a fallback list whose every entry resolves', () => {
    // Run the real script (subprocess) with empty detection inside an isolated
    // root that holds the FALLBACK files, then verify every line it wrote into
    // .ci-selected-tests.txt resolves — the exact scoped-lane path that crashed
    // in #1329. Hermetic: the temp root is removed by afterEach's cleanup().
    for (const f of FALLBACK) {
      fs.writeFileSync(path.join(tmpDir, f), PASS_BODY, 'utf8');
    }
    const prep = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'ci-prepare-test-scope.cjs')],
      { cwd: tmpDir, env: { ...process.env, TEST_SCOPE: 'targeted', TARGETED_TESTS: '', WINDOWS_TESTS: '' }, encoding: 'utf8' },
    );
    assert.strictEqual(prep.status, 0, `prepare step failed: ${prep.stderr}`);

    const selected = fs.readFileSync(path.join(tmpDir, '.ci-selected-tests.txt'), 'utf8');
    for (const line of selected.split(/\r?\n/).filter(Boolean)) {
      const isSentinel = SUITE_SENTINELS.includes(line);
      assert.ok(
        isSentinel || fs.existsSync(path.join(tmpDir, line)),
        `selected entry "${line}" does not resolve — would crash run-tests (#1329)`,
      );
    }
    assert.doesNotMatch(selected, /core\.test\.cjs/, 'deleted core.test.cjs must never be selected');
  });
});
  });
}

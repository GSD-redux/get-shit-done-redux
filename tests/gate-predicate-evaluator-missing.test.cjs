const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { evaluatePredicate } = require('../gsd-core/bin/lib/gate-predicate-evaluator.cjs');
const { buildPredicateDeps } = require('../gsd-core/bin/lib/check-command-router.cjs');

test('evaluatePredicate handles artifact-frontmatter-equals kind with numeric string coercion', () => {
  const dummyDeps = {
    runBoundedShell: () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    readFrontmatter: (filePath) => {
      const base = path.basename(filePath);
      if (base === 'clean-WINDOWS.md') {
        return { open_count: '0' };
      }
      if (base === 'unclean-WINDOWS.md') {
        return { open_count: '2' };
      }
      return {};
    },
    findPhaseArtifact: (dir, suffix) => path.join(dir, suffix),
  };

  const dummyCtx = { cwd: '/fake/project' };

  const cleanPred = {
    kind: 'artifact-frontmatter-equals',
    artifact: 'clean-WINDOWS.md',
    field: 'open_count',
    equals: 0,
  };

  const passRes = evaluatePredicate(cleanPred, dummyCtx, dummyDeps);
  assert.strictEqual(passRes.block, false, 'pass on matching numeric frontmatter field even if read as string');

  const uncleanPred = {
    kind: 'artifact-frontmatter-equals',
    artifact: 'unclean-WINDOWS.md',
    field: 'open_count',
    equals: 0,
  };

  const blockRes = evaluatePredicate(uncleanPred, dummyCtx, dummyDeps);
  assert.strictEqual(blockRes.block, true, 'block on non-matching frontmatter field');
});

test('evaluatePredicate with real buildPredicateDeps resolves project-level .planning/WINDOWS.md', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-pred-'));
  try {
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    const windowsPath = path.join(planningDir, 'WINDOWS.md');
    fs.writeFileSync(windowsPath, '---\nopen_count: 0\n---\n# Windows\n', 'utf8');

    const pred = {
      kind: 'artifact-frontmatter-equals',
      artifact: 'WINDOWS.md',
      field: 'open_count',
      equals: 0,
    };

    const ctx = { cwd: tmpDir };
    const deps = buildPredicateDeps();

    const res = evaluatePredicate(pred, ctx, deps);
    assert.strictEqual(res.block, false, 'real buildPredicateDeps must find .planning/WINDOWS.md and pass on open_count: 0');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

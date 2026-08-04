const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fc = require('fast-check');
const { evaluatePredicate } = require('../gsd-core/bin/lib/gate-predicate-evaluator.cjs');
const { buildPredicateDeps } = require('../gsd-core/bin/lib/check-command-router.cjs');

const dummyCtx = { cwd: '/fake/project' };
const basePredicate = {
  kind: 'artifact-frontmatter-equals',
  artifact: 'WINDOWS.md',
  field: 'open_count',
  equals: 0,
};

function dummyDeps(overrides = {}) {
  return {
    runBoundedShell: () => ({ exitCode: 0, stdout: '', stderr: '', signal: null, timedOut: false }),
    readFrontmatter: () => ({ open_count: '0' }),
    findPhaseArtifact: (dir, suffix) => path.join(dir, suffix),
    ...overrides,
  };
}

test('evaluatePredicate handles artifact-frontmatter-equals kind with numeric string coercion', () => {
  const deps = dummyDeps({
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
  });

  const cleanPred = {
    kind: 'artifact-frontmatter-equals',
    artifact: 'clean-WINDOWS.md',
    field: 'open_count',
    equals: 0,
  };

  const passRes = evaluatePredicate(cleanPred, dummyCtx, deps);
  assert.strictEqual(passRes.block, false, 'pass on matching numeric frontmatter field even if read as string');

  const uncleanPred = {
    kind: 'artifact-frontmatter-equals',
    artifact: 'unclean-WINDOWS.md',
    field: 'open_count',
    equals: 0,
  };

  const blockRes = evaluatePredicate(uncleanPred, dummyCtx, deps);
  assert.strictEqual(blockRes.block, true, 'block on non-matching frontmatter field');
});

test('artifact-frontmatter-equals rejects malformed declarations', () => {
  for (const artifact of [undefined, '']) {
    assert.throws(
      () => evaluatePredicate({ ...basePredicate, artifact }, dummyCtx, dummyDeps()),
      /non-empty string "artifact"/,
    );
  }
  for (const field of [undefined, '']) {
    assert.throws(
      () => evaluatePredicate({ ...basePredicate, field }, dummyCtx, dummyDeps()),
      /non-empty string "field"/,
    );
  }
  const { equals: _equals, ...withoutEquals } = basePredicate;
  assert.throws(
    () => evaluatePredicate(withoutEquals, dummyCtx, dummyDeps()),
    /requires an "equals" key/,
  );
});

test('artifact-frontmatter-equals fails closed for missing artifacts and fields', () => {
  const missingArtifact = evaluatePredicate(
    basePredicate,
    dummyCtx,
    dummyDeps({ findPhaseArtifact: () => null }),
  );
  assert.equal(missingArtifact.block, true);
  assert.equal(missingArtifact.details.artifactNotFound, true);

  const missingField = evaluatePredicate(
    basePredicate,
    dummyCtx,
    dummyDeps({ readFrontmatter: () => ({}) }),
  );
  assert.equal(missingField.block, true);
  assert.equal(missingField.details.match, false);
  assert.equal(missingField.details.actual, undefined);
});

test('artifact-frontmatter-equals blocks non-numeric values and surfaces parse failures', () => {
  const nonNumeric = evaluatePredicate(
    basePredicate,
    dummyCtx,
    dummyDeps({ readFrontmatter: () => ({ open_count: 'clean' }) }),
  );
  assert.equal(nonNumeric.block, true);
  assert.equal(nonNumeric.details.actual, 'clean');

  assert.throws(
    () => evaluatePredicate(
      basePredicate,
      dummyCtx,
      dummyDeps({ readFrontmatter: () => { throw new Error('invalid frontmatter'); } }),
    ),
    /invalid frontmatter/,
  );
});

test('artifact-frontmatter-equals validates its kind-specific dependencies', () => {
  const deps = dummyDeps();
  delete deps.findPhaseArtifact;
  assert.throws(
    () => evaluatePredicate(basePredicate, dummyCtx, deps),
    /predicate deps require a "findPhaseArtifact" function/,
  );

  const depsWithoutReader = dummyDeps();
  delete depsWithoutReader.readFrontmatter;
  assert.throws(
    () => evaluatePredicate(basePredicate, dummyCtx, depsWithoutReader),
    /predicate deps require a "readFrontmatter" function/,
  );
});

test('property: stringified scalar frontmatter equals its JSON scalar declaration', () => {
  const scalar = fc.oneof(
    fc.integer(),
    fc.boolean(),
    fc.string({ maxLength: 40 }),
    fc.constant(null),
  );
  fc.assert(
    fc.property(scalar, (value) => {
      const result = evaluatePredicate(
        { ...basePredicate, equals: value },
        dummyCtx,
        dummyDeps({ readFrontmatter: () => ({ open_count: String(value) }) }),
      );
      assert.equal(result.block, false);
    }),
  );
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

    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-pred-parent-'));
    try {
      const projectDir = path.join(parentDir, 'project');
      fs.mkdirSync(projectDir);
      fs.writeFileSync(path.join(parentDir, 'secret.md'), '---\nopen_count: 0\n---\n', 'utf8');
      assert.equal(deps.findPhaseArtifact(projectDir, '../secret.md'), null);
      assert.equal(deps.findPhaseArtifact(projectDir, '..\\secret.md'), null);
    } finally {
      const { cleanup } = require('./helpers.cjs');
      cleanup(parentDir);
    }
  } finally {
    const { cleanup } = require('./helpers.cjs');
    cleanup(tmpDir);
  }
});

test('buildPredicateDeps reports an artifact removed before its frontmatter read', () => {
  const missingPath = path.join(os.tmpdir(), 'gsd-test-predicate-artifact-missing.md');
  assert.throws(
    () => buildPredicateDeps().readFrontmatter(missingPath),
    /predicate artifact disappeared before it could be read/,
  );
});

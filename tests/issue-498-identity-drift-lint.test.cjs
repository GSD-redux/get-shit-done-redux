'use strict';
process.env.GSD_TEST_MODE = '1';

// Issue #498: the drift-guard lint. Every GSD package/repo coordinate that
// appears as a literal anywhere in the runtime/code surface must equal the
// value the Package Identity seam derives from package.json. This is what
// makes a repoint a one-line change: rename package.json, regenerate the seam,
// and any stale literal fails CI until it is updated.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { findCoordinateDrift } = require(
  path.join(ROOT, 'scripts', 'lint-package-identity-drift.cjs'),
);

const SEAM = { packageName: '@opengsd/get-shit-done-redux', repoSlug: 'open-gsd/get-shit-done-redux' };

describe('Issue #498: findCoordinateDrift (pure)', () => {
  test('a correct package literal is not drift', () => {
    const v = findCoordinateDrift('run npx -y @opengsd/get-shit-done-redux@latest', SEAM);
    assert.deepEqual(v, []);
  });

  test('a stale package literal (post-rename) is flagged', () => {
    const v = findCoordinateDrift('npx @opengsd/get-shit-done-classic@latest', SEAM);
    assert.equal(v.length, 1);
    assert.equal(v[0].found, '@opengsd/get-shit-done-classic');
    assert.equal(v[0].expected, SEAM.packageName);
    assert.equal(v[0].kind, 'package');
  });

  test('a different package (@opengsd/gsd-sdk) is NOT a gsd-core coordinate', () => {
    assert.deepEqual(findCoordinateDrift("require('@opengsd/gsd-sdk')", SEAM), []);
  });

  test('a correct github repo slug is not drift', () => {
    const v = findCoordinateDrift('https://github.com/open-gsd/get-shit-done-redux/issues', SEAM);
    assert.deepEqual(v, []);
  });

  test('a stale repo slug in a github url is flagged', () => {
    const v = findCoordinateDrift('https://github.com/tches/get-shit-done-classic.git', SEAM);
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, 'slug');
    assert.equal(v[0].found, 'tches/get-shit-done-classic');
  });

  test('reports 1-based line numbers', () => {
    const text = 'line1\nnpx @opengsd/get-shit-done-OLD@latest\nline3';
    const v = findCoordinateDrift(text, SEAM);
    assert.equal(v[0].line, 2);
  });
});

describe('Issue #498: the live repo passes the drift lint', () => {
  test('scanRepo finds zero drift against the current seam', () => {
    const { scanRepo } = require(path.join(ROOT, 'scripts', 'lint-package-identity-drift.cjs'));
    const violations = scanRepo(ROOT);
    assert.deepEqual(
      violations,
      [],
      'stale GSD coordinate literal(s) found:\n' +
        violations.map((d) => `  ${d.file}:${d.line} ${d.kind} '${d.found}' != '${d.expected}'`).join('\n'),
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-170-workflow-fallback-install-hint.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-170-workflow-fallback-install-hint (consolidation epic #1969 B4 #1973)", () => {
'use strict';
// allow-test-rule: source-text-is-the-product (see #170)
// Workflow markdown is shipped product text; this test validates fallback
// hint literals across all workflow files.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const LEGACY_HINT = 'npx get-shit-done-cc@latest --claude --local';
const CURRENT_HINT = 'npx -y @opengsd/gsd-core@latest --claude --local';

function findMarkdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findMarkdownFiles(full));
    else if (entry.isFile() && full.endsWith('.md')) out.push(full);
  }
  return out;
}

test('bug #170: workflow fallback hints do not reference get-shit-done-cc', () => {
  const files = findMarkdownFiles(WORKFLOWS_DIR);
  let legacyCount = 0;
  let currentCount = 0;

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    if (src.includes(LEGACY_HINT)) legacyCount += 1;
    if (src.includes(CURRENT_HINT)) currentCount += 1;
  }

  assert.equal(
    legacyCount,
    0,
    `workflow fallback hints must not reference legacy package (${LEGACY_HINT})`
  );
  assert.ok(
    currentCount > 0,
    `expected at least one workflow fallback hint to use current package (${CURRENT_HINT})`
  );
});
  });
}

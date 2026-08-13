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


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-498-package-identity.test.cjs — H3 Wave 5 (#3337)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-498-package-identity (H3 Wave 5 #3337)', () => {
'use strict';
// Issue #498: single Package Identity seam.
// The package coordinates (npm name, bin name, repo slug, changelog URL) are
// DERIVED from package.json, not re-typed. deriveIdentity is the pure core;
// the generated runtime module gsd-core/bin/lib/package-identity.cjs
// bakes those values at build time so it survives the install layout, where no
// package.json carries a .name — the only ones GSD stages are synthetic
// {"type":"commonjs"} markers, and since #2544 those live in GSD's own
// directories (hooks/, the native plugin dir) rather than the config root.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { deriveIdentity, formatManualInstall, slugifyPackageName } = require(
  path.join(ROOT, 'scripts', 'generate-package-identity.cjs'),
);
const GENERATED = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'package-identity.cjs');

describe('Issue #498: deriveIdentity (pure, package.json -> coordinates)', () => {
  const FAKE_PKG = {
    name: '@scope/example-pkg',
    bin: { 'example-pkg': 'bin/install.js', 'extra-tool': 'x.cjs' },
    repository: { type: 'git', url: 'git+https://github.com/acme/example-pkg.git' },
  };

  test('packageName is package.json .name', () => {
    assert.equal(deriveIdentity(FAKE_PKG).packageName, '@scope/example-pkg');
  });

  test('binName is the FIRST bin key (primary launcher)', () => {
    assert.equal(deriveIdentity(FAKE_PKG).binName, 'example-pkg');
  });

  test('repoSlug is owner/name parsed from repository.url (git+ and .git stripped)', () => {
    assert.equal(deriveIdentity(FAKE_PKG).repoSlug, 'acme/example-pkg');
  });

  test('repoUrl is the cleaned https github url', () => {
    assert.equal(deriveIdentity(FAKE_PKG).repoUrl, 'https://github.com/acme/example-pkg');
  });

  test('changelogRawUrl points at raw.githubusercontent main CHANGELOG', () => {
    assert.equal(
      deriveIdentity(FAKE_PKG).changelogRawUrl,
      'https://raw.githubusercontent.com/acme/example-pkg/main/CHANGELOG.md',
    );
  });

  test('derives the real GSD coordinates from the repo package.json', () => {
    const real = require(path.join(ROOT, 'package.json'));
    const id = deriveIdentity(real);
    assert.equal(id.packageName, '@opengsd/gsd-core');
    assert.equal(id.binName, 'gsd-core');
    assert.equal(id.repoSlug, 'open-gsd/gsd-core');
  });

  test('deriveIdentity returns cacheSlug for @opengsd/gsd-core', () => {
    const real = require(path.join(ROOT, 'package.json'));
    const id = deriveIdentity(real);
    assert.equal(id.cacheSlug, 'opengsd-gsd-core');
  });

  test('deriveIdentity returns updateCacheFileName for @opengsd/gsd-core', () => {
    const real = require(path.join(ROOT, 'package.json'));
    const id = deriveIdentity(real);
    assert.equal(id.updateCacheFileName, 'gsd-update-check-opengsd-gsd-core.json');
  });
});

describe('Issue #498: slugifyPackageName (pure helper for cache filename)', () => {
  test('slugifyPackageName strips leading @, replaces / with -, for @opengsd/gsd-core', () => {
    assert.equal(slugifyPackageName('@opengsd/gsd-core'), 'opengsd-gsd-core');
  });

  test('slugifyPackageName returns empty string for empty input', () => {
    assert.equal(slugifyPackageName(''), '');
  });
});

describe('Issue #498: formatManualInstall (the npx fallback command)', () => {
  test('global scope, no runtime -> npx with --global only', () => {
    assert.equal(
      formatManualInstall({ packageName: '@scope/example-pkg', binName: 'example-pkg', scope: 'global' }),
      'npx -y --package=@scope/example-pkg@latest -- example-pkg --global',
    );
  });

  test('local scope with runtime -> --<runtime> before --<scope>', () => {
    assert.equal(
      formatManualInstall({ packageName: '@scope/example-pkg', binName: 'example-pkg', scope: 'local', runtime: 'claude' }),
      'npx -y --package=@scope/example-pkg@latest -- example-pkg --claude --local',
    );
  });

  test('matches the literal update.md uses for the real package (global+claude)', () => {
    const id = deriveIdentity(require(path.join(ROOT, 'package.json')));
    assert.equal(
      formatManualInstall({ packageName: id.packageName, binName: id.binName, scope: 'global', runtime: 'claude' }),
      'npx -y --package=@opengsd/gsd-core@latest -- gsd-core --claude --global',
    );
  });
});

describe('Issue #498: generated runtime module (baked)', () => {
  // The committed-generated-file freshness guard moved to
  // `npm run lint:generated-sync` (generate-package-identity.cjs --check), where
  // it runs against the committed file in both local and CI lint lanes instead
  // of being masked by gsd-test's `npm run build` leg regenerating the artifact.

  test('requiring the generated module exposes the real coordinates', () => {
    const id = require(GENERATED);
    assert.equal(id.packageName, '@opengsd/gsd-core');
    assert.equal(id.binName, 'gsd-core');
    assert.equal(id.repoSlug, 'open-gsd/gsd-core');
  });

  test('generated module exports cacheSlug matching @opengsd/gsd-core', () => {
    const id = require(GENERATED);
    assert.equal(id.cacheSlug, 'opengsd-gsd-core');
  });

  test('generated module exports updateCacheFileName matching @opengsd/gsd-core', () => {
    const id = require(GENERATED);
    assert.equal(id.updateCacheFileName, 'gsd-update-check-opengsd-gsd-core.json');
  });

  test('generated manualInstallCommand closes over the baked coordinates', () => {
    const id = require(GENERATED);
    assert.equal(
      id.manualInstallCommand({ scope: 'global', runtime: 'claude' }),
      'npx -y --package=@opengsd/gsd-core@latest -- gsd-core --claude --global',
    );
  });
});
  });
}

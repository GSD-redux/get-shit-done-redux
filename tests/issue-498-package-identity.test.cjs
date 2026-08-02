'use strict';
process.env.GSD_TEST_MODE = '1';

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

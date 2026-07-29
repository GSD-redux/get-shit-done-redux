'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatReleaseNotes,
  classifyTitle,
} = require('../scripts/release-notes/format-github-release-notes.cjs');

// ---------------------------------------------------------------------------
// classifyTitle
// ---------------------------------------------------------------------------

describe('classifyTitle', () => {
  test('returns Feature for feat(#39): title', () => {
    assert.equal(
      classifyTitle('* feat(#39): milestone-prefixed phase IDs by @trek-e in https://github.com/open-gsd/gsd-core/pull/565'),
      'Feature'
    );
  });

  test('returns Feature for feat: title', () => {
    assert.equal(
      classifyTitle('* feat: some feature by @trek-e in https://github.com/open-gsd/gsd-core/pull/1'),
      'Feature'
    );
  });

  test('returns Feature for feature(x): title', () => {
    assert.equal(
      classifyTitle('* feature(x): something by @trek-e in https://github.com/open-gsd/gsd-core/pull/2'),
      'Feature'
    );
  });

  test('returns Fix for fix(#1): title', () => {
    assert.equal(
      classifyTitle('* fix(#1): some fix by @trek-e in https://github.com/open-gsd/gsd-core/pull/3'),
      'Fix'
    );
  });

  test('returns Fix for fix: title', () => {
    assert.equal(
      classifyTitle('* fix: another fix by @trek-e in https://github.com/open-gsd/gsd-core/pull/4'),
      'Fix'
    );
  });

  test('returns Internal for chore(#2): title (#2716)', () => {
    assert.equal(
      classifyTitle('* chore(#2): some chore by @trek-e in https://github.com/open-gsd/gsd-core/pull/5'),
      'Internal'
    );
  });

  test('returns Internal for docs: title (#2716)', () => {
    assert.equal(
      classifyTitle('* docs: documentation update by @trek-e in https://github.com/open-gsd/gsd-core/pull/6'),
      'Internal'
    );
  });

  test('returns Enhancement for [codex] Rebrand', () => {
    assert.equal(
      classifyTitle('* [codex] Rebrand public docs as GSD Core by @jeremymcs in https://github.com/open-gsd/gsd-core/pull/524'),
      'Enhancement'
    );
  });

  test('returns Enhancement for plain title with no conventional prefix', () => {
    assert.equal(
      classifyTitle('* Main changes by @trek-e in https://github.com/open-gsd/gsd-core/pull/7'),
      'Enhancement'
    );
  });
});

// ---------------------------------------------------------------------------
// formatReleaseNotes
// ---------------------------------------------------------------------------

const SAMPLE_BODY = `## What's Changed
* feat(#39): milestone-prefixed phase IDs by @trek-e in https://github.com/open-gsd/gsd-core/pull/565
* fix(#557): milestone erased on update by @trek-e in https://github.com/open-gsd/gsd-core/pull/563
* enhance(#2): smoother phase transitions by @trek-e in https://github.com/open-gsd/gsd-core/pull/560

## New Contributors
* @someone made their first contribution in https://github.com/open-gsd/gsd-core/pull/123

**Full Changelog**: https://github.com/open-gsd/gsd-core/compare/v1.2.0...v1.3.0-rc.1
`;

describe('formatReleaseNotes', () => {
  test('prerelease=true: Install block contains @next and pre-release text', () => {
    const out = formatReleaseNotes({
      generatedBody: SAMPLE_BODY,
      version: '1.3.0-rc.1',
      prerelease: true,
      packageName: '@opengsd/gsd-core',
    });

    assert.ok(out.startsWith('## Install'), 'should start with ## Install');
    assert.ok(out.includes('This pre-release is published to npm under the `next` dist-tag.'), 'should mention next dist-tag');
    assert.ok(out.includes('npm i @opengsd/gsd-core@1.3.0-rc.1'), 'should contain versioned install');
    assert.ok(out.includes('@next'), 'should contain @next tag');
  });

  test('prerelease=true: sections appear in correct order', () => {
    const out = formatReleaseNotes({
      generatedBody: SAMPLE_BODY,
      version: '1.3.0-rc.1',
      prerelease: true,
      packageName: '@opengsd/gsd-core',
    });

    const installIdx = out.indexOf('## Install');
    const whatsChangedIdx = out.indexOf("## What's Changed");
    const featureIdx = out.indexOf('### Feature');
    const enhancementIdx = out.indexOf('### Enhancement');
    const fixIdx = out.indexOf('### Fix');
    const newContribIdx = out.indexOf('## New Contributors');
    const fullChangelogIdx = out.indexOf('**Full Changelog**:');

    assert.ok(installIdx < whatsChangedIdx, '## Install should precede ## Whats Changed');
    assert.ok(whatsChangedIdx < featureIdx, "## What's Changed should precede ### Feature");
    assert.ok(featureIdx < enhancementIdx, '### Feature should precede ### Enhancement');
    assert.ok(enhancementIdx < fixIdx, '### Enhancement should precede ### Fix');
    assert.ok(fixIdx < newContribIdx, '### Fix should precede ## New Contributors');
    assert.ok(newContribIdx < fullChangelogIdx, '## New Contributors should precede **Full Changelog**');
  });

  test('prerelease=true: New Contributors block is preserved', () => {
    const out = formatReleaseNotes({
      generatedBody: SAMPLE_BODY,
      version: '1.3.0-rc.1',
      prerelease: true,
      packageName: '@opengsd/gsd-core',
    });

    assert.ok(out.includes('## New Contributors'), 'should contain ## New Contributors');
    assert.ok(
      out.includes('* @someone made their first contribution'),
      'should preserve contributor bullet'
    );
  });

  test('prerelease=true: ends with Full Changelog line and no trailing newline', () => {
    const out = formatReleaseNotes({
      generatedBody: SAMPLE_BODY,
      version: '1.3.0-rc.1',
      prerelease: true,
      packageName: '@opengsd/gsd-core',
    });

    assert.ok(
      out.endsWith('**Full Changelog**: https://github.com/open-gsd/gsd-core/compare/v1.2.0...v1.3.0-rc.1'),
      'should end with Full Changelog line'
    );
    assert.ok(!out.endsWith('\n'), 'should have no trailing newline');
  });

  test('prerelease=false: Install block uses @latest and omits pre-release sentence', () => {
    const out = formatReleaseNotes({
      generatedBody: SAMPLE_BODY,
      version: '1.3.0',
      prerelease: false,
      packageName: '@opengsd/gsd-core',
    });

    assert.ok(out.includes('@latest'), 'should contain @latest');
    assert.ok(
      !out.includes('This pre-release is published'),
      'should not contain pre-release sentence'
    );
    assert.ok(out.includes('npm i @opengsd/gsd-core@1.3.0'), 'should contain versioned install');
  });

  test('empty-section omission: only fix bullets → no Feature or Enhancement headers', () => {
    const fixOnlyBody = `## What's Changed
* fix(#1): only a fix by @trek-e in https://github.com/open-gsd/gsd-core/pull/1

**Full Changelog**: https://github.com/open-gsd/gsd-core/compare/v1.0.0...v1.0.1
`;

    const out = formatReleaseNotes({
      generatedBody: fixOnlyBody,
      version: '1.0.1',
      prerelease: false,
      packageName: '@opengsd/gsd-core',
    });

    assert.ok(out.includes('### Fix'), 'should contain ### Fix');
    assert.ok(!out.includes('### Feature'), 'should NOT contain ### Feature');
    assert.ok(!out.includes('### Enhancement'), 'should NOT contain ### Enhancement');
  });

  test('ordering within a category is preserved', () => {
    const twoFeatBody = `## What's Changed
* feat(#1): first feature by @trek-e in https://github.com/open-gsd/gsd-core/pull/1
* feat(#2): second feature by @trek-e in https://github.com/open-gsd/gsd-core/pull/2

**Full Changelog**: https://github.com/open-gsd/gsd-core/compare/v1.0.0...v1.1.0
`;

    const out = formatReleaseNotes({
      generatedBody: twoFeatBody,
      version: '1.1.0',
      prerelease: false,
      packageName: '@opengsd/gsd-core',
    });

    const firstIdx = out.indexOf('feat(#1): first feature');
    const secondIdx = out.indexOf('feat(#2): second feature');
    assert.ok(firstIdx !== -1, 'first feature bullet should be present');
    assert.ok(secondIdx !== -1, 'second feature bullet should be present');
    assert.ok(firstIdx < secondIdx, 'first feature should appear before second feature');
  });

  test('#2716: a test:-titled PR is omitted from the rendered release notes entirely', () => {
    const body = `## What's Changed
* feat(#39): real feature by @trek-e in https://github.com/open-gsd/gsd-core/pull/565
* test(#99): add regression coverage by @trek-e in https://github.com/open-gsd/gsd-core/pull/900

## New Contributors

**Full Changelog**: https://github.com/open-gsd/gsd-core/compare/v1.2.0...v1.3.0-rc.1
`;
    const out = formatReleaseNotes({
      generatedBody: body,
      version: '1.3.0-rc.1',
      prerelease: true,
      packageName: '@opengsd/gsd-core',
    });
    // The feature bullet must appear under ### Feature.
    assert.ok(out.includes('feat(#39): real feature'), 'feature bullet must be present');
    assert.ok(out.includes('### Feature'), 'Feature section must render');
    // The test:-titled PR must NOT appear anywhere in the user-facing output.
    assert.ok(
      !out.includes('test(#99): add regression coverage'),
      'a test:-titled PR must be omitted from the rendered release notes (#2716)',
    );
    // And there must be no user-facing "Enhancement" section here (only the feature).
    assert.ok(!out.includes('### Enhancement'), 'no Enhancement section expected when the only non-feature is Internal');
  });
});

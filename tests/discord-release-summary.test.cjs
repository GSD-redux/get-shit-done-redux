'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const {
  buildDiscordReleasePayload,
  cleanBullet,
  collectSections,
  extractInstallCommand,
} = require('../scripts/release-notes/discord-release-summary.cjs');

const sampleRelease = {
  tagName: 'v1.4.0-rc.1',
  name: 'v1.4.0-rc.1',
  isPrerelease: true,
  url: 'https://github.com/open-gsd/gsd-core/releases/tag/v1.4.0-rc.1',
  body: [
    '## Install',
    '',
    'This pre-release is published to npm under the `next` dist-tag.',
    '',
    '```bash',
    'npm i @opengsd/gsd-core@1.4.0-rc.1',
    '# or',
    'npm i @opengsd/gsd-core@next',
    '```',
    '',
    '## What\'s Changed',
    '',
    '### Feature',
    '* feat(#656): Research module cache by @trek-e in https://github.com/open-gsd/gsd-core/pull/664',
    '* feat(#717): size budget on bytes by @trek-e in https://github.com/open-gsd/gsd-core/pull/719',
    '* feat(#159): auto-use existing RESEARCH.md by @trek-e in https://github.com/open-gsd/gsd-core/pull/718',
    '* feat(#703): add --granularity override by @trek-e in https://github.com/open-gsd/gsd-core/pull/750',
    '* feat(#25): scope verifier Step 7b by @trek-e in https://github.com/open-gsd/gsd-core/pull/753',
    '',
    '### Fix',
    '* fix(#663): resolve CodeQL alerts by @trek-e in https://github.com/open-gsd/gsd-core/pull/665',
    '',
    '**Full Changelog**: https://github.com/open-gsd/gsd-core/compare/v1.3.1...v1.4.0-rc.1',
  ].join('\n'),
};

describe('discord release summary', () => {
  test('builds a hybrid payload with a preserved full changelog URL', () => {
    const payload = buildDiscordReleasePayload({
      release: sampleRelease,
      packageName: '@opengsd/gsd-core',
      maxContent: 1850,
    });

    assert.equal(payload.username, 'GSD Releases');
    assert.match(payload.content, /\*\*@opengsd\/gsd-core v1\.4\.0-rc\.1 pre-release is out\*\*/);
    assert.match(payload.content, /`npm i @opengsd\/gsd-core@1\.4\.0-rc\.1`/);
    assert.match(payload.content, /Full changelog: https:\/\/github\.com\/open-gsd\/gsd-core\/releases\/tag\/v1\.4\.0-rc\.1/);
    assert.doesNotMatch(payload.content, /\*\*Full Changelog\*\*:\s*$/m);
    assert.match(payload.content, /Research module cache \(#664\)/);
    assert.match(payload.content, /\.\.\.and 1 more features/);
    assert.equal(payload.embeds[0].fields[1].value, '`next`');
  });

  test('summarizes auto-generated What Changed bullets when release notes are not yet curated', () => {
    const sections = collectSections([
      '## What\'s Changed',
      '* feat: add thing by @trek-e in https://github.com/open-gsd/gsd-core/pull/10',
      '* fix: repair thing by @trek-e in https://github.com/open-gsd/gsd-core/pull/11',
      '* enhance: improve thing by @trek-e in https://github.com/open-gsd/gsd-core/pull/13',
      '* docs: explain thing by @trek-e in https://github.com/open-gsd/gsd-core/pull/12',
    ].join('\n'));

    assert.deepEqual(sections.get('Feature'), ['add thing (#10)']);
    assert.deepEqual(sections.get('Fix'), ['repair thing (#11)']);
    // enhance: is a genuine user-facing enhancement (not in the non-user-facing set).
    assert.ok(sections.get('Enhancement') && sections.get('Enhancement').length === 1, 'enhance: bullet lands in Enhancement');
    // #2716: docs: routes to the Internal section, not Enhancement.
    assert.deepEqual(sections.get('Internal'), ['explain thing (#12)']);
  });

  test('cleans common GitHub release-note link noise without deleting issue references', () => {
    assert.equal(
      cleanBullet('* fix: repair [#670](https://github.com/open-gsd/gsd-core/issues/670) by @trek-e in https://github.com/open-gsd/gsd-core/pull/675'),
      'repair #670 (#675)'
    );
  });

  test('falls back to the release channel when no install block exists', () => {
    assert.equal(
      extractInstallCommand('', '@opengsd/gsd-core', { tagName: 'v1.4.0-rc.1', isPrerelease: true }),
      'npm i @opengsd/gsd-core@next'
    );
    assert.equal(
      extractInstallCommand('', '@opengsd/gsd-core', { tagName: 'v1.4.0', isPrerelease: false }),
      'npm i @opengsd/gsd-core@latest'
    );
  });
});

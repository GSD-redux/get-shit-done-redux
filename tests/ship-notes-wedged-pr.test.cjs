const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripFencedCode } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const SHIP_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md');

function extractStep(name) {
  const content = fs.readFileSync(SHIP_MD, 'utf8');
  const open = `<step name="${name}">`;
  const start = content.indexOf(open);
  assert.notEqual(start, -1, `ship.md must contain a ${name} step`);
  const end = content.indexOf('</step>', start);
  assert.notEqual(end, -1, `${name} step must close`);
  return content.slice(start, end);
}

describe('#2783 ship.md track_shipping self-heals wedged PRs', () => {
  const step = extractStep('track_shipping');

  test('track_shipping inspects mergeStateStatus post-push', () => {
    assert.ok(
      /mergeStateStatus/.test(step),
      'track_shipping must query mergeStateStatus to detect wedged PRs (#2783)'
    );
  });

  test('track_shipping self-heals BLOCKED PRs by pushing a recovery commit without skip token', () => {
    assert.ok(
      /BLOCKED/.test(step),
      'track_shipping must check for BLOCKED merge state (#2783)'
    );
    assert.ok(
      /trigger CI/.test(step) || /allow-empty/.test(step),
      'track_shipping must push a recovery commit to trigger CI when wedged (#2783)'
    );
  });

  test('track_shipping and the following step remain outside balanced code fences', () => {
    const content = fs.readFileSync(SHIP_MD, 'utf8');
    const stripped = stripFencedCode(content);
    assert.strictEqual(stripped.unterminatedFence, false, 'ship.md must not contain an unterminated code fence');
    assert.match(
      stripped.text,
      /<step name="track_shipping">[\s\S]*?<\/step>\s*<step name="ship_post_capability_dispatch">/,
      'the track_shipping boundary and following step must remain visible after stripping code fences',
    );
  });
});

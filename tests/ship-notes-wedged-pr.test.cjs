const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
});

// allow-test-rule: source-text-is-the-product (see #2641)
// The mempalace-capture skill gates on config.mempalace.capture_artifacts.
// The capability registry declares this key with default: true, so an absent
// key must be treated as enabled. The skill previously used `!== true` which
// treated absent (undefined) as disabled — inverted from the schema default.
// The fix changes it to `=== false` (disabled only on explicit false).

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL = path.join(__dirname, '..', 'skills', 'gsd-mempalace-capture', 'SKILL.md');
const COMMAND = path.join(__dirname, '..', 'commands', 'gsd', 'mempalace-capture.md');

describe('#2641 — mempalace-capture gate treats absent capture_artifacts as enabled', () => {
  test('SKILL.md uses === false (disabled only on explicit false), not !== true', () => {
    const text = fs.readFileSync(SKILL, 'utf8');
    assert.ok(
      text.includes('capture_artifacts === false'),
      'SKILL.md must use capture_artifacts === false (defaults to enabled when absent, matching the schema) — not !== true (#2641)',
    );
    assert.ok(
      !text.includes('capture_artifacts !== true'),
      'SKILL.md must NOT use the inverted capture_artifacts !== true check (#2641)',
    );
  });

  test('commands/gsd/mempalace-capture.md uses === false, not !== true', () => {
    const text = fs.readFileSync(COMMAND, 'utf8');
    assert.ok(
      text.includes('capture_artifacts === false'),
      'commands/gsd/mempalace-capture.md must use capture_artifacts === false (#2641)',
    );
    assert.ok(
      !text.includes('capture_artifacts !== true'),
      'commands/gsd/mempalace-capture.md must NOT use the inverted check (#2641)',
    );
  });
});

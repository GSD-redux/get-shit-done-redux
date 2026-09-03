'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

test('configured entrypoint validation exposes an aggregate typed boundary', () => {
  assert.equal(
    typeof hooksSurface.validateConfiguredEntrypoints,
    'function',
    'the Runtime Hooks Surface must export configured-entrypoint validation',
  );
});

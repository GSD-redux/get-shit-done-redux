'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * tests/registry-axes-parity.test.cjs — regression coverage for issue #2810.
 *
 * `scripts/registry-schema.cjs`'s `AXES` (the eight ADR-1239 negotiated axes
 * mirrored into the EoS Registry schema) and `src/host-integration.cts`'s
 * `HOST_INTEGRATION_AXES` (the canonical runtime vocabulary, compiled to
 * `gsd-core/bin/lib/host-integration.cjs`) are two independent, hand-written
 * mirrors of the same underlying axis vocabulary. ADR-1239 amendment #2481
 * added a ninth axis, `effortSurface`, to the canonical vocabulary but not to
 * the registry's closed `AXES` key set — so a registry entry that faithfully
 * mirrored its upstream `registry/eos-entry.json` (which DOES carry
 * `effortSurface`) was rejected outright by the registry's exact-key-set
 * check. `OPTIONAL_AXES` fixes that by adding `effortSurface` as a ninth,
 * OPTIONAL registry axis key. This file asserts the two vocabularies stay in
 * parity going forward, and pins the boundary behavior of the fix itself.
 *
 * Entries below are hand-built plain objects — never read from
 * `docs/registries/eos.json` on disk, and no source file is read+string
 * matched (both would trip `local/no-source-grep` / defeat the point of a
 * behavioral regression test).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  AXES,
  OPTIONAL_AXES,
  AXES_FREE_STRING,
  validateEntries,
  renderMarkdown,
} = require(path.join(__dirname, '..', 'scripts', 'registry-schema.cjs'));

const { HOST_INTEGRATION_AXES } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'host-integration.cjs'),
);

// ─── Fixtures ─────────────────────────────────────────────────────────────

// A fully-valid eos entry carrying exactly the eight REQUIRED axes keys (no
// `effortSurface`) — same shape as the two real docs/registries/eos.json
// entries (gsd-cursor, gsd-omp), both published before ADR-1239 amendment
// #2481 and neither carrying `effortSurface`.
function baseEosEntry() {
  return {
    id: 'my-host-plugin',
    name: 'My Host Plugin',
    type: 'eos',
    repo: 'octocat/my-host-plugin',
    description: 'Embeds GSD as an orchestration engine in My Host.',
    author: 'Octocat',
    license: 'MIT',
    enginesGsd: '>=1.6.0 <3.0.0',
    install: 'See the My Host plugin marketplace listing.',
    uninstall: 'Uninstall via the My Host plugin manager.',
    protocolVersion: 1,
    interactions: {
      interfacePoints: ['command', 'state'],
      profile: 'programmatic-cli',
      axes: {
        embeddingMode: 'imperative',
        commandSurface: 'slash-file',
        dispatch: 'Supports nested background dispatch up to depth 3.',
        modelMode: 'active',
        hookBus: 'host',
        stateIO: 'filesystem',
        transport: 'mcp',
        runtime: 'node',
      },
    },
    discussion: 'https://github.com/octocat/my-host-plugin/discussions/2',
  };
}

// ─── Parity: registry AXES/OPTIONAL_AXES vs canonical HOST_INTEGRATION_AXES ──

describe('registry-axes-parity: AXES/OPTIONAL_AXES vs HOST_INTEGRATION_AXES', () => {
  test('every key shared between (AXES ∪ OPTIONAL_AXES) and HOST_INTEGRATION_AXES has an identical enum array', () => {
    const registryAxisKeys = new Set([...Object.keys(AXES), ...Object.keys(OPTIONAL_AXES)]);
    const canonicalAxisKeys = new Set(Object.keys(HOST_INTEGRATION_AXES));
    const shared = [...registryAxisKeys].filter((k) => canonicalAxisKeys.has(k));

    // Sanity: the shared set must be non-empty, or the loop below would pass vacuously.
    assert.ok(shared.length > 0, 'expected at least one axis key shared between the two vocabularies');

    for (const key of shared) {
      const registryValue = AXES[key] !== undefined ? AXES[key] : OPTIONAL_AXES[key];
      if (registryValue === AXES_FREE_STRING) continue; // dispatch: asserted separately below
      assert.deepEqual(
        registryValue,
        HOST_INTEGRATION_AXES[key],
        `registry axis "${key}" enum must match HOST_INTEGRATION_AXES.${key}`,
      );
    }
  });

  test('dispatch is registry-only — absent from HOST_INTEGRATION_AXES — and carries the free-string sentinel', () => {
    assert.equal(AXES.dispatch, AXES_FREE_STRING);
    assert.equal(Array.isArray(AXES.dispatch), false);
    assert.equal(Object.hasOwn(HOST_INTEGRATION_AXES, 'dispatch'), false);
  });

  test('OPTIONAL_AXES.effortSurface equals the canonical HOST_INTEGRATION_AXES.effortSurface exactly', () => {
    assert.deepEqual(OPTIONAL_AXES.effortSurface, ['argv', 'none']);
    assert.deepEqual(OPTIONAL_AXES.effortSurface, HOST_INTEGRATION_AXES.effortSurface);
  });
});

// ─── Boundary coverage: axes key-count limit-1 / limit / limit+1 ──────────

describe('validateEntries: eos axes key-count boundaries (limit-1 / limit / limit+1)', () => {
  test('limit-1: 7 keys (one required key missing) is INVALID and names the missing key', () => {
    const entry = baseEosEntry();
    delete entry.interactions.axes.runtime;
    assert.equal(Object.keys(entry.interactions.axes).length, 7);

    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'interactions.axes' && /missing/i.test(e.reason));
    assert.ok(err, `expected a missing-key error, got: ${JSON.stringify(verdict.errors)}`);
    assert.ok(err.reason.includes('runtime'), `expected the error to name "runtime", got: ${err.reason}`);
  });

  test('limit: 8 keys (exactly the required axes) is VALID', () => {
    const entry = baseEosEntry();
    assert.equal(Object.keys(entry.interactions.axes).length, 8);

    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.errors, []);
  });

  test('limit+1: 8 required + effortSurface = 9 keys is VALID', () => {
    const entry = baseEosEntry();
    entry.interactions.axes.effortSurface = 'argv';
    assert.equal(Object.keys(entry.interactions.axes).length, 9);

    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.errors, []);
  });

  test('8 required + an unknown 9th key (bogusAxis) is INVALID and names the unknown key', () => {
    const entry = baseEosEntry();
    entry.interactions.axes.bogusAxis = 'x';
    assert.equal(Object.keys(entry.interactions.axes).length, 9);

    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'interactions.axes' && /unknown/i.test(e.reason));
    assert.ok(err, `expected an unknown-key error, got: ${JSON.stringify(verdict.errors)}`);
    assert.ok(err.reason.includes('bogusAxis'), `expected the error to name "bogusAxis", got: ${err.reason}`);
  });

  test('8 required + effortSurface with a value outside the enum ("config-file") is INVALID', () => {
    const entry = baseEosEntry();
    entry.interactions.axes.effortSurface = 'config-file';

    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.axes.effortSurface'));
  });
});

// ─── renderMarkdown: effortSurface presence/absence ────────────────────────

describe('renderMarkdown: eos effortSurface rendering', () => {
  test('an entry carrying effortSurface renders "effortSurface=argv"', () => {
    const entry = baseEosEntry();
    entry.interactions.axes.effortSurface = 'argv';
    const rendered = renderMarkdown([entry], { type: 'eos', sourceFile: 'eos.json' });
    assert.ok(rendered.includes('effortSurface=argv'), rendered);
  });

  test('an entry that omits effortSurface renders no "effortSurface" substring at all', () => {
    const entry = baseEosEntry();
    const rendered = renderMarkdown([entry], { type: 'eos', sourceFile: 'eos.json' });
    assert.ok(!rendered.includes('effortSurface'), rendered);
  });
});

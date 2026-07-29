'use strict';

/**
 * golden-parity-single-source.test.cjs — anti-divergence guard (#2266, carried
 * forward by #2724 / ADR-2719 Phase 4).
 *
 * tests/golden-install-parity.test.cjs and scripts/gen-golden-install-parity-zcode.cjs
 * used to each carry their OWN inline copy of buildParityManifest plus its 4
 * exclusion constants (VOLATILE_FILES, HOOK_CONFIG_FILES,
 * HOOK_CONFIG_RELATIVE_PATHS, EXCLUDED_PREFIXES). The two copies drifted —
 * the generator's copy was missing the realpath/`<HOME>` normalization the
 * test harness's copy had — and shipped broken fixtures three times (#2086,
 * #2095, #2100). Phase 1 of the golden-install-parity redesign (#2266)
 * consolidated both call sites onto a single canonical implementation in
 * tests/helpers/install-shared.cjs. ADR-2264 Phase 1 (that consolidation) is
 * explicitly RETAINED by ADR-2719 — #2724 deletes the two ORIGINAL consumers
 * (golden-install-parity.test.cjs, gen-golden-install-parity-zcode.cjs), but
 * their two REPLACEMENTS (tests/helpers/emitted-runtime.cjs's currentManifests
 * and tests/helpers/emitted-provenance.cjs's loadManifests) import
 * buildParityManifest the exact same way, so the divergence risk this guard
 * exists for is unchanged — only the consumer names moved.
 *
 * This guard (mirrors the ADR-2121 anti-divergence pattern) enforces that
 * consolidation stays consolidated:
 *   1. install-shared.cjs actually exports a working buildParityManifest +
 *      the 4 exclusion constants with the expected shapes.
 *   2. No downstream consumer re-declares its own inline copy of the builder
 *      function or the exclusion constants.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('install-shared.cjs exports the canonical buildParityManifest + exclusion constants (#2266)', () => {
  const installShared = require('./helpers/install-shared.cjs');

  assert.equal(
    typeof installShared.buildParityManifest,
    'function',
    'install-shared.cjs must export buildParityManifest as the single source of truth'
  );

  assert.ok(
    installShared.VOLATILE_FILES instanceof Set,
    'VOLATILE_FILES must be a Set'
  );
  assert.ok(
    installShared.HOOK_CONFIG_FILES instanceof Set,
    'HOOK_CONFIG_FILES must be a Set'
  );
  assert.ok(
    installShared.HOOK_CONFIG_RELATIVE_PATHS instanceof Set,
    'HOOK_CONFIG_RELATIVE_PATHS must be a Set'
  );
  assert.ok(
    Array.isArray(installShared.EXCLUDED_PREFIXES),
    'EXCLUDED_PREFIXES must be an array'
  );
  assert.ok(
    installShared.EXCLUDED_PREFIXES.includes('gsd-core/bin/lib/'),
    "EXCLUDED_PREFIXES must include 'gsd-core/bin/lib/' (compiled runtime artifacts, build-environment-dependent)"
  );
});

// The anti-divergence check below reads the two downstream .cjs source files
// as plain text to prove they no longer re-declare the builder/constants
// inline — the runtime-contract-under-test IS the source text (whether a
// second inline copy exists), not behavior a require() could exercise.
//
// ALL FIVE identifiers are guarded, not just buildParityManifest + VOLATILE_FILES:
// the drift that shipped broken fixtures was a MISSING exclusion-constant entry
// (#2100 = generator's HOOK_CONFIG_FILES copy lacked settings.local.json; #2095 =
// kimi's HOOK_CONFIG_RELATIVE_PATHS entry), so a re-declared HOOK_CONFIG_FILES /
// HOOK_CONFIG_RELATIVE_PATHS / EXCLUDED_PREFIXES is exactly the failure class this
// guard exists to prevent — checking only two of four would leave that gap open.
const FORBIDDEN_INLINE = [
  { label: 'buildParityManifest',        re: /function\s+buildParityManifest/ },
  { label: 'VOLATILE_FILES',             re: /const\s+VOLATILE_FILES\s*=\s*new\s+Set/ },
  { label: 'HOOK_CONFIG_FILES',          re: /const\s+HOOK_CONFIG_FILES\s*=\s*new\s+Set/ },
  { label: 'HOOK_CONFIG_RELATIVE_PATHS', re: /const\s+HOOK_CONFIG_RELATIVE_PATHS\s*=\s*new\s+Set/ },
  { label: 'EXCLUDED_PREFIXES',          re: /const\s+EXCLUDED_PREFIXES\s*=\s*\[/ },
];

const CONSUMERS = [
  { name: 'tests/helpers/emitted-runtime.cjs',    rel: ['tests', 'helpers', 'emitted-runtime.cjs'],    from: './install-shared.cjs' },
  { name: 'tests/helpers/emitted-provenance.cjs', rel: ['tests', 'helpers', 'emitted-provenance.cjs'], from: './install-shared.cjs' },
];

for (const consumer of CONSUMERS) {
  test(`${consumer.name} does not re-declare an inline buildParityManifest or any exclusion constant (#2266)`, () => {
    // allow-test-rule: source text is the product for this anti-divergence check, see #2266
    const content = fs.readFileSync(path.join(ROOT, ...consumer.rel), 'utf8');
    for (const { label, re } of FORBIDDEN_INLINE) {
      assert.ok(
        !re.test(content),
        `${consumer.name} must import ${label} from ${consumer.from}, not re-declare it inline`
      );
    }
  });
}

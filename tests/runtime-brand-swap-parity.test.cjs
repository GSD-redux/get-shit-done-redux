'use strict';

/**
 * runtime-brand-swap-parity.test.cjs — DEFECT.GENERATIVE-FIX family parity
 * guard for the #2284(b) protected-region fix.
 *
 * `applyClaudeCodeBrandSwap` (src/runtime-artifact-conversion.cts) rewrites
 * bare "Claude Code" self-references to a runtime's brand name EXCEPT inside
 * `<runtime_compatibility>...</runtime_compatibility>` blocks, which must
 * survive byte-for-byte verbatim (a runtime-comparison table that says
 * "Claude Code" is describing Claude Code's own behavior, not this
 * runtime's — brand-swapping it mislabels the comparison). The Windsurf
 * converter got this fix; every sibling markdown/agent converter that also
 * performs a "Claude Code" -> brand swap needed the SAME fix (#2284b
 * follow-up).
 *
 * A per-converter regression test would only catch a REintroduction in the
 * converter it targets — the exact shape of divergence CONTEXT.md's
 * DEFECT.GENERATIVE-FIX names. This file instead drives every brand-swapping
 * converter through ONE assertion body from a declarative table, so a NEW
 * runtime converter that skips `applyClaudeCodeBrandSwap` and reintroduces a
 * naive `.replace(/\bClaude Code\b/g, brand)` fails the moment it is added
 * to the table below — and the floor test catches an entry silently dropped
 * from the table itself.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const conv = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
const capabilityRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

// Qwen/Hermes brand-swap the "Claude Code" literal to a descriptor-driven
// value (runtime.hostBehaviors.brandingRewrites), not a hardcoded string —
// read the SAME source the converters themselves read, so this test can
// never drift from the shipped descriptor.
function brandingRewrite(runtime, key) {
  return capabilityRegistry.runtimes[runtime].runtime.hostBehaviors.brandingRewrites[key];
}

const QWEN_BRAND = brandingRewrite('qwen', 'Claude Code');
const HERMES_BRAND = brandingRewrite('hermes', 'Claude Code');

/**
 * Every runtime converter in src/runtime-artifact-conversion.cts that
 * performs a "Claude Code" -> brand swap, normalized to a uniform
 * `(content) => string` shape regardless of the underlying function's real
 * signature (fixed-brand markdown converters vs descriptor-driven
 * agent/rewrite functions).
 */
const BRAND_SWAP_CONVERTERS = [
  { name: 'cursor', brand: 'Cursor', convert: (content) => conv.convertClaudeToCursorMarkdown(content) },
  { name: 'windsurf', brand: 'Windsurf', convert: (content) => conv.convertClaudeToWindsurfMarkdown(content) },
  { name: 'augment', brand: 'Augment', convert: (content) => conv.convertClaudeToAugmentMarkdown(content) },
  { name: 'trae', brand: 'Trae', convert: (content) => conv.convertClaudeToTraeMarkdown(content) },
  { name: 'codebuddy', brand: 'CodeBuddy', convert: (content) => conv.convertClaudeToCodebuddyMarkdown(content) },
  { name: 'cline', brand: 'Cline', convert: (content) => conv.convertClaudeToCliineMarkdown(content) },
  // Dynamic (descriptor-driven) brand converters — same protected-region
  // guard, brand value sourced from capability.json instead of a literal.
  { name: 'qwen-agent', brand: QWEN_BRAND, convert: (content) => conv.convertClaudeAgentToQwenAgent(content) },
  {
    name: 'qwen-runtime-rewrites',
    brand: QWEN_BRAND,
    convert: (content) => conv._applyRuntimeRewrites(content, 'qwen', '~/.qwen/', false, undefined),
  },
  {
    name: 'hermes-runtime-rewrites',
    brand: HERMES_BRAND,
    convert: (content) => conv._applyRuntimeRewrites(content, 'hermes', '~/.hermes/', false, undefined),
  },
];

// Floor, not an exact count (mirrors MINIMUM_MANIFEST_FAMILIES in
// tests/helpers/install-shared.cjs): the point of this table is that a NEW
// brand-swapping converter must be added here explicitly and reviewably.
// Lowering it is a deliberate act; this only guards it from silently
// shrinking underneath a refactor.
const MINIMUM_BRAND_SWAP_CONVERTER_COUNT = 9;

const PROTECTED_BLOCK =
  '<runtime_compatibility>\n| Runtime | Claude Code | Other |\n|---|---|---|\n| x | Claude Code native | y |\n</runtime_compatibility>';

function buildFixture() {
  return `Before: mentions Claude Code here.\n\n${PROTECTED_BLOCK}\n\nAfter: also mentions Claude Code here.\n`;
}

describe('everyRuntimeMarkdownConverterPreservesRuntimeCompatibilityBlocks', () => {
  test('the brand-swap converter table has not silently shrunk below its floor', () => {
    assert.ok(
      BRAND_SWAP_CONVERTERS.length >= MINIMUM_BRAND_SWAP_CONVERTER_COUNT,
      `expected at least ${MINIMUM_BRAND_SWAP_CONVERTER_COUNT} brand-swapping converters in the table, `
      + `got ${BRAND_SWAP_CONVERTERS.length}`,
    );
  });

  for (const { name, brand, convert } of BRAND_SWAP_CONVERTERS) {
    test(`${name}: <runtime_compatibility> block is preserved verbatim while outside text is brand-swapped`, () => {
      // Guard the table entry itself before trusting the assertions below —
      // an undefined brand (a descriptor lookup that silently returned
      // nothing) would make every `includes()` check below vacuously
      // meaningless.
      assert.strictEqual(typeof brand, 'string', `${name}: table entry must declare a string brand`);
      assert.ok(brand.length > 0, `${name}: table entry brand must be non-empty`);

      const result = convert(buildFixture());

      assert.ok(
        result.includes(PROTECTED_BLOCK),
        `${name}: <runtime_compatibility> block must survive byte-for-byte verbatim`,
      );
      assert.ok(
        result.includes(`Before: mentions ${brand} here.`),
        `${name}: text BEFORE the protected block must be brand-swapped to "${brand}"`,
      );
      assert.ok(
        result.includes(`After: also mentions ${brand} here.`),
        `${name}: text AFTER the protected block must be brand-swapped to "${brand}"`,
      );
      // The protected block's OWN "Claude Code" occurrences must not have
      // been swapped anywhere in the output — a stronger form of the
      // verbatim-block assertion above, independent of exact block framing.
      const claudeCodeOccurrencesInResult = (result.match(/Claude Code/g) || []).length;
      assert.strictEqual(
        claudeCodeOccurrencesInResult, 2,
        `${name}: expected exactly the 2 "Claude Code" occurrences inside the protected block to survive `
        + `(got ${claudeCodeOccurrencesInResult} — outside occurrences must be brand-swapped away)`,
      );
    });
  }
});

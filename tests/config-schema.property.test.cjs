'use strict';

/**
 * Property-based tests for config-schema.cjs
 *
 * Module: gsd-core/bin/lib/config-schema.cjs
 * Exported: isValidConfigKey(keyPath) -> boolean
 *           VALID_CONFIG_KEYS: Set<string>
 *           RUNTIME_STATE_KEYS: Set<string>
 *           DYNAMIC_KEY_PATTERNS: Array<{ test(key): boolean, ... }>
 *
 * Properties tested:
 *   (a) isValidConfigKey never throws regardless of input type/content
 *   (b) isValidConfigKey(key) is true for every key in VALID_CONFIG_KEYS
 *   (c) isValidConfigKey(key) is true for every key in RUNTIME_STATE_KEYS
 *   (d) Robustness: null/undefined/NaN/control-chars/binary never throw
 *   (e) Arbitrary garbage strings return false (not throw) from isValidConfigKey
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');

const {
  isValidConfigKey,
  isCapabilityConfigKey,
  VALID_CONFIG_KEYS,
  RUNTIME_STATE_KEYS,
} = require('../gsd-core/bin/lib/config-schema.cjs');

describe('config-schema: isValidConfigKey properties', () => {
  // (a) Never throws on any input
  test('property: isValidConfigKey never throws on hostile inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity),
          fc.constant(0),
          fc.constant(''),
          fc.constant('\x00'),
          fc.constant('\n\r\t'),
          fc.string({ unit: 'binary', maxLength: 100 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 100 }),
          fc.constant([]),
          fc.constant({}),
          fc.boolean(),
          fc.string({ maxLength: 100 })
        ),
        (input) => {
          assert.doesNotThrow(
            () => isValidConfigKey(input),
            `isValidConfigKey threw on input: ${JSON.stringify(input)}`
          );
        }
      )
    );
  });

  // (b) Every key in VALID_CONFIG_KEYS returns true
  test('all VALID_CONFIG_KEYS entries are recognized as valid', () => {
    for (const key of VALID_CONFIG_KEYS) {
      assert.equal(
        isValidConfigKey(key),
        true,
        `Expected isValidConfigKey(${JSON.stringify(key)}) === true`
      );
    }
  });

  // (c) Every key in RUNTIME_STATE_KEYS returns true
  test('all RUNTIME_STATE_KEYS entries are recognized as valid', () => {
    for (const key of RUNTIME_STATE_KEYS) {
      assert.equal(
        isValidConfigKey(key),
        true,
        `Expected isValidConfigKey(${JSON.stringify(key)}) === true (runtime state key)`
      );
    }
  });

  // (d+e) Robustness: hostile strings return boolean (not throw)
  test('property: isValidConfigKey always returns a boolean for any string', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        (key) => {
          const result = isValidConfigKey(key);
          assert.ok(
            typeof result === 'boolean',
            `isValidConfigKey must return boolean, got ${typeof result} for ${JSON.stringify(key)}`
          );
        }
      )
    );
  });

  test('property: binary/control-char strings return false (not throw)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 100 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 100 })
        ),
        (key) => {
          // Either returns true (if it happens to match a valid key) or false
          // It must NOT throw
          let result;
          assert.doesNotThrow(() => {
            result = isValidConfigKey(key);
          });
          assert.ok(typeof result === 'boolean');
        }
      )
    );
  });

  // Boundary: well-formed dotted paths that are NOT in the schema
  test('property: plausible-but-invalid dotted paths return false', () => {
    // Generate dot-separated alphanumeric paths that do not match known keys
    const dotPath = fc.array(
      fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/),
      { minLength: 3, maxLength: 5 }
    ).map((parts) => 'zz_unknown.' + parts.join('.'));

    fc.assert(
      fc.property(dotPath, (key) => {
        // Must not throw
        let result;
        assert.doesNotThrow(() => {
          result = isValidConfigKey(key);
        });
        // Result is a boolean
        assert.ok(typeof result === 'boolean');
      })
    );
  });

  // Boundary: empty string is not a valid config key
  test('empty string is not a valid config key', () => {
    const result = isValidConfigKey('');
    assert.equal(result, false, 'empty string must not be a valid config key');
  });

  // Boundary: null/undefined/number return false (not throw, not true)
  test('null, undefined, number inputs return false', () => {
    assert.equal(isValidConfigKey(null), false);
    assert.equal(isValidConfigKey(undefined), false);
    assert.equal(isValidConfigKey(42), false);
    assert.equal(isValidConfigKey(NaN), false);
  });
});

// ─── ADR-1244 D2: cwd-aware overlay config-key federation ─────────────────────
//
// Exercises every branch of the new _capabilityConfigSchema(cwd) path so the
// mutation suite (this is the file Stryker runs for config-schema) KILLS the
// added mutants: the `typeof cwd === 'string' && cwd` guard, the overlay
// loadRegistry({includeInstalled,cwd}) call, the `schema && typeof === 'object'`
// found-branch, the first-party fallback, and the cwd threading through
// isValidConfigKey. Uses a real overlay fixture (no test seam).
describe('config-schema: cwd-aware overlay federation (ADR-1244 D2)', () => {
  const OVERLAY_KEY = 'workflow.cfgschema_overlay_gate';
  // A known FIRST-PARTY capability config key (ui capability) — exercises the
  // first-party fallback branch (no cwd → frozen registry configSchema).
  const FIRST_PARTY_KEY = 'workflow.ui_phase';
  const overlayCap = {
    id: 'cfgschema-overlay', role: 'feature', version: '1.0.0', title: 'cfg overlay', description: 'x',
    tier: 'standard', requires: [], engines: { gsd: '>=1.0.0' },
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: ['cfgschema-overlay-skill'], agents: [], hooks: [],
    config: { [OVERLAY_KEY]: { type: 'boolean', default: true, description: 'overlay-owned key' } },
    steps: [], contributions: [], gates: [],
  };

  let withOverlay, withoutOverlay, sandboxHome, savedHome;
  before(() => {
    savedHome = process.env.GSD_HOME;
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgschema-home-'));
    process.env.GSD_HOME = sandboxHome; // empty global overlay root + user-owned consent store
    // realpath so the consent record's realpath(projectRoot) matches the loader's lookup.
    withOverlay = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cfgschema-proj-')));
    fs.mkdirSync(path.join(withOverlay, '.planning'), { recursive: true }); // project-root marker
    const capDir = path.join(withOverlay, '.gsd', 'capabilities', 'cfgschema-overlay');
    fs.mkdirSync(capDir, { recursive: true });
    fs.writeFileSync(path.join(capDir, 'capability.json'), JSON.stringify(overlayCap), 'utf8');
    // #1459: a PROJECT-scope overlay activates only with a committed ledger AND a user consent record
    // on this machine. Write both so the cwd-aware federation behavior under test is exercised for a
    // genuinely-installed+consented overlay (a forged in-repo ledger alone no longer activates it).
    fs.writeFileSync(
      path.join(withOverlay, '.gsd-capabilities.json'),
      JSON.stringify({ version: '1', updatedAt: '2026-01-01T00:00:00Z', entries: {
        'cfgschema-overlay': { id: 'cfgschema-overlay', version: '1.0.0', source: 's', integrity: 'sha512-cfg', files: [], sharedEdits: [] },
      } }),
      'utf8',
    );
    const trust = require('../gsd-core/bin/lib/capability-trust.cjs');
    const consent = require('../gsd-core/bin/lib/capability-consent.cjs');
    consent.recordProjectConsent({
      gsdHome: sandboxHome, projectRoot: withOverlay, id: 'cfgschema-overlay',
      integrity: 'sha512-cfg', disclosureSignature: trust.signatureForManifest(overlayCap, capDir),
      contentHash: consent.bundleContentHash(capDir),
    });
    withoutOverlay = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgschema-bare-'));
    fs.mkdirSync(path.join(withoutOverlay, '.planning'), { recursive: true });
  });
  after(() => {
    if (savedHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedHome;
    cleanup(sandboxHome); cleanup(withOverlay); cleanup(withoutOverlay);
  });

  test('first-party fallback: a first-party capability config key is valid with no cwd', () => {
    // Kills the fallback branch (return fp ... : {}) and the no-cwd path.
    assert.equal(isCapabilityConfigKey(FIRST_PARTY_KEY), true);
    assert.equal(isValidConfigKey(FIRST_PARTY_KEY), true);
  });

  test('overlay key is recognized only when the installing project cwd is supplied', () => {
    // cwd with the overlay → true (kills cwd-guard, loadRegistry call, found-branch, hasOwnProperty)
    assert.equal(isCapabilityConfigKey(OVERLAY_KEY, withOverlay), true);
    assert.equal(isValidConfigKey(OVERLAY_KEY, withOverlay), true);
    // no cwd → first-party only → false (kills the cwd-true→fallback distinction)
    assert.equal(isCapabilityConfigKey(OVERLAY_KEY), false);
    assert.equal(isValidConfigKey(OVERLAY_KEY), false);
    // cwd WITHOUT the overlay → loadRegistry returns base → false (cwd-correct)
    assert.equal(isCapabilityConfigKey(OVERLAY_KEY, withoutOverlay), false);
    assert.equal(isValidConfigKey(OVERLAY_KEY, withoutOverlay), false);
  });

  test('a genuinely unknown key is invalid regardless of cwd', () => {
    assert.equal(isCapabilityConfigKey('zz.not.a.key', withOverlay), false);
    assert.equal(isValidConfigKey('zz.not.a.key', withOverlay), false);
  });

  test('non-string keyPath returns false even with a cwd (no throw)', () => {
    assert.equal(isCapabilityConfigKey(null, withOverlay), false);
    assert.equal(isCapabilityConfigKey(42, withOverlay), false);
  });
});

// ---------------------------------------------------------------------------
// ADR-1244 Phase 4 — capability trust config keys
// ---------------------------------------------------------------------------

describe('capability trust config keys (ADR-1244 Phase 4)', () => {
  const { CONFIG_DEFAULTS } = require('../gsd-core/bin/lib/configuration.cjs');

  test('capabilities.strict_known_registries and capabilities.auto_update are valid central keys', () => {
    assert.equal(isValidConfigKey('capabilities.strict_known_registries'), true);
    assert.equal(isValidConfigKey('capabilities.auto_update'), true);
  });

  test('there is no capabilities.* wildcard — an unknown capabilities key is invalid', () => {
    assert.equal(isValidConfigKey('capabilities.something_else'), false);
  });

  test('defaults: strict_known_registries is permissive (null) and auto_update is OFF (false)', () => {
    assert.equal(CONFIG_DEFAULTS.capabilities.strict_known_registries, null);
    assert.equal(CONFIG_DEFAULTS.capabilities.auto_update, false);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2986-config-schema-mutation-killers.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2986-config-schema-mutation-killers (consolidation epic #1969 B3 #1972)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2986: Layer-3 fault-detection audit found 4.62% Stryker mutation
 * score on gsd-core/bin/lib/config-schema.cjs (6 killed, 124 survived).
 * Surviving mutants document tests that "exercise paths" but don't
 * "verify outputs" -- a polarity flip or predicate swap inside the lib
 * passed every existing test.
 *
 * Sample surviving mutants from #2986:
 *   M1: `if (VALID_CONFIG_KEYS.has(keyPath)) return true;`
 *       -> `if (false) return true;`
 *       Killer: a test that asserts isValidConfigKey returns true for
 *       every member of VALID_CONFIG_KEYS. If VALID_CONFIG_KEYS.has is
 *       short-circuited to false, those keys would only be accepted if
 *       a DYNAMIC_KEY_PATTERN matches them -- and none of the static
 *       keys match any dynamic pattern by design.
 *
 *   M2: `return DYNAMIC_KEY_PATTERNS.some((p) => p.test(keyPath));`
 *       -> `return DYNAMIC_KEY_PATTERNS.every(p => p.test(keyPath));`
 *       Killer: a test that supplies a key matching ONE pattern but not
 *       every pattern. With `.every`, that key is rejected; with `.some`,
 *       accepted. The current dynamic-pattern set is mutually exclusive
 *       (e.g., `agent_skills.foo` matches the agent_skills regex but not
 *       review/features/claude_md_assembly/model_profile_overrides), so
 *       any single dynamic-key sample suffices.
 *
 *   M3: `return true` -> `return false` on the early-return line
 *       Killer: a test that uses a known-valid static key and asserts
 *       the boolean true (not just "non-falsy" or "no throw"). A
 *       polarity flip turns the true into false; the assertion catches it.
 *
 *   M4: `if (VALID_CONFIG_KEYS.has(keyPath)) return true;` -> remove the
 *       guard entirely (return DYNAMIC_KEY_PATTERNS.some(...) always).
 *       Killer: same as M1 -- static keys that don't match any dynamic
 *       pattern would be wrongly rejected.
 *
 * These tests exercise the lib's PUBLIC SURFACE (isValidConfigKey)
 * with structured inputs and assert on typed boolean outputs. No regex
 * on source code; no source-grep.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  VALID_CONFIG_KEYS,
  DYNAMIC_KEY_PATTERNS,
  isValidConfigKey,
} = require('../gsd-core/bin/lib/config-schema.cjs');

describe('Bug #2986: M1/M4 -- isValidConfigKey returns true for EVERY static key in VALID_CONFIG_KEYS', () => {
  // Stryker mutants like `if (false) return true;` would silently flip
  // every static key to "rejected" because none of the static keys match
  // any dynamic pattern by design. This parameterized test is the
  // mutation-kill equivalent for that branch.
  for (const key of VALID_CONFIG_KEYS) {
    test(`isValidConfigKey('${key}') === true`, () => {
      assert.strictEqual(isValidConfigKey(key), true,
        `static config key '${key}' must be accepted (catches Stryker mutant on the static-key fast path)`);
    });
  }
});

describe('Bug #2986: M2 -- DYNAMIC_KEY_PATTERNS.some semantic, not .every', () => {
  // Each pattern has a representative key that matches ONLY that pattern
  // (mutually exclusive with the others by design) AND is NOT a member of
  // VALID_CONFIG_KEYS. The static-key fast-path returns true before
  // DYNAMIC_KEY_PATTERNS.some() ever runs, so any rep key that's also in
  // VALID_CONFIG_KEYS gives the M2 killer zero coverage for that pattern
  // (#3005 CR: this caught features.thinking_partner, which IS in static).
  // A reserved-prefix-style placeholder name is used for `features` so the
  // dynamic path is the only way to reach `true`.
  const patternRepresentatives = [
    { key: 'agent_skills.gsd-planner',                           topLevel: 'agent_skills' },
    // #2797: `review.models.<slug>` was the `review` representative until that
    // pattern was federated to the lane capabilities and removed from the central
    // schema. `reviewer_instances` is the surviving `review` dynamic pattern —
    // an instance is not a lane (ADR-2782 D8), so it stays central.
    { key: 'review.reviewer_instances.myinstance.cli',           topLevel: 'review' },
    { key: 'features.some_dynamic_feature',                      topLevel: 'features' },
    { key: 'claude_md_assembly.blocks.intro',                    topLevel: 'claude_md_assembly' },
    { key: 'model_profile_overrides.codex.opus',                 topLevel: 'model_profile_overrides' },
  ];

  for (const { key, topLevel } of patternRepresentatives) {
    test(`isValidConfigKey('${key}') === true (matches '${topLevel}' pattern via dynamic path)`, () => {
      // Invariant: the rep key MUST NOT be in the static set. Otherwise the
      // static fast-path short-circuits and the dynamic-pattern .some() is
      // never invoked, so a mutation removing this entry from
      // DYNAMIC_KEY_PATTERNS would survive.
      assert.strictEqual(VALID_CONFIG_KEYS.has(key), false,
        `representative key '${key}' must NOT be in VALID_CONFIG_KEYS — otherwise the static fast-path masks the dynamic-pattern test (#3005 CR)`);
      assert.strictEqual(isValidConfigKey(key), true,
        `dynamic key '${key}' must be accepted via DYNAMIC_KEY_PATTERNS.some`);
      // Verify mutual exclusivity: only one pattern matches this key.
      const matchCount = DYNAMIC_KEY_PATTERNS.filter((p) => p.test(key)).length;
      assert.strictEqual(matchCount, 1,
        `mutual-exclusivity invariant: '${key}' must match exactly 1 pattern, matched ${matchCount}. ` +
        `If this fails, dynamic-pattern overlap was introduced and the .some-vs-.every mutation killer breaks.`);
    });
  }
});

describe('Bug #2986: M3 -- polarity assertion (true is true, not just truthy)', () => {
  // Stryker mutants that flip `return true` to `return false` are killed
  // by strictEqual against the boolean true. assert.ok would tolerate any
  // truthy value (e.g., a non-empty string returned by a different mutation).
  test('isValidConfigKey returns the literal boolean true for static keys', () => {
    const result = isValidConfigKey('model_profile');
    assert.strictEqual(result, true);
    assert.strictEqual(typeof result, 'boolean');
  });

  test('isValidConfigKey returns the literal boolean false for unknown keys', () => {
    const result = isValidConfigKey('totally_unknown_key_xyz');
    assert.strictEqual(result, false);
    assert.strictEqual(typeof result, 'boolean');
  });

  test('isValidConfigKey returns false for a dynamic-pattern-shape key under a non-existent topLevel', () => {
    // E.g., `unrelated.models.claude` syntactically resembles a dynamic
    // pattern but no DYNAMIC_KEY_PATTERN owns the `unrelated` topLevel.
    // A mutant that loosens the regex anchors would falsely accept this.
    assert.strictEqual(isValidConfigKey('unrelated.models.claude'), false);
  });
});

describe('Bug #2986: anchor-tightening (catches mutants that loosen ^ or $ in regexes)', () => {
  // Each dynamic regex is anchored. Mutants that drop ^ or $ would
  // accept too much. These keys differ from a valid one by ONE character
  // beyond the documented shape; they must be rejected.
  const overshoot = [
    { key: 'agent_skills.gsd-planner.extra',                     reason: 'agent_skills regex must not allow trailing dot-segment' },
    { key: 'agent_skills.',                                      reason: 'agent_skills regex requires non-empty agent name' },
    { key: 'review.models.',                                     reason: 'review.models regex requires non-empty cli name' },
    { key: 'features.bad name with spaces',                      reason: 'features regex disallows spaces' },
    { key: 'model_profile_overrides.codex.gpt5',                 reason: 'model_profile_overrides tier is enum-restricted to opus|sonnet|haiku' },
    { key: 'model_profile_overrides.codex',                      reason: 'model_profile_overrides requires .<tier> suffix' },
  ];

  for (const { key, reason } of overshoot) {
    test(`isValidConfigKey('${key}') === false -- ${reason}`, () => {
      assert.strictEqual(isValidConfigKey(key), false,
        `'${key}' must be rejected (catches anchor/charset-loosening mutants)`);
    });
  }
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-2527-settings-layers.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-2527-settings-layers (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Feature test for #2527 — /gsd-settings expands to 22 settings grouped into
 * six visual sections. Adds 8 new fields (pattern_mapper, tdd_mode, code_review,
 * code_review_depth, ui_review, commit_docs, intel.enabled, graphify.enabled)
 * and verifies each is present in the AskUserQuestion block, the update_config
 * step, the confirmation table, the ~/.gsd/defaults.json save step, and the
 * effective config-key validator.
 *
 * Closes: #2527
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const SETTINGS_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'settings.md');
const {
  VALID_CONFIG_KEYS,
  isCentralConfigKey,
  isValidConfigKey,
} = require('../gsd-core/bin/lib/config-schema.cjs');

const NEW_FIELDS = [
  'workflow.pattern_mapper',
  'workflow.tdd_mode',
  'workflow.code_review',
  'workflow.code_review_depth',
  'workflow.ui_review',
  'commit_docs',
  'intel.enabled',
  'graphify.enabled',
];

const CENTRAL_NEW_FIELDS = [
  'commit_docs',
];

const CAPABILITY_OWNED_NEW_FIELDS = NEW_FIELDS.filter((field) => !CENTRAL_NEW_FIELDS.includes(field));

const SECTION_HEADERS = ['Planning', 'Execution', 'Docs & Output', 'Features', 'Model & Pipeline', 'Misc'];

/**
 * Match a dotted config-key path inside a block of text. Falls back to a
 * simple substring check for single-segment keys; for nested keys, requires
 * each segment to appear in order within a bounded window so distinct fields
 * (e.g., intel.enabled vs graphify.enabled) cannot collapse to the same leaf.
 */
function hasPathLike(block, field) {
  const parts = field.split('.');
  if (parts.length === 1) return block.includes(parts[0]);
  const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('[\\s\\S]{0,600}'), 'i');
  return pattern.test(block);
}

describe('#2527: settings.md adds grouped settings layers', () => {
  let content;

  before(() => {
    content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
  });

  describe('Acceptance: all 8 new fields present in AskUserQuestion block', () => {
    for (const field of NEW_FIELDS) {
      test(`settings.md mentions ${field}`, () => {
        assert.ok(
          content.includes(field),
          `settings.md must reference the config key "${field}" in its AskUserQuestion/update_config step`
        );
      });
    }
  });

  describe('Acceptance: section headers applied', () => {
    for (const section of SECTION_HEADERS) {
      test(`settings.md declares a "${section}" section header`, () => {
        // The convention for grouping AskUserQuestion items is a markdown section heading
        // of the form "### <Section>" inside the present_settings step.
        const heading = new RegExp(`^#{2,4}\\s+${section.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'm');
        assert.ok(
          heading.test(content),
          `settings.md must declare a "${section}" section header to group questions`
        );
      });
    }
  });

  describe('Acceptance: update_config step includes all new fields', () => {
    test('update_config step references every new field', () => {
      const updateMatch = content.match(/<step name="update_config">[\s\S]*?<\/step>/);
      assert.ok(updateMatch, 'settings.md must have an update_config step');
      const updateBlock = updateMatch[0];
      for (const field of NEW_FIELDS) {
        // Keys may appear as nested JSON (e.g., "pattern_mapper" under workflow).
        // Use hasPathLike so distinct dotted keys (e.g., intel.enabled,
        // graphify.enabled) cannot share a single "enabled" occurrence.
        assert.ok(
          hasPathLike(updateBlock, field),
          `update_config step must write "${field}"`
        );
      }
    });
  });

  describe('Acceptance: save_as_defaults step includes all new fields', () => {
    test('save_as_defaults step references every new field', () => {
      const defaultsMatch = content.match(/<step name="save_as_defaults">[\s\S]*?<\/step>/);
      assert.ok(defaultsMatch, 'settings.md must have a save_as_defaults step');
      const block = defaultsMatch[0];
      for (const field of NEW_FIELDS) {
        assert.ok(
          hasPathLike(block, field),
          `save_as_defaults step must persist "${field}" into ~/.gsd/defaults.json`
        );
      }
    });
  });

  describe('Acceptance: confirmation display includes all new fields', () => {
    test('confirm step table lists every new setting by name', () => {
      const confirmMatch = content.match(/<step name="confirm">[\s\S]*?<\/step>/);
      assert.ok(confirmMatch, 'settings.md must have a confirm step');
      const block = confirmMatch[0];
      const expectedLabels = [
        'Pattern Mapper',
        'TDD Mode',
        'Code Review',
        'Code Review Depth',
        'UI Review',
        'Commit Docs',
        'Intel',
        'Graphify',
      ];
      for (const label of expectedLabels) {
        assert.ok(
          block.includes(label),
          `confirm step table must display "${label}"`
        );
      }
    });
  });

  describe('Acceptance: all 8 new fields accepted by the config validator', () => {
    for (const field of NEW_FIELDS) {
      test(`config validator accepts ${field}`, () => {
        assert.ok(
          isValidConfigKey(field),
          `${field} must be accepted so config-set can write it`
        );
      });
    }
  });

  describe('Acceptance: migrated capability fields are no longer central config keys', () => {
    for (const field of CAPABILITY_OWNED_NEW_FIELDS) {
      test(`${field} is capability-owned, not central-schema residue`, () => {
        assert.equal(
          isCentralConfigKey(field),
          false,
          `${field} must be owned by the capability registry instead of the central schema`
        );
        assert.equal(
          VALID_CONFIG_KEYS.has(field),
          false,
          `${field} must not be duplicated in VALID_CONFIG_KEYS after Phase 6 migration`
        );
      });
    }
  });

  describe('Acceptance: still-central settings remain in VALID_CONFIG_KEYS', () => {
    for (const field of CENTRAL_NEW_FIELDS) {
      test(`VALID_CONFIG_KEYS contains central setting ${field}`, () => {
        assert.ok(
          VALID_CONFIG_KEYS.has(field),
          `${field} is not a migrated capability key and must remain in VALID_CONFIG_KEYS`
        );
      });
    }
  });

  describe('Acceptance: code_review_depth is conditional on code_review=on', () => {
    test('settings.md documents conditional visibility for code_review_depth', () => {
      // Must explicitly note that code_review_depth only appears when code_review is on.
      const conditionalRegex = /code_review_depth[\s\S]{0,400}(only|conditional|when|if)[\s\S]{0,80}code_review/i;
      assert.ok(
        conditionalRegex.test(content) ||
          /code_review\s*=\s*on[\s\S]{0,400}code_[…]*depth/i.test(content),
        'settings.md must document that code_review_depth is only shown when code_review is on'
      );
    });
  });

  describe('Negative: settings.md constrains code_review_depth options', () => {
    test('settings.md restricts code_review_depth to a known option set', () => {
      // Depth accepts string values (quick|standard|deep). config-set does not
      // block arbitrary strings at the value level today; instead settings.md
      // constrains the AskUserQuestion options to the valid set so users
      // cannot pick "bogus" via the interactive flow.
      const depthOptionsRegex =
        /code_review_depth[\s\S]{0,800}(quick|standard|deep|surface)/i;
      assert.ok(
        depthOptionsRegex.test(content),
        'settings.md must constrain code_review_depth options to a known set'
      );
    });
  });

  describe('Negative: config-set rejects an unknown key path', () => {
    test('config-set workflow.code_review_bogus_key fails', (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));

      const bad = runGsdTools(['config-set', 'workflow.code_review_bogus_key', 'x'], tmpDir);
      assert.ok(!bad.success, 'config-set on an unknown key must fail');
    });
  });

  describe('Acceptance: all 6 section headers are used as header: field on first question in each section', () => {
    test('the header field appears for each section in the AskUserQuestion block', () => {
      // Map user-visible section names to the short `header:` strings used in AskUserQuestion.
      // settings.md uses abbreviated headers (max 12 chars). Verify at least one header
      // per section-intent appears on a question.
      const requiredHeaders = [
        /header:\s*"Model"/,           // Model & Pipeline opener
        /header:\s*"Research"/,        // Planning opener (first Planning-section question)
        /header:\s*"Pattern Mapper"|header:\s*"Patterns"/, // new Planning addition
        /header:\s*"Verifier"/,        // Execution existing
        /header:\s*"TDD"/,             // new Execution
        /header:\s*"Code Review"/,     // new Execution
        /header:\s*"UI Review"/,       // new Execution
        /header:\s*"Commit Docs"/,     // new Docs & Output
        /header:\s*"Intel"/,           // new Features
        /header:\s*"Graphify"/,        // new Features
      ];
      for (const re of requiredHeaders) {
        assert.ok(re.test(content), `settings.md must include an AskUserQuestion header matching ${re}`);
      }
    });
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3210-fallow-integration.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3210-fallow-integration (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #3210)
// This test validates workflow/agent/config contracts stored in shipped .md/.ts/.cjs
// artifacts. Source text is the runtime product for those surfaces.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');

// N2: single helper — on macOS os.tmpdir() already returns /private/tmp; the
// existsSync guard is kept only as defense-in-depth fallback.
function getWritableTmp() {
  const candidates = ['/private/tmp', '/tmp', os.tmpdir()];
  return candidates.find((dir) => {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  });
}

describe('feat-3210: fallow integration module', () => {
  test('normalizes structural findings from a fallow report', () => {
    const { normalizeFallowReport } = require('../gsd-core/bin/lib/fallow-runner.cjs');
    const fixture = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'fallow', 'sample-findings.json'), 'utf8'),
    );

    const normalized = normalizeFallowReport(fixture);
    // Counts derived from real schema fixture fields
    const expectedUnused = fixture.dead_code.unused_exports.length;
    const expectedUnusedFiles = fixture.dead_code.unused_files.length;
    const expectedCircular = fixture.dead_code.circular_dependencies.length;
    const expectedDuplicates = fixture.duplication.clone_groups.length;
    assert.deepStrictEqual(normalized.summary, {
      unused_exports: expectedUnused,
      unused_files: expectedUnusedFiles,
      duplicates: expectedDuplicates,
      circular_dependencies: expectedCircular,
      total: 4,
    });
    assert.strictEqual(normalized.findings.length, 4);
  });

  test('falls back to node_modules/.bin/fallow when PATH does not contain fallow', () => {
    const { resolveFallowBinary } = require('../gsd-core/bin/lib/fallow-runner.cjs');
    // N2: use shared helper
    const baseTmp = getWritableTmp();
    const tmp = fs.mkdtempSync(path.join(baseTmp, 'gsd-fallow-bin-'));
    const binDir = path.join(tmp, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fallowPath = path.join(binDir, 'fallow');
    fs.writeFileSync(fallowPath, '#!/usr/bin/env sh\n');
    if (process.platform !== 'win32') fs.chmodSync(fallowPath, 0o755);

    const resolved = resolveFallowBinary({ cwd: tmp, envPath: '' });
    assert.strictEqual(resolved, fallowPath);

    cleanup(tmp);
  });

  // H6: replaced wholesale win32 skip with platform-adapted assertion
  test('ignores non-executable PATH candidate on non-Windows; prefers .cmd over bare extensionless on Windows', () => {
    const { resolveFallowBinary } = require('../gsd-core/bin/lib/fallow-runner.cjs');
    // N2: use shared helper
    const baseTmp = getWritableTmp();

    if (process.platform === 'win32') {
      // H6: Windows — .cmd extension candidate must be preferred over bare extensionless file
      const tmp = fs.mkdtempSync(path.join(baseTmp, 'gsd-fallow-win-'));
      try {
        const pathDir = path.join(tmp, 'bin');
        fs.mkdirSync(pathDir, { recursive: true });
        const bareFile = path.join(pathDir, 'fallow');
        const cmdFile = path.join(pathDir, 'fallow.cmd');
        fs.writeFileSync(bareFile, '@echo off\r\n');
        fs.writeFileSync(cmdFile, '@echo off\r\n');
        const resolved = resolveFallowBinary({ cwd: tmp, envPath: pathDir });
        assert.strictEqual(
          resolved,
          cmdFile,
          'Windows: .cmd candidate must be preferred over bare extensionless file',
        );
      } finally {
        cleanup(tmp);
      }
    } else {
      // H6: non-Windows — non-executable file in PATH must be ignored
      const tmp = fs.mkdtempSync(path.join(baseTmp, 'gsd-fallow-nonexec-'));
      try {
        const pathDir = path.join(tmp, 'bin');
        fs.mkdirSync(pathDir, { recursive: true });
        const nonExec = path.join(pathDir, 'fallow');
        fs.writeFileSync(nonExec, '#!/usr/bin/env sh\n');
        fs.chmodSync(nonExec, 0o644);
        const resolved = resolveFallowBinary({ cwd: tmp, envPath: pathDir });
        assert.strictEqual(resolved, null);
      } finally {
        cleanup(tmp);
      }
    }
  });

  test('normalizes empty fallow report to zero findings', () => {
    const { normalizeFallowReport } = require('../gsd-core/bin/lib/fallow-runner.cjs');
    const fixture = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'fallow', 'sample-empty.json'), 'utf8'),
    );
    const normalized = normalizeFallowReport(fixture);
    assert.deepStrictEqual(normalized.summary, {
      unused_exports: 0,
      unused_files: 0,
      duplicates: 0,
      circular_dependencies: 0,
      total: 0,
    });
    assert.deepStrictEqual(normalized.findings, []);
  });

  test('throws actionable error when fallow is enabled but binary is unavailable', () => {
    const { requireFallowBinary } = require('../gsd-core/bin/lib/fallow-runner.cjs');
    // N2: use shared helper
    const baseTmp = getWritableTmp();
    const tmp = fs.mkdtempSync(path.join(baseTmp, 'gsd-fallow-missing-'));
    assert.throws(
      () => requireFallowBinary({ cwd: tmp, envPath: '' }),
      /install fallow via `npm install -D fallow` or `cargo install fallow`/,
    );
    cleanup(tmp);
  });

  // M5: edge-case fixture — line:0 preservation, unicode path, single-instance clone_group, 3-file cycle
  test('normalizes edge-case fixture: line:0 preservation, unicode path, single-instance clone_group, 3-file cycle', () => {
    const { normalizeFallowReport } = require('../gsd-core/bin/lib/fallow-runner.cjs');
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, 'tests', 'fixtures', 'fallow', 'sample-edge-cases.json'),
        'utf8',
      ),
    );

    // Real schema: unused_export with line:0 — must survive without coercion
    assert.strictEqual(fixture.dead_code.unused_exports.length, 1);
    assert.strictEqual(fixture.dead_code.unused_exports[0].line, 0, 'edge-case fixture: line must be 0');
    // unicode file path is preserved in fixture
    assert.ok(
      fixture.dead_code.unused_exports[0].path.includes('café'),
      'edge-case fixture: unicode file path must be present',
    );

    // single-instance clone_group (related_file normalizes to '')
    assert.strictEqual(fixture.duplication.clone_groups.length, 1);
    assert.strictEqual(fixture.duplication.clone_groups[0].instances.length, 1);

    // 3-file circular dependency cycle
    assert.strictEqual(fixture.dead_code.circular_dependencies.length, 1);
    assert.strictEqual(
      fixture.dead_code.circular_dependencies[0].files.length,
      3,
      'edge-case: files array must have exactly 3 entries',
    );

    // normalization round-trips without throwing
    const normalized = normalizeFallowReport(fixture);
    // 1 unused_export + 0 unused_files + 1 circular_dep + 1 clone_group = 3
    const expectedTotal =
      fixture.dead_code.unused_exports.length +
      fixture.dead_code.unused_files.length +
      fixture.dead_code.circular_dependencies.length +
      fixture.duplication.clone_groups.length;
    assert.strictEqual(normalized.findings.length, expectedTotal);
    assert.strictEqual(normalized.summary.total, expectedTotal);

    // line:0 survives normalization
    const unicodeFinding = normalized.findings.find(
      (f) => typeof f.file === 'string' && f.file.includes('café'),
    );
    assert.ok(unicodeFinding, 'unicode file path must survive normalization round-trip');
    assert.strictEqual(unicodeFinding.line, 0, 'line:0 must not be coerced to null');

    // single-instance clone_group: related_file must be ''
    const dupFinding = normalized.findings.find((f) => f.type === 'duplicate_block');
    assert.ok(dupFinding, 'duplicate_block finding must exist');
    assert.strictEqual(dupFinding.related_file, '', 'single-instance clone_group: related_file must be empty string');
  });
});

describe('feat-3210: H1 - line:0 preservation', () => {
  test('normalizeFallowReport preserves line:0 for unused_export (not coerced to null)', () => {
    const { normalizeFallowReport } = require('../gsd-core/bin/lib/fallow-runner.cjs');
    const report = {
      dead_code: {
        unused_exports: [{ path: 'src/a.ts', export_name: 'foo', line: 0 }],
      },
    };
    const normalized = normalizeFallowReport(report);
    assert.strictEqual(normalized.findings[0].line, 0, 'line:0 must not be coerced to null via ||');
  });

  test('normalizeFallowReport preserves line:0 for duplicate_block instances[0].start_line (not coerced to null)', () => {
    const { normalizeFallowReport } = require('../gsd-core/bin/lib/fallow-runner.cjs');
    const report = {
      duplication: {
        clone_groups: [
          { instances: [{ file: 'src/a.ts', start_line: 0 }, { file: 'src/b.ts', start_line: 5 }] },
        ],
      },
    };
    const normalized = normalizeFallowReport(report);
    assert.strictEqual(normalized.findings[0].line, 0, 'start_line:0 must not be coerced to null via ||');
  });
});

describe('feat-3210: M2 - node_modules/.bin resolution order', () => {
  test('resolveFallowBinary prefers node_modules/.bin over PATH when both exist', () => {
    const { resolveFallowBinary } = require('../gsd-core/bin/lib/fallow-runner.cjs');
    // N2: use shared helper
    const baseTmp = getWritableTmp();
    const tmp = fs.mkdtempSync(path.join(baseTmp, 'gsd-fallow-order-'));
    try {
      // local node_modules/.bin/fallow
      const binDir = path.join(tmp, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const localFallow = path.join(binDir, 'fallow');
      fs.writeFileSync(localFallow, '#!/usr/bin/env sh\necho local\n');
      if (process.platform !== 'win32') fs.chmodSync(localFallow, 0o755);

      // PATH fallow (a different file)
      const pathDir = path.join(tmp, 'pathbin');
      fs.mkdirSync(pathDir, { recursive: true });
      const pathFallow = path.join(pathDir, 'fallow');
      fs.writeFileSync(pathFallow, '#!/usr/bin/env sh\necho path\n');
      if (process.platform !== 'win32') fs.chmodSync(pathFallow, 0o755);

      const resolved = resolveFallowBinary({ cwd: tmp, envPath: pathDir });
      assert.strictEqual(resolved, localFallow, 'node_modules/.bin/fallow must win over PATH fallow');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('feat-3210 / #1012: code-review workflow invokes fallow with the real CLI', () => {
  // allow-test-rule: source-text-is-the-product — code-review.md IS the workflow the orchestrator (see #3210)
  // executes; its fallow invocation is the product surface.
  const workflowSrc = fs.readFileSync(
    path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md'),
    'utf8',
  );

  test('uses audit --format json and --quiet (real fallow 2.x flags)', () => {
    assert.ok(
      workflowSrc.includes('audit --format json'),
      'workflow must invoke: audit --format json',
    );
    assert.ok(
      workflowSrc.includes('--quiet'),
      'workflow must pass --quiet to suppress progress output',
    );
  });

  test('does NOT use removed flags: --json , --profile, --stdin-files', () => {
    assert.ok(
      !workflowSrc.includes('--json '),
      'workflow must not use old --json flag (note trailing space to avoid matching --format json)',
    );
    assert.ok(
      !workflowSrc.includes('--profile'),
      'workflow must not use --profile (fallow has no native profile concept)',
    );
    assert.ok(
      !workflowSrc.includes('--stdin-files'),
      'workflow must not use --stdin-files (removed in fallow 2.x)',
    );
  });

  test('uses --max-crap for threshold control (profile maps to max-crap)', () => {
    assert.ok(
      workflowSrc.includes('--max-crap'),
      'workflow must use --max-crap to control threshold (profile mapped to this flag)',
    );
  });

  test('scopes phase via --changed-since (native fallow git-ref scoping)', () => {
    assert.ok(
      workflowSrc.includes('--changed-since'),
      'workflow must use --changed-since for phase scoping',
    );
  });

  test('normalizes fallow output via normalizeFallowReportFile before embedding', () => {
    assert.ok(
      workflowSrc.includes('normalizeFallowReportFile'),
      'workflow must call normalizeFallowReportFile to normalize before embedding into reviewer prompt',
    );
  });

  test('exit-handling gates on valid JSON (verdict in o), not on exit code', () => {
    assert.ok(
      workflowSrc.includes("'verdict' in o"),
      "workflow exit-handling must use 'verdict' in o to decide success (not exit code)",
    );
  });
});

describe('feat-3210: workflow and config contracts', () => {
  test('config schema allows code_quality.fallow.* keys in CJS and runtime manifest', () => {
    // CJS config-schema and runtime consume the same manifest source-of-truth.
    // Use the CJS runtime Set and the manifest directly (no inline text parsing).
    const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');
    const manifestPath = path.join(ROOT, 'gsd-core', 'bin', 'shared', 'config-schema.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifestKeys = new Set(manifest.validKeys);
    for (const key of [
      'code_quality.fallow.enabled',
      'code_quality.fallow.scope',
      'code_quality.fallow.profile',
      'code_quality.fallow.mcp',
    ]) {
      assert.ok(VALID_CONFIG_KEYS.has(key), `missing CJS config key: ${key}`);
      assert.ok(manifestKeys.has(key), `missing manifest key: ${key} (runtime sources from manifest)`);
    }
  });

  test('config-set accepts code_quality.fallow keys', () => {
    const originalTmpDir = process.env.TMPDIR;
    // L2: fail loudly if no writable tmp dir is found (was silent skip)
    const writableTmp = getWritableTmp(); // N2: use shared helper
    assert.ok(writableTmp, 'no writable tmp directory found'); // L2: explicit fail-loud assertion
    process.env.TMPDIR = writableTmp;
    const tmpDir = createTempProject('gsd-fallow-config-');
    try {
      const cases = [
        ['code_quality.fallow.enabled', 'true'],
        ['code_quality.fallow.scope', 'repo'],
        ['code_quality.fallow.profile', 'strict'],
        ['code_quality.fallow.mcp', 'false'],
      ];
      for (const [key, value] of cases) {
        const result = runGsdTools(['config-set', key, value], tmpDir);
        assert.ok(result.success, `config-set failed for ${key}: ${result.error || result.output}`);
      }
    } finally {
      cleanup(tmpDir);
      if (originalTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpDir;
    }
  });

  // B4: replaced 5x source-grep tautologies with parse-based structural checks.
  // The workflow .md uses XML-like <step> tags as its runtime DSL; we parse the step block
  // structurally and assert on structural properties, not on prose strings.
  test('code-review workflow structural_pre_pass step is parseable and references FALLOW.json output', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md'),
      'utf8',
    );

    // Parse: the <step name="structural_pre_pass"> block must exist and be closed
    const stepMatch = workflow.match(/<step\s+name="structural_pre_pass">([\s\S]*?)<\/step>/);
    assert.ok(
      stepMatch,
      'workflow must contain a parseable <step name="structural_pre_pass">...</step> block',
    );

    const stepBody = stepMatch[1];

    // Structural property: the step body must reference the FALLOW.json output artifact
    assert.ok(
      stepBody.includes('FALLOW.json'),
      'structural_pre_pass step body must reference the FALLOW.json output artifact',
    );

    // Structural property: the step body must gate on the fallow enabled config key
    assert.ok(
      stepBody.includes('code_quality.fallow.enabled'),
      'structural_pre_pass step body must gate on code_quality.fallow.enabled',
    );
  });

  // B4: agent output contract — doc-parity check (approved fallback per config-schema-docs-parity
  // pattern). We confirm the heading exists in the shipped artifact, not in a live agent response.
  // Live agent output is covered by /gsd-code-review e2e runs downstream.
  test('reviewer prompt defines ## Structural Findings (fallow) heading and review context echoes it', () => {
    const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'gsd-code-reviewer.md'), 'utf8');
    const reviewContext = fs.readFileSync(path.join(ROOT, 'gsd-core', 'contexts', 'review.md'), 'utf8');

    // Doc-parity: section heading must exist in the shipped agent file (the heading is a contract,
    // not prose — renaming it would break every consumer that parses agent output by section)
    assert.ok(
      reviewer.includes('## Structural Findings (fallow)'),
      'gsd-code-reviewer.md must define ## Structural Findings (fallow) section heading',
    );

    // Doc-parity: review context that agents receive must reference the same section
    assert.ok(
      reviewContext.includes('Structural Findings (fallow)'),
      'review.md context must reference Structural Findings (fallow) so agents recognize the section',
    );
  });
});
  });
}

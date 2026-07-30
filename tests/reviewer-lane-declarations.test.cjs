'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * reviewer-lane-declarations.test.cjs — behavioral tests for ADR-2782 Phase 5a
 * (chore #2798): declaring the eleven existing reviewer lanes as capability-
 * manifest data.
 *
 * Implements every row carrying a Test name in
 * `.gsd/phase/chore-2798-declare-reviewer-lanes/50-test-matrix.md` (sections
 * A-E). See that phase's `40-design.md` for the behavior table the matrix
 * derives from. Test names are copied verbatim from the matrix.
 *
 * THE SINGLE MOST IMPORTANT PROPERTY (matrix "Red-before-green"): the roster is
 * eleven slugs before this phase and eleven after, with IDENTICAL membership —
 * C1 is the keystone, asserted against a LITERAL list, never against a value
 * computed by the same machinery under test. E1 is the highest-value row: it
 * asserts the manifest and `src/review-lane-descriptor.cts`'s `REVIEWER_LANES`
 * describe the same eleven lanes field-for-field — the whole premise of
 * ADR-2782 is that there is no translation layer between the two surfaces.
 *
 * Level choice, per the matrix's own "Units" note: the eleven
 * `capabilities/*\/capability.json` files are validated through the existing
 * registry generator (`loadAndValidate` / `validateCrossCapability` / the
 * generated `capability-registry.cjs`), never by reading JSON text — a
 * source-grep assertion would be rejected by `local/no-source-grep` and would
 * prove nothing about validity. `src/review-reviewer-selection.cts`'s roster
 * derivation (`deriveReviewerSlugs`) is exercised directly against synthetic
 * registries for the C-section rows that need to isolate one input class at a
 * time (Independence: each test builds its own fixture; no shared mutable
 * state).
 *
 * `SHIPPED` below is the one deliberate exception to "each test builds its own
 * fixture": it is the REAL, already-validated capability set (computed once,
 * read-only — no test mutates `SHIPPED.capMap` or any capability object
 * inside it), reused across the A/B/D/E rows that assert against the actual
 * shipped repo rather than a synthetic input class. Recomputing it per test
 * would re-scan and re-validate all of `capabilities/*` on every one of those
 * rows for no behavioral benefit.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadAndValidate,
  validateCapability,
  validateCrossCapability,
  deriveProfileMembership,
  deriveCapabilityClusters,
} = require('../scripts/gen-capability-registry.cjs');

const {
  KEBAB_RE,
  KNOWN_REVIEWER_FIELDS,
} = require('../gsd-core/bin/lib/capability-validator.cjs');

const {
  REVIEWER_LANES,
  checkReviewerLaneParity,
} = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');

// Kept as a whole-module reference (rather than only destructuring) so C5 can
// assert on the module's OWN export surface, not just the names we happen to use.
const reviewerSelectionModule = require('../gsd-core/bin/lib/review-reviewer-selection.cjs');
const {
  KNOWN_REVIEWER_SLUGS,
  deriveReviewerSlugs,
  resolveReviewerSelection,
} = reviewerSelectionModule;

// Generated registry (ADR-894) — `.capabilities` is keyed by capability id;
// each value is the whole manifest object, exactly as loaded from disk.
const capabilityRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

const ROOT = path.join(__dirname, '..');

/** The five net-new lane-only `role:"reviewer"` capabilities (ADR-2782 D3). */
const NEW_LANE_ONLY_IDS = ['gemini', 'coderabbit', 'ollama', 'lm-studio', 'llama-cpp'];

/** The six pre-existing dual-purpose `role:"runtime"` capabilities. */
const RUNTIME_REVIEWER_IDS = ['antigravity', 'claude', 'codex', 'cursor', 'opencode', 'qwen'];

/**
 * The shipped roster BEFORE this phase, as a literal (not computed) sorted
 * list. C1 compares `KNOWN_REVIEWER_SLUGS` against THIS, never against a
 * value produced by `deriveReviewerSlugs` itself — a self-consistent-but-wrong
 * refactor would otherwise sail through.
 */
const LITERAL_ROSTER = [
  'antigravity', 'claude', 'coderabbit', 'codex', 'cursor', 'gemini',
  'llama_cpp', 'lm_studio', 'ollama', 'opencode', 'qwen',
];

/**
 * The real, already-validated capability set. Read-only; see the file header
 * for why this is shared instead of rebuilt per test. `new Set()` for central
 * keys skips config-schema collision detection — irrelevant to this phase's
 * rows and not part of what any of them assert (same choice the existing
 * `shippedRegistryOutputIsUnchangedByHarvestWidening` test makes).
 */
const SHIPPED = loadAndValidate(new Set());

// ─── A. The five new lane-only capabilities ─────────────────────────────────

describe('A. The five new lane-only capabilities', () => {
  test('newLaneOnlyCapabilitiesValidate', () => {
    assert.deepEqual(
      SHIPPED.errors, [],
      `expected the shipped capability set to validate cleanly, got: ${JSON.stringify(SHIPPED.errors)}`,
    );
    for (const id of NEW_LANE_ONLY_IDS) {
      assert.ok(SHIPPED.capMap.has(id), `expected capability "${id}" to be loaded from capabilities/${id}/`);
    }
  });

  test('newLaneCapabilitiesUseTheReviewerRole', () => {
    for (const id of NEW_LANE_ONLY_IDS) {
      const cap = SHIPPED.capMap.get(id);
      assert.equal(cap.role, 'reviewer', `capability "${id}" must declare role:"reviewer"`);
    }
  });

  test('newLaneCapabilitiesDeclareAReviewerBody', () => {
    for (const id of NEW_LANE_ONLY_IDS) {
      const cap = SHIPPED.capMap.get(id);
      assert.ok(
        cap.reviewer && typeof cap.reviewer === 'object' && !Array.isArray(cap.reviewer),
        `capability "${id}" must carry a "reviewer" body`,
      );
      assert.ok(
        typeof cap.reviewer.slug === 'string' && cap.reviewer.slug.length > 0,
        `capability "${id}" reviewer body must declare a non-empty slug`,
      );
    }
  });

  test('laneOnlyCapabilitiesHaveNoRuntimeBody', () => {
    // A runtime body would be a validation ERROR for role:"reviewer" — these
    // are not install targets (design 40-design.md "A3").
    for (const id of NEW_LANE_ONLY_IDS) {
      const cap = SHIPPED.capMap.get(id);
      assert.equal('runtime' in cap, false, `lane-only capability "${id}" must not carry a "runtime" body`);
    }
  });

  test('laneOnlyCapabilitiesNeedNoRuntimeCompat', () => {
    for (const id of NEW_LANE_ONLY_IDS) {
      const cap = SHIPPED.capMap.get(id);
      assert.equal('runtimeCompat' in cap, false, `lane-only capability "${id}" must not declare runtimeCompat`);
      // The absence must not cost it validity (D3: not required for role:"reviewer").
      const errs = validateCapability(cap, id);
      assert.deepEqual(
        errs, [],
        `capability "${id}" without runtimeCompat must still validate cleanly, got: ${JSON.stringify(errs)}`,
      );
    }
  });

  test('laneOnlyCapabilitiesContributeNoArtifacts', () => {
    // No install surface, nothing to install: none of the fields buildRegistry
    // harvests for a feature capability's install/loop-point surface.
    for (const id of NEW_LANE_ONLY_IDS) {
      const cap = SHIPPED.capMap.get(id);
      for (const field of ['skills', 'agents', 'steps', 'gates', 'contributions']) {
        const value = cap[field];
        assert.ok(
          value === undefined || (Array.isArray(value) && value.length === 0),
          `lane-only capability "${id}" must contribute no ${field}, got: ${JSON.stringify(value)}`,
        );
      }
    }
    // Nothing routes through them at the registry level either.
    const bySkillOwners = new Set(Object.values(capabilityRegistry.bySkill));
    const byAgentOwners = new Set(Object.values(capabilityRegistry.byAgent));
    for (const id of NEW_LANE_ONLY_IDS) {
      assert.equal(bySkillOwners.has(id), false, `"${id}" must own no skill in the generated registry`);
      assert.equal(byAgentOwners.has(id), false, `"${id}" must own no agent in the generated registry`);
    }
  });

  test('laneCapabilityIdsAreKebabWhileSlugsMaySnake', () => {
    // The build-breaking trap (ADR-2782's three-namespace trap): the epic body
    // and #2798 both literally specified `capabilities/lm_studio/` and
    // `capabilities/llama_cpp/`, which fail KEBAB_RE outright — the folder/id
    // MUST be kebab while `reviewer.slug` keeps the shipped roster's snake form.
    const kebabIdToSnakeSlug = { 'lm-studio': 'lm_studio', 'llama-cpp': 'llama_cpp' };
    for (const [id, expectedSlug] of Object.entries(kebabIdToSnakeSlug)) {
      const cap = SHIPPED.capMap.get(id);
      assert.ok(KEBAB_RE.test(id), `capability id "${id}" must satisfy KEBAB_RE (the folder-name grammar)`);
      assert.equal(cap.reviewer.slug, expectedSlug, `capability "${id}" reviewer.slug must be "${expectedSlug}"`);
      assert.equal(
        KEBAB_RE.test(cap.reviewer.slug), false,
        `reviewer.slug "${cap.reviewer.slug}" must NOT satisfy KEBAB_RE — it deliberately differs from the kebab id`,
      );
      // The rejected alternative the epic literally specified as a folder name.
      assert.equal(
        KEBAB_RE.test(expectedSlug), false,
        `"${expectedSlug}" would fail KEBAB_RE as a folder/id — that is exactly the trap this row guards`,
      );
    }
    // The other three new capabilities are single-word and unaffected: id === slug.
    for (const id of ['gemini', 'coderabbit', 'ollama']) {
      const cap = SHIPPED.capMap.get(id);
      assert.ok(KEBAB_RE.test(id), `capability id "${id}" must satisfy KEBAB_RE`);
      assert.equal(cap.reviewer.slug, id, `single-word capability "${id}" must have a matching slug`);
    }
  });

  test('laneOnlyCapabilitiesReceiveNoProfileMembership', () => {
    // tier is required (source of truth for the requires-closure), but with no
    // skills, deriveProfileMembership/deriveCapabilityClusters skip them —
    // membership is computed and inert, not simply "not applicable".
    const profileMembership = deriveProfileMembership(SHIPPED.capMap);
    const capabilityClusters = deriveCapabilityClusters(SHIPPED.capMap);
    for (const id of NEW_LANE_ONLY_IDS) {
      const cap = SHIPPED.capMap.get(id);
      assert.ok(typeof cap.tier === 'string' && cap.tier.length > 0, `lane-only capability "${id}" must still declare a tier`);
      assert.equal(id in profileMembership, false, `lane-only capability "${id}" must receive no profile membership`);
      assert.equal(id in capabilityClusters, false, `lane-only capability "${id}" must own no cluster`);
    }
  });
});

// ─── B. The six existing runtime capabilities ───────────────────────────────

describe('B. The six existing runtime capabilities', () => {
  test('dualPurposeRuntimesCarryAReviewerBody', () => {
    for (const id of RUNTIME_REVIEWER_IDS) {
      const cap = SHIPPED.capMap.get(id);
      assert.equal(cap.role, 'runtime', `"${id}" must remain role:"runtime"`);
      assert.ok(cap.runtime && typeof cap.runtime === 'object', `"${id}" must retain its runtime body`);
      assert.ok(cap.reviewer && typeof cap.reviewer === 'object', `"${id}" must gain a reviewer body alongside it (D1)`);
      const errs = validateCapability(cap, id);
      assert.deepEqual(errs, [], `"${id}" carrying both bodies must validate cleanly, got: ${JSON.stringify(errs)}`);
    }
  });

  /**
   * Real per-capability snapshots of `cap.runtime`'s own KEY SET, captured at
   * this phase's boundary (`git status` confirms these six files' only
   * uncommitted change is the added `reviewer` key). Adding that sibling key
   * must not add, remove, or rename anything inside `runtime` — a top-level
   * key drift here means the edit that added `reviewer` also touched
   * `runtime`, by accident or by a future careless merge of the two bodies.
   *
   * Deliberately a KEY-SET snapshot, not a full-content one: embedding all six
   * ~15-70-field runtime bodies verbatim would duplicate six actively-edited
   * install descriptors into the test as a second source of truth that drifts
   * on every legitimate future runtime change (these are the most frequently
   * touched capabilities in the repo). Value-level integrity is covered by
   * `validateCapability` (schema-complete) below and by the no-cross-
   * contamination check (no reviewer-only field name inside `runtime`, and
   * vice versa) — together these catch "the sibling edit corrupted this
   * body" without requiring line-for-line duplication.
   */
  const EXPECTED_RUNTIME_KEYS = {
    antigravity: ['artifactLayout', 'commandStyle', 'configFormat', 'configHome', 'extendedHookEvents', 'hookEvents', 'hooksSurface', 'hostBehaviors', 'hostIntegration', 'installSurface', 'localConfigDir', 'permissionWriter', 'sandboxTier', 'supportTier', 'writesSharedSettings'],
    claude: ['artifactLayout', 'commandStyle', 'configFormat', 'configHome', 'extendedHookEvents', 'harnessIsolationFlag', 'hookEvents', 'hooksSurface', 'hostBehaviors', 'hostIntegration', 'installSurface', 'localConfigDir', 'permissionWriter', 'sandboxTier', 'supportTier', 'writesSharedSettings'],
    codex: ['artifactLayout', 'commandStyle', 'configFormat', 'configHome', 'extendedHookEvents', 'hookEvents', 'hooksSurface', 'hostBehaviors', 'hostIntegration', 'installSurface', 'localConfigDir', 'orchestratorExec', 'permissionWriter', 'sandboxTier', 'supportTier', 'writesSharedSettings'],
    cursor: ['artifactLayout', 'commandStyle', 'configFormat', 'configHome', 'extendedHookEvents', 'harnessIsolationFlag', 'hookEvents', 'hooksSurface', 'hostBehaviors', 'hostIntegration', 'installSurface', 'localConfigDir', 'permissionWriter', 'sandboxTier', 'supportTier', 'writesSharedSettings'],
    opencode: ['artifactLayout', 'commandStyle', 'configFormat', 'configHome', 'extendedHookEvents', 'extensionEvents', 'hooksSurface', 'hostBehaviors', 'hostIntegration', 'installSurface', 'localConfigDir', 'orchestratorExec', 'permissionWriter', 'sandboxTier', 'supportTier', 'writesSharedSettings'],
    qwen: ['artifactLayout', 'commandStyle', 'configFormat', 'configHome', 'extendedHookEvents', 'hookEvents', 'hooksSurface', 'hostBehaviors', 'hostIntegration', 'installSurface', 'localConfigDir', 'permissionWriter', 'sandboxTier', 'supportTier', 'writesSharedSettings'],
  };

  test('runtimeBodiesAreUnchangedByLaneDeclaration', () => {
    for (const id of RUNTIME_REVIEWER_IDS) {
      const cap = SHIPPED.capMap.get(id);

      assert.deepEqual(
        Object.keys(cap.runtime).sort(), EXPECTED_RUNTIME_KEYS[id],
        `"${id}" runtime body's key set must be unperturbed by adding the sibling reviewer body`,
      );

      // No cross-contamination in either direction — a field from one body
      // leaking into the other would be an install-behavior-changing defect
      // that schema validation alone (which tolerates unknown fields via a
      // warning, not an error) would not catch.
      const runtimeKeys = new Set(Object.keys(cap.runtime));
      for (const reviewerField of KNOWN_REVIEWER_FIELDS) {
        assert.equal(
          runtimeKeys.has(reviewerField), false,
          `"${id}" runtime body must not contain reviewer-only field "${reviewerField}"`,
        );
      }
      const reviewerKeys = Object.keys(cap.reviewer);
      assert.ok(
        reviewerKeys.every((k) => KNOWN_REVIEWER_FIELDS.has(k)),
        `"${id}" reviewer body must contain only known reviewer fields, got: ${JSON.stringify(reviewerKeys)}`,
      );
    }
  });

  test('reviewerCliAliasIsRetainedForTheDeprecationWindow', () => {
    for (const id of RUNTIME_REVIEWER_IDS) {
      const cap = SHIPPED.capMap.get(id);
      assert.equal(
        cap.runtime.hostBehaviors && cap.runtime.hostBehaviors.reviewerCli, true,
        `"${id}" must retain hostBehaviors.reviewerCli:true for the deprecation window (removal is Phase 7 / #2801)`,
      );
    }
  });

  test('bodyAndAliasContributeOneSlugNotTwo', () => {
    // Isolated synthetic fixture: one capability carrying BOTH a declared
    // reviewer.slug AND the legacy alias, with slug !== capId, so a double
    // contribution would be observable as two distinct roster entries rather
    // than being hidden by an accidental string match.
    const registry = {
      capabilities: {
        'dual-purpose-cap': {
          role: 'runtime',
          runtime: { hostBehaviors: { reviewerCli: true } },
          reviewer: { slug: 'dual-slug' },
        },
      },
    };
    const roster = deriveReviewerSlugs(registry);
    assert.equal(roster.length, 1, `expected exactly one contribution, not two, got: ${JSON.stringify(roster)}`);
    assert.deepEqual(roster, ['dual-slug']);
    assert.equal(roster.includes('dual-purpose-cap'), false, 'the legacy alias must not ALSO contribute the capability id');
  });
});

// ─── C. Roster derivation — src/review-reviewer-selection.cts ─────────────

describe('C. Roster derivation — src/review-reviewer-selection.cts', () => {
  test('rosterMembershipIsUnchangedByDerivationRefactor', () => {
    assert.equal(KNOWN_REVIEWER_SLUGS.length, 11, 'roster must be exactly 11 — not 10, not 12');
    assert.deepEqual(
      [...KNOWN_REVIEWER_SLUGS].sort(), LITERAL_ROSTER,
      `roster must be exactly the same 11 slugs as before this phase, got: ${JSON.stringify(KNOWN_REVIEWER_SLUGS)}`,
    );
  });

  test('declaredReviewerBodyContributesItsSlug', () => {
    const registry = { capabilities: { 'my-cap': { role: 'reviewer', reviewer: { slug: 'my-lane' } } } };
    assert.deepEqual(deriveReviewerSlugs(registry), ['my-lane']);
  });

  test('aliasOnlyCapabilityStillContributesItsSlug', () => {
    // No reviewer body yet — only the legacy hostBehaviors flag (B2's shape).
    const registry = {
      capabilities: {
        'legacy-cli': { role: 'runtime', runtime: { hostBehaviors: { reviewerCli: true } } },
      },
    };
    assert.deepEqual(deriveReviewerSlugs(registry), ['legacy-cli']);
  });

  test('nonReviewerCapabilityContributesNoSlug', () => {
    const registry = { capabilities: { 'plain-feature': { role: 'feature' } } };
    assert.deepEqual(deriveReviewerSlugs(registry), []);
  });

  test('hardcodedNonRuntimeTailIsDeleted', () => {
    assert.equal(
      'NON_RUNTIME_REVIEWER_SLUGS' in reviewerSelectionModule, false,
      'NON_RUNTIME_REVIEWER_SLUGS must no longer be exported from review-reviewer-selection',
    );
    assert.equal(reviewerSelectionModule.NON_RUNTIME_REVIEWER_SLUGS, undefined);
  });

  test('reviewerBodyWinsOverTheLegacyAlias', () => {
    // Body and alias disagree on membership: capId (what the alias would
    // contribute) differs from reviewer.slug (what the body contributes), so
    // the winner is unambiguous from the result alone.
    const registry = {
      capabilities: {
        'conflicting-cap-id': {
          role: 'runtime',
          runtime: { hostBehaviors: { reviewerCli: true } },
          reviewer: { slug: 'the-declared-slug' },
        },
      },
    };
    const roster = deriveReviewerSlugs(registry);
    assert.deepEqual(
      roster, ['the-declared-slug'],
      `expected only the declared body's slug to win over the alias, got: ${JSON.stringify(roster)}`,
    );
  });

  test('emptyRegistryYieldsEmptyRoster', () => {
    assert.deepEqual(deriveReviewerSlugs({ capabilities: {} }), []);
    assert.deepEqual(deriveReviewerSlugs({}), [], 'a registry object with no capabilities key at all must not throw');
  });

  test('rosterIsStableRegardlessOfRegistryOrder', () => {
    const capsForward = {
      alpha: { role: 'reviewer', reviewer: { slug: 'zzz-lane' } },
      beta: { role: 'reviewer', reviewer: { slug: 'aaa-lane' } },
      gamma: { role: 'runtime', runtime: { hostBehaviors: { reviewerCli: true } } },
    };
    const reversedCaps = {};
    for (const key of Object.keys(capsForward).reverse()) reversedCaps[key] = capsForward[key];

    const forwardRoster = deriveReviewerSlugs({ capabilities: capsForward });
    const reversedRoster = deriveReviewerSlugs({ capabilities: reversedCaps });
    assert.deepEqual(forwardRoster, reversedRoster, 'roster must not depend on registry key insertion order');
    assert.deepEqual(
      forwardRoster, ['aaa-lane', 'gamma', 'zzz-lane'],
      'roster must be sorted, independent of declaration order',
    );
  });
});

// ─── D. Cross-phase invariants that must not regress ────────────────────────

describe('D. Cross-phase invariants that must not regress', () => {
  test('phase1ParityAssertionStillHolds', () => {
    const workflowText = fs
      .readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'review.md'), 'utf-8')
      .replace(/\r\n/g, '\n');
    const result = checkReviewerLaneParity({
      descriptor: REVIEWER_LANES,
      roster: KNOWN_REVIEWER_SLUGS,
      workflowText,
    });
    assert.deepEqual(
      result.violations, [],
      `Phase 1's descriptor <-> roster <-> legs <-> sections parity must stay green across this migration, got: ${JSON.stringify(result.violations)}`,
    );
    assert.equal(result.ok, true);
  });

  test('kimiCodeIsDeliberatelyNotDeclaredYet', () => {
    assert.equal(KNOWN_REVIEWER_SLUGS.includes('kimi-code'), false, '"kimi-code" must not be in the roster yet — it has no invoke_reviewers leg until 5b');
    assert.equal(KNOWN_REVIEWER_SLUGS.includes('kimi_code'), false);
    const cap = SHIPPED.capMap.get('kimi-code');
    assert.ok(cap, 'expected the kimi-code capability to exist (it is net-new for an unrelated, EoS reason)');
    assert.equal('reviewer' in cap, false, 'kimi-code must not declare a reviewer body in this phase');
    assert.equal(
      Boolean(cap.runtime && cap.runtime.hostBehaviors && cap.runtime.hostBehaviors.reviewerCli),
      false,
      'kimi-code must not carry the legacy reviewerCli alias either',
    );
  });

  test('legacyKimiCapabilityIsNotAReviewerLane', () => {
    assert.equal(KNOWN_REVIEWER_SLUGS.includes('kimi'), false, '"kimi" (the legacy Python CLI) must not be a reviewer lane');
    const cap = SHIPPED.capMap.get('kimi');
    assert.ok(cap, 'expected the kimi capability to exist');
    assert.equal('reviewer' in cap, false, 'kimi must not acquire a reviewer body by proximity to kimi-code');
    assert.equal(
      Boolean(cap.runtime && cap.runtime.hostBehaviors && cap.runtime.hostBehaviors.reviewerCli),
      false,
      'kimi must not carry the legacy reviewerCli alias',
    );
  });

  test('allElevenDeclaredLanesSatisfyUniqueness', () => {
    const errs = validateCrossCapability(SHIPPED.capMap, new Set());
    const laneErrs = errs.filter((e) => e.startsWith('reviewer '));
    assert.deepEqual(
      laneErrs, [],
      `expected no reviewer-lane uniqueness violations (slug/flag/section) across the real eleven, got: ${JSON.stringify(laneErrs)}`,
    );
  });

  test('selectionPrecedenceIsUnchanged', () => {
    // ADR-0011: explicit flags > --all > review.default_reviewers > all
    // detected. Exercised with real roster members so a broken roster
    // derivation would also surface here — normalizeReviewerInstances /
    // resolveReviewerSelection gate config_default membership on
    // KNOWN_REVIEWER_SLUGS.includes(...).
    const detected = ['gemini', 'claude', 'qwen'];

    const explicit = resolveReviewerSelection({
      detected, explicitFlags: ['gemini'], allFlag: true, configuredDefaultReviewers: ['claude'],
    });
    assert.equal(explicit.source, 'explicit_flags');
    assert.deepEqual(explicit.selected, ['gemini']);

    const allFlagResult = resolveReviewerSelection({
      detected, explicitFlags: [], allFlag: true, configuredDefaultReviewers: ['claude'],
    });
    assert.equal(allFlagResult.source, 'all_flag');
    assert.deepEqual(allFlagResult.selected, [...detected].sort());

    const configDefault = resolveReviewerSelection({
      detected, explicitFlags: [], allFlag: false, configuredDefaultReviewers: ['claude', 'qwen'],
    });
    assert.equal(configDefault.source, 'config_default');
    assert.deepEqual(configDefault.selected, ['claude', 'qwen']);

    const noConfig = resolveReviewerSelection({ detected, explicitFlags: [], allFlag: false });
    assert.equal(noConfig.source, 'no_config_all_detected');
    assert.deepEqual(noConfig.selected, [...detected].sort());
  });
});

// ─── E. Lane fidelity — no translation layer ────────────────────────────────

describe('E. Lane fidelity — no translation layer', () => {
  test('declaredManifestLanesMatchThePhase1Descriptor', () => {
    // The epic's entire premise: the manifest and the core descriptor describe
    // the SAME lane with no translation layer. Phase 2's review already caught
    // one divergence (the slug grammar) invisible to every other test — assert
    // the WHOLE table, per field, so any future divergence names itself: the
    // lane AND the exact field (and, for nested fields, the sub-field) that
    // diverged.
    const bySlug = new Map();
    for (const [capId, cap] of Object.entries(capabilityRegistry.capabilities)) {
      if (cap && cap.reviewer && typeof cap.reviewer.slug === 'string') {
        bySlug.set(cap.reviewer.slug, { capId, reviewer: cap.reviewer });
      }
    }

    assert.equal(REVIEWER_LANES.length, 11, 'expected exactly 11 declared descriptor lanes');
    assert.equal(bySlug.size, 11, `expected exactly 11 capabilities declaring a reviewer body, got: ${bySlug.size}`);

    // Top-level scalar/array fields compared whole; the two fields that are
    // themselves nested objects (probe, invoke) are compared sub-field-by-
    // sub-field over the UNION of keys on both sides, so a field present on
    // only one side is caught exactly as loudly as one with a differing value.
    const TOP_FIELDS = [
      'flags', 'transport', 'probe', 'invoke', 'timeoutFloorMs', 'emptyOutput',
      'reviewsSection', 'evidenceClass', 'requiresBinaries', 'promptBudgetKey', 'handler',
    ];
    const NESTED_OBJECT_FIELDS = new Set(['probe', 'invoke']);

    for (const lane of REVIEWER_LANES) {
      const declared = bySlug.get(lane.slug);
      assert.ok(declared, `no capability declares a reviewer body for descriptor lane "${lane.slug}"`);
      const { capId, reviewer } = declared;

      for (const field of TOP_FIELDS) {
        if (NESTED_OBJECT_FIELDS.has(field)) {
          const laneSub = lane[field] || {};
          const manifestSub = reviewer[field] || {};
          const subKeys = new Set([...Object.keys(laneSub), ...Object.keys(manifestSub)]);
          for (const subKey of subKeys) {
            assert.deepEqual(
              manifestSub[subKey], laneSub[subKey],
              `lane "${lane.slug}" (capability "${capId}") field "${field}.${subKey}" diverges from Phase 1's descriptor: ` +
              `expected ${JSON.stringify(laneSub[subKey])}, got ${JSON.stringify(manifestSub[subKey])}`,
            );
          }
        } else {
          assert.deepEqual(
            reviewer[field], lane[field],
            `lane "${lane.slug}" (capability "${capId}") field "${field}" diverges from Phase 1's descriptor: ` +
            `expected ${JSON.stringify(lane[field])}, got ${JSON.stringify(reviewer[field])}`,
          );
        }
      }

      // Belt-and-suspenders whole-object comparison, in case a field exists on
      // one side under a name the named-field loop above did not enumerate.
      assert.deepEqual(
        reviewer, lane,
        `lane "${lane.slug}" (capability "${capId}") has a field-set divergence from Phase 1's descriptor`,
      );
    }

    // Reverse direction: every capability-declared reviewer body maps back to
    // a descriptor lane — no orphaned manifest lane the descriptor doesn't know.
    for (const [slug, { capId }] of bySlug) {
      assert.ok(
        REVIEWER_LANES.some((l) => l.slug === slug),
        `capability "${capId}" declares reviewer.slug "${slug}" with no matching Phase 1 descriptor lane`,
      );
    }
  });
});

// ─── F. Isolated-security-review regressions (#2798) ─────────────────────────
//
// Both rows come from an independent adversarial review that reproduced them by
// execution. Neither is reachable through the checked-in registry — it is
// generated, JSON-sourced and code-reviewed — but `deriveReviewerSlugs` is
// EXPORTED for reuse and carries no other validation, so it must not depend on
// its caller's hygiene.
describe('F. Isolated-security-review regressions', () => {
  test('whitespaceOnlySlugIsRejectedNotAdmittedToTheRoster', () => {
    for (const blank of ['   ', '\t', '\n', ' \t\n ']) {
      const roster = deriveReviewerSlugs({ capabilities: { x: { reviewer: { slug: blank } } } });
      assert.deepEqual(
        roster, [],
        `a whitespace-only slug can never match a real lane but would occupy a roster entry; got: ${JSON.stringify(roster)}`,
      );
    }
  });

  test('slugIsTrimmedRatherThanDropped', () => {
    // The fix must NOT discard a slug that merely carries incidental whitespace.
    assert.deepEqual(
      deriveReviewerSlugs({ capabilities: { x: { reviewer: { slug: '  gemini  ' } } } }),
      ['gemini'],
    );
  });

  test('theAliasStillAppliesWhenABodyDeclaresOnlyWhitespace', () => {
    // A body whose slug is blank is NOT a declaration, so the legacy alias must
    // still contribute — otherwise a malformed body would silently REMOVE a lane
    // that worked before, which is worse than the blank slug itself.
    const roster = deriveReviewerSlugs({
      capabilities: {
        claude: { reviewer: { slug: '   ' }, runtime: { hostBehaviors: { reviewerCli: true } } },
      },
    });
    assert.deepEqual(roster, ['claude'], 'a blank body must fall through to the alias, not drop the lane');
  });

  test('moduleLoadSurvivesAHostileRegistryShape', () => {
    // KNOWN_REVIEWER_SLUGS is computed at require() time, so an uncaught throw
    // there breaks import for EVERY consumer rather than degrading selection.
    // The module under test already imported successfully above; assert the
    // derived roster is a usable array rather than a partially-initialised value.
    assert.ok(Array.isArray([...KNOWN_REVIEWER_SLUGS]), 'roster must be iterable after module load');
    assert.equal(KNOWN_REVIEWER_SLUGS.length, 11, 'the real registry still yields the eleven lanes');
    // And the derivation itself is total over the shapes JSON can express.
    for (const hostile of [null, undefined, [], 0, 'x', { capabilities: null }, { capabilities: [] }]) {
      assert.doesNotThrow(
        () => deriveReviewerSlugs(hostile === undefined ? {} : (hostile || {})),
        `deriveReviewerSlugs must tolerate ${JSON.stringify(hostile)}`,
      );
    }
  });
});

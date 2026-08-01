'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * tests/registry-reviewer-parity.test.cjs — regression coverage for issue
 * #2904 ("reviewer" registry entry type).
 *
 * `scripts/registry-schema.cjs`'s reviewer vocabulary
 * (`REVIEWER_LANE_TRANSPORTS`, `REVIEWER_EVIDENCE_CLASSES`,
 * `REVIEWER_SLUG_RE`, `REVIEWER_FLAG_RE`) and
 * `gsd-core/bin/lib/capability-validator.cjs`'s runtime reviewer-lane
 * vocabulary (`VALID_LANE_TRANSPORTS`, `VALID_EVIDENCE_CLASSES`,
 * `LANE_SLUG_RE`, `LANE_FLAG_RE`) are two independent, hand-written mirrors
 * of the same underlying grammar — the registry is a third-party
 * DISCOVERABILITY catalog (documentation-scoped), the capability-validator
 * is the RUNTIME manifest validator that actually gates what a shipped
 * `capabilities/<id>/capability.json`'s `reviewer` body may declare. Nothing
 * imports one from the other (capability-validator.cjs's own header comment,
 * `gsd-core/bin/lib/capability-validator.cjs:798-810`, explains why: the
 * canonical descriptor `LANE_SLUG_RE` mirrors lives in
 * `src/review-lane-descriptor.cts`, which compiles to gitignored build
 * output that this committed plain `.cjs` cannot depend on before
 * `npm run build:lib` has ever run) — so the two vocabularies can silently
 * drift apart with no error to read: a registry entry that faithfully
 * mirrors a real shipped lane (e.g. `lm_studio`, `llama_cpp`, `4o-mini` —
 * all real slugs that a naive kebab-only grammar would reject) would look
 * "strict but simply wrong" if the registry's copy of the slug grammar ever
 * diverged from `LANE_SLUG_RE`.
 *
 * `capability-validator.cjs:807-810` states the byte-identical requirement
 * explicitly: "A LEADING DIGIT IS PERMITTED. ... Keep the two grammars
 * byte-identical." This file is that parity guard for the reviewer registry
 * entry type, sibling in structure/intent to
 * `tests/registry-axes-parity.test.cjs` (which pins `AXES`/`OPTIONAL_AXES`
 * against `HOST_INTEGRATION_AXES`).
 *
 * Row 75 additionally reads every real, shipped `capabilities/<id>/capability.json`
 * and asserts each one's `reviewer.slug` (where present) validates against
 * `REVIEWER_SLUG_RE` — a reality check that the registry grammar isn't just
 * parity-pinned against `capability-validator.cjs` in the abstract, but
 * actually accepts every lane slug the repository ships today. This reads
 * JSON DATA files (not source), so it does not trip `local/no-source-grep`
 * and is not a source-grep-in-disguise — no `.cjs`/`.js`/`.ts` source file is
 * ever `readFileSync`'d and string-matched in this file.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  REVIEWER_LANE_TRANSPORTS,
  REVIEWER_EVIDENCE_CLASSES,
  REVIEWER_SLUG_RE,
  REVIEWER_FLAG_RE,
} = require(path.join(__dirname, '..', 'scripts', 'registry-schema.cjs'));

const {
  VALID_LANE_TRANSPORTS,
  VALID_EVIDENCE_CLASSES,
  LANE_SLUG_RE,
  LANE_FLAG_RE,
} = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'capability-validator.cjs'));

// ─── Parity: transport / evidence-class vocabularies ───────────────────────

describe('registry-reviewer-parity: vocab set-equality vs capability-validator.cjs', () => {
  test('registry transport vocab matches capability-validator', () => {
    const registrySet = new Set(REVIEWER_LANE_TRANSPORTS);
    assert.ok(registrySet.size > 0, 'expected REVIEWER_LANE_TRANSPORTS to be non-empty');
    assert.ok(VALID_LANE_TRANSPORTS.size > 0, 'expected VALID_LANE_TRANSPORTS to be non-empty');
    assert.deepEqual(
      [...registrySet].sort(),
      [...VALID_LANE_TRANSPORTS].sort(),
      'REVIEWER_LANE_TRANSPORTS must be set-equal to capability-validator.cjs VALID_LANE_TRANSPORTS',
    );
  });

  test('registry evidence-class vocab matches capability-validator', () => {
    const registrySet = new Set(REVIEWER_EVIDENCE_CLASSES);
    assert.ok(registrySet.size > 0, 'expected REVIEWER_EVIDENCE_CLASSES to be non-empty');
    assert.ok(VALID_EVIDENCE_CLASSES.size > 0, 'expected VALID_EVIDENCE_CLASSES to be non-empty');
    assert.deepEqual(
      [...registrySet].sort(),
      [...VALID_EVIDENCE_CLASSES].sort(),
      'REVIEWER_EVIDENCE_CLASSES must be set-equal to capability-validator.cjs VALID_EVIDENCE_CLASSES',
    );
  });
});

// ─── Parity: slug / flag grammar — byte-identical regexes ──────────────────

describe('registry-reviewer-parity: grammar regexes are byte-identical to capability-validator.cjs', () => {
  test('registry slug grammar is byte-identical to LANE_SLUG_RE', () => {
    assert.equal(
      REVIEWER_SLUG_RE.source,
      LANE_SLUG_RE.source,
      'REVIEWER_SLUG_RE.source must equal LANE_SLUG_RE.source — "keep the two grammars byte-identical" (capability-validator.cjs:807-810)',
    );
    assert.equal(
      REVIEWER_SLUG_RE.flags,
      LANE_SLUG_RE.flags,
      'REVIEWER_SLUG_RE.flags must equal LANE_SLUG_RE.flags',
    );
  });

  test('registry flag grammar is byte-identical to LANE_FLAG_RE', () => {
    assert.equal(
      REVIEWER_FLAG_RE.source,
      LANE_FLAG_RE.source,
      'REVIEWER_FLAG_RE.source must equal LANE_FLAG_RE.source',
    );
    assert.equal(
      REVIEWER_FLAG_RE.flags,
      LANE_FLAG_RE.flags,
      'REVIEWER_FLAG_RE.flags must equal LANE_FLAG_RE.flags',
    );
  });
});

// ─── Reality check: every shipped first-party lane slug validates ─────────

describe('registry-reviewer-parity: every first-party lane slug is accepted by the registry schema', () => {
  test('every first-party lane slug is accepted by the registry schema', () => {
    const capabilitiesDir = path.join(__dirname, '..', 'capabilities');
    const capabilityDirs = fs.readdirSync(capabilitiesDir, { withFileTypes: true }).filter((d) => d.isDirectory());

    const collectedSlugs = [];
    for (const dirent of capabilityDirs) {
      const capabilityJsonPath = path.join(capabilitiesDir, dirent.name, 'capability.json');
      if (!fs.existsSync(capabilityJsonPath)) continue;
      const data = JSON.parse(fs.readFileSync(capabilityJsonPath, 'utf8'));
      if (data && typeof data === 'object' && data.reviewer && typeof data.reviewer.slug === 'string') {
        collectedSlugs.push({ id: dirent.name, slug: data.reviewer.slug });
      }
    }

    // Sanity: the collected set must be non-empty, or the loop below would
    // pass vacuously — a glob that silently matched nothing must fail loudly.
    assert.ok(
      collectedSlugs.length > 0,
      'expected at least one capabilities/*/capability.json with a reviewer.slug — found none',
    );

    for (const { id, slug } of collectedSlugs) {
      assert.ok(
        REVIEWER_SLUG_RE.test(slug),
        `expected capabilities/${id}/capability.json reviewer.slug "${slug}" to match REVIEWER_SLUG_RE (${REVIEWER_SLUG_RE})`,
      );
    }
  });
});

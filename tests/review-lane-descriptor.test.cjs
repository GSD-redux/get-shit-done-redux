'use strict';

/**
 * Reviewer Lane Descriptor + DEFECT.GENERATIVE-FIX parity (#2794, ADR-2782 Phase 1).
 *
 * `CONTEXT.md:797` requires that a constant shared between two parallel surfaces
 * carry a parity assertion failing when they diverge. The reviewer roster has
 * never had one: it is declared across four surfaces — the descriptor, the
 * roster in `review-reviewer-selection.cts`, the `invoke_reviewers` legs, and the
 * `write_reviews` section headings — and only the Cursor lane has ever been
 * parity-checked at all.
 *
 * The assertion is exercised in BOTH directions, because a forward-only check
 * ("does every declared lane resolve?") misses the failure this exists to catch:
 * #2718 added a lane leg and #2781 was the documentation drift that followed. So
 * every negative row below feeds a SYNTHETIC divergence to the pure checker and
 * asserts the specific violation — a parity test that has never been seen to
 * fail is a green light on drift, not a guarantee.
 *
 * Assertions are on the frozen `PARITY_VIOLATION` reason enum, never on rendered
 * prose (CONTRIBUTING.md — "tests assert on typed structured values").
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  REVIEWER_LANES,
  PARITY_VIOLATION,
  checkReviewerLaneParity,
} = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const {
  KNOWN_REVIEWER_SLUGS,
} = require('../gsd-core/bin/lib/review-reviewer-selection.cjs');

const ROOT = path.join(__dirname, '..');
// Normalized to LF on read so the CRLF cases below can construct a Windows
// checkout deterministically from a known-LF baseline.
const WORKFLOW_TEXT = fs
  .readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'review.md'), 'utf-8')
  .replace(/\r\n/g, '\n');

/** Render the LF baseline as a Windows autocrlf checkout would store it. */
function asCrlf(text) {
  return text.split('\n').join('\r\n');
}

/** Run the checker against the shipped inputs, with targeted overrides. */
function check(overrides = {}) {
  return checkReviewerLaneParity({
    descriptor: REVIEWER_LANES,
    roster: KNOWN_REVIEWER_SLUGS,
    workflowText: WORKFLOW_TEXT,
    ...overrides,
  });
}

/** The violation reasons produced, as a plain sorted array of `reason:subject`. */
function reasons(result) {
  return result.violations.map((v) => `${v.reason}:${v.subject}`).sort();
}

/** A lane object that is structurally valid but names nothing real. */
function fakeLane(slug) {
  return { ...REVIEWER_LANES[0], slug, flags: [`--${slug}`], reviewsSection: slug };
}

describe('reviewer lane parity — the shipped repo', () => {
  test('descriptor, roster, workflow legs and output sections all agree', () => {
    const r = check();
    assert.deepStrictEqual(
      r.violations,
      [],
      `shipped repo must satisfy lane parity; got: ${JSON.stringify(r.violations)}`,
    );
    assert.strictEqual(r.ok, true);
  });

  test('the descriptor covers every roster slug and vice versa', () => {
    assert.deepStrictEqual(
      REVIEWER_LANES.map((l) => l.slug).sort(),
      [...KNOWN_REVIEWER_SLUGS].sort(),
    );
  });

  test('parity is evaluated over a non-empty lane set', () => {
    // Guards the vacuous-truth failure mode: an empty descriptor trivially
    // satisfies every forward check.
    assert.ok(REVIEWER_LANES.length >= 11, 'expected at least the 11 shipped lanes');
  });
});

describe('reviewer lane parity — descriptor vs roster', () => {
  test('a roster slug with no descriptor entry is a violation', () => {
    const r = check({ roster: [...KNOWN_REVIEWER_SLUGS, 'kimi_code'] });
    assert.deepStrictEqual(reasons(r), [
      `${PARITY_VIOLATION.ROSTER_SLUG_UNDECLARED}:kimi_code`,
    ]);
  });

  test('a descriptor lane absent from the roster is a violation', () => {
    const r = check({ descriptor: [...REVIEWER_LANES, fakeLane('acme')] });
    assert.ok(
      reasons(r).includes(`${PARITY_VIOLATION.DESCRIPTOR_LANE_NOT_IN_ROSTER}:acme`),
      `expected a not-in-roster violation, got: ${JSON.stringify(reasons(r))}`,
    );
  });
});

describe('reviewer lane parity — descriptor vs invoke_reviewers legs', () => {
  test('a leg added without a descriptor entry is a violation', () => {
    // The #2718 shape: a new lane's bash block lands in the workflow and nothing
    // else moves. This is the row a forward-only assertion cannot catch.
    const r = check({
      workflowText: WORKFLOW_TEXT.replace(
        '<!-- reviewer-lane: qwen -->',
        '<!-- reviewer-lane: qwen -->\n<!-- reviewer-lane: kimi_code -->',
      ),
    });
    assert.deepStrictEqual(reasons(r), [
      `${PARITY_VIOLATION.LEG_MARKER_UNDECLARED}:kimi_code`,
    ]);
  });

  test('a declared lane whose workflow leg was removed is a violation', () => {
    const r = check({
      workflowText: WORKFLOW_TEXT.replace('<!-- reviewer-lane: qwen -->', ''),
    });
    assert.deepStrictEqual(reasons(r), [
      `${PARITY_VIOLATION.LEG_MARKER_MISSING}:qwen`,
    ]);
  });

  test('a duplicated leg marker is a violation', () => {
    const r = check({
      workflowText: WORKFLOW_TEXT.replace(
        '<!-- reviewer-lane: qwen -->',
        '<!-- reviewer-lane: qwen -->\n<!-- reviewer-lane: qwen -->',
      ),
    });
    assert.deepStrictEqual(reasons(r), [
      `${PARITY_VIOLATION.LEG_MARKER_DUPLICATED}:qwen`,
    ]);
  });

  test('marker matching tolerates whitespace variation', () => {
    const r = check({
      workflowText: WORKFLOW_TEXT.replace(
        '<!-- reviewer-lane: qwen -->',
        '<!--reviewer-lane:qwen-->',
      ),
    });
    assert.deepStrictEqual(r.violations, []);
  });

  test('a marker outside the invoke_reviewers step does not satisfy the leg', () => {
    // Scoped, not file-wide: a marker parked in write_reviews must not be
    // mistaken for a dispatch leg.
    const moved = WORKFLOW_TEXT
      .replace('<!-- reviewer-lane: qwen -->', '')
      .replace('## Qwen Review', '<!-- reviewer-lane: qwen -->\n## Qwen Review');
    const r = check({ workflowText: moved });
    assert.deepStrictEqual(reasons(r), [
      `${PARITY_VIOLATION.LEG_MARKER_MISSING}:qwen`,
    ]);
  });
});

describe('reviewer lane parity — descriptor vs write_reviews sections', () => {
  test('an output section with no declared lane is a violation', () => {
    const r = check({
      workflowText: WORKFLOW_TEXT.replace(
        '## Qwen Review',
        '## Qwen Review\n\n{qwen}\n\n---\n\n## Kimi Review',
      ),
    });
    assert.deepStrictEqual(reasons(r), [
      `${PARITY_VIOLATION.SECTION_UNDECLARED}:Kimi`,
    ]);
  });

  test('a declared lane with no output section is a violation', () => {
    const r = check({
      workflowText: WORKFLOW_TEXT.replace('## Qwen Review', '## Renamed Heading'),
    });
    assert.ok(
      reasons(r).includes(`${PARITY_VIOLATION.SECTION_MISSING}:Qwen`),
      `expected a section-missing violation, got: ${JSON.stringify(reasons(r))}`,
    );
  });

  test('a duplicated output section is a violation', () => {
    // Two lanes under one heading would silently MERGE in REVIEWS.md, producing
    // a review that appears to have consensus it does not have (ADR-2782 D8).
    const r = check({
      workflowText: WORKFLOW_TEXT.replace(
        '## Qwen Review',
        '## Qwen Review\n\n{a}\n\n---\n\n## Qwen Review',
      ),
    });
    assert.deepStrictEqual(reasons(r), [
      `${PARITY_VIOLATION.SECTION_DUPLICATED}:Qwen`,
    ]);
  });
});

describe('reviewer lane parity — not-corruption (must NOT fire)', () => {
  test('ADR-1517 instance sections are exempt from lane parity', () => {
    // `## OpenCode Review (opencode-deepseek)` and `(opencode-mimo)` are already
    // in the shipped file. ADR-2782 D8: reviewer instances are not lanes. A
    // naive `## … Review` matcher fails against these on day one.
    const r = check();
    assert.deepStrictEqual(r.violations, []);

    const withNewInstance = WORKFLOW_TEXT.replace(
      '## Qwen Review',
      '## Qwen Review (qwen-turbo)\n\n{x}\n\n---\n\n## Qwen Review',
    );
    assert.deepStrictEqual(
      checkReviewerLaneParity({
        descriptor: REVIEWER_LANES,
        roster: KNOWN_REVIEWER_SLUGS,
        workflowText: withNewInstance,
      }).violations,
      [],
      'adding a reviewer instance section must not trip lane parity',
    );
  });

  test('the h1 title and non-lane headings are not read as lane sections', () => {
    // `# Cross-AI Plan Review — Phase {N}` contains "Review" but is h1;
    // `## Consensus Summary` is h2 but has no ` Review` suffix.
    const r = check();
    assert.deepStrictEqual(r.violations, []);

    const withExtras = WORKFLOW_TEXT.replace(
      '## Consensus Summary',
      '## Another Summary\n\n---\n\n## Consensus Summary',
    );
    assert.deepStrictEqual(
      checkReviewerLaneParity({
        descriptor: REVIEWER_LANES,
        roster: KNOWN_REVIEWER_SLUGS,
        workflowText: withExtras,
      }).violations,
      [],
    );
  });

  test('bold prose in invoke_reviewers is not read as a leg', () => {
    // Five non-lane bold labels share the bold-then-fence shape a heuristic
    // matcher would key on. Adding another must not register a lane.
    const withProse = WORKFLOW_TEXT.replace(
      '<!-- reviewer-lane: qwen -->',
      '**Some new maintainer note (#9999):**\n\n```bash\necho hi\n```\n\n<!-- reviewer-lane: qwen -->',
    );
    assert.deepStrictEqual(
      checkReviewerLaneParity({
        descriptor: REVIEWER_LANES,
        roster: KNOWN_REVIEWER_SLUGS,
        workflowText: withProse,
      }).violations,
      [],
    );
  });
});

describe('reviewer lane parity — cross-platform and hostile input', () => {
  test('parity is CRLF-insensitive', () => {
    // A Windows autocrlf checkout puts \r on every line; without normalization
    // every marker and heading would miss and the whole roster would report
    // missing.
    const r = check({ workflowText: asCrlf(WORKFLOW_TEXT) });
    assert.deepStrictEqual(r.violations, []);
  });

  test('a divergence is still detected under CRLF', () => {
    const crlf = asCrlf(
      WORKFLOW_TEXT.replace('<!-- reviewer-lane: qwen -->', ''),
    );
    assert.deepStrictEqual(reasons(check({ workflowText: crlf })), [
      `${PARITY_VIOLATION.LEG_MARKER_MISSING}:qwen`,
    ]);
  });

  test('empty workflow text degrades to violations rather than throwing', () => {
    // A read failure must never be mistaken for a clean bill of health.
    const r = check({ workflowText: '' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(
      r.violations.filter((v) => v.reason === PARITY_VIOLATION.LEG_MARKER_MISSING)
        .length,
      REVIEWER_LANES.length,
    );
  });

  test('non-string workflow text is coerced, never thrown on', () => {
    for (const bad of [undefined, null]) {
      const r = check({ workflowText: bad });
      assert.strictEqual(r.ok, false, `expected violations for ${String(bad)}`);
    }
  });

  test('repeated evaluation is stable (no leaked regex lastIndex)', () => {
    // A module-level /g regex carries state between calls and would silently
    // skip matches on the second invocation.
    const first = check();
    const second = check();
    assert.deepStrictEqual(second.violations, first.violations);
    assert.deepStrictEqual(second.violations, []);
  });
});

describe('reviewer lane parity — descriptor-internal uniqueness (ADR-2782 D8)', () => {
  test('duplicate lane slugs are a violation', () => {
    const r = check({ descriptor: [...REVIEWER_LANES, REVIEWER_LANES[0]] });
    assert.ok(reasons(r).some((x) => x.startsWith(PARITY_VIOLATION.DUPLICATE_SLUG)));
  });

  test('duplicate lane flags are a violation', () => {
    const clash = { ...fakeLane('acme'), flags: ['--gemini'] };
    const r = check({ descriptor: [...REVIEWER_LANES, clash] });
    assert.ok(
      reasons(r).includes(`${PARITY_VIOLATION.DUPLICATE_FLAG}:--gemini`),
      `expected a duplicate-flag violation, got: ${JSON.stringify(reasons(r))}`,
    );
  });

  test('duplicate reviewsSection is a violation', () => {
    const clash = { ...fakeLane('acme'), reviewsSection: 'Gemini' };
    const r = check({ descriptor: [...REVIEWER_LANES, clash] });
    assert.ok(
      reasons(r).includes(`${PARITY_VIOLATION.DUPLICATE_SECTION}:Gemini`),
      `expected a duplicate-section violation, got: ${JSON.stringify(reasons(r))}`,
    );
  });
});

describe('reviewer lane descriptor — declared shape (ADR-2782 D1/D2/D6/D7)', () => {
  test('every lane declares a closed transport', () => {
    for (const lane of REVIEWER_LANES) {
      assert.ok(
        ['spawn', 'openai-http'].includes(lane.invoke.transport),
        `${lane.slug}: unexpected transport ${lane.invoke.transport}`,
      );
    }
  });

  test('the transport sub-shape is respected per lane', () => {
    // A descriptor carrying fields from both sub-shapes — or neither — has
    // undefined meaning, which is what a closed vocabulary exists to prevent.
    for (const lane of REVIEWER_LANES) {
      const i = lane.invoke;
      if (i.transport === 'spawn') {
        assert.ok(i.binary, `${lane.slug}: spawn lane must declare a binary`);
        assert.ok(Array.isArray(i.args), `${lane.slug}: spawn lane must declare args`);
        assert.strictEqual(i.hostConfigKey, undefined, `${lane.slug}: spawn lane must not declare hostConfigKey`);
      } else {
        assert.ok(i.hostConfigKey, `${lane.slug}: http lane must declare hostConfigKey`);
        assert.ok(i.path, `${lane.slug}: http lane must declare a path`);
        assert.strictEqual(i.binary, undefined, `${lane.slug}: http lane must not declare a binary`);
        assert.strictEqual(i.effortChannel, 'none', `${lane.slug}: http lanes carry no effort channel`);
      }
    }
  });

  test('every probe kind is in the closed enum', () => {
    for (const lane of REVIEWER_LANES) {
      assert.ok(
        ['command-exists', 'command-capability', 'http-reachable'].includes(lane.probe.kind),
        `${lane.slug}: unexpected probe kind ${lane.probe.kind}`,
      );
    }
  });

  test('every probe that opens a connection declares a bound', () => {
    // DEFECT.UNBOUNDED-SUBPROCESS: an unbounded probe hangs every future review,
    // including reviews that never asked for that lane.
    for (const lane of REVIEWER_LANES) {
      if (lane.probe.kind === 'command-exists') continue;
      assert.ok(
        Number.isInteger(lane.probe.timeoutMs) && lane.probe.timeoutMs > 0,
        `${lane.slug}: ${lane.probe.kind} probe must declare a positive timeoutMs`,
      );
    }
  });

  test('handler is a closed first-party enum', () => {
    const allowed = [null, 'antigravity', 'openai-compatible'];
    for (const lane of REVIEWER_LANES) {
      assert.ok(allowed.includes(lane.handler), `${lane.slug}: unexpected handler ${lane.handler}`);
    }
    assert.deepStrictEqual(
      REVIEWER_LANES.filter((l) => l.handler !== null).map((l) => l.slug).sort(),
      ['antigravity', 'llama_cpp', 'lm_studio', 'ollama'],
    );
  });

  test('every lane declares a positive timeout floor', () => {
    for (const lane of REVIEWER_LANES) {
      assert.ok(
        Number.isInteger(lane.timeoutFloorMs) && lane.timeoutFloorMs > 0,
        `${lane.slug}: timeoutFloorMs must be a positive integer`,
      );
    }
  });

  test('empty-output policy is normalized across lanes', () => {
    // Only Antigravity opts out, and it does so by owning its own diagnostics
    // through a handler (ADR-2782 D6) — not by discarding stderr.
    assert.deepStrictEqual(
      REVIEWER_LANES.filter((l) => l.emptyOutput !== 'stub-with-stderr').map((l) => l.slug),
      ['antigravity'],
    );
  });

  test('the descriptor table is frozen', () => {
    assert.ok(Object.isFrozen(REVIEWER_LANES));
    for (const lane of REVIEWER_LANES) {
      assert.ok(Object.isFrozen(lane), `${lane.slug}: lane must be frozen`);
    }
  });

  test('the violation reason enum is locked', () => {
    // Adding a reason is three coordinated changes: enum, emitting site, and
    // this assertion.
    assert.deepStrictEqual(Object.keys(PARITY_VIOLATION).sort(), [
      'DESCRIPTOR_LANE_NOT_IN_ROSTER',
      'DUPLICATE_FLAG',
      'DUPLICATE_SECTION',
      'DUPLICATE_SLUG',
      'LEG_MARKER_DUPLICATED',
      'LEG_MARKER_MISSING',
      'LEG_MARKER_UNDECLARED',
      'ROSTER_SLUG_UNDECLARED',
      'SECTION_DUPLICATED',
      'SECTION_MISSING',
      'SECTION_UNDECLARED',
    ]);
    assert.ok(Object.isFrozen(PARITY_VIOLATION));
  });
});

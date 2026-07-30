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
const fc = require('fast-check');

const {
  REVIEWER_LANES,
  PARITY_VIOLATION,
  checkReviewerLaneParity,
} = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const {
  KNOWN_REVIEWER_SLUGS,
} = require('../gsd-core/bin/lib/review-reviewer-selection.cjs');
const CAPABILITY_REGISTRY = require('../gsd-core/bin/lib/capability-registry.cjs');

/**
 * Reviewer slugs the GENERATED registry declares — the surface Phase 5b (#2799) re-pointed parity
 * onto. Once `invoke_reviewers` iterates lanes, the registry (not the workflow text) is what
 * decides which lanes exist at runtime.
 */
const REGISTRY_LANE_SLUGS = Object.values(CAPABILITY_REGISTRY.capabilities || {})
  .map((c) => c && c.reviewer && c.reviewer.slug)
  .filter((s) => typeof s === 'string' && s)
  .sort();

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
    registry: REGISTRY_LANE_SLUGS,
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

describe('reviewer lane parity — descriptor vs registry (ADR-2782 Phase 5b)', () => {
  // Phase 5b deleted the per-lane workflow text this file used to scan, so the leg-marker and
  // section-heading families are gone. What replaced them is the parity that is load-bearing once
  // lanes are data: the registry is what the runtime actually iterates.
  test('a registry lane with no descriptor entry is a violation', () => {
    const r = check({ registry: [...REGISTRY_LANE_SLUGS, 'acme'] });
    assert.ok(
      reasons(r).includes(`${PARITY_VIOLATION.REGISTRY_LANE_UNDECLARED}:acme`),
      'a lane the registry ships but the descriptor never declared must fail',
    );
  });

  test('a descriptor lane absent from the registry is a violation', () => {
    const r = check({
      descriptor: [...REVIEWER_LANES, fakeLane('acme')],
      roster: [...KNOWN_REVIEWER_SLUGS, 'acme'],
    });
    assert.ok(
      reasons(r).includes(`${PARITY_VIOLATION.DESCRIPTOR_LANE_NOT_IN_REGISTRY}:acme`),
      'a declared lane no capability manifest ships must fail',
    );
  });

  test('an empty registry reports every lane rather than passing silently', () => {
    // Degrading to violations is the point: a checker that cannot tell "no registry" from
    // "registry agrees" is worse than no checker.
    const r = check({ registry: [] });
    const missing = r.violations.filter(
      (v) => v.reason === PARITY_VIOLATION.DESCRIPTOR_LANE_NOT_IN_REGISTRY,
    );
    assert.equal(missing.length, REVIEWER_LANES.length);
  });

  test('a non-array registry degrades to violations, never throws', () => {
    for (const bad of [null, undefined, 42, 'gemini', {}]) {
      const r = check({ registry: bad });
      assert.equal(r.ok, false);
    }
  });
});

describe('reviewer lane parity — anti-parity: no bespoke leg may return', () => {
  test('a re-added per-CLI leg marker is a violation', () => {
    // The regex flipped polarity in Phase 5b: matching a leg marker is now the failure. Without
    // this, nothing stops a contributor quietly re-adding a hand-authored block — which is the
    // drift (#2718 -> #2781) the epic exists to end, and every other check here would still pass.
    const wf = WORKFLOW_TEXT.replace(
      '<step name="invoke_reviewers">',
      '<step name="invoke_reviewers">\n<!-- reviewer-lane: gemini -->',
    );
    const r = check({ workflowText: wf });
    assert.ok(reasons(r).includes(`${PARITY_VIOLATION.BESPOKE_LEG_PRESENT}:gemini`));
  });

  test('the shipped workflow contains no leg markers', () => {
    const r = check();
    assert.deepStrictEqual(
      r.violations.filter((v) => v.reason === PARITY_VIOLATION.BESPOKE_LEG_PRESENT),
      [],
    );
  });

  test('a marker outside the invoke_reviewers step is not a bespoke leg', () => {
    const r = check({ workflowText: `${WORKFLOW_TEXT}\n<!-- reviewer-lane: gemini -->\n` });
    assert.deepStrictEqual(
      r.violations.filter((v) => v.reason === PARITY_VIOLATION.BESPOKE_LEG_PRESENT),
      [],
      'the anti-parity check is scoped to invoke_reviewers, as the old leg check was',
    );
  });
});

describe('reviewer lane parity — not-corruption (must NOT fire)', () => {
  // Phase 5b deleted the section-heading and leg-marker matchers these cases were written against.
  // The invariant they protected still matters and is asserted here against the surfaces that
  // replaced them: nothing in REVIEWS.md prose may promote itself into the lane roster.
  test('the shipped repo is clean', () => {
    assert.deepStrictEqual(check().violations, []);
  });

  test('an ADR-1517 instance heading never becomes a lane', () => {
    // `## OpenCode Review (opencode-deepseek)` is an INSTANCE resolving through a lane, not a lane
    // (ADR-2782 D8). Instances take no part in the roster, the flag set, or uniqueness.
    const withNewInstance = WORKFLOW_TEXT.replace(
      '## Consensus Summary',
      '## Qwen Review (qwen-turbo)\n\n{x}\n\n---\n\n## Consensus Summary',
    );
    assert.deepStrictEqual(check({ workflowText: withNewInstance }).violations, []);
  });

  test('extra non-lane headings are inert', () => {
    const withExtras = WORKFLOW_TEXT.replace(
      '## Consensus Summary',
      '## Another Summary\n\n---\n\n## Consensus Summary',
    );
    assert.deepStrictEqual(check({ workflowText: withExtras }).violations, []);
  });

  test('bold prose in invoke_reviewers is not read as a leg', () => {
    // Non-lane bold labels share the bold-then-fence shape a heuristic matcher would key on.
    // Adding another must not register a lane — the anti-parity check keys on the explicit marker
    // only, never on prose shape.
    const withProse = WORKFLOW_TEXT.replace(
      '<step name="invoke_reviewers">',
      '<step name="invoke_reviewers">\n**Some new maintainer note (#9999):**\n\n```bash\necho hi\n```\n',
    );
    assert.deepStrictEqual(check({ workflowText: withProse }).violations, []);
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
      WORKFLOW_TEXT.replace(
        '<step name="invoke_reviewers">',
        '<step name="invoke_reviewers">\n<!-- reviewer-lane: qwen -->',
      ),
    );
    assert.deepStrictEqual(reasons(check({ workflowText: crlf })), [
      `${PARITY_VIOLATION.BESPOKE_LEG_PRESENT}:qwen`,
    ]);
  });

  test('empty workflow text is clean for anti-parity but an empty REGISTRY is not', () => {
    // Phase 5b split what "degrades to violations" means. An empty WORKFLOW legitimately contains
    // no bespoke leg, so the anti-parity arm is silent — the workflow no longer names lanes at all.
    // The read-failure guard moved to the registry arm, which is now the surface that decides which
    // lanes exist: an unreadable registry must never read as "registry agrees".
    const emptyWorkflow = check({ workflowText: '' });
    assert.deepStrictEqual(
      emptyWorkflow.violations.filter((v) => v.reason === PARITY_VIOLATION.BESPOKE_LEG_PRESENT),
      [],
    );

    const emptyRegistry = check({ registry: [] });
    assert.strictEqual(emptyRegistry.ok, false);
    assert.strictEqual(
      emptyRegistry.violations.filter(
        (v) => v.reason === PARITY_VIOLATION.DESCRIPTOR_LANE_NOT_IN_REGISTRY,
      ).length,
      REVIEWER_LANES.length,
    );
  });

  test('non-string workflow text is coerced, never thrown on', () => {
    // Totality is the invariant. Since Phase 5b the workflow no longer names lanes, so an absent
    // one legitimately yields NO anti-parity violation — the read-failure guard moved to the
    // registry arm, which is covered in the registry describe above.
    for (const bad of [undefined, null, 42, {}, []]) {
      const r = check({ workflowText: bad });
      assert.equal(typeof r.ok, 'boolean');
      assert.ok(Array.isArray(r.violations));
      assert.deepStrictEqual(
        r.violations.filter((v) => v.reason === PARITY_VIOLATION.BESPOKE_LEG_PRESENT),
        [],
      );
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

/**
 * `checkReviewerLaneParity` parses markdown for lane markers and section
 * headings, so CLAUDE.md's TEST RULES ("Parsers... must include at least one
 * fast-check property test") applies.
 *
 * FIXTURE PROVENANCE (CONTRIBUTING.md #2371): the generators below are
 * DOCUMENT-shaped, not writer-seeded. They emit arbitrary markdown — arbitrary
 * noise lines, arbitrary heading levels, arbitrary bold labels, markers placed
 * at arbitrary positions — rather than being built by calling the same regexes
 * the checker uses. A generator seeded from the module's own matchers could only
 * ever produce documents the matchers already recognize, which makes the
 * document shape a constant and the property unfalsifiable.
 *
 * Deterministic per repo rules: seed pinned, run count bounded.
 */
describe('reviewer lane parity — properties', () => {
  const FC = { seed: 20260729, numRuns: 200 };

  /** Slugs inside the declared grammar — the only ones a marker can carry. */
  const slugArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/);

  /**
   * Slugs OUTSIDE the declared LANE_SLUG_RE grammar, which stays enforced after Phase 5b so
   * contract is that they are reported as INVALID_SLUG rather than silently
   * reported missing. Includes regex metacharacters and prototype-pollution
   * shaped keys.
   */
  const badSlugArb = fc.constantFrom(
    'a.b', 'a*b', 'a+b', '(a)', '[a]', 'a|b', 'A', '-lead', '_lead', '__proto__', '',
  );

  /**
   * Slugs that ARE inside the grammar but collide with Object.prototype keys.
   * `constructor` is all-lowercase, so it is a legitimate slug — the risk is
   * prototype pollution in the counting maps, not validation.
   */
  const prototypeKeyArb = fc.constantFrom('constructor', 'tostring', 'valueof', 'hasownproperty');

  /** Arbitrary markdown noise that must never be read as a marker or a lane heading. */
  const noiseArb = fc.array(
    fc.oneof(
      fc.constant(''),
      fc.constant('**Timeout guidance (#2194):**'),
      fc.constant('```bash'),
      fc.constant('```'),
      fc.constant('# Cross-AI Plan Review — Phase {N}'),
      fc.constant('## Consensus Summary'),
      fc.constant('### Agreed Concerns'),
      fc.constant('<!-- not-a-lane-marker: xyz -->'),
      fc.stringMatching(/^[A-Za-z0-9 ,.()#*_-]{0,40}$/),
    ),
    { maxLength: 12 },
  );

  /** Build a review.md-shaped document declaring exactly `slugs`. */
  function docFor(slugs, sections, noise, eol) {
    // No leg markers: Phase 5b's workflow iterates lanes, and a marker is now the violation.
    // `slugs` is retained so callers keep their existing shape.
    const legs = slugs.map((s) => `**${s}:**`).join('\n');
    const heads = sections.map((s) => `## ${s} Review`).join('\n\n');
    const body = [
      '<step name="invoke_reviewers">',
      ...noise,
      legs,
      '</step>',
      '<step name="write_reviews">',
      ...noise,
      heads,
      '## Consensus Summary',
      '</step>',
    ].join('\n');
    return body.split('\n').join(eol);
  }

  const laneSetArb = fc
    .uniqueArray(slugArb, { minLength: 1, maxLength: 6 })
    .map((slugs) =>
      slugs.map((slug, i) => ({
        slug,
        flags: [`--${slug}`],
        transport: 'spawn',
        probe: { kind: 'command-exists', binary: slug },
        invoke: {
          binary: slug,
          args: [],
          promptChannel: 'stdin',
          outputChannel: 'stdout',
          modelArg: null,
          effortChannel: 'none',
        },
        timeoutFloorMs: 1000,
        emptyOutput: 'stub-with-stderr',
        // Section names are index-tagged so they stay unique even when two slugs
        // differ only by a character the heading grammar would not distinguish.
        reviewsSection: `Sec${i}`,
        evidenceClass: 'source-grounded',
        requiresBinaries: [],
        promptBudgetKey: null,
        handler: null,
      })),
    );

  test('never throws on arbitrary input, and ok always agrees with the violations', () => {
    // Totality is a real requirement, not a nicety: Phase 2 (#2795) feeds this
    // same function manifest-derived data from third-party overlays. A checker
    // that throws on bad input cannot report on it, and a parity gate that
    // crashes is indistinguishable from one that was never run.
    fc.assert(
      fc.property(
        fc.anything(),
        fc.anything(),
        fc.anything(),
        (descriptor, roster, workflowText) => {
          let r;
          try {
            r = checkReviewerLaneParity({ descriptor, roster, workflowText });
          } catch {
            return false;
          }
          return (
            Array.isArray(r.violations) && r.ok === (r.violations.length === 0)
          );
        },
      ),
      FC,
    );
  });

  test('a slug outside the declared grammar is named, never silently accepted', () => {
    // The grammar is still enforced after Phase 5b, for the same reason: a lane whose slug falls
    // outside it is unmatchable downstream, and a loud named violation beats a silent miss.
    fc.assert(
      fc.property(badSlugArb, (bad) => {
        const lane = { ...fakeLane('placeholder'), slug: bad };
        const r = checkReviewerLaneParity({
          descriptor: [lane],
          roster: [bad],
          registry: [bad],
          workflowText: '<step name="invoke_reviewers">\n</step>',
        });
        return r.violations.map((v) => v.reason).includes(PARITY_VIOLATION.INVALID_SLUG);
      }),
      FC,
    );
  });

  test('a prototype-key slug behaves like any other valid slug', () => {
    // The counting layer uses Map/Set, not bare objects, so a slug named
    // `constructor` cannot reach Object.prototype. Locking it: a bare-object
    // counter would make this lane appear present when it is absent.
    fc.assert(
      fc.property(prototypeKeyArb, (name) => {
        const lane = { ...fakeLane('placeholder'), slug: name, reviewsSection: 'Sec' };
        const declared = checkReviewerLaneParity({
          descriptor: [lane],
          roster: [name],
          registry: [name],
          workflowText: '<step name="invoke_reviewers">\n</step>',
        });
        const absent = checkReviewerLaneParity({
          descriptor: [lane],
          roster: [name],
          registry: [],
          workflowText: '<step name="invoke_reviewers">\n</step>',
        });
        return (
          declared.ok &&
          absent.violations.some(
            (v) =>
              v.reason === PARITY_VIOLATION.DESCRIPTOR_LANE_NOT_IN_REGISTRY &&
              v.subject === name,
          )
        );
      }),
      FC,
    );
  });

  test('a non-object lane entry is reported as malformed, not thrown on', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0, 1, '', 'x', null, true, [], NaN),
        (junk) => {
          const r = checkReviewerLaneParity({
            descriptor: [junk],
            roster: [],
            workflowText: '',
          });
          const reasonsOut = r.violations.map((v) => v.reason);
          return (
            reasonsOut.includes(PARITY_VIOLATION.MALFORMED_LANE) ||
            reasonsOut.includes(PARITY_VIOLATION.INVALID_SLUG)
          );
        },
      ),
      FC,
    );
  });

  test('a document declaring exactly the descriptor satisfies parity', () => {
    fc.assert(
      fc.property(laneSetArb, noiseArb, fc.constantFrom('\n', '\r\n'), (lanes, noise, eol) => {
        const doc = docFor(
          lanes.map((l) => l.slug),
          lanes.map((l) => l.reviewsSection),
          noise,
          eol,
        );
        const r = checkReviewerLaneParity({
          descriptor: lanes,
          roster: lanes.map((l) => l.slug),
          registry: lanes.map((l) => l.slug),
          workflowText: doc,
        });
        return r.ok;
      }),
      FC,
    );
  });

  test('dropping one lane from the registry yields exactly that lane missing', () => {
    fc.assert(
      fc.property(laneSetArb, fc.nat(), (lanes, pick) => {
        const victim = lanes[pick % lanes.length];
        const r = checkReviewerLaneParity({
          descriptor: lanes,
          roster: lanes.map((l) => l.slug),
          registry: lanes.filter((l) => l.slug !== victim.slug).map((l) => l.slug),
          workflowText: '<step name="invoke_reviewers">\n</step>',
        });
        const missing = r.violations.filter(
          (v) => v.reason === PARITY_VIOLATION.DESCRIPTOR_LANE_NOT_IN_REGISTRY,
        );
        return missing.length === 1 && missing[0].subject === victim.slug;
      }),
      FC,
    );
  });

  test('evaluation is deterministic across repeated calls', () => {
    // Guards regex lastIndex leaking between invocations of a module-level /g.
    fc.assert(
      fc.property(laneSetArb, noiseArb, (lanes, noise) => {
        const input = {
          descriptor: lanes,
          roster: lanes.map((l) => l.slug),
          registry: lanes.map((l) => l.slug),
          workflowText: docFor(
            lanes.map((l) => l.slug),
            lanes.map((l) => l.reviewsSection),
            noise,
            '\n',
          ),
        };
        const a = checkReviewerLaneParity(input);
        const b = checkReviewerLaneParity(input);
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      FC,
    );
  });
});

describe('reviewer lane descriptor — declared shape (ADR-2782 D1/D2/D6/D7)', () => {
  test('every lane declares a closed transport at the lane level', () => {
    // ADR-2782 D1 places `transport` as a sibling of `probe` and `invoke`, not
    // nested inside `invoke`. Locking the placement keeps Phase 2's manifest
    // harvest free of a translation step.
    for (const lane of REVIEWER_LANES) {
      assert.ok(
        ['spawn', 'openai-http'].includes(lane.transport),
        `${lane.slug}: unexpected transport ${lane.transport}`,
      );
      assert.strictEqual(
        lane.invoke.transport,
        undefined,
        `${lane.slug}: transport must not be duplicated inside invoke`,
      );
    }
  });

  test('the transport sub-shape is respected per lane', () => {
    // A descriptor carrying fields from both sub-shapes — or neither — has
    // undefined meaning, which is what a closed vocabulary exists to prevent.
    for (const lane of REVIEWER_LANES) {
      const i = lane.invoke;
      if (lane.transport === 'spawn') {
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
    const allowed = [null, 'antigravity', 'openai-compatible', 'opencode'];
    for (const lane of REVIEWER_LANES) {
      assert.ok(allowed.includes(lane.handler), `${lane.slug}: unexpected handler ${lane.handler}`);
    }
    assert.deepStrictEqual(
      REVIEWER_LANES.filter((l) => l.handler !== null).map((l) => l.slug).sort(),
      // `opencode` joined in Phase 5b: its review is reconstructed from assistant text parts of a
      // --format json stream, which data cannot express (#1936).
      ['antigravity', 'llama_cpp', 'lm_studio', 'ollama', 'opencode'],
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

  test('flag uniqueness holds across the flattened multi-flag set', () => {
    // ADR-2782 D8 states uniqueness over a singular `reviewer.flag`; this module
    // widens that field to `flags[]` (Antigravity is --antigravity AND --agy), so
    // the invariant is enforced over every lane's flattened flag set.
    const all = REVIEWER_LANES.flatMap((l) => l.flags);
    assert.deepStrictEqual([...new Set(all)].sort(), [...all].sort());
    assert.ok(
      REVIEWER_LANES.some((l) => l.flags.length > 1),
      'expected at least one multi-flag lane, else the widening is untested',
    );
  });

  test('the violation reason enum is locked', () => {
    // Adding a reason is three coordinated changes: enum, emitting site, and
    // this assertion.
    assert.deepStrictEqual(Object.keys(PARITY_VIOLATION).sort(), [
      'BESPOKE_LEG_PRESENT',
      'DESCRIPTOR_LANE_NOT_IN_REGISTRY',
      'DESCRIPTOR_LANE_NOT_IN_ROSTER',
      'DUPLICATE_FLAG',
      'DUPLICATE_SECTION',
      'DUPLICATE_SLUG',
      'INVALID_SLUG',
      'MALFORMED_LANE',
      'REGISTRY_LANE_UNDECLARED',
      'ROSTER_SLUG_UNDECLARED',
    ]);
    assert.ok(Object.isFrozen(PARITY_VIOLATION));
  });
});

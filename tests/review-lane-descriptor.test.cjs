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

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-2927-reviewer-lane-overlay-invocation.test.cjs — H3 wave-fold (#3339)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:issue-2927-reviewer-lane-overlay-invocation", () => {
'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Regression test for #2927 — third-party reviewer lane installs and is
 * roster-visible, but `review-lane sections|flags|plan|invoke` cannot select,
 * plan, or invoke it.
 *
 * Root cause: `routeReviewLane` (gsd-core/bin/gsd-tools.cjs) built its lane map
 * exclusively from the frozen first-party `REVIEWER_LANES` array and never
 * consulted the merged capability registry, so an installed overlay
 * `role:"reviewer"` capability — whose `reviewer` body is field-identical to a
 * `ReviewerLane` (ADR-2782 D1, "no translation layer") — was invisible to every
 * invocation subcommand.
 *
 * The fix extracts a PURE helper `mergeReviewerLanes(firstParty, registry)`
 * (source of truth: src/review-lane-descriptor.cts) implementing ADR-2782 D8:
 * first-party ∪ installed overlay `reviewer` bodies, first-party wins on slug
 * collision. This file exercises the helper directly against synthetic
 * registries — no real capability install — matching the convention in
 * reviewer-manifest-body.test.cjs / review-lane-invocation.test.cjs.
 *
 * Matrix: .gsd/bug/fix/2927-reviewer-lane-overlay-invocation/50-test-matrix.md
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  REVIEWER_LANES,
  mergeReviewerLanes,
  LANE_SLUG_RE,
} = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');

/** A first-party lane set small enough to read at a glance, but real-shaped. */
const FP = REVIEWER_LANES.slice(0, 2); // gemini, claude
const FP_SLUGS = FP.map((l) => l.slug);

/** A valid overlay `reviewer` body, field-identical to a SpawnLane (ADR-2782 D1). */
function overlayLane(overrides = {}) {
  return {
    slug: 'agy-revisor',
    flags: ['--agy-revisor'],
    transport: 'spawn',
    probe: { kind: 'command-exists', binary: 'agy' },
    invoke: {
      binary: 'agy',
      args: ['--agent', 'revisor-gsd', '{{model}}', '-p', '{{prompt}}'],
      promptChannel: 'argv-file-ref',
      outputChannel: 'stdout',
      modelArg: '--model',
      effortChannel: 'none',
    },
    timeoutFloorMs: 600000,
    emptyOutput: 'handler-owned',
    reviewsSection: 'Antigravity revisor-gsd',
    evidenceClass: 'source-grounded',
    requiresBinaries: [],
    promptBudgetKey: null,
    modelConfigKey: 'review.models.agy-revisor',
    handler: 'antigravity',
    ...overrides,
  };
}

/** A `role:"reviewer"` capability envelope carrying a reviewer body. */
function reviewerCap(body) {
  return { id: body && typeof body === 'object' && body.slug ? body.slug : 'x', role: 'reviewer', reviewer: body };
}

/** Build a synthetic registry shape ({ capabilities: { id: cap } }). */
function registry(...caps) {
  const capabilities = {};
  for (const c of caps) capabilities[c.id] = c;
  return { capabilities };
}

describe('mergeReviewerLanes (#2927)', () => {
  test('overlayAbsentReturnsFirstPartyUnchanged', () => {
    // Row 1: no overlay reviewer caps → merged set is first-party exactly.
    const merged = mergeReviewerLanes(FP, registry());
    assert.deepEqual(merged.map((l) => l.slug), FP_SLUGS);
    assert.equal(merged.length, FP.length);
    // identity, not just equality — first-party objects themselves
    assert.equal(merged[0], FP[0]);
    assert.equal(merged[1], FP[1]);
  });

  test('overlayLaneIncludedInMerge', () => {
    // Row 2 (failing-first regression): one valid non-colliding overlay lane is present.
    const merged = mergeReviewerLanes(FP, registry(reviewerCap(overlayLane())));
    const slugs = merged.map((l) => l.slug);
    assert.ok(slugs.includes('agy-revisor'), 'overlay slug admitted into merged set');
    assert.ok(slugs.includes('gemini'), 'first-party lanes preserved');
    // the overlay body itself is the merged entry (no translation layer)
    const overlay = merged.find((l) => l.slug === 'agy-revisor');
    assert.ok(overlay, 'agy-revisor overlay lane should be present in merged set');
    assert.equal(overlay.reviewsSection, 'Antigravity revisor-gsd');
    assert.deepEqual(overlay.flags, ['--agy-revisor']);
  });

  test('firstPartyWinsOnSlugCollision', () => {
    // Row 3 / D8: an overlay declaring a first-party slug is superseded by first-party.
    const colliding = overlayLane({ slug: 'claude', reviewsSection: 'EVIL CLAUDE' });
    const merged = mergeReviewerLanes(FP, registry(reviewerCap(colliding)));
    const claude = merged.find((l) => l.slug === 'claude');
    assert.ok(claude, 'claude first-party lane should be present in merged set');
    assert.equal(claude, FP.find((l) => l.slug === 'claude'), 'first-party identity wins');
    assert.notEqual(claude.reviewsSection, 'EVIL CLAUDE', 'overlay did not leak through');
    assert.equal(merged.length, FP.length, 'collision added no extra entry');
  });

  test('runtimeCapWithoutReviewerBodyAddsNoLane', () => {
    // Row 4: a role:"runtime" cap with only the legacy reviewerCli alias has no lane descriptor.
    const runtimeCap = { id: 'some-runtime', role: 'runtime', runtime: { hostBehaviors: { reviewerCli: true } } };
    const merged = mergeReviewerLanes(FP, registry(runtimeCap));
    assert.deepEqual(merged.map((l) => l.slug), FP_SLUGS, 'runtime alias contributed no lane');
  });

  test('emptySlugOverlaySkippedNotThrown', () => {
    // Row 5: an overlay body whose slug is empty/whitespace is skipped, never throws.
    const empty = reviewerCap(overlayLane({ slug: '   ' }));
    const missing = reviewerCap(overlayLane({ slug: '' }));
    assert.doesNotThrow(() => mergeReviewerLanes(FP, registry(empty)));
    assert.doesNotThrow(() => mergeReviewerLanes(FP, registry(missing)));
    const merged = mergeReviewerLanes(FP, registry(empty, missing));
    assert.deepEqual(merged.map((l) => l.slug), FP_SLUGS, 'empty-slug overlays admitted no lane');
  });

  test('invalidGrammarSlugSkipped', () => {
    // Row 6 / security: a slug outside LANE_SLUG_RE (path-traversal class) is skipped at the merge.
    const evil = reviewerCap(overlayLane({ slug: '../evil' }));
    assert.doesNotThrow(() => mergeReviewerLanes(FP, registry(evil)));
    const merged = mergeReviewerLanes(FP, registry(evil));
    assert.ok(!merged.map((l) => l.slug).includes('../evil'), 'invalid-grammar slug not admitted');
    // sanity: the grammar is what we think it is
    assert.ok(!LANE_SLUG_RE.test('../evil'));
    assert.ok(LANE_SLUG_RE.test('agy-revisor'));
  });

  test('twoOverlaysBothIncluded', () => {
    // Row 7: two distinct non-colliding overlays both present; count == fp + 2.
    const a = reviewerCap(overlayLane({ slug: 'alpha-lane', reviewsSection: 'Alpha' }));
    const b = reviewerCap(overlayLane({ slug: 'beta-lane', reviewsSection: 'Beta' }));
    const merged = mergeReviewerLanes(FP, registry(a, b));
    const slugs = merged.map((l) => l.slug);
    assert.ok(slugs.includes('alpha-lane'));
    assert.ok(slugs.includes('beta-lane'));
    assert.equal(merged.length, FP.length + 2);
  });

  test('malformedReviewerBodySkipped', () => {
    // Row 8: reviewer body that is null / array / string is skipped, no throw.
    const nullBody = { id: 'n', role: 'reviewer', reviewer: null };
    const arrBody = { id: 'a', role: 'reviewer', reviewer: [] };
    const strBody = { id: 's', role: 'reviewer', reviewer: 'not-an-object' };
    assert.doesNotThrow(() => mergeReviewerLanes(FP, registry(nullBody, arrBody, strBody)));
    const merged = mergeReviewerLanes(FP, registry(nullBody, arrBody, strBody));
    assert.deepEqual(merged.map((l) => l.slug), FP_SLUGS, 'malformed bodies admitted no lane');
  });
});

// ---------------------------------------------------------------------------
// Rows 9–10: the WIRING defect this PR exists to close. The eight rows above
// guard the pure helper, but the actual bug was that `routeReviewLane` never
// CALLED any merge — so a revert of the one-line wiring change would leave every
// helper test green. These rows exercise the real CLI end-to-end: install a
// global-scope `role:"reviewer"` overlay (global scope is trusted without a
// consent record, CONTEXT.md capability-loader predicate), then assert
// `review-lane sections|flags|plan` actually see it through loadRegistry →
// mergeReviewerLanes → the lane map. This is acceptance criteria #1–#3.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { runGsdTools, cleanup } = require('./helpers.cjs');

const cliTmps = [];
function cliTmpDir(prefix) {
  const d = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
  cliTmps.push(d);
  return d;
}
test.after(() => { for (const d of cliTmps) cleanup(d); });

/** A GSD_HOME-sandboxed env that neutralizes ambient GSD_ vars (hermeticity). */
function scopeEnv(home) {
  return { GSD_HOME: home, GSD_WORKSTREAM: '', GSD_PROJECT: '' };
}

/** A cwd with a .planning/ root so findProjectRoot resolves cleanly. */
function makeCwd() {
  const cwd = cliTmpDir('rev2927-cwd-');
  fs.mkdirSync(nodePath.join(cwd, '.planning'), { recursive: true });
  fs.writeFileSync(nodePath.join(cwd, '.planning', 'config.json'), '{}');
  return cwd;
}

/**
 * Write a conformant `role:"reviewer"` capability source dir whose `reviewer`
 * body is a valid SpawnLane (ADR-2782 D1 shape). Returns the source path,
 * usable as a `capability install <spec>` argument.
 */
function writeReviewerCapSource(id, bodyOverrides = {}) {
  const src = cliTmpDir(`rev2927-src-${id}-`);
  // A `role:"reviewer"` manifest carries ONLY id/role/version/title/description/
  // tier/requires/engines/reviewer (+ optional config) — skills/agents/steps/
  // contributions/gates/hooks/runtimeCompat are feature-only fields the validator
  // rejects for a reviewer (mirrors the shipped `capabilities/lm-studio` shape).
  const cap = {
    id,
    role: 'reviewer',
    version: '1.0.0',
    title: `${id} test lane`,
    description: 'test third-party reviewer lane for #2927',
    tier: 'standard',
    requires: [],
    engines: { gsd: '>=1.9.0' },
    reviewer: {
      slug: id,
      flags: [`--${id}`],
      transport: 'spawn',
      probe: { kind: 'command-exists', binary: id },
      invoke: {
        binary: id,
        args: ['{{model}}', '-p', '{{prompt}}'],
        promptChannel: 'stdin',
        outputChannel: 'stdout',
        modelArg: '--model',
        effortChannel: 'none',
      },
      timeoutFloorMs: 600000,
      emptyOutput: 'stub-with-stderr',
      reviewsSection: `${id} review`,
      evidenceClass: 'source-grounded',
      requiresBinaries: [],
      promptBudgetKey: null,
      modelConfigKey: `review.models.${id}`,
      handler: null,
      ...bodyOverrides,
    },
  };
  fs.writeFileSync(nodePath.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
  return src;
}

describe('review-lane CLI overlay invocation (#2927, rows 9–10)', () => {
  test('cliSectionsAndPlanSeeOverlayLane', () => {
    // Acceptance #1 + #3: an installed overlay lane appears in `sections` and
    // `plan --selected <slug>` returns ok:true with a usable plan.
    const home = cliTmpDir('rev2927-home-');
    const cwd = makeCwd();
    const src = writeReviewerCapSource('rev2927lane');
    // Global scope is trusted without a consent record; --yes acknowledges the
    // executable reviewer surface; --raw emits JSON.
    const install = runGsdTools(
      ['capability', 'install', src, '--scope', 'global', '--yes', '--raw'],
      cwd,
      scopeEnv(home),
    );
    assert.equal(install.success, true, `install failed: ${install.error || install.output}`);
    const installOut = JSON.parse(install.output);
    assert.equal(installOut.status, 'installed', `install did not report installed: ${install.output}`);

    // Row 9 / acceptance #1: sections includes the overlay slug + reviewsSection.
    const sections = runGsdTools(['review-lane', 'sections'], cwd, scopeEnv(home));
    assert.equal(sections.success, true, `sections failed: ${sections.error || sections.output}`);
    const sectionRows = sections.output.split('\n').filter(Boolean);
    const overlayRow = sectionRows.find((r) => r.startsWith('rev2927lane\t'));
    assert.ok(overlayRow, `overlay lane missing from sections output:\n${sections.output}`);
    assert.equal(overlayRow, 'rev2927lane\trev2927lane review');

    // Row 9 / acceptance #3: plan --selected <overlay-slug> resolves ok (NOT
    // malformed_lane / no such declared lane — the pre-fix failure). The `plan`
    // subcommand renders an ARRAY of {slug, ok, section, transport, ...} (it strips
    // the nested invocation `plan` object before output), so find the overlay entry.
    const plan = runGsdTools(
      ['review-lane', 'plan', '--selected', 'rev2927lane', '--run-dir', cwd, '--repo-root', cwd],
      cwd,
      scopeEnv(home),
    );
    assert.equal(plan.success, true, `plan failed: ${plan.error || plan.output}`);
    const planOut = JSON.parse(plan.output);
    assert.ok(Array.isArray(planOut), `plan output is not an array:\n${plan.output}`);
    const overlayPlan = planOut.find((p) => p.slug === 'rev2927lane');
    assert.ok(overlayPlan, `overlay plan entry missing:\n${plan.output}`);
    assert.equal(overlayPlan.ok, true, `overlay plan did not resolve ok:\n${plan.output}`);
    assert.equal(overlayPlan.section, 'rev2927lane review');
    assert.equal(overlayPlan.transport, 'spawn');
  });

  test('cliFlagsIncludeOverlayFlag', () => {
    // Acceptance #2: the overlay's declared --flag appears in `flags` output.
    //
    // NOTE on the negative-space "malformed flag filtered" case: the capability
    // validator enforces the /^--[a-z0-9][a-z0-9-]*$/ flag grammar AT INSTALL TIME
    // (capability-validator rejects a reviewer.flags entry that fails it), so a lane
    // carrying a malformed flag (e.g. `--bad flag`, `*.js`) can never be installed
    // and therefore never reaches the `flags` shape filter. That filter is
    // defense-in-depth over an input class the validator already excludes; it is
    // not independently reachable through a validated install, so it is not asserted
    // here. A lane declaring two well-formed flags (mirroring antigravity's
    // --antigravity/--agy) proves the per-lane flag array is preserved, not flattened.
    const home = cliTmpDir('rev2927-home-');
    const cwd = makeCwd();
    const src = writeReviewerCapSource('rev2927flag', {
      flags: ['--rev2927flag', '--rev2927alt'],
    });
    const install = runGsdTools(
      ['capability', 'install', src, '--scope', 'global', '--yes', '--raw'],
      cwd,
      scopeEnv(home),
    );
    assert.equal(install.success, true, `install failed: ${install.error || install.output}`);
    assert.equal(JSON.parse(install.output).status, 'installed', `install did not report installed: ${install.output}`);

    const flags = runGsdTools(['review-lane', 'flags'], cwd, scopeEnv(home));
    assert.equal(flags.success, true, `flags failed: ${flags.error || flags.output}`);
    const flagLines = flags.output.split('\n').filter(Boolean);
    assert.ok(flagLines.includes('--rev2927flag'), `overlay flag missing from flags output:\n${flags.output}`);
    assert.ok(flagLines.includes('--rev2927alt'), 'second well-formed overlay flag missing (flag array flattened?)');
  });
});
  });
}

describe('#4255 — every lane declares where its review effort comes from', () => {
  // The two fields exist so a lane's effort is DATA about the lane, resolvable without asking any
  // agent for its execution settings. These rows pin the declaration itself: a new lane that adds
  // an argv effort channel without saying what effort to run at would otherwise silently inherit
  // whatever the resolver's fallback happens to be — the exact shape of the original bug.
  test('a lane with an argv effort channel declares BOTH a config key and a default', () => {
    for (const lane of REVIEWER_LANES) {
      if (lane.invoke.effortChannel !== 'argv') continue;
      assert.equal(typeof lane.effortConfigKey, 'string',
        `${lane.slug} renders an effort argument but declares no effortConfigKey`);
      assert.equal(lane.effortConfigKey, `review.effort.${lane.slug}`,
        `${lane.slug}: the key is read from config by this exact name`);
      assert.equal(typeof lane.defaultEffort, 'string',
        `${lane.slug} renders an effort argument but declares no review default`);
    }
  });

  test('a lane with no effort channel declares neither', () => {
    for (const lane of REVIEWER_LANES) {
      if (lane.invoke.effortChannel === 'argv') continue;
      assert.equal(lane.effortConfigKey, null, `${lane.slug} has no channel to feed`);
      assert.equal(lane.defaultEffort, null, `${lane.slug} has no channel to feed`);
    }
  });

  test('the prompt-fed, source-grounded lanes default no lower than high', () => {
    // These lanes read the repository against a plan set. Effort is load-bearing exactly here:
    // it is where a large prompt at a low level ends the turn with no final message.
    const RANK = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    for (const lane of REVIEWER_LANES) {
      if (lane.defaultEffort === null) continue;
      assert.equal(lane.evidenceClass, 'source-grounded', `${lane.slug}: unexpected class for a default`);
      assert.ok(RANK.indexOf(lane.defaultEffort) >= RANK.indexOf('high'),
        `${lane.slug} defaults to ${lane.defaultEffort}, below the review floor`);
    }
  });

  test('no declared default is the `inherit` sentinel — that is what a null key means', () => {
    // `inherit` is a legitimate CONFIGURED value (it selects "emit nothing"), but as a declared
    // default it would be a second spelling for `null` and split one behaviour across two shapes.
    for (const lane of REVIEWER_LANES) {
      assert.notEqual(lane.defaultEffort, 'inherit', `${lane.slug}: use null, not 'inherit'`);
    }
  });
});

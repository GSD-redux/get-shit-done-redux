'use strict';

/**
 * emitted-caps.test.cjs — the per-runtime emitted-byte cap decision
 * (issue #2931, epic #1671, Phase 4). Exercises `tests/helpers/emitted-caps.cjs`
 * per `.gsd/phase/chore-2931-emitted-byte-caps/50-test-matrix.md` section A.
 *
 * Assertion discipline: every check compares typed structured values
 * (`REASON` enum members, numeric fields) — never rendered prose
 * (CONTRIBUTING.md, "Prohibited: Raw Text Matching on Test Outputs").
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { REASON, EMITTED_CAPS, evaluateEmittedCaps } = require('./helpers/emitted-caps.cjs');

const WINDSURF_PATTERN = 'workflows/*.md';
const WINDSURF_CAP = 12000;

// ─── A1-A8: happy path + boundaries + independence ───────────────────────────

test('passesRuntimeWithNoDeclaredCap', () => {
  // `windsurf` must also report SOME sizes here: EMITTED_CAPS declares a
  // windsurf cap, and a runtime the cap table names but `sizes` never
  // mentions is REASON.UNKNOWN_RUNTIME (a distinct, more specific error —
  // see A10/`errorsOnCapRuleForUnknownRuntime`), not the "no declared cap"
  // path this test targets. Giving windsurf a compliant artifact keeps that
  // orthogonal path out of this fixture while still proving `claude` (which
  // truly has no cap entry) is recorded unmeasured and passes.
  const r = evaluateEmittedCaps({
    sizes: {
      claude: { 'workflows/plan-phase.md': 999999 },
      windsurf: { 'workflows/satisfies-the-rule.md': 100 },
    },
    capTable: EMITTED_CAPS,
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.violations.length, 0);
  assert.equal(r.unmeasured.length, 1);
  assert.equal(r.unmeasured[0].runtime, 'claude');
  assert.equal(r.compliant.length, 1);
  assert.equal(r.compliant[0].runtime, 'windsurf');
  assert.ok(r.ok);
});

test('passesArtifactUnderCap', () => {
  const r = evaluateEmittedCaps({
    sizes: { windsurf: { 'workflows/a.md': 100 } },
  });
  assert.equal(r.violations.length, 0);
  assert.equal(r.compliant.length, 1);
  assert.equal(r.compliant[0].bytes, 100);
  assert.equal(r.compliant[0].cap, WINDSURF_CAP);
  assert.ok(r.ok);
});

test('passesAtCapMinusOne', () => {
  const r = evaluateEmittedCaps({ sizes: { windsurf: { 'workflows/a.md': WINDSURF_CAP - 1 } } });
  assert.equal(r.violations.length, 0);
  assert.equal(r.compliant.length, 1);
  assert.ok(r.ok);
});

test('passesAtExactlyCap', () => {
  const r = evaluateEmittedCaps({ sizes: { windsurf: { 'workflows/a.md': WINDSURF_CAP } } });
  assert.equal(r.violations.length, 0, 'inclusive <= means the cap itself passes');
  assert.equal(r.compliant.length, 1);
  assert.equal(r.compliant[0].bytes, WINDSURF_CAP);
  assert.ok(r.ok);
});

test('failsAtCapPlusOne', () => {
  const r = evaluateEmittedCaps({ sizes: { windsurf: { 'workflows/a.md': WINDSURF_CAP + 1 } } });
  assert.equal(r.compliant.length, 0);
  assert.equal(r.violations.length, 1);
  const v = r.violations[0];
  assert.equal(v.runtime, 'windsurf');
  assert.equal(v.rel, 'workflows/a.md');
  assert.equal(v.bytes, WINDSURF_CAP + 1);
  assert.equal(v.cap, WINDSURF_CAP);
  assert.equal(v.delta, 1);
  assert.equal(v.reason, REASON.CAP_EXCEEDED);
  assert.ok(!r.ok);
});

test('passesZeroByteArtifact', () => {
  const r = evaluateEmittedCaps({ sizes: { windsurf: { 'workflows/empty.md': 0 } } });
  assert.equal(r.violations.length, 0, 'empty is not oversize');
  assert.equal(r.compliant.length, 1);
  assert.equal(r.compliant[0].bytes, 0);
  assert.ok(r.ok);
});

test('ignoresPathMatchingNoCapRule', () => {
  // The sole windsurf rule (`workflows/*.md`) must ALSO match something in
  // this fixture, or it is a dead rule across the whole run (A13/A14 — a
  // deliberate hard error, see `errorsOnDeadCapRuleMatchingNothing`) and
  // this test would be asserting two different failure modes at once. Give
  // it a compliant match so the ONLY thing under test is: a path the rule
  // doesn't match is ignored (unmeasured), not that the rule is dead.
  const r = evaluateEmittedCaps({
    sizes: {
      windsurf: {
        'skills/gsd-add-tests/SKILL.md': 999999,
        'workflows/satisfies-the-rule.md': 100,
      },
    },
  });
  assert.equal(r.violations.length, 0);
  assert.equal(r.unmeasured.length, 1);
  assert.equal(r.unmeasured[0].rel, 'skills/gsd-add-tests/SKILL.md');
  assert.equal(r.compliant.length, 1);
  assert.equal(r.deadRules.length, 0);
  assert.ok(r.ok);
});

test('failsOnlyOffendingRuntimeForSharedRelPath', () => {
  const capTable = {
    windsurf: [{ pattern: WINDSURF_PATTERN, maxBytes: 100, note: 'test' }],
    otherRuntime: [{ pattern: WINDSURF_PATTERN, maxBytes: 100, note: 'test' }],
  };
  const r = evaluateEmittedCaps({
    sizes: {
      windsurf: { 'workflows/shared.md': 200 }, // over
      otherRuntime: { 'workflows/shared.md': 50 }, // under
    },
    capTable,
  });
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].runtime, 'windsurf');
  assert.equal(r.compliant.length, 1);
  assert.equal(r.compliant[0].runtime, 'otherRuntime');
  assert.ok(!r.ok);
});

// ─── A9-A20: negative / hostile ──────────────────────────────────────────────

test('errorsOnDeadCapRuleMatchingNothing', () => {
  const capTable = { windsurf: [{ pattern: WINDSURF_PATTERN, maxBytes: WINDSURF_CAP, note: 'x' }] };
  const r = evaluateEmittedCaps({
    sizes: { windsurf: { 'skills/other.md': 10 } }, // never matches the workflows/*.md rule
    capTable,
  });
  assert.equal(r.deadRules.length, 1);
  assert.equal(r.deadRules[0].runtime, 'windsurf');
  assert.equal(r.deadRules[0].pattern, WINDSURF_PATTERN);
  assert.equal(r.deadRules[0].reason, REASON.DEAD_RULE);
  assert.ok(!r.ok, 'a cap guarding nothing is a hard error');
});

test('errorsOnCapRuleForUnknownRuntime', () => {
  const capTable = { 'ghost-runtime': [{ pattern: '*.md', maxBytes: 100, note: 'x' }] };
  const r = evaluateEmittedCaps({
    sizes: { claude: { 'a.md': 10 } },
    capTable,
  });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].reason, REASON.UNKNOWN_RUNTIME);
  assert.equal(r.errors[0].runtime, 'ghost-runtime');
  assert.ok(!r.ok);
});

test('errorsWhenRuntimeProducedNoArtifacts', () => {
  const r = evaluateEmittedCaps({ sizes: { windsurf: {} } });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].reason, REASON.NO_ARTIFACTS);
  assert.equal(r.errors[0].runtime, 'windsurf');
  assert.ok(!r.ok, 'never read "nothing to check" as "pass"');
});

test('errorsOnMissingSizesMap', () => {
  for (const bad of [null, undefined]) {
    const r = evaluateEmittedCaps({ sizes: bad });
    assert.equal(r.errors.length, 1, `${bad} must be rejected`);
    assert.equal(r.errors[0].reason, REASON.INVALID_SIZES);
    assert.ok(!r.ok);
  }
});

test('errorsOnNonObjectSizesMap', () => {
  for (const bad of [0, 'str', [], true]) {
    const r = evaluateEmittedCaps({ sizes: bad });
    assert.equal(r.errors.length, 1, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(r.errors[0].reason, REASON.INVALID_SIZES);
    assert.equal(r.errors[0].receivedType, Array.isArray(bad) ? 'array' : typeof bad);
    assert.ok(!r.ok);
  }
});

test('errorsOnNonObjectCapTable', () => {
  for (const bad of [null, [], 0, 'str']) {
    const r = evaluateEmittedCaps({ sizes: { windsurf: { 'a.md': 1 } }, capTable: bad });
    assert.equal(r.errors.length, 1, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(r.errors[0].reason, REASON.INVALID_CAP_TABLE);
    assert.ok(!r.ok);
  }
});

test('treatsZeroCapAsAlwaysViolating', () => {
  const capTable = { windsurf: [{ pattern: WINDSURF_PATTERN, maxBytes: 0, note: 'zero cap' }] };
  const violating = evaluateEmittedCaps({ sizes: { windsurf: { 'workflows/a.md': 1 } }, capTable });
  assert.equal(violating.violations.length, 1);
  assert.equal(violating.violations[0].cap, 0);
  assert.equal(violating.violations[0].delta, 1);
  assert.equal(violating.errors.length, 0, 'maxBytes: 0 is a LEGAL table entry');

  const stillPasses = evaluateEmittedCaps({ sizes: { windsurf: { 'workflows/a.md': 0 } }, capTable });
  assert.equal(stillPasses.violations.length, 0, 'a genuinely empty artifact still passes a zero cap');
  assert.equal(stillPasses.compliant.length, 1);
});

test('errorsOnNonPositiveIntegerCap', () => {
  for (const bad of [-1, NaN, Infinity, 1.5]) {
    const capTable = { windsurf: [{ pattern: WINDSURF_PATTERN, maxBytes: bad, note: 'x' }] };
    const r = evaluateEmittedCaps({ sizes: { windsurf: { 'skills/unrelated.md': 5 } }, capTable });
    const err = r.errors.find((e) => e.reason === REASON.INVALID_CAP_VALUE);
    assert.ok(err, `${bad} must be rejected at table validation`);
    assert.ok(
      Number.isNaN(bad) ? Number.isNaN(err.value) : err.value === bad,
      'the raw offending value must be surfaced',
    );
    assert.equal(r.deadRules.length, 0, 'an invalid rule must never also be reported as merely dead');
    assert.ok(!r.ok);
  }
});

test('errorsOnStringCapValue', () => {
  const capTable = { windsurf: [{ pattern: WINDSURF_PATTERN, maxBytes: '12000', note: 'x' }] };
  const r = evaluateEmittedCaps({ sizes: { windsurf: { 'workflows/a.md': 5 } }, capTable });
  const err = r.errors.find((e) => e.reason === REASON.INVALID_CAP_VALUE);
  assert.ok(err);
  assert.equal(err.value, '12000');
  assert.equal(typeof err.value, 'string', 'no implicit coercion — the raw string is surfaced, not 12000');
  assert.ok(!r.ok);
});

test('rejectsReservedKeysInSizesMap', () => {
  // Genuine OWN properties named __proto__/constructor/prototype, built the
  // way a real ingest (JSON.parse) would — not the object-literal special
  // case that would set the prototype instead of a key.
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const topLevel = JSON.parse(JSON.stringify({ [key]: { 'a.md': 10 } }));
    const runtimeLevel = JSON.parse(JSON.stringify({ windsurf: { [key]: 10 } }));

    const rTop = evaluateEmittedCaps({ sizes: topLevel, capTable: {} });
    const topErr = rTop.errors.find((e) => e.reason === REASON.RESERVED_KEY && e.scope === 'sizes-runtime');
    assert.ok(topErr, `${key} as a runtime key must be rejected loudly`);
    assert.equal(topErr.key, key);
    assert.ok(!rTop.ok);

    const rRel = evaluateEmittedCaps({ sizes: runtimeLevel, capTable: {} });
    const relErr = rRel.errors.find((e) => e.reason === REASON.RESERVED_KEY && e.scope === 'sizes-rel');
    assert.ok(relErr, `${key} as a rel key must be rejected loudly`);
    assert.equal(relErr.key, key);
    assert.equal(relErr.runtime, 'windsurf');
    assert.ok(!rRel.ok);
  }

  // The brief's "in either map" also covers capTable's runtime keys. Must use
  // the COMPUTED key form (`{ ['__proto__']: ... }`), matching the genuine
  // OWN-property construction above: the literal object-initializer form
  // `{ __proto__: ... }` is special-cased by the language to set the
  // object's [[Prototype]] instead of creating an own property, so it would
  // produce an object with ZERO own keys (nothing for JSON.stringify to
  // serialize, and nothing for Object.keys(capTable) to ever see) — testing
  // nothing at all rather than the hostile-key case this asserts on.
  const capTableWithReservedRuntime = JSON.parse(
    JSON.stringify({ ['__proto__']: [{ pattern: '*.md', maxBytes: 10, note: 'x' }] }),
  );
  const rCapTable = evaluateEmittedCaps({ sizes: { windsurf: { 'a.md': 1 } }, capTable: capTableWithReservedRuntime });
  const capErr = rCapTable.errors.find((e) => e.reason === REASON.RESERVED_KEY && e.scope === 'capTable-runtime');
  assert.ok(capErr, '__proto__ as a capTable runtime key must be rejected loudly');
  assert.equal(capErr.key, '__proto__');
  assert.ok(!rCapTable.ok);
});

test('rejectsTraversalInCapPattern', () => {
  for (const pattern of ['../workflows/*.md', '/workflows/*.md']) {
    const capTable = { windsurf: [{ pattern, maxBytes: WINDSURF_CAP, note: 'x' }] };
    const r = evaluateEmittedCaps({ sizes: { windsurf: { 'workflows/a.md': 5 } }, capTable });
    const err = r.errors.find((e) => e.reason === REASON.UNSAFE_PATTERN);
    assert.ok(err, `"${pattern}" must be rejected`);
    assert.equal(err.pattern, pattern);
    assert.ok(!r.ok);
  }
});

test('errorsOnRuntimeWithEmptyArtifactSet', () => {
  const r = evaluateEmittedCaps({
    sizes: { windsurf: {}, claude: { 'foo.md': 5 } },
  });
  const err = r.errors.find((e) => e.reason === REASON.NO_ARTIFACTS);
  assert.ok(err, 'must not be excused just because another runtime has real content');
  assert.equal(err.runtime, 'windsurf');
  assert.equal(r.unmeasured.length, 1, 'the other runtime is still processed normally');
  assert.equal(r.unmeasured[0].runtime, 'claude');
  assert.ok(!r.ok);
});

// ─── A21-A23: shipping shape, idempotence, determinism ───────────────────────

test('usesShippingCallerShapeWithNoOptions', () => {
  const sizes = { windsurf: { 'workflows/a.md': 100 } };
  const withNoOptions = evaluateEmittedCaps({ sizes });
  const withExplicitDefault = evaluateEmittedCaps({ sizes, capTable: EMITTED_CAPS });
  assert.deepEqual(withNoOptions, withExplicitDefault);
});

test('isIdempotentAcrossRepeatedEvaluation', () => {
  const sizes = { windsurf: { 'workflows/a.md': WINDSURF_CAP + 1 }, claude: { 'x.md': 5 } };
  const capTable = { windsurf: [{ pattern: WINDSURF_PATTERN, maxBytes: WINDSURF_CAP, note: 'x' }] };
  const sizesBefore = JSON.stringify(sizes);
  const capTableBefore = JSON.stringify(capTable);

  const r1 = evaluateEmittedCaps({ sizes, capTable });
  const r2 = evaluateEmittedCaps({ sizes, capTable });

  assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify(sizes), sizesBefore, 'sizes must not be mutated');
  assert.equal(JSON.stringify(capTable), capTableBefore, 'capTable must not be mutated');
});

test('returnsViolationsInStableSortedOrder', () => {
  const capTable = {
    zeta: [{ pattern: '*.md', maxBytes: 1, note: 'x' }],
    alpha: [{ pattern: '*.md', maxBytes: 1, note: 'x' }],
  };
  // Inserted deliberately out of sorted order so the assertion bites.
  const r = evaluateEmittedCaps({
    sizes: { zeta: { 'z.md': 99 }, alpha: { 'a.md': 99 } },
    capTable,
  });
  assert.equal(r.violations.length, 2);
  assert.deepEqual(r.violations.map((v) => v.runtime), ['alpha', 'zeta']);
});

// ─── A24-A25: fast-check property tests ──────────────────────────────────────

test('propertyUnderCapNeverViolates', () => {
  fc.assert(
    fc.property(
      fc.nat({ max: 50000 }),
      fc.nat({ max: 50000 }),
      (bytes, maxBytes) => {
        const capTable = { windsurf: [{ pattern: 'workflows/probe.md', maxBytes, note: 'x' }] };
        const r = evaluateEmittedCaps({ sizes: { windsurf: { 'workflows/probe.md': bytes } }, capTable });
        assert.equal(r.errors.length, 0);
        for (const v of r.violations) {
          assert.ok(v.bytes > v.cap, 'no artifact <= its cap may ever appear in violations');
        }
        if (bytes <= maxBytes) {
          assert.equal(r.violations.length, 0);
          assert.equal(r.compliant.length, 1);
        } else {
          assert.equal(r.violations.length, 1);
          assert.equal(r.compliant.length, 0);
        }
      },
    ),
  );
});

test('propertyEveryArtifactLandsInExactlyOneBucket', () => {
  const runtimeArb = fc.constantFrom('windsurf', 'cursor', 'claude', 'trae', 'roo');
  const relArb = fc
    .tuple(
      fc.constantFrom('workflows', 'agents', 'skills', 'commands'),
      fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'epsilon'),
      fc.constantFrom('md', 'yaml', 'toml'),
    )
    .map(([dir, name, ext]) => `${dir}/${name}.${ext}`);

  fc.assert(
    fc.property(
      fc.array(
        fc.record({ runtime: runtimeArb, rel: relArb, bytes: fc.nat({ max: 20000 }) }),
        { minLength: 0, maxLength: 25 },
      ),
      fc.array(
        fc.record({
          runtime: runtimeArb,
          patternKind: fc.constantFrom('exact', 'wildcard'),
          dir: fc.constantFrom('workflows', 'agents', 'skills', 'commands'),
          maxBytes: fc.nat({ max: 20000 }),
        }),
        { minLength: 0, maxLength: 8 },
      ),
      (entries, ruleSpecs) => {
        const sizes = {};
        const expectedKeys = new Set();
        for (const { runtime, rel, bytes } of entries) {
          sizes[runtime] = sizes[runtime] || {};
          sizes[runtime][rel] = bytes;
          expectedKeys.add(`${runtime}::${rel}`);
        }
        // Every runtime named in sizes must have at least one artifact, or
        // evaluateEmittedCaps correctly reports NO_ARTIFACTS instead of
        // conserving it — filtered out here since the property is about the
        // WELL-FORMED subset (see the module's conservation-law comment).
        for (const runtime of Object.keys(sizes)) {
          if (Object.keys(sizes[runtime]).length === 0) delete sizes[runtime];
        }
        fc.pre(Object.keys(sizes).length > 0); // nothing to conserve this run

        const capTable = {};
        for (const { runtime, patternKind, dir, maxBytes } of ruleSpecs) {
          capTable[runtime] = capTable[runtime] || [];
          const pattern = patternKind === 'exact' ? `${dir}/fixed.md` : `${dir}/*.md`;
          capTable[runtime].push({ pattern, maxBytes, note: 'property' });
        }
        // Only reference runtimes that are actually present in sizes, so this
        // run never trips UNKNOWN_RUNTIME noise unrelated to the conservation
        // law under test.
        for (const runtime of Object.keys(capTable)) {
          if (!Object.prototype.hasOwnProperty.call(sizes, runtime)) delete capTable[runtime];
        }

        const r = evaluateEmittedCaps({ sizes, capTable });

        const seen = new Set();
        for (const bucket of [r.violations, r.unmeasured, r.compliant]) {
          for (const rec of bucket) {
            const key = `${rec.runtime}::${rec.rel}`;
            assert.ok(!seen.has(key), `${key} appeared in more than one bucket`);
            seen.add(key);
          }
        }
        assert.deepEqual([...seen].sort(), [...expectedKeys].sort());
      },
    ),
  );
});

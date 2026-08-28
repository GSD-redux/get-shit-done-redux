'use strict';

/**
 * tests/lint-seam-enforcement.test.cjs
 *
 * Regression net for scripts/lint-seam-enforcement.cjs (#3626). Drives the
 * guard's pure `extractSeamFacts`/`parseEnforcementPointer`/`checkSeamFacts`/
 * `readRegisteredRuleNames` exports directly with synthetic fixtures and
 * injected fakes, so this test never depends on eslint.config.mjs or CONTEXT.md
 * shape churn — plus a final "real repo" integration block.
 *
 * Design:      .gsd/phase/feat-3626-context-seam-claim-gate/40-design.md
 * Test matrix: .gsd/phase/feat-3626-context-seam-claim-gate/50-test-matrix.md
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  extractSeamFacts,
  parseEnforcementPointer,
  checkSeamFacts,
  readRegisteredRuleNames,
} = require('../scripts/lint-seam-enforcement.cjs');

describe('lint-seam-enforcement: extractSeamFacts', () => {
  test('captures a backtick-wrapped owns/enforced-by pair', () => {
    const text = [
      'Some prose.',
      '`SEAM.foo.owns=bar`',
      '`SEAM.foo.enforced-by=test:tests/x.test.cjs`',
      'More prose.',
    ].join('\n');

    const { owns, enforcedBy } = extractSeamFacts(text);
    assert.equal(owns.get('foo'), 'bar');
    assert.equal(enforcedBy.get('foo'), 'test:tests/x.test.cjs');
  });

  test('row 13: an unrelated <NAME>.SEAM.<subkey>= line is NOT captured (anchored regex, not <id>.owns|enforced-by)', () => {
    const text = '`WORKTREE.SEAM.files=[gsd-core/bin/lib/worktree-safety.cjs]`';
    const { owns, enforcedBy } = extractSeamFacts(text);
    assert.equal(owns.size, 0);
    assert.equal(enforcedBy.size, 0);
  });
});

describe('lint-seam-enforcement: parseEnforcementPointer', () => {
  test('lint-rule: scheme', () => {
    assert.deepEqual(parseEnforcementPointer('lint-rule:no-source-grep'), {
      scheme: 'lint-rule',
      target: 'no-source-grep',
    });
  });

  test('test: scheme', () => {
    assert.deepEqual(parseEnforcementPointer('test:tests/foo.test.cjs'), {
      scheme: 'test',
      target: 'tests/foo.test.cjs',
    });
  });

  test('unrecognized scheme falls back to null scheme with the raw value as target', () => {
    assert.deepEqual(parseEnforcementPointer('bogus-scheme:x'), {
      scheme: null,
      target: 'bogus-scheme:x',
    });
  });
});

describe('lint-seam-enforcement: checkSeamFacts', () => {
  test('row 1: owns + enforced-by=lint-rule:<name> where the rule is registered and its source exists — no findings', () => {
    const owns = new Map([['foo', 'bar']]);
    const enforcedBy = new Map([['foo', 'lint-rule:no-source-grep']]);
    const deps = {
      ruleIsRegistered: () => true,
      ruleFileExists: () => true,
      testFileExists: () => false,
    };
    assert.deepEqual(checkSeamFacts({ owns, enforcedBy }, deps), []);
  });

  test('row 2: owns + enforced-by=test:<path> where the file exists — no findings', () => {
    const owns = new Map([['foo', 'bar']]);
    const enforcedBy = new Map([['foo', 'test:tests/foo.test.cjs']]);
    const deps = {
      ruleIsRegistered: () => false,
      ruleFileExists: () => false,
      testFileExists: () => true,
    };
    assert.deepEqual(checkSeamFacts({ owns, enforcedBy }, deps), []);
  });

  test('row 4: owns with no matching enforced-by — THE FIXTURE THAT PROVES THE GATE CAN FAIL (drift-guard-prove-it-can-fail convention)', () => {
    const owns = new Map([['foo', 'bar']]);
    const enforcedBy = new Map();
    const deps = { ruleIsRegistered: () => true, ruleFileExists: () => true, testFileExists: () => true };

    const findings = checkSeamFacts({ owns, enforcedBy }, deps);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /SEAM\.foo/);
    assert.match(findings[0], /no enforcement pointer/);
  });

  test('row 5: enforced-by=lint-rule:<name> where the name is not registered — dangling lint-rule pointer', () => {
    const owns = new Map([['foo', 'bar']]);
    const enforcedBy = new Map([['foo', 'lint-rule:nope']]);
    const deps = { ruleIsRegistered: () => false, ruleFileExists: () => true, testFileExists: () => true };

    const findings = checkSeamFacts({ owns, enforcedBy }, deps);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /dangling lint-rule pointer/);
  });

  test('row 6: enforced-by=lint-rule:<name> registered but its source file is missing — registered rule has no source file', () => {
    const owns = new Map([['foo', 'bar']]);
    const enforcedBy = new Map([['foo', 'lint-rule:ghost']]);
    const deps = { ruleIsRegistered: () => true, ruleFileExists: () => false, testFileExists: () => true };

    const findings = checkSeamFacts({ owns, enforcedBy }, deps);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /registered rule has no source file/);
  });

  test('row 7: enforced-by=test:<path> where the path does not exist — dangling test-anchor pointer', () => {
    const owns = new Map([['foo', 'bar']]);
    const enforcedBy = new Map([['foo', 'test:tests/nope.test.cjs']]);
    const deps = { ruleIsRegistered: () => true, ruleFileExists: () => true, testFileExists: () => false };

    const findings = checkSeamFacts({ owns, enforcedBy }, deps);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /dangling test-anchor pointer/);
  });

  test('row 8: enforced-by with an unrecognized scheme prefix — unrecognized enforcement-pointer scheme', () => {
    const owns = new Map([['foo', 'bar']]);
    const enforcedBy = new Map([['foo', 'weird:thing']]);
    const deps = { ruleIsRegistered: () => true, ruleFileExists: () => true, testFileExists: () => true };

    const findings = checkSeamFacts({ owns, enforcedBy }, deps);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /unrecognized enforcement-pointer scheme/);
  });

  test('row 9: enforced-by with no matching owns (stale/renamed id) — enforcement pointer with no ownership claim', () => {
    const owns = new Map();
    const enforcedBy = new Map([['foo', 'lint-rule:no-source-grep']]);
    const deps = { ruleIsRegistered: () => true, ruleFileExists: () => true, testFileExists: () => true };

    const findings = checkSeamFacts({ owns, enforcedBy }, deps);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /enforcement pointer with no ownership claim/);
  });

  test('row 10 (checkSeamFacts-level zero case): empty owns/enforcedBy maps — no findings', () => {
    // The CLI-level "explicit zero notice" (row 10's full behavior) is emitted
    // via process.stdout.write in main() — CLI/process stdout is not
    // unit-tested in this style elsewhere in the repo (see
    // mutation-test-derivation-drift.test.cjs), so only the checkSeamFacts
    // return value (empty findings on empty input) is asserted here.
    assert.deepEqual(checkSeamFacts({ owns: new Map(), enforcedBy: new Map() }, {
      ruleIsRegistered: () => true,
      ruleFileExists: () => true,
      testFileExists: () => true,
    }), []);
  });

  test('row 11 (boundary, limit=1): exactly one valid claim — no findings', () => {
    const owns = new Map([['foo', 'bar']]);
    const enforcedBy = new Map([['foo', 'test:tests/foo.test.cjs']]);
    const deps = { ruleIsRegistered: () => true, ruleFileExists: () => true, testFileExists: () => true };
    assert.deepEqual(checkSeamFacts({ owns, enforcedBy }, deps), []);
  });

  test('row 11 (boundary, limit=1): exactly one INVALID (dangling) claim — findings array of length exactly 1', () => {
    const owns = new Map([['foo', 'bar']]);
    const enforcedBy = new Map([['foo', 'test:tests/nope.test.cjs']]);
    const deps = { ruleIsRegistered: () => true, ruleFileExists: () => true, testFileExists: () => false };
    const findings = checkSeamFacts({ owns, enforcedBy }, deps);
    assert.equal(findings.length, 1);
  });

  test('row 12 (independence): two claims, one valid + one dangling — findings name ONLY the dangling id', () => {
    const owns = new Map([
      ['good', 'good-thing'],
      ['bad', 'bad-thing'],
    ]);
    const enforcedBy = new Map([
      ['good', 'test:tests/good.test.cjs'],
      ['bad', 'test:tests/bad.test.cjs'],
    ]);
    const deps = {
      ruleIsRegistered: () => true,
      ruleFileExists: () => true,
      testFileExists: (relPath) => relPath === 'tests/good.test.cjs',
    };

    const findings = checkSeamFacts({ owns, enforcedBy }, deps);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /SEAM\.bad/);
    assert.doesNotMatch(findings[0], /SEAM\.good/);
  });

  test('row 14 (hostile, resolves-only scope): a valid lint-rule pointer for an id whose owns prose is unrelated to the rule — still resolves, no content inference', () => {
    const owns = new Map([['totally-unrelated-capability', 'some prose describing an unrelated thing']]);
    const enforcedBy = new Map([['totally-unrelated-capability', 'lint-rule:no-source-grep']]);
    const deps = {
      ruleIsRegistered: (name) => name === 'no-source-grep',
      ruleFileExists: (name) => name === 'no-source-grep',
      testFileExists: () => false,
    };
    assert.deepEqual(checkSeamFacts({ owns, enforcedBy }, deps), []);
  });
});

describe('lint-seam-enforcement: readRegisteredRuleNames', () => {
  test('extracts rule names from a synthetic localPlugin.rules block', () => {
    const text = `
const localPlugin = {
  rules: {
    'no-source-grep': noSourceGrep,
    'no-private-binary-resolution': noPrivateBinaryResolution,
  },
};
`;
    const names = readRegisteredRuleNames(text);
    assert.ok(names instanceof Set);
    assert.ok(names.has('no-source-grep'));
    assert.ok(names.has('no-private-binary-resolution'));
  });
});

describe('lint-seam-enforcement: real repo has zero unresolved SEAM claims', () => {
  test('row 3: extractSeamFacts + checkSeamFacts against the real CONTEXT.md and eslint.config.mjs resolve cleanly', () => {
    // EXPECTED TO PASS VACUOUSLY RIGHT NOW: if CONTEXT.md currently has zero
    // SEAM.*.owns/enforced-by facts, extractSeamFacts returns empty maps and
    // checkSeamFacts on empty maps returns [] trivially. A later commit in
    // this same PR adds six real SEAM.*.owns/enforced-by facts (Shell Command
    // Projection Module, Verification Module, Phase Locator Module, Git Query
    // Module, capability-activation precedence engine, Worktree Safety Policy
    // Module) backed by real lint rules/tests; this test then starts
    // meaningfully exercising real data and proves they all resolve. It must
    // never assert findings.length > 0 — deepEqual([]) is correct both before
    // and after CONTEXT.md gains the six facts.
    const root = path.join(__dirname, '..');
    const contextText = fs.readFileSync(path.join(root, 'CONTEXT.md'), 'utf8');
    const eslintConfigText = fs.readFileSync(path.join(root, 'eslint.config.mjs'), 'utf8');

    const registeredRules = readRegisteredRuleNames(eslintConfigText);
    const facts = extractSeamFacts(contextText);

    const findings = checkSeamFacts(facts, {
      ruleIsRegistered: (name) => registeredRules.has(name),
      ruleFileExists: (name) => fs.existsSync(path.join(root, 'eslint-rules', `${name}.cjs`)),
      testFileExists: (relPath) => fs.existsSync(path.join(root, relPath)),
    });

    assert.deepEqual(findings, []);
  });
});

'use strict';

// allow-test-rule: source-text-is-the-product (#1190)
// Reads the shipped .github/workflows YAML — the deployed text GitHub
// Actions executes — as the security artifact under test.

/**
 * ADR-230 regression guard: PR target-branch policy.
 *
 * (A) Behavioral coverage of classifyPrTarget — every decision path, including
 *     boundary cases (wrong version format, partial prefix matches).
 *
 * (B) Equivalence oracle — the old inline decision logic from the workflow's
 *     github-script is embedded here verbatim as oracle(). Every (base, head)
 *     combo must produce the same decision from both the module and the oracle.
 *     This proves behavior-preservation across the refactor.
 *
 * (C) Structural assertions — pr-target-validator.yml must now check out the
 *     base ref (fork-tamper-safe) and require the policy module.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const POLICY_PATH = path.join(__dirname, '..', 'scripts', 'pr-target-policy.cjs');
const WORKFLOW_PATH = path.join(__dirname, '..', '.github', 'workflows', 'pr-target-validator.yml');

const { classifyPrTarget, MAIN_ALLOWED_PATTERNS } = require(POLICY_PATH);

// ---------------------------------------------------------------------------
// Oracle: verbatim inline logic from the original github-script in the workflow.
// This is intentionally NOT refactored — it is the canonical pre-refactor
// behavior against which the extracted module is checked.
// ---------------------------------------------------------------------------

/**
 * Oracle replicating the original inline decision logic.
 * Returns 'allowed' | 'blocked' | 'unusual' — same vocabulary as classifyPrTarget.
 *
 * @param {string} base
 * @param {string} head
 * @returns {'allowed'|'blocked'|'unusual'}
 */
function oracle(base, head) {
  if (base === 'next') {
    return 'allowed';
  }

  if (base === 'main') {
    const mainAllowed = [
      /^release\/\d+\.\d+\.0$/,           // release branches
      /^hotfix\/\d+\.\d+\.\d+$/,          // hotfix branches
      /^fix\/critical-/,                  // production-down emergencies
      /^chore\/backmerge-/,               // auto-backmerge from this workflow
      /^revert\/critical-/,               // emergency reverts
    ];
    const allowed = mainAllowed.some(re => re.test(head));
    return allowed ? 'allowed' : 'blocked';
  }

  if (/^release\/\d+\.\d+\.0$/.test(base) || /^hotfix\/\d+\.\d+\.\d+$/.test(base)) {
    return 'allowed';
  }

  return 'unusual';
}

// ---------------------------------------------------------------------------
// (A) Behavioral tests
// ---------------------------------------------------------------------------

describe('classifyPrTarget — allowed cases', () => {
  test('base=next, any head → allowed', () => {
    assert.deepStrictEqual(classifyPrTarget('next', 'feat/anything'), { decision: 'allowed' });
    assert.deepStrictEqual(classifyPrTarget('next', 'main'), { decision: 'allowed' });
    assert.deepStrictEqual(classifyPrTarget('next', ''), { decision: 'allowed' });
  });

  test('base=main, head=release/1.2.0 → allowed', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'release/1.2.0'), { decision: 'allowed' });
  });

  test('base=main, head=release/10.20.0 → allowed (multi-digit)', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'release/10.20.0'), { decision: 'allowed' });
  });

  test('base=main, head=hotfix/1.2.3 → allowed', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'hotfix/1.2.3'), { decision: 'allowed' });
  });

  test('base=main, head=hotfix/10.20.30 → allowed (multi-digit)', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'hotfix/10.20.30'), { decision: 'allowed' });
  });

  test('base=main, head=fix/critical-login → allowed', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'fix/critical-login'), { decision: 'allowed' });
  });

  test('base=main, head=fix/critical- (bare suffix) → allowed', () => {
    // The regex is /^fix\/critical-/ (prefix match, no anchor), so bare suffix is allowed.
    assert.deepStrictEqual(classifyPrTarget('main', 'fix/critical-'), { decision: 'allowed' });
  });

  test('base=main, head=chore/backmerge-next-to-main → allowed', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'chore/backmerge-next-to-main'), { decision: 'allowed' });
  });

  test('base=main, head=revert/critical-bad-deploy → allowed', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'revert/critical-bad-deploy'), { decision: 'allowed' });
  });

  test('base=release/1.2.0 → allowed (stabilization PR)', () => {
    assert.deepStrictEqual(classifyPrTarget('release/1.2.0', 'fix/some-fix'), { decision: 'allowed' });
  });

  test('base=release/10.20.0 → allowed (multi-digit stabilization)', () => {
    assert.deepStrictEqual(classifyPrTarget('release/10.20.0', 'chore/bump'), { decision: 'allowed' });
  });

  test('base=hotfix/1.2.3 → allowed (stabilization PR)', () => {
    assert.deepStrictEqual(classifyPrTarget('hotfix/1.2.3', 'fix/patch'), { decision: 'allowed' });
  });

  test('base=hotfix/10.20.30 → allowed (multi-digit stabilization)', () => {
    assert.deepStrictEqual(classifyPrTarget('hotfix/10.20.30', 'chore/stuff'), { decision: 'allowed' });
  });
});

describe('classifyPrTarget — blocked cases', () => {
  test('base=main, head=feat/x → blocked', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'feat/x'), { decision: 'blocked' });
  });

  test('base=main, head=fix/non-critical → blocked (non-critical prefix)', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'fix/non-critical'), { decision: 'blocked' });
  });

  test('base=main, head=fix/x → blocked (not fix/critical-)', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'fix/x'), { decision: 'blocked' });
  });

  test('base=main, head=chore/cleanup → blocked (not chore/backmerge-)', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'chore/cleanup'), { decision: 'blocked' });
  });

  test('base=main, head=revert/safe → blocked (not revert/critical-)', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'revert/safe'), { decision: 'blocked' });
  });

  test('base=main, head=release/1.2.1 → blocked (patch release not allowed for main)', () => {
    // The pattern is /^release\/\d+\.\d+\.0$/ — only .0 patch is allowed for main.
    assert.deepStrictEqual(classifyPrTarget('main', 'release/1.2.1'), { decision: 'blocked' });
  });

  test('base=main, head=release/1.2.0-beta → blocked (suffix after .0)', () => {
    // The pattern anchors with $, so release/1.2.0-beta does not match.
    assert.deepStrictEqual(classifyPrTarget('main', 'release/1.2.0-beta'), { decision: 'blocked' });
  });

  test('base=main, head=hotfix/1.2 → blocked (only two version parts)', () => {
    // Pattern requires \d+\.\d+\.\d+ (3 parts).
    assert.deepStrictEqual(classifyPrTarget('main', 'hotfix/1.2'), { decision: 'blocked' });
  });

  test('base=main, head=empty string → blocked', () => {
    assert.deepStrictEqual(classifyPrTarget('main', ''), { decision: 'blocked' });
  });

  // Hyphen-boundary negative tests: verify that the trailing hyphen is required.
  // A regex weakening from /^fix\/critical-/ → /^fix\/critical/ would make these
  // incorrectly pass; they must remain blocked.
  test('base=main, head=fix/criticalfoo → blocked (missing required hyphen)', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'fix/criticalfoo'), { decision: 'blocked' });
  });

  test('base=main, head=chore/backmergefoo → blocked (missing required hyphen)', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'chore/backmergefoo'), { decision: 'blocked' });
  });

  test('base=main, head=revert/criticalfoo → blocked (missing required hyphen)', () => {
    assert.deepStrictEqual(classifyPrTarget('main', 'revert/criticalfoo'), { decision: 'blocked' });
  });
});

describe('classifyPrTarget — unusual cases', () => {
  test('base=develop → unusual', () => {
    assert.deepStrictEqual(classifyPrTarget('develop', 'feat/x'), { decision: 'unusual' });
  });

  test('base=feature/something → unusual', () => {
    assert.deepStrictEqual(classifyPrTarget('feature/something', 'feat/x'), { decision: 'unusual' });
  });

  test('base=release/1.2.1 (patch, not .0) → unusual (not a valid stabilization target)', () => {
    // release/1.2.1 does not match /^release\/\d+\.\d+\.0$/, so it's unusual.
    assert.deepStrictEqual(classifyPrTarget('release/1.2.1', 'fix/patch'), { decision: 'unusual' });
  });

  test('base=hotfix/1.2 (two parts) → unusual', () => {
    // hotfix/1.2 does not match /^hotfix\/\d+\.\d+\.\d+$/, so it's unusual.
    assert.deepStrictEqual(classifyPrTarget('hotfix/1.2', 'fix/patch'), { decision: 'unusual' });
  });
});

// ---------------------------------------------------------------------------
// (B) Equivalence oracle — prove behavior-preservation across the refactor.
// Every (base, head) combo must agree between the module and the oracle.
// ---------------------------------------------------------------------------

describe('equivalence oracle — module agrees with original inline logic', () => {
  /** @type {[string, string][]} */
  const BATTERY = [
    // next → always allowed
    ['next', 'feat/foo'],
    ['next', 'fix/critical-x'],
    ['next', 'main'],
    // main → allowed patterns
    ['main', 'release/1.2.0'],
    ['main', 'release/0.0.0'],
    ['main', 'hotfix/1.2.3'],
    ['main', 'hotfix/0.1.2'],
    ['main', 'fix/critical-login-failure'],
    ['main', 'fix/critical-'],
    ['main', 'chore/backmerge-next'],
    ['main', 'revert/critical-bad-merge'],
    // main → blocked
    ['main', 'feat/new-thing'],
    ['main', 'fix/typo'],
    ['main', 'chore/lint'],
    ['main', 'release/1.2.1'],
    ['main', 'hotfix/1.2'],
    ['main', ''],
    // main → blocked: hyphen-boundary negatives (no trailing hyphen)
    ['main', 'fix/criticalfoo'],
    ['main', 'chore/backmergefoo'],
    ['main', 'revert/criticalfoo'],
    // stabilization bases → allowed
    ['release/1.2.0', 'chore/bump-deps'],
    ['hotfix/1.2.3', 'fix/critical-patch'],
    // unusual bases
    ['develop', 'feat/something'],
    ['feature/my-thing', 'chore/minor'],
    ['release/1.2.1', 'fix/patch'],
    ['hotfix/1.2', 'fix/patch'],
  ];

  for (const [base, head] of BATTERY) {
    test(`oracle agrees: base=${JSON.stringify(base)} head=${JSON.stringify(head)}`, () => {
      const moduleDecision = classifyPrTarget(base, head).decision;
      const oracleDecision = oracle(base, head);
      assert.strictEqual(
        moduleDecision,
        oracleDecision,
        `classifyPrTarget(${JSON.stringify(base)}, ${JSON.stringify(head)}) returned ` +
        `'${moduleDecision}' but oracle returned '${oracleDecision}'`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// (C) Structural assertions — workflow wiring
// ---------------------------------------------------------------------------

describe('pr-target-validator.yml structural wiring', () => {
  let workflowSrc;

  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), `workflow not found at ${WORKFLOW_PATH}`);
    workflowSrc = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  });

  test('workflow checks out the base ref (fork-tamper-safe)', () => {
    assert.ok(
      workflowSrc,
      'workflowSrc not loaded (prior test may have failed)'
    );
    // Must have a checkout step using the base ref so that a fork PR cannot
    // supply its own copy of the policy module.
    assert.match(
      workflowSrc,
      /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.ref\s*\}\}/,
      'checkout step must pin ref to github.event.pull_request.base.ref'
    );
  });

  test('checkout step uses the repo-standard pinned SHA (de0fac2e...)', () => {
    assert.ok(workflowSrc, 'workflowSrc not loaded');
    assert.match(
      workflowSrc,
      /actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/,
      'checkout must use the repo-standard pinned SHA de0fac2e4500dabe0009e67214ff5f5447ce83dd'
    );
  });

  test('workflow requires pr-target-policy.cjs', () => {
    assert.ok(workflowSrc, 'workflowSrc not loaded');
    assert.match(
      workflowSrc,
      /require\(.*scripts\/pr-target-policy\.cjs/,
      'github-script must require scripts/pr-target-policy.cjs'
    );
  });

  test('workflow calls classifyPrTarget', () => {
    assert.ok(workflowSrc, 'workflowSrc not loaded');
    assert.match(
      workflowSrc,
      /classifyPrTarget\(/,
      'github-script must call classifyPrTarget()'
    );
  });

  test('workflow no longer contains the inline mainAllowed array', () => {
    assert.ok(workflowSrc, 'workflowSrc not loaded');
    // The inline pattern array `mainAllowed` was the old classification code.
    // It must have been removed to avoid the logic diverging from the module.
    assert.doesNotMatch(
      workflowSrc,
      /const mainAllowed\s*=/,
      'old inline mainAllowed array must not appear in the rewired workflow'
    );
  });

  test('WARN_ONLY env and setFailed/warning behavior preserved', () => {
    assert.ok(workflowSrc, 'workflowSrc not loaded');
    assert.match(workflowSrc, /WARN_ONLY/, 'WARN_ONLY env must still be present');
    assert.match(workflowSrc, /core\.setFailed/, 'core.setFailed must still be called on block');
    assert.match(workflowSrc, /core\.warning.*warning-only mode/, 'WARN_ONLY warning message must be preserved');
  });

  test('sticky-comment marker and post/update logic preserved', () => {
    assert.ok(workflowSrc, 'workflowSrc not loaded');
    assert.match(workflowSrc, /pr-target-validator/, 'comment marker must still reference pr-target-validator');
    assert.match(workflowSrc, /listComments/, 'listComments call must be preserved');
    assert.match(workflowSrc, /updateComment/, 'updateComment call must be preserved');
    assert.match(workflowSrc, /createComment/, 'createComment call must be preserved');
  });

  test('maintainer carve-out (if: author_association) preserved', () => {
    assert.ok(workflowSrc, 'workflowSrc not loaded');
    assert.match(
      workflowSrc,
      /OWNER.*MEMBER.*COLLABORATOR|COLLABORATOR.*MEMBER.*OWNER/s,
      'maintainer association carve-out must still be present'
    );
  });
});

// ---------------------------------------------------------------------------
// (D) MAIN_ALLOWED_PATTERNS export — verify array is exported and well-formed
// ---------------------------------------------------------------------------

describe('MAIN_ALLOWED_PATTERNS export', () => {
  test('exports an array of 5 RegExp objects', () => {
    assert.ok(Array.isArray(MAIN_ALLOWED_PATTERNS), 'MAIN_ALLOWED_PATTERNS must be an array');
    assert.strictEqual(MAIN_ALLOWED_PATTERNS.length, 5, 'must export exactly 5 patterns');
    for (const re of MAIN_ALLOWED_PATTERNS) {
      assert.ok(re instanceof RegExp, `Expected RegExp, got ${typeof re}`);
    }
  });

  test('pattern[0] matches release/X.Y.0 branches only', () => {
    const re = MAIN_ALLOWED_PATTERNS[0];
    assert.ok(re.test('release/1.2.0'));
    assert.ok(re.test('release/10.20.0'));
    assert.ok(!re.test('release/1.2.1'), 'should not match patch != 0');
    assert.ok(!re.test('release/1.2.0-beta'), 'should not match suffix');
    assert.ok(!re.test('hotfix/1.2.0'), 'should not match hotfix');
  });

  test('pattern[1] matches hotfix/X.Y.Z branches', () => {
    const re = MAIN_ALLOWED_PATTERNS[1];
    assert.ok(re.test('hotfix/1.2.3'));
    assert.ok(re.test('hotfix/10.20.30'));
    assert.ok(!re.test('hotfix/1.2'), 'must require 3 parts');
    assert.ok(!re.test('hotfix/1.2.3-beta'), 'suffix should not match');
  });

  test('pattern[2] matches fix/critical- prefix', () => {
    const re = MAIN_ALLOWED_PATTERNS[2];
    assert.ok(re.test('fix/critical-login'));
    assert.ok(re.test('fix/critical-'));
    assert.ok(!re.test('fix/noncritical'));
    assert.ok(!re.test('chore/critical-something'));
  });

  test('pattern[3] matches chore/backmerge- prefix', () => {
    const re = MAIN_ALLOWED_PATTERNS[3];
    assert.ok(re.test('chore/backmerge-next-to-main'));
    assert.ok(re.test('chore/backmerge-'));
    assert.ok(!re.test('chore/merge-back'));
    assert.ok(!re.test('feat/backmerge-something'));
  });

  test('pattern[4] matches revert/critical- prefix', () => {
    const re = MAIN_ALLOWED_PATTERNS[4];
    assert.ok(re.test('revert/critical-bad-deploy'));
    assert.ok(re.test('revert/critical-'));
    assert.ok(!re.test('revert/safe'));
    assert.ok(!re.test('fix/critical-something'));
  });
});

// allow-test-rule: structural-regression-guard [#3143]
/**
 * no-unbounded-spawn-allowlist.test.cjs
 *
 * `eslint-rules/no-unbounded-spawn.allowlist.json` was deleted by #3148 (the
 * terminal wave of epic #3064): the migration reached zero remaining
 * violations, so the allowlist option was dropped from the rule's wiring in
 * `eslint.config.mjs` and `local/no-unbounded-spawn` now runs with no
 * exemption surface at all under `tests/**`. The former D4/D5/D6/D8 guards
 * here (dead entries, baseline ratchet, separator normalization, canonical
 * sort/dedupe) all referenced that now-deleted file and are gone with it.
 *
 * What remains — D7, the inline-disable ban — matters MORE now, not less:
 * with no allowlist to grandfather a file, an inline `eslint-disable`
 * naming this rule is the ONLY remaining way to silence it. This guard is
 * the sole remaining defense against that, so it stays.
 *
 * D7 needs to inspect test-file *contents* for an inline directive that
 * disables this rule by name — the absence of that pattern is the contract
 * this guard protects (a contributor cannot silence the check by disabling
 * it inline instead of fixing the timeout). That is a `readFileSync` +
 * text-search on `.cjs` files, which is exactly what `local/no-source-grep`
 * exists to catch — hence the
 * `// allow-test-rule: structural-regression-guard [#3143]` annotation on
 * its own line above, per CONTRIBUTING.md's documented exemption.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TESTS_DIR = path.join(__dirname);
const REPO_ROOT = path.join(__dirname, '..');

function listTestFiles() {
  const out = [];
  for (const entry of fs.readdirSync(TESTS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.cjs')) {
      out.push(path.join(TESTS_DIR, entry.name));
    }
  }
  return out;
}

// Built via concatenation, not a string literal, so this file does not
// itself contain the literal directive text (`local/no-unbounded-spawn`)
// that D7 below scans every test file for — a literal here would make this
// guard flag itself.
const GUARDED_RULE = 'local' + '/' + 'no-unbounded-spawn';

function containsDisableDirective(contents, ruleName) {
  return new RegExp(`eslint-disable[^\\n]*${ruleName}`).test(contents);
}

describe('no-unbounded-spawn allowlist: D7 — no inline disable of this rule', () => {
  test('no test file inline-disables the unbounded-spawn guard', () => {
    const offenders = [];
    for (const filePath of listTestFiles()) {
      const contents = fs.readFileSync(filePath, 'utf8');
      if (containsDisableDirective(contents, GUARDED_RULE)) {
        offenders.push(path.relative(REPO_ROOT, filePath));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `test files inline-disabling the unbounded-spawn guard (forbidden — fix the timeout instead): ${JSON.stringify(offenders)}`
    );
  });

  test('detection logic actually flags a synthetic inline-disable directive', () => {
    const syntheticContents = [
      "'use strict';",
      '// eslint-disable-next-line ' + GUARDED_RULE,
      "spawnSync('git', ['status'], {});",
    ].join('\n');
    assert.equal(containsDisableDirective(syntheticContents, GUARDED_RULE), true);
    assert.equal(containsDisableDirective("'use strict';\nspawnSync('git', ['status'], {});", GUARDED_RULE), false);
  });
});

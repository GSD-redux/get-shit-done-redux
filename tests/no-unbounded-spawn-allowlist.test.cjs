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
 *
 * The scan covers ALL of `tests/`, RECURSIVELY — not just the top-level
 * directory. `listTestFiles()` walks every subdirectory (`tests/helpers/`,
 * `tests/qa/`, `tests/observability/`, `tests/fixtures/`, `tests/dispatch/`,
 * etc.) via `fs.readdirSync(..., { recursive: true })`. A non-recursive scan
 * left ~37 nested `.cjs` files completely unchecked: a file in a subdirectory
 * could carry both an unbounded spawn AND an inline eslint-disable directive
 * naming this rule (see `GUARDED_RULE` below), and this guard would never see
 * it. With the allowlist gone, this is the SOLE remaining defense against
 * silencing the rule — recursion is not optional.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TESTS_DIR = path.join(__dirname);
const REPO_ROOT = path.join(__dirname, '..');

/**
 * Recursively list every `.cjs` file under `tests/`, including subdirectories
 * (`tests/helpers/`, `tests/qa/`, `tests/observability/`, `tests/fixtures/`,
 * `tests/dispatch/`, etc.). `fs.readdirSync(dir, { recursive: true,
 * withFileTypes: true })` is available on the repo's Node floor (>=22.0.0 per
 * package.json `engines`; the option landed in Node 20.1). Each returned
 * `Dirent` carries `parentPath` — its containing directory, which for a
 * nested entry is the subdirectory, not `TESTS_DIR` — so the joined path is
 * correct at any depth. `node_modules` is skipped defensively in case one is
 * ever vendored under `tests/`.
 */
function listTestFiles() {
  const out = [];
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.cjs')) continue;
    const dir = entry.parentPath || entry.path || TESTS_DIR;
    if (dir.split(path.sep).includes('node_modules')) continue;
    out.push(path.join(dir, entry.name));
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

  test('listTestFiles() recurses into subdirectories, not just the top level', (t) => {
    // Regression for the reviewer-proven hole: a non-recursive scan sees
    // only TESTS_DIR itself and is blind to tests/helpers/, tests/qa/,
    // tests/observability/, tests/fixtures/, tests/dispatch/, etc.
    const probeDir = path.join(TESTS_DIR, 'helpers');
    const probePath = path.join(probeDir, '__probe_recursion_3148.cjs');
    fs.writeFileSync(
      probePath,
      [
        "'use strict';",
        '// eslint-disable-next-line ' + GUARDED_RULE,
        "spawnSync('git', ['status'], {});",
        '',
      ].join('\n'),
    );
    t.after(() => {
      // helpers.cleanup() refuses any path outside a recognized temp root;
      // this probe deliberately lives under tests/helpers/ (the thing under
      // test is recursion into a real subdirectory of tests/, not a temp
      // dir), so a raw, force-flagged, single-file rmSync of a path this
      // same test just created is the correct tool here.
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- probe file lives under tests/helpers/, not a temp root; helpers.cleanup() would refuse it
      fs.rmSync(probePath, { force: true });
    });

    const found = listTestFiles();
    assert.ok(
      found.includes(probePath),
      'listTestFiles() must include .cjs files nested in subdirectories of tests/',
    );
  });

  test('a subdirectory file inline-disabling the rule is caught end-to-end', (t) => {
    // Same probe, but exercised through the actual D7 detection path (the
    // same offenders-collection loop the first test in this describe runs),
    // proving the fix closes the hole rather than just listTestFiles().
    const probeDir = path.join(TESTS_DIR, 'helpers');
    const probePath = path.join(probeDir, '__probe_recursion_detect_3148.cjs');
    fs.writeFileSync(
      probePath,
      [
        "'use strict';",
        '// eslint-disable-next-line ' + GUARDED_RULE,
        "spawnSync('git', ['status'], {});",
        '',
      ].join('\n'),
    );
    t.after(() => {
      // helpers.cleanup() refuses any path outside a recognized temp root;
      // this probe deliberately lives under tests/helpers/ (the thing under
      // test is recursion into a real subdirectory of tests/, not a temp
      // dir), so a raw, force-flagged, single-file rmSync of a path this
      // same test just created is the correct tool here.
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- probe file lives under tests/helpers/, not a temp root; helpers.cleanup() would refuse it
      fs.rmSync(probePath, { force: true });
    });

    const offenders = [];
    for (const filePath of listTestFiles()) {
      const contents = fs.readFileSync(filePath, 'utf8');
      if (containsDisableDirective(contents, GUARDED_RULE)) {
        offenders.push(path.relative(REPO_ROOT, filePath));
      }
    }
    assert.ok(
      offenders.includes(path.relative(REPO_ROOT, probePath)),
      `expected the nested inline-disable probe to be caught; offenders: ${JSON.stringify(offenders)}`,
    );
  });
});

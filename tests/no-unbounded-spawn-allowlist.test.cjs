// allow-test-rule: structural-regression-guard [#3143]
/**
 * no-unbounded-spawn-allowlist.test.cjs
 *
 * Structural guards on `eslint-rules/no-unbounded-spawn.allowlist.json` —
 * matrix D4-D8 of
 * .gsd/phase/chore-3143-no-unbounded-spawn-guard/50-test-matrix.md.
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

const ALLOWLIST_PATH = path.join(__dirname, '..', 'eslint-rules', 'no-unbounded-spawn.allowlist.json');
const TESTS_DIR = path.join(__dirname);
const REPO_ROOT = path.join(__dirname, '..');

// The allowlist only ratchets DOWN. This baseline is the length observed at
// the time this guard was written (139 entries) — each future migration
// wave lowers it as files are moved off the allowlist by adding real
// timeouts; it must never grow back up.
const BASELINE = 139;

function readAllowlist() {
  const raw = fs.readFileSync(ALLOWLIST_PATH, 'utf8');
  return JSON.parse(raw);
}

function listTestFiles() {
  const out = [];
  for (const entry of fs.readdirSync(TESTS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.cjs')) {
      out.push(path.join(TESTS_DIR, entry.name));
    }
  }
  return out;
}

describe('no-unbounded-spawn allowlist: D4 — no dead entries', () => {
  test('every allowlist entry resolves to a file that exists on disk', () => {
    const list = readAllowlist();
    const dead = list.filter((entry) => !fs.existsSync(path.join(REPO_ROOT, entry)));
    assert.deepEqual(dead, [], `dead allowlist entries (file does not exist): ${JSON.stringify(dead)}`);
  });
});

describe('no-unbounded-spawn allowlist: D5 — never grows', () => {
  test('allowlist length is at or under the recorded baseline', () => {
    const list = readAllowlist();
    assert.ok(
      list.length <= BASELINE,
      `allowlist grew to ${list.length} entries, exceeding the BASELINE of ${BASELINE}. ` +
        `The allowlist only ratchets down — if this is a legitimate new violation, ` +
        `lower BASELINE only after confirming it, never raise it to paper over growth.`
    );
  });
});

describe('no-unbounded-spawn allowlist: D6 — separator normalization', () => {
  test('every entry uses / separators, never \\', () => {
    const list = readAllowlist();
    const withBackslash = list.filter((entry) => entry.includes('\\'));
    assert.deepEqual(withBackslash, [], `entries with a backslash separator: ${JSON.stringify(withBackslash)}`);
  });
});

describe('no-unbounded-spawn allowlist: D7 — no inline disable of this rule', () => {
  test('no test file inline-disables the unbounded-spawn guard', () => {
    const GUARDED_RULE = 'local' + '/' + 'no-unbounded-spawn';
    const offenders = [];
    for (const filePath of listTestFiles()) {
      const contents = fs.readFileSync(filePath, 'utf8');
      if (new RegExp(`eslint-disable[^\\n]*${GUARDED_RULE}`).test(contents)) {
        offenders.push(path.relative(REPO_ROOT, filePath));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `test files inline-disabling the unbounded-spawn guard (forbidden — fix the timeout instead): ${JSON.stringify(offenders)}`
    );
  });
});

describe('no-unbounded-spawn allowlist: D8 — canonical form', () => {
  test('allowlist is valid JSON, sorted, with no duplicates', () => {
    const list = readAllowlist();
    assert.ok(Array.isArray(list), 'allowlist.json must parse to an array');

    const sorted = [...list].sort();
    assert.deepEqual(list, sorted, 'allowlist entries must be sorted');

    const unique = new Set(list);
    assert.equal(unique.size, list.length, 'allowlist entries must be unique');
  });
});

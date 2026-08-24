'use strict';

// docs-guard-exempt: this file only WRITES synthetic 'docs/...' fixtures into
// throwaway temp dirs (writeFileSync()) to exercise
// scripts/lint-docs-guard-registration.cjs's own reader-detection behavior —
// it never reads real shipped docs/ content itself. The fixture strings
// happen to contain readFileSync('docs/...')-shaped text, which trips this
// lint's own plain-text scan; that is expected of a lint's own test file.
//
// Coverage for the docs-guard lane (#3753):
//   - scripts/docs-guard-registry.cjs — the sole registry of doc-reading test
//     files the docs-guard lane must run;
//   - a registration lint (scripts/lint-docs-guard-registration.cjs) that
//     flags a test file which reads a docs/ path but is neither registered
//     nor exempted;
//   - the docs-guard lane's registry run lives inside the ALREADY-REQUIRED
//     `docs-lint` job in .github/workflows/docs-required.yml, gated on a
//     `docs_changed` step output, rather than in a dedicated
//     `paths:`-filtered workflow. A `paths:`-filtered workflow never reports
//     a check on a non-docs PR, so it can never be added to the required
//     contexts in .github/rulesets/main-protection.json without hanging
//     every non-docs PR forever — that was the fatal flaw in a prior version
//     of this PR that stood up .github/workflows/docs-guards.yml as a
//     separate workflow (deleted; see git history).
//
// #3753 follow-up: this file (net-new; no predecessor exists on origin/next)
// replaces an earlier, since-abandoned version of this PR that put the registry inside a `docs guards` RULE
// in scripts/ci-test-scope.cjs's RULES array, on the theory that classify()'s
// `!codeChanged` normalization made the RULE inert to the scope decision.
// That theory held for docs-ONLY diffs and broke for MIXED docs+code diffs,
// where codeChanged is true and the normalization never runs — every one of
// the registry's ~20 tests joined targeted_tests on EVERY mixed PR. Probed:
// `node scripts/ci-test-scope.cjs --files "docs/a.md src/semver.cts"`
// returned 25 targeted_tests with the RULE in place, vs. 3 on `origin/next`.
// The fix extracts the registry to its own module (scripts/docs-guard-registry.cjs)
// that classify() never reads at all, and scripts/ci-test-scope.cjs is
// reverted byte-for-byte to `origin/next`. This file carries only the new
// registry's own tests plus the regression pin in the "classify() is
// untouched" describe block below — there is no `docs guards` RULE for it
// to cover, on `origin/next` or anywhere else.
//
// #3753 follow-up 2 (registry shape change): DOCS_GUARD_TESTS changed from a
// flat array to a MAP (test file -> docs/ path patterns it reads), and
// scripts/select-docs-guards.cjs's pure selectDocsGuards() resolves a PR's
// changed docs/ paths to the narrow subset of guards that need to run —
// instead of the docs-lint job always running the entire registry. See the
// "docs-guard selector" describe block below for the selector's own coverage.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci-test-scope.cjs');
const {
  DOCS_GUARD_TESTS,
  DOCS_GUARD_TEST_FILES,
  RUN_TESTS_SUITES,
  assertNoSuiteCollision,
} = require('../scripts/docs-guard-registry.cjs');
const { selectDocsGuards } = require('../scripts/select-docs-guards.cjs');
const {
  checkDocsGuardRegistration,
  checkExemptBaseline,
  checkExemptFingerprints,
  extractDocsPathReferences,
  deriveDocsGuardRegistry,
  EXEMPT_BASELINE_FILE,
  EXEMPT_BASELINE_CONST,
} = require('../scripts/lint-docs-guard-registration.cjs');
const {
  DOCS_GUARD_EXEMPT_BASELINE,
  DOCS_GUARD_EXEMPT_DOCS_PATHS,
} = require('../scripts/lint-docs-guard-registration.exempt-baseline.cjs');
const { selectExplicitFiles, walkTestFiles } = require('../scripts/run-tests.cjs');

function scopeFor(files) {
  const r = runNode([SCRIPT, '--files', files.join(' ')], { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
  assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  return JSON.parse(r.stdout);
}

describe('docs-guard registry (scripts/docs-guard-registry.cjs)', () => {
  test('every registry entry exists on disk', () => {
    for (const f of DOCS_GUARD_TEST_FILES) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `registry entry does not exist on disk: ${f}`);
    }
  });

  // #10: a heuristic curation pass missed tests/ui-spec-inventory-provenance.test.cjs
  // the day it broke `next` on dacae9273 — its membership in the registry is
  // therefore pinned here BY NAME, not derived from any heuristic.
  test('the guard that broke next on dacae9273 is in the registry', () => {
    assert.ok(
      DOCS_GUARD_TEST_FILES.includes('tests/ui-spec-inventory-provenance.test.cjs'),
      'tests/ui-spec-inventory-provenance.test.cjs must be pinned in the docs-guard registry by name',
    );
  });

  test('every registry VALUE is a non-empty array of strings', () => {
    for (const [file, patterns] of Object.entries(DOCS_GUARD_TESTS)) {
      assert.ok(Array.isArray(patterns) && patterns.length > 0, `${file}: registry value must be a non-empty array`);
      for (const p of patterns) {
        assert.strictEqual(typeof p, 'string', `${file}: every pattern must be a string, got ${JSON.stringify(p)}`);
      }
    }
  });
});

// Boundary coverage for the pure selector (limit-1 / limit / limit+1 style):
// exact match, dir-prefix match (including the prefix-confusion boundary a
// naive startsWith would get wrong), the '*' wildcard, and the empty-input
// edge.
describe('docs-guard selector (scripts/select-docs-guards.cjs)', () => {
  const REGISTRY = {
    'tests/exact-reader.test.cjs': ['docs/AGENTS.md'],
    'tests/dir-reader.test.cjs': ['docs/adr/'],
    'tests/wildcard-reader.test.cjs': ['*'],
  };

  test('exact-file match selects only that guard', () => {
    assert.deepStrictEqual(
      selectDocsGuards(['docs/AGENTS.md'], REGISTRY),
      ['tests/exact-reader.test.cjs', 'tests/wildcard-reader.test.cjs'].sort(),
    );
  });

  test('dir-prefix match selects on a nested file', () => {
    const selected = selectDocsGuards(['docs/adr/0001-example.md'], REGISTRY);
    assert.ok(selected.includes('tests/dir-reader.test.cjs'), `expected dir-reader selected, got ${JSON.stringify(selected)}`);
  });

  // Prefix-confusion boundary: 'docs/adrenaline.md' shares the literal
  // prefix 'docs/adr' with the pattern 'docs/adr/', but is NOT under the
  // docs/adr/ directory. A naive `startsWith('docs/adr')` (without the
  // trailing slash) would wrongly match this.
  test('dir-prefix match does NOT select on a same-prefix sibling file (docs/adrenaline.md)', () => {
    const selected = selectDocsGuards(['docs/adrenaline.md'], REGISTRY);
    assert.ok(!selected.includes('tests/dir-reader.test.cjs'), `expected dir-reader NOT selected, got ${JSON.stringify(selected)}`);
  });

  test("'*' guard is selected on any docs change", () => {
    const selected = selectDocsGuards(['docs/some-unrelated-file.md'], REGISTRY);
    assert.deepStrictEqual(selected, ['tests/wildcard-reader.test.cjs']);
  });

  test('empty changed set yields an empty selection', () => {
    assert.deepStrictEqual(selectDocsGuards([], REGISTRY), []);
  });

  test('a changed docs file no guard reads yields an empty selection (minus the wildcard)', () => {
    const registryNoWildcard = { 'tests/exact-reader.test.cjs': ['docs/AGENTS.md'] };
    assert.deepStrictEqual(selectDocsGuards(['docs/totally-unrelated.md'], registryNoWildcard), []);
  });

  // Proven-genuine cases (real registry, real files) pinned by name.
  test('changing docs/COMMANDS.md selects tests/cursor-reviewer.test.cjs', () => {
    const selected = selectDocsGuards(['docs/COMMANDS.md'], DOCS_GUARD_TESTS);
    assert.ok(selected.includes('tests/cursor-reviewer.test.cjs'), `got: ${JSON.stringify(selected)}`);
  });

  test('changing docs/INVENTORY.md selects tests/inventory-headings-countfree.test.cjs', () => {
    const selected = selectDocsGuards(['docs/INVENTORY.md'], DOCS_GUARD_TESTS);
    assert.ok(selected.includes('tests/inventory-headings-countfree.test.cjs'), `got: ${JSON.stringify(selected)}`);
  });

  test('changing docs/AGENTS.md selects tests/install.test.cjs', () => {
    const selected = selectDocsGuards(['docs/AGENTS.md'], DOCS_GUARD_TESTS);
    assert.ok(selected.includes('tests/install.test.cjs'), `got: ${JSON.stringify(selected)}`);
  });

  // The whole point of the maintainer's decision: an unrelated docs change
  // must NOT select tests/install.test.cjs (7840 lines) just because that
  // file happens to also read docs/AGENTS.md.
  test('changing an unrelated docs file does NOT select tests/install.test.cjs', () => {
    const selected = selectDocsGuards(['docs/how-to/some-unrelated-guide.md'], DOCS_GUARD_TESTS);
    assert.ok(!selected.includes('tests/install.test.cjs'), `got: ${JSON.stringify(selected)}`);
  });

  test('a real single-file docs change selects far fewer than the full 62-file registry', () => {
    const selected = selectDocsGuards(['docs/how-to/foo.md'], DOCS_GUARD_TESTS);
    assert.ok(
      selected.length < DOCS_GUARD_TEST_FILES.length,
      `expected a narrower selection than the full registry (${DOCS_GUARD_TEST_FILES.length}), got ${selected.length}`,
    );
  });
});

describe('docs-guard lane: classify() is untouched (#3753 mixed-diff regression)', () => {
  // THE regression pin for this PR's blocker. Before the extraction, a `docs
  // guards` RULE lived inside scripts/ci-test-scope.cjs's RULES array and
  // fired on any 'docs/' path regardless of what else changed. Because the
  // `!codeChanged` normalization only zeroes output when NO product/pipeline
  // file changed, a mixed docs+code diff kept every one of the RULE's ~20
  // tests in targeted_tests. Measured on that version:
  //   node scripts/ci-test-scope.cjs --files "docs/a.md src/semver.cts"
  //   -> 25 targeted_tests (HEAD with the RULE) vs. 3 (origin/next, no RULE).
  // scripts/ci-test-scope.cjs is now reverted byte-for-byte to origin/next,
  // so this pins the count the 'TS runtime sources' RULE alone produces for a
  // src/*.cts change, proving the docs-guard registry does not leak into the
  // scoped lane via any path. Asserted BEHAVIORALLY rather than by diffing the
  // file against origin/next: a ref-diff assertion is unavailable in a shallow
  // CI checkout and in gsd-test's shallow clone, so it could only be written to
  // skip when the ref is missing -- i.e. to pass vacuously wherever it actually
  // runs. The OUTPUT is the contract; the bytes are not.
  test('a mixed docs+code diff selects the same tests as before the docs-guard extraction', () => {
    const result = scopeFor(['docs/a.md', 'src/semver.cts']);
    assert.strictEqual(result.code_changed, true);
    assert.deepStrictEqual(
      result.targeted_tests,
      [
        'tests/emitted-attribution.test.cjs',
        'tests/emitted-provenance.test.cjs',
        'tests/semver-compare.test.cjs',
      ],
      `expected exactly the 'TS runtime sources' RULE's 3 tests (matching origin/next), not the ` +
      `pre-fix 25 that resulted from the docs-guard registry leaking into targeted_tests on a ` +
      `mixed docs+code diff: ${JSON.stringify(result.targeted_tests)}`,
    );
  });
});

describe('docs-guard lane: lint-docs-guard-registration.cjs', () => {
  function withFixture(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-guard-lint-'));
    try {
      return fn(dir);
    } finally {
      cleanup(dir);
    }
  }

  test('a registered docs reader passes the registration lint', () => {
    withFixture(dir => {
      fs.writeFileSync(
        path.join(dir, 'reader.test.cjs'),
        "'use strict';\nconst fs = require('fs');\nfs.readFileSync('docs/foo.md', 'utf8');\n",
      );
      const result = checkDocsGuardRegistration({ testsDir: dir, registry: ['reader.test.cjs'] });
      assert.deepStrictEqual(result.violations, []);
      assert.strictEqual(result.ok, true);
    });
  });

  test('an unregistered docs reader fails the lint', () => {
    withFixture(dir => {
      fs.writeFileSync(
        path.join(dir, 'unregistered.test.cjs'),
        "'use strict';\nconst fs = require('fs');\nfs.readFileSync('docs/foo.md', 'utf8');\n",
      );
      const result = checkDocsGuardRegistration({ testsDir: dir, registry: [] });
      assert.strictEqual(result.ok, false);
      assert.ok(
        result.violations.some(v => v.file === 'unregistered.test.cjs'),
        `expected a violation naming unregistered.test.cjs, got: ${JSON.stringify(result.violations)}`,
      );
    });
  });

  test('an exempted docs reader passes the lint', () => {
    withFixture(dir => {
      fs.writeFileSync(
        path.join(dir, 'exempt.test.cjs'),
        "'use strict';\n// docs-guard-exempt: reads docs only to build an overlay\nconst fs = require('fs');\nfs.readFileSync('docs/foo.md', 'utf8');\n",
      );
      const result = checkDocsGuardRegistration({ testsDir: dir, registry: [] });
      assert.deepStrictEqual(result.violations, []);
      assert.strictEqual(result.ok, true);
    });
  });

  test('an exemption without a reason is rejected', () => {
    withFixture(dir => {
      fs.writeFileSync(
        path.join(dir, 'bare-exempt.test.cjs'),
        "'use strict';\n// docs-guard-exempt:\nconst fs = require('fs');\nfs.readFileSync('docs/foo.md', 'utf8');\n",
      );
      const result = checkDocsGuardRegistration({ testsDir: dir, registry: [] });
      assert.strictEqual(result.ok, false);
      assert.ok(
        result.violations.some(v => v.file === 'bare-exempt.test.cjs'),
        `expected a violation naming bare-exempt.test.cjs, got: ${JSON.stringify(result.violations)}`,
      );
    });
  });

  test('a registry entry pointing at a missing file fails the lint', () => {
    withFixture(dir => {
      const result = checkDocsGuardRegistration({ testsDir: dir, registry: ['does-not-exist.test.cjs'] });
      assert.strictEqual(result.ok, false);
      assert.ok(
        result.violations.some(v => v.file === 'does-not-exist.test.cjs'),
        `expected a violation naming does-not-exist.test.cjs, got: ${JSON.stringify(result.violations)}`,
      );
    });
  });

  test('a test that only mentions a docs path is not treated as a reader', () => {
    withFixture(dir => {
      fs.writeFileSync(
        path.join(dir, 'mentions-only.test.cjs'),
        "'use strict';\nconst assert = require('node:assert/strict');\nconst msg = 'see docs/foo.md';\nassert.equal(msg, 'see docs/foo.md');\n",
      );
      const result = checkDocsGuardRegistration({ testsDir: dir, registry: [] });
      assert.deepStrictEqual(result.violations, []);
      assert.strictEqual(result.ok, true);
    });
  });

  // #3753 follow-up: the shipped lint's original reader-detection caught the
  // SEGMENT spelling (path.join(ROOT, 'docs', 'x.md')) but not the
  // SINGLE-STRING spelling (readShipped('docs/how-to/x.md')) — exactly how
  // tests/ui-spec-inventory-provenance.test.cjs reads, the guard that broke
  // `next` on dacae9273. This is the regression pin: it must fail against the
  // pre-fix lint and pass once the name-shaped reader-call detector exists.
  test('the lint detects a docs path passed as a single string argument', () => {
    withFixture(dir => {
      fs.writeFileSync(
        path.join(dir, 'single-string-reader.test.cjs'),
        "'use strict';\nfunction readShipped(p) { return require('fs').readFileSync(p, 'utf8'); }\nreadShipped('docs/how-to/x.md');\n",
      );
      const result = checkDocsGuardRegistration({ testsDir: dir, registry: [] });
      assert.strictEqual(result.ok, false);
      assert.ok(
        result.violations.some(v => v.file === 'single-string-reader.test.cjs'),
        `expected a violation naming single-string-reader.test.cjs, got: ${JSON.stringify(result.violations)}`,
      );
    });
  });

  // Over-correction guard: a naive "flag any 'docs/...' string literal" rule
  // would trip on a docs path that only appears inside an assertion message,
  // never passed to anything read-shaped. The name-shaped heuristic must not
  // regress the existing mention-only exemption.
  test('the lint still ignores a docs path that is only mentioned in a message', () => {
    withFixture(dir => {
      fs.writeFileSync(
        path.join(dir, 'still-mentions-only.test.cjs'),
        "'use strict';\nconst assert = require('node:assert/strict');\nconst msg = 'see docs/foo.md';\nassert.equal(msg, 'see docs/foo.md');\n",
      );
      const result = checkDocsGuardRegistration({ testsDir: dir, registry: [] });
      assert.deepStrictEqual(result.violations, []);
      assert.strictEqual(result.ok, true);
    });
  });

  // Exemption-marker header-window regression pin (this PR's second
  // reviewer finding): findExemption used to scan the WHOLE file, so a
  // `// docs-guard-exempt:` string appearing inside a fixture/template
  // literal anywhere in the file exempted the real file it lives in. This
  // asserts the marker is only honored near the top (within the header
  // window), not when it appears far down the file body.
  test('a docs-guard-exempt marker deep in the file body (outside the header window) does not exempt it', () => {
    withFixture(dir => {
      const padding = Array.from({ length: 30 }, (_, i) => `// padding line ${i}`).join('\n');
      fs.writeFileSync(
        path.join(dir, 'late-marker.test.cjs'),
        `'use strict';\n${padding}\n// docs-guard-exempt: this should NOT count, it is not a header\nconst fs = require('fs');\nfs.readFileSync('docs/foo.md', 'utf8');\n`,
      );
      const result = checkDocsGuardRegistration({ testsDir: dir, registry: [] });
      assert.strictEqual(result.ok, false);
      assert.ok(
        result.violations.some(v => v.file === 'late-marker.test.cjs'),
        `expected a violation naming late-marker.test.cjs (marker outside header window must not exempt), got: ${JSON.stringify(result.violations)}`,
      );
    });
  });

  // Security follow-up FIX 2: a guard that cannot read its own input must
  // never report success. Pre-fix, checkDocsGuardRegistration({testsDir:
  // '/nonexistent', registry: []}) returned {ok:true, violations:[]}.
  test('an unreadable testsDir is a hard violation, not a silent pass', () => {
    const result = checkDocsGuardRegistration({ testsDir: '/nonexistent-docs-guard-testsdir', registry: [] });
    assert.strictEqual(result.ok, false);
    assert.ok(
      result.violations.some(v => /cannot read testsDir/.test(v.reason)),
      `expected a violation naming the unreadable testsDir, got: ${JSON.stringify(result.violations)}`,
    );
  });

  // Same class: a directory (or broken symlink) named `*.test.cjs` must fail
  // the lint rather than being silently skipped by the readFileSync catch.
  test('an unreadable candidate test file (a directory named *.test.cjs) is a hard violation', () => {
    withFixture(dir => {
      fs.mkdirSync(path.join(dir, 'a-directory.test.cjs'));
      const result = checkDocsGuardRegistration({ testsDir: dir, registry: [] });
      assert.strictEqual(result.ok, false);
      assert.ok(
        result.violations.some(v => v.file === 'a-directory.test.cjs' && /cannot read candidate test file/.test(v.reason)),
        `expected a violation naming a-directory.test.cjs, got: ${JSON.stringify(result.violations)}`,
      );
    });
  });

  // Security follow-up FIX 4: a marker line inside a multi-line template
  // literal in the header window (e.g. `const F = \`...\`;`) must NOT be
  // honored as a real comment. Probed pre-fix: exempted=true.
  test('a docs-guard-exempt marker inside a multi-line template literal does NOT exempt the file', () => {
    withFixture(dir => {
      fs.writeFileSync(
        path.join(dir, 'template-literal-marker.test.cjs'),
        "'use strict';\nconst F = `\n// docs-guard-exempt: this is fixture content, not a real comment\n`;\nconst fs = require('fs');\nfs.readFileSync('docs/foo.md', 'utf8');\n",
      );
      const result = checkDocsGuardRegistration({ testsDir: dir, registry: [] });
      assert.strictEqual(result.ok, false);
      assert.ok(
        result.violations.some(v => v.file === 'template-literal-marker.test.cjs'),
        `expected a violation naming template-literal-marker.test.cjs (marker inside a template literal must not exempt), got: ${JSON.stringify(result.violations)}`,
      );
    });
  });

  test('the lint registry and the docs-guard-registry module export the same list', () => {
    const moduleRegistry = DOCS_GUARD_TEST_FILES.map(f => path.basename(f));
    const lintRegistry = deriveDocsGuardRegistry();
    assert.deepStrictEqual(lintRegistry, moduleRegistry,
      'the lint\'s default registry must be exactly scripts/docs-guard-registry.cjs\'s ' +
      'DOCS_GUARD_TEST_FILES export — a second, independently maintained list is the #3753 defect ' +
      'class this pins against');
  });

  test('the repository currently satisfies the registration lint (including the exempt baseline ratchet)', () => {
    const result = checkDocsGuardRegistration({
      testsDir: path.join(ROOT, 'tests'),
      registry: DOCS_GUARD_TEST_FILES.map(f => path.basename(f)),
      exemptBaseline: DOCS_GUARD_EXEMPT_BASELINE,
      exemptDocsPathsBaseline: DOCS_GUARD_EXEMPT_DOCS_PATHS,
    });
    assert.strictEqual(result.ok, true,
      `expected the real tests/ tree to satisfy the docs-guard registration lint, ` +
      `got ${result.violations.length} violation(s): ${JSON.stringify(result.violations)}`);
  });
});

// #3753 security follow-up FIX 3: the exempt ratchet gated on file IDENTITY
// only — a baselined file that later STARTS genuinely reading shipped docs/
// content stayed exempt with zero signal. Probed pre-fix: a baselined file
// doing fs.readFileSync('docs/foo.md') still reported ok=true, violations=[].
describe('docs-guard lane: docs-guard-exempt content-aware fingerprint ratchet (#3753 FIX 3)', () => {
  test('an unchanged docs-path fingerprint passes', () => {
    const violations = checkExemptFingerprints(
      { 'a.test.cjs': ['docs/foo.md'] },
      { 'a.test.cjs': ['docs/foo.md'] },
    );
    assert.deepStrictEqual(violations, []);
  });

  test('an ADDED docs path fails', () => {
    const violations = checkExemptFingerprints(
      { 'a.test.cjs': ['docs/foo.md', 'docs/bar.md'] },
      { 'a.test.cjs': ['docs/foo.md'] },
    );
    assert.ok(violations.length > 0, 'expected a violation for an added docs path');
    assert.ok(
      violations.some(v => v.file === 'a.test.cjs' && /docs paths referenced by a\.test\.cjs changed/.test(v.reason) && /re-confirm the exemption still holds/.test(v.reason)),
      `expected an actionable re-confirm message, got: ${JSON.stringify(violations)}`,
    );
  });

  test('a REMOVED docs path fails', () => {
    const violations = checkExemptFingerprints(
      { 'a.test.cjs': ['docs/foo.md'] },
      { 'a.test.cjs': ['docs/foo.md', 'docs/bar.md'] },
    );
    assert.ok(violations.length > 0, 'expected a violation for a removed docs path');
    assert.ok(
      violations.some(v => v.file === 'a.test.cjs' && /re-confirm the exemption still holds/.test(v.reason)),
      `expected an actionable re-confirm message, got: ${JSON.stringify(violations)}`,
    );
  });

  test('a file with no baseline fingerprint yet is not flagged here (identity ratchet handles novelty)', () => {
    const violations = checkExemptFingerprints({ 'novel.test.cjs': ['docs/foo.md'] }, {});
    assert.deepStrictEqual(violations, []);
  });

  test('end-to-end: a baselined exempt file that starts genuinely reading a NEW docs/ path fails the lint', () => {
    withFixtureForExemptBaseline((dir) => {
      fs.writeFileSync(
        path.join(dir, 'novel-exempt.test.cjs'),
        "'use strict';\n// docs-guard-exempt: reads docs only to build an overlay\nconst fs = require('fs');\nfs.readFileSync('docs/foo.md', 'utf8');\n",
      );
      const result = checkDocsGuardRegistration({
        testsDir: dir,
        registry: [],
        exemptBaseline: ['novel-exempt.test.cjs'],
        exemptDocsPathsBaseline: { 'novel-exempt.test.cjs': ['docs/foo.md'] },
      });
      assert.strictEqual(result.ok, true, `expected unchanged fingerprint to pass, got: ${JSON.stringify(result.violations)}`);

      fs.writeFileSync(
        path.join(dir, 'novel-exempt.test.cjs'),
        "'use strict';\n// docs-guard-exempt: reads docs only to build an overlay\nconst fs = require('fs');\nfs.readFileSync('docs/foo.md', 'utf8');\nfs.readFileSync('docs/bar.md', 'utf8');\n",
      );
      const drifted = checkDocsGuardRegistration({
        testsDir: dir,
        registry: [],
        exemptBaseline: ['novel-exempt.test.cjs'],
        exemptDocsPathsBaseline: { 'novel-exempt.test.cjs': ['docs/foo.md'] },
      });
      assert.strictEqual(drifted.ok, false, 'expected a NEW docs/ path reference to fail the lint');
      assert.ok(
        drifted.violations.some(v => v.file === 'novel-exempt.test.cjs' && /re-confirm the exemption still holds/.test(v.reason)),
        `expected a fingerprint-drift violation, got: ${JSON.stringify(drifted.violations)}`,
      );
    });
  });

  test('the shipped docs-paths baseline exactly matches the extracted fingerprint for every baselined file', () => {
    for (const file of DOCS_GUARD_EXEMPT_BASELINE) {
      const content = fs.readFileSync(path.join(ROOT, 'tests', file), 'utf8');
      const live = extractDocsPathReferences(content);
      assert.deepStrictEqual(
        live,
        DOCS_GUARD_EXEMPT_DOCS_PATHS[file] || [],
        `docs-paths fingerprint for ${file} is stale — regenerate DOCS_GUARD_EXEMPT_DOCS_PATHS`,
      );
    }
  });
});

// #3753 security follow-up FIX 2: `// docs-guard-exempt:` had no ratchet — any
// non-empty reason permanently opted a file out with no cap and no review
// signal. Mirrors scripts/lint-allow-test-rule-refs.cjs's identity ratchet
// (scripts/lib/allowlist-ratchet.cjs).
describe('docs-guard lane: docs-guard-exempt baseline ratchet (#3753 FIX 2)', () => {
  test('an un-baselined exemption fails', () => {
    const violations = checkExemptBaseline(['newly-exempted.test.cjs'], ['already-known.test.cjs']);
    assert.ok(violations.length > 0, 'expected at least one violation for a novel exemption');
    assert.ok(
      violations.some(v => /newly-exempted\.test\.cjs/.test(v.reason) && /add it to the baseline/.test(v.reason)),
      `expected a remedy naming the new file and pointing at the baseline, got: ${JSON.stringify(violations)}`,
    );
    assert.ok(
      violations.some(v => v.reason.includes(EXEMPT_BASELINE_FILE) && v.reason.includes(EXEMPT_BASELINE_CONST)),
      `expected the remedy to cite ${EXEMPT_BASELINE_FILE}:${EXEMPT_BASELINE_CONST}, got: ${JSON.stringify(violations)}`,
    );
  });

  test('a baselined exemption passes', () => {
    const violations = checkExemptBaseline(['already-known.test.cjs'], ['already-known.test.cjs']);
    assert.deepStrictEqual(violations, []);
  });

  test('a baseline entry whose file no longer carries the marker (or was removed) is reported stale', () => {
    const violations = checkExemptBaseline([], ['removed-file.test.cjs']);
    assert.ok(violations.length > 0, 'expected a stale-entry violation');
    assert.ok(
      violations.some(v => /removed-file\.test\.cjs/.test(v.reason) && /prune/i.test(v.reason)),
      `expected a prune-the-stale-entry message naming removed-file.test.cjs, got: ${JSON.stringify(violations)}`,
    );
  });

  test('end-to-end via checkDocsGuardRegistration: an un-baselined marker fails, a baselined one passes', () => {
    withFixtureForExemptBaseline((dir) => {
      fs.writeFileSync(
        path.join(dir, 'novel-exempt.test.cjs'),
        "'use strict';\n// docs-guard-exempt: reads docs only to build an overlay\nconst fs = require('fs');\nfs.readFileSync('docs/foo.md', 'utf8');\n",
      );

      const failing = checkDocsGuardRegistration({ testsDir: dir, registry: [], exemptBaseline: [] });
      assert.strictEqual(failing.ok, false, 'expected an un-baselined docs-guard-exempt marker to fail the lint');
      assert.ok(
        failing.violations.some(v => v.reason.includes('novel-exempt.test.cjs')),
        `expected a violation naming novel-exempt.test.cjs, got: ${JSON.stringify(failing.violations)}`,
      );

      const passing = checkDocsGuardRegistration({
        testsDir: dir,
        registry: [],
        exemptBaseline: ['novel-exempt.test.cjs'],
      });
      assert.strictEqual(passing.ok, true,
        `expected a baselined docs-guard-exempt marker to pass, got: ${JSON.stringify(passing.violations)}`);
    });
  });

  test('the shipped baseline exactly matches every real docs-guard-exempt marker in tests/', () => {
    const result = checkDocsGuardRegistration({
      testsDir: path.join(ROOT, 'tests'),
      registry: DOCS_GUARD_TEST_FILES.map(f => path.basename(f)),
    });
    assert.deepStrictEqual(
      [...result.exemptedFiles].sort(),
      [...DOCS_GUARD_EXEMPT_BASELINE].sort(),
      'scripts/lint-docs-guard-registration.exempt-baseline.cjs must exactly list every real ' +
      'docs-guard-exempt marker currently in tests/ — derived, not retyped from memory',
    );
  });
});

function withFixtureForExemptBaseline(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-guard-exempt-baseline-'));
  try {
    return fn(dir);
  } finally {
    cleanup(dir);
  }
}

// #3753 security follow-up FIX 3: a registry entry equal to a run-tests.cjs
// SUITES token (e.g. a typo'd 'all') would be silently treated by
// selectExplicitFiles (scripts/run-tests.cjs:651) as a suite selector, not a
// filename, running the ENTIRE suite inside the required docs-lint job.
describe('docs-guard lane: registry entries cannot collide with a SUITES token (#3753 FIX 3)', () => {
  test('assertNoSuiteCollision rejects a registry containing a SUITES token', () => {
    assert.throws(
      () => assertNoSuiteCollision(['all']),
      /collides with a run-tests\.cjs SUITES token/,
    );
  });

  test('assertNoSuiteCollision accepts the real, current DOCS_GUARD_TEST_FILES', () => {
    assert.doesNotThrow(() => assertNoSuiteCollision(DOCS_GUARD_TEST_FILES));
  });

  // Security follow-up FIX 1: every real registry key carries the `tests/`
  // prefix by convention, so the realistic typo is 'tests/all', not bare
  // 'all'. Pre-fix, assertNoSuiteCollision compared RAW keys against
  // RUN_TESTS_SUITES and missed this entirely, while run-tests.cjs's own
  // splitFileList strips `tests/` before its SUITES check — letting
  // selectExplicitFiles silently run the ENTIRE suite (824 files) for a
  // 'tests/all' entry inside the required docs-lint job.
  test('assertNoSuiteCollision rejects the realistic tests/-prefixed typo (tests/all)', () => {
    assert.throws(
      () => assertNoSuiteCollision(['tests/all']),
      /collides with a run-tests\.cjs SUITES token/,
    );
  });

  // Same collision spelled with a Windows backslash separator, mirroring
  // run-tests.cjs's own `\`->`/` normalization in splitFileList.
  test('assertNoSuiteCollision rejects a backslash-spelled tests\\all typo', () => {
    assert.throws(
      () => assertNoSuiteCollision(['tests\\all']),
      /collides with a run-tests\.cjs SUITES token/,
    );
  });

  test('deriveDocsGuardRegistry (the lint\'s consumer) also rejects a SUITES-colliding registry', () => {
    // deriveDocsGuardRegistry always reads the real DOCS_GUARD_TEST_FILES
    // module export, so this drives the same assertNoSuiteCollision call it
    // makes internally, directly against a synthetic colliding list —
    // proving the lint's own derivation path (not just the registry module)
    // enforces it.
    assert.throws(() => assertNoSuiteCollision(['unit', ...DOCS_GUARD_TEST_FILES]), /unit/);
  });

  // Parity test (this repo's documented generative-fix-divergence rule):
  // RUN_TESTS_SUITES in scripts/docs-guard-registry.cjs is a hand-maintained
  // duplicate of scripts/run-tests.cjs:50's SUITES (not exported there, and
  // run-tests.cjs's behavior is deliberately out of scope to change for this
  // fix). Verified BEHAVIORALLY, never by re-reading run-tests.cjs's source
  // text: for every token in the duplicate, run-tests.cjs's own exported
  // selectExplicitFiles must treat it as a suite selector (never "not
  // found"); for a control non-member it must NOT.
  test('RUN_TESTS_SUITES stays behaviorally in sync with run-tests.cjs\'s real SUITES', () => {
    const allFiles = walkTestFiles(path.join(ROOT, 'tests'));
    for (const suite of RUN_TESTS_SUITES) {
      const result = selectExplicitFiles(allFiles, suite, null);
      assert.ok(
        !result.error,
        `expected run-tests.cjs to treat "${suite}" as a suite selector, but selectExplicitFiles ` +
        `errored: ${result.error} — RUN_TESTS_SUITES has drifted from the real SUITES`,
      );
    }

    const control = '__not_a_real_suite_or_file__';
    const controlResult = selectExplicitFiles(allFiles, control, null);
    assert.ok(
      controlResult.error && /not found/.test(controlResult.error),
      'control non-member unexpectedly resolved as a suite or file — the parity check itself is not discriminating',
    );
  });
});

describe('docs-guard lane: the workflow', () => {
  test('the docs-required workflow derives from the registry module and runs the registered set, gated on docs_changed, without a paths filter', () => {
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'docs-required.yml');
    assert.ok(fs.existsSync(workflowPath), `expected ${workflowPath} to exist`);

    const text = fs.readFileSync(workflowPath, 'utf8');

    // Deliberately NO `paths:` filter: this workflow must always report a
    // status so it can supply the already-required `docs-lint` context
    // (.github/rulesets/main-protection.json). A `paths:`-filtered workflow
    // never reports on a non-docs PR and therefore can never be made
    // required without hanging every non-docs PR forever.
    assert.doesNotMatch(text, /^\s*paths:/m, 'expected NO `paths:` filter — this workflow must always report a status to be a valid required context');

    // The required-context job id must survive; renaming it would silently
    // un-require the whole gate.
    assert.match(text, /^\s*docs-lint:/m, 'expected the `docs-lint` job id to still be present (it is the required-context name)');

    assert.match(text, /docs-guard-registry\.cjs/, 'expected the workflow to derive its list from scripts/docs-guard-registry.cjs');
    assert.match(text, /run-tests\.cjs/, 'expected a run step invoking run-tests.cjs');
    assert.match(text, /--files-from/, 'expected the run step to use --files-from');

    // The registry run must be gated on the same docs_changed detection this
    // job already computes, so it does not run (and cannot fail) on
    // non-docs PRs.
    assert.match(
      text,
      /steps\.docs-changed\.outputs\.docs_changed == 'true'/,
      'expected the docs-guard registry steps to be gated on steps.docs-changed.outputs.docs_changed',
    );
  });

  // Second reviewer finding: the derivation step used to throw only when the
  // rule/module was absent, never asserting the derived list was NON-EMPTY.
  // Probed: `run-tests.cjs --files-from <file with only a blank line>` prints
  // 'run-tests: no tests in suite "all"' and exits 0 — an emptied registry
  // would yield a GREEN check having run zero tests, precisely the failure
  // mode #3753 exists to close.
  test('the workflow fails loudly if the derived registry file ends up empty', () => {
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'docs-required.yml');
    const text = fs.readFileSync(workflowPath, 'utf8');
    assert.match(
      text,
      /-s\s+\.docs-guard-tests\.txt/,
      'expected the workflow to check the derived file is non-empty (e.g. `[ -s .docs-guard-tests.txt ]`) ' +
      'before running run-tests.cjs against it',
    );
  });

  // Security follow-up FIX 5: a fork PR could FORCE-COMMIT
  // `.docs-guard-tests.txt` (gitignored files are still addable with
  // `git add -f`), which would satisfy `hashFiles('.docs-guard-tests.txt')
  // != ''` and run an attacker-chosen test list. The fix rm -f's any
  // committed copy at the start of selection, and gates the run step on an
  // explicit step OUTPUT the selection step itself sets — never on hashFiles.
  test('the selection step destroys any pre-existing copy of its output files before regenerating them', () => {
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'docs-required.yml');
    const text = fs.readFileSync(workflowPath, 'utf8');
    assert.match(
      text,
      /rm -f \.docs-guard-tests\.txt \.docs-changed-paths\.txt/,
      'expected the selection step to `rm -f` both derived files before regenerating them, so a ' +
      'force-committed copy cannot survive into the run',
    );
  });

  test('the run step is gated on an explicit step output, never on hashFiles', () => {
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'docs-required.yml');
    const text = fs.readFileSync(workflowPath, 'utf8');

    // Assert the real gate property (parsed `if:` expressions), not a
    // raw-text scan: `hashFiles(` legitimately appears in COMMENTS explaining
    // why hashFiles was rejected, and a source-text ban on the substring
    // fails on those comments even though no step is actually gated on it.
    const ifExpressions = splitLines(text)
      .map(line => line.trim())
      .filter(line => line.startsWith('if:'));
    assert.ok(ifExpressions.length > 0, 'expected at least one `if:` expression in the workflow');
    for (const expr of ifExpressions) {
      assert.doesNotMatch(
        expr,
        /hashFiles\(/,
        'expected NO step to be gated (via `if:`) on hashFiles(...) — a force-committed ' +
        `.docs-guard-tests.txt would satisfy hashFiles() != '' and run an attacker-chosen test list. Offending expression: ${expr}`,
      );
    }

    assert.match(
      text,
      /GITHUB_OUTPUT.*selected=true/,
      'expected the selection step to set an explicit selected=true step output only on the ' +
      'code path that legitimately wrote .docs-guard-tests.txt',
    );

    const runStepIfExpression = ifExpressions.find(expr => expr.includes('select-docs-guards.outputs.selected'));
    assert.ok(
      runStepIfExpression,
      `expected an if: expression gating the run step on steps.select-docs-guards.outputs.selected, ` +
      `found: ${JSON.stringify(ifExpressions)}`,
    );
    assert.match(
      runStepIfExpression,
      /steps\.select-docs-guards\.outputs\.selected == 'true'/,
      'expected the run step to be gated on steps.select-docs-guards.outputs.selected, not on hashFiles',
    );
  });

  // Guard-can-fail proof: a hypothetical `if: hashFiles('x') != ''` line must
  // trip the ifExpressions scan above. Exercised directly against the parsing
  // logic (not by mutating the shipped workflow) so this stays a fast,
  // deterministic unit check.
  test('the if: hashFiles scan can actually fail (guard is not vacuous)', () => {
    const hypothetical = "  run:\n    if: hashFiles('.docs-guard-tests.txt') != ''\n";
    const ifExpressions = splitLines(hypothetical)
      .map(line => line.trim())
      .filter(line => line.startsWith('if:'));
    assert.ok(ifExpressions.some(expr => /hashFiles\(/.test(expr)), 'expected the hypothetical hashFiles gate to be detected by the scan');
  });
});

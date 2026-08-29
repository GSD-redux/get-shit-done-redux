#!/usr/bin/env node
'use strict';

/**
 * docs-guard-registry.cjs — the sole source of truth for which doc-reading
 * test files the docs-guard lane must run.
 *
 * ## Why this is its own module, not a `scripts/ci-test-scope.cjs` RULE
 *
 * A prior version of this PR added a `docs guards` RULE to `RULES` in
 * scripts/ci-test-scope.cjs, on the theory that classify()'s `!codeChanged`
 * normalization (which zeroes fullMatrix/targeted_tests/windows_tests for
 * docs-only diffs) made the RULE inert to classify()'s scope decision.
 *
 * That is true for docs-ONLY diffs and FALSE for MIXED docs+code diffs:
 * `codeChanged` is true whenever ANY changed file is product/pipeline code,
 * so the normalization never runs, and every one of this registry's test
 * files joined `targeted_tests` for every mixed PR. Probed on that version:
 * `node scripts/ci-test-scope.cjs --files "docs/a.md src/semver.cts"`
 * returned 25 targeted_tests, vs. 3 on `origin/next` — an unstated blowup
 * of the scoped/targeted lane on every mixed docs+code PR.
 *
 * Root cause: `RULES` answers "given these changed files, what should
 * test.yml run" for the MAIN scoped-lane pipeline. The docs-guard registry
 * is a LANE MANIFEST for a completely different consumer (the `docs-lint`
 * job in .github/workflows/docs-required.yml, gated on a `docs_changed`
 * step output). Putting a lane manifest inside a scope-classification rule
 * set was the defect; extracting it here removes any path by which it can
 * influence classify() at all.
 *
 * ## Who reads this
 *
 * - .github/workflows/docs-required.yml (`docs-lint` job) — derives the
 *   PER-PR-SELECTED subset of this registry from scripts/select-docs-guards.cjs,
 *   which is itself driven by this module's DOCS_GUARD_TESTS map. This job has
 *   no `paths:` filter, so it always reports a status and can supply the
 *   already-required `docs-lint` context; a dedicated `paths:`-filtered
 *   workflow cannot be made required without hanging non-docs PRs forever.
 * - scripts/lint-docs-guard-registration.cjs — derives its registration
 *   lint's comparison set from this module (so a docs-reading test file
 *   that is neither registered here nor exempted fails the lint).
 * - scripts/select-docs-guards.cjs — the pure selector that maps a PR's
 *   changed docs/ paths to the subset of this registry that actually needs
 *   to run (#3753 follow-up: a flat "run everything" list is disproportionate
 *   for a single-file docs typo fix).
 *
 * ## Registry shape (#3753 follow-up)
 *
 * `DOCS_GUARD_TESTS` is a MAP from test file path to the array of docs/
 * paths it actually reads, so a changed-docs-file can be resolved to the
 * narrow subset of guards that read it, instead of always running the
 * entire registry. Each value is a non-empty array of PATTERNS:
 *
 *   - a plain path (e.g. `'docs/AGENTS.md'`) matches that exact file only;
 *   - a trailing-slash path (e.g. `'docs/adr/'`) matches any changed path
 *     under that directory prefix — use this for a test that walks or
 *     `readdirSync`s a whole docs/ subdirectory;
 *   - the sentinel `'*'` means "run on ANY docs/ change" — reserved for a
 *     test that cannot be resolved to a narrower set of paths (the path is
 *     computed, looped over an unresolvable variable, or the test walks
 *     docs/ generally). Conservative fallback: when in doubt, use `'*'`,
 *     never a guessed-narrow path — a false negative here (a guard that
 *     silently stops running) is exactly the #3753 defect class this
 *     registry exists to prevent.
 *
 * `DOCS_GUARD_TEST_FILES` (derived: `Object.keys(DOCS_GUARD_TESTS)`) is kept
 * as a flat array export so the registration lint and its parity test
 * continue to consume a plain file list without needing to know about the
 * map shape.
 *
 * ## Adding a docs guard
 *
 * Add the test file's path (relative to the repo root, `tests/<file>`) as a
 * key in DOCS_GUARD_TESTS below, with the docs/ paths it reads as the value
 * (or `['*']` if that cannot be resolved narrowly). Do not duplicate this
 * list anywhere else — a second, independently maintained list is exactly
 * the #3753 defect class (10 registered-but-not-run guards, silently
 * drifted) this registry exists to prevent from recurring.
 *
 * Sorted alphabetically by basename for unambiguous diffs.
 */

/**
 * Duplicate of scripts/run-tests.cjs:50's `SUITES` array. That array is not
 * exported by run-tests.cjs (module.exports there is deliberately narrow;
 * run-tests.cjs's own behavior is intentional and out of scope for this
 * registry to alter), so it cannot be imported directly without changing a
 * shared, behavior-locked file.
 *
 * Why this must exist at all: `run-tests.cjs`'s `selectExplicitFiles`
 * (scripts/run-tests.cjs:651) treats any registry entry that EQUALS a
 * SUITES member (e.g. `all`, `unit`) as a suite selector, not a filename —
 * so a typo in DOCS_GUARD_TESTS matching a suite name would silently run
 * the ENTIRE suite inside the required `docs-lint` job instead of erroring.
 * `assertNoSuiteCollision` below rejects that at the registry boundary
 * instead.
 *
 * Divergence risk: if run-tests.cjs's real SUITES list ever changes and this
 * copy is not updated, this check could under- or over-reject. That risk is
 * covered by a parity test (tests/ci-docs-guard-registry.test.cjs) that
 * drives run-tests.cjs's own exported `selectExplicitFiles` behaviorally —
 * for every token here it asserts run-tests.cjs treats it as a suite
 * selector (never "file not found"), and for a control non-member it
 * asserts the opposite — so a real divergence fails that test rather than
 * silently drifting.
 */
const RUN_TESTS_SUITES = ['all', 'unit', 'integration', 'install', 'security', 'slow', 'qa'];

/**
 * Normalize a registry entry EXACTLY the way scripts/run-tests.cjs's
 * `splitFileList` (:617-625) normalizes a requested token before its SUITES
 * check (:651): strip a leading `tests/` and normalize `\`->`/`. Without this,
 * comparing RAW registry keys (which all carry the `tests/` prefix by
 * convention) against RUN_TESTS_SUITES misses the realistic typo `'tests/all'`
 * entirely — proven by probe: `assertNoSuiteCollision(['tests/all'])` did not
 * throw, and `selectExplicitFiles(allFiles, 'tests/all')` selected all 824
 * files (the whole suite) inside the required docs-lint job.
 *
 * @param {string} t
 * @returns {string}
 */
function normalizeForSuiteCheck(t) {
  return t.replace(/\\/g, '/').replace(/^tests\//, '');
}

/**
 * Reject any docs-guard registry entry that collides with a run-tests.cjs
 * suite token (see RUN_TESTS_SUITES doc comment above). Throws with every
 * offending entry named, rather than failing on only the first. Compares
 * entries AFTER normalizeForSuiteCheck, mirroring run-tests.cjs's own
 * splitFileList normalization, so a `tests/`-prefixed or backslash-spelled
 * entry that would collide post-normalization is caught here too.
 *
 * @param {string[]} tests
 */
function assertNoSuiteCollision(tests) {
  const collisions = tests.filter((t) => RUN_TESTS_SUITES.includes(normalizeForSuiteCheck(t)));
  if (collisions.length > 0) {
    throw new Error(
      'docs-guard-registry: DOCS_GUARD_TESTS entry collides with a run-tests.cjs SUITES token ' +
        `(${collisions.join(', ')}) — scripts/run-tests.cjs:651's selectExplicitFiles treats a ` +
        'registry entry that equals a suite name as a suite selector, not a filename, so this ' +
        'would silently run the entire suite instead of the intended file(s). Fix the registry entry.',
    );
  }
}

/**
 * Map from docs-guard test file to the docs/ path patterns it reads. See
 * this module's header comment for pattern semantics (exact / trailing-slash
 * dir-prefix / `'*'` sentinel). Every value here was derived by reading the
 * test file's actual read call(s) — not guessed — per #3753's own lesson: an
 * unresolvable read is recorded as `'*'`, never a narrowed guess.
 */
const DOCS_GUARD_TESTS = {
  'tests/adr-15-progress-converge.test.cjs': [
    'docs/COMMANDS.md',
    'docs/how-to/run-phases-autonomously.md',
  ],
  // Walks docs/adr/ as a directory (builds/reads docs/adr/README.md and
  // fixture ADRs throughout) and separately reads docs/contributor-standards.md.
  'tests/adr-index-gate.test.cjs': ['docs/adr/', 'docs/contributor-standards.md'],

  // Walks docs/features/ as a directory (the fragment corpus) and asserts the
  // committed docs/FEATURES.md equals the generated projection of it (#3840).
  'tests/features-index-gate.test.cjs': ['docs/features/', 'docs/FEATURES.md'],
  'tests/agent-classification-parity.test.cjs': ['docs/AGENTS.md', 'docs/INVENTORY.md'],
  // #3683: pins the learnings feature section's agreement with the canonical
  // artifact registry (reads docs/FEATURES.md around the extract-learnings
  // entry).
  'tests/learnings.test.cjs': ['docs/FEATURES.md'],
  'tests/analyze-dependencies.test.cjs': ['docs/COMMANDS.md'],
  'tests/autonomous-converge.test.cjs': [
    'docs/COMMANDS.md',
    'docs/how-to/run-phases-autonomously.md',
  ],
  'tests/capability-matrix-sync.test.cjs': ['docs/reference/capability-matrix.md'],
  'tests/capability-registry.test.cjs': [
    'docs/tutorials/build-your-first-capability.md',
    'docs/tutorials/install-your-first-capability.md',
    'docs/reference/capability-manifest.md',
  ],
  'tests/claude-md.test.cjs': ['docs/COMMANDS.md'],
  'tests/claude-orchestration.test.cjs': ['docs/explanation/claude-orchestration-capability.md'],
  'tests/command-contract.test.cjs': [
    'docs/INVENTORY.md',
    'docs/ja-JP/INVENTORY.md',
    'docs/ko-KR/INVENTORY.md',
    'docs/zh-CN/INVENTORY.md',
    'docs/pt-BR/INVENTORY.md',
  ],
  // uncoveredFiles(...) scans 'docs' as a generic coverage-scan root
  // (commit-files-pathspec.test.cjs:1618) — cannot be resolved to specific
  // files without re-deriving the scan's own file-discovery logic.
  'tests/commit-files-pathspec.test.cjs': ['*'],
  'tests/config-field-docs.test.cjs': ['docs/CONFIGURATION.md'],
  'tests/config.test.cjs': ['docs/CONFIGURATION.md'],
  'tests/context-index-sync.test.cjs': ['docs/CONTEXT-INDEX.json'],
  'tests/context-predicates-query.test.cjs': ['docs/contributor-standards.md'],
  // SCAN_DIRS includes 'docs' and recursively walks every .md file under it
  // (context7-tool-name-parity.test.cjs:31-38) — a generic tree walk, not a
  // fixed file set.
  'tests/context7-tool-name-parity.test.cjs': ['*'],
  'tests/contributor-standards.test.cjs': ['docs/contributor-standards.md'],
  'tests/cursor-reviewer.test.cjs': [
    'docs/COMMANDS.md',
    'docs/FEATURES.md',
    'docs/ja-JP/COMMANDS.md',
    'docs/ja-JP/FEATURES.md',
    'docs/ko-KR/COMMANDS.md',
    'docs/ko-KR/FEATURES.md',
  ],
  'tests/discuss-all-flag.test.cjs': ['docs/COMMANDS.md'],
  'tests/discuss-mode.test.cjs': ['docs/workflow-discuss-mode.md'],
  // Walks docs/*.md and every docs/<locale>/*.md dir dynamically
  // (docs-parity-live-registry.test.cjs:42, 428) — deliberately generic.
  'tests/docs-parity-live-registry.test.cjs': ['*'],
  // #3839: pins every hook-table Event cell in the five locales' ARCHITECTURE
  // and INVENTORY files against src/runtime-hooks-surface.cts registrations.
  'tests/docs-hooks-table-parity.test.cjs': [
    'docs/ARCHITECTURE.md',
    'docs/INVENTORY.md',
    'docs/ja-JP/ARCHITECTURE.md',
    'docs/ja-JP/INVENTORY.md',
    'docs/zh-CN/ARCHITECTURE.md',
    'docs/zh-CN/INVENTORY.md',
    'docs/ko-KR/ARCHITECTURE.md',
    'docs/ko-KR/INVENTORY.md',
    'docs/pt-BR/ARCHITECTURE.md',
    'docs/pt-BR/INVENTORY.md',
  ],
  'tests/docs-state-md-locale-parity.test.cjs': [
    'docs/reference/state-md.md',
    'docs/ja-JP/reference/state-md.md',
    'docs/zh-CN/reference/state-md.md',
    'docs/ko-KR/reference/state-md.md',
    'docs/pt-BR/reference/state-md.md',
  ],
  'tests/drift-detection.test.cjs': ['docs/CONFIGURATION.md', 'docs/AGENTS.md'],
  'tests/edge-probe-docs-fixtures.test.cjs': ['docs/adr/550-spec-phase-probe-contract.md'],
  'tests/edit-phase.test.cjs': [
    'docs/INVENTORY.md',
    'docs/INVENTORY-MANIFEST.json',
    'docs/COMMANDS.md',
  ],
  'tests/effort-surface-axis.test.cjs': ['docs/reference/host-integration-capability-matrix.md'],
  'tests/execute-phase-active-flags.test.cjs': [
    'docs/reference/host-integration-capability-matrix.md',
  ],
  'tests/execute-phase-wave.test.cjs': ['docs/COMMANDS.md'],
  // #3913 (ADR-3889 terminal phase): reads the generated docs/reference/exit-codes.md
  // (content invariants, F1/F3) and docs/README.md (F4, the index link).
  'tests/exit-code-registry.test.cjs': ['docs/reference/exit-codes.md', 'docs/README.md'],
  'tests/external-job-waiting.test.cjs': ['docs/reference/planning-artifacts.md'],
  // Rows 8/9 (negative controls) read real docs/registries/eos.json and
  // docs/adr/0001-dispatch-policy-module.md and assert on their EXACT
  // committed content (an entry's name field, ADR-0001's H1 title) as a
  // sanity check before mutating an overlay fixture — a content edit to
  // either file changes the string this test asserts on.
  'tests/fragment-single-edit-propagation.install.test.cjs': [
    'docs/registries/eos.json',
    'docs/adr/0001-dispatch-policy-module.md',
  ],
  // Seeds a temp fixture copy of these five files (never mutates the real
  // tree) to exercise scripts/gen-state-md-docs.cjs's marked-region splicing
  // against them — #3873 (ADR-3473 §8.8), rows 10-22/27. Read for fixture
  // seeding, so a content edit to any of them (e.g. renaming a landmark
  // heading/string a hostile-input test targets) can change this test's
  // fixture assumptions.
  'tests/gen-state-md-docs.test.cjs': [
    'docs/reference/state-md.md',
    'docs/ja-JP/reference/state-md.md',
    'docs/zh-CN/reference/state-md.md',
    'docs/ko-KR/reference/state-md.md',
    'docs/pt-BR/reference/state-md.md',
  ],
  'tests/gsd-write-guard.test.cjs': ['docs/USER-GUIDE.md'],
  'tests/host-integration-descriptors.test.cjs': [
    'docs/reference/host-integration-capability-matrix.md',
  ],
  'tests/install.test.cjs': ['docs/AGENTS.md', 'docs/INVENTORY.md', 'docs/INVENTORY-MANIFEST.json'],
  // SOURCE_DIRS includes 'docs' and walks it recursively for every .md file
  // (intel.test.cjs:1223-1228) — a generic tree walk.
  'tests/intel.test.cjs': ['*'],
  'tests/inventory-headings-countfree.test.cjs': ['docs/INVENTORY.md'],
  'tests/inventory-manifest-sync.test.cjs': ['docs/INVENTORY.md', 'docs/INVENTORY-MANIFEST.json'],
  'tests/kilo-upgrades.test.cjs': ['docs/how-to/connect-gsd-mcp-server.md'],
  'tests/live-config-guard.test.cjs': ['docs/TESTING-SUITES.md'],
  'tests/model-catalog-runtime-defaults.test.cjs': ['docs/CONFIGURATION.md'],
  // Scans every git-tracked file in the whole repo via `git ls-files`
  // (no-pending-3212-markers.test.cjs:37-46), which includes all of docs/ —
  // cannot be resolved to a fixed docs/ path set.
  'tests/no-pending-3212-markers.test.cjs': ['*'],
  'tests/phase6-capability-docs.test.cjs': ['docs/how-to/develop-a-capability.md', 'docs/README.md'],
  'tests/phase6-review-capabilities.test.cjs': [
    'docs/reference/review-verification-capabilities.md',
    'docs/how-to/develop-a-capability.md',
    'docs/README.md',
  ],
  'tests/plan-checker-coupling.test.cjs': ['docs/AGENTS.md'],
  'tests/plan-phase-drift-guard.test.cjs': [
    'docs/CONFIGURATION.md',
    'docs/COMMANDS.md',
    'docs/USER-GUIDE.md',
    'docs/ARCHITECTURE.md',
    'docs/INVENTORY.md',
    'docs/INVENTORY-MANIFEST.json',
  ],
  'tests/plan-phase-stall-detection.test.cjs': ['docs/CONFIGURATION.md'],
  'tests/plan-review-convergence.test.cjs': [
    'docs/CONFIGURATION.md',
    'docs/USER-GUIDE.md',
    'docs/ARCHITECTURE.md',
  ],
  'tests/planner-estimate-emission.test.cjs': ['docs/reference/plan-md.md', 'docs/CONFIGURATION.md'],
  'tests/precondition-element.test.cjs': ['docs/reference/plan-md.md'],
  'tests/product-name-purity.test.cjs': [
    'docs/README.md',
    'docs/zh-CN/README.md',
    'docs/ko-KR/README.md',
    'docs/ja-JP/README.md',
    'docs/pt-BR/README.md',
  ],
  'tests/progress-forensic.test.cjs': ['docs/COMMANDS.md'],
  'tests/repo-layout.test.cjs': ['docs/contributing/bootstrap.md'],
  'tests/reversibility-tagging.test.cjs': ['docs/reference/plan-md.md'],
  'tests/reviewer-docs-parity.test.cjs': [
    'docs/COMMANDS.md',
    'docs/ja-JP/COMMANDS.md',
    'docs/ko-KR/COMMANDS.md',
    'docs/pt-BR/COMMANDS.md',
    'docs/zh-CN/COMMANDS.md',
    'docs/FEATURES.md',
    'docs/ja-JP/FEATURES.md',
    'docs/ko-KR/FEATURES.md',
    'docs/pt-BR/FEATURES.md',
    'docs/zh-CN/FEATURES.md',
  ],
  'tests/runtime-converters.test.cjs': ['docs/CONFIGURATION.md'],
  'tests/secure-phase.test.cjs': ['docs/CONFIGURATION.md'],
  'tests/security-dead-exports.regression.test.cjs': ['docs/FEATURES.md'],
  'tests/security.test.cjs': ['docs/INVENTORY-MANIFEST.json'],
  // Walks docs/ recursively (todos-done-rename-guard.test.cjs:19-22
  // SCAN_DIRS) looking for stale references — a generic tree walk.
  'tests/todos-done-rename-guard.test.cjs': ['*'],
  'tests/tracer-bullet.test.cjs': [
    'docs/COMMANDS.md',
    'docs/reference/plan-md.md',
    'docs/how-to/plan-a-phase.md',
    'docs/AGENTS.md',
  ],
  'tests/ui-spec-inventory-provenance.test.cjs': [
    'docs/FEATURES.md',
    'docs/how-to/design-a-ui-phase.md',
    'docs/ja-JP/FEATURES.md',
    'docs/ja-JP/how-to/design-a-ui-phase.md',
    'docs/zh-CN/FEATURES.md',
    'docs/zh-CN/how-to/design-a-ui-phase.md',
    'docs/ko-KR/FEATURES.md',
    'docs/ko-KR/how-to/design-a-ui-phase.md',
    'docs/pt-BR/how-to/design-a-ui-phase.md',
  ],
  'tests/verifier-behavior-unverified.test.cjs': ['docs/reference/planning-artifacts.md'],
  'tests/verifier-coincidental-reliance.test.cjs': ['docs/AGENTS.md'],
  'tests/verify.test.cjs': ['docs/reference/plan-md.md'],
  'tests/workflow-fragments.test.cjs': ['docs/reference/workflow-fragments.md'],
};

/**
 * Flat file-list view of DOCS_GUARD_TESTS, kept for consumers (the
 * registration lint and its parity test) that only need "which test files
 * are registered", not their per-file docs path patterns.
 */
const DOCS_GUARD_TEST_FILES = Object.keys(DOCS_GUARD_TESTS);

assertNoSuiteCollision(DOCS_GUARD_TEST_FILES);

module.exports = {
  DOCS_GUARD_TESTS,
  DOCS_GUARD_TEST_FILES,
  RUN_TESTS_SUITES,
  assertNoSuiteCollision,
  normalizeForSuiteCheck,
};

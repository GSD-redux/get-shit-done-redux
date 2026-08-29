'use strict';

/**
 * Pinned baseline for scripts/lint-docs-guard-registration.cjs's
 * `docs-guard-exempt` identity ratchet — mirrors
 * scripts/lint-allow-test-rule-refs.cjs's `allow-test-rule` ratchet
 * (scripts/lib/allowlist-ratchet.cjs, ADR-456's pattern).
 *
 * Every test file basename here is a KNOWN, already-reviewed
 * `// docs-guard-exempt: <reason>` marker. Nothing caps how many files may
 * carry the marker in the abstract, but ADDING a new one anywhere in
 * tests/*.test.cjs fails `lint-docs-guard-registration` until this baseline
 * is deliberately updated — so a new exemption always shows up as a
 * reviewable diff here, instead of silently opting a file out of the
 * docs-guard registration requirement with zero signal.
 *
 * A file listed here that no longer exists, or no longer carries a real
 * `docs-guard-exempt:` marker in its first 20 lines, is reported STALE and
 * must be pruned (ratchet-down, same as the sibling gate).
 *
 * Seeded 2026-08-23 (#3753 security follow-up FIX 2) from every real marker
 * found via scripts/lint-docs-guard-registration.cjs's own `findExemption`
 * scan of tests/*.test.cjs — derived, not retyped from memory.
 *
 * Extended 2026-08-23 (#3753 correctness follow-up): the reader-detection
 * fixes (Defects A/B/C) surfaced 86 previously-undetected docs/ readers. 40
 * were genuine docs-content guards (added to DOCS_GUARD_TESTS in
 * scripts/docs-guard-registry.cjs); the 46 added here touch a docs/ path
 * only incidentally (fixture data, external URL citations, comment-only
 * mentions, metadata labels, or scan-exclusion lists) — see each file's own
 * `docs-guard-exempt:` marker for its specific reason.
 */
const DOCS_GUARD_EXEMPT_BASELINE = [
  'adr-parser.test.cjs',
  'adr-parser.unit.test.cjs',
  'agent-marker-documentation-guard.test.cjs',
  'antigravity-upgrades.test.cjs',
  'capability-cli.test.cjs',
  'capability-validator-task-content-resolver.test.cjs',
  'ci-docs-guard-registry.test.cjs',
  'ci-test-scope.test.cjs',
  'cline-install.test.cjs',
  'code-review-depth.test.cjs',
  'code-review-pipeline-regression.test.cjs',
  'codebuddy-upgrades.test.cjs',
  'commands.test.cjs',
  'commit-docs-bypass.test.cjs',
  'complexity-trigger.test.cjs',
  'concurrency-safety.test.cjs',
  'cursor-imperative-reference.test.cjs',
  'declarative-reference-antigravity.test.cjs',
  'declarative-reference-zcode.test.cjs',
  'emitted-attribution.test.cjs',
  'eslint-rules.test.cjs',
  'estimate-calibrate.test.cjs',
  'gen-context-index.test.cjs',
  'gen-registry.test.cjs',
  'gsd-agent-isolation-guard.test.cjs',
  'hermes-dispatch-upgrade.test.cjs',
  'install-minimal-hooks.test.cjs',
  'install-runtime-artifacts.test.cjs',
  'installer-migration-config-root-marker.test.cjs',
  'installer-migration-pi-extension-ext.test.cjs',
  'installer-migrations.test.cjs',
  'kimi-upgrades.test.cjs',
  'lint-allow-test-rule-refs.test.cjs',
  'lint-docs-command-form.test.cjs',
  'lint-docs-required.test.cjs',
  'manifest-version-sync.test.cjs',
  'milestone-archive.test.cjs',
  'model-resolver.test.cjs',
  'new-project-mvp-prompt.test.cjs',
  'onboard-command.test.cjs',
  'opencode-command-dir-plural.test.cjs',
  'phase.test.cjs',
  'pr-branch-planning-filter.test.cjs',
  'precommit-alias-drift-hook.test.cjs',
  'removed-but-needed-lint.test.cjs',
  'repo-invariants.test.cjs',
  'require-issue-link-policy.test.cjs',
  'reviewer-manifest-body.test.cjs',
  'run-tests-harness.test.cjs',
  'runtime-name-policy.test.cjs',
  'security-prompt-injection.security.test.cjs',
  'shipped-reference-cites.test.cjs',
  'state.test.cjs',
  'worktree-safety.test.cjs',
];

/**
 * Security follow-up FIX 3: a per-file fingerprint of every distinct
 * `docs/...` path TOKEN referenced by each baselined file (derived via
 * scripts/lint-docs-guard-registration.cjs's `extractDocsPathReferences`,
 * never retyped from memory). A baselined file whose live fingerprint
 * DIFFERS from the recorded one here fails the lint — the exemption's
 * premise ("this file doesn't really guard shipped docs content") may no
 * longer hold and a human must re-confirm it before the entry is updated.
 * Keeping this a plain, sorted, diffable path list (not a hash) is
 * deliberate: a reviewer can see exactly WHAT changed from the PR diff
 * alone.
 *
 * Seeded 2026-08-23 alongside DOCS_GUARD_EXEMPT_BASELINE above, from the
 * exact same scan.
 */
const DOCS_GUARD_EXEMPT_DOCS_PATHS = {
  'adr-parser.test.cjs': ['docs/adr/0001.md', 'docs/adr/0002.md', 'docs/adr/0010.md', 'docs/adr/NNNN.md'],
  'adr-parser.unit.test.cjs': ['docs/adr/0001.md', 'docs/adr/0099.md', 'docs/adr/NNNN.md'],
  'agent-marker-documentation-guard.test.cjs': ['docs/reference', 'docs/reference/workflow-fragments.md'],
  'antigravity-upgrades.test.cjs': ['docs/cli', 'docs/cli/gcli-migration', 'docs/cli/permissions'],
  'capability-cli.test.cjs': ['docs/reference/gsd-capability-command.md'],
  // #3970: cites docs/adr/3646-per-task-content-resolution-seam.md in an
  // explanatory comment describing ADR-3646's Decision 3; the file never
  // reads that (or any) docs/ file.
  'capability-validator-task-content-resolver.test.cjs': ['docs/adr/3646-per-task-content-resolution-seam.md'],
  'ci-docs-guard-registry.test.cjs': [
    'docs/AGENTS.md', 'docs/COMMANDS.md', 'docs/INVENTORY.md', 'docs/a.md', 'docs/adr',
    'docs/adr/0001-example.md', 'docs/adrenaline.md', 'docs/bar.md', 'docs/foo.md', 'docs/how-to/foo.md',
    'docs/how-to/some-unrelated-guide.md', 'docs/how-to/x.md', 'docs/some-unrelated-file.md',
    'docs/totally-unrelated.md',
  ],
  'ci-test-scope.test.cjs': [
    'docs/a.md', 'docs/adr', 'docs/adr/22-plan-drift-guard.md', 'docs/how-to/configure-model-profiles.md',
    'docs/installer-migrations.md', 'docs/ja-JP', 'docs/ja-JP/USAGE.md', 'docs/usage.md', 'docs/x.md',
  ],
  'cline-install.test.cjs': ['docs/guide.md'],
  'code-review-depth.test.cjs': ['docs/src/auth/x.ts'],
  'code-review-pipeline-regression.test.cjs': ['docs/DEVELOPMENT.md'],
  'codebuddy-upgrades.test.cjs': ['docs/cli/sub-agents'],
  'commands.test.cjs': ['docs/x.md'],
  'commit-docs-bypass.test.cjs': [
    'docs/40-design.md', 'docs/CONFIGURATION.md', 'docs/readme.md', 'docs/tracked-var-mentioning',
  ],
  'complexity-trigger.test.cjs': ['docs/readme.md'],
  // #3884: cites docs/CLI-TOOLS.md:736 in an explanatory comment describing
  // the real `frontmatter get <file> [--field key]` CLI shape; the file
  // never reads that (or any) docs/ file.
  'concurrency-safety.test.cjs': ['docs/CLI-TOOLS.md'],
  'cursor-imperative-reference.test.cjs': ['docs/sdk/typescript'],
  'declarative-reference-antigravity.test.cjs': ['docs/cli/features'],
  'declarative-reference-zcode.test.cjs': ['docs/reference/host-integration-capability-matrix.md'],
  'emitted-attribution.test.cjs': ['docs/README.md', 'docs/tests', 'docs/tests/helpers/install-shared.cjs'],
  // #3914: cites docs/adr/3889-process-exit-contract.md ~:350-362 in an
  // explanatory comment describing the intentional computed-property
  // boundary move; the file never reads that (or any) docs/ file.
  'eslint-rules.test.cjs': ['docs/adr/3889-process-exit-contract.md', 'docs/readme.md'],
  'estimate-calibrate.test.cjs': [
    'docs/adr', 'docs/adr/2629-phase-effort-estimation-calibration.md', 'docs/reference',
    'docs/reference/planning-artifacts.md',
  ],
  'gen-context-index.test.cjs': ['docs/CONTEXT-INDEX.json', 'docs/INVENTORY-MANIFEST.json'],
  'gen-registry.test.cjs': ['docs/registries', 'docs/registries/reviewers.json'],
  'gsd-agent-isolation-guard.test.cjs': ['docs/adr/1239-...md', 'docs/adr/1239-gsd-embeddable-orchestration-engine.md'],
  'hermes-dispatch-upgrade.test.cjs': ['docs/guides/delegation-patterns.md'],
  'install-minimal-hooks.test.cjs': ['docs/en/hooks', 'docs/en/users/features/hooks'],
  'install-runtime-artifacts.test.cjs': ['docs/CONFIGURATION.md', 'docs/adr/58-...md', 'docs/adr/58-runtime-install-policy-module.md', 'docs/cli/slash-commands'],
  'installer-migration-config-root-marker.test.cjs': ['docs/installer-migrations.md'],
  'installer-migration-pi-extension-ext.test.cjs': ['docs/installer-migrations.md'],
  'installer-migrations.test.cjs': ['docs/installer-migrations.md'],
  'kimi-upgrades.test.cjs': ['docs/reference/host-integration-capability-matrix.md'],
  'lint-allow-test-rule-refs.test.cjs': ['docs/readme.md'],
  'lint-docs-command-form.test.cjs': ['docs/adr', 'docs/adr/999-example.md', 'docs/how-to/example.md'],
  'lint-docs-required.test.cjs': [
    'docs/COMMANDS.md', 'docs/USER-GUIDE.md', 'docs/adr', 'docs/adr/0001-foo.md', 'docs/adr/0099-new.md',
    'docs/agents', 'docs/agents/triage-labels.md',
  ],
  'manifest-version-sync.test.cjs': [],
  // #3884: re-confirmed — the added docs/CLI-TOOLS.md:458 reference is the
  // same class as the existing docs/TESTING-SUITES.md one (a placement-note
  // / explanatory comment citing documented CLI behavior for context, never
  // a read target); the exemption's premise still holds for both.
  'milestone-archive.test.cjs': ['docs/CLI-TOOLS.md', 'docs/TESTING-SUITES.md'],
  'model-resolver.test.cjs': ['docs/TESTING-SUITES.md'],
  'new-project-mvp-prompt.test.cjs': ['docs/CONFIGURATION.md'],
  'onboard-command.test.cjs': ['docs/adr/0001-runtime.md'],
  'opencode-command-dir-plural.test.cjs': ['docs/commands'],
  'phase.test.cjs': ['docs/adr/3524-...md', 'docs/adr/3524-cjs-sdk-hard-seam.md'],
  'pr-branch-planning-filter.test.cjs': ['docs/readme.md'],
  'precommit-alias-drift-hook.test.cjs': ['docs/adr/0174-...md', 'docs/adr/0174-retire-gsd-sdk-package-boundary.md'],
  'removed-but-needed-lint.test.cjs': [
    'docs/README.md', 'docs/getting-started.md', 'docs/gsd-new-workspace.md', 'docs/setup.md', 'docs/some-doc.md',
  ],
  'repo-invariants.test.cjs': ['docs/FEATURES.md', 'docs/workflows/README'],
  'require-issue-link-policy.test.cjs': ['docs/-prefixed', 'docs/CONFIGURATION.md', 'docs/a.md', 'docs/b.md', 'docs/guide.md'],
  'reviewer-manifest-body.test.cjs': ['docs/how-to/ship-a-reviewer-lane.md'],
  'run-tests-harness.test.cjs': ['docs/TESTING-SUITES.md'],
  'runtime-name-policy.test.cjs': ['docs/customize/skills'],
  'security-prompt-injection.security.test.cjs': ['docs/notes.md'],
  'shipped-reference-cites.test.cjs': [],
  'state.test.cjs': ['docs/CONFIGURATION.md', 'docs/reference/state-md.md'],
  'worktree-safety.test.cjs': ['docs/SUMMARY.md'],
};

module.exports = { DOCS_GUARD_EXEMPT_BASELINE, DOCS_GUARD_EXEMPT_DOCS_PATHS };

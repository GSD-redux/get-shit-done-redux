#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { existsSync, readdirSync, appendFileSync } = require('fs');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

// Workflow files that are purely administrative / policy bots. Changes to these
// files do NOT require the cross-platform test matrix — only a lightweight
// ubuntu lane running workflow-lint tests is needed.
// FAIL-SAFE: any .github/workflows/*.yml NOT listed here is treated as a
// pipeline workflow and gets the full matrix. New workflow files default to full.
const INERT_WORKFLOWS = new Set([
  'stale.yml',
  'branch-cleanup.yml',
  'branch-naming.yml',
  'auto-label-issues.yml',
  'auto-branch.yml',
  'auto-backmerge.yml',
  'close-draft-prs.yml',
  'dismiss-unauthorized-pr-approvals.yml',
  'pr-target-validator.yml',
  'pr-template-format.yml',
  'require-issue-link.yml',
  'changeset-required.yml',
  'docs-required.yml',
  'discord-changelog.yml',
]);

// Workflows that gate merges, ship the product, or run security/cross-platform
// suites — these must ALWAYS get the full pipeline treatment and can never be
// added to INERT_WORKFLOWS. A module-load assertion enforces this so a mistaken
// or malicious addition fails CI loudly in the `changes` job on every PR.
const PROTECTED_WORKFLOWS = new Set([
  'test.yml',
  'install-smoke.yml',
  'mutation.yml',
  'security-scan.yml',
  'release.yml',
]);
for (const wf of PROTECTED_WORKFLOWS) {
  if (INERT_WORKFLOWS.has(wf)) {
    throw new Error(`ci-test-scope: protected workflow "${wf}" must not be in INERT_WORKFLOWS (it requires the full test matrix).`);
  }
}

/**
 * Returns true if the path is an inert (non-pipeline) workflow file.
 * Only `.github/workflows/<name>` where <name> is in INERT_WORKFLOWS qualifies.
 */
function isInertCi(filePath) {
  if (!filePath.startsWith('.github/workflows/')) return false;
  const name = filePath.slice('.github/workflows/'.length);
  // Must be a direct child (no further slashes) and in the allowlist.
  return !name.includes('/') && INERT_WORKFLOWS.has(name);
}

// Tests shared by both the 'workflow automation' and 'inert CI' rules.
const WORKFLOW_LINT_TESTS = [
  'tests/workflow-shell-pinning.test.cjs',
  'tests/pr-template-policy.test.cjs',
  'tests/lint-pr-check-project-dir.test.cjs',
];

const RULES = [
  {
    name: 'workflow automation',
    // Only NON-inert .github/workflows/* and all .github/rulesets/* trigger full matrix.
    // FAIL-SAFE: any .github/workflows/*.yml not in INERT_WORKFLOWS is treated as pipeline.
    match: filePath => (filePath.startsWith('.github/workflows/') && !isInertCi(filePath)) ||
      filePath.startsWith('.github/rulesets/'),
    fullMatrix: true,
    tests: [
      ...WORKFLOW_LINT_TESTS,
      'tests/release-tarball-smoke-workflow.test.cjs',
    ],
  },
  {
    name: 'inert CI',
    match: filePath => isInertCi(filePath),
    fullMatrix: false,
    tests: [
      ...WORKFLOW_LINT_TESTS,
      'tests/policy-lint-shallow-checkout.test.cjs',
    ],
  },
  {
    name: 'test harness',
    match: path => path === 'scripts/run-tests.cjs',
    fullMatrix: true,
    tests: [
      'tests/run-tests-harness.test.cjs',
      'tests/workflow-shell-pinning.test.cjs',
    ],
  },
  {
    name: 'environment and dependency gates',
    match: path => [
      'scripts/check-env.cjs',
      'scripts/check-npm-integrity.cjs',
      'package.json',
      'package-lock.json',
    ].includes(path),
    fullMatrix: true,
    tests: [
      'tests/check-env.test.cjs',
      'tests/npm-integrity-gate.test.cjs', // #2758: absorbs the former tests/bug-3588-npm-audit-clean.test.cjs (folded into it by consolidation epic #1969 B6 #1975; the stale filename here was a silent coverage hole this rule never actually re-selected)
      'tests/package-manifest.test.cjs',
    ],
  },
  {
    name: 'TS runtime sources (ADR-457 build-at-publish)',
    // src/*.cts compiles into gsd-core/bin/lib/*.cjs; a source-only edit must
    // still trigger the migrated module's tests (otherwise CI silently skips them).
    match: path => path.startsWith('src/') || path === 'tsconfig.build.json',
    tests: [
      'tests/semver-compare.test.cjs', // #2758: absorbs the former tests/bug-10-semver-policy-consolidation.test.cjs (folded into it by consolidation epic #1969 B3 #1972; the stale filename here was a silent coverage hole this rule never actually re-selected)
      'tests/emitted-provenance.test.cjs', // any src/installer change can alter emitted install artifacts → re-verify provenance totality (#2724: golden-install-parity retired, this is the sole gate)
      'tests/emitted-attribution.test.cjs',
    ],
  },
  {
    name: 'installer and package layout',
    match: path => path.startsWith('bin/') ||
      path.startsWith('gsd-core/bin/') ||
      path.includes('install') ||
      path.includes('release-tarball-smoke'),
    fullMatrix: true,
    tests: [
      'tests/install.test.cjs',
      'tests/install-regressions.test.cjs',
      'tests/install-runtime-artifacts.test.cjs',
      'tests/install-path-detection.test.cjs',
      // NOTE: release-tarball-smoke.install.test.cjs is intentionally NOT here.
      // It is a 3–6 min `npm pack` + `npm install -g` integration test with its
      // OWN dedicated workflow (.github/workflows/install-smoke.yml, triggered on
      // the production install paths). Running it in the scoped/targeted lane too
      // is redundant and blows the per-chunk Windows timeout when a broad PR
      // bundles it with many other changed test files (epic #1969). See the
      // SCOPED_LANE_EXCLUDE guard below, which also drops it when it is itself a
      // changed test file.
      'tests/runtime-artifact-layout.test.cjs',
      'tests/emitted-provenance.test.cjs', // any src/installer change can alter emitted install artifacts → re-verify provenance totality (#2724: golden-install-parity retired, this is the sole gate)
      'tests/emitted-attribution.test.cjs',
    ],
  },
  {
    name: 'shipped install content (emitted-attribution drift guard, #2267/#2724)',
    // Every source file the installer EMITS into a runtime layout is captured by
    // the emitted-attribution differential + the install-tree snapshot. A source
    // edit here that changes emitted output MUST re-verify (#2266: a
    // hooks/gsd-statusline.js edit changed installed output but no rule selected
    // the drift guard, so a stale emitted state shipped to next undetected).
    // Union semantics: this ADDS the drift guard on top of each path's existing
    // content-specific tests. Targeted lane only (the real-tree test skips win32
    // by design), no fullMatrix.
    // #2724: golden-install-parity.test.cjs is retired (ADR-2719 Phase 4); the
    // emitted differential (ADR-2719 Phase 2/3) is now the sole gate for a PR
    // editing only shipped content, the archetypal emitted-ripple case.
    // NOTE: intentionally NOT a blanket 'gsd-core/' prefix, for two reasons:
    // (1) gsd-core/bin/** is tsc-compiled runtime output — EXCLUDED_PREFIXES-
    //     excluded from both manifests, and already covered by the 'installer and
    //     package layout' rule (path.startsWith('gsd-core/bin/')) — so matching it
    //     here would be pure noise; and
    // (2) enumerating only the installer-shipped content subtrees preserves the
    //     bug-408 unit-fallback contract: a gsd-core/ path that is NOT shipped
    //     verbatim (the bug-408 test uses gsd-core/src/some-util.js) must still
    //     fall back to ['unit'] when no rule matches.
    // Listed: the four gsd-core content subtrees the installer ships verbatim
    // (contexts, references, templates, workflows) + bin/shared/*.json data files.
    // Verify against Object.keys(golden fixture) grouped by gsd-core/<subdir>.
    match: path =>
      ['hooks/', 'commands/', 'agents/', 'skills/', 'gsd-core/workflows/', 'gsd-core/templates/', 'gsd-core/references/', 'gsd-core/contexts/', 'scripts/changeset/', 'scripts/lib/'].some(p => path.startsWith(p)) ||
      (path.startsWith('gsd-core/bin/shared/') && path.endsWith('.json')) ||
      ['scripts/fix-slash-commands.cjs', 'scripts/gen-capability-registry.cjs', 'scripts/gen-loop-host-contract.cjs'].includes(path),
    tests: [
      'tests/golden-install-tree.test.cjs',
      'tests/emitted-provenance.test.cjs',
      'tests/emitted-attribution.test.cjs',
    ],
  },
  {
    name: 'hooks',
    match: path => path.startsWith('hooks/'),
    fullMatrix: true,
    tests: [
      'tests/hook-validation.test.cjs',
      'tests/managed-hooks.test.cjs',
      'tests/hooks-opt-in.test.cjs',
      'tests/sh-hook-paths.test.cjs',
      'tests/precommit-alias-drift-hook.test.cjs',
      'tests/prepush-enterprise-email-hook.test.cjs',
    ],
  },
  {
    name: 'changeset tooling',
    match: path => path.startsWith('scripts/changeset/') || path.startsWith('.changeset/'),
    tests: [
      'tests/changeset-cli.test.cjs',
      'tests/changeset-lint.test.cjs',
      'tests/changeset-new.test.cjs',
      'tests/changeset-parse.test.cjs',
      'tests/changeset-render.test.cjs',
      'tests/changeset-serialize.test.cjs',
      'tests/changeset-github-release-notes.test.cjs',
    ],
  },
  {
    name: 'security scanners',
    match: path => path.includes('secret-scan') ||
      path.includes('base64-scan') ||
      path.includes('prompt-injection-scan') ||
      path.startsWith('tests/fixtures/adversarial/security/'),
    tests: [
      'tests/secret-scan-lint.security.test.cjs',
      'tests/prompt-injection-scan.security.test.cjs',
      'tests/security-prompt-injection.security.test.cjs',
      'tests/read-injection-scanner.security.test.cjs',
      'tests/security-scan.security.test.cjs',
    ],
  },
  {
    name: 'command definitions',
    match: path => path.startsWith('commands/'),
    tests: [
      'tests/command-contract.test.cjs',
      'tests/command-routing-hub.test.cjs',
      'tests/commands.test.cjs',
      'tests/docs-parity-live-registry.test.cjs',
      'tests/phase-command-router.test.cjs',
      'tests/roadmap-command-router.test.cjs',
    ],
  },
  {
    name: 'workflow prompts',
    match: path => path.startsWith('gsd-core/workflows/'),
    tests: [
      'tests/workflow-compat.test.cjs',
      'tests/workflow-size-budget.test.cjs',
      'tests/workflow-guard-registration.test.cjs',
      'tests/commands.test.cjs',
      // #2758: was 'tests/bug-3683-workflow-colon-namespace-leak.test.cjs', deleted by
      // consolidation epic #1969 (B6 #1975) and folded into slash-command-namespace.test.cjs
      // ("folded:bug-3683-workflow-colon-namespace-leak" describe block). The stale filename
      // here was itself an instance of this issue's defect class — silently dropped by
      // existingTests() below, so gsd-core/workflows/ changes stopped re-running this
      // regression's coverage with nothing signaling it.
      'tests/slash-command-namespace.test.cjs',
    ],
  },
  {
    name: 'agent prompts',
    match: path => path.startsWith('agents/'),
    tests: [
      'tests/agent-frontmatter.test.cjs',
      'tests/agent-size-budget.test.cjs',
      'tests/agent-skills.test.cjs',
      'tests/agent-skills-awareness.test.cjs',
      'tests/agent-required-reading-consistency.test.cjs',
      'tests/docs-parity-live-registry.test.cjs',
    ],
  },
  {
     name: 'configuration',
     match: path => ['config', 'configuration', 'model-catalog', 'model-profile'].some(k => path.includes(k)),
     tests: [
       'tests/config.test.cjs',
       'tests/config-get-default.test.cjs',
       'tests/configuration-migrate-config.test.cjs',
       'tests/model-catalog-runtime-defaults.test.cjs',
       'tests/model-profiles.test.cjs',
     ],
   },
  {
    // ADR-1703 portability lint surface. Editing a rule, the shared vocab/guard
    // helpers, or the eslint config that wires them must re-run the rule suites
    // + the disable-ban. The disable-ban also scans bin/install.js and
    // scripts/build-hooks.js (the Phase 6 glob-expansion surface), so changes
    // to those files re-run it too.
    name: 'portability lint rules (ADR-1703)',
    match: path => path.startsWith('eslint-rules/') ||
      path === 'eslint.config.mjs' ||
      path === 'bin/install.js' ||
      path === 'scripts/build-hooks.js',
    tests: [
      'tests/portability-rule-disable-ban.test.cjs',
      'tests/portability-vocab-drift.test.cjs',
      // All nine RuleTester suites (P1–P6) — editing any rule / the shared
      // vocab+guard helpers / the eslint config re-runs the full rule family.
      'tests/no-path-literal-in-assert.rule.test.cjs',
      'tests/no-posix-mode-bit-assert.rule.test.cjs',
      'tests/no-unguarded-nonportable-exec.rule.test.cjs',
      'tests/no-crlf-fragile-split.rule.test.cjs',
      'tests/no-hardcoded-tmp.rule.test.cjs',
      'tests/no-bare-npm-exec.rule.test.cjs',
      'tests/require-userprofile-with-home.rule.test.cjs',
      'tests/normalize-path-in-content.rule.test.cjs',
      'tests/require-fs-op-fallback.rule.test.cjs',
    ],
  },
 ];

/**
 * Every RULES[].tests entry (deduped, across every rule) that does NOT exist on
 * disk. #2758: a rule naming a test file that no longer exists is not merely
 * inert — existingTests() below silently drops it out of targeted_tests, with
 * nothing in the CI output signaling why. Phase 4 (#2724) deletes
 * tests/golden-install-parity.test.cjs; without this check, any rule still
 * naming it would stop selecting the guard entirely and CI would stay green
 * throughout. Pure and independent of which rule / which file: it catches ANY
 * phantom entry, not only the two names this issue is about.
 * Paths resolve relative to the repo root (this file's parent directory), not
 * the caller's cwd, so the check behaves identically whether invoked as the CLI
 * (`node scripts/ci-test-scope.cjs ...`, cwd == repo root by convention) or
 * required directly by a test.
 */
function missingRuleTestFiles(rules) {
  const referenced = new Set();
  for (const rule of rules) {
    for (const f of rule.tests) referenced.add(f);
  }
  return [...referenced].filter(f => !existsSync(path.join(__dirname, '..', f))).sort();
}

// Fail loudly at module load, mirroring the PROTECTED_WORKFLOWS check above —
// this fires on EVERY invocation of the CLI (including the real `changes` job
// in .github/workflows/test.yml), not only when a test suite happens to run.
{
  const missing = missingRuleTestFiles(RULES);
  if (missing.length > 0) {
    throw new Error(
      `ci-test-scope: RULES reference test file(s) that do not exist on disk ` +
      `(silent coverage hole — see #2758):\n  ${missing.join('\n  ')}`,
    );
  }
}

function usage() {
  return [
    'Usage:',
    '  node scripts/ci-test-scope.cjs --base <sha> --head <sha>',
    '  node scripts/ci-test-scope.cjs --files <path-list>',
    '',
    'Prints JSON by default. With GITHUB_OUTPUT set, also writes workflow outputs.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { base: null, head: null, files: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      out.base = argv[++i];
      if (!out.base || out.base.startsWith('--')) throw new Error('--base requires a value');
    } else if (arg.startsWith('--base=')) {
      out.base = arg.slice('--base='.length);
      if (!out.base) throw new Error('--base requires a value');
    } else if (arg === '--head') {
      out.head = argv[++i];
      if (!out.head || out.head.startsWith('--')) throw new Error('--head requires a value');
    } else if (arg.startsWith('--head=')) {
      out.head = arg.slice('--head='.length);
      if (!out.head) throw new Error('--head requires a value');
    } else if (arg === '--files') {
      out.files = argv[++i];
      if (!out.files || out.files.startsWith('--')) throw new Error('--files requires a value');
    } else if (arg.startsWith('--files=')) {
      out.files = arg.slice('--files='.length);
      if (!out.files) throw new Error('--files requires a value');
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      throw new ExitError(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function splitFiles(value) {
  if (!value) return [];
  const SEPARATORS = new Set([',', ' ', '\t', '\n', '\r', '\f', '\v']);
  const tokens = [];
  let current = '';
  for (const ch of value) {
    if (SEPARATORS.has(ch)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens.map(v => v.trim()).filter(Boolean);
}

function changedFiles(args) {
  if (args.files) return splitFiles(args.files);
  if (!args.base || !args.head) {
    throw new Error('--base/--head or --files is required');
  }
  // Three-dot diff (merge-base...head) matches GitHub's PR "Files changed" semantics.
  // A two-dot `git diff base head` would surface every file `next` gained after this
  // branch's merge-base, mis-flagging product_changed/full_matrix on docs-only PRs cut
  // from a slightly stale base (#837). The `changes` job checks out with fetch-depth: 0,
  // so the merge-base is always available.
  const stdout = execFileSync('git', ['diff', '--name-only', `${args.base}...${args.head}`], {
    encoding: 'utf8',
  });
  return splitFiles(stdout);
}

function existingTests(files) {
  const all = new Set(readdirSync('tests').filter(f => f.endsWith('.test.cjs')).map(f => `tests/${f}`));
  return files.filter(file => all.has(file) && existsSync(file));
}

function addAll(set, values) {
  for (const value of values) set.add(value);
}

// Windows-sensitive filename hints — deliberately narrow. 'workflow',
// 'install', and 'hook' were dropped from this list: workflow-lint tests are
// platform-independent YAML/policy checks, and the installer/hooks RULES set
// fullMatrix=true, so the full Windows lane already runs when those paths
// change. The old six-hint list pulled 102 of ~633 test files into the scoped
// windows lane, turning it into a ~10-minute job on every PR.
const WINDOWS_HINTS = ['windows', 'win32', 'shell', 'path'];
const isWindowsHint = s => WINDOWS_HINTS.some(k => s.toLowerCase().includes(k));

function classify(files) {
  const targeted = new Set();
  const windows = new Set();
  const reasons = [];
  let productOrPipelineChanged = false; // product/pipeline code (excludes docs)
  let inertCiChanged = false;           // inert workflow files
  let fullMatrix = false;

  for (const file of files) {
    // Determine if this file is product/pipeline code.
    // docs/ and root-level .md files are intentionally excluded.
    // 'skills/' is shipped agent-skill content installed into every runtime by
    // the installer (see the 'shipped install content' RULES entry below) — it
    // must be product code, or a skills/-only change silently gets
    // code_changed=false and skips the ENTIRE CI matrix, not merely golden-parity
    // (found while verifying the #2267 golden-parity rule against skills/**: the
    // rule fired in `reasons` but classify()'s codeChanged gate zeroed out every
    // targeted test because 'skills/' was absent from this list).
    if (
      ['bin/', 'src/', 'gsd-core/', 'agents/', 'commands/', 'hooks/', 'skills/', 'tests/', 'scripts/', 'eslint-rules/'].some(p => file.startsWith(p)) ||
      file === 'package.json' || file === 'package-lock.json' ||
      (file.startsWith('tsconfig') && file.endsWith('.json')) ||
      file.startsWith('.github/rulesets/')
    ) {
      productOrPipelineChanged = true;
    }

    // Non-inert .github/workflows/* are pipeline code → full matrix.
    if (file.startsWith('.github/workflows/') && !isInertCi(file)) {
      productOrPipelineChanged = true;
    }

    // Inert workflow files set a lightweight signal.
    if (isInertCi(file)) {
      inertCiChanged = true;
    }

    if (file.startsWith('tests/') && file.endsWith('.test.cjs')) {
      targeted.add(file);
      // #494 invariant, narrowed: a changed test must still be exercised on
      // the divergent OS before merge, but at per-file cost — it ALWAYS joins
      // the scoped windows lane instead of triggering the three full parity
      // lanes. (full_matrix fired on 15/15 sampled PRs because test-driven
      // PRs always touch tests/, costing ~25 runner-minutes each.) Changed
      // tests already run on ubuntu-22 and ubuntu-24 via targeted_tests; the
      // residual macOS / windows-node-22 cross-product is covered by the full
      // matrix on every push to next.
      windows.add(file);
    }

    for (const rule of RULES) {
      if (rule.match(file)) {
        addAll(targeted, rule.tests);
        reasons.push(`${file}: ${rule.name}`);
        if (rule.fullMatrix) fullMatrix = true;
      }
    }
  }

  // Heavy integration tests that own a dedicated workflow must never run in the
  // scoped/targeted lane — they carry a multi-minute cost that overruns the
  // per-chunk timeout (worst on Windows) when a broad PR bundles them with many
  // other changed test files, and their production paths already trigger their
  // own workflow. Drop them however they entered (matched rule OR changed-file).
  const SCOPED_LANE_EXCLUDE = new Set([
    // covered by .github/workflows/install-smoke.yml
    'tests/release-tarball-smoke.install.test.cjs',
  ]);
  for (const f of SCOPED_LANE_EXCLUDE) { targeted.delete(f); windows.delete(f); }

  // code_changed: true when product/pipeline OR inert CI changed.
  // Docs-only PRs (neither flag set) get code_changed=false → full matrix skip.
  const codeChanged = productOrPipelineChanged || inertCiChanged;

  const targetedTests = existingTests([...targeted].sort());

  // When code changed but no rule matched any changed file, fall back to the
  // unit suite so the targeted lane always runs something meaningful (#408).
  if (codeChanged && targetedTests.length === 0) {
    targetedTests.push('unit');
  }

  const windowsTests = existingTests([...new Set([...windows, ...targetedTests.filter(isWindowsHint)])].sort());

  // Inert-CI-only: full_matrix must be false (override any RULES that fired).
  if (inertCiChanged && !productOrPipelineChanged) {
    fullMatrix = false;
  }

  // Normalize: when code_changed is false, the output must be self-consistent.
  // A docs file can coincidentally match a coarse content RULE (e.g. docs/installer-migrations.md
  // matches the installer rule via path.includes('install')), leaving full_matrix=true and
  // non-empty targeted_tests/windows_tests. The workflow skips correctly (gated on code_changed)
  // but the output object would be self-contradictory. Force a clean "nothing to run" result.
  if (!codeChanged) {
    fullMatrix = false;
    targetedTests.length = 0;
    windowsTests.length = 0;
  }

  return {
    code_changed: codeChanged,
    product_changed: productOrPipelineChanged,
    full_matrix: fullMatrix,
    targeted_tests: targetedTests,
    windows_tests: windowsTests,
    reasons: [...new Set(reasons)].sort(),
  };
}

function writeOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [
    `code_changed=${result.code_changed}`,
    `product_changed=${result.product_changed}`,
    `full_matrix=${result.full_matrix}`,
    `targeted_tests=${result.targeted_tests.join(' ')}`,
    `windows_tests=${result.windows_tests.join(' ')}`,
  ];
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    const files = changedFiles(args);
    const result = classify(files);
    result.changed_files = files;
    writeOutputs(result);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof ExitError) throw error;
    console.error(`ci-test-scope: ${error.message}`);
    console.error(usage());
    throw new ExitError(2);
  }
}

if (require.main === module) {
  runMain(main);
}

module.exports = { RULES, missingRuleTestFiles };

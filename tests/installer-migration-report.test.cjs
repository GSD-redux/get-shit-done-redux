'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertInstallerMigrationsUnblocked,
  summarizeInstallerMigrationResult,
} = require('../gsd-core/bin/lib/installer-migration-report.cjs');

test('summarizes every installer migration report category', () => {
  const blockedAction = {
    type: 'prompt-user',
    relPath: 'hooks/gsd-retired-hook.js',
    reason: 'needs a user choice',
  };
  const result = {
    blocked: [blockedAction],
    plan: {
      actions: [
        {
          type: 'remove-managed',
          relPath: 'hooks/statusline.js',
          reason: 'retired hook',
        },
        {
          type: 'backup-and-remove',
          relPath: 'hooks/modified.js',
          reason: 'modified managed hook retired',
        },
        {
          type: 'baseline-preserve-user',
          relPath: 'hooks/custom.js',
          reason: 'user-owned hook',
        },
        {
          type: 'unknown-action',
          relPath: 'hooks/unknown.js',
          reason: 'unsupported in this installer',
        },
        blockedAction,
      ],
    },
  };

  assert.deepEqual(
    summarizeInstallerMigrationResult(result).rows.map((row) => ({
      label: row.label,
      relPath: row.relPath,
      reason: row.reason,
    })),
    [
      {
        label: 'removed',
        relPath: 'hooks/statusline.js',
        reason: 'retired hook',
      },
      {
        label: 'backed up and removed',
        relPath: 'hooks/modified.js',
        reason: 'modified managed hook retired',
      },
      {
        label: 'preserved',
        relPath: '1 user baseline file',
        reason: 'first-time baseline scan',
      },
      {
        label: 'skipped',
        relPath: 'hooks/unknown.js',
        reason: 'unsupported in this installer',
      },
      {
        label: 'blocked',
        relPath: 'hooks/gsd-retired-hook.js',
        reason: 'needs a user choice',
      },
    ]
  );
});

test('collapses first-time baseline report rows without hiding destructive actions', () => {
  const blockedAction = {
    type: 'prompt-user',
    relPath: 'hooks/gsd-ambiguous.js',
    reason: 'needs a user choice',
  };
  const result = {
    blocked: [blockedAction],
    plan: {
      actions: [
        {
          type: 'record-baseline',
          relPath: 'hooks/statusline.js',
          reason: 'first-time baseline scan',
        },
        {
          type: 'record-baseline',
          relPath: 'hooks/workflow-guard.js',
          reason: 'first-time baseline scan',
        },
        {
          type: 'baseline-preserve-user',
          relPath: 'hooks/custom.js',
          reason: 'first-time baseline scan',
        },
        {
          type: 'remove-managed',
          relPath: 'hooks/retired.js',
          reason: 'retired hook',
        },
        blockedAction,
      ],
    },
  };

  assert.deepEqual(
    summarizeInstallerMigrationResult(result).rows.map((row) => ({
      label: row.label,
      relPath: row.relPath,
      reason: row.reason,
    })),
    [
      {
        label: 'recorded',
        relPath: '2 managed baseline files',
        reason: 'first-time baseline scan',
      },
      {
        label: 'preserved',
        relPath: '1 user baseline file',
        reason: 'first-time baseline scan',
      },
      {
        label: 'removed',
        relPath: 'hooks/retired.js',
        reason: 'retired hook',
      },
      {
        label: 'blocked',
        relPath: 'hooks/gsd-ambiguous.js',
        reason: 'needs a user choice',
      },
    ]
  );
});

test('throws when installer migrations require user choice', () => {
  // #3541: error message now groups paths by reason and names the
  // non-interactive resolution surface. The thrown error carries
  // structured `blockedByReason` data and the resolution env var
  // name so callers can render their own report.
  let captured = null;
  try {
    assertInstallerMigrationsUnblocked({
      blocked: [
        {
          relPath: 'hooks/gsd-retired-hook.js',
          reason: 'needs a user choice',
          choices: ['keep', 'remove'],
        },
      ],
    });
    assert.fail('expected throw');
  } catch (err) {
    captured = err;
  }
  assert.ok(captured instanceof Error);
  assert.match(captured.message, /installer migration blocked pending user choice/);
  assert.match(captured.message, /hooks\/gsd-retired-hook\.js/);
  assert.match(captured.message, /GSD_INSTALLER_MIGRATION_RESOLVE/);
  assert.ok(captured.blockedByReason, 'error exposes grouped-by-reason data');
  assert.equal(captured.resolutionEnvVar, 'GSD_INSTALLER_MIGRATION_RESOLVE');
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3541-installer-migration-prompt-user-resolution.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3541-installer-migration-prompt-user-resolution (consolidation epic #1969 B5 #1974)", () => {
/**
 * Regression test for #3541: first-time-baseline installer migration
 * `prompt-user` actions threw hard with no resolution path, making
 * `/gsd-update` unrecoverable when leftover `gsd-*` files were classified
 * as `stale-gsd-looking`.
 *
 * Fix shape (per triage brief):
 *   A. Classify-and-default for safe categories - stale SDK build
 *      artifacts default to "remove"; user-facing skills/gsd-asterisk/SKILL.md
 *      defaults to "keep". Each resolution is logged.
 *   B. Improved error message when an unresolved prompt-user action
 *      remains: lists choices, suggests the resolution path, groups
 *      blocked paths by reason.
 *
 * Behavioural test — exercises the actual installer migration code paths
 * via the public `runInstallerMigrations` + new resolver entry points.
 * No source-grep (per CONTEXT.md L98–101 / RULESET.TESTS).
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  runInstallerMigrations,
} = require('../gsd-core/bin/lib/installer-migrations.cjs');
const {
  assertInstallerMigrationsUnblocked,
  resolveInstallerMigrationPromptsForNonTty,
} = require('../gsd-core/bin/lib/installer-migration-report.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

function writeFile(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function writeManifest(root, files) {
  fs.writeFileSync(
    path.join(root, 'gsd-file-manifest.json'),
    JSON.stringify({
      version: '1.41.2',
      timestamp: '2026-05-10T00:00:00.000Z',
      mode: 'full',
      files,
    }, null, 2),
    'utf8'
  );
}

describe('#3541: installer migration prompt-user non-TTY resolution', { concurrency: false }, () => {
  let configDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-3541-');
  });

  afterEach(() => {
    cleanup(configDir);
  });

  test('Test A: non-TTY default resolution removes stale SDK artifacts and keeps user skills', () => {
    // Stale SDK build artifact: replicates the 1.41.2 → 1.42.2 upgrade where
    // 24 stale `gsd-core/sdk/{dist,src}/gsd-*` files leaked into the
    // baseline because the new manifest no longer classifies them as managed.
    writeFile(configDir, 'gsd-core/sdk/dist/gsd-old-bundle.js', 'stale sdk bundle\n');
    // User-facing skill: replicates `skills/gsd-roadmap/SKILL.md` from the
    // same incident — user-owned content that must be preserved.
    writeFile(configDir, 'skills/gsd-roadmap/SKILL.md', '# Roadmap skill\nuser content\n');

    // Plant an empty manifest so both files classify as `stale-gsd-looking`
    // (they look like GSD artifacts but are not manifest-managed).
    writeManifest(configDir, {});

    const result = runInstallerMigrations({
      configDir,
      runtime: 'claude',
      scope: 'global',
      baselineScan: true,
    });

    // Confirm the migration framework classified both as prompt-user
    // blockers — this is the precondition the fix resolves.
    const blockedPaths = (result.blocked || []).map((a) => a.relPath).sort();
    assert.deepEqual(
      blockedPaths,
      ['gsd-core/sdk/dist/gsd-old-bundle.js', 'skills/gsd-roadmap/SKILL.md'],
      'precondition: both stale-looking files should be flagged for explicit user choice'
    );

    // Now run the non-TTY resolver. It must classify-and-default each
    // blocked action and return a structured log of resolutions.
    const resolved = resolveInstallerMigrationPromptsForNonTty(result, { isTty: false });

    assert.ok(Array.isArray(resolved.resolutions), 'resolver returns a resolutions log');
    assert.equal(
      resolved.resolutions.length,
      2,
      'one resolution entry per blocked action'
    );

    const byPath = new Map(resolved.resolutions.map((r) => [r.relPath, r]));
    const sdkResolution = byPath.get('gsd-core/sdk/dist/gsd-old-bundle.js');
    const skillResolution = byPath.get('skills/gsd-roadmap/SKILL.md');

    assert.ok(sdkResolution, 'SDK artifact resolution logged');
    assert.equal(sdkResolution.choice, 'remove', 'stale SDK build artifact defaults to remove');
    assert.equal(sdkResolution.category, 'stale-sdk-build-artifact');

    assert.ok(skillResolution, 'user skill resolution logged');
    assert.equal(skillResolution.choice, 'keep', 'user-facing skill defaults to keep');
    assert.equal(skillResolution.category, 'user-facing-skill');

    // After resolution there must be no blocked actions remaining; the
    // assertion gatekeeper must not throw.
    assert.equal(
      (resolved.result.blocked || []).length,
      0,
      'all prompt-user actions resolved'
    );
    assert.doesNotThrow(() => assertInstallerMigrationsUnblocked(resolved.result));
  });

  test('Test B: error message groups paths by reason and suggests a resolution path', () => {
    // Build a synthetic result with two blocked prompt-user actions of
    // distinct reasons. The improved error message must (1) list the
    // documented choices, (2) suggest the non-interactive resolution
    // path, (3) group blocked paths by reason rather than emit each path
    // individually.
    const blocked = [
      {
        type: 'prompt-user',
        relPath: 'gsd-core/sdk/dist/gsd-a.js',
        reason: 'GSD-looking file is not proven manifest-managed and needs explicit user choice',
        classification: 'stale-gsd-looking',
        prompt: 'Choose whether to remove this stale-looking GSD artifact or keep it as user-owned.',
        choices: ['keep', 'remove'],
      },
      {
        type: 'prompt-user',
        relPath: 'gsd-core/sdk/dist/gsd-b.js',
        reason: 'GSD-looking file is not proven manifest-managed and needs explicit user choice',
        classification: 'stale-gsd-looking',
        prompt: 'Choose whether to remove this stale-looking GSD artifact or keep it as user-owned.',
        choices: ['keep', 'remove'],
      },
    ];

    let captured = null;
    try {
      assertInstallerMigrationsUnblocked({ blocked });
      assert.fail('expected assertInstallerMigrationsUnblocked to throw');
    } catch (err) {
      captured = err;
    }

    assert.ok(captured instanceof Error);
    const message = captured.message;

    // (a) Documented choices listed.
    assert.match(message, /keep/, 'error message lists `keep` choice');
    assert.match(message, /remove/, 'error message lists `remove` choice');

    // (b) Suggests the resolution path. The fix introduces an
    // environment variable as the documented non-interactive resolution
    // surface — the message must point users at it.
    assert.match(
      message,
      /GSD_INSTALLER_MIGRATION_RESOLVE/,
      'error message suggests the non-interactive resolution env var'
    );

    // (c) Paths grouped by reason — two paths sharing the same reason
    // appear under one summary count, not as two separate path lines.
    // The message must include a `2 files` (or similar) grouped summary
    // and must NOT list each individual relPath in the top-level message.
    assert.match(
      message,
      /2 (files?|paths?|artifacts?)/,
      'error message groups blocked paths into a count summary'
    );

    // Structured surface: the thrown error must carry a `blockedByReason`
    // map so callers can render their own report without re-parsing.
    assert.ok(captured.blockedByReason, 'error carries blockedByReason data');
    const reasons = Object.keys(captured.blockedByReason);
    assert.equal(reasons.length, 1, 'two same-reason paths grouped under one key');
    assert.equal(captured.blockedByReason[reasons[0]].length, 2);
  });

  test('Test C: non-TTY env override resolves otherwise-unclassified prompt-user actions', () => {
    const result = {
      blocked: [
        {
          type: 'prompt-user',
          relPath: 'skills/gsd-custom/SKILL.toml',
          reason: 'custom skill metadata requires user decision',
          choices: ['keep', 'remove'],
        },
      ],
      plan: {
        actions: [],
        blocked: [
          {
            type: 'prompt-user',
            relPath: 'skills/gsd-custom/SKILL.toml',
            reason: 'custom skill metadata requires user decision',
            choices: ['keep', 'remove'],
          },
        ],
      },
    };

    const resolved = resolveInstallerMigrationPromptsForNonTty(result, {
      isTty: false,
      env: { GSD_INSTALLER_MIGRATION_RESOLVE: 'keep' },
    });

    assert.equal(resolved.resolutions.length, 1, 'env override resolves prompt-user action');
    assert.equal(resolved.resolutions[0].choice, 'keep');
    assert.equal(resolved.resolutions[0].source, 'GSD_INSTALLER_MIGRATION_RESOLVE');
    assert.equal(resolved.resolutions[0].category, 'operator-override');
    assert.equal((resolved.result.blocked || []).length, 0);
    assert.equal((resolved.result.plan.blocked || []).length, 0);
    assert.equal((resolved.result.plan.actions || []).length, 1);
    assert.equal(resolved.result.plan.actions[0].type, 'baseline-preserve-user');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3610-installer-migration-bundled-hooks-classification.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3610-installer-migration-bundled-hooks-classification (consolidation epic #1969 B5 #1974)", () => {
/**
 * Regression test for #3610: fresh `npx @opengsd/gsd-core@latest --codex`
 * hard-aborts when the target ~/.codex/hooks/ contains the bundled GSD
 * hook files (`gsd-check-update-worker.js`, `gsd-prompt-guard.js`, …)
 * left over from a previous version. The installer-migration report
 * classifies them as "GSD-looking file is not proven manifest-managed
 * and needs explicit user choice" and `assertInstallerMigrationsUnblocked`
 * throws.
 *
 * The files in question are NOT user-owned — they are the GSD bundled
 * hooks shipped under `hooks/gsd-*` in the npm package. The fix adds a
 * `bundled-gsd-hook` classification to `classifyPromptUserAction` so the
 * resolver removes them (the installer then writes the fresh bundled
 * versions in their place).
 *
 * Because this classification is unambiguous (these are not user files),
 * it must apply regardless of whether stdin is a TTY — the reporter's
 * `npx ... --codex` run was interactive and the existing non-TTY
 * resolver gate at install.js:8069 skipped the safe-default pass.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  runInstallerMigrations,
} = require('../gsd-core/bin/lib/installer-migrations.cjs');
const {
  assertInstallerMigrationsUnblocked,
  resolveInstallerMigrationPromptsForNonTty,
  classifyPromptUserAction,
} = require('../gsd-core/bin/lib/installer-migration-report.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

function writeFile(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function writeManifest(root, files) {
  fs.writeFileSync(
    path.join(root, 'gsd-file-manifest.json'),
    JSON.stringify(
      {
        version: '1.41.2',
        timestamp: '2026-05-10T00:00:00.000Z',
        mode: 'full',
        files,
      },
      null,
      2,
    ),
    'utf8',
  );
}

// Reporter's exact list of blocked files from the v1.42.2 → v1.42.0 upgrade
// abort. Each is a real `hooks/gsd-*` file shipped under hooks/ in the npm
// package (verified by `ls hooks/`).
const BUNDLED_HOOK_RELPATHS = [
  'hooks/gsd-check-update-worker.js',
  'hooks/gsd-check-update.js',
  'hooks/gsd-context-monitor.js',
  'hooks/gsd-phase-boundary.sh',
  'hooks/gsd-prompt-guard.js',
  'hooks/gsd-read-guard.js',
  'hooks/gsd-read-injection-scanner.js',
  'hooks/gsd-session-state.sh',
  'hooks/gsd-statusline.js',
  'hooks/gsd-update-banner.js',
  'hooks/gsd-validate-commit.sh',
  'hooks/gsd-workflow-guard.js',
];

describe('bug #3610: classifyPromptUserAction recognizes bundled GSD hooks', () => {
  test('classifies hooks/gsd-*.js as bundled-gsd-hook → remove', () => {
    const result = classifyPromptUserAction({
      relPath: 'hooks/gsd-prompt-guard.js',
    });
    assert.ok(result, 'classifier returned null for a bundled GSD hook (.js)');
    assert.strictEqual(result.category, 'bundled-gsd-hook');
    assert.strictEqual(
      result.choice,
      'remove',
      'bundled hook must default to remove so the installer can write the fresh bundled version',
    );
  });

  test('classifies hooks/gsd-*.sh as bundled-gsd-hook → remove', () => {
    const result = classifyPromptUserAction({
      relPath: 'hooks/gsd-validate-commit.sh',
    });
    assert.ok(result);
    assert.strictEqual(result.category, 'bundled-gsd-hook');
    assert.strictEqual(result.choice, 'remove');
  });

  test('does NOT classify non-gsd hooks (preserves user-owned hook files)', () => {
    // A user's custom hook that happens to live under hooks/ must NOT be
    // auto-classified as bundled — the existing block-then-choose flow
    // continues to apply, preserving the user's control over their files.
    const result = classifyPromptUserAction({
      relPath: 'hooks/my-custom-hook.js',
    });
    assert.strictEqual(
      result,
      null,
      'non-gsd-prefixed hook must NOT auto-classify (would clobber user files)',
    );
  });

  test('does NOT classify deeper paths under hooks/gsd-* (e.g. hooks/lib/) as bundled-gsd-hook', () => {
    // The bundled GSD distribution has hooks/lib/ (helper modules). Those
    // are managed differently — verify the classifier limits itself to
    // top-level hooks/gsd-<name>.<ext> files, not nested directories.
    const result = classifyPromptUserAction({
      relPath: 'hooks/gsd-helpers/index.js',
    });
    assert.strictEqual(result, null);
  });
});

describe('bug #3610: fresh upgrade with leftover bundled hooks does not throw', () => {
  let configDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-3610-');
  });

  afterEach(() => {
    cleanup(configDir);
  });

  test('end-to-end: 12 leftover bundled hooks + empty manifest → resolver clears all blockers', () => {
    // Recreate the reporter's environment: 12 bundled `gsd-*` hook files
    // present at target, but the manifest has not yet seeded their baseline
    // entries (first-time-baseline scan).
    for (const rel of BUNDLED_HOOK_RELPATHS) {
      writeFile(configDir, rel, '#!/usr/bin/env node\n// stale 1.42.0 hook\n');
    }
    writeManifest(configDir, {});

    const result = runInstallerMigrations({
      configDir,
      runtime: 'codex',
      scope: 'global',
      baselineScan: true,
    });

    // Precondition: all 12 leftover hooks classify as prompt-user blockers.
    const blockedPaths = (result.blocked || []).map((a) => a.relPath).sort();
    assert.deepStrictEqual(
      blockedPaths,
      [...BUNDLED_HOOK_RELPATHS].sort(),
      'precondition: every leftover hooks/gsd-* should be a prompt-user blocker',
    );

    // Resolve through the safe-default classifier (passing isTty=false to
    // exercise the same code path the bundled-hook classification will hit
    // regardless of TTY once the fix removes the gate).
    const resolved = resolveInstallerMigrationPromptsForNonTty(result, { isTty: false });

    assert.strictEqual(
      resolved.resolutions.length,
      BUNDLED_HOOK_RELPATHS.length,
      'every bundled hook should produce a safe-default resolution entry',
    );

    for (const entry of resolved.resolutions) {
      assert.strictEqual(entry.category, 'bundled-gsd-hook');
      assert.strictEqual(entry.choice, 'remove');
      assert.strictEqual(entry.resolvedActionType, 'backup-and-remove');
    }

    assert.strictEqual(
      (resolved.result.blocked || []).length,
      0,
      'no blockers should remain after bundled-hook classification fires',
    );
    assert.doesNotThrow(() => assertInstallerMigrationsUnblocked(resolved.result));
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3628-bundled-hook-classifier-whitelist.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3628-bundled-hook-classifier-whitelist (consolidation epic #1969 B5 #1974)", () => {
// classifyPromptUserAction returns a typed result object; this test asserts
// on that typed surface (category + choice fields) for both the positive
// (shipped) and negative (user-owned / retired) cases. There is no rendered
// text or stdout under test — the classifier's structured return value IS
// the contract.

/**
 * Bug #3628: `bundled-gsd-hook` classifier (added in #3610) uses a shape
 * regex (`/^hooks\/gsd-[^/]+\.(?:js|sh|cjs|mjs)$/`) that matches ANY file
 * named `hooks/gsd-<name>.{js,sh,cjs,mjs}`, not only the 13 hook files
 * actually shipped in the npm distribution. The permissive shape regex
 * silently auto-classifies — and on first-time-baseline scan auto-removes:
 *
 *   - User-authored custom hooks (e.g. `hooks/gsd-personal-experiment.js`)
 *   - Retired bundled hooks from prior GSD versions
 *
 * Fix: the classifier must whitelist the explicit set of shipped hook
 * filenames sourced from a single point of truth (`BUNDLED_GSD_HOOK_FILES`
 * exported from the classifier module). Any `hooks/gsd-<name>` file NOT in
 * that set must fall through to the existing block-or-prompt flow so the
 * user retains control.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyPromptUserAction,
  BUNDLED_GSD_HOOK_FILES,
} = require('../gsd-core/bin/lib/installer-migration-report.cjs');
const path = require('node:path');
const fs = require('node:fs');

describe('bug #3628: BUNDLED_GSD_HOOK_FILES is an explicit whitelist', () => {
  test('exports a Set of shipped hook filenames', () => {
    assert.ok(
      BUNDLED_GSD_HOOK_FILES instanceof Set,
      'BUNDLED_GSD_HOOK_FILES must be exported as a Set so callers can probe membership',
    );
    assert.ok(
      BUNDLED_GSD_HOOK_FILES.size > 0,
      'BUNDLED_GSD_HOOK_FILES must enumerate at least one shipped hook',
    );
  });

  test('every entry is a hooks/-prefixed posix path', () => {
    for (const relPath of BUNDLED_GSD_HOOK_FILES) {
      assert.ok(
        relPath.startsWith('hooks/'),
        `entry ${JSON.stringify(relPath)} must be prefixed with "hooks/"`,
      );
      assert.ok(
        !relPath.includes('\\'),
        `entry ${JSON.stringify(relPath)} must use POSIX slashes`,
      );
      assert.ok(
        relPath.includes('gsd-'),
        `entry ${JSON.stringify(relPath)} must contain the "gsd-" prefix`,
      );
    }
  });

  test('every BUNDLED_GSD_HOOK_FILES entry corresponds to a real file in hooks/', () => {
    // Sourcing the whitelist from a frozen constant is only durable if the
    // constant stays aligned with the on-disk distribution. This guard
    // fails the day someone removes a hook file but forgets to update the
    // whitelist (or vice-versa).
    const hooksDir = path.join(__dirname, '..', 'hooks');
    for (const relPath of BUNDLED_GSD_HOOK_FILES) {
      const fullPath = path.join(hooksDir, relPath.slice('hooks/'.length));
      assert.ok(
        fs.existsSync(fullPath),
        `whitelisted ${relPath} is missing from hooks/ on disk — whitelist drifted`,
      );
    }
  });

  test('every gsd-*.{js,sh,cjs,mjs} file in hooks/ is in BUNDLED_GSD_HOOK_FILES (no shipping drift)', () => {
    const hooksDir = path.join(__dirname, '..', 'hooks');
    const onDisk = fs
      .readdirSync(hooksDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /^gsd-[^/]+\.(?:js|sh|cjs|mjs)$/.test(e.name))
      .map((e) => `hooks/${e.name}`);
    for (const relPath of onDisk) {
      assert.ok(
        BUNDLED_GSD_HOOK_FILES.has(relPath),
        `${relPath} ships in hooks/ but is missing from BUNDLED_GSD_HOOK_FILES — whitelist drifted`,
      );
    }
  });
});

describe('bug #3628: classifyPromptUserAction whitelists shipped bundled hooks', () => {
  test('classifies every entry in BUNDLED_GSD_HOOK_FILES as bundled-gsd-hook → remove', () => {
    for (const relPath of BUNDLED_GSD_HOOK_FILES) {
      const result = classifyPromptUserAction({ relPath });
      assert.deepStrictEqual(
        result,
        { category: 'bundled-gsd-hook', choice: 'remove' },
        `${relPath} should classify as bundled-gsd-hook`,
      );
    }
  });

  const USER_OWNED_OR_RETIRED = [
    'hooks/gsd-personal-experiment.js',
    'hooks/gsd-my-custom-guard.sh',
    'hooks/gsd-team-policy.cjs',
    'hooks/gsd-retired-hook.js',
    'hooks/gsd-old-statusline.js',
    'hooks/gsd-experimental.mjs',
  ];

  for (const relPath of USER_OWNED_OR_RETIRED) {
    test(`does NOT classify ${relPath} (user-owned / retired)`, () => {
      assert.strictEqual(
        classifyPromptUserAction({ relPath }),
        null,
        `${relPath} must NOT auto-classify — falls through to block-or-prompt`,
      );
    });
  }

  test('still does NOT classify nested gsd-* directories (existing #3610 boundary preserved)', () => {
    assert.strictEqual(
      classifyPromptUserAction({ relPath: 'hooks/gsd-helpers/index.js' }),
      null,
    );
  });

  test('still does NOT classify non-gsd hooks (existing boundary preserved)', () => {
    assert.strictEqual(
      classifyPromptUserAction({ relPath: 'hooks/my-custom-hook.js' }),
      null,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3442-codex-legacy-hooks-json-migration.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3442-codex-legacy-hooks-json-migration (consolidation epic #1969 B5 #1974)", () => {
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const migration = require(path.join(
  __dirname,
  '..',
  'gsd-core',
  'bin',
  'lib',
  'installer-migrations',
  '002-codex-legacy-hooks-json.cjs',
));

describe('bug #3442: codex legacy hooks.json migration consumes shared managed-hook policy', () => {
  test('plan prunes managed codex hook commands including legacy alias', () => {
    const configDir = '/Users/me/.codex';
    const hooksJson = {
      hooks: [
        { command: '"/usr/local/bin/node" "/Users/me/.codex/hooks/gsd-check-update.js"' },
        { command: '"/usr/local/bin/node" "/Users/me/.codex/hooks/gsd-update-check.js"' },
        { command: '"/usr/local/bin/node" "/Users/me/.codex/hooks/custom-hook.js"' },
      ],
    };

    const actions = migration.plan({
      configDir,
      readJson: () => ({ exists: true, error: null, value: hooksJson }),
    });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'rewrite-json');
    assert.equal(actions[0].relPath, 'hooks.json');
    assert.deepEqual(actions[0].value, {
      hooks: [
        { command: '"/usr/local/bin/node" "/Users/me/.codex/hooks/custom-hook.js"' },
      ],
    });
  });

  test('plan preserves similarly named commands outside the managed hooks directory', () => {
    const configDir = '/Users/me/.codex';
    const hooksJson = {
      hooks: [
        { command: '"/usr/local/bin/node" "/tmp/other/hooks/gsd-check-update.js"' },
      ],
    };

    const actions = migration.plan({
      configDir,
      readJson: () => ({ exists: true, error: null, value: hooksJson }),
    });

    assert.deepEqual(actions, []);
  });
});
  });
}

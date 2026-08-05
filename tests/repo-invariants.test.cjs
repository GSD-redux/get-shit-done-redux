'use strict';

// Repo-wide invariant scans.
//
// Consolidated home (epic #1969, batch B8 #1977) for regression tests that walk
// whole top-level directories (docs/, agents/, commands/, workflows/, references/,
// templates/, bin/lib/, …) asserting a CROSS-CUTTING invariant with no single
// module subject — e.g. "no retired /gsd-next token in any doc", "no gsd-sdk
// reference in any runtime surface", "ESLint coverage tracks the bin/lib migration",
// "every CLI command family fails cleanly on bad input". Each block below is folded
// verbatim from its origin issue-named file and keeps its origin issue number.


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/551-eslint-bin-lib-coverage.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:551-eslint-bin-lib-coverage (consolidation epic #1969 B8 #1977)", () => {
'use strict';

/**
 * Regression / migration-gate test for #551 and ADR-457 (TS migration).
 *
 * ESLint must apply the correct policy to every gsd-core/bin/lib/*.cjs
 * file as modules migrate from hand-written CJS to tsc-generated artifacts:
 *
 *   - tsc-generated artifact (has src/<basename>.cts counterpart) → MUST be
 *     eslint-ignored.  We lint the *.cts source instead (ADR-457).
 *   - Genuinely hand-written (no src/*.cts counterpart) → MUST be linted
 *     (NOT ignored).  Includes scripts-generated package-identity.cjs which
 *     has no *.cts source.
 *
 * The test is filesystem-driven — it scans bin/lib at runtime and checks each
 * file against the src/ directory, so it stays correct automatically as more
 * modules migrate.  No hardcoded lists.
 *
 * ESLint behaviour is verified via ESLint's own `isPathIgnored()` API so the
 * test reflects real resolved flat-config precedence, not a textual scan of
 * eslint.config.mjs.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ESLint } = require('eslint');

const ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(ROOT, 'gsd-core', 'bin', 'lib');
const SRC_DIR = path.join(ROOT, 'src');

/**
 * Returns true if the given bin/lib/*.cjs file has a corresponding
 * src/<basename>.cts TypeScript source (meaning it is tsc-generated).
 */
function hasTsSource(absPath) {
  const base = path.basename(absPath, '.cjs');
  return (
    fs.existsSync(path.join(SRC_DIR, `${base}.cts`)) ||
    fs.existsSync(path.join(SRC_DIR, `${base}.ts`))
  );
}

let eslint;
before(() => {
  eslint = new ESLint({ cwd: ROOT });
});

describe('ESLint coverage tracks the bin/lib TS migration (ADR-457 / #537)', () => {
  /**
   * Main invariant: scan every *.cjs in bin/lib and assert the correct ESLint
   * policy is applied.
   */
  test('each bin/lib/*.cjs is linted xor ignored according to migration state', async () => {
    const wronglyIgnored = []; // hand-written but ignored — should be linted
    const wronglyLinted = []; // tsc-generated but not ignored — should be ignored

    const entries = fs.readdirSync(LIB_DIR).filter((e) => e.endsWith('.cjs'));
    for (const entry of entries) {
      const abs = path.join(LIB_DIR, entry);
      const generated = hasTsSource(abs);
      const ignored = await eslint.isPathIgnored(abs);

      if (generated && !ignored) {
        wronglyLinted.push(entry);
      } else if (!generated && ignored) {
        wronglyIgnored.push(entry);
      }
    }

    assert.deepEqual(
      wronglyLinted,
      [],
      `tsc-generated bin/lib modules not yet added to ESLint ignore list: ${wronglyLinted.join(', ')}`,
    );
    assert.deepEqual(
      wronglyIgnored,
      [],
      `Hand-written bin/lib modules silently excluded from ESLint: ${wronglyIgnored.join(', ')}`,
    );
  });

  test('semver-compare.cjs (tsc-generated publish artifact) stays eslint-ignored (ADR-457)', async () => {
    const f = path.join(LIB_DIR, 'semver-compare.cjs');
    assert.equal(
      await eslint.isPathIgnored(f),
      true,
      'semver-compare.cjs is a tsc-generated publish-time artifact and must stay ignored',
    );
  });

  test('package-identity.cjs (script-generated, no *.cts source) is linted, not ignored (#551)', async () => {
    const f = path.join(LIB_DIR, 'package-identity.cjs');
    assert.equal(
      await eslint.isPathIgnored(f),
      false,
      'package-identity.cjs has no src/*.cts counterpart and must be linted, not ignored',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// RETIRED: folded:bug-3054-stale-gsd-next-references (consolidation epic #1969 B8 #1977)
// ────────────────────────────────────────────────────────────────────────
//
// This invariant used to fail any docs/workflows/README file that contained
// the literal string `/gsd-next`, on the premise that `/gsd-next` named a
// RETIRED workflow-advance command and any occurrence was a stale reference
// that should have read `/gsd-progress --next` instead.
//
// That premise is now obsolete. #2903 established that human-facing docs
// must use the hyphen command form (`/gsd-<cmd>`), and the maintainer
// resolved the #3054-vs-#2903 conflict in favor of retiring this invariant
// (option B) rather than exempting `next` from the #2903 sweep (option A):
// `/gsd-next` no longer names the retired workflow-advance command — it is
// the correct, live, user-facing name for the state-aware smart-entry
// launcher (`commands/gsd/next.md`), exactly as documented by
// `docs/FEATURES.md`'s REQ-CONSOLIDATE-03 ("`/gsd-next` is not the retired
// workflow-advance command; it is reserved for the state-aware smart-entry
// launcher. Workflow advancement remains under `/gsd-progress --next`.").
//
// Keeping this scan alive would now contradict the documented command form:
// it would fail the build the moment `/gsd-next` legitimately appears in
// docs, which #2903 requires everywhere `next` is referenced. See #3054,
// #2903, and docs/FEATURES.md REQ-CONSOLIDATE-03.


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3810-no-gsd-sdk-runtime-refs.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3810-no-gsd-sdk-runtime-refs (consolidation epic #1969 B8 #1977)", () => {
// allow-test-rule: source-text-is-the-product (see #3810)
// Runtime prompt/hook files are deployed verbatim — their text IS what the
// runtime loads and executes. Asserting that text carries no retired `gsd-sdk`
// reference tests the deployed contract, which no behavioral seam can observe
// (there is no runtime API that enumerates "did any shipped prompt name the
// removed SDK binary").

/**
 * Regression guard: no `gsd-sdk` references in runtime-facing surfaces (#339).
 *
 * The `@opengsd/gsd-sdk` package and its `gsd-sdk` binary were retired (ADR 0174,
 * #191). The bulk runtime cleanup is already done — this test locks it in so a
 * `gsd-sdk` / `GSD_SDK` reference cannot creep back into a shipped prompt or hook
 * and re-introduce drift between the documented surface and the supported
 * `gsd-tools` binary.
 *
 * Scope: runtime surfaces only — the prompts and hooks the installer ships into
 * a user's runtime config dir. Explicitly NOT covered here:
 *   - `bin/install.js` — installer code, not a runtime-deployed prompt/hook
 *     surface. (It carries zero `gsd-sdk` references today; the SDK-shim
 *     verification subsystem was removed in #515 and the shim retired in #522.)
 *   - `gsd-core/bin/` — executable library code, not deployed prompt text; it
 *     may legitimately reference the SDK retirement in comments.
 *   - `tests/`, `docs/`, `.changeset/`, CI/lint scripts — legitimately reference
 *     the SDK retirement as history or detect its stale artifacts.
 *
 * Complements `tests/gsd-tools-path-refs.test.cjs`, which only catches the
 * `gsd-sdk query` binary-invocation form; this catches ANY runtime reference.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

// Runtime surfaces the installer ships. Each entry is { dir, exts } — dir is
// repo-relative, exts is the set of file extensions whose text is deployed.
const RUNTIME_SURFACES = [
  // .md prompts plus the non-.md runtime artifacts this dir also ships:
  // _runtime-launcher.snippet.sh (the canonical launcher synced into every hook
  // by scripts/sync-runtime-launcher.cjs) and discuss-phase/templates/*.json
  // (loaded at runtime by discuss-phase.md). Scanning only .md left these two
  // deployed files uncovered. (#691 review)
  { dir: path.join('gsd-core', 'workflows'), exts: ['.md', '.sh', '.json'] },
  { dir: path.join('gsd-core', 'references'), exts: ['.md'] },
  // Prompt surfaces the installer deep-copies and the runtime loads via
  // `@~/.claude/gsd-core/templates/*.md` anchors in workflows/commands; the
  // lone config.json under templates/ ships too. (#691 review)
  { dir: path.join('gsd-core', 'templates'), exts: ['.md', '.json'] },
  { dir: path.join('gsd-core', 'contexts'), exts: ['.md'] },
  { dir: path.join('commands', 'gsd'), exts: ['.md'] },
  { dir: 'agents', exts: ['.md'] },
  // Hooks ship as executable text (.js/.cjs/.sh). `hooks/dist/` is a gitignored
  // build artifact regenerated from these sources, so scanning the sources is
  // sufficient and avoids asserting against generated copies.
  { dir: 'hooks', exts: ['.js', '.cjs', '.sh'], skipDirs: ['dist'] },
];

// Matches every casing/separator variant of the retired SDK token:
// gsd-sdk, gsd_sdk, GSD-SDK, GSD_SDK, etc.
const SDK_REF = /gsd[-_]sdk/i;

/**
 * Recursively collect files under `absDir` whose extension is in `exts`,
 * skipping any directory name listed in `skipDirs`.
 */
function collectFiles(absDir, exts, skipDirs) {
  if (!fs.existsSync(absDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirs.includes(entry.name)) continue;
      out.push(...collectFiles(path.join(absDir, entry.name), exts, skipDirs));
    } else if (entry.isFile() && exts.includes(path.extname(entry.name))) {
      out.push(path.join(absDir, entry.name));
    }
  }
  return out;
}

function rel(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

describe('#339 no gsd-sdk references in runtime surfaces', () => {
  test('shipped prompts and hooks carry no retired gsd-sdk reference', () => {
    const violations = [];

    for (const { dir, exts, skipDirs = [] } of RUNTIME_SURFACES) {
      const files = collectFiles(path.join(REPO_ROOT, dir), exts, skipDirs);
      for (const file of files) {
        const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (SDK_REF.test(lines[i])) {
            violations.push(`${rel(file)}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      'Runtime surfaces must not reference the retired gsd-sdk binary/package — ' +
        'use gsd-tools instead.\nViolations:\n' + violations.join('\n')
    );
  });

  test('at least one file per configured extension is scanned (guards against an empty sweep)', () => {
    // A path typo, directory rename, or stale extension could silently make
    // collectFiles() return [] for part of a surface, turning the guard above
    // into a no-op that always passes. Checking per-surface isn't enough: for
    // gsd-core/workflows the .md files alone keep a per-surface count > 0, so
    // dropping .sh/.json would stop covering _runtime-launcher.snippet.sh and
    // discuss-phase/templates/*.json while the test stayed green. Assert each
    // configured extension actually resolves to scanned files. (#691 review)
    for (const { dir, exts, skipDirs = [] } of RUNTIME_SURFACES) {
      for (const ext of exts) {
        const count = collectFiles(path.join(REPO_ROOT, dir), [ext], skipDirs).length;
        assert.ok(
          count > 0,
          `Runtime surface "${dir}" resolved to 0 "${ext}" files — the path may ` +
            'have moved or the extension is stale; update RUNTIME_SURFACES so the ' +
            'guard keeps covering it.'
        );
      }
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3593-cli-negative-universal.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3593-cli-negative-universal (consolidation epic #1969 B8 #1977)", () => {
/**
 * Universal CLI negative-matrix sweep across the seven command families
 * named in #3593: phase, roadmap, state, config, workstream, init,
 * validate.
 *
 * The full per-case matrix for each family belongs in dedicated files
 * (the `config` family is the template — see
 * `feat-3593-cli-negative-config.test.cjs`). This file pins a much
 * narrower contract that EVERY family must satisfy:
 *
 *   1. Bare top-level command with no subcommand: must not crash with
 *      a V8 stack trace, must exit non-zero (or, where the bare form
 *      is legitimate, return a clean payload).
 *   2. Unknown subcommand at command depth: must emit a typed reason
 *      under --json-errors and must not crash.
 *   3. Shell-metacharacter as an argv element: must not be executed.
 *      Sentinel-file probe in the project temp dir proves this.
 *
 * Future per-family files will deepen each family's matrix; this file
 * is the floor.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCli } = require('./helpers/cli-negative.cjs');
const { createTempProject, createTempGitProject, cleanup } = require('./helpers.cjs');

/**
 * Each entry names a top-level command, a representative subcommand
 * (for the "unknown sub" probe), and the temp-project factory.
 *
 * The `representativeSubcommand` is not asserted on directly — it
 * exists so the test layout reads "for each family, run probe X" and
 * so a future maintainer adding a family doesn't need to invent one.
 */
const FAMILIES = [
  { name: 'phase',      bare: ['phase'],      unknown: ['phase', 'this-sub-does-not-exist'],      projectFactory: createTempProject },
  { name: 'roadmap',    bare: ['roadmap'],    unknown: ['roadmap', 'this-sub-does-not-exist'],    projectFactory: createTempProject },
  { name: 'state',      bare: ['state'],      unknown: ['state', 'this-sub-does-not-exist'],      projectFactory: createTempProject },
  { name: 'config',     bare: ['config'],     unknown: ['config', 'this-sub-does-not-exist'],     projectFactory: createTempProject },
  { name: 'workstream', bare: ['workstream'], unknown: ['workstream', 'this-sub-does-not-exist'], projectFactory: createTempGitProject },
  { name: 'init',       bare: ['init'],       unknown: ['init', 'this-sub-does-not-exist'],       projectFactory: createTempProject },
  { name: 'validate',   bare: ['validate'],   unknown: ['validate', 'this-sub-does-not-exist'],   projectFactory: createTempProject },
];

describe('feat-3593: bare top-level command does not crash', () => {
  for (const fam of FAMILIES) {
    test(`${fam.name}: bare invocation exits cleanly without a stack trace`, (t) => {
      const projectDir = fam.projectFactory(`cli-neg-univ-bare-${fam.name}-`);
      t.after(() => cleanup(projectDir));
      const result = runCli(fam.bare, { cwd: projectDir });
      assert.equal(result.hasStackTrace, false, `${fam.name} bare must not leak a V8 stack frame`);
      assert.equal(result.signal, null, `${fam.name} bare must not be killed by a signal`);
      // We do not pin exit code here: some families legitimately treat the
      // bare form as a list/status command (status 0); others reject it as
      // a usage error (status ≠ 0). What we pin is "no crash."
    });
  }
});

describe('feat-3593: unknown subcommand emits a typed reason', () => {
  for (const fam of FAMILIES) {
    test(`${fam.name}: unknown subcommand fails with reason set and no stack trace`, (t) => {
      const projectDir = fam.projectFactory(`cli-neg-univ-unk-${fam.name}-`);
      t.after(() => cleanup(projectDir));
      const result = runCli(fam.unknown, { cwd: projectDir });
      assert.notEqual(result.status, 0, `${fam.name} unknown sub must exit non-zero`);
      assert.equal(result.hasStackTrace, false, `${fam.name} unknown sub must not leak a stack frame`);
      // When --json-errors is on, every typed-failure path lands a non-empty
      // reason string from ERROR_REASON. A null reason here means the family
      // is using throw/console.error somewhere — a TDD signal to wire that
      // failure path through error(msg, ERROR_REASON.X).
      assert.equal(typeof result.reason, 'string', `${fam.name}: reason must be a typed enum string (got: ${result.reason})`);
      assert.notEqual(result.reason, '', `${fam.name}: reason must be non-empty`);
    });
  }
});

describe('feat-3593: shell-metacharacter argv values are NOT executed', () => {
  for (const fam of FAMILIES) {
    test(`${fam.name}: shell-payload as subcommand argv does NOT execute the payload`, (t) => {
      const projectDir = fam.projectFactory(`cli-neg-univ-shell-${fam.name}-`);
      t.after(() => cleanup(projectDir));
      // Place the payload where the subcommand value goes. The payload
      // would, if shell-interpreted, create a sentinel file in the
      // project dir. Argv-based invocation must treat it as opaque text.
      const sentinelPayload = `$(touch ${projectDir}/INJ-${fam.name})`;
      const argv = [fam.name, sentinelPayload];
      const result = runCli(argv, { cwd: projectDir });
      // No stack trace — opaque text must not crash.
      assert.equal(result.hasStackTrace, false, `${fam.name}: shell payload must not crash`);
      // The sentinel file must NOT exist. We check the project dir's
      // listing rather than fs.existsSync of a single path so the test
      // surfaces any spelling drift.
      const entries = fs.readdirSync(projectDir);
      const sentinels = entries.filter((n) => n.startsWith('INJ-'));
      assert.deepEqual(
        sentinels,
        [],
        `${fam.name}: shell payload was executed — sentinel files exist: ${sentinels.join(', ')}`,
      );
    });
  }
});

// ─── Cross-family invariants on the global --cwd flag ──────────────────────

test('--cwd with an empty value fails the same way regardless of command family', () => {
  for (const fam of FAMILIES) {
    const result = runCli(['--cwd', '', ...fam.bare], { cwd: process.cwd() });
    assert.notEqual(result.status, 0, `${fam.name}: empty --cwd must fail`);
    assert.equal(result.hasStackTrace, false, `${fam.name}: empty --cwd must not crash`);
    assert.equal(result.reason, 'usage', `${fam.name}: empty --cwd reason should be 'usage', got: ${result.reason}`);
  }
});

test('--cwd pointing at a non-existent path fails uniformly across families', () => {
  const nonExistent = path.join(require('os').tmpdir(), 'cli-neg-univ-no-such-' + Date.now() + '-' + Math.random());
  assert.equal(fs.existsSync(nonExistent), false, 'pre-check: temp path must not exist');
  for (const fam of FAMILIES) {
    const result = runCli(['--cwd', nonExistent, ...fam.bare], { cwd: process.cwd() });
    assert.notEqual(result.status, 0, `${fam.name}: invalid --cwd must fail`);
    assert.equal(result.hasStackTrace, false);
    assert.equal(result.reason, 'usage', `${fam.name}: invalid --cwd reason should be 'usage'`);
  }
});
  });
}

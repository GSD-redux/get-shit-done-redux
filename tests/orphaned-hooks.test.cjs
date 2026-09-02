/**
 * Regression test for #1750: orphaned hook files from removed features
 * (e.g., gsd-intel-*.js) should NOT be flagged as stale by gsd-check-update.js.
 *
 * The stale hooks scanner should only check hooks that are part of the current
 * distribution, not every gsd-*.js file in the hooks directory.
 *
 * Migration note (#455): previously used fs.readFileSync + regex on the worker
 * and build-hooks source to extract arrays. Now imports typed exports directly:
 *   - hooks/managed-hooks-registry.cjs  → MANAGED_HOOKS
 *   - scripts/build-hooks.js            → HOOKS_TO_COPY
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CHECK_UPDATE_PATH = path.join(__dirname, '..', 'hooks', 'gsd-check-update.js');
const WORKER_PATH = path.join(__dirname, '..', 'hooks', 'gsd-check-update-worker.js');
const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

// Typed imports — no source-grep needed (#455)
const { MANAGED_HOOKS } = require(path.join(HOOKS_DIR, 'managed-hooks-registry.cjs'));
const { HOOKS_TO_COPY, HOOKS_SUBDIRS_TO_COPY } = require(path.join(__dirname, '..', 'scripts', 'build-hooks.js'));

describe('orphaned hooks stale detection (#1750)', () => {
  test('MANAGED_HOOKS is an array and does not use a broad gsd-* wildcard', () => {
    // The scanner must reference a known set of managed hook filenames,
    // not a broad startsWith('gsd-') filter that catches orphaned files.
    assert.ok(Array.isArray(MANAGED_HOOKS), 'MANAGED_HOOKS must be an array');
    // Each entry is a concrete filename string — no glob/wildcard patterns
    for (const entry of MANAGED_HOOKS) {
      assert.ok(typeof entry === 'string', `MANAGED_HOOKS entry must be a string, got ${typeof entry}`);
      assert.ok(!entry.includes('*'), `MANAGED_HOOKS entry '${entry}' must not contain wildcards`);
      assert.ok(entry.startsWith('gsd-'), `MANAGED_HOOKS entry '${entry}' must start with gsd-`);
    }
  });

  test('gsd-check-update-worker.js imports managed-hooks-registry.cjs (not inline array)', () => {
    // allow-test-rule: structural-regression-guard (#3545) — presence of a
    // require() wire-up and absence of a reintroduced inline array are source
    // structure facts, not runtime behavior; see file header.
    const content = fs.readFileSync(WORKER_PATH, 'utf8');
    assert.ok(
      content.includes('managed-hooks-registry.cjs'),
      'gsd-check-update-worker.js must require managed-hooks-registry.cjs'
    );
    // The inline MANAGED_HOOKS array must no longer be in the worker
    assert.ok(
      !content.includes('const MANAGED_HOOKS = ['),
      'gsd-check-update-worker.js must not define MANAGED_HOOKS inline — it should import from managed-hooks-registry.cjs'
    );
  });

  test('gsd-check-update.js spawns the worker by file path (not inline -e code)', () => {
    // allow-test-rule: structural-regression-guard (#3545) — spawn-target
    // wiring and absence of inline `-e` code are source structure facts, not
    // runtime behavior; see file header.
    const content = fs.readFileSync(CHECK_UPDATE_PATH, 'utf8');
    assert.ok(
      content.includes('gsd-check-update-worker.js'),
      'gsd-check-update.js must reference gsd-check-update-worker.js as the spawn target'
    );
    assert.ok(
      !content.includes("'-e'"),
      'gsd-check-update.js must not use node -e inline code (logic moved to worker file)'
    );
  });

  test('MANAGED_HOOKS includes each JS hook from HOOKS_TO_COPY', () => {
    assert.ok(Array.isArray(HOOKS_TO_COPY), 'HOOKS_TO_COPY must be an array');
    const jsHooks = HOOKS_TO_COPY.filter(h => h.endsWith('.js'));
    assert.ok(jsHooks.length >= 5, `expected at least 5 JS hooks in HOOKS_TO_COPY, got ${jsHooks.length}`);

    for (const hook of jsHooks) {
      assert.ok(
        MANAGED_HOOKS.includes(hook),
        `MANAGED_HOOKS should include '${hook}' from HOOKS_TO_COPY`
      );
    }
  });

  test('MANAGED_HOOKS is a superset of all gsd-* hooks in HOOKS_TO_COPY (all extensions)', () => {
    // Every hook-named file in HOOKS_TO_COPY (matching the gsd-* naming pattern
    // that the registry governs, regardless of extension) must appear in MANAGED_HOOKS.
    // Non-hook support files like managed-hooks-registry.cjs are intentionally
    // excluded from this check because they are not themselves hooks.
    // This catches missing .sh entries as well as .js entries.
    assert.ok(Array.isArray(HOOKS_TO_COPY), 'HOOKS_TO_COPY must be an array');
    const gsdHooks = HOOKS_TO_COPY.filter(h => h.startsWith('gsd-'));
    assert.ok(gsdHooks.length >= 5, `expected at least 5 gsd-* hooks in HOOKS_TO_COPY, got ${gsdHooks.length}`);

    for (const hook of gsdHooks) {
      assert.ok(
        MANAGED_HOOKS.includes(hook),
        `MANAGED_HOOKS should include '${hook}' (from HOOKS_TO_COPY) — add it to hooks/managed-hooks-registry.cjs`
      );
    }
  });

  test('orphaned hook filenames are NOT in MANAGED_HOOKS', () => {
    const orphanedHooks = [
      'gsd-intel-index.js',
      'gsd-intel-prune.js',
      'gsd-intel-session.js',
    ];

    for (const orphan of orphanedHooks) {
      assert.ok(
        !MANAGED_HOOKS.includes(orphan),
        `orphaned hook '${orphan}' must NOT be in MANAGED_HOOKS`
      );
    }
  });

  test('every same-dir require() target of a shipped hook is itself shipped (#606)', () => {
    // Regression guard for #606: gsd-check-update-worker.js does
    // require('./managed-hooks-registry.cjs'), but that sibling was missing from
    // HOOKS_TO_COPY, so the installer never placed it next to the worker and the
    // background worker crashed at runtime with "Cannot find module". The fix added
    // the file to HOOKS_TO_COPY; this guard fails if any shipped hook ever again
    // requires a same-directory file that the installer would not ship.
    //
    // Scope: only *same-directory* relative requires — require('./x') and
    // require('./subdir/x'). A require('../...') target reaches out of the hooks/
    // dir into sibling package dirs (e.g. gsd-core/) whose shipping is governed
    // by package.json "files", not by this allowlist, so it is out of scope here.
    assert.ok(Array.isArray(HOOKS_SUBDIRS_TO_COPY), 'HOOKS_SUBDIRS_TO_COPY must be exported as an array');

    const SAME_DIR_REQUIRE = /require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
    const jsHooks = HOOKS_TO_COPY.filter(h => /\.c?js$/.test(h));
    assert.ok(jsHooks.length >= 5, `expected at least 5 JS/CJS hooks in HOOKS_TO_COPY, got ${jsHooks.length}`);

    for (const hook of jsHooks) {
      const source = fs.readFileSync(path.join(HOOKS_DIR, hook), 'utf8');
      for (const match of source.matchAll(SAME_DIR_REQUIRE)) {
        const rel = match[1].slice(2); // strip leading './'
        const slash = rel.indexOf('/');
        if (slash === -1) {
          assert.ok(
            HOOKS_TO_COPY.includes(rel),
            `${hook} requires './${rel}', but '${rel}' is not in HOOKS_TO_COPY — the installer ` +
            `would not place it next to ${hook}, so the require would throw at runtime (the #606 class of bug). ` +
            `Add '${rel}' to HOOKS_TO_COPY in scripts/build-hooks.js.`
          );
        } else {
          const subdir = rel.slice(0, slash);
          assert.ok(
            HOOKS_SUBDIRS_TO_COPY.includes(subdir),
            `${hook} requires './${rel}', but subdirectory '${subdir}' is not in HOOKS_SUBDIRS_TO_COPY — ` +
            `the installer would not ship it. Add '${subdir}' to HOOKS_SUBDIRS_TO_COPY in scripts/build-hooks.js.`
          );
        }
      }
    }
  });
});

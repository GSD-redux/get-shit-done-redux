'use strict';

/**
 * #2071 — `gsd-tools effort sync` crashed in an INSTALLED runtime because
 * commands.cjs did `require('../../../bin/install.js')`, but the installer only
 * copies the `gsd-core/` subtree into a runtime home — the package-root
 * `bin/install.js` is never present there, so the require threw MODULE_NOT_FOUND.
 *
 * This does a real minimal install into a temp home (the same helper the
 * golden-parity suite uses) and runs the exact repro from the issue against the
 * installed shim: `node <configDir>/gsd-core/bin/gsd-tools.cjs effort sync`. Pre-fix
 * this throws `Cannot find module '../../../bin/install.js'`; post-fix the
 * install-time resolvers live in the shipped sibling
 * `gsd-core/bin/lib/install-effort-resolver.cjs` and the require resolves.
 *
 * `--config-dir <temp>` keeps it hermetic (targets the temp install, never the
 * developer's real ~/.claude); effort sync defaults to dry-run so nothing is written.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');

const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');

describe('#2071: effort sync runs in an installed runtime (no package-root bin/install.js)', () => {
  test('effort sync does not crash reaching for the un-shipped bin/install.js', () => {
    if (process.platform === 'win32') return; // install layout is POSIX-path-shaped

    const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global' });
    try {
      // Installed layout invariant: the package-root installer is never copied in.
      assert.ok(!fs.existsSync(path.join(root, 'bin', 'install.js')), 'installed home must not contain bin/install.js');
      assert.ok(!fs.existsSync(path.join(configDir, 'bin', 'install.js')), 'no bin/install.js beside gsd-core');

      // A project effort config gives the sync something to resolve.
      fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.planning', 'config.json'),
        JSON.stringify({ effort: { default: 'high' } }),
      );

      const gsdTools = path.join(configDir, 'gsd-core', 'bin', 'gsd-tools.cjs');
      const result = runNode(
        [gsdTools, 'effort', 'sync', '--config-dir', configDir],
        { cwd: root, env: { ...process.env, HOME: root }, timeoutMs: 15000 },
      );
      const combined = `${result.stdout || ''}${result.stderr || ''}`;

      assert.doesNotMatch(
        combined,
        /Cannot find module[^\n]*install\.js|'\.\.\/\.\.\/\.\.\/bin\/install\.js'/,
        `effort sync must not reach for the un-shipped bin/install.js:\n${combined}`,
      );
      assert.doesNotMatch(
        combined,
        /MODULE_NOT_FOUND/,
        `effort sync must not crash on module resolution in an installed runtime:\n${combined}`,
      );
    } finally {
      cleanup(root);
    }
  });
});

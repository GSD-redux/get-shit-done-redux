'use strict';

/**
 * #3031 — opt-in reclaim of the orphaned GSD hooks a pre-#2755 `--kimi-code`
 * install left behind in `~/.kimi`.
 *
 * BACKGROUND. Before #2755 `resolveKimiHooksTomlDir` was unparameterized, so a
 * `--kimi-code` install wrote its GSD `[[hooks]]` block, `hooks/` bundle and
 * CommonJS marker into Kimi CLI's `~/.kimi` instead of Kimi Code's own root.
 * #2755 fixed the forward path but could not clean up what the old bug already
 * wrote: the stale block is BYTE-IDENTICAL to a legitimate Kimi CLI one (both
 * runtimes render the same 1526-byte block for the same root — the command
 * paths derive from the hooks root, not the runtime), so nothing on disk can
 * distinguish "litter GSD wrote for kimi-code" from "Kimi CLI's working hooks".
 *
 * Because the state is undecidable, cleanup is OPT-IN: `--reclaim-kimi-legacy`
 * on a `--kimi-code` install. That keeps #2755's own acceptance criterion
 * intact ("Uninstalling GSD hooks for one runtime does not touch or remove the
 * other runtime's hooks") — a dual-product user simply never passes the flag.
 *
 * These tests drive the real user-reachable surface: a spawned `bin/install.js`
 * against a sandbox HOME pre-seeded with the pre-#2755 wreckage.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');
const {
  stripKimiHooksTomlBlock,
  KIMI_HOOKS_TOML_MARKER_BEGIN,
  KIMI_HOOKS_TOML_MARKER_END,
} = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const { COMMONJS_MARKER_CONTENT } = require('../gsd-core/bin/lib/commonjs-marker.cjs');

const RECLAIM_FLAG = '--reclaim-kimi-legacy';

// A GSD hook script name that the bundle really installs, so the seeded
// wreckage matches what the pre-#2755 installer actually left behind.
const SEEDED_GSD_HOOK = 'gsd-check-update.js';

/** Does this config.toml still carry GSD's managed block? */
function hasGsdHooksBlock(tomlPath) {
  if (!fs.existsSync(tomlPath)) return false;
  return fs.readFileSync(tomlPath, 'utf8').includes(KIMI_HOOKS_TOML_MARKER_BEGIN);
}

/**
 * Seed a sandbox HOME with exactly what a pre-#2755 `--kimi-code` install left
 * in `~/.kimi`: the GSD block in the native config.toml, the hooks bundle, and
 * the CommonJS marker inside hooks/.
 *
 * @param {string} home           sandbox HOME
 * @param {string} [userTomlPre]  user-authored TOML to place BEFORE the block
 * @param {string} [userTomlPost] user-authored TOML to place AFTER the block
 * @param {string} [dirName]      legacy root basename (default `.kimi`)
 */
function seedLegacyKimiRoot(home, { userTomlPre = '', userTomlPost = '', dirName = '.kimi' } = {}) {
  const root = path.join(home, dirName);
  const hooksDir = path.join(root, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const block = [
    KIMI_HOOKS_TOML_MARKER_BEGIN,
    '',
    '[[hooks]]',
    'event = "SessionStart"',
    `command = "node \\"${root.replace(/\\/g, '/')}/hooks/${SEEDED_GSD_HOOK}\\""`,
    '',
    KIMI_HOOKS_TOML_MARKER_END,
  ].join('\n');

  const parts = [userTomlPre, block, userTomlPost].filter((p) => p !== '');
  fs.writeFileSync(path.join(root, 'config.toml'), `${parts.join('\n\n')}\n`);

  fs.writeFileSync(path.join(hooksDir, SEEDED_GSD_HOOK), '// GSD hook\n');
  fs.writeFileSync(path.join(hooksDir, 'package.json'), COMMONJS_MARKER_CONTENT);

  return { root, hooksDir, tomlPath: path.join(root, 'config.toml') };
}

/** One sandbox HOME reused by an install; caller registers teardown. */
function freshHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3031-'));
  t.after(() => cleanup(home));
  return home;
}

describe('#3031 — opt-in reclaim of orphaned ~/.kimi GSD artifacts', () => {
  // Row 1 — the failing-first regression.
  test('reclaims the legacy ~/.kimi GSD artifacts when --reclaim-kimi-legacy is passed', (t) => {
    const home = freshHome(t);
    const legacy = seedLegacyKimiRoot(home);

    runMinimalInstall({
      runtime: 'kimi-code',
      scope: 'global',
      root: home,
      extraArgs: [RECLAIM_FLAG],
    });

    assert.equal(hasGsdHooksBlock(legacy.tomlPath), false,
      'the stale GSD [[hooks]] block must be gone from ~/.kimi/config.toml');
    assert.equal(fs.existsSync(path.join(legacy.hooksDir, SEEDED_GSD_HOOK)), false,
      'the orphaned GSD hook script must be removed from ~/.kimi/hooks/');
    assert.equal(fs.existsSync(path.join(legacy.hooksDir, 'package.json')), false,
      'the orphaned CommonJS marker must be removed from ~/.kimi/hooks/');

    // The reclaim must not have disturbed the install it accompanied.
    assert.ok(hasGsdHooksBlock(path.join(home, '.kimi-code', 'config.toml')),
      'the kimi-code install must still have written its own GSD block');
  });

  // Row 2 — opt-in contract: no flag, no deletion.
  test('leaves ~/.kimi untouched without the flag (cleanup is opt-in)', (t) => {
    const home = freshHome(t);
    const legacy = seedLegacyKimiRoot(home);
    const before = fs.readFileSync(legacy.tomlPath, 'utf8');

    runMinimalInstall({ runtime: 'kimi-code', scope: 'global', root: home });

    assert.equal(fs.readFileSync(legacy.tomlPath, 'utf8'), before,
      '~/.kimi/config.toml must be byte-identical when the flag is absent');
    assert.ok(fs.existsSync(path.join(legacy.hooksDir, SEEDED_GSD_HOOK)),
      'the hook bundle must survive when the flag is absent');
  });

  // Row 3 — independence / negative space.
  test('preserves user-authored config.toml sections and non-GSD hook files', (t) => {
    const home = freshHome(t);
    const userPre = '[providers.moonshot]\napi_key = "USER-OWNED"';
    const userPost = '[ui]\ntheme = "dark"';
    const legacy = seedLegacyKimiRoot(home, { userTomlPre: userPre, userTomlPost: userPost });

    const userHook = path.join(legacy.hooksDir, 'my-own-hook.js');
    fs.writeFileSync(userHook, '// authored by the user\n');

    runMinimalInstall({
      runtime: 'kimi-code',
      scope: 'global',
      root: home,
      extraArgs: [RECLAIM_FLAG],
    });

    const after = fs.readFileSync(legacy.tomlPath, 'utf8');
    assert.equal(hasGsdHooksBlock(legacy.tomlPath), false, 'GSD block must be gone');
    assert.match(after, /api_key = "USER-OWNED"/, 'user provider section must survive');
    assert.match(after, /theme = "dark"/, 'user ui section must survive');
    assert.ok(fs.existsSync(userHook), 'a user-authored hook script must never be removed');
  });

  // Row 4 — self-delete guard.
  test('never reclaims when the install runtime is kimi itself', (t) => {
    const home = freshHome(t);
    const legacy = seedLegacyKimiRoot(home);

    runMinimalInstall({
      runtime: 'kimi',
      scope: 'global',
      root: home,
      extraArgs: [RECLAIM_FLAG],
    });

    assert.ok(hasGsdHooksBlock(legacy.tomlPath),
      'a --kimi install must never reclaim ~/.kimi — that is its own hooks root');
  });

  // Row 5 — root-collision guard.
  test('skips reclaim when the legacy root resolves to the install root', (t) => {
    const home = freshHome(t);
    const shared = path.join(home, 'shared-kimi');
    fs.mkdirSync(shared, { recursive: true });

    runMinimalInstall({
      runtime: 'kimi-code',
      scope: 'global',
      root: home,
      extraArgs: [RECLAIM_FLAG],
      extraEnv: { KIMI_SHARE_DIR: shared, KIMI_CODE_HOME: shared },
    });

    // Both roots collapsed onto one dir, so "reclaim the legacy root" and "the
    // root this install just wrote" are the same path. The block written by
    // THIS install must survive.
    assert.ok(hasGsdHooksBlock(path.join(shared, 'config.toml')),
      'reclaim must not delete the hooks block this very install just wrote');
  });

  // Row 6 — empty input.
  test('is a no-op when no legacy ~/.kimi root exists', (t) => {
    const home = freshHome(t);

    runMinimalInstall({
      runtime: 'kimi-code',
      scope: 'global',
      root: home,
      extraArgs: [RECLAIM_FLAG],
    });

    assert.equal(fs.existsSync(path.join(home, '.kimi', 'config.toml')), false,
      'reclaim must not create a legacy root that never existed');
    assert.ok(hasGsdHooksBlock(path.join(home, '.kimi-code', 'config.toml')),
      'the kimi-code install itself must still succeed');
  });

  // Row 7 — idempotence.
  test('is idempotent across repeated reclaims', (t) => {
    const home = freshHome(t);
    const legacy = seedLegacyKimiRoot(home);

    const args = { runtime: 'kimi-code', scope: 'global', root: home, extraArgs: [RECLAIM_FLAG] };
    runMinimalInstall(args);
    const afterFirst = fs.existsSync(legacy.tomlPath)
      ? fs.readFileSync(legacy.tomlPath, 'utf8')
      : null;

    // runMinimalInstall asserts exit 0, so a crash on the second pass fails here.
    runMinimalInstall(args);
    const afterSecond = fs.existsSync(legacy.tomlPath)
      ? fs.readFileSync(legacy.tomlPath, 'utf8')
      : null;

    assert.equal(afterSecond, afterFirst,
      'a second reclaim must change nothing further');
  });

  // Row 8 — property: stripping never destroys user content.
  test('property: stripping the GSD block never destroys user content', () => {
    const userText = fc.stringMatching(/^[A-Za-z0-9_= ."[\]]{1,40}$/);

    fc.assert(
      fc.property(userText, userText, (pre, post) => {
        const block = [
          KIMI_HOOKS_TOML_MARKER_BEGIN,
          '',
          '[[hooks]]',
          'event = "SessionStart"',
          '',
          KIMI_HOOKS_TOML_MARKER_END,
        ].join('\n');

        const content = `${pre}\n\n${block}\n\n${post}\n`;
        const stripped = stripKimiHooksTomlBlock(content);

        // The block itself must be gone...
        assert.ok(stripped === null || !stripped.includes(KIMI_HOOKS_TOML_MARKER_BEGIN));

        // ...and every user-authored line must survive verbatim.
        const survives = (text) => {
          const trimmed = text.trim();
          if (trimmed === '') return true;
          return stripped !== null && stripped.includes(trimmed);
        };
        assert.ok(survives(pre), `user prefix lost: ${JSON.stringify(pre)}`);
        assert.ok(survives(post), `user suffix lost: ${JSON.stringify(post)}`);
      }),
      { numRuns: 100 },
    );
  });
});

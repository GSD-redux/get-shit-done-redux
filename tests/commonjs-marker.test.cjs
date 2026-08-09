'use strict';

/**
 * CommonJS marker ownership — regression coverage for #2544.
 *
 * `installSharedHooksBundle` used to write `{"type":"commonjs"}` over
 * `<configRoot>/package.json` unconditionally — no existence check, no merge,
 * no backup. On OpenCode and Kilo that file is documented, user-writable
 * territory (it is where local-plugin npm dependencies are declared), so every
 * install and every `/gsd-update` destroyed the user's `name`, `type`,
 * `dependencies`, and `scripts`.
 *
 * The uninstall path had always read the file first and unlinked it only on an
 * exact content match. The defect was that asymmetry: the discipline existed,
 * it just was not applied on the write side.
 *
 * The fix moves the marker into the directories GSD actually fills with its own
 * `.js` files — `hooks/` and the `nativePlugin.dir` — and routes install and
 * uninstall through one shared ownership predicate. These tests pin both
 * halves: the config root is never written, and a user-authored package.json is
 * never overwritten even where GSD does write.
 *
 * Coverage maps to the issue's acceptance criteria:
 *   AC1 — a user-authored config-root package.json survives a fresh install
 *   AC2 — it survives a second install (the `/gsd-update` re-install path)
 *   AC3 — GSD's staged .js files still resolve as CommonJS
 *   AC4 — uninstall removes only markers GSD wrote
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { BUILD_TIMEOUT_MS, INSTALL_TIMEOUT_MS, PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  COMMONJS_MARKER,
  classifyMarker,
  ensureCommonJsMarker,
  removeCommonJsMarker,
} = require('../gsd-core/bin/lib/commonjs-marker.cjs');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');

/** A realistic OpenCode-shape config-root package.json (the issue's repro). */
const USER_PACKAGE_JSON = JSON.stringify(
  {
    name: 'my-opencode-config',
    type: 'module',
    dependencies: { shescape: '^2.1.0', zod: '^3.23.8' },
    scripts: { postinstall: 'echo user-owned' },
  },
  null,
  2,
) + '\n';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Run the real installer against a throwaway config root.
 *
 * HOME/USERPROFILE/CLAUDE_CONFIG_DIR are all redirected into the temp tree so
 * the installer can never reach the developer's live profile — gsd-core's
 * installer resolves through exactly those variables.
 */
function runInstall(root, runtime, extraArgs = []) {
  const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root };
  delete env.GSD_TEST_MODE;
  const result = runNode(
    [INSTALL_SCRIPT, `--${runtime}`, '--global', '--config-dir', root, ...extraArgs],
    { cwd: root, env, timeoutMs: INSTALL_TIMEOUT_MS },
  );
  assert.equal(
    result.exitCode,
    0,
    `installer exited ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result;
}

describe('commonjs-marker: ownership predicate', () => {
  test('classifies absent, GSD-owned, and foreign package.json files', (t) => {
    const dir = mkTmp('cjs-marker-classify-');
    t.after(() => cleanup(dir));

    assert.equal(classifyMarker(dir), 'absent');

    fs.writeFileSync(path.join(dir, 'package.json'), `${COMMONJS_MARKER}\n`);
    assert.equal(classifyMarker(dir), 'gsd-owned');

    fs.writeFileSync(path.join(dir, 'package.json'), USER_PACKAGE_JSON);
    assert.equal(classifyMarker(dir), 'foreign');
  });

  test('ensureCommonJsMarker never overwrites a foreign package.json', (t) => {
    const dir = mkTmp('cjs-marker-ensure-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'package.json');

    assert.equal(ensureCommonJsMarker(dir), 'written');
    assert.equal(fs.readFileSync(target, 'utf8').trim(), COMMONJS_MARKER);

    // Idempotent: a re-install must not churn the file.
    assert.equal(ensureCommonJsMarker(dir), 'unchanged');

    // Foreign content is preserved byte-for-byte.
    fs.writeFileSync(target, USER_PACKAGE_JSON);
    const before = sha256(fs.readFileSync(target));
    assert.equal(ensureCommonJsMarker(dir), 'preserved-foreign');
    assert.equal(sha256(fs.readFileSync(target)), before);
  });

  test('a symlinked package.json is foreign — never followed, never removed', (t) => {
    const dir = mkTmp('cjs-marker-symlink-');
    t.after(() => cleanup(dir));
    const outside = path.join(dir, 'outside.json');
    const owned = path.join(dir, 'owned');
    fs.mkdirSync(owned);
    const link = path.join(owned, 'package.json');

    // A DANGLING symlink is the dangerous case: existsSync() reports false for
    // it, so an existsSync-based guard would classify `absent` and then write
    // straight through the link, landing outside the directory GSD owns.
    fs.symlinkSync(outside, link);
    assert.equal(classifyMarker(owned), 'foreign');
    assert.equal(ensureCommonJsMarker(owned), 'preserved-foreign');
    assert.ok(!fs.existsSync(outside), 'the write must not follow the symlink out of the directory');
    assert.equal(removeCommonJsMarker(owned), false, 'a symlink is never GSD-owned');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink itself must survive');
  });

  test('the #2717 hooks-surface helpers inherit the same symlink guard', (t) => {
    const dir = mkTmp('cjs-marker-hookssurface-');
    t.after(() => cleanup(dir));

    // #2717 added a SECOND copy of these helpers in runtime-hooks-surface.cts
    // for the runtimes that stage .js hooks via dedicated paths
    // (cursor/windsurf/codex). That copy probed with `fs.existsSync`, which
    // follows symlinks and reports false for a DANGLING one — so it classified
    // the link `absent` and wrote straight through it, landing outside the
    // directory GSD owns. #2544 makes it delegate to commonjs-marker instead.
    //
    // This asserts the hardening reaches that path, not just the module: it is
    // the only coverage that fails if the duplicate is ever reintroduced, since
    // the two implementations agree on every non-adversarial input.
    const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

    const outside = path.join(dir, 'escaped.json');
    const owned = path.join(dir, 'hooks');
    fs.mkdirSync(owned);
    fs.symlinkSync(outside, path.join(owned, 'package.json'));

    assert.equal(
      hooksSurface.ensureCommonJsMarker(owned),
      false,
      'a dangling symlink is not GSD-owned, so the marker must not be reported present',
    );
    assert.ok(
      !fs.existsSync(outside),
      'the write must not follow the symlink out of the hooks directory',
    );
    assert.equal(
      hooksSurface.removeCommonJsMarkerIfGsdOwned(owned),
      false,
      'a symlink is never GSD-owned, so uninstall must not remove it',
    );
  });

  // The #2717 writers mkdir hooks/ unconditionally, then staged their scripts
  // conditionally on the source existing — so with an empty hooks source they
  // created a directory, filled it with nothing, and marked it as GSD's anyway.
  // That is the same write-into-territory-GSD-did-not-fill this issue is about,
  // and it is what `stagedHooks` guards on the shared-bundle path. These pin the
  // matching gate on the two dedicated writers.
  for (const rt of ['cursor', 'windsurf']) {
    test(`${rt}: staging zero hook scripts leaves hooks/ marker-free`, (t) => {
      const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
      const root = mkTmp(`gsd-2544-${rt}-nostage-`);
      t.after(() => cleanup(root));

      // A src tree whose hooks/ dir exists but holds none of the runtime's
      // scripts — the writer stages nothing and must not claim the directory.
      const emptySrc = path.join(root, 'src');
      fs.mkdirSync(path.join(emptySrc, 'hooks'), { recursive: true });
      const targetDir = path.join(root, 'target');
      fs.mkdirSync(targetDir, { recursive: true });

      const write = rt === 'cursor'
        ? hooksSurface.writeCursorHooksJson
        : hooksSurface.writeWindsurfHooksJson;
      write(targetDir, emptySrc);

      const hooksDir = path.join(targetDir, 'hooks');
      const staged = fs.existsSync(hooksDir)
        ? fs.readdirSync(hooksDir).filter((f) => f.endsWith('.js'))
        : [];
      assert.equal(staged.length, 0, 'precondition: the writer staged no scripts');
      assert.ok(
        !fs.existsSync(path.join(hooksDir, 'package.json')),
        `${rt} must not mark a hooks/ directory it staged nothing into`,
      );
    });
  }

  test('removeCommonJsMarker removes only GSD-owned markers', (t) => {
    const dir = mkTmp('cjs-marker-remove-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'package.json');

    fs.writeFileSync(target, USER_PACKAGE_JSON);
    assert.equal(removeCommonJsMarker(dir), false);
    assert.ok(fs.existsSync(target), 'a foreign package.json must survive uninstall');

    fs.writeFileSync(target, `${COMMONJS_MARKER}\n`);
    assert.equal(removeCommonJsMarker(dir), true);
    assert.ok(!fs.existsSync(target));
  });
});

/**
 * Fault injection (CONTRIBUTING.md:514-531, mandatory for install/uninstall
 * flows). Every branch below is one whose doc comment claims it as the module's
 * safety posture, and none of them is reachable from a happy-path test.
 *
 * These override fs methods and restore in `finally` rather than using
 * `chmod 0o000`: chmod does not fault under root, so a permissions-based test
 * passes vacuously with zero coverage in root Docker and CI containers.
 */
describe('commonjs-marker: fault injection', () => {
  /** Swap one fs method for the duration of `fn`, restoring even on throw. */
  function withPatched(key, impl, fn) {
    const original = fs[key];
    fs[key] = impl;
    try {
      return fn();
    } finally {
      fs[key] = original;
    }
  }

  const errWith = (code) => Object.assign(new Error(`synthetic ${code}`), { code });

  test('classifyMarker: a non-ENOENT lstat error fails CLOSED to foreign', (t) => {
    const dir = mkTmp('cjs-marker-lstat-fault-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, 'package.json'), `${COMMONJS_MARKER}\n`);

    // EACCES on the stat itself. Reporting `absent` here would license the
    // overwrite this module exists to prevent, so the answer must be `foreign`.
    const result = withPatched('lstatSync', () => { throw errWith('EACCES'); },
      () => classifyMarker(dir));
    assert.equal(result, 'foreign');
  });

  test('classifyMarker: ENOENT from lstat still reports absent', (t) => {
    const dir = mkTmp('cjs-marker-enoent-');
    t.after(() => cleanup(dir));
    // The discriminating control for the test above: only ENOENT means absent.
    const result = withPatched('lstatSync', () => { throw errWith('ENOENT'); },
      () => classifyMarker(dir));
    assert.equal(result, 'absent');
  });

  test('classifyMarker: an unreadable file fails CLOSED to foreign', (t) => {
    const dir = mkTmp('cjs-marker-read-fault-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, 'package.json'), `${COMMONJS_MARKER}\n`);

    // Present-but-unreadable never downgrades to the permissive answer — the
    // file's bytes are exactly GSD's marker, and it must STILL classify foreign
    // because we could not prove it.
    const result = withPatched('readFileSync', () => { throw errWith('EACCES'); },
      () => classifyMarker(dir));
    assert.equal(result, 'foreign');
  });

  test('classifyMarker: a DIRECTORY at the marker path is foreign', (t) => {
    const dir = mkTmp('cjs-marker-dir-');
    t.after(() => cleanup(dir));
    // CONTRIBUTING.md:521 names this case explicitly. The symlink case is
    // covered above with a real symlink; the directory case needs no fault
    // injection at all, just a real directory.
    fs.mkdirSync(path.join(dir, 'package.json'));

    assert.equal(classifyMarker(dir), 'foreign');
    assert.equal(ensureCommonJsMarker(dir), 'preserved-foreign');
    assert.equal(removeCommonJsMarker(dir), false);
    assert.ok(fs.statSync(path.join(dir, 'package.json')).isDirectory(),
      'the directory must survive untouched');
  });

  test('ensureCommonJsMarker: the TOCTOU EEXIST branch returns preserved-foreign', (t) => {
    const dir = mkTmp('cjs-marker-toctou-');
    t.after(() => cleanup(dir));

    // classifyMarker says `absent`, then something appears at the path before
    // the write lands. `flag:'wx'` turns that race into EEXIST instead of a
    // follow-or-overwrite — this branch is the entire reason for `wx`.
    const result = withPatched('writeFileSync', () => { throw errWith('EEXIST'); },
      () => ensureCommonJsMarker(dir));
    assert.equal(result, 'preserved-foreign');
  });

  test('ensureCommonJsMarker: a write error is reported, never thrown', (t) => {
    const dir = mkTmp('cjs-marker-write-fault-');
    t.after(() => cleanup(dir));

    // EACCES on a read-only hooks/, EROFS, ENOSPC. Every other marker
    // interaction is best-effort; this one used to be fatal and abort the whole
    // install with a raw stack trace.
    for (const code of ['EACCES', 'EROFS', 'ENOSPC']) {
      const result = withPatched('writeFileSync', () => { throw errWith(code); },
        () => ensureCommonJsMarker(dir));
      assert.equal(result, 'failed', `${code} must report failed, not throw`);
    }
  });

  test('ensureCommonJsMarker: a mkdir error is reported, never thrown', (t) => {
    const dir = mkTmp('cjs-marker-mkdir-fault-');
    t.after(() => cleanup(dir));

    // Creating the directory is the same environmental hazard as writing into
    // it, so it lives inside the same guard. This sat OUTSIDE the try until
    // #2544 review round 2.
    const result = withPatched('mkdirSync', () => { throw errWith('EROFS'); },
      () => ensureCommonJsMarker(path.join(dir, 'nested')));
    assert.equal(result, 'failed');
  });

  test('removeCommonJsMarker: an unlink failure returns false, never throws', (t) => {
    const dir = mkTmp('cjs-marker-unlink-fault-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'package.json');
    fs.writeFileSync(target, `${COMMONJS_MARKER}\n`);

    const result = withPatched('unlinkSync', () => { throw errWith('EACCES'); },
      () => removeCommonJsMarker(dir));
    assert.equal(result, false);
    assert.ok(fs.existsSync(target), 'the file is still there — the report must say so');
  });
});

describe('#2544 regression: install must not clobber the config-root package.json', () => {
  // hooks/dist is gitignored and built; scoped CI lanes do not run build:hooks,
  // so build it idempotently before driving a real install.
  before(() => {
    const build = runNode([BUILD_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS });
    assert.equal(build.exitCode, 0, `build:hooks failed: ${build.stderr}`);
  });

  for (const runtime of ['opencode', 'claude']) {
    test(`${runtime}: a user-authored package.json survives install and re-install`, (t) => {
      const root = mkTmp(`gsd-2544-${runtime}-`);
      t.after(() => cleanup(root));
      const userPkg = path.join(root, 'package.json');
      fs.writeFileSync(userPkg, USER_PACKAGE_JSON);
      const before = sha256(fs.readFileSync(userPkg));

      // AC1 — fresh install leaves it untouched.
      runInstall(root, runtime);
      assert.equal(
        sha256(fs.readFileSync(userPkg)),
        before,
        'fresh install must not modify the user-authored config-root package.json',
      );

      // AC2 — the /gsd-update re-install path leaves it untouched too.
      runInstall(root, runtime);
      assert.equal(
        sha256(fs.readFileSync(userPkg)),
        before,
        're-install must not modify the user-authored config-root package.json',
      );

      // The user's own keys are still readable and intact.
      const parsed = JSON.parse(fs.readFileSync(userPkg, 'utf8'));
      assert.equal(parsed.name, 'my-opencode-config');
      assert.equal(parsed.type, 'module');
      assert.deepEqual(parsed.dependencies, { shescape: '^2.1.0', zod: '^3.23.8' });
      assert.deepEqual(parsed.scripts, { postinstall: 'echo user-owned' });

      // AC3 — GSD's own staged scripts still get a CommonJS marker, from the
      // directory GSD owns, so `require` keeps working under "type": "module".
      const hooksMarker = path.join(root, 'hooks', 'package.json');
      assert.ok(fs.existsSync(hooksMarker), 'hooks/package.json marker must be staged');
      assert.equal(JSON.parse(fs.readFileSync(hooksMarker, 'utf8')).type, 'commonjs');
    });
  }

  test('staged hook helpers still load as CommonJS under a "type": "module" config root', (t) => {
    const root = mkTmp('gsd-2544-esm-');
    t.after(() => cleanup(root));
    // The config root declares ESM — the exact shape that breaks Node's
    // walk-up resolution for GSD's staged .js files.
    fs.writeFileSync(path.join(root, 'package.json'), USER_PACKAGE_JSON);
    runInstall(root, 'opencode');

    // Actually require a staged CommonJS helper. Without a marker inside
    // hooks/, the walk-up lands on the user's "type": "module" and this throws
    // ERR_REQUIRE_ESM / "require is not defined" — the regression AC3 forbids.
    const target = path.join(root, 'hooks', 'lib', 'git-cmd.js');
    assert.ok(fs.existsSync(target), 'hooks/lib/git-cmd.js must be staged');
    const probe = runNode(
      ['-e', `const m = require(${JSON.stringify(target)}); if (typeof m.isGitSubcommand !== 'function') { throw new Error('unexpected exports'); } console.log('loaded');`],
      { cwd: root, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.equal(
      probe.exitCode,
      0,
      `staged hook helper must load as CommonJS under an ESM config root\nstderr: ${probe.stderr}`,
    );
    assert.match(probe.stdout, /loaded/);
  });

  test('opencode: the native plugin dir gets its own marker', (t) => {
    const root = mkTmp('gsd-2544-plugin-');
    t.after(() => cleanup(root));
    runInstall(root, 'opencode');

    // The adapter is staged as .js, so it needs a marker in its own directory
    // now that the config root no longer carries one. A package.json here is
    // inert to plugin discovery: OpenCode globs plugins/*.{ts,js}.
    assert.ok(fs.existsSync(path.join(root, 'plugins', 'gsd-core.js')));
    const pluginMarker = path.join(root, 'plugins', 'package.json');
    assert.ok(fs.existsSync(pluginMarker), 'plugins/package.json marker must be staged');
    assert.equal(JSON.parse(fs.readFileSync(pluginMarker, 'utf8')).type, 'commonjs');
  });

  test('install writes no package.json at the config root when none existed', (t) => {
    const root = mkTmp('gsd-2544-noroot-');
    t.after(() => cleanup(root));
    runInstall(root, 'opencode');

    assert.ok(
      !fs.existsSync(path.join(root, 'package.json')),
      'GSD must not create a package.json in the runtime config root',
    );
  });

  test('uninstall removes GSD markers but preserves a user-authored one', (t) => {
    const root = mkTmp('gsd-2544-uninstall-');
    t.after(() => cleanup(root));
    const userPkg = path.join(root, 'package.json');
    fs.writeFileSync(userPkg, USER_PACKAGE_JSON);
    const before = sha256(fs.readFileSync(userPkg));

    runInstall(root, 'opencode');
    runInstall(root, 'opencode', ['--uninstall']);

    // AC4 — GSD's own markers are gone; the user's file is untouched.
    assert.ok(fs.existsSync(userPkg), 'uninstall must not remove a user-authored package.json');
    assert.equal(sha256(fs.readFileSync(userPkg)), before);
    assert.ok(
      !fs.existsSync(path.join(root, 'hooks', 'package.json')),
      'uninstall must remove the hooks/ marker it wrote',
    );
    assert.ok(
      !fs.existsSync(path.join(root, 'plugins', 'package.json')),
      'uninstall must remove the plugin-dir marker it wrote',
    );
  });

  test('uninstall does not prune a plugin dir GSD removed nothing from', (t) => {
    const root = mkTmp('gsd-2544-rmdir-');
    t.after(() => cleanup(root));
    runInstall(root, 'opencode');

    // Strip GSD's own artifacts by hand, leaving an EMPTY plugins/ directory
    // that — from uninstall's point of view — GSD never filled. Hoisting the
    // rmdir out of the adapter-exists guard (so the marker-only case could
    // prune) must not widen it into deleting a user-created empty plugin dir:
    // that is the same "don't touch territory GSD didn't fill" principle this
    // issue is about, inverted.
    const pluginsDir = path.join(root, 'plugins');
    fs.unlinkSync(path.join(pluginsDir, 'gsd-core.js'));
    fs.unlinkSync(path.join(pluginsDir, 'package.json'));
    assert.deepEqual(fs.readdirSync(pluginsDir), [], 'precondition: the dir is empty');

    runInstall(root, 'opencode', ['--uninstall']);

    assert.ok(
      fs.existsSync(pluginsDir),
      'an empty plugin dir GSD removed nothing from must survive uninstall',
    );
  });

  test('uninstall reclaims the plugin-dir marker even if the adapter is already gone', (t) => {
    const root = mkTmp('gsd-2544-partial-');
    t.after(() => cleanup(root));
    runInstall(root, 'opencode');

    // Model a partial install / hand-deleted adapter. The marker cleanup must
    // not be gated on the adapter still being present, or it is stranded and
    // the directory can never prune.
    fs.unlinkSync(path.join(root, 'plugins', 'gsd-core.js'));
    runInstall(root, 'opencode', ['--uninstall']);

    assert.ok(
      !fs.existsSync(path.join(root, 'plugins', 'package.json')),
      'the plugin-dir marker must be reclaimed even without the adapter',
    );
  });

  test('a pre-existing hooks/ dir GSD never fills stays marker-free', (t) => {
    const root = mkTmp('gsd-2544-stagedhooks-');
    t.after(() => cleanup(root));

    // Scope, stated precisely: this pins the OUTCOME — a pre-existing,
    // GSD-untouched hooks/ stays marker-free — for a runtime GSD stages no .js
    // into. It does NOT exercise installSharedHooksBundle's `stagedHooks` gate:
    // zcode declares skipSharedHooksInstall, so the outer guard in bin/install.js
    // skips that helper entirely and the gate is never evaluated. For a runtime
    // that DOES reach the bundle, `stagedHooks` is true whenever any hook source
    // exists, so the gate is only distinguishable under fault injection. The two
    // `staging zero hook scripts` tests above are the ones that pin a real
    // staged-nothing gate, on the #2717 writers.
    //
    // ZCode, not Windsurf. Windsurf was the original choice because
    // hostBehaviors.skipSharedHooksInstall kept it out of the shared bundle —
    // but #2717 then began staging cursor/windsurf/codex .js hooks via dedicated
    // paths and writing the marker beside them, so for those three GSD now DOES
    // fill hooks/ and the marker is correct. ZCode is the durable choice: per
    // #1821 it has hooksSurface:'none' AND no plugin surface to spawn hooks, so
    // GSD stages no .js there by either route. (Measured on this tree: zcode
    // stages 0 .js hooks and gets no marker; windsurf stages 2 and gets one.)
    const userHooks = path.join(root, 'hooks');
    fs.mkdirSync(userHooks, { recursive: true });
    fs.writeFileSync(path.join(userHooks, 'my-hook.js'), '// user-authored\n');

    runInstall(root, 'zcode');

    assert.ok(
      !fs.existsSync(path.join(userHooks, 'package.json')),
      'GSD must not mark a hooks/ directory it never staged into',
    );
    assert.ok(
      fs.existsSync(path.join(userHooks, 'my-hook.js')),
      "the user's own hooks/ contents must be untouched",
    );
  });

  test('pi: the extensions/ marker is installed and reclaimed on uninstall', (t) => {
    const root = mkTmp('gsd-2544-pi-');
    t.after(() => cleanup(root));

    runInstall(root, 'pi');
    const marker = path.join(root, 'extensions', 'package.json');
    assert.ok(fs.existsSync(marker), 'pi extensions/package.json marker must be staged');
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).type, 'commonjs');

    runInstall(root, 'pi', ['--uninstall']);
    assert.ok(!fs.existsSync(marker), 'uninstall must remove the extensions/ marker it wrote');
  });

  test('pi: a user-authored extensions/package.json survives install and uninstall', (t) => {
    const root = mkTmp('gsd-2544-pi-user-');
    t.after(() => cleanup(root));

    const extDir = path.join(root, 'extensions');
    fs.mkdirSync(extDir, { recursive: true });
    const userPkg = path.join(extDir, 'package.json');
    fs.writeFileSync(userPkg, USER_PACKAGE_JSON);
    const before = sha256(fs.readFileSync(userPkg));

    runInstall(root, 'pi');
    assert.equal(sha256(fs.readFileSync(userPkg)), before,
      'install must not overwrite a user-authored extensions/package.json');

    runInstall(root, 'pi', ['--uninstall']);
    assert.ok(fs.existsSync(userPkg), 'uninstall must not remove it either');
    assert.equal(sha256(fs.readFileSync(userPkg)), before);
  });

  test('kimi: the marker lives under hooks/, and the legacy root marker is retired', (t) => {
    const root = mkTmp('gsd-2544-kimi-');
    t.after(() => cleanup(root));

    // HOME is redirected to `root`, so kimi's native hook root
    // (resolveKimiHooksTomlDir → the `.kimi` dot-home) resolves inside the
    // temp tree. That root is OUTSIDE kimi's configDir, which is why migration
    // 007 cannot reach it and bin/install.js retires it directly.
    const kimiRoot = path.join(root, '.kimi');

    runInstall(root, 'kimi');
    assert.ok(
      fs.existsSync(path.join(kimiRoot, 'hooks', 'package.json')),
      'kimi marker must be staged inside .kimi/hooks/',
    );
    assert.ok(
      !fs.existsSync(path.join(kimiRoot, 'package.json')),
      'kimi must not carry a marker at its native hook root',
    );

    // Model a pre-#2544 install, which left the marker at the .kimi root, then
    // upgrade. The stale marker must be retired by the install itself.
    fs.writeFileSync(path.join(kimiRoot, 'package.json'), `${COMMONJS_MARKER}\n`);
    runInstall(root, 'kimi');
    assert.ok(
      !fs.existsSync(path.join(kimiRoot, 'package.json')),
      'upgrading must retire the pre-#2544 marker at kimi\'s root',
    );
  });

  test('kimi: a user-authored package.json at the .kimi root is never retired', (t) => {
    const root = mkTmp('gsd-2544-kimi-user-');
    t.after(() => cleanup(root));
    const kimiRoot = path.join(root, '.kimi');
    fs.mkdirSync(kimiRoot, { recursive: true });
    const userPkg = path.join(kimiRoot, 'package.json');
    fs.writeFileSync(userPkg, USER_PACKAGE_JSON);
    const before = sha256(fs.readFileSync(userPkg));

    runInstall(root, 'kimi');

    assert.ok(fs.existsSync(userPkg), 'a user file at the .kimi root must survive');
    assert.equal(sha256(fs.readFileSync(userPkg)), before);
  });

  test('kimi: uninstall reclaims the hooks/ marker', (t) => {
    const root = mkTmp('gsd-2544-kimi-uninstall-');
    t.after(() => cleanup(root));
    const kimiRoot = path.join(root, '.kimi');

    runInstall(root, 'kimi');
    assert.ok(fs.existsSync(path.join(kimiRoot, 'hooks', 'package.json')));

    runInstall(root, 'kimi', ['--uninstall']);
    assert.ok(
      !fs.existsSync(path.join(kimiRoot, 'hooks', 'package.json')),
      'uninstall must remove the kimi hooks/ marker it wrote',
    );
  });

  test('uninstall retires a pre-#2544 config-root marker', (t) => {
    const root = mkTmp('gsd-2544-legacy-');
    t.after(() => cleanup(root));

    runInstall(root, 'opencode');
    // Model an install made before the fix, which left the marker at the root.
    fs.writeFileSync(path.join(root, 'package.json'), `${COMMONJS_MARKER}\n`);

    runInstall(root, 'opencode', ['--uninstall']);
    assert.ok(
      !fs.existsSync(path.join(root, 'package.json')),
      'uninstall must still retire the legacy config-root marker',
    );
  });
});

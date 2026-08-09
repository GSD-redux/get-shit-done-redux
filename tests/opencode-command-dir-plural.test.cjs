'use strict';

/**
 * Regression coverage for #2329: OpenCode install target writes slash
 * commands to `command/` (singular); OpenCode discovers them from
 * `commands/` (plural), so none of the ~71 `/gsd-*` commands appear in the
 * OpenCode TUI.
 *
 * Per OpenCode's own docs (opencode.ai/docs/commands/), the documented
 * discovery directories are the plural `commands/` (global
 * `~/.config/opencode/commands/`, per-project `.opencode/commands/`).
 * OpenCode ALSO accepts singular names for backwards compatibility per its
 * config docs, but the reporter empirically confirmed on OpenCode 1.17.13
 * that `command/` (what GSD currently writes) is NOT discovered and that
 * `mv command commands` fixes it. These tests assert only what GSD
 * controls: where GSD writes its command files.
 *
 * Four sites must agree (Generative Fix Divergence guard, repo rule):
 *   - capabilities/opencode/capability.json:28  (global artifactLayout commands.destSubpath)
 *   - capabilities/opencode/capability.json:46  (local artifactLayout commands.destSubpath)
 *   - capabilities/opencode/capability.json:91  (hostBehaviors.flatCommandDir)
 *   - bin/install.js:9352                        (writeManifest's separate hardcoded
 *                                                  `manifest.files['command/' + file]` literal)
 *
 * See also tests/runtime-artifact-layout-descriptor-drive.test.cjs, whose
 * GOLDEN table was updated in lockstep with this file (opencode/global and
 * opencode/local destSubpath entries) — that is the canonical descriptor-
 * layer pin; this file covers the full install → manifest → migration
 * behavior end to end.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');

const {
  runMinimalInstall,
  installerEnv,
  INSTALL_SCRIPT,
} = require('./helpers/install-shared.cjs');
// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { cleanup } = require('./helpers.cjs');
const {
  resolveRuntimeArtifactLayout,
} = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

const CAPABILITY_PATH = path.join(__dirname, '..', 'capabilities', 'opencode', 'capability.json');
const EXPECTED_COMMAND_DIR = 'commands';

/** Re-run the installer against an EXISTING configDir/root to simulate an
 *  upgrade/reapply pass (the installer runs its migration planner on every
 *  invocation — see bin/install.js installAllRuntimes -> install() ->
 *  runInstallerMigrations, unconditional, not gated on first-install). */
function reinstallOpencode(root, scope = 'global') {
  const args = [INSTALL_SCRIPT, '--opencode'];
  let cwd = process.cwd();
  if (scope === 'global') {
    args.push('--global', '--config-dir', root);
  } else {
    args.push('--local');
    cwd = root;
  }
  const r = runNode(args, {
    cwd,
    env: installerEnv({ HOME: root, USERPROFILE: root }),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

function gsdMdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
}

/**
 * #2329: fabricate a pre-fix "legacy" OpenCode install fixture.
 *
 * Under the FIXED installer, a fresh install lands its command files
 * straight into commands/ (plural) and never creates command/ (singular) —
 * that is the fix working correctly. So the pre-fix "existing install with a
 * populated command/ dir" starting state a real upgrading user has can no
 * longer be reproduced by simply calling the installer once (as a prior
 * version of these tests assumed); it must be fabricated by hand-rewriting a
 * fresh install's output into the shape the OLD, buggy installer actually
 * left on disk.
 *
 * The migration under test (_migrateLegacyOpencodeCommandDir in
 * src/install-engine.cts) only deletes a command/<file> entry when
 * classifyArtifact() proves it GSD-managed via gsd-file-manifest.json (key
 * `command/<file>` present, hash matches or was locally modified — see
 * installerMigrations.classifyArtifact). A legacyDir populated with files but
 * no matching manifest entries would classify as 'unknown' and never be
 * touched, silently turning the migration tests into no-ops. So this helper
 * also rewrites the manifest's `commands/<file>` keys to `command/<file>`
 * (matching the OLD writeManifest's opencodeCommandDir-prefix behavior)
 * alongside physically moving the files, so the fabricated state is exactly
 * what a pre-fix install would have left: files AND a manifest that proves
 * GSD manages them at the legacy path.
 *
 * @param {string} configDir
 * @param {object} [opts]
 * @param {boolean} [opts.keepPluralDir=false] - when true, leaves the
 *   (now-empty) commands/ dir in place instead of removing it. Used by the
 *   both-dirs-exist scenario, which separately seeds commands/ with
 *   unrelated content after calling this helper.
 * @returns {{legacyDir:string, pluralDir:string, manifestPath:string, movedFiles:string[]}}
 */
function fabricateLegacyOpencodeCommandDir(configDir, opts = {}) {
  const { keepPluralDir = false } = opts;
  const legacyDir = path.join(configDir, 'command');
  const pluralDir = path.join(configDir, 'commands');
  const manifestPath = path.join(configDir, 'gsd-file-manifest.json');

  const movedFiles = gsdMdFiles(pluralDir);
  assert.ok(
    movedFiles.length >= 60,
    `fabricateLegacyOpencodeCommandDir: expected a fresh install to have ` +
    `populated >=60 gsd-*.md files under ${pluralDir} before fabrication, got ${movedFiles.length}`
  );

  fs.mkdirSync(legacyDir, { recursive: true });
  for (const file of movedFiles) {
    fs.renameSync(path.join(pluralDir, file), path.join(legacyDir, file));
  }
  if (!keepPluralDir && fs.existsSync(pluralDir) && fs.readdirSync(pluralDir).length === 0) {
    fs.rmdirSync(pluralDir);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const file of movedFiles) {
    const commandsKey = `commands/${file}`;
    const legacyKey = `command/${file}`;
    assert.ok(
      Object.prototype.hasOwnProperty.call(manifest.files, commandsKey),
      `fabricateLegacyOpencodeCommandDir: manifest is missing expected key ${commandsKey} — ` +
      'cannot fabricate a manifest-proven legacy fixture'
    );
    manifest.files[legacyKey] = manifest.files[commandsKey];
    delete manifest.files[commandsKey];
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return { legacyDir, pluralDir, manifestPath, movedFiles };
}

// ---------------------------------------------------------------------------
// 1 + 2. Command files land under commands/ (plural); command/ (singular)
//        is never created — both scopes.
// ---------------------------------------------------------------------------

describe('#2329: opencode install writes commands to commands/ (plural), not command/ (singular)', () => {
  for (const scope of ['global', 'local']) {
    test(`opencode --${scope}: command files land under commands/, and command/ does NOT exist`, (t) => {
      const { configDir, root } = runMinimalInstall({ runtime: 'opencode', scope });
      t.after(() => cleanup(root));

      const pluralDir = path.join(configDir, 'commands');
      const singularDir = path.join(configDir, 'command');

      const pluralFiles = gsdMdFiles(pluralDir);
      assert.ok(
        pluralFiles.length >= 60,
        `expected >=60 gsd-*.md command files under ${pluralDir}, got ${pluralFiles.length}. ` +
        `OpenCode discovers commands from commands/ (plural) per opencode.ai/docs/commands/.`
      );
      assert.ok(
        pluralFiles.includes('gsd-help.md'),
        `gsd-help.md must exist under ${pluralDir}`
      );

      assert.ok(
        !fs.existsSync(singularDir),
        `${singularDir} must NOT exist — OpenCode does not discover commands from the singular ` +
        'command/ dir (empirically confirmed on OpenCode 1.17.13, issue #2329)'
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Manifest records files under the commands/ prefix, not command/.
// ---------------------------------------------------------------------------

describe('#2329: opencode install manifest records the commands/ prefix', () => {
  test('manifest.files keys use "commands/" prefix; none use "command/"', (t) => {
    const { manifest, root } = runMinimalInstall({ runtime: 'opencode', scope: 'global' });
    t.after(() => cleanup(root));

    assert.ok(manifest && manifest.files, 'manifest.files must exist');
    const keys = Object.keys(manifest.files);

    const pluralKeys = keys.filter((k) => k.startsWith('commands/'));
    assert.ok(
      pluralKeys.length >= 60,
      `expected >=60 manifest keys under "commands/", got ${pluralKeys.length}. ` +
      `Sample keys: ${keys.slice(0, 5).join(', ')}`
    );

    const singularKeys = keys.filter((k) => k.startsWith('command/'));
    assert.deepStrictEqual(
      singularKeys, [],
      'no manifest key may use the old singular "command/" prefix — ' +
      'this is the bin/install.js:9352 writeManifest hardcode this issue must fix'
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Single source of truth: the two destSubpath declarations,
//    hostBehaviors.flatCommandDir, and the descriptor-driven layout resolver
//    all agree on "commands" — and the manifest prefix is DERIVED from the
//    descriptor, not a separate hardcoded literal (Generative Fix
//    Divergence guard).
// ---------------------------------------------------------------------------

describe('#2329: opencode command-dir declarations are a single source of truth', () => {
  test('capability.json global/local artifactLayout commands.destSubpath === "commands"', () => {
    const cap = JSON.parse(fs.readFileSync(CAPABILITY_PATH, 'utf8'));
    const globalCommands = cap.runtime.artifactLayout.global.find((k) => k.kind === 'commands');
    const localCommands = cap.runtime.artifactLayout.local.find((k) => k.kind === 'commands');

    assert.ok(globalCommands, 'capability.json global artifactLayout must have a commands kind');
    assert.ok(localCommands, 'capability.json local artifactLayout must have a commands kind');

    assert.strictEqual(
      globalCommands.destSubpath, EXPECTED_COMMAND_DIR,
      'capabilities/opencode/capability.json global commands.destSubpath must be "commands" (#2329)'
    );
    assert.strictEqual(
      localCommands.destSubpath, EXPECTED_COMMAND_DIR,
      'capabilities/opencode/capability.json local commands.destSubpath must be "commands" (#2329)'
    );
  });

  test('capability.json hostBehaviors.flatCommandDir === "commands"', () => {
    const cap = JSON.parse(fs.readFileSync(CAPABILITY_PATH, 'utf8'));
    assert.strictEqual(
      cap.runtime.hostBehaviors.flatCommandDir, EXPECTED_COMMAND_DIR,
      'capabilities/opencode/capability.json runtime.hostBehaviors.flatCommandDir must be "commands" (#2329)'
    );
  });

  test('resolveRuntimeArtifactLayout("opencode", ...) commands kind destSubpath === "commands" for both scopes', () => {
    for (const scope of ['global', 'local']) {
      const layout = resolveRuntimeArtifactLayout('opencode', '/tmp/fake-opencode-config-dir', scope);
      const commandsKind = layout.kinds.find((k) => k.kind === 'commands');
      assert.ok(commandsKind, `opencode/${scope} layout must have a commands kind`);
      assert.strictEqual(
        commandsKind.destSubpath, EXPECTED_COMMAND_DIR,
        `resolveRuntimeArtifactLayout('opencode', dir, '${scope}').kinds commands.destSubpath must be "commands" (#2329)`
      );
    }
  });

  test('installed manifest prefix is derived from the descriptor value, not a separate hardcoded literal (bin/install.js:9352 guard)', (t) => {
    const cap = JSON.parse(fs.readFileSync(CAPABILITY_PATH, 'utf8'));
    const globalCommands = cap.runtime.artifactLayout.global.find((k) => k.kind === 'commands');
    const descriptorPrefix = globalCommands.destSubpath;

    const { manifest, root } = runMinimalInstall({ runtime: 'opencode', scope: 'global' });
    t.after(() => cleanup(root));

    const keys = Object.keys(manifest.files);
    const descriptorPrefixKeys = keys.filter((k) => k.split('/')[0] === descriptorPrefix);
    assert.ok(
      descriptorPrefixKeys.length >= 60,
      `manifest must record command files under the descriptor's "${descriptorPrefix}/" prefix ` +
      `(read from capability.json), got ${descriptorPrefixKeys.length} matching keys. This proves ` +
      'bin/install.js:9352 derives its manifest prefix from the same descriptor value instead of a ' +
      'separately-hardcoded literal — a divergence would silently break the manifest even after the ' +
      'capability.json descriptor is fixed.'
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Migration: an existing install with a populated command/ dir is
//    migrated cleanly on upgrade/reapply — without destroying user content.
// ---------------------------------------------------------------------------

describe('#2329: upgrading an install with an orphaned command/ dir migrates it to commands/ safely', () => {
  test('reinstall relocates all gsd-owned files from command/ into commands/ and removes the now-empty orphan', (t) => {
    // Under the FIXED source, a first install writes straight into commands/
    // (plural) — that's the fix working. To exercise the upgrade/migration
    // path, fabricate the pre-fix "legacy" starting state a real upgrading
    // user has (populated command/ dir + a manifest that proves GSD manages
    // those files at the legacy path) by hand-rewriting a fresh install's
    // output — see fabricateLegacyOpencodeCommandDir's doc comment.
    const { configDir, root } = runMinimalInstall({ runtime: 'opencode', scope: 'global' });
    t.after(() => cleanup(root));

    const legacyDir = path.join(configDir, 'command');
    const pluralDir = path.join(configDir, 'commands');

    const { movedFiles } = fabricateLegacyOpencodeCommandDir(configDir);
    const filesBefore = new Set(movedFiles);
    assert.ok(filesBefore.size >= 60, `sanity: expected >=60 gsd command files from the first install, got ${filesBefore.size}`);
    // Sanity: the migration must genuinely FIRE against this fixture, not
    // no-op — confirm the legacy dir is populated and commands/ is gone
    // before the reinstall runs.
    assert.ok(gsdMdFiles(legacyDir).length >= 60, 'sanity: legacyDir must be populated before reinstall');
    assert.ok(!fs.existsSync(pluralDir), 'sanity: pluralDir must not exist before reinstall (fabricated pre-fix state)');

    const result = reinstallOpencode(root, 'global');
    assert.strictEqual(
      result.status, 0,
      `reinstall (upgrade) must exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );

    const filesAfter = new Set(gsdMdFiles(pluralDir));
    assert.deepStrictEqual(
      [...filesAfter].sort(), [...filesBefore].sort(),
      'after the upgrade reinstall, commands/ must contain the exact same gsd-* command file set ' +
      'that was previously under command/'
    );

    assert.ok(
      !fs.existsSync(legacyDir),
      'the orphaned command/ dir must be removed once fully migrated — it held only GSD-owned files ' +
      '(all present, unmodified, in the manifest), so removing it is safe and expected'
    );
  });

  test('an unrelated user file placed inside command/ survives the migration (not destroyed)', (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'opencode', scope: 'global' });
    t.after(() => cleanup(root));

    const legacyDir = path.join(configDir, 'command');
    const pluralDir = path.join(configDir, 'commands');

    fabricateLegacyOpencodeCommandDir(configDir);
    // Sanity: the migration must genuinely fire against this fixture.
    assert.ok(gsdMdFiles(legacyDir).length >= 60, 'sanity: legacyDir must be populated before reinstall');
    assert.ok(!fs.existsSync(pluralDir), 'sanity: pluralDir must not exist before reinstall (fabricated pre-fix state)');

    const userContent = 'precious user notes — not a GSD-managed file\n';
    const userFileLegacy = path.join(legacyDir, 'my-notes.md');
    fs.writeFileSync(userFileLegacy, userContent, 'utf8');

    const result = reinstallOpencode(root, 'global');
    assert.strictEqual(
      result.status, 0,
      `reinstall (upgrade) must exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );

    // The migration must actually have happened (commands/ now populated) —
    // otherwise "the user file is still where it was" would be a vacuous pass.
    assert.ok(
      gsdMdFiles(pluralDir).length >= 60,
      `commands/ must contain the migrated gsd-* command set after the upgrade, got ` +
      `${gsdMdFiles(pluralDir).length}`
    );

    // The unrelated file is not a GSD-managed artifact (no manifest entry —
    // it never matched the "gsd-*.md" filter GSD tracks), so it must never
    // be silently deleted. It may legitimately end up EITHER left in place
    // in the (now GSD-file-free) command/ dir, OR carried over into
    // commands/ alongside the migrated files — either is safe; deletion is
    // not.
    const userFilePlural = path.join(pluralDir, 'my-notes.md');
    const survivedInLegacy = fs.existsSync(userFileLegacy);
    const survivedInPlural = fs.existsSync(userFilePlural);
    assert.ok(
      survivedInLegacy || survivedInPlural,
      'unrelated user file my-notes.md must survive the migration (either in place under command/, ' +
      'or carried over to commands/) — it must NOT be deleted as collateral damage'
    );
    const survivingPath = survivedInLegacy ? userFileLegacy : userFilePlural;
    assert.strictEqual(
      fs.readFileSync(survivingPath, 'utf8'), userContent,
      'unrelated user file content must be byte-identical after the migration'
    );
  });

  test('both-dirs-exist case: pre-existing unrelated content already in commands/ is not clobbered while command/ is still relocated', (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'opencode', scope: 'global' });
    t.after(() => cleanup(root));

    const legacyDir = path.join(configDir, 'command');
    const pluralDir = path.join(configDir, 'commands');

    fabricateLegacyOpencodeCommandDir(configDir, { keepPluralDir: true });

    // Simulate a commands/ dir that already independently exists (e.g. the
    // user manually created it while working around #2329, or a partial
    // prior migration attempt left it behind) with content GSD does not own.
    fs.mkdirSync(pluralDir, { recursive: true });
    const preexistingPath = path.join(pluralDir, 'unrelated-project-doc.md');
    const preexistingContent = 'unrelated content that already lived in commands/\n';
    fs.writeFileSync(preexistingPath, preexistingContent, 'utf8');

    const filesBefore = new Set(gsdMdFiles(legacyDir));
    assert.ok(filesBefore.size >= 60, `sanity: expected >=60 gsd command files in command/, got ${filesBefore.size}`);
    // Sanity: the migration must genuinely fire against this fixture — the
    // manifest must actually prove ownership of the legacy files (not just
    // their physical presence), otherwise classifyArtifact would treat them
    // as 'unknown' and the migration would silently no-op.
    const manifestBefore = JSON.parse(fs.readFileSync(path.join(configDir, 'gsd-file-manifest.json'), 'utf8'));
    const legacyManifestKeys = Object.keys(manifestBefore.files).filter((k) => k.startsWith('command/'));
    assert.ok(
      legacyManifestKeys.length >= 60,
      `sanity: manifest must record >=60 "command/" keys before reinstall, got ${legacyManifestKeys.length}`
    );

    const result = reinstallOpencode(root, 'global');
    assert.strictEqual(
      result.status, 0,
      `reinstall (upgrade) must exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );

    // Pre-existing unrelated content in commands/ must survive untouched.
    assert.ok(
      fs.existsSync(preexistingPath),
      'pre-existing unrelated-project-doc.md in commands/ must not be deleted by the migration'
    );
    assert.strictEqual(
      fs.readFileSync(preexistingPath, 'utf8'), preexistingContent,
      'pre-existing unrelated file content in commands/ must be untouched'
    );

    // All gsd command files must now be present in commands/ too.
    const filesAfter = new Set(gsdMdFiles(pluralDir));
    for (const f of filesBefore) {
      assert.ok(filesAfter.has(f), `${f} must be present in commands/ after the upgrade (was in command/ before)`);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. No collateral: another flat-command-dir runtime (Kilo) is unaffected.
// ---------------------------------------------------------------------------
//
// NOTE: this test is expected to PASS both before and after the #2329 fix —
// it is a regression guard against the fix accidentally widening scope to
// Kilo (which also uses a flat, singular `command/` dir per its own
// capability.json and is NOT part of this issue), not a red-phase test for
// the bug itself.

describe('#2329: the fix must not affect other runtimes\' command output directories', () => {
  test('kilo global install still writes to command/ (singular) — unaffected by the opencode-only fix', (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'kilo', scope: 'global' });
    t.after(() => cleanup(root));

    const singularDir = path.join(configDir, 'command');
    const pluralDir = path.join(configDir, 'commands');

    assert.ok(
      gsdMdFiles(singularDir).length >= 60,
      `kilo must still write its command files to the singular command/ dir, got ` +
      `${gsdMdFiles(singularDir).length} files under ${singularDir}`
    );
    assert.ok(
      !fs.existsSync(pluralDir),
      `kilo must NOT gain a commands/ (plural) dir as collateral from the opencode-only #2329 fix`
    );
  });
});

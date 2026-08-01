'use strict';

// allow-test-rule: source-text-is-the-product — noSectionMarkerLeaksIntoEmittedArtifacts
// (#2930) asserts on the literal bytes of an EMITTED install artifact, which IS the
// deployed contract (a leaked `gsd:section` marker byte would ship to every user). This
// mirrors the test-matrix's own row-34/35 exemption from the "no source-grep" rule
// (50-test-matrix.md "No source-grep" note) — the ESLint rule itself only fires on
// readFileSync of a .cjs/.js/.ts SOURCE path, never on an installed .md artifact, so this
// annotation is documentation of intent, not a required suppression.

/**
 * workflow-fragments-emission.install.test.cjs — 50-test-matrix.md rows 32-36
 * (issue #2930, epic #1671 Phase 3).
 *
 * Real spawn-install coverage for `composeWorkflow`'s wiring into
 * `bin/install.js`'s `copyWithPathReplacement` (ADR-1671 "Architecture and
 * contracts": an engine-direct assertion is false-green for install
 * behavior — only a real spawned installer proves bytes actually reach
 * disk). The pure parser/composer itself is covered by
 * tests/workflow-fragments.test.cjs (unit, rows 1-29/37) and
 * tests/workflow-fragments.property.test.cjs (prop, rows 30-31).
 *
 * Each test builds and tears down its own tmp fixture(s) inline (no shared
 * `before()` install cache) — independence per matrix row 38.
 *
 * ── The overlay technique (rows 33/36) ───────────────────────────────────
 *
 * Rows 33 and 36 need a spawned `bin/install.js` that reads a DIFFERENT
 * `gsd-core/workflows/plan-phase.md` (malformed, row 36) or a different
 * `gsd-core/bin/lib/workflow-fragments.cjs` (stubbed to identity, row 33)
 * than this checkout's real files, without paying to copy the ~400 MB
 * repository (mostly node_modules) for every run. `buildOverlayRepo` mirrors
 * the repo tree with real directories (so `copyWithPathReplacement`'s own
 * `entry.isDirectory()` / `entry.isFile()` Dirent checks — which do NOT
 * follow symlinks — see the correct type) and HARD-LINKS every unmodified
 * leaf file (not symlinks: a symlinked leaf file also fails an `isFile()`
 * Dirent check elsewhere in the installer, verified empirically — "Failed
 * to install agents: directory is empty" against a symlink-leaf overlay).
 * Only `node_modules` and `.git` are symlinked at the top level (install.js
 * never walks into either), which is what keeps the overlay build fast.
 * Every overlay-spawned installer runs with `--preserve-symlinks
 * --preserve-symlinks-main` as a defensive belt: with an all-hardlink leaf
 * layout this checkout does not currently NEED symlink-preservation for
 * correctness, but the flag is free insurance against a future install.js
 * change that resolves a node_modules package by real path.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');
const { RUNTIME_META, runMinimalInstall, installerEnv } = require('./helpers/install-shared.cjs');
const { executionContextRefs } = require('../scripts/command-contract-helpers.cjs');
const { composeWorkflow } = require('../gsd-core/bin/lib/workflow-fragments.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const PILOT_REL = path.join('gsd-core', 'workflows', 'plan-phase.md');
const PILOT_PATH = path.join(REPO_ROOT, PILOT_REL);
const UNMARKED_REL = path.join('gsd-core', 'workflows', 'ship.md');

const RUNTIMES = Object.keys(RUNTIME_META);

// ─── Overlay-repo builder (rows 33/36) ─────────────────────────────────────

const OVERLAY_SKIP_TOP = new Set(['node_modules', '.git']);

/** Hard-link a file, falling back to a real copy only if the two paths sit on
 *  different filesystems/devices (EXDEV) or linking is denied (EPERM) — both
 *  cross-platform-legitimate, unlike a symlink's Dirent type-detection gap. */
function linkOrCopyFile(src, dest) {
  try {
    fs.linkSync(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV' || err.code === 'EPERM') {
      fs.copyFileSync(src, dest);
    } else {
      throw err;
    }
  }
}

/**
 * Build a throwaway mirror of REPO_ROOT with real directories throughout and
 * every unmodified leaf file hard-linked, except the paths named in
 * `fileOverrides` (POSIX-relative-path -> content string), which are written
 * as real files. Returns the mirror's absolute path; caller must
 * `fs.rmSync(..., {recursive:true, force:true})` it away.
 *
 * @param {{[relPath: string]: string}} fileOverrides
 */
function buildOverlayRepo(fileOverrides) {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2930-overlay-'));
  const entries = Object.entries(fileOverrides).map(([relPath, content]) => ({
    parts: relPath.split('/'),
    content,
  }));

  function place(srcDir, destDir, pending, isTop) {
    fs.mkdirSync(destDir, { recursive: true });
    const grouped = new Map();
    for (const e of pending) {
      const [head, ...rest] = e.parts;
      if (!grouped.has(head)) grouped.set(head, []);
      grouped.get(head).push({ parts: rest, content: e.content });
    }
    for (const de of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (isTop && OVERLAY_SKIP_TOP.has(de.name)) {
        fs.symlinkSync(path.join(srcDir, de.name), path.join(destDir, de.name));
        continue;
      }
      const srcPath = path.join(srcDir, de.name);
      const destPath = path.join(destDir, de.name);
      const overridden = grouped.get(de.name);
      const leaf = overridden && overridden.find((s) => s.parts.length === 0);
      if (leaf) {
        fs.writeFileSync(destPath, leaf.content);
        continue;
      }
      // fs.statSync follows symlinks (unlike Dirent.isDirectory()), so a
      // symlinked source directory is still recursed as a REAL directory in
      // the overlay — the property copyWithPathReplacement itself needs.
      if (fs.statSync(srcPath).isDirectory()) {
        place(srcPath, destPath, overridden || [], false);
      } else {
        linkOrCopyFile(srcPath, destPath);
      }
    }
  }

  place(REPO_ROOT, tmpRepo, entries, true);
  return tmpRepo;
}

/** Spawn a (possibly overlaid) installScript at global scope. Does NOT
 *  assert success — callers decide (row 36 expects failure). */
function spawnGlobalInstall(installScript, runtime, extraArgs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-2930-dest-${runtime}-`));
  const args = [
    '--preserve-symlinks',
    '--preserve-symlinks-main',
    installScript,
    `--${runtime}`,
    '--global',
    '--config-dir',
    root,
    ...extraArgs,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: installerEnv({ HOME: root, USERPROFILE: root }),
  });
  return { result, configDir: root, root };
}

// ─── Row 32: emitted plan-phase.md shrinks by exactly the marker bytes ────

test('emittedWorkflowShrinksByMarkerBytesForEveryRuntime', () => {
  const source = fs.readFileSync(PILOT_PATH, 'utf8');
  const composed = composeWorkflow(source, { sourcePath: PILOT_PATH });
  const expectedBytes = Buffer.byteLength(composed, 'utf8');
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  assert.ok(
    expectedBytes < sourceBytes,
    'sanity: the pilot workflow must actually carry gsd:section markers to strip',
  );

  for (const runtime of RUNTIMES) {
    const { configDir, root } = runMinimalInstall({ runtime, scope: 'global' });
    try {
      const emittedPath = path.join(configDir, PILOT_REL);
      assert.ok(fs.existsSync(emittedPath), `${runtime}: emitted plan-phase.md is missing`);
      const emittedBytes = fs.statSync(emittedPath).size;
      assert.equal(
        emittedBytes,
        expectedBytes,
        `${runtime}: emitted plan-phase.md size ${emittedBytes} !== source-minus-markers ${expectedBytes}`,
      );
    } finally {
      cleanup(root);
    }
  }
});

// ─── Row 33: an unmarked workflow emits byte-identical for every runtime ──
//
// "Byte-identical" here means identical to what the SAME runtime's install
// pipeline would emit WITHOUT the #2930 composeWorkflow wiring — not
// necessarily identical to the raw repo source, since path-prefix rewrites,
// attribution stamping, and per-runtime .md converters already ran before
// this change and still run today. Proven empirically per runtime by
// comparing two REAL installs of the SAME unmarked file: one through this
// checkout's real composeWorkflow, one through an overlay whose
// gsd-core/bin/lib/workflow-fragments.cjs is stubbed to plain identity — any
// difference is attributable ONLY to the compose wiring, never to an
// unrelated converter (which fires identically on both sides).

test('unmarkedWorkflowEmitsByteIdenticalForEveryRuntime', () => {
  const identityStubRepo = buildOverlayRepo({
    'gsd-core/bin/lib/workflow-fragments.cjs': 'module.exports = { composeWorkflow: (c) => c };\n',
  });
  try {
    for (const runtime of RUNTIMES) {
      const real = runMinimalInstall({ runtime, scope: 'global' });
      const stub = spawnGlobalInstall(path.join(identityStubRepo, 'bin', 'install.js'), runtime);
      try {
        assert.equal(
          stub.result.status,
          0,
          `${runtime}: identity-stub install must succeed\nstderr: ${stub.result.stderr}`,
        );
        const realPath = path.join(real.configDir, UNMARKED_REL);
        const stubPath = path.join(stub.configDir, UNMARKED_REL);
        assert.ok(fs.existsSync(realPath), `${runtime}: real install is missing ship.md`);
        assert.ok(fs.existsSync(stubPath), `${runtime}: stub install is missing ship.md`);

        // Normalize each side's own randomly-generated temp root out of the
        // content before hashing: some runtimes (opencode) embed the
        // install's own absolute configDir path in execution_context refs,
        // and the two installs necessarily used DIFFERENT temp roots — an
        // unnormalized compare would report a spurious mismatch driven by
        // temp-path length, not by anything composeWorkflow's wiring did.
        const realText = fs.readFileSync(realPath, 'utf8').split(real.root).join('<ROOT>');
        const stubText = fs.readFileSync(stubPath, 'utf8').split(stub.root).join('<ROOT>');
        assert.equal(
          Buffer.byteLength(realText, 'utf8'),
          Buffer.byteLength(stubText, 'utf8'),
          `${runtime}: ship.md byte size drifted between real compose and identity-stub compose`,
        );
        const realHash = crypto.createHash('sha256').update(realText).digest('hex');
        const stubHash = crypto.createHash('sha256').update(stubText).digest('hex');
        assert.equal(
          realHash,
          stubHash,
          `${runtime}: ship.md content drifted between real compose and identity-stub compose`,
        );
      } finally {
        cleanup(real.root);
        cleanup(stub.root);
      }
    }
  } finally {
    cleanup(identityStubRepo);
  }
});

// ─── Row 34: no gsd:section marker survives into any emitted artifact ─────

test('noSectionMarkerLeaksIntoEmittedArtifacts', () => {
  for (const runtime of RUNTIMES) {
    const { configDir, root } = runMinimalInstall({ runtime, scope: 'global' });
    try {
      const emittedPath = path.join(configDir, PILOT_REL);
      assert.ok(fs.existsSync(emittedPath), `${runtime}: emitted plan-phase.md is missing`);
      const emittedText = fs.readFileSync(emittedPath, 'utf8');
      assert.equal(
        emittedText.includes('gsd:section'),
        false,
        `${runtime}: emitted plan-phase.md still contains a gsd:section marker token`,
      );
    } finally {
      cleanup(root);
    }
  }
});

// ─── Row 35: ADR-0002 @-ref contract still resolves after composition ─────
//
// Two representative runtimes chosen to cover BOTH observed @-ref forms
// (empirically confirmed, #2930 dispatch): claude/cursor/codex rewrite to
// `@$HOME/...`, while opencode rewrites to a bare `@<absolute-path>/...`.
// Both installed SKILL.md files themselves pass through composeWorkflow too
// (as a no-op, being unmarked) — this proves that pass never corrupts or
// relocates the referenced workflow file.

function resolveExecutionContextRefTarget(token, root) {
  if (token.startsWith('@/')) return token.slice(1); // already absolute (opencode form)
  const stripped = token.replace(/^@(?:~|\$HOME)\//, '');
  return path.join(root, stripped);
}

test('atRefContractStillResolvesAfterComposition', () => {
  for (const runtime of ['claude', 'opencode']) {
    const { configDir, root } = runMinimalInstall({ runtime, scope: 'global' });
    try {
      const skillPath = path.join(configDir, 'skills', 'gsd-plan-phase', 'SKILL.md');
      assert.ok(fs.existsSync(skillPath), `${runtime}: installed gsd-plan-phase SKILL.md is missing`);
      const skillContent = fs.readFileSync(skillPath, 'utf8');
      const refs = executionContextRefs(skillContent);
      assert.ok(refs.length > 0, `${runtime}: SKILL.md has no execution_context @-refs to check`);
      for (const { token } of refs) {
        const target = resolveExecutionContextRefTarget(token, root);
        assert.ok(
          fs.existsSync(target),
          `${runtime}: execution_context @-ref "${token}" resolved to "${target}", which does not exist on disk`,
        );
      }
    } finally {
      cleanup(root);
    }
  }
});

// ─── Row 36: a malformed marker fails install loudly, with no partial emit ─

test('malformedMarkersFailInstallWithoutPartialEmit', () => {
  const malformed = '<!-- gsd:section id="broken" when="always" -->\nnever closed\n';
  const overlayRepo = buildOverlayRepo({ 'gsd-core/workflows/plan-phase.md': malformed });
  let dest;
  try {
    dest = spawnGlobalInstall(path.join(overlayRepo, 'bin', 'install.js'), 'claude');
    assert.notEqual(
      dest.result.status,
      0,
      `install must fail loudly on a malformed marker, got exit 0\nstdout: ${dest.result.stdout}`,
    );
    assert.match(
      dest.result.stderr,
      /workflow-fragments: unclosed gsd:section marker/,
      `stderr must name the parser failure: ${dest.result.stderr}`,
    );
    assert.match(
      dest.result.stderr,
      /plan-phase\.md:1\)/,
      `stderr must name the offending file and line: ${dest.result.stderr}`,
    );
    const emittedPath = path.join(dest.configDir, PILOT_REL);
    assert.equal(
      fs.existsSync(emittedPath),
      false,
      'a half-composed plan-phase.md must never be written when composition throws',
    );
  } finally {
    cleanup(overlayRepo);
    if (dest) cleanup(dest.root);
  }
});

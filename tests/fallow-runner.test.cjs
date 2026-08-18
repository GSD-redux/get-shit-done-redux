'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  resolveFallowBinary,
  requireFallowBinary,
} = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'fallow-runner.cjs'));
const {
  resolveExecutableBinary,
} = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));

const { createTempDir, cleanup } = require('./helpers.cjs');

// `resolveFallowBinary` resolves through the seam using the REAL process.platform —
// it has no platform injection. So the fixture, not the assertion, is what varies:
// on win32 the seam only accepts a PATHEXT-listed extension (never a bare name, by
// design — the #3275 npm sh-shim trap), so the staged file must carry one there.
// This keeps every row genuinely executing on all three CI lanes instead of
// silently no-opping on one.
//
// The extension's CASE must come from the same source the seam itself falls
// back to (fallow-runner.cjs passes `process.env.PATHEXT ?? ''`, and the seam
// falls back to its own DEFAULT_PATHEXT `.EXE;.CMD;.BAT;.COM` when that's
// empty) — resolveExecutableBinary returns `name + <PATHEXT entry AS-IS>`,
// never the on-disk file's own casing, so a hardcoded 'fallow.cmd' would
// silently mismatch a real Windows PATHEXT of '.CMD' with a strict
// assert.equal (case-insensitive filesystem, case-SENSITIVE string compare).
const WIN32_CMD_EXT = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
  .split(';')
  .find((ext) => ext.toLowerCase() === '.cmd') ?? '.CMD';
const FALLOW_FIXTURE = process.platform === 'win32' ? `fallow${WIN32_CMD_EXT}` : 'fallow';

// ─── fallow-runner (#3618 Phase 2) ──────────────────────────────────────────
// Fold of the prior private resolver onto the seam's resolveExecutableBinary.
// See .gsd/phase/chore-3618-fallow-binary-resolution/50-test-matrix.md (F1-F15).
//
// Executability (X_OK) cannot be forced via chmod — root Docker bypasses mode
// bits, which would silently zero out coverage. Every case that needs a POSIX
// "is executable" or "is not executable" outcome monkeypatches fs.accessSync
// instead, restored in a finally.
//
// F7-F10 (the win32 rows) cannot inject a platform through
// resolveFallowBinary's public signature, so they are asserted directly
// against resolveExecutableBinary with platform:'win32' plus the same
// prependPaths/requireExecutable shape resolveFallowBinary passes — a
// projection of fallow's call, not fallow's own entry point (approach (a)
// from the phase brief).
function resolveFallowBinaryWin32({ cwd, envPath = '' }) {
  return resolveExecutableBinary('fallow', {
    platform: 'win32',
    prependPaths: [path.join(cwd, 'node_modules', '.bin')],
    env: { PATH: envPath, PATHEXT: process.env['PATHEXT'] ?? '' },
    requireExecutable: true,
  });
}

describe('resolveFallowBinary (#3618)', () => {
  test('F1: POSIX, executable fallow in <cwd>/node_modules/.bin only — the .bin path', () => {
    const cwd = createTempDir();
    const originalAccessSync = fs.accessSync;
    try {
      const binDir = path.join(cwd, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const fallowPath = path.join(binDir, FALLOW_FIXTURE);
      fs.writeFileSync(fallowPath, '');
      fs.accessSync = () => {};
      const resolved = resolveFallowBinary({ cwd, envPath: '' });
      assert.equal(resolved, fallowPath);
    } finally {
      fs.accessSync = originalAccessSync;
      cleanup(cwd);
    }
  });

  test('F2: POSIX, fallow on envPath only — the PATH copy', () => {
    const cwd = createTempDir();
    const pathDir = createTempDir();
    const originalAccessSync = fs.accessSync;
    try {
      const fallowPath = path.join(pathDir, FALLOW_FIXTURE);
      fs.writeFileSync(fallowPath, '');
      fs.accessSync = () => {};
      const resolved = resolveFallowBinary({ cwd, envPath: pathDir });
      assert.equal(resolved, fallowPath);
    } finally {
      fs.accessSync = originalAccessSync;
      cleanup(cwd);
      cleanup(pathDir);
    }
  });

  test('F3: POSIX, executable fallow in BOTH .bin and PATH — .bin wins (documented-backwards precedence)', () => {
    const cwd = createTempDir();
    const pathDir = createTempDir();
    const originalAccessSync = fs.accessSync;
    try {
      const binDir = path.join(cwd, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const binFallow = path.join(binDir, FALLOW_FIXTURE);
      const pathFallow = path.join(pathDir, FALLOW_FIXTURE);
      fs.writeFileSync(binFallow, '');
      fs.writeFileSync(pathFallow, '');
      fs.accessSync = () => {};
      const resolved = resolveFallowBinary({ cwd, envPath: pathDir });
      assert.equal(resolved, binFallow);
      assert.notEqual(resolved, pathFallow);
    } finally {
      fs.accessSync = originalAccessSync;
      cleanup(cwd);
      cleanup(pathDir);
    }
  });

  test('F4: POSIX, file present but accessSync throws — null (pins the X_OK check)', () => {
    const cwd = createTempDir();
    const originalAccessSync = fs.accessSync;
    try {
      const binDir = path.join(cwd, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, FALLOW_FIXTURE), '');
      fs.accessSync = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
      const resolved = resolveFallowBinary({ cwd, envPath: '' });
      assert.equal(resolved, null);
    } finally {
      fs.accessSync = originalAccessSync;
      cleanup(cwd);
    }
  });

  test('F5: absent everywhere — null', () => {
    const cwd = createTempDir();
    try {
      const resolved = resolveFallowBinary({ cwd, envPath: '' });
      assert.equal(resolved, null);
    } finally {
      cleanup(cwd);
    }
  });

  test('F6: envPath omitted (default from process.env.PATH), binary in .bin — resolves from .bin', () => {
    const cwd = createTempDir();
    const originalAccessSync = fs.accessSync;
    const originalPath = process.env.PATH;
    try {
      const binDir = path.join(cwd, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const fallowPath = path.join(binDir, FALLOW_FIXTURE);
      fs.writeFileSync(fallowPath, '');
      fs.accessSync = () => {};
      process.env.PATH = '';
      // Call shape production uses (structural-pre-pass.md): no envPath.
      const resolved = resolveFallowBinary({ cwd });
      assert.equal(resolved, fallowPath);
    } finally {
      fs.accessSync = originalAccessSync;
      process.env.PATH = originalPath;
      cleanup(cwd);
    }
  });

  test('F7: win32, fallow.CMD in .bin — resolves .bin/fallow.CMD', () => {
    const cwd = createTempDir();
    try {
      const binDir = path.join(cwd, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const fallowCmd = path.join(binDir, 'fallow.CMD');
      fs.writeFileSync(fallowCmd, '');
      const resolved = resolveFallowBinaryWin32({ cwd, envPath: '' });
      assert.equal(resolved, fallowCmd);
    } finally {
      cleanup(cwd);
    }
  });

  test('F8: win32, fallow.EXE and fallow.CMD both on PATH — .EXE wins (PATHEXT default order)', () => {
    const cwd = createTempDir();
    const pathDir = createTempDir();
    try {
      const exePath = path.join(pathDir, 'fallow.EXE');
      const cmdPath = path.join(pathDir, 'fallow.CMD');
      fs.writeFileSync(exePath, '');
      fs.writeFileSync(cmdPath, '');
      const resolved = resolveFallowBinaryWin32({ cwd, envPath: pathDir });
      assert.equal(resolved, exePath);
      assert.notEqual(resolved, cmdPath);
    } finally {
      cleanup(cwd);
      cleanup(pathDir);
    }
  });

  test('F9: win32, extensionless fallow beside fallow.CMD — resolves fallow.CMD, never the shim (#3275 trap)', () => {
    const cwd = createTempDir();
    const pathDir = createTempDir();
    try {
      const bareFallow = path.join(pathDir, 'fallow');
      const cmdFallow = path.join(pathDir, 'fallow.CMD');
      fs.writeFileSync(bareFallow, '');
      fs.writeFileSync(cmdFallow, '');
      const resolved = resolveFallowBinaryWin32({ cwd, envPath: pathDir });
      assert.equal(resolved, cmdFallow);
      assert.notEqual(resolved, bareFallow);
    } finally {
      cleanup(cwd);
      cleanup(pathDir);
    }
  });

  test('F10: win32, only an extensionless fallow — null (intentional change)', () => {
    const cwd = createTempDir();
    const pathDir = createTempDir();
    try {
      fs.writeFileSync(path.join(pathDir, 'fallow'), '');
      const resolved = resolveFallowBinaryWin32({ cwd, envPath: pathDir });
      assert.equal(resolved, null);
    } finally {
      cleanup(cwd);
      cleanup(pathDir);
    }
  });

  test('F11: requireFallowBinary with a binary present — returns the path, does not throw', () => {
    const cwd = createTempDir();
    const originalAccessSync = fs.accessSync;
    try {
      const binDir = path.join(cwd, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const fallowPath = path.join(binDir, FALLOW_FIXTURE);
      fs.writeFileSync(fallowPath, '');
      fs.accessSync = () => {};
      const resolved = requireFallowBinary({ cwd, envPath: '' });
      assert.equal(resolved, fallowPath);
    } finally {
      fs.accessSync = originalAccessSync;
      cleanup(cwd);
    }
  });

  test('F12: requireFallowBinary with nothing found — throws the byte-identical install-instructions message', () => {
    const cwd = createTempDir();
    try {
      let caught = null;
      try {
        requireFallowBinary({ cwd, envPath: '' });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof Error, 'requireFallowBinary must throw when nothing is found');
      assert.equal(
        caught.message,
        'Fallow is enabled but no binary was found. Please install fallow via `npm install -D fallow` or `cargo install fallow`.',
      );
    } finally {
      cleanup(cwd);
    }
  });

  test('F13: <cwd> has no node_modules at all — no throw; falls through to PATH', () => {
    const cwd = createTempDir();
    const pathDir = createTempDir();
    const originalAccessSync = fs.accessSync;
    const originalPath = process.env.PATH;
    try {
      const fallowPath = path.join(pathDir, FALLOW_FIXTURE);
      fs.writeFileSync(fallowPath, '');
      fs.accessSync = () => {};
      process.env.PATH = pathDir;
      // Call shape production uses (structural-pre-pass.md): no envPath.
      assert.doesNotThrow(() => {
        const resolved = resolveFallowBinary({ cwd });
        assert.equal(resolved, fallowPath);
      });
    } finally {
      fs.accessSync = originalAccessSync;
      process.env.PATH = originalPath;
      cleanup(cwd);
      cleanup(pathDir);
    }
  });

  test('F14: <cwd>/node_modules/.bin exists but is a file, not a directory — no throw; falls through', () => {
    const cwd = createTempDir();
    const pathDir = createTempDir();
    const originalAccessSync = fs.accessSync;
    try {
      const nodeModulesDir = path.join(cwd, 'node_modules');
      fs.mkdirSync(nodeModulesDir, { recursive: true });
      fs.writeFileSync(path.join(nodeModulesDir, '.bin'), ''); // .bin is a FILE, not a dir
      const fallowPath = path.join(pathDir, FALLOW_FIXTURE);
      fs.writeFileSync(fallowPath, '');
      fs.accessSync = () => {};
      assert.doesNotThrow(() => {
        const resolved = resolveFallowBinary({ cwd, envPath: pathDir });
        assert.equal(resolved, fallowPath);
      });
    } finally {
      fs.accessSync = originalAccessSync;
      cleanup(cwd);
      cleanup(pathDir);
    }
  });

  test('F15: a directory named fallow in .bin — not resolved (isFile() is the predicate)', () => {
    const cwd = createTempDir();
    const originalAccessSync = fs.accessSync;
    try {
      const binDir = path.join(cwd, 'node_modules', '.bin');
      fs.mkdirSync(path.join(binDir, FALLOW_FIXTURE), { recursive: true }); // fallow is a DIRECTORY
      fs.accessSync = () => {};
      const resolved = resolveFallowBinary({ cwd, envPath: '' });
      assert.equal(resolved, null);
    } finally {
      fs.accessSync = originalAccessSync;
      cleanup(cwd);
    }
  });
});

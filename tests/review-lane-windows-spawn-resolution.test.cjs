'use strict';

/**
 * Regression test for #3275 — reviewer lanes fail with spawn ENOENT on Windows.
 *
 * Root cause: `routeReviewLane`'s `deps.spawn` (gsd-core/bin/gsd-tools.cjs) mediate
 * Windows `.cmd`/`.bat` shims through cmd.exe only when the binary name ALREADY
 * carries the extension, but lane descriptors declare BARE names ('codex', 'kimi',
 * 'agy') and nothing resolved them to the on-disk extensioned form — while
 * `deps.hasBinary` scanned PATH WITH PATHEXT, so probes reported the lane
 * available for a spawn that could never start.
 *
 * The fix gives both seams ONE shared resolver, `resolveSpawnBinary`, exported
 * from gsd-tools.cjs. This file exercises:
 *   - the resolver itself, portably, against staged fake-bin dirs (P1–P8);
 *   - the real CLI end-to-end on Windows: staged `codex.CMD` (primary invocation
 *     path, file-arg) and `kimi.CMD` (capability-probe path) invoked through
 *     `gsd-tools review-lane invoke` with the staged dir first on PATH (W1–W2).
 *
 * The E2E cases stage an extensionless POSIX sh shim NEXT to each `.CMD` on
 * purpose: an `['', ...PATHEXT]` resolver resolves to it and re-opens the exact
 * ENOENT (field-reported on Windows 11), so its presence pins the ordering.
 *
 * Matrix: .gsd/bug/fix-3275-reviewer-lanes-enoent-windows/50-test-matrix.md
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempDir, cleanup, TOOLS_PATH } = require('./helpers.cjs');
const { resolveSpawnBinary } = require('../gsd-core/bin/gsd-tools.cjs');

const WIN32 = { PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const POSIX = { PATH: '' };

/** Stage a fake bin dir: entries are written verbatim (name → content). */
function stageBin(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(entries)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

describe('resolveSpawnBinary (#3275)', () => {
  test('is exported as a function', () => {
    assert.equal(typeof resolveSpawnBinary, 'function');
  });

  test('P1: win32 resolves the .CMD shim, never the extensionless POSIX sh shim beside it', () => {
    const dir = createTempDir('gsd-3275-p1-');
    try {
      stageBin(dir, {
        codex: '#!/bin/sh\nexec node "$0".js "$@"\n',
        'codex.CMD': '@echo off\r\nexit /b 0\r\n',
      });
      const resolved = resolveSpawnBinary('codex', 'win32', { ...WIN32, PATH: dir });
      assert.equal(resolved, path.join(dir, 'codex.CMD'));
      // The resolution must carry the extension the cmd.exe mediation gate keys on.
      assert.match(path.basename(resolved || ''), /\.(cmd|bat)$/i);
    } finally {
      cleanup(dir);
    }
  });

  test('P2: win32 returns null when only the extensionless sh shim exists', () => {
    const dir = createTempDir('gsd-3275-p2-');
    try {
      stageBin(dir, { codex: '#!/bin/sh\nexit 0\n' });
      assert.equal(resolveSpawnBinary('codex', 'win32', { ...WIN32, PATH: dir }), null);
    } finally {
      cleanup(dir);
    }
  });

  test('P3: win32 honors PATHEXT ORDER, not just membership', () => {
    const dir = createTempDir('gsd-3275-p3-');
    try {
      stageBin(dir, { 'gemini.CMD': '@echo off\r\n', 'gemini.EXE': 'exe' });
      const resolved = resolveSpawnBinary('gemini', 'win32', { PATH: dir, PATHEXT: '.CMD;.EXE' });
      assert.equal(resolved, path.join(dir, 'gemini.CMD'));
      const flipped = resolveSpawnBinary('gemini', 'win32', { PATH: dir, PATHEXT: '.EXE;.CMD' });
      assert.equal(flipped, path.join(dir, 'gemini.EXE'));
    } finally {
      cleanup(dir);
    }
  });

  test('P4: win32 scans PATH dirs in order across multiple entries', () => {
    const early = createTempDir('gsd-3275-p4a-');
    const late = createTempDir('gsd-3275-p4b-');
    try {
      // Staged in PATHEXT casing: the resolver probes `name + ext` verbatim, and a
      // case-SENSITIVE CI filesystem (Linux ext4) must find it exactly as a
      // case-insensitive Windows one would.
      stageBin(late, { 'tool.EXE': 'exe' });
      const resolved = resolveSpawnBinary('tool', 'win32', {
        PATH: [early, late].join(path.delimiter),
        PATHEXT: '.EXE;.CMD',
      });
      assert.equal(resolved, path.join(late, 'tool.EXE'));
    } finally {
      cleanup(early);
      cleanup(late);
    }
  });

  test('P5: win32 returns null when the name exists nowhere on PATH', () => {
    const dir = createTempDir('gsd-3275-p5-');
    try {
      stageBin(dir, {});
      assert.equal(
        resolveSpawnBinary('definitely-not-installed-3275', 'win32', { ...WIN32, PATH: dir }),
        null,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('P6: a path-like name bypasses the PATH scan — existing file passes through, missing is null', () => {
    const dir = createTempDir('gsd-3275-p6-');
    try {
      const file = path.join(dir, 'tool.CMD');
      fs.writeFileSync(file, '@echo off\r\n');
      assert.equal(resolveSpawnBinary(file, 'win32', WIN32), file);
      assert.equal(resolveSpawnBinary(path.join(dir, 'absent.CMD'), 'win32', WIN32), null);
    } finally {
      cleanup(dir);
    }
  });

  test('P7: POSIX existence semantics — bare name found in a PATH dir, null when absent', () => {
    const dir = createTempDir('gsd-3275-p7-');
    try {
      stageBin(dir, { codex: '#!/bin/sh\nexit 0\n' });
      assert.equal(resolveSpawnBinary('codex', 'darwin', { ...POSIX, PATH: dir }), path.join(dir, 'codex'));
      assert.equal(resolveSpawnBinary('codex', 'linux', POSIX), null);
    } finally {
      cleanup(dir);
    }
  });

  test('P8: an empty name resolves to null on every platform', () => {
    assert.equal(resolveSpawnBinary('', 'win32', WIN32), null);
    assert.equal(resolveSpawnBinary('', 'darwin', POSIX), null);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Windows-gated end-to-end: the REAL CLI seam (no injected deps), staged
// shims first on PATH, mirroring how `npm install -g` lays down CLIs.
// Pre-fix, W1 stubs with `[spawn error: ENOENT]` and W2 fails its
// capability probe — the two symptoms the issue reports.
// ────────────────────────────────────────────────────────────────────────
describe('review-lane invoke on Windows (#3275)', () => {
  const isWin = process.platform === 'win32';

  /** PATH env key as spelled on this process (Windows env keys are case-folded). */
  function withStagedPath(binDir) {
    const pathKey =
      Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    return {
      [pathKey]: [binDir, process.env[pathKey]].filter(Boolean).join(path.delimiter),
    };
  }

  /** Run the real `gsd-tools review-lane invoke` for one slug and parse its JSON result. */
  function invokeLane({ slug, binDir, runDir, repoRoot }) {
    const r = runGsdTools(
      [
        'review-lane', 'invoke',
        '--selected', slug,
        '--slug', slug,
        '--run-dir', runDir,
        '--repo-root', repoRoot,
        '--explicit',
      ],
      repoRoot,
      withStagedPath(binDir),
    );
    assert.equal(r.exitCode, 0, `invoke exited ${r.exitCode}: ${r.error}`);
    return { result: JSON.parse(r.output), stdout: r.output };
  }

  test('W1: codex lane runs to completion through a staged codex.CMD shim (primary invocation path)', { skip: !isWin }, () => {
    const binDir = createTempDir('gsd-3275-w1-bin-');
    const runDir = createTempDir('gsd-3275-w1-run-');
    const repoRoot = createTempDir('gsd-3275-w1-repo-');
    try {
      // The pitfall, live: the extensionless sh shim sits beside codex.CMD exactly
      // as npm lays it down. A bare-name-first resolver picks it and re-ENOENTs.
      stageBin(binDir, {
        codex: '#!/bin/sh\nexit 1\n',
        'codex.CMD': [
          '@echo off',
          'setlocal',
          'set "OUT="',
          ':parse',
          'if "%~1"=="" goto write',
          'if /I "%~1"=="-o" set "OUT=%~2"',
          'shift',
          'goto parse',
          ':write',
          '> "%OUT%" echo fake codex review from the #3275 Windows shim',
          'exit /b 0',
        ].join('\r\n'),
      });
      const { result } = invokeLane({ slug: 'codex', binDir, runDir, repoRoot });

      assert.equal(result.ok, true, `lane failed: ${result.reason} ${result.detail}`);
      assert.equal(result.stubbed, false, `review was stubbed: ${JSON.stringify(result)}`);

      const review = fs.readFileSync(path.join(runDir, 'gsd-review-codex.md'), 'utf8');
      assert.ok(
        review.includes('#3275 Windows shim'),
        `review file should carry the shim's output, got: ${review}`,
      );
      const errSide = fs.readFileSync(path.join(runDir, 'gsd-review-codex.err'), 'utf8');
      assert.ok(!errSide.includes('[spawn error: ENOENT]'), `sidecar carries ENOENT: ${errSide}`);
    } finally {
      cleanup(binDir);
      cleanup(runDir);
      cleanup(repoRoot);
    }
  });

  test('W2: kimi-code lane passes its capability probe and runs through a staged kimi.CMD shim', { skip: !isWin }, () => {
    const binDir = createTempDir('gsd-3275-w2-bin-');
    const runDir = createTempDir('gsd-3275-w2-run-');
    const repoRoot = createTempDir('gsd-3275-w2-repo-');
    try {
      stageBin(binDir, {
        kimi: '#!/bin/sh\nexit 1\n',
        'kimi.CMD': [
          '@echo off',
          'if /I "%~1"=="--help" (',
          '  echo Usage: kimi [-m MODEL] [-p PROMPT] --output-format FORMAT',
          '  exit /b 0',
          ')',
          'echo fake kimi-code review from the #3275 Windows shim',
          'exit /b 0',
        ].join('\r\n'),
      });
      const { result } = invokeLane({ slug: 'kimi-code', binDir, runDir, repoRoot });

      assert.equal(result.ok, true, `lane failed: ${result.reason} ${result.detail}`);
      assert.equal(result.stubbed, false, `review was stubbed: ${JSON.stringify(result)}`);

      const review = fs.readFileSync(path.join(runDir, 'gsd-review-kimi-code.md'), 'utf8');
      assert.ok(
        review.includes('#3275 Windows shim'),
        `review file should carry the shim's output, got: ${review}`,
      );
    } finally {
      cleanup(binDir);
      cleanup(runDir);
      cleanup(repoRoot);
    }
  });

  test('E2E wiring is aimed at the real CLI seam', () => {
    // Guards the test itself: if TOOLS_PATH or the review-lane verb ever moves,
    // W1/W2 would silently skip their assertions behind the win32 gate.
    assert.ok(fs.existsSync(TOOLS_PATH), `gsd-tools.cjs not found at ${TOOLS_PATH}`);
  });
});

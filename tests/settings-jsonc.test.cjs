/**
 * GSD Tools Tests - settings.json JSONC (JSON with comments) support
 *
 * Validates that the installer's readSettings() correctly handles
 * settings.json files containing comments (line and block) without
 * silently overwriting them with empty objects.
 *
 * Closes: #1461
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cleanup, mockPartialWriteThenThrow } = require('./helpers.cjs');

// ─── load real install.js exports once ───────────────────────────────────────
//
// install.js prints a banner at module-load time (outside its GSD_TEST_MODE
// guard) — silence stdout for the duration of the require() so test output
// stays clean.  The main-logic block IS gated on GSD_TEST_MODE, so no
// installer side-effects run.
//
// Guard line (bin/install.js:12287):
//   if (require.main === module && !process.env.GSD_TEST_MODE) {
//
let installExports;
{
  process.env.GSD_TEST_MODE = '1';
  const _origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true; // suppress banner
  try {
    installExports = require('../bin/install.js');
  } finally {
    process.stdout.write = _origWrite;
  }
}
const { readSettings, writeSettings, stripJsonComments } = installExports;

// ─── tests ───────────────────────────────────────────────────────────────────

describe('stripJsonComments (#1461)', () => {

  test('strips line comments', () => {
    const input = `{
  // This is a comment
  "key": "value"
}`;
    const result = JSON.parse(stripJsonComments(input));
    assert.deepStrictEqual(result, { key: 'value' });
  });

  test('strips block comments', () => {
    const input = `{
  /* Block comment */
  "key": "value"
}`;
    const result = JSON.parse(stripJsonComments(input));
    assert.deepStrictEqual(result, { key: 'value' });
  });

  test('strips multi-line block comments', () => {
    const input = `{
  /*
   * Multi-line
   * block comment
   */
  "key": "value"
}`;
    const result = JSON.parse(stripJsonComments(input));
    assert.deepStrictEqual(result, { key: 'value' });
  });

  test('preserves comments inside string values', () => {
    const input = `{
  "url": "https://example.com/path",
  "description": "Use // for line comments"
}`;
    const result = JSON.parse(stripJsonComments(input));
    assert.strictEqual(result.url, 'https://example.com/path');
    assert.strictEqual(result.description, 'Use // for line comments');
  });

  test('handles trailing commas', () => {
    const input = `{
  "a": 1,
  "b": 2,
}`;
    const result = JSON.parse(stripJsonComments(input));
    assert.deepStrictEqual(result, { a: 1, b: 2 });
  });

  test('handles inline comments after values', () => {
    const input = `{
  "timeout": 5000, // milliseconds
  "retries": 3 // max attempts
}`;
    const result = JSON.parse(stripJsonComments(input));
    assert.strictEqual(result.timeout, 5000);
    assert.strictEqual(result.retries, 3);
  });

  test('handles standard JSON (no comments) unchanged', () => {
    const input = '{"key": "value", "num": 42}';
    const result = JSON.parse(stripJsonComments(input));
    assert.deepStrictEqual(result, { key: 'value', num: 42 });
  });

  test('handles empty object', () => {
    const result = JSON.parse(stripJsonComments('{}'));
    assert.deepStrictEqual(result, {});
  });

  test('handles real-world settings.json with comments', () => {
    const input = `{
  // My configuration
  "hooks": {
    "SessionStart": [
      {
        "matcher": "", /* match all */
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/hooks/gsd-statusline.js"
          }
        ]
      }
    ]
  },
  "statusLine": {
    "command": "node ~/.claude/hooks/gsd-statusline.js",
    "refreshInterval": 10
  }
}`;
    const result = JSON.parse(stripJsonComments(input));
    assert.ok(result.hooks, 'should have hooks');
    assert.ok(result.statusLine, 'should have statusLine');
    assert.strictEqual(result.statusLine.refreshInterval, 10);
  });
});

describe('readSettings null return on malformed files (#1461)', () => {
  test('readSettings strips JSONC comments when reading a real file', (t) => {
    const tmpFile = path.join(os.tmpdir(), `gsd-settings-test-jsonc-${process.pid}.json`);
    fs.writeFileSync(tmpFile, `{\n  // a comment\n  "key": "value"\n}`);
    t.after(() => fs.unlinkSync(tmpFile));
    const result = readSettings(tmpFile);
    assert.deepStrictEqual(
      result,
      { key: 'value' },
      'readSettings should use stripJsonComments so a commented file parses, not warns-as-malformed'
    );
  });

  test('readSettings returns null on truly malformed files (not empty object)', (t) => {
    const tmpFile = path.join(os.tmpdir(), `gsd-settings-test-malformed-return-${process.pid}.json`);
    fs.writeFileSync(tmpFile, '{ this is not valid json');
    t.after(() => fs.unlinkSync(tmpFile));
    const result = readSettings(tmpFile);
    assert.strictEqual(result, null, 'readSettings should return null on parse failure, not empty object');
  });

  test('callers guard against null readSettings return', () => {
    const installPath = path.join(__dirname, '..', 'bin', 'install.js');
    // allow-test-rule: structural-implementation-guard (#1461) (#3545) — structural
    // assertion on internal wiring inside install()'s (~2500-line)
    // settings-configuration call sites — the
    // null-guard only manifests behaviorally deep inside a full install()
    // run, so the source-text check is the minimum-cost regression guard
    // that a caller was not added without also checking readSettings'
    // documented null return
    const content = fs.readFileSync(installPath, 'utf8');
    // Should have null guards at the settings configuration call sites
    assert.ok(
      content.includes('=== null') || content.includes('rawSettings === null'),
      'callers should check for null return from readSettings'
    );
  });
});

// ─── seam-4 (#1191): real readSettings via exported function ─────────────────
//
// These tests exercise the REAL readSettings from bin/install.js (not a
// replica), using real temp files.  The structural grep below is a secondary
// belt-and-suspenders anchoring the source text; the primary assertions are
// the behavioural ones beneath it.

describe('readSettings: JSON null coalesced to empty, malformed warns (#1191)', () => {
  test('valid JSON null coalesces to {} via the real function (early behavioral anchor)', (t) => {
    // Behavioral anchor: if someone removes the coalescing, this test catches
    // it before the more detailed behavioural test below even runs.
    const tmpFile = path.join(os.tmpdir(), `gsd-settings-test-null-anchor-${process.pid}.json`);
    fs.writeFileSync(tmpFile, 'null');
    t.after(() => fs.unlinkSync(tmpFile));
    const result = readSettings(tmpFile);
    assert.deepStrictEqual(
      result,
      {},
      'install.js readSettings must coalesce valid JSON null to {} (not malformed warning)'
    );
  });

  test('valid JSON null content returns empty object with no malformed warning (real function)', () => {
    // A settings file containing literally `null` is valid JSON.
    // readSettings must treat it as empty settings ({}) — no warning emitted.
    const tmpFile = path.join(os.tmpdir(), `gsd-settings-test-null-${process.pid}.json`);
    fs.writeFileSync(tmpFile, 'null');
    const warnCalls = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnCalls.push(args.join(' '));
    let result;
    try {
      result = readSettings(tmpFile);
    } finally {
      console.warn = origWarn;
      fs.unlinkSync(tmpFile);
    }
    assert.deepStrictEqual(result, {}, 'JSON null must coalesce to {}');
    const malformedWarns = warnCalls.filter(w => w.includes('malformed') || w.includes('Could not parse'));
    assert.strictEqual(malformedWarns.length, 0, 'no malformed warning expected for valid JSON null');
  });

  test('malformed content returns null and emits malformed warning (real function)', () => {
    // A file containing `{ broken` is not valid JSON (even after comment-stripping).
    // readSettings must emit a malformed warning and return null.
    const tmpFile = path.join(os.tmpdir(), `gsd-settings-test-broken-${process.pid}.json`);
    fs.writeFileSync(tmpFile, '{ broken');
    const warnCalls = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnCalls.push(args.join(' '));
    let result;
    try {
      result = readSettings(tmpFile);
    } finally {
      console.warn = origWarn;
      fs.unlinkSync(tmpFile);
    }
    assert.strictEqual(result, null, 'malformed JSON must return null');
    const malformedWarns = warnCalls.filter(w => w.includes('malformed') || w.includes('Could not parse'));
    assert.strictEqual(malformedWarns.length, 1, 'exactly one malformed warning expected');
  });

  test('valid object content returns parsed object with no warning (real function)', () => {
    const tmpFile = path.join(os.tmpdir(), `gsd-settings-test-valid-${process.pid}.json`);
    fs.writeFileSync(tmpFile, '{"hooks":{}}');
    const warnCalls = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnCalls.push(args.join(' '));
    let result;
    try {
      result = readSettings(tmpFile);
    } finally {
      console.warn = origWarn;
      fs.unlinkSync(tmpFile);
    }
    assert.deepStrictEqual(result, { hooks: {} }, 'valid object must be returned as-is');
    const malformedWarns = warnCalls.filter(w => w.includes('malformed') || w.includes('Could not parse'));
    assert.strictEqual(malformedWarns.length, 0, 'no warning expected for valid JSON object');
  });

  test('absent file returns empty object with no warning (real function)', () => {
    const tmpFile = path.join(os.tmpdir(), `gsd-settings-test-absent-${process.pid}.json`);
    // ensure file does NOT exist
    try { fs.unlinkSync(tmpFile); } catch { /* already absent */ }
    const warnCalls = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnCalls.push(args.join(' '));
    let result;
    try {
      result = readSettings(tmpFile);
    } finally {
      console.warn = origWarn;
    }
    assert.deepStrictEqual(result, {}, 'absent file must return {}');
    assert.strictEqual(warnCalls.length, 0, 'no warning expected for absent file');
  });
});

// ─── writeSettings durability (#1874 F5) ─────────────────────────────────────
//
// Claude Code discards the ENTIRE settings file on any parse failure, so a
// truncated write costs the user every hook, permission, and statusline they
// have — not just GSD's entries. writeSettings is the sole writer of this
// surface for six runtimes, so it must never leave a partial file behind.

describe('writeSettings durability (#1874 F5)', () => {

  // The user's existing settings: entries GSD does not own and must not lose.
  const PRIOR = JSON.stringify({
    permissions: { allow: ['Bash(npm test)'] },
    statusLine: { command: '/usr/local/bin/my-statusline' },
    env: { MY_TOKEN: 'keep-me' },
  }, null, 2) + '\n';

  function withTmpDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-write-settings-'));
    try { return fn(dir); } finally { cleanup(dir); }
  }

  test('a failure mid-write leaves the previous settings file intact', (t) => {
    withTmpDir((dir) => {
      const settingsPath = path.join(dir, 'settings.json');
      fs.writeFileSync(settingsPath, PRIOR);

      // Simulate the crash window faithfully: the bytes that were written
      // before the failure DO land on disk, then the call fails. A mock that
      // merely throws would pass against a non-atomic writer, proving nothing.
      t.after(mockPartialWriteThenThrow(fs, undefined, 12, {
        code: 'ENOSPC',
        message: 'ENOSPC: no space left on device',
      }));

      let threw = false;
      try {
        writeSettings(settingsPath, { hooks: { SessionStart: [] } });
      } catch {
        threw = true;
      }

      assert.ok(threw, 'the write failure must propagate, not be swallowed');
      assert.strictEqual(
        fs.readFileSync(settingsPath, 'utf8'),
        PRIOR,
        'settings.json must be byte-identical to its pre-write contents'
      );
      // The real cost of the bug: a truncated file is discarded wholesale by
      // the host, so assert the user's non-GSD entries actually survive.
      const recovered = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.deepStrictEqual(recovered.permissions.allow, ['Bash(npm test)']);
      assert.strictEqual(recovered.env.MY_TOKEN, 'keep-me');
    });
  });

  test('a failure mid-write leaves no temp file behind', (t) => {
    withTmpDir((dir) => {
      const settingsPath = path.join(dir, 'settings.json');
      fs.writeFileSync(settingsPath, PRIOR);

      t.after(mockPartialWriteThenThrow(fs, undefined, 12, {
        code: 'EIO',
        message: 'simulated mid-write failure',
      }));
      try {
        writeSettings(settingsPath, { hooks: {} });
      } catch { /* expected */ }

      assert.deepStrictEqual(
        fs.readdirSync(dir).sort(),
        ['settings.json'],
        'no .tmp-* residue may survive a failed write'
      );
    });
  });

  test('a successful write produces the same bytes as before (format contract)', () => {
    withTmpDir((dir) => {
      const settingsPath = path.join(dir, 'settings.json');
      const settings = { hooks: { SessionStart: [{ hooks: [{ command: 'x' }] }] }, env: { A: '1' } };

      writeSettings(settingsPath, settings);

      // Two-space indent + trailing newline is the on-disk contract other
      // tooling (and users' diffs) depend on; atomicity must not disturb it.
      assert.strictEqual(
        fs.readFileSync(settingsPath, 'utf8'),
        JSON.stringify(settings, null, 2) + '\n'
      );
      assert.deepStrictEqual(readSettings(settingsPath), settings, 'must round-trip through readSettings');
      assert.deepStrictEqual(fs.readdirSync(dir), ['settings.json'], 'no temp residue on success');
    });
  });

  test('hardened permissions survive the rewrite', () => {
    withTmpDir((dir) => {
      const settingsPath = path.join(dir, 'settings.json');
      fs.writeFileSync(settingsPath, PRIOR);
      // 0o600 is the hardened-secrets posture: settings.json can carry env
      // tokens, and rename() would otherwise swap in a umask-default inode.
      fs.chmodSync(settingsPath, 0o600);

      writeSettings(settingsPath, { hooks: {}, env: { MY_TOKEN: 'keep-me' } });

      assert.deepStrictEqual(
        readSettings(settingsPath),
        { hooks: {}, env: { MY_TOKEN: 'keep-me' } },
        'the write must land through a chmod-hardened target on every OS'
      );
      if (process.platform !== 'win32') {
        assert.strictEqual(
          fs.statSync(settingsPath).mode & 0o7777,
          0o600,
          'a pre-existing non-default mode must survive the temp+rename write'
        );
      }
    });
  });

  test('the temp file is created exclusively — a pre-planted symlink is not followed', { skip: process.platform === 'win32' }, (t) => {
    withTmpDir((dir) => {
      const settingsPath = path.join(dir, 'settings.json');
      fs.writeFileSync(settingsPath, PRIOR);
      const victimPath = path.join(dir, 'victim');
      fs.writeFileSync(victimPath, 'victim-bytes');

      // Squat every plausible near-future temp path with a symlink to the
      // victim; an O_EXCL writer must skip them all instead of writing
      // through one.
      const planted = [];
      const origWriteFileSync = fs.writeFileSync;
      fs.writeFileSync = (target, data, options) => {
        const resolved = String(target);
        if (/\.tmp-\d+-\d+$/.test(resolved) && !fs.existsSync(resolved)) {
          try {
            fs.symlinkSync(victimPath, resolved);
            planted.push(resolved);
          } catch { /* already there */ }
        }
        return origWriteFileSync(target, data, options);
      };
      t.after(() => { fs.writeFileSync = origWriteFileSync; });
      assert.throws(
        () => writeSettings(settingsPath, { hooks: {} }),
        (e) => e.code === 'EEXIST',
        'an exclusive create must refuse every squatted temp path'
      );

      assert.strictEqual(fs.readFileSync(victimPath, 'utf8'), 'victim-bytes',
        'the symlink target must never receive the settings payload');
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), PRIOR,
        'the settings file must be untouched when every temp path is squatted');
      for (const link of planted) fs.unlinkSync(link);
    });
  });
});

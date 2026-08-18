/**
 * Regression tests for bugs #2045 and #2046
 *
 * #2046 (macOS/Linux): The three .sh hooks (gsd-validate-commit.sh,
 * gsd-session-state.sh, gsd-phase-boundary.sh) were registered in
 * settings.json with RELATIVE paths (bash .claude/hooks/...) for local
 * installs, causing "No such file or directory" when Claude Code's cwd
 * is not the project root.
 *
 * #2045 (Windows): The same three .sh hooks were registered WITHOUT quotes
 * around the path, so usernames with spaces (e.g. C:/Users/First Last/)
 * break bash invocation with a syntax error.
 *
 * Root cause: buildHookCommand() only handled .js files. The .sh hooks were
 * built via manual string concatenation without quoting, and local installs
 * used localPrefix (.claude/...) instead of the $CLAUDE_PROJECT_DIR-anchored
 * form that .js local hooks use.
 *
 * Fix: extend buildHookCommand() to handle .sh files (uses 'bash' instead of
 * 'node') so that all paths go through the same quoted-path construction.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// buildHookCommand was extracted to gsd-core/bin/lib/runtime-hooks-surface.cjs
// (ADR-857 phase 5f-1). #2876 (epic #2866 Phase 7) retired install.js's
// pass-through re-export (zero production consumers) — import the module
// directly.
const { buildHookCommand } = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-hooks-surface.cjs'));

const SH_HOOKS = [
  { name: 'gsd-validate-commit.sh' },
  { name: 'gsd-session-state.sh' },
  { name: 'gsd-phase-boundary.sh' },
];

// Use a fixed configDir that is unambiguously absolute so the assertions below
// are not accidentally satisfied by a relative path in the output.
const TEST_CONFIG_DIR = '/test-home/.claude';
// Force a non-Windows platform so resolveBashRunner reliably returns 'bash'
// (Windows candidates need filesystem probing; platform:linux is hermetic).
const HOOK_OPTS = { platform: 'linux', runtime: 'claude' };

describe('bugs #2045 #2046: .sh hook paths must be absolute and quoted', () => {
  // ── Test 1: buildHookCommand supports .sh files (BEHAVIORAL) ─────────────
  describe('buildHookCommand', () => {
    test('returns a bash command for .sh hookName', () => {
      // Behavioral: call the exported function and assert on the returned string.
      // buildHookCommand was extracted to runtime-hooks-surface.cjs; source-grep
      // on install.js no longer works (the wrapper body just delegates).
      assert.equal(typeof buildHookCommand, 'function',
        'buildHookCommand must be exported from install.js');

      const cmd = buildHookCommand(TEST_CONFIG_DIR, 'gsd-validate-commit.sh', HOOK_OPTS);
      assert.ok(typeof cmd === 'string' && cmd.length > 0,
        'buildHookCommand must return a non-empty string for .sh hooks');

      assert.ok(
        cmd.includes('bash'),
        'buildHookCommand must use "bash" as the runner for .sh hooks. ' +
        `Got: ${cmd}`
      );
    });

    test('buildHookCommand produces bash runner for .sh and node runner for .js', () => {
      assert.equal(typeof buildHookCommand, 'function',
        'buildHookCommand must be exported from install.js');

      // .sh hook must contain "bash"
      const shCmd = buildHookCommand(TEST_CONFIG_DIR, 'gsd-validate-commit.sh', HOOK_OPTS);
      assert.ok(
        typeof shCmd === 'string' && shCmd.includes('bash'),
        'buildHookCommand must produce a "bash" command for .sh hooks. ' +
        `Got: ${shCmd}`
      );

      // .js hook must contain "node" (absolute path will include the word "node")
      const jsCmd = buildHookCommand(TEST_CONFIG_DIR, 'gsd-something.js', HOOK_OPTS);
      assert.ok(
        typeof jsCmd === 'string' && jsCmd.includes('node'),
        'buildHookCommand must produce a "node" command for .js hooks. ' +
        `Got: ${jsCmd}`
      );

      // Non-vacuousness guard: the two commands must be DIFFERENT so that if
      // buildHookCommand stops branching on .sh the test actually fails.
      assert.notEqual(
        shCmd.split('"')[0], // runner token before the first quoted path
        jsCmd.split('"')[0],
        'buildHookCommand must use different runners for .sh vs .js hooks'
      );
    });
  });

  // ── Tests 2-4: behavioral buildHookCommand checks for each .sh hook ────────
  // These replace the former source-grep variable-name scans.  We call
  // buildHookCommand directly for each .sh hook on both linux and win32 and
  // assert three properties that the bugs required:
  //   (a) the returned command is non-empty
  //   (b) a bash runner appears in the command (linux path; win32 uses the
  //       path directly as the invocation, so the check is conditioned on OS)
  //   (c) the configDir is embedded as an absolute, double-quoted prefix

  // Absolute configDir with a space in it exercises the #2045 quoting bug.
  const SPACED_CONFIG_DIR = '/home/first last/.claude';

  for (const { name } of SH_HOOKS) {
    describe(`${name} — buildHookCommand output`, () => {
      // ── Test 2: non-empty command on linux ─────────────────────────────────
      test(`linux: returns non-empty command (fixes #2046 relative-path crash)`, () => {
        const cmd = buildHookCommand(TEST_CONFIG_DIR, name, { platform: 'linux', runtime: 'claude' });
        assert.ok(
          typeof cmd === 'string' && cmd.length > 0,
          `buildHookCommand must return a non-empty string for ${name} on linux. Got: ${String(cmd)}`
        );
      });

      // ── Test 3: bash runner present on linux ───────────────────────────────
      test(`linux: command starts with bash runner (fixes #2046 sh dispatch)`, () => {
        const cmd = buildHookCommand(TEST_CONFIG_DIR, name, { platform: 'linux', runtime: 'claude' });
        // Acceptable forms: "bash <path>", "/usr/bin/bash <path>", etc.
        assert.ok(
          /\bbash\b/.test(cmd),
          `buildHookCommand must include "bash" runner for ${name} on linux. Got: ${cmd}`
        );
      });

      // ── Test 4: absolute, double-quoted configDir on both platforms ─────────
      // Uses a configDir containing a space to prove quoting is not incidental.
      for (const platform of ['linux', 'win32']) {
        test(`${platform}: configDir is absolute and double-quoted (fixes #2045 spaces)`, () => {
          const cmd = buildHookCommand(SPACED_CONFIG_DIR, name, { platform, runtime: 'claude' });
          // The configDir must appear verbatim inside double quotes in the command.
          // e.g. bash "/home/first last/.claude/hooks/gsd-validate-commit.sh"
          //       or  "/home/first last/.claude/hooks/gsd-validate-commit.sh"
          assert.ok(
            cmd.includes(`"${SPACED_CONFIG_DIR}`),
            `buildHookCommand must embed configDir inside double quotes for ${name} on ${platform}. ` +
            `Got: ${cmd}`
          );
          // Confirm the path is absolute (starts with / or drive letter) — not ".claude/..."
          const quotedPath = cmd.match(/"([^"]+)"/)?.[1] ?? '';
          assert.ok(
            path.isAbsolute(quotedPath),
            `The quoted path in buildHookCommand output must be absolute for ${name} on ${platform}. ` +
            `Got quoted segment: "${quotedPath}" in: ${cmd}`
          );
        });
      }
    });
  }

  // ── Tests 5-7: GLOBAL-install branch (isGlobal=true) for each .sh hook ─────
  // The #2045 path-with-spaces bug originally lived in the global-install branch
  // of hook registration.  These tests call buildHookCommand with isGlobal:true
  // for each .sh hook on both linux and win32 and assert:
  //   (a) the command is non-empty
  //   (b) bash is used as the runner on linux (not bare concatenation)
  //   (c) the configDir with spaces is wrapped in double quotes
  //   (d) the quoted path is absolute (not a relative ".claude/..." fragment)
  //
  // A regression that reintroduces bare string concatenation on the isGlobal
  // branch will produce e.g. `bash /home/first last/.claude/hooks/...` (no
  // quotes), which fails assertion (c) and makes these tests go RED.

  for (const { name } of SH_HOOKS) {
    describe(`${name} — buildHookCommand isGlobal=true`, () => {
      // ── Test 5: non-empty command on linux (global) ────────────────────────
      test(`linux isGlobal: returns non-empty command`, () => {
        const cmd = buildHookCommand(TEST_CONFIG_DIR, name, {
          platform: 'linux', runtime: 'claude', isGlobal: true,
        });
        assert.ok(
          typeof cmd === 'string' && cmd.length > 0,
          `buildHookCommand(isGlobal=true) must return a non-empty string for ${name} on linux. Got: ${String(cmd)}`
        );
      });

      // ── Test 6: bash runner present on linux (global) ─────────────────────
      test(`linux isGlobal: command delegates to bash runner (not bare concatenation)`, () => {
        const cmd = buildHookCommand(TEST_CONFIG_DIR, name, {
          platform: 'linux', runtime: 'claude', isGlobal: true,
        });
        // Must contain 'bash' — bare concatenation produces "bash /path with space/..."
        // which crashes the shell; the fix puts the path in quotes.
        assert.ok(
          /\bbash\b/.test(cmd),
          `buildHookCommand(isGlobal=true) must include "bash" runner for ${name} on linux. Got: ${cmd}`
        );
      });

      // ── Test 7: absolute, double-quoted configDir on both platforms (global) ─
      // Uses SPACED_CONFIG_DIR (contains a space) to ensure the test goes RED
      // when bare concatenation is reintroduced: `bash /home/first last/...`
      // fails the `cmd.includes('"' + SPACED_CONFIG_DIR)` check.
      for (const platform of ['linux', 'win32']) {
        test(`${platform} isGlobal: configDir is absolute and double-quoted (guards #2045 global path)`, () => {
          const cmd = buildHookCommand(SPACED_CONFIG_DIR, name, {
            platform, runtime: 'claude', isGlobal: true,
          });
          assert.ok(
            cmd.includes(`"${SPACED_CONFIG_DIR}`),
            `buildHookCommand(isGlobal=true) must embed configDir inside double quotes for ${name} on ${platform}. ` +
            `Got: ${cmd}`
          );
          const quotedPath = cmd.match(/"([^"]+)"/)?.[1] ?? '';
          assert.ok(
            path.isAbsolute(quotedPath),
            `The quoted path in buildHookCommand(isGlobal=true) output must be absolute for ${name} on ${platform}. ` +
            `Got quoted segment: "${quotedPath}" in: ${cmd}`
          );
        });
      }
    });
  }
});

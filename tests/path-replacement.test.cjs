// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * GSD Tests - path replacement in install.js
 *
 * Verifies that global installs produce $HOME/ paths in .md files,
 * so that shell commands expand correctly inside double quotes.
 * ~ does NOT expand inside double quotes in POSIX shells, causing
 * MODULE_NOT_FOUND errors (see #1284).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.join(__dirname, '..');

// Thin adapter over the REAL _computePathPrefix (ADR-1508 Phase 2: deleted hand-copy).
// Old signature: computePathPrefix(homedir, targetDir) assumed isGlobal=true, isOpencode=false.
// This adapter preserves that contract so existing call-sites stay unchanged.
process.env['GSD_TEST_MODE'] = '1';
const { _computePathPrefix } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
function computePathPrefix(homedir, targetDir) {
  return _computePathPrefix({
    isGlobal: true,
    isOpencode: false,
    isWindowsHost: process.platform === 'win32',
    resolvedTarget: path.resolve(targetDir).replace(/\\/g, '/'),
    homeDir: homedir.replace(/\\/g, '/'),
  });
}

// Detect whether `content` leaks a resolved absolute homedir path (e.g.
// /home/alice or /root). A bare substring match false-positives when homedir
// is short and happens to appear inside ordinary words or tags — for example
// `</root_cause_analysis>` when os.homedir() === '/root' (Docker). Real path
// leaks are followed by a path separator, so we require a trailing '/'.
// See #3503.
function containsResolvedHomedir(content, normalizedHomedir) {
  if (!normalizedHomedir || normalizedHomedir === '$HOME') return false;
  return content.includes(normalizedHomedir + '/');
}

describe('pathPrefix computation', () => {
  test('default Claude global install uses $HOME/', () => {
    const homedir = os.homedir();
    const targetDir = path.join(homedir, '.claude');
    const prefix = computePathPrefix(homedir, targetDir);
    assert.strictEqual(prefix, '$HOME/.claude/');
  });

  test('default Gemini global install uses $HOME/', () => {
    const homedir = os.homedir();
    const targetDir = path.join(homedir, '.gemini');
    const prefix = computePathPrefix(homedir, targetDir);
    assert.strictEqual(prefix, '$HOME/.gemini/');
  });

  test('custom config dir under home uses $HOME/', () => {
    const homedir = os.homedir();
    const targetDir = path.join(homedir, '.config', 'claude');
    const prefix = computePathPrefix(homedir, targetDir);
    assert.ok(prefix.startsWith('$HOME/'), `Expected $HOME/ prefix, got: ${prefix}`);
    assert.ok(!prefix.includes(homedir), `Should not contain homedir: ${homedir}`);
  });

  test('Windows-style paths produce $HOME/ not C:/', () => {
    // Call the REAL _computePathPrefix with Windows-style paths.
    // isWindowsHost=true is passed; today the function ignores it (no-op) and
    // the $HOME shorthand is determined by the startsWith(homeDir) check alone.
    const prefix = _computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: true,
      resolvedTarget: 'C:/Users/matte/.claude',
      homeDir: 'C:/Users/matte',
    });
    assert.strictEqual(prefix, '$HOME/.claude/');
    assert.ok(!prefix.includes('C:'), `Should not contain drive letter, got: ${prefix}`);
  });

  test('target outside home uses absolute path', () => {
    const prefix = _computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: '/opt/gsd/.claude',
      homeDir: '/home/user',
    });
    assert.strictEqual(prefix, '/opt/gsd/.claude/');
    assert.ok(!prefix.includes('$HOME'), `Should not contain $HOME for non-home paths`);
  });

  test('$HOME expands inside double-quoted shell commands', () => {
    // This is the core regression test for #1284:
    // ~ does NOT expand inside double quotes in POSIX shells,
    // but $HOME does expand inside double quotes.
    const homedir = os.homedir();
    const targetDir = path.join(homedir, '.claude');
    const prefix = computePathPrefix(homedir, targetDir);
    // Verify the prefix uses $HOME, not ~
    assert.ok(!prefix.startsWith('~/'), `pathPrefix must not use ~ (breaks in double-quoted shell commands), got: ${prefix}`);
    assert.ok(prefix.startsWith('$HOME/'), `pathPrefix must use $HOME for shell expansion, got: ${prefix}`);
  });
});

describe('source .md files have no quoted-tilde shell patterns', () => {
  function collectMdFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectMdFiles(fullPath));
      } else if (entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const dirsToCheck = ['commands', 'gsd-core', 'agents'].map(d => path.join(repoRoot, d));
  const mdFiles = dirsToCheck.flatMap(collectMdFiles);

  test('source .md files exist', () => {
    assert.ok(mdFiles.length > 0, `Expected .md files, found ${mdFiles.length}`);
  });

  test('no .md file contains node "~/ pattern (quoted tilde breaks shell expansion)', () => {
    const quotedTildePattern = /node\s+"~\//;
    const failures = [];
    for (const file of mdFiles) {
      const content = fs.readFileSync(file, 'utf8');
      if (quotedTildePattern.test(content)) {
        failures.push(path.relative(repoRoot, file));
      }
    }
    assert.deepStrictEqual(failures, [], `Files with quoted-tilde node paths: ${failures.join(', ')}`);
  });
});

describe('installed .md files contain no resolved absolute paths', () => {
  const homedir = os.homedir();
  const targetDir = path.join(homedir, '.claude');
  const pathPrefix = computePathPrefix(homedir, targetDir);
  const claudeDirRegex = /~\/\.claude\//g;
  const claudeHomeRegex = /\$HOME\/\.claude\//g;
  const normalizedHomedir = homedir.replace(/\\/g, '/');

  function collectMdFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectMdFiles(fullPath));
      } else if (entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const dirsToCheck = ['commands', 'gsd-core', 'agents'].map(d => path.join(repoRoot, d));
  const mdFiles = dirsToCheck.flatMap(collectMdFiles);

  test('after replacement, no .md file contains os.homedir()', () => {
    const failures = [];
    for (const file of mdFiles) {
      let content = fs.readFileSync(file, 'utf8');
      content = content.replace(claudeDirRegex, pathPrefix);
      content = content.replace(claudeHomeRegex, pathPrefix);
      if (containsResolvedHomedir(content, normalizedHomedir)) {
        failures.push(path.relative(repoRoot, file));
      }
    }
    assert.deepStrictEqual(failures, [], `Files with resolved absolute paths: ${failures.join(', ')}`);
  });
});

describe('containsResolvedHomedir predicate (#3503)', () => {
  test('flags a real homedir path leak with trailing slash', () => {
    const content = 'see /home/alice/.claude/config for details';
    assert.strictEqual(containsResolvedHomedir(content, '/home/alice'), true);
  });

  test('does NOT flag short homedir appearing as substring of an identifier (#3503)', () => {
    // Regression: in Docker, os.homedir() === '/root'. Agent markdown contains
    // `<root_cause_analysis>` / `</root_cause_analysis>` tags. The old naive
    // substring check false-fired on these. The trailing-slash rule fixes it.
    const content = '<root_cause_analysis>\nfoo\n</root_cause_analysis>';
    assert.strictEqual(containsResolvedHomedir(content, '/root'), false);
  });

  test('still flags /root when followed by a real path separator', () => {
    const content = 'cat /root/.claude/agents.md';
    assert.strictEqual(containsResolvedHomedir(content, '/root'), true);
  });

  test('returns false for $HOME placeholder', () => {
    assert.strictEqual(containsResolvedHomedir('$HOME/.claude/', '$HOME'), false);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2376-opencode-windows-home-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2376-opencode-windows-home-path (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for #2376: @$HOME not correctly mapped in OpenCode on Windows.
 *
 * On Windows, $HOME is not expanded by PowerShell/cmd.exe, so OpenCode cannot
 * resolve @$HOME/... file references in installed command files.
 *
 * Fix: install.js must use the absolute path (not $HOME-relative) when installing
 * for OpenCode. (Generalized to all platforms in #2831 — OpenCode `@file`
 * references are not shell-expanded on any platform.)
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let computePathPrefix;

before(() => {
  process.env.GSD_TEST_MODE = '1';
  // Re-require fresh in case other tests already loaded it.
  delete require.cache[require.resolve('../bin/install.js')];
  ({ computePathPrefix } = require('../bin/install.js'));
});

after(() => {
  delete process.env.GSD_TEST_MODE;
});

describe('bug-2376: OpenCode on Windows must use absolute path, not $HOME', () => {
  test('computePathPrefix is exported by install.js', () => {
    assert.equal(typeof computePathPrefix, 'function');
  });

  test('OpenCode on Windows: pathPrefix is absolute (no $HOME substitution)', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: true,
      isOpencode: true,
      isWindowsHost: true,
      resolvedTarget: 'C:/Users/user/.config/opencode',
      homeDir: 'C:/Users/user',
    });
    assert.strictEqual(pathPrefix, 'C:/Users/user/.config/opencode/');
    assert.ok(!pathPrefix.includes('$HOME'));
  });

  test('Claude Code on Windows: pathPrefix still uses $HOME (unaffected)', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: true,
      resolvedTarget: 'C:/Users/user/.claude',
      homeDir: 'C:/Users/user',
    });
    assert.strictEqual(pathPrefix, '$HOME/.claude/');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2831-opencode-home-path-prefix.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2831-opencode-home-path-prefix (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #2831)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression test for #2831: OpenCode @file references contain literal `$HOME`
 * which OpenCode does not expand — `@$HOME/.config/opencode/...` is resolved
 * as a path relative to the config command/ dir, producing
 * `command/$HOME/.config/opencode/...` (file not found).
 *
 * Root cause: install.js pathPrefix used `$HOME`-relative paths for OpenCode on
 * non-Windows hosts (only Windows was guarded by #2376). OpenCode's `@file`
 * include syntax does NOT shell-expand `$HOME` on any platform.
 *
 * Fix: pathPrefix must use the absolute path for OpenCode on all platforms.
 *
 * Tests exercise install.js's exported `computePathPrefix` directly (no source
 * grepping) and additionally simulate the `copyFlattenedCommands` substitution
 * pipeline on a temp tree to verify no `$HOME` literal leaks into emitted files.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanup } = require('./helpers.cjs');

let computePathPrefix;

before(() => {
  process.env.GSD_TEST_MODE = '1';
  delete require.cache[require.resolve('../bin/install.js')];
  ({ computePathPrefix } = require('../bin/install.js'));
});

after(() => {
  delete process.env.GSD_TEST_MODE;
});

describe('bug-2831: OpenCode pathPrefix uses absolute path on all platforms', () => {
  test('computePathPrefix is exported by install.js', () => {
    assert.equal(typeof computePathPrefix, 'function');
  });

  test('OpenCode on macOS: pathPrefix is absolute (no $HOME)', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: true,
      isOpencode: true,
      isWindowsHost: false,
      homeDir: '/Users/alice',
      resolvedTarget: '/Users/alice/.config/opencode',
    });
    assert.strictEqual(pathPrefix, '/Users/alice/.config/opencode/');
    assert.ok(!pathPrefix.includes('$HOME'));
  });

  test('OpenCode on Linux: pathPrefix is absolute (no $HOME)', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: true,
      isOpencode: true,
      isWindowsHost: false,
      homeDir: '/home/bob',
      resolvedTarget: '/home/bob/.config/opencode',
    });
    assert.strictEqual(pathPrefix, '/home/bob/.config/opencode/');
    assert.ok(!pathPrefix.includes('$HOME'));
  });

  test('OpenCode on Windows: pathPrefix is absolute (preserves #2376)', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: true,
      isOpencode: true,
      isWindowsHost: true,
      homeDir: 'C:/Users/carol',
      resolvedTarget: 'C:/Users/carol/.config/opencode',
    });
    assert.strictEqual(pathPrefix, 'C:/Users/carol/.config/opencode/');
  });

  test('Claude Code on macOS: pathPrefix still uses $HOME (unaffected)', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      homeDir: '/Users/alice',
      resolvedTarget: '/Users/alice/.claude',
    });
    assert.strictEqual(pathPrefix, '$HOME/.claude/');
  });

  test('Local install (non-global): pathPrefix uses absolute path regardless of runtime', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: false,
      isOpencode: false,
      isWindowsHost: false,
      homeDir: '/Users/alice',
      resolvedTarget: '/Users/alice/projects/foo/.claude',
    });
    assert.strictEqual(pathPrefix, '/Users/alice/projects/foo/.claude/');
  });

  test('Substitution pipeline simulation: OpenCode emits no @$HOME literal', () => {
    // This validates the same regex substitution pipeline used by
    // copyFlattenedCommands when writing OpenCode command files. We invoke the
    // real exported computePathPrefix; the regex passes mirror the install.js
    // call sites (globalClaudeRegex / globalClaudeHomeRegex).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2831-'));
    try {
      const srcRoot = path.join(tmp, 'src');
      const targetRoot = path.join(tmp, 'home', '.config', 'opencode');
      const srcCmdDir = path.join(srcRoot, 'commands', 'gsd');
      fs.mkdirSync(srcCmdDir, { recursive: true });
      fs.mkdirSync(targetRoot, { recursive: true });

      const srcFile = path.join(srcCmdDir, 'autonomous.md');
      fs.writeFileSync(
        srcFile,
        '---\nname: autonomous\n---\n<execution_context>\n@~/.claude/gsd-core/workflows/autonomous.md\n@$HOME/.claude/gsd-core/references/ui-brand.md\n</execution_context>\n'
      );

      const homeDir = path.join(tmp, 'home').replace(/\\/g, '/');
      const resolvedTarget = targetRoot.replace(/\\/g, '/');
      const pathPrefix = computePathPrefix({
        isGlobal: true,
        isOpencode: true,
        isWindowsHost: false,
        homeDir,
        resolvedTarget,
      });

      let content = fs.readFileSync(srcFile, 'utf8');
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);

      assert.ok(
        !/@\$HOME\b/.test(content),
        `output must not contain @$HOME literal; got:\n${content}`
      );
      assert.ok(
        !/\$HOME\b/.test(content),
        `output must not contain $HOME literal; got:\n${content}`
      );
      assert.ok(
        content.includes(`@${resolvedTarget}/`),
        `output should include absolute path with @ prefix; got:\n${content}`
      );
    } finally {
      cleanup(tmp);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// #3133: global Claude @-references must resolve (tilde), not $HOME.
//
// Claude Code expands `~` and absolute paths in @-file references but NOT
// `$HOME`. computePathPrefix returns `$HOME/.claude/` for global installs
// (correct for double-quoted shell commands — `~` does not expand inside
// double quotes, #1284), so context-blind substitution rewrote every
// `@~/.claude/…` include to `@$HOME/.claude/…`, which silently resolves to
// nothing — skills load with an empty <execution_context>. OpenCode already
// has an absolute-path carve-out for the identical limitation (#2376/#2831);
// Claude is not special. Fix: in the `claude` rewrite case, restore the
// tilde form for @-references when the prefix is the $HOME (global) form.
// ────────────────────────────────────────────────────────────────────────
describe('#3133: global Claude @-references resolve on tilde, not $HOME', () => {
  // Re-require to also pull _applyRuntimeRewrites (module is cached under GSD_TEST_MODE).
  const conv = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  const _computePathPrefix = conv._computePathPrefix;
  const _applyRuntimeRewrites = conv._applyRuntimeRewrites;

  const homeDir = os.homedir().replace(/\\/g, '/');
  const isWin = process.platform === 'win32';
  const globalClaudePrefix = _computePathPrefix({
    isGlobal: true, isOpencode: false, isWindowsHost: isWin,
    resolvedTarget: homeDir + '/.claude', homeDir,
  });
  // Sanity: the global claude prefix IS the $HOME form (the precondition for the bug).
  assert.ok(globalClaudePrefix.startsWith('$HOME/'), `expected $HOME prefix, got ${globalClaudePrefix}`);

  test('row 1 — global Claude @-reference stays on tilde (resolves), not $HOME', () => {
    const src = '---\nname: gsd-stats\n---\n<execution_context>\n@~/.claude/gsd-core/workflows/stats.md\n</execution_context>\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    assert.match(out, /@~\/\.claude\/gsd-core\/workflows\/stats\.md/, `@-ref must stay on tilde; got:\n${out}`);
    assert.doesNotMatch(out, /@\$HOME/, `must not emit @$HOME (Claude does not expand it); got:\n${out}`);
  });

  test('row 2 — global Claude normalizes an @$HOME source reference to @~', () => {
    // Source may already carry @$HOME (e.g. a prior bad render); it must end on @~.
    const src = '<execution_context>\n@$HOME/.claude/gsd-core/references/ui-brand.md\n</execution_context>\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    assert.match(out, /@~\/\.claude\/gsd-core\/references\/ui-brand\.md/, `@$HOME source must normalize to @~; got:\n${out}`);
    assert.doesNotMatch(out, /@\$HOME/, `no @$HOME may remain; got:\n${out}`);
  });

  test('row 3 — global Claude shell contexts keep $HOME (#1284 preserved)', () => {
    // `~` does NOT expand inside double quotes; $HOME does. Shell commands must stay $HOME.
    const src = 'Run: node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" query state\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    assert.match(out, /node "\$HOME\/\.claude\/gsd-core\/bin\/gsd-tools\.cjs"/, `shell $HOME must be preserved; got:\n${out}`);
    assert.doesNotMatch(out, /node "~\//, `must not introduce quoted-tilde (re-introduces #1284); got:\n${out}`);
  });

  test('row 4 — global Claude bare ~/ shell (unquoted) becomes $HOME', () => {
    const src = 'cat ~/.claude/gsd-core/VERSION\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    assert.match(out, /cat \$HOME\/\.claude\/gsd-core\/VERSION/, `unquoted ~/ shell must become $HOME; got:\n${out}`);
  });

  test('row 5 — local Claude @-reference rewrites to the absolute target', () => {
    // Local install is NOT under $HOME/.claude; @~/ would point at global home.
    // pathPrefix is absolute; @-refs must follow it (Claude resolves absolute).
    const localPrefix = _computePathPrefix({
      isGlobal: false, isOpencode: false, isWindowsHost: isWin,
      resolvedTarget: '/abs/projects/foo/.claude', homeDir,
    });
    assert.ok(!localPrefix.startsWith('$HOME'), `local prefix must be absolute, got ${localPrefix}`);
    const src = '<execution_context>\n@~/.claude/gsd-core/workflows/stats.md\n</execution_context>\n';
    const out = _applyRuntimeRewrites(src, 'claude', localPrefix, false, undefined);
    assert.match(out, /@\/abs\/projects\/foo\/\.claude\/gsd-core\/workflows\/stats\.md/, `local @-ref must rewrite to absolute target; got:\n${out}`);
    assert.doesNotMatch(out, /@~\/\.claude/, `local @-ref must not stay on global ~/; got:\n${out}`);
  });

  test('row 6 — global Claude @-ref normalization is idempotent (re-surface safe)', () => {
    const src = '<execution_context>\n@~/.claude/gsd-core/workflows/stats.md\n</execution_context>\n';
    const once = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    const twice = _applyRuntimeRewrites(once, 'claude', globalClaudePrefix, true, undefined);
    assert.equal(twice, once, `re-running the rewrite must be stable (idempotent)`);
    assert.doesNotMatch(twice, /@\$HOME/, `no @$HOME after 2nd pass; got:\n${twice}`);
  });

  test('row 7 — global Claude emits no resolved homedir literal (#3503 preserved)', () => {
    const src = '<execution_context>\n@~/.claude/gsd-core/workflows/stats.md\n</execution_context>\nnode "$HOME/.claude/gsd-core/bin/gsd-tools.cjs"\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    // A real homedir leak is followed by a path separator (#3503 trailing-slash rule).
    assert.ok(!out.includes(homeDir + '/'), `must not leak resolved homedir ${homeDir}/; got:\n${out}`);
  });

  test('row 8 — non-Claude runtime (codex) is unaffected by the claude @-ref fix', () => {
    // The claude normalization targets @$HOME/.claude/; codex rewrites to .codex/,
    // so its output must be byte-identical to pre-fix (no @~/.claude/ restoration).
    const codexPrefix = _computePathPrefix({
      isGlobal: true, isOpencode: false, isWindowsHost: isWin,
      resolvedTarget: homeDir + '/.codex', homeDir,
    });
    const src = '<execution_context>\n@~/.claude/gsd-core/workflows/stats.md\n</execution_context>\n';
    const out = _applyRuntimeRewrites(src, 'codex', codexPrefix, true, undefined);
    // Codex rewrites .claude -> .codex; the @-ref must NOT have been restored to @~/.claude/.
    assert.doesNotMatch(out, /@~\/\.claude\//, `codex must not get the claude @~/.claude restoration; got:\n${out}`);
    assert.match(out, /@\$HOME\/\.codex\/gsd-core\/workflows\/stats\.md/, `codex keeps its own rewrite; got:\n${out}`);
  });

  test('row 9 — global Claude @-ref preserves the full tail path', () => {
    const src = '@~/.claude/gsd-core/references/ui-brand.md\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    assert.match(out, /@~\/\.claude\/gsd-core\/references\/ui-brand\.md$/, `tail must be intact; got:\n${out}`);
  });
});

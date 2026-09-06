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
  delete require.cache[require.resolve('../gsd-core/bin/lib/runtime-artifact-conversion.cjs')];
  ({ _computePathPrefix: computePathPrefix } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs'));
});

after(() => {
  delete process.env.GSD_TEST_MODE;
});

describe('bug-2376: OpenCode on Windows must use absolute path, not $HOME', () => {
  test('computePathPrefix (_computePathPrefix) is exported by runtime-artifact-conversion.cjs', () => {
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
  delete require.cache[require.resolve('../gsd-core/bin/lib/runtime-artifact-conversion.cjs')];
  ({ _computePathPrefix: computePathPrefix } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs'));
});

after(() => {
  delete process.env.GSD_TEST_MODE;
});

describe('bug-2831: OpenCode pathPrefix uses absolute path on all platforms', () => {
  test('computePathPrefix (_computePathPrefix) is exported by runtime-artifact-conversion.cjs', () => {
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
    // Deeper subpath than row 1 — ensures the @-ref normalization does not
    // truncate the tail. (No `$` anchor: a realistic @-ref line ends with `\n`.)
    const src = '@~/.claude/gsd-core/references/ui-brand.md\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    assert.match(out, /@~\/\.claude\/gsd-core\/references\/ui-brand\.md/, `tail must be intact; got:\n${out}`);
    assert.doesNotMatch(out, /@\$HOME/, `no @$HOME; got:\n${out}`);
  });
});

// ────────────────────────────────────────────────────────────────────────
// #3544: `$HOME` does NOT expand in a Claude Code @-import (measured — see
// .gsd/bug/fix-3544-home-expansion-spec-tree/10-diagnosis.md's ADDENDUM).
// #3133 (above) already fixed this for the SKILL/command staging pipeline
// (_applyRuntimeRewrites's 'claude' case) by restoring @-anchored $HOME
// references to tilde AFTER the blanket $HOME substitution. #3544 found the
// identical defect in bin/install.js's copyWithPathReplacement — the
// gsd-core/ SPEC-TREE emit path — which never had that restore step: every
// `@~/.claude/gsd-core/…` include in a global install's workflows/references
// tree (e.g. gsd-core/workflows/plan-phase.md's own @-includes) silently
// resolved to nothing.
//
// The old test at the top of this file ('$HOME expands inside double-quoted
// shell commands') asserted only the raw computePathPrefix STRING, never
// that an @-reference actually resolves — which is exactly why the spec-tree
// defect survived undetected. That assertion is preserved above (unchanged:
// computePathPrefix's raw $HOME form is CORRECT and must stay — it is what
// keeps double-quoted shell commands working, #1284). What was missing is
// coverage of the @-anchored restore step. This section adds it, plus a
// real spawned-installer proof that the fix reaches the actual emit path
// (not just the pure function), plus negative-proof rows for OpenCode,
// local installs, and a second non-Claude global runtime (Cursor).
// ────────────────────────────────────────────────────────────────────────
describe('#3544: _restoreClaudeGlobalAtRefTilde (spec-tree @-ref restore, unit)', () => {
  const { _restoreClaudeGlobalAtRefTilde } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

  test('restores an @$HOME/.claude/ reference to @~/.claude/ when pathPrefix is the $HOME form', () => {
    const src = '@$HOME/.claude/gsd-core/references/ui-brand.md\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(out, '@~/.claude/gsd-core/references/ui-brand.md\n');
  });

  test('leaves a non-@-anchored $HOME/.claude/ shell reference untouched (#1284)', () => {
    const src = 'node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" query state\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(out, src, 'a double-quoted shell $HOME reference must never be rewritten to ~ (breaks #1284)');
  });

  test('is a no-op when pathPrefix is an absolute (local-install) path', () => {
    const src = '@$HOME/.claude/gsd-core/references/ui-brand.md\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '/abs/projects/foo/.claude/');
    assert.strictEqual(out, src);
  });

  test('handles multiple @-references and preserves an interleaved shell reference', () => {
    const src =
      '@$HOME/.claude/gsd-core/references/a.md\n' +
      'node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs"\n' +
      '@$HOME/.claude/gsd-core/references/b.md\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(
      out,
      '@~/.claude/gsd-core/references/a.md\n' +
      'node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs"\n' +
      '@~/.claude/gsd-core/references/b.md\n',
    );
  });

  // #3544 review (Finding 1): a custom --config-dir under $HOME produces a
  // pathPrefix like '$HOME/.claude-work/' — the directory name is NOT
  // '.claude'. The restore must derive the tilde form from pathPrefix itself
  // rather than a hardcoded '.claude' literal, or it silently no-ops for any
  // non-default config-dir name (reproducing the exact defect #3544 fixes).
  test('generalizes to a non-default config-dir name (not hardcoded to .claude)', () => {
    const src = '@$HOME/.claude-work/gsd-core/workflows/plan-phase.md\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude-work/');
    assert.strictEqual(out, '@~/.claude-work/gsd-core/workflows/plan-phase.md\n');
  });

  // #3544 review (Finding 2): quote-aware, not line-start-anchored. A
  // double-quoted or single-quoted `@$HOME/...` sequence must be left alone
  // (rewriting $HOME -> ~ inside a quoted shell string reintroduces #1284 —
  // ~ does not expand in double quotes). A bare line-start `@$HOME/...` and a
  // legitimate MID-LINE `@`-reference (Claude Code documents @-references as
  // valid "anywhere in your CLAUDE.md") must both still be rewritten.
  test('leaves a double-quoted @$HOME/.claude/ sequence untouched (quote-aware)', () => {
    const src = 'echo "@$HOME/.claude/x"\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(out, src, 'a double-quoted @$HOME sequence must not be rewritten');
  });

  test('leaves a single-quoted @$HOME/.claude/ sequence untouched (quote-aware)', () => {
    const src = "'@$HOME/.claude/x'\n";
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(out, src, 'a single-quoted @$HOME sequence must not be rewritten');
  });

  test('rewrites a bare line-start @$HOME/.claude/ reference', () => {
    const src = '@$HOME/.claude/x\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(out, '@~/.claude/x\n');
  });

  test('rewrites a legitimate mid-line @$HOME/.claude/ reference (not line-start-anchored)', () => {
    const src = 'See @$HOME/.claude/x for details\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(out, 'See @~/.claude/x for details\n');
  });
});

// ────────────────────────────────────────────────────────────────────────
// #3719 GAP 2: restoreClaudeGlobalAtRefTilde used to build the substitution
// with a STRING passed as the 2nd arg to .replace() — `content.replace(re,
// '@' + tildeEquivalent)`. When tildeEquivalent (derived from an
// operator-controlled --config-dir pathPrefix) contains the literal sequence
// `$&` or `` $` ``, the JS engine treats those as REPLACEMENT PATTERNS, not
// literal text: `$&` re-inserts the whole match (duplicating the matched
// `@$HOME/...` span back into the output) and `` $` `` inserts the substring
// before the match (which is empty at position 0, silently dropping the
// literal text that followed it). Measured pre-fix:
//   prefix "$HOME/.cl$&ude/"  -> "@~/.cl@$HOME/.cl$&ude/ude/x" (corrupted, duplicated)
//   prefix "$HOME/.cl$`ude/"  -> "@~/.clude/x"                 (corrupted, text dropped)
// Fixed by passing a FUNCTION as the 2nd arg (`() => '@' + tildeEquivalent`),
// which the engine never pattern-scans. These pathological prefixes are built
// via string concatenation / String.fromCharCode, not template literals, so an
// editor normalizing a literal backtick-dollar sequence can't silently defang
// the fixture.
// ────────────────────────────────────────────────────────────────────────
describe('#3719 GAP 2: _restoreClaudeGlobalAtRefTilde is immune to $&/$` in pathPrefix', () => {
  const { _restoreClaudeGlobalAtRefTilde } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

  test('a pathPrefix containing a literal "$&" round-trips to the plain tilde form (not duplicated)', () => {
    const dollarAmp = '$' + '&';
    const prefix = '$HOME/.cl' + dollarAmp + 'ude/';
    const src = '@' + prefix + 'x';
    const out = _restoreClaudeGlobalAtRefTilde(src, prefix);
    assert.strictEqual(out, '@~/.cl' + dollarAmp + 'ude/x',
      'a literal $& in pathPrefix must not re-insert the whole match into the output');
  });

  test('a pathPrefix containing a literal "$`" (backtick-dollar) round-trips to the plain tilde form (not dropped)', () => {
    const dollarBacktick = '$' + String.fromCharCode(96);
    const prefix = '$HOME/.cl' + dollarBacktick + 'ude/';
    const src = '@' + prefix + 'x';
    const out = _restoreClaudeGlobalAtRefTilde(src, prefix);
    assert.strictEqual(out, '@~/.cl' + dollarBacktick + 'ude/x',
      'a literal $` in pathPrefix must not be treated as a "text before match" replacement pattern');
  });

  test('an ordinary pathPrefix (no special replacement chars) is unaffected by the function-replacement fix', () => {
    const prefix = '$HOME/.claude/';
    const src = '@' + prefix + 'x';
    const out = _restoreClaudeGlobalAtRefTilde(src, prefix);
    assert.strictEqual(out, '@~/.claude/x');
  });
});

// Verification boundary (#3544): this suite proves the emitted @-line takes
// the `~` STRING form Claude Code documents as expanding. It cannot prove
// the host actually resolves it — no automated test can spawn a live Claude
// Code session and read `/context` in CI. Read a green run here as "the
// installer emits the documented form", not as "the include loads". See
// restoreClaudeGlobalAtRefTilde's doc comment (runtime-artifact-conversion.cts)
// for the controlled measurement that established the documented form is the
// one that actually resolves.
describe('#3544: spawned installer — gsd-core/ spec tree @-refs resolve on tilde', () => {
  const { before, after } = require('node:test');
  const { cleanup } = require('./helpers.cjs');
  const { runNode } = require('./helpers/process-seam.cjs');
  const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
  const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

  const sandboxes = [];
  function makeSandbox(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-3544-${prefix}-`));
    sandboxes.push(dir);
    return dir;
  }

  // No --config-dir: install.js must resolve the DEFAULT <HOME>/.claude (or
  // runtime equivalent) under the sandboxed HOME, so the emitted tree has the
  // real `~/.claude/gsd-core/…` shape the diagnosis measured — a --config-dir
  // run pins configDir to the sandbox root itself (target === home), which
  // never reproduces that layout.
  function spawnInstall(args, home) {
    return runNode([INSTALL_SCRIPT, ...args], {
      cwd: home,
      env: installerEnv({ HOME: home, USERPROFILE: home }),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
  }

  function collectAtLines(rootDir) {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(rootDir, full);
        const topLevel = rel.split(path.sep)[0];
        // The durable Runtime Surface corpus is intentionally raw canonical
        // input, not an emitted/runtime-rewritten spec tree. Its paths are
        // validated when staged, so exclude only these two known corpus roots
        // from this legacy emitted-content oracle.
        if (topLevel === 'commands' || topLevel === 'agents') continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md')) {
          const content = fs.readFileSync(full, 'utf8');
          for (const line of splitLines(content)) {
            if (line.startsWith('@')) out.push({ file: full, line });
          }
        }
      }
    };
    if (fs.existsSync(rootDir)) walk(rootDir);
    return out;
  }

  let claudeGlobalHome, claudeLocalHome, opencodeGlobalHome, cursorGlobalHome, claudeConfigDirHome, claudeConfigDirTarget;

  before(() => {
    claudeGlobalHome = makeSandbox('claude-global');
    const g = spawnInstall(['--claude', '--global'], claudeGlobalHome);
    assert.strictEqual(g.exitCode, 0, `claude --global install failed:\n${g.stdout}\n${g.stderr}`);

    claudeLocalHome = makeSandbox('claude-local');
    const l = spawnInstall(['--claude', '--local'], claudeLocalHome);
    assert.strictEqual(l.exitCode, 0, `claude --local install failed:\n${l.stdout}\n${l.stderr}`);

    opencodeGlobalHome = makeSandbox('opencode-global');
    const o = spawnInstall(['--opencode', '--global'], opencodeGlobalHome);
    assert.strictEqual(o.exitCode, 0, `opencode --global install failed:\n${o.stdout}\n${o.stderr}`);

    cursorGlobalHome = makeSandbox('cursor-global');
    const c = spawnInstall(['--cursor', '--global'], cursorGlobalHome);
    assert.strictEqual(c.exitCode, 0, `cursor --global install failed:\n${c.stdout}\n${c.stderr}`);

    // #3544 review (Finding 1): a custom --config-dir name under $HOME
    // (i.e. NOT the default .claude) — the target must be a subdirectory of
    // HOME (not HOME itself) so computePathPrefix takes the $HOME-shorthand
    // branch with a non-'.claude' suffix, the exact precondition the
    // hardcoded-'.claude' bug required.
    claudeConfigDirHome = makeSandbox('claude-config-dir-home');
    claudeConfigDirTarget = path.join(claudeConfigDirHome, '.claude-work');
    const cd = spawnInstall(['--claude', '--global', '--config-dir', claudeConfigDirTarget], claudeConfigDirHome);
    assert.strictEqual(cd.exitCode, 0, `claude --global --config-dir install failed:\n${cd.stdout}\n${cd.stderr}`);
  });

  after(() => {
    for (const dir of sandboxes) cleanup(dir);
  });

  test('claude --global: gsd-core/workflows/plan-phase.md @-lines use ~/, never @$HOME', () => {
    const planPhase = path.join(claudeGlobalHome, '.claude', 'gsd-core', 'workflows', 'plan-phase.md');
    assert.ok(fs.existsSync(planPhase), `expected ${planPhase} to exist`);
    const content = fs.readFileSync(planPhase, 'utf8');
    const atLines = splitLines(content).filter((l) => l.startsWith('@'));
    assert.ok(atLines.length > 0, 'expected plan-phase.md to carry at least one @-line');
    for (const line of atLines) {
      assert.ok(!/^@\$HOME/.test(line), `plan-phase.md @-line must not use @$HOME: ${line}`);
    }
    assert.ok(
      atLines.some((l) => l.startsWith('@~/')),
      `expected at least one @~/ line, got: ${JSON.stringify(atLines)}`,
    );
  });

  test('claude --global: zero ^@$HOME lines remain anywhere under the emitted gsd-core/ tree', () => {
    const gsdCoreDir = path.join(claudeGlobalHome, '.claude', 'gsd-core');
    const homeLines = collectAtLines(gsdCoreDir).filter(({ line }) => /^@\$HOME/.test(line));
    assert.deepStrictEqual(homeLines, [], `found @$HOME lines: ${JSON.stringify(homeLines)}`);
  });

  // #3544 review (Finding 1): a real install under a non-default --config-dir
  // name reproduces the exact defect #3544 fixes if the restore is hardcoded
  // to '.claude/'. This must FAIL against the pre-fix restoreClaudeGlobalAtRefTilde.
  test('claude --global --config-dir <custom>: zero @$HOME lines remain, and @~/<custom>/ appears', () => {
    const gsdCoreDir = path.join(claudeConfigDirTarget, 'gsd-core');
    assert.ok(fs.existsSync(gsdCoreDir), `expected ${gsdCoreDir} to exist`);
    const homeLines = collectAtLines(gsdCoreDir).filter(({ line }) => /^@\$HOME/.test(line));
    assert.deepStrictEqual(homeLines, [], `found @$HOME lines under a custom --config-dir: ${JSON.stringify(homeLines)}`);
    const tildeLines = collectAtLines(gsdCoreDir).filter(({ line }) => line.startsWith('@~/.claude-work/'));
    assert.ok(
      tildeLines.length > 0,
      `expected at least one @~/.claude-work/ line under a custom --config-dir, got: ${JSON.stringify(collectAtLines(gsdCoreDir))}`,
    );
  });

  test('claude --global: double-quoted shell $HOME references are preserved (#1284)', () => {
    // At least one emitted file must still carry a double-quoted
    // "$HOME/.claude/" shell reference — proving the restore step did NOT
    // blanket-convert every $HOME occurrence, only @-anchored ones.
    const gsdCoreDir = path.join(claudeGlobalHome, '.claude', 'gsd-core');
    let sawShellHome = false;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md') && fs.readFileSync(full, 'utf8').includes('"$HOME/.claude/')) {
          sawShellHome = true;
        }
      }
    };
    walk(gsdCoreDir);
    assert.ok(sawShellHome, 'expected at least one emitted file to preserve a "$HOME/.claude/ shell reference');
  });

  test('claude --local: pathPrefix is absolute — no @$HOME or bare @~ leak (negative proof)', () => {
    const gsdCoreDir = path.join(claudeLocalHome, '.claude', 'gsd-core');
    assert.ok(fs.existsSync(gsdCoreDir), `expected ${gsdCoreDir} to exist`);
    const badLines = collectAtLines(gsdCoreDir).filter(
      ({ line }) => /^@\$HOME/.test(line) || /^@~\//.test(line),
    );
    assert.deepStrictEqual(badLines, [], `local install must not emit @$HOME or @~/: ${JSON.stringify(badLines)}`);
  });

  test('opencode --global: unaffected — never emits an @~/.claude/ line (negative proof)', () => {
    const gsdCoreDir = path.join(opencodeGlobalHome, '.config', 'opencode', 'gsd-core');
    assert.ok(fs.existsSync(gsdCoreDir), `expected ${gsdCoreDir} to exist`);
    const leaked = collectAtLines(gsdCoreDir).filter(({ line }) => line.startsWith('@~/.claude/'));
    assert.deepStrictEqual(
      leaked, [],
      `opencode must never emit a @~/.claude/ line (claude-only restore leaked): ${JSON.stringify(leaked)}`,
    );
  });

  test('cursor --global: unaffected — still emits @$HOME/.cursor/ (unrestored), never @~/.claude/ (negative proof)', () => {
    const gsdCoreDir = path.join(cursorGlobalHome, '.cursor', 'gsd-core');
    assert.ok(fs.existsSync(gsdCoreDir), `expected ${gsdCoreDir} to exist`);
    const atLines = collectAtLines(gsdCoreDir);
    const leaked = atLines.filter(({ line }) => line.startsWith('@~/.claude/'));
    assert.deepStrictEqual(
      leaked, [],
      `cursor must never emit a @~/.claude/ line (claude-only restore leaked): ${JSON.stringify(leaked)}`,
    );
    assert.ok(
      atLines.some(({ line }) => line.startsWith('@$HOME/.cursor/')),
      `expected cursor's own $HOME-form @-refs to remain unrestored, got: ${JSON.stringify(atLines)}`,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// #3719: applyAgentPathRewrites (the agents/ staging pipeline's pre-converter
// path-rewrite step, install-profiles.cts:964) does the 4 base ~/.claude/ and
// $HOME/.claude/ substitutions but NEVER calls restoreClaudeGlobalAtRefTilde
// — the SAME restore #3133 wired into `_applyRuntimeRewrites`'s 'claude' case
// and #3544 wired into the gsd-core/ spec-tree emit path. Consequence: every
// `agents/gsd-*.md` `@`-include (mandatory-initial-read.md, the
// untrusted-input boundary, the agent-skills bootstrap, etc.) ships as
// `@$HOME/.claude/...` in a global Claude install, which Claude Code does not
// expand — the include silently loads nothing. Unlike #3133/#3544, this is a
// MISSING call, not a wrong regex; fixing it must not touch the ordinary
// $HOME/.claude/ substitutions non-@-anchored text still needs (#1284).
// ────────────────────────────────────────────────────────────────────────
describe('#3719: applyAgentPathRewrites must restore @-anchored $HOME refs to tilde', () => {
  const { applyAgentPathRewrites } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  const globalHomePrefix = '$HOME/.claude/';

  test('row 1 [RED] — an @-include through the agents path emits @~/… not @$HOME/…', () => {
    const src = '@~/.claude/gsd-core/references/mandatory-initial-read.md\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, '@~/.claude/gsd-core/references/mandatory-initial-read.md\n');
  });

  // #3719 review (MINOR 3): the original control string contained no `@` at
  // all, so `restoreClaudeGlobalAtRefTilde`'s `atRefRe` (which only matches
  // an `@`-anchored sequence) could never match it — the row passed even
  // with the quote-lookbehind deleted entirely, proving nothing about
  // quote-awareness. A real control needs an `@`-anchored $HOME reference
  // INSIDE quotes: `~` does not expand inside double-quoted shell strings
  // (#1284), so a quoted `@~/.claude/x` must stay on `@$HOME/.claude/x`
  // after the restore pass, not be rewritten back to `@~/`. Confirmed this
  // row fails (asserts the wrong string) if the lookbehind
  // `(?<!["'])` is deleted from `restoreClaudeGlobalAtRefTilde`'s `atRefRe` —
  // without it the quoted `@$HOME/.claude/x` matches unconditionally and is
  // rewritten to `@~/.claude/x`, breaking the assertion below.
  test('row 2 [CONTROL] — a quoted @-reference stays on $HOME (quote-aware, #1284)', () => {
    const src = 'echo "@~/.claude/x"\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, 'echo "@$HOME/.claude/x"\n');
  });

  test('row 7 [CONTROL] — a noPathRewrite runtime (copilot) is untouched', () => {
    const src = '@~/.claude/gsd-core/references/mandatory-initial-read.md\n';
    const out = applyAgentPathRewrites(src, 'copilot', globalHomePrefix);
    assert.strictEqual(out, src, 'noPathRewrite runtimes must be returned unchanged (no substitutions at all)');
  });

  // #3719 review (MINOR 2): row 7 (copilot) returns early at the
  // `noPathRewrite` check and never reaches the `if (runtime === 'claude')`
  // restore guard at all — zero coverage of the guard itself. Cursor and
  // Kilo are NOT noPathRewrite, so they exercise the base `.claude/` ->
  // pathPrefix substitution AND then hit the guard, which must suppress the
  // `@~` restore because they are not `claude`.
  test('row 10 [CONTROL] — cursor (non-claude, non-noPathRewrite) keeps @$HOME/.cursor/…, does not restore to tilde', () => {
    const src = '@~/.claude/gsd-core/references/mandatory-initial-read.md\n';
    const out = applyAgentPathRewrites(src, 'cursor', '$HOME/.cursor/');
    assert.strictEqual(out, '@$HOME/.cursor/gsd-core/references/mandatory-initial-read.md\n',
      'cursor must keep the @$HOME/.cursor/ form — the runtime guard must suppress the claude-only tilde restore');
  });

  test('row 11 [CONTROL] — kilo (non-claude, non-noPathRewrite) keeps @$HOME/.kilo/…, does not restore to tilde', () => {
    const src = '@~/.claude/gsd-core/references/mandatory-initial-read.md\n';
    const out = applyAgentPathRewrites(src, 'kilo', '$HOME/.kilo/');
    assert.strictEqual(out, '@$HOME/.kilo/gsd-core/references/mandatory-initial-read.md\n',
      'kilo must keep the @$HOME/.kilo/ form — the runtime guard must suppress the claude-only tilde restore');
  });

  // ── boundary rows ──
  test('boundary — leading @~/.claude/x @-include', () => {
    const src = '@~/.claude/x\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, '@~/.claude/x\n');
  });

  test('boundary — mid-sentence @~/.claude/x @-include', () => {
    const src = 'See @~/.claude/x for details\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, 'See @~/.claude/x for details\n');
  });

  test('boundary — ~/.claude/x with NO @ prefix must stay on $HOME (not an @-include)', () => {
    const src = 'See ~/.claude/x for details\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, 'See $HOME/.claude/x for details\n');
  });

  test('boundary — @~/.claude with no trailing slash (word-boundary variant)', () => {
    const src = '@~/.claude\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, '@~/.claude\n');
  });

  test('boundary — @$HOME/.claude/x already present in source is restored, not double-rewritten', () => {
    const src = '@$HOME/.claude/x\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, '@~/.claude/x\n');
  });

  // #3719 GAP 1: `-work-work` doubling guard. The MAJOR fix changed the two
  // `~/.claude` / `$HOME/.claude` replaces in this function from a bare `\b`
  // to `(?![\w-])`, because `\b` is satisfied by ANY non-word character —
  // including '-'. For a --config-dir whose name EXTENDS '.claude' (e.g.
  // '.claude-work'), the bare-`\b` regex re-matched the '.claude' PREFIX of
  // the already-substituted '.claude-work' path and corrupted it to
  // '.claude-work-work'. Security measured 120 doubled paths before the fix
  // and 0 after. Nothing else in this file installs under a config dir that
  // extends '.claude', so without this block the fix ships unpinned.
  describe('-work-work doubling guard (#3719 MAJOR: \\b -> (?![\\w-]))', () => {
    const extendedPrefix = '$HOME/.claude-work/';

    test('@-include: @~/.claude/x.md -> @~/.claude-work/x.md (not .claude-work-work)', () => {
      const src = '@~/.claude/x.md';
      const out = applyAgentPathRewrites(src, 'claude', extendedPrefix);
      assert.strictEqual(out, '@~/.claude-work/x.md');
    });

    test('no-trailing-slash variant: @~/.claude -> @~/.claude-work', () => {
      const src = '@~/.claude';
      const out = applyAgentPathRewrites(src, 'claude', extendedPrefix);
      assert.strictEqual(out, '@~/.claude-work');
    });

    test('prose (non-@-anchored): See ~/.claude/p.md -> See $HOME/.claude-work/p.md', () => {
      const src = 'See ~/.claude/p.md';
      const out = applyAgentPathRewrites(src, 'claude', extendedPrefix);
      assert.strictEqual(out, 'See $HOME/.claude-work/p.md');
    });

    // Different extension character class (word char 'x' immediately after
    // '.claude', vs. '-' above) — confirms the lookahead's `[\w-]` class
    // covers both.
    test('.claudex prefix (word-char extension): @~/.claude/x.md -> @~/.claudex/x.md', () => {
      const src = '@~/.claude/x.md';
      const out = applyAgentPathRewrites(src, 'claude', '$HOME/.claudex/');
      assert.strictEqual(out, '@~/.claudex/x.md');
    });
  });
});

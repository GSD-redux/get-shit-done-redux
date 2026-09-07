'use strict';
/**
 * Parity test for bug #373: space-safe gsd_run launcher
 *
 * Asserts:
 * (A) No retired GSD_SDK token remains in any workflow .md file.
 * (B) Each workflow .md that uses gsd_run contains EXACTLY ONE canonical preamble
 *     (byte-equal to _runtime-launcher.snippet.sh), and it appears before the first
 *     gsd_run call. NOT every bash block — exactly one per file (define once, use
 *     across blocks — original footprint).
 * (C) Space-safe behavioral: a RUNTIME_DIR path with spaces in it resolves
 *     and calls gsd-tools.cjs correctly (no word-split, no {}).
 * (D) Loud guard behavioral: missing gsd-tools.cjs exits non-zero and emits
 *     "not found" to stderr.
 * (E) PATH fallback behavioral: when no local gsd-tools.cjs, the elif branch
 *     resolves to the gsd_run binary on PATH (#3668).
 * (F) Regression locks: the snippet file contains no /gsd-tools substring; and
 *     no line in workflows/do.md matches /\/gsd[:-][a-z]/ (dispatcher-parity
 *     scanner must not read the preamble as a slash-command stub).
 * (H) Codex shim fallback: when PATH has no gsd_run, $HOME/.codex/gsd-core/bin
 *     can satisfy gsd_run for Codex shim-only installs.
 */

// allow-test-rule: structural-regression-guard
// structural parity/drift guard — asserts literal presence/absence of the canonical gsd_run launcher and the retired $GSD_SDK / `/gsd-tools` tokens across workflow markdown; there is no typed IR for "this source file does not contain substring X".

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { cleanup, TEST_ENV_BASE } = require('./helpers.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const SNIPPET_FILE = path.join(WORKFLOWS_DIR, '_runtime-launcher.snippet.sh');

/**
 * Env for any fixture that sources the snippet (#4205).
 *
 * TEST_ENV_BASE is DERIVED from the same capability registry the resolver
 * reads (see tests/helpers.cjs, #2665), so a new runtime home cannot leave it
 * silently stale — the shape of #4205.
 *
 * Three keys the derived set cannot supply:
 *  - GEMINI_CONFIG_DIR: the gemini runtime is retired (#1928) so the registry
 *    no longer carries it, but the snippet still probes its arm.
 *  - CLAUDE_ENV_FILE: a WRITE sink, not a read path. Left ambient, every
 *    fixture that exits 0 appends `export PATH='<temp dir>'` to the
 *    developer's real env file, each line naming a /tmp dir the fixture has
 *    already deleted.
 *  - BASH_ENV: sourced by non-interactive bash BEFORE the script, which is
 *    after this scrub is applied — so one inherited var re-injects any of
 *    the others. Measured: a BASH_ENV exporting CODEX_HOME turns (H) red.
 */
const SNIPPET_SCRUB = { GEMINI_CONFIG_DIR: '', CLAUDE_ENV_FILE: '', BASH_ENV: '' };
function snippetEnv(overrides = {}) {
  const env = { ...process.env, ...TEST_ENV_BASE, ...SNIPPET_SCRUB, ...overrides };
  // Windows env vars are case-insensitive; a spread of process.env is not. The
  // host PATH enumerates as `Path` there, so `{ ...process.env, PATH: x }`
  // yields BOTH keys — and libuv's make_program_env sorts the child's block
  // case-insensitively but never drops duplicates, so the ambient twin of
  // anything scrubbed here still reaches the child and defeats the isolation
  // this whole file rests on. Every key this function sets wins over any other
  // casing of itself; keys it does not set are left alone, so a caller that
  // passes no PATH override still gets the host PATH.
  const canonical = new Map(
    [...Object.keys(TEST_ENV_BASE), ...Object.keys(SNIPPET_SCRUB), ...Object.keys(overrides)]
      .map((key) => [key.toUpperCase(), key]),
  );
  for (const key of Object.keys(env)) {
    const owner = canonical.get(key.toUpperCase());
    if (owner !== undefined && owner !== key) delete env[key];
  }
  return env;
}

/**
 * Run a bash script FILE via the process seam, preserving the throw-on-
 * nonzero-exit semantics of the execFileSync('bash', [path], ...) idiom
 * this replaces.
 */
function runBashFile(scriptPath, options = {}) {
  const r = runHookSeam(scriptPath, [], {
    interpreter: 'bash', ...options, env: snippetEnv(options.env),
  });
  throwIfFailed(r, `bash ${scriptPath}`);
  return r.stdout;
}

const NODE_BIN = process.platform === 'win32' ? 'node.exe' : 'node';

/**
 * Put an executable link to this interpreter in `dir` under `name`, and return
 * `dir` so a caller can prepend it to a PATH. Callers use it for both halves of
 * a fixture: the node the launcher needs, and the gsd_run sentinel it must not
 * reach. The content never matters, only that the name resolves.
 *
 * Windows symlinks need elevation, so a hard link is used there instead: it
 * needs no privilege, but it cannot cross volumes, hence the copy fallback.
 */
function linkExecutable(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  if (process.platform !== 'win32') {
    fs.symlinkSync(process.execPath, target);
    return dir;
  }
  try {
    fs.linkSync(process.execPath, target);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(process.execPath, target);
  }
  return dir;
}

/**
 * Plant `dir/name` as a file an X_OK probe accepts, and return `dir`. For
 * fixtures that only need a name to be *found*: nothing ever executes these,
 * so they cost a zero-byte write instead of a link to (or, across volumes, a
 * copy of) the whole interpreter.
 */
function plantExecutable(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), '', { mode: 0o755 });
  return dir;
}

/**
 * Every filename the launcher's `command -v gsd_run` arm could resolve.
 *
 * The arm runs under bash, so this models bash's lookup, not cmd.exe's. The
 * Cygwin/msys rule is that `.exe` may be omitted from a command while ".bat and
 * .com ... you cannot omit the extension" — so `gsd_run.exe` is reachable for a
 * bare `gsd_run` and `gsd_run.cmd`/`.ps1` are not, whatever PATHEXT says.
 *
 * Matching PATHEXT instead would drop more directories than bash can reach, and
 * that is not free: buildIsolatedPath() restores node to the isolated PATH but
 * nothing restores bash, which the fixtures spawn by name. A wider drop set is
 * a wider chance of removing the directory bash itself lives in and failing the
 * fixture with ENOENT instead of an assertion.
 */
const GSD_RUN_NAMES = process.platform === 'win32'
  ? ['gsd_run', 'gsd_run.exe']
  : ['gsd_run'];

/** True when `dir` holds a gsd_run the launcher's PATH arm could resolve. */
function hasGsdRun(dir) {
  return GSD_RUN_NAMES.some((name) => {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; }
    catch { return false; }
  });
}

/**
 * Build a PATH the launcher's `command -v gsd_run` arm cannot resolve anything
 * from, while a bare `node` lookup still succeeds — the precondition every
 * runtime-home fallback fixture needs.
 *
 * Directories holding a resolvable gsd_run are dropped (#4205: the arm probes
 * `gsd_run`, not `gsd-tools`), then a dedicated dir carrying only node is
 * prepended. The prepend is unconditional because dropping the directory node
 * itself lives in is a normal outcome, not an exotic one: fnm, nvm, Homebrew
 * and Windows global installs all co-locate the two.
 *
 * The caller cleans up `result.nodeBinDir` (pass it to `cleanup()` in a
 * `t.after` or `finally` block).
 *
 * @param {string} [basePath] PATH to filter. Callers planting a leaked gsd_run
 *   pass their own string rather than mutating `process.env.PATH`.
 * @returns {{ isolatedPath: string, nodeBinDir: string }}
 */
function buildIsolatedPath(basePath = process.env.PATH) {
  // Only absolute directories survive. An empty element means "the current
  // directory" to a POSIX shell and `.` says so explicitly, so either one puts
  // the child's cwd on PATH — and hasGsdRun cannot see what it would admit,
  // since `path.join('.', 'gsd_run')` probes the *runner's* cwd instead of the
  // child's. Joining the survivors (rather than the filtered string) also keeps
  // a fully-filtered PATH from ending in a delimiter, which means the same
  // thing. Dropping a relative entry can only tighten the isolation, never
  // loosen it.
  const filteredDirs = (basePath ?? '')
    .split(path.delimiter)
    .filter((p) => path.isAbsolute(p) && !hasGsdRun(p));

  const nodeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-node-'));
  try {
    linkExecutable(nodeBinDir, NODE_BIN);
  } catch (err) {
    cleanup(nodeBinDir);
    throw err;
  }

  return { isolatedPath: [nodeBinDir, ...filteredDirs].join(path.delimiter), nodeBinDir };
}

/**
 * Read the canonical preamble from the snippet file (all lines, no trailing newline).
 */
function expectedPreamble() {
  const raw = fs.readFileSync(SNIPPET_FILE, 'utf8');
  const lines = raw.split(/\r?\n/);
  // Strip trailing empty element produced by a trailing newline.
  const content = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  assert.ok(content.length >= 1, `_runtime-launcher.snippet.sh must not be empty`);
  return content; // array of strings
}

/**
 * Extract all bash/sh/shell fenced blocks from markdown content.
 * Returns array of { index, lines } where index is 0-based block count,
 * and lines is the array of content lines (without the fence markers).
 *
 * Handles both column-0 fences (```bash) and indented fences (   ```bash).
 */
function extractShellBlocks(content) {
  const allLines = content.split(/\r?\n/);
  const blocks = [];
  let inBlock = false;
  let blockLang = null;
  let blockLines = [];
  let blockIndex = 0;
  let blockIndent = '';
  let closingPattern = null;

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (!inBlock) {
      const fenceOpen = line.match(/^(\s*)```(\w+)?\s*$/);
      if (fenceOpen) {
        inBlock = true;
        blockIndent = fenceOpen[1];
        blockLang = (fenceOpen[2] || '').toLowerCase();
        blockLines = [];
        // Closing pattern: same indent prefix + ```
        closingPattern = new RegExp('^' + escapeRegex(blockIndent) + '```\\s*$');
        continue;
      }
    } else {
      if (closingPattern.test(line)) {
        if (['bash', 'sh', 'shell', 'zsh', ''].includes(blockLang)) {
          blocks.push({ index: blockIndex, lang: blockLang, lines: blockLines });
          blockIndex++;
        }
        inBlock = false;
        blockLang = null;
        blockLines = [];
        blockIndent = '';
        closingPattern = null;
        continue;
      }
      blockLines.push(line);
    }
  }
  return blocks;
}

/**
 * Collect all workflow .md files recursively under WORKFLOWS_DIR.
 * Excludes _runtime-launcher.snippet.sh (not a markdown file).
 */
function collectWorkflowFiles() {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  }
  walk(WORKFLOWS_DIR);
  return results;
}

/**
 * Collect all agent .md files under AGENTS_DIR (non-recursive — agents/ has no subdirs,
 * but collectFiles in the sync script is recursive-safe; we mirror that here).
 */
function collectAgentFiles() {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  }
  walk(AGENTS_DIR);
  return results;
}

/**
 * A workflow/agent file "delegates to the shared resolver" when it pulls the
 * canonical gsd_run preamble in from gsd-core/references/gsd-run-resolver.md via
 * an @-include instead of inlining the snippet (see onboard.md / issue #1990).
 *
 * Such files are exempt from the inline-preamble parity checks (B / G / H and the
 * runtime-home propagation checks): they intentionally do NOT inline the preamble
 * — onboard-command.test.cjs even asserts the absence of the inline form. Their
 * resolver correctness is guaranteed transitively by:
 *   (1) onboard-command.test.cjs asserting the @-include is present, and
 *   (2) the "resolver reference stays byte-equal to the snippet" guard (B2) below.
 */
function delegatesToResolverReference(content) {
  return content.includes('references/gsd-run-resolver.md');
}

describe('runtime-launcher-parity (#373)', () => {
  // ─── (#3146) Deliberate bootstrap-only preamble placement is preserved ────
  test('sync preserves a deliberate bootstrap-only preamble placement (#3146)', () => {
    // gsd-core/workflows/explore.md deliberately places the preamble in a
    // Step 1 block that DEFINES gsd_run but never CALLS it — its own comment
    // explains why: "Placed in Step 1 rather than Step 3 so declining the
    // research offer cannot leave Step 5's commit call unbootstrapped."
    // transformFile strips all blocks before re-inserting the preamble, so a
    // naive "first block that CALLS gsd_run" target would silently relocate
    // the preamble into the second block, breaking define-before-use. This
    // fixture reproduces that shape with two blocks: the first containing
    // ONLY the preamble (no gsd_run call), the second containing a gsd_run
    // call.
    const preamble = expectedPreamble();
    const preambleText = preamble.join('\n');

    const fixture =
      '# Fixture\n\n' +
      '```bash\n' +
      preambleText + '\n' +
      '```\n\n' +
      '```bash\n' +
      'gsd_run query something\n' +
      '```\n';

    const { transformFile } = require('../scripts/sync-runtime-launcher.cjs');
    const result = transformFile(fixture, preamble);

    // transformFile returns null when no changes are needed (already correct
    // and idempotent); otherwise the transformed content.
    const finalContent = result === null ? fixture : result;

    const markerIdx = finalContent.indexOf('_GSD_SHIM_NAME=');
    const useIdx = finalContent.indexOf('gsd_run query something');

    assert.ok(markerIdx >= 0, 'expected the preamble marker to be present in the transformed fixture');
    assert.ok(useIdx >= 0, 'expected the gsd_run call to be present in the transformed fixture');
    assert.ok(
      markerIdx < useIdx,
      `expected preamble (index ${markerIdx}) to remain in the FIRST block, before the gsd_run call ` +
        `(index ${useIdx}) — the sync script must not relocate a deliberately-placed bootstrap-only preamble`,
    );
  });

  // ─── (A) No retired GSD_SDK token ────────────────────────────────────────
  test('(A) no GSD_SDK token in any workflow .md file', () => {
    const files = collectWorkflowFiles();
    assert.ok(files.length > 0, 'expected at least one workflow .md file');

    const offending = [];
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      if (content.includes('GSD_SDK')) {
        offending.push(path.relative(WORKFLOWS_DIR, f));
      }
    }

    assert.deepStrictEqual(
      offending,
      [],
      'Found GSD_SDK (retired token) in workflow files — run `node scripts/sync-runtime-launcher.cjs` to fix:\n' +
        offending.join('\n'),
    );
  });

  // ─── (B) Exactly ONE canonical preamble per using file ───────────────────
  test('(B) each workflow .md using gsd_run contains exactly ONE canonical preamble, before the first gsd_run call', () => {
    const preamble = expectedPreamble();
    const preambleStr = preamble.join('\n');
    const files = collectWorkflowFiles();
    assert.ok(files.length > 0, 'expected at least one workflow .md file');

    const violations = [];

    for (const f of files) {
      const rel = path.relative(WORKFLOWS_DIR, f);
      const content = fs.readFileSync(f, 'utf8');
      // Files that delegate to the shared resolver reference (@-include) do not
      // inline the preamble — exempt them (see delegatesToResolverReference / (B2)).
      if (delegatesToResolverReference(content)) continue;
      const blocks = extractShellBlocks(content);

      // Collect all block lines in document order for flat analysis
      const allBlockLines = [];
      for (const blk of blocks) {
        allBlockLines.push(...blk.lines);
      }

      // Does this file use gsd_run at all?
      const fileHasGsdRun = allBlockLines.some((l) => /\bgsd_run\b/.test(l));
      if (!fileHasGsdRun) continue;

      // Count preamble occurrences across all shell content of this file
      // Flatten all block lines with a separator so multi-block boundary doesn't create false match
      const allContent = allBlockLines.join('\n');
      let preambleCount = 0;
      let searchPos = 0;
      while (true) {
        const idx = allContent.indexOf(preambleStr, searchPos);
        if (idx === -1) break;
        preambleCount++;
        searchPos = idx + preambleStr.length;
      }

      if (preambleCount !== 1) {
        violations.push(
          `${rel}: expected exactly 1 canonical preamble occurrence in bash blocks, found ${preambleCount}. ` +
            `Run \`node scripts/sync-runtime-launcher.cjs\` to fix.`,
        );
        continue;
      }

      // Verify preamble appears BEFORE the first gsd_run call (in document order)
      // Find the line index of the preamble start vs the first gsd_run call in the flat content
      const preamblePos = allContent.indexOf(preambleStr);
      const firstGsdRunPos = allContent.search(/\bgsd_run\b/);

      // The first gsd_run WITHIN the preamble itself (the function definition) is fine.
      // We need to verify that no gsd_run CALL (i.e. gsd_run used as a command, not in a
      // function definition body) appears before the preamble starts.
      // Simple check: preamble starts at or before the first gsd_run occurrence
      if (preamblePos > firstGsdRunPos) {
        violations.push(
          `${rel}: preamble appears AFTER the first gsd_run reference — it must precede all gsd_run calls.`,
        );
      }
    }

    assert.deepStrictEqual(
      violations,
      [],
      'Files with gsd_run calls have wrong preamble count or ordering:\n' +
        violations.join('\n---\n'),
    );
  });

  // ─── (B2) Shared resolver reference stays byte-equal to the snippet ───────
  // Workflows may delegate to gsd-core/references/gsd-run-resolver.md instead of
  // inlining the preamble (see delegatesToResolverReference). That delegation is
  // only safe if the reference's bash block is byte-equal to the canonical
  // snippet — otherwise a delegating workflow (e.g. onboard.md) would silently
  // ship a drifted resolver. This guard replaces the inline-preamble checks for
  // those files.
  test('(B2) references/gsd-run-resolver.md preamble is byte-equal to the canonical snippet', () => {
    const preambleStr = expectedPreamble().join('\n');
    const refPath = path.join(__dirname, '..', 'gsd-core', 'references', 'gsd-run-resolver.md');
    const refContent = fs.readFileSync(refPath, 'utf8');
    const refPreamble = extractShellBlocks(refContent)
      .map((b) => b.lines.join('\n'))
      .join('\n')
      .trim();
    assert.equal(
      refPreamble,
      preambleStr,
      'gsd-core/references/gsd-run-resolver.md must contain the canonical gsd_run preamble ' +
        'byte-equal to _runtime-launcher.snippet.sh. Re-copy the snippet into the reference so ' +
        'workflows that delegate to it via @-include ship the current resolver.',
    );
  });

  // ─── (C) Space-safe behavioral test ──────────────────────────────────────
  test('(C) gsd_run works with a RUNTIME_DIR path containing spaces', () => {
    // Create temp dir whose path contains a space
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd 373 '));
    try {
      const binDir = path.join(base, 'gsd-core', 'bin');
      fs.mkdirSync(binDir, { recursive: true });

      // Stub gsd-tools.cjs that prints its argv
      const stub = path.join(binDir, 'gsd-tools.cjs');
      fs.writeFileSync(stub, '#!/usr/bin/env node\nconsole.log("STUB:" + process.argv.slice(2).join(","));\n');
      fs.chmodSync(stub, 0o755);

      // Build a shell script: set RUNTIME_DIR, source preamble, run gsd_run
      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      const scriptContent =
        `export RUNTIME_DIR=${JSON.stringify(base)}\n` +
        snippet +
        `\ngsd_run query state.json\n`;

      const scriptPath = path.join(base, 'test-space.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      const stdout = runBashFile(scriptPath);
      assert.ok(
        stdout.includes('STUB:query,state.json'),
        `Expected stdout to contain "STUB:query,state.json" but got: ${stdout.trim()}`,
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── (D) Loud guard: missing runtime is fatal ─────────────────────────────
  test('(D) missing gsd-tools.cjs and no PATH gsd_run causes loud non-zero exit with "not found" on stderr', (t) => {
    // Create temp dir with a space in the name, but NO gsd-tools.cjs.
    // We ensure gsd_run is not on PATH by prepending a dir that has no
    // gsd_run binary (system binaries remain on PATH so bash/node work).
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd 373 notools '));
    // Place a no-op dir first in PATH; no gsd_run stub there.
    const noToolsBin = path.join(base, 'nobin');
    fs.mkdirSync(noToolsBin, { recursive: true });
    try {
      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      // The script must also unset any GSD_TOOLS env var that might leak in
      const scriptContent =
        `unset GSD_TOOLS\n` +
        `export RUNTIME_DIR=${JSON.stringify(base)}\n` +
        snippet +
        `\ngsd_run query state.json\n`;

      const scriptPath = path.join(base, 'test-guard.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      // noToolsBin first (no gsd_run stub there), then a PATH no gsd_run is
      // resolvable from.
      const isolated = buildIsolatedPath();
      t.after(() => cleanup(isolated.nodeBinDir));
      const isolatedPath = [noToolsBin, isolated.isolatedPath].join(path.delimiter);

      const r = runHookSeam(scriptPath, [], {
        interpreter: 'bash',
        // Loud-guard requires every runtime-home arm to genuinely miss, not
        // just PATH (#4205 class: an ambient config-dir var pointing at a
        // real install would resolve here instead of the hard error).
        env: snippetEnv({ PATH: isolatedPath, HOME: base }),
      });
      const threw = r.exitCode !== 0;
      const stderrOutput = r.stderr || '';

      assert.ok(threw, 'Expected the script to exit non-zero when gsd-tools.cjs is missing and gsd_run is not on PATH');
      // Match the launcher's own diagnostic, not a bare "not found": when node
      // itself is missing from the isolated PATH, bash's own
      // `bash: node: command not found` satisfies the loose form and a
      // regressed guard passes.
      assert.ok(
        stderrOutput.includes('ERROR: gsd-tools.cjs not found'),
        `Expected stderr to contain "ERROR: gsd-tools.cjs not found", got: ${stderrOutput.trim()}`,
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── (E) PATH fallback behavioral (#3668) ────────────────────────────────
  test('(E) PATH fallback: uses installed gsd_run when no local gsd-tools.cjs present', () => {
    // Create a temp dir with NO local gsd-core/bin/gsd-tools.cjs.
    // Place an executable gsd_run stub on a dedicated PATH dir.
    // RUNTIME_DIR points somewhere that has no gsd-tools.cjs.
    //
    // #3146: the PATH-fallback target changed from `gsd-tools` to `gsd_run`.
    // The predecessor package `get-shit-done-cc` publishes a colliding
    // `gsd-tools` bin, so the launcher resolves `gsd_run`, which only this
    // package publishes.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd 373 pathfb '));
    try {
      const pathBinDir = path.join(base, 'bin');
      fs.mkdirSync(pathBinDir, { recursive: true });

      // Stub installed gsd_run binary that prints a marker
      const stubPath = path.join(pathBinDir, 'gsd_run');
      fs.writeFileSync(stubPath, '#!/bin/sh\necho "installed:$*"\n');
      fs.chmodSync(stubPath, 0o755);

      // RUNTIME_DIR points to base — no gsd-core/bin/gsd-tools.cjs there
      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      const scriptContent =
        `export RUNTIME_DIR=${JSON.stringify(base)}\n` +
        snippet +
        `\nprintf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"\n` +
        `gsd_run query state.json\n`;

      const scriptPath = path.join(base, 'test-pathfb.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      const stdout = runBashFile(scriptPath, {
        env: { PATH: `${pathBinDir}${path.delimiter}${process.env.PATH || ''}` },
      });

      // The PATH fallback must have resolved GSD_TOOLS to the stub binary.
      // Normalize backslashes → forward slashes so the assertion works on Windows
      // (git-bash emits POSIX paths while Node's os.tmpdir() returns the Windows form).
      // Assert by suffix (/bin/gsd_run, no .cjs extension) rather than absolute prefix
      // because the prefix differs between Windows and POSIX.
      // Use .+ (not \S*) to tolerate paths that contain spaces.
      const normStdout = stdout.replace(/\\/g, '/');
      assert.match(
        normStdout,
        /GSD_TOOLS=.+\/bin\/gsd_run(?:\s|$)/m,
        `Expected GSD_TOOLS to resolve to the installed PATH stub (suffix /bin/gsd_run), got: ${stdout.trim()}`,
      );
      assert.doesNotMatch(
        normStdout,
        /GSD_TOOLS=.+\.cjs/m,
        `Expected GSD_TOOLS NOT to point to a .cjs file in PATH fallback, got: ${stdout.trim()}`,
      );
      // The stub must have been invoked with the query arguments
      assert.ok(
        stdout.includes('installed:query state.json'),
        `Expected stdout to contain "installed:query state.json" (PATH stub output), got: ${stdout.trim()}`,
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── (G) ~/.claude fallback arm is present (#211) ───────────────────────────
  test('(G) snippet and all propagated workflow .md files contain the $HOME/.claude fallback arm between PATH check and hard error', () => {
    // The resolution order must be:
    //   (1) local/RUNTIME_DIR  →  (2) PATH  →  (3) $HOME/.claude/gsd-core/bin  →  (4) hard error
    // We probe for .claude/gsd-core/bin (using ${_GSD_SHIM_NAME} indirection)
    // between the `command -v gsd_run` elif and the hard-error else branch.
    const CLAUDE_HOME_PROBE = '.claude/gsd-core/bin/';

    // Assert snippet itself contains the probe
    const snippetContent = fs.readFileSync(SNIPPET_FILE, 'utf8');
    assert.ok(
      snippetContent.includes(CLAUDE_HOME_PROBE),
      `_runtime-launcher.snippet.sh must contain the $HOME/.claude fallback arm (probing "${CLAUDE_HOME_PROBE}"). ` +
        `Add an elif arm that checks $HOME/.claude/gsd-core/bin/\${_GSD_SHIM_NAME} before the hard-error else.`,
    );

    // Assert the probe appears BEFORE the hard-error text in the snippet
    const probePos = snippetContent.indexOf(CLAUDE_HOME_PROBE);
    const errorPos = snippetContent.indexOf('exit 1');
    assert.ok(
      probePos < errorPos,
      `The $HOME/.claude fallback arm (at index ${probePos}) must appear before "exit 1" (at index ${errorPos}) in the snippet.`,
    );

    // Assert every propagated workflow .md file that uses gsd_run also contains the probe
    const files = collectWorkflowFiles();
    const missing = [];
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      const blocks = extractShellBlocks(content);
      const allBlockLines = blocks.flatMap((b) => b.lines);
      if (delegatesToResolverReference(content)) continue;
      const fileHasGsdRun = allBlockLines.some((l) => /\bgsd_run\b/.test(l));
      if (!fileHasGsdRun) continue;
      const allContent = allBlockLines.join('\n');
      if (!allContent.includes(CLAUDE_HOME_PROBE)) {
        missing.push(path.relative(WORKFLOWS_DIR, f));
      }
    }
    assert.deepStrictEqual(
      missing,
      [],
      `These workflow files use gsd_run but are missing the $HOME/.claude fallback arm ("${CLAUDE_HOME_PROBE}"). ` +
        `Run \`node scripts/sync-runtime-launcher.cjs\` to propagate:\n` +
        missing.join('\n'),
    );
  });

  // ─── (H) Codex shim fallback behavioral ------------------------------------
  test('(H) gsd_run resolves $HOME/.codex/gsd-core/bin/ shim when PATH has no gsd_run', (t) => {
    const CODEX_HOME_PROBE = '.codex/gsd-core/bin/';

    const snippetContent = fs.readFileSync(SNIPPET_FILE, 'utf8');
    assert.ok(
      snippetContent.includes(CODEX_HOME_PROBE),
      `_runtime-launcher.snippet.sh must contain the Codex fallback arm (probing "${CODEX_HOME_PROBE}").`,
    );

    const missing = [];
    for (const f of collectWorkflowFiles()) {
      const content = fs.readFileSync(f, 'utf8');
      const blocks = extractShellBlocks(content);
      const allBlockLines = blocks.flatMap((b) => b.lines);
      if (delegatesToResolverReference(content)) continue;
      const fileHasGsdRun = allBlockLines.some((l) => /\bgsd_run\b/.test(l));
      if (!fileHasGsdRun) continue;
      if (!allBlockLines.join('\n').includes(CODEX_HOME_PROBE)) {
        missing.push(path.relative(WORKFLOWS_DIR, f));
      }
    }
    assert.deepStrictEqual(
      missing,
      [],
      `These workflow files use gsd_run but are missing the Codex fallback arm ("${CODEX_HOME_PROBE}"). ` +
        `Run \`node scripts/sync-runtime-launcher.cjs\` to propagate:\n` +
        missing.join('\n'),
    );

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-home-'));
    const fakeRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-rt-'));
    try {
      const codexBinDir = path.join(fakeHome, '.codex', 'gsd-core', 'bin');
      fs.mkdirSync(codexBinDir, { recursive: true });
      const stubPath = path.join(codexBinDir, 'gsd-tools.cjs');
      fs.writeFileSync(
        stubPath,
        '#!/usr/bin/env node\nconsole.log("CODEX_HOME_STUB:" + process.argv.slice(2).join(","));\n',
      );
      fs.chmodSync(stubPath, 0o755);

      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      const scriptContent =
        `unset GSD_TOOLS\n` +
        `export RUNTIME_DIR=${JSON.stringify(fakeRuntime)}\n` +
        `export HOME=${JSON.stringify(fakeHome)}\n` +
        snippet +
        `\nprintf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"\n` +
        `gsd_run query init.quick\n`;

      const scriptPath = path.join(fakeRuntime, 'test-codex-home-fb.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      const { isolatedPath, nodeBinDir } = buildIsolatedPath();
      t.after(() => cleanup(nodeBinDir));

      const stdout = runBashFile(scriptPath, {
        // Ambient CLAUDE_CONFIG_DIR/HERMES_HOME/CURSOR_CONFIG_DIR resolve arms
        // checked before CODEX_HOME, and an ambient CODEX_HOME overrides the
        // $HOME/.codex default this test asserts (#4205 class: same env-leak
        // bug, this time via config-dir vars rather than PATH). snippetEnv()'s
        // derived TEST_ENV_BASE clears all four, so only HOME's default
        // $HOME/.codex fallback can win.
        env: { PATH: isolatedPath, HOME: fakeHome },
      });

      const normStdout = stdout.replace(/\\/g, '/');
      assert.ok(
        normStdout.includes('.codex/gsd-core/bin/'),
        `Expected GSD_TOOLS to resolve into .codex/gsd-core/bin/, got:\n${stdout.trim()}`,
      );
      assert.ok(
        stdout.includes('CODEX_HOME_STUB:query,init.quick'),
        `Expected Codex shim stub output, got:\n${stdout.trim()}`,
      );
    } finally {
      cleanup(fakeHome);
      cleanup(fakeRuntime);
    }
  });

  // ─── (F0) Brace balance — the preamble is inlined into brace-counted files ──
  //
  // Regression for the #3841 red matrix run. The preamble is inlined into 112
  // shipped files, and several downstream guards balance braces by scanning raw
  // TEXT with no string-context awareness — tests/new-project-mvp-prompt.test.cjs's
  // "balanced braces" guard (mirroring #3784 bd53925f) counts every `{` and `}`
  // across new-project.md plus its steps/. new-project.md and
  // new-project/steps/auto-mode-config.md each carry one preamble copy, so a
  // snippet that is off by one reports a combined net depth of TWO, in a test whose
  // name mentions neither the launcher nor this issue.
  //
  // The identity assertion's `case` pattern legitimately contains a `{` inside a
  // single-quoted shell literal. It is paired by requiring the payload to be a
  // CLOSED object (`*'}'`) — which is also a real strengthening, since a truncated
  // payload then fails. Pin the balance HERE, at the snippet, so the next edit to
  // that pattern fails on the file it broke rather than three files downstream.
  test('(F0) the snippet has balanced braces (#3841 — inlined into brace-counted files)', () => {
    const snippetContent = fs.readFileSync(SNIPPET_FILE, 'utf8');
    let depth = 0;
    let minDepth = 0;
    for (const ch of snippetContent) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth < minDepth) minDepth = depth;
    }
    assert.equal(
      depth,
      0,
      `_runtime-launcher.snippet.sh has unbalanced braces: net depth ${depth}. ` +
        `The preamble is inlined into 112 shipped files, and downstream guards ` +
        `(tests/new-project-mvp-prompt.test.cjs) balance braces over raw text with no ` +
        `awareness of shell quoting — an unpaired brace here fails there instead, ` +
        `multiplied by the number of inlined copies in the scanned file set. ` +
        `Pair the brace in the snippet; do not relax the downstream guard.`,
    );
    // Never dips below zero: a `}` that precedes its `{` would still net to 0 while
    // being unbalanced at every prefix, which is what a text scanner actually reports.
    assert.equal(minDepth, 0, `brace depth went negative (min ${minDepth}) — a closing brace precedes its opener`);
  });

  // ─── (F) Regression locks: no /gsd-tools substring; no do.md dispatcher false-positive ──
  test('(F) snippet has no /gsd-tools substring; do.md has no /gsd[:-][a-z] matches', () => {
    // (F1) The snippet must not contain the literal substring /gsd-tools.
    // The _GSD_SHIM_NAME indirection ensures bin/${_GSD_SHIM_NAME} instead of
    // bin/gsd-tools.cjs — so the do.md dispatcher regex /\/gsd[:-]([a-z]...)/ never
    // misreads a preamble line as a slash-command stub.
    const snippetContent = fs.readFileSync(SNIPPET_FILE, 'utf8');
    assert.ok(
      !snippetContent.includes('/gsd-tools'),
      `_runtime-launcher.snippet.sh must not contain the literal "/gsd-tools" substring. ` +
        `Use bin/\${_GSD_SHIM_NAME} indirection to keep the /gsd[:-] scanner from ` +
        `misreading it as a slash-command stub. Found in snippet:\n` +
        snippetContent.split(/\r?\n/).filter((l) => l.includes('/gsd-tools')).join('\n'),
    );

    // (F2) workflows/do.md must not contain the literal substring /gsd-tools
    // (the specific path that leaks when _GSD_SHIM_NAME indirection is bypassed).
    // The bug-2954 dispatcher scanner /\/gsd[:-]([a-z]...)/ would misread
    // /gsd-tools as a slash-command stub named "tools" — which is not shipped.
    // Note: /gsd:command references (with colon) in the dispatch table are
    // legitimate and are NOT checked here.
    const doMdPath = path.join(WORKFLOWS_DIR, 'do.md');
    const doMdContent = fs.readFileSync(doMdPath, 'utf8');
    const offendingLines = doMdContent
      .split(/\r?\n/)
      .filter((l) => /\/gsd-tools/.test(l));
    assert.deepStrictEqual(
      offendingLines,
      [],
      `workflows/do.md contains the literal "/gsd-tools" substring which the dispatcher-parity ` +
        `scanner (bug-2954) misreads as a slash-command stub. Use \${_GSD_SHIM_NAME} indirection. ` +
        `Offending lines:\n` +
        offendingLines.join('\n'),
    );
  });
});

// ─── Issue #381: standalone gsd_run executable + CLAUDE_ENV_FILE persistence ──
describe('runtime-launcher-parity — standalone executable (#381)', () => {
  const BIN_DIR = path.join(__dirname, '..', 'gsd-core', 'bin');
  const GSD_RUN_SRC = path.join(BIN_DIR, 'gsd_run');

  // ─── (I) gsd_run executable delegates to gsd-tools.cjs beside it ──────────
  test('(I) gsd_run executable delegates to gsd-tools.cjs beside it', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-381-I-'));
    try {
      const binDir = path.join(base, 'gsd-core', 'bin');
      fs.mkdirSync(binDir, { recursive: true });

      // Copy the real gsd_run executable into the temp bin dir
      fs.copyFileSync(GSD_RUN_SRC, path.join(binDir, 'gsd_run'));
      fs.chmodSync(path.join(binDir, 'gsd_run'), 0o755);

      // Write a stub gsd-tools.cjs that echoes its args
      fs.writeFileSync(
        path.join(binDir, 'gsd-tools.cjs'),
        `console.log('GSD_TOOLS_STUB:' + process.argv.slice(2).join(' '))`,
      );

      const gsdRunPath = path.join(binDir, 'gsd_run');
      const r = runHookSeam(gsdRunPath, ['query', 'x'], { interpreter: 'sh' });
      throwIfFailed(r, `sh ${gsdRunPath} query x`);
      const stdout = r.stdout;
      assert.ok(
        stdout.includes('GSD_TOOLS_STUB:query x'),
        `Expected stdout to contain "GSD_TOOLS_STUB:query x", got: ${stdout.trim()}`,
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── (J) preamble persists bin dir to CLAUDE_ENV_FILE ─────────────────────
  test('(J) preamble persists bin dir to CLAUDE_ENV_FILE so a fresh shell resolves gsd_run', () => {
    // Use a RUNTIME_DIR whose path contains a SPACE to prove single-quote safety.
    const baseParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-381-J-'));
    const base = path.join(baseParent, 'has space');
    try {
      const binDir = path.join(base, 'gsd-core', 'bin');
      fs.mkdirSync(binDir, { recursive: true });

      // gsd_run stub that prints GSD_RUN_STUB:<args>
      const gsdRunStub = path.join(binDir, 'gsd_run');
      fs.writeFileSync(gsdRunStub, '#!/bin/sh\necho "GSD_RUN_STUB:$*"\n');
      fs.chmodSync(gsdRunStub, 0o755);

      // gsd-tools.cjs stub (must exist for preamble first arm to win)
      fs.writeFileSync(path.join(binDir, 'gsd-tools.cjs'), '// stub');

      const envFile = path.join(baseParent, 'envfile');
      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');

      // Script: just source the preamble with RUNTIME_DIR + CLAUDE_ENV_FILE set
      const preambleScript = path.join(baseParent, 'run-preamble.sh');
      fs.writeFileSync(preambleScript, snippet);

      runBashFile(preambleScript, {
        env: {
          RUNTIME_DIR: base,
          CLAUDE_ENV_FILE: envFile,
          PATH: process.env.PATH,
        },
      });

      // Assert envfile exists and the persisted line is single-quoted
      assert.ok(fs.existsSync(envFile), `Expected CLAUDE_ENV_FILE (${envFile}) to be created after preamble runs`);
      const envFileContent = fs.readFileSync(envFile, 'utf8');
      // The persisted line must single-quote the directory (neutralising $, spaces, etc.)
      // and keep "$PATH" expanding at source time.
      // Expected form: export PATH='<dir>':"$PATH"
      assert.ok(
        envFileContent.includes("export PATH='"),
        `Expected envfile to contain single-quoted export PATH line, got: ${envFileContent.trim()}`,
      );
      assert.ok(
        envFileContent.includes('has space/gsd-core/bin'),
        `Expected envfile to contain the spaced bin dir, got: ${envFileContent.trim()}`,
      );
      assert.ok(
        envFileContent.includes(':"$PATH"'),
        `Expected envfile to contain :"$PATH" (double-quoted, expands at source time), got: ${envFileContent.trim()}`,
      );

      // Windows Git Bash (msys2) does not honor Node's chmod exec bit for PATH-executing
      // extension-less scripts; the env-file persistence above is the cross-platform proof.
      // Global installs on Windows are covered by npm's generated bin shim.
      if (process.platform !== 'win32') {
        // Simulate a LATER fresh block that SOURCES the env file to get gsd_run on PATH.
        // The later shell does NOT have the bin dir on PATH beforehand — it only gets it
        // by sourcing the env file.  We use a minimal PATH (no temp bin dir pre-injected).
        const inlineResult = runHookSeam('-c', ['. "$CLAUDE_ENV_FILE"; gsd_run hello'], {
          interpreter: 'bash',
          env: {
            CLAUDE_ENV_FILE: envFile,
            PATH: process.env.PATH,
          },
        });
        throwIfFailed(inlineResult, 'bash -c <source env file; gsd_run hello>');
        const stdout = inlineResult.stdout;
        assert.ok(
          stdout.includes('GSD_RUN_STUB:hello'),
          `Expected stdout to contain "GSD_RUN_STUB:hello" after sourcing env file, got: ${stdout.trim()}`,
        );
      }
    } finally {
      cleanup(baseParent);
    }
  });
});

// ─── Agent parity — runtime-launcher-parity — agents (#1041) ─────────────────
describe('runtime-launcher-parity — agents (#1041)', () => {
  // ─── (B-agents) Exactly ONE canonical preamble per using agent file ────────
  test('(B-agents) each agent .md using gsd_run contains exactly ONE canonical preamble, before the first gsd_run call', () => {
    const preamble = expectedPreamble();
    const preambleStr = preamble.join('\n');
    const files = collectAgentFiles();
    assert.ok(files.length > 0, 'expected at least one agent .md file');

    const violations = [];

    for (const f of files) {
      const rel = path.relative(AGENTS_DIR, f);
      const content = fs.readFileSync(f, 'utf8');
      const blocks = extractShellBlocks(content);

      // Collect all block lines in document order for flat analysis
      const allBlockLines = [];
      for (const blk of blocks) {
        allBlockLines.push(...blk.lines);
      }

      // Does this file use gsd_run at all?
      const fileHasGsdRun = allBlockLines.some((l) => /\bgsd_run\b/.test(l));
      if (!fileHasGsdRun) continue; // agents without gsd_run are not checked

      // Count preamble occurrences across all shell content of this file
      const allContent = allBlockLines.join('\n');
      let preambleCount = 0;
      let searchPos = 0;
      while (true) {
        const idx = allContent.indexOf(preambleStr, searchPos);
        if (idx === -1) break;
        preambleCount++;
        searchPos = idx + preambleStr.length;
      }

      if (preambleCount !== 1) {
        violations.push(
          `${rel}: expected exactly 1 canonical preamble occurrence in bash blocks, found ${preambleCount}. ` +
            `Run \`node scripts/sync-runtime-launcher.cjs\` to fix.`,
        );
        continue;
      }

      // Verify preamble appears BEFORE the first gsd_run call (in document order)
      const preamblePos = allContent.indexOf(preambleStr);
      const firstGsdRunPos = allContent.search(/\bgsd_run\b/);

      // The first gsd_run WITHIN the preamble itself (the function definition) is fine.
      // Simple check: preamble starts at or before the first gsd_run occurrence.
      if (preamblePos > firstGsdRunPos) {
        violations.push(
          `${rel}: preamble appears AFTER the first gsd_run reference — it must precede all gsd_run calls.`,
        );
      }
    }

    assert.deepStrictEqual(
      violations,
      [],
      'Agent files with gsd_run calls have wrong preamble count or ordering:\n' +
        violations.join('\n---\n'),
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-211-launcher-home-fallback.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-211-launcher-home-fallback (consolidation epic #1969 B6 #1975)", () => {
'use strict';
/**
 * Regression test for bug #211: gsd_run launcher must probe
 * $HOME/.claude/gsd-core/bin/gsd-tools.cjs before emitting the hard error.
 *
 * Asserts:
 * (A) The canonical snippet file contains the ~/.claude fallback arm.
 * (B) A representative propagated workflow file contains the ~/.claude fallback arm.
 * (C) Behavioral: when RUNTIME_DIR misses and gsd_run is NOT on PATH,
 *     a stub at $HOME/.claude/gsd-core/bin/gsd-tools.cjs is resolved and invoked.
 * (D) The resolution order is preserved: local -> PATH -> ~/.claude -> hard error.
 *     When all three miss, exit non-zero.
 */

// allow-test-rule: structural-regression-guard (see #211)
// structural/behavioral regression for the ~/.claude fallback arm in
// the gsd_run launcher snippet -- asserts literal substring presence and exercises the
// bash resolution path via execFileSync; there is no typed IR for "snippet contains arm X".

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const SNIPPET_FILE = path.join(WORKFLOWS_DIR, '_runtime-launcher.snippet.sh');
// Representative propagated workflow file (has a gsd_run call):
const REPRESENTATIVE_FILE = path.join(WORKFLOWS_DIR, 'add-backlog.md');


const CLAUDE_HOME_PROBE = '.claude/gsd-core/bin/';

describe('bug-211: launcher ~/.claude home fallback', () => {
  // --- (A) Snippet contains the arm ----------------------------------------
  test('(A) snippet file contains the $HOME/.claude fallback arm', () => {
    const content = fs.readFileSync(SNIPPET_FILE, 'utf8');
    assert.ok(
      content.includes(CLAUDE_HOME_PROBE),
      `_runtime-launcher.snippet.sh must contain "${CLAUDE_HOME_PROBE}" (the ~/.claude fallback arm). ` +
        `Found snippet content:\n${content.trim()}`,
    );
  });

  // --- (B) Representative propagated file contains the arm ------------------
  test('(B) add-backlog.md (representative propagated file) contains the $HOME/.claude fallback arm', () => {
    const content = fs.readFileSync(REPRESENTATIVE_FILE, 'utf8');
    assert.ok(
      content.includes(CLAUDE_HOME_PROBE),
      `add-backlog.md must contain "${CLAUDE_HOME_PROBE}" after propagation. ` +
        `Run \`node scripts/sync-runtime-launcher.cjs\` to propagate the updated snippet.`,
    );
  });

  // --- (C) Behavioral: ~/.claude stub is resolved when local and PATH both miss
  test('(C) gsd_run resolves $HOME/.claude/gsd-core/bin/ stub when no local install and gsd_run not on PATH', (t) => {
    // Build a fake $HOME with a stub at .claude/gsd-core/bin/gsd-tools.cjs
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-211-home-'));
    // RUNTIME_DIR points to a directory with no gsd-tools.cjs
    const fakeRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-211-rt-'));
    try {
      const claudeBinDir = path.join(fakeHome, '.claude', 'gsd-core', 'bin');
      fs.mkdirSync(claudeBinDir, { recursive: true });

      // Stub gsd-tools.cjs that prints a marker
      const stubPath = path.join(claudeBinDir, 'gsd-tools.cjs');
      fs.writeFileSync(
        stubPath,
        '#!/usr/bin/env node\nconsole.log("CLAUDE_HOME_STUB:" + process.argv.slice(2).join(","));\n',
      );
      fs.chmodSync(stubPath, 0o755);

      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      const scriptContent =
        `unset GSD_TOOLS\n` +
        `export RUNTIME_DIR=${JSON.stringify(fakeRuntime)}\n` +
        `export HOME=${JSON.stringify(fakeHome)}\n` +
        snippet +
        `\nprintf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"\n` +
        `gsd_run ping test\n`;

      const scriptPath = path.join(fakeRuntime, 'test-home-fb.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      // A PATH with no resolvable gsd_run, to force the ~/.claude arm. The
      // helper also supplies node, which the stub's #!/usr/bin/env node needs.
      const { isolatedPath, nodeBinDir } = buildIsolatedPath();
      t.after(() => cleanup(nodeBinDir));

      const stdout = runBashFile(scriptPath, {
        // Ambient CLAUDE_CONFIG_DIR would override the $HOME/.claude default
        // this test relies on (#4205 class: env-leak, not PATH-leak).
        env: { PATH: isolatedPath, HOME: fakeHome },
      });

      // GSD_TOOLS must point into the fake ~/.claude dir
      const normStdout = stdout.replace(/\\/g, '/');
      assert.ok(
        normStdout.includes('.claude/gsd-core/bin/'),
        `Expected GSD_TOOLS to resolve into .claude/gsd-core/bin/, got:\n${stdout.trim()}`,
      );
      // The stub must have been invoked
      assert.ok(
        stdout.includes('CLAUDE_HOME_STUB:ping,test'),
        `Expected stub output "CLAUDE_HOME_STUB:ping,test", got:\n${stdout.trim()}`,
      );
    } finally {
      cleanup(fakeHome);
      cleanup(fakeRuntime);
    }
  });

  // --- (D) All three miss -> hard error -------------------------------------
  test('(D) hard error when local, PATH, and ~/.claude all miss', (t) => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-211-nohome-'));
    const fakeRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-211-nort-'));
    // noToolsBin so PATH check finds nothing
    const noToolsBin = path.join(fakeHome, 'nobin');
    fs.mkdirSync(noToolsBin, { recursive: true });
    // NO .claude/gsd-core/bin stub created in fakeHome
    try {
      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      const scriptContent =
        `unset GSD_TOOLS\n` +
        `export RUNTIME_DIR=${JSON.stringify(fakeRuntime)}\n` +
        `export HOME=${JSON.stringify(fakeHome)}\n` +
        snippet +
        `\ngsd_run ping test\n`;

      const scriptPath = path.join(fakeRuntime, 'test-allfail.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      const isolated = buildIsolatedPath();
      t.after(() => cleanup(isolated.nodeBinDir));
      const isolatedPath = [noToolsBin, isolated.isolatedPath].join(path.delimiter);

      const r = runHookSeam(scriptPath, [], {
        interpreter: 'bash',
        // "All three miss" requires every runtime-home arm to genuinely miss,
        // not just the first (#4205 class: an ambient config-dir var pointing
        // at a real install would resolve here instead of the hard error).
        env: snippetEnv({ PATH: isolatedPath, HOME: fakeHome }),
      });
      const threw = r.exitCode !== 0;
      const stderrOutput = r.stderr || '';

      assert.ok(threw, 'Expected non-zero exit when all three resolution arms miss');
      // Match the launcher's own diagnostic, not a bare "not found": when node
      // itself is missing from the isolated PATH, bash's own
      // `bash: node: command not found` satisfies the loose form and a
      // regressed guard passes.
      assert.ok(
        stderrOutput.includes('ERROR: gsd-tools.cjs not found'),
        `Expected stderr to contain "ERROR: gsd-tools.cjs not found", got: ${stderrOutput.trim()}`,
      );
    } finally {
      cleanup(fakeHome);
      cleanup(fakeRuntime);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-891-non-claude-runtime-home-fallback.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-891-non-claude-runtime-home-fallback (consolidation epic #1969 B6 #1975)", () => {
'use strict';
/**
 * Regression test for bug #891: gsd_run launcher must probe non-Claude
 * runtime homes before emitting the hard error.
 *
 * The last-resort $HOME/.claude/gsd-core branch is Claude Code-specific.
 * Every non-Claude runtime (Hermes, Cursor, Codex, Copilot, Windsurf, …)
 * installs gsd-core into a *different* directory that the shim never tried,
 * causing a false-positive fatal ERROR on all non-Claude runtimes when
 * RUNTIME_DIR is not set and gsd_run is not on PATH.
 *
 * Asserts:
 * (A) Snippet contains all expected non-Claude runtime home probes (structural).
 * (B0) buildIsolatedPath() co-location invariant (see below).
 * (B) HERMES_HOME behavioral: when RUNTIME_DIR misses and gsd_run is NOT on
 *     PATH, the stub at ${HERMES_HOME}/gsd-core/bin/gsd-tools.cjs is invoked.
 *     It plants a leaked gsd_run on PATH first (#4205), on every platform,
 *     which is what makes it fail on a clean machine as well as a leaking one.
 * (C) Default Hermes path behavioral: stub at $HOME/.hermes/gsd-core/bin/
 *     gsd-tools.cjs is invoked when HERMES_HOME is not set.
 * (D) Resolution order: non-Claude homes are probed BEFORE the hard error,
 *     and AFTER the $HOME/.claude branch.
 * (E) Propagation: all workflow .md files using gsd_run contain each probe
 *     (sync-runtime-launcher.cjs was re-run after editing the snippet).
 */

// allow-test-rule: structural-regression-guard (see #891)
// structural/behavioral regression for non-Claude runtime-home
// fallback arms in the gsd_run launcher snippet -- asserts literal substring
// presence for each runtime-home probe and exercises the bash resolution paths
// via execFileSync; there is no typed IR for "snippet contains arm X".

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const SNIPPET_FILE = path.join(WORKFLOWS_DIR, '_runtime-launcher.snippet.sh');


// Every non-Claude runtime home probe the snippet must contain.
// Key: runtime name (for diagnostics). Value: the substring that must appear
// in the snippet (the env-var-with-default expansion that probes that runtime's
// gsd-core install location). Mirrors src/runtime-homes.cts getGlobalConfigDir().
const EXPECTED_RUNTIME_PROBES = {
  hermes:      '.hermes}/gsd-core/bin/',
  cursor:      '.cursor}/gsd-core/bin/',
  codex:       '.codex}/gsd-core/bin/',
  gemini:      '.gemini}/gsd-core/bin/',
  copilot:     '.copilot}/gsd-core/bin/',
  windsurf:    '.codeium/windsurf}/gsd-core/bin/',
  augment:     '.augment}/gsd-core/bin/',
  trae:        '.trae}/gsd-core/bin/',
  qwen:        '.qwen}/gsd-core/bin/',
  codebuddy:   '.codebuddy}/gsd-core/bin/',
  cline:       '.cline}/gsd-core/bin/',
  grok:        '.agents}/gsd-core/bin/',
  antigravity: '.gemini/antigravity}/gsd-core/bin/',
  opencode:    'opencode}/gsd-core/bin/',
  kilo:        'kilo}/gsd-core/bin/',
};

/**
 * Collect all workflow .md files recursively.
 */
function collectWorkflowFiles() {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  }
  walk(WORKFLOWS_DIR);
  return results;
}

/**
 * Extract all bash/sh/shell fenced blocks from markdown content.
 */
function extractShellBlocks(content) {
  const allLines = content.split('\n');
  const blocks = [];
  let inBlock = false;
  let blockLang = null;
  let blockLines = [];
  let blockIndent = '';
  let closingPattern = null;

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (!inBlock) {
      const fenceOpen = line.match(/^(\s*)```(\w+)?\s*$/);
      if (fenceOpen) {
        inBlock = true;
        blockIndent = fenceOpen[1];
        blockLang = (fenceOpen[2] || '').toLowerCase();
        blockLines = [];
        closingPattern = new RegExp('^' + escapeRegex(blockIndent) + '```\\s*$');
        continue;
      }
    } else {
      if (closingPattern.test(line)) {
        if (['bash', 'sh', 'shell', 'zsh', ''].includes(blockLang)) {
          blocks.push({ lines: blockLines });
        }
        inBlock = false;
        blockLang = null;
        blockLines = [];
        blockIndent = '';
        closingPattern = null;
        continue;
      }
      blockLines.push(line);
    }
  }
  return blocks;
}


describe('bug-891: non-Claude runtime home fallback arms', () => {

  // ── (A) Structural: snippet contains all expected non-Claude probes ───────
  test('(A) snippet contains all non-Claude runtime home probes', () => {
    const snippetContent = fs.readFileSync(SNIPPET_FILE, 'utf8');

    const missing = [];
    for (const [runtime, probe] of Object.entries(EXPECTED_RUNTIME_PROBES)) {
      if (!snippetContent.includes(probe)) {
        missing.push(`${runtime}: expected snippet to contain "${probe}"`);
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `_runtime-launcher.snippet.sh is missing fallback probes for non-Claude runtimes:\n` +
        missing.join('\n') +
        `\n\nAdd elif arms for each runtime home (e.g. "\${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/...")` +
        ` before the hard-error else. Current snippet:\n${snippetContent.trim()}`,
    );
  });

  // ── (A2) Structural: probes appear AFTER .claude arm but BEFORE hard error ─
  test('(A2) non-Claude probes appear after .claude/gsd-core arm and before hard error', () => {
    const snippetContent = fs.readFileSync(SNIPPET_FILE, 'utf8');
    const claudePos = snippetContent.indexOf('.claude/gsd-core/bin/');
    const errorPos  = snippetContent.indexOf('exit 1');

    assert.ok(claudePos !== -1, 'Snippet must still contain .claude/gsd-core/bin/ arm (regression guard)');
    assert.ok(errorPos  !== -1, 'Snippet must contain exit 1 (hard-error guard)');

    for (const [runtime, probe] of Object.entries(EXPECTED_RUNTIME_PROBES)) {
      const probePos = snippetContent.indexOf(probe);
      assert.ok(
        probePos !== -1,
        `Snippet must contain probe for ${runtime} ("${probe}")`,
      );
      assert.ok(
        probePos < errorPos,
        `${runtime} probe must appear before "exit 1" in snippet (found at ${probePos}, exit 1 at ${errorPos})`,
      );
    }
  });

  // ── (B0) Regression: buildIsolatedPath keeps node resolvable when node and ──
  //        gsd_run co-locate in the same PATH directory.                       ─
  //
  // Machine-independence guarantee: the filtered PATH is ONLY two controlled
  // dirs — fakeBinDir (holds both fake gsd_run AND node) plus a fresh empty dir
  // (no executables at all). The real system PATH is NOT appended.
  //
  // Filtering fakeBinDir out is correct and unavoidable, so the only thing that
  // keeps node reachable is the nodeBinDir buildIsolatedPath() prepends. This
  // test is that prepend's guard: make it conditional again — as it was on
  // Windows, where the helper returned `nodeBinDir: null` — and (ii) goes red.
  test(
    '(B0) buildIsolatedPath invariants: node survives, every reachable gsd_run name and every relative dir does not',
    (t) => {
      // Build a fake bin dir that contains BOTH a gsd_run executable and node,
      // simulating a dev setup (fnm/nvm/Homebrew) where both land in the same
      // bin directory.
      const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-colocated-'));
      // A second fresh empty dir — contains neither gsd_run nor node.
      const emptyDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-empty-'));
      t.after(() => cleanup(fakeBinDir));
      t.after(() => cleanup(emptyDir));

      // gsd_run co-located with node — the fnm/nvm/Homebrew layout, and the
      // Windows global-install layout the same helper has to survive. Both are
      // probed, never run.
      plantExecutable(fakeBinDir, 'gsd_run');
      plantExecutable(fakeBinDir, NODE_BIN);

      // Filter ONLY the two controlled dirs (no real system dirs). This makes
      // the test machine-independent: on any machine, the only place node
      // *could* come from before the fix is fakeBinDir — which gets filtered.
      const result = buildIsolatedPath(fakeBinDir + path.delimiter + emptyDir);
      t.after(() => cleanup(result.nodeBinDir));

      const returnedDirs = result.isolatedPath.split(path.delimiter);

      // (i) gsd_run must NOT be resolvable on the returned PATH
      const gsdRunResolvable = returnedDirs.some(hasGsdRun);
      assert.equal(
        gsdRunResolvable,
        false,
        'gsd_run must not be resolvable on the isolated PATH (home-fallback would be bypassed)',
      );

      // (ii) node must BE resolvable on the returned PATH (the new nodeBinDir makes it so)
      const nodeResolvable = returnedDirs.some((dir) => {
        try { fs.accessSync(path.join(dir, NODE_BIN), fs.constants.X_OK); return true; }
        catch { return false; }
      });
      assert.equal(
        nodeResolvable,
        true,
        'node must be resolvable on the isolated PATH (launcher runs: node "$GSD_TOOLS" "$@")',
      );

      // (iii) every name the launcher's PATH arm can resolve must be filtered,
      // not just the extensionless one — a gsd_run.exe-only directory is the
      // reachable Windows leak an extensionless probe misses (#4344). The list
      // is written out rather than taken from GSD_RUN_NAMES: sweeping the
      // constant under test with itself cannot catch that constant being wrong.
      const reachableNames = process.platform === 'win32'
        ? ['gsd_run', 'gsd_run.exe']
        : ['gsd_run'];
      const survived = reachableNames.filter((name) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-ext-'));
        t.after(() => cleanup(dir));
        plantExecutable(dir, name);
        const probe = buildIsolatedPath(dir);
        t.after(() => cleanup(probe.nodeBinDir));
        return probe.isolatedPath.split(path.delimiter).includes(dir);
      });
      assert.deepStrictEqual(
        survived,
        [],
        'every name bash can resolve for a bare gsd_run must be filtered out of the isolated PATH',
      );

      // (iv) every surviving element is absolute. A shell resolves an empty
      // element, `.`, or any relative entry against the *child's* working
      // directory, so each one is a way to put a cwd gsd_run back on PATH —
      // and hasGsdRun cannot see any of them, because it probes relative to the
      // runner's cwd instead. Four ways one arrives: an ambient `::`, an
      // explicit `.`, a relative entry, and a PATH every entry of which was
      // filtered (which used to leave a trailing delimiter, meaning the same
      // thing).
      // Each case names the dirs that must survive, so the assertion has an
      // oracle of its own rather than re-running the implementation's filter.
      const relativeElementCases = {
        emptyElement: [`${emptyDir}${path.delimiter}${path.delimiter}${emptyDir}`, [emptyDir, emptyDir]],
        dotElement: [`${emptyDir}${path.delimiter}.${path.delimiter}${emptyDir}`, [emptyDir, emptyDir]],
        relativeElement: [`${emptyDir}${path.delimiter}sub/dir`, [emptyDir]],
        fullyFiltered: [fakeBinDir, []],
      };
      for (const [label, [basePath, expected]] of Object.entries(relativeElementCases)) {
        const probe = buildIsolatedPath(basePath);
        t.after(() => cleanup(probe.nodeBinDir));
        assert.deepStrictEqual(
          probe.isolatedPath.split(path.delimiter),
          [probe.nodeBinDir, ...expected],
          `${label}: only absolute, gsd_run-free dirs may survive (a relative one resolves the child's cwd), got: ${probe.isolatedPath}`,
        );
      }
    },
  );


  // ── (B) Behavioral: HERMES_HOME stub is resolved, even past a leaked PATH ──
  //
  // #4205 regression, and the reason this asserts the sentinel rather than just
  // the stub: on a CLEAN machine the bare HERMES_HOME assertion passes whether
  // buildIsolatedPath() filters gsd_run or gsd-tools, so it only catches the bug
  // on a machine that already has the leak. Planting the sentinel makes it fail
  // on any machine, and on either platform: the sentinel is planted in the one
  // form that platform's shell resolves — the extensionless shim npm installs
  // on POSIX, `gsd_run.exe` alone on Windows (see below for why alone). Note
  // that only the POSIX sentinel can print SENTINEL_INVOKED; on Windows the
  // basename assertion is what carries the guarantee (#4344).
  test('(B) buildIsolatedPath strips a leaked PATH gsd_run; the ${HERMES_HOME} stub wins', (t) => {
    const fakeHome       = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-home-b-'));
    const fakeHermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-hermes-'));
    const fakeRuntime    = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-rt-'));
    t.after(() => cleanup(fakeHome));
    t.after(() => cleanup(fakeHermesHome));
    t.after(() => cleanup(fakeRuntime));

    const sentinelBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4205-sentinel-'));
    t.after(() => cleanup(sentinelBinDir));
    if (process.platform === 'win32') {
      // What msys bash resolves for a bare `gsd_run`: it appends `.exe` during
      // PATH lookup. Planted ALONE, so the leak this fixture proves is the
      // extension-only one — an extensionless sibling would let an
      // extension-blind filter strip the directory for the wrong reason and
      // pass. It cannot print SENTINEL_INVOKED (it is this interpreter under
      // another name), which is what the GSD_TOOLS assertion below is for.
      linkExecutable(sentinelBinDir, 'gsd_run.exe');
    } else {
      const sentinelPath = path.join(sentinelBinDir, 'gsd_run');
      fs.writeFileSync(sentinelPath, '#!/bin/sh\necho "SENTINEL_INVOKED:$*"\n');
      fs.chmodSync(sentinelPath, 0o755);
    }

    // Simulate the reported leak: a real gsd_run reachable on PATH. Passed in
    // rather than assigned to process.env.PATH — the runner's own environment
    // stays untouched, so no other fixture can observe the leak.
    const { isolatedPath, nodeBinDir } = buildIsolatedPath(
      `${sentinelBinDir}${path.delimiter}${process.env.PATH}`,
    );
    t.after(() => cleanup(nodeBinDir));

    // Leak assertion that needs no subprocess: a filter probing the wrong name
    // leaves sentinelBinDir on the isolated PATH. Deterministic on both
    // platforms, so it stays red even where the stdout assertions below depend
    // on the mount's exec heuristics rather than on the filter under test.
    assert.ok(
      !isolatedPath.split(path.delimiter).includes(sentinelBinDir),
      `Expected buildIsolatedPath to strip the leaked ${sentinelBinDir}, got:\n${isolatedPath}`,
    );

    const hermesBinDir = path.join(fakeHermesHome, 'gsd-core', 'bin');
    fs.mkdirSync(hermesBinDir, { recursive: true });

    const stubPath = path.join(hermesBinDir, 'gsd-tools.cjs');
    fs.writeFileSync(
      stubPath,
      '#!/usr/bin/env node\nconsole.log("HERMES_HOME_STUB:" + process.argv.slice(2).join(","));\n',
    );
    fs.chmodSync(stubPath, 0o755);

    const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
    // HOME points at an isolated temp dir with no .claude install, so the
    // $HOME/.claude arm misses and the HERMES_HOME arm is the one under test.
    const scriptContent =
      `unset GSD_TOOLS\n` +
      `export HOME=${JSON.stringify(fakeHome)}\n` +
      `export RUNTIME_DIR=${JSON.stringify(fakeRuntime)}\n` +
      `export HERMES_HOME=${JSON.stringify(fakeHermesHome)}\n` +
      snippet +
      `\nprintf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"\n` +
      `gsd_run ping test\n`;

    const scriptPath = path.join(fakeRuntime, 'test-hermes-home.sh');
    fs.writeFileSync(scriptPath, scriptContent);

    const stdout = runBashFile(scriptPath, {
      env: { PATH: isolatedPath, HOME: fakeHome, HERMES_HOME: fakeHermesHome },
    });

    const normStdout = stdout.replace(/\\/g, '/');
    assert.ok(
      !normStdout.includes('SENTINEL_INVOKED'),
      `Expected the leaked PATH gsd_run to never be invoked, got:\n${stdout.trim()}`,
    );
    // The same claim without depending on the sentinel producing output:
    // whatever the resolver picked, it did not come from the leaked directory.
    // Matched by basename, not by absolute path — git-bash prints `/c/Users/…`
    // where os.tmpdir() gives `C:\Users\…` (see the note above the (E) PATH
    // fallback assertion), so an absolute-path comparison never matches on
    // Windows and would assert nothing there. The mkdtemp suffix keeps the
    // basename unique.
    assert.ok(
      !normStdout.includes(path.basename(sentinelBinDir)),
      `Expected GSD_TOOLS to resolve outside the leaked ${sentinelBinDir}, got:\n${stdout.trim()}`,
    );
    // Assert the hermes dir itself: every arm of the resolver ends in
    // gsd-core/bin/, so that substring alone cannot tell them apart.
    assert.ok(
      normStdout.includes(fakeHermesHome.replace(/\\/g, '/')),
      `Expected GSD_TOOLS to resolve into ${fakeHermesHome}, got:\n${stdout.trim()}`,
    );
    assert.ok(
      normStdout.includes('HERMES_HOME_STUB:ping,test'),
      `Expected stub output "HERMES_HOME_STUB:ping,test", got:\n${stdout.trim()}`,
    );
  });

  // ── (C) Behavioral: default .hermes path used when HERMES_HOME not set ────
  test('(C) gsd_run resolves $HOME/.hermes/gsd-core/bin/ stub when HERMES_HOME is unset', () => {
    const fakeHome    = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-home-'));
    const fakeRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-rt2-'));
    const { isolatedPath, nodeBinDir } = buildIsolatedPath();
    try {
      const hermesBinDir = path.join(fakeHome, '.hermes', 'gsd-core', 'bin');
      fs.mkdirSync(hermesBinDir, { recursive: true });

      const stubPath = path.join(hermesBinDir, 'gsd-tools.cjs');
      fs.writeFileSync(
        stubPath,
        '#!/usr/bin/env node\nconsole.log("HERMES_DEFAULT_STUB:" + process.argv.slice(2).join(","));\n',
      );
      fs.chmodSync(stubPath, 0o755);

      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      const scriptContent =
        `unset GSD_TOOLS HERMES_HOME\n` +
        `export RUNTIME_DIR=${JSON.stringify(fakeRuntime)}\n` +
        `export HOME=${JSON.stringify(fakeHome)}\n` +
        snippet +
        `\nprintf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"\n` +
        `gsd_run status\n`;

      const scriptPath = path.join(fakeRuntime, 'test-hermes-default.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      const stdout = runBashFile(scriptPath, {
        // CLAUDE_CONFIG_DIR resolves before the HERMES_HOME arm under test
        // (#4205 class, env vector); script-level `unset HERMES_HOME` above
        // already handles that var, and snippetEnv()'s derived TEST_ENV_BASE
        // clears CLAUDE_CONFIG_DIR before bash ever sees it.
        env: { PATH: isolatedPath, HOME: fakeHome },
      });

      const normStdout = stdout.replace(/\\/g, '/');
      assert.ok(
        normStdout.includes('.hermes/gsd-core/bin/'),
        `Expected GSD_TOOLS to resolve into .hermes/gsd-core/bin/, got:\n${stdout.trim()}`,
      );
      assert.ok(
        stdout.includes('HERMES_DEFAULT_STUB:status'),
        `Expected stub output "HERMES_DEFAULT_STUB:status", got:\n${stdout.trim()}`,
      );
    } finally {
      cleanup(fakeHome);
      cleanup(fakeRuntime);
      cleanup(nodeBinDir);
    }
  });

  // ── (D) Resolution order: claude < hermes < hard-error ───────────────────
  test('(D) resolution order: .claude probe comes before hermes probe, hermes before hard error', () => {
    const snippetContent = fs.readFileSync(SNIPPET_FILE, 'utf8');
    const claudePos  = snippetContent.indexOf('.claude/gsd-core/bin/');
    const hermesPos  = snippetContent.indexOf('.hermes}/gsd-core/bin/');
    const errorPos   = snippetContent.indexOf('exit 1');

    assert.ok(claudePos  !== -1, 'Snippet must contain .claude/gsd-core/bin/ arm');
    assert.ok(hermesPos  !== -1, 'Snippet must contain .hermes}/gsd-core/bin/ arm');
    assert.ok(errorPos   !== -1, 'Snippet must contain exit 1 hard-error');

    assert.ok(
      claudePos < hermesPos,
      `Expected .claude probe (at ${claudePos}) before .hermes probe (at ${hermesPos})`,
    );
    assert.ok(
      hermesPos < errorPos,
      `Expected .hermes probe (at ${hermesPos}) before exit 1 (at ${errorPos})`,
    );
  });

  // ── (E) Propagation: workflow .md files using gsd_run contain hermes probe ─
  test('(E) all workflow .md files using gsd_run contain the hermes runtime home probe', () => {
    const HERMES_PROBE = '.hermes}/gsd-core/bin/';
    const files = collectWorkflowFiles();
    assert.ok(files.length > 0, 'expected at least one workflow .md file');

    const missing = [];
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      const blocks = extractShellBlocks(content);
      const allBlockLines = blocks.flatMap((b) => b.lines);
      if (delegatesToResolverReference(content)) continue;
      const fileHasGsdRun = allBlockLines.some((l) => /\bgsd_run\b/.test(l));
      if (!fileHasGsdRun) continue;
      const allContent = allBlockLines.join('\n');
      if (!allContent.includes(HERMES_PROBE)) {
        missing.push(path.relative(WORKFLOWS_DIR, f));
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `These workflow files use gsd_run but are missing the hermes runtime home probe ("${HERMES_PROBE}"). ` +
        `Run \`node scripts/sync-runtime-launcher.cjs\` to propagate:\n` +
        missing.join('\n'),
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3668-workflow-runtime-resolution.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3668-workflow-runtime-resolution (consolidation epic #1969 B6 #1975)", () => {
/**
 * Bug #3668: workflow resolver snippets must run from installed user projects.
 *
 * A user project normally does not contain gsd-core/bin/gsd-tools.cjs.
 * The snippets should still prefer RUNTIME_DIR for local/dev installs, then
 * fall back to the installed gsd_run binary on PATH.
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { readFileNormalized } = require('./helpers.cjs');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'next.md');

/**
 * Extract the canonical runtime resolver snippet from next.md.
 *
 * Supports two forms:
 * - One-line form (canonical): the entire launcher is a single line starting with
 *   `_GSD_SHIM_NAME="gsd-tools.cjs";` — return that line directly.
 * - Multi-line form (legacy): starts with a `# Runtime launcher:` comment or a
 *   `_GSD_SHIM_NAME=` line followed by separate GSD_TOOLS= and if/elif/else/fi
 *   lines — scan to the closing `fi`.
 */
function extractResolverSnippet() {
  const content = readFileNormalized(WORKFLOW_PATH);
  const lines = content.split('\n');

  // Find the canonical preamble — prefer _GSD_SHIM_NAME= line (handles both forms)
  let start = lines.findIndex((line) => /^_GSD_SHIM_NAME=/.test(line.trim()));
  if (start === -1) {
    // Fallback: canonical preamble comment (multi-line legacy form)
    start = lines.findIndex((line) =>
      /^\s*#\s*Runtime launcher:.*prefer local gsd-tools\.cjs.*installed gsd-tools on PATH/.test(line)
    );
  }
  if (start === -1) {
    // Last fallback: GSD_TOOLS= with RUNTIME_DIR
    start = lines.findIndex((line) => line.includes('GSD_TOOLS="${RUNTIME_DIR:-'));
  }
  assert.notEqual(
    start,
    -1,
    'next.md must contain the canonical runtime preamble ' +
    '(_GSD_SHIM_NAME= line, # Runtime launcher: comment, or GSD_TOOLS= line with RUNTIME_DIR)'
  );

  // One-line form: the entire launcher (including `if` and `fi`) is on a single line.
  // Detect by checking whether the start line contains a semicolon-separated `if` and `fi`.
  const startLine = lines[start].trim();
  if (/^_GSD_SHIM_NAME=.*;\s*if\s+\[.*\bfi$/.test(startLine)) {
    // Single-line canonical launcher — return it as-is
    return startLine;
  }

  // Multi-line form: scan forward from start to the closing `fi`, tracking if-depth
  let depth = 0;
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^if\s+/.test(t)) depth++;
    if (/^fi(\s|$)/.test(t)) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.notEqual(end, -1, 'runtime preamble must end with a closing `fi`');

  return lines.slice(start, end + 1).join('\n');
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-runtime-resolution-'));
}

function runResolver({ cwd, runtimeDir, pathDir }) {
  // RUNTIME_DIR='' is INDISTINGUISHABLE from unset to the resolver's
  // ${RUNTIME_DIR:-$(git rev-parse --show-toplevel)} — an empty value silently
  // falls back to the real repo root and resolves its real install. Fail loudly
  // instead; every caller passes one.
  if (!runtimeDir) throw new Error('runResolver requires runtimeDir: an empty value resolves the real repo root');
  const script = [
    'set -e',
    extractResolverSnippet(),
    'printf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"',
    'gsd_run query state.json',
  ].join('\n');

  // Consolidation #1969: POSIX-shell resolver. These tests create an
  // extension-less `gsd_run` PATH stub (mode 0o755) and exec it via `bash -c`;
  // Windows Git Bash ignores the exec bit for extension-less PATH scripts, so the
  // suite is guarded to POSIX (matches the host suite's own bash -c guard).
  if (process.platform === 'win32') return '';

  const r = runHookSeam('-c', [script], {
    interpreter: 'bash',
    cwd,
    env: snippetEnv({
      PATH: `${pathDir}${path.delimiter}${process.env.PATH || ''}`,
      RUNTIME_DIR: runtimeDir,
    }),
  });
  throwIfFailed(r, 'bash -c <runtime resolver snippet>');
  return r.stdout;
}

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

describe('bug-3668: workflow SDK resolver supports installed user projects', { skip: process.platform === 'win32' }, () => {
  test('falls back to installed gsd_run when project-local runtime copy is absent', () => {
    // Bug #3668: when a user project has no local gsd-core/bin/gsd-tools.cjs,
    // the elif branch must resolve to the gsd_run binary on PATH.
    // RUNTIME_DIR points to a dir that has no gsd-tools.cjs.
    //
    // #3146: the PATH-fallback target changed from `gsd-tools` to `gsd_run`.
    // The predecessor package `get-shit-done-cc` publishes a colliding
    // `gsd-tools` bin, so the launcher resolves `gsd_run`, which only this
    // package publishes.
    const tmp = makeTempDir();
    const project = path.join(tmp, 'user-project');
    const runtimeNoLocal = path.join(tmp, 'runtime-no-local');
    const pathBin = path.join(tmp, 'bin');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(runtimeNoLocal, { recursive: true });

    // Place gsd_run stub on PATH (installed binary)
    writeExecutable(
      path.join(pathBin, 'gsd_run'),
      '#!/bin/sh\nprintf "installed:%s %s\\n" "$1" "$2"\n',
    );

    // NO gsd-core/bin/gsd-tools.cjs in runtimeNoLocal
    const output = runResolver({ cwd: project, runtimeDir: runtimeNoLocal, pathDir: pathBin });

    // GSD_TOOLS must have been reassigned to the PATH binary (not the missing .cjs)
    assert.match(output, /GSD_TOOLS=.+gsd_run(?:\s|$)/m);
    // The PATH stub must have been invoked
    assert.match(output, /installed:query state\.json/);
  });

  test('preserves RUNTIME_DIR local gsd-tools.cjs preference over PATH fallback', () => {
    // #3146: the PATH-fallback target changed from `gsd-tools` to `gsd_run`
    // (the predecessor package `get-shit-done-cc` publishes a colliding
    // `gsd-tools` bin, so the launcher resolves `gsd_run` instead), but the
    // point of this test is unchanged: a RUNTIME_DIR-local gsd-tools.cjs must
    // win over the PATH stub, and the PATH stub must never be invoked.
    const tmp = makeTempDir();
    const project = path.join(tmp, 'user-project');
    const runtime = path.join(tmp, 'runtime');
    const pathBin = path.join(tmp, 'bin');
    fs.mkdirSync(project, { recursive: true });
    writeExecutable(path.join(pathBin, 'gsd_run'), '#!/bin/sh\nprintf "path-installed:%s %s\\n" "$1" "$2"\n');
    writeExecutable(
      path.join(runtime, 'gsd-core', 'bin', 'gsd-tools.cjs'),
      '#!/usr/bin/env node\nconsole.log(`runtime:${process.argv[2]} ${process.argv[3]}`);\n',
    );

    const output = runResolver({ cwd: project, runtimeDir: runtime, pathDir: pathBin });

    // Normalize separators so the assertion works on Windows (Git bash emits POSIX paths)
    const norm = output.replace(/\\/g, '/');
    // The resolved bin is the RUNTIME_DIR local runtime (suffix /gsd-core/bin/gsd-tools.cjs)
    // Use .+ instead of \S* to handle paths with spaces (e.g. /Volumes/Mini Me/...)
    assert.match(norm, /GSD_TOOLS=.+\/gsd-core\/bin\/gsd-tools\.cjs(?:\s|$)/m);
    assert.match(output, /runtime:query state\.json/);
    assert.doesNotMatch(output, /path-installed:query state\.json/);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-444-resolver-local-claude-install.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-444-resolver-local-claude-install (consolidation epic #1969 B6 #1975)", () => {
'use strict';
/**
 * Regression test for bug #444: gsd_run resolver must probe
 * <repo-root>/.claude/gsd-core/bin/gsd-tools.cjs (the project-local
 * `--claude --local` install location) BEFORE checking $HOME/.claude and PATH.
 *
 * Asserts:
 * (A) The canonical snippet file contains the repo-local .claude/ check.
 * (B) Behavioral: when RUNTIME_DIR/gsd-core/bin/ misses, but a stub
 *     exists ONLY at <repo-root>/.claude/gsd-core/bin/gsd-tools.cjs,
 *     gsd_run resolves to that stub (no PATH stub, no HOME stub).
 * (C) Precedence: repo-local .claude/ wins over $HOME/.claude/ when both exist.
 */

// allow-test-rule: structural-regression-guard (see #444)
// structural/behavioral regression for the repo-local .claude/ install
// arm in the gsd_run launcher snippet -- asserts literal substring presence and exercises
// the bash resolution path via execFileSync; there is no typed IR for "snippet contains arm X".

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const SNIPPET_FILE = path.join(WORKFLOWS_DIR, '_runtime-launcher.snippet.sh');


// The probe string that must appear in the snippet for the new repo-local check.
// The snippet uses _GSD_RUNTIME_ROOT as the intermediate variable.
const LOCAL_CLAUDE_PROBE = '_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/';

// Tests B and C below need no PATH isolation: the RUNTIME_DIR/.claude arm
// they exercise fires before the resolver ever reaches `command -v gsd_run`.
describe('bug-444: resolver finds repo-local .claude install', () => {
  // --- (A) Snippet contains the repo-local .claude arm ----------------------
  test('(A) snippet file contains the repo-local .claude/ check arm before $HOME/.claude/', () => {
    const content = fs.readFileSync(SNIPPET_FILE, 'utf8');

    // Must contain the repo-local .claude/ check (via _GSD_RUNTIME_ROOT variable)
    const localClaudeIdx = content.indexOf(LOCAL_CLAUDE_PROBE);
    assert.ok(
      localClaudeIdx !== -1,
      `_runtime-launcher.snippet.sh must contain the repo-local .claude check ` +
        `('${LOCAL_CLAUDE_PROBE}'). ` +
        `Found snippet content:\n${content.trim()}`,
    );

    // Must still contain the $HOME/.claude fallback arm (#1865: now carried as
    // the ${CLAUDE_CONFIG_DIR:-$HOME/.claude} fallback, so match the stem).
    const homeClaudeIdx = content.indexOf('$HOME/.claude');
    assert.ok(
      homeClaudeIdx !== -1,
      `Snippet must still contain the $HOME/.claude fallback arm.`,
    );

    // #1865: the Claude arm must honor CLAUDE_CONFIG_DIR (the installer writes
    // there when it is set), with $HOME/.claude as the fallback.
    assert.ok(
      content.includes('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/'),
      `Snippet's Claude arm must honor CLAUDE_CONFIG_DIR via \${CLAUDE_CONFIG_DIR:-$HOME/.claude}.`,
    );

    // Repo-local check must appear BEFORE $HOME/.claude check (local overrides global)
    assert.ok(
      localClaudeIdx < homeClaudeIdx,
      `Repo-local .claude/ check (idx ${localClaudeIdx}) must appear BEFORE ` +
        `$HOME/.claude/ check (idx ${homeClaudeIdx}) in the snippet (local overrides global).`,
    );
  });

  // --- (B) Behavioral: repo-local .claude stub resolved when only location ---
  test('(B) gsd_run resolves repo-local .claude/gsd-core/bin/ stub when no other locations present', () => {
    // Create a fake repo root with a stub ONLY at .claude/gsd-core/bin/gsd-tools.cjs
    // NO stub at gsd-core/bin/, NOT on PATH, NOT in $HOME/.claude
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-444-root-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-444-home-'));

    try {
      // Create the stub at the repo-local .claude path ONLY
      const localClaudeBinDir = path.join(fakeRoot, '.claude', 'gsd-core', 'bin');
      fs.mkdirSync(localClaudeBinDir, { recursive: true });
      const stubPath = path.join(localClaudeBinDir, 'gsd-tools.cjs');
      fs.writeFileSync(
        stubPath,
        '#!/usr/bin/env node\nconsole.log("LOCAL_CLAUDE_STUB:" + process.argv.slice(2).join(","));\n',
      );
      fs.chmodSync(stubPath, 0o755);

      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      // Set RUNTIME_DIR to fakeRoot so the resolver uses it as the repo root.
      const scriptContent =
        `unset GSD_TOOLS\n` +
        `export RUNTIME_DIR=${JSON.stringify(fakeRoot)}\n` +
        `export HOME=${JSON.stringify(fakeHome)}\n` +
        snippet +
        `\nprintf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"\n` +
        `gsd_run ping test\n`;

      const scriptPath = path.join(fakeRoot, 'test-local-claude.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      const stdout = runBashFile(scriptPath, {
        env: { HOME: fakeHome },
      });

      // Must have resolved to the local .claude stub
      const normStdout = stdout.replace(/\\/g, '/');
      assert.ok(
        normStdout.includes('.claude/gsd-core/bin/gsd-tools.cjs'),
        `Expected GSD_TOOLS to resolve to .claude/gsd-core/bin/gsd-tools.cjs, got:\n${stdout.trim()}`,
      );
      // The stub must have been invoked with the correct arguments
      assert.ok(
        stdout.includes('LOCAL_CLAUDE_STUB:ping,test'),
        `Expected stub output "LOCAL_CLAUDE_STUB:ping,test" but got:\n${stdout.trim()}`,
      );
    } finally {
      cleanup(fakeRoot);
      cleanup(fakeHome);
    }
  });

  // --- (C) Precedence: repo-local .claude/ wins over $HOME/.claude/ ----------
  test('(C) repo-local .claude/ install wins over $HOME/.claude/ when both exist', () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-444-prec-root-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-444-prec-home-'));

    try {
      // Stub at repo-local .claude/ path (should be picked)
      const localClaudeBinDir = path.join(fakeRoot, '.claude', 'gsd-core', 'bin');
      fs.mkdirSync(localClaudeBinDir, { recursive: true });
      const localStubPath = path.join(localClaudeBinDir, 'gsd-tools.cjs');
      fs.writeFileSync(
        localStubPath,
        '#!/usr/bin/env node\nconsole.log("LOCAL_WINS:" + process.argv.slice(2).join(","));\n',
      );
      fs.chmodSync(localStubPath, 0o755);

      // Stub at $HOME/.claude/ path (must NOT be picked)
      const homeClaudeBinDir = path.join(fakeHome, '.claude', 'gsd-core', 'bin');
      fs.mkdirSync(homeClaudeBinDir, { recursive: true });
      const homeStubPath = path.join(homeClaudeBinDir, 'gsd-tools.cjs');
      fs.writeFileSync(
        homeStubPath,
        '#!/usr/bin/env node\nconsole.log("HOME_WINS:" + process.argv.slice(2).join(","));\n',
      );
      fs.chmodSync(homeStubPath, 0o755);

      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      const scriptContent =
        `unset GSD_TOOLS\n` +
        `export RUNTIME_DIR=${JSON.stringify(fakeRoot)}\n` +
        `export HOME=${JSON.stringify(fakeHome)}\n` +
        snippet +
        `\nprintf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"\n` +
        `gsd_run check\n`;

      const scriptPath = path.join(fakeRoot, 'test-precedence.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      const stdout = runBashFile(scriptPath, {
        env: { HOME: fakeHome },
      });

      assert.ok(
        stdout.includes('LOCAL_WINS:check'),
        `Expected repo-local .claude stub to be invoked ("LOCAL_WINS:check") ` +
          `but got:\n${stdout.trim()}`,
      );
      assert.ok(
        !stdout.includes('HOME_WINS'),
        `Expected $HOME/.claude stub NOT to be invoked, but got:\n${stdout.trim()}`,
      );
    } finally {
      cleanup(fakeRoot);
      cleanup(fakeHome);
    }
  });
});
  });
}

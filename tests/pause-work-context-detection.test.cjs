'use strict';

/**
 * pause-work-context-detection.test.cjs — regression coverage for #4112.
 *
 * gsd-core/workflows/pause-work.md's "Context Detection" step opens its
 * phase/spike/sketch assignments with `$((`. That is genuinely ambiguous in
 * POSIX-family shell grammar between arithmetic expansion and a command
 * substitution wrapping a subshell. bash and zsh silently fall back to the
 * command-substitution reading when the arithmetic parse fails (undocumented
 * but real — verified empirically), so this construct does NOT throw under
 * bash/zsh. It DOES throw a hard "Syntax error: Missing '))'" under POSIX
 * `sh` (dash), which does not implement that fallback and is the default
 * `/bin/sh` on Debian/Ubuntu (including the CI/bench hosts this repo tests
 * on, and a common default shell for `child_process.exec()`-style spawns
 * with no explicit `shell:` override).
 *
 * An earlier version of this test asserted `bash -n` syntax validity and
 * wrapped a plain `bash -c` execution in assert.doesNotThrow(). Both were
 * wrong: `bash -n` never evaluates arithmetic-context content at parse time,
 * and bash's runtime fallback means a bare `bash -c` execution never throws
 * either. That version passed a full `gsd-test` run (41594/41594, 0
 * failures) against the UNFIXED file — a false green. This version fixes
 * that by asserting on the real, verified failure mode: execution under
 * `dash`/`sh`.
 *
 * A code review of an intermediate version also found that falling back
 * from `dash` to plain `sh` without verifying discrimination could silently
 * produce a non-discriminating test on a host where `/bin/sh` is
 * bash-compatible (macOS, for example) — `resolvePosixShell` below verifies
 * each shell candidate actually rejects a known-ambiguous `$((` snippet
 * before trusting it, rather than assuming that from the binary name.
 *
 * These tests execute the real fenced bash block extracted from the shipped
 * workflow file against real temp-directory filesystem states — not a mock,
 * not a source-text grep of the fix. Extracting the fence line-by-line (not
 * a single fence-spanning regex — matches this repo's established
 * extraction idiom, e.g. tests/no-hardcoded-home-gsd-tools.test.cjs) reads
 * workflow markdown, not source code; `local/no-source-grep` targets
 * readFileSync of .cjs/.cts/.js/.mjs/.mts/.ts SOURCE files, which this is
 * not. All subprocess calls route through tests/helpers/process-seam.cjs
 * (bounded by construction, never a hand-rolled execFileSync/spawnSync);
 * temp-directory removal goes through tests/helpers.cjs's `cleanup()`.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'pause-work.md');

/**
 * Extract the fenced ```bash block that immediately follows the given
 * heading, scanning line-by-line rather than matching a single
 * fence-spanning regex (the shape `local/no-adhoc-markdown-parsing` flags).
 */
function extractBashBlockAfterHeading(markdown, heading) {
  const headingIdx = markdown.indexOf(heading);
  assert.ok(headingIdx !== -1, `heading "${heading}" not found in ${WORKFLOW_PATH}`);
  const lines = splitLines(markdown.slice(headingIdx));
  const blockLines = [];
  let inBash = false;
  for (const line of lines) {
    if (!inBash) {
      if (/^```bash\s*$/.test(line)) inBash = true;
    } else if (/^```\s*$/.test(line)) {
      break;
    } else {
      blockLines.push(line);
    }
  }
  assert.ok(blockLines.length > 0, `no \`\`\`bash fence found after heading "${heading}"`);
  return `${blockLines.join('\n')}\n`;
}

const KNOWN_AMBIGUOUS_ARITHMETIC_SNIPPET =
  'x=$(( ls -lt /tmp 2>/dev/null || true ) | head -1 || true)';

/** True if `shell` is present and spawnable at all (independent of exit code). */
function shellIsUsable(shell) {
  const result = runHook('-c', ['true'], { interpreter: shell });
  return result.outcome === OUTCOME.EXITED;
}

/**
 * True if `shell` rejects the known-ambiguous `$((` construct above (i.e. it
 * does NOT implement bash's permissive arithmetic-expansion-or-subshell
 * fallback, so it can actually tell broken from fixed for this bug).
 */
function shellRejectsAmbiguousArithmetic(shell) {
  const result = runHook('-c', [KNOWN_AMBIGUOUS_ARITHMETIC_SNIPPET], { interpreter: shell });
  return result.outcome !== OUTCOME.EXITED || result.exitCode !== 0;
}

/**
 * Resolve a POSIX shell binary that does NOT implement bash's permissive
 * `$((` -> command-substitution fallback, so it can actually distinguish
 * broken from fixed. Plain `/bin/sh` is unreliable for this: on macOS it is
 * bash-compatible and does not reproduce the defect. Prefer `dash` (the
 * default `/bin/sh` on Debian/Ubuntu, including this repo's gsd-test Linux
 * bench); fall back to `sh` only if `dash` is not on PATH — and even then,
 * only if `sh` actually discriminates the two cases (verified, not assumed
 * from the binary name).
 */
function resolvePosixShell() {
  for (const candidate of ['dash', 'sh']) {
    if (!shellIsUsable(candidate)) continue;
    if (shellRejectsAmbiguousArithmetic(candidate)) return candidate;
  }
  return null;
}

let contextDetectionBlock;
let posixShell;

before(() => {
  const markdown = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  contextDetectionBlock = extractBashBlockAfterHeading(markdown, '## Context Detection');
  posixShell = resolvePosixShell();
});

/** Run the block in a fresh temp cwd under bash, returning parsed var assignments. */
function runBlock(setup) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-work-context-'));
  try {
    if (setup) setup(tmpDir);
    const probe = `${contextDetectionBlock}\n` +
      'printf \'phase=%s\\nspike=%s\\nsketch=%s\\ndeliberation=%s\\n\' ' +
      '"$phase" "$spike" "$sketch" "$deliberation"\n';
    const result = runHook('-c', [probe], { interpreter: 'bash', cwd: tmpDir });
    assert.equal(result.outcome, OUTCOME.EXITED, `bash exited abnormally: ${result.stderr}`);
    assert.equal(result.exitCode, 0, `bash exited ${result.exitCode}: ${result.stderr}`);
    const out = {};
    for (const line of result.stdout.trim().split('\n')) {
      const eq = line.indexOf('=');
      out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  } finally {
    cleanup(tmpDir);
  }
}

describe('regression #4112: pause-work.md Context Detection block', () => {
  test('does not throw a "Missing \'))\'" syntax error under POSIX sh/dash', (t) => {
    if (!posixShell) {
      t.skip('no POSIX shell on this host actually rejects the ambiguous $(( construct ' +
        '(dash unavailable and the resolved /bin/sh is bash-compatible) — cannot prove the ' +
        'regression here; this is still proven on the gsd-test Linux bench, where /bin/sh is dash');
      return;
    }
    const result = runHook('-c', [contextDetectionBlock], { interpreter: posixShell });
    assert.equal(result.outcome, OUTCOME.EXITED, `${posixShell} exited abnormally: ${result.stderr}`);
    assert.equal(result.exitCode, 0, `${posixShell} rejected the fixed block: ${result.stderr}`);
  });

  test('no active phase/spike/sketch/deliberation resolves all four vars to empty string, no abort', () => {
    const result = runBlock();
    assert.equal(result.phase, '');
    assert.equal(result.spike, '');
    assert.equal(result.sketch, '');
    assert.equal(result.deliberation, '');
  });

  test('single active phase resolves phase to its directory name', () => {
    const result = runBlock((tmpDir) => {
      const dir = path.join(tmpDir, '.planning', 'phases', '03-foo');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# plan\n');
    });
    assert.equal(result.phase, '03-foo');
    assert.equal(result.spike, '');
    assert.equal(result.sketch, '');
  });

  test('spike/sketch resolution is independent of phase (no active phase present)', () => {
    const result = runBlock((tmpDir) => {
      const spikeDir = path.join(tmpDir, '.planning', 'spikes', 'SPIKE-002');
      fs.mkdirSync(spikeDir, { recursive: true });
      fs.writeFileSync(path.join(spikeDir, 'SPIKE.md'), '# spike\n');

      const sketchDir = path.join(tmpDir, '.planning', 'sketches', 'my-sketch');
      fs.mkdirSync(sketchDir, { recursive: true });
      fs.writeFileSync(path.join(sketchDir, 'README.md'), '# sketch\n');
    });
    assert.equal(result.phase, '');
    assert.equal(result.spike, 'SPIKE-002');
    assert.equal(result.sketch, 'my-sketch');
  });

  test('deliberation (the already-correct pattern on line 27) is unaffected by the fix', () => {
    const result = runBlock((tmpDir) => {
      const delibDir = path.join(tmpDir, '.planning', 'deliberations');
      fs.mkdirSync(delibDir, { recursive: true });
      fs.writeFileSync(path.join(delibDir, 'topic.md'), '# deliberation\n');
    });
    assert.equal(result.phase, '');
    assert.match(result.deliberation, /\.planning\/deliberations\/topic\.md$/);
  });
});

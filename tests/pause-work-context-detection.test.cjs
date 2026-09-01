'use strict';

/**
 * pause-work-context-detection.test.cjs — regression coverage for #4112.
 *
 * gsd-core/workflows/pause-work.md's "Context Detection" step opened its
 * phase/spike/sketch assignments with `$((`, which bash/zsh parse as
 * ARITHMETIC expansion, not the intended command-substitution-wrapping-a-
 * subshell. That is a hard shell syntax error, not a warning, and it fires
 * on every `/gsd:pause-work` invocation (this is that workflow's first step).
 *
 * These tests execute the real fenced bash block extracted from the shipped
 * workflow file against real temp-directory filesystem states — not a mock,
 * not a source-text grep of the fix. Extracting the fence by locating its
 * markers in the .md prose is not `local/no-source-grep` territory: that
 * ESLint rule targets readFileSync of .cjs/.cts/.js/.mjs/.mts/.ts SOURCE
 * files followed by a text-search method; this reads workflow markdown and
 * then actually runs the extracted shell as a subprocess.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'pause-work.md');

/** Extract the fenced ```bash block that immediately follows the given heading. */
function extractBashBlockAfterHeading(markdown, heading) {
  const headingIdx = markdown.indexOf(heading);
  assert.ok(headingIdx !== -1, `heading "${heading}" not found in ${WORKFLOW_PATH}`);
  const rest = markdown.slice(headingIdx);
  const fenceMatch = rest.match(/```bash\n([\s\S]*?)```/);
  assert.ok(fenceMatch, `no \`\`\`bash fence found after heading "${heading}"`);
  return fenceMatch[1];
}

let contextDetectionBlock;

before(() => {
  const markdown = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  contextDetectionBlock = extractBashBlockAfterHeading(markdown, '## Context Detection');
});

/** Run the block in a fresh temp cwd, returning parsed var assignments. */
function runBlock(setup) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-work-context-'));
  try {
    if (setup) setup(tmpDir);
    const probe = `${contextDetectionBlock}\n` +
      'printf \'phase=%s\\nspike=%s\\nsketch=%s\\ndeliberation=%s\\n\' ' +
      '"$phase" "$spike" "$sketch" "$deliberation"\n';
    const stdout = execFileSync('bash', ['-c', probe], { cwd: tmpDir, encoding: 'utf8' });
    const out = {};
    for (const line of stdout.trim().split('\n')) {
      const eq = line.indexOf('=');
      out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('regression #4112: pause-work.md Context Detection block', () => {
  test('is syntactically valid bash (bash -n) — the arithmetic-context misparse is gone', () => {
    // A bare `bash -n` on the fragment alone is enough to prove parse validity
    // without touching the filesystem at all.
    assert.doesNotThrow(() => {
      execFileSync('bash', ['-n', '-c', contextDetectionBlock], { encoding: 'utf8' });
    }, /syntax error/);
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

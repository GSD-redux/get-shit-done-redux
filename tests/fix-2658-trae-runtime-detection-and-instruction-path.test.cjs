'use strict';

/**
 * Regression tests for #2658 — Trae runtime not detected in workflow
 * runtime-detection blocks (falls back to claude), and the install-time
 * `CLAUDE.md` path rewrite mutilates the claude fallback into a malformed
 * path instead of resolving to the Trae rules file.
 *
 * Three independent defects collided (see
 * .gsd/bug/fix-2658-trae-runtime-not-detected-falls-back-to-/10-diagnosis.md):
 *
 *   1. `gsd-core/workflows/new-project.md` AND `gsd-core/workflows/ingest-docs.md`
 *      (found during this remediation — same pattern, same gap, not just
 *      new-project.md as originally reported) never recognized trae (path
 *      `/.trae/` or env `TRAE_CONFIG_DIR`) in their runtime-detection blocks —
 *      fell through to `RUNTIME=claude`.
 *   2. The `trae.js` entry in `bin/install.js`'s `RUNTIME_CONTENT_DISPATCH`
 *      replaced bare `CLAUDE.md` first, leaving a stale `.claude/` prefix:
 *      `.claude/CLAUDE.md` -> `.claude/.trae/rules/`.
 *   3. `convertClaudeToTraeMarkdown` (mirrored in `bin/install.js` and
 *      `src/runtime-artifact-conversion.cts`) had the same class of bug but a
 *      DIFFERENT wrong output (`.trae/.trae/rules/`), because its generic
 *      `.claude/` -> `.trae/` rewrite ran after the bare `CLAUDE.md` rewrite
 *      and re-mutated the leftover prefix.
 *   4. `capabilities/trae/capability.json` didn't declare
 *      `hostBehaviors.projectInstructionFile`, so even a correctly-detected
 *      trae runtime resolved to the generic `AGENTS.md` default via
 *      `getProjectInstructionFile`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

process.env['GSD_TEST_MODE'] = '1';

const { getProjectInstructionFile } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const { convertClaudeToTraeMarkdown } = require('../bin/install.js');
const runtimeArtifactConversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const { runMinimalInstall, walk } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const MALFORMED_SINGLE = '.claude/.trae/rules';
const MALFORMED_DOUBLE = '.trae/.trae/rules';
const EXPECTED_PATH = '.trae/rules/rules.md';

describe('#2658 acceptance criterion 2: getProjectInstructionFile resolves trae to a concrete file', () => {
  test('trae maps to .trae/rules/rules.md (not the generic AGENTS.md default)', () => {
    assert.strictEqual(getProjectInstructionFile('trae'), EXPECTED_PATH);
  });

  test('capability descriptor declares the same path getProjectInstructionFile returns', () => {
    const cap = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'trae', 'capability.json'), 'utf8'),
    );
    assert.strictEqual(cap.runtime.hostBehaviors.projectInstructionFile, EXPECTED_PATH);
    assert.strictEqual(getProjectInstructionFile('trae'), cap.runtime.hostBehaviors.projectInstructionFile);
  });

  test('the declared path is a concrete file, not a bare directory (acceptance criterion 2)', () => {
    assert.ok(!EXPECTED_PATH.endsWith('/'), 'must not be directory-terminated');
    assert.ok(/\.md$/.test(EXPECTED_PATH), 'must name a concrete markdown file');
  });
});

describe('#2658: convertClaudeToTraeMarkdown never mutilates the CLAUDE.md path (bin/install.js)', () => {
  const cases = [
    ['bare CLAUDE.md', 'See CLAUDE.md for details.'],
    ['./CLAUDE.md', 'Read ./CLAUDE.md before starting.'],
    ['backtick-wrapped `CLAUDE.md`', 'The file `CLAUDE.md` is authoritative.'],
    ['the exact reported-bug input: .claude/CLAUDE.md', 'Fallback path is .claude/CLAUDE.md by default.'],
    ['backtick-wrapped .claude/CLAUDE.md', 'Fallback: `.claude/CLAUDE.md`.'],
    ['./.claude/CLAUDE.md', 'From root: ./.claude/CLAUDE.md'],
  ];
  for (const [label, input] of cases) {
    test(`${label} -> ${EXPECTED_PATH}, no malformed output`, () => {
      const out = convertClaudeToTraeMarkdown(input);
      assert.ok(!out.includes(MALFORMED_SINGLE), `output must not contain "${MALFORMED_SINGLE}": ${out}`);
      assert.ok(!out.includes(MALFORMED_DOUBLE), `output must not contain "${MALFORMED_DOUBLE}": ${out}`);
      assert.ok(out.includes(EXPECTED_PATH), `output must contain "${EXPECTED_PATH}": ${out}`);
    });
  }

  test('fast-check property: any surrounding text around .claude/CLAUDE.md never yields a malformed path', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        (prefix, suffix) => {
          const content = `${prefix}.claude/CLAUDE.md${suffix}`;
          const out = convertClaudeToTraeMarkdown(content);
          assert.ok(!out.includes(MALFORMED_SINGLE));
          assert.ok(!out.includes(MALFORMED_DOUBLE));
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('#2658 output parity: bin/install.js vs runtime-artifact-conversion.cjs convertClaudeToTraeMarkdown (#2094 mirror)', () => {
  test('identical output for the reported-bug input', () => {
    const input = 'Fallback path is .claude/CLAUDE.md by default.';
    assert.strictEqual(
      convertClaudeToTraeMarkdown(input),
      runtimeArtifactConversion.convertClaudeToTraeMarkdown(input),
    );
  });
});

describe('#2658: end-to-end --trae install never emits the malformed path (acceptance criterion 1)', () => {
  test('local install: no emitted .md/.js/.cjs file contains the malformed strings; the rules file is concrete', () => {
    const { configDir, root } = runMinimalInstall({ runtime: 'trae', scope: 'local' });
    try {
      const files = walk(configDir).filter((f) => /\.(md|js|cjs)$/.test(f));
      assert.ok(files.length > 0, 'expected at least one emitted .md/.js/.cjs file');
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        assert.ok(!content.includes(MALFORMED_SINGLE), `${file} must not contain "${MALFORMED_SINGLE}"`);
        assert.ok(!content.includes(MALFORMED_DOUBLE), `${file} must not contain "${MALFORMED_DOUBLE}"`);
      }
    } finally {
      cleanup(root);
    }
  });
});

describe('#2658 acceptance criterion 3: new-project.md / ingest-docs.md detect trae before falling back to claude', () => {
  const workflowsDir = path.join(REPO_ROOT, 'gsd-core', 'workflows');

  test('new-project.md recognizes /.trae/ path and TRAE_CONFIG_DIR before the claude fallback', () => {
    const content = fs.readFileSync(path.join(workflowsDir, 'new-project.md'), 'utf8');
    const pathBlock = content.match(/Derive `RUNTIME`[\s\S]*?Otherwise → `RUNTIME=claude`/);
    assert.ok(pathBlock, 'runtime-detection path block must exist');
    assert.ok(
      /Path contains `\/\.trae\/` → `RUNTIME=trae`/.test(pathBlock[0]),
      'path-based detection must recognize /.trae/ before the claude fallback',
    );
    const envBlock = content.match(/if \[ -n "\$CODEX_HOME" \][\s\S]*?else RUNTIME="claude"; fi/);
    assert.ok(envBlock, 'env-var fallback block must exist');
    assert.ok(
      /TRAE_CONFIG_DIR/.test(envBlock[0]),
      'env-var fallback must recognize TRAE_CONFIG_DIR before the claude fallback',
    );
  });

  test('ingest-docs.md carries the same trae detection (found during this remediation, not just new-project.md)', () => {
    const content = fs.readFileSync(path.join(workflowsDir, 'ingest-docs.md'), 'utf8');
    const block = content.match(/\*\*Detect runtime\*\*[\s\S]*?else → `RUNTIME=claude`/);
    assert.ok(block, 'runtime-detection block must exist');
    assert.ok(
      /`\/\.trae\/` → `RUNTIME=trae`/.test(block[0]),
      'ingest-docs.md must also recognize /.trae/ before the claude fallback',
    );
    assert.ok(/TRAE_CONFIG_DIR/.test(content), 'env-var fallback mention must include TRAE_CONFIG_DIR');
  });
});

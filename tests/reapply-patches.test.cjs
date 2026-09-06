/**
 * GSD Tools Tests - reapply-patches backup logic
 *
 * Validates that saveLocalPatches() in the installer correctly detects
 * user-modified files and saves pristine hashes for three-way merge.
 *
 * Closes: #1469
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── helpers ──────────────────────────────────────────────────────────────────

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

const { cleanup } = require('./helpers.cjs');
const { collectSection } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

function createTempDir() {
  return fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-patch-test-'));
}

/**
 * Simulate what the installer does: create a manifest, modify a file,
 * then run the saveLocalPatches detection logic.
 */
function simulateManifestAndPatch(configDir, files) {
  // Create the GSD files
  for (const [relPath, content] of Object.entries(files.original)) {
    const fullPath = path.join(configDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  // Create manifest with hashes of original files
  const manifest = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    files: {}
  };
  for (const [relPath, content] of Object.entries(files.original)) {
    manifest.files[relPath] = sha256(content);
  }
  fs.writeFileSync(
    path.join(configDir, 'gsd-file-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  // Now modify files to simulate user edits
  for (const [relPath, content] of Object.entries(files.modified || {})) {
    fs.writeFileSync(path.join(configDir, relPath), content);
  }

  return manifest;
}

// ─── inline saveLocalPatches (mirrors install.js logic) ──────────────────────

function fileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function saveLocalPatches(configDir) {
  const PATCHES_DIR_NAME = 'gsd-local-patches';
  const MANIFEST_NAME = 'gsd-file-manifest.json';
  const manifestPath = path.join(configDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return [];

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return []; }

  const patchesDir = path.join(configDir, PATCHES_DIR_NAME);
  const modified = [];

  for (const [relPath, originalHash] of Object.entries(manifest.files || {})) {
    const fullPath = path.join(configDir, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const currentHash = fileHash(fullPath);
    if (currentHash !== originalHash) {
      const backupPath = path.join(patchesDir, relPath);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(fullPath, backupPath);
      modified.push(relPath);
    }
  }

  if (modified.length > 0) {
    const meta = {
      backed_up_at: new Date().toISOString(),
      from_version: manifest.version,
      from_manifest_timestamp: manifest.timestamp,
      files: modified,
      pristine_hashes: {}
    };
    for (const relPath of modified) {
      meta.pristine_hashes[relPath] = manifest.files[relPath];
    }
    fs.writeFileSync(path.join(patchesDir, 'backup-meta.json'), JSON.stringify(meta, null, 2));
  }
  return modified;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('saveLocalPatches — patch backup and pristine hash tracking (#1469)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('detects modified files and backs them up', () => {
    simulateManifestAndPatch(tmpDir, {
      original: {
        'gsd-core/workflows/execute-phase.md': '# Execute Phase\nOriginal content\n',
        'gsd-core/workflows/plan-phase.md': '# Plan Phase\nOriginal content\n',
      },
      modified: {
        'gsd-core/workflows/execute-phase.md': '# Execute Phase\nOriginal content\n\n## My Custom Step\nDo something special\n',
      },
    });

    const result = saveLocalPatches(tmpDir);

    assert.strictEqual(result.length, 1, 'should detect exactly one modified file');
    assert.ok(result.includes('gsd-core/workflows/execute-phase.md'));

    // Verify backup exists
    const backupPath = path.join(tmpDir, 'gsd-local-patches', 'gsd-core/workflows/execute-phase.md');
    assert.ok(fs.existsSync(backupPath), 'backup file should exist');

    const backupContent = fs.readFileSync(backupPath, 'utf8');
    assert.ok(backupContent.includes('My Custom Step'), 'backup should contain user modification');
  });

  test('backup-meta.json includes pristine_hashes for three-way merge', () => {
    const originalContent = '# Execute Phase\nOriginal content\n';
    simulateManifestAndPatch(tmpDir, {
      original: {
        'gsd-core/workflows/execute-phase.md': originalContent,
      },
      modified: {
        'gsd-core/workflows/execute-phase.md': originalContent + '\n## Custom\n',
      },
    });

    saveLocalPatches(tmpDir);

    const metaPath = path.join(tmpDir, 'gsd-local-patches', 'backup-meta.json');
    assert.ok(fs.existsSync(metaPath), 'backup-meta.json should exist');

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    // Verify pristine_hashes field exists and contains correct hash
    assert.ok(meta.pristine_hashes, 'meta should have pristine_hashes field');
    const expectedHash = sha256(originalContent);
    assert.strictEqual(
      meta.pristine_hashes['gsd-core/workflows/execute-phase.md'],
      expectedHash,
      'pristine hash should match SHA-256 of original file content'
    );
  });

  test('backup-meta.json includes from_version and from_manifest_timestamp', () => {
    simulateManifestAndPatch(tmpDir, {
      original: { 'gsd-core/workflows/test.md': 'original' },
      modified: { 'gsd-core/workflows/test.md': 'modified' },
    });

    saveLocalPatches(tmpDir);

    const meta = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'gsd-local-patches', 'backup-meta.json'), 'utf8'
    ));

    assert.strictEqual(meta.from_version, '1.0.0');
    assert.ok(meta.from_manifest_timestamp, 'should have from_manifest_timestamp');
    assert.ok(meta.backed_up_at, 'should have backed_up_at timestamp');
  });

  test('unmodified files are not backed up', () => {
    simulateManifestAndPatch(tmpDir, {
      original: {
        'gsd-core/workflows/a.md': 'content A',
        'gsd-core/workflows/b.md': 'content B',
      },
      // No modifications
    });

    const result = saveLocalPatches(tmpDir);
    assert.strictEqual(result.length, 0, 'no files should be detected as modified');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'gsd-local-patches')), 'patches dir should not be created');
  });

  test('multiple modified files all get pristine hashes', () => {
    simulateManifestAndPatch(tmpDir, {
      original: {
        'gsd-core/workflows/a.md': 'original A',
        'gsd-core/workflows/b.md': 'original B',
        'gsd-core/workflows/c.md': 'original C',
      },
      modified: {
        'gsd-core/workflows/a.md': 'modified A',
        'gsd-core/workflows/b.md': 'modified B',
      },
    });

    const result = saveLocalPatches(tmpDir);
    assert.strictEqual(result.length, 2);

    const meta = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'gsd-local-patches', 'backup-meta.json'), 'utf8'
    ));

    assert.strictEqual(Object.keys(meta.pristine_hashes).length, 2);
    assert.strictEqual(meta.pristine_hashes['gsd-core/workflows/a.md'], sha256('original A'));
    assert.strictEqual(meta.pristine_hashes['gsd-core/workflows/b.md'], sha256('original B'));
    // c.md should NOT have a pristine hash (it wasn't modified)
    assert.strictEqual(meta.pristine_hashes['gsd-core/workflows/c.md'], undefined);
  });

  test('returns empty array when no manifest exists', () => {
    const result = saveLocalPatches(tmpDir);
    assert.strictEqual(result.length, 0);
  });

  test('returns empty array when manifest is malformed', () => {
    fs.writeFileSync(path.join(tmpDir, 'gsd-file-manifest.json'), 'not json');
    const result = saveLocalPatches(tmpDir);
    assert.strictEqual(result.length, 0);
  });
});

// allow-test-rule: source-text-is-the-product
// update.md routing and reapply-patches.md workflow text IS the deployed behavioral contract.

/**
 * Parse a field from YAML frontmatter between --- markers.
 * Returns null if the frontmatter or field is absent.
 */
function parseFrontmatterField(content, field) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const quoted = fm.match(new RegExp(`^${field}:\\s+"((?:[^"\\\\]|\\\\.)*)"\\s*$`, 'm'));
  if (quoted) return quoted[1];
  const plain = fm.match(new RegExp(`^${field}:\\s+(.+)$`, 'm'));
  if (plain) return plain[1].trim();
  return null;
}

// #2790: reapply-patches.md command was absorbed into update.md as the --reapply flag.
// The full workflow content (three-way merge, hunk verification) is in the referenced workflow.
// These tests now verify the update.md command delegates to the reapply-patches workflow correctly.

/**
 * Parse a markdown pipe-table into header + rows. Returns null if no table
 * with the expected header tokens is found. Used to assert structurally
 * against the Hunk Verification Table without raw substring matching.
 */
function parsePipeTable(content, expectedHeaderTokens) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const headerLine = lines[i].trim();
    const sepLine = (lines[i + 1] || '').trim();
    if (!headerLine.startsWith('|') || !sepLine.startsWith('|')) continue;
    if (!/^\|\s*[:\- |]+\|\s*$/.test(sepLine)) continue;
    const header = headerLine.slice(1, -1).split('|').map((s) => s.trim());
    const headerLower = header.map((h) => h.toLowerCase());
    const allFound = expectedHeaderTokens.every((tok) => headerLower.includes(tok.toLowerCase()));
    if (!allFound) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length; j++) {
      const rowLine = lines[j].trim();
      if (!rowLine.startsWith('|')) break;
      const cells = rowLine.slice(1, -1).split('|').map((s) => s.trim());
      const row = {};
      header.forEach((col, idx) => { row[col] = cells[idx] !== undefined ? cells[idx] : ''; });
      rows.push(row);
    }
    return { header, rows };
  }
  return null;
}

describe('reapply-patches workflow contract (#1469)', () => {
  test('reapply-patches.md command file is deleted (absorbed into update.md --reapply, #2790)', () => {
    const oldPath = path.join(__dirname, '..', 'commands', 'gsd', 'reapply-patches.md');
    assert.ok(!fs.existsSync(oldPath), 'reapply-patches.md should be deleted (absorbed into update.md)');
  });

  test('update.md argument-hint declares --reapply as consolidated entry point', () => {
    // Structural: parse frontmatter, then tokenize the argument-hint pipes
    // and assert --reapply is one of the documented flags (no raw substring
    // matching on prose, per the no-source-grep contract).
    const updatePath = path.join(__dirname, '..', 'commands', 'gsd', 'update.md');
    const content = fs.readFileSync(updatePath, 'utf8');
    const argHint = parseFrontmatterField(content, 'argument-hint');
    assert.ok(argHint, 'update.md frontmatter must declare argument-hint');
    // argument-hint may include multiple bracketed segments; pull every
    // `--flag` token out of any bracketed section to assert on a parsed
    // flag set rather than the surrounding punctuation.
    const bracketed = [...argHint.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
    const flagList = bracketed
      .flatMap((seg) => seg.split('|').map((s) => s.trim().split(/\s+/)[0]))
      .filter((tok) => tok.startsWith('--'));
    assert.ok(
      flagList.includes('--reapply'),
      `update.md argument-hint flag list must include --reapply; got: ${JSON.stringify(flagList)}`
    );
  });

  test('update.md @-include declares the reapply-patches workflow as a dependency', () => {
    // Structural: scan ALL <execution_context> and <execution_context_extended>
    // blocks for an `@~/.../workflows/reapply-patches.md` include. The earlier
    // substring check tolerated incidental mentions in prose; matching only the
    // first context block missed the _extended block where the delegate lives.
    const updatePath = path.join(__dirname, '..', 'commands', 'gsd', 'update.md');
    const content = fs.readFileSync(updatePath, 'utf8');
    const blocks = [
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own command .md content, fixed-size author-controlled content
      ...content.matchAll(/<execution_context(?:_extended)?>([\s\S]*?)<\/execution_context(?:_extended)?>/g),
    ].map((m) => m[1]);
    assert.ok(blocks.length > 0, 'update.md must define at least one <execution_context> block');
    const includes = blocks
      .flatMap((blk) => blk.split(/\r?\n/))
      .map((l) => l.trim())
      .filter((l) => l.startsWith('@'))
      .map((l) => l.replace(/^@/, ''));
    const declaresReapply = includes.some((p) => /(^|\/)workflows\/reapply-patches\.md$/.test(p));
    assert.ok(
      declaresReapply,
      `update.md execution_context blocks must @-include workflows/reapply-patches.md; got: ${JSON.stringify(includes)}`
    );
  });
});

// #2790: reapply-patches.md (the command file which contained the inline workflow)
// was deleted. The hunk verification contract now lives in the workflow file
// gsd-core/workflows/reapply-patches.md, referenced via execution_context_extended.
describe('reapply-patches gated hunk verification (#1999)', () => {
  const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'reapply-patches.md');

  test('reapply-patches.md command is deleted and absorbed into update.md (#2790)', () => {
    const oldPath = path.join(__dirname, '..', 'commands', 'gsd', 'reapply-patches.md');
    assert.ok(!fs.existsSync(oldPath), 'reapply-patches.md should be absent (absorbed into update.md --reapply)');
  });

  test('reapply-patches workflow file exists (behavioral contract for --reapply)', () => {
    assert.ok(fs.existsSync(workflowPath), 'gsd-core/workflows/reapply-patches.md must exist');
  });

  test('Step 4 declares a Hunk Verification Table with all required columns', () => {
    // Structural: parse the markdown pipe-table out of the workflow and
    // assert its header columns directly. Substring checks let row text
    // collide with prose mentions and fail under harmless rewording.
    const content = fs.readFileSync(workflowPath, 'utf8');
    const required = ['file', 'hunk_id', 'signature_line', 'line_count', 'verified'];
    const table = parsePipeTable(content, required);
    assert.ok(
      table,
      `reapply-patches workflow must declare a pipe-table with header columns ${JSON.stringify(required)} (Hunk Verification Table)`
    );
    const headerLower = table.header.map((h) => h.toLowerCase());
    for (const col of required) {
      assert.ok(headerLower.includes(col.toLowerCase()), `Hunk Verification Table is missing required column "${col}"; got header ${JSON.stringify(table.header)}`);
    }
  });

  test('Step 5 gates progression on the Hunk Verification Table', () => {
    // Locate the Step 5 section structurally via heading parsing, then
    // assert it both names the table and defines an explicit gate
    // condition tied to the `verified` column.
    const content = fs.readFileSync(workflowPath, 'utf8');
    const step5Section = collectSection(content, (h) => /^Step 5\b/.test(h.text));
    assert.ok(step5Section, 'reapply-patches workflow must contain a "## Step 5" section');
    const step5 = step5Section.body;
    assert.ok(
      /Hunk Verification Table/.test(step5),
      'Step 5 body must explicitly reference the Hunk Verification Table'
    );
    // Gate condition: must mention verified=no (or "verified: no") AND a stop
    // directive (STOP / halt / abort), so missing-table or any-no-row halts.
    const referencesVerifiedNo = /verified:\s*no/i.test(step5) || /verified\s*=\s*no/i.test(step5);
    const referencesStop = /\bSTOP\b/.test(step5) || /\bhalt\b/i.test(step5) || /\babort\b/i.test(step5);
    assert.ok(
      referencesVerifiedNo,
      'Step 5 gate must reference the `verified: no` failure condition (no row may slip past)'
    );
    assert.ok(
      referencesStop,
      'Step 5 gate must explicitly STOP/halt/abort when verification fails'
    );
  });

  test('Step 5 also halts when the Hunk Verification Table is absent (Step 4 produced nothing)', () => {
    // Independent gate: missing-table is a separate halt path from any-no-row.
    const content = fs.readFileSync(workflowPath, 'utf8');
    const step5Section = collectSection(content, (h) => /^Step 5\b/.test(h.text));
    assert.ok(step5Section, 'Step 5 section must exist');
    const step5 = step5Section.body;
    const handlesAbsent = /(table is absent|table is missing|missing.*table|absent.*table)/i.test(step5);
    assert.ok(
      handlesAbsent,
      'Step 5 must include an explicit "table absent / missing" halt path so Step 4 silently producing nothing cannot bypass the gate'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2424-reapply-patches-baseline-detection.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2424-reapply-patches-baseline-detection (consolidation epic #1969 B3 #1972)", () => {
/**
 * Bug #2424: reapply-patches pristine-baseline detection uses first-add commit
 *
 * The three-way merge baseline detection previously used `git log --diff-filter=A`
 * which returns the commit that FIRST added the file. On repos that have been
 * through multiple GSD update cycles, this returns a stale, many-versions-old
 * baseline — not the version immediately prior to the current update.
 *
 * Fix: Option A must prefer `pristine_hashes` from backup-meta.json to locate
 * the correct baseline commit by SHA-256 matching, with a fallback to the
 * first-add heuristic only when no pristine hash is recorded.
 *
 * #2790: reapply-patches.md (which contained the inline Option A / Option B workflow)
 * was consolidated into update.md as the --reapply flag. The behavioral contract
 * (pristine_hashes preference, fallback to first-add) is maintained in the
 * update.md workflow's --reapply path. These tests now verify the consolidation.
 */

// allow-test-rule: source-text-is-the-product (see #2424)
// gsd-core/workflows/update.md is the installed runtime workflow —
// its text IS the deployed behavioral contract.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// #2790: reapply-patches.md (command with inline workflow) was deleted.
// The --reapply functionality is now in update.md.
const UPDATE_MD = path.join(__dirname, '..', 'commands', 'gsd', 'update.md');

/**
 * Parse a field from YAML frontmatter between --- markers.
 * Returns null if the frontmatter or field is absent.
 */
function parseFrontmatterField(content, field) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const quoted = fm.match(new RegExp(`^${field}:\\s+"((?:[^"\\\\]|\\\\.)*)"\\s*$`, 'm'));
  if (quoted) return quoted[1];
  const plain = fm.match(new RegExp(`^${field}:\\s+(.+)$`, 'm'));
  if (plain) return plain[1].trim();
  return null;
}

describe('reapply-patches pristine baseline detection (#2424)', () => {
  test('reapply-patches.md command is deleted (absorbed into update.md --reapply, #2790)', () => {
    const oldPath = path.join(__dirname, '..', 'commands', 'gsd', 'reapply-patches.md');
    assert.ok(!fs.existsSync(oldPath), 'reapply-patches.md should be absent (absorbed into update.md --reapply)');
  });

  test('update.md argument-hint declares --reapply as consolidated entry point', () => {
    const content = fs.readFileSync(UPDATE_MD, 'utf-8');
    const argHint = parseFrontmatterField(content, 'argument-hint');
    assert.ok(
      argHint && argHint.includes('--reapply'),
      `update.md argument-hint must declare --reapply flag; got: ${argHint || '(none)'}`
    );
  });

  test('update.md workflow references backup-meta.json for pristine-hash baseline', () => {
    // #2790: The behavioral contract (pristine_hashes from backup-meta.json as primary
    // baseline source) is implemented in the update.md workflow (gsd-core/workflows/update.md),
    // not the command file. The command delegates via --reapply flag.
    // Verify the underlying workflow has this content.
    const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'update.md');
    const workflowContent = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(
      workflowContent.includes('backup-meta.json'),
      'gsd-core/workflows/update.md must reference backup-meta.json (pristine_hashes baseline source)'
    );
  });

  test('update.md exists as consolidated entry point', () => {
    assert.ok(fs.existsSync(UPDATE_MD), 'update.md must exist as consolidated entry point');
  });

  test('update.md argument-hint declares full consolidated flag surface (--sync | --reapply)', () => {
    // Validates that both flags absorbed from the deleted micro-skills are declared
    // in the command contract, not just --reapply alone.
    const content = fs.readFileSync(UPDATE_MD, 'utf-8');
    const argHint = parseFrontmatterField(content, 'argument-hint');
    assert.ok(
      argHint && argHint.includes('--sync') && argHint.includes('--reapply'),
      `update.md argument-hint must declare both --sync and --reapply; got: ${argHint || '(none)'}`
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3516-reapply-patches-gsd-update-filter.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3516-reapply-patches-gsd-update-filter (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #3516)
// gsd-core/workflows/reapply-patches.md is the installed runtime workflow —
// its text IS the deployed behavioral contract for the --reapply flag.

'use strict';

/**
 * Bug #3516: reapply-patches.md git-enhanced two-way merge filter misses
 * commits authored by the renamed `/gsd-update` flow.
 *
 * The `grep -v` alternation on line 231 only included the legacy `gsd:update`
 * marker. After the slash-command rename `/gsd:update` → `/gsd-update`, commits
 * authored by the current flow fall through the filter and are misclassified as
 * user customizations, prompting spurious merge conflicts during `--reapply`.
 *
 * Fix: add `gsd-update` arm to the alternation so both the legacy and current
 * commit-message prefixes are excluded. `GSD update` and `gsd-install`
 * exclusions are preserved.
 *
 * Per the repo's source-text-is-the-product exception: the workflow file's text
 * IS the deployed behavioral contract. Structural assertion against the parsed
 * shell command string is the correct test form here.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'reapply-patches.md',
);

/**
 * Extract the git log filter command from the workflow.
 *
 * Looks for the `grep -v "..."` shell snippet inside the Git-enhanced two-way
 * merge section and returns the alternation string between the quotes.
 * Returns null if the snippet is absent (signals a structural regression).
 */
function extractFilterAlternation(content) {
  // Match the grep -v "..." line in the bash block
  const match = content.match(/grep\s+-v\s+"([^"]+)"/);
  if (!match) return null;
  return match[1];
}

/**
 * Parse the alternation string (pipe-delimited) into individual arms.
 * Handles escaped pipes produced by shell regex syntax (`\|`).
 */
function parseAlternationArms(alternation) {
  // Shell grep alternation uses \| (escaped pipe); split on that
  return alternation.split(/\\\|/).map((arm) => arm.trim());
}

describe('Bug #3516: git-enhanced two-way merge filter includes gsd-update arm', () => {
  let content;
  let alternation;
  let arms;

  before(() => {
    content = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    alternation = extractFilterAlternation(content);
    arms = alternation ? parseAlternationArms(alternation) : [];
  });

  test('workflow file exists', () => {
    assert.ok(
      fs.existsSync(WORKFLOW_PATH),
      'gsd-core/workflows/reapply-patches.md must exist',
    );
  });

  test('git-enhanced two-way merge section contains a grep -v filter', () => {
    assert.ok(
      alternation !== null,
      'reapply-patches.md must contain a `grep -v "..."` filter in the git-enhanced two-way merge section',
    );
  });

  test('filter excludes legacy gsd:update commits (back-compat)', () => {
    assert.ok(
      arms.some((arm) => arm === 'gsd:update'),
      `filter must include 'gsd:update' arm for back-compat; got arms: ${JSON.stringify(arms)}`,
    );
  });

  test('filter excludes renamed gsd-update commits (primary fix)', () => {
    assert.ok(
      arms.some((arm) => arm === 'gsd-update'),
      `filter must include 'gsd-update' arm (renamed flow); got arms: ${JSON.stringify(arms)}`,
    );
  });

  test('filter excludes GSD update commits (no regression)', () => {
    assert.ok(
      arms.some((arm) => arm === 'GSD update'),
      `filter must include 'GSD update' arm; got arms: ${JSON.stringify(arms)}`,
    );
  });

  test('filter excludes gsd-install commits (no regression)', () => {
    assert.ok(
      arms.some((arm) => arm === 'gsd-install'),
      `filter must include 'gsd-install' arm; got arms: ${JSON.stringify(arms)}`,
    );
  });

  test('all four expected exclusion patterns are present in the filter', () => {
    const required = ['gsd:update', 'gsd-update', 'GSD update', 'gsd-install'];
    const missing = required.filter((p) => !arms.some((arm) => arm === p));
    assert.deepEqual(
      missing,
      [],
      `filter is missing required exclusion patterns: ${JSON.stringify(missing)}; got arms: ${JSON.stringify(arms)}`,
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2994-verify-reapply-patches-installed-path.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2994-verify-reapply-patches-installed-path (consolidation epic #1969 B5 #1974)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2994: scripts/verify-reapply-patches.cjs ships in tarball but is
 * not installed at ${GSD_HOME}/scripts/.
 *
 * Root cause: bin/install.js copies the gsd-core/ source tree to
 * ${configDir}/gsd-core/ but does NOT copy the top-level scripts/
 * directory. The verifier script lived under scripts/ so /gsd-reapply-patches
 * Step 5 hit `Cannot find module …/scripts/verify-reapply-patches.cjs`.
 *
 * Fix: move the script to gsd-core/bin/verify-reapply-patches.cjs
 * (which IS installed) and update reapply-patches.md to point there.
 *
 * This test enforces the structural invariant that prevents regression.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNTIME_SCRIPT_PATH = path.join(ROOT, 'gsd-core', 'bin', 'verify-reapply-patches.cjs');
const STALE_SCRIPT_PATH = path.join(ROOT, 'scripts', 'verify-reapply-patches.cjs');
const REAPPLY_WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'reapply-patches.md');

describe('Bug #2994: verify-reapply-patches.cjs lives at the runtime-installed path', () => {
  test('the script exists under gsd-core/bin/ (installed by copyWithPathReplacement)', () => {
    assert.equal(fs.existsSync(RUNTIME_SCRIPT_PATH), true,
      `Expected verifier script at ${RUNTIME_SCRIPT_PATH} -- installer copies gsd-core/ recursively`);
  });

  test('the script does NOT live at the legacy scripts/ path (not installed)', () => {
    assert.equal(fs.existsSync(STALE_SCRIPT_PATH), false,
      `scripts/ is not copied by installer; verifier must be under gsd-core/bin/ instead`);
  });

  test('the script is requireable (loads without throwing)', () => {
    const mod = require(RUNTIME_SCRIPT_PATH);
    assert.equal(typeof mod.REASON, 'object');
    assert.notEqual(mod.REASON, null);
  });
});

// Parse reapply-patches.md to extract every `node "${GSD_HOME}/...cjs"`
// invocation as structured records. Assertions go against the parsed
// records, not against the markdown text.
function extractScriptInvocations(markdown) {
  const invocations = [];
  const re = /node\s+"\$\{GSD_HOME\}\/([^"]+\.cjs)"/g;
  let match;
  while ((match = re.exec(markdown)) !== null) {
    invocations.push({ relPath: match[1] });
  }
  return invocations;
}

describe('Bug #2994: reapply-patches workflow references the runtime-installed path', () => {
  test('every node ${GSD_HOME}/... invocation in reapply-patches.md uses an installed runtime path', () => {
    const md = fs.readFileSync(REAPPLY_WORKFLOW, 'utf-8');
    const invocations = extractScriptInvocations(md);
    assert.ok(invocations.length > 0, 'sanity: expected at least one node ${GSD_HOME}/... invocation in reapply-patches.md');

    const violations = invocations.filter(inv => !inv.relPath.startsWith('gsd-core/'));
    assert.deepEqual(violations, [], `invocations under non-installed paths: ${JSON.stringify(violations)}`);
  });

  test('reapply-patches.md references the verifier at gsd-core/bin/verify-reapply-patches.cjs', () => {
    const md = fs.readFileSync(REAPPLY_WORKFLOW, 'utf8');
    const invocations = extractScriptInvocations(md);
    const verifierInvocations = invocations.filter(inv => inv.relPath.endsWith('verify-reapply-patches.cjs'));
    // #4136: the workflow now invokes the verifier exactly twice — the Step 4
    // pre-flight --classify run (Incorporated detection) and the Step 5a
    // post-merge gate run. Both must resolve to the runtime-installed path
    // (the sibling test above enforces the path for every invocation).
    assert.deepEqual(
      verifierInvocations.map(i => i.relPath),
      ['gsd-core/bin/verify-reapply-patches.cjs', 'gsd-core/bin/verify-reapply-patches.cjs'],
      'workflow must call the runtime-installed verifier exactly twice (classify + gate, #4136)',
    );
  });
});
  });
}

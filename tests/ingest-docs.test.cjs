// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Ingest Docs Tests — ingest-docs.test.cjs
 *
 * Structural assertions for /gsd-ingest-docs (#2387). Agents and workflows
 * are prompt-based; these tests guard the contract (files exist, frontmatter
 * present, required references wired up, safety semantics preserved).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

const ROOT = path.join(__dirname, '..');
const CMD_PATH = path.join(ROOT, 'commands', 'gsd', 'ingest-docs.md');
const WF_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'ingest-docs.md');
const CLASSIFIER_PATH = path.join(ROOT, 'agents', 'gsd-doc-classifier.md');
const SYNTHESIZER_PATH = path.join(ROOT, 'agents', 'gsd-doc-synthesizer.md');
const CONFLICT_ENGINE_PATH = path.join(ROOT, 'gsd-core', 'references', 'doc-conflict-engine.md');

// ─── File Existence ────────────────────────────────────────────────────────────

describe('ingest-docs file structure (#2387)', () => {
  test('command file exists', () => {
    assert.ok(fs.existsSync(CMD_PATH), 'commands/gsd/ingest-docs.md should exist');
  });
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WF_PATH), 'gsd-core/workflows/ingest-docs.md should exist');
  });
  test('classifier agent exists', () => {
    assert.ok(fs.existsSync(CLASSIFIER_PATH), 'agents/gsd-doc-classifier.md should exist');
  });
  test('synthesizer agent exists', () => {
    assert.ok(fs.existsSync(SYNTHESIZER_PATH), 'agents/gsd-doc-synthesizer.md should exist');
  });
  test('shared conflict-engine reference exists', () => {
    assert.ok(fs.existsSync(CONFLICT_ENGINE_PATH), 'references/doc-conflict-engine.md should exist');
  });
});

// ─── Command Frontmatter ───────────────────────────────────────────────────────

describe('ingest-docs command frontmatter', () => {
  const content = fs.readFileSync(CMD_PATH, 'utf-8');

  test('has name field', () => {
    assert.match(content, /^name:\s*gsd:ingest-docs$/m);
  });
  test('has description field', () => {
    assert.match(content, /^description:\s*.+$/m);
  });
  test('argument-hint mentions --mode, --manifest, --resolve', () => {
    const m = content.match(/^argument-hint:\s*"(.+)"$/m);
    assert.ok(m, 'argument-hint should be present');
    assert.ok(m[1].includes('--mode'), 'argument-hint should mention --mode');
    assert.ok(m[1].includes('--manifest'), 'argument-hint should mention --manifest');
    assert.ok(m[1].includes('--resolve'), 'argument-hint should mention --resolve');
  });
  test('allowed-tools include AskUserQuestion and Agent', () => {
    const frontmatter = extractFrontmatter(content);
    const allowedTools = frontmatter['allowed-tools'];
    assert.ok(Array.isArray(allowedTools), 'allowed-tools should be a frontmatter array');
    assert.ok(allowedTools.includes('AskUserQuestion'), 'command needs AskUserQuestion for gates');
    assert.ok(allowedTools.includes('Agent'), 'command needs Agent for agent spawns');
  });
});

// ─── Command References ─────────────────────────────────────────────────────────

describe('ingest-docs command references', () => {
  const content = fs.readFileSync(CMD_PATH, 'utf-8');

  test('references the ingest-docs workflow', () => {
    assert.ok(
      content.includes('@~/.claude/gsd-core/workflows/ingest-docs.md'),
      'command must @-reference its workflow'
    );
  });
  test('references the doc-conflict-engine', () => {
    assert.ok(
      content.includes('@~/.claude/gsd-core/references/doc-conflict-engine.md'),
      'command must load the shared conflict-engine contract'
    );
  });
  test('references gate-prompts', () => {
    assert.ok(
      content.includes('@~/.claude/gsd-core/references/gate-prompts.md'),
      'command must load gate-prompts for AskUserQuestion patterns'
    );
  });
});

// ─── Workflow Content ───────────────────────────────────────────────────────────

describe('ingest-docs workflow content', () => {
  const content = fs.readFileSync(WF_PATH, 'utf-8');

  test('parses --mode, --manifest, --resolve, and a positional path', () => {
    assert.ok(content.includes('--mode'), '--mode flag must be parsed');
    assert.ok(content.includes('--manifest'), '--manifest flag must be parsed');
    assert.ok(content.includes('--resolve'), '--resolve flag must be parsed');
    assert.ok(content.includes('SCAN_PATH'), 'positional scan path must be parsed');
  });

  test('validates paths for traversal sequences', () => {
    assert.ok(
      content.includes('traversal') || content.match(/case\s+".*\*\.\.\*/),
      'workflow must reject traversal sequences in user-supplied paths'
    );
  });

  test('enforces 50-doc cap in v1', () => {
    assert.ok(
      content.includes('50'),
      'workflow must enforce the v1 doc cap'
    );
    assert.ok(
      content.toLowerCase().includes('cap') || content.toLowerCase().includes('limit'),
      'workflow must describe the cap/limit'
    );
  });

  test('auto-detects MODE from .planning/ presence', () => {
    assert.ok(
      content.includes('planning_exists'),
      'workflow must check planning_exists from init to auto-detect mode'
    );
  });

  test('discovers via directory conventions', () => {
    assert.ok(content.includes('adr'), 'workflow must match ADR directory convention');
    assert.ok(content.includes('prd'), 'workflow must match PRD directory convention');
    assert.ok(content.includes('spec'), 'workflow must match SPEC/RFC directory convention');
  });

  test('spawns gsd-doc-classifier and gsd-doc-synthesizer', () => {
    assert.ok(
      content.includes('gsd-doc-classifier'),
      'workflow must spawn gsd-doc-classifier'
    );
    assert.ok(
      content.includes('gsd-doc-synthesizer'),
      'workflow must spawn gsd-doc-synthesizer'
    );
  });

  test('conflict gate honors BLOCKER/WARNING/INFO semantics from doc-conflict-engine', () => {
    assert.ok(content.includes('BLOCKER'), 'workflow must reference BLOCKER severity');
    assert.ok(content.includes('WARNING'), 'workflow must reference WARNING severity');
    assert.ok(content.includes('INFO'), 'workflow must reference INFO severity');
    assert.ok(
      content.includes('doc-conflict-engine'),
      'workflow must cite the shared conflict-engine reference'
    );
  });

  test('hard-blocks writes when BLOCKERs exist', () => {
    // Must contain language that prevents writing destination files on blocker
    assert.ok(
      content.toLowerCase().includes('without writing') ||
      content.toLowerCase().includes('no destination files'),
      'workflow must forbid writes when BLOCKERs exist (safety gate)'
    );
  });

  test('routes to gsd-roadmapper in new mode', () => {
    assert.ok(
      content.includes('gsd-roadmapper'),
      'new mode must delegate to gsd-roadmapper'
    );
  });

  test('rejects --resolve interactive in v1', () => {
    const lower = content.toLowerCase();
    assert.ok(
      lower.includes('interactive') && lower.includes('future'),
      'workflow must reject --resolve interactive with a future-release message'
    );
  });

  test('references INGEST-CONFLICTS.md as the conflicts report location', () => {
    assert.ok(
      content.includes('INGEST-CONFLICTS.md'),
      'workflow must write/read INGEST-CONFLICTS.md'
    );
  });
});

// ─── Classifier Agent ───────────────────────────────────────────────────────────

describe('gsd-doc-classifier agent', () => {
  const content = fs.readFileSync(CLASSIFIER_PATH, 'utf-8');

  test('has Read and Write tools', () => {
    assert.match(content, /^tools:\s*.*Read.*Write.*/m);
  });
  test('produces JSON output schema', () => {
    assert.ok(content.includes('"type"'), 'schema must include type field');
    assert.ok(content.includes('"confidence"'), 'schema must include confidence field');
    assert.ok(content.includes('"locked"'), 'schema must include locked field for ADRs');
  });
  test('documents all five classification types', () => {
    assert.ok(content.includes('ADR'), 'classifier must handle ADR type');
    assert.ok(content.includes('PRD'), 'classifier must handle PRD type');
    assert.ok(content.includes('SPEC'), 'classifier must handle SPEC type');
    assert.ok(content.includes('DOC'), 'classifier must handle DOC type');
    assert.ok(content.includes('UNKNOWN'), 'classifier must handle UNKNOWN type');
  });
  test('only marks Accepted ADRs as locked', () => {
    assert.ok(
      content.includes('Accepted'),
      'classifier must tie locked status to Accepted ADR status'
    );
  });
});

// ─── Synthesizer Agent ──────────────────────────────────────────────────────────

describe('gsd-doc-synthesizer agent', () => {
  const content = fs.readFileSync(SYNTHESIZER_PATH, 'utf-8');

  test('has Read/Write/Bash tools', () => {
    assert.match(content, /^tools:\s*.*Read.*Write.*Bash.*/m);
  });
  test('documents default precedence ADR > SPEC > PRD > DOC', () => {
    const precedenceBlock = content.match(/ADR[^.]*SPEC[^.]*PRD[^.]*DOC/);
    assert.ok(precedenceBlock, 'default precedence ordering must be documented');
  });
  test('hard-blocks LOCKED vs LOCKED in both modes', () => {
    assert.ok(
      content.includes('LOCKED') && content.toLowerCase().includes('both'),
      'LOCKED-vs-LOCKED must be a hard block in both modes'
    );
  });
  test('produces three-bucket conflicts report', () => {
    assert.ok(content.includes('auto-resolved'), 'report must have auto-resolved bucket');
    assert.ok(content.includes('competing-variants'), 'report must have competing-variants bucket');
    assert.ok(content.includes('unresolved-blockers'), 'report must have unresolved-blockers bucket');
  });
  test('performs cycle detection', () => {
    assert.ok(
      content.toLowerCase().includes('cycle'),
      'synthesizer must run cycle detection on cross-ref graph'
    );
  });
  test('preserves competing PRD acceptance variants (no naive merge)', () => {
    assert.ok(
      content.toLowerCase().includes('variant'),
      'synthesizer must preserve competing acceptance variants'
    );
  });
  test('writes SYNTHESIS.md as entry point for downstream consumers', () => {
    assert.ok(
      content.includes('SYNTHESIS.md'),
      'synthesizer must write SYNTHESIS.md'
    );
  });
});

// ─── Shared Conflict Engine Contract ────────────────────────────────────────────

describe('doc-conflict-engine shared reference', () => {
  const content = fs.readFileSync(CONFLICT_ENGINE_PATH, 'utf-8');

  test('defines all three severity labels', () => {
    assert.ok(content.includes('[BLOCKER]'));
    assert.ok(content.includes('[WARNING]'));
    assert.ok(content.includes('[INFO]'));
  });
  test('forbids markdown tables in conflict reports', () => {
    assert.ok(
      content.toLowerCase().includes('never markdown tables') ||
      content.toLowerCase().includes('no markdown tables') ||
      content.toLowerCase().includes('never use markdown tables'),
      'reference must forbid markdown tables'
    );
  });
  test('defines the BLOCKER safety gate', () => {
    assert.ok(
      content.toLowerCase().includes('exit without writing'),
      'safety gate must forbid destination writes when BLOCKERs exist'
    );
  });
});

// ─── Import command still consumes the shared reference (#2387 refactor) ───────

describe('import command adopts shared conflict-engine', () => {
  const cmdContent = fs.readFileSync(path.join(ROOT, 'commands', 'gsd', 'import.md'), 'utf-8');
  const wfContent = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'import.md'), 'utf-8');

  test('import command loads doc-conflict-engine reference', () => {
    assert.ok(
      cmdContent.includes('@~/.claude/gsd-core/references/doc-conflict-engine.md'),
      '/gsd-import must load the shared conflict-engine contract'
    );
  });
  test('import workflow cites the shared reference', () => {
    assert.ok(
      wfContent.includes('doc-conflict-engine'),
      'import workflow must cite the shared conflict-engine'
    );
  });
  test('import workflow retains BLOCKER/WARNING/INFO labels', () => {
    assert.ok(wfContent.includes('[BLOCKER]'));
    assert.ok(wfContent.includes('[WARNING]'));
    assert.ok(wfContent.includes('[INFO]'));
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2801-ingest-docs-handler.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2801-ingest-docs-handler (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for bug #2801
 *
 * `/gsd-ingest-docs` was broken because:
 * 1. `workflows/ingest-docs.md` called `gsd-sdk query init.ingest-docs` but the
 *    installed binary is `gsd-tools` (not `gsd-sdk`).
 * 2. `gsd-tools init` had no `ingest-docs` case in its dispatch switch.
 *
 * The fix:
 * - Added `case 'ingest-docs'` to the `init` switch in `gsd-tools.cjs`.
 * - Exported `cmdInitIngestDocs` from `init.cjs`.
 * - Updated `workflows/ingest-docs.md` to call `gsd-tools init ingest-docs`.
 *
 * This test prevents regression of the dispatch omission.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, TOOLS_PATH } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOW_FILE = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'ingest-docs.md');

// Note (#3147 migration): the original execFileSync-based implementation
// caught its own throw and degraded it into `{exitCode, stdout}` data —
// nothing here ever propagated err.status/err.stdout/err.stderr to a
// caller, and every call site below asserts exitCode === 0. That is the
// "already reads exit status as data" shape (never-throwing runX, map
// .exitCode), not a throw-preserving one, so this uses `runNode` directly
// rather than `throwIfFailed`. stdout/stderr are concatenated on a non-zero
// exit to match the original catch-block behavior exactly.
function spawnGsdTools(args, projectDir) {
  const result = runNode(
    [TOOLS_PATH, ...args, '--cwd', projectDir],
    {
      env: { ...process.env, GSD_SESSION_KEY: '' },
      timeoutMs: PROBE_TIMEOUT_MS,
    }
  );
  const exitCode = result.exitCode ?? 1;
  const stdout = exitCode === 0 ? result.stdout : result.stdout + result.stderr;
  return { exitCode, stdout };
}

describe('bug-2801: gsd-tools init ingest-docs handler exists', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-test-2801-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init ingest-docs exits 0 (not "Unknown init workflow")', () => {
    const { exitCode, stdout } = spawnGsdTools(['init', 'ingest-docs', '--raw'], tmpDir);
    assert.strictEqual(exitCode, 0, `expected exit 0, got: ${stdout}`);
  });

  test('init ingest-docs returns JSON with project_exists field', () => {
    const { exitCode, stdout } = spawnGsdTools(['init', 'ingest-docs', '--raw'], tmpDir);
    assert.strictEqual(exitCode, 0);
    let json;
    try { json = JSON.parse(stdout.trim()); } catch { assert.fail(`non-JSON output: ${stdout}`); }
    assert.ok(Object.prototype.hasOwnProperty.call(json, 'project_exists'), 'project_exists present');
  });

  test('init ingest-docs returns JSON with planning_exists field', () => {
    const { exitCode, stdout } = spawnGsdTools(['init', 'ingest-docs', '--raw'], tmpDir);
    assert.strictEqual(exitCode, 0);
    const json = JSON.parse(stdout.trim());
    assert.ok(Object.prototype.hasOwnProperty.call(json, 'planning_exists'), 'planning_exists present');
  });

  test('init ingest-docs returns JSON with has_git field', () => {
    const { exitCode, stdout } = spawnGsdTools(['init', 'ingest-docs', '--raw'], tmpDir);
    assert.strictEqual(exitCode, 0);
    const json = JSON.parse(stdout.trim());
    assert.ok(Object.prototype.hasOwnProperty.call(json, 'has_git'), 'has_git present');
  });

  test('init ingest-docs returns JSON with project_path field', () => {
    const { exitCode, stdout } = spawnGsdTools(['init', 'ingest-docs', '--raw'], tmpDir);
    assert.strictEqual(exitCode, 0);
    const json = JSON.parse(stdout.trim());
    assert.ok(Object.prototype.hasOwnProperty.call(json, 'project_path'), 'project_path present');
    assert.ok(Object.prototype.hasOwnProperty.call(json, 'commit_docs'), 'commit_docs present');
  });

  test('planning_exists is true when .planning/ directory exists', () => {
    const { exitCode, stdout } = spawnGsdTools(['init', 'ingest-docs', '--raw'], tmpDir);
    assert.strictEqual(exitCode, 0);
    const json = JSON.parse(stdout.trim());
    assert.strictEqual(json.planning_exists, true, 'planning_exists should be true (.planning/ created by createTempProject)');
  });
});

describe('bug-2801: ingest-docs.md workflow calls gsd-tools not gsd-sdk', () => {
  test('no bash code block in ingest-docs.md calls gsd-sdk', () => {
    const content = fs.readFileSync(WORKFLOW_FILE, 'utf-8');
    // Extract bash fenced code blocks structurally.
    const bashBlocks = [];
    const codeBlockRe = /```bash\r?\n([\s\S]*?)```/g;
    let m;
    while ((m = codeBlockRe.exec(content)) !== null) {
      bashBlocks.push(m[1]);
    }
    assert.ok(bashBlocks.length > 0, 'expected bash code blocks in workflow');

    // Check every line in every bash block — not just lines that start with the token,
    // since gsd-sdk can appear in subshell expansions like $(gsd-sdk query ...).
    const sdkCalls = bashBlocks
      .join('\n')
      .split('\n')
      .filter((line) => /\bgsd-sdk\b/.test(line));

    assert.deepStrictEqual(
      sdkCalls,
      [],
      `workflow bash blocks still reference gsd-sdk (should use gsd-tools): ${sdkCalls.join(', ')}`
    );
  });

  test('ingest-docs.md init step uses the gsd_run launcher (#637)', () => {
    const content = fs.readFileSync(WORKFLOW_FILE, 'utf-8');
    // Parse fenced bash blocks structurally — do not match raw markdown text.
    const codeBlockRe = /```bash\r?\n([\s\S]*?)```/g;
    const bashLines = [...content.matchAll(codeBlockRe)]
      .flatMap((m) => m[1].split('\n'))
      .filter((l) => !/^\s*#/.test(l));
    // #637 routes ingest-docs through the resolved `gsd_run` launcher instead of
    // the hardcoded `node "$HOME/.../gsd-tools.cjs"` path (which misses global
    // installs). The legacy bare `gsd-tools` form remains the bug and is still
    // rejected by bug-2851's repo-wide guard.
    const initLine = bashLines.find((l) =>
      /\bgsd_run\s+init\s+ingest-docs\b/.test(l)
    );
    assert.ok(initLine, 'workflow must invoke init ingest-docs via the gsd_run launcher (#637)');
  });

  test('cmdInitIngestDocs is exported from init.cjs', () => {
    const init = require(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'init.cjs'));
    assert.strictEqual(typeof init.cmdInitIngestDocs, 'function', 'cmdInitIngestDocs must be exported');
  });
});
  });
}

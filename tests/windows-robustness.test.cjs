// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Windows Robustness Tests
 *
 * Validates that workflow files, hooks, and core functions handle
 * Windows/cross-platform edge cases correctly:
 *
 * 1. Workflow shell robustness: informational commands guarded with || true
 * 2. Glob loops guarded with [ -e "$var" ] || continue
 * 3. Hook stdin timeout patterns present in all JS hooks
 * 4. findProjectRoot detects .git at same level as .planning/
 * 5. @file: handoff present in all workflows that call init
 *
 * Regression tests for: https://github.com/open-gsd/gsd-core/issues/1343
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

/**
 * Extract bash code blocks from a markdown file.
 * Returns array of { lineNumber, code } objects.
 */
function extractBashBlocks(content) {
  const blocks = [];
  const lines = content.split('\n');
  let inBlock = false;
  let blockStart = 0;
  let blockLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```bash')) {
      inBlock = true;
      blockStart = i + 1;
      blockLines = [];
    } else if (inBlock && line.trim() === '```') {
      inBlock = false;
      blocks.push({ lineNumber: blockStart, code: blockLines.join('\n') });
    } else if (inBlock) {
      blockLines.push(line);
    }
  }
  return blocks;
}

/**
 * Check if a line is an informational command that can return non-zero on
 * "no results" and should be guarded with || true.
 *
 * Matches: ls, grep, find, cat on optional files — commands at end of line
 * with 2>/dev/null that are NOT already guarded.
 */
function findUnguardedInfoCommands(code) {
  const issues = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip comments, empty lines, and lines that are already guarded
    if (!line || line.startsWith('#')) continue;
    if (line.includes('|| true') || line.includes('|| echo') || line.includes('|| continue')) continue;

    // Lines ending with 2>/dev/null that use informational commands
    if (line.endsWith('2>/dev/null')) {
      // Check if this is an informational command (ls, grep, find, cat on optional files)
      if (/^(ls|grep|find|cat)\s/.test(line) ||
          /\|\s*(ls|grep|find)\s/.test(line)) {
        issues.push({ line: i + 1, content: line });
      }
    }
  }
  return issues;
}

// ─── Workflow Shell Robustness ────────────────────────────────────────────────

describe('workflow shell robustness', () => {
  // Key workflow files that must have || true guards on informational commands
  const criticalWorkflows = [
    'resume-project.md',
    'progress.md',
    'transition.md',
    'verify-work.md',
    'discuss-phase.md',
    'plan-phase.md',
    'execute-plan.md',
    'cleanup.md',
  ];

  for (const wf of criticalWorkflows) {
    test(`${wf}: informational commands are guarded with || true`, () => {
      const filePath = path.join(WORKFLOWS_DIR, wf);
      if (!fs.existsSync(filePath)) return; // skip if workflow doesn't exist
      const content = fs.readFileSync(filePath, 'utf-8');
      const blocks = extractBashBlocks(content);
      const allIssues = [];

      for (const block of blocks) {
        const issues = findUnguardedInfoCommands(block.code);
        for (const issue of issues) {
          allIssues.push(`Line ~${block.lineNumber + issue.line}: ${issue.content}`);
        }
      }

      assert.strictEqual(
        allIssues.length, 0,
        `${wf} has unguarded informational commands that may fail on Windows:\n  ${allIssues.join('\n  ')}`
      );
    });
  }

  test('glob loops in resume-project.md have existence guard', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'resume-project.md'), 'utf-8');
    const blocks = extractBashBlocks(content);

    for (const block of blocks) {
      // Look for `for ... in .planning/` glob loops
      const forLoopMatch = block.code.match(/for\s+\w+\s+in\s+\.planning\/[^;]+;\s*do/);
      if (forLoopMatch) {
        // The loop body should contain [ -e "$var" ] || continue
        assert.ok(
          block.code.includes('|| continue'),
          `Glob loop at line ~${block.lineNumber} missing existence guard ([ -e "$var" ] || continue):\n${forLoopMatch[0]}`
        );
      }
    }
  });
});

// ─── Hook Stdin Timeout ──────────────────────────────────────────────────────

describe('hook stdin timeout patterns', () => {
  test('all JS hooks have stdin timeout guard', () => {
    if (!fs.existsSync(HOOKS_DIR)) return;

    const hookFiles = fs.readdirSync(HOOKS_DIR)
      .filter(f => f.endsWith('.js'));

    for (const hook of hookFiles) {
      const content = fs.readFileSync(path.join(HOOKS_DIR, hook), 'utf-8');

      // Hooks that read stdin must have a timeout
      if (content.includes('process.stdin')) {
        assert.ok(
          content.includes('setTimeout') || content.includes('stdinTimeout'),
          `${hook} reads stdin but lacks a timeout guard — will hang on Windows if stdin pipe doesn't close`
        );
      }
    }
  });

  test('no JS hooks use synchronous readFileSync on /dev/stdin', () => {
    if (!fs.existsSync(HOOKS_DIR)) return;

    const hookFiles = fs.readdirSync(HOOKS_DIR)
      .filter(f => f.endsWith('.js'));

    for (const hook of hookFiles) {
      const content = fs.readFileSync(path.join(HOOKS_DIR, hook), 'utf-8');
      assert.ok(
        !content.includes("readFileSync('/dev/stdin')") &&
        !content.includes('readFileSync("/dev/stdin")'),
        `${hook} uses readFileSync('/dev/stdin') which hangs on Windows — use async process.stdin with timeout instead`
      );
    }
  });
});

// ─── @file: Handoff ─────────────────────────────────────────────────────────

describe('@file: handoff in workflows', () => {
  test('all workflows calling gsd-tools init have @file: handler', () => {
    const workflowFiles = fs.readdirSync(WORKFLOWS_DIR)
      .filter(f => f.endsWith('.md'));

    const missing = [];
    for (const wf of workflowFiles) {
      const content = fs.readFileSync(path.join(WORKFLOWS_DIR, wf), 'utf-8');

      // Check if this workflow calls gsd-tools.cjs init
      if (/INIT=\$\(node.*gsd-tools.*\binit\b/.test(content)) {
        // Must have @file: handler
        if (!content.includes('@file:')) {
          missing.push(wf);
        }
      }
    }

    assert.strictEqual(
      missing.length, 0,
      `Workflows calling gsd-tools init without @file: handler (large output will be truncated):\n  ${missing.join('\n  ')}`
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-685-windowshide-spawn.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-685-windowshide-spawn (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #685)
// These spawn/exec sites cannot be behaviourally tested for windowsHide
// off-Windows; the source text is the runtime contract (issue #685). Without
// windowsHide:true a detached or shell:true child allocates a visible console
// window on Windows (the "gsd-core" flash).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf-8');

// Slice the exact body of one spawn site so the assertion binds that site,
// not merely "windowsHide appears somewhere in the file".
function regionBetween(src, startAnchor, endAnchor) {
  const i = src.indexOf(startAnchor);
  assert.notEqual(i, -1, `start anchor not found: ${startAnchor}`);
  const j = src.indexOf(endAnchor, i);
  assert.notEqual(j, -1, `end anchor not found after start: ${endAnchor}`);
  return src.slice(i, j);
}

describe('bug #685: Windows spawns must set windowsHide:true (no console-window flash)', () => {
  test('gsd-context-monitor record-session spawn sets windowsHide', () => {
    const region = regionBetween(read('hooks/gsd-context-monitor.js'), "'record-session'", '.unref()');
    assert.match(region, /windowsHide:\s*true/, 'record-session spawn must set windowsHide: true');
  });

  const cts = () => read('src/shell-command-projection.cts');
  const helpers = [
    ['execGit', 'export function execGit', "_spawnResult(result, 'git')"],
    ['execNpm', 'export function execNpm', "_spawnResult(result, 'npm')"],
    ['execTool', 'export function execTool', '_spawnResult(result, program)'],
  ];
  for (const [name, start, end] of helpers) {
    test(`shell-command-projection ${name} spawnSync sets windowsHide`, () => {
      const region = regionBetween(cts(), start, end);
      assert.match(region, /windowsHide:\s*true/, `${name} spawnSync must set windowsHide: true`);
    });
  }

  test('gsd-worktree-path-guard SPAWNOPT sets windowsHide', () => {
    const region = regionBetween(read('hooks/gsd-worktree-path-guard.js'), 'const SPAWNOPT', '};');
    assert.match(region, /windowsHide:\s*true/, 'gsd-worktree-path-guard SPAWNOPT must set windowsHide: true');
  });

  test('gsd-workflow-guard currentBranch spawnSync sets windowsHide', () => {
    const region = regionBetween(read('hooks/gsd-workflow-guard.js'), "spawnSync('git', ['branch'", '});');
    assert.match(region, /windowsHide:\s*true/, 'gsd-workflow-guard git-branch spawn must set windowsHide: true');
  });

  test('check-command-router recentCommitMessages execFileSync sets windowsHide', () => {
    const region = regionBetween(read('src/check-command-router.cts'), "execFileSync('git', ['log'", '});');
    assert.match(region, /windowsHide:\s*true/, 'check-command-router git-log execFileSync must set windowsHide: true');
  });

  test('roadmap-upgrade execSync git calls all set windowsHide', () => {
    const src = read('src/roadmap-upgrade.cts');
    const calls = src.match(/execSync\([^)]*\)/g) || [];
    // #1542 made rollback git-independent (surgical fs restore), so the only
    // remaining git execSync is the `git status --porcelain` precondition. The
    // durable guard is that EVERY git execSync still present sets windowsHide.
    assert.ok(calls.length >= 1, 'expected at least the roadmap-upgrade git status execSync call to be present');
    const missing = calls.filter((c) => !/windowsHide:\s*true/.test(c));
    assert.deepEqual(missing, [], `execSync without windowsHide:\n${missing.join('\n')}`);
  });

  test('gsd-check-update spawn retains windowsHide (precedent guard)', () => {
    assert.match(read('hooks/gsd-check-update.js'), /windowsHide:\s*true/,
      'gsd-check-update.js must keep windowsHide: true');
  });

  // Durable invariant: ANY external-binary process spawn in the runtime source
  // (hooks + src) must set windowsHide — catches future additions, not just the
  // sites known today. Handles the `{ ...CONST }` spread indirection.
  test('completeness: no external-binary spawn in runtime source omits windowsHide', () => {
    const listDir = (dir, re) =>
      fs.readdirSync(path.join(root, dir)).filter((f) => re.test(f)).map((f) => `${dir}/${f}`);
    const files = [...listDir('hooks', /\.js$/), ...listDir('src', /\.cts$/)];
    const callRe = /(?:execSync|execFileSync|spawnSync|spawn)\s*\(\s*(?:`|'|")?(?:git|npm|gh)\b|spawn\s*\(\s*process\.execPath/g;
    const offenders = [];
    for (const rel of files) {
      const src = read(rel);
      let m;
      while ((m = callRe.exec(src)) !== null) {
        const win = src.slice(m.index, m.index + 400);
        let ok = /windowsHide:\s*true/.test(win);
        if (!ok) {
          const spread = win.match(/\{\s*\.\.\.(\w+)/); // e.g. { ...SPAWNOPT, cwd }
          if (spread) {
            ok = new RegExp(`(?:const|let|var)\\s+${spread[1]}\\s*=\\s*\\{[^}]*windowsHide:\\s*true`).test(src);
          }
        }
        if (!ok) offenders.push(`${rel}: ...${src.slice(m.index, m.index + 48).replace(/\s+/g, ' ')}`);
      }
    }
    assert.deepEqual(offenders, [], `external-binary spawns missing windowsHide:\n${offenders.join('\n')}`);
  });
});
  });
}

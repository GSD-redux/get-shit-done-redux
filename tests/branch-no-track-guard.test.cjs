// allow-test-rule: structural-regression-guard see #2498
// Guards the --no-track fix: any workflow that creates a branch from a remote-tracking
// ref (origin/$DEFAULT_BRANCH / origin/$<ENV>_BRANCH) MUST pass --no-track. Without it,
// the default branch.autoSetupMerge=true wires branch.<name>.merge to
// refs/heads/$DEFAULT_BRANCH, so a GUI sync (GitHub Desktop, VS Code) pushes the
// branch's commits straight onto origin/$DEFAULT_BRANCH, bypassing PR review entirely
// (#2498 — caused a 7-plan phase's commits to land on origin/master in a real project).
// Scans ALL workflow .md files so a newly-added workflow reintroducing the pattern is
// caught, not just the two originally-fixed ones.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');

function collectMdFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

test('#2498: branch creation from a remote-tracking ref uses --no-track', () => {
  const violations = [];
  for (const file of collectMdFiles(WORKFLOWS_DIR)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const isCheckoutFromRemoteRef =
        /git\s+checkout\s+-b\b/.test(line) &&
        /origin\/\$[A-Z_]+_?BRANCH|origin\/\$DEFAULT_BRANCH/.test(line);
      if (isCheckoutFromRemoteRef && !/--no-track/.test(line)) {
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.equal(
    violations.length,
    0,
    `Found ${violations.length} \`git checkout -b\` from a remote-tracking ref ` +
      `(origin/$<BRANCH>) without --no-track (#2498). Default branch.autoSetupMerge would ` +
      `wire the branch upstream to origin/$<BRANCH>, so a GUI sync pushes commits onto it, ` +
      `bypassing PR review. Add --no-track. Violations:\n${violations.join('\n')}`,
  );
});

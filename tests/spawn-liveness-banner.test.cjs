// allow-test-rule: source-text-is-the-product
// Tests that every GSD workflow that spawns a subagent carries the liveness phrase
// "runs in a subagent" on its spawn announcement lines.
// Canonical phrase defined in gsd-core/references/ui-brand.md § Spawning Indicators.
// Regression test for https://github.com/open-gsd/gsd-core/issues/558.
//
// TEST STRATEGY: Two complementary assertions.
//
// 1. SPAWN-BANNER CHECK — any ◆ display line that contains the word "spawn" or "spawning"
//    (case-insensitive, anywhere on the line) must carry the liveness phrase. This is more
//    rigorous than a simple /◆\s+[Ss]pawning/ prefix match and catches all variants:
//      "◆ Spawning researcher..."              (spawn word right after ◆)
//      "◆ Chunked mode: spawning planner..."   (spawn word after prefix text)
//    It does NOT match ◆ status/error lines that say "planner returned" or "checker wrote"
//    (those don't contain the word "spawn"), so it has no false positives.
//
// 2. PRESENCE CHECK (coarser fallback) — if a file contains `subagent_type`, it must
//    contain the liveness phrase at least once. Catches workflows that dispatch subagents
//    without any ◆ spawn banner (e.g. prose-only "Spawn X" instructions).
//
// Together the two assertions are strictly stronger than the original file-level check:
// a file with 10 spawns where only one ◆ Spawning banner got the note still fails #1.
// A file with subagent_type but no banner at all still fails #2.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readWorkflowCombined } = require('./helpers.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const LIVENESS_PHRASE = 'runs in a subagent';

// Matches any ◆ line that contains "spawn" or "spawning" (case-insensitive, word anywhere).
// This covers:
//   "◆ Spawning researcher..."       → matched
//   "◆ Chunked mode: spawning X..."  → matched
// But NOT:
//   "◆ Planner wrote N plan(s)..."   → not matched (no "spawn" word)
//   "◆ Research phase enabled"       → not matched (no "spawn" word)
const SPAWN_BANNER_RE = /◆[^\r\n]*\bspawning?\b/i;

function findMdFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

describe('spawn-liveness-banner', () => {
  test('every ◆ spawn announcement line carries the liveness phrase "runs in a subagent"', () => {
    const mdFiles = findMdFiles(WORKFLOWS_DIR);
    const bannerViolations = [];

    for (const filePath of mdFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      const rel = path.relative(WORKFLOWS_DIR, filePath);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (SPAWN_BANNER_RE.test(line) && !line.includes(LIVENESS_PHRASE)) {
          bannerViolations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    assert.deepStrictEqual(
      bannerViolations,
      [],
      `The following ◆ spawn announcement lines are missing the liveness phrase "${LIVENESS_PHRASE}":\n` +
        bannerViolations.map(v => `  - ${v}`).join('\n') +
        '\n\nPer gsd-core/references/ui-brand.md § "Spawning Indicators":\n' +
        'every ◆ spawn announcement must carry "runs in a subagent" so users know\n' +
        'that silence during a subagent run is expected and do not kill a healthy agent.\n' +
        'See https://github.com/open-gsd/gsd-core/issues/558'
    );
  });

  test('every workflow that dispatches a subagent contains the liveness phrase somewhere', () => {
    // #2994: scoped to HOST workflow files only (top-level gsd-core/workflows/*.md),
    // each read via readWorkflowCombined (host + its workflows/<wf>/steps/*.md
    // fragments). The fragment model can move a subagent dispatch site into a step
    // file while the host still carries the liveness phrase elsewhere for its other
    // dispatches (e.g. docs-update.md). A raw recursive `findMdFiles` walk treats
    // that step fragment as an independent "workflow" and reports a false positive
    // — it is not a standalone workflow, it is part of its host's contract. The
    // asserted property (every workflow that dispatches a subagent documents the
    // liveness phrase somewhere in that workflow) is unchanged; only the file
    // boundary the check honors is corrected.
    const hostFiles = fs
      .readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(WORKFLOWS_DIR, entry.name));
    const presenceViolations = [];

    for (const filePath of hostFiles) {
      const content = readWorkflowCombined(filePath);
      const rel = path.relative(WORKFLOWS_DIR, filePath);

      if (content.includes('subagent_type') && !content.includes(LIVENESS_PHRASE)) {
        presenceViolations.push(rel);
      }
    }

    assert.deepStrictEqual(
      presenceViolations,
      [],
      `The following workflow files contain "subagent_type" but are missing the liveness phrase "${LIVENESS_PHRASE}" anywhere in the file:\n` +
        presenceViolations.map(f => `  - ${f}`).join('\n') +
        '\n\nPer gsd-core/references/ui-brand.md § "Spawning Indicators":\n' +
        'every workflow that spawns a subagent must carry "runs in a subagent" so users know\n' +
        'that silence during a subagent run is expected and do not kill a healthy agent.\n' +
        'See https://github.com/open-gsd/gsd-core/issues/558'
    );
  });
});

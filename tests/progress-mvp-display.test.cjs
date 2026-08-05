/**
 * progress workflow — MVP mode display contract test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress.md');
const PROGRESS_STEPS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress', 'steps');

/**
 * progress.md was fragmented (#2994) into gsd-core/workflows/progress/steps/*.md.
 * The mvp_display step (and its MVP-mode display contract) now lives in
 * progress/steps/mvp-display.md, only read at all when state:phase-mvp-mode is
 * true. Read host + every step file combined so this contract guard keeps
 * seeing the full picture regardless of which file the content physically
 * lives in.
 */
function readProgressCombined() {
  let combined = fs.readFileSync(WORKFLOW, 'utf8');
  if (fs.existsSync(PROGRESS_STEPS_DIR)) {
    for (const entry of fs.readdirSync(PROGRESS_STEPS_DIR).sort()) {
      if (entry.endsWith('.md')) {
        combined += '\n' + fs.readFileSync(path.join(PROGRESS_STEPS_DIR, entry), 'utf8');
      }
    }
  }
  return combined;
}

function parseProgressContract(content) {
  const lines = content.split(/\r?\n/);
  const lowerLines = lines.map(line => line.toLowerCase());
  return {
    hasMvpModeVariable: lowerLines.some(line => line.includes('mvp_mode')),
    usesPhaseMvpVerb: lowerLines.some(line => line.includes('phase.mvp-mode')),
    sourcesPlanTasks: lowerLines.some(line => line.includes('plan.md') && line.includes('task')),
    usesUserFlowLanguage: lowerLines.some(line => line.includes('user-flow') || line.includes('user-visible')),
    hasStandardFallback: lowerLines.some(line =>
      (line.includes('mode') && (line.includes('null') || line.includes('absent') || line.includes('not mvp'))) ||
      (line.includes('standard') && line.includes('display'))
    ),
  };
}

describe('progress — MVP mode display', () => {
  const contract = parseProgressContract(readProgressCombined());

  test('workflow declares MVP_MODE branch', () => {
    assert.ok(contract.hasMvpModeVariable, 'must declare MVP_MODE');
    assert.ok(contract.usesPhaseMvpVerb, 'must resolve MVP mode via the centralized phase.mvp-mode verb');
  });

  test('MVP display sources user-flow status from PLAN.md task names', () => {
    assert.ok(contract.sourcesPlanTasks, 'must source user-flow status from PLAN.md tasks');
    assert.ok(contract.usesUserFlowLanguage, 'must use user-flow framing');
  });

  test('falls back to standard display when mode null', () => {
    assert.ok(contract.hasStandardFallback, 'must specify fallback when mode is not mvp');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-14-progress-auto-flag-dropped.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-14-progress-auto-flag-dropped (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #14)
// The command markdown is loaded directly by runtime prompt assembly.
// This test verifies that --auto is documented in progress.md and handled in next.md.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

describe('#14: /gsd:progress --next --auto flag must be documented and propagated', () => {
  test('progress.md <flags> section documents --auto flag', () => {
    const command = fs.readFileSync(
      path.join(ROOT, 'commands', 'gsd', 'progress.md'),
      'utf8'
    );

    assert.ok(
      command.includes('--auto'),
      'progress.md must document the --auto flag in the <flags> section'
    );
  });

  test('progress.md <process> block explicitly passes --auto through to next workflow', () => {
    const command = fs.readFileSync(
      path.join(ROOT, 'commands', 'gsd', 'progress.md'),
      'utf8'
    );

    // Extract only the <process>…</process> block so this assertion is
    // scoped to the handoff wiring, not just any occurrence in the file.
    const processMatch = command.match(/<process>([\s\S]*?)<\/process>/);
    assert.ok(
      processMatch,
      'progress.md must contain a <process> block'
    );
    const processBlock = processMatch[1];

    assert.ok(
      processBlock.includes('--auto'),
      'progress.md <process> block must explicitly mention --auto so it is not silently stripped at the --next handoff'
    );
  });

  test('next.md show_and_execute step handles --auto to chain steps', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, 'gsd-core', 'workflows', 'next.md'),
      'utf8'
    );

    assert.ok(
      workflow.includes('--auto'),
      'next.md must handle the --auto flag to chain step invocations automatically'
    );
  });

  test('next.md --auto chaining re-invokes /gsd:progress --next after step completion', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, 'gsd-core', 'workflows', 'next.md'),
      'utf8'
    );

    // The workflow must contain instructions to re-invoke /gsd:progress --next --auto
    // after the determined step completes, enabling the chain.
    assert.ok(
      workflow.includes('--next --auto'),
      'next.md must instruct re-invocation of /gsd:progress --next --auto after step completion to enable chaining'
    );
  });
});
  });
}

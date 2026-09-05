/**
 * Discuss Mode Config Tests
 *
 * Validates workflow.discuss_mode config, routing, and assumptions workflow integration.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempProject, cleanup, captureFdSync } = require('./helpers.cjs');

describe('workflow.discuss_mode config', () => {
  test('config template includes discuss_mode default', () => {
    const template = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'templates', 'config.json'), 'utf8')
    );
    assert.strictEqual(template.workflow.discuss_mode, 'discuss');
  });

  test('discuss-phase command references both workflow files', () => {
    const command = fs.readFileSync(
      path.join(__dirname, '..', 'commands', 'gsd', 'discuss-phase.md'), 'utf8'
    );
    assert.ok(command.includes('discuss-phase-assumptions.md'), 'should reference assumptions workflow');
    assert.ok(command.includes('discuss-phase.md'), 'should reference discuss workflow');
    assert.ok(command.includes('workflow.discuss_mode'), 'should reference config key');
  });

  test('discuss-phase command process block defers to workflow file (not inline instructions)', () => {
    const command = fs.readFileSync(
      path.join(__dirname, '..', 'commands', 'gsd', 'discuss-phase.md'), 'utf8'
    );
    // Extract the <process> block
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own command .md content, fixed-size author-controlled content
    const processMatch = command.match(/<process>([\s\S]*?)<\/process>/);
    assert.ok(processMatch, 'should have a <process> block');
    const processBlock = processMatch[1];

    // The process block must explicitly tell the agent to read the workflow file
    assert.ok(
      processBlock.includes('Read and execute'),
      'process block should direct agent to read and execute workflow file'
    );
    assert.ok(
      processBlock.includes('MANDATORY'),
      'process block should include MANDATORY instruction to read workflow files'
    );

    // The process block must NOT contain detailed step-by-step instructions
    // that could substitute for the actual workflow file
    assert.ok(
      !processBlock.includes('Scout codebase'),
      'process block should not contain detailed workflow steps (Scout codebase)'
    );
    assert.ok(
      !processBlock.includes('Deep-dive each area'),
      'process block should not contain detailed workflow steps (Deep-dive)'
    );
    assert.ok(
      !processBlock.includes('Probing depth'),
      'process block should not contain detailed workflow steps (Probing depth)'
    );
  });

  test('discuss-phase command argument-hint includes --text', () => {
    const command = fs.readFileSync(
      path.join(__dirname, '..', 'commands', 'gsd', 'discuss-phase.md'), 'utf8'
    );
    assert.ok(command.includes('--text'), 'argument-hint should include --text');
  });

  test('assumptions workflow file exists and has required steps', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'discuss-phase-assumptions.md'), 'utf8'
    );
    const requiredSteps = [
      'initialize', 'check_existing', 'load_prior_context',
      'deep_codebase_analysis', 'present_assumptions', 'correct_assumptions',
      'write_context', 'write_discussion_log', 'auto_advance'
    ];
    for (const step of requiredSteps) {
      assert.ok(workflow.includes(`<step name="${step}"`), `missing step: ${step}`);
    }
  });

  test('assumptions workflow produces same CONTEXT.md sections', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'discuss-phase-assumptions.md'), 'utf8'
    );
    const sections = ['<domain>', '<decisions>', '<canonical_refs>', '<code_context>', '<specifics>', '<deferred>'];
    for (const section of sections) {
      assert.ok(workflow.includes(section), `missing CONTEXT.md section: ${section}`);
    }
  });

  test('plan-phase gate references discuss_mode config', () => {
    const planPhase = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md'), 'utf8'
    );
    assert.ok(planPhase.includes('workflow.discuss_mode'), 'should reference config key');
    assert.ok(planPhase.includes('assumptions mode'), 'should mention assumptions mode');
  });

  test('assumptions workflow handles --auto flag', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'discuss-phase-assumptions.md'), 'utf8'
    );
    assert.ok(workflow.includes('--auto'), 'should handle --auto');
    assert.ok(workflow.includes('auto-select'), 'should auto-select in --auto mode');
    assert.ok(workflow.includes('auto_advance'), 'should support auto_advance');
  });

  test('assumptions workflow handles --text flag', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'discuss-phase-assumptions.md'), 'utf8'
    );
    assert.ok(workflow.includes('text_mode'), 'should reference text_mode config');
    assert.ok(workflow.includes('--text'), 'should handle --text flag');
  });

  test('plan-phase workflow references text_mode', () => {
    const planPhase = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md'), 'utf8'
    );
    assert.ok(planPhase.includes('text_mode'), 'plan-phase workflow should reference text_mode');
    assert.ok(planPhase.includes('TEXT_MODE'), 'plan-phase workflow should use TEXT_MODE variable');
    assert.ok(planPhase.includes('--text'), 'plan-phase workflow should handle --text flag');
  });

  test('plan-phase command argument-hint includes --text', () => {
    const command = fs.readFileSync(
      path.join(__dirname, '..', 'commands', 'gsd', 'plan-phase.md'), 'utf8'
    );
    assert.ok(command.includes('--text'), 'argument-hint should include --text flag');
  });

  test('plan-phase init propagates config.workflow.text_mode into its result', () => {
    // Behavioral replacement for a source-grep assertion (#3466): calls
    // cmdInitPlanPhase directly against a real project fixture whose
    // config.json sets workflow.text_mode, and asserts the value actually
    // reaches the JSON result cmdInitPlanPhase emits — rather than grepping
    // init.cjs's source text for the propagation line.
    const { cmdInitPlanPhase } = require(
      path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'init.cjs')
    );
    const cwd = createTempProject('gsd-text-mode-propagation-');
    try {
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ workflow: { text_mode: true } }, null, 2)
      );

      // cmdInitPlanPhase writes its JSON result directly to fd 1 via
      // io.cjs's writeAllSync (bypasses console.log — captureConsole()
      // cannot observe it). Delegates to the shared, safe fd-capture helper
      // (#4306) — see tests/helpers.cjs's captureFdSync.
      const captured = captureFdSync(1, () => cmdInitPlanPhase(cwd, 'does-not-exist', false, {}));
      const result = JSON.parse(captured);
      assert.strictEqual(
        result.text_mode, true,
        'cmdInitPlanPhase result must propagate config.workflow.text_mode'
      );
    } finally {
      cleanup(cwd);
    }
  });

  test('progress workflow references discuss_mode', () => {
    const progress = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress.md'), 'utf8'
    );
    assert.ok(progress.includes('workflow.discuss_mode'), 'should read discuss_mode config');
    assert.ok(progress.includes('Discuss mode'), 'should display discuss mode');
  });

  test('documentation file exists', () => {
    const docPath = path.join(__dirname, '..', 'docs', 'workflow-discuss-mode.md');
    assert.ok(fs.existsSync(docPath), 'docs/workflow-discuss-mode.md should exist');
    const doc = fs.readFileSync(docPath, 'utf8');
    assert.ok(doc.includes('assumptions'), 'doc should mention assumptions');
    assert.ok(doc.includes('discuss'), 'doc should mention discuss');
    assert.ok(doc.includes('config-set'), 'doc should show how to configure');
  });

  test('discuss-phase command mode-routing uses gsd_run (shim-safe) not bare gsd-tools', () => {
    const command = fs.readFileSync(
      path.join(__dirname, '..', 'commands', 'gsd', 'discuss-phase.md'), 'utf8'
    );
    // Must contain the canonical shim probe marker
    assert.ok(
      command.includes('_GSD_SHIM_NAME'),
      'discuss-phase.md must define _GSD_SHIM_NAME shim probe before mode routing'
    );
    // Must use gsd_run for the config lookup
    assert.ok(
      command.includes('gsd_run query config-get workflow.discuss_mode'),
      'discuss-phase.md must use gsd_run (not bare gsd-tools) for discuss_mode lookup'
    );
    // Must NOT contain the bare footgun pattern: gsd-tools immediately before the silent default
    assert.ok(
      !command.includes('gsd-tools query config-get workflow.discuss_mode 2>/dev/null || echo'),
      'discuss-phase.md must NOT use bare gsd-tools binary for discuss_mode lookup (shim-only install footgun)'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2549-2550-2552-discuss-phase-context.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2549-2550-2552-discuss-phase-context (consolidation epic #1969 B4 #1973)", () => {
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


/**
 * Bugs #2549, #2550, #2552: discuss-phase context bloat and cache invalidation.
 *
 * #2549: load_prior_context must cap prior CONTEXT.md reads (was O(phases))
 * #2550: scout_codebase must select maps by phase type (was always all 7)
 * #2552: scout_codebase must not instruct split reads of the same file
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DISCUSS_PHASE = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'discuss-phase.md',
);
// After the discuss-phase progressive-disclosure split (#717), the scout_codebase phase-type
// table and split-reads warning live in references/scout-codebase.md.
const SCOUT_REF = path.join(
  __dirname, '..', 'gsd-core', 'references', 'scout-codebase.md',
);

function readDiscussContext() {
  // Both files are required after the discuss-phase/modes split — fail loudly if either is missing
  // rather than silently weakening the regression coverage.
  for (const p of [DISCUSS_PHASE, SCOUT_REF]) {
    assert.ok(fs.existsSync(p), `Required discuss-phase context source missing: ${p}`);
  }
  return [DISCUSS_PHASE, SCOUT_REF].map(p => fs.readFileSync(p, 'utf-8')).join('\n');
}

describe('discuss-phase context fixes (#2549, #2550, #2552)', () => {
  let src;
  test('discuss-phase.md source exists', () => {
    assert.ok(fs.existsSync(DISCUSS_PHASE), 'discuss-phase.md must exist');
    assert.ok(
      fs.existsSync(SCOUT_REF),
      'references/scout-codebase.md must exist after the discuss-phase/modes progressive-disclosure split',
    );
    src = readDiscussContext();
  });

  // ─── #2549: load_prior_context cap ──────────────────────────────────────
  test('#2549: load_prior_context must NOT instruct reading ALL prior CONTEXT.md files', () => {
    if (!src) src = readDiscussContext();
    assert.ok(
      !src.includes('For each CONTEXT.md where phase number < current phase'),
      'load_prior_context must not unboundedly read all prior CONTEXT.md files',
    );
  });

  test('#2549: load_prior_context must reference a bounded read (3 phases or DECISIONS-INDEX)', () => {
    // Read ONLY the parent file — `src.includes('3')` against the
    // concatenated source can be satisfied by unrelated occurrences of "3"
    // in scout-codebase.md (e.g., "3-5 most relevant files"), masking a
    // regression where the parent drops the bounded-read instruction.
    const parent = fs.readFileSync(DISCUSS_PHASE, 'utf-8');
    const hasBound = /\b(?:most recent|latest|last|up to)\s+3\b[\s\S]{0,160}\bprior CONTEXT\.md\b/i.test(parent);
    const hasIndex = parent.includes('DECISIONS-INDEX.md');
    assert.ok(
      hasBound || hasIndex,
      'load_prior_context must reference a bounded read (e.g., most recent 3 phases) or DECISIONS-INDEX.md',
    );
  });

  // ─── #2550: scout_codebase phase-type selection ──────────────────────────
  test('#2550: scout_codebase must not instruct reading all 7 codebase maps', () => {
    if (!src) src = readDiscussContext();
    assert.ok(
      !src.includes('Read the most relevant ones (CONVENTIONS.md, STRUCTURE.md, STACK.md based on phase type)'),
      'scout_codebase must not use the old vague "most relevant" instruction without a selection table',
    );
  });

  test('#2550: scout_codebase must include a phase-type-to-maps selection table', () => {
    if (!src) src = readDiscussContext();
    // The table maps phase types to specific map selections
    assert.ok(
      src.includes('Phase type') && src.includes('Read these maps'),
      'scout_codebase must include a phase-type to map-selection table',
    );
    // Key phase types must be covered
    assert.ok(src.includes('UI') || src.includes('frontend'), 'Table must cover UI/frontend phases');
    assert.ok(src.includes('Backend') || src.includes('API'), 'Table must cover backend phases');
    assert.ok(src.includes('Testing'), 'Table must cover testing phases');
    assert.ok(src.includes('Mixed'), 'Table must have a fallback for mixed/unclear phases');
  });

  // ─── #2552: no split reads ───────────────────────────────────────────────
  test('#2552: scout_codebase must explicitly prohibit split reads of the same file', () => {
    if (!src) src = readDiscussContext();
    const prohibitsSplit = src.includes('split reads') || src.includes('split read');
    assert.ok(
      prohibitsSplit,
      'scout_codebase must explicitly warn against split reads (same file, two offsets) that break prompt cache',
    );
  });
});
  });
}

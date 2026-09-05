// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Code Review Tests
 *
 * Validates all code review artifacts from Phases 1-4:
 * - Agent frontmatter (gsd-code-reviewer, gsd-code-fixer)
 * - Command structure (code-review.md, code-review-fix.md)
 * - Workflow structure (code-review.md, code-review-fix.md)
 * - Config key registration (workflow.code_review, workflow.code_review_depth)
 * - Workflow integration points (execute-phase, quick, autonomous)
 *
 * Test structure:
 * - CR-AGENT: Hermetic agent tests (repo files only)
 * - CR-CMD: Hermetic command tests (repo files only)
 * - CR-WORKFLOW: Hermetic workflow tests (repo files only)
 * - CR-CONFIG: Hermetic config tests (repo files only)
 * - CR-INTEGRATION: Conditional integration tests (skip if plugin dir absent)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

/** Return the raw text of every ```bash fenced block in `content`. */
function extractBashBlocks(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  for (const block of scanFencedBlocks(lines)) {
    if (block.closeLineIdx === -1) continue;
    if ((block.infoString || '').trim().toLowerCase() !== 'bash') continue;
    blocks.push(lines.slice(block.openLineIdx, block.closeLineIdx + 1).join('\n'));
  }
  return blocks;
}
const os = require('os');
const { runGsdTools, createTempProject, createTempGitProject, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const GSD_TOOLS_BIN = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

// --- Test Environment Setup ---

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

/**
 * Parse top-level (non-nested, non-escaped) Skill() invocations from a workflow .md file.
 *
 * Returns an array of structured objects: [{ skill, args }]
 *  - `skill` is the value of the `skill="..."` keyword argument
 *  - `args` is the value of the `args="..."` keyword argument (or null if absent)
 *
 * Skips occurrences inside escaped string contexts like
 *   prompt="... Skill(skill=\"x\", args=\"y\") ..."
 * by walking the file character-by-character and tracking whether we are inside
 * a double-quoted string. Escaped quotes (\") are treated as literal content.
 *
 * This avoids regex/.includes() text-matching: callers receive a structured list
 * and assert against fields and tokenized args.
 */
function parseWorkflowSkillInvocations(content) {
  const invocations = [];
  let i = 0;
  let inString = false;

  while (i < content.length) {
    const ch = content[i];

    if (inString) {
      if (ch === '\\' && i + 1 < content.length) {
        // Skip escape sequence (e.g. \" or \\)
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }

    // Look for top-level "Skill(" at this position
    if (content.startsWith('Skill(', i)) {
      const callStart = i + 'Skill('.length;
      // Find the matching close paren, respecting strings/escapes inside the call
      let j = callStart;
      let depth = 1;
      let innerInString = false;
      while (j < content.length && depth > 0) {
        const c = content[j];
        if (innerInString) {
          if (c === '\\' && j + 1 < content.length) {
            j += 2;
            continue;
          }
          if (c === '"') innerInString = false;
          j += 1;
          continue;
        }
        if (c === '"') {
          innerInString = true;
        } else if (c === '(') {
          depth += 1;
        } else if (c === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
        j += 1;
      }
      const callBody = content.slice(callStart, j);
      const parsed = parseSkillCallBody(callBody);
      if (parsed) invocations.push(parsed);
      i = j + 1;
      continue;
    }

    i += 1;
  }

  return invocations;
}

/**
 * Parse the body of a Skill(...) call into { skill, args }.
 * Body looks like: skill="name", args="value" (args optional).
 * Returns null if no skill keyword is found.
 */
function parseSkillCallBody(body) {
  const kwargs = {};
  const isIdentChar = (c) => /[A-Za-z0-9_]/.test(c);
  const isWs = (c) => /\s/.test(c);
  let i = 0;
  while (i < body.length) {
    // Skip whitespace and commas
    while (i < body.length && (isWs(body[i]) || body[i] === ',')) i += 1;
    if (i >= body.length) break;

    // Read identifier key
    const keyStart = i;
    while (i < body.length && isIdentChar(body[i])) i += 1;
    const key = body.slice(keyStart, i);
    if (!key) break;

    // Expect '='
    while (i < body.length && isWs(body[i])) i += 1;
    if (body[i] !== '=') break;
    i += 1;
    while (i < body.length && isWs(body[i])) i += 1;

    // Expect quoted value
    if (body[i] !== '"') break;
    i += 1;
    let value = '';
    while (i < body.length) {
      const c = body[i];
      if (c === '\\' && i + 1 < body.length) {
        value += body[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        i += 1;
        break;
      }
      value += c;
      i += 1;
    }
    kwargs[key] = value;
  }

  if (!('skill' in kwargs)) return null;
  return { skill: kwargs.skill, args: 'args' in kwargs ? kwargs.args : null };
}

// Plugin directory resolution (cross-platform safe)
const PLUGIN_WORKFLOWS_DIR = process.env.GSD_PLUGIN_ROOT || path.join(os.homedir(), '.claude', 'gsd-core', 'workflows');
const PLUGIN_AVAILABLE = fs.existsSync(PLUGIN_WORKFLOWS_DIR);

// --- CR-AGENT: code review agent frontmatter ---

describe('CR-AGENT: code review agent frontmatter', () => {
  test('gsd-code-reviewer.md has required frontmatter fields', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-reviewer.md'), 'utf-8');
    const frontmatter = content.split('---')[1] || '';

    assert.ok(frontmatter.includes('name:'), 'gsd-code-reviewer missing name:');
    assert.ok(frontmatter.includes('description:'), 'gsd-code-reviewer missing description:');
    assert.ok(frontmatter.includes('tools:'), 'gsd-code-reviewer missing tools:');
    assert.ok(frontmatter.includes('color:'), 'gsd-code-reviewer missing color:');
  });

  test('gsd-code-fixer.md has required frontmatter fields', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-fixer.md'), 'utf-8');
    const frontmatter = content.split('---')[1] || '';

    assert.ok(frontmatter.includes('name:'), 'gsd-code-fixer missing name:');
    assert.ok(frontmatter.includes('description:'), 'gsd-code-fixer missing description:');
    assert.ok(frontmatter.includes('tools:'), 'gsd-code-fixer missing tools:');
    assert.ok(frontmatter.includes('color:'), 'gsd-code-fixer missing color:');
  });

  test('gsd-code-reviewer.md has Read, Bash, Glob, Grep, Write tools', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-reviewer.md'), 'utf-8');
    const frontmatter = content.split('---')[1] || '';

    assert.ok(frontmatter.includes('Read'), 'gsd-code-reviewer missing Read tool');
    assert.ok(frontmatter.includes('Bash'), 'gsd-code-reviewer missing Bash tool');
    assert.ok(frontmatter.includes('Glob'), 'gsd-code-reviewer missing Glob tool');
    assert.ok(frontmatter.includes('Grep'), 'gsd-code-reviewer missing Grep tool');
    assert.ok(frontmatter.includes('Write'), 'gsd-code-reviewer missing Write tool');
  });

  test('gsd-code-fixer.md has Read, Edit, Write, Bash, Grep, Glob tools', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-fixer.md'), 'utf-8');
    const frontmatter = content.split('---')[1] || '';

    assert.ok(frontmatter.includes('Read'), 'gsd-code-fixer missing Read tool');
    assert.ok(frontmatter.includes('Edit'), 'gsd-code-fixer missing Edit tool');
    assert.ok(frontmatter.includes('Write'), 'gsd-code-fixer missing Write tool');
    assert.ok(frontmatter.includes('Bash'), 'gsd-code-fixer missing Bash tool');
  });

  test('gsd-code-reviewer.md does not have skills: in frontmatter', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-reviewer.md'), 'utf-8');
    const frontmatter = content.split('---')[1] || '';

    assert.ok(!frontmatter.includes('skills:'),
      'gsd-code-reviewer has skills: in frontmatter — breaks Gemini CLI');
  });

  test('gsd-code-fixer.md does not have skills: in frontmatter', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-fixer.md'), 'utf-8');
    const frontmatter = content.split('---')[1] || '';

    assert.ok(!frontmatter.includes('skills:'),
      'gsd-code-fixer has skills: in frontmatter — breaks Gemini CLI');
  });

  test('gsd-code-fixer.md rollback uses git checkout (not Write tool)', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-fixer.md'), 'utf-8');
    assert.ok(content.includes('git checkout --'),
      'gsd-code-fixer rollback should use git checkout -- {file} for atomic rollback');
    assert.ok(!content.includes('PRE_FIX_CONTENT'),
      'gsd-code-fixer should not use PRE_FIX_CONTENT in-memory capture (use git checkout instead)');
  });

  test('gsd-code-fixer.md success_criteria consistent with rollback strategy (git checkout)', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-fixer.md'), 'utf-8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own agent .md content, fixed-size author-controlled content
    const successCriteria = content.match(/<success_criteria>([\s\S]*?)<\/success_criteria>/)?.[1] || '';
    assert.ok(successCriteria.includes('git checkout'),
      'gsd-code-fixer success_criteria must reference git checkout rollback');
    assert.ok(!successCriteria.includes('Write tool with captured'),
      'gsd-code-fixer success_criteria must not say Write tool for rollback');
  });

  test('gsd-code-fixer.md flags logic-bug fixes for human review', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-fixer.md'), 'utf-8');
    assert.ok(content.includes('requires human verification'),
      'gsd-code-fixer should flag logic-bug fixes as requiring human verification');
  });

  test('gsd-code-reviewer.md REVIEW.md spec includes files_reviewed_list field', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-reviewer.md'), 'utf-8');
    assert.ok(content.includes('files_reviewed_list'),
      'gsd-code-reviewer REVIEW.md frontmatter spec must include files_reviewed_list for --auto scope persistence');
  });

  // #2825: gsd-code-fixer is the only writer that hand-rolls a git worktree; it
  // must honor workflow.use_worktrees (the documented opt-out) like its four
  // sibling writer workflows, and never rm -rf a possible Windows reparse point.
  test('#2825 gsd-code-fixer.md reads workflow.use_worktrees and gates git worktree add on it', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-fixer.md'), 'utf-8');
    assert.ok(
      content.includes('workflow.use_worktrees'),
      'gsd-code-fixer setup_worktree must read the workflow.use_worktrees config flag (#2825)',
    );
    // The git worktree add must be CONDITIONAL on the flag, not unconditional.
    // Locate the worktree-add line and confirm a USE_WORKTREES gate precedes it.
    assert.ok(
      /USE_WORKTREES=.false./.test(content) || content.includes('if [ "$USE_WORKTREES" = "false" ]'),
      'gsd-code-fixer must gate worktree creation on USE_WORKTREES=false (skip when opted out) (#2825)',
    );
  });

  test('#2825 gsd-code-fixer.md forbids rm -rf on a possible reparse point (Windows junction safety)', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-fixer.md'), 'utf-8');
    assert.ok(
      /rm -rf.*reparse point|reparse point.*rm -rf|NEVER .rm -rf.|never use .rm -rf/i.test(content),
      'gsd-code-fixer must forbid rm -rf on a possible reparse point/junction (#2825) — on Windows that is the delete-the-target path',
    );
  });

  test('#2825 gsd-code-fixer.md records where verification ran (main checkout vs worktree)', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-code-fixer.md'), 'utf-8');
    assert.ok(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own agent .md content, fixed-size author-controlled content
      /verification[\s\S]*(main checkout|worktree)|(main checkout|worktree)[\s\S]*verification/i.test(content),
      'gsd-code-fixer REVIEW-FIX.md must record where verification ran (main checkout vs worktree) so a reader knows if the numbers are reproducible (#2825)',
    );
  });
});

// --- CR-CMD: code review command structure ---

describe('CR-CMD: code review command structure', () => {
  test('code-review.md has correct frontmatter name: gsd:code-review', () => {
    const content = fs.readFileSync(path.join(COMMANDS_DIR, 'code-review.md'), 'utf-8');
    const frontmatter = content.split('---')[1] || '';

    assert.ok(frontmatter.includes('name: gsd:code-review'),
      'code-review.md missing correct name in frontmatter');
  });

  // #2790: code-review-fix.md was consolidated into code-review.md as the --fix flag.
  test('code-review.md has --fix flag absorbing code-review-fix (#2790)', () => {
    const content = fs.readFileSync(path.join(COMMANDS_DIR, 'code-review.md'), 'utf-8');
    assert.ok(content.includes('--fix'),
      'code-review.md must document --fix flag (absorbed code-review-fix)');
  });

  test('code-review.md references workflow: code-review.md', () => {
    const content = fs.readFileSync(path.join(COMMANDS_DIR, 'code-review.md'), 'utf-8');

    assert.ok(content.includes('code-review.md'),
      'code-review.md does not reference its workflow');
  });

  test('code-review.md references code-review-fix workflow via --fix (#2790)', () => {
    const content = fs.readFileSync(path.join(COMMANDS_DIR, 'code-review.md'), 'utf-8');
    assert.ok(content.includes('code-review-fix') || content.includes('--fix'),
      'code-review.md must reference code-review-fix workflow or --fix flag');
  });

  test('code-review.md has argument-hint in frontmatter', () => {
    const content = fs.readFileSync(path.join(COMMANDS_DIR, 'code-review.md'), 'utf-8');
    const frontmatter = content.split('---')[1] || '';

    assert.ok(frontmatter.includes('argument-hint:'),
      'code-review.md missing argument-hint');
  });

  test('code-review.md argument-hint includes --fix flag (#2790: absorbed code-review-fix)', () => {
    const content = fs.readFileSync(path.join(COMMANDS_DIR, 'code-review.md'), 'utf-8');
    const frontmatter = content.split('---')[1] || '';
    assert.ok(frontmatter.includes('argument-hint:') && content.includes('--fix'),
      'code-review.md must have argument-hint with --fix');
  });

  test('code-review.md has allowed-tools in frontmatter', () => {
    const content = fs.readFileSync(path.join(COMMANDS_DIR, 'code-review.md'), 'utf-8');
    const frontmatter = content.split('---')[1] || '';

    assert.ok(frontmatter.includes('allowed-tools:'),
      'code-review.md missing allowed-tools');
  });

  test('code-review.md has allowed-tools in frontmatter (covers fix too, #2790)', () => {
    const content = fs.readFileSync(path.join(COMMANDS_DIR, 'code-review.md'), 'utf-8');
    const frontmatter = content.split('---')[1] || '';
    assert.ok(frontmatter.includes('allowed-tools:'),
      'code-review.md missing allowed-tools');
  });
});

// --- CR-WORKFLOW: code review workflow structure ---

describe('CR-WORKFLOW: code review workflow structure', () => {
  test('code-review.md workflow has <step name="initialize">', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review.md'), 'utf-8');

    assert.ok(content.includes('<step name="initialize">'),
      'code-review.md workflow missing initialize step');
  });

  test('code-review.md workflow has <step name="check_config_gate">', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review.md'), 'utf-8');

    assert.ok(content.includes('<step name="check_config_gate">'),
      'code-review.md workflow missing check_config_gate step');
  });

  test('code-review.md workflow references gsd-code-reviewer agent', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review.md'), 'utf-8');

    assert.ok(content.includes('gsd-code-reviewer'),
      'code-review.md workflow does not reference gsd-code-reviewer agent');
  });

  test('code-review-fix.md workflow has <step name="initialize">', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review-fix.md'), 'utf-8');

    assert.ok(content.includes('<step name="initialize">'),
      'code-review-fix.md workflow missing initialize step');
  });

  test('code-review-fix.md workflow references gsd-code-fixer agent', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review-fix.md'), 'utf-8');

    assert.ok(content.includes('gsd-code-fixer'),
      'code-review-fix.md workflow does not reference gsd-code-fixer agent');
  });

  test('code-review-fix.md workflow has iteration cap', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review-fix.md'), 'utf-8');

    // Check for iteration logic with cap
    assert.ok(content.includes('MAX_ITERATIONS') || (content.includes('3') && content.includes('iteration')),
      'code-review-fix.md workflow missing iteration cap logic');
  });

  test('code-review.md --files path traversal guard rejects paths outside repo', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review.md'), 'utf-8');
    // Guard must resolve and compare against REPO_ROOT
    assert.ok(content.includes('REPO_ROOT') && content.includes('realpath'),
      'code-review.md missing path traversal guard (realpath + REPO_ROOT check)');
    assert.ok(content.includes('File path outside repository'),
      'code-review.md missing rejection message for paths outside repo');
  });

  test('code-review.md uses portable while-read loop for array dedup (not mapfile)', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review.md'), 'utf-8');
    // mapfile is bash 4+ only; macOS ships bash 3.2. Dedup must use portable while-read.
    // Note: 'mapfile' may appear in platform_notes documentation — check bash code blocks only
    const codeBlocks = extractBashBlocks(content);
    const hasMapfileInCode = codeBlocks.some(block => block.includes('mapfile -t'));
    assert.ok(!hasMapfileInCode,
      'code-review.md bash code blocks use mapfile which is bash 4+ only — breaks macOS default bash 3.2');
    assert.ok(content.includes('while IFS= read -r'),
      'code-review.md should use portable while-read loop instead of mapfile');
  });

  test('code-review-fix.md uses portable while-read loop for array construction (not mapfile)', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review-fix.md'), 'utf-8');
    const codeBlocks = extractBashBlocks(content);
    const hasMapfileInCode = codeBlocks.some(block => block.includes('mapfile -t'));
    assert.ok(!hasMapfileInCode,
      'code-review-fix.md bash code blocks use mapfile which is bash 4+ only — breaks macOS default bash 3.2');
    assert.ok(content.includes('while IFS= read -r'),
      'code-review-fix.md should use portable while-read loop instead of mapfile');
  });

  // #3661: configurable code-review hook point (see .gsd/phase/feat-3661-code-review-hook-point/
  // 40-design.md and 50-test-matrix.md Section G) — manual invocation reads
  // workflow.code_review directly (independent of the automatic loop-point
  // selector workflow.code_review_point) instead of gating on registry
  // presence at the hardcoded execute:post point; and Tier 2/3 file scoping
  // narrows to what changed since the phase's last review.
  describe('#3661: configurable code-review hook point (test matrix Section G)', () => {
    function extractStepBody(content, stepName) {
      const re = new RegExp(`<step name="${stepName}">([\\s\\S]*?)<\\/step>`);
      const m = content.match(re);
      return m ? m[1] : null;
    }

    test('G1: checkConfigGateReadsCodeReviewConfigDirectly', () => {
      const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review.md'), 'utf-8');
      const stepContent = extractStepBody(content, 'check_config_gate');
      assert.ok(stepContent, 'code-review.md missing check_config_gate step');

      assert.ok(/gsd_run query config-get workflow\.code_review\b/.test(stepContent),
        'check_config_gate must read workflow.code_review via gsd_run query config-get');
    });

    test('G2: checkConfigGateNoLongerProbesExecutePostHooks', () => {
      const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review.md'), 'utf-8');
      const stepContent = extractStepBody(content, 'check_config_gate');
      assert.ok(stepContent, 'code-review.md missing check_config_gate step');

      assert.ok(!stepContent.includes('render-hooks execute:post'),
        'check_config_gate must no longer gate on render-hooks execute:post — manual invocation must work regardless of workflow.code_review_point');
    });

    test('G3: computeFileScopeDerivesLastReviewCommit', () => {
      const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review.md'), 'utf-8');
      const stepContent = extractStepBody(content, 'compute_file_scope');
      assert.ok(stepContent, 'code-review.md missing compute_file_scope step');

      assert.ok(
        /LAST_REVIEW_COMMIT=\$\(git log --format=%H -1 -- "\$\{PHASE_DIR\}\/\$\{PADDED_PHASE\}-REVIEW\.md"/.test(stepContent),
        'compute_file_scope must derive LAST_REVIEW_COMMIT from the phase REVIEW.md git history',
      );
    });

    test('G4: tier2SkipsUnchangedSummariesSinceLastReview', () => {
      const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review.md'), 'utf-8');
      const codeBlocks = extractBashBlocks(content);
      const tier2Block = codeBlocks.find(block =>
        block.includes('for summary in $(printf') && block.includes('LAST_REVIEW_COMMIT'));
      assert.ok(tier2Block, 'code-review.md Tier 2 SUMMARY loop must reference LAST_REVIEW_COMMIT');

      assert.ok(
        /git diff --quiet "\$\{LAST_REVIEW_COMMIT\}" HEAD -- "\$summary"/.test(tier2Block),
        'Tier 2 must contain a `git diff --quiet "${LAST_REVIEW_COMMIT}" HEAD -- "$summary"` skip-conditional',
      );
      assert.ok(/\bcontinue\b/.test(tier2Block),
        'Tier 2 unchanged-since-last-review guard must `continue` (skip) the summary, not just log');
    });

    test('G5: tier3PrefersLastReviewCommitOverPhaseStartDerivation', () => {
      const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review.md'), 'utf-8');
      const codeBlocks = extractBashBlocks(content);
      // #3995 replaced the old commit-message-grep PHASE_COMMITS derivation with
      // PHASE_START (git log --diff-filter=A -- "${PHASE_DIR}") — a phase number is
      // only unique within a milestone, not the whole repo, so #3661's fallback
      // chain rides on whichever derivation is current rather than pinning the old name.
      const tier3Block = codeBlocks.find(block =>
        block.includes('DIFF_BASE=""') && block.includes('PHASE_START'));
      assert.ok(tier3Block, 'code-review.md Tier 3 DIFF_BASE derivation block not found');

      const lastReviewIdx = tier3Block.indexOf('if [ -n "$LAST_REVIEW_COMMIT" ]; then');
      const phaseStartElifIdx = tier3Block.indexOf('elif [ -n "$PHASE_START" ]; then');
      assert.ok(lastReviewIdx !== -1, 'Tier 3 DIFF_BASE must check LAST_REVIEW_COMMIT');
      assert.ok(phaseStartElifIdx !== -1, 'Tier 3 DIFF_BASE must fall back to PHASE_START via elif (#3995 derivation unchanged)');
      assert.ok(lastReviewIdx < phaseStartElifIdx,
        'LAST_REVIEW_COMMIT must be checked BEFORE the PHASE_START fallback, so a prior review narrows the diff base');
      assert.ok(/DIFF_BASE="\$LAST_REVIEW_COMMIT"/.test(tier3Block),
        'Tier 3 must set DIFF_BASE directly from LAST_REVIEW_COMMIT when present (no ^ parent offset)');
    });

    test('G6: tier2GuardIsNoOpWhenLastReviewCommitEmpty', () => {
      const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review.md'), 'utf-8');
      const codeBlocks = extractBashBlocks(content);
      const tier2Block = codeBlocks.find(block =>
        block.includes('for summary in $(printf') && block.includes('LAST_REVIEW_COMMIT'));
      assert.ok(tier2Block, 'code-review.md Tier 2 SUMMARY loop must reference LAST_REVIEW_COMMIT');

      // The skip-conditional's guard must require LAST_REVIEW_COMMIT to be
      // non-empty (`[ -n "$LAST_REVIEW_COMMIT" ]`) as the FIRST operand of an
      // `&&` chain, so on a phase's first review (LAST_REVIEW_COMMIT="") the
      // conditional is structurally a no-op — bash short-circuits `&&` before
      // ever reaching `git diff --quiet`, so nothing can be skipped.
      assert.ok(
        /if \[ -n "\$LAST_REVIEW_COMMIT" \] && git diff --quiet/.test(tier2Block),
        'Tier 2 skip-conditional must guard on `[ -n "$LAST_REVIEW_COMMIT" ]` as the first `&&` operand, so it is a structural no-op when LAST_REVIEW_COMMIT is empty (first review)',
      );
    });
  });
});

// --- CR-CONFIG: config key registration ---

describe('CR-CONFIG: config key registration', () => {
  test('config-set accepts workflow.code_review', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools('config-set workflow.code_review true', tmpDir);
      assert.ok(result.success, `config-set should accept workflow.code_review: ${result.error}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('config-set accepts workflow.code_review_depth', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools('config-set workflow.code_review_depth standard', tmpDir);
      assert.ok(result.success, `config-set should accept workflow.code_review_depth: ${result.error}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('config-get workflow.code_review returns value set via config-set', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const setResult = runGsdTools(['config-set', 'workflow.code_review', 'true'], tmpDir);
    assert.ok(setResult.success, `config-set workflow.code_review failed: ${setResult.error}`);

    const getResult = runGsdTools(['config-get', 'workflow.code_review'], tmpDir);
    assert.ok(getResult.success, `config-get workflow.code_review failed: ${getResult.error}`);
    assert.strictEqual(getResult.output, 'true',
      `workflow.code_review should return "true", got ${getResult.output}`);
  });

  test('config-get workflow.code_review_depth returns value set via config-set', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const setResult = runGsdTools(['config-set', 'workflow.code_review_depth', 'standard'], tmpDir);
    assert.ok(setResult.success, `config-set workflow.code_review_depth failed: ${setResult.error}`);

    const getResult = runGsdTools(['config-get', 'workflow.code_review_depth'], tmpDir);
    assert.ok(getResult.success, `config-get workflow.code_review_depth failed: ${getResult.error}`);
    assert.strictEqual(getResult.output, '"standard"',
      `workflow.code_review_depth should return '"standard"', got ${getResult.output}`);
  });

  // ── #3661: workflow.code_review_point — CLI-behavioral (50-test-matrix.md
  //    Section F, rows F4-F7). Uses createTempGitProject + runGsdTools + the real
  //    gsd-tools subprocess (via runNode), not source-grep, per the matrix's
  //    coverage-strategy note.

  function renderHooksEnvelope(tmpDir, point) {
    const result = runNode(
      [GSD_TOOLS_BIN, 'loop', 'render-hooks', point, '--cwd', tmpDir],
      { cwd: REPO_ROOT, timeoutMs: 15000 },
    );
    assert.strictEqual(result.exitCode, 0, `Expected exit 0 for render-hooks ${point}. stderr: ` + (result.stderr || ''));
    return JSON.parse(result.stdout.trim());
  }

  test('F4: renderHooksExecutePostActiveByDefault', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));

    const envelope = renderHooksEnvelope(tmpDir, 'execute:post');
    const step = envelope.activeHooks.find((h) => h.capId === 'code-review' && h.kind === 'step');
    assert.ok(step, 'Expected an active code-review step at execute:post by default. Got: ' + JSON.stringify(envelope.activeHooks));
  });

  test('F5: renderHooksExecuteWavePostInactiveByDefault', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));

    const envelope = renderHooksEnvelope(tmpDir, 'execute:wave:post');
    const step = envelope.activeHooks.find((h) => h.capId === 'code-review' && h.kind === 'step');
    assert.strictEqual(step, undefined, 'code-review step must be inactive at execute:wave:post by default (point not selected). Got: ' + JSON.stringify(envelope.activeHooks));
  });

  test('F6: renderHooksFlipsWithConfigSetCodeReviewPoint', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));

    const setResult = runGsdTools(['config-set', 'workflow.code_review_point', 'execute:wave:post'], tmpDir);
    assert.ok(setResult.success, `config-set workflow.code_review_point failed: ${setResult.error}`);

    const postEnvelope = renderHooksEnvelope(tmpDir, 'execute:post');
    const wavePostEnvelope = renderHooksEnvelope(tmpDir, 'execute:wave:post');
    const postStep = postEnvelope.activeHooks.find((h) => h.capId === 'code-review' && h.kind === 'step');
    const wavePostStep = wavePostEnvelope.activeHooks.find((h) => h.capId === 'code-review' && h.kind === 'step');
    assert.strictEqual(postStep, undefined, 'execute:post code-review step must be inactive once flipped to execute:wave:post');
    assert.ok(wavePostStep, 'execute:wave:post code-review step must become active once the point is flipped');
  });

  test('F7: configSetRejectsOutOfEnumCodeReviewPoint', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(['config-set', 'workflow.code_review_point', 'bogus'], tmpDir);
    assert.strictEqual(result.success, false, 'config-set must reject an out-of-enum workflow.code_review_point value');
    assert.match(
      result.error || '',
      /Invalid workflow\.code_review_point/,
      `Expected an enum-rejection error, got: ${result.error}`,
    );

    // The rejected value must not have been persisted.
    const getResult = runGsdTools(['config-get', 'workflow.code_review_point'], tmpDir);
    assert.ok(getResult.success, `config-get workflow.code_review_point failed: ${getResult.error}`);
    assert.notStrictEqual(getResult.output, '"bogus"', 'out-of-enum value must not be silently accepted/persisted');
  });
});

// --- CR-REVIEWER-LANES: optional external source-reviewer dispatch (#4209) ---

describe('CR-REVIEWER-LANES: optional external source-reviewer dispatch (#4209)', () => {
  const workflowContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'code-review.md'), 'utf-8');

  test('code-review.md workflow has <step name="dispatch_reviewer_lanes">', () => {
    assert.ok(workflowContent.includes('<step name="dispatch_reviewer_lanes">'),
      'code-review.md workflow missing dispatch_reviewer_lanes step');
  });

  // #4209 (round 5 review): every prior "one fence, not two" fix in this step was verified by
  // manually extracting a SUB-SLICE of the step and pre-seeding the variables that slice reads
  // (e.g. CODE_REVIEW_POINT set by the test driver, not by the fence itself) — which is exactly
  // why a SIBLING cross-fence bug on CODE_REVIEW_POINT itself went undetected for a full review
  // round even after the EXPLICIT_JOINED/EXPLICIT_REVIEWER_SLUGS instance was fixed. This test
  // extracts and executes the step's ENTIRE bash content as the workflow author's own execution
  // model actually runs it (one process, nothing pre-seeded except genuinely external inputs),
  // and additionally asserts there is exactly one fence — a structural invariant that makes any
  // future accidental re-split fail loudly here instead of silently at runtime.
  function extractDispatchReviewerLanesFences() {
    // eslint-disable-next-line local/no-unbounded-quantifier -- bounded author-controlled workflow markdown
    const stepMatch = workflowContent.match(/<step name="dispatch_reviewer_lanes">([\s\S]*?)<\/step>/);
    const stepLines = splitLines(stepMatch[1]);
    return scanFencedBlocks(stepLines)
      .filter((b) => b.infoString.trim().toLowerCase() === 'bash' && b.closeLineIdx !== -1)
      .map((b) => stepLines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'));
  }

  test('dispatch_reviewer_lanes is exactly one bash fence (no cross-fence variable read can reappear)', () => {
    const fences = extractDispatchReviewerLanesFences();
    assert.equal(fences.length, 1,
      `expected dispatch_reviewer_lanes to be exactly one continuous bash fence, found ${fences.length} — a split fence means any variable set in one and read in another is silently empty (this file's own documented execution model: fenced blocks do not share shell state)`);
  });

  test('dispatch_reviewer_lanes computes CODE_REVIEW_POINT and dispatches in the SAME process, end to end (#4209 round 5)', () => {
    const [fence] = extractDispatchReviewerLanesFences();
    const tmpDir = createTempGitProject();
    const dispatchArgsPath = path.join(tmpDir, 'dispatch-args.txt');
    try {
      // `review-lane dispatch-step --explicit codex` would spawn the REAL `codex` CLI (present on
      // this machine) via runner.runLane, which then blocks on interactive auth with no stdin —
      // a genuine hang, not a test artifact (#4209 round 5, BL-01). This test's subject is the
      // FENCE's own bash control flow (CODE_REVIEW_POINT/EXPLICIT_JOINED computed correctly and
      // threaded into dispatch-step's argv) — not the external CLI dispatch-step goes on to spawn.
      // `gsd_run` stays real for `config-get`/`review-lane explicit-from-argv` (what this test
      // verifies) and is short-circuited ONLY for `review-lane dispatch-step`, whose argv is
      // captured to a file for assertion instead of executed for real.
      const driver = [
        `GSD_TOOLS=${JSON.stringify(GSD_TOOLS_BIN)}`,
        `DISPATCH_ARGS_PATH=${JSON.stringify(dispatchArgsPath)}`,
        'gsd_run() {',
        '  if [ "$1" = "review-lane" ] && [ "$2" = "dispatch-step" ]; then',
        '    printf \'%s\\n\' "$@" > "$DISPATCH_ARGS_PATH"',
        '    cat >/dev/null',
        '    echo \'{"ok":true,"dispatched":false,"selection":{},"results":[]}\'',
        '    return 0',
        '  fi',
        '  node "$GSD_TOOLS" "$@"',
        '}',
        `REPO_ROOT=${JSON.stringify(tmpDir)}`,
        'REVIEW_DEPTH=standard',
        'DIFF_BASE=deadbeef',
        'REVIEW_FILES=(src/foo.ts)',
        'set -- --codex',
        fence,
        'echo "===RESULT==="',
        'echo "CODE_REVIEW_POINT=[$CODE_REVIEW_POINT]"',
        'echo "EXPLICIT_JOINED=[$EXPLICIT_JOINED]"',
      ].join('\n');
      const result = require('node:child_process').spawnSync('bash', ['-c', driver], { cwd: tmpDir, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, `driver failed: stdout=${result.stdout} stderr=${result.stderr}`);
      assert.match(result.stdout, /CODE_REVIEW_POINT=\[execute:post\]/,
        `CODE_REVIEW_POINT must be computed and survive within the SAME fence that later uses it for --point, got: ${result.stdout}`);
      assert.match(result.stdout, /EXPLICIT_JOINED=\[codex\]/,
        `EXPLICIT_JOINED must resolve --codex to its canonical slug within the same fence, got: ${result.stdout}`);
      const dispatchArgs = splitLines(fs.readFileSync(dispatchArgsPath, 'utf-8')).filter(Boolean);
      assert.ok(dispatchArgs.includes('--point'), `dispatch-step argv missing --point: ${dispatchArgs.join(' ')}`);
      assert.equal(dispatchArgs[dispatchArgs.indexOf('--point') + 1], 'execute:post',
        `dispatch-step must receive the SAME CODE_REVIEW_POINT the fence computed, got argv: ${dispatchArgs.join(' ')}`);
      assert.ok(dispatchArgs.includes('--explicit'), `dispatch-step argv missing --explicit: ${dispatchArgs.join(' ')}`);
      assert.equal(dispatchArgs[dispatchArgs.indexOf('--explicit') + 1], 'codex',
        `dispatch-step must receive the SAME EXPLICIT_JOINED the fence computed, got argv: ${dispatchArgs.join(' ')}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('dispatch_reviewer_lanes passes --cap-id/--point to dispatch-step instead of resolving the trait itself', () => {
    // eslint-disable-next-line local/no-unbounded-quantifier -- bounded author-controlled workflow markdown
    const stepMatch = workflowContent.match(/<step name="dispatch_reviewer_lanes">([\s\S]*?)<\/step>/);
    const stepContent = stepMatch[1];
    assert.match(stepContent, /--cap-id code-review --point "\$CODE_REVIEW_POINT"/,
      'must delegate trait resolution to dispatch-step via --cap-id/--point, not scrape loop render-hooks itself (#4209 maintainer redirect: no per-workflow hand-wiring of the gate)');
    assert.ok(!/loop render-hooks/.test(stepContent),
      'the workflow must not call loop render-hooks itself — that belongs to dispatch-step, the reusable seam');
  });

  test('dispatch_reviewer_lanes delegates roster-flag matching to review-lane explicit-from-argv, not an inline node -e (#4209 RQ-02)', () => {
    // eslint-disable-next-line local/no-unbounded-quantifier -- bounded author-controlled workflow markdown
    const stepMatch = workflowContent.match(/<step name="dispatch_reviewer_lanes">([\s\S]*?)<\/step>/);
    const stepContent = stepMatch[1];
    assert.match(stepContent, /review-lane explicit-from-argv -- "\$@"/,
      'must delegate roster/flag matching to the shared explicit-from-argv subcommand');
    assert.ok(!/mergeReviewerLanes/.test(stepContent),
      'the workflow must not re-implement the roster merge inline — that duplicate is exactly what RQ-02 removed');
  });

  // #4209 (maintainer redirect): the trait must be enforced by the shared `dispatch-step` CLI
  // itself, not trusted from a caller-passed boolean — otherwise a second capability reusing this
  // seam gets zero enforcement from declaring the trait alone. These run the REAL command against
  // the REAL first-party capability registry (capabilities/code-review/capability.json), not a
  // stubbed value.
  test('review-lane dispatch-step: --cap-id code-review --point execute:post resolves the real trait as true', () => {
    const tmpDir = createTempGitProject();
    try {
      const result = runNode(
        [GSD_TOOLS_BIN, 'review-lane', 'dispatch-step',
          '--repo-root', tmpDir, '--depth', 'standard', '--base-sha', 'deadbeef',
          '--run-dir', tmpDir, '--cwd', tmpDir, '--explicit', 'not-a-real-reviewer-xyz',
          '--cap-id', 'code-review', '--point', 'execute:post', '--raw'],
        { cwd: REPO_ROOT, timeoutMs: 15000, input: 'src/foo.ts\n' },
      );
      assert.strictEqual(result.exitCode, 0, `expected exit 0, stderr: ${result.stderr || ''}`);
      const parsed = JSON.parse(result.stdout.trim());
      // An unresolvable slug still proves the trait gate was passed: TRAIT_NOT_ENABLED short-
      // circuits before selection is ever attempted (dispatched:false, ok:true), whereas a real
      // selection failure on a resolved (trait-enabled) dispatch is ok:false with selection.errors.
      assert.notStrictEqual(parsed.reason, 'trait_not_enabled',
        `expected the real code-review capability step's trait to be enabled, got: ${JSON.stringify(parsed)}`);
      assert.strictEqual(parsed.ok, false, 'an unresolvable explicit lane past a passed trait gate must still be a reported failure');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('review-lane dispatch-step: an unknown --cap-id resolves the trait as false (fails closed, not open)', () => {
    const tmpDir = createTempGitProject();
    try {
      const result = runNode(
        [GSD_TOOLS_BIN, 'review-lane', 'dispatch-step',
          '--repo-root', tmpDir, '--depth', 'standard', '--base-sha', 'deadbeef',
          '--run-dir', tmpDir, '--cwd', tmpDir, '--explicit', 'codex',
          '--cap-id', 'no-such-capability-xyz', '--point', 'execute:post', '--raw'],
        { cwd: REPO_ROOT, timeoutMs: 15000, input: 'src/foo.ts\n' },
      );
      assert.strictEqual(result.exitCode, 0, `expected exit 0, stderr: ${result.stderr || ''}`);
      const parsed = JSON.parse(result.stdout.trim());
      assert.strictEqual(parsed.dispatched, false, 'a capId whose trait is not enabled must dispatch nothing');
      assert.strictEqual(parsed.reason, 'trait_not_enabled');
      assert.deepStrictEqual(parsed.results, [], 'no lane may run when the trait is not enabled');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('review-lane dispatch-step: omitting --cap-id/--point resolves the trait as false (no context means no opt-in)', () => {
    const tmpDir = createTempGitProject();
    try {
      const result = runNode(
        [GSD_TOOLS_BIN, 'review-lane', 'dispatch-step',
          '--repo-root', tmpDir, '--depth', 'standard', '--base-sha', 'deadbeef',
          '--run-dir', tmpDir, '--cwd', tmpDir, '--explicit', 'codex', '--raw'],
        { cwd: REPO_ROOT, timeoutMs: 15000, input: 'src/foo.ts\n' },
      );
      assert.strictEqual(result.exitCode, 0, `expected exit 0, stderr: ${result.stderr || ''}`);
      const parsed = JSON.parse(result.stdout.trim());
      assert.strictEqual(parsed.reason, 'trait_not_enabled',
        `a caller with no --cap-id/--point context must not be silently opted in, got: ${JSON.stringify(parsed)}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('review-lane dispatch-step: --cap-id without --point warns (misconfigured, not opted out) (#4209 RQ-03)', () => {
    const tmpDir = createTempGitProject();
    try {
      const result = runNode(
        [GSD_TOOLS_BIN, 'review-lane', 'dispatch-step',
          '--repo-root', tmpDir, '--depth', 'standard', '--base-sha', 'deadbeef',
          '--run-dir', tmpDir, '--cwd', tmpDir, '--explicit', 'codex',
          '--cap-id', 'code-review', '--raw'],
        { cwd: REPO_ROOT, timeoutMs: 15000, input: 'src/foo.ts\n' },
      );
      assert.strictEqual(result.exitCode, 0, `expected exit 0, stderr: ${result.stderr || ''}`);
      assert.match(result.stderr, /--cap-id and --point must both be given/,
        `a --cap-id with no --point must warn distinctly from a correct no-context opt-out, got stderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout.trim());
      assert.strictEqual(parsed.reason, 'trait_not_enabled');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('review-lane explicit-from-argv matches CLI flags against the merged roster (#4209 RQ-02)', () => {
    const result = runNode(
      [GSD_TOOLS_BIN, 'review-lane', 'explicit-from-argv', '--', '--codex', '--agy'],
      { cwd: REPO_ROOT, timeoutMs: 15000 },
    );
    assert.strictEqual(result.exitCode, 0, `expected exit 0, stderr: ${result.stderr || ''}`);
    assert.strictEqual(result.stdout.trim(), 'antigravity,codex');
  });

  test('review-lane explicit-from-argv resolves to empty when no known flag is present', () => {
    const result = runNode(
      [GSD_TOOLS_BIN, 'review-lane', 'explicit-from-argv', '--'],
      { cwd: REPO_ROOT, timeoutMs: 15000 },
    );
    assert.strictEqual(result.exitCode, 0, `expected exit 0, stderr: ${result.stderr || ''}`);
    assert.strictEqual(result.stdout.trim(), '');
  });

  test('dispatch_reviewer_lanes step derives explicit flags from the roster, not a hand-maintained list', () => {
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow markdown, bounded author-controlled prose
    const stepMatch = workflowContent.match(/<step name="dispatch_reviewer_lanes">([\s\S]*?)<\/step>/);
    assert.ok(stepMatch, 'dispatch_reviewer_lanes step not found');
    const stepContent = stepMatch[1];

    assert.ok(stepContent.includes('review-lane-descriptor.cjs'),
      'dispatch_reviewer_lanes must derive flags from the canonical review-lane-descriptor roster');
    assert.ok(!/\[\s*['"]--(codex|agy|gemini|claude)['"]/.test(stepContent),
      'dispatch_reviewer_lanes must not hand-maintain a static reviewer-flag array (DOCS-03 / anti-pattern)');
  });

  test('dispatch_reviewer_lanes calls review-lane dispatch-step exactly once', () => {
    // eslint-disable-next-line local/no-unbounded-quantifier -- bounded author-controlled workflow markdown
    const stepMatch = workflowContent.match(/<step name="dispatch_reviewer_lanes">([\s\S]*?)<\/step>/);
    const stepContent = stepMatch[1];
    const calls = stepContent.match(/gsd_run review-lane dispatch-step/g) || [];
    assert.strictEqual(calls.length, 1,
      `dispatch_reviewer_lanes must call review-lane dispatch-step exactly once, found ${calls.length}`);
  });

  test('dispatch_reviewer_lanes passes already-resolved repo root, depth, and base SHA (SAFE-01)', () => {
    // eslint-disable-next-line local/no-unbounded-quantifier -- bounded author-controlled workflow markdown
    const stepMatch = workflowContent.match(/<step name="dispatch_reviewer_lanes">([\s\S]*?)<\/step>/);
    const stepContent = stepMatch[1];
    assert.ok(stepContent.includes('--repo-root "$REPO_ROOT"'), 'must pass already-resolved REPO_ROOT');
    assert.ok(stepContent.includes('--depth "$REVIEW_DEPTH"'), 'must pass already-resolved REVIEW_DEPTH');
    assert.ok(stepContent.includes('--base-sha "$DIFF_BASE"'), 'must pass already-resolved DIFF_BASE');
  });

  test('dispatch_reviewer_lanes explains and skips rather than silently failing when explicit lanes have no resolvable DIFF_BASE', () => {
    // eslint-disable-next-line local/no-unbounded-quantifier -- bounded author-controlled workflow markdown
    const stepMatch = workflowContent.match(/<step name="dispatch_reviewer_lanes">([\s\S]*?)<\/step>/);
    const stepContent = stepMatch[1];
    assert.ok(/\[\s+\${#EXPLICIT_REVIEWER_SLUGS\[@\]}\s+-gt\s+0\s+\]\s+&&\s+\[\s+-z\s+"\$DIFF_BASE"\s+\]/.test(stepContent),
      'must guard against dispatching with an empty DIFF_BASE when lanes were explicitly requested');
    assert.match(stepContent, /no diff base could be resolved/,
      'must explain why explicitly requested lanes did not run, rather than leaving the generic missing_provenance rejection unexplained');
  });

  test('dispatch_reviewer_lanes is a no-op when no explicit reviewer-lane flag is present (COMP-01)', () => {
    // eslint-disable-next-line local/no-unbounded-quantifier -- bounded author-controlled workflow markdown
    const stepMatch = workflowContent.match(/<step name="dispatch_reviewer_lanes">([\s\S]*?)<\/step>/);
    const stepContent = stepMatch[1];
    assert.ok(/if\s*\[\s*\$\{#EXPLICIT_REVIEWER_SLUGS\[@\]\}\s*-gt\s*0\s*\]/.test(stepContent),
      'dispatch_reviewer_lanes must gate the dispatch-step call behind a non-empty explicit selection');
  });

  test('spawn_reviewer prompt interpolates ${EXTERNAL_EVIDENCE_BLOCK}', () => {
    // eslint-disable-next-line local/no-unbounded-quantifier -- bounded author-controlled workflow markdown
    const stepMatch = workflowContent.match(/<step name="spawn_reviewer">([\s\S]*?)<\/step>/);
    assert.ok(stepMatch, 'spawn_reviewer step not found');
    assert.ok(stepMatch[1].includes('${EXTERNAL_EVIDENCE_BLOCK}'),
      'spawn_reviewer must interpolate EXTERNAL_EVIDENCE_BLOCK into the agent prompt');
  });

  test('external evidence block marks findings as unverified and requires re-opening source (CONS-02)', () => {
    assert.ok(/UNVERIFIED/.test(workflowContent) && /re-open|reopen/i.test(workflowContent),
      'external evidence block must mark external findings as unverified and require the internal reviewer to re-open cited source');
  });

  // --- Real subprocess behavior: `review-lane dispatch-step` (fail-closed, no raw fallback) ---

  test('review-lane dispatch-step is a no-op with no --explicit selection', () => {
    const tmpDir = createTempGitProject();
    try {
      const result = runNode(
        [GSD_TOOLS_BIN, 'review-lane', 'dispatch-step',
          '--repo-root', tmpDir, '--depth', 'standard', '--base-sha', 'deadbeef',
          '--run-dir', tmpDir, '--cwd', tmpDir,
          '--cap-id', 'code-review', '--point', 'execute:post', '--raw'],
        { cwd: REPO_ROOT, timeoutMs: 15000, input: 'src/foo.ts\n' },
      );
      assert.strictEqual(result.exitCode, 0, `expected exit 0, stderr: ${result.stderr || ''}`);
      const parsed = JSON.parse(result.stdout.trim());
      assert.strictEqual(parsed.dispatched, false, 'no explicit selection must dispatch zero lanes');
      assert.strictEqual(parsed.reason, 'no_lanes_selected');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('review-lane dispatch-step fails closed on an explicitly requested unknown lane (SAFE-07)', () => {
    const tmpDir = createTempGitProject();
    try {
      const result = runNode(
        [GSD_TOOLS_BIN, 'review-lane', 'dispatch-step',
          '--repo-root', tmpDir, '--depth', 'standard', '--base-sha', 'deadbeef',
          '--run-dir', tmpDir, '--cwd', tmpDir, '--explicit', 'not-a-real-reviewer-xyz',
          '--cap-id', 'code-review', '--point', 'execute:post', '--raw'],
        { cwd: REPO_ROOT, timeoutMs: 15000, input: 'src/foo.ts\n' },
      );
      assert.strictEqual(result.exitCode, 0, `expected exit 0, stderr: ${result.stderr || ''}`);
      const parsed = JSON.parse(result.stdout.trim());
      assert.strictEqual(parsed.dispatched, false, 'an unresolvable explicit lane must plan/invoke nothing');
      assert.strictEqual(parsed.ok, false, 'an explicitly requested unavailable lane must be a failure, not a silent success');
      assert.deepStrictEqual(parsed.results, [], 'no lane fallback result may appear');
      assert.ok(
        (parsed.selection.errors || []).some((e) => e.includes('not-a-real-reviewer-xyz')),
        'the unresolved slug must be named in the selection errors',
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  // --- #4209 R4: execute the actual EVIDENCE_LIST reducer extracted from the workflow, not a
  // reimplementation of it, so a regression in the real markdown fails this test (see B1: the
  // reducer must warn on parsed.ok===false, not just per-lane results[]/selection.errors). ---

  function extractEvidenceReducer() {
    // eslint-disable-next-line local/no-unbounded-quantifier -- bounded author-controlled workflow markdown
    const stepMatch = workflowContent.match(/<step name="dispatch_reviewer_lanes">([\s\S]*?)<\/step>/);
    const stepContent = stepMatch[1];
    const startMarker = 'if [[ "$DISPATCH_JSON" == @file:* ]]; then';
    const start = stepContent.indexOf(startMarker);
    assert.ok(start !== -1, 'expected the EVIDENCE_LIST reducer in dispatch_reviewer_lanes');
    const end = stepContent.indexOf('\n  ")', start);
    assert.ok(end !== -1, 'unterminated EVIDENCE_LIST reducer fence');
    return stepContent.slice(start, end + '\n  ")'.length);
  }

  function runReducer(dispatchJson) {
    const script = `DISPATCH_JSON=${JSON.stringify(dispatchJson)}\n${extractEvidenceReducer()}\necho "$EVIDENCE_LIST"`;
    const result = require('node:child_process').spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 15000 });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  test('EVIDENCE_LIST reducer warns on a whole-dispatch rejection (B1), not just per-lane failures', () => {
    const { stdout, stderr } = runReducer(JSON.stringify({
      dispatched: false, ok: false, reason: 'missing_provenance', results: [],
    }));
    assert.match(stderr, /external reviewer dispatch rejected \(missing_provenance\)/,
      `expected a whole-dispatch rejection warning, got stderr: ${stderr}`);
    assert.strictEqual(stdout.trim(), '', 'a rejected dispatch must produce no evidence lines');
  });

  test('EVIDENCE_LIST reducer still warns per-lane and still emits evidence for lanes that succeeded', () => {
    const { stdout, stderr } = runReducer(JSON.stringify({
      dispatched: true,
      ok: false,
      results: [
        { slug: 'codex', ok: true, reviewPath: '/tmp/gsd-review-codex.md' },
        { slug: 'agy', ok: false, reason: 'invoke_failed', detail: 'binary not found' },
      ],
    }));
    assert.match(stderr, /external reviewer lane 'agy' failed \(invoke_failed: binary not found\)/,
      `expected a per-lane failure warning, got stderr: ${stderr}`);
    assert.strictEqual(stdout.trim(), '- codex: /tmp/gsd-review-codex.md',
      'the lane that succeeded must still produce an evidence line');
  });

  test('EVIDENCE_LIST reducer unwraps the @file: overflow protocol (R1)', () => {
    const tmpDir = createTempGitProject();
    try {
      const payloadPath = path.join(tmpDir, 'dispatch-result.json');
      fs.writeFileSync(payloadPath, JSON.stringify({
        dispatched: true, ok: true,
        results: [{ slug: 'codex', ok: true, reviewPath: '/tmp/gsd-review-codex.md' }],
      }));
      const { stdout, stderr } = runReducer(`@file:${payloadPath}`);
      assert.strictEqual(stdout.trim(), '- codex: /tmp/gsd-review-codex.md',
        `expected the @file:-wrapped payload to be unwrapped and parsed, got stdout: ${stdout} stderr: ${stderr}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// --- CR-INTEGRATION: workflow integration points ---

describe('CR-INTEGRATION: workflow integration points', () => {
  test('execute-phase.md contains code_review_gate step', { skip: !PLUGIN_AVAILABLE ? 'Plugin dir not installed' : false }, () => {
    const content = fs.readFileSync(path.join(PLUGIN_WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8');

    assert.ok(content.includes('code_review_gate'),
      'execute-phase.md missing code_review_gate step name');
  });

  test('execute-phase.md resolves code-review capability hook', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored workflow markdown, bounded prose, not adversarial input
    const gateMatch = content.match(/<step name="code_review_gate"[^>]*>([\s\S]*?)<\/step>/);
    assert.ok(gateMatch, 'execute-phase.md missing code_review_gate step');
    const gateContent = gateMatch[1];

    assert.ok(gateContent.includes('loop render-hooks execute:post'),
      'execute-phase.md code_review_gate must resolve execute:post capability hooks');
    assert.ok(gateContent.includes('ref.skill == "code-review"'),
      'execute-phase.md code_review_gate must identify the code-review capability hook');
    assert.ok(!gateContent.match(/config-get\s+workflow\.code_review/),
      'execute-phase.md code_review_gate must not read workflow.code_review directly');
  });

  // #3661: the generic execute:wave:post step-dispatch contract
  // (loop-hook-dispatch.md § step) invokes `Skill(skill="gsd-<ref.skill>")` with no
  // phase argument, but code-review.md's `initialize` step requires one positionally
  // (`PHASE_ARG="${1}"`) — without it the review reports "Phase not found" and exits.
  // Caught by the orthogonal spec review; fixed with a precedented carve-out in step
  // 5.75 mirroring code_review_gate's own `args="${PHASE_NUMBER}"` invocation.
  test('execute-phase.md wave-post dispatch passes PHASE_NUMBER to the code-review skill', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow markdown, bounded author-controlled prose
    const stepMatch = content.match(/5\.75\.[\s\S]*?(?=\r?\n5\.8\.)/);
    assert.ok(stepMatch, 'execute-phase.md missing step 5.75 (execute:wave:post capability dispatch)');
    const stepContent = stepMatch[0];

    assert.ok(stepContent.includes('ref.skill == "code-review"'),
      'step 5.75 must carve out ref.skill == "code-review" from the generic step-dispatch contract');
    assert.ok(/Skill\(skill="gsd-code-review",\s*args="\$\{PHASE_NUMBER\}"\)/.test(stepContent),
      'step 5.75 must dispatch code-review with an explicit args="${PHASE_NUMBER}", matching code_review_gate\'s invocation — the bare generic Skill(skill="gsd-<ref.skill>") form has no phase argument and code-review.md requires one');
  });

  test('execute-phase.md does NOT contain ls.*REVIEW.md.*head pattern', { skip: !PLUGIN_AVAILABLE ? 'Plugin dir not installed' : false }, () => {
    const content = fs.readFileSync(path.join(PLUGIN_WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8');

    // Extract code_review_gate section to check
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
    const gateMatch = content.match(/<step name="code_review_gate">([\s\S]*?)<\/step>/);
    if (gateMatch) {
      const gateContent = gateMatch[1];
      assert.ok(!gateContent.match(/ls.*REVIEW\.md.*head/),
        'execute-phase.md code_review_gate uses non-deterministic glob pattern (ls | head)');
    }
  });

  test('quick.md contains code-review invocation', { skip: !PLUGIN_AVAILABLE ? 'Plugin dir not installed' : false }, () => {
    const content = fs.readFileSync(path.join(PLUGIN_WORKFLOWS_DIR, 'quick.md'), 'utf-8');

    assert.ok(content.includes('code-review') || content.includes('code_review'),
      'quick.md missing code-review invocation');
  });

  test('quick.md resolves code-review capability hook', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'quick.md'), 'utf-8');
    const start = content.indexOf('**Step 6.25: Code review (auto)**');
    // #2994 (pre-existing since #2994's earlier quick-verification.md extraction,
    // 18ff35d20): Step 6.5's content moved into
    // gsd-core/workflows/quick/steps/quick-verification.md behind a
    // `<!-- gsd:section id="quick-verification" -->` marker, so the literal
    // "**Step 6.5: Verification" heading text no longer follows Step 6.25 in
    // this file — the marker is the correct end-of-step delimiter now (mirrors
    // phase6-review-capabilities.test.cjs's identical retarget for the same move).
    const end = content.indexOf('<!-- gsd:section id="quick-verification"', start);
    assert.ok(start !== -1 && end !== -1, 'quick.md missing Step 6.25 code review section');
    const reviewContent = content.slice(start, end);

    assert.ok(reviewContent.includes('loop render-hooks execute:post'),
      'quick.md code review step must resolve execute:post capability hooks');
    assert.ok(reviewContent.includes('ref.skill == "code-review"'),
      'quick.md code review step must identify the code-review capability hook');
    assert.ok(!reviewContent.match(/config-get\s+workflow\.code_review/),
      'quick.md code review step must not read workflow.code_review directly');
  });

  // autonomous.md tests read from the repo's canonical workflow source (WORKFLOWS_DIR),
  // not the user-installed plugin dir. The plugin dir can lag behind the repo until the
  // user re-installs, so asserting against it produces false negatives. The repo file
  // is the source of truth and is always present in CI checkouts.
  test('autonomous.md contains gsd-code-review skill invocation', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'autonomous.md'), 'utf-8');

    // Parse Skill(...) invocations into structured objects and assert canonical
    // hyphen form is referenced. Canonical command form is hyphen
    // (gsd-code-review); colon form (gsd:code-review) is the legacy
    // frontmatter-name form removed in PR #2819.
    const invocations = parseWorkflowSkillInvocations(content);
    const skillNames = invocations.map(inv => inv.skill);
    assert.ok(skillNames.includes('gsd-code-review'),
      `autonomous.md must invoke Skill(skill="gsd-code-review", ...); found skills: ${JSON.stringify(skillNames)}`);
    assert.ok(!skillNames.includes('gsd:code-review'),
      'autonomous.md must not use legacy colon form gsd:code-review (canonical is hyphen form)');
  });

  test('autonomous.md auto-fix uses consolidated gsd-code-review --fix invocation (#2790)', () => {
    // After #2790, gsd-code-review-fix was absorbed into gsd-code-review as
    // the --fix flag. The autonomous workflow must invoke the consolidated
    // form, not the deleted gsd-code-review-fix skill.
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'autonomous.md'), 'utf-8');

    const invocations = parseWorkflowSkillInvocations(content);
    const skillNames = invocations.map(inv => inv.skill);
    assert.ok(!skillNames.includes('gsd-code-review-fix'),
      `autonomous.md must not invoke deleted gsd-code-review-fix skill (consolidated into --fix); found: ${JSON.stringify(skillNames)}`);
    assert.ok(!skillNames.includes('gsd:code-review-fix'),
      'autonomous.md must not use legacy colon form gsd:code-review-fix');

    // Find a gsd-code-review invocation that carries the --fix flag (the
    // consolidated auto-fix entry point).
    const fixInvocation = invocations.find(inv => {
      if (inv.skill !== 'gsd-code-review') return false;
      const tokens = new Set((inv.args ?? '').split(/\s+/).filter(Boolean));
      return tokens.has('--fix');
    });
    assert.ok(fixInvocation,
      `autonomous.md must invoke Skill(skill="gsd-code-review", args="... --fix ...") for auto-fix; found: ${JSON.stringify(invocations)}`);
  });

  test('autonomous.md contains --auto flag on consolidated --fix invocation (#2790)', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'autonomous.md'), 'utf-8');

    // Find the gsd-code-review invocation that carries --fix (the consolidated
    // auto-fix entry point), then assert --auto is one of its arg tokens.
    // Tokenize via whitespace-split to avoid substring matches that could
    // conflate --auto with --auto-foo.
    const invocations = parseWorkflowSkillInvocations(content);
    const fixInvocation = invocations.find(inv => {
      if (inv.skill !== 'gsd-code-review') return false;
      const tokens = new Set((inv.args ?? '').split(/\s+/).filter(Boolean));
      return tokens.has('--fix');
    });
    assert.ok(fixInvocation, 'autonomous.md missing Skill(skill="gsd-code-review", args="... --fix ...") invocation');
    const argTokens = new Set((fixInvocation.args ?? '').split(/\s+/).filter(Boolean));
    assert.ok(argTokens.has('--auto'),
      `autonomous.md gsd-code-review-fix args missing --auto flag; got args="${fixInvocation.args}"`);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2839-review-fix-transactional-cleanup.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2839-review-fix-transactional-cleanup (consolidation epic #1969 B8 #1977)", () => {
/**
 * Regression test for bug #2839
 *
 * /gsd-code-review-fix cleanup tail is non-transactional. If the agent is
 * interrupted (system restart, OOM kill) AFTER the last fix commit but
 * BEFORE `git worktree remove`, the worktree is orphaned in
 * `git worktree list`, the agent's branch is left with unmerged commits,
 * and STATE.md is never advanced. To anyone reading main only, the phase
 * looks "ready to plan" while critical fixes sit on a dangling branch.
 *
 * Fix: introduce a recovery sentinel JSON at
 *   ${PHASE_DIR}/.review-fix-recovery-pending.json
 * The sentinel is written AFTER `git worktree add` succeeds and
 * REMOVED only after `git worktree remove` completes, so the cleanup
 * tail is transactional from the orchestrator's perspective. If the
 * process dies in between, the sentinel is left behind pointing at the
 * orphan worktree and branch — a future run, /gsd-resume-work, or
 * /gsd-progress can detect and complete the recovery.
 */

'use strict';

// allow-test-rule: source-text-is-the-product (see #2839)
// The gsd-code-fixer agent's working instructions ARE the product — Claude
// follows them at runtime. Structural assertions over the markdown source
// test the deployed contract. See bug-2686 for the same pattern.

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseFrontmatter } = require('./helpers.cjs');

const SENTINEL_NAME = '.review-fix-recovery-pending.json';

function extractStep(content, stepName) {
  const re = new RegExp(`<step\\s+name="${stepName}">([\\s\\S]*?)</step>`);
  const m = content.match(re);
  return m ? m[1] : null;
}

describe('bug-2839: /gsd-code-review-fix cleanup is transactional', () => {
  let agentPath;
  let agentContent;
  let frontmatter;

  before(() => {
    agentPath = path.join(__dirname, '..', 'agents', 'gsd-code-fixer.md');
    assert.ok(fs.existsSync(agentPath), 'agents/gsd-code-fixer.md must exist');
    agentContent = fs.readFileSync(agentPath, 'utf-8');
    frontmatter = parseFrontmatter(agentContent);
    assert.ok(frontmatter, 'agent must have YAML frontmatter');
  });

  test('agent declares a recovery sentinel filename', () => {
    assert.ok(
      agentContent.includes(SENTINEL_NAME),
      `gsd-code-fixer.md must reference the recovery sentinel ${SENTINEL_NAME} so an interrupted cleanup tail is discoverable (#2839)`
    );
  });

  test('sentinel is written inside setup_worktree, after git worktree add', () => {
    const setupStep = extractStep(agentContent, 'setup_worktree');
    assert.ok(setupStep, 'setup_worktree step must exist');

    assert.ok(
      setupStep.includes(SENTINEL_NAME),
      `setup_worktree must reference ${SENTINEL_NAME} so the sentinel is created at the start of the run (#2839)`
    );

    const addPos = setupStep.indexOf('git worktree add');
    assert.ok(addPos !== -1, 'setup_worktree must contain `git worktree add`');

    // The sentinel WRITE (not just a reference) must come after `git worktree add`.
    // Earlier references are allowed (e.g. recovery check for a stale sentinel
    // from a prior interrupted run). Look for an explicit write — either a
    // shell `>`/`>>` redirection, a `node -e` invocation that uses
    // `fs.writeFileSync(...sentinel...)`, or a `Write` tool reference.
    const writeIdx = (() => {
      const candidates = [
        /fs\.writeFileSync\([^)]*sentinel/,
        />\s*"?\$sentinel/,
        />\s*"?\$\{sentinel\}/,
        /Write the recovery sentinel/i,
      ];
      let earliest = -1;
      for (const re of candidates) {
        const m = re.exec(setupStep);
        if (m && (earliest === -1 || m.index < earliest)) earliest = m.index;
      }
      return earliest;
    })();
    assert.ok(
      writeIdx !== -1,
      'setup_worktree must explicitly describe writing the sentinel (#2839)'
    );
    assert.ok(
      addPos < writeIdx,
      'sentinel must be written AFTER `git worktree add` succeeds (#2839)'
    );
  });

  test('sentinel records worktree path, branch, and padded_phase as JSON fields', () => {
    for (const key of ['worktree_path', 'branch', 'padded_phase']) {
      assert.ok(
        agentContent.includes(key),
        `recovery sentinel must record \`${key}\` so a future /gsd-resume-work or /gsd-progress can locate the orphan state (#2839)`
      );
    }
  });

  test('sentinel removal happens only AFTER git worktree remove succeeds', () => {
    const setupStep = extractStep(agentContent, 'setup_worktree');
    assert.ok(setupStep, 'setup_worktree step must exist');

    const cleanupAnchor = setupStep.lastIndexOf('Cleanup tail (transactional');
    assert.ok(cleanupAnchor !== -1, 'setup_worktree must document cleanup-tail section');
    const cleanupSection = setupStep.slice(cleanupAnchor);

    const removeIdx = cleanupSection.indexOf('git worktree remove "$wt" --force');
    assert.ok(removeIdx !== -1, 'cleanup-tail must remove worktree');

    // Within the cleanup-tail section, accept either a literal-filename form
    // (`rm -f .../.review-fix-recovery-pending.json`) or a shell-variable form
    // referring to the previously-declared `sentinel` variable
    // (`rm -f "$sentinel"` / `rm -f "${sentinel}"`).
    const escapedName = escapeRegex(SENTINEL_NAME);
    const sentinelRemovalRe = new RegExp(
      `(rm\\s+(?:-f\\s+)?[^\\n]*(?:${escapedName}|\\$\\{?sentinel\\}?)|unlink[^\\n]*(?:${escapedName}|\\$\\{?sentinel\\}?))`
    );
    const sentinelRemovalMatch = sentinelRemovalRe.exec(cleanupSection);
    assert.ok(
      sentinelRemovalMatch,
      `agent must remove the sentinel file (rm or unlink ${SENTINEL_NAME}) as part of the cleanup tail (#2839)`
    );
    const sentinelRemovalIdx = sentinelRemovalMatch.index;

    assert.ok(
      removeIdx < sentinelRemovalIdx,
      'cleanup ordering must be: `git worktree remove` BEFORE sentinel removal (#2839)'
    );
  });

  test('agent documents detection of pre-existing sentinel from a prior interrupted run', () => {
    const lower = agentContent.toLowerCase();
    const mentionsRecovery =
      lower.includes('stale sentinel') ||
      lower.includes('existing sentinel') ||
      lower.includes('previous sentinel') ||
      lower.includes('prior run') ||
      lower.includes('pre-existing sentinel') ||
      lower.includes('recovery');
    assert.ok(
      mentionsRecovery,
      'agent must describe how it handles a pre-existing sentinel from a previous interrupted run (#2839)'
    );
  });

  test('cleanup-tail obligation is documented as transactional / atomic', () => {
    const lower = agentContent.toLowerCase();
    const mentionsTransactional =
      lower.includes('transactional') ||
      lower.includes('atomic cleanup') ||
      lower.includes('cleanup tail');
    assert.ok(
      mentionsTransactional,
      'agent must document the cleanup tail as transactional/atomic (#2839)'
    );
  });
});
  });
}

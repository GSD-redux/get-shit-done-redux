// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


/**
 * Planner Language Regression Tests (#2091, #2092)
 *
 * Prevents time-based reasoning and complexity-as-scope-justification
 * from leaking back into planning artifacts via future PRs.
 *
 * These tests scan agent definitions, workflow files, and references
 * for prohibited patterns that import human-world constraints into
 * an AI execution context where those constraints do not exist.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const REFERENCES_DIR = path.join(ROOT, 'gsd-core', 'references');
const TEMPLATES_DIR = path.join(ROOT, 'gsd-core', 'templates');

/**
 * Collect all .md files from a directory (non-recursive).
 */
function mdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, path: path.join(dir, f) }));
}

/**
 * Collect all .md files recursively.
 */
function mdFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...mdFilesRecursive(full));
    } else if (entry.name.endsWith('.md')) {
      results.push({ name: entry.name, path: full });
    }
  }
  return results;
}

/**
 * Files that define planning behavior — agents, workflows, references.
 * These are the files where time-based and complexity-based scope
 * reasoning must never appear.
 */
const PLANNING_FILES = [
  ...mdFiles(AGENTS_DIR),
  ...mdFiles(WORKFLOWS_DIR),
  ...mdFiles(REFERENCES_DIR),
  ...mdFilesRecursive(TEMPLATES_DIR),
];

// -- Prohibited patterns --

/**
 * Time-based task sizing patterns.
 * Matches "15-60 minutes", "X minutes Claude execution time", etc.
 * Does NOT match operational timeouts ("timeout: 5 minutes"),
 * API docs examples ("100 requests per 15 minutes"),
 * or human-readable timeout descriptions in workflow execution steps.
 */
const TIME_SIZING_PATTERNS = [
  // "N-M minutes" in task sizing context (not timeout context)
  /each task[:\s]*\*?\*?\d+[-–]\d+\s*min/i,
  // "minutes Claude execution time" or "minutes execution time"
  /minutes?\s+(claude\s+)?execution\s+time/i,
  // Duration-based sizing table rows: "< 15 min", "15-60 min", "> 60 min"
  /[<>]\s*\d+\s*min\s*\|/i,
];

/**
 * Complexity-as-scope-justification patterns.
 * Matches "too complex to implement", "challenging feature", etc.
 * Does NOT match legitimate uses like:
 *   - "complex domains" in research/discovery context (describing what to research)
 *   - "non-trivial" in verification context (confirming substantive code exists)
 *   - "challenging" in user-profiling context (quoting user reactions)
 */
const COMPLEXITY_SCOPE_PATTERNS = [
  // "too complex to" — always a scope-reduction justification
  /too\s+complex\s+to/i,
  // "too difficult" — always a scope-reduction justification
  /too\s+difficult/i,
  // "is too complex for" — scope justification (e.g. "Phase X is too complex for")
  /is\s+too\s+complex\s+for/i,
];

/**
 * Files allowed to contain certain patterns because they document
 * the prohibition itself, or use the terms in non-scope-reduction context.
 */
const ALLOWLIST = {
  // Plan-checker scans FOR these patterns — it's a detection list, not usage
  'gsd-plan-checker.md': ['complexity_scope', 'time_sizing'],
  // Planner defines the prohibition and the authority limits — uses terms to explain what NOT to do
  'gsd-planner.md': ['complexity_scope'],
  // Debugger uses "30+ minutes" as anti-pattern detection, not task sizing
  'gsd-debugger.md': ['time_sizing'],
  // Doc-writer uses "15 minutes" in API rate limit example, "2 minutes" for doc quality
  'gsd-doc-writer.md': ['time_sizing'],
  // Discovery-phase uses time for level descriptions (operational, not scope)
  'discovery-phase.md': ['time_sizing'],
  // Explore uses "~30 seconds" as operational estimate
  'explore.md': ['time_sizing'],
  // Review uses "up to 5 minutes" for CodeRabbit timeout
  'review.md': ['time_sizing'],
  // Fast uses "under 2 minutes wall time" as operational constraint
  'fast.md': ['time_sizing'],
  // Execute-phase uses a configurable test-gate timeout (workflow.test_gate_timeout, #1857)
  'execute-phase.md': ['time_sizing'],
  // Map-codebase documents subagent_timeout
  'map-codebase.md': ['time_sizing'],
  // Help documents CodeRabbit timing
  'help.md': ['time_sizing'],
};

function isAllowlisted(fileName, category) {
  const entry = ALLOWLIST[fileName];
  return entry && entry.includes(category);
}

// -- Tests --

describe('Planner language regression — time-based task sizing (#2092)', () => {
  for (const file of PLANNING_FILES) {
    test(`${file.name} must not use time-based task sizing`, () => {
      if (isAllowlisted(file.name, 'time_sizing')) return;

      const content = fs.readFileSync(file.path, 'utf-8');
      for (const pattern of TIME_SIZING_PATTERNS) {
        const match = content.match(pattern);
        assert.ok(
          !match,
          [
            `${file.name} contains time-based task sizing: "${match?.[0]}"`,
            'Task sizing must use context-window percentage, not time units.',
            'See issue #2092 for rationale.',
          ].join('\n')
        );
      }
    });
  }
});

describe('Planner language regression — complexity-as-scope-justification (#2092)', () => {
  for (const file of PLANNING_FILES) {
    test(`${file.name} must not use complexity to justify scope reduction`, () => {
      if (isAllowlisted(file.name, 'complexity_scope')) return;

      const content = fs.readFileSync(file.path, 'utf-8');
      for (const pattern of COMPLEXITY_SCOPE_PATTERNS) {
        const match = content.match(pattern);
        assert.ok(
          !match,
          [
            `${file.name} contains complexity-as-scope-justification: "${match?.[0]}"`,
            'Scope decisions must be based on context cost, missing information,',
            'or dependency conflicts — not perceived difficulty.',
            'See issue #2092 for rationale.',
          ].join('\n')
        );
      }
    });
  }
});

describe('gsd-planner.md — required structural sections (#2091, #2092)', () => {
  let plannerContent;

  test('planner file exists and is readable', () => {
    const plannerPath = path.join(AGENTS_DIR, 'gsd-planner.md');
    assert.ok(fs.existsSync(plannerPath), 'agents/gsd-planner.md must exist');
    plannerContent = fs.readFileSync(plannerPath, 'utf-8');
  });

  test('contains <planner_authority_limits> section', () => {
    assert.ok(
      plannerContent.includes('<planner_authority_limits>'),
      'gsd-planner.md must contain a <planner_authority_limits> section defining what the planner cannot decide'
    );
  });

  test('authority limits prohibit difficulty-based scope decisions', () => {
    assert.ok(
      plannerContent.includes('The planner has no authority to'),
      'planner_authority_limits must explicitly state what the planner cannot decide'
    );
  });

  test('authority limits list three legitimate split reasons: context cost, missing info, dependency', () => {
    assert.ok(
      plannerContent.includes('Context cost') || plannerContent.includes('context cost'),
      'authority limits must list context cost as a legitimate split reason'
    );
    assert.ok(
      plannerContent.includes('Missing information') || plannerContent.includes('missing information'),
      'authority limits must list missing information as a legitimate split reason'
    );
    assert.ok(
      plannerContent.includes('Dependency conflict') || plannerContent.includes('dependency conflict'),
      'authority limits must list dependency conflict as a legitimate split reason'
    );
  });

  test('task sizing uses context percentage, not time units', () => {
    assert.ok(
      plannerContent.includes('context consumption') || plannerContent.includes('context cost'),
      'task sizing must reference context consumption, not time'
    );
    assert.ok(
      !(/each task[:\s]*\*?\*?\d+[-–]\d+\s*min/i.test(plannerContent)),
      'task sizing must not use minutes as sizing unit'
    );
  });

  test('contains multi-source coverage audit (not just D-XX decisions)', () => {
    assert.ok(
      plannerContent.includes('Multi-Source Coverage Audit') ||
      plannerContent.includes('multi-source coverage audit'),
      'gsd-planner.md must contain a multi-source coverage audit, not just D-XX decision matrix'
    );
  });

  test('coverage audit includes all four source types: GOAL, REQ, RESEARCH, CONTEXT', () => {
    // The planner file or its referenced planner-source-audit.md must define all four types.
    // The inline compact version uses **GOAL**, **REQ**, **RESEARCH**, **CONTEXT**.
    const refPath = path.join(ROOT, 'gsd-core', 'references', 'planner-source-audit.md');
    const combined = plannerContent + (fs.existsSync(refPath) ? fs.readFileSync(refPath, 'utf-8') : '');

    const hasGoal = combined.includes('**GOAL**');
    const hasReq = combined.includes('**REQ**');
    const hasResearch = combined.includes('**RESEARCH**');
    const hasContext = combined.includes('**CONTEXT**');

    assert.ok(hasGoal, 'coverage audit must include GOAL source type (ROADMAP.md phase goal)');
    assert.ok(hasReq, 'coverage audit must include REQ source type (REQUIREMENTS.md)');
    assert.ok(hasResearch, 'coverage audit must include RESEARCH source type (RESEARCH.md)');
    assert.ok(hasContext, 'coverage audit must include CONTEXT source type (CONTEXT.md decisions)');
  });

  test('coverage audit defines MISSING item handling with developer escalation', () => {
    assert.ok(
      plannerContent.includes('Source Audit: Unplanned Items Found') ||
      plannerContent.includes('MISSING'),
      'coverage audit must define handling for MISSING items'
    );
    assert.ok(
      plannerContent.includes('Awaiting developer decision') ||
      plannerContent.includes('developer confirmation'),
      'MISSING items must escalate to developer, not be silently dropped'
    );
  });
});

describe('plan-phase.md — source audit orchestration (#2091)', () => {
  let workflowContent;

  test('plan-phase workflow exists and is readable', () => {
    const workflowPath = path.join(WORKFLOWS_DIR, 'plan-phase.md');
    assert.ok(fs.existsSync(workflowPath), 'workflows/plan-phase.md must exist');
    workflowContent = fs.readFileSync(workflowPath, 'utf-8');
  });

  test('step 9 handles Source Audit return from planner', () => {
    assert.ok(
      workflowContent.includes('Source Audit: Unplanned Items Found'),
      'plan-phase.md step 9 must handle the Source Audit return from the planner'
    );
  });

  test('step 9c exists for source audit gap handling', () => {
    assert.ok(
      workflowContent.includes('9c') && workflowContent.includes('Source Audit'),
      'plan-phase.md must have a step 9c for handling source audit gaps'
    );
  });

  test('step 9b does not use "too complex" language', () => {
    // Extract just step 9b content (between "## 9b" and "## 9c" or "## 10")
    const step9bMatch = workflowContent.match(/## 9b\.([\s\S]*?)(?=## 9c|## 10)/);
    if (step9bMatch) {
      const step9b = step9bMatch[1];
      assert.ok(
        !step9b.includes('too complex'),
        'step 9b must not use "too complex" — use context budget language instead'
      );
    }
  });

  test('phase split recommendation uses context budget framing', () => {
    assert.ok(
      workflowContent.includes('context budget') || workflowContent.includes('context cost'),
      'phase split recommendation must be framed in terms of context budget, not complexity'
    );
  });
});

describe('gsd-plan-checker.md — scope reduction detection includes time/complexity (#2092)', () => {
  let checkerContent;

  test('plan-checker exists and is readable', () => {
    const checkerPath = path.join(AGENTS_DIR, 'gsd-plan-checker.md');
    assert.ok(fs.existsSync(checkerPath), 'agents/gsd-plan-checker.md must exist');
    checkerContent = fs.readFileSync(checkerPath, 'utf-8');
  });

  test('scope reduction scan includes complexity-based justification patterns', () => {
    assert.ok(
      checkerContent.includes('too complex') || checkerContent.includes('too difficult'),
      'plan-checker scope reduction scan must detect complexity-based justification language'
    );
  });

  test('scope reduction scan includes time-based justification patterns', () => {
    assert.ok(
      checkerContent.includes('would take') || checkerContent.includes('hours') || checkerContent.includes('minutes'),
      'plan-checker scope reduction scan must detect time-based justification language'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3805-fast-md-log-to-state-schema.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3805-fast-md-log-to-state-schema (consolidation epic #1969 B4 #1973)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #3805)
// Reads gsd-core/workflows/fast.md whose deployed text IS the product —
// the workflow markdown is executed verbatim by LLM runtimes.

/**
 * #3805 — fast.md log_to_state appends a schema-blind 4-column row to the
 * 5-column "Quick Tasks Completed" table created by quick.md Step 7.
 *
 * quick.md Step 7 creates the table with 5 columns:
 *   | # | Description | Date | Commit | Directory |
 *
 * Before this fix, fast.md's log_to_state step appended a hardcoded 4-cell
 * row unconditionally:
 *   echo "| $(date +%Y-%m-%d) | fast | $TASK | ✅ |" >> .planning/STATE.md
 *
 * This produces malformed Markdown when the existing table has a different
 * column count.
 *
 * Covers:
 *   - fast.md does NOT contain the hardcoded 4-cell echo template
 *   - fast.md log_to_state step reads/introspects the existing table header
 *     before appending (schema-aware insertion)
 *   - fast.md log_to_state step matches the 5-column schema from quick.md
 *     Step 7 when that table is present
 *   - fast.md log_to_state step skips (does not corrupt) the STATE.md write
 *     when the table schema is unrecognized
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const FAST_MD_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'fast.md');

// The 5-column schema defined in quick.md Step 7 (non-validate mode).
// Column count is 5: # | Description | Date | Commit | Directory
// Named constant for traceability — mirrors quick.md Step 7's table header.
const QUICK_MD_STEP7_COL_COUNT = 5;
const QUICK_MD_STEP7_COLUMNS = ['#', 'Description', 'Date', 'Commit', 'Directory'];

describe('bug #3805: fast.md log_to_state must be schema-aware', () => {
  let fastMdContent;

  test('fast.md workflow file exists and is readable', () => {
    assert.ok(fs.existsSync(FAST_MD_PATH), `fast.md not found at ${FAST_MD_PATH}`);
    fastMdContent = fs.readFileSync(FAST_MD_PATH, 'utf-8');
  });

  test('fast.md log_to_state step does NOT hardcode a 4-cell row template', () => {
    // The old broken template: | date | fast | task | ✅ |
    // This regex matches the exact hardcoded pattern that ignores table schema.
    // A 4-cell row has exactly 4 pipe-delimited fields plus the surrounding pipes.
    const hardcoded4CellPattern = /echo\s+["'][|][^|]*[|][^|]*[|][^|]*[|][^|]*[|]\s*["']/;
    const match = fastMdContent.match(hardcoded4CellPattern);
    assert.ok(
      !match,
      [
        'fast.md log_to_state still contains the hardcoded 4-cell row template:',
        `  "${match?.[0]}"`,
        'This appends a malformed row to the 5-column Quick Tasks Completed table',
        'created by quick.md Step 7.',
        `Expected table schema (${QUICK_MD_STEP7_COL_COUNT} cols): | ${QUICK_MD_STEP7_COLUMNS.join(' | ')} |`,
      ].join('\n')
    );
  });

  test('fast.md log_to_state step reads the existing table header (schema introspection)', () => {
    // The fix must inspect the existing STATE.md table header before appending.
    // Acceptable signals: reading STATE.md content, grepping for the header line,
    // or parsing columns from the header row.
    const hasHeaderRead =
      // Reads STATE.md to inspect it (awk/sed/grep on the file for header detection)
      /grep.*Quick Tasks Completed.*STATE\.md/.test(fastMdContent) ||
      /awk.*Quick Tasks Completed/.test(fastMdContent) ||
      /sed.*Quick Tasks Completed/.test(fastMdContent) ||
      // Reads the header line explicitly (head -n, sed -n, awk NR==)
      /head\s+-n/.test(fastMdContent) && /STATE\.md/.test(fastMdContent) ||
      // Counts pipe separators / columns from existing header
      /col.*count|column.*count|count.*col|NF|awk.*\|/.test(fastMdContent) ||
      // References schema detection in prose
      /schema|header|column\s+count|existing.*table/.test(fastMdContent);

    assert.ok(
      hasHeaderRead,
      [
        'fast.md log_to_state step does not appear to introspect the existing table schema.',
        'The step must read the STATE.md table header to detect column count before appending.',
        'quick.md Step 7 uses schema-aware matching — fast.md must follow the same discipline.',
      ].join('\n')
    );
  });

  test('fast.md log_to_state step references the 5-column quick.md schema', () => {
    // Schema-awareness no longer lives inline in fast.md as hardcoded column
    // names — it was moved to the schema-backed `quick-tasks-append` helper
    // (`appendQuickTaskRow` in markdown-table.cjs; #2133, ADR-2143 §3/§7),
    // which introspects the existing table's schema (5-col or 6-col) itself.
    // Assert the step delegates to that helper instead of requiring the old
    // literal column names.
    const logToStateMatch = fastMdContent.match(/<step name="log_to_state">([\s\S]*?)<\/step>/);
    assert.ok(logToStateMatch, 'fast.md must contain a <step name="log_to_state"> element');

    const stepContent = logToStateMatch[1];

    assert.ok(
      stepContent.includes('quick-tasks-append'),
      [
        'fast.md log_to_state step does not invoke the schema-aware quick-tasks-append helper.',
        'Schema-awareness now lives in the gsd-tools quick-tasks-append subcommand',
        `(appendQuickTaskRow, handling both the ${QUICK_MD_STEP7_COL_COUNT}-column quick.md Step 7 schema`,
        `${QUICK_MD_STEP7_COLUMNS.join(', ')} and the 6-column with-status variant) —`,
        'the step must delegate to it rather than hardcoding column names inline.',
      ].join('\n')
    );
  });

  test('fast.md log_to_state step skips STATE.md write on unrecognized schema', () => {
    // The fix must not blindly append when the table schema is unknown.
    // Check for a guard that skips or logs rather than corrupting the file.
    const logToStateMatch = fastMdContent.match(/<step name="log_to_state">([\s\S]*?)<\/step>/);
    assert.ok(logToStateMatch, 'fast.md must contain a <step name="log_to_state"> element');

    const stepContent = logToStateMatch[1];

    // Must have a skip/guard path for unrecognized schemas
    const hasSkipGuard =
      /skip/i.test(stepContent) ||
      /unrecognized|unknown|mismatch/i.test(stepContent) ||
      /else\b/.test(stepContent) ||
      /warn|log/i.test(stepContent);

    assert.ok(
      hasSkipGuard,
      [
        'fast.md log_to_state step does not appear to guard against unrecognized table schemas.',
        'When the existing STATE.md table does not match an expected schema,',
        'the step must skip the write (with a brief log) rather than append a malformed row.',
      ].join('\n')
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2421-planner-grep-gate-hygiene.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2421-planner-grep-gate-hygiene (consolidation epic #1969 B7 #1976)", () => {
// allow-test-rule: source-text-is-the-product (see #2421)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Bug #2421: gsd-planner emits grep-count acceptance gates that count comment text
 *
 * The planner must instruct agents to use comment-aware grep patterns in
 * <automated> verify blocks. Without this, descriptive comments in file
 * headers count against the gate and force authors to reword them — the
 * "self-invalidating grep gate" anti-pattern.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLANNER_PATH = path.join(__dirname, '..', 'agents', 'gsd-planner.md');

describe('gsd-planner grep gate hygiene (#2421)', () => {
  test('gsd-planner.md exists in agents source dir', () => {
    assert.ok(fs.existsSync(PLANNER_PATH), 'agents/gsd-planner.md must exist');
  });

  test('gsd-planner.md contains Grep gate hygiene rule', () => {
    const content = fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert.ok(
      content.includes('Grep gate hygiene') || content.includes('grep gate hygiene'),
      'gsd-planner.md must contain a "Grep gate hygiene" rule to prevent self-invalidating grep gates'
    );
  });

  test('gsd-planner.md explains self-invalidating grep gate anti-pattern', () => {
    const content = fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert.ok(
      content.includes('self-invalidating'),
      'gsd-planner.md must describe the "self-invalidating" grep gate anti-pattern'
    );
  });

  test('gsd-planner.md provides comment-stripping grep example', () => {
    const content = fs.readFileSync(PLANNER_PATH, 'utf-8');
    // Must show a pattern that excludes comment lines (grep -v or grep -vE)
    assert.ok(
      content.includes('grep -v') || content.includes('grep -vE') || content.includes('-v '),
      'gsd-planner.md must provide a comment-stripping grep example (grep -v or grep -vE)'
    );
  });

  test('gsd-planner.md warns against bare zero-count grep gates on whole files', () => {
    const content = fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert.ok(
      content.includes('== 0') || content.includes('zero-count') || content.includes('zero count'),
      'gsd-planner.md must warn against bare zero-count grep gates without comment exclusion'
    );
  });

  test('gsd-planner.md grep gate hygiene rule appears after Nyquist Rule', () => {
    const content = fs.readFileSync(PLANNER_PATH, 'utf-8');
    const nyquistIdx = content.indexOf('Nyquist Rule');
    const grepGateIdx = content.indexOf('grep gate hygiene') !== -1
      ? content.indexOf('grep gate hygiene')
      : content.indexOf('Grep gate hygiene');

    assert.ok(nyquistIdx !== -1, 'Nyquist Rule must be present in gsd-planner.md');
    assert.ok(grepGateIdx !== -1, 'Grep gate hygiene must be present in gsd-planner.md');
    assert.ok(
      grepGateIdx > nyquistIdx,
      `Grep gate hygiene rule (at ${grepGateIdx}) must appear after Nyquist Rule (at ${nyquistIdx})`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3087-planner-directive-language.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3087-planner-directive-language (consolidation epic #1969 B7 #1976)", () => {
'use strict';

// Regression guard for bug #3087.
//
// Between v1.38.3 and v1.38.4, agents/gsd-planner.md had 10 instances of
// CRITICAL/MANDATORY/ALWAYS/MUST directive emphasis systematically removed.
// The change was undocumented and conflicts with the stated intent of PR #2489
// (the sycophancy-hardening pass that shipped in the same release). This test
// enforces the restored directive language so the demotion cannot recur silently.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let src;
try {
  src = fs.readFileSync(path.join(ROOT, 'agents', 'gsd-planner.md'), 'utf8');
} catch (err) {
  throw new Error(`agents/gsd-planner.md not found — was the file renamed? (${err.message})`);
}

const directives = [
  { desc: 'User Decision Fidelity heading is CRITICAL',         pattern: /## CRITICAL: User Decision Fidelity/ },
  { desc: 'Never Simplify heading is CRITICAL',                 pattern: /## CRITICAL: Never Simplify User Decisions/ },
  { desc: 'Multi-Source Audit heading is MANDATORY',            pattern: /## Multi-Source Coverage Audit \(MANDATORY in every plan set\)/ },
  { desc: 'Source audit uses "Audit ALL" imperative',           pattern: /Audit ALL four source types before finalizing/ },
  { desc: 'Discovery is MANDATORY',                             pattern: /Discovery is MANDATORY unless/ },
  { desc: 'Split signals use ALWAYS',                           pattern: /\*\*ALWAYS split if:\*\*/ },
  { desc: 'requirements field doc uses MUST',                   pattern: /\*\*MUST\*\* list requirement IDs from ROADMAP/ },
  { desc: 'Step 0 has CRITICAL requirement ID directive',       pattern: /\*\*CRITICAL:\*\* Every requirement ID MUST appear/ },
  { desc: 'Write tool directive uses ALWAYS',                   pattern: /\*\*ALWAYS use the Write tool to create files\*\*/ },
  { desc: 'File naming convention heading is CRITICAL',         pattern: /\*\*CRITICAL — File naming convention \(enforced\):\*\*/ },
];

for (const { desc, pattern } of directives) {
  test(`gsd-planner.md: ${desc}`, () => {
    assert.ok(
      pattern.test(src),
      `Directive enforcement missing from gsd-planner.md: "${desc}" — pattern ${pattern} not found. ` +
      `This language was demoted in v1.38.4 (PR #2489) without documentation, conflicting with ` +
      `the sycophancy-hardening intent of that release. See bug #3087.`,
    );
  });
}
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3430-planner-phase-contract.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3430-planner-phase-contract (consolidation epic #1969 B7 #1976)", () => {
// allow-test-rule: source-text-is-the-product (see #3430)
// Planner markdown is the deployed planning contract; these checks lock the
// exact canonical forms that downstream phase-plan-index accepts.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLANNER_PATH = path.join(__dirname, '..', 'agents', 'gsd-planner.md');

function readPlanner() {
  return fs.readFileSync(PLANNER_PATH, 'utf8');
}

test('#3430: planner SUMMARY instruction uses canonical padded phase/plan form', () => {
  const content = readPlanner();
  assert.match(
    content,
    /Create `\.planning\/phases\/XX-name\/\{padded_phase\}-\{plan\}-SUMMARY\.md` when done/,
    'planner must instruct executors to write SUMMARY files in canonical padded-phase form'
  );
  assert.doesNotMatch(
    content,
    /After completion, create `\.planning\/phases\/XX-name\/\{phase\}-\{plan\}-SUMMARY\.md`/,
    'planner must not instruct the broken {phase}-{plan}-SUMMARY.md form'
  );
});

test('#3430: planner depends_on docs show canonical in-phase plan ids', () => {
  const content = readPlanner();
  assert.match(
    content,
    /depends_on:[^\n]*Use `01-01`\/`01-01-auth-hardening`/,
    'planner must document canonical depends_on examples that phase-plan-index resolves'
  );
  assert.doesNotMatch(
    content,
    /depends_on:[^\n]*01-trust\/01/,
    'planner must not document phase-slug/plan-number depends_on examples as canonical'
  );
});
  });
}

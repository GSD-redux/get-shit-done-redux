// allow-test-rule: source-text-is-the-product
// Agent .md files are the installed AI agents — their frontmatter and body text IS what
// Claude Code loads at runtime. Checking text content IS checking the deployed contract.

/**
 * GSD Agent Frontmatter Tests
 *
 * Validates that all agent .md files have correct frontmatter fields:
 * - Anti-heredoc instruction present in file-writing agents
 * - skills: field absent from all agents (breaks Gemini CLI)
 * - Commented hooks: pattern in file-writing agents
 * - Spawn type consistency across workflows
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listAgentFiles } = require('./helpers/agent-roster.cjs');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');

// Sorted basenames (without `.md`); reads below re-add `.md` via `name + '.md'`.
const ALL_AGENTS = listAgentFiles(AGENTS_DIR);

const FILE_WRITING_AGENTS = ALL_AGENTS.filter(name => {
  const content = fs.readFileSync(path.join(AGENTS_DIR, name + '.md'), 'utf-8');
  const toolsMatch = content.match(/^tools:\s*(.+)$/m);
  return toolsMatch && toolsMatch[1].includes('Write');
});

const READ_ONLY_AGENTS = ALL_AGENTS.filter(name => !FILE_WRITING_AGENTS.includes(name));

// ─── Anti-Heredoc Instruction ────────────────────────────────────────────────

describe('HDOC: anti-heredoc instruction', () => {
  for (const agent of FILE_WRITING_AGENTS) {
    test(`${agent} has anti-heredoc instruction`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      assert.ok(
        content.includes("never use `Bash(cat << 'EOF')` or heredoc"),
        `${agent} missing anti-heredoc instruction`
      );
    });
  }

  test('no active heredoc patterns in any agent file', () => {
    for (const agent of ALL_AGENTS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      // Match actual heredoc commands (not references in anti-heredoc instruction)
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip lines that are part of the anti-heredoc instruction or markdown code fences
        if (line.includes('never use') || line.includes('NEVER') || line.trim().startsWith('```')) continue;
        // Check for actual heredoc usage instructions
        if (/^cat\s+<<\s*'?EOF'?\s*>/.test(line.trim())) {
          assert.fail(`${agent}:${i + 1} has active heredoc pattern: ${line.trim()}`);
        }
      }
    }
  });
});

// ─── Skills Frontmatter ──────────────────────────────────────────────────────

describe('SKILL: skills frontmatter absent', () => {
  for (const agent of ALL_AGENTS) {
    test(`${agent} does not have skills: in frontmatter`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      const frontmatter = content.split('---')[1] || '';
      assert.ok(
        !frontmatter.includes('skills:'),
        `${agent} has skills: in frontmatter — skills: breaks Gemini CLI and must be removed`
      );
    });
  }
});

// ─── Hooks Frontmatter ───────────────────────────────────────────────────────

describe('HOOK: hooks frontmatter pattern', () => {
  for (const agent of FILE_WRITING_AGENTS) {
    test(`${agent} has commented hooks pattern`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      const frontmatter = content.split('---')[1] || '';
      assert.ok(
        frontmatter.includes('# hooks:'),
        `${agent} missing commented hooks: pattern in frontmatter`
      );
    });
  }

  for (const agent of READ_ONLY_AGENTS) {
    test(`${agent} (read-only) does not need hooks`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      const frontmatter = content.split('---')[1] || '';
      // Read-only agents may or may not have hooks — just verify they parse
      assert.ok(frontmatter.includes('name:'), `${agent} has valid frontmatter`);
    });
  }
});

// ─── Spawn Type Consistency ──────────────────────────────────────────────────

describe('SPAWN: spawn type consistency', () => {
  test('no "First, read agent .md" workaround pattern remains', () => {
    const dirs = [WORKFLOWS_DIR, COMMANDS_DIR];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const hasWorkaround = content.includes('First, read ~/.claude/agents/gsd-');
        assert.ok(
          !hasWorkaround,
          `${file} still has "First, read agent .md" workaround — use named subagent_type instead`
        );
      }
    }
  });

  test('named agent spawns use correct agent names', () => {
    const validAgentTypes = new Set([
      ...ALL_AGENTS,
      'general-purpose',  // Allowed for orchestrator spawns
    ]);

    const dirs = [WORKFLOWS_DIR, COMMANDS_DIR];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const matches = content.matchAll(/subagent_type="([^"]+)"/g);
        for (const match of matches) {
          const agentType = match[1];
          assert.ok(
            validAgentTypes.has(agentType),
            `${file} references unknown agent type: ${agentType}`
          );
        }
      }
    }
  });

  test('diagnose-issues uses gsd-debugger (not general-purpose)', () => {
    const content = fs.readFileSync(
      path.join(WORKFLOWS_DIR, 'diagnose-issues.md'), 'utf-8'
    );
    assert.ok(
      content.includes('subagent_type="gsd-debugger"'),
      'diagnose-issues should spawn gsd-debugger, not general-purpose'
    );
  });

  test('workflows spawning named agents have <available_agent_types> listing (#1357)', () => {
    // After /clear, Claude Code re-reads workflow instructions but loses agent
    // context. Without an <available_agent_types> section, the orchestrator may
    // fall back to general-purpose, silently breaking agent capabilities.
    // PR #1139 added this to plan-phase and execute-phase but missed all other
    // workflows that spawn named GSD agents.
    const dirs = [WORKFLOWS_DIR, COMMANDS_DIR];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        // Find all named subagent_type references (excluding general-purpose)
        const matches = [...content.matchAll(/subagent_type="([^"]+)"/g)];
        const namedAgents = matches
          .map(m => m[1])
          .filter(t => t !== 'general-purpose');

        if (namedAgents.length === 0) continue;

        // Workflow spawns named agents — must have <available_agent_types>
        assert.ok(
          content.includes('<available_agent_types>'),
          `${file} spawns named agents (${[...new Set(namedAgents)].join(', ')}) ` +
          `but has no <available_agent_types> section — after /clear, the ` +
          `orchestrator may fall back to general-purpose (#1357)`
        );

        // Every spawned agent type must appear in the listing
        for (const agent of new Set(namedAgents)) {
          const agentTypesMatch = content.match(
            /<available_agent_types>([\s\S]*?)<\/available_agent_types>/
          );
          assert.ok(
            agentTypesMatch,
            `${file} has malformed <available_agent_types> section`
          );
          assert.ok(
            agentTypesMatch[1].includes(agent),
            `${file} spawns ${agent} but does not list it in <available_agent_types>`
          );
        }
      }
    }
  });

  test('execute-phase has Copilot sequential fallback in runtime_compatibility', () => {
    const content = fs.readFileSync(
      path.join(WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8'
    );
    assert.ok(
      content.includes('sequential inline execution'),
      'execute-phase must document sequential inline execution as Copilot fallback'
    );
    assert.ok(
      content.includes('spot-check'),
      'execute-phase must have spot-check fallback for completion detection'
    );
  });
});

// ─── Required Frontmatter Fields ─────────────────────────────────────────────

describe('AGENT: required frontmatter fields', () => {
  for (const agent of ALL_AGENTS) {
    test(`${agent} has name, description, tools, color`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      const frontmatter = content.split('---')[1] || '';
      assert.ok(frontmatter.includes('name:'), `${agent} missing name:`);
      assert.ok(frontmatter.includes('description:'), `${agent} missing description:`);
      assert.ok(frontmatter.includes('tools:'), `${agent} missing tools:`);
      assert.ok(frontmatter.includes('color:'), `${agent} missing color:`);
    });
  }
});

// ─── Color Value Validation ──────────────────────────────────────────────────

const VALID_AGENT_COLORS = new Set(['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']);

describe('COLOR: color frontmatter must be a documented named color', () => {
  for (const agent of ALL_AGENTS) {
    test(`${agent} color: is a documented named color`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const frontmatter = fmMatch ? fmMatch[1] : '';
      const colorMatch = frontmatter.match(/^color:\s*(.+)$/m);
      assert.ok(colorMatch, `${agent} missing color: field in frontmatter`);
      const rawValue = colorMatch[1].trim();
      // Strip surrounding quotes (single or double) before validating
      const colorValue = rawValue.replace(/^["']|["']$/g, '');
      assert.ok(
        VALID_AGENT_COLORS.has(colorValue),
        `${agent} has invalid color: "${colorValue}" — must be one of: ${[...VALID_AGENT_COLORS].join(', ')}`
      );
    });
  }
});

// ─── CLAUDE.md Compliance ───────────────────────────────────────────────────

describe('CLAUDEMD: CLAUDE.md compliance enforcement', () => {
  test('gsd-plan-checker has Dimension 10: CLAUDE.md Compliance', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-plan-checker.md'), 'utf-8');
    assert.ok(
      content.includes('Dimension 10: CLAUDE.md Compliance'),
      'gsd-plan-checker must have Dimension 10 for CLAUDE.md compliance checking'
    );
    assert.ok(
      content.includes('claude_md_compliance'),
      'gsd-plan-checker must use claude_md_compliance as dimension identifier'
    );
  });

  test('gsd-phase-researcher has CLAUDE.md enforcement directive', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-phase-researcher.md'), 'utf-8');
    assert.ok(
      content.includes('CLAUDE.md enforcement'),
      'gsd-phase-researcher must enforce CLAUDE.md directives during research'
    );
    assert.ok(
      content.includes('Project Constraints (from CLAUDE.md)'),
      'gsd-phase-researcher must output a Project Constraints section from CLAUDE.md'
    );
  });

  test('gsd-executor has CLAUDE.md enforcement directive', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-executor.md'), 'utf-8');
    assert.ok(
      content.includes('CLAUDE.md enforcement'),
      'gsd-executor must enforce CLAUDE.md directives during execution'
    );
    assert.ok(
      content.includes('CLAUDE.md rule — it takes precedence over plan instructions'),
      'gsd-executor must specify CLAUDE.md precedence over plan instructions'
    );
  });

  test('all three agents read CLAUDE.md in project_context', () => {
    const agents = ['gsd-plan-checker', 'gsd-phase-researcher', 'gsd-executor'];
    for (const agent of agents) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      assert.ok(
        content.includes('Read `./CLAUDE.md`'),
        `${agent} must read ./CLAUDE.md in project_context section`
      );
    }
  });
});

// ─── Verification Data-Flow and Environment Audit (#1245) ────────────────────

describe('VERIFY: data-flow trace, environment audit, and behavioral spot-checks', () => {
  test('gsd-verifier has Step 4b: Data-Flow Trace', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-verifier.md'), 'utf-8');
    assert.ok(
      content.includes('Step 4b: Data-Flow Trace'),
      'gsd-verifier must have Step 4b for data-flow tracing'
    );
    assert.ok(
      content.includes('HOLLOW'),
      'gsd-verifier must define HOLLOW status for wired-but-disconnected artifacts'
    );
    assert.ok(
      content.includes('DISCONNECTED'),
      'gsd-verifier must define DISCONNECTED status for missing data sources'
    );
  });

  test('gsd-verifier has Step 7b: Behavioral Spot-Checks', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-verifier.md'), 'utf-8');
    assert.ok(
      content.includes('Step 7b: Behavioral Spot-Checks'),
      'gsd-verifier must have Step 7b for behavioral spot-checks'
    );
    assert.ok(
      content.includes('SKIP'),
      'gsd-verifier spot-checks must support SKIP status for untestable items'
    );
  });

  test('gsd-verifier VERIFICATION.md template includes data-flow and spot-check sections', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-verifier.md'), 'utf-8');
    assert.ok(
      content.includes('Data-Flow Trace (Level 4)'),
      'VERIFICATION.md template must include Data-Flow Trace section'
    );
    assert.ok(
      content.includes('Behavioral Spot-Checks'),
      'VERIFICATION.md template must include Behavioral Spot-Checks section'
    );
  });

  test('gsd-verifier success criteria include data-flow and spot-checks', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-verifier.md'), 'utf-8');
    assert.ok(
      content.includes('Data-flow trace (Level 4)'),
      'success criteria must include data-flow trace step'
    );
    assert.ok(
      content.includes('Behavioral spot-checks run'),
      'success criteria must include behavioral spot-checks step'
    );
  });

  test('gsd-phase-researcher has Step 2.6: Environment Availability Audit', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-phase-researcher.md'), 'utf-8');
    assert.ok(
      content.includes('Step 2.6: Environment Availability Audit'),
      'gsd-phase-researcher must have Step 2.6 for environment availability auditing'
    );
    assert.ok(
      content.includes('Environment Availability'),
      'gsd-phase-researcher must include Environment Availability section in RESEARCH.md template'
    );
  });

  test('gsd-phase-researcher success criteria include environment audit', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-phase-researcher.md'), 'utf-8');
    assert.ok(
      content.includes('Environment availability audited'),
      'success criteria must include environment availability audit step'
    );
  });
});

// ─── Discussion Log ──────────────────────────────────────────────────────────

describe('DISCUSS: discussion log generation', () => {
  test('discuss-phase workflow references DISCUSSION-LOG.md generation', () => {
    // After the discuss-phase progressive-disclosure split (#717), the DISCUSSION-LOG.md template
    // body lives in workflows/discuss-phase/templates/discussion-log.md and is
    // read at the git_commit step. Both files together must satisfy the
    // documentation contract.
    const parent = fs.readFileSync(
      path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8'
    );
    const tplPath = path.join(WORKFLOWS_DIR, 'discuss-phase', 'templates', 'discussion-log.md');
    const tpl = fs.existsSync(tplPath) ? fs.readFileSync(tplPath, 'utf-8') : '';
    const content = parent + '\n' + tpl;
    assert.ok(
      content.includes('DISCUSSION-LOG.md'),
      'discuss-phase must reference DISCUSSION-LOG.md generation'
    );
    assert.ok(
      content.includes('Audit trail only'),
      'discuss-phase (or its discussion-log template after the discuss-phase/modes split) must mark discussion log as audit-only'
    );
  });

  test('discussion-log template exists', () => {
    const templatePath = path.join(__dirname, '..', 'gsd-core', 'templates', 'discussion-log.md');
    assert.ok(
      fs.existsSync(templatePath),
      'discussion-log.md template must exist'
    );
    const content = fs.readFileSync(templatePath, 'utf-8');
    assert.ok(
      content.includes('Do not use as input to planning'),
      'template must contain audit-only notice'
    );
  });
});

// ─── Section-writer agents must carry both Write and Edit (#581) ────────────

describe('EDITWRITE: section-writer agents must have both Write and Edit in tools', () => {
  // These agents perform in-place section edits on shared/existing files (e.g.
  // AI-SPEC.md). Without Edit in tools:, the "Edit-only" discipline in their
  // spawn-prompt is unenforceable — they fall back to whole-file Write and
  // clobber sibling sections. Same bug class as #571/#575 (fixed gsd-doc-writer).
  // Issue #581.
  const SECTION_WRITER_AGENTS = [
    'gsd-eval-planner',
    'gsd-ai-researcher',
    'gsd-domain-researcher',
    'gsd-phase-researcher',
    'gsd-ui-researcher',
    'gsd-debug-session-manager',
    'gsd-planner', // #973: planner lacked Edit; whole-file Write truncated ROADMAP.md
  ];

  for (const agent of SECTION_WRITER_AGENTS) {
    test(`${agent} has both Write and Edit in tools: (#581)`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      const toolsMatch = content.match(/^tools:\s*(.+)$/m);
      assert.ok(toolsMatch, `${agent} missing tools: line in frontmatter`);
      const tools = toolsMatch[1].split(',').map(t => t.trim());
      assert.ok(
        tools.includes('Write'),
        `${agent} missing Write in tools: — required for file creation`
      );
      assert.ok(
        tools.includes('Edit'),
        `${agent} missing Edit in tools: — required to enforce Edit-only discipline on shared files (#581)`
      );
    });
  }
});

// ─── Cross-runtime agent compatibility (#1522) ──────────────────────────────

describe('COMPAT: agents must not use runtime-specific frontmatter keys', () => {
  // permissionMode is Claude Code-specific and breaks Gemini CLI agent loading.
  // It also has no effect on subagent Write permissions in Claude Code (blocked
  // at runtime level regardless). See #1522, #1387.
  const AGENTS_WITH_WRITE = ['gsd-executor', 'gsd-debugger'];

  for (const agent of AGENTS_WITH_WRITE) {
    test(`${agent} does not have permissionMode (breaks Gemini CLI)`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      const frontmatter = content.split('---')[1] || '';
      assert.ok(
        !frontmatter.includes('permissionMode'),
        `${agent} must not have permissionMode — it breaks Gemini CLI agent loading (#1522) ` +
        `and has no effect in Claude Code (#1387)`
      );
    });
  }
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2346-agent-read-loop-guards.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2346-agent-read-loop-guards (consolidation epic #1969 B7 #1976)", () => {
/**
 * Regression tests for bug #2346
 *
 * Multiple GSD agents (gsd-ui-checker, gsd-planner) entered unbounded Read
 * loops — re-reading the same file hundreds of times in a single run. Root
 * cause: no explicit no-re-read rule or tool-budget cap in the agent prompts.
 * gsd-pattern-mapper was fixed in #2312; this covers the remaining agents.
 *
 * Fix: add <critical_rules> block to each affected agent with:
 *   1. No-re-read constraint
 *   2. Large-file strategy (Grep first, then targeted offset/limit Read)
 *   3. Stop-on-sufficient-evidence rule (where applicable)
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

// allow-test-rule: source-text-is-the-product (see #2346)
// The <critical_rules> block in agent .md files IS the fix — it is the AI instruction that
// prevents unbounded Read loops. There is no behavioral equivalent without a live LLM run.
describe('bug #2346: agent read loop guards', () => {

  describe('gsd-ui-checker', () => {
    const agentPath = path.join(AGENTS_DIR, 'gsd-ui-checker.md');
    const content = fs.readFileSync(agentPath, 'utf-8');

    test('agent file exists', () => {
      assert.ok(fs.existsSync(agentPath), 'agents/gsd-ui-checker.md must exist');
    });

    test('has <critical_rules> block', () => {
      assert.ok(
        content.includes('<critical_rules>'),
        'gsd-ui-checker.md must have a <critical_rules> block to prevent unbounded read loops (#2346)'
      );
    });

    test('critical_rules contains no-re-read constraint', () => {
      const rulesStart = content.indexOf('<critical_rules>');
      const rulesEnd = content.indexOf('</critical_rules>', rulesStart);
      assert.ok(rulesStart !== -1 && rulesEnd !== -1, '<critical_rules> block must be complete');
      const rulesBlock = content.slice(rulesStart, rulesEnd);
      assert.ok(
        rulesBlock.includes('re-read') || rulesBlock.includes('re read'),
        'critical_rules must include a no-re-read rule'
      );
    });

    test('critical_rules appears before success_criteria', () => {
      const rulesIdx = content.indexOf('<critical_rules>');
      const successIdx = content.indexOf('<success_criteria>');
      assert.ok(rulesIdx !== -1 && successIdx !== -1, 'both sections must exist');
      assert.ok(
        rulesIdx < successIdx,
        '<critical_rules> must appear before <success_criteria>'
      );
    });
  });

  describe('gsd-planner', () => {
    const agentPath = path.join(AGENTS_DIR, 'gsd-planner.md');
    const content = fs.readFileSync(agentPath, 'utf-8');

    test('agent file exists', () => {
      assert.ok(fs.existsSync(agentPath), 'agents/gsd-planner.md must exist');
    });

    test('has <critical_rules> block', () => {
      assert.ok(
        content.includes('<critical_rules>'),
        'gsd-planner.md must have a <critical_rules> block to prevent unbounded read loops (#2346)'
      );
    });

    test('critical_rules contains no-re-read constraint', () => {
      const rulesStart = content.indexOf('<critical_rules>');
      const rulesEnd = content.indexOf('</critical_rules>', rulesStart);
      assert.ok(rulesStart !== -1 && rulesEnd !== -1, '<critical_rules> block must be complete');
      const rulesBlock = content.slice(rulesStart, rulesEnd);
      assert.ok(
        rulesBlock.includes('re-read') || rulesBlock.includes('re read'),
        'critical_rules must include a no-re-read rule'
      );
    });

    test('critical_rules appears before success_criteria', () => {
      const rulesIdx = content.indexOf('<critical_rules>');
      const successIdx = content.lastIndexOf('<success_criteria>');
      assert.ok(rulesIdx !== -1 && successIdx !== -1, 'both sections must exist');
      assert.ok(
        rulesIdx < successIdx,
        '<critical_rules> must appear before <success_criteria>'
      );
    });
  });

});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3605-stale-research-insert-phase-agent-refs.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3605-stale-research-insert-phase-agent-refs (consolidation epic #1969 B7 #1976)", () => {
// allow-test-rule: source-text-is-the-product (see #3605)
// agents/*.md text IS the deployed contract — Claude Code, Codex, etc. load these
// files at runtime and surface their content to users. Testing for retired slash
// commands in this text is testing what real users will see.

/**
 * Bug #3605: Stale slash command references in 5 agent files
 *
 * After #3042 deleted /gsd-research-phase (replaced by
 * /gsd-plan-phase --research-phase <N>) and v1.40.0 consolidated /gsd-insert-phase
 * into /gsd-phase insert, six occurrences survived in agents/*.md because none of
 * the consolidation passes (#3029, #3044, #3131) included agents/ in their per-name
 * scrub scope. scripts/fix-slash-commands.cjs lists agents/ in SEARCH_DIRS but only
 * runs the /gsd- → /gsd: namespace transform, not retired-name replacement.
 *
 * This guard fails when any retired command name reappears in agents/*.md.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

const RETIRED_COMMANDS = [
  '/gsd-research-phase',
  '/gsd-insert-phase',
  '/gsd-add-phase',
  '/gsd-remove-phase',
  '/gsd-analyze-dependencies',
];

// Not the shared listAgentFiles() helper: this returns ABSOLUTE paths (consumed
// by scanForRetired below as readFileSync targets), not stripped basenames.
function listAgentFiles() {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(AGENTS_DIR, name));
}

function scanForRetired(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    for (const cmd of RETIRED_COMMANDS) {
      const idx = lines[i].indexOf(cmd);
      if (idx === -1) continue;
      const next = lines[i].charCodeAt(idx + cmd.length);
      // Only count if the match is a real invocation, not a prefix of a longer name.
      // The next char must be a non-name char (anything outside [A-Za-z0-9-_]).
      const isWordBoundary =
        Number.isNaN(next) ||
        !((next >= 48 && next <= 57) || // 0-9
          (next >= 65 && next <= 90) || // A-Z
          (next >= 97 && next <= 122) || // a-z
          next === 45 || // -
          next === 95); // _
      if (!isWordBoundary) continue;
      hits.push({ line: i + 1, cmd, text: lines[i].trim() });
    }
  }
  return hits;
}

describe('bug #3605: agent contracts must not reference retired slash commands', () => {
  const agentFiles = listAgentFiles();

  test('at least one agent file is scanned (smoke)', () => {
    assert.ok(agentFiles.length > 0, 'expected agents/*.md to exist');
  });

  for (const file of agentFiles) {
    const rel = path.relative(path.join(__dirname, '..'), file);
    test(`${rel} contains no retired slash commands`, () => {
      const hits = scanForRetired(file);
      assert.deepEqual(
        hits,
        [],
        `${rel} contains retired command references:\n` +
          hits.map((h) => `  line ${h.line}: ${h.cmd} — ${h.text}`).join('\n'),
      );
    });
  }
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2427-sycophancy-hardening.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2427-sycophancy-hardening (consolidation epic #1969 B7 #1976)", () => {
'use strict';

/**
 * Tests for #2427 — prompt-level sycophancy hardening of audit-class agents.
 * Verifies the four required changes are present in each agent file:
 *   1. Third-person framing (no "You are a GSD X" opening in <role>)
 *   2. FORCE adversarial stance block
 *   3. Explicit failure modes list
 *   4. BLOCKER/WARNING classification requirement
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS_DIR = path.join(__dirname, '../agents');

const AUDIT_AGENTS = [
  'gsd-plan-checker.md',
  'gsd-code-reviewer.md',
  'gsd-security-auditor.md',
  'gsd-verifier.md',
  'gsd-eval-auditor.md',
  'gsd-nyquist-auditor.md',
  'gsd-ui-auditor.md',
  'gsd-integration-checker.md',
  'gsd-doc-verifier.md',
];

function readAgent(agentsDir, filename) {
  return fs.readFileSync(path.join(agentsDir, filename), 'utf-8');
}

function extractRole(content) {
  const match = content.match(/<role>([\s\S]*?)<\/role>/);
  return match ? match[1] : '';
}

describe('enh-2427 — sycophancy hardening: audit-class agents', () => {

  for (const filename of AUDIT_AGENTS) {
    const label = filename.replace('.md', '');

    describe(label, () => {
      let content;
      let role;

      test('file is readable', () => {
        content = readAgent(AGENTS_DIR, filename);
        role = extractRole(content);
        assert.ok(content.length > 0, `${filename} should not be empty`);
      });

      test('(1) third-person framing — <role> does not open with "You are a GSD"', () => {
        content = content || readAgent(AGENTS_DIR, filename);
        role = role || extractRole(content);
        const firstSentence = role.trim().slice(0, 80);
        assert.ok(
          !firstSentence.startsWith('You are a GSD'),
          `${filename}: <role> must not open with "You are a GSD" — use third-person submission framing. Got: "${firstSentence}"`
        );
      });

      test('(2) FORCE adversarial stance — <adversarial_stance> block present', () => {
        content = content || readAgent(AGENTS_DIR, filename);
        assert.ok(
          content.includes('<adversarial_stance>'),
          `${filename}: must contain <adversarial_stance> block`
        );
        assert.ok(
          content.includes('FORCE stance'),
          `${filename}: <adversarial_stance> must contain "FORCE stance"`
        );
      });

      test('(3) explicit failure modes list present', () => {
        content = content || readAgent(AGENTS_DIR, filename);
        assert.ok(
          content.includes('failure modes'),
          `${filename}: must contain "failure modes" section in <adversarial_stance>`
        );
      });

      test('(4) BLOCKER/WARNING classification requirement present', () => {
        content = content || readAgent(AGENTS_DIR, filename);
        assert.ok(
          content.includes('**BLOCKER**'),
          `${filename}: must define BLOCKER classification in <adversarial_stance>`
        );
        assert.ok(
          content.includes('**WARNING**'),
          `${filename}: must define WARNING classification in <adversarial_stance>`
        );
      });
    });
  }

});
// sdk/prompts/agents/ was removed in 377a6d2 — SDK now loads installed agents directly.
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-571-doc-writer-fix-mode-edit-only.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-571-doc-writer-fix-mode-edit-only (consolidation epic #1969 B7 #1976)", () => {
/**
 * Regression tests for bug #571
 *
 * gsd-doc-writer in fix mode used the Write tool (whole-file replace) instead
 * of the Edit tool (surgical replacement) when correcting specific failing
 * claims. When the target doc was generated but not yet committed, Write could
 * truncate the file to a single line with no git recovery path.
 *
 * Fix 1 (agent): Add Edit to the tools frontmatter and rewrite fix_mode
 *   instructions to mandate Edit and explicitly forbid Write on existing files.
 * Fix 2 (workflow): Add a post-fix line-count guard in fix_loop that detects
 *   >90% shrinkage and restores the file from existing_content.
 */

'use strict';

// allow-test-rule: source-text-is-the-product (see #571)
// Agent .md files are the installed AI agents — their frontmatter and body IS
// what the runtime loads. Checking text content IS checking the deployed contract.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

const AGENT_PATH = path.join(AGENTS_DIR, 'gsd-doc-writer.md');
const WORKFLOW_PATH = path.join(WORKFLOWS_DIR, 'docs-update.md');

// ─── Agent fix: Edit in tools frontmatter ────────────────────────────────────

describe('bug #571: gsd-doc-writer agent', () => {
  const content = fs.readFileSync(AGENT_PATH, 'utf-8');

  test('agent file exists', () => {
    assert.ok(fs.existsSync(AGENT_PATH), 'agents/gsd-doc-writer.md must exist');
  });

  test('tools frontmatter includes Edit', () => {
    const toolsMatch = content.match(/^tools:\s*(.+)$/m);
    assert.ok(toolsMatch, 'gsd-doc-writer.md must have a tools: frontmatter line');
    assert.ok(
      toolsMatch[1].includes('Edit'),
      'tools: frontmatter must include Edit so fix mode can make surgical replacements (#571)'
    );
  });

  // ─── fix_mode instructions ────────────────────────────────────────────────

  describe('fix_mode block', () => {
    const fixStart = content.indexOf('<fix_mode>');
    const fixEnd = content.indexOf('</fix_mode>', fixStart);
    assert.ok(fixStart !== -1 && fixEnd !== -1, '<fix_mode> block must be present and complete');
    const fixBlock = content.slice(fixStart, fixEnd);

    test('fix_mode mandates Edit for corrections', () => {
      assert.ok(
        fixBlock.includes('Edit'),
        'fix_mode must instruct the agent to use the Edit tool for surgical corrections (#571)'
      );
    });

    test('fix_mode explicitly forbids Write on existing files', () => {
      assert.ok(
        fixBlock.includes('NEVER use the Write tool') || fixBlock.includes('NEVER call Write'),
        'fix_mode must explicitly forbid Write on existing files — Write replaces the whole file (#571)'
      );
    });

    test('fix_mode mentions unrecoverable data loss risk of Write', () => {
      assert.ok(
        fixBlock.includes('untracked') || fixBlock.includes('context window') || fixBlock.includes('permanently destroyed'),
        'fix_mode must explain WHY Write is forbidden — unrecoverable data loss for untracked files (#571)'
      );
    });
  });

  // ─── critical_rules ───────────────────────────────────────────────────────

  describe('critical_rules block', () => {
    const rulesStart = content.indexOf('<critical_rules>');
    const rulesEnd = content.indexOf('</critical_rules>', rulesStart);
    assert.ok(rulesStart !== -1 && rulesEnd !== -1, '<critical_rules> block must be present and complete');
    const rulesBlock = content.slice(rulesStart, rulesEnd);

    test('critical_rules forbids Write in fix mode', () => {
      assert.ok(
        rulesBlock.includes('fix mode') && (rulesBlock.includes('NEVER call Write') || rulesBlock.includes('NEVER use the Write')),
        'critical_rules must explicitly forbid Write in fix mode (#571)'
      );
    });

    test('critical_rules Edit rule appears before success_criteria', () => {
      const rulesIdx = content.indexOf('<critical_rules>');
      const successIdx = content.indexOf('<success_criteria>');
      assert.ok(rulesIdx !== -1 && successIdx !== -1, 'both <critical_rules> and <success_criteria> must exist');
      assert.ok(
        rulesIdx < successIdx,
        '<critical_rules> must appear before <success_criteria> (#571)'
      );
    });
  });
});

// ─── Workflow fix: post-fix truncation guard in fix_loop ─────────────────────

describe('bug #571: docs-update workflow fix_loop', () => {
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'gsd-core/workflows/docs-update.md must exist');
  });

  describe('fix_loop step', () => {
    const loopStart = content.indexOf('<step name="fix_loop">');
    const loopEnd = content.indexOf('</step>', loopStart);
    assert.ok(loopStart !== -1 && loopEnd !== -1, 'fix_loop step must be present and complete');
    const loopBlock = content.slice(loopStart, loopEnd);

    test('fix_loop captures pre-fix line count', () => {
      assert.ok(
        loopBlock.includes('PRE_FIX_LINES') || loopBlock.includes('pre-fix line'),
        'fix_loop must capture the pre-fix line count to detect truncation (#571)'
      );
    });

    test('fix_loop checks post-fix line count', () => {
      assert.ok(
        loopBlock.includes('POST_FIX_LINES') || loopBlock.includes('post-fix line'),
        'fix_loop must check the post-fix line count to detect truncation (#571)'
      );
    });

    test('fix_loop restores file on truncation detection', () => {
      assert.ok(
        loopBlock.includes('Restore') || loopBlock.includes('restore'),
        'fix_loop must restore the file from existing_content when truncation is detected (#571)'
      );
    });

    test('fix_loop truncation threshold is >90% shrinkage', () => {
      assert.ok(
        loopBlock.includes('90%') || loopBlock.includes('10%'),
        'fix_loop must use a >90% shrinkage threshold (10% of original) to detect truncation (#571)'
      );
    });

    test('fix_loop logs a WARNING on truncation', () => {
      assert.ok(
        loopBlock.includes('WARNING') || loopBlock.includes('corrupted'),
        'fix_loop must log a WARNING when truncation is detected and restored (#571)'
      );
    });

    // Structural ordering: PRE check → fix agent runs → POST check → restore
    // These ensure the guard is wired in the right sequence, not just present.
    test('PRE_FIX_LINES is captured before POST_FIX_LINES (correct ordering)', () => {
      const preIdx = loopBlock.indexOf('PRE_FIX_LINES');
      const postIdx = loopBlock.indexOf('POST_FIX_LINES');
      assert.ok(preIdx !== -1 && postIdx !== -1, 'both PRE_FIX_LINES and POST_FIX_LINES must be present (#571)');
      assert.ok(
        preIdx < postIdx,
        'PRE_FIX_LINES must appear before POST_FIX_LINES — pre-capture must happen before post-check (#571)'
      );
    });

    test('restore instruction appears after POST_FIX_LINES check (correct ordering)', () => {
      const postIdx = loopBlock.indexOf('POST_FIX_LINES');
      // Find the restore instruction — it follows the threshold comparison
      const restoreIdx = loopBlock.indexOf('existing_content', postIdx);
      assert.ok(
        restoreIdx !== -1 && restoreIdx > postIdx,
        'restore-from-existing_content instruction must appear after the POST_FIX_LINES check (#571)'
      );
    });

    test('fix_loop doc path is quoted in shell snippets', () => {
      // Unquoted paths break on filenames with spaces or shell metacharacters.
      // Verify the bash snippets use quoted "{doc_path}" not bare {doc_path}.
      assert.ok(
        loopBlock.includes('< "{doc_path}"') || loopBlock.includes("<\"{doc_path}\""),
        'shell redirections must quote {doc_path} to handle paths with spaces (#571)'
      );
    });

    test('corrupted doc is still re-verified (not silently skipped)', () => {
      // The restored doc must be included in step 2 re-verification so its
      // failures are counted and reported. It should only be excluded from
      // receiving another fix attempt, not from verification.
      const restoreIdx = loopBlock.indexOf('existing_content', loopBlock.indexOf('POST_FIX_LINES'));
      const reVerifyIdx = loopBlock.indexOf('re-verify', restoreIdx);
      assert.ok(
        reVerifyIdx !== -1,
        'fix_loop must include re-verification after truncation restore (corrupted docs still have failures) (#571)'
      );
    });
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-214-writer-agents-write-truncation-contract.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-214-writer-agents-write-truncation-contract (consolidation epic #1969 B7 #1976)", () => {
// allow-test-rule: source-text-is-the-product (see #214)
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Every agent that writes a large file in a single Write call must carry the
// same truncation-resilient write contract added for bug #214. OpenCode shares
// OUTPUT_TOKEN_MAX=32000 with the thinking budget (upstream opencode#18108), so
// an oversized single `write` tool call is truncated mid-payload, yielding
// `JSON Parse error: Expected '}'`, and OpenCode then doom-loops. gsd-phase-researcher
// is locked by its own bug-214 test; this locks the other large-file writers.
const WRITER_AGENTS = [
  'gsd-research-synthesizer',
  'gsd-planner',
  'gsd-executor',
  'gsd-domain-researcher',
  'gsd-project-researcher',
  'gsd-ui-researcher',
];

function readAgent(name) {
  return fs.readFileSync(path.join(REPO_ROOT, 'agents', `${name}.md`), 'utf8');
}

describe('bug #214: large-file writer agents must survive write-tool truncation', () => {
  for (const name of WRITER_AGENTS) {
    describe(name, () => {
      const prompt = readAgent(name);

      test('keeps single-Write as the default path', () => {
        assert.match(
          prompt,
          /in a single `Write` call/i,
          `${name}: must keep single-Write as the default (no regression for non-truncating runtimes).`
        );
      });

      test('names the truncation failure mode', () => {
        assert.match(prompt, /truncat/i, `${name}: must name the truncation failure mode.`);
      });

      test('instructs incremental construction on large files', () => {
        assert.match(
          prompt,
          /incrementa/i,
          `${name}: must instruct incremental construction on large files.`
        );
      });

      test('defines the continuation sentinel', () => {
        assert.match(
          prompt,
          /<!-- gsd:write-continue -->/,
          `${name}: must define the continuation sentinel for incremental writes.`
        );
      });

      test('forbids identical retry of the oversized write (doom-loop guard)', () => {
        assert.match(
          prompt,
          /do NOT retry the same oversized call/i,
          `${name}: must forbid identical retry of the oversized write.`
        );
      });

      test('requires Read before Edit', () => {
        assert.match(
          prompt,
          /`Read` the file, then `Edit`/i,
          `${name}: must require Read before Edit (OpenCode edit requires a prior Read).`
        );
      });

      test('instructs removing the sentinel on the final section', () => {
        assert.match(
          prompt,
          /no trailing sentinel/i,
          `${name}: must instruct removing the sentinel on the final section.`
        );
      });

      test('forbids silent fallback to returning content', () => {
        assert.match(
          prompt,
          /do NOT silently fall back to returning content/i,
          `${name}: must forbid silent fallback to returning content.`
        );
      });
    });
  }
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-214-phase-researcher-write-truncation-contract.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-214-phase-researcher-write-truncation-contract (consolidation epic #1969 B7 #1976)", () => {
// allow-test-rule: source-text-is-the-product (see #214)
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const RESEARCHER_PATH = path.join(REPO_ROOT, 'agents', 'gsd-phase-researcher.md');

function readResearcherPrompt() {
  return fs.readFileSync(RESEARCHER_PATH, 'utf8');
}

describe('bug #214: phase researcher must survive OpenCode write-tool truncation', () => {
  test('Step 6 documents the large-file / truncation fallback write contract', () => {
    const prompt = readResearcherPrompt();

    assert.match(
      prompt,
      /truncat/i,
      'Step 6 must name the truncation failure mode.'
    );
    assert.match(
      prompt,
      /incrementa/i,
      'Step 6 must instruct incremental construction on large files.'
    );
    assert.match(
      prompt,
      /<!-- gsd:write-continue -->/,
      'Step 6 must define the continuation sentinel for incremental writes.'
    );
    assert.match(
      prompt,
      /do NOT retry the same oversized call/i,
      'Step 6 must forbid identical retry of the oversized write (doom-loop guard).'
    );
    assert.match(
      prompt,
      /do NOT silently fall back to returning content/i,
      'Step 6 must forbid silent fallback to returning content.'
    );
    assert.match(
      prompt,
      /`Read` the file, then `Edit`/i,
      'Step 6 must require Read before Edit (OpenCode edit requires a prior Read).'
    );
    assert.match(
      prompt,
      /no trailing sentinel/i,
      'Step 6 must instruct removing the sentinel on the final section.'
    );
    assert.match(
      prompt,
      /write the whole file in a single `Write` call/i,
      'Step 6 must keep single-Write as the default path (no regression for non-truncating runtimes).'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2990-code-fixer-worktree-branch.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2990-code-fixer-worktree-branch (consolidation epic #1969 B7 #1976)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #2990)
// agents/gsd-code-fixer.md is the deployed agent definition the runtime
// loads. Parsing its bash code blocks into structured invocation records
// (extractCleanupGitInvocations + the recovery-block parsers below) IS
// testing the runtime contract — what command sequence the agent
// actually documents and executes. The .match() calls extract typed
// fields from a known-shape product file, then assertions go against
// those typed fields, not against the raw markdown text.

// Consolidation #1969: scope GSD_TEST_MODE to this folded block so it does not
// leak into sibling folded suites in the shared file (was process-isolated when
// standalone). This unit suite only parses agent markdown, but keep the flag set
// for its own duration to preserve the origin behaviour, and restore it after.
const { before: __gtmBefore, after: __gtmAfter } = require('node:test');
const __savedGsdTestMode = process.env.GSD_TEST_MODE;
__gtmBefore(() => { process.env.GSD_TEST_MODE = '1'; });
__gtmAfter(() => { if (__savedGsdTestMode === undefined) delete process.env.GSD_TEST_MODE; else process.env.GSD_TEST_MODE = __savedGsdTestMode; });

/**
 * Bug #2990: gsd-code-fixer worktree setup fails when current branch
 * is already checked out in the main repo.
 *
 * The original agent definition called `git worktree add "$wt" "$branch"`,
 * where `$branch` was the user's currently-checked-out branch. Git refuses
 * to check out the same branch in two worktrees by default, so the setup
 * failed before the agent could do any work.
 *
 * Fix: create a NEW branch `gsd-reviewfix/${padded_phase}-$$` and attach
 * the worktree to it via `git worktree add -b "$reviewfix_branch" "$wt"
 * "$branch"`. The cleanup tail then fast-forwards `$branch` to
 * `$reviewfix_branch` so the user's branch captures the agent's commits.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AGENT_PATH = path.join(__dirname, '..', 'agents', 'gsd-code-fixer.md');

function parseWorktreeAddInvocations(markdown) {
  // Pull `git worktree add ...` calls and classify each into structured
  // records: hasNewBranchFlag (uses -b $reviewfix_branch) vs attachesToBareBranch
  // ($wt $branch). Skip occurrences inside markdown inline code (backticks)
  // or bash comments -- those are documentation citations of the OLD broken
  // pattern, not executable instructions.
  const invocations = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const idx = line.indexOf('git worktree add');
    if (idx === -1) continue;
    // Skip if inside backticks: the substring up to the match has an odd
    // number of backticks, the call is inside an inline code span.
    const before = line.slice(0, idx);
    const backticksBefore = (before.match(/`/g) || []).length;
    if (backticksBefore % 2 === 1) continue;
    // Skip if the line is a bash comment (after stripping leading whitespace).
    if (line.trimStart().startsWith('#')) continue;
    const argstr = line.slice(idx + 'git worktree add'.length).trim();
    invocations.push({
      raw: argstr,
      hasNewBranchFlag: /(?:^|\s)-b\s+["']?\$reviewfix_branch["']?/.test(argstr),
      attachesToBareBranch: /^["']?\$wt["']?\s+["']?\$branch["']?\b/.test(argstr),
    });
  }
  return invocations;
}

describe('Bug #2990: gsd-code-fixer worktree attaches to a NEW branch, not the user-checked-out one', () => {
  const md = fs.readFileSync(AGENT_PATH, 'utf-8');
  const invocations = parseWorktreeAddInvocations(md);

  test('sanity: at least one git-worktree-add invocation exists in the agent definition', () => {
    assert.ok(invocations.length > 0,
      'expected gsd-code-fixer.md to document at least one git worktree add invocation');
  });

  test('every git-worktree-add invocation uses -b $reviewfix_branch (not bare $branch)', () => {
    const violations = invocations.filter(inv => inv.attachesToBareBranch);
    assert.deepEqual(
      violations.map(v => v.raw),
      [],
      `worktree-add invocations attaching to bare $branch (#2990): ${JSON.stringify(violations.map(v => v.raw), null, 2)}`,
    );
  });

  test('the canonical setup invocation uses -b "$reviewfix_branch" "$wt" "$branch"', () => {
    const setupInvocations = invocations.filter(inv => inv.hasNewBranchFlag);
    assert.ok(setupInvocations.length >= 1,
      `expected at least one git-worktree-add invocation with -b "$reviewfix_branch" -- found: ${JSON.stringify(invocations.map(i => i.raw), null, 2)}`);
  });
});

/**
 * Bug #2647: gsd-code-fixer hand-rolled its worktree at a hardcoded `/tmp/sv-...`
 * mktemp path, which on Windows/Git Bash landed OUTSIDE the project tree —
 * outside the agent session's permission allowlist, so every Read inside the
 * worktree prompted — and mktemp's MAX_PATH-avoidance substitute produced an
 * un-removable `C:/mvwtNN` path. The fix places the worktree repo-relative
 * under `.claude/worktrees/` (the same dir the harness-managed executor
 * worktrees use: gitignored via `.claude/`, inside the permission scope),
 * with a PID+epoch suffix for concurrency uniqueness.
 *
 * These assertions parse the `wt=...` assignment(s) out of the agent markdown
 * (source-text-is-the-product, same allow-test-rule as the #2990 block above)
 * and assert the path is repo-relative under `.claude/worktrees/`, never an
 * absolute `/tmp` path, and concurrency-unique.
 */
describe('Bug #2647: gsd-code-fixer worktree path is repo-relative, not a hardcoded /tmp path', () => {
  const md = fs.readFileSync(AGENT_PATH, 'utf-8');

  // Extract `wt=...` shell assignments from fenced bash blocks (skip inline
  // backtick spans and bash comments, mirroring parseWorktreeAddInvocations).
  function parseWtAssignments(markdown) {
    const assigns = [];
    const lines = markdown.split('\n');
    for (const line of lines) {
      // Match `wt=` only as a whole token (preceded by start-of-line or
      // whitespace) so `prior_wt=` and `${reviewfix_wt}`-style names are not
      // captured. `\b` would also match the `wt` in `prior_wt`, so anchor on
      // `(?:^|\s)wt=`.
      const m = /(?:^|\s)wt=/.exec(line);
      if (!m) continue;
      const idx = m.index + m[0].length - 'wt='.length;
      // Skip inline-code spans (odd backtick count before the match).
      const before = line.slice(0, idx);
      if ((before.match(/`/g) || []).length % 2 === 1) continue;
      // Skip bash comments.
      if (line.trimStart().startsWith('#')) continue;
      // Skip `wt="."` (the use_worktrees=false opt-out — not a worktree path).
      const value = line.slice(idx + 'wt='.length).trim();
      if (value === '"."' || value === "'.'") continue;
      assigns.push(value);
    }
    return assigns;
  }

  test('the worktree path is NOT an absolute /tmp path', () => {
    const wtAssigns = parseWtAssignments(md);
    assert.ok(wtAssigns.length > 0, 'expected at least one wt= assignment in gsd-code-fixer.md');
    const tmpViolations = wtAssigns.filter(v => /\/tmp\/sv-|mktemp -d "\/tmp\//.test(v));
    assert.deepEqual(
      tmpViolations,
      [],
      `worktree paths still hardcoded to /tmp (#2647): ${JSON.stringify(tmpViolations, null, 2)}`,
    );
  });

  test('the worktree path is repo-relative under .claude/worktrees/', () => {
    const wtAssigns = parseWtAssignments(md);
    assert.ok(wtAssigns.length > 0, 'expected at least one wt= assignment in gsd-code-fixer.md');
    const nonRelative = wtAssigns.filter(v => !v.includes('.claude/worktrees/rf-'));
    assert.deepEqual(
      nonRelative,
      [],
      `worktree paths not under .claude/worktrees/ (#2647): ${JSON.stringify(nonRelative, null, 2)}`,
    );
  });

  test('the worktree path is concurrency-unique (PID + epoch suffix)', () => {
    const wtAssigns = parseWtAssignments(md);
    assert.ok(wtAssigns.length > 0, 'expected at least one wt= assignment in gsd-code-fixer.md');
    // The path must carry BOTH a PID (`$$`) AND a time component (`$(date +%s)`)
    // so concurrent runs for the same phase do not collide — the property
    // mktemp's XXXXXX provided before #2647. Requiring both (not either) is
    // faithful to the fix: PID alone could recycle after wrap; epoch alone could
    // collide for two same-second runs.
    const nonUnique = wtAssigns.filter(v => !v.includes('$$') || !v.includes('$(date +%s)'));
    assert.deepEqual(
      nonUnique,
      [],
      `worktree paths lack the PID+epoch concurrency-uniqueness suffix (#2647): ${JSON.stringify(nonUnique, null, 2)}`,
    );
  });
});

/**
 * Extract the cleanup-tail bash block from the agent .md, then parse it into
 * an ordered array of `git ...` invocation records. Per-record assertions go
 * against the structured records, not the raw markdown text. Anchor on the
 * "Cleanup tail" header to scope to the right block (the file has multiple
 * fenced bash blocks; we only want the cleanup one).
 */
function extractCleanupGitInvocations(markdown) {
  // Find the cleanup tail header and the fenced bash block that follows.
  const headerIdx = markdown.indexOf('**Cleanup tail (transactional');
  if (headerIdx === -1) return null;
  const fenceStart = markdown.indexOf('```bash', headerIdx);
  if (fenceStart === -1) return null;
  const fenceEnd = markdown.indexOf('```', fenceStart + '```bash'.length);
  if (fenceEnd === -1) return null;
  const block = markdown.slice(fenceStart + '```bash'.length, fenceEnd);

  // Tokenize each non-comment, non-blank line into structured records.
  const lines = block.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const records = [];
  for (const line of lines) {
    // Skip occurrences inside backticks (these would be inline-code
    // citations of the OLD pattern, not executable). The cleanup fenced
    // block is bash, but inline backticks can still appear inside echo
    // strings — guard anyway.
    const ticksBefore = (line.match(/`/g) || []).length;
    if (ticksBefore && ticksBefore % 2 === 1) continue;
    if (!line.includes('git ') && !line.startsWith('git ')) continue;
    records.push({
      raw: line,
      // Strip leading `git -C "..."`/`git -C $main_repo` so the verb-only
      // form stays comparable across direct and -C invocations.
      verb: (() => {
        const m = line.match(/^git\s+(?:-C\s+\S+\s+)?(\S+)/);
        return m ? m[1] : null;
      })(),
      // Did this line target the temp reviewfix branch by variable name?
      targetsReviewfixBranch: /\$reviewfix_branch\b/.test(line) || /"\$reviewfix_branch"/.test(line),
      // Is this the merge step? Captures the flag too.
      isMergeFfOnly: /\bmerge\s+--ff-only\b/.test(line),
      // Is this the branch-delete step?
      isBranchDelete: /\bbranch\s+-D\b/.test(line),
    });
  }
  return records;
}

describe('Bug #2990: cleanup tail fast-forwards $branch and deletes the temp branch on success', () => {
  const md = fs.readFileSync(AGENT_PATH, 'utf-8');
  const records = extractCleanupGitInvocations(md);

  test('cleanup tail bash block exists and is parseable', () => {
    assert.notEqual(records, null, 'expected to find a "Cleanup tail" bash block in agents/gsd-code-fixer.md');
    assert.ok(records.length > 0, 'expected at least one git invocation in the cleanup tail');
  });

  test('cleanup contains exactly one merge --ff-only against $reviewfix_branch', () => {
    const merges = records.filter(r => r.isMergeFfOnly);
    assert.equal(merges.length, 1, `expected exactly 1 ff-only merge, got ${merges.length}: ${JSON.stringify(merges, null, 2)}`);
    assert.equal(merges[0].targetsReviewfixBranch, true, 'merge --ff-only must target $reviewfix_branch');
  });

  test('cleanup contains exactly one git branch -D for $reviewfix_branch', () => {
    const deletes = records.filter(r => r.isBranchDelete);
    assert.equal(deletes.length, 1, `expected exactly 1 branch -D, got ${deletes.length}`);
    assert.equal(deletes[0].targetsReviewfixBranch, true, 'branch -D must target $reviewfix_branch');
  });

  test('merge --ff-only precedes branch -D in the cleanup ordering', () => {
    const mergeIdx = records.findIndex(r => r.isMergeFfOnly);
    const deleteIdx = records.findIndex(r => r.isBranchDelete);
    assert.ok(mergeIdx >= 0 && deleteIdx >= 0);
    assert.ok(mergeIdx < deleteIdx,
      `merge must run before branch delete (merge=${mergeIdx}, delete=${deleteIdx}); otherwise commits could be lost on merge failure`);
  });

  test('recovery sentinel JSON shape records reviewfix_branch alongside worktree_path', () => {
    // Find the writeFileSync call that constructs the sentinel JSON.
    // Parse the JSON.stringify argument list to extract the field names.
    const match = md.match(/fs\.writeFileSync\(sentinelPath,\s*JSON\.stringify\(\{([^}]+)\}/);
    assert.notEqual(match, null, 'expected JSON.stringify({...}) inside the sentinel write');
    const fields = match[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean);
    assert.ok(fields.includes('reviewfix_branch'),
      `recovery sentinel must record reviewfix_branch alongside worktree_path; fields=${JSON.stringify(fields)}`);
    assert.ok(fields.includes('worktree_path'),
      `recovery sentinel must record worktree_path; fields=${JSON.stringify(fields)}`);
  });
});

describe('Bug #2990 (#3001 CR): recovery code reads reviewfix_branch from sentinel and deletes the orphan branch', () => {
  const md = fs.readFileSync(AGENT_PATH, 'utf-8');

  test('recovery node script extracts reviewfix_branch from parsed sentinel', () => {
    // Find the recovery `node -e '...'` block (NOT the sentinel-write one).
    // Anchor on "recovery sentinel from a prior interrupted run".
    const headerIdx = md.indexOf('Detected pre-existing recovery sentinel');
    assert.notEqual(headerIdx, -1);
    const nodeStart = md.indexOf("node -e '", headerIdx);
    assert.notEqual(nodeStart, -1);
    const nodeEnd = md.indexOf("' \"$sentinel\"", nodeStart);
    assert.notEqual(nodeEnd, -1);
    const nodeBlock = md.slice(nodeStart, nodeEnd);
    // Both fields must be referenced by parsed.<field>.
    assert.ok(nodeBlock.includes('parsed.reviewfix_branch'),
      'recovery node script must extract parsed.reviewfix_branch from the sentinel');
    assert.ok(nodeBlock.includes('parsed.worktree_path'),
      'recovery node script must extract parsed.worktree_path from the sentinel');
  });

  test('recovery shell deletes the orphan reviewfix branch when present', () => {
    // The recovery block (between sentinel detection and `rm -f "$sentinel"`)
    // must call `git branch -D "$prior_branch"` (best-effort, with || true).
    const sentinelIdx = md.indexOf('Detected pre-existing recovery sentinel');
    const rmIdx = md.indexOf('rm -f "$sentinel"', sentinelIdx);
    assert.notEqual(rmIdx, -1);
    const recoveryBlock = md.slice(sentinelIdx, rmIdx);
    assert.ok(/git\s+branch\s+-D\s+"\$prior_branch"/.test(recoveryBlock),
      `recovery block must contain \`git branch -D "$prior_branch"\`; got: ${recoveryBlock.slice(0, 500)}`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2686-review-fix-worktree.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2686-review-fix-worktree (consolidation epic #1969 B7 #1976)", () => {
/**
 * Regression test for bug #2686
 *
 * The gsd-code-fixer agent (spawned by /gsd-code-review-fix) operated directly
 * against the main working tree. When it ran concurrently with a foreground
 * session both processes raced for HEAD, the index, and on-disk files. The
 * foreground session's next commit could land on the wrong branch (whichever
 * branch the agent last checked out).
 *
 * Fix: the agent's working instructions must include `git worktree add` as the
 * FIRST git operation, run ALL subsequent git operations inside that worktree
 * path, and call `git worktree remove` for cleanup when done.
 *
 * This mirrors the pattern already used by every other per-issue GSD agent at
 * /private/tmp/sv-<n>.
 */

'use strict';

// allow-test-rule: source-text-is-the-product (see #2686)
// The gsd-code-fixer agent's working instructions ARE the product — Claude
// executes them literally at runtime. Testing the text content tests the
// deployed contract: if the instruction is absent, the isolation guarantee
// is absent.

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('bug-2686: review-fix agent worktree isolation', () => {
  let agentContent;

  before(() => {
    const agentPath = path.join(__dirname, '..', 'agents', 'gsd-code-fixer.md');
    assert.ok(fs.existsSync(agentPath), 'agents/gsd-code-fixer.md must exist');
    agentContent = fs.readFileSync(agentPath, 'utf-8');
  });

  test('agent instructions include git worktree add before any branch-switching checkout or commit', () => {
    const worktreePos = agentContent.indexOf('git worktree add');

    assert.ok(
      worktreePos !== -1,
      'gsd-code-fixer.md must include a "git worktree add" instruction to isolate operations from the main working tree (#2686)'
    );

    // `git checkout -- {file}` is a file-restore within the worktree — safe, not a branch switch.
    // The dangerous operation is `git checkout <branch>` (no leading --).
    // Find the first branch-switching checkout (pattern: "git checkout " NOT followed by "--").
    const branchCheckoutMatch = /git checkout (?!--)/.exec(agentContent);
    if (branchCheckoutMatch) {
      const branchCheckoutPos = branchCheckoutMatch.index;
      assert.ok(
        worktreePos < branchCheckoutPos,
        'git worktree add must appear before any branch-switching git checkout in the agent instructions'
      );
    }

    // commit command must come after worktree setup — the fixer may use
    // either `git commit` directly or `gsd-sdk query commit`
    const commitMatch = /(?:git commit|gsd-sdk query commit)/.exec(agentContent);
    if (commitMatch) {
      const commitPos = commitMatch.index;
      assert.ok(
        worktreePos < commitPos,
        'git worktree add must appear before any commit command in the agent instructions'
      );
    }
  });

  test('agent instructions include worktree cleanup after completion', () => {
    assert.ok(
      agentContent.includes('git worktree remove') || agentContent.includes('worktree remove'),
      'gsd-code-fixer.md must include worktree cleanup (git worktree remove) to avoid leaking tmp directories (#2686)'
    );
  });

  test('agent instructions use a repo-relative worktree path under .claude/worktrees/ (not a hardcoded /tmp path)', () => {
    // #2647: the original #2686 fix placed the worktree at a hardcoded `/tmp/sv-`
    // mktemp path to match sibling GSD agents. On Windows/Git Bash that landed
    // OUTSIDE the project tree — outside the agent session's permission allowlist,
    // so every Read inside the worktree prompted — and mktemp's MAX_PATH-avoidance
    // substitute produced an un-removable `C:/mvwtNN` path. The worktree must now
    // be repo-relative under `.claude/worktrees/` (the same dir the harness-managed
    // executor worktrees use: gitignored via `.claude/`, inside the permission
    // scope), and the agent must NOT define a `/tmp/sv-` worktree path.
    const hasTmpWorktreePath =
      /\/tmp\/sv-/.test(agentContent) ||
      /\bwt\s*=\s*["']?\/tmp\/sv-/.test(agentContent);
    assert.ok(
      !hasTmpWorktreePath,
      'gsd-code-fixer.md must NOT define a worktree variable at a /tmp/sv-... path (#2647 — use a repo-relative .claude/worktrees/ path instead)'
    );
    assert.ok(
      /\.claude\/worktrees\//.test(agentContent),
      'gsd-code-fixer.md must define the worktree under .claude/worktrees/ (repo-relative, gitignored, inside the permission scope) (#2647)'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2500-codebase-mapper-arch-rich-format.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2500-codebase-mapper-arch-rich-format (consolidation epic #1969 B7 #1976)", () => {
/**
 * Enhancement #2500: gsd-codebase-mapper (arch focus) rich architecture output
 *
 * The codebase/ARCHITECTURE.md produced by gsd-codebase-mapper was a sparse
 * structural inventory — file listings and module relationships. After a major
 * refactor, research/ARCHITECTURE.md (created at /gsd-new-project) goes stale
 * with no refresh command. This enhancement enriches the codebase mapper's
 * arch-focus template to match the richness of the research version:
 *   - ASCII system overview diagram
 *   - Data flow traces with numbered steps and code references
 *   - Component responsibility table (component → responsibility → file)
 *   - Critical architectural constraints
 *   - Anti-patterns specific to the codebase
 *   - <!-- refreshed: {date} --> marker at top (maintainer request)
 *
 * The agent's template text IS what the runtime executes, so testing
 * the template content directly tests the deployed contract.
 */

'use strict';

// allow-test-rule: source-text-is-the-product (see #2500)
// The gsd-codebase-mapper ARCHITECTURE.md template is the instruction set
// executed by the LLM at runtime. Testing its text content tests whether the
// deployed agent will produce rich architecture docs as required by #2500.

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENT_PATH = path.join(__dirname, '..', 'agents', 'gsd-codebase-mapper.md');

describe('enh-2500: gsd-codebase-mapper arch focus — rich architecture output', () => {
  let agentContent;
  let archTemplate;

  before(() => {
    assert.ok(fs.existsSync(AGENT_PATH), 'agents/gsd-codebase-mapper.md must exist');
    agentContent = fs.readFileSync(AGENT_PATH, 'utf-8');

    // Isolate the ARCHITECTURE.md template section from the agent file.
    // End boundary is the STRUCTURE.md Template heading that immediately follows it.
    const archStart = agentContent.indexOf('## ARCHITECTURE.md Template (arch focus)');
    assert.ok(archStart !== -1, 'agent must contain an ARCHITECTURE.md Template (arch focus) section');

    const archEnd = agentContent.indexOf('## STRUCTURE.md Template (arch focus)', archStart + 1);
    archTemplate = archEnd !== -1
      ? agentContent.slice(archStart, archEnd)
      : agentContent.slice(archStart);
  });

  test('template includes a refreshed date marker', () => {
    assert.ok(
      archTemplate.includes('<!-- refreshed:') || archTemplate.includes('refreshed:'),
      'ARCHITECTURE.md template must include a <!-- refreshed: {date} --> marker so users can see when the doc was last generated (#2500 maintainer requirement)'
    );
  });

  test('template includes an ASCII system overview diagram', () => {
    // ASCII diagrams use box-drawing characters or at minimum ┌/└/│/─ or +/|/-
    const hasAsciiDiagram =
      archTemplate.includes('┌') ||
      archTemplate.includes('└') ||
      archTemplate.includes('│') ||
      archTemplate.includes('+--') ||
      archTemplate.includes('+-') ||
      archTemplate.includes('→') ||
      archTemplate.includes('↓') ||
      archTemplate.includes('↑');

    assert.ok(
      hasAsciiDiagram,
      'ARCHITECTURE.md template must include an ASCII system overview diagram (box-drawing characters or flow arrows) as required by #2500'
    );
  });

  test('template includes System Overview section header', () => {
    assert.ok(
      archTemplate.includes('System Overview') || archTemplate.includes('system overview'),
      'ARCHITECTURE.md template must include a "System Overview" section for the ASCII diagram (#2500)'
    );
  });

  test('template includes a component responsibility table with required columns', () => {
    // Must have a markdown table with component, responsibility, and file columns
    const hasComponentCol =
      archTemplate.includes('Component') || archTemplate.includes('component');
    const hasResponsibilityCol =
      archTemplate.includes('Responsibility') || archTemplate.includes('responsibility');
    const hasFileCol =
      archTemplate.includes('File') || archTemplate.includes('file');

    assert.ok(
      hasComponentCol && hasResponsibilityCol && hasFileCol,
      'ARCHITECTURE.md template must include a component responsibility table with Component, Responsibility, and File columns (#2500)'
    );
  });

  test('template includes data flow traces with numbered steps', () => {
    const hasPrimaryRequestPath = /###\s+Primary Request Path/i.test(archTemplate);
    // [^\n]+ + \r?\n is CRLF-tolerant: .+ doesn't match \r in JS regex by
    // default, so \r before the literal \n in CRLF content kills the match.
    const hasThreeNumberedSteps = /^\s*1\.[^\n]+\r?\n\s*2\.[^\n]+\r?\n\s*3\./m.test(archTemplate);
    const hasFileLineRefs = /\(`\[.*:(?:line|\d+)\]`\)/.test(archTemplate);

    assert.ok(
      hasPrimaryRequestPath && hasThreeNumberedSteps && hasFileLineRefs,
      'ARCHITECTURE.md template must include a "Primary Request Path" section with numbered steps and file:line references (#2500)'
    );
  });

  test('template includes architectural constraints section', () => {
    const hasConstraints =
      /##\s+Architectural Constraints/i.test(archTemplate) &&
      /\bThreading\b/.test(archTemplate) &&
      /\bGlobal state\b/i.test(archTemplate) &&
      /\bCircular imports\b/i.test(archTemplate);

    assert.ok(
      hasConstraints,
      'ARCHITECTURE.md template must include an "Architectural Constraints" section with Threading, Global state, and Circular imports categories (#2500)'
    );
  });

  test('template includes anti-patterns section', () => {
    assert.ok(
      archTemplate.includes('Anti-pattern') ||
      archTemplate.includes('Anti-Pattern') ||
      archTemplate.includes('anti-pattern'),
      'ARCHITECTURE.md template must include an anti-patterns section specific to the codebase (#2500)'
    );
  });
});
  });
}

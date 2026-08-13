// allow-test-rule: source-text-is-the-product
// The agent_skills injection for the review-family workflows lives as text in
// the workflow .md files — that text IS what the orchestrating runtime loads
// and executes. There is no intermediate runtime that parses these workflows
// into a prompt we could assert on structurally, so the deployed contract is
// the workflow text itself.
//
// Regression guard for #991: code-review.md / code-review-fix.md /
// eval-review.md were the lone outliers among ~20 workflows that never
// injected the project-configured agent_skills into the subagents they spawn.
// Subagents do not inherit the orchestrator's auto-loaded context, so this
// injection is the ONLY channel for reviewer/fixer/auditor rule context.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { escapeRegex: escapeRe } = require('../gsd-core/bin/lib/pattern.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

// Workflow file -> EVERY subagent type it spawns and must inject skills for.
// A workflow can spawn more than one agent type: code-review-fix.md spawns the
// fixer (twice) AND re-spawns the reviewer in its --auto loop, so it must
// inject skills for BOTH. Listing every spawned type here is what catches a
// partially-fixed workflow (the gap Codex flagged on the first pass at #991).
const REVIEW_FAMILY = [
  { file: 'code-review.md', agentTypes: ['gsd-code-reviewer'] },
  { file: 'code-review-fix.md', agentTypes: ['gsd-code-fixer', 'gsd-code-reviewer'] },
  { file: 'eval-review.md', agentTypes: ['gsd-eval-auditor'] },
];

const cases = REVIEW_FAMILY.flatMap(({ file, agentTypes }) =>
  agentTypes.map((agentType) => ({ file, agentType })),
);

describe('agent_skills injection — review-family workflows (#991)', () => {
  for (const { file, agentType } of cases) {
    test(`${file} queries + injects agent_skills for every ${agentType} spawn`, () => {
      const content = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');

      // 1. Must query the project-configured skills for this agent type, using
      //    the same `gsd_run query agent-skills <type>` idiom as the ~20
      //    sibling workflows (plan-phase, execute-phase, secure-phase, ...).
      const assignRe = new RegExp(
        '([A-Z][A-Z0-9_]*)=\\$\\(\\s*gsd_run query agent-skills ' + escapeRe(agentType) + '\\s*\\)',
      );
      const m = content.match(assignRe);
      assert.ok(
        m,
        `${file}: missing \`VAR=$(gsd_run query agent-skills ${agentType})\` — configured agent_skills are never queried (#991)`,
      );
      const varName = m[1];

      // 2. The queried block must be interpolated into the spawn prompt for
      //    EVERY spawn of this agent type. code-review-fix.md spawns the fixer
      //    twice (initial + auto-iteration re-spawn); both must inject, or a
      //    spawn runs under-equipped.
      const interpolations = content.split('${' + varName + '}').length - 1;
      const spawnCount = (
        content.match(new RegExp('subagent_type=["\']' + escapeRe(agentType) + '["\']', 'g')) || []
      ).length;
      assert.ok(
        interpolations >= Math.max(1, spawnCount),
        `${file}: \${${varName}} is interpolated ${interpolations}x but ${agentType} is spawned ${spawnCount}x — every spawn must inject the skills block (#991)`,
      );
    });
  }
});

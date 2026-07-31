/**
 * Drift guard for gsd:plan-phase workflow (#22)
 *
 * Validates that the plan-phase workflow contains the key structural elements
 * added for issue #22 Change #1:
 *
 * (A) intel.enabled gate — when intel.enabled is true, plan-phase regenerates
 *     API-SURFACE.md via `gsd-tools intel api-surface` and injects it into the
 *     planner's required reading as a HINT (prefer symbols, may be incomplete,
 *     absence = unknown, never exhaustive).
 *
 * (B) "Artifacts this phase produces" section — every PLAN.md must include
 *     this section so the plan-review-convergence source-grounding pass can
 *     exclude newly-created symbols from drift verification.
 */

// allow-test-rule: source-text-is-the-product
// The workflow markdown IS the runtime instruction. Testing its text content
// tests the deployed contract — if the intel gate or Artifacts section
// requirement is absent, the drift-guard feature is absent from defenses too.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'plan-phase.md'
);

// ─── Fixture ──────────────────────────────────────────────────────────────────

const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

// ─── (A) intel.enabled gate ───────────────────────────────────────────────────

describe('plan-phase workflow: intel.enabled gate for API-SURFACE injection (#22)', () => {
  test('workflow reads intel.enabled config before planner spawn', () => {
    assert.ok(
      workflow.includes('intel.enabled'),
      'workflow must gate API-SURFACE generation on intel.enabled config key'
    );
  });

  test('workflow runs gsd-tools intel api-surface to regenerate surface', () => {
    assert.ok(
      workflow.includes('intel api-surface'),
      'workflow must call `gsd_run intel api-surface` (or equivalent) to regenerate API-SURFACE.md'
    );
  });

  test('workflow injects API-SURFACE.md into planner files_to_read when intel.enabled', () => {
    assert.ok(
      workflow.includes('API-SURFACE.md') && workflow.includes('API_SURFACE_PATH'),
      'workflow must pass API_SURFACE_PATH into the planner prompt files_to_read block'
    );
  });

  test('workflow labels the surface as a HINT (not a hard rule)', () => {
    assert.ok(
      workflow.includes('HINT') || workflow.includes('intel_surface_hint'),
      'API-SURFACE.md must be annotated as a HINT, never a hard rule'
    );
  });

  test('workflow documents that surface absence means unknown not nonexistent', () => {
    assert.ok(
      workflow.includes("absence means *unknown*, not *nonexistent*") ||
      workflow.includes("absence = unknown") ||
      workflow.includes("absence means unknown"),
      "workflow must state that a symbol's absence from the surface means unknown, not nonexistent"
    );
  });

  test('workflow states the surface may be incomplete', () => {
    assert.ok(
      workflow.includes('MAY BE INCOMPLETE') || workflow.includes('may be incomplete'),
      'workflow must warn that the API surface may be incomplete'
    );
  });

  test('workflow skips surface injection when intel.enabled is false', () => {
    assert.ok(
      workflow.includes('no active intel step hook exists') &&
      workflow.includes('API_SURFACE_PATH') &&
      (workflow.includes('when: intel.enabled') || workflow.includes('"when": "intel.enabled"')),
      'workflow must skip the intel step when intel.enabled is false — enforced via capability registry when: gate and explicit no-active-hook skip branch'
    );
  });
});

// ─── (B) "Artifacts this phase produces" requirement ─────────────────────────

describe('plan-phase workflow: Artifacts this phase produces section (#22)', () => {
  test('downstream_consumer block requires Artifacts this phase produces section', () => {
    assert.ok(
      workflow.includes('Artifacts this phase produces'),
      'downstream_consumer must list "Artifacts this phase produces" as a required plan section'
    );
  });

  test('quality_gate checklist includes Artifacts this phase produces item', () => {
    // Find the quality_gate block and confirm the checklist item is there
    const qualityGateMatch = workflow.match(/<quality_gate>([\s\S]*?)<\/quality_gate>/);
    assert.ok(
      qualityGateMatch,
      'workflow must have a <quality_gate> block'
    );
    assert.ok(
      qualityGateMatch[1].includes('Artifacts this phase produces'),
      '<quality_gate> checklist must include an "Artifacts this phase produces" item'
    );
  });

  test('workflow explains why Artifacts section is needed (source-grounding reviewer)', () => {
    assert.ok(
      workflow.includes('source-grounding') || workflow.includes('plan-review-convergence'),
      'workflow must explain that the Artifacts section is consumed by the source-grounding pass'
    );
  });

  test('workflow lists symbol kinds for Artifacts section (decorators, classes, functions, CLI flags)', () => {
    // Must enumerate concrete symbol kinds so planner knows what to list
    const hasDecorators = workflow.includes('decorators');
    const hasClasses = workflow.includes('classes');
    const hasFunctions = workflow.includes('functions');
    const hasCliFlags = workflow.includes('CLI flags');
    assert.ok(
      hasDecorators && hasClasses && hasFunctions && hasCliFlags,
      'workflow must enumerate symbol kinds: decorators, classes, functions, CLI flags (needed for Artifacts section guidance)'
    );
  });
});

// ─── (C) Top-level spawn guard (#913) ────────────────────────────────────────

describe('plan-phase workflow: top-level spawn guard (#913)', () => {
  // Extract the runtime_compatibility block for targeted assertions
  const rtBlock = (() => {
    const m = workflow.match(/<runtime_compatibility>([\s\S]*?)<\/runtime_compatibility>/);
    return m ? m[1] : '';
  })();

  test('workflow has a runtime_compatibility block asserting Agent is available at top-level', () => {
    assert.ok(
      rtBlock.length > 0,
      'plan-phase must have a <runtime_compatibility> block — prevents role-collapse regression (#913)'
    );
    assert.ok(
      rtBlock.includes('Agent tool IS available') || rtBlock.includes('Agent IS available'),
      'plan-phase runtime_compatibility must assert that the Agent tool IS available at top-level Claude Code (#913)'
    );
    assert.ok(
      rtBlock.toLowerCase().includes('top-level'),
      'plan-phase runtime_compatibility must scope the IS-available assertion to top-level Claude Code (#913)'
    );
    assert.ok(
      rtBlock.includes('Always spawn') || rtBlock.includes('always spawn'),
      'plan-phase runtime_compatibility must state that plan roles must always be spawned (#913)'
    );
    assert.ok(
      rtBlock.includes('Never absorb') || rtBlock.includes('never absorb'),
      'plan-phase runtime_compatibility must state that roles must never be absorbed inline (#913)'
    );
  });

  test('workflow states --chain/--auto suppress prompts only, not spawns', () => {
    assert.ok(
      rtBlock.includes('suppress') &&
      (rtBlock.includes('prompts only') || rtBlock.includes('interactive prompts only')),
      'plan-phase runtime_compatibility must document that --chain/--auto suppress prompts only, not spawns (#913)'
    );
  });

  test('workflow does not contain unscoped CODEX RUNTIME orchestrator rule labels', () => {
    // All "wait for subagent" rules must apply to ALL RUNTIMES, not just Codex
    assert.ok(
      !workflow.includes('ORCHESTRATOR RULE — CODEX RUNTIME'),
      'plan-phase must not label orchestrator wait rules as "CODEX RUNTIME" — they apply to all runtimes including top-level Claude Code (#913)'
    );
  });

  test('workflow contains ALL RUNTIMES orchestrator rule labels (count preserved)', () => {
    // Must have all 7 agent-spawn wait rules still present (none dropped during rename)
    const allRuntimesCount = (workflow.match(/ORCHESTRATOR RULE — ALL RUNTIMES/g) || []).length;
    assert.ok(
      allRuntimesCount >= 7,
      `plan-phase must have at least 7 "ORCHESTRATOR RULE — ALL RUNTIMES" labels (one per agent spawn site); found ${allRuntimesCount} (#913)`
    );
  });
});

// ─── (D) Attempt-based Agent gate (#922) ─────────────────────────────────────

describe('plan-phase workflow: attempt-based Agent availability gate (#922)', () => {
  // Extract the runtime_compatibility block for targeted assertions
  const rtBlock = (() => {
    const m = workflow.match(/<runtime_compatibility>([\s\S]*?)<\/runtime_compatibility>/);
    return m ? m[1] : '';
  })();

  // Extract the "Other runtimes" clause specifically
  const otherRuntimesClause = (() => {
    const m = rtBlock.match(/\*\*Other runtimes[^*]*\*\*[^\n]*\n([\s\S]*?)(?=\n\*\*|$)/);
    return m ? m[0] : rtBlock;
  })();

  test('Other runtimes clause does not authorize stopping on a self-assessed absence (#922)', () => {
    // The pre-#922 wording ("if the Agent tool is genuinely absent") let the model
    // self-assess and stop without ever attempting a call. The fixed wording must
    // not contain phrasing that authorizes that pattern.
    const forbiddenPatterns = [
      /if the Agent tool is genuinely absent/i,
      /if.*Agent.*genuinely absent/i,
    ];
    for (const pattern of forbiddenPatterns) {
      assert.ok(
        !pattern.test(otherRuntimesClause),
        `plan-phase "Other runtimes" clause must not authorize stopping on a self-assessed Agent absence — ` +
        `use attempt-based gate instead (#922). Found: ${otherRuntimesClause.trim()}`
      );
    }
  });

  test('Other runtimes clause pins "Always attempt the actual Agent() call" language (#922)', () => {
    // Pin the exact contract phrase so a future edit that changes to "try to determine
    // availability" or "check if Agent is available" does not silently reintroduce introspection.
    assert.ok(
      otherRuntimesClause.includes('Always attempt the actual') ||
      otherRuntimesClause.includes('always attempt the actual'),
      `plan-phase "Other runtimes" clause must pin "Always attempt the actual Agent() call" (or equivalent) (#922). ` +
      `Found: ${otherRuntimesClause.trim()}`
    );
  });

  test('Other runtimes clause pins "real tool-unavailable error" as the only valid stop signal (#922)', () => {
    // Must tie the stop to a real returned error, not a self-assessed absence.
    assert.ok(
      otherRuntimesClause.includes('real tool-unavailable error') ||
      otherRuntimesClause.includes('tool-unavailable error returned'),
      `plan-phase "Other runtimes" clause must state only a real tool-unavailable error from Agent() authorizes stopping (#922). ` +
      `Found: ${otherRuntimesClause.trim()}`
    );
  });

  test('Other runtimes clause still prohibits inline role collapse (#922 preserves #913)', () => {
    // Even after the attempt-based rewrite the clause must keep the no-inline-collapse guard.
    const hasNoInline =
      otherRuntimesClause.toLowerCase().includes('do not') &&
      (otherRuntimesClause.toLowerCase().includes('inline') ||
       otherRuntimesClause.toLowerCase().includes('collapse'));
    assert.ok(
      hasNoInline,
      `plan-phase "Other runtimes" clause must still prohibit inline role collapse even with the attempt-based gate (#922). ` +
      `Found: ${otherRuntimesClause.trim()}`
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2948-spike-wrap-up-dispatch.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2948-spike-wrap-up-dispatch (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for bug #2948
 *
 * `/gsd:spike --wrap-up` was silently no-oping because:
 * 1. `commands/gsd/spike.md` listed `--wrap-up` as a flag but had no dispatch block.
 * 2. `workflows/spike.md` still referenced the deleted `/gsd-spike-wrap-up` entry-point
 *    instead of the correct `/gsd:spike --wrap-up` form.
 *
 * Fix:
 * - `commands/gsd/spike.md` now has a dispatch block that routes `--wrap-up` to
 *   spike-wrap-up.md, and spike-wrap-up.md is listed in execution_context so the
 *   runtime can find it.
 * - `workflows/spike.md` companion references updated from `/gsd-spike-wrap-up` to
 *   `/gsd:spike --wrap-up`.
 */

// allow-test-rule: source-text-is-the-product (see #2948)
// commands/gsd/*.md files ARE what the runtime loads — testing their
// frontmatter and section content tests the deployed system-prompt contract.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SPIKE_CMD_PATH = path.join(__dirname, '..', 'commands', 'gsd', 'spike.md');
const SPIKE_WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'spike.md');

/**
 * Parse YAML frontmatter + body from a markdown file.
 * Returns a shallow { key: value } map of frontmatter fields plus `_body`.
 * Mirrors the parseFrontmatter utility used in enh-2792-namespace-skills.test.cjs.
 */
function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);

  // Frontmatter must start at the very first line; a mid-file '---' is a
  // horizontal rule, not a frontmatter delimiter.
  if (lines[0]?.trim() !== '---') {
    return { _body: content };
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  assert.ok(closeIdx !== -1, 'frontmatter block must be delimited by --- on its own lines');
  const fm = {};
  for (const line of lines.slice(1, closeIdx)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    fm[key] = raw.trim().replace(/^["']|["']$/g, '');
  }
  fm._body = lines.slice(closeIdx + 1).join('\n');
  return fm;
}

/**
 * Extract the text content of a named XML-like section from a markdown body.
 * Returns null if the section is absent.
 */
function extractSection(body, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = body.indexOf(open);
  const end = body.indexOf(close);
  if (start === -1 || end === -1) return null;
  return body.slice(start + open.length, end);
}

/**
 * Parse the @-prefixed workflow references out of an execution_context section.
 * Returns an array of resolved reference strings (@ stripped).
 */
function parseExecutionContextRefs(section) {
  return section
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.startsWith('@'))
    .map(l => l.slice(1).trim());
}

describe('bug-2948: /gsd:spike --wrap-up dispatch wiring', () => {
  describe('commands/gsd/spike.md — frontmatter and section contract', () => {
    test('spike.md command file exists and has valid frontmatter', () => {
      assert.ok(fs.existsSync(SPIKE_CMD_PATH), 'commands/gsd/spike.md should exist');
      const fm = parseFrontmatter(fs.readFileSync(SPIKE_CMD_PATH, 'utf-8'));
      assert.ok(fm.name, 'frontmatter must have a name field');
    });

    test('argument-hint frontmatter field advertises --wrap-up flag', () => {
      const fm = parseFrontmatter(fs.readFileSync(SPIKE_CMD_PATH, 'utf-8'));
      assert.ok(
        fm['argument-hint'] && fm['argument-hint'].includes('--wrap-up'),
        `argument-hint must advertise --wrap-up; got: "${fm['argument-hint']}"`
      );
    });

    test('execution_context section includes spike-wrap-up workflow reference', () => {
      const fm = parseFrontmatter(fs.readFileSync(SPIKE_CMD_PATH, 'utf-8'));
      const execSection = extractSection(fm._body, 'execution_context');
      assert.ok(execSection !== null, 'spike.md must have an <execution_context> section');
      const refs = parseExecutionContextRefs(execSection);
      assert.ok(
        refs.some(r => r.includes('spike-wrap-up')),
        `execution_context must declare a spike-wrap-up reference so the runtime can load the workflow; ` +
        `declared refs: ${JSON.stringify(refs)}`
      );
    });

    test('process section dispatches first-token --wrap-up to spike-wrap-up workflow', () => {
      const fm = parseFrontmatter(fs.readFileSync(SPIKE_CMD_PATH, 'utf-8'));
      const processSection = extractSection(fm._body, 'process');
      assert.ok(processSection, 'spike.md must have a <process> section');

      const rules = processSection
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

      const wrapUpRule = rules.find(line => line.startsWith('- If it is `--wrap-up`:'));
      const fallbackRule = rules.find(line => line.startsWith('- Otherwise:'));

      assert.ok(
        wrapUpRule && wrapUpRule.includes('strip the flag') && wrapUpRule.includes('spike-wrap-up'),
        'process must define a --wrap-up branch that strips the flag and routes to spike-wrap-up'
      );
      assert.ok(
        fallbackRule && fallbackRule.includes('spike workflow'),
        'process must define an Otherwise fallback to the normal spike workflow'
      );
    });
  });

  describe('gsd-core/workflows/spike.md — companion references', () => {
    test('spike workflow file exists', () => {
      assert.ok(fs.existsSync(SPIKE_WORKFLOW_PATH), 'gsd-core/workflows/spike.md should exist');
    });

    test('does NOT reference the deleted /gsd-spike-wrap-up entry-point', () => {
      const fm = parseFrontmatter(fs.readFileSync(SPIKE_WORKFLOW_PATH, 'utf-8'));
      assert.ok(
        !fm._body.includes('/gsd-spike-wrap-up'),
        'workflows/spike.md must not reference the deleted /gsd-spike-wrap-up command; use /gsd:spike --wrap-up instead'
      );
    });

    test('references /gsd:spike --wrap-up as the canonical wrap-up invocation', () => {
      const fm = parseFrontmatter(fs.readFileSync(SPIKE_WORKFLOW_PATH, 'utf-8'));
      assert.ok(
        fm._body.includes('/gsd:spike --wrap-up'),
        'workflows/spike.md must reference /gsd:spike --wrap-up as the canonical wrap-up command'
      );
    });
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2949-sketch-wrap-up-dispatch.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2949-sketch-wrap-up-dispatch (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #2949)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * GSD Tests — /gsd:sketch --wrap-up silently no-ops (#2949)
 *
 * The --wrap-up flag was documented in commands/gsd/sketch.md but never dispatched.
 * The sketch-wrap-up.md micro-skill entry point was deleted in #2790 and the dispatch
 * wiring was never added to the command or workflow.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKETCH_COMMAND = path.join(ROOT, 'commands/gsd/sketch.md');
const SKETCH_WORKFLOW = path.join(ROOT, 'gsd-core/workflows/sketch.md');

describe('bug-2949: sketch --wrap-up dispatch wiring', () => {
  test('commands/gsd/sketch.md contains --wrap-up dispatch logic', () => {
    const content = fs.readFileSync(SKETCH_COMMAND, 'utf8');
    assert.ok(
      content.includes('--wrap-up'),
      'sketch.md should contain --wrap-up dispatch logic'
    );
    // The dispatch should route to sketch-wrap-up workflow
    assert.ok(
      content.includes('sketch-wrap-up'),
      'sketch.md should reference sketch-wrap-up in dispatch logic'
    );
  });

  test('commands/gsd/sketch.md has sketch-wrap-up in execution_context section', () => {
    const content = fs.readFileSync(SKETCH_COMMAND, 'utf8');
    // Find execution_context block
    const execCtxMatch = content.match(/<execution_context>([\s\S]*?)<\/execution_context>/);
    assert.ok(execCtxMatch, 'sketch.md must have an <execution_context> block');
    const execCtx = execCtxMatch[1];
    assert.ok(
      execCtx.includes('sketch-wrap-up'),
      `execution_context block should include sketch-wrap-up workflow; got: ${execCtx}`
    );
  });

  test('workflows/sketch.md does NOT contain old /gsd-sketch-wrap-up form', () => {
    const content = fs.readFileSync(SKETCH_WORKFLOW, 'utf8');
    assert.ok(
      !content.includes('/gsd-sketch-wrap-up'),
      'workflows/sketch.md must not reference the old /gsd-sketch-wrap-up command'
    );
  });

  test('workflows/sketch.md DOES contain new /gsd:sketch --wrap-up form', () => {
    const content = fs.readFileSync(SKETCH_WORKFLOW, 'utf8');
    assert.ok(
      content.includes('/gsd:sketch --wrap-up'),
      'workflows/sketch.md should reference /gsd:sketch --wrap-up (the new form)'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3156-plan-phase-opencode-dispatch.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3156-plan-phase-opencode-dispatch (consolidation epic #1969 B3 #1972)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #3156)
// commands/gsd/*.md files are the deployed skill surface. Their frontmatter
// IS the runtime contract. Checking frontmatter fields checks deployed behaviour.

/**
 * #3156 — plan-phase auto-dispatches to gsd-planner subagent on OpenCode,
 * losing Task tool access.
 *
 * Root cause: commands/gsd/plan-phase.md had `agent: gsd-planner` in its
 * frontmatter. Per OpenCode docs, `agent: <name>` in a command causes
 * auto-dispatch to a subagent context where the Agent (Task spawner) tool is
 * unavailable. Orchestrator commands that need to spawn subagents via the
 * Agent tool must NOT carry an `agent:` frontmatter directive.
 *
 * This test parses the YAML frontmatter of every commands/gsd/*.md file and
 * asserts:
 *   1. No command file has an `agent:` frontmatter directive at all.
 *      (The directive causes OpenCode to auto-dispatch, breaking any command
 *      that relies on the Agent tool to spawn subagents.)
 *   2. Any command whose allowed-tools includes `Agent` (an orchestrator) must
 *      not have `agent:` in its frontmatter.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');

/** Parse the YAML frontmatter block between the first two `---` delimiters. */
function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0].trim() !== '---') return {};
  const end = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
  if (end === -1) return {};
  const fm = {};
  let currentKey = null;
  for (const line of lines.slice(1, end)) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)/);
    if (kv) {
      currentKey = kv[1];
      fm[currentKey] = kv[2].trim();
    } else if (currentKey && line.match(/^\s+-\s+/)) {
      const val = line.replace(/^\s+-\s+/, '').trim();
      fm[currentKey] = fm[currentKey] ? fm[currentKey] + '\n' + val : val;
    }
  }
  return fm;
}

/** Return the list of tools from the allowed-tools frontmatter block. */
function allowedTools(fm) {
  const raw = fm['allowed-tools'];
  if (!raw) return [];
  // Multi-line YAML list: each entry on its own line
  if (raw.includes('\n')) {
    return raw.split('\n').map(t => t.trim()).filter(Boolean);
  }
  return raw.split(',').map(t => t.trim()).filter(Boolean);
}

const commandFiles = fs
  .readdirSync(COMMANDS_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => ({
    name: f,
    full: path.join(COMMANDS_DIR, f),
    content: fs.readFileSync(path.join(COMMANDS_DIR, f), 'utf-8'),
  }));

// ─── No command may carry `agent:` ────────────────────────────────────────────
//
// OpenCode interprets `agent: <name>` as "auto-dispatch to this subagent",
// which removes the Agent (subagent-spawner) tool from the command's context.
// Any orchestrator command is immediately broken. Commands that need to run in
// the main agent context (i.e., all GSD commands) must omit this directive.

describe('#3156 — no command file may have an `agent:` frontmatter directive', () => {
  for (const { name, content } of commandFiles) {
    test(`${name}: no agent: directive in frontmatter`, () => {
      const fm = parseFrontmatter(content);
      assert.ok(
        !Object.prototype.hasOwnProperty.call(fm, 'agent'),
        `${name}: has \`agent: ${fm['agent']}\` in frontmatter — ` +
        'this causes OpenCode to auto-dispatch to a subagent context where the ' +
        'Agent tool is unavailable, breaking orchestrator workflows. ' +
        'Remove the `agent:` directive so the command runs in the main agent context.',
      );
    });
  }
});

// ─── Orchestrator commands must not have `agent:` ────────────────────────────
//
// Redundant with the above (belt-and-suspenders), but captures the precise
// failure mode from #3156: a command whose allowed-tools includes `Agent`
// relies on spawning subagents. Pairing that with `agent:` is self-defeating.

describe('#3156 — orchestrator commands (allowed-tools: Agent) must not have agent:', () => {
  const orchestrators = commandFiles.filter(({ content }) => {
    const fm = parseFrontmatter(content);
    const tools = allowedTools(fm);
    return tools.includes('Agent');
  });

  for (const { name, content } of orchestrators) {
    test(`${name}: orchestrator must not carry agent: directive`, () => {
      const fm = parseFrontmatter(content);
      assert.ok(
        !Object.prototype.hasOwnProperty.call(fm, 'agent'),
        `${name}: allowed-tools includes Agent (orchestrator) but also has ` +
        `\`agent: ${fm['agent']}\` — OpenCode will auto-dispatch to a subagent ` +
        'where Agent is unavailable, making the orchestrator unable to spawn ' +
        'researcher/planner/checker subagents. Remove the `agent:` directive.',
      );
    });
  }
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2310-chunked-plan-phase.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2310-chunked-plan-phase (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #2310)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


/**
 * Tests for #2310: plan-phase chunked mode + filesystem fallback.
 *
 * Context: on Windows (and occasionally other platforms), gsd-planner's
 * Task() call may never return even though the subagent finished writing all
 * PLAN.md files to disk. The orchestrator hangs indefinitely. Two mitigations:
 *
 * 1. Filesystem fallback (steps 9a, 11a): if the Task() return lacks the
 *    expected marker but PLAN.md files exist on disk, surface a recoverable
 *    prompt instead of hanging/failing silently.
 *
 * 2. Chunked mode (step 8.5): --chunked flag / workflow.plan_chunked config
 *    splits the single long planner Task into (a) a short outline Task and
 *    (b) N short single-plan Tasks. Each Task is shorter-lived, the
 *    orchestrator can commit work incrementally, and a hang loses only one
 *    plan instead of the entire phase.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLAN_PHASE = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md'
);

const PLANNER_AGENT = path.join(__dirname, '..', 'agents', 'gsd-planner.md');
const PLANNER_CHUNKED_REF = path.join(__dirname, '..', 'gsd-core', 'references', 'planner-chunked.md');
const CONFIG_SCHEMA = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'config-schema.cjs');
const CONFIGURATION_MD = path.join(__dirname, '..', 'docs', 'CONFIGURATION.md');

describe('plan-phase.md — filesystem fallback (#2310)', () => {
  const content = fs.readFileSync(PLAN_PHASE, 'utf-8');

  test('step 9 checks PLAN.md count on disk when planner return lacks completion marker', () => {
    assert.ok(
      content.includes('DISK_PLANS=$(ls "${PHASE_DIR}"/*-PLAN.md'),
      'step 9a must check disk for PLAN.md files via DISK_PLANS variable'
    );
  });

  test('step 9a fallback section exists', () => {
    assert.ok(
      content.includes('## 9a. Filesystem Fallback'),
      'plan-phase.md must have a ## 9a. Filesystem Fallback section for planner hang recovery'
    );
  });

  test('step 9a fallback offers Accept plans option', () => {
    assert.ok(
      content.includes('Accept plans'),
      'step 9a must offer "Accept plans" as a recovery option'
    );
  });

  test('step 9a fallback offers Retry planner option', () => {
    assert.ok(
      content.includes('Retry planner'),
      'step 9a must offer "Retry planner" as a recovery option'
    );
  });

  test('step 11 has filesystem fallback section', () => {
    assert.ok(
      content.includes('## 11a. Filesystem Fallback'),
      'plan-phase.md must have a ## 11a. Filesystem Fallback section for checker hang recovery'
    );
  });

  test('step 11a fallback offers Accept verification option', () => {
    assert.ok(
      content.includes('Accept verification'),
      'step 11a must offer "Accept verification" as a recovery option'
    );
  });

  test('step 11a fallback offers Retry checker option', () => {
    assert.ok(
      content.includes('Retry checker'),
      'step 11a must offer "Retry checker" as a recovery option'
    );
  });

  test('step 9 routes to step 9a when no recognized marker found', () => {
    assert.ok(
      content.includes('step 9a') || content.includes('9a.'),
      'step 9 handle-return must reference the filesystem fallback path (step 9a)'
    );
  });

  test('step 11 routes to step 11a when no recognized marker found', () => {
    assert.ok(
      content.includes('step 11a') || content.includes('11a.'),
      'step 11 handle-return must reference the filesystem fallback path (step 11a)'
    );
  });
});

describe('plan-phase.md — chunked mode flag and config (#2310)', () => {
  const content = fs.readFileSync(PLAN_PHASE, 'utf-8');

  test('step 2 parses --chunked flag', () => {
    assert.ok(
      content.includes('--chunked'),
      'step 2 must parse --chunked flag from $ARGUMENTS'
    );
  });

  test('step 2 reads workflow.plan_chunked config', () => {
    assert.ok(
      content.includes('workflow.plan_chunked'),
      'step 2 must read workflow.plan_chunked config key'
    );
  });

  test('step 2 sets CHUNKED_MODE variable', () => {
    assert.ok(
      content.includes('CHUNKED_MODE'),
      'step 2 must set CHUNKED_MODE from flag or config'
    );
  });
});

describe('plan-phase.md — chunked mode implementation (#2310)', () => {
  const content = fs.readFileSync(PLAN_PHASE, 'utf-8');

  test('step 8.5 chunked planning section exists', () => {
    assert.ok(
      content.includes('## 8.5.'),
      'plan-phase.md must have a step 8.5 section for chunked planning mode'
    );
  });

  test('chunked mode produces PLAN-OUTLINE.md', () => {
    assert.ok(
      content.includes('PLAN-OUTLINE.md'),
      'chunked mode outline step must produce a *-PLAN-OUTLINE.md file'
    );
  });

  test('chunked outline step uses outline-only mode', () => {
    assert.ok(
      content.includes('outline-only'),
      'chunked step 8.5.1 must spawn the planner in outline-only mode'
    );
  });

  test('chunked per-plan step uses single-plan mode', () => {
    assert.ok(
      content.includes('single-plan'),
      'chunked step 8.5.2 must spawn the planner in single-plan mode for each plan'
    );
  });

  test('chunked mode checks for existing outline to enable resume', () => {
    // The resume check skips the outline Task if PLAN-OUTLINE.md already exists
    assert.ok(
      content.includes('PLAN-OUTLINE.md') && content.includes('already exists'),
      'chunked mode must detect existing PLAN-OUTLINE.md and skip outline generation (resume safety)'
    );
  });

  test('chunked mode commits each plan individually', () => {
    assert.ok(
      content.includes('chunked'),
      'chunked mode must commit each individual plan for crash resilience'
    );
  });

  test('step 8 routes to chunked path when CHUNKED_MODE is true', () => {
    assert.ok(
      content.includes('CHUNKED_MODE') && content.includes('8.5'),
      'step 8 must route to step 8.5 when CHUNKED_MODE is true'
    );
  });
});

describe('gsd-planner.md — references planner-chunked.md (#2310)', () => {
  const plannerContent = fs.readFileSync(PLANNER_AGENT, 'utf-8');

  test('gsd-planner.md references planner-chunked.md for chunked return formats', () => {
    assert.ok(
      plannerContent.includes('planner-chunked.md'),
      'gsd-planner.md must reference planner-chunked.md for ## OUTLINE COMPLETE / ## PLAN COMPLETE formats'
    );
  });
});

describe('planner-chunked.md — chunked return formats (#2310)', () => {
  const content = fs.readFileSync(PLANNER_CHUNKED_REF, 'utf-8');

  test('planner-chunked.md defines OUTLINE COMPLETE structured return', () => {
    assert.ok(
      content.includes('## OUTLINE COMPLETE'),
      'planner-chunked.md must define ## OUTLINE COMPLETE return format for outline-only mode'
    );
  });

  test('planner-chunked.md defines PLAN COMPLETE structured return for single-plan mode', () => {
    assert.ok(
      content.includes('## PLAN COMPLETE'),
      'planner-chunked.md must define ## PLAN COMPLETE return format for single-plan mode'
    );
  });

  test('planner-chunked.md describes resume behaviour', () => {
    assert.ok(
      content.includes('Resume') || content.includes('resume'),
      'planner-chunked.md must describe resume behaviour for interrupted chunked runs'
    );
  });
});

describe('config-schema.cjs — workflow.plan_chunked key (#2310)', () => {
  test('VALID_CONFIG_KEYS includes workflow.plan_chunked', () => {
    const { VALID_CONFIG_KEYS } = require(CONFIG_SCHEMA);
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.plan_chunked'),
      'config-schema.cjs VALID_CONFIG_KEYS must include workflow.plan_chunked'
    );
  });
});

describe('docs/CONFIGURATION.md — workflow.plan_chunked documented (#2310)', () => {
  const content = fs.readFileSync(CONFIGURATION_MD, 'utf-8');

  test('CONFIGURATION.md documents workflow.plan_chunked', () => {
    assert.ok(
      content.includes('`workflow.plan_chunked`'),
      'docs/CONFIGURATION.md must document workflow.plan_chunked'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-3209-plan-phase-ingest-adr.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-3209-plan-phase-ingest-adr (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #3209)
// These assertions validate shipped workflow/command markdown contracts.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const COMMAND_PATH = path.join(ROOT, 'commands', 'gsd', 'plan-phase.md');
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'plan-phase.md');
const DOCS_COMMANDS_PATH = path.join(ROOT, 'docs', 'COMMANDS.md');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

describe('enh #3209: plan-phase ADR ingest express path', () => {
  test('command argument-hint advertises --ingest and --ingest-format', () => {
    const command = read(COMMAND_PATH);
    assert.ok(command.includes('--ingest <path-or-glob>'),
      'plan-phase command argument-hint must include --ingest <path-or-glob>');
    assert.ok(command.includes('--ingest-format <auto|nygard|madr|narrative>'),
      'plan-phase command argument-hint must include --ingest-format selector');
  });

  test('workflow parses --ingest and --ingest-format flags', () => {
    const workflow = read(WORKFLOW_PATH);
    assert.ok(workflow.includes('--ingest <path-or-glob>'),
      'plan-phase workflow argument parsing must mention --ingest');
    assert.ok(workflow.includes('--ingest-format'),
      'plan-phase workflow argument parsing must mention --ingest-format');
  });

  test('workflow has explicit mutual exclusion guard for --prd and --ingest', () => {
    const workflow = read(WORKFLOW_PATH);
    assert.ok(
      workflow.includes('cannot combine `--prd` with `--ingest`') ||
      workflow.includes('mutually exclusive'),
      'plan-phase workflow must fail fast when --prd and --ingest are both provided'
    );
  });

  test('workflow defines an ADR ingest express-path step', () => {
    const workflow = read(WORKFLOW_PATH);
    assert.ok(/##\s*(?:\d+(?:\.\d+)*)?\.?\s*Handle ADR Ingest Express Path/i.test(workflow),
      'plan-phase workflow must include a dedicated ADR ingest express-path step');
    assert.ok(workflow.includes('ADR Ingest Express Path'),
      'workflow must display ADR ingest express-path banner text');
  });

  test('ADR ingest context template includes scope fence and ADR source attribution', () => {
    const workflow = read(WORKFLOW_PATH);
    assert.ok(workflow.includes('<scope_fence>'),
      'ADR ingest context template must include <scope_fence> for hard out-of-scope exclusions');
    assert.ok(workflow.includes('Source:** ADR Ingest Express Path'),
      'ADR ingest context template must tag source as ADR Ingest Express Path');
  });

  test('workflow documents status gate and no-decisions fallback', () => {
    const workflow = read(WORKFLOW_PATH);
    assert.ok(
      workflow.includes('Reject `superseded`/`rejected`/`deprecated`') ||
      workflow.includes('reject `superseded`/`rejected`/`deprecated`') ||
      /superseded.*rejected.*deprecated/i.test(workflow),
      'ADR ingest workflow must include status gate for non-active ADRs'
    );
    assert.ok(
      workflow.includes('empty-decisions fallback') ||
      workflow.includes('fall back to discuss-phase'),
      'ADR ingest workflow must document fallback when no locked decisions are present'
    );
  });

  test('docs COMMANDS advertises --ingest flag for /gsd-plan-phase', () => {
    const commands = read(DOCS_COMMANDS_PATH);
    assert.ok(commands.includes('--ingest <path-or-glob>'),
      'docs/COMMANDS.md must document --ingest for /gsd-plan-phase');
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-621-plan-phase-gap-analysis-gsd-run.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-621-plan-phase-gap-analysis-gsd-run (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #621)
// The post-planning-gaps gap-analysis invocation is deployed workflow text the
// runtime executes; the contract is that it routes through the gsd_run launcher,
// not a hardcoded $HOME path (#621).

/**
 * Regression test for #621: plan-phase gap-analysis must route through gsd_run
 *
 * Prior to the fix, line 1631 of plan-phase.md hardcoded:
 *   node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" gap-analysis ...
 * twice on the same line, breaking non-default install layouts.
 *
 * After the fix, both invocations route through gsd_run (the launcher defined
 * at line ~34 of the same file that resolves gsd-tools.cjs against
 * RUNTIME_DIR / git-toplevel / PATH / $HOME in order).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'plan-phase.md'
);

// ─── Fixture ──────────────────────────────────────────────────────────────────

const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

// ─── #621 regression: gap-analysis routes through gsd_run ────────────────────

describe('plan-phase workflow: post-planning-gaps gap-analysis uses gsd_run launcher (#621)', () => {
  test('gap-analysis dispatches via gsd_run loop render-hooks plan:post (ADR-857 capability gate)', () => {
    assert.ok(
      workflow.includes('gsd_run loop render-hooks plan:post'),
      'workflow must dispatch gap-analysis via gsd_run loop render-hooks plan:post, not a hardcoded node path or direct gsd_run gap-analysis call'
    );
  });

  test('inner phase_req_ids query also routes through gsd_run', () => {
    assert.ok(
      workflow.includes('gsd_run query init.plan-phase'),
      'workflow must invoke the inner phase_req_ids query via gsd_run launcher'
    );
  });

  test('no hardcoded node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" invocations remain (#621)', () => {
    const hardcodedCount = (
      workflow.match(/node "\$HOME\/\.claude\/gsd-core\/bin\/gsd-tools\.cjs"/g) || []
    ).length;
    assert.strictEqual(
      hardcodedCount,
      0,
      [
        '#621 regression: workflow must not contain any hardcoded',
        'node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" invocations;',
        `found ${hardcodedCount}`,
      ].join(' ')
    );
  });

  test('post-planning-gaps block still gates on workflow.post_planning_gaps and preserves required args', () => {
    const hasGate = workflow.includes('workflow.post_planning_gaps');
    const hasPhaseDir = workflow.includes('gsd_run check ${hook.check.query} "${PHASE_DIR}" "${PHASE_REQ_IDS}"');
    const hasPickArg = workflow.includes('--pick phase_req_ids');
    assert.ok(
      hasGate,
      'workflow must still gate the gap-analysis step on workflow.post_planning_gaps config key'
    );
    assert.ok(
      hasPhaseDir,
      'gap-analysis check dispatch must pass "${PHASE_DIR}" (and "${PHASE_REQ_IDS}") positionally to gsd_run check'
    );
    assert.ok(
      hasPickArg,
      'inner query must still pass --pick phase_req_ids to extract phase requirement IDs'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-22-surfacing-docs.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-22-surfacing-docs (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: docs-parity (see #22)
// Verifies that issue #22 drift-guard surfacing changes are present:
//   - new-project workflow mentions plan_review.source_grounding
//   - CONFIGURATION.md documents both new config keys
//   - COMMANDS.md mentions gsd-tools intel api-surface

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const NEW_PROJECT_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'new-project.md');
const SETTINGS_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'settings.md');
const CONFIGURATION_PATH = path.join(ROOT, 'docs', 'CONFIGURATION.md');
const COMMANDS_PATH = path.join(ROOT, 'docs', 'COMMANDS.md');
const USER_GUIDE_PATH = path.join(ROOT, 'docs', 'USER-GUIDE.md');
const ARCHITECTURE_PATH = path.join(ROOT, 'docs', 'ARCHITECTURE.md');

describe('feat-22-surfacing-docs', () => {
  // ── A1: new-project workflow ─────────────────────────────────────────────

  test('new-project workflow mentions source_grounding', () => {
    const content = fs.readFileSync(NEW_PROJECT_PATH, 'utf-8');
    assert.ok(
      content.includes('source_grounding'),
      'new-project.md must mention source_grounding'
    );
  });

  test('new-project workflow has Drift Guard question', () => {
    const content = fs.readFileSync(NEW_PROJECT_PATH, 'utf-8');
    assert.ok(
      content.includes('Drift Guard'),
      'new-project.md must include a "Drift Guard" question header'
    );
  });

  test('new-project workflow wires source_grounding into config-new-project call', () => {
    const content = fs.readFileSync(NEW_PROJECT_PATH, 'utf-8');
    assert.ok(
      content.includes('"plan_review":{"source_grounding":'),
      'new-project.md config-new-project call must include plan_review.source_grounding'
    );
  });

  test('new-project workflow has Drift Guard default-yes option', () => {
    const content = fs.readFileSync(NEW_PROJECT_PATH, 'utf-8');
    // Both question blocks (auto and interactive) should have the yes option
    const count = (content.match(/Yes \(Recommended\).*catches hallucinated names/g) || []).length;
    assert.ok(
      count >= 1,
      'new-project.md must have at least one Drift Guard "Yes (Recommended)" option'
    );
  });

  // ── A2: settings workflow ────────────────────────────────────────────────

  test('settings workflow mentions source_grounding in read_current step', () => {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    assert.ok(
      content.includes('plan_review.source_grounding'),
      'settings.md must mention plan_review.source_grounding in the read_current step'
    );
  });

  test('settings workflow has Drift Guard AskUserQuestion toggle', () => {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    assert.ok(
      content.includes('Drift Guard'),
      'settings.md must include a "Drift Guard" question header'
    );
  });

  test('settings workflow update_config includes plan_review.source_grounding', () => {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    assert.ok(
      content.includes('"source_grounding": true/false'),
      'settings.md update_config block must include source_grounding: true/false'
    );
  });

  test('settings workflow mentions source_grounding_authority', () => {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    assert.ok(
      content.includes('source_grounding_authority'),
      'settings.md must mention source_grounding_authority'
    );
  });

  test('settings confirm table includes Plan Drift Guard row', () => {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    assert.ok(
      content.includes('Plan Drift Guard'),
      'settings.md confirm table must include a "Plan Drift Guard" row'
    );
  });

  // ── B1: CONFIGURATION.md ─────────────────────────────────────────────────

  test('CONFIGURATION.md documents plan_review.source_grounding', () => {
    const content = fs.readFileSync(CONFIGURATION_PATH, 'utf-8');
    assert.ok(
      content.includes('`plan_review.source_grounding`'),
      'CONFIGURATION.md must document plan_review.source_grounding'
    );
  });

  test('CONFIGURATION.md documents plan_review.source_grounding_authority', () => {
    const content = fs.readFileSync(CONFIGURATION_PATH, 'utf-8');
    assert.ok(
      content.includes('`plan_review.source_grounding_authority`'),
      'CONFIGURATION.md must document plan_review.source_grounding_authority'
    );
  });

  test('CONFIGURATION.md documents grep as default authority', () => {
    const content = fs.readFileSync(CONFIGURATION_PATH, 'utf-8');
    assert.ok(
      content.includes('`grep`') && content.includes('source_grounding_authority'),
      'CONFIGURATION.md must document grep as the default source_grounding_authority'
    );
  });

  test('CONFIGURATION.md lists all five authority enum values', () => {
    const content = fs.readFileSync(CONFIGURATION_PATH, 'utf-8');
    const authorities = ['grep', 'intel', 'treesitter', 'lsp', 'scip'];
    const missing = authorities.filter(a => !content.includes(a));
    assert.deepStrictEqual(
      missing,
      [],
      `CONFIGURATION.md must list all authority values; missing: ${missing.join(', ')}`
    );
  });

  // ── B2: COMMANDS.md ───────────────────────────────────────────────────────

  test('COMMANDS.md mentions intel api-surface', () => {
    const content = fs.readFileSync(COMMANDS_PATH, 'utf-8');
    assert.ok(
      content.includes('intel api-surface'),
      'COMMANDS.md must document the gsd-tools intel api-surface command'
    );
  });

  test('COMMANDS.md documents api-surface gating on intel.enabled', () => {
    const content = fs.readFileSync(COMMANDS_PATH, 'utf-8');
    assert.ok(
      content.includes('intel.enabled'),
      'COMMANDS.md intel api-surface section must mention the intel.enabled gate'
    );
  });

  test('COMMANDS.md mentions API-SURFACE.md output', () => {
    const content = fs.readFileSync(COMMANDS_PATH, 'utf-8');
    assert.ok(
      content.includes('API-SURFACE.md'),
      'COMMANDS.md must mention the API-SURFACE.md output file'
    );
  });

  // ── B3: USER-GUIDE.md ─────────────────────────────────────────────────────

  test('USER-GUIDE.md has Plan Drift Guard subsection', () => {
    const content = fs.readFileSync(USER_GUIDE_PATH, 'utf-8');
    assert.ok(
      content.includes('### Plan Drift Guard'),
      'USER-GUIDE.md must have a "### Plan Drift Guard" subsection'
    );
  });

  test('USER-GUIDE.md mentions needs-acknowledgement behavior', () => {
    const content = fs.readFileSync(USER_GUIDE_PATH, 'utf-8');
    assert.ok(
      content.includes('needs-acknowledgement'),
      'USER-GUIDE.md drift guard section must describe needs-acknowledgement behavior'
    );
  });

  test('USER-GUIDE.md explains drift guard works without intel', () => {
    const content = fs.readFileSync(USER_GUIDE_PATH, 'utf-8');
    assert.ok(
      content.includes('without intel') || content.includes('Works without intel'),
      'USER-GUIDE.md must explain that the drift guard works without intel'
    );
  });

  // ── B4: ARCHITECTURE.md ───────────────────────────────────────────────────

  test('ARCHITECTURE.md links to ADR 22', () => {
    const content = fs.readFileSync(ARCHITECTURE_PATH, 'utf-8');
    assert.ok(
      content.includes('adr/22-plan-drift-guard.md') || content.includes('ADR 22'),
      'ARCHITECTURE.md must link to ADR 22 (adr/22-plan-drift-guard.md)'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2430-learnings-consumption.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2430-learnings-consumption (consolidation epic #1969 B4 #1973)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #2430)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Tests for #2430 — LEARNINGS.md consumption loop.
 *
 * Part A: plan-phase.md cross-phase context load includes LEARNINGS.md
 * Part B: transition.md graduation_scan step + graduation.md helper
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '../gsd-core/workflows');

function readWorkflow(name) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf-8');
}

describe('enh-2430 Part A — plan-phase LEARNINGS.md context load', () => {
  let content;

  test('plan-phase.md includes LEARNINGS.md in cross-phase context load', () => {
    content = readWorkflow('plan-phase.md');
    assert.ok(
      content.includes('LEARNINGS.md files from the 3 most recent completed phases'),
      'plan-phase.md must mention LEARNINGS.md in cross-phase context block'
    );
  });

  test('plan-phase.md LEARNINGS load is inside the 1M context-window gate', () => {
    content = content || readWorkflow('plan-phase.md');
    const windowBlock = content.match(/\$\{CONTEXT_WINDOW >= 500000[\s\S]*?` : ''\}/);
    assert.ok(windowBlock, 'CONTEXT_WINDOW gate block must exist');
    assert.ok(
      windowBlock[0].includes('LEARNINGS.md'),
      'LEARNINGS.md load must be inside the CONTEXT_WINDOW >= 500000 gate'
    );
  });

  test('plan-phase.md source attribution mentioned for LEARNINGS load', () => {
    content = content || readWorkflow('plan-phase.md');
    assert.ok(
      content.includes('[from Phase N LEARNINGS]') || content.includes('source attribution'),
      'plan-phase.md must document source attribution for loaded LEARNINGS.md content'
    );
  });

  test('plan-phase.md handles missing LEARNINGS.md gracefully (silent skip)', () => {
    content = content || readWorkflow('plan-phase.md');
    assert.ok(
      content.includes('skip silently if a phase has no LEARNINGS.md') ||
      content.includes('skip silently'),
      'plan-phase.md must document silent skip when LEARNINGS.md is absent'
    );
  });

  test('plan-phase.md LEARNINGS load includes Depends-on chain', () => {
    content = content || readWorkflow('plan-phase.md');
    content.match(/Depends on.*?(\n.*?)+/);
    assert.ok(
      content.includes('LEARNINGS.md from any phases listed in'),
      'plan-phase.md must load LEARNINGS.md for Depends on chain phases'
    );
  });

  test('plan-phase.md specifies context budget limit for LEARNINGS', () => {
    content = content || readWorkflow('plan-phase.md');
    assert.ok(
      content.includes('15%') || content.includes('drop oldest'),
      'plan-phase.md must specify budget limit and truncation strategy for LEARNINGS'
    );
  });
});

describe('enh-2430 Part B — graduation_scan in transition.md', () => {
  let content;

  test('transition.md contains graduation_scan step', () => {
    content = readWorkflow('transition.md');
    assert.ok(
      content.includes('graduation_scan'),
      'transition.md must contain graduation_scan step'
    );
  });

  test('graduation_scan is placed after evolve_project step', () => {
    content = content || readWorkflow('transition.md');
    const evolvePos = content.indexOf('name="evolve_project"');
    const graduationPos = content.indexOf('name="graduation_scan"');
    assert.ok(evolvePos >= 0, 'evolve_project step must exist');
    assert.ok(graduationPos >= 0, 'graduation_scan step must exist');
    assert.ok(
      graduationPos > evolvePos,
      'graduation_scan must appear after evolve_project in transition.md'
    );
  });

  test('graduation_scan is non-blocking (transition continues regardless)', () => {
    content = content || readWorkflow('transition.md');
    const scanBlock = content.match(/name="graduation_scan"[\s\S]*?<\/step>/);
    assert.ok(scanBlock, 'graduation_scan step must be parseable');
    assert.ok(
      scanBlock[0].includes('non-blocking') || scanBlock[0].includes('always non-blocking'),
      'graduation_scan must be documented as non-blocking'
    );
  });

  test('graduation_scan delegates to graduation.md helper', () => {
    content = content || readWorkflow('transition.md');
    assert.ok(
      content.includes('graduation.md'),
      'graduation_scan must reference graduation.md helper workflow'
    );
  });
});

describe('enh-2430 Part B — graduation.md helper workflow', () => {
  let content;

  test('graduation.md exists', () => {
    content = readWorkflow('graduation.md');
    assert.ok(content.length > 0, 'graduation.md must exist and be non-empty');
  });

  test('graduation.md documents features.graduation config flag', () => {
    content = content || readWorkflow('graduation.md');
    assert.ok(
      content.includes('features.graduation'),
      'graduation.md must document features.graduation config flag'
    );
  });

  test('graduation.md documents graduation_window config', () => {
    content = content || readWorkflow('graduation.md');
    assert.ok(
      content.includes('graduation_window'),
      'graduation.md must document features.graduation_window config'
    );
  });

  test('graduation.md documents graduation_threshold config', () => {
    content = content || readWorkflow('graduation.md');
    assert.ok(
      content.includes('graduation_threshold'),
      'graduation.md must document features.graduation_threshold config'
    );
  });

  test('graduation.md specifies HITL: Promote / Defer / Dismiss', () => {
    content = content || readWorkflow('graduation.md');
    assert.ok(content.includes('Promote'), 'graduation.md must document Promote action');
    assert.ok(content.includes('Defer'), 'graduation.md must document Defer action');
    assert.ok(content.includes('Dismiss'), 'graduation.md must document Dismiss action');
  });

  test('graduation.md specifies category→target routing', () => {
    content = content || readWorkflow('graduation.md');
    assert.ok(
      content.includes('PROJECT.md') && content.includes('PATTERNS.md'),
      'graduation.md must route categories to appropriate target files'
    );
  });

  test('graduation.md specifies graduation_backlog in STATE.md', () => {
    content = content || readWorkflow('graduation.md');
    assert.ok(
      content.includes('graduation_backlog'),
      'graduation.md must document STATE.md graduation_backlog for Defer/Dismiss'
    );
  });

  test('graduation.md skips items with graduated: annotation', () => {
    content = content || readWorkflow('graduation.md');
    assert.ok(
      content.includes('graduated:') || content.includes('Graduated:'),
      'graduation.md must skip already-graduated items'
    );
  });

  test('graduation.md has silent no-op for first phase / insufficient data', () => {
    content = content || readWorkflow('graduation.md');
    assert.ok(
      content.includes('no-op') || content.includes('silent'),
      'graduation.md must silently no-op when there is insufficient data'
    );
  });

  test('graduation.md specifies Defer-all shorthand (A key)', () => {
    content = content || readWorkflow('graduation.md');
    assert.ok(
      content.includes('Defer all') || content.includes('[Defer all]'),
      'graduation.md must document the Defer all shorthand for first-run batches'
    );
  });
});

describe('enh-2430 — extract-learnings.md graduated: field', () => {
  test('extract-learnings.md documents optional graduated: annotation', () => {
    const content = readWorkflow('extract-learnings.md');
    assert.ok(
      content.includes('graduated:') || content.includes('Graduated:'),
      'extract-learnings.md must document optional graduated: field'
    );
  });

  test('extract-learnings.md clarifies graduated: is written only by graduation workflow', () => {
    const content = readWorkflow('extract-learnings.md');
    assert.ok(
      content.includes('graduation workflow') || content.includes('graduation.md'),
      'extract-learnings.md must clarify that graduated: is written only by graduation.md'
    );
  });
});

describe('enh-2430 — INVENTORY sync', () => {
  test('INVENTORY.md lists graduation.md', () => {
    const inventory = fs.readFileSync(
      path.join(__dirname, '../docs/INVENTORY.md'), 'utf-8'
    );
    assert.ok(inventory.includes('graduation.md'), 'INVENTORY.md must list graduation.md');
  });

  test('INVENTORY-MANIFEST.json includes graduation.md', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../docs/INVENTORY-MANIFEST.json'), 'utf-8')
    );
    assert.ok(
      manifest.families.workflows.includes('graduation.md'),
      'INVENTORY-MANIFEST.json must include graduation.md in workflows array'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2492-context-coverage-gate.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2492-context-coverage-gate (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #2492)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Bug #2492: Add gates to ensure discuss-phase decisions are translated to
 * plans (plan-phase, BLOCKING) and verified against shipped artifacts
 * (verify-phase, NON-BLOCKING).
 *
 * These workflow files are loaded as prompts by the corresponding subagents.
 * The tests below verify that the prompt text contains the gate steps and
 * the config-toggle skip clauses — losing them silently would regress the
 * fix.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAN_PHASE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
const VERIFY_PHASE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-phase.md');
const SCHEMA_MANIFEST_JSON = path.join(__dirname, '..', 'gsd-core', 'bin', 'shared', 'config-schema.manifest.json');

describe('plan-phase decision-coverage gate (#2492)', () => {
  const md = fs.readFileSync(PLAN_PHASE, 'utf-8');

  test('contains a Decision Coverage Gate step', () => {
    assert.ok(
      /Decision Coverage Gate/i.test(md),
      'plan-phase.md must define a Decision Coverage Gate step',
    );
  });

  test('invokes the check.decision-coverage-plan handler', () => {
    assert.ok(
      md.includes('check.decision-coverage-plan'),
      'plan-phase.md must call gsd-sdk query check.decision-coverage-plan',
    );
  });

  test('mentions workflow.context_coverage_gate skip clause', () => {
    assert.ok(
      md.includes('workflow.context_coverage_gate'),
      'plan-phase.md must reference workflow.context_coverage_gate to allow skipping',
    );
  });

  test('decision gate appears AFTER the existing Requirements Coverage Gate', () => {
    // Anchored heading regexes — avoid prose-substring traps (review F8/F9).
    const reqIdx = md.search(/^## 13[a-z]?\.\s+Requirements Coverage Gate/m);
    const decIdx = md.search(/^## 13[a-z]?\.\s+Decision Coverage Gate/m);
    assert.ok(reqIdx !== -1, 'Requirements Coverage Gate heading must exist as ## 13[a-z]?.');
    assert.ok(decIdx !== -1, 'Decision Coverage Gate heading must exist as ## 13[a-z]?.');
    assert.ok(decIdx > reqIdx, 'Decision gate must run after Requirements gate');
  });

  test('decision gate appears BEFORE plans are committed', () => {
    const decIdx = md.search(/^## 13[a-z]?\.\s+Decision Coverage Gate/m);
    const commitIdx = md.search(/^## 13[a-z]?\.\s+Commit Plans/m);
    assert.ok(decIdx !== -1, 'Decision Coverage Gate heading must exist as ## 13[a-z]?.');
    assert.ok(commitIdx !== -1, 'Commit Plans heading must exist as ## 13[a-z]?.');
    assert.ok(decIdx < commitIdx, 'Decision gate must run before commit so failures block the commit');
  });

  test('plan-phase Decision Coverage Gate recomputes CONTEXT_PATH in-block and guards the empty-glob case (#2770)', () => {
    // #2770: the CONTEXT_PATH set in the step-1 init Bash block does NOT survive into
    // the separately-spawned gate block, so the gate used to run with an empty arg and
    // silently green-skip. The gate must now (a) recompute CONTEXT_PATH locally from the
    // phase dir, and (b) guard the empty case so a genuinely CONTEXT.md-less phase still
    // skips (the handler now fails closed on an empty arg, so an unguarded empty path
    // would hard-halt the legitimate "Continue without context" flow).
    const gateIdx = md.indexOf('check.decision-coverage-plan');
    assert.ok(gateIdx !== -1, 'check.decision-coverage-plan invocation must exist');

    // The gate invocation is now nested inside the empty-glob guard, so slice a wide
    // window around it to capture both the recompute and the guard.
    const snippet = md.slice(Math.max(0, gateIdx - 600), gateIdx + 400);
    assert.ok(
      snippet.includes('CONTEXT_PATH=$(ls "${PHASE_DIR}"/*-CONTEXT.md'),
      'Gate must recompute CONTEXT_PATH in-block from the phase-dir glob (not rely on the init-block variable) (#2770)',
    );
    assert.ok(
      snippet.includes('if [ -n "$CONTEXT_PATH" ]'),
      'Gate must guard the empty-glob case so a CONTEXT.md-less phase still skips (handler now fails closed on empty arg) (#2770)',
    );
  });

  test('plan-phase blocking gate exits non-zero on failure (review F15)', () => {
    // The gate is documented as BLOCKING. To actually block, the shell snippet must
    // exit with non-zero status when `passed` is false. Without exit-1 the workflow
    // continues silently past the failure.
    const gateIdx = md.indexOf('check.decision-coverage-plan');
    assert.ok(gateIdx !== -1);
    const snippet = md.slice(gateIdx, gateIdx + 800);
    // Accept either an inline `|| exit 1` or a `|| { ...; exit 1; }` group.
    const hasJqGuard =
      /jq[^\r\n]*\.data\.passed\s*==\s*true/.test(snippet) ||
      /jq[^\r\n]*\(\.passed\s*\/\/\s*\.data\.passed\)\s*==\s*true/.test(snippet);
    const hasExitOne = /\|\|\s*(?:exit\s+1|\{[\s\S]{0,200}?exit\s+1)/.test(snippet);
    assert.ok(
      hasJqGuard && hasExitOne,
      'plan-phase gate must guard with `jq -e .passed == true || exit 1` (or `|| { ...; exit 1; }`) to actually block',
    );
  });

  test('plan-phase gate accepts top-level .passed field from CLI output (#275)', () => {
    const gateIdx = md.indexOf('check.decision-coverage-plan');
    assert.ok(gateIdx !== -1, 'check.decision-coverage-plan invocation must exist');
    const snippet = md.slice(gateIdx, gateIdx + 800);
    assert.ok(
      /\.(?:passed)\s*==\s*true\s*\|\|\s*\.data\.passed\s*==\s*true/.test(snippet) ||
      /\(\.passed\s*\/\/\s*\.data\.passed\)\s*==\s*true/.test(snippet),
      'plan-phase gate must explicitly check top-level .passed with a compatibility fallback to .data.passed',
    );
  });
});

describe('verify-phase decision-coverage gate (#2492)', () => {
  const md = fs.readFileSync(VERIFY_PHASE, 'utf-8');

  test('contains a verify_decisions step', () => {
    assert.ok(
      /verify_decisions/.test(md),
      'verify-phase.md must define a verify_decisions step',
    );
  });

  test('invokes the check.decision-coverage-verify handler', () => {
    assert.ok(
      md.includes('check.decision-coverage-verify'),
      'verify-phase.md must call gsd-sdk query check.decision-coverage-verify',
    );
  });

  test('declares the decision gate as non-blocking / warning only', () => {
    const lower = md.toLowerCase();
    assert.ok(
      lower.includes('non-blocking') || lower.includes('warning only') || lower.includes('not block'),
      'verify-phase.md must declare the decision gate is non-blocking',
    );
  });

  test('mentions workflow.context_coverage_gate skip clause', () => {
    assert.ok(
      md.includes('workflow.context_coverage_gate'),
      'verify-phase.md must reference workflow.context_coverage_gate to allow skipping',
    );
  });
});

describe('runtime wiring for #2492 gates', () => {
  test('schema manifest includes context_coverage_gate', () => {
    const manifest = JSON.parse(fs.readFileSync(SCHEMA_MANIFEST_JSON, 'utf-8'));
    assert.ok(
      manifest.validKeys.includes('workflow.context_coverage_gate'),
      'workflow.context_coverage_gate must be present in config-schema manifest',
    );
  });
});
  });
}

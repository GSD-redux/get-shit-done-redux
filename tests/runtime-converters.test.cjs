/**
 * Runtime Converter Tests — OpenCode + Kilo
 *
 * Tests for small runtime-specific conversion functions from install.js.
 * Larger runtime test suites (Copilot, Codex, Antigravity) have their own files.
 *
 * OpenCode/Kilo: flat-runtime frontmatter converters (agent + command modes)
 *   model: inherit is NOT added (runtime uses its configured default model)
 *   but mode: subagent IS added (required by both runtimes' agents).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.GSD_TEST_MODE = '1';
const {
  convertClaudeToOpencodeFrontmatter,
  convertClaudeToKiloFrontmatter,
  convertClaudeAgentToAntigravityAgent,
  convertClaudeCommandToOpencodeSkill,
  convertClaudeCommandToKiloSkill,
  convertClaudeCommandToTraeSkill,
  convertClaudeCommandToKimiSkill,
  buildKimiAgentArtifacts,
  neutralizeAgentReferences,
} = require('../bin/install.js');

// Sample Claude agent frontmatter (matches actual GSD agent format)
const SAMPLE_AGENT = `---
name: gsd-executor
description: Executes GSD plans with atomic commits
tools: Read, Write, Edit, Bash, Grep, Glob
color: yellow
skills:
  - gsd-executor-workflow
# hooks:
#   PostToolUse:
#     - matcher: "Write|Edit"
#       hooks:
#         - type: command
#           command: "npx eslint --fix $FILE 2>/dev/null || true"
---

<role>
You are a GSD plan executor.
</role>`;

// Sample Claude command frontmatter (for comparison — commands work differently)
const SAMPLE_COMMAND = `---
name: gsd-execute-phase
description: Execute all plans in a phase
allowed-tools:
  - Read
  - Write
  - Bash
---

Execute the phase plan.`;

const flatRuntimeSuites = [
  {
    label: 'OpenCode',
    convert: convertClaudeToOpencodeFrontmatter,
    configDir: '.config/opencode',
  },
  {
    label: 'Kilo',
    convert: convertClaudeToKiloFrontmatter,
    configDir: '.config/kilo',
  },
];

for (const { label, convert, configDir } of flatRuntimeSuites) {
  describe(`${label} agent conversion (isAgent: true)`, () => {
    test('keeps name: field for agents', () => {
      const result = convert(SAMPLE_AGENT, { isAgent: true });
      const frontmatter = result.split('---')[1];
      assert.ok(frontmatter.includes('name: gsd-executor'), 'name: should be preserved for agents');
    });

    test('does not add model: inherit', () => {
      const result = convert(SAMPLE_AGENT, { isAgent: true });
      const frontmatter = result.split('---')[1];
      assert.ok(!frontmatter.includes('model: inherit'), 'model: inherit should NOT be added');
    });

    test('adds mode: subagent', () => {
      const result = convert(SAMPLE_AGENT, { isAgent: true });
      const frontmatter = result.split('---')[1];
      assert.ok(frontmatter.includes('mode: subagent'), 'mode: subagent should be added');
    });

    test('strips tools: field', () => {
      const result = convert(SAMPLE_AGENT, { isAgent: true });
      const frontmatter = result.split('---')[1];
      assert.ok(!frontmatter.includes('tools:'), 'tools: should be stripped for agents');
      assert.ok(!frontmatter.includes('read: true'), 'tools object should not be generated');

      if (label === 'Kilo') {
        assert.ok(frontmatter.includes('permission:'), 'Kilo agents should emit permission block');
        assert.ok(frontmatter.includes('read: allow'), 'Read should map to read: allow');
        assert.ok(frontmatter.includes('edit: allow'), 'Write/Edit should map to edit: allow');
        assert.ok(frontmatter.includes('bash: allow'), 'Bash should map to bash: allow');
        assert.ok(frontmatter.includes('grep: allow'), 'Grep should map to grep: allow');
        assert.ok(frontmatter.includes('glob: allow'), 'Glob should map to glob: allow');
        assert.ok(frontmatter.includes('task: deny'), 'unspecified permissions should be denied');
      } else {
        assert.ok(!frontmatter.includes('permission:'), 'OpenCode agents should not emit permission block');
      }
    });

    test('strips skills: array', () => {
      const result = convert(SAMPLE_AGENT, { isAgent: true });
      const frontmatter = result.split('---')[1];
      assert.ok(!frontmatter.includes('skills:'), 'skills: should be stripped');
      assert.ok(!frontmatter.includes('gsd-executor-workflow'), 'skill entries should be stripped');
    });

    test('strips color: field', () => {
      const result = convert(SAMPLE_AGENT, { isAgent: true });
      const frontmatter = result.split('---')[1];
      assert.ok(!frontmatter.includes('color:'), 'color: should be stripped for agents');
    });

    test('strips commented hooks block', () => {
      const result = convert(SAMPLE_AGENT, { isAgent: true });
      const frontmatter = result.split('---')[1];
      assert.ok(!frontmatter.includes('# hooks:'), 'commented hooks should be stripped');
      assert.ok(!frontmatter.includes('PostToolUse'), 'hook content should be stripped');
    });

    test('keeps description: field', () => {
      const result = convert(SAMPLE_AGENT, { isAgent: true });
      const frontmatter = result.split('---')[1];
      assert.ok(frontmatter.includes('description: Executes GSD plans'), 'description should be kept');
    });

    test('preserves body content', () => {
      const result = convert(SAMPLE_AGENT, { isAgent: true });
      assert.ok(result.includes('<role>'), 'body should be preserved');
      assert.ok(result.includes('You are a GSD plan executor.'), 'body content should be intact');
    });

    test('applies body text replacements', () => {
      const agentWithClaudePaths = `---
name: test-agent
description: Test
tools: Read
---

Read ~/.claude/agent-memory/ for context.
Use $HOME/.claude/skills/ for reference.
Check .claude/skills/ and .claude/agents/ locally.
Use ./.claude/hooks/gsd-statusline.js during local testing.
Fallback skills live in .agents/skills/.`;

      const result = convert(agentWithClaudePaths, { isAgent: true });
      assert.ok(result.includes(`~/${configDir}/agent-memory/`), '~/.claude should be replaced');
      assert.ok(result.includes(`$HOME/${configDir}/skills/`), '$HOME/.claude should be replaced');

      if (label === 'Kilo') {
        assert.ok(result.includes('.kilo/skills/'), '.claude/skills should be replaced for Kilo');
        assert.ok(result.includes('.kilo/agents/'), '.claude/agents should be replaced for Kilo');
        assert.ok(result.includes('./.kilo/hooks/'), './.claude should be replaced for Kilo');
        assert.ok(result.includes('Fallback skills live in .kilo/skills/.'), '.agents/skills should be rewritten to Kilo skills dir');
        assert.ok(!result.includes('.kilo/skill/'), 'singular Kilo skill dir should not be emitted');
      }
    });
  });

  describe(`${label} command conversion (isAgent: false, default)`, () => {
    test('strips name: field for commands', () => {
      const result = convert(SAMPLE_COMMAND);
      const frontmatter = result.split('---')[1];
      assert.ok(!frontmatter.includes('name:'), 'name: should be stripped for commands');
    });

    test('does not add model: or mode: for commands', () => {
      const result = convert(SAMPLE_COMMAND);
      const frontmatter = result.split('---')[1];
      assert.ok(!frontmatter.includes('model:'), 'model: should not be added for commands');
      assert.ok(!frontmatter.includes('mode:'), 'mode: should not be added for commands');
    });

    test('keeps description: for commands', () => {
      const result = convert(SAMPLE_COMMAND);
      const frontmatter = result.split('---')[1];
      assert.ok(frontmatter.includes('description:'), 'description should be kept');
    });
  });

  // ─── #2256: model_overrides support for OpenCode/Kilo agents ────────────────
  // Only test OpenCode — Kilo uses the same converter but model override injection
  // is wired only for OpenCode at the call site in install().
  if (label === 'OpenCode') {
    describe('OpenCode agent model override (modelOverride option) (#2256)', () => {
      test('adds model: field when modelOverride is provided', () => {
        const result = convert(SAMPLE_AGENT, { isAgent: true, modelOverride: 'gpt-5.3-codex' });
        const frontmatter = result.split('---')[1];
        assert.ok(frontmatter.includes('model: gpt-5.3-codex'), 'model: field must be added with override value');
      });

      test('does not add model: field when modelOverride is null', () => {
        const result = convert(SAMPLE_AGENT, { isAgent: true, modelOverride: null });
        const frontmatter = result.split('---')[1];
        assert.ok(!frontmatter.includes('model:'), 'model: field must be absent when no override');
      });

      test('does not add model: field when modelOverride is omitted', () => {
        const result = convert(SAMPLE_AGENT, { isAgent: true });
        const frontmatter = result.split('---')[1];
        assert.ok(!frontmatter.includes('model:'), 'model: field must be absent when option omitted');
      });

      test('model: field appears after mode: subagent', () => {
        const result = convert(SAMPLE_AGENT, { isAgent: true, modelOverride: 'o4-mini' });
        const frontmatter = result.split('---')[1];
        const modeIdx = frontmatter.indexOf('mode: subagent');
        const modelIdx = frontmatter.indexOf('model: o4-mini');
        assert.ok(modeIdx !== -1, 'mode: subagent must be present');
        assert.ok(modelIdx !== -1, 'model: field must be present');
        assert.ok(modelIdx > modeIdx, 'model: must appear after mode: subagent');
      });

      test('model override does not affect command conversion', () => {
        // modelOverride has no effect when isAgent is false (commands)
        const result = convert(SAMPLE_COMMAND, { modelOverride: 'gpt-5.4' });
        const frontmatter = result.split('---')[1];
        assert.ok(!frontmatter.includes('model:'), 'model: must not appear in command output');
      });
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT.GENERATIVE-FIX output-parity guard: convertClaudeToKiloFrontmatter is
// defined TWICE — once in bin/install.js (the function bound at the top of this
// file, used by bin/install.js's own legacy install path) and once in
// src/runtime-artifact-conversion.cts, compiled to
// gsd-core/bin/lib/runtime-artifact-conversion.cjs (used by
// src/install-engine.cts's newer TS install path, see install-engine.cts ~L871).
// Both copies are LIVE — neither re-exports the other — so #2093's modelOverride
// edit had to be applied twice by hand. Source-text identity can't be asserted
// (they live in different module systems: plain CJS vs a tsc-compiled .cts
// output with different surrounding comments), so this instead proves the two
// implementations still produce IDENTICAL output for representative agent and
// command input. If a future edit changes one copy's behavior without mirroring
// it into the other, this test is the guard that catches the divergence.
// ─────────────────────────────────────────────────────────────────────────────
describe('convertClaudeToKiloFrontmatter output parity: bin/install.js vs runtime-artifact-conversion.cjs (#2093)', () => {
  const { convertClaudeToKiloFrontmatter: convertViaConversionModule } =
    require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

  test('identical output for an agent with a model override', () => {
    const viaInstall = convertClaudeToKiloFrontmatter(SAMPLE_AGENT, { isAgent: true, modelOverride: 'anthropic/claude-sonnet-5' });
    const viaModule = convertViaConversionModule(SAMPLE_AGENT, { isAgent: true, modelOverride: 'anthropic/claude-sonnet-5' });
    assert.equal(viaInstall, viaModule, 'bin/install.js and runtime-artifact-conversion.cjs must emit identical agent output');
  });

  test('identical output for an agent with no model override', () => {
    const viaInstall = convertClaudeToKiloFrontmatter(SAMPLE_AGENT, { isAgent: true, modelOverride: null });
    const viaModule = convertViaConversionModule(SAMPLE_AGENT, { isAgent: true, modelOverride: null });
    assert.equal(viaInstall, viaModule, 'bin/install.js and runtime-artifact-conversion.cjs must emit identical agent output with no override');
  });

  test('identical output for a command (model override never applies)', () => {
    const viaInstall = convertClaudeToKiloFrontmatter(SAMPLE_COMMAND, { isAgent: false, modelOverride: 'x' });
    const viaModule = convertViaConversionModule(SAMPLE_COMMAND, { isAgent: false, modelOverride: 'x' });
    assert.equal(viaInstall, viaModule, 'bin/install.js and runtime-artifact-conversion.cjs must emit identical command output');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT.GENERATIVE-FIX output-parity guard: convertClaudeCommandToTraeSkill is
// defined TWICE — once in bin/install.js (dead for the live skills-install
// path; kept for this file's own module-level export/test surface) and once in
// src/runtime-artifact-conversion.cts, compiled to
// gsd-core/bin/lib/runtime-artifact-conversion.cjs (used by
// src/install-engine.cts's skills-install path via SKILLS_CONVERTER_REGISTRY,
// see install-engine.cts ~L754). Both copies are LIVE call surfaces — neither
// re-exports the other — so #2094's `stage:` emission had to be applied to
// bin/install.js's copy by hand to keep parity. Source-text identity can't be
// asserted (they live in different module systems: plain CJS vs a
// tsc-compiled .cts output with different surrounding comments), so this
// instead proves the two implementations still produce IDENTICAL output for
// representative command input. If a future edit changes one copy's behavior
// without mirroring it into the other, this test is the guard that catches
// the divergence.
// ─────────────────────────────────────────────────────────────────────────────
describe('convertClaudeCommandToTraeSkill output parity: bin/install.js vs runtime-artifact-conversion.cjs (#2094)', () => {
  const { convertClaudeCommandToTraeSkill: convertViaConversionModule } =
    require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

  test('identical output for a representative command, including the #2094 stage: field', () => {
    const viaInstall = convertClaudeCommandToTraeSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    const viaModule = convertViaConversionModule(SAMPLE_COMMAND, 'gsd-execute-phase');
    assert.equal(viaInstall, viaModule, 'bin/install.js and runtime-artifact-conversion.cjs must emit identical command output');
    assert.match(viaInstall, /\nstage: workflow\n/, 'both copies must emit the #2094 stage: field');
  });

  test('identical output when the source has no description (falls back to generic description)', () => {
    const noDescriptionCommand = `---
name: gsd-noop
allowed-tools:
  - Read
---

Do nothing.`;
    const viaInstall = convertClaudeCommandToTraeSkill(noDescriptionCommand, 'gsd-noop');
    const viaModule = convertViaConversionModule(noDescriptionCommand, 'gsd-noop');
    assert.equal(viaInstall, viaModule, 'bin/install.js and runtime-artifact-conversion.cjs must emit identical output when description is absent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT.GENERATIVE-FIX output-parity guard: convertClaudeCommandToKimiSkill
// and buildKimiAgentArtifacts are each defined TWICE — once in bin/install.js
// (dead for the live install path; kept for this file's own module-level
// export/test surface) and once in src/runtime-artifact-conversion.cts,
// compiled to gsd-core/bin/lib/runtime-artifact-conversion.cjs (used by
// src/install-engine.cts's skills-install path via SKILLS_CONVERTER_REGISTRY
// for skills, and by src/runtime-artifact-layout.cts's kimiAgentsKind for
// agent YAML — see runtime-artifact-layout.cts ~L268/L289). Both copies are
// LIVE call surfaces — neither re-exports the other, so any future
// kimi-specific fix (e.g. the #2095 code-review fixes) must be applied to
// both by hand. Source-text identity can't be asserted (different module
// systems: plain CJS vs a tsc-compiled .cts output with different
// surrounding comments), so this instead proves the two implementations
// still produce IDENTICAL output for representative command and agent
// input. If a future edit changes one copy's behavior without mirroring it
// into the other, this test is the guard that catches the divergence.
// ─────────────────────────────────────────────────────────────────────────────
describe('convertClaudeCommandToKimiSkill / buildKimiAgentArtifacts output parity: bin/install.js vs runtime-artifact-conversion.cjs (#2095)', () => {
  const {
    convertClaudeCommandToKimiSkill: convertViaConversionModule,
    buildKimiAgentArtifacts: buildViaConversionModule,
  } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

  test('identical skill output for a representative command', () => {
    const viaInstall = convertClaudeCommandToKimiSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    const viaModule = convertViaConversionModule(SAMPLE_COMMAND, 'gsd-execute-phase');
    assert.equal(viaInstall, viaModule, 'bin/install.js and runtime-artifact-conversion.cjs must emit identical Kimi skill output');
  });

  test('identical skill output when the source has no description (falls back to generic description)', () => {
    const noDescriptionCommand = `---
name: gsd-noop
allowed-tools:
  - Read
---

Do nothing.`;
    const viaInstall = convertClaudeCommandToKimiSkill(noDescriptionCommand, 'gsd-noop');
    const viaModule = convertViaConversionModule(noDescriptionCommand, 'gsd-noop');
    assert.equal(viaInstall, viaModule, 'bin/install.js and runtime-artifact-conversion.cjs must emit identical output when description is absent');
  });

  test('identical agent-artifact output for a representative agent with a subagent, including the Agent tool grant', () => {
    const viaInstall = buildKimiAgentArtifacts({ rootAgent: SAMPLE_AGENT, subagents: [SAMPLE_AGENT] });
    const viaModule = buildViaConversionModule({ rootAgent: SAMPLE_AGENT, subagents: [SAMPLE_AGENT] });
    assert.deepEqual(viaInstall, viaModule, 'bin/install.js and runtime-artifact-conversion.cjs must emit an identical artifact bundle');
    assert.match(viaInstall.root.yaml, /kimi_cli\.tools\.agent:Agent/,
      'both copies must grant the Agent tool when a subagent is present (#2095 Upgrade 2)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Antigravity agent conversion — shared Gemini-backend tool mapping (#1394 / #1928)
// ─────────────────────────────────────────────────────────────────────────────
//
// The gemini-RUNTIME's own top-level converter (convertClaudeToGeminiAgent) and
// its dedicated test coverage were removed with the gemini runtime (#1928,
// Google sunset Gemini CLI 2026-06-18). convertGeminiToolName and
// claudeToGeminiTools STAY — they are shared infra reused by Antigravity (which
// runs on the same backend tool-name vocabulary), so the Antigravity-facing
// regression coverage below is retained unchanged.

describe('#1394 regression: excludes Skill/SlashCommand from Antigravity frontmatter', () => {
  // Skill/SlashCommand are Claude-only tools with no Gemini-backend built-in
  // equivalent. Without explicit exclusion they hit the lowercase fallback and
  // emit an invalid 'skill'/'slashcommand' tool name, which fails frontmatter
  // validation (tools.N: Invalid tool name) and aborts the entire agent load.

  // Antigravity reuses convertGeminiToolName (it runs on the Gemini backend),
  // so the exclusion intentionally applies there too. Antigravity surfaces GSD
  // skills through the skill surface (SKILL.md), not the agent tools: allowlist,
  // so dropping the invalid 'skill' tool name does not remove skill access —
  // this locks that cross-runtime behavior (criterion 4).
  test('Antigravity conversion also excludes Skill/SlashCommand (shared Gemini backend)', () => {
    const input = `---
name: gsd-planner
description: Creates executable phase plans.
tools: Read, Write, Bash, Skill, WebFetch, SlashCommand
---

<role>Plan the phase.</role>`;

    const result = convertClaudeAgentToAntigravityAgent(input);
    const toolsLine = result.split('\n').find(l => l.startsWith('tools:')) || '';

    assert.ok(toolsLine.includes('read_file'), 'maps Read -> read_file');
    assert.ok(toolsLine.includes('web_fetch'), 'maps WebFetch -> web_fetch');
    assert.ok(!/\bskill\b/.test(toolsLine), 'no invalid skill tool in Antigravity frontmatter');
    assert.ok(!/\bslashcommand\b/.test(toolsLine), 'no invalid slashcommand tool in Antigravity frontmatter');
  });
});

// ─── neutralizeAgentReferences (#766) ─────────────────────────────────────────

describe('neutralizeAgentReferences', () => {
  test('replaces standalone Claude with "the agent"', () => {
    const input = 'Claude handles these decisions. Claude should read the file.';
    const result = neutralizeAgentReferences(input, 'AGENTS.md');
    assert.ok(!result.includes('Claude handles'), 'standalone Claude replaced');
    assert.ok(result.includes('the agent handles'), 'replaced with "the agent"');
  });

  test('preserves Claude Code (product name)', () => {
    const input = 'This is a Claude Code bug. Use Claude Code settings.';
    const result = neutralizeAgentReferences(input, 'AGENTS.md');
    assert.ok(result.includes('Claude Code bug'), 'Claude Code preserved');
    assert.ok(result.includes('Claude Code settings'), 'Claude Code preserved');
  });

  test('preserves Claude model names', () => {
    const input = 'Use Claude Opus for planning. Claude Sonnet for execution. Claude Haiku for research.';
    const result = neutralizeAgentReferences(input, 'AGENTS.md');
    assert.ok(result.includes('Claude Opus'), 'Opus preserved');
    assert.ok(result.includes('Claude Sonnet'), 'Sonnet preserved');
    assert.ok(result.includes('Claude Haiku'), 'Haiku preserved');
  });

  test('replaces CLAUDE.md with runtime instruction file', () => {
    const input = 'Read CLAUDE.md for project instructions. Check ./CLAUDE.md if exists.';
    const result = neutralizeAgentReferences(input, 'AGENTS.md');
    assert.ok(result.includes('AGENTS.md'), 'CLAUDE.md -> AGENTS.md');
    assert.ok(!result.includes('CLAUDE.md'), 'no CLAUDE.md remains');
  });

  test('uses different instruction file per runtime', () => {
    const input = 'Read CLAUDE.md for instructions.';
    assert.ok(neutralizeAgentReferences(input, 'GEMINI.md').includes('GEMINI.md'));
    assert.ok(neutralizeAgentReferences(input, 'copilot-instructions.md').includes('copilot-instructions.md'));
    assert.ok(neutralizeAgentReferences(input, 'AGENTS.md').includes('AGENTS.md'));
  });

  test('removes AGENTS.md load-blocking instruction', () => {
    const input = 'Do NOT load full `AGENTS.md` files — they contain agent definitions.';
    const result = neutralizeAgentReferences(input, 'AGENTS.md');
    assert.ok(!result.includes('Do NOT load full'), 'blocking instruction removed');
  });

  test('preserves claude- prefixes (CSS classes, package names)', () => {
    const input = 'The claude-ctx session and claude-code package.';
    const result = neutralizeAgentReferences(input, 'AGENTS.md');
    assert.ok(result.includes('claude-ctx'), 'claude- prefix preserved');
    assert.ok(result.includes('claude-code'), 'claude-code preserved');
  });
});

// ─── OpenCode-family skill converters (SKILL.md) — #784 ──────────────────────

const SKILL_SAMPLE_COMMAND = `---
description: Show available GSD commands and usage guide
argument-hint: "[topic]"
allowed-tools:
  - Read
  - Bash
---

Run \`/gsd:help\` to see the guide. AskUserQuestion when unsure.
`;

const SKILL_BETA_COMMAND = `---
description: "[BETA] Offload plan phase to the cloud and import back."
---

Body for /gsd:ultraplan-phase.
`;

describe('convertClaudeCommandToOpencodeSkill / convertClaudeCommandToKiloSkill (#784)', () => {
  const cases = [
    { label: 'opencode', convert: convertClaudeCommandToOpencodeSkill },
    { label: 'kilo', convert: convertClaudeCommandToKiloSkill },
  ];

  for (const { label, convert } of cases) {
    describe(`${label} skill conversion`, () => {
      test('emits SKILL.md frontmatter with name matching the skill dir', () => {
        const out = convert(SKILL_SAMPLE_COMMAND, 'gsd-help');
        assert.ok(out.startsWith('---\n'), 'opens with frontmatter');
        assert.match(out, /^name: gsd-help$/m, 'name equals the skill name');
      });

      test('preserves the description from the source command', () => {
        const out = convert(SKILL_SAMPLE_COMMAND, 'gsd-help');
        assert.match(out, /^description: "Show available GSD commands and usage guide"$/m);
      });

      test('drops the command tools/permission block (skills inherit perms)', () => {
        const out = convert(SKILL_SAMPLE_COMMAND, 'gsd-help');
        const fmEnd = out.indexOf('\n---', 4);
        const fm = out.slice(0, fmEnd);
        assert.ok(!/tools:/.test(fm), 'no tools block in skill frontmatter');
        assert.ok(!/permission:/.test(fm), 'no permission block in skill frontmatter');
      });

      test('rewrites /gsd: colon refs to hyphen form in the body', () => {
        const out = convert(SKILL_SAMPLE_COMMAND, 'gsd-help');
        assert.ok(!/\/gsd:/.test(out), 'no /gsd: colon refs remain');
        assert.match(out, /\/gsd-help/, 'colon ref rewritten to hyphen form');
      });

      test('quotes descriptions with leading YAML flow indicators ([BETA])', () => {
        const out = convert(SKILL_BETA_COMMAND, 'gsd-ultraplan-phase');
        assert.match(out, /^description: "\[BETA\] /m, 'leading [BETA] safely quoted');
      });

      test('falls back to a synthetic description when none present', () => {
        const out = convert('Body only, no frontmatter.', 'gsd-mystery');
        assert.match(out, /^name: gsd-mystery$/m);
        assert.match(out, /^description: "Run GSD workflow gsd-mystery\."$/m);
      });
    });
  }
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-1173-agent-converters-descriptor.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-1173-agent-converters-descriptor (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * feat-1173: Descriptor-driven agent converter wiring.
 *
 * Verifies that the descriptor-driven install path (dispatchKindEntry) applies
 * per-runtime agent conversion when the 'agents' kind entry has a non-null
 * converter — instead of silently raw-copying.
 *
 * Behavioral assertions: invoke the staging/dispatch seam, inspect the staged
 * output files. NOT source-grep.
 *
 * TDD flow (REGRESSION-MUST-FAIL-FIRST rule):
 *   Before the fix, dispatchKindEntry ignores the converter for agents kind and
 *   raw-copies. The tests below prove conversion is applied by asserting that
 *   the staged .md contains runtime-specific frontmatter transformations absent
 *   in the raw source.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');

const {
  resolveRuntimeArtifactLayoutFromRegistry,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-artifact-layout.cjs'));

const {
  cleanupStagedSkills,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'install-profiles.cjs'));

const { cleanup } = require('./helpers.cjs');

// ─── fixtures ────────────────────────────────────────────────────────────────

/**
 * Minimal Claude agent source with comma-separated tools (Claude format).
 * Copilot conversion turns tools into a JSON array (CONV-04/05).
 * Codex conversion adds <codex_agent_role> block.
 * Cursor/Windsurf/Augment/Trae/Codebuddy/Cline conversion strips color field.
 */
const CLAUDE_AGENT_SOURCE = `---
name: gsd-planner
description: A GSD planning agent.
tools: Bash, Read, Write
color: blue
---

# GSD Planner

This agent plans GSD phases using ~/.claude/skills.
`;

/**
 * Create a temp agents directory with a .gsd-source marker pointing back to it
 * (so findAgentsSourceRoot finds the fixture dir, not the real agents/ dir).
 * The .gsd-source convention expects the marker to point at a commands/gsd dir;
 * agents/ is resolved as a sibling of commands/. So we set up:
 *   <tmproot>/
 *     commands/gsd/       (empty, satisfies the sibling check)
 *     agents/
 *       gsd-planner.md
 *     .gsd-source         <- points to <tmproot>/commands/gsd
 */
function makeFixtureRoot(agentFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1173-root-'));
  const commandsDir = path.join(root, 'commands', 'gsd');
  const agentsDir = path.join(root, 'agents');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  // .gsd-source marker must point to commands/gsd so that agentsSourceRoot resolves to agents/
  fs.writeFileSync(path.join(root, '.gsd-source'), commandsDir + '\n', 'utf8');
  for (const { name, content } of agentFiles) {
    fs.writeFileSync(path.join(agentsDir, name), content, 'utf8');
  }
  return root;
}

function makeSyntheticRegistry(converterName) {
  return {
    runtimes: {
      testruntime: {
        runtime: {
          artifactLayout: {
            global: [
              {
                kind: 'agents',
                destSubpath: 'agents',
                prefix: 'gsd-',
                nesting: 'flat',
                recursive: false,
                converter: converterName,
              },
            ],
            local: [],
          },
        },
      },
    },
  };
}

// ─── stageAgentsForRuntimeWithConverter unit tests ────────────────────────────

describe('feat-1173: stageAgentsForRuntimeWithConverter', () => {
  test('is exported from install-profiles', () => {
    const installProfiles = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'install-profiles.cjs'));
    assert.strictEqual(
      typeof installProfiles.stageAgentsForRuntimeWithConverter,
      'function',
      'stageAgentsForRuntimeWithConverter must be exported',
    );
  });

  test('applies converter to each staged agent file', (t) => {
    const { stageAgentsForRuntimeWithConverter } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'install-profiles.cjs'));

    const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1173-agents-'));
    fs.writeFileSync(path.join(agentsDir, 'gsd-planner.md'), CLAUDE_AGENT_SOURCE, 'utf8');
    fs.writeFileSync(path.join(agentsDir, 'gsd-executor.md'), CLAUDE_AGENT_SOURCE.replace('gsd-planner', 'gsd-executor'), 'utf8');

    t.after(() => {
      cleanup(agentsDir);
      cleanupStagedSkills();
    });

    const calls = [];
    const converter = (content) => {
      calls.push(content);
      return content.replace('~/.claude/', '~/.copilot/');
    };

    const resolvedProfile = { name: 'full', skills: '*', agents: new Set() };
    const stagedDir = stageAgentsForRuntimeWithConverter(agentsDir, resolvedProfile, converter);

    assert.strictEqual(calls.length, 2, 'converter called for each agent file');
    const stagedFiles = fs.readdirSync(stagedDir).sort();
    assert.deepStrictEqual(stagedFiles, ['gsd-executor.md', 'gsd-planner.md']);

    // Converter replaced ~/.claude/ with ~/.copilot/ in all staged files
    for (const file of stagedFiles) {
      const content = fs.readFileSync(path.join(stagedDir, file), 'utf8');
      assert.ok(!content.includes('~/.claude/'), `${file}: converter must have replaced ~/.claude/`);
      assert.ok(content.includes('~/.copilot/'), `${file}: converter must have injected ~/.copilot/`);
    }
  });

  test('non-existent srcAgentsDir returns srcAgentsDir unchanged', () => {
    const { stageAgentsForRuntimeWithConverter } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'install-profiles.cjs'));
    const ghost = path.join(os.tmpdir(), 'gsd-1173-no-exist-' + Date.now());
    const converter = (c) => c;
    const result = stageAgentsForRuntimeWithConverter(ghost, { name: 'full', skills: '*', agents: new Set() }, converter);
    assert.strictEqual(result, ghost, 'must return srcAgentsDir unchanged for non-existent dir');
  });

  test('only copies .md files (ignores non-.md)', (t) => {
    const { stageAgentsForRuntimeWithConverter } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'install-profiles.cjs'));
    const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1173-agents-'));
    fs.writeFileSync(path.join(agentsDir, 'gsd-planner.md'), CLAUDE_AGENT_SOURCE, 'utf8');
    fs.writeFileSync(path.join(agentsDir, 'README.txt'), 'not an agent', 'utf8');

    t.after(() => {
      cleanup(agentsDir);
      cleanupStagedSkills();
    });

    const converter = (c) => c;
    const resolvedProfile = { name: 'full', skills: '*', agents: new Set() };
    const stagedDir = stageAgentsForRuntimeWithConverter(agentsDir, resolvedProfile, converter);
    const stagedFiles = fs.readdirSync(stagedDir);
    assert.deepStrictEqual(stagedFiles, ['gsd-planner.md'], 'only .md files should be staged');
  });
});

// ─── dispatchKindEntry wiring tests ──────────────────────────────────────────

describe('feat-1173: dispatchKindEntry agents converter wiring', () => {
  test('agents kind with convertClaudeAgentToCopilotAgent converter applies copilot conversion', (t) => {
    const fixtureRoot = makeFixtureRoot([{ name: 'gsd-planner.md', content: CLAUDE_AGENT_SOURCE }]);
    t.after(() => {
      cleanup(fixtureRoot);
      cleanupStagedSkills();
    });

    const registry = makeSyntheticRegistry('convertClaudeAgentToCopilotAgent');
    const layout = resolveRuntimeArtifactLayoutFromRegistry(
      registry, 'testruntime', fixtureRoot, 'global',
    );

    assert.strictEqual(layout.kinds.length, 1);
    const agentKind = layout.kinds[0];
    assert.strictEqual(agentKind.kind, 'agents');

    const resolvedProfile = { name: 'full', skills: '*', agents: new Set() };
    const stagedDir = agentKind.stage(resolvedProfile);

    const stagedFile = path.join(stagedDir, 'gsd-planner.md');
    assert.ok(fs.existsSync(stagedFile), `staged file must exist: ${stagedFile}`);

    const stagedContent = fs.readFileSync(stagedFile, 'utf8');

    // Copilot CONV-04/05: tools converted from "Bash, Read, Write" to JSON array "['bash', 'read', 'write']"
    // Raw copy would keep the original comma-separated "tools: Bash, Read, Write" line.
    assert.notStrictEqual(stagedContent, CLAUDE_AGENT_SOURCE, 'converter must have transformed the content');
    assert.ok(
      stagedContent.includes("tools: ['") || stagedContent.includes('tools: ['),
      `Copilot conversion must produce JSON array tools. Got:\n${stagedContent.slice(0, 300)}`,
    );
  });

  test('agents kind with convertClaudeAgentToCodexAgent converter applies codex conversion', (t) => {
    const fixtureRoot = makeFixtureRoot([{ name: 'gsd-planner.md', content: CLAUDE_AGENT_SOURCE }]);
    t.after(() => {
      cleanup(fixtureRoot);
      cleanupStagedSkills();
    });

    const registry = makeSyntheticRegistry('convertClaudeAgentToCodexAgent');
    const layout = resolveRuntimeArtifactLayoutFromRegistry(
      registry, 'testruntime', fixtureRoot, 'global',
    );

    const agentKind = layout.kinds[0];
    const resolvedProfile = { name: 'full', skills: '*', agents: new Set() };
    const stagedDir = agentKind.stage(resolvedProfile);

    const stagedContent = fs.readFileSync(path.join(stagedDir, 'gsd-planner.md'), 'utf8');

    // Codex conversion adds <codex_agent_role> block
    assert.notStrictEqual(stagedContent, CLAUDE_AGENT_SOURCE, 'converter must have transformed the content');
    assert.ok(
      stagedContent.includes('<codex_agent_role>'),
      `Codex conversion must add <codex_agent_role>. Got:\n${stagedContent.slice(0, 300)}`,
    );
  });

  test('agents kind with convertClaudeAgentToCursorAgent converter applies cursor conversion', (t) => {
    const fixtureRoot = makeFixtureRoot([{ name: 'gsd-planner.md', content: CLAUDE_AGENT_SOURCE }]);
    t.after(() => {
      cleanup(fixtureRoot);
      cleanupStagedSkills();
    });

    const registry = makeSyntheticRegistry('convertClaudeAgentToCursorAgent');
    const layout = resolveRuntimeArtifactLayoutFromRegistry(
      registry, 'testruntime', fixtureRoot, 'global',
    );

    const agentKind = layout.kinds[0];
    const resolvedProfile = { name: 'full', skills: '*', agents: new Set() };
    const stagedDir = agentKind.stage(resolvedProfile);

    const stagedContent = fs.readFileSync(path.join(stagedDir, 'gsd-planner.md'), 'utf8');

    // Cursor conversion strips color field and rewrites ~/.claude/ paths
    assert.notStrictEqual(stagedContent, CLAUDE_AGENT_SOURCE, 'converter must have transformed the content');
    assert.ok(
      !stagedContent.includes('color:'),
      `Cursor agent conversion should strip the color field. Got:\n${stagedContent.slice(0, 300)}`,
    );
  });

  test('agents kind with converter=null still raw-copies (backward compat for claude)', (t) => {
    const fixtureRoot = makeFixtureRoot([{ name: 'gsd-planner.md', content: CLAUDE_AGENT_SOURCE }]);
    t.after(() => {
      cleanup(fixtureRoot);
      cleanupStagedSkills();
    });

    const registry = makeSyntheticRegistry(null);
    const layout = resolveRuntimeArtifactLayoutFromRegistry(
      registry, 'testruntime', fixtureRoot, 'global',
    );

    const agentKind = layout.kinds[0];
    const resolvedProfile = { name: 'full', skills: '*', agents: new Set() };
    const stagedDir = agentKind.stage(resolvedProfile);

    // converter=null: stageAgentsForProfile with skills='*' returns srcAgentsDir unchanged
    // (no staging dir is created; the source dir IS the staged dir, a passthrough)
    const stagedContent = fs.readFileSync(path.join(stagedDir, 'gsd-planner.md'), 'utf8');
    assert.strictEqual(stagedContent, CLAUDE_AGENT_SOURCE, 'converter=null must raw-copy the agent content');
  });

  test('scope threads isGlobal to a scope-aware converter (global vs local differ)', (t) => {
    // The plumbing kept by #1173 (option a): convertedAgentsKind / dispatchKindEntry
    // pass the install scope to the converter as isGlobal. A scope-aware converter
    // (copilot) must therefore produce different output for global vs local. This
    // proves the thread is live via a synthetic descriptor — no real runtime
    // declares a converted agents kind yet (declarations deferred to the ADR-1235
    // §0 parity follow-up).
    const fixtureRoot = makeFixtureRoot([{ name: 'gsd-planner.md', content: CLAUDE_AGENT_SOURCE }]);
    t.after(() => {
      cleanup(fixtureRoot);
      cleanupStagedSkills();
    });

    const agentsEntry = {
      kind: 'agents',
      destSubpath: 'agents',
      prefix: 'gsd-',
      nesting: 'flat',
      recursive: false,
      converter: 'convertClaudeAgentToCopilotAgent',
    };
    const registry = {
      runtimes: { testruntime: { runtime: { artifactLayout: { global: [agentsEntry], local: [agentsEntry] } } } },
    };

    const profile = { name: 'full', skills: '*', agents: new Set() };
    const stageFor = (scope) => {
      const layout = resolveRuntimeArtifactLayoutFromRegistry(registry, 'testruntime', fixtureRoot, scope);
      const agentKind = layout.kinds.find((k) => k.kind === 'agents');
      assert.ok(agentKind, `${scope} layout must include an agents kind`);
      return fs.readFileSync(path.join(agentKind.stage(profile), 'gsd-planner.md'), 'utf8');
    };

    const globalOut = stageFor('global');
    const localOut = stageFor('local');
    assert.notStrictEqual(
      globalOut,
      localOut,
      'scope-aware converter output must differ by scope — proves isGlobal is threaded from the descriptor scope',
    );
  });
});

// ─── real registry: claude agents kind has converter=null ────────────────────

describe('feat-1173: real registry claude agents kind has converter=null (backward compat)', () => {
  test('claude local artifacts layout has agents entry with converter=null', () => {
    const registry = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs'));
    const claudeDesc = registry.runtimes?.claude?.runtime?.artifactLayout?.local ?? [];
    const agentsEntry = claudeDesc.find((e) => e.kind === 'agents');
    assert.ok(agentsEntry, 'claude local artifactLayout must have an agents entry');
    assert.strictEqual(agentsEntry.converter, null, 'claude agents entry must have converter=null');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1515-codex-runtime-default.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1515-codex-runtime-default (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * Regression tests for bug #1515: Codex install with runtime-neutral
 * .planning/config.json resolves runtime as 'claude' and enables worktree
 * isolation (unsafe for Codex).
 *
 * Root causes:
 *   A) config-get reads in workflows lacked --raw → output JSON-quoted →
 *      every comparison like [ "$RUNTIME" = "codex" ] failed silently.
 *   B) The conversion engine emitted --default claude for every runtime →
 *      neutral Codex config fell back to claude default.
 *
 * All tests assert on the SUT's RETURN VALUE (engine output), not raw file reads,
 * except the integration test (test 4) which is explicitly the source↔engine
 * parity guard and carries the allow-test-rule exemption.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

// ---------------------------------------------------------------------------
// Unit tests: engine stamps codex-specific defaults into emitted workflows
// ---------------------------------------------------------------------------

test('codex emit stamps its own runtime default into the runtime-resolution line', () => {
  const line =
    'RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")\n';
  const out = conversion._applyRuntimeRewrites(line, 'codex', '$HOME/.codex/', true, undefined);
  assert.ok(
    out.includes('config-get runtime --default codex --raw'),
    `Expected 'config-get runtime --default codex --raw' in output; got:\n${out}`,
  );
  assert.ok(
    out.includes('|| echo "codex")'),
    `Expected '|| echo "codex")' in output; got:\n${out}`,
  );
  assert.ok(
    !out.includes('--default claude'),
    `Expected '--default claude' to be fully rewritten; got:\n${out}`,
  );
  assert.ok(
    !out.includes('echo "claude"'),
    `Expected 'echo "claude"' to be fully rewritten; got:\n${out}`,
  );
});

test('codex emit defaults workflow.use_worktrees to false', () => {
  const line =
    'USE_WORKTREES=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null || echo "true")\n';
  const out = conversion._applyRuntimeRewrites(line, 'codex', '$HOME/.codex/', true, undefined);
  assert.ok(
    out.includes('config-get workflow.use_worktrees --default false --raw'),
    `Expected 'config-get workflow.use_worktrees --default false --raw' in output; got:\n${out}`,
  );
  assert.ok(
    out.includes('|| echo "false")'),
    `Expected '|| echo "false")' in output; got:\n${out}`,
  );
  assert.ok(
    !out.includes('|| echo "true")'),
    `Expected '|| echo "true")' to be fully rewritten; got:\n${out}`,
  );
});

test('claude runtime does NOT rewrite the runtime default — stamping is non-claude-scoped (#1521 inversion)', () => {
  // #1521 generalizes stamping to ALL non-Claude runtimes. The negative case
  // (no stamping) is now the 'claude' runtime, not other non-Claude runtimes.
  const line =
    'RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")\n';
  const out = conversion._applyRuntimeRewrites(line, 'claude', '$HOME/.claude/', true, undefined);
  assert.ok(
    out.includes('--default claude --raw'),
    `Expected claude output to preserve '--default claude --raw'; got:\n${out}`,
  );
  assert.ok(
    !out.includes('--default codex'),
    `Expected claude output NOT to contain '--default codex'; got:\n${out}`,
  );
});

// ---------------------------------------------------------------------------
// Integration / parity guard: real source ↔ engine output for codex (all surfaces)
// ---------------------------------------------------------------------------

test('regression: every edited workflow gets codex-stamped (source↔engine parity, all surfaces) (#1515)', () => {
  // allow-test-rule: emitted workflow runtime-resolution shell block is the runtime contract surface (#1515) — asserts on engine-transformed output of the real source
  const WORKFLOWS = ['execute-phase.md', 'autonomous.md', 'manager.md', 'diagnose-issues.md', 'quick.md'];
  const CLAUDE_RUNTIME = 'config-get runtime --default claude --raw 2>/dev/null || echo "claude"';
  const CODEX_RUNTIME = 'config-get runtime --default codex --raw 2>/dev/null || echo "codex"';
  const TRUE_WT = 'config-get workflow.use_worktrees --raw 2>/dev/null || echo "true"';
  const FALSE_WT = 'config-get workflow.use_worktrees --default false --raw 2>/dev/null || echo "false"';
  for (const wf of WORKFLOWS) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', wf), 'utf8');
    const out = conversion._applyRuntimeRewrites(src, 'codex', '$HOME/.codex/', true, undefined);
    // No un-stamped claude/true resolution line may survive codex emit on ANY surface.
    assert.ok(!out.includes(CLAUDE_RUNTIME), `${wf}: residual un-stamped runtime read — engine regex no longer matches source line (parity drift)`);
    assert.ok(!out.includes(TRUE_WT), `${wf}: residual un-stamped use_worktrees read — parity drift`);
    // If the source HAS such a read, the codex form must be present.
    if (src.includes(CLAUDE_RUNTIME)) assert.ok(out.includes(CODEX_RUNTIME), `${wf}: runtime read not stamped to codex`);
    if (src.includes(TRUE_WT)) assert.ok(out.includes(FALSE_WT), `${wf}: use_worktrees read not defaulted to false`);
  }
});

// ---------------------------------------------------------------------------
// Property tests (RULESET.TESTS.property-based-testing)
// ---------------------------------------------------------------------------

test('property: runtime stamping applies for ALL non-claude runtimes; only claude leaves --default claude unchanged (#1521)', () => {
  // #1521: generalised from codex-only to all non-claude runtimes.
  // Use the canonical list from the conversion module to avoid hand-rolled array drift.
  const { NON_CLAUDE_RUNTIMES } = conversion;
  const RUNTIMES = ['claude', ...NON_CLAUDE_RUNTIMES];
  const line = 'RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")\n';
  fc.assert(fc.property(fc.constantFrom(...RUNTIMES), (rt) => {
    const out = conversion._applyRuntimeRewrites(line, rt, `$HOME/.${rt}/`, true, undefined);
    return rt === 'claude'
      ? out.includes('--default claude --raw') && !out.includes('--default codex')
      : out.includes(`--default ${rt} --raw`) && !out.includes('--default claude');
  }));
});

test('property: codex stamping is idempotent on resolution lines (#1515)', () => {
  fc.assert(fc.property(fc.constantFrom('runtime', 'use_worktrees'), (which) => {
    const line = which === 'runtime'
      ? 'RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")\n'
      : 'USE_WORKTREES=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null || echo "true")\n';
    const once = conversion._applyRuntimeRewrites(line, 'codex', '$HOME/.codex/', true, undefined);
    const twice = conversion._applyRuntimeRewrites(once, 'codex', '$HOME/.codex/', true, undefined);
    return once === twice;
  }));
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1521-non-claude-runtime-default-resolution.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1521-non-claude-runtime-default-resolution (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * Regression tests for #1521: every non-Claude runtime stamps its own runtime
 * identity + workflow.use_worktrees=false into emitted workflows.
 *
 * GSD's worktree isolation relies on Claude Code's isolation="worktree" spawn
 * parameter, which no other runtime honors. #1519 (Codex-only fix) is
 * generalized here to ALL non-Claude runtimes.
 *
 * All tests assert on the SUT's RETURN VALUE (engine output), not raw file reads,
 * except the parity integration test which carries the allow-test-rule exemption.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

// #1521: use the canonical list from the conversion module rather than a hand-rolled
// local array that can drift from the real runtime set.
const { NON_CLAUDE_RUNTIMES: NON_CLAUDE } = conversion;
const WORKFLOWS = [
  'execute-phase.md', 'autonomous.md', 'manager.md', 'diagnose-issues.md', 'quick.md',
];

const CLAUDE_RUNTIME_LINE = 'config-get runtime --default claude --raw 2>/dev/null || echo "claude"';
const TRUE_WT_LINE = 'config-get workflow.use_worktrees --raw 2>/dev/null || echo "true"';
const FALSE_WT_LINE = 'config-get workflow.use_worktrees --default false --raw 2>/dev/null || echo "false"';

// ---------------------------------------------------------------------------
// Parity across ALL non-Claude runtimes × all 5 workflows
// ---------------------------------------------------------------------------

test('parity: every non-Claude runtime stamps its own runtime default and use_worktrees=false on all workflows (#1521)', () => {
  // allow-test-rule: emitted workflow runtime-resolution shell block is the runtime contract surface (#1521)
  for (const rt of NON_CLAUDE) {
    for (const wf of WORKFLOWS) {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'gsd-core', 'workflows', wf),
        'utf8',
      );
      const out = conversion._applyRuntimeRewrites(src, rt, `$HOME/.${rt}/`, true, undefined);

      // No un-stamped claude runtime line may survive
      assert.ok(
        !out.includes(CLAUDE_RUNTIME_LINE),
        `${rt}/${wf}: residual un-stamped claude runtime read — _stampNonClaudeRuntimeDefaults not applied`,
      );

      // No un-stamped use_worktrees=true line may survive
      assert.ok(
        !out.includes(TRUE_WT_LINE),
        `${rt}/${wf}: residual un-stamped use_worktrees=true read — _stampNonClaudeRuntimeDefaults not applied`,
      );

      // If the source had a runtime read, the output must have --default <rt>
      if (src.includes(CLAUDE_RUNTIME_LINE)) {
        assert.ok(
          out.includes(`config-get runtime --default ${rt} --raw 2>/dev/null || echo "${rt}"`),
          `${rt}/${wf}: runtime line not stamped to --default ${rt}`,
        );
      }

      // If the source had a use_worktrees read, the output must have --default false
      if (src.includes(TRUE_WT_LINE)) {
        assert.ok(
          out.includes(FALSE_WT_LINE),
          `${rt}/${wf}: use_worktrees line not defaulted to false`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Claude unchanged — no stamping for the native runtime
// ---------------------------------------------------------------------------

test('claude runtime leaves runtime default and use_worktrees=true unchanged (#1521)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'),
    'utf8',
  );
  const out = conversion._applyRuntimeRewrites(src, 'claude', '$HOME/.claude/', true, undefined);

  // Claude emit must preserve the original --default claude line
  if (src.includes(CLAUDE_RUNTIME_LINE)) {
    assert.ok(
      out.includes(CLAUDE_RUNTIME_LINE),
      `claude/execute-phase.md: expected original claude runtime line to survive; got mutated`,
    );
  }

  // Claude emit must NOT gain --default false for use_worktrees
  assert.ok(
    !out.includes(FALSE_WT_LINE),
    `claude/execute-phase.md: use_worktrees line must NOT be stamped false for claude runtime`,
  );
});

// ---------------------------------------------------------------------------
// fc property — identity: each runtime stamps itself, claude stays unchanged
// ---------------------------------------------------------------------------

test('property: _stampNonClaudeRuntimeDefaults stamps each non-claude runtime and leaves claude unchanged (#1521)', () => {
  const line =
    'RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")\n';
  fc.assert(
    fc.property(fc.constantFrom(...NON_CLAUDE, 'claude'), (rt) => {
      const out = conversion._applyRuntimeRewrites(line, rt, `$HOME/.${rt}/`, true, undefined);
      if (rt === 'claude') {
        return out.includes('--default claude') && !/--default (?!claude)/.test(out);
      }
      return out.includes(`--default ${rt}`) && !out.includes('--default claude');
    }),
  );
});

// ---------------------------------------------------------------------------
// fc property — idempotence: stamping twice equals once
// ---------------------------------------------------------------------------

test('property: _stampNonClaudeRuntimeDefaults is idempotent (#1521)', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...NON_CLAUDE),
      fc.constantFrom('runtime', 'use_worktrees'),
      (rt, which) => {
        const line =
          which === 'runtime'
            ? 'RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")\n'
            : 'USE_WORKTREES=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null || echo "true")\n';
        const once = conversion._applyRuntimeRewrites(line, rt, `$HOME/.${rt}/`, true, undefined);
        const twice = conversion._applyRuntimeRewrites(once, rt, `$HOME/.${rt}/`, true, undefined);
        return once === twice;
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// Guard generalization: execute-phase.md uses != "claude" not = "codex"
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Guard generalization: execute-phase.md, quick.md, and diagnose-issues.md
// all use != "claude" (not = "codex") for the worktree guard (#1521)
// ---------------------------------------------------------------------------

test('execute-phase.md, quick.md, and diagnose-issues.md guards are generalized to != "claude" (not Codex-specific) (#1521)', () => {
  // allow-test-rule: emitted workflow runtime-resolution shell block is the runtime contract surface (#1521)
  // #2584 Phase 3 (#2627): execute-phase.md graduated PAST the `!= "claude"`
  // guard — worktree isolation there is now keyed on the negotiated
  // `dispatch.isolation` capability, so no runtime name appears in its guard at
  // all. quick.md and diagnose-issues.md still use the #1521 generalized form
  // (they do not negotiate isolation), so they keep asserting it.
  const GUARD_WORKFLOWS = ['quick.md', 'diagnose-issues.md'];
  for (const wf of GUARD_WORKFLOWS) {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', wf),
      'utf8',
    );
    assert.ok(
      src.includes('[ "$RUNTIME" != "claude" ] && [ "$USE_WORKTREES" != "false" ]'),
      `${wf}: expected generalized guard [ "$RUNTIME" != "claude" ] && [ "$USE_WORKTREES" != "false" ]`,
    );
    assert.ok(
      !src.includes('[ "$RUNTIME" = "codex" ] && [ "$USE_WORKTREES" != "false" ]'),
      `${wf}: found Codex-specific guard — should have been generalized to != "claude"`,
    );
  }

  // execute-phase.md: the guard must be capability-keyed, with NO runtime name.
  const executePhase = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'),
    'utf8',
  );
  assert.ok(
    !/\[\s*"\$RUNTIME"\s*(?:!=|=)\s*"[a-z-]+"\s*\]\s*&&\s*\[\s*"\$USE_WORKTREES"/.test(executePhase),
    'execute-phase.md: worktree isolation must branch on dispatch.isolation, not on a runtime name (#2584)',
  );
  assert.ok(
    executePhase.includes('Resolve ISOLATION'),
    'execute-phase.md: must resolve the negotiated ISOLATION capability',
  );
});

// ---------------------------------------------------------------------------
// Orchestration gating: manager.md + autonomous.md gate background dispatch on
// the typed FLATTEN query. #1708 (ADR-1239 Phase B) graduated #1521's
// codex-specific check to a documentation-sourced shouldFlattenDispatch — the
// prose now branches on `FLATTEN` (false = background), not a runtime name.
// ---------------------------------------------------------------------------

test('manager.md and autonomous.md gate run_in_background on FLATTEN=false, not a runtime name (#1521, graduated by #1708)', () => {
  // allow-test-rule: orchestration dispatch gating in manager/autonomous .md is the runtime contract surface (#1521/#1708)
  const manager = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'manager.md'),
    'utf8',
  );
  const autonomous = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'autonomous.md'),
    'utf8',
  );

  // Both files must gate run_in_background on the typed FLATTEN decision (not a runtime name)
  assert.ok(
    /If `FLATTEN` is `false`[\s\S]{0,500}?run_in_background=true/.test(manager),
    'manager.md: expected run_in_background dispatch gated on FLATTEN=false (typed dispatch-should-flatten query)',
  );
  assert.ok(
    /If `FLATTEN` is `false`[\s\S]{0,1200}?run_in_background=true/.test(autonomous),
    'autonomous.md: expected run_in_background dispatch gated on FLATTEN=false (typed dispatch-should-flatten query)',
  );

  // Inline is the else branch, keyed on FLATTEN — never a runtime name
  assert.ok(
    /Otherwise[\s\S]{0,250}?inline/i.test(manager),
    'manager.md: expected "Otherwise ... inline" branch keyed on FLATTEN',
  );
  assert.ok(
    /Otherwise[\s\S]{0,250}?inline/i.test(autonomous),
    'autonomous.md: expected "Otherwise ... inline" branch keyed on FLATTEN',
  );
  // And the old runtime-name gating must be gone (no `RUNTIME` is `codex` dispatch gate)
  assert.ok(
    !/`RUNTIME` is `codex`[\s\S]{0,500}?run_in_background=true/.test(manager),
    'manager.md: must no longer gate run_in_background on the runtime name',
  );
});

test('manager.md and autonomous.md no longer contain old "not claude" background-dispatch gating (#1521)', () => {
  // allow-test-rule: orchestration dispatch gating in manager/autonomous .md is the runtime contract surface (#1521)
  const manager = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'manager.md'),
    'utf8',
  );
  const autonomous = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'autonomous.md'),
    'utf8',
  );

  // The old phrasing that unconditionally sent every non-claude runtime to background must be gone
  assert.ok(
    !manager.includes('If `RUNTIME` is not `claude` (e.g. Codex)'),
    'manager.md: old "If `RUNTIME` is not `claude` (e.g. Codex)" gating must be replaced',
  );
  assert.ok(
    !autonomous.includes('On other runtimes:'),
    'autonomous.md: old "On other runtimes:" branch label must be replaced',
  );
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2876-skill-frontmatter-quote.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2876-skill-frontmatter-quote (consolidation epic #1969 B8 #1977)", () => {
/**
 * Bug #2876: SKILL.md frontmatter parse failure when `description` begins
 * with a YAML flow indicator like `[BETA]`.
 *
 *   description: [BETA] Offload plan phase to Claude Code's ultraplan…
 *
 * YAML 1.2 treats a leading `[` as the start of a flow sequence, so any
 * downstream parser (gh-copilot, JetBrains' kit, etc.) fails with
 * "Unexpected scalar at node end". The Copilot/Antigravity/Trae/Codebuddy
 * skill+agent converters in `bin/install.js` re-emit the description
 * unquoted; the Claude variant `yamlQuote(...)`s it. Bring the others
 * in line so any value is round-trip-safe regardless of leading char.
 *
 * The test is structural: it parses each emitted frontmatter into lines
 * and asserts the `description` value is a quoted YAML scalar (double or
 * single quoted) when the source description starts with a flow indicator.
 * It does not regex the bytes for substrings.
 */
'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const installPath = path.resolve(REPO_ROOT, pkg.bin['gsd-core']);
const install = require(installPath);

// Build a minimal Claude command source whose description starts with the
// reporter's exact flow-indicator prefix. Apostrophe in the body forces
// any naive single-quoting to also escape correctly — the canonical
// safe form is `JSON.stringify(...)` (used by yamlQuote).
const REPORTER_DESCRIPTION =
  "[BETA] Offload plan phase to Claude Code's ultraplan cloud — drafts remotely while terminal stays free, review in browser with inline comments, import back via /gsd-import. Claude Code only.";

// Use unquoted description in the source frontmatter — that's exactly the
// shape that ships in commands/gsd/*.md when authors paste a description
// without quoting it (see commands/gsd/ultraplan-phase.md). The bug is
// triggered when the converter re-emits this same value to the destination
// runtime without quoting. `extractFrontmatterField` strips a single outer
// quote pair but does not unescape internal characters, so quoting the
// fixture input would actually mask the bug.
function buildClaudeCommand(description) {
  return [
    '---',
    'name: gsd:ultraplan-phase',
    `description: ${description}`,
    'argument-hint: "[phase-number]"',
    'allowed-tools:',
    '  - Read',
    '  - Bash',
    '---',
    '',
    '# body',
    '',
  ].join('\n');
}

function buildClaudeAgent(description) {
  return [
    '---',
    'name: gsd-extract-learnings',
    `description: ${description}`,
    'tools: Read, Bash',
    '---',
    '',
    '# body',
    '',
  ].join('\n');
}

function extractFrontmatter(content) {
  // Leading delimiter is `---\n`; closing is the next standalone `---`
  // on its own line. Tests parse line-structurally so the assertion
  // doesn't drift on whitespace/order changes (per project test-rigor).
  assert.ok(content.startsWith('---'), `output must begin with frontmatter, got: ${content.slice(0, 40)}`);
  const lines = content.split('\n');
  let openIdx = -1;
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      if (openIdx === -1) openIdx = i;
      else { closeIdx = i; break; }
    }
  }
  assert.ok(openIdx !== -1 && closeIdx !== -1, `output must have a closed frontmatter block, got:\n${content}`);
  return lines.slice(openIdx + 1, closeIdx);
}

function findDescriptionLine(frontmatterLines) {
  for (const line of frontmatterLines) {
    if (line.startsWith('description:')) return line;
  }
  assert.fail(`no description line found in frontmatter:\n${frontmatterLines.join('\n')}`);
  return ''; // unreachable
}

function isQuotedYamlScalar(valueText) {
  // YAML safe-quoted scalar: starts with `"` and ends with `"`, OR
  // starts with `'` and ends with `'`. This is what `yamlQuote()`
  // (JSON.stringify) and the Claude variant of these converters emit.
  const trimmed = valueText.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return true;
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return true;
  return false;
}

function parseQuotedYamlValue(valueText) {
  const trimmed = valueText.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

function assertDescriptionRoundTrips(emitted, expected, label) {
  const fmLines = extractFrontmatter(emitted);
  const descLine = findDescriptionLine(fmLines);
  const valueText = descLine.slice('description:'.length);
  assert.ok(
    isQuotedYamlScalar(valueText),
    `(${label}) description must be a quoted YAML scalar (parser-safe for leading flow indicators). Got line: ${descLine}`,
  );
  assert.strictEqual(
    parseQuotedYamlValue(valueText),
    expected,
    `(${label}) description must round-trip through YAML quoting unchanged.`,
  );
}

const COMMAND_CONVERTERS = [
  { label: 'convertClaudeCommandToCopilotSkill', fn: (src) => install.convertClaudeCommandToCopilotSkill(src, 'gsd-ultraplan-phase') },
  { label: 'convertClaudeCommandToAntigravitySkill', fn: (src) => install.convertClaudeCommandToAntigravitySkill(src, 'gsd-ultraplan-phase') },
  { label: 'convertClaudeCommandToTraeSkill', fn: (src) => install.convertClaudeCommandToTraeSkill(src, 'gsd-ultraplan-phase') },
  { label: 'convertClaudeCommandToCodebuddySkill', fn: (src) => install.convertClaudeCommandToCodebuddySkill(src, 'gsd-ultraplan-phase') },
];

const AGENT_CONVERTERS = [
  { label: 'convertClaudeAgentToCopilotAgent', fn: (src) => install.convertClaudeAgentToCopilotAgent(src) },
  { label: 'convertClaudeAgentToAntigravityAgent', fn: (src) => install.convertClaudeAgentToAntigravityAgent(src) },
];

// A grab-bag of leading characters that all break unquoted YAML scalar
// parsing per YAML 1.2 §7.3.3 / §6.9. The reporter's case is `[`; the
// rest defend against neighbouring drift.
const FLOW_HOSTILE_PREFIXES = ['[', '{', '*', '&', '!', '|', '>', '%', '@', '`'];

// Some converters (Trae, CodeBuddy) deliberately rewrite "Claude Code"
// in body content to their target runtime name, and the rewrite cuts
// across the description too. That's correct behavior — out of scope for
// the YAML-quoting fix — so for the reporter case we assert only the
// quoting requirement, not byte-equality of the round-tripped value.
function assertDescriptionIsQuoted(emitted, label) {
  const fmLines = extractFrontmatter(emitted);
  const descLine = findDescriptionLine(fmLines);
  const valueText = descLine.slice('description:'.length);
  assert.ok(
    isQuotedYamlScalar(valueText),
    `(${label}) description must be a quoted YAML scalar (parser-safe for leading flow indicators). Got line: ${descLine}`,
  );
}

describe('bug-2876: skill+agent converters emit YAML-quoted description', () => {
  for (const { label, fn } of COMMAND_CONVERTERS) {
    test(`${label}: reporter's "[BETA] ..." description is quoted`, () => {
      const out = fn(buildClaudeCommand(REPORTER_DESCRIPTION));
      assertDescriptionIsQuoted(out, label);
    });
    for (const prefix of FLOW_HOSTILE_PREFIXES) {
      test(`${label}: leading ${JSON.stringify(prefix)} is quoted`, () => {
        // Avoid leading/trailing `'` or `"` in the payload — `extractFrontmatterField`
        // strips a single outer quote char of either kind regardless of whether
        // the value was actually quoted, which would obscure the round-trip
        // assertion. Pre-existing behavior, out of scope for #2876.
        const desc = `${prefix} edge-case payload — flow indicator at start`;
        const out = fn(buildClaudeCommand(desc));
        assertDescriptionRoundTrips(out, desc, `${label} prefix=${prefix}`);
      });
    }
  }

  for (const { label, fn } of AGENT_CONVERTERS) {
    test(`${label}: reporter-shape "[BETA] ..." description is quoted`, () => {
      const out = fn(buildClaudeAgent(REPORTER_DESCRIPTION));
      assertDescriptionIsQuoted(out, label);
    });
  }
});
  });
}

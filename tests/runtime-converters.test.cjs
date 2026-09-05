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
  convertClaudeCommandToTraeSkill,
  convertClaudeCommandToKimiSkill,
  buildKimiAgentArtifacts,
  neutralizeAgentReferences,
} = require('../bin/install.js');

const {
  convertClaudeCommandToOpencodeSkill,
  convertClaudeCommandToKiloSkill,
} = require('../gsd-core/bin/lib/install-engine.cjs');

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

test('codex emit leaves workflow.use_worktrees at the true default — isolation is negotiated, not stamped (#1515 premise superseded by #2584/#2652)', () => {
  // #1515 stamped `--default false` here because worktree isolation *was*
  // Claude Code's isolation="worktree" spawn parameter, so a Codex install that
  // resolved use_worktrees=true would have run unisolated while believing it was
  // isolated. #2584 removed that premise: Codex declares
  // `dispatch.isolation: orchestrator-worktree`, meaning GSD creates the
  // worktree itself and spawns `codex exec --cd <worktree>` — supported, not
  // unsafe. Keeping the stamp would resolve USE_WORKTREES=false before
  // dispatch-isolation is consulted, re-deciding isolation by runtime name,
  // which is the exact defect #2652 removes. The safety property #1515 protects
  // is now held by the isolation gate's fail-closed resolution, not by a
  // name-scoped install-time default.
  const line =
    'USE_WORKTREES=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null || echo "true")\n';
  const out = conversion._applyRuntimeRewrites(line, 'codex', '$HOME/.codex/', true, undefined);
  assert.strictEqual(
    conversion._negotiatedDispatchIsolation('codex'),
    'orchestrator-worktree',
    'codex must declare orchestrator-worktree for this expectation to hold',
  );
  assert.strictEqual(
    out,
    line,
    `Expected the use_worktrees read to survive codex emit untouched; got:\n${out}`,
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
  // allow-test-rule: pending-migration-to-typed-ir [#3090]
  // `out` is _applyRuntimeRewrites's engine-transformed shell text, not shipped
  // source — substring-matching it is the "Rendered file" row CONTRIBUTING
  // requires a typed-IR builder for. No such IR exists yet for the shell
  // rewrite output; production change out of scope here. Tracked under #3090.
  const WORKFLOWS = ['execute-phase.md', 'autonomous.md', 'manager.md', 'diagnose-issues.md', 'quick.md'];
  const CLAUDE_RUNTIME = 'config-get runtime --default claude --raw 2>/dev/null || echo "claude"';
  const CODEX_RUNTIME = 'config-get runtime --default codex --raw 2>/dev/null || echo "codex"';
  const TRUE_WT = 'config-get workflow.use_worktrees --raw 2>/dev/null || echo "true"';
  const FALSE_WT = 'config-get workflow.use_worktrees --default false --raw 2>/dev/null || echo "false"';
  for (const wf of WORKFLOWS) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', wf), 'utf8');
    const out = conversion._applyRuntimeRewrites(src, 'codex', '$HOME/.codex/', true, undefined);
    // No un-stamped claude runtime line may survive codex emit on ANY surface.
    assert.ok(!out.includes(CLAUDE_RUNTIME), `${wf}: residual un-stamped runtime read — engine regex no longer matches source line (parity drift)`);
    // If the source HAS such a read, the codex form must be present.
    if (src.includes(CLAUDE_RUNTIME)) assert.ok(out.includes(CODEX_RUNTIME), `${wf}: runtime read not stamped to codex`);
    // #2652: codex declares orchestrator-worktree, so the use_worktrees read is
    // left for `gsd_run query dispatch-isolation` to decide at run time — the
    // install-time `--default false` stamp would pre-empt that negotiation.
    if (src.includes(TRUE_WT)) {
      assert.ok(out.includes(TRUE_WT), `${wf}: use_worktrees read was stamped away for a runtime that negotiates worktree isolation (#2652)`);
      assert.ok(!out.includes(FALSE_WT), `${wf}: codex gained the --default false use_worktrees stamp (#2652)`);
    }
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
 * identity into emitted workflows, and stamps workflow.use_worktrees=false
 * where its negotiated dispatch.isolation is `none`.
 *
 * #1519 (Codex-only fix) was generalized here to ALL non-Claude runtimes on the
 * premise that GSD's worktree isolation was Claude Code's isolation="worktree"
 * spawn parameter, which no other runtime honored. #2584 replaced that premise
 * with the negotiated `dispatch.isolation` capability, and #2652 scoped the
 * use_worktrees stamp to match: a host declaring harness-worktree or
 * orchestrator-worktree keeps the `true` default, because stamping it false
 * pre-empts the negotiation and re-decides isolation by runtime name.
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

test('parity: every non-Claude runtime stamps its own runtime default, and use_worktrees=false only where isolation negotiates to none (#1521, #2652)', () => {
  // allow-test-rule: pending-migration-to-typed-ir [#3090]
  // `out` is _applyRuntimeRewrites's engine-transformed shell text, not shipped
  // source — substring-matching it is the "Rendered file" row CONTRIBUTING
  // requires a typed-IR builder for. No such IR exists yet for the shell
  // rewrite output; production change out of scope here. Tracked under #3090.
  for (const rt of NON_CLAUDE) {
    const isolation = conversion._negotiatedDispatchIsolation(rt);
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

      // If the source had a runtime read, the output must have --default <rt>
      if (src.includes(CLAUDE_RUNTIME_LINE)) {
        assert.ok(
          out.includes(`config-get runtime --default ${rt} --raw 2>/dev/null || echo "${rt}"`),
          `${rt}/${wf}: runtime line not stamped to --default ${rt}`,
        );
      }

      if (!src.includes(TRUE_WT_LINE)) continue;

      // #2652: the use_worktrees=false stamp is scoped to the runtimes whose
      // negotiated dispatch.isolation really is `none`. A host that declares
      // harness-worktree (cursor) or orchestrator-worktree (codex, opencode,
      // kimi, kimi-code) must keep the unstamped `true` default, or the stamp
      // resolves USE_WORKTREES=false before dispatch-isolation is consulted and
      // the runtime is judged by its name after all.
      if (isolation === 'none') {
        assert.ok(
          !out.includes(TRUE_WT_LINE),
          `${rt}/${wf}: residual un-stamped use_worktrees=true read — _stampNonClaudeRuntimeDefaults not applied`,
        );
        assert.ok(
          out.includes(FALSE_WT_LINE),
          `${rt}/${wf}: use_worktrees line not defaulted to false`,
        );
      } else {
        assert.ok(
          out.includes(TRUE_WT_LINE),
          `${rt}/${wf}: declares dispatch.isolation=${isolation} but the use_worktrees read was stamped away — the install-time default pre-empts the negotiated capability (#2652)`,
        );
        assert.ok(
          !out.includes(FALSE_WT_LINE),
          `${rt}/${wf}: declares dispatch.isolation=${isolation} but gained the --default false stamp`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// #2652: the stamp's scope is the negotiated capability, not the runtime name
// ---------------------------------------------------------------------------

test('regression #2652: _stampNonClaudeRuntimeDefaults leaves use_worktrees alone for every runtime that negotiates a worktree isolation', () => {
  const line =
    'USE_WORKTREES=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null || echo "true")\n';

  // The set is derived from the registry, not hand-listed, so a newly declared
  // worktree host is covered the moment it lands — the same reason
  // NON_CLAUDE_RUNTIMES is derived rather than literal (#1521).
  const declaresWorktree = NON_CLAUDE.filter(
    (rt) => conversion._negotiatedDispatchIsolation(rt) !== 'none',
  );
  const declaresNone = NON_CLAUDE.filter(
    (rt) => conversion._negotiatedDispatchIsolation(rt) === 'none',
  );

  // Both arms must be non-empty or the test proves nothing about either.
  assert.ok(
    declaresWorktree.length > 0,
    'no non-Claude runtime negotiates a worktree isolation — the regression this pins is unreachable',
  );
  assert.ok(
    declaresNone.length > 0,
    'every non-Claude runtime negotiates a worktree isolation — the false stamp is dead code',
  );

  for (const rt of declaresWorktree) {
    assert.strictEqual(
      conversion._stampNonClaudeRuntimeDefaults(line, rt),
      line,
      `${rt}: negotiates ${conversion._negotiatedDispatchIsolation(rt)} but its use_worktrees default was stamped false at install time, so dispatch-isolation-gate.md resolves ISOLATION=none regardless of what it declared (#2652)`,
    );
  }

  for (const rt of declaresNone) {
    assert.ok(
      conversion._stampNonClaudeRuntimeDefaults(line, rt).includes(FALSE_WT_LINE),
      `${rt}: negotiates none, so the false default must still be stamped (#1521)`,
    );
  }
});

test('regression #2652: _negotiatedDispatchIsolation fails closed on an undeclared or unknown runtime', () => {
  // Mirrors routeDispatchIsolation's fail-closed contract (ADR-1239): anything
  // outside the closed vocabulary resolves to `none`, so the #1521 stamp — and
  // the workflows' isolation gate — degrade to sequential rather than to an
  // unisolated dispatch that believes it is isolated.
  for (const unknown of ['not-a-runtime', '', 'CLAUDE', '__proto__']) {
    assert.strictEqual(
      conversion._negotiatedDispatchIsolation(unknown),
      'none',
      `${JSON.stringify(unknown)}: expected fail-closed 'none'`,
    );
  }

  // A registry-known host whose declared value is the `undocumented` sentinel
  // (or absent) is out of vocabulary and must degrade the same way.
  const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
  const undocumented = NON_CLAUDE.filter((rt) => {
    const declared = registry?.runtimes?.[rt]?.runtime?.hostIntegration?.dispatch?.isolation;
    return declared === 'undocumented' || declared == null;
  });
  assert.ok(undocumented.length > 0, 'no runtime declares the undocumented sentinel — nothing to pin');
  for (const rt of undocumented) {
    assert.strictEqual(conversion._negotiatedDispatchIsolation(rt), 'none', `${rt}: undocumented must degrade to none`);
  }
});

// ---------------------------------------------------------------------------
// #2652 review round-5/6 Major 1 — PARITY with the runtime resolver.
//
// `_negotiatedDispatchIsolation` (install time, this module) and
// `routeDispatchIsolation` (dispatch time, gsd-core/bin/gsd-tools.cjs) are two
// implementations of ONE rule: what isolation may this host negotiate. They
// read the same inputs — the capability registry and `resolveOrchestratorExec`
// — but duplicate the DECISION on top of them, on two surfaces (the install
// engine and the CLI query hub) with no call edge between them. So neither
// symbol appears in the other's impact graph and no static analysis sees the
// duplication. Divergence would be silent, and its consequence is the #2652
// defect returning by the back door: the installer stamping
// `use_worktrees=false` for a host the resolver would have granted a worktree
// (or the reverse — an unstamped host whose dispatch then refuses).
//
// The assertion is therefore behavioral on BOTH sides: the resolver leg drives
// the REAL CLI and reads its actual stdout.
// ---------------------------------------------------------------------------

test('regression #2652: _negotiatedDispatchIsolation agrees with the routeDispatchIsolation CLI for every registered runtime', () => {
  const { runGsdTools, createTempProject, cleanup: cleanupDir } = require('./helpers.cjs');
  const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
  const RUNTIME_IDS = Object.keys(registry.runtimes).sort();

  // Install time cannot know the worktree a future dispatch will target, so
  // `_negotiatedDispatchIsolation` probes the orchestrator descriptor with a
  // placeholder. The CLI is asked BOTH ways, because the two calls are both real:
  //
  //   --cwd-target <probe>  the executor-spawn call, which resolves the descriptor.
  //                         Same question install time asks; must match exactly.
  //   (no --cwd-target)     the FIRST call every dispatch site makes — the
  //                         `Resolve ISOLATION` block in dispatch-isolation-gate.md.
  //                         It skips descriptor resolution, so it can only differ
  //                         from install time for an orchestrator host whose
  //                         descriptor does not resolve. No such host exists today
  //                         and that is worth pinning: if one lands, the install
  //                         stamps `use_worktrees=false` while the workflow gate
  //                         still reports `orchestrator-worktree` — the #2652 split
  //                         brain, in the one shape the target-bound leg cannot see.
  const PROBE_TARGET = '/gsd-orchestrator-worktree-probe';

  const dir = createTempProject('gsd-2652-parity-');
  try {
    const disagreements = [];
    const seen = new Set();
    for (const rt of RUNTIME_IDS) {
      const res = runGsdTools(
        ['query', 'dispatch-isolation', '--json', '--cwd-target', PROBE_TARGET],
        dir,
        { GSD_RUNTIME: rt, HOME: dir },
      );
      assert.equal(res.success, true, `${rt}: dispatch-isolation query failed: ${res.error}`);
      const parsed = JSON.parse(res.output);

      // Guard the guard: if resolveRuntime normalized `rt` to some other id, the
      // comparison below would be pinning the wrong host and silently pass.
      assert.equal(
        parsed.runtime,
        rt,
        `${rt}: the CLI resolved runtime "${parsed.runtime}" instead — parity would be measured against the wrong host`,
      );

      const gateRes = runGsdTools(
        ['query', 'dispatch-isolation', '--raw'],
        dir,
        { GSD_RUNTIME: rt, HOME: dir },
      );
      assert.equal(gateRes.success, true, `${rt}: no-target dispatch-isolation query failed: ${gateRes.error}`);
      const gateIsolation = gateRes.output.trim();

      const installTime = conversion._negotiatedDispatchIsolation(rt);
      seen.add(installTime);
      if (installTime !== parsed.isolation) {
        disagreements.push(
          `${rt}: install-time _negotiatedDispatchIsolation → "${installTime}", ` +
            `dispatch-time routeDispatchIsolation (--cwd-target) → "${parsed.isolation}"`,
        );
      }
      if (installTime !== gateIsolation) {
        disagreements.push(
          `${rt}: install-time _negotiatedDispatchIsolation → "${installTime}", ` +
            `workflow-gate routeDispatchIsolation (no --cwd-target) → "${gateIsolation}"`,
        );
      }
    }

    assert.deepEqual(
      disagreements,
      [],
      'the install-time and dispatch-time isolation resolvers disagree. One of them was ' +
        'changed without the other (DEFECT.GENERATIVE-FIX-DIVERGENCE): the installer and the ' +
        'dispatch gate would then make opposite isolation decisions for the same host.\n' +
        disagreements.join('\n'),
    );

    // A parity check over a set that only ever answers `none` proves nothing —
    // both legs could be stubbed to a constant and still agree.
    for (const mode of ['harness-worktree', 'orchestrator-worktree', 'none']) {
      assert.ok(
        seen.has(mode),
        `no registered runtime resolves to "${mode}" — the parity above never exercised that branch`,
      );
    }
  } finally {
    cleanupDir(dir);
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
  // allow-test-rule: source-text-is-the-product (#1521)
  // Reads the raw shipped workflow .md source directly (not engine-transformed
  // output) and asserts on its literal guard-clause text — the deployed prose
  // IS the runtime contract here.
  // #2584 Phase 3 (#2627): execute-phase.md graduated PAST the `!= "claude"`
  // guard — worktree isolation there is now keyed on the negotiated
  // `dispatch.isolation` capability, so no runtime name appears in its guard at
  // all.
  //
  // #2652: quick.md and diagnose-issues.md have now graduated too. This block
  // previously asserted they still carried the #1521 generalized form, with a
  // comment noting "they do not negotiate isolation" — i.e. the test knowingly
  // pinned the un-migrated state #2652 was filed about. They negotiate now, so
  // they are held to the same capability-keyed contract as execute-phase.md.
  const GUARD_WORKFLOWS = ['quick.md', 'diagnose-issues.md', 'execute-phase.md'];
  for (const wf of GUARD_WORKFLOWS) {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', wf),
      'utf8',
    );
    assert.ok(
      !src.includes('[ "$RUNTIME" != "claude" ] && [ "$USE_WORKTREES" != "false" ]'),
      `${wf}: worktree isolation must branch on dispatch.isolation, not on != "claude" (#2584/#2652)`,
    );
    assert.ok(
      !src.includes('[ "$RUNTIME" = "codex" ] && [ "$USE_WORKTREES" != "false" ]'),
      `${wf}: found Codex-specific guard — isolation is a negotiated capability (#2584/#2652)`,
    );
  }

  // The two migrated sites must actually negotiate, not merely drop the guard.
  for (const wf of ['quick.md', 'diagnose-issues.md']) {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', wf),
      'utf8',
    );
    assert.ok(
      src.includes('query dispatch-isolation'),
      `${wf}: must resolve ISOLATION via \`gsd_run query dispatch-isolation\` (#2652)`,
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
  // allow-test-rule: source-text-is-the-product (#1521/#1708)
  // Reads the raw shipped manager.md/autonomous.md workflow prose directly —
  // the deployed orchestration dispatch gating text IS the runtime contract.
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
  // allow-test-rule: source-text-is-the-product (#1521)
  // Reads the raw shipped manager.md/autonomous.md workflow prose directly —
  // the deployed orchestration dispatch gating text IS the runtime contract.
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
// #2486: settings.md must not recommend or persist worktree isolation on
// non-Claude runtimes, and health.md must surface an inherited explicit
// use_worktrees=true before execution fails closed on it. Both rely on the
// #1521 stamping machinery, so the canonical runtime/use_worktrees reads in
// those two files are part of the runtime contract surface.
// ────────────────────────────────────────────────────────────────────────
{
  const fs = require('node:fs');
  const path = require('node:path');
  const conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  const { NON_CLAUDE_RUNTIMES } = conversion;

  const RUNTIME_BRANCH_WORKFLOWS = ['settings.md', 'health.md'];
  const CLAUDE_RUNTIME_LINE = 'config-get runtime --default claude --raw 2>/dev/null || echo "claude"';
  const TRUE_WT_LINE = 'config-get workflow.use_worktrees --raw 2>/dev/null || echo "true"';
  // #2486 review round 2 (#2584): the capability read that replaced the runtime-name
  // gate. Round 4: `inspect-dispatch-isolation`, the side-effect-free inspection verb —
  // the recording `dispatch-isolation` verb stamps the executor-dispatch sentinel as an
  // unconditional #3045 side effect, which an inspection surface must never do.
  // Round 9 (#2486 review, Major 3): this used to pin the single-line
  // `ISOLATION=$(… || echo "none")` read. That shape was the defect — `|| echo
  // "none"` collapses "this runtime declares no primitive" into "the resolver
  // failed", and both surfaces then assert the former, which is false. The
  // canonical read now captures the raw value and tracks whether a verdict was
  // actually learned, the same shape the execution-side isolation gate uses.
  // Pinned as two invariants rather than one long literal so that reformatting
  // the block does not fail the test while a semantic regression still does.
  const ISOLATION_LINE = '_INSPECTED_RAW=$(gsd_run query inspect-dispatch-isolation --raw 2>/dev/null)';
  const ISOLATION_RESOLVED_FLAG = 'INSPECTED_RESOLVED';
  const ISOLATION_COLLAPSING_FALLBACK = /inspect-dispatch-isolation --raw 2>\/dev\/null \|\| echo/;
  const readWorkflow = (wf) =>
    fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', wf), 'utf8');

  // Behavioral W025 coverage (#2486 Major 2) executes the shipped block, so it
  // needs a subprocess and a CRLF-safe read. `readFileNormalized` normalizes at
  // the READ boundary — a `\r?\n` fence regex alone leaves embedded CR inside
  // the captured body, which bash then treats as part of the token
  // (DEFECT.WINDOWS-CRLF-TEST-PORTABILITY).
  //
  // The subprocess goes through the process seam, never a hand-rolled
  // spawnSync (CONTRIBUTING "Spawning a subprocess: use the process seam").
  // `runHook` already documents `interpreter: 'bash'` for running a shell
  // script, so the harness is written to a file rather than passed as `-c`.
  const { runHook } = require('./helpers/process-seam.cjs');
  const { readFileNormalized, createTempDir, cleanup: cleanupDir } = require('./helpers.cjs');
  const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
  // Skipped on Windows, where there is no bash. Checked by platform rather than
  // by shelling out to `which`, which is itself non-portable.
  const NO_BASH = process.platform === 'win32';

  /** The first ```bash fenced block in `src` whose body includes `marker`. */
  function bashBlockContaining(src, marker) {
    const lines = src.split(/\r?\n/);
    for (const block of scanFencedBlocks(lines)) {
      if (block.closeLineIdx === -1) continue;
      if ((block.infoString || '').trim() !== 'bash') continue;
      const body = lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n');
      if (body.includes(marker)) return body;
    }
    return undefined;
  }

  describe('#2486 regression: settings/health worktrees isolation branch', () => {
    // Review round 2 (#2584 Phase 3): isolation is a DECLARED CAPABILITY, not a
    // runtime name. cursor declares harness-worktree and codex/opencode/kimi/
    // kimi-code declare orchestrator-worktree, so a `RUNTIME != claude` gate
    // would block a supported configuration on five runtimes and false-warn in
    // health. Both surfaces branch on `dispatch-isolation` instead.
    test('settings.md and health.md contain NO runtime-name gate for the worktrees branch', () => {
      // allow-test-rule: source-text-is-the-product (#2486)
      // Workflow .md text IS what the runtime loads — asserting on it tests the deployed contract.
      for (const wf of RUNTIME_BRANCH_WORKFLOWS) {
        const src = readWorkflow(wf);
        assert.ok(
          !src.includes(CLAUDE_RUNTIME_LINE),
          `${wf}: the worktrees branch must not read the runtime name — gate on dispatch-isolation (#2584)`,
        );
        assert.ok(
          !/RUNTIME"?\s*(!=|=)\s*"?claude/.test(src),
          `${wf}: residual RUNTIME-vs-claude comparison — execute-phase forbids a runtime-name fan-out`,
        );
        // Prose gates count too: the shell-syntax check above missed two
        // sentences that still asserted the obsolete non-Claude premise
        // (the config-key list and the emitted-JSON schema comment).
        assert.ok(
          !/non-Claude (installs?|runtimes?)\b[^.]{0,120}\b(fail closed|default it to `?false)/i.test(src),
          `${wf}: prose still states the obsolete "non-Claude cannot honor worktrees" premise — gate on dispatch.isolation`,
        );
        assert.ok(
          !/never written as true on a non-Claude runtime/i.test(src),
          `${wf}: emitted-JSON comment still claims a runtime-name persistence rule`,
        );
      }
    });

    // Round 4 note: an earlier revision carried a test here that encoded the
    // #2728 merge order as a red assertion against quick.md/diagnose-issues.md.
    // Deleted: a repo test cannot sequence merges — it only made this change
    // unmergeable on its own schedule. The settings behavior change is instead
    // scoped entirely to the `ISOLATION = none` branch (below), which needs
    // nothing from any sibling PR; the `!= none` path is base behavior unchanged.

    test('settings.md and health.md resolve isolation with the sentinel-free inspection read', () => {
      // allow-test-rule: source-text-is-the-product (#2486)
      // Workflow .md text IS what the runtime loads — asserting on it tests the deployed contract.
      for (const wf of RUNTIME_BRANCH_WORKFLOWS) {
        const src = readWorkflow(wf);
        assert.ok(
          src.includes(ISOLATION_LINE),
          `${wf}: missing the canonical inspect-dispatch-isolation read (fail-closes unknown/undocumented to none)`,
        );
        // Major 3: fail-closed is right; reporting the failure AS a capability
        // verdict is not. Both surfaces must be able to tell the two apart.
        // #2486 review: the diagnostics name their state INSPECTED_ISOLATION,
        // not ISOLATION. That is load-bearing, not cosmetic — #2728's
        // "every dispatch-site degrade block re-records" guard scans for a
        // literal `ISOLATION=none` in any workflow bash block, and a read-only
        // surface has no sentinel to re-record. Naming the read differently
        // keeps these files out of that scan BY CONSTRUCTION; the alternative
        // was exempting the two files, which silently covered any future
        // dispatch block added to them.
        assert.ok(
          !/^\s*ISOLATION=/m.test(src),
          `${wf}: a read-only diagnostic must not assign the dispatch-site variable name ISOLATION — use INSPECTED_ISOLATION so #2728's re-record guard does not have to carve out this file`,
        );
        assert.ok(
          src.includes(ISOLATION_RESOLVED_FLAG),
          `${wf}: must track ISOLATION_RESOLVED — a resolver failure is not a declaration of 'none' (#2486 review, Major 3)`,
        );
        assert.ok(
          !ISOLATION_COLLAPSING_FALLBACK.test(src),
          `${wf}: '|| echo "none"' on the inspect read collapses "could not resolve" into "declares none" — capture the raw value and branch on ISOLATION_RESOLVED instead`,
        );
        // #2486 round 4 (B1): the RECORDING resolver is dispatch-only. On
        // current next, `query dispatch-isolation` persists its decision to
        // .gsd/dispatch-isolation-sentinel.json as an unconditional #3045 side
        // effect, and the isolation guard hooks hard-fail dispatches that
        // disagree with the recorded sentinel. An inspection surface calling it
        // would let /gsd:health or /gsd:settings hard-block executor dispatch
        // for the sentinel's lifetime — across sessions, since the sentinel
        // root resolves linked worktrees to the main checkout.
        assert.ok(
          !src.includes('query dispatch-isolation'),
          `${wf}: calls the RECORDING dispatch-isolation verb — inspection surfaces must use inspect-dispatch-isolation, which never writes the sentinel`,
        );
        assert.ok(
          src.includes('"$INSPECTED_ISOLATION" = "none"') || src.includes('`INSPECTED_ISOLATION` = `none`'),
          `${wf}: must gate on ISOLATION = none, the only value that cannot honor worktrees`,
        );
      }
    });

    test('the isolation read is runtime-neutral — no per-runtime stamping rewrites it', () => {
      // inspect-dispatch-isolation resolves the runtime internally and fail-closes,
      // so unlike the #1521 runtime read it must survive every emit byte-identical.
      // allow-test-rule: integration-test-input (#2486)
      // The workflow source is fed to _applyRuntimeRewrites as real fixture input;
      // the assertion is on the transformation's output.
      for (const rt of NON_CLAUDE_RUNTIMES) {
        for (const wf of RUNTIME_BRANCH_WORKFLOWS) {
          const out = conversion._applyRuntimeRewrites(readWorkflow(wf), rt, `$HOME/.${rt}/`, true, undefined);
          assert.ok(
            out.includes(ISOLATION_LINE),
            `${rt}/${wf}: the inspect-dispatch-isolation read must not be rewritten by per-runtime stamping`,
          );
        }
        // The settings tri-state read must survive stamping too: if
        // _stampNonClaudeRuntimeDefaults ever matched the bare (no-fallback)
        // shape, absence would again collapse into an explicit false and the
        // pre-selection rule would go dead on that runtime.
        const settingsOut = conversion._applyRuntimeRewrites(readWorkflow('settings.md'), rt, `$HOME/.${rt}/`, true, undefined);
        assert.ok(
          settingsOut.includes('USE_WORKTREES_CURRENT=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null)'),
          `${rt}/settings.md: the bare tri-state worktrees read must survive per-runtime stamping byte-identical`,
        );
      }
    });

    test('claude emit of settings.md and health.md keeps the recommended Yes option unchanged', () => {
      const settingsOut = conversion._applyRuntimeRewrites(readWorkflow('settings.md'), 'claude', '$HOME/.claude/', true, undefined);
      assert.ok(
        settingsOut.includes('{ label: "Yes (Recommended)", description: "Each parallel executor runs in its own worktree branch — no conflicts between agents." }'),
        'claude/settings.md: the worktree-capable Worktrees question must be unchanged',
      );
    });

    test('settings.md source carries the isolation-none branch: no enabling option, never persist true', () => {
      const src = readWorkflow('settings.md');
      assert.ok(
        src.includes('**Conditional options — Worktrees (#2486):**'),
        'settings.md: missing the conditional-options block for the Worktrees question',
      );
      // Round 4: the current-value read carries NO --default/fallback on purpose.
      // _stampNonClaudeRuntimeDefaults rewrites the canonical fallback line to
      // `--default false || echo "false"` on every non-Claude emit, which made
      // key-absence indistinguishable from an explicit false — and the
      // "pre-select Leave unchanged only when absent" rule dead there. The bare
      // read signals absence as empty output and matches no stamp pattern.
      assert.ok(
        src.includes('USE_WORKTREES_CURRENT=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null)'),
        'settings.md: current worktrees value must use the bare tri-state read (empty = absent)',
      );
      assert.ok(
        !src.includes(`USE_WORKTREES_CURRENT=$(gsd_run query ${TRUE_WT_LINE})`),
        'settings.md: the stampable fallback read collapses absent into false on non-Claude emits',
      );
      assert.ok(
        src.includes('NEVER write `workflow.use_worktrees: true` from this workflow when the runtime declares no isolation primitive'),
        'settings.md: missing the never-persist-true instruction for isolation-none runtimes',
      );
      assert.ok(
        src.includes('{ label: "No (Recommended)", description: "Write use_worktrees: false.'),
        'settings.md: isolation-none branch must recommend No',
      );
      assert.ok(
        src.includes('{ label: "Leave unchanged", description: "Do not write the key.'),
        'settings.md: isolation-none branch must offer leaving the key untouched for shared configs',
      );
      // Round 2: in the broken-inheritance case (explicit non-false value) the
      // pre-selected default must be the repair, not "Leave unchanged".
      // Round-5 review: this used to pin `Pre-select "Leave unchanged" only
      // when the key is absent`. That assumed an absent key is already safe,
      // which holds only on an emit that stamped the default to false —
      // execute-phase/quick/diagnose read it as `|| echo "true"` otherwise. The
      // recommended default must now be the explicit repair in every case.
      assert.ok(
        src.includes('Pre-select "No (Recommended)" in every case, including an absent key'),
        'settings.md: the recommended default must be the explicit false — an absent key is safe only on a stamped emit',
      );
      assert.ok(
        !/Pre-select "Leave unchanged" only when the key is absent/.test(src),
        'settings.md: the old absent-key-is-safe pre-selection rule is falsified on un-stamped emits (#2486 round-5 review)',
      );
      assert.ok(
        src.includes('when it is an explicit non-false value — the broken-inheritance case'),
        'settings.md: the broken-inheritance case must pre-select the recommended repair',
      );
    });

    test('health.md source carries the W025 isolation/worktrees compatibility check', () => {
      const src = readWorkflow('health.md');
      assert.ok(
        src.includes('W025:'),
        'health.md: missing the W025 diagnostic line',
      );
      assert.ok(
        src.includes('Status: DEGRADED'),
        'health.md: a config the execution workflows fail closed on must degrade the reported status',
      );
      // #2486 review Major 1: W025's correctness must NOT depend on
      // `_stampNonClaudeRuntimeDefaults` having rewritten the read. A
      // `|| echo "true"` fallback makes an ABSENT key look like an explicit
      // `true`, so the check fires on a config that never set it — correct only
      // on a stamped emit, wrong on the un-stamped source/Claude emit. Pin the
      // stamp-independent shape settings.md already uses.
      assert.ok(
        src.includes('USE_WORKTREES=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null)'),
        'health.md: the W025 worktrees read must be bare — a --default/|| fallback collapses key-absent into explicit-true (#2486 Major 1)',
      );
      assert.ok(
        !/workflow\.use_worktrees --raw 2>\/dev\/null \|\| echo/.test(src),
        'health.md: the W025 read reintroduced a fallback, so it depends on install-time stamping again (#2486 Major 1)',
      );
      assert.ok(
        src.includes('[ -n "$USE_WORKTREES" ]'),
        'health.md: W025 must require the key to be PRESENT before warning that the config "sets" it',
      );
    });

    // #2486 review Major 2: the coverage above is still text-matching. Execute
    // the SHIPPED block so the predicate is proven by behavior — Major 1 would
    // have been caught by any one of these cases.
    test('W025 fires only on an explicit non-false key under isolation=none (behavioral, #2486 Major 2)', { skip: NO_BASH }, (t) => {
      const scratch = createTempDir('gsd-w025-');
      t.after(() => cleanupDir(scratch));
      const src = readFileNormalized(
        path.join(__dirname, '..', 'gsd-core', 'workflows', 'health.md'),
      );
      const block = bashBlockContaining(src, 'W025:');
      assert.ok(block, 'health.md: no ```bash block containing the W025 diagnostic');

      /** Run the shipped block with `gsd_run` stubbed to the given answers. */
      const fire = (isolation, worktreesOut) => {
        const harness = [
          'set -u',
          'gsd_run() {',
          '  case "$*" in',
          `    *inspect-dispatch-isolation*) printf '%s' ${JSON.stringify(isolation)} ;;`,
          // Faithful to the real CLI: `config-get` EXITS NON-ZERO for an absent
          // key, it does not print empty and succeed. A stub that succeeds here
          // would let `|| echo "true"` be reintroduced and still pass — the
          // fallback only triggers on failure (#2486 round-7 review, Major 4).
          worktreesOut === ''
            ? '    *"config-get workflow.use_worktrees"*) return 1 ;;'
            : `    *"config-get workflow.use_worktrees"*) printf '%s' ${JSON.stringify(worktreesOut)} ;;`,
          "    *) printf '' ;;",
          '  esac; }',
          block,
        ].join('\n');
        const scriptPath = path.join(scratch, `w025-${isolation}-${worktreesOut || 'absent'}.sh`);
        fs.writeFileSync(scriptPath, harness);
        const res = runHook(scriptPath, [], { interpreter: 'bash' });
        assert.equal(
          res.outcome, 'exited',
          `W025 block did not complete cleanly: outcome=${res.outcome} ${res.stderr || ''}`,
        );
        assert.equal(res.exitCode, 0, `W025 block exited ${res.exitCode}: ${res.stderr}`);
        return res.stdout.includes('W025:');
      };

      // The reviewer's exact repro: rt=qwen, source (un-stamped) emit, cfg={}.
      // The key is absent, so `config-get` prints nothing. This FIRED before.
      assert.equal(
        fire('none', ''),
        false,
        'W025 fired on an ABSENT use_worktrees key — the warning claims the config "sets" a non-false value, and it does not (#2486 Major 1 repro)',
      );
      // The defect W025 actually exists for.
      assert.equal(
        fire('none', 'true'),
        true,
        'W025 stayed quiet on an explicit true under isolation=none — that is the config execute-phase/quick fail closed on',
      );
      assert.equal(
        fire('none', 'false'), false, 'W025 fired on an explicit false — nothing to repair',
      );
      // A host that CAN isolate is never the subject of this warning.
      for (const iso of ['harness-worktree', 'orchestrator-worktree']) {
        assert.equal(
          fire(iso, 'true'),
          false,
          `W025 fired on ${iso}, which declares an isolation primitive — the gate is the declared capability, not the runtime name (#2584)`,
        );
      }
    });

    // #2486 round-9 review, Major 3: the source-text pins above assert only
    // that ISOLATION_RESOLVED is *mentioned*, so flipping the shipped block's
    // `ISOLATION_RESOLVED=true` to `false` left every one of them green. What
    // has to be pinned is the BRANCH: a resolver that answered and a resolver
    // that failed must produce different W025 text, because the whole point is
    // to stop reporting a failed query as a capability verdict. This test
    // drives the shipped block twice and fails on the mutation.
    test('W025 distinguishes a declared none from an unresolvable query (behavioral, #2486 Major 3)', { skip: NO_BASH }, (t) => {
      const scratch = createTempDir('gsd-w025-provenance-');
      t.after(() => cleanupDir(scratch));
      const src = readFileNormalized(
        path.join(__dirname, '..', 'gsd-core', 'workflows', 'health.md'),
      );
      const block = bashBlockContaining(src, 'W025:');
      assert.ok(block, 'health.md: no ```bash block containing the W025 diagnostic');

      // `resolves` false = the inspect call exits non-zero, the real shape of a
      // shim that cannot resolve. The worktrees key is an explicit true in both
      // runs, so the ONLY difference is whether the capability query answered.
      const runBlock = (resolves) => {
        const harness = [
          'set -u',
          'gsd_run() {',
          '  case "$*" in',
          resolves
            ? "    *inspect-dispatch-isolation*) printf 'none' ;;"
            : '    *inspect-dispatch-isolation*) return 1 ;;',
          "    *\"config-get workflow.use_worktrees\"*) printf 'true' ;;",
          "    *) printf '' ;;",
          '  esac; }',
          block,
        ].join('\n');
        const scriptPath = path.join(scratch, `w025-resolves-${resolves}.sh`);
        fs.writeFileSync(scriptPath, harness);
        const res = runHook(scriptPath, [], { interpreter: 'bash' });
        assert.equal(res.outcome, 'exited', `block did not complete: ${res.stderr || ''}`);
        assert.equal(res.exitCode, 0, `block exited ${res.exitCode}: ${res.stderr}`);
        return res.stdout;
      };

      const resolved = runBlock(true);
      const unresolved = runBlock(false);

      // Both must warn — an explicit true is worth reporting either way.
      assert.match(resolved, /W025:/, 'a resolved none with an explicit true must still warn');
      assert.match(unresolved, /W025:/, 'an unresolvable capability with an explicit true must still warn');

      // ...but they must not say the same thing.
      assert.notEqual(
        resolved.trim(),
        unresolved.trim(),
        'W025 emitted identical text whether or not the capability resolved — that is the Major 3 conflation',
      );
      assert.match(
        unresolved,
        /could not resolve/i,
        'the unresolved branch must report that the query failed, not assert a capability verdict',
      );
      assert.doesNotMatch(
        unresolved,
        /declares no executor-isolation primitive|has no usable executor-isolation primitive/i,
        'the unresolved branch must NOT claim the runtime has no primitive — nothing established that',
      );
      assert.doesNotMatch(
        resolved,
        /could not resolve/i,
        'the resolved branch must state the capability finding, not a resolution failure',
      );
      // Round-3 review: asserting only "differs and omits the other phrase"
      // would stay green if the resolved text were replaced with anything at
      // all. Pin what it must positively say — the capability finding and the
      // consequence a user acts on.
      assert.match(
        resolved,
        /no usable executor-isolation primitive/i,
        'the resolved branch must state the capability finding it actually reached',
      );
      assert.match(
        resolved,
        /fail closed/i,
        'the resolved branch must state the consequence — that is what makes W025 actionable',
      );
      assert.match(
        resolved,
        /use_worktrees/,
        'the resolved branch must name the offending key',
      );
      // Both branches must still route the user to the same repair.
      for (const [name, out] of [['resolved', resolved], ['unresolved', unresolved]]) {
        assert.match(out, /(?:\/gsd[:-]settings|\$gsd-settings)\b/, `${name}: W025 must name the repair command`);
      }
    });

    test('W025 is documented consistently across health.md and both config references', () => {
      // The rename W020 -> W025 landed in health.md only; the two docs kept
      // saying W020, which collides with a code src/verify.cts already emits.
      // #3309: health.md's generated `<error_codes>` table now carries a real,
      // UNRELATED W020 row of its own (`Worktree health scan degraded` —
      // git-worktree-list-inventory failure, #3384/#3652 territory), whose
      // description legitimately contains the bare word "worktree" right next
      // to "W020". A bare `worktree` probe can no longer tell that apart from
      // the stale isolation-check naming this guard exists for, so it narrows
      // to the literal config key (`use_worktrees`) the isolation warning is
      // actually about — the real W020 row's text never mentions that key.
      for (const rel of ['gsd-core/workflows/health.md', 'docs/CONFIGURATION.md', 'gsd-core/references/planning-config.md']) {
        const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
        assert.ok(text.includes('W025'), `${rel}: must document the worktrees warning as W025`);
        assert.ok(
          !/\bW020\b[^)]{0,120}use_worktrees/i.test(text),
          `${rel}: stale W020 reference for the worktrees warning`,
        );
      }
    });

    // Round 4 note: an earlier revision carried a W025-vs-src/verify.cts
    // namespace-collision test here that read verify.cts as raw text — the
    // source-grep shape RULESET.TESTS.delete-bad-tests says to delete, not
    // exempt. Deleted without a behavioral replacement: verify.cts exposes no
    // enumerable W-code registry to assert against, and building one is a
    // shared-module refactor outside this fix. The namespace claim lives as
    // guidance in health.md's error-codes note instead of as a fake test.

    test('the health.md error-codes table is not broken by the namespace note', () => {
      // The note was inserted BETWEEN two rows, which terminates the GFM table
      // and orphans the trailing row(s) into literal pipe-delimited text.
      // #3309: the hand-written "Note: the `W0NN` warning-code namespace..."
      // paragraph (and the `W025` row it sat under) is gone — `gen-health-docs.cjs`
      // now GENERATES this table from `RULES`, and deliberately excludes W025
      // (a workflow-layer diagnostic emitted by this file's own bash step, never
      // by `cmdValidateHealth`/`RULES` — see the generator's module header and its
      // `FOOTNOTE_PARAGRAPH`, which still names W025 for cross-reference). The
      // table's actual last row is now I010, not I001, and the footnote's own
      // opening sentence replaces the old namespace note. The hazard this test
      // guards — a footnote landing mid-table — still applies to the new content.
      const src = readWorkflow('health.md');
      const i001 = src.indexOf('| I001 |');
      const i010 = src.indexOf('| I010 |');
      const note = src.indexOf('Note: this table is **generated**');
      assert.ok(i001 > -1 && i010 > -1 && note > -1, 'health.md: expected I001, I010 and the generated-table note');
      assert.ok(i010 > i001, 'health.md: I010 row must follow the I001 row');
      assert.ok(
        note > i010,
        'health.md: the generated-table note must come AFTER the final table row — placing it between rows ends the table and orphans trailing rows',
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

// ─── #3706: OpenCode subagent effort (variant) + frontmatter escaping ────────
//
// `query resolve-execution` reported an effort (high/xhigh) that never reached
// OpenCode: the bake wrote `model:` and nothing else, so every subagent ran at
// whatever opencode.jsonc defaults the model to. The effort-side twin of #3705.
//
// bin/install.js has its own copy of these converters, but no `isAgent: true`
// call site: its agents install path runs through the compiled bin/lib module,
// not through its own copy. The live copy in src/runtime-artifact-conversion.cts
// (compiled to gsd-core/bin/lib/runtime-artifact-conversion.cjs) is therefore
// the one the bake actually uses, and the one under test here.
const liveConversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const OPENCODE_CONVERTERS = [['src (live bake)', liveConversion.convertClaudeToOpencodeFrontmatter]];
const KILO_CONVERTERS = [['src (live bake)', liveConversion.convertClaudeToKiloFrontmatter]];

describe('#3706: OpenCode agent variant (resolved effort)', () => {
  const AGENT = ['---', 'name: gsd-executor', 'description: x', 'model: sonnet', '---', '', 'Body.'].join('\n');
  const hasKey = (out, key) => new RegExp(`^${key}:`, 'm').test(out);

  for (const [label, convert] of OPENCODE_CONVERTERS) {
    test(`[${label}] emits variant alongside model`, () => {
      const out = convert(AGENT, {
        isAgent: true, modelOverride: 'synthetic/hf:zai-org/GLM-5.2', variant: 'high',
      });
      assert.match(out, /^model: synthetic\/hf:zai-org\/GLM-5\.2$/m);
      assert.match(out, /^variant: high$/m);
    });

    test(`[${label}] carries whatever level was resolved, not a fixed one`, () => {
      assert.match(convert(AGENT, { isAgent: true, variant: 'xhigh' }), /^variant: xhigh$/m);
    });

    test(`[${label}] omits the key entirely when no variant is supplied`, () => {
      // The control that keeps every existing install byte-identical.
      const out = convert(AGENT, { isAgent: true, modelOverride: 'M' });
      assert.ok(!hasKey(out, 'variant'), `expected no variant key, got:\n${out}`);
      assert.match(out, /^model: M$/m, 'the model side is unaffected');
    });

    test(`[${label}] commands get neither model nor variant`, () => {
      const out = convert(AGENT, { isAgent: false, modelOverride: 'M', variant: 'high' });
      assert.ok(!hasKey(out, 'variant'));
      assert.ok(!hasKey(out, 'model'));
    });

    test(`[${label}] adding a variant perturbs no other line`, () => {
      const withV = convert(AGENT, { isAgent: true, modelOverride: 'M', variant: 'high' });
      const without = convert(AGENT, { isAgent: true, modelOverride: 'M' });
      assert.match(withV, /^mode: subagent$/m);
      assert.deepEqual(
        withV.split('\n').filter((l) => !/^variant:/.test(l)),
        without.split('\n'),
      );
    });
  }

  for (const [label, convert] of KILO_CONVERTERS) {
    test(`[${label}] Kilo does NOT emit variant even when one is passed`, () => {
      // The asymmetry, pinned. EFFORT_ARGV declares surfaces for claude/opencode/
      // codex and has no kilo entry — unlike the model side, where #2794 J8
      // requires the two runtimes to resolve identically.
      const out = convert(AGENT, { isAgent: true, modelOverride: 'M', variant: 'high' });
      assert.ok(!hasKey(out, 'variant'), `kilo has no declared effort surface; got:\n${out}`);
      assert.match(out, /^model: M$/m, 'but the model override still applies');
    });
  }
});

// ─── #3706: config-supplied values cannot inject frontmatter keys ────────────
//
// `model:` and now `variant:` both interpolate values read from
// .planning/config.json / ~/.gsd/defaults.json. Raw interpolation let a value
// containing a newline inject additional TOP-LEVEL keys — proven by execution
// during the #3705 security review. The sink predates #3706; this change adds a
// SECOND write to it, so it is closed here rather than doubled.
describe('#3706: frontmatter values are escaped, not interpolated raw', () => {
  const AGENT = ['---', 'name: gsd-executor', 'description: x', '---', '', 'Body.'].join('\n');

  for (const [label, convert] of OPENCODE_CONVERTERS) {
    test(`[${label}] a newline-bearing model value cannot add top-level keys`, () => {
      const out = convert(AGENT, {
        isAgent: true, modelOverride: 'sonnet\ntools: ["*"]\npermission: bypass',
      });
      assert.ok(!/^tools:/m.test(out), `injected a tools key:\n${out}`);
      assert.ok(!/^permission: bypass$/m.test(out), `injected a permission key:\n${out}`);
      assert.match(out, /^model: "/m, 'the value is quoted');
    });

    test(`[${label}] a newline-bearing variant value cannot add top-level keys`, () => {
      const out = convert(AGENT, { isAgent: true, variant: 'high\nevil: yes' });
      assert.ok(!/^evil:/m.test(out), `injected a key:\n${out}`);
      assert.match(out, /^variant: "/m);
    });
  }

  for (const [label, convert] of KILO_CONVERTERS) {
    test(`[${label}] Kilo model values are escaped too — the same sink exists there`, () => {
      const out = convert(AGENT, { isAgent: true, modelOverride: 'sonnet\ntools: ["*"]' });
      assert.ok(!/^tools:/m.test(out), `injected a tools key:\n${out}`);
    });
  }
});

// ─── #3706: values that look plain but do not round-trip ────────────────────
//
// Matching /^[A-Za-z0-9._:\/@+-]+$/ is not the same question as "does YAML read
// this back as the exact string that went in". Each row below is wrong when
// emitted bare; the last is the control that keeps real installs unchanged.
describe('#3706: YAML-ambiguous scalars are quoted, not emitted bare', () => {
  const AGENT = ['---', 'name: gsd-executor', 'description: x', '---', '', 'Body.'].join('\n');

  const QUOTED = [
    // A PARSE ERROR bare, not merely ambiguous: '@' is a YAML reserved
    // indicator and may not open a plain scalar, so the whole agent file
    // becomes unreadable.
    '@org/model',
    // A trailing ':' reads as a nested mapping key — "bad indentation of a
    // mapping entry" kills the frontmatter.
    'foo:',
    // YAML 1.1 resolves these to booleans/null, so a variant named 'no'
    // arrives as `false` and matches no entry in the user's variants map.
    'no', 'yes', 'true', 'off', 'y', 'n', 'null',
    // '12:30' resolves to the integer 750; ':' is legal mid-identifier here,
    // so the form is reachable rather than contrived.
    '12:30', '0755', '1.5', '0x1f',
    // #3706 hardening: '(.+?)' in the value regex needs one character before
    // this fix, so an empty/whitespace-only value read as "key absent" rather
    // than "key present, value empty" — these are the YAML-ambiguous classes
    // that predicate missed once presence and value became distinct questions.
    '~', '.inf', '.Inf', '.nan', '+1', '-1', '-0', '+1.5', '.5', '0x1F',
    '2026-08-25', '2026-08-25T10:00:00Z', 'a: b', 'a #b',
  ];
  // The whole point of the predicate: no churn for anybody's existing files.
  const BARE = ['sonnet', 'synthetic/hf:zai-org/GLM-5.2', 'gpt-5.6-luna', 'claude-opus-5', 'x-', 'a.b', 'GLM-5.2'];

  for (const [label, convert] of OPENCODE_CONVERTERS) {
    const modelLine = (v) =>
      (convert(AGENT, { isAgent: true, modelOverride: v })
        .split('\n').find((l) => l.startsWith('model:')) ?? '');

    for (const v of QUOTED) {
      test(`[${label}] quotes ${JSON.stringify(v)}`, () => {
        assert.equal(modelLine(v), `model: "${v}"`);
      });
    }
    for (const v of BARE) {
      test(`[${label}] leaves ${JSON.stringify(v)} bare`, () => {
        assert.equal(modelLine(v), `model: ${v}`);
      });
    }
    test(`[${label}] the same predicate governs variant, not just model`, () => {
      assert.match(convert(AGENT, { isAgent: true, variant: 'no' }), /^variant: "no"$/m);
    });
  }
});

// ─── #3706: the threading seam — where the bug actually was ─────────────────
//
// Every test above exercises a converter directly. #3706 broke one layer up, in
// runtime-artifact-layout's convertedAgentsKind: the converter had no variant to
// write because nothing resolved or passed one. A converter-only suite goes green
// while the value still never arrives, so the resolve→render chain is pinned here.
describe('#3706: install-time effort resolves and renders for OpenCode', () => {
  const effortResolver = require('../gsd-core/bin/lib/install-effort-resolver.cjs');
  const catalog = require('../gsd-core/bin/lib/model-catalog.cjs');

  // Exactly the composition the layout performs per agent.
  const thread = (effortCfg, agentName) => {
    const universal = effortCfg ? effortResolver.resolveInstallTimeEffort(effortCfg, agentName) : null;
    return universal ? catalog.clampEffortForHost('opencode', universal) : null;
  };

  test('no effort config at all yields no variant', () => {
    // The gate. resolveInstallTimeEffort ALWAYS returns a level ('high' from the
    // catalog default) even for a null config, so gating on its return value
    // would stamp `variant:` into every existing OpenCode install.
    assert.equal(effortResolver.resolveInstallTimeEffort(null, 'gsd-executor'), 'high');
    assert.equal(thread(null, 'gsd-executor'), null);
  });

  test('a configured agent override reaches the emitted value', () => {
    assert.equal(thread({ agent_overrides: { 'gsd-executor': 'xhigh' } }, 'gsd-executor'), 'xhigh');
  });

  test('a configured default reaches an agent with no catalog tier', () => {
    // effort.default is only consulted for agents the tier ladder does not
    // answer for; see the tiered-agent test below for the other half.
    assert.equal(thread({ default: 'low' }, 'not-a-catalog-agent'), 'low');
  });

  test("'inherit' is never emitted as a literal", () => {
    // #3533 (10d): inherit means "omit the key and follow the host default" and
    // is not a wire level on ANY runtime. It IS a member of EFFORT_SET, so the
    // resolver returns it verbatim — the declared render seam is what drops it.
    // Writing `variant: inherit` would name a variant that cannot resolve.
    for (const cfg of [
      { agent_overrides: { 'gsd-executor': 'inherit' } },
      { routing_tier_defaults: { light: 'inherit', standard: 'inherit', heavy: 'inherit' } },
    ]) {
      assert.equal(effortResolver.resolveInstallTimeEffort(cfg, 'gsd-executor'), 'inherit');
      assert.equal(thread(cfg, 'gsd-executor'), null, `should omit for ${JSON.stringify(cfg)}`);
    }
  });

  test('a bare effort.default does NOT reach a tiered agent', () => {
    // Not obvious, and it is why the `inherit` case above goes through
    // agent_overrides instead: for an agent WITH a catalog tier the manifest
    // tier ladder (#3531) answers before effort.default is ever consulted, so
    // `default: 'inherit'` leaves a tiered agent at its tier value. Pinned
    // because a test written against `default` alone would assert nothing.
    assert.equal(effortResolver.resolveInstallTimeEffort({ default: 'inherit' }, 'gsd-executor'), 'high');
    assert.equal(thread({ default: 'inherit' }, 'gsd-executor'), 'high');
  });

  test('a level OpenCode does not accept is dropped, not emitted', () => {
    // 'ultra' is a real EFFORT_SET member that OpenCode's declared supported set
    // does not contain. Omitting beats naming a variant that cannot resolve.
    assert.equal(catalog.renderEffortArgv('opencode', 'ultra', 'argv').value, null);
  });

  test('the full universal ladder OpenCode does accept passes through', () => {
    for (const lvl of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(catalog.renderEffortArgv('opencode', lvl, 'argv').value, lvl);
    }
  });

  test('an empty model override omits the key rather than writing an empty value', () => {
    // Found by the property below, which originally asserted a round-trip for
    // every generated string and failed on "". An empty override is falsy, so
    // no `model:` line is written at all — that is the #2256/J7 contract (omit
    // the key, never `model: ""`), so the property is scoped to non-empty
    // values and the empty case is pinned here instead of being generated away.
    const out = liveConversion.convertClaudeToOpencodeFrontmatter(
      ['---', 'name: x', 'description: y', '---', '', 'Body.'].join('\n'),
      { isAgent: true, modelOverride: '' },
    );
    assert.ok(!/^model:/m.test(out), `expected no model key, got:\n${out}`);
  });

  test('every emitted model line parses back to the exact value', () => {
    // The real contract, stated directly: whatever a user puts in config, the
    // generated frontmatter must read back as that same string. A per-character
    // rule list is only a means to this end, and this is what catches the case
    // nobody thought to enumerate.
    const fc = require('fast-check');
    const yaml = require('js-yaml');
    const chars = ':@-_./"\\ \n\t#&*!|>%`{}[],?~+abcXY019';
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...chars.split('')), minLength: 1 }),
        (value) => {
          const out = liveConversion.convertClaudeToOpencodeFrontmatter(
            ['---', 'name: x', 'description: y', '---', '', 'Body.'].join('\n'),
            { isAgent: true, modelOverride: value },
          );
          const fmBody = /^---\r?\n([\s\S]*?)^---\r?$/m.exec(out)[1];
          return yaml.load(fmBody).model === value;
        },
      ),
      { numRuns: 2000 },
    );
  });
});

// ─── #3706: the layout seam actually threads the variant ─────────────────────
//
// Every test above calls a converter directly. Direct-converter tests all
// still pass if a future edit drops `variant` from the `rawConverter(...)`
// call inside runtime-artifact-layout.cts's convertedAgentsKind, or flips its
// `converterName ===` gate — this drives the REAL staging path
// (resolveRuntimeArtifactLayout -> the OpenCode 'agents' kind's stage()) so
// that regression cannot hide behind converter-only coverage.
describe('#3706: the layout seam actually threads the variant', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { cleanup } = require('./helpers.cjs');
  const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

  // Fixture layout mirrors the .gsd-source marker convention
  // (findAgentsSourceRoot): the marker at <configDir>/.gsd-source points to
  // <configDir>/commands/gsd, and agents/ is resolved as its sibling.
  function makeConfigDirFixture(agentContent) {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3706-seam-configdir-'));
    const commandsDir = path.join(configDir, 'commands', 'gsd');
    const agentsDir = path.join(configDir, 'agents');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), commandsDir + '\n', 'utf8');
    fs.writeFileSync(path.join(agentsDir, 'gsd-executor.md'), agentContent, 'utf8');
    return configDir;
  }

  function makeProjectRootWithEffort(effort) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3706-seam-project-'));
    fs.mkdirSync(path.join(projectRoot, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.planning', 'config.json'),
      JSON.stringify({ effort }),
      'utf8',
    );
    return projectRoot;
  }

  // resolveInstallTimeEffort also merges ~/.gsd/defaults.json (os.homedir()),
  // so HOME/USERPROFILE are pinned to an empty temp dir for the duration of
  // each stage() call to keep the assertion hermetic against the real
  // developer machine's home directory.
  function stageWithFakeHome(agentKind, resolvedProfile, agentCtx) {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3706-seam-home-'));
    const realHome = process.env.HOME;
    const realUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      return agentKind.stage(resolvedProfile, agentCtx);
    } finally {
      // On POSIX, USERPROFILE (and potentially HOME) is unset before this
      // helper runs — `process.env.X = undefined` would coerce to the
      // literal string "undefined" and leak that into the environment for
      // the rest of the test process. Restore by deletion when the saved
      // value was genuinely absent.
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      if (realUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = realUserProfile;
      cleanup(fakeHome);
    }
  }

  const AGENT_SOURCE = ['---', 'name: gsd-executor', 'description: x', '---', '', 'Body.'].join('\n');
  const resolvedProfile = { name: 'full', skills: '*', agents: new Set() };

  test('a configured effort reaches the real OpenCode agents kind staging output', () => {
    const configDir = makeConfigDirFixture(AGENT_SOURCE);
    const projectRoot = makeProjectRootWithEffort({ agent_overrides: { 'gsd-executor': 'xhigh' } });
    try {
      const layout = resolveRuntimeArtifactLayout('opencode', configDir, 'global');
      const agentKind = layout.kinds.find((k) => k.kind === 'agents');
      assert.ok(agentKind, 'opencode global layout must include an agents kind');

      const agentCtx = { runtime: 'opencode', pathPrefix: '', attribution: null, targetDir: projectRoot };
      const stagedDir = stageWithFakeHome(agentKind, resolvedProfile, agentCtx);
      const stagedContent = fs.readFileSync(path.join(stagedDir, 'gsd-executor.md'), 'utf8');
      assert.match(stagedContent, /^variant: xhigh$/m, `expected variant: xhigh in staged output:\n${stagedContent}`);
    } finally {
      cleanup(configDir);
      cleanup(projectRoot);
    }
  });

  test('no effort config at all reaches the real staging output with no variant key', () => {
    const configDir = makeConfigDirFixture(AGENT_SOURCE);
    const noConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3706-seam-noconfig-'));
    try {
      const layout = resolveRuntimeArtifactLayout('opencode', configDir, 'global');
      const agentKind = layout.kinds.find((k) => k.kind === 'agents');

      const agentCtx = { runtime: 'opencode', pathPrefix: '', attribution: null, targetDir: noConfigRoot };
      const stagedDir = stageWithFakeHome(agentKind, resolvedProfile, agentCtx);
      const stagedContent = fs.readFileSync(path.join(stagedDir, 'gsd-executor.md'), 'utf8');
      assert.doesNotMatch(stagedContent, /^variant:/m, `expected no variant key in staged output:\n${stagedContent}`);
    } finally {
      cleanup(configDir);
      cleanup(noConfigRoot);
    }
  });
});

describe('#3159: runtime conversion and projection of session-survivability dispatch', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  const { NON_CLAUDE_RUNTIMES } = conversion;
  const ALL_RUNTIMES = ['claude', ...NON_CLAUDE_RUNTIMES];

  const WORKFLOW_EXECUTE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
  const SESSION_DISPATCH_PATH = path.join(
    __dirname,
    '..',
    'gsd-core',
    'workflows',
    'execute-phase',
    'steps',
    'session-survivability-dispatch.md',
  );
  const ISOLATION_DISPATCH_PATH = path.join(
    __dirname,
    '..',
    'gsd-core',
    'workflows',
    'execute-phase',
    'steps',
    'executor-isolation-dispatch.md',
  );

  test('harness Agent dispatch retains configuration-gated literal background and awaited foreground branches across all runtimes', () => {
    const sessionSource = fs.readFileSync(SESSION_DISPATCH_PATH, 'utf8');

    for (const rt of ALL_RUNTIMES) {
      const out = conversion._applyRuntimeRewrites(sessionSource, rt, `$HOME/.${rt}/`, true, undefined);

      const trueIdx = out.indexOf('When `SESSION_OUTLIVES_TURN` is `true`');
      const falseIdx = out.indexOf('When `SESSION_OUTLIVES_TURN` is `false`');
      assert.ok(trueIdx !== -1, `${rt}: must have true branch in session survivability dispatch`);
      assert.ok(falseIdx !== -1, `${rt}: must have false branch in session survivability dispatch`);
      assert.ok(trueIdx < falseIdx, `${rt}: true branch must precede false branch`);

      const trueChunk = out.slice(trueIdx, falseIdx);
      assert.match(trueChunk, /run_in_background\s*=\s*true/);
      assert.doesNotMatch(trueChunk, /run_in_background\s*=\s*false/);

      const afterFalse = out.slice(falseIdx);
      const nextHeadingIdx = afterFalse.indexOf('\n## ');
      const falseChunk = nextHeadingIdx !== -1 ? afterFalse.slice(0, nextHeadingIdx) : afterFalse;
      assert.match(falseChunk, /run_in_background\s*=\s*false/);
      assert.match(falseChunk, /synchronously/i);
      assert.doesNotMatch(falseChunk, /run_in_background\s*=\s*true/);
    }
  });

  test('orchestrator-worktree backend preserves background spawn for true and synchronous wait for false across all runtimes', () => {
    const isolationSource = fs.readFileSync(ISOLATION_DISPATCH_PATH, 'utf8');

    for (const rt of ALL_RUNTIMES) {
      const out = conversion._applyRuntimeRewrites(isolationSource, rt, `$HOME/.${rt}/`, true, undefined);

      const trueIdx = out.indexOf('When it is `true`');
      const falseIdx = out.indexOf('When it is `false`');
      assert.ok(trueIdx !== -1, `${rt}: must have true branch in isolation dispatch`);
      assert.ok(falseIdx !== -1, `${rt}: must have false branch in isolation dispatch`);
      assert.ok(trueIdx < falseIdx, `${rt}: true branch must precede false branch`);

      const trueChunk = out.slice(trueIdx, falseIdx);
      assert.match(trueChunk, /background/i);
      assert.doesNotMatch(trueChunk, /synchronously/i);

      const afterFalse = out.slice(falseIdx);
      const periodIdx = afterFalse.indexOf('. The worktree');
      const falseChunk = periodIdx !== -1 ? afterFalse.slice(0, periodIdx) : afterFalse;
      assert.match(falseChunk, /synchronously/i);
      assert.match(falseChunk, /wait/i);
      assert.doesNotMatch(falseChunk, /background/i);

      assert.doesNotMatch(out, /workflow\.session_outlives_turn/, `${rt}: must consume resolved mode without re-querying config`);
    }
  });

  test('rejects runtime-name selector and verifies session survivability in verifier dispatch', () => {
    const sessionSource = fs.readFileSync(SESSION_DISPATCH_PATH, 'utf8');
    const isolationSource = fs.readFileSync(ISOLATION_DISPATCH_PATH, 'utf8');
    const executeWorkflow = fs.readFileSync(WORKFLOW_EXECUTE_PATH, 'utf8');

    // Negative assertion: session-survivability decision is not guarded by runtime name
    assert.doesNotMatch(sessionSource, /if\s*\[\s*"\$RUNTIME"|case\s*"\$RUNTIME"|RUNTIME\s*===/);
    assert.doesNotMatch(isolationSource, /if\s*\[\s*"\$RUNTIME"|case\s*"\$RUNTIME"|RUNTIME\s*===/);

    // Verifier dispatch carries session survivability guidance
    const verifierStepStart = executeWorkflow.indexOf('<step name="verify_phase_goal">');
    const verifierStepEnd = executeWorkflow.indexOf('</step>', verifierStepStart);
    assert.ok(verifierStepStart !== -1 && verifierStepEnd !== -1, 'verifier step must exist');
    const verifierStep = executeWorkflow.slice(verifierStepStart, verifierStepEnd);
    assert.match(verifierStep, /SESSION_OUTLIVES_TURN/);
    assert.match(verifierStep, /session-survivability-dispatch\.md/);

    // Verifier dispatch section in sessionSource preserves literal branches across all runtimes
    const verifierDispatchStart = sessionSource.indexOf('## verifier Agent dispatch');
    assert.ok(verifierDispatchStart !== -1, 'verifier dispatch section must exist in sessionSource');
    const verifierSource = sessionSource.slice(verifierDispatchStart);
    for (const rt of ALL_RUNTIMES) {
      const out = conversion._applyRuntimeRewrites(verifierSource, rt, `$HOME/.${rt}/`, true, undefined);
      const trueIdx = out.indexOf('When `SESSION_OUTLIVES_TURN` is `true`');
      const falseIdx = out.indexOf('When `SESSION_OUTLIVES_TURN` is `false`');
      assert.ok(trueIdx !== -1, `${rt}: must have true branch in verifier dispatch`);
      assert.ok(falseIdx !== -1, `${rt}: must have false branch in verifier dispatch`);
      assert.ok(trueIdx < falseIdx, `${rt}: true branch must precede false branch`);

      const trueChunk = out.slice(trueIdx, falseIdx);
      assert.match(trueChunk, /subagent_type="gsd-verifier"/);
      assert.match(trueChunk, /run_in_background\s*=\s*true/);
      assert.doesNotMatch(trueChunk, /run_in_background\s*=\s*false/);

      const falseChunk = out.slice(falseIdx);
      assert.match(falseChunk, /subagent_type="gsd-verifier"/);
      assert.match(falseChunk, /run_in_background\s*=\s*false/);
      assert.doesNotMatch(falseChunk, /run_in_background\s*=\s*true/);
    }

    // Isolation and worktree ownership remain intact
    assert.match(isolationSource, /worktree/i);
    assert.match(isolationSource, /cleanup/i);
  });
});

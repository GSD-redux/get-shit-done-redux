// allow-test-rule: source-text-is-the-product
// research agent .md content is the governed surface
// The 7 researcher agent .md files are the deployed AI agent definitions — their
// frontmatter and @-includes ARE what the runtime loads. Asserting on their content
// is asserting on the deployed contract, not the test author's source code.

'use strict';

/**
 * research-agent-profiles.test.cjs — drift guard for the 7 researcher agents.
 *
 * Behavioral contract (DEFECT.GENERATIVE-FIX):
 *   1. The profiles table covers exactly the 7 researcher agents (no missing, no extra).
 *   2. Every agent passes the profile check (frontmatter + includes + seam-calls +
 *      output-contract markers all match the profile).
 *   3. (DEFECT.GENERATIVE-FIX parity guard) Every provider id in PROVIDER_WATERFALL
 *      has a dispatch mapping in the Step-C section of BOTH seam-wired researcher agents.
 *   4. checkAgent returns a clear failure string for malformed profiles (not a thrown TypeError).
 *
 * If an agent's frontmatter/includes/seam-calls drift from its profile, this test fails.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { PROFILES, checkAgent } = require('../scripts/gen-research-agents.cjs');

const ROOT = path.resolve(__dirname, '..');

// The canonical set of 7 researcher agent names
const EXPECTED_AGENT_NAMES = new Set([
  'gsd-project-researcher',
  'gsd-phase-researcher',
  'gsd-advisor-researcher',
  'gsd-ai-researcher',
  'gsd-domain-researcher',
  'gsd-ui-researcher',
  'gsd-research-synthesizer',
]);

// ─── Profile coverage ─────────────────────────────────────────────────────────

describe('research-agent-profiles: coverage', () => {
  test('profiles covers exactly the 7 researcher agents — no missing agents', () => {
    const profileNames = new Set(PROFILES.map((p) => p.name));
    const missing = [];
    for (const name of EXPECTED_AGENT_NAMES) {
      if (!profileNames.has(name)) missing.push(name);
    }
    assert.deepEqual(
      missing,
      [],
      'These researcher agents are missing from PROFILES: ' + missing.join(', '),
    );
  });

  test('profiles covers exactly the 7 researcher agents — no extra agents', () => {
    const profileNames = PROFILES.map((p) => p.name);
    const extra = profileNames.filter((n) => !EXPECTED_AGENT_NAMES.has(n));
    assert.deepEqual(
      extra,
      [],
      'PROFILES contains unexpected agent names: ' + extra.join(', '),
    );
  });

  test('profiles contains exactly 7 entries', () => {
    assert.equal(
      PROFILES.length,
      7,
      'PROFILES should have 7 entries, got ' + PROFILES.length,
    );
  });
});

// ─── Per-agent parity check ───────────────────────────────────────────────────

describe('research-agent-profiles: parity', () => {
  for (const profile of PROFILES) {
    test(profile.name + ' matches its profile', () => {
      const agentPath = path.join(ROOT, 'agents', profile.name + '.md');
      assert.ok(
        fs.existsSync(agentPath),
        'Agent file not found: ' + agentPath,
      );

      const failures = checkAgent(profile);
      assert.deepEqual(
        failures,
        [],
        profile.name + ' has profile mismatches:\n' + failures.join('\n'),
      );
    });
  }
});

// ─── Provider dispatch parity (DEFECT.GENERATIVE-FIX) ────────────────────────
//
// Every provider id in PROVIDER_WATERFALL must have a dispatch mapping in the
// Step-C section of gsd-phase-researcher.md and gsd-project-researcher.md.
// This guard fails when code adds a new provider without updating the agents.

describe('research-agent-profiles: provider dispatch parity', () => {
  // The two seam-wired researcher agents that contain a Step-C dispatch table.
  const SEAM_AGENTS = ['gsd-phase-researcher', 'gsd-project-researcher'];

  // Load PROVIDER_WATERFALL from the compiled seam module.
  const { PROVIDER_WATERFALL } = require('../gsd-core/bin/lib/research-provider.cjs');

  // Compute the union of all provider ids across all waterfall kinds.
  const allProviderIds = new Set();
  for (const ids of Object.values(PROVIDER_WATERFALL)) {
    for (const id of ids) {
      allProviderIds.add(id);
    }
  }

  // Extract the Step-C section from an agent file.
  // We look for the section between "### Step C" and "### Step D".
  function extractStepC(agentPath) {
    const content = fs.readFileSync(agentPath, 'utf8');
    const stepCStart = content.indexOf('### Step C');
    if (stepCStart === -1) return '';
    const stepDStart = content.indexOf('### Step D', stepCStart);
    if (stepDStart === -1) return content.slice(stepCStart);
    return content.slice(stepCStart, stepDStart);
  }

  for (const agentName of SEAM_AGENTS) {
    for (const providerId of allProviderIds) {
      test(agentName + ' Step-C dispatch table covers provider: ' + providerId, () => {
        const agentPath = path.join(ROOT, 'agents', agentName + '.md');
        assert.ok(
          fs.existsSync(agentPath),
          'Agent file not found: ' + agentPath,
        );
        const stepC = extractStepC(agentPath);
        assert.ok(
          stepC.includes('`' + providerId + '`') || stepC.includes('"' + providerId + '"'),
          agentName + ' Step-C dispatch table is missing provider "' + providerId + '".\n' +
          'Add a row for this provider in the Step-C dispatch table.\n' +
          'Step-C section content:\n' + stepC,
        );
      });
    }
  }
});

// ─── checkAgent handles malformed profiles without throwing ──────────────────

describe('research-agent-profiles: checkAgent malformed profile', () => {
  test('checkAgent returns clear failure string when requiredSeamCalls is missing (not a thrown TypeError)', () => {
    const malformedProfile = {
      name: 'gsd-phase-researcher',
      description: 'some description',
      color: 'cyan',
      tools: 'Read',
      requiredIncludes: [],
      // requiredSeamCalls intentionally omitted
      outputContract: [],
    };

    let result;
    let threw = false;
    try {
      result = checkAgent(malformedProfile);
    } catch (err) {
      threw = true;
    }

    assert.ok(
      !threw,
      'checkAgent threw a TypeError instead of returning a failure string. ' +
      'Add array validation at the top of checkAgent().',
    );
    assert.ok(
      Array.isArray(result),
      'checkAgent should return an array, got: ' + typeof result,
    );
    // Should contain a clear failure message about the missing field
    const combined = result.join('\n');
    assert.ok(
      combined.includes('requiredSeamCalls') || combined.includes('missing required array field'),
      'checkAgent should return a message mentioning the missing field "requiredSeamCalls", got: ' + combined,
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-222-research-synthesizer-write-contract.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-222-research-synthesizer-write-contract (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #222)
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SYNTHESIZER_PATH = path.join(REPO_ROOT, 'agents', 'gsd-research-synthesizer.md');

function readSynthesizerPrompt() {
  return fs.readFileSync(SYNTHESIZER_PATH, 'utf8');
}

describe('bug #222: research synthesizer must write SUMMARY.md via Write tool', () => {
  test('step 6 has explicit hard-rule block forbidding return-message content fallback', () => {
    const prompt = readSynthesizerPrompt();

    assert.match(
      prompt,
      /canonical output of this agent[\s\S]*existing on disk after you return/i,
      'Step 6 must define SUMMARY.md-on-disk as canonical output.'
    );
    assert.match(
      prompt,
      /Hard rules \(must follow\):/i,
      'Step 6 must contain explicit hard rules block.'
    );
    assert.match(
      prompt,
      /Use the `Write` tool[\s\S]*there are no restrictions/i,
      'Rule 1 must force Write tool usage and reject hallucinated restrictions.'
    );
    assert.match(
      prompt,
      /Do NOT return the SUMMARY\.md content in your response/i,
      'Rule 2 must forbid returning SUMMARY content in the response body.'
    );
    assert.match(
      prompt,
      /Do NOT ask permission to write/i,
      'Rule 3 must forbid write-permission asks for this agent.'
    );
    assert.match(
      prompt,
      /Do NOT use `Bash\(cat << 'EOF'\)` or heredoc/i,
      'Rule 4 must forbid heredoc/Bash file creation fallback.'
    );
    assert.match(
      prompt,
      /If the Write tool errors[\s\S]*Do not silently fall back to returning content/i,
      'Rule 5 must force explicit error reporting for Write failures.'
    );
  });
});

describe('bug #222 recurrence: orchestrator self-heals when synthesizer returns SUMMARY.md inline', () => {
  const WORKFLOWS = [
    path.join(REPO_ROOT, 'gsd-core', 'workflows', 'new-project.md'),
    path.join(REPO_ROOT, 'gsd-core', 'workflows', 'new-milestone.md'),
  ];

  for (const wf of WORKFLOWS) {
    const name = path.basename(wf);

    test(`${name} has the #222 synthesizer SUMMARY.md self-heal guard`, () => {
      const text = fs.readFileSync(wf, 'utf8');

      // Marker tying the guard to the issue
      assert.match(text, /#222[^\n]*self-heal|self-heal[^\n]*#222/i,
        `${name} must contain a #222-tagged self-heal guard after the synthesizer returns.`);

      // Verifies the file exists AND is substantive/non-empty
      assert.match(text, /SUMMARY\.md[\s\S]{0,120}?(non-empty|substantive|exists)/i,
        `${name} must verify .planning/research/SUMMARY.md exists AND is substantive — non-empty.`);

      // Truncation/validator guard: references the continuation sentinel OR the verify-summary CLI
      assert.match(text, /gsd:write-continue|verify-summary/i,
        `${name} must guard against truncated/invalid SUMMARY.md (sentinel or verify-summary).`);

      // Self-heal must commit ALL research artifacts, not just SUMMARY.md
      assert.match(text, /--files \.planning\/research\//,
        `${name} self-heal must commit ALL research artifacts, not just SUMMARY.md.`);

      // Persists inline-returned document via Write rather than trusting the agent
      assert.match(text, /returned[\s\S]{0,200}?document[\s\S]{0,200}?Write tool/i,
        `${name} must instruct the orchestrator to persist inline-returned document with the Write tool.`);

      // Must not proceed to roadmapper against a missing or incomplete SUMMARY.md
      assert.match(text, /gsd-roadmapper[\s\S]{0,200}?(missing|incomplete|do NOT)/i,
        `${name} must block spawning gsd-roadmapper when SUMMARY.md is missing or incomplete.`);

      // Must name the FULL SUMMARY template markers so the orchestrator persists the real
      // document, not the brief structured return (resolves the HIGH finding).
      assert.match(text, /# Project Research Summary[\s\S]{0,260}?## Sources/,
        `${name}: self-heal must name the full SUMMARY.md template markers (# Project Research Summary … ## Sources).`);
      // Must reference the brief confirmation marker it must NOT mistake for file content.
      assert.match(text, /## SYNTHESIS COMPLETE/,
        `${name}: self-heal must distinguish the brief ## SYNTHESIS COMPLETE confirmation from the real document.`);
    });

    test(`${name} runs the #222 self-heal AFTER the synthesizer and BEFORE gsd-roadmapper`, () => {
      const text = fs.readFileSync(wf, 'utf8');
      const synthIdx = text.indexOf('subagent_type="gsd-research-synthesizer"');
      const healIdx = text.indexOf('Synthesizer output self-heal (#222)');
      const roadIdx = text.indexOf('subagent_type="gsd-roadmapper"');
      assert.ok(synthIdx >= 0, `${name}: synthesizer dispatch not found`);
      assert.ok(healIdx >= 0, `${name}: #222 self-heal block not found`);
      assert.ok(roadIdx >= 0, `${name}: gsd-roadmapper dispatch not found`);
      assert.ok(healIdx > synthIdx, `${name}: self-heal must come AFTER the synthesizer dispatch`);
      assert.ok(roadIdx > healIdx, `${name}: self-heal must come BEFORE the gsd-roadmapper dispatch`);
    });
  }
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2419-project-researcher-agent.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2419-project-researcher-agent (consolidation epic #1969 B7 #1976)", () => {
// allow-test-rule: source-text-is-the-product (see #2419)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Bug #2419: gsd-project-researcher agent type not found
 *
 * When gsd-new-project spawns gsd-project-researcher subagents, it fails with
 * "agent type not found" if the user has a local-only install (agents in
 * .claude/agents/ of a different project, not the global ~/.claude/agents/).
 *
 * Fix: new-project.md and new-milestone.md must parse agents_installed from
 * the init JSON and warn the user (rather than silently failing) when agents
 * are missing.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const NEW_PROJECT_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-project.md');
const NEW_MILESTONE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md');
const AGENTS_DIR = path.join(__dirname, '..', 'agents');

describe('gsd-project-researcher agent registration (#2419)', () => {
  test('gsd-project-researcher.md exists in agents source dir', () => {
    const agentFile = path.join(AGENTS_DIR, 'gsd-project-researcher.md');
    assert.ok(
      fs.existsSync(agentFile),
      'agents/gsd-project-researcher.md must exist in the source agents directory'
    );
  });

  test('gsd-project-researcher.md has correct name in frontmatter', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-project-researcher.md'), 'utf-8');
    assert.ok(
      content.includes('name: gsd-project-researcher'),
      'agents/gsd-project-researcher.md must have name: gsd-project-researcher in frontmatter'
    );
  });

  test('new-project.md parses agents_installed from init JSON', () => {
    const content = fs.readFileSync(NEW_PROJECT_PATH, 'utf-8');
    assert.ok(
      content.includes('agents_installed'),
      'new-project.md must parse agents_installed from the init JSON to detect missing agents'
    );
  });

  test('new-project.md warns user when agents_installed is false', () => {
    const content = fs.readFileSync(NEW_PROJECT_PATH, 'utf-8');
    assert.ok(
      content.includes('agents_installed') && content.includes('agent type not found') ||
      content.includes('agents_installed') && content.includes('missing') ||
      content.includes('agents_installed') && content.includes('not installed'),
      'new-project.md must warn the user when agents are not installed (agents_installed is false)'
    );
  });

  test('new-project.md reports required-agent and skill-payload diagnostics separately', () => {
    const content = fs.readFileSync(NEW_PROJECT_PATH, 'utf-8');
    assert.ok(content.includes('required_agents_installed'),
      'new-project.md must parse required_agents_installed from init JSON');
    assert.ok(content.includes('missing_required_agents'),
      'new-project.md must report missing required new-project agents separately');
    assert.ok(content.includes('agent_skill_payloads_available'),
      'new-project.md must distinguish skill payload availability from agent definitions');
    assert.ok(content.includes('agents_dir'),
      'new-project.md must show which agents directory was checked');
  });

  test('new-milestone.md parses agents_installed from init JSON', () => {
    const content = fs.readFileSync(NEW_MILESTONE_PATH, 'utf-8');
    assert.ok(
      content.includes('agents_installed'),
      'new-milestone.md must parse agents_installed from the init JSON to detect missing agents'
    );
  });

  test('new-milestone.md warns user when agents_installed is false', () => {
    const content = fs.readFileSync(NEW_MILESTONE_PATH, 'utf-8');
    assert.ok(
      content.includes('agents_installed') && (
        content.includes('agent type not found') ||
        content.includes('missing') ||
        content.includes('not installed')
      ),
      'new-milestone.md must warn the user when agents are not installed (agents_installed is false)'
    );
  });

  test('new-project.md lists gsd-project-researcher in available_agent_types', () => {
    const content = fs.readFileSync(NEW_PROJECT_PATH, 'utf-8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
    const agentTypesMatch = content.match(/<available_agent_types>([\s\S]*?)<\/available_agent_types>/);
    assert.ok(agentTypesMatch, 'new-project.md must have <available_agent_types> section');
    assert.ok(
      agentTypesMatch[1].includes('gsd-project-researcher'),
      'new-project.md <available_agent_types> must list gsd-project-researcher'
    );
  });

  test('new-milestone.md lists gsd-project-researcher in available_agent_types', () => {
    const content = fs.readFileSync(NEW_MILESTONE_PATH, 'utf-8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
    const agentTypesMatch = content.match(/<available_agent_types>([\s\S]*?)<\/available_agent_types>/);
    assert.ok(agentTypesMatch, 'new-milestone.md must have <available_agent_types> section');
    assert.ok(
      agentTypesMatch[1].includes('gsd-project-researcher'),
      'new-milestone.md <available_agent_types> must list gsd-project-researcher'
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2559-stale-search-year.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2559-stale-search-year (consolidation epic #1969 B8 #1977)", () => {
// allow-test-rule: source-text-is-the-product (see #2559)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Bug #2559: Stale document references in Research phase
 *
 * The gsd-phase-researcher and gsd-project-researcher agents instruct
 * WebSearch queries to always include "current year" (or a hardcoded
 * year). This biases results toward stale dated content as time passes
 * (e.g., a 2024 query run in 2026 returns stale results).
 *
 * Fix: Remove year-injection instructions from research agent
 * WebSearch guidance so searches return current results.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PHASE_RESEARCHER = path.join(
  __dirname,
  '..',
  'agents',
  'gsd-phase-researcher.md'
);
const PROJECT_RESEARCHER = path.join(
  __dirname,
  '..',
  'agents',
  'gsd-project-researcher.md'
);

const FILES = [
  { label: 'gsd-phase-researcher.md', path: PHASE_RESEARCHER },
  { label: 'gsd-project-researcher.md', path: PROJECT_RESEARCHER },
];

describe('research agents do not inject year into web searches (#2559)', () => {
  for (const { label, path: filePath } of FILES) {
    test(`${label} contains no CURRENT_YEAR placeholder`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(
        !/CURRENT_YEAR/.test(content),
        `${label} must not contain CURRENT_YEAR placeholder (causes stale-year injection)`
      );
    });

    test(`${label} contains no hardcoded year in web search instructions`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const match = content.match(/\b20(2[3-9]|[3-9]\d)\b/);
      assert.ok(
        !match,
        `${label} must not contain hardcoded year (found "${match && match[0]}") — biases searches toward stale content`
      );
    });

    test(`${label} does not instruct searches to include year or current year`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Match phrases like "include current year", "year in searches",
      // "[current year]", "with year", etc.
      const patterns = [
        /include\s+(?:the\s+)?current\s+year/i,
        /current\s+year/i,
        /year\s+in\s+(?:searches|queries)/i,
        /\[current year\]/i,
      ];
      for (const pat of patterns) {
        assert.ok(
          !pat.test(content),
          `${label} must not instruct year injection (matched /${pat.source}/)`
        );
      }
    });
  }
});
  });
}

// ---------------------------------------------------------------------------
// In-repo value provenance rule (#1699)
//
// The claim-provenance block governed EXTERNAL facts only (npm registry, official
// docs, Context7, package-name provenance). An in-repo discrete value could earn
// [VERIFIED] from training memory or a bare grep, drift into RESEARCH.md, be lifted
// into PLAN.md's <interfaces> by the planner, and fail at the executor's typecheck.
// These assert the governed prose contract on the deployed agent definition.
// ---------------------------------------------------------------------------

describe('gsd-phase-researcher in-repo value provenance rule (#1699)', () => {
  const agentPath = path.join(ROOT, 'agents', 'gsd-phase-researcher.md');
  const read = () => fs.readFileSync(agentPath, 'utf-8');

  test('names the in-repo discrete-value taxonomy the rule governs', () => {
    const content = read();
    for (const term of ['enum', 'error code', 'status constant', 'filesystem path']) {
      assert.ok(
        content.includes(term),
        `agent must name "${term}" as a governed in-repo discrete value`
      );
    }
  });

  test('requires the source-of-truth file to be opened with Read this session', () => {
    assert.match(
      read(),
      /opened the source-of-truth file with `Read` \*\*this session\*\*/,
      'agent must require a same-session Read of the source-of-truth file'
    );
  });

  test('requires both a path and a line range in the citation', () => {
    const content = read();
    assert.match(
      content,
      /Cite the path \*\*and line range\*\*/,
      'agent must require path AND line range, not a bare path'
    );
    assert.match(
      content,
      /\[VERIFIED: src\/types\/order\.ts:14-22\]/,
      'agent must carry a concrete path:line-range citation example'
    );
  });

  test('states that a codebase grep alone does not earn the tag', () => {
    assert.match(
      read(),
      /codebase `grep` is not sufficient on its own/,
      'agent must exclude bare grep, which only proves a string occurs'
    );
  });

  test('requires a verbatim quote and forbids paraphrase', () => {
    const content = read();
    assert.match(
      content,
      /quote the values \*\*verbatim\*\* in RESEARCH\.md beside the claim/,
      'the quote must land in RESEARCH.md, the researcher\'s own output'
    );
    assert.ok(
      content.includes('paraphrase is forbidden'),
      'agent must forbid paraphrase of in-repo discrete values'
    );
  });

  test('makes the quote the falsifiable artifact, not the citation (Goodhart guard)', () => {
    assert.match(
      read(),
      /a citation with no quote beside it does not earn `\[VERIFIED\]`/,
      'a precise-looking line range without a quote must not earn the tag'
    );
  });

  test('routes an unquoted skeleton value to [ASSUMED]', () => {
    assert.match(
      read(),
      /must also appear in that verbatim quote; a value that does not is `\[ASSUMED\]`/,
      'values used in examples but absent from the quote must degrade to [ASSUMED]'
    );
  });

  test('does not disturb the pre-existing package name provenance rule', () => {
    const content = read();
    assert.ok(
      content.includes('**Package name provenance rule:**'),
      'the sibling external-provenance rule must survive unchanged'
    );
    assert.ok(
      content.includes('a slopsquatted package also passes `npm view`'),
      'package-legitimacy reasoning must remain intact'
    );
  });

  test('defines the rule once — no paraphrased restatement (META.RULE.brief-no-paraphrase)', () => {
    const occurrences = read().split('In-repo value provenance rule').length - 1;
    assert.equal(
      occurrences,
      1,
      'the rule must be defined at exactly one site; a second copy is the prose-drift mode'
    );
  });
});

// ---------------------------------------------------------------------------
// Absent-evidence provenance rule (#2951)
//
// The two sibling rules above classify WHERE you looked. Neither classifies
// whether what you saw supports the claim you drew from it. Consulting PyPI and
// finding no `python_requires` and no per-minor classifier is a tool-confirmed
// observation from an authoritative source — it earns `[VERIFIED: PyPI]` under a
// plain reading of the base taxonomy. The negative conclusion ("ldap3 does not
// support 3.14") then rides into a locked CONTEXT.md decision on a tag that was
// honestly applied to the lookup. The claim was true of 3.14 and equally true of
// 3.12 and 3.13 — the versions the plan was standardizing ON — so the same
// evidence "proved" both, and a wrong interpreter downgrade shipped.
//
// An absence can be verified; the tag did not distinguish a verified absence from
// a verified constraint. These assert the governed prose contract on the deployed
// agent definition.
// ---------------------------------------------------------------------------

describe('gsd-phase-researcher absent-evidence provenance rule (#2951)', () => {
  const agentPath = path.join(ROOT, 'agents', 'gsd-phase-researcher.md');
  const read = () => fs.readFileSync(agentPath, 'utf-8');

  test('names the absent-metadata forms the rule governs', () => {
    const content = read();
    for (const term of ['`python_requires`', '`engines` field', 'per-version classifier', 'changelog entry', 'support matrix']) {
      assert.ok(
        content.includes(term),
        `agent must name "${term}" as a governed form of absent metadata`
      );
    }
  });

  test('states that absence is silence about every value, not a constraint on one', () => {
    const content = read();
    assert.ok(
      content.includes('Absence is silence about **every** value, not a constraint on one'),
      'the core proposition must be stated, not paraphrased'
    );
    assert.match(
      content,
      /says nothing about the version you want \*and\* nothing about the version you are standardizing on/,
      'the agent must spell out that the same absence "proves" both sides, which is why the ldap3 claim was worthless'
    );
  });

  test('refuses the tag however authoritative the consulted source was', () => {
    assert.ok(
      read().includes('however authoritative the source you consulted'),
      'source authority is what made the original claim pass review — it must be explicitly insufficient'
    );
  });

  test("keys on the evidence, not the claim's wording", () => {
    const content = read();
    assert.ok(
      content.includes('keys on the **evidence, not the wording**'),
      'a rule keyed on surface polarity is evaded by rephrasing'
    );
    assert.ok(
      content.includes('supports only up to 3.13'),
      'the agent must name the positive rephrasing as resting on the identical absence'
    );
  });

  test('rejects absence as evidence of support, not only of non-support', () => {
    assert.match(
      read(),
      /an absence is equally not evidence that the target \*is\* supported/,
      'the mirror-image error must be closed, or the rule licenses "no upper bound declared, so any version works"'
    );
  });

  test('leaves a present declared constraint earning [VERIFIED]', () => {
    const content = read();
    assert.ok(
      content.includes('A **present** constraint is the opposite case and is untouched'),
      'the rule targets MISSING fields, never merely unfavorable ones'
    );
    assert.ok(
      content.includes('`requires-python = ">=3.9,<3.12"` is a declared exclusion'),
      'a concrete present-constraint example must show what still earns the tag'
    );
  });

  test('leaves an affirmatively documented incompatibility on [CITED]', () => {
    assert.match(
      read(),
      /documentation stating the incompatibility affirmatively \(`\[CITED: …\]`\)/,
      'an affirmative statement about the world is not an absence and must keep its existing tag'
    );
  });

  test('licenses a positive falsification attempt as the route to [VERIFIED]', () => {
    const content = read();
    // Pinned as ONE joined sentence, not as independent substrings: the rule's whole
    // payoff is the TARGET of the route. A mutant swapping `[VERIFIED]` for `[CITED]`
    // or `[ASSUMED]` inverts the rule while leaving every separate phrase intact.
    assert.match(
      content,
      /The only route from an absence to `\[VERIFIED\]` is a \*\*positive falsification attempt\*\*/,
      'the route and the tag it reaches must be asserted together, or inverting the tag survives'
    );
    assert.ok(
      content.includes('run it against the real target'),
      'the probe must exercise the real target, not a proxy'
    );
  });

  test('makes the pasted failing output the artifact, not the claim of having run it', () => {
    const content = read();
    assert.ok(
      content.includes('**paste the failing output**'),
      'the output is the falsifiable artifact — mirrors the in-repo rule making the quote, not the citation, the artifact'
    );
    assert.ok(
      content.includes('asserting that you ran it does not earn the tag'),
      'an unpasted probe assertion is the box-ticking mode this rule exists to close'
    );
  });

  test('rejects a failure not attributable to the incompatibility', () => {
    assert.match(
      read(),
      // The parenthetical examples are illustrative; a copy-edit that swaps them must
      // not break this. Only the substantive clause is pinned.
      /a failure attributable to something else[^.]{0,80}is not a falsification/,
      'any-failure-will-do turns the probe requirement into a formality'
    );
  });

  test('refutes rather than downgrades a claim whose probe succeeds', () => {
    assert.match(
      read(),
      /A probe that \*succeeds\* refutes the claim: drop it rather than downgrade it/,
      'a disproved claim must leave RESEARCH.md entirely, not survive as [ASSUMED]'
    );
  });

  test('separates a failed lookup from a declared absence', () => {
    assert.match(
      read(),
      /When the lookup itself failed, report \*no observation\*, never a declared absence/,
      'an unobserved field must not be laundered into a declared-absent field'
    );
  });

  test('keeps [ASSUMED] available when a probe cannot be run', () => {
    assert.match(
      read(),
      /costs a confirmation checkpoint, not a blocked plan/,
      'a rule that demanded a feasible probe would become a gate that is routinely skipped'
    );
  });

  test('sits inside the claim-provenance block ahead of the [ASSUMED] routing sentence', () => {
    const content = read();
    const taxonomy = content.indexOf('**Claim provenance:**');
    const rule = content.indexOf('**Absent-evidence provenance rule:**');
    const routing = content.indexOf('Claims tagged `[ASSUMED]` signal to the planner and discuss-phase');
    assert.ok(taxonomy >= 0, 'the base claim-provenance taxonomy must still be present');
    assert.ok(rule >= 0, 'the absent-evidence rule must be present');
    assert.ok(routing >= 0, 'the [ASSUMED] routing sentence must still be present');
    assert.ok(
      taxonomy < rule && rule < routing,
      'the rule must follow the taxonomy it constrains and precede the routing sentence it terminates in — '
      + 'otherwise "routes into the existing [ASSUMED] path" is not true of the deployed ordering'
    );
  });

  test('distinguishes a bounding declaration from an allow-list that stops short', () => {
    const content = read();
    // The ldap3 class of case: classifiers present for some versions, absent for the
    // target. Without this, the absence clause and the present-constraint carve-out
    // give opposite verdicts on the same evidence and the rule cannot be applied.
    assert.ok(
      content.includes('whether the declaration bounds **every** value or only the ones it names'),
      'the rule must give a decision procedure for present-list-vs-absent-entry, not two conflicting readings'
    );
    assert.match(
      content,
      /an enumerated allow-list that stops short of your target[\s\S]{0,400}is still a governed absence/,
      'an allow-list missing the target version must stay a governed absence'
    );
    assert.ok(
      content.includes('unless the project states the list is exhaustive'),
      'the one condition that turns an allow-list into a real constraint must be named'
    );
    assert.match(
      content,
      /Reframing that silence as a positive finding[\s\S]{0,120}earns the same tag/,
      'the positive-reframing evasion must be closed explicitly, not left to inference'
    );
  });

  test('does not disturb the package name provenance rule', () => {
    const content = read();
    assert.ok(
      content.includes('**Package name provenance rule:**'),
      'the first sibling rule must survive unchanged'
    );
    assert.ok(
      content.includes('a slopsquatted package also passes `npm view`'),
      'package-legitimacy reasoning must remain intact'
    );
  });

  test('does not disturb the in-repo value provenance rule', () => {
    const content = read();
    assert.ok(
      content.includes('**In-repo value provenance rule:**'),
      'the second sibling rule must survive unchanged'
    );
    assert.match(
      content,
      /opened the source-of-truth file with `Read` \*\*this session\*\*/,
      'the same-session Read requirement must remain intact'
    );
  });

  test('defines the rule and its core proposition once each (META.RULE.brief-no-paraphrase)', () => {
    const content = read();
    // Counting the heading alone would miss the drift mode this guard is named for: the
    // same substance restated under a different heading. Pin the load-bearing sentence too.
    assert.equal(
      content.split('Absent-evidence provenance rule').length - 1,
      1,
      'the rule must be headed at exactly one site; a second copy is the prose-drift mode'
    );
    assert.equal(
      content.split('Absence is silence about **every** value').length - 1,
      1,
      'the core proposition must appear once; a restatement elsewhere is the drift this guards'
    );
  });
});

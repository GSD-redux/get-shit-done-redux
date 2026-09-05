// allow-test-rule: docs-parity
// allow-test-rule: source-text-is-the-product — settings-advanced.md prompt text is the deployed contract (#1216)
// Extracts CONFIG_DEFAULTS keys from config-loader.cjs source to verify planning-config.md
// stays in sync. The canonical list of defaults lives in source; there is no runtime
// API to enumerate them. Source inspection is the only practical parity check here.
// CONFIG_DEFAULTS was extracted from core.cjs into config-loader.cjs by ADR-857 phase 2e.

/**
 * Verify planning-config.md documents all config fields from source code.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitTableRow } = require('../gsd-core/bin/lib/markdown-table.cjs');

const REFERENCE_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'planning-config.md');
const CORE_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'config-loader.cjs');
const DOCS_CONFIG_PATH = path.join(__dirname, '..', 'docs', 'CONFIGURATION.md');
const CONFIG_SCHEMA_MANIFEST_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'bin',
  'shared',
  'config-schema.manifest.json',
);

/** Find the markdown table row whose first cell is `` `key` `` and return its cells. */
function tableRowForKey(content, key) {
  const target = `\`${key}\``;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = splitTableRow(line);
    if (cells[0] === target) return cells;
  }
  return null;
}

describe('config-field-docs', () => {
  let content;

  before(() => {
    content = fs.readFileSync(REFERENCE_PATH, 'utf-8');
  });

  test('contains Complete Field Reference section', () => {
    assert.ok(
      content.includes('## Complete Field Reference'),
      'planning-config.md must contain a "Complete Field Reference" heading'
    );
  });

  test('documents at least 15 config fields in tables', () => {
    // Count table rows that start with | `<key>` (field rows, not header/separator)
    const fieldRows = content.match(/^\| `[a-z_][a-z0-9_.]*` \|/gm);
    assert.ok(fieldRows, 'Expected markdown table rows with backtick-quoted keys');
    assert.ok(
      fieldRows.length >= 15,
      `Expected at least 15 documented fields, found ${fieldRows.length}`
    );
  });

  test('contains example configurations', () => {
    assert.ok(
      content.includes('## Example Configurations'),
      'planning-config.md must contain an "Example Configurations" section'
    );
    // Verify at least one JSON code block with a model_profile key
    assert.ok(
      content.includes('"model_profile"'),
      'Example configurations must include model_profile'
    );
  });

  test('contains field interactions section', () => {
    assert.ok(
      content.includes('## Field Interactions'),
      'planning-config.md must contain a "Field Interactions" section'
    );
  });

  test('every CONFIG_DEFAULTS key appears in the doc', () => {
    // Read CONFIG_DEFAULTS' actual keys straight from the module (moved from
    // core.cjs by ADR-857 phase 2e) instead of regex-parsing its source text.
    const { CONFIG_DEFAULTS } = require(CORE_PATH);
    assert.ok(CONFIG_DEFAULTS && typeof CONFIG_DEFAULTS === 'object', 'Could not find CONFIG_DEFAULTS export in config-loader.cjs');

    const keys = Object.keys(CONFIG_DEFAULTS);
    assert.ok(keys.length > 0, 'Could not extract any keys from CONFIG_DEFAULTS');

    // CONFIG_DEFAULTS uses flat keys; the doc may use namespaced equivalents.
    // Map flat keys to the namespace forms used in config.json and the doc.
    const NAMESPACE_MAP = {
      research: 'workflow.research',
      plan_checker: 'workflow.plan_check',
      verifier: 'workflow.verifier',
      nyquist_validation: 'workflow.nyquist_validation',
      ai_integration_phase: 'workflow.ai_integration_phase',
      api_coverage_gate: 'workflow.api_coverage_gate',
      text_mode: 'workflow.text_mode',
      subagent_timeout: 'workflow.subagent_timeout',
      branching_strategy: 'git.branching_strategy',
      phase_branch_template: 'git.phase_branch_template',
      milestone_branch_template: 'git.milestone_branch_template',
      quick_branch_template: 'git.quick_branch_template',
      security_enforcement: 'workflow.security_enforcement',
      security_asvs_level: 'workflow.security_asvs_level',
      security_block_on: 'workflow.security_block_on',
      inline_plan_threshold: 'workflow.inline_plan_threshold', // #3801
    };

    const missing = keys.filter(k => {
      // Check both bare key and namespaced form
      if (content.includes(`\`${k}\``)) return false;
      const ns = NAMESPACE_MAP[k];
      if (ns && content.includes(`\`${ns}\``)) return false;
      return true;
    });
    assert.deepStrictEqual(
      missing,
      [],
      `CONFIG_DEFAULTS keys missing from planning-config.md: ${missing.join(', ')}`
    );
  });

  test('documents workflow namespace fields', () => {
    const workflowFields = [
      'workflow.research',
      'workflow.plan_check',
      'workflow.verifier',
      'workflow.nyquist_validation',
      'workflow.use_worktrees',
      'workflow.subagent_timeout',
      'workflow.text_mode',
    ];
    const missing = workflowFields.filter(f => !content.includes(`\`${f}\``));
    assert.deepStrictEqual(
      missing,
      [],
      `Workflow fields missing from planning-config.md: ${missing.join(', ')}`
    );
  });

  test('documents git namespace fields', () => {
    const gitFields = [
      'git.branching_strategy',
      'git.base_branch',
      'git.phase_branch_template',
      'git.milestone_branch_template',
    ];
    const missing = gitFields.filter(f => !content.includes(`\`${f}\``));
    assert.deepStrictEqual(
      missing,
      [],
      `Git fields missing from planning-config.md: ${missing.join(', ')}`
    );
  });

  test('git.protected_branches canonical field has synchronized type and examples', () => {
    const manifest = JSON.parse(fs.readFileSync(CONFIG_SCHEMA_MANIFEST_PATH, 'utf-8'));
    assert.ok(
      manifest.validKeys.includes('git.protected_branches'),
      'config schema manifest must register git.protected_branches',
    );

    const publicDocs = fs.readFileSync(DOCS_CONFIG_PATH, 'utf-8');
    const references = [
      ['docs/CONFIGURATION.md', publicDocs],
      ['gsd-core/references/planning-config.md', content],
    ];
    const example = /"protected_branches"\s*:\s*\[\s*"develop"\s*,\s*"staging"\s*\]/;

    for (const [name, reference] of references) {
      const row = reference
        .split(/\r?\n/)
        .find((line) => line.startsWith('| `git.protected_branches` |'));
      assert.ok(row, `${name} must document the canonical git.protected_branches key`);
      assert.match(row, /array of non-empty strings/i,
        `${name} must document the non-empty string-array contract`);
      assert.match(row, /\| \(none\) \|/,
        `${name} must document that the optional field has no persisted default`);
      assert.match(reference, example,
        `${name} must show the synchronized multi-branch JSON example`);
      assert.match(reference, /extends the resolved base branch/i,
        `${name} must state that configured names extend the resolved base`);
      assert.match(reference, /execute-phase and ship/i,
        `${name} must name both advisory warning boundaries`);
      assert.match(reference, /does not\s+change\s+`git\.branching_strategy: "none"`/i,
        `${name} must preserve branching_strategy none behavior`);
      assert.match(reference, /exact branch name/i,
        `${name} must state that matching is by exact name`);
      assert.match(reference, /no glob or prefix/i,
        `${name} must say globs and prefixes are unsupported, so git-flow layouts enumerate`);
      assert.match(reference, /remaining names\s+still apply/i,
        `${name} must state that an invalid entry drops only itself`);
    }
  });

  test('documents KNOWN_TOP_LEVEL internal fields not in CONFIG_DEFAULTS', () => {
    // These fields are in KNOWN_TOP_LEVEL (core.cjs) and read by loadConfig()
    // but not in CONFIG_DEFAULTS, so the CONFIG_DEFAULTS test doesn't cover them.
    const internalFields = [
      'model_overrides',
      'agent_skills',
    ];
    const missing = internalFields.filter(f => !content.includes(`\`${f}\``));
    assert.deepStrictEqual(
      missing,
      [],
      `KNOWN_TOP_LEVEL internal fields missing from planning-config.md: ${missing.join(', ')}`
    );
  });

  test('agent_tools is registered in the central schema and public configuration docs (#4032)', () => {
    const manifest = JSON.parse(fs.readFileSync(CONFIG_SCHEMA_MANIFEST_PATH, 'utf-8'));
    assert.ok(manifest.validKeys.includes('agent_tools'),
      'agent_tools must be accepted by the central config schema');
    const selectorPattern = manifest.dynamicKeyPatterns.find((entry) => entry.topLevel === 'agent_tools');
    assert.ok(selectorPattern, 'agent_tools must register a dynamic selector pattern');
    assert.ok(new RegExp(selectorPattern.source).test('agent_tools.gsd-executor'));
    assert.ok(new RegExp(selectorPattern.source).test('agent_tools.*'));
    const publicDocs = fs.readFileSync(DOCS_CONFIG_PATH, 'utf-8');
    assert.ok(tableRowForKey(publicDocs, 'agent_tools.<selector>'),
      'agent_tools must have a public configuration table row');
    assert.match(publicDocs, /agents without a\s+`tools:` key inherit/i);
    assert.match(publicDocs, /Codex.*parent.*MCP servers.*sandbox_mode/is);
  });

  test('documents sub_repos field (CONFIG_DEFAULTS, no namespace form)', () => {
    // sub_repos is in CONFIG_DEFAULTS but has no NAMESPACE_MAP entry
    // (it uses a planning.sub_repos nested lookup but is documented as a
    // top-level field). Verify it explicitly since the NAMESPACE_MAP path
    // would silently skip it.
    assert.ok(
      content.includes('`sub_repos`'),
      'planning-config.md must document the sub_repos field'
    );
  });

  test('documents features.thinking_partner field', () => {
    // features.thinking_partner is in VALID_CONFIG_KEYS (config.cjs) and
    // used by discuss-phase.md and plan-phase.md for conditional extended
    // thinking at workflow decision points.
    assert.ok(
      content.includes('`features.thinking_partner`'),
      'planning-config.md must document the features.thinking_partner field'
    );
  });

  test('mode field documents correct allowed values', () => {
    // mode values are "interactive" and "yolo" per templates/config.json
    // and workflows/new-project.md — NOT "code-first"/"plan-first"/"hybrid"
    assert.ok(
      content.includes('"interactive"') && content.includes('"yolo"'),
      'mode field must document "interactive" and "yolo" as allowed values'
    );
    assert.ok(
      !content.includes('"code-first"'),
      'mode field must NOT document non-existent "code-first" value'
    );
  });

  test('discuss_mode field documents correct allowed values', () => {
    // discuss_mode values are "discuss" and "assumptions" per workflows/settings.md
    // NOT "auto" or "analyze" (those are CLI flags, not config values)
    assert.ok(
      content.includes('"assumptions"'),
      'discuss_mode must document "assumptions" as an allowed value'
    );
  });

  test('documents plan_checker alias for workflow.plan_check', () => {
    // plan_checker is the flat-key form in CONFIG_DEFAULTS; workflow.plan_check
    // is the canonical namespaced form. The doc should mention the alias.
    assert.ok(
      content.includes('`workflow.plan_check`'),
      'planning-config.md must document workflow.plan_check'
    );
    assert.ok(
      content.includes('plan_checker'),
      'planning-config.md must mention the plan_checker flat-key alias'
    );
  });

  test('workflow.test_command is documented in planning-config.md (#1216)', () => {
    assert.ok(
      content.includes('`workflow.test_command`'),
      'planning-config.md must document workflow.test_command'
    );
    // Must appear specifically in the Complete Field Reference section
    const completeRefSection = content.slice(content.indexOf('## Complete Field Reference'));
    assert.ok(
      completeRefSection.includes('`workflow.test_command`'),
      'planning-config.md Complete Field Reference must include workflow.test_command'
    );
  });

  test('workflow.build_command is documented in planning-config.md (#1216)', () => {
    assert.ok(
      content.includes('`workflow.build_command`'),
      'planning-config.md must document workflow.build_command'
    );
    // Must appear specifically in the Complete Field Reference section
    const completeRefSection = content.slice(content.indexOf('## Complete Field Reference'));
    assert.ok(
      completeRefSection.includes('`workflow.build_command`'),
      'planning-config.md Complete Field Reference must include workflow.build_command'
    );
  });
});

// ─── Capability-enum doc parity (#3303) ─────────────────────────────────────

describe('capability-enum doc parity (#3303)', () => {
  const CAPABILITY_PATH = path.join(
    __dirname, '..', 'capabilities', 'code-review', 'capability.json'
  );

  let docContent;
  let capability;

  before(() => {
    docContent = fs.readFileSync(REFERENCE_PATH, 'utf-8');
    capability = JSON.parse(fs.readFileSync(CAPABILITY_PATH, 'utf-8'));
  });

  /**
   * Extract a single Complete-Field-Reference table row by key and split it into
   * trimmed cells: ['', '`key`', type, default, allowedValues, description, ''].
   * Row-scoping keeps unrelated wording elsewhere in the doc from satisfying
   * (or breaking) the parity assertions.
   */
  function docRow(key) {
    const line = docContent
      .split(/\r?\n/)
      .find(l => l.startsWith(`| \`${key}\` |`));
    assert.ok(line, `planning-config.md must have a table row for \`${key}\``);
    return line.split('|').map(c => c.trim());
  }

  test('workflow.code_review_depth allowed values match the capability registry (#3303)', () => {
    const spec = capability.config && capability.config['workflow.code_review_depth'];
    assert.ok(
      spec && Array.isArray(spec.values),
      'capabilities/code-review/capability.json must declare workflow.code_review_depth values'
    );

    const allowedCell = docRow('workflow.code_review_depth')[4];
    const docValues = [...allowedCell.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    assert.ok(
      docValues.length > 0,
      `workflow.code_review_depth Allowed-Values cell must list quoted values, got: ${allowedCell}`
    );
    assert.deepStrictEqual(
      [...docValues].sort(),
      [...spec.values].sort(),
      `planning-config.md workflow.code_review_depth allowed values (${docValues.join(', ')}) ` +
        `must exactly match what config-set accepts per capability.json (${spec.values.join(', ')})`
    );
  });

  test('workflow.code_review_depth default matches the capability registry (#3303)', () => {
    const spec = capability.config && capability.config['workflow.code_review_depth'];
    assert.ok(spec, 'capability.json must declare workflow.code_review_depth');
    const defaultCell = docRow('workflow.code_review_depth')[3];
    const [docDefault] = [...defaultCell.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    assert.strictEqual(
      docDefault,
      spec.default,
      `planning-config.md workflow.code_review_depth default must match capability.json default (${spec.default})`
    );
  });

  test('agent_skills row documents the array-of-strings form (#3303)', () => {
    const cells = docRow('agent_skills');
    const allowedCell = cells[4];
    assert.ok(
      /\[\s*"<skill-set>"\s*,/.test(allowedCell),
      `agent_skills Allowed-Values cell must show the array-of-strings form, got: ${allowedCell}`
    );
    assert.ok(
      /array/i.test(cells[5]),
      'agent_skills description must explain the array form assigns multiple skill sets to one agent type'
    );
  });
});

// ─── CONFIGURATION.md parity (#1216) ────────────────────────────────────────

describe('CONFIGURATION.md parity (#1216)', () => {
  const DOCS_CONFIG_PATH = path.join(__dirname, '..', 'docs', 'CONFIGURATION.md');
  const SETTINGS_ADVANCED_PATH = path.join(
    __dirname,
    '..',
    'gsd-core',
    'workflows',
    'settings-advanced.md',
  );

  let docsContent;
  let settingsAdvancedContent;

  before(() => {
    docsContent = fs.readFileSync(DOCS_CONFIG_PATH, 'utf-8');
    settingsAdvancedContent = fs.readFileSync(SETTINGS_ADVANCED_PATH, 'utf-8');
  });

  test('CONFIGURATION.md workflow.subagent_timeout describes milliseconds, not seconds (#1216)', () => {
    assert.ok(
      docsContent.includes('millisecond') || docsContent.includes('milliseconds'),
      'CONFIGURATION.md workflow.subagent_timeout must use the word "millisecond(s)"'
    );
    const row = tableRowForKey(docsContent, 'workflow.subagent_timeout');
    assert.ok(row, 'CONFIGURATION.md must have a table row for workflow.subagent_timeout');
    assert.notEqual(
      row[2].replace(/`/g, ''),
      '600',
      'CONFIGURATION.md workflow.subagent_timeout default must not be 600 (that was the seconds default)'
    );
  });

  test('CONFIGURATION.md workflow.subagent_timeout default is 300000 (#1216)', () => {
    // Row-scoped: the actual table row for workflow.subagent_timeout must contain 300000
    const row = tableRowForKey(docsContent, 'workflow.subagent_timeout');
    assert.ok(row, 'CONFIGURATION.md must have a table row for workflow.subagent_timeout');
    assert.equal(
      row[2].replace(/`/g, ''),
      '300000',
      'CONFIGURATION.md workflow.subagent_timeout table row must have default 300000'
    );
  });

  test('settings-advanced.md subagent_timeout prompt says milliseconds, not seconds (#1216)', () => {
    assert.ok(
      settingsAdvancedContent.includes('millisecond') ||
        settingsAdvancedContent.includes('milliseconds'),
      'settings-advanced.md subagent_timeout prompt must use "millisecond(s)"'
    );
    assert.ok(
      !settingsAdvancedContent.includes('Integer number of seconds'),
      'settings-advanced.md must NOT say "Integer number of seconds" for subagent_timeout'
    );
  });

  test('settings-advanced.md subagent_timeout prompt default is 300000 not 600 (#1216)', () => {
    assert.ok(
      !settingsAdvancedContent.match(/value or 600/),
      'settings-advanced.md must NOT show 600 as the subagent_timeout default'
    );
    assert.ok(
      settingsAdvancedContent.includes('300000'),
      'settings-advanced.md must show 300000 as the subagent_timeout default'
    );
  });

  test('settings-advanced.md parse-default list must NOT show subagent_timeout default 600 (#1216)', () => {
    // Line 53 regression: the parse-default list item must use 300000, not 600
    assert.ok(
      !(/`workflow\.subagent_timeout`[^\r\n]*default:[^\n]*`?600`?/.test(settingsAdvancedContent)),
      'settings-advanced.md must NOT list subagent_timeout default as 600 (stale seconds default)'
    );
  });

  test('settings-advanced.md confirmation table must NOT label subagent_timeout as {seconds} (#1216)', () => {
    // Line 754 regression: the confirmation table row must say {milliseconds}, not {seconds}
    assert.ok(
      !(/workflow\.subagent_timeout\s*\|\s*\{seconds\}/.test(settingsAdvancedContent)),
      'settings-advanced.md confirmation table must NOT label subagent_timeout as {seconds}'
    );
  });

  test('settings-advanced.md bash example must NOT use subagent_timeout 900 (#1216)', () => {
    // Line 501 regression: the bash example must not show the stale 900 value
    assert.ok(
      !(/subagent_timeout 900\b/.test(settingsAdvancedContent)),
      'settings-advanced.md bash example must NOT set subagent_timeout to 900 (stale seconds value)'
    );
  });

  test('CONFIGURATION.md review.models rows do not show shell command examples (#1216)', () => {
    // The Integration Settings section (around line 195-202) used to have
    // shell-command examples like "codex exec --model gpt-5". After the fix
    // those rows must describe model ids, not full commands.
    assert.ok(
      !docsContent.includes('"codex exec --model'),
      'CONFIGURATION.md must NOT contain "codex exec --model" shell command example'
    );
    assert.ok(
      !docsContent.includes('"opencode run --model'),
      'CONFIGURATION.md must NOT contain "opencode run --model" shell command example'
    );
    assert.ok(
      !docsContent.includes('"gemini -m gemini'),
      'CONFIGURATION.md must NOT contain "gemini -m gemini..." shell command example'
    );
  });

  test('workflow.test_command is documented in CONFIGURATION.md (#1216)', () => {
    assert.ok(
      docsContent.includes('`workflow.test_command`'),
      'CONFIGURATION.md must document workflow.test_command'
    );
  });

  test('workflow.build_command is documented in CONFIGURATION.md (#1216)', () => {
    assert.ok(
      docsContent.includes('`workflow.build_command`'),
      'CONFIGURATION.md must document workflow.build_command'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1494-workflow-config-key-docs.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1494-workflow-config-key-docs (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Parity assertions for #1494: workflow config keys that are consumed by
 * planning-pipeline code must be (a) accepted by VALID_CONFIG_KEYS and
 * (b) documented in references/planning-config.md.
 *
 * Per DEFECT.GENERATIVE-FIX: a shared constant / key-list that spans two
 * surfaces requires a parity assertion that fails when the surfaces diverge.
 */

const { describe, test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const CONFIG_SCHEMA_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'config-schema.cjs');
const PLANNING_CONFIG_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'planning-config.md');

describe('VALID_CONFIG_KEYS parity — #1494 orphan-undocumented keys', () => {
  const { VALID_CONFIG_KEYS } = require(CONFIG_SCHEMA_PATH);

  test('workflow.mvp_mode is in VALID_CONFIG_KEYS', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.mvp_mode'),
      'workflow.mvp_mode is read by config-loader.cts and plan-phase.md but was missing from VALID_CONFIG_KEYS (#1494)'
    );
  });

  test('workflow.code_review_command is in VALID_CONFIG_KEYS', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.code_review_command'),
      'workflow.code_review_command must be in VALID_CONFIG_KEYS'
    );
  });

  test('workflow.plan_chunked is in VALID_CONFIG_KEYS', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.plan_chunked'),
      'workflow.plan_chunked must be in VALID_CONFIG_KEYS'
    );
  });

  test('workflow.test_command is in VALID_CONFIG_KEYS', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.test_command'),
      'workflow.test_command must be in VALID_CONFIG_KEYS'
    );
  });

  test('workflow.build_command is in VALID_CONFIG_KEYS', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.build_command'),
      'workflow.build_command must be in VALID_CONFIG_KEYS'
    );
  });
});

describe('config-set accepts workflow.mvp_mode (#1494)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) cleanup(tmpDir); });

  test('config-set workflow.mvp_mode true succeeds and stores the value', () => {
    tmpDir = createTempProject();
    const result = runGsdTools(['config-set', 'workflow.mvp_mode', 'true'], tmpDir);
    assert.ok(
      result.success,
      `config-set workflow.mvp_mode must succeed; got:\nstdout: ${result.output}\nstderr: ${result.error}`
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.updated, true, 'response must have updated:true');
    assert.strictEqual(parsed.key, 'workflow.mvp_mode', 'response must echo the key');
  });

  test('config-set workflow.mvp_mode false succeeds', () => {
    tmpDir = createTempProject();
    const result = runGsdTools(['config-set', 'workflow.mvp_mode', 'false'], tmpDir);
    assert.ok(
      result.success,
      `config-set workflow.mvp_mode false must succeed; got:\nstdout: ${result.output}\nstderr: ${result.error}`
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.updated, true);
  });
});

// allow-test-rule: source-text-is-the-product — planning-config.md is the deployed reference contract (#1494)
describe('planning-config.md documents #1494 keys', () => {
  let content;
  before(() => { content = fs.readFileSync(PLANNING_CONFIG_PATH, 'utf-8'); });

  const KEYS = [
    'workflow.mvp_mode',
    'workflow.code_review_command',
    'workflow.plan_chunked',
    'workflow.test_command',
    'workflow.build_command',
  ];

  for (const key of KEYS) {
    test(`planning-config.md documents \`${key}\``, () => {
      assert.ok(
        content.includes(`\`${key}\``),
        `planning-config.md must document \`${key}\` (#1494)`
      );
    });

    test(`\`${key}\` appears in the Complete Field Reference section`, () => {
      const refSection = content.slice(content.indexOf('## Complete Field Reference'));
      assert.ok(
        refSection.includes(`\`${key}\``),
        `planning-config.md Complete Field Reference must include \`${key}\` (#1494)`
      );
    });
  }
});
  });
}

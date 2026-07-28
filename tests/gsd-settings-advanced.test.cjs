// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


/**
 * Tests for `/gsd-settings-advanced` — power-user configuration command (#2528).
 *
 * Covers:
 *   - Command file exists with correct frontmatter
 *   - Workflow file exists with required section structure
 *   - Every field in the issue spec is rendered in the workflow with its default
 *   - Current values are pre-selected in prompts
 *   - Config merge preserves unrelated keys (sibling preservation)
 *   - Confirmation table is rendered after save
 *   - Every field is accepted by VALID_CONFIG_KEYS
 *   - /gsd-settings confirmation output advertises /gsd-settings-advanced
 *   - Negative: non-numeric value rejected for numeric field via config-set
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');
const fc = require('fast-check');

/** How far after a key mention the default may appear and still count as documenting it. */
const DEFAULT_PROXIMITY_WINDOW = 400;

/**
 * Is `defaultToken` documented near ANY occurrence of `key` in `workflow`?
 *
 * Scans every occurrence, not just the first (#2753). The contract this enforces is "the
 * workflow documents the default for this key". A first-occurrence search asserts something
 * narrower and different — "the FIRST mention of this key is followed by the default" — which
 * silently breaks the moment a workflow names a key in prose before its settings-table entry.
 * That is a normal thing for a workflow to do, and #2558 does it: a shared language directive
 * puts `response_language` at index 6 while the table documents `null` at 7185, so the check
 * failed on a document that was correct.
 *
 * Deliberately still forgiving about WHERE the evidence sits (any occurrence) and strict about
 * WHAT counts (the token inside a bounded window). Widening the window to the whole file would
 * pass on any unrelated occurrence of the token and gut the check; parsing the settings table
 * would couple this to table markup. Both rejected.
 *
 * @returns {{ok: boolean, occurrences: number, window: string}}
 *   `occurrences` is how many key occurrences were EXAMINED before deciding — not how many
 *   exist. The scan short-circuits on the first documenting window, so on success this is the
 *   1-based position of the match, and on failure it is the document's full count. That
 *   asymmetry is deliberate: the failure path is where the number has to be trustworthy, since
 *   "examined N, none documented it" is what distinguishes a genuine miss from the
 *   first-occurrence false negative this function exists to remove. `occurrences: 0` = key absent.
 */
function findDocumentedDefault(workflow, key, defaultToken, windowSize = DEFAULT_PROXIMITY_WINDOW) {
  let occurrences = 0;
  let lastWindow = '';
  // An empty needle would HANG this loop, not end it: String#indexOf('', pos) clamps to
  // str.length instead of returning -1, so `idx` stabilizes at the end and never goes
  // negative. Every SPEC_FIELDS key is non-empty today, which is exactly why this has to be
  // guarded rather than assumed.
  if (typeof key !== 'string' || key === '') {
    return { ok: false, occurrences: 0, window: '' };
  }
  // Advance by one char, not by key length: a key that overlaps itself or sits inside the
  // default token must still terminate.
  for (let idx = workflow.indexOf(key); idx >= 0; idx = workflow.indexOf(key, idx + 1)) {
    occurrences += 1;
    lastWindow = workflow.slice(idx, idx + windowSize);
    if (lastWindow.includes(defaultToken)) {
      return { ok: true, occurrences, window: lastWindow };
    }
  }
  return { ok: false, occurrences, window: lastWindow };
}

const ROOT = path.resolve(__dirname, '..');
// #2790: settings-advanced.md was consolidated into config.md as the --advanced flag.
const COMMAND_PATH = path.join(ROOT, 'commands', 'gsd', 'config.md');
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'settings-advanced.md');
const SETTINGS_WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'settings.md');

// ─── Spec — every field the advanced command must expose ──────────────────────

const SPEC_FIELDS = {
  planning: [
    { key: 'workflow.plan_bounce',           default: 'false' },
    { key: 'workflow.plan_bounce_passes',    default: '2' },
    { key: 'workflow.plan_bounce_script',    default: 'null' },
    { key: 'workflow.subagent_timeout',      default: '300000' },
    { key: 'workflow.inline_plan_threshold', default: '3' },
  ],
  execution: [
    { key: 'workflow.node_repair',        default: 'true' },
    { key: 'workflow.node_repair_budget', default: '2' },
    { key: 'workflow.auto_prune_state',   default: 'false' },
  ],
  discussion: [
    { key: 'workflow.max_discuss_passes', default: '3' },
  ],
  cross_ai: [
    { key: 'workflow.cross_ai_execution', default: 'false' },
    { key: 'workflow.cross_ai_command',   default: 'null' },
    { key: 'workflow.cross_ai_timeout',   default: '300' },
  ],
  git: [
    { key: 'git.base_branch',                default: 'main' },
    { key: 'git.phase_branch_template',      default: 'gsd/phase-{phase}-{slug}' },
    { key: 'git.milestone_branch_template',  default: 'gsd/{milestone}-{slug}' },
  ],
  runtime: [
    { key: 'response_language',     default: 'null' },
    { key: 'context_window',        default: '200000' },
    { key: 'search_gitignored',     default: 'false' },
    { key: 'graphify.build_timeout', default: '300' },
  ],
};

const ALL_SPEC_KEYS = Object.values(SPEC_FIELDS).flat().map((f) => f.key);

// ─── File existence + frontmatter ─────────────────────────────────────────────

describe('gsd-settings-advanced — file scaffolding', () => {
  test('consolidated config.md command exists (#2790: settings-advanced absorbed)', () => {
    assert.ok(fs.existsSync(COMMAND_PATH), `missing ${COMMAND_PATH}`);
  });

  test('workflow file exists at gsd-core/workflows/settings-advanced.md', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), `missing ${WORKFLOW_PATH}`);
  });

  test('command frontmatter has name, description, allowed-tools', () => {
    const text = fs.readFileSync(COMMAND_PATH, 'utf-8');
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fmMatch, 'command file missing frontmatter block');
    const fm = fmMatch[1];
    assert.match(fm, /name:\s*gsd:config/, 'frontmatter missing name (gsd:config)');
    assert.match(fm, /description:\s*\S/, 'frontmatter missing non-empty description');
    assert.match(fm, /allowed-tools:/, 'frontmatter missing allowed-tools');
  });

  test('command routes to the settings-advanced workflow via --advanced flag', () => {
    const text = fs.readFileSync(COMMAND_PATH, 'utf-8');
    assert.ok(
      text.includes('workflows/settings-advanced.md') || text.includes('--advanced'),
      'config.md must reference settings-advanced workflow or --advanced flag'
    );
  });
});

// ─── Workflow content — sections and fields ───────────────────────────────────

describe('gsd-settings-advanced — workflow structure', () => {
  let workflow;
  try {
    workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  } catch { workflow = ''; }

  const requiredSteps = [
    'ensure_and_load_config',
    'read_current',
    'present_settings',
    'update_config',
    'confirm',
  ];
  for (const step of requiredSteps) {
    test(`workflow defines <step name="${step}">`, () => {
      assert.ok(
        workflow.includes(`<step name="${step}">`),
        `workflow missing step ${step}`
      );
    });
  }

  const requiredSections = [
    'Planning Tuning',
    'Execution Tuning',
    'Discussion Tuning',
    'Cross-AI Execution',
    'Git Customization',
    'Runtime / Output',
  ];
  for (const section of requiredSections) {
    test(`workflow renders section "${section}"`, () => {
      assert.ok(
        workflow.includes(section),
        `workflow missing section heading "${section}"`
      );
    });
  }

  for (const field of Object.values(SPEC_FIELDS).flat()) {
    test(`workflow mentions key \`${field.key}\``, () => {
      assert.ok(
        workflow.includes(field.key),
        `workflow missing field ${field.key}`
      );
    });
    test(`workflow documents default for \`${field.key}\` (${field.default})`, () => {
      // Proximity search across EVERY occurrence of the key, not just the first (#2753).
      const found = findDocumentedDefault(workflow, field.key, field.default);
      assert.ok(found.occurrences > 0, `key ${field.key} not found`);
      assert.ok(
        found.ok,
        `default "${field.default}" not found within ${DEFAULT_PROXIMITY_WINDOW} chars of any ` +
        `of the ${found.occurrences} occurrence(s) of key ${field.key}. Last window:\n${found.window}`
      );
    });
  }

  test('workflow pre-selects current values from loaded config', () => {
    assert.match(
      workflow,
      /pre-selected|current value|Current:/i,
      'workflow must document that current values are pre-selected'
    );
  });

  test('confirmation step renders a table with saved settings', () => {
    const confirmStart = workflow.indexOf('<step name="confirm">');
    assert.ok(confirmStart >= 0, 'confirm step missing');
    const confirmBlock = workflow.slice(confirmStart);
    assert.ok(
      confirmBlock.includes('|') && /\|[^\n]*Setting[^\n]*\|/.test(confirmBlock),
      'confirm step must render a markdown table with a Setting column'
    );
  });

  test('update_config step describes merge-preserving-siblings behavior', () => {
    assert.match(
      workflow,
      /(preserv(e|ing) (unrelated|sibling)|do not clobber|merge .*existing|...existing_config)/i,
      'update_config step must describe preserving unrelated keys'
    );
  });
});

// ─── VALID_CONFIG_KEYS membership ─────────────────────────────────────────────

describe('gsd-settings-advanced — VALID_CONFIG_KEYS coverage', () => {
  for (const key of ALL_SPEC_KEYS) {
    test(`VALID_CONFIG_KEYS contains "${key}"`, () => {
      assert.ok(
        VALID_CONFIG_KEYS.has(key),
        `VALID_CONFIG_KEYS missing ${key} — add it to gsd-core/bin/lib/config-schema.cjs`
      );
    });
  }
});

// ─── /gsd-settings mentions /gsd-settings-advanced ────────────────────────────

describe('/gsd-settings advertises /gsd-settings-advanced', () => {
  test('settings workflow mentions canonical /gsd-config --advanced', () => {
    const text = fs.readFileSync(SETTINGS_WORKFLOW_PATH, 'utf-8');
    assert.ok(
      text.includes('/gsd:config --advanced'),
      'gsd-core/workflows/settings.md must mention /gsd:config --advanced'
    );
    assert.ok(
      !text.includes('gsd-settings-advanced') && !text.includes('gsd:settings-advanced'),
      'gsd-core/workflows/settings.md must not mention legacy /gsd-settings-advanced variants'
    );
  });
});

// ─── Sibling-preservation via config-set ──────────────────────────────────────

describe('gsd-settings-advanced — config merge preserves unrelated keys', () => {
  test('setting workflow.plan_bounce_passes does not clobber model_profile or git.branching_strategy', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // Seed config
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const initial = {
      model_profile: 'quality',
      git: {
        branching_strategy: 'phase',
        phase_branch_template: 'feature/{phase}-{slug}',
      },
      workflow: {
        research: true,
        plan_check: false,
      },
      hooks: {
        context_warnings: true,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(initial, null, 2), 'utf-8');

    const result = runGsdTools(
      ['config-set', 'workflow.plan_bounce_passes', '5'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `config-set failed: ${result.error || result.output}`);

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(updated.model_profile, 'quality', 'model_profile clobbered');
    assert.strictEqual(updated.git.branching_strategy, 'phase', 'git.branching_strategy clobbered');
    assert.strictEqual(updated.git.phase_branch_template, 'feature/{phase}-{slug}', 'git.phase_branch_template clobbered');
    assert.strictEqual(updated.workflow.research, true, 'workflow.research clobbered');
    assert.strictEqual(updated.workflow.plan_check, false, 'workflow.plan_check clobbered');
    assert.strictEqual(updated.hooks.context_warnings, true, 'hooks.context_warnings clobbered');
    assert.strictEqual(updated.workflow.plan_bounce_passes, 5, 'new value not written');
  });

  test('setting context_window preserves existing top-level keys', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      model_profile: 'balanced',
      response_language: 'Japanese',
      search_gitignored: true,
    }, null, 2));

    const result = runGsdTools(
      ['config-set', 'context_window', '1000000'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `config-set context_window failed: ${result.error || result.output}`);

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(updated.context_window, 1000000);
    assert.strictEqual(updated.model_profile, 'balanced');
    assert.strictEqual(updated.response_language, 'Japanese');
    assert.strictEqual(updated.search_gitignored, true);
  });
});

// ─── Negative: non-numeric for numeric field / unknown key rejected ───────────

describe('gsd-settings-advanced — negative scenarios', () => {
  test('config-set rejects an unknown key with a helpful error', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'workflow.no_such_knob_at_all', 'true'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(!result.success, 'config-set should reject unknown keys');
    const combined = (result.error || '') + (result.output || '');
    assert.match(combined, /Unknown config key/i);
  });

  test('workflow.subagent_timeout numeric input is coerced and stored as Number', (t) => {
    // The config-set parser coerces numeric-looking strings to Number.
    // This test locks in the coercion so users can't accidentally save
    // a string for a numeric knob. A non-numeric string would be stored
    // verbatim — we assert the parser prefers Number for numeric literals.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, '{}');

    const okNum = runGsdTools(
      ['config-set', 'workflow.subagent_timeout', '900'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(okNum.success);
    const c1 = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(typeof c1.workflow.subagent_timeout, 'number');
    assert.strictEqual(c1.workflow.subagent_timeout, 900);
  });

  test('workflow documents numeric-input rejection for non-numeric answers', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.match(
      workflow,
      /(non-numeric|must be a number|integer|numeric input|re-?prompt)/i,
      'workflow must document how non-numeric input is handled for numeric fields'
    );
  });

  // Behavioral coverage for numeric-key inputs at the config-set boundary.
  // The /gsd-settings-advanced workflow promises non-numeric input is never
  // silently coerced — that promise is enforced by the AskUserQuestion
  // re-prompt loop in the workflow runner, not by config-set itself. The
  // CLI parser passes numeric-looking strings through Number() and stores
  // anything else verbatim. These tests lock in both behaviors so a future
  // regression that changes either layer surfaces immediately.
  test('config-set on a numeric key stores non-numeric input verbatim as string (workflow layer must reject before reaching here)', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, '{}');

    const result = runGsdTools(
      ['config-set', 'workflow.subagent_timeout', 'not-a-number'],
      tmpDir,
      { HOME: tmpDir }
    );
    // The CLI layer accepts the write — type validation lives in the
    // /gsd-settings-advanced workflow. If a future change adds a numeric
    // type-check at config-set, flip this assertion to !result.success.
    assert.ok(result.success, `config-set should accept the raw value at the CLI boundary: ${result.error || result.output}`);
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(
      typeof stored.workflow.subagent_timeout,
      'string',
      'non-numeric input on a numeric key currently lands as a string at the CLI boundary'
    );
    assert.strictEqual(stored.workflow.subagent_timeout, 'not-a-number');
  });

  test('config-set on a numeric key coerces a numeric string to Number (parser invariant)', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, '{}');

    const result = runGsdTools(
      ['config-set', 'workflow.max_discuss_passes', '7'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `config-set failed: ${result.error || result.output}`);
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(typeof stored.workflow.max_discuss_passes, 'number');
    assert.strictEqual(stored.workflow.max_discuss_passes, 7);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2506-settings-profile-nonclaude-warning.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2506-settings-profile-nonclaude-warning (consolidation epic #1969 B4 #1973)", () => {
/**
 * Regression test for bug #2506
 *
 * /gsd-settings presents Quality/Balanced/Budget model profiles without any
 * warning that on non-Claude runtimes (Codex, Gemini CLI, etc.) these profiles
 * select Claude model tiers and have no effect on actual agent model selection.
 *
 * Fix: settings.md must include a non-Claude runtime note instructing users to
 * use "Inherit" or configure model_overrides manually, and the Inherit option
 * description must explicitly call out non-Claude runtimes.
 *
 * Closes: #2506
 */

'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'settings.md');

describe('bug #2506: settings.md non-Claude runtime warning for model profiles', () => {
  let content;

  before(() => {
    content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
  });

  test('settings.md contains a non-Claude runtime note for model profiles', () => {
    assert.ok(
      content.includes('non-Claude runtime') || content.includes('non-Claude runtimes'),
      'settings.md must include a note about non-Claude runtimes and model profiles'
    );
  });

  test('non-Claude note explains profiles are no-ops without model_overrides', () => {
    assert.ok(
      content.includes('model_overrides') || content.includes('no effect'),
      'note must explain profiles have no effect on non-Claude runtimes without model_overrides'
    );
  });

  test('Inherit option description explicitly mentions non-Claude runtimes', () => {
    // The Inherit option in AskUserQuestion must call out non-Claude runtimes
    const inheritOptionMatch = content.match(/label:\s*"Inherit"[^}]*description:\s*"([^"]+)"/s);
    assert.ok(inheritOptionMatch, 'Inherit option with label/description must exist in settings.md');
    const desc = inheritOptionMatch[1];
    assert.ok(
      desc.includes('non-Claude') || desc.includes('Codex') || desc.includes('Gemini'),
      `Inherit option description must mention non-Claude runtimes; got: "${desc}"`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3784-gsd-settings-model-profile-ui-omits-adaptive.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3784-gsd-settings-model-profile-ui-omits-adaptive (consolidation epic #1969 B4 #1973)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #3784)
// The deployed settings.md IS the product — testing its text content tests the deployed contract.

/**
 * Regression test for bug #3784
 *
 * /gsd-settings model profile UI omits `adaptive`. The AskUserQuestion block
 * for model_profile in settings.md lists only four options (Quality, Balanced,
 * Budget, Inherit) but the settings schema registers five valid profiles:
 * quality, balanced, budget, adaptive, inherit. The `adaptive` profile is
 * reachable by name via `gsd:config --profile adaptive` but cannot be selected
 * interactively through `/gsd:settings`.
 *
 * Root cause: the options array in the model-profile AskUserQuestion block was
 * written before the `adaptive` profile was introduced and was never updated.
 * Because AskUserQuestion enforces a hard 4-option cap, the fix uses a two-
 * question split: Q1 asks "Standard tier or Adaptive?" (2 options); if the
 * user picks Standard, Q2 asks which of the three standard profiles to use
 * (Quality, Balanced, Budget). This keeps every call within the 4-option cap
 * while making all five profiles reachable.
 *
 * Fixes: #3784
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'settings.md');

/**
 * Extract all AskUserQuestion option labels from a text block.
 * Returns them lowercased for case-insensitive comparison.
 */
function extractOptionLabels(block) {
  const labelPattern = /label:\s*"([^"]+)"/g;
  const labels = [];
  let match;
  while ((match = labelPattern.exec(block)) !== null) {
    labels.push(match[1].toLowerCase());
  }
  return labels;
}

describe('bug #3784: settings.md model profile UI exposes all 5 profiles', () => {
  let content;
  let presentBlock;

  before(() => {
    content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const presentMatch = content.match(/<step name="present_settings">[\s\S]*?<\/step>/);
    assert.ok(presentMatch, 'settings.md must have a present_settings step');
    presentBlock = presentMatch[0];
  });

  // ── Core contract: all five valid profiles reachable via the settings UI ──

  test('present_settings step includes Adaptive as a selectable option (#3784)', () => {
    // This is the primary assertion for bug #3784 — adaptive was missing.
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'adaptive' || l.startsWith('adaptive')),
      [
        'Bug #3784: present_settings step must include an "Adaptive" label in',
        'its model profile AskUserQuestion options so users can select it',
        `interactively. Got labels: [${labels.join(', ')}]`,
      ].join(' ')
    );
  });

  test('present_settings step includes Quality as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'quality' || l.startsWith('quality')),
      `present_settings step must include a "Quality" option. Got: [${labels.join(', ')}]`
    );
  });

  test('present_settings step includes Balanced as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'balanced' || l.startsWith('balanced')),
      `present_settings step must include a "Balanced" option. Got: [${labels.join(', ')}]`
    );
  });

  test('present_settings step includes Budget as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'budget' || l.startsWith('budget')),
      `present_settings step must include a "Budget" option. Got: [${labels.join(', ')}]`
    );
  });

  test('present_settings step includes Inherit as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'inherit' || l.startsWith('inherit')),
      `present_settings step must include an "Inherit" option. Got: [${labels.join(', ')}]`
    );
  });

  // ── update_config step writes adaptive as a valid value ──

  test('update_config step lists adaptive as a valid model_profile value', () => {
    const updateMatch = content.match(/<step name="update_config">[\s\S]*?<\/step>/);
    assert.ok(updateMatch, 'settings.md must have an update_config step');
    const block = updateMatch[0];
    assert.ok(
      block.includes('adaptive'),
      'update_config step must list "adaptive" as a valid model_profile value'
    );
  });

  // ── confirm step displays adaptive as a possible profile value ──

  test('confirm step table shows adaptive as a possible model profile value', () => {
    const confirmMatch = content.match(/<step name="confirm">[\s\S]*?<\/step>/);
    assert.ok(confirmMatch, 'settings.md must have a confirm step');
    const block = confirmMatch[0];
    assert.ok(
      block.includes('adaptive'),
      'confirm step must include "adaptive" in the Model Profile row placeholder'
    );
  });

  // ── adaptive described with role-based routing semantics ──

  test('settings.md describes adaptive profile with role-based routing semantics', () => {
    // Adaptive uses heavy/light role tiers per routingTier.
    // The UI description must convey role-based cost optimization and the heavy/light tier
    // split — not just mention "Adaptive" somewhere (that word appears 6+ times in the file).
    const lower = content.toLowerCase();
    assert.ok(
      lower.includes('role-based cost optimization') && lower.includes('heavy roles'),
      'settings.md must describe the adaptive profile with "role-based cost optimization" and "heavy roles" wording so the description is meaningful across all supported runtimes'
    );
  });

  // ── 4-option cap enforcement ──

  test('each question object in present_settings AskUserQuestion blocks has at most 4 options (AskUserQuestion runtime cap)', () => {
    // The AskUserQuestion runtime enforces a hard 4-option cap per individual question object
    // (each { question:..., options:[...] } entry). This test guards against a naïve revert
    // that puts all 5 profiles into a single question object instead of using the Q1/Q2 split.
    const ASK_USER_QUESTION_OPTION_CAP = 4; // hard limit enforced by the AskUserQuestion runtime

    // Extract each individual options array by finding 'options: [' and walking to the
    // matching balanced ']', then count label: entries within that span.
    const optionsKeyRe = /\boptions\s*:\s*\[/g;
    let match;
    let questionIndex = 0;
    while ((match = optionsKeyRe.exec(presentBlock)) !== null) {
      questionIndex++;
      // Walk forward from the opening '[' to find the balanced close ']'.
      let depth = 0;
      const start = match.index + match[0].length - 1; // points at '['
      let end = start;
      for (let k = start; k < presentBlock.length; k++) {
        if (presentBlock[k] === '[') { depth++; }
        else if (presentBlock[k] === ']') {
          depth--;
          if (depth === 0) { end = k; break; }
        }
      }
      const optionsBody = presentBlock.slice(start, end + 1);
      const labelMatches = optionsBody.match(/label:\s*"[^"]+"/g) || [];
      const optionCount = labelMatches.length;
      assert.ok(
        optionCount <= ASK_USER_QUESTION_OPTION_CAP,
        `Question object ${questionIndex} in present_settings has ${optionCount} options — exceeds the runtime cap of ${ASK_USER_QUESTION_OPTION_CAP}. Split into multiple questions (as #3784 did for model_profile).`
      );
    }
    // Sanity check: there must be at least one options array found.
    assert.ok(questionIndex > 0, 'present_settings must contain at least one AskUserQuestion options array');
  });

  // ── Brace-balance regression (bd53925f fixed duplicate '{' from 35fc1d21) ──

  test('present_settings step has balanced braces — regression: brace-balance after #3784 split', () => {
    // commit bd53925f fixed a duplicate '{' introduced by 35fc1d21 when the model-profile
    // AskUserQuestion was split into Q1+Q2. This test guards against a recurrence.
    let depth = 0;
    for (const ch of presentBlock) {
      if (ch === '{') { depth++; }
      if (ch === '}') { depth--; }
    }
    assert.strictEqual(
      depth,
      0,
      `present_settings step has unbalanced braces: net depth after full scan is ${depth} (positive = extra '{', negative = extra '}'). Regression guard for bd53925f / #3784.`
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-33-settings-model-profile-adaptive.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-33-settings-model-profile-adaptive (consolidation epic #1969 B8 #1977)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #33)
// The deployed settings.md IS the product — testing its text content tests the deployed contract.

/**
 * Regression test for issue #33
 *
 * model_profile UI shows 4 options, schema has 5 — `adaptive` missing from
 * `settings.md` AskUserQuestion.
 *
 * The schema (gsd-core/bin/shared/model-catalog.json `profiles` array) defines 5 valid
 * model_profile values: quality, balanced, budget, adaptive, inherit. The
 * settings.md AskUserQuestion block for model_profile originally listed only 4
 * options (Quality, Balanced, Budget, Inherit) — `adaptive` was missing.
 *
 * Fix: the model_profile selection uses a two-question split. Q1 routes between
 * Adaptive / Standard-tier / Inherit (3 options). Q2 (only when Q1 = Standard)
 * asks Quality / Balanced / Budget. This keeps every individual options array
 * within the AskUserQuestion 4-option cap while making all 5 profiles reachable.
 *
 * Fixes: #33
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SETTINGS_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'settings.md');
const CATALOG_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'model-catalog.json');

/**
 * Collect every label: "..." value within a text block, lowercased.
 */
function extractOptionLabels(block) {
  const re = /label:\s*"([^"]+)"/g;
  const labels = [];
  let m;
  while ((m = re.exec(block)) !== null) {
    labels.push(m[1].toLowerCase());
  }
  return labels;
}

describe('issue #33: model_profile schema and settings.md UI are in sync', () => {
  let catalog;
  let settingsContent;
  let presentBlock;

  before(() => {
    catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
    settingsContent = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const presentMatch = settingsContent.match(/<step name="present_settings">[\s\S]*?<\/step>/);
    assert.ok(presentMatch, 'settings.md must contain a present_settings step');
    presentBlock = presentMatch[0];
  });

  // -- (a) Schema contract ---------------------------------------------------

  test('schema includes the adaptive model_profile value', () => {
    assert.ok(
      Array.isArray(catalog.profiles),
      'model-catalog.json must have a "profiles" array'
    );
    assert.ok(
      catalog.profiles.includes('adaptive'),
      'model-catalog should include the adaptive profile. Got: [' + catalog.profiles.join(', ') + ']'
    );
  });

  test('schema includes adaptive as a model_profile value', () => {
    assert.ok(
      catalog.profiles.includes('adaptive'),
      '"adaptive" must be in model-catalog.json profiles. Got: [' + catalog.profiles.join(', ') + ']'
    );
  });

  test('schema includes all expected model_profile values', () => {
    const expected = ['quality', 'balanced', 'budget', 'adaptive', 'inherit'];
    for (const profile of expected) {
      assert.ok(
        catalog.profiles.includes(profile),
        'Schema must include "' + profile + '" in profiles. Got: [' + catalog.profiles.join(', ') + ']'
      );
    }
  });

  // -- (b) UI contract — all 5 profiles reachable via present_settings -------

  test('present_settings includes Adaptive as a selectable option (#33)', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'adaptive' || l.startsWith('adaptive')),
      'Issue #33: present_settings must include an "Adaptive" label in its model_profile AskUserQuestion options so users can select it interactively. Got labels: [' + labels.join(', ') + ']'
    );
  });

  test('present_settings includes Quality as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'quality' || l.startsWith('quality')),
      'present_settings must include a "Quality" option. Got: [' + labels.join(', ') + ']'
    );
  });

  test('present_settings includes Balanced as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'balanced' || l.startsWith('balanced')),
      'present_settings must include a "Balanced" option. Got: [' + labels.join(', ') + ']'
    );
  });

  test('present_settings includes Budget as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'budget' || l.startsWith('budget')),
      'present_settings must include a "Budget" option. Got: [' + labels.join(', ') + ']'
    );
  });

  test('present_settings includes Inherit as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'inherit' || l.startsWith('inherit')),
      'present_settings must include an "Inherit" option. Got: [' + labels.join(', ') + ']'
    );
  });

  // -- update_config and confirm steps reference adaptive --------------------

  test('update_config step lists adaptive as a valid model_profile value', () => {
    const m = settingsContent.match(/<step name="update_config">[\s\S]*?<\/step>/);
    assert.ok(m, 'settings.md must have an update_config step');
    assert.ok(
      m[0].includes('adaptive'),
      'update_config step must list "adaptive" as a valid model_profile value'
    );
  });

  test('confirm step table shows adaptive as a possible model profile value', () => {
    const m = settingsContent.match(/<step name="confirm">[\s\S]*?<\/step>/);
    assert.ok(m, 'settings.md must have a confirm step');
    assert.ok(
      m[0].includes('adaptive'),
      'confirm step must include "adaptive" in the Model Profile row'
    );
  });
});
  });
}

// ─── findDocumentedDefault: the proximity scan itself (#2753) ────────────────
//
// The generated `workflow documents default for ...` tests above instantiate this helper
// against the ONE real workflow, which documents every key — so they can only ever exercise
// the passing path. The negative cases that stop this from degrading into "the token appears
// somewhere in the file" are only reachable on synthetic documents, which is what these do.

describe('findDocumentedDefault', () => {
  const KEY = 'response_language';
  const DEF = 'null';
  const pad = (n) => 'x'.repeat(n);

  test('documents default on a single occurrence', () => {
    const r = findDocumentedDefault(`| ${KEY} | ${DEF} | prose`, KEY, DEF);
    assert.equal(r.ok, true);
    assert.equal(r.occurrences, 1);
  });

  test('documents default when a LATER occurrence carries it (#2558 shape)', () => {
    // Prose directive names the key first; the settings table documents it much later.
    const doc = `Apply ${KEY} to all user-facing prose.\n${pad(2000)}\n| ${KEY} | ${DEF} |`;
    const r = findDocumentedDefault(doc, KEY, DEF);
    assert.equal(r.ok, true, 'a later occurrence must satisfy the contract');
    assert.equal(r.occurrences, 2);
  });

  test('documents default when the FIRST occurrence carries it (no regression)', () => {
    const doc = `| ${KEY} | ${DEF} |\n${pad(2000)}\nlater prose about ${KEY}.`;
    const r = findDocumentedDefault(doc, KEY, DEF);
    assert.equal(r.ok, true);
    // The document contains the key twice, but the scan short-circuits on the first
    // documenting window, so exactly one occurrence is EXAMINED. Asserting 2 here would be
    // asserting the document's contents rather than the function's behavior.
    assert.equal(r.occurrences, 1, 'must short-circuit rather than scan the whole document');
  });

  test('documents default on the LAST of many occurrences', () => {
    const doc = [pad(500), KEY, pad(500), KEY, pad(500), KEY, pad(10), DEF].join('\n');
    const r = findDocumentedDefault(doc, KEY, DEF);
    assert.equal(r.ok, true);
    assert.equal(r.occurrences, 3);
  });

  test('FAILS when no occurrence documents the default', () => {
    // The load-bearing negative: scanning more occurrences must not turn a real miss into a pass.
    const doc = [pad(500), KEY, pad(500), KEY, pad(500), KEY, pad(500)].join('\n');
    const r = findDocumentedDefault(doc, KEY, DEF);
    assert.equal(r.ok, false);
    assert.equal(r.occurrences, 3, 'the count is what makes a genuine miss diagnosable');
  });

  test('reports zero occurrences when the key is absent', () => {
    const r = findDocumentedDefault(`nothing relevant here ${DEF}`, KEY, DEF);
    assert.equal(r.ok, false);
    assert.equal(r.occurrences, 0);
    assert.equal(r.window, '');
  });

  test('window boundary holds at limit-1 / limit / limit+1', () => {
    // Offset measured from the start of the key, matching slice(idx, idx + windowSize).
    const at = (gap) => `${KEY}${pad(gap)}${DEF}`;
    const inside = DEFAULT_PROXIMITY_WINDOW - KEY.length - DEF.length - 1;
    assert.equal(findDocumentedDefault(at(inside), KEY, DEF).ok, true, 'limit-1 must pass');
    assert.equal(findDocumentedDefault(at(inside + 1), KEY, DEF).ok, true, 'limit must pass');
    assert.equal(findDocumentedDefault(at(inside + 2), KEY, DEF).ok, false, 'limit+1 must fail');
  });

  test('fails cleanly on an empty document', () => {
    const r = findDocumentedDefault('', KEY, DEF);
    assert.deepEqual(r, { ok: false, occurrences: 0, window: '' });
  });

  test('terminates when the key overlaps itself', () => {
    // Advance-by-one must not loop forever on a self-overlapping needle.
    const r = findDocumentedDefault('aaaa', 'aa', 'zz');
    assert.equal(r.ok, false);
    assert.equal(r.occurrences, 3);
  });

  test('is newline-agnostic (CRLF reaches the same verdict as LF)', () => {
    const lf = `prose ${KEY}\n${pad(2000)}\n| ${KEY} | ${DEF} |`;
    const crlf = lf.replace(/\n/g, '\r\n');
    // Asserting only that the two agree is vacuous — a stub returning a constant satisfies it.
    // Pin the ABSOLUTE verdict on both, then that they agree.
    assert.equal(findDocumentedDefault(lf, KEY, DEF).ok, true);
    assert.equal(findDocumentedDefault(crlf, KEY, DEF).ok, true);
    // And a document neither newline style can rescue must fail under both.
    const missLf = [pad(500), KEY, pad(500), KEY, pad(500)].join('\n');
    assert.equal(findDocumentedDefault(missLf, KEY, DEF).ok, false);
    assert.equal(findDocumentedDefault(missLf.replace(/\n/g, '\r\n'), KEY, DEF).ok, false);
  });

  test('an empty key is refused rather than hanging the scan', () => {
    // String#indexOf('', pos) clamps to str.length instead of returning -1, so an unguarded
    // scan loops forever. Guarded above; this pins it. A timeout here means the guard is gone.
    const r = findDocumentedDefault('some workflow text', '', DEF);
    assert.deepEqual(r, { ok: false, occurrences: 0, window: '' });
    assert.deepEqual(
      findDocumentedDefault('', '', ''),
      { ok: false, occurrences: 0, window: '' }
    );
  });

  test('property: verdict is exactly "default fits inside the window from the key"', () => {
    // windowSize is a budget limit, so it carries a property test (CLAUDE.md TEST RULES).
    // Disjoint alphabets keep key/default/filler from colliding, so the expected verdict is
    // pure arithmetic: the window starts AT the key and spans windowSize chars.
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-f]{1,12}$/),
        fc.stringMatching(/^[m-r]{1,8}$/),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 20, max: 400 }),
        (key, def, gap, windowSize) => {
          const doc = `${key}${'z'.repeat(gap)}${def}`;
          const expected = key.length + gap + def.length <= windowSize;
          const r = findDocumentedDefault(doc, key, def, windowSize);
          assert.equal(r.ok, expected);
          assert.ok(r.occurrences >= 1, 'the key is present by construction');
          return true;
        }
      ),
      { numRuns: 300, seed: 2753 }
    );
  });
});

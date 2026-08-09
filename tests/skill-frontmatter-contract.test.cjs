// allow-test-rule: source-text-is-the-product
// The commands/gsd/*.md and gsd-core/workflows/*.md files are the
// installed agent stubs — their frontmatter and workflow body IS the
// deployed contract. These assertions check structural fields (argument-hint,
// description, early-exit prose) that govern runtime routing.

/**
 * Skill frontmatter contract tests
 *
 * Moved here from bug-3042-3044-research-flag-and-stale-refs.test.cjs
 * during the docs-parity polarity refactor (#3049). The original file
 * mixed two concerns:
 *   (a) docs-parity deny-list checks    → replaced by docs-parity-live-registry.test.cjs
 *   (b) frontmatter-structural checks   → this file
 *
 * These tests assert structural invariants in command-stub frontmatter and
 * workflow prose — they are NOT docs-parity checks. They verify that flags
 * are wired, descriptions are correct, and early-exit prose is present in
 * the right sections. These tests need to remain even after the deny-list
 * tests are removed.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  let content;
  try {
    content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
  } catch (err) {
    throw new Error('[skill-frontmatter-contract] failed to read ' + rel + ': ' + err.message);
  }
  return content;
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

// ─── #3042: --research-phase flag wired into /gsd-plan-phase ────────────────
// (Moved from bug-3042-3044-research-flag-and-stale-refs.test.cjs)

describe('skill frontmatter: /gsd-plan-phase --research-phase flag absorbs the standalone research command', () => {
  test('commands/gsd/plan-phase.md argument-hint advertises --research-phase', () => {
    const content = read('commands/gsd/plan-phase.md');
    // Frontmatter argument-hint is the structural place users discover
    // the flag. Parse the line that starts with "argument-hint:" and
    // assert the flag token is present.
    const m = content.match(/^argument-hint:\s*"([^"]+)"/m);
    assert.ok(m, 'plan-phase.md must declare an argument-hint frontmatter field');
    assert.ok(
      m[1].includes('--research-phase'),
      'argument-hint must include "--research-phase"; got: ' + m[1]
    );
  });

  test('plan-phase.md frontmatter description still advertises plan capability (no semantics drift)', () => {
    const content = read('commands/gsd/plan-phase.md');
    const m = content.match(/^description:\s*(.+)$/m);
    assert.ok(m, 'plan-phase.md must have a description field');
    // The description should still describe planning — the flag is
    // additive, not a renamed command.
    assert.ok(
      /plan/i.test(m[1]),
      'description should still mention planning; got: ' + m[1]
    );
  });

  test('workflows/plan-phase.md parses --research-phase and sets a research-only mode', () => {
    const content = read('gsd-core/workflows/plan-phase.md');
    // The arg-parsing section of the workflow must mention the new flag
    // by name. This is the structural seam the LLM follows.
    // Anchored to the argument/flags section to avoid false positives from prose.
    const argsHeader = '## 2. Parse and Normalize Arguments';
    const argsIdx = content.indexOf(argsHeader);
    assert.ok(argsIdx >= 0, 'plan-phase workflow must contain an argument/flags section');
    const argsWindow = content.slice(argsIdx, argsIdx + 1200);
    assert.ok(
      /--research-phase/.test(argsWindow),
      'plan-phase.md workflow must reference --research-phase in the argument-parsing section (within 1200 chars of the args/flags header)'
    );
  });

  test('workflows/plan-phase.md skips planner/verifier when in research-only mode', () => {
    const content = read('gsd-core/workflows/plan-phase.md');
    // Look for explicit early-exit prose so the LLM knows to stop after
    // research. We accept any of: "research-only", "research only mode",
    // "skip if --research-phase", "RESEARCH_ONLY", "exit after research".
    const patterns = [
      /research[ -]only/i,
      /RESEARCH_ONLY/,
      /skip if[^\n]*--research-phase/i,
      /exit (?:after|when)[^\n]*research/i,
    ];
    const hits = patterns.filter((re) => re.test(content));
    assert.ok(
      hits.length > 0,
      'plan-phase workflow must contain explicit early-exit prose for --research-phase mode; ' +
        'none of [research-only, RESEARCH_ONLY, "skip if --research-phase", "exit after research"] matched'
    );
  });

  test('orphaned workflows/research-phase.md is removed', () => {
    assert.equal(
      exists('gsd-core/workflows/research-phase.md'),
      false,
      'workflows/research-phase.md must be removed; the capability now lives on /gsd-plan-phase --research-phase'
    );
  });

  test('argument-hint advertises --view as a research-only modifier', () => {
    const content = read('commands/gsd/plan-phase.md');
    const m = content.match(/^argument-hint:\s*"([^"]+)"/m);
    assert.ok(m, 'plan-phase.md must declare an argument-hint frontmatter field');
    assert.ok(
      m[1].includes('--view'),
      'argument-hint must include --view (research-only view-only mode); got: ' + m[1]
    );
  });

  test('workflow handles --view by printing existing RESEARCH.md without spawning', () => {
    const content = read('gsd-core/workflows/plan-phase.md');
    // The workflow must reference the --view flag as a no-spawn mode
    // for research-only invocations. We accept any of: "view-only",
    // "VIEW_ONLY", "skip if --view", "no spawn" alongside --view.
    assert.ok(
      /--view/.test(content),
      'plan-phase workflow must reference the --view flag'
    );
    const viewModePatterns = [
      /view[ -]only/i,
      /VIEW_ONLY/,
      /no[ -]spawn/i,
      /print[^\n]*RESEARCH\.md/i,
      /display[^\n]*RESEARCH\.md/i,
    ];
    const hits = viewModePatterns.filter((re) => re.test(content));
    assert.ok(
      hits.length > 0,
      'plan-phase workflow must explain that --view prints existing RESEARCH.md without spawning; ' +
        'expected one of [view-only, VIEW_ONLY, no-spawn, "print/display RESEARCH.md"]'
    );
  });

  test('workflow uses --research as the force-refresh signal in research-only mode', () => {
    const content = read('gsd-core/workflows/plan-phase.md');
    // The plan-phase workflow already had a --research flag with
    // "force re-research" semantics. In research-only mode, that flag
    // must short-circuit the "RESEARCH.md exists, what do you want to
    // do?" prompt and unconditionally re-spawn. Assert the workflow
    // documents the combined semantics.
    // Find the --research-phase description section (headed by the ** marker),
    // then assert that --research and force/refresh semantics are documented
    // within the same section — verifying the COMBINATION is documented.
    // The section header starts at "**`--research-phase <N>`" and runs ~1200
    // chars to cover the modifiers sub-list (--research and --view bullets).
    const sectionIdx = content.indexOf('**`--research-phase');
    assert.ok(sectionIdx >= 0, 'plan-phase workflow must contain a --research-phase description section');
    const sectionWindow = content.slice(sectionIdx, sectionIdx + 1200);
    const hasResearch = /--research\b/.test(sectionWindow);
    const hasForceRefresh = /(?:force[ -]?refresh|re-research|re-spawn|overwrites)/i.test(sectionWindow);
    assert.ok(
      hasResearch && hasForceRefresh,
      'plan-phase workflow must document that --research forces re-research when used with --research-phase ' +
        '(expected --research and force/refresh prose in the --research-phase section; got hasResearch=' +
        hasResearch + ' hasForceRefresh=' + hasForceRefresh + ')'
    );
  });

  test('research-only mode auto-uses existing RESEARCH.md (no update/view/skip prompt)', () => {
    // #2993 fragmentization moved §5.0 (research-only modifiers, including the
    // existing-RESEARCH.md auto-use notice) out of plan-phase.md into
    // gsd-core/workflows/plan-phase/steps/research-only-modifiers.md.
    const content = read('gsd-core/workflows/plan-phase/steps/research-only-modifiers.md');
    // #159: the §5.0 existing-RESEARCH.md path no longer prompts
    // update/view/skip. When RESEARCH.md exists and neither --research nor
    // --view is set, the workflow emits a brief "using it" notice naming
    // the two escape-hatch flags and exits cleanly — matching the
    // promptless auto-use behavior of §5.1 standard mode.
    const idx = content.indexOf('RESEARCH.md already exists');
    assert.ok(
      idx >= 0,
      'plan-phase workflow must contain the literal "RESEARCH.md already exists" notice in the research-only existing-artifact section'
    );
    const window = content.slice(idx, idx + 600);
    // Positive contract: an auto-use notice that names both recovery flags.
    assert.ok(
      /using it/i.test(window),
      'existing-RESEARCH.md notice must state the existing research is being used (e.g. "using it")'
    );
    assert.ok(
      /--research\b/.test(window),
      'notice must name --research as the force-refresh escape hatch'
    );
    assert.ok(
      /--view\b/.test(window),
      'notice must name --view as the print-existing escape hatch'
    );
    // Negative contract: the interactive three-choice prompt must be gone.
    // Guard against reintroduction via prose, an AskUserQuestion call, or a
    // lingering "skip" choice token. (The §5.1 "skip to step 6" text is ~805
    // chars past the anchor, outside this 600-char window.)
    assert.ok(
      !/prompt the user/i.test(window) &&
        !/three choices/i.test(window) &&
        !/AskUserQuestion/i.test(window) &&
        !/\bskip\b/i.test(window),
      'existing-RESEARCH.md path must no longer present an interactive update/view/skip prompt'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2789-description-budget.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2789-description-budget (consolidation epic #1969 B6 #1975)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #2789)
// commands/gsd/*.md text IS what the runtime loads — testing description
// length tests the deployed system-prompt contract.

/**
 * Tests for #2789 — Trim skill description anti-patterns; enforce 100-char budget
 *
 * Verifies:
 * 1. All skill descriptions in commands/gsd/*.md are <= 100 chars
 * 2. No descriptions contain flag documentation anti-patterns (Use --)
 * 3. No descriptions contain "Triggers:" keyword stuffing
 * 4. lint-descriptions.cjs rejects descriptions over 100 chars
 * 5. lint-descriptions.cjs accepts descriptions under 100 chars
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const COMMANDS_DIR = path.join(__dirname, '../commands/gsd');
const LINT_SCRIPT = path.join(__dirname, '../scripts/lint-descriptions.cjs');

const MAX_DESCRIPTION_LENGTH = 100;

/**
 * Parse the description field from a frontmatter block in a .md file.
 * Returns null if no description is found.
 */
function parseDescription(content) {
  // Extract frontmatter block between --- markers
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  // Handle multi-line or quoted values: description: "..." or description: plain text
  // Match: description: "value" or description: value (to end of line)
  const quoted = fm.match(/^description:\s+"((?:[^"\\]|\\.)*)"\s*$/m);
  if (quoted) return quoted[1];

  const plain = fm.match(/^description:\s+(.+)$/m);
  if (plain) return plain[1].trim();

  return null;
}

/**
 * Get all .md files in commands/gsd/ with their descriptions.
 */
function getAllCommandDescriptions() {
  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
  return files.map(file => {
    const filePath = path.join(COMMANDS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const description = parseDescription(content);
    return { file, filePath, description };
  });
}

// ── Test 1: All descriptions <= 100 chars ────────────────────────────────────

describe('description length budget', () => {
  test('all commands/gsd/*.md descriptions are <= 100 chars', () => {
    const commands = getAllCommandDescriptions();
    const violators = commands
      .filter(c => c.description !== null && c.description.length > MAX_DESCRIPTION_LENGTH)
      .map(c => [
        'length=' + c.description.length,
        'file=' + c.file,
        'desc=' + c.description,
      ].join(' | '));

    assert.strictEqual(
      violators.length,
      0,
      [
        `${violators.length} description(s) exceed ${MAX_DESCRIPTION_LENGTH} chars:`,
        ...violators.map(v => '  ' + v),
      ].join('\n')
    );
  });
});

// ── Test 2: No flag documentation anti-patterns ──────────────────────────────

describe('description anti-patterns', () => {
  test('no descriptions contain flag documentation (Use --, use --, via --)', () => {
    const commands = getAllCommandDescriptions();
    const FLAG_PATTERNS = ['Use --', 'use --', 'via --'];
    const violators = commands
      .filter(c => {
        if (!c.description) return false;
        return FLAG_PATTERNS.some(p => c.description.includes(p));
      })
      .map(c => 'file=' + c.file + ' | desc=' + c.description);

    assert.strictEqual(
      violators.length,
      0,
      [
        `${violators.length} description(s) contain flag documentation anti-patterns:`,
        ...violators.map(v => '  ' + v),
      ].join('\n')
    );
  });

  // ── Test 3: No Triggers: keyword stuffing ─────────────────────────────────

  test('no descriptions contain "Triggers:" keyword stuffing', () => {
    const commands = getAllCommandDescriptions();
    const violators = commands
      .filter(c => c.description && /triggers:/i.test(c.description))
      .map(c => 'file=' + c.file + ' | desc=' + c.description);

    assert.strictEqual(
      violators.length,
      0,
      [
        `${violators.length} description(s) contain "Triggers:" keyword stuffing:`,
        ...violators.map(v => '  ' + v),
      ].join('\n')
    );
  });
});

// ── Test 4 & 5: lint-descriptions.cjs script ─────────────────────────────────

describe('lint-descriptions.cjs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lint-desc-test-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('rejects a command file with a description over 100 chars', () => {
    const longDesc = 'A'.repeat(101);
    const content = [
      '---',
      'name: gsd:test-long',
      'description: ' + longDesc,
      '---',
      '',
      'Body text.',
    ].join('\n');

    const tmpFile = path.join(tmpDir, 'long-desc.md');
    fs.writeFileSync(tmpFile, content, 'utf-8');

    const result = runNode([LINT_SCRIPT, tmpFile], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assert.notStrictEqual(result.exitCode, 0, [
      'lint-descriptions.cjs should exit non-zero for description > 100 chars',
      'stdout: ' + result.stdout,
      'stderr: ' + result.stderr,
    ].join('\n'));
  });

  test('accepts a command file with a description under 100 chars', () => {
    const shortDesc = 'Short routing description for this skill.';
    const content = [
      '---',
      'name: gsd:test-short',
      'description: ' + shortDesc,
      '---',
      '',
      'Body text.',
    ].join('\n');

    const tmpFile = path.join(tmpDir, 'short-desc.md');
    fs.writeFileSync(tmpFile, content, 'utf-8');

    const result = runNode([LINT_SCRIPT, tmpFile], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assert.strictEqual(result.exitCode, 0, [
      'lint-descriptions.cjs should exit 0 for description <= 100 chars',
      'stdout: ' + result.stdout,
      'stderr: ' + result.stderr,
    ].join('\n'));
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2790-skill-consolidation.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2790-skill-consolidation (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #2790)
// commands/gsd/*.md files ARE what the runtime loads — testing their
// existence/non-existence tests the deployed skill surface contract.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { assertWithinAllowlist } = require('../scripts/lib/allowlist-ratchet.cjs');

// ---------------------------------------------------------------------------
// Allowlisted set of user-invocable skills (commands/gsd/*.md, ns-* excluded).
// Consolidation target ~58; this set may only SHRINK.
// Adding a new skill requires adding it here with justification.
// Removing a consolidated skill requires pruning it here.
// ---------------------------------------------------------------------------
const KNOWN_SKILLS = new Set([
  'add-tests.md',
  'ai-integration-phase.md',
  'audit-fix.md',
  'audit-milestone.md',
  'audit-uat.md',
  'autonomous.md',
  'capture.md',
  'cleanup.md',
  'code-review.md',
  'complete-milestone.md',
  'config.md',
  'debug.md',
  'discuss-phase.md',
  'docs-update.md',
  'eval-review.md',
  'execute-phase.md',
  'explore.md',
  'extract-learnings.md',
  'fast.md',
  'forensics.md',
  'graphify.md',
  'health.md',
  'help.md',
  'import.md',
  'inbox.md',
  'ingest-docs.md',
  'manager.md',
  'map-codebase.md',
  'mempalace-capture.md',
  'mempalace-recall.md',
  'milestone-summary.md',
  'mvp-phase.md',
  'new-milestone.md',
  'new-project.md',
  // #1990 brownfield onboarding entry command; sibling of new-project, routed under ns-project.
  'onboard.md',
  // `next.md` was legitimately reclaimed (#1787): the old workflow-advance
  // command stays absorbed into `progress.md --next`, while the current
  // `/gsd:next` is a different state-aware smart-entry launcher.
  'next.md',
  'pause-work.md',
  'phase.md',
  'plan-phase.md',
  'plan-review-convergence.md',
  'pr-branch.md',
  'profile-user.md',
  'progress.md',
  'quick.md',
  'resume-work.md',
  'review-backlog.md',
  'review.md',
  'secure-phase.md',
  'settings.md',
  'ship.md',
  'sketch.md',
  'spec-phase.md',
  'spike.md',
  'stats.md',
  'surface.md',
  'thread.md',
  'ui-phase.md',
  'ui-review.md',
  'ultraplan-phase.md',
  'undo.md',
  'update.md',
  'validate-phase.md',
  'verify-work.md',
  'workspace.md',
  'workstreams.md',
]);

const COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');

/**
 * Parse the YAML frontmatter from a skill .md file.
 * Returns an object with the frontmatter fields as strings.
 * Only handles simple scalar and array values needed by these tests.
 */
function parseFrontmatter(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // CRLF-tolerant: Windows checkouts leave \r on every line. lines.indexOf('---', 1)
  // would never match because elements would be '---\r' instead of '---'.
  const lines = raw.split(/\r?\n/);
  if (lines[0].trim() !== '---') return {};
  const endIdx = lines.indexOf('---', 1);
  if (endIdx === -1) return {};
  const fmLines = lines.slice(1, endIdx);
  const result = {};
  let currentKey = null;
  for (const line of fmLines) {
    const kvMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      result[currentKey] = kvMatch[2].trim();
    } else if (currentKey && line.match(/^\s+-\s+/)) {
      // array item — append to existing string value so callers can check membership
      const item = line.replace(/^\s+-\s+/, '').trim();
      result[currentKey] = result[currentKey] ? [result[currentKey], item].join('\n') : item;
    }
  }
  return result;
}

function skillPath(name) {
  return path.join(COMMANDS_DIR, `${name}.md`);
}

// ---------------------------------------------------------------------------
// Group: New consolidated skills exist
// ---------------------------------------------------------------------------
describe('new consolidated skills exist', () => {
  test('commands/gsd/capture.md exists', () => {
    assert.ok(fs.existsSync(skillPath('capture')), 'capture.md does not exist');
  });

  test('commands/gsd/phase.md exists', () => {
    assert.ok(fs.existsSync(skillPath('phase')), 'phase.md does not exist');
  });

  test('commands/gsd/config.md exists', () => {
    assert.ok(fs.existsSync(skillPath('config')), 'config.md does not exist');
  });

  test('commands/gsd/workspace.md exists', () => {
    assert.ok(fs.existsSync(skillPath('workspace')), 'workspace.md does not exist');
  });
});

// ---------------------------------------------------------------------------
// Group: Absorbed skills are removed
// ---------------------------------------------------------------------------
describe('absorbed skills are removed', () => {
  const absorbed = [
    ['add-todo', 'absorbed into capture.md'],
    ['note', 'absorbed into capture.md'],
    ['add-backlog', 'absorbed into capture.md'],
    ['plant-seed', 'absorbed into capture.md'],
    ['check-todos', 'absorbed into capture.md'],
    ['add-phase', 'absorbed into phase.md'],
    ['insert-phase', 'absorbed into phase.md'],
    ['remove-phase', 'absorbed into phase.md'],
    ['edit-phase', 'absorbed into phase.md'],
    ['settings-advanced', 'absorbed into config.md'],
    ['settings-integrations', 'absorbed into config.md'],
    ['set-profile', 'absorbed into config.md'],
    ['new-workspace', 'absorbed into workspace.md'],
    ['list-workspaces', 'absorbed into workspace.md'],
    ['remove-workspace', 'absorbed into workspace.md'],
    ['sync-skills', 'absorbed into update.md'],
    ['reapply-patches', 'absorbed into update.md'],
    ['sketch-wrap-up', 'absorbed into sketch.md'],
    ['spike-wrap-up', 'absorbed into spike.md'],
    ['scan', 'absorbed into map-codebase.md'],
    ['intel', 'absorbed into map-codebase.md'],
    ['code-review-fix', 'absorbed into code-review.md'],
    // NOTE: `next` is intentionally absent here — the workflow-advance behavior
    // stays absorbed into `progress.md --next`, but `/gsd:next` was reintroduced
    // (#1787) as a distinct state-aware smart-entry launcher, so `next.md` is a
    // KNOWN_SKILL again rather than an absorbed/removed command.
    ['do', 'absorbed into progress.md'],
  ];

  for (const [name, reason] of absorbed) {
    test(`commands/gsd/${name}.md does NOT exist (${reason})`, () => {
      assert.ok(
        !fs.existsSync(skillPath(name)),
        [
          `${name}.md still exists but should have been deleted`,
          `(${reason})`,
        ].join(' '),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Group: Outright deletions
// ---------------------------------------------------------------------------
describe('outright deleted dead skills are removed', () => {
  const deleted = [
    'join-discord',
    // research-phase     → plan-phase --research-phase (PR #3045, already absorbed)
    // plan-milestone-gaps → inline in audit-milestone (PR #3038, already absorbed)
    // list-phase-assumptions → discuss-phase --assumptions (pending #3131)
    // session-report     → pause-work --report (pending #3131)
    // analyze-dependencies → manager --analyze-deps (pending #3131)
    // from-gsd2          → import --from-gsd2 (pending #3131)
  ];

  for (const name of deleted) {
    test(`commands/gsd/${name}.md does NOT exist`, () => {
      assert.ok(
        !fs.existsSync(skillPath(name)),
        `${name}.md still exists but should have been deleted (outright dead skill)`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Group: #3131 — re-wired workflows absorbed as flags
// ---------------------------------------------------------------------------
describe('#3131 re-wired workflows: standalone command files must not exist', () => {
  const rewired = [
    ['list-phase-assumptions', 'absorbed into discuss-phase.md --assumptions'],
    ['session-report',         'absorbed into pause-work.md --report'],
    ['analyze-dependencies',   'absorbed into manager.md --analyze-deps'],
    ['from-gsd2',              'absorbed into import.md --from-gsd2'],
  ];

  for (const [name, reason] of rewired) {
    test(`commands/gsd/${name}.md does NOT exist (${reason})`, () => {
      assert.ok(
        !fs.existsSync(skillPath(name)),
        `${name}.md still exists as a standalone command but should be absorbed (${reason})`,
      );
    });
  }
});

describe('#3131 re-wired workflows: parent command argument-hints advertise the new flags', () => {
  test('discuss-phase.md argument-hint contains --assumptions', () => {
    const fm = parseFrontmatter(skillPath('discuss-phase'));
    assert.ok(
      (fm['argument-hint'] || '').includes('--assumptions'),
      'discuss-phase.md argument-hint does not contain --assumptions. got: ' + (fm['argument-hint'] || '(none)'),
    );
  });

  test('pause-work.md argument-hint contains --report', () => {
    const fm = parseFrontmatter(skillPath('pause-work'));
    assert.ok(
      (fm['argument-hint'] || '').includes('--report'),
      'pause-work.md argument-hint does not contain --report. got: ' + (fm['argument-hint'] || '(none)'),
    );
  });

  test('manager.md argument-hint contains --analyze-deps', () => {
    const fm = parseFrontmatter(skillPath('manager'));
    assert.ok(
      (fm['argument-hint'] || '').includes('--analyze-deps'),
      'manager.md argument-hint does not contain --analyze-deps. got: ' + (fm['argument-hint'] || '(none)'),
    );
  });

  test('import.md argument-hint contains --from-gsd2', () => {
    const fm = parseFrontmatter(skillPath('import'));
    assert.ok(
      (fm['argument-hint'] || '').includes('--from-gsd2'),
      'import.md argument-hint does not contain --from-gsd2. got: ' + (fm['argument-hint'] || '(none)'),
    );
  });
});

describe('#3131 re-wired workflows: parent command bodies dispatch to workflow files', () => {
  function bodyContains(name, substring) {
    const raw = fs.readFileSync(skillPath(name), 'utf8');
    return raw.includes(substring);
  }

  test('discuss-phase.md body references list-phase-assumptions.md', () => {
    assert.ok(
      bodyContains('discuss-phase', 'list-phase-assumptions.md'),
      'discuss-phase.md body does not reference list-phase-assumptions.md — --assumptions flag dispatch is missing',
    );
  });

  test('pause-work.md body references session-report.md', () => {
    assert.ok(
      bodyContains('pause-work', 'session-report.md'),
      'pause-work.md body does not reference session-report.md — --report flag dispatch is missing',
    );
  });

  test('manager.md body references analyze-dependencies.md', () => {
    assert.ok(
      bodyContains('manager', 'analyze-dependencies.md'),
      'manager.md body does not reference analyze-dependencies.md — --analyze-deps flag dispatch is missing',
    );
  });

  test('import.md body references from-gsd2', () => {
    assert.ok(
      bodyContains('import', 'from-gsd2'),
      'import.md body does not reference from-gsd2 — --from-gsd2 flag dispatch is missing',
    );
  });
});

// ---------------------------------------------------------------------------
// Group: Parent skills updated with new flags
// ---------------------------------------------------------------------------
describe('parent skills updated with new flags in argument-hint', () => {
  test('update.md argument-hint contains --sync', () => {
    const fm = parseFrontmatter(skillPath('update'));
    assert.ok(
      (fm['argument-hint'] || '').includes('--sync'),
      [
        'update.md argument-hint does not contain --sync',
        'got: ' + (fm['argument-hint'] || '(none)'),
      ].join('. '),
    );
  });

  test('update.md argument-hint contains --reapply', () => {
    const fm = parseFrontmatter(skillPath('update'));
    assert.ok(
      (fm['argument-hint'] || '').includes('--reapply'),
      [
        'update.md argument-hint does not contain --reapply',
        'got: ' + (fm['argument-hint'] || '(none)'),
      ].join('. '),
    );
  });

  test('sketch.md argument-hint contains --wrap-up', () => {
    const fm = parseFrontmatter(skillPath('sketch'));
    assert.ok(
      (fm['argument-hint'] || '').includes('--wrap-up'),
      [
        'sketch.md argument-hint does not contain --wrap-up',
        'got: ' + (fm['argument-hint'] || '(none)'),
      ].join('. '),
    );
  });

  test('spike.md argument-hint contains --wrap-up', () => {
    const fm = parseFrontmatter(skillPath('spike'));
    assert.ok(
      (fm['argument-hint'] || '').includes('--wrap-up'),
      [
        'spike.md argument-hint does not contain --wrap-up',
        'got: ' + (fm['argument-hint'] || '(none)'),
      ].join('. '),
    );
  });

  test('map-codebase.md argument-hint contains --fast', () => {
    const fm = parseFrontmatter(skillPath('map-codebase'));
    assert.ok(
      (fm['argument-hint'] || '').includes('--fast'),
      [
        'map-codebase.md argument-hint does not contain --fast',
        'got: ' + (fm['argument-hint'] || '(none)'),
      ].join('. '),
    );
  });

  test('code-review.md argument-hint contains --fix', () => {
    const fm = parseFrontmatter(skillPath('code-review'));
    assert.ok(
      (fm['argument-hint'] || '').includes('--fix'),
      [
        'code-review.md argument-hint does not contain --fix',
        'got: ' + (fm['argument-hint'] || '(none)'),
      ].join('. '),
    );
  });

  test('progress.md argument-hint contains --do', () => {
    const fm = parseFrontmatter(skillPath('progress'));
    assert.ok(
      (fm['argument-hint'] || '').includes('--do'),
      [
        'progress.md argument-hint does not contain --do',
        'got: ' + (fm['argument-hint'] || '(none)'),
      ].join('. '),
    );
  });
});

// ---------------------------------------------------------------------------
// Group: settings.md is NOT deleted
// ---------------------------------------------------------------------------
describe('settings.md is kept (merged into config entry point or remains standalone)', () => {
  test('commands/gsd/settings.md still exists', () => {
    assert.ok(
      fs.existsSync(skillPath('settings')),
      'settings.md was deleted — it should be kept (or renamed to config.md, but not both missing)',
    );
  });
});

// ---------------------------------------------------------------------------
// Group: Skill set allowlisted (identity-based, consolidating toward ~58)
// ---------------------------------------------------------------------------
describe('skill set', () => {
  test('user-invocable skill set is allowlisted (consolidating toward ~58)', () => {
    // Exclude `ns-*.md` namespace meta-skills (#2792) from this guard.
    // Those are descriptor-only routers selected first by the model and
    // are not part of the consolidation surface this test tracks; their
    // own contract is enforced by tests/enh-2792-namespace-skills.test.cjs.
    const currentBasenames = fs.readdirSync(COMMANDS_DIR)
      .filter((f) => f.endsWith('.md') && !f.startsWith('ns-'));
    assertWithinAllowlist({
      label: 'user-invocable skills (commands/gsd)',
      current: currentBasenames,
      known: KNOWN_SKILLS,
      fail: assert.fail,
      pruneHint: 'edit KNOWN_SKILLS in tests/skill-frontmatter-contract.test.cjs',
    });
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3039-help-tiered.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3039-help-tiered (consolidation epic #1969 B6 #1975)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #3039)
// `workflows/help/modes/*.md` files ARE the help output — their text is what
// the runtime emits when the user runs `/gsd:help [--brief|--full|<topic>]`.
// Asserting on their structure tests the deployed contract directly.

/**
 * Feature #3039: tiered /gsd:help output.
 *
 * The legacy single-file 747-line help is replaced by:
 *   - workflows/help.md             — small dispatcher (progressive disclosure)
 *   - workflows/help/modes/brief.md   — ~one-liner refresher
 *   - workflows/help/modes/default.md — one-page newcomer tour
 *   - workflows/help/modes/full.md    — complete reference (former help.md body)
 *   - workflows/help/modes/topic.md   — section-extraction logic + alias table
 *
 * This test enforces the contract:
 *   1. All four mode files exist with a single `<reference>` block.
 *   2. brief and default fit a "one screen" budget; full stays under LARGE tier cap.
 *   3. The dispatcher routes on $ARGUMENTS to all four mode files (structural parse).
 *   4. Dispatcher conflict-resolution rules are documented:
 *      - `--brief` + `--full` without a topic → prefer `--full`
 *      - `--brief <topic>` → topic.md in compact scope (composable)
 *      - bare or `--full <topic>` → topic.md in full scope
 *   5. topic.md documents an explicit routing preamble + compact-scope rule.
 *   6. Every topic alias in topic.md resolves to a heading that exists in full.md.
 *   7. Every /gsd:* sub-block token in topic.md's alias table appears in full.md.
 *   8. Every full.md heading is either aliased or in the intentional-orphan allowlist.
 *   9. The `commands/gsd/help.md` shim passes `$ARGUMENTS` through and advertises
 *      the composable `--brief <topic>` form.
 *
 * Tighten-only invariant (issue #597): ceilings track the per-tier high-water mark
 * within GRACE lines. Budgets may only decrease, never silently creep upward.
 * The assertTightCeiling() calls below enforce this automatically.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertTightCeiling } = require('../scripts/lib/allowlist-ratchet.cjs');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS = path.join(ROOT, 'gsd-core', 'workflows');
const MODES = path.join(WORKFLOWS, 'help', 'modes');
const DISPATCHER = path.join(WORKFLOWS, 'help.md');
const COMMAND_SHIM = path.join(ROOT, 'commands', 'gsd', 'help.md');

const MODE_FILES = ['brief.md', 'default.md', 'full.md', 'topic.md'];

// "One screen" budgets, including frontmatter/<purpose>/<reference> tags.
// These are conservative (one-page conceptual size of ~25 lines of usable
// content) but allow for the wrapping tags. Tighten as content stabilizes.
//
// Ceilings tightened to actualMax + SMALL_GRACE per the ratchet-down rule (#597).
// BRIEF ceiling kept at 30 (actualMax=22, slack=8 ≤ SMALL_GRACE=10).
const BRIEF_BUDGET = 30;
// DEFAULT ceiling lowered from 70 → 60 (actualMax=50; #597 ratchet-down).
const DEFAULT_BUDGET = 60;
// full.md is the LARGE tier (see workflow-size-budget.test.cjs — now byte-based per #717;
// this FULL_BUDGET is a separate line-count budget for help/modes/full.md).
// The size-budget test is non-recursive so full.md is not covered there; cap it here.
// FULL ceiling lowered from 1500 → 844 (actualMax=784; #597 ratchet-down).
const FULL_BUDGET = 844;

// Grace bands:
//   SMALL_GRACE — for the tiny brief/default/dispatcher files (≤ ~70 lines):
//     10 lines of breathing room is proportionate and prevents trivial edits from
//     failing while still catching any meaningful upward creep.
//   LARGE_GRACE — for full.md where content fluctuates more:
//     60 lines matches the line-budget GRACE used in the other size-budget tests.
const SMALL_GRACE = 10;
const LARGE_GRACE = 60;

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function lineCount(file) {
  const c = read(file);
  if (c.length === 0) return 0;
  const trail = c.endsWith('\n') ? 1 : 0;
  return c.split('\n').length - trail;
}

describe('feature #3039: tiered help — file structure', () => {
  for (const f of MODE_FILES) {
    test(`mode file exists: ${f}`, () => {
      assert.ok(fs.existsSync(path.join(MODES, f)), `missing ${path.join(MODES, f)}`);
    });
  }

  // Dispatcher ceiling lowered from 40 → 34 (actualMax=24; #597 ratchet-down).
  const DISPATCHER_BUDGET = 34;
  test(`dispatcher exists and is small (≤ ${DISPATCHER_BUDGET} lines)`, () => {
    assert.ok(fs.existsSync(DISPATCHER));
    const n = lineCount(DISPATCHER);
    assert.ok(n <= DISPATCHER_BUDGET, `dispatcher should be small; got ${n} lines`);
    assertTightCeiling({ label: 'dispatcher', actualMax: n, ceiling: DISPATCHER_BUDGET, grace: SMALL_GRACE, fail: assert.fail });
  });

  for (const f of MODE_FILES) {
    test(`${f} has exactly one <reference> block (line-anchored)`, () => {
      const content = read(path.join(MODES, f));
      // Anchor on start-of-line so prose mentions of `<reference>` inside
      // <purpose> blocks aren't counted.
      const opens = (content.match(/^<reference>$/gm) || []).length;
      const closes = (content.match(/^<\/reference>$/gm) || []).length;
      assert.equal(opens, 1, `${f}: expected 1 <reference> opening line, got ${opens}`);
      assert.equal(closes, 1, `${f}: expected 1 </reference> closing line, got ${closes}`);
    });
  }
});

describe('feature #3039: tiered help — size budgets', () => {
  test(`brief.md fits one screen (≤ ${BRIEF_BUDGET} lines)`, () => {
    const n = lineCount(path.join(MODES, 'brief.md'));
    assert.ok(n <= BRIEF_BUDGET, `brief.md is ${n} lines, budget ${BRIEF_BUDGET}`);
    assertTightCeiling({ label: 'BRIEF', actualMax: n, ceiling: BRIEF_BUDGET, grace: SMALL_GRACE, fail: assert.fail });
  });

  test(`default.md fits one screen (≤ ${DEFAULT_BUDGET} lines)`, () => {
    const n = lineCount(path.join(MODES, 'default.md'));
    assert.ok(n <= DEFAULT_BUDGET, `default.md is ${n} lines, budget ${DEFAULT_BUDGET}`);
    assertTightCeiling({ label: 'DEFAULT', actualMax: n, ceiling: DEFAULT_BUDGET, grace: SMALL_GRACE, fail: assert.fail });
  });

  test('full.md preserves the complete reference (≥ 600 lines)', () => {
    // The pre-#3039 reference was 747 lines. Guard against accidental shrinkage
    // that would amount to silently removing content from --full.
    const n = lineCount(path.join(MODES, 'full.md'));
    assert.ok(n >= 600, `full.md is ${n} lines — too small, content may have been lost`);
  });

  test(`full.md stays under LARGE workflow budget (≤ ${FULL_BUDGET} lines)`, () => {
    // full.md lives in a subdirectory and is not enumerated by the non-recursive
    // workflow-size-budget.test.cjs. Cap it here at the LARGE tier limit.
    const n = lineCount(path.join(MODES, 'full.md'));
    assert.ok(n <= FULL_BUDGET, `full.md grew to ${n} lines (LARGE budget: ${FULL_BUDGET})`);
    assertTightCeiling({ label: 'FULL', actualMax: n, ceiling: FULL_BUDGET, grace: LARGE_GRACE, fail: assert.fail });
  });
});

describe('feature #3039: tiered help — dispatcher routing (structural)', () => {
  const dispatcher = read(DISPATCHER);

  function extractDisclosureBlock(src) {
    const m = src.match(/<progressive_disclosure>([\s\S]*?)<\/progressive_disclosure>/);
    assert.ok(m, 'dispatcher must contain a <progressive_disclosure> block');
    return m[1];
  }

  test('dispatcher <progressive_disclosure> block has exactly 5 routing rows', () => {
    // 4 base tiers (brief, full, default, topic) + 1 composable row (--brief <topic>).
    const block = extractDisclosureBlock(dispatcher);
    // Table rows are lines starting with `|`, excluding the header and separator rows.
    const rows = block.split('\n')
      .filter(l => /^\|/.test(l))
      .filter(l => !/^\|\s*[-:]+\s*\|/.test(l))        // strip separator rows
      .filter(l => !/when.*arguments/i.test(l));         // strip header row
    assert.equal(rows.length, 5,
      `dispatcher routing table must have exactly 5 rows; got ${rows.length}:\n${rows.join('\n')}`);
  });

  test('dispatcher routes --brief to brief.md', () => {
    const block = extractDisclosureBlock(dispatcher);
    assert.match(block, /`--brief`[\s\S]*?brief\.md/);
  });

  test('dispatcher routes --full to full.md', () => {
    const block = extractDisclosureBlock(dispatcher);
    assert.match(block, /`--full`[\s\S]*?full\.md/);
  });

  test('dispatcher routes empty/no-flag args to default.md', () => {
    const block = extractDisclosureBlock(dispatcher);
    assert.match(block, /(empty|unset)[\s\S]*?default\.md/i);
  });

  test('dispatcher routes topic args to topic.md', () => {
    const block = extractDisclosureBlock(dispatcher);
    assert.match(block, /topic[\s\S]*?topic\.md/i);
  });
});

describe('feature #3039: tiered help — dispatcher conflict-resolution rules', () => {
  const dispatcher = read(DISPATCHER);

  test('dispatcher documents --brief + --full (without topic) conflict resolution (prefer --full)', () => {
    // help.md argument parsing rules: "if both appear *without* a topic, prefer `--full`"
    assert.match(dispatcher, /prefer.*--full/);
  });

  test('dispatcher routes --brief <topic> to topic.md in compact scope (composable)', () => {
    // help.md argument parsing rules: "--brief combined with a topic invokes topic.md
    // in compact scope" — the composable scoped-lookup form (trek-e review finding #4).
    assert.match(dispatcher, /--brief[^|]*<topic>[\s\S]*?topic\.md[\s\S]*?compact/i);
  });

  test('dispatcher routes --full <topic> (or bare topic) to topic.md in full scope', () => {
    // Bare topic, `--full <topic>`, or topic with leading `--` → full scope.
    assert.match(dispatcher, /(bare topic|--full <topic>)[\s\S]*?full scope/i);
  });

  test('dispatcher tells topic.md to retain --brief when delegating', () => {
    // The dispatcher passes $ARGUMENTS through; topic.md needs to see --brief to
    // choose compact scope. Guard against accidental flag-stripping.
    assert.match(dispatcher, /retain.*--brief|pass.*--brief/i);
  });
});

describe('feature #3039: tiered help — command shim passes $ARGUMENTS', () => {
  const shim = read(COMMAND_SHIM);

  test('shim references $ARGUMENTS', () => {
    assert.match(shim, /\$ARGUMENTS/);
  });

  test('shim declares argument-hint frontmatter', () => {
    assert.match(shim, /argument-hint:/);
  });

  test('shim argument-hint advertises composable --brief <topic>', () => {
    // Discoverability: users need to know the composable form is supported
    // (trek-e review finding #4).
    assert.match(shim, /argument-hint:[^\n]*--brief[^\n]*<topic>/);
  });

  test('shim references the help workflow', () => {
    assert.match(shim, /workflows\/help\.md/);
  });
});

describe('feature #3039: tiered help — topic.md routing visibility + compact scope', () => {
  const topicSrc = read(path.join(MODES, 'topic.md'));

  test('topic.md documents an explicit resolved-routing preamble', () => {
    // Trek-e review finding #3: routing must be explicit in output so the user
    // can see which alias matched which heading and at what scope.
    assert.match(topicSrc, /\*\*Topic:\*\*[\s\S]*<alias>[\s\S]*<heading>/);
    assert.match(topicSrc, /scope:.*full.*\|.*compact/i);
  });

  test('topic.md documents a compact scope distinct from full scope', () => {
    // Trek-e review finding #4: --brief <topic> must produce a compact
    // scoped lookup (signature + one-line summary), not the full section.
    assert.match(topicSrc, /compact scope/i);
    assert.match(topicSrc, /signature.*one-line summary|signature \+ one-line/i);
  });

  test('topic.md parses --brief flag and strips it before resolving the alias', () => {
    // Compact scope must trigger off the --brief flag in $ARGUMENTS; the
    // remaining token is the alias.
    assert.match(topicSrc, /--brief.*-b.*compact scope|compact scope[\s\S]*--brief/i);
  });

  test('topic.md closing "More:" line advertises the composable form', () => {
    assert.match(topicSrc, /More:[\s\S]*--brief <topic>/);
  });
});

describe('feature #3039: tiered help — topic alias coverage', () => {
  const topicSrc = read(path.join(MODES, 'topic.md'));
  const fullSrc = read(path.join(MODES, 'full.md'));

  // Extract the alias table portion of topic.md (before "**Output rules:**")
  function aliasTableSection(src) {
    return src.split('**Output rules:**')[0];
  }

  // Extract the canonical heading text referenced from each row of the
  // alias table. Rows look like: `| aliases | \`## Heading\` ... |`.
  // We accept either ## or ### and pull the literal heading text.
  function extractReferencedHeadings(src) {
    const headings = new Set();
    const re = /`(#{2,3} [^`]+?)`/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      headings.add(m[1].trim());
    }
    return headings;
  }

  function fullHeadings(src) {
    const set = new Set();
    for (const line of src.split('\n')) {
      const m = line.match(/^(#{2,3}) (.+?)\s*$/);
      if (m) set.add(`${m[1]} ${m[2]}`);
    }
    return set;
  }

  test('every heading referenced in topic.md exists in full.md', () => {
    const referenced = extractReferencedHeadings(aliasTableSection(topicSrc));
    const present = fullHeadings(fullSrc);
    const missing = [...referenced].filter((h) => !present.has(h)).sort();
    assert.deepEqual(missing, [],
      `topic.md references headings not present in full.md: ${missing.join(' | ')}`);
  });

  test('every /gsd:* sub-block token in topic.md alias table exists in full.md', () => {
    // Validates fix for review finding #2: sub-block aliases reference bold-line
    // anchors (**`/gsd:X`**) — assert each token actually appears in full.md.
    const tableSection = aliasTableSection(topicSrc);
    const tokens = [...tableSection.matchAll(/`(\/gsd:[a-z-]+(?:\s+--[a-z-]+)?)`/g)].map(m => m[1]);
    assert.ok(tokens.length > 0, 'expected at least one /gsd:* token in alias table');
    const missing = tokens.filter(t => !fullSrc.includes(t));
    assert.deepEqual(missing, [],
      `topic.md references /gsd:* tokens not present in full.md: ${missing.join(' | ')}`);
  });

  test('every full.md heading is either aliased or in the intentional-orphan allowlist', () => {
    // Catches newly added headings that have no alias (contributor must either
    // alias the section or explicitly add it to INTENTIONAL_ORPHANS below).
    const INTENTIONAL_ORPHANS = new Set([
      '## Quick Start',
      '## Staying Updated',
      '### Utility Commands',          // covered by cleanup/update sub-block aliases
      '## Additional Commands',
      '### Discovery & Specification',
      '### Planning & Execution',
      '### Quality, Review & Verification',
      '### Diagnostics & Maintenance',
      '### Knowledge & Context',
      '### Workflow & Orchestration',
      '### Repository Integration',
      '### Namespace Routers (model-facing meta-skills)',
    ]);

    const allHeadings = fullSrc.split('\n')
      .filter(l => /^#{2,3} /.test(l))
      .map(l => l.trim());

    const aliased = extractReferencedHeadings(aliasTableSection(topicSrc));

    const orphans = allHeadings.filter(h => !aliased.has(h) && !INTENTIONAL_ORPHANS.has(h));
    assert.deepEqual(orphans, [],
      `full.md headings not aliased in topic.md (add to INTENTIONAL_ORPHANS if intentional): ${orphans.join(' | ')}`);
  });

  test('topic.md covers the core topics promised in default.md', () => {
    // Surface contract: default.md advertises a "Topics:" line. Each alias
    // there must appear as a recognized topic in topic.md's alias table.
    const def = read(path.join(MODES, 'default.md'));
    const topicsLine = def.split('\n').find((l) => /^Topics:/i.test(l));
    assert.ok(topicsLine, 'default.md must advertise a "Topics:" line for users');
    // Strip the leading "Topics:" prefix, then pull every backticked token.
    const aliases = [...topicsLine.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]);
    assert.ok(aliases.length >= 5, `expected at least 5 promoted topic aliases; got ${aliases.length}`);
    const missing = aliases.filter((a) => !new RegExp(`\`${a}\``).test(topicSrc));
    assert.deepEqual(missing, [],
      `default.md promotes topic aliases that topic.md does not recognize: ${missing.join(', ')}`);
  });
});
  });
}

/**
 * Tests for skill-manifest command
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function writeSkill(rootDir, name, description, body = '') {
  const skillDir = path.join(rootDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body || `# ${name}`,
  ].join('\n'));
}

describe('skill-manifest', () => {
  let tmpDir;
  let homeDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    homeDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-skill-manifest-home-'));

    writeSkill(path.join(tmpDir, '.claude', 'skills'), 'project-claude', 'Project Claude skill');
    writeSkill(path.join(tmpDir, '.claude', 'skills'), 'gsd-help', 'Installed GSD skill');
    writeSkill(path.join(tmpDir, '.agents', 'skills'), 'project-agents', 'Project agent skill');
    writeSkill(path.join(tmpDir, '.codex', 'skills'), 'project-codex', 'Project Codex skill');

    writeSkill(path.join(homeDir, '.claude', 'skills'), 'global-claude', 'Global Claude skill');
    writeSkill(path.join(homeDir, '.codex', 'skills'), 'global-codex', 'Global Codex skill');
    writeSkill(
      path.join(homeDir, '.claude', 'gsd-core', 'skills'),
      'legacy-import',
      'Deprecated import-only skill'
    );

    fs.mkdirSync(path.join(homeDir, '.claude', 'commands', 'gsd'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.claude', 'commands', 'gsd', 'help.md'), '# legacy');
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(homeDir);
  });

  test('returns normalized inventory across canonical roots', () => {
    // On Windows, os.homedir() reads USERPROFILE (not HOME). The SUT scans
    // global skill roots via os.homedir(), so the test must also override
    // USERPROFILE to keep the fixture's homeDir visible.
    const result = runGsdTools(['skill-manifest'], tmpDir, { HOME: homeDir, USERPROFILE: homeDir });
    assert.ok(result.success, `Command should succeed: ${result.error || result.output}`);

    const manifest = JSON.parse(result.output);
    assert.ok(Array.isArray(manifest.skills), 'skills should be an array');
    assert.ok(Array.isArray(manifest.roots), 'roots should be an array');
    assert.ok(manifest.installation && typeof manifest.installation === 'object', 'installation summary present');
    assert.ok(manifest.counts && typeof manifest.counts === 'object', 'counts summary present');

    const skillNames = manifest.skills.map((skill) => skill.name).sort();
    assert.deepStrictEqual(skillNames, [
      'global-claude',
      'global-codex',
      'gsd-help',
      'legacy-import',
      'project-agents',
      'project-claude',
      'project-codex',
    ]);

    const codexSkill = manifest.skills.find((skill) => skill.name === 'project-codex');
    assert.deepStrictEqual(
      {
        root: codexSkill.root,
        scope: codexSkill.scope,
        installed: codexSkill.installed,
        deprecated: codexSkill.deprecated,
      },
      {
        root: '.codex/skills',
        scope: 'project',
        installed: true,
        deprecated: false,
      }
    );

    const importedSkill = manifest.skills.find((skill) => skill.name === 'legacy-import');
    assert.deepStrictEqual(
      {
        root: importedSkill.root,
        scope: importedSkill.scope,
        installed: importedSkill.installed,
        deprecated: importedSkill.deprecated,
      },
      {
        root: '.claude/gsd-core/skills',
        scope: 'import-only',
        installed: false,
        deprecated: true,
      }
    );

    const gsdSkill = manifest.skills.find((skill) => skill.name === 'gsd-help');
    assert.strictEqual(gsdSkill.installed, true);

    const legacyRoot = manifest.roots.find((root) => root.scope === 'legacy-commands');
    assert.ok(legacyRoot, 'legacy commands root should be reported');
    assert.strictEqual(legacyRoot.present, true);

    assert.strictEqual(manifest.installation.gsd_skills_installed, true);
    assert.strictEqual(manifest.installation.legacy_claude_commands_installed, true);
    assert.strictEqual(manifest.counts.skills, 7);
  });

  test('writes manifest to .planning/skill-manifest.json when --write flag is used', () => {
    const result = runGsdTools(['skill-manifest', '--write'], tmpDir, { HOME: homeDir, USERPROFILE: homeDir });
    assert.ok(result.success, `Command should succeed: ${result.error || result.output}`);

    const manifestPath = path.join(tmpDir, '.planning', 'skill-manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'skill-manifest.json should be written to .planning/');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.ok(Array.isArray(manifest.skills));
    assert.ok(manifest.installation);
  });

  test('global roots honor runtime-home env overrides instead of hardcoded home paths', () => {
    const result = runGsdTools(['skill-manifest'], tmpDir, {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CONFIG_DIR: path.join(homeDir, 'claude-custom'),
      CODEX_HOME: path.join(homeDir, 'codex-custom'),
    });
    assert.ok(result.success, `Command should succeed: ${result.error || result.output}`);

    const manifest = JSON.parse(result.output);
    const claudeRoot = manifest.roots.find((root) => root.root === '~/.claude/skills');
    const codexRoot = manifest.roots.find((root) => root.root === '~/.codex/skills');
    assert.ok(claudeRoot, 'Expected ~/.claude/skills root to be present');
    assert.ok(codexRoot, 'Expected ~/.codex/skills root to be present');
    assert.strictEqual(claudeRoot.path, path.join(homeDir, 'claude-custom', 'skills'));
    assert.strictEqual(codexRoot.path, path.join(homeDir, 'codex-custom', 'skills'));
  });

  // bug-929: nested layout discovery
  test('bug-929: discovers concrete skills nested under gsd-ns-* routers', () => {
    // Mirrors the on-disk shape that stageSkillsForRuntimeAsSkills emits for
    // cline/qwen/hermes/augment/trae/antigravity when nested=true:
    //   <root>/gsd-ns-workflow/SKILL.md             — router (top-level)
    //   <root>/gsd-ns-workflow/skills/plan/SKILL.md — concrete
    //   <root>/gsd-ns-workflow/skills/execute/SKILL.md — concrete
    //   <root>/gsd-ns-workflow/skills/spec-phase/SKILL.md — dual-routed concrete
    //   <root>/gsd-ns-manage/SKILL.md               — router (top-level)
    //   <root>/gsd-ns-manage/skills/progress/SKILL.md — concrete
    //   <root>/gsd-ns-manage/skills/spec-phase/SKILL.md — same dual-routed concrete (dedupe by name)
    //   <root>/gsd-standalone/SKILL.md              — flat top-level skill (no skills/ subdir)
    const skillsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-nested-skills-'));

    function writeNestedSkill(dir, name, description) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), [
        '---',
        `name: ${name}`,
        `description: ${description}`,
        '---',
        '',
        `# ${name}`,
      ].join('\n'));
    }

    // Router 1: gsd-ns-workflow
    writeNestedSkill(path.join(skillsDir, 'gsd-ns-workflow'), 'gsd-ns-workflow', 'Workflow router');
    writeNestedSkill(path.join(skillsDir, 'gsd-ns-workflow', 'skills', 'plan'), 'gsd-plan', 'Plan skill');
    writeNestedSkill(path.join(skillsDir, 'gsd-ns-workflow', 'skills', 'execute'), 'gsd-execute', 'Execute skill');
    writeNestedSkill(path.join(skillsDir, 'gsd-ns-workflow', 'skills', 'spec-phase'), 'gsd-spec-phase', 'Spec phase skill');

    // Router 2: gsd-ns-manage
    writeNestedSkill(path.join(skillsDir, 'gsd-ns-manage'), 'gsd-ns-manage', 'Manage router');
    writeNestedSkill(path.join(skillsDir, 'gsd-ns-manage', 'skills', 'progress'), 'gsd-progress', 'Progress skill');
    // Same spec-phase under a second router (dual-routed); must appear exactly once in manifest
    writeNestedSkill(path.join(skillsDir, 'gsd-ns-manage', 'skills', 'spec-phase'), 'gsd-spec-phase', 'Spec phase skill');

    // Flat top-level skill (not a router, no skills/ subdir)
    writeNestedSkill(path.join(skillsDir, 'gsd-standalone'), 'gsd-standalone', 'Standalone flat skill');

    const result = runGsdTools(['skill-manifest', '--skills-dir', skillsDir], tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error || result.output}`);

    const manifest = JSON.parse(result.output);
    const skillNames = manifest.skills.map((s) => s.name).sort();

    // 2 routers + 4 unique concretes (gsd-spec-phase deduped) + 1 flat = 7 total
    assert.deepStrictEqual(skillNames, [
      'gsd-execute',
      'gsd-ns-manage',
      'gsd-ns-workflow',
      'gsd-plan',
      'gsd-progress',
      'gsd-spec-phase',
      'gsd-standalone',
    ]);
    assert.strictEqual(manifest.counts.skills, 7, 'dual-routed concrete must be deduped to one entry');

    // Concrete skills should have a forward-slash nested file_path (posix-stable on all platforms)
    const planSkill = manifest.skills.find((s) => s.name === 'gsd-plan');
    assert.ok(planSkill, 'gsd-plan should be discovered');
    assert.ok(
      planSkill.file_path.includes('skills/plan'),
      `gsd-plan file_path should reflect nested location with forward slashes, got: ${planSkill.file_path}`
    );

    // Router should also appear as a skill entry
    const routerSkill = manifest.skills.find((s) => s.name === 'gsd-ns-workflow');
    assert.ok(routerSkill, 'gsd-ns-workflow router should be discovered as a top-level skill');

    cleanup(skillsDir);
  });

  test('bug-929: discovers nested concretes even when router has no top-level SKILL.md', () => {
    // Edge case: a router dir has a skills/ subdir with concretes but no top-level SKILL.md.
    // The concrete skills should still be discovered.
    const skillsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-router-only-skills-'));

    // Router dir with skills/ but no SKILL.md of its own
    const concreteDir = path.join(skillsDir, 'gsd-ns-noroot', 'skills', 'orphan-skill');
    fs.mkdirSync(concreteDir, { recursive: true });
    fs.writeFileSync(path.join(concreteDir, 'SKILL.md'), [
      '---',
      'name: gsd-orphan',
      'description: Orphan skill under router without top-level SKILL.md',
      '---',
      '',
      '# gsd-orphan',
    ].join('\n'));

    const result = runGsdTools(['skill-manifest', '--skills-dir', skillsDir], tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error || result.output}`);

    const manifest = JSON.parse(result.output);
    assert.deepStrictEqual(
      manifest.skills.map((s) => s.name).sort(),
      ['gsd-orphan'],
    );
    assert.strictEqual(manifest.counts.skills, 1);

    cleanup(skillsDir);
  });

  test('bug-929: flat layout (no nested skills/ subdirs) still works correctly', () => {
    const skillsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-flat-skills-'));

    function writeFlat(name, description) {
      const dir = path.join(skillsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), [
        '---',
        `name: ${name}`,
        `description: ${description}`,
        '---',
        '',
        `# ${name}`,
      ].join('\n'));
    }

    writeFlat('gsd-alpha', 'Alpha skill');
    writeFlat('gsd-beta', 'Beta skill');
    writeFlat('gsd-gamma', 'Gamma skill');

    const result = runGsdTools(['skill-manifest', '--skills-dir', skillsDir], tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error || result.output}`);

    const manifest = JSON.parse(result.output);
    assert.deepStrictEqual(
      manifest.skills.map((s) => s.name).sort(),
      ['gsd-alpha', 'gsd-beta', 'gsd-gamma']
    );
    assert.strictEqual(manifest.counts.skills, 3, 'flat layout count should be exact, no phantom nesting');

    cleanup(skillsDir);
  });

  test('bug-929: non-gsd-ns-* dirs with a skills/ subdir are NOT scanned (guard)', () => {
    // Regression guard for the `if (!entry.name.startsWith('gsd-ns-')) continue;` guard
    // in buildSkillManifest. A user tool dir like `my-tool/` that happens to have its
    // own `skills/` subdirectory must NOT have those skills vacuumed up.
    // Only `gsd-ns-<router>/skills/<stem>/SKILL.md` paths are in scope.
    const skillsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-guard-test-'));

    // Non-router dir with a flat SKILL.md at its own root — SHOULD be found (flat scan).
    const topLevelDir = path.join(skillsDir, 'my-tool');
    fs.mkdirSync(topLevelDir, { recursive: true });
    fs.writeFileSync(path.join(topLevelDir, 'SKILL.md'), [
      '---',
      'name: my-tool',
      'description: A user-defined top-level skill',
      '---',
      '',
      '# my-tool',
    ].join('\n'));

    // Non-router dir with a nested skills/ subdir — nested skills must NOT be discovered.
    const nestedDir = path.join(skillsDir, 'my-tool', 'skills', 'helper');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, 'SKILL.md'), [
      '---',
      'name: my-tool-helper',
      'description: A nested skill that must not be vacuumed up',
      '---',
      '',
      '# my-tool-helper',
    ].join('\n'));

    // Another non-router dir (prefixed differently, could look router-like but isn't)
    const otherDir = path.join(skillsDir, 'gsd-settings');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'SKILL.md'), [
      '---',
      'name: gsd-settings',
      'description: A flat gsd-* skill that is not a router',
      '---',
      '',
      '# gsd-settings',
    ].join('\n'));
    // Give gsd-settings its own skills/ subdir — must not be traversed since it's not gsd-ns-*
    const otherNestedDir = path.join(skillsDir, 'gsd-settings', 'skills', 'subsetting');
    fs.mkdirSync(otherNestedDir, { recursive: true });
    fs.writeFileSync(path.join(otherNestedDir, 'SKILL.md'), [
      '---',
      'name: gsd-subsetting',
      'description: A nested skill that must not be vacuumed up',
      '---',
      '',
      '# gsd-subsetting',
    ].join('\n'));

    const result = runGsdTools(['skill-manifest', '--skills-dir', skillsDir], tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error || result.output}`);

    const manifest = JSON.parse(result.output);
    const skillNames = manifest.skills.map((s) => s.name).sort();

    // Only the flat top-level SKILL.md entries should be found; nested non-router skills are ignored
    assert.deepStrictEqual(
      skillNames,
      ['gsd-settings', 'my-tool'],
      'nested skills under non-gsd-ns-* dirs must not be discovered',
    );
    assert.strictEqual(
      manifest.counts.skills,
      2,
      'only 2 top-level skills; nested non-router helpers must not inflate the count',
    );

    // Confirm the forbidden names are absent
    assert.ok(
      !skillNames.includes('my-tool-helper'),
      'my-tool/skills/helper/SKILL.md must not appear (guard: my-tool is not gsd-ns-*)',
    );
    assert.ok(
      !skillNames.includes('gsd-subsetting'),
      'gsd-settings/skills/subsetting/SKILL.md must not appear (guard: gsd-settings is not gsd-ns-*)',
    );

    cleanup(skillsDir);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2792-namespace-skills.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2792-namespace-skills (consolidation epic #1969 B3 #1972)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #2792)
// commands/gsd/*.md files ARE what the runtime loads — testing their
// frontmatter content tests the deployed system-prompt contract.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseRequires } = require('./helpers/nested-layout.cjs');

const COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');

const NAMESPACE_SKILLS = [
  { file: 'ns-workflow.md', name: 'gsd-workflow' },
  { file: 'ns-project.md',  name: 'gsd-project' },
  { file: 'ns-review.md',   name: 'gsd-quality' },
  { file: 'ns-context.md',  name: 'gsd-context' },
  { file: 'ns-manage.md',   name: 'gsd-manage' },
  { file: 'ns-ideate.md',   name: 'gsd-ideate' },
];

// Route targets named in any namespace body. The cross-reference test below
// asserts that every one of these resolves to a surviving command file or to
// a known consolidated parent (which absorbs flag-form invocations of folded
// skills, e.g. `gsd-map-codebase --fast` for the former `gsd-scan`).
const FLAG_FORM_PARENTS = new Set([
  'gsd-code-review',     // --fix absorbs former gsd-code-review-fix
  'gsd-map-codebase',    // --fast absorbs scan, --query absorbs intel
]);

/**
 * Parse the leading YAML frontmatter block of a markdown file into a
 * shallow `{ key: value }` map plus the trailing body. Splits on `\r?\n`
 * for CRLF tolerance and uses trimmed-line equality for the `---`
 * delimiters so whitespace-padded delimiter lines are accepted.
 */
function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  let openIdx = -1;
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      if (openIdx === -1) openIdx = i;
      else { closeIdx = i; break; }
    }
  }
  assert.ok(openIdx !== -1 && closeIdx !== -1, 'frontmatter block must be delimited by --- on its own lines');
  const fm = {};
  for (const line of lines.slice(openIdx + 1, closeIdx)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const value = raw.trim().replace(/^["']|["']$/g, '');
    fm[key] = value;
  }
  fm._body = lines.slice(closeIdx + 1).join('\n');
  return fm;
}

function readNamespaceFile(file) {
  const filePath = path.join(COMMANDS_DIR, file);
  assert.ok(fs.existsSync(filePath), `${file} must exist at ${filePath}`);
  return { filePath, ...parseFrontmatter(fs.readFileSync(filePath, 'utf-8')) };
}

// ── Frontmatter contract ───────────────────────────────────────────────

describe('Namespace skill files exist with correct name', () => {
  for (const { file, name } of NAMESPACE_SKILLS) {
    test(`${file} — name field is hyphen-form ${name}`, () => {
      const fm = readNamespaceFile(file);
      assert.strictEqual(
        fm.name,
        name,
        `name: in ${file} must be ${name} (hyphen form per #2858), got: ${fm.name}`,
      );
    });
  }
});

describe('Namespace skill descriptions are keyword-tag format', () => {
  for (const { file } of NAMESPACE_SKILLS) {
    test(`${file} — description ≤ 60 chars`, () => {
      const fm = readNamespaceFile(file);
      assert.ok(
        fm.description.length <= 60,
        `${file} description must be ≤ 60 chars, got ${fm.description.length}: ${fm.description}`,
      );
    });

    test(`${file} — description contains a pipe separator`, () => {
      const fm = readNamespaceFile(file);
      assert.ok(
        fm.description.includes('|'),
        `${file} description must contain | pipe separator, got: ${fm.description}`,
      );
    });

    test(`${file} — description does not start with prose ("Use " / "This skill")`, () => {
      const { description } = readNamespaceFile(file);
      assert.ok(
        !description.startsWith('Use ') && !description.startsWith('This skill'),
        `${file} description must not start with "Use " or "This skill", got: ${description}`,
      );
    });
  }
});

// ── allowed-tools must include Skill ──────────────────────────────────

describe('Namespace skills permit Skill execution', () => {
  for (const { file } of NAMESPACE_SKILLS) {
    test(`${file} — allowed-tools includes Skill`, () => {
      const filePath = path.join(COMMANDS_DIR, file);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const lines = raw.split(/\r?\n/);
      const startIdx = lines.findIndex((l) => l.trim() === 'allowed-tools:');
      assert.ok(startIdx !== -1, `${file} must declare an allowed-tools block`);
      const tools = [];
      for (let i = startIdx + 1; i < lines.length; i += 1) {
        const m = lines[i].match(/^\s+-\s+(\S+)/);
        if (!m) break;
        tools.push(m[1]);
      }
      assert.ok(
        tools.includes('Skill'),
        `${file} body invokes the Skill tool but allowed-tools does not include Skill (got: ${tools.join(', ')})`,
      );
    });
  }
});

// ── Body contains routing table ───────────────────────────────────────

describe('Namespace skill bodies carry a routing table', () => {
  for (const { file } of NAMESPACE_SKILLS) {
    test(`${file} — body contains "| User wants" table header`, () => {
      const fm = readNamespaceFile(file);
      const lines = fm._body.split('\n');
      const hasHeader = lines.some((l) => l.includes('| User wants'));
      assert.ok(hasHeader, `${file} body must contain a routing table starting with "| User wants"`);
    });

    test(`${file} — body has at least one Invoke target`, () => {
      const fm = readNamespaceFile(file);
      const hasInvoke = /\bgsd-[a-z-]+/i.test(fm._body);
      assert.ok(hasInvoke, `${file} body must reference at least one gsd-* sub-skill`);
    });
  }
});

// ── Context guard contract on gsd-health ──────────────────────────────
// Asserts the `--context` surface promised by #2792 is wired through to
// both the command frontmatter and the workflow body. The classifier
// itself is covered by tests/context-utilization.test.cjs and the SDK
// CLI by tests/validate-context.test.cjs.

describe('gsd-health --context flag is wired into command + workflow', () => {
  const HEALTH_CMD = path.join(COMMANDS_DIR, 'health.md');
  const HEALTH_WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'health.md');

  test('commands/gsd/health.md argument-hint advertises --context', () => {
    const raw = fs.readFileSync(HEALTH_CMD, 'utf-8');
    const fm = parseFrontmatter(raw);
    assert.ok(
      fm['argument-hint'] && fm['argument-hint'].includes('--context'),
      `health.md argument-hint must include --context, got: ${fm['argument-hint']}`,
    );
  });

  test('commands/gsd/health.md body documents the three-state utilization table', () => {
    const raw = fs.readFileSync(HEALTH_CMD, 'utf-8');
    const body = parseFrontmatter(raw)._body.toLowerCase();
    assert.ok(body.includes('healthy'), 'body must name the healthy state');
    assert.ok(body.includes('warning'), 'body must name the warning state');
    assert.ok(body.includes('critical'), 'body must name the critical state');
    assert.ok(
      body.includes('60%') && body.includes('70%'),
      'body must reference the 60% and 70% threshold boundaries',
    );
  });

  test('gsd-core/workflows/health.md has a context_check step', () => {
    const raw = fs.readFileSync(HEALTH_WORKFLOW, 'utf-8');
    assert.match(
      raw,
      /<step name="context_check">/,
      'workflow must define a <step name="context_check"> branch',
    );
  });

  test('workflow context_check invokes gsd-sdk query validate.context', () => {
    const raw = fs.readFileSync(HEALTH_WORKFLOW, 'utf-8');
    // Extract just the context_check step's body so a stray reference
    // elsewhere in the file can't satisfy this assertion.
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
    const stepMatch = raw.match(/<step name="context_check">([\s\S]*?)<\/step>/);
    assert.ok(stepMatch, 'context_check step must be a closed <step>...</step> block');
    const stepBody = stepMatch[1];
    // After #3797 architectural fix, callsites use gsd_run
    assert.match(
      stepBody,
      /gsd_run\s+query\s+validate\.context/,
      'context_check must call `gsd_run query validate.context`',
    );
    assert.match(stepBody, /--tokens-used/, 'context_check must pass --tokens-used');
    assert.match(stepBody, /--context-window/, 'context_check must pass --context-window');
  });
});

// ── Namespace nesting completeness (#69) ──────────────────────────────
// Guards that the install-layout nesting invariant (<=6 top-level entries)
// is always satisfiable: every router's requires list points at real files,
// every concrete skill is covered by at least one router, and each router's
// body table stays in sync with its requires list.

const NS_FILES = NAMESPACE_SKILLS.map((ns) => ns.file);

describe('namespace nesting completeness (#69)', () => {
  // Build the concrete-skill set once (all *.md minus ns-*.md)
  const allFiles = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
  const concreteStemSet = new Set(
    allFiles
      .filter((f) => !f.startsWith('ns-'))
      .map((f) => f.replace(/\.md$/, '')),
  );

  // Build per-router requires and the union over all routers
  const routerRequires = new Map(); // stem -> string[]
  for (const f of NS_FILES) {
    const stem = f.replace(/\.md$/, '');
    const content = fs.readFileSync(path.join(COMMANDS_DIR, f), 'utf-8');
    routerRequires.set(stem, parseRequires(content));
  }
  const allRoutedStems = new Set([...routerRequires.values()].flat());

  test('every router requires entry resolves to a real concrete skill file', () => {
    const bad = [];
    for (const [routerStem, children] of routerRequires) {
      for (const child of children) {
        if (!fs.existsSync(path.join(COMMANDS_DIR, `${child}.md`))) {
          bad.push(`${routerStem} → ${child}`);
        }
      }
    }
    assert.deepStrictEqual(
      bad,
      [],
      `Router requires entries with no matching commands/gsd/<stem>.md: ${bad.join(', ')}`,
    );
  });

  test('every concrete skill is routed by at least one namespace router', () => {
    const unrouted = [...concreteStemSet].filter((stem) => !allRoutedStems.has(stem));
    assert.deepStrictEqual(
      unrouted,
      [],
      `Concrete skills not routed by any ns-*.md (add to a router's requires:): ${unrouted.join(', ')}`,
    );
  });

  test("each router's routing-table rows reference only its own required sub-skills (plus flag variants)", () => {
    const bad = [];
    for (const [routerStem, children] of routerRequires) {
      const childSet = new Set(children);
      const content = fs.readFileSync(path.join(COMMANDS_DIR, `${routerStem}.md`), 'utf-8');
      const fm = parseFrontmatter(content);
      // Extract gsd-<stem> tokens from table data rows (last cell), strip flags
      for (const line of fm._body.split('\n')) {
        if (!line.startsWith('|') || /^\|[\s\-:|]+\|?\s*$/.test(line)) continue;
        const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
        if (cells.length < 2) continue;
        const lastCell = cells[cells.length - 1];
        for (const match of lastCell.matchAll(/\bgsd-([a-z][a-z0-9-]*)/g)) {
          const stem = match[1];
          if (!childSet.has(stem)) {
            bad.push(`${routerStem}: body table references gsd-${stem} but it's not in requires`);
          }
        }
      }
    }
    assert.deepStrictEqual(
      bad,
      [],
      `Routing table / requires mismatch:\n${bad.join('\n')}`,
    );
  });
});

// ── Cross-reference: every routed sub-skill must exist ─────────────────
// This is the regression guard the original PR lacked. Without it,
// post-#2790 consolidations can quietly invalidate router targets again.

describe('Namespace router targets resolve to surviving skills', () => {
  // Build the post-consolidation surviving set once.
  const surviving = new Set();
  for (const f of fs.readdirSync(COMMANDS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const base = f.replace(/\.md$/, '');
    if (base.startsWith('ns-')) continue; // namespace routers themselves
    surviving.add(`gsd-${base}`);
    // The PR #2858 rename canonicalized extract_learnings → extract-learnings.
    // Until #2790 rebases onto current main, accept either source filename
    // as resolving to the canonical hyphenated identifier.
    if (base === 'extract_learnings') surviving.add('gsd-extract-learnings');
  }

  for (const { file } of NAMESPACE_SKILLS) {
    test(`${file} — every routing target resolves`, () => {
      const fm = readNamespaceFile(file);
      // Extract every gsd-<name> token that appears in a table-row right column.
      // Strip flag suffixes (`gsd-foo --bar` → `gsd-foo`) before resolving.
      const targets = new Set();
      for (const line of fm._body.split('\n')) {
        // Only consider markdown table data rows: lines that start with `|`
        // and have content between pipes. Skip header / separator rows.
        if (!line.startsWith('|') || /^\|[\s\-:|]+\|?\s*$/.test(line)) continue;
        const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
        if (cells.length < 2) continue;
        for (const m of cells[cells.length - 1].matchAll(/\bgsd-[a-z][a-z0-9-]*/g)) {
          targets.add(m[0]);
        }
      }
      assert.ok(targets.size > 0, `${file} routing table must reference at least one gsd-* target`);
      const unresolved = [...targets].filter(
        (t) => !surviving.has(t) && !FLAG_FORM_PARENTS.has(t),
      );
      assert.deepStrictEqual(
        unresolved,
        [],
        `${file} routes to skills that don't exist in commands/gsd/: ${unresolved.join(', ')}`,
      );
    });
  }
});
  });
}

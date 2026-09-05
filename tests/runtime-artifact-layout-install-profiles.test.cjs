'use strict';
/**
 * Consolidated tests for the Runtime Artifact Layout Module — install-profiles parity (ADR-3660).
 *
 * Covers:
 *   - stageSkillsForProfile / stageAgentsForProfile / stageSkillsForRuntimeAsSkills
 *   - resolveProfile — transitive closure + PROFILES map
 *   - loadSkillsManifest — frontmatter parsing
 *   - readActiveProfile / writeActiveProfile — marker persistence
 *
 * Sources consolidated (4 files deleted):
 *   tests/install-profiles-stage.test.cjs
 *   tests/install-profiles-resolve.test.cjs
 *   tests/install-profiles-manifest.test.cjs
 *   tests/install-profiles-marker.test.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  stageSkillsForProfile,
  stageAgentsForProfile,
  stageSkillsForRuntimeAsSkills,
  cleanupStagedSkills,
  resolveProfile,
  loadSkillsManifest,
  readActiveProfile,
  writeActiveProfile,
  PROFILES,
  STAGED_DIRS,
  // #2322 security-hardening seams
  isSafeCapabilitySkillStem,
  readInstalledCapabilitySkill,
  capabilityClusterStems,
  CAPABILITY_SKILL_MARKER,
} = require('../gsd-core/bin/lib/install-profiles.cjs');
const { createTempDir, cleanup, writePackageSourceMarkerFixture } = require('./helpers.cjs');
const { resolveRuntimeArtifactLayout: resolveLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const REAL_AGENTS_DIR = path.join(__dirname, '..', 'agents');

// ─── helpers ────────────────────────────────────────────────────────────────

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'gsd-ip-'));
}

function createFixtureSkillsDir() {
  const tmp = createTempDir('gsd-stage-profile-');
  for (const name of ['plan-phase', 'execute-phase', 'autonomous', 'progress', 'help', 'phase']) {
    fs.writeFileSync(path.join(tmp, `${name}.md`), `# ${name}\n`);
  }
  return tmp;
}

function createFixtureAgentsDir() {
  const tmp = createTempDir('gsd-agents-profile-');
  for (const name of ['gsd-planner', 'gsd-executor', 'gsd-code-reviewer']) {
    fs.writeFileSync(path.join(tmp, `${name}.md`), `# ${name}\n`);
  }
  return tmp;
}

function writeSkill(dir, stem, frontmatter) {
  const content = `---\n${frontmatter}\n---\n\n# body\n`;
  fs.writeFileSync(path.join(dir, `${stem}.md`), content);
}

// ─── stageSkillsForRuntimeAsSkills ──────────────────────────────────────────

describe('stageSkillsForRuntimeAsSkills', () => {
  test('is exported as a function', () => {
    assert.strictEqual(typeof stageSkillsForRuntimeAsSkills, 'function');
  });

  test('registers stagedDir in STAGED_DIRS after staging', (t) => {
    const src = createTempDir('gsd-rta-src-');
    let stagedDir;
    t.after(() => {
      cleanup(src);
      if (stagedDir) cleanupStagedSkills();
    });
    fs.writeFileSync(path.join(src, 'alpha.md'), '# alpha\n');
    cleanupStagedSkills();
    const converter = (content, _skillName) => content;
    stagedDir = stageSkillsForRuntimeAsSkills(src, { skills: '*' }, converter, 'gsd-');
    assert.ok(STAGED_DIRS.has(stagedDir), 'stagedDir must be in STAGED_DIRS');
  });

  test('non-existent srcCommandsDir returns srcCommandsDir unchanged', () => {
    const ghost = path.join(os.tmpdir(), 'gsd-rta-no-exist-' + Date.now());
    const converter = (content, _skillName) => content;
    const result = stageSkillsForRuntimeAsSkills(ghost, { skills: '*' }, converter, 'gsd-');
    assert.strictEqual(result, ghost);
  });

  test('empty prefix produces <stem>/SKILL.md without prefix segment', (t) => {
    const src = createTempDir('gsd-rta-src-');
    let stagedDir;
    t.after(() => {
      cleanup(src);
      if (stagedDir) cleanupStagedSkills();
    });
    fs.writeFileSync(path.join(src, 'phase.md'), '# phase\n');
    const converter = (content, _skillName) => content;
    stagedDir = stageSkillsForRuntimeAsSkills(src, { skills: '*' }, converter, '');
    const entries = fs.readdirSync(stagedDir);
    assert.deepStrictEqual(entries, ['phase']);
    const content = fs.readFileSync(path.join(stagedDir, 'phase', 'SKILL.md'), 'utf8');
    assert.strictEqual(content, '# phase\n');
  });

  test('converter is called with (content, skillName) for each kept skill', (t) => {
    const src = createTempDir('gsd-rta-src-');
    let stagedDir;
    t.after(() => {
      cleanup(src);
      if (stagedDir) cleanupStagedSkills();
    });
    fs.writeFileSync(path.join(src, 'alpha.md'), '# alpha\n');
    fs.writeFileSync(path.join(src, 'beta.md'), '# beta\n');
    const calls = [];
    const converter = (content, skillName) => {
      calls.push([content, skillName]);
      return content;
    };
    stagedDir = stageSkillsForRuntimeAsSkills(src, { skills: '*' }, converter, 'x-');
    assert.strictEqual(calls.length, 2);
    const callMap = Object.fromEntries(calls.map(([c, n]) => [n, c]));
    assert.strictEqual(callMap['x-alpha'], '# alpha\n');
    assert.strictEqual(callMap['x-beta'], '# beta\n');
  });

  test('skills Set filters: only matching stems land in stagedDir', (t) => {
    const src = createTempDir('gsd-rta-src-');
    let stagedDir;
    t.after(() => {
      cleanup(src);
      if (stagedDir) cleanupStagedSkills();
    });
    for (const name of ['alpha', 'beta', 'phase']) {
      fs.writeFileSync(path.join(src, `${name}.md`), `# ${name}\n`);
    }
    const converter = (content, _skillName) => content;
    stagedDir = stageSkillsForRuntimeAsSkills(src, { skills: new Set(['phase']) }, converter, 'gsd-');
    const entries = fs.readdirSync(stagedDir).sort();
    assert.deepStrictEqual(entries, ['gsd-phase']);
  });

  test('skills === "*" stages all md files as <prefix><stem>/SKILL.md', (t) => {
    const src = createTempDir('gsd-rta-src-');
    let stagedDir;
    t.after(() => {
      cleanup(src);
      if (stagedDir) cleanupStagedSkills();
    });
    for (const name of ['alpha', 'beta', 'gamma']) {
      fs.writeFileSync(path.join(src, `${name}.md`), `# ${name}\n`);
    }
    const converter = (content, _skillName) => content;
    stagedDir = stageSkillsForRuntimeAsSkills(src, { skills: '*' }, converter, 'gsd-');
    const entries = fs.readdirSync(stagedDir).sort();
    assert.deepStrictEqual(entries, ['gsd-alpha', 'gsd-beta', 'gsd-gamma']);
    for (const name of ['alpha', 'beta', 'gamma']) {
      const content = fs.readFileSync(path.join(stagedDir, `gsd-${name}`, 'SKILL.md'), 'utf8');
      assert.strictEqual(content, `# ${name}\n`);
    }
  });
});

// ─── stageSkillsForProfile ───────────────────────────────────────────────────

describe('stageSkillsForProfile', () => {
  test('full profile (skills === "*") returns srcDir unchanged', (t) => {
    const src = createFixtureSkillsDir();
    t.after(() => cleanup(src));
    const result = stageSkillsForProfile(src, { skills: '*', agents: new Set() });
    assert.strictEqual(result, src);
  });

  test('profile with Set copies only member files', (t) => {
    const src = createFixtureSkillsDir();
    let staged;
    t.after(() => {
      cleanup(src);
      if (staged) cleanupStagedSkills();
    });
    const skills = new Set(['plan-phase', 'help', 'phase']);
    staged = stageSkillsForProfile(src, { skills, agents: new Set() });
    assert.notStrictEqual(staged, src);
    const files = fs.readdirSync(staged).sort();
    assert.deepStrictEqual(files, ['help.md', 'phase.md', 'plan-phase.md']);
  });

  test('preserves file content byte-for-byte', (t) => {
    const src = createFixtureSkillsDir();
    const content = '# plan-phase special content\n\nsome body\n';
    fs.writeFileSync(path.join(src, 'plan-phase.md'), content);
    let staged;
    t.after(() => {
      cleanup(src);
      if (staged) cleanupStagedSkills();
    });
    const skills = new Set(['plan-phase']);
    staged = stageSkillsForProfile(src, { skills, agents: new Set() });
    const copied = fs.readFileSync(path.join(staged, 'plan-phase.md'), 'utf8');
    assert.strictEqual(copied, content);
  });

  test('non-existent srcDir returns srcDir unchanged', () => {
    const ghost = path.join(os.tmpdir(), 'gsd-no-exist-' + Date.now());
    const result = stageSkillsForProfile(ghost, { skills: new Set(['help']), agents: new Set() });
    assert.strictEqual(result, ghost);
  });

  test('empty skills Set produces empty staged dir', (t) => {
    const src = createFixtureSkillsDir();
    let staged;
    t.after(() => {
      cleanup(src);
      if (staged) cleanupStagedSkills();
    });
    staged = stageSkillsForProfile(src, { skills: new Set(), agents: new Set() });
    const files = fs.readdirSync(staged);
    assert.deepStrictEqual(files, []);
  });
});

// ─── stageAgentsForProfile ───────────────────────────────────────────────────

describe('stageAgentsForProfile', () => {
  test('full profile (skills === "*") returns srcDir unchanged', (t) => {
    const src = createFixtureAgentsDir();
    t.after(() => cleanup(src));
    const result = stageAgentsForProfile(src, { skills: '*', agents: new Set() });
    assert.strictEqual(result, src);
  });

  test('non-full profile with empty agents Set produces empty staged dir', (t) => {
    const src = createFixtureAgentsDir();
    let staged;
    t.after(() => {
      cleanup(src);
      if (staged) cleanupStagedSkills();
    });
    staged = stageAgentsForProfile(src, { skills: new Set(['help']), agents: new Set() });
    const files = fs.readdirSync(staged);
    assert.deepStrictEqual(files, [], 'no agents for non-full profile by default');
  });

  test('non-full profile with agents Set copies only member agent files', (t) => {
    const src = createFixtureAgentsDir();
    let staged;
    t.after(() => {
      cleanup(src);
      if (staged) cleanupStagedSkills();
    });
    const agents = new Set(['gsd-planner']);
    staged = stageAgentsForProfile(src, { skills: new Set(['plan-phase']), agents });
    const files = fs.readdirSync(staged).sort();
    assert.deepStrictEqual(files, ['gsd-planner.md']);
  });

  test('non-existent srcAgentsDir returns srcAgentsDir unchanged', () => {
    const ghost = path.join(os.tmpdir(), 'gsd-agents-no-exist-' + Date.now());
    const result = stageAgentsForProfile(ghost, { skills: new Set(), agents: new Set() });
    assert.strictEqual(result, ghost);
  });

  test('standard profile — stageAgentsForProfile copies exactly the agents in resolvedProfile.agents', (t) => {
    if (!fs.existsSync(REAL_AGENTS_DIR) || !fs.existsSync(REAL_COMMANDS_DIR)) return;
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const resolved = resolveProfile({ modes: ['standard'], manifest });
    assert.ok(resolved.agents instanceof Set && resolved.agents.size > 0,
      'standard profile must have >0 agents (plan-phase calls gsd-planner etc)');
    let staged;
    t.after(() => {
      if (staged) cleanupStagedSkills();
    });
    staged = stageAgentsForProfile(REAL_AGENTS_DIR, resolved);
    const stagedFiles = new Set(
      fs.readdirSync(staged).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3))
    );
    for (const stem of stagedFiles) {
      assert.ok(resolved.agents.has(stem), `staged agent ${stem} not in resolved.agents`);
    }
    for (const agentStem of resolved.agents) {
      const exists = fs.existsSync(path.join(REAL_AGENTS_DIR, `${agentStem}.md`));
      if (exists) {
        assert.ok(stagedFiles.has(agentStem), `resolved agent ${agentStem} missing from staged dir`);
      }
    }
  });

  test('full profile staging returns real agents dir unchanged', () => {
    if (!fs.existsSync(REAL_AGENTS_DIR)) return;
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const resolved = resolveProfile({ modes: ['full'], manifest });
    const result = stageAgentsForProfile(REAL_AGENTS_DIR, resolved);
    assert.strictEqual(result, REAL_AGENTS_DIR);
  });
});

// ─── PROFILES map + resolveProfile ──────────────────────────────────────────

describe('PROFILES map', () => {
  test('PROFILES is frozen', () => {
    assert.ok(Object.isFrozen(PROFILES));
  });

  test('PROFILES has core, standard, full keys', () => {
    assert.ok('core' in PROFILES, 'PROFILES.core missing');
    assert.ok('standard' in PROFILES, 'PROFILES.standard missing');
    assert.ok('full' in PROFILES, 'PROFILES.full missing');
  });

  test('PROFILES.core contains the 8 main-loop skills (including phase and surface)', () => {
    const core = PROFILES.core;
    assert.ok(Array.isArray(core), 'core should be an array');
    const sorted = [...core].sort();
    assert.deepStrictEqual(sorted, [
      'discuss-phase',
      'execute-phase',
      'help',
      'new-project',
      'phase',
      'plan-phase',
      'surface',
      'update',
    ]);
  });

  test('PROFILES.full is the sentinel "*"', () => {
    assert.strictEqual(PROFILES.full, '*');
  });

  test('PROFILES.standard contains at least the core skills', () => {
    const core = new Set(PROFILES.core);
    const standard = PROFILES.standard;
    assert.ok(Array.isArray(standard), 'standard should be an array');
    for (const s of core) {
      assert.ok(standard.includes(s), `standard should include core skill: ${s}`);
    }
  });

  test('PROFILES.standard has at least 10 skills', () => {
    assert.ok(PROFILES.standard.length >= 10, `standard should have >=10 skills, got ${PROFILES.standard.length}`);
  });
});

describe('resolveProfile', () => {
  test('defaults to full when called with no modes arg', () => {
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const result = resolveProfile({ manifest });
    assert.strictEqual(result.name, 'full');
    assert.strictEqual(result.skills, '*');
  });

  test('resolves core profile — returns 8+ skills, all base stems present', () => {
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const result = resolveProfile({ modes: ['core'], manifest });
    assert.strictEqual(result.name, 'core');
    assert.ok(result.skills instanceof Set, 'skills should be a Set');
    // core has 8 base skills (includes surface as of #3735).
    assert.ok(result.skills.size >= 8, `core closure should have >=8 skills, got ${result.skills.size}`);
    for (const s of PROFILES.core) {
      assert.ok(result.skills.has(s), `core closure should include ${s}`);
    }
    assert.ok(result.skills.has('phase'), 'core closure must include phase');
  });

  test('resolves standard profile — superset of core', () => {
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const coreResult = resolveProfile({ modes: ['core'], manifest });
    const stdResult = resolveProfile({ modes: ['standard'], manifest });
    assert.strictEqual(stdResult.name, 'standard');
    assert.ok(stdResult.skills instanceof Set);
    assert.ok(stdResult.skills.size >= coreResult.skills.size, 'standard should have >= skills than core');
    for (const s of coreResult.skills) {
      assert.ok(stdResult.skills.has(s), `standard must include core skill: ${s}`);
    }
  });

  test('standard profile includes the onboard manager handoff dependency', () => {
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const result = resolveProfile({ modes: ['standard'], manifest });
    assert.ok(result.skills instanceof Set);
    assert.ok(result.skills.has('onboard'), 'standard profile should include onboard');
    assert.ok(result.skills.has('manager'), 'onboard handoff must install gsd-manager');
  });

  test('resolves full profile — returns sentinel', () => {
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const result = resolveProfile({ modes: ['full'], manifest });
    assert.strictEqual(result.name, 'full');
    assert.strictEqual(result.skills, '*');
  });

  test('composable profiles — core,standard union is same as standard', () => {
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const stdResult = resolveProfile({ modes: ['standard'], manifest });
    const composed = resolveProfile({ modes: ['core', 'standard'], manifest });
    assert.ok(composed.name.includes('core') && composed.name.includes('standard'),
      `composed name should include both, got: ${composed.name}`);
    for (const s of stdResult.skills) {
      assert.ok(composed.skills.has(s), `composed should include standard skill: ${s}`);
    }
  });

  test('transitive closure: skill that requires phase pulls in phase', () => {
    const manifest = new Map([
      ['discuss-phase', ['phase']],
      ['phase', []],
      ['help', []],
    ]);
    const miniProfiles = { core: ['discuss-phase', 'help'], full: '*', standard: ['discuss-phase', 'help'] };
    const result = resolveProfile({ modes: ['core'], manifest, _profilesOverride: miniProfiles });
    assert.ok(result.skills.has('phase'), 'phase should be pulled in via closure from discuss-phase');
    assert.ok(result.skills.has('discuss-phase'));
    assert.ok(result.skills.has('help'));
  });

  test('deep transitive closure works (A→B→C pulls in C)', () => {
    const manifest = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', []],
    ]);
    const miniProfiles = { core: ['a'], full: '*', standard: ['a'] };
    const result = resolveProfile({ modes: ['core'], manifest, _profilesOverride: miniProfiles });
    assert.ok(result.skills.has('a'));
    assert.ok(result.skills.has('b'));
    assert.ok(result.skills.has('c'));
  });

  test('result has agents Set', () => {
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const result = resolveProfile({ modes: ['core'], manifest });
    assert.ok(result.agents instanceof Set, 'result should have agents Set');
  });

  test('standard — agents Set is non-empty; gsd-planner and gsd-plan-checker present', () => {
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const result = resolveProfile({ modes: ['standard'], manifest });
    assert.ok(result.agents instanceof Set, 'agents should be a Set');
    assert.ok(result.agents.size > 0, `standard profile should have >0 agents, got ${result.agents.size}`);
    assert.ok(result.agents.has('gsd-planner'), 'standard should include gsd-planner');
    assert.ok(result.agents.has('gsd-plan-checker'), 'standard should include gsd-plan-checker');
  });

  test('full — agents is a Set (full staging uses srcDir directly)', () => {
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const result = resolveProfile({ modes: ['full'], manifest });
    assert.strictEqual(result.skills, '*');
    assert.ok(result.agents instanceof Set, 'agents should still be a Set for full');
  });

  test('agents are derived from real manifest body text (gsd-planner from plan-phase)', () => {
    const realManifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const result = resolveProfile({ modes: ['standard'], manifest: realManifest });
    assert.ok(result.agents.has('gsd-planner'), 'gsd-planner should be derived from plan-phase body');
  });

  test('agents transitively closed — plan-phase in standard brings its agents', () => {
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const result = resolveProfile({ modes: ['standard'], manifest });
    assert.ok(result.agents.has('gsd-planner'));
  });
});

// ─── loadSkillsManifest ──────────────────────────────────────────────────────

describe('loadSkillsManifest', () => {
  test('returns a Map', () => {
    const dir = tmpDir('gsd-manifest-fixture-');
    try {
      const m = loadSkillsManifest(dir);
      assert.ok(m instanceof Map, 'should return a Map');
    } finally {
      cleanup(dir);
    }
  });

  test('skill with no requires: frontmatter maps to empty array', () => {
    const dir = tmpDir('gsd-manifest-fixture-');
    try {
      writeSkill(dir, 'help', 'name: gsd:help\ndescription: Help text');
      const m = loadSkillsManifest(dir);
      assert.ok(m.has('help'), 'help should be in manifest');
      assert.deepStrictEqual(m.get('help'), []);
    } finally {
      cleanup(dir);
    }
  });

  test('skill with requires: single value maps to array of one', () => {
    const dir = tmpDir('gsd-manifest-fixture-');
    try {
      writeSkill(dir, 'add-tests', 'name: gsd:add-tests\ndescription: Add tests\nrequires: [phase]');
      const m = loadSkillsManifest(dir);
      assert.ok(m.has('add-tests'));
      assert.deepStrictEqual(m.get('add-tests'), ['phase']);
    } finally {
      cleanup(dir);
    }
  });

  test('skill with requires: multiple values maps to full array', () => {
    const dir = tmpDir('gsd-manifest-fixture-');
    try {
      writeSkill(dir, 'plan-phase', 'name: gsd:plan-phase\ndescription: Plan\nrequires: [discuss-phase, phase, review, update]');
      const m = loadSkillsManifest(dir);
      assert.deepStrictEqual(m.get('plan-phase'), ['discuss-phase', 'phase', 'review', 'update']);
    } finally {
      cleanup(dir);
    }
  });

  test('ignores non-.md files in the dir', () => {
    const dir = tmpDir('gsd-manifest-fixture-');
    try {
      writeSkill(dir, 'help', 'name: gsd:help\ndescription: Help');
      fs.writeFileSync(path.join(dir, 'README.txt'), 'not a skill');
      fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
      const m = loadSkillsManifest(dir);
      assert.ok(m.has('help'));
      assert.ok(!m.has('README'));
      assert.ok(!m.has('notes'));
    } finally {
      cleanup(dir);
    }
  });

  test('empty dir returns empty Map', () => {
    const dir = tmpDir('gsd-manifest-fixture-');
    try {
      const m = loadSkillsManifest(dir);
      assert.strictEqual(m.size, 0);
    } finally {
      cleanup(dir);
    }
  });

  test('skill with requires: empty array maps to empty array', () => {
    const dir = tmpDir('gsd-manifest-fixture-');
    try {
      writeSkill(dir, 'explore', 'name: gsd:explore\ndescription: Explore\nrequires: []');
      const m = loadSkillsManifest(dir);
      assert.deepStrictEqual(m.get('explore'), []);
    } finally {
      cleanup(dir);
    }
  });

  test('loads real commands/gsd/ directory: >=60 skills, discuss-phase deps correct, help has no requires', () => {
    const m = loadSkillsManifest(REAL_COMMANDS_DIR);
    // Use prefix/set assertion, not a hardcoded count — avoids stale-count anti-pattern
    assert.ok(m.size >= 60, `expected >=60 skills, got ${m.size}`);
    const depsDP = m.get('discuss-phase');
    assert.ok(Array.isArray(depsDP), 'discuss-phase should be in manifest');
    assert.ok(depsDP.includes('phase'), 'discuss-phase should require phase');
    assert.ok(depsDP.includes('config'), 'discuss-phase should require config');
    assert.deepStrictEqual(m.get('help'), []);
  });
});

// ─── readActiveProfile / writeActiveProfile ──────────────────────────────────

describe('readActiveProfile / writeActiveProfile', () => {
  test('write then read round-trips the profile name', () => {
    const dir = tmpDir('gsd-marker-');
    try {
      writeActiveProfile(dir, 'standard');
      assert.strictEqual(readActiveProfile(dir), 'standard');
    } finally {
      cleanup(dir);
    }
  });

  test('round-trips "core" profile', () => {
    const dir = tmpDir('gsd-marker-');
    try {
      writeActiveProfile(dir, 'core');
      assert.strictEqual(readActiveProfile(dir), 'core');
    } finally {
      cleanup(dir);
    }
  });

  test('round-trips composed profiles "core,audit"', () => {
    const dir = tmpDir('gsd-marker-');
    try {
      writeActiveProfile(dir, 'core,audit');
      assert.strictEqual(readActiveProfile(dir), 'core,audit');
    } finally {
      cleanup(dir);
    }
  });

  test('round-trips "full"', () => {
    const dir = tmpDir('gsd-marker-');
    try {
      writeActiveProfile(dir, 'full');
      assert.strictEqual(readActiveProfile(dir), 'full');
    } finally {
      cleanup(dir);
    }
  });

  test('missing marker file returns null (not throws)', () => {
    const dir = tmpDir('gsd-marker-');
    try {
      const result = readActiveProfile(dir);
      assert.strictEqual(result, null);
    } finally {
      cleanup(dir);
    }
  });

  test('non-existent directory returns null (not throws)', () => {
    const ghost = path.join(os.tmpdir(), 'gsd-marker-no-exist-' + Date.now());
    const result = readActiveProfile(ghost);
    assert.strictEqual(result, null);
  });

  test('corrupt marker content (invalid chars) returns null', () => {
    const dir = tmpDir('gsd-marker-');
    try {
      fs.writeFileSync(path.join(dir, '.gsd-profile'), 'profile with spaces and !!!\n');
      const result = readActiveProfile(dir);
      assert.strictEqual(result, null);
    } finally {
      cleanup(dir);
    }
  });

  test('empty marker file returns null', () => {
    const dir = tmpDir('gsd-marker-');
    try {
      fs.writeFileSync(path.join(dir, '.gsd-profile'), '');
      const result = readActiveProfile(dir);
      assert.strictEqual(result, null);
    } finally {
      cleanup(dir);
    }
  });

  test('writeActiveProfile creates the directory if it does not exist', () => {
    const base = tmpDir('gsd-marker-base-');
    const nested = path.join(base, 'skills', '.claude');
    try {
      writeActiveProfile(nested, 'standard');
      assert.ok(fs.existsSync(nested), 'directory should be created');
      assert.strictEqual(readActiveProfile(nested), 'standard');
    } finally {
      cleanup(base);
    }
  });

  test('overwrites a previously written profile', () => {
    const dir = tmpDir('gsd-marker-');
    try {
      writeActiveProfile(dir, 'core');
      writeActiveProfile(dir, 'full');
      assert.strictEqual(readActiveProfile(dir), 'full');
    } finally {
      cleanup(dir);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3659-applysurface-prune-skill-dirs.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3659-applysurface-prune-skill-dirs (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * Regression test for bug #3659
 *
 * applySurface did not prune ~/.claude/skills/gsd-STEM dirs when a cluster
 * was disabled. install/uninstall both prune correctly via _removeGsdEntries;
 * applySurface called _syncGsdDir with the right logic but the surface.md spec
 * directed the AI to use RUNTIME_CONFIG_DIR=~/.claude/skills (the skills dir
 * itself) instead of the base Claude config dir (~/.claude).
 *
 * When runtimeConfigDir = ~/.claude/skills and scope = 'global':
 *   kind.destSubpath = 'skills'
 *   dest = path.join('~/.claude/skills', 'skills') = ~/.claude/skills/skills  WRONG
 *
 * The pruning ran against the wrong (non-existent) dir so stale gsd-Y dirs
 * were never removed from ~/.claude/skills/.
 *
 * Fix:
 *   1. surface.md RUNTIME_CONFIG_DIR changed to use the base Claude config dir
 *      (getGlobalDir('claude') = ~/.claude), not ~/.claude/skills.
 *   2. Surface state file moves to <configDir>/.gsd-surface.json at the config
 *      root, matching install/uninstall conventions.
 *   3. applySurface is called with scope='global' so the skills kind is active.
 *
 * Tests:
 *   a) disabled cluster gsd-STEM dirs are REMOVED from ~/.claude/skills/
 *   b) gsd-STEM dirs in the retain set are preserved
 *   c) non-gsd dirs are UNTOUCHED (user-owned)
 *   d) idempotence: running applySurface twice produces the same on-disk state
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { writeSurface, applySurface } = require('../gsd-core/bin/lib/surface.cjs');
const { loadSkillsManifest } = require('../gsd-core/bin/lib/install-profiles.cjs');
const { CLUSTERS } = require('../gsd-core/bin/lib/clusters.cjs');
const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');

/**
 * Build a minimal fixture simulating a Claude global install.
 *
 * configDir  — analogous to ~/.claude
 * skillsDir  — analogous to ~/.claude/skills (contains gsd-* dirs)
 *
 * Pre-populated with:
 *   gsd-explore/SKILL.md  — in research_ideate cluster (will be disabled)
 *   gsd-help/SKILL.md     — in core_loop cluster (will remain enabled)
 *   my-custom-skill/      — user-owned, not gsd-prefixed (must never be touched)
 */
function createFixture() {
  const configDir = createTempDir('gsd-bug3659-');
  const skillsDir = path.join(configDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.gsd-source'), REAL_COMMANDS_DIR + '\n');

  const gsdExplore = path.join(skillsDir, 'gsd-explore');
  const gsdHelp = path.join(skillsDir, 'gsd-help');
  const userSkill = path.join(skillsDir, 'my-custom-skill');

  for (const d of [gsdExplore, gsdHelp, userSkill]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), '# skill\n', 'utf8');
  }

  return { configDir, skillsDir, gsdExplore, gsdHelp, userSkill };
}

/**
 * Extended fixture that also includes a user-created gsd-* directory.
 * Used by the all-clusters-disabled counter-test to prove the manifest-membership
 * gate (Finding 1 fix) protects user-owned gsd-* dirs from data loss.
 */
function createFixtureWithUserGsdDir() {
  const base = createFixture();
  const userGsdDir = path.join(base.skillsDir, 'gsd-mything');
  fs.mkdirSync(userGsdDir, { recursive: true });
  fs.writeFileSync(path.join(userGsdDir, 'SKILL.md'), '# user skill\n', 'utf8');
  return { ...base, userGsdDir };
}

describe('bug-3659: applySurface prunes ~/.claude/skills/gsd-*/ on cluster disable', () => {
  test('(a) disabled cluster gsd-* dirs are removed from skills dir', (t) => {
    const { configDir, gsdExplore, gsdHelp } = createFixture();
    t.after(() => cleanup(configDir));

    // Surface state at configDir (= ~/.claude), NOT at skillsDir (= ~/.claude/skills).
    // This is the corrected location after the fix.
    writeSurface(configDir, {
      baseProfile: 'full',
      disabledClusters: ['research_ideate'], // contains 'explore'
      explicitAdds: [],
      explicitRemoves: [],
    });

    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    // scope='global' gives the skills kind for Claude (destSubpath='skills', prefix='gsd-')
    const layout = resolveRuntimeArtifactLayout('claude', configDir, 'global');
    applySurface(configDir, layout, manifest, CLUSTERS);

    // gsd-explore is in the research_ideate cluster which was disabled:
    // it must be pruned from skillsDir.
    assert.ok(
      !fs.existsSync(gsdExplore),
      'gsd-explore/ must be removed from skills dir when research_ideate cluster is disabled'
    );

    // gsd-help is in core_loop (not disabled) and must survive.
    assert.ok(
      fs.existsSync(gsdHelp),
      'gsd-help/ must be preserved when its cluster is not disabled'
    );
  });

  test('(b) gsd-* dirs in retained clusters are preserved', (t) => {
    const { configDir, gsdHelp } = createFixture();
    t.after(() => cleanup(configDir));

    // Disable a cluster that does NOT include help (core_loop has help)
    writeSurface(configDir, {
      baseProfile: 'full',
      disabledClusters: ['research_ideate'],
      explicitAdds: [],
      explicitRemoves: [],
    });

    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const layout = resolveRuntimeArtifactLayout('claude', configDir, 'global');
    applySurface(configDir, layout, manifest, CLUSTERS);

    assert.ok(
      fs.existsSync(gsdHelp),
      'gsd-help/ must be preserved — core_loop cluster remains enabled'
    );
  });

  test('(c) non-gsd user dirs are untouched', (t) => {
    const { configDir, userSkill } = createFixture();
    t.after(() => cleanup(configDir));

    writeSurface(configDir, {
      baseProfile: 'full',
      disabledClusters: ['research_ideate'],
      explicitAdds: [],
      explicitRemoves: [],
    });

    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const layout = resolveRuntimeArtifactLayout('claude', configDir, 'global');
    applySurface(configDir, layout, manifest, CLUSTERS);

    assert.ok(
      fs.existsSync(userSkill),
      'my-custom-skill/ (non-gsd user dir) must be preserved by applySurface'
    );
    assert.ok(
      fs.existsSync(path.join(userSkill, 'SKILL.md')),
      'user skill SKILL.md must be untouched'
    );
  });

  test('(d) idempotence: running applySurface twice produces identical on-disk state', (t) => {
    const { configDir, skillsDir, gsdExplore, userSkill } = createFixture();
    t.after(() => cleanup(configDir));

    writeSurface(configDir, {
      baseProfile: 'full',
      disabledClusters: ['research_ideate'],
      explicitAdds: [],
      explicitRemoves: [],
    });

    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const layout = resolveRuntimeArtifactLayout('claude', configDir, 'global');

    // First apply
    applySurface(configDir, layout, manifest, CLUSTERS);
    const afterFirst = fs.readdirSync(skillsDir).sort();

    // Second apply — must produce exactly the same set
    applySurface(configDir, layout, manifest, CLUSTERS);
    const afterSecond = fs.readdirSync(skillsDir).sort();

    assert.deepStrictEqual(
      afterSecond,
      afterFirst,
      'skills dir contents must be identical after two consecutive applySurface calls (idempotent)'
    );

    // Double-check the pruned dir is gone after both runs
    assert.ok(
      !fs.existsSync(gsdExplore),
      'gsd-explore/ must remain absent after second applySurface call'
    );

    // User dir must survive both runs
    assert.ok(
      fs.existsSync(userSkill),
      'my-custom-skill/ must survive both applySurface calls'
    );
  });

  test('(e) all-clusters-disabled: all gsd-owned dirs removed; user dirs and user gsd-* dirs survive', (t) => {
    // Counter-test for Finding 1 (data-loss class) and Finding 3 (missing coverage).
    //
    // Disables EVERY cluster so the resolved skill set is empty.
    // Assertions:
    //   1. gsd-explore/ — GSD-owned, disabled cluster → REMOVED
    //   2. gsd-help/    — GSD-owned, disabled cluster → REMOVED
    //   3. my-custom-skill/ — user-owned, no gsd- prefix → PRESERVED
    //   4. gsd-mything/ — prefix match but NOT in manifest → PRESERVED (Finding 1 fix)
    const { configDir, gsdExplore, gsdHelp, userSkill, userGsdDir } =
      createFixtureWithUserGsdDir();
    t.after(() => cleanup(configDir));

    const allClusters = Object.keys(CLUSTERS);

    writeSurface(configDir, {
      baseProfile: 'full',
      disabledClusters: allClusters,
      explicitAdds: [],
      explicitRemoves: [],
    });

    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const layout = resolveRuntimeArtifactLayout('claude', configDir, 'global');
    applySurface(configDir, layout, manifest, CLUSTERS);

    // 1. GSD-owned dirs in now-disabled clusters must be removed.
    assert.ok(
      !fs.existsSync(gsdExplore),
      'gsd-explore/ must be removed when all clusters are disabled'
    );
    assert.ok(
      !fs.existsSync(gsdHelp),
      'gsd-help/ must be removed when all clusters are disabled'
    );

    // 2. Non-gsd user dir must be preserved regardless.
    assert.ok(
      fs.existsSync(userSkill),
      'my-custom-skill/ (non-gsd user dir) must survive when all clusters are disabled'
    );

    // 3. User-created gsd-* dir NOT in the manifest must be preserved.
    //    This is the critical Finding 1 regression guard: without the manifest-membership
    //    gate, gsd-mything/ would have been silently deleted.
    assert.ok(
      fs.existsSync(userGsdDir),
      'gsd-mything/ (user-created gsd-* dir not in manifest) must be preserved — ' +
      'prefix match alone must not trigger deletion (Finding 1 data-loss fix)'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// #2322: applySurface never materializes installed third-party capability
// skills (~/.gsd/capabilities/<id>/skills/<stem>/SKILL.md) — the registry
// (#2045) reports surfaced:true but stageSkillsForRuntimeAsSkills only ever
// iterates findInstallSourceRoot(configDir) (gsd-core's own bundled
// commands/gsd), so a stem that lives only under the capabilities root is
// silently dropped: no error, no file on disk, /gsd-<stem> not invocable.
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __issueDescribe, test: __issueTest } = require('node:test');
  const surfaceMod = require('../gsd-core/bin/lib/surface.cjs');
  const { writeSurface: __writeSurface, applySurface: __applySurface } = surfaceMod;
  const __resolveRuntimeArtifactLayout = resolveLayout;

  /** Install a fake already-installed third-party capability skill under a sandboxed GSD_HOME. */
  function __installCapSkill(gsdHome, capId, stem, content) {
    const skillDir = path.join(gsdHome, '.gsd', 'capabilities', capId, 'skills', stem);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  }

  /** A minimal capability-registry shape carrying one capId -> [stems] cluster. */
  function __registryFor(capId, stems, tier = 'standard') {
    return {
      capabilityClusters: { [capId]: stems },
      profileMembership: { [capId]: { tier, profiles: tier === 'core' ? ['core', 'standard', 'full'] : ['standard', 'full'] } },
    };
  }

  /**
   * Recursively snapshot every FILE under dir into a Map<relPath, content>.
   * NOTE: converters embed the absolute configDir in some skill bodies (e.g.
   * `@`-workflow-file references), so two DIFFERENT tmp configDirs never
   * produce byte-identical output even with identical inputs. Every
   * before/after comparison below therefore re-applies to the SAME configDir
   * (snapshot -> mutate -> re-snapshot) rather than comparing two distinct
   * directories.
   */
  function __snapshotDir(dir) {
    const snap = new Map();
    const walk = (rel) => {
      const abs = path.join(dir, rel);
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const relChild = path.join(rel, entry.name);
        if (entry.isDirectory()) walk(relChild);
        else if (entry.isFile()) snap.set(relChild, fs.readFileSync(path.join(dir, relChild), 'utf8'));
      }
    };
    walk('.');
    return snap;
  }

  /** Assert every entry captured in `before` (a __snapshotDir Map) still exists, byte-identical, under dir. */
  function __assertSnapshotSubsetPreserved(before, dir, label) {
    for (const [relChild, beforeContent] of before) {
      const candidatePath = path.join(dir, relChild);
      assert.ok(fs.existsSync(candidatePath), `${label}: ${relChild} must still exist`);
      assert.strictEqual(fs.readFileSync(candidatePath, 'utf8'), beforeContent, `${label}: ${relChild} must be byte-identical`);
    }
  }

  __issueDescribe('issue-2322: applySurface materializes installed third-party capability skills', () => {
    __issueTest('(1) primary: installed capability skill materializes at <prefix><stem>/SKILL.md and IS subject to the same runtime body rewrites as first-party content', () => {
      const gsdHome = createTempDir('gsd-2322-home-');
      const configDir = writePackageSourceMarkerFixture(createTempDir('gsd-2322-cfg-'));
      const savedHome = process.env.GSD_HOME;
      try {
        // #2322 MEDIUM-4: a fixture with NO rewrite-triggering content passes
        // vacuously (fs.readFileSync === AUTHORED is trivially true whether or
        // not the rewrite pass ever ran over this directory). This fixture
        // deliberately embeds a `~/.claude/` reference so the assertion below
        // actually exercises rewriteStagedSkillBodies (surface.cts) — it is
        // NOT immune from that pass just because no per-file `converter` runs
        // at stage time (see readInstalledCapabilitySkill's doc comment).
        const AUTHORED = '---\nname: my-thing\ndescription: third-party test skill\n---\n\n# My Thing\nSee @~/.claude/workflows/example.md for details.\n';
        __installCapSkill(gsdHome, 'my-thing', 'my-thing', AUTHORED);
        process.env.GSD_HOME = gsdHome;

        const registry = __registryFor('my-thing', ['my-thing']);
        const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
        const layout = __resolveRuntimeArtifactLayout('claude', configDir, 'global', registry);
        const resolved = __applySurface(configDir, layout, manifest, undefined, registry);

        assert.ok(resolved.skills.has('my-thing'), 'sanity: registry union (#2045) already includes my-thing in resolved.skills');

        const stagedPath = path.join(configDir, 'skills', 'gsd-my-thing', 'SKILL.md');
        assert.ok(
          fs.existsSync(stagedPath),
          'gsd-my-thing/SKILL.md must exist on disk after applySurface — registry says surfaced:true but nothing was materialized (#2322)',
        );
        const staged = fs.readFileSync(stagedPath, 'utf8');
        assert.notStrictEqual(
          staged,
          AUTHORED,
          'MEDIUM-4: a third-party skill is NOT immune from the runtime body rewrite pass applySurface runs over the whole stage dir — a byte-for-byte-equal assertion here would be vacuous',
        );
        assert.ok(!staged.includes('~/.claude/'), 'the ~/.claude/ literal must have been rewritten to the resolved path prefix');
        assert.ok(staged.includes('workflows/example.md'), 'the rewrite must preserve the referenced path suffix, not corrupt the body');
      } finally {
        if (savedHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedHome;
        cleanup(gsdHome);
        cleanup(configDir);
      }
    });

    __issueTest('(2) collision: a first-party stem always wins over a same-named third-party capability skill', () => {
      const gsdHome = createTempDir('gsd-2322-home-');
      const configDir = writePackageSourceMarkerFixture(createTempDir('gsd-2322-cfg-'));
      const savedHome = process.env.GSD_HOME;
      try {
        const EVIL = '---\nname: phase\n---\n\n# EVIL PHASE — must never win over the first-party gsd-phase skill\n';
        __installCapSkill(gsdHome, 'evil-cap', 'phase', EVIL);
        process.env.GSD_HOME = gsdHome;

        const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);

        // Baseline: apply against the SAME configDir with no colliding capability
        // registered — this is the reference first-party conversion of
        // commands/gsd/phase.md. (Two DIFFERENT configDirs would embed different
        // absolute @-workflow-file paths in the body and could never compare
        // byte-identical, so the collision run below re-applies to this same dir.)
        const baselineLayout = __resolveRuntimeArtifactLayout('claude', configDir, 'global');
        __applySurface(configDir, baselineLayout, manifest, undefined, undefined);
        const phasePath = path.join(configDir, 'skills', 'gsd-phase', 'SKILL.md');
        assert.ok(fs.existsSync(phasePath), 'sanity: first-party gsd-phase stages without a colliding capability');
        const baselinePhaseContent = fs.readFileSync(phasePath, 'utf8');

        // Collision run: re-apply to the SAME configDir once a third-party
        // capability also declares the 'phase' stem — the layout is rebuilt
        // WITH the colliding registry so the third-party fill-in pass actually
        // runs (and is then correctly suppressed by "first-party always wins"),
        // rather than never attempting it at all.
        const collideRegistry = __registryFor('evil-cap', ['phase']);
        const collideLayout = __resolveRuntimeArtifactLayout('claude', configDir, 'global', collideRegistry);
        __applySurface(configDir, collideLayout, manifest, undefined, collideRegistry);
        assert.ok(fs.existsSync(phasePath), 'gsd-phase must still exist when a third-party capability collides on the same stem');
        const collidePhaseContent = fs.readFileSync(phasePath, 'utf8');

        assert.notStrictEqual(collidePhaseContent, EVIL, 'the third-party EVIL PHASE content must never win the collision');
        assert.strictEqual(
          collidePhaseContent,
          baselinePhaseContent,
          'on a stem collision the first-party converted content must be staged, identical to the no-collision baseline',
        );
      } finally {
        if (savedHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedHome;
        cleanup(gsdHome);
        cleanup(configDir);
      }
    });

    __issueTest('(3) profile filter: a third-party skill outside the resolved profile is not staged; sibling first-party skills are unaffected', () => {
      const gsdHome = createTempDir('gsd-2322-home-');
      const configDir = writePackageSourceMarkerFixture(createTempDir('gsd-2322-cfg-'));
      const savedHome = process.env.GSD_HOME;
      try {
        __installCapSkill(gsdHome, 'my-thing', 'my-thing', '# my-thing\n');
        process.env.GSD_HOME = gsdHome;

        // 'my-thing' is tier:'standard' -> profiles ['standard','full']; the
        // 'core' base profile does NOT include it.
        __writeSurface(configDir, { baseProfile: 'core', disabledClusters: [], explicitAdds: [], explicitRemoves: [] });

        const registry = __registryFor('my-thing', ['my-thing'], 'standard');
        const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
        const layout = __resolveRuntimeArtifactLayout('claude', configDir, 'global', registry);
        const resolved = __applySurface(configDir, layout, manifest, undefined, registry);

        assert.ok(!resolved.skills.has('my-thing'), 'sanity: core profile excludes a standard-tier capability skill');
        assert.ok(
          !fs.existsSync(path.join(configDir, 'skills', 'gsd-my-thing', 'SKILL.md')),
          'a capability skill outside the resolved profile must NOT be staged',
        );
        // 'phase' is a core-profile member — must be unaffected by the presence
        // of the (filtered-out) third-party capability skill.
        assert.ok(
          fs.existsSync(path.join(configDir, 'skills', 'gsd-phase', 'SKILL.md')),
          'a first-party core-profile skill must still stage normally alongside a filtered-out capability skill',
        );
      } finally {
        if (savedHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedHome;
        cleanup(gsdHome);
        cleanup(configDir);
      }
    });

    __issueTest('(4) control: a nested-router (doNest) runtime layout is unperturbed by an installed capability skill', () => {
      const gsdHome = createTempDir('gsd-2322-home-');
      const configDir = writePackageSourceMarkerFixture(createTempDir('gsd-2322-cfg-'));
      const savedHome = process.env.GSD_HOME;
      try {
        __installCapSkill(gsdHome, 'my-thing', 'my-thing', '# my-thing\n');
        process.env.GSD_HOME = gsdHome;

        const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
        // 'cline' is a nested (doNest) runtime layout (unlike Claude's flat layout).
        const baselineLayout = __resolveRuntimeArtifactLayout('cline', configDir, 'global');

        // Baseline: no capability registered — snapshot the resulting nested layout.
        __applySurface(configDir, baselineLayout, manifest, undefined, undefined);
        const skillsDir = path.join(configDir, 'skills');
        const router = fs.readdirSync(skillsDir).find((d) => d.startsWith('gsd-ns-'));
        assert.ok(router, 'sanity: the baseline nested layout has at least one gsd-ns-* router');
        const baselineSnapshot = __snapshotDir(skillsDir);

        // Re-apply to the SAME configDir once a capability skill is also
        // installed and present in the registry — rebuild the layout WITH the
        // registry so the fill-in pass actually runs.
        const registry = __registryFor('my-thing', ['my-thing']);
        const registryLayout = __resolveRuntimeArtifactLayout('cline', configDir, 'global', registry);
        __applySurface(configDir, registryLayout, manifest, undefined, registry);

        assert.ok(
          fs.existsSync(path.join(skillsDir, router)),
          'the namespace router bundle must still be present when a capability skill is also installed',
        );
        // Every first-party file staged in the baseline (no capability) run
        // must remain byte-identical after the capability is added — its
        // presence must never perturb first-party nesting or content.
        __assertSnapshotSubsetPreserved(baselineSnapshot, skillsDir, 'nested first-party layout');
      } finally {
        if (savedHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedHome;
        cleanup(gsdHome);
        cleanup(configDir);
      }
    });

    __issueTest('(5) absent/malformed: a registry-referenced capability skill missing on disk must not throw and must not affect first-party output', () => {
      const gsdHome = createTempDir('gsd-2322-home-');
      const configDirGhost = writePackageSourceMarkerFixture(createTempDir('gsd-2322-cfg-ghost-'));
      const configDirPartial = writePackageSourceMarkerFixture(createTempDir('gsd-2322-cfg-partial-'));
      const savedHome = process.env.GSD_HOME;
      try {
        // Partial case: the capability dir exists but the declared stem's
        // skills/<stem>/SKILL.md is missing (e.g. a corrupt/partial install).
        fs.mkdirSync(path.join(gsdHome, '.gsd', 'capabilities', 'partial-cap', 'skills'), { recursive: true });
        process.env.GSD_HOME = gsdHome;

        const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);

        // Ghost case: capId in the registry has NO install directory at all.
        const ghostRegistry = __registryFor('ghost-cap', ['ghost-stem']);
        const ghostLayout = __resolveRuntimeArtifactLayout('claude', configDirGhost, 'global', ghostRegistry);
        assert.doesNotThrow(() => {
          __applySurface(configDirGhost, ghostLayout, manifest, undefined, ghostRegistry);
        }, 'applySurface must not throw when a registry-referenced capability has no install directory on disk');
        assert.ok(
          fs.existsSync(path.join(configDirGhost, 'skills', 'gsd-help', 'SKILL.md')),
          'first-party skills must still materialize when a referenced capability is entirely absent on disk',
        );

        // Partial case.
        const partialRegistry = __registryFor('partial-cap', ['missing-stem']);
        const partialLayout = __resolveRuntimeArtifactLayout('claude', configDirPartial, 'global', partialRegistry);
        assert.doesNotThrow(() => {
          __applySurface(configDirPartial, partialLayout, manifest, undefined, partialRegistry);
        }, 'applySurface must not throw when a capability install dir exists but the declared stem is missing under skills/');
        assert.ok(
          fs.existsSync(path.join(configDirPartial, 'skills', 'gsd-help', 'SKILL.md')),
          'first-party skills must still materialize when a referenced capability skill is partially/malformed-installed',
        );
      } finally {
        if (savedHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedHome;
        cleanup(gsdHome);
        cleanup(configDirGhost);
        cleanup(configDirPartial);
      }
    });
  });

  // ── BLOCKER 1: cross-capability skill-stem hijack ──────────────────────────
  __issueDescribe('issue-2322 BLOCKER 1: capability skill stem hijack via an undeclared/unregistered directory', () => {
    __issueTest('an UNDECLARED skills/<stem>/ directory shipped by one capability must never supply another capability\'s declared+registered stem', () => {
      const gsdHome = createTempDir('gsd-2322-home-');
      const configDir = writePackageSourceMarkerFixture(createTempDir('gsd-2322-cfg-'));
      const savedHome = process.env.GSD_HOME;
      try {
        const EVIL = '---\nname: deploy\n---\n\n# EVIL deploy — planted by aaa-utils, which never declared this skill\n';
        const LEGIT = '---\nname: deploy\n---\n\n# legit deploy — authored and declared by zzz-deploy\n';
        // aaa-utils sorts BEFORE zzz-deploy lexically (the OLD scan-and-first-
        // sorted-match implementation would have picked aaa-utils) AND ships an
        // UNDECLARED skills/deploy/ directory it never listed in its
        // capability.json `skills[]`.
        __installCapSkill(gsdHome, 'aaa-utils', 'deploy', EVIL);
        // zzz-deploy is the SOLE capability that DECLARES + is REGISTERED as
        // owning 'deploy'.
        __installCapSkill(gsdHome, 'zzz-deploy', 'deploy', LEGIT);
        process.env.GSD_HOME = gsdHome;

        // aaa-utils's capabilityClusters entry is EMPTY — mirrors
        // gen-capability-registry.cjs deriveCapabilityClusters, which only
        // includes a capability that owns a NON-EMPTY declared skills[] array
        // (i.e. "skills": [] in capability.json never appears here at all).
        const registry = {
          capabilityClusters: { 'aaa-utils': [], 'zzz-deploy': ['deploy'] },
          profileMembership: { 'zzz-deploy': { tier: 'standard', profiles: ['standard', 'full'] } },
        };

        // (a) direct unit-level probe of the ownership-binding function.
        const found = readInstalledCapabilitySkill('deploy', registry);
        assert.ok(found, 'sanity: the declared+registered owner must be resolvable');
        assert.strictEqual(found.capId, 'zzz-deploy', 'ownership must resolve to the DECLARING+REGISTERED capability, never the alphabetically-first directory on disk');
        assert.strictEqual(found.content, LEGIT, 'the returned content must be the declaring capability\'s own SKILL.md');
        assert.notStrictEqual(found.content, EVIL, 'the undeclared sibling directory\'s content must never be returned');

        // (b) end-to-end through the real staging path (applySurface).
        const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
        const layout = __resolveRuntimeArtifactLayout('claude', configDir, 'global', registry);
        const resolved = __applySurface(configDir, layout, manifest, undefined, registry);
        assert.ok(resolved.skills.has('deploy'), 'sanity: the registered capability skill is unioned into the resolved surface');

        const stagedPath = path.join(configDir, 'skills', 'gsd-deploy', 'SKILL.md');
        assert.ok(fs.existsSync(stagedPath), 'the legitimate declaring capability\'s skill must be staged');
        const stagedContent = fs.readFileSync(stagedPath, 'utf8');
        assert.ok(!stagedContent.includes('EVIL'), 'the undeclared aaa-utils directory must never win the stem — hijack blocked end-to-end');
        assert.ok(stagedContent.includes('legit deploy'), 'the declaring capability\'s own content must be what lands on disk');
      } finally {
        if (savedHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedHome;
        cleanup(gsdHome);
        cleanup(configDir);
      }
    });

    __issueTest('two capabilities can never both claim the same stem — capabilityClusters is unambiguous by construction (no ownership tie to break)', () => {
      // capabilityClusters can only ever bind a stem to ONE capId (the
      // capability-loader registry composer rejects a candidate whose declared
      // skill collides with an already-registered owner before it is ever
      // composed) — so _owningCapabilityId's "first Object.keys() match wins"
      // internal iteration order can never actually matter in practice. This
      // documents that invariant at the readInstalledCapabilitySkill boundary.
      const registry = { capabilityClusters: { alpha: ['shared'], beta: ['shared'] } };
      // Even in this (registry-invariant-violating, hand-crafted) input, the
      // lookup must be deterministic and must not throw.
      assert.doesNotThrow(() => readInstalledCapabilitySkill('shared', registry));
    });
  });

  // ── BLOCKER 2: the '*' (full-profile) sentinel must still stage capability skills ──
  __issueDescribe('issue-2322 BLOCKER 2: mode=full (the "*" sentinel) must still stage registered third-party capability skills', () => {
    __issueTest('resolveProfile({modes:["full"]})\'s "*" sentinel, passed straight to stageSkillsForRuntimeAsSkills, still materializes a registered capability skill', () => {
      const gsdHome = createTempDir('gsd-2322-home-');
      const configDir = writePackageSourceMarkerFixture(createTempDir('gsd-2322-cfg-'));
      const savedHome = process.env.GSD_HOME;
      let unitStaged;
      let e2eStaged;
      try {
        const AUTHORED = '# my-thing (full profile)\n';
        __installCapSkill(gsdHome, 'my-thing', 'my-thing', AUTHORED);
        process.env.GSD_HOME = gsdHome;

        const registry = __registryFor('my-thing', ['my-thing']);
        // The REAL sentinel resolveProfile({modes:['full']}) produces — mirrors
        // bin/install.js's `_resolvedProfile` for the DEFAULT (`--profile full`)
        // install, and does NOT go through applySurface/resolveSurface (which
        // would materialize '*' into a concrete Set before staging ever sees it).
        const resolvedFull = resolveProfile({ modes: ['full'] });
        assert.strictEqual(resolvedFull.skills, '*', 'sanity: full mode resolves to the "*" sentinel');

        // (a) direct unit-level probe of the staging function.
        unitStaged = stageSkillsForRuntimeAsSkills(REAL_COMMANDS_DIR, resolvedFull, (content) => content, 'gsd-', false, registry);
        const unitStagedPath = path.join(unitStaged, 'gsd-my-thing', 'SKILL.md');
        assert.ok(
          fs.existsSync(unitStagedPath),
          '#2322 BLOCKER 2: the "*" sentinel must still stage a registered capability skill (unit level) — mode=standard already did this, mode=full must too',
        );
        assert.strictEqual(fs.readFileSync(unitStagedPath, 'utf8'), AUTHORED);

        // (b) end-to-end through resolveRuntimeArtifactLayout's skills-kind
        // stage() closure — the EXACT call shape bin/install.js's installer
        // path uses (kind.stage(resolvedProfile), with NO applySurface
        // involved, so the '*' sentinel really does reach staging here).
        const layout = __resolveRuntimeArtifactLayout('claude', configDir, 'global', registry);
        const skillsKindEntry = layout.kinds.find((k) => k.kind === 'skills');
        e2eStaged = skillsKindEntry.stage(resolvedFull);
        const e2eStagedPath = path.join(e2eStaged, 'gsd-my-thing', 'SKILL.md');
        assert.ok(
          fs.existsSync(e2eStagedPath),
          'BLOCKER 2 (issue repro): mode=full must stage a registered capability skill exactly like mode=standard already does',
        );
      } finally {
        if (savedHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedHome;
        cleanup(gsdHome);
        cleanup(configDir);
        if (unitStaged) cleanup(unitStaged);
        if (e2eStaged) cleanup(e2eStaged);
      }
    });

    __issueTest('no registry threaded through at all -> the "*" sentinel stages NOTHING third-party (fail closed, never a fallback scan)', () => {
      const gsdHome = createTempDir('gsd-2322-home-');
      const savedHome = process.env.GSD_HOME;
      let staged;
      try {
        __installCapSkill(gsdHome, 'my-thing', 'my-thing', '# my-thing\n');
        process.env.GSD_HOME = gsdHome;
        const resolvedFull = resolveProfile({ modes: ['full'] });
        staged = stageSkillsForRuntimeAsSkills(REAL_COMMANDS_DIR, resolvedFull, (c) => c, 'gsd-', false /* no registry arg */);
        assert.ok(
          !fs.existsSync(path.join(staged, 'gsd-my-thing')),
          'an absent registry must never fall back to scanning the capabilities root — fail closed',
        );
      } finally {
        if (savedHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedHome;
        cleanup(gsdHome);
        if (staged) cleanup(staged);
      }
    });
  });

  // ── HIGH 3: staged capability skills must be prunable once orphaned ────────
  __issueDescribe('issue-2322 HIGH-3: an orphaned (uninstalled/unsurfaced) capability skill is pruned; a genuinely unknown gsd-* dir is still preserved', () => {
    __issueTest('uninstalling the capability + re-applying removes its staged skill; an unrelated hand-made gsd-* dir survives with a warning', () => {
      const gsdHome = createTempDir('gsd-2322-home-');
      const configDir = writePackageSourceMarkerFixture(createTempDir('gsd-2322-cfg-'));
      const savedHome = process.env.GSD_HOME;
      try {
        __installCapSkill(gsdHome, 'my-thing', 'my-thing', '# my-thing\n');
        process.env.GSD_HOME = gsdHome;

        const registry = __registryFor('my-thing', ['my-thing']);
        const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
        const layoutWithCap = __resolveRuntimeArtifactLayout('claude', configDir, 'global', registry);

        // Step 1: install + apply -> the capability skill is staged and marked.
        __applySurface(configDir, layoutWithCap, manifest, undefined, registry);
        const stagedDirPath = path.join(configDir, 'skills', 'gsd-my-thing');
        assert.ok(fs.existsSync(path.join(stagedDirPath, 'SKILL.md')), 'sanity: the capability skill is staged');
        assert.ok(
          fs.existsSync(path.join(stagedDirPath, CAPABILITY_SKILL_MARKER)),
          'sanity: the staged capability skill dir carries the persisted ownership marker',
        );

        // Step 2: an unrelated, genuinely user-created gsd-* dir must survive
        // the whole scenario untouched, with a warning — the data-loss guard.
        const userDir = path.join(configDir, 'skills', 'gsd-my-own-notes');
        fs.mkdirSync(userDir, { recursive: true });
        fs.writeFileSync(path.join(userDir, 'SKILL.md'), '# my own notes\n');

        // Step 3: uninstall the capability (remove its on-disk bundle) and drop
        // it from every registry view entirely — simulating `capability remove`.
        cleanup(path.join(gsdHome, '.gsd', 'capabilities', 'my-thing'));
        const registryAfterUninstall = { capabilityClusters: {}, profileMembership: {} };
        const layoutAfterUninstall = __resolveRuntimeArtifactLayout('claude', configDir, 'global', registryAfterUninstall);

        // Step 4: re-apply to the SAME configDir with the capability now
        // entirely absent from the registry.
        const stderrChunks = [];
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk, ...rest) => { stderrChunks.push(String(chunk)); return origWrite(chunk, ...rest); };
        try {
          __applySurface(configDir, layoutAfterUninstall, manifest, undefined, registryAfterUninstall);
        } finally {
          process.stderr.write = origWrite;
        }

        assert.ok(
          !fs.existsSync(stagedDirPath),
          'HIGH-3: an uninstalled/unsurfaced capability\'s previously-staged skill must be PRUNED, not preserved forever',
        );
        assert.ok(
          fs.existsSync(userDir),
          'a genuinely unknown/hand-made gsd-* dir must still be preserved (data-loss protection unchanged)',
        );
        assert.ok(
          stderrChunks.some((c) => c.includes('gsd-my-own-notes')),
          'the genuinely unknown dir must still emit the preserve warning',
        );
        assert.ok(
          !stderrChunks.some((c) => c.includes('gsd-my-thing')),
          'the orphaned capability skill must be pruned via its positively-identified marker, not routed through the "unknown" warning path',
        );
      } finally {
        if (savedHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedHome;
        cleanup(gsdHome);
        cleanup(configDir);
      }
    });
  });

  // ── LOW 7: isSafeCapabilitySkillStem — the security control had ZERO direct coverage ──
  __issueDescribe('issue-2322 LOW-7: isSafeCapabilitySkillStem direct security-control coverage', () => {
    const unsafe = [
      ['../../evil', 'parent-directory traversal (unix separators)'],
      ['..\\..\\evil', 'parent-directory traversal (windows separators)'],
      ['/etc/passwd', 'absolute unix path'],
      ['C:\\x', 'absolute-looking windows path (rejected via the backslash check, platform-independent)'],
      ['foo/../../bar', 'embedded traversal segment'],
      ['foo\0bar', 'embedded NUL byte'],
      ['.', 'current-directory sentinel'],
      ['..', 'parent-directory sentinel'],
      ['', 'empty string'],
    ];
    for (const [stem, label] of unsafe) {
      __issueTest(`rejects: ${label}`, () => {
        assert.strictEqual(isSafeCapabilitySkillStem(stem), false, `"${JSON.stringify(stem)}" (${label}) must be rejected`);
      });
    }

    __issueTest('accepts an ordinary single-segment stem (limit-1 / control case)', () => {
      assert.strictEqual(isSafeCapabilitySkillStem('my-thing'), true);
    });

    __issueTest('boundary: a very long single-segment stem (no separators) has no length cap — accepted, and a lookup against it degrades gracefully (never throws)', () => {
      const longStem = 'a'.repeat(5000);
      assert.strictEqual(isSafeCapabilitySkillStem(longStem), true, 'no length cap is documented on this function — it is a shape check, not a length check');
      const registry = { capabilityClusters: { 'some-cap': [longStem] } };
      assert.doesNotThrow(() => readInstalledCapabilitySkill(longStem, registry), 'an overlong (but shape-valid) stem must degrade to null on a filesystem-level failure (e.g. ENAMETOOLONG), never throw');
      assert.strictEqual(readInstalledCapabilitySkill(longStem, registry), null);
    });

    __issueTest('capabilityClusterStems ignores prototype-pollution-shaped keys and non-array values', () => {
      // Computed keys (['__proto__'], ['constructor']) create genuine OWN
      // enumerable properties named "__proto__"/"constructor" — unlike the
      // bare object-literal `__proto__:` form (which sets the object's actual
      // [[Prototype]] instead and would never appear in Object.keys() at all,
      // making the BANNED-list guard untestable this way).
      const clusters = Object.create(null);
      clusters['__proto__'] = ['evil'];
      clusters['constructor'] = ['evil'];
      clusters['good'] = ['a', 'b'];
      clusters['bad'] = 'not-an-array';
      const stems = capabilityClusterStems({ capabilityClusters: clusters });
      assert.deepStrictEqual([...stems].sort(), ['a', 'b']);
    });
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-924-claude-flat-skill-layout.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-924-claude-flat-skill-layout (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #924)
// Reads installed SKILL.md files from a real install run —
// testing their on-disk layout tests the deployed contract.

/**
 * Regression test for bug #924.
 *
 * PR #883 accidentally nested concrete gsd-* skills 3 levels deep for the
 * Claude global install:
 *
 *   ~/.claude/skills/gsd-ns-<router>/skills/<stem>/SKILL.md
 *
 * Claude Code's skills discovery scans only ONE level under ~/.claude/skills/,
 * so nested concretes were never listed in the Skill-tool available-skills list.
 * Direct `Skill(skill="gsd-plan-phase")` calls stopped working.
 *
 * Fix: revert Claude to the FLAT layout — concrete skills at the top level:
 *
 *   ~/.claude/skills/gsd-<name>/SKILL.md
 *
 * The 6 ns-* routers are also top-level entries in the flat layout (they are
 * concrete skills themselves). No nested skills/ subdirs for Claude.
 *
 * Other 6 runtimes (cline, qwen, hermes, augment, trae, antigravity) stay nested.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const COMMANDS_GSD = path.join(ROOT, 'commands', 'gsd');

const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');
const { cleanup } = require('./helpers.cjs');
const {
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');
const { applySurface } = require('../gsd-core/bin/lib/surface.cjs');
const resolveRuntimeArtifactLayout = resolveLayout;

const MANIFEST = loadSkillsManifest(COMMANDS_GSD);
const RESOLVED_FULL = resolveProfile({ modes: ['full'], manifest: MANIFEST });

// ---------------------------------------------------------------------------
// #924 regression: Claude global install must use FLAT layout
// ---------------------------------------------------------------------------

describe('bug-924: claude global install uses flat skill layout (concrete skills discoverable)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-924-claude-flat-'));
    installRuntimeArtifacts('claude', tmpDir, 'global', RESOLVED_FULL);
  });

  after(() => {
    if (tmpDir) {
      try { cleanup(tmpDir); } catch { /* best-effort */ }
    }
  });

  test('claude global: concrete skills are at the TOP LEVEL of skills/ (flat, directly discoverable)', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), `skills/ dir must exist under ${tmpDir}`);

    const topLevel = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));

    // Flat layout must have MANY more than 6 top-level gsd-* entries (concrete skills).
    // Pre-#924-fix nested layout had exactly 6 (only routers). Flat must have >= 60.
    assert.ok(
      topLevel.length >= 60,
      `Claude global must have >= 60 gsd-* top-level skill dirs (concrete flat layout). ` +
      `Got ${topLevel.length}: [${topLevel.slice(0, 10).join(', ')}${topLevel.length > 10 ? ', …' : ''}]. ` +
      'Nested layout detected — #924 regression: Claude must be flat.',
    );
  });

  test('claude global: gsd-plan-phase is directly at the top level of skills/', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    const planPhaseDir = path.join(skillsDir, 'gsd-plan-phase');
    assert.ok(
      fs.existsSync(path.join(planPhaseDir, 'SKILL.md')),
      `skills/gsd-plan-phase/SKILL.md must exist at top level for Claude global install. ` +
      'Concrete skill buried in nested layout — #924 regression.',
    );
  });

  test('claude global: gsd-execute-phase is directly at the top level of skills/', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-execute-phase', 'SKILL.md')),
      `skills/gsd-execute-phase/SKILL.md must exist at top level for Claude global install.`,
    );
  });

  test('claude global: gsd-code-review is directly at the top level of skills/', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-code-review', 'SKILL.md')),
      `skills/gsd-code-review/SKILL.md must exist at top level for Claude global install.`,
    );
  });

  test('claude global: gsd-ns-workflow is at the top level as a concrete skill (no nested skills/ subdir)', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    const nsWorkflowDir = path.join(skillsDir, 'gsd-ns-workflow');
    assert.ok(
      fs.existsSync(path.join(nsWorkflowDir, 'SKILL.md')),
      `skills/gsd-ns-workflow/SKILL.md must exist at top level (router as concrete skill).`,
    );

    // In the FLAT layout, gsd-ns-workflow/ must NOT have a skills/ subdir.
    // A skills/ subdir means nested layout was applied (the #924 regression).
    assert.ok(
      !fs.existsSync(path.join(nsWorkflowDir, 'skills')),
      `skills/gsd-ns-workflow/skills/ must NOT exist in flat layout (nested layout detected — #924 regression).`,
    );
  });

  test('claude global: no concrete skill is nested under gsd-ns-*/skills/<stem>/SKILL.md', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    const topLevel = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-ns-'));

    for (const nsDir of topLevel) {
      const nestedSkillsDir = path.join(skillsDir, nsDir, 'skills');
      assert.ok(
        !fs.existsSync(nestedSkillsDir),
        `${nsDir}/skills/ must NOT exist in Claude flat layout (#924 regression: nested layout detected).`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// #924 regression: applySurface on Claude must also preserve flat layout
// (no re-nesting after surface update)
// ---------------------------------------------------------------------------

describe('bug-924: applySurface on claude preserves flat layout (no re-nesting)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-924-surface-'));
    installRuntimeArtifacts('claude', tmpDir, 'global', RESOLVED_FULL);
    writePackageSourceMarkerFixture(tmpDir);
  });

  after(() => {
    if (tmpDir) {
      try { cleanup(tmpDir); } catch { /* best-effort */ }
    }
  });

  test('claude: applySurface keeps concrete skills at the top level (flat, no re-nesting)', () => {
    const skillsDir = path.join(tmpDir, 'skills');

    // Sanity: install must produce flat layout (>= 60 top-level gsd-* dirs)
    const topLevelAfterInstall = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.ok(
      topLevelAfterInstall.length >= 60,
      `Install must produce flat layout with >= 60 gsd-* dirs. Got ${topLevelAfterInstall.length}.`,
    );

    // Run applySurface (full surface → full profile)
    const layout = resolveRuntimeArtifactLayout('claude', tmpDir, 'global');
    applySurface(tmpDir, layout, MANIFEST);

    // After applySurface: still flat
    const topLevelAfterSurface = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.ok(
      topLevelAfterSurface.length >= 60,
      `After applySurface: must still have >= 60 gsd-* top-level dirs (flat). ` +
      `Got ${topLevelAfterSurface.length}. Re-nesting detected.`,
    );

    // gsd-plan-phase must remain directly accessible
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-plan-phase', 'SKILL.md')),
      'After applySurface: gsd-plan-phase/SKILL.md must remain at top level.',
    );
  });
});
  });
}

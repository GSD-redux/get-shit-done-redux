const fs = require('fs');
const os = require('os');
const path = require('path');
const { gitOrThrow } = require('../helpers/git-fixture.cjs');

/**
 * Create a temp test fixture directory with canonical planning layout.
 *
 * @param {object} [options]
 * @param {string} [options.prefix='gsd-test-']
 * @param {boolean} [options.git=false] - initialize git repo with initial commit
 * @param {boolean} [options.planning=true] - create .planning/phases layout
 * @param {boolean} [options.projectDoc=true] - write .planning/PROJECT.md
 * @returns {string} absolute fixture directory path
 */
function createFixture(options = {}) {
  const {
    prefix = 'gsd-test-',
    git = false,
    planning = true,
    projectDoc = git,
  } = options;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  if (planning) {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  }

  if (projectDoc) {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Project\n\nTest project.\n'
    );
  }

  if (git) {
    gitOrThrow(['init'], { cwd: tmpDir });
    gitOrThrow(['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    gitOrThrow(['config', 'user.name', 'Test'], { cwd: tmpDir });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
    gitOrThrow(['add', '-A'], { cwd: tmpDir });
    // `--allow-empty`: a fixture with `git: true, planning: false,
    // projectDoc: false` (e.g. a "greenfield" starting world) stages nothing,
    // so a plain `git commit` would fail with "nothing to commit" and the
    // caller would never get a usable repo (there'd be no HEAD at all).
    gitOrThrow(['commit', '--allow-empty', '-m', 'initial commit'], { cwd: tmpDir });
  }

  return tmpDir;
}

/**
 * Seed a canonical phase directory with files.
 * @param {string} tmpDir
 * @param {string} phaseSlug e.g. "03-api"
 * @param {Record<string,string>} files map of filename->content
 * @returns {string} phase directory path
 */
function seedPhase(tmpDir, phaseSlug, files = {}) {
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(phaseDir, name), content);
  }
  return phaseDir;
}

/**
 * Seed a canonical workstream tree and optionally set active pointer.
 * @param {string} tmpDir
 * @param {{name:string, state?:string, roadmap?:string, active?:boolean}} options
 * @returns {string} workstream directory path
 */
function seedWorkstream(tmpDir, options) {
  const { name, state = '', roadmap = '', active = false } = options || {};
  if (!name || /[^a-zA-Z0-9._-]/.test(name) || name.includes('..')) {
    throw new Error(`seedWorkstream: invalid name "${name}"`);
  }
  const wsDir = path.join(tmpDir, '.planning', 'workstreams', name);
  fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
  if (state) fs.writeFileSync(path.join(wsDir, 'STATE.md'), state);
  if (roadmap) fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), roadmap);
  if (active) {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), `${name}\n`);
  }
  return wsDir;
}

/**
 * Write STATE.md in canonical location.
 * @param {string} tmpDir
 * @param {string} content
 * @returns {string} file path
 */
function writeState(tmpDir, content) {
  const statePath = path.join(tmpDir, '.planning', 'STATE.md');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, content);
  return statePath;
}

module.exports = { createFixture, seedPhase, seedWorkstream, writeState };

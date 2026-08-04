'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const retiredArtifactCleanup = require('../gsd-core/bin/lib/retired-artifact-cleanup.cjs');
const capabilityRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

const cursorBehaviors = capabilityRegistry.runtimes.cursor.runtime.hostBehaviors;

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-retired-cleanup-'));
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  t.after(() => {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- isolated temp fixture cleanup
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, configDir };
}

function setDeclarations(t, declarations) {
  const original = cursorBehaviors.retiredArtifacts;
  cursorBehaviors.retiredArtifacts = declarations;
  t.after(() => {
    cursorBehaviors.retiredArtifacts = original;
  });
}

function writeFile(root, relPath, content) {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeManifest(configDir, files) {
  fs.writeFileSync(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify({
    version: '1.8.0',
    timestamp: '2026-07-28T00:00:00.000Z',
    mode: 'full',
    files,
  }), 'utf8');
}

test('rejects malformed and escaping retired-artifact declarations', (t) => {
  const { root, configDir } = createFixture(t);
  const outsideFile = writeFile(root, 'escape/gsd-help.md', '# outside\n');
  const localFile = writeFile(configDir, 'commands/gsd-help.md', '# local\n');
  setDeclarations(t, [
    { destSubpath: null, prefix: 'gsd-', suffix: '.md' },
    { destSubpath: '../escape', prefix: 'gsd-', suffix: '.md' },
  ]);

  const result = retiredArtifactCleanup.pruneRetiredRuntimeArtifacts('cursor', configDir);

  assert.deepEqual(result, { removed: [], preserved: [] });
  assert.ok(fs.existsSync(outsideFile), 'an escaping destination must never be touched');
  assert.ok(fs.existsSync(localFile), 'a malformed declaration must not affect valid-looking files');
});

test('refuses a symlinked retired destination directory', (t) => {
  const { root, configDir } = createFixture(t);
  const targetDir = path.join(root, 'outside-commands');
  const targetFile = writeFile(targetDir, 'gsd-help.md', '# outside\n');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(targetDir, path.join(configDir, 'commands'), linkType);
  setDeclarations(t, [{ destSubpath: 'commands', prefix: 'gsd-', suffix: '.md' }]);

  const result = retiredArtifactCleanup.pruneRetiredRuntimeArtifacts('cursor', configDir);

  assert.deepEqual(result, { removed: [], preserved: [] });
  assert.ok(fs.existsSync(targetFile), 'cleanup must not follow the destination symlink');
});

test('preserves and reports a user-modified managed file', (t) => {
  const { configDir } = createFixture(t);
  const relPath = 'commands/gsd-help.md';
  const originalContent = '# generated\n';
  const modifiedContent = '# user changed this\n';
  const filePath = writeFile(configDir, relPath, modifiedContent);
  writeManifest(configDir, { [relPath]: sha256(originalContent) });
  setDeclarations(t, [{ destSubpath: 'commands', prefix: 'gsd-', suffix: '.md' }]);

  const result = retiredArtifactCleanup.pruneRetiredRuntimeArtifacts('cursor', configDir);

  assert.deepEqual(result, { removed: [], preserved: [relPath] });
  assert.equal(fs.readFileSync(filePath, 'utf8'), modifiedContent);
  assert.ok(fs.existsSync(path.dirname(filePath)), 'directory must remain while a preserved file exists');
});

test('removes and reports a managed-pristine file and then removes the empty directory', (t) => {
  const { configDir } = createFixture(t);
  const relPath = 'commands/gsd-help.md';
  const content = '# generated\n';
  const filePath = writeFile(configDir, relPath, content);
  const commandsDir = path.dirname(filePath);
  writeManifest(configDir, { [relPath]: sha256(content) });
  setDeclarations(t, [{ destSubpath: 'commands', prefix: 'gsd-', suffix: '.md' }]);

  const result = retiredArtifactCleanup.pruneRetiredRuntimeArtifacts('cursor', configDir);

  assert.deepEqual(result, { removed: [relPath], preserved: [] });
  assert.ok(!fs.existsSync(filePath));
  assert.ok(!fs.existsSync(commandsDir), 'an empty retired destination should be removed');
});

test('leaves non-matching files untouched and keeps their directory', (t) => {
  const { configDir } = createFixture(t);
  const managedRelPath = 'commands/gsd-help.md';
  const managedContent = '# generated\n';
  const managedFile = writeFile(configDir, managedRelPath, managedContent);
  const unrelatedFile = writeFile(configDir, 'commands/user-command.md', '# user\n');
  writeManifest(configDir, { [managedRelPath]: sha256(managedContent) });
  setDeclarations(t, [{ destSubpath: 'commands', prefix: 'gsd-', suffix: '.md' }]);

  const result = retiredArtifactCleanup.pruneRetiredRuntimeArtifacts('cursor', configDir);

  assert.deepEqual(result, { removed: [managedRelPath], preserved: [] });
  assert.ok(!fs.existsSync(managedFile));
  assert.ok(fs.existsSync(unrelatedFile));
  assert.ok(fs.existsSync(path.dirname(unrelatedFile)), 'a non-empty destination must remain');
});

test('reports a managed-pristine file as preserved when unlinkSync fails', (t) => {
  const { configDir } = createFixture(t);
  const relPath = 'commands/gsd-help.md';
  const content = '# generated\n';
  const filePath = writeFile(configDir, relPath, content);
  writeManifest(configDir, { [relPath]: sha256(content) });
  setDeclarations(t, [{ destSubpath: 'commands', prefix: 'gsd-', suffix: '.md' }]);

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = (candidate) => {
    if (path.resolve(candidate) === path.resolve(filePath)) throw new Error('injected unlink failure');
    return originalUnlinkSync(candidate);
  };
  let result;
  try {
    result = retiredArtifactCleanup.pruneRetiredRuntimeArtifacts('cursor', configDir);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.deepEqual(result, { removed: [], preserved: [relPath] });
  assert.ok(fs.existsSync(filePath), 'a failed unlink must leave the file in place');
});

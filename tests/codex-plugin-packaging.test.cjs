'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

test('Codex plugin manifest and MCP companion have the approved packaging contract', () => {
  const pkg = readJson('package.json');
  const manifest = readJson('.codex-plugin/plugin.json');
  const mcp = readJson('.mcp.json');

  assert.equal(manifest.name, 'gsd-core');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.interface.category, 'Productivity');
  assert.deepEqual(manifest.interface.capabilities, ['Interactive', 'Write']);
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.deepEqual(manifest.interface.defaultPrompt, [
    'Show my GSD project control center.',
    'Review outstanding UAT checks.',
    'What is blocking this milestone?',
  ]);
  assert.deepEqual(mcp, {
    mcpServers: {
      gsd: {
        command: 'node',
        args: ['./bin/gsd-mcp-server.js'],
        cwd: '.',
      },
    },
  });
});

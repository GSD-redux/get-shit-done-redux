'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { handleMessage } = require('../gsd-core/bin/lib/mcp-server.cjs');

function call(name, arguments_) {
  return handleMessage({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ },
  });
}

test('Codex app tools require an absolute project_path', () => {
  for (const name of ['gsd_control_center', 'gsd_uat_workbench', 'gsd_record_uat_result']) {
    const res = call(name, { project_path: 'relative-project' });
    assert.equal(res.result.isError, true, `${name} must reject a relative project path`);
  }
});

test('Codex app tools declare the UI resource each host should render', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const byName = Object.fromEntries(res.result.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.gsd_control_center._meta.ui.resourceUri, 'ui://gsd/control-center-v1.html');
  assert.equal(byName.gsd_uat_workbench._meta.ui.resourceUri, 'ui://gsd/uat-workbench-v1.html');
  assert.equal(byName.gsd_record_uat_result._meta.ui.resourceUri, 'ui://gsd/uat-workbench-v1.html');
  assert.deepEqual(byName.gsd_record_uat_result.inputSchema.required, ['project_path', 'file_path', 'test_number', 'result']);
  assert.deepEqual(Object.keys(byName.gsd_record_uat_result.inputSchema.properties).sort(), ['file_path', 'note', 'project_path', 'result', 'test_number']);
});

test('gsd_control_center returns matching structured data and JSON text', () => {
  const dir = createTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    const res = call('gsd_control_center', { project_path: dir });
    assert.equal(res.result.isError, undefined, res.result.content[0].text);
    assert.equal(res.result.structuredContent.schema_version, 1);
    assert.deepEqual(JSON.parse(res.result.content[0].text), res.result.structuredContent);
  } finally {
    cleanup(dir);
  }
});

test('gsd_record_uat_result returns the mutation and refreshed workbench', () => {
  const dir = createTempDir();
  try {
    const phase = path.join(dir, '.planning', 'phases', '01-test-phase');
    fs.mkdirSync(phase, { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
fs.writeFileSync(path.join(phase, '01-UAT.md'), `---
phase: 01-test-phase
status: testing
updated: 2025-01-01T00:00:00Z
---

## Current Test

number: 1
name: Sign in
expected: Sign in succeeds.
awaiting: user response

## Tests

### 1. Sign in
expected: Sign in succeeds.
result: pending

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
`);
    const res = call('gsd_record_uat_result', {
      project_path: dir,
      file_path: '.planning/phases/01-test-phase/01-UAT.md',
      test_number: 1,
      result: 'pass',
    });
    assert.equal(res.result.isError, undefined, res.result.content[0].text);
    assert.equal(res.result.structuredContent.mutation.file_path, '.planning/phases/01-test-phase/01-UAT.md');
    assert.equal(res.result.structuredContent.mutation.test_number, 1);
    assert.equal(res.result.structuredContent.mutation.result, 'pass');
    assert.equal(res.result.structuredContent.mutation.status, 'complete');
    assert.equal(res.result.structuredContent.mutation.next_test, null);
    assert.equal(res.result.structuredContent.workbench.project_path, dir);
    assert.deepEqual(res.result.structuredContent.workbench.results, []);
    assert.deepEqual(JSON.parse(res.result.content[0].text), res.result.structuredContent);
  } finally {
    cleanup(dir);
  }
});

test('Codex app resources are versioned HTML with border metadata', () => {
  for (const uri of ['ui://gsd/control-center-v1.html', 'ui://gsd/uat-workbench-v1.html']) {
    const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } });
    const content = res.result.contents[0];
    assert.equal(content.mimeType, 'text/html;profile=mcp-app');
    assert.equal(content._meta['ui.prefersBorder'], true);
    assert.match(content.text, /postMessage/);
    assert.match(content.text, /protocolVersion/);
    assert.match(content.text, /appCapabilities/);
    assert.match(content.text, /ui\/notifications\/initialized/);
    assert.match(content.text, /textContent/);
  }
});

test('MCP App resources expose semantic dashboards, not a manual JSON console', () => {
  const control = handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://gsd/control-center-v1.html' } }).result.contents[0].text;
  const workbench = handleMessage({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'ui://gsd/uat-workbench-v1.html' } }).result.contents[0].text;
  for (const label of ['Milestone', 'Active work', 'Progress', 'Phases', 'Diagnostics', 'Next action']) assert.match(control, new RegExp(label));
  for (const label of ['phase-filter', 'type-filter', 'Record pass', 'Record issue', 'note']) assert.match(workbench, new RegExp(label));
  for (const contract of ['uat?.unresolved', 'verification?.next_action']) assert.ok(control.includes(contract));
  for (const contract of ['message.error', 'item.expected', 'parse_gap', "querySelectorAll('button')"]) assert.ok(workbench.includes(contract));
  assert.doesNotMatch(control, /Load planning/);
  assert.doesNotMatch(workbench, /Load UAT/);
});

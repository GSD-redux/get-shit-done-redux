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

function callWithDispatch(name, arguments_, dispatch) {
  return handleMessage({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ },
  }, { dispatch });
}

function dispatchResult(value) {
  return { ok: true, stdout: JSON.stringify(value), stderr: '', code: 0, timedOut: false };
}

function planningSnapshot(overrides = {}) {
  return {
    schema_version: 1,
    generated_from: { cwd: '/project', planning_root: null },
    milestone: { version: null, name: null, scope: 'complete' },
    active: {
      phase: { value: null, scope: 'complete' },
      plan: { value: null, scope: 'complete' },
      status: { value: null, scope: 'complete' },
    },
    phases: [],
    orphan_phase_dirs: [],
    requirements: [],
    progress: {
      accepted_phases: { completed: 0, total: 0, percent: 100, scope: 'complete' },
      completed_plans: { completed: 0, total: 0, percent: 100, scope: 'complete' },
    },
    diagnostics: [],
    ...overrides,
  };
}

function workbench(overrides = {}) {
  return {
    results: [],
    summary: { total_files: 0, total_items: 0, parse_gap_files: 0, by_category: {}, by_phase: {} },
    ...overrides,
  };
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
  assert.equal(byName.gsd_record_uat_result._meta, undefined);
  assert.deepEqual(byName.gsd_record_uat_result.inputSchema.required, ['project_path', 'file_path', 'test_number', 'result']);
  assert.deepEqual(Object.keys(byName.gsd_record_uat_result.inputSchema.properties).sort(), ['file_path', 'note', 'project_path', 'result', 'test_number']);
});

test('Codex read tools reject malformed command schemas and cannot have project_path spoofed', () => {
  const dir = createTempDir();
  try {
    for (const malformed of [
      planningSnapshot({ schema_version: 2 }),
      planningSnapshot({ phases: {} }),
      planningSnapshot({ phases: [null] }),
      planningSnapshot({ phases: [{ dir: '01-test', phase_id: '01', verification: null, roadmap_acceptance: { checkbox: null }, uat: { unresolved: [] }, plan_count: 0 }] }),
      planningSnapshot({ phases: [{ dir: '01-test', phase_id: '01', verification: { status: 'passed', next_action: null }, roadmap_acceptance: { checkbox: null }, uat: { unresolved: [null] }, plan_count: 0 }] }),
      planningSnapshot({ diagnostics: 'none' }),
      planningSnapshot({ diagnostics: [null] }),
      planningSnapshot({ diagnostics: [{ code: 'broken', subject: 'x', detail: null }] }),
    ]) {
      const res = callWithDispatch('gsd_control_center', { project_path: dir }, () => dispatchResult(malformed));
      assert.equal(res.result.isError, true);
    }
    const control = callWithDispatch('gsd_control_center', { project_path: dir }, () => dispatchResult(planningSnapshot({ project_path: '/spoofed' })));
    assert.equal(control.result.structuredContent.project_path, fs.realpathSync(dir));

    for (const malformed of [
      { results: {}, summary: {} },
      { results: [], summary: [] },
      workbench({ results: [null] }),
      workbench({ results: [{ phase: '01', phase_dir: '01-test', file: '01-UAT.md', file_path: '.planning/phases/01-test/01-UAT.md', type: 'uat', status: 'testing', items: [null] }] }),
      workbench({ results: [{ phase: '01', phase_dir: '01-test', file: '01-UAT.md', file_path: '.planning/phases/01-test/01-UAT.md', type: 'uat', status: 'testing', items: [{ name: 'Check', result: 'pending', category: null }] }] }),
    ]) {
      const res = callWithDispatch('gsd_uat_workbench', { project_path: dir }, () => dispatchResult(malformed));
      assert.equal(res.result.isError, true);
    }
    const validWorkbench = callWithDispatch('gsd_uat_workbench', { project_path: dir }, () => dispatchResult(workbench({ project_path: '/spoofed' })));
    assert.equal(validWorkbench.result.structuredContent.project_path, fs.realpathSync(dir));
  } finally {
    cleanup(dir);
  }
});

test('gsd_record_uat_result rejects a blank issue note before dispatch', () => {
  const dir = createTempDir();
  try {
    let calls = 0;
    const res = callWithDispatch('gsd_record_uat_result', {
      project_path: dir,
      file_path: '.planning/phases/01-test/01-UAT.md',
      test_number: 1,
      result: 'issue',
      note: '   ',
    }, () => { calls += 1; return dispatchResult({}); });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /nonblank "note"/);
    assert.equal(calls, 0);

    const invalidTest = callWithDispatch('gsd_record_uat_result', {
      project_path: dir,
      file_path: '.planning/phases/01-test/01-UAT.md',
      test_number: 0,
      result: 'pass',
    }, () => { calls += 1; return dispatchResult({}); });
    assert.equal(invalidTest.result.isError, true);
    assert.equal(calls, 0);
  } finally {
    cleanup(dir);
  }
});

test('gsd_record_uat_result reports refresh failure without denying the durable mutation', () => {
  const dir = createTempDir();
  try {
    let calls = 0;
    const dispatch = () => {
      calls += 1;
      if (calls === 1) return dispatchResult({
        recorded: true,
        file_path: '.planning/phases/01-test/01-UAT.md',
        test_number: 1,
        result: 'pass',
        status: 'partial',
        next_test: 2,
      });
      return { ok: false, stdout: '', stderr: 'refresh unavailable', code: 1, timedOut: false };
    };
    const res = callWithDispatch('gsd_record_uat_result', {
      project_path: dir,
      file_path: '.planning/phases/01-test/01-UAT.md',
      test_number: 1,
      result: 'pass',
    }, dispatch);
    assert.equal(res.result.isError, undefined);
    assert.equal(res.result.structuredContent.mutation.result, 'pass');
    assert.equal(res.result.structuredContent.workbench, null);
    assert.match(res.result.structuredContent.refresh_error, /refresh unavailable/);
  } finally {
    cleanup(dir);
  }
});

test('gsd_record_uat_result rejects incomplete or mismatched CLI mutation output without refreshing', () => {
  const dir = createTempDir();
  const request = {
    project_path: dir,
    file_path: '.planning/phases/01-test/01-UAT.md',
    test_number: 1,
    result: 'pass',
  };
  try {
    for (const mutation of [
      { file_path: request.file_path, test_number: 1, result: 'pass', status: 'partial', next_test: 2 },
      { recorded: true, file_path: 'other.md', test_number: 1, result: 'pass', status: 'partial', next_test: 2 },
      { recorded: true, file_path: request.file_path, test_number: 2, result: 'pass', status: 'partial', next_test: 2 },
      { recorded: true, file_path: request.file_path, test_number: 1, result: 'issue', status: 'partial', next_test: 2 },
      { recorded: true, file_path: request.file_path, test_number: 1, result: 'pass', status: 'partial', next_test: 0 },
    ]) {
      let calls = 0;
      const res = callWithDispatch('gsd_record_uat_result', request, () => {
        calls += 1;
        return dispatchResult(mutation);
      });
      assert.equal(res.result.isError, true);
      assert.equal(calls, 1, 'invalid mutation output must not trigger a refresh');
    }
  } finally {
    cleanup(dir);
  }
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
    assert.equal(res.result.structuredContent.workbench.project_path, fs.realpathSync(dir));
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

test('MCP App resources honor the planning schema and iframe trust boundary', () => {
  const control = fs.readFileSync(path.join(__dirname, '..', 'assets', 'mcp-apps', 'control-center.html'), 'utf8');
  const workbench = fs.readFileSync(path.join(__dirname, '..', 'assets', 'mcp-apps', 'uat-workbench.html'), 'utf8');

  for (const source of [control, workbench]) {
    assert.match(source, /event\.source!==parent/);
    assert.match(source, /message\.id===initId.*message\.error/s);
  }
  assert.match(control, /phase\.phase_id\|\|phase\.dir/);
  assert.match(control, /roadmap_acceptance\?\.checkbox/);
  assert.match(control, /percent==null\?'withheld'/);
  assert.match(control, />Roadmap acceptance</);
});

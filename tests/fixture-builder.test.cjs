const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createFixture, seedPhase, seedWorkstream, writeState } = require('./fixtures/index.cjs');
const { cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const created = [];
afterEach(() => {
  while (created.length > 0) cleanup(created.pop());
});

describe('fixture builder module', () => {
  test('creates canonical planning layout by default', () => {
    const dir = createFixture();
    created.push(dir);

    assert.ok(fs.existsSync(path.join(dir, '.planning')), 'creates .planning directory');
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'phases')), 'creates .planning/phases directory');
  });

  test('seeds phase files declaratively', () => {
    const dir = createFixture();
    created.push(dir);

    const phaseDir = seedPhase(dir, '03-api', {
      '03-01-PLAN.md': '# Plan',
      '03-CONTEXT.md': '# Context',
    });

    assert.ok(fs.existsSync(path.join(phaseDir, '03-01-PLAN.md')));
    assert.ok(fs.existsSync(path.join(phaseDir, '03-CONTEXT.md')));
  });

  test('seeds workstream and active pointer declaratively', () => {
    const dir = createFixture();
    created.push(dir);

    const wsDir = seedWorkstream(dir, {
      name: 'alpha',
      state: '# State\n',
      roadmap: '# Roadmap\n',
      active: true,
    });

    assert.ok(fs.existsSync(path.join(wsDir, 'STATE.md')));
    assert.ok(fs.existsSync(path.join(wsDir, 'ROADMAP.md')));
    assert.strictEqual(
      fs.readFileSync(path.join(dir, '.planning', 'active-workstream'), 'utf8').trim(),
      'alpha'
    );
  });

  test('rejects invalid workstream names', () => {
    const dir = createFixture();
    created.push(dir);
    assert.throws(() => seedWorkstream(dir, { name: '../escape' }), /invalid name/);
  });

  test('writes STATE.md in canonical location', () => {
    const dir = createFixture();
    created.push(dir);

    const p = writeState(dir, '# Project State\n');
    assert.ok(fs.existsSync(p));
    assert.strictEqual(path.basename(p), 'STATE.md');
  });

  test('initializes git fixture with initial commit', () => {
    const dir = createFixture({ git: true });
    created.push(dir);

    const isWorkTree = gitOrThrow(['rev-parse', '--is-inside-work-tree'], { cwd: dir }).trim();
    assert.strictEqual(isWorkTree, 'true', 'fixture should be a git worktree');

    const head = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    assert.ok(head.length > 0, 'fixture should include initial commit');

    assert.ok(
      fs.existsSync(path.join(dir, '.planning', 'PROJECT.md')),
      'git fixture writes canonical PROJECT.md'
    );
  });
});

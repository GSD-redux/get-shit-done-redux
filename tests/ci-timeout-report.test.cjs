'use strict';

/**
 * tests/ci-timeout-report.test.cjs
 *
 * Unit tests for scripts/ci-timeout-report.cjs's pure exports (#4036).
 * main() is impure orchestration requiring a live Octokit/GitHub Actions
 * context and is intentionally NOT covered here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveJobTimeoutMinutes,
  parseJobRecord,
  buildReportLines,
  dedupeAgainstHistory,
} = require('../scripts/ci-timeout-report.cjs');

test('resolveJobTimeoutMinutes', async (t) => {
  await t.test('static job: resolves timeout-minutes from workflow YAML', () => {
    const yamlText = [
      'jobs:',
      '  test:',
      '    timeout-minutes: 15',
      '',
    ].join('\n');

    const result = resolveJobTimeoutMinutes({
      jobName: 'test (ubuntu-latest, 24, shard 1/3)',
      workflowFile: 'test.yml',
      workflowYamlText: yamlText,
      covered: null,
    });

    assert.equal(result, 15);
  });

  await t.test('mutation job: resolves override timeoutMinutes from COVERED', () => {
    const result = resolveJobTimeoutMinutes({
      jobName: 'Stryker (frontmatter)',
      workflowFile: 'mutation.yml',
      workflowYamlText: null,
      covered: { frontmatter: { timeoutMinutes: 20 }, 'adr-parser': {} },
    });

    assert.equal(result, 20);
  });

  await t.test('mutation job: falls back to default 15 when no override', () => {
    const result = resolveJobTimeoutMinutes({
      jobName: 'Stryker (adr-parser)',
      workflowFile: 'mutation.yml',
      workflowYamlText: null,
      covered: { frontmatter: { timeoutMinutes: 20 }, 'adr-parser': {} },
    });

    assert.equal(result, 15);
  });

  await t.test('mutation job: unknown module returns null', () => {
    const result = resolveJobTimeoutMinutes({
      jobName: 'Stryker (totally-unknown-module)',
      workflowFile: 'mutation.yml',
      workflowYamlText: null,
      covered: { frontmatter: { timeoutMinutes: 20 }, 'adr-parser': {} },
    });

    assert.equal(result, null);
  });

  await t.test('test-inert resolves against the test-inert job key, not test', () => {
    const yamlText = [
      'jobs:',
      '  test:',
      '    timeout-minutes: 15',
      '  test-inert:',
      '    timeout-minutes: 2',
      '',
    ].join('\n');

    const result = resolveJobTimeoutMinutes({
      jobName: 'test (inert CI)',
      workflowFile: 'test.yml',
      workflowYamlText: yamlText,
      covered: null,
    });

    assert.equal(result, 2);
  });
});

test('parseJobRecord', async (t) => {
  await t.test('still-running job (completed_at null) returns null', () => {
    const result = parseJobRecord({
      job: {
        name: 'test (ubuntu-latest, 24, shard 1/3)',
        completed_at: null,
        started_at: '2026-08-29T00:00:00Z',
        run_id: 1,
        head_sha: 'abc123',
      },
      workflowFile: 'test.yml',
      workflowYamlText: 'jobs:\n  test:\n    timeout-minutes: 15\n',
      covered: null,
    });

    assert.equal(result, null);
  });

  await t.test('untracked job name returns null', () => {
    for (const jobName of ['preflight', 'changes', 'lint-tests']) {
      const result = parseJobRecord({
        job: {
          name: jobName,
          completed_at: '2026-08-29T00:10:00Z',
          started_at: '2026-08-29T00:00:00Z',
          run_id: 1,
          head_sha: 'abc123',
        },
        workflowFile: 'test.yml',
        workflowYamlText: 'jobs:\n  test:\n    timeout-minutes: 15\n',
        covered: null,
      });

      assert.equal(result, null, `expected null for job name ${jobName}`);
    }
  });

  await t.test('valid smoke job returns a full record', () => {
    const yamlText = [
      'jobs:',
      '  smoke:',
      '    timeout-minutes: 12',
      '',
    ].join('\n');

    const result = parseJobRecord({
      job: {
        name: 'smoke (ubuntu-latest)',
        started_at: '2026-08-29T00:00:00Z',
        completed_at: '2026-08-29T00:06:00Z',
        run_id: 42,
        head_sha: 'deadbeef',
      },
      workflowFile: 'install-smoke.yml',
      workflowYamlText: yamlText,
      covered: null,
    });

    assert.ok(result);
    assert.equal(result.jobName, 'smoke (ubuntu-latest)');
    assert.equal(result.workflowFile, 'install-smoke.yml');
    assert.equal(result.runId, 42);
    assert.equal(result.sha, 'deadbeef');
    assert.equal(result.timeoutMinutes, 12);
    assert.equal(typeof result.pct, 'number');
  });
});

test('dedupeAgainstHistory', async (t) => {
  await t.test('excludes only the record already present in history', () => {
    const records = [
      { runId: 1, jobName: 'test (ubuntu-latest, 24, shard 1/3)', pct: 0.5 },
      { runId: 2, jobName: 'test (ubuntu-latest, 24, shard 2/3)', pct: 0.6 },
    ];
    const historyText = `${JSON.stringify({ runId: 1, jobName: 'test (ubuntu-latest, 24, shard 1/3)' })}\n`;

    const result = dedupeAgainstHistory(records, historyText);

    assert.equal(result.length, 1);
    assert.equal(result[0].runId, 2);
  });

  await t.test('same runId, different jobName: both kept when history is empty', () => {
    const records = [
      { runId: 1, jobName: 'test (ubuntu-latest, 24, shard 1/3)', pct: 0.5 },
      { runId: 1, jobName: 'test (ubuntu-latest, 24, shard 2/3)', pct: 0.6 },
    ];

    const result = dedupeAgainstHistory(records, '');

    assert.equal(result.length, 2);
  });

  await t.test('malformed history lines are skipped, not thrown', () => {
    const records = [
      { runId: 1, jobName: 'test (ubuntu-latest, 24, shard 1/3)', pct: 0.5 },
      { runId: 2, jobName: 'test (ubuntu-latest, 24, shard 2/3)', pct: 0.6 },
    ];
    const historyText = [
      JSON.stringify({ runId: 1, jobName: 'test (ubuntu-latest, 24, shard 1/3)' }),
      '',
      'not json{',
      '',
    ].join('\n');

    const result = dedupeAgainstHistory(records, historyText);

    assert.equal(result.length, 1);
    assert.equal(result[0].runId, 2);
  });
});

test('buildReportLines', async (t) => {
  await t.test('end-to-end: only tracked+completed jobs produce records', () => {
    const workflowYamlText = [
      'jobs:',
      '  test:',
      '    timeout-minutes: 15',
      '',
    ].join('\n');

    const runs = [
      {
        run: { id: 1, head_sha: 'sha1' },
        jobs: [
          {
            name: 'test (ubuntu-latest, 24, shard 1/3)',
            started_at: '2026-08-29T00:00:00Z',
            completed_at: '2026-08-29T00:05:00Z',
          },
          {
            name: 'test (ubuntu-latest, 24, shard 2/3)',
            started_at: '2026-08-29T00:00:00Z',
            completed_at: null,
          },
          {
            name: 'lint-tests',
            started_at: '2026-08-29T00:00:00Z',
            completed_at: '2026-08-29T00:01:00Z',
          },
        ],
      },
      {
        run: { id: 2, head_sha: 'sha2' },
        jobs: [
          {
            name: 'test (ubuntu-latest, 24, shard 3/3)',
            started_at: '2026-08-29T00:00:00Z',
            completed_at: '2026-08-29T00:07:00Z',
          },
        ],
      },
    ];

    const result = buildReportLines(runs, { workflowFile: 'test.yml', workflowYamlText, covered: null });

    assert.equal(result.length, 2);
    const names = result.map((r) => r.jobName).sort();
    assert.deepEqual(names, [
      'test (ubuntu-latest, 24, shard 1/3)',
      'test (ubuntu-latest, 24, shard 3/3)',
    ]);
    for (const name of names) {
      assert.equal(names.filter((n) => n === name).length, 1);
    }
  });
});

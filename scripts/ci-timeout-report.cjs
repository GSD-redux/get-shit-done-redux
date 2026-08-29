'use strict';

/**
 * scripts/ci-timeout-report.cjs
 *
 * Scheduled CI-timeout trending report (#4036). Polls GitHub's Actions REST
 * API for recently completed jobs across test.yml, mutation.yml, and
 * install-smoke.yml, resolves each job's declared `timeout-minutes` budget,
 * computes elapsed-vs-cap via scripts/lib/ci-job-timing.cjs, and appends
 * new (never-before-seen) records to a JSONL history file. Every record also
 * carries the triggering `runEvent` (e.g. `push`/`pull_request`) so entries
 * for jobs whose matrix genuinely differs by trigger (e.g. `smoke`'s
 * push-only macOS row) can be told apart in the persisted trend — records
 * are never filtered by event, only labeled.
 *
 * Invoked from a GitHub Actions workflow via actions/github-script, e.g.:
 *   const report = require(`${process.env.GITHUB_WORKSPACE}/scripts/ci-timeout-report.cjs`);
 *   const result = await report.main({ github, context, core });
 */

const yaml = require('js-yaml');
const fs = require('node:fs');
const path = require('node:path');
const {
  computeElapsedPct, isNearCap, formatNearCapNotice,
} = require('./lib/ci-job-timing.cjs');

const HISTORY_PATH = path.join(__dirname, '..', 'tests', 'ci-timeout-budget-history.jsonl');
const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');

// Static job name → job-id rules, first match wins, checked in array order
// (test-inert before test, since both job names start with "test ").
const JOB_RULES = [
  { workflowFile: 'test.yml', jobKey: 'test-inert', test: (name) => name === 'test (inert CI)' },
  { workflowFile: 'test.yml', jobKey: 'test', test: (name) => name.startsWith('test (') && name !== 'test (inert CI)' },
  { workflowFile: 'test.yml', jobKey: 'test-full', test: (name) => name.startsWith('full test (') },
  { workflowFile: 'test.yml', jobKey: 'coverage-gate', test: (name) => name === 'Coverage gate (merged shards)' },
  { workflowFile: 'install-smoke.yml', jobKey: 'smoke', test: (name) => name.startsWith('smoke (') },
];

function resolveJobTimeoutMinutes({ jobName, workflowFile, workflowYamlText, covered }) {
  if (workflowFile === 'mutation.yml') {
    const m = jobName.match(/^Stryker \(([^)]+)\)$/);
    if (!m) return null;
    const moduleName = m[1];
    if (!covered || !Object.prototype.hasOwnProperty.call(covered, moduleName)) return null;
    return covered[moduleName].timeoutMinutes || 15;
  }

  const rule = JOB_RULES.find((r) => r.workflowFile === workflowFile && r.test(jobName));
  if (!rule) return null;

  const doc = yaml.load(workflowYamlText);
  const budget = doc && doc.jobs && doc.jobs[rule.jobKey] ? doc.jobs[rule.jobKey]['timeout-minutes'] : undefined;
  return typeof budget === 'number' ? budget : null;
}

/**
 * @param {{job: object, workflowFile: string, workflowYamlText: ?string, covered: ?object}} args
 *   `job.runEvent` is the triggering event (e.g. `push`/`pull_request`) — carried through to
 *   the returned record so entries whose matrix genuinely differs by trigger (e.g. `smoke`'s
 *   push-only macOS row) can be distinguished in the persisted history.
 */
function parseJobRecord({ job, workflowFile, workflowYamlText, covered }) {
  if (!job.completed_at) return null;

  const timeoutMinutes = resolveJobTimeoutMinutes({ jobName: job.name, workflowFile, workflowYamlText, covered });
  if (timeoutMinutes == null) return null;

  const { elapsedMs, pct } = computeElapsedPct({
    startedAt: job.started_at, completedAt: job.completed_at, timeoutMinutes,
  });

  return {
    runId: job.run_id,
    jobName: job.name,
    workflowFile,
    sha: job.head_sha,
    runEvent: job.runEvent,
    completedAt: job.completed_at,
    elapsedMs,
    timeoutMinutes,
    pct,
  };
}

function buildReportLines(runs, { workflowFile, workflowYamlText, covered }) {
  const records = [];
  for (const { run, jobs } of runs) {
    for (const job of jobs) {
      const rec = parseJobRecord({
        job: {
          ...job, run_id: run.id, head_sha: run.head_sha, runEvent: run.event,
        },
        workflowFile,
        workflowYamlText,
        covered,
      });
      if (rec) records.push(rec);
    }
  }
  return records;
}

function dedupeAgainstHistory(newRecords, historyText) {
  const seen = new Set();
  for (const line of String(historyText || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      seen.add(`${rec.runId}::${rec.jobName}`);
    } catch {
      // Malformed history line — skip it rather than crash the whole report.
    }
  }
  return newRecords.filter((r) => !seen.has(`${r.runId}::${r.jobName}`));
}

function formatHistoryLine(record) {
  return `${JSON.stringify(record)}\n`;
}

const WORKFLOW_FILES = ['test.yml', 'mutation.yml', 'install-smoke.yml'];
const MAX_RUNS_PER_WORKFLOW = 15;

/**
 * Orchestration entry point — impure, invoked from actions/github-script.
 *
 * @param {{github: object, context: object, core: object, historyPath?: string, fs?: object}} args
 * @returns {Promise<{added: number, nearCap: number}>}
 */
async function main({
  github, context, core, historyPath = HISTORY_PATH, fs: fsImpl = fs,
}) {
  const { owner, repo } = context.repo;
  const mutationMatrix = require('./mutation-matrix.cjs');

  const allNewRecords = [];

  for (const workflowFile of WORKFLOW_FILES) {
    const covered = workflowFile === 'mutation.yml' ? mutationMatrix.COVERED : null;
    const workflowYamlText = workflowFile === 'mutation.yml'
      ? null
      : fsImpl.readFileSync(path.join(WORKFLOWS_DIR, workflowFile), 'utf8');

    let runsList;
    try {
      runsList = await github.paginate(github.rest.actions.listWorkflowRuns, {
        owner,
        repo,
        workflow_id: workflowFile,
        status: 'completed',
        per_page: 30,
      });
    } catch (err) {
      core.warning(`ci-timeout-report: failed to list runs for ${workflowFile}: ${err.message}`);
      continue;
    }

    const runs = runsList.slice(0, MAX_RUNS_PER_WORKFLOW);
    const runsWithJobs = [];

    for (const run of runs) {
      try {
        const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
          owner,
          repo,
          run_id: run.id,
          per_page: 50,
        });
        runsWithJobs.push({ run, jobs });
      } catch (err) {
        core.warning(`ci-timeout-report: failed to list jobs for ${workflowFile} run ${run.id}: ${err.message}`);
      }
    }

    const records = buildReportLines(runsWithJobs, { workflowFile, workflowYamlText, covered });
    allNewRecords.push(...records);
  }

  let historyText = '';
  try {
    historyText = fsImpl.readFileSync(historyPath, 'utf8');
  } catch {
    // First run — history file does not exist yet, treat as empty.
    historyText = '';
  }

  const deduped = dedupeAgainstHistory(allNewRecords, historyText);

  if (deduped.length > 0) {
    const newLines = deduped.map(formatHistoryLine).join('');
    fsImpl.appendFileSync(historyPath, newLines);
  }
  // First-run bootstrap when there is nothing new to append is handled by
  // `git add` picking up whatever the history file already contains.

  let nearCapCount = 0;
  for (const record of deduped) {
    if (!isNearCap(record.pct)) continue;
    nearCapCount += 1;

    const notice = formatNearCapNotice({
      label: `${record.jobName} (run ${record.runId})`,
      pct: record.pct,
      elapsedMs: record.elapsedMs,
      capMs: record.timeoutMinutes * 60000,
    });

    core.warning(notice.warningLine.replace(/^::warning title=CI budget::/, ''));

    if (core.summary) {
      core.summary.addRaw(`${notice.summaryMarkdown}\n`);
    }
  }

  return { added: deduped.length, nearCap: nearCapCount };
}

module.exports = {
  HISTORY_PATH,
  WORKFLOWS_DIR,
  JOB_RULES,
  resolveJobTimeoutMinutes,
  parseJobRecord,
  buildReportLines,
  dedupeAgainstHistory,
  formatHistoryLine,
  main,
};

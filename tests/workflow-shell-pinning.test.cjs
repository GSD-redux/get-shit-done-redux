'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Asserts that every `run:` step whose command begins with `npm ` in any
 * .github/workflows/*.yml file has an effective `shell:` directive that is
 * H1-policy-compliant (native shell per OS).
 *
 * H1 policy (LOCKED — open-gsd/gsd-core):
 *   ubuntu-* → bash (runner default, no pin needed)
 *   macos-*  → zsh  (must be pinned explicitly)
 *   windows-* → pwsh (runner default, no pin needed)
 *
 * "Effective shell" is resolved as:
 *   step.shell ?? job.defaults.run.shell ?? workflow.defaults.run.shell ?? runner_default
 *
 * Under H1, Windows runner default is pwsh. pwsh does NOT have the npm.cmd
 * stderr-swallow issue that prompted the original bash requirement — that issue
 * was specific to running bash-wrapped npm in a pwsh session. With H1 in force,
 * Windows npm steps run natively under pwsh and are reliable.
 *
 * Violation conditions (H1-aware):
 *   - An npm run: step on a Windows runner has shell: bash (wrong shell for OS,
 *     and reintroduces the pwsh/bash interop issue H1 is designed to eliminate).
 *   - An npm run: step on a macOS runner has no effective shell (macos default
 *     is bash, but H1 requires zsh — tracked by policy-shell-pinning.test.cjs).
 *
 * This test enforces the Windows side: Windows npm steps MUST NOT use shell: bash
 * (either directly or via job/workflow defaults). No shell pin = pwsh default = correct.
 *
 * Scope: only workflow files that reference a Windows hosted runner label.
 * Acceptable outcomes: no shell pin (pwsh default), or explicit shell: pwsh.
 * Unacceptable: shell: bash (H1 violation on Windows).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * Collect all .yml / .yaml files under the workflows directory.
 *
 * Only files that reference a Windows hosted label (`windows-latest` or
 * `windows-2025`, as a literal runs-on value or inside a matrix.os list) are
 * class can only manifest in workflows that target Windows runners.
 */
function listWorkflowFiles() {
  const entries = fs.readdirSync(WORKFLOWS_DIR);
  const all = entries
    .filter((e) => /\.ya?ml$/.test(e))
    .map((e) => path.join(WORKFLOWS_DIR, e));

  // Filter to files that have at least one Windows hosted-runner reference.
  // allow-test-rule: source-text-is-the-product
  // Reads the shipped .github/workflows/*.yml — the deployed text GitHub
  // Actions executes — to detect whether a workflow targets Windows runners
  // at all. The pwsh
  // stderr-swallow class is windows-only, so files that never mention
  // windows-hosted labels are out of scope. Exposing a typed IR from production
  // code is not appropriate here because the source-of-truth is the YAML
  // itself; the actual test assertions below ARE structural (parse runs-on,
  // strategy.matrix.os, defaults.run.shell, etc.).
  return all.filter((f) => {
    const raw = fs.readFileSync(f, 'utf8');
    return raw.includes('windows-latest') || raw.includes('windows-2025');
  });
}

/**
 * Return the number of leading spaces in a line.
 */
function indentOf(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

/**
 * Parse a workflow YAML file with a line-based scanner.
 *
 * Returns an array of violation objects:
 *   { file, job, stepIndex, stepName, runLine }
 *
 * A violation is a `run:` step whose command starts with `npm ` and that
 * does NOT have an effective `shell:` directive.  Effective shell is:
 *   step.shell ?? job.defaults.run.shell ?? workflow.defaults.run.shell
 *
 * Strategy:
 * 1. Walk lines top-to-bottom tracking workflow-level defaults.run.shell.
 * 2. Track job keys (jobs.<key>) and their defaults.run.shell.
 * 3. Detect step boundaries: a line matching /^\s+-\s+(name:|uses:|run:)/ at
 *    "step list" indentation (8 spaces for most workflows, detected
 *    dynamically) opens a new step context.
 * 4. Within a step context, collect all keys (name, run, shell, uses, …).
 * 5. At the END of each step context (next step boundary or end-of-job),
 *    emit a violation if `run` starts with `npm ` and effective shell is null.
 */
function findViolations(filePath) {
  const relFile = path.relative(REPO_ROOT, filePath);
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const violations = [];

  // Workflow-level defaults.run.shell
  let workflowDefaultShell = null;

  // ── State machine ─────────────────────────────────────────────────────────
  let inJobs = false;
  let currentJob = null;
  let jobDefaultShell = null;   // job-level defaults.run.shell

  // Section tracking for defaults blocks
  // We need to detect:
  //   defaults:         (at col 0 = workflow level, or col 2 = job level)
  //     run:
  //       shell: bash
  let inDefaultsBlock = false;    // currently inside a `defaults:` mapping
  let inDefaultsRunBlock = false; // currently inside `defaults: run:`
  let defaultsBlockOwner = null;  // 'workflow' or 'job'
  let _defaultsBlockCol = null;    // column of the `defaults:` key

  // Strategy/matrix tracking
  let _inStrategyBlock = false;
  let _inMatrixBlock = false;
  let _inMatrixOsBlock = false;
  let _strategyCol = null;
  let _matrixCol = null;

  // Step tracking
  let stepIndent = null;      // indent level of the `- name:/run:/uses:` items
  let inStep = false;
  let stepIndex = -1;
  let stepProps = null;       // { name, run, shell }

  /**
   * Flush the current step: emit a violation if it qualifies.
   *
   * H1-aware check: Windows npm steps must NOT use shell: bash.
   * Under H1, Windows runner default is pwsh (native, reliable for npm).
   * Using shell: bash on Windows is an H1 policy violation AND reintroduces
   * the pwsh/bash interop issue the original rule was designed to prevent.
   *
   * Effective shell = step.shell ?? jobDefaultShell ?? workflowDefaultShell
   * (null means runner default applies — pwsh for windows, which is correct)
   */
  function flushStep() {
    if (!inStep || stepProps === null) return;
    const { name, run, shell } = stepProps;
    const effectiveShell = shell !== null ? shell
      : jobDefaultShell !== null ? jobDefaultShell
      : workflowDefaultShell;
    // H1 violation: npm step on Windows with shell: bash (explicit or via defaults)
    if (run !== null && /^\s*(?:npm|npx)(\s|$)/.test(run) && effectiveShell === 'bash') {
      violations.push({
        file: relFile,
        job: currentJob,
        stepIndex,
        stepName: name || '(unnamed)',
        effectiveShell,
      });
    }
    inStep = false;
    stepProps = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const col = indentOf(line);

    // Skip blank lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // ── Workflow-level `defaults:` block (col 0) ──────────────────────────
    // Detect `defaults:` at the root level (before `jobs:`)
    if (!inJobs && /^defaults\s*:/.test(line)) {
      inDefaultsBlock = true;
      inDefaultsRunBlock = false;
      defaultsBlockOwner = 'workflow';
      _defaultsBlockCol = 0;
      continue;
    }

    if (inDefaultsBlock && defaultsBlockOwner === 'workflow') {
      // A key at col 0 that isn't blank/comment ends the defaults block
      if (col === 0 && !/^\s/.test(line)) {
        inDefaultsBlock = false;
        inDefaultsRunBlock = false;
      } else if (/^\s+run\s*:/.test(line) && col === 2) {
        inDefaultsRunBlock = true;
      } else if (inDefaultsRunBlock && /^\s+shell\s*:\s*(\S+)/.test(line)) {
        const m = line.match(/^\s+shell\s*:\s*(\S+)/);
        if (m) workflowDefaultShell = m[1];
      }
    }

    // ── `jobs:` section ───────────────────────────────────────────────────
    if (/^jobs\s*:/.test(line)) {
      inJobs = true;
      inDefaultsBlock = false;
      inDefaultsRunBlock = false;
      continue;
    }

    if (!inJobs) continue;

    // ── Job-level keys at indent 2 ────────────────────────────────────────
    if (col === 2 && /^[a-zA-Z0-9_-]+\s*:/.test(trimmed)) {
      flushStep();
      currentJob = trimmed.replace(/\s*:.*/, '');
      stepIndent = null;
      inStep = false;
      stepIndex = -1;
      jobDefaultShell = null;
      // Reset sub-section tracking
      inDefaultsBlock = false;
      inDefaultsRunBlock = false;
      _inStrategyBlock = false;
      _inMatrixBlock = false;
      _inMatrixOsBlock = false;
      continue;
    }

    if (currentJob === null) continue;

    // ── Job-level `defaults:` block (col 4) ──────────────────────────────
    if (col === 4 && /^defaults\s*:/.test(trimmed)) {
      inDefaultsBlock = true;
      inDefaultsRunBlock = false;
      defaultsBlockOwner = 'job';
      _defaultsBlockCol = 4;
      continue;
    }

    if (inDefaultsBlock && defaultsBlockOwner === 'job') {
      if (col <= 4 && !/^\s{5}/.test(line)) {
        // Back to job level or above — end defaults block
        inDefaultsBlock = false;
        inDefaultsRunBlock = false;
      } else if (col === 6 && /^run\s*:/.test(trimmed)) {
        inDefaultsRunBlock = true;
      } else if (inDefaultsRunBlock && col === 8 && /^shell\s*:\s*(\S+)/.test(trimmed)) {
        const m = trimmed.match(/^shell\s*:\s*(\S+)/);
        if (m) jobDefaultShell = m[1];
      }
    }

    // ── Step list detection ───────────────────────────────────────────────
    const stepStartMatch = line.match(
      /^(\s+)-\s+(name|run|uses|shell|if|id|env|with|continue-on-error|timeout-minutes|working-directory)\s*[:|]/,
    );
    if (stepStartMatch) {
      const thisIndent = stepStartMatch[1].length;

      if (stepIndent === null) {
        stepIndent = thisIndent;
      }

      if (thisIndent === stepIndent) {
        // New step boundary
        flushStep();
        stepIndex += 1;
        inStep = true;
        stepProps = { name: null, run: null, shell: null };
        // Reset defaults sub-tracking when we enter the steps section
        inDefaultsBlock = false;
        inDefaultsRunBlock = false;

        // Parse the key on this same line
        const keyMatch = line.match(/^\s+-\s+(name|run|shell|uses)\s*:\s*(.*)/);
        if (keyMatch) {
          const key = keyMatch[1];
          const val = keyMatch[2].trim();
          if (key === 'name') stepProps.name = val || null;
          else if (key === 'run') stepProps.run = val || null;
          else if (key === 'shell') stepProps.shell = val || null;
        }
        continue;
      }
    }

    // ── Inside a step: parse continuation key-value pairs ─────────────────
    if (inStep && stepIndent !== null && col > stepIndent) {
      const kvMatch = line.match(/^\s+(name|run|shell|uses)\s*:\s*(.*)/);
      if (kvMatch) {
        const key = kvMatch[1];
        const val = kvMatch[2].trim();
        if (key === 'run') {
          if (val && val !== '|') {
            stepProps.run = val;
          } else {
            // Multi-line run block — find first non-empty continuation line
            let j = i + 1;
            while (j < lines.length) {
              const contLine = lines[j];
              const contTrimmed = contLine.trimStart();
              if (contTrimmed === '' || contTrimmed.startsWith('#')) { j++; continue; }
              if (indentOf(contLine) <= col) break;
              stepProps.run = contTrimmed;
              break;
            }
          }
        } else if (key === 'shell') {
          stepProps.shell = val || null;
        } else if (key === 'name') {
          stepProps.name = val || null;
        }
      }
    }
  }

  // Flush the last step
  flushStep();

  return violations;
}

// ── Unit helper: scanner exercised against a synthetic YAML string ──────────

/**
 * Parse violation list from a raw YAML string (written to a temp file).
 * Used by the defaults.run.shell unit test below.
 */
function findViolationsInString(yamlContent) {
  const tmpPath = path.join(require('os').tmpdir(), `gsd-shell-test-${process.pid}.yml`);
  fs.writeFileSync(tmpPath, yamlContent, 'utf8');
  try {
    return findViolations(tmpPath);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe('GitHub Actions workflow shell pinning', () => {
  test('npm ci/run steps in Windows-targeting workflow files must not use shell: bash (H1 policy)', () => {
    const workflowFiles = listWorkflowFiles();
    assert.ok(workflowFiles.length > 0, 'No windows-targeting workflow files found — check WORKFLOWS_DIR path');

    const allViolations = [];
    for (const wf of workflowFiles) {
      const v = findViolations(wf);
      allViolations.push(...v);
    }

    if (allViolations.length > 0) {
      const details = allViolations.map(
        (v) => `  jobs.${v.job}.steps[${v.stepIndex}].name = ${v.stepName}  shell=${v.effectiveShell}  (${v.file})`,
      ).join('\n');
      assert.fail(
        `${allViolations.length} npm run/ci step(s) use shell: bash in a Windows-targeting workflow file.\n` +
        `H1 policy: Windows runners must use pwsh (runner default — no explicit pin needed).\n` +
        `shell: bash on Windows is both an H1 violation and reintroduces pwsh/bash interop issues.\n` +
        `Remove the shell: bash directive (or change to shell: pwsh) on each listed step:\n\n` +
        details,
      );
    }
  });

  test('workflow-level defaults.run.shell: bash on Windows-targeting workflow is an H1 violation', () => {
    // H1: Windows runners must use pwsh (runner default). Setting defaults.run.shell: bash
    // at the workflow level forces npm steps on Windows to use bash — an H1 violation.
    const yaml = `
name: Test
on: push
defaults:
  run:
    shell: bash
jobs:
  build:
    runs-on: windows-latest
    steps:
      - name: Install
        run: npm ci
      - name: Build
        run: npm run build
`.trimStart();
    const violations = findViolationsInString(yaml);
    assert.strictEqual(
      violations.length,
      2,
      `Expected 2 violations (both npm steps inherit shell: bash via workflow defaults — H1 violation), got:\n` +
        violations.map((v) => `  steps[${v.stepIndex}] ${v.stepName} shell=${v.effectiveShell}`).join('\n'),
    );
  });

  test('job-level defaults.run.shell: bash on Windows job is an H1 violation', () => {
    // H1: Windows runners must use pwsh. job-level defaults.run.shell: bash
    // forces Windows npm steps to use bash — an H1 violation.
    const yaml = `
name: Test
on: push
jobs:
  build:
    runs-on: windows-latest
    defaults:
      run:
        shell: bash
    steps:
      - name: Install
        run: npm ci
      - name: Build
        run: npm run build
`.trimStart();
    const violations = findViolationsInString(yaml);
    assert.strictEqual(
      violations.length,
      2,
      `Expected 2 violations (both npm steps inherit shell: bash via job defaults — H1 violation), got:\n` +
        violations.map((v) => `  steps[${v.stepIndex}] ${v.stepName} shell=${v.effectiveShell}`).join('\n'),
    );
  });
});

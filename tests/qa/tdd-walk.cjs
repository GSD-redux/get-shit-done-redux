'use strict';

/**
 * tdd-walk.cjs — a small stateful harness proving the TDD-dispatch predicate
 * resolves correctly END-TO-END, mirroring the discipline `tests/qa/loop-walk.cjs`
 * brings to the loop subsystem: invoke the REAL shipped mechanism against a
 * REAL temp project, never reimplement or grep-simulate it (#4298, Phase 5 of
 * epic #4272).
 *
 * WHAT'S EXECUTABLE VS WHAT ISN'T (see
 * `.gsd/phase/chore-4298-tdd-walk-qa-harness/40-design.md`): the two TDD
 * dispatch backends' `${TDD_APPLICABLE ? "..." : ""}` embed-list markers are
 * LLM-orchestrator pseudo-syntax composed by the agent reading the workflow
 * markdown at dispatch time — they are NOT real bash and cannot be executed
 * by a shell. What IS real, executable bash is the resolution block that
 * computes the `TDD_APPLICABLE` variable itself:
 *   - `gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md`
 *     ("harness" backend) — one self-contained fenced block: its own
 *     `gsd_run` shim-discovery preamble, then the `TDD_APPLICABLE_RAW=...` /
 *     `TDD_APPLICABLE_RC=$?` / fail-closed check / `TDD_APPLICABLE=` assignment.
 *   - `gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md`
 *     ("worktree" backend) — the `gsd_run` shim-discovery preamble lives in
 *     the file's FIRST fenced block, which is not just the shim: it is the
 *     whole ISOLATION resolution (its own independent fail-closed branches),
 *     ahead of a LATER fenced block that contains the `_TDD_APPLICABLE_RAW=...`
 *     resolution followed by the `EXECUTOR_PROMPT=` composition this harness
 *     does not need. A standalone execution must concatenate the first block
 *     (for its `gsd_run` definition) with just the TDD resolution lines
 *     sliced out of the second.
 *
 * This module extracts each backend's real bash via `indexOf`/`slice` on the
 * fenced-code markers (NEVER a backtracking regex over the whole file — see
 * `tests/tdd-single-statement.test.cjs`'s `restatesCycle()` header for the
 * documented #4228 incident: a lazy-quantifier regex over a 47KB file pinned
 * a Windows CI runner for 32 minutes), substitutes the plan's placeholders,
 * and executes the result via a real `bash -c` subprocess against a real
 * fixture project built with `tests/helpers.cjs`'s `createTempProject`.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createTempProject, cleanup, runGsdTools, readFileNormalized, TEST_ENV_BASE } = require('../helpers.cjs');

/** Absolute real repo root — NOT the temp fixture's own root. */
const REPO_ROOT = path.join(__dirname, '..', '..');

const RESOLUTION_STEP_PATH = path.join(
  REPO_ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'tdd-applicability-resolution.md',
);
const DISPATCH_STEP_PATH = path.join(
  REPO_ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md',
);

const FENCE_OPEN = '```bash';
const FENCE_CLOSE = '```';

// The exact slice boundaries inside executor-isolation-dispatch.md's later
// fenced block (see module header). Extracted by literal substring search,
// never a regex, per the #4228 constraint.
const TDD_SLICE_START_MARKER = '_TDD_APPLICABLE_RAW=';
const TDD_SLICE_END_MARKER = 'TDD_APPLICABLE="$_TDD_APPLICABLE_RAW"';

// The pseudo-bash embed-list ternary this harness's resolved value ultimately
// gates (#3800/#4266) — NOT executable, documented here only so the QA
// self-tests can confirm it exists over the real shipped file without a
// second, independently-typed copy drifting from it.
const TDD_EMBED_TERNARY = '${TDD_APPLICABLE ? "- tdd.md" : ""}';

/**
 * Extract the Nth (0-indexed) fenced ` ```bash ... ``` ` block's body from
 * `content`, verbatim (fence markers excluded), via `indexOf`/`slice`.
 *
 * @param {string} content
 * @param {number} [occurrence] - 0-indexed occurrence to extract.
 * @returns {string}
 */
function extractFencedBashBlock(content, occurrence = 0) {
  let searchFrom = 0;
  for (let i = 0; i <= occurrence; i += 1) {
    const openIdx = content.indexOf(FENCE_OPEN, searchFrom);
    if (openIdx === -1) {
      throw new Error(
        `extractFencedBashBlock: could not find occurrence ${i} of "${FENCE_OPEN}" (wanted occurrence ${occurrence})`,
      );
    }
    const bodyStart = openIdx + FENCE_OPEN.length;
    const closeIdx = content.indexOf(FENCE_CLOSE, bodyStart);
    if (closeIdx === -1) {
      throw new Error(`extractFencedBashBlock: unterminated fenced block opened at offset ${openIdx}`);
    }
    if (i === occurrence) {
      let body = content.slice(bodyStart, closeIdx);
      if (body.startsWith('\n')) body = body.slice(1);
      if (body.endsWith('\n')) body = body.slice(0, -1);
      return body;
    }
    searchFrom = closeIdx + FENCE_CLOSE.length;
  }
  throw new Error('extractFencedBashBlock: unreachable');
}

/**
 * Scan every fenced ` ```bash ... ``` ` block in `content`, in document
 * order, and return the body of the first one whose body contains the
 * literal substring `marker`.
 *
 * @param {string} content
 * @param {string} marker
 * @returns {string}
 */
function extractFencedBashBlockContaining(content, marker) {
  let searchFrom = 0;
  for (;;) {
    const openIdx = content.indexOf(FENCE_OPEN, searchFrom);
    if (openIdx === -1) {
      throw new Error(`extractFencedBashBlockContaining: no fenced bash block contains "${marker}"`);
    }
    const bodyStart = openIdx + FENCE_OPEN.length;
    const closeIdx = content.indexOf(FENCE_CLOSE, bodyStart);
    if (closeIdx === -1) {
      throw new Error(`extractFencedBashBlockContaining: unterminated fenced block opened at offset ${openIdx}`);
    }
    const body = content.slice(bodyStart, closeIdx);
    if (body.indexOf(marker) !== -1) {
      return body.startsWith('\n') ? body.slice(1) : body;
    }
    searchFrom = closeIdx + FENCE_CLOSE.length;
  }
}

/**
 * From executor-isolation-dispatch.md's later fenced block (the one composing
 * `EXECUTOR_PROMPT`), slice out ONLY the TDD-applicability resolution lines:
 * from `_TDD_APPLICABLE_RAW=` through the `TDD_APPLICABLE="$_TDD_APPLICABLE_RAW"`
 * line, inclusive. Everything before (comments) and after (`EXECUTOR_PROMPT=...`)
 * is dropped.
 *
 * @param {string} blockBody
 * @returns {string}
 */
function sliceTddResolution(blockBody) {
  const startIdx = blockBody.indexOf(TDD_SLICE_START_MARKER);
  if (startIdx === -1) {
    throw new Error(`sliceTddResolution: start marker "${TDD_SLICE_START_MARKER}" not found`);
  }
  const endMarkerIdx = blockBody.indexOf(TDD_SLICE_END_MARKER, startIdx);
  if (endMarkerIdx === -1) {
    throw new Error(`sliceTddResolution: end marker "${TDD_SLICE_END_MARKER}" not found after start marker`);
  }
  const endOfLineIdx = blockBody.indexOf('\n', endMarkerIdx);
  const sliceEnd = endOfLineIdx === -1 ? blockBody.length : endOfLineIdx;
  return blockBody.slice(startIdx, sliceEnd);
}

/**
 * Build the standalone, placeholder-substituted bash script for one backend.
 *
 * @param {'harness'|'worktree'} backend
 * @param {{phaseDir: string, planFile: string, planNumber: string}} placeholders
 * @returns {string}
 */
function buildBackendScript(backend, placeholders) {
  let template;
  if (backend === 'harness') {
    template = extractFencedBashBlock(readFileNormalized(RESOLUTION_STEP_PATH), 0);
  } else if (backend === 'worktree') {
    const dispatchContent = readFileNormalized(DISPATCH_STEP_PATH);
    const preamble = extractFencedBashBlock(dispatchContent, 0);
    const laterBlock = extractFencedBashBlockContaining(dispatchContent, TDD_SLICE_START_MARKER);
    const resolution = sliceTddResolution(laterBlock);
    template = `${preamble}\n${resolution}`;
  } else {
    throw new Error(`buildBackendScript: unknown backend "${backend}" (expected "harness" or "worktree")`);
  }
  const substituted = template
    .replaceAll('{phase_dir}', placeholders.phaseDir)
    .replaceAll('{plan_file}', placeholders.planFile)
    .replaceAll('{plan_number}', placeholders.planNumber);
  return `${substituted}\necho "TDD_APPLICABLE_RESULT=$TDD_APPLICABLE"\n`;
}

/** Parse the `TDD_APPLICABLE_RESULT=<value>` sentinel out of stdout via indexOf/slice. */
function parseResultSentinel(stdout) {
  const marker = 'TDD_APPLICABLE_RESULT=';
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) return undefined;
  const valueStart = idx + marker.length;
  const lineEndIdx = stdout.indexOf('\n', valueStart);
  return lineEndIdx === -1 ? stdout.slice(valueStart) : stdout.slice(valueStart, lineEndIdx);
}

/**
 * Execute a backend's extracted script for real, via `bash -c`, against
 * `cwd`. Never throws: a non-zero exit is captured and returned as a normal
 * `{success: false, ...}` value so a caller can assert "this backend failed
 * closed" without a try/catch.
 *
 * @param {string} script
 * @param {string} cwd
 * @returns {{success: true, value: string|undefined, stdout: string, stderr: string}
 *   | {success: false, status: number|null, stdout: string, stderr: string}}
 */
function executeBackendScript(script, cwd) {
  try {
    // #4298 Standards+Spec review: `runGsdTools` (tests/helpers.cjs) scrubs
    // SESSION_IDENTITY_ENV_KEYS + config-location env vars before spawning,
    // because an ambient developer/CI value (e.g. a real ~/.gsd/config.json
    // location override) can silently change what a gsd-tools child resolves
    // — documented there as #2665. This harness spawns `gsd_run` the exact
    // same way (indirectly, via the extracted resolution script), so it needs
    // the same hermeticity: spread the exported `TEST_ENV_BASE` (every
    // scrub-listed key set to '') AFTER `...process.env` but BEFORE the two
    // intentional overrides below, so ambient state is blanked and only
    // RUNTIME_DIR/GSD_TEST_MODE are deliberately set.
    const stdout = execFileSync('bash', ['-c', script], {
      cwd,
      env: { ...process.env, ...TEST_ENV_BASE, RUNTIME_DIR: REPO_ROOT, GSD_TEST_MODE: '1' },
      encoding: 'utf8',
      timeout: 30000,
    });
    return { success: true, value: parseResultSentinel(stdout), stdout, stderr: '' };
  } catch (error) {
    return {
      success: false,
      status: typeof error.status === 'number' ? error.status : null,
      stdout: error.stdout != null ? error.stdout.toString() : '',
      stderr: error.stderr != null ? error.stderr.toString() : '',
    };
  }
}

class TddWalk {
  /** @param {string} dir - absolute project root (an already-created temp project). */
  constructor(dir) {
    this.dir = dir;
    this.planNumber = '01';
    this.phaseDirRel = path.join('.planning', 'phases', '01-x');
    this.planFileName = '01-PLAN.md';
  }

  /** @returns {string} absolute path to the fixture's phase directory. */
  get phaseDir() {
    return path.join(this.dir, this.phaseDirRel);
  }

  /** @returns {string} absolute path to the fixture's plan file. */
  get planPath() {
    return path.join(this.phaseDir, this.planFileName);
  }

  /**
   * Create a fresh temp project and a `TddWalk` bound to it. Does NOT write a
   * plan file — callers that need the fail-closed path (row 5 of the test
   * matrix) rely on the plan being absent until `writePlan()` is called.
   *
   * @param {{prefix?: string}} [opts]
   * @returns {TddWalk}
   */
  static create(opts = {}) {
    const { prefix = 'gsd-tdd-walk-' } = opts;
    const dir = createTempProject(prefix);
    return new TddWalk(dir);
  }

  /**
   * Write (or overwrite) this walk's plan file with `content`, creating
   * parent directories as needed.
   *
   * @param {string} content
   */
  writePlan(content) {
    fs.mkdirSync(this.phaseDir, { recursive: true });
    fs.writeFileSync(this.planPath, content, 'utf8');
  }

  /**
   * Resolve TDD-applicability via the real CLI verb (`gsd_run query
   * phase.tdd-applicable`), reusing Phase 1's proven invocation
   * (`tests/phase-tdd-applicable.test.cjs`).
   *
   * @param {{cliFlag?: boolean}} [opts]
   * @returns {{success: true, applicable: boolean, source: string, plan_type: unknown,
   *   config_tdd_mode: unknown, cli_flag_present: boolean} | {success: false, error: string, exitCode: number|null}}
   */
  resolveViaCli(opts = {}) {
    const { cliFlag = false } = opts;
    const argv = ['query', 'phase.tdd-applicable', this.planPath];
    if (cliFlag) argv.push('--cli-flag');
    const result = runGsdTools(argv, this.dir);
    if (!result.success) {
      return { success: false, error: result.error, exitCode: result.exitCode ?? null };
    }
    return { success: true, ...JSON.parse(result.output) };
  }

  /**
   * Resolve `TDD_APPLICABLE` by extracting and EXECUTING the real shipped
   * bash for `backend`, against this walk's real fixture project. See
   * `executeBackendScript` for the return shape.
   *
   * @param {'harness'|'worktree'} backend
   * @returns {ReturnType<typeof executeBackendScript>}
   */
  resolveViaBackend(backend) {
    const script = buildBackendScript(backend, {
      phaseDir: this.phaseDir,
      planFile: this.planFileName,
      planNumber: this.planNumber,
    });
    return executeBackendScript(script, this.dir);
  }

  /** Remove this walk's temp project. Safe to call multiple times. */
  cleanup() {
    cleanup(this.dir);
  }
}

module.exports = {
  TddWalk,
  extractFencedBashBlock,
  extractFencedBashBlockContaining,
  sliceTddResolution,
  buildBackendScript,
  executeBackendScript,
  parseResultSentinel,
  RESOLUTION_STEP_PATH,
  DISPATCH_STEP_PATH,
  TDD_EMBED_TERNARY,
  REPO_ROOT,
};

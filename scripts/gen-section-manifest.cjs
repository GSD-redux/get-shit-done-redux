#!/usr/bin/env node
'use strict';

/**
 * gen-section-manifest.cjs — generates gsd-core/workflows/section-manifest.json
 * from the `<!-- gsd:section -->` markers in gsd-core/workflows/*.md (ADR-1671
 * epic #1671; Phase 5 / issue #2932 introduced the artifact,
 * `.gsd/phase/chore-2932-init-section-manifest/40-design.md`; Phase 6.1 /
 * issue #2992 generalized it from single-workflow to PER-WORKFLOW,
 * `.gsd/phase/chore-2992-widen-when-vocabulary/40-design.md`).
 *
 * Reuses `parseWorkflowSections` from the compiled `workflow-fragments.cjs`
 * (src/workflow-fragments.cts, Phase 3 / #2930) UNCHANGED — this module never
 * re-implements marker parsing (design "Rejected #6"; a second parser is the
 * `DEFECT.GENERATIVE-FIX` divergence class).
 *
 * The committed artifact is placed INSIDE the `gsd-core/` tree (not `docs/`,
 * unlike `docs/CONTEXT-INDEX.json`/`docs/INVENTORY-MANIFEST.json`) because it
 * must SHIP: `bin/install.js`'s `copyWithPathReplacement` only copies
 * `gsd-core/`, and the init CLI's run-time selection reads this artifact
 * from the INSTALLED tree, not the dev repo. `copyWithPathReplacement`
 * only runs `composeWorkflow`/converters on `*.md` — a `.json` leaf falls
 * through to a plain `fs.copyFileSync`, so the artifact ships byte-identical.
 *
 * Shape (#2992 Phase 6.1): `{ "workflows": { "<workflow-name>": [{id, when,
 * read}, ...], ... } }`, where `<workflow-name>` is a source `.md` file's
 * basename without extension. A workflow with zero explicit sections
 * contributes NO key at all (absence, not `[]` — an init caller for that
 * workflow must degrade to `null`, never be attributed some OTHER workflow's
 * sections). Keys are serialized in sorted (filename) order; each workflow's
 * own sections stay in document order. The pre-6.1 shape was a single flat
 * `{ sections: [...] }` array with no workflow key at all — `isValidManifestShape`
 * REJECTS that shape outright so a stale committed artifact can never be
 * mis-attributed to whichever workflow asks first (design row C4).
 *
 * Per design's "Rejected" list, a workflow's section list carries NEITHER
 * section content (would duplicate every section's bytes, fighting Phase 4's
 * emitted-byte caps) NOR line numbers (re-drifts on any line shift, and
 * per-runtime converters rewrite text so ranges would differ per runtime).
 * It carries only `{id, when, read}` triples — `read` is a POSIX-normalized
 * path, relative to the repo root, of the step file the section body was
 * moved to.
 *
 * Usage:
 *   node scripts/gen-section-manifest.cjs                 # print to stdout
 *   node scripts/gen-section-manifest.cjs --write          # write the manifest
 *   node scripts/gen-section-manifest.cjs --check          # exit 1 if stale/invalid
 *   node scripts/gen-section-manifest.cjs --check --json   # same, + typed report
 *   node scripts/gen-section-manifest.cjs --write --workflows-dir <p> --manifest-path <p>
 *                                                           # override the two hardcoded
 *                                                           # repo-root paths (tests point
 *                                                           # the real CLI at a temp fixture
 *                                                           # tree with no fs monkeypatching)
 *
 * Only `.md` files directly inside `--workflows-dir` are scanned (not files
 * already inside a `<workflow>/steps/` subdirectory — those are MOVED-TO
 * output, never source-with-markers). A workflow with zero explicit sections
 * (most workflows today) contributes no key to `workflows` and is never
 * orphan-checked — orphan-checking is scoped only to a workflow's OWN
 * `steps/` directory, and only for workflows that declare at least one
 * `gsd:section` marker.
 *
 * `--check` fails closed (exit 1, never a stack trace) on:
 *   - the compiled `workflow-fragments.cjs` dependency being unbuilt/unloadable
 *     (FAIL_LIB_NOT_BUILT — `npm run build:lib` has not run)
 *   - the live build itself failing: a marker's derived step file does not
 *     exist on disk (FAIL_MISSING_STEP_FILE), a step file in a managed
 *     workflow's `steps/` dir is referenced by no marker AND no reachable
 *     prose reference (FAIL_ORPHAN_STEP_FILE — see `findOrphanStepFiles`),
 *     or the source itself fails to parse (FAIL_SOURCE_PARSE_ERROR, wraps
 *     `parseWorkflowSections`' typed `WorkflowFragmentsError`)
 *   - the committed manifest: absent (FAIL_MANIFEST_MISSING), empty/unparseable
 *     JSON (FAIL_MANIFEST_UNPARSEABLE), valid JSON but the wrong shape
 *     (FAIL_MANIFEST_MALFORMED_SHAPE — `0`, `"s"`, `[]`, `null`, `true` all
 *     land here), or parseable-and-shaped but not equal to the live build
 *     (FAIL_STALE)
 *
 * `--write --json` reports the same typed envelope on failure: the compiled
 * dependency being unloadable (FAIL_LIB_NOT_BUILT, same as above) or the
 * atomic write itself failing (FAIL_WRITE_ERROR — see `writeManifestAtomically`).
 *
 * Orphan detection (`findOrphanStepFiles`) is plain substring reachability
 * over prose, NOT a second marker parser: starting from the parent workflow's
 * raw text, it does a fixed-point search for the literal token
 * `steps/<basename>` across the parent text and every already-reached step
 * file's own text (so a step file that is itself an on-demand delegation
 * TARGET of another step file — e.g. `regression-gate.md`'s own "Read and
 * execute `.../steps/regression-gate-run.md`" line — is correctly resolved
 * as non-orphan without the generator needing to know that convention).
 *
 * `--write` writes atomically: content lands at a same-directory temp path
 * first, then `fs.renameSync` swaps it into place. If either step throws, the
 * temp path is removed (best-effort) and the target manifest is left exactly
 * as it was — never truncated or partially written.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const MANIFEST_PATH = path.join(WORKFLOWS_DIR, 'section-manifest.json');

// ─── Typed reason enum (CONTRIBUTING.md "Prohibited: Raw Text Matching") ───────

/**
 * Stable reason codes for `checkReport`'s `reason` field. Tests assert via
 * `assert.equal(report.reason, REASON.X)` rather than regex-matching the
 * human-readable prose the non-JSON `--check` mode still writes to
 * stdout/stderr.
 *
 * Adding a new reason requires updating this map AND the test that locks
 * `Object.keys(REASON).sort()` as a coordinated change.
 */
const REASON = Object.freeze({
  OK_UP_TO_DATE: 'ok_up_to_date',
  FAIL_STALE: 'fail_stale',
  FAIL_MANIFEST_MISSING: 'fail_manifest_missing',
  FAIL_MANIFEST_UNPARSEABLE: 'fail_manifest_unparseable',
  FAIL_MANIFEST_MALFORMED_SHAPE: 'fail_manifest_malformed_shape',
  FAIL_MISSING_STEP_FILE: 'fail_missing_step_file',
  FAIL_ORPHAN_STEP_FILE: 'fail_orphan_step_file',
  FAIL_SOURCE_PARSE_ERROR: 'fail_source_parse_error',
  FAIL_LIB_NOT_BUILT: 'fail_lib_not_built',
  FAIL_WRITE_ERROR: 'fail_write_error',
});

// ─── Loaders ──────────────────────────────────────────────────────────────────

const WORKFLOW_FRAGMENTS_LIB_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'workflow-fragments.cjs');

/**
 * Load the compiled workflow-fragments library. The artifact is a gitignored
 * tsc build output of src/workflow-fragments.cts and only exists after
 * `npm run build:lib`. Throws a clean `ManifestBuildError` (REASON.FAIL_LIB_NOT_BUILT;
 * never a bare MODULE_NOT_FOUND stack) naming the remedy when it is missing —
 * `ManifestBuildError` extends `ExitError`, so `runMain` still prints only the
 * friendly message, and `checkReport`/the `--write --json` path can still read
 * `.reason`/`.subject` off it to emit the typed envelope.
 *
 * @returns {{ parseWorkflowSections: Function }}
 */
function loadWorkflowFragmentsLib() {
  try {
    delete require.cache[require.resolve(WORKFLOW_FRAGMENTS_LIB_PATH)];
    return require(WORKFLOW_FRAGMENTS_LIB_PATH);
  } catch (err) {
    const subject = relPosix(ROOT, WORKFLOW_FRAGMENTS_LIB_PATH);
    throw new ManifestBuildError(
      REASON.FAIL_LIB_NOT_BUILT,
      subject,
      `Cannot load ${subject}: ${err && err.message}\n` +
      'Run:\n  npm run build:lib\n',
    );
  }
}

// ─── POSIX path helpers ─────────────────────────────────────────────────────

/** Unconditional backslash->forward-slash normalization (CONTEXT.md
 *  path-separator-normalization rule: never gate on `path.sep`). */
function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Repo-root-relative POSIX path for a file under `repoRoot`.
 *
 * @param {string} repoRoot
 * @param {string} absPath
 */
function relPosix(repoRoot, absPath) {
  return toPosix(path.relative(repoRoot, absPath));
}

// ─── Orphan detection (plain substring reachability, not a marker parser) ────

/**
 * Fixed-point reachability scan over a managed workflow's `steps/` directory:
 * a step file is "reached" once the literal token `steps/<its-basename>`
 * appears in the parent workflow's raw text OR in the text of any
 * already-reached step file (so nested delegation — a step file that itself
 * names another step file — resolves without the generator knowing that
 * convention explicitly). Returns the SORTED list of `.md` basenames in
 * `stepsDir` that are never reached (i.e. orphans). Returns `[]` if
 * `stepsDir` does not exist.
 *
 * @param {string} parentText - the workflow.md's raw source text
 * @param {string} stepsDir - absolute path to `<workflow>/steps/`
 * @returns {string[]}
 */
function findOrphanStepFiles(parentText, stepsDir) {
  if (!fs.existsSync(stepsDir)) return [];
  const files = fs
    .readdirSync(stepsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => d.name)
    .sort();

  const textOf = new Map(files.map((f) => [f, fs.readFileSync(path.join(stepsDir, f), 'utf8')]));
  const reached = new Set();
  const haystacks = [parentText];

  let changed = true;
  while (changed) {
    changed = false;
    for (const f of files) {
      if (reached.has(f)) continue;
      const token = `steps/${f}`;
      if (haystacks.some((h) => h.includes(token))) {
        reached.add(f);
        haystacks.push(textOf.get(f));
        changed = true;
      }
    }
  }

  return files.filter((f) => !reached.has(f));
}

// ─── Live manifest build ─────────────────────────────────────────────────────

/** Thrown by `buildFreshManifest`/`loadWorkflowFragmentsLib`/`writeManifestAtomically`
 *  for every fail-closed condition below; carries a stable `reason` + the
 *  offending `subject` path so `checkReport`/the `--write --json` path never
 *  need to string-match a message. Extends `ExitError` (not plain `Error`) so
 *  `runMain` still prints only the friendly `message` — never a bare stack
 *  trace — for the `default`/`--write` (non-`--json`) code paths that let it
 *  propagate uncaught, exactly like every other `ExitError`. */
class ManifestBuildError extends ExitError {
  constructor(reason, subject, message) {
    super(1, message);
    this.name = 'ManifestBuildError';
    this.reason = reason;
    this.subject = subject;
  }
}

/**
 * Scan `workflowsDir` for `.md` files carrying `gsd:section` markers and
 * build the live (freshly-derived) manifest: `{ workflows: { <name>:
 * [{id, when, read}], ... } }` (#2992 Phase 6.1). Workflow keys are
 * serialized in sorted (filename) order; a workflow's own sections stay in
 * document order. A workflow with zero explicit sections contributes NO key
 * at all — absence, not `[]` (design row C4/C11: absence must degrade to
 * `null` at the init seam, never be confused with "computed, no sections").
 * Throws `ManifestBuildError` on any fail-closed condition (missing step
 * file, orphan step file, unparseable source).
 *
 * @param {string} workflowsDir - defaults to the real repo-root gsd-core/workflows/
 * @param {string} repoRoot - root `read` paths are computed relative to
 * @returns {{ workflows: Record<string, Array<{id: string, when: string, read: string}>> }}
 */
function buildFreshManifest(workflowsDir = WORKFLOWS_DIR, repoRoot = ROOT) {
  const { parseWorkflowSections } = loadWorkflowFragmentsLib();

  const workflowFiles = fs
    .readdirSync(workflowsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => d.name)
    .sort();

  const workflows = {};

  for (const fileName of workflowFiles) {
    const filePath = path.join(workflowsDir, fileName);
    const relSourcePath = relPosix(repoRoot, filePath);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new ManifestBuildError(REASON.FAIL_SOURCE_PARSE_ERROR, relSourcePath, `Cannot read ${relSourcePath}: ${err && err.message}`);
    }

    let parsed;
    try {
      parsed = parseWorkflowSections(content, relSourcePath);
    } catch (err) {
      throw new ManifestBuildError(REASON.FAIL_SOURCE_PARSE_ERROR, relSourcePath, `${relSourcePath}: ${err && err.message}`);
    }

    const explicitSections = parsed.filter((s) => s.explicit);
    if (explicitSections.length === 0) continue;

    const workflowName = fileName.replace(/\.md$/, '');
    const stepsDir = path.join(workflowsDir, workflowName, 'steps');
    const sections = [];

    for (const section of explicitSections) {
      const stepFileAbs = path.join(stepsDir, `${section.id}.md`);
      if (!fs.existsSync(stepFileAbs)) {
        const relStepPath = relPosix(repoRoot, stepFileAbs);
        throw new ManifestBuildError(
          REASON.FAIL_MISSING_STEP_FILE,
          relStepPath,
          `${relSourcePath}: section "${section.id}" (when="${section.when}") names step file ${relStepPath}, which does not exist`,
        );
      }
      sections.push({
        id: section.id,
        when: section.when,
        read: relPosix(repoRoot, stepFileAbs),
      });
    }

    const orphans = findOrphanStepFiles(content, stepsDir);
    if (orphans.length > 0) {
      const relOrphanPath = relPosix(repoRoot, path.join(stepsDir, orphans[0]));
      throw new ManifestBuildError(
        REASON.FAIL_ORPHAN_STEP_FILE,
        relOrphanPath,
        `${relOrphanPath} is not referenced by any gsd:section marker or reachable "steps/" reference in ${relSourcePath}`,
      );
    }

    workflows[workflowName] = sections;
  }

  return { workflows };
}

// ─── Serialization ────────────────────────────────────────────────────────────

/**
 * @param {{ workflows: Record<string, Array<{id: string, when: string, read: string}>> }} manifest
 * @returns {string}
 */
function serializeManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * Workflow-count / section-count pair for a manifest's `workflows` map, used
 * by the `--write` stdout summary and the `--check` OK message.
 *
 * @param {{ workflows: Record<string, Array<{id: string, when: string, read: string}>> }} manifest
 * @returns {{ workflowCount: number, sectionCount: number }}
 */
function countManifest(manifest) {
  const workflowNames = Object.keys(manifest.workflows);
  const sectionCount = workflowNames.reduce((sum, name) => sum + manifest.workflows[name].length, 0);
  return { workflowCount: workflowNames.length, sectionCount };
}

/**
 * True when `parsed` has the expected committed-manifest shape (#2992 Phase
 * 6.1): a plain object (not an array, not null) carrying a `workflows` plain
 * object (not an array, not null) whose every own value is an array of
 * `{id, when, read}` string triples. Rejects `0`, `"s"`, `[]`, `null`, `true`
 * — AND rejects the pre-6.1 flat `{sections:[...]}` shape (no `workflows`
 * key ⇒ `parsed.workflows` is `undefined`, which fails the object check),
 * so a stale committed artifact can never be silently mis-attributed to
 * whichever workflow asks first (design row C4).
 *
 * @param {unknown} parsed
 * @returns {boolean}
 */
function isValidManifestShape(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const workflows = parsed.workflows;
  if (workflows === null || typeof workflows !== 'object' || Array.isArray(workflows)) return false;
  return Object.values(workflows).every(
    (sections) =>
      Array.isArray(sections) &&
      sections.every(
        (s) => s !== null && typeof s === 'object' && typeof s.id === 'string' && typeof s.when === 'string' && typeof s.read === 'string',
      ),
  );
}

// ─── Atomic write ─────────────────────────────────────────────────────────────

/**
 * Write `content` to `targetPath` atomically: write to a same-directory temp
 * path, then `fs.renameSync` it into place (same filesystem, so the rename is
 * atomic). On ANY failure (the write or the rename), the temp path is removed
 * best-effort and a `ManifestBuildError` (REASON.FAIL_WRITE_ERROR, subject
 * `targetPath`) is thrown — `targetPath` is left exactly as it was before the
 * call, never truncated or partially written. `ManifestBuildError` extends
 * `ExitError`, so a caller that lets it propagate uncaught (e.g. `--write`
 * without `--json`) still gets only the friendly message, never a stack trace.
 *
 * @param {string} targetPath
 * @param {string} content
 */
function writeManifestAtomically(targetPath, content) {
  const tmpPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_cleanupErr) {
      // best-effort: tmpPath may never have been created (writeFileSync itself threw)
    }
    throw new ManifestBuildError(REASON.FAIL_WRITE_ERROR, targetPath, `Cannot write ${targetPath}: ${err && err.message}`);
  }
}

// ─── Typed check report ───────────────────────────────────────────────────────

/**
 * Empty-report shape shared by every early-exit branch below.
 *
 * @returns {{ subject: string | null }}
 */
function emptyReportFields() {
  return { subject: null };
}

/**
 * Compute the full `--check` result as a typed, non-throwing report.
 *
 * @param {string} [workflowsDir]
 * @param {string} [manifestPath]
 * @param {string} [repoRoot]
 * @returns {{ ok: boolean, reason: string, subject: string | null, message: string }}
 */
function checkReport(workflowsDir = WORKFLOWS_DIR, manifestPath = MANIFEST_PATH, repoRoot = ROOT) {
  let live;
  try {
    live = buildFreshManifest(workflowsDir, repoRoot);
  } catch (err) {
    if (err instanceof ManifestBuildError) {
      return { ok: false, reason: err.reason, subject: err.subject, message: `${err.message}\n` };
    }
    throw err;
  }

  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      reason: REASON.FAIL_MANIFEST_MISSING,
      ...emptyReportFields(),
      subject: manifestPath,
      message: `${manifestPath} does not exist. Run:\n  node scripts/gen-section-manifest.cjs --write\n`,
    };
  }

  let committedText;
  try {
    committedText = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      reason: REASON.FAIL_MANIFEST_UNPARSEABLE,
      subject: manifestPath,
      message: `Cannot read ${manifestPath}: ${err && err.message}\n`,
    };
  }

  let committed;
  try {
    committed = JSON.parse(committedText);
  } catch (err) {
    return {
      ok: false,
      reason: REASON.FAIL_MANIFEST_UNPARSEABLE,
      subject: manifestPath,
      message: `${manifestPath} is not valid JSON: ${err && err.message}\n` +
        'Run:\n  node scripts/gen-section-manifest.cjs --write\n',
    };
  }

  if (!isValidManifestShape(committed)) {
    return {
      ok: false,
      reason: REASON.FAIL_MANIFEST_MALFORMED_SHAPE,
      subject: manifestPath,
      message: `${manifestPath} is valid JSON but does not have the expected {workflows:{<name>:[{id,when,read}]}} shape.\n` +
        'Run:\n  node scripts/gen-section-manifest.cjs --write\n',
    };
  }

  if (JSON.stringify(committed) !== JSON.stringify(live)) {
    return {
      ok: false,
      reason: REASON.FAIL_STALE,
      subject: manifestPath,
      message: `${manifestPath} is stale. Run:\n  node scripts/gen-section-manifest.cjs --write\n`,
    };
  }

  const { workflowCount, sectionCount } = countManifest(live);
  return {
    ok: true,
    reason: REASON.OK_UP_TO_DATE,
    subject: null,
    message: `${manifestPath} is up to date (${workflowCount} workflow${workflowCount === 1 ? '' : 's'}, ${sectionCount} section${sectionCount === 1 ? '' : 's'}).\n`,
  };
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

/**
 * @param {string|undefined} value
 * @returns {boolean}
 */
function isMissingPathValue(value) {
  return value === undefined || value === '' || value.startsWith('-');
}

/**
 * @param {string[]} argv
 * @returns {{ mode: 'check'|'write'|'default'|'unknown', json: boolean, workflowsDir: string, manifestPath: string, repoRoot: string, unknownArg?: string, usageMessage?: string }}
 */
function parseArgs(argv) {
  const opts = { mode: 'default', json: false, workflowsDir: WORKFLOWS_DIR, manifestPath: MANIFEST_PATH, repoRoot: ROOT };
  let sawCheck = false;
  let sawWrite = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      sawCheck = true;
      opts.mode = 'check';
    } else if (arg === '--write') {
      sawWrite = true;
      opts.mode = 'write';
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--workflows-dir' || arg === '--manifest-path' || arg === '--repo-root') {
      const value = argv[i + 1];
      if (isMissingPathValue(value)) {
        return {
          ...opts,
          mode: 'unknown',
          unknownArg: arg,
          usageMessage: `${arg} requires a non-empty path argument (got ${value === undefined ? 'nothing' : JSON.stringify(value)})`,
        };
      }
      i++;
      if (arg === '--workflows-dir') opts.workflowsDir = path.resolve(value);
      else if (arg === '--manifest-path') opts.manifestPath = path.resolve(value);
      else opts.repoRoot = path.resolve(value);
    } else {
      opts.mode = 'unknown';
      opts.unknownArg = arg;
    }
  }

  if (sawCheck && sawWrite) {
    return { ...opts, mode: 'unknown', usageMessage: '--check and --write are mutually exclusive' };
  }

  return opts;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'unknown') {
    process.stderr.write('Usage: gen-section-manifest.cjs [--write|--check] [--json] [--workflows-dir <path>] [--manifest-path <path>] [--repo-root <path>]\n');
    if (opts.usageMessage) process.stderr.write(`${opts.usageMessage}\n`);
    throw new ExitError(1);
  }

  if (opts.mode === 'default') {
    process.stdout.write(serializeManifest(buildFreshManifest(opts.workflowsDir, opts.repoRoot)));
    return;
  }

  if (opts.mode === 'check') {
    const report = checkReport(opts.workflowsDir, opts.manifestPath, opts.repoRoot);

    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: report.ok, reason: report.reason, subject: report.subject }) + '\n');
    } else if (report.ok) {
      process.stdout.write(report.message);
    }

    if (!report.ok) {
      throw new ExitError(1, opts.json ? undefined : report.message);
    }
    return;
  }

  // opts.mode === 'write'. Same typed-envelope pattern as --check --json above:
  // a ManifestBuildError (FAIL_LIB_NOT_BUILT from buildFreshManifest,
  // FAIL_WRITE_ERROR from writeManifestAtomically) is caught here so --json
  // still emits {ok, reason, subject} instead of letting the error propagate
  // to runMain unobserved by the JSON caller.
  let manifest;
  let writeErr;
  try {
    manifest = buildFreshManifest(opts.workflowsDir, opts.repoRoot);
    writeManifestAtomically(opts.manifestPath, serializeManifest(manifest));
  } catch (err) {
    if (!(err instanceof ManifestBuildError)) throw err;
    writeErr = err;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(
      writeErr
        ? { ok: false, reason: writeErr.reason, subject: writeErr.subject }
        : { ok: true, reason: REASON.OK_UP_TO_DATE, subject: null },
    ) + '\n');
  } else if (!writeErr) {
    const { workflowCount, sectionCount } = countManifest(manifest);
    process.stdout.write(`Wrote ${opts.manifestPath}\n  ${workflowCount} workflow${workflowCount === 1 ? '' : 's'}, ${sectionCount} section${sectionCount === 1 ? '' : 's'}\n`);
  }

  if (writeErr) {
    throw new ExitError(1, opts.json ? undefined : writeErr.message);
  }
}

// ─── Exports (for tests) ──────────────────────────────────────────────────────

module.exports = {
  loadWorkflowFragmentsLib,
  findOrphanStepFiles,
  buildFreshManifest,
  serializeManifest,
  countManifest,
  isValidManifestShape,
  writeManifestAtomically,
  checkReport,
  parseArgs,
  ManifestBuildError,
  REASON,
  WORKFLOW_FRAGMENTS_LIB_PATH,
  WORKFLOWS_DIR,
  MANIFEST_PATH,
  ROOT,
};

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  runMain(main);
}

'use strict';

/**
 * loop-walk.cjs — a small stateful harness around `tests/helpers.cjs` for the
 * loop QA walk. This module owns NONE of the subprocess mechanics itself
 * (spawn, retry-on-kill, quote-splitting) — those live in `runGsdTools` /
 * `createTempGitProject` and are reused verbatim. What this module adds is
 * the walk-specific concerns: turning a raw helper result into the typed
 * `RunResult` from `./result.cjs`, guaranteeing the child never inherits an
 * ambient `GSD_*` variable that would silently redirect the engine, pinning
 * the clock so output is reproducible run-to-run, and giving callers a
 * content-free way to observe what the SUT wrote to disk.
 */

const fs = require('fs');
const path = require('path');
const { runGsdTools, cleanup } = require('../helpers.cjs');
const { classify } = require('./result.cjs');
const { createFixture } = require('../fixtures/index.cjs');
const { LOOP_HOST_CONTRACT } = require('../../gsd-core/bin/lib/loop-host-contract.cjs');
const { resolveWithin } = require('./paths.cjs');

/**
 * WHY re-derive rather than re-list: `loop-host-contract.cjs` is itself
 * generated (see its own header) from workflow markers by
 * `scripts/gen-loop-host-contract.cjs`. If this file hardcoded
 * `['discuss', 'plan', 'execute', 'verify', 'ship']`, a future regeneration
 * that renames, adds, or removes a step would leave the QA walk silently
 * testing a stale step list — a second source of truth that can drift out
 * from under the generated one with no signal anywhere. Deriving `LOOP_STEPS`
 * from the same contract object the generator produced means drift is
 * structurally impossible: this array always has exactly the steps the
 * contract currently declares.
 *
 * @type {string[]}
 */
const LOOP_STEPS = LOOP_HOST_CONTRACT.map((entry) => entry.step);

/** Default pinned clock value (2026-01-01T00:00:00.000Z) — see `create({nowMs})`. */
const DEFAULT_NOW_MS = 1767225600000;

/**
 * Starting-world builders keyed by `fixture` name, each a thin wrapper over
 * `createFixture` (`tests/fixtures/index.cjs`).
 *
 * WHY this exists at all: `createFixture`'s `projectDoc` option defaults to
 * `projectDoc = git` (`tests/fixtures/index.cjs:21`) — so any caller that
 * only passes `git: true` silently also gets `.planning/PROJECT.md` seeded.
 * A "greenfield" walk built that way would report `project_exists: true`
 * from its very first step, which makes the greenfield trajectory
 * meaningless: it can never exercise the create path (`/gsd-new-project`)
 * because a project already exists before the walk begins. Every entry
 * below therefore states `projectDoc` explicitly rather than relying on
 * that default, and `greenfield` is the harness default precisely because
 * an empty git repo with no `.planning/` at all is what a real user's
 * working tree looks like before running `/gsd-new-project` for the first
 * time.
 *
 * @type {Record<string, (prefix: string) => string>}
 */
const FIXTURE_BUILDERS = {
  // A git repo with NO `.planning/` at all — what a user has before
  // `/gsd-new-project`.
  greenfield: (prefix) => createFixture({ prefix, git: true, planning: false, projectDoc: false }),
  // `.planning/phases/` exists, but no PROJECT.md yet.
  planning: (prefix) => createFixture({ prefix, git: true, planning: true, projectDoc: false }),
  // The old `createTempGitProject` behavior: a fully seeded project.
  seeded: (prefix) => createFixture({ prefix, git: true, planning: true, projectDoc: true }),
};

/**
 * Recursively collect `{size, mtimeMs}` stat facts for every regular file
 * under `root`, excluding `.git/`.
 *
 * WHY stat-only, never read: `RULESET.TESTS.no-source-grep.tmp-file-traps`
 * (see `result.cjs` header) forbids reading the content of files the SUT
 * (system under test) wrote and then string-matching against it — that
 * pattern is exactly the raw-text-matching anti-pattern the project's test
 * conventions ban, just relocated from stdout to disk. `fs.statSync` proves
 * a file exists, changed size, or changed mtime without ever opening its
 * content, so a walk can assert "did this step write/touch a file" without
 * ever being tempted into `readFileSync(...).includes(...)`.
 *
 * @param {string} root - absolute directory to walk.
 * @returns {Map<string, {size: number, mtimeMs: number}>} keyed by
 *   POSIX-normalized path relative to `root`.
 */
function collectStatSnapshot(root) {
  /** @type {Map<string, {size: number, mtimeMs: number}>} */
  const out = new Map();

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(abs);
      // WHY unconditional replace, not platform-conditional: `path.sep` is
      // '/' on POSIX so a conditional swap looks like a no-op there, but a
      // path segment can still literally contain a backslash character
      // (e.g. an artifact file the SUT names with one) on Linux — so the
      // normalization must run every time, not only when path.sep === '\\'.
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      out.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

  walk(root);
  return out;
}

class LoopWalk {
  /**
   * @param {string} dir - absolute project root (an already-created temp git project).
   * @param {number} nowMs - pinned epoch ms passed to every `run()` as `GSD_NOW_MS`.
   */
  constructor(dir, nowMs) {
    this.dir = dir;
    this.nowMs = nowMs;
  }

  /**
   * Alias for `this.dir` under the name `oracles.cjs`'s `ctx.projectDir`
   * expects (see `value-hygiene`'s absolute-path-leak smell check). Kept as
   * a getter rather than a second stored field so the two can never drift.
   *
   * @returns {string}
   */
  get projectDir() {
    return this.dir;
  }

  /**
   * Create a fresh temp git project and a `LoopWalk` bound to it.
   *
   * WHY `fixture` defaults to `'greenfield'`, not the old seeded behavior:
   * see `FIXTURE_BUILDERS` above — a walk that starts with
   * `.planning/PROJECT.md` already present can never exercise the
   * project-creation path, which is the whole point of a "greenfield" walk.
   * An unrecognized `fixture` name throws rather than silently falling back
   * to a default, because a typo'd fixture name silently testing the wrong
   * starting world is exactly the failure this harness exists to catch.
   *
   * @param {{prefix?: string, nowMs?: number, fixture?: 'greenfield'|'planning'|'seeded'}} [opts]
   * @returns {LoopWalk}
   */
  static create(opts = {}) {
    const { prefix = 'gsd-loop-walk-', nowMs = DEFAULT_NOW_MS, fixture = 'greenfield' } = opts;
    const build = FIXTURE_BUILDERS[fixture];
    if (!build) {
      throw new Error(
        `LoopWalk.create: unknown fixture "${fixture}" (expected one of: ${Object.keys(FIXTURE_BUILDERS).join(', ')})`
      );
    }
    const dir = build(prefix);
    return new LoopWalk(dir, nowMs);
  }

  /**
   * Run a `gsd-tools` invocation inside this walk's project and return the
   * typed `RunResult` from `classify()`.
   *
   * SIGNATURE: `run(...argvTokens)` where the LAST argument, if it is a
   * plain object (not a string), is stripped off and treated as an options
   * bag rather than an argv token — so `walk.run('progress')` and
   * `walk.run('progress', { jsonErrors: false })` both read naturally
   * against every existing call site in this repo (`walk.run(...argv)` in
   * `scenario.cjs`, `walk.run('progress')` in the self-tests) without
   * requiring callers to restructure a spread argv array around a leading
   * options object.
   *
   * WHY `jsonErrors` defaults to `true`: `--json-errors` (`docs/json-errors.md`)
   * is a real CLI flag, but it is the TOOLING/TEST surface — a human or a real
   * workflow invokes `gsd_run <cmd>` directly, WITHOUT it. Defaulting to
   * `true` keeps every pre-existing call site's behavior byte-for-byte
   * unchanged (they all exercised `--json-errors` before this option
   * existed), while `{ jsonErrors: false }` lets a scenario step opt into
   * driving the human path instead — otherwise the harness would only ever
   * prove the tooling surface works and could never catch a regression a
   * real user would actually hit.
   *
   * WHY the env is built the way it is (ambient `GSD_*` sanitization):
   * `runGsdTools` composes the child env as
   * `{ ...process.env, ...TEST_ENV_BASE, ...env }` — so whatever `GSD_*`
   * variables happen to be set in the *parent* shell (e.g. a developer or CI
   * runner with `GSD_WORKSTREAM` / `GSD_PROJECT` exported for an unrelated
   * reason) flow straight through into the child and can silently redirect
   * the engine at a different workstream or project root than the one this
   * walk created — an invisible, non-deterministic test-pollution vector.
   * `runGsdTools`'s own merge order means the last object spread wins, so
   * this method builds an `env` override that sets EVERY ambient `GSD_*` key
   * (scanned live from `process.env`, not a hardcoded list — a new leaking
   * var needs no code change here to be caught) to `undefined`, then layers
   * the two intentionally-pinned vars on top.
   *
   * The `undefined` trick is deliberate, not a placeholder: Node's child
   * process env normalization (`lib/child_process.js` `normalizeSpawnArgs`,
   * exercised here via `execFileSync`) iterates `Object.keys(env)` and
   * OMITS any key whose value is `undefined` from the actual `KEY=VALUE`
   * pairs handed to the OS — it does not stringify it to the literal text
   * `"undefined"`. That means `{ GSD_WORKSTREAM: undefined }` in the `env`
   * option makes the child process behave exactly as if `GSD_WORKSTREAM`
   * were never exported at all, even though `process.env.GSD_WORKSTREAM` is
   * still set and non-empty in the parent. This was verified empirically
   * (not assumed) — see the module verification transcript — because
   * `delete`-based approaches were not available here (the merge is inside
   * `runGsdTools`, not under this method's control) and a stringified
   * `"undefined"` would have been a silent correctness bug indistinguishable
   * from a passing run until an actual leak test caught it.
   *
   * ⚠️ KNOWN LIMIT — SUCCESS-PATH STDERR IS NOT OBSERVABLE THROUGH THIS
   * SUBSTRATE, SO `result.warnings` IS ERROR-PATH-ONLY TODAY: this method
   * builds `raw.stderr` as `result.success ? '' : (result.error ?? '')`
   * (below), and `runGsdTools` (`tests/helpers.cjs`) invokes the child via
   * `execFileSync`, which discards the child's stderr stream entirely on a
   * clean (non-throwing) exit — Node never captures it, so there is no text
   * to forward even if this method wanted to. The practical effect: for any
   * exit-0 invocation, `classify()` always receives `stderr: ''`, so
   * `result.warnings` can never be non-empty on the success path, no matter
   * what the real `gsd-tools` process actually wrote to stderr. `warnings`
   * only ever populates on the exit-1 (error) path, where `result.error`
   * (helpers.cjs's captured stderr-on-failure text) is threaded through.
   * Capturing success-path stderr would require changing `runGsdTools` /
   * `tests/helpers.cjs` (e.g. to `spawnSync`) — out of scope here because
   * that helper is shared by ~131 test files. DO NOT build an oracle that
   * assumes `.warnings` reflects success-path stderr; it structurally cannot
   * today, and a check written against that assumption is silently vacuous.
   *
   * @param {...(string|{jsonErrors?: boolean})} args - argv tokens, optionally
   *   followed by a trailing `{jsonErrors?: boolean}` options object.
   * @returns {ReturnType<typeof classify>}
   */
  run(...args) {
    const trailing = args[args.length - 1];
    const hasOptions = trailing !== null && typeof trailing === 'object' && !Array.isArray(trailing);
    const options = hasOptions ? trailing : {};
    const argvTokens = hasOptions ? args.slice(0, -1) : args;
    const { jsonErrors = true } = options;
    const argv = jsonErrors ? ['--json-errors', ...argvTokens] : argvTokens;

    /** @type {Record<string, string|undefined>} */
    const sanitize = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GSD_')) sanitize[key] = undefined;
    }
    const env = {
      ...sanitize,
      GSD_TEST_MODE: '1',
      GSD_NOW_MS: String(this.nowMs),
    };

    let raw;
    try {
      const result = runGsdTools(argv, this.dir, env);
      raw = {
        exitCode: result.exitCode,
        stdout: result.output,
        stderr: result.success ? '' : (result.error ?? ''),
        timedOut: false,
        argv,
      };
    } catch {
      // `runGsdTools` throws only after a retried, persistent subprocess
      // kill (host OOM / scheduler contention — see helpers.cjs
      // `throwResourceStarvation`). That is a statement about the HOST, not
      // the engine under test, so a walk must degrade to a TIMEOUT result
      // rather than propagate and abort the whole walk over a transient
      // resource condition it cannot control.
      raw = { exitCode: null, stdout: '', stderr: '', timedOut: true, argv };
    }
    return classify(raw);
  }

  /**
   * Write a planning artifact into this walk's project, standing in for what
   * a real agent (researcher/planner/executor/...) would produce mid-loop.
   * Creates parent directories as needed.
   *
   * `relPath` is resolved via `resolveWithin` before any I/O — a scenario- or
   * caller-supplied path that escapes `this.dir` (e.g. `"../../escaped.md"`)
   * throws rather than reaching `fs.writeFileSync` outside the temp project.
   *
   * @param {string} relPath - path relative to `this.dir`.
   * @param {string} content
   */
  writeArtifact(relPath, content) {
    const abs = resolveWithin(this.dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }

  /**
   * Content-free snapshot of every file under this walk's project (excluding
   * `.git/`). See `collectStatSnapshot` for why this never reads file bytes.
   *
   * @returns {Map<string, {size: number, mtimeMs: number}>}
   */
  statSnapshot() {
    return collectStatSnapshot(this.dir);
  }

  /**
   * Remove this walk's temp project. Safe to call multiple times.
   *
   * `opts.keep` (default `false`) skips the removal entirely — the caller
   * (a QA-report run, typically via `--keep` / `GSD_QA_KEEP=1`) wants the
   * failing/inspected tree left on disk for a human to `cd` into. When kept,
   * this returns `this.dir` so the caller can record it (e.g. as
   * `preservedDir` on a scenario report); when actually cleaned up, it
   * returns `undefined`.
   *
   * @param {{keep?: boolean}} [opts]
   * @returns {string|undefined}
   */
  cleanup(opts = {}) {
    const { keep = false } = opts;
    if (keep) return this.dir;
    cleanup(this.dir);
    return undefined;
  }
}

LoopWalk.LOOP_STEPS = LOOP_STEPS;

module.exports = { LoopWalk, LOOP_STEPS };

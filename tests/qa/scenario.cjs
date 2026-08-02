'use strict';

/**
 * scenario.cjs — the QA-walk scenario DSL interpreter.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * A scenario is a small JSON document describing a sequence of loop-host
 * points, artifacts an "agent" would write at each point, and `gsd-tools`
 * invocations to run there. `loadScenario` validates the JSON shape so a
 * malformed scenario fails fast and loud (never a silent no-op walk);
 * `runScenario` drives a `LoopWalk` through the steps, evaluating both
 * declared `expect` assertions and the shared `oracles.cjs` checks at every
 * step, and NEVER throws on a step failure — a single bad step is recorded
 * and the walk continues, so one broken step can never hide the rest of the
 * walk's results.
 */

const fs = require('node:fs');
const path = require('node:path');
const { resolveRef } = require('./fixtures/index.cjs');
const { LOOP_HOST_CONTRACT } = require('../../gsd-core/bin/lib/loop-host-contract.cjs');
const { MUTATIONS, apply, NOOP } = require('./mutations.cjs');
const { resolveWithin, isAbsoluteLike, hasTraversalSegment } = require('./paths.cjs');

/**
 * True when `relPath` is absolute or contains a `..` path segment. Delegates to
 * `paths.cjs`'s `isAbsoluteLike` / `hasTraversalSegment` — the single source of truth for
 * both predicates — rather than keeping a second copy here. Used at `validateScenario` LOAD
 * time, ahead of `resolveWithin`'s own (equally strict) runtime check: failing a malformed
 * scenario fast and loud at load time is better than failing at apply time — the scenario is
 * malformed, not the run.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function isTraversalOrAbsolute(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return true;
  return isAbsoluteLike(relPath) || hasTraversalSegment(relPath);
}

/** Scenario `fixture` must be one of these — see `loop-walk.cjs` `FIXTURE_BUILDERS`. */
const VALID_FIXTURES = new Set(['greenfield', 'planning', 'seeded']);

/** Every known mutation id, derived from `mutations.cjs` (never hardcoded — see that module's `MUTATIONS`). */
const VALID_MUTATION_IDS = new Set(MUTATIONS.map((m) => m.id));

/** `id -> {id, kind, describe}` lookup, derived once from `MUTATIONS`. */
const MUTATION_BY_ID = new Map(MUTATIONS.map((m) => [m.id, m]));

/**
 * The legal set of `step.at` values, derived from the generated loop-host
 * contract rather than hardcoded — see `loop-walk.cjs`'s `LOOP_STEPS` header
 * comment for why a hardcoded copy would silently drift from the generator.
 *
 * @returns {Set<string>}
 */
function getLegalPoints() {
  const points = new Set();
  for (const entry of LOOP_HOST_CONTRACT) {
    for (const point of entry.points) points.add(point);
  }
  return points;
}

/**
 * Structural (deep) equality for JSON-ish values. Cycle-tolerant via a
 * `WeakMap` pairing "already compared" object references.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @param {WeakMap<object, unknown>} [seen]
 * @returns {boolean}
 */
function deepEqual(a, b, seen = new WeakMap()) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key], seen)) return false;
  }
  return true;
}

/**
 * Look up a dot-path (e.g. `"a.b.c"` or `"a.b[0].c"`) inside a JSON-ish value.
 *
 * @param {unknown} value
 * @param {string} dotPath
 * @returns {{ found: boolean, value: unknown }}
 */
function dotGet(value, dotPath) {
  const segments = dotPath
    .split('.')
    .flatMap((seg) => {
      const parts = [];
      const re = /^([^[\]]*)((?:\[\d+\])*)$/;
      const m = re.exec(seg);
      if (!m) return [seg];
      if (m[1] !== '') parts.push(m[1]);
      const indices = m[2].match(/\[\d+\]/g) || [];
      for (const idx of indices) parts.push(Number(idx.slice(1, -1)));
      return parts;
    });

  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (typeof current !== 'object') return { found: false, value: undefined };
    const key = segment;
    if (Array.isArray(current)) {
      if (typeof key !== 'number' || key < 0 || key >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[key];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, key)) return { found: false, value: undefined };
    current = current[key];
  }
  return { found: true, value: current };
}

/**
 * Validate a parsed scenario object, throwing on the first violation with a
 * message naming the offending field/step.
 *
 * @param {unknown} scenario
 * @param {string} [sourceLabel] e.g. an absolute file path, for error context.
 * @returns {object} `scenario`, unmodified, once fully validated.
 */
function validateScenario(scenario, sourceLabel) {
  const label = sourceLabel ? ` (from ${sourceLabel})` : '';

  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    throw new Error(`loadScenario: scenario${label} must be a JSON object, got ${JSON.stringify(scenario)}`);
  }
  if (typeof scenario.name !== 'string' || scenario.name.trim() === '') {
    throw new Error(`loadScenario: "name"${label} must be a non-empty string, got ${JSON.stringify(scenario.name)}`);
  }
  if (!VALID_FIXTURES.has(scenario.fixture)) {
    throw new Error(
      `loadScenario: "fixture"${label} must be one of ${[...VALID_FIXTURES].join(', ')}, got ${JSON.stringify(scenario.fixture)}`,
    );
  }
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    throw new Error(`loadScenario: "steps"${label} must be a non-empty array — an empty scenario is an error, not a silent pass`);
  }
  if (scenario.selfTest !== undefined && typeof scenario.selfTest !== 'boolean') {
    throw new Error(`loadScenario: "selfTest"${label} must be a boolean, got ${JSON.stringify(scenario.selfTest)}`);
  }

  const legalPoints = getLegalPoints();
  scenario.steps.forEach((step, index) => {
    const where = `steps[${index}]${label}`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`loadScenario: ${where} must be an object, got ${JSON.stringify(step)}`);
    }
    if (typeof step.at !== 'string' || !legalPoints.has(step.at)) {
      throw new Error(
        `loadScenario: ${where}.at is ${JSON.stringify(step.at)}, which is not a legal loop-host-contract point `
          + `(legal points: ${[...legalPoints].sort().join(', ')})`,
      );
    }
    if (step.run !== undefined) {
      if (!Array.isArray(step.run)) {
        throw new Error(`loadScenario: ${where}.run must be an array of argv arrays, got ${JSON.stringify(step.run)}`);
      }
      step.run.forEach((argv, ri) => {
        if (!Array.isArray(argv) || argv.length === 0 || !argv.every((t) => typeof t === 'string')) {
          throw new Error(`loadScenario: ${where}.run[${ri}] must be a non-empty array of strings, got ${JSON.stringify(argv)}`);
        }
      });
    }
    if (step.expect !== undefined) {
      if (!Array.isArray(step.expect)) {
        throw new Error(`loadScenario: ${where}.expect must be an array, got ${JSON.stringify(step.expect)}`);
      }
      step.expect.forEach((exp, ei) => {
        const isValid = exp && typeof exp === 'object' && !Array.isArray(exp)
          && typeof exp.path === 'string' && exp.path !== ''
          && Object.prototype.hasOwnProperty.call(exp, 'is');
        if (!isValid) {
          throw new Error(
            `loadScenario: ${where}.expect[${ei}] must be {path: <non-empty dot-path string>, is: <value>}, got ${JSON.stringify(exp)}`,
          );
        }
      });
    }
    if (step.jsonErrors !== undefined && typeof step.jsonErrors !== 'boolean') {
      throw new Error(`loadScenario: ${where}.jsonErrors must be a boolean, got ${JSON.stringify(step.jsonErrors)}`);
    }
    if (step.mutate !== undefined) {
      if (!step.mutate || typeof step.mutate !== 'object' || Array.isArray(step.mutate)) {
        throw new Error(`loadScenario: ${where}.mutate must be an object, got ${JSON.stringify(step.mutate)}`);
      }
      if (typeof step.mutate.id !== 'string' || !VALID_MUTATION_IDS.has(step.mutate.id)) {
        throw new Error(
          `loadScenario: ${where}.mutate.id is ${JSON.stringify(step.mutate.id)}, which is not a known mutation id `
            + `(valid ids: ${[...VALID_MUTATION_IDS].sort().join(', ')})`,
        );
      }
      if (typeof step.mutate.target !== 'string' || step.mutate.target === '') {
        throw new Error(`loadScenario: ${where}.mutate.target must be a non-empty project-relative path string, got ${JSON.stringify(step.mutate.target)}`);
      }
      if (isTraversalOrAbsolute(step.mutate.target)) {
        throw new Error(
          `loadScenario: ${where}.mutate.target ${JSON.stringify(step.mutate.target)} must be project-relative `
            + '— absolute paths and ".." segments are rejected at load time',
        );
      }
      if (step.mutate.targetBytes !== undefined) {
        const { targetBytes } = step.mutate;
        if (typeof targetBytes !== 'number' || !Number.isFinite(targetBytes) || targetBytes < 0) {
          throw new Error(`loadScenario: ${where}.mutate.targetBytes must be a non-negative finite number, got ${JSON.stringify(targetBytes)}`);
        }
      }
    }
    if (step.agent !== undefined) {
      if (!step.agent || typeof step.agent !== 'object' || Array.isArray(step.agent)) {
        throw new Error(`loadScenario: ${where}.agent must be an object, got ${JSON.stringify(step.agent)}`);
      }
      if (step.agent.write !== undefined) {
        if (!step.agent.write || typeof step.agent.write !== 'object' || Array.isArray(step.agent.write)) {
          throw new Error(`loadScenario: ${where}.agent.write must be an object, got ${JSON.stringify(step.agent.write)}`);
        }
        for (const [relPath, ref] of Object.entries(step.agent.write)) {
          if (typeof ref !== 'string' || ref === '') {
            throw new Error(`loadScenario: ${where}.agent.write["${relPath}"] must be a non-empty ref string, got ${JSON.stringify(ref)}`);
          }
          if (isTraversalOrAbsolute(relPath)) {
            throw new Error(
              `loadScenario: ${where}.agent.write key ${JSON.stringify(relPath)} must be project-relative `
                + '— absolute paths and ".." segments are rejected at load time',
            );
          }
        }
      }
    }
  });

  return scenario;
}

/**
 * Load and validate a scenario JSON file.
 *
 * @param {string} absPathToJson
 * @returns {object} the validated scenario object.
 * @throws {Error} on missing/unparsable file or any validation violation
 *   (message names the offending field).
 */
function loadScenario(absPathToJson) {
  let text;
  try {
    text = fs.readFileSync(absPathToJson, 'utf-8');
  } catch (err) {
    throw new Error(`loadScenario: cannot read "${absPathToJson}": ${err && err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`loadScenario: "${absPathToJson}" is not valid JSON: ${err && err.message}`);
  }
  return validateScenario(parsed, path.resolve(absPathToJson));
}

/**
 * Evaluate a step's `expect` array against a `RunResult`.
 *
 * @param {Array<{path: string, is: unknown}>} expectations
 * @param {{ json: unknown }} result
 * @returns {string[]} human-readable failure descriptions, empty when all pass.
 */
function evaluateExpectations(expectations, result) {
  const failures = [];
  for (const exp of expectations || []) {
    const { found, value } = dotGet(result ? result.json : undefined, exp.path);
    if (!found) {
      failures.push(`path "${exp.path}": not found in result.json`);
      continue;
    }
    if (!deepEqual(value, exp.is)) {
      failures.push(`path "${exp.path}": expected ${JSON.stringify(exp.is)}, got ${JSON.stringify(value)}`);
    }
  }
  return failures;
}

/**
 * Drive a `LoopWalk` through every step of `scenario`, evaluating `expect`
 * assertions and the shared oracle set at each step. Never throws on a step
 * failure — failures are recorded on that step's report entry and the walk
 * continues, so one bad step never hides the rest.
 *
 * @param {object} scenario a scenario already validated by `loadScenario`.
 * @param {{
 *   LoopWalk: { create(opts: object): object },
 *   runOracles: (ctx: object) => { passed: string[], violations: {id:string,detail:string}[], smells: {id:string,detail:string}[], failed: {id:string,detail:string}[] },
 *   liveCommands?: string[],
 *   keep?: boolean,
 * }} opts `keep` (default `false`) preserves the walk's temp project instead
 *   of removing it in `finally` — see `LoopWalk#cleanup`. Also honored via
 *   the `GSD_QA_KEEP=1` environment variable (an `||`, not an override: either
 *   one being truthy keeps the tree), since a CI operator invoking this
 *   through a shell cannot pass a JS option.
 * @returns {{
 *   name: string,
 *   steps: Array<{ at: string, argv: string[], kind: string|null, expectFailures: string[], oracleFailures: {id:string,detail:string}[], smells: {id:string,detail:string}[], mutation: {id:string,target:string}|null, mutationNoop: boolean, mutationObserved: boolean }>,
 *   ok: boolean,
 *   smellSummary: Array<{ id: string, count: number, examples: string[] }>,
 *   preservedDir?: string,
 * }}
 */
function runScenario(scenario, opts) {
  const { LoopWalk, runOracles, liveCommands = [], keep = false } = opts || {};
  if (!LoopWalk || typeof LoopWalk.create !== 'function') {
    throw new Error('runScenario: opts.LoopWalk (with a create() factory) is required');
  }
  if (typeof runOracles !== 'function') {
    throw new Error('runScenario: opts.runOracles (function) is required');
  }
  const shouldKeep = keep || process.env.GSD_QA_KEEP === '1';

  const walk = LoopWalk.create({ fixture: scenario.fixture });
  /** @type {object[]} */
  const history = [];
  /** @type {Array<{at:string, argv:string[], kind:string|null, expectFailures:string[], oracleFailures:{id:string,detail:string}[], smells:{id:string,detail:string}[]}>} */
  const steps = [];
  let preservedDir;

  try {
    for (const step of scenario.steps) {
      try {
        if (step.agent && step.agent.write) {
          for (const [relPath, ref] of Object.entries(step.agent.write)) {
            walk.writeArtifact(relPath, resolveRef(ref));
          }
        }

        // Anti-vacuity for perturbations: BEFORE the mutation is applied,
        // run this step's own `run` sequence once against the CLEAN (as-yet
        // unmutated) world and keep only the last result's `kind`/`json` —
        // never pushed to `history`, never fed to oracles, never counted in
        // `statsBefore/After`. This baseline exists solely so that, once the
        // mutated run happens below, the two can be compared: a mutation
        // that changes nothing observable is indistinguishable from a
        // mutation that was never applied, so `mutationObserved` gives that
        // distinction a name instead of leaving it implicit in a diff nobody
        // looks at.
        let cleanBaseline = null;
        if (step.mutate) {
          const jsonErrorModeForBaseline = step.jsonErrors !== false;
          const baselineOptions = { jsonErrors: jsonErrorModeForBaseline };
          const baselineRuns = Array.isArray(step.run) ? step.run : [];
          let baselineResult = null;
          for (const argv of baselineRuns) {
            baselineResult = walk.run(...argv, baselineOptions);
          }
          if (baselineResult) {
            cleanBaseline = { kind: baselineResult.kind, json: baselineResult.json };
          }
        }

        // Mutation is applied AFTER `agent.write` and BEFORE `run` — a step
        // can write a valid artifact and then corrupt it, so `run` observes
        // the corrupted world exactly as a real engine invocation would.
        let mutationRecord = null;
        let mutationNoop = false;
        if (step.mutate) {
          const { id, target, targetBytes } = step.mutate;
          const entry = MUTATION_BY_ID.get(id);
          const absTarget = resolveWithin(walk.dir, target);
          if (entry.kind === 'content') {
            // This `readFileSync` is harness plumbing, not a test assertion —
            // it reads a planning ARTIFACT the walk itself just wrote so the
            // mutation catalog's pure string transforms have input to work
            // on. It is never string-matched/asserted against; the mutated
            // bytes are written straight back to disk for `run` to react to.
            // Do NOT "fix" this into a stat-only check — see `mutations.cjs`
            // and this file's header for why oracles must never read SUT
            // output, which does not apply to this harness-owned write path.
            const before = fs.readFileSync(absTarget, 'utf-8');
            const mutateOpts = targetBytes !== undefined ? { targetBytes } : undefined;
            const after = apply(id, before, mutateOpts);
            if (after === NOOP) {
              mutationNoop = true;
            } else {
              fs.writeFileSync(absTarget, after, 'utf-8');
            }
          } else {
            apply(id, { dir: walk.dir, relPath: target });
          }
          mutationRecord = { id, target };
        }

        const readOnly = !!step.readOnly;
        const runs = Array.isArray(step.run) ? step.run : [];
        // `step.jsonErrors === false` opts a step into the human-invocation
        // path (`gsd_run <cmd>` without `--json-errors`); any other value
        // (including undefined) keeps `LoopWalk#run`'s own default of true.
        const jsonErrorMode = step.jsonErrors !== false;
        const runOptions = { jsonErrors: jsonErrorMode };

        const statsBefore = walk.statSnapshot();
        let result = null;
        let lastArgv = [];
        for (const argv of runs) {
          result = walk.run(...argv, runOptions);
          lastArgv = argv;
        }
        const statsAfter = walk.statSnapshot();

        let repeatResult = null;
        if (readOnly && lastArgv.length > 0) {
          repeatResult = walk.run(...lastArgv, runOptions);
        }

        const expectFailures = evaluateExpectations(step.expect, result);
        const { violations: oracleFailures, smells } = runOracles({
          result,
          repeatResult,
          statsBefore,
          statsAfter,
          history,
          liveCommands,
          readOnly,
          projectDir: walk.dir,
          jsonErrorMode,
        });

        if (result) history.push(result);

        // `mutationObserved` is only meaningful for a mutated step: it is
        // `true` when the mutated run's result differs from the clean
        // baseline captured above, by `kind` OR by deep-inequality of
        // `json` — a `kind`-only comparison would miss a mutation that
        // keeps `kind: "json"` but silently changes the payload (e.g.
        // `found: true` -> `found: false`), which is exactly the class of
        // corruption a perturbation scenario exists to catch.
        const mutationObserved = step.mutate && cleanBaseline
          ? (cleanBaseline.kind !== (result ? result.kind : null) || !deepEqual(cleanBaseline.json, result ? result.json : null))
          : false;

        steps.push({
          at: step.at,
          argv: lastArgv,
          kind: result ? result.kind : null,
          expectFailures,
          oracleFailures,
          smells,
          mutation: mutationRecord,
          mutationNoop,
          mutationObserved,
        });
      } catch (err) {
        steps.push({
          at: step && step.at,
          argv: [],
          kind: null,
          expectFailures: [],
          oracleFailures: [{ id: 'step-exception', detail: `${err && err.message}` }],
          smells: [],
          mutation: null,
          mutationNoop: false,
          mutationObserved: false,
        });
      }
    }
  } finally {
    preservedDir = walk.cleanup({ keep: shouldKeep });
  }

  // A SMELL is evidence, never a build break: `ok` is derived from
  // `expectFailures` + `oracleFailures` (violations) ONLY. A step whose sole
  // findings are smells still counts as `ok`.
  const ok = steps.every((s) => s.expectFailures.length === 0 && s.oracleFailures.length === 0);
  const smellSummary = summarizeSmells(steps);
  return {
    name: scenario.name,
    steps,
    ok,
    smellSummary,
    ...(preservedDir ? { preservedDir } : {}),
  };
}

/**
 * Group every step's `smells` by oracle `id` across the whole walk, so a
 * reader sees "this oracle fired N times, here are up to 3 examples" rather
 * than a flat wall of per-step repeats.
 *
 * @param {Array<{smells: {id:string, detail:string}[]}>} steps
 * @returns {Array<{id: string, count: number, examples: string[]}>}
 */
function summarizeSmells(steps) {
  /** @type {Map<string, string[]>} */
  const byId = new Map();
  for (const step of steps) {
    for (const smell of step.smells || []) {
      const list = byId.get(smell.id) || [];
      list.push(smell.detail);
      byId.set(smell.id, list);
    }
  }
  return [...byId.entries()].map(([id, details]) => ({
    id,
    count: details.length,
    examples: details.slice(0, 3),
  }));
}

/** Absolute path to the wiring self-test scenario — see `assertWiringIsLive`. */
const SELF_TEST_SCENARIO_PATH = path.join(__dirname, 'scenarios', '_selftest-must-fail.json');

/**
 * The REAL wiring detector for this harness's assertion machinery.
 *
 * `totalSmells > 0` on a happy-path walk proves almost nothing: it leans on
 * well-known engine behaviors that fire regardless of whether `expect` /
 * oracle plumbing actually works. This function instead loads the
 * deliberately-broken `scenarios/_selftest-must-fail.json` scenario — whose
 * `expect` block asserts something KNOWN FALSE about a real command — and
 * runs it for real. If the assertion machinery is wired correctly, the run
 * MUST fail (`ok === false`, non-empty `expectFailures`); if it silently
 * passes, `expect` is not actually being evaluated and this function throws
 * naming that fact, rather than letting a broken harness report a clean bill
 * of health.
 *
 * @param {{ LoopWalk: object, runOracles: Function, liveCommands?: string[] }} opts
 * @returns {ReturnType<typeof runScenario>} the self-test's own report, for
 *   callers that want to inspect or log it.
 * @throws {Error} when the self-test scenario is missing `"selfTest": true`,
 *   or when it does NOT fail — either case means the expect/oracle assertion
 *   machinery is not provably wired.
 */
function assertWiringIsLive(opts) {
  const scenario = loadScenario(SELF_TEST_SCENARIO_PATH);
  if (scenario.selfTest !== true) {
    throw new Error(`assertWiringIsLive: "${SELF_TEST_SCENARIO_PATH}" is missing "selfTest": true`);
  }
  const report = runScenario(scenario, opts);
  if (report.ok !== false) {
    throw new Error(
      'assertWiringIsLive: the self-test scenario (a KNOWN-FALSE expectation) did not fail — '
        + 'the expect/oracle assertion machinery is not wired',
    );
  }
  const hasExpectFailure = report.steps.some((s) => s.expectFailures.length > 0);
  if (!hasExpectFailure) {
    throw new Error(
      'assertWiringIsLive: the self-test scenario failed via oracleFailures but recorded no expectFailures — '
        + 'the "expect" assertion machinery specifically is not provably wired',
    );
  }
  return report;
}

module.exports = { loadScenario, runScenario, deepEqual, dotGet, assertWiringIsLive };

// allow-test-rule: source-text-is-the-product (see #2481)
// The final describe block asserts on gsd-core/workflows/review.md's text. A
// workflow .md IS what the runtime loads — its literal command lines are the
// deployed contract, and there is no runtime seam that executes review.md here.
// Every other block in this file is behavioral (CLI + module surface).

/**
 * #2481 — ADR-1239 `effortSurface` axis + ADR-443 path (a).
 *
 * Before this change effort reached a runtime only through install-time channels
 * (EFFORT_RENDERING's `frontmatter`/`api`), so a reviewer CLI spawned as a
 * subprocess silently inherited whatever effort sat in the user's own global CLI
 * config. These tests pin the invocation-time channel: the negotiated axis that
 * decides WHETHER effort is deliverable, the renderer that knows the syntax, and
 * the live orchestration path that carries it.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const {
  renderEffortArgv,
  EFFORT_ARGV,
} = require(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'model-catalog.cjs'));
const {
  HOST_INTEGRATION_AXES,
  negotiateHostCapabilities,
  degradationFor,
} = require(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'host-integration.cjs'));
const {
  _HOST_INTEGRATION_VOCAB,
  validateRuntimeBody,
} = require(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'capability-validator.cjs'));

/**
 * A real shipped descriptor with one hostIntegration axis stripped.
 *
 * Deriving the fixture from a descriptor this gate did not author satisfies the
 * fixture-provenance rule (#2371) — a hand-built body would only ever encode the
 * author's mental model of a valid descriptor, which is how the required-axis
 * defect reached the runner in the first place.
 */
function shippedDescriptorWithout(axis) {
  const cap = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'vscode', 'capability.json'), 'utf8'),
  );
  delete cap.runtime.hostIntegration[axis];
  return cap;
}

/** Write a project whose effort cascade resolves to a known universal value. */
function projectWithEffort(effort) {
  const dir = createTempProject();
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ effort: { default: effort } }, null, 2),
  );
  return dir;
}

describe('#2481 effortSurface — closed vocabulary', () => {
  test('is exactly argv|none — no config-file member', () => {
    // Gemini CLI was the only host with a config-file effort surface and was
    // removed as a sunset runtime (8f2ebbe9b / #1928 / PR #1996). A member no
    // supported host can claim would invite guessed descriptor values.
    assert.deepEqual([...HOST_INTEGRATION_AXES.effortSurface], ['argv', 'none']);
  });

  test('engine vocabulary and validator mirror agree (parity guard)', () => {
    assert.deepEqual(
      [...HOST_INTEGRATION_AXES.effortSurface],
      [..._HOST_INTEGRATION_VOCAB.effortSurface],
    );
  });

  test('undocumented is NOT a vocabulary member — it is the corpus sentinel', () => {
    assert.ok(!HOST_INTEGRATION_AXES.effortSurface.includes('undocumented'));
  });
});

describe('#2481 effortSurface — negotiation fails closed', () => {
  const cases = [
    ['argv declared', 'argv', 'argv'],
    ['undocumented sentinel', 'undocumented', 'none'],
    ['retired value (config-file)', 'config-file', 'none'],
    ['unknown/future value', 'quantum-telepathy', 'none'],
    ['empty string', '', 'none'],
    ['none declared', 'none', 'none'],
  ];
  for (const [label, declared, expected] of cases) {
    test(`${label} -> ${expected}`, () => {
      const r = negotiateHostCapabilities({ protocolVersion: 1, modelMode: 'active', effortSurface: declared });
      assert.equal(r.effective.effortSurface, expected);
    });
  }

  test('axis omitted entirely -> safe floor, and the omission is warned', () => {
    const r = negotiateHostCapabilities({ protocolVersion: 1, modelMode: 'active' });
    assert.equal(r.effective.effortSurface, 'none');
    assert.ok(r.warnings.some((w) => String(w).includes('effortSurface')));
  });

  test('a descriptor that omits the axis entirely still validates clean', () => {
    // The axis was added after descriptors existed. Requiring it would invalidate
    // every pre-existing descriptor — including third-party ones — and break the
    // "purely additive" property ADR-1239 promises for external descriptors.
    // Regression guard: 48 suites failed across both node lanes when it was required.
    const cap = shippedDescriptorWithout('effortSurface');
    const errors = validateRuntimeBody(cap);
    assert.deepEqual(
      errors, [],
      `a descriptor without effortSurface must validate clean, got: ${JSON.stringify(errors)}`,
    );
  });

  test('optional does not mean unvalidated — a present bad value is still rejected', () => {
    const cap = shippedDescriptorWithout('effortSurface');
    cap.runtime.hostIntegration.effortSurface = 'config-file'; // retired value
    const errors = validateRuntimeBody(cap);
    assert.ok(
      errors.some((e) => String(e).includes('effortSurface')),
      `a present invalid value must error, got: ${JSON.stringify(errors)}`,
    );
  });

  test('an undeclared axis is never invented from a profile baseline', () => {
    // Regression guard for the failure this axis was designed against: a
    // programmatic-cli host must not inherit `argv` merely by being programmatic.
    const r = negotiateHostCapabilities({
      protocolVersion: 1,
      embeddingMode: 'imperative',
      commandSurface: 'slash-file',
      modelMode: 'active',
    });
    assert.equal(r.effective.effortSurface, 'none');
  });
});

describe('#2481 effortSurface — is its own axis, not folded into the model point', () => {
  test('the model interface point still grades on modelMode alone', () => {
    // Deliberate: modelMode has graded interface point 3 since Phase A. Widening
    // it to also mean "delivers effort" would silently redefine that contract for
    // every existing consumer. Effort is read from effective.effortSurface.
    assert.equal(degradationFor('model', { modelMode: 'active' }).level, 'full');
    assert.equal(degradationFor('model', { modelMode: 'passive' }).level, 'degraded');
  });

  test('declaring an effort surface does not change the model point', () => {
    for (const es of ['argv', 'none', 'undocumented', undefined]) {
      assert.equal(degradationFor('model', { modelMode: 'active', effortSurface: es }).level, 'full');
    }
  });

  test('degradationFor never throws on a malformed axes object', () => {
    for (const axes of [{}, { modelMode: null }, { effortSurface: 42 }, { modelMode: 'active', effortSurface: [] }]) {
      assert.ok(['full', 'degraded', 'absent'].includes(degradationFor('model', axes).level));
    }
  });
});

describe('#2481 renderEffortArgv — per-host syntax and clamping', () => {
  test('claude renders --effort', () => {
    assert.deepEqual(renderEffortArgv('claude', 'xhigh', 'argv').argv, ['--effort', 'xhigh']);
  });

  test('opencode renders --variant', () => {
    assert.deepEqual(renderEffortArgv('opencode', 'high', 'argv').argv, ['--variant', 'high']);
  });

  test('codex renders the generic -c config override, not a dedicated flag', () => {
    // codex-rs/exec/src/cli.rs: model_reasoning_effort is NOT a CLI flag
    // (config.toml key only), so -c key=value is the only argv route.
    assert.deepEqual(
      renderEffortArgv('codex', 'high', 'argv').argv,
      ['-c', 'model_reasoning_effort=high'],
    );
  });

  test('clamps the provider-unique tail levels', () => {
    // claude has no `minimal`; codex has no `max`.
    assert.deepEqual(renderEffortArgv('claude', 'minimal', 'argv').argv, ['--effort', 'low']);
    assert.deepEqual(renderEffortArgv('codex', 'max', 'argv').argv, ['-c', 'model_reasoning_effort=xhigh']);
  });

  test('emits nothing when the surface is not argv', () => {
    for (const surface of ['none', 'undocumented', 'config-file', '', null, undefined]) {
      assert.deepEqual(renderEffortArgv('claude', 'xhigh', surface).argv, []);
    }
  });

  test('emits nothing for a host with no known syntax', () => {
    for (const host of ['gemini', 'cursor', 'zcode', '']) {
      assert.deepEqual(renderEffortArgv(host, 'high', 'argv').argv, []);
    }
  });

  test('inherited Object members are not mistaken for host specs', () => {
    // Regression guard: a bare EFFORT_ARGV[host] lookup resolves these to
    // inherited members — truthy, but with no clamp/render — so a hostile host
    // id from an untrusted descriptor threw instead of degrading.
    for (const host of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.deepEqual(
        renderEffortArgv(host, 'high', 'argv').argv, [],
        `${host} must degrade to no argument, not throw`,
      );
    }
  });

  test('emits nothing for a missing or unrecognised effort level', () => {
    for (const level of ['', 'bogus', 'HIGH', ' high', null, undefined, 42]) {
      assert.deepEqual(renderEffortArgv('claude', level, 'argv').argv, []);
    }
  });

  test('property: a rendered level is always inside that host\'s supported set', () => {
    const hosts = Object.keys(EFFORT_ARGV);
    const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    fc.assert(
      fc.property(fc.constantFrom(...hosts), fc.constantFrom(...levels), (host, level) => {
        const r = renderEffortArgv(host, level, 'argv');
        if (r.argv.length === 0) return true;
        return EFFORT_ARGV[host].supported.has(r.value);
      }),
      { numRuns: 200, seed: 2481 },
    );
  });
});

describe('#2481 live path — resolve-execution carries invocation-time effort', () => {
  test('--host renders the argument for an argv host', (t) => {
    const dir = projectWithEffort('xhigh');
    t.after(() => cleanup(dir));

    const r = runGsdTools('query resolve-execution gsd-planner --host claude', dir);
    assert.ok(r.success, `resolve-execution failed: ${r.error}`);
    const out = JSON.parse(r.output);
    assert.equal(out.effort, 'xhigh');
    assert.equal(out.effort_surface, 'argv');
    assert.deepEqual(out.effort_argv, ['--effort', 'xhigh']);
    assert.equal(out.effort_argv_string, '--effort xhigh');
  });

  test('--host on a host without a documented surface renders nothing', (t) => {
    const dir = projectWithEffort('xhigh');
    t.after(() => cleanup(dir));

    const out = JSON.parse(runGsdTools('query resolve-execution gsd-planner --host cursor', dir).output);
    assert.equal(out.effort_surface, 'none');
    assert.deepEqual(out.effort_argv, []);
    assert.equal(out.effort_argv_string, '');
  });

  test('an unknown host degrades closed rather than erroring', (t) => {
    const dir = projectWithEffort('high');
    t.after(() => cleanup(dir));

    const r = runGsdTools('query resolve-execution gsd-planner --host not-a-real-host', dir);
    assert.ok(r.success, 'an unknown host must degrade, not fail');
    const out = JSON.parse(r.output);
    assert.equal(out.effort_surface, 'none');
    assert.deepEqual(out.effort_argv, []);
  });

  test('omitting --host leaves the JSON contract untouched', (t) => {
    const dir = projectWithEffort('high');
    t.after(() => cleanup(dir));

    const out = JSON.parse(runGsdTools('query resolve-execution gsd-planner', dir).output);
    for (const k of ['host', 'effort_surface', 'effort_argv', 'effort_argv_string', 'effort_argv_value']) {
      assert.ok(!(k in out), `--host absent must not add "${k}" to the contract`);
    }
  });

  test('--host requires a value', (t) => {
    const dir = projectWithEffort('high');
    t.after(() => cleanup(dir));

    const r = runGsdTools('query resolve-execution gsd-planner --host', dir);
    assert.ok(!r.success, 'a valueless --host must be a usage error');
  });

  test('a shell-metacharacter host is not interpolated, just unmatched', (t) => {
    const dir = projectWithEffort('high');
    t.after(() => cleanup(dir));

    const r = runGsdTools('query resolve-execution gsd-planner --host "claude; touch pwned"', dir);
    assert.ok(r.success);
    assert.deepEqual(JSON.parse(r.output).effort_argv, []);
    assert.ok(!fs.existsSync(path.join(dir, 'pwned')), 'no shell interpolation of the host value');
  });
});

describe('#2481 — the escalation surface renders argv (CLI-level, not a workflow claim)', () => {
  // NAMING IS DELIBERATE. This exercises `resolve-execution --attempt` directly,
  // which is the CLI surface ADR-443's blocker explicitly EXCLUDES when it asks
  // for "a real caller outside src/commands.cts's CLI surface and tests". It
  // proves the escalation ladder still renders a host argument; it does NOT
  // prove any workflow escalates. The live workflow caller for Decision item 6
  // is #2296's gsd-core/references/execute-phase-quota-recovery.md, asserted
  // separately below.
  test('--attempt walks the effort ladder above the configured default', (t) => {
    const dir = createTempProject();
    t.after(() => cleanup(dir));
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({
        effort: { default: 'low' },
        dynamic_routing: { enabled: true, escalate_on_failure: true, max_escalations: 3 },
      }, null, 2),
    );

    const at = (n) => JSON.parse(
      runGsdTools(`query resolve-execution gsd-planner --host claude --attempt ${n}`, dir).output,
    );

    // attempt 0 is the un-escalated baseline; a later attempt must not be lower.
    const base = at(0);
    const later = at(2);
    const RANK = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
    assert.equal(base.effort, 'low');
    assert.ok(
      RANK[later.effort] >= RANK[base.effort],
      `escalation must not lower effort: attempt0=${base.effort} attempt2=${later.effort}`,
    );
    // Whatever the ladder resolved, it must still reach the host as an argument.
    assert.equal(later.effort_surface, 'argv');
    assert.deepEqual(later.effort_argv, ['--effort', later.effort]);
  });

  test('a negative --attempt is rejected', (t) => {
    const dir = projectWithEffort('high');
    t.after(() => cleanup(dir));
    assert.ok(!runGsdTools('query resolve-execution gsd-planner --attempt -1', dir).success);
  });
});

describe('#2481 — ADR-443 mechanism callers, as they actually exist', () => {
  const quotaRecovery = fs.readFileSync(
    path.join(REPO_ROOT, 'gsd-core', 'references', 'execute-phase-quota-recovery.md'),
    'utf8',
  );
  const executePhase = fs.readFileSync(
    path.join(REPO_ROOT, 'gsd-core', 'workflows', 'execute-phase.md'),
    'utf8',
  );

  test('Decision item 6 (escalation) has its live caller — from #2296, not this change', () => {
    assert.match(
      quotaRecovery, /resolve-execution\s+gsd-executor\s+--attempt/,
      'execute-phase-quota-recovery.md must invoke resolve-execution with --attempt (#2296)',
    );
    assert.ok(
      executePhase.includes('references/execute-phase-quota-recovery.md'),
      'that reference must be @-included into execute-phase.md, or it is not a live caller',
    );
  });

  test('Decision item 1 (invocation override) still has NO live caller', () => {
    // Guards the corrected ADR-443 claim. If someone later wires --effort into a
    // workflow, this fails and the ADR status text must be revisited — that is
    // the point: the ADR must not silently drift back to being wrong.
    const dirs = ['gsd-core/workflows', 'gsd-core/references', 'agents', 'commands'];
    const hits = [];
    const walk = (d) => {
      const abs = path.join(REPO_ROOT, d);
      if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const full = path.join(abs, e.name);
        if (e.isDirectory()) walk(path.relative(REPO_ROOT, full));
        else if (e.name.endsWith('.md') && /resolve-execution[^\r\n]*--effort\s/.test(fs.readFileSync(full, 'utf8'))) {
          hits.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    dirs.forEach(walk);
    assert.deepEqual(
      hits, [],
      `ADR-443 records Decision item 1 as having no live caller; found: ${JSON.stringify(hits)}. ` +
      'Update the ADR-443 amendment before adding one.',
    );
  });
});

describe('#2481 review workflow resolves effort per reviewer', () => {
  const reviewMd = fs.readFileSync(
    path.join(REPO_ROOT, 'gsd-core', 'workflows', 'review.md'),
    'utf8',
  );

  test('shipped orchestration invokes resolve-execution — the grep ADR-443 said returned zero hits', () => {
    // Phase 5b (#2799) moved the call out of review.md's per-lane bash and into the review-lane
    // route, which resolves effort once per selected lane through the SAME surface. ADR-443's
    // invariant is about shipped orchestration calling resolve-execution at all, not about which
    // file it lives in — so the assertion follows the call rather than pinning the old location.
    const toolsSrc = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs'), 'utf-8',
    );
    assert.ok(
      toolsSrc.includes('resolve-execution'),
      'ADR-443 blocks on no shipped orchestration calling resolve-execution',
    );
  });

  test('each argv-effort reviewer places effort in its resolved command line', () => {
    // Stronger than the old shell-variable check: this asserts the effort actually lands in the
    // argv AT THE POSITION the lane declares, which a `$VAR` substring never proved. Lanes whose
    // effortChannel is not `argv` must receive nothing.
    const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
    const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
    const EFFORT = ['--effort', 'high'];
    for (const lane of REVIEWER_LANES.filter((l) => l.transport === 'spawn')) {
      const r = resolveLanePlan({
        lane, configGet: () => undefined, runDir: '/run', repoRoot: '/repo', effortArgs: EFFORT,
      });
      assert.equal(r.ok, true, `${lane.slug} failed to resolve`);
      const carries = r.plan.argv.includes('--effort');
      assert.equal(
        carries, lane.invoke.effortChannel === 'argv',
        `${lane.slug}: effortChannel=${lane.invoke.effortChannel} but argv ${carries ? 'carries' : 'omits'} effort`,
      );
    }
    // The three lanes ADR-1239 #2481 named must still be the argv-effort set.
    const argvEffort = REVIEWER_LANES
      .filter((l) => l.transport === 'spawn' && l.invoke.effortChannel === 'argv')
      .map((l) => l.slug).sort();
    assert.deepStrictEqual(argvEffort, ['claude', 'codex', 'opencode']);
  });
});

// #2615 the matrix-parity block below (the file's final describe block) is a
// contract assertion, not a source grep: docs/reference/host-integration-capability-matrix.md
// IS the cited source of truth for every descriptor axis (ADR-1239), so asserting a shipped
// axis value appears there and matches is a contract assertion. Every other block in this file
// is behavioral (CLI + module surface).

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
const os = require('node:os');
const cp = require('node:child_process');
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
const registry = require(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs'));

// #2615: the host-integration capability matrix, normalized so CRLF checkouts
// (Windows autocrlf) don't break the row regexes below.
const MATRIX = path.join(REPO_ROOT, 'docs', 'reference', 'host-integration-capability-matrix.md');
const MATRIX_TEXT = fs.readFileSync(MATRIX, 'utf-8').replace(/\r\n/g, '\n');

/** Extract a `## <host>` section body, stopping at the next top-level host heading. */
function matrixSection(host) {
  const start = MATRIX_TEXT.indexOf(`\n## ${host}\n`);
  if (start === -1) return null;
  const rest = MATRIX_TEXT.slice(start + 1);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

/** Read the value cell of a `| <axis> | <value> | …` row. */
function matrixAxisValue(body, axis) {
  const row = body.split(/\r?\n/).find((l) => l.startsWith(`| ${axis} |`));
  return row ? row.split('|')[2].trim() : null;
}

const MATRIX_RUNTIMES = Object.keys(registry.runtimes).filter(
  (id) => registry.runtimes[id]?.runtime?.hostIntegration,
);

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

describe('#3534 resolve-execution reports resolved AND effective effort', () => {
  function agentHome(t, agentFileBody) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3534-home-'));
    t.after(() => cleanup(home));
    if (agentFileBody !== null) {
      fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(home, 'agents', 'gsd-executor.md'), agentFileBody);
    }
    return home;
  }

  function resolveExecution(dir, agent = 'gsd-executor', extra = [], env = {}) {
    return JSON.parse(
      runGsdTools(`query resolve-execution ${agent} ${extra.join(' ')}`, dir, env).output,
    );
  }

  test('10a: effective effort reads the installed frontmatter (claude)', (t) => {
    const dir = projectWithEffort('high');
    t.after(() => cleanup(dir));
    const home = agentHome(t, '---\nname: gsd-executor\neffort: low\ndescription: x\n---\nBody.\n');
    // #3534: pass the fixture home as the CHILD env argument — testEnvBase()
    // blanks CLAUDE_CONFIG_DIR after the process.env spread, so a process.env
    // mutation never reaches the child (and a dev's real ~/.claude would).
    const out = resolveExecution(dir, 'gsd-executor', [], { CLAUDE_CONFIG_DIR: home });
    assert.equal(out.effort, 'high', 'resolved cascade value unchanged');
    assert.equal(out.effort_effective, 'low', 'the installed frontmatter value');
    assert.equal(out.effort_effective_source, 'frontmatter');
    // Existing keys all still present, unchanged shape.
    for (const k of ['model', 'profile', 'effort', 'effort_rendered', 'effort_param', 'effort_propagation', 'fast_mode', 'fast_mode_supported']) {
      assert.ok(k in out, `existing key ${k} must remain`);
    }
  });

  test('10a: absent frontmatter reports inherit as the effective state (the 10a repro)', (t) => {
    const dir = projectWithEffort('high');
    t.after(() => cleanup(dir));
    const home = agentHome(t, '---\nname: gsd-executor\ndescription: x\n---\nBody.\n');
    const out = resolveExecution(dir, 'gsd-executor', [], { CLAUDE_CONFIG_DIR: home });
    assert.equal(out.effort, 'high');
    assert.equal(out.effort_effective, 'inherit', 'absent key = follows the session');
    assert.equal(out.effort_effective_source, 'frontmatter-absent');
  });

  test('10a: missing agent file falls back to resolved with the flag', (t) => {
    const dir = projectWithEffort('high');
    t.after(() => cleanup(dir));
    const home = agentHome(t, null);
    const out = resolveExecution(dir, 'gsd-executor', [], { CLAUDE_CONFIG_DIR: home });
    assert.equal(out.effort_effective, out.effort);
    assert.equal(out.effort_effective_source, 'resolved');
  });

  test('10a: runtimes without an install-time channel report resolved', (t) => {
    const dir = createTempProject();
    t.after(() => cleanup(dir));
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      // #3531+#3534 combined: pin the AGENT — a bare effort.default no longer
      // reaches a tiered agent under the merged tier ladder.
      JSON.stringify({ runtime: 'codex', effort: { agent_overrides: { 'gsd-executor': 'medium' } } }, null, 2),
    );
    const out = resolveExecution(dir);
    assert.equal(out.effort, 'medium');
    assert.equal(out.effort_effective, 'medium');
    assert.equal(out.effort_effective_source, 'resolved');
  });

  test('10a: CRLF frontmatter is read', (t) => {
    const dir = projectWithEffort('high');
    t.after(() => cleanup(dir));
    const home = agentHome(t, ['---', 'name: gsd-executor', 'effort: xhigh', 'description: x', '---', 'Body.', ''].join('\r\n'));
    const out = resolveExecution(dir, 'gsd-executor', [], { CLAUDE_CONFIG_DIR: home });
    assert.equal(out.effort_effective, 'xhigh');
    assert.equal(out.effort_effective_source, 'frontmatter');
  });

  test('10a: frontmatter-less agent file degrades to resolved', (t) => {
    const dir = projectWithEffort('high');
    t.after(() => cleanup(dir));
    const home = agentHome(t, 'No frontmatter here at all.\n');
    const out = resolveExecution(dir, 'gsd-executor', [], { CLAUDE_CONFIG_DIR: home });
    assert.equal(out.effort_effective, out.effort);
    assert.equal(out.effort_effective_source, 'resolved');
  });

});

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

  // #3007: corrected — Codex gained 'max' (declared per-model), and no Codex
  // model advertises 'minimal', so 'max' now passes through and 'minimal'
  // clamps to 'low' instead.
  test('clamps the provider-unique tail levels', () => {
    // claude has no `minimal`; codex has no `minimal` either (clamps to 'low').
    assert.deepEqual(renderEffortArgv('claude', 'minimal', 'argv').argv, ['--effort', 'low']);
    assert.deepEqual(renderEffortArgv('codex', 'max', 'argv').argv, ['-c', 'model_reasoning_effort=max']);
    assert.deepEqual(renderEffortArgv('codex', 'minimal', 'argv').argv, ['-c', 'model_reasoning_effort=low']);
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

describe('#3533 inherit renders no host argv argument', () => {
  test('a project configuring inherit resolves effort inherit and renders NO argv', (t2) => {
    const dir = createTempProject();
    t2.after(() => cleanup(dir));
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ effort: { agent_overrides: { 'gsd-planner': 'inherit' } } }, null, 2),
    );
    const out = JSON.parse(
      runGsdTools('query resolve-execution gsd-planner --host claude', dir).output,
    );
    assert.equal(out.effort, 'inherit');
    assert.deepEqual(out.effort_argv, [], 'inherit must render no argument');
    assert.equal(out.effort_propagation, null);
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
        // #3531: pin the heavy tier rather than effort.default — a bare default
        // no longer answers for gsd-planner (heavy) now that the config block
        // merges over the built-in tier ladder.
        effort: { routing_tier_defaults: { heavy: 'low' } },
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

  /**
   * Does this text invoke `resolve-execution` with an invocation-time effort override (#2475)?
   *
   * BOTH argument shapes, because the CLI accepts both: `--effort <level>` and `--effort=<level>`
   * (`gsd-core/bin/gsd-tools.cjs` — `a.slice('--effort='.length)`). The original matcher required
   * `--effort\s`, so `--effort=low` — the terser form a workflow author is at least as likely to
   * write — evaded it entirely, along with `--effort` at end-of-input. That hole mattered little
   * while this guard merely SNAPSHOT a temporary gap; it matters a lot now that path (b) makes the
   * guard the enforcement of a decision (ADR-443 amendment 2026-08-19).
   *
   * `[^\r\n]*` keeps the call and the flag on ONE line, so a `resolve-execution` on one line and an
   * unrelated `--effort` on the next is not a false hit. The trailing `(?:[\s=]|$)` is what stops
   * `--effortless` from matching: the character after `--effort` must be a delimiter or nothing.
   *
   * The unbounded quantifier is deliberate and safe here: the corpus scanned is maintainer-authored
   * workflow, reference, and agent markdown — bounded prose, not adversarial input.
   *
   * DIVERGENCE RISK. This predicate independently models `gsd-tools.cjs`'s own argument parser; the
   * two are not derived from one shared constant. If that parser ever accepts a THIRD spelling of
   * `--effort`, this regex is the surface that must follow it — otherwise ADR-443's ratifying
   * invariant silently stops holding while the guard still reports green.
   */
  const EFFORT_CALLER_RE = /resolve-execution[^\r\n]*--effort(?:[\s=]|$)/;
  const hasEffortCaller = (text) => EFFORT_CALLER_RE.test(String(text ?? ''));

  test('the item-1 matcher recognises every shape the CLI accepts, and nothing else', () => {
    // Behavioral: the predicate is called with inputs and its verdict asserted. The equals form
    // fails against the pre-#2475 matcher — it is the regression this sub-change closes.
    for (const [label, text] of [
      ['space form', 'gsd_run query resolve-execution gsd-executor --effort low\n'],
      ['equals form', 'gsd_run query resolve-execution gsd-executor --effort=low\n'],
      ['bare trailing --effort', 'gsd_run query resolve-execution gsd-executor --effort\n'],
      ['end of input, no newline', 'gsd_run query resolve-execution gsd-executor --effort'],
      ['CRLF equals form', 'gsd_run query resolve-execution gsd-executor --effort=low\r\n'],
    ]) {
      assert.ok(hasEffortCaller(text), `must detect an item-1 caller written as: ${label}`);
    }

    for (const [label, text] of [
      ['--effortless is a different word', 'resolve-execution gsd-executor --effortless\n'],
      ['no effort argument at all', 'resolve-execution gsd-executor --host codex\n'],
      ['--effort without resolve-execution', 'some-other-command --effort low\n'],
      ["item 6's --attempt caller", 'resolve-execution gsd-executor --attempt 1\n'],
      ['call and flag on different lines', 'resolve-execution\ngsd-executor --effort low\n'],
      ['empty input', ''],
    ]) {
      assert.ok(!hasEffortCaller(text), `must NOT fire on: ${label}`);
    }
  });

  test('Decision item 1 (invocation override) has no orchestration caller — by decision', () => {
    // ADR-443's 2026-08-19 amendment settles this as path (b) FOR ITEM 1: the invocation-override
    // step is an operator-facing CLI surface, deliberately not driven by shipped orchestration.
    // So this is no longer a snapshot of a gap awaiting wiring — it is the invariant that keeps the
    // ratified ADR true. A hit here is not "the ADR is stale", it is "the ADR must be amended first".
    const dirs = ['gsd-core/workflows', 'gsd-core/references', 'agents', 'commands'];
    const hits = [];
    const walk = (d) => {
      const abs = path.join(REPO_ROOT, d);
      if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const full = path.join(abs, e.name);
        if (e.isDirectory()) walk(path.relative(REPO_ROOT, full));
        else if (e.name.endsWith('.md') && hasEffortCaller(fs.readFileSync(full, 'utf8'))) {
          hits.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    dirs.forEach(walk);
    assert.deepEqual(
      hits, [],
      `ADR-443 records Decision item 1 as deliberately having no orchestration caller; found: ${JSON.stringify(hits)}. ` +
      'Amend ADR-443 before wiring one — the ADR is Accepted on the strength of this invariant.',
    );
  });
});

describe('#2481 review workflow resolves effort per reviewer', () => {
  test('shipped orchestration: the live claude lane genuinely receives --effort <level> in its spawned argv', () => {
    // Phase 5b (#2799) moved the call out of review.md's per-lane bash and into the review-lane
    // route's `effortFor()`, which folds a resolved level into that lane's argv template. A text
    // grep in gsd-tools.cjs would pass even if the result were silently dropped before reaching
    // the spawned reviewer, or if the call were dead code. This drives the REAL `review-lane
    // invoke` route end-to-end — real cp.spawnSync, a real project config, a real claude-shaped
    // shim on PATH — and inspects the argv the shim actually received, which is the only way to
    // prove the resolved effort reaches the invocation rather than merely that some file mentions
    // the command name.
    //
    // #4255 changed WHERE the level comes from, not whether it must arrive. It used to be read
    // from the `gsd-plan-checker` AGENT's execution settings via a hardcoded id, so this row
    // configured `effort.routing_tier_defaults` and expected that value in the reviewer's argv.
    // A reviewer lane is not that agent, and the coupling is the bug. The row now configures the
    // lane's OWN `review.effort.claude` and pins the decoupling in the same spawn: the execution
    // routing tier is set to a DIFFERENT level, and leaking it into the reviewer is a failure.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2481-orchestration-e2e-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2481-orchestration-project-'));
    try {
      const bin = path.join(dir, 'bin');
      const runDir = path.join(dir, 'run');
      fs.mkdirSync(bin);
      fs.mkdirSync(runDir);
      fs.writeFileSync(path.join(runDir, 'gsd-review-prompt.md'), 'prompt');

      const seenArgv = path.join(dir, 'argv.txt');
      fs.writeFileSync(
        path.join(bin, 'claude'),
        '#!/usr/bin/env bash\n'
        + 'cat >/dev/null\n'
        + `printf '%s\\n' "$@" > "${seenArgv}"\n`
        + 'echo "a review body long enough to clear the empty-output guard."\n',
        { mode: 0o755 },
      );

      // An extensionless file with a POSIX shebang is not executable on Windows:
      // CreateProcess resolves a bare `claude` command against PATHEXT
      // (.COM;.EXE;.BAT;.CMD;...), and a shebang-only file matches none of them,
      // so the shim above is invisible there. Ship a second shim recognized by
      // PATHEXT that writes the SAME newline-per-argv capture format the
      // assertion below parses. Delegating the actual argv capture to a small
      // Node script (invoked via `%*`) rather than parsing `%*` in batch avoids
      // cmd.exe's fragile re-splitting of quoted/spaced arguments — Node parses
      // the raw Windows command line itself, the same way the real `claude`
      // binary's argv would be parsed.
      if (process.platform === 'win32') {
        const captureScript = path.join(bin, '_claude-capture.cjs');
        fs.writeFileSync(
          captureScript,
          'const fs = require("fs");\n'
          + 'process.stdin.resume();\n'
          + 'process.stdin.on("end", () => {\n'
          + `  fs.writeFileSync(${JSON.stringify(seenArgv)}, process.argv.slice(2).join("\\n") + "\\n");\n`
          + '  console.log("a review body long enough to clear the empty-output guard.");\n'
          + '});\n',
        );
        fs.writeFileSync(
          path.join(bin, 'claude.cmd'),
          `@echo off\r\n"${process.execPath}" "${captureScript}" %*\r\n`,
        );
      }

      fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, '.planning', 'config.json'),
        // Two levels, deliberately different (#4255). `review.effort.claude` is the reviewer
        // lane's own key and is what must reach the shim. `effort.routing_tier_defaults` drives
        // the AGENT execution axis and is pinned across every tier to a level that must NOT
        // appear — before #4255 it, through gsd-plan-checker, was the only thing that could.
        JSON.stringify({
          review: { effort: { claude: 'xhigh' } },
          effort: { routing_tier_defaults: { light: 'minimal', standard: 'minimal', heavy: 'minimal' } },
        }, null, 2),
      );

      const r = cp.spawnSync(
        process.execPath,
        [
          path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs'),
          'review-lane', 'invoke', '--slug', 'claude',
          '--run-dir', runDir, '--repo-root', REPO_ROOT, '--json',
        ],
        {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 60000,
          killSignal: 'SIGKILL',
          env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
        },
      );
      assert.equal(r.status, 0, `review-lane invoke failed: ${r.stderr}`);
      assert.ok(fs.existsSync(seenArgv), `the claude shim never ran; stdout was: ${r.stdout}`);

      const argv = fs.readFileSync(seenArgv, 'utf8').trim().split(/\r?\n/);
      assert.ok(
        argv.includes('--effort') && argv.includes('xhigh'),
        `the lane's own review effort ("xhigh") did not reach the spawned claude reviewer's argv: ${JSON.stringify(argv)}`,
      );
      // The decoupling half (#4255), and the reason this row is worth a real spawn: the agent
      // execution tier is pinned to `minimal` above. Seeing it here would mean a reviewer lane is
      // still taking its effort from an agent's execution settings.
      assert.ok(
        !argv.includes('minimal'),
        'the AGENT execution routing tier leaked into the reviewer lane\'s argv: '
        + `${JSON.stringify(argv)} — a lane's effort must come from its own review key`,
      );
    } finally {
      cleanup(dir);
      cleanup(projectDir);
    }
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

describe('#2615: the matrix documents the effortSurface axis', () => {
  test('the axes legend defines effortSurface and its vocabulary', () => {
    const legendRow = MATRIX_TEXT.split(/\r?\n/).find((l) => l.startsWith('| `effortSurface` |'));
    assert.ok(legendRow, 'the axes legend must define effortSurface (#2615)');
    for (const member of ['`argv`', '`none`', '`undocumented`']) {
      assert.ok(legendRow.includes(member),
        `the legend must document the ${member} vocabulary member (#2615)`);
    }
  });

  test('there is at least one runtime to check', () => {
    // Guards the loops below against silently asserting nothing.
    assert.ok(MATRIX_RUNTIMES.length >= 18, `expected the full runtime corpus, got ${MATRIX_RUNTIMES.length}`);
  });

  for (const id of MATRIX_RUNTIMES) {
    describe(`runtime: ${id}`, () => {
      test('has a matrix section', () => {
        assert.ok(matrixSection(id), `${id}: every installed runtime needs a matrix section (ADR-1239)`);
      });

      test('documents effortSurface, and the value matches the descriptor', () => {
        const body = matrixSection(id);
        assert.ok(body, `${id}: missing matrix section`);

        const documented = matrixAxisValue(body, 'effortSurface');
        assert.ok(documented, `${id}: the matrix must carry an effortSurface row (#2615)`);

        const declared = registry.runtimes[id].runtime.hostIntegration.effortSurface;
        if (declared === undefined) {
          // kimi-code declares no value: its mechanism (`/effort`) is interactive-only
          // and neither `argv` nor `none` describes it. The matrix must say so rather
          // than invent a value.
          assert.match(documented, /not declared/i,
            `${id}: an absent descriptor value must be documented as absent, not guessed (#2615)`);
        } else {
          assert.equal(documented, declared,
            `${id}: the matrix effortSurface value must match the shipped descriptor`);
        }
      });
    });
  }
});

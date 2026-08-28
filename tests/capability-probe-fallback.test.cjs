'use strict';

/**
 * The capability fragments' probe fallbacks must be honest (#3909, ADR-3889 P5).
 *
 * Two capability fragments carry a shell snippet that runs a detector and
 * captures its JSON. Those snippets used `… 2>/dev/null || echo '{"detected":false}'`,
 * which FABRICATES a negative verdict whenever the probe exits non-zero. That is
 * wrong three separate ways, and all three are covered here:
 *
 *   1. `||` fires on exit 1 — which ADR-3889 P3 made the LEGITIMATE negative —
 *      so a correct "no integration" answer got a second object appended to it.
 *   2. `$( )` captures the whole compound's stdout, so the fallback APPENDS
 *      rather than replaces: an honest `{"skipped":true}` was immediately
 *      contradicted by a fabricated `{"detected":false}` in the same string.
 *   3. A probe that genuinely could not run produced a clean, confident,
 *      wrong `detected:false`.
 *
 * BEHAVIORAL, not source-grep: each test extracts the fragment's own fenced
 * bash block, executes it under `bash` with the surrounding contract stubbed
 * (`gsd_run`, `PHASE_DIR`, `PHASE`), and asserts on the captured variable.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const API_FRAGMENT = path.join(
  REPO_ROOT, 'capabilities', 'ai-integration', 'fragments', 'api-coverage-plan-pre.md');
const DELTA_FRAGMENT = path.join(
  REPO_ROOT, 'capabilities', 'assumption-delta', 'fragments', 'plan-pre.md');
const TOOLS_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

/**
 * Pull the fragment's probe snippet out of its markdown: the first fenced
 * ```bash block that assigns `varName`. The block is returned verbatim so the
 * test executes exactly the bytes the planner is handed.
 */
function extractProbeBlock(fragmentPath, varName) {
  const md = splitLines(fs.readFileSync(fragmentPath, 'utf8'));
  const fences = [];
  let current = null;
  for (const line of md) {
    if (current === null) {
      if (line.trim() === '```bash') {
        current = [];
      }
      continue;
    }
    if (line.trim() === '```') {
      fences.push(current.join('\n'));
      current = null;
      continue;
    }
    current.push(line);
  }
  const block = fences.find((body) => body.includes(`${varName}=`));
  assert.ok(
    block,
    `${path.basename(fragmentPath)} must contain a fenced bash block assigning ${varName}`,
  );
  return block;
}

/**
 * Run a fragment snippet under bash and return the captured variable's value.
 * `prelude` stubs the surrounding workflow contract; `cwd` decides whether the
 * detector module is reachable (an unreachable one is how "the probe could not
 * launch" is simulated — no chmod, no monkeypatch, just a different cwd).
 */
function runSnippet({ block, varName, prelude, cwd }) {
  const script = `set -u\n${prelude}\n${block}\nprintf '%s' "\${${varName}}"\n`;
  const scriptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-frag-')), 'run.sh');
  fs.writeFileSync(scriptFile, script, 'utf8');
  try {
    const r = runNode(['-e', `
      const { spawnSync } = require('node:child_process');
      const r = spawnSync('bash', [process.argv[1]], { cwd: process.argv[2], encoding: 'utf8', timeout: 60000 });
      process.stdout.write(r.stdout || '');
    `, scriptFile, cwd], { cwd, timeoutMs: 60000 });
    assert.strictEqual(r.outcome, OUTCOME.EXITED, `snippet runner outcome: ${r.outcome}`);
    return r.stdout;
  } finally {
    cleanup(path.dirname(scriptFile));
  }
}

/** Assert the captured value is exactly ONE JSON object, and return it. */
function parseSingleObject(captured, what) {
  assert.notStrictEqual(captured.trim(), '', `${what}: the fragment captured nothing at all`);
  let parsed;
  try {
    parsed = JSON.parse(captured);
  } catch (err) {
    assert.fail(
      `${what}: the fragment produced text that is not a single JSON object — ` +
      `a concatenated fallback is exactly this failure. Captured: ${JSON.stringify(captured)} ` +
      `(${err.message})`,
    );
  }
  assert.strictEqual(typeof parsed, 'object', `${what}: payload must be an object`);
  assert.notStrictEqual(parsed, null, `${what}: payload must not be null`);
  return parsed;
}

// ─── api-coverage fragment ────────────────────────────────────────────────────

describe('api-coverage fragment probe fallback is honest (#3909)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  // The fragment's snippet builds SCOPE from `${PHASE_DIR}/*-PLAN.md` plus a
  // `gsd_run query roadmap.get-phase` call. Both are stubbed so the test
  // controls exactly what reaches the detector.
  function preludeFor(planBody) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-apifrag-'));
    if (planBody !== null) {
      fs.writeFileSync(path.join(tmpDir, '01-PLAN.md'), planBody, 'utf8');
    }
    return [
      `PHASE_DIR=${JSON.stringify(tmpDir)}`,
      'PHASE=01',
      'gsd_run() { return 0; }',
    ].join('\n');
  }

  function capture(planBody, { cwd = REPO_ROOT } = {}) {
    return runSnippet({
      block: extractProbeBlock(API_FRAGMENT, 'API_COVERAGE_JSON'),
      varName: 'API_COVERAGE_JSON',
      prelude: preludeFor(planBody),
      cwd,
    });
  }

  test('CONTROL: a scope with API vocabulary captures a detected verdict', () => {
    const j = parseSingleObject(
      capture('# Plan\nIntegrate the Stripe API and wrap its SDK.'), 'detected case');
    assert.strictEqual(j.detected, true);
    assert.strictEqual(j.skipped, undefined);
  });

  test('a LEGITIMATE negative (probe exit 1) is captured as ONE valid object', () => {
    // Regression: the detector exits 1 for a real negative, so `|| echo …`
    // fired on the success path and appended a second object.
    const j = parseSingleObject(
      capture('# Plan\nRefactor the internal state machine.'), 'legit negative');
    assert.strictEqual(j.detected, false, 'a real negative must survive intact');
    assert.strictEqual(j.skipped, undefined, 'a real negative is not a skip');
  });

  test('an HONEST skip (empty scope) is not contradicted by a fabricated verdict', () => {
    const j = parseSingleObject(capture(null), 'empty scope');
    assert.strictEqual(j.skipped, true, 'an unexamined scope must report skipped');
    assert.strictEqual(
      j.detected,
      undefined,
      'the skip must not carry a detected key — that contradiction is the defect',
    );
  });

  test('a probe that CANNOT LAUNCH reports skipped, never detected:false', () => {
    // cwd without the module → node fails, stdout empty. The fragment must not
    // manufacture a verdict from that.
    const away = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-nomodule-'));
    try {
      const j = parseSingleObject(
        capture('# Plan\nIntegrate the Stripe API.', { cwd: away }), 'probe unavailable');
      assert.strictEqual(j.skipped, true, 'a probe that could not run must report skipped');
      assert.strictEqual(j.reason, 'probe_unavailable');
      assert.strictEqual(
        j.detected,
        undefined,
        'asserting detected:false from a probe that never ran is the bug this closes',
      );
    } finally {
      cleanup(away);
    }
  });
});

// ─── assumption-delta fragment ────────────────────────────────────────────────

describe('assumption-delta fragment probe fallback is honest (#3909)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  function projectWithRoadmap(body) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-deltafrag-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    if (body !== null) {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), body, 'utf8');
    }
    return tmpDir;
  }

  // `gsd_run` is the workflow launcher's shell function; stub it to the real
  // CLI so the snippet exercises the genuine query route.
  function realGsdRunPrelude(projectDir) {
    return [
      'PHASE=01',
      `gsd_run() { ( cd ${JSON.stringify(projectDir)} && ` +
        `node ${JSON.stringify(TOOLS_PATH)} "$@" ); }`,
    ].join('\n');
  }

  function capture(prelude) {
    return runSnippet({
      block: extractProbeBlock(DELTA_FRAGMENT, 'ASSUMPTION_DELTA_JSON'),
      varName: 'ASSUMPTION_DELTA_JSON',
      prelude,
      cwd: REPO_ROOT,
    });
  }

  test('CONTROL: a resolved section with a cue captures a detected verdict', () => {
    const dir = projectWithRoadmap(
      '# Roadmap\n\n### Phase 01: Auth\n\nAdd a second authentication method.\n');
    const j = parseSingleObject(capture(realGsdRunPrelude(dir)), 'detected case');
    assert.strictEqual(j.detected, true);
    assert.strictEqual(j.skipped, undefined);
  });

  test('CONTROL: a resolved section with no cue captures ONE valid negative', () => {
    const dir = projectWithRoadmap(
      '# Roadmap\n\n### Phase 01: Cleanup\n\nRefactor the internal state machine.\n');
    const j = parseSingleObject(capture(realGsdRunPrelude(dir)), 'legit negative');
    assert.strictEqual(j.detected, false);
    assert.strictEqual(j.skipped, undefined);
  });

  test('an unresolvable phase captures skipped, not a fabricated negative', () => {
    const dir = projectWithRoadmap(null);
    const j = parseSingleObject(capture(realGsdRunPrelude(dir)), 'unresolved phase');
    assert.strictEqual(j.skipped, true);
    assert.strictEqual(j.detected, undefined);
  });

  test('a probe that CANNOT LAUNCH reports skipped, never detected:false', () => {
    const j = parseSingleObject(
      capture(['PHASE=01', 'gsd_run() { return 127; }'].join('\n')), 'probe unavailable');
    assert.strictEqual(j.skipped, true, 'a launcher that failed must not yield a verdict');
    assert.strictEqual(j.reason, 'probe_unavailable');
    assert.strictEqual(j.detected, undefined);
  });
});

// ─── Parity: one vocabulary across both fragments ─────────────────────────────

describe('both fragments share one skipped-with-reason vocabulary (#3909)', () => {
  // Generative-fix divergence guard: two surfaces adopting one convention must
  // fail this test the moment they drift apart.
  test('both fragments emit the same probe-unavailable reason token', () => {
    const results = [
      { name: 'api-coverage', block: extractProbeBlock(API_FRAGMENT, 'API_COVERAGE_JSON') },
      { name: 'assumption-delta', block: extractProbeBlock(DELTA_FRAGMENT, 'ASSUMPTION_DELTA_JSON') },
    ].map(({ name, block }) => {
      const varName = name === 'api-coverage' ? 'API_COVERAGE_JSON' : 'ASSUMPTION_DELTA_JSON';
      const captured = runSnippet({
        block,
        varName,
        // Force the unavailable path for both: no PHASE_DIR contents, and a
        // launcher/cwd that cannot produce output.
        prelude: [
          'PHASE_DIR=/nonexistent-phase-dir-3909',
          'PHASE=01',
          'gsd_run() { return 127; }',
        ].join('\n'),
        cwd: os.tmpdir(),
      });
      return { name, payload: parseSingleObject(captured, name) };
    });

    for (const { name, payload } of results) {
      assert.strictEqual(payload.skipped, true, `${name} must report skipped when the probe cannot run`);
    }
    assert.strictEqual(
      results[0].payload.reason,
      results[1].payload.reason,
      'the two fragments must not invent different reason tokens for the same condition',
    );
  });
});

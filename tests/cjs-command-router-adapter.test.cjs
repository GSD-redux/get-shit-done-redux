'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { routeCjsCommandFamily, routeHubCommandFamily } = require('../gsd-core/bin/lib/cjs-command-router-adapter.cjs');
const { makeInvalidArgs } = require('../gsd-core/bin/lib/command-routing-hub.cjs');

describe('cjs-command-router-adapter routeHubCommandFamily', () => {
  test('routes known subcommand handler through the hub', () => {
    let calls = 0;
    let errorMessage = null;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'ok'],
      subcommands: ['ok'],
      handlers: {
        ok: () => {
          calls += 1;
        },
      },
      unknownMessage: (subcommand, available) => `Unknown ${subcommand}. Available: ${available.join(', ')}`,
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(calls, 1);
    assert.equal(errorMessage, null);
  });

  test('maps unknown subcommands via unknownMessage and filtered availability', () => {
    let errorMessage = null;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'missing'],
      subcommands: ['ok', 'legacy'],
      unsupported: { legacy: 'legacy disabled' },
      handlers: { ok: () => {} },
      unknownMessage: (subcommand, available) => `Unknown ${subcommand}. Available: ${available.join(', ')}`,
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(errorMessage, 'Unknown missing. Available: ok');
  });

  test('returns unsupported subcommand error before dispatch', () => {
    let errorMessage = null;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'legacy'],
      subcommands: ['ok', 'legacy'],
      unsupported: { legacy: 'legacy disabled' },
      handlers: { ok: () => {} },
      unknownMessage: () => 'should not be used',
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(errorMessage, 'legacy disabled');
  });

  test('projects InvalidArgs result reason via error callback', () => {
    let errorMessage = null;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'invalid'],
      subcommands: ['invalid'],
      handlers: {
        invalid: () => makeInvalidArgs('--phase', '--phase must be an integer'),
      },
      unknownMessage: () => 'should not be used',
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(errorMessage, '--phase must be an integer');
  });

  test('projects InvalidArgs exitReason as second error() arg when present (#1644)', () => {
    let capturedMessage = null;
    let capturedExitReason = null;
    let callCount = 0;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'invalid'],
      subcommands: ['invalid'],
      handlers: {
        invalid: () => makeInvalidArgs('--phase', '--phase must be an integer', 'USAGE'),
      },
      unknownMessage: () => 'should not be used',
      error: (message, exitReason) => {
        callCount += 1;
        capturedMessage = message;
        capturedExitReason = exitReason;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(callCount, 1);
    assert.equal(capturedMessage, '--phase must be an integer',
      `error() message must be the InvalidArgs.reason; got: ${JSON.stringify(capturedMessage)}`);
    assert.equal(capturedExitReason, 'USAGE',
      `error() exitReason must be passed as second arg; got: ${JSON.stringify(capturedExitReason)}`);
  });

  test('omits second error() arg when InvalidArgs has no exitReason (byte-identical with prior behavior)', () => {
    let capturedArgs = null;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'invalid'],
      subcommands: ['invalid'],
      handlers: {
        invalid: () => makeInvalidArgs('--phase', '--phase must be an integer'),
      },
      unknownMessage: () => 'should not be used',
      error: (...args) => {
        capturedArgs = args;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(capturedArgs.length, 1,
      `error() must be called with EXACTLY one arg when exitReason absent (preserve byte-identical prior behavior); got ${capturedArgs.length} args`);
    assert.equal(capturedArgs[0], '--phase must be an integer');
  });

  test('projects thrown handler exceptions as HandlerFailure message', () => {
    let errorMessage = null;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'boom'],
      subcommands: ['boom'],
      handlers: {
        boom: () => {
          throw new Error('boom');
        },
      },
      unknownMessage: () => 'should not be used',
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(errorMessage, 'boom');
  });
});

describe('cjs-command-router-adapter routeCjsCommandFamily', () => {
  test('routes known subcommand handler via the legacy adapter', () => {
    let calls = 0;
    let errorMessage = null;

    routeCjsCommandFamily({
      args: ['unit', 'ok'],
      subcommands: ['ok'],
      handlers: {
        ok: () => {
          calls += 1;
        },
      },
      unknownMessage: (subcommand, available) => `Unknown ${subcommand}. Available: ${available.join(', ')}`,
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(calls, 1);
    assert.equal(errorMessage, null);
  });

  test('honors defaultSubcommand when args[1] is absent', () => {
    let calls = 0;
    let errorMessage = null;

    routeCjsCommandFamily({
      args: ['unit'],
      subcommands: ['load'],
      defaultSubcommand: 'load',
      handlers: {
        load: () => {
          calls += 1;
        },
      },
      unknownMessage: (subcommand, available) => `Unknown ${subcommand}. Available: ${available.join(', ')}`,
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(calls, 1);
    assert.equal(errorMessage, null);
  });

  test('converts thrown handler exceptions into error callback messages', () => {
    let errorMessage = null;

    routeCjsCommandFamily({
      args: ['unit', 'boom'],
      subcommands: ['boom'],
      handlers: {
        boom: () => {
          throw new Error('boom');
        },
      },
      unknownMessage: () => 'should not be used',
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(errorMessage, 'boom');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-224-pick-stdout-capture.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-224-pick-stdout-capture (consolidation epic #1969 B2 #1971)", () => {
// allow-test-rule: structural-implementation-guard (see #224)
// Bug #224 is a platform-specific (Node 24 + Windows) flake in `--pick` where
// stdout interception can produce non-deterministic failures. We lock the seam
// contract structurally until we have a deterministic Windows reproduction
// harness in CI.

'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools } = require('./helpers.cjs');

const GSD_TOOLS_SRC = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

describe('bug #224: --pick stdout capture contract', () => {
  let src;

  before(() => {
    src = fs.readFileSync(GSD_TOOLS_SRC, 'utf-8');
  });

  test('--pick output still succeeds for current-timestamp command', () => {
    const result = runGsdTools(['current-timestamp', '--pick', 'timestamp']);
    assert.strictEqual(result.success, true, result.error || 'expected command to succeed');
    assert.match(result.output, /^\d{4}-\d{2}-\d{2}T/, 'expected ISO timestamp output');
  });

  test('stdout interception for fd=1 returns a byte count (never undefined)', () => {
    const mainStart = src.indexOf('async function main()');
    assert.ok(mainStart !== -1, 'main() must exist');
    const mainSrc = src.slice(mainStart);

    assert.ok(
      mainSrc.includes('Buffer.byteLength(') || mainSrc.includes('return data.length'),
      'stdout interception must return written-byte counts for fd=1 captures'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3243-dotted-command-form.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3243-dotted-command-form (consolidation epic #1969 B2 #1971)", () => {
/**
 * Regression tests for bug #3243.
 *
 * The CJS dispatcher (gsd-tools.cjs) must accept dotted canonical command
 * form (e.g. `state.update`) as well as the spaced form (`state update`).
 * Workflow markdown files emit `gsd-sdk query <domain>.<subcommand>` calls,
 * and any caller that bypasses the SDK (stale npm binary, direct shell-out,
 * third-party script) would hit "Unknown command: <domain>.<subcommand>".
 *
 * The fix: a top-of-main() shim that splits args[0] on the first `.` when
 * present and normalizes to the spaced form before the switch is reached.
 *
 * This test file uses runGsdTools() — never readFileSync + .includes().
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('bug #3243: CJS dispatcher accepts dotted canonical command form', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── generate-slug: no project structure needed, deterministic output ────

  test('generate-slug.hello-world (dotted) produces the same slug as spaced form', () => {
    const spaced = runGsdTools(['generate-slug', 'hello-world'], tmpDir);
    assert.strictEqual(spaced.success, true, [
      'control (spaced form) failed:',
      spaced.error,
    ].join(' '));

    const dotted = runGsdTools(['generate-slug.hello-world'], tmpDir);
    // Before the fix this errors: "Unknown command: generate-slug.hello-world"
    assert.strictEqual(dotted.success, true, [
      'dotted form must not emit "Unknown command":',
      dotted.error,
    ].join(' '));
    assert.strictEqual(dotted.output, spaced.output,
      'dotted form must produce identical output to spaced form');
  });

  test('current-timestamp.date (dotted) produces the same output as spaced form', () => {
    const spaced = runGsdTools(['current-timestamp', 'date'], tmpDir);
    assert.strictEqual(spaced.success, true, [
      'control (spaced form) failed:',
      spaced.error,
    ].join(' '));

    const dotted = runGsdTools(['current-timestamp.date'], tmpDir);
    assert.strictEqual(dotted.success, true, [
      'dotted form must not emit "Unknown command":',
      dotted.error,
    ].join(' '));
    assert.strictEqual(dotted.output, spaced.output,
      'dotted form must produce identical output to spaced form');
  });

  // ── Commands with subcommands that need a project ────────────────────────

  test('validate.plan (dotted) routes into validate handler, not "Unknown command"', () => {
    const dotted = runGsdTools(['validate.plan'], tmpDir);
    // Before the fix: success=false, error contains "Unknown command: validate.plan"
    // After the fix: success=false is still possible (validate needs a PLAN.md),
    // but the error must NOT mention "Unknown command".
    const errText = dotted.error || '';
    assert.ok(
      !errText.includes('Unknown command: validate.plan'),
      [
        'dotted form must not produce "Unknown command: validate.plan".',
        'Got error:', errText,
      ].join('\n')
    );
  });

  test('roadmap.analyze (dotted) routes into roadmap handler, not "Unknown command"', () => {
    const dotted = runGsdTools(['roadmap.analyze'], tmpDir);
    // success=true means it reached the handler (even if handler reports no ROADMAP.md).
    // success=false means dispatcher rejected it — assert the error is NOT "Unknown command".
    const errText = dotted.error || '';
    assert.ok(
      !errText.includes('Unknown command: roadmap.analyze'),
      [
        'dotted form must not produce "Unknown command: roadmap.analyze".',
        'Got error:', errText,
      ].join('\n')
    );
  });

  test('phases.list (dotted) routes into phases handler, not "Unknown command"', () => {
    const dotted = runGsdTools(['phases.list'], tmpDir);
    const errText = dotted.error || '';
    assert.ok(
      !errText.includes('Unknown command: phases.list'),
      [
        'dotted form must not produce "Unknown command: phases.list".',
        'Got error:', errText,
      ].join('\n')
    );
  });

  // ── Multi-dot commands: split on first dot only ──────────────────────────

  test('check.decision-coverage-plan (multi-dot-safe: first dot splits)', () => {
    const dotted = runGsdTools(['check.decision-coverage-plan'], tmpDir);
    // "check" is not a known top-level command currently, so this will still
    // fail — but the error must NOT say "Unknown command: check.decision-coverage-plan"
    // (the dotted form); it should say something about "check" (the split result).
    const errText = dotted.error || '';
    assert.ok(
      !errText.includes('Unknown command: check.decision-coverage-plan'),
      [
        'multi-dot dotted form must not be passed verbatim to "Unknown command".',
        'Got error:', errText,
      ].join('\n')
    );
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  test('command without dots is unchanged (existing behaviour preserved)', () => {
    const result = runGsdTools(['generate-slug', 'no-dots-here'], tmpDir);
    assert.strictEqual(result.success, true, [
      'spaced-only invocation must still work:',
      result.error,
    ].join(' '));
    assert.ok(result.output.length > 0, 'output must be non-empty');
  });

  test('leading-dot arg (e.g. .hidden) is not mis-routed by the shim', () => {
    // A leading dot in args[0] like ".hidden" has head="" (empty) after split,
    // so the shim must reject it and fall through to the existing "Unknown command"
    // path (not silently reroute to an empty-string command).
    const result = runGsdTools(['.hidden'], tmpDir);
    assert.strictEqual(result.success, false, 'leading-dot arg must not succeed');
  });

  // ── "Unknown command" error message improvement ──────────────────────────

  test('"Unknown command" error for dotted form suggests spaced equivalent', () => {
    // A genuinely unknown dotted command (e.g. "foo.bar") should include a
    // "did you mean" hint pointing at the spaced form "foo bar".
    const result = runGsdTools(['foo.bar'], tmpDir);
    assert.strictEqual(result.success, false, '"foo.bar" must fail');
    assert.ok(
      result.error.includes('foo bar'),
      [
        'error for unknown dotted command should suggest spaced form "foo bar".',
        'Got:', result.error,
      ].join('\n')
    );
  });

  test('multi-dot unknown command suggestion uses first-dot split only (a.b.c → "a b.c")', () => {
    // The shim splits only on the FIRST dot, so the suggestion must mirror that:
    // "a.b.c" → head="a", rest="b.c" → suggest "a b.c", NOT "a b c".
    const result = runGsdTools(['a.b.c'], tmpDir);
    assert.strictEqual(result.success, false, '"a.b.c" must fail');
    assert.ok(
      result.error.includes('a b.c'),
      [
        'suggestion for multi-dot unknown command must use first-dot split: "a b.c".',
        'Got:', result.error,
      ].join('\n')
    );
    assert.ok(
      !result.error.includes('a b c'),
      [
        'suggestion must NOT replace all dots ("a b c" is wrong — only first dot splits).',
        'Got:', result.error,
      ].join('\n')
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3631-router-raw-flag.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3631-router-raw-flag (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression tests for #3631 — SDK dispatch path in family routers must
 * forward the `--raw` flag through to `output()`.
 *
 * Before the fix, every `*-command-router.cjs` `sdkHandler` called
 * `output(result.data)` without the second positional `raw` argument or the
 * third positional `rawValue`. With `--raw` set, the SDK path therefore
 * emitted JSON-stringified data ({"next":"2.1",...}) instead of the scalar
 * the CJS path used to print (e.g. `2.1`).
 *
 * Both tests below exercise the live SDK path:
 *   1. `phase next-decimal --raw <base>` must emit the next-decimal token.
 *   2. `roadmap get-phase --raw <id>` must emit the phase's roadmap section.
 *
 * Per CONTRIBUTING.md: assertions are on structured (scalar) tokens, not
 * substring grep against full JSON.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const GSD_TOOLS = path.resolve(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

function run(args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync(process.execPath, [GSD_TOOLS, ...args], {
        cwd,
        encoding: 'utf-8',
        timeout: 15000,
      }),
    };
  } catch (e) {
    return {
      ok: false,
      stdout: (e.stdout && e.stdout.toString()) || '',
      stderr: (e.stderr && e.stderr.toString()) || '',
      code: e.status,
    };
  }
}

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3631-'));
  const planning = path.join(tmp, '.planning');
  fs.mkdirSync(path.join(planning, 'phases'), { recursive: true });
  fs.writeFileSync(
    path.join(planning, 'ROADMAP.md'),
    [
      '# Project Roadmap',
      '',
      '## v1',
      '',
      '### Phase 1: First',
      '',
      'Body of phase 1.',
      '',
      '### Phase 2: Second',
      '',
      'Body of phase 2.',
      '',
    ].join('\n')
  );
  // PROJECT.md anchors the planning root for callers that resolve it.
  fs.writeFileSync(path.join(planning, 'PROJECT.md'), '# Test\n');
  return tmp;
}

describe('bug #3631 — SDK family routers forward --raw to output()', () => {
  test('phase next-decimal --raw emits the scalar next-decimal token (not JSON)', () => {
    const tmp = makeFixture();
    try {
      const res = run(['phase', 'next-decimal', '--raw', '1'], tmp);
      assert.ok(
        res.ok,
        `command must succeed; got code=${res.code} stderr=${res.stderr}`
      );
      const trimmed = res.stdout.trim();
      // Scalar form — must be a phase id token like "1.1", not a JSON object.
      assert.doesNotMatch(
        trimmed,
        /^\{/,
        `--raw must not emit JSON; got: ${trimmed}`
      );
      assert.match(
        trimmed,
        /^0*\d+(?:\.\d+)?$/,
        `--raw must emit a scalar phase id; got: ${trimmed}`
      );
      // SDK and CJS both normalize the base phase before computing the next-
      // decimal token; CJS emits "1.1" while SDK normalizes "1"→"01" and emits
      // "01.1". Both are valid scalar projections — assert on parity with the
      // computed-next semantics rather than the exact padding form.
      assert.ok(
        trimmed === '1.1' || trimmed === '01.1',
        `expected next-decimal of base "1" to be 1.1 or 01.1; got: ${trimmed}`
      );
    } finally {
      cleanup(tmp);
    }
  });

  test('roadmap get-phase --raw emits the phase section (not JSON)', () => {
    const tmp = makeFixture();
    try {
      const res = run(['roadmap', 'get-phase', '--raw', '2'], tmp);
      assert.ok(
        res.ok,
        `command must succeed; got code=${res.code} stderr=${res.stderr}`
      );
      const trimmed = res.stdout.trim();
      assert.doesNotMatch(
        trimmed,
        /^\{/,
        `--raw must not emit JSON; got: ${trimmed.slice(0, 80)}`
      );
      // Section text starts with the heading.
      assert.match(
        trimmed,
        /Phase 2:\s*Second/,
        `--raw must emit the section body containing the Phase 2 heading; got: ${trimmed.slice(0, 80)}`
      );
    } finally {
      cleanup(tmp);
    }
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Regression for #2620 — the live adapter must inject a real DispatchLogger
// (ADR-0174 §6: "DispatchLogger is injected; the Hub emits DispatchEvent on
// every dispatch path"). Before the fix, routeHubCommandFamily built the Hub
// with no logger, so it fell back to createNoOpLogger and GSD_AUDIT was inert.
// ────────────────────────────────────────────────────────────────────────
{
  const { describe, test } = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { routeHubCommandFamily } = require('../gsd-core/bin/lib/cjs-command-router-adapter.cjs');
  const { createTempDir, cleanup } = require('./helpers.cjs');

  describe('cjs-command-router-adapter — observability logger wiring (#2620)', () => {
    test('a dispatch through the live adapter writes the opt-in audit trail when GSD_AUDIT=1', (t) => {
      const tmp = createTempDir('gsd-obs-wire-');
      const prev = process.env.GSD_AUDIT;
      t.after(() => {
        if (prev === undefined) delete process.env.GSD_AUDIT;
        else process.env.GSD_AUDIT = prev;
        cleanup(tmp);
      });
      process.env.GSD_AUDIT = '1';

      routeHubCommandFamily({
        family: 'unit',
        args: ['unit', 'ok'],
        subcommands: ['ok'],
        handlers: { ok: () => {} },
        unknownMessage: (subcommand, available) => `Unknown ${subcommand}. Available: ${available.join(', ')}`,
        error: () => {},
        cwd: tmp,
        raw: false,
      });

      const auditPath = path.join(tmp, '.planning', '.gsd-trace.jsonl');
      assert.ok(
        fs.existsSync(auditPath),
        'GSD_AUDIT=1 must produce .planning/.gsd-trace.jsonl — the adapter must build the Hub with a real DispatchLogger (ADR-0174 §6), not createNoOpLogger'
      );
      const lines = fs.readFileSync(auditPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      assert.ok(lines.length > 0, 'at least one dispatch event must be recorded');
      assert.equal(lines.length, 1, 'exactly one dispatch event must be recorded');
      const event = JSON.parse(lines[0]);
      assert.equal(event.result.kind, 'ok', 'a successful dispatch is recorded with result.kind === "ok"');
      assert.ok(typeof event.command === 'string' && event.command.length > 0, 'event carries the dispatched command');
      assert.ok(typeof event.traceId === 'string' && event.traceId.length > 0, 'event carries a traceId');
      assert.ok(typeof event.timestamp === 'string' && event.timestamp.length > 0, 'event carries an ISO timestamp');
    });
  });
}

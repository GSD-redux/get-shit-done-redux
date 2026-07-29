/**
 * Tests for config-get --default flag (#1893)
 *
 * When --default <value> is passed, config-get should return the default
 * value (exit 0) instead of erroring (exit 1) when the key is absent.
 * When the key IS present, --default should be ignored and the real value
 * returned.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanup } = require('./helpers.cjs');

// In-process invocation, not execFileSync: cmdConfigGet is a pure CJS
// function reachable without spawning `node` as a child. The prior
// execFileSync(..., { timeout: 5000 }) raced a real subprocess's startup
// (full node boot + gsd-tools.cjs's large eager require graph — capability
// registry, phase/roadmap/agent/check/task routers, verify.cjs,
// cli-skew-check, findProjectRoot, etc.) against a fixed 5s wall clock, with
// no retry. Under Docker host contention that wall clock loses
// nondeterministically (ETIMEDOUT) — a test-harness race, not a product
// defect. bin/lib/config.cjs requires none of that dispatcher machinery, so
// calling cmdConfigGet directly removes the subprocess-spawn cost and the
// wall-clock race entirely: no timeout of any size can flake this.
const config = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'config.cjs'));
// io.cjs owns error()/output() and the JSON-error-mode toggle. cmdConfigGet's `error`
// is bound to io.error at load, so we drive io directly to (a) get structured stderr
// we can assert a typed `reason` on, and (b) restore the mode after each error probe.
const io = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'io.cjs'));

/**
 * cmdConfigGet's error() path (gsd-core/bin/lib/io.cjs) calls process.exit(1)
 * directly (it predates the ExitError/runMain seam used by the CLI
 * entrypoint's non-error paths). Intercepting process.exit with a throwable
 * sentinel lets the error path be exercised in-process without killing the
 * test worker.
 *
 * The sentinel carries the ORIGINAL error message (not a generic "process.exit(1)").
 * That matters for cmdConfigGet's "no config.json" branch, whose `error()` sits inside
 * a try/catch that reclassifies any throw NOT starting with "No config.json" as a parse
 * failure (a guard that is dead in production, where process.exit terminates first, but
 * becomes live once process.exit is a throwing seam). Carrying the real message makes
 * that guard re-throw — modeling the single, faithful production termination instead of
 * a spurious second error() call with the wrong reason.
 */
class _ExitSignal extends Error {
  constructor(code, message) {
    super(message ?? `process.exit(${code})`);
    this.code = code;
  }
}

/**
 * bin/lib/io.cjs's output()/error() write directly to the raw fd (1 or 2)
 * via fs.writeSync — they bypass console.log entirely, so
 * tests/helpers.cjs's captureConsole() cannot observe them (see
 * tests/io.test.cjs: "output() writes directly to fd 1"). Monkeypatch
 * fs.writeSync itself — save the original, override, restore in a finally,
 * the project's standard IO capture/fault-injection seam — to capture what
 * would have hit the fd.
 */
function captureFdWrite(fd, fn) {
  const orig = fs.writeSync;
  let captured = Buffer.alloc(0);
  fs.writeSync = (writeFd, ...rest) => {
    if (writeFd !== fd) return orig.call(fs, writeFd, ...rest);
    const [data, offset = 0, length] = rest;
    const chunk = Buffer.isBuffer(data)
      ? data.subarray(offset, offset + (length ?? data.length - offset))
      : Buffer.from(String(data), 'utf8');
    captured = Buffer.concat([captured, chunk]);
    return chunk.length;
  };
  try {
    fn();
  } finally {
    fs.writeSync = orig;
  }
  return captured.toString('utf-8');
}

/**
 * Parse a CLI-style config-get argv (mirrors gsd-core/bin/gsd-tools.cjs's
 * 'config-get' case: key is args[1], optional --default <value>, optional
 * --raw) into cmdConfigGet's positional params. Keeps the test bodies below
 * expressed in the same CLI-args vocabulary they always were.
 */
function parseConfigGetArgs(args) {
  const rest = args.slice(1); // drop the leading 'config-get'
  let raw = false;
  let defaultValue;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--raw') { raw = true; continue; }
    if (rest[i] === '--default') { defaultValue = rest[i + 1] ?? ''; i++; continue; }
    positional.push(rest[i]);
  }
  return { keyPath: positional[0], raw, defaultValue };
}

describe('config-get --default flag (#1893)', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-config-default-'));
    planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function run(...args) {
    const { keyPath, raw, defaultValue } = parseConfigGetArgs(args);
    const out = captureFdWrite(1, () => {
      config.cmdConfigGet(tmpDir, keyPath, raw, defaultValue);
    });
    return out.trim();
  }

  function runRaw(...args) {
    return run(...args, '--raw');
  }

  function runExpectError(...args) {
    const { keyPath, raw, defaultValue } = parseConfigGetArgs(args);
    const origExit = process.exit;
    const origWriteSync = fs.writeSync;
    io.setJsonErrorMode(true); // structured stderr line lets the sentinel carry the message + assert reason
    let exitCount = 0;
    let exitCode;
    let stderr = '';
    fs.writeSync = (fd, ...rest) => {
      if (fd !== 2) return origWriteSync.call(fs, fd, ...rest);
      const [data, offset = 0, length] = rest;
      const chunk = Buffer.isBuffer(data)
        ? data.subarray(offset, offset + (length ?? data.length - offset)).toString('utf8')
        : String(data);
      stderr += chunk;
      return Buffer.byteLength(chunk);
    };
    const lastError = () => {
      const parts = stderr.split('\n').filter(Boolean);
      try { return JSON.parse(parts[parts.length - 1]); } catch { return {}; }
    };
    process.exit = (code) => {
      exitCount++;
      exitCode = code;
      // Carry the just-emitted error message so cmdConfigGet's seam guard re-throws
      // (single, faithful fire) instead of catching + reclassifying into a 2nd error().
      throw new _ExitSignal(code, lastError().message);
    };
    try {
      config.cmdConfigGet(tmpDir, keyPath, raw, defaultValue);
    } catch (e) {
      if (!(e instanceof _ExitSignal)) throw e;
    } finally {
      process.exit = origExit;
      fs.writeSync = origWriteSync;
      io.setJsonErrorMode(false);
    }
    assert.ok(exitCode !== 0 && exitCode !== undefined, 'Expected non-zero exit code');
    // Faithfulness guard: production process.exit terminates, so error() fires exactly
    // once. A count of 2 means the throwing-exit seam was caught + reclassified (the bug
    // this harness redesign fixes) — fail loudly rather than report a wrong reason.
    assert.equal(exitCount, 1, 'error() must fire exactly once (production process.exit terminates)');
    const payload = lastError();
    return { status: exitCode, reason: payload.reason, message: payload.message, stderr };
  }

  test('absent key without --default errors', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}');
    const { reason } = runExpectError('config-get', 'nonexistent.key', '--raw');
    assert.equal(reason, io.ERROR_REASON.CONFIG_KEY_NOT_FOUND, 'absent key must report CONFIG_KEY_NOT_FOUND');
  });

  test('absent key with --default returns default value', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}');
    const result = runRaw('config-get', 'nonexistent.key', '--default', 'fallback');
    assert.equal(result, 'fallback');
  });

  test('absent key with --default "" returns empty string', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}');
    const result = runRaw('config-get', 'nonexistent.key', '--default', '');
    assert.equal(result, '');
  });

  test('present key with --default returns real value (ignores default)', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({
      workflow: { discuss_mode: 'adaptive' }
    }));
    const result = runRaw('config-get', 'workflow.discuss_mode', '--default', 'ignored');
    assert.equal(result, 'adaptive');
  });

  test('nested absent key with --default returns default', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({
      workflow: {}
    }));
    const result = runRaw('config-get', 'workflow.deep.missing.key', '--default', 'safe');
    assert.equal(result, 'safe');
  });

  test('missing config.json with --default returns default', () => {
    // No config.json written
    const result = runRaw('config-get', 'any.key', '--default', 'no-config');
    assert.equal(result, 'no-config');
  });

  test('missing config.json without --default errors', () => {
    // No config.json written
    const { reason } = runExpectError('config-get', 'any.key', '--raw');
    assert.equal(reason, io.ERROR_REASON.CONFIG_NO_FILE, 'missing config.json must report CONFIG_NO_FILE');
  });

  test('--default works with JSON output (no --raw)', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}');
    const result = run('config-get', 'missing.key', '--default', 'json-test');
    const parsed = JSON.parse(result);
    assert.equal(parsed, 'json-test');
  });
});

// ────────────────────────────────────────────────────────────────────────
// #2256 — config-get was blind to capability-registry configSchema defaults.
//
// cmdConfigGet's three absent-key branches (no-config-file, mid-traversal
// non-object, final-undefined) only consulted the 4-key SCHEMA_DEFAULTS map
// before erroring "Key not found". The capability registry declares ~42
// configSchema defaults (e.g. workflow.security_enforcement -> true) that
// resolveConfigKey's Level 4 (capability-activation.cts) already honors at
// runtime — so `query config-get` could disagree with the runtime about the
// effective value of an absent key. Fix: cmdConfigGet now also consults
// getCapabilityConfigSchema(cwd) via a resolveSchemaDefault() helper before
// erroring.
// ────────────────────────────────────────────────────────────────────────
{
  const configSchemaMod = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'config-schema.cjs'));
  // Repo idiom for property tests (matches config-schema.property.test.cjs):
  // require the shared seeded/bounded wrapper, not bare 'fast-check', so this
  // property run is deterministic across CI (seed 42) rather than fuzzing with
  // a fresh random seed on every invocation.
  const fc = require('./helpers/fast-check-setup.cjs');

  describe('config-get registry configSchema defaults (#2256)', () => {
    let tmpDir;
    let planningDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-config-2256-'));
      planningDir = path.join(tmpDir, '.planning');
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    function run(...args) {
      const { keyPath, raw, defaultValue } = parseConfigGetArgs(args);
      const out = captureFdWrite(1, () => {
        config.cmdConfigGet(tmpDir, keyPath, raw, defaultValue);
      });
      return out.trim();
    }

    function runRaw(...args) {
      return run(...args, '--raw');
    }

    function runExpectError(...args) {
      const { keyPath, raw, defaultValue } = parseConfigGetArgs(args);
      const origExit = process.exit;
      const origWriteSync = fs.writeSync;
      io.setJsonErrorMode(true);
      let exitCount = 0;
      let exitCode;
      let stderr = '';
      fs.writeSync = (fd, ...rest) => {
        if (fd !== 2) return origWriteSync.call(fs, fd, ...rest);
        const [data, offset = 0, length] = rest;
        const chunk = Buffer.isBuffer(data)
          ? data.subarray(offset, offset + (length ?? data.length - offset)).toString('utf8')
          : String(data);
        stderr += chunk;
        return Buffer.byteLength(chunk);
      };
      const lastError = () => {
        const parts = stderr.split('\n').filter(Boolean);
        try { return JSON.parse(parts[parts.length - 1]); } catch { return {}; }
      };
      process.exit = (code) => {
        exitCount++;
        exitCode = code;
        throw new _ExitSignal(code, lastError().message);
      };
      try {
        config.cmdConfigGet(tmpDir, keyPath, raw, defaultValue);
      } catch (e) {
        if (!(e instanceof _ExitSignal)) throw e;
      } finally {
        process.exit = origExit;
        fs.writeSync = origWriteSync;
        io.setJsonErrorMode(false);
      }
      assert.ok(exitCode !== 0 && exitCode !== undefined, 'Expected non-zero exit code');
      assert.equal(exitCount, 1, 'error() must fire exactly once (production process.exit terminates)');
      const payload = lastError();
      return { status: exitCode, reason: payload.reason, message: payload.message, stderr };
    }

    // Pull the real registry defaults instead of hardcoding a guess, so this
    // test tracks the registry rather than pinning a stale snapshot of it.
    const capSchema = configSchemaMod.getCapabilityConfigSchema();
    const securityEnforcementDefault = capSchema['workflow.security_enforcement']?.default;
    const securityBlockOnDefault = capSchema['workflow.security_block_on']?.default;
    const securityAsvsLevelDefault = capSchema['workflow.security_asvs_level']?.default;

    test('primary: no config.json — registry-defaulted boolean key resolves via --raw (not "Key not found")', () => {
      // No .planning dir at all — the no-config-file branch (branch 1).
      assert.equal(fs.existsSync(planningDir), false, 'pre-check: no .planning dir');
      assert.equal(securityEnforcementDefault, true, 'pre-check: registry default for workflow.security_enforcement is true');
      const result = runRaw('config-get', 'workflow.security_enforcement');
      assert.equal(result, 'true', 'must return the registry default, not error');
    });

    test('no config.json — registry-defaulted enum key resolves to its registry default', () => {
      assert.equal(fs.existsSync(planningDir), false, 'pre-check: no .planning dir');
      assert.equal(typeof securityBlockOnDefault, 'string');
      const result = runRaw('config-get', 'workflow.security_block_on');
      assert.equal(result, securityBlockOnDefault);
    });

    test('no config.json — registry-defaulted number key resolves to its registry default', () => {
      assert.equal(fs.existsSync(planningDir), false, 'pre-check: no .planning dir');
      assert.equal(typeof securityAsvsLevelDefault, 'number');
      const result = runRaw('config-get', 'workflow.security_asvs_level');
      assert.equal(result, String(securityAsvsLevelDefault));
    });

    test('config.json exists but key is absent after full traversal — registry default still resolves (final-undefined branch)', () => {
      // keys = ['workflow', 'security_enforcement']. First segment traverses
      // into a real object ({ auto_advance: false }); the second segment is
      // simply absent from it, so the loop completes and `current` comes out
      // undefined — this is the FINAL-undefined branch (branch 3), not
      // mid-traversal (branch 2 fires only when an INTERMEDIATE segment is a
      // non-object scalar; see the dedicated mid-traversal test below).
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(
        path.join(planningDir, 'config.json'),
        JSON.stringify({ workflow: { auto_advance: false } }),
      );
      const result = runRaw('config-get', 'workflow.security_enforcement');
      assert.equal(result, 'true');
    });

    test('config.json has a non-object intermediate segment — registry default still resolves (true mid-traversal branch)', () => {
      // keys = ['workflow', 'security_enforcement']. `workflow` itself is a
      // boolean scalar, not an object, so the SECOND loop iteration's guard
      // (`typeof current !== 'object'`) fires before any further descent —
      // this is the genuine mid-traversal branch (branch 2).
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(
        path.join(planningDir, 'config.json'),
        JSON.stringify({ workflow: true }),
      );
      const result = runRaw('config-get', 'workflow.security_enforcement');
      assert.equal(result, 'true');
    });

    test('legacy SCHEMA_DEFAULTS key still resolves unchanged (context_window -> 200000)', () => {
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(
        path.join(planningDir, 'config.json'),
        JSON.stringify({ workflow: { auto_advance: false } }),
      );
      const result = runRaw('config-get', 'context_window');
      assert.equal(result, '200000');
    });

    test('--default flag still wins over the registry default for an absent registry key', () => {
      const result = runRaw('config-get', 'workflow.security_enforcement', '--default', 'flag-wins');
      assert.equal(result, 'flag-wins');
    });

    test('a genuinely unknown, non-registry, non-legacy key still errors "Key not found" (rc1) when config.json exists', () => {
      // config.json must exist here: with NO config.json, cmdConfigGet's
      // no-config-file branch fires first and reports CONFIG_NO_FILE before
      // ever reaching the traversal path's CONFIG_KEY_NOT_FOUND check (see
      // the dedicated no-config-file test below for that branch). Writing a
      // config.json here routes the unknown key through the real traversal
      // path so this test actually exercises "unknown key found not
      // permissive", not "no config file yet".
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(
        path.join(planningDir, 'config.json'),
        JSON.stringify({ workflow: { auto_advance: true } }),
      );
      const { status, reason } = runExpectError('config-get', 'nonsense.totally_made_up_key', '--raw');
      assert.equal(status, 1);
      assert.equal(reason, io.ERROR_REASON.CONFIG_KEY_NOT_FOUND, 'unknown key must not become permissive');
    });

    test('a genuinely unknown, non-registry, non-legacy key with NO config.json errors "No config.json found" (rc1)', () => {
      // Pins the actual (distinct) behavior of the no-config-file branch:
      // an unrecognized key with no config file at all legitimately reports
      // CONFIG_NO_FILE — it never reaches the CONFIG_KEY_NOT_FOUND check,
      // because that check lives in the traversal path which only runs once
      // a config object exists (or a default/schema-default short-circuits
      // first). A registry-defaulted key in this same no-file scenario
      // instead resolves its default (see the "primary" test above) — the
      // two behaviors are complementary and both worth locking in.
      assert.equal(fs.existsSync(planningDir), false, 'pre-check: no .planning dir');
      const { status, reason } = runExpectError('config-get', 'nonsense.totally_made_up_key', '--raw');
      assert.equal(status, 1);
      assert.equal(reason, io.ERROR_REASON.CONFIG_NO_FILE, 'no config file at all must report CONFIG_NO_FILE');
    });

    // ── Prototype-pollution guard: bracket-access traversal on a plain
    // object walks the JS prototype chain, so an unqualified `current[key]`
    // could resolve '__proto__' / 'constructor' / 'hasOwnProperty' to their
    // inherited Object.prototype values instead of correctly reporting them
    // absent. cmdConfigGet's traversal loop gates each descent on
    // Object.prototype.hasOwnProperty.call(current, key) precisely to close
    // this off; these tests pin that it stays closed.
    for (const protoKey of ['__proto__', 'constructor']) {
      test(`config-get ${protoKey} with no config.json errors safely (does not resolve Object.prototype/Function)`, () => {
        assert.equal(fs.existsSync(planningDir), false, 'pre-check: no .planning dir');
        const { status, reason } = runExpectError('config-get', protoKey, '--raw');
        assert.equal(status, 1);
        // No config.json at all -> the no-config-file branch fires first
        // (same as any other absent, non-registry key); the important
        // invariant is that it errors rc1 and never leaks a prototype
        // object/function representation at rc0.
        assert.equal(reason, io.ERROR_REASON.CONFIG_NO_FILE);
      });

      test(`config-get ${protoKey} with config.json present errors "Key not found" (does not walk the prototype chain)`, () => {
        fs.mkdirSync(planningDir, { recursive: true });
        fs.writeFileSync(
          path.join(planningDir, 'config.json'),
          JSON.stringify({ workflow: { auto_advance: true } }),
        );
        const { status, reason } = runExpectError('config-get', protoKey, '--raw');
        assert.equal(status, 1);
        assert.equal(reason, io.ERROR_REASON.CONFIG_KEY_NOT_FOUND,
          `${protoKey} must not resolve via the prototype chain`);
      });
    }

    test('config-get hasOwnProperty (a nested Object.prototype method name) errors "Key not found", not the inherited function', () => {
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(
        path.join(planningDir, 'config.json'),
        JSON.stringify({ workflow: { auto_advance: true } }),
      );
      const { status, reason } = runExpectError('config-get', 'hasOwnProperty', '--raw');
      assert.equal(status, 1);
      assert.equal(reason, io.ERROR_REASON.CONFIG_KEY_NOT_FOUND);
    });

    // ── Secret-masking on the resolved-default path (finding #4). No
    // first-party registry key is both secret-named and schema-defaulted,
    // and getCapabilityConfigSchema(cwd) is not fixture-injectable from a
    // black-box test (it composes from real installed-capability discovery
    // under `cwd`, not a seam this test can substitute). The reachable,
    // faithful-to-production seam is `--default` on a secret-named key path:
    // cmdConfigGet's `hasDefault` branches sit in the exact same absent-key
    // position as the resolveSchemaDefault() branches and must apply the
    // identical isSecretKey()/maskSecret() masking — this exercises that the
    // masking invariant is real and observable at the CLI-args level, not
    // merely aspirational in the resolveSchemaDefault plumbing.
    test('secret-named key resolved via --default is masked, not echoed in plaintext', () => {
      // 'brave_search' is a real entry in SECRET_CONFIG_KEYS (src/secrets.cts) —
      // the same isSecretKey() gate emitResolvedDefault() applies.
      const result = runRaw('config-get', 'brave_search', '--default', 'sk-plaintext-should-not-leak');
      assert.notEqual(result, 'sk-plaintext-should-not-leak', 'a secret-named key must never echo its raw value');
      assert.match(result, /\*/, 'masked secret output should contain masking characters');
    });

    // ── Property test: dotted-key traversal safety contract ────────────────
    //
    // Runs cmdConfigGet fully in-process against an ISOLATED temp dir created
    // fresh for every fc run (unique mkdtemp per run body, cleaned up in a
    // finally — no shared/leaked state across runs).
    function runInProcessAt(dir, keyPath) {
      const origExit = process.exit;
      const origWriteSync = fs.writeSync;
      io.setJsonErrorMode(true);
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      let exited = false;
      fs.writeSync = (fd, ...rest) => {
        const [data, offset = 0, length] = rest;
        const chunk = Buffer.isBuffer(data)
          ? data.subarray(offset, offset + (length ?? data.length - offset)).toString('utf8')
          : String(data);
        if (fd === 1) stdout += chunk;
        else if (fd === 2) stderr += chunk;
        return Buffer.byteLength(chunk);
      };
      process.exit = (code) => {
        exited = true;
        exitCode = code;
        throw new _ExitSignal(code, '');
      };
      try {
        config.cmdConfigGet(dir, keyPath, true, undefined);
      } catch (e) {
        if (!(e instanceof _ExitSignal)) throw e;
      } finally {
        process.exit = origExit;
        fs.writeSync = origWriteSync;
        io.setJsonErrorMode(false);
      }
      let reason = null;
      if (exited) {
        const parts = stderr.split('\n').filter(Boolean);
        try { reason = JSON.parse(parts[parts.length - 1]).reason; } catch { /* no structured payload */ }
      }
      return { exited, exitCode, stdout: stdout.trim(), reason };
    }

    test('property: dotted-key traversal never resolves a value sourced from the JS prototype chain', () => {
      const PROTO_MEMBER_NAMES = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf', 'isPrototypeOf'];
      const randomSegmentArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/);
      const segmentArb = fc.oneof(fc.constantFrom(...PROTO_MEMBER_NAMES), randomSegmentArb);
      // Every generated path is FORCED to include at least one prototype-member
      // segment (interleaved with 0-4 random segments). That guarantees the
      // full dotted path can never equal a real SCHEMA_DEFAULTS or
      // capability-registry key: none of those keys have a segment literally
      // named '__proto__' / 'constructor' / etc., so equality would require
      // every segment to match, which a proto-member segment rules out. That
      // means any rc0 resolution below can ONLY be explained by a genuine
      // own-property value present in the written config.json — never by the
      // legitimate schema-default fallback, and never by the prototype chain.
      const keyPathArb = fc.tuple(
        fc.array(segmentArb, { maxLength: 2 }),
        fc.constantFrom(...PROTO_MEMBER_NAMES),
        fc.array(segmentArb, { maxLength: 2 }),
      ).map(([before, proto, after]) => [...before, proto, ...after].join('.'));

      // Own-property-gated reference traversal — mirrors src/config.cts's
      // fixed cmdConfigGet traversal loop exactly (Object.prototype.hasOwnProperty.call
      // gate at every descent), so "expected" reflects only genuinely-present
      // config data, never anything reachable only via the prototype chain.
      function safeOwnTraverse(obj, dottedPath) {
        let current = obj;
        for (const seg of dottedPath.split('.')) {
          if (current === undefined || current === null || typeof current !== 'object') return { found: false };
          if (!Object.prototype.hasOwnProperty.call(current, seg)) return { found: false };
          current = current[seg];
        }
        if (current === undefined) return { found: false };
        return { found: true, value: current };
      }

      // Leaf value planted at the end of a genuine own-property chain (see
      // "plant" below). JSON-safe scalars only — this exercises the "found"
      // branch with values of several distinct typeof()s, including the
      // `null` edge case (a real, resolvable value, distinct from "absent").
      const leafValueArb = fc.oneof(fc.boolean(), fc.integer(), fc.string({ maxLength: 20 }), fc.constant(null));

      fc.assert(
        fc.property(
          keyPathArb,
          fc.boolean(),
          leafValueArb,
          fc.object({ maxDepth: 3 }),
          (keyPath, plant, leafValue, backgroundObj) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-proto-prop-'));
            try {
              fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });

              let configObj;
              if (plant) {
                // Deliberately construct a config object where `keyPath` IS a
                // genuine own-property chain terminating at `leafValue` — via
                // COMPUTED property syntax `{ [seg]: nested }`, which (unlike
                // `obj.__proto__ = v` / `obj['__proto__'] = v`) is NOT
                // Annex-B-special-cased and always defines a real own data
                // property, even when `seg === '__proto__'`. This is the
                // same mechanism JSON.parse uses for a literal "__proto__"
                // key in committed JSON, so it models a real project config.
                const segments = keyPath.split('.');
                let nested = leafValue;
                for (let i = segments.length - 1; i >= 0; i--) {
                  nested = { [segments[i]]: nested };
                }
                configObj = nested;
              } else {
                // Independent random object — keyPath is (overwhelmingly)
                // absent from it, exercising the safe-error side.
                configObj = backgroundObj;
              }

              const serialized = JSON.stringify(configObj ?? {});
              fs.writeFileSync(path.join(dir, '.planning', 'config.json'), serialized);
              // Reference expectation is computed from the SAME round-tripped
              // JSON cmdConfigGet itself reads back (JSON.stringify then
              // JSON.parse), so it reflects exactly what fs.readFileSync +
              // JSON.parse produced.
              const roundTripped = JSON.parse(serialized);
              const expected = safeOwnTraverse(roundTripped, keyPath);

              const result = runInProcessAt(dir, keyPath);

              if (result.exited) {
                assert.equal(result.exitCode, 1, `keyPath=${JSON.stringify(keyPath)} exited non-1`);
                assert.ok(
                  result.reason === io.ERROR_REASON.CONFIG_KEY_NOT_FOUND
                    || result.reason === io.ERROR_REASON.CONFIG_NO_FILE,
                  `keyPath=${JSON.stringify(keyPath)} errored with unexpected reason=${result.reason}`,
                );
                // A planted path must NEVER fail to resolve — if it did, that
                // would itself be a defect (own data lost/misread), distinct
                // from the prototype-leak contract but still worth pinning.
                assert.equal(plant, false, `planted own-property path ${JSON.stringify(keyPath)} unexpectedly errored`);
              } else {
                // rc0 — the guaranteed proto-member segment rules out both the
                // SCHEMA_DEFAULTS and capability-registry fallback paths, so
                // the ONLY legitimate explanation for a success here is a
                // genuine own-property value actually present in config.json.
                assert.ok(
                  expected.found,
                  `rc0 for keyPath=${JSON.stringify(keyPath)} but no own-reachable value exists in the ` +
                  `written config — possible prototype-chain leak (stdout=${JSON.stringify(result.stdout)})`,
                );
                assert.equal(result.stdout, String(expected.value));
              }
            } finally {
              cleanup(dir);
            }
          },
        ),
        // Bounded below the shared 200-run default (config-schema.property.test.cjs's
        // global fc.configureGlobal) because each run does real filesystem I/O
        // (mkdtemp + write + rm) rather than pure in-memory computation.
        { numRuns: 60 },
      );
    });
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2798-context-window-config-key.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2798-context-window-config-key (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for bug #2798
 *
 * `gsd-sdk query config-set context_window <n>` was rejected with
 * "Unknown config key: context_window" because context_window was missing
 * from VALID_CONFIG_KEYS in sdk/src/query/config-schema.ts.
 *
 * The fix added 'context_window' to the allowlist.
 * This test prevents future drift where the key gets accidentally removed.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTempProject, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const SDK_CLI = path.join(REPO_ROOT, 'sdk', 'dist', 'cli.js');

function runConfigSet(key, value, projectDir) {
  const argv = ['query', 'config-set', key, String(value), '--project-dir', projectDir];
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [SDK_CLI, ...argv], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GSD_SESSION_KEY: '' },
    });
  } catch (err) {
    exitCode = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
  }
  let json = null;
  try { json = JSON.parse(stdout.trim()); } catch { /* ok */ }
  return { exitCode, json };
}

describe('bug-2798: context_window is a valid config key', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-test-2798-');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ mode: 'balanced' })
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-set context_window succeeds (not rejected as unknown key)', (t) => {
    if (!fs.existsSync(SDK_CLI)) {
      t.skip('sdk/dist/cli.js not built — run `cd sdk && npm run build` to enable this integration test');
      return;
    }
    const result = runConfigSet('context_window', 1000000, tmpDir);

    assert.strictEqual(result.exitCode, 0, 'should exit 0 (key is valid)');
    assert.ok(result.json !== null, 'should emit JSON');
    assert.strictEqual(result.json?.updated, true, 'updated should be true');
    assert.strictEqual(result.json?.key, 'context_window');
  });

  test('context_window value is written to config.json', (t) => {
    if (!fs.existsSync(SDK_CLI)) {
      t.skip('sdk/dist/cli.js not built — run `cd sdk && npm run build` to enable this integration test');
      return;
    }
    runConfigSet('context_window', 500000, tmpDir);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8')
    );
    assert.strictEqual(config.context_window, 500000, 'context_window should be persisted');
  });

  test('config-schema CJS and SDK allowlists both include context_window', (t) => {
    if (!fs.existsSync(path.join(REPO_ROOT, 'sdk', 'dist', 'query', 'config-schema.js'))) {
      t.skip('sdk/dist/query/config-schema.js not built — run `cd sdk && npm run build` to enable this integration test');
      return;
    }
    const cjsSchema = require(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'config-schema.cjs'));
    const sdkSchema = require(path.join(REPO_ROOT, 'sdk', 'dist', 'query', 'config-schema.js'));

    assert.ok(
      cjsSchema.VALID_CONFIG_KEYS.has('context_window'),
      'CJS VALID_CONFIG_KEYS must include context_window'
    );
    assert.ok(
      sdkSchema.VALID_CONFIG_KEYS.has('context_window'),
      'SDK VALID_CONFIG_KEYS must include context_window'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2943-config-get-context-window-default.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2943-config-get-context-window-default (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for bug #2943
 *
 * `gsd-tools.cjs config-get context_window` (and the SDK equivalent) threw
 * "Key not found: context_window" when the key was absent from config.json,
 * even though context_window has a documented schema default of 200000.
 *
 * Fix: `cmdConfigGet` in bin/lib/config.cjs now consults a SCHEMA_DEFAULTS map
 * before emitting "Key not found", so schema-defaulted keys always return the
 * default value (exit 0) when not explicitly set in the project config.
 */

'use strict';

// Migrated to typed-IR (#2974): the previous shape grepped stderr/stdout for
// "Key not found"; now the test passes `--json-errors` to gsd-tools and
// asserts on the structured `reason` code (a frozen-enum value from
// `core.cjs::ERROR_REASON`). Exit code is also a typed signal — together
// they fully discriminate the failure class.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const { ERROR_REASON } = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'io.cjs'));
const { cleanup } = require('./helpers.cjs');

describe('bug-2943: config-get returns schema default for context_window', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-2943-'));
    planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /**
   * Run config-get with optional extra args. Returns { exitCode, stdout, stderr }.
   * Uses --raw so we get the plain scalar value, not JSON-wrapped.
   */
  function runConfigGet(keyPath, extraArgs = []) {
    const args = [GSD_TOOLS, 'config-get', keyPath, '--raw', '--cwd', tmpDir, ...extraArgs];
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      // Windows/Node 22 under --test-concurrency=4 can starve subprocess slots when
      // sharing a wave with bug-2760-codex-install (8–15s install subtests). 15s covers
      // observed worst case (13.5s) with headroom.
      stdout = execFileSync(process.execPath, args, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      });
    } catch (err) {
      exitCode = err.status ?? 1;
      stdout = err.stdout?.toString() ?? '';
      stderr = err.stderr?.toString() ?? '';
    }
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  }

  test('returns "200000" (exit 0) when context_window absent from config.json', () => {
    // Fixture A: config with unrelated keys, no context_window
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ workflow: { auto_advance: false } })
    );

    const result = runConfigGet('context_window');

    assert.strictEqual(result.exitCode, 0, 'should exit 0 (schema default applied)');
    assert.strictEqual(result.stdout, '200000', 'should return schema default of 200000');
  });

  test('returns configured value when context_window is explicitly set', () => {
    // Fixture B: config has context_window: 1000000
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ context_window: 1000000 })
    );

    const result = runConfigGet('context_window');

    assert.strictEqual(result.exitCode, 0, 'should exit 0 for found key');
    assert.strictEqual(result.stdout, '1000000', 'should return configured value not schema default');
  });

  test('--default flag overrides schema default', () => {
    // config has context_window but we pass --default with a different value —
    // when key IS present, real value wins over any default
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ workflow: { auto_advance: false } })
    );

    const result = runConfigGet('context_window', ['--default', '123456']);

    assert.strictEqual(result.exitCode, 0, 'should exit 0 when --default provided');
    assert.strictEqual(result.stdout, '123456', 'should return the --default value, not schema default');
  });

  test('errors with reason=CONFIG_KEY_NOT_FOUND (exit 1) for an unknown absent key — no regression', () => {
    // An unrecognised key with no schema default still errors as before.
    // Migrated #2974: assert on the structured reason code from --json-errors,
    // not on substring presence in stderr/stdout text.
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ workflow: { auto_advance: false } })
    );

    const result = runConfigGet('totally_unknown_key_xyz', ['--json-errors']);

    assert.strictEqual(result.exitCode, 1, 'should exit 1 for unknown absent key');
    let parsed;
    try {
      parsed = JSON.parse(result.stderr);
    } catch (err) {
      assert.fail(`expected JSON-shaped stderr from --json-errors; got: ${JSON.stringify(result.stderr)}`);
    }
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.reason, ERROR_REASON.CONFIG_KEY_NOT_FOUND,
      `expected reason=${ERROR_REASON.CONFIG_KEY_NOT_FOUND}, got=${parsed.reason}`);
  });

  test('--default flag still works for arbitrary absent keys', () => {
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({})
    );

    const result = runConfigGet('some.missing.key', ['--default', '200000']);

    assert.strictEqual(result.exitCode, 0, 'should exit 0 when --default supplied');
    assert.strictEqual(result.stdout, '200000', 'should return the explicit --default value');
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3593-cli-negative-config.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3593-cli-negative-config (consolidation epic #1969 B6 #1975)", () => {
/**
 * CLI negative matrix for the `config` command family (#3593).
 *
 * Exercises the 12 adversarial input categories enumerated in
 * CONTRIBUTING.md §"QA Matrix Requirements / CLI and command routing"
 * against `config-get` and `config-set`. The harness in
 * `tests/helpers/cli-negative.cjs` shapes spawnSync output into a typed
 * IR so every assertion runs on `result.reason`, `result.status`, and
 * `result.hasStackTrace` — never on stderr/stdout prose.
 *
 * Each test gets its own temp project (no shared state) so concurrent
 * runs can't observe each other's filesystem mutations. Hostile values
 * (shell metacharacters, null bytes, unicode, very long strings) reach
 * the CLI as single argv elements via spawnSync — never composed into
 * a shell string — so the test framework itself can't be the source of
 * a false positive on shell-injection assertions.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCli } = require('./helpers/cli-negative.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

/**
 * Universal invariants every adversarial case must satisfy when the
 * CLI is invoked with --json-errors. Bundling these in a helper keeps
 * each test focused on the case-specific reason assertion.
 */
function assertSafeFailure(result, msg = '') {
  assert.notEqual(result.status, 0, `${msg} :: expected non-zero exit`);
  assert.equal(result.signal, null, `${msg} :: must exit cleanly, not via signal`);
  assert.equal(result.hasStackTrace, false, `${msg} :: stderr must not leak a V8 stack frame`);
  assert.equal(result.ok, false, `${msg} :: JSON payload ok must be false`);
  assert.equal(typeof result.reason, 'string', `${msg} :: reason must be a string`);
  assert.notEqual(result.reason, '', `${msg} :: reason must not be empty`);
  // The harness's JSON-shape detection runs on the trimmed stderr; if we
  // got here with reason set, the payload was a valid object — that already
  // implies no rogue prose was mixed in. Re-asserting the trimmed form would
  // be redundant.
}

/**
 * Snapshot the file inventory of a directory so a later assertion can
 * prove the failing CLI invocation did NOT create or modify any file.
 */
function snapshotInventory(dir) {
  const entries = [];
  function walk(rel) {
    const abs = path.join(dir, rel);
    let stat;
    try { stat = fs.lstatSync(abs); } catch { return; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name));
    } else {
      entries.push(`${rel}\t${stat.size}\t${stat.mtimeMs}`);
    }
  }
  walk('.');
  return entries.join('\n');
}

// ─── 1. Missing required arg ────────────────────────────────────────────────

test('config-get with no key fails with a typed reason and no stack trace', (t) => {
  const projectDir = createTempProject('cli-neg-config-1-');
  t.after(() => cleanup(projectDir));
  const before = snapshotInventory(projectDir);
  const result = runCli(['config-get'], { cwd: projectDir });
  assertSafeFailure(result, 'config-get missing key');
  assert.equal(snapshotInventory(projectDir), before, 'failing read must not mutate FS');
});

test('config-set with no key fails with a typed reason', (t) => {
  const projectDir = createTempProject('cli-neg-config-2-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config-set'], { cwd: projectDir });
  assertSafeFailure(result, 'config-set missing key');
});

test('config-set with key but no value fails with a typed reason', (t) => {
  const projectDir = createTempProject('cli-neg-config-3-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config-set', 'model_profile'], { cwd: projectDir });
  assertSafeFailure(result, 'config-set missing value');
});

// ─── 2/3. Empty / whitespace arg ────────────────────────────────────────────

test('config-get with empty-string key fails safely', (t) => {
  const projectDir = createTempProject('cli-neg-config-4-');
  t.after(() => cleanup(projectDir));
  const before = snapshotInventory(projectDir);
  const result = runCli(['config-get', ''], { cwd: projectDir });
  assertSafeFailure(result, 'config-get empty key');
  assert.equal(snapshotInventory(projectDir), before, 'failing read must not mutate FS');
});

test('config-get with whitespace-only key fails safely', (t) => {
  const projectDir = createTempProject('cli-neg-config-5-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config-get', '   \t  '], { cwd: projectDir });
  assertSafeFailure(result, 'config-get whitespace key');
});

test('config-set with empty key string fails safely', (t) => {
  const projectDir = createTempProject('cli-neg-config-6-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config-set', '', 'value'], { cwd: projectDir });
  assertSafeFailure(result, 'config-set empty key');
});

// ─── 4. Duplicate flags ─────────────────────────────────────────────────────

test('--cwd specified twice does not silently use the wrong one', (t) => {
  // Make two real but distinct dirs so the test can't accidentally pass
  // because one of the paths is invalid.
  const a = createTempProject('cli-neg-config-7a-');
  const b = createTempProject('cli-neg-config-7b-');
  t.after(() => { cleanup(a); cleanup(b); });
  // No --json-errors here on purpose: --cwd is parsed before json mode is
  // applied, so we exercise both code paths by running once each.
  const result = runCli(['--cwd', a, '--cwd', b, 'config-get', 'model_profile'], { cwd: process.cwd() });
  // Either: (a) the CLI rejects duplicate --cwd with a typed reason; OR
  // (b) it commits to one of the values deterministically. The safety
  // bar is "no stack trace, no half-state mutation in EITHER dir".
  assert.equal(result.hasStackTrace, false, 'duplicate --cwd must not crash with a stack trace');
  // Neither tmp dir should have a written config since model_profile is
  // a read, not a write, and it didn't exist beforehand. Prove the read
  // didn't accidentally trigger a write side effect.
  assert.equal(fs.existsSync(path.join(a, '.planning', 'config.json')), false);
  assert.equal(fs.existsSync(path.join(b, '.planning', 'config.json')), false);
});

// ─── 5. Conflicting flags ───────────────────────────────────────────────────

test('--json-errors with --no-such-flag does not crash with a stack trace', (t) => {
  const projectDir = createTempProject('cli-neg-config-8-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['--no-such-flag', 'config-get', 'model_profile'], { cwd: projectDir });
  assert.equal(result.hasStackTrace, false, 'unknown global flag must not crash with a stack trace');
  assert.notEqual(result.status, 0, 'unknown global flag must fail');
});

// ─── 6. Malformed assignment / unknown subcommand ──────────────────────────

test('config-FAKE subcommand fails with a typed reason', (t) => {
  const projectDir = createTempProject('cli-neg-config-9-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config-FAKE'], { cwd: projectDir });
  assertSafeFailure(result, 'unknown config-* command');
});

// ─── 7. Unknown subcommands at each command depth ───────────────────────────

test('config family — bare top-level "config" without a subcommand fails safely', (t) => {
  const projectDir = createTempProject('cli-neg-config-10-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config'], { cwd: projectDir });
  // Either "missing subcommand" usage or genuine no-op behavior — what we
  // pin is "no stack trace, no FS mutation".
  assert.equal(result.hasStackTrace, false);
});

// ─── 8. Values that look like flags ─────────────────────────────────────────

test('config-set value that starts with -- is treated as a value, not a flag', (t) => {
  const projectDir = createTempProject('cli-neg-config-11-');
  t.after(() => cleanup(projectDir));
  // First create a config.json so the set has a target file.
  runCli(['config-ensure-section'], { cwd: projectDir });
  const result = runCli(['config-set', 'project_code', '--weird'], { cwd: projectDir });
  // Acceptable outcomes:
  //   (a) CLI accepts --weird as the value (and persists it),
  //   (b) CLI rejects it as a usage error.
  // Either way: no stack trace, no half-written corrupt config.
  assert.equal(result.hasStackTrace, false, 'value-looking-like-a-flag must not crash');
  const configPath = path.join(projectDir, '.planning', 'config.json');
  if (fs.existsSync(configPath)) {
    // If a config exists, it must still be valid JSON — no half-write corruption.
    const raw = fs.readFileSync(configPath, 'utf-8');
    assert.doesNotThrow(() => JSON.parse(raw), 'config.json must remain parseable after a failed set');
  }
});

// ─── 9. Invalid JSON / corrupt config file ──────────────────────────────────

test('config-get against a corrupt config.json fails with a parse-failed reason', (t) => {
  const projectDir = createTempProject('cli-neg-config-12-');
  t.after(() => cleanup(projectDir));
  const configPath = path.join(projectDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, '{ this is not json'); // deliberate corruption
  const originalCorrupt = fs.readFileSync(configPath, 'utf-8');
  const result = runCli(['config-get', 'model_profile'], { cwd: projectDir });
  assertSafeFailure(result, 'corrupt config.json');
  // The corrupt file must remain untouched — the CLI must not "helpfully"
  // overwrite an unparseable config in the failure path.
  assert.equal(fs.readFileSync(configPath, 'utf-8'), originalCorrupt, 'corrupt file must be preserved as-is');
  // Specific reason: CONFIG_PARSE_FAILED (or equivalent) — pin this so a
  // regression where parse failure leaks as "unknown" is caught.
  assert.match(
    result.reason,
    /^(config_parse_failed|config_no_file|config_invalid_key|usage)$/,
    `parse-failure reason must be from the typed ERROR_REASON enum (got: ${result.reason})`,
  );
});

// ─── 10. Very long arg ──────────────────────────────────────────────────────

test('config-get with a very long key (50KB) fails safely without hanging', (t) => {
  const projectDir = createTempProject('cli-neg-config-13-');
  t.after(() => cleanup(projectDir));
  const longKey = 'x'.repeat(50000);
  const result = runCli(['config-get', longKey], { cwd: projectDir, timeoutMs: 8000 });
  assert.equal(result.signal, null, 'long input must not trigger the harness timeout');
  assert.equal(result.hasStackTrace, false, 'long input must not crash');
  assert.notEqual(result.status, 0, 'unknown 50KB key must fail');
});

// ─── 11. Unicode / non-ASCII ────────────────────────────────────────────────

test('config-get with a Unicode key fails safely', (t) => {
  const projectDir = createTempProject('cli-neg-config-14-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config-get', 'workflow.🔥_mode'], { cwd: projectDir });
  assertSafeFailure(result, 'unicode key');
});

test('config-set with an emoji value persists or rejects without corrupting JSON', (t) => {
  const projectDir = createTempProject('cli-neg-config-15-');
  t.after(() => cleanup(projectDir));
  runCli(['config-ensure-section'], { cwd: projectDir });
  const result = runCli(['config-set', 'project_code', '🔥👾'], { cwd: projectDir });
  assert.equal(result.hasStackTrace, false);
  // If it accepted, the JSON must round-trip cleanly.
  const configPath = path.join(projectDir, '.planning', 'config.json');
  if (result.status === 0 && fs.existsSync(configPath)) {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(typeof parsed, 'object', 'config.json must be a valid object');
    if (parsed.project_code != null) {
      assert.equal(typeof parsed.project_code, 'string', 'project_code must remain a string');
    }
  }
});

// ─── 12. Shell metacharacters (the security-critical case) ──────────────────

const SHELL_PAYLOADS = [
  // Each one would, if shell-interpreted, create a sentinel file
  // adjacent to the project tree. Argv-based invocation must treat them
  // as opaque text.
  '$(touch ${PROJECT}/INJ-dollar-paren)',
  '`touch ${PROJECT}/INJ-backtick`',
  '; touch ${PROJECT}/INJ-semicolon;',
  '&& touch ${PROJECT}/INJ-and',
  '|| touch ${PROJECT}/INJ-or',
  '| tee ${PROJECT}/INJ-pipe',
  '> ${PROJECT}/INJ-redirect',
  // Quote-balanced payloads — these have historically broken naive
  // shell-string composition even when the rest of the code uses argv.
  '"; touch ${PROJECT}/INJ-quote;"',
  '\'; touch ${PROJECT}/INJ-quote;\'',
];

for (const payload of SHELL_PAYLOADS) {
  test(`config-get with shell-metachar key (${payload.slice(0, 25)}…) does NOT execute the payload`, (t) => {
    const projectDir = createTempProject('cli-neg-config-shell-');
    t.after(() => cleanup(projectDir));
    const resolvedPayload = payload.replace(/\$\{PROJECT\}/g, projectDir);
    const result = runCli(['config-get', resolvedPayload], { cwd: projectDir });
    // No shell interpretation: none of the INJ-* sentinel files must
    // exist after the run. Walk the project dir and assert.
    const entries = fs.readdirSync(projectDir);
    const sentinels = entries.filter((n) => n.startsWith('INJ-'));
    assert.deepEqual(sentinels, [], `shell payload must NOT create sentinel files (found: ${sentinels.join(', ')})`);
    // The CLI may exit 0 (legitimate — the metacharacter-laden key
    // simply doesn't exist in config) or non-zero (typed reason). Both
    // are acceptable as long as no payload was executed.
    assert.equal(result.hasStackTrace, false);
  });
}

// ─── Cross-cutting: --cwd points at a non-existent path ────────────────────

test('--cwd pointing at a non-existent path fails with a typed usage reason', (_t) => {
  const nonExistent = path.join(require('os').tmpdir(), 'cli-neg-no-such-dir-' + Date.now() + '-' + Math.random());
  assert.equal(fs.existsSync(nonExistent), false, 'pre-check: path must not exist');
  const result = runCli(['--cwd', nonExistent, 'config-get', 'model_profile'], { cwd: process.cwd() });
  assert.notEqual(result.status, 0);
  assert.equal(result.hasStackTrace, false);
  // gsd-tools validates --cwd up-front and emits ERROR_REASON.USAGE.
  assert.equal(result.reason, 'usage', `expected reason=usage for invalid --cwd, got: ${result.reason}`);
});

test('--cwd with an empty value fails with a typed usage reason', () => {
  const result = runCli(['--cwd', '', 'config-get', 'model_profile'], { cwd: process.cwd() });
  assert.notEqual(result.status, 0);
  assert.equal(result.hasStackTrace, false);
  assert.equal(result.reason, 'usage');
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3593-cli-negative-harness.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3593-cli-negative-harness (consolidation epic #1969 B6 #1975)", () => {
/**
 * Meta-test for the CLI negative-matrix harness (#3593).
 *
 * The harness in `tests/helpers/cli-negative.cjs` shapes spawnSync
 * results into a typed IR that adversarial-input tests consume. This
 * file pins the IR contract by exercising the harness against
 * deliberate scenarios — not as a placeholder for the real matrix tests
 * (those live in sibling feat-3593-* files) but to surface harness
 * regressions before they cascade through every matrix test.
 *
 * Tests deliberately avoid prose-matching: they assert on numeric exit
 * codes, boolean flags, and reason codes pulled from the parsed JSON
 * payload.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCli, parseSpawnResult } = require('./helpers/cli-negative.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

test('runCli rejects non-array argv with TypeError', () => {
  assert.throws(
    () => runCli('config-get', { cwd: '/tmp' }),
    (err) => err instanceof TypeError && /argv/.test(err.message),
  );
});

test('runCli rejects missing cwd with TypeError', () => {
  assert.throws(
    () => runCli(['config-get'], {}),
    (err) => err instanceof TypeError && /cwd/.test(err.message),
  );
});

test('runCli surfaces typed reason from a known failure path', (t) => {
  const projectDir = createTempProject('cli-neg-harness-');
  t.after(() => cleanup(projectDir));
  // Unknown command — gsd-tools emits ERROR_REASON.SDK_UNKNOWN_COMMAND or
  // USAGE depending on dispatch depth. Either is a real reason string;
  // the contract we pin here is just "the IR carries a reason from the
  // ERROR_REASON enum, never null".
  const result = runCli(['this-command-does-not-exist'], { cwd: projectDir });
  assert.notEqual(result.status, 0, 'unknown command must exit non-zero');
  assert.equal(result.ok, false, 'JSON payload must report ok=false');
  assert.equal(typeof result.reason, 'string', 'reason must be a string from ERROR_REASON');
  assert.notEqual(result.reason, null);
  assert.notEqual(result.reason, '');
  assert.equal(result.hasStackTrace, false, 'a typed failure must NOT print a V8 stack trace');
});

test('parseSpawnResult detects stack-trace leakage in stderr', () => {
  const fakeSpawn = {
    status: 1,
    signal: null,
    stdout: '',
    stderr: 'Error: boom\n    at Object.<anonymous> (/some/file.js:10:5)\n    at Module._compile\n',
    error: null,
  };
  const ir = parseSpawnResult(fakeSpawn, { jsonErrorsRequested: false });
  assert.equal(ir.hasStackTrace, true, 'stack frames in stderr must be flagged');
  assert.equal(ir.reason, null, 'non-JSON stderr leaves reason null');
});

test('parseSpawnResult does NOT match the literal word "at" in prose', () => {
  // Guard against a regex regression that would catch sentences like
  // "command failed at startup" as stack frames.
  const fakeSpawn = {
    status: 1,
    signal: null,
    stdout: '',
    stderr: 'Error: command failed at startup\nbecause no project was found.\n',
    error: null,
  };
  const ir = parseSpawnResult(fakeSpawn, { jsonErrorsRequested: false });
  assert.equal(ir.hasStackTrace, false, 'prose containing the word "at" is not a stack frame');
});

test('parseSpawnResult extracts ok/reason/message from a json-errors payload', () => {
  const payload = { ok: false, reason: 'config_invalid_key', message: 'no such key: foo' };
  const fakeSpawn = {
    status: 1,
    signal: null,
    stdout: '',
    stderr: JSON.stringify(payload) + '\n',
    error: null,
  };
  const ir = parseSpawnResult(fakeSpawn, { jsonErrorsRequested: true });
  assert.equal(ir.ok, false);
  assert.equal(ir.reason, 'config_invalid_key');
  assert.equal(ir.message, 'no such key: foo');
  assert.equal(ir.hasStackTrace, false);
});

test('parseSpawnResult ignores malformed JSON in stderr without throwing', () => {
  const fakeSpawn = {
    status: 1,
    signal: null,
    stdout: '',
    stderr: '{ ok: false, reason }', // missing quotes — invalid JSON
    error: null,
  };
  const ir = parseSpawnResult(fakeSpawn, { jsonErrorsRequested: true });
  assert.equal(ir.ok, null, 'malformed JSON must NOT promote partial data into ok');
  assert.equal(ir.reason, null);
  assert.equal(ir.message, null);
});

test('parseSpawnResult ignores JSON arrays and primitives, only accepts objects', () => {
  const cases = [
    '["ok", false]',     // array
    '"just a string"',   // primitive
    'null',              // null literal
    '42',                // number
  ];
  for (const stderr of cases) {
    const ir = parseSpawnResult(
      { status: 1, signal: null, stdout: '', stderr, error: null },
      { jsonErrorsRequested: true },
    );
    assert.equal(ir.ok, null, `non-object JSON (${stderr}) must not set ok`);
    assert.equal(ir.reason, null);
  }
});

test('runCli treats jsonErrors=false as an explicit human-formatter path', (t) => {
  const projectDir = createTempProject('cli-neg-harness-text-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['this-command-does-not-exist'], { cwd: projectDir, jsonErrors: false });
  assert.notEqual(result.status, 0);
  assert.equal(result.jsonErrorsRequested, false);
  // Reason fields stay null in human-mode because stderr is prose, not JSON.
  assert.equal(result.ok, null);
  assert.equal(result.reason, null);
  // But the prose still must not include a V8 stack trace.
  assert.equal(result.hasStackTrace, false);
});
  });
}

// ─── #2702: workstream-scoped config-get inherits from root config ──────────
//
// When GSD_WORKSTREAM is set, planningDir(cwd) points at .planning/workstreams/<ws>/.
// cmdConfigGet used to read ONLY that file, so a key configured at the project root
// (.planning/config.json) but absent from the workstream's own config was reported
// "Key not found" — silently inverting boolean workflow guards. The fix adds a
// root-config inheritance rung: workstream overrides root, but root fills gaps.

describe('#2702: workstream config-get inherits from root config', () => {
  let tmpDir;
  let rootPlanningDir;
  let wsPlanningDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-config-ws-2702-'));
    rootPlanningDir = path.join(tmpDir, '.planning');
    wsPlanningDir = path.join(rootPlanningDir, 'workstreams', 'alpha');
    fs.mkdirSync(wsPlanningDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Run cmdConfigGet with GSD_WORKSTREAM scoped to 'alpha' (so planningDir → ws dir).
  function runScoped(...args) {
    const { keyPath, raw, defaultValue } = parseConfigGetArgs(args);
    const saved = process.env.GSD_WORKSTREAM;
    process.env.GSD_WORKSTREAM = 'alpha';
    let out;
    try {
      out = captureFdWrite(1, () => {
        config.cmdConfigGet(tmpDir, keyPath, raw, defaultValue);
      });
    } finally {
      if (saved === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = saved;
    }
    return out.trim();
  }

  function runScopedExpectError(...args) {
    const { keyPath, raw, defaultValue } = parseConfigGetArgs(args);
    const saved = process.env.GSD_WORKSTREAM;
    process.env.GSD_WORKSTREAM = 'alpha';
    const origExit = process.exit;
    const origWriteSync = fs.writeSync;
    io.setJsonErrorMode(true);
    let exitCode;
    let stderr = '';
    fs.writeSync = (fd, ...rest) => {
      if (fd !== 2) return origWriteSync.call(fs, fd, ...rest);
      stderr += String(rest[0]);
      return Buffer.byteLength(String(rest[0]));
    };
    process.exit = (code) => { exitCode = code; throw new _ExitSignal(code); };
    try {
      config.cmdConfigGet(tmpDir, keyPath, raw, defaultValue);
    } catch (e) {
      if (!(e instanceof _ExitSignal)) throw e;
    } finally {
      process.exit = origExit;
      fs.writeSync = origWriteSync;
      io.setJsonErrorMode(false);
      if (saved === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = saved;
    }
    const parts = stderr.split('\n').filter(Boolean);
    let payload = {};
    try { payload = JSON.parse(parts[parts.length - 1]); } catch { /* human mode */ }
    return { status: exitCode, reason: payload.reason };
  }

  function writeRoot(obj) {
    fs.writeFileSync(path.join(rootPlanningDir, 'config.json'), JSON.stringify(obj));
  }
  function writeWs(obj) {
    fs.writeFileSync(path.join(wsPlanningDir, 'config.json'), JSON.stringify(obj));
  }

  test('inherits a fail-closed key (workflow.use_worktrees) from root when workstream omits it', () => {
    writeRoot({ workflow: { use_worktrees: true } });
    // workstream config exists but does NOT set the key
    writeWs({ workflow: {} });
    assert.equal(runScoped('config-get', 'workflow.use_worktrees', '--raw'), 'true');
  });

  test('inherits a fail-open key (workflow.plan_review_convergence) from root', () => {
    writeRoot({ workflow: { plan_review_convergence: true } });
    writeWs({ workflow: {} });
    assert.equal(runScoped('config-get', 'workflow.plan_review_convergence', '--raw'), 'true');
  });

  test('inherits a core key (workflow.verifier) from root', () => {
    writeRoot({ workflow: { verifier: true } });
    writeWs({ workflow: {} });
    assert.equal(runScoped('config-get', 'workflow.verifier', '--raw'), 'true');
  });

  test('workstream config overrides root value for a key it sets', () => {
    writeRoot({ workflow: { use_worktrees: true } });
    writeWs({ workflow: { use_worktrees: false } });
    assert.equal(runScoped('config-get', 'workflow.use_worktrees', '--raw'), 'false');
  });

  test('still errors on a key absent from workstream, root, and schema', () => {
    writeWs({ workflow: {} });
    writeRoot({ workflow: {} });
    const { status, reason } = runScopedExpectError('config-get', 'workflow.totally_absent', '--raw');
    assert.notEqual(status, 0, 'a key absent everywhere must error');
    assert.equal(reason, io.ERROR_REASON.CONFIG_KEY_NOT_FOUND);
  });

  test('--default is ignored when the key is inherited from root', () => {
    writeRoot({ workflow: { use_worktrees: true } });
    writeWs({ workflow: {} });
    assert.equal(
      runScoped('config-get', 'workflow.use_worktrees', '--default', 'false', '--raw'),
      'true',
    );
  });

  test('inherits a nested fail-closed key (workflow.context_coverage_gate) from root', () => {
    writeRoot({ workflow: { context_coverage_gate: false } });
    writeWs({ workflow: {} });
    assert.equal(runScoped('config-get', 'workflow.context_coverage_gate', '--raw'), 'false');
  });

  test('scoped and unscoped reads return the same string form when workstream does not override', () => {
    writeRoot({ workflow: { use_worktrees: true } });
    writeWs({ workflow: {} });
    const scoped = runScoped('config-get', 'workflow.use_worktrees', '--raw');
    // Unscoped read: no GSD_WORKSTREAM — reads root directly.
    const unscoped = captureFdWrite(1, () => {
      config.cmdConfigGet(tmpDir, 'workflow.use_worktrees', true, undefined);
    }).trim();
    assert.equal(scoped, unscoped, 'scoped (inherited) and unscoped reads must agree');
    assert.equal(scoped, 'true');
  });

  test('unscoped config-get still reads root value (no regression when not scoped)', () => {
    writeRoot({ workflow: { use_worktrees: true } });
    const out = captureFdWrite(1, () => {
      config.cmdConfigGet(tmpDir, 'workflow.use_worktrees', true, undefined);
    }).trim();
    assert.equal(out, 'true');
  });

  test('inherits from root even when the workstream has no config.json at all', () => {
    writeRoot({ workflow: { use_worktrees: true } });
    // No writeWs — workstreams/alpha/config.json does not exist.
    assert.equal(runScoped('config-get', 'workflow.use_worktrees', '--raw'), 'true');
  });

  test('GSD_PROJECT alone (no workstream) does not trigger root inheritance — matches loadConfigResolved', () => {
    // GSD_PROJECT scopes planningDir to .planning/<project>/ but loadConfigResolved
    // gates root-reading on `if (ws)`, so a project-only read must NOT inherit root.
    // The fix gates on GSD_WORKSTREAM presence (not path inequality) to match.
    // A --default is supplied so a non-inheriting read returns a clean sentinel
    // ('not-inherited') rather than hitting the error/exit path.
    const projectPlanningDir = path.join(rootPlanningDir, 'myproj');
    fs.mkdirSync(projectPlanningDir, { recursive: true });
    fs.writeFileSync(path.join(projectPlanningDir, 'config.json'), JSON.stringify({ workflow: {} }));
    writeRoot({ workflow: { use_worktrees: true } });
    const saved = process.env.GSD_PROJECT;
    process.env.GSD_PROJECT = 'myproj';
    try {
      const out = captureFdWrite(1, () => {
        config.cmdConfigGet(tmpDir, 'workflow.use_worktrees', true, 'not-inherited');
      }).trim();
      // No workstream → no root inheritance → returns the --default sentinel, NOT root 'true'.
      assert.equal(out, 'not-inherited', 'GSD_PROJECT-only must not inherit root (matches loadConfigResolved)');
    } finally {
      if (saved === undefined) delete process.env.GSD_PROJECT;
      else process.env.GSD_PROJECT = saved;
    }
  });
});

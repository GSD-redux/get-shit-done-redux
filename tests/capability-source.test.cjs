'use strict';

/**
 * capability-source.test.cjs — ADR-1244 Phase 3, Decision D3.
 *
 * Tests for resolveCapabilitySource + parseSpec:
 *   - parseSpec kind-detection table (all kinds + error cases)
 *   - local adapter: happy path, invalid manifest, engines.gsd incompatibility
 *   - registry kind: throws 'not yet implemented'
 *   - tarball adapter: integrity matching / mismatching (via injected HTTP seam)
 *   - security: shell metacharacters in specs/args → only reach exec override as
 *     argv array (not interpolated into a shell string)
 *   - security: capability id containing ../ → rejected
 *   - staging atomicity: validation failure leaves no dir under capabilities/
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { cleanup, createTempDir } = require('./helpers.cjs');

// The module under test — loaded from the built .cjs artifact.
const capSource = require('../gsd-core/bin/lib/capability-source.cjs');
const {
  resolveCapabilitySource,
  parseSpec,
  _setCapabilitySourceHttpGet,
  _setHttpsGetImpl,
  peekLatestVersion,
  pickHighestSemverTag,
  splitNpmSpec,
  pickHighestNpmVersion,
  MAX_RESPONSE_BYTES,
  MANIFEST_MAX_BYTES,
  MAX_STAGED_BUNDLE_BYTES,
  MAX_STAGED_BUNDLE_ENTRIES,
} = capSource;
const { EventEmitter } = require('node:events');
const fc = require('fast-check');

/** Build a `git ls-remote --tags` style stdout line for a tag. */
function lsRemoteLine(tag) {
  return `0000000000000000000000000000000000000000\trefs/tags/${tag}`;
}
/** A SpawnResult-shaped success. */
function spawnOk(stdout) {
  return { exitCode: 0, stdout, stderr: '', signal: null, error: null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal but valid capability manifest for tests. */
function featureCap(id, extra = {}) {
  return {
    id,
    role: 'feature',
    version: '1.0.0',
    title: id,
    description: 'test capability',
    tier: 'standard',
    requires: [],
    engines: { gsd: '>=1.0.0' },
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [],
    agents: [],
    hooks: [],
    config: {},
    steps: [],
    contributions: [],
    gates: [],
    ...extra,
  };
}

/**
 * Create a temp directory with a capability.json inside.
 * Returns the directory path.
 */
function makeLocalCap(cap) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-local-'));
  fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(cap), 'utf8');
  return dir;
}

/** Compute sha512-<base64> from a Buffer. */
function sha512b64(buf) {
  return 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
}

/** A minimal fs.Dirent-shaped object for synthetic streaming-opendir tests. */
function makeDirent(name, { file = false, dir = false, symlink = false } = {}) {
  return {
    name,
    isSymbolicLink: () => symlink,
    isDirectory: () => dir,
    isFile: () => file,
  };
}

// ---------------------------------------------------------------------------
// parseSpec — kind detection
// ---------------------------------------------------------------------------

describe('parseSpec — kind detection', () => {
  test('relative path ./foo → local', () => {
    const p = parseSpec('./my-cap');
    assert.strictEqual(p.kind, 'local');
    assert.strictEqual(p.raw, './my-cap');
  });

  test('relative path ../foo → local', () => {
    const p = parseSpec('../my-cap');
    assert.strictEqual(p.kind, 'local');
  });

  test('absolute path /home/user/my-cap → local', () => {
    const p = parseSpec('/home/user/my-cap');
    assert.strictEqual(p.kind, 'local');
  });

  test('npm: prefix → npm', () => {
    const p = parseSpec('npm:my-capability@1.0.0');
    assert.strictEqual(p.kind, 'npm');
    assert.strictEqual(p.target, 'my-capability@1.0.0');
  });

  test('tarball https URL ending .tgz → tarball', () => {
    const p = parseSpec('https://example.com/cap.tgz');
    assert.strictEqual(p.kind, 'tarball');
    assert.strictEqual(p.target, 'https://example.com/cap.tgz');
  });

  test('tarball https URL ending .tar.gz → tarball', () => {
    const p = parseSpec('https://example.com/cap.tar.gz');
    assert.strictEqual(p.kind, 'tarball');
  });

  test('git https URL ending .git → git', () => {
    const p = parseSpec('https://github.com/org/repo.git');
    assert.strictEqual(p.kind, 'git');
    assert.strictEqual(p.target, 'https://github.com/org/repo.git');
    assert.strictEqual(p.ref, undefined);
  });

  test('git URL with #<ref> → git with ref extracted', () => {
    const p = parseSpec('https://github.com/org/repo#v1.2.3');
    assert.strictEqual(p.kind, 'git');
    assert.strictEqual(p.ref, 'v1.2.3');
    assert.ok(!p.target.includes('#'), 'URL must not include # fragment');
  });

  test('git+ prefix → git', () => {
    const p = parseSpec('git+https://github.com/org/repo.git');
    assert.strictEqual(p.kind, 'git');
  });

  test('registry-style name@version (no scheme) → registry', () => {
    const p = parseSpec('my-org/capability@2.0.0');
    assert.strictEqual(p.kind, 'registry');
  });

  test('bare package name → registry', () => {
    const p = parseSpec('my-capability');
    assert.strictEqual(p.kind, 'registry');
  });

  test('empty string → throws', () => {
    assert.throws(() => parseSpec(''), /non-empty/i);
  });

  test('whitespace-only string → throws', () => {
    assert.throws(() => parseSpec('   '), /non-empty/i);
  });

  test('null coerced (wrong type) → throws', () => {
    // @ts-expect-error intentional wrong type for test
    assert.throws(() => parseSpec(null), /non-empty|string/i);
  });

  test('npm: with empty package spec → throws', () => {
    assert.throws(() => parseSpec('npm:'), /empty after "npm:"/i);
  });
});

// ---------------------------------------------------------------------------
// local adapter
// ---------------------------------------------------------------------------

describe('local adapter — happy path', () => {
  let gsdHome = '';
  let capDir = '';

  beforeEach(() => {
    gsdHome = createTempDir('gsd-home-');
    capDir = makeLocalCap(featureCap('test-cap-local'));
  });

  afterEach(() => {
    cleanup(gsdHome);
    cleanup(capDir);
  });

  test('resolves a valid local capability — staged dir exists with capability.json', async () => {
    const result = await resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' });
    assert.strictEqual(result.id, 'test-cap-local');
    assert.strictEqual(result.version, '1.0.0');
    assert.ok(fs.existsSync(result.stagedDir), 'staged dir must exist');
    assert.ok(
      fs.existsSync(path.join(result.stagedDir, 'capability.json')),
      'capability.json must be present in staged dir'
    );
    assert.strictEqual(result.source, capDir);
  });

  test('staging creates the capability under <gsdHome>/.gsd/capabilities/<id>/', async () => {
    const result = await resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' });
    const expectedDir = path.join(gsdHome, '.gsd', 'capabilities', 'test-cap-local');
    assert.strictEqual(result.stagedDir, expectedDir);
    assert.ok(fs.existsSync(expectedDir));
  });

  test('skipEnginesGate:true stages an engines-incompatible capability without throwing', async () => {
    const cap = featureCap('test-cap-local');
    cap.engines = { gsd: '>=99.0.0' };
    const incompatDir = makeLocalCap(cap);
    // Default: the engines gate throws.
    await assert.rejects(
      () => resolveCapabilitySource(incompatDir, { gsdHome, hostVersion: '1.6.0' }),
      /engines\.gsd/,
    );
    // skipEnginesGate: the resolver stages it (copy-only) and leaves the gate to the caller.
    const r = await resolveCapabilitySource(incompatDir, { gsdHome, hostVersion: '1.6.0', skipEnginesGate: true, promote: false });
    assert.strictEqual(r.id, 'test-cap-local');
    assert.ok(fs.existsSync(path.join(r.stagedDir, 'capability.json')));
    cleanup(incompatDir);
    cleanup(r.stagedDir);
  });

  test('promote:false validates but does NOT promote — returns the staging dir, final dir absent', async () => {
    const result = await resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0', promote: false });
    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'test-cap-local');
    const stagingRoot = path.join(gsdHome, '.gsd', 'capabilities', '.staging');
    assert.notStrictEqual(result.stagedDir, finalDir, 'must not be the final dir');
    assert.ok(result.stagedDir.startsWith(stagingRoot), 'staged dir is under .staging');
    assert.ok(fs.existsSync(path.join(result.stagedDir, 'capability.json')), 'staged manifest present');
    assert.ok(!fs.existsSync(finalDir), 'final dir must NOT be created when promote:false');
  });
});

describe('local adapter — invalid manifest', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('manifest missing "version" field → throws AND no staged dir remains', async () => {
    const cap = featureCap('no-version-cap');
    delete cap.version;
    const capDir = makeLocalCap(cap);

    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' }),
        (err) => {
          assert.ok(err instanceof Error, 'must throw an Error');
          return true;
        }
      );
    } finally {
      cleanup(capDir);
    }

    // No staged dir should remain.
    const capabilitiesDir = path.join(gsdHome, '.gsd', 'capabilities');
    if (fs.existsSync(capabilitiesDir)) {
      const entries = fs.readdirSync(capabilitiesDir).filter((e) => e !== '.staging');
      assert.strictEqual(entries.length, 0, 'No capability dirs must remain after failure');
    }
  });

  test('manifest with invalid role → throws AND no staged dir remains', async () => {
    const cap = featureCap('bad-role-cap');
    cap.role = 'totally-invalid-role-xyz';
    const capDir = makeLocalCap(cap);

    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' }),
        /valid|role|validation/i
      );
    } finally {
      cleanup(capDir);
    }

    const capabilitiesDir = path.join(gsdHome, '.gsd', 'capabilities');
    if (fs.existsSync(capabilitiesDir)) {
      const entries = fs.readdirSync(capabilitiesDir).filter((e) => e !== '.staging');
      assert.strictEqual(entries.length, 0, 'No capability dirs must remain after failure');
    }
  });

  test('missing capability.json → throws', async () => {
    const dir = createTempDir('no-manifest-');
    try {
      await assert.rejects(
        () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' }),
        /capability\.json/i
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('local adapter — engines.gsd incompatibility', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('engines.gsd ">=99.0.0" with hostVersion 1.5.0 → throws before staging', async () => {
    const cap = featureCap('incompat-cap', { engines: { gsd: '>=99.0.0' } });
    const capDir = makeLocalCap(cap);

    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' }),
        /engines\.gsd|requires|incompatible/i
      );
    } finally {
      cleanup(capDir);
    }

    // No staged directory should exist.
    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'incompat-cap');
    assert.ok(!fs.existsSync(finalDir), 'staged dir must not exist for incompatible capability');
  });
});

// ---------------------------------------------------------------------------
// registry kind — explicit stub
// ---------------------------------------------------------------------------

describe('registry kind', () => {
  test('throws "not yet implemented" for registry specs', async () => {
    await assert.rejects(
      () => resolveCapabilitySource('my-cap@1.0.0', { gsdHome: os.tmpdir(), hostVersion: '1.5.0' }),
      /not yet implemented/i
    );
  });
});

// ---------------------------------------------------------------------------
// tarball adapter — integrity verification via injected HTTP seam
// ---------------------------------------------------------------------------

describe('tarball adapter — integrity via _setCapabilitySourceHttpGet', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => {
    _setCapabilitySourceHttpGet(null); // restore real transport
    cleanup(gsdHome);
  });

  test('matching integrity → resolves successfully', async () => {
    const cap = featureCap('tarball-cap');
    const tgzBuf = _fakeTarball(cap);
    const integrity = sha512b64(tgzBuf);

    _setCapabilitySourceHttpGet(() => Promise.resolve({ statusCode: 200, body: tgzBuf }));

    // Inject a tar extractor that writes the capability.json to extractDir.
    const result = await resolveCapabilitySource(
      'https://example.com/tarball-cap.tgz',
      {
        gsdHome,
        hostVersion: '1.5.0',
        integrity,
        execOverrides: {
          tar: (_prog, args, _opts) => {
            // Name listing (assertSafeTarMembers step 1): safe member names.
            if (args[0] === '-tzf') {
              return { exitCode: 0, stdout: 'capability.json\n', stderr: '', signal: null, error: null };
            }
            // Verbose listing (assertSafeTarMembers step 2): regular file, no link.
            if (args[0] === '-tvzf') {
              return { exitCode: 0, stdout: '-rw-r--r-- 0 user group 10 Jan  1 2020 capability.json\n', stderr: '', signal: null, error: null };
            }
            // Extraction pass: args = ['-xzf', tgzPath, '-C', extractDir]
            const extractDir = args[args.indexOf('-C') + 1];
            fs.writeFileSync(
              path.join(extractDir, 'capability.json'),
              JSON.stringify(cap),
              'utf8'
            );
            return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
          },
        },
      }
    );

    assert.strictEqual(result.id, 'tarball-cap');
    assert.ok(result.integrity && result.integrity.startsWith('sha512-'), 'integrity must be set');
    assert.ok(fs.existsSync(result.stagedDir));
  });

  test('mismatching integrity → throws BEFORE staging (no staged dir)', async () => {
    const cap = featureCap('tarball-mismatch');
    const tgzBuf = _fakeTarball(cap);
    const badIntegrity = 'sha512-' + Buffer.from('totally-wrong').toString('base64');

    _setCapabilitySourceHttpGet(() => Promise.resolve({ statusCode: 200, body: tgzBuf }));

    let tarCalls = 0;
    await assert.rejects(
      () =>
        resolveCapabilitySource('https://example.com/tarball-mismatch.tgz', {
          gsdHome,
          hostVersion: '1.5.0',
          integrity: badIntegrity,
          execOverrides: {
            tar: (_prog, args, _opts) => {
              // Must never be reached — integrity check fires before any tar invocation.
              tarCalls++;
              const extractDir = args[args.indexOf('-C') + 1];
              fs.writeFileSync(
                path.join(extractDir, 'capability.json'),
                JSON.stringify(cap),
                'utf8'
              );
              return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
            },
          },
        }),
      /integrity mismatch|mismatch/i
    );

    // Integrity is verified over the raw .tgz bytes BEFORE any tar call — ordering invariant.
    assert.strictEqual(tarCalls, 0, 'tar must NOT be invoked — integrity verified over the .tgz bytes before extraction');

    // No staged directory must exist.
    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'tarball-mismatch');
    assert.ok(!fs.existsSync(finalDir), 'staged dir must NOT exist after integrity mismatch');
  });
});

// ---------------------------------------------------------------------------
// #1460 CS-1 — a supplied --integrity is NEVER silently ignored.
//   - npm: verified over the produced .tgz bytes (same SRI sha512 domain as tarball).
//   - git / local: REJECTED with an actionable error (no single byte-SRI artifact).
// revert-fails: with stageValidated's `integrity: null` restored on these adapters
// (the pre-fix behaviour), the npm-mismatch case would silently resolve and the
// git/local cases would silently resolve with integrity:null — every assert below
// would then fail.
// ---------------------------------------------------------------------------

describe('#1460 CS-1 — supplied --integrity is verified or rejected per source (never silently dropped)', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  /** Build a fake `npm pack` that writes a real .tgz of `tgzBytes` to the --pack-destination. */
  function fakeNpmPack(tgzBytes) {
    return (args) => {
      const destIdx = args.indexOf('--pack-destination');
      const dest = destIdx >= 0 ? args[destIdx + 1] : '';
      fs.writeFileSync(path.join(dest, 'cap.tgz'), tgzBytes);
      return { exitCode: 0, stdout: 'cap.tgz\n', stderr: '', signal: null, error: null };
    };
  }

  /** A tar override that lists safe members and writes `cap`'s capability.json on extract. */
  function fakeTar(cap) {
    return (_prog, args) => {
      if (args[0] === '-tzf') {
        return { exitCode: 0, stdout: 'package/capability.json\n', stderr: '', signal: null, error: null };
      }
      if (args[0] === '-tvzf') {
        return { exitCode: 0, stdout: '-rw-r--r-- 0 user group 10 Jan  1 2020 package/capability.json\n', stderr: '', signal: null, error: null };
      }
      const extractDir = args[args.indexOf('-C') + 1];
      const pkgDir = path.join(extractDir, 'package');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'capability.json'), JSON.stringify(cap), 'utf8');
      return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
    };
  }

  test('npm + matching --integrity (over the .tgz bytes) → resolves', async () => {
    const cap = featureCap('npm-int-ok');
    const tgzBytes = Buffer.from('a deterministic npm tarball payload for integrity', 'utf8');
    const integrity = sha512b64(tgzBytes);

    const result = await resolveCapabilitySource('npm:@org/npm-int-ok@^1.0.0', {
      gsdHome,
      hostVersion: '1.5.0',
      integrity,
      execOverrides: { npm: fakeNpmPack(tgzBytes), tar: fakeTar(cap) },
    });

    assert.strictEqual(result.id, 'npm-int-ok');
    assert.ok(result.integrity && result.integrity.startsWith('sha512-'), 'integrity must be recorded');
    assert.ok(fs.existsSync(result.stagedDir), 'staged dir must exist');
  });

  test('npm + MISMATCHING --integrity → throws BEFORE promote/staging (no final dir)', async () => {
    const cap = featureCap('npm-int-bad');
    const tgzBytes = Buffer.from('the real npm tarball bytes', 'utf8');
    const badIntegrity = 'sha512-' + Buffer.from('not-the-real-hash').toString('base64');

    let tarCalls = 0;
    const instrumentedTar = (_prog, args) => {
      // Must never be reached — integrity is verified over the .tgz bytes before any tar call.
      tarCalls++;
      return fakeTar(cap)(_prog, args);
    };

    await assert.rejects(
      () => resolveCapabilitySource('npm:@org/npm-int-bad@^1.0.0', {
        gsdHome,
        hostVersion: '1.5.0',
        integrity: badIntegrity,
        execOverrides: { npm: fakeNpmPack(tgzBytes), tar: instrumentedTar },
      }),
      /integrity mismatch|mismatch/i,
    );

    // Integrity is verified over the raw .tgz bytes BEFORE any tar call — ordering invariant.
    assert.strictEqual(tarCalls, 0, 'tar extraction must NOT run — integrity verified over the .tgz bytes before extraction');

    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'npm-int-bad');
    assert.ok(!fs.existsSync(finalDir), 'no final dir after integrity mismatch');
  });

  test('git + any --integrity → throws an actionable error (no silent resolve)', async () => {
    // The integrity reject must fire BEFORE the clone — so execGit is never called.
    const gitCalls = [];
    const fakeGit = (...callArgs) => {
      gitCalls.push(callArgs);
      return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
    };

    await assert.rejects(
      () => resolveCapabilitySource('https://github.com/org/repo.git#v1.0.0', {
        gsdHome,
        hostVersion: '1.5.0',
        integrity: 'sha512-' + Buffer.from('anything').toString('base64'),
        execOverrides: { git: fakeGit },
      }),
      /integrity pinning is not supported for git sources|#sha:/i,
    );

    assert.strictEqual(gitCalls.length, 0, 'execGit must NOT run — rejection fires before the clone');
    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'repo');
    assert.ok(!fs.existsSync(finalDir), 'no final dir after git integrity rejection');
  });

  test('local + --integrity → throws an actionable error (no silent resolve)', async () => {
    const capDir = makeLocalCap(featureCap('local-int-cap'));
    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, {
          gsdHome,
          hostVersion: '1.5.0',
          integrity: 'sha512-' + Buffer.from('anything').toString('base64'),
        }),
        /integrity pinning is not supported for local sources/i,
      );
    } finally {
      cleanup(capDir);
    }

    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'local-int-cap');
    assert.ok(!fs.existsSync(finalDir), 'no final dir after local integrity rejection');
  });
});

// ---------------------------------------------------------------------------
// Security: shell metacharacters in spec / args → arrive as argv array
// ---------------------------------------------------------------------------

describe('security: shell metacharacters do not escape into a shell string', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('git spec with shell metacharacters — captured as argv array, not shell string', async () => {
    const capturedCalls = [];

    // The injected execGit captures every call; we verify the spec appears verbatim
    // as an array element, never interpolated into a string with shell operators.
    const maliciousUrl = 'https://github.com/org/repo.git; rm -rf /tmp/evil';

    const fakeGit = (args, _opts) => {
      capturedCalls.push([...args]);
      // Simulate failing clone so we don't need a real repo.
      return { exitCode: 128, stdout: '', stderr: 'not a git repository', signal: null, error: null };
    };

    await assert.rejects(
      () =>
        resolveCapabilitySource(`git+${maliciousUrl}`, {
          gsdHome,
          hostVersion: '1.5.0',
          execOverrides: { git: fakeGit },
        }),
      /clone failed|git/i
    );

    // The call must have been made with the URL as a discrete argv element.
    assert.ok(capturedCalls.length > 0, 'execGit must have been called');
    const cloneCall = capturedCalls[0];
    // Argv must include the URL as a single token — never split or shell-interpolated.
    // The semicolon and "rm -rf" must be a single string element, not two elements.
    // The key security property: if we ran this in a shell, `; rm -rf /tmp/evil` would
    // be a separate command. By routing through argv array, it is inert.
    assert.ok(
      cloneCall.some((arg) => arg === maliciousUrl || arg.includes('rm -rf')),
      'malicious characters must appear in argv array (inert), not as a parsed shell command'
    );
    // None of the individual args should be shell commands like just 'rm' or '-rf'.
    const hasStandaloneRm = cloneCall.some((arg) => arg === 'rm');
    assert.ok(!hasStandaloneRm, 'shell metacharacters must not be parsed into separate argv elements');
  });

  test('npm spec with shell metacharacters is REJECTED before exec (execNpm uses a Windows shell)', async () => {
    const capturedCalls = [];
    const fakeNpm = (args) => {
      capturedCalls.push([...args]);
      return { exitCode: 1, stdout: '', stderr: 'not found', signal: null, error: null };
    };
    for (const evil of ['`rm -rf /`', 'pkg; rm -rf', 'pkg && calc', 'pkg|cat /etc/passwd', 'pkg$(whoami)', 'pkg >out', "pkg'", 'pkg"x']) {
      await assert.rejects(
        () => resolveCapabilitySource(`npm:${evil}`, { gsdHome, hostVersion: '1.5.0', execOverrides: { npm: fakeNpm } }),
        /unsafe npm package spec/i,
        `npm:${evil} must be rejected at parse`
      );
    }
    assert.equal(capturedCalls.length, 0, 'execNpm must NEVER be called for an unsafe npm spec');
  });

  test('a valid npm spec reaches execNpm as a discrete argv element WITH --ignore-scripts', async () => {
    const capturedCalls = [];
    const fakeNpm = (args) => {
      capturedCalls.push([...args]);
      return { exitCode: 1, stdout: '', stderr: 'not found', signal: null, error: null };
    };
    await assert.rejects(
      () => resolveCapabilitySource('npm:@org/cap@^1.2.0', { gsdHome, hostVersion: '1.5.0', execOverrides: { npm: fakeNpm } }),
      /npm pack failed|not found/i
    );
    const packCall = capturedCalls[0];
    assert.ok(packCall.includes('@org/cap@^1.2.0'), 'valid spec passed as a single discrete argv element');
    assert.ok(packCall.includes('--ignore-scripts'), 'npm pack MUST pass --ignore-scripts (no lifecycle code execution)');
    assert.ok(packCall.includes('pack'), 'must be `npm pack`, never `npm install`');
  });

  test('git transport allowlist: ext::/file:// transports are rejected at parse', async () => {
    for (const evil of ['git+ext::sh -c "evil"', 'git+file:///etc', 'git+fd::7']) {
      await assert.rejects(
        () => resolveCapabilitySource(evil, { gsdHome, hostVersion: '1.5.0' }),
        /unsupported git transport/i,
        `${evil} must be rejected`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Security: symlink + tar-slip rejection
// ---------------------------------------------------------------------------

describe('security: symlink and tar-slip rejection', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('local bundle containing a symlink is refused (copyFileSync would follow it)', async (t) => {
    const dir = createTempDir('gsd-local-symlink-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(featureCap('symlink-cap')), 'utf8');
    // Plant a symlink pointing at a host file.
    const secret = createTempDir('gsd-secret-');
    t.after(() => cleanup(secret));
    fs.writeFileSync(path.join(secret, 'id_rsa'), 'PRIVATE', 'utf8');
    try {
      fs.symlinkSync(path.join(secret, 'id_rsa'), path.join(dir, 'leaked'));
    } catch {
      t.skip('symlink not supported on this platform');
      return;
    }
    await assert.rejects(
      () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' }),
      /symlink/i
    );
    assert.ok(!fs.existsSync(path.join(gsdHome, '.gsd', 'capabilities', 'symlink-cap')), 'no staged dir after symlink refusal');
  });

  test('tarball with a tar-slip member (..) is refused before extraction', async () => {
    const cap = featureCap('slip-cap');
    const tgzBuf = _fakeTarball(cap);
    _setCapabilitySourceHttpGet(() => Promise.resolve({ statusCode: 200, body: tgzBuf }));
    let extracted = false;
    await assert.rejects(
      () => resolveCapabilitySource('https://example.com/slip.tgz', {
        gsdHome, hostVersion: '1.5.0',
        execOverrides: {
          tar: (_prog, args) => {
            if (args[0] === '-tzf') {
              // Listing reveals a traversal member → must be rejected.
              return { exitCode: 0, stdout: 'capability.json\n../../../etc/evil\n', stderr: '', signal: null, error: null };
            }
            extracted = true; // extraction must NOT happen
            return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
          },
        },
      }),
      /unsafe member path/i
    );
    assert.equal(extracted, false, 'extraction must not run when a member path is unsafe');
  });

  test('tarball containing a SYMLINK member is refused before extraction', async () => {
    const cap = featureCap('symmember-cap');
    const tgzBuf = _fakeTarball(cap);
    _setCapabilitySourceHttpGet(() => Promise.resolve({ statusCode: 200, body: tgzBuf }));
    let extracted = false;
    await assert.rejects(
      () => resolveCapabilitySource('https://example.com/sym.tgz', {
        gsdHome, hostVersion: '1.5.0',
        execOverrides: {
          tar: (_prog, args) => {
            if (args[0] === '-tzf') {
              // Names look safe...
              return { exitCode: 0, stdout: 'capability.json\nleak\n', stderr: '', signal: null, error: null };
            }
            if (args[0] === '-tvzf') {
              // ...but the verbose listing reveals a symlink member → reject.
              return { exitCode: 0, stdout: '-rw-r--r-- 0 u g 10 Jan 1 2020 capability.json\nlrwxr-xr-x 0 u g 0 Jan 1 2020 leak -> /etc/passwd\n', stderr: '', signal: null, error: null };
            }
            extracted = true;
            return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
          },
        },
      }),
      /symlink or hardlink member/i
    );
    assert.equal(extracted, false, 'extraction must not run when a symlink member is present');
  });
});

// ---------------------------------------------------------------------------
// Security: capability id path traversal → rejected
// ---------------------------------------------------------------------------

describe('security: path traversal in capability id', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('capability id containing ../ is rejected before staging', async () => {
    // Build a local dir with a capability.json whose id contains path traversal.
    const cap = featureCap('../evil-escape');
    const capDir = makeLocalCap(cap);

    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' }),
        /invalid|path separator|kebab-case|\.\./i
      );
    } finally {
      cleanup(capDir);
    }

    // Nothing must have been written under gsdHome.
    const capRoot = path.join(gsdHome, '.gsd', 'capabilities');
    if (fs.existsSync(capRoot)) {
      const entries = fs.readdirSync(capRoot).filter((e) => e !== '.staging');
      assert.strictEqual(entries.length, 0, 'no capability must be staged with traversal id');
    }
  });

  test('capability id containing / is rejected', async () => {
    const cap = featureCap('org/evil');
    const capDir = makeLocalCap(cap);

    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' }),
        /invalid|path separator|kebab-case/i
      );
    } finally {
      cleanup(capDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Staging atomicity: validation failure leaves no directory
// ---------------------------------------------------------------------------

describe('staging atomicity', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('validation failure leaves no directory under capabilities/ (only .staging may exist briefly)', async () => {
    // Deliberately invalid cap: missing required fields beyond id/version.
    const cap = { id: 'atomicity-test', version: '1.0.0', role: 'totally-invalid-role-xyz' };
    const capDir = makeLocalCap(cap);

    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' }),
        (err) => err instanceof Error
      );
    } finally {
      cleanup(capDir);
    }

    // The final capability directory must NOT exist.
    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'atomicity-test');
    assert.ok(!fs.existsSync(finalDir), 'Final capability dir must be absent after validation failure');

    // .staging dir should be cleaned up too (best-effort assertion — it's async).
    const stagingRoot = path.join(gsdHome, '.gsd', 'capabilities', '.staging');
    if (fs.existsSync(stagingRoot)) {
      const stagingEntries = fs.readdirSync(stagingRoot);
      assert.strictEqual(stagingEntries.length, 0, '.staging must be empty after cleanup');
    }
  });
});

// ---------------------------------------------------------------------------
// Fake tarball helper (not a real .tgz — the tar override bypasses extraction)
// ---------------------------------------------------------------------------

/**
 * Returns a Buffer that acts as a "tarball" for tests that inject a fake tar extractor.
 * The content is arbitrary; tests use the execOverrides.tar hook to write fixture files
 * into the extractDir instead of calling real tar.
 */
function _fakeTarball(cap) {
  // We just need a buffer; the injected tar override does the actual "extraction".
  return Buffer.from(JSON.stringify({ _fakeTarball: true, id: cap.id }), 'utf8');
}

// ---------------------------------------------------------------------------
// #1461 DOS-1 — realHttpsGet must BOUND the fetched response size. Without a cap,
// res.on('data') accumulates chunks and Buffer.concat'd into memory with no
// ceiling → a hostile/oversized tarball OOMs the process. Verified by injecting a
// fake low-level https.get (the _setHttpsGetImpl seam) that streams a response.
// ---------------------------------------------------------------------------

/**
 * Build a fake https.get implementation that drives realHttpsGet's streaming path.
 * @param chunks      array of Buffers to emit on the response 'data' events
 * @param headers     response headers (e.g. { 'content-length': '...' })
 * @param statusCode  response status (default 200)
 * Returns a function matching the https.get(url, opts, cb) shape. It captures whether
 * req.destroy() / res.destroy() were called so a test can assert the cap aborts the stream.
 */
function makeFakeHttpsGet(chunks, headers = {}, statusCode = 200) {
  const state = { reqDestroyed: false, resDestroyed: false, emittedBytes: 0, ended: false };
  const fn = (_url, _opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => { state.reqDestroyed = true; };
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = headers;
    res.destroy = () => { state.resDestroyed = true; };
    // Drive the response on the next tick so realHttpsGet has attached its listeners.
    setImmediate(() => {
      cb(res);
      for (const c of chunks) {
        if (state.reqDestroyed || state.resDestroyed) break;
        state.emittedBytes += c.length;
        res.emit('data', c);
      }
      if (!state.reqDestroyed && !state.resDestroyed) {
        state.ended = true;
        res.emit('end');
      }
    });
    return req;
  };
  fn.state = state;
  return fn;
}

describe('#1461 DOS-1 — realHttpsGet bounds the response size (MAX_RESPONSE_BYTES)', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-dos-home-'); });
  afterEach(() => {
    _setHttpsGetImpl(null); // restore the real https.get
    _setCapabilitySourceHttpGet(null);
    cleanup(gsdHome);
  });

  test('MAX_RESPONSE_BYTES is a sane bounded cap (64 MiB)', () => {
    assert.strictEqual(MAX_RESPONSE_BYTES, 64 * 1024 * 1024, 'cap is generous but bounded');
  });

  test('a streamed body exceeding MAX_RESPONSE_BYTES is rejected and not buffered unboundedly', async () => {
    // Stream chunks whose cumulative length exceeds the cap. Each chunk is 1 MiB; we emit cap+2
    // chunks. With the cap in place the stream is destroyed after crossing MAX_RESPONSE_BYTES, so
    // far fewer than all chunks are ever emitted.
    const ONE_MIB = 1024 * 1024;
    const chunkCount = MAX_RESPONSE_BYTES / ONE_MIB + 2; // 66 chunks of 1 MiB
    const chunks = Array.from({ length: chunkCount }, () => Buffer.alloc(ONE_MIB, 0x61));
    const fake = makeFakeHttpsGet(chunks, {} /* no content-length → exercise the streaming guard */);
    _setHttpsGetImpl(fake);

    // REVERT-FAILS: without the per-`data` size guard in realHttpsGet, all chunks are accumulated
    // and the promise RESOLVES with an oversized body (then proceeds to integrity/extraction) —
    // assert.rejects below fails because nothing rejected.
    await assert.rejects(
      () => resolveCapabilitySource('https://example.com/huge.tgz', { gsdHome, hostVersion: '1.5.0' }),
      /exceeds .*bytes/i,
      'an oversized streamed body must reject with the size error'
    );
    // The stream was aborted: the request/response were destroyed and NOT every chunk was emitted.
    assert.ok(fake.state.reqDestroyed || fake.state.resDestroyed, 'the request/response is destroyed on overflow');
    assert.ok(fake.state.emittedBytes <= (MAX_RESPONSE_BYTES + ONE_MIB),
      'streaming stops shortly after crossing the cap (not all chunks buffered)');
    assert.ok(!fake.state.ended, 'the response never reaches end — it was cut off');
  });

  test('a content-length header over the cap is rejected BEFORE buffering any body', async () => {
    // Advertise an oversized content-length but emit NO data — the early header check must reject.
    const fake = makeFakeHttpsGet([], { 'content-length': String(MAX_RESPONSE_BYTES + 1) });
    _setHttpsGetImpl(fake);

    // REVERT-FAILS: without the content-length pre-check in realHttpsGet, the (empty) stream simply
    // ends and the promise RESOLVES — assert.rejects fails because nothing rejected.
    await assert.rejects(
      () => resolveCapabilitySource('https://example.com/lying.tgz', { gsdHome, hostVersion: '1.5.0' }),
      /exceeds .*bytes|content-length/i,
      'an over-cap content-length must reject before buffering'
    );
    assert.strictEqual(fake.state.emittedBytes, 0, 'no body bytes were buffered before rejection');
    assert.ok(fake.state.reqDestroyed || fake.state.resDestroyed, 'the request/response is destroyed on the header check');
  });

  test('CONTROL: a normal small tarball still fetches + installs through realHttpsGet', async () => {
    // A small valid body that passes the cap. The high-level _httpGet seam is NOT used here — we go
    // through the real realHttpsGet via the injected low-level https.get so the size-cap code path is
    // exercised on the happy path too. A tar override performs the "extraction".
    const cap = featureCap('dos-control-cap');
    const tgzBuf = _fakeTarball(cap);
    const fake = makeFakeHttpsGet([tgzBuf], { 'content-length': String(tgzBuf.length) });
    _setHttpsGetImpl(fake);

    const result = await resolveCapabilitySource('https://example.com/dos-control-cap.tgz', {
      gsdHome,
      hostVersion: '1.5.0',
      execOverrides: {
        tar: (_prog, args) => {
          if (args[0] === '-tzf') {
            return { exitCode: 0, stdout: 'capability.json\n', stderr: '', signal: null, error: null };
          }
          if (args[0] === '-tvzf') {
            return { exitCode: 0, stdout: '-rw-r--r-- 0 user group 10 Jan  1 2020 capability.json\n', stderr: '', signal: null, error: null };
          }
          const extractDir = args[args.indexOf('-C') + 1];
          fs.writeFileSync(path.join(extractDir, 'capability.json'), JSON.stringify(cap), 'utf8');
          return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
        },
      },
    });

    assert.strictEqual(result.id, 'dos-control-cap', 'a normal small tarball resolves through the bounded fetch path');
    assert.ok(fs.existsSync(result.stagedDir), 'staged dir exists after a normal fetch+install');
    assert.ok(fake.state.ended, 'a within-cap body streams to completion');
  });
});

// ---------------------------------------------------------------------------
// #1461 finding 2 (HIGH) — the resolver/staging must read every UNTRUSTED
// capability.json via the shared bounded reader (regular-file + size cap), NOT a
// raw fs.readFileSync. A repo-planted/extracted oversized (or FIFO/non-regular)
// manifest would otherwise read unbounded into memory (OOM) or BLOCK the resolver.
// A null/oversized/non-regular read → reject the source with a clear error.
// ---------------------------------------------------------------------------
describe('#1461 finding 2 — untrusted capability.json reads are size-bounded (no OOM/hang)', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-cap-manifest-bound-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('MANIFEST_MAX_BYTES is a sane bounded cap (8 MiB)', () => {
    assert.strictEqual(MANIFEST_MAX_BYTES, 8 * 1024 * 1024, 'manifest cap is generous but bounded');
  });

  test('local: an OVERSIZED capability.json fails closed with a clear error (no OOM)', async () => {
    // Build a local bundle whose capability.json EXCEEDS the cap. The bounded reader's fstat-size
    // check refuses it WITHOUT reading the whole file into memory.
    const dir = createTempDir('gsd-cap-oversized-local-');
    try {
      // One byte over the cap is enough for the size check to refuse.
      const oversized = Buffer.alloc(MANIFEST_MAX_BYTES + 1, 0x20); // spaces (still "JSON-ish" length-wise)
      fs.writeFileSync(path.join(dir, 'capability.json'), oversized);

      // REVERT-FAILS: with a raw fs.readFileSync of capability.json, the whole oversized file is read
      // into memory and JSON.parse fails with a SYNTAX error (not the bounded-reader size error). The
      // bounded reader rejects on the fstat size BEFORE reading — so the error message names the size.
      await assert.rejects(
        () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' }),
        /exceeds|size|maximum|not a regular file|cannot read/i,
        'an oversized local capability.json must be refused by the bounded reader',
      );
    } finally {
      cleanup(dir);
    }
    assert.ok(!fs.existsSync(path.join(gsdHome, '.gsd', 'capabilities')) ||
      fs.readdirSync(path.join(gsdHome, '.gsd', 'capabilities')).filter((e) => e !== '.staging').length === 0,
      'no capability is staged after an oversized manifest is refused');
  });

  test('CONTROL: a small valid local capability.json still resolves through the bounded reader', async () => {
    const dir = makeLocalCap(featureCap('bounded-control-cap'));
    try {
      const result = await resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' });
      assert.strictEqual(result.id, 'bounded-control-cap', 'a small valid manifest still resolves');
      assert.ok(fs.existsSync(path.join(result.stagedDir, 'capability.json')), 'staged manifest present');
    } finally {
      cleanup(dir);
    }
  });

  test('local PRE-READ: an oversized capability.json is refused by the bounded reader (before any staging)', async () => {
    // HONEST SCOPE (#1461 finding 3): for a LOCAL source the adapter's bounded pre-read of
    // capability.json (to learn the id) runs FIRST and refuses an oversized manifest BEFORE staging —
    // so this proves the LOCAL PRE-READ bound, NOT the stageValidated staged re-read (an earlier
    // version of this test falsely claimed to exercise the staged re-read). The staged re-read is
    // covered directly below via _readManifestBounded.
    const dir = createTempDir('gsd-cap-oversized-stage-');
    try {
      const cap = featureCap('oversized-stage-cap');
      // A valid manifest padded past the cap via a large filler field — still parseable JSON shape but
      // over the byte cap, so the bounded reader refuses it on size.
      const padded = JSON.stringify({ ...cap, _filler: 'x'.repeat(MANIFEST_MAX_BYTES) });
      fs.writeFileSync(path.join(dir, 'capability.json'), padded);
      await assert.rejects(
        () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' }),
        /exceeds|size|maximum|cannot read/i,
        'an oversized local capability.json must be refused by the bounded pre-read',
      );
    } finally {
      cleanup(dir);
    }
  });

  test('staged re-read: the bounded manifest reader refuses an oversized staged capability.json directly', () => {
    // #1461 finding 3: exercise stageValidated's bounded re-read WITHOUT the local pre-read shadowing
    // it. _readManifestBounded is the exact reader stageValidated uses on the COPIED manifest; an
    // oversized staged file is refused on size (fail-closed), not read unbounded.
    //
    // REVERT-FAILS: with a raw fs.readFileSync in the staged re-read, this would read the whole
    // oversized file and either OOM or surface a JSON SyntaxError, not the bounded size refusal.
    const dir = createTempDir('gsd-cap-stagedread-direct-');
    try {
      const padded = Buffer.alloc(MANIFEST_MAX_BYTES + 1, 0x20); // spaces — over the cap by one byte.
      fs.writeFileSync(path.join(dir, 'capability.json'), padded);
      assert.throws(
        () => capSource._readManifestBounded(path.join(dir, 'capability.json'), 'capability.json not found'),
        /exceeds|size|maximum|not a regular file|cannot read|not found/i,
        'the bounded staged re-read refuses an oversized manifest on size',
      );
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// #1461 finding 1 (HIGH) — the STAGED bundle directory is byte-bounded UNIFORMLY.
// realHttpsGet is capped, but copyDirRecursive / git clone / npm pack / tar
// extraction RESULTS were only TIMEOUT-bounded, so a huge source tree / repo /
// package / tar bomb could fill disk during staging. stageValidated now enforces
// ONE aggregate byte-budget (MAX_STAGED_BUNDLE_BYTES) over the staged dir via a
// BOUNDED streaming walk AFTER staging and BEFORE validation/promotion — a single
// chokepoint that covers EVERY adapter (tar / npm / git / local).
// ---------------------------------------------------------------------------
describe('#1461 finding 1 — the staged bundle dir is aggregate-byte-bounded (uniform DoS bound)', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-cap-stagebudget-'); });
  afterEach(() => {
    _setCapabilitySourceHttpGet(null);
    cleanup(gsdHome);
  });

  test('MAX_STAGED_BUNDLE_BYTES is a sane bounded cap (128 MiB)', () => {
    assert.strictEqual(MAX_STAGED_BUNDLE_BYTES, 128 * 1024 * 1024, 'staged-bundle cap is generous but bounded');
  });

  test('local: a staged bundle whose TOTAL bytes exceed the budget is refused before promotion', async () => {
    // A valid small manifest (so id/validation pass), plus a sibling artifact whose size pushes the
    // bundle TOTAL over the budget. The bounded streaming walk in stageValidated sums regular-file
    // bytes and fails closed BEFORE validation/promotion.
    //
    // REVERT-FAILS: without the staged-dir aggregate budget, copyDirRecursive copies the oversized
    // artifact into staging and the source resolves+promotes normally — the oversized bundle lands on
    // disk. With the budget, the bounded walk throws and the source never resolves.
    const dir = createTempDir('gsd-cap-stagebudget-local-');
    try {
      fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(featureCap('stagebudget-cap')), 'utf8');
      // One byte over the budget across a single artifact is enough for the cumulative counter to trip.
      // ftruncate makes a sparse file so we don't actually write 128 MiB of real bytes (st.size still
      // reports the full length, which is what the budget walk sums).
      const big = path.join(dir, 'artifact.bin');
      const fd = fs.openSync(big, 'w');
      try { fs.ftruncateSync(fd, MAX_STAGED_BUNDLE_BYTES + 1); } finally { fs.closeSync(fd); }

      await assert.rejects(
        () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' }),
        /staged bundle|exceeds|budget|maximum|too large/i,
        'an over-budget staged bundle must be refused before promotion',
      );
    } finally {
      cleanup(dir);
    }
    const capRoot = path.join(gsdHome, '.gsd', 'capabilities');
    assert.ok(!fs.existsSync(capRoot) ||
      fs.readdirSync(capRoot).filter((e) => e !== '.staging').length === 0,
      'no capability is promoted after an over-budget bundle is refused');
    // The staging dir for the rejected bundle must be cleaned up (atomicity).
    const stagingRoot = path.join(capRoot, '.staging');
    if (fs.existsSync(stagingRoot)) {
      assert.strictEqual(fs.readdirSync(stagingRoot).length, 0, '.staging must be empty after an over-budget refusal');
    }
  });

  test('tarball: an extracted bundle over the budget is refused at the common staging chokepoint', async () => {
    // Drives the budget via the tarball adapter to prove the chokepoint is adapter-agnostic: the tar
    // override "extracts" an oversized artifact next to a valid manifest; stageValidated's budget walk
    // (after copyDirRecursive) rejects it.
    const cap = featureCap('stagebudget-tar-cap');
    const tgzBuf = _fakeTarball(cap);
    _setCapabilitySourceHttpGet(() => Promise.resolve({ statusCode: 200, body: tgzBuf }));
    await assert.rejects(
      () => resolveCapabilitySource('https://example.com/big.tgz', {
        gsdHome, hostVersion: '1.5.0',
        execOverrides: {
          tar: (_prog, args) => {
            if (args[0] === '-tzf') {
              return { exitCode: 0, stdout: 'capability.json\nbomb.bin\n', stderr: '', signal: null, error: null };
            }
            if (args[0] === '-tvzf') {
              return {
                exitCode: 0,
                stdout:
                  '-rw-r--r-- 0 user group 10 Jan  1 2020 capability.json\n' +
                  '-rw-r--r-- 0 user group 10 Jan  1 2020 bomb.bin\n',
                stderr: '', signal: null, error: null,
              };
            }
            // "extraction": write a valid manifest + an oversized (sparse) artifact into extractDir.
            const extractDir = args[args.indexOf('-C') + 1];
            fs.writeFileSync(path.join(extractDir, 'capability.json'), JSON.stringify(cap), 'utf8');
            const fd = fs.openSync(path.join(extractDir, 'bomb.bin'), 'w');
            try { fs.ftruncateSync(fd, MAX_STAGED_BUNDLE_BYTES + 1); } finally { fs.closeSync(fd); }
            return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
          },
        },
      }),
      /staged bundle|exceeds|budget|maximum|too large/i,
      'an over-budget extracted tarball must be refused at the staging chokepoint',
    );
    const capRoot = path.join(gsdHome, '.gsd', 'capabilities');
    assert.ok(!fs.existsSync(capRoot) ||
      fs.readdirSync(capRoot).filter((e) => e !== '.staging').length === 0,
      'no capability is promoted after an over-budget tarball is refused');
  });

  test('CONTROL: a within-budget bundle still resolves + promotes normally', async () => {
    const dir = makeLocalCap(featureCap('stagebudget-control-cap'));
    try {
      const result = await resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' });
      assert.strictEqual(result.id, 'stagebudget-control-cap', 'a within-budget bundle resolves');
      assert.ok(fs.existsSync(path.join(result.stagedDir, 'capability.json')), 'staged manifest present');
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// #1461 finding 1 (HIGH, ROUND 2) — copyDirRecursive itself is STREAMING +
// BUDGETED, so the COPY can never materialize a whole hostile directory.
//
// The post-copy assertStagedBundleWithinBudget walk is bounded, but it runs
// AFTER copyDirRecursive. The OLD copyDirRecursive used
// `fs.readdirSync(src, { withFileTypes: true })`, which materializes the ENTIRE
// directory-entry array into memory BEFORE the budget walk can run — so a
// hostile source tree with a directory holding millions of tiny entries
// (fetch < 64 MiB, but a colossal dirent array) OOMs the process during the
// COPY, before the post-copy budget can fail closed. copyDirRecursive now
// streams each directory via fs.opendirSync + dir.readSync() and threads a
// cumulative entry + byte counter, throwing the MOMENT either cap is exceeded —
// DURING the copy, before reading/copying the rest.
// ---------------------------------------------------------------------------
describe('#1461 finding 1 (ROUND 2) — copyDirRecursive streams + budgets the copy (no full materialization)', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-cap-copybudget-'); });
  afterEach(() => {
    _setCapabilitySourceHttpGet(null);
    cleanup(gsdHome);
  });

  test('MAX_STAGED_BUNDLE_ENTRIES is exported as a sane bounded cap (100k)', () => {
    assert.strictEqual(MAX_STAGED_BUNDLE_ENTRIES, 100_000, 'staged-bundle entry cap is generous but bounded');
  });

  test('a source dir with more than MAX_STAGED_BUNDLE_ENTRIES entries is refused, and the copy NEVER readdirSyncs the source', async () => {
    // ANTI-VACUOUS, two-pronged:
    //   (1) the bounded entry error fires (fail closed), AND
    //   (2) the COPY enumerated the source via opendirSync/readSync — it did NOT call the
    //       whole-array `fs.readdirSync(src, { withFileTypes:true })` materialization on the source.
    //
    // We don't actually create 100k real files (slow + disk). Instead we monkeypatch fs.opendirSync to
    // return a SYNTHETIC Dir whose readSync() yields lazily-generated tiny-file dirents far past the cap,
    // while a real on-disk capability.json + a few real files back the source so non-enumeration fs ops
    // still work. We also spy fs.readdirSync to PROVE the whole-array materialization is never used on
    // the source during the copy.
    //
    // REVERT-FAILS: reverting copyDirRecursive to `fs.readdirSync(src, { withFileTypes:true })` makes the
    // copy call readdirSync on the source (assertion (2) fails) AND would materialize the entire (here
    // synthetic, effectively unbounded) dirent array before any cap could trip.
    const src = createTempDir('gsd-cap-copybudget-src-');
    try {
      fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(featureCap('copybudget-cap')), 'utf8');

      const TOTAL_SYNTH = MAX_STAGED_BUNDLE_ENTRIES + 50_000; // far past the cap
      let readSyncCalls = 0;
      let readdirOnSrc = 0;
      let opendirOnSrc = 0;

      const realOpendir = fs.opendirSync;
      const realReaddir = fs.readdirSync;
      const realLstat = fs.lstatSync;
      const realCopyFile = fs.copyFileSync;

      // Make any per-entry lstat/copy of a synthetic file a no-op (the files don't exist on disk).
      fs.lstatSync = function patchedLstat(p, ...rest) {
        if (typeof p === 'string' && /[/\\]synth-\d+\.txt$/.test(p)) {
          return {
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => true,
            size: 1,
          };
        }
        return realLstat.call(this, p, ...rest);
      };
      fs.copyFileSync = function patchedCopyFile(s, d, ...rest) {
        if (typeof s === 'string' && /[/\\]synth-\d+\.txt$/.test(s)) return undefined;
        return realCopyFile.call(this, s, d, ...rest);
      };

      fs.readdirSync = function patchedReaddir(p, ...rest) {
        if (p === src) readdirOnSrc++;
        return realReaddir.call(this, p, ...rest);
      };

      fs.opendirSync = function patchedOpendir(p, ...rest) {
        if (p === src) {
          opendirOnSrc++;
          let i = 0;
          // A streaming Dir that yields the real manifest first, then synthetic tiny files lazily.
          return {
            readSync() {
              readSyncCalls++;
              if (i === 0) { i++; return makeDirent('capability.json', { file: true }); }
              if (i <= TOTAL_SYNTH) { const n = i++; return makeDirent(`synth-${n}.txt`, { file: true }); }
              return null;
            },
            closeSync() {},
            [Symbol.iterator]() { return this; },
          };
        }
        return realOpendir.call(this, p, ...rest);
      };

      try {
        await assert.rejects(
          () => resolveCapabilitySource(src, { gsdHome, hostVersion: '1.5.0' }),
          /entry count exceeds|maximum of 100000|too many entries/i,
          'a source with more than the entry cap must be refused during the streaming copy',
        );
      } finally {
        fs.opendirSync = realOpendir;
        fs.readdirSync = realReaddir;
        fs.lstatSync = realLstat;
        fs.copyFileSync = realCopyFile;
      }

      // (2a) The copy enumerated the source via the streaming opendir/readSync path.
      assert.ok(opendirOnSrc >= 1, 'copyDirRecursive must opendirSync the source (streaming)');
      assert.ok(readSyncCalls >= 1, 'copyDirRecursive must readSync the source (streaming)');
      // (2b) The copy did NOT use the whole-array readdirSync materialization on the source.
      assert.strictEqual(readdirOnSrc, 0, 'copyDirRecursive must NOT readdirSync the source (no full materialization)');
      // (2c) It aborted at ~the cap, NOT after enumerating all TOTAL_SYNTH entries.
      assert.ok(
        readSyncCalls <= MAX_STAGED_BUNDLE_ENTRIES + 5,
        `streaming copy must abort at ~the cap (readSync called ${readSyncCalls}, cap ${MAX_STAGED_BUNDLE_ENTRIES})`,
      );
    } finally {
      cleanup(src);
    }
    // Atomicity: nothing promoted; .staging cleaned up.
    const capRoot = path.join(gsdHome, '.gsd', 'capabilities');
    assert.ok(!fs.existsSync(capRoot) ||
      fs.readdirSync(capRoot).filter((e) => e !== '.staging').length === 0,
      'no capability is promoted after an over-entry-budget bundle is refused');
    const stagingRoot = path.join(capRoot, '.staging');
    if (fs.existsSync(stagingRoot)) {
      assert.strictEqual(fs.readdirSync(stagingRoot).length, 0, '.staging must be empty after an over-entry refusal');
    }
  });

  test('a source whose copied bytes exceed the budget is refused DURING the copy (cumulative byte counter)', async () => {
    // The streaming copy threads a cumulative BYTE counter too: an oversized regular file trips the byte
    // cap during the copy, before the rest of the tree is read/copied.
    //
    // REVERT-FAILS: the old copyDirRecursive copied everything unconditionally and relied solely on the
    // post-copy walk; if that post-copy walk were ALSO removed (and copy not budgeted), the oversized
    // artifact would land in staging. With the in-copy byte budget the copy itself fails closed.
    const src = createTempDir('gsd-cap-copybudget-bytes-');
    try {
      fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(featureCap('copybudget-bytes-cap')), 'utf8');
      const big = path.join(src, 'artifact.bin');
      const fd = fs.openSync(big, 'w');
      try { fs.ftruncateSync(fd, MAX_STAGED_BUNDLE_BYTES + 1); } finally { fs.closeSync(fd); }

      await assert.rejects(
        () => resolveCapabilitySource(src, { gsdHome, hostVersion: '1.5.0' }),
        /exceeds|budget|maximum|too large|staged bundle/i,
        'an over-byte-budget source must be refused during the streaming copy',
      );
    } finally {
      cleanup(src);
    }
    const capRoot = path.join(gsdHome, '.gsd', 'capabilities');
    assert.ok(!fs.existsSync(capRoot) ||
      fs.readdirSync(capRoot).filter((e) => e !== '.staging').length === 0,
      'no capability is promoted after an over-byte-budget bundle is refused');
  });

  test('CONTROL: a normal small source still stages through the streaming copy', async () => {
    const dir = createTempDir('gsd-cap-copybudget-control-');
    try {
      fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(featureCap('copybudget-control-cap')), 'utf8');
      fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'nested', 'extra.txt'), 'hello', 'utf8');

      const result = await resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' });
      assert.strictEqual(result.id, 'copybudget-control-cap', 'a within-budget bundle resolves');
      assert.ok(fs.existsSync(path.join(result.stagedDir, 'capability.json')), 'staged manifest present');
      assert.ok(fs.existsSync(path.join(result.stagedDir, 'nested', 'extra.txt')), 'nested file copied through the streaming copy');
      assert.strictEqual(fs.readFileSync(path.join(result.stagedDir, 'nested', 'extra.txt'), 'utf8'), 'hello', 'nested file bytes preserved');
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// #1461 finding 2 (MED) — the spoofable parseTarMemberSize header-size parse was
// REMOVED. The staged-dir aggregate budget (finding 1) is now the real bound on
// the extracted RESULT, so the fragile/spoofable BSD-vs-GNU date-token size scan
// is gone. The tar NAME/TYPE guards (traversal, symlink, hardlink) remain and a
// within-name/type tarball still resolves through extraction.
// ---------------------------------------------------------------------------
describe('#1461 finding 2 — tar header-size parse removed; NAME/TYPE guards remain', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-cap-tarsize-removed-'); });
  afterEach(() => {
    _setCapabilitySourceHttpGet(null);
    cleanup(gsdHome);
  });

  test('the spoofable per-member size cap export (MAX_TAR_MEMBER_BYTES) is REMOVED', () => {
    // REVERT-FAILS: if parseTarMemberSize / its export are re-introduced, this asserts the constant
    // is gone (the spoofable BSD-owner="Jan" mis-anchor fail-open is no longer relied upon).
    assert.strictEqual(capSource.MAX_TAR_MEMBER_BYTES, undefined, 'the spoofable per-member tar size cap is removed');
  });

  test('a tar with a HUGE declared member size (formerly rejected by the size parse) now extracts — and the staged budget is the real bound', async () => {
    // This listing once tripped the per-member size cap. With that removed, the NAME/TYPE guards pass
    // and extraction proceeds; a WITHIN-budget extracted result resolves normally. (An over-budget
    // result would be caught by finding 1's staged-dir budget, exercised in the finding-1 suite.)
    const cap = featureCap('tarsize-removed-cap');
    const tgzBuf = _fakeTarball(cap);
    _setCapabilitySourceHttpGet(() => Promise.resolve({ statusCode: 200, body: tgzBuf }));
    const result = await resolveCapabilitySource('https://example.com/huge-decl.tgz', {
      gsdHome, hostVersion: '1.5.0',
      execOverrides: {
        tar: (_prog, args) => {
          if (args[0] === '-tzf') {
            return { exitCode: 0, stdout: 'capability.json\n', stderr: '', signal: null, error: null };
          }
          if (args[0] === '-tvzf') {
            // A wildly large DECLARED size in the column — formerly rejected, now ignored.
            return { exitCode: 0, stdout: '-rw-r--r-- 0 user group 999999999999 Jan  1 2020 capability.json\n', stderr: '', signal: null, error: null };
          }
          const extractDir = args[args.indexOf('-C') + 1];
          fs.writeFileSync(path.join(extractDir, 'capability.json'), JSON.stringify(cap), 'utf8');
          return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
        },
      },
    });
    assert.strictEqual(result.id, 'tarsize-removed-cap', 'a huge-declared-size tar with safe names/types now extracts');
    assert.ok(fs.existsSync(result.stagedDir), 'staged dir exists after extraction');
  });
});

// ---------------------------------------------------------------------------
// #1463: pickHighestSemverTag — pure highest-stable-semver-tag parser
// ---------------------------------------------------------------------------

describe('#1463 pickHighestSemverTag (git ls-remote --tags parser)', () => {
  test('BOUNDARY: picks the NUMERIC max across v1.1.0/v1.2.0/v1.10.0 + junk (1.10.0, not 1.2.0)', () => {
    // revert-fails: a lexical (string) compare would pick "1.2.0" > "1.10.0"; the numeric compare
    // (compareSemverCore) must pick 1.10.0. Junk + a non-semver tag must be ignored.
    const out = [
      lsRemoteLine('v1.1.0'),
      lsRemoteLine('v1.2.0'),
      lsRemoteLine('v1.10.0'),
      lsRemoteLine('not-a-version'),
      lsRemoteLine('release-candidate'),
    ].join('\n');
    assert.strictEqual(pickHighestSemverTag(out), '1.10.0');
  });

  test('ignores ^{} peeled-annotation entries (same tag, not a distinct version)', () => {
    const out = [
      lsRemoteLine('v2.0.0'),
      lsRemoteLine('v2.0.0^{}'),
      lsRemoteLine('v1.5.0'),
    ].join('\n');
    assert.strictEqual(pickHighestSemverTag(out), '2.0.0');
  });

  test('ignores prerelease/non-triplet tags; bare (no-v) triplets accepted', () => {
    const out = [
      lsRemoteLine('v1.0.0-rc.1'),
      lsRemoteLine('1.4.2'),
      lsRemoteLine('v2'),
      lsRemoteLine('v1.0'),
    ].join('\n');
    assert.strictEqual(pickHighestSemverTag(out), '1.4.2');
  });

  test('no parseable semver tags → null', () => {
    assert.strictEqual(pickHighestSemverTag('0000\trefs/heads/main\n0000\trefs/tags/latest'), null);
    assert.strictEqual(pickHighestSemverTag(''), null);
  });

  test('PROPERTY (fc): result is the numeric max of the injected stable triplets, ignoring junk', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(50), fc.nat(50), fc.nat(50)), { minLength: 1, maxLength: 12 }),
        (triplets) => {
          const tags = triplets.map(([a, b, c]) => `v${a}.${b}.${c}`);
          // Interleave non-semver junk that must be ignored.
          const lines = [];
          for (const t of tags) {
            lines.push(lsRemoteLine(t));
            lines.push(lsRemoteLine('junk-' + t));        // non-triplet → ignored
            lines.push(lsRemoteLine(`${t}-rc.1`));         // prerelease → ignored
          }
          const got = pickHighestSemverTag(lines.join('\n'));
          // Expected max computed numerically (not lexically).
          const expected = triplets
            .slice()
            .sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]))
            .pop();
          return got === `${expected[0]}.${expected[1]}.${expected[2]}`;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// #1463: peekLatestVersion — per-source latest-version peek (ADR-1244 D6)
// ---------------------------------------------------------------------------

describe('#1463 peekLatestVersion (D6 per-source matrix)', () => {
  test('git: highest remote tag returned as latest (status ok)', () => {
    const fakeGit = (args) => {
      assert.ok(args.includes('ls-remote'), 'must use ls-remote (metadata only — no clone)');
      assert.ok(!args.includes('clone'), 'must NOT clone for a peek');
      return spawnOk([lsRemoteLine('v1.0.0'), lsRemoteLine('v1.3.0'), lsRemoteLine('v1.10.0')].join('\n'));
    };
    const r = peekLatestVersion('https://github.com/org/repo.git', { execOverrides: { git: fakeGit } });
    assert.deepStrictEqual(r, { status: 'ok', version: '1.10.0' });
  });

  test('git: ls-remote non-zero exit → status unknown (DEGRADE, no throw)', () => {
    const fakeGit = () => ({ exitCode: 128, stdout: '', stderr: 'fatal', signal: null, error: null });
    const r = peekLatestVersion('https://github.com/org/repo.git', { execOverrides: { git: fakeGit } });
    assert.strictEqual(r.status, 'unknown');
    assert.strictEqual(r.version, null);
  });

  test('git: ls-remote timeout (signal set) → status unknown', () => {
    // revert-fails: without the timeout→unknown branch, a killed peek (signal) would not degrade.
    const fakeGit = () => ({ exitCode: null, stdout: '', stderr: '', signal: 'SIGTERM', error: null });
    const r = peekLatestVersion('https://github.com/org/repo.git', { execOverrides: { git: fakeGit } });
    assert.strictEqual(r.status, 'unknown');
  });

  test('git: bounded timeout is passed to execGit (≤30s)', () => {
    let seenTimeout;
    const fakeGit = (_args, o) => { seenTimeout = o && o.timeout; return spawnOk(lsRemoteLine('v1.0.0')); };
    peekLatestVersion('https://github.com/org/repo.git', { execOverrides: { git: fakeGit } });
    assert.ok(typeof seenTimeout === 'number' && seenTimeout <= 30_000, `git peek must be bounded ≤30s (got ${seenTimeout})`);
  });

  test('git: source pinned to a commit SHA (#sha:…) → status pinned, NEVER outdated (update stays on the ref)', () => {
    // A `#sha:<commit>` pin is immutable: re-resolving the recorded source checks out the SAME commit,
    // so a newer remote tag is irrelevant. revert-fails: without the parsed.ref pinned check the peek
    // returns the highest tag with status 'ok', which outdatedCapabilities renders 'outdated' — this
    // assert (status 'pinned') then fails.
    const fakeGit = () => spawnOk([lsRemoteLine('v1.0.0'), lsRemoteLine('v9.9.9')].join('\n'));
    const r = peekLatestVersion('https://github.com/org/repo.git#sha:abcdef1234567890abcdef1234567890abcdef12', { execOverrides: { git: fakeGit } });
    assert.strictEqual(r.status, 'pinned');
  });

  test('git: source pinned to an explicit tag (#tag:…) → status pinned', () => {
    const fakeGit = () => spawnOk([lsRemoteLine('v1.0.0'), lsRemoteLine('v2.0.0')].join('\n'));
    const r = peekLatestVersion('https://github.com/org/repo.git#tag:v1.0.0', { execOverrides: { git: fakeGit } });
    assert.strictEqual(r.status, 'pinned');
  });

  test('git: bare ref (#<ref>) resolving to a TAG (refs/tags/…) → status pinned (immutable tag)', () => {
    // #1463 Fix 2 (R Medium): a bare `#<ref>` is ambiguous (tag OR branch). We classify it with a
    // bounded `git ls-remote <url> <ref>`. When the remote resolves it under refs/tags/ it is an
    // immutable tag → pinned. The ls-remote query is the SAME safe seam (argv + `--`).
    const fakeGit = (args) => {
      assert.ok(args.includes('ls-remote'), 'classification must use ls-remote (metadata only)');
      assert.ok(args.includes('--'), 'argv must terminate options with `--`');
      assert.ok(args.includes('release-1'), 'the bare ref is passed to ls-remote for classification');
      // ls-remote <url> <ref> prints the matching ref line(s).
      return spawnOk('1111111111111111111111111111111111111111\trefs/tags/release-1');
    };
    const r = peekLatestVersion('https://github.com/org/repo.git#release-1', { execOverrides: { git: fakeGit } });
    assert.strictEqual(r.status, 'pinned');
  });

  test('git: bare ref (#main) resolving to a BRANCH (refs/heads/…) → NEVER pinned (mutable; no installed sha ⇒ unknown)', () => {
    // #1463 Fix 2 (R Medium) — THE bug: `repo.git#main` is a MUTABLE branch (`update` re-clones and
    // checks out the ref, so it can move). The OLD isGitRefPinned reported ANY non-empty parsed.ref as
    // 'pinned', so this asserted 'pinned' and was WRONG. The ledger records NO installed commit sha for
    // git sources (integrity is null), so a moved branch HEAD cannot be compared → DEGRADE to 'unknown'.
    // revert-fails: with the old blanket isGitRefPinned this returns 'pinned' and the !== 'pinned'
    // assert below fails (and the === 'unknown' assert fails too).
    const fakeGit = (args) => {
      assert.ok(args.includes('ls-remote'), 'classification must use ls-remote');
      return spawnOk('2222222222222222222222222222222222222222\trefs/heads/main');
    };
    const r = peekLatestVersion('https://github.com/org/repo.git#main', { execOverrides: { git: fakeGit } });
    assert.notStrictEqual(r.status, 'pinned', 'a mutable branch ref must NEVER be reported pinned');
    assert.strictEqual(r.status, 'unknown', 'no installed sha recorded ⇒ cannot compare branch HEAD ⇒ unknown');
  });

  test('git: bare ref classification — ls-remote error/timeout → status unknown (DEGRADE, never pinned/crash)', () => {
    const errGit = () => ({ exitCode: 128, stdout: '', stderr: 'fatal', signal: null, error: null });
    const r1 = peekLatestVersion('https://github.com/org/repo.git#main', { execOverrides: { git: errGit } });
    assert.notStrictEqual(r1.status, 'pinned');
    assert.strictEqual(r1.status, 'unknown');
    const killGit = () => ({ exitCode: null, stdout: '', stderr: '', signal: 'SIGTERM', error: null });
    const r2 = peekLatestVersion('https://github.com/org/repo.git#main', { execOverrides: { git: killGit } });
    assert.strictEqual(r2.status, 'unknown');
  });

  test('git: bare ref classification — unresolvable/empty ls-remote output → status unknown (never pinned)', () => {
    const fakeGit = () => spawnOk('');
    const r = peekLatestVersion('https://github.com/org/repo.git#mystery-ref', { execOverrides: { git: fakeGit } });
    assert.notStrictEqual(r.status, 'pinned');
    assert.strictEqual(r.status, 'unknown');
  });

  test('git: bare ref classification — ls-remote returns BOTH refs/tags/<r> AND refs/heads/<r> (true ambiguity) → status unknown (NOT pinned)', () => {
    // #1463 accuracy fix: when ls-remote resolves a bare ref under BOTH refs/tags/ AND refs/heads/
    // the ref is genuinely ambiguous (a tag and a branch share the same name). The classifier must
    // NOT prefer the tag and report 'pinned' — the mutable branch reading means the ref could move.
    // The safe fallback is 'unknown'.
    // revert-fails: a classifier that scans lines and picks the FIRST refs/tags/ hit (or any tag-wins
    // strategy) would return 'pinned' here, making the notStrictEqual('pinned') assert below fail.
    const ambiguousRef = 'release-1';
    const fakeGit = (args) => {
      assert.ok(args.includes('ls-remote'), 'must use ls-remote for bare-ref classification');
      assert.ok(args.includes(ambiguousRef), 'the bare ref must be passed to ls-remote');
      // ls-remote output: same name exists as BOTH a tag and a branch head.
      return spawnOk(
        `1111111111111111111111111111111111111111\trefs/tags/${ambiguousRef}\n` +
        `2222222222222222222222222222222222222222\trefs/heads/${ambiguousRef}\n`,
      );
    };
    const r = peekLatestVersion(`https://github.com/org/repo.git#${ambiguousRef}`, { execOverrides: { git: fakeGit } });
    assert.notStrictEqual(r.status, 'pinned', 'ambiguous tag+branch ref must NEVER be reported pinned');
    assert.strictEqual(r.status, 'unknown', 'ambiguous ref degrades to unknown (safe fallback)');
  });

  test('git: bare ref classification — bounded timeout (≤30s) passed to the ls-remote classify call', () => {
    let seenTimeout;
    const fakeGit = (_args, o) => { seenTimeout = o && o.timeout; return spawnOk('33\trefs/heads/main'); };
    peekLatestVersion('https://github.com/org/repo.git#main', { execOverrides: { git: fakeGit } });
    assert.ok(typeof seenTimeout === 'number' && seenTimeout <= 30_000, `classify peek must be bounded ≤30s (got ${seenTimeout})`);
  });

  test('git: UNPINNED source (no #ref, tracks default branch) → highest tag with status ok (NOT pinned)', () => {
    // revert-fails-guard for over-pinning: an unpinned source must STILL peek and resolve a version.
    const fakeGit = () => spawnOk([lsRemoteLine('v1.0.0'), lsRemoteLine('v1.4.0')].join('\n'));
    const r = peekLatestVersion('https://github.com/org/repo.git', { execOverrides: { git: fakeGit } });
    assert.deepStrictEqual(r, { status: 'ok', version: '1.4.0' });
  });

  test('npm: RANGE spec — npm view prints EVERY matching version (real multi-line output) → highest matching is chosen', () => {
    // npm's REAL behaviour for `npm view <pkg>@<range> version`: when the range matches multiple
    // versions it prints one annotated line PER matching version, e.g.
    //   @org/gsd-cap-foo@1.0.0 '1.0.0'
    //   @org/gsd-cap-foo@1.3.0 '1.3.0'
    //   @org/gsd-cap-foo@1.10.0 '1.10.0'
    // (NOT a single bare token). The peek must parse ALL tokens and pick the HIGHEST numerically.
    // revert-fails: the old single-token NPM_VERSION_RE.test(stdout.trim()) parse sees multi-line
    // output as non-semver and DEGRADES to status 'unknown' — this assert then fails.
    const multiLine = [
      "@org/gsd-cap-foo@1.0.0 '1.0.0'",
      "@org/gsd-cap-foo@1.3.0 '1.3.0'",
      "@org/gsd-cap-foo@1.10.0 '1.10.0'",
    ].join('\n') + '\n';
    const fakeNpm = (args, o) => {
      assert.ok(args.includes('view'), 'must use npm view');
      assert.ok(typeof o.timeout === 'number' && o.timeout <= 60_000, 'npm peek must be bounded ≤60s');
      // Invocation shape is unchanged: ['view','--',<target>,'version'] with the range still on target.
      assert.deepStrictEqual(args, ['view', '--', '@org/gsd-cap-foo@^1', 'version']);
      return spawnOk(multiLine);
    };
    const r = peekLatestVersion('npm:@org/gsd-cap-foo@^1', { execOverrides: { npm: fakeNpm } });
    // 1.10.0 must beat 1.3.0 numerically (not lexically), and it satisfies ^1.
    assert.deepStrictEqual(r, { status: 'ok', version: '1.10.0' });
  });

  test('npm: RANGE spec — highest MATCHING version is bounded by the range (out-of-range versions ignored)', () => {
    // ^1 must NOT pick a 2.x even if npm happened to print one; the chosen version must satisfy the range.
    const multiLine = [
      "@org/cap@1.4.0 '1.4.0'",
      "@org/cap@1.9.0 '1.9.0'",
      "@org/cap@2.0.0 '2.0.0'",
    ].join('\n') + '\n';
    const r = peekLatestVersion('npm:@org/cap@^1', { execOverrides: { npm: () => spawnOk(multiLine) } });
    assert.deepStrictEqual(r, { status: 'ok', version: '1.9.0' });
  });

  test('npm: RANGE spec — installed < highest matching ⇒ caller sees newer; installed == highest ⇒ same', () => {
    // Two ledgers: the peek itself only resolves the highest-matching version; the outdated/current
    // decision lives in outdatedCapabilities. Here we lock the peek's resolution (the input to that).
    const multiLine = [
      "@org/cap@1.2.0 '1.2.0'",
      "@org/cap@1.5.0 '1.5.0'",
    ].join('\n') + '\n';
    const r = peekLatestVersion('npm:@org/cap@^1', { execOverrides: { npm: () => spawnOk(multiLine) } });
    assert.strictEqual(r.version, '1.5.0', 'highest matching is the version update would install');
  });

  test('npm: NO-version spec (tracks latest) — single bare latest line → status ok', () => {
    const fakeNpm = (args) => {
      // No version on the spec ⇒ target is just the bare name; npm view prints a single latest token.
      assert.deepStrictEqual(args, ['view', '--', '@org/gsd-cap-foo', 'version']);
      return spawnOk('2.4.1\n');
    };
    const r = peekLatestVersion('npm:@org/gsd-cap-foo', { execOverrides: { npm: fakeNpm } });
    assert.deepStrictEqual(r, { status: 'ok', version: '2.4.1' });
  });

  test('npm: EXACT-pinned spec (@1.2.3) → status pinned (update re-resolves to the SAME version, never outdated)', () => {
    // revert-fails: without the exact-pin → 'pinned' branch, the npm peek would run npm view and
    // compare, so a pinned source could be reported outdated; this assert requires status 'pinned'.
    let called = false;
    const fakeNpm = () => { called = true; return spawnOk('9.9.9\n'); };
    const r = peekLatestVersion('npm:@org/gsd-cap-foo@1.2.3', { execOverrides: { npm: fakeNpm } });
    assert.strictEqual(r.status, 'pinned');
    assert.strictEqual(r.version, '1.2.3', 'pinned reports the pinned exact version');
    assert.strictEqual(called, false, 'an exact-pinned npm source needs no remote peek (update will not move it)');
  });

  test('npm: npm view error/timeout → status unknown (no crash)', () => {
    const r1 = peekLatestVersion('npm:@org/cap@^1', { execOverrides: { npm: () => ({ exitCode: 1, stdout: '', stderr: 'E404', signal: null, error: null }) } });
    assert.strictEqual(r1.status, 'unknown');
    const r2 = peekLatestVersion('npm:@org/cap@^1', { execOverrides: { npm: () => ({ exitCode: null, stdout: '', stderr: '', signal: 'SIGTERM', error: null }) } });
    assert.strictEqual(r2.status, 'unknown');
  });

  test('npm: non-semver output → status unknown (untrusted output)', () => {
    const r = peekLatestVersion('npm:@org/cap@^1', { execOverrides: { npm: () => spawnOk('not a version\n') } });
    assert.strictEqual(r.status, 'unknown');
  });

  test('local: re-reads capability.json version (status ok)', () => {
    const dir = makeLocalCap(featureCap('local-peek', { version: '3.1.0' }));
    try {
      const r = peekLatestVersion(dir);
      assert.deepStrictEqual(r, { status: 'ok', version: '3.1.0' });
    } finally {
      cleanup(dir);
    }
  });

  test('local: missing path → status unknown (no throw)', () => {
    const r = peekLatestVersion('/no/such/path/that/exists');
    assert.strictEqual(r.status, 'unknown');
  });

  test('tarball: not auto-detectable → status manual (no version)', () => {
    const r = peekLatestVersion('https://host/path/cap-1.0.0.tgz');
    assert.strictEqual(r.status, 'manual');
    assert.strictEqual(r.version, null);
  });

  test('registry: unimplemented → status unsupported', () => {
    const r = peekLatestVersion('my-cap@gsd-registry');
    assert.strictEqual(r.status, 'unsupported');
    assert.strictEqual(r.version, null);
  });
});

// ---------------------------------------------------------------------------
// #1463: pure npm-spec / npm-view parsers (splitNpmSpec, pickHighestNpmVersion)
// ---------------------------------------------------------------------------

describe('#1463 splitNpmSpec (name vs version-selector)', () => {
  test('scoped package with exact version → split at the LAST @ (not the scope @)', () => {
    assert.deepStrictEqual(splitNpmSpec('@org/pkg@1.2.3'), { name: '@org/pkg', selector: '1.2.3' });
  });
  test('scoped package with range → selector is the range', () => {
    assert.deepStrictEqual(splitNpmSpec('@org/pkg@^1'), { name: '@org/pkg', selector: '^1' });
  });
  test('scoped package, no version → empty selector (tracks latest)', () => {
    assert.deepStrictEqual(splitNpmSpec('@org/pkg'), { name: '@org/pkg', selector: '' });
  });
  test('unscoped package with version → split at the single @', () => {
    assert.deepStrictEqual(splitNpmSpec('pkg@2.0.0'), { name: 'pkg', selector: '2.0.0' });
  });
  test('unscoped package, no version → empty selector', () => {
    assert.deepStrictEqual(splitNpmSpec('pkg'), { name: 'pkg', selector: '' });
  });
});

describe('#1463 pickHighestNpmVersion (robust multi-line range parse)', () => {
  test('multi-line annotated range output → highest matching (numeric, not lexical)', () => {
    const out = ["@org/pkg@1.2.0 '1.2.0'", "@org/pkg@1.10.0 '1.10.0'", "@org/pkg@1.3.0 '1.3.0'"].join('\n');
    assert.strictEqual(pickHighestNpmVersion(out, '^1'), '1.10.0');
  });
  test('range bound is honored — out-of-range versions ignored', () => {
    const out = ["@org/pkg@1.9.0 '1.9.0'", "@org/pkg@2.0.0 '2.0.0'"].join('\n');
    assert.strictEqual(pickHighestNpmVersion(out, '^1'), '1.9.0');
  });
  test('empty selector = no constraint → overall max', () => {
    const out = ["@org/pkg@1.9.0 '1.9.0'", "@org/pkg@2.4.0 '2.4.0'"].join('\n');
    assert.strictEqual(pickHighestNpmVersion(out, ''), '2.4.0');
  });
  test('single bare token (latest dist-tag) parses', () => {
    assert.strictEqual(pickHighestNpmVersion('2.4.1\n', ''), '2.4.1');
  });
  test('garbage / no version tokens → null (DEGRADE)', () => {
    assert.strictEqual(pickHighestNpmVersion('not a version\n', ''), null);
    assert.strictEqual(pickHighestNpmVersion('', '^1'), null);
  });
  test('no token satisfies the range → null', () => {
    const out = ["@org/pkg@2.0.0 '2.0.0'", "@org/pkg@3.0.0 '3.0.0'"].join('\n');
    assert.strictEqual(pickHighestNpmVersion(out, '^1'), null);
  });

  test('package NAME contains a version-like substring → resolves the RESOLVED version, not the name token', () => {
    // #1463 Fix 1 (R Medium): npm view (range) prints `<name>@<version> '<version>'`. When the package
    // NAME itself contains an `x.y.z`-shaped substring (`@scope/cap-1.2.3`), the version must come from
    // its CANONICAL position (the quoted token / the token after the LAST `@`), NOT any token on the line.
    // revert-fails: the old any-token regex matches `1.2.3` from the NAME first and returns it (the
    // highest token that satisfies ^1 is `1.5.0`, but `1.2.3` < `1.5.0`, so a name-poisoned parse could
    // also wrongly surface `1.2.3` as a candidate). With both lines present the CORRECT answer is 1.5.0.
    const out = [
      "@scope/cap-1.2.3@1.0.0 '1.0.0'",
      "@scope/cap-1.2.3@1.5.0 '1.5.0'",
    ].join('\n');
    assert.strictEqual(pickHighestNpmVersion(out, '^1'), '1.5.0');
  });

  test('single name-poisoned line → resolves the resolved version (not the name substring)', () => {
    // revert-fails: with one line `@scope/cap-1.2.3@1.0.0 '1.0.0'` and range `^1.0.0`, the any-token
    // regex picks `1.2.3` (the FIRST/HIGHEST satisfying token, from the NAME); the canonical parse must
    // return `1.0.0` (the resolved version). 1.2.3 !== 1.0.0 so the assert flips on revert.
    const out = "@scope/cap-1.2.3@1.0.0 '1.0.0'";
    assert.strictEqual(pickHighestNpmVersion(out, '^1.0.0'), '1.0.0');
  });

  test('property: with no range constraint, picks the numeric max of the printed versions', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(40), fc.nat(40), fc.nat(40)), { minLength: 1, maxLength: 12 }),
        (triplets) => {
          const lines = triplets.map(([a, b, c]) => `@org/pkg@${a}.${b}.${c} '${a}.${b}.${c}'`);
          const got = pickHighestNpmVersion(lines.join('\n'), '');
          const expected = triplets
            .slice()
            .sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]))
            .pop();
          return got === `${expected[0]}.${expected[1]}.${expected[2]}`;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// #3514 (epic #1900 F21) — fetch-transport hardening in realHttpsGet:
// a loopback/link-local/metadata host denylist (unconditional) and a distinct
// named reason for non-https URLs (no parse-time hard reject — internal-mirror
// classification flows stay intact; the https-only transport fails clearly).
// ---------------------------------------------------------------------------

describe('#3514 F21a — loopback/metadata denylist in realHttpsGet', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-3514-home-'); });
  afterEach(() => {
    _setHttpsGetImpl(null); // restore the real https.get
    cleanup(gsdHome);
  });

  /** Wrap makeFakeHttpsGet with a call counter so a test can prove the gate
   *  rejects BEFORE the transport is invoked. */
  function makeCountingFake(chunks, headers) {
    const inner = makeFakeHttpsGet(chunks, headers);
    const fn = (url, opts, cb) => {
      fn.calls += 1;
      return inner(url, opts, cb);
    };
    fn.calls = 0;
    fn.state = inner.state;
    return fn;
  }

  // Every entry: no legitimate install fetches these — loopback, link-local
  // (which contains the cloud metadata IPs), unspecified, or a localhost-form
  // name. REVERT-FAILS: pre-#3514 these reached the transport.
  for (const [label, url] of [
    ['loopback v4', 'https://127.0.0.1/cap.tgz'],
    ['loopback v4 high octet', 'https://127.255.0.1/cap.tgz'],
    ['cloud metadata v4', 'https://169.254.169.254/cap.tgz'],
    ['link-local v4', 'https://169.254.0.9/cap.tgz'],
    ['unspecified v4', 'https://0.0.0.0/cap.tgz'],
    ['loopback v6', 'https://[::1]/cap.tgz'],
    ['link-local v6', 'https://[fe80::1]/cap.tgz'],
    ['link-local v6 high', 'https://[febf::1]/cap.tgz'],
    ['unspecified v6', 'https://[::]/cap.tgz'],
    ['v4-mapped loopback', 'https://[::ffff:127.0.0.1]/cap.tgz'],
    ['v4-mapped loopback (hex-normalized)', 'https://[::ffff:7f00:1]/cap.tgz'],
    ['localhost', 'https://localhost/cap.tgz'],
    ['subdomain of localhost', 'https://svc.localhost/cap.tgz'],
    ['localhost with trailing FQDN dot', 'https://localhost./cap.tgz'],
  ]) {
    test(`denied host (${label}) rejects before the transport is called`, async () => {
      const fake = makeCountingFake([Buffer.from('x')]);
      _setHttpsGetImpl(fake);
      await assert.rejects(
        () => resolveCapabilitySource(url, { gsdHome, hostVersion: '1.5.0' }),
        /internal host|loopback|link-local|metadata|denylist/i,
        `${label} must be refused with the named denylist reason`
      );
      assert.strictEqual(fake.calls, 0, `the transport must NEVER be called for ${label}`);
    });
  }

  // Spec-review follow-up (#3514): alternate IPv4-literal spellings — decimal integer
  // (2130706433 = 127.0.0.1), hex (0x7f000001), octal (0177.0.0.1), and short forms (127.1) —
  // are host LITERALS, not DNS names, so they are inside the denylist's stated scope. The
  // WHATWG URL parser normalizes every form it accepts to dotted-quad BEFORE `.hostname`
  // (verified: new URL('https://2130706433/').hostname === '127.0.0.1'), so the gate's
  // dotted-quad range check already denies them — these tests LOCK that invariant, because
  // a future refactor to raw-string host matching would silently reopen the bypass.
  for (const [label, url] of [
    ['decimal integer form', 'https://2130706433/cap.tgz'],
    ['hex form', 'https://0x7f000001/cap.tgz'],
    ['hex per-octet form', 'https://0x7f.0.0.1/cap.tgz'],
    ['octal form', 'https://0177.0.0.1/cap.tgz'],
    ['short form', 'https://127.1/cap.tgz'],
  ]) {
    test(`alternate IP spelling (${label}) normalizes to a denied dotted-quad`, async () => {
      const fake = makeCountingFake([Buffer.from('x')]);
      _setHttpsGetImpl(fake);
      await assert.rejects(
        () => resolveCapabilitySource(url, { gsdHome, hostVersion: '1.5.0' }),
        /internal host|loopback|denylist/i,
        `${label} must be refused — it is the loopback literal in another spelling`
      );
      assert.strictEqual(fake.calls, 0);
    });
  }

  test('CONTROL: a public host still fetches through the gate', async () => {
    const cap = featureCap('gate-control-cap');
    const tgzBuf = _fakeTarball(cap);
    const fake = makeCountingFake([tgzBuf], { 'content-length': String(tgzBuf.length) });
    _setHttpsGetImpl(fake);
    const result = await resolveCapabilitySource('https://example.com/gate-control-cap.tgz', {
      gsdHome,
      hostVersion: '1.5.0',
      execOverrides: {
        tar: (_prog, args) => {
          if (args[0] === '-tzf') return { exitCode: 0, stdout: 'capability.json\n', stderr: '', signal: null, error: null };
          if (args[0] === '-tvzf') return { exitCode: 0, stdout: '-rw-r--r-- 0 user group 10 Jan  1 2020 capability.json\n', stderr: '', signal: null, error: null };
          const extractDir = args[args.indexOf('-C') + 1];
          fs.writeFileSync(path.join(extractDir, 'capability.json'), JSON.stringify(cap), 'utf8');
          return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
        },
      },
    });
    assert.strictEqual(result.id, 'gate-control-cap');
    assert.strictEqual(fake.calls, 1, 'the denylist is not an allowlist — public hosts fetch');
  });

  // Isolated-review Major 1: the fe80::/10 prefix test runs only on IPv6 literals — a
  // registered domain never contains ':'. A domain-shaped host starting fe8/fe9/fea/feb
  // (feather.internal, february.example.com) must NOT be denied.
  test('CONTROL: fe-prefixed DOMAIN hosts are not denied (the v6 branch requires a colon)', async () => {
    for (const host of ['feather.internal', 'february.example.com', 'fe9cdn.example.com']) {
      const fake = makeCountingFake([Buffer.from('x')]);
      _setHttpsGetImpl(fake);
      await assert.rejects(
        () => resolveCapabilitySource(`https://${host}/cap.tgz`, { gsdHome, hostVersion: '1.5.0' }),
        (err) => !/internal host|denylist|loopback/i.test(String(err && err.message)),
        `${host} is a domain, not an IPv6 literal — it must reach the transport`
      );
      assert.strictEqual(fake.calls, 1, `${host} must reach the transport`);
    }
  });

  test('CONTROL: a private-range mirror host is NOT denied (internal mirrors are legitimate)', async () => {
    const fake = makeCountingFake([Buffer.from('x')]);
    _setHttpsGetImpl(fake);
    // The flow proceeds PAST the gate into the transport (the body then fails
    // downstream as a non-tarball — irrelevant here; the assertion is that the
    // gate itself does not reject a private-range host).
    await assert.rejects(
      () => resolveCapabilitySource('https://192.168.1.10/cap.tgz', { gsdHome, hostVersion: '1.5.0' }),
      (err) => !/internal host|denylist|loopback/i.test(String(err && err.message))
    );
    assert.strictEqual(fake.calls, 1, 'a private-range host must reach the transport');
  });
});

describe('#3514 F21b — non-https tarball spec fails with a named reason', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-3514-http-home-'); });
  afterEach(() => {
    _setHttpsGetImpl(null);
    cleanup(gsdHome);
  });

  test('parseSpec STILL classifies an http:// tarball URL as tarball (no parse-time hard reject)', () => {
    const p = parseSpec('http://mirror.internal/cap.tgz');
    assert.strictEqual(p.kind, 'tarball', 'classification is unchanged — the gate lives in the fetcher');
  });

  test('an http:// tarball spec rejects with the https-only reason, not a raw protocol error', async () => {
    let calls = 0;
    const fake = (url, opts, cb) => { calls += 1; return makeFakeHttpsGet([])(url, opts, cb); };
    _setHttpsGetImpl(fake);
    await assert.rejects(
      () => resolveCapabilitySource('http://mirror.internal/cap.tgz', { gsdHome, hostVersion: '1.5.0' }),
      /requires https|plaintext|internal mirror/i,
      'the failure must name the https-only transport and the mirror alternative'
    );
    assert.strictEqual(calls, 0, 'the transport is never called for a plaintext URL');
  });
});

// ---------------------------------------------------------------------------
// #3929 — install-time cross-capability validation seeding
//
// `stageValidated` used to seed the cross-capability suite with a map holding ONLY the candidate
// (`new Map([[id, cap]])`), so every invariant resolved by map membership was either unsatisfiable
// (`requires`, concrete `runtimeCompat` ids) or vacuous (ownership, cycles, tier-monotone). The
// loader (`loadRegistry`) seeds first-party ∪ accepted overlays; these cases pin install-time
// validation to that same universe. All fixtures use tier `full` because `tdd` is tier `full` and
// tier-monotone — now actually reachable — forbids a lower tier requiring a higher one.
// ---------------------------------------------------------------------------

describe('regressions — #3929 install-time cross-capability validation set', () => {
  let gsdHome = '';
  let globalHome = '';
  let priorGsdHome;
  const capDirs = [];

  /** A tier-`full` feature manifest, the tier a capability requiring `tdd` must declare. */
  function fullCap(id, extra = {}) {
    return featureCap(id, { tier: 'full', ...extra });
  }

  /** Install `cap` into `scopeHome`'s overlay root as an already-present bundle. */
  function seedInstalled(id, contents, scopeHome = gsdHome) {
    const dir = path.join(scopeHome, '.gsd', 'capabilities', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'capability.json'), contents, 'utf8');
    return dir;
  }

  /** Write a `scopeHome` ledger marking `ids` as COMMITTED installs. */
  function seedLedger(ids, scopeHome = gsdHome) {
    const entries = {};
    for (const id of ids) {
      entries[id] = {
        id, version: '1.0.0', source: './' + id, integrity: 'sha512-x', files: [], sharedEdits: [],
      };
    }
    fs.writeFileSync(
      path.join(scopeHome, '.gsd-capabilities.json'),
      JSON.stringify({ version: '1', updatedAt: '2026-01-01T00:00:00.000Z', entries }),
      'utf8',
    );
  }

  beforeEach(() => {
    gsdHome = createTempDir('gsd-home-');
    // The seed also walks the GLOBAL overlay root, resolved as `GSD_HOME` else the user's home —
    // point it at an empty temp scope so these cases never read the developer's real installs.
    globalHome = createTempDir('gsd-global-home-');
    priorGsdHome = process.env.GSD_HOME;
    process.env.GSD_HOME = globalHome;
  });
  afterEach(() => {
    if (priorGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = priorGsdHome;
    cleanup(gsdHome);
    cleanup(globalHome);
    while (capDirs.length) cleanup(capDirs.pop());
  });

  /** makeLocalCap + track for cleanup. */
  function localCap(cap) {
    const dir = makeLocalCap(cap);
    capDirs.push(dir);
    return dir;
  }

  test('requires naming an installed FIRST-PARTY capability installs cleanly', async () => {
    const dir = localCap(fullCap('requires-first-party-cap', { requires: ['tdd'] }));
    const result = await resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.11.0' });
    assert.strictEqual(result.id, 'requires-first-party-cap');
    assert.ok(
      fs.existsSync(path.join(gsdHome, '.gsd', 'capabilities', 'requires-first-party-cap')),
      'the bundle must be promoted — `tdd` is first-party and must resolve at install time',
    );
  });

  test('requires naming a genuinely missing id still fails with the accurate message', async () => {
    const dir = localCap(fullCap('requires-missing-cap', { requires: ['no-such-cap-xyz'] }));
    await assert.rejects(
      () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.11.0' }),
      /requires "no-such-cap-xyz" which does not exist/,
    );
    assert.ok(
      !fs.existsSync(path.join(gsdHome, '.gsd', 'capabilities', 'requires-missing-cap')),
      'a rejected candidate must leave nothing behind',
    );
  });

  test('runtimeCompat naming a first-party runtime installs; an unknown runtime still fails', async () => {
    const okDir = localCap(fullCap('runtime-known-cap', {
      runtimeCompat: { supported: ['claude'], unsupported: [] },
    }));
    const okResult = await resolveCapabilitySource(okDir, { gsdHome, hostVersion: '1.11.0' });
    assert.strictEqual(okResult.id, 'runtime-known-cap');

    const badDir = localCap(fullCap('runtime-unknown-cap', {
      runtimeCompat: { supported: ['no-such-runtime'], unsupported: [] },
    }));
    await assert.rejects(
      () => resolveCapabilitySource(badDir, { gsdHome, hostVersion: '1.11.0' }),
      /references unknown runtime "no-such-runtime"/,
    );
  });

  test('requires naming a COMMITTED third-party capability in the target scope installs cleanly', async () => {
    seedInstalled('dep-cap', JSON.stringify(fullCap('dep-cap')));
    seedLedger(['dep-cap']);
    const dir = localCap(fullCap('dependent-cap', { requires: ['dep-cap'] }));
    const result = await resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.11.0' });
    assert.strictEqual(result.id, 'dependent-cap');
  });

  test('an overlay with NO committed ledger entry does not satisfy requires (load-time parity)', async () => {
    // Load-time skips a bundle that was never committed to the ledger, so install-time must not
    // let it satisfy a dependency either — otherwise install succeeds and the loader then drops it.
    seedInstalled('uncommitted-cap', JSON.stringify(fullCap('uncommitted-cap')));
    const dir = localCap(fullCap('needs-uncommitted-cap', { requires: ['uncommitted-cap'] }));
    await assert.rejects(
      () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.11.0' }),
      /requires "uncommitted-cap" which does not exist/,
    );
  });

  test('a malformed installed bundle is skipped, not fatal, for an unrelated install', async () => {
    seedInstalled('broken-cap', '{ this is not json');
    seedLedger(['broken-cap']);
    const dir = localCap(fullCap('unrelated-cap', { requires: ['tdd'] }));
    const result = await resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.11.0' });
    assert.strictEqual(result.id, 'unrelated-cap', 'a broken neighbour must not block an install');
  });

  test('a project-scope install resolves requires against a GLOBALLY installed capability', async () => {
    // The loader composes global ∪ project, so a project-scope install must see the global scope too.
    seedInstalled('global-dep-cap', JSON.stringify(fullCap('global-dep-cap')), globalHome);
    seedLedger(['global-dep-cap'], globalHome);
    const dir = localCap(fullCap('project-needs-global-cap', { requires: ['global-dep-cap'] }));
    const result = await resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.11.0' });
    assert.strictEqual(result.id, 'project-needs-global-cap');
  });

  test('an UNCOMMITTED global bundle does not satisfy a project-scope requires', async () => {
    seedInstalled('global-uncommitted-cap', JSON.stringify(fullCap('global-uncommitted-cap')), globalHome);
    const dir = localCap(fullCap('needs-global-uncommitted-cap', { requires: ['global-uncommitted-cap'] }));
    await assert.rejects(
      () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.11.0' }),
      /requires "global-uncommitted-cap" which does not exist/,
    );
  });

  test('reinstalling over an existing bundle validates the CANDIDATE, not the installed copy', async () => {
    // The same-id bundle already on disk is REPLACED by the candidate, so it must be excluded from
    // the seed — otherwise its own declarations collide with the candidate's (self-ownership).
    seedInstalled('self-replace-cap', JSON.stringify(fullCap('self-replace-cap', { skills: ['sr-skill'] })));
    seedLedger(['self-replace-cap']);
    const dir = localCap(fullCap('self-replace-cap', { version: '2.0.0', skills: ['sr-skill'] }));
    const result = await resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.11.0' });
    assert.strictEqual(result.version, '2.0.0');
  });
});

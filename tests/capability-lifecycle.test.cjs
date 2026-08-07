'use strict';

/**
 * Tests for capability lifecycle orchestration — ADR-1244 Phase 4 (D5 + D6).
 * Covers install (consent / abort / block), upgrade (atomic stage-then-swap, ledger commit
 * point, executable-set re-consent), remove (surgical marker-isolated strip + the user
 * hand-edit fault case), and the crash-recovery reconciliation sweep.
 *
 * The bulk of the logic is exercised through an injectable `_resolve` seam (so tests are not
 * coupled to full capability validation); one test drives the REAL resolver end-to-end.
 */

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const lifecycle = require('../gsd-core/bin/lib/capability-lifecycle.cjs');
const ledgerMod = require('../gsd-core/bin/lib/capability-ledger.cjs');
const { CAP_MARKER } = lifecycle;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { runHook } = require('./helpers/process-seam.cjs');
// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
/** POSIX-only: make a FIFO at `p` (returns false where mkfifo is unavailable). */
function tryMkfifoLife(p) {
  if (process.platform === 'win32') return false;
  const res = runHook(p, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS });
  return res.exitCode === 0;
}

const cleanups = [];
function runtime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-life-'));
  cleanups.push(dir);
  return dir;
}
test.after(() => {
  for (const d of cleanups) cleanup(d);
});

function declarativeCap(id, version = '1.0.0') {
  return {
    id,
    role: 'feature',
    version,
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
  };
}

function execCap(id, version, { script = 'hooks/run.js', mcp = null } = {}) {
  const cap = declarativeCap(id, version);
  cap.hooks = [{ event: 'PostToolUse', script }];
  if (mcp) cap.mcpServers = mcp;
  return cap;
}

let stageCounter = 0;
/** Materialize a declared artifact file inside the staged bundle (so the trust gate's
 *  existence check passes), skipping absolute/traversal paths. */
function materialize(dir, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) return;
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '// artifact', 'utf8');
}
/** Build a `_resolve` seam that stages `manifest` (and its declared artifacts) under .staging. */
function fakeResolve(manifest, { integrity = null, throwErr = null } = {}) {
  return async (spec, opts) => {
    if (throwErr) throw new Error(throwErr);
    const root = path.join(opts.gsdHome, '.gsd', 'capabilities', '.staging');
    fs.mkdirSync(root, { recursive: true });
    const dir = path.join(root, `${manifest.id}-${++stageCounter}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(manifest), 'utf8');
    for (const h of manifest.hooks || []) if (h && h.script) materialize(dir, h.script);
    for (const c of manifest.commands || []) if (c && c.module) materialize(dir, c.module);
    return { id: manifest.id, version: manifest.version, stagedDir: dir, integrity, source: spec };
  };
}

function readLedgerEntry(dir, id) {
  const l = ledgerMod.readLedger(dir);
  return l && l.entries[id] ? l.entries[id] : null;
}
function readSettings(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch { return null; }
}
function capManifestVersion(dir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.gsd', 'capabilities', id, 'capability.json'), 'utf8')).version;
  } catch { return null; }
}
/**
 * #1460 CONF-1: the expected absolute hook command — `script` resolved against the
 * capability install dir and confined via realpath of the existing ancestor chain
 * (so an ancestor symlink cannot escape). Mirrors confinedBundleScript in the source.
 */
function expectedBundleCommand(dir, id, script) {
  const capDir = path.join(dir, '.gsd', 'capabilities', id);
  const target = path.resolve(capDir, script);
  let parent = path.dirname(target);
  try { parent = fs.realpathSync(parent); } catch { /* lexical fallback below */ }
  return path.join(parent, path.basename(target));
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

test('install: declarative capability installs without consent and records the ledger', async () => {
  const dir = runtime();
  const res = await lifecycle.installCapability('./decl', {
    runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('decl')),
  });
  assert.strictEqual(res.status, 'installed');
  const entry = readLedgerEntry(dir, 'decl');
  assert.ok(entry, 'ledger entry recorded');
  assert.strictEqual(entry.version, '1.0.0');
  assert.ok(fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'decl', 'capability.json')));
});

test('install: executable capability without consent aborts and writes NOTHING', async () => {
  const dir = runtime();
  const res = await lifecycle.installCapability('./exec', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: false, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('exec', '1.0.0')),
  });
  assert.strictEqual(res.status, 'aborted');
  assert.strictEqual(res.requiresConsent, true);
  assert.strictEqual(readLedgerEntry(dir, 'exec'), null, 'no ledger entry');
  assert.ok(!fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'exec')), 'no install dir');
  assert.strictEqual(readSettings(dir), null, 'no settings.json written');
});

test('install: executable capability with consent installs and applies marked shared edits', async () => {
  const dir = runtime();
  const res = await lifecycle.installCapability('./exec', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('exec', '1.0.0', { mcp: { 'cap-srv': { command: 'node' } } })),
  });
  assert.strictEqual(res.status, 'installed');
  const settings = readSettings(dir);
  assert.ok(settings.hooks.PostToolUse.length === 1);
  assert.strictEqual(settings.hooks.PostToolUse[0][CAP_MARKER], 'exec');
  assert.strictEqual(settings.mcpServers['cap-srv'][CAP_MARKER], 'exec');
  const entry = readLedgerEntry(dir, 'exec');
  assert.deepStrictEqual(entry.sharedEdits, [{ file: 'settings.json', marker: 'exec' }]);
});

test('install: a disallowed source is blocked BEFORE the resolver runs', async () => {
  const dir = runtime();
  let resolverCalled = false;
  const res = await lifecycle.installCapability('https://github.com/x/y.git', {
    runtimeDir: dir, hostVersion: '1.6.0', strictKnownRegistries: [],
    _resolve: async () => { resolverCalled = true; throw new Error('should not run'); },
  });
  assert.strictEqual(res.status, 'blocked');
  assert.strictEqual(resolverCalled, false, 'resolver must not be invoked for a blocked source');
  assert.strictEqual(readLedgerEntry(dir, 'y'), null);
});

test('install: a reserved-namespace capability is blocked', async () => {
  const dir = runtime();
  const res = await lifecycle.installCapability('./x', {
    runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('gsd-evil')),
  });
  assert.strictEqual(res.status, 'blocked');
  assert.ok(res.blockReasons.some((r) => /reserved namespace/.test(r)));
  assert.ok(!fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'gsd-evil')));
});

test('install: engines mismatch is blocked at install WITH a compatVersions downgrade hint', async () => {
  const dir = runtime();
  const cap = declarativeCap('eng', '3.0.0');
  cap.engines = { gsd: '>=2.0.0' };
  cap.compatVersions = { '1.4.0': '>=1.5.0 <2.0.0' };
  const res = await lifecycle.installCapability('./eng', {
    runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(cap),
  });
  assert.strictEqual(res.status, 'blocked');
  assert.ok(res.blockReasons.some((r) => /compatVersions offers 1\.4\.0/.test(r)), JSON.stringify(res.blockReasons));
  assert.strictEqual(readLedgerEntry(dir, 'eng'), null);
});

test('integration: engines-incompatible local cap is blocked by the lifecycle, not the resolver throw (skipEnginesGate)', async () => {
  const dir = runtime();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-src-eng-'));
  cleanups.push(src);
  const cap = declarativeCap('engreal');
  cap.engines = { gsd: '>=99.0.0' };
  fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap), 'utf8');
  const res = await lifecycle.installCapability(src, { runtimeDir: dir, hostVersion: '1.6.0' });
  assert.strictEqual(res.status, 'blocked', JSON.stringify(res));
  assert.ok(res.blockReasons.some((r) => /engines\.gsd/.test(r)));
  assert.ok(!fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'engreal')), 'nothing installed');
  const staging = path.join(dir, '.gsd', 'capabilities', '.staging');
  assert.deepStrictEqual(fs.existsSync(staging) ? fs.readdirSync(staging) : [], [], 'staging cleaned');
});

test('install: re-installing over an existing capability (via install, not upgrade) advances the bundle + ledger, no backup lingers', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0')),
  });
  const res = await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '2.0.0')),
  });
  assert.strictEqual(res.status, 'installed');
  assert.strictEqual(capManifestVersion(dir, 'e'), '2.0.0');
  assert.strictEqual(readLedgerEntry(dir, 'e').version, '2.0.0');
  assert.ok(!readLedgerEntry(dir, 'e')._pending, 'intent cleared on commit');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.gsd', 'capabilities')).filter((n) => n.includes('.upgrading-')), [], 'no backup left');
  assert.strictEqual(readSettings(dir).hooks.PostToolUse.length, 1, 'exactly one stamped hook');
});

test('install: a deadman-stale lock is stolen so a crashed prior holder does not block forever', async () => {
  const dir = runtime();
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // A legacy no-pid body: liveness cannot be verified, so (finding 1) it is reclaimable ONLY by the
  // HARD deadman timeout — backdate it past LOCK_DEADMAN_MS (10 min) to simulate a crashed holder the
  // deadman must eventually free. (An under-deadman no-pid lock is intentionally NOT stolen; that case
  // is covered in the finding-1 lock suite.)
  fs.writeFileSync(lockPath, 'dead-holder-token', 'utf8');
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);
  const res = await lifecycle.installCapability('./x', {
    runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('x')),
  });
  assert.strictEqual(res.status, 'installed', 'deadman-stale lock stolen, install proceeds');
});

test('install: a resolver failure (e.g. integrity mismatch) is reported as blocked', async () => {
  const dir = runtime();
  const res = await lifecycle.installCapability('./x', {
    runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('x'), { throwErr: 'Integrity mismatch: expected ... got ...' }),
  });
  assert.strictEqual(res.status, 'blocked');
  assert.ok(res.blockReasons.some((r) => /Integrity mismatch/.test(r)));
});

// ---------------------------------------------------------------------------
// Upgrade
// ---------------------------------------------------------------------------

test('upgrade: a not-installed capability cannot be upgraded', async () => {
  const dir = runtime();
  const res = await lifecycle.upgradeCapability('./x', {
    runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('x', '2.0.0')),
  });
  assert.strictEqual(res.status, 'not_installed');
});

test('upgrade: same executable set upgrades without re-consent; bundle + ledger advance, no backup left', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0')),
  });
  const res = await lifecycle.upgradeCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: false, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '2.0.0')), // same hook script => same exec set
  });
  assert.strictEqual(res.status, 'upgraded');
  assert.strictEqual(res.fromVersion, '1.0.0');
  assert.strictEqual(res.toVersion, '2.0.0');
  assert.strictEqual(capManifestVersion(dir, 'e'), '2.0.0');
  assert.strictEqual(readLedgerEntry(dir, 'e').version, '2.0.0');
  const leftovers = fs.readdirSync(path.join(dir, '.gsd', 'capabilities')).filter((n) => n.includes('.upgrading-'));
  assert.deepStrictEqual(leftovers, [], 'no backup dir left behind');
  // Exactly one stamped hook remains (old stripped, new applied).
  assert.strictEqual(readSettings(dir).hooks.PostToolUse.length, 1);
});

test('upgrade: a changed executable set without consent aborts and leaves the OLD version fully intact', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0', { script: 'hooks/a.js' })),
  });
  const res = await lifecycle.upgradeCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: false, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '2.0.0', { script: 'hooks/b.js' })), // changed script => changed exec set
  });
  assert.strictEqual(res.status, 'aborted');
  assert.strictEqual(res.requiresConsent, true);
  assert.strictEqual(capManifestVersion(dir, 'e'), '1.0.0', 'old bundle untouched');
  assert.strictEqual(readLedgerEntry(dir, 'e').version, '1.0.0', 'old ledger untouched');
  // #1460 CONF-1/(R): command is the ABSOLUTE confined path inside the bundle (POSIX single-quoted), not the raw relative form.
  assert.strictEqual(readSettings(dir).hooks.PostToolUse[0].hooks[0].command, nodeQuoted(expectedBundleCommand(dir, 'e', 'hooks/a.js')));
});

test('upgrade: a changed executable set WITH consent upgrades and re-derives shared edits', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0', { script: 'hooks/a.js' })),
  });
  const res = await lifecycle.upgradeCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '2.0.0', { script: 'hooks/b.js' })),
  });
  assert.strictEqual(res.status, 'upgraded');
  const hooks = readSettings(dir).hooks.PostToolUse;
  assert.strictEqual(hooks.length, 1);
  // #1460 CONF-1/(R): re-derived command is the ABSOLUTE confined path inside the bundle (POSIX single-quoted).
  assert.strictEqual(hooks[0].hooks[0].command, nodeQuoted(expectedBundleCommand(dir, 'e', 'hooks/b.js')), 'old shared edit stripped, new applied (node + quoted absolute confined path)');
});

// ---------------------------------------------------------------------------
// #1460 (R) HIGH: the emitted hook `command` must be shell-safe
// ---------------------------------------------------------------------------
// A hook `command` string is consumed by a shell (first-party hooks emit
// `node "${CLAUDE_PLUGIN_ROOT}/hooks/x.js"`). The non-manifest install-prefix
// (the home/runtime dir) commonly contains spaces (e.g. "/Users/Bob Smith/...")
// — written unquoted it word-splits and breaks (or, with a hostile prefix,
// could inject). The emitted absolute command must be POSIX single-quoted.

/** A runtime dir whose absolute path contains a SPACE (mirrors "/Users/Bob Smith/.claude"). */
function runtimeWithSpace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cap life-'));
  cleanups.push(base);
  const dir = path.join(base, 'Bob Smith', '.claude');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** POSIX single-quote a string the way applyCapabilitySharedEdits must. */
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
/** #1634: a `.js`-family hook command is emitted as `node ` + the POSIX-quoted absolute path. */
function nodeQuoted(p) {
  return 'node ' + shQuote(p);
}

test('#1460 (R): emitted hook command is single-quoted when the install prefix contains a space', async () => {
  const dir = runtimeWithSpace();
  assert.ok(dir.includes(' '), 'precondition: install prefix contains a space');
  const res = await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0', { script: 'hooks/format.sh' })),
  });
  assert.strictEqual(res.status, 'installed', JSON.stringify(res));
  const command = readSettings(dir).hooks.PostToolUse[0].hooks[0].command;
  const expectedAbs = expectedBundleCommand(dir, 'e', 'hooks/format.sh');
  // revert-fails: without quoting the command is the bare space-containing absolute path,
  // which a shell would word-split (the second token would be executed as a command).
  assert.strictEqual(command, shQuote(expectedAbs), 'command must be POSIX single-quoted');
  // Defense-in-depth: emulate POSIX word-splitting — single-quoted runs are atomic (whitespace
  // inside them does NOT split). The quoted command must collapse to exactly ONE word (the path).
  const words = command.match(/'[^']*'|[^\s']+/g) || [];
  assert.strictEqual(words.length, 1, 'quoting must keep the space-containing path as a single shell word');
  assert.strictEqual(words[0], command, 'the single word IS the entire quoted command');
  // Negative control: the UNQUOTED path would split into >1 word at the space (the bug this prevents).
  assert.ok((expectedAbs.match(/'[^']*'|[^\s']+/g) || []).length > 1, 'precondition: the bare path word-splits');
});

test('#1460 (R): a normal script under a normal prefix emits the quoted absolute command and stays strippable by CAP_MARKER', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0', { script: 'hooks/run.js' })),
  });
  const before = readSettings(dir).hooks.PostToolUse;
  assert.strictEqual(before.length, 1);
  assert.strictEqual(before[0][CAP_MARKER], 'e');
  // revert-fails: without quoting the control command is the bare absolute path.
  assert.strictEqual(before[0].hooks[0].command, nodeQuoted(expectedBundleCommand(dir, 'e', 'hooks/run.js')));
  // Strip is keyed on CAP_MARKER===capId, NOT the command string — quoting does not break it.
  const rem = await lifecycle.removeCapability('e', {
    runtimeDir: dir, hostVersion: '1.6.0', sharedFiles: ['settings.json'],
  });
  assert.strictEqual(rem.status, 'removed', JSON.stringify(rem));
  const after = readSettings(dir);
  assert.ok(!after || !after.hooks || !after.hooks.PostToolUse || after.hooks.PostToolUse.length === 0,
    'the stamped hook is stripped by CAP_MARKER regardless of quoting');
});

test('#1460 (R): idempotent strip-then-reapply yields the identical quoted command', () => {
  const dir = runtime();
  const capId = 'e';
  const capDirPath = path.join(dir, '.gsd', 'capabilities', capId);
  fs.mkdirSync(path.join(capDirPath, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(capDirPath, 'hooks', 'run.js'), '// x', 'utf8');
  const manifest = execCap(capId, '1.0.0', { script: 'hooks/run.js' });
  const apply = () => lifecycle.applyCapabilitySharedEdits({
    runtimeDir: dir, capId, manifest, sharedFiles: ['settings.json'],
  });
  const edits = apply();
  const first = readSettings(dir).hooks.PostToolUse;
  // The real install/upgrade transition is strip-then-apply; re-running it must converge.
  lifecycle.stripCapabilitySharedEdits({ runtimeDir: dir, capId, sharedEdits: edits });
  apply();
  const second = readSettings(dir).hooks.PostToolUse;
  assert.strictEqual(second.length, 1, 'idempotent: still exactly one stamped hook after strip+reapply');
  assert.strictEqual(second[0].hooks[0].command, first[0].hooks[0].command, 'identical quoted command on re-apply');
  assert.strictEqual(second[0].hooks[0].command, nodeQuoted(expectedBundleCommand(dir, capId, 'hooks/run.js')));
});

// ---------------------------------------------------------------------------
// #1634: a declared tool-scoping `matcher` must be honored, and a .js-family
// hook command must run without relying on the source's executable bit.
// ---------------------------------------------------------------------------
test('#1634: a declared matcher is preserved on the emitted shared-config hook entry', () => {
  const dir = runtime();
  const capId = 'toolkit';
  const capDirPath = path.join(dir, '.gsd', 'capabilities', capId);
  fs.mkdirSync(path.join(capDirPath, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(capDirPath, 'hooks', 'genfile-guard.cjs'), '// guard\n', 'utf8');
  const manifest = declarativeCap(capId, '1.0.0');
  manifest.hooks = [{ event: 'PreToolUse', script: 'hooks/genfile-guard.cjs', matcher: 'Write|Edit' }];

  lifecycle.applyCapabilitySharedEdits({ runtimeDir: dir, capId, manifest, sharedFiles: ['settings.json'] });

  const entry = readSettings(dir).hooks.PreToolUse[0];
  assert.strictEqual(entry[CAP_MARKER], capId, 'entry is stamped with the capability marker');
  // revert-fails: matcher was dropped, so the hook fired on every tool (Bash/Read/Write/Edit).
  assert.strictEqual(entry.matcher, 'Write|Edit', 'declared matcher is preserved so the hook is tool-scoped');
});

test('#1634: an absent matcher is omitted (match-all) so shipped capabilities stay unchanged', () => {
  const dir = runtime();
  const capId = 'plain';
  const capDirPath = path.join(dir, '.gsd', 'capabilities', capId);
  fs.mkdirSync(path.join(capDirPath, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(capDirPath, 'hooks', 'run.js'), '// x\n', 'utf8');
  const manifest = declarativeCap(capId, '1.0.0');
  manifest.hooks = [{ event: 'PostToolUse', script: 'hooks/run.js' }];

  lifecycle.applyCapabilitySharedEdits({ runtimeDir: dir, capId, manifest, sharedFiles: ['settings.json'] });

  const entry = readSettings(dir).hooks.PostToolUse[0];
  assert.ok(!('matcher' in entry), 'no matcher declared => field omitted (match-all), preserving prior behavior');
});

test('#1634: a .cjs hook command is node-prefixed so it runs without the executable bit', () => {
  const dir = runtime();
  const capId = 'toolkit';
  const capDirPath = path.join(dir, '.gsd', 'capabilities', capId);
  fs.mkdirSync(path.join(capDirPath, 'hooks'), { recursive: true });
  // Stage at 0644 (no +x) — a git/tarball source that lost the executable bit.
  fs.writeFileSync(path.join(capDirPath, 'hooks', 'genfile-guard.cjs'), '// guard\n', { encoding: 'utf8', mode: 0o644 });
  const manifest = declarativeCap(capId, '1.0.0');
  manifest.hooks = [{ event: 'PreToolUse', script: 'hooks/genfile-guard.cjs' }];

  lifecycle.applyCapabilitySharedEdits({ runtimeDir: dir, capId, manifest, sharedFiles: ['settings.json'] });

  const command = readSettings(dir).hooks.PreToolUse[0].hooks[0].command;
  // The executable bit is a POSIX concept; on Windows fs modes are not POSIX (a 0o644 write reads
  // back as 0o666), so the precondition is checked on POSIX only. The node-prefix assertion below
  // is the actual fix and is platform-independent.
  if (process.platform !== 'win32') {
    assert.strictEqual((fs.statSync(path.join(capDirPath, 'hooks', 'genfile-guard.cjs')).mode & 0o777), 0o644,
      'precondition: file staged without +x');
  }
  // revert-fails: command was a bare single-quoted path -> /bin/sh: Permission denied on non-+x.
  assert.ok(/^node '/.test(command), 'command is node-prefixed for a .cjs hook: ' + command);
});

test('#1634: matcher + node-prefix together; marker strip round-trip unaffected', () => {
  const dir = runtime();
  const capId = 'toolkit';
  const capDirPath = path.join(dir, '.gsd', 'capabilities', capId);
  fs.mkdirSync(path.join(capDirPath, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(capDirPath, 'hooks', 'genfile-guard.cjs'), '// guard\n', 'utf8');
  const manifest = declarativeCap(capId, '1.0.0');
  manifest.hooks = [{ event: 'PreToolUse', script: 'hooks/genfile-guard.cjs', matcher: 'Write|Edit' }];

  const edits = lifecycle.applyCapabilitySharedEdits({ runtimeDir: dir, capId, manifest, sharedFiles: ['settings.json'] });
  const before = readSettings(dir).hooks.PreToolUse[0];
  assert.strictEqual(before.matcher, 'Write|Edit', 'matcher preserved on apply');
  assert.ok(/^node '/.test(before.hooks[0].command), 'command node-prefixed on apply');

  // Strip is keyed on CAP_MARKER, not command/matcher shape — must still remove the entry.
  lifecycle.stripCapabilitySharedEdits({ runtimeDir: dir, capId, sharedEdits: edits });
  const after = readSettings(dir);
  assert.ok(!after || !after.hooks || !after.hooks.PreToolUse || after.hooks.PreToolUse.length === 0,
    'marker-stamped entry is stripped regardless of matcher/command shape');
});

test('#1460 (R): confinedBundleScript returns null for an unsafe-char script (defense-in-depth)', () => {
  const dir = runtime();
  const capDirPath = path.join(dir, '.gsd', 'capabilities', 'e');
  fs.mkdirSync(capDirPath, { recursive: true });
  // Even when the file literally exists on disk inside the bundle, an unsafe-char script
  // name must be refused — so applyCapabilitySharedEdits skips it even if validation were
  // bypassed. revert-fails: without the allowlist guard this returns the absolute path.
  fs.writeFileSync(path.join(capDirPath, 'run.sh; touch pwn'), '// x', 'utf8');
  assert.strictEqual(lifecycle.confinedBundleScript(capDirPath, 'run.sh; touch pwn'), null);
  // A normal script still resolves to its confined absolute path.
  fs.writeFileSync(path.join(capDirPath, 'ok.sh'), '// x', 'utf8');
  const ok = lifecycle.confinedBundleScript(capDirPath, 'ok.sh');
  assert.ok(typeof ok === 'string' && ok.endsWith(path.join('e', 'ok.sh')), 'normal script resolves: ' + ok);
});

// ---------------------------------------------------------------------------
// Reconciliation (crash recovery) — proves "no half-state"
// ---------------------------------------------------------------------------

function seedCapDir(dir, name, manifest) {
  const d = path.join(dir, '.gsd', 'capabilities', name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'capability.json'), JSON.stringify(manifest), 'utf8');
  return d;
}
// Record a ledger entry carrying an in-flight INTENT (the commit signal).
function recordPending(dir, id, version, { kind = 'upgrade', backupName, sharedFiles = [], sharedEdits = [] }) {
  ledgerMod.recordInstall(dir, {
    id, version, source: 's', integrity: '', files: ['.gsd/capabilities/' + id], sharedEdits,
    _pending: { kind, backupName, sharedFiles },
  });
}

test('reconcile: crash before new swapped in (final missing, backup present) rolls back to old', () => {
  const dir = runtime();
  seedCapDir(dir, 'c.upgrading-111-222', declarativeCap('c', '1.0.0')); // old, set aside
  recordPending(dir, 'c', '1.0.0', { backupName: 'c.upgrading-111-222' });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledBack.includes('c'));
  assert.strictEqual(capManifestVersion(dir, 'c'), '1.0.0');
  assert.ok(!readLedgerEntry(dir, 'c')._pending, 'intent cleared');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.gsd', 'capabilities')).filter((n) => n.includes('.upgrading-')), []);
});

test('reconcile: crash after swap before commit (intent present) rolls back to old', () => {
  const dir = runtime();
  seedCapDir(dir, 'c', declarativeCap('c', '2.0.0')); // new, uncommitted, live
  seedCapDir(dir, 'c.upgrading-111-222', declarativeCap('c', '1.0.0')); // old backup
  recordPending(dir, 'c', '1.0.0', { backupName: 'c.upgrading-111-222' });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledBack.includes('c'));
  assert.strictEqual(capManifestVersion(dir, 'c'), '1.0.0', 'rolled back to old');
});

test('reconcile H3: SAME-version malicious bundle with intent present is rolled BACK, not mistaken for committed', () => {
  const dir = runtime();
  // Attacker ships different content under the SAME version string; crash before commit.
  seedCapDir(dir, 'c', { id: 'c', version: '1.0.0', _evil: true }); // new (uncommitted), same version
  seedCapDir(dir, 'c.upgrading-111-222', { id: 'c', version: '1.0.0', _evil: false }); // genuine old
  recordPending(dir, 'c', '1.0.0', { backupName: 'c.upgrading-111-222' });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledBack.includes('c'), 'must roll back despite equal version strings');
  const live = JSON.parse(fs.readFileSync(path.join(dir, '.gsd', 'capabilities', 'c', 'capability.json'), 'utf8'));
  assert.strictEqual(live._evil, false, 'the genuine old bundle is restored, not the uncommitted one');
});

test('reconcile H2: rollback restores SHARED CONFIG (new hook is not stranded in settings.json)', () => {
  const dir = runtime();
  // Old bundle is declarative (no hooks). New bundle (uncommitted) added a hook that the
  // mid-upgrade applied into settings.json before the crash.
  seedCapDir(dir, 'c', execCap('c', '2.0.0', { script: 'hooks/new.js' })); // new, uncommitted, live
  seedCapDir(dir, 'c.upgrading-111-222', declarativeCap('c', '1.0.0')); // old, declarative
  // Simulate the new hook already written to settings.json (stamped).
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ hooks: { PostToolUse: [{ [CAP_MARKER]: 'c', hooks: [{ type: 'command', command: 'hooks/new.js' }] }] }, theme: 'dark' }),
    'utf8',
  );
  recordPending(dir, 'c', '1.0.0', { backupName: 'c.upgrading-111-222', sharedFiles: ['settings.json'] });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledBack.includes('c'));
  const after = readSettings(dir);
  assert.ok(!after.hooks, 'the new hook was stripped (old bundle had none) — no stranded executable config');
  assert.strictEqual(after.theme, 'dark', 'unrelated user config preserved');
});

test('reconcile: committed leftover backup (no intent) rolls forward, dropping the backup', () => {
  const dir = runtime();
  seedCapDir(dir, 'c', declarativeCap('c', '2.0.0')); // new, committed, live
  seedCapDir(dir, 'c.upgrading-111-222', declarativeCap('c', '1.0.0')); // stale backup
  // Committed: ledger entry has NO _pendingUpgrade.
  ledgerMod.recordInstall(dir, { id: 'c', version: '2.0.0', source: 's', integrity: '', files: ['.gsd/capabilities/c'], sharedEdits: [] });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledForward.includes('c'));
  assert.strictEqual(capManifestVersion(dir, 'c'), '2.0.0', 'new kept');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.gsd', 'capabilities')).filter((n) => n.includes('.upgrading-')), []);
});

test('reconcile: an AGED staging orphan is swept, a FRESH one (possible in-flight resolve) is spared', () => {
  const dir = runtime();
  const stagingRoot = path.join(dir, '.gsd', 'capabilities', '.staging');
  const aged = path.join(stagingRoot, 'aged-1');
  const fresh = path.join(stagingRoot, 'fresh-2');
  fs.mkdirSync(aged, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });
  // Backdate the aged orphan well past the in-flight grace window.
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(aged, old, old);
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.orphansRemoved.includes('aged-1'), 'aged orphan swept');
  assert.ok(!fs.existsSync(aged));
  assert.ok(!report.orphansRemoved.includes('fresh-2'), 'fresh staging spared (could be live)');
  assert.ok(fs.existsSync(fresh), 'fresh staging not deleted');
});

test('reconcile H1: a crashed FRESH install (intent kind=install) is rolled back — dir, edits, and entry removed', () => {
  const dir = runtime();
  // Simulate: install promoted the dir + wrote a hook into settings.json, then crashed before commit.
  seedCapDir(dir, 'f', execCap('f', '1.0.0', { script: 'hooks/x.js' }));
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ hooks: { PostToolUse: [{ [CAP_MARKER]: 'f', hooks: [{ type: 'command', command: 'hooks/x.js' }] }] } }),
    'utf8',
  );
  recordPending(dir, 'f', '1.0.0', { kind: 'install', backupName: null, sharedFiles: ['settings.json'] });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledBack.includes('f'));
  assert.strictEqual(readLedgerEntry(dir, 'f'), null, 'half-installed ledger entry removed');
  assert.ok(!fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'f')), 'half-installed dir removed');
  assert.ok(!readSettings(dir).hooks, 'stranded shared edit stripped');
});

test('reconcile M5: a tampered ledger key (non-kebab id) is skipped, never used in a delete path', () => {
  const dir = runtime();
  // A precious file under runtimeDir the traversal id would resolve to.
  fs.writeFileSync(path.join(dir, 'precious.txt'), 'keep', 'utf8');
  // Tamper: write a ledger file directly (bypassing recordInstall's id validation, which now
  // correctly rejects non-kebab ids — finding 7) to simulate an externally tampered ledger.
  // The tampered entry uses a traversal id that reconcile must not act on.
  const LEDGER_FILE_NAME = ledgerMod.LEDGER_FILE_NAME;
  fs.writeFileSync(
    path.join(dir, LEDGER_FILE_NAME),
    JSON.stringify({
      version: '1',
      updatedAt: new Date().toISOString(),
      entries: {
        '../../precious': {
          id: '../../precious', version: '1.0.0', source: 's', integrity: '',
          files: ['.gsd/capabilities/x'], sharedEdits: [],
          _pending: { kind: 'install', backupName: null, sharedFiles: [] },
        },
      },
    }),
  );
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(!report.rolledBack.includes('../../precious'), 'tampered id not acted upon');
  assert.ok(fs.existsSync(path.join(dir, 'precious.txt')), 'no delete via the tampered id');
});

test('reconcile M6: a wrong-id/malformed upgrade backupName fails CLOSED (intent left for retry)', () => {
  const dir = runtime();
  seedCapDir(dir, 'c', declarativeCap('c', '2.0.0')); // new, uncommitted, live
  // Tampered intent: backupName names a DIFFERENT id.
  recordPending(dir, 'c', '1.0.0', { kind: 'upgrade', backupName: 'other.upgrading-1-1', sharedFiles: [] });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(!report.rolledBack.includes('c'), 'must not silently accept');
  assert.ok(readLedgerEntry(dir, 'c')._pending, 'intent left pending for manual handling');
});

test('reconcile H2: reinstall rollback restores OLD ledger metadata, not the new version', () => {
  const dir = runtime();
  seedCapDir(dir, 'c', declarativeCap('c', '2.0.0')); // new, uncommitted, live
  seedCapDir(dir, 'c.upgrading-111-222', declarativeCap('c', '1.0.0')); // old backup
  // Intent carries the OLD (prior) metadata + kind 'upgrade' (as installCapability now writes it).
  recordPending(dir, 'c', '1.0.0', { kind: 'upgrade', backupName: 'c.upgrading-111-222', sharedFiles: [], sharedEdits: [] });
  lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.strictEqual(capManifestVersion(dir, 'c'), '1.0.0', 'old files restored');
  assert.strictEqual(readLedgerEntry(dir, 'c').version, '1.0.0', 'ledger metadata matches restored old bundle');
});

test('remove: a held lock makes remove report "in progress" (does not mutate)', () => {
  const dir = runtime();
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  ledgerMod.recordInstall(dir, { id: 'q', version: '1.0.0', source: 's', integrity: '', files: ['.gsd/capabilities/q'], sharedEdits: [] });
  fs.writeFileSync(lockPath, '99999', 'utf8');
  try {
    const res = lifecycle.removeCapability('q', { runtimeDir: dir });
    assert.strictEqual(res.status, 'blocked');
    assert.ok(readLedgerEntry(dir, 'q'), 'entry not removed while locked');
  } finally {
    cleanup(lockPath);
  }
});

test('reconcile: a held lock makes reconcile defer (no-op) and a mutation report "in progress"', async () => {
  const dir = runtime();
  // Manually hold the lock (fresh mtime => not stale).
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '99999', 'utf8');
  try {
    const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
    assert.deepStrictEqual(report.rolledBack, [], 'reconcile defers while another op holds the lock');
    const res = await lifecycle.installCapability('./x', {
      runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('x')),
    });
    assert.strictEqual(res.status, 'blocked');
    assert.ok(res.blockReasons.some((r) => /in progress/.test(r)));
  } finally {
    cleanup(lockPath);
  }
});

// ---------------------------------------------------------------------------
// Remove (surgical strip + user hand-edit fault case)
// ---------------------------------------------------------------------------

test('remove: not-installed is idempotent', () => {
  const dir = runtime();
  assert.strictEqual(lifecycle.removeCapability('nope', { runtimeDir: dir }).status, 'not_installed');
});

test('remove: deletes recorded files, strips marked shared edits, drops the ledger entry', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0', { mcp: { 'cap-srv': { command: 'node' } } })),
  });
  const res = lifecycle.removeCapability('e', { runtimeDir: dir });
  assert.strictEqual(res.status, 'removed');
  assert.strictEqual(readLedgerEntry(dir, 'e'), null);
  assert.ok(!fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'e')));
  const settings = readSettings(dir);
  assert.ok(!settings.hooks, 'empty hooks object pruned');
  assert.ok(!settings.mcpServers, 'empty mcpServers object pruned');
});

test('remove: FAULT CASE — user hand-edited settings.json between install and remove is preserved', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0', { mcp: { 'cap-srv': { command: 'node' } } })),
  });
  // User hand-edits settings.json: adds their own (unmarked) hook + mcp server + a top-level field.
  const sp = path.join(dir, 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.hooks.PostToolUse.push({ hooks: [{ type: 'command', command: 'user-script.js' }] });
  s.mcpServers['user-srv'] = { command: 'user-mcp' };
  s.theme = 'dark';
  fs.writeFileSync(sp, JSON.stringify(s, null, 2), 'utf8');

  const res = lifecycle.removeCapability('e', { runtimeDir: dir });
  assert.strictEqual(res.status, 'removed');
  const after = JSON.parse(fs.readFileSync(sp, 'utf8'));
  // Capability-owned entries gone; user's untouched.
  assert.strictEqual(after.hooks.PostToolUse.length, 1);
  assert.strictEqual(after.hooks.PostToolUse[0].hooks[0].command, 'user-script.js');
  assert.deepStrictEqual(after.mcpServers, { 'user-srv': { command: 'user-mcp' } });
  assert.strictEqual(after.theme, 'dark');
});

test('remove: tolerates a user having already deleted the shared file and the install dir', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0')),
  });
  cleanup(path.join(dir, 'settings.json'));
  cleanup(path.join(dir, '.gsd', 'capabilities', 'e'));
  const res = lifecycle.removeCapability('e', { runtimeDir: dir });
  assert.strictEqual(res.status, 'removed', 'idempotent despite missing artifacts');
  assert.strictEqual(readLedgerEntry(dir, 'e'), null);
});

test('remove: a tampered ledger files[] routed through a symlink cannot delete outside runtimeDir', () => {
  const dir = runtime();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-outside-'));
  cleanups.push(outside);
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'precious', 'utf8');
  // A symlink inside runtimeDir pointing OUT, plus a tampered ledger routing files[] through it.
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, '.gsd', 'link'), 'dir');
  ledgerMod.recordInstall(dir, {
    id: 'evil', version: '1.0.0', source: 's', integrity: '',
    files: ['.gsd/link/victim.txt'], sharedEdits: [],
  });
  lifecycle.removeCapability('evil', { runtimeDir: dir });
  assert.ok(fs.existsSync(victim), 'a file OUTSIDE runtimeDir (reached via symlink) must NOT be deleted');
});

test('remove: CAPABILITY_DATA is preserved by default and deleted only on removeData', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true,
    _resolve: fakeResolve(declarativeCap('e')),
  });
  const dataDir = path.join(dir, '.gsd', 'capability-data', 'e');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{}', 'utf8');

  const keep = lifecycle.removeCapability('e', { runtimeDir: dir });
  assert.strictEqual(keep.dataPreserved, true);
  assert.ok(fs.existsSync(dataDir), 'data preserved by default');

  // Re-install then remove with removeData.
  await lifecycle.installCapability('./e', { runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('e')) });
  const wipe = lifecycle.removeCapability('e', { runtimeDir: dir, removeData: true });
  assert.strictEqual(wipe.dataPreserved, false);
  assert.ok(!fs.existsSync(dataDir), 'data deleted on removeData');
});

// ---------------------------------------------------------------------------
// Finding 1: upgrade + remove with a corrupt-present ledger must fail closed
// (throw/quarantine), NOT silently return not_installed.
// ---------------------------------------------------------------------------

test('upgrade: a corrupt-present ledger fails closed with status=blocked — must NOT throw or return not_installed (issue-4)', async () => {
  const dir = runtime();
  // Write a corrupt ledger file (present but unparseable).
  const ledgerPath = path.join(dir, ledgerMod.LEDGER_FILE_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const corruptContent = '{ broken json ---';
  fs.writeFileSync(ledgerPath, corruptContent);

  // upgradeCapability must NOT throw — it must return a blocked result.
  let result;
  await assert.doesNotReject(
    async () => {
      result = await lifecycle.upgradeCapability('./x', {
        runtimeDir: dir, hostVersion: '1.6.0',
        _resolve: fakeResolve(declarativeCap('x', '2.0.0')),
      });
    },
    'upgradeCapability must not throw on a corrupt ledger — must return a blocked result',
  );

  assert.strictEqual(result.status, 'blocked',
    `upgradeCapability must return status='blocked' on corrupt ledger; got: ${result?.status}`);
  assert.ok(
    result.blockReasons && result.blockReasons.some((r) => /corrupt/i.test(r)),
    `blockReasons must mention corruption; got: ${JSON.stringify(result?.blockReasons)}`,
  );

  // The corrupt file must still be at its ORIGINAL PATH (non-destructive — finding 1).
  assert.ok(fs.existsSync(ledgerPath), 'corrupt file must remain in place after blocked upgrade');
  assert.strictEqual(fs.readFileSync(ledgerPath, 'utf8'), corruptContent, 'corrupt content unchanged');
  // No quarantine files must exist.
  const quarantines = fs.readdirSync(dir).filter((n) => n.includes(ledgerMod.LEDGER_FILE_NAME) && n.includes('.corrupt.'));
  assert.strictEqual(quarantines.length, 0, 'no quarantine files must exist — non-destructive behavior');
});

test('remove: a corrupt-present ledger fails closed with status=blocked — must NOT throw or return not_installed (issue-4)', () => {
  const dir = runtime();
  const ledgerPath = path.join(dir, ledgerMod.LEDGER_FILE_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const corruptContent = '{ broken json ---';
  fs.writeFileSync(ledgerPath, corruptContent);

  // removeCapability must NOT throw — it must return a blocked result.
  let result;
  assert.doesNotThrow(
    () => {
      result = lifecycle.removeCapability('some-cap', { runtimeDir: dir });
    },
    'removeCapability must not throw on a corrupt ledger — must return a blocked result',
  );

  assert.strictEqual(result.status, 'blocked',
    `removeCapability must return status='blocked' on corrupt ledger; got: ${result?.status}`);
  assert.ok(
    result.blockReasons && result.blockReasons.some((r) => /corrupt/i.test(r)),
    `blockReasons must mention corruption; got: ${JSON.stringify(result?.blockReasons)}`,
  );

  // The corrupt file must still be at its ORIGINAL PATH (non-destructive — finding 1).
  assert.ok(fs.existsSync(ledgerPath), 'corrupt file must remain in place after blocked remove');
  assert.strictEqual(fs.readFileSync(ledgerPath, 'utf8'), corruptContent, 'corrupt content unchanged');
  // No quarantine files must exist.
  const quarantines = fs.readdirSync(dir).filter((n) => n.includes(ledgerMod.LEDGER_FILE_NAME) && n.includes('.corrupt.'));
  assert.strictEqual(quarantines.length, 0, 'no quarantine files must exist — non-destructive behavior');
});

// ---------------------------------------------------------------------------
// Finding 2 (HIGH): remove must run a READ-ONLY corruption preflight BEFORE acquireLock.
// On a corrupt ledger it must NOT create .gsd/capabilities and must NOT create a .lock.
// ---------------------------------------------------------------------------

test('finding-2: removeCapability on a corrupt ledger does NOT acquire a lock or create .gsd/capabilities (preflight precedes acquireLock)', () => {
  const dir = runtime();
  const ledgerPath = path.join(dir, ledgerMod.LEDGER_FILE_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ledgerPath, '{ broken json ---');

  const capsRoot = path.join(dir, '.gsd', 'capabilities');
  assert.ok(!fs.existsSync(capsRoot), 'precondition: .gsd/capabilities must not exist yet');

  const result = lifecycle.removeCapability('some-cap', { runtimeDir: dir });

  assert.strictEqual(result.status, 'blocked',
    `removeCapability must be blocked on corrupt ledger; got: ${result?.status}`);
  assert.ok(result.blockReasons && /corrupt|invalid/i.test(result.blockReasons.join(' ')),
    `block reason must name corruption; got: "${(result.blockReasons || []).join(' ')}"`);

  // UNCONDITIONAL: the read-only preflight failed BEFORE acquireLock, so no lock dir/file exists.
  assert.ok(!fs.existsSync(capsRoot),
    '.gsd/capabilities must NOT be created by acquireLock when the corruption preflight blocks first');
  assert.ok(!fs.existsSync(path.join(capsRoot, '.lock')),
    'no .lock file may be created when the corruption preflight blocks before acquireLock');
});

// ---------------------------------------------------------------------------
// Issue 1 (HIGH): wrong-shape sharedEdits/files member → readLedgerStrict quarantines
// → upgradeCapability/removeCapability return 'blocked', not a thrown error.
// ---------------------------------------------------------------------------

test('upgrade: wrong-shape sharedEdits member is treated as corrupt → status=blocked, not a thrown error (issue-1)', async () => {
  const dir = runtime();
  fs.mkdirSync(dir, { recursive: true });

  // Write a ledger whose sharedEdits contains null — must fail deep validation.
  const badLedger = {
    version: '1',
    updatedAt: new Date().toISOString(),
    entries: {
      x: {
        id: 'x', version: '1.0.0', source: 'registry:test', integrity: 'sha256-abc',
        files: [],
        sharedEdits: [null],  // null member — must fail deep validation
      },
    },
  };
  const ledgerFilePath = path.join(dir, ledgerMod.LEDGER_FILE_NAME);
  const badContent = JSON.stringify(badLedger, null, 2);
  fs.writeFileSync(ledgerFilePath, badContent);

  let result;
  await assert.doesNotReject(
    async () => {
      result = await lifecycle.upgradeCapability('./x', {
        runtimeDir: dir, hostVersion: '1.6.0',
        _resolve: fakeResolve(declarativeCap('x', '2.0.0')),
      });
    },
    'upgradeCapability must not throw on wrong-shape sharedEdits — must return blocked',
  );

  assert.strictEqual(result.status, 'blocked',
    `must return status='blocked' for wrong-shape sharedEdits; got: ${result?.status}`);

  // The corrupt file must still be in place (non-destructive — finding 1).
  assert.ok(fs.existsSync(ledgerFilePath), 'malformed ledger must remain in place');
  // No quarantine files must exist.
  const quarantines = fs.readdirSync(dir).filter((n) => n.includes(ledgerMod.LEDGER_FILE_NAME) && n.includes('.corrupt.'));
  assert.strictEqual(quarantines.length, 0, 'no quarantine files — non-destructive');
});

test('remove: wrong-shape files member is treated as corrupt → status=blocked, not a thrown error (issue-1)', () => {
  const dir = runtime();
  fs.mkdirSync(dir, { recursive: true });

  // Write a ledger whose files[] contains a number — must fail deep validation.
  const badLedger = {
    version: '1',
    updatedAt: new Date().toISOString(),
    entries: {
      'some-cap': {
        id: 'some-cap', version: '1.0.0', source: 'registry:test', integrity: 'sha256-abc',
        files: [123],  // non-string — must fail deep validation
        sharedEdits: [],
      },
    },
  };
  const ledgerFilePath = path.join(dir, ledgerMod.LEDGER_FILE_NAME);
  fs.writeFileSync(ledgerFilePath, JSON.stringify(badLedger, null, 2));

  let result;
  assert.doesNotThrow(
    () => {
      result = lifecycle.removeCapability('some-cap', { runtimeDir: dir });
    },
    'removeCapability must not throw on wrong-shape files[] — must return blocked',
  );

  assert.strictEqual(result.status, 'blocked',
    `must return status='blocked' for wrong-shape files[]; got: ${result?.status}`);

  // The malformed ledger must remain in place (non-destructive — finding 1).
  assert.ok(fs.existsSync(ledgerFilePath), 'malformed ledger must remain in place');
  const quarantines = fs.readdirSync(dir).filter((n) => n.includes(ledgerMod.LEDGER_FILE_NAME) && n.includes('.corrupt.'));
  assert.strictEqual(quarantines.length, 0, 'no quarantine files — non-destructive');
});

// ---------------------------------------------------------------------------
// Shared-edit helpers (direct) — prototype-pollution guard
// ---------------------------------------------------------------------------

test('applyCapabilitySharedEdits: __proto__ event/name is skipped (no pollution)', () => {
  const dir = runtime();
  lifecycle.applyCapabilitySharedEdits({
    runtimeDir: dir,
    capId: 'p',
    manifest: { hooks: [{ event: '__proto__', script: 'x.js' }, { event: 'Real', script: 'y.js' }], mcpServers: { __proto__: { command: 'evil' }, ok: { command: 'node' } } },
    sharedFiles: ['settings.json'],
  });
  const s = readSettings(dir);
  assert.ok(!Object.prototype.hasOwnProperty.call(s.hooks, '__proto__'));
  assert.ok(Array.isArray(s.hooks.Real));
  assert.ok(!Object.prototype.hasOwnProperty.call(s.mcpServers, '__proto__'));
  assert.ok(s.mcpServers.ok);
  // The global prototype was not polluted.
  assert.strictEqual({}.command, undefined);
});

// ---------------------------------------------------------------------------
// #1460 CONF-1 — a hook command is written as the ABSOLUTE path inside the
// capability's own install dir, confined via realpath; a script that resolves
// OUTSIDE the bundle is NOT written.
// revert-fails: with the raw `command: script` restored (pre-fix), the absolute
// assertion fails and a bundle-escaping script would be written.
// ---------------------------------------------------------------------------

test('#1460 CONF-1: a relative hook script is emitted as the absolute path inside capDir', () => {
  const dir = runtime();
  const capId = 'conf1';
  // Make the install dir real so realpath confinement resolves a concrete chain.
  const capDir = path.join(dir, '.gsd', 'capabilities', capId);
  fs.mkdirSync(path.join(capDir, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(capDir, 'subdir', 'run.js'), '// hook', 'utf8');

  lifecycle.applyCapabilitySharedEdits({
    runtimeDir: dir,
    capId,
    manifest: { hooks: [{ event: 'PostToolUse', script: 'subdir/run.js' }] },
    sharedFiles: ['settings.json'],
  });

  const s = readSettings(dir);
  const command = s.hooks.PostToolUse[0].hooks[0].command;
  const expectedAbs = path.join(fs.realpathSync(path.join(capDir, 'subdir')), 'run.js');
  // #1460 (R) + #1634: the emitted command is `node ` + the absolute confined path, POSIX single-quoted.
  assert.strictEqual(command, nodeQuoted(expectedAbs), 'command must be node + the quoted absolute confined path inside capDir');
  const unquoted = command.slice('node '.length + 1, -1); // drop `node ` prefix, strip the wrapping single quotes
  assert.ok(path.isAbsolute(unquoted), 'command path must be absolute (CWD-independent)');
  assert.ok(unquoted.startsWith(fs.realpathSync(capDir) + path.sep), 'command path must live inside the bundle');
});

test('#1460 CONF-1: a script resolving OUTSIDE capDir via a symlinked subdir is NOT written (skipped)', (t) => {
  const dir = runtime();
  const capId = 'conf1-escape';
  const capDir = path.join(dir, '.gsd', 'capabilities', capId);
  fs.mkdirSync(capDir, { recursive: true });

  // Plant a victim file outside the bundle and a symlinked subdir inside the bundle
  // that points at the victim's parent. A relative script "evil/run.js" would then
  // resolve to the victim through the symlink — confinement must refuse it.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'conf1-outside-'));
  cleanups.push(outside);
  fs.writeFileSync(path.join(outside, 'run.js'), '// victim', 'utf8');
  try {
    fs.symlinkSync(outside, path.join(capDir, 'evil'));
  } catch {
    t.skip('symlink not supported on this platform');
    return;
  }

  lifecycle.applyCapabilitySharedEdits({
    runtimeDir: dir,
    capId,
    manifest: { hooks: [{ event: 'PostToolUse', script: 'evil/run.js' }] },
    sharedFiles: ['settings.json'],
  });

  const s = readSettings(dir);
  // The escaping hook is skipped → no settings written at all (no touched edits).
  assert.strictEqual(s, null, 'no shared-config edit must be written for a bundle-escaping script');
});

// ---------------------------------------------------------------------------
// #1460 CONF-2 — REGRESSION GUARD: confinedSharedFile realpaths the FULL ancestor
// chain, so an ANCESTOR symlink (not just the final component) cannot escape.
// revert-fails: if confinedSharedFile were changed to realpath only the final
// component, a path through a symlinked ancestor would resolve OUTSIDE runtimeDir
// and this test (asserting null) would fail.
// ---------------------------------------------------------------------------

test('#1460 CONF-2: confinedSharedFile refuses a path through a symlinked ANCESTOR directory', (t) => {
  const dir = runtime();
  // Build runtimeDir/inner where `inner` is a symlink to a directory OUTSIDE runtimeDir.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'conf2-outside-'));
  cleanups.push(outside);
  fs.mkdirSync(path.join(outside, 'deep'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(dir, 'inner'));
  } catch {
    t.skip('symlink not supported on this platform');
    return;
  }

  // A path whose ANCESTOR ("inner") is the escaping symlink — the final component
  // ("settings.json") is not itself a link, so a final-component-only realpath would
  // miss the escape. confinedSharedFile realpaths the parent chain and must return null.
  const result = lifecycle.confinedSharedFile(dir, path.join('inner', 'deep', 'settings.json'));
  assert.strictEqual(result, null, 'a path through a symlinked ancestor must be refused (null)');
});

// ---------------------------------------------------------------------------
// Site B: reconcileCapabilities on a corrupt-present ledger must surface a
// warning in its report, not silently do nothing (#1462).
// ---------------------------------------------------------------------------

test('reconcileCapabilities: a corrupt-present ledger surfaces a warning in report.warnings (site B)', () => {
  const dir = runtime();
  fs.mkdirSync(dir, { recursive: true });
  // Write a corrupt (unparseable) ledger file.
  fs.writeFileSync(path.join(dir, ledgerMod.LEDGER_FILE_NAME), '{ broken json ---');

  let report;
  assert.doesNotThrow(
    () => { report = lifecycle.reconcileCapabilities({ runtimeDir: dir }); },
    'reconcileCapabilities must not throw on a corrupt ledger',
  );

  assert.ok(report, 'must return a report object');
  // The warning must be in the top-level report.warnings[] field (not only nested
  // under report.ledger.warnings which is typed as unknown and callers miss it).
  assert.ok(Array.isArray(report.warnings),
    `report.warnings must be an array; got: ${typeof report.warnings}`);
  assert.ok(
    report.warnings.some((w) => /corrupt|could not be parsed/i.test(w)),
    `report.warnings must contain a warning mentioning corruption; got: ${JSON.stringify(report.warnings)}`,
  );
});

// ---------------------------------------------------------------------------
// Finding 2 (HIGH): reconcile must run a READ-ONLY corruption preflight BEFORE acquireLock.
// On a corrupt ledger it must warn WITHOUT creating .gsd/capabilities or a .lock.
// ---------------------------------------------------------------------------

test('finding-2: reconcileCapabilities on a corrupt ledger does NOT acquire a lock or create .gsd/capabilities (preflight precedes acquireLock)', () => {
  const dir = runtime();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ledgerMod.LEDGER_FILE_NAME), '{ broken json ---');

  const capsRoot = path.join(dir, '.gsd', 'capabilities');
  assert.ok(!fs.existsSync(capsRoot), 'precondition: .gsd/capabilities must not exist yet');

  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });

  assert.ok(report.warnings.some((w) => /corrupt|could not be parsed/i.test(w)),
    `report.warnings must mention corruption; got: ${JSON.stringify(report.warnings)}`);

  // UNCONDITIONAL: the read-only preflight warned BEFORE acquireLock, so no lock dir/file exists.
  assert.ok(!fs.existsSync(capsRoot),
    '.gsd/capabilities must NOT be created by acquireLock when the corruption preflight warns first');
  assert.ok(!fs.existsSync(path.join(capsRoot, '.lock')),
    'no .lock file may be created when the corruption preflight warns before acquireLock');
});

// ---------------------------------------------------------------------------
// Issue HIGH: installCapability corrupt-ledger fail-closed (Codex pass 3)
// Prior-entry readLedger (non-strict) + uncaught recordInstall CorruptLedgerError
// — both paths must return blocked, never throw.
// ---------------------------------------------------------------------------

test('install: a corrupt-present ledger fails closed with status=blocked — must NOT throw or return not_installed (codex-p3-h1)', async () => {
  const dir = runtime();
  const ledgerPath = path.join(dir, ledgerMod.LEDGER_FILE_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const corruptContent = '{ broken json ---';
  fs.writeFileSync(ledgerPath, corruptContent);

  // installCapability must NOT throw — it must return a blocked result.
  let result;
  await assert.doesNotReject(
    async () => {
      result = await lifecycle.installCapability('./newcap', {
        runtimeDir: dir, hostVersion: '1.6.0',
        _resolve: fakeResolve(declarativeCap('newcap', '1.0.0')),
      });
    },
    'installCapability must not throw on a corrupt ledger — must return a blocked result',
  );

  assert.strictEqual(result.status, 'blocked',
    `installCapability must return status='blocked' on corrupt ledger; got: ${result?.status}`);
  assert.ok(
    result.blockReasons && result.blockReasons.some((r) => /corrupt/i.test(r)),
    `blockReasons must mention corruption; got: ${JSON.stringify(result?.blockReasons)}`,
  );

  // The corrupt file must still be at its ORIGINAL PATH (non-destructive — finding 1).
  assert.ok(fs.existsSync(ledgerPath), 'corrupt file must remain in place after blocked install');
  assert.strictEqual(fs.readFileSync(ledgerPath, 'utf8'), corruptContent, 'corrupt content unchanged');
  // No quarantine files must exist.
  const quarantines = fs.readdirSync(dir).filter((n) => n.includes(ledgerMod.LEDGER_FILE_NAME) && n.includes('.corrupt.'));
  assert.strictEqual(quarantines.length, 0, 'no quarantine files must exist — non-destructive behavior');
});

// ---------------------------------------------------------------------------
// Finding 3: removeCapability ledger-write failure after files deleted → blocked result,
// no unhandled throw. Coherent state: files gone, ledger still references them (retry-able).
// ---------------------------------------------------------------------------

test('remove: ledger commit failure after files are deleted returns blocked (finding-3)', async (t) => {
  const dir = runtime();

  // Install a capability.
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true,
    _resolve: fakeResolve(declarativeCap('e')),
  });
  assert.ok(ledgerMod.readLedger(dir)?.entries['e'], 'e must be installed');

  // Mock renameSync to fail (ledger write = tmp+rename; make the rename fail).
  const { mock } = require('node:test');
  const renameMock = mock.method(require('node:fs'), 'renameSync', (_src, _dest) => {
    const err = new Error('EXDEV: cross-device rename not permitted');
    err.code = 'EXDEV';
    throw err;
  });
  t.after(() => renameMock.mock.restore());

  // removeCapability must NOT throw — must return a blocked result.
  let result;
  assert.doesNotThrow(
    () => { result = lifecycle.removeCapability('e', { runtimeDir: dir }); },
    'removeCapability must not throw when ledger commit fails',
  );

  assert.strictEqual(result.status, 'blocked',
    `must return blocked when ledger write fails; got: ${result?.status}`);
  assert.ok(
    result.blockReasons && result.blockReasons.some((r) => /ledger commit failed|EXDEV/i.test(r)),
    `blockReasons must mention ledger commit failure; got: ${JSON.stringify(result?.blockReasons)}`,
  );
});

// ---------------------------------------------------------------------------
// Finding 4: upgradeCapability intent-write failure → blocked result, no unhandled throw.
// ---------------------------------------------------------------------------

test('upgrade: intent recordInstall failure returns blocked (finding-4)', async (t) => {
  const dir = runtime();

  // Install first.
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true,
    _resolve: fakeResolve(declarativeCap('e', '1.0.0')),
  });

  // Mock renameSync to fail (writeLedger uses tmp+rename; the intent write will fail).
  const { mock } = require('node:test');
  const renameMock = mock.method(require('node:fs'), 'renameSync', (_src, _dest) => {
    const err = new Error('EXDEV: cross-device rename not permitted');
    err.code = 'EXDEV';
    throw err;
  });
  t.after(() => renameMock.mock.restore());

  // upgradeCapability must NOT throw — must return blocked.
  let result;
  await assert.doesNotReject(
    async () => {
      result = await lifecycle.upgradeCapability('./e', {
        runtimeDir: dir, hostVersion: '1.6.0',
        _resolve: fakeResolve(declarativeCap('e', '2.0.0')),
      });
    },
    'upgradeCapability must not throw when intent write fails',
  );

  assert.strictEqual(result.status, 'blocked',
    `must return blocked when upgrade intent write fails; got: ${result?.status}`);
  assert.ok(
    result.blockReasons && result.blockReasons.length > 0,
    `must have blockReasons; got: ${JSON.stringify(result?.blockReasons)}`,
  );
});

// ---------------------------------------------------------------------------
// Real-resolver integration (no _resolve seam)
// ---------------------------------------------------------------------------

test('integration: install a real, valid, declarative local capability through the real resolver', async () => {
  const dir = runtime();
  // Build a valid local capability source dir.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-src-'));
  cleanups.push(src);
  fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(declarativeCap('realcap')), 'utf8');

  const res = await lifecycle.installCapability(src, { runtimeDir: dir, hostVersion: '1.6.0' });
  assert.strictEqual(res.status, 'installed', JSON.stringify(res));
  assert.strictEqual(res.id, 'realcap');
  assert.ok(fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'realcap', 'capability.json')));
  assert.ok(readLedgerEntry(dir, 'realcap'), 'ledger entry recorded via real path');
});

// ---------------------------------------------------------------------------
// Finding 3 (HIGH): removeCapability must commit from the ALREADY-read in-memory
// ledger — not re-read via removeEntry's non-strict readLedger. A ledger corrupted
// between the strict pre-read and the commit must not produce a silent 'removed'
// result with dangling refs.
// ---------------------------------------------------------------------------

test('remove: finding-3 — removeCapability NEVER calls ledgerMod.removeEntry (uses in-memory writeLedger, not a re-read path)', async (t) => {
  const dir = runtime();

  // Install a capability so it exists in the ledger.
  await lifecycle.installCapability('./rf3', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true,
    _resolve: fakeResolve(declarativeCap('rf3')),
  });
  assert.ok(readLedgerEntry(dir, 'rf3'), 'rf3 must be installed before remove test');

  // Spy on ledgerMod.removeEntry — removeCapability must NEVER call it.
  // (removeCapability commits by mutating the in-memory ledger + writeLedger directly,
  // never via removeEntry whose re-read is non-strict and would silently swallow corruption.)
  const { mock } = require('node:test');
  let removeEntryCalls = 0;
  const removeEntryMock = mock.method(ledgerMod, 'removeEntry', function (...args) {
    removeEntryCalls++;
    // Still call through so ledger stays consistent if the code ever uses it.
    return ledgerMod.removeEntry.__origFn ? ledgerMod.removeEntry.__origFn(...args) : undefined;
  });
  t.after(() => removeEntryMock.mock.restore());

  const result = lifecycle.removeCapability('rf3', { runtimeDir: dir });
  assert.strictEqual(result.status, 'removed',
    'removeCapability must succeed using the in-memory writeLedger path');
  assert.strictEqual(removeEntryCalls, 0,
    'removeCapability must NEVER call ledgerMod.removeEntry — it must commit via the in-memory writeLedger path');
  assert.strictEqual(readLedgerEntry(dir, 'rf3'), null, 'entry must be gone after remove');
});

test('remove: finding-3 — mid-remove corruption blocks coherently: capability files gone but ledger write fails → blocked (not silent removed with dangling refs)', async (t) => {
  const dir = runtime();

  // Install a capability.
  await lifecycle.installCapability('./rf3b', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true,
    _resolve: fakeResolve(declarativeCap('rf3b')),
  });
  assert.ok(readLedgerEntry(dir, 'rf3b'), 'rf3b must be installed');

  // After strict pre-read, corrupt the ledger on disk so the writeLedger commit fails.
  // We do this by intercepting the SECOND renameSync call (the atomic ledger write's rename)
  // with an EXDEV error, simulating a commit failure after files are already deleted.
  const { mock } = require('node:test');
  const realRename = fs.renameSync.bind(fs);
  let renameCount = 0;
  const renameMock = mock.method(fs, 'renameSync', function (src, dst) {
    renameCount++;
    // The first rename may be for staging during install setup; skip it.
    // The ledger commit rename will be for a .tmp.<pid>-<nonce> → .gsd-capabilities.json path.
    if (typeof dst === 'string' && dst.includes('.gsd-capabilities.json') && renameCount >= 1) {
      const err = new Error('EXDEV: cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    }
    return realRename(src, dst);
  });
  t.after(() => renameMock.mock.restore());

  const result = lifecycle.removeCapability('rf3b', { runtimeDir: dir });

  // The result must be 'blocked' — not 'removed' — because the ledger commit failed.
  // Returning 'removed' when the ledger write failed would be a "silent removed with dangling refs".
  assert.strictEqual(result.status, 'blocked',
    `removeCapability must return blocked when the ledger commit fails; got: ${result?.status}`);
  assert.ok(
    result.blockReasons && result.blockReasons.length > 0,
    'must include blockReasons explaining the failure',
  );
  // The error message must NOT reference a non-existent CLI command ('gsd capability reconcile').
  const reason = result.blockReasons[0] || '';
  assert.ok(
    !reason.includes('gsd capability reconcile'),
    `blockReasons must not reference non-existent CLI subcommand 'gsd capability reconcile'; got: "${reason}"`,
  );
});

// ---------------------------------------------------------------------------
// ROOT FIX 2: preflight strict-read BEFORE source resolution + staging.
// A corrupt ledger must block install/upgrade BEFORE any staging dir is created.
// ---------------------------------------------------------------------------

test('root-fix-2: install on a corrupt-present ledger blocks BEFORE resolving source / creating staging', async (_t) => {
  const dir = runtime();

  // Write a corrupt ledger before attempting install.
  const ledgerPath = path.join(dir, '.gsd-capabilities.json');
  fs.writeFileSync(ledgerPath, '{ broken json ---', 'utf8');

  let resolveCalled = false;
  const trackingResolve = async (spec, opts) => {
    resolveCalled = true;
    // Materialize a staging dir so a regression (resolve before strict read) is observable.
    const root = path.join(opts.gsdHome, '.gsd', 'capabilities', '.staging');
    fs.mkdirSync(root, { recursive: true });
    const staged = path.join(root, 'preflight-test');
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, 'capability.json'), JSON.stringify(
      { id: 'pf', role: 'feature', version: '1.0.0', title: 'pf', description: 'x',
        tier: 'standard', requires: [], engines: { gsd: '>=1.0.0' },
        runtimeCompat: { supported: ['*'], unsupported: [] },
        skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [] }
    ), 'utf8');
    return { id: 'pf', version: '1.0.0', stagedDir: staged, integrity: null, source: spec };
  };

  const result = await lifecycle.installCapability('./pf', {
    runtimeDir: dir, hostVersion: '1.6.0',
    _resolve: trackingResolve,
  });

  assert.strictEqual(result.status, 'blocked',
    'installCapability must be blocked by a corrupt ledger');
  assert.ok(result.blockReasons && result.blockReasons.length > 0, 'must have blockReasons');
  // The block reason must be the CORRUPTION (not some downstream staging/consent message).
  assert.ok(
    /corrupt|invalid/i.test(result.blockReasons.join(' ')),
    `block reason must name ledger corruption; got: "${result.blockReasons.join(' ')}"`,
  );

  // UNCONDITIONAL invariant: the strict read precedes source resolution, so the resolver is
  // NEVER invoked when the ledger is corrupt. (Was gated behind `if (!resolveCalled)` — vacuous.)
  assert.strictEqual(resolveCalled, false,
    'resolver must NOT be called when the ledger is corrupt (strict read precedes _resolve)');

  // And because resolve never ran, NO staging dir was created.
  const stagingRoot = path.join(dir, '.gsd', 'capabilities', '.staging');
  assert.ok(
    !fs.existsSync(stagingRoot),
    'no .staging dir may be created when the ledger is corrupt (preflight precedes staging)',
  );
});

test('root-fix-2: upgrade on a corrupt-present ledger blocks BEFORE resolving source / creating staging', async (_t) => {
  const dir = runtime();

  // First install successfully.
  await lifecycle.installCapability('./u2', {
    runtimeDir: dir, hostVersion: '1.6.0',
    _resolve: fakeResolve(declarativeCap('u2', '1.0.0')),
  });

  // Then corrupt the ledger.
  const ledgerPath = path.join(dir, '.gsd-capabilities.json');
  fs.writeFileSync(ledgerPath, '{ broken json ---', 'utf8');

  let resolveCalled = false;
  const trackingResolve = async (spec, opts) => {
    resolveCalled = true;
    const root = path.join(opts.gsdHome, '.gsd', 'capabilities', '.staging');
    fs.mkdirSync(root, { recursive: true });
    const staged = path.join(root, 'preflight-upgrade-test');
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, 'capability.json'), JSON.stringify(
      { id: 'u2', role: 'feature', version: '2.0.0', title: 'u2', description: 'x',
        tier: 'standard', requires: [], engines: { gsd: '>=1.0.0' },
        runtimeCompat: { supported: ['*'], unsupported: [] },
        skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [] }
    ), 'utf8');
    return { id: 'u2', version: '2.0.0', stagedDir: staged, integrity: null, source: spec };
  };

  // Snapshot the .staging dir's prior contents (the successful install above may have left none,
  // but be precise): the corrupt-upgrade attempt must add NOTHING.
  const stagingRoot = path.join(dir, '.gsd', 'capabilities', '.staging');
  const before = fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).sort() : [];

  const result = await lifecycle.upgradeCapability('./u2-v2', {
    runtimeDir: dir, hostVersion: '1.6.0',
    _resolve: trackingResolve,
  });

  assert.strictEqual(result.status, 'blocked',
    'upgradeCapability must be blocked by a corrupt ledger');
  assert.ok(result.blockReasons && result.blockReasons.length > 0, 'must have blockReasons');
  assert.ok(
    /corrupt|invalid/i.test(result.blockReasons.join(' ')),
    `block reason must name ledger corruption; got: "${result.blockReasons.join(' ')}"`,
  );

  // UNCONDITIONAL: strict read precedes resolution, so the resolver is never invoked.
  assert.strictEqual(resolveCalled, false,
    'resolver must NOT be called when the ledger is corrupt (strict read precedes _resolve)');

  // No NEW staging entry was created by the corrupt-upgrade attempt.
  const after = fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).sort() : [];
  assert.deepStrictEqual(after, before,
    'no new .staging entry may be created when the ledger is corrupt (preflight precedes staging)');
});

test('root-fix-2: corrupt-ledger EXECUTABLE install WITHOUT --yes blocks on CORRUPTION (not aborts on consent)', async (_t) => {
  const dir = runtime();

  // Write a corrupt ledger before attempting install.
  const ledgerPath = path.join(dir, '.gsd-capabilities.json');
  fs.writeFileSync(ledgerPath, '{ broken json ---', 'utf8');

  let resolveCalled = false;
  const trackingResolve = async (spec, opts) => {
    resolveCalled = true;
    const root = path.join(opts.gsdHome, '.gsd', 'capabilities', '.staging');
    fs.mkdirSync(root, { recursive: true });
    const staged = path.join(root, 'exec-corrupt-test');
    fs.mkdirSync(staged, { recursive: true });
    // An EXECUTABLE capability (declares a hook) — would normally require consent.
    const manifest = execCap('execcap', '1.0.0', { script: 'hooks/run.js' });
    fs.writeFileSync(path.join(staged, 'capability.json'), JSON.stringify(manifest), 'utf8');
    materialize(staged, 'hooks/run.js');
    return { id: 'execcap', version: '1.0.0', stagedDir: staged, integrity: null, source: spec };
  };

  // No consentGranted (i.e. no --yes). Pre-fix order returned 'aborted' (consent) BEFORE the
  // strict read at ~660 ever ran, masking the corruption. Post-fix: corruption is detected FIRST.
  const result = await lifecycle.installCapability('./execcap', {
    runtimeDir: dir, hostVersion: '1.6.0',
    _resolve: trackingResolve,
    // consentGranted intentionally omitted (falsy) — this is the WITHOUT --yes case.
  });

  assert.strictEqual(result.status, 'blocked',
    `corrupt-ledger executable install without --yes must be 'blocked' on corruption, ` +
    `not 'aborted' on consent; got: ${result.status}`);
  assert.notStrictEqual(result.status, 'aborted',
    'must NOT report aborted-on-consent before the corruption is reported');
  assert.ok(result.blockReasons && /corrupt|invalid/i.test(result.blockReasons.join(' ')),
    `block reason must name ledger corruption; got: "${(result.blockReasons || []).join(' ')}"`);
  assert.strictEqual(resolveCalled, false,
    'resolver must NOT be called — corruption is detected before resolution/consent');
});

// ---------------------------------------------------------------------------
// ROOT FIX 3: unsafe capability ids rejected at install/upgrade before staging.
// A __proto__/constructor/prototype bundle must never be promoted.
// ---------------------------------------------------------------------------

test('root-fix-3: installCapability rejects unsafe id (constructor) before staging/promotion', async (_t) => {
  const dir = runtime();

  const result = await lifecycle.installCapability('./evil', {
    runtimeDir: dir, hostVersion: '1.6.0',
    _resolve: async (spec, opts) => {
      const root = path.join(opts.gsdHome, '.gsd', 'capabilities', '.staging');
      fs.mkdirSync(root, { recursive: true });
      const staged = path.join(root, 'unsafe-id-test');
      fs.mkdirSync(staged, { recursive: true });
      fs.writeFileSync(path.join(staged, 'capability.json'), JSON.stringify(
        { id: 'constructor', role: 'feature', version: '1.0.0', title: 'evil',
          description: 'evil', tier: 'standard', requires: [], engines: { gsd: '>=1.0.0' },
          runtimeCompat: { supported: ['*'], unsupported: [] },
          skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [] }
      ), 'utf8');
      return { id: 'constructor', version: '1.0.0', stagedDir: staged, integrity: null, source: spec };
    },
  });

  assert.strictEqual(result.status, 'blocked',
    `installCapability must block a capability with id='constructor'; got: ${result.status}`);
  assert.ok(result.blockReasons && result.blockReasons.length > 0, 'must have blockReasons');
  // Must NOT have installed a bundle at .gsd/capabilities/constructor
  assert.ok(
    !fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'constructor')),
    'no .gsd/capabilities/constructor bundle must be promoted',
  );
  // Must NOT have a ledger entry for 'constructor'
  const l = ledgerMod.readLedger(dir);
  assert.ok(!l || !Object.prototype.hasOwnProperty.call(l.entries, 'constructor'),
    'no ledger entry for id=constructor must exist');
});

test('root-fix-3: installCapability rejects __proto__ and prototype ids', async (_t) => {
  const dir = runtime();

  for (const unsafeId of ['__proto__', 'prototype']) {
    const res = await lifecycle.installCapability('./evil', {
      runtimeDir: dir, hostVersion: '1.6.0',
      _resolve: async (spec, opts) => {
        const root = path.join(opts.gsdHome, '.gsd', 'capabilities', '.staging');
        fs.mkdirSync(root, { recursive: true });
        const staged = path.join(root, `unsafe-${unsafeId}`);
        fs.mkdirSync(staged, { recursive: true });
        fs.writeFileSync(path.join(staged, 'capability.json'), JSON.stringify(
          { id: unsafeId, role: 'feature', version: '1.0.0', title: 'evil',
            description: 'evil', tier: 'standard', requires: [], engines: { gsd: '>=1.0.0' },
            runtimeCompat: { supported: ['*'], unsupported: [] },
            skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [] }
        ), 'utf8');
        return { id: unsafeId, version: '1.0.0', stagedDir: staged, integrity: null, source: spec };
      },
    });
    assert.strictEqual(res.status, 'blocked',
      `installCapability must block id='${unsafeId}'; got: ${res.status}`);
  }
});

test('root-fix-3: upgradeCapability rejects unsafe id (constructor) before staging/promotion', async (_t) => {
  const dir = runtime();

  // Install a safe version first.
  await lifecycle.installCapability('./safe', {
    runtimeDir: dir, hostVersion: '1.6.0',
    _resolve: fakeResolve(declarativeCap('safe-cap', '1.0.0')),
  });

  // Attempt an upgrade where the resolved id is 'constructor' (source retargeted to unsafe id).
  const result = await lifecycle.upgradeCapability('./evil-upgrade', {
    runtimeDir: dir, hostVersion: '1.6.0',
    _resolve: async (spec, opts) => {
      const root = path.join(opts.gsdHome, '.gsd', 'capabilities', '.staging');
      fs.mkdirSync(root, { recursive: true });
      const staged = path.join(root, 'unsafe-upgrade-test');
      fs.mkdirSync(staged, { recursive: true });
      fs.writeFileSync(path.join(staged, 'capability.json'), JSON.stringify(
        { id: 'constructor', role: 'feature', version: '2.0.0', title: 'evil',
          description: 'evil', tier: 'standard', requires: [], engines: { gsd: '>=1.0.0' },
          runtimeCompat: { supported: ['*'], unsupported: [] },
          skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [] }
      ), 'utf8');
      return { id: 'constructor', version: '2.0.0', stagedDir: staged, integrity: null, source: spec };
    },
  });

  assert.strictEqual(result.status, 'blocked',
    `upgradeCapability must block unsafe id='constructor'; got: ${result.status}`);
  assert.ok(!fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'constructor')),
    'no .gsd/capabilities/constructor bundle must be promoted on upgrade');
});

// ---------------------------------------------------------------------------
// FIX 5: removeCapability failure guidance must NOT reference 'gsd capability reconcile'
// (a non-existent CLI subcommand).
// ---------------------------------------------------------------------------

test('fix-5: removeCapability commit-fail guidance does not reference nonexistent "gsd capability reconcile" subcommand', async (t) => {
  const dir = runtime();

  // Install a capability.
  await lifecycle.installCapability('./fix5cap', {
    runtimeDir: dir, hostVersion: '1.6.0',
    _resolve: fakeResolve(declarativeCap('fix5cap')),
  });

  // Simulate commit failure by making the ledger write's renameSync throw.
  const { mock } = require('node:test');
  const realRename = fs.renameSync.bind(fs);
  const renameMock = mock.method(fs, 'renameSync', function (src, dst) {
    if (typeof dst === 'string' && dst.includes('.gsd-capabilities.json')) {
      const err = new Error('EXDEV: cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    }
    return realRename(src, dst);
  });
  t.after(() => renameMock.mock.restore());

  const result = lifecycle.removeCapability('fix5cap', { runtimeDir: dir });
  assert.strictEqual(result.status, 'blocked');

  const reason = (result.blockReasons || []).join(' ');
  assert.ok(
    !reason.includes('gsd capability reconcile'),
    `Failure guidance must not reference non-existent "gsd capability reconcile"; got: "${reason}"`,
  );
  // Must still mention a useful recovery action (inspect/restore the ledger file).
  assert.ok(
    reason.includes('ledger') || reason.includes('.gsd-capabilities.json') || reason.includes('remove'),
    `Failure guidance must mention the ledger or re-run remove; got: "${reason}"`,
  );
});

// ===========================================================================
// Orthogonal adversarial review (#1462) — durability / concurrency / Windows /
// DoS / UX cross-cutting findings. TDD red-first.
// ===========================================================================

// ---------------------------------------------------------------------------
// Finding 1 (HIGH): lock liveness via PROCESS START-TIME. The lock has oscillated
// (age-based→lost-update; pid-liveness→pid-reuse-deadlock; deadman→live-steal).
// The convergent design records THIS process's start-time in the lock body and,
// on the steal-decision path, treats a SAME-host holder as live ONLY if its pid
// is alive AND the pid's CURRENT start-time matches the recorded one. That pair
// (pid, start-time) identifies a process INSTANCE, so pid-reuse is detected as a
// start-time MISMATCH and stolen, while a verified-live holder is NEVER stolen
// (even past the deadman). A DIFFERENT host / unparseable-or-no-pid body can't be
// verified locally → stolen only by the deadman fallback. A fresh lock is never
// stolen.
//
// Tests inject DETERMINISTIC isPidAlive / getProcessStartTime via the exported
// _setLockProbes seam so the start-time branches are exercised without depending on
// real OS pids beyond the current process. Every test resets the probes in t.after.
// ---------------------------------------------------------------------------

/**
 * Build a JSON lock body matching the new lockfile shape. `startTime` is included by default; pass
 * `startTime: null` to simulate a body that did not record one (legacy-ish / unverifiable).
 */
function lockBody({ pid = process.pid, host = os.hostname(), ts = Date.now(), startTime = 'START-A' } = {}) {
  // First `-`-segment is still the pid (legacy token compatibility); the JSON body carries host + startTime.
  return JSON.stringify({ token: `${pid}-${ts}-1`, pid, hostname: host, startTime, ts });
}

function writeLock(dir, body, ageMs) {
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // Finding 1: age now binds to the BODY's own `ts` for a JSON body (not the file mtime). So a lock
  // that is `ageMs` old must carry a `ts` that is `ageMs` in the past — backdate BOTH the body ts (for
  // JSON bodies) AND the file mtime (for legacy/no-ts bodies, which still use the mtime fallback).
  let written = body;
  if (typeof body === 'string' && body.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(body);
      if (obj && typeof obj === 'object' && 'ts' in obj) {
        obj.ts = Date.now() - ageMs; // backdate the body's own timestamp to the intended age.
        written = JSON.stringify(obj);
      }
    } catch { /* not JSON after all — write verbatim */ }
  }
  fs.writeFileSync(lockPath, written, 'utf8');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, t, t);
  return lockPath;
}

/** Install deterministic lock probes and auto-reset them after the test. */
function withLockProbes(t, { alive, startTime }) {
  lifecycle._setLockProbes({ isPidAlive: () => alive, getProcessStartTime: () => startTime });
  t.after(() => lifecycle._resetLockProbes());
}

test('finding-1: acquireLock is exported (used by lock unit tests)', () => {
  assert.ok(typeof lifecycle.acquireLock === 'function', 'acquireLock must be exported for testing');
  assert.ok(typeof lifecycle._setLockProbes === 'function', '_setLockProbes seam must be exported');
  assert.ok(typeof lifecycle.getProcessStartTime === 'function', 'getProcessStartTime must be exported');
});

// Revert-fails: drop the start-time match from holderVerifiedLive (treat any live pid as live) →
// the verified-live SAME-host holder past the deadman is no longer protected and gets stolen, so
// acquireLock returns a handle and this strictEqual(null) assertion fails.
test('finding-1: a SAME-host VERIFIED-LIVE holder (pid alive + start-time MATCH) is NOT stolen — even past the deadman', (t) => {
  const dir = runtime();
  // pid alive AND its observed start-time equals the recorded one → verified-live → sacrosanct.
  withLockProbes(t, { alive: true, startTime: 'START-A' });
  const lockPath = writeLock(dir, lockBody({ pid: process.pid, host: os.hostname(), startTime: 'START-A' }), 11 * 60 * 1000);
  const original = fs.readFileSync(lockPath, 'utf8');
  const handle = lifecycle.acquireLock(dir);
  assert.strictEqual(handle, null,
    'a verified-live same-host holder must NEVER be stolen, even past the deadman');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), original, 'the verified-live lock body must be untouched');
});

// Same protection must hold UNDER the deadman too (the older deadman-only design would also block
// here, but this guards the explicit "verified-live → blocked" branch under the stale window).
// Revert-fails: same as above — drop the start-time match → stolen → handle non-null → fails.
test('finding-1: a SAME-host VERIFIED-LIVE holder (start-time MATCH), stale but under the deadman, is NOT stolen', (t) => {
  const dir = runtime();
  withLockProbes(t, { alive: true, startTime: 'START-A' });
  const lockPath = writeLock(dir, lockBody({ pid: process.pid, host: os.hostname(), startTime: 'START-A' }), 2 * 60 * 1000);
  const original = fs.readFileSync(lockPath, 'utf8');
  const handle = lifecycle.acquireLock(dir);
  assert.strictEqual(handle, null, 'a stale-but-verified-live same-host holder must NOT be stolen');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), original, 'the verified-live lock body must be untouched');
});

// Revert-fails: drop the start-time MISMATCH check in holderVerifiedLive (return true on any live
// pid) → the pid-reuse lock (alive pid, but a DIFFERENT current start-time) is treated as live and
// NOT stolen, so acquireLock returns null and this "must be stolen" assertion fails — the permanent
// pid-reuse deadlock the whole design exists to defeat.
test('finding-1: a SAME-host pid-reuse holder (pid alive but start-time MISMATCH) IS stolen after stale', (t) => {
  const dir = runtime();
  // pid is "alive" but its CURRENT start-time differs from the recorded one → reuse → steal-eligible.
  withLockProbes(t, { alive: true, startTime: 'NEW-START-after-reuse' });
  const lockPath = writeLock(dir, lockBody({ pid: process.pid, host: os.hostname(), startTime: 'OLD-START-before-crash' }), 2 * 60 * 1000);
  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle && handle.token,
    'a same-host lock whose pid is alive but whose start-time no longer matches (pid-reuse) must be stolen');
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, handle.token,
    'the stolen lock body must now carry OUR token');
  lifecycle.releaseLock(handle);
});

// Revert-fails: drop the dead-pid steal (require the deadman for same-host) → a demonstrably-dead
// local holder past the stale window but under the deadman is never stolen, so acquireLock returns
// null and this "must be stolen" assertion fails.
test('finding-1: a SAME-host stale (>60s, <deadman) lock with a DEAD pid is stolen (fast local recovery)', (t) => {
  const dir = runtime();
  withLockProbes(t, { alive: false, startTime: 'START-A' }); // pid dead → not verified-live
  writeLock(dir, lockBody({ pid: process.pid, host: os.hostname(), startTime: 'START-A' }), 2 * 60 * 1000);
  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle && handle.token,
    'a same-host stale lock whose pid is dead must be stolen before the deadman timeout');
  lifecycle.releaseLock(handle);
});

// Revert-fails: drop the "recorded.startTime != null" requirement (treat a live pid with no recorded
// start-time as verified-live) → a same-host live-pid lock that recorded NO start-time would be
// blocked and never stolen, so this "must be stolen" assertion fails. A start-time we cannot verify
// is NOT verified-live.
test('finding-1: a SAME-host live-pid lock with NO recorded start-time is stolen after stale (unverifiable liveness)', (t) => {
  const dir = runtime();
  withLockProbes(t, { alive: true, startTime: 'START-A' }); // pid "alive" but body recorded no start-time
  writeLock(dir, lockBody({ pid: process.pid, host: os.hostname(), startTime: null }), 2 * 60 * 1000);
  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle && handle.token,
    'a same-host live-pid lock whose body recorded no start-time cannot be verified-live → stolen after stale');
  lifecycle.releaseLock(handle);
});

// Revert-fails: drop the "observed start-time unobtainable → not live" handling (return true when
// getProcessStartTime is null) → a live-pid lock whose CURRENT start-time can't be read would be
// blocked and never stolen, so this "must be stolen" assertion fails.
test('finding-1: a SAME-host live-pid lock whose CURRENT start-time is unobtainable is stolen after stale', (t) => {
  const dir = runtime();
  withLockProbes(t, { alive: true, startTime: null }); // can't observe a current start-time
  writeLock(dir, lockBody({ pid: process.pid, host: os.hostname(), startTime: 'START-A' }), 2 * 60 * 1000);
  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle && handle.token,
    'a same-host live-pid lock whose current start-time is unobtainable cannot be verified-live → stolen');
  lifecycle.releaseLock(handle);
});

// Revert-fails: route a legacy (no-pid) body into the same-host-pid branch (or steal it before the
// deadman) → a legacy lock under the deadman would be stolen, so this strictEqual(null) fails.
// A no-pid body is unverifiable → only the deadman may reclaim it.
test('finding-1: a stale legacy (no parseable pid) lock UNDER the deadman is NOT stolen (deadman-only)', (t) => {
  const dir = runtime();
  withLockProbes(t, { alive: true, startTime: 'START-A' });
  const lockPath = writeLock(dir, 'legacy-token-no-pid', 2 * 60 * 1000); // non-JSON, no pid
  const original = fs.readFileSync(lockPath, 'utf8');
  const handle = lifecycle.acquireLock(dir);
  assert.strictEqual(handle, null,
    'a no-pid legacy lock under the deadman cannot be verified and must NOT be stolen yet');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), original, 'the legacy lock body must be untouched');
});

// Revert-fails: drop the deadman fallback for the no-pid branch → a legacy lock past the deadman is
// never reclaimed (permanent deadlock), so acquireLock returns null and this "must be stolen" fails.
test('finding-1: a stale legacy (no parseable pid) lock OLDER than the deadman IS stolen (deadman defeats deadlock)', (t) => {
  const dir = runtime();
  withLockProbes(t, { alive: true, startTime: 'START-A' });
  writeLock(dir, 'legacy-token-no-pid', 11 * 60 * 1000);
  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle && handle.token, 'a no-pid legacy lock past the deadman must be stolen');
  lifecycle.releaseLock(handle);
});

// Revert-fails: drop the DIFFERENT-host handling (judge any host by local pid liveness) → a remote
// lock under the deadman gets stolen via a local pid that happens to be alive, so this
// strictEqual(null) assertion fails. Local pid liveness is meaningless cross-host.
test('finding-1: a DIFFERENT-host stale (<deadman) lock is NOT stolen (local pid is meaningless cross-host)', (t) => {
  const dir = runtime();
  withLockProbes(t, { alive: true, startTime: 'START-A' });
  const lockPath = writeLock(dir, lockBody({ pid: process.pid, host: os.hostname() + '-OTHER-HOST' }), 2 * 60 * 1000);
  const original = fs.readFileSync(lockPath, 'utf8');
  const handle = lifecycle.acquireLock(dir);
  assert.strictEqual(handle, null,
    'a different-host lock under the deadman must NOT be stolen (local pid liveness is meaningless cross-host)');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), original, 'the cross-host lock body must be untouched');
});

// Revert-fails: drop the deadman branch for the different-host case → a remote lock past the deadman
// is never reclaimed, so acquireLock returns null and this "must be stolen" assertion fails.
test('finding-1: a DIFFERENT-host lock OLDER than the deadman timeout IS stolen', (t) => {
  const dir = runtime();
  withLockProbes(t, { alive: true, startTime: 'START-A' });
  writeLock(dir, lockBody({ pid: process.pid, host: os.hostname() + '-OTHER-HOST' }), 11 * 60 * 1000);
  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle && handle.token,
    'a different-host lock older than LOCK_DEADMAN_MS must be stolen (deadman defeats cross-host deadlock)');
  lifecycle.releaseLock(handle);
});

// Revert-fails: remove the fresh-lock short-circuit (age <= LOCK_STALE_MS) → a 1-second-old lock
// would be evaluated for stealing and (with a dead pid) stolen, so this strictEqual(null) fails.
test('finding-1: a FRESH lock (under the stale window) is never stolen regardless of host/pid', (t) => {
  const dir = runtime();
  withLockProbes(t, { alive: false, startTime: 'START-A' }); // even a dead pid must not matter while fresh
  const lockPath = writeLock(dir, lockBody({ pid: process.pid, host: os.hostname() }), 1000);
  const original = fs.readFileSync(lockPath, 'utf8');
  const handle = lifecycle.acquireLock(dir);
  assert.strictEqual(handle, null, 'a fresh lock must never be stolen');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), original, 'fresh lock body untouched');
});

// Finding 2 (MEDIUM): the lock body is untrusted. An OVERSIZED lock body must NOT be read whole; it
// is treated as unparseable (no pid/host) → routed to the deadman policy.
//
// The oversized body is crafted so that, IF it were (wrongly) read, it would parse as a SAME-host,
// alive-pid holder with a MISMATCHED start-time (pid-reuse) → which is steal-eligible after stale. So
// WITHOUT the size cap the lock would be STOLEN (handle non-null); WITH the cap it is treated as
// no-pid → NOT stolen under the deadman (handle null). The `strictEqual(null)` assertion therefore
// holds ONLY when the cap is in effect — a true discriminator, not a vacuous pass.
//
// Revert-fails: drop the statSync size-cap in readParsedLockBounded (read the whole body) → the body
// parses as an alive same-host holder with a mismatched start-time and is STOLEN, so acquireLock
// returns a handle and this strictEqual(null) assertion fails.
test('finding-2: an OVERSIZED lock body is treated as unparseable (no pid) and NOT stolen under the deadman', (t) => {
  const dir = runtime();
  // pid "alive" but the OBSERVED start-time differs from the recorded one → if the body were read it
  // would look like steal-eligible pid-reuse. The size cap must prevent that read entirely.
  withLockProbes(t, { alive: true, startTime: 'OBSERVED-NEW' });
  const huge = JSON.stringify({ token: 't', pid: process.pid, hostname: os.hostname(), startTime: 'RECORDED-OLD', ts: Date.now(), pad: 'x'.repeat(70 * 1024) });
  assert.ok(huge.length > 64 * 1024, 'test body must exceed the 64 KiB cap');
  const lockPath = writeLock(dir, huge, 2 * 60 * 1000); // stale, under the deadman
  const handle = lifecycle.acquireLock(dir);
  assert.strictEqual(handle, null,
    'an oversized lock body must be treated as unverifiable (no pid) → NOT stolen under the deadman');
  assert.ok(fs.existsSync(lockPath), 'the oversized lock must remain in place (not read/stolen)');
});

// Revert-fails: drop the startTime field from the lock body written by acquireLock → the body has no
// `startTime` key, so this assertion (startTime present + equals the cached self start-time when
// obtainable, else null) fails on the missing key.
test('finding-1: acquireLock records hostname + pid + token + startTime in the lockfile body', () => {
  const dir = runtime();
  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle, 'acquireLock must succeed on a fresh dir');
  const raw = fs.readFileSync(handle.path, 'utf8');
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'lock body must be JSON');
  assert.strictEqual(parsed.hostname, os.hostname(), 'lock body must record the hostname');
  assert.strictEqual(parsed.pid, process.pid, 'lock body must record the pid');
  assert.strictEqual(typeof parsed.token, 'string', 'lock body must record the owner token');
  assert.strictEqual(parsed.token, handle.token, 'the recorded token must equal the handle token');
  // startTime must be PRESENT as a key (string when obtainable on this OS, null otherwise) — and must
  // equal what getProcessStartTime reports for THIS process (the cached self start-time).
  assert.ok('startTime' in parsed, 'lock body must record a startTime key');
  const selfStart = lifecycle.getProcessStartTime(process.pid);
  assert.strictEqual(parsed.startTime, selfStart === null ? null : selfStart,
    'recorded startTime must equal this process\'s observed start-time');
  lifecycle.releaseLock(handle);
});

// ---------------------------------------------------------------------------
// Finding 1 (HIGH): lock-steal TOCTOU — stale `mtime` age applied to a REPLACEMENT
// lock body. A acquirer must bind its age decision to the SAME body instance it acts
// on: for a JSON body the age comes from the body's own `ts` field (now - body.ts),
// NOT the file `mtime` (a fresh replacement body carries a fresh `ts` → small age →
// not stolen). And immediately BEFORE the atomic rename-steal it must re-stat and
// confirm dev/ino (and, for JSON, body `ts`) are UNCHANGED; if changed → do NOT
// steal, retry the bounded loop (B's fresh lock must not be rename-stolen).
// ---------------------------------------------------------------------------

// Revert-fails: derive age from `mtime` instead of the body `ts` → the body carries a RECENT ts but
// the file mtime is backdated 2 min, so a mtime-age would read it as STALE and (pid dead) STEAL it,
// making handle non-null. With ts-bound age the lock is FRESH → NOT stolen, so this strictEqual(null)
// holds only when age is bound to the body instance.
test('finding-1: a JSON lock with a RECENT body `ts` but an artificially-OLD mtime is NOT stolen (age binds to the body, not mtime)', (t) => {
  const dir = runtime();
  // pid "dead" so a mtime-derived STALE age would steal it; only ts-bound freshness can protect it.
  withLockProbes(t, { alive: false, startTime: 'START-A' });
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // Body `ts` is NOW (fresh replacement); file mtime is backdated 2 minutes (would look stale).
  const freshBody = JSON.stringify({ token: `${process.pid}-${Date.now()}-1`, pid: process.pid, hostname: os.hostname(), startTime: 'START-A', ts: Date.now() });
  fs.writeFileSync(lockPath, freshBody, 'utf8');
  const old = new Date(Date.now() - 2 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);

  const handle = lifecycle.acquireLock(dir);
  assert.strictEqual(handle, null,
    'a JSON lock whose BODY ts is fresh must be treated as FRESH (not stolen) even with an old mtime');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), freshBody, 'the fresh-ts lock body must be untouched');
});

// A legacy/no-`ts` body still uses the mtime age (fallback). Revert-fails: if the fallback to mtime
// for a no-ts body is dropped (e.g. treat missing ts as age 0 = fresh), a stale dead-pid legacy lock
// past the deadman would never be stolen and this "must be stolen" assertion fails.
test('finding-1: a legacy/no-`ts` body falls back to mtime age (stale past deadman → stolen)', (t) => {
  const dir = runtime();
  withLockProbes(t, { alive: true, startTime: 'START-A' });
  writeLock(dir, 'legacy-token-no-pid', 11 * 60 * 1000); // no ts → mtime age → past deadman
  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle && handle.token, 'a no-ts legacy lock past the deadman (mtime age) must be stolen');
  lifecycle.releaseLock(handle);
});

// Revert-fails: drop the pre-rename dev/ino recheck → when B replaces the lock inode between A's
// steal-decision and A's rename, A rename-steals B's FRESH lock (concurrent mutation). With the
// recheck, the changed inode makes A `continue` (no steal), so the on-disk lock is never renamed —
// this test forces a DIFFERENT ino on every recheck stat and asserts A never steals (returns null,
// body untouched).
test('finding-1: an inode change between the steal-decision and the rename causes a RETRY, not a steal', (t) => {
  const dir = runtime();
  const { mock } = require('node:test');
  withLockProbes(t, { alive: false, startTime: 'START-A' }); // dead pid → otherwise steal-eligible
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // Stale legacy body (no ts → mtime age), backdated past the deadman so the steal branch is reached.
  const body = 'legacy-token-no-pid';
  fs.writeFileSync(lockPath, body, 'utf8');
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);

  // openSync('wx') always reports the lock held; renameSync would (without the recheck) "succeed".
  const realOpen = fs.openSync.bind(fs);
  const openMock = mock.method(fs, 'openSync', function (p, flags, ...rest) {
    if (typeof p === 'string' && p.endsWith('.lock') && flags === 'wx') {
      const err = new Error('EEXIST'); err.code = 'EEXIST'; throw err;
    }
    return realOpen(p, flags, ...rest);
  });
  // Alternate the reported inode: the DECISION stat sees ino=1, the pre-rename RECHECK stat sees
  // ino=2 (B swapped the inode). Every recheck therefore observes a changed inode → A must retry.
  let statCalls = 0;
  const realStat = fs.statSync.bind(fs);
  const statMock = mock.method(fs, 'statSync', function (p, ...rest) {
    if (typeof p === 'string' && p.endsWith('.lock')) {
      statCalls += 1;
      const ino = (statCalls % 2 === 1) ? 1 : 2; // decision: 1, recheck: 2 (changed)
      return { mtimeMs: Date.now() - 11 * 60 * 1000, dev: 1, ino, size: body.length, isFile: () => true };
    }
    return realStat(p, ...rest);
  });
  // If the recheck were absent, rename would fire and steal; track whether it was ever called on .lock.
  let renamedLock = false;
  const renameMock = mock.method(fs, 'renameSync', function (from, ...rest) {
    if (typeof from === 'string' && from.endsWith('.lock')) { renamedLock = true; return; }
    return require('node:fs').renameSync.wrappedMethod
      ? require('node:fs').renameSync.wrappedMethod(from, ...rest)
      : undefined;
  });
  t.after(() => { openMock.mock.restore(); statMock.mock.restore(); renameMock.mock.restore(); });

  const handle = lifecycle.acquireLock(dir);
  assert.strictEqual(handle, null, 'A must NOT acquire (every recheck saw a changed inode → retry, never steal)');
  assert.strictEqual(renamedLock, false, 'A must NEVER rename-steal a lock whose inode changed under it');
  assert.ok(statCalls >= 2, 'both a decision-stat and a pre-rename recheck-stat must have run');
});

// Revert-fails: drop the pre-rename body `ts` recheck for JSON bodies → when B replaces the JSON body
// with a fresh `ts` (same inode) between A's decision and rename, A still steals. With the ts recheck,
// the changed ts makes A `continue`. Here the DECISION read sees an OLD ts (steal-eligible) but the
// RECHECK read sees a NEW ts → A must NOT steal.
test('finding-1: a body `ts` change between the steal-decision and the rename causes a RETRY, not a steal', (t) => {
  const dir = runtime();
  const { mock } = require('node:test');
  withLockProbes(t, { alive: false, startTime: 'START-A' }); // dead pid → steal-eligible if stale
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // DECISION body: OLD ts (stale → steal-eligible with a dead pid). RECHECK body: fresh ts (B's swap).
  const oldTs = Date.now() - 2 * 60 * 1000;
  const oldBody = JSON.stringify({ token: 't-old', pid: process.pid, hostname: os.hostname(), startTime: 'START-A', ts: oldTs });
  const newBody = JSON.stringify({ token: 't-new', pid: process.pid, hostname: os.hostname(), startTime: 'START-A', ts: Date.now() });
  fs.writeFileSync(lockPath, oldBody, 'utf8');

  // Track which fds belong to the .lock so fstat/readSync can be steered for them only. A 'wx' create
  // throws EEXIST (held); an O_RDONLY|O_NONBLOCK read open returns the real fd and is registered.
  const lockFds = new Set();
  const realOpen = fs.openSync.bind(fs);
  const openMock = mock.method(fs, 'openSync', function (p, flags, ...rest) {
    if (typeof p === 'string' && p.endsWith('.lock') && flags === 'wx') {
      const err = new Error('EEXIST'); err.code = 'EEXIST'; throw err;
    }
    const fd = realOpen(p, flags, ...rest);
    if (typeof p === 'string' && p.endsWith('.lock')) lockFds.add(fd);
    return fd;
  });
  // Same dev/ino across stats (so the body TS — not the inode — is the discriminator under test).
  const realStat = fs.statSync.bind(fs);
  const statMock = mock.method(fs, 'statSync', function (p, ...rest) {
    if (typeof p === 'string' && p.endsWith('.lock')) {
      return { mtimeMs: oldTs, dev: 7, ino: 7, size: oldBody.length, isFile: () => true };
    }
    return realStat(p, ...rest);
  });
  // The body is read via the fd-based reader (fstatSync + readSync). The DECISION read (the 1st
  // readSmallRegularFile of the .lock) returns oldBody; every later RECHECK read returns newBody.
  // Count fstatSync calls on .lock fds — one per readSmallRegularFile — to alternate the body.
  const realFstat = fs.fstatSync.bind(fs);
  let bodyReads = 0;
  let activeBody = oldBody;
  const fstatMock = mock.method(fs, 'fstatSync', function (fd, ...rest) {
    if (lockFds.has(fd)) {
      bodyReads += 1;
      activeBody = bodyReads === 1 ? oldBody : newBody; // decision: old, recheck(s): new
      return { isFile: () => true, isDirectory: () => false, size: activeBody.length };
    }
    return realFstat(fd, ...rest);
  });
  const realReadSync = fs.readSync.bind(fs);
  const readMock = mock.method(fs, 'readSync', function (fd, buffer, offset, length, position, ...rest) {
    if (lockFds.has(fd)) {
      const bytes = Buffer.from(activeBody, 'utf8');
      const n = Math.min(length, bytes.length - (position || 0));
      if (n <= 0) return 0;
      bytes.copy(buffer, offset, position || 0, (position || 0) + n);
      return n;
    }
    return realReadSync(fd, buffer, offset, length, position, ...rest);
  });
  let renamedLock = false;
  const renameMock = mock.method(fs, 'renameSync', function (from) {
    if (typeof from === 'string' && from.endsWith('.lock')) { renamedLock = true; return; }
    return undefined;
  });
  t.after(() => { openMock.mock.restore(); statMock.mock.restore(); fstatMock.mock.restore(); readMock.mock.restore(); renameMock.mock.restore(); });

  const handle = lifecycle.acquireLock(dir);
  assert.strictEqual(handle, null, 'A must NOT steal a JSON lock whose body ts changed (B replaced it) before the rename');
  assert.strictEqual(renamedLock, false, 'A must NEVER rename-steal a lock whose body ts changed under it');
  assert.ok(bodyReads >= 2, 'both a decision body-read and a pre-rename recheck body-read must have run');
});

// Finding 3 (LOW): sameLockInstance must reject a DISAPPEARING ts, not just a ts mismatch. If the
// DECISION body had a non-null JSON ts but the RECHECK body (same inode) is now no-ts/garbage, the
// "ts re-confirmed before steal" invariant is broken — the body changed under us, so A must retry,
// NOT steal. (The prior code only rejected when BOTH ts were non-null and differed; a null recheck ts
// slipped through as "same".)
// Revert-fails: keep the old `a.ts !== null && b.ts !== null && a.ts !== b.ts` guard → a decision ts
// that goes null on recheck is treated as the SAME instance, so A rename-steals it; this
// strictEqual(null)/renamedLock===false pair fails.
test('finding-3: a body `ts` going NULL between the steal-decision and the rename causes a RETRY, not a steal', (t) => {
  const dir = runtime();
  const { mock } = require('node:test');
  withLockProbes(t, { alive: false, startTime: 'START-A' }); // dead pid → steal-eligible if stale
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // DECISION body: a JSON body with a non-null OLD ts (stale → steal-eligible with a dead pid).
  // RECHECK body: a no-`ts` legacy/garbage body on the SAME inode (B replaced the body content).
  const oldTs = Date.now() - 2 * 60 * 1000;
  const oldBody = JSON.stringify({ token: 't-old', pid: process.pid, hostname: os.hostname(), startTime: 'START-A', ts: oldTs });
  const recheckBody = 'legacy-no-ts-garbage';
  fs.writeFileSync(lockPath, oldBody, 'utf8');

  const lockFds = new Set();
  const realOpen = fs.openSync.bind(fs);
  const openMock = mock.method(fs, 'openSync', function (p, flags, ...rest) {
    if (typeof p === 'string' && p.endsWith('.lock') && flags === 'wx') {
      const err = new Error('EEXIST'); err.code = 'EEXIST'; throw err;
    }
    const fd = realOpen(p, flags, ...rest);
    if (typeof p === 'string' && p.endsWith('.lock')) lockFds.add(fd);
    return fd;
  });
  // Same dev/ino across stats (so the body ts disappearing — not the inode — is the discriminator).
  const realStat = fs.statSync.bind(fs);
  const statMock = mock.method(fs, 'statSync', function (p, ...rest) {
    if (typeof p === 'string' && p.endsWith('.lock')) {
      return { mtimeMs: oldTs, dev: 9, ino: 9, size: oldBody.length, isFile: () => true };
    }
    return realStat(p, ...rest);
  });
  // fd-based reader (fstatSync + readSync): 1st .lock body read = oldBody (has ts); later reads =
  // recheckBody (no ts). Alternate on the fstatSync call count (one per readSmallRegularFile).
  const realFstat = fs.fstatSync.bind(fs);
  let bodyReads = 0;
  let activeBody = oldBody;
  const fstatMock = mock.method(fs, 'fstatSync', function (fd, ...rest) {
    if (lockFds.has(fd)) {
      bodyReads += 1;
      activeBody = bodyReads === 1 ? oldBody : recheckBody; // decision: has-ts, recheck(s): no-ts
      return { isFile: () => true, isDirectory: () => false, size: activeBody.length };
    }
    return realFstat(fd, ...rest);
  });
  const realReadSync = fs.readSync.bind(fs);
  const readMock = mock.method(fs, 'readSync', function (fd, buffer, offset, length, position, ...rest) {
    if (lockFds.has(fd)) {
      const bytes = Buffer.from(activeBody, 'utf8');
      const n = Math.min(length, bytes.length - (position || 0));
      if (n <= 0) return 0;
      bytes.copy(buffer, offset, position || 0, (position || 0) + n);
      return n;
    }
    return realReadSync(fd, buffer, offset, length, position, ...rest);
  });
  let renamedLock = false;
  const renameMock = mock.method(fs, 'renameSync', function (from) {
    if (typeof from === 'string' && from.endsWith('.lock')) { renamedLock = true; return; }
    return undefined;
  });
  t.after(() => { openMock.mock.restore(); statMock.mock.restore(); fstatMock.mock.restore(); readMock.mock.restore(); renameMock.mock.restore(); });

  const handle = lifecycle.acquireLock(dir);
  assert.strictEqual(handle, null, 'A must NOT steal a lock whose decision ts went NULL on recheck (body changed)');
  assert.strictEqual(renamedLock, false, 'A must NEVER rename-steal a lock whose body ts disappeared under it');
  assert.ok(bodyReads >= 2, 'both a decision body-read and a pre-rename recheck body-read must have run');
});

// ---------------------------------------------------------------------------
// Finding 2 (HIGH): the lock body is untrusted — its bounded read must go through the
// shared fd-based regular-file reader (reject FIFO/device/non-regular, cap size) so a
// FIFO/device/symlink lock cannot block or read unbounded. A non-regular lock body is
// treated as unparseable (no pid/host) → deadman policy (not stolen under the deadman).
// ---------------------------------------------------------------------------

// Revert-fails: read the lock body via statSync(path)+readFileSync(path) → a FIFO lock body blocks
// acquireLock forever (no writer). With the fd-based regular-file reader the FIFO body is rejected as
// non-regular → unparseable (no pid) → NOT stolen under the deadman, so acquireLock returns promptly.
test('finding-2: a FIFO lock body does NOT hang acquireLock — treated as unparseable (deadman policy)', (t) => {
  const dir = runtime();
  withLockProbes(t, { alive: true, startTime: 'START-A' });
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (!tryMkfifoLife(lockPath)) { t.skip('mkfifo unavailable on this platform'); return; }
  const old = new Date(Date.now() - 2 * 60 * 1000); // stale, under the deadman
  try { fs.utimesSync(lockPath, old, old); } catch { /* FIFO utimes best-effort */ }

  let handle;
  assert.doesNotThrow(() => { handle = lifecycle.acquireLock(dir); },
    'acquireLock must not hang/throw on a FIFO lock body');
  assert.strictEqual(handle, null,
    'a FIFO (non-regular) lock body is unparseable (no pid) → NOT stolen under the deadman');
});

// ---------------------------------------------------------------------------
// Finding 3 (LOW): partial lock orphan. After openSync(lockPath,'wx') succeeds, a
// body-write/closeSync failure must unlink the just-created (empty) .lock so it does
// not self-block until the deadman. Revert-fails: drop the cleanup-unlink → the
// orphan .lock remains and this "no .lock left behind" assertion fails.
//
// Finding 2 (MEDIUM): the lock body is written with fs.writeFileSync(fd, …) (full-buffer write, no
// short-writes), NOT a bare fs.writeSync(fd, …). Mocking fs.writeFileSync to fail proves the body
// write goes through writeFileSync — if the code regressed to a bare writeSync this mock would NOT
// fire, the write would succeed, and acquireLock would return a handle (this strictEqual(null) fails).
// ---------------------------------------------------------------------------

test('finding-3/2: a body-write (writeFileSync) failure after the exclusive create leaves NO orphan .lock behind', (t) => {
  const dir = runtime();
  const { mock } = require('node:test');
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // Let the exclusive create succeed (real openSync), then force the body write to fail. The body MUST
  // be written via writeFileSync (finding 2), so mocking writeFileSync to throw is what trips it; if
  // the code used a bare writeSync this would never fire (proving writeFileSync is the write path).
  let writeFileFired = false;
  const writeFileMock = mock.method(fs, 'writeFileSync', function (fd) {
    // Only fail the fd-targeted lock body write (a numeric fd), not any path-based writes.
    if (typeof fd === 'number') {
      writeFileFired = true;
      const err = new Error('ENOSPC: no space left on device'); err.code = 'ENOSPC'; throw err;
    }
    return undefined;
  });
  t.after(() => { writeFileMock.mock.restore(); });

  const handle = lifecycle.acquireLock(dir);
  assert.ok(writeFileFired, 'the lock body must be written via fs.writeFileSync(fd, …) (finding 2 short-write fix)');
  assert.strictEqual(handle, null, 'acquireLock must return null when the lock body write fails');
  assert.ok(!fs.existsSync(lockPath),
    'the empty .lock created before the failed write must be unlinked (no self-blocking orphan)');
});

// Finding 5(c): the closeSync-failure variant. After openSync(lockPath,'wx') succeeds and the body
// write succeeds, a closeSync failure must ALSO unlink the just-created .lock (the body may be
// unflushed/partial) so no self-blocking orphan remains until the deadman.
// Revert-fails: drop the closeSync-error cleanup-unlink in acquireLock → the .lock written before the
// failed close is left behind and this "no .lock left behind" assertion fails.
test('finding-3: a closeSync failure after the exclusive create+write leaves NO orphan .lock behind', (t) => {
  const dir = runtime();
  const { mock } = require('node:test');
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // Let the exclusive create AND the body write succeed; force ONLY the .lock fd's closeSync to fail.
  // Track which fds belong to the .lock so unrelated closeSync calls (dir fsync, etc.) are untouched.
  const realOpen = fs.openSync.bind(fs);
  const lockFds = new Set();
  const openMock = mock.method(fs, 'openSync', function (p, flags, ...rest) {
    const fd = realOpen(p, flags, ...rest);
    if (typeof p === 'string' && p.endsWith('.lock') && flags === 'wx') lockFds.add(fd);
    return fd;
  });
  const realClose = fs.closeSync.bind(fs);
  const closeMock = mock.method(fs, 'closeSync', function (fd, ...rest) {
    if (lockFds.has(fd)) {
      lockFds.delete(fd);
      const err = new Error('EIO: delayed-writeback failure on close'); err.code = 'EIO'; throw err;
    }
    return realClose(fd, ...rest);
  });
  t.after(() => { openMock.mock.restore(); closeMock.mock.restore(); });

  const handle = lifecycle.acquireLock(dir);
  assert.strictEqual(handle, null, 'acquireLock must return null when the lock fd close fails');
  assert.ok(!fs.existsSync(lockPath),
    'the .lock created before the failed close must be unlinked (no self-blocking orphan)');
});

// ---------------------------------------------------------------------------
// Finding 1 (HIGH): a FUTURE / implausibly-far-future body `ts` must NOT deadlock the
// lock forever. age = now - ts goes negative (or stays tiny) for a future ts, keeping
// age <= LOCK_STALE_MS so the lock is NEVER stale/deadman/steal-eligible → permanent
// block. The fix distrusts a future ts and falls back to the file `mtime` for the age,
// so stale/deadman recovery still bounds the lock.
// ---------------------------------------------------------------------------

// Revert-fails: drop the future-ts guard (use `now - ts` even when ts is in the future) → the
// far-future body ts makes age negative (<= LOCK_STALE_MS) forever, so the lock is never stolen and
// acquireLock returns null — this "must be stolen" assertion fails (the permanent deadlock).
test('finding-1: a lock whose JSON body `ts` is far in the FUTURE is still reclaimed (mtime fallback), not blocked forever', (t) => {
  const dir = runtime();
  // Different host + past the deadman by MTIME so the deadman branch reclaims it once the future ts is
  // distrusted. (A future ts under the trusting code would compute a negative age → never stale.)
  withLockProbes(t, { alive: true, startTime: 'START-A' });
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // Body ts is 1 hour in the FUTURE; file mtime is backdated 11 min (past the deadman).
  const futureBody = JSON.stringify({
    token: 't-future', pid: process.pid, hostname: os.hostname() + '-OTHER-HOST',
    startTime: 'START-A', ts: Date.now() + 60 * 60 * 1000,
  });
  fs.writeFileSync(lockPath, futureBody, 'utf8');
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);

  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle && handle.token,
    'a lock with a far-FUTURE body ts must distrust the ts and fall back to mtime age → reclaimed past the deadman');
  lifecycle.releaseLock(handle);
});

// ---------------------------------------------------------------------------
// Finding 4 (LOW): releaseLock check-then-unlink TOCTOU minimization. The original
// holder must rmSync ONLY when its OWN owner token is still in the lock body. A
// SUCCESSOR lock (a new acquirer's lock at the same path, with a DIFFERENT token)
// must NOT be deleted by the original holder's stale release.
//
// The PRIMARY, portable discriminator is the TOKEN re-check: a real successor wrote a
// different token, so releaseLock reads a non-matching token and refuses to delete.
// (The dev/ino recheck in releaseLock is a best-effort SECONDARY guard that may be
// defeated by inode reuse on some filesystems — e.g. Linux ext4/overlay reusing the
// freed inode after unlink+recreate — so this test does NOT rely on it: it asserts the
// token mechanism, which holds on macOS AND Linux.)
// ---------------------------------------------------------------------------

// Revert-fails: drop the token re-check in releaseLock (delete on inode-match-only, or unconditionally)
// → the original holder rmSyncs the successor's lock at the same path even though the body now carries a
// DIFFERENT token, so the successor .lock is deleted and this "successor survives" assertion fails. The
// token re-check (body token != handle.token) is what prevents the delete.
test('finding-4: releaseLock does NOT delete a SUCCESSOR lock (different token) at the same path', () => {
  const dir = runtime();
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');

  // The original holder acquires (captures its token + dev/ino in the handle).
  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle && handle.path === lockPath, 'original holder must acquire the lock');

  // Simulate the lock being stale-stolen then re-created by a SUCCESSOR at the same path with a
  // DIFFERENT token. We do NOT mock the body read — releaseLock reads the REAL successor token below.
  // (We deliberately do not assert anything about the inode: Linux may reuse the freed inode after
  // unlink+recreate, so inode-distinctness is non-portable and is NOT the mechanism under test.)
  fs.unlinkSync(lockPath);
  const successorBody = JSON.stringify({
    token: 'successor-token', pid: process.pid, hostname: os.hostname(), startTime: 'START-A', ts: Date.now(),
  });
  fs.writeFileSync(lockPath, successorBody, 'utf8');
  assert.notStrictEqual(handle.token, 'successor-token', 'the successor token must differ from the original holder token');

  lifecycle.releaseLock(handle);

  assert.ok(fs.existsSync(lockPath), 'the SUCCESSOR lock at the same path must NOT be deleted by the original holder');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), successorBody,
    'the successor lock body must be untouched (original holder read a non-matching token and did not rmSync it)');
});

// Sanity companion: the NORMAL case (same inode + our token) still releases (so the inode guard does
// not break legitimate release). Revert this would not be a fix-revert; it pins that the guard is not
// over-strict (the dev/ino captured at acquire matches the unchanged on-disk lock → rmSync runs).
test('finding-4: releaseLock STILL deletes our own unchanged lock (inode guard is not over-strict)', () => {
  const dir = runtime();
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle, 'must acquire');
  assert.ok(fs.existsSync(lockPath), 'lock present before release');
  lifecycle.releaseLock(handle);
  assert.ok(!fs.existsSync(lockPath), 'our own unchanged lock (matching token + inode) must be released');
});

// ---------------------------------------------------------------------------
// CONC-2 / DOS-1 (LOW): acquireLock must be a BOUNDED iterative loop, not
// unbounded recursion. A pathological never-acquirable lock must return null
// without a stack overflow.
// Revert-fails: restore the recursive `return acquireLock(runtimeDir)` calls →
// the forced infinite contention recurses until RangeError (stack overflow),
// so this test throws instead of returning null within the attempt cap.
// ---------------------------------------------------------------------------

test('CONC-2: acquireLock returns null on contention exhaustion WITHOUT a stack overflow (bounded loop)', (t) => {
  const dir = runtime();
  const { mock } = require('node:test');
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // TV-06/07/11/17: a FAITHFUL pathological-contention sim. Write a REAL, stale, DEAD-pid JSON lock body
  // on disk so the lock body is read through the actual fd-based bounded reader (openSync 'r' → fstatSync
  // → readSync) — exactly the production path — instead of a bogus readFileSync mock that never fires.
  // The DEAD pid (probe alive:false) makes the holder steal-eligible.
  fs.writeFileSync(lockPath, lockBody({ pid: 999999999, host: os.hostname(), startTime: null, ts: Date.now() - 10 * 60 * 1000 }), 'utf8');
  withLockProbes(t, { alive: false, startTime: null }); // dead, unverifiable → steal-eligible

  // openSync: only the EXCLUSIVE create ('wx') of the .lock is forced to EEXIST (always "held"); every
  // other open — including the fd reader's O_RDONLY open of the lock body — delegates to the real fn so
  // the JSON body is genuinely read. TV-06: capture the real fn BEFORE mocking and delegate in else.
  const realOpen = fs.openSync.bind(fs);
  const openMock = mock.method(fs, 'openSync', function (p, flags, ...rest) {
    if (typeof p === 'string' && p.endsWith('.lock') && flags === 'wx') {
      const err = new Error('EEXIST: file already exists'); err.code = 'EEXIST'; throw err;
    }
    return realOpen(p, flags, ...rest);
  });
  // statSync: keep the .lock looking PRESENT + STALE so the steal branch is taken on every attempt even
  // after a real rename moves the file aside. TV-06: capture+delegate the real fn in the else branch.
  // TV-11: include `size` (and dev/ino) so a stat consumer that reads them gets a complete stat object.
  const realStat = fs.statSync.bind(fs);
  const staleMtime = Date.now() - 10 * 60 * 1000;
  const statMock = mock.method(fs, 'statSync', function (p, ...rest) {
    if (typeof p === 'string' && p.endsWith('.lock')) {
      return { mtimeMs: staleMtime, size: 256, dev: 1, ino: 1, isFile: () => true, isDirectory: () => false };
    }
    return realStat(p, ...rest);
  });
  // renameSync / rmSync: TV-18 — delegate to the REAL fns (capture before mocking). A real steal moves
  // the lock aside and removes it, but the mocked 'wx' open keeps throwing EEXIST, so acquireLock can
  // never actually acquire → the bounded loop runs to exhaustion and returns null (no recursion/SO).
  const realRename = fs.renameSync.bind(fs);
  const realRm = fs.rmSync.bind(fs);
  const renameMock = mock.method(fs, 'renameSync', function (src, dst, ...rest) { return realRename(src, dst, ...rest); });
  const rmMock = mock.method(fs, 'rmSync', function (p, ...rest) { return realRm(p, ...rest); });
  t.after(() => { openMock.mock.restore(); statMock.mock.restore(); renameMock.mock.restore(); rmMock.mock.restore(); });

  let handle;
  assert.doesNotThrow(
    () => { handle = lifecycle.acquireLock(dir); },
    'acquireLock must not throw (no stack overflow) under pathological contention',
  );
  assert.strictEqual(handle, null, 'acquireLock must return null on attempt exhaustion');
});

// ---------------------------------------------------------------------------
// MEDIUM finding — future mtime can deadlock lock recovery.
//
// `lockAgeMs` already distrusts a future body `ts` and falls back to `mtime`.
// But if `mtime` is ALSO in the future (planted lock, or system clock stepped
// backward after the lock was written), `Date.now() - mtimeMs` is negative →
// `age <= LOCK_STALE_MS` stays true → the lock is treated as "fresh" forever →
// permanent block of all capability mutations.
//
// Fix: when the mtime fallback also yields a negative age (untrustworthy source),
// return `Number.MAX_SAFE_INTEGER` so the lock routes into the normal steal
// decision tree. The verified-live guard (same-host + pid alive + start-time
// match) is age-independent and still prevents false steals.
// ---------------------------------------------------------------------------

// Revert-fails: revert the `Number.MAX_SAFE_INTEGER` clamp in lockAgeMs (leave the
// raw `Date.now() - mtimeMs` when it is negative) → age stays negative →
// `age <= LOCK_STALE_MS` is always true → acquireLock returns null instead of a
// handle, so this `assert.ok(handle && handle.token)` fails.
test('MEDIUM: future mtime + DEAD pid → lock IS stolen (negative mtime age must not deadlock recovery)', (t) => {
  const dir = runtime();
  // Probe: pid is dead AND no start-time → definitely not verified-live.
  withLockProbes(t, { alive: false, startTime: 'START-A' });
  // Write a lock with FUTURE body ts AND future mtime (negative ageMs = future).
  // writeLock(dir, body, ageMs) sets both `obj.ts = Date.now() - ageMs` and
  // `utimesSync` to `Date.now() - ageMs`; negative ageMs pushes both into the future.
  const FUTURE_MS = -5 * 60 * 1000; // 5 minutes in the future
  writeLock(dir, lockBody({ pid: process.pid, host: os.hostname(), startTime: 'START-A' }), FUTURE_MS);
  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle && handle.token,
    'a future-mtime lock with a dead pid must be stolen (negative age must clamp to MAX_SAFE_INTEGER, not block forever)');
  lifecycle.releaseLock(handle);
});

// Revert-fails: revert the clamp → age stays negative → acquireLock returns null
// (permanent block), so this `ok(handle)` fails.
test('MEDIUM: future body ts + future mtime + dead/unverifiable pid → lock IS stolen (both sources untrustworthy)', (t) => {
  const dir = runtime();
  withLockProbes(t, { alive: true, startTime: null }); // alive but start-time unobservable → unverifiable
  const FUTURE_MS = -10 * 60 * 1000; // 10 minutes in the future
  writeLock(dir, lockBody({ pid: process.pid, host: os.hostname(), startTime: 'START-A' }), FUTURE_MS);
  const handle = lifecycle.acquireLock(dir);
  assert.ok(handle && handle.token,
    'a lock with both future body-ts and future mtime, held by an unverifiable pid, must be stolen');
  lifecycle.releaseLock(handle);
});

// Revert-fails: NOT a fix-revert; pins that the clamp does NOT break the verified-live
// protection. A future-mtime lock whose holder is SAME-host + pid alive + start-time
// MATCH must NOT be stolen even after the age clamp kicks in (clamping to MAX_SAFE_INTEGER
// makes it steal-eligible by age, but the verified-live check is age-independent and still
// blocks the steal). If the clamp incorrectly bypasses verified-live, acquireLock returns a
// handle here instead of null, and the `strictEqual(null)` fails.
test('MEDIUM: future mtime + VERIFIED-LIVE same-host holder → lock is NOT stolen (clamp does not break liveness guard)', (t) => {
  const dir = runtime();
  // Probe: pid alive AND observed start-time MATCHES the recorded one → verified-live.
  withLockProbes(t, { alive: true, startTime: 'START-A' });
  const FUTURE_MS = -5 * 60 * 1000;
  const lockPath = writeLock(dir, lockBody({ pid: process.pid, host: os.hostname(), startTime: 'START-A' }), FUTURE_MS);
  const original = fs.readFileSync(lockPath, 'utf8');
  const handle = lifecycle.acquireLock(dir);
  assert.strictEqual(handle, null,
    'a future-mtime lock held by a verified-live same-host process must NOT be stolen');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), original, 'the verified-live lock body must be untouched');
});

// ---------------------------------------------------------------------------
// CONC-3 (LOW): backup names must carry a crypto nonce so two processes upgrading
// at the same millisecond cannot collide.
// Revert-fails: drop the randomBytes nonce from the upgrade backupName → with
// Date.now and pid stubbed equal the second upgrade's backupName equals the
// first's, so the captured backup names are identical and the inequality fails.
// ---------------------------------------------------------------------------

test('CONC-3: upgrade backupName includes a random nonce (collision-resistant across same-ms processes)', async (t) => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true,
    _resolve: fakeResolve(execCap('e', '1.0.0', { script: 'hooks/a.js' })),
  });

  // Capture the backupName the upgrade records into the _pending intent by spying on
  // ledgerMod.recordInstall and reading the _pending.backupName.
  const { mock } = require('node:test');
  const capturedBackupNames = [];
  const realRecord = ledgerMod.recordInstall.bind(ledgerMod);
  const recordMock = mock.method(ledgerMod, 'recordInstall', function (rd, entry) {
    if (entry && entry._pending && typeof entry._pending.backupName === 'string') {
      capturedBackupNames.push(entry._pending.backupName);
    }
    return realRecord(rd, entry);
  });
  // Freeze Date.now so the timestamp portion is identical between two upgrades — only the
  // nonce can differ.
  const realNow = Date.now;
  Date.now = () => 1700000000000;
  t.after(() => { recordMock.mock.restore(); Date.now = realNow; });

  await lifecycle.upgradeCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true,
    _resolve: fakeResolve(execCap('e', '2.0.0', { script: 'hooks/a.js' })),
  });
  await lifecycle.upgradeCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true,
    _resolve: fakeResolve(execCap('e', '3.0.0', { script: 'hooks/a.js' })),
  });

  assert.ok(capturedBackupNames.length >= 2,
    `must capture at least two upgrade backupNames; got: ${JSON.stringify(capturedBackupNames)}`);
  assert.notStrictEqual(capturedBackupNames[0], capturedBackupNames[1],
    `same-ms upgrade backup names must differ via the random nonce; got both: ${capturedBackupNames[0]}`);
});

// ---------------------------------------------------------------------------
// DUR-3 (HIGH): promoteStagingToFinal must fsync the parent directory after BOTH
// renames (old→backup AND staging→final) so a crash between them cannot lose the
// backup → reconcile silent-uninstall. The upgrade/reinstall path does exactly
// two renames, so it must produce exactly TWO parent-dir fsyncs.
// Revert-fails: drop EITHER fsyncDir(parent) in promoteStagingToFinal → the count
// drops to 1 (or 0) and the `=== 2` assertion fails (a one-fsync regression that the
// prior `>= 1` assertion would have silently passed).
//
// Note: the fd-tracking set REMOVES fds on close, because once a capsRoot dir fd is
// closed the OS may reuse the SAME fd number for an unrelated open (e.g. the ledger
// write's containing-dir fsync of runtimeDir), which must NOT be miscounted. Without
// close-tracking the count is noisy (observed 4) and would mask a regression to 2/3.
// ---------------------------------------------------------------------------

test('DUR-3: promoteStagingToFinal fsyncs the parent directory after BOTH renames (exactly two, durable backup swap)', async (t) => {
  const dir = runtime();
  // First install so a prior bundle exists (so the upgrade path renames old→backup).
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true,
    _resolve: fakeResolve(declarativeCap('e', '1.0.0')),
  });

  const capsRoot = path.join(dir, '.gsd', 'capabilities');
  const { mock } = require('node:test');
  const realOpen = fs.openSync.bind(fs);
  const realFsync = fs.fsyncSync.bind(fs);
  const realClose = fs.closeSync.bind(fs);
  const dirFds = new Set();
  let parentDirFsyncs = 0;
  const openMock = mock.method(fs, 'openSync', function (p, flags, ...rest) {
    const fd = realOpen(p, flags, ...rest);
    if (typeof p === 'string' && path.resolve(p) === path.resolve(capsRoot) && flags === 'r') dirFds.add(fd);
    return fd;
  });
  const fsyncMock = mock.method(fs, 'fsyncSync', function (fd, ...rest) {
    if (dirFds.has(fd)) parentDirFsyncs++;
    return realFsync(fd, ...rest);
  });
  const closeMock = mock.method(fs, 'closeSync', function (fd, ...rest) {
    // Drop the fd from the tracked set BEFORE closing: a reused fd number for a later non-capsRoot
    // open must not be counted as a capsRoot dir fsync.
    if (dirFds.has(fd)) dirFds.delete(fd);
    return realClose(fd, ...rest);
  });
  t.after(() => { openMock.mock.restore(); fsyncMock.mock.restore(); closeMock.mock.restore(); });

  // Reinstall over the existing bundle (upgrade-like path → old→backup, staging→final = two renames).
  const res = await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true,
    _resolve: fakeResolve(declarativeCap('e', '2.0.0')),
  });
  assert.strictEqual(res.status, 'installed');
  assert.strictEqual(parentDirFsyncs, 2,
    `promoteStagingToFinal must fsync the parent dir after BOTH renames (exactly 2); fsync count=${parentDirFsyncs}`);
});

// ---------------------------------------------------------------------------
// Finding 4 (MEDIUM): the directory fsync in the lifecycle (fsyncDir, used by
// promoteStagingToFinal) must NOT swallow ALL errors. It tolerates ONLY
// EISDIR/EPERM/EINVAL/EBADF; any other errno (e.g. EIO) RETHROWS (durability
// could not be confirmed). The dir fd must still be closed.
// ---------------------------------------------------------------------------

/** Mock fs.fsyncSync to throw `errno` ONLY for the capabilities-root dir fd (opened 'r'). */
function withLifecycleDirFsyncError(t, capsRoot, errno) {
  const dirFds = new Set();
  const closed = [];
  const realOpen = fs.openSync.bind(fs);
  const openMock = mock.method(fs, 'openSync', function (p, flags, ...rest) {
    const fd = realOpen(p, flags, ...rest);
    if (typeof p === 'string' && path.resolve(p) === path.resolve(capsRoot) && flags === 'r') dirFds.add(fd);
    return fd;
  });
  const realClose = fs.closeSync.bind(fs);
  const closeMock = mock.method(fs, 'closeSync', function (fd) {
    // Remove the fd from the tracked set BEFORE closing: once closed the OS may reuse the same
    // fd NUMBER for an unrelated open (e.g. writeLedger's temp file), which must NOT be treated
    // as the capabilities-root dir fd.
    if (dirFds.has(fd)) { closed.push(fd); dirFds.delete(fd); }
    return realClose(fd);
  });
  const realFsync = fs.fsyncSync.bind(fs);
  const fsyncMock = mock.method(fs, 'fsyncSync', function (fd) {
    if (dirFds.has(fd)) { const e = new Error(`${errno}: injected`); e.code = errno; throw e; }
    return realFsync(fd);
  });
  t.after(() => { openMock.mock.restore(); closeMock.mock.restore(); fsyncMock.mock.restore(); });
  return { closed };
}

// Revert-fails: restore the swallow-all `catch {}` in fsyncDir → the EIO dir-fsync
// during promotion is swallowed, the install COMMITS and returns 'installed', so
// this "must be blocked" assertion fails.
test('finding-4: a NON-tolerated dir-fsync errno (EIO) during install promotion surfaces as blocked (durability not silently claimed)', async (t) => {
  const dir = runtime();
  const capsRoot = path.join(dir, '.gsd', 'capabilities');
  fs.mkdirSync(capsRoot, { recursive: true });
  const { closed } = withLifecycleDirFsyncError(t, capsRoot, 'EIO');

  const res = await lifecycle.installCapability('./d', {
    runtimeDir: dir, hostVersion: '1.6.0',
    _resolve: fakeResolve(declarativeCap('d', '1.0.0')),
  });
  assert.strictEqual(res.status, 'blocked',
    'an EIO directory-fsync error during promotion must NOT be swallowed (install blocked)');
  assert.ok((res.blockReasons || []).some((r) => /durab/i.test(r)),
    `block reason must indicate durability could not be confirmed; got ${JSON.stringify(res.blockReasons)}`);
  assert.ok(closed.length >= 1, 'the directory fd must still be closed (finally)');
});

// Revert-fails: remove the tolerated-errno allowlist (rethrow EVERYTHING) → EISDIR
// would block the install, so this 'installed' assertion fails.
test('finding-4: a TOLERATED dir-fsync errno (EISDIR) during install promotion is ignored (install succeeds)', async (t) => {
  const dir = runtime();
  const capsRoot = path.join(dir, '.gsd', 'capabilities');
  fs.mkdirSync(capsRoot, { recursive: true });
  const { closed } = withLifecycleDirFsyncError(t, capsRoot, 'EISDIR');

  const res = await lifecycle.installCapability('./d', {
    runtimeDir: dir, hostVersion: '1.6.0',
    _resolve: fakeResolve(declarativeCap('d', '1.0.0')),
  });
  assert.strictEqual(res.status, 'installed',
    'an EISDIR directory-fsync error must be tolerated (best-effort) — install succeeds');
  assert.ok(closed.length >= 1, 'the directory fd must still be closed (finally)');
});

// ---------------------------------------------------------------------------
// DUR-6 (LOW): reconcile upgrade-rollback must renameSync(backup→final) FIRST
// (atomic replace), not rmSync(final) before the rename — a crash between the
// two leaves both gone.
// Revert-fails: restore `rmSync(finalDir)` BEFORE `renameSync(backupDir, finalDir)`
// → if we make ONLY the post-rmSync rename fail, the old rmSync-first order has
// already destroyed finalDir, so the bundle is lost; the new order renames first
// (no rmSync of finalDir) so the bundle survives. This test injects a crash right
// after a (hypothetical) rmSync of finalDir and asserts the final bundle survives.
// ---------------------------------------------------------------------------

test('DUR-6: reconcile upgrade-rollback renames backup→final atomically (no rmSync-before-rename data loss)', (t) => {
  const dir = runtime();
  // Seed an in-flight upgrade: a NEW (uncommitted) bundle live + the OLD backup set aside,
  // with a pending upgrade intent naming the backup.
  const backupName = 'c.upgrading-111-222';
  seedCapDir(dir, 'c', declarativeCap('c', '2.0.0'));           // new/uncommitted live dir
  seedCapDir(dir, backupName, declarativeCap('c', '1.0.0'));    // old backup to restore
  recordPending(dir, 'c', '2.0.0', { kind: 'upgrade', backupName, sharedFiles: [] });

  // Spy: assert reconcile NEVER rmSyncs the finalDir before the backup rename. If the buggy
  // order is restored, finalDir is rmSync'd first; the new order must rename the backup over
  // finalDir directly (renameSync replaces atomically), so no rmSync of finalDir occurs.
  const { mock } = require('node:test');
  const finalDir = path.join(dir, '.gsd', 'capabilities', 'c');
  const realRm = fs.rmSync.bind(fs);
  const realRename = fs.renameSync.bind(fs); // capture BEFORE mocking
  let finalDirRmBeforeRename = false;
  let backupRenamedToFinal = false;
  const renameMock = mock.method(fs, 'renameSync', function (src, dst, ...rest) {
    if (typeof src === 'string' && typeof dst === 'string'
      && path.resolve(src) === path.resolve(path.join(dir, '.gsd', 'capabilities', backupName))
      && path.resolve(dst) === path.resolve(finalDir)) {
      backupRenamedToFinal = true;
    }
    return realRename(src, dst, ...rest);
  });
  const rmMock = mock.method(fs, 'rmSync', function (p, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(finalDir) && !backupRenamedToFinal) {
      finalDirRmBeforeRename = true;
    }
    return realRm(p, ...rest);
  });
  t.after(() => { renameMock.mock.restore(); rmMock.mock.restore(); });

  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledBack.includes('c'), 'upgrade rollback must roll back c');
  assert.strictEqual(finalDirRmBeforeRename, false,
    'reconcile must NOT rmSync(finalDir) before renaming the backup over it (DUR-6 ordering)');
  assert.ok(backupRenamedToFinal, 'reconcile must renameSync(backup→final) to restore the old bundle');
  // The restored bundle is the OLD version.
  assert.strictEqual(capManifestVersion(dir, 'c'), '1.0.0', 'rolled-back bundle must be the old version');
});

// ---------------------------------------------------------------------------
// DOS-2 (MED): reconcile step-1 must accumulate mutations and write the ledger
// ONCE at the end of step 1, not once per pending entry.
// Revert-fails: restore per-entry recordInstall/removeEntry/writeLedger calls in
// step 1 → with N pending entries the ledger is written N times, so the spied
// writeLedger call count exceeds 1 for step-1 mutations and the "<= a small
// bound" assertion fails.
// ---------------------------------------------------------------------------

test('DOS-2: reconcile with N pending entries writes the ledger at most once for step-1 mutations', (t) => {
  const dir = runtime();
  // Seed several uncommitted FRESH installs (kind 'install') — each would, in the buggy
  // version, trigger its own removeEntry → writeLedger.
  const ids = ['a-cap', 'b-cap', 'c-cap', 'd-cap'];
  for (const id of ids) {
    recordPending(dir, id, '1.0.0', { kind: 'install', backupName: null, sharedFiles: [] });
    // Do NOT create the on-disk dir → safeRmUnder returns true (already gone) → entry rolled back.
  }

  const { mock } = require('node:test');
  let ledgerWrites = 0;
  const realWrite = ledgerMod.writeLedger.bind(ledgerMod);
  const writeMock = mock.method(ledgerMod, 'writeLedger', function (rd, ledger) {
    ledgerWrites++;
    return realWrite(rd, ledger);
  });
  // removeEntry also writes the ledger internally; spy it too so any per-entry path is visible.
  // TV-10: the batched step-1 path must NEVER call removeEntry (it mutates the in-memory ledger and
  // writes once). The spy is a pure COUNTER — it intentionally does NOT delegate to the real
  // removeEntry: a call here would be the bug under test (a per-entry write), so we only record that it
  // happened (the count assertion below fails) rather than masking it behind a misleading call-through.
  let removeEntryCalls = 0;
  const removeMock = mock.method(ledgerMod, 'removeEntry', function () {
    removeEntryCalls++;
    return false; // not delegated on purpose — see TV-10 note above.
  });
  t.after(() => { writeMock.mock.restore(); removeMock.mock.restore(); });

  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  // All N entries must be rolled back.
  for (const id of ids) {
    assert.ok(report.rolledBack.includes(id), `${id} must be rolled back`);
    assert.strictEqual(readLedgerEntry(dir, id), null, `${id} entry must be removed`);
  }
  // Step-1 must batch: at most ONE ledger write for the step-1 mutations (plus possibly
  // the read-only reconcile() at the end does no write). It must be far below N.
  assert.ok(ledgerWrites <= 1,
    `step-1 must write the ledger at most once for N=${ids.length} pending entries; writes=${ledgerWrites}`);
  assert.strictEqual(removeEntryCalls, 0,
    `step-1 batching must not call removeEntry per entry; calls=${removeEntryCalls}`);
});

// ---------------------------------------------------------------------------
// W-6 (NIT): reconcile's removeEntry/recordInstall calls can now throw (strict).
// One bad entry must NOT abort the whole reconcile — it must warn and continue.
// Revert-fails: remove the per-entry try/catch around the rollback mutations →
// a throw on the first entry propagates out of the loop, so the SECOND (good)
// entry is never rolled back and a warning is never recorded; the test's
// "good entry still rolled back" + "warning recorded" assertions fail.
// ---------------------------------------------------------------------------

test('W-6: a throwing per-entry mutation does not abort reconcile (warns and continues)', (t) => {
  const dir = runtime();
  // 'bad-cap' is an uncommitted UPGRADE with a backup; we make a per-entry filesystem call throw
  // for ITS backup path only. 'good-cap' is an uncommitted FRESH install that must still roll back.
  const badBackup = 'bad-cap.upgrading-111-222';
  seedCapDir(dir, badBackup, declarativeCap('bad-cap', '1.0.0'));
  recordPending(dir, 'bad-cap', '1.0.0', { kind: 'upgrade', backupName: badBackup, sharedFiles: [] });
  recordPending(dir, 'good-cap', '1.0.0', { kind: 'install', backupName: null, sharedFiles: [] });

  const { mock } = require('node:test');
  const realExists = fs.existsSync.bind(fs);
  const badBackupPath = path.join(dir, '.gsd', 'capabilities', badBackup);
  // existsSync(backupDir) is a direct per-entry call in reconcile's step-1 loop (outside the inner
  // restore try/catch) — making it throw for bad-cap exercises the W-6 per-entry catch.
  const existsMock = mock.method(fs, 'existsSync', function (p) {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(badBackupPath)) {
      throw new Error('simulated per-entry IO failure for bad-cap');
    }
    return realExists(p);
  });
  t.after(() => existsMock.mock.restore());

  let report;
  assert.doesNotThrow(
    () => { report = lifecycle.reconcileCapabilities({ runtimeDir: dir }); },
    'a throwing per-entry mutation must not abort the whole reconcile',
  );

  // The GOOD entry must still be rolled back despite the bad one throwing.
  assert.ok(report.rolledBack.includes('good-cap'),
    `good-cap must still be rolled back after bad-cap threw; rolledBack=${JSON.stringify(report.rolledBack)}`);
  assert.strictEqual(readLedgerEntry(dir, 'good-cap'), null, 'good-cap entry removed');
  // The bad entry must be LEFT in place (not silently committed) for a later retry.
  assert.ok(readLedgerEntry(dir, 'bad-cap'), 'bad-cap entry must remain (not silently dropped)');
  // A warning must record the bad entry.
  assert.ok(Array.isArray(report.warnings) && report.warnings.some((w) => /bad-cap/.test(w)),
    `a warning must name the failed entry; warnings=${JSON.stringify(report.warnings)}`);
});

// ---------------------------------------------------------------------------
// W-3 / DUR-5 (LOW): reconcile step-2 must sweep stale `.gsd-capabilities.json.tmp.*`
// orphan temp files (older than a threshold) from the runtime dir.
// Revert-fails: remove the stale-temp sweep → the old orphan temp file remains
// after reconcile, so the "orphan removed" assertion fails.
// ---------------------------------------------------------------------------

test('W-3/DUR-5: reconcile sweeps a stale .gsd-capabilities.json.tmp.* orphan from the runtime dir', () => {
  const dir = runtime();
  fs.mkdirSync(dir, { recursive: true });
  // A committed, valid ledger so reconcile proceeds past the corruption preflight.
  ledgerMod.recordInstall(dir, { id: 'z', version: '1.0.0', source: 's', integrity: '', files: [], sharedEdits: [] });

  // Plant a STALE orphan temp (older than the 5-min threshold) and a FRESH one (must be kept).
  const staleTmp = path.join(dir, `${ledgerMod.LEDGER_FILE_NAME}.tmp.99999-deadbeef`);
  const freshTmp = path.join(dir, `${ledgerMod.LEDGER_FILE_NAME}.tmp.99998-cafef00d`);
  fs.writeFileSync(staleTmp, 'orphan');
  fs.writeFileSync(freshTmp, 'fresh');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(staleTmp, old, old);

  lifecycle.reconcileCapabilities({ runtimeDir: dir });

  assert.ok(!fs.existsSync(staleTmp), 'stale orphan tmp file must be swept by reconcile (W-3/DUR-5)');
  assert.ok(fs.existsSync(freshTmp), 'a fresh tmp file (possible in-flight write) must NOT be swept');
});

// ---------------------------------------------------------------------------
// Consent store binding on project install / upgrade / remove (#1459)
// ---------------------------------------------------------------------------

const consentMod = require('../gsd-core/bin/lib/capability-consent.cjs');
const trustMod = require('../gsd-core/bin/lib/capability-trust.cjs');

/** A consent home OUTSIDE the project tree (user-owned). */
function consentHome() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-consent-home-')));
  cleanups.push(dir);
  return dir;
}

/**
 * #1459 CB-1/CB-2: the SECURITY binding `hasProjectConsent` checks is the RECOMPUTED full-bundle
 * content hash over the INSTALLED capDir (`<runtimeDir>/.gsd/capabilities/<id>`) — exactly what the
 * loader recomputes at load. Tests assert consent presence by recomputing the same hash here.
 */
function installedCapDir(runtimeDir, id) {
  return path.join(runtimeDir, '.gsd', 'capabilities', id);
}
function installedContentHash(runtimeDir, id) {
  return consentMod.bundleContentHash(installedCapDir(runtimeDir, id));
}

test('install (project scope, consented): writes a consent record under the consent home, NOT the project', async () => {
  const dir = fs.realpathSync(runtime()); // project runtimeDir
  const home = consentHome();
  const cap = declarativeCap('proj-decl');
  const res = await lifecycle.installCapability('./proj', {
    runtimeDir: dir, hostVersion: '1.6.0', scope: 'project', consentStoreDir: home,
    _resolve: fakeResolve(cap, { integrity: 'sha512-proj' }),
  });
  assert.strictEqual(res.status, 'installed');
  // The consent record matches what the loader will check — the RECOMPUTED full-bundle content hash
  // over the installed capDir (#1459 CB-1/CB-2). A declarative-only cap has NO executable surface, so
  // before content binding it had a constant disclosure signature and a repo-write could swap its
  // manifest while consent still matched; the contentHash binds the whole bundle.
  assert.strictEqual(
    consentMod.hasProjectConsent({
      gsdHome: home, projectRoot: dir, id: 'proj-decl',
      contentHash: installedContentHash(dir, 'proj-decl'),
    }),
    true,
    'a matching consent record was written under the consent home',
  );
  // It is under the consent HOME, not under the project runtimeDir.
  assert.ok(fs.existsSync(consentMod.consentStorePath(home)), 'store under consent home');
  assert.ok(!fs.existsSync(path.join(dir, '.gsd', 'consent.json')), 'NOT written inside the project');
});

test('install (project scope, executable + consented): consent record matches the executable disclosure signature', async () => {
  const dir = fs.realpathSync(runtime());
  const home = consentHome();
  const cap = execCap('proj-exec', '1.0.0', { mcp: { srv: { command: 'node', env: { NODE_OPTIONS: '--inspect' } } } });
  const res = await lifecycle.installCapability('./pe', {
    runtimeDir: dir, hostVersion: '1.6.0', scope: 'project', consentStoreDir: home,
    consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(cap, { integrity: 'sha512-pe' }),
  });
  assert.strictEqual(res.status, 'installed');
  // The recorded contentHash must equal the recomputed full-bundle hash of the installed capDir so
  // the loader re-activates it; a tampered manifest/script later changes the recomputed hash and
  // deactivates (loader test). The stored disclosureSignature (incl. env) remains for the UX layer.
  assert.strictEqual(
    consentMod.hasProjectConsent({
      gsdHome: home, projectRoot: dir, id: 'proj-exec',
      contentHash: installedContentHash(dir, 'proj-exec'),
    }),
    true,
  );
  // The record ALSO retains the executable disclosure signature for the re-consent-on-change UX.
  const store = consentMod.readConsentStore(home);
  const rec = store.records[`${dir}\0proj-exec`];
  assert.ok(rec, 'consent record present');
  assert.strictEqual(rec.disclosureSignature, trustMod.signatureForManifest(cap), 'disclosure signature retained on the record');
});

test('install (GLOBAL scope): writes NO consent record (global is trusted as today)', async () => {
  const dir = fs.realpathSync(runtime());
  const home = consentHome();
  const res = await lifecycle.installCapability('./g', {
    runtimeDir: dir, hostVersion: '1.6.0', scope: 'global', consentStoreDir: home,
    _resolve: fakeResolve(declarativeCap('global-decl'), { integrity: 'sha512-g' }),
  });
  assert.strictEqual(res.status, 'installed');
  // No store file (or an empty one) — global scope never records consent.
  const store = consentMod.readConsentStore(home);
  assert.deepStrictEqual(Object.keys(store.records), [], 'global install records no consent');
});

test('remove (project scope): revokes the consent record', async () => {
  const dir = fs.realpathSync(runtime());
  const home = consentHome();
  const cap = declarativeCap('proj-rm');
  await lifecycle.installCapability('./rm', {
    runtimeDir: dir, hostVersion: '1.6.0', scope: 'project', consentStoreDir: home,
    _resolve: fakeResolve(cap, { integrity: 'sha512-rm' }),
  });
  const rmHash = installedContentHash(dir, 'proj-rm');
  assert.strictEqual(
    consentMod.hasProjectConsent({ gsdHome: home, projectRoot: dir, id: 'proj-rm', contentHash: rmHash }),
    true,
    'consent present after install',
  );
  const rm = lifecycle.removeCapability('proj-rm', { runtimeDir: dir, scope: 'project', consentStoreDir: home });
  assert.strictEqual(rm.status, 'removed');
  assert.strictEqual(
    consentMod.hasProjectConsent({ gsdHome: home, projectRoot: dir, id: 'proj-rm', contentHash: rmHash }),
    false,
    'remove fully revokes the consent record',
  );
});

// Finding 3 (MED, #1459 round 6): removeProjectConsent now THROWS on a consent-lock failure
// (round-3). removeCapability must NOT silently swallow that throw and still report a clean
// 'removed' — that leaves a STALE consent record a byte-identical re-drop + forged ledger could
// reactivate against. The revoke failure must be SURFACED (a stderr warning naming the record AND
// a flag in the returned result) so the user knows to clear it (`gsd capability trust revoke`).
function plantFreshConsentLockLife(home) {
  const lockPath = consentMod.consentLockPath(home);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // A fresh JSON lock body (matching the shared lock primitive shape) so acquireConsentLock cannot
  // steal it within its attempt budget → revokeProjectConsent throws.
  const body = JSON.stringify({ token: `${process.pid}-${Date.now()}-1`, pid: process.pid, hostname: os.hostname(), startTime: 'CSTART', ts: Date.now() });
  fs.writeFileSync(lockPath, body, 'utf8');
  return lockPath;
}

test('remove (project scope): a revoke-on-lock-failure is SURFACED, not swallowed (no silent clean removed with a stale consent record)', async (t) => {
  // revert-fails: the old remove path wrapped revokeProjectConsent in `try { … } catch { /* best-effort */ }`
  // and returned `{ status: 'removed' }` regardless — so with the consent lock held, revoke throws, the
  // catch swallows it, and the result is a clean 'removed' with NO indication the consent record is stale.
  // This asserts the result carries consentRevokeFailed:true (and a warning) — which is FALSE/absent under
  // the swallow-and-return-clean implementation and only true once the failure is surfaced.
  const dir = fs.realpathSync(runtime());
  const home = consentHome();
  const cap = declarativeCap('proj-rm-lk');
  await lifecycle.installCapability('./rmlk', {
    runtimeDir: dir, hostVersion: '1.6.0', scope: 'project', consentStoreDir: home,
    _resolve: fakeResolve(cap, { integrity: 'sha512-rmlk' }),
  });
  const rmHash = installedContentHash(dir, 'proj-rm-lk');
  assert.strictEqual(
    consentMod.hasProjectConsent({ gsdHome: home, projectRoot: dir, id: 'proj-rm-lk', contentHash: rmHash }),
    true, 'consent present after install',
  );
  // Hold the consent-store lock so the revoke inside remove cannot acquire it → revokeProjectConsent throws.
  const lockPath = plantFreshConsentLockLife(home);
  t.after(() => { try { fs.unlinkSync(lockPath); } catch { /* best-effort */ } });

  const rm = lifecycle.removeCapability('proj-rm-lk', { runtimeDir: dir, scope: 'project', consentStoreDir: home });

  // The files/ledger are gone (removal succeeded) — but the consent revoke FAILED and must be surfaced.
  assert.strictEqual(rm.status, 'removed', 'the files+ledger removal still succeeds');
  assert.strictEqual(readLedgerEntry(dir, 'proj-rm-lk'), null, 'ledger entry removed');
  assert.strictEqual(rm.consentRevokeFailed, true,
    'the result must flag consentRevokeFailed:true so the CLI can report a non-clean removal (a swallowed throw would leave this undefined)');
  assert.ok(
    typeof rm.consentRevokeWarning === 'string' && /consent|revoke|trust revoke/i.test(rm.consentRevokeWarning),
    `the result must carry a warning naming the stale consent record; got: ${JSON.stringify(rm.consentRevokeWarning)}`,
  );
  // The consent record is STALE (could not be revoked) — confirming the failure was real, not a no-op.
  assert.strictEqual(
    consentMod.hasProjectConsent({ gsdHome: home, projectRoot: dir, id: 'proj-rm-lk', contentHash: rmHash }),
    true, 'the consent record is left STALE (revoke was blocked by the held lock) — the user must clear it',
  );
});

test('upgrade (project scope, consented): re-records the consent for the new version', async () => {
  const dir = fs.realpathSync(runtime());
  const home = consentHome();
  const capV1 = execCap('proj-up', '1.0.0', { script: 'hooks/a.js' });
  await lifecycle.installCapability('./up', {
    runtimeDir: dir, hostVersion: '1.6.0', scope: 'project', consentStoreDir: home,
    consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(capV1, { integrity: 'sha512-up1' }),
  });
  // Capture the V1 bundle content hash BEFORE the upgrade overwrites the on-disk bundle, so TV-05 can
  // prove the OLD-version binding no longer matches after the re-record.
  const v1Hash = installedContentHash(dir, 'proj-up');
  // Upgrade to v2 with the SAME executable set (no re-consent prompt) — consent re-recorded for v2.
  const capV2 = execCap('proj-up', '2.0.0', { script: 'hooks/a.js' });
  const up = await lifecycle.upgradeCapability('./up', {
    runtimeDir: dir, hostVersion: '1.6.0', scope: 'project', consentStoreDir: home,
    consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(capV2, { integrity: 'sha512-up2' }),
  });
  assert.strictEqual(up.status, 'upgraded');
  const v2Hash = installedContentHash(dir, 'proj-up');
  assert.notStrictEqual(v1Hash, v2Hash, 'precondition: the v1 and v2 bundles hash differently');
  assert.strictEqual(
    consentMod.hasProjectConsent({ gsdHome: home, projectRoot: dir, id: 'proj-up', contentHash: v2Hash }),
    true,
    'consent re-recorded against the upgraded bundle content hash',
  );
  // TV-05: the upgrade must REPLACE the consent record in place — no second STALE record bound to the
  // OLD version may linger. revert-fails: if the upgrade ADDED a new record instead of overwriting (or
  // left the v1 binding around), the store would carry 2 records and/or the OLD hash would still match.
  assert.strictEqual(
    consentMod.hasProjectConsent({ gsdHome: home, projectRoot: dir, id: 'proj-up', contentHash: v1Hash }),
    false,
    'the OLD-version content hash no longer matches (no stale consent record)',
  );
  const store = consentMod.readConsentStore(home);
  assert.strictEqual(Object.keys(store.records).length, 1, 'exactly one consent record for the (project, id) — no duplicate');
});

// ---------------------------------------------------------------------------
// D — IC-01/CB-4: install from a SUBDIR records consent at the project root, so the loader (which
// looks up via consentProjectRoot = realpath(findProjectRoot(cwd))) finds it from any descendant.
// ---------------------------------------------------------------------------

const { loadRegistry } = require('../gsd-core/bin/lib/capability-loader.cjs');

test('D (IC-01/CB-4): install --scope project from a SUBDIR → cap is ACTIVE (record key matches loader lookup)', async () => {
  // revert-fails: if the RECORD site bound consent to realpath(subdir) and the loader looked it up at
  // realpath(findProjectRoot(cwd)), the keys would differ and the freshly installed cap would be
  // immediately INACTIVE (install-then-inactive). The CLI resolves cwd→project root via
  // findProjectRoot BEFORE install (capability is not in SKIP_ROOT_RESOLUTION), so the record lands at
  // the project root; the loader's consentProjectRoot resolves the same root from a deep subdir. This
  // test simulates that: install at the project root, then load from a nested subdir.
  const projectRoot = fs.realpathSync(runtime());
  fs.mkdirSync(path.join(projectRoot, '.planning'), { recursive: true }); // project-root marker for findProjectRoot
  const subdir = path.join(projectRoot, 'a', 'b', 'c');
  fs.mkdirSync(subdir, { recursive: true });
  const home = consentHome();
  const cap = declarativeCap('subdir-cap');
  cap.skills = ['subdir-skill'];
  const res = await lifecycle.installCapability('./sd', {
    // The CLI passes the findProjectRoot-resolved cwd as runtimeDir; here that is the project root.
    runtimeDir: projectRoot, hostVersion: '1.6.0', scope: 'project', consentStoreDir: home,
    _resolve: fakeResolve(cap, { integrity: '' }), // local install → empty integrity (CB-3 path)
  });
  assert.strictEqual(res.status, 'installed');
  // Load the registry FROM the nested subdir, pointing the consent home at the same store. The loader
  // resolves the project root (findProjectRoot finds the .planning/ marker) and finds the record.
  const reg = loadRegistry({ includeInstalled: true, gsdHome: home, cwd: subdir, hostVersion: '1.6.0' });
  assert.ok(reg.capabilities && reg.capabilities['subdir-cap'], 'cap ACTIVE when loaded from a subdir (no install-then-inactive)');
  assert.strictEqual(reg.bySkill['subdir-skill'], 'subdir-cap', 'skill surface present from the subdir');
});

// ---------------------------------------------------------------------------
// IC-03: a reconcile rollback that DELETES a project-scope entry whose bundle dir is gone must also
// REVOKE the now-stale consent, so a later re-dropped BYTE-IDENTICAL bundle of the same id stays
// INACTIVE (it cannot silently re-activate against the stale record whose content hash still matches).
// ---------------------------------------------------------------------------

test('IC-03: reconcile rollback of a deleted project bundle revokes consent → identical re-drop stays INACTIVE', async () => {
  // revert-fails: drop the revokeStaleConsent(id) call in reconcile's install-rollback branch → the
  // stale consent record survives the rollback, so the byte-identical re-drop (same content hash) would
  // RE-ACTIVATE against it and the final inactive assertion would FAIL.
  const dir = fs.realpathSync(runtime());
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true }); // genuine project marker (CB-3 safe)
  const home = consentHome();
  const cap = declarativeCap('redrop-cap');
  cap.skills = ['redrop-skill'];

  // 1. Real project install — records a user consent record bound to the installed bundle content hash.
  const installed = await lifecycle.installCapability('./rd', {
    runtimeDir: dir, hostVersion: '1.6.0', scope: 'project', consentStoreDir: home,
    _resolve: fakeResolve(cap, { integrity: '' }),
  });
  assert.strictEqual(installed.status, 'installed');
  const consentedHash = installedContentHash(dir, 'redrop-cap');
  assert.strictEqual(
    consentMod.hasProjectConsent({ gsdHome: home, projectRoot: dir, id: 'redrop-cap', contentHash: consentedHash }),
    true, 'consent present after install',
  );

  // 2. Simulate a crashed/interrupted state: mark the entry as an in-flight (uncommitted) install and
  //    delete its on-disk bundle dir. reconcile's install-rollback path then drops the entry.
  recordPending(dir, 'redrop-cap', '1.0.0', { kind: 'install', backupName: null, sharedFiles: [] });
  cleanup(path.join(dir, '.gsd', 'capabilities', 'redrop-cap')); // delete the on-disk bundle dir (helpers.cleanup: Windows-EBUSY retry budget)

  // 3. Reconcile WITH the consent context — the rollback must revoke the stale consent.
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir, scope: 'project', consentStoreDir: home });
  assert.ok(report.rolledBack.includes('redrop-cap'), 'the deleted-bundle entry is rolled back');
  assert.strictEqual(
    consentMod.hasProjectConsent({ gsdHome: home, projectRoot: dir, id: 'redrop-cap', contentHash: consentedHash }),
    false, 'reconcile rollback revoked the now-stale consent record',
  );

  // 4. Re-drop the BYTE-IDENTICAL bundle + a committed (forged) project ledger — no new consent.
  const reDir = path.join(dir, '.gsd', 'capabilities', 'redrop-cap');
  fs.mkdirSync(reDir, { recursive: true });
  fs.writeFileSync(path.join(reDir, 'capability.json'), JSON.stringify(cap), 'utf8');
  assert.strictEqual(consentMod.bundleContentHash(reDir), consentedHash, 'precondition: the re-drop is byte-identical (same hash)');
  fs.writeFileSync(path.join(dir, '.gsd-capabilities.json'), JSON.stringify({
    version: '1', updatedAt: '2026-01-01T00:00:00Z',
    entries: { 'redrop-cap': { id: 'redrop-cap', version: '1.0.0', source: 's', integrity: '', files: [], sharedEdits: [] } },
  }), 'utf8');

  // 5. The loader must NOT re-activate the identical re-drop — consent was revoked.
  const reg = loadRegistry({ includeInstalled: true, gsdHome: home, cwd: dir, hostVersion: '1.6.0' });
  assert.ok(reg.capabilities['redrop-cap'] === undefined, 'an identical re-drop stays INACTIVE after the rollback revoked consent');
});

// ---------------------------------------------------------------------------
// IC-07: a PROJECT-scope install/upgrade with NO consentStoreDir cannot bind consent. That used to be
// a SILENT skip (cap inactive with no explanation). It must now emit an observable stderr warning.
// ---------------------------------------------------------------------------

test('IC-07: project-scope install WITHOUT a consentStoreDir warns on stderr (consent binding skipped)', async () => {
  // revert-fails: remove warnIfConsentSkipped's emit → the install still succeeds but NO warning is
  // written, so the /consentStoreDir|consent binding was SKIPPED/i match below fails.
  const dir = fs.realpathSync(runtime());
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (chunk, ...rest) => { buf += String(chunk); return orig(chunk, ...rest); };
  let res;
  try {
    res = await lifecycle.installCapability('./nostore', {
      // scope:'project' but NO consentStoreDir → bind cannot run.
      runtimeDir: dir, hostVersion: '1.6.0', scope: 'project',
      _resolve: fakeResolve(declarativeCap('no-store-cap'), { integrity: '' }),
    });
  } finally {
    process.stderr.write = orig;
  }
  assert.strictEqual(res.status, 'installed', 'the install still succeeds (binding skip is non-fatal)');
  assert.match(buf, /capability consent:/i, 'a consent diagnostic was written to stderr');
  assert.match(buf, /no-store-cap/, 'the warning names the capability');
  assert.match(buf, /skip/i, 'the warning states consent binding was skipped');
});

// ---------------------------------------------------------------------------
// IC-05 / WIN-2: a consent-store write failure (read-only/UNC/NFS) must NOT fail an otherwise-
// successful install — surface a non-fatal warning naming the store path and let the install succeed.
// ---------------------------------------------------------------------------

test('IC-05/WIN-2: a consent-store write failure leaves the install status:installed + warns', async () => {
  // revert-fails: if bindProjectConsent re-threw (or the warning were dropped), the install would
  // either throw / return non-installed OR succeed silently — both fail an assertion below.
  const dir = fs.realpathSync(runtime());
  const home = consentHome();
  // Simulate an unwritable store: mock recordProjectConsent to throw (read-only/UNC/NFS surrogate).
  const realRecord = consentMod.recordProjectConsent.bind(consentMod);
  const recMock = mock.method(consentMod, 'recordProjectConsent', function () {
    const err = new Error('EROFS: read-only file system, open consent.json'); err.code = 'EROFS'; throw err;
  });
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (chunk, ...rest) => { buf += String(chunk); return orig(chunk, ...rest); };
  let res;
  try {
    res = await lifecycle.installCapability('./rofs', {
      runtimeDir: dir, hostVersion: '1.6.0', scope: 'project', consentStoreDir: home,
      _resolve: fakeResolve(declarativeCap('rofs-cap'), { integrity: '' }),
    });
  } finally {
    process.stderr.write = orig;
    recMock.mock.restore();
  }
  void realRecord;
  assert.strictEqual(res.status, 'installed', 'a consent-store IO error must NOT fail an otherwise-successful install');
  assert.ok(fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'rofs-cap', 'capability.json')), 'the bundle is committed on disk');
  assert.match(buf, /capability consent:/i, 'a consent diagnostic was written to stderr');
  assert.match(buf, /could not write the consent record/i, 'the warning explains the write failure');
  assert.match(buf, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the warning names the consent store path');
});

// ---------------------------------------------------------------------------
// #1463: outdatedCapabilities (ADR-1244 D6 "Update available?")
// ---------------------------------------------------------------------------

/** Plant a ledger entry with a given source string and installed version. */
function plantEntry(dir, id, version, source) {
  ledgerMod.recordInstall(dir, {
    id, version, source, integrity: '',
    files: [`.gsd/capabilities/${id}`], sharedEdits: [],
  });
}
/** A git ls-remote --tags line for a tag. */
function lsLine(tag) {
  return `0000000000000000000000000000000000000000\trefs/tags/${tag}`;
}

test('#1463 outdated: empty ledger → empty records (no throw)', () => {
  const dir = runtime();
  assert.deepStrictEqual(lifecycle.outdatedCapabilities({ runtimeDir: dir }), []);
});

test('#1463 outdated: git source with a newer tag → status outdated; latest reported', () => {
  const dir = runtime();
  plantEntry(dir, 'gitcap', '1.0.0', 'https://github.com/org/repo.git');
  const fakeGit = () => ({ exitCode: 0, stdout: [lsLine('v1.0.0'), lsLine('v1.2.0')].join('\n'), stderr: '', signal: null, error: null });
  const [rec] = lifecycle.outdatedCapabilities({ runtimeDir: dir, execOverrides: { git: fakeGit } });
  // revert-fails: an inverted comparison would report 'current' here.
  assert.strictEqual(rec.status, 'outdated');
  assert.strictEqual(rec.latest, '1.2.0');
  assert.strictEqual(rec.current, '1.0.0');
  assert.strictEqual(rec.sourceKind, 'git');
});

test('#1463 outdated: git installed == latest → current', () => {
  const dir = runtime();
  plantEntry(dir, 'gitcap', '1.2.0', 'https://github.com/org/repo.git');
  const fakeGit = () => ({ exitCode: 0, stdout: lsLine('v1.2.0'), stderr: '', signal: null, error: null });
  const [rec] = lifecycle.outdatedCapabilities({ runtimeDir: dir, execOverrides: { git: fakeGit } });
  assert.strictEqual(rec.status, 'current');
});

test('#1463 outdated: git installed > latest → current (not outdated)', () => {
  const dir = runtime();
  plantEntry(dir, 'gitcap', '2.0.0', 'https://github.com/org/repo.git');
  const fakeGit = () => ({ exitCode: 0, stdout: lsLine('v1.5.0'), stderr: '', signal: null, error: null });
  const [rec] = lifecycle.outdatedCapabilities({ runtimeDir: dir, execOverrides: { git: fakeGit } });
  assert.strictEqual(rec.status, 'current');
});

test('#1463 outdated: npm newer → outdated; npm peek error → unknown, other caps still reported', () => {
  const dir = runtime();
  plantEntry(dir, 'npmgood', '1.0.0', 'npm:@org/good@^1');
  plantEntry(dir, 'npmbad', '1.0.0', 'npm:@org/bad@^1');
  // revert-fails: without timeout/error→unknown handling, the failing peek crashes the whole verb and
  // npmgood would never be reported.
  // #1463: the good peek returns npm's REAL multi-line range output (one line per matching version); the
  // highest version satisfying `^1` is 1.9.0 (a 2.x would be OUT of range and must NOT be chosen).
  const fakeNpm = (args) => {
    const pkg = args[args.indexOf('view') + 2]; // ['view','--',<pkg>,'version']
    if (pkg === '@org/good@^1') {
      const out = ["@org/good@1.4.0 '1.4.0'", "@org/good@1.9.0 '1.9.0'"].join('\n') + '\n';
      return { exitCode: 0, stdout: out, stderr: '', signal: null, error: null };
    }
    return { exitCode: 1, stdout: '', stderr: 'E404', signal: null, error: null };
  };
  const recs = lifecycle.outdatedCapabilities({ runtimeDir: dir, execOverrides: { npm: fakeNpm } });
  const byId = Object.fromEntries(recs.map((r) => [r.id, r]));
  assert.strictEqual(byId.npmgood.status, 'outdated');
  assert.strictEqual(byId.npmgood.latest, '1.9.0', 'highest version satisfying the recorded ^1 range');
  assert.strictEqual(byId.npmbad.status, 'unknown', 'a failing peek degrades that row only');
  assert.strictEqual(recs.length, 2, 'both capabilities are still reported');
});

test('#1463 outdated: tarball → manual; registry → unknown', () => {
  const dir = runtime();
  plantEntry(dir, 'tarcap', '1.0.0', 'https://host/path/cap-1.0.0.tgz');
  plantEntry(dir, 'regcap', '1.0.0', 'my-cap@gsd-registry');
  const recs = lifecycle.outdatedCapabilities({ runtimeDir: dir });
  const byId = Object.fromEntries(recs.map((r) => [r.id, r]));
  assert.strictEqual(byId.tarcap.status, 'manual');
  assert.strictEqual(byId.regcap.status, 'unknown');
});

test('#1463 outdated: local newer/equal → outdated/current (re-read of recorded path)', () => {
  const dir = runtime();
  const srcNew = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-out-localnew-'));
  const srcSame = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-out-localsame-'));
  cleanups.push(srcNew, srcSame);
  fs.writeFileSync(path.join(srcNew, 'capability.json'), JSON.stringify(declarativeCap('locnew', '2.0.0')));
  fs.writeFileSync(path.join(srcSame, 'capability.json'), JSON.stringify(declarativeCap('locsame', '1.0.0')));
  plantEntry(dir, 'locnew', '1.0.0', srcNew);
  plantEntry(dir, 'locsame', '1.0.0', srcSame);
  const recs = lifecycle.outdatedCapabilities({ runtimeDir: dir });
  const byId = Object.fromEntries(recs.map((r) => [r.id, r]));
  assert.strictEqual(byId.locnew.status, 'outdated');
  assert.strictEqual(byId.locnew.latest, '2.0.0');
  assert.strictEqual(byId.locsame.status, 'current');
});

test('#1463 outdated: git source pinned to a commit SHA is NEVER outdated even with a newer remote tag → status pinned', () => {
  const dir = runtime();
  // A `#sha:<commit>`-pinned source: `update` re-resolves to the SAME commit, so a newer tag at the
  // remote is irrelevant. revert-fails: without the parsed.ref pinned check, peek returns the highest
  // tag 'ok' and outdatedCapabilities compares 9.9.9 > 1.0.0 ⇒ 'outdated', failing this 'pinned' assert.
  plantEntry(dir, 'pinnedsha', '1.0.0', 'https://github.com/org/repo.git#sha:abcdef1234567890abcdef1234567890abcdef12');
  const fakeGit = () => ({ exitCode: 0, stdout: [lsLine('v1.0.0'), lsLine('v9.9.9')].join('\n'), stderr: '', signal: null, error: null });
  const [rec] = lifecycle.outdatedCapabilities({ runtimeDir: dir, execOverrides: { git: fakeGit } });
  assert.strictEqual(rec.status, 'pinned');
  assert.strictEqual(rec.sourceKind, 'git');
});

test('#1463 outdated: git source pinned to an explicit tag → status pinned (not outdated)', () => {
  const dir = runtime();
  plantEntry(dir, 'pinnedtag', '1.0.0', 'https://github.com/org/repo.git#tag:v1.0.0');
  const fakeGit = () => ({ exitCode: 0, stdout: [lsLine('v1.0.0'), lsLine('v2.0.0')].join('\n'), stderr: '', signal: null, error: null });
  const [rec] = lifecycle.outdatedCapabilities({ runtimeDir: dir, execOverrides: { git: fakeGit } });
  assert.strictEqual(rec.status, 'pinned');
});

test('#1463 outdated: UNPINNED git source (no #ref) with a newer tag → still outdated', () => {
  const dir = runtime();
  plantEntry(dir, 'unpinned', '1.0.0', 'https://github.com/org/repo.git');
  const fakeGit = () => ({ exitCode: 0, stdout: [lsLine('v1.0.0'), lsLine('v1.5.0')].join('\n'), stderr: '', signal: null, error: null });
  const [rec] = lifecycle.outdatedCapabilities({ runtimeDir: dir, execOverrides: { git: fakeGit } });
  assert.strictEqual(rec.status, 'outdated');
  assert.strictEqual(rec.latest, '1.5.0');
});

test('#1463 outdated: UNPINNED git source at latest → current', () => {
  const dir = runtime();
  plantEntry(dir, 'unpinnedcur', '1.5.0', 'https://github.com/org/repo.git');
  const fakeGit = () => ({ exitCode: 0, stdout: lsLine('v1.5.0'), stderr: '', signal: null, error: null });
  const [rec] = lifecycle.outdatedCapabilities({ runtimeDir: dir, execOverrides: { git: fakeGit } });
  assert.strictEqual(rec.status, 'current');
});

test('#1463 outdated: npm RANGE source picks highest matching (real multi-line output) → outdated when installed below it', () => {
  const dir = runtime();
  plantEntry(dir, 'npmrange', '1.0.0', 'npm:@org/cap@^1');
  // npm's REAL range output: one annotated line per matching version (not a single bare token).
  // revert-fails: the old single-token parse degrades this to 'unknown', so the 'outdated' assert fails.
  const multiLine = ["@org/cap@1.2.0 '1.2.0'", "@org/cap@1.10.0 '1.10.0'"].join('\n') + '\n';
  const fakeNpm = () => ({ exitCode: 0, stdout: multiLine, stderr: '', signal: null, error: null });
  const [rec] = lifecycle.outdatedCapabilities({ runtimeDir: dir, execOverrides: { npm: fakeNpm } });
  assert.strictEqual(rec.status, 'outdated');
  assert.strictEqual(rec.latest, '1.10.0', 'highest matching version (numeric, not lexical) is what update installs');
});

test('#1463 outdated: npm RANGE source installed == highest matching → current', () => {
  const dir = runtime();
  plantEntry(dir, 'npmrangecur', '1.10.0', 'npm:@org/cap@^1');
  const multiLine = ["@org/cap@1.2.0 '1.2.0'", "@org/cap@1.10.0 '1.10.0'"].join('\n') + '\n';
  const fakeNpm = () => ({ exitCode: 0, stdout: multiLine, stderr: '', signal: null, error: null });
  const [rec] = lifecycle.outdatedCapabilities({ runtimeDir: dir, execOverrides: { npm: fakeNpm } });
  assert.strictEqual(rec.status, 'current');
});

test('#1463 outdated: npm NO-version source (tracks latest) → outdated/current via single latest', () => {
  const dir = runtime();
  plantEntry(dir, 'npmlatest', '1.0.0', 'npm:@org/cap');
  const fakeNpm = () => ({ exitCode: 0, stdout: '2.0.0\n', stderr: '', signal: null, error: null });
  const [rec] = lifecycle.outdatedCapabilities({ runtimeDir: dir, execOverrides: { npm: fakeNpm } });
  assert.strictEqual(rec.status, 'outdated');
  assert.strictEqual(rec.latest, '2.0.0');
});

test('#1463 outdated: npm EXACT-pinned source (@1.2.3) → status pinned (update will not move it)', () => {
  const dir = runtime();
  plantEntry(dir, 'npmpinned', '1.2.3', 'npm:@org/cap@1.2.3');
  // revert-fails: without the exact-pin → 'pinned' branch, peek runs npm view and the row classifies
  // by comparison; a registry that advertised 9.9.9 would render it 'outdated', failing this assert.
  const fakeNpm = () => ({ exitCode: 0, stdout: '9.9.9\n', stderr: '', signal: null, error: null });
  const [rec] = lifecycle.outdatedCapabilities({ runtimeDir: dir, execOverrides: { npm: fakeNpm } });
  assert.strictEqual(rec.status, 'pinned');
});

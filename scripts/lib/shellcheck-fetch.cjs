'use strict';

/**
 * shellcheck-fetch.cjs
 *
 * Dependency-free replacement for the `shellcheck` npm package (removed in
 * #4120 — its extraction step pulled in `decompress@4.2.1`, which carries an
 * unpatched CRITICAL zip-slip vulnerability, GHSA-mp2f-45pm-3cg9, CVSS 9.1,
 * plus two moderate findings, with no patched version available upstream).
 *
 * This module fetches a PINNED koalaman/shellcheck release directly from
 * GitHub releases (never "latest" — see SHELLCHECK_VERSION below), extracts
 * the single `shellcheck` binary from the release's `.tar.gz` asset using
 * only Node's built-in `https`/`zlib` modules plus a small hand-written tar
 * reader (no third-party archive library), and caches the extracted binary
 * for reuse across runs.
 *
 * Zip-slip defense: unlike `decompress`, which wrote extracted files using
 * PATHS TAKEN FROM THE ARCHIVE (the exact defect class in GHSA-mp2f-45pm-
 * 3cg9 — a malicious archive entry named e.g. `../../etc/passwd` gets
 * written there verbatim), this reader NEVER uses an archive-supplied name
 * as a filesystem path. `extractFileFromTar` only ever returns the matched
 * entry's raw byte content; the caller (`resolveShellcheckBin`) writes those
 * bytes to a path it constructs itself (`<cacheDir>/shellcheck`), and the
 * archive's own name field is used only for a string-equality/suffix CHECK
 * (`name === targetName || name.endsWith('/' + targetName)`), never
 * interpolated into a path passed to `fs.writeFileSync`/`fs.mkdirSync`/etc.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const https = require('node:https');
const { ExitError } = require('./cli-exit.cjs');

// Pinned explicitly — verified against `koalaman/shellcheck`'s GitHub
// releases API as the current latest tag at the time this was written
// (2026-08-31). Never resolved dynamically ("latest") — a moving target
// would make this lint's exact ShellCheck version, and therefore its exact
// finding set against scripts/lint-workflow-shellcheck-baseline.json,
// non-reproducible across runs/machines/CI.
const SHELLCHECK_VERSION = 'v0.11.0';

const ROOT = path.join(__dirname, '..', '..');
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'shellcheck', SHELLCHECK_VERSION);
const CACHED_BIN_PATH = path.join(CACHE_DIR, 'shellcheck');

// process.arch -> the arch token ShellCheck's release asset names use.
// Only the two architectures that actually matter for this repo (per
// .github/workflows/test.yml: the lint-tests job that runs this script only
// runs on ubuntu-latest, which is x86_64; and Apple Silicon dev machines are
// aarch64) are supported — anything else fails with a clear error rather
// than guessing.
const ARCH_MAP = { x64: 'x86_64', arm64: 'aarch64' };

const MAX_REDIRECTS = 5;

// Bounds each individual HTTP hop (the initial request AND every redirect
// hop get their own fresh 30s budget, rather than one shared budget across
// the whole redirect chain) — a stalled connection on any single hop is
// caught in a bounded time, mirroring lint-workflow-shellcheck.cjs's own
// SHELLCHECK_TIMEOUT_MS bound on the ShellCheck subprocess. A bare `timeout`
// option on the request does NOT abort it by itself — Node only emits a
// 'timeout' event, which must be handled by destroying the request (see the
// `req.on('timeout', ...)` below).
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Issue one real HTTPS request. Exists as its own function purely so tests
 * can inject a fake in its place (see `httpsGetFollowingRedirects`'s
 * `requestFn` parameter) — production callers never pass an override, so
 * the real download path always uses this exact implementation.
 */
function defaultRequestFn(url, options, callback) {
  return https.get(url, options, callback);
}

/**
 * GET `url` following HTTP redirects manually — `https.get` does NOT follow
 * redirects automatically, and GitHub release asset URLs redirect through
 * `objects.githubusercontent.com`. Resolves with the full response body as a
 * Buffer once a 200 response is received.
 *
 * `requestFn` defaults to a real `https.get`-based transport
 * (`defaultRequestFn`) and is only ever overridden in tests, so calling this
 * with zero/one arg from `resolveShellcheckBin` is unchanged behavior.
 */
function httpsGetFollowingRedirects(url, redirectsLeft = MAX_REDIRECTS, requestFn = defaultRequestFn) {
  return new Promise((resolve, reject) => {
    const req = requestFn(
      url,
      { headers: { 'User-Agent': 'gsd-core-shellcheck-fetch' }, timeout: DOWNLOAD_TIMEOUT_MS },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain so the socket can be reused/closed
          if (redirectsLeft <= 0) {
            reject(new Error(`too many redirects fetching ${url}`));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          httpsGetFollowingRedirects(next, redirectsLeft - 1, requestFn).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`unexpected HTTP ${status} fetching ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    // `timeout` in the options above only ARMS a timer — Node emits a
    // 'timeout' event on the request but does not abort it. Without this
    // handler the request (and this Promise) would hang indefinitely past
    // the configured bound on a stalled connection.
    req.on('timeout', () => {
      req.destroy(new Error(`timed out after ${DOWNLOAD_TIMEOUT_MS}ms fetching ${url}`));
    });
  });
}

/**
 * Find the entry named (or path-ending-in) `targetName` inside a raw
 * (already gunzipped) POSIX tar byte stream and return its content as a
 * Buffer, or `null` if not found.
 *
 * Tar format: a sequence of 512-byte headers — name at offset 0/length 100,
 * size at offset 124/length 12 (octal ASCII), typeflag at offset 156 — each
 * followed by that many content bytes, padded up to the next 512-byte
 * boundary, terminated by an all-zero 512-byte block. This deliberately
 * implements only enough to locate ONE known entry name (no general
 * multi-file extraction, no symlink handling, no GNU long-name `@LongLink`
 * entries — ShellCheck's own release tarballs never need them) — see this
 * module's header comment for why the entry's NAME is never used as a
 * filesystem path.
 */
function extractFileFromTar(buffer, targetName) {
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeRaw = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = sizeRaw === '' ? 0 : parseInt(sizeRaw, 8);
    const typeflag = String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    const isRegularFile = typeflag === '0' || typeflag === '\0';
    if (isRegularFile && (name === targetName || name.endsWith(`/${targetName}`))) {
      return buffer.subarray(dataStart, dataStart + size);
    }
    const contentBlocks = Math.ceil(size / 512);
    offset = dataStart + contentBlocks * 512;
  }
  return null;
}

/**
 * Resolve the local path to a working, executable `shellcheck` binary,
 * downloading and caching the pinned release on first use. Subsequent calls
 * (same version) reuse the cached binary with no network activity — mirrors
 * the `fs.accessSync(bin, F_OK | X_OK)` cache-check pattern already used by
 * this script's own `runShellcheck`.
 */
async function resolveShellcheckBin() {
  try {
    fs.accessSync(CACHED_BIN_PATH, fs.constants.F_OK | fs.constants.X_OK);
    return CACHED_BIN_PATH;
  } catch {
    // not cached yet — fall through to download
  }

  if (process.platform === 'win32') {
    throw new ExitError(
      1,
      'lint-workflow-shellcheck: automatic ShellCheck download is not supported on Windows yet ' +
        '(this lint only ever runs in the ubuntu-latest lint-tests CI job — see .github/workflows/test.yml — ' +
        'so this is an honest platform gap, not expected to be hit in CI).',
    );
  }
  const platform = process.platform === 'darwin' || process.platform === 'linux' ? process.platform : null;
  if (!platform) {
    throw new ExitError(
      1,
      `lint-workflow-shellcheck: unsupported platform '${process.platform}' for ShellCheck auto-download ` +
        `(supported: linux, darwin).`,
    );
  }
  const arch = ARCH_MAP[process.arch];
  if (!arch) {
    throw new ExitError(
      1,
      `lint-workflow-shellcheck: unsupported architecture '${process.arch}' for ShellCheck auto-download ` +
        `(supported: x86_64 [node arch 'x64'], aarch64 [node arch 'arm64']).`,
    );
  }

  const assetName = `shellcheck-${SHELLCHECK_VERSION}.${platform}.${arch}.tar.gz`;
  const url = `https://github.com/koalaman/shellcheck/releases/download/${SHELLCHECK_VERSION}/${assetName}`;

  let gz;
  try {
    gz = await httpsGetFollowingRedirects(url);
  } catch (e) {
    throw new ExitError(1, `lint-workflow-shellcheck: failed to download ShellCheck (${url}): ${e.message}`);
  }

  let tarBuf;
  try {
    tarBuf = zlib.gunzipSync(gz);
  } catch (e) {
    throw new ExitError(1, `lint-workflow-shellcheck: failed to gunzip downloaded ShellCheck archive: ${e.message}`);
  }

  const entry = extractFileFromTar(tarBuf, 'shellcheck');
  if (!entry) {
    throw new ExitError(
      1,
      `lint-workflow-shellcheck: could not find a 'shellcheck' entry inside downloaded archive ${assetName}`,
    );
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // Write to a per-process temp path and rename into place — avoids any
  // other concurrent invocation observing (and trying to execute) a
  // partially-written binary at the real cache path.
  const tmpPath = path.join(CACHE_DIR, `.shellcheck.tmp-${process.pid}`);
  fs.writeFileSync(tmpPath, entry);
  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, CACHED_BIN_PATH);

  return CACHED_BIN_PATH;
}

module.exports = {
  SHELLCHECK_VERSION,
  CACHED_BIN_PATH,
  MAX_REDIRECTS,
  DOWNLOAD_TIMEOUT_MS,
  extractFileFromTar,
  httpsGetFollowingRedirects,
  resolveShellcheckBin,
};

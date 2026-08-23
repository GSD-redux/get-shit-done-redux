'use strict';

/**
 * Ensure hooks/dist is populated before any suite that reads it.
 * hooks/dist/ is gitignored and only produced by `npm run build:hooks`.
 * In CI the scoped/windows test jobs do NOT run build:hooks before running
 * tests, so the first test that needs hooks/dist would fail. This mirrors
 * the pattern used in bug-3357-codex-legacy-hooks-json-migration.test.cjs.
 *
 * Idempotent: `isHooksDistStale` rebuilds only when the directory is absent
 * or missing an entry from the EXPECTED SET — `scripts/build-hooks.js`'s
 * exported `HOOKS_TO_COPY` list. This replaces a former `.js`-extension-count
 * heuristic ("populated" if at least one `.js` file exists), which could not
 * see a dist missing exactly the file class that caused #3108: build-hooks
 * also ships `.sh` files (e.g. `gsd-session-state.sh`), so a dist with every
 * `.js` present and every `.sh` absent read as fully populated and the
 * rebuild was silently skipped. The set-membership check has no such blind
 * spot: any expected entry missing, of any extension, is stale. It does NOT
 * flag extra/unexpected files as stale — hooks/dist legitimately accumulates
 * output the list does not name (subdirectory output, hooks/lib) — and it
 * stays cheap (one `readdirSync` into a `Set`, no per-entry `existsSync`, no
 * `statSync`) since it runs once per suite.
 *
 * Extracted from six behaviorally-identical copies that had accumulated
 * across tests/install.test.cjs (x2) and tests/install-minimal-hooks.test.cjs
 * (x4) — see #2704's Failure B, where a seventh suite
 * (tests/mcp-catalog-parity.install.test.cjs) needed the same guard but had
 * no copy of its own, and so failed only on lanes where no other suite
 * happened to build hooks/dist first.
 */

const fs = require('node:fs');
const path = require('node:path');
// Required as a module object (not destructured) so tests can monkeypatch
// `processSeam.runNode` in place and have `ensureHooksDist` observe the
// replacement — a destructured `const { runNode } = require(...)` would
// bind a local reference at require-time that a later patch to the
// process-seam module's exports could never reach.
const processSeam = require('./process-seam.cjs');
const { throwIfFailed } = require('./git-fixture.cjs');
const { BUILD_TIMEOUT_MS } = require('./timeouts.cjs');
const { HOOKS_TO_COPY, HOOKS_SUBDIRS_TO_COPY } = require('../../scripts/build-hooks.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOKS_DIST_DIR = path.join(REPO_ROOT, 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

/**
 * True when `dir` is missing, or missing any entry `scripts/build-hooks.js`
 * expects to have copied there (`HOOKS_TO_COPY`, bare top-level filenames,
 * and `HOOKS_SUBDIRS_TO_COPY`, bare subdirectory names such as `lib`). A dist
 * with every top-level file present but no `lib/` (e.g. missing
 * `gsd-graphify-rebuild.sh`) is exactly the same blindness the old
 * `.js`-count heuristic had, one level down — so each subdir entry is first
 * checked against the same top-level readdir Set, THEN additionally required
 * to be a readable, non-empty directory (one extra `readdirSync` per subdir
 * entry — there is exactly one, `lib` — never a per-expected-file
 * `existsSync`/`statSync`). Presence alone is not enough: a stray regular
 * file named `lib`, or an empty `lib/`, would otherwise read as fresh, which
 * is the same blind spot one level down again. Extra/unexpected entries never
 * count as stale — this is a "is everything expected present and populated"
 * check, not an exact-set check.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function isHooksDistStale(dir) {
  if (!fs.existsSync(dir)) return true;
  let present;
  try {
    present = new Set(fs.readdirSync(dir));
  } catch (e) {
    // dir exists (existsSync passed above) but readdirSync still threw —
    // e.g. dir is actually a regular file (ENOTDIR), unreadable (EACCES),
    // or was removed in the race between the two calls. Unreadable is
    // indistinguishable from unusable here, and treating it as stale is
    // both safe (rebuilding is idempotent) and the likely remedy — whereas
    // throwing would fail every suite's before() on a diagnosis it cannot
    // act on.
    return true;
  }
  if (HOOKS_TO_COPY.some((name) => !present.has(name))) return true;
  for (const name of HOOKS_SUBDIRS_TO_COPY) {
    if (!present.has(name)) return true;
    // Presence in the top-level Set only proves an entry named `lib`
    // exists — not that it is a directory, nor that it is populated. A
    // stray regular file named `lib`, or an empty `lib/` missing e.g.
    // `gsd-graphify-rebuild.sh`, would otherwise read as fresh: exactly
    // the blind spot the subdir check exists to close. One `readdirSync`
    // per subdir entry (there is exactly one, `lib`) — no per-expected-file
    // `existsSync`/`statSync`, keeping the added cost to one syscall total.
    try {
      if (fs.readdirSync(path.join(dir, name)).length === 0) return true;
    } catch (e) {
      // ENOTDIR (regular file), EACCES, or a race where it vanished —
      // unreadable/unusable is indistinguishable from absent here, and
      // treating it as stale is safe (idempotent rebuild) per the same
      // posture as the top-level readdirSync catch above.
      return true;
    }
  }
  return false;
}

function ensureHooksDist() {
  if (isHooksDistStale(HOOKS_DIST_DIR)) {
    throwIfFailed(
      processSeam.runNode([BUILD_HOOKS_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }),
      `node ${BUILD_HOOKS_SCRIPT}`,
    );
  }
}

module.exports = { ensureHooksDist, isHooksDistStale, HOOKS_DIST_DIR, BUILD_HOOKS_SCRIPT };

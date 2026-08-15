'use strict';

/**
 * Preload fixture for #2873 matrix row C5 — force the installer's
 * cross-scope shadow-report call site (bin/install.js, immediately after
 * writeManifest) to exercise its own swallow-everything catch.
 *
 * `install-shadow-report.cjs`'s `buildShadowReport()` only degrades a
 * `TypeError` thrown by `resolveInstalledSurfaces` (returns
 * `RESOLVER_UNAVAILABLE`); any OTHER error type it lets propagate — see its
 * own doc comment. This preload replaces the exported `buildShadowReport`
 * with a function that always throws a plain `Error`, so whatever calls it
 * next (`bin/install.js`, requiring the SAME resolved module path and
 * therefore getting the SAME cached module object) sees that throw and must
 * swallow it without failing the install (design row C5: "a report failure
 * never fails the install").
 *
 * Loaded via `node --require <this file> bin/install.js ...`
 * (`tests/helpers/process-seam.cjs`'s `runNode` forwards extra argv
 * verbatim, ahead of the target script) so the patch lands in the require
 * cache BEFORE `bin/install.js`'s own
 * `require('../gsd-core/bin/lib/install-shadow-report.cjs')` resolves.
 *
 * One-shot subprocess: no restoration needed — the process exits right
 * after the single `install()` call this preload targets. This is NOT a
 * chmod/mode-bit trick (CONTRIBUTING.md: those no-op under root), and NOT
 * the in-process fs fault-injection seam (`tests/helpers/faulty-deps.cjs`'s
 * `withFaultyFs` is explicitly documented as in-process-only, since a
 * spawned subprocess offers no shared memory to monkeypatch into) — this
 * patches the ONE exported function the design doc names as the report
 * builder, at the require-cache seam a spawned child process actually
 * offers.
 */

const path = require('node:path');

const modPath = require.resolve(
  path.join(__dirname, '..', '..', 'gsd-core', 'bin', 'lib', 'install-shadow-report.cjs'),
);
const shadowReportModule = require(modPath);

shadowReportModule.buildShadowReport = function throwingBuildShadowReport() {
  throw new Error('injected by tests/helpers/shadow-report-throws-preload.cjs (#2873 matrix row C5)');
};
